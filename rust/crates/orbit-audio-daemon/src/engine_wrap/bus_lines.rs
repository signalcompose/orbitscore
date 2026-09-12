//! `EngineWrap` のバスルーティング（#888 子 1・第 2 束）。
//!
//! 🔴 **これは純粋な移動である。** `engine_wrap.rs` の `impl EngineWrap` から
//! `device_dest_from_wire` / `render_dest_rejected` / `link_dest_rejected` /
//! `set_bus_line` / `set_bus_routing` / `set_source_routing` をそのまま移しただけで、
//! 本文は 1 行も書き換えていない。
//!
//! **ヘルパー 3 本を一緒に動かしている**のは、置いていくとモジュールを跨いで
//! `pub(crate)` 化が要り、それは「移動」ではなく「変更」なので residual に出るため。
//!
//! 親の子モジュールなので `EngineWrap` の private フィールドに到達できる（可視性の変更 0 件）。
//! 対応するインラインテスト（`set_bus_line_tests` / `set_bus_routing_tests` /
//! `set_source_routing_tests`）は `engine_wrap.rs` に残す（コード行に数えられないので
//! 目標に寄与せず、移すと素の変更行だけが増える）。

use super::*;

impl EngineWrap {
    /// wire の 1 始まりチャンネル対を RT の 0 始まり `OutputDest::Device` へ写す。
    /// **master line と named bus で扱いが同一**なので 1 箇所に置く（§4.1 の `dest.device`）。
    #[cfg(feature = "outproc-effect")]
    fn device_dest_from_wire(left: usize, right: Option<usize>) -> Result<OutputDest, WrapError> {
        let one_based =
            || WrapError::OutProcEffectRequest("SetBusLine device channels are 1-based".into());
        Ok(OutputDest::Device {
            left: left.checked_sub(1).ok_or_else(one_based)?,
            right: right
                .map(|channel| channel.checked_sub(1).ok_or_else(one_based))
                .transpose()?,
        })
    }

    /// `dest.render` は登記簿（`DeclareRender`・PR-R2）が無いので今日はすべて未登録。
    /// 🔴 これは §4.1 の規則を**今日の状態に当てはめた結果**であって、規則の変更ではない。
    /// 登記簿が入ったら、ここと `output.rs` の `validate_line_program` の両方から外す。
    #[cfg(feature = "outproc-effect")]
    fn render_dest_rejected(id: &str) -> WrapError {
        WrapError::OutProcEffectRequest(format!(
            "SetBusLine render destination '{id}' is not registered"
        ))
    }

    /// `dest.link` は **`link-audio` feature の有無にかかわらず**今日は受理しない。
    /// 🔴 理由は feature ではなく **RT が Link 出口をまだ実行できない**こと
    /// （`output.rs` の `validate_line_program` が同じ理由で拒否しており、**そちらが一次情報**）。
    /// wire code は §4.1 の指定どおり `LINK_AUDIO_UNAVAILABLE`。RT へ配線されたら、
    /// そこで初めて「feature 有効 + 登録済み channel なら受理」へ広げる。
    #[cfg(feature = "outproc-effect")]
    fn link_dest_rejected(channel: &str) -> WrapError {
        WrapError::LinkAudioUnavailable(format!(
            "SetBusLine link destination '{channel}' is not wired into RT execution yet"
        ))
    }

