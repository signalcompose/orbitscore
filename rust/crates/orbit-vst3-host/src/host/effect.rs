//! VST3 エフェクトのプロセッサとオーディオ経路（#888 子 3・orbit-vst3-host）。
//!
//! 🔴 **これは純粋な移動である。** `lib.rs` からそのまま移した。本文は 1 行も書き換えていない。

#[allow(unused_imports)]
use crate::*;

/// Single-threaded-by-default VST3 effect processor: [`Vst3EffectAudio`] + [`Vst3PluginMain`]
/// の composite。`load` したスレッド上でそのまま使う（従来 API 互換）か、`split()` で
/// main / audio の 2 スレッド運用（UIH.1）へ分割する。
///
/// Shutdown call order is enforced by the hand-written [`Drop::drop`] body below via explicit
/// `.take()` calls, not by field declaration order.
pub struct Vst3EffectProcessor {
    pub(crate) audio: Option<Vst3EffectAudio>,
    pub(crate) main: Option<Vst3PluginMain>,
}

impl Vst3EffectProcessor {
    /// realtime（既定）で読み込む。`load_with_process_mode(.., Vst3ProcessMode::Realtime)` と同義で、
    /// #598 以前からの呼び出し側をそのまま通すための薄いラッパ。
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

    /// 処理圧を明示して読み込む（#598）。`process_mode` は `ProcessSetup` で宣言され、
    /// 以降の `ProcessData` にも同じ値が載る（両者の不一致は VST3 の契約違反）。
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
        let controller_handshake =
            connect_controller(&factory, &component, &host_context, host_context_ptr)?;

        let input_buses = unsafe {
            component.getBusCount(MediaTypes_::kAudio as i32, BusDirections_::kInput as i32)
        };
        let output_buses = unsafe {
            component.getBusCount(MediaTypes_::kAudio as i32, BusDirections_::kOutput as i32)
        };
        let is_effect = input_buses > 0;

        configure_audio_buses(&component, &processor, input_buses, output_buses)?;

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

        // instrument と同じ VST3 正準順序: setup 済み・inactive の component へ state を適用し、
        // 音色が確定してから READY に到達できるようにする。
        if let Some(bytes) = state {
            apply_state_bytes(&component, controller_handshake.controller.as_ref(), bytes)?;
        }
        // `is_effect` drives both `process_block`'s overwrite-vs-add-mix branch (used in
        // production by `orbit-vst3-effect-child`) and the probe / two-pass signal check below
        // (`probe_effect_signal`), which only verifies the effect overwrite path. This detection
        // is separate from CLAP's `has_audio_input`; treating an instrument as an effect would be
        // silent-but-wrong because the dry signal would be overwritten instead of add-mixed.
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

        // setProcessing は optional。kNotImplemented(=3) を返すプラグイン（例: iZotope
        // Ozone/RX/Neutron 系）は多く、VST3 的に合法。JUCE も kNotImplemented を非致命として
        // 続行する（warnOnFailureIfImplemented）。ここで hard error にすると iZotope 全滅する。
        let processing_result = unsafe { processor.setProcessing(1) };
        if !is_ok(processing_result) && processing_result != kNotImplemented {
            return Err(Vst3HostError::SetProcessing(processing_result));
        }

        // Queried once: the plugin's process-context requirements are fixed for its lifetime, so
        // `process_context()` reads this cache instead of re-querying `IProcessContextRequirements`
        // on every block.
        let process_context_requirements = unsafe {
            processor
                .as_com_ref()
                .cast::<IProcessContextRequirements>()
                .map(|requirements| requirements.getProcessContextRequirements())
                .unwrap_or(0)
        };

