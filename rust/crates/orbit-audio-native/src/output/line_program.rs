//! ラインプログラムの検証と slot 交換（#888 子 2・output.rs）。
//!
//! 🔴 **これは純粋な移動である。** `lines.rs` から分けた。1 ファイルにまとめると
//! **549 コード行**で #888 の閾値 500 を超えるため（設計 §13.9 の制約 1）。

#[allow(unused_imports)]
use super::*;

impl LineProgram {
    /// Construct a generic program whose gain state starts at unity and ramps to each target.
    pub fn new(ops: Vec<LineOp>) -> Self {
        let seeds = vec![1.0; ops.len()];
        Self::with_seeds(ops, seeds)
    }

    /// Construct a generic program with control-selected effective values for click-free
    /// replacement. Shape validation remains at the publication boundary.
    pub fn with_seeds(ops: Vec<LineOp>, seeds: Vec<f32>) -> Self {
        Self {
            ops: ops.into_boxed_slice(),
            current_gain: seeds
                .into_iter()
                .map(|seed| AtomicU32::new(seed.to_bits()))
                .collect::<Vec<_>>()
                .into_boxed_slice(),
            #[cfg(test)]
            drop_thread_log: None,
        }
    }

    /// Construct a program already at every target. Static and legacy routing use this path because
    /// their pre-LineProgram behavior applied gains immediately, including the first callback.
    pub fn settled(ops: Vec<LineOp>) -> Self {
        let seeds = ops
            .iter()
            .map(|op| match op {
                LineOp::Gain(gain) | LineOp::Pan(gain) => *gain,
                LineOp::Output(output) => output.gain,
                LineOp::Rack => 1.0,
            })
            .collect();
        Self::with_seeds(ops, seeds)
    }

    pub(super) fn legacy(output_target: BusTarget, sends: &[BusSend]) -> Self {
        Self::settled(legacy_line_ops(output_target, sends))
    }

    pub(super) fn validate_shape(&self) -> Result<(), OutputError> {
        if self.ops.len() != self.current_gain.len() {
            return Err(OutputError::NoConfig(format!(
                "line program has {} ops but {} gain cells",
                self.ops.len(),
                self.current_gain.len()
            )));
        }
        Ok(())
    }

    #[cfg(test)]
    pub(super) fn with_drop_thread_log(
        mut self,
        log: Arc<std::sync::Mutex<Vec<std::thread::ThreadId>>>,
    ) -> Self {
        self.drop_thread_log = Some(log);
        self
    }
}

#[cfg(test)]
impl Drop for LineProgram {
    fn drop(&mut self) {
        if let Some(log) = &self.drop_thread_log {
            log.lock()
                .expect("line-program drop-thread log")
                .push(std::thread::current().id());
        }
    }
}

/// A retired program and the RT generation after which it can be destroyed. The generation lives
/// in the retired object itself, matching the shape of the `ChainExchange` precedent. The safety
/// argument differs: `ChainExchange` has RT write `retired_at_generation` before handoff, which
/// establishes happens-before, while this exchange has control count completed RT generations.
/// Only the “generation travels in the retired object” shape is borrowed here.
pub(super) struct RetiredLineProgram {
    pub(super) program: Box<LineProgram>,
    pub(super) retired_at_generation: u64,
}

pub(super) struct LineExchange {
    pub(super) live: AtomicPtr<LineProgram>,
    pub(super) retired: Mutex<Vec<RetiredLineProgram>>,
    /// Completed RT generations. The audio thread is the sole writer; control only Acquire-loads.
    pub(super) generation: AtomicU64,
}

impl LineExchange {
    pub(super) fn new(program: LineProgram) -> Arc<Self> {
        Arc::new(Self {
            live: AtomicPtr::new(Box::into_raw(Box::new(program))),
            retired: Mutex::new(Vec::new()),
            generation: AtomicU64::new(0),
        })
    }

