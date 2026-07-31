//! 親(host=daemon)/子(child=effect process) が共有する shared-memory レイアウトと map ヘルパ。
//!
//! file-backed mmap(MAP_SHARED) を親子双方が map し、同一物理ページを共有する。同期は
//! [`SharedRegion`] 内の atomic(`seq_request` / `seq_done` / per-slot `seq_tag`)による SPSC
//! ハンドシェイク(各ステップは 1 行で記述):
//!
//! - **host PUBLISH**: 該当 slot の `n_frames[slot]` と `input[slot]` を書く → `seq_request` を Release で進めて publish(`n_frames` は Relaxed だが Release 前に書かれ child の Acquire で可視)。
//! - **child**: `seq_request` を Acquire で読む(前回より進んだら)→ n_frames/input が可視 → `output[slot]` を書く → `seq_tag[slot] = seq` を Release(その slot の出力 publish)→ `seq_done = seq` を Release(submit guard 用の最新処理 seq)で store。
//! - **host READ**: `seq_tag[slot(target)]` を Acquire で読み `== target` なら output が可視 → 出力にコピー。global monotone な `seq_done` でなく per-slot `seq_tag` で判定するのは、child が「latest 処理」で中間 seq を skip しても、その slot の tag が target に一致せず false-fresh を防げるから(seq_done では skip を検知できない)。
//! - **host SUBMIT guard**: `seq_done` を Acquire で読み slot 再利用可否(下記不変条件)を判定する。
//! - **child readiness**: child は `ClapEffectProcessor::load` / `ClapInstrumentProcessor::load`
//!   成功直後に `child_flags` → `child_status` の順で Release store する。host は初回 `LoadPlugin` 時に
//!   `load_outproc_plugin` の ready-ack ループでこれを poll する（PR-1b・#431 で実装済み）。
//!
//! **ping-pong バッファ**: `input` / `output` は各 [`SLOTS`] 個の slot を持ち、seq を [`slot_offset`]
//! で割り当てて交替する。slot を分けることで「host が seq s の slot を書く」のと「child が seq s-k の
//! slot を読む」が別領域になり、pipelined(host が spin せず数 block ずらして読む)でも torn read を
//! 起こさない。host / child の双方が同一の `slot_offset` で index する(モード非依存)。
//!
//! **N-slot-generic(γ M1)**: spike は slot 数 2 をハードコードしていた(`seq & 1` は 2 のべき乗専用)。
//! 本番では owner が slot 数(= pipeline 深さ = latency/stall のトレードオフ)を PR-C の実測で 2 or 3 に
//! 決める。cross-process な `repr(C)` 構造に slot 数が焼き付くと後で rewrite を強制するので、最初から
//! `% SLOTS` で汎用化し、[`SLOTS`] 1 つの変更で切り替わるようにする。
//!
//! **不変条件(slot 再利用の安全)**: host は新 seq s を submit する前に `seq_done >= s - SLOTS`
//! (s の slot の前 occupant = s-SLOTS の完了)を確認する。満たさなければ submit を見送る(stall)。
//! この下では各 slot へのアクセスは時間的に排他化され、生ポインタ経由の `&mut [f32]` 形成も健全
//! (不変条件が破れると live-but-slow child との間でデータ競合 = UB になる)。

// 共有メモリは生ポインタ経由でクロスプロセス参照するため unsafe FFI 同等。
#![allow(unsafe_code)]

#[cfg(test)]
use std::cell::Cell;
use std::collections::VecDeque;
use std::fmt;
use std::fs::OpenOptions;
use std::io;
use std::num::NonZeroUsize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use memmap2::MmapMut;

use crate::events::EventRecord;

#[cfg(test)]
thread_local! {
    /// Per-thread counter keeps the mmap regression test deterministic under parallel cargo tests.
    static OPEN_SHARED_CALL_COUNT: Cell<usize> = const { Cell::new(0) };
}

/// 1 ブロックの最大フレーム数(cpal buffer の上限。これを超える callback は clamp する)。
pub const MAX_FRAMES: usize = 4096;
/// チャンネル数(stereo 固定)。
pub const CHANNELS: usize = 2;
/// 1 slot(= 1 ブロック)のインターリーブ済みバッファ長(フレーム × チャンネル)。
pub const BUF_LEN: usize = MAX_FRAMES * CHANNELS;
/// 1 ブロックあたりの event 転送窓(= shm 上の [`EventRecord`] 配列サイズ)。
///
/// 根拠 = 統計的典型性でなく「アーキテクチャ飽和点」: [`MAX_FRAMES`] と揃え、「1 sample あたり
/// 1 event」を持続転送できる水準にする(設計 doc §4.2)。これを超える密度は個別イベントでなく
/// audio-rate 変調が正しい表現媒体であり、"天井" ではなく表現媒体の境界になる。窓に載りきらない
/// 分は host 側 backing ring / child 側 spill FIFO が lossless に遅延配送する(§4.2)。
pub const MAX_EVENTS_PER_BLOCK: usize = 4096; // = MAX_FRAMES
/// ping-pong の slot 数(= pipeline 深さ)。
///
/// PR-C の gated 実機計測(32f stall/latency)で 2 or 3 に確定する。`% SLOTS` 方式なので
/// この const を変えるだけで slot 数が切り替わる(レイアウト・index・outstanding guard が連動)。
/// 2 以上であること(連続 seq が必ず別 slot を指す前提)。
pub const SLOTS: usize = 2;

// SLOTS は 2 以上でなければならない(連続 seq が別 slot を指す = pipelined で s と s-1 が衝突しない
// 前提。outstanding guard も seq-SLOTS を見る)。PR-C で 2→3 にする際の床を compile-time に固定。
const _: () = assert!(SLOTS >= 2);

/// child → host の取りこぼし不可イベント用 slot 数（UIH.2a）。
///
/// audio pipeline の [`SLOTS`] とは導出根拠が異なる。1 close cycle で同時に in-flight に
/// なりうる `UI_CLOSED` + `UI_CLOSED_DONE` の2件から固定される。
pub const EVT_SLOTS: usize = 2;

// spec (PLUGIN_UI_HOSTING_SPEC_v1.md) の 🔴 `EVT_SLOTS >= 2`(連続 seq が必ず別 slot を指す
// 不変条件)の床。鏡像元 `SLOTS` の const assert と同じ役目を evt 側でも compile-time に固定する。
const _: () = assert!(EVT_SLOTS >= 2);

/// seq に対応する slot のインデックス(`0..SLOTS`)。per-slot メタデータ配列(`seq_tag` /
/// `n_frames`)の添字に使う。`slot_offset` はこれを [`BUF_LEN`] 倍したバッファ要素オフセット。
#[inline]
pub fn slot_index(seq: u64) -> usize {
    seq as usize % SLOTS
}

/// evt seq に対応する slot のインデックス(`0..EVT_SLOTS`)。`evt_kind` / `evt_arg` の添字に使う。
///
/// [`slot_index`] と式は同じだが定数が違う([`EVT_SLOTS`] は close cycle の占有上限から、
/// [`SLOTS`] は pipeline 深さから導出される別物)。裸の `% EVT_SLOTS` を散らさず本関数に集約し、
/// 「定数 1 つと関数 1 つを変えれば slot 割り当てが切り替わる」構造を evt 側でも保つ。
#[inline]
pub fn evt_slot_index(seq: u64) -> usize {
    seq as usize % EVT_SLOTS
}

/// seq に対応する slot の開始要素オフセット(ping-pong: `seq % SLOTS` で [`SLOTS`] 個を循環)。
/// host / child の双方がこれで `input` / `output` を index する(モード非依存)。
#[inline]
pub fn slot_offset(seq: u64) -> usize {
    slot_index(seq) * BUF_LEN
}

/// `control` の値: child は spin を続ける。
pub const CONTROL_RUN: u32 = 0;
/// `control` の値: host が child に spin loop を抜けて正常終了するよう要求する。
pub const CONTROL_QUIT: u32 = 1;

/// child が実際にロードした CLAP plugin の readiness（PR-431・child→host handshake）。
/// 0 = starting（child がまだ load 中）。
pub const CHILD_STATUS_STARTING: u32 = 0;
/// child が load に成功し、以降 process loop に入る状態。
pub const CHILD_STATUS_READY: u32 = 1;
/// **現状は未使用の予約値**（child が load に失敗して終了する直前の状態を表す想定）。
/// child は load 失敗時 `?` の早期 return でこの値を書かずにそのままプロセス終了する。PR-1c (#441)
/// では watchdog が初回 attach 中の child exit を stats に publish し、host が timeout を待たずに
/// retryable attach failure として返す。
///
/// **respawn 注意**: shm は daemon 起動時に一度だけ truncate され、respawn（`EffectChildSupervisor`/
/// `InstrumentChildSupervisor` の watchdog による再起動）は同一 shm を再利用する（再 truncate しない）
/// ため、一度 READY に達した後の respawn 失敗では `child_status` は STARTING でなく前 incarnation の
/// READY が残留する。PR-1b（#440）は spawn 直前の `reset_child_starting` による STARTING リセット
/// のみを実装し、この前 incarnation の READY 残留誤認を解消した。一方、初回 attach 時に child が
/// `CHILD_STATUS_LOAD_FAILED` は現状も write 箇所なしの予約値であり、early-exit は上記 watchdog
/// signal で検出する。
pub const CHILD_STATUS_LOAD_FAILED: u32 = 2;

/// child のロード結果を表す bit flags（PR-431）。bit0 = has_audio_input
/// （`orbit_clap_host::buffers::HostAudioBuffers::has_audio_input()` 相当）。effect/instrument の
/// 実体判定に使い、PR-1b で role 不一致検証に使う予定（本 PR では書き込みのみ）。
pub const CHILD_FLAG_HAS_AUDIO_INPUT: u32 = 1 << 0;

/// per-block の演奏文脈(event ではなく block header・設計 doc §4.5)。CLAP/VST3/AU が process
/// 呼び出しのたびに共通して消費する transport metadata の superset。host -> child のみ(child から
/// の逆方向は無い)。`SLOTS` 単位で持つ理由は `n_frames`/`seq_tag` と同じ: 各 child が自分の
/// ペースでスロットを消費するため、消費時点で有効だった値を保証するには per-slot 保持が要る。
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TransportContext {
    /// 0.0 = 未供給(#408 の plumbing 完了までは 0.0 になりうる、という sentinel)。
    pub tempo_bpm: f64,
    pub time_sig_numerator: u16,
    pub time_sig_denominator: u16,
    /// POD union の安全性規約(events モジュール参照)に合わせ bool でなく u8。
    pub is_playing: u8,
    pub is_looping: u8,
    /// 直近 block 先頭の楽曲内位置(拍単位・四分音符=1.0)。
    pub song_position_beats: f64,
}

/// 親子で共有する制御ブロック + audio バッファ。
///
/// `#[repr(C)]` でフィールド順を固定し、`align(64)` でキャッシュライン境界に載せる。親子は
/// 同一 crate の同一レイアウトでコンパイルされるが、レイアウト不変性を明示するため repr(C) を付ける。
/// mmap のベースはページ境界(>= 4096)なので 64-byte align は常に満たされる。
///
/// atomic フィールドはクロスプロセスで可視(MAP_SHARED)。`input` / `output` は生 f32 配列で、
/// 可視性順序は `seq_request` / `seq_done` の Acquire/Release が与える(モジュール doc 参照)。
/// effect の load-time param(gain 等)や plugin path は SharedRegion ではなく child の起動引数で
/// 渡す(M1 は per-block automation 無し。SharedRegion は audio + handshake に限定して clean に保つ)。
#[repr(C, align(64))]
pub struct SharedRegion {
    /// host が input/n_frames 書き込み後に進める。child はこれが前回値より進むのを待つ。
    pub seq_request: AtomicU64,
    /// child が処理し終えた **最新** request seq(monotone)。host の **submit guard** が slot 再利用
    /// 可否(`seq_done >= new_seq - SLOTS`)に使う。READ の fresh 判定には使わない(それは per-slot
    /// [`SharedRegion::seq_tag`]。global monotone な seq_done では「latest 処理」の skip を検知できない)。
    pub seq_done: AtomicU64,
    /// child が処理したブロック総数(観測用。respawn 後の処理再開を可視化する)。
    pub child_processed: AtomicU64,
    /// **child -> host health signal**(γ M1 PR-C・carry-forward ①): child の per-block 処理
    /// (`plugin.process()`)が失敗したブロックの累積数。child が `fetch_add` で書き、host(supervisor /
    /// accessor)が読む。effect は失敗時 dry 素通し・instrument は無音になるため、この counter だけが
    /// 失敗の可視化手段になる(silent-failure 防止)。**child が crash しても host は mmap を保持し続けるので
    /// 値は読める**(supervisor の respawn で同一 shm を再利用するため child を跨いで累積する)。supervisor
    /// 側の `respawn_count` / `last_respawn_ns` / `measurement_invalid`(child の異常終了を host が
    /// 観測する signal)は host-side atomic で別に持つ(SharedRegion ではない)。gain child(PR-A)は
    /// 失敗経路を持たないので増分せず 0 のまま。
    pub child_process_error_count: AtomicU64,
    /// host -> child の制御フラグ([`CONTROL_RUN`] / [`CONTROL_QUIT`])。host が teardown 時に
    /// QUIT を store し、child は spin loop の各周回で確認して正常終了する(kill より clean)。
    pub control: AtomicU32,
    /// **per-slot**: child が各 slot に書いた output の seq。child は output 書き込み後 Release で store し、
    /// host は READ 時に `seq_tag[slot(target)] == target` を Acquire で確認してから読む(その Acquire が
    /// 当該 slot の output 書き込みを可視化する)。child が「latest 処理」で中間 seq を skip しても、その
    /// slot の tag は target に一致しないので host は false-fresh せず repeat-previous に落ちる。
    pub seq_tag: [AtomicU64; SLOTS],
    /// **per-slot**: 各 slot の有効フレーム数(<= MAX_FRAMES)。host が submit 時に該当 slot へ書き、child
    /// はその slot の値で処理長を決め、host は READ 時に copy 長の clamp に使う。pipelined で host が次 block
    /// (別フレーム数)を submit 済みでも、各 slot は自分の正しい長さを持つ(単一 n_frames だと取り違える)。
    pub n_frames: [AtomicU32; SLOTS],
    /// host -> child のインターリーブ入力(ping-pong: SLOTS 個の block。`slot_offset` で index)。
    pub input: [f32; BUF_LEN * SLOTS],
    /// child -> host のインターリーブ出力(ping-pong: SLOTS 個の block。`slot_offset` で index)。
    pub output: [f32; BUF_LEN * SLOTS],

    // ── M2 instrument IPC substrate(設計 doc §4.2/§4.5・Issue #416)。event を消費しない
    // effect child(M1)は以下を一切参照しない(値は 0 のまま残る)。
    /// **per-slot**: host -> child の event 転送窓([`MAX_EVENTS_PER_BLOCK`] 個)。host 側 backing
    /// ring から該当 seq ぶんだけ transcribe する。child は自分の消費ポリシー(§4.6: event を
    /// 消費する child は in-order 必須)に従い、対応する slot の `input_event_count` 個ぶんだけ読む。
    pub input_events: [[EventRecord; MAX_EVENTS_PER_BLOCK]; SLOTS],
    /// **per-slot**: 該当 slot の `input_events` に有効な件数(<= MAX_EVENTS_PER_BLOCK)。`n_frames`
    /// と同じ「Relaxed store → Release publish(`seq_request`)で可視」規律に従う。
    pub input_event_count: [AtomicU32; SLOTS],
    /// **per-slot**: child -> host の event 転送窓(NoteEnd/LegacyMidiCcOut 等)。child 側の
    /// spill FIFO(§4.2 output 方向)から drain して詰める。
    pub output_events: [[EventRecord; MAX_EVENTS_PER_BLOCK]; SLOTS],
    /// **per-slot**: 該当 slot の `output_events` に有効な件数。host は読み取り時にこれを
    /// [`MAX_EVENTS_PER_BLOCK`] で clamp してから走査する(child は別プロセスで汚染されうる値)。
    pub output_event_count: [AtomicU32; SLOTS],
    /// host 側 backing ring 自体が尽きた場合のみ増分(真の drop・health signal)。
    pub input_event_dropped_count: AtomicU64,
    /// host 側 backing ring 経由の無損失な1ブロック超遅延(情報用・health signal)。
    pub input_event_spilled_count: AtomicU64,
    /// child-local spill FIFO(§4.2 output 方向)自体が尽きた場合のみ増分(真の drop)。
    pub output_event_dropped_count: AtomicU64,
    /// child-local spill FIFO 経由の無損失な1ブロック超遅延(情報用)。
    pub output_event_spilled_count: AtomicU64,
    /// 上記 output 方向 drop に `NoteEnd` が含まれた回数(host の簿記リセット判断トリガ)。
    pub output_note_end_dropped_count: AtomicU64,
    /// [`EventRecord::decode`] が未知 kind / nested enum 範囲外値を skip した回数(validated
    /// decode の可視化。呼び出し側が増分する)。
    pub event_decode_error_count: AtomicU64,
    /// **per-slot**: host -> child の per-block 演奏文脈(§4.5)。child からの逆方向は無い。
    pub transport_context: [TransportContext; SLOTS],
    /// **child -> host readiness signal**（PR-431）。child は load 成功後、[`SharedRegion::child_flags`]
    /// を先に Release store してから本 field を [`CHILD_STATUS_READY`] に Release store する。
    pub child_status: AtomicU32,
    /// child が実際にロードした plugin の role 判定用 bit flags（[`CHILD_FLAG_HAS_AUDIO_INPUT`]）。
    pub child_flags: AtomicU32,

    // ── #555: コマンドメールボックス（`PLUGIN_UI_HOSTING_SPEC_v1.md` UIH.2）。
    //
    // 既存の `control`（RUN/QUIT の2値）は teardown 経路で `reset_control_run` により
    // RUN へ戻されるため、コマンドの意味論を同じフィールドに載せると teardown と競合する。
    // **独立したメールボックスを追加する。**
    //
    // 可変長データ（state は数十 MB になりうる）はここを通さない。host が
    // `cmd_arg` に command 固有の文字列（state sidecar の絶対パス、UI の window title 等）を書く。
    /// host -> child: 新規コマンド投函時に単調増加させる。0 = 未発行。
    pub cmd_seq: AtomicU64,
    /// host -> child: コマンド種別（[`CMD_SAVE_STATE`] 等）。
    pub cmd_kind: AtomicU32,
    /// host -> child: 固定長の引数域（サイドカーファイルの絶対パス・NUL 終端 UTF-8）。
    pub cmd_arg: [u8; CMD_ARG_BYTES],
    /// child -> host: 処理を完了した `cmd_seq`。host はこれで完了を判定する。
    pub cmd_ack_seq: AtomicU64,
    /// child -> host: 結果コード（[`CMD_RESULT_OK`] / 以外は失敗）。
    pub cmd_result: AtomicU32,
    /// child -> host: 成功時は書き込んだバイト数、失敗時は 0。
    pub cmd_result_len: AtomicU64,
    /// child -> host: 失敗理由（NUL 終端 UTF-8・空なら理由なし）。**silent failure を防ぐ**。
    pub cmd_result_detail: [u8; CMD_DETAIL_BYTES],

    // ── #474 P2: child → host の取りこぼし不可イベントリング（UIH.2a）。
    /// child -> host: 新規イベント投函時に単調増加。0 = 未発行。
    pub evt_seq: ReleaseAcquireSeq,
    /// child -> host: per-slot イベント種別（[`EVT_UI_CLOSED`] / [`EVT_UI_CLOSED_DONE`]）。
    pub evt_kind: [AtomicU32; EVT_SLOTS],
    /// child -> host: per-slot 固定長引数域（NUL 終端 UTF-8）。
    pub evt_arg: [[u8; EVT_ARG_BYTES]; EVT_SLOTS],
    /// host -> child: host 側処理が完結した最新の `evt_seq`。
    ///
    /// `s` は「`s` 以下の全イベントが完結済み」を意味するため、host は seq 順にのみ進める。
    pub evt_ack_seq: ReleaseAcquireSeq,
    /// child -> host: plugin dirty 通知の累積回数。respawn ではリセットしない。
    pub dirty_epoch: MonotoneEpoch,
}

