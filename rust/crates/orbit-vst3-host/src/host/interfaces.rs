//! VST3 ホスト側インターフェースの実装（#888 子 3・orbit-vst3-host）。
//!
//! 🔴 **これは純粋な移動である。** `IHostApplication` / `IAttributeList` / `IBStream` /
//! イベントリスト / パラメータキューの実装をそのまま移した。本文は 1 行も書き換えていない。

#[allow(unused_imports)]
use crate::*;

impl Drop for Vst3EffectAudio {
    fn drop(&mut self) {
        let result = unsafe { self.processor.setProcessing(0) };
        if !is_ok(result) && result != kNotImplemented {
            eprintln!("[orbit-vst3-host] effect setProcessing(0) failed: {result}");
        }
    }
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

pub(crate) struct HostMessage {
    pub(crate) message_id: Cell<*const i8>,
    pub(crate) attributes: ComWrapper<HostAttributeList>,
    pub(crate) attributes_ptr: Cell<*mut IAttributeList>,
}

impl HostMessage {
    pub(crate) fn new() -> Self {
        Self {
            message_id: Cell::new(ptr::null()),
            attributes: ComWrapper::new(HostAttributeList),
            attributes_ptr: Cell::new(ptr::null_mut()),
        }
    }

    pub(crate) fn attributes_ptr(&self) -> *mut IAttributeList {
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

pub(crate) struct HostAttributeList;

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

pub(crate) fn copy_wstring(src: &str, dst: &mut [TChar]) {
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

pub(crate) struct HostComponentHandler;

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

pub(crate) struct MemoryStream {
    pub(crate) data: RefCell<Vec<u8>>,
    pub(crate) pos: Cell<usize>,
}

impl MemoryStream {
    pub(crate) fn new() -> Self {
        Self {
            data: RefCell::new(Vec::new()),
            pos: Cell::new(0),
        }
    }

    /// #540 P2: 保存済み state chunk を読み出し位置 0 で包む（`setState` 系へ渡す用）。
    pub(crate) fn with_data(data: Vec<u8>) -> Self {
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
