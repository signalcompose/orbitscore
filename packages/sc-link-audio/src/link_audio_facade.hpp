// link_audio_facade.hpp — single-file wrapper around <ableton/LinkAudio.hpp>
//
// LinkAudio is documented as an alpha API. Every call OrbitScore needs flows
// through this header so that breaking changes upstream are absorbed in one
// translation unit. Step 2.2 will fill in the actual surface (Sink ctor,
// BufferHandle commit, channels callback, enable/disable). Step 2.1 keeps the
// declarations as stubs gated behind ORBIT_SC_PLUGIN_BUILD so source files
// compile in tools that lack the SDK paths (linters, IDE indexers).

#pragma once

#ifdef ORBIT_SC_PLUGIN_BUILD
#include <ableton/LinkAudio.hpp>
#include <cstdint>
#include <string>
#endif

namespace orbitscore::link_audio {

#ifdef ORBIT_SC_PLUGIN_BUILD
// Real type aliases. Once Step 2.2 starts using the SDK, prefer these aliases
// over `ableton::*` directly so future renames stay local.
using LinkAudio = ::ableton::LinkAudio;
using LinkAudioSink = ::ableton::LinkAudioSink;
#else
// Stub forward declarations so Step 2.1 source files type-check in
// environments without the SDK on the include path. These never appear in
// the final .scx — they're only here to keep the skeleton self-contained.
class LinkAudio;
class LinkAudioSink;
#endif

// Step 2.2 will populate these. Keeping the signatures here documents the
// intended surface and gives reviewers a single place to inspect the API
// dependency.
//
//   void enableLinkAudio(LinkAudio&, bool);
//   bool isLinkAudioEnabled(const LinkAudio&);
//   void publishChannel(LinkAudio&, std::string name, std::size_t maxNumSamples);
//   void commitInterleavedInt16(LinkAudioSink&, const std::int16_t* samples,
//                               std::size_t numFrames, std::size_t numChannels,
//                               std::uint32_t sampleRate, double beatsAtBufferBegin,
//                               double quantum);

}  // namespace orbitscore::link_audio
