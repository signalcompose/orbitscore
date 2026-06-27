//! host 側 pipelined transport — orbit-sandbox (Issue #354)
//!
//! [`SandboxHostTransport`] は候補 B（one-block-pipelined）の本番実装。
//! RT audio callback から 1 回/block 呼ばれ:
//! 1. **出力ステップ**: 前回 submit した seq の child 処理結果を読む。
//!    - child が間に合った (seq_done >= req): fresh output → `output` にコピー + `repeat_buf` 更新。
//!    - child が遅れた (stale): `repeat_buf`（直前 valid ブロック）を `output` にコピー。click 回避。
//!    - 初回（priming）: silence。
//! 2. **submit ステップ**: 新 seq の input を child に送る。
//!    - stall guard: seq_done >= new_seq - SLOTS を確認してから slot に書く（slot 衝突防止）。
//!    - guard 未達: stall（提出見送り、req 据え置き）。
//!
//! ## RT 安全性
//! `process_block` はアロケーションしない。`Vec` は `new()` 時に一度だけ確保し、
//! RT callback では事前確保済みのバッファをコピーするのみ。

use std::sync::atomic::Ordering;

use crate::shared::{SharedRegion, CHANNELS, MAX_FRAMES, SLOTS, slot_offset};

/// `process_block` の出力ステップの結果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputKind {
    /// child がリアルタイムで処理済み。出力は最新。
    Fresh,
    /// child が期限内に処理できず、直前 block の出力を繰り返した。
    Stale,
    /// まだ submit がなく、silence を出力した（初回 callback のみ）。
    Priming,
}

/// `process_block` の submit ステップの結果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubmitKind {
    /// 新 block を child に submit した。
    Submitted,
    /// child が遅延中で slot が再利用不可。submit を見送った（req 据え置き）。
    Stall,
}

/// 1 回の `process_block` 呼び出しの結果。
#[derive(Debug, Clone, Copy)]
pub struct BlockStatus {
    pub output: OutputKind,
    pub submit: SubmitKind,
}

/// host 側 pipelined sandbox transport（RT callback から使用）。
///
/// 固定 `n_frames` 前提。可変 buffer size は未対応（daemon は固定 buffer を想定）。
pub struct SandboxHostTransport {
    region: *mut SharedRegion,
    /// 直近に submit した seq。初期値 0 = "まだ submit していない"。
    req: u64,
    /// 最初の block を submit したか（priming 状態の追跡）。
    primed: bool,
    /// stale 時に繰り返す直前 valid 出力。`new()` で zero-init（初回 stale → silence）。
    /// n_frames * CHANNELS 長（RT callback ではアロケーションしない）。
    repeat_buf: Vec<f32>,
}

// SAFETY: RT audio callback は単一スレッドから呼ばれる。SandboxHostTransport は
// そのスレッドにのみ渡される。SharedRegion はクロスプロセス共有だが Rust レベルの
// data race は発生しない（host 側は唯一の writer）。
unsafe impl Send for SandboxHostTransport {}

impl SandboxHostTransport {
    /// 新しい transport を作成する。
    ///
    /// `n_frames` は全 callback で一定であること（可変 buffer は未対応）。
    ///
    /// # Safety
    /// `region` は `create_shared` + `region_ptr` で得た有効な SharedRegion ポインタ。
    /// このオブジェクトが生存する間、mmap は drop してはならない。
    pub unsafe fn new(region: *mut SharedRegion, n_frames: usize) -> Self {
        debug_assert!(!region.is_null());
        debug_assert!(n_frames <= MAX_FRAMES, "n_frames {n_frames} > MAX_FRAMES {MAX_FRAMES}");
        Self {
            region,
            req: 0,
            primed: false,
            repeat_buf: vec![0.0f32; n_frames * CHANNELS],
        }
    }

