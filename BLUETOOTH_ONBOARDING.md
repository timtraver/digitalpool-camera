# Bluetooth onboarding

**Status:** Design. Nothing here is implemented yet.
**Date:** 2026-11-09
**Scope:** device (this repo), the DigitalPool mobile app (`digitalpool-app`), and the
`registerCameraDevice` cloud function plus one new cloud function.

This document is the contract between those three pieces. It is written so each can be
built at the same time against the definitions here, and tested end to end on a bench
camera.

---

## 1. Why

Today a new camera is set up through its own WiFi hotspot (`DigitalPool-xxxx`):

1. The phone joins the hotspot.
2. A captive portal opens the admin UI.
3. The operator picks the venue WiFi.
4. The operator registers the box with their DigitalPool email and password.

The onboard WiFi chip is kept busy running that hotspot, so every box needs a **USB WiFi
dongle** to reach the internet.

The new flow moves setup to **Bluetooth Low Energy (BLE)** through the DigitalPool mobile
app, which the operator is already signed in to:

- **The onboard WiFi chip becomes the internet connection.** No dongle is needed. On the
  N97 boxes the radio can be the hotspot *or* the internet but never both (§3.3), which
  is exactly why the dongle is needed today.
- **No passwords are typed into the camera.** Registration uses the app's existing
  login.
- **Bluetooth carries only small control messages.** Once the box is online, the app hands
  the user to the full web UI (live preview, overlays, streaming) on the venue network.

### Goals

- Unbox → online → registered → in the web UI, all from the app, in under 3 minutes.
- Bluetooth is available whenever the box is powered, not only on first boot, so a box can
  be moved to a new venue or recover from a changed WiFi password.
- The hotspot stays available as an on-demand fallback.
- Devices already in the field keep working exactly as they do now.

### Non-goals (v1)

- Streaming preview or any media over Bluetooth.
- WPA2-Enterprise (802.1X) venue networks.
- Venue WiFi that requires a captive-portal login to reach the internet. Use Ethernet or
  the dongle there. See §12.
- Controlling streams from the app over Bluetooth.

---

## 2. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | **BLE only. No Classic Bluetooth.** | Every phone in circulation has BLE: iPhone 4S+ (2011), Android 4.3+ (2013). iOS doesn't let apps use Classic Bluetooth serial (SPP) without Apple's MFi hardware program, so BLE is the only option that works on both platforms. Classic is switched off (`ControllerMode = le`), which also leaves less to attack. |
| D2 | **A small Python daemon handles Bluetooth. Node handles everything else.** | `python3-gi` / `python3-dbus` are already on the image for the GStreamer script, and BlueZ's D-Bus API is the supported way to act as a BLE peripheral. The daemon is a thin pipe: GATT, chunking, advertising. Auth, network and registration logic stay in Node, so the web UI and the app share one code path. Node `bleno` was rejected because it takes the HCI device away from `bluetoothd` and needs raw-socket privileges. |
| D3 | **The app's DigitalPool login is the identity.** | The app asks the backend for a short-lived signed **grant** bound to this device and to a one-time nonce from this BLE connection. The device checks the signature **offline** against a public key shipped in the image. No password is sent over Bluetooth or stored on the box. |
| D4 | ~~Registration uses a new `claim` action.~~ **Superseded 2026-11-10: the app sends the signed-in user's Firebase ID token, and `verify`/`assign` accept it in place of email + password.** | Simpler than a second credential type: the user is already signed in to the app, so that login *is* the authentication, and the backend verifies the token with `admin.auth().verifyIdToken`. No password is typed into a phone and the box keeps nothing. **The trade-off, accepted deliberately:** a fake device advertising our service UUID could collect a token that is valid for up to an hour — see §7.5. Grants (§7) can replace this later without changing the BLE contract. |
| D5 | **The browser handoff uses a one-time link that logs in as the app user.** | The web UI opens already signed in as the DigitalPool account that owns the box. The shared `admin`/`Digitalpool` login stops being the normal way in (§9.4). |
| D6 | ~~The hotspot is off by default and started on demand over BLE.~~ **Reversed 2026-11-10: under `ble` the camera never runs a hotspot at all.** | Bluetooth already does every job the hotspot was being kept for. It reaches a box with no network, which is the recovery case, and it needs no window or fallback to do it. Keeping an on-demand AP meant a WPA2 access point that could appear at a venue, a captive portal to maintain, `hotspot.start`/`hotspot.stop` to build and gate, and §7.4's ungated recovery window — all to cover one case (§12) that it covers badly anyway. `hotspot` mode still exists for the boxes already in the field (D7); this is about the new architecture. |
| D7 | **Onboarding mode is chosen per device: `ble` \| `hotspot` \| `auto`.** | Boxes already in the field are pinned to `hotspot` by a migration, so a venue whose tablet lives on the hotspot doesn't lose its camera after an update. New images use `auto`: BLE if a Bluetooth controller exists, otherwise hotspot. That covers boards with no radio, such as the Orange Pi 5. |
| D8 | **One phone connected at a time — but the box stays discoverable throughout.** | BlueZ sends GATT notifications to every subscribed phone, so serving several at once would mean routing each reply to the right one, and a setup flow never needs that. A second phone is disconnected rather than queued. **It still sees the box**: D8 is about serving one *session*, and amended on 2026-11-10 because the two had been conflated — see §5.6. |

---

## 3. Hardware: M0 results (measured 2026-11-10)

M0 is **done for both Intel boards**. Neither radio is what this document first assumed,
and the two are different enough from each other that §8 has to handle both.

### 3.1 There are two hardware profiles, not one

Checked over SSH on `dp-stream-1` (N97 bench), `dp-stream-119c` / `2e27` / `9605` / `cc64`
(N97, Ariakon), and `dp-stream-b1b5` (**N100 — the ISO master, so this is what production
units will be**).

| | **N100** (production) | **N97** (the five in the field) |
|---|---|---|
| Example box | `dp-stream-b1b5` | `dp-stream-1`, four at Ariakon |
| WiFi | **Intel Wireless 7265** `[8086:095a]`, `iwlwifi` | **Realtek RTL8821CE**, `rtw_8821ce` |
| WiFi generation | **802.11ac (WiFi 5)**, 2×2 MIMO, ~867 Mbps on 5 GHz. **Not WiFi 6** — `iw list` reports VHT and zero HE capabilities. | 802.11ac (WiFi 5), 1×1, ~433 Mbps |
| Bluetooth | Intel, USB `8087:0a2a` (the 7265's BT half) | Realtek, USB `0bda:c821` (the 8821CE's BT half) |
| BT firmware | `intel/ibt-hw-37.8.10-fw-22.50.19.14.f.bseq`, patch activated at boot | `rtl_bt/rtl8821c_fw.bin` + `_config.bin` |
| BT version | 4.2 (Legacy ROM 2.x, 2015 build) | 4.2 (`hci_ver=08`) |
| `hci0` present | ✅ | ✅ on all five |
| **AP + client at once** | ✅ **Yes** (§3.3) | ❌ **No, ever** (§3.3) |
| **Advertises while a phone is connected** | ✅ Yes | ❌ No — undiscoverable until the phone leaves (§5.6) |

That last row is reported to the app as **`info.advertisesWhileConnected`**, so it can
decide whether holding the BLE link while the web UI is on screen is free (N100) or makes
the box invisible to everyone, including the phone holding it (N97). It is optimistic
(`true`) until the daemon learns otherwise, which takes about 1.5 s from the first
connection.

**Bluetooth works out of the box on both.** Nothing to ship: `btusb` binds and the vendor
firmware already in `linux-firmware` loads at every boot, on both chipsets. Both are BT
4.2, so §3.4 applies across the fleet.

**Product direction, decided 2026-11-10:** production units are the **N100**, the N97
boxes already in the field behave identically, and on both of them BLE is the primary way
a phone reaches the box. The onboard radio carries the internet. A venue that wants WiFi 6
adds a **USB WiFi 6 dongle**, which then becomes the client (§8.2). Onboard WiFi 6 is
expected in a later hardware revision, at which point the dongle stops being needed.

**On WiFi 6: no.** Neither board has it today. The N100's Intel 7265 is a 2014-era 802.11ac
part. It is still the better of the two radios — 2×2 instead of 1×1, so roughly double the
link rate — and the uplink, not the WiFi link, is what bounds streaming bitrate, so this
does not cost us anything we were counting on. It just means §1's "WiFi 6" claim was
wrong. If WiFi 6 is wanted on production units it is an M.2 card swap (an AX210 is the
obvious choice and would bring BT 5.2 with it), not a software change.

### 3.2 Two things that have to be fixed before any BLE code runs

Both apply to **every** box checked, N97 and N100 alike:

1. **`bluez` is not installed.** Only `libbluetooth3` is there, pulled in as a dependency.
   There is no `bluetoothctl`, no `bluetoothd`, and no `bluetooth.service` — so there is
   no GATT stack yet. `python3-gi` and `python3-dbus` *are* present, as §4 assumed.
   Installing `bluez` is a migration (§13).
2. **`rfkill` is not installed either**, so the `ExecStartPre=+/usr/sbin/rfkill unblock
   bluetooth` in §4.2 would fail the unit on every start. Install `rfkill` in the same
   migration, or drop the line — no adapter checked was soft-blocked.

### 3.3 AP + client concurrency: yes on the N100, never on the N97

**N100 / `iwlwifi` — it works:**

```
$ iw list
	valid interface combinations:
		 * #{ managed } <= 1, #{ AP, P2P-client, P2P-GO } <= 1, #{ P2P-device } <= 1,
		   total <= 3, #channels <= 2
```

One client plus one AP, and `#channels <= 2` means they need not even share a channel —
a 5 GHz client alongside a 2.4 GHz hotspot is allowed by the driver. Intel's regulatory
handling (LAR) may still refuse to *start* an AP on 5 GHz, so the safe construction is to
pin the on-demand hotspot to 2.4 GHz and leave the client wherever the venue put it. This
is untested in practice and is the one M0 item still worth bench time (§3.5).

**N97 / `rtw_8821ce` — it does not:**

```
$ iw list
	interface combinations are not supported
```

The driver advertises AP, managed, monitor and mesh as *modes* but publishes **no valid
interface combination at all**. That is not a channel or regulatory limit a different band
would dodge; it will not bring up a second interface of any kind.

Consequences:

- **§8.3 has to keep both branches**, chosen at runtime from the adapter's own
  capabilities rather than from a board name. Read `iw list` (or
  `NL80211_ATTR_INTERFACE_COMBINATIONS`) once at startup and cache the answer.
- On the N97, `hotspot.start` drops the venue WiFi and returns
  `{"internetInterrupted": true}`. On the N100 it should not have to.
- A box on **Ethernet** keeps its internet either way — a wired link is a different
  interface — so `internetInterrupted` is `false` whenever `enp2s0` is carrying the route.
- A box with the **USB dongle still fitted** keeps both as well: two radios, so §8.2's
  "prefer the dongle for the AP" rule stands.

The N97's limitation is still the clearest argument for this whole project: on those five
boxes the onboard radio can be the hotspot *or* the internet, never both, which is exactly
why each one needs a second radio today.

### 3.4 What BT 4.2 changes

Both chipsets are 4.2. Nothing here breaks the design, but it is worth knowing:

- **No LE extended advertising.** The advertisement is the legacy 31 bytes, which §5.2 is
  already written to.
- **No LE 2M PHY.** Transfers run at the 1 Mbps symbol rate. Irrelevant for control
  messages.
- **ATT MTU tops out around 247**, not 517, because Data Length Extension caps the packet
  at 251 bytes. Android should still ask for 517 and take what it gets; §6.2's framing
  already works at any MTU. A 3 KB scan result is ~13 notifications instead of ~7.
- LE Secure Connections (§5.4) **is** in 4.2, so Just Works pairing still encrypts with
  ECDH as described.

