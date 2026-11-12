import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
const OUT = '/Users/timtraver/Projects/digitalpool-camera/tools/overlay-conformance/out';
const keys = fs.readdirSync(OUT).filter(f => f.endsWith('.canvas.json')).map(f => f.replace('.canvas.json',''));
const acc = new Map();
const add = (k, diff, ink) => { const a = acc.get(k) || {diff:0, ink:0, n:0}; a.diff+=diff; a.ink+=ink; a.n++; acc.set(k,a); };
for (const key of keys) {
  const ref = PNG.sync.read(fs.readFileSync(path.join(OUT, `${key}.ref.png`)));
  const loc = PNG.sync.read(fs.readFileSync(path.join(OUT, `${key}.local.png`)));
  const { canvas } = JSON.parse(fs.readFileSync(path.join(OUT, `${key}.canvas.json`), 'utf8'));
  for (const el of canvas.elements) {
    if (el.visible === false) continue;
    const x0 = Math.max(0, Math.floor(el.x)-2), y0 = Math.max(0, Math.floor(el.y)-2);
    const x1 = Math.min(ref.width, Math.ceil(el.x+el.w)+2), y1 = Math.min(ref.height, Math.ceil(el.y+el.h)+2);
    const w = x1-x0, h = y1-y0; if (w<=0||h<=0) continue;
    const a = Buffer.alloc(w*h*4), c = Buffer.alloc(w*h*4); let ink = 0;
    for (let y=0;y<h;y++) for (let x=0;x<w;x++) {
      const s = ((y0+y)*ref.width + (x0+x))*4, d = (y*w+x)*4;
      ref.data.copy(a,d,s,s+4); loc.data.copy(c,d,s,s+4);
      if (ref.data[s+3]>8 || loc.data[s+3]>8) ink++;
    }
    const diff = pixelmatch(a,c,null,w,h,{threshold:0.1});
    const group = process.argv[2] === 'fit' ? (el.fit ? 'fit=Y' : 'fit=.')
                : process.argv[2] === 'both' ? `${el.type} ${el.fit?'fit':'   '}`
                : el.type;
    add(group, diff, ink);
  }
}
const rows = [...acc].sort((x,y)=>y[1].diff - x[1].diff);
console.log(`${'group'.padEnd(32)} ${'n'.padStart(4)} ${'diff'.padStart(8)} ${'ink'.padStart(9)} ${'%'.padStart(7)}`);
for (const [k,v] of rows) console.log(`${k.padEnd(32)} ${String(v.n).padStart(4)} ${String(v.diff).padStart(8)} ${String(v.ink).padStart(9)} ${(v.ink?v.diff/v.ink*100:0).toFixed(1).padStart(6)}%`);
