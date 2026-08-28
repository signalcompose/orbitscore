#![cfg(target_os = "macos")]

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering::{Acquire, Relaxed, Release};

use anyhow::{bail, Context, Result};
use orbit_audio_sandbox::{
    open_shared, region_ptr, slot_index, slot_offset, CommandOutcome, ParentWatch, BUF_LEN,
    CHANNELS, CMD_APPLY_CHAIN, CMD_CLOSE_UI, CMD_CLOSE_UI_AT, CMD_OPEN_UI, CMD_OPEN_UI_AT,
    CMD_RESULT_BAD_ARG, CMD_SAVE_STATE_AT, CONTROL_QUIT, MAX_FRAMES,
};
use orbit_child_runtime::{
    child_should_quit, run_child, PluginMainHandle, UiCallbacks, UiEventHub, UiService,
};
use orbit_clap_host::{ClapEffectAudio, ClapEffectProcessor, ClapParamValue, ClapPluginMain};
use orbit_vst3_host::{Vst3EffectAudio, Vst3EffectProcessor, Vst3PluginMain};
use serde::Deserialize;

use crate::{
    host_format_for_path, ok_outcome, read_apply_plan, read_manifest, resolve_standard_plugin_path,
    ApplyFailure, AudioStage, ChainExchange, ControlStage, HostFormat, RackController,
    ResolvedParam, StageFactory, StageInstance, StageSpec,
};

struct Args {
    shm: PathBuf,
    chain: PathBuf,
    sample_rate: u32,
}

fn parse_args() -> Result<Args> {
    let mut shm = None;
    let mut chain = None;
    let mut sample_rate = 48_000;
    let mut args = std::env::args().skip(1);
    while let Some(argument) = args.next() {
        match argument.as_str() {
            "--shm" => {
                shm = Some(PathBuf::from(
                    args.next().context("--shm requires a value")?,
                ))
            }
            "--chain" => {
                chain = Some(PathBuf::from(
                    args.next().context("--chain requires a value")?,
                ))
            }
            "--sample-rate" => {
                sample_rate = args
                    .next()
                    .context("--sample-rate requires a value")?
                    .parse()
                    .context("parse --sample-rate")?;
            }
            other => bail!("unknown argument: {other}"),
        }
    }
    Ok(Args {
        shm: shm.context("--shm is required")?,
        chain: chain.context("--chain is required")?,
        sample_rate,
    })
}

struct ClapRackAudio(ClapEffectAudio);

impl AudioStage for ClapRackAudio {
    fn apply_params(&mut self, params: &[ResolvedParam]) -> Result<(), String> {
        let values: Vec<_> = params
            .iter()
            .map(|param| ClapParamValue {
                id: param.id,
                value: param.value,
            })
            .collect();
        self.0.apply_param_values(&values)
    }

    fn process_block(&mut self, block: &mut [f32]) -> bool {
        self.0.process_block(block)
    }
}

struct Vst3RackAudio(Vst3EffectAudio);

impl AudioStage for Vst3RackAudio {
    fn process_block(&mut self, block: &mut [f32]) -> bool {
        self.0.process_block(block)
    }
}

struct ClapControl {
    ui: UiService,
    main: PluginMainHandle<ClapPluginMain>,
    standard: bool,
}

impl ControlStage for ClapControl {
    fn capture_state(&mut self) -> Result<Vec<u8>, String> {
        if self.standard {
            return Err("standard stages have no state".into());
        }
        self.main
            .with_mut(ClapPluginMain::capture_state)
            .map_err(|error| error.to_string())
    }

    fn resolve_params(
        &mut self,
        params: &BTreeMap<String, f64>,
    ) -> Result<Vec<ResolvedParam>, String> {
        if params.is_empty() {
            return Ok(Vec::new());
        }
        if !self.standard {
            return Err("catalog plugin parameter updates are staged with #522".into());
        }
        params
            .iter()
            .map(|(name, value)| {
                let id = self
                    .main
                    .with_mut(|main| main.parameter_id_by_name(name))
                    .ok_or_else(|| {
                        format!("standard plugin has no CLAP parameter named {name:?}")
                    })?;
                Ok(ResolvedParam { id, value: *value })
            })
            .collect()
    }

    fn is_standard(&self) -> bool {
        self.standard
    }

    fn handle_ui(&self, open: bool, title: Option<&str>) -> CommandOutcome {
        self.ui.handle_command(
            if open { CMD_OPEN_UI } else { CMD_CLOSE_UI },
            if open { title } else { None },
        )
    }

    fn tick_ui(&self) {
        self.ui.tick(self.ui.now());
    }

    fn set_index(&self, index: u32) {
        self.ui.set_index(index);
    }
}

struct Vst3Control {
    ui: UiService,
    main: PluginMainHandle<Vst3PluginMain>,
}

