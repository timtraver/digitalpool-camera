/*
 * dp_percussive — keep the room, lose the music.
 *
 * Pool halls play music, and a stream that carries it clearly gets flagged by
 * Facebook and YouTube content matching. This keeps what is SUDDEN — balls,
 * cue tips, pockets, voices starting — and takes out what is SUSTAINED, which
 * is what music is made of and what music recognition matches on.
 *
 * Harmonic/percussive separation, as a stream. The sound is cut into
 * overlapping frames (2048 samples, a new one every 512); in each frame every
 * pitch is compared with the same pitch in the frames around it (sustained:
 * the median across time) and with the pitches around it in that frame
 * (sudden: the median across pitch). Each pitch keeps its share of being
 * sudden. Fitzgerald's median-filter separation, with the usual Wiener-style
 * soft mask.
 *
 * This is a port of the filter the DigitalPool mobile app records with
 * (digitalpool-app, modules/match-camera/.../PercussiveFilter.kt and its iOS
 * twin). KEEP THE NUMBERS IN STEP WITH THOSE: they were tuned on a recording
 * made in a hall, and a venue streaming from a phone and from a camera in the
 * same room should not sound like two different places.
 *
 * Deciding what is sustained needs the frames after a frame as well as the
 * ones before it, so sound comes out DP_PERCUSSIVE_LATENCY samples late. The
 * caller is expected to account for that — on the camera appliance the stream
 * controller folds it into the A/V alignment, so it never reaches a viewer as
 * lip-sync error.
 */
#ifndef DP_PERCUSSIVE_H
#define DP_PERCUSSIVE_H

#include <stddef.h>

#define DP_PERCUSSIVE_FRAME_SIZE   2048
#define DP_PERCUSSIVE_HOP           512
/* Frames either side of a frame that say what is sustained there (~0.2 s in all) */
#define DP_PERCUSSIVE_TIME_RADIUS     8
/* Pitches either side of a pitch that say what is sudden there (~800 Hz in all) */
#define DP_PERCUSSIVE_PITCH_RADIUS    8
/* Taking the music out leaves the sound about 9 dB quieter; this brings it back */
#define DP_PERCUSSIVE_MAKEUP_GAIN  2.0f

#define DP_PERCUSSIVE_BINS    (DP_PERCUSSIVE_FRAME_SIZE / 2 + 1)
#define DP_PERCUSSIVE_HISTORY (2 * DP_PERCUSSIVE_TIME_RADIUS + 1)
/* How late the sound comes out: the frames ahead it waits for, and the frame itself */
#define DP_PERCUSSIVE_LATENCY \
  (DP_PERCUSSIVE_TIME_RADIUS * DP_PERCUSSIVE_HOP + DP_PERCUSSIVE_FRAME_SIZE)

#define DP_PERCUSSIVE_OUTPUT_RING \
  ((DP_PERCUSSIVE_TIME_RADIUS + 1) * DP_PERCUSSIVE_HOP + 2 * DP_PERCUSSIVE_FRAME_SIZE)

typedef struct {
  float window[DP_PERCUSSIVE_FRAME_SIZE];
  float cos_table[DP_PERCUSSIVE_FRAME_SIZE / 2];
  float sin_table[DP_PERCUSSIVE_FRAME_SIZE / 2];
  float overlap_gain;

  /* The last FRAME_SIZE samples heard, as a ring; input_index is the oldest */
  float input[DP_PERCUSSIVE_FRAME_SIZE];
  int   input_index;
  int   since_frame;

  /* The last HISTORY frames' spectra and magnitudes */
  float history_real[DP_PERCUSSIVE_HISTORY][DP_PERCUSSIVE_BINS];
  float history_imag[DP_PERCUSSIVE_HISTORY][DP_PERCUSSIVE_BINS];
  float history_mag[DP_PERCUSSIVE_HISTORY][DP_PERCUSSIVE_BINS];
  int   history_count;
  int   history_next;

  float overlap[DP_PERCUSSIVE_FRAME_SIZE];

  /* Processed sound waiting to go out, as a ring */
  float output[DP_PERCUSSIVE_OUTPUT_RING];
  int   output_read;
  int   output_write;

  /* The input again, delayed by exactly the filter's latency, so that mixing
   * some of it back in (strength < 1) lines the two copies up instead of
   * comb-filtering them against each other. */
  float dry[DP_PERCUSSIVE_LATENCY + 1];
  int   dry_write;

  /* Scratch, so nothing is allocated while sound is flowing */
  float re[DP_PERCUSSIVE_FRAME_SIZE];
  float im[DP_PERCUSSIVE_FRAME_SIZE];
  float sustained[DP_PERCUSSIVE_BINS];
  float sudden[DP_PERCUSSIVE_BINS];
  float sort_scratch[DP_PERCUSSIVE_HISTORY > (2 * DP_PERCUSSIVE_PITCH_RADIUS + 1)
                     ? DP_PERCUSSIVE_HISTORY : (2 * DP_PERCUSSIVE_PITCH_RADIUS + 1)];
} dp_percussive;

/** Prepare a filter. Call before the first process(); allocates nothing. */
void dp_percussive_init(dp_percussive *f);

/**
 * Filter `count` samples, one out per one in, late by DP_PERCUSSIVE_LATENCY.
 *
 * `strength` mixes the result against the (equally delayed) original: 1 is the
 * full separation, 0 passes the sound through untouched. `in` and `out` may be
 * the same buffer.
 */
void dp_percussive_process(dp_percussive *f, const float *in, float *out,
                           size_t count, float strength);

#endif /* DP_PERCUSSIVE_H */
