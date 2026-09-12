//! オーディオコールバックのレンダリング経路（#888 子 2・output.rs）。
//!
//! 🔴 **これは純粋な移動である。** 1 callback 分の render 経路をそのまま移した。
//! 本文は 1 行も書き換えていない。

#[allow(unused_imports)]
use super::*;

/// 1 callback 分の処理（計測 + engine render + master-bus post-processor）。
#[inline]
pub(super) fn render_shared_block(
    engine: &Engine,
    state: &Arc<std::sync::Mutex<RenderState>>,
    capture: &mut Option<RingTapSink>,
    cb_stats: &Option<Arc<CallbackTimeStats>>,
    output_channels: usize,
    hw: &mut [f32],
    stats: &StreamStats,
) {
    stats.record_callback((hw.len() / output_channels) as u32);
    match state.try_lock() {
        Ok(mut state) => {
            let RenderState {
                link,
                insert_buses,
                sources,
                transport,
                master,
            } = &mut *state;
            render_block_with_sources(
                engine,
                link,
                insert_buses,
                sources,
                transport,
                master,
                capture,
                cb_stats,
                output_channels,
                hw,
            )
        }
        Err(_) => {
            hw.fill(0.0);
            stats.record_render_contention();
        }
    }
}

///
/// 手順（設計 `611-output-line-design.md` §5.3）: (1) callback 開始時刻を取る（`cb_stats` 有り時
/// のみ）→ (2) engine（+ 各 insert bus / LinkAudio egress）を常に 2ch で render し `master.buffer`
/// へ集約 → (3) master ライン: `master.post` 有りなら `master.buffer`（2ch）を in-place 変換
/// （CLAP effect/instrument・Issue #340）、続けて gain を適用（production の乗算経路はここ 1 本・
/// §5.4）→ (4) `master.buffer` を device 幅の `hw` へ配置（`place_master_into_device`）→
/// (5) `capture` 有りなら **配置後の最終 `hw`** を WAV 用 ring へ読み取り専用 tap（#307）→
/// (6) callback 所要時間を記録。`master.post`/`capture`/`cb_stats` は各々独立の opt-in 分岐で、
/// `master.post` が None かつ gain が 1.0（既定）なら従来経路とビット同一（2ch デバイス）。
/// `capture` は `hw` を読むだけなので有効でも出力サンプルは不変（tap であって mutation ではない）。
#[inline]
#[cfg(test)]
#[allow(clippy::too_many_arguments)] // callback state is kept as independent opt-in seams.
pub(super) fn render_block(
    engine: &Engine,
    link: &mut Option<LinkEgress>,
    insert_buses: &mut [InsertBusStage],
    master: &mut MasterLine,
    capture: &mut Option<RingTapSink>,
    cb_stats: &Option<Arc<CallbackTimeStats>>,
    output_channels: usize,
    hw: &mut [f32],
) {
    let mut sources = [];
    let mut transport = BlockTransport {
        cursor_frames: 0,
        sample_rate: 0,
    };
    render_block_with_sources(
        engine,
        link,
        insert_buses,
        &mut sources,
        &mut transport,
        master,
        capture,
        cb_stats,
        output_channels,
        hw,
    );
}

