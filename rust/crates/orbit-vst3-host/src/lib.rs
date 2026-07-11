//! orbit-vst3-host — Phase 1 (#381) in-process VST3 hosting library, used in-process by
//! `orbit-vst3-effect-child`.
//!
//! Load a macOS `.vst3` bundle, instantiate the first "Audio Module Class", negotiate the host
//! context / edit-controller handshake and audio bus arrangement, and process f32 stereo blocks
//! on the same home thread the plugin was loaded on. Grew out of the Phase 0 (#381) offline
//! feasibility spike documented in `docs/development/POST_2.0_VST3_HOSTING_PLAN.md`; the
//! production surface (host application/component-handler callbacks, bus negotiation,
//! `process_block`) is exercised by `orbit-vst3-effect-child`, which is spawned/supervised by
//! the daemon.

#![cfg(target_os = "macos")]

use std::cell::{Cell, RefCell};
use std::error::Error;
use std::ffi::{c_void, CString};
use std::fmt::{Display, Formatter};
use std::marker::PhantomData;
use std::path::{Path, PathBuf};
use std::ptr;
use std::rc::Rc;

use core_foundation_sys::base::{kCFAllocatorDefault, CFRelease};
use core_foundation_sys::bundle::{
    CFBundleCreate, CFBundleGetFunctionPointerForName, CFBundleLoadExecutable, CFBundleRef,
    CFBundleUnloadExecutable,
};
use core_foundation_sys::string::{kCFStringEncodingUTF8, CFStringCreateWithCString, CFStringRef};
use core_foundation_sys::url::{kCFURLPOSIXPathStyle, CFURLCreateWithFileSystemPath, CFURLRef};
use vst3::Steinberg::Vst::*;
use vst3::Steinberg::*;
use vst3::{Class, ComPtr, ComWrapper};

const AUDIO_MODULE_CLASS: &str = "Audio Module Class";
const DEFAULT_CHANNELS: usize = 2;

type GetPluginFactory = unsafe extern "system" fn() -> *mut IPluginFactory;
type BundleEntry = unsafe extern "system" fn(*mut c_void) -> bool;
type BundleExit = unsafe extern "system" fn() -> bool;

#[derive(Debug)]
pub enum Vst3HostError {
    Io {
        path: PathBuf,
        message: String,
    },
    InvalidBundle(PathBuf),
    BundleLoad(String),
    MissingSymbol(&'static str),
    NullFactory,
    NoAudioModuleClass,
    CreateInstance(tresult),
    QueryAudioProcessor,
    Controller(tresult),
    Initialize(tresult),
    BusArrangement(tresult),
    SampleSize(tresult),
    SetupProcessing(tresult),
    SetActive(tresult),
    SetProcessing(tresult),
    Process(tresult),
    UnsupportedChannels {
        input: i32,
        output: i32,
    },
    UnsupportedPrimaryBusLayout {
        direction: &'static str,
        channels: i32,
    },
}

impl Display for Vst3HostError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io { path, message } => write!(f, "{}: {message}", path.display()),
            Self::InvalidBundle(path) => write!(f, "invalid VST3 bundle: {}", path.display()),
            Self::BundleLoad(message) => write!(f, "CFBundle load failed: {message}"),
            Self::MissingSymbol(symbol) => write!(f, "missing symbol: {symbol}"),
            Self::NullFactory => write!(f, "GetPluginFactory returned null"),
            Self::NoAudioModuleClass => write!(f, "no Audio Module Class in VST3 factory"),
            Self::CreateInstance(result) => {
                write!(f, "IPluginFactory::createInstance failed: {result}")
            }
            Self::QueryAudioProcessor => write!(f, "queryInterface(IAudioProcessor) failed"),
            Self::Controller(result) => write!(f, "controller handshake failed: {result}"),
            Self::Initialize(result) => write!(f, "IComponent::initialize failed: {result}"),
            Self::BusArrangement(result) => {
                write!(f, "IAudioProcessor::setBusArrangements failed: {result}")
            }
            Self::SetupProcessing(result) => {
                write!(f, "IAudioProcessor::setupProcessing failed: {result}")
            }
            Self::SampleSize(result) => write!(
                f,
                "IAudioProcessor::canProcessSampleSize(kSample32) failed: {result}"
            ),
            Self::SetActive(result) => write!(f, "IComponent::setActive failed: {result}"),
            Self::SetProcessing(result) => {
                write!(f, "IAudioProcessor::setProcessing failed: {result}")
            }
            Self::Process(result) => write!(f, "IAudioProcessor::process failed: {result}"),
            Self::UnsupportedChannels { input, output } => {
                write!(
                    f,
                    "unsupported channel layout: input={input}, output={output}"
                )
            }
            Self::UnsupportedPrimaryBusLayout {
                direction,
                channels,
            } => write!(
                f,
                "primary {direction} bus is not stereo (expected {DEFAULT_CHANNELS} channels, got {channels})"
            ),
        }
    }
}

impl Error for Vst3HostError {}

#[derive(Debug, Clone)]
pub struct LoadedVst3Info {
    pub name: String,
    pub audio_inputs: i32,
    pub audio_outputs: i32,
    pub is_effect: bool,
}

pub struct ProcessReport {
    pub processed: bool,
    pub is_effect: bool,
}

struct LoadedLibrary {
    bundle: CFBundleRef,
    bundle_exit_called: bool,
}

impl LoadedLibrary {
    fn open(bundle_path: &Path) -> Result<Self, Vst3HostError> {
        if bundle_path.extension().and_then(|ext| ext.to_str()) != Some("vst3") {
            return Err(Vst3HostError::InvalidBundle(bundle_path.to_path_buf()));
        }
        let bundle_path = bundle_path.canonicalize().map_err(|error| {
            Vst3HostError::BundleLoad(format!("{}: {error}", bundle_path.display()))
        })?;
        let path_string = bundle_path.to_str().ok_or_else(|| {
            Vst3HostError::BundleLoad(format!("non-UTF8 bundle path: {}", bundle_path.display()))
        })?;
        let cf_path = CfString::new(path_string)?;
        let url = unsafe {
            CFURLCreateWithFileSystemPath(
                kCFAllocatorDefault,
                cf_path.as_ref(),
                kCFURLPOSIXPathStyle,
                1,
            )
        };
        let url = CfUrl::from_raw(url).ok_or_else(|| {
            Vst3HostError::BundleLoad(format!(
                "CFURLCreateWithFileSystemPath failed: {}",
                bundle_path.display()
            ))
        })?;
        let bundle = unsafe { CFBundleCreate(kCFAllocatorDefault, url.as_ref()) };
        if bundle.is_null() {
            return Err(Vst3HostError::BundleLoad(format!(
                "CFBundleCreate failed: {}",
                bundle_path.display()
            )));
        }
        let mut loaded = Self {
            bundle,
            bundle_exit_called: false,
        };
        if unsafe { CFBundleLoadExecutable(loaded.bundle) } == 0 {
            return Err(Vst3HostError::BundleLoad(format!(
                "CFBundleLoadExecutable failed: {}",
                bundle_path.display()
            )));
        }

        if let Some(entry) = unsafe { loaded.function::<BundleEntry>("bundleEntry") }
            .or_else(|| unsafe { loaded.function::<BundleEntry>("BundleEntry") })
        {
            // VST3/CFBundle convention: `bundleEntry` returning `false` means module init failed
            // (JUCE treats this as a hard load failure too). Abort before `get_factory()` instead
            // of silently continuing against an uninitialized module.
            if unsafe { entry(loaded.bundle.cast::<c_void>()) } {
                loaded.bundle_exit_called = true;
            } else {
                return Err(Vst3HostError::BundleLoad(format!(
                    "bundleEntry returned false: {}",
                    bundle_path.display()
                )));
            }
        }

        Ok(loaded)
    }

