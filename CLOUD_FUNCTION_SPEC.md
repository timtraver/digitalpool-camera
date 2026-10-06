# `registerCameraDevice` — subscription support

**Task spec for the DigitalPool Firebase functions codebase.** Self-contained:
nothing here requires reading the camera-device repo.

## What this is

DigitalPool camera devices (Node app on an Intel N97 / Rockchip RK3588 appliance)
talk to one HTTPS cloud function, `registerCameraDevice`, by POSTing a JSON
`action`. They hold no Firebase SDK and no API key.

The devices now enforce subscriptions, and **the device half is already written
and deployed**. It cannot be changed from your side, and until this function
reports subscription data nothing is enforced — every device behaves exactly as
it does today. Your job is to start reporting it.

Two packages exist:

| | Base — any plan | Advanced Streaming |
| --- | --- | --- |
| Software runs, streams to the venue's own YouTube / Facebook / RTMP | ✅ | ✅ |
| RTSP Server / SRT Server output (how our datacenter pulls the stream) | ❌ | ✅ |
| The venue's own overlays (scoreboards, graphics) | ❌ — our branded overlay is composited instead | ✅ |

## Existing actions — do not change their current behaviour

| Action | Sent by the device | Carries a password? |
| --- | --- | --- |
| `verify` | Registration step 1 — authenticate the operator, return their venues | Yes |
| `assign` | Registration step 2 — attach this device to a venue | Yes |
| `deregister` | Device is being de-registered | No — identity only |
| `listOverlays` | Overlay picker in the UI | No — identity only |

`deregister` and `listOverlays` already authenticate by identity
(`ownerEmail` / `venueId` / `deviceId` / `macAddress`). The new `subscription`
action follows that same pattern.

---

## Change 1 — return `user_id` from `verify` and `assign`

The device stores it and uses it as the lookup key for every later subscription
check. The operator's password is used once during registration and is **never**
persisted, so there is nothing else to re-authenticate with later.

```json
{ "ok": true, "user_id": "firebase-uid-of-the-account", "venues": [ ... ] }
```

Also accepted: `userId`, `uid`.

This is effectively required. Without it the device falls back to `ownerEmail`,
which your lookup should also accept for devices registered before this ships.

## Change 2 — report the subscription on `verify` and `assign`

Add a `subscription` object to both responses (see **The subscription object**
below). The device refuses to register an account that has no subscription.

**Refuse inside `verify` wherever you can** — ideally before creating or
updating any device record. The chooseVenue path calls `assign` in a separate
request, so `assign` needs the same check; a request that reaches `assign`
without a subscription should be refused there rather than recording a device
the operator will never be able to use.

Either shape works for a refusal — the device parses the body before it looks at
the status code:

```json
HTTP 200 or 402
{ "ok": false,
  "error": "This account has no active subscription.",
  "subscription": { "subscribed": false, "status": "none" } }
```

## Change 3 — add the `subscription` action

This is the recurring check: every 14 days per device, plus whenever an operator
clicks "Check Now" after purchasing or upgrading.

**Request** (no password — identity only):

```json
{
  "action":     "subscription",
  "userId":     "firebase-uid",          // also sent as "user_id"
  "email":      "owner@example.com",     // fallback for pre-user_id devices
  "deviceId":   "...",
  "deviceName": "dp-stream-ab12",
  "macAddress": "aa:bb:cc:dd:ee:ff",
  "netbirdIp":  "100.64.0.10",
  "venueId":    "..."
}
```

**Response** — `ok` plus the same `subscription` object:

```json
{ "ok": true, "subscription": { ... } }
```

Look the account up by `userId`, falling back to `email`. If you want to bind
the answer to a known device, match `deviceId` (or `macAddress`) against the
device record as well — but **answer about the account even when no device
record is found**, because an error there reads as an outage (see
**Error semantics**).

---

## The subscription object

Canonical shape. Send this and you need none of the tolerance below:

```json
"subscription": {
  "subscribed": true,
  "status":     "active",
  "plan":       "Advanced Streaming",
  "expires_at": "2026-11-04T00:00:00Z",
  "features": {
    "overlays":   true,
    "datacenter": true
  }
}
```

A base plan sends `"features": { "overlays": false, "datacenter": false }`.

- **`datacenter`** — RTSP Server / SRT Server output, i.e. streaming back to us.
- **`overlays`** — the venue's own overlays. Without it they stream with the
  DigitalPool branded overlay.

### Two rules that matter more than the field names

1. **A flag you omit is GRANTED, not withheld.** Omitting `features` entirely
   gives a subscribed account both packages. This is deliberate: adding a
   package to billing never needs a device update, and an older function can
   never take a capability away from a paying venue. It also means **the device
   locks nothing until you actually send `features: { ... : false }`.**
2. **A lapsed subscription holds no packages**, whatever the flags say. You do
   not need to zero them yourself.

### Field tolerance

Only relevant if the canonical shape does not fit your data model. The object
may also be flattened onto the response root instead of nested under
`subscription`.

