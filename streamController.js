const { spawn } = require("child_process");
const EventEmitter = require("events");
const fs = require("fs");
const path = require("path");

// ── MPEG-TS PTS extractor ────────────────────────────────────────────────────
// Scans a raw MPEG-TS buffer and returns the first PTS value found in any PES
// packet, converted from 90 kHz ticks to seconds. Returns null if no PTS is
// found (e.g. the chunk contains only PAT/PMT/adaptation-only packets).
//
// Used at FFmpeg spawn time to compute the -itsoffset needed to align
// GStreamer's pipeline-clock timestamps with the audio's wall-clock timestamps.
function extractMpegtsPts(buf) {
  for (let i = 0; i + 188 <= buf.length; i += 188) {
    if (buf[i] !== 0x47) continue;                    // MPEG-TS sync byte

    const payloadStart = (buf[i + 1] >> 6) & 1;       // payload_unit_start_indicator
    if (!payloadStart) continue;

    const adaptCtrl = (buf[i + 3] >> 4) & 0x3;
    if ((adaptCtrl & 1) === 0) continue;               // no payload in this packet

    // Skip adaptation field if present (adaptation_field_length at byte [i+4])
    let pOff = i + 4;
    if (adaptCtrl & 2) pOff += 1 + buf[i + 4];

    // Verify PES start code: 0x000001
    if (buf[pOff] !== 0x00 || buf[pOff + 1] !== 0x00 || buf[pOff + 2] !== 0x01) continue;

    // PTS_DTS_flags are in byte 7 of the PES header (bits 7-6)
    if (pOff + 13 >= buf.length) continue;
    const ptsDtsFlags = (buf[pOff + 7] >> 6) & 0x3;
    if (ptsDtsFlags < 2) continue;                     // no PTS field

    // PTS is encoded across bytes [pOff+9 … pOff+13] in 5-byte MPEG-TS notation
    const p = pOff + 9;
    const pts =
      ((buf[p]     & 0x0E) >>> 1) * 0x40000000 +      // PTS[32:30] × 2³⁰
       (buf[p + 1]        ) * 0x400000    +            // PTS[29:22] × 2²²
      ((buf[p + 2] & 0xFE) >>> 1) * 0x8000   +        // PTS[21:15] × 2¹⁵
       (buf[p + 3]        ) * 0x80         +           // PTS[14: 7] × 2⁷
      ((buf[p + 4] & 0xFE) >>> 1);                     // PTS[ 6: 0]

    return pts / 90000; // 90 kHz → seconds
  }
  return null;
}

class StreamController extends EventEmitter {
  constructor(cameraDevice = "/dev/video0") {
    super();
    this.cameraDevice = cameraDevice;
    this.gstProcess = null;
    this.ffmpegProcess = null; // Separate ffmpeg process for SRT+audio hybrid
    this.isStreaming = false;
    this.configFile = path.join(__dirname, "stream-config.json");

    // Default configuration
    const defaultConfig = {
      protocol: "srt", // 'srt' or 'rtmp'
      destination: "",
      width: 1920,
      height: 1080,
      framerate: 30,
      bitrate: 5000000, // 5 Mbps
      encoder: "mpph264enc", // Rockchip MPP hardware encoder (Orange Pi 5 / RK3588)
      autoStart: false, // Auto-start streaming on server startup
      // Overlay settings
      overlayEnabled: false,
      overlayType: "text", // 'text' or 'url'
      overlayText: "",
      showTimestamp: false,
      overlayUrl: "",
      overlayZoom: 100, // Zoom level for remote overlay page (50-200%)
      remoteOverlayEnabled: false, // Enable remote overlay (Puppeteer screenshot)
      timestampPosition: "bottom-right",
      titlePosition: "top-left",
      overlayFontSize: 32, // Default font size for overlays
      overlayColor: "white",
      overlayBackground: "transparent",
      overlayBackgroundOpacity: 70,
      // Per-element formatting
      titleFontSize: 32,
      titleColor: "white",
      titleBackground: "transparent",
      timestampFontSize: 24,
      timestampColor: "white",
      timestampBackground: "transparent",
      // Legacy fields
      timestampFormat: "%Y-%m-%d %H:%M:%S",
      logoPath: "", // Path to logo image overlay
      // Audio settings
      audioEnabled: true, // Include audio from camera mic in stream
      audioDevice: "hw:3,0", // ALSA device for camera microphone
      // Skia graphics overlay
      skiaGraphicsEnabled: false, // Enable Skia graphics overlay
      skiaGraphicsPort: 8556, // Port where Skia graphics server is running
      skiaGraphicsAlpha: 1.0, // Opacity of graphics overlay (0.0-1.0)
    };

    // Load config from file, merging with defaults to fill in any missing fields
    const savedConfig = this.loadConfig();
    if (savedConfig) {
      this.streamConfig = { ...defaultConfig, ...savedConfig };
    } else {
      this.streamConfig = defaultConfig;
      // Save defaults so a config file always exists
      this.saveConfig();
    }
  }

  /**
   * Initialize and auto-start if configured
   */
  async initialize() {
    if (this.streamConfig.autoStart) {
      console.log("🚀 Auto-starting stream on server startup...");
      // Wait a moment for the system to be ready
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const result = await this.startStream();
      if (result.success) {
        console.log("✅ Auto-start successful");
      } else {
        console.error("❌ Auto-start failed:", result.error);
      }
    }
  }

  /**
   * Load configuration from JSON file
   */
  loadConfig() {
    try {
      if (fs.existsSync(this.configFile)) {
        const data = fs.readFileSync(this.configFile, "utf8");
        const config = JSON.parse(data);
        console.log("✅ Loaded stream config from file:", this.configFile);
        return config;
      }
    } catch (error) {
      console.error("❌ Error loading config file:", error.message);
    }
    return null;
  }

  /**
   * Save configuration to JSON file
   */
  saveConfig() {
    try {
      fs.writeFileSync(
        this.configFile,
        JSON.stringify(this.streamConfig, null, 2),
        "utf8",
      );
      console.log("✅ Saved stream config to file:", this.configFile);
      return true;
    } catch (error) {
      console.error("❌ Error saving config file:", error.message);
      return false;
    }
  }