impl ControlStage for Vst3Control {
    fn capture_state(&mut self) -> Result<Vec<u8>, String> {
        self.main
            .with_mut(|main| main.capture_state())
            .map_err(|error| error.to_string())
    }

    fn resolve_params(
        &mut self,
        params: &BTreeMap<String, f64>,
    ) -> Result<Vec<ResolvedParam>, String> {
        if params.is_empty() {
            Ok(Vec::new())
        } else {
            Err("catalog plugin parameter updates are staged with #522".into())
        }
    }

    fn is_standard(&self) -> bool {
        false
    }

    fn handle_ui(&self, open: bool, title: Option<&str>) -> CommandOutcome {
        self.ui.handle_command(
            if open { CMD_OPEN_UI } else { CMD_CLOSE_UI },
            if open { title } else { None },
        )
    }

    fn tick_ui(&self) {
        self.ui.tick(self.ui.now());
    }

    fn set_index(&self, index: u32) {
        self.ui.set_index(index);
    }
}

pub(crate) struct ActualFactory {
    region: *mut orbit_audio_sandbox::SharedRegion,
    ui_events: UiEventHub,
    executable: PathBuf,
    standard_dir: Option<PathBuf>,
    sample_rate: u32,
    next_generation: u64,
}

impl ActualFactory {
    pub(crate) fn new(
        region: *mut orbit_audio_sandbox::SharedRegion,
        sample_rate: u32,
    ) -> Result<Self> {
        Ok(Self {
            region,
            ui_events: UiEventHub::new(region),
            executable: std::env::current_exe().context("resolve rack child executable")?,
            standard_dir: std::env::var_os("ORBIT_STD_PLUGIN_DIR").map(PathBuf::from),
            sample_rate,
            next_generation: 1,
        })
    }

    #[cfg(test)]
    pub(crate) fn set_standard_dir(&mut self, directory: PathBuf) {
        self.standard_dir = Some(directory);
    }

    fn generation(&mut self) -> u64 {
        let generation = self.next_generation;
        self.next_generation += 1;
        generation
    }

    fn load_clap(
        &mut self,
        path: &Path,
        plugin_id: Option<&str>,
        state: Option<&Path>,
        params: &BTreeMap<String, f64>,
        standard: bool,
        index: usize,
    ) -> Result<Box<StageInstance>, String> {
        let state = state
            .map(|path| {
                std::fs::read(path).map_err(|error| format!("read {}: {error}", path.display()))
            })
            .transpose()?;
        let (effect, _) = ClapEffectProcessor::load(
            path,
            plugin_id,
            self.sample_rate,
            CHANNELS,
            MAX_FRAMES as u32,
            state.as_deref(),
        )
        .map_err(|error| format!("load CLAP {}: {error}", path.display()))?;
        let has_audio_input = effect.has_audio_input();
        let (audio, main) = effect.split();
        let (ui, main) = UiService::new_indexed(
            self.region,
            index as u32,
            self.ui_events.clone(),
            main,
            |main| UiCallbacks {
                closed: main.take_closed(),
                requested_size: main.take_requested_size(),
            },
        );
        let mut control = ClapControl { ui, main, standard };
        let initial_params = control.resolve_params(params)?;
        Ok(Box::new(StageInstance::new(
            Box::new(ClapRackAudio(audio)),
            Box::new(control),
            initial_params,
            self.generation(),
            has_audio_input,
        )))
    }

    fn load_vst3(
        &mut self,
        path: &Path,
        state: Option<&Path>,
        index: usize,
    ) -> Result<Box<StageInstance>, String> {
        let state = state
            .map(|path| {
                std::fs::read(path).map_err(|error| format!("read {}: {error}", path.display()))
            })
            .transpose()?;
        let (effect, info) = Vst3EffectProcessor::load(
            path,
            self.sample_rate as f64,
            MAX_FRAMES as i32,
            state.as_deref(),
        )
        .map_err(|error| format!("load VST3 {}: {error}", path.display()))?;
        let (audio, main) = effect.split();
        let (ui, main) = UiService::new_indexed(
            self.region,
            index as u32,
            self.ui_events.clone(),
            main,
            |main| UiCallbacks {
                closed: None,
                requested_size: main.take_requested_size(),
            },
        );
        Ok(Box::new(StageInstance::new(
            Box::new(Vst3RackAudio(audio)),
            Box::new(Vst3Control { ui, main }),
            Vec::new(),
            self.generation(),
            info.audio_inputs > 0,
        )))
    }
}

