"use strict";

/**
 * recordingManager.js — reader-gated local recording of the live stream(s).
 *
 * Why this exists
 * ---------------
 * Delivery is Wowza pulling RTSP from this box across the internet. On
 * 2026-09-14 that pull stalled mid-match: MediaMTX's write queue to Wowza
 * filled (`reader is too slow, discarding ~500 frames` a second, the full
 * 512-deep default queue), the 10 s writeTimeout expired, and the session was
 * destroyed with `write tcp …: i/o timeout`. Wowza reconnected 19 s later and
 * rolled to a new recording file, so a 1h23m match survived only as its last
 * 13m39s. The encoder never faltered — drift checks stayed at 0 ppm throughout.
 *
 * Nothing on this box can stop a venue uplink from degrading, so the fix is to
 * keep a copy locally that no WAN event can touch.
 *
 * How it decides to record
 * ------------------------
 * MediaMTX's own `record:` is publisher-gated, and the publisher here runs
 * 24/7 (the path had been up four days when the incident happened), so it
 * would record continuously — ~2.25 GB/hour, forever. Instead we watch the
 * MediaMTX API for *readers* and record only while a real consumer is pulling.
 *
 * A reader arms recording when it is an RTSP session in `read` state on a
 * watched path, from a non-local address. That deliberately excludes:
 *   - the WebRTC/WHEP admin preview (not RTSP), so opening the UI is free
 *   - this module's own ffmpeg, which reads from 127.0.0.1 — without the
 *     locality test it would arm itself and never stop
 *   - hotspot clients on the tablet used to run the match
 *
 * The grace window is the part that actually addresses the incident: when the
 * last qualifying reader disappears we keep writing for `graceSeconds`. Wowza's
 * 19-second reconnect therefore lands inside one continuous local file instead
 * of splitting it the way Wowza's own recording split.
 *
 * Crash tolerance
 * ---------------
 * Output is fragmented MP4 (`+frag_keyframe+empty_moov+default_base_moof`), so
 * a file left behind by an OOM kill, a power cut, or a SIGKILL at the end of
 * the service's 7 s shutdown budget is still playable up to its last fragment.
 * A plain MP4 truncated the same way is a total loss — it never gets its moov
 * atom. Given the MemoryMax=2500M cap on this service, that is not a
 * theoretical concern.
 */

const EventEmitter = require("events");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn, exec } = require("child_process");
const { promisify } = require("util");

const execAsync = promisify(exec);

// Kept off the repo directory on purpose: DEPLOY_GRAPHICS.md syncs the repo
// with rsync, and multi-GB match footage in the sync path would be copied,
// deleted, or both. migrations/0011 creates this owned by `dp`.
const RECORDINGS_DIR = process.env.RECORDINGS_DIR || "/var/lib/digitalpool-camera/recordings";
const CONFIG_FILE    = path.join(__dirname, "recording-config.json");

const POLL_MS  = 3000;            // reader poll — also the restart/space check
const SWEEP_MS = 10 * 60 * 1000;  // retention sweep
const GiB      = 1024 ** 3;

// Sized for the standard build: a 231 GB root volume with ~208 GB free after
// the OS. One 5 Mbps stream plus AAC is ~2.15 GiB/hour, so 120 GiB is roughly
// 56 hours of a single camera — or 28 hours when both cameras have a remote
// reader, which is the case worth planning for.
//
// The remaining ~88 GiB of headroom is not slack: /home/dp/system-images holds
// multi-GB capture tarballs and recovery ISOs, and /api/system/image/create
// already refuses to run below 4 GB free. Recordings must not be what pushes it
// there, hence a floor well above that check.
//
// retentionDays is the looser of the two limits on a busy venue — the size cap
// will normally bind first, which is the safer failure mode.
const DEFAULT_CONFIG = {
  enabled:       false,  // opt-in; the UI switch owns this
  graceSeconds:  90,     // > the 19 s Wowza took to reconnect on 2026-09-14
  retentionDays: 14,
  maxTotalGB:    120,
  minFreeGB:     20,
};

