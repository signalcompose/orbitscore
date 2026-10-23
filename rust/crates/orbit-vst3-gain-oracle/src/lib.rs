// orbit-vst3-gain-oracle — Phase 0 (#381) sample-exact test oracle.
//
// VENDORED verbatim from the `vst3` crate's `examples/gain.rs`
// (vst3 v0.3.0, MIT OR Apache-2.0, github.com/coupler-rs/vst3-rs).
// 挙動: out[i] = gain * in[i]（smoothing なし・default gain=1.0・2-in/2-out）。
// このプラグインの挙動を我々が完全に把握していることが oracle たる要点。
// host spike（orbit-vst3-host）はこの既知挙動を sample-exact に再現できねばならない。
//
// Processor CID: 6E332252-54224A00-AA69301A-F318797D
// 正本: docs/development/POST_2.0_VST3_HOSTING_PLAN.md §Phase 0 (0b ①)
#![allow(non_upper_case_globals)]
#![allow(non_camel_case_types)]
#![allow(non_snake_case)]
// vendored upstream code なので clippy の style/complexity 指摘は抑制（意味を変えない）。
// CI は `clippy -D warnings`。upstream gain.rs の unnecessary_cast 等をここで許容する。
#![allow(clippy::all)]

use std::cell::Cell;
use std::ffi::{c_char, c_void, CString};
use std::str::FromStr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::{ptr, slice};

use vst3::{uid, Class, ComRef, ComWrapper, Steinberg::Vst::*, Steinberg::*};

mod controller_state_seam;
mod factory;

fn copy_cstring(src: &str, dst: &mut [c_char]) {
    let c_string = CString::new(src).unwrap_or_else(|_| CString::default());
    let bytes = c_string.as_bytes_with_nul();

    for (src, dst) in bytes.iter().zip(dst.iter_mut()) {
        *dst = *src as c_char;
    }

    if bytes.len() > dst.len() {
        if let Some(last) = dst.last_mut() {
            *last = 0;
        }
    }
}

fn copy_wstring(src: &str, dst: &mut [TChar]) {
    let mut len = 0;
    for (src, dst) in src.encode_utf16().zip(dst.iter_mut()) {
        *dst = src as TChar;
        len += 1;
    }

    if len < dst.len() {
        dst[len] = 0;
    } else if let Some(last) = dst.last_mut() {
        *last = 0;
    }
}

unsafe fn len_wstring(string: *const TChar) -> usize {
    let mut len = 0;

    while *string.offset(len) != 0 {
        len += 1;
    }

    len as usize
}

const PLUGIN_NAME: &'static str = "Gain (vst3-rs example plugin)";

/// VST3 / CLAP effect oracle 共通の state 契約（magic + f64 gain bits）。
pub const STATE_MAGIC: u32 = 0x4F52_4531; // "ORE1"
pub const STATE_LEN: usize = 12;

pub fn encode_state(gain: f64) -> [u8; STATE_LEN] {
    let mut bytes = [0u8; STATE_LEN];
    bytes[..4].copy_from_slice(&STATE_MAGIC.to_le_bytes());
    bytes[4..].copy_from_slice(&gain.to_bits().to_le_bytes());
    bytes
}

pub fn decode_state(bytes: &[u8]) -> Option<f64> {
    if bytes.len() != STATE_LEN {
        return None;
    }
    let magic = u32::from_le_bytes(bytes[..4].try_into().ok()?);
    if magic != STATE_MAGIC {
        return None;
    }
    let bits = u64::from_le_bytes(bytes[4..].try_into().ok()?);
    let gain = f64::from_bits(bits);
    gain.is_finite().then_some(gain)
}

struct GainProcessor {
    gain: AtomicU64,
    /// Test oracle invariant: ProcessSetup and every ProcessData must carry the same session mode.
    process_mode: Cell<i32>,
}

impl Class for GainProcessor {
    type Interfaces = (
        IComponent,
        IAudioProcessor,
        IProcessContextRequirements,
        IEditController,
    );
}

