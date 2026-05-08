// channel_registry.hpp — server-side counterpart to the TS-side
// `LinkAudioChannelRegistry` (packages/engine/src/audio/supercollider/
// link-audio-channels.ts).
//
// The TS side maps channel names ("kick", "drums") to integer ids and sends
// only the integer over `/s_new`. Live displays the original name though, so
// the plugin must be told the mapping out-of-band. We use a custom OSC
// `/cmd /orbit/registerLinkAudioChannel <id> <name>` (handled in
// `orbit_link_audio_out.cpp`) which routes through `registerChannel()` here.
//
// Threading model:
//   - `initLinkAudio` / `shutdownLinkAudio`: PluginLoad / PluginUnload (server
//     startup / shutdown thread). Single-shot. PluginUnload is assumed to run
//     after scsynth has stopped its audio engine — sinks held by live UGens
//     would otherwise race with `BufferHandle` consumers.
//   - `registerChannel`: OSC `/cmd` handler thread. Holds the mutex briefly
//     to insert into the map and ctor a new sink.
//   - `lookup`: UGen ctor (server NRT command thread). Holds the mutex briefly
//     to read; the returned raw pointer stays valid for the registry lifetime
//     because the registry never erases entries during a session (a future
//     `release()` would invalidate cached pointers held by `next()` — adding
//     erase requires a cache-invalidation strategy on the audio thread).
//   - The audio thread itself never touches the registry — UGens cache the
//     `SinkEntry*` once in their `Ctor` and use it lock-free in `next()`.
//
// Sum-by-name:
//   Per-channel `ChannelMixState` is owned exclusively by the audio thread.
//   UGens cache `SinkEntry*` once at Ctor time and never call `lookup()` from
//   `next()`, so the registry mutex is never contended from the RT thread.
//   Single-thread serial UGen execution makes `+=` accumulation race-free.

#pragma once

#include "link_audio_facade.hpp"

#include <cstddef>
#include <cstdint>
#include <memory>
#include <optional>
#include <string>

namespace orbitscore {

// === Block-size constants ===
//
// Largest scsynth block size we will ever see. SC_PlugIn does not expose a
// hard upper bound, but production servers default to 64 with rare bumps to
// 1024. We cap our internal buffers at 2048 stereo frames — 2× the largest
// expected production block size of 1024 — so the `LinkAudioSink` seed
// (`kSinkInitialMaxNumSamples`) covers the worst case without slack above
// the computed minimum. Larger blocks fall back to dropping the tail of the
// buffer (better than tearing on a memcpy overrun) and Ctor logs a warning.
constexpr int kLinkAudioMaxBlockFrames = 2048;

// The stereo contract is fixed at the SynthDef level. The DSL's mono inputs
// are upmixed via Pan2 in `orbitPlayBufLink` before they reach the UGen.
constexpr int kLinkAudioNumChannels = 2;

// Initial max-samples seed used when constructing a `LinkAudioSink`. Set so
// that the per-tick memcpy in `OrbitLinkAudioOut::next()` always fits without
// the UGen ever needing `requestMaxNumSamples` at runtime. Coupled to
// `kLinkAudioMaxBlockFrames * kLinkAudioNumChannels * sizeof(int16_t)` —
// the UGen's `static_assert` verifies this equals the seed value at the
// current block-size cap (no slack above the computed minimum).
constexpr std::size_t kSinkInitialMaxNumSamples = 8192;

#ifdef ORBIT_SC_PLUGIN_BUILD

// Per-channel sum-by-name accumulation state. Lives inside `SinkEntry` so the
// audio thread sees it via the same cached pointer as the sink itself.
//
// Concurrency: only the scsynth audio thread touches this struct after
// initialisation. UGens for the same block run serially on that thread, so
// `+= input` accumulation across UGens for the same channel is naturally
// race-free without atomics.
struct ChannelMixState {
  // Float accumulator across all UGens publishing to this channel within a
  // single audio tick. Cleared at the start of each new tick (see next() flow
  // in orbit_link_audio_out.cpp). Float is preferred over int32 because it
  // avoids an early int16 quantisation step when accumulating multiple float
  // inputs.
  float mixBuffer[kLinkAudioMaxBlockFrames * kLinkAudioNumChannels];

