// The background-music filter, from the app's side.
//
// The DSP is audio/dp_percussive.c, installed as a LADSPA plugin by
// migrations/0020-audio-music-filter.sh. This module is only the part the
// Node process needs: is it there, what does ffmpeg have to be told to use it,
// and how much later does sound come out the other end.
//
// It is never required. A box where the plugin failed to install streams
// unfiltered audio and says so once in the log — the alternative, refusing to
// stream because a filter is missing, would be a worse trade for a venue.
const fs = require("fs");
const { execFile } = require("child_process");

// Where the migration puts it, and where both hosts look. LADSPA_PATH wins if
// the environment sets one, which is how a build can be tested without
// installing it system-wide.
const SEARCH_PATHS = (process.env.LADSPA_PATH || "/usr/lib/ladspa:/usr/local/lib/ladspa")
  .split(":")
  .filter(Boolean);

const PLUGIN_FILE = "dp_percussive.so";
const PLUGIN_LABEL = "dp_percussive";

// DP_PERCUSSIVE_LATENCY / 48000, from audio/dp_percussive.h: the filter has to
// hear TIME_RADIUS frames past a frame before it can say what in it was
// sustained, so sound comes out 6144 samples late. Keep this in step with the
// header — streamController folds it into the A/V alignment, so a wrong value
// here is lip-sync error, not a missing filter.
const LATENCY_SEC = 6144 / 48000;

let _cachedPath;
let _verified = null;      // null = not checked yet, true/false = ffmpeg's answer
let _verifying = null;     // in-flight check, so two cameras starting together ask once
let _verifyReason = "";

/** Full path to the installed plugin, or null. Cached after the first look. */
function pluginPath() {
  if (_cachedPath !== undefined) return _cachedPath;
  _cachedPath = null;
  for (const dir of SEARCH_PATHS) {
    const candidate = `${dir}/${PLUGIN_FILE}`;
    try {
      if (fs.existsSync(candidate)) { _cachedPath = candidate; break; }
    } catch (e) { /* unreadable directory is just a miss */ }
  }
  return _cachedPath;
}

function available() {
  return pluginPath() !== null;
}

/**
 * Prove that THIS ffmpeg can load the plugin, by asking it to.
 *
 * The file being on disk is not enough: ffmpeg only has the `ladspa` filter if
 * it was built with --enable-ladspa, and an `-af ladspa=…` it cannot parse
 * makes it exit immediately — which in the hybrid path means no stream at all,
 * for a feature that is supposed to be a nicety. So the filter is never put on
 * a live command line until a throwaway one has run with it.
 *
 * Costs a tenth of a second, once per process. Cached, including the failure.
 */
function verify() {
  if (_verified !== null) return Promise.resolve(_verified);
  if (_verifying) return _verifying;
  if (!available()) {
    _verified = false;
    _verifyReason = "plugin not installed";
    return Promise.resolve(false);
  }
  _verifying = new Promise((resolve) => {
    const args = [
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono",
      "-af", `ladspa=f=${pluginPath()}:p=${PLUGIN_LABEL}`,
      "-t", "0.1", "-f", "null", "-",
    ];
    execFile("ffmpeg", args, { timeout: 10000 }, (err, _stdout, stderr) => {
      _verified = !err;
      _verifyReason = err ? String(stderr || err.message).trim().split("\n").pop() : "";
      if (!_verified) {
        console.log(`⚠️  Background-music filter unusable by ffmpeg: ${_verifyReason}`);
      }
      _verifying = null;
      resolve(_verified);
    });
  });
  return _verifying;
}

/**
 * The ffmpeg -af entry, or null when the filter is off or not installed.
 *
 * `strength` is the dry/wet mix the UI sets: 1 is the full separation, 0 is
 * the room as it is. At 0 the filter is left out of the chain entirely rather
 * than run as an expensive passthrough.
 */
function ffmpegFilter(enabled, strength = 1) {
  // _verified === null means verify() was never awaited; treat that as "do not
  // risk it" rather than assuming the host can load the plugin.
  if (!enabled || _verified !== true) return null;
  const mix = Math.max(0, Math.min(1, Number(strength)));
  if (mix === 0) return null;
  // f= is the plugin, p= its label inside that file, c0 the Strength port.
  //
  // The FULL PATH, not the name: ffmpeg appends ".so" itself and rejects a
  // name that already has it ("Failed to load 'dp_percussive.so'"), and an
  // absolute path also means the answer does not depend on LADSPA_PATH being
  // set the same way for the app as it was when this was verified.
  return `ladspa=f=${pluginPath()}:p=${PLUGIN_LABEL}:c=c0=${mix.toFixed(3)}`;
}

/** One line for the log, so which of the three states a box is in is obvious. */
function describe(enabled, strength = 1) {
  if (!enabled) return "background-music filter off";
  if (_verified !== true) {
    return `background-music filter ON but unusable (${_verifyReason || "not checked"}) — audio unfiltered`;
  }
  return `background-music filter on (strength ${Math.round(strength * 100)}%, mono, ` +
         `+${Math.round(LATENCY_SEC * 1000)} ms, compensated)`;
}

module.exports = { available, verify, pluginPath, ffmpegFilter, describe, LATENCY_SEC, PLUGIN_FILE, PLUGIN_LABEL };