impl GainProcessor {
    const CID: TUID = uid(0x6E332252, 0x54224A00, 0xAA69301A, 0xF318797D);

    fn new() -> GainProcessor {
        GainProcessor {
            gain: AtomicU64::new(1.0f64.to_bits()),
            process_mode: Cell::new(ProcessModes_::kRealtime as i32),
        }
    }
}

impl IPluginBaseTrait for GainProcessor {
    unsafe fn initialize(&self, _context: *mut FUnknown) -> tresult {
        kResultOk
    }

    unsafe fn terminate(&self) -> tresult {
        kResultOk
    }
}

impl IComponentTrait for GainProcessor {
    unsafe fn getControllerClassId(&self, class_id: *mut TUID) -> tresult {
        if std::env::var_os("ORBIT_VST3_GAIN_SINGLE_COMPONENT").is_some() {
            return kNotImplemented;
        }
        *class_id = GainController::CID;
        kResultOk
    }

    unsafe fn setIoMode(&self, _mode: IoMode) -> tresult {
        kResultOk
    }

    unsafe fn getBusCount(&self, mediaType: MediaType, dir: BusDirection) -> i32 {
        match mediaType as BusDirections {
            MediaTypes_::kAudio => match dir as BusDirections {
                BusDirections_::kInput => 1,
                BusDirections_::kOutput => 1,
                _ => 0,
            },
            MediaTypes_::kEvent => 0,
            _ => 0,
        }
    }

    unsafe fn getBusInfo(
        &self,
        mediaType: MediaType,
        dir: BusDirection,
        index: i32,
        bus: *mut BusInfo,
    ) -> tresult {
        match mediaType as MediaTypes {
            MediaTypes_::kAudio => match dir as BusDirections {
                BusDirections_::kInput => match index {
                    0 => {
                        let bus = &mut *bus;

                        bus.mediaType = MediaTypes_::kAudio as MediaType;
                        bus.direction = BusDirections_::kInput as BusDirection;
                        bus.channelCount = 2;
                        copy_wstring("Input", &mut bus.name);
                        bus.busType = BusTypes_::kMain as BusType;
                        bus.flags = BusInfo_::BusFlags_::kDefaultActive as u32;

                        kResultOk
                    }
                    _ => kInvalidArgument,
                },
                BusDirections_::kOutput => match index {
                    0 => {
                        let bus = &mut *bus;

                        bus.mediaType = MediaTypes_::kAudio as MediaType;
                        bus.direction = BusDirections_::kOutput as BusDirection;
                        bus.channelCount = 2;
                        copy_wstring("Output", &mut bus.name);
                        bus.busType = BusTypes_::kMain as BusType;
                        bus.flags = BusInfo_::BusFlags_::kDefaultActive as u32 as uint32;

                        kResultOk
                    }
                    _ => kInvalidArgument,
                },
                _ => kInvalidArgument,
            },
            MediaTypes_::kEvent => kInvalidArgument,
            _ => kInvalidArgument,
        }
    }

    unsafe fn getRoutingInfo(
        &self,
        _in_info: *mut RoutingInfo,
        _out_info: *mut RoutingInfo,
    ) -> tresult {
        kNotImplemented
    }

    unsafe fn activateBus(
        &self,
        _media_type: MediaType,
        _dir: BusDirection,
        _index: i32,
        _state: TBool,
    ) -> tresult {
        kResultOk
    }

    unsafe fn setActive(&self, _state: TBool) -> tresult {
        kResultOk
    }

    unsafe fn setState(&self, state: *mut IBStream) -> tresult {
        controller_state_seam::trace("component.setState");
        if state.is_null() {
            return kResultFalse;
        }
        let Some(stream) = ComRef::from_raw(state) else {
            return kResultFalse;
        };
        let mut bytes = [0u8; STATE_LEN];
        let mut read = 0;
        let result = stream.read(
            bytes.as_mut_ptr().cast::<c_void>(),
            STATE_LEN as i32,
            &mut read,
        );
        if result != kResultOk || read != STATE_LEN as i32 {
            return kResultFalse;
        }
        let Some(gain) = decode_state(&bytes) else {
            return kResultFalse;
        };
        self.gain.store(gain.to_bits(), Ordering::Relaxed);
        kResultOk
    }

