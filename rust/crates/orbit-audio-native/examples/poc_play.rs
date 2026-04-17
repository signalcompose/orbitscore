//! Issue #91 PoC: 複数サンプルをポリリズム的にスケジュールして再生する最小例。
//!
//! 使い方:
//!   cargo run --example poc_play -- <wav1> [<wav2> ...]
//!
//! WAV ファイルを 1 つ以上渡すと、それらを 500ms 間隔でラウンドロビンに
//! スケジュールし、約 5 秒間鳴らす。

use std::env;
use std::error::Error;
use std::thread;
use std::time::Duration;

use orbit_audio_native::{load_sample_resampled, start_default_output};

fn main() -> Result<(), Box<dyn Error>> {
    let paths: Vec<String> = env::args().skip(1).collect();
    if paths.is_empty() {
        eprintln!("usage: poc_play <wav1> [<wav2> ...]");
        std::process::exit(1);
    }

    // デバイス config に一致する Engine を自動構築
    let (engine, stream) = start_default_output()?;
    println!(
        "output stream: sr={}, ch={}",
        stream.sample_rate, stream.channels
    );

    // Project SR = 出力デバイスの SR。ソースが異なる場合は rubato でリサンプル。
    let samples = paths
        .iter()
        .map(|p| {
            println!("loading {p}");
            load_sample_resampled(p, stream.sample_rate)
        })
        .collect::<Result<Vec<_>, _>>()?;

    for (i, s) in samples.iter().enumerate() {
        println!(
            "  [{i}] sr={}, ch={}, frames={}, dur={:.3}s",
            s.sample_rate,
            s.channels,
            s.frames(),
            s.duration_secs()
        );
    }

    // 500ms 間隔で 10 回スケジュール（ラウンドロビン）
    for i in 0..10 {
        let sample = samples[i % samples.len()].clone();
        let when = 0.2 + (i as f64) * 0.5;
        engine.schedule(when, sample)?;
    }

    // 6 秒再生してから終了
    thread::sleep(Duration::from_secs(6));
    println!("done");
    Ok(())
}
