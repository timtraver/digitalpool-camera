#!/bin/bash
# dp-restore.sh — flash a DigitalPool Camera golden image onto a NEW device.
#
# Runs from a bootable recovery environment (an Ubuntu live USB with a few extra
# packages — see SYSTEM_IMAGE.md).  It takes an image produced by dp-create-image.sh
# and lays it down on the target internal disk, preserving every filesystem UUID
# so fstab / GRUB / extlinux keep working untouched.  On the target's first real
# boot, dp-firstboot.service sanitises the clone into a unique unit.
#
# The image MUST match the target's CPU architecture (x86_64 vs aarch64) — a
# cross-arch flash will not boot.  This script refuses a mismatch.
#
# Usage:
#   sudo bash dp-restore.sh <image.tar.zst> [/dev/target-disk]
#
# With no target disk, it lists candidates and prompts.

set -uo pipefail

RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${GREEN}  ✔  $*${NC}"; }
warn()  { echo -e "${YELLOW}  ⚠  $*${NC}"; }
step()  { echo -e "\n${CYAN}▶  $*${NC}"; }
fatal() { echo -e "${RED}  ✘  $*${NC}" >&2; cleanup; exit 1; }

WORK="$(mktemp -d /tmp/dp-restore.XXXXXX)"
ROOTMNT="${WORK}/root"
declare -a MOUNTED=()

