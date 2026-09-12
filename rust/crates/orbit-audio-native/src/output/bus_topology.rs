//! insert bus stage の検証とトポロジ（#888 子 2・output.rs）。
//!
//! 🔴 **これは純粋な移動である。** `output.rs` からそのまま移した。

#[allow(unused_imports)]
use super::*;

impl InsertBusStage {
    /// テストまたは構築側が既知の block 長で stage を作る。通常の stream 起動 seam は device config
    /// 確定後に必要な buffer を確保するため、ここには 0 を渡してよい。
    pub fn new(
        name: impl Into<String>,
        processor: Option<Box<dyn PostProcessor>>,
        buffer_len: usize,
    ) -> Self {
        // 手組み（テスト・明示構成）の stage は生成時から live。遅延 activation が要る
        // 呼び出し側（daemon の bus プール）は `with_activation` を使う。
        Self::with_activation(name, processor, buffer_len, Arc::new(AtomicBool::new(true)))
    }

    /// 共有 activation flag 付きで stage を作る（daemon が LoadPlugin 時に `true` へ release-store
    /// する用途。flag の所有は呼び出し側と共有）。
    pub fn with_activation(
        name: impl Into<String>,
        processor: Option<Box<dyn PostProcessor>>,
        buffer_len: usize,
        active: Arc<AtomicBool>,
    ) -> Self {
        Self {
            name: name.into(),
            processor,
            buffer: vec![0.0; buffer_len],
            active,
            line: LineSlot::new(LineProgram::settled(default_bus_line_ops())),
        }
    }

    /// effect 未 attach の routing bus を登録する。
    pub fn unattached(name: impl Into<String>) -> Self {
        Self::new(name, None, 0)
    }

    /// この stage の明示済み primary output を差し替える。sum の member 等に使う（MX.1）。
    /// target index の妥当性（自分より後ろ）は構築 API 側で検証する。
    ///
    /// 🔴 **前提: line が既に Output op を持っていること。** #883 で `default_bus_line_ops()` が
    /// `[Rack]`（出口なし）になったので、`new()` 直後の stage には Output op が無く、その状態で
    /// 呼ぶと **target は黙って捨てられる**。明示 master から始めたいなら
    /// `with_explicit_master()` を先に通すこと。
    pub fn with_output_target(self, target: BusTarget) -> Self {
        let mut ops = self.line.ops_snapshot_during_construction();
        if let Some(LineOp::Output(output)) =
            ops.iter_mut().find(|op| matches!(op, LineOp::Output(_)))
        {
            output.dest = match target {
                BusTarget::Master => OutputDest::Master,
                BusTarget::Bus(index) => OutputDest::Bus(index),
            };
        }
        self.line
            .replace_during_construction(LineProgram::settled(ops));
        self
    }

    /// 明示済み primary output に複数の send（aux/return への post-fader copy・MX.3）を足す。
    ///
    /// 🔴 **前提: line が既に Output op を持っていること**（`with_output_target` と同じ）。
    /// `[Rack]` 既定の stage に対して呼ぶと `expect` で panic する。送り先だけを足す API なので
    /// 「出口が無い line」は表現できない — 出口なしのまま残したいなら呼ばない。
    pub fn with_sends(self, sends: Vec<BusSend>) -> Self {
        let mut ops = self.line.ops_snapshot_during_construction();
        let primary = ops
            .iter()
            .position(|op| matches!(op, LineOp::Output(_)))
            .expect("legacy line has a primary output");
        ops.truncate(primary + 1);
        if let LineOp::Output(output) = &mut ops[primary] {
            output.thru = !sends.is_empty();
        }
        for (index, send) in sends.iter().enumerate() {
            ops.push(LineOp::Output(LineOutput {
                dest: OutputDest::Bus(send.target),
                thru: index + 1 != sends.len(),
                gain: send.gain,
            }));
        }
        self.line
            .replace_during_construction(LineProgram::settled(ops));
        self
    }

    /// Replace the construction-time default with an explicit generic line program. Topology is
    /// validated once the complete stage array is available.
    pub fn with_line(self, program: LineProgram) -> Self {
        self.line.replace_during_construction(program);
        self
    }

    /// Obtain the control-only publication handle before moving the stage into callback state.
    pub fn line_control(&self) -> LineControl {
        self.line.line_control()
    }

    pub fn line_program_installer(&self) -> LineProgramInstaller {
        let control = self.line.line_control();
        let current = control.clone();
        LineProgramInstaller::new(
            move |program, bus_index, bus_count| {
                control.install_for_bus(program, bus_index, bus_count)
            },
            move || current.current_gains(),
        )
    }

    /// Compatibility bridge used by the daemon's old `SetBusRouting` command. The closure accepts
    /// the old routing shape but publishes a complete `LineProgram`; it exposes neither the live
    /// pointer nor callback-owned gain cells to control code.
    pub fn legacy_line_installer(&self) -> LegacyLineInstaller {
        let control = self.line.line_control();
        Arc::new(move |target, sends, bus_index, bus_count| {
            control.install_for_bus(LineProgram::legacy(target, &sends), bus_index, bus_count)
        })
    }

