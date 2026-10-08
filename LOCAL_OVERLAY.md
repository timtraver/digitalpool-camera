# Local overlay rendering (no browser)

Draws the venue's DigitalPool overlay on the device with Skia, instead of running
headless Chromium to screenshot the overlay page.

**Nothing changes until `OVERLAY_ENGINE=auto` is set.** The default is `chromium`,
which is the behaviour this device has always had.

## Why

Today every overlay frame costs a full-page Chromium render plus a 1080p PNG
encode, every 2 seconds, per camera — and a resident browser. Removing it:

- gives back ~150–250 MB of RSS against the `MemoryMax=2500M` cap in
  `digitalpool-camera.service` (that cap exists because of an OOM that took the
  WiFi driver down with it)
- removes a ~1-core spike every 2 s per camera, plus the screenshot stagger and
  the global capture mutex that exist only to stop two browser captures colliding
- removes the hourly Chromium restart, during which the overlay goes dark for 2–3 s
- redraws when the score actually changes rather than sampling on a timer

It does **not** touch the per-frame compositing cost (the NV12↔BGRA round-trip),
which is the larger steady-state load. Expect the spikes to go, not the overlay to
become free.

## How the pieces fit

```
overlayProducer.js   picks the engine, and falls back
  ├── puppeteerOverlay.js   headless Chromium  (unchanged)
  └── skiaOverlay.js        local renderer
        ├── overlayDataSource.js   overlay canvas + live match binding
        └── overlayRenderer.js     draws the canvas to a Skia surface
```

Both engines write the same `/dev/shm/graphics-overlay[-2].png`. Nothing
downstream can tell which one produced it — `gst-overlay-pipeline.py` still
hot-swaps on mtime, and `effectiveOverlay()` still decides whose overlay shows.
`server.js` requires `overlayProducer` in place of `puppeteerOverlay`; every call
site is unchanged.

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

- **`user_overlays` is not readable by Hasura's anonymous role**, so the device
  cannot fetch the overlay canvas yet. Live match data (`tournaments`,
  `pool_tables`) already is. Either grant that role SELECT on
  `user_overlays(id, user_id, name, is_public, is_example, canvas)`, or set
  `OVERLAY_SOURCE_FUNCTION` to a cloud function that returns it. **Until one of
  those exists, `auto` always falls back to the browser** — safely, but with no
  benefit.
- **Tournament** and **venue** mode overlay URLs render locally. Event mode reads
  its match through a nested event→tournament structure that is not ported yet,
  so those URLs still use the browser.
- **`image_carousel` is not implemented** — the one element type that needs a
  frame loop rather than redraw-on-change. Any overlay using it falls back.
- `player_avatar`, `static_image` and `tournament_logo` are implemented but
  currently unverifiable, because every image in the DigitalPool S3 bucket
  returns `AllAccessDisabled` (see below). The other 16 types are verified.
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
| synthetic fixture covering all 20 element types | 0.2% |

The residual is glyph edge weight from synthesised bold, not geometry. See its
README.

## Unrelated but blocking: the S3 bucket is disabled

Every object under `digitalpool.s3.amazonaws.com` and
`digitalpool.s3.us-west-1.amazonaws.com` currently returns HTTP 403
`AllAccessDisabled`, including the bucket root — avatars, tournament logos and
every custom overlay image. This is an AWS-level block on the bucket, not a
permissions setting, and it affects the existing browser-based overlays exactly
as much as this one. Overlays that are mostly a custom background image are
rendering blank in production right now.
