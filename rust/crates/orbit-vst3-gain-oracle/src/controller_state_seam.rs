//! Environment-controlled controller-state behavior for host integration tests.

use super::*;
use std::fs::OpenOptions;
use std::io::Write;
use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};

const CONTROLLER_STATE: &[u8] = b"ORBIT-CONTROLLER";
static GET_STATE_CALLS: AtomicUsize = AtomicUsize::new(0);

pub(super) fn trace(event: &str) {
    let Some(path) = std::env::var_os("ORBIT_VST3_GAIN_STATE_TRACE_FILE") else {
        return;
    };
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .expect("open gain-oracle state trace");
    writeln!(file, "{event}").expect("append gain-oracle state trace");
}

unsafe fn write_bytes(state: *mut IBStream, bytes: &[u8]) -> tresult {
    let Some(stream) = ComRef::from_raw(state) else {
        return kResultFalse;
    };
    let mut owned = bytes.to_vec();
    let mut written = 0;
    let result = stream.write(
        owned.as_mut_ptr().cast::<c_void>(),
        owned.len() as i32,
        &mut written,
    );
    if result == kResultOk && written == owned.len() as i32 {
        kResultOk
    } else {
        kResultFalse
    }
}

pub(super) unsafe fn controller_get_state(state: *mut IBStream, gain: f64) -> tresult {
    trace("controller.getState");
    if state.is_null() {
        return kResultFalse;
    }
    let call = GET_STATE_CALLS.fetch_add(1, AtomicOrdering::Relaxed);
    match std::env::var("ORBIT_VST3_GAIN_CONTROLLER_STATE").as_deref() {
        Ok("known") => write_bytes(state, CONTROLLER_STATE),
        Ok("not-implemented") => kNotImplemented,
        Ok("failure") => kResultFalse,
        Ok("failure-changing") if call == 0 => kResultFalse,
        Ok("failure-changing") => kInvalidArgument,
        Ok("failure-success-failure") if call == 1 => write_bytes(state, CONTROLLER_STATE),
        Ok("failure-success-failure") => kResultFalse,
        Ok("echo") => write_bytes(state, &encode_state(gain)),
        Ok("echo-then-distinct") if call == 0 => write_bytes(state, &encode_state(gain)),
        Ok("echo-then-distinct") => write_bytes(state, CONTROLLER_STATE),
        Ok("echo-interrupted-echo") if call == 0 || call == 2 => {
            write_bytes(state, &encode_state(gain))
        }
        Ok("echo-interrupted-echo") => write_bytes(state, CONTROLLER_STATE),
        _ => kResultOk,
    }
}

pub(super) unsafe fn controller_set_state(state: *mut IBStream) -> tresult {
    trace("controller.setState");
    if state.is_null() {
        return kResultFalse;
    }
    let Some(stream) = ComRef::from_raw(state) else {
        return kResultFalse;
    };
    let mut bytes = [0u8; 256];
    let mut read = 0;
    let result = stream.read(
        bytes.as_mut_ptr().cast::<c_void>(),
        bytes.len() as i32,
        &mut read,
    );
    if result != kResultOk || read < 0 {
        return kResultFalse;
    }
    if let Some(path) = std::env::var_os("ORBIT_VST3_GAIN_CONTROLLER_SET_STATE_FILE") {
        std::fs::write(path, &bytes[..read as usize])
            .expect("write observed controller setState bytes");
    }
    kResultOk
}

impl IEditControllerTrait for GainProcessor {
    unsafe fn setComponentState(&self, _state: *mut IBStream) -> tresult {
        trace("controller.setComponentState");
        kResultOk
    }

    unsafe fn setState(&self, state: *mut IBStream) -> tresult {
        controller_set_state(state)
    }

    unsafe fn getState(&self, state: *mut IBStream) -> tresult {
        controller_get_state(state, f64::from_bits(self.gain.load(Ordering::Relaxed)))
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

impl IEditControllerTrait for GainController {
    unsafe fn setComponentState(&self, _state: *mut IBStream) -> tresult {
        trace("controller.setComponentState");
        kNotImplemented
    }

    unsafe fn setState(&self, state: *mut IBStream) -> tresult {
        controller_set_state(state)
    }

    unsafe fn getState(&self, state: *mut IBStream) -> tresult {
        controller_get_state(state, self.gain.get())
    }

    unsafe fn getParameterCount(&self) -> i32 {
        1
    }

    unsafe fn getParameterInfo(&self, param_index: i32, info: *mut ParameterInfo) -> tresult {
        match param_index {
            0 => {
                let info = &mut *info;
                info.id = 0;
                copy_wstring("Gain", &mut info.title);
                copy_wstring("Gain", &mut info.shortTitle);
                copy_wstring("", &mut info.units);
                info.stepCount = 0;
                info.defaultNormalizedValue = 1.0;
                info.unitId = 0;
                info.flags = ParameterInfo_::ParameterFlags_::kCanAutomate as i32;
                kResultOk
            }
            _ => kInvalidArgument,
        }
    }

    unsafe fn getParamStringByValue(
        &self,
        id: u32,
        value_normalized: f64,
        string: *mut String128,
    ) -> tresult {
        let slice = &mut *string;
        match id {
            0 => {
                copy_wstring(&value_normalized.to_string(), slice);
                kResultOk
            }
            _ => kInvalidArgument,
        }
    }

    unsafe fn getParamValueByString(
        &self,
        id: u32,
        string: *mut TChar,
        value_normalized: *mut f64,
    ) -> tresult {
        match id {
            0 => {
                let len = len_wstring(string as *const TChar);
                if let Ok(string) = String::from_utf16(slice::from_raw_parts(string.cast(), len)) {
                    if let Ok(value) = f64::from_str(&string) {
                        *value_normalized = value;
                        return kResultOk;
                    }
                }
                kInvalidArgument
            }
            _ => kInvalidArgument,
        }
    }

    unsafe fn normalizedParamToPlain(&self, id: u32, value: f64) -> f64 {
        if id == 0 {
            value
        } else {
            0.0
        }
    }

    unsafe fn plainParamToNormalized(&self, id: u32, value: f64) -> f64 {
        if id == 0 {
            value
        } else {
            0.0
        }
    }

    unsafe fn getParamNormalized(&self, id: u32) -> f64 {
        if id == 0 {
            self.gain.get()
        } else {
            0.0
        }
    }

    unsafe fn setParamNormalized(&self, id: u32, value: f64) -> tresult {
        if id == 0 {
            self.gain.set(value);
            kResultOk
        } else {
            kInvalidArgument
        }
    }

    unsafe fn setComponentHandler(&self, _handler: *mut IComponentHandler) -> tresult {
        kResultOk
    }

    unsafe fn createView(&self, _name: *const c_char) -> *mut IPlugView {
        ptr::null_mut()
    }
}
