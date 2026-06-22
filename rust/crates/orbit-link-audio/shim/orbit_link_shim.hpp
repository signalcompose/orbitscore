// SPDX-License-Identifier: GPL-2.0-or-later
//
// OrbitScore LinkAudio egress shim — C ABI.
//
// 🔴 この C++ 翻訳単位は Ableton Link(GPL-2.0-or-later/commercial dual)を呼ぶ
//    唯一の面。SuperCollider には依存しない(packages/sc-link-audio の SC 結合
//    実装を参照に SC-free 化したもの)。permissive な engine core からは Rust の
//    FFI 経由でのみ到達し、core/native/wasm が直接リンクすることはない。
#ifndef ORBIT_LINK_SHIM_H
#define ORBIT_LINK_SHIM_H

#include <cstddef>
#include <cstdint>

#ifdef __cplusplus
extern "C" {
#endif

// 1 つの Ableton Link セッションと、その上の名前付き出力 channel 群を保持する
// 不透明ハンドル。
typedef struct OrbitLink OrbitLink;

// セッションを生成する(ネットワーク discovery はまだ有効化しない)。失敗時 NULL。
OrbitLink* orbit_link_create(double bpm, const char* peer_name);

// セッションを破棄する(NULL 安全)。内部で LinkAudio/discovery を無効化してから解放。
void orbit_link_destroy(OrbitLink* link);

// LinkAudio とネットワーク discovery を有効/無効化する(enable != 0 で ON)。
void orbit_link_enable(OrbitLink* link, int enable);

// 現在の Link peer 数。
size_t orbit_link_num_peers(OrbitLink* link);

// 名前付き channel を登録し、channel id(>=0)を返す。失敗時 -1。
int32_t orbit_link_register_channel(OrbitLink* link, const char* name,
                                    size_t max_num_samples);

// interleaved f32 の 1 ブロックを channel に commit する。
// この呼び出しスレッドが LinkAudio の "audio thread" として扱われる
// (内部で captureAudioSessionState + beatAtTime を行う)。
// 戻り値: 1 = commit 済 / 0 = 購読者なしで no-op / -1 = 引数不正。
int orbit_link_commit_channel(OrbitLink* link, int32_t channel_id,
                              const float* interleaved, size_t num_frames,
                              size_t num_channels, uint32_t sample_rate,
                              double quantum);

// Link テンポリーダーとして BPM を push する(app-thread 経路・PR3 で配線)。
void orbit_link_set_tempo(OrbitLink* link, double bpm);

#ifdef __cplusplus
}  // extern "C"
#endif

#endif  // ORBIT_LINK_SHIM_H