// Path traversal guard for the download/delete endpoints. Only names this
// module generates are addressable.
const RECORDING_NAME_RE = /^dp-rec-cam[0-9]+-\d{8}-\d{6}\.mp4$/;
function safeRecordingName(name) {
  return typeof name === "string" && !name.includes("..") && RECORDING_NAME_RE.test(name);
}

// YYYYMMDD-HHMMSS in the device's configured timezone, matching localStamp() in
// server.js but with seconds — two recordings can legitimately start in the
// same minute when a reader flaps just outside the grace window.
function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
         `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

class RecordingManager extends EventEmitter {
  /**
   * @param {Array<{path:string,label:string,streamId:number}>} paths
   *        MediaMTX paths to watch. Camera 1 publishes to `live`, camera 2 to
   *        `live2` (streamController.js:67).
   */
  constructor(paths) {
    super();
    this.paths  = paths;
    this.config = { ...DEFAULT_CONFIG };
    this.dirOk  = false;

    // Per-path recording state, keyed by MediaMTX path name.
    this.state = new Map();
    for (const p of paths) {
      this.state.set(p.path, {
        ...p,
        proc: null, name: null, file: null, startedAt: null,
        readerIp: null, graceUntil: null, stopping: false, lastError: null,
        exited: null,      // set by ffmpeg's close handler; see _poll
        failCount: 0,      // consecutive too-short recordings
        retryAfter: 0,     // backoff deadline for a crash-looping ffmpeg
      });
    }

    this._pollTimer  = null;
    this._sweepTimer = null;
    this._polling    = false;   // re-entrancy guard; a stop can take 5 s
    this._freeGB     = null;    // cached — `df` every 3 s is not free on an N97
    this._freeGBAt   = 0;
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  async start() {
    this.loadConfig();
    this.dirOk = this._ensureDir();
    await this._reconcileOnBoot();

    this._pollTimer  = setInterval(() => this._poll().catch(() => {}), POLL_MS);
    this._sweepTimer = setInterval(() => this.sweep().catch(() => {}), SWEEP_MS);
    this.sweep().catch(() => {});

    console.log(
      `🎥 Recording manager started — ${this.config.enabled ? "ENABLED" : "disabled"}, ` +
      `dir=${RECORDINGS_DIR}, grace=${this.config.graceSeconds}s, ` +
      `retention=${this.config.retentionDays}d/${this.config.maxTotalGB}GB, floor=${this.config.minFreeGB}GB`
    );
  }

  /**
   * Stop every recorder and wait for ffmpeg to finalize. Called from the
   * shutdown handler, which has a hard 7 s budget for all child processes —
   * hence the short cap here. Fragmented MP4 means blowing the budget costs at
   * most the final fragment, not the file.
   */
  async shutdown() {
    if (this._pollTimer)  clearInterval(this._pollTimer);
    if (this._sweepTimer) clearInterval(this._sweepTimer);
    this._pollTimer = this._sweepTimer = null;

    await Promise.all(
      [...this.state.values()]
        .filter((s) => s.proc)
        .map((s) => this._stopRecording(s, "shutdown", 2500))
    );
  }

  // ── config ───────────────────────────────────────────────────────────────

  loadConfig() {
    try {
      if (fs.existsSync(CONFIG_FILE)) {
        const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
        this.config = { ...DEFAULT_CONFIG, ...saved };
        console.log("✅ Loaded recording config from file:", CONFIG_FILE);
      }
    } catch (err) {
      console.error("⚠️  Failed to load recording config, using defaults:", err.message);
      this.config = { ...DEFAULT_CONFIG };
    }
    return this.config;
  }

  /**
   * Merge and persist. Values are clamped rather than rejected so a bad field
   * from the UI can never leave recording in a state that fills the disk.
   */
  saveConfig(patch = {}) {
    const n = (v, min, max, fallback) => {
      const x = Number(v);
      return Number.isFinite(x) ? Math.min(max, Math.max(min, x)) : fallback;
    };
    const next = { ...this.config };

    if ("enabled"       in patch) next.enabled       = !!patch.enabled;
    if ("graceSeconds"  in patch) next.graceSeconds  = n(patch.graceSeconds,  0,  3600, next.graceSeconds);
    if ("retentionDays" in patch) next.retentionDays = n(patch.retentionDays, 1,   365, next.retentionDays);
    if ("maxTotalGB"    in patch) next.maxTotalGB    = n(patch.maxTotalGB,    1, 10000, next.maxTotalGB);
    if ("minFreeGB"     in patch) next.minFreeGB     = n(patch.minFreeGB,     1,  1000, next.minFreeGB);

    const wasEnabled = this.config.enabled;
    this.config = next;

    try {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2));
      console.log("✅ Saved recording config to file:", CONFIG_FILE);
    } catch (err) {
      console.error("❌ Failed to save recording config:", err.message);
    }

    // Turning the feature off stops anything in flight immediately — an
    // operator flipping the switch expects the writing to stop now, not at the
    // end of the grace window.
    if (wasEnabled && !next.enabled) {
      for (const s of this.state.values()) {
        if (s.proc) this._stopRecording(s, "disabled").catch(() => {});
      }
    }
    this._emitState();
    return next;
  }

  // ── reader detection ─────────────────────────────────────────────────────

  _mediamtxGet(apiPath) {
    return new Promise((resolve, reject) => {
      const req = http.get(
        { hostname: "127.0.0.1", port: 9997, path: apiPath, timeout: 2000 },
        (res) => {
          let body = "";
          res.on("data", (d) => { body += d; });
          res.on("end", () => {
            try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
          });
        }
      );
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(); reject(new Error("MediaMTX timeout")); });
    });
  }

  _extractIp(remoteAddr) {
    if (!remoteAddr) return null;
    const ipv6 = remoteAddr.match(/^\[(.+)\]:\d+$/);
    if (ipv6) return ipv6[1];
    const colon = remoteAddr.lastIndexOf(":");
    return colon >= 0 ? remoteAddr.slice(0, colon) : remoteAddr;
  }

  /**
   * A reader counts only if it is genuinely off-box.
   *
   * Loopback is excluded because our own ffmpeg reads from 127.0.0.1 — include
   * it and the first recording would arm the next one forever. The hotspot
   * subnet is excluded because that is the tablet running the match, whose
   * preview must not cost 2.25 GB/hour.
   *
   * RFC1918 is deliberately NOT excluded: Wowza reaches us over the VPN and
   * presents as 172.16.0.71, indistinguishable from a LAN address from here.
   */
  _isRemoteIp(ip) {
    if (!ip) return false;
    const bare = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
    if (bare === "::1" || bare.startsWith("127.")) return false;
    const hotspot = process.env.HOTSPOT_SUBNET || "192.168.50.";
    if (bare.startsWith(hotspot)) return false;
    return true;
  }

  /**
   * Map of watched path -> IP of a qualifying reader (RTSP, reading, remote).
   * Only RTSP is queried: Wowza pulls RTSP, and the admin preview is WebRTC.
   */
  async _qualifyingReaders() {
    const out = new Map();
    const data = await this._mediamtxGet("/v3/rtspsessions/list");
    for (const s of data.items || []) {
      if (s.state !== "read") continue;
      if (!this.state.has(s.path)) continue;
      const ip = this._extractIp(s.remoteAddr);
      if (!this._isRemoteIp(ip)) continue;
      if (!out.has(s.path)) out.set(s.path, ip);
    }
    return out;
  }

  // ── the poll loop ────────────────────────────────────────────────────────

  async _poll() {
    if (!this.config.enabled) return;

    // A stop waits up to 5 s for ffmpeg to finalize, which is longer than the
    // 3 s tick. Without this guard a slow stop lets the next tick observe
    // `!s.proc` and start a second recorder for the same path.
    if (this._polling) return;
    this._polling = true;
    try {
      await this._pollOnce();
    } finally {
      this._polling = false;
    }
  }

  async _pollOnce() {
    let readers;
    try {
      readers = await this._qualifyingReaders();
    } catch {
      // MediaMTX down or restarting. Leave recorders alone — ffmpeg will exit
      // on its own if the source really went away, and the next tick restarts
      // it. Tearing down on a single failed poll would chop files needlessly.
      return;
    }

    // A recording that outlives the free-space floor takes the whole box down
    // with it, so this check outranks everything else.
    const freeGB = await this._freeGBCached();
    const now = Date.now();
    let changed = false;

    for (const s of this.state.values()) {
      const readerIp = readers.get(s.path) || null;

      // ffmpeg died on its own (publisher restart, decode error, OOM). Checked
      // via the close handler rather than `proc.exitCode`, because a process
      // killed by a signal leaves exitCode null forever — the path would then
      // look permanently "recording" and never restart.
      if (s.proc && s.exited) {
        this._finalize(s, `ffmpeg exited (${s.exited.signal || `code ${s.exited.code}`})`);
        changed = true;
      }

      if (s.proc && freeGB !== null && freeGB < this.config.minFreeGB) {
        console.error(
          `🎥 [${s.label}] Stopping recording — free space ${freeGB.toFixed(1)} GB ` +
          `below floor ${this.config.minFreeGB} GB`
        );
        await this._stopRecording(s, "low disk space");
        changed = true;
        continue;
      }

      if (readerIp && !s.proc && !s.stopping) {
        // ffmpeg that dies immediately (bad path, missing codec) would
        // otherwise be respawned every 3 s, littering the store with junk
        // fragments and hammering the CPU. Back off instead.
        if (now < s.retryAfter) continue;

        if (freeGB !== null && freeGB < this.config.minFreeGB) {
          if (s.lastError !== "low-space") {
            s.lastError = "low-space";
            console.error(
              `🎥 [${s.label}] Reader ${readerIp} connected but free space ` +
              `${freeGB.toFixed(1)} GB is below the ${this.config.minFreeGB} GB floor — not recording`
            );
            changed = true;
          }
          continue;
        }
        s.lastError = null;
        await this._startRecording(s, readerIp);
        changed = true;
        continue;
      }

      if (readerIp && s.proc && s.graceUntil) {
        // Reader came back inside the grace window — this is the 2026-09-14
        // case. Keep the same file; the gap stays inside one recording.
        console.log(`🎥 [${s.label}] Reader ${readerIp} returned within grace — recording continues`);
        s.graceUntil = null;
        s.readerIp = readerIp;
        changed = true;
        continue;
      }

      if (!readerIp && s.proc && !s.stopping) {
        if (!s.graceUntil) {
          s.graceUntil = now + this.config.graceSeconds * 1000;
          console.log(
            `🎥 [${s.label}] Reader gone — holding recording for ${this.config.graceSeconds}s ` +
            `in case it reconnects`
          );
          changed = true;
        } else if (now >= s.graceUntil) {
          await this._stopRecording(s, "reader disconnected");
          changed = true;
        }
      }
    }

    if (changed) this._emitState();
  }

  // ── start / stop ─────────────────────────────────────────────────────────

  async _startRecording(s, readerIp) {
    if (!this.dirOk && !(this.dirOk = this._ensureDir())) {
      if (s.lastError !== "no-dir") {
        s.lastError = "no-dir";
        console.error(`🎥 [${s.label}] Cannot record — ${RECORDINGS_DIR} is not writable`);
      }
      return;
    }

    const name = `dp-rec-${s.label}-${stamp()}.mp4`;
    const file = path.join(RECORDINGS_DIR, name);

    // -c copy: remux only, no decode/encode. The N97 is already carrying two
    // encoders plus overlay compositing, so a recorder that costs real CPU
    // would trade one failure mode for another.
    const args = [
      "-hide_banner", "-nostdin", "-loglevel", "warning",
      "-rtsp_transport", "tcp",
      "-i", `rtsp://127.0.0.1:8554/${s.path}`,
      "-c", "copy",
      "-f", "mp4",
      "-movflags", "+frag_keyframe+empty_moov+default_base_moof",
      "-y", file,
    ];

    let proc;
    try {
      proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    } catch (err) {
      s.lastError = err.message;
      console.error(`🎥 [${s.label}] Failed to spawn ffmpeg: ${err.message}`);
      return;
    }

    s.proc = proc;
    s.name = name;
    s.file = file;
    s.startedAt = Date.now();
    s.readerIp = readerIp;
    s.graceUntil = null;
    s.stopping = false;
    s.lastError = null;
    s.exited = null;

    proc.stderr.on("data", (d) => {
      const msg = String(d).trim();
      if (msg) console.error(`[rec ${s.label}] ${msg}`);
    });
    proc.on("error", (err) => {
      s.lastError = err.message;
      console.error(`🎥 [${s.label}] ffmpeg error: ${err.message}`);
    });
    // `close` covers both a normal exit and death by signal; the poll loop
    // reads this rather than proc.exitCode, which stays null when signalled.
    proc.on("close", (code, signal) => {
      if (s.proc === proc) s.exited = { code, signal };
    });

    this._writeSidecar(s, null);
    console.log(`🎥 [${s.label}] Recording started → ${name} (reader ${readerIp})`);
    this.emit("started", { label: s.label, name, startedAt: s.startedAt, readerIp });
  }

  /**
   * SIGINT, not SIGTERM: ffmpeg treats SIGINT as "wrap up now" and flushes its
   * last fragment before exiting. SIGKILL after `waitMs` guarantees we never
   * hang the shutdown path.
   */
  async _stopRecording(s, reason, waitMs = 5000) {
    const proc = s.proc;
    if (!proc) return;
    s.stopping = true;
    console.log(`🎥 [${s.label}] Stopping recording (${reason}) → ${s.name}`);

    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; clearTimeout(timer); resolve(); } };
      const timer = setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch { /* already gone */ }
        finish();
      }, waitMs);
      proc.once("close", finish);
      try { proc.kill("SIGINT"); } catch { finish(); }
    });

    this._finalize(s, reason);
    this.sweep().catch(() => {});
  }

  /** Close out in-memory state and stamp the sidecar. Safe to call twice. */
  _finalize(s, reason) {
    if (!s.name) { s.proc = null; s.stopping = false; return; }
    const name = s.name;
    const startedAt = s.startedAt;
    const endedAt = Date.now();

    this._writeSidecar(s, endedAt);
    const bytes = this._size(s.file);
    const durationSec = Math.round((endedAt - startedAt) / 1000);

    // An ffmpeg that failed to connect leaves a 0-byte (or header-only) file.
    // Keeping those would bury real footage in the list and make the "no
    // recordings" case indistinguishable from "recording is broken".
    const stillborn = bytes < 65536;
    if (stillborn) {
      try { this._unlinkPair(name); } catch { /* already gone */ }
      s.failCount += 1;
      // 6 s, 12 s, 24 s, 48 s, then a flat minute.
      const backoffSec = Math.min(60, 3 * 2 ** s.failCount);
      s.retryAfter = Date.now() + backoffSec * 1000;
      console.error(
        `🎥 [${s.label}] Recording produced nothing (${reason}) — discarded ${name}, ` +
        `retrying in ${backoffSec}s (failure ${s.failCount})`
      );
    } else {
      s.failCount = 0;
      s.retryAfter = 0;
      console.log(
        `🎥 [${s.label}] Recording finished → ${name} ` +
        `(${durationSec}s, ${(bytes / GiB).toFixed(2)} GB, ${reason})`
      );
    }

    s.proc = null; s.name = null; s.file = null; s.exited = null;
    s.startedAt = null; s.readerIp = null; s.graceUntil = null; s.stopping = false;

    if (!stillborn) {
      this.emit("stopped", { label: s.label, name, startedAt, endedAt, bytes, reason });
    }
  }

  // ── sidecar metadata ─────────────────────────────────────────────────────
  //
  // Duration and camera can't be recovered from the file alone: ext4 birthtime
  // is not reliably exposed, and probing every file with ffprobe to render a
  // list would be absurd. A sidecar written at start and stamped at stop is
  // cheap and survives a crash (endedAt stays null and boot reconciles it).

  _sidecarPath(file) { return file.replace(/\.mp4$/, ".json"); }

  _writeSidecar(s, endedAt) {
    if (!s.file) return;
    try {
      fs.writeFileSync(this._sidecarPath(s.file), JSON.stringify({
        name: s.name, label: s.label, streamId: s.streamId, path: s.path,
        startedAt: s.startedAt, endedAt, readerIp: s.readerIp,
      }, null, 2));
    } catch (err) {
      console.error(`⚠️  Failed to write recording metadata for ${s.name}: ${err.message}`);
    }
  }

  _readSidecar(file) {
    try { return JSON.parse(fs.readFileSync(this._sidecarPath(file), "utf8")); }
    catch { return null; }
  }

  /**
   * A recording interrupted by a crash or an OOM kill leaves `endedAt: null`
   * forever, which would render as a permanently "recording" row in the UI.
   * Nothing is actually writing at boot, so stamp those closed from the file's
   * mtime — the last moment ffmpeg wrote a fragment.
   */
  async _reconcileOnBoot() {
    if (!this.dirOk) return;
    let files;
    try { files = fs.readdirSync(RECORDINGS_DIR); } catch { return; }
    for (const f of files) {
      if (!safeRecordingName(f)) continue;
      const full = path.join(RECORDINGS_DIR, f);
      const meta = this._readSidecar(full);
      if (!meta || meta.endedAt) continue;
      try {
        meta.endedAt = fs.statSync(full).mtimeMs;
        meta.interrupted = true;
        fs.writeFileSync(this._sidecarPath(full), JSON.stringify(meta, null, 2));
        console.log(`🎥 Recovered interrupted recording ${f} (closed at file mtime)`);
      } catch { /* leave it; listing falls back to mtime anyway */ }
    }
  }

  // ── listing ──────────────────────────────────────────────────────────────

  _size(p) { try { return fs.statSync(p).size; } catch { return 0; } }

  _ensureDir() {
    try { fs.mkdirSync(RECORDINGS_DIR, { recursive: true }); fs.accessSync(RECORDINGS_DIR, fs.constants.W_OK); return true; }
    catch (err) { console.error(`⚠️  Recordings directory unusable (${RECORDINGS_DIR}): ${err.message}`); return false; }
  }

  /**
   * Free space on the recordings volume, cached for `maxAgeMs`.
   *
   * The poll loop runs every 3 s; shelling out to `df` that often would be
   * ~29k subprocesses a day on a box whose CPU headroom is already the binding
   * constraint for dual-stream encoding. Disk fills slowly enough that a
   * 30-second-old answer is as good as a fresh one.
   */
  async _freeGBCached(maxAgeMs = 30000) {
    if (this._freeGB !== null && Date.now() - this._freeGBAt < maxAgeMs) return this._freeGB;
    const v = await this._freeGBNow();
    this._freeGB = v;
    this._freeGBAt = Date.now();
    return v;
  }

  async _freeGBNow() {
    try {
      const { stdout } = await execAsync(`df -B1 --output=avail ${JSON.stringify(RECORDINGS_DIR)} | tail -n1`);
      const bytes = parseInt(stdout.trim(), 10);
      return Number.isFinite(bytes) ? bytes / GiB : null;
    } catch { return null; }
  }

  list() {
    const active = new Map();
    for (const s of this.state.values()) if (s.name) active.set(s.name, s);

    let files = [];
    try { files = fs.readdirSync(RECORDINGS_DIR).filter(safeRecordingName); } catch { /* dir missing */ }

    // ffmpeg creates its output a moment after spawn, so a just-started
    // recording is briefly absent from the directory listing. Include it from
    // in-memory state instead: a row that appears at 0 bytes and grows reads
    // correctly, whereas one that pops into existence a beat later looks like
    // the UI missed it.
    for (const name of active.keys()) if (!files.includes(name)) files.push(name);

    return files.map((name) => {
      const full = path.join(RECORDINGS_DIR, name);
      const meta = this._readSidecar(full) || {};
      const st   = (() => { try { return fs.statSync(full); } catch { return null; } })();
      const live = active.get(name);
      const startedAt = meta.startedAt ?? (st ? st.mtimeMs : null);
      const endedAt   = live ? null : (meta.endedAt ?? (st ? st.mtimeMs : null));
      return {
        name,
        label:      meta.label   ?? "unknown",
        streamId:   meta.streamId ?? null,
        bytes:      st ? st.size : 0,
        startedAt,
        endedAt,
        durationSec: startedAt ? Math.round(((endedAt ?? Date.now()) - startedAt) / 1000) : null,
        readerIp:   meta.readerIp ?? null,
        recording:  !!live,
        interrupted: !!meta.interrupted,
      };
    }).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  }

  async status() {
    const items = this.list();
    const totalBytes = items.reduce((n, r) => n + r.bytes, 0);
    return {
      config: this.config,
      dir: RECORDINGS_DIR,
      dirOk: this.dirOk,
      freeGB: await this._freeGBCached(5000),
      totalBytes,
      recordings: items,
      active: [...this.state.values()]
        .filter((s) => s.proc)
        .map((s) => ({
          label: s.label, name: s.name, startedAt: s.startedAt, readerIp: s.readerIp,
          bytes: this._size(s.file),
          graceRemainingSec: s.graceUntil ? Math.max(0, Math.round((s.graceUntil - Date.now()) / 1000)) : null,
        })),
    };
  }

  _emitState() {
    this.status().then((st) => this.emit("state", st)).catch(() => {});
  }

  // ── deletion & retention ─────────────────────────────────────────────────

  /** Refuses to delete a file that is currently being written. */
  remove(name) {
    if (!safeRecordingName(name)) throw new Error("bad recording name");
    for (const s of this.state.values()) {
      if (s.name === name) throw new Error("recording is still in progress");
    }
    const full = path.join(RECORDINGS_DIR, name);
    fs.unlinkSync(full);
    try { fs.unlinkSync(this._sidecarPath(full)); } catch { /* sidecar may be absent */ }
    console.log(`🎥 Deleted recording ${name}`);
    this._emitState();
    return true;
  }

  /**
   * Age first, then size. Files being written now are never candidates — the
   * size pass could otherwise delete the match currently in progress, which is
   * exactly the footage this module exists to protect.
   */
  async sweep() {
    if (!this.dirOk) return { deleted: [] };
    const activeNames = new Set([...this.state.values()].map((s) => s.name).filter(Boolean));
    const deleted = [];

    const candidates = this.list().filter((r) => !activeNames.has(r.name) && !r.recording);

    const cutoff = Date.now() - this.config.retentionDays * 86400 * 1000;
    const survivors = [];
    for (const r of candidates) {
      if ((r.endedAt ?? r.startedAt ?? 0) < cutoff) {
        try { this._unlinkPair(r.name); deleted.push({ name: r.name, reason: "age" }); }
        catch (err) { console.error(`⚠️  Retention: could not delete ${r.name}: ${err.message}`); survivors.push(r); }
      } else survivors.push(r);
    }

    // Oldest-first until under the cap.
    const cap = this.config.maxTotalGB * GiB;
    let total = survivors.reduce((n, r) => n + r.bytes, 0);
    const oldestFirst = [...survivors].sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
    for (const r of oldestFirst) {
      if (total <= cap) break;
      try { this._unlinkPair(r.name); total -= r.bytes; deleted.push({ name: r.name, reason: "size cap" }); }
      catch (err) { console.error(`⚠️  Retention: could not delete ${r.name}: ${err.message}`); }
    }

    if (deleted.length) {
      console.log(`🎥 Retention removed ${deleted.length} recording(s): ` +
        deleted.map((d) => `${d.name} (${d.reason})`).join(", "));
      this._emitState();
    }
    return { deleted };
  }

  _unlinkPair(name) {
    const full = path.join(RECORDINGS_DIR, name);
    fs.unlinkSync(full);
    try { fs.unlinkSync(this._sidecarPath(full)); } catch { /* sidecar may be absent */ }
  }

  pathFor(name) {
    if (!safeRecordingName(name)) throw new Error("bad recording name");
    return path.join(RECORDINGS_DIR, name);
  }

  isRecording(name) {
    for (const s of this.state.values()) if (s.name === name) return true;
    return false;
  }
}

module.exports = { RecordingManager, safeRecordingName, RECORDINGS_DIR };
