//! VST3 インストゥルメントのプロセッサとオーディオ経路（#888 子 3・orbit-vst3-host）。
//!
//! 🔴 **これは純粋な移動である。** `lib.rs` からそのまま移した。本文は 1 行も書き換えていない。

#[allow(unused_imports)]
use crate::*;

pub(crate) fn capture_component_state(
    component: &ComPtr<IComponent>,
) -> Result<Vec<u8>, Vst3HostError> {
    let stream_wrapper = ComWrapper::new(MemoryStream::new());
    let stream = stream_wrapper
        .to_com_ptr::<IBStream>()
        .ok_or_else(|| Vst3HostError::State("MemoryStream exposes no IBStream".into()))?;

    let result = unsafe { component.getState(stream.as_ptr()) };
    if !is_ok(result) {
        return Err(Vst3HostError::State(format!(
            "IComponent::getState failed (tresult {result:#x})"
        )));
    }
    let bytes = stream_wrapper.data.borrow().clone();
    if bytes.is_empty() {
        return Err(Vst3HostError::State(
            "IComponent::getState produced an empty chunk — refusing to record it as state".into(),
        ));
    }
    Ok(bytes)
}

impl Vst3InstrumentProcessor {
    /// #555: 現在の plugin state を **バイト列として取り出す**（DAW ループの保存側）。
    ///
    /// VST3 正準の永続化は `IComponent::getState`。ここでは controller chunk を含めず
    /// component chunk のみを返す — 復元側（`apply_state_chunks`）が magic 無しの
    /// raw component state を受理する契約なので対称になる。
    ///
    /// **スレッド**: UI/メインスレッドから呼ぶこと（CAP.5・VST3 の規約）。
    /// child のメインループ（現状は audio spin loop・Phase 2 で runloop 化）が呼び出す。
    ///
    /// `getState` が失敗した、または空を返した場合は `Err` を返す — **空 state を
    /// 「成功」として上位へ渡さない**（サイズ 0 を登記すると音色を失う）。
    pub fn capture_state(&self) -> Result<Vec<u8>, Vst3HostError> {
        self.main
            .as_ref()
            .expect("VST3 instrument main is present")
            .capture_state()
    }

    /// realtime（既定）で読み込む（[`Vst3EffectProcessor::load`] と同じ契約）。
    pub fn load(
        bundle_path: &Path,
        sample_rate: f64,
        max_samples_per_block: i32,
        state: Option<&[u8]>,
    ) -> Result<(Self, LoadedVst3Info), Vst3HostError> {
        Self::load_with_process_mode(
            bundle_path,
            sample_rate,
            max_samples_per_block,
            state,
            Vst3ProcessMode::Realtime,
        )
    }

