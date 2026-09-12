//! プラグインのセットアップ（controller 接続・preset・バス構成）（#888 子 3・orbit-vst3-host）。
//!
//! 🔴 **これは純粋な移動である。** `lib.rs` からそのまま移した。本文は 1 行も書き換えていない。

#[allow(unused_imports)]
use crate::*;

pub(crate) fn connect_controller(
    factory: &ComPtr<IPluginFactory>,
    component: &ComPtr<IComponent>,
    _host_context: &ComWrapper<HostApplication>,
    host_context_ptr: *mut FUnknown,
) -> Result<ControllerHandshake, Vst3HostError> {
    let mut controller_cid = [0; 16];
    let cid_result = unsafe { component.getControllerClassId(&mut controller_cid) };
    if !is_ok(cid_result) {
        // 単一コンポーネント plugin の fallback（#603）。
        //
        // `getControllerClassId` が失敗する plugin は、別クラスの controller を持たず
        // **component 自身が `IEditController` を実装する**。この場合は component を
        // `IEditController` へ cast して使う。
        //
        // 🔴 cast の実体は COM の QueryInterface（`com-scrape-types` の `ComPtr::cast`）で、
        // 「このオブジェクトが IEditController を実装するか」を問う正規の手段。実装しない
        // plugin では `None` に落ちて従来どおり controller なしになる（退行なし）。
        // **VST3 SDK 本体のテキストはこのリポジトリに無いため、SDK 条文は引用しない。**
        // 根拠は上記の COM 意味論と、Kontakt 8 での実測（fallback 無しでは UI が開かない）。
        //
        // ここで `initialize` を呼ばないのは、**同一オブジェクトの component 側で既に
        // 済んでいる**ため。connection point の接続と state の同期も、送り先と受け手が
        // 同一オブジェクトなので不要になる。
        //
        // 実測（2026-08-01・Kontakt 8）: この fallback が無いと UI open が
        // `edit controller is unavailable` で失敗する。fallback ありで
        // Soundcinema 提出作品の音色選定（6 パッチ連続の open → 選択 → close → 自動保存）を
        // 完走した。
        if let Some(controller) = component.as_com_ref().cast::<IEditController>() {
            let component_handler = ComWrapper::new(HostComponentHandler);
            let handler_ptr = component_handler
                .as_com_ref::<IComponentHandler>()
                .expect("HostComponentHandler exposes IComponentHandler")
                .as_ptr();
            unsafe {
                let _ = controller.setComponentHandler(handler_ptr);
            }
            return Ok(ControllerHandshake {
                controller: Some(controller),
                component_connection: None,
                controller_connection: None,
                component_handler: Some(component_handler),
                shared_with_component: true,
            });
        }
        // 🔴 controller の取得が**両方**失敗した（#619 レビュー）。plugin のロード自体は
        // 続行できる（音は出る）が、UI は開けない。ここで黙ると、後で `seq.ui()` を呼んだ
        // 時に出る `edit controller is unavailable` と**ロード時の根本原因が結びつかない**。
        eprintln!(
            "[vst3-host] no edit controller: getControllerClassId failed ({cid_result}) and the \
             component does not expose IEditController; the plugin will load but its UI cannot open"
        );
        return Ok(ControllerHandshake {
            controller: None,
            component_connection: None,
            controller_connection: None,
            component_handler: None,
            shared_with_component: false,
        });
    }

    let mut controller_raw = ptr::null_mut();
    let create_result = unsafe {
        factory.createInstance(
            controller_cid.as_ptr() as FIDString,
            IEditController_iid.as_ptr() as FIDString,
            &mut controller_raw,
        )
    };
    if !is_ok(create_result) {
        return Err(Vst3HostError::Controller(create_result));
    }
    let controller = unsafe { ComPtr::from_raw(controller_raw as *mut IEditController) }
        .ok_or(Vst3HostError::Controller(create_result))?;

    let init_result = unsafe { controller.initialize(host_context_ptr) };
    if !is_ok(init_result) {
        return Err(Vst3HostError::Controller(init_result));
    }

    let component_handler = ComWrapper::new(HostComponentHandler);
    let handler_ptr = component_handler
        .as_com_ref::<IComponentHandler>()
        .expect("HostComponentHandler exposes IComponentHandler")
        .as_ptr();
    let handler_result = unsafe { controller.setComponentHandler(handler_ptr) };
    if !is_ok(handler_result) {
        return Err(Vst3HostError::Controller(handler_result));
    }

    let component_connection = component.as_com_ref().cast::<IConnectionPoint>();
    let controller_connection = controller.as_com_ref().cast::<IConnectionPoint>();
    if let (Some(component_connection), Some(controller_connection)) =
        (&component_connection, &controller_connection)
    {
        unsafe {
            let _ = component_connection.connect(controller_connection.as_ptr());
            let _ = controller_connection.connect(component_connection.as_ptr());
        }
    }

    sync_component_state(component, &controller);

    Ok(ControllerHandshake {
        controller: Some(controller),
        component_connection,
        controller_connection,
        component_handler: Some(component_handler),
        shared_with_component: false,
    })
}

