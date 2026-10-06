// Subscription enforcement — the device may only stream while the DigitalPool
// account that registered it holds a subscription, and WHAT it may do depends on
// which package that subscription includes:
//
//   • Any plan (base)        — the software runs, and the stream can be pushed to
//                              the venue's own YouTube / Facebook / RTMP target.
//                              Their own graphics overlay is replaced by the
//                              DigitalPool branded overlay.
//   • Advanced streaming     — adds the two server output modes our datacenter
//                              consumes (RTSP Server, SRT Server) and the venue's
//                              own overlays (remote scoreboard, Skia graphics).
//
// Which package is held comes from the cloud function as explicit feature flags
// (`features: { overlays, datacenter }`) — see SUBSCRIPTION_CHECK.md.  A flag the
// service does not mention is treated as granted, so adding a package to billing
// never needs a device update and an older cloud function never takes a feature
// away from a paying venue.
//
// Two moments matter:
//
//   1. Registration.  /api/setup/register sends the operator's email+password to
//      the `registerCameraDevice` cloud function; that function now also reports
//      the account's subscription.  No subscription → registration is refused,
//      so an unsubscribed account can never get as far as a registered device.
//
//   2. Every ~14 days after that.  The password is never persisted, so the
//      recurring check is identity-based: it sends the account id recorded at
//      registration (plus device identifiers) to the same function under the
//      `subscription` action.  See SUBSCRIPTION_CHECK.md for the wire contract.
//
// Enforcement is deliberately asymmetric, because a false "no" here means a
// paying venue cannot broadcast a tournament:
//
//   • Only an EXPLICIT "not subscribed" from DigitalPool blocks immediately.
//   • A failed check (venue internet down, function erroring) changes nothing.
//     The last good answer stands and we retry daily; only after the check is
//     ~21 days stale (14 day interval + 7 day grace) does the device stop
//     allowing new streams.
//   • A device that has never received an answer at all (legacy device, or the
//     cloud function not yet reporting subscriptions) is allowed to stream.
//     Enforcement starts the first time DigitalPool actually answers.
//   • A stream that is already running is never torn down.  Only starts and
//     restarts are gated — a lapse mid-match does not kill the broadcast.
const fsSync = require("fs");
const path = require("path");
const { callDigitalPoolFunction } = require("./digitalpoolApi");

const STATE_FILE = path.join(__dirname, "subscription.json");

const DAY_MS  = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

