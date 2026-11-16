// Broadcast destinations the box owns: YouTube and Facebook.
//
// BLUETOOTH_ONBOARDING.md §6.13. The box holds the tokens and creates its own
// per-match broadcast, rather than being handed an ingest URL by the backend.
// That was Tim's call on 2026-11-16, made knowing the trade — §6.13 records
// both the choice and what it costs, and this file does not relitigate it.
//
// Two things here are not obvious and are the reason this is a module rather
// than a few functions in server.js:
//
//   1. **The device-flow poll must outlive the BLE connection.** On Android the
//      Custom Tab that shows Google's page backgrounds the app, which drops the
//      BLE link. If polling the token endpoint were driven by the phone — or
//      even merely owned by a connection — linking would fail on exactly the
//      platform it was designed for. The poll is a timer on the box. The phone
//      reconnects when it likes and reads `dest.status` to see what happened.
//
//   2. **The tokens never leave this module.** `status()` returns what the app
//      may show and nothing else. A refresh token in a BLE response would end
//      up in whatever logs that response, which is the whole point of not
//      sending the phone a credential in the first place.
const fs = require("fs");
const path = require("path");
const https = require("https");

// Outside the repo: a deploy is an rsync into /home/dp/digitalpool-camera, so
// credentials living there would be clobbered by one and copied by any backup
// of it. This directory already holds the migration state.
const STORE_DIR = process.env.DP_STATE_DIR || "/var/lib/digitalpool-camera";
const STORE_FILE = path.join(STORE_DIR, "destinations.json");

const KINDS = ["youtube", "facebook"];

// Google's device endpoints. The client is a "TV and Limited Input" OAuth
// client; its secret ships on the box because that is how installed clients
// work, and Google treats it as non-confidential. It is configured rather than
// committed so a box can be re-pointed without a code change.
const GOOGLE_DEVICE_CODE_URL = "https://oauth2.googleapis.com/device/code";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_SCOPE = "https://www.googleapis.com/auth/youtube";
const GOOGLE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

const FB_VERSION = process.env.FACEBOOK_API_VERSION || "v21.0";
const FB_DEVICE_URL = `https://graph.facebook.com/${FB_VERSION}/device/login`;
const FB_DEVICE_STATUS_URL = `https://graph.facebook.com/${FB_VERSION}/device/login_status`;
const FB_SCOPE = process.env.FACEBOOK_SCOPE || "pages_show_list,pages_manage_posts,publish_video";

// A device code is short-lived and the user is standing there; polling slower
// than the server asks is rude to them, faster is rude to the server.
const MIN_POLL_MS = 5000;

let state = {
  youtube: null,          // { refreshToken, accessToken, expiresAt, channelTitle }
  facebook: null,         // { accessToken, expiresAt, pageName }
  cameras: { 1: null, 2: null },
};

// Linking in progress, per kind. Never persisted: a device code dies in
// minutes, so a box that reboots mid-link should start over rather than resume
// something the user has forgotten about.
const pending = { youtube: null, facebook: null };

let log = (...a) => console.log("📺", ...a);

// ── storage ──────────────────────────────────────────────────────────────────

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
    state = {
      youtube: raw.youtube || null,
      facebook: raw.facebook || null,
      cameras: {
        1: KINDS.includes(raw?.cameras?.["1"]) ? raw.cameras["1"] : null,
        2: KINDS.includes(raw?.cameras?.["2"]) ? raw.cameras["2"] : null,
      },
    };
  } catch {
    // No file, or an unreadable one. Either way there is nothing linked, which
    // is a legitimate state and not an error worth shouting about at boot.
  }
  return state;
}

function save() {
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    // 0600 and owned by whoever runs this (dp). §6.13 says plainly what that
    // is worth: it stops another local account reading the file and stops
    // nothing else. Root ownership would need a setuid helper to hand the
    // tokens back to the process that uses them, which is more attack surface
    // than it removes.
    fs.writeFileSync(STORE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.chmodSync(STORE_FILE, 0o600);
  } catch (err) {
    log(`⚠️  Could not save destinations: ${err.message}`);
  }
}

