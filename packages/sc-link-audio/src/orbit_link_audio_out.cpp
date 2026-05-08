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
//   5. commit at the scsynth hardware sample rate (resampling to a different
//      target SR is a future follow-up — currently we expect the host to be
//      configured at the LinkAudio peer's SR).
//
// Realtime safety:
//   - The LinkAudioSink and LinkAudio* are looked up once in `Ctor` (NRT
//     command thread). `next()` only dereferences cached raw pointers and
//     never re-enters the registry mutex.
//   - No allocations / locks / blocking calls in `next()`. The int16 scratch
//     buffer is part of the Unit struct.
//   - `captureAudioSessionState` and `commit` are documented as realtime-safe
//     in `LinkAudio.hpp`. We deliberately avoid `requestMaxNumSamples` at
//     runtime — the sink is seeded with `kSinkInitialMaxNumSamples` at
//     registration time so per-block memcpy fits without resizing.
//
// Multi-sequence to the same channel (sum-by-name):
//   When two sequences share a channel id, both UGens currently `commit`
//   independently and the last write per audio tick wins. A per-channel mix
//   buffer + commit serialization is tracked separately as a follow-up.

#include "channel_registry.hpp"
#include "link_audio_facade.hpp"

#ifdef ORBIT_SC_PLUGIN_BUILD

#include <SC_PlugIn.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <limits>
#include <string>

// External linkage so channel_registry.cpp can also use the `Print` macro,
// which expands to `(*ft->fPrint)` and routes through the InterfaceTable
// (NRT-safe; the only host printer available to MH_BUNDLE plugins).
InterfaceTable* ft;

namespace {

orbitscore::ChannelRegistry g_channelRegistry;

// Largest scsynth block size we will ever see. SC_PlugIn does not expose a
// hard upper bound, but production servers default to 64 with rare bumps to
// 1024. We size scratch at 2048 stereo frames (= 8192 bytes per Unit) to
// absorb that with 2× headroom, which also matches the LinkAudioSink seed
// size in channel_registry.hpp via the static_assert below. Larger blocks
// fall back to dropping the tail of the buffer (better than tearing on a
// memcpy overrun) and Ctor logs a warning so the operator notices.
constexpr int kMaxBlockFrames = 2048;
constexpr int kNumChannels = 2;

// The stereo contract is fixed at the SynthDef level. The DSL's mono inputs
// are upmixed via Pan2 in `orbitPlayBufLink` before they reach this UGen.
// Quantum 4 = beats per Link cycle (4/4 mapping). Polymeter handling lives in
// the engine-side scheduler, not in this UGen.
constexpr double kQuantum = 4.0;

// Build-time check that the per-block memcpy in `next()` fits within the seed
// buffer size set in channel_registry.cpp. Hoisted to TU scope so a reader of
// `next()` doesn't have to step over a static_assert mid-RT-code.
static_assert(orbitscore::kSinkInitialMaxNumSamples >=
                  kMaxBlockFrames * kNumChannels * 2,
              "LinkAudioSink seed must cover max block with 2x headroom");

struct OrbitLinkAudioOut : public Unit {
  // Cached at Ctor time; lifetime owned by g_channelRegistry which never
  // erases entries during a session.
  orbitscore::link_audio::LinkAudioSink* sink;

  // Cached at Ctor time so `next()` never touches g_channelRegistry's mutex
  // (the audio thread must remain lock-free).
  orbitscore::link_audio::LinkAudio* link;

  // Cached SR so `next()` doesn't dereference `mWorld->mSampleRate` per block.
  std::uint32_t sampleRate;

