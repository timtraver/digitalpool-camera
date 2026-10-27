// Ad Center ads for the local overlay renderer.
//
// The Overlay Builder's `ad_center` element is the one element type whose
// content is not in the saved canvas: it names a venue (or says "whichever
// venue this overlay is being shown at") and the images come from that venue's
// Ad Center. The browser engine gets them because the overlay page runs
// AdCenterCarousel.js, which queries them itself; this module is that
// component's data half, for the renderer that has no browser.
//
// It is a deliberate port of digitalpool-antd's
// src/screens/overlay-builder/renderers/AdCenterCarousel.js, plus the two
// helpers it leans on (src/utils/adDuration.js, src/utils/cdnUtils.js). Where
// the device deliberately differs from the web component, the reason is in a
// comment — those differences are the only ones there should be.
//
// What it does NOT do is decide which ad is on screen: that is a function of
// the wall clock and the ad list, and it lives in overlayRenderer.js next to
// the drawing, so the renderer stays a pure function of (canvas, binding, now).
const fs = require("fs");
const path = require("path");

const dataSource = require("./overlayDataSource");
const { callDigitalPoolFunction } = require("./digitalpoolApi");

// An overlay is not an Ad Center screen, so it queries as the venue's default
// screen — which matches only ads with no target screens, i.e. the ones meant
// for every screen in the venue. Same constant, same reasoning, as the web
// component; a camera is not one of the venue's TVs and must not inherit ads
// aimed at a particular one.
const SCREEN_ID = "default";
const SCREEN_ID_ARRAY = [SCREEN_ID];

// What the impression is reported *as*, which is a different question from which
// ads are eligible: these rows have to be tellable apart from a venue's TVs, or
// a camera's numbers disappear into the venue's totals. screen_id is the column
// the Ad Center already breaks ads down by (byScreen, unique_screens), so a
// camera arrives as its own line in reports that exist, with no query to change.
// Nothing filters on it, so a new value cannot hide a row.
const REPORT_SCREEN_PREFIX = "camera";
const MAX_SCREEN_ID = 100;   // analyticsIngest truncates past this

// How often to re-ask for a venue's ads. The web component uses five minutes
// and bumps the query's `current_time` on the same cadence, so an ad whose
// start/end date crosses "now" comes and goes without a reload. A device runs
// for weeks, so that matters more here than it does in a browser tab.
const REFRESH_MS = parseInt(process.env.OVERLAY_AD_REFRESH_MS, 10) || 300000;
// How long a venue's last good ad list stays usable when DigitalPool cannot be
// reached. An overlay that blanked its sponsor panel on a dropped uplink would
// be worse than one showing ads a few hours stale — the venue sold the slot.
const STALE_MAX_MS = parseInt(process.env.OVERLAY_AD_STALE_MS, 10) || 86400000;

// ── Media URLs ───────────────────────────────────────────────────────────────
// Port of transformToCdnUrl() from src/utils/cdnUtils.js, trimmed to the cases
// a device can meet. The current bucket is private — its S3 URLs 403 — so
// those are always rewritten; the legacy host is rewritten too, since its
// bucket is gone and only the CloudFront distribution in front of it answers.
// The web version has a localhost bypass, which cannot apply here: a device is
// never a development host.
const CDN_DOMAIN = "d2cqpja9v01i02.cloudfront.net";
const S3_DOMAIN = "digital-pool.s3.us-east-2.amazonaws.com";
const LEGACY_CDN_DOMAIN = "d1k23ln7af6dzb.cloudfront.net";
const LEGACY_S3_DOMAIN = "digitalpool.s3.us-west-1.amazonaws.com";
const WASABI_DOMAIN = "s3.us-central-1.wasabisys.com/digitalpool";

const CDN_FOR = [
  [S3_DOMAIN, CDN_DOMAIN],
  [LEGACY_S3_DOMAIN, LEGACY_CDN_DOMAIN],
  [WASABI_DOMAIN, LEGACY_CDN_DOMAIN],
];

function transformToCdnUrl(url) {
  if (!url || typeof url !== "string") return url;
  if (url.includes(CDN_DOMAIN) || url.includes(LEGACY_CDN_DOMAIN)) return url;
  for (const [domain, cdn] of CDN_FOR) {
    const parts = url.split(`${domain}/`);
    if (parts.length === 2) return `https://${cdn}/${parts[1]}`;
  }
  // Path-style S3 (https://s3.<region>.amazonaws.com/<bucket>/<key>).
  const alt = url.match(/https:\/\/s3\.[^.]+\.amazonaws\.com\/([^/]+)\/(.+)/);
  if (alt) {
    if (alt[1] === "digital-pool") return `https://${CDN_DOMAIN}/${alt[2]}`;
    if (alt[1] === "digitalpool") return `https://${LEGACY_CDN_DOMAIN}/${alt[2]}`;
  }
  return url;   // external image, or already somewhere we do not rewrite
}

