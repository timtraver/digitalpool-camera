# Local overlay rendering (no browser)

Draws the venue's DigitalPool overlay on the device with Skia, instead of running
headless Chromium to screenshot the overlay page.

**Nothing changes until `OVERLAY_ENGINE=auto` is set.** The default is `chromium`,
which is the behaviour this device has always had.

## Why

Measured on an N97 (`dp-stream-1`, 4 cores), before and after, with the same box
doing the work:

| | browser engine, 1 stream | local renderer, 2 streams |
|---|---|---|
| overlay + app CPU | 5.6% of one core (Chrome 4.0 + node 1.6), continuous | **2.8% of one core** |
| cgroup memory | 802 MB | **605 MB** (cap is 2500) |
| browser processes | 3–9, restarted hourly | **0** |
| PNG writes | every 2 s whether or not anything changed | only when something changes |
| DigitalPool queries, table idle | every 2 s, the full query | **none — a subscription** |

Twice the streams, half the CPU, 200 MB back. The browser also screenshotted on a
timer regardless of whether the scoreboard had moved — 10 rewrites in 20 s with
identical content — where the local renderer redraws on an actual change.

## What it asks DigitalPool for

The renderer polls; it does not subscribe. What keeps that affordable is that it
runs at two speeds, and only the fast one costs anything much:

- **A match is on the table** — the full binding query every `OVERLAY_POLL_MS`
  (2 s), the same interval the web overlay uses for venue mode.
- **The table is empty** — nothing is sent. The same question is held open as a
  GraphQL subscription (`overlayWatch.js`), and Hasura pushes only when the
  answer changes. Measured against api-prod: a subscription on an idle table
  delivered **one payload in 25 s** — the initial result — and nothing after it.

A venue box is idle far more of the day than it is live, and at the old fixed
cadence each camera sent the heavy query about 43,000 times a day to re-render
the same blank scoreboard. Holding the cheap question open instead takes that to
zero, and makes detection immediate rather than a function of a poll interval.

After a match leaves the table the fast cadence is held for
`OVERLAY_IDLE_AFTER_MS` (60 s), so the normal few-second gap between one match
and the next does not pay the handover.

### The subscription is never load-bearing

These boxes sit on venue WiFi and LTE behind NAT; the socket will drop. Every
watcher keeps its poll behind it:

- Socket connected and it has delivered a payload → believed, no requests sent.
  "Connected" alone is not enough: a socket that has not spoken yet knows
  nothing, and reading silence as "no match" would strand the overlay.
- Socket down, or not yet speaking → `probeLive()` every `OVERLAY_IDLE_POLL_MS`,
  exactly as if subscriptions did not exist. A close is noticed immediately and
  pulls the next read right in, rather than leaving it scheduled at the
  safety-net interval.
- `OVERLAY_WATCH_RECHECK_MS` (10 min) only covers a push that never arrived at
  all — a half-open socket, or a Hasura restart that dropped the subscription
  without closing the connection.

One socket per device, shared by both cameras, with jittered reconnect backoff
so a fleet coming back from an outage does not reconnect in lockstep.

Only the PROBE is subscribed. The full binding query stays a poll on purpose:
Hasura implements live queries by re-running the query server-side on its
multiplexed refetch interval, so subscribing the expensive query would mean
*more* database work during a match, not less. The cheap question is the one
worth holding open.

A tick is also no longer the same thing as a query. Carousel frames and the match
clock redraw from the binding already in hand, so animation runs at whatever rate
it needs without that rate reaching DigitalPool — which it used to, because every
tick fetched. With `OVERLAY_CAROUSEL_FADE=1` that meant ten queries a second for
the length of every fade.

`GET /api/overlay/engine` reports `live`, `watching` and `pollMs` per camera,
which is how to tell from outside which cadence a box is actually on —
`pollMs: 0` with `watching: true` means the idle poll is off entirely.

It does **not** touch the per-frame compositing cost (the NV12↔BGRA round-trip),
which is the larger steady-state load. The 38% of four cores this box uses with
two 4K streams is encoding, not overlays.

### Where the remaining overlay cost is

A frame on that hardware breaks down as:

```
warm draw    :   8 ms
png encode   : 114 ms   ← 93% of the frame
raw RGBA     :  10 ms
```

PNG compression level makes no difference — the cost is the per-pixel scan. The
one change left that materially moves this is handing the pipeline raw
premultiplied BGRA instead of a PNG, which would also remove the cairo decode in
`_build_composition`. A frame would go from ~122 ms to ~18 ms.

In practice an overlay with a 10 s sponsor carousel redraws about 6 times a
minute, so that single change is worth roughly 1.3% of a core per camera.

## How the pieces fit

