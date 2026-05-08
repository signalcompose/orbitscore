// orbit_link_audio_out.cpp — `OrbitLinkAudioOut` UGen.
//
// SynthDef contract (matches packages/engine/src/audio/supercollider/
// event-scheduler.ts SYNTHDEF_LINK = "orbitPlayBufLink"):
//
//   OrbitLinkAudioOut.ar(left, right, channel)
//
//   - left  / right  : audio-rate stereo input. Mono sources upmix via Pan2 in
//                      the SynthDef before reaching this UGen, so the
//                      LinkAudioSink always commits 2-channel buffers.
//   - channel        : control-rate integer id allocated by the TS-side
//                      `LinkAudioChannelRegistry`. The human-readable name
//                      arrives separately via `/cmd /orbit/registerLinkAudioChannel`.
//
// Per-block flow in `next()`:
//   1. clamp + scale float samples to int16 interleaved
//   2. acquire `LinkAudioSink::BufferHandle`
//   3. memcpy into the buffer
//   4. compute `beatsAtBufferBegin` from `captureAudioSessionState` + Link clock
//   5. commit at the scsynth hardware sample rate (Step 2.2 commits at the
//      input SR; resampling to a separate target SR is left to a follow-up;
//      see WORK_LOG 6.83).
//
// Realtime safety:
//   - The LinkAudioSink lookup happens once in `Ctor` (NRT command thread).
//     `next()` only dereferences a cached raw pointer.
//   - No allocations / locks / blocking calls in `next()`. The int16 scratch
//     buffer is part of the Unit struct.
//   - `captureAudioSessionState`, `commit`, `requestMaxNumSamples` are
//     documented as realtime-safe in `LinkAudio.hpp`.
//
// Multi-sequence to the same channel (sum-by-name, E2E checklist §C):
//   Step 2.2 only routes a single sequence per channel cleanly. When two
//   sequences share a channel id, both UGens currently `commit` independently
//   and the last write per audio tick wins. Step 2.3 will introduce a
//   per-channel mix buffer + commit serialization. Documented as a known
//   limitation in WORK_LOG.

#include "channel_registry.hpp"
#include "link_audio_facade.hpp"

#ifdef ORBIT_SC_PLUGIN_BUILD

#include <SC_PlugIn.h>

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <string>

static InterfaceTable* ft;

namespace {

orbitscore::ChannelRegistry g_channelRegistry;

// Largest scsynth block size we will ever see. SC_PlugIn does not expose a
// hard upper bound, but production servers default to 64 with rare bumps to
// 1024. We size scratch at 2048 stereo frames to absorb that without RT
// allocation. Larger blocks fall back to dropping the tail of the buffer
// (better than tearing on a memcpy overrun).
constexpr int kMaxBlockFrames = 2048;
constexpr int kNumChannels = 2;

// The stereo contract is fixed at the SynthDef level. The DSL's mono inputs
// are upmixed via Pan2 in `orbitPlayBufLink` before they reach this UGen.
constexpr double kQuantum = 4.0;  // Standard 4/4 mapping. See WORK_LOG 6.83 for polymeter follow-up.

struct OrbitLinkAudioOut : public Unit {
  // Cached at Ctor time; lifetime owned by g_channelRegistry which never
  // erases entries during a session (release() is reserved for v1.2.x).
  orbitscore::link_audio::LinkAudioSink* sink;