    pub(super) fn install(
        &self,
        program: LineProgram,
        bus_index: usize,
        bus_count: usize,
    ) -> Result<(), OutputError> {
        validate_line_program(&program, bus_index, bus_count)?;
        let next = Box::into_raw(Box::new(program));
        let previous = self.live.swap(next, Ordering::AcqRel);
        debug_assert!(!previous.is_null());

        let completed = self.generation.load(Ordering::Acquire);
        // The swap above has already published `next`. If this panic-only mutex-poisoning path is
        // taken, install returns Err even though the new program is live and `previous` is leaked.
        // This ordering is documented rather than disguised as an atomic control-side rollback.
        let mut retired = self
            .retired
            .lock()
            .map_err(|_| OutputError::NoConfig("line retirement mutex poisoned".into()))?;
        retired.retain(|entry| completed < entry.retired_at_generation);
        if !previous.is_null() {
            // SAFETY: `previous` was produced by Box::into_raw and the swap removed it from the
            // live owner. RT may still hold a shared raw reference, so the box stays retained for
            // two completed generations: one for the possible in-flight read plus one spare. It is
            // never dereferenced by control.
            retired.push(RetiredLineProgram {
                program: unsafe { Box::from_raw(previous) },
                retired_at_generation: completed.saturating_add(2),
            });
        }
        Ok(())
    }
}

impl Drop for LineExchange {
    fn drop(&mut self) {
        let live = *self.live.get_mut();
        if !live.is_null() {
            // SAFETY: final `Arc<LineExchange>` destruction means no RT or control handle remains.
            drop(unsafe { Box::from_raw(live) });
        }
        if let Ok(retired) = self.retired.get_mut() {
            for entry in retired.drain(..) {
                drop(entry.program);
            }
        }
    }
}

/// Control-only installation handle. Effective values are atomic because re-publication must seed
/// a replacement from the currently audible state rather than restarting at unity.
#[derive(Clone)]
pub struct LineControl {
    pub(super) exchange: Arc<LineExchange>,
}

impl LineControl {
    pub fn install_for_bus(
        &self,
        program: LineProgram,
        bus_index: usize,
        bus_count: usize,
    ) -> Result<(), OutputError> {
        self.exchange.install(program, bus_index, bus_count)
    }

    /// 🔴 **呼び手が install と直列化する契約**であり、型では強制していない。
    /// どの mutex で直列化されているかを名指ししておく（`/code:pr-review-team` の
    /// code-reviewer の Minor・2026-09-11: 「この規約を知らない 4 つ目の呼び出し元が
    /// 追加されると壊れる」）:
    ///
    /// `current_gains()` を呼ぶのは 2 箇所だけで、どちらも `EngineWrap::set_bus_line` の中にある:
    ///
    /// | 呼び出し元 | 直前に取っている mutex |
    /// |---|---|
    /// | `set_bus_line` の `bus == "master"` 分岐 | `master_line_program` |
    /// | `set_bus_line` の named-bus 分岐 | `bus_line_shadows` |
    ///
    /// 同じ `LineExchange` へ install する経路は、`current_gains()` を呼ばないものも含めて
    /// 次の 3 つ。**どれも上と同じ mutex を取ってから install する**ので、install どうしも
    /// 「読む → install」も全経路で直列化される:
    ///
    /// | install する経路 | 取る mutex |
    /// |---|---|
    /// | `set_bus_line`（master 分岐） | `master_line_program` |
    /// | `set_bus_line`（named-bus 分岐・新経路） | `bus_line_shadows` |
    /// | `set_bus_routing`（旧 `SetBusRouting` 経路） | `bus_line_shadows`（同じもの） |
    ///
    /// ここを別ロックに分けると、退役中の program を読む use-after-free が生まれる。
    ///
    /// 🔴 `EngineWrap::set_global_gain` は**この表に入らない**。現状は `master_gain` atomic を
    /// store するだけで、`master_line_program` にも `LineExchange` にも触れていない。TS の
    /// `global.gain()` を `SetBusLine("master", …)` へ切り替える PR-O4 でこの経路に触るときは、
    /// 「既に直列化されている」と読まずに上の契約を新たに満たすこと。
    pub fn current_gains(&self) -> Vec<f32> {
        let program = self.exchange.live.load(Ordering::Acquire);
        assert!(!program.is_null(), "line program must always be installed");
        // SAFETY: control is the sole publication side. The caller serializes reading the live
        // values with replacement (see the tables above), so this pointer remains live for the
        // duration of the loads.
        unsafe { &*program }
            .current_gain
            .iter()
            .map(|gain| f32::from_bits(gain.load(Ordering::Relaxed)))
            .collect()
    }
}