    unsafe fn get_factory(&self) -> Result<ComPtr<IPluginFactory>, Vst3HostError> {
        let get_factory = self
            .function::<GetPluginFactory>("GetPluginFactory")
            .ok_or(Vst3HostError::MissingSymbol("GetPluginFactory"))?;
        let raw = get_factory();
        ComPtr::from_raw(raw).ok_or(Vst3HostError::NullFactory)
    }

    unsafe fn function<T>(&self, name: &str) -> Option<T>
    where
        T: Copy,
    {
        let cf_name = CfString::new(name).ok()?;
        let ptr = CFBundleGetFunctionPointerForName(self.bundle, cf_name.as_ref());
        if ptr.is_null() {
            None
        } else {
            Some(std::mem::transmute_copy(&ptr))
        }
    }
}

impl Drop for LoadedLibrary {
    fn drop(&mut self) {
        if self.bundle_exit_called {
            unsafe {
                let exit = self
                    .function::<BundleExit>("bundleExit")
                    .or_else(|| self.function::<BundleExit>("BundleExit"));
                if let Some(exit) = exit {
                    let _ = exit();
                }
            }
        }
        unsafe {
            CFBundleUnloadExecutable(self.bundle);
            CFRelease(self.bundle.cast());
        }
    }
}

struct CfString(CFStringRef);

impl CfString {
    fn new(value: &str) -> Result<Self, Vst3HostError> {
        let c_string = CString::new(value)
            .map_err(|_| Vst3HostError::BundleLoad(format!("string contains NUL: {value}")))?;
        let raw = unsafe {
            CFStringCreateWithCString(
                kCFAllocatorDefault,
                c_string.as_ptr(),
                kCFStringEncodingUTF8,
            )
        };
        if raw.is_null() {
            Err(Vst3HostError::BundleLoad(format!(
                "CFStringCreateWithCString failed: {value}"
            )))
        } else {
            Ok(Self(raw))
        }
    }

    fn as_ref(&self) -> CFStringRef {
        self.0
    }
}

impl Drop for CfString {
    fn drop(&mut self) {
        unsafe {
            CFRelease(self.0.cast());
        }
    }
}

struct CfUrl(CFURLRef);

impl CfUrl {
    fn from_raw(raw: CFURLRef) -> Option<Self> {
        if raw.is_null() {
            None
        } else {
            Some(Self(raw))
        }
    }

    fn as_ref(&self) -> CFURLRef {
        self.0
    }
}

impl Drop for CfUrl {
    fn drop(&mut self) {
        unsafe {
            CFRelease(self.0.cast());
        }
    }
}

/// Single-threaded VST3 effect processor.
///
/// `Rc` makes this type `!Send` and `!Sync`. Construct, process, and drop it on the same home
/// thread. Shutdown call order (`setProcessing` → disconnect → `controller.terminate` →
/// `component.setActive(0)`/`terminate`) is enforced by the hand-written `Drop::drop` body below
/// via explicit `.take()` calls, not by field declaration order. Field order is load-bearing only
/// for the *implicit* drop of the fields `Drop::drop` does not `.take()`: `_component_handler`
/// and `_host_context` must be declared (and therefore dropped) before `_library`, so any COM
/// callback objects backed by the plugin's vtables are released before the dynamic library is
/// unloaded.
pub struct Vst3EffectProcessor {
    processor: Option<ComPtr<IAudioProcessor>>,
    controller: Option<ComPtr<IEditController>>,
    component_connection: Option<ComPtr<IConnectionPoint>>,
    controller_connection: Option<ComPtr<IConnectionPoint>>,
    component: Option<ComPtr<IComponent>>,
    _component_handler: Option<ComWrapper<HostComponentHandler>>,
    _host_context: ComWrapper<HostApplication>,
    factory: Option<ComPtr<IPluginFactory>>,
    _home_thread: PhantomData<Rc<()>>,
    _library: LoadedLibrary,
    info: LoadedVst3Info,
    sample_rate: f64,
    /// `IProcessContextRequirements` flags queried once at load time (`load()`). The plugin's
    /// requirements do not change over its lifetime, so re-querying per block would be a wasted
    /// COM `queryInterface` + call on the RT hot path.
    process_context_requirements: u32,
    /// Stateless stub `IParameterChanges`/`IEventList` instances shared by `process_stereo` and
    /// `process_block`. `HostParameterChanges::empty()`/`HostEventList` always answer the same way
    /// regardless of call count, so a single instance can be reused instead of allocating
    /// (`ComWrapper::new` = `Arc`) on every block.
    output_parameter_changes: ParameterChanges,
    input_events: EventList,
    output_events: EventList,
    /// Empty input `IParameterChanges` for `process_block`, which never carries parameter
    /// automation (unlike `process_stereo`'s optional per-call gain).
    block_parameter_changes: ParameterChanges,
    process_input_l: Vec<f32>,
    process_input_r: Vec<f32>,
    process_output_l: Vec<f32>,
    process_output_r: Vec<f32>,
}

