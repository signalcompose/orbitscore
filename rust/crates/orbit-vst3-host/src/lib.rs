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

mod view;

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

pub use view::Vst3UiEndpoint;

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
    ProcessBlockTooLarge {
        requested: usize,
        max: usize,
    },
    UnsupportedPrimaryBusLayout {
        direction: &'static str,
        channels: i32,
    },
    NotInstrument {
        input_buses: i32,
        output_buses: i32,
    },
    MissingEventInputBus,
    /// #540 P2: 保存済み state（.vstpreset / raw chunk）の解析・適用失敗。
    State(String),
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
            Self::ProcessBlockTooLarge { requested, max } => {
                write!(
                    f,
                    "process block too large: requested={requested}, max={max}"
                )
            }
            Self::UnsupportedPrimaryBusLayout {
                direction,
                channels,
            } => write!(
                f,
                "primary {direction} bus is not stereo (expected {DEFAULT_CHANNELS} channels, got {channels})"
            ),
            Self::NotInstrument {
                input_buses,
                output_buses,
            } => write!(
                f,
                "VST3 plugin is not an instrument (audio input buses={input_buses}, audio output buses={output_buses}); expected no audio input buses and at least one audio output bus"
            ),
            Self::MissingEventInputBus => {
                write!(f, "VST3 instrument has no event input bus")
            }
            Self::State(message) => write!(f, "plugin state restore failed: {message}"),
        }
    }
}

impl Error for Vst3HostError {}

/// Factory descriptor API used for one class.
///
/// A factory may expose a newer interface while returning an error for one descriptor, so the
/// level is recorded per class rather than once per module.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FactoryDescriptorApi {
    Factory3,
    Factory2,
    Factory1,
}

impl FactoryDescriptorApi {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Factory3 => "factory3",
            Self::Factory2 => "factory2",
            Self::Factory1 => "factory1",
        }
    }
}

/// Metadata obtainable from a VST3 factory without creating a component instance.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FactoryClassDescriptor {
    pub name: String,
    /// Uppercase 32-hex-digit VST3 class ID, matching `moduleinfo.json`'s CID shape.
    pub cid: String,
    pub category: String,
    pub sub_categories: String,
    pub vendor: String,
    pub version: String,
    pub sdk_version: String,
    pub descriptor_api: FactoryDescriptorApi,
}

/// Failures from the factory-only probe. These variants intentionally cover only module loading
/// and descriptor enumeration; component creation/initialization errors cannot occur in this API.
#[derive(Debug)]
pub enum FactoryProbeError {
    InvalidBundle(PathBuf),
    BundleLoad(String),
    MissingSymbol(&'static str),
    NullFactory,
    InvalidClassCount(i32),
    DescriptorRead {
        index: i32,
        factory3_result: Option<tresult>,
        factory2_result: Option<tresult>,
        factory1_result: tresult,
    },
}

impl Display for FactoryProbeError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidBundle(path) => {
                write!(f, "invalid VST3 bundle: {}", path.display())
            }
            Self::BundleLoad(message) => write!(f, "CFBundle load failed: {message}"),
            Self::MissingSymbol(symbol) => write!(f, "missing symbol: {symbol}"),
            Self::NullFactory => write!(f, "GetPluginFactory returned null"),
            Self::InvalidClassCount(count) => {
                write!(f, "IPluginFactory::countClasses returned {count}")
            }
            Self::DescriptorRead {
                index,
                factory3_result,
                factory2_result,
                factory1_result,
            } => write!(
                f,
                "factory descriptor read failed at index {index}: \
                 Factory3={factory3_result:?}, Factory2={factory2_result:?}, \
                 Factory1={factory1_result}"
            ),
        }
    }
}

impl Error for FactoryProbeError {}

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

/// Main(home)-thread half shared by the split VST3 effect / instrument processors (#474 P1).
///
/// Holds everything the per-block `process` call does **not** need: the component (state
/// capture), the controller handshake, the factory, and the dynamic library. `Rc` makes this
/// `!Send` — it stays on the thread that called `load` (the home thread), which is where the
/// VST3 `[main-thread]` contract wants `getState` (CAP.5 / UIH.1).
///
/// ## Teardown（🔴 順序が正しさの条件）
///
/// `Drop` はモノリシック時代の shutdown 列の **後半**（disconnect → `controller.terminate` →
/// `component.setActive(0)`/`terminate` → factory 解放）を実行する。前半の
/// `setProcessing(0)` は audio 側（[`Vst3EffectAudio`] / [`Vst3InstrumentAudio`]）の `Drop` が
/// 担うため、**audio 側が先に drop されていなければならない**:
/// - 未分割の composite（[`Vst3EffectProcessor`] / [`Vst3InstrumentProcessor`]）では
///   hand-written `Drop::drop` の明示的な `.take()` 列がこれを強制する
/// - 分割後（`split()`）は、main スレッドが **audio スレッドを join してから**本型を drop
///   することで強制する（`orbit-child-runtime` の関数構造がこの順序を持つ）
///
/// Field order is load-bearing for the *implicit* drops `Drop::drop` does not `.take()`:
/// `_component_handler` and `_host_context` must be declared (and therefore dropped) before
/// `_library`, so any COM callback objects backed by the plugin's vtables are released before
/// the dynamic library is unloaded.
pub struct Vst3PluginMain {
    ui_endpoint: Vst3UiEndpoint,
    controller: Option<ComPtr<IEditController>>,
    /// controller == component（単一コンポーネント plugin）のとき true（#603）。
    /// 理由は [`should_terminate_controller`] を参照。
    controller_shared_with_component: bool,
    component_connection: Option<ComPtr<IConnectionPoint>>,
    controller_connection: Option<ComPtr<IConnectionPoint>>,
    component: Option<ComPtr<IComponent>>,
    _component_handler: Option<ComWrapper<HostComponentHandler>>,
    _host_context: ComWrapper<HostApplication>,
    factory: Option<ComPtr<IPluginFactory>>,
    _home_thread: PhantomData<Rc<()>>,
    _library: LoadedLibrary,
    info: LoadedVst3Info,
}

impl Vst3PluginMain {
    /// Format-specific endpoint used by the AppKit-owning layer.
    pub fn ui_endpoint(&mut self) -> &mut Vst3UiEndpoint {
        &mut self.ui_endpoint
    }

    /// 現在の component state を取得する（空 state 拒否の規律込み）。
    ///
    /// **スレッド**: home（main）スレッドから呼ぶこと（CAP.5・VST3 の規約）。
    pub fn capture_state(&self) -> Result<Vec<u8>, Vst3HostError> {
        let component = self
            .component
            .as_ref()
            .ok_or_else(|| Vst3HostError::State("component is not loaded".into()))?;
        capture_component_state(component)
    }

    pub fn info(&self) -> &LoadedVst3Info {
        &self.info
    }
}

