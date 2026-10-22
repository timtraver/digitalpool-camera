#!/usr/bin/env node
// avsync-check — measure how far apart the audio and the picture really are.
//
// A/V sync on this device is structural: video frames carry the time they were
// captured and the audio is placed on that timeline (see AUDIO.md). Nothing is
// configured, so there is nothing to tune — but "it should line up" is not a
// measurement, and this turns it into one.
//
// Clap in front of the camera a few times, irregularly, while recording. The
// clap is seen as a jump in the picture and heard as a spike in the sound;
// this reads both out of the file and cross-correlates them.
//
//   # record a few seconds off the live stream, then measure it
//   ffmpeg -rtsp_transport tcp -i rtsp://localhost:8554/live1 -t 15 -c copy /tmp/sync.mkv
//   node tools/avsync-check.js /tmp/sync.mkv
//
// Result:
//   audio is LATE  — sound arrives after the picture (positive)
//   audio is EARLY — sound arrives before the picture (negative)
// Inside ±30 ms is imperceptible and is where this should land. ±100 ms or
// more means something is wrong.
//
// Both signals come from ONE ffmpeg run, as timestamped filter metadata, and
// that is not an implementation detail: decoding the two streams separately
// makes ffmpeg rebase each one to its own first packet, which silently throws
// away the very offset being measured. Validated against files with a known
// ±120 ms injected — an earlier version of this tool read those as in sync.
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const input = process.argv[2];
const seconds = parseFloat(process.argv[3] || "15");
if (!input) {
  console.error("usage: node tools/avsync-check.js <file|rtsp-url> [seconds]");
  process.exit(2);
}

const BIN_MS = 5;          // 240 samples at 48 kHz
const MAX_LAG_MS = 1000;

function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => { err += d.toString(); });
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err.slice(-900)))));
  });
}

/** Pull `pts_time` / value pairs out of ffmpeg's metadata=print output. */
function parseMetadata(file, key) {
  const text = fs.readFileSync(file, "utf8");
  const points = [];
  let pts = null;
  for (const line of text.split("\n")) {
    const header = line.match(/pts_time:\s*(-?[\d.]+)/);
    if (header) { pts = parseFloat(header[1]); continue; }
    const value = line.match(new RegExp(`${key}=\\s*(-?[\\d.eE+]+|-?inf|nan)`));
    if (value && pts !== null) {
      const v = parseFloat(value[1]);
      points.push({ t: pts, v: Number.isFinite(v) ? v : -120 });
      pts = null;
    }
  }
  return points;
}

/** Put irregularly-spaced points onto the common millisecond grid. */
function toBins(points, t0, t1) {
  const size = Math.max(1, Math.ceil(((t1 - t0) * 1000) / BIN_MS));
  const bins = new Array(size).fill(0);
  const filled = new Array(size).fill(false);
  for (const { t, v } of points) {
    const i = Math.floor(((t - t0) * 1000) / BIN_MS);
    if (i < 0 || i >= size) continue;
    bins[i] = filled[i] ? Math.max(bins[i], v) : v;
    filled[i] = true;
  }
  // Video points are sparser than the grid — one per frame against a bin every
  // 5 ms — so the gaps between them are held forward. Only the GAPS: a bin
  // that really measured zero has to stay zero, or one loud frame smears
  // forward over everything after it and the correlation peak dissolves into
  // a broad hump. (It did, until this told the two cases apart.)
  for (let i = 1; i < size; i++) {
    if (!filled[i]) { bins[i] = bins[i - 1]; filled[i] = true; }
  }
  return bins;
}

function normalise(bins) {
  const mean = bins.reduce((a, b) => a + b, 0) / (bins.length || 1);
  const sd = Math.sqrt(bins.reduce((a, b) => a + (b - mean) ** 2, 0) / (bins.length || 1)) || 1e-9;
  return bins.map((v) => (v - mean) / sd);
}

/**
 * Turn a level into an onset: what matters is the moment a sound STARTS, not
 * how loud it stays. The picture's signal is already a frame-to-frame
 * difference, so it is used as it is — differentiating it twice would smear
 * the edge being measured.
 */
function onsets(bins) {
  const out = new Array(bins.length).fill(0);
  for (let i = 1; i < bins.length; i++) out[i] = Math.max(0, bins[i] - bins[i - 1]);
  return normalise(out);
}

/**
 * Best lag, and how far it stands out from every other lag.
 *
 * The raw correlation is small even for a perfect match when the events are a
 * few claps in a long recording, so what says "this is the answer" is the peak
 * standing clear of the rest of the profile.
 */
