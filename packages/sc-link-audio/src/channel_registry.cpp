// channel_registry.cpp — implementation.
//
// See channel_registry.hpp for the threading contract. The mutex here is
// only ever held by non-realtime threads (server startup / OSC `/cmd` /
// UGen ctor). The audio thread reads a cached pointer obtained at ctor time.

#include "channel_registry.hpp"

#ifdef ORBIT_SC_PLUGIN_BUILD
#include <SC_PlugIn.h>  // Print macro = (*ft->fPrint), NRT-safe via InterfaceTable

#include <exception>
#include <mutex>
#include <unordered_map>

// `ft` is defined with external linkage in orbit_link_audio_out.cpp (set in
// PluginLoad before any /cmd or UGen call can fire). The `Print` macro from
// SC_PlugIn.h dereferences it; we just need the symbol to exist at link time.
extern InterfaceTable* ft;
#endif

namespace orbitscore {

#ifdef ORBIT_SC_PLUGIN_BUILD

struct ChannelRegistry::Impl {
  std::mutex mtx;
  std::unique_ptr<link_audio::LinkAudio> link;
  std::unordered_map<std::int32_t, std::unique_ptr<SinkEntry>> sinks;
};

ChannelRegistry::ChannelRegistry() : impl_(std::make_unique<Impl>()) {}
ChannelRegistry::~ChannelRegistry() = default;

void ChannelRegistry::initLinkAudio(double bpm, const std::string& peerName) {
  std::lock_guard<std::mutex> lock(impl_->mtx);
  if (impl_->link) {
    return;
  }
  // LinkAudio is alpha — its ctor and enableLinkAudio() error contract is not
  // formally documented. Catch defensively so a failed init leaves the plugin
  // in a clean "disabled" state rather than crashing scsynth.
  try {
    impl_->link = std::make_unique<link_audio::LinkAudio>(bpm, peerName);
    impl_->link->enableLinkAudio(true);
  } catch (const std::exception& e) {
    Print("OrbitLinkAudio: initLinkAudio failed: %s\n", e.what());
    impl_->link.reset();
  } catch (...) {
    Print("OrbitLinkAudio: initLinkAudio failed (unknown exception)\n");
    impl_->link.reset();
  }
}

void ChannelRegistry::shutdownLinkAudio() {
  std::lock_guard<std::mutex> lock(impl_->mtx);
  // Sinks hold weak references back into LinkAudio internals; destroy them
  // first so LinkAudio teardown does not race against `BufferHandle` users.
  // The teardown path is symmetric with initLinkAudio() — alpha API, error
  // contract not formally documented — so wrap defensively. An exception
  // escaping into PluginUnload would crash scsynth on user-initiated server
  // quit, the worst possible time to take down the audio process.
  try {
    impl_->sinks.clear();
  } catch (const std::exception& e) {
    Print("OrbitLinkAudio: error during sink teardown: %s\n", e.what());
  } catch (...) {
    Print("OrbitLinkAudio: error during sink teardown (unknown exception)\n");
  }
  if (impl_->link) {
    try {
      impl_->link->enableLinkAudio(false);
    } catch (const std::exception& e) {
      Print("OrbitLinkAudio: enableLinkAudio(false) failed: %s\n", e.what());
    } catch (...) {
      Print("OrbitLinkAudio: enableLinkAudio(false) failed (unknown exception)\n");
    }
    try {
      impl_->link.reset();
    } catch (const std::exception& e) {
      Print("OrbitLinkAudio: LinkAudio dtor threw: %s\n", e.what());
    } catch (...) {
      Print("OrbitLinkAudio: LinkAudio dtor threw (unknown exception)\n");
    }
  }
}

bool ChannelRegistry::registerChannel(std::int32_t channelId, std::string name) {
  std::lock_guard<std::mutex> lock(impl_->mtx);
  if (!impl_->link) {
    Print("OrbitLinkAudio: registerChannel called before initLinkAudio "
             "(channel id %d) — ignoring\n", channelId);
    return false;
  }

  auto it = impl_->sinks.find(channelId);
  if (it != impl_->sinks.end()) {
    // Re-registration must NOT call setName(): LinkAudio.hpp documents
    // LinkAudioSink as "Thread-safe: no", so a setName from the /cmd thread
    // would race with BufferHandle ctor/commit on the audio thread. The TS
    // dispatcher only emits /cmd on first-name occurrence, so this branch
    // doubles as a regression detector. Return true: the channel id is
    // already usable — the discarded rename is not a hard failure.
    Print("OrbitLinkAudio: re-registration of channel id %d ignored "
          "(rename to \"%s\" discarded; setName would race with audio "
          "thread)\n", channelId, name.c_str());
    return true;
  }

  // Catch defensively — LinkAudioSink ctor's exception contract is undocumented
  // in the alpha API. A throw must not escape into the OSC /cmd dispatch loop
  // and crash scsynth (mirrors the rationale in initLinkAudio above).
  try {
    auto entry = std::make_unique<SinkEntry>(
        *impl_->link, std::move(name), kSinkInitialMaxNumSamples);
    impl_->sinks.emplace(channelId, std::move(entry));
    return true;
  } catch (const std::exception& e) {
    Print("OrbitLinkAudio: failed to allocate sink for channel id %d: %s\n",
             channelId, e.what());
    return false;
  } catch (...) {
    Print("OrbitLinkAudio: failed to allocate sink for channel id %d "
             "(unknown exception)\n", channelId);
    return false;
  }
}

SinkEntry* ChannelRegistry::lookup(std::int32_t channelId) {
  std::lock_guard<std::mutex> lock(impl_->mtx);
  auto it = impl_->sinks.find(channelId);
  return (it != impl_->sinks.end()) ? it->second.get() : nullptr;
}

link_audio::LinkAudio* ChannelRegistry::getLinkAudio() {
  std::lock_guard<std::mutex> lock(impl_->mtx);
  return impl_->link.get();
}

#else  // ORBIT_SC_PLUGIN_BUILD

// Non-plugin builds (linters, IDE indexers) get an empty translation unit.
// The header still declares the API; nothing to instantiate without the SDK.
struct ChannelRegistry::Impl {};
ChannelRegistry::ChannelRegistry() : impl_(nullptr) {}
ChannelRegistry::~ChannelRegistry() = default;
void ChannelRegistry::initLinkAudio(double, const std::string&) {}
void ChannelRegistry::shutdownLinkAudio() {}
bool ChannelRegistry::registerChannel(std::int32_t, std::string) { return false; }
SinkEntry* ChannelRegistry::lookup(std::int32_t) { return nullptr; }
link_audio::LinkAudio* ChannelRegistry::getLinkAudio() { return nullptr; }

#endif  // ORBIT_SC_PLUGIN_BUILD

}  // namespace orbitscore
