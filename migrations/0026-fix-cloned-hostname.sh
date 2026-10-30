#!/usr/bin/env bash
# 0026-fix-cloned-hostname.sh — give a cloned unit back its own name.
#
# Units imaged before 2026-10-29 came up as their master. dp-firstboot.sh set
# the hostname only through `hostnamectl`, which talks to systemd-hostnamed over
# D-Bus and can fail that early in boot; the script is deliberately not `set -e`,
# so the failure was silent, and by the time anyone noticed, the flag was cleared
# and the service disabled. Nothing ever tried again. Those boxes are still out
# there answering to the image master's name — and two units with one name on one
# network is a mess that starts with the operator reaching the wrong camera.
#
# e43f00f fixed the script for every unit imaged after it. This repairs the ones
# already built, because they will never run firstboot again.
#
# Conservative on purpose. It renames ONLY a host whose name is dp-stream-<4 hex>
# where those four characters do not match this box's own wired MAC — that is a
# clone wearing someone else's name, and nothing else looks like it. A unit named
# by hand (dp-stream-1) or by an operator is left exactly as it is.
#
# Idempotent: on a correctly named box it decides there is nothing to do.
set -euo pipefail

APP_DIR=/home/dp/digitalpool-camera
REMOTE_JSON="${APP_DIR}/remote.json"

# ── This unit's own suffix, derived exactly as dp-firstboot.sh derives it ──────
primary_mac() {
    local iface mac
    for iface in $(ls /sys/class/net 2>/dev/null | grep -E '^(en|eth)') \
                 $(ls /sys/class/net 2>/dev/null | grep -E '^wl') \
                 $(ls /sys/class/net 2>/dev/null); do
        [[ "$iface" == "lo" ]] && continue
        [[ -e "/sys/class/net/$iface/device" ]] || continue   # skip virtual ifaces
        mac="$(cat "/sys/class/net/$iface/address" 2>/dev/null)"
        [[ -n "$mac" && "$mac" != "00:00:00:00:00:00" ]] && { echo "$mac"; return; }
    done
}

MAC="$(primary_mac)"
if [[ -z "$MAC" ]]; then
    echo "0026: no NIC MAC readable — cannot tell whose name this is. Leaving it alone."
    exit 0
fi
NOCOLON="${MAC//:/}"
SUFFIX="${NOCOLON: -4}"
WANT="dp-stream-${SUFFIX}"
CURRENT="$(cat /etc/hostname 2>/dev/null || hostname)"

if [[ "$CURRENT" == "$WANT" ]]; then
    echo "0026: hostname ${CURRENT} already matches this unit's MAC (${MAC}). Nothing to do."
    exit 0
fi

# Only a name of the generated shape is ours to correct. Anything else was
# chosen by a person, and a person's choice outranks this script.
if [[ ! "$CURRENT" =~ ^dp-stream-[0-9a-f]{4}$ ]]; then
    echo "0026: hostname ${CURRENT} was not generated from a MAC — leaving it alone."
    exit 0
fi

echo "0026: ${CURRENT} belongs to another unit — this one's MAC ${MAC} makes it ${WANT}"

# ── Rename ────────────────────────────────────────────────────────────────────
# /etc/hostname first: it is what the next boot reads, and it is the step whose
# omission caused this in the first place.
echo "${WANT}" > /etc/hostname
hostnamectl set-hostname "${WANT}" 2>/dev/null \
    || echo "0026: hostnamectl unavailable — /etc/hostname carries it over the next reboot"
# Not allowed to be fatal: under `set -e` a failure here would abort the script
# with the hostname changed and everything after it skipped — a half-renamed box
# is worse than one with a stale hosts line.
if sed -i "s/^127\.0\.1\.1.*/127.0.1.1\t${WANT}/" /etc/hosts 2>/dev/null; then
    grep -q "127.0.1.1" /etc/hosts || printf '127.0.1.1\t%s\n' "${WANT}" >> /etc/hosts
else
    echo "0026: could not rewrite /etc/hosts — the hostname itself is still set"
fi

# ── The app's own idea of its name ────────────────────────────────────────────
# remote.json's deviceName is what the app reports to DigitalPool, and on an
# unregistered unit firstboot would have seeded it from the hostname.
#
# A REGISTERED unit is not touched: its name is how venue_devices rows, table
# lookups and alert subjects find it, and renaming it here would orphan all
# three while leaving the venue none the wiser. Those are repaired by
# de-registering and registering again, which is a decision for a person.
if [[ -f "$REMOTE_JSON" ]]; then
    if grep -q '"registered"[[:space:]]*:[[:space:]]*true' "$REMOTE_JSON"; then
        echo "0026: remote.json says this unit is REGISTERED as $(grep -o '"deviceName"[^,]*' "$REMOTE_JSON")."
        echo "0026: leaving it — re-register to move it to ${WANT}."
    else
        python3 - "$REMOTE_JSON" "$WANT" <<'PY' || echo "0026: could not update remote.json — the app will fall back to the hostname"
import json, sys
path, want = sys.argv[1], sys.argv[2]
with open(path) as fh:
    cfg = json.load(fh)
if cfg.get("deviceName") != want:
    cfg["deviceName"] = want
    with open(path, "w") as fh:
        json.dump(cfg, fh, indent=2)
    print(f"0026: remote.json deviceName -> {want}")
PY
        chown dp:dp "$REMOTE_JSON" 2>/dev/null || true
    fi
fi

echo "0026: now ${WANT} (was ${CURRENT})"