function correlate(a, b, maxLagBins) {
  const scores = [];
  for (let lag = -maxLagBins; lag <= maxLagBins; lag++) {
    let sum = 0, n = 0;
    for (let i = 0; i < a.length; i++) {
      const j = i + lag;
      if (j < 0 || j >= b.length) continue;
      sum += a[i] * b[j];
      n++;
    }
    scores.push({ lag, score: n < 10 ? -Infinity : sum / n });
  }
  const valid = scores.filter((s) => Number.isFinite(s.score));
  if (!valid.length) return { lag: 0, prominence: 0 };
  const best = valid.reduce((m, s) => (s.score > m.score ? s : m), valid[0]);
  // Measure the peak against lags FAR from it. The lags either side of the
  // answer are correlated with it — a clap is tens of milliseconds wide, so
  // the peak is a hump, not a spike — and including its own shoulders in the
  // background inflates the spread and makes a perfect match look uncertain.
  const guardBins = Math.round(200 / BIN_MS);
  const background = valid.filter((s) => Math.abs(s.lag - best.lag) > guardBins);
  if (background.length < 10) return { lag: best.lag, prominence: 0 };
  const mean = background.reduce((t, s) => t + s.score, 0) / background.length;
  const sd = Math.sqrt(background.reduce((t, s) => t + (s.score - mean) ** 2, 0) / background.length) || 1e-9;
  return { lag: best.lag, prominence: (best.score - mean) / sd };
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "avsync-"));
  const vFile = path.join(dir, "video.txt");
  const aFile = path.join(dir, "audio.txt");

  console.log(`Reading ${seconds}s from ${input} …`);
  await ffmpeg([
    "-hide_banner", "-loglevel", "error",
    ...(input.startsWith("rtsp") ? ["-rtsp_transport", "tcp"] : []),
    "-t", String(seconds), "-i", input, "-copyts",
    "-filter_complex",
    // YDIF is signalstats' average absolute change from the previous frame —
    // a motion measure, which is what a hand entering the shot is.
    `[0:v]scale=64:36,signalstats,metadata=print:key=lavfi.signalstats.YDIF:file=${vFile}[v];` +
    // asetnsamples makes every audio "frame" one grid bin long, so the peak
    // levels come out at the resolution the correlation works at.
    `[0:a]aformat=channel_layouts=mono,asetnsamples=n=${(48000 * BIN_MS) / 1000}:p=0,` +
    `astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.Peak_level:file=${aFile}[a]`,
    "-map", "[v]", "-f", "null", "-",
    "-map", "[a]", "-f", "null", "-",
  ]);

  const videoPoints = parseMetadata(vFile, "lavfi\\.signalstats\\.YDIF");
  const audioDb = parseMetadata(aFile, "lavfi\\.astats\\.Overall\\.Peak_level");
  if (!videoPoints.length) throw new Error("no video frames measured");
  if (!audioDb.length) throw new Error("no audio measured");
  // Peak level is in dBFS; a linear amplitude is what an onset should be
  // measured on, or every quiet bin dominates the derivative.
  const audioPoints = audioDb.map(({ t, v }) => ({ t, v: Math.pow(10, Math.max(-120, v) / 20) }));

  // ONE timeline for both, taken from the timestamps themselves.
  const t0 = Math.min(videoPoints[0].t, audioPoints[0].t);
  const t1 = Math.max(videoPoints[videoPoints.length - 1].t, audioPoints[audioPoints.length - 1].t);
  const v = normalise(toBins(videoPoints, t0, t1));
  const a = onsets(toBins(audioPoints, t0, t1));

  const { lag, prominence } = correlate(v, a, Math.round(MAX_LAG_MS / BIN_MS));
  const fps = videoPoints.length / Math.max(1e-9, t1 - t0);
  // Both signals are sampled, and they are sampled differently, which biases
  // the raw lag by a knowable amount:
  //   • a clap becomes visible on the first frame AFTER it happens, so the
  //     picture's event is on average half a frame period late (17 ms at 30 fps);
  //   • the sound's event lands at the start of its 5 ms bin, so it reads
  //     half a bin early.
  // Both make the audio look earlier than it is. Measured on fixtures with a
  // known offset, the uncorrected numbers were out by a steady -25 ms and this
  // brings them to within a few milliseconds.
  const samplingBiasMs = 1000 / fps / 2 + BIN_MS / 2;
  const ms = Math.round(lag * BIN_MS + samplingBiasMs);

  console.log(`\n${videoPoints.length} frames at ${fps.toFixed(1)} fps, ${audioPoints.length} audio bins, ${(t1 - t0).toFixed(1)}s`);
  console.log(`peak at ${ms >= 0 ? "+" : ""}${ms} ms (±10 ms — this method's own floor), ` +
              `standing ${prominence.toFixed(1)}σ above the other lags`);
  if (prominence < 4) {
    console.log("\n⚠️  Weak peak — there may have been nothing sharp to match.");
    console.log("   Record again and clap two or three times, irregularly, in front of the lens.");
  }
  const verdict = Math.abs(ms) <= 30 ? "in sync (within a frame)"
    : ms > 0 ? `audio is LATE by ${ms} ms` : `audio is EARLY by ${-ms} ms`;
  console.log(`\n→ ${verdict}`);
  fs.rmSync(dir, { recursive: true, force: true });
})().catch((e) => { console.error(`failed: ${e.message}`); process.exit(1); });
