# DigitalPool Camera — Factory Installation Guide

This describes how to install the DigitalPool Camera software onto a unit at the
factory. The USB stick does everything by itself: **plug it in, power the unit on,
wait, and the unit powers itself off when it is finished.** No keyboard, no
network, no menus, no commands to type.

---

## What you receive

| Item | Notes |
|------|-------|
| One `.iso` file | e.g. `dp-recovery-20261004-1530.iso` (about 7–10 GB) |
| A 16 GB (or larger) USB stick per station | A single stick can image any number of units, one after another |

## One-time: make the USB stick

1. Download and install **balenaEtcher** (free — https://etcher.balena.io).
2. Insert the USB stick.
3. In balenaEtcher: **Flash from file** → select the `.iso` → **Select target** →
   the USB stick → **Flash**.
4. When it finishes, eject the stick. It is now ready and is reusable.

Do not copy the `.iso` onto the stick as a file — it must be *flashed* with
balenaEtcher (or an equivalent image writer).

## One-time per unit model: BIOS

The unit must boot from USB. On a factory-fresh unit with an empty internal disk
this normally happens automatically. If it does not:

- Power on and press **Del** (or **F7** / **F11** / **Esc**, depending on the
  model) to enter the BIOS / boot menu.
- Set the USB device first in the boot order, or select it from the one-time boot
  menu.
- If the unit has **Secure Boot**, it can stay enabled.

---

## Installing a unit

1. Plug the USB stick into the unit.
2. Connect a monitor (HDMI) — you need it to read the result screen.
3. Power the unit on.
4. A boot menu appears. **Press nothing.** It starts on its own after a short
   countdown.
5. A message offers **10 seconds to stop**. Press nothing here either — pressing a
   key cancels the installation on purpose, so that the stick can be used on a
   machine that is not meant to be erased.
6. Progress is shown on screen. Typical time is **5–15 minutes**, depending on the
   unit's disk.
7. The unit **powers itself off** when it is done.
8. Remove the USB stick. The unit is installed.

Move the stick to the next unit and repeat. Nothing needs to be reset between
units.

> **Do not unplug or power off the unit while it is working.** If the screen is
> still showing progress, it is not finished.

## Reading the result

**The simplest check, and the one to rely on: a unit that has POWERED ITSELF OFF
passed. A unit still switched on did not.** You do not have to be watching at the
right moment — a failed unit holds its message on screen indefinitely and never
powers off, so it is still there when you come back.

The last screen before the unit powers off says the same thing in words.

**Green — `✔ INSTALL COMPLETE — this unit is ready to ship`**
The unit powers off by itself a few seconds later. Remove the stick and box it.

**Red — `✘ FACTORY INSTALL FAILED — DO NOT SHIP THIS UNIT`**
The unit stays on with the message displayed. **Set the unit aside.** Photograph
or write down the message under the heading and report it. Then power the unit off
by holding the power button.

**Yellow — `⏸ STOPPED — nothing on this unit has been changed`**
A key was pressed during the 10-second window. Nothing was installed and nothing
was damaged. Power the unit off (hold the power button) and start again from
step 1, this time without touching the keyboard.

**Anything else** — for example, the unit shows an Ubuntu installer asking for a
language, a name or a password, or a boot menu that never advances, or it never
powers off — treat it as a failure: set the unit aside and report what the screen
shows.

## Common causes of a red screen

| Message mentions | Means |
|---|---|
| `no eligible internal disk` | The unit has no internal disk, or its disk is smaller than required. Check that the SSD is fitted and seated. |
| `equally likely target disks` | The unit has more than one internal disk. These units must ship with one. Report it. |
| `architecture mismatch` | Wrong ISO for this hardware. Report it — a different ISO is needed. |
| `dp-restore.sh failed` / `verification failed` | The install did not complete correctly. Try the unit once more with the same stick; if it fails again, set the unit aside and report it. |

## What the installed unit does afterwards

Nothing has to be configured at the factory. The **first time the unit is powered
on by the customer**, it gives itself a unique identity (hostname, keys) and then
restarts once. That is expected and takes a couple of minutes.

If you want to verify a unit powers on (optional): power it on, wait 3 minutes,
then shut it down with a short press of the power button. This does not affect the
unit.

---

## Quick checklist per unit

- [ ] USB stick in
- [ ] Monitor connected
- [ ] Power on, leave it alone
- [ ] Green screen → unit powered off → **remove stick** → box it
- [ ] Red screen or anything unexpected → set aside, report the message
