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

Twice the streams, half the CPU, 200 MB back. The browser also screenshotted on a
timer regardless of whether the scoreboard had moved — 10 rewrites in 20 s with
identical content — where the local renderer redraws on an actual change.

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
- Carousel crossfades are **off** by default (`OVERLAY_CAROUSEL_FADE=1` enables
  them). The pipeline only re-reads the PNG on a 2 s mtime poll, so a 600 ms fade
  cannot be seen — it would cost 7 PNG encodes per carousel cycle instead of 1
  for nothing. Worth revisiting once the handoff is raw pixels.
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
| live production page, overlay #273 (40 elements, 16 types) | 0.1% |

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