// ── Queries ──────────────────────────────────────────────────────────────────
// GET_ACTIVE_ADS_FOR_SCREEN, trimmed to the fields a drawn ad needs. The where
// clause is reproduced exactly: changing it would mean the camera shows a
// different set of ads than the venue's own displays, which is the one thing
// this element exists to avoid.
const AD_FIELDS = `
  id title type file_url video_url thumbnail_url duration
  display_frequency priority scope
  ad_schedules(where: { is_active: { _eq: true } }) { day_of_week start_time end_time }`;

const Q_VENUE_ADS = `
  query DeviceVenueAds($venue_id: Int!, $screen_id: jsonb, $current_time: timestamptz!) {
    advertisements(
      where: {
        scope: { _eq: "venue" }
        venue_id: { _eq: $venue_id }
        status: { _eq: "active" }
        start_date: { _lte: $current_time }
        _or: [{ end_date: { _gte: $current_time } }, { end_date: { _is_null: true } }]
        _and: [{ _or: [{ target_screens: { _contains: $screen_id } }, { target_screens: { _is_null: true } }, { target_screens: { _eq: [] } }] }]
      }
      order_by: { priority: asc, created_at: asc }
    ) {${AD_FIELDS}
    }
    venues_by_pk(id: $venue_id) { id accepts_national_ads venue_custom_install }
  }`;

// Platform-wide ads, fetched only when the venue's two flags allow them — the
// same gate the venue's own displays use.
const Q_NATIONAL_ADS = `
  query DeviceNationalAds($screen_id: jsonb, $current_time: timestamptz!) {
    advertisements(
      where: {
        scope: { _eq: "national" }
        status: { _eq: "active" }
        start_date: { _lte: $current_time }
        _or: [{ end_date: { _gte: $current_time } }, { end_date: { _is_null: true } }]
        _and: [{ _or: [{ target_screens: { _contains: $screen_id } }, { target_screens: { _is_null: true } }, { target_screens: { _eq: [] } }] }]
      }
      order_by: { priority: asc, created_at: asc }
    ) {${AD_FIELDS}
    }
  }`;

// ── The venue an element draws ads for ───────────────────────────────────────
// remote.json is where registration records which venue this appliance was
// assigned to. Read here rather than plumbed down from server.js so the
// renderer, the conformance harness and any one-off script all resolve the
// venue the same way; it is re-read when it changes, so registering a device
// does not need a restart.
const REMOTE_CONFIG_FILE = path.join(__dirname, "remote.json");
let _deviceVenue = { at: 0, mtime: 0, id: null };

function deviceName() {
  try {
    const cfg = JSON.parse(fs.readFileSync(REMOTE_CONFIG_FILE, "utf8"));
    return (cfg.deviceName || "").trim();
  } catch (e) {
    return "";
  }
}

/**
 * The screen_id these impressions are reported under: "camera" for a box that
 * has no name yet, "camera:<device>" for one that does. The prefix is what
 * makes the whole class selectable (`screen_id LIKE 'camera:%'`) without
 * knowing the fleet; the name is what makes one box's row readable in a
 * report next to the venue's TVs.
 */
function reportScreenId(name = deviceName()) {
  const id = name ? `${REPORT_SCREEN_PREFIX}:${name}` : REPORT_SCREEN_PREFIX;
  return id.slice(0, MAX_SCREEN_ID);
}

function deviceVenueId() {
  try {
    const mtime = fs.statSync(REMOTE_CONFIG_FILE).mtimeMs;
    if (mtime !== _deviceVenue.mtime) {
      const cfg = JSON.parse(fs.readFileSync(REMOTE_CONFIG_FILE, "utf8"));
      const id = parseInt(cfg.venueId, 10);
      _deviceVenue = { mtime, id: Number.isFinite(id) && id > 0 ? id : null };
    }
  } catch (e) {
    // Not registered, or the file is unreadable: there is simply no device
    // venue, which is not an error — an element naming a venue still works.
    _deviceVenue = { mtime: 0, id: null };
  }
  return _deviceVenue.id;
}

