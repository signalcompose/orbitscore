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

use crate::transport::{
    region_ptr, slot_index, slot_offset, SharedRegion, BUF_LEN, CHANNELS, MAX_FRAMES, SLOTS,
};

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
                (*region).n_frames[slot_index(new_seq)].store(n_frames, Relaxed);
                (*region).seq_request.store(new_seq, Release);
            }
            self.submitted = new_seq;
        } else {
            self.stall += 1;
            // submitted は進めない(前ブロックを再度 play する)。
        }

        // --- READ: 前 callback で submit したブロックの出力を data へ ---
        // 1-block pipeline: 今 play すべきは submitted-1(submit 後に約 1 period の処理時間を得た block)。
        // fresh 判定は per-slot `seq_tag[slot(target)] == target`: global monotone な seq_done では、child が
        // 「latest 処理」で中間 seq を skip しても seq_done が target を追い越してしまい false-fresh する
        // (skip された slot は別 generation のまま)。`seq_tag` の Acquire が当該 slot の output を可視化する。
        // `target >= 1` を先に評価し初回(target=0)で atomic load を短絡する。`primed` は ready 成立
        // (target>=1)でしか立たないので、submitted が減らない以上 primed なら target>=1 は恒真。
        let target = self.submitted.saturating_sub(1);
        let ready =
            target >= 1 && unsafe { (*region).seq_tag[slot_index(target)].load(Acquire) } == target;
        if ready {
            // child が slot(target)へ書いた実フレーム数で copy 長を clamp(可変 buffer の stale tail を防ぐ)。
            // n_frames[slot(target)] は host 自身が target の submit 時に書いた値(同一プロセス・program
            // order で可視)。slot 不変条件で target の slot は submitted+SLOTS まで再利用されない。
            let target_count = (unsafe { (*region).n_frames[slot_index(target)].load(Relaxed) }
                as usize)
                .min(MAX_FRAMES)
                * CHANNELS;
            let copy = target_count.min(count);
            unsafe {
                let out_base = std::ptr::addr_of!((*region).output) as *const f32;
                let src = out_base.add(slot_offset(target));
                std::ptr::copy_nonoverlapping(src, data.as_mut_ptr(), copy);
            }
            // 現 callback が target より大きい buffer を要求した端は無音で埋める(dry leak 防止・通常 0)。
            if copy < count {
                data[copy..count].fill(0.0);
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

        // clamp(BUF_LEN 超)や端数 sample で触れなかった末尾は無音化(dry leak 防止・通常 count==raw で no-op)。
        if count < raw {
            data[count..].fill(0.0);
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

    /// テストが「child」を演じて **指定 seq** を処理する(skip シナリオ構築のため任意 seq を選べる)。
    /// 実 child(bin/sandbox-effect-child)と同じ per-slot プロトコル: n_frames[slot] を読み output を
    /// 書き、seq_tag[slot]=seq(Release)→ seq_done=seq(Release)。mock と実 child を同一手順に保つ。
    fn child_process_seq(region: *mut SharedRegion, seq: u64, gain: f32) {
        unsafe {
            let n = (*region).n_frames[slot_index(seq)].load(Relaxed) as usize;
            let count = n * CHANNELS;
            let off = slot_offset(seq);
            let in_base = std::ptr::addr_of!((*region).input) as *const f32;
            let out_base = std::ptr::addr_of_mut!((*region).output) as *mut f32;
            for i in 0..count {
                *out_base.add(off + i) = *in_base.add(off + i) * gain;
            }
            (*region).child_processed.fetch_add(1, Relaxed);
            (*region).seq_tag[slot_index(seq)].store(seq, Release);
            (*region).seq_done.store(seq, Release);
        }
    }

    /// テストが「child」を演じて直近 request(latest)を処理する(実 child の通常動作)。
    fn child_process_latest(region: *mut SharedRegion, gain: f32) {
        unsafe {
            let req = (*region).seq_request.load(Acquire);
            let done = (*region).seq_done.load(Relaxed);
            if req > done {
                child_process_seq(region, req, gain);
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
            // 一度も fresh を読めていない間は prime 無音(dry 入力を漏らさない)。
            assert!(
                d.iter().all(|&x| x == 0.0),
                "prime/stall 中は無音(dry leak しない)"
            );
        }
        assert!(host.stall >= 1, "child 停止で stall が発生する");
        // 一度も fresh は読めていない(child 停止)。
        assert_eq!(host.fresh, 0);
    }

    // skip(latest 処理): child が中間 seq を skip して新しい seq を処理し global seq_done が target を
    // 追い越しても、host は per-slot seq_tag で skip を検知し false-fresh しない(PR-C の counter を保護)。
    // 旧判定(seq_done >= target)なら、書かれていない slot を fresh と誤読していたケース。
    #[test]
    fn pipelined_skip_is_not_false_fresh() {
        let region = alloc_region();
        let mut host = unsafe { PipelinedEffectHost::from_raw(region) };
        let frames = 64;
        let gain = 0.5;

        // prime: cb1 submit seq1 → child seq1 → cb2 で seq1(0.5)を fresh 読み last_good を確立。
        let mut d = block(1.0, frames);
        host.process_block(&mut d);
        child_process_seq(region, 1, gain);
        let mut d = block(2.0, frames);
        host.process_block(&mut d);
        assert!(d.iter().all(|&x| (x - 0.5).abs() < 1e-9));
        assert_eq!(host.fresh, 1);

        // trap: child が seq2(slot0)を skip して seq3(slot1)へ jump したと模す。global seq_done を 3 に
        // 進める(target=2 を追い越す)が slot0 の output/seq_tag は seq2 用に書かない(seq_tag[slot(2)]
        // は初期 0 のまま)。旧判定 seq_done>=target なら未書込み slot を false-fresh する状況。
        unsafe {
            (*region).seq_done.store(3, Release);
            (*region).seq_tag[slot_index(3)].store(3, Release); // seq3 は slot1 に正しく在る
        }

        // cb3: submit seq3(slot1)、read target=2(slot0)。seq_tag[slot0]=0 != 2 → repeat-previous。
        let mut d = block(3.0, frames);
        host.process_block(&mut d);
        assert!(
            d.iter().all(|&x| (x - 0.5).abs() < 1e-9),
            "skip された seq2 を false-fresh せず直前 good(0.5)を再出力"
        );
        assert_eq!(host.stale, 1, "skip は stale 扱い");
        assert_eq!(
            host.fresh, 1,
            "fresh counter は汚染されない(slot 数決定指標を保護)"
        );
    }

    // recovery: stall でドロップした後でも、child が追いつけば host は再び fresh を読む(恒久 stall しない)。
    #[test]
    fn pipelined_recovers_after_stall() {
        let region = alloc_region();
        let mut host = unsafe { PipelinedEffectHost::from_raw(region) };
        let frames = 64;
        let gain = 0.5;

        // child を止めたまま SLOTS+1 callback 回して stall を作る。
        for i in 0..(SLOTS as u64 + 1) {
            let mut d = block(i as f32 + 1.0, frames);
            host.process_block(&mut d);
        }
        assert!(host.stall >= 1, "child 停止で stall");
        let stalled = host.submitted;

        // child を追いつかせる(latest 処理で seq_done が submitted に到達 → slot 解放)。
        child_process_latest(region, gain);
        let mut d = block(99.0, frames);
        host.process_block(&mut d);
        assert!(host.submitted > stalled, "slot 解放で submit 再開");

        // 再開ぶんを child が処理 → 続く callback で fresh を読めることを確認。
        child_process_latest(region, gain);
        let prev_fresh = host.fresh;
        let mut d = block(123.0, frames);
        host.process_block(&mut d);
        assert!(host.fresh > prev_fresh, "stall から復帰して fresh を読む");
    }

    // 境界: submit guard は `seq_done == new_seq - SLOTS` ちょうどで free(オフバイワン回帰検出)。
    #[test]
    fn pipelined_submit_guard_exact_boundary() {
        let region = alloc_region();
        let mut host = unsafe { PipelinedEffectHost::from_raw(region) };
        let frames = 64;
        let gain = 0.5;

        // 最初の SLOTS 本は無条件 free(slot 未使用)。child は処理しない。
        for i in 0..SLOTS as u64 {
            let mut d = block(i as f32 + 1.0, frames);
            host.process_block(&mut d);
        }
        assert_eq!(host.submitted, SLOTS as u64);
        assert_eq!(host.stall, 0, "最初の SLOTS 本は無条件 free");

        // child に seq1 だけ処理させる → seq_done=1。次 submit new_seq=SLOTS+1 の guard は
        // seq_done >= (SLOTS+1)-SLOTS = 1。ちょうど 1 なので free(境界が < でなく >= である回帰を検出)。
        child_process_seq(region, 1, gain);
        let mut d = block(100.0, frames);
        host.process_block(&mut d);
        assert_eq!(
            host.submitted,
            SLOTS as u64 + 1,
            "seq_done==new_seq-SLOTS ちょうどで submit 成功"
        );
        assert_eq!(host.stall, 0, "境界で stall しない");
    }

    // clamp: data.len() が BUF_LEN を超えても panic せず frames_clamped を数え、末尾は無音化する。
    #[test]
    fn pipelined_clamps_over_buf_len() {
        let region = alloc_region();
        let mut host = unsafe { PipelinedEffectHost::from_raw(region) };
        // BUF_LEN を 1 frame ぶん超える buffer。
        let over = BUF_LEN + CHANNELS;
        let mut d = vec![0.7f32; over];
        host.process_block(&mut d);
        assert_eq!(host.frames_clamped, 1, "BUF_LEN 超で frames_clamped");
        // 初回 prime 無音 + clamp 末尾無音なので全要素 0(panic しないことが主眼)。
        assert!(d.iter().all(|&x| x == 0.0), "prime 無音 + 末尾無音");
    }

    // READ clamp(可変 buffer): fresh 読み出しは target slot の実フレーム数で copy 長を clamp し、
    // 現 callback がより大きい buffer を要求しても target slot の stale tail を漏らさない。
    // poison-tail 構成: slot の末尾に sentinel を仕込み、漏れたら検出できる差分テスト
    //(clamp を `copy=count` に退行させると sentinel が出力に混入して失敗する)。
    #[test]
    fn pipelined_read_clamps_to_target_slot_frames() {
        let region = alloc_region();
        let mut host = unsafe { PipelinedEffectHost::from_raw(region) };
        let gain = 0.5;

        // cb1: frames=64 → submit seq1(slot_index(1)=1)。child が seq1 を処理(out[slot1][0..128]=0.5)。
        let mut d = block(1.0, 64);
        host.process_block(&mut d);
        child_process_seq(region, 1, gain);

        // poison: slot1 の tail(128..BUF_LEN)に sentinel を書く(前 occupant の残骸を模す)。
        unsafe {
            let out_base = std::ptr::addr_of_mut!((*region).output) as *mut f32;
            let off = slot_offset(1);
            for i in 128..BUF_LEN {
                *out_base.add(off + i) = 9.0;
            }
        }

        // cb2: frames=128(count=256)→ submit seq2(slot_index(0)=0・slot1 と非衝突)。READ target=1:
        // target_count=n_frames[slot1]=64 → copy=min(128,256)=128。data[0..128]=0.5・data[128..256]=無音。
        let mut d = block(2.0, 128);
        host.process_block(&mut d);
        assert!(
            d[0..128].iter().all(|&x| (x - 0.5).abs() < 1e-9),
            "target slot の実フレーム分のみ gain 出力"
        );
        assert!(
            d[128..256].iter().all(|&x| x == 0.0),
            "target より大きい buffer の端は無音化(slot tail の sentinel を漏らさない)"
        );
    }
}
