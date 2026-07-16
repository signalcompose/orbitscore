//! Known-behavior VST3 instrument oracle: a monophonic stereo sine synth.
#![allow(non_upper_case_globals, non_camel_case_types, non_snake_case)]

use std::cell::Cell;
use std::f32::consts::TAU;
use std::ffi::{c_char, c_void, CString};
use std::{ptr, slice};

use vst3::{uid, Class, ComRef, ComWrapper, Steinberg::Vst::*, Steinberg::*};

const PLUGIN_NAME: &str = "Orbit VST3 Synth Oracle";

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

#[derive(Clone, Copy)]
struct SineVoice {
    phase: f32,
    phase_inc: f32,
    active: bool,
    key: i16,
}

impl SineVoice {
    fn note_on(&mut self, key: i16, sample_rate: f32) {
        let frequency = 440.0 * 2.0f32.powf((key as f32 - 69.0) / 12.0);
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
    unsafe fn setState(&self, _state: *mut IBStream) -> tresult {
        kResultOk
    }
    unsafe fn getState(&self, _state: *mut IBStream) -> tresult {
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
                    Event_::EventTypes_::kNoteOnEvent => {
                        voice.note_on(event.__field0.noteOn.pitch, self.sample_rate.get())
                    }
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
    unsafe fn createView(&self, _name: *const c_char) -> *mut IPlugView {
        ptr::null_mut()
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
