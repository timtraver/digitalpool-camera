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

- **The onboard WiFi 6 chip becomes the internet connection.** No dongle is needed.
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
| D4 | **Registration uses a new `claim` action on `registerCameraDevice`.** | Replaces `verify`/`assign` with email + password. The response has the same shape, so venue choice and subscription classification stay as they are. |
| D5 | **The browser handoff uses a one-time link that logs in as the app user.** | The web UI opens already signed in as the DigitalPool account that owns the box. The shared `admin`/`Digitalpool` login stops being the normal way in (§9.4). |
| D6 | **The hotspot is off by default and started on demand over BLE.** | It's still needed for venues that keep devices apart, for phones that can't reach the box, and for recovery. |
| D7 | **Onboarding mode is chosen per device: `ble` \| `hotspot` \| `auto`.** | Boxes already in the field are pinned to `hotspot` by a migration, so a venue whose tablet lives on the hotspot doesn't lose its camera after an update. New images use `auto`: BLE if a Bluetooth controller exists, otherwise hotspot. That covers boards with no radio, such as the Orange Pi 5. |
| D8 | **One phone connected at a time.** | BlueZ sends GATT notifications to every subscribed phone, so supporting several at once would mean routing each reply to the right phone. A setup flow doesn't need more than one. |

---

## 3. Hardware: confirm before building (milestone M0)

| Board | Bluetooth | Expected | What to verify |
|---|---|---|---|
| GMKtec G5 (N97, Intel AX101 — WiFi 6 + BT 5.2) | In-kernel `btusb` with Intel `ibt-*` firmware from `linux-firmware` | Should work out of the box | `bluetoothctl show` lists a controller; `btmgmt info` lists `le` among the supported settings; advertising is visible from nRF Connect |
| Radxa Rock 5C (AIC8800D80) | Needs AIC's vendor Bluetooth driver/firmware, which isn't in the mainline kernel | **Risk** | Is the AIC Bluetooth driver in our image? Does the controller appear in `bluetoothctl show`? Does advertising stay up for 24 h or more? |
| Orange Pi 5 | No onboard radio | — | Stays in `hotspot` mode, or gets a USB BT 5 adapter (any one using the in-kernel `btusb` driver) |

Also during M0, on the G5 (this decides how §8.3 behaves):

- `iw list` → "valid interface combinations". Look for AP + managed running at the same
  time (`#{ managed } <= 1, #{ AP } <= 1, #channels <= 1`).
- With the client connected on **5 GHz**, can a hotspot start? Intel's regulatory handling
  (LAR) often forbids starting an AP on 5 GHz. With `#channels <= 1` the AP has to share
  the client's channel, so the hotspot may only work while the client is on 2.4 GHz. Write
  down what actually happens. It decides whether `hotspot.start` can keep the internet up
  or has to drop it.

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
ExecStartPre=+/usr/sbin/rfkill unblock bluetooth
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

- **Adapter alias / BLE local name:** `getDeviceName()`, truncated to 20 characters. On a
  fresh box this is `dp-stream-<last 4 hex of the wired MAC>`, set by `dp-firstboot.sh`.
  It is the same name the web UI, NetBird and the DigitalPool backend show, so the box has
  one name everywhere. The local name goes in the **scan response**, not the main
  advertisement.
- **Primary MAC:** the one `getPrimaryMac()` returns (the wired NIC, even without a
  cable). Grants are bound to it (§7).

### 5.2 Advertisement payload (31 bytes)

| Field | Bytes | Value |
|---|---|---|
| Flags | 3 | LE General Discoverable, BR/EDR not supported |
| Complete list of 128-bit service UUIDs | 18 | the service UUID (§6.1) |
| Manufacturer specific data | 8 | company ID `0xFFFF` (reserved for testing; replace if DigitalPool registers a Bluetooth SIG company ID), then 4 bytes: `proto` (u8), `state` bits (u8), `shortId` (u16, the last 4 hex digits of the MAC) |

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
- **Advertising stops when a phone connects** on some controllers. While connected, the
  daemon doesn't need to advertise (D8). On disconnect, re-register the advertisement
  explicitly instead of assuming it resumed.
- **An idle phone holds the only connection.** Node `kick`s any connection with no request
  for **5 minutes**. In-progress operations (a WiFi connect, registration) carry on; the
  app reads their result after reconnecting.
- **A self-check every 60 s.** If the adapter is powered but the advertisement isn't
  registered and no phone is connected, re-register it and log a warning.

