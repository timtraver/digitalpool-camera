// End-to-end check of the local producer against LIVE DigitalPool data: the real
// saved overlay canvas, the real match binding, the real renderer, no browser.
//
//   node live-test.mjs [overlayId] [seconds]
//
// With no overlayId it picks a real one and a real streaming table on its own.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const dataSource = require('../../overlayDataSource.js');
const SkiaOverlay = require('../../skiaOverlay.js');

const wantId = process.argv[2] ? parseInt(process.argv[2], 10) : null;
const seconds = Number(process.argv[3] || 10);

// A real overlay, and a real tournament table to bind it to.
const overlays = await dataSource._internals.graphql(
  `query { user_overlays(order_by: {id: asc}, limit: 20) { id name } }`, {}
);
const overlay = wantId
  ? overlays.user_overlays.find((o) => o.id === wantId)
  : overlays.user_overlays[1] || overlays.user_overlays[0];
if (!overlay) { console.error(`overlay ${wantId} not visible`); process.exit(1); }

const probe = await dataSource._internals.graphql(
  `query { pool_tables(where: {is_streaming_table: {_eq: true}, tournament_id: {_is_null: false}},
           order_by: {updated_at: desc}, limit: 1) { slug tournament { slug name } } }`, {}
);
const table = probe.pool_tables && probe.pool_tables[0];
if (!table || !table.tournament) { console.error('no live streaming table found'); process.exit(1); }

const url = `https://digitalpool.com/tournaments/${table.tournament.slug}/tables/${table.slug}/overlays/${overlay.id}`;
console.log(`overlay     : #${overlay.id} "${overlay.name}"`);
console.log(`live source : ${table.tournament.name} / ${table.slug}`);
console.log(`url         : ${url}\n`);

const pngPath = path.join(os.tmpdir(), 'dp-live-overlay.png');
try { fs.unlinkSync(pngPath); } catch {}

const producer = new SkiaOverlay();
await producer.initialize(3000, pngPath);
producer.setOverlayUrl(url);

const frames = [];
producer.on('updated', (info) => frames.push(info));
producer.on('unsupported', (types) => console.log('would fall back — unsupported:', types.join(', ')));
producer.startPeriodicRefresh();

await new Promise((r) => setTimeout(r, seconds * 1000));
await producer.stop();

console.log(`\nframes drawn : ${frames.length} in ${seconds}s`);
if (frames.length) {
  const t = frames.map((f) => f.ms);
  console.log(`draw time    : ${Math.min(...t)}–${Math.max(...t)} ms (avg ${Math.round(t.reduce((a, b) => a + b, 0) / t.length)} ms)`);
  console.log(`png          : ${pngPath} (${(fs.statSync(pngPath).size / 1024).toFixed(0)} KB)`);
}
console.log('stats        :', JSON.stringify(producer.stats()));
