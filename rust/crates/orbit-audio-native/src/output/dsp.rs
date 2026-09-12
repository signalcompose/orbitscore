//! ゲイン / パン / 加算の DSP ヘルパー（#888 子 2・output.rs）。
//!
//! 🔴 **これは純粋な移動である。** `render.rs` から分けた。1 ファイルにまとめると
//! **812 コード行**で #888 の閾値 500 を超えるため（設計 §13.9 の制約 1）。

#[allow(unused_imports)]
use super::*;

#[inline]
pub(super) fn line_ramp(
    program: &LineProgram,
    op_index: usize,
    target: f32,
    frames: usize,
    ramp_frames: u32,
) -> LineRamp {
    let current_gain = &program.current_gain[op_index];
    let mut current = f32::from_bits(current_gain.load(Ordering::Relaxed));
    if current == target {
        return LineRamp::settled(target);
    }
    let ramp = advance_line_ramp(&mut current, target, frames, ramp_frames);
    current_gain.store(ramp.end.to_bits(), Ordering::Relaxed);
    ramp
}

#[inline]
pub(super) fn apply_ramped_gain(buf: &mut [f32], channels: usize, ramp: LineRamp) {
    if ramp.is_settled() {
        if ramp.end != 1.0 {
            for sample in buf {
                *sample *= ramp.end;
            }
        }
        return;
    }

    debug_assert!(channels > 0);
    for (sample_index, sample) in buf.iter_mut().enumerate() {
        *sample *= ramp.at(sample_index / channels);
    }
}

/// Return the normalized L/R coefficients for a bus-level pan.
///
/// 🔴 The `√2` is **not** an extra boost — it makes this stage unity at center.
///
/// The source side already applies `equal_power_pan` when it schedules an event
/// (`orbit_audio_core::scheduler`), so a centered event arrives here having been multiplied by
/// `(1/√2, 1/√2)`. Applying the raw equal-power law a second time would drop a further 3 dB, so
/// **writing `pan(0)` would make a score quieter than not writing it at all**. Scaling by `√2`
/// makes center `(1, 1)`, and hard-left `(√2, 0)` composes with the source-side center to `(1, 0)`
/// — the same as today's source-side hard left. The two stages compose to the original law for
/// every position.
///
/// Do not remove the factor as "double compensation": the compensation is what keeps this stage
/// transparent. The source side cannot drop its own center application without breaking bit
/// identity for existing scores (design `docs/design/611-o-surface-bundle-design.md` §4.1).
#[inline]
pub(super) fn line_pan_coefficients(pan: f32) -> (f32, f32) {
    // 中央は定義上ちょうど unity なので、乗算ごと省く（`/simplify` efficiency・2026-09-11）。
    //
    // 🔴 これは丸め誤差の除去でもある。f32 では `sqrt(2) * cos(pi/4) = 0.99999994` で
    // **1.0 ちょうどにならない**ため、省かないと `pan(0)` を書いた譜面が書かない譜面と
    // 6e-8 だけずれる。設計 §4.1 は「center で `(1, 1)`（unity）」と書いているので、
    // 省く方が**文書どおり**になる。`LineOp::Gain` が `gain != 1.0` で同じことをしている。
    if pan == 0.0 {
        return (1.0, 1.0);
    }
    let (left, right) = equal_power_pan(pan);
    (
        left * std::f32::consts::SQRT_2,
        right * std::f32::consts::SQRT_2,
    )
}

/// Apply a bus-level pan ramp to an interleaved stereo buffer.
#[inline]
pub(super) fn apply_line_pan(buf: &mut [f32], frames: usize, ramp: LineRamp) {
    if ramp.is_settled() {
        if ramp.end == 0.0 {
            return;
        }
        let (left, right) = line_pan_coefficients(ramp.end);
        for frame in 0..frames {
            let base = frame * ENGINE_CHANNELS;
            buf[base] *= left;
            buf[base + 1] *= right;
        }
        return;
    }

    if ramp.hold_after == 0 {
        return;
    }
    let (start_left, start_right) = line_pan_coefficients(ramp.start);
    let (end_left, end_right) = line_pan_coefficients(ramp.end);
    let coefficient_frames = ramp.hold_after as f32;
    let left_ramp = LineRamp {
        start: start_left,
        step: (end_left - start_left) / coefficient_frames,
        hold_after: ramp.hold_after,
        end: end_left,
    };
    let right_ramp = LineRamp {
        start: start_right,
        step: (end_right - start_right) / coefficient_frames,
        hold_after: ramp.hold_after,
        end: end_right,
    };
    for frame in 0..frames {
        let base = frame * ENGINE_CHANNELS;
        buf[base] *= left_ramp.at(frame);
        buf[base + 1] *= right_ramp.at(frame);
    }
}

#[inline]
pub(super) fn add_scaled(dst: &mut [f32], src: &[f32], gain: f32) {
    if gain == 1.0 {
        for (dst, src) in dst.iter_mut().zip(src) {
            *dst += *src;
        }
    } else {
        for (dst, src) in dst.iter_mut().zip(src) {
            *dst += *src * gain;
        }
    }
}

#[inline]
pub(super) fn add_ramped_scaled(dst: &mut [f32], src: &[f32], channels: usize, ramp: LineRamp) {
    if ramp.is_settled() {
        add_scaled(dst, src, ramp.end);
        return;
    }

    debug_assert!(channels > 0);
    for (sample_index, (dst, src)) in dst.iter_mut().zip(src).enumerate() {
        *dst += *src * ramp.at(sample_index / channels);
    }
}

pub(super) struct DeviceLineBuffer<'a> {
    pub(super) samples: &'a mut [f32],
    pub(super) channels: usize,
    pub(super) wrote: bool,
}

#[inline]
pub(super) fn add_to_device(
    device: &mut DeviceLineBuffer<'_>,
    src: &[f32],
    frames: usize,
    left: usize,
    right: Option<usize>,
    ramp: LineRamp,
) {
    if !device.wrote {
        device.samples.fill(0.0);
    }
    debug_assert!(left < device.channels);
    debug_assert!(right.is_none_or(|channel| channel < device.channels));
    if ramp.is_settled() {
        let gain = ramp.end;
        match right {
            Some(right) => {
                for frame in 0..frames {
                    let device_base = frame * device.channels;
                    let source_base = frame * ENGINE_CHANNELS;
                    if gain == 1.0 {
                        device.samples[device_base + left] += src[source_base];
                        device.samples[device_base + right] += src[source_base + 1];
                    } else {
                        device.samples[device_base + left] += src[source_base] * gain;
                        device.samples[device_base + right] += src[source_base + 1] * gain;
                    }
                }
            }
            None => {
                for frame in 0..frames {
                    let source_base = frame * ENGINE_CHANNELS;
                    let merged = (src[source_base] + src[source_base + 1]) * 0.5;
                    device.samples[frame * device.channels + left] +=
                        if gain == 1.0 { merged } else { merged * gain };
                }
            }
        }
        device.wrote = true;
        return;
    }

    match right {
        Some(right) => {
            for frame in 0..frames {
                let device_base = frame * device.channels;
                let source_base = frame * ENGINE_CHANNELS;
                let gain = ramp.at(frame);
                device.samples[device_base + left] += src[source_base] * gain;
                device.samples[device_base + right] += src[source_base + 1] * gain;
            }
        }
        None => {
            for frame in 0..frames {
                let source_base = frame * ENGINE_CHANNELS;
                let merged = (src[source_base] + src[source_base + 1]) * 0.5;
                device.samples[frame * device.channels + left] += merged * ramp.at(frame);
            }
        }
    }
    device.wrote = true;
}
