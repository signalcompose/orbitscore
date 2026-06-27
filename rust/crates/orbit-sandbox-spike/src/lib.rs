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

// ---- candidate A: child RT スレッド優先度（mach time-constraint）-----------------------------
//
// Step0 spike は同期 round-trip の worst-case tail（~2〜4ms・buffer 非依存）が scheduling jitter
// 由来だと突き止めた。child の spin スレッドは通常優先度なのでプリエンプトされうる。candidate A は
// child を mach `THREAD_TIME_CONSTRAINT_POLICY`（macOS の RT スケジューリング）に上げ、その tail が
// 縮むか測る（#350）。host callback は既に CoreAudio の RT スレッド上なので host 側は変えない。

/// ns を mach absolute-time 単位へ変換する（`abs = ns * denom / numer`）。`u32` で飽和。
///
/// `mach_timebase_info` の `numer`/`denom` は「1 abs tick = numer/denom ns」を表す
/// （Apple Silicon は 125/3 ≈ 41.67ns/tick、Intel は 1/1）。time-constraint policy の各フィールドは
/// abs tick 単位なので ns を変換して渡す。`numer == 0`（timebase 取得失敗）は 0 を返す。
pub fn ns_to_mach_abs(ns: u64, numer: u32, denom: u32) -> u32 {
    if numer == 0 {
        return 0;
    }
    let abs = ns as u128 * denom as u128 / numer as u128;
    abs.min(u32::MAX as u128) as u32
}

/// 呼び出しスレッドを RT（time-constraint）スケジューリングに上げる（macOS）。
///
/// `period_ns` = 仕事が届く周期（= block period）、`computation_ns` = 周期内の想定計算時間、
/// `constraint_ns` = 計算を終えるべき期限（>= computation）。spike 用なので失敗は呼び出し側で
/// ログするだけ（通常優先度のまま継続し、計測は RT 無効として読める）。
///
/// 注意（verdict に明記する前提）: 連続 spin するスレッドに time-constraint を付けても、macOS は
/// computation 予算を超過し続けるスレッドを demote しうる。production の隔離プロセスは spin ではなく
/// block/wake で待つべきで、本 spike の数値は「RT tail の floor」を測るものであり production 値ではない。
#[cfg(target_os = "macos")]
pub fn set_realtime_thread(
    period_ns: u64,
    computation_ns: u64,
    constraint_ns: u64,
) -> io::Result<()> {
    use mach2::kern_return::KERN_SUCCESS;
    use mach2::mach_init::mach_thread_self;
    use mach2::mach_time::{mach_timebase_info, mach_timebase_info_data_t};
    use mach2::thread_policy::{
        thread_policy_set, thread_time_constraint_policy_data_t, THREAD_TIME_CONSTRAINT_POLICY,
        THREAD_TIME_CONSTRAINT_POLICY_COUNT,
    };

    let mut tb = mach_timebase_info_data_t { numer: 0, denom: 0 };
    // SAFETY: timebase 比率（numer/denom）を tb に書き込む mach 呼び出し。
    unsafe {
        mach_timebase_info(&mut tb);
    }

    let mut policy = thread_time_constraint_policy_data_t {
        period: ns_to_mach_abs(period_ns, tb.numer, tb.denom),
        computation: ns_to_mach_abs(computation_ns, tb.numer, tb.denom),
        constraint: ns_to_mach_abs(constraint_ns, tb.numer, tb.denom),
        // 0 = 計算中はプリエンプトされにくい（tail floor を測る意図）。
        preemptible: 0,
    };

    // SAFETY: mach_thread_self() は呼び出しスレッドの send right を返す（プロセス生存中の leak は許容）。
    // policy を THREAD_TIME_CONSTRAINT_POLICY_COUNT 個の integer_t としてレイアウト一致で渡す。
    let kr = unsafe {
        thread_policy_set(
            mach_thread_self(),
            THREAD_TIME_CONSTRAINT_POLICY,
            (&mut policy as *mut thread_time_constraint_policy_data_t).cast(),
            THREAD_TIME_CONSTRAINT_POLICY_COUNT,
        )
    };
    if kr == KERN_SUCCESS {
        Ok(())
    } else {
        Err(io::Error::other(format!(
            "thread_policy_set(TIME_CONSTRAINT) failed: kr={kr}"
        )))
    }
}

/// 非 macOS フォールバック（本 spike は macOS 専用だが workspace は ubuntu CI でもビルドされる）。
#[cfg(not(target_os = "macos"))]
pub fn set_realtime_thread(
    _period_ns: u64,
    _computation_ns: u64,
    _constraint_ns: u64,
) -> io::Result<()> {
    Err(io::Error::other(
        "RT thread policy is only implemented on macOS",
    ))
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

    // ns → mach abs 単位の変換（abs = ns * denom / numer）。timebase 比に応じた値と境界を確認。
    #[test]
    fn ns_to_mach_abs_converts_by_timebase() {
        // Intel timebase（1 tick = 1 ns）: 変換は恒等。
        assert_eq!(ns_to_mach_abs(1_000, 1, 1), 1_000);
        // Apple Silicon timebase（1 tick = 125/3 ns ≈ 41.67ns）: ns→tick は ns*3/125。
        assert_eq!(ns_to_mach_abs(1_000, 125, 3), 1_000 * 3 / 125); // = 24
                                                                    // timebase 取得失敗（numer == 0）は 0 を返す（0 除算を避ける）。
        assert_eq!(ns_to_mach_abs(1_000, 0, 3), 0);
        // u32 飽和（巨大 ns でも overflow しない）。
        assert_eq!(ns_to_mach_abs(u64::MAX, 1, 1), u32::MAX);
    }
}