/// `cmd_arg` のバイト長。command 固有文字列を収める（state sidecar の絶対パスは macOS の
/// PATH_MAX = 1024、UI command では window title）。
pub const CMD_ARG_BYTES: usize = 1024;
/// `cmd_result_detail` のバイト長。
pub const CMD_DETAIL_BYTES: usize = 256;
/// `evt_arg` のバイト長。close 完了理由等の短い付随情報を NUL 終端で収める。
pub const EVT_ARG_BYTES: usize = CMD_DETAIL_BYTES;
/// `arg` が `evt_arg` に収まらない時の差し替え文言の**接頭辞**（規律1・
/// [`EventRingChild::queue`] 参照）。実際に書かれる文言は
/// `"{EVT_ARG_FALLBACK} (original len N)"` — 元 arg のバイト長を必ず含める。
/// child プロセスには tracing subscriber が無く、host が原因（何バイトの arg が
/// 収まらなかったか）に迫れる唯一の経路が `evt_arg` の文言そのものだから。
/// [`service_command_mailbox`] の `"detail too long"` フォールバックの evt 側対応物。
pub const EVT_ARG_FALLBACK: &str = "arg too long or embedded NUL";

// フォールバック文言全体（接頭辞 + " (original len " + u64 最大 20 桁 + ")"）が NUL 終端
// 1 バイトぶんの余白を残して EVT_ARG_BYTES に静的に収まる床（`<` が NUL の 1 バイト）。
// queue() はこの保証を前提に書き込み結果を検査しない。
const _: () =
    assert!(EVT_ARG_FALLBACK.len() + " (original len ".len() + 20 + ")".len() < EVT_ARG_BYTES);

/// コマンド種別: 未発行（`cmd_seq == 0` と対）。
pub const CMD_NONE: u32 = 0;
/// コマンド種別: 現在の plugin state を `cmd_arg` のパスへ書き出す（#555）。
pub const CMD_SAVE_STATE: u32 = 1;
/// コマンド種別: plugin UI を開く（#474 P3）。
pub const CMD_OPEN_UI: u32 = 2;
/// コマンド種別: plugin UI の非同期 close handshake を開始する（#474 P3）。
pub const CMD_CLOSE_UI: u32 = 3;

/// イベント種別: 未発行（`evt_seq == 0` と対）。
pub const EVT_NONE: u32 = 0;
/// イベント種別: plugin 起点の UI close が始まった。
pub const EVT_UI_CLOSED: u32 = 1;
/// イベント種別: UI close 手続きが完了した。
pub const EVT_UI_CLOSED_DONE: u32 = 2;

pub use evt_sync::{MonotoneEpoch, ReleaseAcquireSeq};

/// evt リングの Ordering を型に封じる submodule（UIH.2a）。
///
/// `evt_arg` は非 atomic の `[u8; N]` で、直前の `std::ptr::write` を可視化するには
/// publish/read と ack/reuse の両方に Release/Acquire 対が**必須**（欠けると UB データレース）。
/// この必須性はテストでは守り切れない（ordering 定数の値を検査するテストは同語反復になり、
/// 呼び出し箇所の逸脱を検出できない）ため、**呼び出し箇所が Ordering を渡せない API** に固定する:
/// 内部の `AtomicU64` は本 submodule の外から不可視なので、
/// `evt_seq.store(seq, Ordering::Relaxed)` のような逸脱は**コンパイルできない**。
///
/// **同じ限界は「プログラム順序」の規律にもある**: payload（`evt_kind` / `evt_arg`）を
/// 書き終えてから [`ReleaseAcquireSeq::publish`] を呼ぶ、という呼び出し側の順序は本型でも
/// 強制できず、単一スレッドのユニットテストでは原理的に検出できない（program order 内では
/// どちらの順でも同じ結果になる）。publish を payload より先に呼ぶ逸脱はレビューだけが
/// ガードなので、`EventRingChild::service` の書き込み順を変えるときはこの doc に立ち返ること。
///
/// **既存の atomic フィールドには適用していない**（`cmd_seq` / `cmd_ack_seq` /
/// `seq_request` / `seq_tag` 等は生の `AtomicU64` のままで、呼び出し箇所ごとに Ordering を
/// 手書きする）。同型へ揃えるかは別工程 — `seq_request` / `seq_tag` は audio hot path が
/// 触るため、本 PR（#474 P2）の差分から大きくはみ出す。**新しい部分だけ守った状態である**
/// ことを承知の上での段階的導入であり、既存側が安全でないという意味ではない。
mod evt_sync {
    use std::sync::atomic::{AtomicU64, Ordering};

    /// Release publish / Acquire read を型に固定した seq カーソル。
    ///
    /// `evt_seq`（payload publish → host read の対）と `evt_ack_seq`（ack → slot 再利用の対）の
    /// 両方が使う。[`SharedRegion`](super::SharedRegion) の repr(C) レイアウトを変えないため
    /// `repr(transparent)`（shm の zero 初期化とも互換）。
    #[repr(transparent)]
    pub struct ReleaseAcquireSeq(AtomicU64);

    impl ReleaseAcquireSeq {
        /// 非 atomic payload を書き終えた後に seq を公開する。Release store 固定。
        pub fn publish(&self, seq: u64) {
            self.0.store(seq, Ordering::Release);
        }

        /// 対岸の [`Self::publish`] と synchronizes-with する読み。Acquire load 固定。
        pub fn read(&self) -> u64 {
            self.0.load(Ordering::Acquire)
        }

        /// このフィールドの唯一の書き手自身による読み。自分の store とは program order で
        /// 整合するため Relaxed で十分（対岸の payload とは同期しない点に注意）。
        pub fn load_own(&self) -> u64 {
            self.0.load(Ordering::Relaxed)
        }
    }

    /// 累積水位（respawn でもリセットしない単調増加カウンタ）。`dirty_epoch` が使う。
    #[repr(transparent)]
    pub struct MonotoneEpoch(AtomicU64);

    impl MonotoneEpoch {
        /// 水位を 1 進め、新しい水位を返す。Release RMW 固定。
        ///
        /// `evt_seq` と違い `checked_add` を使わないのは意図的な非対称: こちらは通知スレッドを
        /// 問わない atomic RMW（`fetch_add`）で、overflow 検査を挟むには CAS ループ化が要る一方、
        /// 水位は slot 再利用判定に使われない（wrap しても UB クラスの故障に接続しない）ため
        /// u64 の実用上尽きない範囲で wrapping を許容する。
        pub fn increment(&self) -> u64 {
            self.0.fetch_add(1, Ordering::Release).wrapping_add(1)
        }

        /// [`Self::increment`] と synchronizes-with する読み。Acquire load 固定。
        pub fn read(&self) -> u64 {
            self.0.load(Ordering::Acquire)
        }
    }

    // repr(C) の SharedRegion に埋め込むため、newtype がレイアウトを変えないことを
    // コンパイル時に固定する（repr(transparent) の宣言忘れ・剥がし事故のガード）。
    const _: () = assert!(size_of::<ReleaseAcquireSeq>() == size_of::<AtomicU64>());
    const _: () = assert!(size_of::<MonotoneEpoch>() == size_of::<AtomicU64>());
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PendingEvent {
    kind: u32,
    arg: [u8; EVT_ARG_BYTES],
}

/// child 側の取りこぼし不可イベント投函器（UIH.2a）。
///
/// [`Self::queue`] したイベントは [`Self::service`] が slot 再利用 guard に阻まれても
/// `pending` に残り、次の main-runloop tick で再試行できる。単一 child main thread から使う。
#[derive(Debug, Default)]
pub struct EventRingChild {
    pending: VecDeque<PendingEvent>,
}

/// [`EventRingChild`] の失敗。**`arg` のエンコード失敗はここに無い**（規律1:
/// 取りこぼし不可イベントを付随情報の失敗に巻き込まない — [`EventRingChild::queue`] 参照）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EventRingChildError {
    /// 呼び出し側のプログラミングエラー。「どのイベントか」自体が不明なので、
    /// フォールバックで enqueue するものが存在せず `Err` のままにする。
    UnknownKind(u32),
    SequenceExhausted,
}

impl fmt::Display for EventRingChildError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnknownKind(kind) => write!(f, "unsupported child event kind {kind}"),
            Self::SequenceExhausted => write!(f, "event ring sequence exhausted"),
        }
    }
}

impl std::error::Error for EventRingChildError {}

impl EventRingChild {
    pub fn new() -> Self {
        Self::default()
    }

    /// 取りこぼし不可イベントを保留する。実際の shm 投函は [`Self::service`] が行う。
    ///
    /// **規律1（[`service_command_mailbox`] の detail フォールバックの継承）**: `arg` が
    /// [`EVT_ARG_BYTES`] に収まらない・埋め込み NUL を含む場合でも、イベント自体は**必ず**
    /// enqueue する。arg は「[`EVT_ARG_FALLBACK`] + 元 arg のバイト長」へ差し替える。
    /// spec（UIH.2a）が取りこぼし不可と規定する `UI_CLOSED` / `UI_CLOSED_DONE` は、
    /// 動的な detail（OS エラー文字列・パス等）のエンコード失敗を理由に消えてはならない —
    /// 呼び出し元が `Result` を読み捨てると MCP `close_plugin_ui` の完了判定が永遠に閉じない。
    ///
    /// **差し替えの可視化は `evt_arg` の文言自体が担う**（host は poll で読める）。
    /// `tracing::warn!` も併発するが、これは best-effort — 本メソッドが走る child バイナリ
    /// （`orbit-vst3-*-child` / `orbit-clap-*-child`）は tracing subscriber を初期化しない
    /// ため、production では何も出力されない（`tracing` は global subscriber 未設定なら
    /// 黙って no-op）。warn が観測されるのは subscriber を持つ in-process 利用・テストのみ。
    ///
    /// `Err` は [`EventRingChildError::UnknownKind`] のみ（enum doc 参照）。
    pub fn queue(&mut self, kind: u32, arg: &str) -> Result<(), EventRingChildError> {
        if !matches!(kind, EVT_UI_CLOSED | EVT_UI_CLOSED_DONE) {
            return Err(EventRingChildError::UnknownKind(kind));
        }
        let mut bytes = [0; EVT_ARG_BYTES];
        if !write_cstr_field(&mut bytes, arg) {
            tracing::warn!(
                kind,
                arg_len = arg.len(),
                "event arg does not fit or contains NUL; replacing with fallback"
            );
            // 元の長さを host まで運ぶ（原因追跡の唯一の経路 — 上記 doc 参照）。
            // 文言全体が EVT_ARG_BYTES に収まることは EVT_ARG_FALLBACK 脇の const assert が保証。
            let fallback = format!("{EVT_ARG_FALLBACK} (original len {})", arg.len());
            let _ = write_cstr_field(&mut bytes, &fallback);
        }
        self.pending.push_back(PendingEvent { kind, arg: bytes });
        Ok(())
    }

    /// まだ shm へ publish できていない取りこぼし不可イベントの件数。
    /// 0 は「保留なし」を意味する(`is_empty` は同じ状態の別表現になるため置かない)。
    pub fn pending_len(&self) -> usize {
        self.pending.len()
    }

    /// リングがドレーン済みか（保留 0 件 かつ `evt_ack_seq == evt_seq`）。
    ///
    /// `evt_ack_seq` は host の Release publish を Acquire で読み、`evt_seq` は child 自身が
    /// publish するカーソルなので own-writer load を使う。Ordering は [`ReleaseAcquireSeq`]
    /// の型固定 API に委ね、ここでは手書きしない。
    ///
    /// # Safety
    /// `region` は生存中の [`SharedRegion`] を指していなければならない。
    pub unsafe fn is_drained(&self, region: *const SharedRegion) -> bool {
        self.pending.is_empty()
            && unsafe { (*region).evt_ack_seq.read() == (*region).evt_seq.load_own() }
    }

    /// slot が空く限り保留イベントを seq 順に publish する。
    ///
    /// `evt_ack_seq >= s - EVT_SLOTS` が偽なら先頭イベントを保持したまま戻る。payload を先に
    /// 書き、最後の `evt_seq` Release store で host に公開する。
    ///
    /// # Safety
    /// `region` は生存中の [`SharedRegion`] を指し、本メソッドの呼び出しは child の単一
    /// main thread に直列化されていなければならない。
    pub unsafe fn service(
        &mut self,
        region: *mut SharedRegion,
    ) -> Result<usize, EventRingChildError> {
        let mut published_count = 0;
        while let Some(event) = self.pending.front() {
            let previous = unsafe { (*region).evt_seq.load_own() };
            let seq = previous
                .checked_add(1)
                .ok_or(EventRingChildError::SequenceExhausted)?;
            let reusable_after = seq.saturating_sub(EVT_SLOTS as u64);
            let ack = unsafe { (*region).evt_ack_seq.read() };
            if ack < reusable_after {
                break;
            }

            let index = evt_slot_index(seq);
            unsafe {
                (*region).evt_kind[index].store(event.kind, Ordering::Relaxed);
                std::ptr::write(std::ptr::addr_of_mut!((*region).evt_arg[index]), event.arg);
                (*region).evt_seq.publish(seq);
            }
            self.pending.pop_front();
            published_count += 1;
        }
        Ok(published_count)
    }
}

/// host handler に渡す、shm から所有領域へコピー済みのイベント。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventRingEvent {
    pub seq: u64,
    pub kind: u32,
    arg: [u8; EVT_ARG_BYTES],
}

impl EventRingEvent {
    pub fn arg(&self) -> Option<&str> {
        read_cstr_field(&self.arg)
    }
}

/// [`EventRingHost::poll`] の結果。**idle / 前進 / 先頭で停止を型で区別する**（規律3:
/// [`CommandMailboxError::Timeout`] が停滞を型で loud にするのと同じ姿勢）。
///
/// spec の「故障時の脱出条件」（host は QUIT を立てる前に保留イベントを解決し、解決できない
/// ものは loud に報告して打ち切る）の判定材料を呼び出し元へ返す: [`Self::Blocked`] の
/// `seq` / `kind` が「何が解決できていないか」の報告内容そのものになる。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventPollOutcome {
    /// 新規イベントは無かった（`evt_ack_seq == evt_seq`）。
    Idle,
    /// 新規イベントを `handled` 件完結し ack した。未 ack は残っていない。
    /// 「>= 1」はコメントでなく型が保証する（0 件の前進は [`Self::Idle`] であり、
    /// `Advanced { handled: 0 }` は構築できない）。
    Advanced { handled: NonZeroUsize },
    /// handler が `seq` / `kind` のイベントの完結を拒んだ。`handled` 件はその前に ack 済み。
    /// 同じ seq が次回 poll の先頭に再登場する（seq 順処理: 追い越して前進しない）。
    Blocked { handled: usize, seq: u64, kind: u32 },
}

/// host 側の seq 順イベント consumer と dirty 水位 observer（UIH.2a）。
///
/// **evt カーソルを保持しない**（読む位置は毎 [`Self::poll`] で shm の `evt_ack_seq + 1` から
/// 導出する）。これは [`reset_child_starting`] が respawn 時に `evt_seq` / `evt_ack_seq` を
/// 0 に戻せる前提条件。カーソルフィールドを足す前に、同関数内の不変条件コメントを読むこと
/// （`last_seen_dirty_epoch` は累積水位 `dirty_epoch` に対する watermark であり、
/// `dirty_epoch` を respawn でリセットしないからこそ保持できている — 対になる設計）。
///
/// **スレッド安全性（`read → handler → ack` の原子性）**: [`Self::poll`] は `AtomicBool` の
/// CAS ゲートで排他する。[`CommandMailboxHost`] の「投函と reset の短い critical section
/// だけを `Mutex` で守り、待ち中は保持しない」規律とは**意図的に粒度が異なる**: evt 側は
/// handler の完了と `evt_ack_seq` の ack publish が原子でないと lost-update（同一イベントの
/// 重複処理）が起きるため、handler を含む全区間をゲートが覆う。任意の呼び出し元コード
/// （handler）がゲート内で走る以上、ブロッキングロックでは再入 = 自己 deadlock・
/// panic = 恒久 poison になる — だから待たずに fail-loud する CAS を使う。
///
/// この型が**提供する保証**:
/// - poll の read → handler → ack サイクルは host プロセス内で同時に 1 本しか走らない。
///   `evt_ack_seq` の Relaxed 読み（[`ReleaseAcquireSeq::load_own`]）が前提とする
///   「唯一の書き手」はこの排他が与える（child は `evt_ack_seq` を読むだけで書かない）。
/// - handler が panic してもゲートは RAII（[`PollGateGuard`]）で解放され、**次の poll は
///   成功する**（恒久 poison は無い）。panic したイベントは未 ack のまま残り、次の poll が
///   同じ seq から再配送する（handler が `false` を返したのと同じ位置に落ちる）。
///
/// この型が**提供しない保証**:
/// - **並行 poll の待機・直列化はしない**: ゲートが取れない poll は待たずに即 `Err` を返す。
///   **handler の中から同じ host の poll を呼ぶ再入も同じ `Err`**（deadlock はしないが
///   成功もしない）。UIH.2a の想定 poller は単一なので、複数スレッドから poll する設計に
///   変えるなら retry / 直列化は呼び出し側が持つこと。
/// - **[`reset_child_starting`] との排他**: 同関数はこのゲートの外にいる。従来どおり
///   `# Safety` 契約（watchdog が host 側の poll も静穏化してから呼ぶ）が要求する。
///
/// [`Self::observe_dirty_epoch`] は `fetch_max` の RMW で自己完結して並行安全なため
/// ゲートを取らない。現在は transport の不変条件テストだけが使う。
#[derive(Debug)]
pub(crate) struct EventRingHost {
    shm_path: PathBuf,
    /// poll の read → handler → ack publish サイクルの排他フラグ（struct doc 参照）。
    /// `true` = poll 実行中。`Mutex` にしない理由も struct doc が持つ。
    poll_gate: AtomicBool,
    #[allow(dead_code)]
    last_seen_dirty_epoch: AtomicU64,
}

/// [`EventRingHost::poll_gate`] を handler panic 時にも確実に解放する RAII ガード。
///
/// これが `Mutex` の poison に対する回復経路の代替: unwind 中も `Drop` は走るので、
/// panic を跨いだ次の poll が恒久失敗しない。
struct PollGateGuard<'a>(&'a AtomicBool);

impl Drop for PollGateGuard<'_> {
    fn drop(&mut self) {
        // Release store: 本 poll が書いた evt_ack_seq を、次にゲートを獲得する poll の
        // Acquire CAS へ可視化する（Mutex の unlock → lock と同じ happens-before を張る）。
        self.0.store(false, Ordering::Release);
    }
}

impl EventRingHost {
    pub(crate) fn new(shm_path: PathBuf) -> Self {
        Self {
            shm_path,
            poll_gate: AtomicBool::new(false),
            last_seen_dirty_epoch: AtomicU64::new(0),
        }
    }

    /// publish 済みイベントを `evt_ack_seq + 1` から順に処理する。
    ///
    /// handler が `true` を返したイベントだけを完了済みとして Release ack する。`false` なら
    /// その seq を未 ack のまま残し、後続を追い越さずに [`EventPollOutcome::Blocked`] を返す
    /// （idle との区別は戻り値の型が持つ — 規律3）。
    ///
    /// **再入不可**: handler の中から同じ host の poll を（直接・間接を問わず）呼ぶと、
    /// deadlock ではなく `Err` を返す。並行 poll も同様（待たない）。保証の全体は
    /// struct doc の「提供する保証 / 提供しない保証」を参照。
    pub(crate) fn poll<F>(&self, handler: F) -> io::Result<EventPollOutcome>
    where
        F: FnMut(EventRingEvent) -> bool,
    {
        let mmap = open_shared(&self.shm_path)?;
        self.poll_mapped(region_ptr(&mmap), handler)
    }

