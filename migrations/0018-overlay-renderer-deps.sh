#!/usr/bin/env bash
# 0018-overlay-renderer-deps.sh — install the native canvas the local overlay
# renderer needs.
#
# overlayRenderer.js draws the venue's overlay on the device with Skia instead of
# screenshotting it out of headless Chromium. That needs @napi-rs/canvas, a
# native module, and `/api/update` only does `git fetch` + `git reset --hard` —
# it never runs npm. Without this the new code lands but the module is missing,
# registerFonts() throws, and overlayProducer quietly demotes that camera back to
# the browser. Safe, but the box would gain nothing and the reason would only be
# visible in the journal.
#
# Prebuilt binaries exist for linux-x64-gnu (N97/N100) and linux-arm64-gnu
# (RK3588), so there is no compiler step. It is declared in optionalDependencies
# precisely so that a box which cannot install it still runs — the browser engine
# stays in use there.
#
# Idempotent: npm install reconciles node_modules against the committed
# package-lock.json and is safe to repeat; the check below short-circuits the
# common case where nothing has changed.
set -euo pipefail

APP_DIR="/home/dp/digitalpool-camera"
as_dp() { sudo -n -u dp env HOME=/home/dp "$@"; }

cd "$APP_DIR"

if as_dp node -e 'require("@napi-rs/canvas")' >/dev/null 2>&1; then
  echo "✅ @napi-rs/canvas already loadable — nothing to install"
else
  echo "📦 Installing overlay renderer dependencies (npm install)…"
  # Run as dp: node_modules is owned by dp and root-owned files here would break
  # every later install and the app's own writes.
  as_dp npm install --no-audit --no-fund
fi

# Verify rather than assume. A module that installs but will not load is the
# failure this migration exists to prevent.
if as_dp node -e 'const c=require("@napi-rs/canvas"); c.createCanvas(8,8).getContext("2d"); console.log("   version", require("@napi-rs/canvas/package.json").version)'; then
  echo "✅ native canvas loads and can create a context"
else
  echo "❌ @napi-rs/canvas is not usable on this box"
  echo "   The app still runs — overlayProducer falls back to the browser engine."
  exit 1
fi

# The renderer reads its font bundle from the repo, so this arrives with the
# update itself; check it landed rather than discovering it at render time.
FONT_DIR="$APP_DIR/assets/fonts"
COUNT=$(ls -1 "$FONT_DIR" 2>/dev/null | wc -l)
if [ "$COUNT" -gt 0 ]; then
  echo "✅ font bundle present ($COUNT faces in assets/fonts)"
else
  echo "❌ assets/fonts is empty — overlays would fall back to whatever fontconfig finds"
  exit 1
fi

# ── Switch this box to the local renderer ────────────────────────────────────
# OVERLAY_ENGINE=local means the browser is never loaded at all: no Chromium
# process, and no fallback either. An overlay the local renderer cannot draw
# renders BLANK rather than quietly reverting to a screenshot. That is the
# intended configuration for this fleet, but it makes the check below matter —
# a camera that would go blank has to be visible in this log, which /api/update
# shows in the admin panel, not discovered on a live stream.
ENV_FILE="$APP_DIR/.env"

check_cam() {   # $1 = config file, $2 = label
  local cfg="$APP_DIR/$1" label="$2"
  [ -f "$cfg" ] || { echo "   $label: no config yet — nothing to check"; return 0; }
  as_dp node -e '
    const fs = require("fs");
    const Skia = require("/home/dp/digitalpool-camera/skiaOverlay.js");
    const cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const label = process.argv[2];
    const url = (cfg.overlayUrl || "").trim();
    const on  = cfg.overlayEnabled !== false && (cfg.remoteOverlayEnabled || url);
    if (!on)                      console.log(`   ${label}: no overlay configured — unaffected`);
    else if (!url)                console.log(`   ${label}: WOULD GO BLANK — overlay is on but has no DigitalPool URL (built-in scoreboard mode is browser-only)`);
    else if (Skia.canHandle(url)) console.log(`   ${label}: OK — ${url}`);
    else                          console.log(`   ${label}: WOULD GO BLANK — not renderable locally: ${url}`);
  ' "$cfg" "$label"
}

echo "🔍 Checking what each camera's overlay would do under OVERLAY_ENGINE=local:"
check_cam stream-config.json   "camera 1"
check_cam stream-config-2.json "camera 2"

BLANK=$( { check_cam stream-config.json "camera 1"; check_cam stream-config-2.json "camera 2"; } | grep -c "WOULD GO BLANK" || true )
if [ "$BLANK" -gt 0 ]; then
  echo "⚠️  $BLANK camera(s) above would have NO overlay under OVERLAY_ENGINE=local."
  echo "⚠️  Set OVERLAY_ENGINE=auto in $ENV_FILE instead to keep the browser as a fallback."
fi

# Idempotent, and never overrides a value already chosen on this box.
if grep -q "^OVERLAY_ENGINE=" "$ENV_FILE" 2>/dev/null; then
  echo "✅ OVERLAY_ENGINE already set: $(grep "^OVERLAY_ENGINE=" "$ENV_FILE")"
else
  printf "\n# Draw overlays on-device with Skia; no browser is loaded at all.\n# Use 'auto' to fall back to Chromium for overlays it cannot draw.\nOVERLAY_ENGINE=local\n" >> "$ENV_FILE"
  chown dp:dp "$ENV_FILE"
  echo "✅ OVERLAY_ENGINE=local added to .env (takes effect on the restart that follows this update)"
fi
