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

use orbit_audio_core::sanitize_rate;
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
    /// varispeed レート（1.0 = 自然尺）。rate を持たない既存 golden は 1.0 として parse する。
    #[serde(default = "default_rate")]
    rate: f64,
    #[allow(dead_code)]
    gain_db: f64,
    #[allow(dead_code)]
    pan_raw: f64,
    #[allow(dead_code)]
    sequence_name: String,
}

fn default_rate() -> f64 {
    1.0
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
            ev.rate,
        )
        .expect("play_at");
        // 出力尺の見積もり（whole=サンプル尺 / slice=duration_sec）。varispeed では出力尺が
        // source 尺 / rate になるので、render 余白の確保にも rate を反映する。
        let sr = golden.sample_rate as f64;
        let source_frames = if ev.duration_sec > 0.0 {
            frame_at(ev.duration_sec, sr)
        } else {
            sample_frames[&ev.sample]
        };
        let play_frames = (source_frames as f64 / sanitize_rate(ev.rate)).ceil() as usize;
        let end = frame_at(ev.onset_sec, sr) + play_frames;
        last_end_frame = last_end_frame.max(end);
    }

    let total_frames = last_end_frame + golden.sample_rate as usize / 4; // +0.25s 余白
    let data = wrap.render_offline(total_frames, BLOCK_FRAMES);
    (
        CapturedAudio::new(data, 2, golden.sample_rate),
        sample_frames,
    )
}

/// 秒 → フレーム位置（四捨五入）。
fn frame_at(sec: f64, sr: f64) -> usize {
    (sec * sr).round() as usize
}

/// body 窓 `[onset+256, onset+span-tail_trim)`。onset 直後の block straddle と末尾 fade を
/// 除外する。`span` は再生尺フレーム（whole=サンプル尺 / slice=領域尺）、`tail_trim` は
/// fixture 固有の末尾除外幅（fade 尺に依存）。
fn body_window(onset: usize, span: usize, tail_trim: usize) -> (usize, usize) {
    (onset + 256, onset + span.saturating_sub(tail_trim))
}

