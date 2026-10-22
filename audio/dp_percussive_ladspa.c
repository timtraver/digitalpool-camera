/*
 * LADSPA wrapper around dp_percussive.
 *
 * LADSPA is the lowest common denominator the two media stacks on this device
 * both speak: ffmpeg loads it with `-af ladspa=` on the USB/ALSA path, and
 * GStreamer loads it as an element on the paths where audio arrives embedded
 * in an NDI or RTSP source. One copy of the DSP, both pipelines, and the
 * sound card's own capture timestamps are left alone — which matters, because
 * the alternative (filtering in a helper process between ALSA and ffmpeg)
 * would replace them with wall-clock reads and reintroduce the jitter
 * streamController.js documents at length.
 *
 * Mono by design: both hosts instantiate one copy per channel.
 */
#include <ladspa.h>
#include <stdlib.h>

#include "dp_percussive.h"

/* Unregistered ID. The official registry is for plugins published to the
 * world; this one only ever loads from /usr/lib/ladspa on our own appliances,
 * where nothing else claims this number. */
#define DP_PERCUSSIVE_UNIQUE_ID 9472

#define PORT_INPUT    0
#define PORT_OUTPUT   1
#define PORT_STRENGTH 2
#define PORT_COUNT    3

typedef struct {
  dp_percussive filter;
  LADSPA_Data *in;
  LADSPA_Data *out;
  LADSPA_Data *strength;
} dp_instance;

static LADSPA_Handle dp_instantiate(const LADSPA_Descriptor *descriptor, unsigned long sample_rate) {
  (void)descriptor;
  (void)sample_rate;   /* The frame sizes are fixed; hosts feed this 48 kHz. */
  dp_instance *self = (dp_instance *)calloc(1, sizeof(dp_instance));
  if (self) dp_percussive_init(&self->filter);
  return (LADSPA_Handle)self;
}

static void dp_connect_port(LADSPA_Handle handle, unsigned long port, LADSPA_Data *data) {
  dp_instance *self = (dp_instance *)handle;
  switch (port) {
    case PORT_INPUT:    self->in = data; break;
    case PORT_OUTPUT:   self->out = data; break;
    case PORT_STRENGTH: self->strength = data; break;
    default: break;
  }
}

/* Called when the host (re)starts the stream: forget the room we were in. */
static void dp_activate(LADSPA_Handle handle) {
  dp_percussive_init(&((dp_instance *)handle)->filter);
}

static void dp_run(LADSPA_Handle handle, unsigned long sample_count) {
  dp_instance *self = (dp_instance *)handle;
  if (!self->in || !self->out) return;
  const float strength = self->strength ? (float)*self->strength : 1.0f;
  dp_percussive_process(&self->filter, (const float *)self->in, (float *)self->out,
                        (size_t)sample_count, strength);
}

static void dp_cleanup(LADSPA_Handle handle) { free(handle); }

static LADSPA_Descriptor *dp_descriptor = NULL;
static LADSPA_PortDescriptor dp_port_descriptors[PORT_COUNT];
static LADSPA_PortRangeHint dp_port_hints[PORT_COUNT];
static const char *dp_port_names[PORT_COUNT];

/* GCC/Clang run this when the .so is loaded. */
static void __attribute__((constructor)) dp_init_descriptor(void) {
  dp_descriptor = (LADSPA_Descriptor *)calloc(1, sizeof(LADSPA_Descriptor));
  if (!dp_descriptor) return;

  dp_descriptor->UniqueID = DP_PERCUSSIVE_UNIQUE_ID;
  dp_descriptor->Label = "dp_percussive";
  dp_descriptor->Properties = LADSPA_PROPERTY_HARD_RT_CAPABLE;
  dp_descriptor->Name = "DigitalPool percussive separator (removes background music)";
  dp_descriptor->Maker = "DigitalPool";
  dp_descriptor->Copyright = "None";
  dp_descriptor->PortCount = PORT_COUNT;

  dp_port_descriptors[PORT_INPUT] = LADSPA_PORT_INPUT | LADSPA_PORT_AUDIO;
  dp_port_descriptors[PORT_OUTPUT] = LADSPA_PORT_OUTPUT | LADSPA_PORT_AUDIO;
  dp_port_descriptors[PORT_STRENGTH] = LADSPA_PORT_INPUT | LADSPA_PORT_CONTROL;
  dp_descriptor->PortDescriptors = dp_port_descriptors;

  dp_port_names[PORT_INPUT] = "Input";
  dp_port_names[PORT_OUTPUT] = "Output";
  dp_port_names[PORT_STRENGTH] = "Strength";
  dp_descriptor->PortNames = dp_port_names;

  dp_port_hints[PORT_INPUT].HintDescriptor = 0;
  dp_port_hints[PORT_OUTPUT].HintDescriptor = 0;
  dp_port_hints[PORT_STRENGTH].HintDescriptor =
      LADSPA_HINT_BOUNDED_BELOW | LADSPA_HINT_BOUNDED_ABOVE | LADSPA_HINT_DEFAULT_MAXIMUM;
  dp_port_hints[PORT_STRENGTH].LowerBound = 0.0f;
  dp_port_hints[PORT_STRENGTH].UpperBound = 1.0f;
  dp_descriptor->PortRangeHints = dp_port_hints;

  dp_descriptor->instantiate = dp_instantiate;
  dp_descriptor->connect_port = dp_connect_port;
  dp_descriptor->activate = dp_activate;
  dp_descriptor->run = dp_run;
  dp_descriptor->run_adding = NULL;
  dp_descriptor->set_run_adding_gain = NULL;
  dp_descriptor->deactivate = NULL;
  dp_descriptor->cleanup = dp_cleanup;
}

static void __attribute__((destructor)) dp_free_descriptor(void) {
  free(dp_descriptor);
  dp_descriptor = NULL;
}

const LADSPA_Descriptor *ladspa_descriptor(unsigned long index) {
  return index == 0 ? dp_descriptor : NULL;
}
