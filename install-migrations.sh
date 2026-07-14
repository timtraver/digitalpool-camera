#!/usr/bin/env bash
# install-migrations.sh — one-time bootstrap for the host-config migration system.
#
# The migration runner (run-migrations.sh) and the migration scripts arrive via
# git, but the systemd unit + sudoers rule that let them run automatically must
# be installed once by hand (chicken-and-egg).  Run this ONCE per device as root:
#
#     sudo ./install-migrations.sh
#
# After this, pending migrations self-apply at every boot and on every
# /api/update.  Re-running this script is safe (idempotent).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo $0" >&2
  exit 1
fi

echo "==> Installing digitalpool-migrations.service"
install -m 0644 "$REPO_DIR/digitalpool-migrations.service" \
  /etc/systemd/system/digitalpool-migrations.service

echo "==> Updating digitalpool-camera.service (adds the migrations dependency)"
install -m 0644 "$REPO_DIR/digitalpool-camera.service" \
  /etc/systemd/system/digitalpool-camera.service

echo "==> Installing sudoers rule (dp may trigger the migration service)"
cat > /etc/sudoers.d/digitalpool-migrations <<'SUDO'
dp ALL=(ALL) NOPASSWD: /usr/bin/systemctl start digitalpool-migrations.service
SUDO
chmod 0440 /etc/sudoers.d/digitalpool-migrations
visudo -c -f /etc/sudoers.d/digitalpool-migrations

echo "==> Making run-migrations.sh executable"
chmod +x "$REPO_DIR/run-migrations.sh"

echo "==> Enabling services"
systemctl daemon-reload
systemctl enable digitalpool-migrations.service

echo "==> Running any pending migrations now"
"$REPO_DIR/run-migrations.sh" || {
  echo "!! Migrations reported an error — see /var/log/digitalpool-migrations.log" >&2
}

echo
echo "Bootstrap complete."
echo "  - Migrations run at boot (before the app) and on every /api/update."
echo "  - Applied list: /var/lib/digitalpool-camera/applied-migrations.txt"
echo "  - Log:          /var/log/digitalpool-migrations.log"
echo
echo "You may want to restart the app service to pick up the updated unit:"
echo "  sudo systemctl restart digitalpool-camera"
