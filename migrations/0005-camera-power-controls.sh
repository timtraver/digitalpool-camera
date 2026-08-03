#!/usr/bin/env bash
# 0005-camera-power-controls.sh — grant the `dp` user the two NOPASSWD sudo rules
# the app needs for the new power/maintenance features:
#   1. usb-reset.sh     — targeted USB reset of a single camera (unbind/rebind one bus port)
#   2. wake-shutdown.sh — timed shutdown that arms the RTC wake alarm (Intel/x86 only)
#
# Both scripts run IN PLACE from the repo (like dp-create-image.sh), so no files
# are copied to /usr/local — the only host state is this sudoers rule. Idempotent:
# re-running is a no-op when the rule is already current.
set -euo pipefail

SUDOERS=/etc/sudoers.d/digitalpool-camera-power
TMP="$(mktemp)"

cat > "$TMP" <<'SUDO'
# Installed by migrations/0005-camera-power-controls.sh — do not edit by hand.
# Targeted USB reset of a single camera (unbind/rebind one USB bus port).
dp ALL=(root) NOPASSWD: /usr/bin/bash /home/dp/digitalpool-camera/usb-reset.sh *
# Timed shutdown: arm the RTC wake alarm, then power off (Intel/x86 boards).
dp ALL=(root) NOPASSWD: /usr/bin/bash /home/dp/digitalpool-camera/wake-shutdown.sh *
SUDO

chmod 0440 "$TMP"

# Validate the syntax on the temp file BEFORE installing, so a malformed rule can
# never land in /etc/sudoers.d and lock the whole box out of sudo.
visudo -c -f "$TMP"

# Copy-if-changed: skip the write (and its churn/log noise) when already current.
if [ -f "$SUDOERS" ] && cmp -s "$TMP" "$SUDOERS"; then
  echo "OK    $SUDOERS already up to date"
  rm -f "$TMP"
else
  install -m 0440 "$TMP" "$SUDOERS"
  rm -f "$TMP"
  echo "COPY  installed $SUDOERS"
fi

# rtcwake ships with util-linux (present on every Ubuntu base), but flag it if not.
command -v rtcwake >/dev/null 2>&1 || echo "WARN  rtcwake not found — timed wake will be unavailable" >&2

echo "0005-camera-power-controls complete."
