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
ROOT_SRC="$(findmnt -no SOURCE /)"                 # e.g. /dev/nvme0n1p2 or /dev/sda2
[[ -n "$ROOT_SRC" ]] || fatal "cannot determine root device"
DISK="/dev/$(lsblk -no PKNAME "$ROOT_SRC" | head -n1)"   # parent disk, e.g. /dev/nvme0n1
[[ -b "$DISK" ]] || fatal "computed disk '$DISK' is not a block device"

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

# ── Enumerate mounts and classify each partition ───────────────────────────────
# We build the manifest's partition array here, tarring every non-root OS mount
# that sits on its own filesystem into mounts/<name>.tar.zst.
ROOT_FSTYPE="$(findmnt -no FSTYPE /)"
ROOT_UUID="$(blkid -s UUID -o value "$ROOT_SRC" || true)"

# JSON assembly helpers (avoid jq dependency).
json_parts=""
add_part() { # num mountpoint fstype uuid label role tar
    local entry
    entry="$(printf '{"num":%s,"mountpoint":"%s","fstype":"%s","uuid":"%s","label":"%s","role":"%s","tar":"%s"}' \
        "$1" "$2" "$3" "$4" "$5" "$6" "$7")"
    if [[ -z "$json_parts" ]]; then json_parts="$entry"; else json_parts="$json_parts,$entry"; fi
}

# Root partition — its content IS the outer download, so tar="(self)".
ROOT_NUM="$(echo "$ROOT_SRC" | grep -oE '[0-9]+$' || echo 0)"
add_part "$ROOT_NUM" "/" "$ROOT_FSTYPE" "$ROOT_UUID" "$(blkid -s LABEL -o value "$ROOT_SRC" || true)" "root" "(self)"

# Every other mount whose backing device is a partition of the SAME disk and
# whose mountpoint is a real OS path (not pseudo/removable) gets its own tar.
while read -r MP SRC FSTYPE; do
    [[ -z "$MP" || "$MP" == "/" ]] && continue
    # only partitions of the disk we're imaging
    case "$SRC" in
        "$DISK"*) : ;;
        *) continue ;;
    esac
    # skip pseudo / removable-ish mountpoints
    case "$MP" in
        /proc*|/sys*|/dev*|/run*|/tmp*|/mnt*|/media*|/snap*) continue ;;
    esac
    local_num="$(echo "$SRC" | grep -oE '[0-9]+$' || echo 0)"
    uuid="$(blkid -s UUID -o value "$SRC" || true)"
    label="$(blkid -s LABEL -o value "$SRC" || true)"
    role="other"; [[ "$MP" == "/boot/efi" || "$FSTYPE" == "vfat" ]] && role="esp"
    [[ "$MP" == "/boot" ]] && role="boot"
    safe="$(echo "$MP" | sed 's#^/##; s#/#_#g')"; [[ -z "$safe" ]] && safe="mount"
    log "Archiving mount $MP ($FSTYPE) -> mounts/${safe}.tar.zst"
    tar --numeric-owner --xattrs --acls -p -S \
        --warning=no-file-changed --ignore-failed-read \
        -C "$MP" -cf - . \
        | zstd -q -T0 -3 -o "$META_DIR/mounts/${safe}.tar.zst"
    add_part "$local_num" "$MP" "$FSTYPE" "$uuid" "$label" "$role" "mounts/${safe}.tar.zst"
done < <(findmnt -rn -o TARGET,SOURCE,FSTYPE)

# 3. Manifest
cat > "$META_DIR/manifest.json" <<EOF
{
  "version": 1,
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
