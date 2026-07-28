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

use std::fmt;
use std::fs::OpenOptions;
use std::io;
use std::path::Path;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use memmap2::MmapMut;

use crate::events::EventRecord;

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

/// seq に対応する slot のインデックス(`0..SLOTS`)。per-slot メタデータ配列(`seq_tag` /
/// `n_frames`)の添字に使う。`slot_offset` はこれを [`BUF_LEN`] 倍したバッファ要素オフセット。
#[inline]
pub fn slot_index(seq: u64) -> usize {
    seq as usize % SLOTS
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
    // `cmd_arg` にパスを書き、child がそのファイルへ書く（UIH.3 サイドカー方式）。
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
}

/// `cmd_arg` のバイト長。サイドカーファイルの絶対パスを収める（macOS の PATH_MAX = 1024）。
pub const CMD_ARG_BYTES: usize = 1024;
/// `cmd_result_detail` のバイト長。
pub const CMD_DETAIL_BYTES: usize = 256;

/// コマンド種別: 未発行（`cmd_seq == 0` と対）。
pub const CMD_NONE: u32 = 0;
/// コマンド種別: 現在の plugin state を `cmd_arg` のパスへ書き出す（#555）。
pub const CMD_SAVE_STATE: u32 = 1;

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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandMailboxResponse {
    pub bytes_written: u64,
}

#[derive(Debug)]
pub enum CommandMailboxError {
    Mapping(io::Error),
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
            Self::Mapping(error) => Some(error),
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
    sidecar_path: std::path::PathBuf,
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
                remove_abandoned_sidecar(&in_flight.sidecar_path)?;
                state.in_flight = None;
            }

            let previous = unsafe { (*region).cmd_seq.load(Ordering::Relaxed) };
            let seq = previous
                .checked_add(1)
                .ok_or(CommandMailboxError::SequenceExhausted)?;
            unsafe {
                if !write_cstr_field(&mut (*region).cmd_arg, sidecar) {
                    return Err(CommandMailboxError::InvalidArgument(format!(
                        "path must contain no NUL and fit in CMD_ARG_BYTES={CMD_ARG_BYTES}"
                    )));
                }
                let _ = write_cstr_field(&mut (*region).cmd_result_detail, "");
                (*region).cmd_result_len.store(0, Ordering::Relaxed);
                (*region).cmd_result.store(CMD_RESULT_OK, Ordering::Relaxed);
                (*region).cmd_kind.store(CMD_SAVE_STATE, Ordering::Relaxed);
                // Release publish: child は cmd_seq Acquire 後に kind/arg を読む。
                (*region).cmd_seq.store(seq, Ordering::Release);
            }
            let generation = state.generation;
            state.in_flight = Some(InFlightCommand {
                seq,
                generation,
                abandoned: false,
                sidecar_path: sidecar_path.to_path_buf(),
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
                    CMD_RESULT_OK => Ok(CommandMailboxResponse { bytes_written }),
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
        // SAFETY: mmap は生存し、旧 child の死亡確認後なので child と reset writer は競合しない。
        unsafe { reset_child_starting(region) };
        state.generation = state.generation.wrapping_add(1);
        if let Some(in_flight) = state.in_flight.as_ref() {
            remove_abandoned_sidecar(&in_flight.sidecar_path)?;
        }
        state.in_flight = None;
        Ok(())
    }
}

fn remove_abandoned_sidecar(path: &Path) -> Result<(), CommandMailboxError> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(CommandMailboxError::Mapping(error)),
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
    /// 失敗理由。成功時は空。
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
/// `region` は呼び出し元が map 済みの生存 SharedRegion を指していること。
pub unsafe fn reset_child_starting(region: *mut SharedRegion) {
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
        assert_eq!(
            host.issue_save_state_with_timeout(
                Path::new("/tmp/orbit-mailbox-after-late-ack.bin"),
                Duration::from_millis(250)
            )
            .expect("late exact ack releases the poisoned slot")
            .bytes_written,
            11
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
