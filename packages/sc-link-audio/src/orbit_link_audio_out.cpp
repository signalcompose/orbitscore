// orbit_link_audio_out.cpp — `OrbitLinkAudioOut` UGen entry point (Step 2.1
// skeleton).
//
// Real implementation lives in Step 2.2:
//   - Read input signal at audio rate
//   - Convert float → 16-bit signed integer (possibly stereo interleaved)
//   - Resample from scsynth's hardware SR to the LinkAudio target SR
//   - Acquire the matching LinkAudioSink from ChannelRegistry by channelId
//   - Acquire a BufferHandle and call commit() with the current SessionState
//
// The current file just exposes the SC plugin entry symbol with no-op
// implementations so the plugin can be loaded and identified by scsynth at
// boot time. Boot-time SynthDef discovery (Step 4) flips the
// `linkAudioPluginAvailable` flag in EventScheduler the moment the
// `orbitPlayBufLink` SynthDef is observed.

#include "channel_registry.hpp"
#include "link_audio_facade.hpp"

// SC Plugin SDK include is gated so this file compiles even when the SDK
// path is not configured (Step 2.1 build is "configure-only").
#ifdef ORBIT_SC_PLUGIN_BUILD
#include <SC_PlugIn.h>

namespace {

// Single registry instance shared across the plugin's UGens. Step 2.2 will
// also own a `LinkAudio` instance here (gated by enableLinkAudio() at
// PluginLoad time).
orbitscore::ChannelRegistry g_channelRegistry;

struct OrbitLinkAudioOut : public Unit {
  // Step 2.2 will store per-Synth state here (last channelId, SR conversion
  // buffer, etc.). Empty for the skeleton — keep the struct so SC's plugin
  // macros generate matching ctor/dtor symbols.
};

extern "C" {

static void OrbitLinkAudioOut_Ctor(OrbitLinkAudioOut* /*unit*/) {
  // Step 2.2: read channelId arg, prime resampler, acquire Sink lazily.
}

static void OrbitLinkAudioOut_Dtor(OrbitLinkAudioOut* /*unit*/) {
  // Step 2.2: release any resampler / per-synth resources.
}

static void OrbitLinkAudioOut_next(OrbitLinkAudioOut* /*unit*/, int /*inNumSamples*/) {
  // Step 2.2: per-block buffer fill + commit. For now this UGen is silent.
}

}  // extern "C"

}  // namespace

// SC requires a `void api_version` symbol and a load function exposed via
// these macros. Step 2.2 will also register multi-channel variants if needed.
PluginLoad(OrbitLinkAudio) {
  ft = inTable;  // SC plugin function table
  DefineSimpleUnit(OrbitLinkAudioOut);
}

#else
// When ORBIT_SC_PLUGIN_BUILD is not defined we want this translation unit to
// compile to nothing useful — the file is here so editors / linters that
// scan the workspace don't complain about missing sources, and so that
// Step 2.2's first commit can replace the stub atomically.
#endif