### 5.4 Pairing agent

The daemon registers an `org.bluez.Agent1` with capability **`NoInputNoOutput`** and makes
it the default agent. That gives LE Secure Connections "Just Works" pairing: the link is
encrypted with ECDH, so the WiFi password can't be sniffed passively. With no display or
keypad on the box there is no protection against an active man-in-the-middle; the grant
signature (§7) is what stops someone else issuing commands.

Bonds pile up in `/var/lib/bluetooth`. The daemon keeps the **20** most recent and removes
older devices through `Adapter1.RemoveDevice`.

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
| `SUBSCRIPTION_REQUIRED` | Registration refused for lack of a subscription. Same meaning as HTTP 402 today. |
| `REGISTRATION_FAILED` | Any other registration refusal. `message` carries the backend's text. |
| `UNAVAILABLE` | Node isn't running. Sent by the daemon itself. |
| `INTERNAL` | Bug. Details are in the journal. |

### 6.5 Versioning

`info.proto` is `1`. Adding commands, fields or events does **not** change `proto`; the
app looks at `info.commands`. Breaking changes raise `proto`, and the app refuses
`proto` values above the highest it knows, with "Update the DigitalPool app".

---

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

### 7.4 Recovery window

For **10 minutes after boot**, `hotspot.start` is allowed without a grant. This covers an
owner whose phone has no internet (so it can't get a grant) at a venue whose WiFi changed:
power-cycle the box, start the hotspot from the app, then join it. The hotspot has its own
WPA2 password and the web UI still needs a login, so this exposes no more than today's
always-on hotspot.

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
  mode: `clientIface` = onboard, and the AP is started on the same radio only when asked
  (§8.3). If a dongle is also present, prefer it for the AP and keep the onboard chip as
  the client.
- **⚠ Remove the shell injection.** `connectToNetwork()` builds an `nmcli` string with
  `ssid` and `password` pasted inside double quotes. A crafted password runs commands as
  `dp`. Today that input comes only from a logged-in admin; over BLE it comes from any
  grant holder, through a parser we didn't write. Change every `nmcli` call that takes
  user input to `execFile('nmcli', [...args])`. Do this in M2, before the BLE path exists.
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
  default). `net.status` reports both.
- **Review** `network-watchdog.sh` and `dp-hotspot.sh` for assumptions that the onboard
  chip is the AP.

### 8.3 On-demand hotspot

`hotspot.start {minutes}` (default 30, max 240) brings up `DigitalPool-Hotspot` and its
captive-portal rules, then takes it down after `minutes` or on `hotspot.stop`. What
happens to the client connection depends on M0:

- **AP + client works on the current channel:** start the AP on a virtual interface. The
  internet stays up.
- **It doesn't** (e.g. client on 5 GHz, Intel won't run an AP there): the box takes the
  client down while the hotspot runs and brings it back afterwards. `hotspot.start`
  returns `{ "internetInterrupted": true }` so the app can warn the user.

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

### 9.2 One-time login link

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
because they only read `req.session.user`. **Confirm** nothing assumes
`session.user.username` exists in `users.json`; the password-change endpoints do, so hide
"change password" for `via: "app"` sessions.

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
   - Tell the user the name is printed on the box label (`dp-stream-xxxx`).
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
   - On `SUBSCRIPTION_REQUIRED`, show the pricing link (same copy as the web UI today).
5. **Open camera.**
   - `web.link`.
   - The **phone must be on the same network as the box**. If the app knows the phone
     isn't on WiFi, say "Join *Joe's Bar* WiFi on this phone" first.
   - Probe reachability with `GET {lan}/api/ping`, 3 s timeout.
   - Open the URL in an **in-app browser tab** (`SFSafariViewController` / Chrome Custom
     Tabs). That supports Socket.IO and WebRTC (WHEP preview), and the handoff token
     carries the login in.
6. **Unreachable** (client isolation, or the phone stuck on cellular).
   - Offer "Connect directly to the camera" → `hotspot.start`.
   - The app joins the hotspot itself:
     - iOS: `NEHotspotConfiguration`
     - Android: `WifiNetworkSpecifier`
   - Get a fresh `web.link` and open the `hotspot` URL.

`register.start` and `wifi.connect` return `accepted` straight away and finish in the
background. If the phone loses BLE in the middle, it reconnects and calls `net.status`, or
the new `register.status`, to pick up where it left off.

### App platform notes

