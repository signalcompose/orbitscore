//! #311 phase 2 tier(c) — Leg 1（renderer がスケジュールを忠実に再生するか）。
//!
//! TS 側（Leg 2）が interpreter の計算スケジュールを **production `toDaemonParams`** で解決し
//! commit した golden schedule JSON を読み込み、各イベントを実 `EngineWrap::play_at` で
//! オフライン決定論レンダ（`render_offline`）して、出力 PCM を phase-1 の analysis で検証する。
//!
//! これにより、phase-1（Scheduler 直接駆動）が飛ばした **`play_at` の sec→frame 変換 +
//! `resolve_slice_region`** を経た出力を、interpreter の意図したスケジュール通りに鳴っているか
//! として裏付ける。
//!
//! GRM 独立性: pan は L/R RMS から `atan2` で独立逆算（renderer は cos/sin）。**slice 領域は
//! golden の offsetSec/durationSec をそのまま `play_at` に渡し、Rust 側で再導出しない**。

use std::collections::HashMap;
use std::path::PathBuf;

use orbit_audio_daemon::engine_wrap::EngineWrap;
use orbit_audio_daemon::backend::StubBackend;
use orbit_audio_verify::{channel_rms, pan_from_lr_rms, region_rms, CapturedAudio, PAN_TOLERANCE};
use serde::Deserialize;

const BLOCK_FRAMES: usize = 512;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoldenSchedule {
    #[allow(dead_code)]
    fixture: String,
    sample_rate: u32,
    events: Vec<GoldenEvent>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoldenEvent {
    onset_sec: f64,
    sample: String,
    gain: f32,
    pan: f32,
    offset_sec: f64,
    duration_sec: f64,
    #[allow(dead_code)]
    gain_db: f64,
    #[allow(dead_code)]
    pan_raw: f64,
    #[allow(dead_code)]
    sequence_name: String,
}

fn repo_path(rel: &str) -> PathBuf {
    PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../..")).join(rel)
}

fn load_golden(fixture: &str) -> GoldenSchedule {
    let path = repo_path(&format!("test-assets/verify-fixtures/{fixture}.schedule.json"));
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("golden JSON {} を読めない: {e}", path.display()));
    serde_json::from_str(&raw).expect("golden JSON parse")
}

/// golden schedule をオフラインレンダして PCM を返す。各 sample をロードし、各イベントを
/// 実 `play_at` でスケジュールしてから `total_frames` 分 render する。
fn render_golden(golden: &GoldenSchedule) -> (CapturedAudio, HashMap<String, usize>) {
    let (wrap, _guard) = EngineWrap::start_with(StubBackend {
        sample_rate: golden.sample_rate,
        channels: 2,
    })
    .expect("EngineWrap start_with StubBackend");

    // sample 名 → (sample_id, frames)。重複ロードを避ける。
    let mut sample_ids: HashMap<String, String> = HashMap::new();
    let mut sample_frames: HashMap<String, usize> = HashMap::new();
    for ev in &golden.events {
        if sample_ids.contains_key(&ev.sample) {
            continue;
        }
        let wav = repo_path(&format!("test-assets/audio/{}", ev.sample));
        let info = wrap
            .load_sample(wav.clone())
            .unwrap_or_else(|e| panic!("load_sample {}: {e}", wav.display()));
        sample_frames.insert(ev.sample.clone(), info.frames);
        sample_ids.insert(ev.sample.clone(), info.sample_id);
    }

    // 各イベントを実 play_at でスケジュール（sec→frame / resolve_slice_region を通す）。
    let mut last_end_frame = 0usize;
    for ev in &golden.events {
        let sample_id = &sample_ids[&ev.sample];
        wrap.play_at(
            sample_id,
            ev.onset_sec,
            ev.gain,
            ev.pan,
            ev.offset_sec,
            ev.duration_sec,
        )
        .expect("play_at");
        // 出力尺の見積もり（whole=サンプル尺 / slice=duration_sec）。
        let play_frames = if ev.duration_sec > 0.0 {
            (ev.duration_sec * golden.sample_rate as f64).round() as usize
        } else {
            sample_frames[&ev.sample]
        };
        let end = (ev.onset_sec * golden.sample_rate as f64).round() as usize + play_frames;
        last_end_frame = last_end_frame.max(end);
    }

    let total_frames = last_end_frame + golden.sample_rate as usize / 4; // +0.25s 余白
    let data = wrap.render_offline(total_frames, BLOCK_FRAMES);
    (
        CapturedAudio::new(data, 2, golden.sample_rate),
        sample_frames,
    )
}

#[test]
fn pan_three_voices_render_matches_schedule() {
    let golden = load_golden("pan_three_voices");
    let (cap, sample_frames) = render_golden(&golden);
    let sr = golden.sample_rate as f64;

    for ev in &golden.events {
        let onset = (ev.onset_sec * sr).round() as usize;
        // whole-file 再生（duration_sec=0）。body 窓は onset 後 256 〜 末尾 fade 前。
        let play_frames = sample_frames[&ev.sample];
        let w_start = onset + 256;
        let w_end = onset + play_frames - 600; // 末尾 fade（≤384）+ 余裕を除外
        let l = region_rms(&cap, 0, w_start, w_end);
        let r = region_rms(&cap, 1, w_start, w_end);
        assert!(
            l.max(r) > 1e-3,
            "seq {} に信号が必要（L={l:.5}, R={r:.5}）",
            ev.sequence_name
        );
        // 出力 pan を atan2 で独立逆算し、スケジュールの pan と突き合わせる。
        let measured = pan_from_lr_rms(l, r);
        assert!(
            (measured - ev.pan).abs() <= PAN_TOLERANCE,
            "seq {}: schedule pan {} → measured {measured} (L={l:.5}, R={r:.5})",
            ev.sequence_name,
            ev.pan
        );
    }

    // イベント間（left 終端 0.6s 〜 mid 開始 2.1s の中央あたり）は無音。
    let gap = region_rms(&cap, 0, (1.0 * sr) as usize, (1.8 * sr) as usize);
    assert!(gap < 1e-5, "イベント間は無音のはず（RMS={gap:.6}）");
    // 公開 API の軽い疎通。
    let _ = channel_rms(&cap, 0);
}
