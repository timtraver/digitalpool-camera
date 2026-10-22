#!/usr/bin/env bash
# 0022-aic8800-monitor-channel.sh — let the UGREEN dongle's driver build on
# kernel 6.8.0-147 and later, so apt stops failing on every operation.
#
# The work is in migrations/helpers/aic8800-monitor-channel.sh, shared with the
# retry migration that follows this one. See the comments there for why a
# kernel-version test cannot solve this.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bash "$REPO_DIR/migrations/helpers/aic8800-monitor-channel.sh"