impl Vst3EffectProcessor {
    pub fn load(
        bundle_path: &Path,
        sample_rate: f64,
        max_samples_per_block: i32,
    ) -> Result<(Self, LoadedVst3Info), Vst3HostError> {
        let library = LoadedLibrary::open(bundle_path)?;
        let factory = unsafe { library.get_factory()? };
        let class = find_audio_module_class(&factory)?;

        let mut component_raw = ptr::null_mut();
        let create_result = unsafe {
            factory.createInstance(
                class.cid.as_ptr() as FIDString,
                IComponent_iid.as_ptr() as FIDString,
                &mut component_raw,
            )
        };
        if !is_ok(create_result) {
            return Err(Vst3HostError::CreateInstance(create_result));
        }
        let component = unsafe { ComPtr::from_raw(component_raw as *mut IComponent) }
            .ok_or(Vst3HostError::CreateInstance(create_result))?;

        let host_context = ComWrapper::new(HostApplication);
        let host_context_ptr = host_context
            .as_com_ref::<IHostApplication>()
            .expect("HostApplication exposes IHostApplication")
            .as_ptr()
            .cast::<FUnknown>();
        let init_result = unsafe { component.initialize(host_context_ptr) };
        if !is_ok(init_result) {
            return Err(Vst3HostError::Initialize(init_result));
        }

        let processor = component
            .as_com_ref()
            .cast::<IAudioProcessor>()
            .ok_or(Vst3HostError::QueryAudioProcessor)?;
        let sample_size_result =
            unsafe { processor.canProcessSampleSize(SymbolicSampleSizes_::kSample32 as i32) };
        if !is_ok(sample_size_result) {
            return Err(Vst3HostError::SampleSize(sample_size_result));
        }
        let controller_handshake =
            connect_controller(&factory, &component, &host_context, host_context_ptr)?;

        let input_buses = unsafe {
            component.getBusCount(MediaTypes_::kAudio as i32, BusDirections_::kInput as i32)
        };
        let output_buses = unsafe {
            component.getBusCount(MediaTypes_::kAudio as i32, BusDirections_::kOutput as i32)
        };
        let is_effect = input_buses > 0;

        configure_audio_buses(&component, &processor, input_buses, output_buses)?;

        let mut setup = ProcessSetup {
            processMode: ProcessModes_::kRealtime as i32,
            symbolicSampleSize: SymbolicSampleSizes_::kSample32 as i32,
            maxSamplesPerBlock: max_samples_per_block,
            sampleRate: sample_rate,
        };
        let setup_result = unsafe { processor.setupProcessing(&mut setup) };
        if !is_ok(setup_result) {
            return Err(Vst3HostError::SetupProcessing(setup_result));
        }

        // `is_effect` drives both `process_block`'s overwrite-vs-add-mix branch (used in
        // production by `orbit-vst3-effect-child`) and the probe / two-pass signal check below
        // (`probe_effect_signal`), which only verifies the effect overwrite path. This detection
        // is separate from CLAP's `has_audio_input`; treating an instrument as an effect would be
        // silent-but-wrong because the dry signal would be overwritten instead of add-mixed.
        let info = LoadedVst3Info {
            name: class.name,
            audio_inputs: input_buses,
            audio_outputs: output_buses,
            is_effect,
        };

        let active_result = unsafe { component.setActive(1) };
        if !is_ok(active_result) {
            return Err(Vst3HostError::SetActive(active_result));
        }

        // setProcessing は optional。kNotImplemented(=3) を返すプラグイン（例: iZotope
        // Ozone/RX/Neutron 系）は多く、VST3 的に合法。JUCE も kNotImplemented を非致命として
        // 続行する（warnOnFailureIfImplemented）。ここで hard error にすると iZotope 全滅する。
        let processing_result = unsafe { processor.setProcessing(1) };
        if !is_ok(processing_result) && processing_result != kNotImplemented {
            return Err(Vst3HostError::SetProcessing(processing_result));
        }

        // Queried once: the plugin's process-context requirements are fixed for its lifetime, so
        // `process_context()` reads this cache instead of re-querying `IProcessContextRequirements`
        // on every block.
        let process_context_requirements = unsafe {
            processor
                .as_com_ref()
                .cast::<IProcessContextRequirements>()
                .map(|requirements| requirements.getProcessContextRequirements())
                .unwrap_or(0)
        };

        let scratch_len = max_samples_per_block.max(0) as usize;
        let processor = Self {
            processor: Some(processor),
            controller: controller_handshake.controller,
            component_connection: controller_handshake.component_connection,
            controller_connection: controller_handshake.controller_connection,
            component: Some(component),
            _component_handler: controller_handshake.component_handler,
            _host_context: host_context,
            factory: Some(factory),
            _home_thread: PhantomData,
            _library: library,
            info: info.clone(),
            sample_rate,
            process_context_requirements,
            output_parameter_changes: ParameterChanges::empty(),
            input_events: EventList::empty(),
            output_events: EventList::empty(),
            block_parameter_changes: ParameterChanges::empty(),
            process_input_l: vec![0.0; scratch_len],
            process_input_r: vec![0.0; scratch_len],
            process_output_l: vec![0.0; scratch_len],
            process_output_r: vec![0.0; scratch_len],
        };
        Ok((processor, info))
    }

    pub fn info(&self) -> &LoadedVst3Info {
        &self.info
    }

    pub fn process_stereo(
        &mut self,
        input_l: &[f32],
        input_r: &[f32],
        output_l: &mut [f32],
        output_r: &mut [f32],
        gain: Option<f64>,
    ) -> Result<ProcessReport, Vst3HostError> {
        if input_l.len() != input_r.len()
            || input_l.len() != output_l.len()
            || input_l.len() != output_r.len()
        {
            return Err(Vst3HostError::UnsupportedChannels {
                input: input_l.len() as i32,
                output: output_l.len() as i32,
            });
        }

        let frames = input_l.len();
        let input_ptrs = [input_l.as_ptr() as *mut f32, input_r.as_ptr() as *mut f32];
        let output_ptrs = [output_l.as_mut_ptr(), output_r.as_mut_ptr()];

        // process_stereo is the non-RT probe/offline-parity path; gain varies per call, so unlike
        // process_block's `block_parameter_changes` this cannot be cached on `self`.
        let parameter_changes = gain
            .map(ParameterChanges::single_gain)
            .unwrap_or_else(ParameterChanges::empty);

        let result = self.run_process(input_ptrs, output_ptrs, frames, &parameter_changes);
        if !is_ok(result) {
            return Err(Vst3HostError::Process(result));
        }
        Ok(ProcessReport {
            processed: true,
            is_effect: self.info.is_effect,
        })
    }

    /// Interleaved stereo f32 blockを in-place で処理する child / offline parity 用 API。
    ///
    /// effect（audio input busあり）は overwrite、instrument（audio input busなし）は add-mix。
    /// 失敗時は `data` を dry のまま残して `false` を返す。
    #[must_use]
    pub fn process_block(&mut self, data: &mut [f32]) -> bool {
        if !data.len().is_multiple_of(DEFAULT_CHANNELS) {
            return false;
        }
        let frames = data.len() / DEFAULT_CHANNELS;
        if frames > self.process_input_l.len() {
            return false;
        }

        for frame in 0..frames {
            let base = frame * DEFAULT_CHANNELS;
            self.process_input_l[frame] = data[base];
            self.process_input_r[frame] = data[base + 1];
            self.process_output_l[frame] = 0.0;
            self.process_output_r[frame] = 0.0;
        }

        let input_ptrs = [
            self.process_input_l.as_mut_ptr(),
            self.process_input_r.as_mut_ptr(),
        ];
        let output_ptrs = [
            self.process_output_l.as_mut_ptr(),
            self.process_output_r.as_mut_ptr(),
        ];

        let result = self.run_process(
            input_ptrs,
            output_ptrs,
            frames,
            &self.block_parameter_changes,
        );
        if !is_ok(result) {
            return false;
        }

        for frame in 0..frames {
            let base = frame * DEFAULT_CHANNELS;
            if self.info.is_effect {
                data[base] = self.process_output_l[frame];
                data[base + 1] = self.process_output_r[frame];
            } else {
                data[base] += self.process_output_l[frame];
                data[base + 1] += self.process_output_r[frame];
            }
        }
        true
    }

