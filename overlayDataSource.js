// Fetches what the local overlay renderer needs — the saved canvas and the live
// match binding — directly from DigitalPool, with no browser in the loop.
//
// This replaces what the remote overlay PAGE does for itself today: Chromium
// loads digitalpool.com, that React app runs the queries, and we screenshot the
// result. Here the device runs the equivalent queries itself and hands the data
// to overlayRenderer.js.
//
// Shapes are deliberately identical to the web app's, so the two renderers stay
// comparable:
//   • URL routes      — CustomOverlayRenderer.js
//   • binding object  — buildLiveBinding() in overlay-builder/data/sampleBinding.js
//   • overlay canvas  — GET_PUBLIC_OVERLAY in overlay-builder/data/queries.js
//
// Transport: plain HTTPS POST of a GraphQL document. Two sources are possible and
// the choice is config, not code —
//   • direct Hasura (default), which needs the anonymous role to be able to SELECT
//     user_overlays. Match data (tournaments / pool_tables) is already readable.
//   • a DigitalPool cloud function, when OVERLAY_SOURCE_FUNCTION names one. That
//     keeps credentials server-side and reuses the device↔function contract that
//     digitalpoolApi.js already speaks.
const { URL } = require("url");
const https = require("https");
const http = require("http");

const DEFAULT_GRAPHQL = "https://api-prod.digitalpool.com/v1/graphql";

function graphqlUrl() {
  return process.env.DIGITALPOOL_GRAPHQL_URL || DEFAULT_GRAPHQL;
}

/** Name of the cloud function to fetch the overlay canvas through, if any. */
function overlaySourceFunction() {
  return (process.env.OVERLAY_SOURCE_FUNCTION || "").trim() || null;
}

// ── Transport ────────────────────────────────────────────────────────────────
function postJson(fullUrl, payload, { timeout = 15000, headers = {} } = {}) {
  const urlObj = new URL(fullUrl);
  const mod = urlObj.protocol === "https:" ? https : http;
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = mod.request(
      {
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === "https:" ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "Content-Length": Buffer.byteLength(body),
          ...headers,
        },
        timeout,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => { data += c; });
        res.on("end", () => {
          let parsed = {};
          try { parsed = data ? JSON.parse(data) : {}; } catch { parsed = { raw: data }; }
          resolve({ statusCode: res.statusCode, body: parsed });
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error(`${fullUrl} timed out`)); });
    req.write(body);
    req.end();
  });
}

async function graphql(query, variables) {
  const { statusCode, body } = await postJson(graphqlUrl(), { query, variables });
  if (statusCode !== 200) throw new Error(`GraphQL HTTP ${statusCode}`);
  if (body.errors && body.errors.length) {
    throw new Error(`GraphQL: ${body.errors.map((e) => e.message).join("; ")}`);
  }
  return body.data || {};
}

// ── URL parsing ──────────────────────────────────────────────────────────────
// The venue's configured overlayUrl already identifies everything the device
// needs, so switching to local rendering requires no settings change and no
// re-registration. A URL that does not match one of these shapes simply is not
// locally renderable, and the caller keeps using Chromium for it.
//
//   /venues/:venueSlug/tables/:tableSlug/overlays/:overlayId
//   /events/:eventSlug/tables/:tableSlug/overlays/:overlayId
//   /tournaments/:tournamentSlug/tables/:tableSlug/overlays/:overlayId
const ROUTE = /\/(venues|events|tournaments)\/([^/]+)\/tables\/([^/]+)\/overlays\/(\d+)\/?$/;
const MODE_FOR = { venues: "venue", events: "event", tournaments: "tournament" };

// Modes whose queries are implemented here. Event mode reads matches through a
// nested event→tournament structure that is not ported yet, so it still falls
// back to the browser rather than render something wrong.
const SUPPORTED_MODES = new Set(["tournament", "venue"]);

function parseOverlayUrl(url) {
  if (!url) return null;
  let parsed;
  try { parsed = new URL(String(url).trim()); } catch { return null; }
  const m = parsed.pathname.match(ROUTE);
  if (!m) return null;
  const mode = MODE_FOR[m[1]];
  const slug = decodeURIComponent(m[2]);
  const tableSlug = decodeURIComponent(m[3]);
  // "preview" is the builder's sample-data sentinel, never a real device URL.
  if (slug === "preview" || tableSlug === "preview") return null;
  const delayRaw = parsed.searchParams.get("delay");
  const delay = delayRaw == null ? null : Number(delayRaw);
  return {
    mode,
    slug,
    tableSlug,
    overlayId: parseInt(m[4], 10),
    // Holds live data back to match a delayed video feed (overlaySettings.js).
    // A URL value overrides whatever the overlay has saved; null means "use the
    // overlay's own setting".
    delaySeconds: Number.isFinite(delay) && delay >= 0 ? Math.min(delay, 300) : null,
    chromaColor: parsed.searchParams.get("chroma_color") || null,
    supported: SUPPORTED_MODES.has(mode),
    href: parsed.href,
  };
}

