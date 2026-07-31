//! Known-behavior VST3 instrument oracle: a monophonic stereo sine synth.
#![allow(non_upper_case_globals, non_camel_case_types, non_snake_case)]

use std::cell::{Cell, RefCell};
use std::f32::consts::TAU;
use std::ffi::{c_char, c_void, CStr, CString};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::{ptr, slice};

use vst3::{uid, Class, ComPtr, ComRef, ComWrapper, Steinberg::Vst::*, Steinberg::*};

const PLUGIN_NAME: &str = "Orbit VST3 Synth Oracle";
const INITIAL_UI_WIDTH: i32 = 400;
const INITIAL_UI_HEIGHT: i32 = 300;
const ATTACH_RESIZE_WIDTH: i32 = 640;
const ATTACH_RESIZE_HEIGHT: i32 = 480;

static UI_TRACE: Mutex<Vec<String>> = Mutex::new(Vec::new());
static UI_SCENARIO_LOCK: Mutex<()> = Mutex::new(());
static RESIZE_DURING_ATTACH: AtomicBool = AtomicBool::new(false);

fn ui_trace_guard() -> MutexGuard<'static, Vec<String>> {
    UI_TRACE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn record_ui_call(call: &str) {
    ui_trace_guard().push(call.to_owned());
}

/// Serialize process-local GUI-oracle scenarios that share the trace and behavior switch.
pub fn lock_ui_scenario() -> MutexGuard<'static, ()> {
    UI_SCENARIO_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Clear the process-local GUI call trace.
pub fn reset_ui_trace() {
    ui_trace_guard().clear();
}

/// Snapshot the process-local GUI call trace.
pub fn ui_trace() -> Vec<String> {
    ui_trace_guard().clone()
}

/// Make `attached` synchronously request a 640x480 resize from its `IPlugFrame`.
pub fn set_resize_during_attach(enabled: bool) {
    RESIZE_DURING_ATTACH.store(enabled, Ordering::SeqCst);
}

/// Create the same edit-controller COM class used by the packaged synth oracle.
///
/// The direct constructor lets host integration tests inspect this process's trace without
/// introducing an oracle-specific interface into the production VST3 host.
pub fn create_ui_test_controller() -> ComPtr<IEditController> {
    ComWrapper::new(SynthController)
        .to_com_ptr::<IEditController>()
        .expect("SynthController exposes IEditController")
}

fn copy_cstring(src: &str, dst: &mut [c_char]) {
    let string = CString::new(src).unwrap_or_default();
    for (source, destination) in string.as_bytes_with_nul().iter().zip(dst.iter_mut()) {
        *destination = *source as c_char;
    }
}

fn copy_wstring(src: &str, dst: &mut [TChar]) {
    let mut length = 0;
    for (source, destination) in src.encode_utf16().zip(dst.iter_mut()) {
        *destination = source as TChar;
        length += 1;
    }
    if let Some(last) = dst.get_mut(length.min(dst.len().saturating_sub(1))) {
        *last = 0;
    }
}

/// #553: **state = 半音単位のピッチオフセット**。
///
/// oracle が観測可能な state を持つことで、「state を変える → 音が変わる → 保存 →
/// 復元 → 同じ音」というループを **capture WAV の解析だけで無人検証**できる
/// （`docs/testing/E2E_HARNESS_SPEC.md` / Epic #546 Phase 1）。
///
/// 半音オフセットを選んだ理由: 期待値が [`voice_frequency_hz`] の式から**導出できる**ため、
/// テストが「実装が出した値」ではなく**仕様の式**と照合できる（改ざん耐性）。
pub const STATE_MAGIC: u32 = 0x4F52_4331; // "ORC1"

/// state バイト列の長さ（magic u32 + offset i32・リトルエンディアン）。
pub const STATE_LEN: usize = 8;