  /**
   * Start streaming with current configuration
   */
  async startStream(config = {}) {
    if (this.isStreaming) {
      return { success: false, error: "Stream already running" };
    }

    // Merge config
    this.streamConfig = { ...this.streamConfig, ...config };

    // For RTMP, destination is optional (defaults to local MediaMTX)
    // For SRT server mode, destination is not needed (device acts as server)

    try {
      // Kill any ffmpeg processes using the camera device
      console.log("Checking for processes using camera device...");
      await this._killCameraProcesses();

      // Kill any process using port 8555 (preview TCP server)
      console.log("🔍 Checking for processes using port 8555...");
      await this._killPortProcess(8555);
      console.log("✅ Port 8555 cleanup complete");

      // Create HLS directory for preview stream
      const fs = require("fs");
      const hlsDir = "/tmp/stream";
      if (!fs.existsSync(hlsDir)) {
        fs.mkdirSync(hlsDir, { recursive: true });
        console.log("📁 Created HLS directory:", hlsDir);
      } else {
        // Clean old segments
        const files = fs.readdirSync(hlsDir);
        files.forEach((file) => {
          fs.unlinkSync(`${hlsDir}/${file}`);
        });
        console.log("🧹 Cleaned old HLS segments");
      }

      // Wait a moment for the device and port to be released
      console.log("⏳ Waiting for resources to be released...");
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Emit "preparing" event so graphics overlay can initialize before GStreamer starts
      // Wait for the event handlers to complete (they may be async)
      await new Promise((resolve) => {
        this.emit("preparing");
        // Give event handlers time to complete (PNG generation + file write)
        setTimeout(resolve, 1500);
      });

      const gstArgs = this._buildGStreamerPipeline();

      // Unified sync mode: GStreamer outputs a complete audio+video MPEG-TS to
      // stdout (fdsink fd=1), and a separate ffmpeg process forwards it to SRT.
      // ffmpeg performs NO encoding or clock decisions — it is a pure transport
      // layer. All sync is guaranteed by the shared GStreamer pipeline clock.
      // Applies to BOTH the direct gst-launch path and the Python compositor path.
      // Hybrid mode applies to both SRT and RTMP when audio is enabled.
      // Both suffer from the same USB mic oscillator drift (~0.12% faster than
      // system clock). The GStreamer-native paths (mpegtsmux/flvmux with alsasrc)
      // accumulate that drift and produce growing latency over time. The ffmpeg
      // hybrid path anchors both inputs to wall clock and uses aresample=async
      // to correct residual jitter — eliminating accumulation entirely.
      const useFfmpegAudio =
        (this.streamConfig.protocol === "srt" || this.streamConfig.protocol === "rtmp") &&
        this.streamConfig.audioEnabled;

      // Check if we're using the compositor helper script
      if (gstArgs.useCompositorScript) {
        console.log("Starting GStreamer with compositor script...");
        console.log("Script args:", gstArgs.scriptArgs.join(" "));

        // In SRT+audio mode the Python script writes a full audio+video MPEG-TS
        // to stdout (fdsink fd=1). Always pipe stdout so ffmpeg can read it;
        // all Python diagnostics go to stderr (captured by the stderr handler below).
        const compositorOpts = useFfmpegAudio
          ? { stdio: ["ignore", "pipe", "pipe"] }
          : { stdio: ["ignore", "pipe", "pipe"] }; // always pipe — diagnostics on stderr

        // Check if scriptPath is a Python script, Node script, or bash script
        if (gstArgs.scriptPath === 'python3' || gstArgs.scriptPath === 'node') {
          // For Python/Node scripts, spawn the interpreter directly with script as first arg
          this.gstProcess = spawn(gstArgs.scriptPath, gstArgs.scriptArgs, compositorOpts);
        } else {
          // For bash scripts, spawn bash with script path
          this.gstProcess = spawn("bash", [gstArgs.scriptPath, ...gstArgs.scriptArgs], compositorOpts);
        }
      } else {
        console.log("Starting GStreamer with pipeline:", gstArgs.join(" "));
        if (useFfmpegAudio) {
          // stdout is binary MPEG-TS destined for ffmpeg — must be a pipe, not inherited
          this.gstProcess = spawn("gst-launch-1.0", gstArgs, {
            stdio: ["ignore", "pipe", "pipe"],
          });
        } else {
          this.gstProcess = spawn("gst-launch-1.0", gstArgs);
        }
      }

      if (!useFfmpegAudio) {
        // In hybrid mode stdout is raw binary MPEG-TS — do not attach a text listener
        this.gstProcess.stdout.on("data", (data) => {
          console.log(`GStreamer stdout: ${data}`);
          this.emit("log", data.toString());
        });
      }

      this.gstProcess.stderr.on("data", (data) => {
        const message = data.toString();

        // Suppress high-frequency operational messages that add no debugging value.
        // "Overlay PNG reloaded" fires every time Puppeteer updates the screenshot
        // (every ~5s) — logging it every time floods the console and stream log.
        if (message.includes("Overlay PNG reloaded")) {
          return; // silently discard
        }

        console.error(`GStreamer stderr: ${message}`);

        // Only emit as error if it's an actual error (contains ERROR, WARNING, or CRITICAL)
        // Ignore informational messages like NVMEDIA, NvMMLite, H264 profile info
        if (
          message.includes("ERROR") ||
          message.includes("WARNING") ||
          message.includes("CRITICAL") ||
          message.includes("failed") ||
          message.includes("Failed")
        ) {
          this.emit("error", message);
        } else {
          // Treat as informational log
          this.emit("log", message);
        }
      });

      this.gstProcess.on("close", async (code) => {
        console.log(`GStreamer process exited with code ${code}`);
        this.isStreaming = false;
        this.gstProcess = null;

        // When GStreamer exits its stdout pipe closes, which causes ffmpeg to see EOF
        // on stdin and exit naturally. Kill explicitly in case it hangs.
        if (this.ffmpegProcess) {
          try { this.ffmpegProcess.kill("SIGINT"); } catch (_) {}
          this.ffmpegProcess = null;
        }

        // If GStreamer failed (non-zero exit code), ensure camera is released
        if (code !== 0 && code !== null) {
          console.error(`❌ GStreamer failed with exit code ${code}`);
          console.error("💡 Common causes:");
          console.error("   - Missing plugin (e.g., srtsink for SRT)");
          console.error("   - Invalid pipeline syntax");
          console.error("   - Camera device busy");
          console.error("💡 Run 'gst-inspect-1.0 srtsink' to check if SRT plugin is installed");
          console.log("⚠️  GStreamer failed, cleaning up camera resources...");
          await this._killCameraProcesses();
        }

        this.emit("stopped", code);
      });

      // Spawn ffmpeg for hybrid A/V mux: reads video-only MPEG-TS from GStreamer's
      // stdout and muxes it with ALSA audio capture.
      //
      // Timestamp strategy — "wall-clock audio, itsoffset-aligned video":
      //
      //  Problem A — USB clock drift:
      //   The USB audio hardware oscillator runs ~0.12% faster than the system
      //   clock (~58 samples/sec at 48 kHz). Without correction the audio PTS
      //   advances faster than video PTS, the muxer buffers the "ahead" stream,
      //   and the RTMP output accumulates ~1 s of extra latency every 15-20 min.
      //   Fix: -use_wallclock_as_timestamps 1 on the ALSA input anchors audio
      //   to the system wall clock (av_gettime), eliminating the USB oscillator
      //   drift entirely.
      //
      //  Problem B — duplicate DTS when wallclock is applied to video:
      //   -use_wallclock_as_timestamps on the MPEG-TS pipe causes ffmpeg to
      //   stamp each chunk with the wall-clock time at the moment it calls
      //   read(). A single read() often returns a burst of frames that all get
      //   the SAME millisecond timestamp → duplicate DTS → MediaMTX drops the
      //   RTMP connection immediately.
      //   Fix: NEVER apply -use_wallclock_as_timestamps to the video pipe.
      //   GStreamer's own nanosecond pipeline clock is already monotonic and
      //   precise; leave it untouched.
      //
      //  Problem C — mismatched timestamp scales:
      //   With audio at Unix epoch (~1.74×10⁹ s) and video at GStreamer clock
      //   (~0–2 s), the two streams are ~1.74 billion seconds apart. The FLV
      //   muxer normalises by subtracting the minimum PTS, but only after the
      //   streams are already interleaved. max_interleave_delta=1s can't bridge
      //   a billion-second gap; the muxer will stall or fail.
      //   Fix: -itsoffset applied to the video input inside the once("data")
      //   callback shifts GStreamer's timestamps up into wall-clock territory.
      //   The offset = Date.now()/1000 − firstPTS_seconds (parsed from the first
      //   MPEG-TS chunk via extractMpegtsPts). After the shift, video PTS ≈ audio
      //   PTS; the muxer normalises both to start at ~0 and they track each other
      //   for the life of the session with no accumulated drift.
      //
      // Applies to both SRT (→ mpegts) and RTMP (→ flv) when audio is enabled.
      if (useFfmpegAudio) {
        const protocol = this.streamConfig.protocol;
        console.log(`📡 Hybrid mode — ffmpeg muxing ALSA audio + GStreamer video → ${protocol.toUpperCase()}`);

        const audioDevice = this.streamConfig.audioDevice || "hw:3,0";

        // ── Part 1: Audio input args (built now) ────────────────────────────
        // -use_wallclock_as_timestamps 1 replaces ALSA's USB-clock-derived PTS
        // with av_gettime() (system wall clock), so audio never drifts relative
        // to real time regardless of how long the session runs.
        const ffmpegAudioArgs = [
          "-loglevel", "warning",
          "-use_wallclock_as_timestamps", "1",
          "-f", "alsa",
          "-ar", "48000",
          "-ac", "2",
          "-thread_queue_size", "4096",
          "-i", audioDevice,
        ];

        // ── Part 2: Output args (built now) ─────────────────────────────────
        const ffmpegOutputArgs = [
          "-map", "1:v",         // video from GStreamer (input 1)
          "-map", "0:a",         // audio from ALSA     (input 0)
          "-c:v", "copy",        // pass H.264 through unchanged
          // RTMP+audio hybrid: strip inline SPS/PPS (NAL types 7 & 8) from the
          // H.264 byte-stream BEFORE ffmpeg's internal h264_annexb_to_mp4 BSF runs.
          // With header-mode=each-idr the encoder prepends SPS+PPS before every IDR.
          // When ffmpeg converts Annex B → AVCC for FLV it sees those inline headers
          // and emits a new AVC sequence header tag + IDR tag with the SAME DTS —
          // MediaMTX drops the connection: "DTS is not monotonically increasing".
          // filter_units strips types 7 (SPS) and 8 (PPS) so the annexb→mp4 BSF
          // only sees the IDR NALU; the sequence header was already written once at
          // startup from the MPEG-TS PMT extradata, so DTS always strictly advances.
          // SRT does not use this filter — inline SPS/PPS help OBS resync mid-stream.
          ...(protocol === "rtmp" ? ["-bsf:v", "filter_units=remove_types=7-8"] : []),
          "-c:a", "aac",
          "-b:a", "128k",
          // aresample=async=1000: safety net for any residual A/V timing jitter
          // (e.g. initial sub-frame ALSA buffer boundary offset). The USB drift
          // is now fully handled by wall-clock timestamps on the audio input, so
          // this filter only needs to absorb minor one-off discontinuities.
          "-af", "aresample=async=1000",
          // max_interleave_delta: once both streams share the same timestamp scale
          // (wall-clock) the interleave delta stays near zero, but we cap at 1 s
          // as a safety margin. muxdelay=0 removes per-packet mux buffering.
          "-max_interleave_delta", "1000000",  // 1 second cap (µs)
          "-muxdelay", "0",
          // flush_packets=1 (RTMP only): force ffmpeg to flush each encoded packet to
          // the TCP socket immediately. Without this the FLV muxer may hold packets in
          // its write cache waiting for a full block — over a long session that cache
          // can grow and become another source of creeping latency.
          ...(protocol === "rtmp" ? ["-flush_packets", "1"] : []),
          ...(protocol === "srt"
            ? ["-f", "mpegts", "srt://0.0.0.0:8891?mode=listener&latency=500000"]
            : ["-f", "flv", (
                this.streamConfig.destination && this.streamConfig.destination.trim() !== ""
                  ? this.streamConfig.destination.trim()
                  : "rtmp://localhost:1935/stream"
              )]),
        ];

        // ── Deferred ffmpeg spawn ────────────────────────────────────────────
        // GStreamer's MPP hardware encoder takes 1-2 s to produce its first
        // frame. Deferring the spawn until the first video chunk arrives ensures
        // ALSA capture (and its wall-clock timestamps) begins at the same instant
        // as video, so both streams share the same wall-clock origin and the FLV
        // muxer normalises them both to start at ~0.
        //
        // Inside the callback we also compute the -itsoffset for the video input:
        //   1. Read the current wall-clock time (Date.now()/1000).
        //   2. Parse the first MPEG-TS PTS from the incoming chunk (GStreamer's
        //      pipeline clock, in seconds since the pipeline entered PLAYING state,
        //      typically 1-2 s due to encoder warm-up).
        //   3. itsoffset = wallNow − gstPts  →  after the shift, video PTS ≈ audio PTS.
        //
        // NOTE: do NOT call gstStdout.pause() before attaching the listener.
        // pause() sets _readableState.flowing = false; a subsequent "data"
        // listener checks `if (flowing !== false) resume()` and skips resume,
        // leaving the stream permanently paused → once() never fires → ffmpeg
        // never spawns → SRT port never opens.
        const gstStdout = this.gstProcess.stdout;

        gstStdout.once("data", (firstChunk) => {
          // ── Compute video -itsoffset ───────────────────────────────────────
          // Parse the GStreamer PTS from the first MPEG-TS chunk so we know
          // exactly how far ahead of zero the video clock already is.
          const wallNowSec  = Date.now() / 1000;
          const gstPtsSec   = extractMpegtsPts(firstChunk);
          // If parsing fails fall back to wallNow (both start near epoch, muxer
          // normalises anyway — slight A/V skew at startup only, no ongoing drift).
          const videoItsOffset = gstPtsSec != null
            ? (wallNowSec - gstPtsSec).toFixed(6)
            : wallNowSec.toFixed(6);

          console.log(
            `🕒 A/V sync — wall:${wallNowSec.toFixed(3)}s` +
            ` gstPts:${gstPtsSec != null ? gstPtsSec.toFixed(3) : "n/a"}s` +
            ` itsoffset:${videoItsOffset}s`
          );

          // ── Part 2: Video input args (built at spawn) ──────────────────────
          // SRT: probesize=32 is enough because there is only ONE PID to detect
          //   and ffmpeg is just passing through the MPEG-TS without inspecting H.264.
          //   +nobuffer keeps latency minimal; +discardcorrupt drops garbled packets.
          // RTMP/FLV: ffmpeg must parse the MPEG-TS PMT to extract H.264 SPS/PPS
          //   and build the AVC sequence header for the FLV container. A larger
          //   probesize ensures ffmpeg reads enough to fully parse the PMT before
          //   outputting FLV packets. +genpts regenerates missing PTS from DTS.
          const ffmpegVideoArgs = [
            "-itsoffset", videoItsOffset,
            // +nobuffer: prevent ffmpeg from accumulating an internal demux buffer on
            // the video pipe — this is the primary guard against latency drift growing
            // over long sessions (same flag used for SRT).
            // +genpts: regenerate PTS from DTS — required for FLV/RTMP because some
            // MPEG-TS packets from GStreamer carry only DTS; without this the FLV muxer
            // may emit packets with missing/invalid PTS that MediaMTX drops.
            // low_delay: hint to ffmpeg's demuxer, muxer, and codec threads to minimise
            // internal buffering at every stage — mirrors the SRT path exactly.
            ...(protocol === "rtmp"
              ? ["-fflags", "+genpts+nobuffer", "-flags", "low_delay"]
              : ["-fflags", "+nobuffer+discardcorrupt", "-flags", "low_delay"]),
            ...(protocol === "rtmp"
              ? ["-probesize", "1048576", "-analyzeduration", "500000"]
              : ["-probesize", "32", "-analyzeduration", "0"]),
            "-thread_queue_size", "4096",
            "-f", "mpegts",
            "-i", "pipe:0",
          ];

          const ffmpegArgs = [...ffmpegAudioArgs, ...ffmpegVideoArgs, ...ffmpegOutputArgs];

          console.log("Starting ffmpeg with args:", ffmpegArgs.join(" "));
          this.ffmpegProcess = spawn("ffmpeg", ffmpegArgs, {
            stdio: ["pipe", "pipe", "pipe"],
          });

          // Write the first chunk manually, then hand off to pipe().
          this.ffmpegProcess.stdin.write(firstChunk);
          gstStdout.pipe(this.ffmpegProcess.stdin);

          this.ffmpegProcess.stderr.on("data", (data) => {
            const msg = data.toString();
            console.log(`ffmpeg: ${msg}`);
            this.emit("log", msg);
          });

          this.ffmpegProcess.stdin.on("error", (err) => {
            if (err.code !== "EPIPE") console.error(`ffmpeg stdin error: ${err.message}`);
          });

          this.ffmpegProcess.on("close", (code) => {
            console.log(`ffmpeg exited with code ${code}`);
            this.ffmpegProcess = null;
          });
        });
      }

      this.isStreaming = true;
      this.emit("started");

      // Enable auto-start and save config
      this.streamConfig.autoStart = true;
      this.saveConfig();

      return { success: true, message: "Stream started" };
    } catch (error) {
      // Ensure camera is released on error
      console.log("⚠️  Stream start failed, cleaning up camera resources...");
      await this._killCameraProcesses();
      this.isStreaming = false;
      this.gstProcess = null;

      return { success: false, error: error.message };
    }
  }

