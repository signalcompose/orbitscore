# OrbitScore SC plugin (OrbitLinkAudio.scx) — Step 2.1 skeleton
#
# Step 2.1 (current) = skeleton only. The build is wired but cannot succeed
# until Step 2.2 adds the external_libraries submodules (SC plugin SDK +
# Ableton/link) and fills in the UGen implementation.
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
# Output: build/OrbitLinkAudio.scx

cmake_minimum_required(VERSION 3.22)
project(OrbitLinkAudio LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_OSX_DEPLOYMENT_TARGET "11.0" CACHE STRING "macOS deployment target")

# Platform guard. The plugin links against LinkAudio (alpha) and is currently
# only validated on macOS arm64. Cross-platform support belongs to a later
# Epic (see docs/development/WORK_LOG.md 6.79 "macOS arm64 only").
if(NOT APPLE)
  message(FATAL_ERROR "OrbitLinkAudio.scx is currently macOS-only. See Epic #187.")
endif()

# === Required paths ===
# These are intentionally configure-time variables (not auto-detected). The
# user — or the release pipeline (Step 4) — supplies them after running
# `git submodule update --init`. Step 2.1 skeleton just validates that the
# paths look plausible; Step 2.2 will ADD_SUBDIRECTORY / target_include into
# the actual source layouts.
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

# Apple Silicon only for v1.x. Universal binary is a release-pipeline concern.
set_target_properties(OrbitLinkAudio PROPERTIES
  OSX_ARCHITECTURES "arm64"
)

# === Notes ===
# - LinkAudio.hpp is header-only; no separate library link step is required.
# - The SC plugin SDK is also header-only for the UGen surface used here.
# - Step 2.2 will add real implementation in src/*.cpp and may extend
#   target_link_libraries if Link's asio bundle requires platform libs.
