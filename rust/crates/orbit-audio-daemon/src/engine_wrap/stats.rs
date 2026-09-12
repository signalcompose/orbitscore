//! `EngineWrap` の統計・ヘルス・メトリクスのアクセサ（#888 子 1・第 1 束）。
//!
//! 🔴 **これは純粋な移動である。** `engine_wrap.rs` の `impl EngineWrap` から
//! 40 メソッド（`clap_post_peak` 〜 `output_channels`）をそのまま移しただけで、
//! 本文は 1 行も書き換えていない。検算は「既存テストの期待値を 1 つも変えていない」こと。
//!
//! **親の子モジュールとして置いている**（兄弟モジュールではない）ので、`EngineWrap` の
//! private フィールドにも親の private `use` にも到達できる。**可視性の変更は 0 件**。
//! 兄弟モジュールにすると `pub(crate)` 化が多数必要になり、それは「移動」ではなく
//! 「変更」なので residual に出る（設計 `docs/design/888-child1-first-extraction.md` §5）。

use super::*;

impl EngineWrap {
    /// test harness 用: CLAP post-mix peak（plugin add-mix 後の絶対値ピーク）。発音検証に使う。
    /// `#[doc(hidden)]`。plugin 未ロード / clap 無効時は 0.0。
    #[cfg(feature = "clap-host")]
    #[doc(hidden)]
    pub fn clap_post_peak(&self) -> f32 {
        match self.clap.lock() {
            Ok(g) => g
                .as_ref()
                .map(|c| f32::from_bits(c.stats.post_peak_bits.load(Ordering::Relaxed)))
                .unwrap_or(0.0),
            // poison を「plugin 未ロード」と同じ 0.0 で握り潰すと、gated テストが
            // 「発音しなかった」と誤診断する。warn で root cause を残す（silent-failure 対策）。
            Err(_) => {
                tracing::warn!("clap mutex poisoned; clap_post_peak returning 0.0");
                0.0
            }
        }
    }

    /// test harness / RT 監視用: callback-duration スナップショット（A0 §6・budget 検証）。
    /// `#[doc(hidden)]`。clap 無効時は None。poison 時も None だが warn で区別する。
    #[cfg(feature = "clap-host")]
    #[doc(hidden)]
    pub fn clap_callback_stats(&self) -> Option<orbit_audio_native::CallbackTimeSnapshot> {
        let guard = match self.clap.lock() {
            Ok(g) => g,
            Err(_) => {
                tracing::warn!("clap mutex poisoned; clap_callback_stats returning None");
                return None;
            }
        };
        guard.as_ref().map(|c| c.cb_stats.snapshot())
    }

    /// test harness 用: CLAP post-mix peak をリセットする。effect 検証の two-phase 計測で
    /// baseline（plugin 無し）と effect（plugin 有り）の位相を分けるために使う。`#[doc(hidden)]`。
    #[cfg(feature = "clap-host")]
    #[doc(hidden)]
    pub fn clap_reset_post_peak(&self) {
        match self.clap.lock() {
            Ok(g) => {
                if let Some(c) = g.as_ref() {
                    c.stats.reset_post_peak();
                }
            }
            // reset が黙って no-op だと、後続の two-phase 計測が baseline 汚染で誤判定する。
            Err(_) => tracing::warn!("clap mutex poisoned; clap_reset_post_peak skipped"),
        }
    }

    /// ロード済み plugin の `process()` エラー累積回数（#340）。daemon の 1 Hz ticker が polling して
    /// 増加を `CLAP_PROCESS_ERROR` WARNING で surface する（非 RT observability）。effect は dry 素通し /
    /// instrument は無音になるため、この counter だけが失敗の可視化手段になる。
    /// `try_lock` で ticker をブロックしない: **WouldBlock** は cumulative counter なので次 tick が
    /// 全累積を報告する。**Poisoned** は `link_egress_ring_drops` と同様 warn で post-mortem の根拠を
    /// 残し、以降の発火を抑制する（contention と poison を同一視しない）。
    #[cfg(feature = "clap-host")]
    pub fn clap_process_error_count(&self) -> u64 {
        let control_errors = match self.clap.try_lock() {
            Ok(g) => g
                .as_ref()
                .map(|c| c.stats.process_error_count.load(Ordering::Relaxed))
                .unwrap_or(0),
            Err(std::sync::TryLockError::WouldBlock) => 0,
            Err(std::sync::TryLockError::Poisoned(_)) => {
                tracing::warn!(
                    "clap mutex poisoned; clap_process_error_count reporting 0 for control errors \
                     (CLAP_PROCESS_ERROR suppressed until daemon restart)"
                );
                0
            }
        };
        control_errors + self.clap_process_errors.load(Ordering::Relaxed)
    }