pub(super) struct LegacyLineRouting {
    pub(super) output: Arc<AtomicUsize>,
    pub(super) sends: Vec<Arc<AtomicU32>>,
}

/// RT-side line reader. Production reads the published program with one Acquire load; reclamation,
/// allocation, locking, and destruction are confined to `LineControl`.
pub struct LineSlot {
    pub(super) exchange: Arc<LineExchange>,
    pub(super) ramp_frames: u32,
    pub(super) legacy: Option<LegacyLineRouting>,
    #[cfg(test)]
    pub(super) read_interlock:
        std::sync::Mutex<Option<(Arc<std::sync::Barrier>, Arc<std::sync::Barrier>)>>,
}

impl LineSlot {
    pub fn new(program: LineProgram) -> Self {
        Self {
            exchange: LineExchange::new(program),
            // Direct unit-test construction uses the engine's normal 48 kHz default. Production
            // replaces this from the selected device rate before the callback starts.
            ramp_frames: 240,
            legacy: None,
            #[cfg(test)]
            read_interlock: std::sync::Mutex::new(None),
        }
    }

    pub fn line_control(&self) -> LineControl {
        LineControl {
            exchange: self.exchange.clone(),
        }
    }

    pub(super) fn set_sample_rate(&mut self, sample_rate: u32) {
        self.ramp_frames = ((sample_rate as f64 * 0.005).round() as u32).max(1);
    }

    #[inline]
    pub(super) fn load(&self) -> *mut LineProgram {
        let program = self.exchange.live.load(Ordering::Acquire);
        debug_assert!(!program.is_null());
        #[cfg(test)]
        self.wait_at_read_interlock();
        program
    }

    #[inline]
    pub(super) fn finish_generation(&self) {
        self.exchange.generation.fetch_add(1, Ordering::Release);
    }

    pub(super) fn replace_during_construction(&self, program: LineProgram) {
        // Construction-only builders have no stage index yet. Bus topology is validated once the
        // complete stage array exists, before a callback can start.
        let next = Box::into_raw(Box::new(program));
        let previous = self.exchange.live.swap(next, Ordering::AcqRel);
        if !previous.is_null() {
            let mut retired = self
                .exchange
                .retired
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            // No RT generation has begun during construction, but a control handle may already
            // have been cloned. Retaining until final drop avoids relying on that convention.
            retired.push(RetiredLineProgram {
                // SAFETY: the live swap transferred ownership to this retired entry.
                program: unsafe { Box::from_raw(previous) },
                retired_at_generation: u64::MAX,
            });
        }
    }

    pub(super) fn ops_snapshot_during_construction(&self) -> Vec<LineOp> {
        let program = self.exchange.live.load(Ordering::Acquire);
        assert!(!program.is_null(), "line program must always be installed");
        // SAFETY: builder methods are construction-only and hold exclusive access to the stage.
        unsafe { (&*program).ops.to_vec() }
    }

    #[cfg(test)]
    pub(super) fn interlock_next_read(
        &mut self,
        reached_after_load: Arc<std::sync::Barrier>,
        resume_read: Arc<std::sync::Barrier>,
    ) {
        *self.read_interlock.lock().expect("line read interlock") =
            Some((reached_after_load, resume_read));
    }