        let scratch_len = max_samples_per_block.max(0) as usize;
        let ui_endpoint = Vst3UiEndpoint::new(controller_handshake.controller.as_ref().cloned());
        let processor = Self {
            audio: Some(Vst3EffectAudio {
                processor,
                process_mode,
                is_effect: info.is_effect,
                sample_rate,
                process_context_requirements,
                output_parameter_changes: ParameterChanges::empty(),
                input_events: EventList::empty(),
                output_events: EventList::empty(),
                block_parameter_changes: ParameterChanges::empty(),
                process_input_l: vec![0.0; scratch_len],
                process_input_r: vec![0.0; scratch_len],
                process_output_l: vec![0.0; scratch_len],
                process_output_r: vec![0.0; scratch_len],
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
        };
        Ok((processor, info))
    }

    /// main / audio の 2 スレッド運用（UIH.1）へ分割する（#474 P1）。
    ///
    /// teardown の順序契約（audio 側 drop = `setProcessing(0)` → join →
    /// [`Vst3PluginMain`] drop = terminate 列）は [`Vst3PluginMain`] の doc を参照。
    pub fn split(mut self) -> (Vst3EffectAudio, Vst3PluginMain) {
        (
            self.audio.take().expect("VST3 effect audio is present"),
            self.main.take().expect("VST3 effect main is present"),
        )
    }

    /// 現在の effect component state を取得する。instrument と同じ空-state拒否規律を使う。
    pub fn capture_state(&self) -> Result<Vec<u8>, Vst3HostError> {
        self.main
            .as_ref()
            .expect("VST3 effect main is present")
            .capture_state()
    }

    pub fn info(&self) -> &LoadedVst3Info {
        self.main
            .as_ref()
            .expect("VST3 effect main is present")
            .info()
    }

    pub fn process_stereo(
        &mut self,
        input_l: &[f32],
        input_r: &[f32],
        output_l: &mut [f32],
        output_r: &mut [f32],
        gain: Option<f64>,
    ) -> Result<ProcessReport, Vst3HostError> {
        self.audio
            .as_mut()
            .expect("VST3 effect audio is present")
            .process_stereo(input_l, input_r, output_l, output_r, gain)
    }

    /// Interleaved stereo f32 blockを in-place で処理する child / offline parity 用 API
    /// （[`Vst3EffectAudio::process_block`] へ委譲）。
    #[must_use]
    pub fn process_block(&mut self, data: &mut [f32]) -> bool {
        self.audio
            .as_mut()
            .expect("VST3 effect audio is present")
            .process_block(data)
    }
}

impl Drop for Vst3EffectProcessor {
    fn drop(&mut self) {
        // Shutdown order is explicit and independent of field declaration order.
        let _ = self.audio.take();
        let _ = self.main.take();
    }
}

impl Vst3EffectAudio {
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
        if frames > self.process_input_l.len() {
            return Err(Vst3HostError::ProcessBlockTooLarge {
                requested: frames,
                max: self.process_input_l.len(),
            });
        }

        self.process_input_l[..frames].copy_from_slice(input_l);
        self.process_input_r[..frames].copy_from_slice(input_r);

        let input_ptrs = [
            self.process_input_l.as_mut_ptr(),
            self.process_input_r.as_mut_ptr(),
        ];
        let output_ptrs = [output_l.as_mut_ptr(), output_r.as_mut_ptr()];

        // process_stereo is the non-RT probe/offline-parity path; gain varies per call, so unlike
        // process_block's `block_parameter_changes` this cannot be cached on `self`.
        let parameter_changes = gain
            .map(ParameterChanges::single_gain)
            .unwrap_or_else(ParameterChanges::empty);

        let result = self.run_process(input_ptrs, output_ptrs, frames, &parameter_changes);
        if !is_ok(result) {
            return Err(Vst3HostError::Process(result));
        }
        Ok(ProcessReport {
            processed: true,
            is_effect: self.is_effect,
        })
    }