impl Drop for Vst3PluginMain {
    fn drop(&mut self) {
        // UIH.4: the editor view must be removed and released before controller termination.
        // Do not rely on field declaration order for this lifetime constraint.
        self.ui_endpoint.release_view();
        self.ui_endpoint.release_controller();

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
            if should_terminate_controller(self.controller_shared_with_component) {
                unsafe {
                    let _ = controller.terminate();
                }
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

/// 1 つの VST3 ホストセッションが宣言する処理圧（#598）。realtime が互換の既定。
///
/// CLAP 側の [`ClapRenderMode`](../../orbit_clap_host/enum.ClapRenderMode.html) と対になる概念で、
/// VST3 では `ProcessSetup.processMode` / `ProcessData.processMode` として渡す。
///
/// 🔴 **setup と process で同じ値を渡すこと。**
///
/// 一次ソース（`vst3_pluginterfaces/vst/ivstaudioprocessor.h`・`ProcessModes` の注記）の規定は
/// **一致そのものではなく切替の手順**である:
///
/// - `kRealtime` ↔ `kPrefetch` は **`setupProcessing` を呼ばずに** realtime thread で切り替えてよく、
///   plugin は `ProcessData::processMode` を毎 process で見ることが期待される
/// - `kRealtime`（または `kPrefetch`）↔ **`kOffline` の切替は host が `setupProcessing` を
///   呼ぶことを要求する**
///
/// 本 host の値域は `{Realtime, Offline}` の 2 値なので、上の第 2 項により
/// 「setup と process の不一致 = `setupProcessing` を経ない offline 切替 = 規定違反」となり、
/// 結果として一致が必須になる。`kPrefetch` を含む一般則ではない点に注意。
///
/// テスト用 oracle（`orbit-vst3-gain-oracle` / `orbit-vst3-synth-oracle`）は**全ての不一致**を
/// `kInvalidArgument` で弾く。これは仕様の再現ではなく、「オフラインだけ setup を変えて
/// process を変え忘れる」取り違えを実機に出さないための **test-only 検出器**である。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Vst3ProcessMode {
    #[default]
    Realtime,
    /// 実時間より速く回す（#598 のオフラインレンダ）。ディスクストリーミングするサンプラーは
    /// これを受け取って先読みを同期読みに切り替えることが期待される。
    Offline,
}

impl Vst3ProcessMode {
    /// VST3 の `ProcessModes_` 定数へ。`ProcessSetup` と `ProcessData` の両方で使う。
    fn as_vst3(self) -> i32 {
        match self {
            Self::Realtime => ProcessModes_::kRealtime as i32,
            Self::Offline => ProcessModes_::kOffline as i32,
        }
    }
}

/// Audio-thread half of the split VST3 effect processor (#474 P1). Owns exactly what the
/// per-block `process` call touches: the `IAudioProcessor`, the host-side COM stubs, and the
/// de-interleave scratch buffers. `Drop` calls `setProcessing(0)`（分割後は audio スレッド上で
/// 走る — モノリシック時代も process と同一スレッドで呼んでいたので契約上同等以上）。
pub struct Vst3EffectAudio {
    processor: ComPtr<IAudioProcessor>,
    is_effect: bool,
    sample_rate: f64,
    /// `ProcessSetup` で宣言したのと同じ処理圧。`ProcessData` に載せ直すために保持する
    /// （setup と process の不一致は VST3 の契約違反）。
    process_mode: Vst3ProcessMode,
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

// SAFETY (#474 P1 / UIH.1): 専用 audio スレッドへの move は VST3 ホストの正準モデルである —
// `IAudioProcessor::process` は非 main の RT スレッドから駆動されることが想定されており、
// COM の参照カウント（`FUnknown`）は VST3 契約上スレッド安全が要求される。ここが所有する
// host 側 COM スタブ（`ParameterChanges` / `EventList`）は move 後は所有スレッドだけが触る
// （`thread::spawn` の引き渡しが happens-before を確立する）。加えて正しさは
// [`Vst3PluginMain`] に記した teardown 順序（audio 側の `setProcessing(0)` が main 側の
// terminate 列より先）に依存する — composite では明示 `Drop`、分割 child では
// 「join してから main 側を drop」の関数構造が強制する。
unsafe impl Send for Vst3EffectAudio {}

impl Drop for Vst3EffectAudio {
    fn drop(&mut self) {
        let result = unsafe { self.processor.setProcessing(0) };
        if !is_ok(result) && result != kNotImplemented {
            eprintln!("[orbit-vst3-host] effect setProcessing(0) failed: {result}");
        }
    }
}

/// Single-threaded-by-default VST3 effect processor: [`Vst3EffectAudio`] + [`Vst3PluginMain`]
/// の composite。`load` したスレッド上でそのまま使う（従来 API 互換）か、`split()` で
/// main / audio の 2 スレッド運用（UIH.1）へ分割する。
///
/// Shutdown call order is enforced by the hand-written [`Drop::drop`] body below via explicit
/// `.take()` calls, not by field declaration order.
pub struct Vst3EffectProcessor {
    audio: Option<Vst3EffectAudio>,
    main: Option<Vst3PluginMain>,
}

impl Vst3EffectProcessor {
    /// realtime（既定）で読み込む。`load_with_process_mode(.., Vst3ProcessMode::Realtime)` と同義で、
    /// #598 以前からの呼び出し側をそのまま通すための薄いラッパ。
    pub fn load(
        bundle_path: &Path,
        sample_rate: f64,
        max_samples_per_block: i32,
        state: Option<&[u8]>,
    ) -> Result<(Self, LoadedVst3Info), Vst3HostError> {
        Self::load_with_process_mode(
            bundle_path,
            sample_rate,
            max_samples_per_block,
            state,
            Vst3ProcessMode::Realtime,
        )
    }

    /// 処理圧を明示して読み込む（#598）。`process_mode` は `ProcessSetup` で宣言され、
    /// 以降の `ProcessData` にも同じ値が載る（両者の不一致は VST3 の契約違反）。
    pub fn load_with_process_mode(
        bundle_path: &Path,
        sample_rate: f64,
        max_samples_per_block: i32,
        state: Option<&[u8]>,
        process_mode: Vst3ProcessMode,
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
            processMode: process_mode.as_vst3(),
            symbolicSampleSize: SymbolicSampleSizes_::kSample32 as i32,
            maxSamplesPerBlock: max_samples_per_block,
            sampleRate: sample_rate,
        };
        let setup_result = unsafe { processor.setupProcessing(&mut setup) };
        if !is_ok(setup_result) {
            return Err(Vst3HostError::SetupProcessing(setup_result));
        }

        // instrument と同じ VST3 正準順序: setup 済み・inactive の component へ state を適用し、
        // 音色が確定してから READY に到達できるようにする。
        if let Some(bytes) = state {
            apply_state_bytes(&component, controller_handshake.controller.as_ref(), bytes)?;
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
        let ui_endpoint = Vst3UiEndpoint::new(controller_handshake.controller.as_ref().cloned());
        let processor = Self {
            audio: Some(Vst3EffectAudio {
                processor,
                process_mode,
                is_effect: info.is_effect,
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
            }),
            main: Some(Vst3PluginMain {
                ui_endpoint,
                controller: controller_handshake.controller,
                controller_shared_with_component: controller_handshake.shared_with_component,
                component_connection: controller_handshake.component_connection,
                controller_connection: controller_handshake.controller_connection,
                component: Some(component),
                _component_handler: controller_handshake.component_handler,
                _host_context: host_context,
                factory: Some(factory),
                _home_thread: PhantomData,
                _library: library,
                info: info.clone(),
            }),
        };
        Ok((processor, info))
    }

    /// main / audio の 2 スレッド運用（UIH.1）へ分割する（#474 P1）。
    ///
    /// teardown の順序契約（audio 側 drop = `setProcessing(0)` → join →
    /// [`Vst3PluginMain`] drop = terminate 列）は [`Vst3PluginMain`] の doc を参照。
    pub fn split(mut self) -> (Vst3EffectAudio, Vst3PluginMain) {
        (
            self.audio.take().expect("VST3 effect audio is present"),
            self.main.take().expect("VST3 effect main is present"),
        )
    }

    /// 現在の effect component state を取得する。instrument と同じ空-state拒否規律を使う。
    pub fn capture_state(&self) -> Result<Vec<u8>, Vst3HostError> {
        self.main
            .as_ref()
            .expect("VST3 effect main is present")
            .capture_state()
    }

    pub fn info(&self) -> &LoadedVst3Info {
        self.main
            .as_ref()
            .expect("VST3 effect main is present")
            .info()
    }

    pub fn process_stereo(
        &mut self,
        input_l: &[f32],
        input_r: &[f32],
        output_l: &mut [f32],
        output_r: &mut [f32],
        gain: Option<f64>,
    ) -> Result<ProcessReport, Vst3HostError> {
        self.audio
            .as_mut()
            .expect("VST3 effect audio is present")
            .process_stereo(input_l, input_r, output_l, output_r, gain)
    }

    /// Interleaved stereo f32 blockを in-place で処理する child / offline parity 用 API
    /// （[`Vst3EffectAudio::process_block`] へ委譲）。
    #[must_use]
    pub fn process_block(&mut self, data: &mut [f32]) -> bool {
        self.audio
            .as_mut()
            .expect("VST3 effect audio is present")
            .process_block(data)
    }
}

impl Drop for Vst3EffectProcessor {
    fn drop(&mut self) {
        // Shutdown order is explicit and independent of field declaration order.
        let _ = self.audio.take();
        let _ = self.main.take();
    }
}

impl Vst3EffectAudio {
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
        if frames > self.process_input_l.len() {
            return Err(Vst3HostError::ProcessBlockTooLarge {
                requested: frames,
                max: self.process_input_l.len(),
            });
        }

        self.process_input_l[..frames].copy_from_slice(input_l);
        self.process_input_r[..frames].copy_from_slice(input_r);

        let input_ptrs = [
            self.process_input_l.as_mut_ptr(),
            self.process_input_r.as_mut_ptr(),
        ];
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
            is_effect: self.is_effect,
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
            if self.is_effect {
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
        let Ok(num_samples) = i32::try_from(frames) else {
            return kInvalidArgument;
        };
        let processor = &self.processor;

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
            processMode: self.process_mode.as_vst3(),
            symbolicSampleSize: SymbolicSampleSizes_::kSample32 as i32,
            numSamples: num_samples,
            numInputs: if self.is_effect { 1 } else { 0 },
            numOutputs: 1,
            inputs: if self.is_effect {
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

/// Audio-thread half of the split VST3 instrument processor (#474 P1). `Send` の根拠と
/// teardown 順序契約は [`Vst3EffectAudio`] / [`Vst3PluginMain`] と同一。
pub struct Vst3InstrumentAudio {
    processor: ComPtr<IAudioProcessor>,
    /// `ProcessSetup` で宣言したのと同じ処理圧（[`Vst3EffectAudio::process_mode`] と同じ理由）。
    process_mode: Vst3ProcessMode,
    input_events: InputEventList,
    output_parameter_changes: ParameterChanges,
    output_events: EventList,
    process_output_l: Vec<f32>,
    process_output_r: Vec<f32>,
    /// Raw tresult of the most recent failing `process()` call (RT-safe: no logging on the hot
    /// path, just stashed for the caller to surface out-of-band, e.g. on child process exit).
    last_process_error: std::cell::Cell<i32>,
}

// SAFETY: [`Vst3EffectAudio`] の SAFETY コメントと同一の根拠（VST3 の audio スレッド駆動は
// 正準モデル・COM 参照カウントはスレッド安全・host 側 COM スタブは move 後single-thread 使用・
// teardown 順序は composite の明示 `Drop` / 分割 child の join-then-drop が強制）。
unsafe impl Send for Vst3InstrumentAudio {}

impl Drop for Vst3InstrumentAudio {
    fn drop(&mut self) {
        let result = unsafe { self.processor.setProcessing(0) };
        if !is_ok(result) && result != kNotImplemented {
            eprintln!("[orbit-vst3-host] instrument setProcessing(0) failed: {result}");
        }
    }
}

/// Single-threaded-by-default VST3 instrument processor: [`Vst3InstrumentAudio`] +
/// [`Vst3PluginMain`] の composite（構成・分割・teardown 契約は [`Vst3EffectProcessor`] と対称）。
///
/// Shutdown call order is enforced by the hand-written [`Drop::drop`] body below via explicit
/// `.take()` calls, not by field declaration order.
pub struct Vst3InstrumentProcessor {
    audio: Option<Vst3InstrumentAudio>,
    main: Option<Vst3PluginMain>,
}

/// #540 P2: 保存済み state を component / controller へ復元する（`.vstpreset` container と
/// raw component state chunk の両対応）。失敗はハードエラー — 音色が復元できていないのに
/// default 音で鳴らすのは「保存した音で鳴る」という契約違反のため、呼び出し側は
/// ロード失敗として表面化させる。
fn apply_state_bytes(
    component: &ComPtr<IComponent>,
    controller: Option<&ComPtr<IEditController>>,
    bytes: &[u8],
) -> Result<(), Vst3HostError> {
    let owned_raw;
    let chunks = match parse_vstpreset(bytes)? {
        Some(chunks) => chunks,
        None => {
            // magic 無し = raw component state chunk（自前保存の生 dump 等）。
            owned_raw = VstPresetChunks {
                component: bytes,
                controller: None,
            };
            owned_raw
        }
    };
    apply_state_chunks(component, controller, &chunks)
}

fn capture_component_state(component: &ComPtr<IComponent>) -> Result<Vec<u8>, Vst3HostError> {
    let stream_wrapper = ComWrapper::new(MemoryStream::new());
    let stream = stream_wrapper
        .to_com_ptr::<IBStream>()
        .ok_or_else(|| Vst3HostError::State("MemoryStream exposes no IBStream".into()))?;

    let result = unsafe { component.getState(stream.as_ptr()) };
    if !is_ok(result) {
        return Err(Vst3HostError::State(format!(
            "IComponent::getState failed (tresult {result:#x})"
        )));
    }
    let bytes = stream_wrapper.data.borrow().clone();
    if bytes.is_empty() {
        return Err(Vst3HostError::State(
            "IComponent::getState produced an empty chunk — refusing to record it as state".into(),
        ));
    }
    Ok(bytes)
}

impl Vst3InstrumentProcessor {
    /// #555: 現在の plugin state を **バイト列として取り出す**（DAW ループの保存側）。
    ///
    /// VST3 正準の永続化は `IComponent::getState`。ここでは controller chunk を含めず
    /// component chunk のみを返す — 復元側（`apply_state_chunks`）が magic 無しの
    /// raw component state を受理する契約なので対称になる。
    ///
    /// **スレッド**: UI/メインスレッドから呼ぶこと（CAP.5・VST3 の規約）。
    /// child のメインループ（現状は audio spin loop・Phase 2 で runloop 化）が呼び出す。
    ///
    /// `getState` が失敗した、または空を返した場合は `Err` を返す — **空 state を
    /// 「成功」として上位へ渡さない**（サイズ 0 を登記すると音色を失う）。
    pub fn capture_state(&self) -> Result<Vec<u8>, Vst3HostError> {
        self.main
            .as_ref()
            .expect("VST3 instrument main is present")
            .capture_state()
    }

    /// realtime（既定）で読み込む（[`Vst3EffectProcessor::load`] と同じ契約）。
    pub fn load(
        bundle_path: &Path,
        sample_rate: f64,
        max_samples_per_block: i32,
        state: Option<&[u8]>,
    ) -> Result<(Self, LoadedVst3Info), Vst3HostError> {
        Self::load_with_process_mode(
            bundle_path,
            sample_rate,
            max_samples_per_block,
            state,
            Vst3ProcessMode::Realtime,
        )
    }

    /// 処理圧を明示して読み込む（#598・[`Vst3EffectProcessor::load_with_process_mode`] と同じ契約）。
    pub fn load_with_process_mode(
        bundle_path: &Path,
        sample_rate: f64,
        max_samples_per_block: i32,
        state: Option<&[u8]>,
        process_mode: Vst3ProcessMode,
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

        // Controller creation/connection precedes bus activation, matching the effect host.
        let controller_handshake =
            connect_controller(&factory, &component, &host_context, host_context_ptr)?;
        let input_buses = unsafe {
            component.getBusCount(MediaTypes_::kAudio as i32, BusDirections_::kInput as i32)
        };
        let output_buses = unsafe {
            component.getBusCount(MediaTypes_::kAudio as i32, BusDirections_::kOutput as i32)
        };
        if input_buses != 0 || output_buses <= 0 {
            return Err(Vst3HostError::NotInstrument {
                input_buses,
                output_buses,
            });
        }
        let event_input_buses = unsafe {
            component.getBusCount(MediaTypes_::kEvent as i32, BusDirections_::kInput as i32)
        };
        if event_input_buses <= 0 {
            return Err(Vst3HostError::MissingEventInputBus);
        }

        configure_audio_buses(&component, &processor, input_buses, output_buses)?;
        // The event input bus is required for note delivery; unlike audio activation it must not
        // be left to a plugin default.
        let event_result = unsafe {
            component.activateBus(
                MediaTypes_::kEvent as i32,
                BusDirections_::kInput as i32,
                0,
                1,
            )
        };
        if !is_ok(event_result) {
            return Err(Vst3HostError::SetActive(event_result));
        }

        let mut setup = ProcessSetup {
            processMode: process_mode.as_vst3(),
            symbolicSampleSize: SymbolicSampleSizes_::kSample32 as i32,
            maxSamplesPerBlock: max_samples_per_block,
            sampleRate: sample_rate,
        };
        let setup_result = unsafe { processor.setupProcessing(&mut setup) };
        if !is_ok(setup_result) {
            return Err(Vst3HostError::SetupProcessing(setup_result));
        }
        // #540 P2: 保存済み state の復元は **setActive(1) より前**に行う。VST3 の正準復元
        // フローは「setup 済み・inactive の component へ setState」で、activate 後の適用は
        // 「実行中の preset 差し替え」意味論になり、サンプルマップ等の構造的 state を持つ
        // 音源（Kontakt 等）で挙動差が出得る（#542 レビュー F7）。
        if let Some(bytes) = state {
            apply_state_bytes(&component, controller_handshake.controller.as_ref(), bytes)?;
        }
        let active_result = unsafe { component.setActive(1) };
        if !is_ok(active_result) {
            return Err(Vst3HostError::SetActive(active_result));
        }
        let processing_result = unsafe { processor.setProcessing(1) };
        if !is_ok(processing_result) && processing_result != kNotImplemented {
            return Err(Vst3HostError::SetProcessing(processing_result));
        }

        let info = LoadedVst3Info {
            name: class.name,
            audio_inputs: input_buses,
            audio_outputs: output_buses,
            is_effect: false,
        };
        let scratch_len = max_samples_per_block.max(0) as usize;
        let ui_endpoint = Vst3UiEndpoint::new(controller_handshake.controller.as_ref().cloned());
        Ok((
            Self {
                audio: Some(Vst3InstrumentAudio {
                    processor,
                    process_mode,
                    input_events: InputEventList::new(),
                    output_parameter_changes: ParameterChanges::empty(),
                    output_events: EventList::empty(),
                    process_output_l: vec![0.0; scratch_len],
                    process_output_r: vec![0.0; scratch_len],
                    last_process_error: std::cell::Cell::new(0),
                }),
                main: Some(Vst3PluginMain {
                    ui_endpoint,
                    controller: controller_handshake.controller,
                    controller_shared_with_component: controller_handshake.shared_with_component,
                    component_connection: controller_handshake.component_connection,
                    controller_connection: controller_handshake.controller_connection,
                    component: Some(component),
                    _component_handler: controller_handshake.component_handler,
                    _host_context: host_context,
                    factory: Some(factory),
                    _home_thread: PhantomData,
                    _library: library,
                    info: info.clone(),
                }),
            },
            info,
        ))
    }

    pub fn info(&self) -> &LoadedVst3Info {
        self.main
            .as_ref()
            .expect("VST3 instrument main is present")
            .info()
    }

    /// main / audio の 2 スレッド運用（UIH.1）へ分割する（#474 P1）。
    /// 順序契約は [`Vst3EffectProcessor::split`] と同一。
    pub fn split(mut self) -> (Vst3InstrumentAudio, Vst3PluginMain) {
        (
            self.audio.take().expect("VST3 instrument audio is present"),
            self.main.take().expect("VST3 instrument main is present"),
        )
    }

    /// Raw tresult of the most recent failing `process()` call (0 / `kResultOk` if none since
    /// construction). Intended for out-of-band error reporting (e.g. child process exit summary),
    /// not for the audio-thread hot path.
    pub fn last_process_error(&self) -> i32 {
        self.audio
            .as_ref()
            .expect("VST3 instrument audio is present")
            .last_process_error()
    }

    pub fn push_note_on(&self, channel: i16, pitch: i16, velocity: f32, sample_offset: i32) {
        self.audio
            .as_ref()
            .expect("VST3 instrument audio is present")
            .push_note_on(channel, pitch, velocity, sample_offset);
    }

    pub fn push_note_off(&self, channel: i16, pitch: i16, velocity: f32, sample_offset: i32) {
        self.audio
            .as_ref()
            .expect("VST3 instrument audio is present")
            .push_note_off(channel, pitch, velocity, sample_offset);
    }

    /// Queued note events are delivered at their supplied sample offsets; successful plugin
    /// output is add-mixed into interleaved stereo `data`
    /// （[`Vst3InstrumentAudio::process_block`] へ委譲）。
    #[must_use]
    pub fn process_block(&mut self, data: &mut [f32]) -> bool {
        self.audio
            .as_mut()
            .expect("VST3 instrument audio is present")
            .process_block(data)
    }
}

impl Drop for Vst3InstrumentProcessor {
    fn drop(&mut self) {
        // Shutdown order is explicit and independent of field declaration order.
        let _ = self.audio.take();
        let _ = self.main.take();
    }
}

impl Vst3InstrumentAudio {
    /// Raw tresult of the most recent failing `process()` call（audio スレッド側）。
    pub fn last_process_error(&self) -> i32 {
        self.last_process_error.get()
    }

    pub fn push_note_on(&self, channel: i16, pitch: i16, velocity: f32, sample_offset: i32) {
        self.input_events
            .push_note_on(channel, pitch, velocity, sample_offset);
    }

    pub fn push_note_off(&self, channel: i16, pitch: i16, velocity: f32, sample_offset: i32) {
        self.input_events
            .push_note_off(channel, pitch, velocity, sample_offset);
    }

    /// Queued note events are delivered at their supplied sample offsets; successful plugin
    /// output is add-mixed into interleaved stereo `data`.
    #[must_use]
    pub fn process_block(&mut self, data: &mut [f32]) -> bool {
        if !data.len().is_multiple_of(DEFAULT_CHANNELS) {
            // Clear queued input events so a rejected block doesn't leak stale note
            // events (with now-invalid sample offsets) into the next successful block.
            self.input_events.clear();
            return false;
        }
        let frames = data.len() / DEFAULT_CHANNELS;
        if frames > self.process_output_l.len() {
            // Same rationale as above: drop stale queued events on early return.
            self.input_events.clear();
            return false;
        }
        self.process_output_l[..frames].fill(0.0);
        self.process_output_r[..frames].fill(0.0);
        let mut output_ptrs = [
            self.process_output_l.as_mut_ptr(),
            self.process_output_r.as_mut_ptr(),
        ];
        let mut outputs = [AudioBusBuffers {
            numChannels: DEFAULT_CHANNELS as i32,
            silenceFlags: 0,
            __field0: AudioBusBuffers__type0 {
                channelBuffers32: output_ptrs.as_mut_ptr(),
            },
        }];
        let Ok(num_samples) = i32::try_from(frames) else {
            // Same rationale as the guards above: drop stale queued events on early return.
            self.input_events.clear();
            return false;
        };
        let mut process_data = ProcessData {
            processMode: self.process_mode.as_vst3(),
            symbolicSampleSize: SymbolicSampleSizes_::kSample32 as i32,
            numSamples: num_samples,
            numInputs: 0,
            numOutputs: 1,
            inputs: ptr::null_mut(),
            outputs: outputs.as_mut_ptr(),
            inputParameterChanges: ptr::null_mut(),
            outputParameterChanges: self.output_parameter_changes.as_ptr(),
            inputEvents: self.input_events.as_ptr(),
            outputEvents: self.output_events.as_ptr(),
            processContext: ptr::null_mut(),
        };
        let result = unsafe { self.processor.process(&mut process_data) };
        self.input_events.clear();
        if !is_ok(result) {
            self.last_process_error.set(result);
            return false;
        }
        for frame in 0..frames {
            let base = frame * DEFAULT_CHANNELS;
            data[base] += self.process_output_l[frame];
            data[base + 1] += self.process_output_r[frame];
        }
        true
    }
}

struct AudioModuleClass {
    cid: TUID,
    name: String,
}

/// controller を独立して `terminate()` すべきか（#603）。
///
/// 🔴 **この判断の理由はここに集約する**（`shared_with_component` 各フィールドの doc は
/// ここを指すだけにしてある）。
///
/// VST3 には controller を別クラスとして持つ plugin と、component 自身が
/// `IEditController` を実装する**単一コンポーネント plugin**（Kontakt 等）の 2 形態がある。
/// 後者では `getControllerClassId` が失敗するので component を `IEditController` へ cast して
/// 使う（[`connect_controller`] の fallback）。
///
/// その結果 controller と component が**同一の COM オブジェクト**になるため、両方から
/// `terminate()` を呼ぶと同じオブジェクトを二度終了させることになる。共有時は component 側の
/// terminate に一本化する。
///
/// 🔴 **これは COM の一般則（同一オブジェクトへの二重 terminate は未定義）に基づく予防措置で、
/// 破損を再現観測したものではない。** 実測したのは「fallback 無しでは Kontakt 8 の UI が
/// `edit controller is unavailable` で開かない」ことと「fallback ありで開閉・再開・2声同時が
/// 通る」ことまでである。
///
/// `Drop` から切り出してあるのは、実 COM オブジェクトなしでこの判定を検証するため。
fn should_terminate_controller(shared_with_component: bool) -> bool {
    !shared_with_component
}

struct ControllerHandshake {
    controller: Option<ComPtr<IEditController>>,
    component_connection: Option<ComPtr<IConnectionPoint>>,
    controller_connection: Option<ComPtr<IConnectionPoint>>,
    component_handler: Option<ComWrapper<HostComponentHandler>>,
    /// controller が component と**同一の COM オブジェクト**のとき true（#603）。
    /// 理由は [`should_terminate_controller`] を参照。
    shared_with_component: bool,
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
        // 単一コンポーネント plugin の fallback（#603）。
        //
        // `getControllerClassId` が失敗する plugin は、別クラスの controller を持たず
        // **component 自身が `IEditController` を実装する**。この場合は component を
        // `IEditController` へ cast して使う。
        //
        // 🔴 cast の実体は COM の QueryInterface（`com-scrape-types` の `ComPtr::cast`）で、
        // 「このオブジェクトが IEditController を実装するか」を問う正規の手段。実装しない
        // plugin では `None` に落ちて従来どおり controller なしになる（退行なし）。
        // **VST3 SDK 本体のテキストはこのリポジトリに無いため、SDK 条文は引用しない。**
        // 根拠は上記の COM 意味論と、Kontakt 8 での実測（fallback 無しでは UI が開かない）。
        //
        // ここで `initialize` を呼ばないのは、**同一オブジェクトの component 側で既に
        // 済んでいる**ため。connection point の接続と state の同期も、送り先と受け手が
        // 同一オブジェクトなので不要になる。
        //
        // 実測（2026-08-01・Kontakt 8）: この fallback が無いと UI open が
        // `edit controller is unavailable` で失敗する。fallback ありで
        // Soundcinema 提出作品の音色選定（6 パッチ連続の open → 選択 → close → 自動保存）を
        // 完走した。
        if let Some(controller) = component.as_com_ref().cast::<IEditController>() {
            let component_handler = ComWrapper::new(HostComponentHandler);
            let handler_ptr = component_handler
                .as_com_ref::<IComponentHandler>()
                .expect("HostComponentHandler exposes IComponentHandler")
                .as_ptr();
            unsafe {
                let _ = controller.setComponentHandler(handler_ptr);
            }
            return Ok(ControllerHandshake {
                controller: Some(controller),
                component_connection: None,
                controller_connection: None,
                component_handler: Some(component_handler),
                shared_with_component: true,
            });
        }
        // 🔴 controller の取得が**両方**失敗した（#619 レビュー）。plugin のロード自体は
        // 続行できる（音は出る）が、UI は開けない。ここで黙ると、後で `seq.ui()` を呼んだ
        // 時に出る `edit controller is unavailable` と**ロード時の根本原因が結びつかない**。
        eprintln!(
            "[vst3-host] no edit controller: getControllerClassId failed ({cid_result}) and the \
             component does not expose IEditController; the plugin will load but its UI cannot open"
        );
        return Ok(ControllerHandshake {
            controller: None,
            component_connection: None,
            controller_connection: None,
            component_handler: None,
            shared_with_component: false,
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
        shared_with_component: false,
    })
}

/// #540 P2: `.vstpreset` container の chunk 参照（`parse_vstpreset` の結果）。
struct VstPresetChunks<'a> {
    component: &'a [u8],
    controller: Option<&'a [u8]>,
}

/// `.vstpreset` container を解析する（Steinberg "VST 3 Preset File Format"）。
///
/// レイアウト: header 48 bytes = magic `VST3`(4) + version i32 LE(4) + class ID ASCII(32) +
/// chunk-list offset i64 LE(8)。chunk list = magic `List`(4) + count i32 LE(4) +
/// count × { chunk ID(4) + offset i64 LE(8) + size i64 LE(8) }。`Comp` = component state・
/// `Cont` = controller state・`Info` はメタデータ（無視）。
///
/// 先頭 magic が `VST3` でなければ `Ok(None)`（呼び出し側は raw component state chunk として
/// 扱う）。magic が合うのに構造が壊れている場合はエラー（silent に raw 扱いすると
/// container ヘッダごと setState に流れて plugin 側で不可解に失敗する）。
///
/// header の class ID は照合しない: TUID ↔ ASCII 表現はプラットフォームで byte order が
/// 異なり（COM 互換 swap）、誤検知で正当な preset を弾くリスクが照合の利得を上回る。
/// 不一致の preset は plugin 自身の setState が拒否する。
fn parse_vstpreset(bytes: &[u8]) -> Result<Option<VstPresetChunks<'_>>, Vst3HostError> {
    if bytes.len() < 4 || &bytes[0..4] != b"VST3" {
        return Ok(None);
    }
    let malformed = |reason: &str| Vst3HostError::State(format!("malformed .vstpreset: {reason}"));
    if bytes.len() < 48 {
        return Err(malformed("header shorter than 48 bytes"));
    }
    let read_i64 = |offset: usize| -> Result<i64, Vst3HostError> {
        let end = offset
            .checked_add(8)
            .filter(|&end| end <= bytes.len())
            .ok_or_else(|| malformed("integer field out of bounds"))?;
        Ok(i64::from_le_bytes(bytes[offset..end].try_into().unwrap()))
    };
    let list_offset =
        usize::try_from(read_i64(40)?).map_err(|_| malformed("negative chunk-list offset"))?;
    let list_end = list_offset
        .checked_add(8)
        .filter(|&end| end <= bytes.len())
        .ok_or_else(|| malformed("chunk-list offset out of bounds"))?;
    if &bytes[list_offset..list_offset + 4] != b"List" {
        return Err(malformed("chunk list magic is not 'List'"));
    }
    let count = i32::from_le_bytes(bytes[list_offset + 4..list_end].try_into().unwrap());
    let count = usize::try_from(count).map_err(|_| malformed("negative chunk count"))?;
    let mut component: Option<&[u8]> = None;
    let mut controller: Option<&[u8]> = None;
    for index in 0..count {
        let entry = list_end + index * 20;
        let entry_end = entry
            .checked_add(20)
            .filter(|&end| end <= bytes.len())
            .ok_or_else(|| malformed("chunk entry out of bounds"))?;
        let id = &bytes[entry..entry + 4];
        let offset = usize::try_from(read_i64(entry + 4)?)
            .map_err(|_| malformed("negative chunk offset"))?;
        let size =
            usize::try_from(read_i64(entry + 12)?).map_err(|_| malformed("negative chunk size"))?;
        let end = offset
            .checked_add(size)
            .filter(|&end| end <= bytes.len())
            .ok_or_else(|| malformed("chunk data out of bounds"))?;
        let _ = entry_end;
        match id {
            b"Comp" => component = Some(&bytes[offset..end]),
            b"Cont" => controller = Some(&bytes[offset..end]),
            _ => {}
        }
    }
    let component = component.ok_or_else(|| malformed("no 'Comp' (component state) chunk"))?;
    Ok(Some(VstPresetChunks {
        component,
        controller,
    }))
}

/// #540 P2: state chunk を component / controller に適用する。復元順序は VST3 公式 FAQ
/// (Persistence): ① `IComponent::setState` ② `IEditController::setComponentState`
/// ③ `IEditController::setState`（controller chunk がある場合のみ）。
///
/// ① の失敗は音色が復元されていないことを意味するのでハードエラー。②③ は GUI/表示側の
/// 同期でありベストエフォート（未実装の plugin も多い）— 失敗は stderr に出すのみ。
/// state 復元の **成功経路**で出す best-effort 通知の文言。
///
/// 🔴 **`INFO ` の level トークンは飾りではない。** host の stderr は daemon 経由で拡張側の
/// router（`packages/engine/src/audio/rust-engine/daemon-client.ts` の
/// `isDaemonNonErrorTracingLine`）へ流れ、**level を名乗らない行は fail-loud で `ERROR:` に
/// 倒れる**。ここは「音声側の state は既に適用済みで、controller への同期だけが best-effort で
/// 失敗した」ことを伝える通知であり、**復元そのものは成功している**（呼び出し元はどちらも
/// `Ok(())` を返す経路にある）。level を落とすと、正常な state 復元が毎回 ERROR として
/// 記録され、`get_log` の ERROR 件数を数える診断・gated E2E・LLM の自己検証が偽陽性になる
/// （#625 の実機 E2E がこれで落ちた）。
///
/// 本物の失敗（`IComponent::setState` の拒否）は `Err` を返しており、そちらは ERROR に
/// 倒れるのが正しい。
fn best_effort_state_notice(what: &str, result: i32) -> String {
    format!(
        "INFO [orbit-vst3-host] {what} returned {result:#x} (best-effort; audio state is already applied)"
    )
}

fn apply_state_chunks(
    component: &ComPtr<IComponent>,
    controller: Option<&ComPtr<IEditController>>,
    chunks: &VstPresetChunks<'_>,
) -> Result<(), Vst3HostError> {
    let stream_wrapper = ComWrapper::new(MemoryStream::with_data(chunks.component.to_vec()));
    let stream = stream_wrapper
        .to_com_ptr::<IBStream>()
        .expect("MemoryStream exposes IBStream");
    let set_result = unsafe { component.setState(stream.as_ptr()) };
    if !is_ok(set_result) {
        return Err(Vst3HostError::State(format!(
            "IComponent::setState rejected the saved state (tresult {set_result:#x}; \
             wrong plugin for this preset, or a truncated state file)"
        )));
    }
    if let Some(controller) = controller {
        unsafe {
            let mut pos = 0;
            let _ = stream.seek(0, IBStream_::IStreamSeekMode_::kIBSeekSet as i32, &mut pos);
            let sync_result = controller.setComponentState(stream.as_ptr());
            if !is_ok(sync_result) {
                eprintln!(
                    "{}",
                    best_effort_state_notice("setComponentState after state restore", sync_result)
                );
            }
        }
        if let Some(controller_chunk) = chunks.controller {
            let controller_stream_wrapper =
                ComWrapper::new(MemoryStream::with_data(controller_chunk.to_vec()));
            let controller_stream = controller_stream_wrapper
                .to_com_ptr::<IBStream>()
                .expect("MemoryStream exposes IBStream");
            let controller_result = unsafe { controller.setState(controller_stream.as_ptr()) };
            if !is_ok(controller_result) {
                eprintln!(
                    "{}",
                    best_effort_state_notice("IEditController::setState", controller_result)
                );
            }
        }
    }
    Ok(())
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
    // `[*mut f32; 2]` として組み立てる。getBusInfo と、process() 時に plugin が実際に使う
    // negotiated arrangement の両方で primary bus が stereo であることを確認できない場合は、
    // silent corruption ではなく load 失敗として reject する。
    verify_primary_bus_is_stereo(component, processor, input_buses, output_buses)?;

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
    processor: &ComPtr<IAudioProcessor>,
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
        if let Some(channels) =
            primary_bus_arrangement_channel_count(processor, BusDirections_::kInput as i32)
        {
            if channels != DEFAULT_CHANNELS as i32 {
                return Err(Vst3HostError::UnsupportedPrimaryBusLayout {
                    direction: "input",
                    channels,
                });
            }
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
        if let Some(channels) =
            primary_bus_arrangement_channel_count(processor, BusDirections_::kOutput as i32)
        {
            if channels != DEFAULT_CHANNELS as i32 {
                return Err(Vst3HostError::UnsupportedPrimaryBusLayout {
                    direction: "output",
                    channels,
                });
            }
        }
    }
    Ok(())
}

fn primary_bus_arrangement_channel_count(
    processor: &ComPtr<IAudioProcessor>,
    direction: BusDirection,
) -> Option<i32> {
    let mut arrangement = 0;
    let result = unsafe { processor.getBusArrangement(direction, 0, &mut arrangement) };
    if is_ok(result) {
        Some(arrangement.count_ones() as i32)
    } else {
        None
    }
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

    /// #540 P2: 保存済み state chunk を読み出し位置 0 で包む（`setState` 系へ渡す用）。
    fn with_data(data: Vec<u8>) -> Self {
        Self {
            data: RefCell::new(data),
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

/// Working input event list for the instrument processor. `IEventList` is queried synchronously
/// from `IAudioProcessor::process`, so `RefCell` lets the Rust-facing queue and COM callbacks
/// share one allocation without requiring a mutable COM interface.
struct InputEventList {
    wrapper: ComWrapper<HostInputEventList>,
    ptr: ComPtr<IEventList>,
}

impl InputEventList {
    fn new() -> Self {
        let wrapper = ComWrapper::new(HostInputEventList::new());
        let ptr = wrapper
            .to_com_ptr::<IEventList>()
            .expect("HostInputEventList exposes IEventList");
        Self { wrapper, ptr }
    }

    fn push_note_on(&self, channel: i16, pitch: i16, velocity: f32, sample_offset: i32) {
        self.wrapper.events.borrow_mut().push(Event {
            busIndex: 0,
            sampleOffset: sample_offset,
            ppqPosition: 0.0,
            flags: Event_::EventFlags_::kIsLive as u16,
            r#type: Event_::EventTypes_::kNoteOnEvent as u16,
            __field0: Event__type0 {
                noteOn: NoteOnEvent {
                    channel,
                    pitch,
                    tuning: 0.0,
                    velocity,
                    length: 0,
                    noteId: -1,
                },
            },
        });
    }

    fn push_note_off(&self, channel: i16, pitch: i16, velocity: f32, sample_offset: i32) {
        self.wrapper.events.borrow_mut().push(Event {
            busIndex: 0,
            sampleOffset: sample_offset,
            ppqPosition: 0.0,
            flags: Event_::EventFlags_::kIsLive as u16,
            r#type: Event_::EventTypes_::kNoteOffEvent as u16,
            __field0: Event__type0 {
                noteOff: NoteOffEvent {
                    channel,
                    pitch,
                    velocity,
                    noteId: -1,
                    tuning: 0.0,
                },
            },
        });
    }

    fn clear(&self) {
        self.wrapper.events.borrow_mut().clear();
    }

    fn as_ptr(&self) -> *mut IEventList {
        self.ptr.as_ptr()
    }
}

struct HostInputEventList {
    events: RefCell<Vec<Event>>,
}

impl HostInputEventList {
    fn new() -> Self {
        Self {
            events: RefCell::new(Vec::new()),
        }
    }
}

impl Class for HostInputEventList {
    type Interfaces = (IEventList,);
}

impl IEventListTrait for HostInputEventList {
    unsafe fn getEventCount(&self) -> i32 {
        self.events.borrow().len().min(i32::MAX as usize) as i32
    }

    unsafe fn getEvent(&self, index: i32, event: *mut Event) -> tresult {
        if index < 0 || event.is_null() {
            return kInvalidArgument;
        }
        let events = self.events.borrow();
        let Some(source) = events.get(index as usize) else {
            return kInvalidArgument;
        };
        *event = *source;
        kResultOk
    }

    unsafe fn addEvent(&self, _event: *mut Event) -> tresult {
        kResultFalse
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

/// Loads one VST3 module and enumerates factory descriptors only.
///
/// This function deliberately has no component IID/CID arguments and contains no
/// `IPluginFactory::createInstance` call. It stops after `countClasses` and the newest available
/// descriptor getter (`IPluginFactory3`, then Factory2, then v1). Keeping this as a separate API
/// from [`probe_plugin`] prevents catalog metadata discovery from drifting into component
/// initialization, bus negotiation, or audio processing.
pub fn probe_factory_descriptors(
    path: &Path,
) -> Result<Vec<FactoryClassDescriptor>, FactoryProbeError> {
    let library = LoadedLibrary::open(path).map_err(factory_open_error)?;
    // SAFETY: `LoadedLibrary::open` keeps the successfully loaded CFBundle alive. The exported
    // function pointer is resolved from that live bundle, and `get_factory` validates non-null
    // before taking ownership of the returned COM reference. `factory` is declared after
    // `library`, so it is released before the module is unloaded.
    let factory = unsafe { library.get_factory() }.map_err(factory_open_error)?;
    // SAFETY: `factory` is a live `IPluginFactory` COM pointer. Calling countClasses and descriptor
    // getters is the VST3 factory-enumeration contract and does not instantiate any class.
    let count = unsafe { factory.countClasses() };
    if count < 0 {
        return Err(FactoryProbeError::InvalidClassCount(count));
    }

    // `ComPtr::cast` performs QueryInterface only. QueryInterface may adjust refcounts, but it
    // cannot invoke `IPluginFactory::createInstance`; the oracle tripwire integration test pins
    // this boundary through the real `orbit-plugin-scan probe-artifact` child binary.
    let factory3 = factory.cast::<IPluginFactory3>();
    let factory2 = factory.cast::<IPluginFactory2>();
    let mut descriptors = Vec::with_capacity(count as usize);
    for index in 0..count {
        descriptors.push(read_factory_descriptor(
            &factory,
            factory2.as_ref(),
            factory3.as_ref(),
            index,
        )?);
    }
    Ok(descriptors)
}

fn factory_open_error(error: Vst3HostError) -> FactoryProbeError {
    match error {
        Vst3HostError::InvalidBundle(path) => FactoryProbeError::InvalidBundle(path),
        Vst3HostError::BundleLoad(message) => FactoryProbeError::BundleLoad(message),
        Vst3HostError::MissingSymbol(symbol) => FactoryProbeError::MissingSymbol(symbol),
        Vst3HostError::NullFactory => FactoryProbeError::NullFactory,
        other => FactoryProbeError::BundleLoad(other.to_string()),
    }
}

fn read_factory_descriptor(
    factory1: &ComPtr<IPluginFactory>,
    factory2: Option<&ComPtr<IPluginFactory2>>,
    factory3: Option<&ComPtr<IPluginFactory3>>,
    index: i32,
) -> Result<FactoryClassDescriptor, FactoryProbeError> {
    let mut factory3_result = None;
    if let Some(factory3) = factory3 {
        // SAFETY: PClassInfoW is a C ABI plain-data output struct. Zero is valid for all fields;
        // the live Factory3 pointer receives its correct size/layout from the `vst3` bindings.
        let mut info = unsafe { std::mem::zeroed::<PClassInfoW>() };
        // SAFETY: `info` is writable for the duration of the call and `index < countClasses`.
        let result = unsafe { factory3.getClassInfoUnicode(index, &mut info) };
        if is_ok(result) {
            return Ok(FactoryClassDescriptor {
                name: char16_array_to_string(&info.name),
                cid: tuid_to_string(&info.cid),
                category: char8_array_to_string(&info.category),
                sub_categories: char8_array_to_string(&info.subCategories),
                vendor: char16_array_to_string(&info.vendor),
                version: char16_array_to_string(&info.version),
                sdk_version: char16_array_to_string(&info.sdkVersion),
                descriptor_api: FactoryDescriptorApi::Factory3,
            });
        }
        factory3_result = Some(result);
    }

    let mut factory2_result = None;
    if let Some(factory2) = factory2 {
        // SAFETY: PClassInfo2 is a C ABI plain-data output struct and is valid when zeroed.
        let mut info = unsafe { std::mem::zeroed::<PClassInfo2>() };
        // SAFETY: `info` is writable for the duration of the call and `index < countClasses`.
        let result = unsafe { factory2.getClassInfo2(index, &mut info) };
        if is_ok(result) {
            return Ok(FactoryClassDescriptor {
                name: char8_array_to_string(&info.name),
                cid: tuid_to_string(&info.cid),
                category: char8_array_to_string(&info.category),
                sub_categories: char8_array_to_string(&info.subCategories),
                vendor: char8_array_to_string(&info.vendor),
                version: char8_array_to_string(&info.version),
                sdk_version: char8_array_to_string(&info.sdkVersion),
                descriptor_api: FactoryDescriptorApi::Factory2,
            });
        }
        factory2_result = Some(result);
    }

    // SAFETY: PClassInfo is a C ABI plain-data output struct and is valid when zeroed.
    let mut info = unsafe { std::mem::zeroed::<PClassInfo>() };
    // SAFETY: `info` is writable for the duration of the call and `index < countClasses`.
    let factory1_result = unsafe { factory1.getClassInfo(index, &mut info) };
    if is_ok(factory1_result) {
        return Ok(FactoryClassDescriptor {
            name: char8_array_to_string(&info.name),
            cid: tuid_to_string(&info.cid),
            category: char8_array_to_string(&info.category),
            sub_categories: String::new(),
            vendor: String::new(),
            version: String::new(),
            sdk_version: String::new(),
            descriptor_api: FactoryDescriptorApi::Factory1,
        });
    }

    Err(FactoryProbeError::DescriptorRead {
        index,
        factory3_result,
        factory2_result,
        factory1_result,
    })
}

fn char16_array_to_string(data: &[TChar]) -> String {
    let nul = data
        .iter()
        .position(|value| *value == 0)
        .unwrap_or(data.len());
    String::from_utf16_lossy(&data[..nul])
}

fn tuid_to_string(cid: &TUID) -> String {
    let mut encoded = String::with_capacity(32);
    for byte in cid {
        use std::fmt::Write;
        write!(encoded, "{byte:02X}").expect("writing to String cannot fail");
    }
    encoded
}

pub fn probe_plugin(path: &Path) -> ProbeResult {
    match Vst3EffectProcessor::load(path, 48_000.0, 512, None) {
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

    // #603: 単一コンポーネント plugin（Kontakt 等）は controller と component が同一の
    // COM オブジェクトなので、両方から terminate() を呼ぶと同じオブジェクトを二度終了
    // させることになり plugin 側の状態機械が壊れる。この判定を実 COM 抜きで固定する。
    #[test]
    fn shared_controller_is_terminated_only_through_the_component() {
        assert!(
            !should_terminate_controller(true),
            "controller == component のとき、controller 側の terminate は呼ばない"
        );
    }

    #[test]
    fn independent_controller_is_terminated_directly() {
        assert!(
            should_terminate_controller(false),
            "別クラスの controller は自分で terminate する（従来の経路を壊さない）"
        );
    }

    #[test]
    fn audio_halves_are_send() {
        fn assert_send<T: Send>() {}
        assert_send::<Vst3EffectAudio>();
        assert_send::<Vst3InstrumentAudio>();
    }

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

    // ── #540 P2: .vstpreset parser ───────────────────────────────────────────────

    /// 合成 .vstpreset を組み立てる（header 48B + データ + chunk list）。
    fn build_vstpreset(chunks: &[(&[u8; 4], &[u8])]) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(b"VST3");
        out.extend_from_slice(&1i32.to_le_bytes());
        out.extend_from_slice(&[b'A'; 32]); // class ID ASCII（parser は照合しない）
        let list_offset_field = out.len();
        out.extend_from_slice(&0i64.to_le_bytes()); // 後で埋める
        let mut entries = Vec::new();
        for (id, data) in chunks {
            let offset = out.len() as i64;
            out.extend_from_slice(data);
            entries.push((**id, offset, data.len() as i64));
        }
        let list_offset = out.len() as i64;
        out.extend_from_slice(b"List");
        out.extend_from_slice(&(entries.len() as i32).to_le_bytes());
        for (id, offset, size) in entries {
            out.extend_from_slice(&id);
            out.extend_from_slice(&offset.to_le_bytes());
            out.extend_from_slice(&size.to_le_bytes());
        }
        out[list_offset_field..list_offset_field + 8].copy_from_slice(&list_offset.to_le_bytes());
        out
    }

    #[test]
    fn vstpreset_extracts_comp_and_cont_chunks() {
        let preset = build_vstpreset(&[(b"Comp", b"component-state"), (b"Cont", b"ctrl")]);
        let chunks = parse_vstpreset(&preset)
            .expect("well-formed preset parses")
            .expect("VST3 magic is recognized");
        assert_eq!(chunks.component, b"component-state");
        assert_eq!(chunks.controller, Some(&b"ctrl"[..]));
    }

    #[test]
    fn vstpreset_without_cont_chunk_has_no_controller_state() {
        let preset = build_vstpreset(&[(b"Comp", b"component-only"), (b"Info", b"<xml/>")]);
        let chunks = parse_vstpreset(&preset)
            .expect("well-formed preset parses")
            .expect("VST3 magic is recognized");
        assert_eq!(chunks.component, b"component-only");
        assert_eq!(chunks.controller, None);
    }

    #[test]
    fn non_vstpreset_bytes_fall_back_to_raw_state() {
        // magic 無し = raw component state（呼び出し側がそのまま setState へ流す契約）。
        assert!(parse_vstpreset(b"OPAQ raw plugin state blob")
            .expect("raw bytes are not an error")
            .is_none());
        assert!(parse_vstpreset(b"").expect("empty is raw").is_none());
    }

    #[test]
    fn vstpreset_with_magic_but_broken_structure_is_an_error_not_raw() {
        // magic があるのに壊れている場合は raw 扱いに落とさず明示エラー（container ヘッダを
        // setState に流し込む silent 誤動作を防ぐ）。
        let truncated = b"VST3\x01\x00\x00\x00short";
        assert!(matches!(
            parse_vstpreset(truncated),
            Err(Vst3HostError::State(_))
        ));

        // Comp チャンク欠如。
        let no_comp = build_vstpreset(&[(b"Info", b"<xml/>")]);
        assert!(matches!(
            parse_vstpreset(&no_comp),
            Err(Vst3HostError::State(_))
        ));

        // chunk list offset が範囲外。
        let mut bad_offset = build_vstpreset(&[(b"Comp", b"x")]);
        let len = bad_offset.len() as i64;
        bad_offset[40..48].copy_from_slice(&(len + 100).to_le_bytes());
        assert!(matches!(
            parse_vstpreset(&bad_offset),
            Err(Vst3HostError::State(_))
        ));

        // chunk データが範囲外（size がファイル末尾を超える）。
        let comp: &[u8] = b"state";
        let mut bad_size = build_vstpreset(&[(b"Comp", comp)]);
        let total_len = bad_size.len() as i64;
        let size_field = bad_size.len() - 8;
        bad_size[size_field..].copy_from_slice(&total_len.to_le_bytes());
        assert!(matches!(
            parse_vstpreset(&bad_size),
            Err(Vst3HostError::State(_))
        ));
    }
}

#[cfg(test)]
mod best_effort_notice_tests {
    use super::best_effort_state_notice;

    /// この通知は復元の成功経路で出るので、daemon の stderr router が非エラーと判定できる形で
    /// なければならない。router は `^\s*(TRACE|DEBUG|INFO)\s+\[orbit-[a-z0-9-]+-child\]\s`
    /// と、daemon 自身の tracing 形式のみを非エラーとして認める（`daemon-client.ts`）。
    #[test]
    fn best_effort_state_notice_declares_a_non_error_level_token() {
        for what in [
            "setComponentState after state restore",
            "IEditController::setState",
        ] {
            let line = best_effort_state_notice(what, 0x3);
            assert!(
                line.starts_with("INFO [orbit-vst3-host] "),
                "notice must declare a non-error level token and the host tag: {line}"
            );
            assert!(
                line.contains(what),
                "notice must name the call that degraded: {line}"
            );
            assert!(
                line.contains("best-effort"),
                "notice must say the restore itself succeeded: {line}"
            );
        }
    }
}