| | iOS | Android |
|---|---|---|
| Library | `react-native-ble-plx` or `flutter_blue_plus`, whichever matches `digitalpool-app` | same |
| Permissions | `NSBluetoothAlwaysUsageDescription`; **`NSLocalNetworkUsageDescription`** (the LAN reachability probe and the web UI on a LAN IP need it; without it the iOS 14+ local-network prompt never shows and requests fail silently) | API 31+: `BLUETOOTH_SCAN` (`neverForLocation`), `BLUETOOTH_CONNECT`. API ≤ 30: `ACCESS_FINE_LOCATION`, needed for BLE scanning on older phones |
| MTU | automatic | `requestMtu(517)` after connect |
| Gotchas | GATT layout is cached per address. BlueZ exposes Service Changed, so updated firmware is noticed. | Serialise **all** GATT operations (one in flight). Retry connect on status 133 up to 3× with 500 ms backoff. Call `refresh()` on the GATT cache if the service isn't found. |
| Joining hotspot | `NEHotspotConfiguration` (Hotspot entitlement) | `WifiNetworkSpecifier` (API 29+) |

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
  hotspot. Later: show the portal page to the user through the hotspot.
- **Plain HTTP on the venue LAN:** session cookies cross the bar's WiFi unencrypted. That
  was already true on the hotspot, but the hotspot was WPA2 and only reached the box. The
  per-device trusted certificate (§9.3) fixes this.
- **WPA2-Enterprise:** not supported.
- **Second phone:** gets no connection while one is connected (D8). The 5-minute idle kick
  bounds the wait.

---

## 13. Image and factory changes

- `dp-restore.sh` / golden image:
  - `bluez` installed, `main.conf` (§4.1), the D-Bus policy (§4.2), and
    `digitalpool-ble.service` enabled.
  - `ble/grant-keys.json` present.
  - `ONBOARDING_MODE=auto`.
- `dp-firstboot.sh`: nothing new. The device name and MAC it already sets are the BLE
  identity.
- **Label:** the box label should print `dp-stream-xxxx` (and optionally a QR code with
  it), so the user can pick the right box in a room full of them. Update
  `FACTORY_INSTALL.md` if the OEM prints labels.
- `CLAUDE.md` / `README.md`: document the new service and the mode switch.

---

## 14. Work plan

Three tracks run in parallel after M1. The protocol in §6 is what they meet on.

| Milestone | Device (this repo) | App | Backend |
|---|---|---|---|
| **M0** hardware spike | §3 checks on a G5 and a Rock 5C. A hello-world advertisement visible in nRF Connect. Answer the AP+client question. | Pick the BLE library; confirm it builds on both platforms | — |
| **M1** read-only BLE | `dp-ble.py` (GATT, framing, advertising, agent, the §5.3 recovery), `bleBridge.js`, commands `info`, `net.status`, `wifi.scan`. A test CLI `ble/tools/dpble-cli.py` using `bleak` (runs on a Mac) to exercise the protocol without the app. | Scan list with state bits; connect, pairing, `info` | Ed25519 keypair; publish `grant-keys.json` |
| **M2** WiFi | `execFile` rewrite and validation in `wifiManager` (§8.2); `wifi.connect` with progress; `ONBOARDING_MODE` and migration; onboard chip as client | Network screen | — |
| **M3** auth + registration | Grant verification, scope table, dev keys; `registration.js` refactor; `register.*` over BLE | Auth handshake, register screens, venue picker | `issueDeviceGrant`; `claim` action |
| **M4** handoff | `web.link`, `/auth/handoff`, `/api/ping`, port 80, random admin password, on-demand hotspot | Reachability probe, in-app browser, hotspot join fallback | — |
| **M5** ship | Image changes (§13), docs | Store release | Production keys |

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

1. Which framework is `digitalpool-app`, React Native or Flutter? This fixes the BLE
   library in §10.
2. Does the backend model venue staff? This decides who besides the registering account
   gets `manage`.
3. Should the shared `admin` password be randomised on BLE registration (§9.4), or kept
   for venues that run a browser-only tablet?
4. Will boxes ship with a printed `dp-stream-xxxx` label? If not, the app has to tell boxes
   apart by RSSI and the `shortId` alone.
5. Does DigitalPool want to register a Bluetooth SIG company ID? Optional; `0xFFFF` works
   in practice.
6. Rock 5C: if the AIC Bluetooth driver turns out to be unreliable, is a USB BT adapter
   acceptable, or does the Rock 5C stay in `hotspot` mode?