    /// 処理圧を明示して読み込む（#598・[`Vst3EffectProcessor::load_with_process_mode`] と同じ契約）。
    pub fn load_with_process_mode(
        bundle_path: &Path,
        sample_rate: f64,
        max_samples_per_block: i32,
        state: Option<&[u8]>,
        process_mode: Vst3ProcessMode,
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
        let sample_size_result =
            unsafe { processor.canProcessSampleSize(SymbolicSampleSizes_::kSample32 as i32) };
        if !is_ok(sample_size_result) {
            return Err(Vst3HostError::SampleSize(sample_size_result));
        }

        // Controller creation/connection precedes bus activation, matching the effect host.
        let controller_handshake =
            connect_controller(&factory, &component, &host_context, host_context_ptr)?;
        let input_buses = unsafe {
            component.getBusCount(MediaTypes_::kAudio as i32, BusDirections_::kInput as i32)
        };
        let output_buses = unsafe {
            component.getBusCount(MediaTypes_::kAudio as i32, BusDirections_::kOutput as i32)
        };
        if input_buses != 0 || output_buses <= 0 {
            return Err(Vst3HostError::NotInstrument {
                input_buses,
                output_buses,
            });
        }
        let event_input_buses = unsafe {
            component.getBusCount(MediaTypes_::kEvent as i32, BusDirections_::kInput as i32)
        };
        if event_input_buses <= 0 {
            return Err(Vst3HostError::MissingEventInputBus);
        }

        configure_audio_buses(&component, &processor, input_buses, output_buses)?;
        // The event input bus is required for note delivery; unlike audio activation it must not
        // be left to a plugin default.
        let event_result = unsafe {
            component.activateBus(
                MediaTypes_::kEvent as i32,
                BusDirections_::kInput as i32,
                0,
                1,
            )
        };
        if !is_ok(event_result) {
            return Err(Vst3HostError::SetActive(event_result));
        }

        let mut setup = ProcessSetup {
            processMode: process_mode.as_vst3(),
            symbolicSampleSize: SymbolicSampleSizes_::kSample32 as i32,
            maxSamplesPerBlock: max_samples_per_block,
            sampleRate: sample_rate,
        };
        let setup_result = unsafe { processor.setupProcessing(&mut setup) };
        if !is_ok(setup_result) {
            return Err(Vst3HostError::SetupProcessing(setup_result));
        }
        // #540 P2: 保存済み state の復元は **setActive(1) より前**に行う。VST3 の正準復元
        // フローは「setup 済み・inactive の component へ setState」で、activate 後の適用は
        // 「実行中の preset 差し替え」意味論になり、サンプルマップ等の構造的 state を持つ
        // 音源（Kontakt 等）で挙動差が出得る（#542 レビュー F7）。
        if let Some(bytes) = state {
            apply_state_bytes(&component, controller_handshake.controller.as_ref(), bytes)?;
        }
        let active_result = unsafe { component.setActive(1) };
        if !is_ok(active_result) {
            return Err(Vst3HostError::SetActive(active_result));
        }
        let processing_result = unsafe { processor.setProcessing(1) };
        if !is_ok(processing_result) && processing_result != kNotImplemented {
            return Err(Vst3HostError::SetProcessing(processing_result));
        }

        let info = LoadedVst3Info {
            name: class.name,
            audio_inputs: input_buses,
            audio_outputs: output_buses,
            is_effect: false,
        };
        let scratch_len = max_samples_per_block.max(0) as usize;
        let ui_endpoint = Vst3UiEndpoint::new(controller_handshake.controller.as_ref().cloned());
        Ok((
            Self {
                audio: Some(Vst3InstrumentAudio {
                    processor,
                    process_mode,
                    input_events: InputEventList::new(),
                    output_parameter_changes: ParameterChanges::empty(),
                    output_events: EventList::empty(),
                    process_output_l: vec![0.0; scratch_len],
                    process_output_r: vec![0.0; scratch_len],
                    last_process_error: std::cell::Cell::new(0),
                }),
                main: Some(Vst3PluginMain {
                    ui_endpoint,
                    controller: controller_handshake.controller,
                    controller_shared_with_component: controller_handshake.shared_with_component,
                    component_connection: controller_handshake.component_connection,
                    controller_connection: controller_handshake.controller_connection,
                    component: Some(component),
                    _component_handler: controller_handshake.component_handler,
                    _host_context: host_context,
                    factory: Some(factory),
                    _home_thread: PhantomData,
                    _library: library,
                    info: info.clone(),
                }),
            },
            info,
        ))
    }

    pub fn info(&self) -> &LoadedVst3Info {
        self.main
            .as_ref()
            .expect("VST3 instrument main is present")
            .info()
    }

    /// main / audio の 2 スレッド運用（UIH.1）へ分割する（#474 P1）。
    /// 順序契約は [`Vst3EffectProcessor::split`] と同一。
    pub fn split(mut self) -> (Vst3InstrumentAudio, Vst3PluginMain) {
        (
            self.audio.take().expect("VST3 instrument audio is present"),
            self.main.take().expect("VST3 instrument main is present"),
        )
    }

    /// Raw tresult of the most recent failing `process()` call (0 / `kResultOk` if none since
    /// construction). Intended for out-of-band error reporting (e.g. child process exit summary),
    /// not for the audio-thread hot path.
    pub fn last_process_error(&self) -> i32 {
        self.audio
            .as_ref()
            .expect("VST3 instrument audio is present")
            .last_process_error()
    }

    pub fn push_note_on(&self, channel: i16, pitch: i16, velocity: f32, sample_offset: i32) {
        self.audio
            .as_ref()
            .expect("VST3 instrument audio is present")
            .push_note_on(channel, pitch, velocity, sample_offset);
    }

    pub fn push_note_off(&self, channel: i16, pitch: i16, velocity: f32, sample_offset: i32) {
        self.audio
            .as_ref()
            .expect("VST3 instrument audio is present")
            .push_note_off(channel, pitch, velocity, sample_offset);
    }

    /// Queued note events are delivered at their supplied sample offsets; successful plugin
    /// output is add-mixed into interleaved stereo `data`
    /// （[`Vst3InstrumentAudio::process_block`] へ委譲）。
    #[must_use]
    pub fn process_block(&mut self, data: &mut [f32]) -> bool {
        self.audio
            .as_mut()
            .expect("VST3 instrument audio is present")
            .process_block(data)
    }
}

impl Drop for Vst3InstrumentProcessor {
    fn drop(&mut self) {
        // Shutdown order is explicit and independent of field declaration order.
        let _ = self.audio.take();
        let _ = self.main.take();
    }
}

impl Vst3InstrumentAudio {
    /// Raw tresult of the most recent failing `process()` call（audio スレッド側）。
    pub fn last_process_error(&self) -> i32 {
        self.last_process_error.get()
    }

