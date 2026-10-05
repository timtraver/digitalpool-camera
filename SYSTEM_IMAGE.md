# System Image — clone a device from the UI

Download a complete image of a running DigitalPool Camera device from the admin
UI, bake it into a USB stick that **images a new unit with nobody at the keyboard**,
and have that unit turn itself into a unique unit on first boot.

That unattended path is what the OEM factory is shipped — see
[FACTORY_INSTALL.md](FACTORY_INSTALL.md), which is written for them and is the
document to hand over. The same stick still carries the manual restore flow for
field recovery.

This is a **filesystem-level** clone (files, not raw blocks), so the source can
stay live and the image is only as big as the *used* data. Every filesystem UUID
is preserved on restore, so `fstab` / GRUB / extlinux keep working untouched.

```
┌─ source device (running) ─────┐   ┌─ install USB ────────────┐   ┌─ new unit ───────────┐
│ UI ▸ Admin ▸ System Image     │   │ boot menu, 15s countdown │   │ first boot:          │
│   → dp-create-image.sh        │──▶│   → dp-factory-install.sh│──▶│  dp-firstboot.sh     │
│   → .tar.zst image            │   │      picks the disk      │   │  new machine-id/ssh/ │
│   → 🏗 dp-build-recovery-iso  │   │   → dp-restore.sh --auto │   │  hostname, wiped     │
│      image + scripts + seed   │iso│      partition, mkfs -U, │   │  netbird+app state,  │
│      + boot menu → one .iso   │   │      extract, bootloader,│   │  then reboots once    │
│                               │   │      verify, arm firstboot│  │                      │
│                               │   │   → POWERS THE UNIT OFF  │   │                      │
└───────────────────────────────┘   └──────────────────────────┘   └──────────────────────┘
                                      (or: manual restore shell → dp-flash.sh)
```

## Hard constraints

- **Architecture must match.** An `x86_64` image (Intel N97 / N100) will **not**
  boot an `aarch64` device (RK3588) and vice-versa. `dp-restore.sh` refuses a
  mismatch. Keep one image + one USB per platform. N97 and N100 are both x86_64,
  so one ISO serves both.
- **Target disk ≥ source disk.** The partition table is replicated, so the target
  must be the same size or larger. Larger disks get the root partition grown to
  fill the extra space automatically.
- **No LUKS / full-disk encryption.** GPT is assumed. Both a plain ext4-on-partition
  root and Ubuntu Server's default **LVM** root (ext4 LV in `ubuntu-vg` on a PV
  partition, with a separate `/boot` and vfat ESP) are supported — the restore
  rebuilds the PV→VG→LV stack and preserves the LV's filesystem UUID.

## Parts (all live at the repo root, deployed to `/home/dp/digitalpool-camera`)

| File | Runs where | Does |
|------|-----------|------|
| `dp-create-image.sh` | source device (via UI) | quiesce + tar rootfs, capture bootgap/partition-table/UUIDs, stream `.tar.zst` to stdout |
| `dp-restore.sh` | recovery USB | partition target, `mkfs -U` (preserve UUIDs), extract, fix bootloader, verify, arm first boot |
| `dp-factory-install.sh` | recovery USB, unattended | picks the disk, runs the restore, stamps the unit, powers it off — never returns |
| `dp-build-recovery-iso.sh` | source device (via UI) | bakes image + scripts + autoinstall seed + boot menu into one bootable `.iso` |
| `dp-firstboot.sh` + `dp-firstboot.service` | new device, first boot | sanitise clone → unique unit, then self-disable |

## 1. Enable the capture endpoint (one-time, on each source device)

The Node service runs as `dp` and shells out with `sudo`. Add a NOPASSWD entry so
it can run the capture script and clean up an aborted capture. Create
`/etc/sudoers.d/digitalpool-image` (mode 0440, validate with `visudo -c`):

```sudoers
dp ALL=(root) NOPASSWD: /usr/bin/bash /home/dp/digitalpool-camera/dp-create-image.sh *
dp ALL=(root) NOPASSWD: /usr/bin/pkill -f dp-create-image.sh
```

Install the capture prerequisites (present on most installs already):

```bash
sudo apt install -y zstd util-linux   # zstd, sfdisk, blockdev, findmnt, lsblk, blkid
```

