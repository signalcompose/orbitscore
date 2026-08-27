//! Serial effect-rack core for `orbit-effect-rack-child` (#628).
//!
//! The main thread owns plugin construction, state, and UI endpoints. The audio thread sees only
//! stable audio-stage cells through a generation-tagged `AtomicPtr<StageList>`. A replacement is
//! prepared completely and published once; the audio thread adopts it only at a block boundary
//! and returns the old list through the retire slot for main-thread destruction.

use std::cell::UnsafeCell;
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::ptr;
use std::sync::atomic::{AtomicPtr, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;

use orbit_audio_sandbox::{
    CommandOutcome, CMD_RESULT_BAD_ARG, CMD_RESULT_IO_ERROR, CMD_RESULT_OK, CMD_RESULT_PLUGIN_ERROR,
};

#[cfg(target_os = "macos")]
pub mod macos;

// 🔴 wire の型は **共有 crate に 1 つだけ**置く（`orbit_audio_sandbox::rack_wire`）。
//
// 初版はこの位置に daemon 側と同一の型を独立に書いていた。その結果、**同じ serde 欠陥が
// 実機で 2 回出た** — daemon 側を直した直後に child 側で同型が出た。ユニットテストは
// 両側とも緑で、wire を跨いだ実物だけが落ちていた。詳細は `rack_wire` のモジュールコメント。
pub use orbit_audio_sandbox::rack_wire::{
    enabled_by_default, ApplyPlan, ChainManifest, PlanStage, SaveDropped, StageSpec,
};

pub fn read_manifest(path: &Path) -> Result<ChainManifest, String> {
    let bytes = std::fs::read(path).map_err(|error| format!("read {}: {error}", path.display()))?;
    let manifest: ChainManifest = serde_json::from_slice(&bytes)
        .map_err(|error| format!("parse {}: {error}", path.display()))?;
    if manifest.version != 1 {
        return Err(format!(
            "unsupported chain manifest version {}",
            manifest.version
        ));
    }
    Ok(manifest)
}

pub fn read_apply_plan(path: &Path) -> Result<ApplyPlan, String> {
    let bytes = std::fs::read(path).map_err(|error| format!("read {}: {error}", path.display()))?;
    let plan: ApplyPlan = serde_json::from_slice(&bytes)
        .map_err(|error| format!("parse {}: {error}", path.display()))?;
    if plan.version != 1 {
        return Err(format!("unsupported chain plan version {}", plan.version));
    }
    Ok(plan)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostFormat {
    Clap,
    #[cfg(target_os = "macos")]
    Vst3,
}

/// Select the concrete host solely from the case-insensitive bundle extension.
pub fn host_format_for_path(path: &Path) -> Result<HostFormat, String> {
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase);
    match extension.as_deref() {
        Some("clap") => Ok(HostFormat::Clap),
        #[cfg(target_os = "macos")]
        Some("vst3") => Ok(HostFormat::Vst3),
        #[cfg(not(target_os = "macos"))]
        Some("vst3") => Err("VST3 stages are available only on macOS".into()),
        _ => Err(format!(
            "unsupported effect plugin extension for {} (expected .clap{} )",
            path.display(),
            if cfg!(target_os = "macos") {
                " or .vst3"
            } else {
                ""
            }
        )),
    }
}

/// Resolve a standard plugin beside the child executable, with the documented env override.
pub fn resolve_standard_plugin_path(
    executable: &Path,
    env_override: Option<&Path>,
    name: &str,
) -> Result<PathBuf, String> {
    if name.is_empty() || name.contains('/') || name.contains('\\') {
        return Err(format!("invalid standard plugin name {name:?}"));
    }
    let directory = match env_override {
        Some(directory) => directory.to_path_buf(),
        None => executable
            .parent()
            .ok_or_else(|| format!("executable has no parent: {}", executable.display()))?
            .join("std-plugins"),
    };
    Ok(directory.join(format!("{name}.clap")))
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ResolvedParam {
    pub id: u32,
    pub value: f64,
}

/// Format-neutral audio-thread half of one loaded stage.
pub trait AudioStage: Send {
    fn apply_params(&mut self, params: &[ResolvedParam]) -> Result<(), String> {
        if params.is_empty() {
            Ok(())
        } else {
            Err("this stage does not accept parameter updates".into())
        }
    }

    /// Return false when this stage failed; callers retain the incoming dry block.
    fn process_block(&mut self, block: &mut [f32]) -> bool;
}

/// Main-thread half of one loaded stage.
pub trait ControlStage {
    fn capture_state(&mut self) -> Result<Vec<u8>, String>;
    fn resolve_params(
        &mut self,
        params: &BTreeMap<String, f64>,
    ) -> Result<Vec<ResolvedParam>, String>;
    fn is_standard(&self) -> bool;
    fn handle_ui(&self, _open: bool, _title: Option<&str>) -> CommandOutcome {
        CommandOutcome::failed(CMD_RESULT_PLUGIN_ERROR, "plugin UI is unavailable")
    }
    fn tick_ui(&self) {}
    fn set_index(&self, _index: u32) {}
}

struct AudioCell(UnsafeCell<Box<dyn AudioStage>>);

// SAFETY: only the dedicated audio thread dereferences the cell. The main thread owns and moves
// the surrounding Box but never accesses its interior after publication; retirement proves the
// audio thread has stopped using a dropped cell before main destroys it.
unsafe impl Sync for AudioCell {}

pub struct StageInstance {
    audio: Box<AudioCell>,
    control: Box<dyn ControlStage>,
    initial_params: Vec<ResolvedParam>,
    construction_generation: u64,
    has_audio_input: bool,
}

impl StageInstance {
    pub fn new(
        audio: Box<dyn AudioStage>,
        control: Box<dyn ControlStage>,
        initial_params: Vec<ResolvedParam>,
        construction_generation: u64,
        has_audio_input: bool,
    ) -> Self {
        Self {
            audio: Box::new(AudioCell(UnsafeCell::new(audio))),
            control,
            initial_params,
            construction_generation,
            has_audio_input,
        }
    }

    fn audio_ptr(&self) -> *mut AudioCell {
        ptr::from_ref(self.audio.as_ref()).cast_mut()
    }
}

pub trait StageFactory {
    fn load(&mut self, spec: &StageSpec, index: usize) -> Result<Box<StageInstance>, String>;

    fn write_state(&mut self, path: &Path, bytes: &[u8]) -> Result<(), String> {
        orbit_audio_sandbox::write_sidecar(
            path.to_str()
                .ok_or_else(|| format!("state path is not UTF-8: {}", path.display()))?,
            bytes,
        )
        .map_err(|error| format!("write {}: {error}", path.display()))
    }
}

struct StageEntry {
    audio: *mut AudioCell,
    enabled: bool,
    params: Vec<ResolvedParam>,
}

struct StageList {
    entries: Vec<StageEntry>,
    apply_params_once: bool,
    #[cfg(test)]
    drop_threads: Option<Arc<std::sync::Mutex<Vec<std::thread::ThreadId>>>>,
}

// SAFETY: every pointer targets an `AudioCell` whose boxed allocation is kept alive by the main
// controller until this list has returned through the retire slot.
unsafe impl Send for StageList {}

#[cfg(test)]
impl Drop for StageList {
    fn drop(&mut self) {
        if let Some(drop_threads) = &self.drop_threads {
            drop_threads
                .lock()
                .expect("stage-list drop-thread log")
                .push(std::thread::current().id());
        }
    }
}

/// One-pending/one-retired generation exchange between main and audio threads.
pub struct ChainExchange {
    pending: AtomicPtr<StageList>,
    generation: AtomicU64,
    retired: AtomicPtr<StageList>,
}

impl ChainExchange {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            pending: AtomicPtr::new(ptr::null_mut()),
            generation: AtomicU64::new(0),
            retired: AtomicPtr::new(ptr::null_mut()),
        })
    }

    fn publish(&self, list: Box<StageList>) -> Result<u64, Box<StageList>> {
        let raw = Box::into_raw(list);
        match self.pending.compare_exchange(
            ptr::null_mut(),
            raw,
            Ordering::AcqRel,
            Ordering::Acquire,
        ) {
            Ok(_) => Ok(self.generation.fetch_add(1, Ordering::Release) + 1),
            Err(_) => Err(unsafe { Box::from_raw(raw) }),
        }
    }

    fn collect_retired(&self) -> Option<Box<StageList>> {
        let raw = self.retired.swap(ptr::null_mut(), Ordering::AcqRel);
        (!raw.is_null()).then(|| unsafe { Box::from_raw(raw) })
    }

    fn has_pending(&self) -> bool {
        !self.pending.load(Ordering::Acquire).is_null()
    }
}

