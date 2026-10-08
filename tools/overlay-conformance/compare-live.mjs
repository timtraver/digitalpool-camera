// End-to-end conformance against PRODUCTION: loads the real digitalpool.com
// overlay page in Chrome exactly as the device does today, renders the same
// overlay locally, and diffs them.
//
// This is the strongest check available, because unlike run.mjs it exercises the
// data layer too — if overlayDataSource fetched the wrong match, or resolved a
// venue differently from the web app, it shows up as pixels.
//
//   node compare-live.mjs <overlayUrl> [settleMs] [nowMs]
//
// Carousels: the browser advances from whenever the page mounted, the local
// renderer derives its index from a clock. To compare like with like, the page
// is captured early (while it is still on image 0) and the local render is given
// a `now` that also resolves to image 0, settled. Pass a different nowMs to
// compare a later slot.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'out');
const renderer = require('../../overlayRenderer.js');
const dataSource = require('../../overlayDataSource.js');

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
];

const url = process.argv[2];
const settleMs = Number(process.argv[3] || 3500);
// 1000 ms lands in slot 0 for any interval >= 1 s, and past the 600 ms fade, so
// every carousel is settled on its first image.
const nowMs = Number(process.argv[4] || 1000);
if (!url) { console.error('usage: node compare-live.mjs <overlayUrl> [settleMs]'); process.exit(1); }

const parsed = dataSource.parseOverlayUrl(url);
if (!parsed) { console.error('not a DigitalPool overlay URL'); process.exit(2); }
console.log(`overlay  : #${parsed.overlayId}  (${parsed.mode} ${parsed.slug}/${parsed.tableSlug})`);

// ── Reference: the real production page, in a real browser ──────────────────
const puppeteer = require('puppeteer-core');
const executablePath = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
if (!executablePath) { console.error('no Chrome/Chromium found'); process.exit(3); }

fs.mkdirSync(OUT, { recursive: true });
const refPath = path.join(OUT, 'live.ref.png');
const locPath = path.join(OUT, 'live.local.png');

const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--force-device-scale-factor=1', '--hide-scrollbars'],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
  // Two loads. The first is only to warm Chrome's image cache: an overlay with
  // several carousels pulls down a lot of artwork, and waiting for that on the
  // capture load would let its carousels advance past image 0, which is the one
  // slot we can compare against a clock-driven renderer. The second load starts
  // every carousel afresh with the images already cached.
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
  await new Promise((r) => setTimeout(r, 4000));
  await page.goto('about:blank');
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
  // The page runs its own queries and subscriptions after load; give it a moment
  // to settle on real data, the same way the device's screenshot loop waits out
  // jsDelay. Keep this under the shortest carousel interval.
  await new Promise((r) => setTimeout(r, settleMs));
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map((i) => (i.complete ? null : new Promise((r) => { i.onload = i.onerror = r; }))));
  });
  await page.screenshot({ path: refPath, omitBackground: true });
  console.log(`reference: ${refPath}`);
} finally {
  await browser.close();
}

// ── Local: the same overlay, drawn here ─────────────────────────────────────
renderer.registerFonts(path.join(HERE, '..', '..', 'assets', 'fonts'));
const canvas = await dataSource.fetchCanvas(parsed.overlayId);
const binding = await dataSource.fetchBinding(parsed);
const missing = renderer.unsupportedTypes(canvas);
if (missing.length) console.log(`note     : unsupported element types present: ${missing.join(', ')}`);

const images = new Map();
for (const u of renderer.imageUrls(canvas, binding, null)) {
  try {
    const buf = /^https?:/.test(u)
      ? Buffer.from(await (await fetch(u)).arrayBuffer())
      : fs.readFileSync(u);
    images.set(u, await renderer.loadImage(buf));
  } catch (e) {
    console.log(`warn     : image unavailable (${u.slice(0, 70)}): ${e.message}`);
  }
}
const t0 = Date.now();
const surface = renderer.renderCanvas(canvas, binding, { images, now: nowMs });
const buf = await surface.encode('png');
const drawMs = Date.now() - t0;
fs.writeFileSync(locPath, buf);
console.log(`local    : ${locPath}  (${drawMs} ms)`);

// ── Score ───────────────────────────────────────────────────────────────────
const ref = PNG.sync.read(fs.readFileSync(refPath));
const loc = PNG.sync.read(fs.readFileSync(locPath));
if (ref.width !== loc.width || ref.height !== loc.height) {
  console.log(`size mismatch: ref ${ref.width}x${ref.height} vs local ${loc.width}x${loc.height}`);
  process.exit(4);
}
const diff = new PNG({ width: ref.width, height: ref.height });
const differing = pixelmatch(ref.data, loc.data, diff.data, ref.width, ref.height, { threshold: 0.1, alpha: 0.3 });
fs.writeFileSync(path.join(OUT, 'live.diff.png'), PNG.sync.write(diff));

let ink = 0;
for (let i = 3; i < ref.data.length; i += 4) if (ref.data[i] > 8 || loc.data[i] > 8) ink++;
console.log(`\ndiff     : ${differing} px  (${ink ? ((100 * differing) / ink).toFixed(1) : '—'}% of painted pixels)`);
console.log(`artifacts: ${OUT}/live.{ref,local,diff}.png`);
