//! Audio-thread RT プロセッサ: engine render 後のバッファに CLAP plugin を適用する。
//! instrument 型（parallel）は add-mix (+=)、effect 型（serial insert）は overwrite (=) で
//! hardware sum を変換する。経路は `HostAudioBuffers::has_audio_input` で分岐（PR2・Issue #340）。
//!
//! orbit-clap-spike の audio.rs（OrbitAudioProcessor）から移植・再設計。主な変更点:
//! - `Engine` と `PostMixSink` を削除: data は engine render 済みで渡される（PostProcessor seam）。
//! - `Arc<AudioThreadStats>` を `Arc<ClapProcessorStats>` に置換（callback timing は
//!   native の CallbackTimeStats が担う）。
//! - `impl orbit_audio_native::PostProcessor for ClapPostProcessor` を実装。
//! - carry-forward #2: `callback_requested` は Arc<AtomicBool> で lock-free（host.rs 参照）。
//! - carry-forward #3: `event_scratch` は ring capacity でサイズを固定し RT realloc を防ぐ。

use crate::buffers::HostAudioBuffers;
use crate::events::{drain_to_event_buffer, PluginEventConsumer};
use crate::host::OrbitClapHost;

use clack_host::events::io::{EventBuffer, InputEvents};
use clack_host::prelude::{OutputEvents, StartedPluginAudioProcessor};
use orbit_audio_native::PostProcessor;

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;

/// audio thread から更新し、制御スレッド（daemon ticker）が読む統計。
///
/// callback timing の計測は `orbit_audio_native::CallbackTimeStats` が担う。
/// ここは CLAP plugin 固有の統計のみを保持する。
pub struct ClapProcessorStats {
    /// plugin.process() がエラーを返した回数。
    /// plugin が毎ブロックでエラーを返してもサイレントにならないようカウントする。
    pub process_error_count: AtomicU64,
    /// hot-install が着地した callback 番号（u64::MAX = 未 install）。
    pub installed_at_callback: AtomicU64,
    /// post-mix ピーク振幅のビット表現（f32::to_bits）。
    /// 非負 f32 のビットパターンは符号なし整数として単調なので atomic fetch_max が使える。
    pub post_peak_bits: AtomicU32,
    /// この processor が process() された回数。
    pub callback_count: AtomicU64,
}

impl ClapProcessorStats {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            process_error_count: AtomicU64::new(0),
            installed_at_callback: AtomicU64::new(u64::MAX), // u64::MAX = 未インストール
            post_peak_bits: AtomicU32::new(0),
            callback_count: AtomicU64::new(0),
        })
    }

    /// post-mix peak を 0 にリセットする。`post_peak_bits` は `fetch_max` で累積するため、
    /// effect 検証の two-phase 計測（plugin 無し baseline → plugin 有り）で位相を分けるのに使う。
    /// audio thread の `fetch_max` と並行しても安全（store 後に audio thread が halved peak を
    /// 積み直す）。test harness 専用 seam。
    pub fn reset_post_peak(&self) {
        self.post_peak_bits.store(0, Ordering::Relaxed);
    }
}

/// 制御スレッド → audio thread への hot-install ペイロード。
///
/// 全フィールドは `Send` かつ制御スレッドで事前確保済み。callback 内でのインストールは
/// plain move のみ（alloc / lock なし）。
pub struct InstallMsg {
    /// 起動済みプラグイン audio processor（`Send`; audio thread へ引き渡す）。
    pub plugin: StartedPluginAudioProcessor<OrbitClapHost>,
    /// プラグイン用オーディオバッファ（制御スレッドで事前確保）。
    pub buffers: HostAudioBuffers,
    /// note 入力ポートインデックス。
    pub note_port_index: u16,
}

/// install ring の consumer 側（audio thread が保持）。
pub type InstallConsumer = rtrb::Consumer<InstallMsg>;

