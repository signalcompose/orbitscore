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

mod host;
#[allow(unused_imports)]
use host::*;
pub use host::{
    probe_factory_descriptors, probe_plugin, ProbeResult, Vst3EffectProcessor, Vst3InstrumentAudio,
    Vst3InstrumentProcessor,
};

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

pub(crate) const AUDIO_MODULE_CLASS: &str = "Audio Module Class";
pub(crate) const DEFAULT_CHANNELS: usize = 2;

pub(crate) type GetPluginFactory = unsafe extern "system" fn() -> *mut IPluginFactory;
pub(crate) type BundleEntry = unsafe extern "system" fn(*mut c_void) -> bool;
pub(crate) type BundleExit = unsafe extern "system" fn() -> bool;

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

pub(crate) struct LoadedLibrary {
    pub(crate) bundle: CFBundleRef,
    pub(crate) bundle_exit_called: bool,
}

impl LoadedLibrary {
    pub(crate) fn open(bundle_path: &Path) -> Result<Self, Vst3HostError> {
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

    pub(crate) unsafe fn get_factory(&self) -> Result<ComPtr<IPluginFactory>, Vst3HostError> {
        let get_factory = self
            .function::<GetPluginFactory>("GetPluginFactory")
            .ok_or(Vst3HostError::MissingSymbol("GetPluginFactory"))?;
        let raw = get_factory();
        ComPtr::from_raw(raw).ok_or(Vst3HostError::NullFactory)
    }

    pub(crate) unsafe fn function<T>(&self, name: &str) -> Option<T>
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

pub(crate) struct CfString(CFStringRef);

impl CfString {
    pub(crate) fn new(value: &str) -> Result<Self, Vst3HostError> {
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

    pub(crate) fn as_ref(&self) -> CFStringRef {
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

pub(crate) struct CfUrl(CFURLRef);

impl CfUrl {
    pub(crate) fn from_raw(raw: CFURLRef) -> Option<Self> {
        if raw.is_null() {
            None
        } else {
            Some(Self(raw))
        }
    }

    pub(crate) fn as_ref(&self) -> CFURLRef {
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
    pub(crate) ui_endpoint: Vst3UiEndpoint,
    pub(crate) controller: Option<ComPtr<IEditController>>,
    /// controller == component（単一コンポーネント plugin）のとき true（#603）。
    /// 理由は [`should_terminate_controller`] を参照。
    pub(crate) controller_shared_with_component: bool,
    pub(crate) component_connection: Option<ComPtr<IConnectionPoint>>,
    pub(crate) controller_connection: Option<ComPtr<IConnectionPoint>>,
    pub(crate) component: Option<ComPtr<IComponent>>,
    pub(crate) _component_handler: Option<ComWrapper<HostComponentHandler>>,
    pub(crate) _host_context: ComWrapper<HostApplication>,
    pub(crate) factory: Option<ComPtr<IPluginFactory>>,
    pub(crate) _home_thread: PhantomData<Rc<()>>,
    pub(crate) _library: LoadedLibrary,
    pub(crate) info: LoadedVst3Info,
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
    pub(crate) fn as_vst3(self) -> i32 {
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
    pub(crate) processor: ComPtr<IAudioProcessor>,
    pub(crate) is_effect: bool,
    pub(crate) sample_rate: f64,
    /// `ProcessSetup` で宣言したのと同じ処理圧。`ProcessData` に載せ直すために保持する
    /// （setup と process の不一致は VST3 の契約違反）。
    pub(crate) process_mode: Vst3ProcessMode,
    /// `IProcessContextRequirements` flags queried once at load time (`load()`). The plugin's
    /// requirements do not change over its lifetime, so re-querying per block would be a wasted
    /// COM `queryInterface` + call on the RT hot path.
    pub(crate) process_context_requirements: u32,
    /// Stateless stub `IParameterChanges`/`IEventList` instances shared by `process_stereo` and
    /// `process_block`. `HostParameterChanges::empty()`/`HostEventList` always answer the same way
    /// regardless of call count, so a single instance can be reused instead of allocating
    /// (`ComWrapper::new` = `Arc`) on every block.
    pub(crate) output_parameter_changes: ParameterChanges,
    pub(crate) input_events: EventList,
    pub(crate) output_events: EventList,
    /// Empty input `IParameterChanges` for `process_block`, which never carries parameter
    /// automation (unlike `process_stereo`'s optional per-call gain).
    pub(crate) block_parameter_changes: ParameterChanges,
    pub(crate) process_input_l: Vec<f32>,
    pub(crate) process_input_r: Vec<f32>,
    pub(crate) process_output_l: Vec<f32>,
    pub(crate) process_output_r: Vec<f32>,
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
    /// なければならない。router は `^\s*(TRACE|DEBUG|INFO)\s+\[orbit-[a-z0-9-]+\]\s`
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
