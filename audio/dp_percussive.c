#include "dp_percussive.h"

#include <math.h>
#include <string.h>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

void dp_percussive_init(dp_percussive *f) {
  memset(f, 0, sizeof(*f));
  float window_power = 0.0f;
  for (int i = 0; i < DP_PERCUSSIVE_FRAME_SIZE; i++) {
    f->window[i] = (float)(0.5 - 0.5 * cos(2.0 * M_PI * i / DP_PERCUSSIVE_FRAME_SIZE));
    window_power += f->window[i] * f->window[i];
  }
  /* Overlap-add of Hann-windowed frames at 75% overlap sums to this; dividing
   * by it restores the level. */
  f->overlap_gain = window_power / DP_PERCUSSIVE_HOP;
  for (int i = 0; i < DP_PERCUSSIVE_FRAME_SIZE / 2; i++) {
    f->cos_table[i] = (float)cos(2.0 * M_PI * i / DP_PERCUSSIVE_FRAME_SIZE);
    f->sin_table[i] = (float)sin(2.0 * M_PI * i / DP_PERCUSSIVE_FRAME_SIZE);
  }
  /* Sound waits in the output ring until the first frame has been processed,
   * which is what makes the filter's latency exactly DP_PERCUSSIVE_LATENCY. */
  f->output_write = (DP_PERCUSSIVE_TIME_RADIUS + 1) * DP_PERCUSSIVE_HOP;
}

/* In-place radix-2 FFT of re/im (unscaled; the inverse is divided by the size
 * by the caller). */
static void dp_fft(dp_percussive *f, int inverse) {
  const int n = DP_PERCUSSIVE_FRAME_SIZE;
  int j = 0;
  for (int i = 1; i < n; i++) {
    int bit = n >> 1;
    while (j & bit) {
      j ^= bit;
      bit >>= 1;
    }
    j ^= bit;
    if (i < j) {
      float t = f->re[i]; f->re[i] = f->re[j]; f->re[j] = t;
      t = f->im[i]; f->im[i] = f->im[j]; f->im[j] = t;
    }
  }
  const float sign = inverse ? 1.0f : -1.0f;
  for (int length = 2; length <= n; length <<= 1) {
    const int step = n / length;
    for (int start = 0; start < n; start += length) {
      for (int k = 0; k < length / 2; k++) {
        const float wr = f->cos_table[k * step];
        const float wi = sign * f->sin_table[k * step];
        const int a = start + k;
        const int b = a + length / 2;
        const float tr = f->re[b] * wr - f->im[b] * wi;
        const float ti = f->re[b] * wi + f->im[b] * wr;
        f->re[b] = f->re[a] - tr;
        f->im[b] = f->im[a] - ti;
        f->re[a] += tr;
        f->im[a] += ti;
      }
    }
  }
}

/* The median of the first `count` values of sort_scratch. Insertion sort:
 * never more than 17 values, and nearly sorted between frames. */
static float dp_median(dp_percussive *f, int count) {
  for (int i = 1; i < count; i++) {
    const float value = f->sort_scratch[i];
    int j = i - 1;
    while (j >= 0 && f->sort_scratch[j] > value) {
      f->sort_scratch[j + 1] = f->sort_scratch[j];
      j--;
    }
    f->sort_scratch[j + 1] = value;
  }
  if (count % 2 == 1) return f->sort_scratch[count / 2];
  return 0.5f * (f->sort_scratch[count / 2 - 1] + f->sort_scratch[count / 2]);
}