#[inline]
#[allow(clippy::too_many_arguments)]
pub(super) fn render_block_with_sources(
    engine: &Engine,
    link: &mut Option<LinkEgress>,
    insert_buses: &mut [InsertBusStage],
    sources: &mut [SourceSlot],
    transport: &mut BlockTransport,
    master: &mut MasterLine,
    capture: &mut Option<RingTapSink>,
    cb_stats: &Option<Arc<CallbackTimeStats>>,
    output_channels: usize,
    hw: &mut [f32],
) {
    // Instant::now() は macOS では mach_absolute_time（lock/alloc なし）= RT 許容。A0 §6 に基づき
    // production RT 監視を callback-duration ベースにするための計測（cb_stats 有り時のみ）。
    let t0 = cb_stats.as_ref().map(|_| Instant::now());

    // engine（+ bus graph）は常に 2ch で完結する（設計 §5.5 row 1・3）。`master.buffer` が core の
    // 「hardware_out」を受ける — デバイス幅（`output_channels`／`hw`）とは無関係。buffer は起動時に
    // 事前確保済み（`start_output_inner`）なので RT では resize しない。
    let frames = hw.len() / output_channels;
    let bs = frames * 2;
    debug_assert!(
        master.buffer.len() >= bs,
        "master buffer too short: {} < {bs}",
        master.buffer.len()
    );
    debug_assert!(master.direct_device_buffer.len() >= hw.len());
    let direct_device_written = {
        let mut device = DeviceLineBuffer {
            samples: &mut master.direct_device_buffer[..hw.len()],
            channels: output_channels,
            wrote: false,
        };
        render_engine_with_sources_impl(
            engine,
            link,
            insert_buses,
            sources,
            transport,
            2,
            &mut master.buffer[..bs],
            Some(&mut device),
        );
        device.wrote
    };

    if master.explicit_line.load(Ordering::Acquire) {
        execute_master_line(master, frames, output_channels, hw);
    } else {
        // SetBusLine 未使用時は従来の固定 master 経路を保ち、既存出力を bit 単位で変えない。
        // この分岐の中身は PR-O3b の前と 1 命令も変えていない（変えると O0 golden が動く）。
        if let Some(p) = master.post.as_mut() {
            p.process(&mut master.buffer[..bs]);
        }
        let ramp = master.advance_gain(frames);
        // gain == 1.0 は IEEE754 の乗算恒等元で bit 一致を崩さない（`x * 1.0 == x`）。分岐は
        // 「未使用 gain 経路に per-sample 乗算コストを払わない」ための最適化であり、O0 golden の
        // bit 一致は乗算そのものではなく `gain_current` が初期値 1.0 のまま変化しないことに由来する
        // （`SetGlobalGain` を一度も呼ばない譜面では target=current=1.0 が恒常的に成立する）。
        apply_ramped_gain(&mut master.buffer[..bs], ENGINE_CHANNELS, ramp);
        // デバイス配置（設計 §5.3・row 6）: master.buffer（2ch）を hw（デバイス幅）の ch{0,1} へ置く。
        // 2ch デバイスなら memcpy 相当（O0-1/O0-2 の bit 一致はここで成立）。3ch 以上は ch2 以降が
        // 無音で残る — この分岐の Device 出口は master 固定 program の 1 本のみで、複数出口は
        // `execute_master_line`（上の分岐）と PR-O4 以降の DSL 表面が持つ。
        //
        // 🔴 ここで `hw` を全域 zero-fill しない。`place_master_into_device` が **hw の全要素を
        // 書き切る**ので、1ch / 2ch（＝今日検証されている構成すべて）では書いた直後に全部上書きされ、
        // RT コールバックで**毎ブロック二重に store する**ことになる（64 frames × 2ch なら
        // 約 96,000 store/秒の無駄）。余剰チャンネルの 0 埋めは配置関数の責務に閉じた。
        place_master_into_device(&master.buffer[..bs], frames, output_channels, hw);
    }
    if direct_device_written {
        add_scaled(hw, &master.direct_device_buffer[..hw.len()], 1.0);
    }

    // capture seam（#307 realtime）: post 適用後の最終 hw（= device に出る実信号）を WAV へ逃がす
    // 読み取り専用 tap。`RingTapSink::commit` は wait-free / no-alloc（満杯時はあふれを drop カウント）
    // ＝ RT 契約を満たす。off-thread writer が ring を drain する。post の後・計測の内側に置くことで
    // capture コストも callback-duration に含めて監視する。
    if let Some(sink) = capture.as_mut() {
        sink.commit(hw);
    }

    if let (Some(stats), Some(t0)) = (cb_stats, t0) {
        stats.record(t0.elapsed().as_nanos() as u64);
    }
}

