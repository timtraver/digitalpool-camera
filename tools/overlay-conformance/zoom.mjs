// Side-by-side zoom of one region, reference above local — for eyeballing what a
// residual actually looks like. Usage:
//   node zoom.mjs <example> <x> <y> <w> <h> [scale]
import fs from 'node:fs';
import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';

const [key, x, y, w, h, scale = 6] = process.argv.slice(2);
if (!key) { console.error('usage: node zoom.mjs <example> <x> <y> <w> <h> [scale]'); process.exit(1); }
const [X, Y, W, H, S] = [x, y, w, h, scale].map(Number);

const out = createCanvas(W * S, H * S * 2 + 24);
const c = out.getContext('2d');
c.fillStyle = '#11161c';
c.fillRect(0, 0, out.width, out.height);
c.imageSmoothingEnabled = false;
for (const [i, kind] of ['ref', 'local'].entries()) {
  const img = await loadImage(fs.readFileSync(path.join('out', `${key}.${kind}.png`)));
  c.drawImage(img, X, Y, W, H, 0, i * (H * S + 24), W * S, H * S);
}
const dest = path.join('out', `_zoom_${key}.png`);
fs.writeFileSync(dest, out.toBuffer('image/png'));
console.log(`${dest} — top: Chrome reference, bottom: local Skia`);