/// #540 P2: `.vstpreset` container の chunk 参照（`parse_vstpreset` の結果）。
pub(crate) struct VstPresetChunks<'a> {
    pub(crate) component: &'a [u8],
    pub(crate) controller: Option<&'a [u8]>,
}

/// `.vstpreset` container を解析する（Steinberg "VST 3 Preset File Format"）。
///
/// レイアウト: header 48 bytes = magic `VST3`(4) + version i32 LE(4) + class ID ASCII(32) +
/// chunk-list offset i64 LE(8)。chunk list = magic `List`(4) + count i32 LE(4) +
/// count × { chunk ID(4) + offset i64 LE(8) + size i64 LE(8) }。`Comp` = component state・
/// `Cont` = controller state・`Info` はメタデータ（無視）。
///
/// 先頭 magic が `VST3` でなければ `Ok(None)`（呼び出し側は raw component state chunk として
/// 扱う）。magic が合うのに構造が壊れている場合はエラー（silent に raw 扱いすると
/// container ヘッダごと setState に流れて plugin 側で不可解に失敗する）。
///
/// header の class ID は照合しない: TUID ↔ ASCII 表現はプラットフォームで byte order が
/// 異なり（COM 互換 swap）、誤検知で正当な preset を弾くリスクが照合の利得を上回る。
/// 不一致の preset は plugin 自身の setState が拒否する。
pub(crate) fn parse_vstpreset(bytes: &[u8]) -> Result<Option<VstPresetChunks<'_>>, Vst3HostError> {
    if bytes.len() < 4 || &bytes[0..4] != b"VST3" {
        return Ok(None);
    }
    let malformed = |reason: &str| Vst3HostError::State(format!("malformed .vstpreset: {reason}"));
    if bytes.len() < 48 {
        return Err(malformed("header shorter than 48 bytes"));
    }
    let read_i64 = |offset: usize| -> Result<i64, Vst3HostError> {
        let end = offset
            .checked_add(8)
            .filter(|&end| end <= bytes.len())
            .ok_or_else(|| malformed("integer field out of bounds"))?;
        Ok(i64::from_le_bytes(bytes[offset..end].try_into().unwrap()))
    };
    let list_offset =
        usize::try_from(read_i64(40)?).map_err(|_| malformed("negative chunk-list offset"))?;
    let list_end = list_offset
        .checked_add(8)
        .filter(|&end| end <= bytes.len())
        .ok_or_else(|| malformed("chunk-list offset out of bounds"))?;
    if &bytes[list_offset..list_offset + 4] != b"List" {
        return Err(malformed("chunk list magic is not 'List'"));
    }
    let count = i32::from_le_bytes(bytes[list_offset + 4..list_end].try_into().unwrap());
    let count = usize::try_from(count).map_err(|_| malformed("negative chunk count"))?;
    let mut component: Option<&[u8]> = None;
    let mut controller: Option<&[u8]> = None;
    for index in 0..count {
        let entry = list_end + index * 20;
        let entry_end = entry
            .checked_add(20)
            .filter(|&end| end <= bytes.len())
            .ok_or_else(|| malformed("chunk entry out of bounds"))?;
        let id = &bytes[entry..entry + 4];
        let offset = usize::try_from(read_i64(entry + 4)?)
            .map_err(|_| malformed("negative chunk offset"))?;
        let size =
            usize::try_from(read_i64(entry + 12)?).map_err(|_| malformed("negative chunk size"))?;
        let end = offset
            .checked_add(size)
            .filter(|&end| end <= bytes.len())
            .ok_or_else(|| malformed("chunk data out of bounds"))?;
        let _ = entry_end;
        match id {
            b"Comp" => component = Some(&bytes[offset..end]),
            b"Cont" => controller = Some(&bytes[offset..end]),
            _ => {}
        }
    }
    let component = component.ok_or_else(|| malformed("no 'Comp' (component state) chunk"))?;
    Ok(Some(VstPresetChunks {
        component,
        controller,
    }))
}

