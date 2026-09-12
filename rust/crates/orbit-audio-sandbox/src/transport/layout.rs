//! 共有メモリのレイアウト（フレーム定数・slot 割り当て・`SharedRegion` とコマンド/イベント種別）（#888 子 3・orbit-audio-sandbox）。
//!
//! 🔴 **これは純粋な移動である。** 本文は 1 行も書き換えていない（可視性を
//! `pub(super)` へ上げたものを除く — 分割前は同一モジュール内だったため）。

#[allow(unused_imports)]
use super::*;

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
/// child が load に失敗して終了する直前に立てる状態。
///
/// 🔴 **write 箇所はある**（#760 で注釈を実装へ合わせ直した・2026-09-06）。rack child の
/// `RackController::load_initial`（`orbit-effect-rack-child/src/lib.rs`）が、失敗の詳細を
/// `cmd_result_detail` へ publish した**後で**この値を store する。daemon（`engine_wrap.rs` の
/// Root 3-3）はこの status を early-exit の watchdog signal **より先に**見るので、「child が
/// 死んだ」ではなく「index n の load がこう失敗した」という具体的な理由が上がる。
/// PR-1c (#441) の watchdog は、この status を立てずに死ぬ child（load 以外の理由での早期終了）を
/// timeout を待たずに拾う経路として残る。
///
/// **respawn 注意**: shm は daemon 起動時に一度だけ truncate され、respawn（`EffectChildSupervisor`/
/// `InstrumentChildSupervisor` の watchdog による再起動）は同一 shm を再利用する（再 truncate しない）
/// ため、一度 READY に達した後の respawn 失敗では `child_status` は STARTING でなく前 incarnation の
/// READY が残留する。PR-1b（#440）は spawn 直前の `reset_child_starting` による STARTING リセット
/// のみを実装し、この前 incarnation の READY 残留誤認を解消した。
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
    /// child -> host: rack child が現在処理している stage の 0 始まり index。
    ///
    /// 既存 field の offset を維持するため、SharedRegion の末尾にだけ追加する。
    pub active_stage_index: AtomicU32,
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
/// コマンド種別: 構築済み effect chain を block 境界で適用する（#628）。
pub const CMD_APPLY_CHAIN: u32 = 4;
/// コマンド種別: 指定 stage の plugin state を保存する（#628）。
pub const CMD_SAVE_STATE_AT: u32 = 5;
/// コマンド種別: 指定 stage の plugin UI を開く（#628）。
pub const CMD_OPEN_UI_AT: u32 = 6;
/// コマンド種別: 指定 stage の plugin UI を閉じる（#628）。
pub const CMD_CLOSE_UI_AT: u32 = 7;

/// イベント種別: 未発行（`evt_seq == 0` と対）。
pub const EVT_NONE: u32 = 0;
/// イベント種別: plugin 起点の UI close が始まった。
pub const EVT_UI_CLOSED: u32 = 1;
/// イベント種別: UI close 手続きが完了した。
pub const EVT_UI_CLOSED_DONE: u32 = 2;
