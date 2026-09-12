//! インストゥルメント slot の型定義と UI 通知の enqueue（#888 子 1・第 10 束）。
//!
//! 🔴 **これは純粋な移動である。** `engine_wrap.rs` のモジュールレベルにある
//! instrument slot 関連の型と関数をそのまま移した。本文は 1 行も書き換えていない。
//!
//! 第 9 束と同じく、親が**構造体のフィールドまで直接触っている**ので、
//! 関数・型だけでなく**フィールドにも `pub(super)`** が要る。
//! `pub(super)` は可視性を上げるだけで名前をスコープへ持ち込まないため、親側に `use` も足す。

#[allow(unused_imports)]
use super::*;

#[cfg(feature = "outproc-instrument")]
pub(super) struct OutProcInstrumentControl {
    /// #540 P1: 起動時に事前確保した instrument slot 群（index = slot 番号）。audio graph /
    /// shm / note ring は stream 起動時に固定で焼かれるため、複数 instrument は N slot の
    /// 事前確保 + `LoadPlugin` の instance 割当で実現する（effect の per-bus slot と同方式）。
    pub(super) slots: Vec<InstrumentSlotEntry>,
    /// instance ID → slot index。respawn 中は安定し、差し替え commit でのみ意図的に張り替える。
    pub(super) instance_index: HashMap<String, usize>,
    /// teardown と drain ack が完了し、別 tenant に安全に再利用できる slot。
    pub(super) free_slots: Vec<usize>,
    /// 起動時 pool のうち、一度も割り当て・prepare 予約されていない次の index。
    pub(super) next_unassigned: usize,
    /// instance ごとの replace 排他。READY 待ちと teardown は control mutex 外で行う。
    pub(super) replacements_in_flight: HashSet<String>,
}

#[cfg(feature = "outproc-instrument")]
impl OutProcInstrumentControl {
    pub(super) fn allocate_slot(&mut self) -> Option<usize> {
        self.free_slots.pop().or_else(|| {
            if self.next_unassigned < self.slots.len() {
                let index = self.next_unassigned;
                self.next_unassigned += 1;
                Some(index)
            } else {
                None
            }
        })
    }

    pub(super) fn free_slot(&mut self, index: usize) {
        if !self.free_slots.contains(&index) {
            self.free_slots.push(index);
        }
    }
}

#[cfg(all(test, feature = "outproc-instrument"))]
pub(super) fn test_instrument_control(
    slots: Vec<InstrumentSlotEntry>,
    instance_index: HashMap<String, usize>,
    next_unassigned: usize,
) -> OutProcInstrumentControl {
    OutProcInstrumentControl {
        slots,
        instance_index,
        free_slots: Vec::new(),
        next_unassigned,
        replacements_in_flight: HashSet::new(),
    }
}

/// instance 引数の無い互換経路（旧単数 API・wire の `instance` 欠如）が写る instance 名。
///
/// 「= slot 0」が**強制**されるのは instrument-only build の互換経路
/// （`load_outproc_plugin` の `or_insert(0)`）のみ。both build では "default" も通常の
/// 先着順割当を通るため、名前付き instance が先行していれば slot 0 とは限らない
/// （slot は同質なので挙動差は無く、互換 accessor `outproc_instrument_stats()` =
/// slots\[0\] が別 instance の統計を返し得る、というテストハーネス表面のみ —
/// #542 レビュー指摘）。
#[cfg(feature = "outproc-instrument")]
pub(crate) const DEFAULT_INSTRUMENT_INSTANCE: &str = "default";

/// stream 起動前に確保した instrument slot の中間部品（起動後に `ChildLaunch` へ組み上げる。
/// sample_rate が stream 起動後にしか確定しないため 2 段階になる）。
#[cfg(feature = "outproc-instrument")]
pub(super) struct PendingInstrumentSlot {
    pub(super) shm_path: PathBuf,
    pub(super) cleanup: ShmCleanupGuard,
    pub(super) event_tx: rtrb::Producer<orbit_audio_sandbox::NeutralEvent>,
    pub(super) stats: Arc<crate::outproc_instrument::OutProcInstrumentStats>,
    pub(super) engaged: Arc<AtomicBool>,
    pub(super) stop: Arc<AtomicBool>,
    pub(super) done: Arc<AtomicBool>,
    pub(super) drain_requested: Arc<AtomicBool>,
    pub(super) drain_done: Arc<AtomicBool>,
    pub(super) source_dests: Vec<orbit_audio_native::SourceDestCell>,
}