// ── Queries ──────────────────────────────────────────────────────────────────
const Q_OVERLAY = `
  query DeviceOverlay($id: Int!) {
    user_overlays(where: { id: { _eq: $id } }, limit: 1) { id name canvas }
  }`;

const Q_TOURNAMENT = `
  query DeviceTournament($slug: String!) {
    tournaments(where: { slug: { _eq: $slug } }, limit: 1) {
      id name slug logo avatar game_type winners_race_to losers_race_to
      venue { id name city region }
    }
  }`;

// Mirrors GET_TOURNAMENT_STREAM_TABLE_OVERLAY_QUERY, trimmed to the fields the
// binding actually reads.
const Q_TABLE_MATCH = `
  query DeviceTableMatch($tournament_id: Int!, $table_slug: String!) {
    pool_tables(where: { tournament_id: { _eq: $tournament_id }, slug: { _eq: $table_slug } }, limit: 1) {
      id slug label
      user { id city region }
      venue { id name city region }
      tournament_match_table(where: { status: { _eq: IN_PROGRESS } }, order_by: { updated_at: desc }, limit: 1) {
        id identifier status scheduled_time start_time end_time updated_at
        challenger1_name challenger1_country challenger1_score challenger1_points
        challenger1_race_to challenger1_skill_level challenger1_is_playing
        challenger2_name challenger2_country challenger2_score challenger2_points
        challenger2_race_to challenger2_skill_level challenger2_is_playing
        challenger1 { id name team { id name } user { id avatar } }
        challenger2 { id name team { id name } user { id avatar } }
      }
    }
  }`;

// Venue mode. A venue table can be carrying either a tournament match or a
// casual match (QR-started play with no event at all), so fetch both and prefer
// the tournament one — the order extractVenueLiveData() resolves them in.
//
// The web app reads this through GET_VENUE_LIVE_TABLE_QUERY, whose fields are
// all aliased to one or two letters to keep the payload small for a browser.
// Nothing here needs that, so this asks for the same data by its real names.
const Q_VENUE_TABLE = `
  query DeviceVenueTable($venue_slug: String!, $table_slug: String!) {
    pool_tables(where: { slug: { _eq: $table_slug }, venue: { slug: { _eq: $venue_slug } } }, limit: 1) {
      id slug label
      venue { id name city region }
      user { id city region }
      tournament {
        id name slug logo avatar game_type winners_race_to losers_race_to
        venue { id name city region }
      }
      tournament_match_table(where: { status: { _eq: IN_PROGRESS } }, order_by: { updated_at: desc }, limit: 1) {
        id identifier status scheduled_time start_time end_time updated_at
        challenger1_name challenger1_country challenger1_score challenger1_points
        challenger1_race_to challenger1_skill_level challenger1_is_playing
        challenger2_name challenger2_country challenger2_score challenger2_points
        challenger2_race_to challenger2_skill_level challenger2_is_playing
        challenger1 { id name team { id name } user { id avatar } }
        challenger2 { id name team { id name } user { id avatar } }
      }
      matches(where: { status: { _neq: COMPLETED } }, order_by: { updated_at: desc }, limit: 1) {
        id name status race_to game_type updated_at
        start_date_time end_date_time
        player_name player_score player_race_to player_fargo player_country player_is_winner player_is_playing
        opponent_name opponent_score opponent_race_to opponent_fargo opponent_country opponent_is_winner opponent_is_playing
      }
    }
  }`;

/**
 * Port of casualMatchToChallenger(). A casual match stores its two competitors
 * as player_ and opponent_ fields rather than challenger1_ and challenger2_.
 *
 * It maps exactly the six fields the web app maps, and no more — points,
 * start/end time and avatars are deliberately NOT mapped, because the web app
 * does not map them either and a casual-match overlay therefore shows 0 points
 * and a 0:00 clock. Adding them here would make the device disagree with the
 * browser, which is a worse outcome than reproducing the gap.
 */