Only the **dpadmin** user sees the "💾 System Image" section (Admin Settings). The
flow is **capture-to-file, then download** (not a live stream — that proved fragile
for a multi-GB file):

1. **Create Image** — stops any active stream, `sync`s, and captures
   `dp-image-<host>-<arch>-<timestamp>.tar.zst` to **`/home/dp/system-images/`** on
   the device. The button shows live progress (bytes written); the capture runs on
   the device, so you can leave the page.
2. **Saved images** list — each finished image has a **⬇︎ download** and **🗑 delete**.
   The download is a normal static file, so it has a real size/progress bar and is
   **resumable** if the connection drops.

> The images directory is **excluded from the capture** (see the `--exclude` in
> `dp-create-image.sh`) so old images are never tarred into a new one. Delete images
> you no longer need — each is 8–15 GB.

**Downloading:** use a **laptop/desktop** browser (not a tablet) at
`http://192.168.50.1:3000` — *not* the "sign in to WiFi" captive-portal popup. Over
plain HTTP, Chrome may still show "insecure download blocked" for a file this size;
if so, use **Firefox**, which downloads from the HTTP origin without complaint. The
resumable static download is far more reliable than the old live stream either way.

## 2. Build an all-in-one bootable ISO (recommended)

Bake everything into **one bootable `.iso`** — the Ubuntu live environment, your
image, the restore scripts, and the flashing tools as offline `.deb`s — so the
target needs **no network** and there is nothing else to copy.

**The ISO installs itself — from any boot entry.** Boot it, touch nothing, and the
unit images its internal disk and powers off. That removes the step where a person
had to intercept the Ubuntu installer and run a script by hand.

How it works, in order of what actually carries the install:

1. **`/autoinstall.yaml` at the root of the ISO.** subiquity looks for autoinstall
   config in four places and the root of the installation medium is one of them, so
   this is found **whichever entry boots, with nothing on the kernel command line**.
   Its `early-commands` runs `dp-factory-install.sh`, which subiquity executes
   *before it probes or touches any block device*, and that script never returns
   (it powers the unit off) — so the Ubuntu install that would otherwise follow
   never happens.
2. **The boot menu** adds a labelled `AUTOMATIC INSTALL` default with a 15-second
   countdown, a `manual restore shell` entry (which passes `dp.manual`), and the
   `dp.*` overrides below. This part is a convenience: if the replaced `grub.cfg`
   is not the config the firmware reads — which is what happened on the first
   factory ISO, where the menu came up stock — the install still runs unattended
   from (1), just on Ubuntu's own 30-second timeout. The builder reads the file
   back out of the finished ISO and says which of the two you got.

Progress is shown on **VT 8**, not on the installer's tty1. Deliberately above
VT 6: logind auto-starts a getty on any VT in `1..NAutoVTs` as soon as that VT
becomes active, and on the first run that painted `ubuntu login:` over the
progress mid-flash — the imaging carried on underneath, but there was no way to
tell from the screen, and the getty was eating the keystrokes meant for the abort
window. The script also masks the getty unit for its VT and re-asserts the console
every 5s while it works, because subiquity pulls the console back to tty1 when its
UI starts.

Two backstops, because every boot of this medium erases a disk:

- A **10-second abort window** at the start of `dp-factory-install.sh`: press any
  key and it stands down without touching the disk, handing the machine to the
  Ubuntu installer (Ctrl+Alt+F2 for the manual flow). `dp.manual` skips the wait.
  The factory simply lets it elapse.
- The autoinstall config marks `storage` as an **interactive section**: if the
  flasher ever did return, the installer stops at a screen waiting for a human
  instead of installing Ubuntu over the fresh clone.

Kernel command-line overrides, if a unit needs one (press `e` on the menu entry):

| Option | Effect |
|--------|--------|
| `dp.manual` | don't install; hand the machine straight to the Ubuntu installer |
| `dp.disk=/dev/nvme0n1` | flash this disk instead of auto-selecting |
| `dp.end=reboot` / `dp.end=halt` | reboot, or stay powered on, instead of powering off |
| `dp.tty=4` | show progress on a different virtual console |