/// instrument slot 1本分の control-side ハンドル（旧 `OutProcInstrumentControl` のフィールド群）。
#[cfg(feature = "outproc-instrument")]
pub(super) struct InstrumentSlotEntry {
    /// Control threadで構築済みの NeutralEvent を audio thread へ渡す producer。
    pub(super) event_tx: rtrb::Producer<orbit_audio_sandbox::NeutralEvent>,
    /// Audio adapter と watchdog が更新し、gated harness が読む観測 stats。
    pub(super) stats: Arc<crate::outproc_instrument::OutProcInstrumentStats>,
    /// slot teardown 後に `ChildLaunch` を再構築するため stream 起動時から保持する値。
    pub(super) shm_path: PathBuf,
    pub(super) child_exe: PathBuf,
    pub(super) sample_rate: u32,
    pub(super) engaged: Arc<AtomicBool>,
    /// tenant 間で note ring を持ち越さないための RT drain-and-discard handshake。
    pub(super) drain_requested: Arc<AtomicBool>,
    pub(super) drain_done: Arc<AtomicBool>,
    pub(super) source_dests: Vec<orbit_audio_native::SourceDestCell>,
    /// post-boot attach の状態。`StreamGuard` と共有し、supervisor は stream より後に drop する。
    #[cfg(all(feature = "outproc-effect", feature = "outproc-instrument"))]
    pub(super) child_slot: Weak<Mutex<ChildSlot<InstrumentRole>>>,
    #[cfg(not(all(feature = "outproc-effect", feature = "outproc-instrument")))]
    pub(super) child_slot: Weak<Mutex<ChildSlot>>,
}

#[cfg(feature = "outproc-instrument")]
pub(super) fn default_source_dests() -> Vec<orbit_audio_native::SourceDestCell> {
    (0..orbit_audio_native::MAX_SOURCE_UNITS)
        .map(|_| orbit_audio_native::SourceDestCell::default())
        .collect()
}

#[cfg(feature = "outproc-instrument")]
pub(super) struct InstrumentSlotTeardownResources {
    pub(super) index: usize,
    pub(super) child_slot: Arc<Mutex<ChildSlot<InstrumentRole>>>,
    pub(super) shm_path: PathBuf,
    pub(super) child_exe: PathBuf,
    pub(super) sample_rate: u32,
    pub(super) stats: Arc<crate::outproc_instrument::OutProcInstrumentStats>,
    pub(super) engaged: Arc<AtomicBool>,
    pub(super) drain_requested: Arc<AtomicBool>,
    pub(super) drain_done: Arc<AtomicBool>,
    pub(super) source_dests: Vec<orbit_audio_native::SourceDestCell>,
}

#[cfg(feature = "outproc-instrument")]
impl InstrumentSlotTeardownResources {
    pub(super) fn from_entry(
        index: usize,
        entry: &InstrumentSlotEntry,
        child_slot: Arc<Mutex<ChildSlot<InstrumentRole>>>,
    ) -> Self {
        Self {
            index,
            child_slot,
            shm_path: entry.shm_path.clone(),
            child_exe: entry.child_exe.clone(),
            sample_rate: entry.sample_rate,
            stats: entry.stats.clone(),
            engaged: entry.engaged.clone(),
            drain_requested: entry.drain_requested.clone(),
            drain_done: entry.drain_done.clone(),
            source_dests: entry.source_dests.clone(),
        }
    }
}

#[cfg(feature = "outproc-instrument")]
#[derive(Debug)]
pub(super) enum InstrumentSlotTeardownFailure {
    ControlPoisoned,
    ControlMissing,
    SlotNotActive,
    DrainAckTimeout,
    ResetMapping(String),
    DrainAckTimeoutAndResetMapping(String),
}

#[cfg(feature = "outproc-instrument")]
impl std::fmt::Display for InstrumentSlotTeardownFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ControlPoisoned => formatter.write_str("instrument control poisoned"),
            Self::ControlMissing => formatter.write_str("instrument control missing"),
            Self::SlotNotActive => formatter.write_str("slot was not Active"),
            Self::DrainAckTimeout => formatter.write_str("event drain ack timed out"),
            Self::ResetMapping(error) => write!(formatter, "control reset mapping failed: {error}"),
            Self::DrainAckTimeoutAndResetMapping(error) => write!(
                formatter,
                "event drain ack timed out and control reset mapping failed: {error}"
            ),
        }
    }
}

