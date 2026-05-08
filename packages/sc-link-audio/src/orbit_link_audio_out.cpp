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
// Sum-by-name commit is deferred by one tick: the first UGen of each new
// tick flushes the previous tick's accumulator and starts a fresh one.
// 1-tick latency (≈ 21 ms @ 48 kHz / 1024 frames; ≈ 1.3 ms @ 64 frames) sits
// well below the Link sync window. A gap > 1 between ticks drops the stored
// accumulator silently — its captured beat would mismatch Live's current
// position.
//
// Realtime safety:
//   - `SinkEntry*` and `LinkAudio*` are looked up once in `Ctor` (NRT command
//     thread) and cached on the Unit. `next()` only dereferences cached raw
//     pointers and never re-enters the registry mutex.
//   - No allocations / locks / blocking calls in `next()`. The mix buffer
//     lives inside `SinkEntry::mix` (heap-allocated at registration time, not
//     per Unit); `BufferHandle.samples` is the only writable destination.
//   - `captureAudioSessionState` and `commit` are documented as realtime-safe
//     in `LinkAudio.hpp`. We deliberately avoid `requestMaxNumSamples` at
//     runtime — the sink is seeded with `kSinkInitialMaxNumSamples` at
//     registration time so the per-tick memcpy fits without resizing.
//
// Multi-sequence to the same channel:
//   The audio thread is single-threaded, so all UGens bound to the same
//   channel id run serially within one block. The first UGen of each tick
//   handles flush + reset; subsequent UGens just `+=` into the cleared
//   buffer. No atomics or extra synchronisation needed.

#include "channel_registry.hpp"
#include "link_audio_facade.hpp"

#ifdef ORBIT_SC_PLUGIN_BUILD

#include <SC_PlugIn.h>
#include <ableton/util/FloatIntConversion.hpp>

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

// Quantum 4 = beats per Link cycle (4/4 mapping). Polymeter handling lives in
// the engine-side scheduler, not in this UGen.
constexpr double kQuantum = 4.0;

// Build-time check that the per-tick memcpy in the flush path fits within the
// seed buffer size set in channel_registry.hpp. Hoisted to TU scope so a reader
// of `next()` doesn't have to step over a static_assert mid-RT-code.
static_assert(orbitscore::kSinkInitialMaxNumSamples >=
                  orbitscore::kLinkAudioMaxBlockFrames *
                      orbitscore::kLinkAudioNumChannels * sizeof(std::int16_t),
              "LinkAudioSink seed must cover max-block stereo frames "
              "in int16 bytes (no slack above this minimum at the cap)");

struct OrbitLinkAudioOut : public Unit {
  // Cached at Ctor time; lifetime owned by g_channelRegistry which never
  // erases entries during a session. Pointer to the SinkEntry (NOT to the
  // inner LinkAudioSink) so `next()` can reach both the sink and the mix
  // accumulation state with a single Ctor-time lookup.
  orbitscore::SinkEntry* entry;

  // Cached at Ctor time so `next()` never touches g_channelRegistry's mutex
  // (the audio thread must remain lock-free).
  orbitscore::link_audio::LinkAudio* link;

  // Cached SR so `next()` doesn't dereference `mWorld->mSampleRate` per block.
  std::uint32_t sampleRate;
};

