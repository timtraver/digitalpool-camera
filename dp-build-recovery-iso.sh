#!/bin/bash
# dp-build-recovery-iso.sh — bake an all-in-one bootable RECOVERY / FACTORY ISO.
#
# Runs on the camera device (Linux). Takes a stock Ubuntu Server (live-server) ISO
# and one of your captured images, and produces a single bootable .iso containing:
#   • the Ubuntu live environment (the boot part)
#   • your image  (…tar.zst)
#   • dp-restore.sh + dp-factory-install.sh + the flashing tools as offline .debs
#   • an autoinstall seed, and a GRUB menu whose DEFAULT entry flashes the unit
#     with no operator input at all
#
# Boot it and walk away: after a 15-second countdown it images the internal disk
# and powers the unit off. That is what the OEM factory gets — no shell, no script
# to run, nobody intercepting the Ubuntu installer. The menu still carries a
# "manual restore shell" entry and the stock Ubuntu entries for field recovery.
#
# The live-server ISO (~2.6 GB) keeps the output small; the flash flow is CLI-only
# so no desktop GUI is needed. On a Mac you then just balenaEtcher that ONE file to
# ONE stick — no network is needed on the target, nothing else to copy. See
# SYSTEM_IMAGE.md and FACTORY_INSTALL.md.
#
# Usage:
#   sudo apt install -y xorriso
#   bash dp-build-recovery-iso.sh <ubuntu-live-server.iso> <image.tar.zst> [out.iso]
#
# Notes:
#   • Needs internet on THIS device (to fetch the tool .debs) — build-time only.
#   • The output ISO is ~= ubuntu.iso + image (e.g. ~10 GB) → use a 16 GB+ stick.
#   • Must match architecture: use an amd64 Ubuntu ISO for x86_64 images. The
#     automatic entry is x86_64-only (RK3588 has no equivalent ISO boot path);
#     an aarch64 build still produces a working manual recovery medium.

set -uo pipefail

RED='\033[0;31m'; YEL='\033[1;33m'; GRN='\033[0;32m'; CYN='\033[0;36m'; NC='\033[0m'
info(){ echo -e "${GRN}  ✔  $*${NC}"; }
warn(){ echo -e "${YEL}  ⚠  $*${NC}"; }
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
[[ -f "$HERE/dp-factory-install.sh" ]] || fatal "dp-factory-install.sh not found next to this script"

# The automatic entry rewrites the ISO's GRUB menu, which only exists on x86.
ARCH="$(uname -m)"
AUTO_INSTALL=true
[[ "$ARCH" == "x86_64" ]] || AUTO_INSTALL=false

IMAGE="$(readlink -f "$IMAGE")"
UBUNTU_ISO="$(readlink -f "$UBUNTU_ISO")"
IMG_BASE="$(basename "$IMAGE")"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "   DigitalPool Camera — Build Install / Recovery ISO"
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
cp "$HERE/dp-restore.sh"        "$PAYLOAD/dp-restore.sh"
cp "$HERE/dp-factory-install.sh" "$PAYLOAD/dp-factory-install.sh"
chmod +x "$PAYLOAD/dp-factory-install.sh"

# The autoinstall seed that makes the install unattended.  subiquity runs
# early-commands BEFORE it probes or touches any disk, so our flasher owns the
# machine; it never returns (it powers the unit off), so the Ubuntu install that
# would have followed never happens.  interactive-sections is the backstop: if the
# flasher ever did return, the installer stops at a screen waiting for a human
# instead of installing Ubuntu over the clone we just wrote.
mkdir -p "$PAYLOAD/seed"
cat > "$PAYLOAD/seed/user-data" <<'SEED_EOF'
#cloud-config
autoinstall:
  version: 1
  interactive-sections:
    - storage
  early-commands:
    - /bin/bash /cdrom/dp/dp-factory-install.sh
SEED_EOF
: > "$PAYLOAD/seed/meta-data"      # NoCloud requires the file to exist, empty is fine

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
DigitalPool Camera — install / recovery medium (Ubuntu Server base)
===================================================================

AUTOMATIC (what the factory does)
  1. Plug this USB into the unit and power it on (boot from USB).
  2. Leave it alone. The menu's default entry starts after 15 seconds and
     images the internal disk by itself; progress shows on screen.
  3. The unit POWERS ITSELF OFF when it is done. Remove the USB and box it.
     A green "INSTALL COMPLETE" screen means ready to ship.
     A red "FACTORY INSTALL FAILED" screen means DO NOT SHIP — set it aside.
  No network, no keyboard, no typing.

MANUAL (field recovery)
  1. At the GRUB menu pick "manual restore shell" (or any stock Ubuntu entry).
  2. Get a root shell: Ctrl+Alt+F2, OR the installer's Help → Enter shell.
  3. Run:  bash /cdrom/dp/dp-flash.sh
  4. Type ERASE when prompted and pick the internal disk.
  5. Power off, remove the USB, boot the device.

Either way the device sanitises itself (new hostname, machine-id, SSH keys)
on its first real boot.
READ_EOF
info "Payload staged"

