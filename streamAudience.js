"use strict";

/**
 * streamAudience.js — is anybody actually receiving this camera's stream?
 *
 * Why this exists
 * ---------------
 * An Ad Center impression is billing data, so it has to mean "somebody could
 * have seen this ad". `isStreaming` was the first approximation and it is not
 * enough: a venue box publishes to MediaMTX for as long as the service is up,
 * whether or not anything is pulling. Checked on 2026-10-26, all three Ariakon
 * boxes had a reader on `live` and **none on `live2`** — their second camera
 * had been encoding to nobody, and under an isStreaming-only gate every one of
 * those hours would have billed the venue's advertisers.
 *
 * What counts as an audience
 * --------------------------
 * A MediaMTX session in `read` state on that camera's path, over any protocol
 * (RTSP, SRT, RTMP, WebRTC), from an address that is not this box and not the
 * operator's tablet:
 *
 *   - loopback is excluded because recordingManager's own ffmpeg reads the
 *     stream over 127.0.0.1; counting it would mean a recording bills ads
 *   - the AP hotspot is excluded because that is the tablet running the match
 *     watching its own preview, not an audience
 *
 * Everything else counts, which is deliberately *more* permissive than
 * recordingManager's `ignoredNetworks` (which drops 192.168/16 to keep a LAN
 * client from arming a 2.25 GB/hour write). The two are answering different
 * questions: a venue's own machine pulling the stream off the box is not worth
 * a recording, but it is certainly a consumer — at Ariakon the thing pulling
 * `live` is on the venue LAN, and dropping it would zero a venue that really is
 * being watched.
 *
 * What cannot be seen
 * -------------------
 * Only the `rtsp` protocol serves its audience through MediaMTX. A push output
 * (YouTube, Facebook, a custom RTMP target) connects outward, so the platform
 * is the consumer and the push itself is the delivery; and `srt` is served by
 * the pipeline's own srtsink in listener mode (srt://:8891), which MediaMTX
 * never sees. For both, this reports an audience while the stream is up.
 *
 * That is on purpose. Guessing "nobody" from an absence of evidence would
 * silently zero a venue that really is being watched, which is the worse of the
 * two errors: an over-count is visible in a report, an under-count looks like
 * the ads never ran. Closing the SRT half means having the pipeline publish
 * srtsink's `stats.callers`, which nothing reports today.
 *
 * Failure and flapping
 * --------------------
 * A reader that drops is believed only after `graceMs`: Wowza reconnected in
 * 19 s during the 2026-09-14 incident, and an impression window is a minute, so
 * a blip must not toggle counting. A failed poll changes nothing at all — an
 * unreachable MediaMTX API is not evidence that an audience went away, and the
 * same one-sided rule governs the subscription check.
 */

const DEFAULTS = {
  pollMs: 10000,
  // Longer than the worst reconnect seen in the field (19 s) and comfortably
  // inside one impression throttle window (60 s).
  graceMs: 45000,
};

// Every MediaMTX connection type that can read a path. All four share the
// same { path, state, remoteAddr } shape, so one pass handles them.
const READER_LISTS = [
  "/v3/rtspsessions/list",
  "/v3/srtconns/list",
  "/v3/rtmpconns/list",
  "/v3/webrtcsessions/list",
];

// The only protocol whose audience is visible here. Everything else is either
// pushed outward or served by the pipeline itself — see "What cannot be seen".
const OBSERVABLE_PROTOCOLS = new Set(["rtsp"]);

function audienceIsObservable(protocol) {
  return OBSERVABLE_PROTOCOLS.has(String(protocol || "").toLowerCase());
}

/** The bare IPv4/IPv6 address out of MediaMTX's "ip:port" remoteAddr. */
function extractIp(remoteAddr) {
  if (!remoteAddr) return "";
  const s = String(remoteAddr);
  const lastColon = s.lastIndexOf(":");
  const ip = lastColon === -1 ? s : s.slice(0, lastColon);
  return ip.replace(/^\[|\]$/g, "");
}

/** Is this reader somebody other than this box and the operator's tablet? */
function isAudienceIp(ip, hotspotPrefix) {
  if (!ip) return false;
  const bare = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  if (bare === "::1" || bare.startsWith("127.")) return false;
  if (hotspotPrefix && bare.startsWith(hotspotPrefix)) return false;
  return true;
}

