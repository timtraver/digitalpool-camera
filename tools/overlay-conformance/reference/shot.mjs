// Serves the reference bundle and screenshots each example overlay in Chrome.
// Also pulls the inflated canvas JSON back out of the page, so the Skia renderer
// under test is driven by byte-identical input instead of its own copy.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { buildReference, ANTD } from './build.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml',
};

function serve() {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    // /antd-fonts/* maps to the web app's own font directory so the custom
    // @font-face faces resolve exactly as they do in production.
    const file = url.startsWith('/antd-fonts/')
      ? path.join(ANTD, 'public/fonts', url.slice('/antd-fonts/'.length))
      : path.join(HERE, url === '/' ? 'page.html' : url);
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// Settle a freshly mounted overlay before screenshotting: webfonts and <img>
// decodes both have to land, or we capture a fallback face or an empty image box
// and score a false miss.
async function settle(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      [...document.images].map((img) =>
        img.complete && img.naturalWidth ? Promise.resolve() : new Promise((r) => { img.onload = img.onerror = r; })
      )
    );
  });
}

/**
 * Screenshot arbitrary canvases — overlays read out of the database, synthetic
 * fixtures — through the same real React components.
 * `items` is [{ key, canvas, binding }].
 */
export async function captureCanvases(items, outDir) {
  await buildReference();
  const server = await serve();
  const port = server.address().port;
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--force-device-scale-factor=1', '--hide-scrollbars'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
    await page.goto(`http://127.0.0.1:${port}/page.html`, { waitUntil: 'networkidle0' });
    fs.mkdirSync(outDir, { recursive: true });
    for (const { key, canvas, binding } of items) {
      await page.evaluate((c, b) => window.__render__(c, b), canvas, binding);
      await settle(page);
      await (await page.$('#root')).screenshot({ path: path.join(outDir, `${key}.ref.png`), omitBackground: true });
      fs.writeFileSync(path.join(outDir, `${key}.canvas.json`), JSON.stringify({ canvas, binding }, null, 2));
      console.log(`📸 ${key}`);
    }
    return items.map((i) => i.key);
  } finally {
    await browser.close();
    server.close();
  }
}

export async function captureAll(outDir) {
  await buildReference();
  const server = await serve();
  const port = server.address().port;
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--force-device-scale-factor=1', '--hide-scrollbars'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });

    await page.goto(`http://127.0.0.1:${port}/page.html`, { waitUntil: 'networkidle0' });
    const keys = await page.evaluate(() => window.__EXAMPLE_KEYS__);

    fs.mkdirSync(outDir, { recursive: true });
    const results = [];
    for (const key of keys) {
      await page.goto(`http://127.0.0.1:${port}/page.html?example=${encodeURIComponent(key)}`, {
        waitUntil: 'networkidle0',
      });
      await settle(page);
      const canvas = await page.evaluate(() => window.__CANVAS__);
      const binding = await page.evaluate(() => window.__BINDING__);
      const png = path.join(outDir, `${key}.ref.png`);
      await (await page.$('#root')).screenshot({ path: png, omitBackground: true });
      fs.writeFileSync(path.join(outDir, `${key}.canvas.json`), JSON.stringify({ canvas, binding }, null, 2));
      results.push({ key, png });
      console.log(`📸 ${key}`);
    }
    return results;
  } finally {
    await browser.close();
    server.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = path.join(HERE, '..', 'out');
  const r = await captureAll(out);
  console.log(`\n${r.length} reference renders in ${out}`);
}