// Tunables, all overridable from .env (the defaults ARE the shipped policy;
// the env vars exist mainly so a check cycle can be exercised in minutes
// instead of weeks when testing).
const positive = (v, fallback) => {
  const n = parseFloat(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const CHECK_DAYS = positive(process.env.SUBSCRIPTION_CHECK_DAYS, 14);
const GRACE_DAYS = positive(process.env.SUBSCRIPTION_GRACE_DAYS, 7);
const RETRY_HRS  = positive(process.env.SUBSCRIPTION_RETRY_HOURS, 24);
const CHECK_MS   = CHECK_DAYS * DAY_MS;
const GRACE_MS   = GRACE_DAYS * DAY_MS;
const RETRY_MS   = RETRY_HRS  * HOUR_MS;
// How often we wake up to ask "is a check due?" — never more than the retry
// interval, so short test intervals still fire.
const TICK_MS = Math.max(60 * 1000, Math.min(HOUR_MS, RETRY_MS));
// Delay before the first check after boot: let NetworkManager/NetBird settle so
// a check does not fail purely because the network is not up yet.
const BOOT_DELAY_MS = positive(process.env.SUBSCRIPTION_BOOT_DELAY_SEC, 90) * 1000;

const SUBSCRIPTION_FUNCTION = () =>
  process.env.DIGITALPOOL_SUBSCRIPTION_FUNCTION
  || process.env.DIGITALPOOL_REGISTER_FUNCTION
  || "registerCameraDevice";
const SUBSCRIPTION_ACTION = () => process.env.DIGITALPOOL_SUBSCRIPTION_ACTION || "subscription";

// "This function has no such action" is an ANSWER, not an outage: the service is
// reachable and healthy, it simply does not know about subscriptions yet.  
// Treating it as a failed verification would start the staleness clock and block
// a paying venue 21 days after the registration half of the backend shipped.
const UNSUPPORTED_ACTION_RE =
  /\b(unknown|unsupported|unrecognised|unrecognized|invalid|missing|bad|not[- ]?implemented)\b[^.]{0,40}\baction\b|\baction\b[^.]{0,40}\b(unknown|unsupported|unrecognised|unrecognized|invalid|not[- ]?implemented|not supported)\b/i;

const saysUnsupportedAction = (body) => {
  const msg = [body?.error, body?.message, body?.raw].filter((v) => typeof v === "string").join(" ");
  return !!msg && UNSUPPORTED_ACTION_RE.test(msg);
};

// Billing states that still entitle the device to stream.  `past_due` is
// deliberately on this list: dunning is between DigitalPool and the card
// issuer, and a venue should not lose its camera the hour a renewal fails.
const ACTIVE_STATUSES = new Set([
  "active", "trialing", "trial", "past_due", "pastdue", "grace", "comped", "lifetime",
]);
const INACTIVE_STATUSES = new Set([
  "canceled", "cancelled", "expired", "inactive", "none", "unpaid",
  "incomplete", "incomplete_expired", "paused", "deleted", "no_subscription",
]);

// The capabilities a plan can carry.  Tri-state everywhere: true = granted,
// false = explicitly withheld, null = the service said nothing, which is granted
// (see the header).  Only `false` ever takes something away.
const FEATURES = ["overlays", "datacenter"];
const EMPTY_FEATURES = { overlays: null, datacenter: null };

// Output modes that reach DigitalPool's datacenter: the device publishes and a
// remote puller (Wowza over NetBird) consumes it.  Push modes — rtmp, and its
// youtube/facebook UI aliases — go to the venue's own destination and need only
// a base plan.
const DATACENTER_PROTOCOLS = new Set(["rtsp", "srt"]);
const PROTOCOL_LABELS = { rtsp: "RTSP Server", srt: "SRT Server" };

// ── State ────────────────────────────────────────────────────────────────────
// Persisted to subscription.json (runtime state, like camera-config*.json —
// not committed).  `active: null` means "DigitalPool has never told us".
const EMPTY_STATE = {
  active:        null,
  plan:          "",
  status:        "",
  features:      { ...EMPTY_FEATURES },
  expiresAt:     null,
  lastCheckedAt: null,   // last attempt, success or failure
  lastSuccessAt: null,   // last time DigitalPool answered with subscription info
  lastActiveAt:  null,   // last answer that said "subscribed" — the grace clock
  lastError:     "",
  lastErrorAt:   null,
  source:        "",     // "registration" | "check"
};

let state = { ...EMPTY_STATE };
let getIdentity = () => ({});
let onChange = () => {};
let tickTimer = null;
let bootTimer = null;
let checkInFlight = null;
let warnedNoReport = false;

function load() {
  try {
    if (fsSync.existsSync(STATE_FILE)) {
      const saved = JSON.parse(fsSync.readFileSync(STATE_FILE, "utf8"));
      state = { ...EMPTY_STATE, ...saved, features: { ...EMPTY_FEATURES, ...(saved.features || {}) } };
    }
  } catch (e) {
    console.warn("⚠️  subscription.json unreadable — starting fresh:", e.message);
    state = { ...EMPTY_STATE };
  }
}

function save() {
  try {
    fsSync.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.warn("⚠️  Could not write subscription.json:", e.message);
  }
}

// ── Response parsing ─────────────────────────────────────────────────────────

const firstDefined = (...vals) => vals.find((v) => v !== undefined && v !== null);

/** Normalise an expiry to an ISO string — accepts ISO text, epoch s, epoch ms. */
function normaliseExpiry(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw === "number") {
    // Stripe-style epoch seconds vs JS milliseconds.
    const ms = raw < 1e11 ? raw * 1000 : raw;
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof raw === "object" && raw._seconds) return new Date(raw._seconds * 1000).toISOString();
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Pull subscription facts out of a cloud-function response body.  Tolerant of
 * field naming because the same shape has to be readable whether it arrives
 * nested under `subscription` or flattened onto the verify/assign response.
 *
 * Returns { known, active, plan, status, expiresAt }.  `known: false` means the
 * response carried no subscription information at all — which is NOT the same
 * as "no subscription", and never blocks.
 */
/**
 * Read the per-package flags.  Accepts an explicit `features` map, a `tier` /
 * `level` string ("advanced" grants everything, "base"/"basic"/"standard" grants
 * neither), or flags sitting directly on the subscription object.  Anything the
 * response does not mention stays null — granted, not withheld.
 */
function parseFeatures(sub, body) {
  const out = { ...EMPTY_FEATURES };
  const bool = (v) => {
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0;
    if (typeof v === "string" && /^(true|yes|1|on|enabled)$/i.test(v.trim())) return true;
    if (typeof v === "string" && /^(false|no|0|off|disabled)$/i.test(v.trim())) return false;
    return null;
  };

  const maps = [sub.features, sub.feature_flags, sub.featureFlags, body && body.features]
    .filter((m) => m && typeof m === "object" && !Array.isArray(m));
  // A plain list — features: ["overlays", "datacenter"] — grants what it names
  // and withholds the rest, since the list is the complete set.
  const lists = [sub.features, body && body.features].filter(Array.isArray);

  const alias = {
    overlays:   ["overlays", "overlay", "graphics", "custom_overlays", "customOverlays"],
    datacenter: ["datacenter", "data_center", "dataCenter", "advanced_streaming",
                 "advancedStreaming", "advanced", "streaming", "server_modes", "serverModes"],
  };

  for (const feat of FEATURES) {
    for (const key of alias[feat]) {
      for (const m of maps) {
        const v = bool(m[key]);
        if (v !== null) { out[feat] = v; break; }
      }
      if (out[feat] !== null) break;
      const v = bool(sub[key]);
      if (v !== null) { out[feat] = v; break; }
    }
    if (out[feat] === null && lists.length) {
      out[feat] = lists.some((l) => l.some((x) => alias[feat].includes(String(x).trim())));
    }
  }

  // A tier string fills in whatever the flags did not say.
  const tier = String(firstDefined(sub.tier, sub.level, sub.package, body && body.tier, "") || "")
    .trim().toLowerCase();
  if (tier) {
    const advanced = /^(advanced|pro|premium|plus|elite|full)/.test(tier) ? true
                   : /^(base|basic|standard|starter|lite|free)/.test(tier) ? false
                   : null;
    if (advanced !== null)
      for (const feat of FEATURES) if (out[feat] === null) out[feat] = advanced;
  }
  return out;
}

function parseSubscription(body) {
  const miss = { known: false, active: null, plan: "", status: "", expiresAt: null, features: { ...EMPTY_FEATURES } };
  if (!body || typeof body !== "object") return miss;

  const sub = (body.subscription && typeof body.subscription === "object") ? body.subscription : body;

  const flag = firstDefined(
    sub.subscribed, sub.is_subscribed, sub.isSubscribed,
    sub.active, sub.is_active, sub.isActive,
    sub.has_subscription, sub.hasSubscription,
    body.subscribed, body.has_subscription, body.hasSubscription,
  );
  const status = String(firstDefined(
    sub.status, sub.subscription_status, sub.subscriptionStatus,
    body.subscription_status, body.subscriptionStatus, "",
  ) || "").trim().toLowerCase();
  const plan = String(firstDefined(
    sub.plan, sub.plan_name, sub.planName, sub.tier, sub.product, sub.level,
    body.plan, body.plan_name, body.planName, "",
  ) || "").trim();
  const expiresAt = normaliseExpiry(firstDefined(
    sub.expires_at, sub.expiresAt, sub.current_period_end, sub.currentPeriodEnd,
    sub.renews_at, sub.renewsAt, body.expires_at, body.expiresAt,
  ));

  let active = null;
  if (typeof flag === "boolean") active = flag;
  else if (typeof flag === "string" && /^(true|false|yes|no|1|0)$/i.test(flag.trim()))
    active = /^(true|yes|1)$/i.test(flag.trim());
  else if (ACTIVE_STATUSES.has(status)) active = true;
  else if (INACTIVE_STATUSES.has(status)) active = false;
  else if (status) active = false;  // an unrecognised explicit status is not an entitlement
  else if (plan) active = true;     // a plan name and nothing else = subscribed

  if (active === null) return miss;
  // A lapsed account holds no packages, whatever the flags happen to say.
  const features = active ? parseFeatures(sub, body) : { overlays: false, datacenter: false };
  return { known: true, active, plan, status, expiresAt, features };
}

// ── Applying a result ────────────────────────────────────────────────────────

const sameFeatures = (a, b) => FEATURES.every((f) => a[f] === b[f]);

function applyParsed(parsed, source) {
  const before = { active: state.active, plan: state.plan, status: state.status,
                   features: { ...state.features } };
  const now = new Date().toISOString();
  state.active        = parsed.active;
  // Keep a remembered plan name only while the account is still entitled —
  // otherwise a lapse reads as "Pro (canceled)" in the log and the UI.
  state.plan          = parsed.plan || (parsed.active ? state.plan : "");
  state.status        = parsed.status || (parsed.active ? "active" : "none");
  state.expiresAt     = parsed.expiresAt !== null ? parsed.expiresAt : state.expiresAt;
  state.features      = { ...EMPTY_FEATURES, ...(parsed.features || {}) };
  state.lastCheckedAt = now;
  state.lastSuccessAt = now;
  state.source        = source;
  state.lastError     = "";
  state.lastErrorAt   = null;
  if (parsed.active) state.lastActiveAt = now;
  save();

  const changed = before.active !== state.active || before.plan !== state.plan
               || before.status !== state.status || !sameFeatures(before.features, state.features);
  if (changed) {
    const label = state.plan ? `${state.plan}${state.status ? ` (${state.status})` : ""}` : (state.status || "—");
    const pkgs = FEATURES.filter((f) => state.features[f] !== false).join(", ") || "none";
    console.log(parsed.active
      ? `✅ Subscription verified (${source}): ${label} — packages: ${pkgs}`
      : `⛔ No active DigitalPool subscription (${source}): ${label}`);
    notify();
  }
}

function recordFailure(message) {
  state.lastCheckedAt = new Date().toISOString();
  state.lastError     = message;
  state.lastErrorAt   = state.lastCheckedAt;
  save();
  const g = gate();
  console.warn(`⚠️  Subscription check failed: ${message}${g.allowed ? " — last known state stands" : " — grace period exhausted, streaming blocked"}`);
  if (!g.allowed) notify();
}

function notify() {
  try { onChange(getStatus()); } catch { /* listener's problem */ }
}

// ── The gate ─────────────────────────────────────────────────────────────────

/**
 * May a NEW stream start?  Returns { allowed, code, message }.
 * Never consults the network — this is a pure read of persisted state, so it is
 * safe to call on every stream start.
 */
function gate() {
  if (state.active === false) {
    return {
      allowed: false,
      code:    "subscription_inactive",
      message: "This device's DigitalPool account does not have an active subscription. "
             + "Subscribe at digitalpool.com, then click Re-check in Admin Settings → Device Registration.",
    };
  }
  if (state.active === true) {
    const anchor = Date.parse(state.lastActiveAt || state.lastSuccessAt || "") || 0;
    if (anchor && Date.now() > anchor + CHECK_MS + GRACE_MS) {
      const days = Math.floor((Date.now() - anchor) / DAY_MS);
      return {
        allowed: false,
        code:    "subscription_unverified",
        message: `This device has not been able to verify its DigitalPool subscription for ${days} days. `
               + "Connect it to the internet and click Re-check in Admin Settings → Device Registration.",
      };
    }
    return { allowed: true, code: "subscription_active", message: "" };
  }
  // Never verified either way — fail open (see the header comment).
  return { allowed: true, code: "subscription_unknown", message: "" };
}

/**
 * Is a package available right now?  `false` only when the service explicitly
 * withheld it AND the subscription itself is in good standing — when the base
 * gate is shut, gate() is what refuses, and every package reads as unavailable.
 */
function can(feature) {
  if (!gate().allowed) return false;
  return state.features[feature] !== false;
}

/** Both packages as plain booleans, for the API and the UI. */
function features() {
  const base = gate().allowed;
  const out = { subscribed: base };
  for (const f of FEATURES) out[f] = base && state.features[f] !== false;
  return out;
}

/**
 * May this output mode be used?  Returns null when allowed, or a refusal.
 * RTSP Server and SRT Server are how the stream reaches DigitalPool's
 * datacenter and need the advanced streaming package; RTMP push (including the
 * YouTube and Facebook presets) goes to the venue's own destination and needs
 * only a base plan.
 */
function gateProtocol(protocol) {
  const p = String(protocol || "").toLowerCase();
  if (!DATACENTER_PROTOCOLS.has(p)) return null;
  if (can("datacenter")) return null;
  return {
    code:    "package_required",
    feature: "datacenter",
    message: `${PROTOCOL_LABELS[p] || p.toUpperCase()} output requires the Advanced Streaming package. `
           + "Your current plan can stream to YouTube, Facebook or your own RTMP destination. "
           + "Upgrade at digitalpool.com to stream back to DigitalPool.",
  };
}

/** When the next scheduled check is due (ISO string), or null if unknown. */
function nextCheckAt() {
  const base = Date.parse(state.lastSuccessAt || "") || 0;
  if (!base) {
    const last = Date.parse(state.lastCheckedAt || "") || 0;
    return last ? new Date(last + RETRY_MS).toISOString() : null;
  }
  const scheduled = base + CHECK_MS;
  const failedSince = (Date.parse(state.lastCheckedAt || "") || 0) > base;
  const retryAt = failedSince ? (Date.parse(state.lastCheckedAt) + RETRY_MS) : 0;
  return new Date(Math.max(scheduled, retryAt)).toISOString();
}

function isDue() {
  const now = Date.now();
  const lastChecked = Date.parse(state.lastCheckedAt || "") || 0;
  const lastSuccess = Date.parse(state.lastSuccessAt || "") || 0;
  // Never hammer: at most one attempt per retry interval.
  if (lastChecked && now - lastChecked < RETRY_MS) return false;
  if (!lastSuccess) return true;                      // never got an answer
  return now - lastSuccess >= CHECK_MS;
}

// ── The check itself ─────────────────────────────────────────────────────────

/**
 * Ask DigitalPool whether the registering account still has a subscription.
 * Resolves to { ok, state, error } — it never throws and never rejects.
 * Concurrent callers share one in-flight request.
 */
function checkNow(reason = "manual") {
  if (checkInFlight) return checkInFlight;
  checkInFlight = (async () => {
    const id = getIdentity() || {};
    if (!id.registered) return { ok: false, error: "Device is not registered", status: getStatus() };
    // Identity-based: the account id recorded at registration is what the cloud
    // function looks the subscription up by.  Email is sent as a fallback for
    // devices registered before user ids were stored.
    if (!id.userId && !id.ownerEmail)
      return { ok: false, error: "No DigitalPool account on file — re-register this device", status: getStatus() };

    const payload = {
      action:     SUBSCRIPTION_ACTION(),
      userId:     id.userId     || "",
      user_id:    id.userId     || "",
      email:      id.ownerEmail || "",
      deviceId:   id.deviceId   || "",
      deviceName: id.deviceName || "",
      macAddress: id.macAddress || "",
      netbirdIp:  id.netbirdIp  || "",
      venueId:    id.venueId    || "",
    };

    let resp;
    try {
      resp = await callDigitalPoolFunction(SUBSCRIPTION_FUNCTION(), payload, { timeout: 20000 });
    } catch (e) {
      recordFailure(`could not reach DigitalPool (${e.message})`);
      return { ok: false, error: e.message, status: getStatus() };
    }

    // Parse before judging the status code: a 402/403 that carries an explicit
    // "not subscribed" is an answer, not a failure.
    const parsed = parseSubscription(resp.body);
    if (parsed.known) {
      applyParsed(parsed, reason === "registration" ? "registration" : "check");
      return { ok: true, status: getStatus() };
    }

    const unsupported = saysUnsupportedAction(resp.body);
    if ((resp.statusCode >= 400 || resp.body?.ok === false) && !unsupported) {
      recordFailure(resp.body?.error || `DigitalPool returned HTTP ${resp.statusCode}`);
      return { ok: false, error: resp.body?.error || `HTTP ${resp.statusCode}`, status: getStatus() };
    }

    // The service answered, but said nothing about subscriptions — either it
    // does not report them yet, or it does not know this action at all.  That is
    // "no change", NOT "could not verify": the device heard from DigitalPool, so
    // the staleness clock must keep moving with it, otherwise a backend that
    // ships registration before the subscription action locks every device out
    // 21 days later.  Entitlements are left exactly as they were.
    state.lastCheckedAt = new Date().toISOString();
    state.lastSuccessAt = state.lastCheckedAt;
    if (state.active === true) state.lastActiveAt = state.lastCheckedAt;
    state.lastError     = "";
    state.lastErrorAt   = null;
    save();
    if (!warnedNoReport) {
      warnedNoReport = true;
      console.warn(`ℹ️  DigitalPool did not report a subscription for action "${SUBSCRIPTION_ACTION()}"`
                 + `${unsupported ? " (action not implemented)" : ""} — `
                 + "entitlements are unchanged until it does (see SUBSCRIPTION_CHECK.md)");
    }
    return { ok: true, reported: false, status: getStatus() };
  })().finally(() => { checkInFlight = null; });
  return checkInFlight;
}

async function tick() {
  try {
    const id = getIdentity() || {};
    if (!id.registered) return;
    if (!isDue()) return;
    await checkNow("scheduled");
  } catch (e) {
    console.warn("⚠️  Subscription tick error:", e.message);
  }
}

// ── Public surface ───────────────────────────────────────────────────────────

/**
 * @param {object}   opts
 * @param {function} opts.getIdentity Returns { registered, userId, ownerEmail,
 *                   deviceId, deviceName, macAddress, netbirdIp, venueId }.
 * @param {function} [opts.onChange]  Called with getStatus() when the gate or
 *                   the subscription state changes (used to push to the UI).
 */
function init(opts = {}) {
  if (typeof opts.getIdentity === "function") getIdentity = opts.getIdentity;
  if (typeof opts.onChange === "function") onChange = opts.onChange;
  load();
  return module.exports;
}

/** Begin the periodic check (first attempt ~90 s after boot). */
function start() {
  if (tickTimer) return;
  bootTimer = setTimeout(() => { tick(); }, BOOT_DELAY_MS);
  tickTimer = setInterval(tick, TICK_MS);
  bootTimer.unref?.();
  tickTimer.unref?.();
  console.log(`🧾 Subscription checks every ${CHECK_DAYS} days (${GRACE_DAYS} day grace, retry every ${RETRY_HRS} h)`);
}

function stop() {
  if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
}

// Words a refusal uses when it names the problem instead of encoding it.
const WORDED_REFUSAL_RE = /\bsubscriptions?\b|\bsubscribed?\b|\bplan\b/i;

/**
 * What does a verify/assign response mean for registration?
 *
 * A refusal legitimately arrives as `ok: false` / 4xx, which is indistinguishable
 * from a rejected login unless the body is actually read — so this is the one
 * place that decides, and the registration routes ask it BEFORE they treat a
 * response as an auth failure.  Two ways a refusal is recognised:
 *
 *   explicit — the body carries subscription data saying "not subscribed"
 *   worded   — the service refused and said why in prose, with no machine
 *              readable subscription object ("This account has no active
 *              DigitalPool camera subscription")
 *
 * A genuine auth error ("Invalid credentials") matches neither and falls through.
 * Recording the parsed state is part of the job, so callers cannot forget it.
 *
 * @param {{statusCode?: number, body?: object}|object} resp  response, or a bare body
 * @returns {{refused: boolean, reason: string|null, message: string, parsed: object}}
 */
function classifyRegistration(resp) {
  const hasEnvelope = resp && typeof resp === "object" && ("body" in resp || "statusCode" in resp);
  const body       = hasEnvelope ? resp.body : resp;
  const statusCode = hasEnvelope && typeof resp.statusCode === "number" ? resp.statusCode : 200;

  const parsed  = recordRegistrationResult(body);
  const message = String(body?.error || body?.message || "");
  const refused = statusCode >= 400 || body?.ok === false || body?.success === false;

  if (parsed.known && !parsed.active) return { refused: true, reason: "explicit", message, parsed };
  if (refused && WORDED_REFUSAL_RE.test(message)) return { refused: true, reason: "worded", message, parsed };
  return { refused: false, reason: null, message, parsed };
}

/** Record subscription facts returned by the registration (verify/assign) call. */
function recordRegistrationResult(body) {
  const parsed = parseSubscription(body);
  if (parsed.known) applyParsed(parsed, "registration");
  return parsed;
}

/** Forget everything — used when the device is de-registered. */
function clear() {
  state = { ...EMPTY_STATE };
  warnedNoReport = false;
  save();
  notify();
}

/** Serialisable view for the API/UI. */
function getStatus() {
  const g = gate();
  return {
    known:         state.active !== null,
    active:        state.active,
    plan:          state.plan,
    status:        state.status,
    expiresAt:     state.expiresAt,
    lastCheckedAt: state.lastCheckedAt,
    lastSuccessAt: state.lastSuccessAt,
    lastActiveAt:  state.lastActiveAt,
    nextCheckAt:   nextCheckAt(),
    lastError:     state.lastError,
    checkDays:     CHECK_DAYS,
    graceDays:     GRACE_DAYS,
    allowed:       g.allowed,
    code:          g.code,
    message:       g.message,
    features:      features(),
    // Which Output Modes the UI should lock, so it does not have to know the
    // protocol→package mapping.
    lockedProtocols: [...DATACENTER_PROTOCOLS].filter((p) => !!gateProtocol(p)),
  };
}

module.exports = {
  init, start, stop,
  checkNow, gate, gateProtocol, can, features, getStatus, clear,
  recordRegistrationResult, classifyRegistration, parseSubscription,
  FEATURES, DATACENTER_PROTOCOLS, STATE_FILE,
};