**From the UI (recommended):** in the image list, click **🏗** on a captured image.
The server auto-downloads & caches the Ubuntu base ISO the first time, builds the
ISO as a background job (live progress), and drops it in the list to download. The
**only** one-time prerequisite is `xorriso` (it needs root, so it's not
auto-installed):
```bash
sudo apt install -y xorriso     # once, on the device
```

**Or from the CLI** on the **camera device** (x86_64 image → amd64 Ubuntu ISO). Use
the **live-server** ISO (~2.6 GB) — the flash flow is command-line only, so no
desktop is needed and the output stays small:

```bash
sudo apt install -y xorriso
# download Ubuntu Server (live-server) 24.04 amd64 ISO onto the device (e.g. into ~/):
#   wget https://releases.ubuntu.com/24.04/ubuntu-24.04.2-live-server-amd64.iso
bash ~/digitalpool-camera/dp-build-recovery-iso.sh \
     ~/ubuntu-24.04.2-live-server-amd64.iso \
     /home/dp/system-images/dp-image-<host>-x86_64-<ts>.tar.zst
# → writes /home/dp/system-images/dp-recovery-<ts>.iso  (~7 GB)
```

The ISO lands in `system-images/`, so it appears in the UI's image list — download
it to your Mac with **Firefox** (resumable), then **balenaEtcher** that one `.iso`
to an **16 GB+** USB stick. Boot the target and leave it alone. Rebuild the ISO
whenever you make a new golden image.

> **Automatic entry is x86_64 only.** It rewrites the ISO's GRUB menu, which has no
> equivalent on RK3588; an aarch64 build still produces a working *manual* recovery
> medium (and says so while building). N97 and N100 are both x86_64 — one ISO
> covers both.
>
> **Notes.** Building needs internet on the device (to fetch the tool `.debs`) and
> ~7 GB free. `dp-flash.sh` `dpkg -i`s only leaf tool packages (`gdisk`, `lvm2`,
> `dosfstools`, `cloud-guest-utils`, `zstd`, `parted`) — their libraries are already
> in the Ubuntu Server live env (the installer itself uses them), so core libs are
> never touched.

### Before handing an ISO to the factory

Flash it and run **one** unit end to end (§"Caveats / validation"). The failure
mode to watch for is the unit sitting in the ordinary Ubuntu installer asking for
a language or a username instead of flashing: that means the autoinstall config
was not picked up at all, and nothing will have been erased. A *stock-looking boot
menu* on its own is not that failure — check the builder's verification lines, and
see whether the install starts by itself after Ubuntu's own 30-second timeout.

### Alternative: plain boot stick + separate image drive

If you'd rather not rebuild a 10 GB ISO each time, use any bootable Ubuntu USB
(balenaEtcher an ISO) plus a separate **exFAT** drive holding the image +
`dp-restore.sh`, and install tools in the live session (needs network):

```bash
sudo apt install -y zstd gdisk cloud-guest-utils dosfstools util-linux python3 lvm2
```

> **LVM caveat:** the restore recreates the VG by its original name (e.g.
> `ubuntu-vg`). A "Try Ubuntu" live session runs from the ISO (not LVM), so there is
> no name clash. Don't run `dp-restore.sh` from an environment that already has an
> active VG of the same name.
>
> **aarch64 (RK3588):** there's no x86-style live ISO — boot from any removable
> aarch64 Linux (SD/USB, *not* the target disk). u-boot/idbloader ride in the image's
> "bootgap" and are written back automatically, so the recovery env needs nothing
> board-specific.

## 3. Flash the new device

With the ISO from §2 this happens by itself — this section is the manual path
(`manual restore shell` in the boot menu, then Ctrl+Alt+F2).

```bash
sudo bash dp-restore.sh /path/to/dp-image-<host>-<arch>-<ts>.tar.zst
# (omit the disk to be shown a menu, or pass it explicitly:)
sudo bash dp-restore.sh dp-image-....tar.zst /dev/nvme0n1
# unattended (what dp-factory-install.sh runs):
sudo bash dp-restore.sh --auto dp-image-....tar.zst
```

It validates arch + disk size, requires you to type **ERASE**, then partitions,
formats (preserving UUIDs), extracts, installs the bootloader fallback (x86),
**verifies the result**, and arms the first-boot sanitiser. On success: power off,
remove the recovery media.

