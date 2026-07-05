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
- **No LUKS / full-disk encryption.** This flow assumes a plain GPT layout
  (Ubuntu Server default): ext4 root, plus a vfat ESP on x86.

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

Only the **dpadmin** user sees the "💾 System Image" section (Admin Settings).
Clicking **Create & Download Image**:
1. stops any active stream and `sync`s,
2. streams `dp-image-<host>-<arch>-<timestamp>.tar.zst` to the browser.

The download size is unknown up front (streamed), so the browser shows an
indeterminate progress bar. Keep the tab open until it finishes. Because streams
are stopped, restart streaming afterward (or reboot).

## 2. Build the recovery USB (one-time, per architecture)

The recovery USB is just any bootable Linux (that is **not** the target disk)
with a handful of tools. Put `dp-restore.sh` and the downloaded image somewhere
the recovery environment can read them (a second USB stick is simplest).

Required tools in the recovery environment:

```bash
sudo apt install -y zstd gdisk cloud-guest-utils dosfstools util-linux python3
# provides: zstd, sgdisk, growpart, mkfs.vfat, sfdisk/mkfs.ext4/partprobe/blkid/lsblk, python3
```

### x86_64 (Intel N97)
1. Write an **Ubuntu Server/Desktop 24.04 live ISO** to a USB stick (Rufus / `dd` /
   `balenaEtcher`) and boot the new device from it in "Try / live" mode.
2. Open a terminal, run the `apt install` above.
3. Put the image + `dp-restore.sh` on a second USB stick, mount it, and run the
   restore (see §3).

### aarch64 (RK3588 — Orange Pi 5 / Radxa Rock 5C)
There is no universal x86-style live ISO. Boot the new board from **removable
media it can already boot** (an SD card or USB with a working aarch64 Ubuntu /
Armbian) — anything that is *not* the internal eMMC/NVMe you're flashing.
1. Boot that removable aarch64 Linux.
2. Run the `apt install` above.
3. Copy the image + `dp-restore.sh` locally (or from another USB) and run the
   restore against the internal disk (e.g. `/dev/mmcblk0` or `/dev/nvme0n1`).

> u-boot/idbloader are captured in the image's "bootgap" and written straight
> back by `dp-restore.sh`, so the recovery environment does **not** need to know
> anything about the board's boot procedure.

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
