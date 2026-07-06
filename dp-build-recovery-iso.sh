#!/bin/bash
# dp-build-recovery-iso.sh — bake an all-in-one bootable RECOVERY ISO.
#
# Runs on the camera device (Linux). Takes a stock Ubuntu Server (live-server) ISO
# and one of your captured images, and produces a single bootable .iso containing:
#   • the Ubuntu live environment (the boot part)
#   • your image  (…tar.zst)
#   • dp-restore.sh + the flashing tools as offline .deb packages
#
# The live-server ISO (~2.6 GB) keeps the output small; the flash flow is CLI-only
# so no desktop GUI is needed. On a Mac you then just balenaEtcher that ONE file to
# ONE stick — no network is needed on the target, nothing else to copy. See
# SYSTEM_IMAGE.md.
#
# Usage:
#   sudo apt install -y xorriso
#   bash dp-build-recovery-iso.sh <ubuntu-live-server.iso> <image.tar.zst> [out.iso]
#
# Notes:
#   • Needs internet on THIS device (to fetch the tool .debs) — build-time only.
#   • The output ISO is ~= ubuntu.iso + image (e.g. ~10 GB) → use a 16 GB+ stick.
#   • Must match architecture: use an amd64 Ubuntu ISO for x86_64 images.

set -uo pipefail

RED='\033[0;31m'; GRN='\033[0;32m'; CYN='\033[0;36m'; NC='\033[0m'
info(){ echo -e "${GRN}  ✔  $*${NC}"; }
step(){ echo -e "\n${CYN}▶  $*${NC}"; }
fatal(){ echo -e "${RED}  ✘  $*${NC}" >&2; [[ -n "${WORK:-}" ]] && rm -rf "$WORK"; exit 1; }

HERE="$(cd "$(dirname "$0")" && pwd)"
# Default output into system-images/ so it shows up in the UI's image list for a
# resumable browser download (the file is named dp-recovery-* so the UI accepts it).
IMAGES_DIR="/home/dp/system-images"
UBUNTU_ISO="${1:-}"; IMAGE="${2:-}"
OUT="${3:-$IMAGES_DIR/dp-recovery-$(date +%Y%m%d-%H%M).iso}"

[[ -f "$UBUNTU_ISO" ]] || fatal "usage: bash $0 <ubuntu-desktop.iso> <image.tar.zst> [out.iso]"
mkdir -p "$(dirname "$OUT")" 2>/dev/null || true
[[ -f "$IMAGE"      ]] || fatal "image not found: $IMAGE"
command -v xorriso >/dev/null || fatal "xorriso missing — sudo apt install -y xorriso"
[[ -f "$HERE/dp-restore.sh" ]] || fatal "dp-restore.sh not found next to this script"

IMAGE="$(readlink -f "$IMAGE")"
UBUNTU_ISO="$(readlink -f "$UBUNTU_ISO")"
IMG_BASE="$(basename "$IMAGE")"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "   DigitalPool Camera — Build Recovery ISO"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
info "Base ISO : $UBUNTU_ISO"
info "Image    : $IMAGE"
info "Output   : $OUT"

WORK="$(mktemp -d /var/tmp/dp-iso.XXXXXX)"
PAYLOAD="$WORK/dp"
mkdir -p "$PAYLOAD/tools"

# ── 1. Fetch the flashing tools as .debs (offline install target) ───────────────
# Only the leaf tool packages — their libraries are already present in the Ubuntu
# live environment, so we never touch libc/core libs. dp-restore.sh checks for each
# tool and errors clearly if one is genuinely unavailable.
step "Downloading flashing tools (build-time network required)…"
( cd "$PAYLOAD/tools" && apt-get download zstd gdisk cloud-guest-utils dosfstools lvm2 parted 2>/dev/null ) \
    || echo "  ⚠  could not download some .debs — the live env may already include them"
info "Bundled $(ls "$PAYLOAD/tools" | wc -l) tool package(s)"

# ── 2. Stage the payload (restore script + flash wrapper + readme) ──────────────
cp "$HERE/dp-restore.sh" "$PAYLOAD/dp-restore.sh"

cat > "$PAYLOAD/dp-flash.sh" <<PAYLOAD_EOF
#!/bin/bash
# Auto-generated flash wrapper — run this from the Ubuntu Server installer shell:
#     bash /cdrom/dp/dp-flash.sh
# Installs the bundled tools offline, then launches the restore (which lists the
# target disks and prompts you to pick one).
set -uo pipefail
HERE="\$(cd "\$(dirname "\$0")" && pwd)"
# The server-installer shell runs as root; use sudo only if we're not already root.
SUDO=""; [[ \$EUID -ne 0 ]] && SUDO="sudo"
echo "Installing bundled flashing tools (offline)…"
# Two passes settle any dpkg ordering; failures are tolerated (libs already present).
\$SUDO dpkg -i "\$HERE"/tools/*.deb >/dev/null 2>&1 || true
\$SUDO dpkg -i "\$HERE"/tools/*.deb >/dev/null 2>&1 || true
IMG="\$(ls "\$HERE"/*.tar.zst 2>/dev/null | head -n1)"
[[ -n "\$IMG" ]] || { echo "No image .tar.zst found on the recovery medium"; exit 1; }
echo "Image: \$IMG"
exec \$SUDO bash "\$HERE/dp-restore.sh" "\$IMG"
PAYLOAD_EOF
chmod +x "$PAYLOAD/dp-flash.sh"

cat > "$PAYLOAD/README.txt" <<'READ_EOF'
DigitalPool Camera — recovery medium (Ubuntu Server base)
=========================================================
1. Boot this USB on the TARGET device. At the GRUB menu pick "Try or Install
   Ubuntu Server" — it starts the installer.
2. Get a root shell: press Ctrl+Alt+F2 (a root prompt appears), OR in the
   installer click "Help" (top-right) → "Enter shell".
3. Run:
       bash /cdrom/dp/dp-flash.sh
   (If /cdrom/dp is missing:  bash "$(find / -name dp-flash.sh 2>/dev/null | head -1)")
4. Type ERASE when prompted and pick the internal disk. Wait for "Flash complete".
5. Power off, remove the USB, boot the device — it sanitises itself on first boot.
No network is required.
READ_EOF
info "Payload staged"

# ── 3. Remaster: copy the Ubuntu ISO adding /dp, preserving boot records ────────
# `-boot_image any replay` re-uses the source ISO's El Torito / EFI boot setup, so
# the output stays bootable on both BIOS and UEFI. We only ADD files (never touch
# the squashfs or bootloaders), which is the safe, well-worn remaster path.
step "Building bootable ISO (this copies ~$(du -h "$UBUNTU_ISO" | cut -f1) + $(du -h "$IMAGE" | cut -f1))…"
xorriso -indev "$UBUNTU_ISO" -outdev "$OUT" \
    -boot_image any replay \
    -map "$PAYLOAD" /dp \
    -map "$IMAGE" "/dp/$IMG_BASE" \
    || fatal "xorriso failed"

rm -rf "$WORK"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${GRN}  ✅  Recovery ISO ready:${NC}"
echo "      $OUT  ($(du -h "$OUT" | cut -f1))"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  On your Mac:"
echo "    1. Copy $OUT to the Mac (scp / the file is on the device)."
echo "    2. balenaEtcher → flash this .iso to a 16 GB+ USB stick."
echo "    3. Boot the TARGET device from it → Try Ubuntu → Terminal:"
echo "         sudo bash /cdrom/dp/dp-flash.sh"
echo ""