/// ノート番号とピッチオフセットから発音周波数を求める（**仕様の式・単一の真実**）。
///
/// テストはこの関数から期待値を導出する。実装側の別経路でハードコードしないこと。
pub fn voice_frequency_hz(key: i16, semitone_offset: i32) -> f32 {
    440.0 * 2.0f32.powf((key as f32 + semitone_offset as f32 - 69.0) / 12.0)
}

/// state バイト列を組み立てる（`getState` と テストが共用）。
pub fn encode_state(semitone_offset: i32) -> [u8; STATE_LEN] {
    let mut out = [0u8; STATE_LEN];
    out[0..4].copy_from_slice(&STATE_MAGIC.to_le_bytes());
    out[4..8].copy_from_slice(&semitone_offset.to_le_bytes());
    out
}

/// state バイト列を解釈する。magic 不一致・長さ不足は `None`（**黙って 0 に倒さない**）。
pub fn decode_state(bytes: &[u8]) -> Option<i32> {
    if bytes.len() < STATE_LEN {
        return None;
    }
    let magic = u32::from_le_bytes(bytes[0..4].try_into().ok()?);
    if magic != STATE_MAGIC {
        return None;
    }
    Some(i32::from_le_bytes(bytes[4..8].try_into().ok()?))
}

#[derive(Clone, Copy)]
struct SineVoice {
    phase: f32,
    phase_inc: f32,
    active: bool,
    key: i16,
}

impl SineVoice {
    fn note_on(&mut self, key: i16, sample_rate: f32, semitone_offset: i32) {
        let frequency = voice_frequency_hz(key, semitone_offset);
        self.phase = 0.0;
        self.phase_inc = TAU * frequency / sample_rate;
        self.active = true;
        self.key = key;
    }

    fn note_off(&mut self, key: i16) {
        if self.active && self.key == key {
            self.active = false;
        }
    }
}

struct SynthProcessor {
    voice: Cell<SineVoice>,
    sample_rate: Cell<f32>,
    /// #553: `setState` / `getState` が往復させる観測可能な state（半音オフセット）。
    semitone_offset: Cell<i32>,
}

impl SynthProcessor {
    const CID: TUID = uid(0x4D16F7A1, 0xC14B4D4D, 0xA292B0D8, 0xA331C421);

    fn new() -> Self {
        Self {
            voice: Cell::new(SineVoice {
                phase: 0.0,
                phase_inc: 0.0,
                active: false,
                key: 69,
            }),
            sample_rate: Cell::new(48_000.0),
            semitone_offset: Cell::new(0),
        }
    }
}

impl Class for SynthProcessor {
    type Interfaces = (IComponent, IAudioProcessor);
}

impl IPluginBaseTrait for SynthProcessor {
    unsafe fn initialize(&self, _context: *mut FUnknown) -> tresult {
        kResultOk
    }
    unsafe fn terminate(&self) -> tresult {
        kResultOk
    }
}