static void dp_process_frame(dp_percussive *f) {
  /* The latest frame, windowed, into the history */
  for (int i = 0; i < DP_PERCUSSIVE_FRAME_SIZE; i++) {
    f->re[i] = f->input[(f->input_index + i) % DP_PERCUSSIVE_FRAME_SIZE] * f->window[i];
    f->im[i] = 0.0f;
  }
  dp_fft(f, 0);
  const int slot = f->history_next;
  f->history_next = (f->history_next + 1) % DP_PERCUSSIVE_HISTORY;
  if (f->history_count < DP_PERCUSSIVE_HISTORY) f->history_count++;
  for (int k = 0; k < DP_PERCUSSIVE_BINS; k++) {
    f->history_real[slot][k] = f->re[k];
    f->history_imag[slot][k] = f->im[k];
    f->history_mag[slot][k] = sqrtf(f->re[k] * f->re[k] + f->im[k] * f->im[k]);
  }

  /* The frame to process now is the one TIME_RADIUS frames back: the frames
   * after it have arrived. */
  if (f->history_count <= DP_PERCUSSIVE_TIME_RADIUS) return;
  const int center =
      (slot - DP_PERCUSSIVE_TIME_RADIUS + DP_PERCUSSIVE_HISTORY) % DP_PERCUSSIVE_HISTORY;

  for (int bin = 0; bin < DP_PERCUSSIVE_BINS; bin++) {
    /* Sustained: this pitch's median across the frames around it. The ring is
     * read in storage order, which is the same SET of frames and therefore the
     * same median. */
    for (int k = 0; k < f->history_count; k++) f->sort_scratch[k] = f->history_mag[k][bin];
    f->sustained[bin] = dp_median(f, f->history_count);
    /* Sudden: the median across the pitches around this one, in this frame */
    int count = 0;
    for (int offset = -DP_PERCUSSIVE_PITCH_RADIUS; offset <= DP_PERCUSSIVE_PITCH_RADIUS; offset++) {
      int b = bin + offset;
      if (b < 0) b = 0;
      if (b > DP_PERCUSSIVE_BINS - 1) b = DP_PERCUSSIVE_BINS - 1;
      f->sort_scratch[count++] = f->history_mag[center][b];
    }
    f->sudden[bin] = dp_median(f, count);
  }

  /* The centre frame's spectrum, masked by each pitch's share of being sudden,
   * and mirrored so the inverse transform comes out real. */
  for (int k = 0; k < DP_PERCUSSIVE_BINS; k++) {
    const float s = f->sudden[k] * f->sudden[k];
    const float h = f->sustained[k] * f->sustained[k];
    const float mask = s / (s + h + 1e-12f);
    f->re[k] = f->history_real[center][k] * mask;
    f->im[k] = f->history_imag[center][k] * mask;
  }
  for (int k = 1; k < DP_PERCUSSIVE_FRAME_SIZE / 2; k++) {
    f->re[DP_PERCUSSIVE_FRAME_SIZE - k] = f->re[k];
    f->im[DP_PERCUSSIVE_FRAME_SIZE - k] = -f->im[k];
  }
  dp_fft(f, 1);

  /* Overlap-add, and the hop it finishes goes out */
  for (int i = 0; i < DP_PERCUSSIVE_FRAME_SIZE; i++) {
    f->overlap[i] += f->re[i] / DP_PERCUSSIVE_FRAME_SIZE * f->window[i] / f->overlap_gain;
  }
  for (int i = 0; i < DP_PERCUSSIVE_HOP; i++) {
    f->output[f->output_write] = f->overlap[i];
    f->output_write = (f->output_write + 1) % DP_PERCUSSIVE_OUTPUT_RING;
  }
  memmove(f->overlap, f->overlap + DP_PERCUSSIVE_HOP,
          (DP_PERCUSSIVE_FRAME_SIZE - DP_PERCUSSIVE_HOP) * sizeof(float));
  memset(f->overlap + DP_PERCUSSIVE_FRAME_SIZE - DP_PERCUSSIVE_HOP, 0,
         DP_PERCUSSIVE_HOP * sizeof(float));
}

void dp_percussive_process(dp_percussive *f, const float *in, float *out,
                           size_t count, float strength) {
  if (strength < 0.0f) strength = 0.0f;
  if (strength > 1.0f) strength = 1.0f;

  for (size_t n = 0; n < count; n++) {
    const float sample = in[n];

    f->input[f->input_index] = sample;
    f->input_index = (f->input_index + 1) % DP_PERCUSSIVE_FRAME_SIZE;
    if (++f->since_frame == DP_PERCUSSIVE_HOP) {
      f->since_frame = 0;
      dp_process_frame(f);
    }

    /* The original, held back by the same latency as the filtered copy. */
    const int dry_read = (f->dry_write + 1) % (DP_PERCUSSIVE_LATENCY + 1);
    const float dry = f->dry[dry_read];
    f->dry[f->dry_write] = sample;
    f->dry_write = dry_read;

    const float wet = f->output[f->output_read] * DP_PERCUSSIVE_MAKEUP_GAIN;
    f->output_read = (f->output_read + 1) % DP_PERCUSSIVE_OUTPUT_RING;

    float value = dry + strength * (wet - dry);
    if (value > 1.0f) value = 1.0f;
    if (value < -1.0f) value = -1.0f;
    out[n] = value;
  }
}