#[inline]
pub(super) fn execute_master_line(
    master: &mut MasterLine,
    frames: usize,
    output_channels: usize,
    hw: &mut [f32],
) {
    let bs = frames * ENGINE_CHANNELS;
    let program_ptr = master.line.load();
    // SAFETY: publication retains replaced programs for two completed RT generations. This
    // generation is completed only after the whole master program has executed.
    let program = unsafe { &*program_ptr };
    let mut device = DeviceLineBuffer {
        samples: hw,
        channels: output_channels,
        wrote: false,
    };
    for (op_index, op) in program.ops.iter().enumerate() {
        match *op {
            LineOp::Rack => {
                if let Some(processor) = master.post.as_mut() {
                    processor.process(&mut master.buffer[..bs]);
                }
            }
            LineOp::Gain(target) => {
                let ramp = line_ramp(program, op_index, target, frames, master.line.ramp_frames);
                apply_ramped_gain(&mut master.buffer[..bs], ENGINE_CHANNELS, ramp);
            }
            LineOp::Output(output) => {
                let ramp = line_ramp(
                    program,
                    op_index,
                    output.gain,
                    frames,
                    master.line.ramp_frames,
                );
                if let OutputDest::Device { left, right } = output.dest {
                    add_to_device(&mut device, &master.buffer[..bs], frames, left, right, ramp);
                } else {
                    // release ではこの debug_assert は no-op。到達不能を保証する唯一の境界は
                    // control 層の `set_bus_line` master 分岐であり、その検証が破れればこの出口は
                    // 無音のまま捨てられ、ログにも残らない。
                    debug_assert!(false, "master line destination was not validated");
                }
                if !output.thru {
                    break;
                }
            }
            LineOp::Pan(target) => {
                let ramp = line_ramp(program, op_index, target, frames, master.line.ramp_frames);
                apply_line_pan(&mut master.buffer[..bs], frames, ramp);
            }
        }
    }
    if !device.wrote {
        device.samples.fill(0.0);
    }
    master.line.finish_generation();
}

/// `master.buffer`（常に 2ch）を device 幅の `hw` へ配置する（裁定 2「Device 宛ては master の
/// ラック・ゲインを通らない」＝この関数の**手前**でラック/gain が既に適用済み）。`hw` は直前に
/// zero-fill 済みでこの関数が唯一の書き手なので加算ではなく代入で足りる。RT: alloc/lock/syscall
/// なし。`device_channels == 0` は cpal が返さない前提（既存コードも同じ前提で `hw.len() /
/// output_channels` を除算している）。
#[inline]
/// master.buffer（常に 2ch）を hw（デバイス幅）へ置く。**hw の全要素を書き切る**
/// （呼び出し側は事前の zero-fill をしない — RT ホットパスで二重に store しないため）。
pub(super) fn place_master_into_device(
    buf: &[f32],
    frames: usize,
    device_channels: usize,
    hw: &mut [f32],
) {
    match device_channels {
        0 => {}
        // mono デバイス: L+R を 0.5 でマージ（相関信号でクリップしない・設計 §2.2 Q-611-5 と同じ法則）。
        1 => {
            for frame in 0..frames {
                hw[frame] = (buf[frame * 2] + buf[frame * 2 + 1]) * 0.5;
            }
        }
        // 2ch は幅が一致するので memcpy 相当（O0-1/O0-2 の bit 一致はここで成立）。
        2 => hw[..frames * 2].copy_from_slice(&buf[..frames * 2]),
        // 3ch 以上: ch0/1 に置き、**余剰チャンネルはここで 0 にする**（Device 出口は master の
        // 1 本だけなので、残りは無音が正しい）。
        _ => {
            for frame in 0..frames {
                let base = frame * device_channels;
                hw[base] = buf[frame * 2];
                hw[base + 1] = buf[frame * 2 + 1];
                for extra in &mut hw[base + 2..base + device_channels] {
                    *extra = 0.0;
                }
            }
        }
    }
}