    /// §4.1 の complete line を検証・解決して LineSlot へ一度だけ publish する。
    ///
    /// 🔴 **入力は `session.rs` の `parse_set_bus_line_params` が先に検証済み**（wire の形・`rack` の
    /// 重複・`gain` の範囲・master の自己参照）。ここでの再検証は **`pub fn` としての防御**であり、
    /// production の経路では到達しない（呼び出し元は `session.rs` の dispatch 1 箇所のみ）。
    ///
    /// ⚠️ **`gain` の条件が session 側と違って見えるのは型が違うから**で、乖離ではない。
    /// session は JSON の **f64** を受けるので `> f32::MAX` を弾いてから `as f32` する必要がある
    /// （変換で `inf` になるのを防ぐ）。こちらは既に **f32** なので `is_finite()` が `inf` を弾き、
    /// 有限な f32 は定義上 `f32::MAX` 以下である。**同じ規則を型に合わせて書いた形**。
    #[cfg(feature = "outproc-effect")]
    pub fn set_bus_line(&self, bus: &str, wire_ops: &[BusLineOp]) -> Result<(), WrapError> {
        let mut rack_seen = false;
        for op in wire_ops {
            match op {
                BusLineOp::Rack if rack_seen => {
                    return Err(WrapError::OutProcEffectRequest(
                        "SetBusLine rack may appear at most once".into(),
                    ));
                }
                BusLineOp::Rack => rack_seen = true,
                BusLineOp::Gain(gain) if !gain.is_finite() || *gain < 0.0 => {
                    return Err(WrapError::OutProcEffectRequest(
                        "SetBusLine gain must be finite and >= 0".into(),
                    ));
                }
                BusLineOp::Pan(pan) if !pan.is_finite() || !(-1.0..=1.0).contains(pan) => {
                    return Err(WrapError::OutProcEffectRequest(
                        "SetBusLine pan must be finite and within -1..=1".into(),
                    ));
                }
                BusLineOp::Output { gain, .. } if !gain.is_finite() || *gain < 0.0 => {
                    return Err(WrapError::OutProcEffectRequest(
                        "SetBusLine output gain must be finite and >= 0".into(),
                    ));
                }
                BusLineOp::Gain(_) | BusLineOp::Pan(_) | BusLineOp::Output { .. } => {}
            }
        }

        if bus == "master" {
            let mut resolved = Vec::with_capacity(wire_ops.len());
            for op in wire_ops {
                resolved.push(match op {
                    BusLineOp::Rack => LineOp::Rack,
                    BusLineOp::Gain(gain) => LineOp::Gain(*gain),
                    BusLineOp::Pan(pan) => LineOp::Pan(*pan),
                    BusLineOp::Output {
                        dest: BusLineDest::Device { left, right },
                        thru,
                        gain,
                    } => LineOp::Output(LineOutput {
                        dest: Self::device_dest_from_wire(*left, *right)?,
                        thru: *thru,
                        gain: *gain,
                    }),
                    // master line の出口は device のみ（§4.1 の自己参照禁止）。
                    BusLineOp::Output {
                        dest: BusLineDest::Master | BusLineDest::Bus(_),
                        ..
                    } => {
                        return Err(WrapError::OutProcEffectRequest(
                            "SetBusLine master line cannot target master or a bus".into(),
                        ));
                    }
                    BusLineOp::Output {
                        dest: BusLineDest::Render(id),
                        ..
                    } => return Err(Self::render_dest_rejected(id)),
                    BusLineOp::Output {
                        dest: BusLineDest::Link(channel),
                        ..
                    } => return Err(Self::link_dest_rejected(channel)),
                });
            }
            let mut shadow = self.master_line_program.lock().map_err(|_| {
                WrapError::OutProcEffect("master line program mutex poisoned".into())
            })?;
            let current = self.master_line.current_gains();
            let seeds = line_republish_seeds(&resolved, &shadow, &current);
            self.master_line
                .install_for_bus(
                    LineProgram::with_seeds(resolved.clone(), seeds),
                    usize::MAX,
                    0,
                )
                .map_err(|error| {
                    WrapError::OutProcEffectRequest(format!(
                        "SetBusLine master program failed validation: {error}"
                    ))
                })?;
            *shadow = resolved;
            return Ok(());
        }

        let guard = self
            .outproc
            .lock()
            .map_err(|_| WrapError::OutProcEffect("outproc mutex poisoned".into()))?;
        let control = guard.as_ref().ok_or_else(|| {
            WrapError::OutProcEffectUnavailable(
                "outproc effect not initialized (test backend has no outproc path)".into(),
            )
        })?;
        let bus_index = *control
            .bus_index
            .get(bus)
            .ok_or_else(|| WrapError::OutProcEffect(format!("unknown bus '{bus}'")))?;
        let bus_count = control.bus_index.len();
        let mut referenced_buses = Vec::new();
        let mut resolved = Vec::with_capacity(wire_ops.len());
        for op in wire_ops {
            resolved.push(match op {
                BusLineOp::Rack => LineOp::Rack,
                BusLineOp::Gain(gain) => LineOp::Gain(*gain),
                BusLineOp::Pan(pan) => LineOp::Pan(*pan),
                BusLineOp::Output {
                    dest,
                    thru,
                    gain,
                } => {
                    let dest = match dest {
                        BusLineDest::Master => OutputDest::Master,
                        BusLineDest::Bus(name) => {
                            let target = *control.bus_index.get(name).ok_or_else(|| {
                                WrapError::OutProcEffect(format!(
                                    "SetBusLine output: unknown bus '{name}'"
                                ))
                            })?;
                            if target <= bus_index {
                                return Err(WrapError::OutProcEffect(format!(
                                    "SetBusLine output '{name}' (index {target}) must be a later stage than '{bus}' (index {bus_index})"
                                )));
                            }
                            referenced_buses.push(name.as_str());
                            OutputDest::Bus(target)
                        }
                        BusLineDest::Device { left, right } => {
                            Self::device_dest_from_wire(*left, *right)?
                        }
                        BusLineDest::Render(id) => return Err(Self::render_dest_rejected(id)),
                        BusLineDest::Link(channel) => {
                            return Err(Self::link_dest_rejected(channel))
                        }
                    };
                    LineOp::Output(LineOutput {
                        dest,
                        thru: *thru,
                        gain: *gain,
                    })
                }
            });
        }

        let installer = self
            .bus_line_programs
            .lock()
            .map_err(|_| WrapError::OutProcEffect("bus line mutex poisoned".into()))?
            .get(bus)
            .cloned()
            .ok_or_else(|| {
                WrapError::OutProcEffect(format!(
                    "SetBusLine: unknown bus '{bus}' (no registered RT line)"
                ))
            })?;
        let mut shadows = self
            .bus_line_shadows
            .lock()
            .map_err(|_| WrapError::OutProcEffect("bus line shadow mutex poisoned".into()))?;
        let old_ops = shadows
            .entry(bus.to_owned())
            .or_insert_with(default_bus_line_program);
        let current = installer.current_gains();
        let seeds = line_republish_seeds(&resolved, old_ops, &current);
        installer
            .install_for_bus(
                LineProgram::with_seeds(resolved.clone(), seeds),
                bus_index,
                bus_count,
            )
            .map_err(|error| {
                WrapError::OutProcEffectRequest(format!(
                    "SetBusLine program failed validation: {error}"
                ))
            })?;
        *old_ops = resolved;

        for name in std::iter::once(bus).chain(referenced_buses) {
            if let Some(active) = control.bus_actives.get(name) {
                active.store(true, Ordering::Release);
            }
        }
        Ok(())
    }

