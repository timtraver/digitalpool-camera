// Conformance run: render every built-in example overlay with BOTH renderers and
// score the difference.
//
//   reference  = the real React components from digitalpool-antd, in Chrome
//   local      = ../../overlayRenderer.js, Skia, no browser
//
// Both are driven from the same inflated canvas JSON (pulled out of the reference
// page), so any difference is renderer behaviour and not differing input.
//
// Element types the local renderer does not implement are excluded from the
// "supported" score and reported separately — otherwise an unimplemented flag
// would hide a text-layout regression.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { captureAll, captureCanvases } from './reference/shot.mjs';
import { databaseOverlays, kitchenSink, richBinding, sampleBinding } from './corpus.mjs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'out');
const renderer = require('../../overlayRenderer.js');

// Per-pixel colour tolerance. 0.1 is pixelmatch's default and is deliberately
// strict: antialiasing differences between two text rasterisers show up at this
// threshold, which is exactly what we want to see.
const THRESHOLD = 0.1;

// Decoding goes through renderer.loadImage so the Image comes from the SAME
// native @napi-rs/canvas instance the renderer draws with — one produced by this
// directory's own copy is rejected by drawImage.
async function loadImages(canvas, binding) {
  const images = new Map();
  for (const url of renderer.imageUrls(canvas, binding, null)) {
    try {
      if (failedImages.has(url)) continue;
      const buf = url.startsWith('data:')
        ? Buffer.from(url.slice(url.indexOf(',') + 1), 'base64')
        : /^https?:/.test(url)
          ? Buffer.from(await (await fetch(url)).arrayBuffer())
          : fs.readFileSync(url); // the six locally-bundled flag assets
      images.set(url, await renderer.loadImage(buf));
    } catch (e) {
      failedImages.set(url, e.message);
    }
  }
  return images;
}

// Images the harness could not fetch at all. These are NOT renderer differences:
// Chrome paints its broken-image placeholder where we paint nothing, so scoring
// them would report a defect in the renderer for what is a dead URL. Elements
// bound to one are excluded from the score and reported separately.
const failedImages = new Map();

// Axis-aligned bounds of an element box after rotation — used to exclude
// unsupported elements from the score.
function elementBounds(el) {
  const cx = el.x + el.w / 2, cy = el.y + el.h / 2;
  const rad = ((el.rotation || 0) * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad)), sin = Math.abs(Math.sin(rad));
  const w = el.w * cos + el.h * sin, h = el.w * sin + el.h * cos;
  return { x0: Math.floor(cx - w / 2), y0: Math.floor(cy - h / 2), x1: Math.ceil(cx + w / 2), y1: Math.ceil(cy + h / 2) };
}

function deadImageElement(el, binding) {
  const url = renderer._internals.imageUrlFor(el, binding, null);
  return !!(url && failedImages.has(url));
}

function score(refPng, locPng, canvas, binding, diffPath) {
  const { width, height } = refPng;
  const diff = new PNG({ width, height });
  // pixelmatch returns the mismatch count; the diff image is for eyeballing.
  // Its default includeAA:false means pixels that differ only because the two
  // rasterisers antialias differently are not counted — which is the right call
  // here, since no two text engines agree on edge pixels and we are looking for
  // layout and colour differences, not subpixel noise.
  const total = pixelmatch(refPng.data, locPng.data, diff.data, width, height, {
    threshold: THRESHOLD,
    alpha: 0.3,
  });
  fs.writeFileSync(diffPath, PNG.sync.write(diff));

  // Score again with every unsupported element's box blanked in BOTH images, so
  // those regions compare equal and drop out of the count.
  const masked = [];
  for (const el of canvas.elements || []) {
    if (el.visible === false) continue;
    if (!renderer.SUPPORTED.has(el.type) || deadImageElement(el, binding)) masked.push(elementBounds(el));
  }
  let inSupported = total;
  const refM = Buffer.from(refPng.data);
  const locM = Buffer.from(locPng.data);
  if (masked.length) {
    for (const b of masked) {
      for (let y = Math.max(0, b.y0); y < Math.min(height, b.y1); y++) {
        for (let x = Math.max(0, b.x0); x < Math.min(width, b.x1); x++) {
          const i = (y * width + x) * 4;
          refM.fill(0, i, i + 4);
          locM.fill(0, i, i + 4);
        }
      }
    }
    inSupported = pixelmatch(refM, locM, null, width, height, { threshold: THRESHOLD });
  }

  // Denominators: pixels either renderer actually painted. A percentage of the
  // whole 1920x1080 frame would be meaningless when an overlay is a thin strip.
  let refInk = 0, supportedInk = 0;
  for (let i = 0; i < refPng.data.length; i += 4) {
    if (refPng.data[i + 3] > 8 || locPng.data[i + 3] > 8) {
      refInk++;
      if (refM[i + 3] > 8 || locM[i + 3] > 8) supportedInk++;
    }
  }
  return { total, inSupported, refInk, supportedInk, width, height };
}

