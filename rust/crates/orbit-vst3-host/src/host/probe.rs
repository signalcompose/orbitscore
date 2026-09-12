//! VST3 プラグインの probe（#888 子 3・orbit-vst3-host）。
//!
//! factory 記述子の読み出し、`probe_plugin` の判定、無音/既知ブロックの検証、
//! および結果の JSON 化。🔴 **これは純粋な移動である。** 本文は 1 行も書き換えていない。

#[allow(unused_imports)]
use crate::*;

pub(crate) fn factory_open_error(error: Vst3HostError) -> FactoryProbeError {
    match error {
        Vst3HostError::InvalidBundle(path) => FactoryProbeError::InvalidBundle(path),
        Vst3HostError::BundleLoad(message) => FactoryProbeError::BundleLoad(message),
        Vst3HostError::MissingSymbol(symbol) => FactoryProbeError::MissingSymbol(symbol),
        Vst3HostError::NullFactory => FactoryProbeError::NullFactory,
        other => FactoryProbeError::BundleLoad(other.to_string()),
    }
}

pub(crate) fn read_factory_descriptor(
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

pub(crate) fn char16_array_to_string(data: &[TChar]) -> String {
    let nul = data
        .iter()
        .position(|value| *value == 0)
        .unwrap_or(data.len());
    String::from_utf16_lossy(&data[..nul])
}

pub(crate) fn tuid_to_string(cid: &TUID) -> String {
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
pub(crate) fn probe_effect_signal(processor: &mut Vst3EffectProcessor) -> Result<(), String> {
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

pub(crate) fn validate_silent_block(left: &[f32], right: &[f32]) -> Result<(), String> {
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

pub(crate) fn validate_known_block(left: &[f32], right: &[f32]) -> Result<(), String> {
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

pub(crate) fn json_escape(value: &str) -> String {
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
