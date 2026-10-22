# Audio: staying in sync, and leaving the music out

Two things this device does to the sound, both of which used to be somebody's
problem and are now nobody's.

## A/V sync, without a number

Until now the web UI had an **A/V Offset (ms)** box, and every venue dialled in
its own value — usually between −80 and −150 ms. That number was never about
the microphone or the camera. It was an artifact of how the stream is put
together.

With a USB camera, the pipeline is split in two: GStreamer encodes video and
writes MPEG-TS to a pipe, and a separate ffmpeg captures ALSA audio and muxes
the two (`streamController.js`, the `useFfmpegAudio` path). ffmpeg used to
stamp the video pipe with `-use_wallclock_as_timestamps 1`, which takes the
time **at the moment the read returns** — after capture, encode, mux and pipe
transit. The audio carried the sound card's own capture time. The two streams
were measured from different instants, and the difference is exactly what a
venue was typing in.

So the fix is to measure time in one place:

1. **Video frames carry the time they were captured.** A probe on `v4l2src`
   watches how far behind the clock each frame's timestamp arrives, takes the
   smallest delay in the first few seconds as the genuine capture latency, and
   corrects the branch once a second with `gst_pad_set_offset()`
   (`_CaptureClockAnchor` in `gst-overlay-pipeline.py`). The minimum is the
   honest measurement, because scheduling jitter can only make a frame look
   late. Correcting on a timer rather than rewriting every buffer keeps the
   per-frame cost at a read.

   This also kills the drift that forced the stamp-at-read in the first place:
   v4l2 timestamps come from `CLOCK_MONOTONIC`, which on the RK3588 runs
   ~764 µs/s slower than NTP-adjusted `CLOCK_REALTIME`, so the correction grows
   with the drift and absorbs it. That growth is the arithmetic, not a leak —
   764 µs/s is 22 s over an evening and 66 s over a day, and these boxes stream
   for days — so the ceiling on it is set where no real drift can reach it and
   the step limit (10 ms/s) is what actually guards against a jump.

   **It measures on the camera's own pad and corrects on the pad downstream of
   it.** Those must be different pads: whether a probe sees an offset set on
   the same pad is a GStreamer implementation detail, and if the measurement
   includes the correction the loop settles on *half* the drift and silently
   leaves the rest. Simulated against three days of RK3588-rate drift, the
   split version tracks it to within ~5 ms; the same-pad version stops at half.
   If there is no downstream pad to correct on, the anchor reports drift and
   corrects nothing rather than correcting half of it.

2. **The two halves are told where the timeline starts.** The pipeline prints
   `AVSYNC_FIRST_FRAME_EPOCH_NS` — the wall-clock instant the muxer's first
   frame was captured — and `streamController` reads the PTS that same frame
   was written with out of the first video PES packet (`tsTimestamps.js`).
   Their difference converts any wall-clock instant into a position on the
   MPEG-TS timeline, which is what the ALSA input needs, since its timestamps
   are capture times in that same clock. ffmpeg then gets `-copyts` on both
   inputs and one `-itsoffset` on the audio, derived entirely from those two
   measurements.

   Measured **at the muxer** on purpose: if anything upstream dropped a frame,
   that is still the frame which produced the first packet.

Nothing here is a setting. If either half cannot be established — a stream
that is not MPEG-TS, a pipeline that never announced itself — the code logs
`alignment unavailable` and falls back to the old stamp-at-read behaviour, and
the stream is no worse off than it was before.

### Checking it on a box

```bash
journalctl -u digitalpool-camera -f | grep -E 'A/V sync|avsync|Drift check'
```

- `A/V sync — capture latency baseline 23.4 ms` — the measured capture latency.
  Tens of milliseconds is normal; hundreds means the camera is delivering late.
- `A/V sync (SRT) — audio placed on the video's capture timeline (shift …)` —
  the alignment was established. The shift is a large negative number (it maps
  epoch seconds onto a stream timeline), which is expected.
- `avsync=corrected +0.8ms (latency 23ms, now 24ms)` in the once-a-minute
  drift line — how much drift has been absorbed so far. It should grow slowly
  and steadily (sub-millisecond per second), never jump. `avsync=measured`
  instead of `corrected` means the anchor found nothing downstream to correct
  on and is only reporting.

`AVSYNC_LEGACY=1` in the environment restores the old behaviour on both sides
at once, as a way back if a box misbehaves.

### Measuring it, rather than trusting it

`tools/avsync-check.js` turns "it should line up" into a number. Record a few
seconds off the live stream while somebody claps in front of the camera two or
three times, irregularly, and measure the file:

```bash
ffmpeg -rtsp_transport tcp -i rtsp://localhost:8554/live1 -t 15 -c copy /tmp/sync.mkv
node tools/avsync-check.js /tmp/sync.mkv
```

