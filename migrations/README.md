# Host-config migrations

Ordered, run-once shell scripts that apply **system-level** changes (packages,
systemd units, `/etc` files, sudoers, kernel settings) to each device — the
things `git pull` alone can't do because the app runs as the unprivileged `dp`
user.

## How it works

- Scripts here are named `NNNN-slug.sh` (e.g. `0001-avahi-daemon.sh`) and run in
  numeric order.
- `../run-migrations.sh` runs the **pending** ones as **root**, recording each
  success in `/var/lib/digitalpool-camera/applied-migrations.txt` (outside the
  repo, so `git reset --hard` never resets it).
- They run automatically:
  - **at boot** — `digitalpool-migrations.service` (a root oneshot ordered
    `Before=digitalpool-camera.service`), and
  - **on update** — `/api/update` triggers the same service right after
    `git reset --hard`, then restarts the app.
- A failed migration is **not** recorded, so it retries on the next run, and the
  runner **stops** at the first failure (later migrations may depend on it).

## Writing a migration

1. Create the next-numbered file: `migrations/0002-my-change.sh`.
2. Make it **idempotent** — it may run again if the state file is lost, and
   idempotency is your safety net. Prefer commands that are naturally safe to
   repeat: `apt-get install -y`, `systemctl enable`, writing a file with `cat >`,
   `mkdir -p`, `grep -q ... || echo >>`.
3. Start with `set -euo pipefail` so any failed step aborts (and isn't recorded).
4. **Never edit a migration once it's been released** to any device — the state
   file keys on the filename, so an edited file won't re-run. Add a new one.

Example:

```bash
#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get install -y some-package
systemctl enable --now some-service
```

## First-time setup

The runner and these scripts arrive via git, but the systemd unit + sudoers rule
must be installed once by hand (chicken-and-egg). Run `../install-migrations.sh`
as root on the device. After that, everything self-applies. See the README's
"Host-config migrations" section.

## Inspecting

```bash
cat /var/lib/digitalpool-camera/applied-migrations.txt   # what's applied
tail -n 50 /var/log/digitalpool-migrations.log           # run history
sudo systemctl start digitalpool-migrations.service      # run pending now
```