    /// Interleaved stereo f32 blockを in-place で処理する child / offline parity 用 API。
    ///
    /// effect（audio input busあり）は overwrite、instrument（audio input busなし）は add-mix。
    /// 失敗時は `data` を dry のまま残して `false` を返す。
    #[must_use]
    pub fn process_block(&mut self, data: &mut [f32]) -> bool {
        if !data.len().is_multiple_of(DEFAULT_CHANNELS) {
            return false;
        }
        let frames = data.len() / DEFAULT_CHANNELS;
        if frames > self.process_input_l.len() {
            return false;
        }

        for frame in 0..frames {
            let base = frame * DEFAULT_CHANNELS;
            self.process_input_l[frame] = data[base];
            self.process_input_r[frame] = data[base + 1];
            self.process_output_l[frame] = 0.0;
            self.process_output_r[frame] = 0.0;
        }

        let input_ptrs = [
            self.process_input_l.as_mut_ptr(),
            self.process_input_r.as_mut_ptr(),
        ];
        let output_ptrs = [
            self.process_output_l.as_mut_ptr(),
            self.process_output_r.as_mut_ptr(),
        ];

        let result = self.run_process(
            input_ptrs,
            output_ptrs,
            frames,
            &self.block_parameter_changes,
        );
        if !is_ok(result) {
            return false;
        }

        for frame in 0..frames {
            let base = frame * DEFAULT_CHANNELS;
            if self.is_effect {
                data[base] = self.process_output_l[frame];
                data[base + 1] = self.process_output_r[frame];
            } else {
                data[base] += self.process_output_l[frame];
                data[base + 1] += self.process_output_r[frame];
            }
        }
        true
    }

    /// Shared `AudioBusBuffers`/`ProcessData` assembly + `IAudioProcessor::process` call for
    /// `process_stereo` and `process_block`. `input_ptrs`/`output_ptrs` must each point at
    /// `frames` valid, writable (for output) `f32` samples for the lifetime of this call; both
    /// callers guarantee this via their scratch buffers / caller-provided slices.
    ///
    /// `is_effect` bus wiring (numInputs/inputs null-vs-populated) lives here so both callers stay
    /// in sync with the same effect/instrument branch.
    ///
    /// OOB note: only the primary (index 0) bus per direction is ever described here
    /// (`numInputs`/`numOutputs` are always 0-or-1), always as a fixed `DEFAULT_CHANNELS`-wide
    /// buffer. `verify_primary_bus_is_stereo` (called from `configure_audio_buses` at load time)
    /// rejects plugins whose primary bus isn't stereo, so this fixed-width assembly cannot read
    /// or write out of bounds for a plugin that passed load. Extra buses beyond index 0 on a
    /// multi-bus plugin are simply never wired (known limitation, not a crash risk — see
    /// `real_plugin_gated.rs`'s instrument commentary).
    pub(crate) fn run_process(
        &self,
        mut input_ptrs: [*mut f32; 2],
        mut output_ptrs: [*mut f32; 2],
        frames: usize,
        parameter_changes: &ParameterChanges,
    ) -> tresult {
        let Ok(num_samples) = i32::try_from(frames) else {
            return kInvalidArgument;
        };
        let processor = &self.processor;

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

        let mut process_context = self.process_context();
        let mut process_data = ProcessData {
            processMode: self.process_mode.as_vst3(),
            symbolicSampleSize: SymbolicSampleSizes_::kSample32 as i32,
            numSamples: num_samples,
            numInputs: if self.is_effect { 1 } else { 0 },
            numOutputs: 1,
            inputs: if self.is_effect {
                inputs.as_mut_ptr()
            } else {
                ptr::null_mut()
            },
            outputs: outputs.as_mut_ptr(),
            inputParameterChanges: parameter_changes.as_ptr(),
            outputParameterChanges: self.output_parameter_changes.as_ptr(),
            inputEvents: self.input_events.as_ptr(),
            outputEvents: self.output_events.as_ptr(),
            processContext: &mut process_context,
        };

        unsafe { processor.process(&mut process_data) }
    }