impl Drop for ChainExchange {
    fn drop(&mut self) {
        for slot in [&self.pending, &self.retired] {
            let raw = slot.swap(ptr::null_mut(), Ordering::AcqRel);
            if !raw.is_null() {
                drop(unsafe { Box::from_raw(raw) });
            }
        }
    }
}

/// Audio-thread owner of the currently visible stage list.
pub struct AudioChain {
    exchange: Arc<ChainExchange>,
    current: Box<StageList>,
    observed_generation: u64,
    /// audio スレッドで起きた param 適用失敗の累計。
    ///
    /// 🔴 audio スレッドからログを出せない（確保・ロック・syscall 禁止）ため、ここへ積んで
    /// **main スレッドが読み出して報告する**。`child_process_error_count` と同じ方式。
    param_apply_errors: Arc<AtomicU64>,
}

impl AudioChain {
    fn new(exchange: Arc<ChainExchange>, current: Box<StageList>) -> Self {
        Self {
            exchange,
            current,
            observed_generation: 0,
            param_apply_errors: Arc::new(AtomicU64::new(0)),
        }
    }

    /// main スレッドから読む: audio スレッドで起きた param 適用失敗の累計。
    pub fn param_apply_errors(&self) -> Arc<AtomicU64> {
        Arc::clone(&self.param_apply_errors)
    }