    /// Shared `AudioBusBuffers`/`ProcessData` assembly + `IAudioProcessor::process` call for
    /// `process_stereo` and `process_block`. `input_ptrs`/`output_ptrs` must each point at
    /// `frames` valid, writable (for output) `f32` samples for the lifetime of this call; both
    /// callers guarantee this via their scratch buffers / caller-provided slices.
    ///
    /// `is_effect` bus wiring (numInputs/inputs null-vs-populated) lives here so both callers stay
    /// in sync with the same effect/instrument branch.
    ///
    /// OOB note: only the primary (index 0) bus per direction is ever described here
    /// (`numInputs`/`numOutputs` are always 0-or-1), always as a fixed `DEFAULT_CHANNELS`-wide
    /// buffer. `verify_primary_bus_is_stereo` (called from `configure_audio_buses` at load time)
    /// rejects plugins whose primary bus isn't stereo, so this fixed-width assembly cannot read
    /// or write out of bounds for a plugin that passed load. Extra buses beyond index 0 on a
    /// multi-bus plugin are simply never wired (known limitation, not a crash risk — see
    /// `real_plugin_gated.rs`'s instrument commentary).
    fn run_process(
        &self,
        mut input_ptrs: [*mut f32; 2],
        mut output_ptrs: [*mut f32; 2],
        frames: usize,
        parameter_changes: &ParameterChanges,
    ) -> tresult {
        let processor = self
            .processor
            .as_ref()
            .expect("processor remains alive until drop");

        let mut inputs = [AudioBusBuffers {
            numChannels: DEFAULT_CHANNELS as i32,
            silenceFlags: 0,
            __field0: AudioBusBuffers__type0 {
                channelBuffers32: input_ptrs.as_mut_ptr(),
            },
        }];
        let mut outputs = [AudioBusBuffers {
            numChannels: DEFAULT_CHANNELS as i32,
            silenceFlags: 0,
            __field0: AudioBusBuffers__type0 {
                channelBuffers32: output_ptrs.as_mut_ptr(),
            },
        }];

        let mut process_context = self.process_context();
        let mut process_data = ProcessData {
            processMode: ProcessModes_::kRealtime as i32,
            symbolicSampleSize: SymbolicSampleSizes_::kSample32 as i32,
            numSamples: frames as i32,
            numInputs: if self.info.is_effect { 1 } else { 0 },
            numOutputs: 1,
            inputs: if self.info.is_effect {
                inputs.as_mut_ptr()
            } else {
                ptr::null_mut()
            },
            outputs: outputs.as_mut_ptr(),
            inputParameterChanges: parameter_changes.as_ptr(),
            outputParameterChanges: self.output_parameter_changes.as_ptr(),
            inputEvents: self.input_events.as_ptr(),
            outputEvents: self.output_events.as_ptr(),
            processContext: &mut process_context,
        };

        unsafe { processor.process(&mut process_data) }
    }

    fn process_context(&self) -> ProcessContext {
        let mut state = ProcessContext_::StatesAndFlags_::kTempoValid
            | ProcessContext_::StatesAndFlags_::kTimeSigValid;
        let required = self.process_context_requirements;
        if required & IProcessContextRequirements_::Flags_::kNeedTransportState != 0 {
            state |= ProcessContext_::StatesAndFlags_::kPlaying;
        }
        if required & IProcessContextRequirements_::Flags_::kNeedProjectTimeMusic != 0 {
            state |= ProcessContext_::StatesAndFlags_::kProjectTimeMusicValid;
        }
        if required & IProcessContextRequirements_::Flags_::kNeedTempo != 0 {
            state |= ProcessContext_::StatesAndFlags_::kTempoValid;
        }
        if required & IProcessContextRequirements_::Flags_::kNeedTimeSignature != 0 {
            state |= ProcessContext_::StatesAndFlags_::kTimeSigValid;
        }
        ProcessContext {
            state,
            sampleRate: self.sample_rate,
            projectTimeSamples: 0,
            systemTime: 0,
            continousTimeSamples: 0,
            projectTimeMusic: 0.0,
            barPositionMusic: 0.0,
            cycleStartMusic: 0.0,
            cycleEndMusic: 0.0,
            tempo: 120.0,
            timeSigNumerator: 4,
            timeSigDenominator: 4,
            chord: Chord {
                keyNote: 0,
                rootNote: 0,
                chordMask: 0,
            },
            smpteOffsetSubframes: 0,
            frameRate: FrameRate {
                framesPerSecond: 0,
                flags: 0,
            },
            samplesToNextClock: 0,
        }
    }
}

impl Drop for Vst3EffectProcessor {
    fn drop(&mut self) {
        if let Some(processor) = self.processor.take() {
            unsafe {
                let _ = processor.setProcessing(0);
            }
        }
        if let (Some(component_connection), Some(controller_connection)) = (
            self.component_connection.as_ref(),
            self.controller_connection.as_ref(),
        ) {
            unsafe {
                let _ = component_connection.disconnect(controller_connection.as_ptr());
                let _ = controller_connection.disconnect(component_connection.as_ptr());
            }
        }
        let _ = self.component_connection.take();
        let _ = self.controller_connection.take();
        if let Some(controller) = self.controller.take() {
            unsafe {
                let _ = controller.terminate();
            }
        }
        if let Some(component) = self.component.take() {
            unsafe {
                let _ = component.setActive(0);
                let _ = component.terminate();
            }
        }
        let _ = self.factory.take();
    }
}

struct AudioModuleClass {
    cid: TUID,
    name: String,
}

struct ControllerHandshake {
    controller: Option<ComPtr<IEditController>>,
    component_connection: Option<ComPtr<IConnectionPoint>>,
    controller_connection: Option<ComPtr<IConnectionPoint>>,
    component_handler: Option<ComWrapper<HostComponentHandler>>,
}

fn connect_controller(
    factory: &ComPtr<IPluginFactory>,
    component: &ComPtr<IComponent>,
    _host_context: &ComWrapper<HostApplication>,
    host_context_ptr: *mut FUnknown,
) -> Result<ControllerHandshake, Vst3HostError> {
    let mut controller_cid = [0; 16];
    let cid_result = unsafe { component.getControllerClassId(&mut controller_cid) };
    if !is_ok(cid_result) {
        return Ok(ControllerHandshake {
            controller: None,
            component_connection: None,
            controller_connection: None,
            component_handler: None,
        });
    }

    let mut controller_raw = ptr::null_mut();
    let create_result = unsafe {
        factory.createInstance(
            controller_cid.as_ptr() as FIDString,
            IEditController_iid.as_ptr() as FIDString,
            &mut controller_raw,
        )
    };
    if !is_ok(create_result) {
        return Err(Vst3HostError::Controller(create_result));
    }
    let controller = unsafe { ComPtr::from_raw(controller_raw as *mut IEditController) }
        .ok_or(Vst3HostError::Controller(create_result))?;

    let init_result = unsafe { controller.initialize(host_context_ptr) };
    if !is_ok(init_result) {
        return Err(Vst3HostError::Controller(init_result));
    }

    let component_handler = ComWrapper::new(HostComponentHandler);
    let handler_ptr = component_handler
        .as_com_ref::<IComponentHandler>()
        .expect("HostComponentHandler exposes IComponentHandler")
        .as_ptr();
    let handler_result = unsafe { controller.setComponentHandler(handler_ptr) };
    if !is_ok(handler_result) {
        return Err(Vst3HostError::Controller(handler_result));
    }

    let component_connection = component.as_com_ref().cast::<IConnectionPoint>();
    let controller_connection = controller.as_com_ref().cast::<IConnectionPoint>();
    if let (Some(component_connection), Some(controller_connection)) =
        (&component_connection, &controller_connection)
    {
        unsafe {
            let _ = component_connection.connect(controller_connection.as_ptr());
            let _ = controller_connection.connect(component_connection.as_ptr());
        }
    }

    sync_component_state(component, &controller);

    Ok(ControllerHandshake {
        controller: Some(controller),
        component_connection,
        controller_connection,
        component_handler: Some(component_handler),
    })
}