#[inline]
#[cfg(test)]
pub(super) fn render_engine_with_sources(
    engine: &Engine,
    link: &mut Option<LinkEgress>,
    buses: &mut [InsertBusStage],
    sources: &mut [SourceSlot],
    transport: &mut BlockTransport,
    output_channels: usize,
    hw: &mut [f32],
) {
    render_engine_with_sources_impl(
        engine,
        link,
        buses,
        sources,
        transport,
        output_channels,
        hw,
        None,
    );
}

#[allow(clippy::too_many_arguments)]
pub(super) fn render_engine_with_sources_impl(
    engine: &Engine,
    link: &mut Option<LinkEgress>,
    buses: &mut [InsertBusStage],
    sources: &mut [SourceSlot],
    transport: &mut BlockTransport,
    output_channels: usize,
    hw: &mut [f32],
    device: Option<&mut DeviceLineBuffer<'_>>,
) {
    let frames = hw.len() / output_channels;

    if sources.is_empty() {
        if buses.iter().any(|bus| bus.active.load(Ordering::Relaxed)) {
            render_engine_with_insert_buses_and_source_outputs(
                engine,
                link,
                buses,
                &[],
                &[],
                output_channels,
                hw,
                device,
            );
        } else {
            render_engine(engine, link, output_channels, hw);
        }
    } else {
        let rendered_units = render_sources(sources, frames, transport);
        if buses.iter().any(|bus| bus.active.load(Ordering::Relaxed)) {
            render_engine_with_insert_buses_and_source_outputs(
                engine,
                link,
                buses,
                sources,
                &rendered_units,
                output_channels,
                hw,
                device,
            );
        } else {
            render_engine_with_source_outputs(
                engine,
                link,
                sources,
                &rendered_units,
                output_channels,
                hw,
            );
        }
    }

    transport.cursor_frames = transport.cursor_frames.saturating_add(frames as u64);
}

pub(super) fn render_sources(
    sources: &mut [SourceSlot],
    frames: usize,
    transport: &BlockTransport,
) -> arrayvec::ArrayVec<usize, MAX_SOURCE_SLOTS> {
    use arrayvec::ArrayVec;

    debug_assert!(sources.len() <= MAX_SOURCE_SLOTS);
    let mut rendered_units = ArrayVec::new();
    for slot in sources.iter_mut().take(MAX_SOURCE_SLOTS) {
        let reported = slot.source.render(frames, transport);
        debug_assert!(reported <= MAX_SOURCE_UNITS);
        debug_assert!(reported <= slot.dests.len());
        rendered_units.push(reported.min(MAX_SOURCE_UNITS).min(slot.dests.len()));
    }
    rendered_units
}

pub(super) fn collect_source_feeds<'a>(
    sources: &'a [SourceSlot],
    rendered_units: &[usize],
    bus_positions: &[Option<usize>],
    block_samples: usize,
) -> arrayvec::ArrayVec<(&'a [f32], FeedDest), MAX_SOURCE_FEEDS> {
    use arrayvec::ArrayVec;

    let mut feeds = ArrayVec::new();
    for (slot, &unit_count) in sources.iter().zip(rendered_units) {
        for unit in 0..unit_count {
            let Some(output) = slot.source.output(unit).get(..block_samples) else {
                debug_assert!(false, "source output shorter than the callback block");
                continue;
            };
            let dest = match slot.dests[unit].load() {
                SourceDest::None => FeedDest::Discard,
                SourceDest::Master => FeedDest::Hardware,
                SourceDest::Bus(index) => bus_positions
                    .get(index)
                    .copied()
                    .flatten()
                    .map_or(FeedDest::Discard, FeedDest::Channel),
                // Link source routing is not wired yet. Missing wiring is silence, never Master.
                SourceDest::Link(_) => FeedDest::Discard,
            };
            if dest != FeedDest::Discard {
                feeds.push((output, dest));
            }
        }
    }
    feeds
}

#[inline]
#[cfg(test)]
pub(super) fn render_engine_with_insert_buses(
    engine: &Engine,
    link: &mut Option<LinkEgress>,
    buses: &mut [InsertBusStage],
    output_channels: usize,
    hw: &mut [f32],
) {
    render_engine_with_insert_buses_and_source_outputs(
        engine,
        link,
        buses,
        &[],
        &[],
        output_channels,
        hw,
        None,
    );
}

