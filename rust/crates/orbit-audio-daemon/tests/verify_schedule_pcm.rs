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
use orbit_audio_verify::{
    channel_rms, db_difference, pan_from_lr_rms, region_rms, CapturedAudio, GAIN_DB_TOLERANCE,
    PAN_TOLERANCE,
};
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

#[test]
fn chop_region_render_matches_schedule() {
    //! Leg 1 — chop_region。
    //! golden: arpeggio_c.wav 1.0s / chop(2) / tempo 120 / 4拍 / length 1。
    //!   slice1: onset=0.1s, offset=0.0s, duration=0.5s（前半）
    //!   slice2: onset=1.1s, offset=0.5s, duration=0.5s（後半）
    //! 各 slice 窓 [onset, onset+durationSec] に信号あり。
    //! イベント間（slice1 終端 0.6s 〜 slice2 開始 1.1s の中央 0.85s あたり）は無音。
    let golden = load_golden("chop_region");
    let (cap, _sample_frames) = render_golden(&golden);
    let sr = golden.sample_rate as f64;

    for ev in &golden.events {
        // slice 領域: [onset, onset+durationSec]（durationSec > 0 = slice）。
        assert!(ev.duration_sec > 0.0, "chop fixture は slice を持つはず");
        let onset = (ev.onset_sec * sr).round() as usize;
        // 信号確認: onset 後 256 frame 〜 slice 終端 600 frame 前を本体窓とする。
        let slice_end = onset + (ev.duration_sec * sr).round() as usize;
        let w_start = onset + 256;
        let w_end = slice_end.saturating_sub(600);
        assert!(w_start < w_end, "slice 窓が狭すぎる: [{w_start}, {w_end})");
        // pan=0 → L/R ほぼ等しい。少なくとも max(L,R) > 1e-3 を確認。
        let l = region_rms(&cap, 0, w_start, w_end);
        let r = region_rms(&cap, 1, w_start, w_end);
        assert!(
            l.max(r) > 1e-3,
            "onset={:.3}s の slice 窓に信号が必要（L={l:.5}, R={r:.5}）",
            ev.onset_sec
        );
    }

    // イベント間（slice1 終端 0.6s 〜 slice2 開始 1.1s の中央 0.85s）は無音。
    let gap_start = (0.65 * sr) as usize;
    let gap_end   = (0.95 * sr) as usize;
    let gap = region_rms(&cap, 0, gap_start, gap_end);
    assert!(gap < 1e-5, "chop イベント間は無音のはず（RMS={gap:.6}）");
}

#[test]
fn per_event_gain_render_matches_schedule() {
    //! Leg 1 — per_event_gain。
    //! golden: kick.wav 0.5s / slice 無し / tempo 60 / 4拍 / length 1。
    //!   loud : onset=0.1s, gainDb=-3, pan=0（中央）
    //!   quiet: onset=3.1s, gainDb=-9, pan=0（中央）
    //! 期待 dB 差 = -9 - (-3) = -6.0 dB（quiet が loud より 6dB 小さい）。
    let golden = load_golden("per_event_gain");
    let (cap, sample_frames) = render_golden(&golden);
    let sr = golden.sample_rate as f64;

    // 各イベントの body 窓 RMS を取得（gainDb 昇順に並んでいるとは限らないので gain_db で判別）。
    assert_eq!(golden.events.len(), 2, "per_event_gain は 2 イベントのはず");
    let mut rms_by_gain: Vec<(f64, f32)> = Vec::new(); // (gainDb, rms)

    for ev in &golden.events {
        let onset = (ev.onset_sec * sr).round() as usize;
        let play_frames = sample_frames[&ev.sample];
        let w_start = onset + 256;
        let w_end = onset + play_frames - 256; // kick は短いので余裕を小さく
        assert!(w_start < w_end, "onset={:.3}s の body 窓が狭すぎる", ev.onset_sec);
        let l = region_rms(&cap, 0, w_start, w_end);
        let r = region_rms(&cap, 1, w_start, w_end);
        // pan=0 → L/R ほぼ等しい。平均 RMS を使う。
        let rms = (l + r) / 2.0;
        assert!(rms > 1e-4, "onset={:.3}s に信号が必要（RMS={rms:.5}）", ev.onset_sec);
        rms_by_gain.push((ev.gain_db, rms));
    }

    // gainDb で並べて loud(-3) / quiet(-9) を識別する。
    rms_by_gain.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap()); // 降順 = loud first
    let rms_loud  = rms_by_gain[0].1;
    let rms_quiet = rms_by_gain[1].1;

    // db_difference(quiet, loud) = 20*log10(quiet/loud) ≈ -6.0 dB。
    let measured_diff = db_difference(rms_quiet, rms_loud);
    let expected_diff = -6.0_f32; // -9 - (-3) = -6 dB
    assert!(
        (measured_diff - expected_diff).abs() <= GAIN_DB_TOLERANCE,
        "quiet/loud の dB 差: 期待 {expected_diff:.1} dB、計測 {measured_diff:.2} dB \
         (rms_loud={rms_loud:.5}, rms_quiet={rms_quiet:.5})"
    );
}