fn sync_component_state(component: &ComPtr<IComponent>, controller: &ComPtr<IEditController>) {
    let stream_wrapper = ComWrapper::new(MemoryStream::new());
    let stream = stream_wrapper
        .to_com_ptr::<IBStream>()
        .expect("MemoryStream exposes IBStream");
    let get_result = unsafe { component.getState(stream.as_ptr()) };
    if is_ok(get_result) {
        unsafe {
            let mut pos = 0;
            let _ = stream.seek(0, IBStream_::IStreamSeekMode_::kIBSeekSet as i32, &mut pos);
            let _ = controller.setComponentState(stream.as_ptr());
        }
    }
}

fn configure_audio_buses(
    component: &ComPtr<IComponent>,
    processor: &ComPtr<IAudioProcessor>,
    input_buses: i32,
    output_buses: i32,
) -> Result<(), Vst3HostError> {
    let mut input_arrangements = arrangements_for_direction(
        component,
        processor,
        BusDirections_::kInput as i32,
        input_buses,
    );
    let mut output_arrangements = arrangements_for_direction(
        component,
        processor,
        BusDirections_::kOutput as i32,
        output_buses,
    );

    let mut result =
        set_bus_arrangements(processor, &mut input_arrangements, &mut output_arrangements);
    if !is_ok(result) {
        input_arrangements = plugin_reported_arrangements(
            processor,
            BusDirections_::kInput as i32,
            input_buses,
            &input_arrangements,
        );
        output_arrangements = plugin_reported_arrangements(
            processor,
            BusDirections_::kOutput as i32,
            output_buses,
            &output_arrangements,
        );
        result = set_bus_arrangements(processor, &mut input_arrangements, &mut output_arrangements);
    }
    // setBusArrangements は advisory（any non-OK, not just kResultFalse）。この tresult を返す
    // プラグイン（ARIA Player 等・特に instrument）はプラグイン既定の arrangement で動作する。
    // JUCE も致命扱いしない。ここで hard-fail すると「host 提案 arrangement を拒否するだけ」の
    // プラグインが全滅するので続行する。（厳密な buffer 整合は Phase 1 で getBusArrangement の
    // 実値に合わせる。）
    let _ = result;

    // `run_process`（lib.rs 内 `Vst3EffectProcessor::run_process`）は index 0 の 1 bus しか
    // process() に渡さない（`numInputs`/`numOutputs` は常に 0-or-1）。activate は process() が
    // 実際に触るバスだけに絞り、plugin 側の active-bus bookkeeping を host の実際の呼び出しと
    // 一致させる（多バス plugin で使わない bus を active のまま残す OOB リスクを避ける）。
    activate_primary_bus_only(component, BusDirections_::kInput as i32, input_buses);
    activate_primary_bus_only(component, BusDirections_::kOutput as i32, output_buses);

    // `run_process` は index 0 の primary バスの channel buffer を常に `DEFAULT_CHANNELS`(2) 幅の
    // `[*mut f32; 2]` として組み立てる。primary バスが stereo でないプラグイン（mono effect 等）を
    // 通すと OOB / 未初期化読み取りになるため、silent corruption ではなく load 失敗として reject する。
    // multi-bus プラグインで bus 0 が stereo なら extra バスは単に使わないだけで許容する。
    verify_primary_bus_is_stereo(component, input_buses, output_buses)?;

    Ok(())
}

fn set_bus_arrangements(
    processor: &ComPtr<IAudioProcessor>,
    input_arrangements: &mut [SpeakerArrangement],
    output_arrangements: &mut [SpeakerArrangement],
) -> tresult {
    unsafe {
        processor.setBusArrangements(
            ptr_or_null_mut(input_arrangements),
            input_arrangements.len() as i32,
            ptr_or_null_mut(output_arrangements),
            output_arrangements.len() as i32,
        )
    }
}

fn plugin_reported_arrangements(
    processor: &ComPtr<IAudioProcessor>,
    direction: BusDirection,
    bus_count: i32,
    fallback: &[SpeakerArrangement],
) -> Vec<SpeakerArrangement> {
    (0..bus_count)
        .map(|index| {
            let mut arrangement = 0;
            let result = unsafe { processor.getBusArrangement(direction, index, &mut arrangement) };
            if is_ok(result) && arrangement != 0 {
                arrangement
            } else {
                fallback
                    .get(index as usize)
                    .copied()
                    .unwrap_or(SpeakerArr::kStereo)
            }
        })
        .collect()
}

fn arrangements_for_direction(
    component: &ComPtr<IComponent>,
    processor: &ComPtr<IAudioProcessor>,
    direction: BusDirection,
    bus_count: i32,
) -> Vec<SpeakerArrangement> {
    (0..bus_count)
        .map(|index| {
            let channel_count = audio_bus_channel_count(component, direction, index);
            let mut arrangement = 0;
            let result = unsafe { processor.getBusArrangement(direction, index, &mut arrangement) };
            if is_ok(result) && arrangement != 0 {
                arrangement
            } else {
                arrangement_for_channels(channel_count)
            }
        })
        .collect()
}

fn audio_bus_channel_count(
    component: &ComPtr<IComponent>,
    direction: BusDirection,
    index: i32,
) -> i32 {
    let mut bus = BusInfo {
        mediaType: MediaTypes_::kAudio as i32,
        direction,
        channelCount: DEFAULT_CHANNELS as i32,
        name: [0; 128],
        busType: 0,
        flags: 0,
    };
    let result =
        unsafe { component.getBusInfo(MediaTypes_::kAudio as i32, direction, index, &mut bus) };
    if is_ok(result) && bus.channelCount > 0 {
        bus.channelCount
    } else {
        DEFAULT_CHANNELS as i32
    }
}

fn arrangement_for_channels(channel_count: i32) -> SpeakerArrangement {
    match channel_count {
        1 => SpeakerArr::kMono,
        2 => SpeakerArr::kStereo,
        _ => SpeakerArr::kStereo,
    }
}

/// Activates only bus index 0 for `direction` (if `bus_count > 0`). `run_process` describes a
/// single bus per direction to `process()`, so only that bus needs to be active; extra buses on
/// a multi-bus plugin are intentionally left inactive.
fn activate_primary_bus_only(
    component: &ComPtr<IComponent>,
    direction: BusDirection,
    bus_count: i32,
) {
    if bus_count <= 0 {
        return;
    }
    // activateBus は advisory: 一部プラグインは常に非 OK を返すが、bus 未 activate でも process()
    // が動くケースが多く（JUCE ホストも致命扱いしない）、失敗を診断 log に残すだけで続行する。
    let result = unsafe { component.activateBus(MediaTypes_::kAudio as i32, direction, 0, 1) };
    if !is_ok(result) {
        eprintln!(
            "[orbit-vst3-host] activateBus(direction={direction}, index=0) advisory failure: {result}"
        );
    }
}