impl IComponentTrait for SynthProcessor {
    unsafe fn getControllerClassId(&self, class_id: *mut TUID) -> tresult {
        *class_id = SynthController::CID;
        kResultOk
    }
    unsafe fn setIoMode(&self, _mode: IoMode) -> tresult {
        kResultOk
    }
    unsafe fn getBusCount(&self, media_type: MediaType, direction: BusDirection) -> i32 {
        match (media_type as MediaTypes, direction as BusDirections) {
            (MediaTypes_::kAudio, BusDirections_::kOutput) => 1,
            (MediaTypes_::kEvent, BusDirections_::kInput) => 1,
            _ => 0,
        }
    }
    unsafe fn getBusInfo(
        &self,
        media_type: MediaType,
        direction: BusDirection,
        index: i32,
        bus: *mut BusInfo,
    ) -> tresult {
        if index != 0 || bus.is_null() {
            return kInvalidArgument;
        }
        let bus = &mut *bus;
        match (media_type as MediaTypes, direction as BusDirections) {
            (MediaTypes_::kAudio, BusDirections_::kOutput) => {
                bus.mediaType = MediaTypes_::kAudio as MediaType;
                bus.direction = BusDirections_::kOutput as BusDirection;
                bus.channelCount = 2;
                bus.busType = BusTypes_::kMain as BusType;
                bus.flags = BusInfo_::BusFlags_::kDefaultActive;
                copy_wstring("Output", &mut bus.name);
                kResultOk
            }
            (MediaTypes_::kEvent, BusDirections_::kInput) => {
                bus.mediaType = MediaTypes_::kEvent as MediaType;
                bus.direction = BusDirections_::kInput as BusDirection;
                bus.channelCount = 16;
                bus.busType = BusTypes_::kMain as BusType;
                bus.flags = BusInfo_::BusFlags_::kDefaultActive;
                copy_wstring("Events", &mut bus.name);
                kResultOk
            }
            _ => kInvalidArgument,
        }
    }
    unsafe fn getRoutingInfo(
        &self,
        _input: *mut RoutingInfo,
        _output: *mut RoutingInfo,
    ) -> tresult {
        kNotImplemented
    }
    unsafe fn activateBus(
        &self,
        _media: MediaType,
        _direction: BusDirection,
        _index: i32,
        _state: TBool,
    ) -> tresult {
        kResultOk
    }
    unsafe fn setActive(&self, _state: TBool) -> tresult {
        kResultOk
    }
    /// #553: ホストが渡す state を読み、半音オフセットを復元する。
    ///
    /// **magic 不一致・長さ不足は `kResultFalse` を返して black-hole にしない** —
    /// 黙って 0 に倒すと「復元したつもりで別の音」になり、ループ検証が意味を失う。
    unsafe fn setState(&self, state: *mut IBStream) -> tresult {
        if state.is_null() {
            return kResultFalse;
        }
        let stream = match ComRef::from_raw(state) {
            Some(s) => s,
            None => return kResultFalse,
        };
        let mut buffer = [0u8; STATE_LEN];
        let mut read: i32 = 0;
        let rc = stream.read(
            buffer.as_mut_ptr() as *mut std::ffi::c_void,
            STATE_LEN as i32,
            &mut read,
        );
        if rc != kResultOk || read != STATE_LEN as i32 {
            return kResultFalse;
        }
        match decode_state(&buffer) {
            Some(offset) => {
                self.semitone_offset.set(offset);
                kResultOk
            }
            None => kResultFalse,
        }
    }

    /// #553: 現在の半音オフセットを state として書き出す。
    unsafe fn getState(&self, state: *mut IBStream) -> tresult {
        if state.is_null() {
            return kResultFalse;
        }
        if std::env::var_os("ORBIT_VST3_SYNTH_EMPTY_STATE").is_some() {
            return kResultOk;
        }
        // #474 P1: getState を意図的に遅くするテスト seam。「state 取得が main スレッドを
        // 塞いでも audio slot の前進を止めない」（UIH.3 の演奏中 SAVE_STATE 解禁）を、
        // 遅い getState を持つ実プラグインの代役として無人検証するために使う
        // （`orbit-vst3-instrument-child/tests/save_during_playback.rs`）。
        if let Some(delay_ms) = std::env::var_os("ORBIT_VST3_SYNTH_STATE_DELAY_MS")
            .and_then(|raw| raw.to_str().and_then(|s| s.parse::<u64>().ok()))
        {
            std::thread::sleep(std::time::Duration::from_millis(delay_ms));
        }
        let stream = match ComRef::from_raw(state) {
            Some(s) => s,
            None => return kResultFalse,
        };
        let mut buffer = encode_state(self.semitone_offset.get());
        let mut written: i32 = 0;
        let rc = stream.write(
            buffer.as_mut_ptr() as *mut std::ffi::c_void,
            STATE_LEN as i32,
            &mut written,
        );
        if rc != kResultOk || written != STATE_LEN as i32 {
            return kResultFalse;
        }
        kResultOk
    }
}