#[test]
fn pan_three_voices_render_matches_schedule() {
    let golden = load_golden("pan_three_voices");
    let (cap, sample_frames) = render_golden(&golden);
    let sr = golden.sample_rate as f64;

    for ev in &golden.events {
        let onset = frame_at(ev.onset_sec, sr);
        // whole-file 再生（duration_sec=0）。body 窓は onset 後 256 〜 末尾 fade 前
        // （fade ≤384 + 余裕を除外）。
        let play_frames = sample_frames[&ev.sample];
        let (w_start, w_end) = body_window(onset, play_frames, 600);
        assert!(w_start < w_end, "pan body 窓が狭すぎる: [{w_start}, {w_end})");
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
        let onset = frame_at(ev.onset_sec, sr);
        // 信号確認: onset 後 256 〜 slice 終端 600 frame 前を本体窓とする。
        let slice_frames = frame_at(ev.duration_sec, sr);
        let (w_start, w_end) = body_window(onset, slice_frames, 600);
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
        let onset = frame_at(ev.onset_sec, sr);
        let play_frames = sample_frames[&ev.sample];
        // kick 0.5s も fade は最大 384 frames（min(0.5*0.04, 0.008)*48000）なので pan と同じ
        // 600 で除外する。dB 差は fade 不変だが、窓に fade を混ぜないよう揃える。
        let (w_start, w_end) = body_window(onset, play_frames, 600);
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

    // イベント間（loud 終端 0.6s 〜 quiet 開始 3.1s の 1.0〜2.5s）は無音。両イベントが
    // 誤って onset=0 にレンダされる回帰（加算 RMS になり dB 差が崩れる）を捕まえる。
    let gap = region_rms(&cap, 0, (1.0 * sr) as usize, (2.5 * sr) as usize);
    assert!(gap < 1e-5, "per_event_gain イベント間は無音のはず（RMS={gap:.6}）");
}

#[test]
fn examples22_parity_render_matches_schedule() {
    //! #316 Leg 1 — examples/22 (#304 dog-food) を de-overlap した parity fixture。
    //! kick(pan -0.6)/snare(+0.6)/hat(0)/chopd(+0.2・chop(2) slice1+slice2) を per-event 検証。
    //! 各イベントは無音で分離 → L/R RMS が単一 voice になり pan を atan2 で独立逆算できる。
    //! gain 値（-3/-6/-9/-4）は **異なるサンプル間で RMS 比較できない**（固有レベルが違う）ので
    //! ここでは検証しない。gain は Leg 2（schedule の gainDb/linear）+ phase-2 per_event_gain
    //! （同一サンプルの dB 差を実レンダで）でカバー済み。ここは pan / 領域 / 分離を見る。
    //! slice の「領域内容」正しさ（slice2 が arpeggio 後半 frame を読むか）は本テストでなく
    //! orbit-audio-verify の chop_region_real_wav.rs（ramp サンプルで offset+local を frame 単位
    //! 検証）が担う。ここは領域に信号があり外が無音であることまで。
    let golden = load_golden("examples22_parity");
    assert_eq!(
        golden.events.len(),
        5,
        "examples22_parity は 5 イベントのはず (kick/snare/hat/chopd×2)"
    );
    let (cap, sample_frames) = render_golden(&golden);
    let sr = golden.sample_rate as f64;

    for ev in &golden.events {
        let onset = frame_at(ev.onset_sec, sr);
        // span: whole(durationSec=0) = サンプル全尺 / slice = durationSec フレーム。
        let span = if ev.duration_sec > 0.0 {
            frame_at(ev.duration_sec, sr)
        } else {
            sample_frames[&ev.sample]
        };
        // 末尾 trim は既存 fixture と同じ固定 600（fade ≤384 + 余裕を除外）。最短の
        // hat(0.05s=2400fr)でも窓は [onset+256, onset+1800) = 1544fr 幅で潰れない。
        let (w_start, w_end) = body_window(onset, span, 600);
        assert!(
            w_start < w_end,
            "seq {} の body 窓が狭すぎる: [{w_start}, {w_end})",
            ev.sequence_name
        );
        let l = region_rms(&cap, 0, w_start, w_end);
        let r = region_rms(&cap, 1, w_start, w_end);
        assert!(
            l.max(r) > 1e-3,
            "seq {} に信号が必要（L={l:.5}, R={r:.5}）",
            ev.sequence_name
        );
        // 出力 pan を atan2 で独立逆算し schedule の pan と突き合わせる（GRM 独立）。
        let measured = pan_from_lr_rms(l, r);
        assert!(
            (measured - ev.pan as f32).abs() <= PAN_TOLERANCE,
            "seq {}: schedule pan {} → measured {measured} (L={l:.5}, R={r:.5})",
            ev.sequence_name,
            ev.pan
        );
    }

    // イベント間の無音（分離の裏付け）。kick[0.1,0.6]/snare[2.1,2.3]/hat[4.1,4.15]/
    // chopd slice1[6.1,6.6]/slice2[7.1,7.6] の隙間を各 ch で確認する。
    for (gap_start, gap_end) in [(1.0, 1.8), (3.0, 3.8), (5.0, 5.8), (6.7, 7.0)] {
        let gs = (gap_start * sr) as usize;
        let ge = (gap_end * sr) as usize;
        let gap = region_rms(&cap, 0, gs, ge).max(region_rms(&cap, 1, gs, ge));
        assert!(
            gap < 1e-5,
            "examples22 イベント間 {gap_start}-{gap_end}s は無音のはず（RMS={gap:.6}）"
        );
    }
}

const VARISPEED_SR: u32 = 48_000;

/// arpeggio_c.wav の `[0, 0.5s]` slice を指定 `rate` で offline render し PCM を返す。
/// `engine_wrap` の出力尺 `effective_len_frames / sr / rate` と `play_at`→scheduler の
/// varispeed seam を rate≠1.0 で実際に通す（#319 統合検証）。
fn render_varispeed_slice(rate: f64) -> Vec<f32> {
    let (wrap, _guard) = EngineWrap::start_with(StubBackend {
        sample_rate: VARISPEED_SR,
        channels: 2,
    })
    .expect("EngineWrap start_with StubBackend");
    let wav = repo_path("test-assets/audio/arpeggio_c.wav");
    let info = wrap
        .load_sample(wav.clone())
        .unwrap_or_else(|e| panic!("load_sample {}: {e}", wav.display()));
    assert!(
        info.frames as f64 / VARISPEED_SR as f64 >= 0.5,
        "arpeggio_c.wav は >=0.5s 必要（frames={}）",
        info.frames
    );
    // slice [0, 0.5s]（offset=0, duration=0.5）を指定 rate で発音。
    wrap.play_at(&info.sample_id, 0.0, 1.0, 0.0, 0.0, 0.5, rate)
        .expect("play_at");
    // rate=1.0 の出力尺 0.5s + 0.25s 余白。rate=2.0 はこれより短く収まる。
    let total = (0.75 * VARISPEED_SR as f64) as usize;
    wrap.render_offline(total, BLOCK_FRAMES)
}

/// interleaved stereo PCM の、|sample| が閾値を超える最後のフレーム index（信号終端）。
/// 無信号なら 0。GRM 独立: core の領域解決を import せず peak で直接測る。
fn last_signal_frame(pcm: &[f32]) -> usize {
    let channels = 2usize;
    let frames = pcm.len() / channels;
    let threshold = 0.01f32;
    for f in (0..frames).rev() {
        let l = pcm[f * channels].abs();
        let r = pcm[f * channels + 1].abs();
        if l.max(r) > threshold {
            return f;
        }
    }
    0
}

#[test]
fn varispeed_rate2_renders_half_duration_of_rate1() {
    //! #319 — varispeed の統合検証。同一 slice [0,0.5s] を rate=1.0 と rate=2.0 で実 `play_at`→
    //! offline render し、rate=2.0 の信号終端が rate=1.0 の **約半分**の時刻に来ることを PCM 上で
    //! 確認する（slice 尺をスロット尺へ詰める varispeed の「尺合わせ再生」の直接証拠）。
    //! 信号終端比 ≈ rate 比なので source の中身に依らず成立する（端の沈黙にも頑健）。
    let rate1_end = last_signal_frame(&render_varispeed_slice(1.0));
    let rate2_end = last_signal_frame(&render_varispeed_slice(2.0));

    assert!(
        rate1_end > 0 && rate2_end > 0,
        "両 rate とも信号が必要（無音回帰検出）: rate1_end={rate1_end}, rate2_end={rate2_end}"
    );
    // rate=2.0 は半分の尺で読み切る。比は理論上 2.0、fade tail / 閾値交差の余裕で ±8%。
    let ratio = rate1_end as f64 / rate2_end as f64;
    assert!(
        (ratio - 2.0).abs() < 0.16,
        "rate=2.0 は rate=1.0 の約半尺のはず: rate1_end={rate1_end}, rate2_end={rate2_end}, ratio={ratio:.3}"
    );
}