/// `run_process` always wires the primary (index 0) bus as a `DEFAULT_CHANNELS`-wide (stereo)
/// buffer. Reject load if either primary bus that will actually be processed reports a different
/// channel count, instead of letting `run_process` read/write out of bounds.
fn verify_primary_bus_is_stereo(
    component: &ComPtr<IComponent>,
    input_buses: i32,
    output_buses: i32,
) -> Result<(), Vst3HostError> {
    if input_buses > 0 {
        let channels = audio_bus_channel_count(component, BusDirections_::kInput as i32, 0);
        if channels != DEFAULT_CHANNELS as i32 {
            return Err(Vst3HostError::UnsupportedPrimaryBusLayout {
                direction: "input",
                channels,
            });
        }
    }
    if output_buses > 0 {
        let channels = audio_bus_channel_count(component, BusDirections_::kOutput as i32, 0);
        if channels != DEFAULT_CHANNELS as i32 {
            return Err(Vst3HostError::UnsupportedPrimaryBusLayout {
                direction: "output",
                channels,
            });
        }
    }
    Ok(())
}

fn ptr_or_null_mut<T>(values: &mut [T]) -> *mut T {
    if values.is_empty() {
        ptr::null_mut()
    } else {
        values.as_mut_ptr()
    }
}

fn find_audio_module_class(
    factory: &ComPtr<IPluginFactory>,
) -> Result<AudioModuleClass, Vst3HostError> {
    let count = unsafe { factory.countClasses() };
    for index in 0..count {
        let mut info = PClassInfo {
            cid: [0; 16],
            cardinality: 0,
            category: [0; 32],
            name: [0; 64],
        };
        let result = unsafe { factory.getClassInfo(index, &mut info) };
        if !is_ok(result) {
            continue;
        }
        if char8_array_to_string(&info.category) == AUDIO_MODULE_CLASS {
            return Ok(AudioModuleClass {
                cid: info.cid,
                name: char8_array_to_string(&info.name),
            });
        }
    }
    Err(Vst3HostError::NoAudioModuleClass)
}

fn char8_array_to_string(data: &[i8]) -> String {
    let nul = data
        .iter()
        .position(|value| *value == 0)
        .unwrap_or(data.len());
    let bytes = data[..nul]
        .iter()
        .map(|value| *value as u8)
        .collect::<Vec<_>>();
    String::from_utf8_lossy(&bytes).into_owned()
}

fn is_ok(result: tresult) -> bool {
    result == kResultOk || result == kResultTrue
}

trait TuidPtr {
    fn as_ptr(&self) -> *const i8;
}

impl TuidPtr for TUID {
    fn as_ptr(&self) -> *const i8 {
        self.as_slice().as_ptr()
    }
}

struct HostApplication;

impl Class for HostApplication {
    type Interfaces = (IHostApplication,);
}

impl IHostApplicationTrait for HostApplication {
    unsafe fn getName(&self, name: *mut String128) -> tresult {
        if name.is_null() {
            return kInvalidArgument;
        }
        copy_wstring("OrbitScore VST3 Host Spike", &mut *name);
        kResultOk
    }

    unsafe fn createInstance(
        &self,
        _cid: *mut TUID,
        iid: *mut TUID,
        obj: *mut *mut c_void,
    ) -> tresult {
        if obj.is_null() {
            return kInvalidArgument;
        }
        *obj = ptr::null_mut();
        if iid.is_null() {
            return kInvalidArgument;
        }

        if *iid == IMessage_iid {
            let ptr = ComWrapper::new(HostMessage::new())
                .to_com_ptr::<IMessage>()
                .expect("HostMessage exposes IMessage")
                .into_raw();
            *obj = ptr.cast::<c_void>();
            kResultOk
        } else if *iid == IAttributeList_iid {
            let ptr = ComWrapper::new(HostAttributeList)
                .to_com_ptr::<IAttributeList>()
                .expect("HostAttributeList exposes IAttributeList")
                .into_raw();
            *obj = ptr.cast::<c_void>();
            kResultOk
        } else {
            kNotImplemented
        }
    }
}

struct HostMessage {
    message_id: Cell<*const i8>,
    attributes: ComWrapper<HostAttributeList>,
    attributes_ptr: Cell<*mut IAttributeList>,
}

impl HostMessage {
    fn new() -> Self {
        Self {
            message_id: Cell::new(ptr::null()),
            attributes: ComWrapper::new(HostAttributeList),
            attributes_ptr: Cell::new(ptr::null_mut()),
        }
    }

    fn attributes_ptr(&self) -> *mut IAttributeList {
        let existing = self.attributes_ptr.get();
        if !existing.is_null() {
            return existing;
        }
        let ptr = self
            .attributes
            .to_com_ptr::<IAttributeList>()
            .expect("HostAttributeList exposes IAttributeList")
            .into_raw();
        self.attributes_ptr.set(ptr);
        ptr
    }
}

impl Drop for HostMessage {
    fn drop(&mut self) {
        let ptr = self.attributes_ptr.get();
        if !ptr.is_null() {
            unsafe {
                if let Some(attributes) = ComPtr::from_raw(ptr) {
                    drop(attributes);
                }
            }
        }
    }
}

impl Class for HostMessage {
    type Interfaces = (IMessage,);
}

impl IMessageTrait for HostMessage {
    unsafe fn getMessageID(&self) -> FIDString {
        self.message_id.get()
    }

    unsafe fn setMessageID(&self, id: FIDString) {
        self.message_id.set(id);
    }

    unsafe fn getAttributes(&self) -> *mut IAttributeList {
        self.attributes_ptr()
    }
}

struct HostAttributeList;

impl Class for HostAttributeList {
    type Interfaces = (IAttributeList,);
}

impl IAttributeListTrait for HostAttributeList {
    unsafe fn setInt(&self, _id: IAttributeList_::AttrID, _value: i64) -> tresult {
        kResultOk
    }

    unsafe fn getInt(&self, _id: IAttributeList_::AttrID, value: *mut i64) -> tresult {
        if !value.is_null() {
            *value = 0;
        }
        kResultFalse
    }

    unsafe fn setFloat(&self, _id: IAttributeList_::AttrID, _value: f64) -> tresult {
        kResultOk
    }

    unsafe fn getFloat(&self, _id: IAttributeList_::AttrID, value: *mut f64) -> tresult {
        if !value.is_null() {
            *value = 0.0;
        }
        kResultFalse
    }

    unsafe fn setString(&self, _id: IAttributeList_::AttrID, _string: *const TChar) -> tresult {
        kResultOk
    }

    unsafe fn getString(
        &self,
        _id: IAttributeList_::AttrID,
        string: *mut TChar,
        size_in_bytes: u32,
    ) -> tresult {
        if !string.is_null() && size_in_bytes >= std::mem::size_of::<TChar>() as u32 {
            *string = 0;
        }
        kResultFalse
    }