### 3.5 Still unverified

| Thing | Why it is still open |
|---|---|
| Advertising visible from a **phone** | ✅ Verified box-to-box (§3.6), but not yet from iOS or Android. The pairing prompts in §6.1 are still unobserved. |
| N100 AP + client in practice | The driver allows it (§3.3); whether `iwlwifi` will really start a 2.4 GHz AP beside a connected 5 GHz client is a bench test, not a capability read. |
| Radxa Rock 5C (AIC8800D80) | No Rock 5C was reachable. The AIC BT module *does* load on the Intel images (`aic_bluetooth_mod_init` appears in `journalctl -k` on both) but creates no `hci` device there, because the AIC card is not in these boxes. Unchanged risk; still needs its own check. |
| Orange Pi 5 | No onboard radio. Unchanged: `hotspot` mode, or a USB BT adapter. |
| Soak | A 7-day advertising soak (§14) still has to run on real hardware. |

### 3.6 The whole BLE path is proven on both chipsets

Done on 2026-11-10 with `migrations/0028-bluez-stack.sh` and `ble/tools/ble-smoketest.py`,
which brings up the real service UUID, the real RX/TX characteristics and the real §5.2
advertisement payload, and echoes whatever it is written.

With `dp-stream-1` (Realtek) advertising and `dp-stream-b1b5` (Intel) acting as the
central, over the air:

```
Device 5C:8A:AE:AF:62:7D (public)
	Name: dp-stream-1
	UUID: Vendor specific           (3f8abaa2-7312-4a07-be35-7c7f1618bb6a)
	ManufacturerData.Key: 0xffff (65535)
	ManufacturerData.Value:  01 00 7d 62
```

`01 00 7d 62` decodes as proto 1, state bits none set, shortId `627d` — the last four hex
digits of the advertiser's address, exactly as §5.2 specifies. Then connect → service
discovery → subscribe to TX → write to RX → notification back:

```
  TX: phone subscribed to notifications
  RX: 2 bytes from /org/bluez/hci0/dev_B4_69_21_B2_0A_FB: b'hi'
  TX: notified 7 bytes
```

So `GattManager1.RegisterApplication`, `LEAdvertisingManager1.RegisterAdvertisement`,
the local name in the scan response, the manufacturer payload, connection, GATT
discovery, writes and notifications all work on both the Intel and the Realtek radios.
What is left is §5.3's recovery, the §6.2 chunking, encryption and pairing — all of which
is dp-ble.py, not hardware risk. See §5.5 for the one trap this turned up.
---

## 4. Device architecture

```
 phone (DigitalPool app)
        │  BLE GATT
        ▼
 ┌────────────────────────┐   NDJSON over unix socket    ┌─────────────────────────────┐
 │ digitalpool-ble.service │ ───────────────────────────▶ │ digitalpool-camera.service   │
 │  ble/dp-ble.py (Python) │ ◀─────────────────────────── │  server.js + bleBridge.js    │
 │  • GATT server          │  /run/digitalpool-camera/    │  • auth (grants, nonces)     │
 │  • advertising          │        ble.sock              │  • command dispatch          │
 │  • chunk/reassemble     │                              │  • wifiManager (nmcli)       │
 │  • pairing agent        │                              │  • registration, handoff     │
 └──────────┬─────────────┘                              └─────────────────────────────┘
            │ D-Bus (org.bluez)
            ▼
     bluetooth.service (BlueZ)
```

### 4.1 `bluetooth.service` (BlueZ)