    unsafe fn getState(&self, state: *mut IBStream) -> tresult {
        controller_state_seam::trace("component.getState");
        if state.is_null() {
            return kResultFalse;
        }
        if std::env::var_os("ORBIT_VST3_GAIN_EMPTY_STATE").is_some() {
            return kResultOk;
        }
        let Some(stream) = ComRef::from_raw(state) else {
            return kResultFalse;
        };
        let mut bytes = encode_state(f64::from_bits(self.gain.load(Ordering::Relaxed)));
        let mut written = 0;
        let result = stream.write(
            bytes.as_mut_ptr().cast::<c_void>(),
            STATE_LEN as i32,
            &mut written,
        );
        if result != kResultOk || written != STATE_LEN as i32 {
            return kResultFalse;
        }
        kResultOk
    }
}

impl IAudioProcessorTrait for GainProcessor {
    unsafe fn setBusArrangements(
        &self,
        inputs: *mut SpeakerArrangement,
        num_ins: i32,
        outputs: *mut SpeakerArrangement,
        num_outs: i32,
    ) -> tresult {
        if num_ins != 1 || num_outs != 1 {
            return kResultFalse;
        }

        if *inputs != SpeakerArr::kStereo || *outputs != SpeakerArr::kStereo {
            return kResultFalse;
        }

        kResultTrue
    }

    unsafe fn getBusArrangement(
        &self,
        dir: BusDirection,
        index: i32,
        arr: *mut SpeakerArrangement,
    ) -> tresult {
        match dir as BusDirections {
            BusDirections_::kInput => {
                if index == 0 {
                    *arr = SpeakerArr::kStereo;
                    kResultOk
                } else {
                    kInvalidArgument
                }
            }
            BusDirections_::kOutput => {
                if index == 0 {
                    *arr = SpeakerArr::kStereo;
                    kResultOk
                } else {
                    kInvalidArgument
                }
            }
            _ => kInvalidArgument,
        }
    }

    unsafe fn canProcessSampleSize(&self, symbolic_sample_size: i32) -> tresult {
        match symbolic_sample_size as SymbolicSampleSizes {
            SymbolicSampleSizes_::kSample32 => kResultOk as i32,
            SymbolicSampleSizes_::kSample64 => kNotImplemented as i32,
            _ => kInvalidArgument,
        }
    }

    unsafe fn getLatencySamples(&self) -> u32 {
        0
    }

    unsafe fn setupProcessing(&self, setup: *mut ProcessSetup) -> tresult {
        if setup.is_null() {
            return kInvalidArgument;
        }
        self.process_mode.set((*setup).processMode);
        kResultOk
    }

    unsafe fn setProcessing(&self, _state: TBool) -> tresult {
        kResultOk
    }