    /// feature `clap-host` 無効ビルド用の stub。本番は常に 0（control が無い）。test 注入分のみ反映。
    #[cfg(not(feature = "clap-host"))]
    pub fn clap_process_error_count(&self) -> u64 {
        self.clap_process_errors.load(Ordering::Relaxed)
    }

    /// `push_plugin_event` の bounded retry が力尽きた回数（#400）。event ring は audio callback
    /// が毎 block 全量 drain するため、通常は 0 のまま推移する health signal。1 Hz ticker が polling
    /// して増加を `PLUGIN_EVENT_RING_OVERFLOW` WARNING で surface する。feature `clap-host` 無効
    /// ビルドでも安全に呼べる（`clap_process_error_count` と同様 unconditional フィールド）。
    pub fn plugin_event_ring_overflow_count(&self) -> u64 {
        self.plugin_event_ring_overflow_count
            .load(Ordering::Relaxed)
    }

    /// test harness 用: `plugin_event_ring_overflow_count` を直接加算する注入 seam（#402
    /// pr-test-analyzer 指摘: sibling counter `link_egress_drops_arc`/`clap_process_errors_arc` に
    /// ある「1 Hz ticker の dedup latch（増加時のみ発火・据え置きでは再発火しない）」の integration
    /// test パターンが、この counter にはまだ無かった）。他の2つと違い `Arc` を返さないのは、この
    /// counter が別スレッドへ producer 側を outsource しない（`EngineWrap` 自身が bounded retry の
    /// 末に直接書く）フィールドだから（struct 定義側の doc 参照）— `&self` 越しの直接 `fetch_add` で
    /// 足りる。`#[doc(hidden)]` で公開 API としては扱わない。
    #[doc(hidden)]
    pub fn plugin_event_ring_overflow_inject(&self, n: u64) {
        self.plugin_event_ring_overflow_count
            .fetch_add(n, Ordering::Relaxed);
    }

    /// test harness / gated 計測用: OOP effect の観測スナップショット（fresh/stale/stall/respawn/
    /// child error 等）。slot 数決定（stale 率）と child crash 生存（respawn）の検証に使う。`#[doc(hidden)]`。
    /// plugin 未起動 / outproc 無効 / poison 時は None（poison は warn で区別）。
    #[cfg(feature = "outproc-effect")]
    #[doc(hidden)]
    pub fn outproc_effect_stats(&self) -> Option<crate::outproc_effect::OutProcEffectSnapshot> {
        match self.outproc.lock() {
            Ok(g) => g.as_ref().map(|c| c.stats.snapshot()),
            Err(_) => {
                tracing::warn!("outproc mutex poisoned; outproc_effect_stats returning None");
                None
            }
        }
    }

    /// test harness / gated 計測用: 特定の named insert bus（`ORBIT_EFFECT_BUSES`）に attach された
    /// OOP effect の観測スナップショット。master bus の [`Self::outproc_effect_stats`] と異なり、
    /// 未知の bus 名 / bus 未起動時は `None`（poison も `None`・warn で区別）。`#[doc(hidden)]`。
    #[cfg(feature = "outproc-effect")]
    #[doc(hidden)]
    pub fn outproc_effect_bus_stats(
        &self,
        bus: &str,
    ) -> Option<crate::outproc_effect::OutProcEffectSnapshot> {
        match self.outproc.lock() {
            Ok(g) => g
                .as_ref()
                .and_then(|c| c.bus_stats.get(bus))
                .map(|stats| stats.snapshot()),
            Err(_) => {
                tracing::warn!("outproc mutex poisoned; outproc_effect_bus_stats returning None");
                None
            }
        }
    }