#[cfg(feature = "outproc-instrument")]
pub(super) struct InstrumentReplacementReservation<'a> {
    pub(super) engine: &'a EngineWrap,
    pub(super) instance: String,
    pub(super) in_flight: bool,
    pub(super) spare_index: Option<usize>,
    pub(super) spare_resources: Option<InstrumentSlotTeardownResources>,
}

#[cfg(feature = "outproc-instrument")]
pub(super) enum ReservedSpareState {
    Empty,
    Active,
    Loading,
    Closed,
}

#[cfg(feature = "outproc-instrument")]
impl<'a> InstrumentReplacementReservation<'a> {
    pub(super) fn new(engine: &'a EngineWrap, instance: String) -> Self {
        Self {
            engine,
            instance,
            in_flight: false,
            spare_index: None,
            spare_resources: None,
        }
    }

    pub(super) fn mark_in_flight(&mut self) {
        self.in_flight = true;
    }

    pub(super) fn reserve_spare(&mut self, index: usize) {
        self.spare_index = Some(index);
    }

    pub(super) fn attach_spare_resources(&mut self, resources: InstrumentSlotTeardownResources) {
        self.spare_resources = Some(resources);
    }

    pub(super) fn commit_spare(&mut self) {
        self.spare_index = None;
        self.spare_resources = None;
    }
}

#[cfg(feature = "outproc-instrument")]
impl Drop for InstrumentReplacementReservation<'_> {
    fn drop(&mut self) {
        let reusable_spare = match self.spare_resources.take() {
            None => self.spare_index.is_some(),
            Some(resources) => {
                let state = {
                    let slot = lock_child_slot_recovering(
                        &resources.child_slot,
                        "replacement reservation rollback",
                    );
                    match &*slot {
                        ChildSlot::Empty(_) => ReservedSpareState::Empty,
                        ChildSlot::Active { .. } => ReservedSpareState::Active,
                        ChildSlot::Loading { .. } => ReservedSpareState::Loading,
                        ChildSlot::Closed => ReservedSpareState::Closed,
                    }
                };
                match state {
                    ReservedSpareState::Empty => true,
                    ReservedSpareState::Active => match self
                        .engine
                        .teardown_outproc_instrument_resources(&self.instance, resources)
                    {
                        Ok(()) => true,
                        Err(reason) => {
                            tracing::error!(
                                instance = %self.instance,
                                reason = %reason,
                                "uncommitted replacement spare teardown failed; slot quarantined from free-list"
                            );
                            false
                        }
                    },
                    ReservedSpareState::Loading => {
                        tracing::error!(
                            instance = %self.instance,
                            slot = resources.index,
                            "uncommitted replacement spare remained Loading; slot quarantined from free-list"
                        );
                        false
                    }
                    ReservedSpareState::Closed => {
                        tracing::error!(
                            instance = %self.instance,
                            slot = resources.index,
                            "uncommitted replacement spare became Closed; slot quarantined from free-list"
                        );
                        false
                    }
                }
            }
        };

        if !self.in_flight && self.spare_index.is_none() {
            return;
        }
        let mut guard = match self.engine.outproc_instrument.lock() {
            Ok(guard) => guard,
            Err(poisoned) => {
                tracing::error!(
                    instance = %self.instance,
                    "instrument control poisoned while releasing replacement reservation"
                );
                poisoned.into_inner()
            }
        };
        let Some(control) = guard.as_mut() else {
            tracing::error!(
                instance = %self.instance,
                "instrument control missing while releasing replacement reservation"
            );
            return;
        };
        if reusable_spare {
            if let Some(index) = self.spare_index {
                control.free_slot(index);
            }
        }
        if self.in_flight {
            control.replacements_in_flight.remove(&self.instance);
        }
    }
}

/// #540 P1: N slot 分の shm / note ring / block source を確保する（stream 起動前・
/// both / instrument-only 両起動経路で共有 — effect 側の `install_effect_bus_slots` と同じ
/// 「抽出 helper を両 spawn 経路が呼ぶ」型）。
#[cfg(feature = "outproc-instrument")]
pub(super) fn build_pending_instrument_slots(
    slot_count: usize,
) -> Result<
    (
        Vec<PendingInstrumentSlot>,
        Vec<orbit_audio_native::SourceSlot>,
    ),
    WrapError,
