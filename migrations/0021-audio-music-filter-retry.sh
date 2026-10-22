#!/usr/bin/env bash
# 0021-audio-music-filter-retry.sh — install the music filter, again.
#
# 0020 could report success without having installed anything. It treated a
# non-zero `apt-get install ladspa-sdk` as fatal, and a box with an unrelated
# package in a broken state — on dp-stream-b1b5 a DKMS module that no longer
# builds against the running kernel — fails every apt-get install regardless of
# whether the requested package went in. It did go in; the migration gave up
# anyway, recorded itself as applied, and left the box unfiltered.
#
# Migrations are keyed on filename and never re-run, so the fix needs its own
# number. The install itself is idempotent, so on a box where 0020 worked this
# simply installs the same file over itself.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bash "$REPO_DIR/audio/install-ladspa.sh"
