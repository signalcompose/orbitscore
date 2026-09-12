//! insert bus と source output を含む完全経路の render（#888 子 2・output.rs）。
//!
//! 🔴 **これは純粋な移動である。** `render.rs` から最大の 1 関数を分けた。
//! 1 ファイルにまとめると **641 コード行**で閾値 500 を超えるため（設計 §13.9 の制約 1）。

#[allow(unused_imports)]
use super::*;

#[inline]
#[allow(clippy::too_many_arguments)]
pub(super) fn render_engine_with_insert_buses_and_source_outputs(
    engine: &Engine,
    link: &mut Option<LinkEgress>,
    buses: &mut [InsertBusStage],
    sources: &[SourceSlot],
    rendered_units: &[usize],
    output_channels: usize,
    hw: &mut [f32],
    mut device: Option<&mut DeviceLineBuffer<'_>>,
) {
    // LinkAudio と併用するときも 1 回の render_multi に集約し、transport/gain ramp を一度だけ進める。
    // bus 名と Link channel 名が重複した場合は bus を先に登録する（S1 は daemon Link 配線を変更しない）。
    use arrayvec::ArrayVec;
    const MAX_TARGETS: usize = MAX_INSERT_BUS_STAGES + MAX_LINK_CHANNELS;
    debug_assert!(buses.len() <= MAX_INSERT_BUS_STAGES);
    let bs = (hw.len() / output_channels) * output_channels;

    // active フラグを 1 回だけ atomic load して使い回す（RT: 同じ判定を何度も load しない）。
    let active_flags: ArrayVec<bool, MAX_INSERT_BUS_STAGES> = buses
        .iter()
        .map(|bus| bus.active.load(Ordering::Relaxed))
        .collect();

    // One Acquire pointer snapshot per line is shared by the marking pass and execution. A control
    // install during this callback therefore cannot make the two passes disagree about which
    // downstream buffers must be cleared. The generation is published only after both passes.
    let programs: ArrayVec<*mut LineProgram, MAX_INSERT_BUS_STAGES> =
        buses.iter().map(|bus| bus.line.load()).collect();

    // `with_routing_overrides` remains as a source-compatible construction shim for existing
    // native callers. Production `SetBusRouting` installs a complete program; only this legacy
    // shim snapshots the old atomic handles.
    let legacy_targets: ArrayVec<Option<OutputDest>, MAX_INSERT_BUS_STAGES> = buses
        .iter()
        .map(|bus| {
            bus.line.legacy.as_ref().and_then(|legacy| {
                decode_bus_routing_sentinel(legacy.output.load(Ordering::Relaxed)).map(|target| {
                    match target {
                        BusTarget::Master => OutputDest::Master,
                        BusTarget::Bus(index) => OutputDest::Bus(index),
                    }
                })
            })
        })
        .collect();
    let legacy_send_gains: ArrayVec<
        ArrayVec<f32, { MAX_INSERT_BUS_STAGES - 1 }>,
        MAX_INSERT_BUS_STAGES,
    > = buses
        .iter()
        .map(|bus| {
            bus.line
                .legacy
                .as_ref()
                .map(|legacy| {
                    legacy
                        .sends
                        .iter()
                        .map(|gain| f32::from_bits(gain.load(Ordering::Relaxed)))
                        .collect()
                })
                .unwrap_or_default()
        })
        .collect();

    // is_render_target（MX.4）: 「event tag を受けるか」（active）と「グラフの中継点として
    // 生きるか」（他の active stage の output_target/sends から参照されるか）を分離する。
    // 後者だけが true の stage（例: 未 declare の sum bus に active な member が output している）
    // も、buffer を zero-fill し post-loop で処理しないと合流先が前 block のゴミを持ち越す。
    let mut render_targets: ArrayVec<bool, MAX_INSERT_BUS_STAGES> =
        active_flags.iter().copied().collect();
    for (i, _bus) in buses.iter().enumerate() {
        if !active_flags[i] {
            continue;
        }
        // SAFETY: the line generation is not completed until after execution below. Control keeps
        // any replaced box retired for two later completed generations.
        let program = unsafe { &*programs[i] };
        let mut first_output = true;
        let mut reached_end = true;
        for op in &program.ops {
            if let LineOp::Output(output) = op {
                let dest =
                    effective_line_output_dest(&mut first_output, legacy_targets[i], output.dest);
                if let OutputDest::Bus(target) = dest {
                    render_targets[target] = true;
                }
                if !output.thru {
                    reached_end = false;
                    break;
                }
            }
        }
        if reached_end {
            for (offset, gain) in legacy_send_gains[i].iter().enumerate() {
                if *gain != 0.0 {
                    render_targets[i + 1 + offset] = true;
                }
            }
        }
    }

    let mut targets: ArrayVec<(&str, &mut [f32]), MAX_TARGETS> = ArrayVec::new();
    let mut bus_positions: ArrayVec<Option<usize>, MAX_INSERT_BUS_STAGES> =
        buses.iter().map(|_| None).collect();
    for (i, bus) in buses.iter_mut().enumerate() {
        if !active_flags[i] {
            // inactive stage は render_multi のタグ対象外（コストゼロ・event tag 契約は変えない・
            // InsertBusStage::active の doc 参照）。ただし render_target なら render_multi を
            // 通らないので、代わりにここで手動 zero-fill する（post-loop が読む前提を守る）。
            if render_targets[i] {
                bus.buffer[..bs].fill(0.0);
            }
            continue;
        }
        debug_assert!(
            bus.buffer.len() >= bs,
            "insert bus '{}' buffer too short",
            bus.name
        );
        let position = targets.len();
        targets
            .try_push((bus.name.as_str(), &mut bus.buffer[..bs]))
            .expect("bounded bus count");
        bus_positions[i] = Some(position);
    }

    if let Some(le) = link {
        while let Ok(act) = le.reg_rx.pop() {
            le.channels.push(act);
        }
        for ch in le.channels.iter_mut() {
            let active =
                channel_egress_active(ch.ready.load(Ordering::Relaxed), ch.scratch.len(), bs);
            if active
                && targets
                    .try_push((ch.name.as_str(), &mut ch.scratch[..bs]))
                    .is_err()
            {
                debug_assert!(false, "render target pool exceeded configured cap");
                break;
            }
        }
    }
    // core は `render_multi` を `render_multi_feeds(.., &[])` に委譲しており、その bit 一致は
    // `render_multi_feeds_empty_matches_render_multi_bit_for_bit` が固定している。sources が
    // 空なら `collect_source_feeds` は空を返すので、呼び出し側で場合分けし直す必要はない。
    let feeds = collect_source_feeds(sources, rendered_units, &bus_positions, bs);
    engine.render_multi_feeds(hw, &mut targets, &feeds);
    drop(targets);

    // post-loop: execute each captured line in topological stage order. Bus outputs retain the
    // existing split_at_mut(i + 1) discipline; every target was validated before publication.
    for i in 0..buses.len() {
        if !render_targets[i] {
            continue;
        }
        // SAFETY: paired with the Acquire load above and the generation completion below.
        let program = unsafe { &*programs[i] };
        let mut first_output = true;
        let mut reached_end = true;
        for (op_index, op) in program.ops.iter().enumerate() {
            match *op {
                LineOp::Rack => {
                    if active_flags[i] {
                        if let Some(processor) = buses[i].processor.as_mut() {
                            processor.process(&mut buses[i].buffer[..bs]);
                        }
                    }
                }
                LineOp::Gain(target) => {
                    let frames = bs / output_channels;
                    let ramp =
                        line_ramp(program, op_index, target, frames, buses[i].line.ramp_frames);
                    apply_ramped_gain(&mut buses[i].buffer[..bs], output_channels, ramp);
                }
                LineOp::Pan(target) => {
                    let frames = bs / output_channels;
                    let ramp =
                        line_ramp(program, op_index, target, frames, buses[i].line.ramp_frames);
                    apply_line_pan(&mut buses[i].buffer[..bs], frames, ramp);
                }
                LineOp::Output(output) => {
                    let dest = effective_line_output_dest(
                        &mut first_output,
                        legacy_targets[i],
                        output.dest,
                    );
                    let frames = bs / output_channels;
                    let ramp = line_ramp(
                        program,
                        op_index,
                        output.gain,
                        frames,
                        buses[i].line.ramp_frames,
                    );
                    match dest {
                        OutputDest::Master => {
                            add_ramped_scaled(hw, &buses[i].buffer[..bs], output_channels, ramp);
                        }
                        OutputDest::Bus(target) => {
                            let (left, right) = buses.split_at_mut(i + 1);
                            add_ramped_scaled(
                                &mut right[target - i - 1].buffer[..bs],
                                &left[i].buffer[..bs],
                                output_channels,
                                ramp,
                            );
                        }
                        OutputDest::Device { left, right } => {
                            if let Some(device) = device.as_deref_mut() {
                                add_to_device(
                                    device,
                                    &buses[i].buffer[..bs],
                                    frames,
                                    left,
                                    right,
                                    ramp,
                                );
                            } else {
                                // Unit-level engine seams have no outer master line; in that shape
                                // their `hw` argument is the physical destination itself.
                                let mut direct = DeviceLineBuffer {
                                    samples: hw,
                                    channels: output_channels,
                                    // `hw` already contains the core/master contribution in this
                                    // unit-level shape, so Device output accumulates without clear.
                                    wrote: true,
                                };
                                add_to_device(
                                    &mut direct,
                                    &buses[i].buffer[..bs],
                                    frames,
                                    left,
                                    right,
                                    ramp,
                                );
                            }
                        }
                        // Render and Link sinks arrive in their dedicated follow-up PRs. No
                        // program generated by this compatibility PR contains these destinations.
                        OutputDest::Render(_) | OutputDest::Link(_) => {}
                    }
                    if !output.thru {
                        reached_end = false;
                        break;
                    }
                }
            }
        }

        if reached_end {
            for (offset, gain) in legacy_send_gains[i].iter().copied().enumerate() {
                if gain != 0.0 {
                    let (left, right) = buses.split_at_mut(i + 1);
                    add_scaled(&mut right[offset].buffer[..bs], &left[i].buffer[..bs], gain);
                }
            }
        }
    }

    for bus in buses.iter() {
        bus.line.finish_generation();
    }

    if let Some(le) = link {
        for ch in le.channels.iter_mut() {
            if channel_egress_active(ch.ready.load(Ordering::Relaxed), ch.scratch.len(), bs) {
                ch.sink.commit(&ch.scratch[..bs]);
            }
        }
    }
}
