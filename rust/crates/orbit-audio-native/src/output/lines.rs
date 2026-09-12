//! オーディオラインの機構（master line / line slot / insert bus stage）（#888 子 2・output.rs）。
//!
//! 🔴 **これは純粋な移動である。** `output.rs` からそのまま移した。
//! 本文は 1 行も書き換えていない。

#[allow(unused_imports)]
use super::*;

pub struct MasterLine {
    /// 全 stage の Master 宛て出口が加算される 2ch バッファ（zero-fill は callback 冒頭・
    /// `render_engine_with_sources` に core の `hardware_out` として渡す）。事前確保のみ・RT では
    /// resize しない（`InsertBusStage::ensure_buffer_len` と同じ規律）。
    pub(super) buffer: Vec<f32>,
    /// Bus-line `Device` outputs bypass the master rack/gain and accumulate here until master
    /// placement is complete. It is sized on the control thread and zero-filled per callback.
    pub(super) direct_device_buffer: Vec<f32>,
    /// master ラック（今日の `post`）。CLAP effect/instrument（Issue #340）。engine render 後の
    /// **master.buffer（常に 2ch）**を in-place 変換する（デバイス幅とは無関係）。
    pub(super) post: Option<Box<dyn PostProcessor>>,
    /// control（`SetGlobalGain`）が書き込む目標ゲイン（線形振幅・f32 bits）。RT は Relaxed load
    /// のみ（`InsertBusStage::send_gain_overrides` と同じ atomic gain パターン）。core の
    /// `Engine::set_global_gain` は production では呼ばない — 乗算経路をここ 1 本にする
    /// （§5.4「経路が 1 本になった」）。
    pub(super) gain_target: Arc<AtomicU32>,
    /// RT が block ごとに `gain_target` へ寄せていく現在値（RT 専有・非 atomic）。
    pub(super) gain_current: f32,
    /// 5ms 相当のフレーム数（**構築時に** sample_rate から算出。`advance_gain` の分母）。
    pub(super) ramp_frames: u32,
    /// `SetBusLine("master", ...)` が publish する汎用 program。未 publish の間は固定互換経路を
    /// 実行し、既存譜面の bit-level 出力を保つ。
    ///
    /// 🔴 **ここに書いてある既定 program は RT では一度も実行されない。** `explicit_line` が
    /// `false` の間は `render_block_with_sources` が固定互換経路の側へ分岐し、`true` になるのは
    /// control が program を publish した後だからである（publish された時点で中身は control 側の
    /// 値に置き換わっている）。`engine_wrap.rs` の `default_master_line_program` が
    /// `output_channels` を見て `right` を出し分けるのに対しここが `Some(1)` 固定なのは、
    /// **この値が使われないため**であって不整合ではない。
    pub(super) line: LineSlot,
    /// control が master program を **一度でも publish したか**（不可逆）。`line` の中身からは
    /// 導出できない（RT で既定値と深い比較をすることになり、かつ「既定と同じ program を明示的に
    /// publish した」場合を区別できない）。
    ///
    /// 名前は「明示的な line が入ったか」の意であり、`SetGlobalGain` の atomic 更新では変わらない。
    ///
    /// 🔴 **いつこの分岐を消せるか**: PR-O4 で TS の `global.gain()` が
    /// `SetBusLine("master", …)` を送る新表面へ切り替わり、その経路が実機で確かめられ、PR-O6 で
    /// 旧 `SetBusRouting` 系が撤去された後。そこで固定互換経路と本フラグを同時に削り、
    /// `execute_master_line` の 1 本にできる見込みである。
    pub(super) explicit_line: Arc<AtomicBool>,
}

impl MasterLine {
    /// `ramp_frames` を sample_rate から**構築時に**算出する（RT では計算しない）。
    ///
    /// 🔴 `output_channels` を取るのは、初期 program を `default_master_line_ops` の 1 箇所から
    /// 作るため（同関数の doc を参照）。デバイス幅を知らずに `right: Some(1)` を固定していた
    /// のが、shadow との食い違いと 1ch デバイスでの範囲外アクセスの両方の原因だった。
    pub fn new(
        sample_rate: u32,
        output_channels: u16,
        post: Option<Box<dyn PostProcessor>>,
    ) -> Self {
        let ramp_frames = ((sample_rate as f64 * 0.005).round() as u32).max(1);
        Self {
            buffer: Vec::new(),
            direct_device_buffer: Vec::new(),
            post,
            gain_target: Arc::new(AtomicU32::new(1.0_f32.to_bits())),
            gain_current: 1.0,
            ramp_frames,
            line: LineSlot::new(LineProgram::settled(default_master_line_ops(
                output_channels,
            ))),
            explicit_line: Arc::new(AtomicBool::new(false)),
        }
    }