/**
 * Which venue's ads an element shows.
 *
 * The first two steps are the web component's rule exactly: a fixed venue, or
 * the venue the overlay is being shown at (ElementRenderer's
 * `automatic ? binding.venue.id : element.venueId`).
 *
 * The third is this device's own: an overlay URL does not always carry a venue
 * — a tournament with no venue attached is the common case — and unlike a
 * browser, an appliance knows where it physically is. Without the fallback the
 * element would be empty on a box sitting in a venue whose ads it was put there
 * to show. It is deliberately LAST, so an overlay that does name a venue, or a
 * URL that identifies one, always wins; set OVERLAY_AD_DEVICE_VENUE=0 to turn
 * it off and match the browser exactly.
 */
function resolveAdVenueId(element, binding) {
  if (element && element.venueSource !== "auto") {
    const fixed = parseInt(element.venueId, 10);
    return Number.isFinite(fixed) && fixed > 0 ? fixed : null;
  }
  const fromBinding = binding && binding.venue && binding.venue.id;
  if (fromBinding) return parseInt(fromBinding, 10) || null;
  return fallbackVenueId();
}

/**
 * The venue to use when the overlay URL named none — this appliance's own,
 * unless OVERLAY_AD_DEVICE_VENUE=0 turns the fallback off.
 */
function fallbackVenueId() {
  if (process.env.OVERLAY_AD_DEVICE_VENUE === "0") return null;
  return deviceVenueId();
}

/** Every venue whose ads a canvas needs, resolved against a binding. */
function adVenueIds(canvasDef, binding) {
  const ids = new Set();
  for (const el of (canvasDef && canvasDef.elements) || []) {
    if (el.visible === false || el.type !== "ad_center") continue;
    const id = resolveAdVenueId(el, binding);
    if (id) ids.add(id);
  }
  return [...ids];
}

/** Whether a canvas has any ad_center element at all (visible or not). */
function hasAdElements(canvasDef) {
  return ((canvasDef && canvasDef.elements) || []).some((el) => el.type === "ad_center" && el.visible !== false);
}

// ── Fetching ─────────────────────────────────────────────────────────────────
// venueId -> { at, ads, error }. `at` is the last SUCCESSFUL read: a failed
// refresh leaves the previous list in place and simply lets it age.
const _cache = new Map();

/**
 * The web component filters on the day of week only — an ad_schedules row with
 * a start_time and end_time still shows all day. That is a gap in the web
 * component, not in this port, and reproducing it is deliberate: the device and
 * the venue's TVs have to agree about what is on screen, and the moment they
 * disagree the overlay is the one that looks broken.
 *
 * The day is the DEVICE's local day, as it is the browser's local day in the
 * web component. A camera sits in the venue it serves, so the two agree.
 */
function scheduledToday(ad, now) {
  const schedules = ad.ad_schedules;
  if (!schedules || schedules.length === 0) return true;
  const today = new Date(now).getDay();
  return schedules.some((s) => s.day_of_week === today);
}

/**
 * Shape an ad list the way the renderer wants it: priority order, today's ads
 * only, CDN URLs, no video.
 *
 * Video ads are dropped because the handoff to GStreamer is a PNG that the
 * pipeline re-reads on an mtime poll — there is no way to play a video through
 * it, and a still frame of an ad the advertiser paid to have play would be
 * worse than leaving it out. The browser engine still plays them, so an overlay
 * whose ads are mostly video is a reason to keep that venue on OVERLAY_ENGINE=
 * chromium.
 */
function shapeAds(rows, now) {
  const out = [];
  for (const ad of rows) {
    if (!ad.file_url) continue;
    if (ad.type === "video") continue;
    if (!scheduledToday(ad, now)) continue;
    out.push({
      id: ad.id,
      title: ad.title || "",
      type: ad.type,
      file_url: transformToCdnUrl(ad.file_url),
      duration: ad.duration,
      priority: ad.priority,
      scope: ad.scope,
    });
  }
  // Array.prototype.sort is stable, so ads of equal priority keep the
  // created_at order the query returned them in — same as the web component's
  // sort over the merged venue + national list.
  return out.sort((a, b) => (a.priority != null ? a.priority : Number.MAX_SAFE_INTEGER)
                          - (b.priority != null ? b.priority : Number.MAX_SAFE_INTEGER));
}