/// #540 P2: state chunk を component / controller に適用する。復元順序は VST3 公式 FAQ
/// (Persistence): ① `IComponent::setState` ② `IEditController::setComponentState`
/// ③ `IEditController::setState`（controller chunk がある場合のみ）。
///
/// ① の失敗は音色が復元されていないことを意味するのでハードエラー。②③ は GUI/表示側の
/// 同期でありベストエフォート（未実装の plugin も多い）— 失敗は stderr に出すのみ。
/// state 復元の **成功経路**で出す best-effort 通知の文言。
///
/// 呼び出し元はどちらも `Ok(())` を返す経路にあり、**復元そのものは成功している**
/// （controller への同期だけが best-effort で失敗した）。本物の失敗
/// （`IComponent::setState` の拒否）は `Err` を返しており、そちらは ERROR に倒れるのが正しい。
///
/// level トークン規約の理由と TS 側の受理条件は `orbit_child_runtime::notice` に集約してある。
/// この crate は **child プロセスの中にリンクされて動く**ため、タグは `-child` で終わらない。
pub(crate) fn best_effort_state_notice(what: &str, result: i32) -> String {
    orbit_child_runtime::notice::child_info(
        "orbit-vst3-host",
        format_args!("{what} returned {result:#x} (best-effort; audio state is already applied)"),
    )
}

pub(crate) fn apply_state_chunks(
    component: &ComPtr<IComponent>,
    controller: Option<&ComPtr<IEditController>>,
    chunks: &VstPresetChunks<'_>,
) -> Result<(), Vst3HostError> {
    let stream_wrapper = ComWrapper::new(MemoryStream::with_data(chunks.component.to_vec()));
    let stream = stream_wrapper
        .to_com_ptr::<IBStream>()
        .expect("MemoryStream exposes IBStream");
    let set_result = unsafe { component.setState(stream.as_ptr()) };
    if !is_ok(set_result) {
        return Err(Vst3HostError::State(format!(
            "IComponent::setState rejected the saved state (tresult {set_result:#x}; \
             wrong plugin for this preset, or a truncated state file)"
        )));
    }
    if let Some(controller) = controller {
        unsafe {
            let mut pos = 0;
            let _ = stream.seek(0, IBStream_::IStreamSeekMode_::kIBSeekSet as i32, &mut pos);
            let sync_result = controller.setComponentState(stream.as_ptr());
            if !is_ok(sync_result) {
                eprintln!(
                    "{}",
                    best_effort_state_notice("setComponentState after state restore", sync_result)
                );
            }
        }
        if let Some(controller_chunk) = chunks.controller {
            let controller_stream_wrapper =
                ComWrapper::new(MemoryStream::with_data(controller_chunk.to_vec()));
            let controller_stream = controller_stream_wrapper
                .to_com_ptr::<IBStream>()
                .expect("MemoryStream exposes IBStream");
            let controller_result = unsafe { controller.setState(controller_stream.as_ptr()) };
            if !is_ok(controller_result) {
                eprintln!(
                    "{}",
                    best_effort_state_notice("IEditController::setState", controller_result)
                );
            }
        }
    }
    Ok(())
}

