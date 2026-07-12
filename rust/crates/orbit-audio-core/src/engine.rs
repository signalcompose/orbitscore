//! Engine: Scheduler と sample ローダを束ねた上位 API。
//!
//! Phase 2 以降で DSL interpreter と接続する想定。PoC では
//! 「サンプルをロードして、時刻指定でスケジュールする」だけを提供する。

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use thiserror::Error;

use super::scheduler::{ScheduledSample, Scheduler};
use super::Sample;

#[derive(Error, Debug)]
pub enum EngineError {
    #[error("sample decode error: {0}")]
    Decode(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("scheduler mutex poisoned (a previous thread panicked while holding the lock)")]
    Poisoned,
}

/// 共有可能なエンジンハンドル。
///
/// オーディオコールバック（リアルタイムスレッド）と制御スレッドで共有するため、
/// 内部状態は `Mutex` でガードする。将来は lock-free ringbuf などに置き換える余地あり。
#[derive(Clone)]
pub struct Engine {
    inner: Arc<Mutex<Scheduler>>,
    /// `with_scheduler` / `render_multi` が RT 競合で `try_lock` が **`WouldBlock`** を返し
    /// silent zero-fill にフォールバックした回数（health signal）。この経路自体は既存の設計判断
    /// （lock-free 化は別 Issue で defer 済み）だが、発生を可視化する仕組みが無かったため追加した
    /// （#401）。`WouldBlock` は自己修復する障害（次のブロックでロックが空けば復帰）なので stuck
    /// しないが、32/64f 小バッファ性能ゴール下ではライブコマンド頻度に比例して発生確率が上がるため、
    /// operator が気づける形にする。**`Poisoned`（恒久障害）はこのカウンタに含めない** — 別スレッドの
    /// panic で一度 poison すると `clear_poison()` を呼ぶ箇所が無く同一プロセス内で永続するため、
    /// 一時的な競合と同列に数えると「次のブロックで自己修復する」という意味が壊れる。poison は
    /// `poisoned` フラグで区別する。
    contention_count: Arc<AtomicU64>,
    /// scheduler Mutex が RT `try_lock` で **`Poisoned`** と判定されたかどうか（#401）。
    /// 一度 `true` になると `clear_poison()` が呼ばれないため、同一プロセス生存中は戻らない
    /// （render 系は恒久的に zero-fill、`schedule`/`stop`/`stop_all`/`set_global_gain` などの
    /// 制御系 API も以降ずっと `EngineError::Poisoned` を返す）。`contention_count` の
    /// `WouldBlock` とは異なり自己修復しない。
    poisoned: Arc<AtomicBool>,
}

impl Engine {
    pub fn new(sample_rate: u32, channels: u16) -> Self {
        Self {
            inner: Arc::new(Mutex::new(Scheduler::new(sample_rate, channels))),
            contention_count: Arc::new(AtomicU64::new(0)),
            poisoned: Arc::new(AtomicBool::new(false)),
        }
    }

    /// サンプルをスケジュールする。制御スレッドから呼ぶ想定。
    /// スケジューラの Mutex が poisoned 状態の場合はエラーを返し、呼び出し側に
    /// 障害を伝える（サイレントに無視しない）。
    pub fn schedule(&self, start_sec: f64, sample: Sample) -> Result<(), EngineError> {
        let mut s = self.inner.lock().map_err(|_| EngineError::Poisoned)?;
        s.schedule(ScheduledSample::new(start_sec, sample));
        Ok(())
    }

    /// `play_id` 付きでスケジュールする。後で `stop` で個別停止できる。
    ///
    /// `pan` は [-1.0, 1.0]（0.0 = 中央）。render 時に等パワー則（SC `Pan2` 一致）で
    /// 適用され、範囲外は clamp される。
    /// `slice_start_frame` / `slice_len_frames` は再生領域（`chop` の slice）。
    /// `slice_len_frames == 0` で「offset 以降すべて」。サンプル端で clamp される。
    /// `rate` は varispeed（1.0 = 自然尺・`<=0`/非有限は 1.0 に丸め）。
    /// `channel` は出力先 channel 名（LinkAudio outputChannel・#209）。`None` = 既定
    /// （unrouted / hardware sum）。同名 channel は `render_channel` で加算合成される。
    #[allow(clippy::too_many_arguments)]
    pub fn schedule_with_play_id(
        &self,
        start_sec: f64,
        gain: f32,
        pan: f32,
        slice_start_frame: usize,
        slice_len_frames: usize,
        rate: f64,
        channel: Option<String>,
        play_id: String,
        sample: Sample,
    ) -> Result<(), EngineError> {
        let mut s = self.inner.lock().map_err(|_| EngineError::Poisoned)?;
        s.schedule(
            ScheduledSample::new(start_sec, sample)
                .with_gain(gain)
                .with_pan(pan)
                .with_region(slice_start_frame, slice_len_frames)
                .with_rate(rate)
                .with_channel(channel)
                .with_play_id(play_id),
        );
        Ok(())
    }

