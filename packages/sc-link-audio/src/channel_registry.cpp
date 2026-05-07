// channel_registry.cpp — Step 2.1 stub.
//
// Step 2.2 will implement:
//   - LinkAudio instance ownership (singleton tied to plugin load)
//   - thread-safe channelId → LinkAudioSink* map
//   - lazy-create of LinkAudioSink on first acquire()
//   - cleanup on release() / plugin unload
//
// This stub keeps the symbol set defined so the plugin links cleanly without
// the full SDK during Step 2.1 review.

#include "channel_registry.hpp"

namespace orbitscore {

struct ChannelRegistry::Impl {
  // intentionally empty — Step 2.2 fills in the map + LinkAudio handle
};

ChannelRegistry::ChannelRegistry() : impl_(new Impl()) {}

ChannelRegistry::~ChannelRegistry() {
  delete impl_;
}

link_audio::LinkAudioSink* ChannelRegistry::acquire(std::int32_t /*channelId*/) {
  // Step 2.2: lazy-create or look up an existing sink for this id.
  return nullptr;
}

void ChannelRegistry::release(std::int32_t /*channelId*/) {
  // Step 2.2 / Step 3.4: tear down the sink when no sequences reference the
  // channel anymore. No-op for now.
}

}  // namespace orbitscore
