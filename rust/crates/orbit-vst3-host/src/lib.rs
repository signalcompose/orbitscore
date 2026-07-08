//! orbit-vst3-host — Phase 0 (#381) in-process VST3 host spike.
//!
//! This crate intentionally implements only the offline feasibility surface needed by
//! `docs/development/POST_2.0_VST3_HOSTING_PLAN.md` Phase 0: load a macOS `.vst3` bundle,
//! instantiate the first "Audio Module Class", run one f32 stereo block, and tear down on the
//! same home thread.

use std::cell::Cell;
use std::error::Error;
use std::ffi::c_void;
use std::fmt::{Display, Formatter};
use std::fs;
use std::marker::PhantomData;
use std::path::{Path, PathBuf};
use std::ptr;
use std::rc::Rc;

use libloading::{Library, Symbol};
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
    Io { path: PathBuf, message: String },
    InvalidBundle(PathBuf),
    Dlopen(String),
    MissingSymbol(&'static str),
    NullFactory,
    NoAudioModuleClass,
    CreateInstance(tresult),
    QueryAudioProcessor,
    Initialize(tresult),
    BusArrangement(tresult),
    SetupProcessing(tresult),
    SetActive(tresult),
    SetProcessing(tresult),
    Process(tresult),
    UnsupportedChannels { input: i32, output: i32 },
}

impl Display for Vst3HostError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io { path, message } => write!(f, "{}: {message}", path.display()),
            Self::InvalidBundle(path) => write!(f, "invalid VST3 bundle: {}", path.display()),
            Self::Dlopen(message) => write!(f, "dlopen failed: {message}"),
            Self::MissingSymbol(symbol) => write!(f, "missing symbol: {symbol}"),
            Self::NullFactory => write!(f, "GetPluginFactory returned null"),
            Self::NoAudioModuleClass => write!(f, "no Audio Module Class in VST3 factory"),
            Self::CreateInstance(result) => {
                write!(f, "IPluginFactory::createInstance failed: {result}")
            }
            Self::QueryAudioProcessor => write!(f, "queryInterface(IAudioProcessor) failed"),
            Self::Initialize(result) => write!(f, "IComponent::initialize failed: {result}"),
            Self::BusArrangement(result) => {
                write!(f, "IAudioProcessor::setBusArrangements failed: {result}")
            }
            Self::SetupProcessing(result) => {
                write!(f, "IAudioProcessor::setupProcessing failed: {result}")
            }
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
    library: Library,
    bundle_exit_called: bool,
}

impl LoadedLibrary {
    fn open(bundle_path: &Path) -> Result<Self, Vst3HostError> {
        let dylib_path = resolve_vst3_executable(bundle_path)?;
        let library = unsafe { Library::new(&dylib_path) }
            .map_err(|error| Vst3HostError::Dlopen(format!("{}: {error}", dylib_path.display())))?;

        let mut bundle_exit_called = false;
        unsafe {
            if let Ok(entry) = library.get::<BundleEntry>(b"BundleEntry\0") {
                if entry(ptr::null_mut()) {
                    bundle_exit_called = true;
                }
            }
        }

        Ok(Self {
            library,
            bundle_exit_called,
        })
    }

    unsafe fn get_factory(&self) -> Result<ComPtr<IPluginFactory>, Vst3HostError> {
        let get_factory: Symbol<'_, GetPluginFactory> = self
            .library
            .get(b"GetPluginFactory\0")
            .map_err(|_| Vst3HostError::MissingSymbol("GetPluginFactory"))?;
        let raw = get_factory();
        ComPtr::from_raw(raw).ok_or(Vst3HostError::NullFactory)
    }
}

impl Drop for LoadedLibrary {
    fn drop(&mut self) {
        if self.bundle_exit_called {
            unsafe {
                if let Ok(exit) = self.library.get::<BundleExit>(b"BundleExit\0") {
                    let _ = exit();
                }
            }
        }
    }
}