```
overlayProducer.js   picks the engine, and falls back
  ├── puppeteerOverlay.js   headless Chromium  (unchanged)
  └── skiaOverlay.js        local renderer
        ├── overlayDataSource.js   overlay canvas + live match binding
        ├── overlayAds.js          Ad Center ads for ad_center elements
        └── overlayRenderer.js     draws the canvas to a Skia surface
```

Both engines write the same `/dev/shm/graphics-overlay[-2].png`. Nothing
downstream can tell which one produced it — `gst-overlay-pipeline.py` still
hot-swaps on mtime, and `effectiveOverlay()` still decides whose overlay shows.
`server.js` requires `overlayProducer` in place of `puppeteerOverlay`; every call
site is unchanged.

## Ad Center elements

`ad_center` is the only element whose content is not in the saved canvas. It
names a venue — or says "whichever venue this overlay is being shown at" — and
the images come from that venue's Ad Center, the same ads its TVs are showing.
`overlayAds.js` is the port of the web component that fetches them
(`renderers/AdCenterCarousel.js`), and the ads ride along on the binding as
`binding.ads`, so drawing stays a pure function of (canvas, binding, now) and
the renderer still never makes a request.

What it asks for, and how often:

| | |
|---|---|
| query | `GET_ACTIVE_ADS_FOR_SCREEN` as screen `default` — venue-scoped ads with no target screen, i.e. the ones that run on every screen — plus national ads when `venue_custom_install` and `accepts_national_ads` are both set |
| cadence | every `OVERLAY_AD_REFRESH_MS` (5 min), per venue, shared by both cameras' elements through one cache |
| failure | the last good list keeps drawing for `OVERLAY_AD_STALE_MS` (24 h). A venue sold that slot; a dropped uplink must not blank it |
| rotation | each ad holds for its own `duration` (the element's `interval` is only the fallback), so the cycle is a cumulative schedule walked off the wall clock, not one interval |

**Which venue.** A fixed venue if the element names one; otherwise the venue in
the overlay's URL; otherwise the venue this device is registered to in
`remote.json`. That last step is the device's own — the browser has no way of
knowing where it is, and without it an element set to "Automatic" would be empty
on an appliance sitting in the venue whose ads it was put there to show. It is
last, so an overlay that does name a venue always wins, and
`OVERLAY_AD_DEVICE_VENUE=0` removes it. The resolved value is written onto
`binding.venue.id` so the renderer keeps the web component's rule rather than a
second one.

**Video ads are skipped.** The handoff to GStreamer is a PNG re-read on an mtime
poll; there is no way to play a video through it, and a still frame of an ad the
advertiser paid to have *play* would be worse than leaving it out. The browser
engine still plays them, so a venue whose ads are mostly video is a reason to
keep that box on `OVERLAY_ENGINE=chromium`.

**Impressions** are reported the way the web overlay reports them — one
`ad_events` row per ad shown, throttled to one per ad per minute per camera,
with the rotations inside that window carried as `rotation_count`. The row has
the shape the web app inserts, so the two are comparable: `screen_id` stays
`default`, and which box and camera it came from goes in the metadata
(`{"source":"overlay","renderer":"device","device":"dp-stream-b1b5","camera":1}`).

Three things are deliberately not counted:

- **Anything drawn while the camera is not streaming.** The overlay producer
  runs for as long as an overlay URL is configured, which on a venue box is
  most of the day, and an ad drawn into a PNG no pipeline is reading has been
  shown to nobody. `server.js` tells the producer when its stream starts and
  stops (`setStreamLive`), and `GET /api/overlay/engine` reports the current
  answer as `ads.counting`. Without it, every idle hour would bill the venue's
  advertisers.
- **Shadow renders** (`OVERLAY_SHADOW=1`) — the browser is the one on screen
  then, and it is already counting.
- **Two cameras at one venue are not deduplicated**: two streams are two
  audiences, and the web counts per page for the same reason.

Rows are POSTed to the `analyticsApi` cloud function's `/ad-events` route,
which checks every field and inserts as ClickHouse's insert-only `dp_ingest`
user — the password is a Google secret, server-side, and no database credential
lives on a device. That route is built for venue screens nobody signs in on, so
it accepts an anonymous POST, which is all the appliance can make: registration
keeps an identity, never a password.

It is deliberately **not** `recordAdImpressions`. That one is a Firebase
*callable* for the mobile app's match camera: it rejects a call without
`request.auth.uid` and labels its rows `match_camera`. Both write the same
`ad_events` table, so the Ad Center's reports count these either way.

`GET /api/overlay/engine` reports `ads.impressions` — `enabled`, `sent`,
`dropped`, `buffered` and the last error — so whether a box is counting is
visible from outside. Set `OVERLAY_AD_IMPRESSIONS=0` to stop a box reporting.

## Rollback

Three layers, fastest first:

1. **`OVERLAY_ENGINE=chromium`** in `.env`, then
   `sudo systemctl restart digitalpool-camera`. Back to the old behaviour
   completely. No code is reverted and no state is migrated.
2. **Per-overlay refusal.** The local engine is used only for a URL it can parse,
   an overlay mode whose queries are implemented, and a canvas containing no
   element type it cannot draw. Anything else uses the browser, silently.
3. **Runtime demotion.** If the local engine becomes unhealthy — its data source
   stops answering, or it finds an element it cannot draw — the overlay is handed
   back to Chromium mid-flight and the reason is logged. A demoted URL is not
   retried until restart, because flapping between renderers on a live stream
   would be worse than either.

A data outage never blanks a scoreboard: the last good frame stays on screen.

## Rolling it out

| phase | what to set | what to look for |
|---|---|---|
| 0 | nothing (default) | `✅ Overlay producer loaded (engine: chromium)` — unchanged behaviour |
| 1 | `OVERLAY_SHADOW=1` | `👻 shadow overlay frame: N ms` during a real match. Costs CPU; time-box it on N97 hardware, which already runs at its thermal limit. |
| 2 | `OVERLAY_ENGINE=auto` | `GET /api/overlay/engine` reports `activeEngine: "skia"`; watch for `demoted` entries |
| 3 | — | once no overlay needs the browser, confirm no Chromium is resident and measure |

```bash
# which engine is really drawing, per camera, and why
curl -s localhost:3000/api/overlay/engine | jq

# the resource question
systemctl show -p MemoryCurrent digitalpool-camera
pgrep -fa chromium | wc -l
journalctl -u digitalpool-camera -f | grep -E '🎛️|🎨|👻'
```

Shadow mode writes `/dev/shm/graphics-overlay.png.shadow.png`, which nothing
composites. Pull that and the real PNG off the device and diff them with
`tools/overlay-conformance` to see exactly where the two renderers disagree on
real tournament data.

## Current limitations

- **Tournament** and **venue** mode overlay URLs render locally. Event mode reads
  its match through a nested event→tournament structure that is not ported yet,
  so those URLs still use the browser.
- **`ad_center` is not covered by the conformance harness.** Its reference
  component runs three Apollo queries and logs an impression per ad, so scoring
  it means mounting the harness page inside an `ApolloProvider` and stubbing
  them — otherwise a conformance run would post impressions into production
  analytics. Everything else about it is verified against live ad data instead:
  the producer's `ads` block in `GET /api/overlay/engine` reports which venues
  it resolved, how many ads each returned, and what failed.
- All 21 element types are implemented. `player_avatar`, `static_image` and
  `tournament_logo` went unverified for a while because the old S3 bucket
  returned `AllAccessDisabled`; media has since moved to CloudFront and they
  draw.
- Carousel crossfades are **off** by default (`OVERLAY_CAROUSEL_FADE=1` enables
  them). The pipeline only re-reads the PNG on a 2 s mtime poll, so a 600 ms fade
  cannot be seen — it would cost 7 PNG encodes per carousel cycle instead of 1
  for nothing. Worth revisiting once the handoff is raw pixels.
- Some PNGs have to be repaired before they decode: `@napi-rs/canvas` rejects a
  file carrying a C2PA provenance chunk (`caBX`, written by Photoshop and most
  AI image tools) with the misleading "Invalid SVG image", so `loadImage()`
  retries once with ancillary chunks stripped. Venue ad creative comes out of
  exactly those tools — one of the nine ads running at the first venue tested
  against is such a file, and before this it simply did not draw.
- Fonts live in `assets/fonts/` (36 faces, 4.4 MB) and must ship in the device
  image. `fontFamily: inherit` resolves to UniformCondensed, which has only a 400
  weight, so weights 500–800 are synthesised — slightly differently from Chrome.

## Verifying fidelity

`tools/overlay-conformance` renders overlays with both the real web components
(in Chrome) and this renderer, and reports the pixel difference. Current state:

| corpus | result |
|---|---|
| 14 built-in example layouts | 0.9% of painted pixels |
| all 41 overlays readable from the database | 0.7% |
| synthetic fixture covering all 20 element types (pre-`ad_center`) | 0.2% |
| live production page, overlay #273 (40 elements, 16 types) | 0.1% |

The residual is glyph edge weight from synthesised bold, not geometry. See its
README.

## Where overlay media lives

Direct S3 URLs do not work and are not meant to: the `digital-pool` bucket is
private and everything is served through the CloudFront distribution in front of
it (`d2cqpja9v01i02.cloudfront.net`), with the pre-October-2026 bucket still
answering on `d1k23ln7af6dzb.cloudfront.net`. The database holds both, and plain
S3 URLs for media uploaded before the move.

`overlayAds.js` rewrites ad URLs to their CDN host exactly as the web app's
`transformToCdnUrl()` does, so an ad stored with an S3 URL still draws. Nothing
rewrites avatars or tournament logos — those arrive already pointing at
CloudFront — so a *stored* S3 URL on one of those would 403 here for the same
reason it does in the browser.
