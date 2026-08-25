//! #364 capture seam — realtime 経路の耳なし検証（gated・実 output device 要）。
//!
//! offline harness（`verify_schedule_pcm.rs`）が StubBackend + `render_offline` で parity を
//! 決定論検証するのに対し、本 harness は **実 cpal stream（`EngineWrap::start`）を実時間で回し、
//! `ORBIT_CAPTURE_WAV` で master 出力（render_block の post 後 `hw`）を WAV に録って**、同じ
//! `orbit-audio-verify` 解析プリミティブで #304（examples/22 の pan / slice / per-slice gain）を
//! 遡及的に自己検証する。これで「scheduler→daemon→device→実サンプル」の実時間経路が耳なしで
//! 回帰検証できる（cutover #108 の load-bearing・spec §6）。
//!
//! # 実行
//! ```text
//! cargo test -p orbit-audio-daemon --test capture_realtime_gated -- --ignored --nocapture
//! ```
//! 実 output device が要る（CI/sandbox には無いことがある）ので `#[ignore]`。短時間スピーカーから
//! 音が出る。
//!
//! # 検証の要点
//! - **`drops == 0`**: off-thread writer が ring から取りこぼしていない（録音が破損していない）
//!   ことを teardown 前に assert する（silent-failure ガード）。`> 0` なら検証 invalid。
//! - capture は render_block の `hw`（OS ボリューム/ハード前）をタップするので、録音レベルは
//!   システム音量に非依存で offline render と数値的にほぼ一致する。timing だけ device 起動 latency で
//!   ずれるので、**検出した最初の onset フレームにアンカー**して相対位置で窓を取る。

use std::io::Read;
use std::path::PathBuf;
use std::time::Duration;

use orbit_audio_daemon::engine_wrap::EngineWrap;
use orbit_audio_verify::{
    detect_onset_threshold, pan_from_lr_rms, region_rms, CapturedAudio, PAN_TOLERANCE,
};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoldenSchedule {
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
    #[serde(default = "default_rate")]
    rate: f64,
    /// 厳密 gain 検証は offline `per_event_gain` fixture が担保するので realtime では未使用。
    #[allow(dead_code)]
    gain_db: f64,
    #[allow(dead_code)]
    pan_raw: f64,
    sequence_name: String,
}

fn default_rate() -> f64 {
    1.0
}

fn repo_path(rel: &str) -> PathBuf {
    PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../..")).join(rel)
}

fn load_golden(fixture: &str) -> GoldenSchedule {
    let path = repo_path(&format!(
        "test-assets/verify-fixtures/{fixture}.schedule.json"
    ));
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("golden JSON {} を読めない: {e}", path.display()));
    serde_json::from_str(&raw).expect("golden JSON parse")
}

