// Which table each camera is pointed at, for alert subject lines.
//
// An alert that says "dp-stream-2e27" sends somebody to look up which table
// that box covers. The table is what they act on, so it belongs in the subject
// — and DigitalPool already knows it: every camera is a `venue_devices` row
// named "<hostname> Camera <n>" with a pool_table relation carrying the
// venue's own label ("Table 2").
//
// Three sources, in order:
//   1. that row, which is authoritative and per camera;
//   2. the camera's overlay URL, which carries the table slug and needs no
//      network — but is empty on a camera with no overlay configured, which is
//      the common case for the second camera on a venue box;
//   3. nothing, and the subject falls back to the hostname as it always did.
//
// The answer is cached on disk so a box that boots without internet still
// labels its mail, and refreshed in the background — never from inside an
// alert, which must not wait on the network.
const fs = require("fs");
const path = require("path");

const CACHE_FILE = path.join(__dirname, "table-names.json");
// Tables are renamed about never; this is only here so a reassignment is picked
// up without a restart.
const REFRESH_MS = 6 * 60 * 60 * 1000;

let _identity = null;      // () => { venueId, deviceName }
let _tables = {};          // { "1": "Table 2", "2": "Table 2" }
let _loaded = false;

function _load() {
  if (_loaded) return;
  _loaded = true;
  try {
    const saved = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    if (saved && saved.tables) _tables = saved.tables;
  } catch (e) { /* no cache yet */ }
}

function _save() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ at: new Date().toISOString(), tables: _tables }, null, 2));
  } catch (e) { /* a cache we cannot write is not worth an error */ }
}

/** `fn` returns { venueId, deviceName } — the registration, read fresh each time. */
function configure(fn) {
  _identity = fn;
}

/** The table label for a camera, or "" when nothing knows it. */
function get(camIdx) {
  _load();
  return (_tables[String(camIdx)] || "").trim();
}

/** Remember a table worked out locally (from an overlay URL), if we have none. */
function seed(camIdx, label) {
  _load();
  const key = String(camIdx);
  if (!label || _tables[key]) return;
  _tables[key] = label;
  _save();
}

/**
 * Ask DigitalPool which table each of this box's cameras is on.
 *
 * Matched on the device name because that is what the venue_devices rows are
 * called; the device id recorded at registration is empty on boxes registered
 * before it was captured, so it cannot be relied on.
 */
async function refresh() {
  if (!_identity) return _tables;
  let who;
  try { who = _identity() || {}; } catch (e) { return _tables; }
  const venueId = parseInt(who.venueId, 10);
  const deviceName = (who.deviceName || "").trim();
  if (!Number.isFinite(venueId) || !deviceName) return _tables;

  const query = `
    query DeviceTables($venue_id: Int!, $name: String!) {
      venue_devices(where: { venue_id: { _eq: $venue_id }, name: { _ilike: $name } }) {
        name
        pool_table { id label slug }
      }
    }`;
  try {
    const data = await require("./overlayDataSource").graphql(query, {
      venue_id: venueId,
      name: `${deviceName} Camera %`,
    });
    const found = {};
    for (const row of data.venue_devices || []) {
      const m = /camera\s*(\d+)\s*$/i.exec(row.name || "");
      const table = row.pool_table && (row.pool_table.label || row.pool_table.slug);
      if (m && table) found[m[1]] = String(table).trim();
    }
    if (Object.keys(found).length) {
      const changed = JSON.stringify(found) !== JSON.stringify(_tables);
      _tables = { ..._tables, ...found };
      if (changed) {
        console.log(`🎱 Tables from DigitalPool: ${Object.entries(_tables)
          .map(([cam, t]) => `camera ${cam} → ${t}`).join(", ")}`);
        _save();
      }
    }
  } catch (e) {
    // Offline, or the row is not there yet. The cache and the overlay URL cover it.
    console.log(`ℹ️  Could not read table names from DigitalPool: ${e.message}`);
  }
  return _tables;
}

/** Refresh now and then periodically. Never throws. */
function start() {
  _load();
  setTimeout(() => { refresh().catch(() => {}); }, 20000).unref?.();
  const t = setInterval(() => { refresh().catch(() => {}); }, REFRESH_MS);
  if (typeof t.unref === "function") t.unref();
}

module.exports = { configure, get, seed, refresh, start, CACHE_FILE };
