#!/bin/bash
# dp-create-image.sh — DigitalPool Camera golden-image capture tool
#
# Produces a single compressed filesystem image of the running system and
# writes it to stdout (so server.js can pipe it straight to an HTTP download
# with no on-disk staging).  The companion `dp-restore.sh` (run from a bootable
# recovery USB) flashes this image onto a brand-new device, and
# `dp-firstboot.sh` sanitises the clone into a unique unit on first boot.
#
# The download is a single file:  <root filesystem>.tar.zst
# Inside it, at /var/lib/dp-image/, we stash everything the restore side needs
# to rebuild the disk it can't get from the rootfs alone:
#     manifest.json          — arch, disk geometry, per-partition fs UUIDs, …
#     partitions.sfdisk       — `sfdisk -d` dump (partition table + GUIDs)
#     bootgap.img.zst         — raw sectors 0..first-partition-start.  On x86
#                               this is just the protective MBR + primary GPT;
#                               on RK3588 it ALSO holds idbloader + u-boot,
#                               which live in the gap before partition 1.
#     mounts/<name>.tar.zst   — contents of every non-root OS mount that lives
#                               on its own filesystem (typically the EFI system
#                               partition and/or a separate /boot).
#
# IMPORTANT — capture is filesystem-level, not block-level.  We tar files, not
# blocks, so the source can stay live.  server.js quiesces the media pipeline
# (stops active streams) and calls `sync` before invoking us; tar tolerates the
# rest of the live system with --warning=no-file-changed.
#
# Usage:
#   sudo bash dp-create-image.sh [--created "<iso8601>"] [--app-version "<v>"] > image.tar.zst
#
# All diagnostic output goes to stderr; stdout carries ONLY the image bytes.

set -euo pipefail

# ── Parse args ────────────────────────────────────────────────────────────────
CREATED=""
APP_VERSION=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --created)     CREATED="${2:-}"; shift 2 ;;
        --app-version) APP_VERSION="${2:-}"; shift 2 ;;
        *) echo "dp-create-image: unknown arg: $1" >&2; exit 2 ;;
    esac
done