    /// 実行時ルーティング切替（#459/#453 M2）: `seq_bus` の output target / send gain を非 RT で
    /// 書き換える。**forward-only（MX.4）と kind 制約（output は sum のみ・send 先は aux のみ）を
    /// ここで検証してから atomic に反映する**（RT callback は検証済みの値を load するだけ）。
    ///
    /// - `output = Some("master")`: **予約語**。sum への出力先指定を解除して hardware/master へ
    ///   戻す（#517 S3 で追加。この予約語は bus 名として検索・登録しない）。
    /// - `output = Some(name)`: `name` は `sum` kind かつ `seq_bus` より後ろの index でなければ
    ///   ならない。それ以外はエラーで拒否し、既存の routing_override には触れない（部分適用しない）。
    /// - `output = None`: output target には触れない（既存の override をそのまま保つ）。
    ///   予約語との区別で「変更なし / sum へ変更 / master へ戻す」の三状態を表現する。
    /// - `sends`: 列挙された `(name, gain)` のみを反映する（列挙されていない既存 send には触れない）。
    ///   `name` は `aux` kind かつ `seq_bus` より後ろの index でなければならない。`gain` は有限
    ///   （NaN/Inf 拒否）。1 件でも検証に失敗したら **どの send も反映しない**（部分適用しない）。
    #[cfg(feature = "outproc-effect")]
    pub fn set_bus_routing(
        &self,
        seq_bus: &str,
        output: Option<&str>,
        sends: &[(String, f32)],
    ) -> Result<(), WrapError> {
        let guard = self
            .outproc
            .lock()
            .map_err(|_| WrapError::OutProcEffect("outproc mutex poisoned".into()))?;
        let control = guard.as_ref().ok_or_else(|| {
            WrapError::OutProcEffectUnavailable(
                "outproc effect not initialized (test backend has no outproc path)".into(),
            )
        })?;

        let seq_index = *control
            .bus_index
            .get(seq_bus)
            .ok_or_else(|| WrapError::OutProcEffect(format!("unknown bus '{seq_bus}'")))?;
        let send_offset = |target_index: usize| target_index - seq_index - 1;

        // 1. output target を検証（反映はまだしない・部分適用を避ける）。
        let resolved_output = match output {
            Some("master") => Some(1),
            Some(name) => {
                let target_index = *control.bus_index.get(name).ok_or_else(|| {
                    WrapError::OutProcEffect(format!("SetBusRouting output: unknown bus '{name}'"))
                })?;
                if target_index <= seq_index {
                    return Err(WrapError::OutProcEffect(format!(
                        "SetBusRouting output '{name}' (index {target_index}) must be a later stage than '{seq_bus}' (index {seq_index})"
                    )));
                }
                if control.bus_kinds.get(name) != Some(&BusKind::Sum) {
                    return Err(WrapError::OutProcEffect(format!(
                        "SetBusRouting output '{name}' must be a sum bus"
                    )));
                }
                Some(target_index + 2)
            }
            None => None,
        };

        // 2. sends を検証（同上・1 件でも失敗したら全体を拒否）。
        let mut resolved_sends = Vec::with_capacity(sends.len());
        for (name, gain) in sends {
            if !gain.is_finite() {
                return Err(WrapError::OutProcEffect(format!(
                    "SetBusRouting send '{name}' gain must be finite, got {gain}"
                )));
            }
            let target_index = *control.bus_index.get(name).ok_or_else(|| {
                WrapError::OutProcEffect(format!("SetBusRouting send: unknown bus '{name}'"))
            })?;
            if target_index <= seq_index {
                return Err(WrapError::OutProcEffect(format!(
                    "SetBusRouting send '{name}' (index {target_index}) must be a later stage than '{seq_bus}' (index {seq_index})"
                )));
            }
            if control.bus_kinds.get(name) != Some(&BusKind::Aux) {
                return Err(WrapError::OutProcEffect(format!(
                    "SetBusRouting send '{name}' must be an aux bus"
                )));
            }
            resolved_sends.push((target_index, *gain));
        }

        // 3. Every compatibility handle is resolved before the one program publication, so a
        // missing slot cannot leave only part of the requested routing applied.
        let routing_handle = if resolved_output.is_some() {
            Some(control.bus_routing.get(seq_bus).ok_or_else(|| {
                WrapError::OutProcEffect(format!("bus '{seq_bus}' has no routing handle"))
            })?)
        } else {
            None
        };
        let send_slots = if resolved_sends.is_empty() {
            None
        } else {
            Some(control.bus_sends.get(seq_bus).ok_or_else(|| {
                WrapError::OutProcEffect(format!("bus '{seq_bus}' has no send slots"))
            })?)
        };
        for (target_index, _) in &resolved_sends {
            let k = send_offset(*target_index);
            if send_slots.and_then(|slots| slots.get(k)).is_none() {
                return Err(WrapError::OutProcEffect(format!(
                    "bus '{seq_bus}' has no send slot for target index {target_index}"
                )));
            }
        }

        let line = self
            .bus_lines
            .lock()
            .map_err(|_| WrapError::OutProcEffect("bus line mutex poisoned".into()))?
            .get(seq_bus)
            .cloned()
            .ok_or_else(|| {
                WrapError::OutProcEffect(format!(
                    "SetBusRouting: unknown bus '{seq_bus}' (no registered RT line)"
                ))
            })?;
        let routing_value = resolved_output.unwrap_or_else(|| {
            control
                .bus_routing
                .get(seq_bus)
                .map(|routing| routing.load(Ordering::Relaxed))
                .unwrap_or(0)
        });
        let output_target = decode_bus_routing_sentinel(routing_value).unwrap_or(BusTarget::Master);
        let existing_sends = control.bus_sends.get(seq_bus);
        let mut gains = existing_sends
            .map(|slots| {
                slots
                    .iter()
                    .map(|slot| f32::from_bits(slot.load(Ordering::Relaxed)))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for (target_index, gain) in &resolved_sends {
            gains[send_offset(*target_index)] = *gain;
        }
        let enabled_sends: Vec<BusSend> = gains
            .into_iter()
            .enumerate()
            .filter(|(_, gain)| *gain != 0.0)
            .map(|(offset, gain)| BusSend {
                target: seq_index + 1 + offset,
                gain,
            })
            .collect();
        let shadow = legacy_line_ops(output_target, &enabled_sends);
        let mut shadows = self
            .bus_line_shadows
            .lock()
            .map_err(|_| WrapError::OutProcEffect("bus line shadow mutex poisoned".into()))?;
        line(
            output_target,
            enabled_sends,
            seq_index,
            control.bus_index.len(),
        )
        .map_err(WrapError::Output)?;
        shadows.insert(seq_bus.to_owned(), shadow);

        // Mirror the accepted state into the old handles. Existing Rust callers and tests can
        // continue to observe the partial-update API, while production RT reads only LineProgram.
        if let (Some(routing), Some(routing_value)) = (routing_handle, resolved_output) {
            routing.store(routing_value, Ordering::Relaxed);
        }
        if let Some(send_slots) = send_slots {
            for (target_index, gain) in resolved_sends {
                let k = send_offset(target_index);
                send_slots[k].store(gain.to_bits(), Ordering::Relaxed);
            }
        }

        // 4. activation（M3・#459/#453）: `SetBusRouting` は `LoadPlugin` と同じ activation 機構を
        //    共有する（MX.4）。plugin 未ロードの pass-through bus（insert 未宣言の seq が
        //    `seq.output`/`seq.send` だけを持つケース）でも routing が生きるよう、参照された bus
        //    （seq_bus 自身・output 先・send 先）を render 対象に含める。既に active な bus への
        //    再 store は無害（RT 経路は bool load のみ）。
        for name in std::iter::once(seq_bus)
            .chain(output)
            .chain(sends.iter().map(|(name, _)| name.as_str()))
        {
            if let Some(active) = control.bus_actives.get(name) {
                active.store(true, Ordering::Release);
            }
        }
        Ok(())
    }

    /// Route one preallocated output unit of an opaque source to an explicit destination.
    /// All name/kind/range validation happens before either shared atomic is changed.
    #[cfg(all(feature = "outproc-effect", feature = "outproc-instrument"))]
    pub fn set_source_routing(
        &self,
        source: &str,
        unit: u32,
        target: SourceRoutingTarget,
    ) -> Result<(), WrapError> {
        let (resolved, active) = match target {
            SourceRoutingTarget::None => (orbit_audio_native::SourceDest::None, None),
            SourceRoutingTarget::Master => (orbit_audio_native::SourceDest::Master, None),
            SourceRoutingTarget::Bus(name) => {
                let guard = self
                    .outproc
                    .lock()
                    .map_err(|_| WrapError::OutProcEffect("outproc mutex poisoned".into()))?;
                let control = guard.as_ref().ok_or_else(|| {
                    WrapError::OutProcEffectUnavailable(
                        "outproc effect not initialized (test backend has no outproc path)".into(),
                    )
                })?;
                let bus_index = *control.bus_index.get(&name).ok_or_else(|| {
                    WrapError::OutProcEffect(format!(
                        "SetSourceRouting target: unknown bus '{name}'"
                    ))
                })?;
                if control.bus_kinds.get(&name) != Some(&BusKind::Insert) {
                    return Err(WrapError::OutProcEffect(format!(
                        "SetSourceRouting target '{name}' must be an insert bus"
                    )));
                }
                let active = control.bus_actives.get(&name).cloned().ok_or_else(|| {
                    WrapError::OutProcEffect(format!(
                        "SetSourceRouting target bus '{name}' has no activation handle"
                    ))
                })?;
                (orbit_audio_native::SourceDest::Bus(bus_index), Some(active))
            }
        };

        // Keep the instance mapping lock through the destination store. Replacement commits use
        // the same lock to copy all destinations, so routing cannot land on a just-retired slot.
        let guard = self.outproc_instrument.lock().map_err(|_| {
            WrapError::OutProcInstrument("outproc instrument mutex poisoned".into())
        })?;
        let control = guard.as_ref().ok_or_else(|| {
            WrapError::OutProcInstrumentUnavailable(
                "outproc instrument not initialized (test backend has no outproc path)".into(),
            )
        })?;
        let slot_index = *control.instance_index.get(source).ok_or_else(|| {
            WrapError::OutProcInstrument(format!("SetSourceRouting: unknown source '{source}'"))
        })?;
        let slot = control.slots.get(slot_index).ok_or_else(|| {
            WrapError::OutProcInstrument(format!(
                "SetSourceRouting: source '{source}' resolves to missing slot {slot_index}"
            ))
        })?;
        let unit_index = usize::try_from(unit).map_err(|_| {
            WrapError::OutProcInstrument(format!(
                "SetSourceRouting: unit {unit} is out of range for source '{source}'"
            ))
        })?;
        let source_dest = slot.source_dests.get(unit_index).ok_or_else(|| {
            WrapError::OutProcInstrument(format!(
                "SetSourceRouting: unit {unit} is out of range for source '{source}' ({} units)",
                slot.source_dests.len()
            ))
        })?;
        if let Some(active) = active {
            active.store(true, Ordering::Release);
        }
        source_dest.store(resolved);
        Ok(())
    }
}