    /// `play_id` に一致するアクティブ再生を停止する。true = 停止成功, false = 見つからず。
    pub fn stop(&self, play_id: &str) -> Result<bool, EngineError> {
        let mut s = self.inner.lock().map_err(|_| EngineError::Poisoned)?;
        Ok(s.stop(play_id))
    }

    /// 全イベントを即時停止する hard-stop-all。停止件数を返す（respawn / stopAll で使う）。
    pub fn stop_all(&self) -> Result<usize, EngineError> {
        let mut s = self.inner.lock().map_err(|_| EngineError::Poisoned)?;
        Ok(s.stop_all())
    }

    /// スケジュール中のイベント数（実時間で active な再生数）。
    /// ロック競合時は `None` を返す。
    pub fn active_count(&self) -> Option<usize> {
        self.inner.try_lock().ok().map(|s| s.active_count())
    }

    /// マスターゲインを設定する。`ramp_sec` が 0 以下なら即時、正なら線形ランプ。
    ///
    /// 正の `ramp_sec` がサブフレーム相当（例: 1/sample_rate 未満）でも、
    /// 呼び出し側の「ランプ要求」意図を尊重して最小 1 フレームのランプとして扱う。
    /// これにより、意図せず即時切替にフォールバックして pop ノイズが乗ることを防ぐ。
    pub fn set_global_gain(&self, value: f32, ramp_sec: f64) -> Result<(), EngineError> {
        let mut s = self.inner.lock().map_err(|_| EngineError::Poisoned)?;
        let ramp_frames = if ramp_sec > 0.0 {
            ((ramp_sec * s.output_sample_rate() as f64).round() as u64).max(1)
        } else {
            0
        };
        s.set_global_gain(value, ramp_frames);
        Ok(())
    }

    /// `try_lock` で Scheduler を借りて `f` を実行する。RT スレッドから呼ばれるため、ロック
    /// 競合時は無音（silent drop）で即時 return する（将来 lock-free ringbuffer 化の余地あり・
    /// Phase 2）。`render` / `render_channel` がこの try-lock + silent-drop 規約を共有する。
    ///
    /// `try_lock` の失敗理由を区別する（#401）: **`WouldBlock`**（一時的競合）は
    /// `contention_count` に積むだけ — 次のブロックで自己修復する。**`Poisoned`**（別スレッドの
    /// panic で永続破損）は `poisoned` フラグを立てるだけに留める。RT コールバック内なので
    /// どちらの分岐も `tracing::warn!` 等のブロッキング/アロケーションを伴う処理は行わない
    /// （非ブロッキングな atomic write のみ）。
    fn with_scheduler(&self, out: &mut [f32], f: impl FnOnce(&mut Scheduler, &mut [f32])) {
        match self.inner.try_lock() {
            // MutexGuard を DerefMut で &mut Scheduler に再借用して closure に渡す。
            Ok(mut s) => return f(&mut s, out),
            Err(std::sync::TryLockError::WouldBlock) => {
                self.contention_count.fetch_add(1, Ordering::Relaxed);
            }
            Err(std::sync::TryLockError::Poisoned(_)) => {
                self.poisoned.store(true, Ordering::Relaxed);
            }
        }
        for x in out.iter_mut() {
            *x = 0.0;
        }
    }

    /// オーディオコールバックから呼び出される。`out` は interleaved f32。RT 競合時は無音。
    pub fn render(&self, out: &mut [f32]) {
        self.with_scheduler(out, |s, b| s.render(b));
    }

    /// `render` の channel filter 版。指定 channel 名に属する event だけを `out` に加算する
    /// （LinkAudio per-channel tap・#209）。test/scaffolding 用（本番 RT は A4-2b-2 で
    /// [`Scheduler::render_multi`] に移行予定）。本番 hardware `render` と同一 tick で混在させない
    /// こと（[`Scheduler::render_channel`] 参照）。
    #[doc(hidden)]
    pub fn render_channel(&self, out: &mut [f32], channel: &str) {
        self.with_scheduler(out, |s, b| s.render_channel(b, channel));
    }

