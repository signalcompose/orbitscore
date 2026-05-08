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
//     startup / shutdown thread). Single-shot.
//   - `registerChannel`: OSC `/cmd` handler thread. Holds the mutex briefly
//     to insert into the map and ctor a new sink.
//   - `lookup`: UGen ctor (server NRT command thread). Holds the mutex briefly
//     to read; the returned raw pointer stays valid for the registry lifetime
//     because Step 2.2 never erases entries (release() is reserved for v1.2.x).
//   - The audio thread itself never touches the registry — UGens cache the
//     `LinkAudioSink*` once in their `Ctor` and use it lock-free in `next()`.

#pragma once

#include "link_audio_facade.hpp"

#include <cstdint>
#include <memory>
#include <string>

namespace orbitscore {

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
  // backing `LinkAudioSink`; subsequent calls update the displayed name.
  // Called from the OSC `/cmd` thread.
  void registerChannel(std::int32_t channelId, std::string name);

  // Look up the sink for a channel id. Returns nullptr if `registerChannel`
  // was never called for this id, or if `initLinkAudio` was never called.
  // Called from the UGen Ctor (NRT command thread). The returned pointer is
  // valid for the registry's lifetime; Step 2.2 never erases entries.
  link_audio::LinkAudioSink* lookup(std::int32_t channelId);

  // Borrowed pointer to the singleton. Used by the UGen to capture audio
  // session state and read the current beat position. nullptr until
  // `initLinkAudio` has run.
  link_audio::LinkAudio* getLinkAudio();

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace orbitscore
