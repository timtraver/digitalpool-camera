#!/bin/bash
# dp-factory-install.sh — UNATTENDED flash, for the factory.
#
# This is the whole "a person intercepts the install and runs a script" step,
# turned into something that happens by itself.  It is baked onto the recovery
# ISO at /dp/ by dp-build-recovery-iso.sh and launched by the Ubuntu installer's
# autoinstall `early-commands` (see /dp/seed/user-data), i.e. before subiquity
# touches a single block of the disk.
#
# Boot the ISO → wait → the unit powers itself off with the golden image on its
# internal disk.  Nobody types anything.
#
#   1. installs the bundled flashing tools from the ISO (no network)
#   2. finds the golden image on the ISO
#   3. picks the internal disk automatically (dp-restore.sh --auto)
#   4. flashes + verifies it
#   5. copies this log onto the installed system, then powers off
#
# IT MUST NEVER RETURN.  If it exited 0, subiquity would carry on and install
# stock Ubuntu over the clone we just laid down; if it exited non-zero the
# installer would show its own error over ours.  Both ends therefore block
# forever — on success while the machine powers off, on failure so the red
# screen stays up for the operator.
#
# It is reached from EVERY entry in the boot menu, including Ubuntu's own, because
# subiquity finds /autoinstall.yaml at the root of the installation medium without
# anything on the kernel command line.  That is deliberate — the first factory ISO
# booted a stock GRUB menu, nothing on the command line reached subiquity, and the
# unit sat in the interactive installer.  The ten-second abort window below is what
# keeps the medium usable on a machine you only meant to look at.
#
# Kernel command-line overrides (add them in the GRUB menu with `e`):
#   dp.manual              don't install; hand the machine to the Ubuntu installer
#   dp.disk=/dev/nvme0n1   flash this disk instead of auto-selecting
#   dp.end=reboot|halt     reboot, or stay on, instead of powering off
#   dp.tty=4               use a different console for the progress display

set -uo pipefail

# The installer runs early-commands as root; a human testing it by hand may not be.
[[ $EUID -eq 0 ]] || exec sudo bash "$0" "$@"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG="/var/log/dp-factory-install.log"
START_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

RED='\033[1;31m'; GRN='\033[1;32m'; YEL='\033[1;33m'; CYN='\033[0;36m'; NC='\033[0m'

# ── Console ─────────────────────────────────────────────────────────────────────
# The installer owns tty1 and would paint over anything we wrote there, so we take
# a spare VT, switch the screen to it, and show our own progress full-screen.
CMDLINE="$(cat /proc/cmdline 2>/dev/null || true)"
cmdline_opt() {  # <key> → value, "" if absent
    grep -oE "(^| )$1=[^ ]+" <<<"$CMDLINE" | tail -n1 | cut -d= -f2-
}
VT="$(cmdline_opt dp.tty)"; [[ "$VT" =~ ^[0-9]+$ ]] || VT=3
TTY="/dev/tty${VT}"
[[ -w "$TTY" ]] || TTY="/dev/console"
exec > >(tee -a "$LOG" > "$TTY") 2>&1
chvt "$VT" 2>/dev/null || true
printf '\033[2J\033[H' 2>/dev/null || true   # clear the screen we just took over

say()  { echo -e "$*"; }
step() { echo -e "\n${CYN}▶  $*${NC}"; }
info() { echo -e "${GRN}  ✔  $*${NC}"; }
warn() { echo -e "${YEL}  ⚠  $*${NC}"; }

banner() {  # <color> <line…>
    local c="$1"; shift
    echo -e "\n${c}╔══════════════════════════════════════════════════════════════════╗${NC}"
    local l
    for l in "$@"; do printf "${c}║${NC} %-64s ${c}║${NC}\n" "$l"; done
    echo -e "${c}╚══════════════════════════════════════════════════════════════════╝${NC}\n"
}

# Terminal failure: show it and HOLD. Blocking here is what guarantees the Ubuntu
# installer behind us never resumes and never writes to the disk.
die() {
    banner "$RED" \
        "✘  FACTORY INSTALL FAILED — DO NOT SHIP THIS UNIT" \
        "" \
        "$1" \
        "" \
        "Power the unit off, set it aside, and report the message above." \
        "Full log: ${LOG}  (Ctrl+Alt+F${VT} shows this screen)"
    say "  Started ${START_TS}, failed $(date -u +%Y-%m-%dT%H:%M:%SZ)."
    chvt "$VT" 2>/dev/null || true
    sleep infinity
}

# Stand down without touching the disk.  Unlike die() this RETURNS, handing the
# machine back to the Ubuntu installer — which stops at its storage screen, where
# Ctrl+Alt+F2 gets the shell the manual restore flow needs.
bail() {
    banner "$YEL" \
        "⏸  STOPPED — nothing on this unit has been changed" \
        "" \
        "Reason: $1" \
        "" \
        "The Ubuntu installer is on Ctrl+Alt+F1. For a manual restore:" \
        "  Ctrl+Alt+F2  →  bash /cdrom/dp/dp-flash.sh"
    # Stay on this VT so the message is readable; the operator switches when ready.
    exit 0
}

banner "$CYN" \
    "DigitalPool Camera — automatic factory install" \
    "" \
    "This unit is being imaged. It will power itself off when done." \
    "Do not unplug it. Started ${START_TS}."

