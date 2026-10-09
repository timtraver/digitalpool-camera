// Downloads the exact font set the Overlay Builder's font dropdown can produce,
// as TTF, for the local Skia renderer. The families/weights below are copied
// from digitalpool-antd/public/index.html's Google Fonts <link> — the same set
// Chrome loads for the reference render, so metrics match by construction.
//
// Output: fonts/<Family>-<weight>.ttf (+ the two custom WOFF2 faces, copied from antd)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The production bundle: overlayRenderer.registerFonts() reads this at startup
// on the device, and the harness registers the very same files.
const OUT = path.join(HERE, '..', '..', 'assets', 'fonts');
const ANTD = '/Users/timtraver/Projects/digitalpool-antd';

// family -> weights, verbatim from the antd Google Fonts link.
const GOOGLE = {
  'Anton': [400],
  'Barlow Condensed': [400, 600, 700],
  'Bebas Neue': [400],
  'Exo 2': [400, 600, 700],
  'Lato': [400, 700],
  'Montserrat': [400, 600, 700],
  'Open Sans': [400, 600, 700],
  'Orbitron': [400, 700],
  'Oswald': [400, 600, 700],
  'Rajdhani': [400, 600, 700],
  'Roboto': [400, 700],
  'Roboto Condensed': [400, 700],
  'Saira Condensed': [400, 600, 700],
  'Teko': [400, 600, 700],
};

// Why a 2008 Firefox UA: the Google Fonts API tailors its response to the
// client. A modern browser is handed several unicode-range-subsetted WOFF2
// files per weight (latin / latin-ext / vietnamese), which is right for a web
// page but wrong for us — Skia registers one file per family+weight, so we
// would silently ship a latin-only face and lose the diacritics in names like
// "Nguyễn". A UA predating unicode-range support gets a single UNSUBSETTED TTF
// with the full charset, which is exactly one face per weight. Same outlines
// Chrome renders, so the reference and the local renderer stay comparable.
const UA = 'Mozilla/5.0 (Windows; U; Windows NT 5.1; en-US; rv:1.9.0.1) Gecko/2008070208 Firefox/3.0.1';

// One request per weight: with the legacy UA the API collapses a multi-weight
// request down to a single face, so asking for all weights at once silently
// returns only the regular.
async function ttfUrlsFor(family, weight) {
  const spec = `${family.replace(/ /g, '+')}:wght@${weight}`;
  const url = `https://fonts.googleapis.com/css2?family=${spec}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${family}: css2 ${res.status}`);
  const css = await res.text();
  // Each @font-face block carries one weight and one src url.
  const u = css.match(/url\((https:\/\/[^)]+)\)/);
  if (!u) throw new Error(`${family} ${weight}: no url in css`);
  return u[1];
}

fs.mkdirSync(OUT, { recursive: true });
let count = 0;
for (const [family, weights] of Object.entries(GOOGLE)) {
  for (const weight of weights) {
    let url;
    try {
      url = await ttfUrlsFor(family, weight);
    } catch (e) {
      console.error(`✗ ${family} ${weight}: ${e.message}`);
      continue;
    }
    const ext = path.extname(new URL(url).pathname) || '.ttf';
    const file = path.join(OUT, `${family.replace(/ /g, '')}-${weight}${ext}`);
    const buf = Buffer.from(await (await fetch(url, { headers: { 'User-Agent': UA } })).arrayBuffer());
    fs.writeFileSync(file, buf);
    count++;
    console.log(`✓ ${path.basename(file)} (${(buf.length / 1024).toFixed(0)} KB)`);
  }
}

// The two "Custom" fonts ship with the web app as WOFF2/WOFF only.
for (const [src, dest] of [
  [`${ANTD}/public/fonts/uniform-condensed/uniform_condensed-webfont.woff2`, 'UniformCondensed-400.woff2'],
  [`${ANTD}/public/fonts/gill-sans-mt-condensed/gilc____.woff2`, 'GillSansMTCondensed-400.woff2'],
]) {
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(OUT, dest));
    count++;
    console.log(`✓ ${dest} (copied from antd)`);
  } else console.error(`✗ missing ${src}`);
}
console.log(`\n${count} faces in ${OUT}`);
