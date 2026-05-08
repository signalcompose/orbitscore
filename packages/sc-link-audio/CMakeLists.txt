# OrbitScore SC plugin (OrbitLinkAudio.scx).
#
# Builds a SuperCollider plugin that exposes `OrbitLinkAudioOut` and a
# `/cmd /orbit/registerLinkAudioChannel` handler. Header-only dependencies
# (SC plugin SDK + Ableton/link) are pulled in via `external_libraries/`
# submodules; no separate link step is required.
#
# Targets: macOS arm64 (Apple Silicon) only. Linux / Windows builds are out
# of scope for v1.x — see Epic #187 § "macOS arm64 only" decision.
#
# Required configure-time variables:
#   -DSC_PATH=...         path to the SuperCollider source tree (provides
#                         server/plugins headers + plugin_interface)
#   -DLINK_AUDIO_PATH=... path to the Ableton/link checkout containing
#                         include/ableton/LinkAudio.hpp and asio submodule
#
# Output: build/OrbitLinkAudio.scx (ad-hoc signed in the POST_BUILD step)

cmake_minimum_required(VERSION 3.22)
project(OrbitLinkAudio LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_OSX_DEPLOYMENT_TARGET "11.0" CACHE STRING "macOS deployment target")

# Platform guard. The plugin links against LinkAudio (alpha) and is currently
# only validated on macOS arm64; cross-platform support is a separate Epic.
if(NOT APPLE)
  message(FATAL_ERROR "OrbitLinkAudio.scx is currently macOS-only. See Epic #187.")
endif()

# === Required paths ===
# Configure-time variables (not auto-detected). The user — or the release
# pipeline — supplies them after `git submodule update --init`. We validate
# the paths up front so a missing submodule fails configure with a clear
# message rather than during compile.
if(NOT DEFINED SC_PATH)
  message(FATAL_ERROR "SC_PATH is required. Pass -DSC_PATH=external_libraries/supercollider-sdk")
endif()
if(NOT DEFINED LINK_AUDIO_PATH)
  message(FATAL_ERROR "LINK_AUDIO_PATH is required. Pass -DLINK_AUDIO_PATH=external_libraries/link")
endif()

if(NOT EXISTS "${SC_PATH}")
  message(FATAL_ERROR "SC_PATH does not exist: ${SC_PATH}. Did you run `git submodule update --init`?")
endif()
if(NOT EXISTS "${LINK_AUDIO_PATH}/include/ableton/LinkAudio.hpp")
  message(FATAL_ERROR "LINK_AUDIO_PATH does not contain LinkAudio.hpp: ${LINK_AUDIO_PATH}")
endif()

# === Plugin target ===
# .scx is a shared library with the SC plugin's special suffix on macOS.
add_library(OrbitLinkAudio MODULE
  src/orbit_link_audio_out.cpp
  src/channel_registry.cpp
)
set_target_properties(OrbitLinkAudio PROPERTIES
  PREFIX ""
  SUFFIX ".scx"
)

target_include_directories(OrbitLinkAudio PRIVATE
  src
  ${SC_PATH}/include/plugin_interface
  ${SC_PATH}/include/common
  ${SC_PATH}/server/plugins
  ${LINK_AUDIO_PATH}/include
  ${LINK_AUDIO_PATH}/modules/asio-standalone/asio/include
)

# Apple Link platform define is required by Link headers on macOS.
target_compile_definitions(OrbitLinkAudio PRIVATE
  LINK_PLATFORM_MACOSX=1
  ORBIT_SC_PLUGIN_BUILD=1
)

# Apple Silicon only. Universal binary is a release-pipeline concern.
set_target_properties(OrbitLinkAudio PROPERTIES
  OSX_ARCHITECTURES "arm64"
)

# === Post-build: ad-hoc codesign ===
# macOS code signing enforcement (post-Big-Sur) refuses to dlopen unsigned
# Mach-O bundles in signed parent processes — and the bundled `scsynth` IS
# signed (TeamIdentifier=HE5VJFE9E4). The result without a signature is a
# silent crash with `signal: SIGKILL (Code Signature Invalid)` in the
# diagnostic report and zero output on the scsynth log. Ad-hoc signing
# (`-sign -`) is sufficient for local development; production distribution
# replaces this with a Developer ID signature in the release pipeline.
add_custom_command(TARGET OrbitLinkAudio POST_BUILD
  COMMAND codesign --force --sign - $<TARGET_FILE:OrbitLinkAudio>
  COMMENT "Ad-hoc signing OrbitLinkAudio.scx (required by macOS dlopen enforcement)"
  VERBATIM
)

# === Notes ===
# - LinkAudio.hpp is header-only; no separate library link step is required.
# - The SC plugin SDK is also header-only for the UGen surface used here.
# - The companion sclang stub (`sc-classes/OrbitLinkAudio.sc`) is NOT installed
#   by this build — manually copy it next to the `.scx` in the SC Extensions
#   directory, or let the release pipeline bundle both.