function casualMatchToChallenger(m) {
  if (!m) return null;
  return {
    ...m,
    challenger1_name: m.player_name,
    challenger1_score: m.player_score,
    challenger1_race_to: m.player_race_to,
    challenger1_skill_level: m.player_fargo,
    challenger1_country: m.player_country,
    challenger1_is_winner: m.player_is_winner,
    challenger2_name: m.opponent_name,
    challenger2_score: m.opponent_score,
    challenger2_race_to: m.opponent_race_to,
    challenger2_skill_level: m.opponent_fargo,
    challenger2_country: m.opponent_country,
    challenger2_is_winner: m.opponent_is_winner,
  };
}

// ── Canvas ───────────────────────────────────────────────────────────────────
async function fetchCanvas(overlayId) {
  const fn = overlaySourceFunction();
  if (fn) {
    // Cloud-function route: keeps Hasura credentials off the device entirely.
    const base = (process.env.DIGITALPOOL_FUNCTIONS_URL || "https://us-central1-digital-pool.cloudfunctions.net").replace(/\/$/, "");
    const { statusCode, body } = await postJson(`${base}/${fn}`, { action: "overlay", overlayId });
    if (statusCode !== 200) throw new Error(`overlay function HTTP ${statusCode}`);
    if (!body || !body.canvas) throw new Error("overlay function returned no canvas");
    return body.canvas;
  }
  const data = await graphql(Q_OVERLAY, { id: overlayId });
  const row = data.user_overlays && data.user_overlays[0];
  if (!row) throw new Error(`overlay ${overlayId} not found or not readable`);
  if (!row.canvas) throw new Error(`overlay ${overlayId} has no canvas`);
  return row.canvas;
}

// ── Binding ──────────────────────────────────────────────────────────────────
// Port of buildLiveBinding(). `defaults` is the EMPTY binding: on a real device
// URL with no match assigned, elements render blank rather than showing sample
// players, exactly as the web renderer does off the preview route.
const EMPTY_BINDING = {
  tournament: { id: null, name: "", slug: "", location: "", logo: null, game_type: "", winners_race_to: null, losers_race_to: null },
  table: { id: null, slug: "", label: "" },
  match: {
    identifier: "", race_to: null, status: "", scheduled_time: null, start_time: null, end_time: null,
    challenger1_name: "", challenger1_country: "", challenger1_score: "", challenger1_points: "",
    challenger1_race_to: "", challenger1_skill_level: "", challenger1_avatarImg: null, challenger1_is_playing: false,
    challenger2_name: "", challenger2_country: "", challenger2_score: "", challenger2_points: "",
    challenger2_race_to: "", challenger2_skill_level: "", challenger2_avatarImg: null, challenger2_is_playing: false,
  },
};

const GAME_TYPE_LABELS = {
  NINE_BALL: "9-Ball", EIGHT_BALL: "8-Ball", TEN_BALL: "10-Ball", ONE_POCKET: "One Pocket",
  BANK_POOL: "Bank Pool", STRAIGHT_POOL: "Straight Pool", SNOOKER: "Snooker", HEYBALL: "Heyball",
};

function gameTypeLabel(gameType) {
  if (!gameType) return "";
  if (GAME_TYPE_LABELS[gameType]) return GAME_TYPE_LABELS[gameType];
  return String(gameType).toLowerCase().split("_")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");
}

function venueLabel(v) {
  if (!v) return "";
  const cityRegion = [v.city, v.region].filter(Boolean).join(", ");
  return [v.name, cityRegion].filter(Boolean).join(" — ");
}

function locationFor(tournament, table) {
  const fromTournament = venueLabel(tournament && tournament.venue);
  if (fromTournament) return fromTournament;
  const fromTable = venueLabel(table && table.venue);
  if (fromTable) return fromTable;
  // In-home tables often have no venue at all; the owner's city/region is then
  // the only geography available.
  const u = table && table.user;
  if (u) {
    const cityRegion = [u.city, u.region].filter(Boolean).join(", ");
    if (cityRegion) return cityRegion;
  }
  return (tournament && tournament.location) || "";
}

