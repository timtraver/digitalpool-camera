# Overlay conformance harness

Measures how closely `overlayRenderer.js` — the local Skia renderer that draws a
DigitalPool Overlay Builder canvas with no browser — reproduces what the web app
draws in Chrome today.

This exists because the device is meant to stop running headless Chromium to
produce `/dev/shm/graphics-overlay.png`. Venues design their overlay in the
builder and watch it in a browser preview; the device then has to draw the same
thing. "Looks about right" is not a usable standard for that, so this turns it
into a number.

## What it compares

| side | what it is |
|---|---|
| **reference** | The *real* `OverlayCanvasRenderer` / `ElementRenderer` React components imported straight out of `../../../digitalpool-antd`, mounted in headless Chrome. Nothing is reimplemented — if those components change, this follows. |
| **local** | `../../overlayRenderer.js`, drawing to a Skia surface in Node. |

Both are driven from the *same* inflated canvas JSON, which is read back out of
the reference page after it renders — so a difference is always renderer
behaviour and never differing input.

Three corpora:

| flag | corpus |
|---|---|
| *(default)* | the 14 built-in layouts in `overlay-builder/data/examples.js` |
| `--db` | every overlay the device can actually read from DigitalPool — what venues really run |
| `--kitchen` | a synthetic layout containing **all 20 element types**, so no type is scored only by hoping an example happened to use it |
| `--all` | `--db` + `--kitchen` |

Bindings come from the builder's `SAMPLE_BINDING`, enriched with real avatar and
logo URLs so image-bearing types are actually exercised rather than drawing empty
placeholders.

## Running it

```bash
npm install                      # once
node fetch-fonts.mjs             # once — downloads the font bundle (see below)
node run.mjs                     # built-in examples
node run.mjs --all               # real database overlays + the all-types fixture
node run.mjs --no-capture        # re-score without relaunching Chrome (fast loop)
node zoom.mjs <key> <x> <y> <w> <h> [scale]       # side-by-side pixel zoom
node live-test.mjs [overlayId] [seconds]          # the producer against LIVE data
```

A capture clears previous artifacts, so a run never mixes corpora.

Artifacts land in `out/`: `<example>.ref.png`, `.local.png`, `.diff.png` and
`.canvas.json`.

## Reading the score

`diff px` counts pixels pixelmatch considers different. Percentages are against
*painted* pixels (pixels either renderer touched), not the whole 1920x1080 frame
— most of an overlay frame is transparent, so a frame-relative number would make
everything look perfect.

`includeAA` is left at its default, so pixels that differ only because two
rasterisers antialias edges differently are not counted. What is counted is
geometry, colour, position and weight.

The `unsupported types` column lists element types `overlayRenderer.js` does not
implement. Those are excluded from the `supported` score and **must be empty**
before Chromium can be removed, since there would be nothing left to fall back
to.

## Fonts

`fetch-fonts.mjs` pulls exactly the families and weights in the builder's font
dropdown (`PropertiesPanel.js`) — which are the ones `digitalpool-antd/public/
index.html` loads — plus the two custom faces that ship with the web app. This
is the same bundle the device needs; it is gitignored here only because it is
reproducible.

It deliberately asks Google Fonts with a 2008-era user agent. A modern UA is
served several unicode-range-subsetted files per weight, and Skia registers one
file per family+weight — so the naive fetch silently produces a latin-only face
and drops the diacritics in names like "Nguyễn".

## Unreachable images

An image URL the harness cannot fetch is **not** a renderer difference: Chrome
paints its broken-image placeholder where we paint nothing. Elements bound to a
dead URL are excluded from the score and listed at the end of the run, so a dead
link can never be mistaken for a defect.

## Known residual

~0.7% of painted pixels across the real-overlay corpus, almost entirely glyph
edge weight. The builder lets a user pick font weights 500–800, but
`fontFamily: inherit` resolves to UniformCondensed, which ships a 400 face only —
so both renderers synthesise bold, and they synthesise it slightly differently.
Shipping real weighted faces would close it; nothing else will.
