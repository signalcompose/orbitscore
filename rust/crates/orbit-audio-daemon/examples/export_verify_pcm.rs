//! phase 3 検証用 PCM エクスポーター（#313）。
//!
//! 3 つの fixture（per_event_gain / pan_three_voices / chop_region）について:
//! 1. `test-assets/verify-fixtures/<fixture>.schedule.json` をロードし
//!    `EngineWrap::play_at` でオフライン決定論レンダ（verify_schedule_pcm.rs と同経路）。
//! 2. stereo interleaved f32 を `test-assets/verify-fixtures/phase3/.gen/<fixture>.pcm`
//!    に生 LE バイト列（ヘッダ無し）でダンプ。
//! 3. onset / RMS / pan を自プリミティブで測定し
//!    `test-assets/verify-fixtures/phase3/<fixture>.rust.json` に書く。
//!
//! # README との対応
//! - 閾値 peak 基準: README の body-window peak を採用。
//!   指示文は「探索区間 peak」としているが、attack fade 無しの本レンダラでは
//!   body peak ≒ 探索区間 peak で差は出ない。探索区間 sub-capture で検出するのは
//!   「先行イベントへの誤マッチ回避」のため（いずれの基準でも必須）。
//!   README を正本とし、この選択をコメントで明記する。

use std::collections::HashMap;
use std::path::PathBuf;

use orbit_audio_daemon::backend::StubBackend;
use orbit_audio_daemon::engine_wrap::EngineWrap;
use orbit_audio_verify::{
    detect_onset_matched, detect_onset_threshold, pan_from_lr_rms, region_peak, region_rms,
    CapturedAudio,
};
use serde::{Deserialize, Serialize};

// ─── golden schedule の構造（verify_schedule_pcm.rs から複製）────────────────

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
    gain_db: f64,
    // panRaw は JSON に存在するが未使用。serde は未知フィールドを無視するため宣言しない。
    sequence_name: String,
}

// ─── 出力 JSON（artifact 契約 ②）────────────────────────────────────────────

/// artifact 契約 ②: `<fixture>.rust.json` のスキーマ。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RustMeasurement {
    fixture: String,
    sample_rate: u32,
    channels: u16,
    frames: usize,
    pcm_file: String,
    onset_threshold_ratio: f64,
    events: Vec<EventMeasurement>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct EventMeasurement {
    sequence_name: String,
    onset_sec: f64,
    onset_frame_scheduled: usize,
    onset_frame_threshold: Option<usize>,
    onset_frame_matched: Option<usize>,
    body_window: [usize; 2],
    l_rms: f32,
    r_rms: f32,
    mono_rms: f32,
    pan: f32,
    gain_db: f64,
}

// ─── ヘルパ ────────────────────────────────────────────────────────────────

/// リポジトリルートからの相対パスを絶対パスに変換する。
fn repo_path(rel: &str) -> PathBuf {
    // Cargo.toml が `rust/crates/orbit-audio-daemon/` にあるため 3 段上がる。
    PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../..")).join(rel)
}

/// 秒 → フレーム（四捨五入）。verify_schedule_pcm.rs の `frame_at` と同じ。
fn frame_at(sec: f64, sr: f64) -> usize {
    (sec * sr).round() as usize
}

/// イベントの再生尺フレーム。whole（durationSec=0）= サンプル全尺 / slice = durationSec フレーム。
fn play_span(ev: &GoldenEvent, sample_frames: &HashMap<String, usize>, sr: f64) -> usize {
    if ev.duration_sec > 0.0 {
        frame_at(ev.duration_sec, sr)
    } else {
        sample_frames[&ev.sample]
    }
}

/// body 窓 `[onset+BODY_HEAD_OFFSET, onset+span-tail_trim)`。
/// verify_schedule_pcm.rs の `body_window` と同じ（import 不可のため複製）。
fn body_window(onset: usize, span: usize, tail_trim: usize) -> (usize, usize) {
    (onset + BODY_HEAD_OFFSET, onset + span.saturating_sub(tail_trim))
}

/// stereo interleaved `cap.data` から mono mix `(L+R)/2` の `CapturedAudio` を生成。
fn make_mono(cap: &CapturedAudio) -> CapturedAudio {
    let frames = cap.frames();
    let mut mono_data = Vec::with_capacity(frames);
    for f in 0..frames {
        let l = cap.data[f * 2];
        let r = cap.data[f * 2 + 1];
        mono_data.push((l + r) / 2.0);
    }
    CapturedAudio::new(mono_data, 1, cap.sample_rate)
}