    unsafe fn setBinary(
        &self,
        _id: IAttributeList_::AttrID,
        _data: *const c_void,
        _size_in_bytes: u32,
    ) -> tresult {
        kResultOk
    }

    unsafe fn getBinary(
        &self,
        _id: IAttributeList_::AttrID,
        data: *mut *const c_void,
        size_in_bytes: *mut u32,
    ) -> tresult {
        if !data.is_null() {
            *data = ptr::null();
        }
        if !size_in_bytes.is_null() {
            *size_in_bytes = 0;
        }
        kResultFalse
    }
}

fn copy_wstring(src: &str, dst: &mut [TChar]) {
    let mut len = 0;
    for (src, dst) in src.encode_utf16().zip(dst.iter_mut()) {
        *dst = src;
        len += 1;
    }

    if len < dst.len() {
        dst[len] = 0;
    } else if let Some(last) = dst.last_mut() {
        *last = 0;
    }
}

struct HostComponentHandler;

impl Class for HostComponentHandler {
    type Interfaces = (IComponentHandler,);
}

impl IComponentHandlerTrait for HostComponentHandler {
    unsafe fn beginEdit(&self, _id: ParamID) -> tresult {
        kResultOk
    }

    unsafe fn performEdit(&self, _id: ParamID, _value_normalized: ParamValue) -> tresult {
        kResultOk
    }

    unsafe fn endEdit(&self, _id: ParamID) -> tresult {
        kResultOk
    }

    unsafe fn restartComponent(&self, _flags: i32) -> tresult {
        kResultOk
    }
}

struct MemoryStream {
    data: RefCell<Vec<u8>>,
    pos: Cell<usize>,
}

impl MemoryStream {
    fn new() -> Self {
        Self {
            data: RefCell::new(Vec::new()),
            pos: Cell::new(0),
        }
    }
}

impl Class for MemoryStream {
    type Interfaces = (IBStream,);
}

impl IBStreamTrait for MemoryStream {
    unsafe fn read(
        &self,
        buffer: *mut c_void,
        num_bytes: i32,
        num_bytes_read: *mut i32,
    ) -> tresult {
        if buffer.is_null() || num_bytes < 0 {
            return kInvalidArgument;
        }
        let data = self.data.borrow();
        let pos = self.pos.get().min(data.len());
        let available = data.len().saturating_sub(pos);
        let to_read = available.min(num_bytes as usize);
        ptr::copy_nonoverlapping(data[pos..].as_ptr(), buffer.cast::<u8>(), to_read);
        self.pos.set(pos + to_read);
        if !num_bytes_read.is_null() {
            *num_bytes_read = to_read as i32;
        }
        kResultOk
    }

    unsafe fn write(
        &self,
        buffer: *mut c_void,
        num_bytes: i32,
        num_bytes_written: *mut i32,
    ) -> tresult {
        if buffer.is_null() || num_bytes < 0 {
            return kInvalidArgument;
        }
        let bytes = std::slice::from_raw_parts(buffer.cast::<u8>(), num_bytes as usize);
        let mut data = self.data.borrow_mut();
        let pos = self.pos.get();
        let end = pos.saturating_add(bytes.len());
        if end > data.len() {
            data.resize(end, 0);
        }
        data[pos..end].copy_from_slice(bytes);
        self.pos.set(end);
        if !num_bytes_written.is_null() {
            *num_bytes_written = bytes.len() as i32;
        }
        kResultOk
    }

    unsafe fn seek(&self, pos: i64, mode: i32, result: *mut i64) -> tresult {
        let len = self.data.borrow().len() as i64;
        let base = match mode as u32 {
            IBStream_::IStreamSeekMode_::kIBSeekSet => 0,
            IBStream_::IStreamSeekMode_::kIBSeekCur => self.pos.get() as i64,
            IBStream_::IStreamSeekMode_::kIBSeekEnd => len,
            _ => return kInvalidArgument,
        };
        let new_pos = base.saturating_add(pos).max(0) as usize;
        self.pos.set(new_pos);
        if !result.is_null() {
            *result = new_pos as i64;
        }
        kResultOk
    }

    unsafe fn tell(&self, pos: *mut i64) -> tresult {
        if !pos.is_null() {
            *pos = self.pos.get() as i64;
        }
        kResultOk
    }
}

struct EventList {
    _wrapper: ComWrapper<HostEventList>,
    ptr: ComPtr<IEventList>,
}

impl EventList {
    fn empty() -> Self {
        let wrapper = ComWrapper::new(HostEventList);
        let ptr = wrapper
            .to_com_ptr::<IEventList>()
            .expect("HostEventList exposes IEventList");
        Self {
            _wrapper: wrapper,
            ptr,
        }
    }

    fn as_ptr(&self) -> *mut IEventList {
        self.ptr.as_ptr()
    }
}

struct HostEventList;

impl Class for HostEventList {
    type Interfaces = (IEventList,);
}

impl IEventListTrait for HostEventList {
    unsafe fn getEventCount(&self) -> i32 {
        0
    }

    unsafe fn getEvent(&self, _index: i32, _event: *mut Event) -> tresult {
        kInvalidArgument
    }

    unsafe fn addEvent(&self, _event: *mut Event) -> tresult {
        kResultFalse
    }
}

struct ParameterChanges {
    _wrapper: ComWrapper<HostParameterChanges>,
    ptr: ComPtr<IParameterChanges>,
}

impl ParameterChanges {
    fn empty() -> Self {
        let wrapper = ComWrapper::new(HostParameterChanges::empty());
        let ptr = wrapper
            .to_com_ptr::<IParameterChanges>()
            .expect("HostParameterChanges exposes IParameterChanges");
        Self {
            _wrapper: wrapper,
            ptr,
        }
    }

    fn single_gain(value: f64) -> Self {
        let wrapper = ComWrapper::new(HostParameterChanges::single(0, value));
        let ptr = wrapper
            .to_com_ptr::<IParameterChanges>()
            .expect("HostParameterChanges exposes IParameterChanges");
        Self {
            _wrapper: wrapper,
            ptr,
        }
    }

    fn as_ptr(&self) -> *mut IParameterChanges {
        self.ptr.as_ptr()
    }
}

struct HostParameterChanges {
    queue: Option<ComWrapper<HostParamValueQueue>>,
    queue_ptr: Cell<*mut IParamValueQueue>,
}

impl HostParameterChanges {
    fn empty() -> Self {
        Self {
            queue: None,
            queue_ptr: Cell::new(ptr::null_mut()),
        }
    }

    fn single(param_id: ParamID, value: ParamValue) -> Self {
        Self {
            queue: Some(ComWrapper::new(HostParamValueQueue::new(param_id, value))),
            queue_ptr: Cell::new(ptr::null_mut()),
        }
    }