/// install ring に残った全アイテムを pop して drop する（#342-#1）。
///
/// teardown 時に未ドレインの [`InstallMsg`]（= [`StartedPluginAudioProcessor`] を内包）が ring に
/// 残ると、それが保持する `Arc<PluginInstanceInner>` のために host 側の `PluginInstance::Drop` が
/// sole owner になれず、clack が wrong-thread teardown を避けて instance を **leak** する
/// （deactivate/destroy が永久に呼ばれない）。ここで drop して Arc を解放すれば、`host.shutdown()` 時に
/// `PluginInstance::Drop` が sole owner となり stop_processing+deactivate+destroy を clap スレッド
/// （= start_processing と同一スレッド）で正常実行できる。
///
/// `InstallMsg`（内包する `StartedPluginAudioProcessor` も）は custom `Drop` を持たないため、drop は
/// `Arc<PluginInstanceInner>` の refcount 減算と `HostAudioBuffers` の free だけで plugin code を呼ばない。
/// この「Arc 減算のみ」は **ordering 依存の不変条件**である: StreamGuard の field drop 順
/// （`_clap_teardown` → `_stream` → `_clap_thread`）と teardown_requested/teardown_done フラグにより本 drain は
/// 必ず `host.shutdown()` より前に走り、その時点で host 側 `PluginInstance` が同じ Arc を保持し続けている。
/// よって audio スレッドの drop で refcount が 0 に達することはなく、`PluginInstanceInner::Drop`
/// （= 実 deactivate/destroy）はここでは走らない。buffer free は teardown 経路なので許容する（既存の
/// `buffers = None` と同性質）。`Consumer<T>` で generic にして real plugin 無しで単体テストできる。
///
/// **スコープ外の corner（#342 項目4 で追跡）**: clap スレッドが plugin load 中に panic した場合は
/// 上の不変条件が崩れる。host.instance が unwind で drop された後（refcount は ring 残存分で 0 非到達）に
/// 本 drain が Arc を 0 まで減算すると、`PluginInstanceInner::Drop`（実 deactivate/destroy）が audio(RT)
/// スレッドで走りうる。drain なし版でも同 corner で deactivate は wrong-thread（install_rx drop = 非 RT の
/// daemon スレッド）で走るので「deactivate が呼ばれない」のではなく、**drain 導入で wrong-thread の質が
/// main→RT に変わる**新挙動である。正常 teardown 経路では発生せず、既存の panic-時 leak 病理に乗る極稀
/// ケースのため #342-#1 のスコープ外とし、#342 項目4 として追跡する。
fn drain_install_ring<T>(rx: &mut rtrb::Consumer<T>) {
    while rx.pop().is_ok() {}
}

/// CLAP plugin を 1 ブロック適用する共有カーネル（A0 §4.1 step d/f）。
///
/// daemon RT 経路（[`ClapPostProcessor::process`]）と γ child / offline parity の
/// [`crate::effect::ClapEffectProcessor`] が**同一の音響処理**を使うよう、両者の core をここに集約する
/// （設計 doc §4.4）。`buffers.has_audio_input()` で effect（serial insert = overwrite）/
/// instrument（parallel = add-mix）を分岐する。
///
/// 戻り値は `plugin.process()` が成功したか（`process_error_count` 等の統計更新は呼び出し側の責務）。
/// `#[must_use]`: 戻り値を握り潰すと plugin の毎ブロックエラーが不可視になる（silent-failure 防止）。
/// 出力配線は **成功時のみ**: 失敗時は `data`（engine render 済み dry 信号）を素通しする
/// （effect で失敗時に上書きすると 1 ブロック無音化する・code-review #340）。
///
/// RT 安全: alloc / lock / syscall なし（`buffers` は事前確保済み・`input_events` は呼び出し側が用意）—
/// ただし `BufferSize::Fixed` 契約が守られている場合のみ。契約違反時の resize / eprintln path は
/// `buffers::ensure_buffer_size_matches` 参照（本来 RT 違反だが Fixed 経路では到達しない）。
#[must_use]
pub(crate) fn process_block_core(
    plugin: &mut StartedPluginAudioProcessor<OrbitClapHost>,
    buffers: &mut HostAudioBuffers,
    steady: &mut u64,
    input_events: &InputEvents,
    data: &mut [f32],
) -> bool {
    // plugin バッファサイズを確認する（BufferSize::Fixed なら zero-cost）。
    buffers.ensure_buffer_size_matches(data.len());
    let frame_count = buffers.cpal_buf_len_to_frame_count(data.len());

    // effect: engine 出力を plugin 入力へ流す。instrument: 入力を無音にする。
    let is_effect = buffers.has_audio_input();
    if is_effect {
        buffers.set_input_from_interleaved(data);
    } else {
        buffers.set_input_silent();
    }
    let (ins, mut outs) = buffers.prepare_plugin_buffers(data.len());

    let process_ok = plugin
        .process(
            &ins,
            &mut outs,
            input_events,
            &mut OutputEvents::void(),
            Some(*steady),
            None,
        )
        .is_ok();

    // 出力配線は process 成功時のみ。effect は overwrite（serial insert）、instrument は add-mix。
    if process_ok {
        if is_effect {
            buffers.replace_cpal_buffer(data);
        } else {
            buffers.add_to_cpal_buffer(data);
        }
    }

    // steady counter を進める（A0 §4.1 step f）。
    *steady += frame_count as u64;
    process_ok
}