/// IEEE-float WAV を interleaved f32 の [`CapturedAudio`] にロードする（本 seam の `RiffWavWriter`
/// が書いた 44-byte header + f32 data という前提で最小 parse する）。
fn load_wav(path: &PathBuf) -> CapturedAudio {
    let mut buf = Vec::new();
    std::fs::File::open(path)
        .unwrap_or_else(|e| panic!("capture WAV {} を開けない: {e}", path.display()))
        .read_to_end(&mut buf)
        .expect("read capture WAV");
    assert!(
        buf.len() >= 44,
        "WAV header が短すぎる: {} bytes",
        buf.len()
    );
    assert_eq!(&buf[0..4], b"RIFF", "RIFF magic");
    assert_eq!(&buf[8..12], b"WAVE", "WAVE magic");
    let audio_format = u16::from_le_bytes(buf[20..22].try_into().unwrap());
    assert_eq!(audio_format, 3, "audioFormat は IEEE_FLOAT(3) のはず");
    let channels = u16::from_le_bytes(buf[22..24].try_into().unwrap());
    let sample_rate = u32::from_le_bytes(buf[24..28].try_into().unwrap());
    let bits = u16::from_le_bytes(buf[34..36].try_into().unwrap());
    assert_eq!(bits, 32, "bitsPerSample は 32 のはず");
    assert!(channels >= 1 && sample_rate > 0, "format が不正");

    let body = &buf[44..];
    // data チャンク size（bytes 40..44）を物理サイズと突き合わせる（silent-failure ガード）:
    // finalize の header patch が失敗（teardown 時の disk full 等）すると placeholder(0)のまま
    // 残るが、PCM 本体は物理的に存在するので、これを検証しないと壊れた WAV でも PCM assert が
    // 通り偽 parity になる。header と物理長の不一致を loud に落とす。
    let data_bytes = u32::from_le_bytes(buf[40..44].try_into().unwrap()) as usize;
    assert_eq!(
        data_bytes,
        body.len(),
        "WAV data chunk size ({data_bytes}) が物理 body 長 ({}) と不一致 = finalize 失敗による \
         header 破損（録音 invalid）",
        body.len()
    );
    let data: Vec<f32> = body
        .as_chunks::<4>()
        .0
        .iter()
        .map(|c| f32::from_le_bytes(*c))
        .collect();
    CapturedAudio::new(data, channels, sample_rate)
}

fn frame_at(sec: f64, sr: f64) -> usize {
    (sec * sr).round() as usize
}

/// body 窓 `[center+256, center+span-tail_trim)`（offline harness と同じ・onset 直後の block
/// straddle と末尾 fade を除外）。
fn body_window(center: usize, span: usize, tail_trim: usize) -> (usize, usize) {
    (center + 256, center + span.saturating_sub(tail_trim))
}