    fn adopt_at_block_boundary(&mut self) {
        let generation = self.exchange.generation.load(Ordering::Acquire);
        if generation == self.observed_generation {
            return;
        }
        // This is the only read/exchange of the pending pointer, and it occurs before traversal.
        let next = self
            .exchange
            .pending
            .swap(ptr::null_mut(), Ordering::AcqRel);
        if next.is_null() {
            return;
        }
        let next = unsafe { Box::from_raw(next) };
        let previous = std::mem::replace(&mut self.current, next);
        let previous = Box::into_raw(previous);
        if self
            .exchange
            .retired
            .compare_exchange(
                ptr::null_mut(),
                previous,
                Ordering::Release,
                Ordering::Relaxed,
            )
            .is_err()
        {
            panic!("rack retire slot was not collected before the next swap");
        }
        self.observed_generation = generation;
    }

    /// Process one whole block through the list captured at the block boundary.
    pub fn process_block(&mut self, block: &mut [f32], active_stage: &AtomicU32) -> usize {
        self.adopt_at_block_boundary();
        if self.current.apply_params_once {
            for entry in &self.current.entries {
                if !entry.params.is_empty() {
                    let stage = unsafe { &mut *(*entry.audio).0.get() };
                    // 🔴 ここは audio スレッド。**確保・ロック・syscall は禁止**なので
                    // `eprintln!` を呼んではいけない（フォーマット確保 + stderr ロック +
                    // write syscall がオーディオコールバック内で走る）。失敗は atomic の
                    // カウンタに積むだけにして、**実際のログ出力は main スレッド**が行う。
                    if stage.apply_params(&entry.params).is_err() {
                        self.param_apply_errors.fetch_add(1, Ordering::Relaxed);
                    }
                }
            }
            self.current.apply_params_once = false;
        }

        let mut errors = 0;
        for (index, entry) in self.current.entries.iter().enumerate() {
            active_stage.store(index as u32, Ordering::Relaxed);
            if !entry.enabled {
                continue;
            }
            let stage = unsafe { &mut *(*entry.audio).0.get() };
            if !stage.process_block(block) {
                errors += 1;
            }
        }
        errors
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApplyFailureKind {
    BadArgument,
    Plugin,
    Io,
    Busy,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApplyFailure {
    pub kind: ApplyFailureKind,
    pub failed_index: Option<usize>,
    pub detail: String,
}

impl ApplyFailure {
    pub fn command_outcome(&self) -> CommandOutcome {
        let result = match self.kind {
            ApplyFailureKind::BadArgument | ApplyFailureKind::Busy => CMD_RESULT_BAD_ARG,
            ApplyFailureKind::Plugin => CMD_RESULT_PLUGIN_ERROR,
            ApplyFailureKind::Io => CMD_RESULT_IO_ERROR,
        };
        let detail = match self.failed_index {
            Some(index) => format!("failed index {index}: {}", self.detail),
            None => self.detail.clone(),
        };
        CommandOutcome::failed(result, detail)
    }
}

enum PreparedStage {
    Keep {
        prev_index: usize,
        enabled: bool,
        params: Vec<ResolvedParam>,
    },
    Load {
        stage: Box<StageInstance>,
        enabled: bool,
    },
}

/// Main-thread chain controller.
// Each stage must have a stable allocation because published StageList entries contain pointers
// into it while the Vec itself is reordered during keep operations.
#[allow(clippy::vec_box)]
pub struct RackController {
    exchange: Arc<ChainExchange>,
    stages: Vec<Box<StageInstance>>,
    pending_stage_drops: Vec<Box<StageInstance>>,
}

impl RackController {
    pub fn load_initial(
        exchange: Arc<ChainExchange>,
        factory: &mut impl StageFactory,
        specs: &[StageSpec],
        child_status: &AtomicU32,
    ) -> Result<(Self, AudioChain), ApplyFailure> {
        let mut stages = Vec::with_capacity(specs.len());
        for (index, spec) in specs.iter().enumerate() {
            if matches!(spec, StageSpec::Layer { .. }) {
                child_status.store(
                    orbit_audio_sandbox::transport::CHILD_STATUS_LOAD_FAILED,
                    Ordering::Release,
                );
                return Err(ApplyFailure {
                    kind: ApplyFailureKind::BadArgument,
                    failed_index: Some(index),
                    detail: "layer stages are reserved; v1 racks are serial only".into(),
                });
            }
            match factory.load(spec, index) {
                Ok(stage) => stages.push(stage),
                Err(detail) => {
                    child_status.store(
                        orbit_audio_sandbox::transport::CHILD_STATUS_LOAD_FAILED,
                        Ordering::Release,
                    );
                    return Err(ApplyFailure {
                        kind: ApplyFailureKind::Plugin,
                        failed_index: Some(index),
                        detail,
                    });
                }
            }
        }
        let list = Self::stage_list(&stages, specs.iter().map(StageSpec::enabled));
        let audio = AudioChain::new(exchange.clone(), list);
        Ok((
            Self {
                exchange,
                stages,
                pending_stage_drops: Vec::new(),
            },
            audio,
        ))
    }

    fn stage_list(
        stages: &[Box<StageInstance>],
        enabled: impl IntoIterator<Item = bool>,
    ) -> Box<StageList> {
        Box::new(StageList {
            entries: stages
                .iter()
                .zip(enabled)
                .map(|(stage, enabled)| StageEntry {
                    audio: stage.audio_ptr(),
                    enabled,
                    params: stage.initial_params.clone(),
                })
                .collect(),
            apply_params_once: true,
            #[cfg(test)]
            drop_threads: None,
        })
    }

    pub fn has_audio_input(&self) -> bool {
        self.stages.iter().any(|stage| stage.has_audio_input)
    }

    pub fn stage_count(&self) -> usize {
        self.stages.len()
    }

    pub fn construction_generation(&self, index: usize) -> Option<u64> {
        self.stages
            .get(index)
            .map(|stage| stage.construction_generation)
    }

    /// Main-thread retire collection. Dropped plugin instances are destroyed only here.
    pub fn collect_retired(&mut self) -> bool {
        let Some(retired) = self.exchange.collect_retired() else {
            return false;
        };
        drop(retired);
        self.pending_stage_drops.clear();
        true
    }

    pub fn apply(
        &mut self,
        plan: &ApplyPlan,
        factory: &mut impl StageFactory,
    ) -> Result<(), ApplyFailure> {
        if plan.version != 1 {
            return Err(ApplyFailure {
                kind: ApplyFailureKind::BadArgument,
                failed_index: None,
                detail: format!("unsupported chain plan version {}", plan.version),
            });
        }
        self.collect_retired();
        if self.exchange.has_pending() || !self.pending_stage_drops.is_empty() {
            return Err(ApplyFailure {
                kind: ApplyFailureKind::Busy,
                failed_index: None,
                detail: "previous chain swap has not reached a block boundary".into(),
            });
        }

        // State capture is part of prepare: every write completes before the one publish below.
        for dropped in &plan.save_dropped {
            let Some(stage) = self.stages.get_mut(dropped.prev_index) else {
                return Err(ApplyFailure {
                    kind: ApplyFailureKind::BadArgument,
                    failed_index: Some(dropped.prev_index),
                    detail: "save_dropped index is outside the previous chain".into(),
                });
            };
            if stage.control.is_standard() {
                return Err(ApplyFailure {
                    kind: ApplyFailureKind::BadArgument,
                    failed_index: Some(dropped.prev_index),
                    detail: "standard stages have no state".into(),
                });
            }
            let bytes = stage
                .control
                .capture_state()
                .map_err(|detail| ApplyFailure {
                    kind: ApplyFailureKind::Plugin,
                    failed_index: Some(dropped.prev_index),
                    detail,
                })?;
            factory
                .write_state(&dropped.path, &bytes)
                .map_err(|detail| ApplyFailure {
                    kind: ApplyFailureKind::Io,
                    failed_index: Some(dropped.prev_index),
                    detail,
                })?;
        }

        let mut kept = HashSet::new();
        let mut prepared = Vec::with_capacity(plan.stages.len());
        for (new_index, operation) in plan.stages.iter().enumerate() {
            match operation {
                PlanStage::Keep {
                    prev_index,
                    enabled,
                    params,
                } => {
                    if !kept.insert(*prev_index) {
                        return Err(ApplyFailure {
                            kind: ApplyFailureKind::BadArgument,
                            failed_index: Some(new_index),
                            detail: format!("prev_index {prev_index} is kept more than once"),
                        });
                    }
                    let Some(stage) = self.stages.get_mut(*prev_index) else {
                        return Err(ApplyFailure {
                            kind: ApplyFailureKind::BadArgument,
                            failed_index: Some(new_index),
                            detail: format!(
                                "prev_index {prev_index} is outside the previous chain"
                            ),
                        });
                    };
                    let params =
                        stage
                            .control
                            .resolve_params(params)
                            .map_err(|detail| ApplyFailure {
                                kind: ApplyFailureKind::Plugin,
                                failed_index: Some(new_index),
                                detail,
                            })?;
                    prepared.push(PreparedStage::Keep {
                        prev_index: *prev_index,
                        enabled: *enabled,
                        params,
                    });
                }
                PlanStage::Load { stage: spec } => {
                    if matches!(spec, StageSpec::Layer { .. }) {
                        return Err(ApplyFailure {
                            kind: ApplyFailureKind::BadArgument,
                            failed_index: Some(new_index),
                            detail: "layer stages are reserved; v1 racks are serial only".into(),
                        });
                    }
                    let stage = factory
                        .load(spec, new_index)
                        .map_err(|detail| ApplyFailure {
                            kind: ApplyFailureKind::Plugin,
                            failed_index: Some(new_index),
                            detail,
                        })?;
                    prepared.push(PreparedStage::Load {
                        stage,
                        enabled: spec.enabled(),
                    });
                }
            }
        }

        let entries = prepared
            .iter()
            .map(|prepared| match prepared {
                PreparedStage::Keep {
                    prev_index,
                    enabled,
                    params,
                } => StageEntry {
                    audio: self.stages[*prev_index].audio_ptr(),
                    enabled: *enabled,
                    params: params.clone(),
                },
                PreparedStage::Load { stage, enabled } => StageEntry {
                    audio: stage.audio_ptr(),
                    enabled: *enabled,
                    params: stage.initial_params.clone(),
                },
            })
            .collect();
        let next_list = Box::new(StageList {
            entries,
            apply_params_once: true,
            #[cfg(test)]
            drop_threads: None,
        });

        // Commit is exactly one pointer publication after every fallible prepare operation.
        self.exchange.publish(next_list).map_err(|_| ApplyFailure {
            kind: ApplyFailureKind::Busy,
            failed_index: None,
            detail: "chain publish slot is busy".into(),
        })?;

        let mut previous: Vec<_> = std::mem::take(&mut self.stages)
            .into_iter()
            .map(Some)
            .collect();
        let mut next = Vec::with_capacity(prepared.len());
        for (index, prepared) in prepared.into_iter().enumerate() {
            let stage = match prepared {
                PreparedStage::Keep { prev_index, .. } => previous[prev_index]
                    .take()
                    .expect("duplicate keeps were rejected during prepare"),
                PreparedStage::Load { stage, .. } => stage,
            };
            stage.control.set_index(index as u32);
            next.push(stage);
        }
        for dropped in previous.into_iter().flatten() {
            let _ = dropped.control.handle_ui(false, None);
            self.pending_stage_drops.push(dropped);
        }
        self.stages = next;
        Ok(())
    }

    pub fn save_state_at(
        &mut self,
        index: usize,
        path: &Path,
        factory: &mut impl StageFactory,
    ) -> CommandOutcome {
        let Some(stage) = self.stages.get_mut(index) else {
            return CommandOutcome::failed(
                CMD_RESULT_BAD_ARG,
                format!("stage index {index} is out of range"),
            );
        };
        if stage.control.is_standard() {
            return CommandOutcome::failed(CMD_RESULT_BAD_ARG, "standard stages have no state");
        }
        let bytes = match stage.control.capture_state() {
            Ok(bytes) => bytes,
            Err(detail) => return CommandOutcome::failed(CMD_RESULT_PLUGIN_ERROR, detail),
        };
        match factory.write_state(path, &bytes) {
            Ok(()) => CommandOutcome::ok(bytes.len() as u64),
            Err(detail) => CommandOutcome::failed(CMD_RESULT_IO_ERROR, detail),
        }
    }

    pub fn handle_ui_at(&self, index: usize, open: bool, title: Option<&str>) -> CommandOutcome {
        let Some(stage) = self.stages.get(index) else {
            return CommandOutcome::failed(
                CMD_RESULT_BAD_ARG,
                format!("stage index {index} is out of range"),
            );
        };
        if stage.control.is_standard() {
            return CommandOutcome::failed(
                CMD_RESULT_BAD_ARG,
                "standard plugin parameters live in the DSL; no UI is available",
            );
        }
        stage.control.handle_ui(open, title)
    }

    pub fn tick_ui(&self) {
        for stage in &self.stages {
            stage.control.tick_ui();
        }
        for stage in &self.pending_stage_drops {
            stage.control.tick_ui();
        }
    }
}

pub fn ok_outcome() -> CommandOutcome {
    CommandOutcome {
        result: CMD_RESULT_OK,
        len: 0,
        detail: String::new(),
    }
}

#[cfg(test)]
mod tests;