cleanup() {
    # Unmount in reverse order, then drop the work dir.
    for ((i=${#MOUNTED[@]}-1; i>=0; i--)); do umount "${MOUNTED[$i]}" 2>/dev/null || true; done
    [[ -d "$ROOTMNT" ]] && umount "$ROOTMNT" 2>/dev/null || true
    rm -rf "$WORK" 2>/dev/null || true
}
trap cleanup EXIT

# ── Preconditions ───────────────────────────────────────────────────────────────
[[ $EUID -eq 0 ]] || fatal "run with sudo: sudo bash $0 <image> [disk]"
IMG="${1:-}"
[[ -n "$IMG" && -f "$IMG" ]] || fatal "usage: sudo bash $0 <image.tar.zst> [/dev/disk]"
IMG="$(readlink -f "$IMG")"
TARGET="${2:-}"

for t in zstd tar sfdisk sgdisk mkfs.ext4 mkfs.vfat partprobe python3 lsblk blkid; do
    command -v "$t" >/dev/null || fatal "missing tool: $t (see SYSTEM_IMAGE.md for the recovery-USB package list)"
done
GROWPART="$(command -v growpart || true)"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "   DigitalPool Camera — Image Restore / Flash"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── 1. Extract metadata from the image ──────────────────────────────────────────
step "Reading image metadata"
mkdir -p "$WORK/meta"
# Selective extract of just the metadata tree (fast to reach — it's near the start).
zstd -dc "$IMG" | tar -x -C "$WORK/meta" ./var/lib/dp-image 2>/dev/null || \
    zstd -dc "$IMG" | tar -x -C "$WORK/meta" var/lib/dp-image 2>/dev/null || true
META="$WORK/meta/var/lib/dp-image"
[[ -f "$META/manifest.json" ]] || fatal "image has no manifest — is this a dp-create-image.sh image?"

mj() {
    python3 - "$META/manifest.json" "$1" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
print(eval(sys.argv[2], {"d": d, "max": max, "min": min}))
PY
}
IMG_ARCH="$(mj 'd["arch"]')"
SRC_DISK_BYTES="$(mj 'd["disk"]["size_bytes"]')"
SRC_SECTOR="$(mj 'd["disk"]["sector_size"]')"
FIRST_START="$(mj 'd["disk"]["first_part_start_sector"]')"
SRC_HOST="$(mj 'd["source_hostname"]')"
SRC_MODEL="$(mj 'd["model"]')"
info "Image: ${SRC_HOST} (${IMG_ARCH}, ${SRC_MODEL}), source disk ${SRC_DISK_BYTES} bytes"

HOST_ARCH="$(uname -m)"
if [[ "$IMG_ARCH" != "$HOST_ARCH" ]]; then
    fatal "architecture mismatch: image is ${IMG_ARCH} but this machine is ${HOST_ARCH}. Boot the matching recovery USB."
fi

# ── 2. Choose + validate the target disk ────────────────────────────────────────
step "Selecting target disk"
IMG_DISK="$(df --output=source "$IMG" 2>/dev/null | tail -n1)"   # disk the image file lives on
if [[ -z "$TARGET" ]]; then
    echo "  Available disks:"
    lsblk -dn -o NAME,SIZE,MODEL,TYPE | awk '$4=="disk"{printf "    /dev/%s  %s  %s\n",$1,$2,$3}'
    read -rp "  Enter target disk (e.g. /dev/nvme0n1): " TARGET
fi
[[ -b "$TARGET" ]] || fatal "'$TARGET' is not a block device"
# Guards.
[[ "$(lsblk -no TYPE "$TARGET" | head -n1)" == "disk" ]] || fatal "'$TARGET' is not a whole disk"
case "$IMG_DISK" in "$TARGET"*) fatal "target '$TARGET' holds the image file itself — choose another disk";; esac
if lsblk -no MOUNTPOINT "$TARGET" | grep -q '/'; then
    fatal "'$TARGET' has mounted partitions — unmount them first"
fi
TGT_BYTES="$(blockdev --getsize64 "$TARGET")"
if (( TGT_BYTES < SRC_DISK_BYTES )); then
    fatal "target ($TGT_BYTES bytes) is smaller than the source disk ($SRC_DISK_BYTES). Use a same-size-or-larger disk."
fi

echo ""
warn "This will ERASE ALL DATA on ${TARGET} ($(lsblk -dn -o SIZE "$TARGET"))."
warn "Source image: ${SRC_HOST} (${IMG_ARCH})."
read -rp "  Type ERASE to proceed: " CONFIRM
[[ "$CONFIRM" == "ERASE" ]] || { echo "  Aborted."; exit 0; }

partdev() { # <disk> <num>  → correct partition node (sda1 vs nvme0n1p1)
    local d="$1" n="$2"
    if [[ "$d" =~ [0-9]$ ]]; then echo "${d}p${n}"; else echo "${d}${n}"; fi
}

# ── 3. Recreate the partition table + bootloader gap ────────────────────────────
step "Writing partition table and boot area to ${TARGET}"
wipefs -a "$TARGET" >/dev/null 2>&1 || true
sgdisk --zap-all "$TARGET" >/dev/null 2>&1 || true
# Restore protective MBR + primary GPT + (on RK3588) idbloader/u-boot living in
# the gap before partition 1.  This also re-establishes the exact source layout.
zstd -dc "$META/bootgap.img.zst" | dd of="$TARGET" bs="$SRC_SECTOR" conv=notrunc status=none
partprobe "$TARGET" 2>/dev/null || true
sleep 1
# Fix the backup GPT header — it must sit at the end of the (possibly larger) disk.
sgdisk -e "$TARGET" >/dev/null 2>&1 || sgdisk --move-second-header "$TARGET" >/dev/null 2>&1 || true
partprobe "$TARGET" 2>/dev/null || true
info "Partition table restored"

# ── 4. LVM info + grow the last partition to fill a larger disk ─────────────────
PART_LINES='"\n".join("%s|%s|%s|%s|%s|%s|%s"%(p["num"],p["mountpoint"],p["fstype"],p["uuid"],p.get("label",""),p["role"],p["tar"]) for p in d["partitions"])'
MAX_NUM="$(mj 'max(p["num"] for p in d["partitions"])')"
IS_LVM="$(mj 'bool(d.get("lvm"))')"    # "True" when root lives on LVM
if [[ "$IS_LVM" == "True" ]]; then
    LVM_VG="$(mj 'd["lvm"]["vg"]')"
    LVM_LV="$(mj 'd["lvm"]["lv"]')"
    LVM_PV_NUM="$(mj 'd["lvm"]["pv_part_num"]')"
    LVM_ROOT_UUID="$(mj 'd["lvm"]["root_fs_uuid"]')"
    for t in pvcreate vgcreate lvcreate; do command -v "$t" >/dev/null || fatal "root is on LVM but '$t' is missing (apt install lvm2)"; done
    info "LVM root: ${LVM_VG}/${LVM_LV} on partition ${LVM_PV_NUM}"
else
    ROOT_NUM="$(mj '[p["num"] for p in d["partitions"] if p["role"]=="root"][0]')"
fi

# Grow the LAST partition (root for plain installs, the LVM PV for LVM installs)
# to consume the extra space on a larger target disk.
if [[ -n "$GROWPART" && $TGT_BYTES -gt $SRC_DISK_BYTES ]]; then
    step "Growing partition ${MAX_NUM} to fill the disk"
    "$GROWPART" "$TARGET" "$MAX_NUM" >/dev/null 2>&1 && info "Partition ${MAX_NUM} grown" || warn "growpart skipped (no free space or unsupported)"
    partprobe "$TARGET" 2>/dev/null || true
fi

# ── 5. Create filesystems, PRESERVING each UUID ─────────────────────────────────
# Preserving UUIDs is what lets fstab / GRUB / extlinux work with zero rewriting.
step "Creating filesystems (preserving UUIDs)"
mkdir -p "$ROOTMNT"
# Iterate partitions: num|mountpoint|fstype|uuid|label|role|tar
while IFS='|' read -r NUM MP FSTYPE UUID LABEL ROLE TARF; do
    [[ -z "$NUM" ]] && continue
    # LVM PVs are (re)built below; unused partitions have no filesystem.
    [[ "$ROLE" == "lvm-pv" || "$ROLE" == "unused" ]] && continue
    DEV="$(partdev "$TARGET" "$NUM")"
    [[ -b "$DEV" ]] || fatal "expected partition $DEV not present after partitioning"
    case "$FSTYPE" in
        ext4|ext3|ext2)
            mkfs.ext4 -F -q -U "$UUID" ${LABEL:+-L "$LABEL"} "$DEV"
            ;;
        vfat|fat32|fat16|msdos)
            VOLID="$(echo "$UUID" | tr -d '-' | tr 'a-f' 'A-F')"   # XXXX-XXXX → XXXXXXXX
            mkfs.vfat -F32 ${VOLID:+-i "$VOLID"} ${LABEL:+-n "$LABEL"} "$DEV" >/dev/null
            ;;
        *)
            warn "unknown fstype '$FSTYPE' on partition $NUM — formatting ext4 (may need manual fix)"
            mkfs.ext4 -F -q -U "$UUID" "$DEV"
            ;;
    esac
    info "mkfs ${FSTYPE} ${DEV} (uuid ${UUID})"