  /**
   * Stop the current stream
   */
  async stopStream() {
    if (!this.isStreaming || !this.gstProcess) {
      return { success: false, error: "No stream running" };
    }

    try {
      this.gstProcess.kill("SIGINT");

      // In hybrid mode, killing GStreamer closes the pipe → ffmpeg sees EOF → exits.
      // Kill explicitly here too in case it doesn't exit on its own.
      if (this.ffmpegProcess) {
        try { this.ffmpegProcess.kill("SIGINT"); } catch (_) {}
        this.ffmpegProcess = null;
      }

      this.isStreaming = false;

      // Wait for process to fully exit and release the camera device
      // V4L2 devices need time to be released by the kernel after the process exits
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Ensure camera is fully released
      await this._killCameraProcesses();

      // Additional wait for kernel to fully release the V4L2 device
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Disable auto-start and save config
      this.streamConfig.autoStart = false;
      this.saveConfig();

      return { success: true, message: "Stream stopped" };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Get current stream status
   */
  getStatus() {
    return {
      isStreaming: this.isStreaming,
      config: this.streamConfig,
    };
  }

  /**
   * Update stream configuration (requires restart)
   */
  updateConfig(config) {
    this.streamConfig = { ...this.streamConfig, ...config };
    this.saveConfig(); // Save to file
    return { success: true, config: this.streamConfig };
  }

  /**
   * Kill any processes using the camera device
   */
  async _killCameraProcesses() {
    const { exec } = require("child_process");
    const util = require("util");
    const execPromise = util.promisify(exec);

    try {
      // Try multiple methods to find and kill processes using the camera

      // Method 1: Use fuser (most reliable for device files)
      try {
        const { stdout: fuserOut } = await execPromise(
          `sudo fuser ${this.cameraDevice} 2>&1 || true`,
        );
        if (fuserOut.trim()) {
          console.log("fuser output:", fuserOut);
          // Extract PIDs (fuser outputs like "/dev/video0: 1234 5678")
          const match = fuserOut.match(/:\s*(.+)/);
          if (match) {
            const pids = match[1].trim().split(/\s+/);
            for (const pid of pids) {
              if (pid && !isNaN(pid) && parseInt(pid) !== process.pid) {
                console.log(`Killing process ${pid} (found by fuser)...`);
                try {
                  await execPromise(`sudo kill -TERM ${pid}`);
                } catch (err) {
                  console.log(`Could not kill process ${pid}:`, err.message);
                }
              }
            }
          }
        }
      } catch (err) {
        console.log("fuser not available or failed:", err.message);
      }

      // Method 2: Kill all GStreamer and ffmpeg processes using the camera (fallback)
      try {
        const { stdout: psOut } = await execPromise(
          `ps aux | grep -E '(ffmpeg|gst-launch|gst-launch-1.0)' | grep -v grep || true`,
        );
        if (psOut.trim()) {
          console.log("Found media processes:", psOut);
          const lines = psOut.trim().split("\n");
          for (const line of lines) {
            const parts = line.trim().split(/\s+/);
            if (parts.length > 1) {
              const pid = parts[1];
              // Don't kill our own process
              if (parseInt(pid) !== process.pid) {
                console.log(`Killing media process ${pid}...`);
                try {
                  process.kill(parseInt(pid), "SIGTERM");
                } catch (err) {
                  console.log(`Could not kill process ${pid}:`, err.message);
                }
              }
            }
          }
        }
      } catch (err) {
        console.log("Could not find media processes:", err.message);
      }

      // Verify the device is actually free now
      await new Promise((resolve) => setTimeout(resolve, 500));
      try {
        const { stdout: verifyOut } = await execPromise(
          `sudo fuser ${this.cameraDevice} 2>&1 || true`,
        );
        const stillBusy = verifyOut.trim() && /\d/.test(verifyOut);
        if (stillBusy) {
          console.log(`⚠️  Camera still busy after cleanup: ${verifyOut.trim()}`);
          // Force kill remaining processes
          await execPromise(`sudo fuser -k ${this.cameraDevice} 2>/dev/null || true`);
          await new Promise((resolve) => setTimeout(resolve, 1000));
          console.log("🔪 Force-killed remaining camera processes");
        }
      } catch (err) {
        // ignore
      }

      console.log("Finished checking for camera processes");
    } catch (error) {
      console.log("Error checking for camera processes:", error.message);
    }
  }

  /**
   * Kill any process using a specific port
   */
  async _killPortProcess(port) {
    const { exec } = require("child_process");
    const util = require("util");
    const execPromise = util.promisify(exec);

    try {
      let pids = [];

      // Method 1: Try lsof first
      try {
        const { stdout: lsofOut } = await execPromise(
          `lsof -ti:${port} 2>/dev/null || true`,
        );
        if (lsofOut.trim()) {
          pids = lsofOut
            .trim()
            .split("\n")
            .filter((p) => p && !isNaN(p));
          console.log(`lsof found PIDs using port ${port}:`, pids);
        }
      } catch (err) {
        console.log("lsof not available or failed");
      }

      // Method 2: Try fuser as fallback
      if (pids.length === 0) {
        try {
          const { stdout: fuserOut } = await execPromise(
            `fuser ${port}/tcp 2>/dev/null || true`,
          );
          if (fuserOut.trim()) {
            pids = fuserOut
              .trim()
              .split(/\s+/)
              .filter((p) => p && !isNaN(p));
            console.log(`fuser found PIDs using port ${port}:`, pids);
          }
        } catch (err) {
          console.log("fuser not available or failed");
        }
      }

      // Method 3: Try netstat/ss as last resort
      if (pids.length === 0) {
        try {
          const { stdout: netstatOut } = await execPromise(
            `netstat -tlnp 2>/dev/null | grep :${port} || ss -tlnp 2>/dev/null | grep :${port} || true`,
          );
          if (netstatOut.trim()) {
            console.log(`netstat/ss output:`, netstatOut);
            // Extract PID from output like "tcp 0 0 0.0.0.0:8554 0.0.0.0:* LISTEN 12345/gst-launch-1"
            const match = netstatOut.match(/(\d+)\//);
            if (match) {
              pids.push(match[1]);
              console.log(`netstat/ss found PID using port ${port}:`, pids);
            }
          }
        } catch (err) {
          console.log("netstat/ss not available or failed");
        }
      }

      // Kill all found PIDs
      if (pids.length > 0) {
        for (const pid of pids) {
          if (pid && !isNaN(pid)) {
            console.log(`Killing process ${pid} using port ${port}...`);
            try {
              process.kill(parseInt(pid), "SIGTERM");
              console.log(`Sent SIGTERM to ${pid}`);
            } catch (err) {
              console.log(`Could not send SIGTERM to ${pid}:`, err.message);
            }
          }
        }

        // Wait for graceful shutdown
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // Force kill if still running
        for (const pid of pids) {
          if (pid && !isNaN(pid)) {
            try {
              process.kill(parseInt(pid), "SIGKILL");
              console.log(`Sent SIGKILL to ${pid}`);
            } catch (err) {
              // Process already dead, that's fine
              console.log(`Process ${pid} already terminated`);
            }
          }
        }

        // Wait a bit more for port to be released
        await new Promise((resolve) => setTimeout(resolve, 500));
      } else {
        console.log(`No process found using port ${port}`);
      }
    } catch (error) {
      console.log(`Error checking port ${port}:`, error.message);
    }
  }

  /**
   * Build PNG overlay pipeline with graphics overlay
   * Uses gdkpixbufoverlay to overlay a dynamically updated PNG file
   * This is MUCH simpler and more reliable than the compositor approach
   */
  _buildPNGOverlayPipeline() {
    const {
      destination,
      width,
      height,
      framerate,
      bitrate,
      overlayText,
    } = this.streamConfig;

    console.log("🎨 Graphics overlay enabled - using PNG overlay (gdkpixbufoverlay)");

    const protocol = this.streamConfig.protocol || "srt";
    // Build the full destination URL based on protocol
    let effectiveDestination = destination || "";
    if (!effectiveDestination) {
      if (protocol === "srt") {
        effectiveDestination = "srt://:8891";
      } else if (protocol === "rtmp") {
        effectiveDestination = "rtmp://localhost:1935/stream";
      }
    }
    const pngPath = "/tmp/graphics-overlay.png";

    // Per-element formatting (fall back to legacy shared values)
    const titleFs = this.streamConfig.titleFontSize || this.streamConfig.overlayFontSize || 32;
    const titleColor = this._colorToInt(this.streamConfig.titleColor || this.streamConfig.overlayColor || "white");
    const titleBackground = this.streamConfig.titleBackground || this.streamConfig.overlayBackground || "transparent";
    const tsFs = this.streamConfig.timestampFontSize || Math.round((this.streamConfig.overlayFontSize || 32) * 0.75);
    const tsColor = this._colorToInt(this.streamConfig.timestampColor || this.streamConfig.overlayColor || "white");
    const tsBackground = this.streamConfig.timestampBackground || this.streamConfig.overlayBackground || "transparent";

    // Scale font sizes the same way the text-only pipeline does (1.5x for 1080p)
    const scaledTitleFontSize = Math.round(titleFs * 1.5);
    const scaledTsFontSize = Math.round(tsFs * 1.5);

    console.log(`🎨 PNG overlay formatting — Title: size=${titleFs}→${scaledTitleFontSize}, color=${titleColor}, bg=${titleBackground}`);
    console.log(`🎨 PNG overlay formatting — Timestamp: size=${tsFs}→${scaledTsFontSize}, color=${tsColor}, bg=${tsBackground}`);
    console.log(`🎨 Raw config values — titleFontSize=${this.streamConfig.titleFontSize}, timestampFontSize=${this.streamConfig.timestampFontSize}, overlayFontSize=${this.streamConfig.overlayFontSize}`);

    const timestampFormat = this.streamConfig.timestampFormat || "%Y-%m-%d %H:%M:%S";
    const titlePosition = this.streamConfig.titlePosition || "top-left";
    const timestampPosition = this.streamConfig.timestampPosition || "bottom-right";

    // Use the PNG overlay helper script
    const scriptPath = path.join(__dirname, 'png-overlay-helper.sh');

    // Only pass overlay text if the Title checkbox is enabled
    const effectiveOverlayText = this.streamConfig.overlayEnabled ? (overlayText || "") : "";
    // Only pass timestamp if the Timestamp checkbox is enabled
    const effectiveShowTimestamp = this.streamConfig.showTimestamp ? "true" : "false";

    const audioDevice = this.streamConfig.audioEnabled ? (this.streamConfig.audioDevice || "hw:3,0") : "";

    const scriptArgs = [
      this.cameraDevice,
      width.toString(),
      height.toString(),
      framerate.toString(),
      bitrate.toString(),
      protocol,
      effectiveDestination,
      pngPath,
      effectiveOverlayText,
      effectiveShowTimestamp,
      scaledTitleFontSize.toString(),
      titleColor.toString(),
      titleBackground,
      timestampFormat,
      titlePosition,
      timestampPosition,
      audioDevice,
      // Per-element timestamp formatting (new args)
      scaledTsFontSize.toString(),
      tsColor.toString(),
      tsBackground,
    ];

    return {
      useCompositorScript: true,
      scriptPath: scriptPath,
      scriptArgs: scriptArgs,
    };
  }

  /**
   * Build GStreamer pipeline based on configuration
   */
  _buildGStreamerPipeline() {
    const {
      protocol,
      destination,
      width,
      height,
      framerate,
      bitrate,
      encoder,
    } = this.streamConfig;

    // Check if graphics overlay is needed:
    // - Legacy: skiaGraphicsEnabled checkbox (being removed from UI)
    // - New: Remote overlay checkbox with a URL set
    const needsGraphicsOverlay = this.streamConfig.skiaGraphicsEnabled ||
      (this.streamConfig.remoteOverlayEnabled &&
        this.streamConfig.overlayUrl && this.streamConfig.overlayUrl.trim());

    if (needsGraphicsOverlay) {
      // Use the PNG overlay pipeline (Python GStreamer with gdkpixbufoverlay)
      return this._buildPNGOverlayPipeline();
    }

    let pipeline = [
      // Video source - use MJPEG format which most USB cameras support at high resolution
      "v4l2src",
      `device=${this.cameraDevice}`,
      "do-timestamp=true", // Use pipeline clock timestamps for better sync
      "!",
      `image/jpeg,width=${width},height=${height},framerate=${framerate}/1`,
      "!",
      "jpegparse",
      "!",
      "mppjpegdec",
      "!",
    ];

    // Add overlays if any individual overlay is enabled
    const hasAnyOverlay = this.streamConfig.overlayEnabled || this.streamConfig.showTimestamp;
    if (hasAnyOverlay) {
      // Convert to format suitable for textoverlay
      pipeline.push("videoconvert", "!");

      // Add timestamp overlay if enabled (per-element formatting)
      if (this.streamConfig.showTimestamp) {
        const tsPosition =
          this.streamConfig.timestampPosition || "bottom-right";
        const [vpos, hpos] = tsPosition.split("-");
        const valign =
          vpos === "bottom" ? "bottom" : vpos === "center" ? "center" : "top";
        const halign =
          hpos === "left" ? "left" : hpos === "right" ? "right" : "center";

        // Per-element font size (fall back to legacy shared value)
        const tsFs = this.streamConfig.timestampFontSize || Math.round((this.streamConfig.overlayFontSize || 32) * 0.75);
        const scaledFontSize = Math.round(tsFs * 1.5);
        const tsColor = this.streamConfig.timestampColor || this.streamConfig.overlayColor || "white";
        const tsBg = this.streamConfig.timestampBackground || this.streamConfig.overlayBackground || "transparent";
        console.log(`🎨 Text-only pipeline — Timestamp: size=${tsFs}→${scaledFontSize}, color=${tsColor}, bg=${tsBg}`);

        const timestampArgs = [
          "clockoverlay",
          `valignment=${valign}`,
          `halignment=${halign}`,
          `font-desc=Sans Bold ${scaledFontSize}`,
          `color=${this._colorToInt(tsColor)}`,
          `time-format="${this.streamConfig.timestampFormat || '%Y-%m-%d %H:%M:%S'}"`,
        ];

        if (tsBg !== "transparent") {
          timestampArgs.push("shaded-background=true");
        }

        timestampArgs.push("xpad=20", "ypad=20", "!");
        pipeline.push(...timestampArgs);
      }

      // Add custom text overlay 1 (main title) - only if Title checkbox is enabled
      if (this.streamConfig.overlayEnabled && (this.streamConfig.overlayText || this.streamConfig.customText1)) {
        const text =
          this.streamConfig.overlayText || this.streamConfig.customText1;

        const position =
          this.streamConfig.titlePosition ||
          this.streamConfig.overlayPosition ||
          "bottom-left";
        const [vpos, hpos] = position.split("-");
        const valign =
          vpos === "bottom" ? "bottom" : vpos === "center" ? "center" : "top";
        const halign =
          hpos === "left" ? "left" : hpos === "right" ? "right" : "center";

        // Per-element font size (fall back to legacy shared value)
        const titleFs = this.streamConfig.titleFontSize || this.streamConfig.overlayFontSize || 32;
        const scaledFontSize = Math.round(titleFs * 1.5);
        const titleClr = this.streamConfig.titleColor || this.streamConfig.overlayColor || "white";
        const titleBg = this.streamConfig.titleBackground || this.streamConfig.overlayBackground || "transparent";

        const textArgs = [
          "textoverlay",
          `text="${text}"`,
          `valignment=${valign}`,
          `halignment=${halign}`,
          `font-desc=Sans Bold ${scaledFontSize}`,
          `color=${this._colorToInt(titleClr)}`,
        ];

        if (titleBg !== "transparent") {
          textArgs.push("shaded-background=true");
        }

        textArgs.push("xpad=20", "ypad=20", "!");
        pipeline.push(...textArgs);
      }

      // Add custom text overlay 2 (subtitle/secondary text)
      if (this.streamConfig.customText2) {
        const valign =
          this.streamConfig.overlayPosition === "bottom" ? "bottom" : "center";
        pipeline.push(
          "textoverlay",
          `text="${this.streamConfig.customText2}"`,
          `valignment=${valign}`,
          "halignment=center",
          `font-desc=Sans ${Math.floor(this.streamConfig.overlayFontSize * 0.75)}`,
          `color=${this._colorToInt(this.streamConfig.overlayColor)}`,
          "shaded-background=true",
          "!",
        );
      }

      // Add logo overlay if path provided
      if (this.streamConfig.logoPath) {
        // Note: gdkpixbufoverlay requires the image file to exist
        pipeline.push(
          "gdkpixbufoverlay",
          `location=${this.streamConfig.logoPath}`,
          "offset-x=20",
          "offset-y=20",
          "!",
        );
      }
    }

    // Graphics overlay compositing is disabled for now
    // The compositor requires a complex multi-source pipeline that doesn't work
    // well with our linear pipeline building approach
    //
    // TODO: Implement proper compositor using gst-launch-1.0 with multiple sources

    // For now, just use the normal pipeline
    // When using MPP hardware path without overlays, mppjpegdec outputs NV12 directly
    // so we can skip videoconvert before the tee to save CPU
    if (encoder === "mpph264enc" && !hasAnyOverlay) {
      pipeline.push("video/x-raw,format=NV12", "!", "tee", "name=t");
    } else {
      pipeline.push("videoconvert", "!", "tee", "name=t");
    }

    // Branch 1: Encoding pipeline for streaming
    // IMPORTANT: must be limited + leaky. Default queue (200 buf / 10 MB, non-leaky) blocks the
    // entire capture chain when the encoder is momentarily slow (e.g. thermal throttle), which
    // causes kernel V4L2 buffer overflows and frame drops at the driver level.
    pipeline.push(
      "t.", "!",
      "queue",
      "max-size-buffers=2",   // Only 2 raw NV12 frames — encoder must keep up
      "max-size-time=0",      // Disable time limit (use buffer count only)
      "max-size-bytes=0",     // Disable byte limit (use buffer count only)
      "leaky=downstream",     // Drop oldest raw frame on overflow rather than blocking capture
      "!",
    );

    // Encoding pipeline
    if (encoder === "mpph264enc") {
      // Rockchip MPP hardware encoder (Orange Pi 5 / RK3588)
      // When no overlay, NV12 comes directly from mppjpegdec — no videoconvert needed
      if (hasAnyOverlay) {
        pipeline.push("videoconvert", "!", "video/x-raw,format=NV12", "!");
      }
      pipeline.push(
        "mpph264enc",
        `bps=${bitrate}`,
        // Allow bursts up to 1.6x target for motion headroom. Pure CBR (bps-max=bps) forces
        // the encoder to raise quantizer on high-motion frames (fast pool shots) causing
        // pixelation. SRT latency=500ms absorbs short bursts; average stays at target bps.
        `bps-max=${Math.round(bitrate * 1.6)}`,
        "rc-mode=vbr",          // VBR with bps-max cap = constrained VBR — best quality/stability tradeoff
        "gop=5",                // Keyframe every ~167ms — fast recovery from any dropped frame
        "header-mode=each-idr", // SPS/PPS prepended to every IDR in the bitstream
        "profile=baseline", // No B-frames — required for RTMP/FLV and better for low-latency
        "!",
        "video/x-h264,stream-format=byte-stream",
        "!",
        "h264parse",
        // RTMP+audio hybrid: config-interval=0 — SPS/PPS go only into the MPEG-TS PMT.
        // ffmpeg reads them once from the PMT and emits ONE AVC sequence header in the FLV.
        // With config-interval=-1 ffmpeg sees inline SPS/PPS before EVERY IDR and emits a
        // new sequence header + IDR NALU with the same DTS → MediaMTX drops the connection.
        // All other paths use -1 so OBS/players can resync after packet loss.
        `config-interval=${protocol === "rtmp" && this.streamConfig.audioEnabled ? "0" : "-1"}`,
        "!",
      );
    } else if (encoder === "x264enc") {
      // Software encoder (fallback)
      const bitrate_kbps = Math.round(bitrate / 1000);
      pipeline.push(
        "videoconvert",
        "!",
        "video/x-raw,format=I420",
        "!",
        "x264enc",
        `speed-preset=ultrafast`,
        `tune=zerolatency`,
        `bitrate=${bitrate_kbps}`,
        "key-int-max=30",
        "threads=0",
        "sliced-threads=true",
        "!",
        "video/x-h264,stream-format=byte-stream",
        "!",
        "h264parse",
        `config-interval=${protocol === "rtmp" && this.streamConfig.audioEnabled ? "0" : "-1"}`,
        "!",
      );
    } else if (encoder === "nvv4l2h264enc") {
      // NVIDIA V4L2 encoder (Jetson)
      pipeline.push(
        "nvvidconv",
        "!",
        "video/x-raw(memory:NVMM)",
        "!",
        "nvv4l2h264enc",
        `bitrate=${bitrate}`,
        "preset-level=1",
        "profile=0",
        "iframeinterval=15",
        "insert-sps-pps=true",
        "maxperf-enable=true",
        "!",
        "video/x-h264,stream-format=byte-stream",
        "!",
        "h264parse",
        `config-interval=${protocol === "rtmp" && this.streamConfig.audioEnabled ? "0" : "-1"}`,
        "!",
      );
    } else if (encoder === "omxh264enc") {
      // OpenMAX encoder (fallback)
      pipeline.push("omxh264enc", `bitrate=${bitrate}`, "!", "h264parse", "!");
    }

    // Add another tee after encoding to split H.264 for output and preview
    pipeline.push("tee", "name=t2");

    // Branch 2a: Output stream (SRT or RTMP) - from t2 (H.264)
    if (protocol === "srt") {
      // SRT streaming - low latency with error correction
      // Use srtsink as listener - device acts as server, OBS connects as client
      // Port 8891 (8890 is used by MediaMTX)

      console.log(
        `📡 SRT server mode - OBS should connect to: srt://${this._getLocalIP()}:8891`,
      );

      pipeline.push(
        "t2.",
        "!",
        "queue",
        "max-size-buffers=0", // Use time-based buffering
        "max-size-time=500000000", // 500 ms buffer — enough to absorb encoding spikes without adding latency
        "max-size-bytes=0",
        "leaky=downstream", // Drop old frames if queue is full
        "!",
        "mpegtsmux",
        "name=mux",
        "alignment=7", // Align packets for better compatibility
        "!",
      );

      if (this.streamConfig.audioEnabled) {
        // Hybrid mode: GStreamer outputs VIDEO-ONLY MPEG-TS to stdout.
        // ffmpeg captures audio from ALSA and muxes it with the incoming video,
        // then forwards everything to the SRT listener.
        //
        // Why video-only in the GStreamer mux:
        // mpegtsmux is a SYNCHRONIZING muxer. When audio is one of its inputs,
        // even a brief USB mic stall (ALSA underrun, USB clock drift) causes it
        // to freeze video output while waiting for the next audio timestamp to
        // align — producing pixelation. With a single video-only input, mpegtsmux
        // never has to wait for anything and video flows without interruption.
        //
        // A/V sync is maintained by:
        //   1. Deferred ffmpeg spawn: ALSA starts the instant GStreamer's first
        //      video chunk arrives, so both streams begin at ~t=0.
        //   2. aresample=async=1000: ffmpeg continuously resamples audio to
        //      match video timestamps, correcting USB clock drift on an ongoing
        //      basis without any accumulated offset.
        console.log(`🎤 Audio via ffmpeg ALSA (hybrid mode — video-only GStreamer mux)`);

        pipeline.push(
          "fdsink",
          "fd=1",      // stdout — video-only MPEG-TS piped to ffmpeg by Node.js
          "sync=false",
          "async=false",
        );
      } else {
        // No audio — GStreamer handles SRT directly (known stable path)
        pipeline.push(
          "srtsink",
          "uri=srt://:8891",
          "wait-for-connection=false",
          "latency=500",
          "sync=false",
          "async=false",
        );
      }
    } else if (protocol === "rtmp") {
      const rtmpUrl =
        destination && destination.trim() !== ""
          ? destination
          : "rtmp://localhost:1935/stream";

      console.log(`📡 RTMP destination: ${rtmpUrl}`);

      if (this.streamConfig.audioEnabled) {
        // ── RTMP hybrid mode ──────────────────────────────────────────────────
        // GStreamer outputs VIDEO-ONLY MPEG-TS to stdout (fdsink fd=1).
        // ffmpeg (spawned by Node.js) captures ALSA audio and muxes it with the
        // video before pushing the FLV stream to the RTMP server.
        //
        // This is identical in principle to the SRT hybrid path and fixes the
        // exact same root cause: the USB mic oscillator runs ~0.12% faster than
        // the system clock. In GStreamer's flvmux path that drift accumulates
        // over hours (causing the 1-hour delay). ffmpeg's wall-clock timestamps
        // on both inputs anchors them to the same reference so no accumulation
        // is possible, and aresample=async=1000 corrects residual jitter.
        console.log(`🎤 Audio via ffmpeg ALSA (RTMP hybrid mode — video-only GStreamer mux)`);

        pipeline.push(
          "t2.", "!",
          "queue",
          "max-size-buffers=0",
          "max-size-time=500000000", // 500 ms — matches SRT hybrid; mpegtsmux is video-only so leaky is safe
          "max-size-bytes=0",
          "leaky=downstream",        // leaky is fine with a single-stream mux (no A/V wait)
          "!",
          "mpegtsmux",
          "name=mux",
          "alignment=7",             // Align TS packets for clean handoff to ffmpeg
          "!",
          "fdsink",
          "fd=1",                    // stdout — video-only MPEG-TS piped to ffmpeg by Node.js
          "sync=false",
          "async=false",
        );
        // No GStreamer audio branch — ffmpeg handles ALSA capture and muxing
      } else {
        // ── RTMP no-audio mode ────────────────────────────────────────────────
        // No USB clock drift to worry about (no audio clock). GStreamer handles
        // RTMP directly via flvmux. Note: do NOT add a second h264parse here —
        // the upstream h264parse config-interval=-1 negotiates stream-format=avc,
        // alignment=au directly with flvmux through the queue. A second parse
        // re-splits SPS+PPS+IDR into buffers with identical DTS values, causing
        // MediaMTX to drop readers with "DTS not monotonically increasing".
        pipeline.push(
          "t2.", "!",
          "queue",
          "max-size-buffers=0",
          "max-size-time=2000000000", // 2 s — absorbs encoding spikes without audio latency concern
          "max-size-bytes=0",
          // No leaky — dropping encoded H264 frames causes DTS duplicates/gaps in flvmux
          "!",
          "video/x-h264,stream-format=avc,alignment=au",
          "!",
          "flvmux",
          "name=mux",
          "streamable=true",
          "!",
          "rtmpsink",
          `location=${rtmpUrl}`,
          "sync=false",
        );
      }
    } else {
      throw new Error(`Unsupported protocol: ${protocol}`);
    }

    // Branch 2b: Preview stream (MJPEG over TCP) - from t (raw video before encoding)
    // This taps the raw video BEFORE H.264 encoding, so no decoding needed!
    // Much more efficient and reliable than decoding H.264
    pipeline.push(
      "t.",
      "!",
      "queue",
      "max-size-buffers=10",
      "leaky=downstream",
      "!",
      "videorate", // Limit preview framerate to reduce CPU/bandwidth usage
      "!",
      "video/x-raw,framerate=2/1", // 2fps is sufficient for web preview
      "!",
      "videoconvert", // Convert from NV12 (or other) to format suitable for videoscale/jpegenc
      "!",
      "videoscale", // Scale down for lower bandwidth
      "!",
      "video/x-raw,width=1280,height=720", // 720p preview (lower bandwidth)
      "!",
      "jpegenc",
      "quality=65", // Lower quality to reduce preview bandwidth
      "!",
      "multipartmux",
      "boundary=--jpgboundary",
      "!",
      "tcpserversink",
      "host=0.0.0.0",
      "port=8555",
      "sync=false",
      "recover-policy=keyframe",
    );

    // TODO: Compositor integration will be added in a future update
    // For now, graphics overlay is disabled in the pipeline

    return pipeline;
  }

  /**
   * Convert color name to GStreamer integer format
   * GStreamer uses 0xAARRGGBB format
   */
  _colorToInt(colorName) {
    const colors = {
      white: "0xFFFFFFFF",
      black: "0xFF000000",
      red: "0xFFFF0000",
      green: "0xFF00FF00",
      blue: "0xFF0000FF",
      yellow: "0xFFFFFF00",
      cyan: "0xFF00FFFF",
      magenta: "0xFFFF00FF",
    };
    return colors[colorName.toLowerCase()] || colors.white;
  }

  /**
   * Get local IP address for display purposes
   */
  _getLocalIP() {
    const os = require("os");
    const interfaces = os.networkInterfaces();

    // Find first non-internal IPv4 address
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === "IPv4" && !iface.internal) {
          return iface.address;
        }
      }
    }
    return "localhost";
  }