/// `orbit_audio_native::PostProcessor` を実装する CLAP audio-thread オーナー。
///
/// cpal closure（`move |data, _| proc.process(data)`）が所有し、audio thread 上で排他的に動く。
/// `plugin` / `buffers` は `Option` で、stream がエンジンのみで動いてから plugin が
/// install される（static: stream 前に install / hot-install: install ring 経由）。
pub struct ClapPostProcessor {
    /// CLAP plugin audio processor（install されるまでは None）。
    plugin: Option<StartedPluginAudioProcessor<OrbitClapHost>>,
    /// lock-free event ring consumer（A0 §4.2）。
    event_consumer: PluginEventConsumer,
    /// CLAP event バッファ（毎 callback クリア・再利用）。carry-forward #3: ring capacity で
    /// 事前サイズ確保し、1回のフルドレインで realloc しないことを保証する。
    event_scratch: EventBuffer,
    /// plugin 用オーディオバッファ（install と同時に着地）。None = 未インストール。
    buffers: Option<HostAudioBuffers>,
    /// steady sample counter（A0 §4.1 step f）。
    steady_counter: u64,
    /// note ポートインデックス（install 時に設定）。
    note_port_index: u16,
    /// 統計（制御スレッドが読む）。
    stats: Arc<ClapProcessorStats>,
    /// hot-install ring（制御スレッド → audio thread）。plugin が None のときのみ pop する。
    install_rx: InstallConsumer,
    /// event ring の capacity（carry-forward #3: debug_assert 用）。
    event_ring_cap: usize,
    /// carry-forward #1: teardown 要求フラグ（daemon → audio thread）。stream を止める前に
    /// daemon がこれを立てると、**audio thread の callback 内で** `stop_processing()` を呼んで
    /// plugin を停止・drop する（CLAP 仕様: stop_processing は audio thread で呼ぶ。暗黙 Drop は
    /// stream drop 時に別スレッドで走り strict plugin で UB＝A0 §13 #1）。
    teardown_requested: Arc<AtomicBool>,
    /// carry-forward #1: teardown 完了フラグ（audio thread → daemon）。callback が stop_processing を
    /// 終えたら立てる。daemon はこれを待ってから stream を drop する（plugin は既に None なので
    /// closure drop で wrong-thread stop_processing が走らない）。
    teardown_done: Arc<AtomicBool>,
}

impl ClapPostProcessor {
    /// 新規作成。`event_ring_capacity` は EventBuffer の初期確保サイズと debug_assert に使う。
    /// `teardown_requested` / `teardown_done` は carry-forward #1 用の協調フラグ（`new_clap_host`
    /// が生成し、daemon 側にも clone を渡す）。
    pub fn new(
        event_consumer: PluginEventConsumer,
        install_rx: InstallConsumer,
        stats: Arc<ClapProcessorStats>,
        event_ring_capacity: usize,
        teardown_requested: Arc<AtomicBool>,
        teardown_done: Arc<AtomicBool>,
    ) -> Self {
        Self {
            plugin: None,
            event_consumer,
            // carry-forward #3: ring capacity でサイズを固定し、フルドレインでも realloc しない。
            event_scratch: EventBuffer::with_capacity(event_ring_capacity),
            buffers: None,
            steady_counter: 0,
            note_port_index: 0,
            stats,
            install_rx,
            event_ring_cap: event_ring_capacity,
            teardown_requested,
            teardown_done,
        }
    }

    /// plugin を install する（static モード: stream 構築前に制御スレッドから呼ぶ）。
    pub fn install(&mut self, msg: InstallMsg) {
        self.plugin = Some(msg.plugin);
        self.buffers = Some(msg.buffers);
        self.note_port_index = msg.note_port_index;
    }
}