impl IAudioProcessorTrait for SynthProcessor {
    unsafe fn setBusArrangements(
        &self,
        _inputs: *mut SpeakerArrangement,
        num_inputs: i32,
        outputs: *mut SpeakerArrangement,
        num_outputs: i32,
    ) -> tresult {
        if num_inputs == 0 && num_outputs == 1 && *outputs == SpeakerArr::kStereo {
            kResultTrue
        } else {
            kResultFalse
        }
    }
    unsafe fn getBusArrangement(
        &self,
        direction: BusDirection,
        index: i32,
        arrangement: *mut SpeakerArrangement,
    ) -> tresult {
        if direction as BusDirections == BusDirections_::kOutput && index == 0 {
            *arrangement = SpeakerArr::kStereo;
            kResultOk
        } else {
            kInvalidArgument
        }
    }
    unsafe fn canProcessSampleSize(&self, sample_size: i32) -> tresult {
        if sample_size as SymbolicSampleSizes == SymbolicSampleSizes_::kSample32 {
            kResultOk
        } else {
            kNotImplemented
        }
    }
    unsafe fn getLatencySamples(&self) -> u32 {
        0
    }
    unsafe fn setupProcessing(&self, setup: *mut ProcessSetup) -> tresult {
        self.sample_rate.set((*setup).sampleRate as f32);
        kResultOk
    }
    unsafe fn setProcessing(&self, _state: TBool) -> tresult {
        kResultOk
    }
    unsafe fn process(&self, data: *mut ProcessData) -> tresult {
        let data = &*data;
        let mut voice = self.voice.get();
        if data.numOutputs != 1 || data.outputs.is_null() {
            self.voice.set(voice);
            return kResultOk;
        }
        let output = &mut *data.outputs;
        if output.numChannels != 2 {
            self.voice.set(voice);
            return kResultOk;
        }
        let channels = slice::from_raw_parts_mut(output.__field0.channelBuffers32, 2);
        let frames = data.numSamples.max(0) as usize;
        let left = slice::from_raw_parts_mut(channels[0], frames);
        let right = slice::from_raw_parts_mut(channels[1], frames);
        let events = ComRef::from_raw(data.inputEvents);
        let event_count = events.map_or(0, |events| events.getEventCount());
        let mut event_index = 0;
        for (frame, (left, right)) in left.iter_mut().zip(right.iter_mut()).enumerate() {
            while event_index < event_count {
                let mut event: Event = std::mem::zeroed();
                let Some(events) = events else { break };
                if events.getEvent(event_index, &mut event) != kResultOk {
                    event_index += 1;
                    continue;
                }
                if event.sampleOffset > frame as i32 {
                    break;
                }
                match event.r#type as Event_::EventTypes {
                    Event_::EventTypes_::kNoteOnEvent => voice.note_on(
                        event.__field0.noteOn.pitch,
                        self.sample_rate.get(),
                        self.semitone_offset.get(),
                    ),
                    Event_::EventTypes_::kNoteOffEvent => {
                        voice.note_off(event.__field0.noteOff.pitch)
                    }
                    _ => {}
                }
                event_index += 1;
            }
            let sample = if voice.active {
                voice.phase.sin() * 0.25
            } else {
                0.0
            };
            *left = sample;
            *right = sample;
            if voice.active {
                voice.phase = (voice.phase + voice.phase_inc) % TAU;
            }
        }
        self.voice.set(voice);
        kResultOk
    }
    unsafe fn getTailSamples(&self) -> u32 {
        0
    }
}