/// `[search_start, search_end)` の sub-`CapturedAudio`（mono 1ch）を切り出す。
/// onset 検出を先行イベントと重ならない区間に限定するために使う。
fn sub_mono(mono: &CapturedAudio, search_start: usize, search_end: usize) -> CapturedAudio {
    let end = search_end.min(mono.frames());
    let start = search_start.min(end);
    let data = mono.data[start..end].to_vec();
    CapturedAudio::new(data, 1, mono.sample_rate)
}

// ─── golden レンダ（verify_schedule_pcm.rs の `render_golden` と同経路）─────

/// golden schedule をオフラインレンダして stereo `CapturedAudio` とサンプル尺 map を返す。
fn render_golden(golden: &GoldenSchedule) -> (CapturedAudio, HashMap<String, usize>) {
    let (wrap, _guard) = EngineWrap::start_with(StubBackend {
        sample_rate: golden.sample_rate,
        channels: 2,
    })
    .expect("EngineWrap start_with StubBackend");

    // サンプル名 → (sample_id, frames)。重複ロード回避。
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

    // 各イベントを `play_at` でスケジュール（sec→frame / resolve_slice_region を通す）。
    let mut last_end_frame = 0usize;
    let sr = golden.sample_rate as f64;
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
        let end = frame_at(ev.onset_sec, sr) + play_span(ev, &sample_frames, sr);
        last_end_frame = last_end_frame.max(end);
    }

    let total_frames = last_end_frame + golden.sample_rate as usize / 4; // +0.25s 余白
    let data = wrap.render_offline(total_frames, BLOCK_FRAMES);
    (
        CapturedAudio::new(data, 2, golden.sample_rate),
        sample_frames,
    )
}

// ─── 1 fixture の処理 ─────────────────────────────────────────────────────

/// render の block 分割粒度（実 cpal callback の粒度を模す）。verify_schedule_pcm.rs と同値。
const BLOCK_FRAMES: usize = 512;
/// onset 閾値 = この比率 × body-window の mono peak（README 由来の校正値）。
const ONSET_THRESHOLD_RATIO: f64 = 0.3;
/// body 窓の先頭オフセット（onset 直後の block straddle を除外）。BODY_TAIL_TRIM と対で見直す。
const BODY_HEAD_OFFSET: usize = 256;
/// body 窓の末尾トリム（末尾 fade を除外）。attack fade 追加時は BODY_HEAD_OFFSET と同時に見直す。
const BODY_TAIL_TRIM: usize = 600;
/// onset 探索区間の先頭マージン（10ms @48k）。±96 frame 許容より広く取り先行イベント誤マッチを回避。
const ONSET_SEARCH_MARGIN: usize = 480;

