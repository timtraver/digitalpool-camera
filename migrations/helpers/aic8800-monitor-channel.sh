#!/usr/bin/env bash
# aic8800-monitor-channel.sh — let the UGREEN dongle's driver build on
# kernel 6.8.0-147 and later. Run as root by the migrations that call it.
#
# The symptom is not a WiFi one. On dp-stream-b1b5, EVERY apt operation failed:
#
#   dpkg: error processing package linux-image-6.8.0-147-generic (--configure):
#    installed post-installation script subprocess returned error exit status 11
#   E: Sub-process /usr/bin/dpkg returned an error code (1)
#
# because the kernel's postinst runs `dkms autoinstall`, the aic8800 build
# fails, and the kernel package is left unconfigured — which then fails every
# later apt invocation, whatever it is for. (It is how migration 0020 came to
# report success while installing nothing: it believed apt's exit status.)
#
# The build failure itself:
#
#   rwnx_main.c:6240: initialization of 'int (*)(struct wiphy *,
#   struct net_device *, struct cfg80211_chan_def *)' from incompatible pointer
#   type 'int (*)(struct wiphy *, struct cfg80211_chan_def *)'
#
# cfg80211's set_monitor_channel gained a net_device argument. The driver
# already handles both forms — but it selects between them with
# `LINUX_VERSION_CODE >= KERNEL_VERSION(6, 13, 0)`, because that is where the
# change landed upstream. Ubuntu BACKPORTED it into 6.8.0-147, where
# LINUX_VERSION_CODE still reads 6.8.0, so the driver cannot see it coming and
# compiles the old signature against the new header.
#
# A version test cannot tell 6.8.0-146 from 6.8.0-147. So this asks the kernel
# headers being built against, which is the only thing that actually knows: the
# driver's Makefile greps cfg80211.h through kbuild's $(srctree) and defines
# AIC_MONITOR_CHAN_NETDEV when the net_device form is there. The three guards
# in the driver gain `|| defined(AIC_MONITOR_CHAN_NETDEV)` and nothing else
# changes — on a kernel without the backport the build is byte-for-byte what it
# was.
#
# Idempotent, and a no-op on a box that does not have this driver.
set -uo pipefail

# AIC_SRC exists so the patching can be rehearsed against a copy before it is
# let near /usr/src on a device.
SRC="${AIC_SRC:-/usr/src/aic8800-1.0}"
MAIN="$SRC/aic8800_fdrv/rwnx_main.c"
MARKER="AIC_MONITOR_CHAN_NETDEV"

if [ ! -f "$MAIN" ]; then
  echo "No aic8800 DKMS source at $SRC — nothing to do."
  exit 0
fi

# ── 1. The feature test, asked of each kernel at build time ────────────────
# This started as a DKMS PRE_BUILD script and did not work: dkms 3.0.11 runs
# that script with `exec`, so only EXPORTED variables reach it, and
# $kernel_source_dir is not exported — the script saw an empty path, found no
# header, and silently did nothing while the build failed exactly as before.
#
# kbuild's own $(srctree) is the dependable hook: inside the module Makefile it
# IS the kernel tree being built against, so the question is asked of the right
# headers every time, with nothing to export.
MAKEFILE="$SRC/aic8800_fdrv/Makefile"
if grep -q "$MARKER" "$MAKEFILE" 2>/dev/null; then
  echo "Makefile already carries the feature test."
else
  cat >> "$MAKEFILE" <<'EOF'

# Does this kernel's cfg80211 pass a net_device to set_monitor_channel?
# Ubuntu backported that change into 6.8.0-147, where LINUX_VERSION_CODE still
# reads 6.8.0 and the driver's own version test cannot see it — so ask the
# headers instead. Verified to answer 0 on 6.8.0-146 and 1 on 6.8.0-147.
ifneq ($(shell grep -A2 '(\*set_monitor_channel)' $(srctree)/include/net/cfg80211.h 2>/dev/null | tr -d ' \t\r\n' | grep -c 'structnet_device\*'),0)
EXTRA_CFLAGS += -DAIC_MONITOR_CHAN_NETDEV
endif
EOF
  echo "Added the feature test to the driver Makefile."
fi

