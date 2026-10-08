// Renders overlay frames on a worker thread.
//
// This exists for one reason: the render is synchronous from Node's point of
// view. Drawing is only ~17 ms, but encoding a 1920x1080 PNG takes ~115-175 ms
// on an N97 and does NOT yield — @napi-rs/canvas's encode() returns a promise,
// but the work happens before the promise resolves, so awaiting it still blocks
// the loop. Measured event-loop lag during a render cycle was 155 ms.
//
// On the main thread that stalls everything the app does for the duration,
// including the 1 Hz MediaMTX bitrate poll. That poll timestamps the response
// when it is processed, so a stall stretches one sample's interval and shortens
// the next — which shows up as a dip-then-spike in the "Total Out" graph every
// time the overlay redraws, even though the actual outbound stream is steady.
//
// The worker owns its own decoded-image cache: decoded images cannot cross the
// thread boundary, so the main thread ships raw bytes once per URL and the
// worker keeps the decoded result.
const { parentPort } = require("worker_threads");
const fs = require("fs");
const path = require("path");

const renderer = require("./overlayRenderer");

const images = new Map(); // url -> decoded Image (or null when it failed)
let fontsDir = null;

async function handleRender(msg) {
  if (fontsDir !== msg.fontsDir) {
    renderer.registerFonts(msg.fontsDir);
    fontsDir = msg.fontsDir;
  }

  // Decode any image the worker has not seen yet. Decoding is also synchronous
  // work, which is another reason it belongs here rather than on the main thread.
  for (const [url, bytes] of Object.entries(msg.newImages || {})) {
    if (images.has(url)) continue;
    try {
      images.set(url, await renderer.loadImage(Buffer.from(bytes)));
    } catch (err) {
      images.set(url, null);
      parentPort.postMessage({ type: "imageFailed", url, message: err.message });
    }
  }

  const started = Date.now();
  const surface = renderer.renderCanvas(msg.canvas, msg.binding, {
    images,
    now: msg.now,
    animationNow: msg.animationNow,
  });
  const buf = await surface.encode("png");

  // Write through a temporary file and rename: the pipeline watches this path's
  // mtime and re-reads the moment it changes, so a plain write would eventually
  // be caught half-finished.
  const tmp = `${msg.pngPath}.tmp`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, msg.pngPath);

  parentPort.postMessage({ type: "rendered", id: msg.id, ms: Date.now() - started, bytes: buf.length });
}

parentPort.on("message", (msg) => {
  if (msg.type === "render") {
    handleRender(msg).catch((err) =>
      parentPort.postMessage({ type: "error", id: msg.id, message: err.message })
    );
  } else if (msg.type === "forgetImages") {
    images.clear();
  }
});