struct SynthController;
impl SynthController {
    const CID: TUID = uid(0x59B9B1A0, 0xA2C244C2, 0xB19FB042, 0x7068E6F1);
}
impl Class for SynthController {
    type Interfaces = (IEditController,);
}
impl IPluginBaseTrait for SynthController {
    unsafe fn initialize(&self, _context: *mut FUnknown) -> tresult {
        kResultOk
    }
    unsafe fn terminate(&self) -> tresult {
        kResultOk
    }
}
impl IEditControllerTrait for SynthController {
    unsafe fn setComponentState(&self, _state: *mut IBStream) -> tresult {
        kResultOk
    }
    unsafe fn setState(&self, _state: *mut IBStream) -> tresult {
        kResultOk
    }
    unsafe fn getState(&self, _state: *mut IBStream) -> tresult {
        kResultOk
    }
    unsafe fn getParameterCount(&self) -> i32 {
        0
    }
    unsafe fn getParameterInfo(&self, _index: i32, _info: *mut ParameterInfo) -> tresult {
        kInvalidArgument
    }
    unsafe fn getParamStringByValue(
        &self,
        _id: u32,
        _value: f64,
        _string: *mut String128,
    ) -> tresult {
        kInvalidArgument
    }
    unsafe fn getParamValueByString(
        &self,
        _id: u32,
        _string: *mut TChar,
        _value: *mut f64,
    ) -> tresult {
        kInvalidArgument
    }
    unsafe fn normalizedParamToPlain(&self, _id: u32, value: f64) -> f64 {
        value
    }
    unsafe fn plainParamToNormalized(&self, _id: u32, value: f64) -> f64 {
        value
    }
    unsafe fn getParamNormalized(&self, _id: u32) -> f64 {
        0.0
    }
    unsafe fn setParamNormalized(&self, _id: u32, _value: f64) -> tresult {
        kInvalidArgument
    }
    unsafe fn setComponentHandler(&self, _handler: *mut IComponentHandler) -> tresult {
        kResultOk
    }
    unsafe fn createView(&self, name: *const c_char) -> *mut IPlugView {
        record_ui_call("createView");
        if name.is_null() || CStr::from_ptr(name).to_bytes() != b"editor" {
            return ptr::null_mut();
        }

        let wrapper = ComWrapper::new(OraclePlugView::new());
        let view_ptr = wrapper
            .as_com_ref::<IPlugView>()
            .expect("OraclePlugView exposes IPlugView")
            .as_ptr();
        wrapper.self_ptr.set(view_ptr);
        wrapper
            .to_com_ptr::<IPlugView>()
            .expect("OraclePlugView exposes IPlugView")
            .into_raw()
    }
}

struct OraclePlugView {
    frame: RefCell<Option<ComPtr<IPlugFrame>>>,
    size: Cell<ViewRect>,
    self_ptr: Cell<*mut IPlugView>,
}

impl OraclePlugView {
    fn new() -> Self {
        Self {
            frame: RefCell::new(None),
            size: Cell::new(ViewRect {
                left: 0,
                top: 0,
                right: INITIAL_UI_WIDTH,
                bottom: INITIAL_UI_HEIGHT,
            }),
            self_ptr: Cell::new(ptr::null_mut()),
        }
    }
}

impl Drop for OraclePlugView {
    fn drop(&mut self) {
        record_ui_call("viewDropped");
    }
}

impl Class for OraclePlugView {
    type Interfaces = (IPlugView,);
}

impl IPlugViewTrait for OraclePlugView {
    unsafe fn isPlatformTypeSupported(&self, platform_type: FIDString) -> tresult {
        record_ui_call("isPlatformTypeSupported");
        if !platform_type.is_null()
            && CStr::from_ptr(platform_type).to_bytes()
                == CStr::from_ptr(kPlatformTypeNSView).to_bytes()
        {
            kResultTrue
        } else {
            kResultFalse
        }
    }