function buildBinding(tournament, table, match) {
  if (!tournament && !table && !match) return EMPTY_BINDING;
  const location = locationFor(tournament, table);
  return {
    tournament: tournament
      ? {
          id: tournament.id,
          name: tournament.name,
          slug: tournament.slug,
          location,
          logo: tournament.logo || tournament.avatar || null,
          game_type: gameTypeLabel(tournament.game_type),
          winners_race_to: tournament.winners_race_to,
          losers_race_to: tournament.losers_race_to,
        }
      : { ...EMPTY_BINDING.tournament, location: location || "" },
    table: table ? { id: table.id, slug: table.slug, label: table.label } : EMPTY_BINDING.table,
    match: match
      ? {
          identifier: match.identifier,
          race_to: match.race_to,
          status: match.status,
          scheduled_time: match.scheduled_time,
          start_time: match.start_time,
          end_time: match.end_time,
          // Team events name the competitor by team, falling back to the player.
          challenger1_name: (match.challenger1 && match.challenger1.team && match.challenger1.team.name) || match.challenger1_name,
          challenger1_country: match.challenger1_country,
          challenger1_score: match.challenger1_score || 0,
          challenger1_points: match.challenger1_points || 0,
          challenger1_race_to: match.challenger1_race_to,
          challenger1_skill_level: match.challenger1_skill_level,
          challenger1_avatarImg: (match.challenger1 && match.challenger1.user && match.challenger1.user.avatar) || null,
          challenger1_is_playing: match.challenger1_is_playing,
          challenger2_name: (match.challenger2 && match.challenger2.team && match.challenger2.team.name) || match.challenger2_name,
          challenger2_country: match.challenger2_country,
          challenger2_score: match.challenger2_score || 0,
          challenger2_points: match.challenger2_points || 0,
          challenger2_race_to: match.challenger2_race_to,
          challenger2_skill_level: match.challenger2_skill_level,
          challenger2_avatarImg: (match.challenger2 && match.challenger2.user && match.challenger2.user.avatar) || null,
          challenger2_is_playing: match.challenger2_is_playing,
        }
      : EMPTY_BINDING.match,
  };
}

/**
 * Current binding for a parsed overlay URL. Throws on transport/permission
 * failures so the caller can fall back; returns a blank-but-valid binding when
 * the queries simply find no match on the table.
 */
async function fetchBinding(parsed) {
  if (parsed.mode === "venue") return fetchVenueBinding(parsed);
  if (parsed.mode !== "tournament") {
    throw new Error(`overlay mode '${parsed.mode}' not implemented locally`);
  }
  const t = await graphql(Q_TOURNAMENT, { slug: parsed.slug });
  const tournament = t.tournaments && t.tournaments[0];
  if (!tournament) throw new Error(`tournament '${parsed.slug}' not found`);

  const d = await graphql(Q_TABLE_MATCH, { tournament_id: tournament.id, table_slug: parsed.tableSlug });
  const table = d.pool_tables && d.pool_tables[0];
  const match = table && table.tournament_match_table && table.tournament_match_table[0];
  return buildBinding(tournament, table, match || null);
}

async function fetchVenueBinding(parsed) {
  const d = await graphql(Q_VENUE_TABLE, { venue_slug: parsed.slug, table_slug: parsed.tableSlug });
  const table = d.pool_tables && d.pool_tables[0];
  if (!table) throw new Error(`table '${parsed.tableSlug}' not found at venue '${parsed.slug}'`);

  const tournamentMatch = table.tournament_match_table && table.tournament_match_table[0];
  if (tournamentMatch) {
    return buildBinding(table.tournament || null, table, tournamentMatch);
  }
  // No tournament match on the table: a casual match, or nothing at all. There is
  // no tournament in either case, so the tournament fields stay blank and only
  // the location resolves (from the venue, or the table owner for a home table).
  const casual = casualMatchToChallenger(table.matches && table.matches[0]);
  return buildBinding(null, table, casual);
}

/**
 * A cheap value that changes whenever anything the overlay displays changes, so
 * the render loop can skip redrawing when nothing moved.
 */
function bindingFingerprint(binding) {
  const m = (binding && binding.match) || {};
  const t = (binding && binding.tournament) || {};
  const tb = (binding && binding.table) || {};
  return JSON.stringify([
    t.name, t.location, t.game_type, t.winners_race_to, t.logo, tb.label,
    m.identifier, m.status, m.race_to, m.start_time, m.end_time,
    m.challenger1_name, m.challenger1_score, m.challenger1_points, m.challenger1_skill_level,
    m.challenger1_country, m.challenger1_avatarImg, m.challenger1_race_to,
    m.challenger2_name, m.challenger2_score, m.challenger2_points, m.challenger2_skill_level,
    m.challenger2_country, m.challenger2_avatarImg, m.challenger2_race_to,
  ]);
}

module.exports = {
  parseOverlayUrl,
  fetchCanvas,
  fetchBinding,
  bindingFingerprint,
  buildBinding,
  casualMatchToChallenger,
  graphqlUrl,
  EMPTY_BINDING,
  SUPPORTED_MODES,
  _internals: { graphql, gameTypeLabel, locationFor, venueLabel },
};