impl Drop for ClapPostProcessor {
    /// carry-forward #1 の最終検知点（code-review #340 B）。正常な teardown では process() の
    /// teardown 分岐が plugin を None にしてからこの Drop（stream drop = daemon thread・非 RT）が走る。
    /// plugin を保持したまま drop された場合、`StartedPluginAudioProcessor` の暗黙 drop が wrong-thread で
    /// stop_processing/deactivate を呼ぶ＝CLAP 仕様違反（strict plugin で UB）。device 喪失で audio thread が
    /// 止まり `ClapTeardownGuard` が timeout した等で到達しうる。device 喪失時の防止は構造上不可能だが、
    /// loud に error ログを出して検知可能にする。
    fn drop(&mut self) {
        if self.plugin.is_some() {
            tracing::error!(
                "ClapPostProcessor が plugin 保持のまま drop された — teardown 未完了で \
                 wrong-thread stop_processing の可能性（device 喪失で callback 停止 → teardown timeout か）"
            );
        }
        // 同じ leak クラスの非対称な見落としを塞ぐ（#342-#1）。正常 teardown では install ring は
        // drain 済みのはず。非空で drop される = teardown 分岐後に install が届いたか、device 喪失で
        // 分岐自体が走らなかった可能性（drain せず検知のみ＝ここでの drain 可否は clack の Drop 挙動
        // 検証後に判断・defer）。slots() で残数を出して transient な 1 件か飽和かを見分けられるようにする。
        let pending = self.install_rx.slots();
        if pending > 0 {
            tracing::error!(
                "ClapPostProcessor が非空 (slots={pending}) の install ring を保持したまま drop された — \
                 teardown 分岐後の install 到着か device 喪失で、未 install の plugin instance が leak した可能性"
            );
        }
    }
}