    /// 本番 RT 用の single-pass multi-buffer render（A4-2b-2）。`hardware_out`（channel=None）と
    /// 各 named channel buffer を 1 パスで埋め transport を 1 回だけ進める
    /// （[`Scheduler::render_multi`]）。RT 競合時は `render` の silent-drop 規約を multi-buffer に
    /// 拡張し、**hardware と全 channel buffer を無音**にする（ramp を多重に進めないため単一の
    /// try_lock で一括処理する）。`try_lock` 失敗理由（`WouldBlock` / `Poisoned`）の区別と RT-safety
    /// 制約は `with_scheduler` と同じ（#401）。
    pub fn render_multi(&self, hardware_out: &mut [f32], channels: &mut [(&str, &mut [f32])]) {
        match self.inner.try_lock() {
            Ok(mut s) => return s.render_multi(hardware_out, channels),
            Err(std::sync::TryLockError::WouldBlock) => {
                self.contention_count.fetch_add(1, Ordering::Relaxed);
            }
            Err(std::sync::TryLockError::Poisoned(_)) => {
                self.poisoned.store(true, Ordering::Relaxed);
            }
        }
        hardware_out.fill(0.0);
        for (_, buf) in channels.iter_mut() {
            buf.fill(0.0);
        }
    }

    /// `contention_count`（`WouldBlock` 由来の累積 zero-fill 回数）を返す。詳細な意味論は
    /// field doc 参照。daemon の 1 Hz ticker が polling して増加を surface する。
    pub fn lock_contention_count(&self) -> u64 {
        self.contention_count.load(Ordering::Relaxed)
    }

    /// scheduler Mutex が RT `try_lock` で poisoned と判定されたか。詳細な意味論は `poisoned`
    /// field doc 参照。daemon の 1 Hz ticker が polling して fire-once の FATAL event を出す。
    pub fn is_lock_poisoned(&self) -> bool {
        self.poisoned.load(Ordering::Relaxed)
    }

    /// test harness 用: `contention_count` の `Arc` を取得し、外部から `WouldBlock` 競合を
    /// 決定論的に注入できるようにする（`StreamStats::record_xrun` と同形 — 本番と同一 counter に
    /// 直接書く injection seam）。`#[doc(hidden)]` で公開 API としては扱わない。
    #[doc(hidden)]
    pub fn contention_count_arc(&self) -> Arc<AtomicU64> {
        self.contention_count.clone()
    }

    /// test harness 用: `poisoned` の `Arc` を取得し、外部から poison 状態を決定論的に注入できる
    /// ようにする（`contention_count_arc` と同形）。実際に Mutex を panic-poison させずに
    /// daemon 側の FATAL event 経路を検証するための seam。`#[doc(hidden)]`。
    #[doc(hidden)]
    pub fn poisoned_arc(&self) -> Arc<AtomicBool> {
        self.poisoned.clone()
    }