  /**
   * Update overlay text dynamically (requires stream restart)
   */
  updateOverlay(overlayConfig) {
    this.streamConfig = { ...this.streamConfig, ...overlayConfig };
    this.saveConfig(); // Save to file
    return {
      success: true,
      message: "Overlay updated and saved. Restart stream to apply changes.",
      config: this.streamConfig,
    };
  }

  /**
   * Test if GStreamer and required plugins are available
   */
  static async testGStreamer() {
    return new Promise((resolve) => {
      // Try mpph264enc first (Rockchip MPP hardware encoder, Orange Pi 5 / RK3588)
      const test = spawn("gst-inspect-1.0", ["mpph264enc"]);
      let output = "";

      test.stdout.on("data", (data) => {
        output += data.toString();
      });

      test.on("close", (code) => {
        if (code === 0) {
          resolve({
            success: true,
            encoder: "mpph264enc",
            message: "Rockchip MPP hardware encoder available",
          });
        } else {
          // Try x264enc (software fallback)
          const testX264 = spawn("gst-inspect-1.0", ["x264enc"]);
          testX264.on("close", (x264Code) => {
            if (x264Code === 0) {
              resolve({
                success: true,
                encoder: "x264enc",
                message: "x264 software encoder available",
              });
            } else {
              // Try nvv4l2h264enc (Jetson)
              const testNv = spawn("gst-inspect-1.0", ["nvv4l2h264enc"]);
              testNv.on("close", (nvCode) => {
                if (nvCode === 0) {
                  resolve({
                    success: true,
                    encoder: "nvv4l2h264enc",
                    message: "NVIDIA hardware encoder available",
                  });
                } else {
                  resolve({
                    success: false,
                    error: "No encoder found (tried mpph264enc, x264enc, nvv4l2h264enc)",
                  });
                }
              });
            }
          });
        }
      });
    });
  }
}

module.exports = StreamController;
