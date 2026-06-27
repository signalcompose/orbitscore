//! pipelined(候補B) effect host — RT callback ごとに 1 block を境界越しに処理する状態機械。
//!
//! γ latency fork spike(#351)が採用した候補B: host は **spin しない**。callback K で
//! 現ブロック(`data` = engine の dry 出力)を child へ submit し、**前 callback で submit した
//! ブロックの出力を読んで `data` を上書きする**(serial insert)。これにより同期 round-trip の
//! tail(~2-4ms・buffer 非依存)を構造的に消し、32f まで小バッファを feasible にする。代償は
//! **+1 block の出力遅延**(最終 hw sum 全体に均一にかかる純レイテンシ)と、child が間に合わない
//! 時の **stale**(owner 決定 = repeat-previous: 直前の good block を再出力してクリック回避)。
//!
//! 本 host は `&mut [f32]`(post-processor の in-place バッファ)と `*mut SharedRegion` の上で完結し、
//! orbit-audio-native(PostProcessor trait)にも cpal にも依存しない。`impl PostProcessor` の adapter は
//! daemon 側(native がある所)に薄く置く。本 host の `process_block` を RT callback から呼ぶ。

#![allow(unsafe_code)]

use std::sync::atomic::Ordering::{Acquire, Relaxed, Release};

use memmap2::MmapMut;

use crate::transport::{region_ptr, slot_offset, SharedRegion, BUF_LEN, CHANNELS, SLOTS};

/// pipelined effect host の RT 状態。`process_block` を audio callback から呼ぶ。
///
/// 不変条件: `region` は生存する mmap(または `_owner` が None の場合は呼び出し側が生かす
/// `SharedRegion`)を指す。`last_good` は construction 時に `BUF_LEN` 確保済みで、`process_block`
/// は alloc しない。
pub struct PipelinedEffectHost {
    /// 共有領域へのポインタ。`_owner` が Some の場合その mmap が、None の場合呼び出し側が生かす。
    region: *mut SharedRegion,
    /// mmap を所有する場合の保持(production)。test は `from_raw` で None。
    _owner: Option<MmapMut>,
    /// 直前に読めた good 出力ブロック(repeat-previous 用・事前確保)。
    last_good: Vec<f32>,
    /// これまでに submit した最大 seq(0 = 未 submit)。
    submitted: u64,
    /// 最初の good 読み出しが済んだか(false の間は prime silence)。
    primed: bool,
    /// child から fresh な出力を読めた callback 数(観測用)。
    pub fresh: u64,
    /// child が間に合わず repeat-previous した callback 数(観測用)。
    pub stale: u64,
    /// slot 再利用待ちで submit を見送った callback 数(観測用・slot 数決定の主指標)。
    pub stall: u64,
    /// data.len() が BUF_LEN を超え clamp した callback 数(観測用・通常 0)。
    pub frames_clamped: u64,
}

// SAFETY: `region` は単一 audio スレッドが排他所有する(daemon が host を cpal callback closure に
// move し、それ以降そのスレッドからのみ触る)。クロスプロセスの同期は SharedRegion の atomic が
// 担い、host 自身が複数スレッドから共有されることはない。MmapMut は Send。
unsafe impl Send for PipelinedEffectHost {}

impl PipelinedEffectHost {
    /// mmap を所有して host を作る(production)。`mmap` は [`crate::transport::create_shared`] が
    /// 返したもの。
    pub fn from_mmap(mmap: MmapMut) -> Self {
        let region = region_ptr(&mmap);
        Self::with_region(region, Some(mmap))
    }

    /// 生ポインタから host を作る(test / 上級者向け)。
    ///
    /// # Safety
    /// `region` は有効な [`SharedRegion`](サイズ/整列を満たす)を指し、host の生存期間を通じて
    /// 呼び出し側が生かし続けなければならない。
    pub unsafe fn from_raw(region: *mut SharedRegion) -> Self {
        Self::with_region(region, None)
    }

    fn with_region(region: *mut SharedRegion, owner: Option<MmapMut>) -> Self {
        Self {
            region,
            _owner: owner,
            last_good: vec![0.0; BUF_LEN],
            submitted: 0,
            primed: false,
            fresh: 0,
            stale: 0,
            stall: 0,
            frames_clamped: 0,
        }
    }