    unsafe fn attached(&self, _parent: *mut c_void, platform_type: FIDString) -> tresult {
        record_ui_call("attached");
        if platform_type.is_null()
            || CStr::from_ptr(platform_type).to_bytes()
                != CStr::from_ptr(kPlatformTypeNSView).to_bytes()
        {
            return kInvalidArgument;
        }

        if RESIZE_DURING_ATTACH.load(Ordering::SeqCst) {
            record_ui_call("resizeView");
            let mut requested = ViewRect {
                left: 0,
                top: 0,
                right: ATTACH_RESIZE_WIDTH,
                bottom: ATTACH_RESIZE_HEIGHT,
            };
            let frame = self.frame.borrow();
            let Some(frame) = frame.as_ref() else {
                return kNotInitialized;
            };
            let result = frame.resizeView(self.self_ptr.get(), &mut requested);
            if result != kResultOk && result != kResultTrue {
                return result;
            }
        }
        kResultOk
    }

    unsafe fn removed(&self) -> tresult {
        record_ui_call("removed");
        kResultOk
    }

    unsafe fn onWheel(&self, _distance: f32) -> tresult {
        kResultFalse
    }

    unsafe fn onKeyDown(&self, _key: char16, _key_code: int16, _modifiers: int16) -> tresult {
        kResultFalse
    }

    unsafe fn onKeyUp(&self, _key: char16, _key_code: int16, _modifiers: int16) -> tresult {
        kResultFalse
    }

    unsafe fn getSize(&self, size: *mut ViewRect) -> tresult {
        record_ui_call("getSize");
        let Some(size) = size.as_mut() else {
            return kInvalidArgument;
        };
        *size = self.size.get();
        kResultOk
    }

    unsafe fn onSize(&self, new_size: *mut ViewRect) -> tresult {
        record_ui_call("onSize");
        let Some(new_size) = new_size.as_ref() else {
            return kInvalidArgument;
        };
        self.size.set(*new_size);
        kResultOk
    }

    unsafe fn onFocus(&self, _state: TBool) -> tresult {
        kResultOk
    }

    unsafe fn setFrame(&self, frame: *mut IPlugFrame) -> tresult {
        record_ui_call("setFrame");
        *self.frame.borrow_mut() = ComRef::from_raw(frame).map(|frame| frame.to_com_ptr());
        kResultOk
    }

    unsafe fn canResize(&self) -> tresult {
        record_ui_call("canResize");
        kResultTrue
    }

    unsafe fn checkSizeConstraint(&self, rect: *mut ViewRect) -> tresult {
        if rect.is_null() {
            kInvalidArgument
        } else {
            kResultOk
        }
    }
}

struct Factory;
impl Class for Factory {
    type Interfaces = (IPluginFactory,);
}
impl IPluginFactoryTrait for Factory {
    unsafe fn getFactoryInfo(&self, info: *mut PFactoryInfo) -> tresult {
        let info = &mut *info;
        copy_cstring("Signal compose", &mut info.vendor);
        copy_cstring("https://signalcompose.com", &mut info.url);
        copy_cstring("support@signalcompose.com", &mut info.email);
        info.flags = PFactoryInfo_::FactoryFlags_::kUnicode as int32;
        kResultOk
    }
    unsafe fn countClasses(&self) -> i32 {
        2
    }
    unsafe fn getClassInfo(&self, index: i32, info: *mut PClassInfo) -> tresult {
        let info = &mut *info;
        match index {
            0 => {
                info.cid = SynthProcessor::CID;
                info.cardinality = PClassInfo_::ClassCardinality_::kManyInstances as int32;
                copy_cstring("Audio Module Class", &mut info.category);
                copy_cstring(PLUGIN_NAME, &mut info.name);
                kResultOk
            }
            1 => {
                info.cid = SynthController::CID;
                info.cardinality = PClassInfo_::ClassCardinality_::kManyInstances as int32;
                copy_cstring("Component Controller Class", &mut info.category);
                copy_cstring(PLUGIN_NAME, &mut info.name);
                kResultOk
            }
            _ => kInvalidArgument,
        }
    }
    unsafe fn createInstance(
        &self,
        cid: FIDString,
        iid: FIDString,
        object: *mut *mut c_void,
    ) -> tresult {
        let instance = match *(cid as *const TUID) {
            SynthProcessor::CID => Some(
                ComWrapper::new(SynthProcessor::new())
                    .to_com_ptr::<FUnknown>()
                    .unwrap(),
            ),
            SynthController::CID => Some(
                ComWrapper::new(SynthController)
                    .to_com_ptr::<FUnknown>()
                    .unwrap(),
            ),
            _ => None,
        };
        if let Some(instance) = instance {
            let pointer = instance.as_ptr();
            ((*(*pointer).vtbl).queryInterface)(pointer, iid as *mut TUID, object)
        } else {
            kInvalidArgument
        }
    }
}