# ── 0. Abort window ─────────────────────────────────────────────────────────────
# Every boot of this medium installs, so give a human ten seconds to say no.
# The factory touches nothing and this simply elapses.
# Bare token, so `dp.manual` and `dp.manual=1` both count.
[[ " $CMDLINE " == *" dp.manual"* ]] && bail "dp.manual on the kernel command line"
if [[ "$TTY" == /dev/tty[0-9]* && -r "$TTY" ]]; then
    exec < "$TTY"
    say ""
    say "  ${YEL}Press any key within 10 seconds to STOP and leave this unit alone.${NC}"
    if read -r -t 10 -n 1 _key 2>/dev/null; then
        bail "a key was pressed during the 10-second abort window"
    fi
    say "  Nothing pressed — continuing."
fi

# ── 1. Flashing tools (offline, from the ISO) ───────────────────────────────────
step "Installing bundled flashing tools (offline)"
# Two passes settle any dpkg ordering; failures are tolerated because the live
# environment already ships most of these — the real check is the tool list below.
for _ in 1 2; do dpkg -i "$HERE"/tools/*.deb >/dev/null 2>&1 || true; done
MISSING=()
for t in zstd tar sfdisk sgdisk mkfs.ext4 mkfs.vfat partprobe python3 lsblk blkid blockdev wipefs; do
    command -v "$t" >/dev/null || MISSING+=("$t")
done
(( ${#MISSING[@]} == 0 )) || die "missing flashing tools: ${MISSING[*]}"
info "Tools ready"

# ── 2. The golden image ─────────────────────────────────────────────────────────
step "Locating the golden image"
IMG="$(ls -1 "$HERE"/dp-image-*.tar.zst 2>/dev/null | head -n1)"
if [[ -z "$IMG" ]]; then
    # Fallback: a stick that was assembled by hand rather than built as an ISO.
    IMG="$(ls -1 /cdrom/dp/*.tar.zst /media/*/dp/*.tar.zst /run/media/*/dp/*.tar.zst 2>/dev/null | head -n1)"
fi
[[ -n "$IMG" && -f "$IMG" ]] || die "no dp-image-*.tar.zst found on the recovery medium"
info "Image: $(basename "$IMG")  ($(du -h "$IMG" 2>/dev/null | cut -f1))"

# ── 3. Flash ────────────────────────────────────────────────────────────────────
DISK="$(cmdline_opt dp.disk)"
if [[ -n "$DISK" ]]; then
    [[ -b "$DISK" ]] || die "dp.disk=${DISK} is not a block device on this unit"
    warn "Target disk forced from the kernel command line: ${DISK}"
fi
step "Flashing (this is the long part — typically 5–15 minutes)"
# --auto: no prompts, and pick the internal disk itself when none was forced.
# dp-restore.sh verifies the result before it unmounts, so a non-zero exit here
# means the disk is NOT trustworthy.
bash "$HERE/dp-restore.sh" --auto "$IMG" ${DISK:+"$DISK"} \
    || die "dp-restore.sh failed — see the messages above"

# ── 4. Stamp the installed system with this log ─────────────────────────────────
# Gives every shipped unit an on-disk record of when and from what it was imaged,
# readable later over SSH.  Best-effort: never fail the install over bookkeeping.
step "Recording the install on the unit"
ROOT_DEV="$(grep -m1 '^ROOT_DEV=' /run/dp-restore-result 2>/dev/null | cut -d= -f2-)"
TARGET="$(grep -m1 '^TARGET=' /run/dp-restore-result 2>/dev/null | cut -d= -f2-)"
if [[ -n "$ROOT_DEV" && -b "$ROOT_DEV" ]]; then
    MNT=/run/dp-target
    mkdir -p "$MNT"
    if mount "$ROOT_DEV" "$MNT" 2>/dev/null; then
        mkdir -p "$MNT/var/lib/dp-image"
        cat > "$MNT/var/lib/dp-image/factory-install.json" <<EOF
{
  "image": "$(basename "$IMG")",
  "target_disk": "${TARGET}",
  "started": "${START_TS}",
  "finished": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "installer": "dp-factory-install.sh"
}
EOF
        cp -f "$LOG" "$MNT/var/log/dp-factory-install.log" 2>/dev/null || true
        sync
        umount "$MNT" 2>/dev/null || true
        info "Install record written to the unit"
    else
        warn "could not re-mount ${ROOT_DEV} to record the install (harmless)"
    fi
else
    warn "no restore result to record (harmless)"
fi

# ── 5. Done — power off ─────────────────────────────────────────────────────────
END="$(cmdline_opt dp.end)"
case "$END" in
    halt)   NEXT="Leave it on — the install is finished." ;;
    reboot) NEXT="Rebooting — REMOVE THE USB STICK NOW." ;;
    *)      NEXT="Powering off. Remove the USB stick, then box the unit." ;;
esac
banner "$GRN" \
    "✔  INSTALL COMPLETE — this unit is ready to ship" \
    "" \
    "Flashed: $(basename "$IMG")" \
    "Disk:    ${TARGET:-auto-selected}" \
    "" \
    "$NEXT"
say "  Started ${START_TS}, finished $(date -u +%Y-%m-%dT%H:%M:%SZ)."
chvt "$VT" 2>/dev/null || true
sync

case "$END" in
    halt)   say "  dp.end=halt — holding here." ;;
    reboot) for i in 10 9 8 7 6 5 4 3 2 1; do say "  rebooting in ${i}…  REMOVE THE USB"; sleep 1; done
            systemctl reboot 2>/dev/null || reboot -f ;;
    *)      for i in 5 4 3 2 1; do say "  powering off in ${i}…"; sleep 1; done
            systemctl poweroff 2>/dev/null || poweroff -f ;;
esac

# Power-off is asynchronous: block here so this script never returns control to
# the Ubuntu installer, which would otherwise go on to install over our work.
sleep infinity