pub(crate) fn sync_component_state(
    component: &ComPtr<IComponent>,
    controller: &ComPtr<IEditController>,
) {
    let stream_wrapper = ComWrapper::new(MemoryStream::new());
    let stream = stream_wrapper
        .to_com_ptr::<IBStream>()
        .expect("MemoryStream exposes IBStream");
    let get_result = unsafe { component.getState(stream.as_ptr()) };
    if is_ok(get_result) {
        unsafe {
            let mut pos = 0;
            let _ = stream.seek(0, IBStream_::IStreamSeekMode_::kIBSeekSet as i32, &mut pos);
            let _ = controller.setComponentState(stream.as_ptr());
        }
    }
}

pub(crate) fn configure_audio_buses(
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

    let mut result =
        set_bus_arrangements(processor, &mut input_arrangements, &mut output_arrangements);
    if !is_ok(result) {
        input_arrangements = plugin_reported_arrangements(
            processor,
            BusDirections_::kInput as i32,
            input_buses,
            &input_arrangements,
        );
        output_arrangements = plugin_reported_arrangements(
            processor,
            BusDirections_::kOutput as i32,
            output_buses,
            &output_arrangements,
        );
        result = set_bus_arrangements(processor, &mut input_arrangements, &mut output_arrangements);
    }
    // setBusArrangements は advisory（any non-OK, not just kResultFalse）。この tresult を返す
    // プラグイン（ARIA Player 等・特に instrument）はプラグイン既定の arrangement で動作する。
    // JUCE も致命扱いしない。ここで hard-fail すると「host 提案 arrangement を拒否するだけ」の
    // プラグインが全滅するので続行する。（厳密な buffer 整合は Phase 1 で getBusArrangement の
    // 実値に合わせる。）
    let _ = result;

    // `run_process`（lib.rs 内 `Vst3EffectProcessor::run_process`）は index 0 の 1 bus しか
    // process() に渡さない（`numInputs`/`numOutputs` は常に 0-or-1）。activate は process() が
    // 実際に触るバスだけに絞り、plugin 側の active-bus bookkeeping を host の実際の呼び出しと
    // 一致させる（多バス plugin で使わない bus を active のまま残す OOB リスクを避ける）。
    activate_primary_bus_only(component, BusDirections_::kInput as i32, input_buses);
    activate_primary_bus_only(component, BusDirections_::kOutput as i32, output_buses);

    // `run_process` は index 0 の primary バスの channel buffer を常に `DEFAULT_CHANNELS`(2) 幅の
    // `[*mut f32; 2]` として組み立てる。getBusInfo と、process() 時に plugin が実際に使う
    // negotiated arrangement の両方で primary bus が stereo であることを確認できない場合は、
    // silent corruption ではなく load 失敗として reject する。
    verify_primary_bus_is_stereo(component, processor, input_buses, output_buses)?;

    Ok(())
}

pub(crate) fn set_bus_arrangements(
    processor: &ComPtr<IAudioProcessor>,
    input_arrangements: &mut [SpeakerArrangement],
    output_arrangements: &mut [SpeakerArrangement],
) -> tresult {
    unsafe {
        processor.setBusArrangements(
            ptr_or_null_mut(input_arrangements),
            input_arrangements.len() as i32,
            ptr_or_null_mut(output_arrangements),
            output_arrangements.len() as i32,
        )
    }
}

pub(crate) fn plugin_reported_arrangements(
    processor: &ComPtr<IAudioProcessor>,
    direction: BusDirection,
    bus_count: i32,
    fallback: &[SpeakerArrangement],
) -> Vec<SpeakerArrangement> {
    (0..bus_count)
        .map(|index| {
            let mut arrangement = 0;
            let result = unsafe { processor.getBusArrangement(direction, index, &mut arrangement) };
            if is_ok(result) && arrangement != 0 {
                arrangement
            } else {
                fallback
                    .get(index as usize)
                    .copied()
                    .unwrap_or(SpeakerArr::kStereo)
            }
        })
        .collect()
}