#[test]
#[ignore = "needs a real audio output device; run with --ignored (plays ~8s of audio)"]
fn examples22_realtime_capture_matches_schedule() {
    let golden = load_golden("examples22_parity");

    // capture 先を一意な temp path に。ORBIT_CAPTURE_WAV は start_output_inner が start 時に読む。
    let wav_path = std::env::temp_dir().join(format!(
        "orbit-capture-realtime-{}-{}.wav",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::env::set_var("ORBIT_CAPTURE_WAV", &wav_path);

    // 実 output device で起動（capture tap は env 経由で有効化される）。
    let (wrap, guard) = EngineWrap::start().expect("EngineWrap::start（実 output device 要）");

    // callback が tick して transport が進むまで待つ（headless で callback が来ない env なら fail）。
    let mut spins = 0;
    let base = loop {
        if let Some(now) = wrap.now_sec() {
            if now > 0.02 {
                break now + 0.5; // 0.5s のリードで未来にスケジュール。
            }
        }
        std::thread::sleep(Duration::from_millis(20));
        spins += 1;
        assert!(
            spins < 200,
            "callback が tick しない（実 device で callback 未達）"
        );
    };

    // 各イベントを実 play_at で未来（base + onset）にスケジュール。sample を必要分だけロード。
    let mut sample_frames = std::collections::HashMap::new();
    let mut sample_ids = std::collections::HashMap::new();
    for ev in &golden.events {
        if !sample_ids.contains_key(&ev.sample) {
            let wav = repo_path(&format!("test-assets/audio/{}", ev.sample));
            let info = wrap
                .load_sample(wav.clone())
                .unwrap_or_else(|e| panic!("load_sample {}: {e}", wav.display()));
            sample_frames.insert(ev.sample.clone(), info.frames);
            sample_ids.insert(ev.sample.clone(), info.sample_id);
        }
        wrap.play_at(
            &sample_ids[&ev.sample],
            base + ev.onset_sec,
            ev.gain,
            ev.pan,
            ev.offset_sec,
            ev.duration_sec,
            ev.rate,
            None,
        )
        .expect("play_at");
    }

    // 最後のイベント終端（+ 余白）まで実時間で待つ。
    let last_end = golden
        .events
        .iter()
        .map(|ev| {
            let dur = if ev.duration_sec > 0.0 {
                ev.duration_sec
            } else {
                // whole-file: サンプル尺（frames / 48000 概算・余白に十分）。
                sample_frames[&ev.sample] as f64 / 48_000.0
            };
            ev.onset_sec + dur
        })
        .fold(0.0f64, f64::max);
    // base 起点で last_end 経過 + 0.6s 余白まで sleep。
    std::thread::sleep(Duration::from_secs_f64(last_end + 0.6 + 0.5));

    // teardown 前に drops を assert（silent-failure ガード）。
    let drops = guard.capture_drops();
    assert_eq!(
        drops,
        Some(0),
        "capture drop が発生（録音破損＝検証 invalid）: {drops:?}"
    );

    // guard を drop すると stream 停止 → writer が ring 残りを drain → WAV finalize。
    drop(guard);
    drop(wrap);
    std::env::remove_var("ORBIT_CAPTURE_WAV");

    // 録った WAV をロードして parity を検証。
    let cap = load_wav(&wav_path);
    let sr = cap.sample_rate as f64;
    assert_eq!(cap.channels, 2, "stereo 出力のはず");
    assert!(
        cap.frames() as f64 / sr >= last_end,
        "capture 尺が短い（{:.2}s < 期待 {:.2}s）",
        cap.frames() as f64 / sr,
        last_end
    );

    // 最初の onset（kick @ base+0.1・pan -0.6 で L 優勢）を検出してアンカーにする。device 起動
    // latency で WAV 先頭が transport 0 とずれるので、これを基準に各イベントの相対位置を取る。
    let anchor =
        detect_onset_threshold(&cap, 0, 1e-3).expect("capture が無音（実出力が録れていない）");
    let first_onset_sec = golden.events[0].onset_sec;

    // 各イベントの pan を独立逆算し schedule と突き合わせる（offline harness と同じ判定）。slice
    // イベント（chopd×2・duration_sec>0）もこのループで「領域に信号あり + pan 一致」を確認するので、
    // pan / slice 領域再生の realtime parity をまとめてカバーする。per-event の厳密 gain dB 差は
    // 同一サンプルを使う offline `per_event_gain` fixture が担保する（examples22 は voice ごとに
    // サンプルが違い、2つの chop は同 gain だが領域が違うので RMS 直接比較はできない）。
    for ev in &golden.events {
        // アンカーからの相対位置（kick を 0 とした delta）。
        let rel = ev.onset_sec - first_onset_sec;
        let center = anchor + frame_at(rel, sr);
        let span = if ev.duration_sec > 0.0 {
            frame_at(ev.duration_sec, sr)
        } else {
            sample_frames[&ev.sample]
        };
        let (w0, w1) = body_window(center, span, 700);
        assert!(w0 < w1 && w1 <= cap.frames(), "窓が不正: [{w0}, {w1})");

        let l = region_rms(&cap, 0, w0, w1);
        let r = region_rms(&cap, 1, w0, w1);
        assert!(
            l.max(r) > 1e-3,
            "seq {} の窓に信号が必要（L={l:.5}, R={r:.5}）",
            ev.sequence_name
        );
        let measured = pan_from_lr_rms(l, r);
        assert!(
            (measured - ev.pan).abs() <= PAN_TOLERANCE,
            "seq {}: schedule pan {} → measured {measured}（L={l:.5}, R={r:.5}）",
            ev.sequence_name,
            ev.pan
        );
    }

    // イベント間（kick 終端〜snare 開始の中央 1.1s あたり）は無音。
    let gap0 = anchor + frame_at(1.0, sr);
    let gap1 = anchor + frame_at(1.8, sr);
    let gap = region_rms(&cap, 0, gap0, gap1);
    assert!(gap < 1e-4, "イベント間は無音のはず（RMS={gap:.6}）");

    let _ = std::fs::remove_file(&wav_path);
}
