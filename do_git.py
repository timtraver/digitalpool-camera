#!/usr/bin/env python3
import subprocess, sys, os

REPO = os.path.dirname(os.path.abspath(__file__))

def run(args, **kwargs):
    r = subprocess.run(args, cwd=REPO, capture_output=True, text=True, **kwargs)
    print(f"$ {' '.join(args)}")
    if r.stdout.strip():
        print(r.stdout.strip())
    if r.stderr.strip():
        print(r.stderr.strip())
    print(f"  -> rc={r.returncode}")
    return r

run(['git', 'status', '--short'])
run(['git', 'log', '--oneline', '-3'])

files = ['gst-overlay-pipeline.py', 'server.js', 'streamController.js']
run(['git', 'add'] + files)

msg = (
    "fix: vah264enc/vah265enc mapping + cairooverlay + race fixes\n\n"
    "1. gst-overlay-pipeline.py: add vah264enc to H.264 encoder branch\n"
    "   Without this, config 'vah264enc' fell through to software x264enc,\n"
    "   causing 200%+ CPU per camera on Intel N97.\n"
    "2. gst-overlay-pipeline.py: add vah264enc->vah265enc for H.265 branch.\n"
    "3. gst-overlay-pipeline.py: replace gdkpixbufoverlay with cairooverlay.\n"
    "   Ubuntu 24.04 gdkpixbufoverlay uses glycin/bwrap which requires D-Bus\n"
    "   and fails in systemd service. cairooverlay + pycairo draws the PNG\n"
    "   directly without any sandbox.\n"
    "4. server.js: fuser -k device before stream start; isRestartInProgress\n"
    "   guard in post-backoff idle preview restart to close spawn race."
)

r = run(['git', 'commit', '-m', msg])
if r.returncode not in (0, 1):
    sys.exit(r.returncode)

run(['git', 'log', '--oneline', '-3'])
run(['git', 'push', 'origin', 'main'])
print("DONE")