| Flag | Effect |
|------|--------|
| `--yes` | skip the typed `ERASE` confirmation |
| `--auto` | `--yes`, plus choose the target disk automatically |

`--auto` only ever picks a disk it is sure of: removable, read-only, USB-attached,
already-mounted and too-small disks are excluded, as are the disk holding the image
and the booted recovery medium. Of what's left it prefers NVMe over SATA over eMMC,
and if two equally good candidates remain it **refuses to guess** and fails rather
than erase a coin-flip. The verification step (init, fstab, kernel, the app, and
the EFI fallback loader all present) matters most here: unattended flashing has
nobody reading the scrollback, so a bad restore has to fail loudly rather than at
the customer's first power-on.

## 4. First boot of the new device

`dp-firstboot.service` runs once (guarded by `/var/lib/dp-image/firstboot-pending`):
new `machine-id`, fresh SSH host keys, hostname `dp-stream-<last 4 of the primary NIC MAC>`, wiped NetBird
identity, cleared app state, regenerated `SESSION_SECRET`, Ethernet → DHCP. It
then disables itself and reboots into the finished unit. Log: `/var/log/dp-firstboot.log`.

Then: connect to the unit's hotspot — the SSID is per-unit, **DigitalPool-XXXX**,
where XXXX matches the hostname suffix (`dp-stream-b1b5` → `DigitalPool-B1B5`) —
then `http://192.168.50.1:3000`,
log in (`admin` / `Digitalpool`, forced password change), rename the device, and
register it under Remote Access.

## What the clone resets vs. keeps

**Reset per unit** (see `dp-firstboot.sh`): machine-id, SSH host keys, hostname,
NetBird peer, `SESSION_SECRET`, and all app state (`users.json`,
`camera-config*`, `stream-config*`, `remote.json`, `banned-ips.json`, …), Ethernet
back to DHCP.

**Kept from the golden image:** the OS, all installed packages, the app code,
`.env` (including NetBird management URL / setup key — these are org-level; if you
consider them per-deployment secrets, rotate them after cloning), MediaMTX config,
the WiFi AP profile, and the systemd hardening.

## Caveats / validation

- **Live capture is quiesced, not crash-consistent.** Streams are stopped and the
  filesystem is `sync`ed before tar; tar tolerates the still-running OS with
  `--warning=no-file-changed`. Good enough for an appliance; it is not an LVM/btrfs
  snapshot.
- **Excluded from the image:** `/proc /sys /dev /run /tmp` (pseudo), swap file,
  journald logs, apt `.deb` cache, GStreamer/Chromium caches. Swap is recreated by
  the OS; its absence is non-fatal at boot.
- **Not yet validated end-to-end on hardware.** Before trusting it in the field,
  do one full dry run per architecture:
  1. Capture from a known-good device; confirm the download completes and
     `zstd -dc img | tar -tf - var/lib/dp-image/manifest.json` lists the manifest.
  2. Restore to a spare disk; confirm it boots, `dp-firstboot` runs (check
     `/var/log/dp-firstboot.log`), hostname/machine-id changed, UI reachable.
  3. Confirm streaming works on the clone.
- **The unattended path has not been run on hardware either, and it is the one
  that goes to an OEM who cannot debug it.** Flash the ISO to a stick and image one
  spare unit with nobody touching it, start to finish, before the stick ships:
  1. Boot it and don't press anything — the 15s countdown should start the
     automatic entry, and progress should appear on screen (Ctrl+Alt+F8).
  2. It should end on the green `INSTALL COMPLETE` screen and power off by itself.
  3. Boot that unit and confirm `/var/lib/dp-image/factory-install.json` and
     `/var/log/dp-factory-install.log` are on it — that is the install record
     every shipped unit carries.
  4. Check the *manual* entry still works too, since field recovery depends on it.

  The first ISO built this way did hit the failure worth rehearsing: it booted a
  **stock GRUB menu**, so nothing we put on the kernel command line reached
  subiquity and the unit sat in the interactive installer. Nothing was erased. The
  fix was to stop depending on the boot menu at all — `/autoinstall.yaml` at the
  ISO root is found whichever entry boots — and to have the builder read both files
  back out of the finished ISO and report which mechanism you actually got.
