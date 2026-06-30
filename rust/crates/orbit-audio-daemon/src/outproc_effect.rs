//! γ M1 PR-C: out-of-process effect の daemon 配線（feature `outproc-effect` 専用・clack-free）。
//!
//! 検証済み pipelined（候補B）sandbox host（`orbit-audio-sandbox`）を本番 daemon の master-bus
//! post-processor 経路（`orbit_audio_native::PostProcessor` seam）に統合する。effect は **別プロセス**
//! （`orbit-clap-effect-child`）で実 CLAP plugin を host し、本 crate は共有メモリ transport
//! （memmap2 のみ・clack 非依存）越しに 1-block ずらして audio を流す（serial insert）。
//!
//! ## なぜ daemon 側か（設計 §4.1/§4.6）
//! [`OutProcEffectPostProcessor`] は `orbit_audio_native::PostProcessor` を実装する。sandbox crate は
//! native/cpal/clack 非依存を保つ設計なので、`PostProcessor` を impl する adapter は daemon（native が
//! ある所）に置く。adapter は `PipelinedEffectHost`（clack-free）を薄く包むだけで、clack は spawn
//! された child プロセスだけにリンクされる（daemon の依存グラフは clack-free）。
//!
//! supervision（spawn / watchdog / respawn）と daemon `start()` 統合は別途（commit 3）。本モジュールは
//! まず audio-thread 側 adapter と teardown handshake を提供する。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use orbit_audio_native::PostProcessor;
use orbit_audio_sandbox::PipelinedEffectHost;

/// `PipelinedEffectHost`（候補B 状態機械・clack-free）を `impl PostProcessor` で包む OOP effect adapter。
///
/// cpal closure が所有し audio thread 上で排他的に動く（`ClapPostProcessor` と並列の clack-free 実装）。
/// `process` は RT callback ごとに 1 block を child へ submit し前 block の出力を読む（候補B・+1 block
/// 遅延・child が間に合わなければ repeat-previous）。RT 安全性は `PipelinedEffectHost::process_block`
/// が担保する（alloc/lock/syscall なし）。
pub struct OutProcEffectPostProcessor {
    host: PipelinedEffectHost,
    /// teardown 要求（daemon supervisor → audio thread）。立つと transport への submit を止め、`data` を
    /// dry のまま素通しする。これにより control 側が child へ QUIT を送って reap・shm unlink する前に
    /// audio thread が transport を触らなくなる（in-process clap の handshake を踏襲・設計 §4.5）。
    teardown_requested: Arc<AtomicBool>,
    /// teardown 完了（audio thread → daemon supervisor）。`process` が quiesce に入ったら立てる。
    /// supervisor は stream を止める前にこれを待つ。
    teardown_done: Arc<AtomicBool>,
}

impl OutProcEffectPostProcessor {
    /// `host` = mmap を所有する production 構築子（`PipelinedEffectHost::from_mmap`）で作った host、
    /// `teardown_requested` / `teardown_done` = supervisor と共有する協調フラグ。
    pub fn new(
        host: PipelinedEffectHost,
        teardown_requested: Arc<AtomicBool>,
        teardown_done: Arc<AtomicBool>,
    ) -> Self {
        Self {
            host,
            teardown_requested,
            teardown_done,
        }
    }
}

impl PostProcessor for OutProcEffectPostProcessor {
    /// `data` は engine が render 済みの interleaved f32（hardware sum）。OOP effect で in-place 変換する。
    ///
    /// teardown 要求が来たら transport を触らず `data` を dry のまま素通しし、`teardown_done` を立てる
    /// （冪等）。それ以外は `PipelinedEffectHost::process_block` に委譲する。
    fn process(&mut self, data: &mut [f32]) {
        if self.teardown_requested.load(Ordering::Acquire) {
            // quiesce: 以降 transport（shm）を触らない。data は engine の dry 出力のまま流れる。
            self.teardown_done.store(true, Ordering::Release);
            return;
        }
        self.host.process_block(data);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64;

    /// 同一プロセス内の複数テストで shm ファイル名が衝突しないための連番。
    static SHM_SEQ: AtomicU64 = AtomicU64::new(0);

    /// 実 mmap（zero-init・unlink 後もマッピングは有効）を所有する production 構築子経由の host を作る。
    /// unsafe を使わず（`from_mmap`）テスト用に zeroed SharedRegion を得る。
    fn temp_host() -> PipelinedEffectHost {
        let seq = SHM_SEQ.fetch_add(1, Ordering::Relaxed);
        let p = std::env::temp_dir().join(format!(
            "orbit-oop-adapter-{}-{}.shm",
            std::process::id(),
            seq
        ));
        let _ = std::fs::remove_file(&p);
        let mmap = orbit_audio_sandbox::create_shared(&p).expect("create_shared");
        // unlink しても mapping は生存する（Unix）。テスト終了時の掃除を兼ねる。
        let _ = std::fs::remove_file(&p);
        PipelinedEffectHost::from_mmap(mmap)
    }

    fn flags() -> (Arc<AtomicBool>, Arc<AtomicBool>) {
        (
            Arc::new(AtomicBool::new(false)),
            Arc::new(AtomicBool::new(false)),
        )
    }

    // 通常経路: adapter は host.process_block に委譲する。child が未処理（mmap zero-init）なので初回は
    // prime silence（host が data を無音化）= 委譲が起きた証拠（adapter が素通ししていない）。
    #[test]
    fn delegates_to_host_first_block_primes_silence() {
        let (tr, td) = flags();
        let mut pp = OutProcEffectPostProcessor::new(temp_host(), tr, td.clone());
        let mut data = vec![0.7f32; 64 * 2];
        pp.process(&mut data);
        assert!(
            data.iter().all(|&x| x == 0.0),
            "初回は host が prime silence（adapter が host.process_block へ委譲した証拠）"
        );
        assert!(
            !td.load(Ordering::Acquire),
            "teardown 未要求なので teardown_done は立たない"
        );
    }

    // teardown handshake: teardown_requested が立つと transport を触らず data を dry 素通しし、
    // teardown_done を立てる。host.process_block は呼ばれない（data が無音化されない）。
    #[test]
    fn teardown_passes_dry_and_acks() {
        let (tr, td) = flags();
        let mut pp = OutProcEffectPostProcessor::new(temp_host(), tr.clone(), td.clone());
        tr.store(true, Ordering::Release);

        let mut data = vec![0.7f32; 64 * 2];
        pp.process(&mut data);
        assert!(
            data.iter().all(|&x| (x - 0.7).abs() < 1e-9),
            "teardown 中は data を dry のまま素通し（host へ委譲せず無音化しない）"
        );
        assert!(
            td.load(Ordering::Acquire),
            "teardown_done を立てて supervisor に quiesce 完了を通知する"
        );

        // 冪等: 再度呼んでも dry 素通し + done のまま。
        let mut data2 = vec![-0.3f32; 32 * 2];
        pp.process(&mut data2);
        assert!(
            data2.iter().all(|&x| (x + 0.3).abs() < 1e-9),
            "冪等に dry 素通し"
        );
        assert!(td.load(Ordering::Acquire));
    }
}
