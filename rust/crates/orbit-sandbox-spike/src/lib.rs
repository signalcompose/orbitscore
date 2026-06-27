//! γ sandbox feasibility spike — 親(host)/子(child) が共有する shared-memory レイアウト。
//!
//! file-backed mmap(MAP_SHARED) を親子双方が map し、同一物理ページを共有する。
//! 同期は [`SharedRegion`] 内の atomic（`seq_request` / `seq_done`）による SPSC ハンドシェイク:
//!
//! 1. host: `n_frames` と `input` を書く → `seq_request` を **Release** で +1 して publish
//!    （`n_frames` は Relaxed だが Release 前に書かれるので child の Acquire で可視）。
//! 2. child: `seq_request` を **Acquire** で読む（> 前回なら）→ n_frames/input が可視 → `output`
//!    を書く → `seq_done = seq_request` を **Release** で store。
//! 3. host: `seq_done` を **Acquire** で読む（>= 自分の req なら）→ output が可視 → 出力にコピー。
//!
//! **1-outstanding request 不変条件**: host は前 req が完了（`seq_done >= req`）したことを確認して
//! からのみ次の `input` を上書きする（host 側の callback でこれを enforce）。よって child が前 req の
//! `input` を読んでいる間に host が `input` を上書きすることは無く、`output` は seq_done の Release/
//! Acquire で覆われる。この不変条件のもとでバッファアクセスは時間的に排他化され、生ポインタ経由の
//! `&mut [f32]` 形成も健全（この不変条件が破れると live-but-slow child との間でデータ競合 = UB になる）。
//! macOS に futex は無いが、RT 側は **bounded spin**（timeout 付き）で待つため別プロセスを
//! 無制限にブロックしない（`ClapTeardownGuard` の busy-wait-with-deadline と同型）。

// 共有メモリは生ポインタ経由でクロスプロセス参照するため unsafe FFI 同等。
#![allow(unsafe_code)]

use std::fs::OpenOptions;
use std::io;
use std::path::Path;
use std::sync::atomic::{AtomicU32, AtomicU64};

use memmap2::MmapMut;

/// 1 ブロックの最大フレーム数（cpal buffer の上限。これを超える callback は clamp する）。
pub const MAX_FRAMES: usize = 4096;
/// チャンネル数（stereo 固定）。
pub const CHANNELS: usize = 2;
/// インターリーブ済みバッファ長（フレーム × チャンネル）。
pub const BUF_LEN: usize = MAX_FRAMES * CHANNELS;

/// 親子で共有する制御ブロック + audio バッファ。
///
/// `#[repr(C)]` でフィールド順を固定し、`align(64)` でキャッシュライン境界に載せる。
/// 親子は同一 crate でコンパイルされるが、レイアウト不変性を明示するため repr(C) を付ける。
/// mmap のベースはページ境界（>= 4096）なので 64-byte align は常に満たされる。
///
/// atomic フィールドはクロスプロセスで可視（MAP_SHARED）。`input` / `output` は生 f32 配列で、
/// 可視性順序は `seq_request` / `seq_done` の Acquire/Release が与える（モジュール doc 参照）。
#[repr(C, align(64))]
pub struct SharedRegion {
    /// host が input 書き込み後に +1 する。child はこれが前回値より進むのを待つ。
    pub seq_request: AtomicU64,
    /// child が処理し終えた request seq を store する。host は `seq_done >= req` を待つ。
    pub seq_done: AtomicU64,
    /// 現ブロックのフレーム数（<= MAX_FRAMES）。
    pub n_frames: AtomicU32,
    /// child が掛ける gain（f32 の bit 表現）。host が起動時に設定する。
    pub gain_bits: AtomicU32,
    /// child が処理したブロック総数（観測用。recovery の進行を可視化）。
    pub child_processed: AtomicU64,
    /// host -> child のインターリーブ入力。
    pub input: [f32; BUF_LEN],
    /// child -> host のインターリーブ出力。
    pub output: [f32; BUF_LEN],
}

/// 共有領域のバイトサイズ（mmap ファイルサイズ）。
pub const REGION_BYTES: usize = std::mem::size_of::<SharedRegion>();

/// 共有メモリファイルを作成して map する（host 側）。ファイルを `REGION_BYTES` に truncate
/// するので全 atomic / バッファは 0 初期化される（`seq_request = seq_done = 0` は有効な初期状態）。
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

    // クロスプロセスで共有する以上、レイアウトが壊れると親子で別物を読む。サイズ/整列の回帰を捕捉。
    #[test]
    fn region_size_and_align() {
        // mmap ファイルサイズはバッファ 2 本ぶんを下回らない。
        assert!(REGION_BYTES >= 2 * BUF_LEN * std::mem::size_of::<f32>());
        // align(64) 指定どおり。mmap のページ整列で満たされる前提の値。
        assert_eq!(std::mem::align_of::<SharedRegion>(), 64);
        // BUF_LEN = フレーム × チャンネル。
        assert_eq!(BUF_LEN, MAX_FRAMES * CHANNELS);
    }
}