It reads the picture's frame-to-frame change and the sound's onsets — both out
of **one** ffmpeg run, as timestamped filter metadata — and cross-correlates
them. One run matters: decoding the two streams separately makes ffmpeg rebase
each to its own first packet, which silently discards the very offset being
measured. An earlier version of this tool did exactly that and read a file with
a known 120 ms error as perfectly in sync.

Validated against fixtures with offsets injected on purpose:

| injected | measured |
|---|---|
| 0 ms | −6 ms |
| audio +120 ms | +124 ms |
| audio −120 ms | −126 ms |
| nothing sharp to match | refuses to answer (0.0σ) |

So it is good to about ±10 ms, which is the floor of the method: a clap becomes
visible only on the next frame, 33 ms wide at 30 fps. That is far below what
anyone can see, and far below the 80–150 ms this work removes. The confidence
figure is the peak's height above every other lag; under 4σ means there was
nothing sharp enough in the recording and the number should not be believed.

### What this does not fix

The camera's sensor-to-USB delay and the microphone's own path are not
measurable from here; what is corrected is every pipeline stage after capture.
If a specific camera turns out to have a large fixed sensor delay, that will
show up as a residual on every box with that model — the way to find out is a
clapperboard test, not a slider.

## Leaving the background music out

Pool halls play music, and a stream carrying it clearly gets flagged by
Facebook's and YouTube's content matching. `audio/dp_percussive.c` keeps the
room's sudden sounds — balls, cue tips, pockets, voices starting — and removes
what is sustained, which is what music is made of and what recognition matches
on.

It is a port of the filter the DigitalPool mobile app records with
(`digitalpool-app`, `PercussiveFilter.kt` and its iOS twin), down to the frame
sizes and the makeup gain: a venue streaming from a phone and from a camera in
the same room should not sound like two different places. Harmonic/percussive
separation, as a stream — 2048-sample frames every 512, each pitch kept by its
share of being sudden (the median across pitch) against sustained (the median
across ~0.2 s).

Measured on synthetic material at 48 kHz: sustained tones come out **40 dB
down**, ball strikes come out **6 dB up** (the makeup gain), for 45 dB of
separation. At `strength 0` it is a bit-exact passthrough. On six seconds of
real room tone from a venue box, with nothing happening: steady content down
4.9 dB, transient peaks up 2.8 dB.

### Where it runs

It installs as a **LADSPA plugin**, because that is the one plugin format both
media stacks on this device already load:

| path | audio comes from | who filters |
|---|---|---|
| USB camera | ALSA, captured by ffmpeg | ffmpeg, `-af ladspa=f=dp_percussive` |
| NDI / RTSP / RTMP source | embedded in the source | GStreamer, as an element in the audio branch |

One copy of the DSP, both pipelines, and — importantly — the sound card's own
capture timestamps are left alone. The obvious alternative, a helper process
between ALSA and ffmpeg, would replace them with wall-clock reads and
reintroduce the jitter `streamController.js` documents at length.

`migrations/0020-audio-music-filter.sh` installs it: a prebuilt
`vendor/ladspa/<arch>/dp_percussive.so` if one has been committed (build with
`audio/build-ladspa.sh`), otherwise it compiles the two source files in place,
which takes about a second.

### Its 128 ms, and why nobody sees it

Deciding what is sustained needs the frames *after* a frame, so sound comes out
6144 samples (128 ms at 48 kHz) late. That is exactly known, so it is corrected
where it happens rather than left to be noticed as lip-sync error: the ffmpeg
path folds it into the A/V alignment above (`_avsyncAlignment()` subtracts it),
and the GStreamer path takes it off the filter's own src pad with
`set_offset()`.

### Two things to know

- **Filtered audio is mono.** ffmpeg instantiates a LADSPA plugin per channel,
  so stereo runs the whole separation twice: measured on an N97, 12% of a core
  against 6% for one channel. The stream is therefore folded to mono whenever
  the filter is on — a pool hall mic is not a stereo recording, and the image
  is worth less than the CPU on a box that already runs at its thermal limit.
  Turning the filter off restores stereo. GStreamer's path has no choice in it
  anyway: its LADSPA element is whatever the plugin is, and this one is mono.
- **Loud strikes can clip.** The makeup gain is a fixed ×2 and the result is
  hard-limited at full scale, exactly as the mobile filter does it. In testing
  that clipped 9 samples in 384,000 on hot material. Keeping the two
  implementations identical is worth more than smoothing it here; if it ever
  becomes audible, change both.

### Turning it off

Per camera, in the stream settings: **Remove background music**, with a
strength slider. Off, or `0%`, leaves the filter out of the chain entirely
rather than running it as an expensive passthrough. Either way the change takes
effect when the stream next starts — it is baked into the pipeline, like the
audio device and the resolution.
