// Per-element residual for ONE overlay, from artifacts a run.mjs capture left
// behind:  node perel.mjs block_scoreboard
//
// run.mjs attributes residual by element TYPE across the whole corpus, which
// says which types are weak but not which element in which overlay. This says
// that, and is how the empty-image_carousel placeholder was found: ten example
// overlays sat at 20-40% diff, and in each of them a single carousel element
// was ~97% of it.
//
// Element boxes overlap, so a pixel can be counted for more than one element.
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

const OUT = '/Users/timtraver/Projects/digitalpool-camera/tools/overlay-conformance/out';
const key = process.argv[2];
const ref = PNG.sync.read(fs.readFileSync(path.join(OUT, `${key}.ref.png`)));
const loc = PNG.sync.read(fs.readFileSync(path.join(OUT, `${key}.local.png`)));
const { canvas } = JSON.parse(fs.readFileSync(path.join(OUT, `${key}.canvas.json`), 'utf8'));

function score(el) {
  const pad = 2;
  const x0 = Math.max(0, Math.floor(el.x) - pad), y0 = Math.max(0, Math.floor(el.y) - pad);
  const x1 = Math.min(ref.width, Math.ceil(el.x + el.w) + pad), y1 = Math.min(ref.height, Math.ceil(el.y + el.h) + pad);
  const w = x1 - x0, h = y1 - y0;
  if (w <= 0 || h <= 0) return { diff: 0, ink: 0 };
  const a = Buffer.alloc(w * h * 4), c = Buffer.alloc(w * h * 4);
  let ink = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = ((y0 + y) * ref.width + (x0 + x)) * 4, d = (y * w + x) * 4;
    ref.data.copy(a, d, s, s + 4); loc.data.copy(c, d, s, s + 4);
    if (ref.data[s + 3] > 8 || loc.data[s + 3] > 8) ink++;
  }
  const diff = pixelmatch(a, c, null, w, h, { threshold: 0.1 });
  return { diff, ink };
}

const rows = canvas.elements.filter(e => e.visible !== false).map((el, i) => {
  const { diff, ink } = score(el);
  return { i, type: el.type, w: el.w, h: el.h, fit: !!el.fit, size: (el.style||{}).fontSize, diff, ink,
           pct: ink ? (diff / ink * 100) : 0 };
}).sort((a, b) => b.diff - a.diff);

console.log(`${key}`);
console.log(`${'#'.padStart(3)} ${'type'.padEnd(26)} ${'box'.padEnd(11)} ${'fit'} ${'sz'.padStart(3)} ${'diff'.padStart(7)} ${'ink'.padStart(7)} ${'%'.padStart(6)}`);
for (const r of rows) {
  console.log(`${String(r.i).padStart(3)} ${r.type.padEnd(26)} ${`${r.w}x${r.h}`.padEnd(11)} ${r.fit ? ' Y ' : ' . '} ${String(r.size ?? '').padStart(3)} ${String(r.diff).padStart(7)} ${String(r.ink).padStart(7)} ${r.pct.toFixed(1).padStart(5)}%`);
}