/// engine（+ LinkAudio egress）の render 本体。`link` が無い（hardware-only）なら従来通り
/// `engine.render`（ビット同一）。`link` 有りなら reg-ring を drain して channel pool を更新し、
/// **ready な channel のみ**を `render_multi` で hardware と一緒に 1 パスで埋め、各 channel buffer
/// を ring へ push する（egress）。ready が 0 でも `render_multi(hw, &[])` を呼ぶ（`engine.render`
/// に落とすと channel-tagged event が hardware に bleed するため）。
#[inline]
pub(super) fn render_engine(
    engine: &Engine,
    link: &mut Option<LinkEgress>,
    output_channels: usize,
    hw: &mut [f32],
) {
    use arrayvec::ArrayVec;

    let Some(le) = link else {
        // hardware-only。従来 render とビット同一。
        engine.render(hw);
        return;
    };

    // reg-ring を drain → 新 channel を pool へ追加（RT で alloc しない・scratch は control が事前確保）。
    // 同名は control の冪等 guard で来ないので既存 entry を drop しない（RT-safe）。cap は control が
    // 強制するので pool は MAX_LINK_CHANNELS を超えない。
    while let Ok(act) = le.reg_rx.pop() {
        le.channels.push(act);
    }

    let bs = (hw.len() / output_channels) * output_channels;

    // egress に乗せる条件（pass 1/2 で同一）: ready かつ scratch が block 以上。両 pass で同じ closure を
    // 使い **論理的な** divergence を防ぐ。ただし `ready` は consumer thread が concurrent に false→true
    // にするため、pass 1 の後に ready 化した channel は pass 2 のみに入りうる（その block は無音で commit・
    // 次 callback から正常）= benign。`bs` を capture するだけで `le.channels` は借用しない。
    let egress_active = |ch: &LinkChannelActivate| {
        channel_egress_active(ch.ready.load(Ordering::Relaxed), ch.scratch.len(), bs)
    };

    // pass 1: active な channel から render_multi 引数を per-callback stack ArrayVec で組む（heap alloc
    // なし）。借用は render_multi 呼び出しまでに閉じる。
    let mut chans: ArrayVec<(&str, &mut [f32]), MAX_LINK_CHANNELS> = ArrayVec::new();
    for ch in le.channels.iter_mut() {
        if !egress_active(ch) {
            // scratch は control が `MAX_BLOCK_FRAMES * channels`（device buffer より遥かに大）で事前
            // 確保する不変。ready なのに不足したら channel audio が出ないので dev で loud に検出
            // （not-ready は静かに skip・release は安全側で skip）。
            debug_assert!(
                !ch.ready.load(Ordering::Relaxed) || ch.scratch.len() >= bs,
                "link channel '{}' scratch ({}) < block ({bs})",
                ch.name,
                ch.scratch.len()
            );
            continue;
        }
        if chans
            .try_push((ch.name.as_str(), &mut ch.scratch[..bs]))
            .is_err()
        {
            // cap は control（`register_channel`）が `MAX_LINK_CHANNELS` で強制するので構造上到達不能。
            // ここに来たら control cap と callback ArrayVec 容量が drift した証拠 → dev で loud に
            // （release は安全側で残り channel を skip・RT で panic させない）。
            debug_assert!(
                false,
                "link channel pool exceeded ArrayVec cap {MAX_LINK_CHANNELS} (control cap drifted)"
            );
            break;
        }
    }
    engine.render_multi(hw, &mut chans);
    drop(chans); // ArrayVec の借用を閉じてから sink commit（scratch を再借用するため）。

    // pass 2: pass 1 と同一述語の active channel の buffer を ring へ push。
    for ch in le.channels.iter_mut() {
        if !egress_active(ch) {
            continue;
        }
        // 満杯なら RingTapSink が drop カウント（GPL consumer が produced-frames に算入し beat 維持）。
        ch.sink.commit(&ch.scratch[..bs]);
    }
}
