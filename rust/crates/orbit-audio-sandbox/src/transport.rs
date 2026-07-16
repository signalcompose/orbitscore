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

use std::fs::OpenOptions;
use std::io;
use std::path::Path;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};

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
    fn reset_control_run_rearms_region_after_attach_teardown() {
        let path = std::env::temp_dir().join(format!(
            "orbit-sbx-reset-control-{}.shm",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        let mmap = create_shared(&path).expect("create");
        let region = region_ptr(&mmap);
        // SAFETY: region points into the live mapping created above.
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
