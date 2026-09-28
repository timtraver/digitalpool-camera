/**
 * Email alerts for things an operator would want to know about without being
 * logged in: a stream restarting itself, a camera vanishing, the service
 * starting, a recording dying mid-match.
 *
 * Sends over a mail provider's HTTPS API rather than SMTP — no new npm
 * dependency (node:https is enough), no SMTP/TLS handshake code to maintain,
 * and a failure comes back as a status code and a body instead of a protocol
 * stall. Supports Resend, SendGrid, Postmark and Mailgun; what differs between
 * them is URL, auth, content type and body shape, which is all PROVIDERS holds.
 *
 * Configure in .env (all optional — absent means alerting is simply off):
 *   ALERT_EMAIL_TO     recipient(s), comma-separated
 *   ALERT_EMAIL_FROM   sender; must be an address the provider has verified
 *   ALERT_API_KEY      provider API key (Mailgun: the private API key)
 *   ALERT_PROVIDER     resend (default) | sendgrid | postmark | mailgun
 *   ALERT_MAILGUN_DOMAIN   mailgun only, required — the verified sending domain
 *   ALERT_MAILGUN_REGION   mailgun only, us (default) | eu
 *   ALERT_EVENTS       comma-separated event classes to send; default "all".
 *                      Classes: stream, service, camera, recording
 *   ALERT_MIN_INTERVAL_S   per-key cooldown, default 600
 *   ALERT_MAX_PER_HOUR     hard cap across all alerts, default 20
 *
 * Two things this deliberately does NOT do:
 *   • Throw. An alert path must never be able to take down the streamer, so
 *     every failure is logged and swallowed.
 *   • Block. sendAlert() returns immediately; delivery happens on its own.
 */

const https = require("https");
const os = require("os");

/**
 * Per-provider differences, and nothing else.
 *
 * Mailgun is why this is shaped as it is rather than "same JSON, different
 * header": it authenticates with HTTP Basic (user "api", password the key),
 * puts the sending domain in the path, and takes form-encoded fields instead
 * of JSON. So each provider owns its host, path, headers, content type and
 * body serialisation, and `requires` reports config it cannot work without.
 */
const PROVIDERS = {
  resend: {
    host: () => "api.resend.com",
    path: () => "/emails",
    headers: (cfg) => ({ Authorization: `Bearer ${cfg.key}` }),
    contentType: "application/json",
    serialize: ({ from, to, subject, text }) => JSON.stringify({ from, to, subject, text }),
    requires: () => "",
  },

  sendgrid: {
    host: () => "api.sendgrid.com",
    path: () => "/v3/mail/send",
    headers: (cfg) => ({ Authorization: `Bearer ${cfg.key}` }),
    contentType: "application/json",
    serialize: ({ from, to, subject, text }) => JSON.stringify({
      personalizations: [{ to: to.map((a) => ({ email: a })) }],
      from: { email: from },
      subject,
      content: [{ type: "text/plain", value: text }],
    }),
    requires: () => "",
  },

  postmark: {
    host: () => "api.postmarkapp.com",
    path: () => "/email",
    headers: (cfg) => ({ "X-Postmark-Server-Token": cfg.key }),
    contentType: "application/json",
    serialize: ({ from, to, subject, text }) => JSON.stringify({
      From: from, To: to.join(","), Subject: subject, TextBody: text,
    }),
    requires: () => "",
  },

  mailgun: {
    // EU-region accounts are a different hostname entirely, and sending to the
    // US host with EU credentials fails authentication in a way that reads like
    // a bad key.
    host: (cfg) => (cfg.mailgunRegion === "eu" ? "api.eu.mailgun.net" : "api.mailgun.net"),
    path: (cfg) => `/v3/${encodeURIComponent(cfg.mailgunDomain)}/messages`,
    headers: (cfg) => ({
      Authorization: "Basic " + Buffer.from(`api:${cfg.key}`).toString("base64"),
    }),
    contentType: "application/x-www-form-urlencoded",
    serialize: ({ from, to, subject, text }) => new URLSearchParams({
      from, to: to.join(","), subject, text,
    }).toString(),
    // The domain is part of the URL, so there is no sensible default: without it
    // the request is a 404 against /v3//messages.
    requires: (cfg) => (cfg.mailgunDomain ? "" : "ALERT_MAILGUN_DOMAIN is required for mailgun"),
  },
};

// Retry schedule for a failed send. Venue internet drops out; an alert about a
// camera dying is worth three tries over ~2 minutes. Beyond that the moment has
// passed and the journal is the record.
const RETRY_BACKOFF_MS = [15000, 45000, 60000];