# ── 2b. GRUB menu: make the automatic install the default entry ─────────────────
# We keep the stock menu verbatim and append to it, so every Ubuntu entry still
# works and nothing version-specific has to be guessed; the trailing `set default`
# / `set timeout` win because GRUB parses the whole file before drawing the menu.
# The kernel/initrd paths come from the ISO's own entry rather than hardcoded.
GRUB_MAP=()
if $AUTO_INSTALL; then
    step "Building the boot menu (automatic install as default)"
    STOCK="$WORK/grub-stock.cfg"
    xorriso -osirrox on -indev "$UBUNTU_ISO" -extract /boot/grub/grub.cfg "$STOCK" >/dev/null 2>&1 \
        || warn "could not read the ISO's grub.cfg — falling back to the standard casper paths"

    KPATH="/casper/vmlinuz"; IPATH="/casper/initrd"; KARGS=""
    if [[ -s "$STOCK" ]]; then
        LINE="$(grep -m1 -E '^[[:space:]]*linux[[:space:]]+/casper/' "$STOCK" || true)"
        if [[ -n "$LINE" ]]; then
            read -r _ KPATH KARGS <<<"$(sed 's/^[[:space:]]*//' <<<"$LINE")"
            KARGS="${KARGS%%---*}"                       # drop the casper separator
            KARGS="$(sed 's/[[:space:]]*$//' <<<"$KARGS")"
        fi
        LINE="$(grep -m1 -E '^[[:space:]]*initrd[[:space:]]+/casper/' "$STOCK" || true)"
        [[ -n "$LINE" ]] && read -r _ IPATH _ <<<"$(sed 's/^[[:space:]]*//' <<<"$LINE")"
    else
        # No stock menu to append to — write a minimal self-contained one.
        printf '%s\n' 'set menu_color_normal=white/black' 'set menu_color_highlight=black/light-gray' \
            > "$STOCK"
        cat >> "$STOCK" <<STOCK_EOF
menuentry 'Try or Install Ubuntu Server' {
	set gfxpayload=keep
	linux	${KPATH} ---
	initrd	${IPATH}
}
STOCK_EOF
    fi
    info "Boot entry: linux ${KPATH} ${KARGS}"

    GRUBCFG="$WORK/grub.cfg"
    cp "$STOCK" "$GRUBCFG"
    # file:// (not a bare path) because cloud-init deprecated schemeless NoCloud
    # seeds; `\;` because an unescaped semicolon ends a GRUB command.
    cat >> "$GRUBCFG" <<GRUB_EOF

# ── DigitalPool Camera (added by dp-build-recovery-iso.sh) ─────────────────────
menuentry 'DigitalPool Camera — AUTOMATIC INSTALL (erases the internal disk)' --id dp-auto {
	set gfxpayload=keep
	linux	${KPATH} ${KARGS} autoinstall ds=nocloud\\;s=file:///cdrom/dp/seed/ ---
	initrd	${IPATH}
}

menuentry 'DigitalPool Camera — manual restore shell (erases nothing by itself)' --id dp-manual {
	set gfxpayload=keep
	linux	${KPATH} ${KARGS} ---
	initrd	${IPATH}
}

set default="dp-auto"
set timeout=15
set timeout_style=menu
GRUB_EOF
    GRUB_MAP=(-map "$GRUBCFG" /boot/grub/grub.cfg)
else
    warn "not x86_64 — building a manual-only recovery ISO (no automatic entry)"
fi

# ── 3. Remaster: copy the Ubuntu ISO adding /dp, preserving boot records ────────
# `-boot_image any replay` re-uses the source ISO's El Torito / EFI boot setup, so
# the output stays bootable on both BIOS and UEFI. Apart from the menu text in
# /boot/grub/grub.cfg we only ADD files — the squashfs and the bootloader binaries
# themselves are untouched, which is the safe, well-worn remaster path.
step "Building bootable ISO (this copies ~$(du -h "$UBUNTU_ISO" | cut -f1) + $(du -h "$IMAGE" | cut -f1))…"
# -overwrite on lets the replacement grub.cfg land on top of the stock one.
xorriso -indev "$UBUNTU_ISO" -outdev "$OUT" \
    -boot_image any replay \
    -overwrite on \
    -map "$PAYLOAD" /dp \
    -map "$IMAGE" "/dp/$IMG_BASE" \
    "${GRUB_MAP[@]}" \
    || fatal "xorriso failed"

rm -rf "$WORK"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${GRN}  ✅  Bootable ISO ready$( $AUTO_INSTALL && echo " (installs automatically)"):${NC}"
echo "      $OUT  ($(du -h "$OUT" | cut -f1))"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  1. Download $OUT (UI ▸ Admin ▸ System Image, or scp)."
echo "  2. balenaEtcher → flash this .iso to a 16 GB+ USB stick."
if $AUTO_INSTALL; then
echo "  3. Boot the TARGET device from it and walk away:"
echo "       the menu's default entry starts after 15s, images the internal"
echo "       disk, and powers the unit off. Green screen = ready to ship."
echo "     (Field recovery: pick 'manual restore shell' in the menu instead,"
echo "      then Ctrl+Alt+F2 → bash /cdrom/dp/dp-flash.sh)"
else
echo "  3. Boot the TARGET device from it → Ctrl+Alt+F2 → "
echo "       bash /cdrom/dp/dp-flash.sh"
fi
echo ""
