// channel_registry.hpp — server-side counterpart to the TS-side
// `LinkAudioChannelRegistry` (packages/engine/src/audio/supercollider/
// link-audio-channels.ts).
//
// Plugin holds a small lookup so that the integer channelId received via OSC
// args can be resolved to a `LinkAudioSink*` lazily (lazy-create on first
// commit). Same channelId from multiple sequences must reuse the same sink
// instance to achieve sum-by-name semantics.
//
// Step 2.1 declares the contract only. Step 2.2 implements with thread-safe
// access (Link runs on its own thread; UGen audio code is realtime-safe).

#pragma once

#include "link_audio_facade.hpp"

#include <cstdint>
#include <string>

namespace orbitscore {

class ChannelRegistry {
 public:
  ChannelRegistry();
  ~ChannelRegistry();

  // Non-copyable / non-movable: the registry owns Sink lifetimes for the
  // lifetime of the plugin process.
  ChannelRegistry(const ChannelRegistry&) = delete;
  ChannelRegistry& operator=(const ChannelRegistry&) = delete;

  // Resolve a channelId to its LinkAudioSink, lazy-creating on first use.
  // Returns nullptr until Step 2.2 wires up the LinkAudio instance and the
  // facade actually publishes a Sink.
  link_audio::LinkAudioSink* acquire(std::int32_t channelId);

  // Tear down a sink (Step 3.4 dynamic-switch use, currently no-op).
  void release(std::int32_t channelId);

 private:
  // Implementation deferred to Step 2.2 — the .cpp keeps an opaque pImpl
  // until the LinkAudio instance ownership pattern is settled.
  struct Impl;
  Impl* impl_;
};

}  // namespace orbitscore