    fn queue_ptr(&self) -> *mut IParamValueQueue {
        let existing = self.queue_ptr.get();
        if !existing.is_null() {
            return existing;
        }
        let Some(queue) = self.queue.as_ref() else {
            return ptr::null_mut();
        };
        let ptr = queue
            .to_com_ptr::<IParamValueQueue>()
            .expect("HostParamValueQueue exposes IParamValueQueue")
            .into_raw();
        self.queue_ptr.set(ptr);
        ptr
    }
}

impl Drop for HostParameterChanges {
    fn drop(&mut self) {
        let ptr = self.queue_ptr.get();
        if !ptr.is_null() {
            unsafe {
                if let Some(queue) = ComPtr::from_raw(ptr) {
                    drop(queue);
                }
            }
        }
    }
}

impl Class for HostParameterChanges {
    type Interfaces = (IParameterChanges,);
}

impl IParameterChangesTrait for HostParameterChanges {
    unsafe fn getParameterCount(&self) -> i32 {
        if self.queue.is_some() {
            1
        } else {
            0
        }
    }

    unsafe fn getParameterData(&self, index: i32) -> *mut IParamValueQueue {
        if index == 0 {
            self.queue_ptr()
        } else {
            ptr::null_mut()
        }
    }

    unsafe fn addParameterData(
        &self,
        _id: *const ParamID,
        index: *mut i32,
    ) -> *mut IParamValueQueue {
        if !index.is_null() {
            *index = 0;
        }
        self.queue_ptr()
    }
}

struct HostParamValueQueue {
    param_id: ParamID,
    value: ParamValue,
}

impl HostParamValueQueue {
    fn new(param_id: ParamID, value: ParamValue) -> Self {
        Self { param_id, value }
    }
}

impl Class for HostParamValueQueue {
    type Interfaces = (IParamValueQueue,);
}

impl IParamValueQueueTrait for HostParamValueQueue {
    unsafe fn getParameterId(&self) -> ParamID {
        self.param_id
    }

    unsafe fn getPointCount(&self) -> i32 {
        1
    }

    unsafe fn getPoint(
        &self,
        index: i32,
        sample_offset: *mut i32,
        value: *mut ParamValue,
    ) -> tresult {
        if index != 0 {
            return kInvalidArgument;
        }
        if !sample_offset.is_null() {
            *sample_offset = 0;
        }
        if !value.is_null() {
            *value = self.value;
        }
        kResultTrue
    }

    unsafe fn addPoint(&self, _sample_offset: i32, _value: ParamValue, index: *mut i32) -> tresult {
        if !index.is_null() {
            *index = 0;
        }
        kResultFalse
    }
}

pub fn probe_plugin(path: &Path) -> ProbeResult {
    match Vst3EffectProcessor::load(path, 48_000.0, 512) {
        Ok((mut processor, info)) => {
            let (processed, error) = match probe_effect_signal(&mut processor) {
                Ok(()) => (true, None),
                Err(message) => (false, Some(message)),
            };
            ProbeResult {
                name: info.name,
                loaded: true,
                audio_in: info.audio_inputs,
                audio_out: info.audio_outputs,
                processed,
                error,
            }
        }
        Err(error) => ProbeResult {
            name: path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("<unknown>")
                .to_owned(),
            loaded: false,
            audio_in: 0,
            audio_out: 0,
            processed: false,
            error: Some(error.to_string()),
        },
    }
}

/// Runs the Phase 0 probe's two-pass signal check (silent-block then known-signal) against an
/// already-loaded effect processor. Instruments (no audio input bus) are not processed — Phase 0
/// only verifies the effect overwrite path (see `Vst3EffectProcessor::load`'s `is_effect` note).
fn probe_effect_signal(processor: &mut Vst3EffectProcessor) -> Result<(), String> {
    if !processor.info().is_effect {
        return Err("instrument/add-mix path detected; Phase 0 probe did not process".to_owned());
    }

    let input_l = vec![0.0; 512];
    let input_r = vec![0.0; 512];
    let mut output_l = vec![0.0; 512];
    let mut output_r = vec![0.0; 512];

    processor
        .process_stereo(&input_l, &input_r, &mut output_l, &mut output_r, None)
        .map_err(|error| error.to_string())?;
    validate_silent_block(&output_l, &output_r)?;

    let known_l = (0..512)
        .map(|i| (i as f32 - 128.0) / 512.0)
        .collect::<Vec<_>>();
    let known_r = (0..512)
        .map(|i| ((i as f32 * 3.0) - 256.0) / 1024.0)
        .collect::<Vec<_>>();
    output_l.fill(0.0);
    output_r.fill(0.0);

    processor
        .process_stereo(&known_l, &known_r, &mut output_l, &mut output_r, None)
        .map_err(|error| error.to_string())?;
    validate_known_block(&output_l, &output_r)
}

fn validate_silent_block(left: &[f32], right: &[f32]) -> Result<(), String> {
    for (label, samples) in [("left", left), ("right", right)] {
        for (index, sample) in samples.iter().enumerate() {
            if !sample.is_finite() {
                return Err(format!("silent {label} sample {index} is not finite"));
            }
            if sample.abs() > 1.0e-3 {
                return Err(format!(
                    "silent {label} sample {index} exceeded noise floor: {sample}"
                ));
            }
        }
    }
    Ok(())
}

fn validate_known_block(left: &[f32], right: &[f32]) -> Result<(), String> {
    for (label, samples) in [("left", left), ("right", right)] {
        for (index, sample) in samples.iter().enumerate() {
            if !sample.is_finite() {
                return Err(format!("known {label} sample {index} is not finite"));
            }
            if sample.abs() > 8.0 {
                return Err(format!("known {label} sample {index} diverged: {sample}"));
            }
        }
    }
    Ok(())
}

pub struct ProbeResult {
    pub name: String,
    pub loaded: bool,
    pub audio_in: i32,
    pub audio_out: i32,
    pub processed: bool,
    pub error: Option<String>,
}

impl ProbeResult {
    pub fn to_json_line(&self) -> String {
        format!(
            "{{\"name\":\"{}\",\"loaded\":{},\"audio_in\":{},\"audio_out\":{},\"processed\":{},\"error\":{}}}",
            json_escape(&self.name),
            self.loaded,
            self.audio_in,
            self.audio_out,
            self.processed,
            self.error
                .as_ref()
                .map(|error| format!("\"{}\"", json_escape(error)))
                .unwrap_or_else(|| "null".to_owned())
        )
    }
}

fn json_escape(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '"' => escaped.push_str("\\\""),
            '\\' => escaped.push_str("\\\\"),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\t' => escaped.push_str("\\t"),
            _ => escaped.push(ch),
        }
    }
    escaped
}

#[cfg(test)]
mod tests {
    use super::*;

    // I6(pr-review-team): `is_ok` gates every tresult check in this crate (setup/activate/process
    // ...) but had no direct unit test — pin the kResultOk/kResultTrue/kResultFalse/kNotImplemented
    // truth table.
    #[test]
    fn is_ok_treats_result_ok_and_result_true_as_success() {
        assert!(is_ok(kResultOk));
        assert!(is_ok(kResultTrue));
    }

    #[test]
    fn is_ok_treats_result_false_and_not_implemented_as_failure() {
        assert!(!is_ok(kResultFalse));
        assert!(!is_ok(kNotImplemented));
    }
}