class StreamAudience {
  /**
   * @param {object} opts
   * @param {(apiPath: string) => Promise<object>} opts.get  MediaMTX API GET
   * @param {() => Array<{index:number, path:string, protocol:string, streaming:boolean}>} opts.cameras
   * @param {(index:number) => void} [opts.onChange] called when a camera gains
   *        or loses its audience, so the caller can re-sync whatever it gates
   */
  constructor({ get, cameras, onChange = null, pollMs, graceMs, hotspotSubnet } = {}) {
    this.get = get;
    this.cameras = cameras;
    this.onChange = onChange;
    this.pollMs = pollMs || DEFAULTS.pollMs;
    this.graceMs = graceMs === undefined ? DEFAULTS.graceMs : graceMs;
    this.hotspotSubnet = hotspotSubnet || process.env.HOTSPOT_SUBNET || "192.168.50.";
    // index -> { has, lastSeen, readers, pushing, at }
    this.state = new Map();
    this._timer = null;
    this._polling = false;
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => { this.poll().catch(() => {}); }, this.pollMs);
    // Never the reason the process stays up through a shutdown.
    if (this._timer.unref) this._timer.unref();
    this.poll().catch(() => {});
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  /** Does camera `index` have an audience right now? */
  has(index) {
    const s = this.state.get(index);
    return !!(s && s.has);
  }

  /** What `has()` is based on, for /api/overlay/engine and support questions. */
  stats() {
    const out = {};
    for (const [index, s] of this.state) {
      out[index] = {
        audience: s.has,
        readers: s.readers,
        // false means "this protocol's audience cannot be seen from here", and
        // `audience` is then an assumption, not a measurement.
        observable: s.observable,
        protocol: s.protocol || null,
        lastSeenAgoMs: s.lastSeen ? Date.now() - s.lastSeen : null,
        checkedAgoMs: s.at ? Date.now() - s.at : null,
      };
    }
    return out;
  }

  async poll() {
    if (this._polling) return;
    const cameras = (this.cameras ? this.cameras() : []) || [];
    // A camera that is not streaming has no audience by definition, and with
    // nothing streaming there is no reason to wake MediaMTX at all.
    const live = cameras.filter((c) => c && c.streaming);
    for (const cam of cameras) {
      if (cam && !cam.streaming) {
        this._set(cam.index, { has: false, readers: 0, observable: audienceIsObservable(cam.protocol), protocol: cam.protocol, at: Date.now() });
      }
    }
    if (!live.length) return;

    this._polling = true;
    try {
      const byPath = await this._readersByPath();
      // A failed poll leaves every camera exactly as it was.
      if (!byPath) return;
      const now = Date.now();
      for (const cam of live) {
        const observable = audienceIsObservable(cam.protocol);
        const readers = byPath.get(cam.path) || 0;
        const seen = observable ? readers > 0 : true;
        const prev = this.state.get(cam.index);
        const lastSeen = seen ? now : (prev && prev.lastSeen) || 0;
        // Hold the last audience through a blip, but only if there ever was one.
        const has = seen || (lastSeen > 0 && now - lastSeen < this.graceMs);
        this._set(cam.index, { has, readers, observable, protocol: cam.protocol, lastSeen, at: now });
      }
    } finally {
      this._polling = false;
    }
  }

  _set(index, next) {
    const prev = this.state.get(index);
    this.state.set(index, { lastSeen: (prev && prev.lastSeen) || 0, ...next });
    if (this.onChange && (!prev || prev.has !== next.has)) this.onChange(index);
  }

  /**
   * Reading sessions per MediaMTX path, or null when MediaMTX could not be
   * asked. A protocol that is disabled in mediamtx.yml answers with an error;
   * that is not a failure, so only *every* list failing counts as one.
   */
  async _readersByPath() {
    const results = await Promise.allSettled(READER_LISTS.map((p) => this.get(p)));
    if (results.every((r) => r.status === "rejected")) return null;
    const byPath = new Map();
    for (const r of results) {
      if (r.status !== "fulfilled") continue;
      for (const s of (r.value && r.value.items) || []) {
        if (s.state !== "read") continue;
        if (!isAudienceIp(extractIp(s.remoteAddr), this.hotspotSubnet)) continue;
        byPath.set(s.path, (byPath.get(s.path) || 0) + 1);
      }
    }
    return byPath;
  }
}

module.exports = { StreamAudience, extractIp, isAudienceIp, audienceIsObservable };