// ── transport ────────────────────────────────────────────────────────────────

/** POST a form body and parse the JSON answer. OAuth speaks form, not JSON. */
function postForm(url, fields, { timeout = 15000 } = {}) {
  const body = new URLSearchParams(fields).toString();
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: target.hostname,
        path: target.pathname + target.search,
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
          Accept: "application/json",
        },
        timeout,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => { data += c; });
        res.on("end", () => {
          let parsed = null;
          try { parsed = JSON.parse(data); } catch { /* not JSON */ }
          resolve({ statusCode: res.statusCode, body: parsed, raw: data });
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function getJson(url, { timeout = 15000 } = {}) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = https.get(
      { hostname: target.hostname, path: target.pathname + target.search, timeout, headers: { Accept: "application/json" } },
      (res) => {
        let data = "";
        res.on("data", (c) => { data += c; });
        res.on("end", () => {
          let parsed = null;
          try { parsed = JSON.parse(data); } catch { /* not JSON */ }
          resolve({ statusCode: res.statusCode, body: parsed });
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
  });
}

// Calls go through this rather than straight to the functions above, so a test
// can replace the transport and drive the whole device flow — including the
// part that matters most, the poll continuing while no phone is connected —
// without a network or a certificate.
const net = { postForm, getJson };

// ── credentials ──────────────────────────────────────────────────────────────

function credentialsFor(kind) {
  if (kind === "youtube") {
    const id = (process.env.YOUTUBE_CLIENT_ID || "").trim();
    const secret = (process.env.YOUTUBE_CLIENT_SECRET || "").trim();
    return id && secret ? { id, secret } : null;
  }
  const id = (process.env.FACEBOOK_APP_ID || "").trim();
  const secret = (process.env.FACEBOOK_CLIENT_TOKEN || "").trim();
  return id && secret ? { id, secret } : null;
}

/** Thrown with a message an operator reads, because the app shows it verbatim. */
class DestError extends Error {
  constructor(code, message) { super(message); this.bleCode = code; }
}

function requireCredentials(kind) {
  const creds = credentialsFor(kind);
  if (!creds) {
    const label = kind === "youtube" ? "YouTube" : "Facebook";
    const vars = kind === "youtube"
      ? "YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET"
      : "FACEBOOK_APP_ID and FACEBOOK_CLIENT_TOKEN";
    throw new DestError(
      "DEST_NOT_CONFIGURED",
      `This camera has no ${label} app configured, so it cannot link an account. `
      + `Set ${vars} on the box and restart it.`
    );
  }
  return creds;
}

// ── linking ──────────────────────────────────────────────────────────────────

/**
 * Start the device flow. Returns what the phone shows the user; the box then
 * polls on its own, which is the whole point — see the header.
 */
async function begin(kind) {
  if (!KINDS.includes(kind)) throw new DestError("BAD_REQUEST", "kind must be youtube or facebook");
  const creds = requireCredentials(kind);

  // A second attempt replaces the first rather than running two polls at once.
  stopPolling(kind);

  let out;
  if (kind === "youtube") {
    const res = await net.postForm(GOOGLE_DEVICE_CODE_URL, { client_id: creds.id, scope: GOOGLE_SCOPE });
    if (res.statusCode !== 200 || !res.body?.device_code) {
      throw new DestError("DEST_LINK_FAILED", googleMessage(res) || "Google would not start the sign-in.");
    }
    out = {
      verification_url: res.body.verification_url || res.body.verification_uri,
      user_code: res.body.user_code,
      expires_in: res.body.expires_in,
      interval: Math.max(res.body.interval || 5, 5),
      device_code: res.body.device_code,
    };
  } else {
    const res = await net.postForm(FB_DEVICE_URL, {
      access_token: `${creds.id}|${creds.secret}`,
      scope: FB_SCOPE,
    });
    if (res.statusCode !== 200 || !res.body?.code) {
      throw new DestError("DEST_LINK_FAILED", res.body?.error?.message || "Facebook would not start the sign-in.");
    }
    out = {
      verification_url: res.body.verification_uri,
      user_code: res.body.user_code,
      expires_in: res.body.expires_in,
      interval: Math.max(res.body.interval || 5, 5),
      device_code: res.body.code,
    };
  }

  pending[kind] = {
    deviceCode: out.device_code,
    intervalMs: Math.max(out.interval * 1000, MIN_POLL_MS),
    deadline: Date.now() + (out.expires_in || 600) * 1000,
    timer: null,
    lastError: null,
  };
  schedulePoll(kind);
  log(`${kind}: linking started — code ${out.user_code}, polling every ${out.interval}s`);

  // The device code is ours to use and no business of the phone's.
  return {
    verification_url: out.verification_url,
    user_code: out.user_code,
    expires_in: out.expires_in,
    interval: out.interval,
  };
}

function schedulePoll(kind) {
  const p = pending[kind];
  if (!p) return;
  p.timer = setTimeout(() => pollOnce(kind), p.intervalMs);
  // Never hold the process open for a link nobody is waiting on.
  if (p.timer.unref) p.timer.unref();
}

function stopPolling(kind) {
  const p = pending[kind];
  if (p && p.timer) clearTimeout(p.timer);
  pending[kind] = null;
}

async function pollOnce(kind) {
  const p = pending[kind];
  if (!p) return;
  if (Date.now() > p.deadline) {
    log(`${kind}: linking expired before anyone approved it`);
    p.lastError = "The sign-in code expired. Start again.";
    const expired = p.lastError;
    stopPolling(kind);
    pending[kind] = { expiredMessage: expired, timer: null, deadline: 0, intervalMs: 0 };
    return;
  }

  try {
    const done = kind === "youtube" ? await pollGoogle(p) : await pollFacebook(p);
    if (done === "pending") { schedulePoll(kind); return; }
    if (done === "slow_down") { p.intervalMs += 5000; schedulePoll(kind); return; }
    stopPolling(kind);
  } catch (err) {
    // A network blip is not a failed link; keep polling until the code dies.
    log(`${kind}: poll failed (${err.message}) — will retry`);
    schedulePoll(kind);
  }
}

async function pollGoogle(p) {
  const creds = credentialsFor("youtube");
  if (!creds) return "pending";
  const res = await net.postForm(GOOGLE_TOKEN_URL, {
    client_id: creds.id,
    client_secret: creds.secret,
    device_code: p.deviceCode,
    grant_type: GOOGLE_GRANT,
  });
  const err = res.body?.error;
  if (err === "authorization_pending") return "pending";
  if (err === "slow_down") return "slow_down";
  if (err) {
    p.lastError = googleMessage(res) || "Google refused the sign-in.";
    log(`youtube: linking refused — ${err}`);
    return "failed";
  }
  if (!res.body?.refresh_token && !res.body?.access_token) {
    p.lastError = "Google did not return a usable token.";
    return "failed";
  }

  state.youtube = {
    refreshToken: res.body.refresh_token || (state.youtube && state.youtube.refreshToken) || null,
    accessToken: res.body.access_token || null,
    expiresAt: res.body.expires_in ? new Date(Date.now() + res.body.expires_in * 1000).toISOString() : null,
    channelTitle: null,
  };
  save();
  log("youtube: linked");
  // A failure here costs a label, not the link — do not undo a good token
  // because a cosmetic lookup went wrong.
  try {
    const who = await net.getJson(
      `https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true&access_token=${encodeURIComponent(state.youtube.accessToken)}`
    );
    const title = who.body?.items?.[0]?.snippet?.title;
    if (title) { state.youtube.channelTitle = title; save(); }
  } catch { /* label only */ }
  return "linked";
}

async function pollFacebook(p) {
  const creds = credentialsFor("facebook");
  if (!creds) return "pending";
  const res = await net.postForm(FB_DEVICE_STATUS_URL, {
    access_token: `${creds.id}|${creds.secret}`,
    code: p.deviceCode,
  });
  const sub = res.body?.error?.error_subcode;
  if (sub === 1349174) return "pending";       // authorization_pending
  if (sub === 1349172) return "slow_down";     // polling too fast
  if (res.body?.error) {
    p.lastError = res.body.error.message || "Facebook refused the sign-in.";
    log(`facebook: linking refused — ${p.lastError}`);
    return "failed";
  }
  if (!res.body?.access_token) {
    p.lastError = "Facebook did not return a usable token.";
    return "failed";
  }

  state.facebook = {
    accessToken: res.body.access_token,
    expiresAt: res.body.expires_in ? new Date(Date.now() + res.body.expires_in * 1000).toISOString() : null,
    pageName: null,
  };
  save();
  log("facebook: linked");
  try {
    const who = await net.getJson(
      `https://graph.facebook.com/${FB_VERSION}/me/accounts?access_token=${encodeURIComponent(state.facebook.accessToken)}`
    );
    const name = who.body?.data?.[0]?.name;
    if (name) { state.facebook.pageName = name; save(); }
  } catch { /* label only */ }
  return "linked";
}

function googleMessage(res) {
  const b = res.body || {};
  if (b.error_description) return b.error_description;
  if (b.error === "access_denied") return "The sign-in was declined on the phone.";
  if (b.error === "expired_token") return "The sign-in code expired. Start again.";
  return b.error || null;
}

// ── the public surface ───────────────────────────────────────────────────────

/** §6.13 `dest.status`. Never returns a token. */
function status() {
  const describe = (kind) => {
    const v = state[kind];
    const p = pending[kind];
    const out = {
      linked: !!(v && (v.refreshToken || v.accessToken)),
      expiresAt: (v && v.expiresAt) || null,
      linking: !!(p && p.deviceCode),
      lastError: (p && (p.lastError || p.expiredMessage)) || null,
      configured: !!credentialsFor(kind),
    };
    if (kind === "youtube") out.channelTitle = (v && v.channelTitle) || null;
    else out.pageName = (v && v.pageName) || null;
    return out;
  };
  return {
    youtube: describe("youtube"),
    facebook: describe("facebook"),
    cameras: { 1: state.cameras[1], 2: state.cameras[2] },
  };
}

/** §6.13 `dest.assign`. `kind: null` means "None". */
function assign(camera, kind) {
  const cam = Number(camera);
  if (cam !== 1 && cam !== 2) throw new DestError("BAD_REQUEST", "camera must be 1 or 2");
  if (kind !== null && kind !== undefined && !KINDS.includes(kind)) {
    throw new DestError("BAD_REQUEST", "kind must be youtube, facebook, or null");
  }
  const want = kind === undefined ? null : kind;
  if (want && !status()[want].linked) {
    const label = want === "youtube" ? "YouTube" : "Facebook";
    throw new DestError("DEST_NOT_LINKED", `No ${label} account is linked to this camera yet.`);
  }
  state.cameras[cam] = want;
  save();
  log(`camera ${cam} → ${want || "none"}`);
  return status();
}

/** §6.13 `dest.clear`. Any camera pointed at it reverts to None. */
function clear(kind) {
  if (!KINDS.includes(kind)) throw new DestError("BAD_REQUEST", "kind must be youtube or facebook");
  stopPolling(kind);
  state[kind] = null;
  for (const cam of [1, 2]) if (state.cameras[cam] === kind) state.cameras[cam] = null;
  save();
  log(`${kind}: cleared`);
  return status();
}

/**
 * Forget everything. Called by wipeDeviceLocally() — a box handed to another
 * venue must not arrive still able to broadcast to the last one's channel.
 */
function clearAll() {
  for (const kind of KINDS) stopPolling(kind);
  state = { youtube: null, facebook: null, cameras: { 1: null, 2: null } };
  try { fs.unlinkSync(STORE_FILE); } catch { /* already gone */ }
  log("all destinations cleared");
}

function init(opts = {}) {
  if (opts.log) log = opts.log;
  load();
  const s = status();
  const linked = KINDS.filter((k) => s[k].linked);
  if (linked.length) log(`destinations linked: ${linked.join(", ")}`);
  return s;
}

module.exports = {
  init, status, begin, assign, clear, clearAll,
  DestError, KINDS, STORE_FILE,
  // exported for tests
  _internals: { load, save, net, credentialsFor, pending, setState: (s) => { state = s; } },
};
