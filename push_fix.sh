#!/bin/bash
set -e
REPO=/Users/timtraver/Projects/digitalpool-camera
cd "$REPO"
git add gst-overlay-pipeline.py server.js streamController.js
git status --short
git commit -m "fix: vah264enc mapping, cairooverlay, fuser-k race fix"
git log --oneline -3
git push origin main
echo "PUSH_OK"
