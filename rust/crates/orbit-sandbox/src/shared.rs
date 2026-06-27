//! γ sandbox 親子共有メモリレイアウト — orbit-sandbox 本番版 (Issue #354)
//!
//! file-backed mmap(MAP_SHARED) を親子双方が map し、同一物理ページを共有する。
//! 同期は [`SharedRegion`] 内の atomic（`seq_request` / `seq_done`）による SPSC ハンドシェイク:
//!
//! 1. host: n_frames と input[slot] を書く → `seq_request` を **Release** で publish
//! 2. child: `seq_request` を **Acquire** で読む → n_frames/input が可視 → output[slot] を書く
//!    → `seq_done = seq_request` を **Release** で store → `child_heartbeat` を +1 (Relaxed)
//! 3. host: `seq_done` を **Acquire** で読む → output[slot] が可視 → 出力にコピー
//!
//! ## spike からの変更点
//!
//! | spike (orbit-sandbox-spike) | 本番 (orbit-sandbox) |
//! |---|---|
//! | SLOTS = 2 (ping-pong) | **SLOTS = 3** (3-outstanding, 32f stall 排除) |
//! | `gain_bits`, `rt_active` | 削除 (spike 専用フィールド) |
//! | `child_processed` (観測のみ) | **`child_heartbeat`** に改名 (watchdog 用) |
//! | `slot_offset(seq) = (seq & 1) * BUF_LEN` | `(seq as usize % SLOTS) * BUF_LEN` |
//!
//! ## 不変条件 (pipelined / 3-outstanding)
//!
//! host は新 seq s を submit する前に `seq_done >= s - SLOTS`（s の slot の前 occupant = s-3 の完了）
//! を確認する（`SandboxHostTransport` の stall guard）。この条件が保たれる限り、host の
//! `input[slot_offset(s)]` への書き込みと child の `input[slot_offset(s-SLOTS)]` からの読み取りは
//! 時間的に排他化され、生ポインタ経由の `&mut [f32]` 形成は健全。
//!
//! seq_done が Release で store された後に Acquire で観測した host/child は、その seq に対応する
//! output/input の書き込みを全て可視化できる（C++ memory_order に対応する Rust ordering）。

use std::fs::OpenOptions;
use std::io;
use std::path::Path;
use std::sync::atomic::{AtomicU32, AtomicU64};

use memmap2::MmapMut;

/// 1 ブロックの最大フレーム数。
pub const MAX_FRAMES: usize = 4096;
/// チャンネル数（stereo 固定）。
pub const CHANNELS: usize = 2;
/// 1 slot のインターリーブ済みバッファ長（フレーム × チャンネル）。
pub const BUF_LEN: usize = MAX_FRAMES * CHANNELS;
/// ping-pong slot 数。3 = 3-outstanding で 32f 時の stall を排除する。
/// spike の 2-slot では 32f で 9–13 stall (@#350 verdict §6)。
pub const SLOTS: usize = 3;

/// seq に対応する slot の開始要素オフセット。
/// SLOTS=3 に対応するため `% SLOTS` を使用（spike の `& 1` から変更）。
#[inline]
pub fn slot_offset(seq: u64) -> usize {
    (seq as usize % SLOTS) * BUF_LEN
}

/// 親子で共有する制御ブロック + audio バッファ。
///
/// `#[repr(C)]` でフィールド順を固定し、`align(64)` で先頭をキャッシュライン境界に置く。
/// ヘッダ部を明示的に 64 バイトに揃え、`input` が offset 64 から始まることを保証する。
///
/// フィールドレイアウト（全 offset は repr(C) + 明示 padding で確定）:
/// ```text
/// offset  0: seq_request   (8)
/// offset  8: seq_done      (8)
/// offset 16: n_frames      (4)
/// offset 20: _pad0         (4)
/// offset 24: child_heartbeat (8)
/// offset 32: _pad1         (32)
/// offset 64: input         (BUF_LEN * SLOTS * 4)
/// offset 64 + BUF_LEN*SLOTS*4: output (same size)
/// ```
#[repr(C, align(64))]
pub struct SharedRegion {
    /// host が input 書き込み後に +1 する (Release)。child はこれが進むのを待つ (Acquire)。
    pub seq_request: AtomicU64,
    /// child が処理済の request seq を store する (Release)。host は `>= req` を確認 (Acquire)。
    pub seq_done: AtomicU64,
    /// 現ブロックのフレーム数（<= MAX_FRAMES）。seq_request の Release より前に書くため可視。
    pub n_frames: AtomicU32,
    _pad0: [u8; 4],
    /// child が block 処理後に Relaxed でインクリメントするハートビート（watchdog 用）。
    /// host は `seq_done` で audio flow を制御し、このカウンタで child liveness を監視する。
    pub child_heartbeat: AtomicU64,
    _pad1: [u8; 32],
    /// host → child のインターリーブ入力。slot s = `[slot_offset(s)..slot_offset(s)+n_frames*CHANNELS]`。
    pub input: [f32; BUF_LEN * SLOTS],
    /// child → host のインターリーブ出力。インデックスは input と同じ。
    pub output: [f32; BUF_LEN * SLOTS],
}

