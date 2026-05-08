// link_audio_facade.hpp — single-file wrapper around <ableton/LinkAudio.hpp>.
//
// LinkAudio is documented as an alpha API. Pinning every direct dependency
// here lets us absorb upstream renames in one translation unit. Source files
// (`channel_registry.cpp`, `orbit_link_audio_out.cpp`) include this header
// instead of `<ableton/LinkAudio.hpp>` directly.

#pragma once

#ifdef ORBIT_SC_PLUGIN_BUILD
// IMPORTANT: include order. Both `<ableton/link/ApiConfig.hpp>` and
// `<ableton/link_audio/ApiConfig.hpp>` use the same `LINK_API_CONTROLLER`
// guard. If `Link.hpp` is included first, it pulls in
// `link/ApiConfig.hpp` which sets the guard — then
// `link_audio/ApiConfig.hpp` (which defines `ChannelId` / `PeerId` /
// `SessionId` aliases used by `LinkAudioSource` etc.) gets skipped, and
// `LinkAudio.hpp` fails to compile with "unknown type name 'ChannelId'".
//
// Workaround: pull `LinkAudio.hpp` in FIRST so the link_audio variant of
// the guard wins. `LinkAudio.hpp` transitively includes Link.hpp at the
// tail of `link_audio/ApiConfig.hpp`, so we still get the full Link API.
#include <ableton/LinkAudio.hpp>
#else
namespace ableton {
class LinkAudio;
class LinkAudioSink;
}  // namespace ableton
#endif

namespace orbitscore::link_audio {

#ifdef ORBIT_SC_PLUGIN_BUILD
using LinkAudio = ::ableton::LinkAudio;
using LinkAudioSink = ::ableton::LinkAudioSink;
#else
class LinkAudio;
class LinkAudioSink;
#endif

}  // namespace orbitscore::link_audio