/// Single-threaded VST3 effect processor.
///
/// `Rc` makes this type `!Send` and `!Sync`. Construct, process, and drop it on the same home
/// thread. Field order is load-bearing: Rust drops fields top-to-bottom, so `processor` is released
/// before `component`, then `factory`, and finally the dynamic library is unloaded.
pub struct Vst3EffectProcessor {
    processor: Option<ComPtr<IAudioProcessor>>,
    component: Option<ComPtr<IComponent>>,
    _host_context: ComWrapper<HostApplication>,
    factory: Option<ComPtr<IPluginFactory>>,
    _home_thread: PhantomData<Rc<()>>,
    _library: LoadedLibrary,
    info: LoadedVst3Info,
    sample_rate: f64,
    max_samples_per_block: i32,
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

        // Phase 0 only verifies the effect overwrite path. This detection is separate from CLAP's
        // `has_audio_input`; treating an instrument as an effect would be silent-but-wrong because
        // the dry signal would be overwritten instead of add-mixed.
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

        let processing_result = unsafe { processor.setProcessing(1) };
        if !is_ok(processing_result) {
            return Err(Vst3HostError::SetProcessing(processing_result));
        }

        let processor = Self {
            processor: Some(processor),
            component: Some(component),
            _host_context: host_context,
            factory: Some(factory),
            _home_thread: PhantomData,
            _library: library,
            info: info.clone(),
            sample_rate,
            max_samples_per_block,
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
        let processor = self
            .processor
            .as_ref()
            .expect("processor remains alive until drop");

        let mut input_ptrs = [input_l.as_ptr() as *mut f32, input_r.as_ptr() as *mut f32];
        let mut output_ptrs = [output_l.as_mut_ptr(), output_r.as_mut_ptr()];
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

        let parameter_changes = gain.map(ParameterChanges::single_gain);
        let input_parameter_changes = parameter_changes
            .as_ref()
            .map(|changes| changes.as_ptr())
            .unwrap_or(ptr::null_mut());

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
            inputParameterChanges: input_parameter_changes,
            outputParameterChanges: ptr::null_mut(),
            inputEvents: ptr::null_mut(),
            outputEvents: ptr::null_mut(),
            processContext: ptr::null_mut(),
        };

        let result = unsafe { processor.process(&mut process_data) };
        if !is_ok(result) {
            return Err(Vst3HostError::Process(result));
        }
        Ok(ProcessReport {
            processed: true,
            is_effect: self.info.is_effect,
        })
    }
}

impl Drop for Vst3EffectProcessor {
    fn drop(&mut self) {
        if let Some(processor) = self.processor.take() {
            unsafe {
                let _ = processor.setProcessing(0);
            }
        }
        if let Some(component) = self.component.take() {
            unsafe {
                let _ = component.setActive(0);
                let _ = component.terminate();
            }
        }
        let _ = self.factory.take();
        let _ = (self.sample_rate, self.max_samples_per_block);
    }
}

struct AudioModuleClass {
    cid: TUID,
    name: String,
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

    let result = unsafe {
        processor.setBusArrangements(
            ptr_or_null_mut(&mut input_arrangements),
            input_arrangements.len() as i32,
            ptr_or_null_mut(&mut output_arrangements),
            output_arrangements.len() as i32,
        )
    };
    if !is_ok(result) {
        return Err(Vst3HostError::BusArrangement(result));
    }