  // scsynth's `mWorld->mBufCounter` value of the tick currently being
  // accumulated. Negative means "no current accumulation in flight" — the
  // SinkEntry constructor seeds it to -1, and the flush gate uses `>= 0` so
  // any negative value short-circuits the flush. Used by next() to detect
  // tick transitions: when the value differs from the live mBufCounter, the
  // previous tick's accumulator is flushed to LinkAudio (only when the gap
  // is exactly 1 — see comment on flush in next()).
  std::int64_t currentBufCounter;

  // Frozen at the start of each tick's accumulation; reused at flush so the
  // commit's SessionState matches the audio data being committed. Optional<>
  // is required because `LinkSessionState` has no default constructor.
  // Invariant: `has_value()` whenever `currentBufCounter >= 0`. Made
  // structural by the next() write order: emplace runs BEFORE
  // `currentBufCounter = bufCounter`, so a hypothetical throw between the
  // two cannot leave the gate open with an empty optional. The flush gate
  // relies on this to dereference without a null check.
  int currentFrames;
  std::optional<link_audio::LinkSessionState> currentSessionState;
  double currentBeatsAtBufferBegin;
};

// Owning pair held inside the registry. The audio thread caches a pointer to
// this struct (not to the inner `LinkAudioSink`) so `next()` can reach both
// the sink (for `BufferHandle` ctor + commit) and the mix state (for
// accumulation) with a single Ctor-time lookup.
struct SinkEntry {
  link_audio::LinkAudioSink sink;
  ChannelMixState mix;

  template <typename... Args>
  explicit SinkEntry(Args&&... sinkArgs)
      : sink(std::forward<Args>(sinkArgs)...), mix{} {
    mix.currentBufCounter = -1;
  }
};

#else  // ORBIT_SC_PLUGIN_BUILD
// Forward declaration only — non-plugin builds don't need the layout.
struct SinkEntry;
#endif

class ChannelRegistry {
 public:
  ChannelRegistry();
  ~ChannelRegistry();

  ChannelRegistry(const ChannelRegistry&) = delete;
  ChannelRegistry& operator=(const ChannelRegistry&) = delete;

  // Construct the LinkAudio singleton and enable audio sharing. Call once
  // from PluginLoad. Idempotent: a second call with the singleton already
  // present is a no-op so plugin reload during dev does not double-construct.
  void initLinkAudio(double bpm, const std::string& peerName);

  // Tear down all sinks and the LinkAudio singleton in that order (sinks hold
  // weak references back into LinkAudio internals). Call from PluginUnload.
  void shutdownLinkAudio();

  // Register a channel id → name mapping. First call for an id constructs the
  // backing `LinkAudioSink`. Subsequent calls for the same id are a deliberate
  // no-op: `LinkAudioSink` is documented as "Thread-safe: no", so calling
  // `setName()` from the OSC `/cmd` thread would race with `BufferHandle`
  // ctor/commit on the audio thread. The TS-side dispatcher only emits `/cmd`
  // on first occurrence of a name, so no rename path exists in production.
  // Called from the OSC `/cmd` thread (or from an async stage2 NRT callback).
  //
  // Returns true on success (sink allocated OR id already registered — both
  // are observable to the caller as "channel id is now usable"). Returns
  // false only when the sink ctor throws or the registry's LinkAudio
  // singleton is missing — both are observability-worthy failure modes that
  // the OSC reply path uses to decide between sending /done vs. swallowing.
  bool registerChannel(std::int32_t channelId, std::string name);

  // Look up the SinkEntry for a channel id. Returns nullptr if
  // `registerChannel` was never called for this id, or if `initLinkAudio`
  // was never called. Called from the UGen Ctor (NRT command thread). The
  // returned pointer is valid for the registry's lifetime; entries are never
  // erased during a session.
  SinkEntry* lookup(std::int32_t channelId);

  // Borrowed pointer to the singleton. Used by the UGen to capture audio
  // session state and read the current beat position. nullptr until
  // `initLinkAudio` has run.
  link_audio::LinkAudio* getLinkAudio();

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace orbitscore