    pub fn push_note_on(&self, channel: i16, pitch: i16, velocity: f32, sample_offset: i32) {
        self.input_events
            .push_note_on(channel, pitch, velocity, sample_offset);
    }

    pub fn push_note_off(&self, channel: i16, pitch: i16, velocity: f32, sample_offset: i32) {
        self.input_events
            .push_note_off(channel, pitch, velocity, sample_offset);
    }

    /// Queued note events are delivered at their supplied sample offsets; successful plugin
    /// output is add-mixed into interleaved stereo `data`.
    #[must_use]
    pub fn process_block(&mut self, data: &mut [f32]) -> bool {
        if !data.len().is_multiple_of(DEFAULT_CHANNELS) {
            // Clear queued input events so a rejected block doesn't leak stale note
            // events (with now-invalid sample offsets) into the next successful block.
            self.input_events.clear();
            return false;
        }
        let frames = data.len() / DEFAULT_CHANNELS;
        if frames > self.process_output_l.len() {
            // Same rationale as above: drop stale queued events on early return.
            self.input_events.clear();
            return false;
        }
        self.process_output_l[..frames].fill(0.0);
        self.process_output_r[..frames].fill(0.0);
        let mut output_ptrs = [
            self.process_output_l.as_mut_ptr(),
            self.process_output_r.as_mut_ptr(),
        ];
        let mut outputs = [AudioBusBuffers {
            numChannels: DEFAULT_CHANNELS as i32,
            silenceFlags: 0,
            __field0: AudioBusBuffers__type0 {
                channelBuffers32: output_ptrs.as_mut_ptr(),
            },
        }];
        let Ok(num_samples) = i32::try_from(frames) else {
            // Same rationale as the guards above: drop stale queued events on early return.
            self.input_events.clear();
            return false;
        };
        let mut process_data = ProcessData {
            processMode: self.process_mode.as_vst3(),
            symbolicSampleSize: SymbolicSampleSizes_::kSample32 as i32,
            numSamples: num_samples,
            numInputs: 0,
            numOutputs: 1,
            inputs: ptr::null_mut(),
            outputs: outputs.as_mut_ptr(),
            inputParameterChanges: ptr::null_mut(),
            outputParameterChanges: self.output_parameter_changes.as_ptr(),
            inputEvents: self.input_events.as_ptr(),
            outputEvents: self.output_events.as_ptr(),
            processContext: ptr::null_mut(),
        };
        let result = unsafe { self.processor.process(&mut process_data) };
        self.input_events.clear();
        if !is_ok(result) {
            self.last_process_error.set(result);
            return false;
        }
        for frame in 0..frames {
            let base = frame * DEFAULT_CHANNELS;
            data[base] += self.process_output_l[frame];
            data[base + 1] += self.process_output_r[frame];
        }
        true
    }
}

pub(crate) struct AudioModuleClass {
    pub(crate) cid: TUID,
    pub(crate) name: String,
}

/// controller を独立して `terminate()` すべきか（#603）。
///
/// 🔴 **この判断の理由はここに集約する**（`shared_with_component` 各フィールドの doc は
/// ここを指すだけにしてある）。
///
/// VST3 には controller を別クラスとして持つ plugin と、component 自身が
/// `IEditController` を実装する**単一コンポーネント plugin**（Kontakt 等）の 2 形態がある。
/// 後者では `getControllerClassId` が失敗するので component を `IEditController` へ cast して
/// 使う（[`connect_controller`] の fallback）。
///
/// その結果 controller と component が**同一の COM オブジェクト**になるため、両方から
/// `terminate()` を呼ぶと同じオブジェクトを二度終了させることになる。共有時は component 側の
/// terminate に一本化する。
///
/// 🔴 **これは COM の一般則（同一オブジェクトへの二重 terminate は未定義）に基づく予防措置で、
/// 破損を再現観測したものではない。** 実測したのは「fallback 無しでは Kontakt 8 の UI が
/// `edit controller is unavailable` で開かない」ことと「fallback ありで開閉・再開・2声同時が
/// 通る」ことまでである。
///
/// `Drop` から切り出してあるのは、実 COM オブジェクトなしでこの判定を検証するため。
pub(crate) fn should_terminate_controller(shared_with_component: bool) -> bool {
    !shared_with_component
}

pub(crate) struct ControllerHandshake {
    pub(crate) controller: Option<ComPtr<IEditController>>,
    pub(crate) component_connection: Option<ComPtr<IConnectionPoint>>,
    pub(crate) controller_connection: Option<ComPtr<IConnectionPoint>>,
    pub(crate) component_handler: Option<ComWrapper<HostComponentHandler>>,
    /// controller が component と**同一の COM オブジェクト**のとき true（#603）。
    /// 理由は [`should_terminate_controller`] を参照。
    pub(crate) shared_with_component: bool,
}