    /// `region` をすでに map 済みの coordinator 向け変種。poll gate と ack 規律は
    /// [`Self::poll`] と同一で、mapping の所有権だけを呼び出し側に残す。
    fn poll_mapped<F>(
        &self,
        region: *mut SharedRegion,
        mut handler: F,
    ) -> io::Result<EventPollOutcome>
    where
        F: FnMut(EventRingEvent) -> bool,
    {
        // 排他の設計判断（CAS ゲート・fail-loud・panic 回復）は struct doc に集約してある。
        // 成功時 Acquire: 前回 poll の ack 書き込み（ガード解放の Release と対）を可視化する。
        if self
            .poll_gate
            .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
            .is_err()
        {
            return Err(io::Error::other(
                "event ring poll is non-reentrant: another poll is in progress on this host \
                 (a handler must not call poll, and concurrent pollers are not serialized)",
            ));
        }
        let _gate = PollGateGuard(&self.poll_gate);
        let mut handled = 0;
        loop {
            let ack = unsafe { (*region).evt_ack_seq.load_own() };
            let published = unsafe { (*region).evt_seq.read() };
            if ack > published {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("event ring ack {ack} exceeds published seq {published}"),
                ));
            }
            if ack == published {
                // NonZeroUsize が Idle / Advanced の境界を型で持つ（0 件の Advanced は構築不能）。
                return Ok(match NonZeroUsize::new(handled) {
                    None => EventPollOutcome::Idle,
                    Some(handled) => EventPollOutcome::Advanced { handled },
                });
            }

            let seq = ack + 1;
            let index = evt_slot_index(seq);
            let event = EventRingEvent {
                seq,
                kind: unsafe { (*region).evt_kind[index].load(Ordering::Relaxed) },
                arg: unsafe { std::ptr::read(std::ptr::addr_of!((*region).evt_arg[index])) },
            };
            let kind = event.kind;
            if !handler(event) {
                return Ok(EventPollOutcome::Blocked { handled, seq, kind });
            }
            unsafe { (*region).evt_ack_seq.publish(seq) };
            handled += 1;
        }
    }

    /// dirty 水位がこの host instance の前回観測値より進んだ場合、その新しい水位を返す。
    #[allow(dead_code)]
    pub(crate) fn observe_dirty_epoch(&self) -> io::Result<Option<u64>> {
        let mmap = open_shared(&self.shm_path)?;
        let region = region_ptr(&mmap);
        let current = unsafe { (*region).dirty_epoch.read() };
        let previous = self
            .last_seen_dirty_epoch
            .fetch_max(current, Ordering::Relaxed);
        Ok((current > previous).then_some(current))
    }
}

/// plugin dirty callback から水位を1進める。通知スレッドを問わず atomic RMW で安全。
///
/// # Safety
/// `region` は生存中の [`SharedRegion`] を指していなければならない。
pub unsafe fn increment_dirty_epoch(region: *mut SharedRegion) -> u64 {
    unsafe { (*region).dirty_epoch.increment() }
}

/// `cmd_result`: 成功。
pub const CMD_RESULT_OK: u32 = 0;
/// `cmd_result`: plugin が state を返さなかった（`getState` 失敗・非対応）。
pub const CMD_RESULT_PLUGIN_ERROR: u32 = 1;
/// `cmd_result`: サイドカーファイルへの書き込みに失敗した。
pub const CMD_RESULT_IO_ERROR: u32 = 2;
/// `cmd_result`: `cmd_arg` が不正（空・非 UTF-8・NUL 終端なし）。
pub const CMD_RESULT_BAD_ARG: u32 = 3;
/// `cmd_result`: 未知の `cmd_kind`（**黙って無視せず ack で知らせる**）。
pub const CMD_RESULT_UNKNOWN_KIND: u32 = 4;
/// `cmd_result`: command の処理中に child が終了し、host が failure ack で打ち切った。
pub const CMD_RESULT_CHILD_EXITED: u32 = 5;

/// plugin state mailbox の ack 待ち上限（UIH.2 / #562）。
///
/// 上位層を含めてこの定数を唯一の production timeout として使う。テストだけは
/// [`CommandMailboxHost::issue_save_state_with_timeout`] へ短い値を渡して timeout 分岐を踏む。
pub const PLUGIN_STATE_MAILBOX_TIMEOUT: Duration = Duration::from_secs(5);
/// `OPEN_UI` の完了 ack 待ち上限。
///
/// `OPEN_UI` は受理時でなく plugin view の生成・host window への attach が完了してから ack する。
/// 重い plugin の `createView` は state mailbox の通常上限 5 秒を正当に超えうるため、UI open
/// だけは専用の余裕を持つ。close handshake の 10 秒 timeout とは別物であり、daemon 側の
/// safepoint timeout は追加しない。
pub const OPEN_UI_MAILBOX_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandMailboxResponse {
    pub bytes_written: u64,
    /// Command detail returned by the child. UIH.4c permits a successful no-op
    /// `CLOSE_UI` to carry `"already-closing"`.
    pub detail: String,
}

#[derive(Debug)]
pub enum CommandMailboxError {
    Mapping(io::Error),
    SidecarCleanup {
        path: PathBuf,
        error: io::Error,
    },
    InvalidArgument(String),
    Busy {
        seq: u64,
    },
    Poisoned {
        seq: u64,
    },
    Timeout {
        seq: u64,
        elapsed: Duration,
    },
    ChildExited {
        seq: u64,
        detail: String,
    },
    CommandFailed {
        seq: u64,
        result: u32,
        detail: String,
    },
    Protocol {
        seq: u64,
        ack: u64,
    },
    SequenceExhausted,
    CoordinatorPoisoned,
}

impl fmt::Display for CommandMailboxError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Mapping(error) => write!(f, "plugin state mailbox mapping failed: {error}"),
            Self::SidecarCleanup { path, error } => write!(
                f,
                "abandoned sidecar cleanup failed: {}: {error}",
                path.display()
            ),
            Self::InvalidArgument(detail) => {
                write!(f, "invalid plugin state sidecar path: {detail}")
            }
            Self::Busy { seq } => {
                write!(f, "plugin state mailbox command {seq} is still in flight")
            }
            Self::Poisoned { seq } => write!(
                f,
                "plugin state mailbox command {seq} timed out and remains in flight"
            ),
            Self::Timeout { seq, elapsed } => write!(
                f,
                "plugin state mailbox command {seq} timed out after {elapsed:?}"
            ),
            Self::ChildExited { seq, detail } => {
                write!(
                    f,
                    "plugin child exited during mailbox command {seq}: {detail}"
                )
            }
            Self::CommandFailed {
                seq,
                result,
                detail,
            } => write!(
                f,
                "plugin state mailbox command {seq} failed (result={result}): {detail}"
            ),
            Self::Protocol { seq, ack } => write!(
                f,
                "plugin state mailbox ack mismatch: expected exactly {seq}, got {ack}"
            ),
            Self::SequenceExhausted => write!(f, "plugin state mailbox sequence exhausted"),
            Self::CoordinatorPoisoned => write!(f, "plugin state mailbox coordinator poisoned"),
        }
    }
}

impl std::error::Error for CommandMailboxError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Mapping(error) | Self::SidecarCleanup { error, .. } => Some(error),
            _ => None,
        }
    }
}

impl From<io::Error> for CommandMailboxError {
    fn from(value: io::Error) -> Self {
        Self::Mapping(value)
    }
}

#[derive(Debug)]
struct InFlightCommand {
    seq: u64,
    /// 投函時の [`CommandMailboxState::generation`]。ack 照合で `seq` と**併せて**見る。
    ///
    /// 「`seq` だけで足りるのでは」は正しい問いで、**現状の実装では実際に足りている** —
    /// [`reset_child_starting`] は `cmd_seq` をゼロに戻さず `cmd_ack_seq` を追いつかせるだけなので、
    /// `cmd_seq` は child の世代をまたいで単調増加し、同じ `seq` が二度使われない。
    ///
    /// それでも残すのは、**その単調性が共有メモリ側のリセット手順に依存している**から。
    /// respawn 時に「綺麗な状態から始める」意図で `cmd_seq` を 0 に戻す変更を入れると、
    /// 旧世代の待機スレッドが新世代の同番コマンドを自分のものと誤認して in-flight を
    /// 消しにいく（= 別コマンドの ack を横取りする）。generation を見ていればその変更は
    /// 安全側に倒れる。フィールド 2 本と `&&` 3 箇所の対価としては安い。
    generation: u64,
    abandoned: bool,
    kind: u32,
    sidecar_path: Option<std::path::PathBuf>,
}

#[derive(Debug, Default)]
struct CommandMailboxState {
    generation: u64,
    in_flight: Option<InFlightCommand>,
}

/// host 側の single-outstanding command coordinator（UIH.2 / #562）。
///
/// `Mutex` は投函と reset の短い critical section だけを保護する。ack 待ち中は保持しないため、
/// watchdog は child 死亡後に in-flight command を failure ack で完了させられる。
#[derive(Debug)]
pub struct CommandMailboxHost {
    shm_path: std::path::PathBuf,
    state: Mutex<CommandMailboxState>,
}

impl CommandMailboxHost {
    pub fn new(shm_path: std::path::PathBuf) -> Self {
        Self {
            shm_path,
            state: Mutex::new(CommandMailboxState::default()),
        }
    }

    pub fn issue_save_state(
        &self,
        sidecar_path: &Path,
    ) -> Result<CommandMailboxResponse, CommandMailboxError> {
        self.issue_save_state_with_timeout(sidecar_path, PLUGIN_STATE_MAILBOX_TIMEOUT)
    }

    pub fn issue_open_ui(
        &self,
        window_title: &str,
    ) -> Result<CommandMailboxResponse, CommandMailboxError> {
        self.issue_command(CMD_OPEN_UI, window_title, None, OPEN_UI_MAILBOX_TIMEOUT)
    }

    pub fn issue_close_ui(&self) -> Result<CommandMailboxResponse, CommandMailboxError> {
        self.issue_command(CMD_CLOSE_UI, "", None, PLUGIN_STATE_MAILBOX_TIMEOUT)
    }

    /// 現在の child incarnation が plugin state 復元まで終えて READY かをAcquireで確認する。
    pub fn child_is_ready(&self) -> Result<bool, CommandMailboxError> {
        let mmap = open_shared(&self.shm_path)?;
        let region = region_ptr(&mmap);
        Ok(unsafe { (*region).child_status.load(Ordering::Acquire) } == CHILD_STATUS_READY)
    }

    /// `timeout` の差し替えは unit test が5秒待たずに failure lifecycle を実証するための seam。
    /// production caller は必ず [`Self::issue_save_state`] を使う。
    #[doc(hidden)]
    pub fn issue_save_state_with_timeout(
        &self,
        sidecar_path: &Path,
        timeout: Duration,
    ) -> Result<CommandMailboxResponse, CommandMailboxError> {
        if !sidecar_path.is_absolute() {
            return Err(CommandMailboxError::InvalidArgument(
                "path must be absolute".into(),
            ));
        }
        let sidecar = sidecar_path.to_str().ok_or_else(|| {
            CommandMailboxError::InvalidArgument("path must be valid UTF-8".into())
        })?;
        self.issue_command(CMD_SAVE_STATE, sidecar, Some(sidecar_path), timeout)
    }

    fn issue_command(
        &self,
        kind: u32,
        arg: &str,
        sidecar_path: Option<&Path>,
        timeout: Duration,
    ) -> Result<CommandMailboxResponse, CommandMailboxError> {
        let mmap = open_shared(&self.shm_path)?;
        let region = region_ptr(&mmap);
        let (seq, generation) = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| CommandMailboxError::CoordinatorPoisoned)?;

            if let Some(in_flight) = state.in_flight.as_ref() {
                if !in_flight.abandoned {
                    return Err(CommandMailboxError::Busy { seq: in_flight.seq });
                }
                let ack = unsafe { (*region).cmd_ack_seq.load(Ordering::Acquire) };
                if ack != in_flight.seq {
                    return Err(CommandMailboxError::Poisoned { seq: in_flight.seq });
                }
                // SAFETY: region はこのメソッドが open_shared で得た生存 mapping を指す。
                unsafe { warn_if_abandoned_save_succeeded(region, in_flight) };
                let cleanup_result = cleanup_abandoned_sidecar(in_flight);
                state.in_flight = None;
                cleanup_result?;
            }

            let previous = unsafe { (*region).cmd_seq.load(Ordering::Relaxed) };
            let seq = previous
                .checked_add(1)
                .ok_or(CommandMailboxError::SequenceExhausted)?;
            unsafe {
                if !write_cstr_field(&mut (*region).cmd_arg, arg) {
                    return Err(CommandMailboxError::InvalidArgument(format!(
                        "command argument must contain no NUL and fit in CMD_ARG_BYTES={CMD_ARG_BYTES}"
                    )));
                }
                let _ = write_cstr_field(&mut (*region).cmd_result_detail, "");
                (*region).cmd_result_len.store(0, Ordering::Relaxed);
                (*region).cmd_result.store(CMD_RESULT_OK, Ordering::Relaxed);
                (*region).cmd_kind.store(kind, Ordering::Relaxed);
                // Release publish: child は cmd_seq Acquire 後に kind/arg を読む。
                (*region).cmd_seq.store(seq, Ordering::Release);
            }
            let generation = state.generation;
            state.in_flight = Some(InFlightCommand {
                seq,
                generation,
                abandoned: false,
                kind,
                sidecar_path: sidecar_path.map(Path::to_path_buf),
            });
            (seq, generation)
        };

        let started = Instant::now();
        loop {
            {
                let state = self
                    .state
                    .lock()
                    .map_err(|_| CommandMailboxError::CoordinatorPoisoned)?;
                if state.generation != generation {
                    return Err(CommandMailboxError::ChildExited {
                        seq,
                        detail: "child died and the mailbox was reset before replacement spawn"
                            .into(),
                    });
                }
            }

            let ack = unsafe { (*region).cmd_ack_seq.load(Ordering::Acquire) };
            if ack == seq {
                let result = unsafe { (*region).cmd_result.load(Ordering::Relaxed) };
                let bytes_written = unsafe { (*region).cmd_result_len.load(Ordering::Relaxed) };
                let detail = unsafe {
                    read_cstr_field(&(*region).cmd_result_detail)
                        .unwrap_or("invalid UTF-8 in command detail")
                        .to_string()
                };
                let mut state = self
                    .state
                    .lock()
                    .map_err(|_| CommandMailboxError::CoordinatorPoisoned)?;
                if matches!(
                    state.in_flight.as_ref(),
                    Some(current)
                        if current.seq == seq
                            && current.generation == generation
                ) {
                    state.in_flight = None;
                }
                return match result {
                    CMD_RESULT_OK => Ok(CommandMailboxResponse {
                        bytes_written,
                        detail,
                    }),
                    CMD_RESULT_CHILD_EXITED => {
                        Err(CommandMailboxError::ChildExited { seq, detail })
                    }
                    _ => Err(CommandMailboxError::CommandFailed {
                        seq,
                        result,
                        detail,
                    }),
                };
            }
            if ack > seq {
                let mut state = self
                    .state
                    .lock()
                    .map_err(|_| CommandMailboxError::CoordinatorPoisoned)?;
                if let Some(current) = state.in_flight.as_mut() {
                    if current.seq == seq && current.generation == generation {
                        current.abandoned = true;
                    }
                }
                return Err(CommandMailboxError::Protocol { seq, ack });
            }

            let elapsed = started.elapsed();
            if elapsed >= timeout {
                let mut state = self
                    .state
                    .lock()
                    .map_err(|_| CommandMailboxError::CoordinatorPoisoned)?;
                if let Some(current) = state.in_flight.as_mut() {
                    if current.seq == seq && current.generation == generation {
                        // timeout 後も delayed ack が来うる。ack/reset まで slot を再利用させない。
                        current.abandoned = true;
                    }
                }
                return Err(CommandMailboxError::Timeout { seq, elapsed });
            }
            std::thread::sleep(Duration::from_millis(1));
        }
    }

    /// watchdog が旧 child の死亡を確認した後、replacement spawn より前に呼ぶ。
    pub fn reset_after_child_exit(&self) -> Result<(), CommandMailboxError> {
        let mmap = open_shared(&self.shm_path)?;
        let region = region_ptr(&mmap);
        let mut state = self
            .state
            .lock()
            .map_err(|_| CommandMailboxError::CoordinatorPoisoned)?;
        if let Some(in_flight) = state.in_flight.as_ref() {
            // SAFETY: region はこのメソッドが open_shared で得た生存 mapping を指す。
            unsafe { warn_if_abandoned_save_succeeded(region, in_flight) };
        }
        // SAFETY: mmap は生存し、旧 child の死亡確認後なので child と reset writer は競合しない。
        unsafe { reset_child_starting(region) };
        state.generation = state.generation.wrapping_add(1);
        let cleanup_result = state
            .in_flight
            .as_ref()
            .map(cleanup_abandoned_sidecar)
            .unwrap_or(Ok(()));
        state.in_flight = None;
        cleanup_result
    }
}

/// `UI_CLOSED_DONE` が伝える close の終端理由。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UiCloseCompletion {
    SafepointCompleted,
    TimedOutWithoutSave,
}

impl UiCloseCompletion {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SafepointCompleted => "safepoint-completed",
            Self::TimedOutWithoutSave => "timeout-without-save",
        }
    }
}

/// [`UiEventPump::poll_step`] が daemon の非ブロッキング sink へ渡す固定通知。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UiPumpNotification {
    Safepoint { generation: u64, evt_seq: u64 },
    CloseDone { completion: UiCloseCompletion },
}

#[derive(Debug)]
pub enum UiEventPumpError {
    Mapping(io::Error),
    Mailbox(CommandMailboxError),
    CoordinatorPoisoned,
    GenerationMismatch { expected: u64, actual: u64 },
    Protocol(String),
}

impl fmt::Display for UiEventPumpError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Mapping(error) => write!(f, "plugin UI event mapping failed: {error}"),
            Self::Mailbox(error) => write!(f, "plugin UI reset mailbox failed: {error}"),
            Self::CoordinatorPoisoned => write!(f, "plugin UI event pump coordinator poisoned"),
            Self::GenerationMismatch { expected, actual } => write!(
                f,
                "plugin UI safepoint generation mismatch: current {expected}, got {actual}"
            ),
            Self::Protocol(detail) => write!(f, "plugin UI event protocol error: {detail}"),
        }
    }
}

impl std::error::Error for UiEventPumpError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Mapping(error) => Some(error),
            Self::Mailbox(error) => Some(error),
            _ => None,
        }
    }
}

impl From<io::Error> for UiEventPumpError {
    fn from(error: io::Error) -> Self {
        Self::Mapping(error)
    }
}

impl From<CommandMailboxError> for UiEventPumpError {
    fn from(error: CommandMailboxError) -> Self {
        Self::Mailbox(error)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UiLifecycle {
    Closed,
    Opening,
    Open,
    Closing,
}

#[derive(Debug)]
struct UiPumpState {
    generation: u64,
    /// Engine へ通知済みで、`AckUiSafepoint` を待っている `UI_CLOSED`。
    pending_safepoint: Option<u64>,
    /// child timeout により放棄した safepoint。遅着 ack を warn 付きで受理するため保持する。
    abandoned_safepoint: Option<u64>,
    lifecycle: UiLifecycle,
}

impl Default for UiPumpState {
    fn default() -> Self {
        Self {
            generation: 0,
            pending_safepoint: None,
            abandoned_safepoint: None,
            lifecycle: UiLifecycle::Closed,
        }
    }
}

/// child UI event ring と respawn reset を一つの排他契約へ束ねる host coordinator。
///
/// # 提供する保証
///
/// - `poll_step` は **pump の Mutex を保持したまま** [`EventRingHost::poll`] の
///   read → 固定 handler → ack 全区間を実行する。`ack_safepoint`、teardown drain、respawn
///   reset も同じ Mutex を取るため、#592 の `evt_seq=0` リセット途中を poll が観測しない。
/// - `reset_after_child_exit` は pump lock の内側で
///   [`CommandMailboxHost::reset_after_child_exit`] を呼ぶ。全呼び出しの lock 順序は
///   **pump → mailbox** に固定し、逆順の経路を提供しない。
/// - [`CommandMailboxHost`] から継承する保証は、通常の command 発行と reset の host 内直列化、
///   generation による世代跨ぎの command ack 横取り防止、および
///   `reset_after_child_exit` を旧 child の死亡確認後にだけ呼ぶという契約である。
/// - generation と通知済み safepoint 水位を同じ state に置くため、respawn で `evt_seq` が 0 に
///   巻き戻っても旧世代の `AckUiSafepoint` は loud に拒否される。
/// - handler は `UiPumpNotification` の enqueue、水位判定、既知 kind の lifecycle 簿記だけで、
///   呼び出し側が任意の ring handler を差し込むことはできない。
///
/// # 提供しない保証 / sink の契約
///
/// - sink の配送完了や engine 側保存は待たない。sink は **非ブロッキング enqueue のみ**で
///   なければならない。pump lock 内で channel capacity 待ち、I/O、別 task の join 等を行うと
///   watchdog と respawn を停止させる。`false` は enqueue 不能を意味し、イベントを未 ack のまま
///   次回へ残す。
/// - child の 10 秒 close timeout より前に daemon 独自の timeout を設けない。脱出は child が
///   `UI_CLOSED_DONE(timeout-without-save)` を publish した事実だけを根拠にする。
/// - host 内 Mutex は、生存中の child process による共有メモリ store を止めない。したがって
///   **生存中の child と reset の cross-process 競合は守られず**、reset は死亡確認後に限る。
/// - [`EventRingHost`] の CAS gate は pump 導入後の reset 排他の主役ではない。pump を経ない
///   raw/direct poll の同時実行を fail-loud に検出する防御線として残る。
/// - generation は世代跨ぎの ack を拒否するが、**同一 generation 内で別の `evt_seq` を
///   取り違えることまでは守らない**。`pending_safepoint` と in-order head の一致検査が別途必要。
/// - raw [`EventRingHost`] / [`reset_child_starting`] は crate 外へ公開せず、他 crate が pump を
///   迂回することを型で禁止する。crate 内の transport 実装・テストは本契約を維持する責務を持つ。
#[derive(Debug)]
pub struct UiEventPump {
    ring: EventRingHost,
    state: Mutex<UiPumpState>,
}

/// respawn reset が UI lifecycle に与えた結果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UiPumpResetOutcome {
    pub closed_visible_ui: bool,
    pub generation: u64,
}

impl UiEventPump {
    pub fn new(shm_path: PathBuf) -> Self {
        Self {
            ring: EventRingHost::new(shm_path),
            state: Mutex::new(UiPumpState::default()),
        }
    }