    /// test harness / RT 監視用: OOP effect の callback-duration スナップショット（A0 §6・budget 検証）。
    /// `#[doc(hidden)]`。outproc 無効時は None。poison 時も None だが warn で区別する。
    #[cfg(feature = "outproc-effect")]
    #[doc(hidden)]
    pub fn outproc_callback_stats(&self) -> Option<orbit_audio_native::CallbackTimeSnapshot> {
        match self.outproc.lock() {
            Ok(g) => g.as_ref().map(|c| c.cb_stats.snapshot()),
            Err(_) => {
                tracing::warn!("outproc mutex poisoned; outproc_callback_stats returning None");
                None
            }
        }
    }

    /// test harness 用: OOP effect の dry / post ピークをリセットする。kill-test / parity の two-phase
    /// 計測で位相を分けるのに使う（`clap_reset_post_peak` と同設計）。`#[doc(hidden)]`。
    #[cfg(feature = "outproc-effect")]
    #[doc(hidden)]
    pub fn outproc_reset_peaks(&self) {
        match self.outproc.lock() {
            Ok(g) => {
                if let Some(c) = g.as_ref() {
                    c.stats.reset_peaks();
                }
            }
            Err(_) => tracing::warn!("outproc mutex poisoned; outproc_reset_peaks skipped"),
        }
    }

    /// Gated instrument harness 用: OOP instrument の発音・child・respawn 観測値を返す。
    #[cfg(feature = "outproc-instrument")]
    #[doc(hidden)]
    pub fn outproc_instrument_stats(
        &self,
    ) -> Option<crate::outproc_instrument::OutProcInstrumentSnapshot> {
        // #540 P1: 互換 accessor は slot 0（= 単数時代の唯一の slot）を返す。
        // instance 指定版は `outproc_instrument_stats_for` を使う。
        match self.outproc_instrument.lock() {
            Ok(guard) => guard
                .as_ref()
                .and_then(|control| control.slots.first().map(|slot| slot.stats.snapshot())),
            Err(_) => {
                tracing::warn!(
                    "outproc instrument mutex poisoned; outproc_instrument_stats returning None"
                );
                None
            }
        }
    }

    /// Gated instrument harness 用（#540 P1）: instance 指定で slot の観測値を返す。
    /// 未割当の instance は None。
    #[cfg(feature = "outproc-instrument")]
    #[doc(hidden)]
    pub fn outproc_instrument_stats_for(
        &self,
        instance: &str,
    ) -> Option<crate::outproc_instrument::OutProcInstrumentSnapshot> {
        match self.outproc_instrument.lock() {
            Ok(guard) => guard.as_ref().and_then(|control| {
                let index = *control.instance_index.get(instance)?;
                control.slots.get(index).map(|slot| slot.stats.snapshot())
            }),
            Err(_) => {
                tracing::warn!(
                    "outproc instrument mutex poisoned; outproc_instrument_stats_for returning None"
                );
                None
            }
        }
    }

    /// Gated kill-test の計測位相を分けるため、instrument source の累積 peak をリセットする。
    #[cfg(feature = "outproc-instrument")]
    #[doc(hidden)]
    pub fn outproc_instrument_reset_post_peak(&self) {
        // #540 P1: 計測位相のリセットは全 slot に適用する（未使用 slot への reset は無害）。
        match self.outproc_instrument.lock() {
            Ok(guard) => {
                if let Some(control) = guard.as_ref() {
                    for slot in &control.slots {
                        slot.stats.reset_post_peak();
                    }
                }
            }
            Err(_) => tracing::warn!(
                "outproc instrument mutex poisoned; outproc_instrument_reset_post_peak skipped"
            ),
        }
    }

