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
use std::sync::atomic::{AtomicU32, AtomicU64};

use memmap2::MmapMut;

/// 1 ブロックの最大フレーム数(cpal buffer の上限。これを超える callback は clamp する)。
pub const MAX_FRAMES: usize = 4096;
/// チャンネル数(stereo 固定)。
pub const CHANNELS: usize = 2;
/// 1 slot(= 1 ブロック)のインターリーブ済みバッファ長(フレーム × チャンネル)。
pub const BUF_LEN: usize = MAX_FRAMES * CHANNELS;
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

#[cfg(test)]
mod tests {
    use super::*;

    // クロスプロセスで共有する以上、レイアウトが壊れると親子で別物を読む。サイズ/整列の回帰を捕捉。
    #[test]
    fn region_size_and_align() {
        // mmap ファイルサイズは input/output 各 SLOTS 本ぶん(計 2*SLOTS ブロック)を下回らない。
        assert!(REGION_BYTES >= 2 * SLOTS * BUF_LEN * std::mem::size_of::<f32>());
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