    /// 1 callback ぶんを処理する。`data` は interleaved f32(stereo)で in-place 上書きされる。
    ///
    /// RT-safe: alloc/lock/syscall なし。submit(data を input slot へ)→ read(前ブロックの output を
    /// data へ)の順で、data の dry 入力を失わずに前ブロックの effected 出力へ差し替える。
    pub fn process_block(&mut self, data: &mut [f32]) {
        let raw = data.len();
        if raw > BUF_LEN {
            self.frames_clamped += 1;
        }
        // BUF_LEN = MAX_FRAMES * CHANNELS なので clamp 後は n_frames <= MAX_FRAMES が自明。
        let n_frames = (raw.min(BUF_LEN) / CHANNELS) as u32;
        // count を frame 境界に丸める(端数 sample は触らない)。
        let count = n_frames as usize * CHANNELS;

        // SAFETY: region は生存する SharedRegion を指す(構造体不変条件)。atomic は field 参照経由、
        // input/output 配列は addr_of で生ポインタ化して slot 単位の copy のみ行う(slot 不変条件で
        // child との時間的排他が保証される)。region 全体への &/&mut は形成しない。
        let region = self.region;

        // --- SUBMIT: 現ブロック(dry 入力)を child へ ---
        let new_seq = self.submitted + 1;
        // 最初の SLOTS 本は slot 未使用なので無条件 free。それ以降は slot の前 occupant
        // (new_seq - SLOTS)の完了を待つ。
        let slot_free = new_seq <= SLOTS as u64
            || unsafe { (*region).seq_done.load(Acquire) } >= new_seq - SLOTS as u64;
        if slot_free {
            unsafe {
                let in_base = std::ptr::addr_of_mut!((*region).input) as *mut f32;
                std::ptr::copy_nonoverlapping(
                    data.as_ptr(),
                    in_base.add(slot_offset(new_seq)),
                    count,
                );
                (*region).n_frames.store(n_frames, Relaxed);
                (*region).seq_request.store(new_seq, Release);
            }
            self.submitted = new_seq;
        } else {
            self.stall += 1;
            // submitted は進めない(前ブロックを再度 play する)。
        }

        // --- READ: 前 callback で submit したブロックの出力を data へ ---
        // 1-block pipeline: 今 play すべきは submitted-1(submit 後に約 1 period の処理時間を得た block)。
        // `target >= 1` を先に評価し、初回(target=0)では atomic load を短絡する。`primed` は
        // `done` 成立(= target>=1)でしか立たないため、別途 `primed` を見る必要はない(submitted は
        // 減らないので一度 primed なら target>=1 が恒真)。
        let target = self.submitted.saturating_sub(1);
        let done = target >= 1 && unsafe { (*region).seq_done.load(Acquire) } >= target;
        if done {
            unsafe {
                let out_base = std::ptr::addr_of!((*region).output) as *const f32;
                let src = out_base.add(slot_offset(target));
                std::ptr::copy_nonoverlapping(src, data.as_mut_ptr(), count);
            }
            // last_good は cache-hot な data から複製(shared page の 2 度読みを避ける)。
            self.last_good[..count].copy_from_slice(&data[..count]);
            self.primed = true;
            self.fresh += 1;
        } else if self.primed {
            // repeat-previous: 直前の good block を再出力(クリック回避)。
            data[..count].copy_from_slice(&self.last_good[..count]);
            self.stale += 1;
        } else {
            // まだ一度も good を読めていない(prime 中 / submit 不足)→ 無音。
            data[..count].fill(0.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::REGION_BYTES;

    /// テスト用に heap 上の SharedRegion を zero 初期化で確保し、生ポインタを返す(意図的に leak し
    /// host の生存期間中ポインタを有効に保つ・テストプロセス終了で OS が回収)。
    fn alloc_region() -> *mut SharedRegion {
        assert_eq!(std::mem::size_of::<SharedRegion>(), REGION_BYTES);
        let layout = std::alloc::Layout::new::<SharedRegion>();
        // SAFETY: layout は非ゼロサイズ・align 64。zero 初期化は全 atomic(0)/配列(0.0)に有効。
        let ptr = unsafe { std::alloc::alloc_zeroed(layout) as *mut SharedRegion };
        assert!(!ptr.is_null());
        ptr
    }

    /// テストが「child」を演じる: 直近 request を gain 適用して output へ書き、seq_done を進める。
    fn child_process_latest(region: *mut SharedRegion, gain: f32) {
        unsafe {
            let req = (*region).seq_request.load(Acquire);
            let done = (*region).seq_done.load(Relaxed);
            if req > done {
                let n = (*region).n_frames.load(Relaxed) as usize;
                let count = n * CHANNELS;
                let off = slot_offset(req);
                let in_base = std::ptr::addr_of!((*region).input) as *const f32;
                let out_base = std::ptr::addr_of_mut!((*region).output) as *mut f32;
                for i in 0..count {
                    *out_base.add(off + i) = *in_base.add(off + i) * gain;
                }
                (*region).child_processed.fetch_add(1, Relaxed);
                (*region).seq_done.store(req, Release);
            }
        }
    }

    fn block(val: f32, frames: usize) -> Vec<f32> {
        vec![val; frames * CHANNELS]
    }

    // steady-state: child が毎 callback 追いつくと、+1 block 遅れで gain 済み出力が流れる。
    #[test]
    fn pipelined_steady_state_one_block_delay() {
        let region = alloc_region();
        let mut host = unsafe { PipelinedEffectHost::from_raw(region) };
        let frames = 64;
        let gain = 0.5;

        // callback 1: input=1.0。submit seq1。read target=0 → prime 無音。
        let mut d = block(1.0, frames);
        host.process_block(&mut d);
        assert!(d.iter().all(|&x| x == 0.0), "初回は prime 無音");
        child_process_latest(region, gain); // child が seq1 を処理

        // callback 2: input=2.0。submit seq2。read target=1 → seq1 の gain 出力(1.0*0.5)。
        let mut d = block(2.0, frames);
        host.process_block(&mut d);
        assert!(
            d.iter().all(|&x| (x - 0.5).abs() < 1e-9),
            "+1 block 遅れで seq1 の 0.5"
        );
        child_process_latest(region, gain); // child が seq2 を処理

        // callback 3: input=3.0。submit seq3。read target=2 → seq2 の gain 出力(2.0*0.5)。
        let mut d = block(3.0, frames);
        host.process_block(&mut d);
        assert!(
            d.iter().all(|&x| (x - 1.0).abs() < 1e-9),
            "+1 block 遅れで seq2 の 1.0"
        );

        assert_eq!(host.fresh, 2);
        assert_eq!(host.stale, 0);
        assert_eq!(host.stall, 0);
    }

    // repeat-previous: child が間に合わない callback では直前の good block を再出力する。
    #[test]
    fn pipelined_stale_repeats_previous() {
        let region = alloc_region();
        let mut host = unsafe { PipelinedEffectHost::from_raw(region) };
        let frames = 64;
        let gain = 0.5;

        // prime: callback1 submit seq1 → child 処理。callback2 で seq1 の 0.5 を読み last_good 確立。
        let mut d = block(1.0, frames);
        host.process_block(&mut d); // 無音
        child_process_latest(region, gain);
        let mut d = block(2.0, frames);
        host.process_block(&mut d); // 0.5(seq1)
        assert!(d.iter().all(|&x| (x - 0.5).abs() < 1e-9));
        assert_eq!(host.fresh, 1);

        // callback 3: child を **処理させない**(seq_done 進めない)→ target=2 未完了 → repeat-previous。
        let mut d = block(3.0, frames);
        host.process_block(&mut d);
        assert!(
            d.iter().all(|&x| (x - 0.5).abs() < 1e-9),
            "stale 時は直前 good(0.5)を再出力"
        );
        assert_eq!(host.stale, 1);
        assert_eq!(host.fresh, 1);
    }

    // stall: child が SLOTS block 以上遅れると slot 再利用できず submit を見送る。
    #[test]
    fn pipelined_stall_when_child_falls_behind() {
        let region = alloc_region();
        let mut host = unsafe { PipelinedEffectHost::from_raw(region) };
        let frames = 64;

        // child を一切処理させずに SLOTS+2 callback 回す。最初の SLOTS submit は free、その後は
        // seq_done=0 のままなので slot 再利用待ちで stall する。
        for i in 0..(SLOTS as u64 + 2) {
            let mut d = block(i as f32 + 1.0, frames);
            host.process_block(&mut d);
        }
        assert!(host.stall >= 1, "child 停止で stall が発生する");
        // 一度も fresh は読めていない(child 停止)。
        assert_eq!(host.fresh, 0);
    }
}