    /// OOP effect の health signal を `(child_process_error_count, respawn_count, measurement_invalid,
    /// frames_clamped)` で返す（daemon の 1 Hz ticker が polling して WARNING/FATAL event で surface する
    /// 非 RT observability）。`clap_process_error_count` と同様 `try_lock` で ticker をブロックしない
    /// （**WouldBlock** は cumulative なので次 tick が全累積を報告・**Poisoned** は warn して 0 を返し
    /// post-mortem の根拠を残す）。plugin 未起動 / outproc 無効時は `(0, 0, false, <injected>)`。
    ///
    /// `frames_clamped` は #404 で `OutProcEffectStats` から追加した 4 つ目の signal（block が
    /// `MAX_FRAMES` を超えて clamp された累積回数）。当初は独立した `outproc_frames_clamped()`
    /// accessor だったが、同一 tick 内で同一 `self.outproc` mutex を 2 回 `try_lock` + `snapshot` する
    /// ことになり（(a) 無駄な二重ロック (b) 4 signal が同一スナップショットである保証が消える —
    /// 片方が `WouldBlock` で 0 を返す間にもう片方が非ゼロを観測しうる）、#406 /simplify レビューで
    /// この 1 accessor に統合した。
    #[cfg(feature = "outproc-effect")]
    pub fn outproc_health(&self) -> (u64, u64, bool, u64) {
        let injected = self.outproc_frames_clamped.load(Ordering::Relaxed);
        match self.outproc.try_lock() {
            Ok(g) => g
                .as_ref()
                .map(|c| {
                    let s = c.stats.snapshot();
                    (
                        s.child_process_error_count,
                        s.respawn_count,
                        s.measurement_invalid,
                        s.frames_clamped + injected,
                    )
                })
                .unwrap_or((0, 0, false, injected)),
            Err(std::sync::TryLockError::WouldBlock) => (0, 0, false, injected),
            Err(std::sync::TryLockError::Poisoned(_)) => {
                tracing::warn!(
                    "outproc mutex poisoned; outproc_health reporting zeros \
                     (OUTPROC_EFFECT events suppressed until daemon restart)"
                );
                (0, 0, false, injected)
            }
        }
    }

    /// per-bus OOP effect の health を bus 名つきで列挙する（#461 review Critical: bus child の
    /// crash/respawn/計測無効/frames_clamped が ticker に出ない穴を塞ぐ）。master の
    /// [`Self::outproc_health`] と同型の tuple を bus ごとに返す。1 tick = 1 try_lock +
    /// snapshot 群（WouldBlock/Poisoned/未初期化は空 Vec = 次 tick 持ち越し）。
    #[cfg(feature = "outproc-effect")]
    pub fn outproc_effect_bus_health(&self) -> Vec<(String, (u64, u64, bool, u64))> {
        match self.outproc.try_lock() {
            Ok(g) => g
                .as_ref()
                .map(|c| {
                    c.bus_stats
                        .iter()
                        .map(|(name, stats)| {
                            let s = stats.snapshot();
                            (
                                name.clone(),
                                (
                                    s.child_process_error_count,
                                    s.respawn_count,
                                    s.measurement_invalid,
                                    s.frames_clamped,
                                ),
                            )
                        })
                        .collect()
                })
                .unwrap_or_default(),
            Err(_) => Vec::new(),
        }
    }

    /// feature 無効ビルド用 stub（ticker 側を cfg なしで書けるようにする）。
    #[cfg(not(feature = "outproc-effect"))]
    pub fn outproc_effect_bus_health(&self) -> Vec<(String, (u64, u64, bool, u64))> {
        Vec::new()
    }

    /// 未登録 named target へ tag された event の skip 累計（core の retain ハザード観測点・
    /// `Scheduler::unroutable_event_count`）。lock 競合時は 0（cumulative なので次 tick で回収）。
    pub fn unroutable_event_count(&self) -> u64 {
        self.engine.unroutable_event_count().unwrap_or(0)
    }

    /// feature `outproc-effect` 無効ビルド用の stub。本番は常に `(0, 0, false, ...)`（control が無い）。
    /// `frames_clamped` は test 注入分のみ反映（`link_egress_ring_drops` / `clap_process_error_count`
    /// の無効ビルド stub と同設計）。
    #[cfg(not(feature = "outproc-effect"))]
    pub fn outproc_health(&self) -> (u64, u64, bool, u64) {
        (
            0,
            0,
            false,
            self.outproc_frames_clamped.load(Ordering::Relaxed),
        )
    }