    pub(crate) fn process_context(&self) -> ProcessContext {
        let mut state = ProcessContext_::StatesAndFlags_::kTempoValid
            | ProcessContext_::StatesAndFlags_::kTimeSigValid;
        let required = self.process_context_requirements;
        if required & IProcessContextRequirements_::Flags_::kNeedTransportState != 0 {
            state |= ProcessContext_::StatesAndFlags_::kPlaying;
        }
        if required & IProcessContextRequirements_::Flags_::kNeedProjectTimeMusic != 0 {
            state |= ProcessContext_::StatesAndFlags_::kProjectTimeMusicValid;
        }
        if required & IProcessContextRequirements_::Flags_::kNeedTempo != 0 {
            state |= ProcessContext_::StatesAndFlags_::kTempoValid;
        }
        if required & IProcessContextRequirements_::Flags_::kNeedTimeSignature != 0 {
            state |= ProcessContext_::StatesAndFlags_::kTimeSigValid;
        }
        ProcessContext {
            state,
            sampleRate: self.sample_rate,
            projectTimeSamples: 0,
            systemTime: 0,
            continousTimeSamples: 0,
            projectTimeMusic: 0.0,
            barPositionMusic: 0.0,
            cycleStartMusic: 0.0,
            cycleEndMusic: 0.0,
            tempo: 120.0,
            timeSigNumerator: 4,
            timeSigDenominator: 4,
            chord: Chord {
                keyNote: 0,
                rootNote: 0,
                chordMask: 0,
            },
            smpteOffsetSubframes: 0,
            frameRate: FrameRate {
                framesPerSecond: 0,
                flags: 0,
            },
            samplesToNextClock: 0,
        }
    }
}

/// Audio-thread half of the split VST3 instrument processor (#474 P1). `Send` の根拠と
/// teardown 順序契約は [`Vst3EffectAudio`] / [`Vst3PluginMain`] と同一。
pub struct Vst3InstrumentAudio {
    pub(crate) processor: ComPtr<IAudioProcessor>,
    /// `ProcessSetup` で宣言したのと同じ処理圧（[`Vst3EffectAudio::process_mode`] と同じ理由）。
    pub(crate) process_mode: Vst3ProcessMode,
    pub(crate) input_events: InputEventList,
    pub(crate) output_parameter_changes: ParameterChanges,
    pub(crate) output_events: EventList,
    pub(crate) process_output_l: Vec<f32>,
    pub(crate) process_output_r: Vec<f32>,
    /// Raw tresult of the most recent failing `process()` call (RT-safe: no logging on the hot
    /// path, just stashed for the caller to surface out-of-band, e.g. on child process exit).
    pub(crate) last_process_error: std::cell::Cell<i32>,
}

// SAFETY: [`Vst3EffectAudio`] の SAFETY コメントと同一の根拠（VST3 の audio スレッド駆動は
// 正準モデル・COM 参照カウントはスレッド安全・host 側 COM スタブは move 後single-thread 使用・
// teardown 順序は composite の明示 `Drop` / 分割 child の join-then-drop が強制）。
unsafe impl Send for Vst3InstrumentAudio {}

impl Drop for Vst3InstrumentAudio {
    fn drop(&mut self) {
        let result = unsafe { self.processor.setProcessing(0) };
        if !is_ok(result) && result != kNotImplemented {
            eprintln!("[orbit-vst3-host] instrument setProcessing(0) failed: {result}");
        }
    }
}

/// Single-threaded-by-default VST3 instrument processor: [`Vst3InstrumentAudio`] +
/// [`Vst3PluginMain`] の composite（構成・分割・teardown 契約は [`Vst3EffectProcessor`] と対称）。
///
/// Shutdown call order is enforced by the hand-written [`Drop::drop`] body below via explicit
/// `.take()` calls, not by field declaration order.
pub struct Vst3InstrumentProcessor {
    pub(crate) audio: Option<Vst3InstrumentAudio>,
    pub(crate) main: Option<Vst3PluginMain>,
}

/// #540 P2: 保存済み state を component / controller へ復元する（`.vstpreset` container と
/// raw component state chunk の両対応）。失敗はハードエラー — 音色が復元できていないのに
/// default 音で鳴らすのは「保存した音で鳴る」という契約違反のため、呼び出し側は
/// ロード失敗として表面化させる。
pub(crate) fn apply_state_bytes(
    component: &ComPtr<IComponent>,
    controller: Option<&ComPtr<IEditController>>,
    bytes: &[u8],
) -> Result<(), Vst3HostError> {
    let owned_raw;
    let chunks = match parse_vstpreset(bytes)? {
        Some(chunks) => chunks,
        None => {
            // magic 無し = raw component state chunk（自前保存の生 dump 等）。
            owned_raw = VstPresetChunks {
                component: bytes,
                controller: None,
            };
            owned_raw
        }
    };
    apply_state_chunks(component, controller, &chunks)
}