    unsafe fn process(&self, data: *mut ProcessData) -> tresult {
        let process_data = &*data;
        if process_data.processMode != self.process_mode.get() {
            return kInvalidArgument;
        }

        if let Some(param_changes) = ComRef::from_raw(process_data.inputParameterChanges) {
            let param_count = param_changes.getParameterCount();
            for param_index in 0..param_count {
                if let Some(param_queue) =
                    ComRef::from_raw(param_changes.getParameterData(param_index))
                {
                    let param_id = param_queue.getParameterId();
                    let point_count = param_queue.getPointCount();

                    match param_id {
                        0 => {
                            let mut sample_offset = 0;
                            let mut value = 0.0;
                            let result = param_queue.getPoint(
                                point_count - 1,
                                &mut sample_offset,
                                &mut value,
                            );

                            if result == kResultTrue {
                                self.gain.store(value.to_bits(), Ordering::Relaxed);
                            }
                        }
                        _ => {}
                    }
                }
            }
        }

        let gain = f64::from_bits(self.gain.load(Ordering::Relaxed)) as f32;
        // Make the raw VST3 process mode observable to host tests.  Offline
        // rendering inverts the otherwise sample-exact oracle output, so a
        // host that silently maps offline back to kRealtime is caught.
        let mode_scale = if self.process_mode.get() == ProcessModes_::kOffline as i32 {
            -1.0
        } else {
            1.0
        };

        let num_samples = process_data.numSamples as usize;

        if process_data.numInputs != 1 || process_data.numOutputs != 1 {
            return kResultOk;
        }

        let input_buses =
            slice::from_raw_parts(process_data.inputs, process_data.numInputs as usize);
        let output_buses =
            slice::from_raw_parts(process_data.outputs, process_data.numOutputs as usize);

        if input_buses[0].numChannels != 2 || output_buses[0].numChannels != 2 {
            return kResultOk;
        }

        let input_channels = slice::from_raw_parts(
            input_buses[0].__field0.channelBuffers32,
            input_buses[0].numChannels as usize,
        );
        let output_channels = slice::from_raw_parts(
            output_buses[0].__field0.channelBuffers32,
            output_buses[0].numChannels as usize,
        );

        let input_l = slice::from_raw_parts(input_channels[0], num_samples);
        let input_r = slice::from_raw_parts(input_channels[1], num_samples);
        let output_l = slice::from_raw_parts_mut(output_channels[0], num_samples);
        let output_r = slice::from_raw_parts_mut(output_channels[1], num_samples);

        for i in 0..num_samples {
            output_l[i] = mode_scale * gain * input_l[i];
            output_r[i] = mode_scale * gain * input_r[i];
        }

        kResultOk
    }

    unsafe fn getTailSamples(&self) -> u32 {
        0
    }
}

impl IProcessContextRequirementsTrait for GainProcessor {
    unsafe fn getProcessContextRequirements(&self) -> u32 {
        0
    }
}

struct GainController {
    gain: Cell<f64>,
}

impl Class for GainController {
    type Interfaces = (IEditController,);
}

impl GainController {
    const CID: TUID = uid(0x1BA8A477, 0xEE0A4A2D, 0x80F50D14, 0x13D2EAA0);

    fn new() -> GainController {
        GainController {
            gain: Cell::new(1.0),
        }
    }
}

impl IPluginBaseTrait for GainController {
    unsafe fn initialize(&self, _context: *mut FUnknown) -> tresult {
        kResultOk
    }

    unsafe fn terminate(&self) -> tresult {
        kResultOk
    }
}

/// Packages this oracle as a process-unique macOS VST3 bundle for integration tests.
///
/// The unique output path avoids concurrent workspace test processes replacing a bundle while
/// another process has it loaded.
pub fn package_bundle() -> Option<std::path::PathBuf> {
    use std::sync::OnceLock;
    static BUNDLE: OnceLock<Option<std::path::PathBuf>> = OnceLock::new();
    BUNDLE
        .get_or_init(|| {
            let script =
                std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("package-oracle.sh");
            let output = std::process::Command::new(&script)
                .arg("debug")
                .arg(format!("-{}", std::process::id()))
                .output()
                .ok()?;
            if !output.status.success() {
                eprintln!(
                    "gain oracle packaging failed: status={} stderr={}",
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

    #[test]
    fn effect_state_encoding_round_trips_and_rejects_corruption() {
        let bytes = encode_state(0.25);
        assert_eq!(decode_state(&bytes), Some(0.25));
        assert_eq!(bytes.len(), STATE_LEN);
        let mut wrong_magic = bytes;
        wrong_magic[0] ^= 0xFF;
        assert_eq!(decode_state(&wrong_magic), None);
        assert_eq!(decode_state(&bytes[..STATE_LEN - 1]), None);
        assert_eq!(decode_state(&encode_state(f64::NAN)), None);
    }

    #[test]
    fn effect_state_encoding_matches_cross_format_contract() {
        assert_eq!(STATE_MAGIC, 0x4F52_4531);
        assert_eq!(STATE_LEN, 12);
        assert_eq!(
            encode_state(0.25),
            [0x31, 0x45, 0x52, 0x4F, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xD0, 0x3F,]
        );
    }
}