void OrbitLinkAudioOut_next(OrbitLinkAudioOut* unit, int inNumSamples) {
  // `!entry` covers the normal case (no /cmd was sent for this channel id
  // before s_new). `!link` is belt-and-suspenders for the rare path where
  // initLinkAudio's try-block threw and `getLinkAudio()` returned nullptr at
  // Ctor — a dangling pointer post-PluginUnload would still be UB on deref,
  // so this guard cannot protect that case; PluginUnload ordering must.
  if (!unit->entry || !unit->link) {
    return;
  }

  auto& sink = unit->entry->sink;
  auto& mix = unit->entry->mix;
  const std::int64_t bufCounter =
      static_cast<std::int64_t>(unit->mWorld->mBufCounter);

  // Tick transition: the first UGen of each new tick flushes the previous
  // tick's accumulator (if adjacent) and starts a fresh one. Subsequent UGens
  // within the same tick fall through to the accumulation step below without
  // re-entering this branch.
  if (bufCounter != mix.currentBufCounter) {
    // Adjacent-tick flush. We only commit when `bufCounter == prev + 1` —
    // a gap > 1 means the audio thread starved or this UGen skipped ticks,
    // and the captured session state's beat would be stale relative to where
    // Live is now. Dropping is safer than injecting mistimed audio. -1 is the
    // initial sentinel and means "no prior accumulation to flush".
    if (mix.currentBufCounter >= 0 &&
        bufCounter == mix.currentBufCounter + 1) {
      orbitscore::link_audio::LinkAudioSink::BufferHandle bh(sink);
      if (bh) {
        const std::size_t totalSamples =
            static_cast<std::size_t>(mix.currentFrames) *
            static_cast<std::size_t>(orbitscore::kLinkAudioNumChannels);
        // Clamp + int16 quantise AFTER summation: two inputs at 0.6 each
        // sum to 1.2, which the post-sum clamp brings to 1.0 (full scale).
        // floatToInt16 internally clamps to [-1, 1 - 1/32768] before scaling.
        for (std::size_t i = 0; i < totalSamples; ++i) {
          bh.samples[i] = ableton::util::floatToInt16(mix.mixBuffer[i]);
        }
        // The flush gate (`currentBufCounter >= 0`) implies the optional
        // SessionState was assigned in a prior new-tick branch.
        bh.commit(*mix.currentSessionState, mix.currentBeatsAtBufferBegin,
                  kQuantum, static_cast<std::size_t>(mix.currentFrames),
                  static_cast<std::size_t>(orbitscore::kLinkAudioNumChannels),
                  unit->sampleRate);
      }
    }

    // Capture session state NOW (at the start of the tick's audio data), not
    // at flush time — the captured state describes when the audio was
    // generated, so Live queues it correctly even though we commit one tick
    // later. emplace() avoids a copy of the opaque ApiState through optional.
    //
    // Ordering: emplace + frame state are written FIRST, then `currentBufCounter`
    // is set last. The flush gate (`currentBufCounter >= 0`) opens only after
    // the optional is populated, so a hypothetical throw from
    // captureAudioSessionState cannot leave the gate open with an empty
    // optional. Makes the invariant on ChannelMixState::currentSessionState
    // structural rather than relying on an unstated no-throw contract.
    const int n =
        std::min(inNumSamples, orbitscore::kLinkAudioMaxBlockFrames);
    const std::size_t clearSamples =
        static_cast<std::size_t>(n) *
        static_cast<std::size_t>(orbitscore::kLinkAudioNumChannels);
    std::memset(mix.mixBuffer, 0, clearSamples * sizeof(float));
    mix.currentFrames = n;
    mix.currentSessionState.emplace(unit->link->captureAudioSessionState());
    const auto now = unit->link->clock().micros();
    mix.currentBeatsAtBufferBegin =
        mix.currentSessionState->beatAtTime(now, kQuantum);
    mix.currentBufCounter = bufCounter;
  }

  // Accumulate this UGen's contribution. scsynth guarantees a uniform block
  // size across UGens within one tick, so `mix.currentFrames` (set by the
  // first UGen of this tick above) is the correct cap. No per-UGen clamp —
  // see post-sum clamp at flush time.
  const float* lin = IN(0);
  const float* rin = IN(1);
  for (int i = 0; i < mix.currentFrames; ++i) {
    mix.mixBuffer[i * 2 + 0] += lin[i];
    mix.mixBuffer[i * 2 + 1] += rin[i];
  }
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
  unit->entry = g_channelRegistry.lookup(channelId);
  unit->link = g_channelRegistry.getLinkAudio();
  unit->sampleRate = static_cast<std::uint32_t>(unit->mWorld->mSampleRate);

  if (!unit->entry) {
    // Without this diagnostic the symptom (silent Synth) is identical to
    // "Live not subscribed" — the user has no path to discover that they
    // forgot to send /cmd /orbit/registerLinkAudioChannel.
    Print("OrbitLinkAudioOut: channel id %d has no registered sink — "
             "send /cmd /orbit/registerLinkAudioChannel before s_new\n",
             static_cast<int>(channelId));
  }

  // Server block size > our mix capacity → next() will silently drop the tail
  // of every tick. We can't warn from next() (RT thread, no Print) but we can
  // warn here once per Synth instantiation. mBufLength is the per-block frame
  // count of the host scsynth.
  const int blockSize = static_cast<int>(unit->mWorld->mBufLength);
  if (blockSize > orbitscore::kLinkAudioMaxBlockFrames) {
    Print("OrbitLinkAudioOut: server blockSize=%d exceeds "
          "kLinkAudioMaxBlockFrames=%d — audio output will be truncated per "
          "block. Reduce blockSize or rebuild the plugin with a larger "
          "kLinkAudioMaxBlockFrames.\n",
          blockSize, orbitscore::kLinkAudioMaxBlockFrames);
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