> {
    use crate::outproc_instrument::{
        OutProcInstrumentBlockSource, OutProcInstrumentStats, SlotSignals, NOTE_RING_CAPACITY,
    };
    use orbit_audio_native::{SourceSlot, MAX_SOURCE_SLOTS};
    const {
        assert!(
            crate::outproc_instrument::MAX_INSTRUMENT_SLOTS <= MAX_SOURCE_SLOTS,
            "daemon instrument capacity must fit native source capacity"
        );
    }
    assert!(
        slot_count <= MAX_SOURCE_SLOTS,
        "requested instrument slots must fit native source capacity"
    );
    let mut pending = Vec::with_capacity(slot_count);
    let mut sources = Vec::with_capacity(slot_count);
    for _ in 0..slot_count {
        let shm_path = crate::outproc_instrument::unique_shm_path();
        let host_mmap = orbit_audio_sandbox::create_shared(&shm_path).map_err(|error| {
            WrapError::OutProcInstrument(format!("create shm {shm_path:?}: {error}"))
        })?;
        let cleanup = ShmCleanupGuard::new(shm_path.clone());
        let host = orbit_audio_sandbox::PipelinedInstrumentHost::from_mmap(host_mmap);
        let (event_tx, event_rx) = rtrb::RingBuffer::new(NOTE_RING_CAPACITY);
        let engaged = Arc::new(AtomicBool::new(false));
        let stop = Arc::new(AtomicBool::new(false));
        let done = Arc::new(AtomicBool::new(false));
        let drain_requested = Arc::new(AtomicBool::new(false));
        let drain_done = Arc::new(AtomicBool::new(false));
        let stats = OutProcInstrumentStats::new();
        let source_dests = default_source_dests();
        let source = OutProcInstrumentBlockSource::new(
            host,
            event_rx,
            NOTE_RING_CAPACITY,
            engaged.clone(),
            SlotSignals {
                teardown_requested: stop.clone(),
                teardown_done: done.clone(),
                drain_requested: drain_requested.clone(),
                drain_done: drain_done.clone(),
            },
            stats.clone(),
        );
        sources.push(SourceSlot {
            source: Box::new(source),
            dests: source_dests.clone(),
        });
        pending.push(PendingInstrumentSlot {
            shm_path,
            cleanup,
            event_tx,
            stats,
            engaged,
            stop,
            done,
            drain_requested,
            drain_done,
            source_dests,
        });
    }
    Ok((pending, sources))
}

/// `install_instrument_slots` の戻り値（entry / child guard / teardown guard の3列）。
#[cfg(feature = "outproc-instrument")]
pub(super) type InstalledInstrumentSlots = (
    Vec<InstrumentSlotEntry>,
    Vec<Arc<Mutex<ChildSlot<InstrumentRole>>>>,
    Vec<crate::outproc_instrument::OutProcInstrumentTeardownGuard>,
);

/// #540 P1: pending slot を ChildLaunch / control entry / guard へ組み上げる
/// （sample_rate が stream 起動後にしか確定しないため build と2段階・両起動経路で共有）。
#[cfg(feature = "outproc-instrument")]
pub(super) fn install_instrument_slots(
    pending_slots: Vec<PendingInstrumentSlot>,
    child_exe: &std::path::Path,
    sample_rate: u32,
) -> InstalledInstrumentSlots {
    let mut entries = Vec::with_capacity(pending_slots.len());
    let mut child_guards = Vec::with_capacity(pending_slots.len());
    let mut teardowns = Vec::with_capacity(pending_slots.len());
    for pending in pending_slots {
        let PendingInstrumentSlot {
            shm_path,
            mut cleanup,
            event_tx,
            stats,
            engaged,
            stop,
            done,
            drain_requested,
            drain_done,
            source_dests,
        } = pending;
        let child_slot = Arc::new(Mutex::new(ChildSlot::<InstrumentRole>::Empty(
            ChildLaunch {
                shm_path: shm_path.clone(),
                child_exe: child_exe.to_path_buf(),
                sample_rate,
                stats: stats.clone(),
                engaged: engaged.clone(),
                cleanup_shm_on_drop: true,
            },
        )));
        // unlink 所有権を起動失敗用 guard から ChildLaunch へ移す。
        cleanup.disarm();
        entries.push(InstrumentSlotEntry {
            event_tx,
            stats,
            shm_path,
            child_exe: child_exe.to_path_buf(),
            sample_rate,
            engaged,
            drain_requested,
            drain_done,
            source_dests,
            child_slot: Arc::downgrade(&child_slot),
        });
        child_guards.push(child_slot);
        teardowns.push(crate::outproc_instrument::OutProcInstrumentTeardownGuard::new(stop, done));
    }
    (entries, child_guards, teardowns)
}