// Which corpus to compare against:
//   (default) the 14 built-in builder examples
//   --db      every overlay actually readable from DigitalPool
//   --kitchen a synthetic layout containing all 20 element types
//   --all     database overlays + kitchen sink
// A capture always clears previous artifacts so a run never mixes corpora.
const skipCapture = process.argv.includes('--no-capture');
const useDb = process.argv.includes('--db') || process.argv.includes('--all');
const useKitchen = process.argv.includes('--kitchen') || process.argv.includes('--all');

if (!skipCapture) {
  if (fs.existsSync(OUT)) {
    for (const f of fs.readdirSync(OUT)) {
      if (/\.(ref|local|diff)\.png$|\.canvas\.json$/.test(f)) fs.unlinkSync(path.join(OUT, f));
    }
  }
  if (!useDb && !useKitchen) {
    await captureAll(OUT);
  } else {
    // The sample binding leaves avatars and logos null, so image-bearing element
    // types would never actually be compared — enrich it with real URLs.
    const binding = richBinding(sampleBinding());
    const items = [];
    if (useDb) items.push(...(await databaseOverlays()));
    if (useKitchen) items.push(kitchenSink());
    await captureCanvases(items.map((i) => ({ ...i, binding })), OUT);
  }
}

renderer.registerFonts(path.join(HERE, '..', '..', 'assets', 'fonts'));

const keys = fs
  .readdirSync(OUT)
  .filter((f) => f.endsWith('.canvas.json'))
  .map((f) => f.replace('.canvas.json', ''))
  .sort();

// Crops both images to one element's box and scores just that, so the residual
// can be attributed to element types. Boxes that overlap are counted for each
// element they belong to, so these are per-type diagnostics, not a partition.
function scoreElement(refPng, locPng, el) {
  const b = elementBounds(el);
  const x0 = Math.max(0, b.x0), y0 = Math.max(0, b.y0);
  const x1 = Math.min(refPng.width, b.x1), y1 = Math.min(refPng.height, b.y1);
  const w = x1 - x0, h = y1 - y0;
  if (w <= 0 || h <= 0) return { diff: 0, ink: 0 };
  const a = Buffer.alloc(w * h * 4), c = Buffer.alloc(w * h * 4);
  let ink = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const src = ((y0 + y) * refPng.width + (x0 + x)) * 4;
      const dst = (y * w + x) * 4;
      refPng.data.copy(a, dst, src, src + 4);
      locPng.data.copy(c, dst, src, src + 4);
      if (refPng.data[src + 3] > 8 || locPng.data[src + 3] > 8) ink++;
    }
  }
  return { diff: pixelmatch(a, c, null, w, h, { threshold: THRESHOLD }), ink };
}