    /// RT audio callback から 1 回/block 呼ぶ。
    ///
    /// `input`:  engine-rendered audio（n_frames × CHANNELS 要素）
    /// `output`: child の処理結果で埋める（n_frames × CHANNELS 要素）
    ///
    /// # Safety
    /// `input.len() == output.len() == n_frames * CHANNELS`（`new()` 時に渡した値）。
    /// Region は有効。再入不可（single RT thread から呼ぶこと）。
    pub unsafe fn process_block(&mut self, input: &[f32], output: &mut [f32]) -> BlockStatus {
        let count = self.repeat_buf.len(); // n_frames * CHANNELS
        debug_assert_eq!(input.len(), count);
        debug_assert_eq!(output.len(), count);

        let r = &*self.region;
        let n_frames = count / CHANNELS;

        // ── 出力ステップ ──────────────────────────────────────────────────────
        let output_kind = if self.primed {
            let seq_done = r.seq_done.load(Ordering::Acquire);
            if seq_done >= self.req {
                // Fresh: seq_done >= req (Acquire) → child の output[slot_offset(req)] が可視。
                // child が次にこの slot に触るのは req+SLOTS 以降（host が未だ submit していない）。
                let off = slot_offset(self.req);
                let src = core::slice::from_raw_parts(r.output.as_ptr().add(off), count);
                output[..count].copy_from_slice(src);
                self.repeat_buf.copy_from_slice(src); // 次の stale に備えて保存
                OutputKind::Fresh
            } else {
                // Stale: child が期限内に処理できず → 直前 valid 出力を繰り返す（click 回避）。
                output[..count].copy_from_slice(&self.repeat_buf);
                OutputKind::Stale
            }
        } else {
            // Priming: 最初の submit 前。silence。
            output[..count].fill(0.0);
            OutputKind::Priming
        };

        // ── submit ステップ ───────────────────────────────────────────────────
        let new_seq = self.req + 1;
        let seq_done = r.seq_done.load(Ordering::Acquire);
        // stall guard: new_seq の slot の前 occupant（new_seq - SLOTS）が完了しているか確認。
        // 満たさない場合、child がその slot の output を書いている途中で host が input を
        // 上書きすると data race になる（input/output は別配列だが safety 保証として明示）。
        let slot_free = seq_done >= new_seq.saturating_sub(SLOTS as u64);
        let submit_kind = if slot_free {
            let off = slot_offset(new_seq);
            // SAFETY: slot_free → child は slot (new_seq % SLOTS) を保持していない。
            // host のみが input slot を書く。
            let dst = core::slice::from_raw_parts_mut(
                (*self.region).input.as_mut_ptr().add(off),
                count,
            );
            dst.copy_from_slice(&input[..count]);
            // n_frames は seq_request の Release より前に書くため child から可視。
            (*self.region).n_frames.store(n_frames as u32, Ordering::Relaxed);
            // Release publish: input[off] と n_frames が child から可視になる。
            (*self.region).seq_request.store(new_seq, Ordering::Release);
            self.req = new_seq;
            self.primed = true;
            SubmitKind::Submitted
        } else {
            // Stall: child が SLOTS ブロック以上遅延。req 据え置き（次 callback で再試行）。
            SubmitKind::Stall
        };

        BlockStatus {
            output: output_kind,
            submit: submit_kind,
        }
    }

    /// 直近の submit seq（監視・ログ用）。
    pub fn last_req(&self) -> u64 {
        self.req
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared::{create_shared, region_ptr, SLOTS};
    use std::sync::atomic::Ordering;

    const N: usize = 64; // テスト用フレーム数

    /// SharedRegion を一時ファイルで初期化し transport を作るヘルパ。
    fn make_transport(n_frames: usize) -> (SandboxHostTransport, memmap2::MmapMut, tempfile::TempPath) {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let path = tmp.into_temp_path();
        let mmap = create_shared(&path).unwrap();
        let ptr = region_ptr(&mmap);
        let transport = unsafe { SandboxHostTransport::new(ptr, n_frames) };
        (transport, mmap, path)
    }

    #[test]
    fn priming_delivers_silence() {
        let (mut t, _mmap, _tmp) = make_transport(N);
        let input = vec![1.0f32; N * CHANNELS];
        let mut output = vec![0.5f32; N * CHANNELS];
        let status = unsafe { t.process_block(&input, &mut output) };
        assert_eq!(status.output, OutputKind::Priming);
        assert!(output.iter().all(|&s| s == 0.0), "priming must deliver silence");
    }

    #[test]
    fn first_submit_increments_seq_request() {
        let (mut t, mmap, _tmp) = make_transport(N);
        let region = unsafe { &*region_ptr(&mmap) };
        let input = vec![0.5f32; N * CHANNELS];
        let mut output = vec![0.0f32; N * CHANNELS];
        let status = unsafe { t.process_block(&input, &mut output) };
        assert_eq!(status.submit, SubmitKind::Submitted);
        assert_eq!(region.seq_request.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn stall_when_child_too_far_behind() {
        // seq_done を 0 に留め、SLOTS 回 submit して次が stall することを確認。
        let (mut t, mmap, _tmp) = make_transport(N);
        let input = vec![0.0f32; N * CHANNELS];
        let mut output = vec![0.0f32; N * CHANNELS];

        // SLOTS 回は slot_free(saturating) で OK。
        for _ in 0..SLOTS {
            let status = unsafe { t.process_block(&input, &mut output) };
            assert_eq!(status.submit, SubmitKind::Submitted);
        }
        // SLOTS+1 回目: seq_done=0 のまま → new_seq - SLOTS > 0 = stall。
        let status = unsafe { t.process_block(&input, &mut output) };
        assert_eq!(status.submit, SubmitKind::Stall);
    }

    #[test]
    fn stale_uses_repeat_previous_not_silence() {
        // seq_done を 0 に留めたまま 2 回 process_block を呼ぶ。
        // 2 回目（primed=true, seq_done < req）は stale → repeat_buf（zeros）をコピー。
        let (mut t, _mmap, _tmp) = make_transport(N);
        let input = vec![0.0f32; N * CHANNELS];
        let mut output = vec![1.0f32; N * CHANNELS]; // 非 zero で初期化

        // 1 回目: priming。
        let _ = unsafe { t.process_block(&input, &mut output) };
        // 2 回目: primed=true, seq_done=0 < req=1 → stale。repeat_buf = zeros。
        let status = unsafe { t.process_block(&input, &mut output) };
        assert_eq!(status.output, OutputKind::Stale);
        // repeat_buf は zero-init → stale output も zero（silence）になることを確認。
        assert!(output.iter().all(|&s| s == 0.0));
    }
}