    /// M2（#459/#453）: 実行時ルーティング用の atomic ハンドルを装着する。`routing_override` は
    /// この stage の output target 切替用（呼び出し側が control 側にも同じ Arc の clone を保持し
    /// `SetBusRouting` で書き込む）。`send_gain_overrides` は「この stage より後ろの全 stage」分の
    /// gain スロットを、絶対 index の昇順（この stage の直後から順）で渡す（呼び出し側が
    /// stage 配列の組み立て時にサイズを決める）。
    pub fn with_routing_overrides(
        mut self,
        routing_override: Arc<AtomicUsize>,
        send_gain_overrides: Vec<Arc<AtomicU32>>,
    ) -> Self {
        if !send_gain_overrides.is_empty() {
            let mut ops = self.line.ops_snapshot_during_construction();
            for op in &mut ops {
                if let LineOp::Output(output) = op {
                    output.thru = true;
                }
            }
            self.line
                .replace_during_construction(LineProgram::settled(ops));
        }
        self.line.legacy = Some(LegacyLineRouting {
            output: routing_override,
            sends: send_gain_overrides,
        });
        self
    }

    pub(super) fn ensure_buffer_len(&mut self, len: usize) {
        ensure_audio_buffer_len(&mut self.buffer, len);
    }
}

/// `insert_buses` の `output_target`/`sends` が MX.4 のトポロジカル不変条件（配列順で後方参照
/// のみ）を満たすか検証する。stage i の target/send が `<= i` を指すと、render 時に
/// `split_at_mut` で解決できない（前方参照 or 自己参照は sum のネスト・循環に相当し v1 で禁止・
/// MX.2）。構築 API の入口（`start_default_output_with_insert_buses*`）でのみ呼ぶ。
pub(super) fn validate_bus_topology(stages: &[InsertBusStage]) -> Result<(), OutputError> {
    for (i, stage) in stages.iter().enumerate() {
        let program = stage.line.exchange.live.load(Ordering::Acquire);
        if program.is_null() {
            return Err(OutputError::NoConfig(format!(
                "insert bus '{}' has no line program",
                stage.name
            )));
        }
        // SAFETY: topology validation runs before stages enter callback state; the construction
        // API cannot replace this pointer concurrently.
        validate_line_program(unsafe { &*program }, i, stages.len()).map_err(|error| {
            OutputError::NoConfig(format!("insert bus '{}': {error}", stage.name))
        })?;
    }
    Ok(())
}

pub(super) fn validate_source_slots(sources: &[SourceSlot]) -> Result<(), OutputError> {
    if sources.len() > MAX_SOURCE_SLOTS {
        return Err(OutputError::NoConfig(format!(
            "too many source slots: {} (max {MAX_SOURCE_SLOTS})",
            sources.len()
        )));
    }
    for (slot, source) in sources.iter().enumerate() {
        if source.dests.len() > MAX_SOURCE_UNITS {
            return Err(OutputError::NoConfig(format!(
                "source slot {slot} has too many output units: {} (max {MAX_SOURCE_UNITS})",
                source.dests.len()
            )));
        }
    }
    Ok(())
}

/// LinkAudio channel を RT callback に届けるための activation メッセージ（A4-2b-2）。
/// control thread が ring 生成・scratch 事前確保まで行い、本構造体を reg-ring 経由で callback へ
/// 渡す（callback は受け取って pool へ追加するだけ＝RT alloc を避ける）。`sink` は対になる
/// `rtrb::Consumer<f32>` を GPL consumer thread が drain する producer 側。
pub struct LinkChannelActivate {
    pub name: String,
    pub sink: RingTapSink,
    /// per-block scratch。control が `max_block_frames * channels` で事前確保する。
    pub scratch: Vec<f32>,
    /// **readiness flag**（A4-2b-2b）: GPL consumer thread が当該 channel の Link 登録 + egress 構築を
    /// 終えたら `true` にする。callback は `false` の間この channel を render_multi 対象から外し commit
    /// もしない。これにより「callback が push するが consumer が drain しない ring（partial-failure で
    /// 溢れて silent）」が **構造的に発生しない**。steady-state の共有者は RT callback（`le.channels`
    /// 内の本構造体）と consumer thread（`ActiveChannel`）の 2 つ。control は `register_channel` 構築後に
    /// 自分の clone を手放す。
    pub ready: Arc<AtomicBool>,
}

/// cpal callback が保持する LinkAudio egress の channel pool（A4-2b-2b・最大 [`MAX_LINK_CHANNELS`]）。
/// `reg_rx` から新 channel を受け取り `channels` に追加する。同名再登録は control 側の冪等 guard が
/// 抑止するため、`channels` への push は常に新規 channel（既存 entry を drop しない＝RT 安全）。
pub(super) struct LinkEgress {
    pub(super) reg_rx: rtrb::Consumer<LinkChannelActivate>,
    pub(super) channels: Vec<LinkChannelActivate>,
}

/// channel が egress 対象か = **ready** かつ **scratch が block 以上**（A4-2b-2b）。`render_block` の
/// pass 1（render_multi 引数組み）と pass 2（sink commit）で同一判定を使い divergence を防ぐ。pure
/// なので CI で単体検証する（not-ready / scratch 不足 / active を pin）。
#[inline]
pub(super) fn channel_egress_active(ready: bool, scratch_len: usize, block: usize) -> bool {
    ready && scratch_len >= block
}