    /// callback block は通常これより遥かに短い。RT hot path の resize を構造的に排除する
    /// （`InsertBusStage::ensure_buffer_len` と同じ意図）。
    pub(super) fn ensure_buffer_len(&mut self, len: usize) {
        ensure_audio_buffer_len(&mut self.buffer, len);
        // Existing unit-level render seams use a 2ch hardware buffer of the same length.
        ensure_audio_buffer_len(&mut self.direct_device_buffer, len);
    }

    pub(super) fn ensure_device_buffer_len(&mut self, len: usize) {
        ensure_audio_buffer_len(&mut self.direct_device_buffer, len);
    }

    /// control 側（`EngineWrap::set_global_gain`）が保持する書き込みハンドル。RT はここへは
    /// 触れない（Arc の clone は非 RT の起動シーケンスで 1 回だけ行う）。
    pub fn gain_target_handle(&self) -> Arc<AtomicU32> {
        self.gain_target.clone()
    }

    pub fn line_program_installer(&self) -> LineProgramInstaller {
        let control = self.line.line_control();
        let current = control.clone();
        let explicit = self.explicit_line.clone();
        LineProgramInstaller::new(
            move |program, bus_index, bus_count| {
                control.install_for_bus(program, bus_index, bus_count)?;
                explicit.store(true, Ordering::Release);
                Ok(())
            },
            move || current.current_gains(),
        )
    }

    /// 1 block 分ランプを進め、その block に適用する ramp を返す（設計 §5.3 `ramp()`）。
    /// `current += (target - current) * min(1, frames / ramp_frames)`。RT: atomic load 1 回 +
    /// 算術のみ（alloc/lock/syscall なし）。
    #[inline]
    pub(super) fn advance_gain(&mut self, frames: usize) -> LineRamp {
        let target = f32::from_bits(self.gain_target.load(Ordering::Relaxed));
        advance_line_ramp(&mut self.gain_current, target, frames, self.ramp_frames)
    }
}

/// Mutable callback state which must survive a cpal stream rebuild (notably
/// out-of-process processor adapters). The callback uses one `try_lock`; a
/// concurrent control-plane rebuild produces a silent block instead of ever
/// blocking an audio thread.
pub struct RenderState {
    pub(super) link: Option<LinkEgress>,
    pub(super) insert_buses: Vec<InsertBusStage>,
    pub(super) sources: Vec<SourceSlot>,
    pub(super) transport: BlockTransport,
    pub(super) master: MasterLine,
}

/// One callback's transport snapshot passed to block sources.
#[derive(Debug, Clone, Copy)]
pub struct BlockTransport {
    pub cursor_frames: u64,
    pub sample_rate: u32,
}

/// A callback-owned source which renders one or more interleaved output units.
pub trait BlockSource: Send {
    fn render(&mut self, frames: usize, transport: &BlockTransport) -> usize;
    fn output(&self, unit: usize) -> &[f32];
}

/// Destination of one source output unit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SourceDest {
    /// Explicit silent sink: the source renders, but no output receives its signal.
    #[default]
    None,
    Master,
    Bus(usize),
    Link(usize),
}

/// Atomic routing cell shared by the callback and the control plane.
#[derive(Clone)]
pub struct SourceDestCell(pub(super) Arc<AtomicUsize>);

impl SourceDestCell {
    const MASTER: usize = 0;
    const BUS_BASE: usize = 1;
    const LINK_BASE: usize = Self::BUS_BASE + MAX_INSERT_BUS_STAGES;
    const END: usize = Self::LINK_BASE + MAX_LINK_CHANNELS;
    // #883 §2.6: the previously-unused END code is the one atomic representation of silence.
    const NONE: usize = Self::END;

    pub fn new(dest: SourceDest) -> Self {
        Self(Arc::new(AtomicUsize::new(Self::encode(dest))))
    }

    #[inline]
    pub fn load(&self) -> SourceDest {
        Self::decode(self.0.load(Ordering::Relaxed))
    }

    #[inline]
    pub fn store(&self, dest: SourceDest) {
        self.0.store(Self::encode(dest), Ordering::Relaxed);
    }

