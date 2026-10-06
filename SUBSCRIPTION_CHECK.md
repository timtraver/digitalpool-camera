# Subscription enforcement

The camera may only stream while the DigitalPool account it is registered to
holds a subscription, and what it may do depends on which package that
subscription includes. This document is the contract between the device
(`subscriptionManager.js`) and the `registerCameraDevice` cloud function.

| | Base — any plan | Advanced Streaming |
| --- | --- | --- |
| Software runs | ✅ | ✅ |
| RTMP Push / YouTube Live / Facebook Live | ✅ | ✅ |
| **RTSP Server / SRT Server** (how DigitalPool's datacenter pulls the stream) | ❌ | ✅ |
| **Venue's own overlays** (remote scoreboard, Skia graphics) | ❌ — replaced by the DigitalPool branded overlay | ✅ |

**The device half is implemented and shipped. The cloud-function half below is
not — until the function reports subscriptions, every device keeps streaming
exactly as it does today (see *Rollout* at the bottom).**

## Where it bites

| Moment | Behaviour |
| --- | --- |
| Registration (`/api/setup/register`, `/api/setup/register/venue`) | The response is classified by `subscriptionManager.classifyRegistration()` **before** it is treated as an auth failure — a refusal arrives as `ok: false` and is otherwise indistinguishable from a rejected login. No subscription → HTTP 402 with `subscriptionRequired`, and the device never becomes registered. The UI answers that with a link to the pricing page and a retry. |
| Every ~14 days afterwards | Background check against the same cloud function, keyed by the account id stored at registration. |
| Stream start / restart (REST + both socket events) | Refused with HTTP 402 / `subscriptionRequired: true` when the gate is closed. |
| Starting on RTSP Server or SRT Server without the advanced package | Refused with HTTP 402 / `packageRequired: "datacenter"`. The UI greys those Output Modes out with a 🔒 and explains why. |
| Overlays without the advanced package | The venue's own graphics overlay is never rendered; the DigitalPool branded overlay is composited in its place. Their saved overlay settings are left untouched, so an upgrade restores them. |
| A stream already running | **Never torn down.** A lapse mid-match does not kill the broadcast; only the next start is refused. |
| Starts with no user behind them — `autoStart` on boot, the USB-reset restore, the stall watchdog's auto-resume | Gated too, by `streamController.startGate` (injected by `server.js`). The user-facing paths pass `skipEntitlementCheck` because they already ran the gate themselves, so nothing is double-checked and the dpadmin bypass survives. |
| `dpadmin` | Bypasses the gate entirely, for support access. |

## What the cloud function must return

### 1. On the existing `verify` and `assign` actions

Add subscription facts to the response body. Either nested or flat is read:

```json
{
  "ok": true,
  "user_id": "firebase-uid-of-the-account",
  "venues": [ ... ],
  "subscription": {
    "subscribed": true,
    "status": "active",
    "plan": "Advanced Streaming",
    "expires_at": "2026-11-04T00:00:00Z",
    "features": {
      "overlays": true,
      "datacenter": true
    }
  }
}
```

`features` is what separates the two packages:

- **`datacenter`** — the RTSP Server and SRT Server output modes, i.e. streaming
  back to DigitalPool for Wowza to pull.
- **`overlays`** — the venue's own graphics overlays. Without it they stream with
  the DigitalPool branded overlay instead.

A base plan sends `{ "overlays": false, "datacenter": false }`. **A flag that is
absent is granted, not withheld** — so adding a package to billing never needs a
device update, and an older cloud function can never take a feature away from a
paying venue. A lapsed subscription holds no packages regardless of the flags.

Prefer refusing inside `verify` (and `assign`, for the venue-picker path) rather
than recording the device and letting it be rejected afterwards: the device
checks the response of both, so an unsubscribed account that reaches `assign`
would otherwise leave a device record behind that it never gets to use.

`user_id` (also read as `userId` / `uid`) is **required going forward** — it is
the only piece of the operator's identity the device keeps, and it is what the
recurring check is keyed by. The password is used once and never persisted.

### 2. A new `subscription` action

```
POST https://<functions-base>/registerCameraDevice
{
  "action":     "subscription",
  "userId":     "firebase-uid",        // also sent as "user_id"
  "email":      "owner@example.com",   // fallback for devices registered before user ids were stored
  "deviceId":   "...",
  "deviceName": "dp-stream-ab12",
  "macAddress": "aa:bb:cc:dd:ee:ff",
  "netbirdIp":  "100.64.0.10",
  "venueId":    "..."
}
```

No password is sent — this is identity-based, exactly like the existing
`deregister` action. Respond with the same `subscription` object as above.

### Field tolerance

The device is deliberately forgiving about naming so the backend is not locked
into one spelling:

- **subscribed**: `subscribed` / `is_subscribed` / `active` / `is_active` /
  `has_subscription` (boolean, or the strings `true`/`yes`/`1`).
- **status**: `status` / `subscription_status`. Treated as entitled:
  `active`, `trialing`, `trial`, `past_due`, `grace`, `comped`, `lifetime`.
  Treated as not entitled: `canceled`, `cancelled`, `expired`, `inactive`,
  `none`, `unpaid`, `incomplete`, `incomplete_expired`, `paused`, `deleted`, and
  any other non-empty value that is not on the entitled list.
- **plan**: `plan` / `plan_name` / `product`. Display only — except that a plan
  name with no boolean and no status is read as subscribed.
- **features**: a map (`{ "overlays": true }`), a list of the granted names
  (`["overlays", "datacenter"]` — a list is treated as the complete set, so
  anything not named is withheld), or flags directly on the subscription object.
  Aliases: `overlays` also reads `overlay` / `graphics` / `custom_overlays`;
  `datacenter` also reads `advanced_streaming` / `advanced` / `server_modes`.
- **tier**: `tier` / `level` / `package` fills in whatever `features` did not
  say. Anything starting `advanced`/`pro`/`premium`/`plus`/`elite`/`full` grants
  both; `base`/`basic`/`standard`/`starter`/`lite`/`free` grants neither.
- **expires_at**: `expires_at` / `current_period_end` / `renews_at`. ISO string,
  epoch seconds, epoch milliseconds, or a Firestore `{_seconds}` timestamp.

`past_due` is intentionally entitled: dunning is between DigitalPool and the
card issuer, and a venue should not lose its camera the hour a renewal fails.

## How failures are treated

A false "no" here means a paying venue cannot broadcast its tournament, so the
device only ever blocks on evidence:

- **Explicit "not subscribed"** → blocked immediately (including a 402/403 whose
  body carries the subscription object — that is an answer, not an outage).
- **Unreachable / HTTP error / timeout** → nothing changes. The last good answer
  stands, retried every 24 h. Only once the last successful *entitled* answer is
  older than 21 days (14 day interval + 7 day grace) does the device stop
  allowing new streams.
- **HTTP 200 with no subscription information**, or an error that says the
  action is unknown / unsupported / not implemented → treated as "no
  information". Entitlements are left exactly as they are, and the staleness
  clock resets, because the device *did* hear from DigitalPool. This is what
  keeps a backend that ships the registration half before the `subscription`
  action from locking every registered device out 21 days later.
- **Never checked at all** (legacy device, or the backend not updated yet) →
  allowed. Enforcement begins the first time DigitalPool actually answers.

## The branded overlay

An account without the `overlays` package streams with the DigitalPool branded
overlay instead of its own. It is rendered by the same headless-Chromium path a
venue's own overlay uses, so nothing in the pipeline changes — only *whose* page
is screenshotted into `/dev/shm/graphics-overlay*.png`.

- Default source: the page this device serves at `/branded-overlay.html`
  (`public/branded-overlay.html` — a transparent 1920×1080 page with the
  DigitalPool lockup bottom-left).
- dpadmin can point it at any URL, switch it off, or change how often it is
  sampled, in **Admin Settings → Branded Overlay** (`/api/branding/overlay`,
  persisted to `branding.json`). This is **dpadmin-only on purpose**: a venue
  admin who could edit it could point it at a blank page and switch the branding
  off.
- Because the page is static it is sampled every 5 minutes rather than every 2
  seconds, so branding costs a fraction of the Chromium CPU a live scoreboard
  does.
- The venue's own overlay settings are never overwritten. They are simply not
  used while the package is absent, and come back on upgrade.

`effectiveOverlay()` in `server.js` is the single place that decides whose
overlay is rendered; the pipeline builders, the idle preview and the Puppeteer
renderer all read it, so they cannot disagree about what is on screen.

## Device-side surface

| Thing | Where |
| --- | --- |
| Logic + persisted state | `subscriptionManager.js` → `subscription.json` (runtime state, gitignored) |
| HTTPS transport | `digitalpoolApi.js` (shared with registration) |
| The one gate | `streamStartGate()` in `server.js` — used by the REST route and both socket handlers so they cannot drift |
| Whose overlay renders | `effectiveOverlay()` / `applyEffectiveOverlay()` in `server.js`; `streamController._needsGraphicsOverlay()` asks it through the injected `resolveOverlay` |
| Branded overlay admin | `GET`/`PUT /api/branding/overlay` (dpadmin), `public/branded-overlay.html`, `branding.json` |
| Read status | `GET /api/subscription/status` (any signed-in user), also included in `GET /api/setup/status` |
| Force a re-check | `POST /api/subscription/check` — **any signed-in user**, throttled to one call per 10 s |
| Push to UI | socket event `subscriptionStatus` |
| UI | Blocker banner above Start, "⛔ Subscription Required" badge on Admin Settings, plan + last-verified rows under Device Registration |

Tunables (all optional, defaults are the shipped policy) are documented in
`.env.example`: `SUBSCRIPTION_CHECK_DAYS`, `SUBSCRIPTION_GRACE_DAYS`,
`SUBSCRIPTION_RETRY_HOURS`, `SUBSCRIPTION_BOOT_DELAY_SEC`,
`DIGITALPOOL_SUBSCRIPTION_FUNCTION`, `DIGITALPOOL_SUBSCRIPTION_ACTION`.

## What the operator sees

Plan state is never something they have to go looking for, and an upgrade never
means waiting out the fortnightly check:

- **Header chip**, on every page view: green `✓ <plan>` when everything is
  available, amber `⚠️ <plan> — limited` the moment any package is missing, red
  `⛔ No subscription` when the device cannot stream at all. Clicking it opens
  the plan panel.
- **Plan panel** — the plan, when it was last verified, when the next check is
  due, and a ✅/🔒 line per capability saying what is and is not included. With
  no live subscription every line reads 🔒, including the push modes a plan would
  otherwise always include.
- **Check Now**, in that panel: asks DigitalPool immediately and reports what
  changed — "Advanced Streaming unlocked", "still on Base, the package is not on
  this account yet", or the failure. The UI updates in place: Output Modes
  ungrey, the notes clear, Start enables. No restart, no reload.
- **"Upgraded? Check now"** sits inside each lock note as well, so the action is
  where the limit is felt. It runs the same check and then opens the plan panel
  with the answer next to the upgrade link.
- The blocker banner above Start and the row under Admin Settings → Device
  Registration both carry the same re-check action.

The check is open to any signed-in user, not just admins — whoever is at the
venue when the upgrade is bought is the one who needs it to take effect. It is
throttled server-side to one outbound call per 10 seconds; inside that window
the device answers with the state it already has.

## Rollout

The device side is safe to deploy before the cloud function changes: with no
subscription information in any response, nothing is ever blocked and the UI
shows "Not yet verified". Enforcement switches itself on, device by device, as
soon as the function starts answering — no second device deployment needed.

Order of operations:

1. Deploy the device software (done by shipping this repo).
2. Add `user_id` + `subscription` to the `verify`/`assign` responses. New
   registrations are now gated, and existing devices record their account id on
   their next re-registration.
3. Add the `subscription` action. Deployed devices pick it up within 24 h and
   re-verify every 14 days from then on.
4. Add `features` when the two packages exist in billing. Until that field
   appears, every subscribed account is treated as holding both packages, so
   nothing is locked and no venue loses a capability mid-season.

Until step 2 ships, devices registered earlier have no `userId` in
`remote.json`; the check falls back to `ownerEmail`, which the function should
accept as a lookup key for those devices.

## Handing the backend work over

`CLOUD_FUNCTION_SPEC.md` is the same contract written from the cloud function's
side, self-contained, for whoever implements `registerCameraDevice`.

## Testing a full cycle in minutes

```bash
# on the device, in .env
SUBSCRIPTION_CHECK_DAYS=0.002      # ~3 minutes
SUBSCRIPTION_GRACE_DAYS=0.002
SUBSCRIPTION_RETRY_HOURS=0.02      # ~70 s
SUBSCRIPTION_BOOT_DELAY_SEC=10
sudo systemctl restart digitalpool-camera
journalctl -u digitalpool-camera -f | grep -i subscription
```

Point `DIGITALPOOL_FUNCTIONS_URL` at a local stub to exercise the refusal paths
without touching production billing.