    /// OPEN_UI 投函直前に lifecycle を予約する。command 失敗時は [`Self::finish_open`] へ
    /// `false` を渡して戻す。すでに open/closing なら child へ投函する前に loud に拒否する。
    pub fn begin_open(&self) -> Result<(), UiEventPumpError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| UiEventPumpError::CoordinatorPoisoned)?;
        if state.lifecycle != UiLifecycle::Closed {
            return Err(UiEventPumpError::Protocol(format!(
                "OPEN_UI requested while lifecycle is {:?}",
                state.lifecycle
            )));
        }
        state.lifecycle = UiLifecycle::Opening;
        Ok(())
    }

    pub fn finish_open(&self, succeeded: bool) -> Result<(), UiEventPumpError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| UiEventPumpError::CoordinatorPoisoned)?;
        if state.lifecycle == UiLifecycle::Opening {
            state.lifecycle = if succeeded {
                UiLifecycle::Open
            } else {
                UiLifecycle::Closed
            };
        }
        Ok(())
    }

    /// watchdog の1 tick。固定 handler は broadcast 等への enqueue と水位判定だけを行う。
    pub fn poll_step<F>(&self, mut sink: F) -> Result<EventPollOutcome, UiEventPumpError>
    where
        F: FnMut(UiPumpNotification) -> bool,
    {
        let mut state = self
            .state
            .lock()
            .map_err(|_| UiEventPumpError::CoordinatorPoisoned)?;
        let mmap = open_shared(&self.ring.shm_path)?;
        let region = region_ptr(&mmap);
        let mut handler_error = None;
        let outcome = self.ring.poll_mapped(region, |event| match event.kind {
            EVT_UI_CLOSED => {
                state.lifecycle = UiLifecycle::Closing;

                // Abandon takes precedence over notification delivery. Once the child has
                // published timeout-without-save it has already given up, so no engine save can
                // still happen. Retrying an undeliverable safepoint first would leave this ring
                // head blocked forever while no editor is connected and prevent a later UI open.
                if is_abandon_done_published(region, event.seq.saturating_add(1)) {
                    tracing::warn!(
                        generation = state.generation,
                        evt_seq = event.seq,
                        "plugin UI safepoint was abandoned after child timeout; acking the blocked head"
                    );
                    state.pending_safepoint = None;
                    state.abandoned_safepoint = Some(event.seq);
                    return true;
                }

                if state.pending_safepoint != Some(event.seq) {
                    if !sink(UiPumpNotification::Safepoint {
                        generation: state.generation,
                        evt_seq: event.seq,
                    }) {
                        return false;
                    }
                    state.pending_safepoint = Some(event.seq);
                }
                false
            }
            EVT_UI_CLOSED_DONE => {
                let completion = match event.arg() {
                    Some("safepoint-completed") => UiCloseCompletion::SafepointCompleted,
                    Some("timeout-without-save") => UiCloseCompletion::TimedOutWithoutSave,
                    other => {
                        handler_error = Some(UiEventPumpError::Protocol(format!(
                            "UI_CLOSED_DONE seq {} has invalid completion {other:?}",
                            event.seq
                        )));
                        return false;
                    }
                };
                if sink(UiPumpNotification::CloseDone { completion }) {
                    state.lifecycle = UiLifecycle::Closed;
                    true
                } else {
                    false
                }
            }
            kind => {
                handler_error = Some(UiEventPumpError::Protocol(format!(
                    "event seq {} has unknown kind {kind}",
                    event.seq
                )));
                false
            }
        })?;
        match handler_error {
            Some(error) => Err(error),
            None => Ok(outcome),
        }
    }

    /// engine が safepoint 保存・atomic rename・project 登記まで完了した時だけ ack を進める。
    pub fn ack_safepoint(&self, generation: u64, evt_seq: u64) -> Result<(), UiEventPumpError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| UiEventPumpError::CoordinatorPoisoned)?;
        if generation != state.generation {
            return Err(UiEventPumpError::GenerationMismatch {
                expected: state.generation,
                actual: generation,
            });
        }
        let mmap = open_shared(&self.ring.shm_path)?;
        let region = region_ptr(&mmap);
        let ack = unsafe { (*region).evt_ack_seq.load_own() };
        if state.abandoned_safepoint == Some(evt_seq) && ack >= evt_seq {
            tracing::warn!(
                generation,
                evt_seq,
                "late plugin UI safepoint ack arrived after timeout-without-save; accepting completed save"
            );
            state.abandoned_safepoint = None;
            return Ok(());
        }
        if state.pending_safepoint != Some(evt_seq) {
            return Err(UiEventPumpError::Protocol(format!(
                "AckUiSafepoint seq {evt_seq} does not match pending {:?}",
                state.pending_safepoint
            )));
        }
        let published = unsafe { (*region).evt_seq.read() };
        if ack.saturating_add(1) != evt_seq || evt_seq > published {
            return Err(UiEventPumpError::Protocol(format!(
                "AckUiSafepoint seq {evt_seq} is not the in-order head (ack={ack}, published={published})"
            )));
        }
        unsafe { (*region).evt_ack_seq.publish(evt_seq) };
        state.pending_safepoint = None;
        Ok(())
    }

    /// 旧 child の死亡確認後、replacement spawn 前に呼ぶ唯一の daemon reset 経路。
    pub fn reset_after_child_exit(
        &self,
        mailbox: &CommandMailboxHost,
    ) -> Result<UiPumpResetOutcome, UiEventPumpError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| UiEventPumpError::CoordinatorPoisoned)?;
        let closed_visible_ui = state.lifecycle != UiLifecycle::Closed;
        if let Some(evt_seq) = state.pending_safepoint.take() {
            tracing::error!(
                generation = state.generation,
                evt_seq,
                "plugin child exited with a UI safepoint waiter pending"
            );
        }
        // LOCK ORDER: pump state -> command mailbox. No code may acquire these in reverse.
        mailbox.reset_after_child_exit()?;
        state.generation = state.generation.wrapping_add(1);
        state.abandoned_safepoint = None;
        state.lifecycle = UiLifecycle::Closed;
        Ok(UiPumpResetOutcome {
            closed_visible_ui,
            generation: state.generation,
        })
    }

    /// 正常 teardown の QUIT 前に、現在 publish 済みのイベントを最終処理する。
    ///
    /// safepoint は停止により完遂不能なので error を残して ack し、DONE の enqueue 不能も error
    /// を残して打ち切る。これは時間経過による daemon timeout ではなく、明示 teardown の終端処理。
    pub fn final_drain<F>(&self, mut sink: F) -> Result<EventPollOutcome, UiEventPumpError>
    where
        F: FnMut(UiPumpNotification) -> bool,
    {
        let mut state = self
            .state
            .lock()
            .map_err(|_| UiEventPumpError::CoordinatorPoisoned)?;
        let outcome = self.ring.poll(|event| {
            match event.kind {
                EVT_UI_CLOSED => {
                    if state.pending_safepoint != Some(event.seq)
                        && !sink(UiPumpNotification::Safepoint {
                            generation: state.generation,
                            evt_seq: event.seq,
                        })
                    {
                        tracing::error!(
                            evt_seq = event.seq,
                            "teardown could not enqueue final plugin UI safepoint notification"
                        );
                    }
                    tracing::error!(
                        generation = state.generation,
                        evt_seq = event.seq,
                        "teardown is abandoning an incomplete plugin UI safepoint before QUIT"
                    );
                    state.pending_safepoint = None;
                    state.abandoned_safepoint = Some(event.seq);
                }
                EVT_UI_CLOSED_DONE => {
                    let completion = match event.arg() {
                        Some("safepoint-completed") => UiCloseCompletion::SafepointCompleted,
                        Some("timeout-without-save") => UiCloseCompletion::TimedOutWithoutSave,
                        other => {
                            tracing::error!(
                                evt_seq = event.seq,
                                ?other,
                                "teardown is discarding malformed UI_CLOSED_DONE"
                            );
                            return true;
                        }
                    };
                    if !sink(UiPumpNotification::CloseDone { completion }) {
                        tracing::error!(
                            evt_seq = event.seq,
                            "teardown could not enqueue final plugin UI close completion"
                        );
                    }
                }
                kind => tracing::error!(
                    evt_seq = event.seq,
                    kind,
                    "teardown is discarding an unknown plugin UI event"
                ),
            }
            true
        })?;
        if let Some(evt_seq) = state.pending_safepoint.take() {
            tracing::error!(
                generation = state.generation,
                evt_seq,
                "teardown failed a plugin UI safepoint waiter that was not present in the ring"
            );
        }
        state.lifecycle = UiLifecycle::Closed;
        Ok(outcome)
    }
}

/// A blocked safepoint may be abandoned only when the immediately following event is the child's
/// explicit `timeout-without-save` completion. The caller owns a live mapping for `region`.
fn is_abandon_done_published(region: *mut SharedRegion, next_seq: u64) -> bool {
    let published = unsafe { (*region).evt_seq.read() };
    if published < next_seq {
        return false;
    }
    let index = evt_slot_index(next_seq);
    let next_kind = unsafe { (*region).evt_kind[index].load(Ordering::Relaxed) };
    let next_arg = unsafe { read_cstr_field(&(*region).evt_arg[index]) };
    next_kind == EVT_UI_CLOSED_DONE && next_arg == Some("timeout-without-save")
}

/// timeout で見捨てたコマンドが**実は成功していた**まま破棄される時に warning を残す。
///
/// UIH.3 が想定する大きな state（fsync が 5 秒を超えうる）では実際に起こる。無言で消すと、
/// ユーザーは保存失敗を見た後、正しく書き終えていた state が消えたことに気づけない。
///
/// # Safety
///
/// `region` は生存している mapping を指していること。本ファイルの他の生ポインタ関数
/// （[`service_command_mailbox`] / [`reset_child_starting`] 等）と同じ契約。
/// **素の `fn` にしない** — 呼び出し側に「このポインタの有効性は誰が保証するのか」を
/// 見せるのがこの crate の慣習で、その慣習だけがガードになっている。
unsafe fn warn_if_abandoned_save_succeeded(region: *mut SharedRegion, in_flight: &InFlightCommand) {
    if !in_flight.abandoned || in_flight.kind != CMD_SAVE_STATE {
        return;
    }
    let Some(sidecar_path) = in_flight.sidecar_path.as_ref() else {
        return;
    };
    let ack = unsafe { (*region).cmd_ack_seq.load(Ordering::Acquire) };
    let result = unsafe { (*region).cmd_result.load(Ordering::Relaxed) };
    if ack == in_flight.seq && result == CMD_RESULT_OK {
        tracing::warn!(
            seq = in_flight.seq,
            path = %sidecar_path.display(),
            "discarding plugin state saved after mailbox timeout"
        );
    }
}

fn cleanup_abandoned_sidecar(in_flight: &InFlightCommand) -> Result<(), CommandMailboxError> {
    match in_flight.sidecar_path.as_deref() {
        Some(path) => remove_abandoned_sidecar(path),
        None => Ok(()),
    }
}

fn remove_abandoned_sidecar(path: &Path) -> Result<(), CommandMailboxError> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(CommandMailboxError::SidecarCleanup {
            path: path.to_path_buf(),
            error,
        }),
    }
}

/// 固定長バイト配列へ NUL 終端 UTF-8 を書く。収まらなければ `false`（**切り詰めない**）。
///
/// **埋め込み NUL を含む値も `false`**。UTF-8 として妥当でも、書けてしまうと
/// [`read_cstr_field`] が最初の NUL で切って読むため、**「切り詰めない」保証が黙って崩れる**。
/// 拒否側に倒して、保証をコメントではなくコードで守る。
pub fn write_cstr_field(dst: &mut [u8], value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() + 1 > dst.len() || bytes.contains(&0) {
        return false;
    }
    dst[..bytes.len()].copy_from_slice(bytes);
    dst[bytes.len()] = 0;
    true
}

/// 固定長バイト配列から NUL 終端 UTF-8 を読む。NUL が無い・非 UTF-8 なら `None`。
pub fn read_cstr_field(src: &[u8]) -> Option<&str> {
    let end = src.iter().position(|&b| b == 0)?;
    std::str::from_utf8(&src[..end]).ok()
}

/// UIH.3 のサイドカー書き込み。**`fsync` まで行う**。
///
/// `std::fs::write` は page cache に載った時点で成功を返す。host は ack 直後にこのファイルを
/// 読み、`PROJECT_FILE_SPEC` の atomic 書き込みで登記簿を確定させるので、**ack が
/// 「ディスクに載った」を意味しない**と、電源断で「登記簿は新しい state を指しているが
/// 実体は無い/古い」という状態になりうる。ack の意味を強くするのは child 側の責務。
pub fn write_sidecar(path: &str, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut file = std::fs::File::create(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

/// mailbox コマンド1件の処理結果。[`service_command_mailbox`] の handler が返す。
pub struct CommandOutcome {
    /// [`CMD_RESULT_OK`] 等の結果コード。
    pub result: u32,
    /// 成功時に生成したバイト数（[`CMD_SAVE_STATE`] ならサイドカーの長さ）。失敗時は 0。
    pub len: u64,
    /// 失敗理由。通常の成功時は空。UIH.4c の冪等 `CLOSE_UI` だけは成功時にも
    /// `"already-closing"` を運ぶ（`orbit_child_ui::CommandAck` からの mailbox 変換）。
    pub detail: String,
}

impl CommandOutcome {
    /// 成功。`len` は生成バイト数。
    pub fn ok(len: u64) -> Self {
        Self {
            result: CMD_RESULT_OK,
            len,
            detail: String::new(),
        }
    }

    /// 失敗。`result` は `CMD_RESULT_OK` 以外、`detail` は host に見せる理由。
    pub fn failed(result: u32, detail: impl Into<String>) -> Self {
        Self {
            result,
            len: 0,
            detail: detail.into(),
        }
    }
}

/// [`CMD_SAVE_STATE`] handler の**共通本体**。`capture` だけがフォーマット固有。
///
/// 4つの child binary（VST3 / CLAP × effect / instrument）はいずれも
/// 「cmd_arg を検証 → プラグインから state を吸い上げ → [`write_sidecar`] → 長さを返す」
/// という同じ手順を踏む。違うのは `capture_state()` のレシーバ型（`&` か `&mut` か、
/// `Vst3HostError` か `ClapHostError` か）だけで、それはクロージャの中に閉じる。
///
/// 各 child に手書きで置くと、**結果コードの割り当て**（空 arg = [`CMD_RESULT_BAD_ARG`] /
/// プラグイン失敗 = [`CMD_RESULT_PLUGIN_ERROR`] / 書き込み失敗 = [`CMD_RESULT_IO_ERROR`]）と
/// `detail` の文言が4箇所で独立に漂流する。host 側はこのコードで分岐するので、
/// 1形式だけ別のコードを返すようになっても型では捕まらない。
pub fn save_state_command<E: std::fmt::Display>(
    path_arg: Option<&str>,
    capture: impl FnOnce() -> Result<Vec<u8>, E>,
) -> CommandOutcome {
    let Some(path) = path_arg.filter(|candidate| !candidate.is_empty()) else {
        return CommandOutcome::failed(
            CMD_RESULT_BAD_ARG,
            "cmd_arg is empty or not NUL-terminated UTF-8",
        );
    };
    let bytes = match capture() {
        Ok(bytes) => bytes,
        Err(error) => return CommandOutcome::failed(CMD_RESULT_PLUGIN_ERROR, format!("{error}")),
    };
    // UIH.3 は fsync を要求する（`write_sidecar` が担う）。
    match write_sidecar(path, &bytes) {
        Ok(()) => CommandOutcome::ok(bytes.len() as u64),
        Err(error) => CommandOutcome::failed(CMD_RESULT_IO_ERROR, format!("write {path}: {error}")),
    }
}

/// mailbox に未処理コマンドがあれば `handler` へ渡し、結果を ack として publish する。
/// 未処理コマンドが無ければ何もせず `false` を返す。
///
/// **この関数がプロトコル不変条件を一手に引き受ける** — child 側はフォーマット固有の処理だけを
/// handler に書けばよい。分散させると publish 順序を child ごとに守り続ける必要が生じる。
///
/// instrument child は VST3 / CLAP とも配線済み。effect child も同じ handler seam を使う。
/// host は [`CommandMailboxHost`] を通して発行し、未対応 child / plugin hang を
/// [`PLUGIN_STATE_MAILBOX_TIMEOUT`] で loud に失敗させる。
///
/// 引き受ける不変条件:
/// - **未知の `cmd_kind` を黙って捨てない** — handler が `None` を返したら
///   [`CMD_RESULT_UNKNOWN_KIND`] で ack する（host が永久に待つのを防ぐ）。
/// - **detail を切り詰めない** — 収まらなければ固定文言へ倒す。
/// - **ack を最後に `Release` で publish する** — host は `cmd_ack_seq` を `Acquire` で
///   読むので、これにより result / len / detail の可視性が保証される。
///
/// handler は `(cmd_kind, cmd_arg)` を受け取る。`cmd_arg` は NUL 終端 UTF-8 として
/// 読めなければ `None`（handler 側で [`CMD_RESULT_BAD_ARG`] を返すか判断する）。
///
/// # host 側が守る前提（この関数では強制できない）
///
/// - **ack を受け取るまで次のコマンドを投函しない**（spec UIH.2 規律 0）。メールボックスは
///   1件分の領域しか持たないため、ack 前に `cmd_seq` を進めると前のコマンドは実行されずに
///   上書きされ、しかも新しい seq が ack されるので host からは成功に見える
/// - **respawn 時にメールボックスを reset する**（spec UIH.2 規律 0-b）。残った未処理コマンドを
///   replacement child が自分宛として実行してしまう
///
/// production host は [`CommandMailboxHost`] で単一未処理とexact ackを強制し、daemonの
/// effect/instrument watchdogは旧child死亡後に同じcoordinatorをresetしてからrespawnする。
///
/// # Safety
/// `region` は生存中の [`SharedRegion`] を指していなければならない。
pub unsafe fn service_command_mailbox<F>(region: *mut SharedRegion, handler: F) -> bool
where
    F: FnOnce(u32, Option<&str>) -> Option<CommandOutcome>,
{
    let seq = unsafe { (*region).cmd_seq.load(Ordering::Acquire) };
    if seq <= unsafe { (*region).cmd_ack_seq.load(Ordering::Relaxed) } {
        return false;
    }
    let kind = unsafe { (*region).cmd_kind.load(Ordering::Acquire) };
    let arg = unsafe { read_cstr_field(&(*region).cmd_arg) };
    let outcome = handler(kind, arg).unwrap_or_else(|| {
        CommandOutcome::failed(CMD_RESULT_UNKNOWN_KIND, format!("unknown cmd_kind {kind}"))
    });

    unsafe {
        if !write_cstr_field(&mut (*region).cmd_result_detail, &outcome.detail) {
            let _ = write_cstr_field(&mut (*region).cmd_result_detail, "detail too long");
        }
        (*region)
            .cmd_result_len
            .store(outcome.len, Ordering::Relaxed);
        (*region)
            .cmd_result
            .store(outcome.result, Ordering::Relaxed);
        (*region).cmd_ack_seq.store(seq, Ordering::Release);
    }
    true
}

/// 共有領域のバイトサイズ(mmap ファイルサイズ)。
pub const REGION_BYTES: usize = std::mem::size_of::<SharedRegion>();

/// 共有メモリファイルを作成して map する(host 側)。ファイルを `REGION_BYTES` に truncate
/// するので全 atomic / バッファは 0 初期化される(`seq_request = seq_done = 0` は有効な初期状態)。
///
/// # Note
/// 返した `MmapMut` が生存する限りのみ [`region_ptr`] のポインタは有効(本関数自体は safe)。
pub fn create_shared(path: &Path) -> io::Result<MmapMut> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(true)
        .open(path)?;
    file.set_len(REGION_BYTES as u64)?;
    // SAFETY: ファイルは REGION_BYTES に拡張済み。map_mut は MAP_SHARED マッピングを返す。
    unsafe { MmapMut::map_mut(&file) }
}

/// 既存の共有メモリファイルを map する(child 側)。
///
/// # Note
/// 返した `MmapMut` が生存する限りのみ [`region_ptr`] のポインタは有効(本関数自体は safe)。
pub fn open_shared(path: &Path) -> io::Result<MmapMut> {
    #[cfg(test)]
    OPEN_SHARED_CALL_COUNT.with(|count| count.set(count.get() + 1));
    let file = OpenOptions::new().read(true).write(true).open(path)?;
    // 不変条件(map 後の生ポインタ deref が UB にならない最低サイズ)をコード側で enforce する。
    // 旧 run の stale shm(別 SLOTS 等)を渡されても silently map せず弾く。
    let len = file.metadata()?.len();
    if len < REGION_BYTES as u64 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("shm file too small: {len} < {REGION_BYTES} bytes"),
        ));
    }
    // SAFETY: ファイルは >= REGION_BYTES。host が REGION_BYTES に truncate 済みの同一ファイルを map する。
    unsafe { MmapMut::map_mut(&file) }
}