done < <(mj "$PART_LINES")

# ── 5b. Rebuild the LVM stack (LVM installs only) ───────────────────────────────
# Recreate PV → VG → LV with the SAME vg/lv names (so GRUB's /dev/mapper path and
# initramfs activation resolve), then mkfs the LV with the preserved root UUID.
if [[ "$IS_LVM" == "True" ]]; then
    step "Rebuilding LVM stack (${LVM_VG}/${LVM_LV})"
    PVDEV="$(partdev "$TARGET" "$LVM_PV_NUM")"
    [[ -b "$PVDEV" ]] || fatal "PV partition $PVDEV missing after partitioning"
    vgchange -an "$LVM_VG" 2>/dev/null || true
    wipefs -a "$PVDEV" >/dev/null 2>&1 || true
    pvcreate -ff -y "$PVDEV" >/dev/null || fatal "pvcreate on $PVDEV failed"
    vgcreate "$LVM_VG" "$PVDEV" >/dev/null || fatal "vgcreate $LVM_VG failed (is that VG name already active in this recovery env?)"
    lvcreate -y -l 100%FREE -n "$LVM_LV" "$LVM_VG" >/dev/null || fatal "lvcreate $LVM_LV failed"
    vgchange -ay "$LVM_VG" >/dev/null 2>&1 || true
    ROOT_DEV="/dev/${LVM_VG}/${LVM_LV}"
    [[ -b "$ROOT_DEV" ]] || fatal "LV device $ROOT_DEV did not appear"
    mkfs.ext4 -F -q -U "$LVM_ROOT_UUID" "$ROOT_DEV"
    info "LV ${ROOT_DEV} formatted (uuid ${LVM_ROOT_UUID})"
else
    ROOT_DEV="$(partdev "$TARGET" "$ROOT_NUM")"
fi

# ── 6. Extract the root filesystem ──────────────────────────────────────────────
step "Extracting root filesystem (this is the long part)"
mount "$ROOT_DEV" "$ROOTMNT" || fatal "cannot mount root $ROOT_DEV"
zstd -dc "$IMG" | tar -x --numeric-owner --xattrs --acls -p -S -C "$ROOTMNT" \
    || fatal "root extraction failed"
info "Root filesystem extracted"