pub(crate) fn arrangements_for_direction(
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

pub(crate) fn audio_bus_channel_count(
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

pub(crate) fn arrangement_for_channels(channel_count: i32) -> SpeakerArrangement {
    match channel_count {
        1 => SpeakerArr::kMono,
        2 => SpeakerArr::kStereo,
        _ => SpeakerArr::kStereo,
    }
}

/// Activates only bus index 0 for `direction` (if `bus_count > 0`). `run_process` describes a
/// single bus per direction to `process()`, so only that bus needs to be active; extra buses on
/// a multi-bus plugin are intentionally left inactive.
pub(crate) fn activate_primary_bus_only(
    component: &ComPtr<IComponent>,
    direction: BusDirection,
    bus_count: i32,
) {
    if bus_count <= 0 {
        return;
    }
    // activateBus は advisory: 一部プラグインは常に非 OK を返すが、bus 未 activate でも process()
    // が動くケースが多く（JUCE ホストも致命扱いしない）、失敗を診断 log に残すだけで続行する。
    let result = unsafe { component.activateBus(MediaTypes_::kAudio as i32, direction, 0, 1) };
    if !is_ok(result) {
        eprintln!(
            "[orbit-vst3-host] activateBus(direction={direction}, index=0) advisory failure: {result}"
        );
    }
}

/// `run_process` always wires the primary (index 0) bus as a `DEFAULT_CHANNELS`-wide (stereo)
/// buffer. Reject load if either primary bus that will actually be processed reports a different
/// channel count, instead of letting `run_process` read/write out of bounds.
pub(crate) fn verify_primary_bus_is_stereo(
    component: &ComPtr<IComponent>,
    processor: &ComPtr<IAudioProcessor>,
    input_buses: i32,
    output_buses: i32,
) -> Result<(), Vst3HostError> {
    if input_buses > 0 {
        let channels = audio_bus_channel_count(component, BusDirections_::kInput as i32, 0);
        if channels != DEFAULT_CHANNELS as i32 {
            return Err(Vst3HostError::UnsupportedPrimaryBusLayout {
                direction: "input",
                channels,
            });
        }
        if let Some(channels) =
            primary_bus_arrangement_channel_count(processor, BusDirections_::kInput as i32)
        {
            if channels != DEFAULT_CHANNELS as i32 {
                return Err(Vst3HostError::UnsupportedPrimaryBusLayout {
                    direction: "input",
                    channels,
                });
            }
        }
    }
    if output_buses > 0 {
        let channels = audio_bus_channel_count(component, BusDirections_::kOutput as i32, 0);
        if channels != DEFAULT_CHANNELS as i32 {
            return Err(Vst3HostError::UnsupportedPrimaryBusLayout {
                direction: "output",
                channels,
            });
        }
        if let Some(channels) =
            primary_bus_arrangement_channel_count(processor, BusDirections_::kOutput as i32)
        {
            if channels != DEFAULT_CHANNELS as i32 {
                return Err(Vst3HostError::UnsupportedPrimaryBusLayout {
                    direction: "output",
                    channels,
                });
            }
        }
    }
    Ok(())
}

pub(crate) fn primary_bus_arrangement_channel_count(
    processor: &ComPtr<IAudioProcessor>,
    direction: BusDirection,
) -> Option<i32> {
    let mut arrangement = 0;
    let result = unsafe { processor.getBusArrangement(direction, 0, &mut arrangement) };
    if is_ok(result) {
        Some(arrangement.count_ones() as i32)
    } else {
        None
    }
}

pub(crate) fn ptr_or_null_mut<T>(values: &mut [T]) -> *mut T {
    if values.is_empty() {
        ptr::null_mut()
    } else {
        values.as_mut_ptr()
    }
}

pub(crate) fn find_audio_module_class(
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

pub(crate) fn char8_array_to_string(data: &[i8]) -> String {
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

pub(crate) fn is_ok(result: tresult) -> bool {
    result == kResultOk || result == kResultTrue
}

pub(crate) trait TuidPtr {
    fn as_ptr(&self) -> *const i8;
}

impl TuidPtr for TUID {
    fn as_ptr(&self) -> *const i8 {
        self.as_slice().as_ptr()
    }
}

pub(crate) struct HostApplication;

impl Class for HostApplication {
    type Interfaces = (IHostApplication,);
}