#[cfg(target_os = "windows")]
#[no_mangle]
extern "system" fn InitDll() -> bool {
    true
}
#[cfg(target_os = "windows")]
#[no_mangle]
extern "system" fn ExitDll() -> bool {
    true
}
#[cfg(target_os = "macos")]
#[no_mangle]
extern "system" fn BundleEntry(_bundle_ref: *mut c_void) -> bool {
    true
}
#[cfg(target_os = "macos")]
#[no_mangle]
extern "system" fn BundleExit() -> bool {
    true
}
#[cfg(target_os = "linux")]
#[no_mangle]
extern "system" fn ModuleEntry(_library_handle: *mut c_void) -> bool {
    true
}
#[cfg(target_os = "linux")]
#[no_mangle]
extern "system" fn ModuleExit() -> bool {
    true
}

#[no_mangle]
extern "system" fn GetPluginFactory() -> *mut IPluginFactory {
    ComWrapper::new(Factory)
        .to_com_ptr::<IPluginFactory>()
        .unwrap()
        .into_raw()
}

/// この oracle を VST3 バンドルとして package し、`.vst3` のパスを返す。
///
/// **テスト専用のヘルパを oracle 本体に置いている理由**: このバンドルを必要とするテストは
/// 複数クレートにまたがる（`orbit-vst3-host` のループ通しテストと
/// `orbit-vst3-instrument-child` の配線テスト）。各テストが同じ package 手順をコピーすると、
/// 手順が変わったときに片方だけ直し忘れる。oracle 自身が「自分をどう package するか」を
/// 知っているのが最も腐りにくい。
///
/// ビルドに失敗したら詳細を stderr に出力して `None` を返す。プロセス内で一度だけ実行し、
/// 結果をキャッシュする。
pub fn package_bundle() -> Option<std::path::PathBuf> {
    use std::sync::OnceLock;
    static BUNDLE: OnceLock<Option<std::path::PathBuf>> = OnceLock::new();
    BUNDLE
        .get_or_init(|| {
            let script =
                std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("package-oracle.sh");
            // 出力先をプロセスごとに分ける（複数クレートのテストが別プロセスで同時に
            // 呼びうるため。詳細は package-oracle.sh のコメント）。
            let output = std::process::Command::new(&script)
                .arg("debug")
                .arg(std::process::id().to_string())
                .output()
                .ok()?;
            if !output.status.success() {
                eprintln!(
                    "synth oracle packaging failed: status={} stderr={}",
                    output.status,
                    String::from_utf8_lossy(&output.stderr)
                );
                return None;
            }
            Some(std::path::PathBuf::from(
                String::from_utf8_lossy(&output.stdout).trim(),
            ))
        })
        .clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// state バイト列が往復すること（`getState` → `setState` の中身）。
    #[test]
    fn state_round_trips_through_encoding() {
        for offset in [-24, -1, 0, 1, 7, 24] {
            let bytes = encode_state(offset);
            assert_eq!(bytes.len(), STATE_LEN);
            assert_eq!(
                decode_state(&bytes),
                Some(offset),
                "encode → decode で {offset} が保存されない"
            );
        }
    }

    /// 🔴 **CLAP oracle と同じエンコードであること**を固定する。
    ///
    /// 両 oracle が同じ magic・同じ長さ・同じバイト並びを使うからこそ、
    /// 「VST3 と CLAP で同じ E2E が green」という受け入れ基準が意味を持つ。
    /// **両側が同じリテラルに pin されている**ので、どちらか一方の定数を変えれば
    /// その側のテストが red になる（`clap-test-synth` 側にも同名のテストがある）。
    /// 別ワークスペースなので定数を共有できず、この二重 pin が唯一の橋渡しになる。
    #[test]
    fn state_encoding_matches_the_cross_format_contract() {
        assert_eq!(STATE_MAGIC, 0x4F52_4331, "magic は \"ORC1\"");
        assert_eq!(STATE_LEN, 8, "magic 4 バイト + i32 4 バイト");

        let bytes = encode_state(7);
        assert_eq!(
            &bytes[..4],
            &STATE_MAGIC.to_le_bytes(),
            "先頭 4 バイトが little-endian の magic でない"
        );
        assert_eq!(
            &bytes[4..8],
            &7i32.to_le_bytes(),
            "後半 4 バイトが little-endian の i32 オフセットでない"
        );
    }

    /// 🔴 不正な state を **黙って 0 に倒さない**（復元したつもりで別の音になるのを防ぐ）。
    #[test]
    fn state_rejects_foreign_and_short_payloads() {
        let mut wrong_magic = encode_state(7);
        wrong_magic[0] ^= 0xFF;
        assert_eq!(decode_state(&wrong_magic), None, "magic 不一致を受理した");

        let short = &encode_state(7)[..STATE_LEN - 1];
        assert_eq!(decode_state(short), None, "長さ不足を受理した");

        assert_eq!(decode_state(&[]), None, "空を受理した");
    }

    /// 期待値は**仕様の式**から導出する（実装が出した値と付き合わせない）。
    #[test]
    fn offset_shifts_pitch_by_semitones() {
        let base = voice_frequency_hz(69, 0);
        assert!(
            (base - 440.0).abs() < 1e-3,
            "A4 (key 69・offset 0) は 440Hz のはず: {base}"
        );

        // +12 半音 = 1 オクターブ = 周波数2倍。
        let octave_up = voice_frequency_hz(69, 12);
        assert!(
            (octave_up / base - 2.0).abs() < 1e-4,
            "+12 半音で 2 倍にならない: {octave_up} / {base}"
        );

        // オフセットは key と等価に効く（key+n と offset+n が同じ音）。
        for (key, offset) in [(60i16, 7i32), (72, -5), (69, 3)] {
            let via_offset = voice_frequency_hz(key, offset);
            let via_key = voice_frequency_hz(key + offset as i16, 0);
            assert!(
                (via_offset - via_key).abs() < 1e-3,
                "key={key} offset={offset}: オフセットが key と等価に効いていない"
            );
        }
    }

    /// 🔴 配線: `note_on` が **実際に** オフセットを使って phase_inc を決めること。
    /// 純関数（`voice_frequency_hz`）のテストだけでは、`note_on` がそれを無視していても green になる。
    #[test]
    fn note_on_applies_state_offset_to_phase_increment() {
        let sample_rate = 48_000.0f32;
        let mut plain = SineVoice {
            phase: 0.0,
            phase_inc: 0.0,
            active: false,
            key: 0,
        };
        let mut shifted = plain;

        plain.note_on(69, sample_rate, 0);
        shifted.note_on(69, sample_rate, 12);

        let expected_plain = TAU * voice_frequency_hz(69, 0) / sample_rate;
        let expected_shifted = TAU * voice_frequency_hz(69, 12) / sample_rate;
        assert!(
            (plain.phase_inc - expected_plain).abs() < 1e-6,
            "offset 0 の phase_inc が仕様式と一致しない"
        );
        assert!(
            (shifted.phase_inc - expected_shifted).abs() < 1e-6,
            "offset 12 の phase_inc が仕様式と一致しない"
        );
        assert!(
            (shifted.phase_inc / plain.phase_inc - 2.0).abs() < 1e-4,
            "offset がヴォイスに反映されていない（phase_inc が変わらない）"
        );
    }
}