    /// OOP instrument の全 health signal を `(child_process_error_count, respawn_count,
    /// measurement_invalid, output_event_dropped_count, output_event_spilled_count,
    /// output_note_end_dropped_count, event_decode_error_count)` で返す（daemon の 1 Hz ticker が polling して WARNING event
    /// で surface する非 RT observability）。`outproc_health()`（effect 側）と同じ「1 tick = 1
    /// try_lock + 1 snapshot」設計 — child-process 系 3 signal と output-event overflow 系 3 signal を
    /// 1 accessor に統合し、同一 tick 内で `outproc_instrument` mutex を複数回 `try_lock` する
    /// 二重ロック（(a) 無駄なロック (b) 6 signal が同一スナップショットである保証の消失）を避ける。
    ///
    /// try_lock 方針は `outproc_health()` と同じ: **WouldBlock** は次 tick に持ち越すだけ
    /// （cumulative なので drop しない）、**Poisoned** は warn して real 分を 0/false に丸める
    /// （injected 分は失わない）。instrument 未起動 / outproc-instrument 無効時は injected 分のみ返す。
    #[cfg(feature = "outproc-instrument")]
    pub fn outproc_instrument_health(&self) -> (u64, u64, bool, u64, u64, u64, u64) {
        let injected_errors = self.outproc_instrument_child_errors.load(Ordering::Relaxed);
        let injected_respawns = self.outproc_instrument_respawns.load(Ordering::Relaxed);
        let injected_invalid = self
            .outproc_instrument_measurement_invalid
            .load(Ordering::Relaxed);
        let injected_dropped = self
            .outproc_instrument_output_dropped
            .load(Ordering::Relaxed);
        match self.outproc_instrument.try_lock() {
            // #540 P1: slot pool の cumulative counter を合算し bool は OR する（1 Hz ticker の
            // WARNING surface は「どこかの instrument child が悪い」で十分。instance 別の詳細は
            // `outproc_instrument_stats_for` で個別に引ける）。
            Ok(g) => g
                .as_ref()
                .map(|c| {
                    let mut totals = (0u64, 0u64, false, 0u64, 0u64, 0u64, 0u64);
                    for slot in &c.slots {
                        let s = slot.stats.snapshot();
                        totals.0 += s.child_process_error_count;
                        totals.1 += s.respawn_count;
                        totals.2 |= s.measurement_invalid;
                        totals.3 += s.output_event_dropped_count;
                        totals.4 += s.output_event_spilled_count;
                        totals.5 += s.output_note_end_dropped_count;
                        totals.6 += s.event_decode_error_count;
                    }
                    (
                        totals.0 + injected_errors,
                        totals.1 + injected_respawns,
                        totals.2 || injected_invalid,
                        totals.3 + injected_dropped,
                        totals.4,
                        totals.5,
                        totals.6,
                    )
                })
                .unwrap_or((
                    injected_errors,
                    injected_respawns,
                    injected_invalid,
                    injected_dropped,
                    0,
                    0,
                    0,
                )),
            Err(std::sync::TryLockError::WouldBlock) => (
                injected_errors,
                injected_respawns,
                injected_invalid,
                injected_dropped,
                0,
                0,
                0,
            ),
            Err(std::sync::TryLockError::Poisoned(_)) => {
                tracing::warn!(
                    "outproc instrument mutex poisoned; outproc_instrument_health reporting \
                     zeros for real stats (OUTPROC_INSTRUMENT_ERROR/_RESPAWN/_INVALID/ \
                     _OUTPUT_DROPPED events suppressed until daemon restart)"
                );
                (
                    injected_errors,
                    injected_respawns,
                    injected_invalid,
                    injected_dropped,
                    0,
                    0,
                    0,
                )
            }
        }
    }

    /// feature `outproc-instrument` 無効ビルド用の stub。本番は常に injected 分のみ（control が無い）。
    #[cfg(not(feature = "outproc-instrument"))]
    pub fn outproc_instrument_health(&self) -> (u64, u64, bool, u64, u64, u64, u64) {
        (
            self.outproc_instrument_child_errors.load(Ordering::Relaxed),
            self.outproc_instrument_respawns.load(Ordering::Relaxed),
            self.outproc_instrument_measurement_invalid
                .load(Ordering::Relaxed),
            self.outproc_instrument_output_dropped
                .load(Ordering::Relaxed),
            0,
            0,
            0,
        )
    }

