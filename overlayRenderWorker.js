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

// ── Raw handoff ──────────────────────────────────────────────────────────────
// Encoding a 1920x1080 PNG costs ~142 ms on an N97, and the pipeline then spends
// more decoding it. Handing over the pixels as premultiplied BGRA — byte for
// byte what cairo used to produce from the PNG — costs ~38 ms end to end:
// 12 ms to read the surface, 21 ms to convert, 5 ms to write 8 MB into /dev/shm.
//
//   magic "DPOV" | version u8 | format u8 (1 = premultiplied BGRA)
//   | reserved u16 | width u32le | height u32le | pixels
const RAW_MAGIC = Buffer.from("DPOV", "ascii");
const RAW_HEADER = 16;

function rawHeader(width, height) {
  const head = Buffer.alloc(RAW_HEADER);
  RAW_MAGIC.copy(head, 0);
  head[4] = 1;                      // version
  head[5] = 1;                      // format: premultiplied BGRA
  head.writeUInt32LE(width, 8);
  head.writeUInt32LE(height, 12);
  return head;
}

/**
 * Canvas pixels are straight (non-premultiplied) RGBA; the overlay API wants
 * premultiplied BGRA. Done in place into a fresh buffer rather than with a
 * typed-array trick because the byte swap and the multiply have to happen
 * together anyway.
 */
function toPremultipliedBGRA(src) {
  const out = Buffer.allocUnsafe(src.length);
  for (let i = 0; i < src.length; i += 4) {
    const a = src[i + 3];
    if (a === 255) {
      out[i] = src[i + 2]; out[i + 1] = src[i + 1]; out[i + 2] = src[i]; out[i + 3] = 255;
    } else if (a === 0) {
      out[i] = 0; out[i + 1] = 0; out[i + 2] = 0; out[i + 3] = 0;
    } else {
      out[i]     = ((src[i + 2] * a + 127) / 255) | 0;
      out[i + 1] = ((src[i + 1] * a + 127) / 255) | 0;
      out[i + 2] = ((src[i]     * a + 127) / 255) | 0;
      out[i + 3] = a;
    }
  }
  return out;
}

/** Write through a temp file and rename so a reader never sees a torn file. */
function writeAtomic(dest, parts) {
  const tmp = `${dest}.tmp`;
  fs.writeFileSync(tmp, parts.length === 1 ? parts[0] : Buffer.concat(parts));
  fs.renameSync(tmp, dest);
}

/**
 * Whether a pipeline is currently consuming the raw file. It touches a claim
 * file while it does, so a PNG only has to be produced when nothing is reading
 * raw — which in practice means while idle, where the idle preview needs a real
 * PNG for gdkpixbufoverlay and the CPU is free anyway.
 */
function rawIsClaimed(pngPath) {
  try {
    const age = Date.now() - fs.statSync(`${pngPath}.rawclaim`).mtimeMs;
    return age < 10000;
  } catch {
    return false;
  }
}

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

  const width = surface.width;
  const height = surface.height;
  const ctx = surface.getContext("2d");
  const pixels = toPremultipliedBGRA(Buffer.from(ctx.getImageData(0, 0, width, height).data.buffer));
  writeAtomic(`${msg.pngPath}.bgra`, [rawHeader(width, height), pixels]);
  let bytes = RAW_HEADER + pixels.length;

  // The PNG is still what the idle preview reads, so keep producing one whenever
  // no pipeline has claimed the raw file.
  if (!rawIsClaimed(msg.pngPath)) {
    const png = await surface.encode("png");
    writeAtomic(msg.pngPath, [png]);
    bytes = png.length;
  }

  parentPort.postMessage({ type: "rendered", id: msg.id, ms: Date.now() - started, bytes });
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