class AlertMailer {
  constructor(env = process.env) {
    this.to = (env.ALERT_EMAIL_TO || "").split(",").map((s) => s.trim()).filter(Boolean);
    this.from = (env.ALERT_EMAIL_FROM || "").trim();
    this.key = (env.ALERT_API_KEY || "").trim();
    this.providerName = (env.ALERT_PROVIDER || "resend").trim().toLowerCase();
    this.provider = PROVIDERS[this.providerName] || null;

    // Mailgun-specific. The domain is part of the request URL and the region
    // decides the hostname, so both are read here and handed to the provider
    // entry as plain config rather than being reached for from inside it.
    this.mailgunDomain = (env.ALERT_MAILGUN_DOMAIN || "").trim();
    this.mailgunRegion = (env.ALERT_MAILGUN_REGION || "us").trim().toLowerCase();

    const events = (env.ALERT_EVENTS || "all").trim().toLowerCase();
    this.events = events === "all" ? null : new Set(events.split(",").map((s) => s.trim()));

    this.minIntervalMs = (Number(env.ALERT_MIN_INTERVAL_S) || 600) * 1000;
    this.maxPerHour = Number(env.ALERT_MAX_PER_HOUR) || 20;

    // Device identity, so an alert from a fleet of appliances says which one.
    // The hostname is the fallback; setIdentity() supplies the venue and the
    // registered device name once the app has them.
    this.deviceName = os.hostname();
    this._identity = null;

    this._lastSentAt = new Map();   // dedupe key → epoch ms
    this._suppressed = new Map();   // dedupe key → count suppressed since
    this._sentTimes = [];           // epoch ms of recent sends, for the hourly cap
  }

  /**
   * Supply a function returning { venueName, deviceName, ownerEmail } — the
   * venue this appliance sits in, for the subject line and the body.
   *
   * A function, not a value, because registration can happen (or change) long
   * after boot: an alert sent at 09:00 should carry whatever the device knew at
   * 09:00, not whatever it knew when the process started. It is called inside a
   * try/catch on every send, so a broken provider costs the identity, not the
   * alert.
   */
  setIdentity(fn) {
    this._identity = fn;
  }

  /** Current identity, falling back to the hostname alone. */
  _who() {
    let info = {};
    try {
      if (this._identity) info = this._identity() || {};
    } catch (e) {
      console.warn("📧 Alert identity lookup failed:", e.message);
    }
    const device = (info.deviceName || "").trim() || this.deviceName;
    const venue = (info.venueName || "").trim();
    return {
      device,
      venue,
      owner: (info.ownerEmail || "").trim(),
      // "Venue — device" is what an operator with several venues needs to see
      // first in a full inbox; unregistered devices still get their hostname.
      label: venue ? `${venue} — ${device}` : device,
    };
  }

  /** What this provider still needs, or "" when it has everything. */
  get missingProviderConfig() {
    return this.provider ? this.provider.requires(this) : "";
  }

  /** Whether enough is configured to send anything at all. */
  get enabled() {
    return !!(this.to.length && this.from && this.key && this.provider) &&
           !this.missingProviderConfig;
  }

  /** One line for the boot log saying whether alerts are on, and if not, why. */
  describe() {
    if (this.to.length === 0 && !this.key) return "📧 Email alerts: not configured (set ALERT_* in .env)";
    if (!this.provider) return `📧 Email alerts: OFF — unknown ALERT_PROVIDER "${this.providerName}"`;
    if (!this.to.length) return "📧 Email alerts: OFF — ALERT_EMAIL_TO is empty";
    if (!this.from) return "📧 Email alerts: OFF — ALERT_EMAIL_FROM is empty";
    if (!this.key) return "📧 Email alerts: OFF — ALERT_API_KEY is empty";
    if (this.missingProviderConfig) return `📧 Email alerts: OFF — ${this.missingProviderConfig}`;
    const classes = this.events ? [...this.events].join(", ") : "all";
    const via = this.providerName === "mailgun"
      ? `mailgun (${this.mailgunDomain}, ${this.mailgunRegion} region)`
      : this.providerName;
    return `📧 Email alerts: ON via ${via} → ${this.to.join(", ")} (events: ${classes})`;
  }