/// mmap のベースを [`SharedRegion`] ポインタにキャストする(本関数自体は safe)。
///
/// # Note
/// `mmap` は [`create_shared`] / [`open_shared`] が返したもの(サイズ >= `REGION_BYTES`・
/// ページ境界整列)でなければならない。返したポインタは `mmap` の生存期間を超えて使ってはならない。
pub fn region_ptr(mmap: &MmapMut) -> *mut SharedRegion {
    mmap.as_ptr() as *mut SharedRegion
}

/// child が plugin load 成功後に呼ぶ readiness 公開ヘルパ（PR-431）。`child_flags` を先に
/// Release store してから `child_status = CHILD_STATUS_READY` を Release store する
/// （host が status を Acquire で観測すれば flags も必ず可視という happens-before を
/// この1箇所に集約する）。
///
/// # Safety
/// `region` は呼び出し元が map 済みの生存 SharedRegion を指していること。
pub unsafe fn publish_child_ready(region: *mut SharedRegion, has_audio_input: bool) {
    let flags = if has_audio_input {
        CHILD_FLAG_HAS_AUDIO_INPUT
    } else {
        0
    };
    unsafe {
        (*region).child_flags.store(flags, Ordering::Release);
        (*region)
            .child_status
            .store(CHILD_STATUS_READY, Ordering::Release);
    }
}

/// child spawn の直前に readiness handshake を初期状態へ戻す。
///
/// shm は watchdog respawn 間で再利用されるため、前 incarnation の `READY` を残したまま
/// replacement child を起動すると host が新 child の load 完了前に ready-ack を誤認しうる。
/// status を先に `STARTING` にしてから flags を消し、全 spawn 経路で同じ順序を使う。
/// この順序なら並行 poller が前 incarnation の `READY` と消去済み flags を組み合わせない。
///
/// # Safety
/// - `region` は呼び出し元が map 済みの生存 SharedRegion を指していること。
/// - **child プロセス側**: watchdog が旧 child のプロセス消滅を確認済みであること
///   （生存中の child と並行すると `evt_seq` / `cmd_ack_seq` の並行 store で lost update）。
/// - **host プロセス側**: 同一 region に対する [`EventRingHost::poll`] が並行して
///   走っていないこと。poll 同士は host 内部の CAS ゲートで排他されるが、本関数は
///   そのゲートの外にいる。並行すると 4 つの独立 store（`evt_seq` → 0 / `evt_ack_seq` → 0 /
///   `evt_kind` / `evt_arg`）の途中状態を poll が観測し、偽の `InvalidData`
///   （`ack > published`）や正当な ack の消失になる。watchdog は「旧 child の死亡確認 →
///   in-flight 手続きの中止（poll 停止を含む）→ 本関数 → spawn」の順で直列化すること。
pub(crate) unsafe fn reset_child_starting(region: *mut SharedRegion) {
    unsafe {
        let seq = (*region).cmd_seq.load(Ordering::Acquire);
        let ack = (*region).cmd_ack_seq.load(Ordering::Relaxed);
        if seq > ack {
            let _ = write_cstr_field(
                &mut (*region).cmd_result_detail,
                "child exited before completing the command",
            );
            (*region).cmd_result_len.store(0, Ordering::Relaxed);
            (*region)
                .cmd_result
                .store(CMD_RESULT_CHILD_EXITED, Ordering::Relaxed);
            // failure payload を先に書き、ack を最後に publish する。
            (*region).cmd_ack_seq.store(seq, Ordering::Release);
        }
        (*region).cmd_kind.store(CMD_NONE, Ordering::Relaxed);
        (*region).cmd_arg.fill(0);

        // 旧 child の未処理イベントを replacement child のものと混線させない。並行 writer の
        // 不在（child のプロセス消滅 + host 内 poll の静穏化の両方）は # Safety 契約が要求する。
        //
        // ここで evt_seq / evt_ack_seq を 0 に戻せるのは、`cmd_seq`（0 に戻さない —
        // [`InFlightCommand::generation`] のコメント参照）と違い、**host 側が evt カーソルを
        // 一切保持しない**から: [`EventRingHost::poll`] は読む位置を毎回 shm の
        // `evt_ack_seq + 1` から導出するので、0 リセット後も desync しようがない。
        //
        // 不変条件: `EventRingHost` に evt カーソル（最後に見た seq 等）のフィールドを
        // 追加してはならない。追加するなら、この 0 リセットをやめて `cmd_seq` と同じく
        // 単調増加（+ generation 防御）へ移行すること。さもないと host-local の旧値を
        // 再超過するまで黙ってイベントを取りこぼす（`dirty_epoch` を 0 に戻した場合に
        // 起きる故障と同型）。この不変条件は
        // tests::event_ring_host_survives_respawn_seq_reset_without_local_cursor が実行で守る。
        (*region).evt_seq.publish(0);
        (*region).evt_ack_seq.publish(0);
        for kind in &(*region).evt_kind {
            kind.store(EVT_NONE, Ordering::Relaxed);
        }
        (*region).evt_arg.fill([0; EVT_ARG_BYTES]);

        // dirty_epoch は累積水位であり、host-local last_seen と比較するため respawn では触れない。
        (*region)
            .child_status
            .store(CHILD_STATUS_STARTING, Ordering::Release);
        (*region).child_flags.store(0, Ordering::Release);
    }
}