  // Per-block scratch for float → int16 interleaved conversion. Living inside
  // the Unit avoids any RT allocation in `next()`.
  std::int16_t scratch[kMaxBlockFrames * kNumChannels];
};

void OrbitLinkAudioOut_next(OrbitLinkAudioOut* unit, int inNumSamples) {
  // `!sink` covers the normal case (no /cmd was sent for this channel id
  // before s_new). `!link` is belt-and-suspenders for the rare path where
  // initLinkAudio's try-block threw and `getLinkAudio()` returned nullptr at
  // Ctor — a dangling pointer post-PluginUnload would still be UB on deref,
  // so this guard cannot protect that case; PluginUnload ordering must.
  if (!unit->sink || !unit->link) {
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
  // bh.samples capacity is guaranteed by the static_assert at TU scope:
  // kSinkInitialMaxNumSamples >= kMaxBlockFrames * kNumChannels * 2, so
  // totalSamples (≤ kMaxBlockFrames * kNumChannels) always fits.
  std::memcpy(bh.samples, out, totalSamples * sizeof(std::int16_t));

  // Beat at buffer begin. We use the Link clock at "now" as a proxy for the
  // start of this audio block. The error is at most one block (~1.4 ms at
  // 48 kHz / 64 frames), well below the human-perceptible Link sync window.
  auto sessionState = unit->link->captureAudioSessionState();
  const auto now = unit->link->clock().micros();
  const double beatsAtBufferBegin = sessionState.beatAtTime(now, kQuantum);

  bh.commit(sessionState, beatsAtBufferBegin, kQuantum,
            static_cast<std::size_t>(n),
            static_cast<std::size_t>(kNumChannels), unit->sampleRate);
}

void OrbitLinkAudioOut_Ctor(OrbitLinkAudioOut* unit) {
  // `channel` is a control-rate constant arg — `IN0(2)` reads the value.
  // Casting NaN / ±inf or any finite value outside `int32_t` range to int is
  // undefined behaviour per C++. Reject both classes and fall through to the
  // `id <= 0` reject path in registerChannel / lookup.
  const float rawChannel = IN0(2);
  // INT32_MIN (= -2^31) IS representable in float32, so >= comparison is fine.
  // INT32_MAX (= 2^31 - 1) is NOT representable and rounds up to 2^31.0f, so
  // we must use a strict < against 2^31.0f. Otherwise rawChannel == 2^31.0f
  // would pass the bounds check and the subsequent cast would still be UB.
  constexpr float kIntMin = static_cast<float>(std::numeric_limits<std::int32_t>::min());
  constexpr float kIntMaxExclusive = static_cast<float>(1ll << 31);
  const std::int32_t channelId =
      (std::isfinite(rawChannel) && rawChannel >= kIntMin && rawChannel < kIntMaxExclusive)
          ? static_cast<std::int32_t>(rawChannel)
          : -1;
  unit->sink = g_channelRegistry.lookup(channelId);
  unit->link = g_channelRegistry.getLinkAudio();
  unit->sampleRate = static_cast<std::uint32_t>(unit->mWorld->mSampleRate);
  std::memset(unit->scratch, 0, sizeof(unit->scratch));

  if (!unit->sink) {
    // Without this diagnostic the symptom (silent Synth) is identical to
    // "Live not subscribed" — the user has no path to discover that they
    // forgot to send /cmd /orbit/registerLinkAudioChannel.
    Print("OrbitLinkAudioOut: channel id %d has no registered sink — "
             "send /cmd /orbit/registerLinkAudioChannel before s_new\n",
             static_cast<int>(channelId));
  }

  // Server block size > our scratch capacity → next() will silently drop the
  // tail of every block. We can't warn from next() (RT thread, no Print) but
  // we can warn here once per Synth instantiation. mBufLength is the per-block
  // frame count of the host scsynth.
  const int blockSize = static_cast<int>(unit->mWorld->mBufLength);
  if (blockSize > kMaxBlockFrames) {
    Print("OrbitLinkAudioOut: server blockSize=%d exceeds kMaxBlockFrames=%d "
          "— audio output will be truncated per block. Reduce blockSize or "
          "rebuild the plugin with a larger kMaxBlockFrames.\n",
          blockSize, kMaxBlockFrames);
  }

  SETCALC(OrbitLinkAudioOut_next);
}

// `/cmd /orbit/registerLinkAudioChannel <id> <name>` handler.
//
// The TS-side dispatcher emits this once per first occurrence of a name. Args:
//   - i : channel id (matches the integer the UGen sees on `IN0(2)`)
//   - s : displayed channel name in Live ("kick", "drums", ...)
void OrbitLinkAudioOut_RegisterChannel(World* /*world*/, void* /*userData*/,
                                       sc_msg_iter* args, void* /*replyAddr*/) {
  // Pass an out-of-band sentinel as the default. The TS-side
  // `LinkAudioChannelRegistry` allocates ids starting at 1, so any non-positive
  // id is malformed (missing or wrong-type integer argument). Without this,
  // a missing/malformed integer would silently register channel 0 — a TS
  // serialization bug would never surface as a diagnostic.
  const std::int32_t id = args->geti(-1);
  if (id <= 0) {
    Print("OrbitLinkAudio: /cmd registerLinkAudioChannel missing or malformed "
          "integer id argument (got %d) — ignoring\n", static_cast<int>(id));
    return;
  }
  // Pass nullptr as the default so `gets` returns nullptr both for missing
  // arguments and for type mismatches — without this the empty default `""`
  // hides a malformed message under a valid-looking empty string.
  const char* name = args->gets(nullptr);
  if (name == nullptr) {
    Print("OrbitLinkAudio: /cmd registerLinkAudioChannel id=%d missing or "
             "malformed string argument — ignoring\n", static_cast<int>(id));
    return;
  }
  if (name[0] == '\0') {
    Print("OrbitLinkAudio: /cmd registerLinkAudioChannel id=%d empty "
             "channel name rejected (would appear blank in Live)\n",
             static_cast<int>(id));
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