/// 共有領域のバイトサイズ（mmap ファイルサイズ）。
pub const REGION_BYTES: usize = std::mem::size_of::<SharedRegion>();

/// 共有メモリファイルを作成して map する（host 側）。
///
/// ファイルを `REGION_BYTES` に truncate する → 全 atomic / バッファは 0 初期化される
/// （`seq_request = seq_done = 0` は有効な初期状態）。
///
/// # Safety
/// 返した `MmapMut` が生存する限りのみ [`region_ptr`] のポインタは有効。
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

/// 既存の共有メモリファイルを map する（child 側）。
///
/// # Safety
/// 返した `MmapMut` が生存する限りのみ [`region_ptr`] のポインタは有効。
pub fn open_shared(path: &Path) -> io::Result<MmapMut> {
    let file = OpenOptions::new().read(true).write(true).open(path)?;
    // SAFETY: host が REGION_BYTES に truncate 済みの同一ファイルを map する。
    unsafe { MmapMut::map_mut(&file) }
}

/// mmap のベースを [`SharedRegion`] ポインタにキャストする。
///
/// # Safety
/// `mmap` は [`create_shared`] / [`open_shared`] が返したもの（サイズ >= `REGION_BYTES`・
/// ページ境界整列）でなければならない。返したポインタは `mmap` の生存期間を超えて使ってはならない。
pub fn region_ptr(mmap: &MmapMut) -> *mut SharedRegion {
    mmap.as_ptr() as *mut SharedRegion
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn region_size_and_align() {
        // input + output の合計を収められるサイズ。
        assert!(REGION_BYTES >= 2 * SLOTS * BUF_LEN * std::mem::size_of::<f32>());
        assert_eq!(std::mem::align_of::<SharedRegion>(), 64);
        assert_eq!(BUF_LEN, MAX_FRAMES * CHANNELS);
    }

    #[test]
    fn header_is_64_bytes() {
        // ヘッダが 64 バイト = input が cacheline 境界から始まることを確認。
        // repr(C) + 明示 padding で保証。
        let offset_of_input = std::mem::offset_of!(SharedRegion, input);
        assert_eq!(offset_of_input, 64, "input must start at offset 64 (cacheline-aligned)");
    }

    #[test]
    fn slot_offset_cycles_through_three_slots() {
        // SLOTS=3: 0 → BUF_LEN → 2*BUF_LEN → 0 と巡回。
        assert_eq!(slot_offset(0), 0);
        assert_eq!(slot_offset(1), BUF_LEN);
        assert_eq!(slot_offset(2), BUF_LEN * 2);
        assert_eq!(slot_offset(3), 0); // 巡回
        assert_eq!(slot_offset(4), BUF_LEN);
        assert_eq!(slot_offset(5), BUF_LEN * 2);
    }

    #[test]
    fn consecutive_seqs_use_distinct_slots() {
        // pipelined の前提: seq s と s+1、s+2 は全て別 slot（3-outstanding 安全）。
        for s in 0..9u64 {
            let a = slot_offset(s);
            let b = slot_offset(s + 1);
            let c = slot_offset(s + 2);
            assert_ne!(a, b, "seq {s} and {}: same slot!", s + 1);
            assert_ne!(a, c, "seq {s} and {}: same slot!", s + 2);
            assert_ne!(b, c, "seq {} and {}: same slot!", s + 1, s + 2);
            // s と s+SLOTS は同じ slot（slot 再利用サイクル）。
            assert_eq!(a, slot_offset(s + SLOTS as u64), "seq {s} and {} must share a slot", s + SLOTS);
        }
    }
}