/// attach 失敗後に同じ shm を次の child incarnation へ引き継ぐ前、teardown が書いた QUIT を解除する。
///
/// # Safety
/// `region` は呼び出し元が map 済みの生存 SharedRegion を指していること。
pub unsafe fn reset_control_run(region: *mut SharedRegion) {
    unsafe { (*region).control.store(CONTROL_RUN, Ordering::Release) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    static MAILBOX_TEST_SEQ: AtomicU64 = AtomicU64::new(0);

    #[derive(Clone)]
    struct WarningSubscriber {
        messages: Arc<Mutex<Vec<String>>>,
    }

    struct MessageVisitor<'a> {
        messages: &'a Arc<Mutex<Vec<String>>>,
    }

    impl tracing::field::Visit for MessageVisitor<'_> {
        fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn fmt::Debug) {
            if field.name() == "message" {
                self.messages
                    .lock()
                    .expect("warning messages lock")
                    .push(format!("{value:?}"));
            }
        }
    }

    impl tracing::Subscriber for WarningSubscriber {
        fn enabled(&self, _metadata: &tracing::Metadata<'_>) -> bool {
            true
        }

        fn new_span(&self, _span: &tracing::span::Attributes<'_>) -> tracing::span::Id {
            tracing::span::Id::from_u64(1)
        }

        fn record(&self, _span: &tracing::span::Id, _values: &tracing::span::Record<'_>) {}

        fn record_follows_from(&self, _span: &tracing::span::Id, _follows: &tracing::span::Id) {}

        fn event(&self, event: &tracing::Event<'_>) {
            event.record(&mut MessageVisitor {
                messages: &self.messages,
            });
        }

        fn enter(&self, _span: &tracing::span::Id) {}

        fn exit(&self, _span: &tracing::span::Id) {}
    }

    /// [`EventPollOutcome::Advanced`] の期待値コンストラクタ（`handled` は 1 以上のこと）。
    fn advanced(handled: usize) -> EventPollOutcome {
        EventPollOutcome::Advanced {
            handled: NonZeroUsize::new(handled).expect("advanced() requires handled >= 1"),
        }
    }

    fn mailbox_test_path(label: &str) -> std::path::PathBuf {
        let seq = MAILBOX_TEST_SEQ.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "orbit-mailbox-{label}-{}-{seq}.shm",
            std::process::id()
        ))
    }

    fn wait_for_command(region: *mut SharedRegion) -> u64 {
        let deadline = Instant::now() + Duration::from_secs(1);
        loop {
            let seq = unsafe { (*region).cmd_seq.load(Ordering::Acquire) };
            if seq != 0 {
                return seq;
            }
            assert!(
                Instant::now() < deadline,
                "host did not publish a mailbox command"
            );
            std::thread::sleep(Duration::from_millis(1));
        }
    }

    fn ack_next_success(
        shm: std::path::PathBuf,
        previous_seq: u64,
        bytes_written: u64,
    ) -> std::thread::JoinHandle<()> {
        std::thread::spawn(move || {
            let mmap = open_shared(&shm).expect("child map");
            let region = region_ptr(&mmap);
            let deadline = Instant::now() + Duration::from_secs(1);
            loop {
                let seq = unsafe { (*region).cmd_seq.load(Ordering::Acquire) };
                if seq > previous_seq {
                    unsafe {
                        (*region)
                            .cmd_result_len
                            .store(bytes_written, Ordering::Relaxed);
                        (*region).cmd_result.store(CMD_RESULT_OK, Ordering::Relaxed);
                        (*region).cmd_ack_seq.store(seq, Ordering::Release);
                    }
                    return;
                }
                assert!(
                    Instant::now() < deadline,
                    "replacement command not published"
                );
                std::thread::sleep(Duration::from_millis(1));
            }
        })
    }

    #[test]
    fn save_state_command_rejects_missing_and_empty_paths_before_capture() {
        for path in [None, Some("")] {
            let mut captures = 0;
            let outcome = save_state_command(path, || {
                captures += 1;
                Ok::<_, io::Error>(b"must not be captured".to_vec())
            });
            assert_eq!(outcome.result, CMD_RESULT_BAD_ARG);
            assert_eq!(outcome.len, 0);
            assert_eq!(captures, 0, "invalid arguments must not invoke capture");
        }
    }

    #[test]
    fn save_state_command_reports_sidecar_io_errors_with_the_reason() {
        let missing_parent = mailbox_test_path("missing-parent").join("state.bin");
        let outcome = save_state_command(missing_parent.to_str(), || {
            Ok::<_, io::Error>(b"captured state".to_vec())
        });

        assert_eq!(outcome.result, CMD_RESULT_IO_ERROR);
        assert_eq!(outcome.len, 0);
        assert!(
            outcome.detail.contains("write")
                && (outcome.detail.contains("No such file")
                    || outcome.detail.contains("not found")),
            "I/O failure detail must retain its reason: {:?}",
            outcome.detail
        );
    }

    #[test]
    fn save_state_command_reports_capture_errors_as_plugin_failures() {
        let sidecar = mailbox_test_path("capture-failure");
        let outcome = save_state_command(sidecar.to_str(), || {
            Err::<Vec<u8>, _>("oracle refused capture")
        });

        assert_eq!(outcome.result, CMD_RESULT_PLUGIN_ERROR);
        assert_eq!(outcome.len, 0);
        assert_eq!(outcome.detail, "oracle refused capture");
        assert!(
            !sidecar.exists(),
            "capture failure must not create a sidecar"
        );
    }

    #[test]
    fn save_state_command_success_len_matches_the_written_file() {
        let sidecar = mailbox_test_path("save-command-success");
        let payload = b"captured plugin state";
        let outcome = save_state_command(sidecar.to_str(), || Ok::<_, io::Error>(payload.to_vec()));

        assert_eq!(outcome.result, CMD_RESULT_OK);
        assert_eq!(outcome.len, payload.len() as u64);
        assert_eq!(
            std::fs::metadata(&sidecar).expect("sidecar metadata").len(),
            outcome.len
        );
        assert_eq!(std::fs::read(&sidecar).expect("sidecar contents"), payload);
        std::fs::remove_file(sidecar).expect("remove sidecar");
    }

    #[test]
    fn abandoned_sidecar_cleanup_has_a_dedicated_diagnostic() {
        let directory = mailbox_test_path("cleanup-directory");
        std::fs::create_dir(&directory).expect("create cleanup target directory");

        let error = remove_abandoned_sidecar(&directory)
            .expect_err("remove_file on a directory must fail as sidecar cleanup");
        assert!(matches!(
            &error,
            CommandMailboxError::SidecarCleanup { path, .. } if path == &directory
        ));
        assert!(
            error
                .to_string()
                .starts_with("abandoned sidecar cleanup failed:"),
            "cleanup failure must not claim that mmap failed: {error}"
        );
        assert!(!error.to_string().contains("mailbox mapping"));
        std::fs::remove_dir(directory).expect("remove cleanup target directory");
    }

    // クロスプロセスで共有する以上、レイアウトが壊れると親子で別物を読む。サイズ/整列の回帰を捕捉。
    #[test]
    fn region_size_and_align() {
        // mmap ファイルサイズは input/output 各 SLOTS 本ぶん(計 2*SLOTS ブロック)を下回らない。
        assert!(REGION_BYTES >= 2 * SLOTS * BUF_LEN * std::mem::size_of::<f32>());
        // event 転送窓(input/output 各 SLOTS 本ぶん)も下回らない(M2・Issue #416)。
        assert!(
            REGION_BYTES >= 2 * SLOTS * MAX_EVENTS_PER_BLOCK * std::mem::size_of::<EventRecord>()
        );
        // align(64) 指定どおり。mmap のページ整列で満たされる前提の値。
        assert_eq!(std::mem::align_of::<SharedRegion>(), 64);
        // BUF_LEN = フレーム × チャンネル。
        assert_eq!(BUF_LEN, MAX_FRAMES * CHANNELS);
    }

    // ping-pong index: seq を SLOTS で循環し、連続 seq は必ず別 slot を指す(N-slot-generic)。
    // 実装式の再記述ではなく、host/child が依拠する 2 つの不変条件(連続 seq は別 slot /
    // SLOTS 個ごとに同じ slot)を検証する。
    #[test]
    fn slot_offset_cycles_by_modulo() {
        // 連続する seq は別 slot(pipelined で s と s-1 が衝突しない前提)。
        for s in 0..(SLOTS as u64 * 3) {
            assert_ne!(slot_offset(s), slot_offset(s + 1));
        }
        // SLOTS 個ごとに同じ slot へ戻る(outstanding guard が seq-SLOTS を見る根拠)。
        for s in 0..(SLOTS as u64 * 3) {
            assert_eq!(slot_offset(s), slot_offset(s + SLOTS as u64));
        }
    }

    // carry-forward ①(PR-C): child_process_error_count は truncate 直後 0 で、生ポインタ経由で
    // read/write できる(child が fetch_add・host が load する health signal)。レイアウトに field が
    // 載っていることと zero-init を locking する。
    #[test]
    fn child_process_error_count_defaults_zero_and_is_writable() {
        use std::sync::atomic::Ordering::Relaxed;
        let p = std::env::temp_dir().join(format!("orbit-sbx-health-{}.shm", std::process::id()));
        let _ = std::fs::remove_file(&p);
        let mmap = create_shared(&p).expect("create");
        let region = region_ptr(&mmap);
        // SAFETY: create_shared が返した生存 mapping を指す。truncate 直後で 0 初期化。
        unsafe {
            assert_eq!((*region).child_process_error_count.load(Relaxed), 0);
            (*region).child_process_error_count.fetch_add(3, Relaxed);
            assert_eq!((*region).child_process_error_count.load(Relaxed), 3);
        }
        drop(mmap);
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn child_readiness_defaults_to_starting_with_no_flags() {
        use std::sync::atomic::Ordering::Relaxed;
        let p = std::env::temp_dir().join(format!(
            "orbit-sbx-child-readiness-{}.shm",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&p);
        let mmap = create_shared(&p).expect("create");
        let region = region_ptr(&mmap);
        // SAFETY: create_shared が返した生存 mapping を指す。truncate 直後で 0 初期化。
        unsafe {
            assert_eq!((*region).child_status.load(Relaxed), CHILD_STATUS_STARTING);
            assert_eq!((*region).child_flags.load(Relaxed), 0);
        }
        drop(mmap);
        let _ = std::fs::remove_file(&p);
    }

    // publish_child_ready の直接検証（PR #439 review・pr-test-analyzer）: has_audio_input の
    // true/false 分岐で child_flags/child_status が期待どおり Release store されることを、
    // ヘルパを介さず本関数呼び出し1回ずつで確認する（既存テストは child_status/child_flags の
    // 初期値のみを検証しており、この関数自体を直接呼ぶテストが無かった）。
    #[test]
    fn publish_child_ready_stores_flags_and_status_for_both_branches() {
        use std::sync::atomic::Ordering::Relaxed;

        // has_audio_input = true: CHILD_FLAG_HAS_AUDIO_INPUT が立ち、status は READY。
        let p_true = std::env::temp_dir().join(format!(
            "orbit-sbx-publish-ready-true-{}.shm",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&p_true);
        let mmap_true = create_shared(&p_true).expect("create");
        let region_true = region_ptr(&mmap_true);
        // SAFETY: create_shared が返した生存 mapping を指す。
        unsafe {
            publish_child_ready(region_true, true);
            assert_eq!(
                (*region_true).child_flags.load(Relaxed),
                CHILD_FLAG_HAS_AUDIO_INPUT
            );
            assert_eq!(
                (*region_true).child_status.load(Relaxed),
                CHILD_STATUS_READY
            );
        }
        drop(mmap_true);
        let _ = std::fs::remove_file(&p_true);

        // has_audio_input = false: flags は 0 のまま、status は READY。
        let p_false = std::env::temp_dir().join(format!(
            "orbit-sbx-publish-ready-false-{}.shm",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&p_false);
        let mmap_false = create_shared(&p_false).expect("create");
        let region_false = region_ptr(&mmap_false);
        // SAFETY: create_shared が返した生存 mapping を指す。
        unsafe {
            publish_child_ready(region_false, false);
            assert_eq!((*region_false).child_flags.load(Relaxed), 0);
            assert_eq!(
                (*region_false).child_status.load(Relaxed),
                CHILD_STATUS_READY
            );
        }
        drop(mmap_false);
        let _ = std::fs::remove_file(&p_false);
    }

    #[test]
    fn reset_child_starting_clears_previous_incarnation_readiness() {
        let path =
            std::env::temp_dir().join(format!("orbit-sbx-reset-ready-{}.shm", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let mmap = create_shared(&path).expect("create");
        let region = region_ptr(&mmap);

        // SAFETY: region は create_shared が返した生存 mapping を指す。
        unsafe {
            publish_child_ready(region, true);
            reset_child_starting(region);
            assert_eq!((*region).child_flags.load(Ordering::Relaxed), 0);
            assert_eq!(
                (*region).child_status.load(Ordering::Relaxed),
                CHILD_STATUS_STARTING
            );
        }

        drop(mmap);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn event_ring_host_processes_strictly_in_sequence_and_acks_only_completion() {
        let shm = mailbox_test_path("event-seq-order");
        let mmap = create_shared(&shm).expect("create");
        let region = region_ptr(&mmap);
        let mut child = EventRingChild::new();
        child
            .queue(EVT_UI_CLOSED, "close-started")
            .expect("queue UI_CLOSED");
        child
            .queue(EVT_UI_CLOSED_DONE, "close-complete")
            .expect("queue UI_CLOSED_DONE");
        assert_eq!(unsafe { child.service(region) }.expect("publish"), 2);

        let host = EventRingHost::new(shm.clone());
        let mut attempted = Vec::new();
        assert_eq!(
            host.poll(|event| {
                attempted.push((event.seq, event.kind));
                false
            })
            .expect("defer first event"),
            // 規律3: 「先頭で停止」は idle と型で区別され、何が未解決か（seq/kind）を運ぶ。
            EventPollOutcome::Blocked {
                handled: 0,
                seq: 1,
                kind: EVT_UI_CLOSED
            }
        );
        assert_eq!(attempted, vec![(1, EVT_UI_CLOSED)]);
        assert_eq!(
            unsafe { (*region).evt_ack_seq.read() },
            0,
            "receipt alone must not ack an incomplete event"
        );

        let mut completed = Vec::new();
        assert_eq!(
            host.poll(|event| {
                completed.push((
                    event.seq,
                    event.kind,
                    event.arg().expect("valid event arg").to_string(),
                ));
                true
            })
            .expect("complete queued events"),
            advanced(2)
        );
        assert_eq!(
            completed,
            vec![
                (1, EVT_UI_CLOSED, "close-started".into()),
                (2, EVT_UI_CLOSED_DONE, "close-complete".into()),
            ]
        );
        assert_eq!(unsafe { (*region).evt_ack_seq.read() }, 2);
        assert_eq!(
            host.poll(|_| true).expect("drained ring"),
            EventPollOutcome::Idle,
            "no new events must be distinguishable from a blocked head"
        );

        drop(mmap);
        let _ = std::fs::remove_file(shm);
    }

    #[test]
    fn event_ring_two_inflight_events_use_distinct_unacked_slots() {
        let shm = mailbox_test_path("event-two-slots");
        let mmap = create_shared(&shm).expect("create");
        let region = region_ptr(&mmap);
        let mut child = EventRingChild::new();
        child
            .queue(EVT_UI_CLOSED, "first-slot")
            .expect("queue first");
        child
            .queue(EVT_UI_CLOSED_DONE, "second-slot")
            .expect("queue second");

        assert_eq!(
            unsafe { child.service(region) }.expect("publish both"),
            2,
            "EVT_SLOTS=2 must accept both close-cycle events before either ack"
        );
        assert_eq!(unsafe { (*region).evt_ack_seq.read() }, 0);
        // 期待 index は本番の evt_slot_index() から導出せずハードコードする（自己参照にすると
        // 式の変異((seq-1) % EVT_SLOTS 等)を検出できない）。EVT_SLOTS = 2 前提の値。
        assert_eq!(
            EVT_SLOTS, 2,
            "hardcoded slot indices below assume EVT_SLOTS = 2"
        );
        let first_index = 1usize; // seq 1 -> slot 1
        let second_index = 0usize; // seq 2 -> slot 0
        assert_ne!(
            first_index, second_index,
            "consecutive unacked events must occupy distinct slots"
        );
        unsafe {
            assert_eq!(
                read_cstr_field(&(*region).evt_arg[first_index]),
                Some("first-slot")
            );
            assert_eq!(
                read_cstr_field(&(*region).evt_arg[second_index]),
                Some("second-slot")
            );
        }

        drop(mmap);
        let _ = std::fs::remove_file(shm);
    }

    // Ordering 対（publish/read・ack/reuse・dirty）の退行はテストではなく型で防いでいる:
    // [`evt_sync`] が AtomicU64 を封じ、呼び出し箇所は Ordering を渡せない（渡す変異は
    // コンパイルできない）。値の同語反復を検査する旧 memory-model テストは撤去した。

    /// [`reset_child_starting`] 内の不変条件コメントが述べる「host は evt カーソルを
    /// 保持しない」を実行で守る。同一 [`EventRingHost`] instance を respawn（seq 0 リセット）
    /// またぎで使い、replacement child の seq 1 からのイベントが取りこぼしなく届くことを検証する。
    /// host にカーソルが生えるか、リセットが部分適用になると red になる。
    #[test]
    fn event_ring_host_survives_respawn_seq_reset_without_local_cursor() {
        let shm = mailbox_test_path("event-respawn-cursor");
        let mmap = create_shared(&shm).expect("create");
        let region = region_ptr(&mmap);
        let host = EventRingHost::new(shm.clone());

        // incarnation 1: publish → poll → ack を完走させ、host が「もしカーソルを持って
        // いたら」旧世代の水位で汚染された状態を作る。
        let mut old_child = EventRingChild::new();
        old_child
            .queue(EVT_UI_CLOSED, "old-start")
            .expect("queue old start");
        old_child
            .queue(EVT_UI_CLOSED_DONE, "old-done")
            .expect("queue old done");
        assert_eq!(
            unsafe { old_child.service(region) }.expect("old publish"),
            2
        );
        assert_eq!(
            host.poll(|_| true).expect("drain old incarnation"),
            advanced(2)
        );

        unsafe { reset_child_starting(region) };

        // incarnation 2: seq は 1 から再スタートする。
        let mut new_child = EventRingChild::new();
        new_child
            .queue(EVT_UI_CLOSED, "new-start")
            .expect("queue new start");
        new_child
            .queue(EVT_UI_CLOSED_DONE, "new-done")
            .expect("queue new done");
        assert_eq!(
            unsafe { new_child.service(region) }.expect("new publish"),
            2
        );

        let mut delivered = Vec::new();
        assert_eq!(
            host.poll(|event| {
                delivered.push((
                    event.seq,
                    event.kind,
                    event.arg().expect("valid arg").to_string(),
                ));
                true
            })
            .expect("poll replacement incarnation"),
            advanced(2),
            "same host instance must deliver exactly the replacement child's events"
        );
        assert_eq!(
            delivered,
            vec![
                (1, EVT_UI_CLOSED, "new-start".into()),
                (2, EVT_UI_CLOSED_DONE, "new-done".into()),
            ]
        );

        drop(mmap);
        let _ = std::fs::remove_file(shm);
    }

    #[test]
    fn event_ring_child_retains_blocked_event_and_retries_after_ack() {
        let shm = mailbox_test_path("event-retry");
        let mmap = create_shared(&shm).expect("create");
        let region = region_ptr(&mmap);
        let mut child = EventRingChild::new();
        child
            .queue(EVT_UI_CLOSED, "cycle-1-start")
            .expect("queue first");
        child
            .queue(EVT_UI_CLOSED_DONE, "cycle-1-done")
            .expect("queue second");
        child
            .queue(EVT_UI_CLOSED, "cycle-2-start")
            .expect("queue blocked third");

        assert_eq!(unsafe { child.service(region) }.expect("first tick"), 2);
        assert_eq!(
            child.pending_len(),
            1,
            "blocked lossless event must remain queued"
        );
        unsafe { (*region).evt_ack_seq.publish(1) };
        assert_eq!(unsafe { child.service(region) }.expect("retry tick"), 1);
        assert_eq!(child.pending_len(), 0, "retry must drain the pending queue");
        assert_eq!(unsafe { (*region).evt_seq.read() }, 3);
        // 期待 index はハードコード（evt_slot_index() を呼ぶと自己参照になり変異を検出できない）。
        assert_eq!(
            EVT_SLOTS, 2,
            "hardcoded slot index below assumes EVT_SLOTS = 2"
        );
        let third_index = 1usize; // seq 3 -> slot 1
        assert_eq!(
            unsafe { read_cstr_field(&(*region).evt_arg[third_index]) },
            Some("cycle-2-start")
        );

        drop(mmap);
        let _ = std::fs::remove_file(shm);
    }

    /// B（変異検出）: kind の値と seq の値が偶然一致するフィクスチャでは
    /// `evt_kind[index].store(event.kind, ..)` を `store(seq as u32, ..)` へ変異させても
    /// 全 green になる。意図的に kind ≠ seq の並び（DONE, CLOSED, DONE = 2, 1, 2）で積み、
    /// (seq, kind) の対応と shm 上の生値を明示 assert する。
    #[test]
    fn event_ring_kind_travels_in_its_slot_not_derived_from_seq() {
        let shm = mailbox_test_path("event-kind-vs-seq");
        let mmap = create_shared(&shm).expect("create");
        let region = region_ptr(&mmap);
        let mut child = EventRingChild::new();
        child
            .queue(EVT_UI_CLOSED_DONE, "seq1")
            .expect("queue seq 1");
        child.queue(EVT_UI_CLOSED, "seq2").expect("queue seq 2");
        child
            .queue(EVT_UI_CLOSED_DONE, "seq3")
            .expect("queue seq 3");
        assert_eq!(unsafe { child.service(region) }.expect("first publish"), 2);

        let host = EventRingHost::new(shm.clone());
        let mut delivered = Vec::new();
        let mut drain = |event: EventRingEvent| {
            delivered.push((event.seq, event.kind));
            true
        };
        assert_eq!(host.poll(&mut drain).expect("drain first two"), advanced(2));
        assert_eq!(unsafe { child.service(region) }.expect("publish third"), 1);
        assert_eq!(host.poll(&mut drain).expect("drain third"), advanced(1));
        assert_eq!(
            delivered,
            vec![
                (1, EVT_UI_CLOSED_DONE),
                (2, EVT_UI_CLOSED),
                (3, EVT_UI_CLOSED_DONE),
            ]
        );
        // shm 上の生値も確認する（index はハードコード・EVT_SLOTS = 2 前提）:
        // seq 3 -> slot 1 = DONE、seq 2 -> slot 0 = CLOSED。
        assert_eq!(EVT_SLOTS, 2, "hardcoded slot indices assume EVT_SLOTS = 2");
        unsafe {
            assert_eq!(
                (*region).evt_kind[1].load(Ordering::Relaxed),
                EVT_UI_CLOSED_DONE
            );
            assert_eq!((*region).evt_kind[0].load(Ordering::Relaxed), EVT_UI_CLOSED);
        }

        drop(mmap);
        let _ = std::fs::remove_file(shm);
    }

    /// A（規律1）: 取りこぼし不可イベントは arg のエンコード失敗（長すぎ・埋め込み NUL）で
    /// 消えない。arg はフォールバック文言へ差し替えられ、イベント自体は必ず届く。
    #[test]
    fn event_ring_queue_replaces_unencodable_arg_but_never_drops_the_event() {
        let shm = mailbox_test_path("event-arg-fallback");
        let mmap = create_shared(&shm).expect("create");
        let region = region_ptr(&mmap);
        let mut child = EventRingChild::new();
        // NUL 終端の 1 バイト分も収まらない長さ（P3 のタイムアウト経路が載せる動的 detail を模す）。
        let oversized = "x".repeat(EVT_ARG_BYTES);
        child
            .queue(EVT_UI_CLOSED_DONE, &oversized)
            .expect("oversized arg must still enqueue the lossless event");
        child
            .queue(EVT_UI_CLOSED_DONE, "timeout\0detail")
            .expect("embedded NUL must still enqueue the lossless event");
        assert_eq!(child.pending_len(), 2, "no event may be dropped at queue()");
        assert_eq!(unsafe { child.service(region) }.expect("publish both"), 2);

        let host = EventRingHost::new(shm.clone());
        let mut args = Vec::new();
        assert_eq!(
            host.poll(|event| {
                args.push(
                    event
                        .arg()
                        .expect("fallback arg must be readable")
                        .to_string(),
                );
                true
            })
            .expect("poll fallback events"),
            advanced(2)
        );
        // 文言はハードコードで検証する（const 経由だと文言の破壊を検出できない）。
        // 元 arg のバイト長を必ず含む（host が原因に迫れる唯一の経路 — queue() の doc 参照）。
        // 256 = EVT_ARG_BYTES ぶんの "x"、14 = "timeout\0detail" のバイト長。
        assert_eq!(
            args,
            vec![
                "arg too long or embedded NUL (original len 256)".to_string(),
                "arg too long or embedded NUL (original len 14)".to_string(),
            ]
        );

        drop(mmap);
        let _ = std::fs::remove_file(shm);
    }

    /// H: 未知 kind は呼び出し側のプログラミングエラーとして Err のまま（enqueue しない）。
    #[test]
    fn event_ring_queue_rejects_unknown_kind_without_enqueueing() {
        let mut child = EventRingChild::new();
        assert_eq!(
            child.queue(99, "detail"),
            Err(EventRingChildError::UnknownKind(99))
        );
        assert_eq!(
            child.pending_len(),
            0,
            "a programming error must not enqueue anything"
        );
    }

    #[test]
    fn event_ring_child_is_drained_requires_no_pending_and_equal_cursors() {
        let shm = mailbox_test_path("event-child-drained");
        let mmap = create_shared(&shm).expect("create");
        let region = region_ptr(&mmap);
        let mut child = EventRingChild::new();

        assert!(
            unsafe { child.is_drained(region) },
            "the initial empty ring must be drained"
        );
        child
            .queue(EVT_UI_CLOSED, "pending")
            .expect("queue pending event");
        assert!(
            unsafe { !child.is_drained(region) },
            "pending_count != 0 must close the drain gate even when both cursors are zero"
        );

        assert_eq!(unsafe { child.service(region) }.expect("publish"), 1);
        assert_eq!(child.pending_len(), 0);
        assert!(
            unsafe { !child.is_drained(region) },
            "evt_ack_seq != evt_seq must close the drain gate even with no pending events"
        );

        unsafe { (*region).evt_ack_seq.publish(1) };
        assert!(
            unsafe { child.is_drained(region) },
            "zero pending events and equal cursors must drain the ring"
        );

        drop(mmap);
        let _ = std::fs::remove_file(shm);
    }

    /// H: seq 枯渇は loud に失敗し、イベントは pending に残る（silent drop しない）。
    #[test]
    fn event_ring_service_fails_loud_on_sequence_exhaustion_and_retains_event() {
        let shm = mailbox_test_path("event-seq-exhausted");
        let mmap = create_shared(&shm).expect("create");
        let region = region_ptr(&mmap);
        unsafe { (*region).evt_seq.publish(u64::MAX) };
        let mut child = EventRingChild::new();
        child.queue(EVT_UI_CLOSED_DONE, "done").expect("queue");
        assert_eq!(
            unsafe { child.service(region) },
            Err(EventRingChildError::SequenceExhausted)
        );
        assert_eq!(
            child.pending_len(),
            1,
            "exhaustion must not silently drop the lossless event"
        );

        drop(mmap);
        let _ = std::fs::remove_file(shm);
    }

    /// H: `ack > published` の壊れた shm 状態は InvalidData で loud に失敗する。
    #[test]
    fn event_ring_poll_fails_loud_when_ack_exceeds_published() {
        let shm = mailbox_test_path("event-ack-overrun");
        let mmap = create_shared(&shm).expect("create");
        let region = region_ptr(&mmap);
        unsafe { (*region).evt_ack_seq.publish(4) };

        let host = EventRingHost::new(shm.clone());
        let mut invoked = false;
        let error = host
            .poll(|_| {
                invoked = true;
                true
            })
            .expect_err("ack beyond published must fail loud");
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert!(
            error.to_string().contains("exceeds published seq"),
            "got: {error}"
        );
        assert!(!invoked, "no handler may run on corrupted ring state");

        drop(mmap);
        let _ = std::fs::remove_file(shm);
    }

    /// 排他ゲート: handler の中から同じ host の poll を呼ぶ再入は、deadlock ではなく
    /// 明示的な `Err` になり、外側の poll はそのまま完結できる。ゲートは外側 poll の
    /// 完了で解放され、後続の poll は成功する。
    #[test]
    fn event_ring_poll_reentry_from_handler_fails_loud_instead_of_deadlocking() {
        let shm = mailbox_test_path("event-poll-reentry");
        let mmap = create_shared(&shm).expect("create");
        let region = region_ptr(&mmap);
        let mut child = EventRingChild::new();
        child.queue(EVT_UI_CLOSED, "reentry").expect("queue");
        assert_eq!(unsafe { child.service(region) }.expect("publish"), 1);

        let host = EventRingHost::new(shm.clone());
        let mut inner_result = None;
        assert_eq!(
            host.poll(|_| {
                inner_result = Some(host.poll(|_| true));
                true
            })
            .expect("outer poll must complete"),
            advanced(1)
        );
        let inner = inner_result.expect("handler must have attempted the re-entrant poll");
        let error = inner.expect_err("re-entrant poll must fail loud, not succeed");
        assert!(
            error.to_string().contains("non-reentrant"),
            "error must name the contract: {error}"
        );
        // 再入の Err で内側イベントが処理されていない（ack は外側の 1 件ぶんだけ）。
        assert_eq!(unsafe { (*region).evt_ack_seq.read() }, 1);
        // ゲートは外側 poll の完了で解放済み。
        assert_eq!(
            host.poll(|_| true).expect("subsequent poll must succeed"),
            EventPollOutcome::Idle
        );

        drop(mmap);
        let _ = std::fs::remove_file(shm);
    }

    /// 排他ゲート: handler の panic でゲートが恒久 poison しない（`Mutex` 版には無かった
    /// 回復経路）。panic したイベントは未 ack のまま残り、次の poll が同じ seq から
    /// 再配送して完結できる。
    #[test]
    fn event_ring_poll_recovers_after_handler_panic_and_redelivers_unacked_event() {
        let shm = mailbox_test_path("event-poll-panic");
        let mmap = create_shared(&shm).expect("create");
        let region = region_ptr(&mmap);
        let mut child = EventRingChild::new();
        child.queue(EVT_UI_CLOSED, "will-panic").expect("queue");
        assert_eq!(unsafe { child.service(region) }.expect("publish"), 1);

        let host = EventRingHost::new(shm.clone());
        let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            host.poll(|_| panic!("handler exploded"))
        }));
        assert!(
            panicked.is_err(),
            "handler panic must propagate to the caller"
        );
        assert_eq!(
            unsafe { (*region).evt_ack_seq.read() },
            0,
            "a panicked handler must not ack its event"
        );

        let mut redelivered = Vec::new();
        assert_eq!(
            host.poll(|event| {
                redelivered.push((event.seq, event.kind));
                true
            })
            .expect("poll after a handler panic must succeed (no permanent poisoning)"),
            advanced(1)
        );
        assert_eq!(redelivered, vec![(1, EVT_UI_CLOSED)]);

        drop(mmap);
        let _ = std::fs::remove_file(shm);
    }

    #[test]
    fn dirty_epoch_increments_and_host_observes_monotone_watermark() {
        let shm = mailbox_test_path("dirty-epoch");
        let mmap = create_shared(&shm).expect("create");
        let region = region_ptr(&mmap);
        let host = EventRingHost::new(shm.clone());

        assert_eq!(host.observe_dirty_epoch().expect("initial observe"), None);
        assert_eq!(unsafe { increment_dirty_epoch(region) }, 1);
        assert_eq!(unsafe { increment_dirty_epoch(region) }, 2);
        assert_eq!(
            host.observe_dirty_epoch().expect("coalesced observe"),
            Some(2)
        );
        assert_eq!(host.observe_dirty_epoch().expect("unchanged observe"), None);
        assert_eq!(unsafe { increment_dirty_epoch(region) }, 3);
        assert_eq!(host.observe_dirty_epoch().expect("next observe"), Some(3));

        drop(mmap);
        let _ = std::fs::remove_file(shm);
    }

    #[test]
    fn reset_child_starting_clears_event_ring_but_preserves_dirty_epoch() {
        let shm = mailbox_test_path("event-reset");
        let mmap = create_shared(&shm).expect("create");
        let region = region_ptr(&mmap);
        let host = EventRingHost::new(shm.clone());
        for expected in 1..=5 {
            assert_eq!(unsafe { increment_dirty_epoch(region) }, expected);
        }
        assert_eq!(
            host.observe_dirty_epoch().expect("observe old child"),
            Some(5)
        );

        let mut child = EventRingChild::new();
        child
            .queue(EVT_UI_CLOSED, "old-incarnation")
            .expect("queue old event");
        assert_eq!(
            unsafe { child.service(region) }.expect("publish old event"),
            1
        );
        unsafe { reset_child_starting(region) };

        unsafe {
            assert_eq!((*region).evt_seq.read(), 0);
            assert_eq!((*region).evt_ack_seq.read(), 0);
            for index in 0..EVT_SLOTS {
                assert_eq!((*region).evt_kind[index].load(Ordering::Relaxed), EVT_NONE);
                assert_eq!(read_cstr_field(&(*region).evt_arg[index]), Some(""));
            }
            assert_eq!(
                (*region).dirty_epoch.read(),
                5,
                "respawn reset must not lower the dirty watermark"
            );
        }
        assert_eq!(unsafe { increment_dirty_epoch(region) }, 6);
        assert_eq!(
            host.observe_dirty_epoch()
                .expect("observe replacement child"),
            Some(6),
            "replacement child dirty must immediately exceed host-local last_seen"
        );

        drop(mmap);
        let _ = std::fs::remove_file(shm);
    }

    #[test]
    fn command_mailbox_host_round_trips_one_exact_ack() {
        let shm = mailbox_test_path("round-trip");
        let mmap = create_shared(&shm).expect("create");
        let host = Arc::new(CommandMailboxHost::new(shm.clone()));
        let child_shm = shm.clone();
        let child = std::thread::spawn(move || {
            let child_mmap = open_shared(&child_shm).expect("child map");
            let region = region_ptr(&child_mmap);
            let seq = wait_for_command(region);
            unsafe {
                assert_eq!((*region).cmd_kind.load(Ordering::Acquire), CMD_SAVE_STATE);
                assert_eq!(
                    read_cstr_field(&(*region).cmd_arg),
                    Some("/tmp/orbit-mailbox-state.bin")
                );
                (*region).cmd_result_len.store(321, Ordering::Relaxed);
                (*region).cmd_result.store(CMD_RESULT_OK, Ordering::Relaxed);
                (*region).cmd_ack_seq.store(seq, Ordering::Release);
            }
        });

        let response = host
            .issue_save_state(Path::new("/tmp/orbit-mailbox-state.bin"))
            .expect("mailbox success");
        assert_eq!(response.bytes_written, 321);
        child.join().expect("child join");
        drop(mmap);
        let _ = std::fs::remove_file(shm);
    }

    #[test]
    fn command_mailbox_host_issues_open_and_close_ui_with_success_detail() {
        let shm = mailbox_test_path("ui-commands");
        let mmap = create_shared(&shm).expect("create");
        let host = CommandMailboxHost::new(shm.clone());
        let child_shm = shm.clone();
        let child = std::thread::spawn(move || {
            let child_mmap = open_shared(&child_shm).expect("child map");
            let region = region_ptr(&child_mmap);
            let mut previous_seq = 0;
            for (expected_kind, expected_arg, detail) in [
                (CMD_OPEN_UI, "Oracle — lead[0]", ""),
                (CMD_CLOSE_UI, "", "already-closing"),
            ] {
                let deadline = Instant::now() + Duration::from_secs(1);
                let seq = loop {
                    let seq = unsafe { (*region).cmd_seq.load(Ordering::Acquire) };
                    if seq > previous_seq {
                        break seq;
                    }
                    assert!(Instant::now() < deadline, "next UI command not published");
                    std::thread::sleep(Duration::from_millis(1));
                };
                unsafe {
                    assert_eq!((*region).cmd_kind.load(Ordering::Acquire), expected_kind);
                    assert_eq!(read_cstr_field(&(*region).cmd_arg), Some(expected_arg));
                    assert!(write_cstr_field(&mut (*region).cmd_result_detail, detail));
                    (*region).cmd_result_len.store(0, Ordering::Relaxed);
                    (*region).cmd_result.store(CMD_RESULT_OK, Ordering::Relaxed);
                    (*region).cmd_ack_seq.store(seq, Ordering::Release);
                }
                previous_seq = seq;
            }
        });

        let open = host.issue_open_ui("Oracle — lead[0]").expect("OPEN_UI ack");
        assert_eq!(open.bytes_written, 0);
        assert_eq!(open.detail, "");
        let close = host.issue_close_ui().expect("CLOSE_UI ack");
        assert_eq!(close.bytes_written, 0);
        assert_eq!(close.detail, "already-closing");

        child.join().expect("child join");
        drop(mmap);
        let _ = std::fs::remove_file(shm);
    }

    #[test]
    fn command_mailbox_host_rejects_a_second_outstanding_command() {
        let shm = mailbox_test_path("single-outstanding");
        let mmap = create_shared(&shm).expect("create");
        let host = Arc::new(CommandMailboxHost::new(shm.clone()));
        let child_shm = shm.clone();
        let child = std::thread::spawn(move || {
            let child_mmap = open_shared(&child_shm).expect("child map");
            let region = region_ptr(&child_mmap);
            let seq = wait_for_command(region);
            std::thread::sleep(Duration::from_millis(40));
            unsafe {
                (*region).cmd_result_len.store(1, Ordering::Relaxed);
                (*region).cmd_result.store(CMD_RESULT_OK, Ordering::Relaxed);
                (*region).cmd_ack_seq.store(seq, Ordering::Release);
            }
        });
        let first_host = host.clone();
        let first = std::thread::spawn(move || {
            first_host.issue_save_state(Path::new("/tmp/orbit-mailbox-first.bin"))
        });
        let region = region_ptr(&mmap);
        let seq = wait_for_command(region);
        let second = host
            .issue_save_state(Path::new("/tmp/orbit-mailbox-second.bin"))
            .expect_err("second command must not overwrite the first");
        assert!(matches!(second, CommandMailboxError::Busy { seq: busy } if busy == seq));
        assert_eq!(
            first
                .join()
                .expect("first issuer join")
                .expect("first command")
                .bytes_written,
            1
        );
        child.join().expect("child join");
        drop(mmap);
        let _ = std::fs::remove_file(shm);
    }

    #[test]
    fn command_mailbox_timeout_keeps_the_slot_poisoned_until_late_ack() {
        let shm = mailbox_test_path("timeout");
        let mmap = create_shared(&shm).expect("create");
        let host = CommandMailboxHost::new(shm.clone());
        let timed_out_sidecar =
            std::env::temp_dir().join(format!("orbit-mailbox-timeout-{}.bin", std::process::id()));
        let _ = std::fs::remove_file(&timed_out_sidecar);

        let error = host
            .issue_save_state_with_timeout(&timed_out_sidecar, Duration::from_millis(15))
            .expect_err("unacknowledged command must time out");
        let timed_out_seq = match error {
            CommandMailboxError::Timeout { seq, elapsed } => {
                assert!(elapsed >= Duration::from_millis(15));
                seq
            }
            other => panic!("unexpected timeout error: {other}"),
        };
        std::fs::write(&timed_out_sidecar, b"late child output")
            .expect("simulate sidecar written after host timeout");
        assert!(matches!(
            host.issue_save_state_with_timeout(
                Path::new("/tmp/orbit-mailbox-overwrite.bin"),
                Duration::from_millis(5)
            ),
            Err(CommandMailboxError::Poisoned { seq }) if seq == timed_out_seq
        ));

        let region = region_ptr(&mmap);
        unsafe {
            (*region).cmd_result_len.store(9, Ordering::Relaxed);
            (*region).cmd_result.store(CMD_RESULT_OK, Ordering::Relaxed);
            (*region)
                .cmd_ack_seq
                .store(timed_out_seq, Ordering::Release);
        }
        let child_shm = shm.clone();
        let child = std::thread::spawn(move || {
            let child_mmap = open_shared(&child_shm).expect("child map");
            let child_region = region_ptr(&child_mmap);
            let deadline = Instant::now() + Duration::from_secs(1);
            loop {
                let seq = unsafe { (*child_region).cmd_seq.load(Ordering::Acquire) };
                if seq > timed_out_seq {
                    unsafe {
                        (*child_region).cmd_result_len.store(11, Ordering::Relaxed);
                        (*child_region)
                            .cmd_result
                            .store(CMD_RESULT_OK, Ordering::Relaxed);
                        (*child_region).cmd_ack_seq.store(seq, Ordering::Release);
                    }
                    break;
                }
                assert!(
                    Instant::now() < deadline,
                    "replacement command not published"
                );
                std::thread::sleep(Duration::from_millis(1));
            }
        });
        let warning_messages = Arc::new(Mutex::new(Vec::new()));
        let response = tracing::subscriber::with_default(
            WarningSubscriber {
                messages: warning_messages.clone(),
            },
            || {
                host.issue_save_state_with_timeout(
                    Path::new("/tmp/orbit-mailbox-after-late-ack.bin"),
                    Duration::from_millis(250),
                )
            },
        )
        .expect("late exact ack releases the poisoned slot");
        assert_eq!(response.bytes_written, 11);
        assert!(
            warning_messages
                .lock()
                .expect("warning messages lock")
                .iter()
                .any(|message| message
                    .contains("discarding plugin state saved after mailbox timeout")),
            "late successful state cleanup must emit a warning"
        );
        assert!(
            !timed_out_sidecar.exists(),
            "late-ack sidecar must be removed before mailbox reuse"
        );
        child.join().expect("child join");
        drop(mmap);
        let _ = std::fs::remove_file(shm);
    }

    #[test]
    fn command_mailbox_late_failed_ack_does_not_emit_success_warning() {
        let shm = mailbox_test_path("late-failed-ack");
        let mmap = create_shared(&shm).expect("create");
        let host = CommandMailboxHost::new(shm.clone());
        let sidecar = mailbox_test_path("late-failed-ack-sidecar");

        let timed_out_seq = match host
            .issue_save_state_with_timeout(&sidecar, Duration::from_millis(15))
            .expect_err("unacknowledged command must time out")
        {
            CommandMailboxError::Timeout { seq, .. } => seq,
            other => panic!("unexpected timeout error: {other}"),
        };
        let region = region_ptr(&mmap);
        unsafe {
            (*region)
                .cmd_result
                .store(CMD_RESULT_PLUGIN_ERROR, Ordering::Relaxed);
            (*region)
                .cmd_ack_seq
                .store(timed_out_seq, Ordering::Release);
        }

        let warning_messages = Arc::new(Mutex::new(Vec::new()));
        tracing::subscriber::with_default(
            WarningSubscriber {
                messages: warning_messages.clone(),
            },
            || host.reset_after_child_exit(),
        )
        .expect("failed late ack cleanup and reset");
        assert!(
            warning_messages
                .lock()
                .expect("warning messages lock")
                .iter()
                .all(|message| !message
                    .contains("discarding plugin state saved after mailbox timeout")),
            "a failed late ack must not be described as a successful discarded save"
        );

        drop(mmap);
        let _ = std::fs::remove_file(shm);
    }

    #[test]
    fn command_mailbox_retry_cleanup_failure_releases_slot_and_stays_loud() {
        let shm = mailbox_test_path("retry-cleanup-failure");
        let mmap = create_shared(&shm).expect("create");
        let host = CommandMailboxHost::new(shm.clone());
        let abandoned_sidecar = mailbox_test_path("retry-cleanup-directory");
        std::fs::create_dir(&abandoned_sidecar).expect("create cleanup target directory");

        let timed_out_seq = match host
            .issue_save_state_with_timeout(&abandoned_sidecar, Duration::from_millis(15))
            .expect_err("unacknowledged command must time out")
        {
            CommandMailboxError::Timeout { seq, .. } => seq,
            other => panic!("unexpected timeout error: {other}"),
        };
        let region = region_ptr(&mmap);
        unsafe {
            (*region)
                .cmd_result
                .store(CMD_RESULT_PLUGIN_ERROR, Ordering::Relaxed);
            (*region)
                .cmd_ack_seq
                .store(timed_out_seq, Ordering::Release);
        }

        let cleanup_error = host
            .issue_save_state_with_timeout(
                Path::new("/tmp/orbit-mailbox-after-cleanup-error.bin"),
                Duration::from_millis(5),
            )
            .expect_err("directory sidecar cleanup must stay loud");
        assert!(matches!(
            cleanup_error,
            CommandMailboxError::SidecarCleanup { path, .. } if path == abandoned_sidecar
        ));

        let child = ack_next_success(shm.clone(), timed_out_seq, 17);
        let response = host
            .issue_save_state_with_timeout(
                Path::new("/tmp/orbit-mailbox-after-released-slot.bin"),
                Duration::from_millis(250),
            )
            .expect("cleanup failure must not leave the mailbox slot occupied");
        assert_eq!(response.bytes_written, 17);
        child.join().expect("child join");

        std::fs::remove_dir(abandoned_sidecar).expect("remove cleanup target directory");
        drop(mmap);
        let _ = std::fs::remove_file(shm);
    }

    #[test]
    fn command_mailbox_reset_cleanup_failure_releases_slot_and_stays_loud() {
        let shm = mailbox_test_path("reset-cleanup-failure");
        let mmap = create_shared(&shm).expect("create");
        let host = CommandMailboxHost::new(shm.clone());
        let abandoned_sidecar = mailbox_test_path("reset-cleanup-directory");
        std::fs::create_dir(&abandoned_sidecar).expect("create cleanup target directory");

        let timed_out_seq = match host
            .issue_save_state_with_timeout(&abandoned_sidecar, Duration::from_millis(15))
            .expect_err("unacknowledged command must time out")
        {
            CommandMailboxError::Timeout { seq, .. } => seq,
            other => panic!("unexpected timeout error: {other}"),
        };

        let cleanup_error = host
            .reset_after_child_exit()
            .expect_err("directory sidecar cleanup must stay loud");
        assert!(matches!(
            cleanup_error,
            CommandMailboxError::SidecarCleanup { path, .. } if path == abandoned_sidecar
        ));

        let child = ack_next_success(shm.clone(), timed_out_seq, 23);
        let response = host
            .issue_save_state_with_timeout(
                Path::new("/tmp/orbit-mailbox-after-reset-cleanup-error.bin"),
                Duration::from_millis(250),
            )
            .expect("reset cleanup failure must not leave the mailbox slot occupied");
        assert_eq!(response.bytes_written, 23);
        child.join().expect("child join");

        std::fs::remove_dir(abandoned_sidecar).expect("remove cleanup target directory");
        drop(mmap);
        let _ = std::fs::remove_file(shm);
    }

    #[test]
    fn command_mailbox_reset_fails_inflight_before_replacement_spawn() {
        let shm = mailbox_test_path("reset");
        let mmap = create_shared(&shm).expect("create");
        let host = Arc::new(CommandMailboxHost::new(shm.clone()));
        let abandoned_sidecar =
            std::env::temp_dir().join(format!("orbit-mailbox-reset-{}.bin", std::process::id()));
        let _ = std::fs::remove_file(&abandoned_sidecar);
        std::fs::write(&abandoned_sidecar, b"partial child output")
            .expect("create abandoned sidecar");
        let issuer_host = host.clone();
        let issuer_sidecar = abandoned_sidecar.clone();
        let issuer = std::thread::spawn(move || {
            issuer_host.issue_save_state_with_timeout(&issuer_sidecar, Duration::from_secs(1))
        });
        let region = region_ptr(&mmap);
        let seq = wait_for_command(region);
        host.reset_after_child_exit().expect("reset after death");
        let error = issuer
            .join()
            .expect("issuer join")
            .expect_err("in-flight command must fail on child death");
        assert!(matches!(
            error,
            CommandMailboxError::ChildExited {
                seq: failed_seq,
                ..
            } if failed_seq == seq
        ));
        unsafe {
            assert_eq!((*region).cmd_ack_seq.load(Ordering::Acquire), seq);
            assert_eq!(
                (*region).cmd_result.load(Ordering::Relaxed),
                CMD_RESULT_CHILD_EXITED
            );
            assert_eq!((*region).cmd_kind.load(Ordering::Relaxed), CMD_NONE);
            assert_eq!(
                (*region).child_status.load(Ordering::Acquire),
                CHILD_STATUS_STARTING
            );
        }
        assert!(
            !abandoned_sidecar.exists(),
            "child death/reset must remove its abandoned sidecar"
        );
        drop(mmap);
        let _ = std::fs::remove_file(shm);
    }

    #[test]
    fn command_mailbox_requires_an_exact_ack_and_valid_bounded_path() {
        let shm = mailbox_test_path("exact-ack");
        let mmap = create_shared(&shm).expect("create");
        let host = CommandMailboxHost::new(shm.clone());
        let child_shm = shm.clone();
        let child = std::thread::spawn(move || {
            let child_mmap = open_shared(&child_shm).expect("child map");
            let region = region_ptr(&child_mmap);
            let seq = wait_for_command(region);
            unsafe { (*region).cmd_ack_seq.store(seq + 1, Ordering::Release) };
        });
        assert!(matches!(
            host.issue_save_state_with_timeout(
                Path::new("/tmp/orbit-mailbox-exact.bin"),
                Duration::from_millis(250)
            ),
            Err(CommandMailboxError::Protocol { seq, ack }) if ack == seq + 1
        ));
        child.join().expect("child join");

        let too_long = format!("/{}", "x".repeat(CMD_ARG_BYTES));
        assert!(matches!(
            CommandMailboxHost::new(shm.clone())
                .issue_save_state_with_timeout(Path::new(&too_long), Duration::from_millis(1)),
            Err(CommandMailboxError::InvalidArgument(_))
        ));
        assert!(matches!(
            CommandMailboxHost::new(shm.clone()).issue_save_state_with_timeout(
                Path::new("/tmp/before\0after"),
                Duration::from_millis(1)
            ),
            Err(CommandMailboxError::InvalidArgument(_))
        ));
        drop(mmap);
        let _ = std::fs::remove_file(shm);
    }

    // ── #555: コマンドメールボックスの引数エンコード（UIH.2） ──

    #[test]
    fn cstr_field_round_trips_paths() {
        let mut field = [0u8; CMD_ARG_BYTES];
        let path = "/tmp/orbit-state-42.bin";
        assert!(write_cstr_field(&mut field, path), "書き込めるはず");
        assert_eq!(read_cstr_field(&field), Some(path));
    }

    /// 🔴 収まらない値は **切り詰めずに拒否** する。切り詰めると別のパスへ書いてしまう。
    #[test]
    fn cstr_field_refuses_to_truncate() {
        let mut field = [0u8; 8];
        assert!(
            !write_cstr_field(&mut field, "0123456789"),
            "収まらないのに書き込みを許した（切り詰めは別パスへの書き込みを招く）"
        );
        // NUL 終端ぎりぎり（7 バイト + NUL = 8）は通る。
        assert!(write_cstr_field(&mut field, "0123456"));
        assert_eq!(read_cstr_field(&field), Some("0123456"));
    }

    /// NUL 終端が無い / 非 UTF-8 は `None`（**黙って途中まで読まない**）。
    #[test]
    fn cstr_field_rejects_unterminated_and_invalid_utf8() {
        let unterminated = [b'a'; 8];
        assert_eq!(read_cstr_field(&unterminated), None, "NUL 無しを受理した");

        let mut invalid = [0u8; 8];
        invalid[0] = 0xFF;
        invalid[1] = 0;
        assert_eq!(read_cstr_field(&invalid), None, "非 UTF-8 を受理した");

        let empty_terminated = [0u8; 8];
        assert_eq!(read_cstr_field(&empty_terminated), Some(""));
    }

    #[test]
    fn cstr_field_refuses_a_value_with_an_embedded_nul() {
        // 埋め込み NUL を書けてしまうと read 側が最初の NUL で切るため、
        // 「切り詰めない」保証が黙って崩れる。拒否側に倒していることを押さえる。
        let mut field = [0u8; 32];
        assert!(
            !write_cstr_field(&mut field, "before\0after"),
            "埋め込み NUL を受理した"
        );
        assert_eq!(
            field, [0u8; 32],
            "拒否したのに書き込んでいる（部分書き込みは前回値を壊す）"
        );
    }

    #[test]
    fn reset_control_run_rearms_region_after_attach_teardown() {
        let path = std::env::temp_dir().join(format!(
            "orbit-sbx-reset-control-{}.shm",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        let mmap = create_shared(&path).expect("create");
        let region = region_ptr(&mmap);
        // SAFETY: region は上で作成した生存 mapping を指す。
        unsafe {
            (*region).control.store(CONTROL_QUIT, Ordering::Release);
            reset_control_run(region);
            assert_eq!((*region).control.load(Ordering::Acquire), CONTROL_RUN);
        }
        drop(mmap);
        let _ = std::fs::remove_file(path);
    }

    fn publish_ui_event(
        region: *mut SharedRegion,
        child: &mut EventRingChild,
        kind: u32,
        arg: &str,
    ) {
        child.queue(kind, arg).expect("queue UI event");
        assert_eq!(
            unsafe { child.service(region) }.expect("publish UI event"),
            1
        );
    }

    /// #592: poll の固定 sink が停止している間、respawn reset は pump lock の外へ出られない。
    /// raw `reset_child_starting` へ差し替える変異では `reset_done` が release 前に届いて red になる。
    #[test]
    fn ui_event_pump_serializes_poll_sink_and_respawn_reset() {
        let shm = mailbox_test_path("ui-pump-reset-exclusion");
        let mmap = create_shared(&shm).expect("create");
        let region = region_ptr(&mmap);
        let mut child = EventRingChild::new();
        publish_ui_event(region, &mut child, EVT_UI_CLOSED, "");

        let pump = Arc::new(UiEventPump::new(shm.clone()));
        let mailbox = Arc::new(CommandMailboxHost::new(shm.clone()));
        let (sink_entered_tx, sink_entered_rx) = std::sync::mpsc::channel();
        let (release_sink_tx, release_sink_rx) = std::sync::mpsc::channel();
        let poll_pump = pump.clone();
        let poller = std::thread::spawn(move || {
            poll_pump.poll_step(|notification| {
                assert!(matches!(notification, UiPumpNotification::Safepoint { .. }));
                sink_entered_tx.send(()).expect("announce sink entry");
                release_sink_rx.recv().expect("release sink");
                true
            })
        });
        sink_entered_rx.recv().expect("poll reached sink");

        let reset_pump = pump.clone();
        let reset_mailbox = mailbox.clone();
        let (reset_done_tx, reset_done_rx) = std::sync::mpsc::channel();
        let resetter = std::thread::spawn(move || {
            let result = reset_pump.reset_after_child_exit(&reset_mailbox);
            reset_done_tx.send(result).expect("report reset");
        });
        assert!(
            matches!(
                reset_done_rx.recv_timeout(Duration::from_millis(50)),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout)
            ),
            "reset must remain blocked while poll_step owns the pump lock"
        );
        // 🔴 排他の実体はリングの不変性であって、reset の戻りが遅いことではない。
        // 完了タイミングだけを見ていると、「pump lock を取る前にリングを潰し、その後
        // lock で待つ」という #592 そのものの実装が素通りする（実際に変異で確認済み）。
        assert_eq!(
            unsafe { (*region).evt_seq.read() },
            1,
            "the event ring must not be reset while poll_step is in flight"
        );
        release_sink_tx.send(()).expect("release poll sink");
        assert!(matches!(
            poller.join().expect("poller join").expect("poll result"),
            EventPollOutcome::Blocked { seq: 1, .. }
        ));
        reset_done_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("reset completes after poll release")
            .expect("reset result");
        resetter.join().expect("resetter join");

        drop(mmap);
        let _ = std::fs::remove_file(shm);
    }

    /// 補助 stress: safe publish order（kind/arg → seq → ack）と reset を別スレッドで交互に走らせ、
    /// pump 排他下の poll がリセット途中の `ack > published` を一度も観測しないことを押さえる。
    #[test]
    fn ui_event_pump_poll_reset_stress_has_no_false_invalid_data() {
        const ITERATIONS: usize = 4_000;
        let shm = mailbox_test_path("ui-pump-reset-stress");
        let mmap = create_shared(&shm).expect("create");
        let region = region_ptr(&mmap);
        let pump = Arc::new(UiEventPump::new(shm.clone()));
        let mailbox = Arc::new(CommandMailboxHost::new(shm.clone()));
        let stop = Arc::new(AtomicBool::new(false));
        let errors = Arc::new(Mutex::new(Vec::new()));

        let poll_pump = pump.clone();
        let poll_stop = stop.clone();
        let poll_errors = errors.clone();
        let poller = std::thread::spawn(move || {
            while !poll_stop.load(Ordering::Acquire) {
                if let Err(error) = poll_pump.poll_step(|_| true) {
                    poll_errors
                        .lock()
                        .expect("errors lock")
                        .push(error.to_string());
                }
                std::thread::yield_now();
            }
        });

        for _ in 0..ITERATIONS {
            // Setup order never creates ack > published. A raw reset mutation does: seq=0 is
            // visible before ack=0, which the concurrent poller catches often and records.
            unsafe {
                assert!(write_cstr_field(
                    &mut (*region).evt_arg[evt_slot_index(1)],
                    "safepoint-completed"
                ));
                (*region).evt_kind[evt_slot_index(1)].store(EVT_UI_CLOSED_DONE, Ordering::Relaxed);
                (*region).evt_seq.publish(1);
                (*region).evt_ack_seq.publish(1);
            }
            pump.reset_after_child_exit(&mailbox).expect("pump reset");
        }
        stop.store(true, Ordering::Release);
        poller.join().expect("poller join");
        let errors = errors.lock().expect("errors lock");
        // 特定の一文字列だけを禁じると、それ以外の破損シグネチャを**全部黙認**する。
        // 健全時の観測エラーは 0 件なので（実測）、締めても偽陽性は増えない。
        assert!(
            errors.is_empty(),
            "poll observed a partial reset or any other pump error: {errors:?}"
        );

        drop(mmap);
        let _ = std::fs::remove_file(shm);
    }

    /// Real shm scripted child: CLOSE_UI command ack is Phase A acceptance only. Completion is
    /// emitted solely after engine ack advances the safepoint and child publishes DONE.
    #[test]
    fn ui_event_pump_close_completion_originates_from_done_not_command_ack_or_closed() {
        let shm = mailbox_test_path("ui-pump-scripted-close");
        let mmap = create_shared(&shm).expect("create");
        let region = region_ptr(&mmap);
        let mailbox = Arc::new(CommandMailboxHost::new(shm.clone()));
        let pump = UiEventPump::new(shm.clone());
        let child_shm = shm.clone();
        let child = std::thread::spawn(move || {
            let child_mmap = open_shared(&child_shm).expect("child map");
            let child_region = region_ptr(&child_mmap);
            let seq = wait_for_command(child_region);
            unsafe {
                assert_eq!(
                    (*child_region).cmd_kind.load(Ordering::Acquire),
                    CMD_CLOSE_UI
                );
                (*child_region)
                    .cmd_result
                    .store(CMD_RESULT_OK, Ordering::Relaxed);
                (*child_region).cmd_ack_seq.store(seq, Ordering::Release);
            }
            let mut events = EventRingChild::new();
            publish_ui_event(child_region, &mut events, EVT_UI_CLOSED, "");
            let deadline = Instant::now() + Duration::from_secs(1);
            while unsafe { (*child_region).evt_ack_seq.read() } < 1 {
                assert!(
                    Instant::now() < deadline,
                    "engine safepoint ack did not arrive"
                );
                std::thread::sleep(Duration::from_millis(1));
            }
            publish_ui_event(
                child_region,
                &mut events,
                EVT_UI_CLOSED_DONE,
                "safepoint-completed",
            );
        });

        let issuer_mailbox = mailbox.clone();
        let issuer = std::thread::spawn(move || issuer_mailbox.issue_close_ui());
        issuer
            .join()
            .expect("issuer join")
            .expect("Phase A command ack");

        let mut notifications = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(1);
        while notifications.is_empty() {
            pump.poll_step(|event| {
                notifications.push(event);
                true
            })
            .expect("poll CLOSED");
            assert!(Instant::now() < deadline, "UI_CLOSED was not published");
            std::thread::yield_now();
        }
        assert_eq!(
            notifications,
            vec![UiPumpNotification::Safepoint {
                generation: 0,
                evt_seq: 1
            }],
            "command ack plus UI_CLOSED must not claim close completion"
        );
        assert_eq!(unsafe { (*region).evt_ack_seq.read() }, 0);

        pump.ack_safepoint(0, 1).expect("engine ack");
        let deadline = Instant::now() + Duration::from_secs(1);
        while notifications.len() < 2 {
            pump.poll_step(|event| {
                notifications.push(event);
                true
            })
            .expect("poll DONE");
            assert!(
                Instant::now() < deadline,
                "UI_CLOSED_DONE was not published"
            );
            std::thread::yield_now();
        }
        assert_eq!(
            notifications[1],
            UiPumpNotification::CloseDone {
                completion: UiCloseCompletion::SafepointCompleted
            }
        );
        child.join().expect("child join");

        drop(mmap);
        let _ = std::fs::remove_file(shm);
    }

    #[test]
    fn ui_event_pump_poll_step_maps_shared_region_once() {
        let shm = mailbox_test_path("ui-pump-single-map");
        let mmap = create_shared(&shm).expect("create");
        let pump = UiEventPump::new(shm.clone());
        OPEN_SHARED_CALL_COUNT.with(|count| count.set(0));

        assert_eq!(
            pump.poll_step(|_| true).expect("idle pump poll"),
            EventPollOutcome::Idle
        );
        assert_eq!(
            OPEN_SHARED_CALL_COUNT.with(Cell::get),
            1,
            "one poll_step must reuse its single shared-region mapping"
        );

        drop(mmap);
        let _ = std::fs::remove_file(shm);
    }

    #[test]
    fn ui_event_pump_does_not_ack_closed_before_engine_ack_and_notifies_once() {
        let shm = mailbox_test_path("ui-pump-engine-ack");
        let mmap = create_shared(&shm).expect("create");
        let region = region_ptr(&mmap);
        let mut child = EventRingChild::new();
        publish_ui_event(region, &mut child, EVT_UI_CLOSED, "");
        let pump = UiEventPump::new(shm.clone());
        let mut notifications = Vec::new();
        for _ in 0..2 {
            assert!(matches!(
                pump.poll_step(|event| {
                    notifications.push(event);
                    true
                })
                .expect("blocked poll"),
                EventPollOutcome::Blocked { seq: 1, .. }
            ));
            assert_eq!(
                unsafe { (*region).evt_ack_seq.read() },
                0,
                "Blocked UI_CLOSED must remain unacked before AckUiSafepoint"
            );
        }
        assert_eq!(
            notifications.len(),
            1,
            "a blocked head is notified only once"
        );
        pump.ack_safepoint(0, 1).expect("matching engine ack");
        assert_eq!(unsafe { (*region).evt_ack_seq.read() }, 1);

        drop(mmap);
        let _ = std::fs::remove_file(shm);
    }

    #[test]
    fn ui_event_pump_rejects_stale_generation_even_when_evt_seq_repeats() {
        let shm = mailbox_test_path("ui-pump-generation");
        let mmap = create_shared(&shm).expect("create");
        let region = region_ptr(&mmap);
        let pump = UiEventPump::new(shm.clone());
        let mailbox = CommandMailboxHost::new(shm.clone());
        let reset = pump
            .reset_after_child_exit(&mailbox)
            .expect("advance generation");
        assert_eq!(reset.generation, 1);
        let mut child = EventRingChild::new();
        publish_ui_event(region, &mut child, EVT_UI_CLOSED, "");
        pump.poll_step(|_| true).expect("notify generation 1");

        assert!(matches!(
            pump.ack_safepoint(0, 1),
            Err(UiEventPumpError::GenerationMismatch {
                expected: 1,
                actual: 0
            })
        ));
        assert_eq!(
            unsafe { (*region).evt_ack_seq.read() },
            0,
            "stale generation must not ack replacement child's seq 1"
        );
        pump.ack_safepoint(1, 1).expect("current generation ack");

        drop(mmap);
        let _ = std::fs::remove_file(shm);
    }

    #[test]
    fn ui_event_pump_abandons_only_after_timeout_done_and_accepts_late_ack() {
        let shm = mailbox_test_path("ui-pump-abandon");
        let mmap = create_shared(&shm).expect("create");
        let region = region_ptr(&mmap);
        let pump = UiEventPump::new(shm.clone());
        let mut child = EventRingChild::new();
        publish_ui_event(region, &mut child, EVT_UI_CLOSED, "");
        let mut notifications = Vec::new();
        pump.poll_step(|event| {
            notifications.push(event);
            true
        })
        .expect("initial blocked poll");
        assert_eq!(unsafe { (*region).evt_ack_seq.read() }, 0);

        publish_ui_event(
            region,
            &mut child,
            EVT_UI_CLOSED_DONE,
            "timeout-without-save",
        );
        assert_eq!(
            pump.poll_step(|event| {
                notifications.push(event);
                true
            })
            .expect("abandon and drain DONE"),
            advanced(2)
        );
        assert_eq!(unsafe { (*region).evt_ack_seq.read() }, 2);
        assert_eq!(
            notifications,
            vec![
                UiPumpNotification::Safepoint {
                    generation: 0,
                    evt_seq: 1
                },
                UiPumpNotification::CloseDone {
                    completion: UiCloseCompletion::TimedOutWithoutSave
                }
            ]
        );
        pump.ack_safepoint(0, 1)
            .expect("late completed save is accepted with warning");

        drop(mmap);
        let _ = std::fs::remove_file(shm);
    }

    /// An absent editor makes safepoint delivery fail on every tick. Once the child publishes its
    /// timeout DONE, that delivery failure must no longer hide abandonment: the CLOSED head is
    /// released, DONE can drain, and the lifecycle permits another open.
    #[test]
    fn ui_event_pump_abandons_after_timeout_despite_undeliverable_safepoint() {
        let shm = mailbox_test_path("ui-pump-abandon-undeliverable");
        let mmap = create_shared(&shm).expect("create");
        let region = region_ptr(&mmap);
        let pump = UiEventPump::new(shm.clone());
        let mut child = EventRingChild::new();
        publish_ui_event(region, &mut child, EVT_UI_CLOSED, "");

        let mut failed_deliveries = 0;
        for _ in 0..3 {
            assert!(matches!(
                pump.poll_step(|_| {
                    failed_deliveries += 1;
                    false
                })
                .expect("blocked while editor is absent"),
                EventPollOutcome::Blocked { seq: 1, .. }
            ));
        }
        assert_eq!(
            failed_deliveries, 3,
            "the safepoint must be retried until the child gives up"
        );
        assert_eq!(unsafe { (*region).evt_ack_seq.read() }, 0);

        publish_ui_event(
            region,
            &mut child,
            EVT_UI_CLOSED_DONE,
            "timeout-without-save",
        );
        assert!(matches!(
            pump.poll_step(|_| {
                failed_deliveries += 1;
                false
            })
            .expect("abandon CLOSED before attempting DONE delivery"),
            EventPollOutcome::Blocked { seq: 2, .. }
        ));
        assert_eq!(
            unsafe { (*region).evt_ack_seq.read() },
            1,
            "timeout DONE must release an undeliverable CLOSED head"
        );
        assert_eq!(
            failed_deliveries, 4,
            "only DONE delivery, not the abandoned safepoint, remains attempted"
        );

        assert_eq!(
            pump.poll_step(|notification| {
                assert_eq!(
                    notification,
                    UiPumpNotification::CloseDone {
                        completion: UiCloseCompletion::TimedOutWithoutSave
                    }
                );
                true
            })
            .expect("drain timeout DONE after editor reconnects"),
            advanced(1)
        );
        assert_eq!(unsafe { (*region).evt_ack_seq.read() }, 2);
        pump.begin_open()
            .expect("completed abandon must not permanently block a later UI open");

        drop(mmap);
        let _ = std::fs::remove_file(shm);
    }

    /// abandon は `timeout-without-save` **だけ**が引き金であることを押さえる。
    ///
    /// child は ack が `UI_CLOSED` の seq に届いて初めて Phase B に入るので、Blocked の
    /// `UI_CLOSED` を飛び越えて `safepoint-completed` が来るのはハンドシェイク違反である。
    /// ここで abandon してしまうと、**engine が保存を確認していない safepoint を daemon が
    /// ack** し、音色を失ったままリングだけが正常に進む（UI は再オープンでき、失敗が
    /// どこにも現れない）。判別を落としたら red になることが、このテストの存在理由。
    #[test]
    fn ui_event_pump_does_not_abandon_on_a_non_timeout_done() {
        let shm = mailbox_test_path("ui-pump-abandon-negative");
        let mmap = create_shared(&shm).expect("create");
        let region = region_ptr(&mmap);
        let pump = UiEventPump::new(shm.clone());
        let mut child = EventRingChild::new();
        publish_ui_event(region, &mut child, EVT_UI_CLOSED, "");
        pump.poll_step(|_| true).expect("initial blocked poll");
        assert_eq!(unsafe { (*region).evt_ack_seq.read() }, 0);

        // ハンドシェイク違反: safepoint 未 ack のまま「保存できた」DONE が来る。
        publish_ui_event(
            region,
            &mut child,
            EVT_UI_CLOSED_DONE,
            "safepoint-completed",
        );
        let mut notifications = Vec::new();
        assert!(
            matches!(
                pump.poll_step(|event| {
                    notifications.push(event);
                    true
                })
                .expect("poll stays blocked"),
                EventPollOutcome::Blocked { seq: 1, .. }
            ),
            "non-timeout DONE must not release the blocked safepoint"
        );
        assert_eq!(
            unsafe { (*region).evt_ack_seq.read() },
            0,
            "ack must not advance without an engine AckUiSafepoint"
        );
        assert!(
            notifications.is_empty(),
            "the safepoint was already announced; no further notification is due"
        );

        // engine が本来の ack を出せば、そこで初めて進む。
        pump.ack_safepoint(0, 1)
            .expect("engine ack advances the head");
        assert_eq!(unsafe { (*region).evt_ack_seq.read() }, 1);

        drop(mmap);
        let _ = std::fs::remove_file(shm);
    }

    #[test]
    fn ui_event_pump_final_drain_fails_blocked_safepoint_before_teardown() {
        let shm = mailbox_test_path("ui-pump-final-drain");
        let mmap = create_shared(&shm).expect("create");
        let region = region_ptr(&mmap);
        let pump = UiEventPump::new(shm.clone());
        let mut child = EventRingChild::new();
        publish_ui_event(region, &mut child, EVT_UI_CLOSED, "");

        let mut notifications = Vec::new();
        assert!(matches!(
            pump.poll_step(|event| {
                notifications.push(event);
                true
            })
            .expect("initial blocked poll"),
            EventPollOutcome::Blocked { seq: 1, .. }
        ));
        assert_eq!(unsafe { (*region).evt_ack_seq.read() }, 0);

        assert_eq!(
            pump.final_drain(|event| {
                notifications.push(event);
                true
            })
            .expect("teardown drain"),
            advanced(1)
        );
        assert_eq!(
            unsafe { (*region).evt_ack_seq.read() },
            1,
            "teardown must not leave the blocked ring head behind"
        );
        assert_eq!(
            notifications,
            vec![UiPumpNotification::Safepoint {
                generation: 0,
                evt_seq: 1
            }],
            "the already-notified safepoint must not be delivered twice during drain"
        );
        pump.begin_open()
            .expect("final drain returns lifecycle to Closed");
        pump.finish_open(false).expect("release test reservation");

        drop(mmap);
        let _ = std::fs::remove_file(shm);
    }

    // 存在しないファイルは map せず Err(open は read-only open なので作成しない)。
    #[test]
    fn open_shared_rejects_missing_file() {
        let p = std::env::temp_dir().join(format!("orbit-sbx-missing-{}.shm", std::process::id()));
        let _ = std::fs::remove_file(&p);
        assert!(open_shared(&p).is_err(), "存在しないファイルは Err");
    }

    // REGION_BYTES 未満の stale/破損ファイルは生ポインタ deref 前に弾く(silently map しない)。
    #[test]
    fn open_shared_rejects_too_small_file() {
        use std::io::Write;
        let p = std::env::temp_dir().join(format!("orbit-sbx-small-{}.shm", std::process::id()));
        {
            let mut f = std::fs::File::create(&p).expect("create");
            f.write_all(&[0u8; 16]).expect("write"); // REGION_BYTES より遥かに小さい
        }
        let r = open_shared(&p);
        let _ = std::fs::remove_file(&p);
        let err = r.expect_err("REGION_BYTES 未満は弾く");
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    }
}