impl StageFactory for ActualFactory {
    fn load(&mut self, spec: &StageSpec, index: usize) -> Result<Box<StageInstance>, String> {
        match spec {
            StageSpec::Catalog {
                path,
                plugin_id,
                state,
                ..
            } => match host_format_for_path(path)? {
                HostFormat::Clap => self.load_clap(
                    path,
                    plugin_id.as_deref(),
                    state.as_deref(),
                    &BTreeMap::new(),
                    false,
                    index,
                ),
                HostFormat::Vst3 => self.load_vst3(path, state.as_deref(), index),
            },
            StageSpec::Standard { name, params, .. } => {
                let path = resolve_standard_plugin_path(
                    &self.executable,
                    self.standard_dir.as_deref(),
                    name,
                )?;
                self.load_clap(&path, None, None, params, true, index)
            }
            StageSpec::Layer { .. } => {
                Err("layer stages are reserved; v1 racks are serial only".into())
            }
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StateAtArg {
    index: usize,
    path: PathBuf,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OpenUiAtArg {
    index: usize,
    #[serde(default)]
    title: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CloseUiAtArg {
    index: usize,
}

fn parse_command_arg<T: for<'de> Deserialize<'de>>(arg: Option<&str>) -> Result<T, CommandOutcome> {
    let Some(arg) = arg.filter(|arg| !arg.is_empty()) else {
        return Err(CommandOutcome::failed(
            CMD_RESULT_BAD_ARG,
            "command argument is empty or invalid UTF-8",
        ));
    };
    serde_json::from_str(arg).map_err(|error| {
        CommandOutcome::failed(CMD_RESULT_BAD_ARG, format!("invalid command JSON: {error}"))
    })
}

fn apply_outcome(error: ApplyFailure) -> CommandOutcome {
    error.command_outcome()
}

pub fn run() -> Result<()> {
    // 🔴 root 3: this child has no other way to surface a diagnostic. Its stderr is inherited by
    // the daemon (`Stdio::inherit()`), so a plain `tracing_subscriber::fmt()` here lands directly
    // on the daemon's own stderr stream in the same timestamp+level format the daemon's own
    // tracing uses — the extension's stderr classifier already recognizes that shape as
    // non-error for TRACE/DEBUG/INFO (see `isDaemonNonErrorTracingLine`), so only genuine
    // WARN/ERROR events here surface as `ERROR:` in `get_log`. `eprintln!`/`println!` would not:
    // they carry no level token and would either drown real errors or get misclassified as one.
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_ansi(false)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let args = parse_args()?;
    let mmap = open_shared(&args.shm).with_context(|| format!("open_shared({:?})", args.shm))?;
    let region = region_ptr(&mmap);
    let manifest = read_manifest(&args.chain).map_err(anyhow::Error::msg)?;
    let exchange = ChainExchange::new();
    let mut factory = ActualFactory::new(region, args.sample_rate)?;
    let (controller, mut audio_chain) = match RackController::load_initial(
        exchange,
        &mut factory,
        &manifest.stages,
        unsafe { &(*region).child_status },
        |detail| unsafe {
            if !orbit_audio_sandbox::transport::write_cstr_field(
                &mut (*region).cmd_result_detail,
                detail,
            ) {
                let _ = orbit_audio_sandbox::transport::write_cstr_field(
                    &mut (*region).cmd_result_detail,
                    "detail too long",
                );
            }
        },
    ) {
        Ok(pair) => pair,
        Err(failure) => {
            // Root 3-3: `child_status` alone tells the daemon *that* the load failed, but the
            // READY-wait loop that observes it (`load_outproc_effect_chain_impl`) has no way
            // to read *why* unless we hand it the detail here. The mailbox's
            // `cmd_result_detail` field is otherwise untouched at this point in startup (no
            // command has been issued yet), so it is safe to reuse as the carrier — the
            // daemon reads it only when it has just observed `CHILD_STATUS_LOAD_FAILED`.
            //
            // 🔴 Ordering is enforced inside `load_initial`, not here: it funnels every failure
            // through one exit that calls this closure and *then* stores `CHILD_STATUS_LOAD_FAILED`
            // with `Release`. The daemon polls that status and reads the detail the moment it sees
            // the failure, so publishing the status first would leave a window in which it reads an
            // empty field and falls back to the generic exit-status message — exactly the silent
            // degradation this root is meant to remove. By the time this arm runs, both writes have
            // already happened in the right order; `c08` pins that order by recording the status as
            // seen from inside this closure.
            return Err(anyhow::anyhow!("{}", failure.command_outcome().detail));
        }
    };

    unsafe {
        orbit_audio_sandbox::transport::publish_child_ready(region, controller.has_audio_input());
    }

    // Root 3-1: `AudioChain::param_apply_errors` is a counter the audio thread cannot log itself
    // (no allocation/lock/syscall on that thread). Nothing previously read it back despite the
    // comment on the field promising "the main thread reads and reports this" in two places —
    // grepping the workspace found zero call sites. Take the handle before `audio_chain` moves
    // into the audio closure below, and drain it from the service loop, which already runs
    // repeatedly regardless of mailbox activity.
    let param_apply_errors = audio_chain.param_apply_errors();
    let mut last_reported_param_apply_errors = 0u64;

    let controller = RefCell::new(controller);
    let factory = RefCell::new(factory);
    let parent_watch = ParentWatch::new();
    let region_addr = region as usize;
    let process_errors = run_child(
        "orbit-effect-rack-child",
        || unsafe { child_should_quit(region, &parent_watch) },
        || {
            unsafe {
                orbit_audio_sandbox::service_command_mailbox(region, |kind, arg| {
                    let outcome = match kind {
                        CMD_APPLY_CHAIN => {
                            let Some(path) = arg.filter(|arg| !arg.is_empty()) else {
                                return Some(CommandOutcome::failed(
                                    CMD_RESULT_BAD_ARG,
                                    "CMD_APPLY_CHAIN requires a plan manifest path",
                                ));
                            };
                            match read_apply_plan(Path::new(path)) {
                                Ok(plan) => match controller
                                    .borrow_mut()
                                    .apply(&plan, &mut *factory.borrow_mut())
                                {
                                    Ok(()) => ok_outcome(),
                                    Err(error) => apply_outcome(error),
                                },
                                Err(detail) => CommandOutcome::failed(CMD_RESULT_BAD_ARG, detail),
                            }
                        }
                        CMD_SAVE_STATE_AT => match parse_command_arg::<StateAtArg>(arg) {
                            Ok(arg) => controller.borrow_mut().save_state_at(
                                arg.index,
                                &arg.path,
                                &mut *factory.borrow_mut(),
                            ),
                            Err(outcome) => outcome,
                        },
                        CMD_OPEN_UI_AT => match parse_command_arg::<OpenUiAtArg>(arg) {
                            Ok(arg) => controller.borrow().handle_ui_at(
                                arg.index,
                                true,
                                arg.title.as_deref(),
                            ),
                            Err(outcome) => outcome,
                        },
                        CMD_CLOSE_UI_AT => match parse_command_arg::<CloseUiAtArg>(arg) {
                            Ok(arg) => controller.borrow().handle_ui_at(arg.index, false, None),
                            Err(outcome) => outcome,
                        },
                        _ => return None,
                    };
                    Some(outcome)
                });
            }
            controller.borrow().tick_ui();
            controller.borrow_mut().collect_retired();
            let total = param_apply_errors.load(Relaxed);
            if total != last_reported_param_apply_errors {
                tracing::warn!(
                    total,
                    delta = total.saturating_sub(last_reported_param_apply_errors),
                    "audio thread rejected one or more parameter updates"
                );
                last_reported_param_apply_errors = total;
            }
            false
        },
        move |stop_audio| {
            let region = region_addr as *mut orbit_audio_sandbox::SharedRegion;
            let mut scratch = vec![0.0f32; BUF_LEN];
            let mut process_errors = 0u64;
            let mut last = 0u64;
            loop {
                if stop_audio.load(Relaxed)
                    || unsafe { (*region).control.load(Relaxed) } == CONTROL_QUIT
                {
                    break;
                }
                let current = unsafe { (*region).seq_request.load(Acquire) };
                if current <= last {
                    std::hint::spin_loop();
                    continue;
                }
                let slot = slot_index(current);
                let offset = slot_offset(current);
                let count = unsafe {
                    let frames = ((*region).n_frames[slot].load(Relaxed) as usize).min(MAX_FRAMES);
                    let count = frames * CHANNELS;
                    let input = std::ptr::addr_of!((*region).input) as *const f32;
                    std::ptr::copy_nonoverlapping(input.add(offset), scratch.as_mut_ptr(), count);
                    count
                };
                let errors = audio_chain.process_block(&mut scratch[..count], unsafe {
                    &(*region).active_stage_index
                });
                if errors > 0 {
                    process_errors += errors as u64;
                    unsafe {
                        (*region)
                            .child_process_error_count
                            .fetch_add(errors as u64, Relaxed);
                    }
                }
                unsafe {
                    let output = std::ptr::addr_of_mut!((*region).output) as *mut f32;
                    std::ptr::copy_nonoverlapping(scratch.as_ptr(), output.add(offset), count);
                    (*region).child_processed.fetch_add(1, Relaxed);
                    (*region).seq_tag[slot].store(current, Release);
                    (*region).seq_done.store(current, Release);
                }
                last = current;
            }
            process_errors
        },
    )?;

    if process_errors > 0 {
        eprintln!(
            "[orbit-effect-rack-child] plugin processing failed {process_errors} stage-block time(s); affected stages stayed dry"
        );
    }
    Ok(())
}