    #[cfg(test)]
    pub(super) fn wait_at_read_interlock(&self) {
        let interlock = self
            .read_interlock
            .lock()
            .expect("line read interlock")
            .take();
        if let Some((reached_after_load, resume_read)) = interlock {
            reached_after_load.wait();
            resume_read.wait();
        }
    }

    #[cfg(test)]
    pub(super) fn visit_program_for_test(&self, visit: impl FnOnce(&LineProgram)) {
        let program = self.load();
        // SAFETY: the RT generation guard retains a replaced program until two later completed
        // generations, and this method publishes completion only after `visit` returns.
        visit(unsafe { &*program });
        self.finish_generation();
    }
}

pub(super) fn validate_line_program(
    program: &LineProgram,
    bus_index: usize,
    bus_count: usize,
) -> Result<(), OutputError> {
    program.validate_shape()?;
    for op in &program.ops {
        match op {
            // These arms are availability gates, not permanent format restrictions. Remove the
            // corresponding rejection when the follow-up PR wires that variant into RT execution;
            // until then accepting it would report success for a program the callback ignores.
            LineOp::Output(LineOutput {
                dest: OutputDest::Render(_),
                ..
            }) => {
                return Err(OutputError::NoConfig(
                    "line program Output destination Render is not wired into RT execution".into(),
                ));
            }
            LineOp::Output(LineOutput {
                dest: OutputDest::Link(_),
                ..
            }) => {
                return Err(OutputError::NoConfig(
                    "line program Output destination Link is not wired into RT execution".into(),
                ));
            }
            LineOp::Output(LineOutput {
                dest: OutputDest::Bus(target),
                ..
            }) if *target <= bus_index || *target >= bus_count => {
                return Err(OutputError::NoConfig(format!(
                    "insert bus index {bus_index} output Bus({target}) must be a later stage"
                )));
            }
            LineOp::Rack
            | LineOp::Gain(_)
            | LineOp::Pan(_)
            | LineOp::Output(LineOutput {
                dest: OutputDest::Master | OutputDest::Bus(_) | OutputDest::Device { .. },
                ..
            }) => {}
        }
    }
    Ok(())
}

#[inline]
pub(super) fn effective_line_output_dest(
    first_output: &mut bool,
    legacy_target: Option<OutputDest>,
    program_target: OutputDest,
) -> OutputDest {
    if *first_output {
        *first_output = false;
        legacy_target.unwrap_or(program_target)
    } else {
        program_target
    }
}

/// named routing tag を受ける per-bus insert stage。sum/aux を含む mixer graph の1ノード
/// （#459/#453・MX.1-MX.5）。
///
/// `processor=None` は effect 未 attach の **登録済み bus** を表す。buffer を `render_multi` に渡して
/// event を必ず消費し、そのまま `output_target` へ足すので、未 attach bus の event が retain され
/// 続けない。
pub struct InsertBusStage {
    pub(super) name: String,
    pub(super) processor: Option<Box<dyn PostProcessor>>,
    pub(super) buffer: Vec<f32>,
    /// **activation flag**（`LinkChannelActivate.ready` と同じパターン）: `false` の間この bus は
    /// render 対象から完全に外れる（zero-fill / gain-ramp / sum のコストゼロ）。daemon の既定
    /// bus プール（#434 S3）は宣言（LoadPlugin）まで inactive で、全 bus inactive なら
    /// `render_block` は bus 無し経路（ビット同一）に落ちる — `seq.effect()` を使わない
    /// セッションが pool のコストを払わないための機構。
    /// ⚠ inactive bus 名に tag された event は render_multi の対象外 = 消費されず retain される
    /// （LinkAudio の not-ready channel と同じ既存ハザード）。producer（TS）は「宣言 =
    /// activation → その後に tag 付き PlayAt」の順序を守ること（`seq.effect()` は await するので
    /// 構造的に成立）。
    pub(super) active: Arc<AtomicBool>,
    /// Published line program. Routing, sends, and rack position are all interpreted from this one
    /// ordered program by the callback post-loop.
    pub(super) line: LineSlot,
}