async function fetchVenueAds(venueId, now) {
  const currentTime = new Date(now).toISOString();
  const data = await dataSource.graphql(Q_VENUE_ADS, {
    venue_id: venueId, screen_id: SCREEN_ID_ARRAY, current_time: currentTime,
  });
  const venue = data.venues_by_pk || {};
  const accepts = !!venue.venue_custom_install && !!venue.accepts_national_ads;
  let rows = data.advertisements || [];
  if (accepts) {
    const national = await dataSource.graphql(Q_NATIONAL_ADS, {
      screen_id: SCREEN_ID_ARRAY, current_time: currentTime,
    });
    rows = rows.concat(national.advertisements || []);
  }
  return shapeAds(rows, now);
}

/**
 * Ads for every venue a canvas needs, as { [venueId]: [ad, ...] } — the shape
 * the renderer reads off `binding.ads`.
 *
 * Never rejects. A venue that cannot be read keeps whatever it had until that
 * is STALE_MAX_MS old, and the reason comes back in `errors` for stats().
 */
async function fetchAds(venueIds, now = Date.now(), { force = false } = {}) {
  const ads = {};
  const errors = {};
  for (const venueId of venueIds) {
    const hit = _cache.get(venueId);
    if (!force && hit && now - hit.at < REFRESH_MS) {
      ads[venueId] = hit.ads;
      continue;
    }
    try {
      const list = await fetchVenueAds(venueId, now);
      _cache.set(venueId, { at: now, ads: list });
      ads[venueId] = list;
    } catch (err) {
      errors[venueId] = err.message;
      if (hit && now - hit.at < STALE_MAX_MS) {
        ads[venueId] = hit.ads;   // last good list, deliberately kept
      } else {
        if (hit) _cache.delete(venueId);
        ads[venueId] = [];
      }
    }
  }
  return { ads, errors };
}

/**
 * A cheap value that changes whenever the ad lists change, for the producer's
 * "has anything moved?" check. Which ad is CURRENTLY on screen is not part of
 * it — that is the renderer's clock-driven job, and folding it in here would
 * make every rotation look like new data.
 */
function adsSignature(adsByVenue) {
  if (!adsByVenue) return "";
  return JSON.stringify(Object.keys(adsByVenue).sort().map((k) => [
    k, (adsByVenue[k] || []).map((ad) => [ad.id, ad.file_url, ad.duration]),
  ]));
}

// ── Impressions ──────────────────────────────────────────────────────────────
// The web overlay logs one impression per ad shown. A device drawing the same
// ads has to log them too, or every box moved to the local renderer would
// quietly stop counting toward what the venue is being paid for.
//
// Both now go through the cloud: POST to analyticsApi's /ad-events, which
// checks each row field by field and inserts it as ClickHouse's insert-only
// dp_ingest user (the password is a Google secret, server-side). That route
// exists for exactly this — venue screens nobody signs in on — so it takes an
// anonymous POST, which is what the appliance can do: registration keeps an
// identity, never a password, so there is no Firebase token here.
//
// It is not recordAdImpressions: that one is a *callable* for the mobile app's
// match camera and rejects anything without request.auth.uid. Both write the
// same ad_events table, so the Ad Center's reports count these either way.
const AD_EVENTS_FUNCTION = "analyticsApi/ad-events";

// Mirrors useAdAnalytics: at most one impression event per ad per screen per
// minute, with the rotations that happened inside the window carried on the
// next event as rotation_count. A ten-second ad in a three-ad rotation would
// otherwise post six rows a minute, per camera, forever.
const THROTTLE_MS = 60000;
const FLUSH_MS = 10000;
const MAX_BUFFER = 50;

const _throttle = new Map();   // `${adId}-${screenId}` -> { at, rotations }
const _buffer = [];
let _flushTimer = null;
let _sent = 0;
let _dropped = 0;
let _lastError = null;

// Nothing to configure — the endpoint is the one the device already talks to.
// The switch is here only so a box can be told to stop reporting (a bench unit
// rehearsing an overlay should not bill a venue's ad for the impressions).
function impressionsEnabled() {
  return process.env.OVERLAY_AD_IMPRESSIONS !== "0";
}