| Meaning | Accepted keys |
| --- | --- |
| subscribed | `subscribed`, `is_subscribed`, `isSubscribed`, `active`, `is_active`, `isActive`, `has_subscription`, `hasSubscription` — boolean, or the strings `true`/`false`/`yes`/`no`/`1`/`0` |
| status | `status`, `subscription_status`, `subscriptionStatus` |
| plan (display only) | `plan`, `plan_name`, `planName`, `product` |
| expiry | `expires_at`, `expiresAt`, `current_period_end`, `currentPeriodEnd`, `renews_at`, `renewsAt` — ISO string, epoch seconds, epoch ms, or a Firestore `{_seconds}` timestamp |
| features | `features`, `feature_flags`, `featureFlags` — a map, **or** a list of the granted names (`["overlays"]`, treated as the complete set), **or** the flags directly on the subscription object |
| feature aliases | `overlays` ← `overlay`, `graphics`, `custom_overlays`, `customOverlays`<br>`datacenter` ← `data_center`, `advanced_streaming`, `advancedStreaming`, `advanced`, `streaming`, `server_modes`, `serverModes` |
| tier (fills in whatever `features` did not say) | `tier`, `level`, `package` — `advanced`/`pro`/`premium`/`plus`/`elite`/`full` grant both; `base`/`basic`/`standard`/`starter`/`lite`/`free` grant neither |

**Statuses treated as entitled:** `active`, `trialing`, `trial`, `past_due`,
`pastdue`, `grace`, `comped`, `lifetime`.
`past_due` is entitled on purpose — dunning is between us and the card issuer,
and a venue should not lose its camera the hour a renewal fails.

**Treated as NOT entitled:** `canceled`, `cancelled`, `expired`, `inactive`,
`none`, `unpaid`, `incomplete`, `incomplete_expired`, `paused`, `deleted`,
`no_subscription` — **and any other non-empty status you invent**. If you add a
status, add it here first or send an explicit `subscribed` boolean alongside it.

If a response carries no recognisable subscription information at all, the
device treats it as "no information" and changes nothing.

---

## Error semantics — the part to get right

A false "no" means a paying venue cannot broadcast its tournament. The device is
asymmetric on purpose, so **how you report a problem decides what happens**:

| Your response | Device behaviour |
| --- | --- |
| Subscription object saying not subscribed (any status code) | **Blocks immediately.** This is an answer. |
| `ok: true` with a valid subscription object | Entitlements updated; verification clock reset. |
| `ok: true` with no subscription information | **No change** to entitlements, and the clock still resets — the device heard from us. |
| `ok: false` / 4xx / 5xx whose message says the action is unknown, unsupported, invalid or not implemented | Same as above: treated as "no information", **not** a failed verification. |
| Any other `ok: false` / 4xx / 5xx | **Outage.** Last known state stands, retried every 24 h. Only after the last good answer is 21 days old (14-day interval + 7-day grace) does the device stop allowing new streams. |
| Unreachable / timeout | Same as an outage. |

Two consequences:

- **Never return a generic 500 for "this user has no subscription."** That reads
  as an outage, and the device keeps streaming for up to three more weeks.
- **Never return a generic error for an account or device you cannot find**
  during the `subscription` action, unless you mean "we could not check". If you
  genuinely cannot resolve the account, a plain error is correct — the device
  keeps its last known state rather than guessing.

---

## Rollout order

The device is already deployed and fails open, so there is no flag day.

1. **`user_id` on `verify` / `assign`.** Harmless on its own; existing devices
   pick up their account id the next time they register.
2. **`subscription` on `verify` / `assign`, and the `subscription` action —
   ship these together.** Registration becomes gated and deployed devices start
   re-verifying within 24 h.
   Shipping step 2's registration half *without* the action is safe but pointless:
   the device will report "action not implemented", keep its entitlements and
   keep asking.
3. **`features`** once the two packages exist in billing. Until this field
   appears, every subscribed account holds both packages, so nothing is locked
   and no venue loses a capability mid-season.

---

## Acceptance tests

Exercise the function directly; each line is what a device would do with it.

**Registration**
1. `verify` with a subscribed account → `ok: true`, `user_id` present,
   `subscription.subscribed: true`, venues listed. *Device registers.*
2. `verify` with a valid login but no subscription → `subscription.subscribed:
   false`. *Device refuses to register and tells the operator to subscribe.*
3. `assign` for an account that lost its subscription between the two steps →
   refused the same way, **no device record left behind**.
4. `verify` with bad credentials → unchanged from today (401 / `ok: false`).
   *Must NOT look like "not subscribed".*

**Recurring check**
5. `subscription` with a known `userId` → the account's current state.
6. Same, with `email` only and no `userId` (a device registered before step 1) →
   resolves by email.
7. `subscription` for an account whose plan lapsed → `subscribed: false`.
   *Device blocks new streams immediately; a stream already running is left
   alone.*
8. `subscription` for a base plan → `features.datacenter: false`,
   `features.overlays: false`. *Device locks the RTSP/SRT output modes and
   composites the DigitalPool branded overlay.*
9. Upgrade the account to Advanced, then call again → both features `true`.
   *The operator clicks "Check Now" and everything unlocks in place, no restart.*
10. No password is required by any `subscription` call, and none is sent.

**Error handling**
11. Unknown `userId` → a plain error, not `subscribed: false`.
12. Simulated internal failure → an error, not `subscribed: false`.

## Reference

The device-side contract, written from the other direction, lives in the camera
repo as `SUBSCRIPTION_CHECK.md`.