impl PostProcessor for ClapPostProcessor {
    /// `data` は engine が既に render 済みの interleaved f32。
    ///
    /// engine.render は **呼ばない**（native callback が render 後にこの seam を呼ぶ）。plugin 型で
    /// 出力配線が分岐する（PR2・Issue #340）:
    /// - effect（`has_audio_input`=true）: `data` を plugin 入力へ de-interleave し、plugin 出力で
    ///   `data` を上書きする（serial insert = replace / `=`）。
    /// - instrument（`has_audio_input`=false）: plugin 入力を無音にし、plugin 出力を `data` に
    ///   add-mix する（parallel = `+=` / A0 §4.1 step d）。
    ///
    /// plugin.process() が失敗したブロックでは出力配線をスキップし `data` を dry のまま通す。
    fn process(&mut self, data: &mut [f32]) {
        // carry-forward #1: teardown 要求が来たら、**この audio thread で** plugin を stop_processing
        // してから drop する（暗黙 Drop は stream drop 時に別スレッドで走り CLAP 違反＝strict plugin で
        // UB）。stop_processing は Started → Stopped に消費し、Stopped の drop は benign。以降の callback
        // は plugin=None で早期 return（data は engine render 済みのまま素通し）。冪等。
        if self.teardown_requested.load(Ordering::Acquire) {
            if let Some(p) = self.plugin.take() {
                let _ = p.stop_processing();
            }
            self.buffers = None;
            // #342-#1: install ring に未ドレインの InstallMsg が残っていると、その
            // StartedPluginAudioProcessor の Arc が ring 越しに生き続け、host.shutdown() で
            // PluginInstance::Drop が sole owner になれず instance を leak する。ここで drain して
            // Arc を解放し、clap スレッドでの正常 teardown を可能にする（drain_install_ring の doc 参照）。
            drain_install_ring(&mut self.install_rx);
            self.teardown_done.store(true, Ordering::Release);
            return;
        }

        // hot-install: plugin が未インストールなら install ring を確認する（pop は wait-free）。
        if self.plugin.is_none() {
            if let Ok(msg) = self.install_rx.pop() {
                self.install(msg);
                // installed_at_callback: hot-install が着地した callback 番号を記録。
                let at = self.stats.callback_count.load(Ordering::Relaxed);
                self.stats
                    .installed_at_callback
                    .store(at, Ordering::Relaxed);
            }
        }

        // plugin パス（インストール済みの場合のみ）。
        if let (Some(plugin), Some(buffers)) = (self.plugin.as_mut(), self.buffers.as_mut()) {
            // rtrb ring → CLAP InputEvents（block-start offset, A0 §4.2）。
            drain_to_event_buffer(
                &mut self.event_consumer,
                &mut self.event_scratch,
                self.note_port_index,
            );
            // carry-forward #3: event_scratch は ring capacity でサイズ固定。future の変更で
            // ring が大きくなるか PluginEvent が複数の CLAP event を生む場合、debug build で検出。
            debug_assert!(
                self.event_scratch.len() as usize <= self.event_ring_cap,
                "event_scratch が ring capacity を超えた — audio thread で realloc が発生する"
            );
            let input_events = self.event_scratch.as_input();

            // effect（serial insert = overwrite）/ instrument（parallel = add-mix）の経路分岐と 1-block
            // process は共有カーネルに委譲する（γ child / parity の ClapEffectProcessor と同一の音響処理・
            // 設計 §4.4）。process_block_core が入出力配線（成功時のみ）と steady 更新まで行い、
            // process 成功可否を返す。
            let process_ok = process_block_core(
                plugin,
                buffers,
                &mut self.steady_counter,
                &input_events,
                data,
            );

            // エラーはサイレントに無視できない: 毎ブロックでエラーを返す plugin が見えなくなるため、
            // process_error_count でカウントする（RT 安全: atomic のみ）。
            if !process_ok {
                self.stats
                    .process_error_count
                    .fetch_add(1, Ordering::Relaxed);
            }
        } else {
            // plugin 未インストール: ring の note をドレイン&破棄（ring が詰まらないように）。
            while self.event_consumer.pop().is_ok() {}
        }

        // callback_count を更新する（hot-install の着地タイミング記録に使う）。
        self.stats.callback_count.fetch_add(1, Ordering::Relaxed);

        // post-mix ピーク更新: abs max を atomic fetch_max で記録。
        // 非負 f32 のビットパターンは符号なし整数として単調なので fetch_max が正しく機能する。
        let peak_bits = data.iter().map(|s| s.abs().to_bits()).max().unwrap_or(0);
        self.stats
            .post_peak_bits
            .fetch_max(peak_bits, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn post_peak_tracks_abs_max_and_resets() {
        // post_peak_bits の不変条件: 非負 f32 の to_bits は u32 として単調なので fetch_max が
        // abs ピークを正しく追える。reset_post_peak（two-phase 計測の位相分離）も検証する。
        let stats = ClapProcessorStats::new();
        let record = |v: f32| {
            stats
                .post_peak_bits
                .fetch_max(v.abs().to_bits(), Ordering::Relaxed);
        };

        record(0.1);
        record(0.5);
        record(0.3); // 0.5 を超えない
        let peak = f32::from_bits(stats.post_peak_bits.load(Ordering::Relaxed));
        assert!(
            (peak - 0.5).abs() < 1e-6,
            "abs max は 0.5 のはず, got {peak}"
        );

        // reset で 0 に戻る。
        stats.reset_post_peak();
        assert_eq!(stats.post_peak_bits.load(Ordering::Relaxed), 0);

        // reset 後は新しいピークを追い直す（baseline 汚染なし）。
        record(0.2);
        let peak2 = f32::from_bits(stats.post_peak_bits.load(Ordering::Relaxed));
        assert!((peak2 - 0.2).abs() < 1e-6, "reset 後は 0.2, got {peak2}");
    }

    #[test]
    fn drain_install_ring_drops_all_pending_and_empties() {
        // #342-#1: drain は ring 内の全アイテムを pop して **drop** し（= Arc 解放）、ring を空にする。
        // InstallMsg は real plugin 無しでは作れないので、Drop を数える generic な代用型で検証する。
        // 注意: これは drain 関数の契約（drop-all + empty）の検証であって、実 leak シナリオ
        // （teardown-before-install で real plugin の deactivate が正しいスレッドに乗る）は real plugin +
        // 非決定的 race を要するため自動テスト不可。後者は gated 実機テスト（正常経路）とソース根拠でカバーする。
        static DROPS: AtomicU64 = AtomicU64::new(0);
        struct DropCounter;
        impl Drop for DropCounter {
            fn drop(&mut self) {
                DROPS.fetch_add(1, Ordering::Relaxed);
            }
        }

        let (mut tx, mut rx) = rtrb::RingBuffer::<DropCounter>::new(4);
        tx.push(DropCounter).expect("push 1");
        tx.push(DropCounter).expect("push 2");

        drain_install_ring(&mut rx);

        // DROPS==2（2 件とも drop = Arc 解放）+ ring 空 で「2 件すべて drain した」を等価に保証する。
        assert_eq!(
            DROPS.load(Ordering::Relaxed),
            2,
            "drain したアイテムは drop されて Arc が解放されるはず"
        );
        assert!(rx.pop().is_err(), "drain 後の ring は空のはず");

        // empty-ring（最頻パス: install 済みで teardown 時に ring は既に空）も no-op で空のまま。
        let (_tx2, mut empty_rx) = rtrb::RingBuffer::<DropCounter>::new(4);
        drain_install_ring(&mut empty_rx);
        assert!(empty_rx.pop().is_err(), "空 ring を drain しても空のまま");
    }
}