    pub(super) fn encode(dest: SourceDest) -> usize {
        match dest {
            SourceDest::None => Self::NONE,
            SourceDest::Master => Self::MASTER,
            SourceDest::Bus(index) if index < MAX_INSERT_BUS_STAGES => Self::BUS_BASE + index,
            SourceDest::Link(index) if index < MAX_LINK_CHANNELS => Self::LINK_BASE + index,
            SourceDest::Bus(_) | SourceDest::Link(_) => {
                // 🔴 §2.6 は「表現できない routing は無音」だが、**仕様上の無音と不変条件違反は
                // 区別が付かなければならない**。`[profile.release]` は `debug-assertions` を
                // 上書きしていない（既定 false）ので、`debug_assert!` は出荷ビルドから消える。
                // それだけだと「原因不明の無音」になり、ライブ中に書き忘れとの区別が付かない。
                // `encode` は制御プレーン（`set_source_routing` の JSON-RPC ハンドラと
                // instrument の差し替え / 解放）からしか呼ばれないので stderr に書いてよい。
                // 🔴 RT から `store()` を呼ぶ経路を足すなら、この行を先に畳むこと。
                #[cfg(not(test))]
                {
                    eprintln!(
                        "[output] source destination was not validated: {dest:?} — routing to silence"
                    );
                    debug_assert!(false, "source destination was not validated");
                }
                Self::NONE
            }
        }
    }

    /// 🔴 `decode` は RT コールバック（`collect_source_feeds`）から呼ばれるので、不正値でも
    /// **ログを出さない**。唯一の書き手である `encode` が制御プレーン側で痕跡を残すため、
    /// ここが黙って `None` に倒れても原因を追える。
    pub(super) fn decode(value: usize) -> SourceDest {
        match value {
            Self::NONE => SourceDest::None,
            Self::MASTER => SourceDest::Master,
            value if value < Self::LINK_BASE => SourceDest::Bus(value - Self::BUS_BASE),
            value if value < Self::END => SourceDest::Link(value - Self::LINK_BASE),
            _ => SourceDest::None,
        }
    }
}

impl Default for SourceDestCell {
    fn default() -> Self {
        Self::new(SourceDest::default())
    }
}

/// A preallocated source and the routing destination of each output unit.
pub struct SourceSlot {
    pub source: Box<dyn BlockSource>,
    pub dests: Vec<SourceDestCell>,
}

/// callback が同時に egress できる LinkAudio channel の上限（A4-2b-2b）。RT callback の per-block
/// stack `ArrayVec` 容量と一致させる。**cap は control 側（`register_channel`）で強制**するため
/// callback はこれを超える channel を受け取らない（callback で log しない＝RT 安全）。実用上の
/// channel 数を遥かに上回る値。
pub const MAX_LINK_CHANNELS: usize = 64;

/// callback が同時に render できる insert bus 数の上限。stage は stream 構築時に固定されるため、
/// callback では stack 上の `ArrayVec` だけで `render_multi` 引数を組み立てられる。
pub const MAX_INSERT_BUS_STAGES: usize = 64;

/// Maximum source slots owned by one callback.
pub const MAX_SOURCE_SLOTS: usize = 32;

/// Maximum independently routable output units exposed by one source.
pub const MAX_SOURCE_UNITS: usize = 16;

pub(super) const MAX_SOURCE_FEEDS: usize = MAX_SOURCE_SLOTS * MAX_SOURCE_UNITS;

/// mixer graph（#459/#453 MX.1-MX.5）における stage の出力先。**stages 配列内の index** で指す
/// （配列順 = トポロジカル順という MX.4 の不変条件を、型ではなく構築時検証で担保する）。
/// `Master` は既定（従来の「hw へ加算」のみの経路とビット同一）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum BusTarget {
    /// hardware sum へ加算する（従来の唯一の経路）。
    #[default]
    Master,
    /// 自分より **後ろ**（配列 index が大きい）の stage へ copy 加算する（sum への合流）。
    Bus(usize),
}

/// Decode the compatibility routing sentinel shared by the legacy RT shim and the daemon's
/// `SetBusRouting` publisher: `0` means no override, `1` means Master, and `n >= 2` means Bus(n-2).
pub fn decode_bus_routing_sentinel(encoded: usize) -> Option<BusTarget> {
    match encoded {
        0 => None,
        1 => Some(BusTarget::Master),
        n => Some(BusTarget::Bus(n - 2)),
    }
}

/// post-insert の signal を copy 加算する send（aux への並列タップ・MX.3）。post-fader 固定
/// （v1・pre/post 切替は将来拡張）。`target` は `sends` を持つ stage 自身より**後ろ**の index。
#[derive(Debug, Clone, Copy)]
pub struct BusSend {
    pub target: usize,
    pub gain: f32,
}

pub type LegacyLineInstaller =
    Arc<dyn Fn(BusTarget, Vec<BusSend>, usize, usize) -> Result<(), OutputError> + Send + Sync>;