const byType = new Map();
const rows = [];
for (const key of keys) {
  const { canvas, binding } = JSON.parse(fs.readFileSync(path.join(OUT, `${key}.canvas.json`), 'utf8'));
  const images = await loadImages(canvas, binding);
  const surface = renderer.renderCanvas(canvas, binding, { images });
  const localPath = path.join(OUT, `${key}.local.png`);
  fs.writeFileSync(localPath, surface.toBuffer('image/png'));

  const refPng = PNG.sync.read(fs.readFileSync(path.join(OUT, `${key}.ref.png`)));
  const locPng = PNG.sync.read(fs.readFileSync(localPath));
  const s = score(refPng, locPng, canvas, binding, path.join(OUT, `${key}.diff.png`));
  const unsupported = renderer.unsupportedTypes(canvas);
  rows.push({ key, ...s, unsupported });

  for (const el of canvas.elements || []) {
    if (el.visible === false || !renderer.SUPPORTED.has(el.type)) continue;
    if (deadImageElement(el, binding)) continue;
    const e = scoreElement(refPng, locPng, el);
    const acc = byType.get(el.type) || { diff: 0, ink: 0, n: 0 };
    acc.diff += e.diff; acc.ink += e.ink; acc.n++;
    byType.set(el.type, acc);
  }
}

const pct = (n, d) => (d ? ((100 * n) / d).toFixed(1) + '%' : '—');
console.log('\n' + '─'.repeat(96));
console.log('overlay'.padEnd(34), 'diff px'.padStart(9), 'of ink'.padStart(8), 'supported'.padStart(10), 'unsupported types');
console.log('─'.repeat(96));
for (const r of rows) {
  console.log(
    r.key.padEnd(34),
    String(r.total).padStart(9),
    pct(r.total, r.refInk).padStart(8),
    pct(r.inSupported, r.supportedInk).padStart(10),
    r.unsupported.join(',') || '—'
  );
}
const sum = (f) => rows.reduce((a, r) => a + r[f], 0);
console.log('─'.repeat(96));
console.log(
  'TOTAL'.padEnd(34),
  String(sum('total')).padStart(9),
  pct(sum('total'), sum('refInk')).padStart(8),
  pct(sum('inSupported'), sum('supportedInk')).padStart(10)
);
console.log('\nresidual by element type (boxes overlap, so these are diagnostics, not a partition)');
console.log('─'.repeat(60));
console.log('element type'.padEnd(30), 'count'.padStart(6), 'diff px'.padStart(9), 'of ink'.padStart(8));
console.log('─'.repeat(60));
for (const [type, a] of [...byType.entries()].sort((x, y) => y[1].diff - x[1].diff)) {
  console.log(type.padEnd(30), String(a.n).padStart(6), String(a.diff).padStart(9), pct(a.diff, a.ink).padStart(8));
}

// The corpus only exercises the element types the built-in examples happen to
// use, so say plainly which supported types the score does NOT cover — and which
// types nothing can draw yet.
const exercised = new Set(byType.keys());
const untested = [...renderer.SUPPORTED].filter((t) => !exercised.has(t)).sort();
const ALL_TYPES = [
  'player_name', 'player_flag', 'player_score', 'player_points', 'player_avatar',
  'player_skill_level', 'player_race_to', 'race_to', 'match_status', 'match_clock',
  'table_label', 'tournament_name', 'tournament_location', 'tournament_game_type',
  'tournament_game_type_image', 'tournament_logo', 'static_text', 'static_image',
  'shape', 'image_carousel',
];
const missing = ALL_TYPES.filter((t) => !renderer.SUPPORTED.has(t));
if (failedImages.size) {
  console.log(`\n⚠️  ${failedImages.size} image URL(s) unreachable — elements using them were EXCLUDED from the score`);
  for (const [url, err] of failedImages) console.log(`   ${err}  ${url.slice(0, 90)}`);
}

console.log(`\ncoverage: ${exercised.size}/${ALL_TYPES.length} element types exercised by this corpus`);
if (untested.length) console.log(`  implemented but untested here : ${untested.join(', ')}`);
if (missing.length) console.log(`  NOT IMPLEMENTED               : ${missing.join(', ')}`);

console.log(`\nartifacts in ${OUT} (*.ref.png / *.local.png / *.diff.png)`);