    /// 現在の出力ストリーム時刻（秒）を返す。
    /// ロック取得に失敗した場合は `None` を返し、呼び出し側がストリーム開始直後の
    /// `Some(0.0)` と区別できるようにする。
    pub fn now_sec(&self) -> Option<f64> {
        self.inner.try_lock().ok().map(|s| s.now_sec())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schedule_then_render_writes_nonzero() {
        let engine = Engine::new(48_000, 2);
        let sample = Sample::new(vec![0.5f32; 200], 48_000, 2);
        engine.schedule(0.0, sample).expect("schedule");

        let mut buf = vec![0.0f32; 400];
        engine.render(&mut buf);
        assert!(buf.iter().any(|&x| x != 0.0));
    }

    #[test]
    fn now_sec_returns_some_zero_at_start() {
        let engine = Engine::new(48_000, 2);
        assert_eq!(engine.now_sec(), Some(0.0));
    }

    // try_lock 競合時の silent zero-fill フォールバック（#401）を、同一スレッドで `inner` を
    // 直接 lock して人工的に競合させ検証する（std::sync::Mutex は非再入なので、同一スレッド内で
    // guard を保持したまま try_lock しても Err になる — 別スレッドを spawn する必要がない）。
    #[test]
    fn contention_count_increments_on_render_lock_conflict() {
        let engine = Engine::new(48_000, 2);
        assert_eq!(engine.lock_contention_count(), 0);

        let mut buf = vec![1.0f32; 8]; // 非ゼロで初期化し zero-fill を検証できるようにする
        {
            let _guard = engine.inner.lock().expect("lock for contention setup");
            engine.render(&mut buf);
        }

        assert!(
            buf.iter().all(|&x| x == 0.0),
            "lock 競合時は silent zero-fill されるべき"
        );
        assert_eq!(
            engine.lock_contention_count(),
            1,
            "render の try_lock 失敗で contention_count が増分されるべき"
        );
        assert!(
            !engine.is_lock_poisoned(),
            "WouldBlock contention must not also set the poisoned flag"
        );
    }

    #[test]
    fn contention_count_increments_on_render_multi_lock_conflict() {
        let engine = Engine::new(48_000, 2);

        let mut hw = vec![1.0f32; 4];
        let mut ch_buf = vec![1.0f32; 4];
        {
            let _guard = engine.inner.lock().expect("lock for contention setup");
            let mut chans: [(&str, &mut [f32]); 1] = [("fx", &mut ch_buf)];
            engine.render_multi(&mut hw, &mut chans);
        }

        assert!(hw.iter().all(|&x| x == 0.0));
        assert!(ch_buf.iter().all(|&x| x == 0.0));
        assert_eq!(engine.lock_contention_count(), 1);
        assert!(
            !engine.is_lock_poisoned(),
            "WouldBlock contention must not also set the poisoned flag"
        );
    }

    // `WouldBlock`（上の2テスト・同一スレッドで guard を保持したまま try_lock）とは別に、
    // 別スレッドで実際に panic させて Mutex を poison し、`Poisoned` 分岐が `contention_count`
    // ではなく専用の `poisoned` フラグを立てることを検証する（#401 の主眼: 一時競合と恒久障害を
    // 同一カウンタに混ぜない）。
    #[test]
    fn poisoned_flag_sets_on_render_lock_poison_distinct_from_contention_count() {
        let engine = Engine::new(48_000, 2);
        assert!(!engine.is_lock_poisoned());
        assert_eq!(engine.lock_contention_count(), 0);

        let engine_clone = engine.clone();
        let panicked = std::thread::spawn(move || {
            let _guard = engine_clone.inner.lock().expect("lock for poison setup");
            panic!("intentional poison for poisoned_flag_sets_on_render_lock_poison test");
        })
        .join()
        .is_err();
        assert!(
            panicked,
            "spawned thread should have panicked while holding the lock"
        );

        let mut buf = vec![1.0f32; 8];
        engine.render(&mut buf);

        assert!(
            buf.iter().all(|&x| x == 0.0),
            "poisoned lock 時も silent zero-fill されるべき"
        );
        assert!(
            engine.is_lock_poisoned(),
            "render の try_lock Poisoned 失敗で poisoned フラグが立つべき"
        );
        assert_eq!(
            engine.lock_contention_count(),
            0,
            "poison は WouldBlock 専用の contention_count に混ぜてはいけない"
        );
    }

    // render_multi は with_scheduler を経由せず try_lock を直接ハンドリングする別実装
    // （#401 で Poisoned 分岐を手動で複製した）ため、render() 側の genuine-poison テストとは
    // 独立して render_multi() 側も同じ経路を検証する。
    #[test]
    fn poisoned_flag_sets_on_render_multi_lock_poison_distinct_from_contention_count() {
        let engine = Engine::new(48_000, 2);
        assert!(!engine.is_lock_poisoned());
        assert_eq!(engine.lock_contention_count(), 0);

        let engine_clone = engine.clone();
        let panicked = std::thread::spawn(move || {
            let _guard = engine_clone.inner.lock().expect("lock for poison setup");
            panic!("intentional poison for poisoned_flag_sets_on_render_multi_lock_poison test");
        })
        .join()
        .is_err();
        assert!(
            panicked,
            "spawned thread should have panicked while holding the lock"
        );

        let mut hw = vec![1.0f32; 8];
        let mut ch_buf = vec![1.0f32; 4];
        let mut chans: [(&str, &mut [f32]); 1] = [("fx", &mut ch_buf)];
        engine.render_multi(&mut hw, &mut chans);

        assert!(
            hw.iter().all(|&x| x == 0.0),
            "poisoned lock 時も hardware_out は silent zero-fill されるべき"
        );
        assert!(
            ch_buf.iter().all(|&x| x == 0.0),
            "poisoned lock 時も channel buffer は silent zero-fill されるべき"
        );
        assert!(
            engine.is_lock_poisoned(),
            "render_multi の try_lock Poisoned 失敗で poisoned フラグが立つべき"
        );
        assert_eq!(
            engine.lock_contention_count(),
            0,
            "poison は WouldBlock 専用の contention_count に混ぜてはいけない"
        );
    }

    // 制御系 API（schedule/stop/stop_all/set_global_gain）は既に `self.inner.lock().map_err(|_|
    // EngineError::Poisoned)?` を実装しているが（#401 以前からの既存コード）、実際に mutex を
    // panic-poison させて `Err(EngineError::Poisoned)` を返すことを検証するテストが無かった。
    // render 系と同じ poison 手法（別スレッドで panic させて join）を流用する。
    #[test]
    fn control_plane_methods_return_poisoned_error_after_genuine_poison() {
        let engine = Engine::new(48_000, 2);

        let engine_clone = engine.clone();
        let panicked = std::thread::spawn(move || {
            let _guard = engine_clone.inner.lock().expect("lock for poison setup");
            panic!("intentional poison for control_plane_methods_return_poisoned_error test");
        })
        .join()
        .is_err();
        assert!(
            panicked,
            "spawned thread should have panicked while holding the lock"
        );

        assert!(
            matches!(engine.stop_all(), Err(EngineError::Poisoned)),
            "stop_all() should surface EngineError::Poisoned instead of panicking after genuine poison"
        );
        assert!(
            matches!(
                engine.schedule(0.0, Sample::new(vec![0.5f32; 8], 48_000, 2)),
                Err(EngineError::Poisoned)
            ),
            "schedule() should surface EngineError::Poisoned instead of panicking after genuine poison"
        );
    }

    // render_multi の Engine ラッパが channel タグで出力先を分離することを CI で検証する
    // （ルーティング本体の網羅は Scheduler::render_multi 側のテスト群・ここは Engine の委譲を pin）。
    // try_lock 競合時（WouldBlock）の全バッファ zero-fill 経路は `render` と同一の with_scheduler
    // 規約（決定論的な再現は `contention_count_increments_on_render_multi_lock_conflict` 参照）。
    #[test]
    fn render_multi_routes_by_channel_tag() {
        let engine = Engine::new(48_000, 2);
        // tagged "fx" イベント。
        engine
            .schedule_with_play_id(
                0.0,
                1.0,
                0.0,
                0,
                0,
                1.0,
                Some("fx".into()),
                "p-fx".into(),
                Sample::new(vec![0.5f32; 200], 48_000, 2),
            )
            .expect("schedule tagged");
        // untagged（hardware）イベント。
        engine
            .schedule_with_play_id(
                0.0,
                1.0,
                0.0,
                0,
                0,
                1.0,
                None,
                "p-hw".into(),
                Sample::new(vec![0.3f32; 200], 48_000, 2),
            )
            .expect("schedule untagged");

        let mut hw = vec![0.0f32; 400];
        let mut chbuf = vec![0.0f32; 400];
        let mut chans: [(&str, &mut [f32]); 1] = [("fx", &mut chbuf)];
        engine.render_multi(&mut hw, &mut chans);

        // tagged は channel buffer、untagged は hardware に分離して出力される。
        assert!(
            chbuf.iter().any(|&x| x != 0.0),
            "tagged event must land in the channel buffer"
        );
        assert!(
            hw.iter().any(|&x| x != 0.0),
            "untagged event must land in hardware"
        );
    }

    // tagged-only のとき hardware は無音（tagged event が hardware に漏れない＝routing 分離の確証）。
    #[test]
    fn render_multi_tagged_event_does_not_leak_to_hardware() {
        let engine = Engine::new(48_000, 2);
        engine
            .schedule_with_play_id(
                0.0,
                1.0,
                0.0,
                0,
                0,
                1.0,
                Some("fx".into()),
                "p-fx".into(),
                Sample::new(vec![0.5f32; 200], 48_000, 2),
            )
            .expect("schedule tagged");

        let mut hw = vec![0.0f32; 400];
        let mut chbuf = vec![0.0f32; 400];
        let mut chans: [(&str, &mut [f32]); 1] = [("fx", &mut chbuf)];
        engine.render_multi(&mut hw, &mut chans);

        assert!(
            chbuf.iter().any(|&x| x != 0.0),
            "tagged event must land in the channel buffer"
        );
        assert!(
            hw.iter().all(|&x| x == 0.0),
            "hardware must stay silent when the only event is channel-tagged"
        );
    }
}
