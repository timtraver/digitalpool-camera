#!/usr/bin/env python3
import subprocess, sys, os

REPO = os.path.dirname(os.path.abspath(__file__))
LOG  = os.path.join(REPO, "do_git_out.txt")
_log = open(LOG, "w", buffering=1)

def run(args, **kwargs):
    r = subprocess.run(args, cwd=REPO, capture_output=True, text=True, **kwargs)
    line = "$ " + " ".join(args) + "\n"
    if r.stdout.strip(): line += r.stdout.strip() + "\n"
    if r.stderr.strip(): line += r.stderr.strip() + "\n"
    line += "  rc=" + str(r.returncode) + "\n"
    _log.write(line); _log.flush()
    return r

run(['git', 'status', '--short'])
run(['git', 'log', '--oneline', '-3'])

files = ['puppeteerOverlay.js', 'server.js', 'digitalpool-camera.service']
run(['git', 'add'] + files)

msg = (
    "fix: kill Chrome process group on shutdown to prevent orphan accumulation\n\n"
    "puppeteerOverlay.js _closeBrowser():\n"
    "  Was: process.kill(pid, SIGKILL) - kills only the parent Chrome process.\n"
    "  Chrome child processes (renderer, gpu-process, zygote, utility, crashpad)\n"
    "  are separate PIDs and get reparented to init as orphans on every restart.\n"
    "  Fix: process.kill(-pid, SIGKILL) sends SIGKILL to the entire process group.\n"
    "  Chrome is always its own process group leader on Linux, so -pid == PGID.\n\n"
    "server.js _shutdownPuppeteer():\n"
    "  Add pkill -f chromium fallback after _closeBrowser() as belt-and-suspenders\n"
    "  for any processes that survived the group kill (snap isolation, etc).\n\n"
    "digitalpool-camera.service:\n"
    "  Add ExecStopPost pkill - runs after every stop/crash/restart, even if Node\n"
    "  exits before its SIGTERM handler fires. Guarantees zero Chrome orphans\n"
    "  regardless of how the service terminates."
)

r = run(['git', 'commit', '-m', msg])
if r.returncode not in (0, 1):
    sys.exit(r.returncode)

run(['git', 'log', '--oneline', '-3'])
run(['git', 'push', 'origin', 'main'])
print("DONE")