Install `bluez` (it's in Ubuntu Server 24.04) and enable the service.
`/etc/bluetooth/main.conf`:

```ini
[General]
ControllerMode = le          # BLE only (D1)
JustWorksRepairing = always  # phones that "forgot" the box can pair again
Privacy = off                # fixed address; phones cache the GATT layout per address

[Policy]
AutoEnable = true            # power the adapter on at boot
```

The adapter name is **not** set here. The daemon sets `Adapter1.Alias` at startup (§5.1),
so it follows the device name.

### 4.2 `digitalpool-ble.service`

```ini
[Unit]
Description=DigitalPool BLE onboarding
After=bluetooth.service
Wants=bluetooth.service

[Service]
User=dp
Group=dp
SupplementaryGroups=bluetooth
ExecStartPre=+/usr/sbin/rfkill unblock bluetooth   # needs the rfkill package (§3.2)
ExecStart=/usr/bin/python3 /home/dp/digitalpool-camera/ble/dp-ble.py
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

It is **not** bound to `digitalpool-camera.service`. If Node restarts, the daemon keeps
advertising, answers `UNAVAILABLE`, and reconnects to the socket with backoff.

D-Bus policy (`/etc/dbus-1/system.d/digitalpool-ble.conf`), so `dp` can register GATT
applications and advertisements without depending on Ubuntu's default `bluetooth` group
rules:

```xml
<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-BUS Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <policy user="dp">
    <allow send_destination="org.bluez"/>
    <allow send_interface="org.bluez.GattCharacteristic1"/>
    <allow send_interface="org.bluez.LEAdvertisement1"/>
    <allow send_interface="org.bluez.Agent1"/>
    <allow send_interface="org.freedesktop.DBus.ObjectManager"/>
    <allow send_interface="org.freedesktop.DBus.Properties"/>
  </policy>
</busconfig>
```

### 4.3 The Node ↔ daemon bridge

- **Socket:** Node listens on `/run/digitalpool-camera/ble.sock`. Add
  `RuntimeDirectory=digitalpool-camera` and `RuntimeDirectoryMode=0700` to
  `digitalpool-camera.service`. Both processes run as `dp`.
- **Format:** newline-delimited JSON in both directions.
- **Message contents:** the daemon forwards **whole, reassembled** messages only. It never
  reads them.

| Direction | Message | Meaning |
|---|---|---|
| daemon → Node | `{"t":"hello","proto":1,"adapter":"hci0","address":"AA:BB:…"}` | Daemon (re)connected |
| daemon → Node | `{"t":"connect","conn":"<id>"}` | A phone connected |
| daemon → Node | `{"t":"msg","conn":"<id>","data":{…}}` | One complete request from the phone (§6.3) |
| daemon → Node | `{"t":"disconnect","conn":"<id>"}` | Phone went away. Node drops that connection's nonce and auth. |
| Node → daemon | `{"t":"send","conn":"<id>","data":{…}}` | Response or event to notify to the phone |
| Node → daemon | `{"t":"adv","state":{…}}` | Update the advertisement's manufacturer data (§5.2) |
| Node → daemon | `{"t":"kick","conn":"<id>"}` | Disconnect the phone (idle timeout, too many auth failures) |

`conn` is a new random id for each BLE connection, not the phone's address.

New file: **`bleBridge.js`**. It owns the socket server, the per-connection state (nonce,
granted scope, last activity) and command dispatch. It calls into `wifiManager` and the
registration functions (§8, §9).

---

## 5. Advertising

### 5.1 Identity

- **Adapter alias / BLE local name:** **`DP-DuoCast-XXXX`**, where `XXXX` is the last four
  hex digits of the primary MAC, uppercase — `DP-DuoCast-B1B5`. 15 characters, well inside
  the 20-character budget. The local name goes in the **scan response**, not the main
  advertisement.

  This is deliberately **not** `getDeviceName()`. A phone's device list is the first thing
  somebody sees when they set up their first camera, and `dp-stream-b1b5` reads like
  something that leaked out of a terminal. The box therefore answers to two names, which is
  fine because they share their last four digits:

  | Where | Name | Comes from |
  |---|---|---|
  | The app's scan list, the web UI | `DP-DuoCast-B1B5` | `getDisplayName()` / `bleBridge.bleName()` |
  | Hostname, NetBird peer, the DigitalPool backend, mediamtx hosts | `dp-duocast-b1b5` | `getDeviceName()` |

  The hostname was `dp-stream-XXXX` until 2026-11-10; migration `0031` renames it, and
  `dp-firstboot.sh` names new units that way. It stays **lowercase** because
  `netbird up --hostname=` and the mediamtx host entries derive from it and both want
  something DNS-safe. The rename is safe on a registered box: `CLOUD_FUNCTION_SPEC.md` and
  §11.2 both key the device record on `deviceId`/`macAddress`, so `deviceName` is
  descriptive only. `0031` deliberately skips any box an operator has renamed by hand.

  `info` returns **both** (`bleName` and `name`), so the app can show the product name
  while it is scanning and switch to the device name once it is connected and the user is
  about to be handed to the web UI.

  Both `bleBridge.js` and `dp-ble.py` compute `DP-DuoCast-XXXX` independently, because the
  daemon has to advertise something sensible in the window before Node has connected — and
  on a box whose Node is down, that window is the whole time.
- **Primary MAC:** the one `getPrimaryMac()` returns (the wired NIC, even without a
  cable). Grants are bound to it (§7).

### 5.2 Advertisement payload (31 bytes)

| Field | Bytes | Value |
|---|---|---|
| Flags | 3 | LE General Discoverable, BR/EDR not supported |
| Complete list of 128-bit service UUIDs | 18 | the service UUID (§6.1) |
| Manufacturer specific data | 8 | company ID `0xFFFF` (reserved for testing; replace if DigitalPool registers a Bluetooth SIG company ID), then 4 bytes: `proto` (u8), `state` bits (u8), `shortId` (u16, little endian, the last 4 hex digits of the **primary** MAC) |

`shortId` comes from `getPrimaryMac()`, **not** from the Bluetooth adapter's own address.
On both board profiles the radio is the Bluetooth half of a combo card and carries its own
address, unrelated to the wired NIC — on the bench N97 the two differ in the last byte, on
the N100 they share nothing. The app matches `shortId` against the name on the box and
against the MAC a grant is bound to (§7.2), so it has to be the MAC everything else uses.

`state` bits, so the app's device list is useful **before connecting**:

| Bit | Meaning |
|---|---|
| 0 | registered |
| 1 | has internet |
| 2 | WiFi client configured |
| 3 | recovery window open (§7.4) |
| 4 | hotspot active |

Node pushes `adv` whenever these change. The daemon updates the registered advertisement's
`ManufacturerData` property, or re-registers it if the controller doesn't pick the change
up.

### 5.3 Staying connectable for weeks

These are the failure modes that make "always on" BLE quietly stop working. The daemon
must handle every one:

- **`bluetoothd` restarts.** The daemon's GATT application and advertisement disappear.
  Watch the `org.bluez` name (`NameOwnerChanged`) and re-register everything.
- **The adapter is removed and comes back** (USB reset, rfkill). Watch `InterfacesAdded`
  for `org.bluez.Adapter1`, power it on, re-register.
- **Advertising stops when a phone connects.** It is not optional on these controllers and
  it is not something to accept — see §5.6.
- **An idle phone holds the only connection.** Node `kick`s any connection with no request
  for **5 minutes**. In-progress operations (a WiFi connect, registration) carry on; the
  app reads their result after reconnecting.
- **A self-check every 60 s.** If the adapter is powered but the advertisement isn't
  registered and no phone is connected, re-register it and log a warning.
- **iOS keeps an LE link alive after the app has let go of it.** A paired peripheral stays
  connected even once the app calls `cancelDeviceConnection`, and a peripheral-initiated
  disconnect is the only thing iOS cannot override. On an N97 — which cannot advertise
  while connected (§5.6) — that makes the box vanish from every list until something
  terminates the link. Found 2026-11-11: press back, and the camera disappears.

  Four bounds now exist, in the order they fire:

  | Mechanism | When | Covers |
  |---|---|---|
  | **`session.end`** | immediately | the normal path — the app says it is leaving |
  | unsubscribed + 30 s | TX unsubscribed, link still up | the app crashed or was force-quit |
  | silent + 60 s | connected, never sent a request | a stranger, or a failed discovery |
  | idle + 5 min | everything else | the long stop |

  `session.end` replies first and drops the link ~250 ms later, so the app gets its answer
  rather than a dead socket. Measured: reply well inside a second, link down 2.75 s after
  the request, advertising resumed immediately. Most of that gap is the reply travelling as
  many 17-byte notifications — see the MTU note in §10.
- **A link that outlives the process that was serving it.** This one is the worst of the
  set, because it is permanent rather than transient. See below.

#### Free the connection slot whenever the software restarts

Found on `dp-stream-b1b5`, 2026-11-10.

A GATT link survives the daemon dying, and an iPhone keeps one open even with the app
backgrounded. So after a restart the controller can still hold a link whose session —
subscriptions, nonce, scope — died with the old process. With one phone at a time (D8)
that link is worse than none:

- The phone that owns it cannot do anything with it.
- The box does not advertise, so **nobody** can see it, including that phone.
- The idle kick that should rescue the situation is reset every time Node restarts, so
  during active development it may never fire at all.

The box looks dead to everyone, indefinitely. Three things close it:

1. **The daemon drops every existing link at startup.** It has no session state for any of
   them, so none of them is useful. The phone reconnects, which it is built to do.
2. **Losing the socket to Node releases the slot.** Node holds the per-connection state,
   so a restart has already invalidated the session; holding the link would only keep the
   box from advertising.
3. **A connection that has never sent a request is kicked after 60 s** — much shorter than
   the 5-minute idle timeout, because a real app sends `info` within a second or two of
   subscribing, even allowing for pairing. A silent link is almost always an orphan.

### 5.4 Pairing agent

The daemon registers an `org.bluez.Agent1` with capability **`NoInputNoOutput`** and makes
it the default agent. That gives LE Secure Connections "Just Works" pairing: the link is
encrypted with ECDH, so the WiFi password can't be sniffed passively. With no display or
keypad on the box there is no protection against an active man-in-the-middle; the grant
signature (§7) is what stops someone else issuing commands.

Bonds pile up in `/var/lib/bluetooth`. The daemon keeps the **20** most recent and removes
older devices through `Adapter1.RemoveDevice`.

### 5.5 `LEAdvertisement1.Discoverable` must be set to true explicitly

Found on the bench, 2026-11-10, and it costs an hour if you meet it cold.

If the advertisement object does not carry a `Discoverable` property, BlueZ takes the
value from `Adapter1.Discoverable`, which is **false** on a box nobody has run
`bluetoothctl discoverable on` against. BlueZ then builds an AD whose Flags byte says
"not discoverable", the controller transmits it happily, and **every scanner doing general
discovery drops it**.

What makes this expensive is that nothing looks wrong from the box's side:

- `RegisterAdvertisement` returns success.
- `bluetoothctl show` reports `ActiveInstances: 0x01`.
- The adapter scans normally and sees every other device in the room.

The box is simply invisible. Setting `"Discoverable": dbus.Boolean(True)` in the
advertisement's properties fixes it, and the box appears immediately with its name,
service UUID and manufacturer data intact. `dp-ble.py` must set it; `ble-smoketest.py`
does, with a comment saying why.

Note that this is **not** the same as the adapter's own `Discoverable` property, which
controls legacy Classic inquiry and should stay false.

### 5.6 Keep advertising while a phone is connected

Found in the field, 2026-11-10, reported as "b1b5 has stopped advertising".

It had not. Tim's own iPhone was connected, with the app's box screen open polling
`net.status` every 60 s. D8 was read as "do not advertise while connected", so the daemon
unregistered the advertisement on connect — and the box disappeared from every scanner in
range, **including the app's own "nearby boxes" screen on the very phone holding the
link**. Having just unregistered the camera, Tim was told there were no cameras nearby.

Neither kick rescued it, and that is the part worth understanding:

- The **60-second silent kick** did not apply: the app had sent requests, so it was not
  silent.
- The **5-minute idle kick** never fired: the app polls `net.status` every 60 s, which
  resets `lastActivity` every time. A well-behaved app keeps the slot forever.

So the only bound on invisibility was the user closing the app. Both kicks are still worth
having, but neither is the fix.

**The fix is to stay discoverable.** Serving one session and being visible are different
things, and only the first is what D8 was ever about. The daemon now advertises
continuously and turns away a second *connection*; a second phone can see the box and is
told it is busy, instead of being told it does not exist.

**The controller terminates a connectable advertisement when a connection completes**, so
simply not unregistering is not enough on its own. Three things make it stick:

1. `_on_device_connected()` re-asserts the advertisement **1.5 s after** the link comes up,
   once the controller has finished with it.
2. `active_instances()` reads `LEAdvertisingManager1.ActiveInstances` — what the *hardware*
   has on air. The daemon's own `self.advertising` flag only records that BlueZ accepted a
   registration, and the two disagree exactly when it matters.
3. The 60-second self-check compares the two and repairs a mismatch.

**The two controllers differ, and this is the one place the fleet is not uniform.**
Measured 2026-11-11 with a third box scanning while a connection was held:

| Board | Controller | Advertises while connected? |
|---|---|---|
| N100 | Intel 7265 | ✅ Yes. `ActiveInstances` stays 1 and a third party receives its adverts throughout. |
| N97 | Realtek RTL8821CE | ❌ No. `RegisterAdvertisement` returns `org.bluez.Error.Failed: Failed to register advertisement` for as long as a link is up. |

So **an N97 box is undiscoverable while anyone is connected to it**, and nothing in
software can change that. The daemon tries three times, logs
`could not get an advertisement on the air after 3 attempts`, and stops rather than
churning the radio; on disconnect it advertises again immediately. That is the correct
behaviour, not a failure — but it means the 60-second silent kick and the 5-minute idle
kick (§14.3) are what bound a second phone's wait on an N97, where on an N100 they merely
tidy up.

**Do not use `ActiveInstances` to decide whether to repair this.** It reads 1 on the N97
after the controller has stopped broadcasting, so a repair conditioned on it never fires —
which is how the box went silently undiscoverable the moment a phone connected, with every
health signal reading green. The daemon now re-registers unconditionally 1.5 s after a
connection and judges the result by whether the register call itself succeeded. Costing a
few milliseconds on a controller that was fine is the right trade against trusting BlueZ's
bookkeeping.
---

## 6. GATT protocol

### 6.1 UUIDs

| | UUID | Properties |
|---|---|---|
| Service | `3f8abaa2-7312-4a07-be35-7c7f1618bb6a` | primary |
| **RX** (phone → box) | `b81717c7-da32-444b-804d-5dbe7e7d756c` | `write` (with response), **encrypted** |
| **TX** (box → phone) | `ea362436-362f-4ceb-8211-f6db458206a3` | `notify`, **encrypted** |

Both characteristics require encryption (BlueZ flags `encrypt-write` and `encrypt-read`,
plus the TX descriptor). The first write starts pairing automatically:

- **iOS** shows a system "Pairing Request" prompt once.
- **Android** shows a pairing notification or dialog once.

Both are expected in the app flow (§10).

### 6.2 Framing

A message is UTF-8 JSON that is usually larger than one BLE packet. Each packet on RX or
TX is a **chunk**:

```
byte 0     msgId    u8, sender-chosen, wraps at 255
byte 1     index    u8, 0-based
byte 2     count    u8, total chunks in this message (1..255)
bytes 3..  payload  up to (ATT_MTU - 3) - 3 bytes
```

- Phone → box chunks are sent as **write-with-response**, one at a time.
- Box → phone chunks are sent as notifications in order.
- The receiver reassembles by `msgId`. It throws away a partial message if no chunk arrives
  for **5 s**, or if a chunk with a new `msgId` starts before the old one finished.
- Maximum message size is 16 KB. A WiFi scan of about 40 networks is around 3 KB.
- **MTU:** Android must call `requestMtu(517)` after connecting. iOS negotiates by itself
  (`maximumWriteValueLength`, usually 182–509). The box works with any MTU down to the
  default 23 (17-byte payloads), only more slowly.

  **Where the box reads it from matters, and is easy to get wrong.** BlueZ does *not*
  expose the negotiated MTU as a readable property on a **local** GATT characteristic —
  that object is exported by `dp-ble.py`, not by `bluetoothd`, so asking `org.bluez` for a
  property on it raises. An earlier version did exactly that, caught the exception, and
  fell back to 23 **on every message, forever**. Nothing looked wrong: the log dutifully
  reported "MTU 23", a legal value, so it read as a phone that had not negotiated.

  The cost was 10–30× more packets than needed — a venue list going out as dozens of
  17-byte notifications instead of one or two — and such a burst is a plausible cause of
  the supervision timeout seen on the choose-venue screen on 2026-11-11.

  **Attempted fix, reverted the same evening.** The `mtu` key in `WriteValue`'s options
  looked like the answer — learned from the phone's first write, which always arrives
  before the box has anything to send back. It is **not** the negotiated link MTU. Both
  controllers report **517 for every link, including an iPhone**, which iOS never
  negotiates. Chunking notifications to 511 bytes against a link that cannot carry them
  means they are truncated or dropped, the app never reassembles a complete message, and
  the request times out **with no error anywhere**: the box logs a successful send and the
  phone waits out its timeout. Silent on both sides, which is what made it expensive.

  **Clamping is not a fix.** Any value above 23 that turns out to be wrong fails in
  exactly this way; choosing 185 or 247 only changes which phones break. So the chunk size
  is back to the spec-guaranteed 23, which costs packets rather than correctness, and the
  reported value is logged on every connection so the data is still being collected.

  **The proper fix is `AcquireNotify`**, which returns the true notification MTU alongside
  a file descriptor — a different notification path from `PropertiesChanged`, worth doing
  deliberately with a phone to test against. Until then the choose-venue screen is slower
  than it needs to be, and that is the right trade.

  The tell, if this recurs: a reply that never arrives, with no ATT error and no complaint
  from BlueZ, while the box's own log says it sent the message.

  **The same lie breaks writes in the other direction.** Measured on a real link to 85E4
  while BlueZ was reporting an MTU of 517 for it:

  | single RX write | result |
  |---|---|
  | 20, 103, 183, 247, 403 bytes | accepted |
  | 514 bytes | **rejected — ATT 0x0D Invalid Attribute Value Length** |

  So the true limit was somewhere between 404 and 513, and 517 was fiction. An app that
  sizes its chunks from the reported MTU therefore has **every oversized write rejected
  before it reaches the box**, which looks from the device like a request that was never
  sent. That is what the first Android registration attempt hit: `info` was small enough to
  arrive, `register.start` carried a ~900-byte ID token in two 514-byte chunks, both were
  rejected, and neither the box nor the backend ever saw it.

  Both sides should therefore treat the reported MTU as an upper bound at best. The app
  caps its RX chunks conservatively; the box chunks notifications at 23 until
  `AcquireNotify` gives it a figure worth believing.

### 6.3 Message envelope

Request (phone → box):
```json
{ "id": 12, "cmd": "wifi.connect", "args": { "ssid": "Joe's Bar", "psk": "…" } }
```

Response (box → phone). Exactly one per request:
```json
{ "id": 12, "ok": true, "result": { "accepted": true } }
{ "id": 12, "ok": false, "error": { "code": "NOT_AUTHORIZED", "message": "Sign in on this box first" } }
```

Event (box → phone, unprompted):
```json
{ "event": "wifi.progress", "data": { "stage": "dhcp" } }
```

`id` is chosen by the app and echoed back. It's separate from the framing `msgId`.
Requests may be sent while another is outstanding; responses can come back in any order.

### 6.4 Error codes

| Code | Meaning |
|---|---|
| `BAD_REQUEST` | Malformed JSON or invalid arguments |
| `UNKNOWN_COMMAND` | Command not supported by this firmware. The app should check `info.proto` and `info.commands`. |
| `NOT_AUTHORIZED` | The command needs a grant scope this connection doesn't have (§7.3) |
| `AUTH_FAILED` | Grant rejected: bad signature, wrong device, wrong nonce, unknown `kid` |
| `RATE_LIMITED` | Too many failed auth attempts on this connection. The box disconnects. |
| `BUSY` | A conflicting operation is running (e.g. two `wifi.connect`) |
| `NO_INTERNET` | The operation needs internet and the box has none |
| `WIFI_NOT_FOUND`, `WIFI_AUTH_FAILED`, `WIFI_TIMEOUT`, `WIFI_FAILED` | WiFi connect outcomes |
| ~~`SUBSCRIPTION_REQUIRED`~~ | **Removed 2026-11-11.** Registering a camera no longer depends on a plan, and nothing shown during registration mentions plans, pricing or Enterprise. A box talking to an older backend that still answers 402 reports `REGISTRATION_FAILED` with neutral wording rather than relaying the backend's "subscribe at…" sentence. **Since 2026-11-14 a subscription governs nothing at all** — see `ENFORCE_PACKAGES` in subscriptionManager.js. |
| `REGISTRATION_FAILED` | Any other registration refusal. `message` carries the backend's text. |
| `UNAVAILABLE` | Node isn't running. Sent by the daemon itself. |
| `INTERNAL` | Bug. Details are in the journal. |

### 6.5 Never gate a notification on `StartNotify`

Found on the bench, 2026-11-10, and it is the kind of bug that passes every
test you run before you pair and fails every time afterwards.

BlueZ keeps a **bonded** client's CCCD across connections and restores it on
reconnect **without calling `StartNotify` on the GATT application again**. A
daemon that tracks a `notifying` flag from `StartNotify`/`StopNotify` and
refuses to send unless it is set therefore works perfectly for exactly one
connection — the one during which the phone first paired — and silently drops
every reply from the second connection onwards. Which is to say: it works while
you are testing setup, and is broken forever after setup.

The symptom on the box is a log line saying nothing is subscribed; the symptom
on the phone is a request that never comes back.

`dp-ble.py` therefore sends whenever a connection exists and keeps `notifying`
only for the journal. Emitting a notification nobody subscribed to is safe —
BlueZ discards it.

### 6.6 `wifi.connect`, in detail

Agreed with the app, 2026-11-10, and implemented on both sides.

**Request.** `psk` is omitted for an open network; `hidden` is set when the user typed a
name that was not in the scan.

```json
{ "id": 7, "cmd": "wifi.connect", "args": { "ssid": "Joe's Bar", "psk": "secret" } }
```

**Response.** One reply, immediately — joining takes up to 45 s and the BLE link is the
first thing to suffer while the radio retunes, so the work happens in the background.

```json
{ "id": 7, "ok": true, "result": { "accepted": true, "ssid": "Joe's Bar" } }
```

**Progress.** `wifi.progress` events, ending in exactly one final stage:

| Stage | Means | Final |
|---|---|---|
| `associating` | NM is in `prepare`/`config` | |
| `authenticating` | NM is in `need-auth` — the four-way handshake | |
| `dhcp` | NM is in `ip-config`/`ip-check` | |
| `online` | joined; `data.internet` says whether the outside world is reachable | ✅ |
| `failed` | `data.code` and `data.message` say why | ✅ |

These are read from NetworkManager's real device state, not timed guesses, because the
difference matters to whoever is standing in the venue: a stall at `authenticating` is a
wrong password, a stall at `dhcp` is the router. A stage is sent only when it changes.

**`online` is the only success stage**, with internet as a flag on it. An earlier draft had
a separate `no-internet` stage; that reads to the app as just another intermediate step and
leaves it waiting for an end that never comes. The box *is* on the network — it just cannot
reach the outside yet, which is the captive-portal case in §12.

**Failure codes:** `WIFI_AUTH_FAILED`, `WIFI_NOT_FOUND`, `WIFI_TIMEOUT`, `WIFI_FAILED`,
plus `BAD_REQUEST` for input the box rejects before trying and `BUSY` for a second attempt
while one is running. A throw inside the box still produces a `failed` stage, so the app
never waits out its 75-second timeout on a bug.

**Picking up after a dropped link.** `net.status` carries `lastConnect` (the most recent
attempt, with its final `stage`, `code` and `message`) and `connecting`. A phone whose BLE
link dropped mid-attempt — which a one-radio box makes likely, since it loses the venue
network partway through — reconnects and reads the outcome instead of starting again.

### 6.7 A profile's name is not its SSID

NetworkManager addresses a saved connection by its **name**, which need not be the SSID it
joins. They match for profiles this code creates — `connectToNetwork()` renames the
candidate to the SSID once it works — but not for one made by hand, not for NM's own
auto-suffixed duplicates (`Joe's Bar 1`), and not for anything an older version left
behind. `nmcli -t -f GENERAL.CONNECTION device show` returns the **name**, and reporting
that as the SSID is wrong in exactly the cases a venue is most likely to hit.

So `net.status.wifi` carries both:

```json
{ "available": true, "iface": "wlp1s0", "state": "connected",
  "ssid": "Joe's Bar", "profile": "Joe's Bar 1", "ip": "192.168.1.45" }
```

`ssid` is what a person reads and what the app puts next to "Forget". `profile` is what
goes back to nmcli. `wifi.saved` reports both for the same reason, and `wifi.forget`
accepts **either**, deleting every profile that matches — NetworkManager keeps several
profiles for one network quite happily, and forgetting a network that returns on the next
boot is not forgetting it.

### 6.8 `wifi.disconnect`

Leaves the current network without forgetting it. Also clears that profile's autoconnect:
without it NetworkManager rejoins within seconds, because `connectToNetwork()` left the
profile at `autoconnect=yes, priority 100`, and a "Disconnect" button that silently undoes
itself reads as broken rather than as a policy. Joining again restores it.

```json
{ "id": 9, "ok": true, "result": { "disconnected": "Joe's Bar", "profile": "Joe's Bar", "stillOnline": true } }
```

`stillOnline` is whether a **wired** default route survives. When it is false this command
has just taken the camera off the internet, which the app should say before the user taps
it rather than after. It is reported rather than refused: Bluetooth is still there, which
is the entire point of onboarding over it.

### 6.9 `register.*`

Agreed with the app 2026-11-10, implemented and verified on `dp-duocast-b1b5`.
**No grant and no `BLE_DEV_NO_AUTH`**: the token is the authentication and the
backend is what checks it. Allowed only while unregistered.

```json
{ "id": 11, "cmd": "register.start", "args": { "idToken": "<firebase id token>" } }
-> { "id": 11, "ok": true, "result": { "accepted": true } }
```

Then `register.progress` events, each sent once, ending in exactly one final
stage:

| Stage | Means | Final |
|---|---|---|
| `netbird` | bringing the VPN up; can take 90 s | |
| `verifying` | asking the backend who this is and what venues they have | |
| `assigning` | binding the camera to the chosen venue | |
| `chooseVenue` | `venues[]`, `assignedVenueId` — **always**, see below | ✅ |
| ~~`needVenue`~~ | never sent over BLE; an empty `venues[]` says the same thing | — |
| `registered` | `venue: {id, name}` | ✅ |
| `failed` | `code` and `message` | ✅ |

**`register.start` never registers anything** (Tim, 2026-11-11). Its final
stage is always `chooseVenue`, even when the account has exactly one venue,
even when the backend returns an `assignedVenueId`, and even when the list is
**empty** — because the app offers "Create a new venue", so nothing is a dead
end. Auto-selecting is what made registration appear to pick a venue name on
its own, which is what this changed.

The web setup page keeps the old behaviour — auto-select the obvious venue,
`needVenue` when there is none — because it has no create option. That is the
`alwaysChooseVenue` flag on `registerWith()`, set only by the BLE path.

`register.venue` answers it, with a **fresh** token so the box never holds one
between steps, and takes either an existing venue or a new one:

```json
{ "cmd": "register.venue", "args": { "idToken": "…", "venueId": 123 } }
{ "cmd": "register.venue", "args": { "idToken": "…",
    "newVenue": { "name": "Corner Pocket", "city": "Denver" } } }
```

`city` is optional. The box validates lightly — a non-empty name of at most 100
characters, a city of at most 100 — and refuses both-at-once rather than making
the backend guess; everything else is the backend's rule. The backend creates a
**private** venue owned by the user, and reuses one they already own with the
same name, so retrying after a dropped BLE link does not leave a trail of
duplicates.

`register.status` returns the last outcome for a phone that lost its link
mid-registration, the same role `net.status.lastConnect` plays for WiFi.
Immediate refusals come back as the reply rather than a stage:
`ALREADY_REGISTERED`, `NO_INTERNET`, `BUSY`, `BAD_REQUEST`.

Codes on `failed`: `REGISTRATION_FAILED`, `AUTH_FAILED`, `NO_INTERNET`. There is
no `SUBSCRIPTION_REQUIRED` — registration does not depend on a plan (2026-11-11).

Every registration response is still run through `subscriptionRefusal()`, and
that is load-bearing for a reason worth not forgetting: asking the question is
what **records** the subscription facts `streamStartGate()` and
`effectiveOverlay()` later read. It no longer refuses anything; it only
decides whether a failure's wording came from a plan refusal, in which case
neutral wording is sent instead of the backend's.

### 6.9 ATT handles must be pinned, or every update strands every paired phone

Diagnosed 2026-11-11 from an ATT error the app finally surfaced: **`0x01` Invalid
Handle**, on the TX subscribe.

BlueZ allocates attribute handles dynamically at `RegisterApplication`, so they move
whenever `dp-ble.py` restarts. Handles seen for the same unchanged service during one
day: `service0006/char0007`, `service001b/char001c`, `service0040/char0040`. An iOS
client that has **bonded** caches the GATT database by handle and does not re-read it, so
the next connect fails on the first subscribe and the only cure is the user forgetting the
box in Settings › Bluetooth.

**Field boxes get software updates.** Without pinning, every update would strand every
paired phone at that venue, with an error the owner cannot act on.

The service and both characteristics therefore declare a fixed `Handle`, which BlueZ
honours (≥ 5.51):

```
0x0040  service        0x0042  TX CCCD
0x0040  TX value       0x0043  RX value
```

Verified by restarting the daemon three times with the central's cache cleared between
each: identical every time, where before they moved on every restart.

Neither **Service Changed** nor the **Database Hash** rescues this, and both are BlueZ's
to send rather than the application's. The reason is structural: an indication cannot
reach a bonded client that is not connected at the moment the database changes, and a
daemon restart is exactly that case.

**The consequence is a constraint with teeth: the GATT layout is now frozen.** Adding or
removing a characteristic shifts the handles and strands every bonded phone once more. New
functionality goes in the JSON over RX/TX — which was always the design, and is now the
rule.

### 6.9a A phone's cached GATT layout outlives the thing that created it

Cost an evening on 2026-11-11, and nothing on the box points at it.

`ble/tools/ble-smoketest.py` deliberately uses the production service and
characteristic UUIDs, so the M0 smoke test exercises the real path. It exposes
them **unencrypted** and at **different attribute handles** from `dp-ble.py`.

iOS caches a bonded peripheral's GATT database and trusts it. A phone that
bonded with a box while the smoke test was running therefore:

- **discovers services successfully** — from its own cache, not from the box;
- **fails on the first write**, because the handle it cached is not the handle
  the real daemon registered.

What makes it expensive to diagnose is that the box looks perfect throughout.
There is no pairing error and no encryption error, because the write never gets
far enough to need a key — `bluetoothd` logs nothing at all. The daemon sees a
connection that never subscribes and never writes, and kicks it 60 s later for
silence, which reads like the box rejecting the phone.

The tell: **the box's pairing agent never logged a pairing for that phone**,
even though the phone is bonded. That means something other than `dp-ble.py`
created the bond.

The fix needs both halves cleared, in this order: forget the device on the
phone first, then `bluetoothctl remove <address>` on the box. The other way
round and the phone re-presents its old keys before the box has forgotten them.

The tool now carries a warning not to run it on a box a real phone will later
pair with. A better long-term answer is a **separate service UUID** for the
smoke test, so a cache built against it can never be confused with the real
service.

### 6.10 A wrong WPA2 password does not reliably say so

Observed on the N100, 2026-11-10. Giving `DigitalPool-85E4` a wrong password produced:

```
Error: Connection activation failed: The Wi-Fi network could not be found
```

Not "Secrets were required". The failed four-way handshake deauthenticates, the AP drops
out of NetworkManager's view, and NM reports the symptom rather than the cause. Taken at
face value the box tells somebody to move the camera closer to a router that is three
metres away, while the actual problem is a typo.

So `_classifyConnectError()` takes a second argument: whether the SSID was in the scan
taken seconds earlier. A network we could see and now cannot join is an auth failure; one
we never saw is genuinely not found.

### 6.11 Versioning

`info.proto` is `1`. Adding commands, fields or events does **not** change `proto`; the
app looks at `info.commands`. Breaking changes raise `proto`, and the app refuses
`proto` values above the highest it knows, with "Update the DigitalPool app".

---

### 6.12 `stream.*` and `camera.*` — PROPOSED, not built

Status: a proposal from the camera side, 2026-11-16, for the app's DuoCast box screen.
Nothing below exists yet. Numbers that constrain the design are measured, not estimated.

**Authorization.** `stream.status` is `scopes: null` — a phone that can connect can read it,
like `info` and `net.status`. `stream.start` and `stream.stop` are `scopes: GRANTED`, the
same bar as `wifi.*`: starting a broadcast from the car park is not a read.

#### `stream.status` → one entry per camera slot

```json
{ "id": 7, "ok": true, "result": { "cameras": [
  { "camera": 1,
    "present": true,
    "state": "streaming",
    "destination": { "kind": "youtube", "url": "rtmp://a.rtmp.youtube.com/live2/ab••••••" },
    "liveSince": "2026-11-16T03:12:44Z",
    "bitrateMbps": 4.8,
    "fps": 30,
    "recording": false,
    "deviceId": "88121",
    "lastError": null },
  { "camera": 2, "present": false, "state": "idle", "destination": null,
    "liveSince": null, "bitrateMbps": null, "fps": null, "recording": false,
    "deviceId": null, "lastError": null }
] } }
```

| Field | Source on the box today |
|---|---|
| `present` | `cameraPresent` logic in server.js — a `/dev/video*` that exists for USB, a configured URL for RTSP/RTMP/NDI |
| `state` | `idle` \| `starting` \| `streaming` \| `recording` \| `error`. Derived from `isStreaming` plus the `preparing`/`started`/`stopped` transitions already emitted to Socket.IO |
| `destination.kind` | `digitalpool` \| `youtube` \| `facebook` \| `rtmp` \| `srt` \| `rtsp`. `youtube`/`facebook` are UI aliases that normalise to `rtmp` in streamController, so the kind has to be read from the saved config, not the running protocol |
| `destination.url` | **Masked** by `redactStreamKey()`. The last path segment is the credential |
| `recording` | `recordingManager.isRecording()` |
| `deviceId` | `remote.json` `devices[]`, matched on camera index |
| `bitrateMbps`, `fps` | **New work.** Both are emitted as events and never stored; the box must keep the last value per camera |
| `liveSince`, `lastError` | **New work.** Neither is retained today |

`lastError` is the operator-facing text, not an exit code — the same string the UI gets.
Tonight's real one, for shape: `"The streaming destination refused the connection. The
server said: Connection failed: Application folder (…/applications/restream) is missing."`

#### `stream.state` event

```json
{ "event": "stream.state", "data": { "camera": 1, "state": "error",
  "lastError": "…", "bitrateMbps": null } }
```

Pushed on every transition, and on a bitrate change no more than once every 5 s — a
notification costs 10 ms of airtime (see below), and a per-second bitrate tick on two
cameras would use a sixth of the link for a number nobody reads that fast.

#### `stream.start` / `stream.stop` `{ camera: 1|2 }`

Both return the **resulting** state, not an ack. Starting is asynchronous and can fail
seconds in — tonight's RTMP rejection surfaced 1.4 s after spawn — so the handler waits for
the pipeline to reach `started` or `error`, up to **15 s**, and returns whichever happened:

```json
{ "id": 9, "ok": true, "result": { "camera": 1, "state": "streaming", "liveSince": "…" } }
{ "id": 9, "ok": false, "error": { "code": "STREAM_FAILED", "message": "<lastError>" } }
```

A 15 s wait is safe: §6.3 already allows requests to be outstanding concurrently and
responses to return out of order. New error codes: `STREAM_FAILED`, `NO_CAMERA`,
`ALREADY_STREAMING` (not an error for `stop`, which is idempotent).

#### `camera.snapshot` — do not build this yet

Not at the current framing. Measured, from `ble/dp-ble.py`:

- `TX_PACING_MS = 10` — one notification every 10 ms.
- TX body = `negotiated_mtu() - 3 - CHUNK_HEADER` = `23 - 3 - 3` = **17 bytes**.
- Throughput is therefore **1,700 bytes/second**, and §6.2's 255-chunk ceiling caps one
  message at **4,335 bytes**, about **2.6 s** on the wire.
- JSON cannot carry binary, so a JPEG costs another 4/3 in base64: the largest image that
  fits a single message is **~3.2 KB**.

A 320×180 JPEG is 8–20 KB. It does not fit, and would not fit if the cap were raised —
15 KB at 1,700 B/s is **8.8 s**, nearly 12 s after base64, per frame.

The blocker is `negotiated_mtu()` returning 23, which is deliberate and documented above:
there is no source on the box for the true notification MTU short of **`AcquireNotify`**.
That is the prerequisite. With a real MTU near 247 the body is 241 bytes — 14× — and
`AcquireNotify` also replaces `PropertiesChanged` with a socket, so the 10 ms pacing can
go. A 15 KB snapshot then lands in well under a second. **Do `AcquireNotify` first, with a
phone to test against; revisit the snapshot after.**

#### Live preview over the LAN — use this instead

The box already serves, all cleartext, nothing on 80 or 443:

| Port | What |
|---|---|
| 8888 | MediaMTX **HLS** |
| 8889 | MediaMTX **WHEP** (WebRTC, what the web UI uses, proxied over Socket.IO) |
| 8554 | RTSP |
| 3000 | the app's own HTTP server |

HLS on 8888 is the one to use from a phone: a plain URL, no signalling, and it plays in
both platforms' native players. Latency is a few seconds, which is fine for "is the camera
pointed at the table".

**The cleartext problem is the app's to solve, not the box's.** A box on a venue LAN has a
private IP, and no CA will issue a certificate for `192.168.1.10`; a self-signed cert makes
it worse, not better, by training people through a warning. Both platforms already have the
intended exception for exactly this case:

- Android: a `network_security_config.xml` permitting cleartext to private ranges only.
- iOS: `NSAllowsLocalNetworking` under ATS.

This applies to `web.link` too, which hands back `http://<lan-ip>:3000/…` and has the same
constraint today.

`stream.status` should carry the URL so the app never builds it:

```json
"preview": { "hls": "http://192.168.1.10:8888/live/index.m3u8", "lanOnly": true }
```

Omitted entirely when the box has no LAN address. It is **not** behind the handoff token —
that token authenticates a *login*, and a preview stream is not a login. If the preview
needs protecting, that is a separate decision about MediaMTX, not a reuse of this token.

## 7. Authentication

### 7.1 Threat model

Anyone within about 30 m can connect with a generic BLE app (nRF Connect, for example).
Without auth they could:

- Point the camera at their own WiFi.
- Take it off the network in the middle of a match.
- Register it to their own account.

Physical access to the box isn't a concern for this design: whoever holds the box can
already re-image it.

### 7.2 Grants

A **grant** is a compact JWS (EdDSA / Ed25519) issued by the DigitalPool backend to the
signed-in app user:

```json
// header
{ "alg": "EdDSA", "typ": "dp-device-grant", "kid": "2026-11" }
// payload
{
  "v": 1,
  "sub": "<firebase uid>",
  "email": "owner@venue.com",
  "name": "Display Name",
  "scope": "claim",              // "claim" | "manage"
  "mac": "a8:b8:e0:01:a1:b2",    // the device's primary MAC, from info
  "nonce": "<from auth.challenge>",
  "iat": 1762700000,
  "exp": 1762700600,             // 10 min
  "jti": "<uuid>"
}
```

The device accepts a grant when **all** of these hold:

1. The signature verifies against a public key in `ble/grant-keys.json` (`{ kid: pem }`).
   That file ships in the repo/image, so the check works **offline**. Several `kid`s can
   be listed at once, which allows key rotation.
2. `mac` equals `getPrimaryMac()`.
3. `nonce` equals the nonce this BLE connection got from `auth.challenge`. That makes it
   fresh without trusting the box's clock; RK3588 boards may have no RTC battery.
4. `exp` is in the future, **only if** the clock is NTP-synced
   (`timedatectl show -p NTPSynchronized`). Otherwise this check is skipped and the nonce
   provides freshness.

On success, the connection holds that scope until it disconnects. Grants are checked by
Node (`crypto.verify` with an Ed25519 key, built in, no dependency). Five failed
`auth.grant` calls on one connection → `RATE_LIMITED`, then `kick`.

### 7.3 What needs what

| Command | No grant | `claim` | `manage` |
|---|:-:|:-:|:-:|
| `info`, `auth.challenge`, `auth.grant`, `net.status` | ✅ | ✅ | ✅ |
| `wifi.scan` | ✅ | ✅ | ✅ |
| `hotspot.start` | recovery window only (§7.4) | ✅ | ✅ |
| `wifi.connect`, `wifi.saved`, `wifi.forget`, `hotspot.stop` | ❌ | ✅ **only while unregistered** | ✅ |
| `register.start`, `register.venue` | ❌ | ✅ **only while unregistered** | ❌ (re-registering means deregistering in the web UI first) |
| `web.link` | ❌ | ✅ **only right after this connection registered the box** | ✅ |
| `device.reboot` | ❌ | ❌ | ✅ |

**Who the backend gives which scope to** (backend rules, §11.1):

- **`claim`:** any signed-in user, for a MAC that is **not** currently registered. The
  backend can see that from its device records. The subscription check still happens at
  registration, as it does today.
- **`manage`:** only users allowed to manage the device registered under that MAC: the
  registering account, plus admins of its venue if the backend models venue staff.

So a stranger with the app can see that a box exists and read its network status, but
can't change it.

### 7.4 ~~Recovery window~~ — removed

This existed for one purpose: letting `hotspot.start` run without a grant, so an owner
whose phone had no internet (and so could not fetch a grant) could still get a hotspot up
at a venue whose WiFi had changed.

With D6 reversed there is no `hotspot.start` to permit, so the window is gone.
`_inRecoveryWindow()` returns false under `ble`, and **advertisement state bit 3 is always
0** there — reporting it would have the app offering a recovery route that does not exist.

Nothing is lost. The case it covered is the case Bluetooth is best at: a box with no
working network is still discoverable, connectable and configurable, because BLE needs no
network. The grant is the open question in that scenario, not the transport — see §14.4.

### 7.5 What an ID token costs, and why it was accepted anyway

The app sends the signed-in user's Firebase ID token over BLE and the box
forwards it to `registerCameraDevice`. Tim chose this over grants on
2026-11-10, knowing the trade-off. Writing it down so the next person weighing
it has the real numbers rather than a vague unease.

**What an attacker gets.** Stand up a device advertising our service UUID with
a plausible name. It appears in the app's "Nearby Unregistered Boxes". The user
taps it, walks the setup flow, and at `register.start` hands over a Firebase ID
token for their DigitalPool account — valid up to an hour, usable against any
backend API that accepts one, from anywhere. It is **not** scoped to this
camera, this MAC, or this operation.

Compare §7.2's grant: bound to one MAC, one connection nonce, ten minutes, and
useless anywhere else. That is the difference, and it is the whole of it.

**Why it is nevertheless reasonable for now:** it requires physical proximity
and a user who completes a setup flow against a device that is not theirs; the
BLE link is encrypted, so the token cannot simply be sniffed; and the same
person's password would be worth far more, which is what the previous flow
asked them to type. The exposure is a strictly better position than typing
`admin`/`Digitalpool` into a phone on a venue's WiFi.

**What the device does to limit its own part:**

- The token is used for the call and dropped. It is never written to
  `remote.json` or anywhere else, and never returned by `register.status`.
- **It is never logged** — not in the journal, not in an error, not in a
  `BAD_REQUEST` message. A camera's journal is read by support. Verified on the
  bench: after a full registration attempt, zero occurrences anywhere in the
  journal or on disk.
- A shape check (`looksLikeIdToken`) refuses anything that is not a plausible
  JWT before putting it on the wire. It is not a validity check — only the
  backend can do that — it just stops the box forwarding arbitrary bytes that
  arrived over Bluetooth.
- The app sends a **fresh** token for `register.venue` rather than the box
  holding one between steps.

**When to replace it with grants:** when a camera is worth stealing an account
for, or when the fleet is large enough that a fake box at a venue is a
plausible attack rather than a theoretical one. The BLE contract does not have
to change — `register.start` grows a `grant` field and the token becomes
optional.

---

## 8. Network handling (device)

### 8.1 Onboarding mode

New `.env` key: **`ONBOARDING_MODE=auto|ble|hotspot`**.

- `auto` (new images): `ble` if `bluetoothctl show` finds a controller within 20 s of
  start, otherwise `hotspot`.
- `ble`:
  - The onboard WiFi chip is a **client**.
  - The hotspot profile exists but `autoconnect=no`.
  - Captive-portal iptables rules are installed only while the hotspot is up.
  - `digitalpool-ble.service` is enabled.
- `hotspot`: today's behaviour, unchanged. `digitalpool-ble.service` is disabled.

**Migration** (`migrations/00NN-onboarding-mode.sh`): on a device that already has
`remote.json`, `users.json` or a client WiFi profile, write `ONBOARDING_MODE=hotspot` if
the key is missing. A fresh image ships `ONBOARDING_MODE=auto`. Switching an existing box
to BLE is a deliberate admin action (System → Network → "Onboard WiFi: hotspot / internet")
because it removes the hotspot that a venue tablet may be using.

### 8.2 `wifiManager.js` changes

- **Interface roles.** Today: `wifiIface` = onboard = AP, `clientIface` = dongle. In `ble`
  mode the roles invert — **the best radio is the client, and the AP goes wherever is
  left**:

  | Radios present | Client (internet) | AP (on-demand hotspot) |
  |---|---|---|
  | Onboard only | onboard | the same radio, when asked (§8.3) |
  | Onboard + USB dongle | **the dongle** | onboard |

  The dongle rule is the reverse of what this document first said, and the reason is the
  product decision in §3.1: once BLE carries onboarding, a dongle is no longer there to
  free up the onboard chip — it is there because somebody wanted **WiFi 6**, which neither
  onboard radio has. Putting the AP on the dongle would waste exactly the radio they paid
  for. So the dongle takes the client role, the onboard chip keeps the hotspot, and on the
  N97 that also sidesteps §3.3 entirely: two radios, so the hotspot never costs the
  internet.
- **✅ The shell injection is gone** (done 2026-11-10). `connectToNetwork()` used to build
  an `nmcli` string with `ssid` and `password` pasted inside double quotes, so a crafted
  password ran commands as `dp`. Every call carrying user input now goes through
  `_runArgs()`, which is `execFile` with an argument array and no shell. Verified on the
  bench: `a";touch /tmp/dp-pwn;#` as an SSID and as a password both arrive at
  NetworkManager as literal strings and create no file.
- **Validate inputs.**
  - SSID: 1–32 bytes.
  - PSK: 8–63 printable ASCII, or exactly 64 hex characters.
  - Open networks: no PSK.
- **Security type.** Choose `key-mgmt` from the scan result: `wpa-psk`, `sae` (WPA3), or
  none (open). For WPA2/WPA3 transition networks use `wpa-psk`; NetworkManager negotiates.
  For `hidden: true`, set `802-11-wireless.hidden yes`.
- **Don't remove the working network before the new one works.** Today the method deletes
  the profile named after the SSID before adding it. Instead:
  1. Add the new profile under a temporary name.
  2. Bring it up.
  3. If it succeeds, rename it and lower the old profiles' autoconnect priority.
  4. If it fails, delete only the new profile.
- **Report connect stages** as events: `associating` → `authenticating` → `dhcp` → `online`
  (a successful `checkInternetCached({fresh:true})`). Or `failed`, with a reason:
  - NM reason "secrets required" / "no secrets" → `WIFI_AUTH_FAILED`
  - SSID not in scan → `WIFI_NOT_FOUND`
  - no IP within 45 s → `WIFI_TIMEOUT`
- **Routing priority:** Ethernet stays preferred over WiFi (route metric 100 vs 600, the NM
  default). `net.status` reports both. Confirmed on the bench: a box on both had
  `default via … dev enp2s0 metric 100` ahead of `… dev wlp1s0 metric 600`.
- **The hotspot profile must not autoconnect in `ble` mode.** `dp-hotspot.sh` standing down
  is not enough — NetworkManager's own autoconnect is a separate mechanism, and the profile
  shipped at `autoconnect=yes, priority 100`, which is high enough to beat the venue
  network it had just been told to join. `wifiManager` now forces that profile to
  `autoconnect=no, priority 0` whenever it starts in `ble` mode.
- **Review** `network-watchdog.sh` and `dp-hotspot.sh` for assumptions that the onboard
  chip is the AP.

### 8.3 ~~On-demand hotspot~~ — not built, by decision

D6 is reversed: under `ble` the camera never runs a hotspot. `hotspot.start` and
`hotspot.stop` do not exist, and `wifiManager._startAP()` refuses outright when
`ONBOARDING_MODE=ble`.

That guard sits at `_startAP()` rather than at each caller on purpose. Four separate paths
reach it — the 30-second AP health monitor, the rollback after a failed join,
`updateAPConfig()` from the admin API, and the Mode B fallback in `startMonitor()` — and
any one of them getting it wrong would put a WPA2 access point on the air at a venue that
is not expecting one. `dp-hotspot.sh` also stands down at boot (migration `0030`), and the
AP profile is forced to `autoconnect=no, priority 0` so NetworkManager cannot bring it up
either.

**The one thing this gives up** is the fallback in §10 step 6 and §12: a venue whose router
has **client isolation** turned on, where the phone and the camera are both on the WiFi but
the router will not pass traffic between them. The box is online and streaming perfectly;
the phone just cannot open its web UI. See §14.4 — this needs an answer, and the hotspot
was a poor one anyway (it required the user to leave the venue network to use it).

---

## 9. Registration and web handoff (device)

### 9.1 Refactor first

`/api/setup/register`, `/api/setup/register/venue` and `finalizeRegistration()` write
straight to `res`, so BLE can't call them. Move the logic into plain async functions that
return a result object, and keep the HTTP routes as thin wrappers:

```js
// registration.js (new) — returns { state: "registered"|"chooseVenue"|"needVenue"|"refused", … }
async function registerWith(credentials /* {email,password} | {grant} */, { venueId } = {})
```

The function keeps today's ordering:

1. Bring NetBird up.
2. Call `registerCameraDevice`.
3. Run `subscriptionManager.classifyRegistration()` **before** treating `ok:false` as an
   auth failure.
4. Persist the identity (`userId`, `ownerEmail`, venue).

The only differences for a grant are that the action is `claim` instead of
`verify`/`assign` (§11.2), and that `ownerEmail`/`userId` come from the response, or from
the grant if the response lacks them.

### 9.2 One-time login link — **built 2026-11-10**

Implemented and verified on `dp-duocast-b1b5`. What was built differs from the sketch
below only in carrying the port (`:3000`) until §9.3 lands, and in the identity, which is
a placeholder until grants arrive.

**What makes a password-free admin login safe enough to ship:**

- **A token is only ever minted over BLE.** There is no HTTP route that issues one, so
  reaching the box over the network is not sufficient to obtain one — you must be in
  Bluetooth range, paired, and past the scope check.
- **32 random bytes.** Guessing is not the threat; the short life and single use are about
  a link leaking *after* it is created — a screenshot, an in-app browser's history,
  somebody reading over a shoulder.
- **In memory only.** A restart invalidates every outstanding token. For something this
  powerful that is the right default.
- **Single use and 120 seconds**, whichever comes first. The token is deleted on lookup
  even when it turns out to be expired, and an opportunistic sweep removes stale entries
  whenever a new one is minted.
- **Gated like a write command.** `web.link` carries the `claim`/`manage` scopes, so until
  M3 it answers only when `BLE_DEV_NO_AUTH=1` (§14.2). Without the flag a stranger in
  range gets `NOT_AUTHORIZED` rather than an admin session on a box in a bar.

Verified: following the link sets a session and redirects to `/`; `/api/auth/me` then
returns `{"username":"app","displayName":"DigitalPool app","role":"admin",
"forcePasswordChange":false,"via":"app"}`; an admin API answers 200; reusing the same
token redirects to `/login?handoff=expired` and leaves no session.

The identity is a placeholder (`app` / `DigitalPool app`) because nothing yet carries a
real one. **M3 replaces it with the grant's `sub`/`email`/`name`** — that is the one change
still owed here.

#### The original design

`web.link` makes a random 32-byte token, keeps it **in memory** for **120 s**, valid
**once**, tied to the grant's `sub`/`email`/`name`. It returns:

```json
{
  "urls": [
    { "kind": "lan",     "url": "http://192.168.1.57/auth/handoff?t=…" },
    { "kind": "hotspot", "url": "http://192.168.50.1/auth/handoff?t=…" }
  ],
  "expiresIn": 120
}
```

- `lan` is listed only when the box has a LAN IP.
- `hotspot` is listed only while the hotspot is up.

New route `GET /auth/handoff?t=…`:

1. Validate and consume the token.
2. Set `req.session.user = { username: <email>, displayName, role: "admin",
   forcePasswordChange: false, via: "app" }`.
3. Redirect to `/`.

An invalid or expired token redirects to `/login?handoff=expired`. The login page then
says: "Open the camera again from the DigitalPool app".

Every `requireAuth`/`requireAdmin` check and the Socket.IO session handling work unchanged,
because they only read `req.session.user`. ✅ **Checked:** the password-change endpoints do
assume the user exists in `users.json`, and an app session's `app` is not in there, so
`/api/users/app/password` would fail with "user not found". The Change Password form is
therefore hidden for `via: "app"` sessions, the forced-password-change banner is
suppressed for them (there is no local password to change, so the prompt would be a dead
end), and the header shows the app identity's display name. Nothing else reads
`session.user.username` against `users.json`.

### 9.3 Ports: serve the UI on 80 directly; 443 once there is a real certificate

**Why 3000 and 3443 exist at all.** Nothing else on the box uses 80 or 443:

- MediaMTX is on 8554/8890/8889.
- SRT is on 8891/8892.
- No nginx or other web server is installed.

The odd ports are there only because Node runs as the unprivileged user `dp`, and Linux
lets only root bind ports below 1024. The hotspot hides that with iptables redirects
(80→3000, 443→3443; `wifiManager.js:428`, `dp-hotspot.sh:203`), but only on the hotspot
interface. And 3443 isn't really the admin UI: it's a self-signed listener whose only job
is answering iOS captive-portal checks (`server.js:6582`).

**v1: listen on 80 directly.**

- Add `AmbientCapabilities=CAP_NET_BIND_SERVICE` to `digitalpool-camera.service`, and in
  `server.js` listen on **80 as well as `PORT`**, so existing `:3000` bookmarks and links
  keep working.
- That gives `http://192.168.1.57` on every interface without iptables state to keep in
  sync. The hotspot's 80→3000 redirect becomes unnecessary; its 443→3443 redirect stays
  for the iOS captive probe.
- Some locked-down guest networks really do allow only 80/443 between devices.

**Changing ports doesn't fix client isolation.** Venue routers almost never filter by port
between devices on the same LAN. When a phone can't reach the box, it's nearly always
client isolation, which blocks **every** port, 443 included. The fix for that is the
hotspot fallback (§10, step 6).

**Why not 443 now.** No port conflict. The problem is the certificate:

- HTTPS on 443 with the self-signed cert gives a full-page "Your connection is not
  private" warning on every phone, worse than plain HTTP.
- Plain HTTP on port 443 breaks whenever a browser assumes `https://`.

443 becomes the right answer with a **publicly trusted certificate per device**, in the
style of Plex's `*.plex.direct`:

- A DigitalPool-owned domain resolves `<ip-dashed>.<device-id>.cam.digitalpool.com` to the
  LAN IP.
- The backend issues a Let's Encrypt cert through DNS-01.

Then `web.link` returns that `https://` URL, and the plain-HTTP session cookie (§12) goes
away too. Worth doing, but as its own project after v1.

### 9.4 The shared admin password

Today the box sits on its own WPA2 hotspot. After this change it sits **on the venue's
network**, where anyone on the bar WiFi can reach the login page, and `admin` /
`Digitalpool` is the default.

When a box is **registered through BLE**, Node replaces the `admin` password with a random
one that is never shown. People get in through the app handoff. A "Set a local password"
action in the web UI (for `via: "app"` sessions) brings back browser-only access for
anyone who wants it. `dpadmin` (support) is unchanged.

---

## 10. App flow

```
[Cameras] ─ "Add camera" ─▶ [Scan] ─ tap box ─▶ [Connecting/pairing] ─▶ [Network] ─▶ [Register] ─▶ [Open camera]
                                                                             │              │
                                                         Ethernet online ────┘ skip         └─ already registered to you → [Open camera]
```

1. **Scan.**
   - Filter on the service UUID.
   - List each box by local name, showing its `state` bits: "New", "Online", "Registered
     to a venue".
   - Sort by RSSI.
   - **There is no label to read it off** (decided 2026-11-10, §13). Boxes are told
     apart by RSSI order and by the four hex digits in the name, which is the only
     identifier in the advertisement. In a room with one box being set up this is fine;
     in a room with several, "hold the phone next to the one you mean" is the only
     disambiguator the app has.
2. **Connect.**
   - Connect, request MTU (Android), discover the service, subscribe to TX.
   - Send `info`. The first encrypted write triggers the OS pairing prompt; tell the user
     to accept it.
   - Then `auth.challenge` → backend `issueDeviceGrant` → `auth.grant`. Scope: `claim` if
     `info.registered` is false, otherwise `manage`.
   - If the backend refuses `manage`, show: "This camera is registered to another
     account."
3. **Network.**
   - If `net.status.internet` is true already (Ethernet or saved WiFi), skip to step 4.
   - Otherwise `wifi.scan` → the user picks a network and enters the password →
     `wifi.connect`.
   - Show the `wifi.progress` stages, and the error text for `WIFI_AUTH_FAILED` and the
     others.
4. **Register** (unregistered boxes only).
   - `register.start` → `register.progress` events: `netbird` (can take up to 90 s),
     `verifying`, `assigning`.
   - On `chooseVenue`, show the list → `register.venue`.
   - On `needVenue`, send the user to create a venue in the app, then retry.
   - There is no subscription step. Registration never refuses for plan reasons, and
     nothing here mentions plans, pricing or Enterprise (2026-11-11).
5. **Open camera.**
   - `web.link`.
   - The **phone must be on the same network as the box**. If the app knows the phone
     isn't on WiFi, say "Join *Joe's Bar* WiFi on this phone" first.
   - Probe reachability with `GET {lan}/api/ping`, 3 s timeout. ✅ **Built
     2026-11-10** — unauthenticated, 63 bytes, ~4 ms:
     `{"ok":true,"name":"DP-DuoCast-B1B5","shortId":"b1b5","proto":1}`.

     **Compare `shortId` against the one from `info`.** A LAN address is a
     lease, not an identity: by the time somebody taps "Manage Device" the
     router may have given that IP to a different device. The next thing the
     app does is hand a one-time admin login to whatever answers, so it should
     confirm it is talking to the right camera first. A mismatch means the
     address is stale — re-read `net.status` over BLE rather than opening it.
   - Open the URL in an **in-app browser tab** (`SFSafariViewController` / Chrome Custom
     Tabs). That supports Socket.IO and WebRTC (WHEP preview), and the handoff token
     carries the login in.
6. **Unreachable** (client isolation, or the phone stuck on cellular).
   - First, the cheap causes: the phone is on cellular rather than the venue WiFi, or on a
     guest SSID while the camera is on the main one. Tell the user which network the
     camera is on — the app has it from `net.status` — and ask them to join that one.
   - If the phone *is* on the same network and still cannot reach the box, that is
     **client isolation**, and there is no answer in v1 (§14.4). The hotspot fallback that
     used to live here is gone with D6.
   - The camera is fine in this state: it is online, and it streams. Only the web UI is
     unreachable from this phone. Say that, rather than implying setup failed.

`register.start` and `wifi.connect` return `accepted` straight away and finish in the
background. If the phone loses BLE in the middle, it reconnects and calls `net.status`, or
the new `register.status`, to pick up where it left off.

### App platform notes

| | iOS | Android |
|---|---|---|
| Library | `react-native-ble-plx` — `digitalpool-app` is **React Native 0.79 / Expo SDK 53** with `expo-router`, and it already builds custom native code (`modules/match-camera`, three config plugins), so a dev-client build is routine. Expo Go cannot load it. | same |
| Permissions | `NSBluetoothAlwaysUsageDescription`; **`NSLocalNetworkUsageDescription`** (the LAN reachability probe and the web UI on a LAN IP need it; without it the iOS 14+ local-network prompt never shows and requests fail silently) | API 31+: `BLUETOOTH_SCAN` (`neverForLocation`), `BLUETOOTH_CONNECT`. API ≤ 30: `ACCESS_FINE_LOCATION`, needed for BLE scanning on older phones |
| MTU | automatic | `requestMtu(517)` after connect |
| Gotchas | GATT layout is cached per address. BlueZ exposes Service Changed, so updated firmware is noticed. | Serialise **all** GATT operations (one in flight). Retry connect on status 133 up to 3× with 500 ms backoff. Call `refresh()` on the GATT cache if the service isn't found. |
| Joining hotspot | not needed — D6 reversed, there is no hotspot to join | same |

---

## 11. Backend contract

### 11.1 New callable: `issueDeviceGrant`

Authenticated as the app's signed-in Firebase user.

```
request:  { "mac": "a8:b8:e0:01:a1:b2", "nonce": "…", "scope": "claim" | "manage", "deviceName": "dp-stream-a1b2" }
response: { "ok": true, "grant": "<jws>" }
          { "ok": false, "error": "…", "code": "DEVICE_REGISTERED_ELSEWHERE" | "NOT_DEVICE_MANAGER" | "BAD_REQUEST" }
```

- **`claim`:** refuse with `DEVICE_REGISTERED_ELSEWHERE` if a device record with this MAC
  is registered to a **different** user. Same user → allow (re-running setup).
- **`manage`:** allow only if the caller registered the device, or administers its venue.
- Sign with the Ed25519 private key from Secret Manager. Publish the public keys
  (`{ kid: pem }`) in this repo as `ble/grant-keys.json`.
- Log every grant issued (user, mac, scope).

### 11.2 `registerCameraDevice` — new action `claim`

```json
{ "action": "claim", "grant": "<jws>", "deviceName": "…", "macAddress": "…",
  "netbirdIp": "100.x.y.z", "local_ip": "…", "venueId": "<optional>" }
```

- Verify the grant: signature, `scope == "claim"`, and `mac == macAddress`. A grant may be
  used for both steps until `exp`.
- **Without `venueId`:** behaves like `verify` for the grant's user. Return `user_id`,
  `venues`, `assigned_venue_id`, and `subscription` exactly as `SUBSCRIPTION_CHECK.md`
  describes.
- **With `venueId`:** behaves like `assign`. Return `venue_id`/`venue_name`/`venue_slug`/
  `device_id`/`user_id`/`subscription`.
- Also return `email` and `display_name`, which the device stores as `ownerEmail`.

`verify`/`assign` with email + password stay supported for `hotspot`-mode devices and the
web UI.

### 11.3 Dev keys (unblocks device and app work before the backend lands)

- `ble/tools/mint-grant.js --mac … --nonce … --scope claim` signs with a **dev** key from
  `ble/dev-key.pem` (git-ignored, generated by the script on first run).
- Devices accept the dev `kid` only when `.env` has `BLE_ACCEPT_DEV_GRANTS=1`. That flag is
  **never** set in images; `dp-create-image.sh` should refuse to capture a device that has
  it.
- Until §11.2 exists, `claim` registration can be stubbed in the app flow by registering
  through the web UI with email + password.

---

## 12. Known limits and later work

- **Venue WiFi with a captive-portal login:** the box joins but has no internet, so
  `register.start` returns `NO_INTERNET`. v1 answer: Ethernet, the dongle, or a phone
  hotspot. The old "show the portal page through our own hotspot" idea is gone with D6.
- **Plain HTTP on the venue LAN:** session cookies cross the bar's WiFi unencrypted. That
  was already true on the hotspot, but the hotspot was WPA2 and only reached the box. The
  per-device trusted certificate (§9.3) fixes this.
- **WPA2-Enterprise:** not supported.
- **Second phone:** gets no connection while one is connected (D8). The 60-second silent
  kick and the 5-minute idle kick bound the wait (§5.3).
- **Client isolation has no fallback.** See §14.4.
- **A refused iOS local-network permission is indistinguishable from client
  isolation** from inside the app: both are a silent timeout on a LAN address.
  `NSLocalNetworkUsageDescription` must be present, and the app's "cannot reach
  the camera" copy has to offer the permission as a cause alongside the router.
  Raised by the app side 2026-11-10.

---

## 13. Image and factory changes

- `dp-restore.sh` / golden image:
  - `bluez` + `rfkill` installed, `main.conf` (§4.1) and the D-Bus policy (§4.2) — all
    three are done by `migrations/0028-bluez-stack.sh`, so an image captured from a box
    that has run its migrations already has them. `digitalpool-ble.service` is enabled by
    the migration that ships the daemon.
  - `ble/grant-keys.json` present.
  - `ONBOARDING_MODE=auto`.
- `dp-firstboot.sh`: nothing new. The device name and MAC it already sets are the BLE
  identity.
- **No label.** Decided 2026-11-10: boxes ship with no printed name, sticker or QR code.
  Nothing in the device or factory flow should assume one, and `FACTORY_INSTALL.md` does
  not need a labelling step.

  Two consequences, neither blocking:

  1. **Telling boxes apart in a room** is down to RSSI order and the four hex digits in
     the advertised name. Fine for one box; "hold the phone next to the one you mean" for
     several.
  2. **There is no out-of-band way to confirm which box you are talking to**, and that is
     the check that would have caught the fake-box attack in §7.5. A label let somebody
     read `DP-DuoCast-B1B5` off the unit in their hands and pick that exact entry; without
     one, the app offers a list and the user takes what looks right. It does not change
     the attack's difficulty much — it still needs a malicious device present during
     setup, and a user would have had to actually check the label — but it does remove the
     only defence that did not depend on the protocol. Worth remembering as an argument
     for grants (§7.2), which make the question moot: a grant is bound to a MAC, so a
     token handed to the wrong box is useless.
- `CLAUDE.md` / `README.md`: document the new service and the mode switch.

---

## 14. Work plan

Three tracks run in parallel after M1. The protocol in §6 is what they meet on.

| Milestone | Device (this repo) | App | Backend |
|---|---|---|---|
| **M0** hardware spike | ✅ **Done on both Intel boards (2026-11-10, §3)**: BT 4.2 with `hci0` up on every box and no firmware to ship; `migrations/0028-bluez-stack.sh` installs the stack; `ble/tools/ble-smoketest.py` proves advertise → connect → write → notify on both radios (§3.6). AP+client works on the N100 and is impossible on the N97. Still open: Rock 5C, the N100 AP+client bench test, and a real phone. | ✅ `react-native-ble-plx` (Expo SDK 53 dev client) | — |
| **M1** read-only BLE | ✅ **Done and running on `dp-stream-b1b5` (2026-11-10, §14.1)**: migrations `0028`/`0029`, `ble/dp-ble.py`, `bleBridge.js`, `digitalpool-ble.service`, commands `info`, `net.status`, `wifi.scan`, and `ble/tools/dpble-cli.py`. | Scan list with state bits; connect, pairing, `info` | Ed25519 keypair; publish `grant-keys.json` |
| **M2** WiFi | ✅ **Done (2026-11-10)**: `execFile` rewrite and validation (§8.2), `wifi.connect`/`wifi.saved`/`wifi.forget` with real NM progress stages (§6.6), `ONBOARDING_MODE` honoured by the app *and* by `dp-hotspot.sh` at boot (migration `0030`), onboard chip as client. **Not done:** grants, so the write commands sit behind `BLE_DEV_NO_AUTH` (§14.2). | Network screen | — |
| **M3** auth + registration | ✅ **Registration done 2026-11-10** by a different route than planned (§6.9, D4): the `registerWith()` refactor landed in `server.js` rather than a new `registration.js`, and `register.start`/`register.venue`/`register.status` work over BLE using the app's Firebase ID token. **Grants are NOT done** — the scope table, `grant-keys.json` and `BLE_DEV_NO_AUTH`'s removal all remain (§7.5). | ✅ register screens, venue picker | ID token accepted by `verify`/`assign`; `issueDeviceGrant` still outstanding |
| **M4** handoff | ✅ `web.link` + `GET /auth/handoff` (§9.2), gated behind `BLE_DEV_NO_AUTH` until M3 supplies an identity. **Still to do:** `/api/ping`, port 80 (§9.3), the random admin password (§9.4), the on-demand hotspot (§8.3). | ✅ Reachability probe, in-app browser; hotspot join fallback outstanding | — |
| **M5** ship | Image changes (§13), docs | Store release | Production keys |

### 14.1 What M1 gives the app today

Running on `dp-stream-b1b5` and exercised from a second box with
`ble/tools/dpble-cli.py`. The app can build against all of this now.

**Advertisement.** Local name `DP-DuoCast-B1B5`, service UUID as §6.1,
manufacturer data `01 13 b5 b1` — proto 1, state bits `registered | internet |
hotspot`, shortId `b1b5`. The state bits update live: the hotspot coming up
moved them from `0x03` to `0x13` within a few seconds, with no reconnection.

**Pairing.** Just Works, LE Secure Connections (`LegacyPairing: no`). A central
with no pairing agent hangs instead of failing, which is worth knowing while
testing from a laptop — a phone always has one, and shows the system prompt
§6.1 describes.

**Commands.** `info` returns both names, the MAC, the board model, the
registration state and the venue; `net.status` returns ethernet, wifi, hotspot,
`internet` and which interface is preferred; `wifi.scan` returns the networks
and, when the list is empty, a `reason` and a `message` saying why.

**Framing.** Verified at **MTU 23**, the worst case — a 21-byte request went as
two chunks and reassembled correctly. A phone will negotiate far more.

**Resilience.** Observed, not just written: Node restarting logs
`Node went away — answering UNAVAILABLE`, reconnects about 7 s later and the
box never stops advertising. Killing the daemon has it back, re-registered and
advertising, in under 4 s.

**Two things a scan right after a restart will see.** Re-registering an
advertisement leaves a gap of a second or two; a scan that starts inside it
finds nothing and the next one succeeds. The app should treat one empty scan as
normal and retry rather than telling the user the camera is gone.

**Still untested:** `systemctl restart bluetooth` recovery (§5.3) — the code
watches `NameOwnerChanged` and re-registers, but restarting bluetoothd needs
root, which the app user does not have. Run it by hand on a bench box.

### 14.2 `BLE_DEV_NO_AUTH` — the thing to remove in M3

`wifi.connect`, `wifi.saved` and `wifi.forget` declare the `claim`/`manage` scopes §7.3
gives them. Grants are M3, so there is nothing yet that can satisfy those scopes, and the
commands refuse by default — a camera that let any passer-by retarget its WiFi would be
worse than one that cannot be set up yet.

`BLE_DEV_NO_AUTH=1` in `.env` turns that refusal off so the device and app can be built
against each other before the backend exists. It logs a warning on every start:

```
🔵 BLE: !!! BLE_DEV_NO_AUTH=1 — anyone in radio range can change this camera's network
```

Same rule as `BLE_ACCEPT_DEV_GRANTS` (§11.3): **never on a shipped box**, and
`dp-create-image.sh` should refuse to capture a device that has it. M3 deletes the flag.

### 14.4 Client isolation now has no fallback

The cost of reversing D6, written down so it is a decision and not an oversight.

A venue router with **client isolation** (also sold as "AP isolation" or "guest mode")
passes traffic between a device and the internet but not between two devices on the same
SSID. The camera is online and streaming; the phone simply cannot open
`http://192.168.1.45:3000`. It blocks **every** port, so §9.3's move to port 80 does not
help, and it is common on exactly the guest networks a bar is likely to put a camera on.

Previously the answer was `hotspot.start`: the box raised its own AP, the phone left the
venue network and joined it. That worked, but it meant the phone lost the venue's internet
to do it, and it is why the hotspot could not be deleted.

Options, none built:

| Option | What it costs |
|---|---|
| Tell the user, and suggest a non-isolated SSID or Ethernet | Nothing. The honest v1 answer, and what §10 step 6 now says. |
| Proxy the web UI over BLE | A GATT link is ~1–3 KB/s. Fine for a settings form, hopeless for the WHEP preview that is most of why somebody opens the UI. |
| Reach the box through NetBird from the phone | Needs the app to carry a NetBird client or the backend to proxy. Works from anywhere, not just the venue — strictly better than the hotspot was, and the natural fit given every box is already on NetBird. **The option worth pricing.** |
| Put the settings the UI offers into the app, over BLE | Largest app change; removes the need to reach the box at all for setup. |

Until one of these lands, a box on an isolated network is set up fine and managed only
through the cloud.

### 14.5 A registered box with no network must stay findable

Raised 2026-11-10, when the app began filtering its discovery list on state bit 0 so that
only unregistered boxes appear. That is the right call for a *setup* list, but it leaves a
box in a gap:

- Registered, so it is excluded from the app's "Nearby Unregistered Boxes".
- Offline — the venue changed its WiFi password — so it is absent from any list built from
  the backend, because it cannot phone home.

It therefore appears nowhere in the app, while sitting a few feet away advertising
perfectly well and entirely fixable over BLE.

This is sharper than it looks because of D6's reversal. The old answer to "registered box,
broken network" was the hotspot: power-cycle, join `DigitalPool-XXXX`, fix it in the web
UI. **That path no longer exists.** BLE is now the only way back into a registered box with
no working network, and most of why removing the hotspot was acceptable.

Nothing is needed on the device: `info`, `net.status`, `wifi.scan`, `wifi.connect` and
`wifi.disconnect` all work on a registered box today. What is needed is for the app to
surface a box whose `shortId` matches one of the user's own but which it cannot reach over
the network — "DP-DuoCast-B1B5 is nearby but offline. Fix its network?" That is the §7.3
`manage` case, and it is recovery rather than onboarding, so it should not wait on the
registration work.

Note that `shortId` is the only identifier in the advertisement (§5.2) — deliberately,
since anyone in range can read it. Matching it against the user's known boxes is therefore
the only way to recognise "one of mine" before connecting, and it has the advantage of
working with no internet, which is exactly the situation this is for.

### 14.3 Still open after M2

- **A registered box should probably require `manage` for everything except `info` and
  `auth.*`**, and kick an unauthenticated connection after ~20 s so a stranger cannot hold
  the single slot (D8). Raised 2026-11-10; not specified here yet, and not built.
- **An iPhone holds its GATT connection open** even with the app backgrounded, so the box
  stops advertising (D8) and nobody else can see it until it is kicked. The 60-second
  silent kick and the 5-minute idle kick (§5.3) bound this, but the shorter
  unauthenticated timeout above would bound it better.
- **Reboot behaviour is untested.** Restarting the daemon, Node, and `bluetoothd`'s socket
  are all verified; a full power cycle is not. What it has to prove: `dp-hotspot.sh` stands
  down (migration `0030`), the hotspot profile does not autoconnect back onto the radio,
  and the box rejoins its venue network by itself.

### Test checklist (bench camera)

- **Phones:** iPhone on the current iOS and on iOS 16. Android 14, Android 10, and one
  Android 7/8 (location-permission path).
- **WiFi:**
  - WPA2, WPA3, open, hidden SSID
  - wrong password → `WIFI_AUTH_FAILED`, and the old network is kept
  - 5 GHz-only network
  - a network with client isolation (a guest SSID on any consumer router) → hotspot
    fallback
- **Disconnects and restarts:**
  - BLE drops during `wifi.connect` and during `register.start`; reconnect and pick up
    from status
  - `systemctl restart bluetooth` → advertising back within 10 s
  - `systemctl restart digitalpool-camera` while a phone is connected → `UNAVAILABLE`,
    then recovers
  - reboot mid-setup
- **Auth:**
  - a grant for another MAC → `AUTH_FAILED`
  - a grant with a stale nonce → `AUTH_FAILED`
  - `manage` from a non-owner → the backend refuses
  - six bad grants → kicked
- **Soak:** 7 days idle, then still discoverable and connectable. Check
  `journalctl -u digitalpool-ble` for re-registration warnings.
- **Legacy:** a field device updated through migrations stays in `hotspot` mode and its
  tablet still connects.

---

## 15. Open questions

1. ~~Which framework is `digitalpool-app`?~~ **Answered:** React Native 0.79 / Expo
   SDK 53 (`expo-router`, custom native modules already in `modules/`). BLE library is
   `react-native-ble-plx` with its Expo config plugin; it needs a dev client, not Expo Go.
2. Does the backend model venue staff? This decides who besides the registering account
   gets `manage`.
3. Should the shared `admin` password be randomised on BLE registration (§9.4), or kept
   for venues that run a browser-only tablet?
4. ~~Will boxes ship with a printed label?~~ **Answered 2026-11-10: no.** No label, no
   sticker, no QR code. The app tells boxes apart by RSSI order and `shortId` alone. See
   §13 for what that costs.
5. Does DigitalPool want to register a Bluetooth SIG company ID? Optional; `0xFFFF` works
   in practice.
6. Rock 5C: if the AIC Bluetooth driver turns out to be unreliable, is a USB BT adapter
   acceptable, or does the Rock 5C stay in `hotspot` mode?
