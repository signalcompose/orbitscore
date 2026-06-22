// SPDX-License-Identifier: GPL-2.0-or-later
//
// OrbitScore LinkAudio egress shim 実装。
// 呼び出す Ableton Link API は packages/sc-link-audio の channel_registry.cpp /
// orbit_link_audio_out.cpp(SC 結合実装)を参照に SC-free 化した。
//
// 例外境界の規約: Ableton Link のヘッダには noexcept 注釈が一切無いため、各 Link
// 呼び出しは throw しうる前提で扱う。C++ 例外が extern "C" を越えて Rust 側へ伝播
// すると UB なので、すべての extern "C" 関数本体で catch(...) して sentinel を返す。

// include 順序の不変条件: LinkAudio.hpp を Link.hpp より先に include する。
// LinkAudio.hpp は <ableton/link_audio/ApiConfig.hpp> を引き込み、#ifndef
// LINK_API_CONTROLLER で守られたブロックで ApiController を
// link_audio::SessionController に定義してから LINK_API_CONTROLLER を define する。
// 後から Link.hpp が引き込む <ableton/link/ApiConfig.hpp> は同名 guard を見てスキップ
// され、ApiController の再定義(link::SessionController)は起きない(first-wins)。
#include <ableton/LinkAudio.hpp>
#include <ableton/Link.hpp>
#include <ableton/util/FloatIntConversion.hpp>

#include "orbit_link_shim.hpp"

#include <cstdio>
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
  } catch (const std::exception& e) {
    std::fprintf(stderr, "[orbit-link] create failed: %s\n", e.what());
    return nullptr;
  } catch (...) {
    std::fprintf(stderr, "[orbit-link] create failed: unknown exception\n");
    return nullptr;
  }
}

void orbit_link_destroy(OrbitLink* link) {
  if (!link) return;
  try {
    link->link.enableLinkAudio(false);
    link->link.enable(false);
  } catch (...) {
    // teardown 中の例外は握りつぶす(解放は必ず行う)が、観測可能にログは残す。
    std::fprintf(stderr, "[orbit-link] destroy teardown exception (ignored)\n");
  }
  // ~OrbitLink → ~LinkAudio / ~LinkAudioSink。Link の dtor は noexcept 宣言が無い
  // (本ファイル冒頭の前提)ため、delete も例外ガードして extern "C" 越えの UB を防ぐ。
  try {
    delete link;
  } catch (...) {
    std::fprintf(stderr, "[orbit-link] destroy delete exception (ignored)\n");
  }
}

void orbit_link_enable(OrbitLink* link, int enable) {
  if (!link) return;
  const bool on = enable != 0;
  try {
    link->link.enableLinkAudio(on);
    link->link.enable(on);  // discovery worker thread / socket を起こす → throw しうる。
  } catch (const std::exception& e) {
    std::fprintf(stderr, "[orbit-link] enable failed: %s\n", e.what());
  } catch (...) {
    std::fprintf(stderr, "[orbit-link] enable failed: unknown exception\n");
  }
}

size_t orbit_link_num_peers(OrbitLink* link) {
  if (!link) return 0;
  try {
    return link->link.numPeers();
  } catch (...) {
    std::fprintf(stderr, "[orbit-link] num_peers exception, returning 0\n");
    return 0;
  }
}

int32_t orbit_link_register_channel(OrbitLink* link, const char* name,
                                    size_t max_num_samples) {
  if (!link || !name) return -1;
  try {
    auto sink = std::make_unique<ableton::LinkAudioSink>(
        link->link, std::string(name), max_num_samples);
    link->channels.push_back(std::move(sink));
    return static_cast<int32_t>(link->channels.size() - 1);
  } catch (const std::exception& e) {
    std::fprintf(stderr, "[orbit-link] register_channel failed: %s\n", e.what());
    return -1;
  } catch (...) {
    std::fprintf(stderr, "[orbit-link] register_channel failed: unknown exception\n");
    return -1;
  }
}

int orbit_link_commit_channel(OrbitLink* link, int32_t channel_id,
                              const float* interleaved, size_t buf_len,
                              size_t num_frames, size_t num_channels,
                              uint32_t sample_rate, double beats_at_begin,
                              double quantum) {
  if (!link || channel_id < 0 || !interleaved) return -1;
  const size_t idx = static_cast<size_t>(channel_id);
  if (idx >= link->channels.size() || !link->channels[idx]) return -1;

  auto& sink = *link->channels[idx];

  try {
    // この関数は GPL consumer thread(rtrb の drain 側)からのみ呼ぶ。その thread が
    // LinkAudio の "audio thread" として振る舞う。captureAudioSessionState は
    // Thread-safe:no / Realtime-safe:yes なので呼び出しスレッドを守る必要がある。
    // `beats_at_begin` は **呼び出し側が cumulative-frames から決定論再構成済み**。ここで
    // "now"(clock().micros())から計算しないことで ring latency 分の位相ずれを避ける(A4-2b-2)。
    // state は bh.commit の引数に必要なので capture する(beat 計算には使わない)。
    auto state = link->link.captureAudioSessionState();

    ableton::LinkAudioSink::BufferHandle bh(sink);
    if (!bh) return 0;  // 購読者(Live peer)なし → no-op。

    // src(interleaved)の読み出しは buf_len(=呼び出し側 slice 長)と宛先
    // bh.maxNumSamples の両方で上限を取る。maxNumSamples は宛先容量であって src 境界
    // ではないため、buf_len でも clamp しないと overread しうる。
    // num_frames*num_channels が size_t を overflow しても(現実の音声値では起きない)、
    // 下の buf_len clamp が吸収する(過小な n は under-read で memory-safe・overread にならない)。
    size_t n = num_frames * num_channels;
    if (n > buf_len) n = buf_len;
    if (n > bh.maxNumSamples) n = bh.maxNumSamples;
    for (size_t i = 0; i < n; ++i) {
      bh.samples[i] = ableton::util::floatToInt16(interleaved[i]);
    }

    const bool ok = bh.commit(state, beats_at_begin, quantum, num_frames,
                              num_channels, sample_rate);
    return ok ? 1 : -2;  // -2 = 購読者ありだが commit 拒否。
  } catch (...) {
    // egress 中の例外も "commit 失敗" として扱う(no-op と区別)。
    return -2;
  }
}

void orbit_link_set_tempo(OrbitLink* link, double bpm) {
  if (!link) return;
  try {
    auto state = link->link.captureAppSessionState();
    state.setTempo(bpm, link->link.clock().micros());
    link->link.commitAppSessionState(state);
  } catch (const std::exception& e) {
    std::fprintf(stderr, "[orbit-link] set_tempo failed: %s\n", e.what());
  } catch (...) {
    std::fprintf(stderr, "[orbit-link] set_tempo failed: unknown exception\n");
  }
}

// egress 開始時の beat anchor。captureAudioSessionState は audio-thread 専用なので、
// GPL consumer thread(= Link "audio thread")から 1 回だけ呼ぶ。失敗時は 0.0。
double orbit_link_capture_beat(OrbitLink* link, double quantum) {
  if (!link) return 0.0;
  try {
    auto state = link->link.captureAudioSessionState();
    return state.beatAtTime(link->link.clock().micros(), quantum);
  } catch (...) {
    return 0.0;
  }
}

// 現在の session tempo(BPM)。beat/frame 換算用。consumer thread から 1 回 capture する。
double orbit_link_session_tempo(OrbitLink* link) {
  if (!link) return 0.0;
  try {
    return link->link.captureAudioSessionState().tempo();
  } catch (...) {
    return 0.0;
  }
}

}  // extern "C"
