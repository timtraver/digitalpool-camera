# System Image — clone a device from the UI

Download a complete image of a running DigitalPool Camera device from the admin
UI, flash it onto a new device from a bootable recovery USB, and have the new
device turn itself into a unique unit on first boot.

This is a **filesystem-level** clone (files, not raw blocks), so the source can
stay live and the image is only as big as the *used* data. Every filesystem UUID
is preserved on restore, so `fstab` / GRUB / extlinux keep working untouched.

```
┌─ source device (running) ──────────┐      ┌─ recovery USB ─┐      ┌─ new device ─────────┐
│ UI ▸ Admin ▸ System Image          │      │ dp-restore.sh  │      │ first boot:          │
│   → dp-create-image.sh             │ ───▶ │  partitions +  │ ───▶ │  dp-firstboot.sh     │
│   → streams .tar.zst to browser    │ file │  mkfs -U +     │flash │  new machine-id/ssh/ │
│                                    │      │  extract +     │      │  hostname, wiped     │
│                                    │      │  bootloader    │      │  netbird+app state,  │
│                                    │      │  + arm firstboot│      │  then reboots once   │
└────────────────────────────────────┘      └────────────────┘      └──────────────────────┘
```

## Hard constraints

- **Architecture must match.** An `x86_64` image (Intel N97) will **not** boot an
  `aarch64` device (RK3588) and vice-versa. `dp-restore.sh` refuses a mismatch.
  Keep one image + one recovery USB per platform.
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
| `dp-restore.sh` | recovery USB | partition target, `mkfs -U` (preserve UUIDs), extract, fix bootloader, arm first boot |
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

## 2. Build an all-in-one recovery ISO (recommended)

Bake everything into **one bootable `.iso`** — the Ubuntu live environment, your
image, `dp-restore.sh`, and the flashing tools as offline `.deb`s — so the target
needs **no network** and there is nothing else to copy.

**From the UI (recommended):** in the image list, click **🏗** on a captured image.
The server auto-downloads & caches the Ubuntu base ISO the first time, builds the
recovery ISO as a background job (live progress), and drops it in the list to
download. The **only** one-time prerequisite is `xorriso` (it needs root, so it's
not auto-installed):
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
to an **8 GB+** USB stick. Boot the target → at the GRUB menu pick **"Try or Install
Ubuntu Server"**, then get a root shell (**Ctrl+Alt+F2**, or the installer's
**Help → Enter shell**) and run:

```bash
bash /cdrom/dp/dp-flash.sh
```

That installs the bundled tools offline and launches the restore (§3). Rebuild the
ISO whenever you make a new golden image.

> **Notes.** Building needs internet on the device (to fetch the tool `.debs`) and
> ~7 GB free. `dp-flash.sh` `dpkg -i`s only leaf tool packages (`gdisk`, `lvm2`,
> `dosfstools`, `cloud-guest-utils`, `zstd`, `parted`) — their libraries are already
> in the Ubuntu Server live env (the installer itself uses them), so core libs are
> never touched. For an **aarch64 (RK3588)**
> image, build with an **arm64** Ubuntu ISO on an aarch64 machine.

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

```bash
sudo bash dp-restore.sh /path/to/dp-image-<host>-<arch>-<ts>.tar.zst
# (omit the disk to be shown a menu, or pass it explicitly:)
sudo bash dp-restore.sh dp-image-....tar.zst /dev/nvme0n1
```

It validates arch + disk size, requires you to type **ERASE**, then partitions,
formats (preserving UUIDs), extracts, installs the bootloader fallback (x86) and
arms the first-boot sanitiser. On success: power off, remove the recovery media.

## 4. First boot of the new device

`dp-firstboot.service` runs once (guarded by `/var/lib/dp-image/firstboot-pending`):
new `machine-id`, fresh SSH host keys, hostname `dp-stream-<last 4 of the primary NIC MAC>`, wiped NetBird
identity, cleared app state, regenerated `SESSION_SECRET`, Ethernet → DHCP. It
then disables itself and reboots into the finished unit. Log: `/var/log/dp-firstboot.log`.

Then: connect to hotspot **DigitalPool-Camera** → `http://192.168.50.1:3000`,
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
