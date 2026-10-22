#!/usr/bin/env bash
# 0023-aic8800-monitor-channel-retry.sh — fix the aic8800 build, properly.
#
# 0022 patched the driver's version guards correctly but fed the feature test
# in through a DKMS PRE_BUILD script, which dkms 3.0.11 runs with `exec` —
# so only exported variables reach it, and $kernel_source_dir is not one. The
# script saw an empty path, did nothing, and the build failed exactly as
# before, on a box where it had just reported itself applied.
#
# The detection now lives in the driver's Makefile, where kbuild's $(srctree)
# points at the right kernel tree by construction. Migrations never re-run, so
# the corrected version needs its own number; it is idempotent, so on a box
# where 0022 happened to be enough this changes nothing.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bash "$REPO_DIR/migrations/helpers/aic8800-monitor-channel.sh"
