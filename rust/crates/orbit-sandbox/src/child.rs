//! child 側 sandbox transport — orbit-sandbox (Issue #354)
//!
//! [`SandboxChildTransport`] は隔離プロセス（child）の audio processing loop を提供する。
//! host から seq_request が届くのを spin-wait で待ち、input を処理コールバックに渡し、
//! output を共有領域に書いて seq_done を publish する。
//!
//! ## CLAP 統合の位置づけ（次フェーズ）
//! 現時点ではコールバック内の処理内容は呼び出し元（child binary）が決める。
//! Phase 2 では `orbit-clap-host` を child binary に統合し、コールバック内で
//! CLAP プラグインを in-process で動かす（daemon 内の clack-host と対称）。
//!
//! ## RT 安全性
//! `process_next` は spin-wait を含む（macOS に futex が無いため）。
//! spin_loop hint はプロセッサの pause 命令を発行し、HT スレッドへの譲歩と
//! メモリ ordering の観測頻度のバランスをとる。

use std::sync::atomic::Ordering;

use crate::shared::{SharedRegion, CHANNELS, MAX_FRAMES, slot_offset};

/// child 側 sandbox transport。
///
/// 隔離プロセスの single audio thread から呼ぶ。
pub struct SandboxChildTransport {
    region: *mut SharedRegion,
    /// 直前に処理した seq（初期値 = mmap 開始時の seq_done = 0）。
    last_seq: u64,
}

// SAFETY: child binary は単一スレッドで process_next を呼ぶ前提。
// SharedRegion はクロスプロセス共有だが Rust レベルの data race は SandboxHostTransport と
// このトランスポートの間で排他化されている（stall guard + Acquire/Release ordering）。
unsafe impl Send for SandboxChildTransport {}

impl SandboxChildTransport {
    /// 共有領域ポインタから transport を作成する。
    ///
    /// # Safety
    /// `region` は `open_shared` + `region_ptr` で得た有効なポインタ。
    /// このオブジェクトが生存する間、mmap は drop してはならない。
    pub unsafe fn new(region: *mut SharedRegion) -> Self {
        let last_seq = (*region).seq_done.load(Ordering::Relaxed);
        Self { region, last_seq }
    }

    /// 次の block が host から届くまで spin-wait し、`process` コールバックを呼んで output を publish する。
    ///
    /// `process(n_frames, input, output)`:
    /// - `n_frames`: 処理フレーム数（<= MAX_FRAMES）
    /// - `input`: host から送られた audio（n_frames × CHANNELS 要素・読み取り専用）
    /// - `output`: 処理結果を書き込む先（n_frames × CHANNELS 要素）
    ///
    /// # Safety
    /// - single child thread から順次呼ぶこと（再入不可）
    /// - region は有効であること
    /// - `process` が panic すると seq_done が publish されず host が stall する点に注意
    pub unsafe fn process_next<F>(&mut self, process: F)
    where
        F: FnOnce(usize, &[f32], &mut [f32]),
    {
        let r = &*self.region;

        // host が seq_request を Release で publish するのを Acquire で待つ。
        let seq = loop {
            let s = r.seq_request.load(Ordering::Acquire);
            if s > self.last_seq {
                break s;
            }
            std::hint::spin_loop();
        };

        // seq_request の Acquire 後: n_frames と input[slot_offset(seq)] が可視。
        let n = (r.n_frames.load(Ordering::Relaxed) as usize).min(MAX_FRAMES);
        let count = n * CHANNELS;
        let off = slot_offset(seq);

        // SAFETY: input と output は SharedRegion の別フィールド（aliasing なし）。
        // stall guard（SandboxHostTransport 側）が input[off] を保護しているため、
        // child が読み終わる（seq_done = seq を publish）前に host が上書きしない。
        let region_mut = &mut *self.region;
        let input = core::slice::from_raw_parts(region_mut.input.as_ptr().add(off), count);
        let output = core::slice::from_raw_parts_mut(region_mut.output.as_mut_ptr().add(off), count);

        process(n, input, output);

        // heartbeat を先に Relaxed で更新し、その後 seq_done を Release で publish。
        // host は seq_done の Acquire 観測で output 書き込みの可視性を得る。
        region_mut.child_heartbeat.fetch_add(1, Ordering::Relaxed);
        region_mut.seq_done.store(seq, Ordering::Release);
        self.last_seq = seq;
    }

    /// 最後に完了した seq（監視・ログ用）。
    pub fn last_seq(&self) -> u64 {
        self.last_seq
    }
}