# ── 7. Extract the other filesystems (ESP, /boot, …) onto their mounts ──────────
step "Extracting boot / EFI filesystems"
while IFS='|' read -r NUM MP FSTYPE UUID LABEL ROLE TARF; do
    [[ -z "$NUM" || "$ROLE" == "root" || "$ROLE" == "lvm-pv" || "$ROLE" == "unused" ]] && continue
    [[ -z "$TARF" || "$TARF" == "(self)" ]] && continue
    DEV="$(partdev "$TARGET" "$NUM")"
    DEST="${ROOTMNT}${MP}"
    mkdir -p "$DEST"
    mount "$DEV" "$DEST" || fatal "cannot mount $DEV at $DEST"
    MOUNTED+=("$DEST")
    TARPATH="${ROOTMNT}/var/lib/dp-image/${TARF}"
    [[ -f "$TARPATH" ]] || { warn "archive $TARF missing in image — skipping $MP"; continue; }
    zstd -dc "$TARPATH" | tar -x --numeric-owner --xattrs --acls -p -S -C "$DEST" \
        || fatal "extraction of $MP failed"
    info "Populated ${MP} from ${TARF}"
done < <(mj "$PART_LINES")

# ── 8. Architecture-specific bootloader fixups ──────────────────────────────────
step "Finalising bootloader for ${IMG_ARCH}"
if [[ "$IMG_ARCH" == "x86_64" ]]; then
    # New hardware has no "ubuntu" EFI NVRAM entry.  Guarantee a firmware-default
    # fallback loader at /EFI/BOOT/BOOTX64.EFI so the box boots without one.
    ESP="${ROOTMNT}/boot/efi"
    if [[ -d "${ESP}/EFI" ]]; then
        mkdir -p "${ESP}/EFI/BOOT"
        if   [[ -f "${ESP}/EFI/ubuntu/shimx64.efi" ]]; then
            cp -f "${ESP}/EFI/ubuntu/shimx64.efi" "${ESP}/EFI/BOOT/BOOTX64.EFI"
            [[ -f "${ESP}/EFI/ubuntu/grubx64.efi" ]] && cp -f "${ESP}/EFI/ubuntu/grubx64.efi" "${ESP}/EFI/BOOT/grubx64.efi"
            [[ -f "${ESP}/EFI/ubuntu/mmx64.efi"   ]] && cp -f "${ESP}/EFI/ubuntu/mmx64.efi"   "${ESP}/EFI/BOOT/mmx64.efi"
            info "Installed EFI fallback loader (shim → BOOTX64.EFI)"
        elif [[ -f "${ESP}/EFI/ubuntu/grubx64.efi" ]]; then
            cp -f "${ESP}/EFI/ubuntu/grubx64.efi" "${ESP}/EFI/BOOT/BOOTX64.EFI"
            info "Installed EFI fallback loader (grub → BOOTX64.EFI)"
        else
            warn "no shim/grub found in ESP — the new box may need a manual EFI entry"
        fi
        # GRUB reads root by UUID (preserved), so grub.cfg needs no edits.
    else
        warn "no EFI directory in ESP — is this really an EFI install?"
    fi
else
    # RK3588 / aarch64: u-boot came back with the bootgap dd; extlinux/boot config
    # references root by its (preserved) UUID, so there is nothing more to do.
    info "aarch64: u-boot restored from boot area; nothing further required"
fi

# ── 9. Arm the first-boot sanitiser ─────────────────────────────────────────────
step "Arming first-boot sanitiser"
UNIT_SRC="${ROOTMNT}/home/dp/digitalpool-camera/dp-firstboot.service"
if [[ -f "$UNIT_SRC" ]]; then
    cp -f "$UNIT_SRC" "${ROOTMNT}/etc/systemd/system/dp-firstboot.service"
    mkdir -p "${ROOTMNT}/etc/systemd/system/multi-user.target.wants"
    ln -sf ../dp-firstboot.service \
        "${ROOTMNT}/etc/systemd/system/multi-user.target.wants/dp-firstboot.service"
    mkdir -p "${ROOTMNT}/var/lib/dp-image"
    : > "${ROOTMNT}/var/lib/dp-image/firstboot-pending"
    info "dp-firstboot.service enabled — clone will sanitise itself on first boot"
else
    warn "dp-firstboot.service not found in image — you must run dp-device-reset.sh manually after boot"
fi

# ── 10. Done ────────────────────────────────────────────────────────────────────
step "Flushing and unmounting"
sync
cleanup
trap - EXIT

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${GREEN}  ✅  Flash complete — ${TARGET} is ready${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  1. Power off, remove the recovery USB."
echo "  2. Boot the device — it will sanitise itself (new machine-id, SSH keys,"
echo "     hostname dp-stream-XXXX, cleared app state) and reboot once."
echo "  3. Connect to hotspot 'DigitalPool-Camera' → http://192.168.50.1:3000"
echo "     Log in (admin / Digitalpool), rename the device, and register it."
echo ""