#[derive(Clone)]
pub struct LineProgramInstaller {
    pub(super) install:
        Arc<dyn Fn(LineProgram, usize, usize) -> Result<(), OutputError> + Send + Sync>,
    pub(super) current_gains: Arc<dyn Fn() -> Vec<f32> + Send + Sync>,
}

impl LineProgramInstaller {
    pub fn new(
        install: impl Fn(LineProgram, usize, usize) -> Result<(), OutputError> + Send + Sync + 'static,
        current_gains: impl Fn() -> Vec<f32> + Send + Sync + 'static,
    ) -> Self {
        Self {
            install: Arc::new(install),
            current_gains: Arc::new(current_gains),
        }
    }

    pub fn install_for_bus(
        &self,
        program: LineProgram,
        bus_index: usize,
        bus_count: usize,
    ) -> Result<(), OutputError> {
        (self.install)(program, bus_index, bus_count)
    }

    pub fn current_gains(&self) -> Vec<f32> {
        (self.current_gains)()
    }
}

/// A resolved output destination for one line operation. Bus and channel names are converted to
/// stable indices on the control thread before a program is published.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputDest {
    Master,
    Bus(usize),
    Device { left: usize, right: Option<usize> },
    Render(usize),
    Link(usize),
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LineOutput {
    pub dest: OutputDest,
    pub thru: bool,
    pub gain: f32,
}

/// One operation in a bus line. Pan positions use the normalized -1..=1 wire range.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum LineOp {
    Rack,
    Gain(f32),
    Pan(f32),
    Output(LineOutput),
}

/// Immutable line operations plus atomically observable callback-owned gain state.
pub struct LineProgram {
    pub ops: Box<[LineOp]>,
    pub current_gain: Box<[AtomicU32]>,
    #[cfg(test)]
    pub(super) drop_thread_log: Option<Arc<std::sync::Mutex<Vec<std::thread::ThreadId>>>>,
}

/// The op sequence a legacy `SetBusRouting` maps onto: rack, the output target, then one
/// `thru` output per send.
///
/// 🔴 This is the single definition. `LineProgram::legacy` builds a program from it, and the
/// daemon keeps the same ops as its republish shadow. Duplicating the construction would let
/// the two drift — the shadow decides what a later `SetBusLine` seeds from, so a mismatch
/// would silently reintroduce the gain jump that seeding exists to prevent.
/// master ラインが**実際に走らせている**初期 program。
///
/// 🔴 **control 側の shadow と RT の実体は、必ずこの 1 関数から作る。**
/// 2026-09-11 の `/code:pr-review-team`（silent-failure-hunter）が Critical として見つけた形:
/// `MasterLine::new` が `right: Some(1)` を**チャンネル数に関係なく**固定する一方、
/// daemon 側の shadow は `(output_channels > 1).then_some(1)` を返していた。1ch デバイスでは
/// `dest` が食い違うので `line_republish_seeds` の Output 照合が外れ、**seed が既定の 0.0 に
/// 落ちて、鳴っていた master が一瞬無音からフェードインし直す** — この機構が防ごうとしている
/// ポップそのものである。
///
/// さらに `add_to_device` の境界検査は `debug_assert` だけなので、**実 1ch デバイスでは
/// `right: Some(1)` が RT で範囲外アクセスになる**。チャンネル数から作れば両方消える。
pub fn default_master_line_ops(output_channels: u16) -> Vec<LineOp> {
    vec![
        LineOp::Rack,
        LineOp::Gain(1.0),
        LineOp::Output(LineOutput {
            dest: OutputDest::Device {
                left: 0,
                right: (output_channels > 1).then_some(1),
            },
            thru: false,
            gain: 1.0,
        }),
    ]
}

pub fn legacy_line_ops(output_target: BusTarget, sends: &[BusSend]) -> Vec<LineOp> {
    let mut ops = Vec::with_capacity(sends.len() + 2);
    ops.push(LineOp::Rack);
    ops.push(LineOp::Output(LineOutput {
        dest: match output_target {
            BusTarget::Master => OutputDest::Master,
            BusTarget::Bus(index) => OutputDest::Bus(index),
        },
        thru: !sends.is_empty(),
        gain: 1.0,
    }));
    for (index, send) in sends.iter().enumerate() {
        ops.push(LineOp::Output(LineOutput {
            dest: OutputDest::Bus(send.target),
            thru: index + 1 != sends.len(),
            gain: send.gain,
        }));
    }
    ops
}

/// The one initial program used by both the RT bus and the daemon republish shadow.
/// An unconfigured bus has a rack position marker but no destination (#883 §2.6).
pub fn default_bus_line_ops() -> Vec<LineOp> {
    vec![LineOp::Rack]
}