    /// 全 LinkAudio channel の ring overflow drop（interleaved サンプル数）の累積合計（A4-2b-2b）。
    /// daemon の 1 Hz ticker が polling して増加を WARNING event で surface する（非 RT observability）。
    /// link 未初期化（test backend）時は control 分が 0。test 注入分（本番 0）を必ず加える。
    #[cfg(feature = "link-audio")]
    pub fn link_egress_ring_drops(&self) -> u64 {
        // try_lock で ticker をブロックしない。**WouldBlock**（callback / register との一時競合）は
        // 次 tick に持ち越すだけ — counter は cumulative なので drop は失われず後続 tick が全累積を
        // 報告する。**Poisoned** は以降ずっと control 分を 0 に固定し LINK_EGRESS_DROP を session 中
        // 抑制してしまうため、他アクセサ（`loaded_sample_count` 等）と同様 `warn!` で post-mortem の
        // 根拠を残す（contention と poison を `.ok()` で同一視しない）。
        let control_drops = match self.link.try_lock() {
            Ok(g) => g.as_ref().map(|ctl| ctl.total_ring_drops()).unwrap_or(0),
            Err(std::sync::TryLockError::WouldBlock) => 0,
            Err(std::sync::TryLockError::Poisoned(_)) => {
                tracing::warn!(
                    "link mutex poisoned; link_egress_ring_drops reporting 0 for control drops \
                     (LINK_EGRESS_DROP events suppressed until daemon restart)"
                );
                0
            }
        };
        control_drops + self.link_egress_drops.load(Ordering::Relaxed)
    }

    /// feature `link-audio` 無効ビルド用の stub。本番は常に 0（control が無い）。test 注入分のみ反映。
    #[cfg(not(feature = "link-audio"))]
    pub fn link_egress_ring_drops(&self) -> u64 {
        self.link_egress_drops.load(Ordering::Relaxed)
    }

    /// test harness 用: LinkAudio egress drop の注入カウンタを取得する。accessor の形（`Arc` clone を
    /// 返す）は `stream_stats_arc` と同じだが、下層 counter は本番経路から分離した注入専用（本番 0）。
    /// integration test から `fetch_add` して 1 Hz ticker の LINK_EGRESS_DROP 発火を駆動する。
    /// `#[doc(hidden)]` で公開 API としては扱わない。
    #[doc(hidden)]
    pub fn link_egress_drops_arc(&self) -> Arc<AtomicU64> {
        self.link_egress_drops.clone()
    }

    /// test harness 用: CLAP process error の注入カウンタを取得する。`link_egress_drops_arc` と同形で、
    /// 下層 counter は本番経路から分離した注入専用（本番 0）。integration test から `fetch_add` して
    /// 1 Hz ticker の CLAP_PROCESS_ERROR 発火を駆動する（plugin ロード不要）。`#[doc(hidden)]`。
    #[doc(hidden)]
    pub fn clap_process_errors_arc(&self) -> Arc<AtomicU64> {
        self.clap_process_errors.clone()
    }

    /// test harness 用: OOP effect `frames_clamped` の注入カウンタを取得する。`link_egress_drops_arc` /
    /// `clap_process_errors_arc` と同形で、下層 counter は本番経路から分離した注入専用（本番 0）。
    /// integration test から `fetch_add` して 1 Hz ticker の OUTPROC_EFFECT_FRAMES_CLAMPED 発火を
    /// 駆動する（child process 不要・#406）。`#[doc(hidden)]`。
    #[doc(hidden)]
    pub fn outproc_frames_clamped_arc(&self) -> Arc<AtomicU64> {
        self.outproc_frames_clamped.clone()
    }

    /// test harness 用: OOP instrument `output_event_dropped_count` の注入カウンタを取得する。
    /// `outproc_frames_clamped_arc` と同形で、下層 counter は本番経路から分離した注入専用（本番 0）。
    /// integration test から `fetch_add` して 1 Hz ticker の OUTPROC_INSTRUMENT_OUTPUT_DROPPED 発火を
    /// 駆動する（instrument child process 不要・PR #422 round 2）。`#[doc(hidden)]`。
    #[doc(hidden)]
    pub fn outproc_instrument_output_dropped_arc(&self) -> Arc<AtomicU64> {
        self.outproc_instrument_output_dropped.clone()
    }

    /// test harness 用: OOP instrument `child_process_error_count` の注入カウンタを取得する。
    /// `outproc_instrument_output_dropped_arc` と同形で、下層 counter は本番経路から分離した注入専用
    /// （本番 0）。integration test から `fetch_add` して 1 Hz ticker の OUTPROC_INSTRUMENT_ERROR 発火を
    /// 駆動する（instrument child process 不要・PR #422 round 3）。`#[doc(hidden)]`。
    #[doc(hidden)]
    pub fn outproc_instrument_child_errors_arc(&self) -> Arc<AtomicU64> {
        self.outproc_instrument_child_errors.clone()
    }