# Clean up the PRE_BUILD attempt, on a box that ran the first version of this.
if grep -q "^PRE_BUILD=\"dkms-detect-monitor-chan.sh\"" "$SRC/dkms.conf" 2>/dev/null; then
  sed -i '/^PRE_BUILD="dkms-detect-monitor-chan.sh"$/d' "$SRC/dkms.conf"
  rm -f "$SRC/dkms-detect-monitor-chan.sh"
  echo "Removed the PRE_BUILD step that could not see the kernel path."
fi

# ── 2. Let the driver's own guards honour it ────────────────────────────────
# Only the three guards around set_monitor_channel: the fourth 6.13 guard in
# this file is for MODULE_IMPORT_NS, a different change that Ubuntu did not
# backport, and flipping it would break a build that works today.
if grep -q "$MARKER" "$MAIN"; then
  echo "Driver source already carries the feature test."
else
  cp -a "$MAIN" "$MAIN.pre-0022"
  # This source has CRLF line endings — the carriage return is carried through
  # untouched rather than quietly rewriting 9,000 lines of someone else's
  # driver, and the guard match allows for it.
  awk -v marker="$MARKER" '
    {
      line = $0
      ending = ""
      if (line ~ /\r$/) { ending = "\r"; sub(/\r$/, "", line) }
      lines[NR] = line
      endings[NR] = ending
    }
    END {
      patched = 0
      for (i = 1; i <= NR; i++) {
        if (lines[i] ~ /^#if \(LINUX_VERSION_CODE >= KERNEL_VERSION\(6, *13, *0\)\)$/ &&
            (lines[i+1] ~ /set_monitor_channel/ || lines[i+2] ~ /set_monitor_channel/)) {
          print lines[i] " || defined(" marker ")" endings[i]
          patched++
        } else {
          print lines[i] endings[i]
        }
      }
      printf("aic8800: patched %d guard(s)\n", patched) > "/dev/stderr"
    }
  ' "$MAIN.pre-0022" > "$MAIN.new" && mv "$MAIN.new" "$MAIN"
  if ! grep -q "$MARKER" "$MAIN"; then
    echo "⚠️  Could not patch $MAIN — this driver revision looks different."
    echo "   Restoring the original and leaving the kernel build as it was."
    mv "$MAIN.pre-0022" "$MAIN"
    exit 0
  fi
fi

# ── 3. Build it for every installed kernel that is missing it ───────────────
status_for() { dkms status -m aic8800 -v 1.0 -k "$1" 2>/dev/null; }

running="$(uname -r)"
for kdir in /lib/modules/*/build; do
  kver="$(basename "$(dirname "$kdir")")"
  [ -e "$kdir" ] || continue                     # headers not installed for it
  # Only the kernel in use and anything newer. Older ones are what you boot to
  # get OUT of trouble; rebuilding the driver for them is not what fixes apt,
  # and a failure there would be noise on top of the real answer.
  [ "$kver" = "$running" ] || \
    [ "$(printf '%s\n%s\n' "$running" "$kver" | sort -V | tail -1)" = "$kver" ] || continue
  case "$(status_for "$kver")" in
    *installed*) echo "aic8800 already installed for $kver"; continue ;;
  esac
  echo "Building aic8800 for $kver …"
  dkms build -m aic8800 -v 1.0 -k "$kver" >/dev/null 2>&1 || {
    echo "⚠️  Build failed for $kver — see /var/lib/dkms/aic8800/1.0/build/make.log"
    continue
  }
  dkms install -m aic8800 -v 1.0 -k "$kver" --force >/dev/null 2>&1 \
    && echo "   installed for $kver" \
    || echo "⚠️  Install failed for $kver"
done

# ── 4. Clear the packages the failed builds left half-configured ────────────
if dpkg --audit 2>/dev/null | grep -q .; then
  echo "Configuring packages left pending by the earlier failures …"
  dpkg --configure -a || true
fi

# ── 5. Say plainly whether apt is healthy now ───────────────────────────────
echo "── Final state ──────────────────────────────────────────────────────────"
dkms status -m aic8800 2>/dev/null | sed 's/^/   /'
if dpkg --audit 2>/dev/null | grep -q .; then
  echo "⚠️  Packages are STILL not fully configured:"
  dpkg --audit | sed 's/^/   /'
  echo "   apt will keep returning non-zero on this box."
else
  echo "✅ dpkg has nothing pending — apt is healthy again."
fi