  /**
   * Queue one alert.
   *
   * @param {object} alert
   * @param {string} alert.eventClass  stream | service | camera | recording
   * @param {string} alert.subject     one line, no device name (added here)
   * @param {string} [alert.detail]    body text
   * @param {string} [alert.key]       dedupe key; defaults to the subject, so a
   *                                   flapping camera coalesces instead of
   *                                   sending mail every 45 seconds
   * @param {boolean} [alert.force]    bypass the cooldown (not the hourly cap)
   */
  sendAlert({ eventClass, subject, detail = "", key, force = false }) {
    try {
      if (!this.enabled) return;
      if (this.events && !this.events.has(eventClass)) return;

      const now = Date.now();
      const dedupeKey = key || `${eventClass}:${subject}`;

      // Per-key cooldown. A suppressed alert is counted, and the count rides
      // along on the next one that does go out — so a storm reads as
      // "(14 more like this since 09:12)" instead of vanishing silently.
      const last = this._lastSentAt.get(dedupeKey) || 0;
      if (!force && now - last < this.minIntervalMs) {
        this._suppressed.set(dedupeKey, (this._suppressed.get(dedupeKey) || 0) + 1);
        return;
      }

      // Hourly cap across everything, so no bug in a caller can turn the device
      // into a mail loop.
      this._sentTimes = this._sentTimes.filter((t) => now - t < 3600000);
      if (this._sentTimes.length >= this.maxPerHour) {
        console.warn(`📧 Alert suppressed (hourly cap of ${this.maxPerHour} reached): ${subject}`);
        return;
      }

      const suppressedCount = this._suppressed.get(dedupeKey) || 0;
      this._suppressed.delete(dedupeKey);
      this._lastSentAt.set(dedupeKey, now);
      this._sentTimes.push(now);

      const who = this._who();
      const body = this._composeBody({ eventClass, detail, suppressedCount, since: last, who });
      this._deliver(`[${who.label}] ${subject}`, body, 0);
    } catch (e) {
      console.warn("📧 Alert failed to queue:", e.message);
    }
  }

  _composeBody({ eventClass, detail, suppressedCount, since, who }) {
    const lines = [];
    if (detail) lines.push(detail, "");
    if (suppressedCount > 0) {
      lines.push(`(${suppressedCount} more like this were suppressed since ` +
                 `${new Date(since).toLocaleString()})`, "");
    }
    if (who.venue) lines.push(`Venue:   ${who.venue}`);
    lines.push(`Device:  ${who.device}`);
    if (who.owner) lines.push(`Owner:   ${who.owner}`);
    lines.push(`Event:   ${eventClass}`);
    lines.push(`Time:    ${new Date().toLocaleString()}`);
    const ips = [];
    for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
      for (const a of addrs || []) {
        if (a.family === "IPv4" && !a.internal) ips.push(`${name} ${a.address}`);
      }
    }
    if (ips.length) lines.push(`Network: ${ips.join(", ")}`);
    lines.push(`Uptime:  ${Math.round(os.uptime() / 60)} min`);
    return lines.join("\n");
  }

  /** POST to the provider, retrying transient failures on the backoff schedule. */
  _deliver(subject, text, attempt) {
    const payload = this.provider.serialize({
      from: this.from, to: this.to, subject, text,
    });
    const req = https.request(
      {
        host: this.provider.host(this),
        path: this.provider.path(this),
        method: "POST",
        timeout: 15000,
        headers: {
          "Content-Type": this.provider.contentType,
          "Content-Length": Buffer.byteLength(payload),
          ...this.provider.headers(this),
        },
      },
      (res) => {
        let body = "";
        res.on("data", (d) => { body += d; });
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            console.log(`📧 Alert sent: ${subject}`);
            return;
          }
          // 4xx is a configuration problem — a wrong key or an unverified
          // sender — and retrying just repeats it. 5xx is worth another go.
          const retryable = res.statusCode >= 500;
          console.warn(`📧 Alert rejected (HTTP ${res.statusCode}): ${body.slice(0, 200)}`);
          if (retryable) this._retry(subject, text, attempt);
        });
      }
    );
    req.on("error", (e) => {
      console.warn(`📧 Alert send failed: ${e.message}`);
      this._retry(subject, text, attempt);
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.write(payload);
    req.end();
  }

  _retry(subject, text, attempt) {
    if (attempt >= RETRY_BACKOFF_MS.length) {
      console.warn(`📧 Alert given up after ${attempt + 1} attempts: ${subject}`);
      return;
    }
    const delay = RETRY_BACKOFF_MS[attempt];
    console.log(`📧 Retrying alert in ${delay / 1000}s: ${subject}`);
    const t = setTimeout(() => this._deliver(subject, text, attempt + 1), delay);
    if (typeof t.unref === "function") t.unref(); // never hold up a shutdown
  }
}

module.exports = { AlertMailer, PROVIDERS };
