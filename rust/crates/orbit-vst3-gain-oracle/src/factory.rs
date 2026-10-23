//! VST3 factory descriptors, instances, and platform entry points for the gain oracle.

use super::*;

const FACTORY_VENDOR: &str = "OrbitScore Factory Oracle";
const FACTORY_VERSION: &str = "5.4.9";
const FACTORY_SDK_VERSION: &str = "VST 3.7.9";

fn class_identity(index: i32) -> Option<(TUID, &'static str)> {
    match index {
        0 => Some((GainProcessor::CID, "Audio Module Class")),
        1 => Some((GainController::CID, "Component Controller Class")),
        _ => None,
    }
}

unsafe fn fill_class_info(index: i32, info: *mut PClassInfo) -> tresult {
    let Some((cid, category)) = class_identity(index) else {
        return kInvalidArgument;
    };
    let info = &mut *info;
    info.cid = cid;
    info.cardinality = PClassInfo_::ClassCardinality_::kManyInstances as int32;
    copy_cstring(category, &mut info.category);
    copy_cstring(PLUGIN_NAME, &mut info.name);
    kResultOk
}

unsafe fn fill_class_info2(index: i32, info: *mut PClassInfo2) -> tresult {
    let Some((cid, category)) = class_identity(index) else {
        return kInvalidArgument;
    };
    let info = &mut *info;
    info.cid = cid;
    info.cardinality = PClassInfo_::ClassCardinality_::kManyInstances as int32;
    copy_cstring(category, &mut info.category);
    copy_cstring(PLUGIN_NAME, &mut info.name);
    info.classFlags = 0;
    copy_cstring("Fx|Dynamics", &mut info.subCategories);
    copy_cstring(FACTORY_VENDOR, &mut info.vendor);
    copy_cstring(FACTORY_VERSION, &mut info.version);
    copy_cstring(FACTORY_SDK_VERSION, &mut info.sdkVersion);
    kResultOk
}

unsafe fn fill_class_info3(index: i32, info: *mut PClassInfoW) -> tresult {
    let Some((cid, category)) = class_identity(index) else {
        return kInvalidArgument;
    };
    let info = &mut *info;
    info.cid = cid;
    info.cardinality = PClassInfo_::ClassCardinality_::kManyInstances as int32;
    copy_cstring(category, &mut info.category);
    copy_wstring("Gain Ω (Factory3 oracle)", &mut info.name);
    info.classFlags = 0;
    copy_cstring("Fx|Dynamics", &mut info.subCategories);
    copy_wstring(FACTORY_VENDOR, &mut info.vendor);
    copy_wstring(FACTORY_VERSION, &mut info.version);
    copy_wstring(FACTORY_SDK_VERSION, &mut info.sdkVersion);
    kResultOk
}

unsafe fn create_oracle_instance(cid: FIDString, iid: FIDString, obj: *mut *mut c_void) -> tresult {
    let instance = match *(cid as *const TUID) {
        GainProcessor::CID => Some(
            ComWrapper::new(GainProcessor::new())
                .to_com_ptr::<FUnknown>()
                .unwrap(),
        ),
        GainController::CID => Some(
            ComWrapper::new(GainController::new())
                .to_com_ptr::<FUnknown>()
                .unwrap(),
        ),
        _ => None,
    };

    if let Some(instance) = instance {
        let ptr = instance.as_ptr();
        ((*(*ptr).vtbl).queryInterface)(ptr, iid as *mut TUID, obj)
    } else {
        kInvalidArgument
    }
}

struct FactoryV1;
struct FactoryV2;
struct FactoryV3;

impl Class for FactoryV1 {
    type Interfaces = (IPluginFactory,);
}

impl Class for FactoryV2 {
    type Interfaces = (IPluginFactory2,);
}

impl Class for FactoryV3 {
    type Interfaces = (IPluginFactory3,);
}

macro_rules! impl_factory_base {
    ($factory:ty) => {
        impl IPluginFactoryTrait for $factory {
            unsafe fn getFactoryInfo(&self, info: *mut PFactoryInfo) -> tresult {
                let info = &mut *info;
                copy_cstring(FACTORY_VENDOR, &mut info.vendor);
                copy_cstring("https://example.com", &mut info.url);
                copy_cstring("someone@example.com", &mut info.email);
                info.flags = PFactoryInfo_::FactoryFlags_::kUnicode as int32;
                kResultOk
            }

            unsafe fn countClasses(&self) -> i32 {
                2
            }

            unsafe fn getClassInfo(&self, index: i32, info: *mut PClassInfo) -> tresult {
                fill_class_info(index, info)
            }

            unsafe fn createInstance(
                &self,
                cid: FIDString,
                iid: FIDString,
                obj: *mut *mut c_void,
            ) -> tresult {
                if std::env::var_os("ORBIT_VST3_FACTORY_ABORT_CREATE_INSTANCE").is_some() {
                    std::process::abort();
                }
                create_oracle_instance(cid, iid, obj)
            }
        }
    };
}

impl_factory_base!(FactoryV1);
impl_factory_base!(FactoryV2);
impl_factory_base!(FactoryV3);

impl IPluginFactory2Trait for FactoryV2 {
    unsafe fn getClassInfo2(&self, index: i32, info: *mut PClassInfo2) -> tresult {
        fill_class_info2(index, info)
    }
}

impl IPluginFactory2Trait for FactoryV3 {
    unsafe fn getClassInfo2(&self, index: i32, info: *mut PClassInfo2) -> tresult {
        fill_class_info2(index, info)
    }
}

impl IPluginFactory3Trait for FactoryV3 {
    unsafe fn getClassInfoUnicode(&self, index: i32, info: *mut PClassInfoW) -> tresult {
        fill_class_info3(index, info)
    }

    unsafe fn setHostContext(&self, _context: *mut FUnknown) -> tresult {
        kResultOk
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
    match std::env::var("ORBIT_VST3_FACTORY_ORACLE_LEVEL").as_deref() {
        Ok("1") => ComWrapper::new(FactoryV1)
            .to_com_ptr::<IPluginFactory>()
            .unwrap()
            .into_raw(),
        Ok("2") => ComWrapper::new(FactoryV2)
            .to_com_ptr::<IPluginFactory2>()
            .unwrap()
            .upcast::<IPluginFactory>()
            .into_raw(),
        _ => ComWrapper::new(FactoryV3)
            .to_com_ptr::<IPluginFactory3>()
            .unwrap()
            .upcast::<IPluginFactory>()
            .into_raw(),
    }
}
