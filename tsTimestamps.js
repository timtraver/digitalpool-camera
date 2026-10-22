// Reading the first video timestamp out of an MPEG-TS stream.
//
// This exists for one job: A/V sync in the hybrid streaming path, where
// GStreamer muxes video into MPEG-TS on a pipe and ffmpeg adds ALSA audio.
// The two halves measure time from different places — video from the camera's
// capture clock, audio from the sound card's — and ffmpeg can only line them up
// if it is told how the pipe's timeline relates to the wall clock.
//
// GStreamer announces the wall-clock instant its first muxed frame was captured
// (AVSYNC_FIRST_FRAME_EPOCH_NS). The missing half is what PTS that same frame
// was written with, which is only knowable by reading the bytes: muxers are
// free to start a timeline wherever they like, and mpegtsmux's choice is not
// something to hardcode a guess about. Those two numbers are the mapping.
//
// Deliberately minimal: no PAT/PMT walk, because the first PES packet carrying
// a video stream id is all this needs and parsing program tables to find the
// video PID would be more code to be wrong in.
const PACKET = 188;
const SYNC = 0x47;

/** Where the 188-byte packet grid starts, or -1 if this isn't TS yet. */
function findSync(buf) {
  for (let i = 0; i + PACKET * 2 < buf.length; i++) {
    if (buf[i] === SYNC && buf[i + PACKET] === SYNC && buf[i + PACKET * 2] === SYNC) return i;
  }
  return -1;
}

/** The 33-bit PTS in a PES header, in 90 kHz ticks, or null if it has none. */
function pesPts(payload) {
  if (payload.length < 14) return null;
  if (payload[0] !== 0x00 || payload[1] !== 0x00 || payload[2] !== 0x01) return null;
  const streamId = payload[3];
  // 0xE0-0xEF is "video stream 0-15" in the PES stream_id table; audio is 0xC0-0xDF.
  if (streamId < 0xe0 || streamId > 0xef) return null;
  if ((payload[7] & 0x80) === 0) return null;        // PTS_DTS_flags says no PTS
  const p = payload;
  // PTS is split across five bytes around marker bits: 3 + 15 + 15.
  const pts =
    ((p[9] >> 1) & 0x07) * 0x40000000 +
    ((p[10] << 22) >>> 0) +
    (((p[11] >> 1) & 0x7f) << 15) +
    (p[12] << 7) +
    (p[13] >> 1);
  return pts;
}

/**
 * The PTS of the first video frame in `buf`, in seconds.
 *
 * Returns null when the buffer does not yet hold a complete video PES header —
 * the caller accumulates more of the stream and asks again. A few hundred
 * kilobytes without an answer means this is not the stream we think it is.
 */
function firstVideoPtsSeconds(buf) {
  const start = findSync(buf);
  if (start < 0) return null;
  for (let i = start; i + PACKET <= buf.length; i += PACKET) {
    const pkt = buf.subarray(i, i + PACKET);
    if (pkt[0] !== SYNC) return null;                // lost the grid; resync next time
    if ((pkt[1] & 0x40) === 0) continue;             // not a payload-unit start
    const adaptation = (pkt[3] >> 4) & 0x03;
    if (adaptation === 0 || adaptation === 2) continue;  // no payload in this packet
    let offset = 4;
    if (adaptation === 3) offset += 1 + pkt[4];
    if (offset >= PACKET) continue;
    const pts = pesPts(pkt.subarray(offset));
    if (pts !== null) return pts / 90000;
  }
  return null;
}

module.exports = { firstVideoPtsSeconds, _internals: { findSync, pesPts } };