function chTimestamp(ms) {
  // The ad_events timestamp is 'YYYY-MM-DD HH:MM:SS' in the column's timezone;
  // the web app formats local time with dayjs, so do the same.
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * Note that an ad is on screen. Called by the producer after a frame is drawn,
 * once per visible ad_center element.
 */
function logImpression(ad, { venueId, screenId = null, instance = "", now = Date.now(), metadata = {} } = {}) {
  if (!ad || !ad.id || !venueId || !impressionsEnabled()) return false;
  const name = deviceName();
  const screen = screenId || reportScreenId(name);
  // `instance` only separates the throttle, never the row: two cameras at one
  // venue are two streams showing the ad to two audiences, and the web counts
  // them separately because each browser has its own throttle. Without it the
  // second camera's impressions would be swallowed by the first's window.
  const key = `${ad.id}-${screen}-${instance}`;
  const seen = _throttle.get(key);
  if (seen && now - seen.at < THROTTLE_MS) {
    seen.rotations++;
    return false;
  }
  const rotations = seen ? seen.rotations : 0;
  _throttle.set(key, { at: now, rotations: 0 });

  // The metadata says the same thing in finer grain than screen_id can: which
  // box, which of its two cameras, and that a renderer rather than a browser
  // drew it. `source` matches what the web overlay writes, so "every overlay
  // impression" stays one query across both engines.
  const meta = {
    ad_title: ad.title,
    ad_type: ad.type,
    source: "overlay",
    renderer: "device",
    ...(name ? { device: name } : {}),
    ...metadata,
  };
  if (rotations > 0) meta.rotation_count = rotations;
  _buffer.push({
    advertisement_id: ad.id,
    event_type: "impression",
    venue_id: venueId,
    screen_id: screen,
    // The web overlay reports 'unknown' because a browser cannot tell what it
    // is running on. This one can.
    device_type: "monitor",
    event_id: null,
    metadata: JSON.stringify(meta),
    timestamp: chTimestamp(now),
    date: chTimestamp(now).slice(0, 10),
  });
  if (_buffer.length >= MAX_BUFFER) flushImpressions();
  else ensureFlushTimer();
  return true;
}

function ensureFlushTimer() {
  if (_flushTimer) return;
  _flushTimer = setTimeout(() => { _flushTimer = null; flushImpressions(); }, FLUSH_MS);
  // Impression reporting must never be the reason the process stays alive
  // through a shutdown.
  if (_flushTimer.unref) _flushTimer.unref();
}

/**
 * Post the buffered rows as one batch. Failures are dropped rather than
 * retried forever: these are analytics, and a venue box that has been offline
 * for a day must not come back and replay a day of impressions with the wrong
 * timestamps still queued in memory.
 */
async function flushImpressions() {
  if (!_buffer.length || !impressionsEnabled()) return;
  const rows = _buffer.splice(0, _buffer.length);
  try {
    const { statusCode, body } = await callDigitalPoolFunction(
      AD_EVENTS_FUNCTION,
      { events: rows },
      { timeout: 15000 },
    );
    if (statusCode !== 200) {
      throw new Error(`HTTP ${statusCode} ${(body && (body.error || body.raw)) || ""}`.trim());
    }
    // The route drops a row it cannot make an ad_events row out of and still
    // answers 200. Silently losing impressions is the failure that would never
    // be noticed, so count them as dropped like any other.
    const accepted = Number.isInteger(body && body.accepted) ? body.accepted : rows.length;
    _sent += accepted;
    if (accepted < rows.length) {
      _dropped += rows.length - accepted;
      _lastError = `${rows.length - accepted} of ${rows.length} events rejected`;
      console.log(`⚠️  Ad impressions rejected: ${_lastError}`);
    } else {
      _lastError = null;
    }
  } catch (err) {
    _dropped += rows.length;
    _lastError = err.message;
    // One line per failure would fill the journal on a long outage; the count
    // is in stats() and that is where to look.
    if (_dropped === rows.length || _dropped % 100 < rows.length) {
      console.log(`⚠️  Ad impressions not recorded (${_dropped} dropped): ${err.message}`);
    }
  }
}

function impressionStats() {
  return {
    enabled: impressionsEnabled(),
    endpoint: AD_EVENTS_FUNCTION,
    sent: _sent,
    dropped: _dropped,
    buffered: _buffer.length,
    lastError: _lastError,
  };
}

module.exports = {
  SCREEN_ID,
  reportScreenId,
  REFRESH_MS,
  resolveAdVenueId,
  fallbackVenueId,
  adVenueIds,
  hasAdElements,
  fetchAds,
  adsSignature,
  deviceVenueId,
  deviceName,
  logImpression,
  flushImpressions,
  impressionStats,
  _internals: { transformToCdnUrl, shapeAds, scheduledToday, fetchVenueAds, Q_VENUE_ADS, Q_NATIONAL_ADS },
};