    activate_audio_buses(component, BusDirections_::kInput as i32, input_buses);
    activate_audio_buses(component, BusDirections_::kOutput as i32, output_buses);
    Ok(())
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

fn activate_audio_buses(component: &ComPtr<IComponent>, direction: BusDirection, bus_count: i32) {
    for index in 0..bus_count {
        unsafe {
            let _ = component.activateBus(MediaTypes_::kAudio as i32, direction, index, 1);
        }
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

fn resolve_vst3_executable(bundle_path: &Path) -> Result<PathBuf, Vst3HostError> {
    if bundle_path.extension().and_then(|ext| ext.to_str()) != Some("vst3") {
        return Err(Vst3HostError::InvalidBundle(bundle_path.to_path_buf()));
    }
    let executable = read_cf_bundle_executable(bundle_path).or_else(|| {
        bundle_path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .map(ToOwned::to_owned)
    });
    let executable = executable.ok_or_else(|| Vst3HostError::InvalidBundle(bundle_path.into()))?;
    Ok(bundle_path.join("Contents").join("MacOS").join(executable))
}

fn read_cf_bundle_executable(bundle_path: &Path) -> Option<String> {
    let plist_path = bundle_path.join("Contents").join("Info.plist");
    let plist = fs::read_to_string(&plist_path).ok()?;
    let key_pos = plist.find("<key>CFBundleExecutable</key>")?;
    let after_key = &plist[key_pos..];
    let string_start = after_key.find("<string>")? + "<string>".len();
    let string_end = after_key[string_start..].find("</string>")?;
    Some(
        after_key[string_start..string_start + string_end]
            .trim()
            .to_owned(),
    )
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

struct ParameterChanges {
    _wrapper: ComWrapper<HostParameterChanges>,
    ptr: ComPtr<IParameterChanges>,
}

impl ParameterChanges {
    fn single_gain(value: f64) -> Self {
        let wrapper = ComWrapper::new(HostParameterChanges::new(0, value));
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
    queue: ComWrapper<HostParamValueQueue>,
    queue_ptr: Cell<*mut IParamValueQueue>,
}

impl HostParameterChanges {
    fn new(param_id: ParamID, value: ParamValue) -> Self {
        Self {
            queue: ComWrapper::new(HostParamValueQueue::new(param_id, value)),
            queue_ptr: Cell::new(ptr::null_mut()),
        }
    }

    fn queue_ptr(&self) -> *mut IParamValueQueue {
        let existing = self.queue_ptr.get();
        if !existing.is_null() {
            return existing;
        }
        let ptr = self
            .queue
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
        1
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
            let input_l = vec![0.0; 512];
            let input_r = vec![0.0; 512];
            let mut output_l = vec![0.0; 512];
            let mut output_r = vec![0.0; 512];
            let mut error = None;
            let processed = if info.is_effect {
                match processor.process_stereo(
                    &input_l,
                    &input_r,
                    &mut output_l,
                    &mut output_r,
                    None,
                ) {
                    Ok(_) => {
                        if let Err(message) = validate_silent_block(&output_l, &output_r) {
                            error = Some(message);
                            false
                        } else {
                            let known_l = (0..512)
                                .map(|i| (i as f32 - 128.0) / 512.0)
                                .collect::<Vec<_>>();
                            let known_r = (0..512)
                                .map(|i| ((i as f32 * 3.0) - 256.0) / 1024.0)
                                .collect::<Vec<_>>();
                            output_l.fill(0.0);
                            output_r.fill(0.0);
                            match processor.process_stereo(
                                &known_l,
                                &known_r,
                                &mut output_l,
                                &mut output_r,
                                None,
                            ) {
                                Ok(_) => match validate_known_block(&output_l, &output_r) {
                                    Ok(()) => true,
                                    Err(message) => {
                                        error = Some(message);
                                        false
                                    }
                                },
                                Err(err) => {
                                    error = Some(err.to_string());
                                    false
                                }
                            }
                        }
                    }
                    Err(err) => {
                        error = Some(err.to_string());
                        false
                    }
                }
            } else {
                error = Some(
                    "instrument/add-mix path detected; Phase 0 probe did not process".to_owned(),
                );
                false
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
    value
        .chars()
        .flat_map(|ch| match ch {
            '"' => "\\\"".chars().collect::<Vec<_>>(),
            '\\' => "\\\\".chars().collect::<Vec<_>>(),
            '\n' => "\\n".chars().collect::<Vec<_>>(),
            '\r' => "\\r".chars().collect::<Vec<_>>(),
            '\t' => "\\t".chars().collect::<Vec<_>>(),
            _ => vec![ch],
        })
        .collect()
}
