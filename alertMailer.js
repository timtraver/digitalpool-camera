/**
 * Email alerts for things an operator would want to know about without being
 * logged in: a stream restarting itself, a camera vanishing, the service
 * starting, a recording dying mid-match.
 *
 * Sends over a mail provider's HTTPS API rather than SMTP — no new npm
 * dependency (node:https is enough), no SMTP/TLS handshake code to maintain,
 * and a failure comes back as a status code and a body instead of a protocol
 * stall. Supports Resend, SendGrid and Postmark; they differ only in URL, auth
 * header and body shape, which is all PROVIDERS below holds.
 *
 * Configure in .env (all optional — absent means alerting is simply off):
 *   ALERT_EMAIL_TO     recipient(s), comma-separated
 *   ALERT_EMAIL_FROM   sender; must be an address the provider has verified
 *   ALERT_API_KEY      provider API key
 *   ALERT_PROVIDER     resend (default) | sendgrid | postmark
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

const PROVIDERS = {
  resend: {
    host: "api.resend.com",
    path: "/emails",
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
    body: ({ from, to, subject, text }) => ({ from, to, subject, text }),
  },
  sendgrid: {
    host: "api.sendgrid.com",
    path: "/v3/mail/send",
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
    body: ({ from, to, subject, text }) => ({
      personalizations: [{ to: to.map((a) => ({ email: a })) }],
      from: { email: from },
      subject,
      content: [{ type: "text/plain", value: text }],
    }),
  },
  postmark: {
    host: "api.postmarkapp.com",
    path: "/email",
    headers: (key) => ({ "X-Postmark-Server-Token": key }),
    body: ({ from, to, subject, text }) => ({
      From: from,
      To: to.join(","),
      Subject: subject,
      TextBody: text,
    }),
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

    const events = (env.ALERT_EVENTS || "all").trim().toLowerCase();
    this.events = events === "all" ? null : new Set(events.split(",").map((s) => s.trim()));

    this.minIntervalMs = (Number(env.ALERT_MIN_INTERVAL_S) || 600) * 1000;
    this.maxPerHour = Number(env.ALERT_MAX_PER_HOUR) || 20;

    // Device identity, so an alert from a fleet of appliances says which one.
    this.deviceName = os.hostname();

    this._lastSentAt = new Map();   // dedupe key → epoch ms
    this._suppressed = new Map();   // dedupe key → count suppressed since
    this._sentTimes = [];           // epoch ms of recent sends, for the hourly cap
  }

  /** Whether enough is configured to send anything at all. */
  get enabled() {
    return !!(this.to.length && this.from && this.key && this.provider);
  }

  /** One line for the boot log saying whether alerts are on, and if not, why. */
  describe() {
    if (this.to.length === 0 && !this.key) return "📧 Email alerts: not configured (set ALERT_* in .env)";
    if (!this.provider) return `📧 Email alerts: OFF — unknown ALERT_PROVIDER "${this.providerName}"`;
    if (!this.to.length) return "📧 Email alerts: OFF — ALERT_EMAIL_TO is empty";
    if (!this.from) return "📧 Email alerts: OFF — ALERT_EMAIL_FROM is empty";
    if (!this.key) return "📧 Email alerts: OFF — ALERT_API_KEY is empty";
    const classes = this.events ? [...this.events].join(", ") : "all";
    return `📧 Email alerts: ON via ${this.providerName} → ${this.to.join(", ")} (events: ${classes})`;
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

      const body = this._composeBody({ eventClass, detail, suppressedCount, since: last });
      this._deliver(`[${this.deviceName}] ${subject}`, body, 0);
    } catch (e) {
      console.warn("📧 Alert failed to queue:", e.message);
    }
  }

  _composeBody({ eventClass, detail, suppressedCount, since }) {
    const lines = [];
    if (detail) lines.push(detail, "");
    if (suppressedCount > 0) {
      lines.push(`(${suppressedCount} more like this were suppressed since ` +
                 `${new Date(since).toLocaleString()})`, "");
    }
    lines.push(`Device:  ${this.deviceName}`);
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
    const payload = JSON.stringify(
      this.provider.body({ from: this.from, to: this.to, subject, text })
    );
    const req = https.request(
      {
        host: this.provider.host,
        path: this.provider.path,
        method: "POST",
        timeout: 15000,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          ...this.provider.headers(this.key),
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
