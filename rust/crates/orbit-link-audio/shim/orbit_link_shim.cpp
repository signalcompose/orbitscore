// SPDX-License-Identifier: GPL-2.0-or-later
//
// OrbitScore LinkAudio egress shim 実装。
// 呼び出す Ableton Link API は packages/sc-link-audio の channel_registry.cpp /
// orbit_link_audio_out.cpp(SC 結合実装)を参照に SC-free 化した。

// include 順序の不変条件: LinkAudio.hpp を Link.hpp より先に
// (両者が共有する LINK_API_CONTROLLER guard で link_audio 変種を勝たせる)。
#include <ableton/LinkAudio.hpp>
#include <ableton/Link.hpp>
#include <ableton/util/FloatIntConversion.hpp>

#include "orbit_link_shim.hpp"

#include <memory>
#include <string>
#include <vector>

struct OrbitLink {
  ableton::LinkAudio link;
  std::vector<std::unique_ptr<ableton::LinkAudioSink>> channels;

  OrbitLink(double bpm, std::string peer) : link(bpm, std::move(peer)) {}
};

extern "C" {

OrbitLink* orbit_link_create(double bpm, const char* peer_name) {
  try {
    std::string peer = peer_name ? std::string(peer_name) : std::string("OrbitScore");
    return new OrbitLink(bpm, std::move(peer));
  } catch (...) {
    return nullptr;
  }
}

void orbit_link_destroy(OrbitLink* link) {
  if (!link) return;
  try {
    link->link.enableLinkAudio(false);
    link->link.enable(false);
  } catch (...) {
    // teardown 中の例外は握りつぶす(解放は必ず行う)。
  }
  delete link;
}

void orbit_link_enable(OrbitLink* link, int enable) {
  if (!link) return;
  const bool on = enable != 0;
  link->link.enableLinkAudio(on);
  link->link.enable(on);
}

size_t orbit_link_num_peers(OrbitLink* link) {
  return link ? link->link.numPeers() : 0;
}

int32_t orbit_link_register_channel(OrbitLink* link, const char* name,
                                    size_t max_num_samples) {
  if (!link || !name) return -1;
  try {
    auto sink = std::make_unique<ableton::LinkAudioSink>(
        link->link, std::string(name), max_num_samples);
    link->channels.push_back(std::move(sink));
    return static_cast<int32_t>(link->channels.size() - 1);
  } catch (...) {
    return -1;
  }
}

int orbit_link_commit_channel(OrbitLink* link, int32_t channel_id,
                              const float* interleaved, size_t num_frames,
                              size_t num_channels, uint32_t sample_rate,
                              double quantum) {
  if (!link || channel_id < 0 || !interleaved) return -1;
  const size_t idx = static_cast<size_t>(channel_id);
  if (idx >= link->channels.size() || !link->channels[idx]) return -1;

  auto& sink = *link->channels[idx];

  // audio-thread surface。ring latency の分だけ "now" は buffer-begin から遅れるが、
  // OrbitScore は tempo leader なので可聴上は無害(精度要件なし・PR2b/層B で精緻化)。
  auto state = link->link.captureAudioSessionState();
  const double beats_at_begin = state.beatAtTime(link->link.clock().micros(), quantum);

  ableton::LinkAudioSink::BufferHandle bh(sink);
  if (!bh) return 0;  // 購読者(Live peer)なし → no-op。

  size_t n = num_frames * num_channels;
  if (n > bh.maxNumSamples) n = bh.maxNumSamples;
  for (size_t i = 0; i < n; ++i) {
    bh.samples[i] = ableton::util::floatToInt16(interleaved[i]);
  }

  const bool ok = bh.commit(state, beats_at_begin, quantum, num_frames,
                            num_channels, sample_rate);
  return ok ? 1 : 0;
}

void orbit_link_set_tempo(OrbitLink* link, double bpm) {
  if (!link) return;
  auto state = link->link.captureAppSessionState();
  state.setTempo(bpm, link->link.clock().micros());
  link->link.commitAppSessionState(state);
}

}  // extern "C"