# ── Everything chatty goes to stderr; stdout is reserved for the image ──────────
log() { echo "  $*" >&2; }
fatal() { echo "dp-create-image: FATAL: $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || fatal "must run as root (via sudo)"
command -v zstd    >/dev/null || fatal "zstd not installed (apt install zstd)"
command -v sfdisk  >/dev/null || fatal "sfdisk not installed (apt install util-linux)"

# ── Discover the disk layout we're capturing ───────────────────────────────────
ROOT_SRC="$(findmnt -no SOURCE / | head -n1)"      # e.g. /dev/nvme0n1p2 or /dev/mapper/ubuntu--vg-ubuntu--lv
ROOT_SRC="${ROOT_SRC%%[*}"                          # strip any btrfs subvol suffix like [/@]
[[ -n "$ROOT_SRC" ]] || fatal "cannot determine root device"
# Walk the block-device stack down to the whole disk. Handles plain partitions
# (nvme0n1p2→nvme0n1) and LVM/device-mapper roots (…-lv→sda3→sda), where PKNAME
# returns nothing.
DISK="/dev/$(lsblk -rnso NAME "$ROOT_SRC" | tail -n1)"   # -r: raw (no tree chars)
[[ -b "$DISK" ]] || fatal "computed disk '$DISK' is not a block device (root src: $ROOT_SRC)"

ARCH="$(uname -m)"
KERNEL="$(uname -r)"
HOSTNAME_SRC="$(hostname)"
SECTOR_SIZE="$(blockdev --getss "$DISK" 2>/dev/null || echo 512)"
DISK_BYTES="$(blockdev --getsize64 "$DISK" 2>/dev/null || echo 0)"
MODEL="$(cat /proc/device-tree/model 2>/dev/null | tr -d '\0' || true)"
[[ -z "$MODEL" ]] && MODEL="$(cat /sys/class/dmi/id/product_name 2>/dev/null || echo unknown)"
[[ -z "$CREATED" ]] && CREATED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# First partition's start sector — the bootgap is [0, that).
FIRST_START="$(sfdisk -d "$DISK" 2>/dev/null \
    | grep -oE 'start=[[:space:]]*[0-9]+' \
    | grep -oE '[0-9]+' | sort -n | head -n1)"
[[ -n "$FIRST_START" && "$FIRST_START" -gt 0 ]] || fatal "cannot determine first partition start on $DISK"

log "Capturing $HOSTNAME_SRC  ($ARCH, $MODEL)"
log "Disk: $DISK  (${DISK_BYTES} bytes, ${SECTOR_SIZE}B sectors, first part @ sector $FIRST_START)"

# ── Prepare the metadata staging dir (captured inside the rootfs tar) ──────────
META_DIR="/var/lib/dp-image"
rm -rf "$META_DIR"
mkdir -p "$META_DIR/mounts"

# 1. Partition table dump
sfdisk -d "$DISK" > "$META_DIR/partitions.sfdisk"
log "Saved partition table"

# 2. Bootgap (protective MBR + GPT + any u-boot living before partition 1)
dd if="$DISK" of="$META_DIR/bootgap.img" bs="$SECTOR_SIZE" count="$FIRST_START" \
    status=none 2>/dev/null
zstd -q -f --rm -19 "$META_DIR/bootgap.img" -o "$META_DIR/bootgap.img.zst"
log "Captured bootgap (${FIRST_START} sectors)"

# ── Detect an LVM root ──────────────────────────────────────────────────────────
# Ubuntu Server's default guided layout puts / on an ext4 LV inside a VG on a PV
# partition (e.g. ubuntu-vg/ubuntu-lv on sda3).  We capture the VG/LV names + which
# partition is the PV so dp-restore.sh can rebuild the LVM stack, then preserve the
# LV's filesystem UUID so fstab/GRUB resolve unchanged.
ROOT_FSTYPE="$(findmnt -no FSTYPE / | head -n1)"
ROOT_UUID="$(blkid -s UUID -o value "$ROOT_SRC" 2>/dev/null || true)"
part_num() { echo "$1" | grep -oE '[0-9]+$' || echo 0; }   # sda3→3, nvme0n1p3→3

IS_LVM=false; LVM_VG=""; LVM_LV=""; LVM_PV=""
if [[ "$(lsblk -no TYPE "$ROOT_SRC" 2>/dev/null | head -n1)" == "lvm" ]]; then
    command -v lvs >/dev/null || fatal "root is on LVM but lvm2 tools are missing"
    IS_LVM=true
    LVM_VG="$(lvs --noheadings -o vg_name "$ROOT_SRC" 2>/dev/null | tr -d ' ')"
    LVM_LV="$(lvs --noheadings -o lv_name "$ROOT_SRC" 2>/dev/null | tr -d ' ')"
    LVM_PV="$(pvs --noheadings -o pv_name,vg_name 2>/dev/null | awk -v vg="$LVM_VG" '$2==vg{print $1; exit}')"
    [[ -n "$LVM_VG" && -n "$LVM_LV" && -n "$LVM_PV" ]] \
        || fatal "LVM root but could not resolve VG/LV/PV (vg='$LVM_VG' lv='$LVM_LV' pv='$LVM_PV')"
    log "LVM root: VG=$LVM_VG  LV=$LVM_LV  PV=$LVM_PV"
fi

# JSON assembly helper for the partitions[] array (avoid a jq dependency).
json_parts=""
add_part() { # num mountpoint fstype uuid label role tar
    local entry
    entry="$(printf '{"num":%s,"mountpoint":"%s","fstype":"%s","uuid":"%s","label":"%s","role":"%s","tar":"%s"}' \
        "$1" "$2" "$3" "$4" "$5" "$6" "$7")"
    if [[ -z "$json_parts" ]]; then json_parts="$entry"; else json_parts="$json_parts,$entry"; fi
}

# ── Enumerate every partition on the disk, classify + archive mounted ones ──────
# Iterate the disk's real partitions (TYPE=part) — this catches unmounted PVs that
# `findmnt` would miss.  For non-LVM installs the root partition (mountpoint /) is
# archived as the outer download ("(self)"); an LVM root is handled via the lvm{}
# block below and does not appear as a partition here.
while read -r PNAME PTYPE PFSTYPE; do
    [[ "$PTYPE" == "part" ]] || continue
    PDEV="/dev/$PNAME"
    NUM="$(part_num "$PNAME")"
    UUID="$(blkid -s UUID -o value "$PDEV" 2>/dev/null || true)"
    LABEL="$(blkid -s LABEL -o value "$PDEV" 2>/dev/null || true)"
    MP="$(findmnt -no TARGET "$PDEV" 2>/dev/null | head -n1)"
    tarf=""; role="unused"
    if   [[ "$PFSTYPE" == "LVM2_member" ]];              then role="lvm-pv"
    elif [[ "$MP" == "/" ]];                             then role="root"; tarf="(self)"
    elif [[ "$MP" == "/boot/efi" || "$PFSTYPE" == "vfat" ]]; then role="esp"
    elif [[ "$MP" == "/boot" ]];                         then role="boot"
    elif [[ -n "$MP" ]];                                 then role="other"
    fi
    if [[ "$role" == "esp" || "$role" == "boot" || "$role" == "other" ]]; then
        safe="$(echo "$MP" | sed 's#^/##; s#/#_#g')"; [[ -z "$safe" ]] && safe="mount"
        tarf="mounts/${safe}.tar.zst"
        log "Archiving $MP ($PFSTYPE) -> $tarf"
        tar --numeric-owner --xattrs --acls -p -S \
            --warning=no-file-changed --ignore-failed-read \
            -C "$MP" -cf - . \
            | zstd -q -T0 -3 -o "$META_DIR/$tarf"
    fi
    add_part "$NUM" "$MP" "$PFSTYPE" "$UUID" "$LABEL" "$role" "$tarf"
done < <(lsblk -rno NAME,TYPE,FSTYPE "$DISK")

# Optional lvm{} block (present only for an LVM root).
LVM_JSON="null"
if $IS_LVM; then
    LVM_JSON="$(printf '{"vg":"%s","lv":"%s","pv_part_num":%s,"root_fstype":"%s","root_fs_uuid":"%s","root_tar":"(self)"}' \
        "$LVM_VG" "$LVM_LV" "$(part_num "$LVM_PV")" "$ROOT_FSTYPE" "$ROOT_UUID")"
fi

# 3. Manifest
cat > "$META_DIR/manifest.json" <<EOF
{
  "version": 2,
  "created": "${CREATED}",
  "app_version": "${APP_VERSION}",
  "arch": "${ARCH}",
  "kernel": "${KERNEL}",
  "model": "${MODEL}",
  "source_hostname": "${HOSTNAME_SRC}",
  "disk": {
    "device": "${DISK}",
    "size_bytes": ${DISK_BYTES},
    "sector_size": ${SECTOR_SIZE},
    "first_part_start_sector": ${FIRST_START}
  },
  "bootgap": { "file": "bootgap.img.zst", "sectors": ${FIRST_START} },
  "lvm": ${LVM_JSON},
  "partitions": [ ${json_parts} ]
}
EOF
log "Wrote manifest"
sync

# ── Stream the root filesystem to stdout ───────────────────────────────────────
# --one-file-system keeps us on the root fs only; the separate mounts above are
# already archived under $META_DIR (which lives on the root fs, so it rides along
# inside this tar).  Exclusions: pseudo/volatile trees, caches, logs, swap.
log "Streaming root filesystem (this is the long part)…"
exec tar --numeric-owner --xattrs --acls -p -S --one-file-system \
    --warning=no-file-changed --ignore-failed-read \
    --exclude='./lost+found' \
    --exclude='./swap.img' \
    --exclude='./swapfile' \
    --exclude='./var/log/journal/*' \
    --exclude='./var/log/*.gz' \
    --exclude='./var/cache/apt/archives/*.deb' \
    --exclude='./home/dp/.cache/gstreamer-1.0/*' \
    --exclude='./home/dp/.cache/chromium/*' \
    --exclude='./root/.cache/*' \
    -I 'zstd -T0 -3' \
    -C / -cf - .