  // Per-block scratch for float → int16 interleaved conversion. Living inside
  // the Unit avoids any RT allocation in `next()`.
  std::int16_t scratch[kMaxBlockFrames * kNumChannels];
};

void OrbitLinkAudioOut_next(OrbitLinkAudioOut* unit, int inNumSamples) {
  if (!unit->sink) {
    return;
  }
  auto* link = g_channelRegistry.getLinkAudio();
  if (!link) {
    return;
  }

  const int n = std::min(inNumSamples, kMaxBlockFrames);

  // Float → int16 interleaved (left, right, left, right, ...).
  // Clamp BEFORE scaling — a sample past ±1.0f would otherwise wrap on cast
  // (e.g., 1.001f * 32767 = 32799 → int16 overflow → audible glitch).
  const float* lin = IN(0);
  const float* rin = IN(1);
  std::int16_t* out = unit->scratch;
  for (int i = 0; i < n; ++i) {
    float l = std::clamp(lin[i], -1.0f, 1.0f);
    float r = std::clamp(rin[i], -1.0f, 1.0f);
    out[i * 2 + 0] = static_cast<std::int16_t>(l * 32767.0f);
    out[i * 2 + 1] = static_cast<std::int16_t>(r * 32767.0f);
  }

  // Acquire a buffer from the sink. RAII-released at scope end so a missing
  // subscriber simply skips the commit.
  orbitscore::link_audio::LinkAudioSink::BufferHandle bh(*unit->sink);
  if (!bh) {
    return;
  }

  const std::size_t totalSamples =
      static_cast<std::size_t>(n) * static_cast<std::size_t>(kNumChannels);
  if (bh.maxNumSamples < totalSamples) {
    // The sink's buffer is too small. Request a bigger buffer for the next
    // tick (RT-safe per `LinkAudio.hpp`) and skip this commit. This typically
    // only fires on the very first block before the sink has settled.
    unit->sink->requestMaxNumSamples(totalSamples * 2);
    return;
  }

  std::memcpy(bh.samples, out, totalSamples * sizeof(std::int16_t));

  // Beat at buffer begin. We use the Link clock at "now" as a proxy for the
  // start of this audio block. The error is at most one block (~1.4 ms at
  // 48 kHz / 64 frames), well below the human-perceptible Link sync window.
  // Refining to a hardware-derived buffer-begin timestamp is a Step 4 follow-up.
  auto sessionState = link->captureAudioSessionState();
  const auto now = link->clock().micros();
  const double beatsAtBufferBegin = sessionState.beatAtTime(now, kQuantum);
  const std::uint32_t sr =
      static_cast<std::uint32_t>(unit->mWorld->mSampleRate);

  bh.commit(sessionState, beatsAtBufferBegin, kQuantum,
            static_cast<std::size_t>(n),
            static_cast<std::size_t>(kNumChannels), sr);
}

void OrbitLinkAudioOut_Ctor(OrbitLinkAudioOut* unit) {
  // `channel` is a control-rate constant arg — `IN0(2)` reads the value.
  // Cast through `int32_t` so a bogus float (e.g., NaN from a SynthDef bug)
  // becomes a deterministic id rather than UB.
  const std::int32_t channelId = static_cast<std::int32_t>(IN0(2));
  unit->sink = g_channelRegistry.lookup(channelId);
  std::memset(unit->scratch, 0, sizeof(unit->scratch));

  SETCALC(OrbitLinkAudioOut_next);
}

// `/cmd /orbit/registerLinkAudioChannel <id> <name>` handler.
//
// TS-side dispatcher emits this once per first occurrence of a name (see
// follow-up patch on `link-audio-channels.ts`). Args:
//   - i : channel id (matches the integer the UGen sees on `IN0(2)`)
//   - s : displayed channel name in Live ("kick", "drums", ...)
void OrbitLinkAudioOut_RegisterChannel(World* /*world*/, void* /*userData*/,
                                       sc_msg_iter* args, void* /*replyAddr*/) {
  const std::int32_t id = args->geti();
  const char* name = args->gets("");
  if (name == nullptr) {
    return;
  }
  g_channelRegistry.registerChannel(id, std::string(name));
}

}  // namespace

PluginLoad(OrbitLinkAudio) {
  ft = inTable;

  // 120 BPM is just an initial value — Link sync overrides it as soon as a
  // peer with a different tempo joins the session. Peer name "OrbitScore" is
  // what other peers (Live, etc.) display in their Link UI.
  g_channelRegistry.initLinkAudio(120.0, "OrbitScore");

  DefinePlugInCmd("/orbit/registerLinkAudioChannel",
                  OrbitLinkAudioOut_RegisterChannel, nullptr);
  DefineSimpleUnit(OrbitLinkAudioOut);
}

PluginUnload(OrbitLinkAudio) {
  g_channelRegistry.shutdownLinkAudio();
}

#else  // ORBIT_SC_PLUGIN_BUILD

// Non-SDK build: empty translation unit so linters and IDE indexers can scan
// the workspace without the SC plugin headers.

#endif  // ORBIT_SC_PLUGIN_BUILD
