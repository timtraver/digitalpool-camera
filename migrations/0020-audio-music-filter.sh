#!/usr/bin/env bash
# 0020-audio-music-filter.sh — install the background-music filter.
#
# Pool halls play music, and a stream carrying it clearly gets flagged by
# Facebook's and YouTube's content matching. audio/dp_percussive.c keeps the
# room's sudden sounds — balls, cue tips, pockets, voices — and removes what is
# sustained, which is what music is made of and what recognition matches on.
# It is the same filter the DigitalPool mobile app records with.
#
# It installs as a LADSPA plugin because that is the one plugin format both
# media stacks on this box already load: ffmpeg (`-af ladspa=`) on the USB
# camera path, and GStreamer for sources that carry their own audio.
#
# The work is in audio/install-ladspa.sh, shared with the retry migration that
# follows this one. See AUDIO.md.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bash "$REPO_DIR/audio/install-ladspa.sh"
