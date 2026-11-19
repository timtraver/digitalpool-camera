#!/usr/bin/env bash
# 0029-journal-keep-evidence-wins.sh — make 0028's journald settings actually win.
#
# 0028 wrote /etc/systemd/journald.conf.d/90-dp-keep-evidence.conf, but drop-ins
# apply in lexical order and the provisioning guide's size-limit.conf sorts
# after "90-…", so its SystemMaxUse=100M and MaxRetentionSec=1week still won.
# The one-week age limit is what erased the logs of the boxes frozen for weeks.
# Rename the file so it sorts last.
#
# Idempotent.
set -euo pipefail

D=/etc/systemd/journald.conf.d
rm -f "$D/90-dp-keep-evidence.conf"
mkdir -p "$D"
cat > "$D/zz-dp-keep-evidence.conf" <<'CONF'
# Written by migrations/0028/0029 — see 0028-stop-silent-freezes.sh for why.
# Named zz- so it sorts after size-limit.conf and overrides it: bound by size
# only, never by age, so the log of a box that sat frozen for weeks survives.
[Journal]
Storage=persistent
SystemMaxUse=1G
MaxRetentionSec=0
CONF
systemctl restart systemd-journald

echo "── Effective journald limits (last value wins) ──────────────────────────"
systemd-analyze cat-config systemd/journald.conf 2>/dev/null | grep -E '^(SystemMaxUse|MaxRetentionSec)=' | tail -2 | sed 's/^/   /'
