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

// interleaved f32 の 1 ブロックを channel に commit する。`buf_len` は interleaved の
// 要素数(= 呼び出し側 slice 長)で、shim は min(num_frames*num_channels, buf_len,
// 宛先容量)までしか読まない(overread 防止)。
// `beats_at_begin` は **呼び出し側(GPL consumer thread)が cumulative-frames から決定論
// 再構成した** buffer-begin の beat 位置。shim はこれをそのまま BufferHandle::commit に渡す
// (内部で "now"=clock().micros() から計算しない＝ring latency 分の位相ずれを避ける・A4-2b-2)。
// この関数は LinkAudio の "audio thread"(GPL consumer thread)からのみ呼ぶ(内部で
// captureAudioSessionState を呼ぶ。Thread-safe:no / Realtime-safe:yes)。
// 戻り値: 1 = commit 済 / 0 = 購読者なしで no-op / -1 = 引数不正・未登録 channel /
//         -2 = 購読者ありだが commit 失敗(拒否 or 例外)。
int orbit_link_commit_channel(OrbitLink* link, int32_t channel_id,
                              const float* interleaved, size_t buf_len,
                              size_t num_frames, size_t num_channels,
                              uint32_t sample_rate, double beats_at_begin,
                              double quantum);

// Link テンポリーダーとして BPM を push する(app-thread 経路・PR3 で配線)。
void orbit_link_set_tempo(OrbitLink* link, double bpm);

// egress 開始時の beat anchor を取得する(GPL consumer thread = "audio thread" から 1 回)。
double orbit_link_capture_beat(OrbitLink* link, double quantum);

// 現在の session tempo(BPM)を取得する(beat/frame 換算用・consumer thread から)。
double orbit_link_session_tempo(OrbitLink* link);

#ifdef __cplusplus
}  // extern "C"
#endif

#endif  // ORBIT_LINK_SHIM_H