fn process_fixture(fixture_name: &str) {
    // golden をロードしてレンダ。
    let path = repo_path(&format!(
        "test-assets/verify-fixtures/{fixture_name}.schedule.json"
    ));
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("golden JSON {} を読めない: {e}", path.display()));
    let golden: GoldenSchedule = serde_json::from_str(&raw).expect("golden JSON parse");

    let (cap, sample_frames) = render_golden(&golden);
    let sr = golden.sample_rate as f64;
    let frames = cap.frames();
    let channels: u16 = 2;

    // mono mix を一本作る（monoRms / onset で共有）。
    let mono = make_mono(&cap);

    // ─── PCM ダンプ ────────────────────────────────────────────────────────
    let gen_dir = repo_path("test-assets/verify-fixtures/phase3/.gen");
    std::fs::create_dir_all(&gen_dir)
        .unwrap_or_else(|e| panic!(".gen/ ディレクトリ作成失敗: {e}"));
    let pcm_path = gen_dir.join(format!("{fixture_name}.pcm"));
    // stereo interleaved data を little-endian f32 バイト列としてダンプ（ヘッダ無し）。
    let bytes: Vec<u8> = cap
        .data
        .iter()
        .flat_map(|&s| s.to_le_bytes())
        .collect();
    std::fs::write(&pcm_path, &bytes)
        .unwrap_or_else(|e| panic!("PCM 書き込み失敗 {}: {e}", pcm_path.display()));
    println!(
        "[{fixture_name}] PCM ダンプ: {} ({} bytes, {} frames)",
        pcm_path.display(),
        bytes.len(),
        frames
    );

    // ─── イベントごとの測定 ───────────────────────────────────────────────
    let n_events = golden.events.len();
    let mut event_measurements: Vec<EventMeasurement> = Vec::with_capacity(n_events);

    for (i, ev) in golden.events.iter().enumerate() {
        let onset_scheduled = frame_at(ev.onset_sec, sr);

        // body 窓（RMS 用）。
        let span = play_span(ev, &sample_frames, sr);
        let (w_start, w_end) = body_window(onset_scheduled, span, BODY_TAIL_TRIM);

        // L/R RMS → pan。
        let l_rms = region_rms(&cap, 0, w_start, w_end);
        let r_rms = region_rms(&cap, 1, w_start, w_end);
        let pan_measured = pan_from_lr_rms(l_rms, r_rms);

        // mono RMS（body 窓）。
        let mono_rms = region_rms(&mono, 0, w_start, w_end);

        // ─── onset 検出（threshold 法）────────────────────────────────
        // 探索区間: [onset_scheduled - 480, 次イベントの scheduled or frames)。
        // 先行イベントが先に当たるのを防ぐためイベントごとに区間を限定する。
        let search_start = onset_scheduled.saturating_sub(ONSET_SEARCH_MARGIN);
        let search_end = if i + 1 < n_events {
            frame_at(golden.events[i + 1].onset_sec, sr)
        } else {
            frames
        };
        let sub = sub_mono(&mono, search_start, search_end);

        // 閾値 = ONSET_THRESHOLD_RATIO × body-window の mono peak。
        // README の「body-window の peak」を正本として採用。
        // 指示文の「探索区間 peak」と定義が異なるが、attack fade 無しの本レンダラでは
        // body peak ≈ 探索区間 peak のため数値差は無視できる（README が校正の正本）。
        let body_peak = region_peak(&mono, 0, w_start, w_end);
        let threshold = ONSET_THRESHOLD_RATIO as f32 * body_peak;
        let onset_frame_threshold = detect_onset_threshold(&sub, 0, threshold)
            .map(|local_f| local_f + search_start);

        // ─── onset 検出（matched filter 法）──────────────────────────
        // matched filter の demo は per_event_gain 第1イベントのみ（他 fixture は threshold で
        // 十分なので意図的に追加しない）。template = onset 直後 BODY_HEAD_OFFSET frame を
        // mono 配列から直接切り出す（sub_mono でなく mono.data から）。
        let onset_frame_matched = if fixture_name == "per_event_gain" && i == 0 {
            let tmpl_end = (onset_scheduled + BODY_HEAD_OFFSET).min(mono.frames());
            let template: Vec<f32> = mono.data[onset_scheduled..tmpl_end].to_vec();
            detect_onset_matched(&mono.data, &template)
        } else {
            None
        };

        event_measurements.push(EventMeasurement {
            sequence_name: ev.sequence_name.clone(),
            onset_sec: ev.onset_sec,
            onset_frame_scheduled: onset_scheduled,
            onset_frame_threshold,
            onset_frame_matched,
            body_window: [w_start, w_end],
            l_rms,
            r_rms,
            mono_rms,
            pan: pan_measured,
            gain_db: ev.gain_db,
        });
    }

    // ─── JSON 書き出し ────────────────────────────────────────────────────
    let pcm_rel = format!(".gen/{fixture_name}.pcm");
    let measurement = RustMeasurement {
        fixture: fixture_name.to_string(),
        sample_rate: golden.sample_rate,
        channels,
        frames,
        pcm_file: pcm_rel,
        onset_threshold_ratio: ONSET_THRESHOLD_RATIO,
        events: event_measurements,
    };
    let json_str = serde_json::to_string_pretty(&measurement).expect("JSON シリアライズ失敗");
    let json_path = repo_path(&format!(
        "test-assets/verify-fixtures/phase3/{fixture_name}.rust.json"
    ));
    std::fs::write(&json_path, &json_str)
        .unwrap_or_else(|e| panic!("JSON 書き込み失敗 {}: {e}", json_path.display()));
    println!("[{fixture_name}] Rust 測定 JSON: {}", json_path.display());

    // ─── 目視確認用サマリ ─────────────────────────────────────────────────
    println!("[{fixture_name}] イベント測定値:");
    for em in &measurement.events {
        println!(
            "  seq={} onsetSched={} onsetThresh={:?} onsetMatched={:?} \
             bodyWindow=[{},{}] lRms={:.4} rRms={:.4} monoRms={:.4} pan={:.4} gainDb={}",
            em.sequence_name,
            em.onset_frame_scheduled,
            em.onset_frame_threshold,
            em.onset_frame_matched,
            em.body_window[0],
            em.body_window[1],
            em.l_rms,
            em.r_rms,
            em.mono_rms,
            em.pan,
            em.gain_db,
        );
    }
}

// ─── main ─────────────────────────────────────────────────────────────────

fn main() {
    for fixture in &["per_event_gain", "pan_three_voices", "chop_region"] {
        process_fixture(fixture);
    }
    println!("完了: 生 PCM 3 本 + Rust 測定 JSON 3 本を出力しました。");
}
