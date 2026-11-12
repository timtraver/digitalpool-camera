// What an overlay looks like BETWEEN matches — the state a venue box is in for
// most of its day, and the one no corpus covers because every binding in them
// carries a live match.
//
// Re-captures canvases the last run left in out/ against an EMPTY binding, so
// `matchOnly` and `ballCountOnly` are actually exercised on both sides.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { captureCanvases } from './reference/shot.mjs';

const require = createRequire(import.meta.url);
const renderer = require('../../overlayRenderer.js');
const HERE = path.dirname(new URL(import.meta.url).pathname);
const OUT = path.join(HERE, 'out');
const IDLE = path.join(HERE, 'out-idle');

const EMPTY = {
  venue: { id: null },
  tournament: { id: null, name: '', slug: '', location: '', logo: null, game_type: '',
    winners_race_to: null, losers_race_to: null, tournament_type: '', enable_match_clock: false, match_time_limit: null },
  table: { id: null, slug: '', label: '' },
  match: { identifier: '', race_to: null, status: '', scheduled_time: null, start_time: null, end_time: null,
    round: null, is_semi_finals: false, is_finals: false, is_consolidation_finals: false, game_type_key: null,
    challenger1_name: '', challenger1_country: '', challenger1_score: '', challenger1_points: '',
    challenger1_race_to: '', challenger1_skill_level: '', challenger1_avatarImg: null, challenger1_is_playing: false,
    challenger2_name: '', challenger2_country: '', challenger2_score: '', challenger2_points: '',
    challenger2_race_to: '', challenger2_skill_level: '', challenger2_avatarImg: null, challenger2_is_playing: false },
};

const keys = fs.readdirSync(OUT).filter((f) => f.endsWith('.canvas.json')).map((f) => f.replace('.canvas.json', ''));
const items = keys.map((key) => ({ key, canvas: JSON.parse(fs.readFileSync(path.join(OUT, `${key}.canvas.json`), 'utf8')).canvas, binding: EMPTY }));

fs.rmSync(IDLE, { recursive: true, force: true });
fs.mkdirSync(IDLE, { recursive: true });
await captureCanvases(items, IDLE);
renderer.registerFonts(path.join(HERE, '..', '..', 'assets', 'fonts'));

let totalDiff = 0, totalInk = 0;
const rows = [];
const failedImages = new Map();
for (const key of keys) {
  const refPath = path.join(IDLE, `${key}.ref.png`);
  if (!fs.existsSync(refPath)) continue;
  const ref = PNG.sync.read(fs.readFileSync(refPath));
  const { canvas } = JSON.parse(fs.readFileSync(path.join(IDLE, `${key}.canvas.json`), 'utf8'));
  const urls = renderer.imageUrls(canvas, EMPTY, null);
  const images = new Map();
  for (const u of urls) {
    try { images.set(u, await renderer.loadImage(u)); }
    // A swallowed load failure makes this measurement lie: the reference draws
    // the picture, the local render leaves a hole, and the diff is reported as
    // a renderer difference. Say so instead.
    catch (err) { failedImages.set(u, err.message); }
  }
  const surface = renderer.renderCanvas(canvas, EMPTY, { images, now: 1000, animationNow: 1000 });
  const loc = PNG.sync.read(surface.toBuffer('image/png'));
  let ink = 0;
  for (let i = 3; i < ref.data.length; i += 4) if (ref.data[i] > 8 || loc.data[i] > 8) ink++;
  const diff = pixelmatch(ref.data, loc.data, null, ref.width, ref.height, { threshold: 0.1 });
  const shows = renderer._internals.showsElement || ((e) => e.visible !== false);
  const drawn = canvas.elements.filter((e) => shows(e, EMPTY)).length;
  rows.push({ key, diff, ink, drawn, total: canvas.elements.length });
  totalDiff += diff; totalInk += ink;
}
rows.sort((a, b) => b.diff - a.diff);
console.log(`${'overlay'.padEnd(34)} ${'drawn'.padStart(7)} ${'diff'.padStart(8)} ${'ink'.padStart(8)}`);
for (const r of rows) console.log(`${r.key.padEnd(34)} ${`${r.drawn}/${r.total}`.padStart(7)} ${String(r.diff).padStart(8)} ${String(r.ink).padStart(8)}`);
if (failedImages.size) {
  console.log(`\n⚠️  ${failedImages.size} image URL(s) unreachable — the local render has a hole the reference does not`);
  for (const [url, err] of failedImages) console.log(`   ${err}  ${url.slice(0, 90)}`);
}
console.log(`${'TOTAL'.padEnd(34)} ${''.padStart(7)} ${String(totalDiff).padStart(8)} ${String(totalInk).padStart(8)}   ${totalInk ? (totalDiff/totalInk*100).toFixed(1) : 0}% of ink`);