    /// test harness 用: OOP instrument `respawn_count` の注入カウンタを取得する。
    /// `outproc_instrument_child_errors_arc` と同形。integration test から `fetch_add` して 1 Hz
    /// ticker の OUTPROC_INSTRUMENT_RESPAWN 発火を駆動する（PR #422 round 3）。`#[doc(hidden)]`。
    #[doc(hidden)]
    pub fn outproc_instrument_respawns_arc(&self) -> Arc<AtomicU64> {
        self.outproc_instrument_respawns.clone()
    }

    /// test harness 用: OOP instrument `measurement_invalid` の注入フラグを取得する。数値カウンタ
    /// 系の `_arc()` getter と異なり `AtomicBool` を返すが、同じ「本番経路から分離した注入専用
    /// （本番 false）」設計。integration test から `store(true, ..)` して 1 Hz ticker の
    /// OUTPROC_INSTRUMENT_INVALID fire-once 発火を駆動する（PR #422 round 3）。`#[doc(hidden)]`。
    #[doc(hidden)]
    pub fn outproc_instrument_measurement_invalid_arc(&self) -> Arc<AtomicBool> {
        self.outproc_instrument_measurement_invalid.clone()
    }

    /// test harness 用: `StreamStats` への参照を取得し、外部から
    /// xrun / device_lost を駆動できるようにする。
    ///
    /// 外部 crate (`tests/`) から呼ぶ必要があるため `pub` だが、
    /// `#[doc(hidden)]` で rustdoc からは不可視にし公開 API としては扱わない。
    #[doc(hidden)]
    pub fn stream_stats_arc(&self) -> Arc<StreamStats> {
        self.stream_stats.clone()
    }

    pub fn uptime_sec(&self) -> f64 {
        self.started_at.elapsed().as_secs_f64()
    }

    /// 現在スケジュール中の（まだ完了していない）再生イベント数。
    /// audio callback がロックを握っている瞬間は取得できないので、その場合は 0 を返す。
    pub fn active_play_count(&self) -> usize {
        self.engine.active_count().unwrap_or(0)
    }

    pub fn output_sample_rate(&self) -> u32 {
        self.stream_config_snapshot().sample_rate
    }

    /// 現在の出力ストリーム時刻（scheduler transport 秒）。`play_at` の `time_sec` と同一座標系。
    /// ロック競合時は `None`（callback がロック保持中）。
    pub fn now_sec(&self) -> Option<f64> {
        self.engine.now_sec()
    }

    /// `Engine::lock_contention_count` の delegate（詳細はそちら参照）。daemon の 1 Hz ticker が
    /// polling する（#401）。
    pub fn engine_lock_contention_count(&self) -> u64 {
        self.engine.lock_contention_count()
    }

    /// `Engine::is_lock_poisoned` の delegate（詳細はそちら参照）。daemon の 1 Hz ticker が
    /// polling して fire-once の FATAL event を出す（#401）。
    pub fn engine_lock_poisoned(&self) -> bool {
        self.engine.is_lock_poisoned()
    }

    /// test harness 用: `Engine::contention_count_arc` の delegate。integration test から
    /// `fetch_add` して 1 Hz ticker の `ENGINE_LOCK_CONTENTION` WARNING 発火を駆動する
    /// （`link_egress_drops_arc` と同様の注入 seam・`#[doc(hidden)]`）。
    #[doc(hidden)]
    pub fn engine_lock_contention_arc(&self) -> Arc<AtomicU64> {
        self.engine.contention_count_arc()
    }

    /// test harness 用: `Engine::poisoned_arc` の delegate。integration test から `store(true, ..)`
    /// して 1 Hz ticker の `ENGINE_LOCK_POISONED` FATAL 発火を、実際に Mutex を panic-poison させずに
    /// 駆動する（`#[doc(hidden)]`）。
    #[doc(hidden)]
    pub fn engine_lock_poisoned_arc(&self) -> Arc<AtomicBool> {
        self.engine.poisoned_arc()
    }

    pub fn output_channels(&self) -> u16 {
        self.stream_config_snapshot().channels
    }
}
