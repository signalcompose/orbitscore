//! instrument/effect の入出力イベントリストとパラメータキュー（#888 子 3・orbit-vst3-host）。
//!
//! 🔴 **これは純粋な移動である。** 本文は 1 行も書き換えていない。

#[allow(unused_imports)]
use crate::*;

/// Working input event list for the instrument processor. `IEventList` is queried synchronously
/// from `IAudioProcessor::process`, so `RefCell` lets the Rust-facing queue and COM callbacks
/// share one allocation without requiring a mutable COM interface.
pub(crate) struct InputEventList {
    pub(crate) wrapper: ComWrapper<HostInputEventList>,
    pub(crate) ptr: ComPtr<IEventList>,
}

impl InputEventList {
    pub(crate) fn new() -> Self {
        let wrapper = ComWrapper::new(HostInputEventList::new());
        let ptr = wrapper
            .to_com_ptr::<IEventList>()
            .expect("HostInputEventList exposes IEventList");
        Self { wrapper, ptr }
    }

    pub(crate) fn push_note_on(&self, channel: i16, pitch: i16, velocity: f32, sample_offset: i32) {
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

    pub(crate) fn push_note_off(
        &self,
        channel: i16,
        pitch: i16,
        velocity: f32,
        sample_offset: i32,
    ) {
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

    pub(crate) fn clear(&self) {
        self.wrapper.events.borrow_mut().clear();
    }

    pub(crate) fn as_ptr(&self) -> *mut IEventList {
        self.ptr.as_ptr()
    }
}

pub(crate) struct HostInputEventList {
    pub(crate) events: RefCell<Vec<Event>>,
}

impl HostInputEventList {
    pub(crate) fn new() -> Self {
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

pub(crate) struct EventList {
    pub(crate) _wrapper: ComWrapper<HostEventList>,
    pub(crate) ptr: ComPtr<IEventList>,
}

impl EventList {
    pub(crate) fn empty() -> Self {
        let wrapper = ComWrapper::new(HostEventList);
        let ptr = wrapper
            .to_com_ptr::<IEventList>()
            .expect("HostEventList exposes IEventList");
        Self {
            _wrapper: wrapper,
            ptr,
        }
    }

    pub(crate) fn as_ptr(&self) -> *mut IEventList {
        self.ptr.as_ptr()
    }
}

pub(crate) struct HostEventList;

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

pub(crate) struct ParameterChanges {
    pub(crate) _wrapper: ComWrapper<HostParameterChanges>,
    pub(crate) ptr: ComPtr<IParameterChanges>,
}

impl ParameterChanges {
    pub(crate) fn empty() -> Self {
        let wrapper = ComWrapper::new(HostParameterChanges::empty());
        let ptr = wrapper
            .to_com_ptr::<IParameterChanges>()
            .expect("HostParameterChanges exposes IParameterChanges");
        Self {
            _wrapper: wrapper,
            ptr,
        }
    }

    pub(crate) fn single_gain(value: f64) -> Self {
        let wrapper = ComWrapper::new(HostParameterChanges::single(0, value));
        let ptr = wrapper
            .to_com_ptr::<IParameterChanges>()
            .expect("HostParameterChanges exposes IParameterChanges");
        Self {
            _wrapper: wrapper,
            ptr,
        }
    }

    pub(crate) fn as_ptr(&self) -> *mut IParameterChanges {
        self.ptr.as_ptr()
    }
}

pub(crate) struct HostParameterChanges {
    pub(crate) queue: Option<ComWrapper<HostParamValueQueue>>,
    pub(crate) queue_ptr: Cell<*mut IParamValueQueue>,
}

impl HostParameterChanges {
    pub(crate) fn empty() -> Self {
        Self {
            queue: None,
            queue_ptr: Cell::new(ptr::null_mut()),
        }
    }

    pub(crate) fn single(param_id: ParamID, value: ParamValue) -> Self {
        Self {
            queue: Some(ComWrapper::new(HostParamValueQueue::new(param_id, value))),
            queue_ptr: Cell::new(ptr::null_mut()),
        }
    }

    pub(crate) fn queue_ptr(&self) -> *mut IParamValueQueue {
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

pub(crate) struct HostParamValueQueue {
    pub(crate) param_id: ParamID,
    pub(crate) value: ParamValue,
}

impl HostParamValueQueue {
    pub(crate) fn new(param_id: ParamID, value: ParamValue) -> Self {
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
