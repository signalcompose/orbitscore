//! Sample: インターリーブ PCM バッファを保持する値型。

use std::sync::Arc;

/// 1 つの音声ファイル（またはメモリ上のバッファ）を表す。
///
/// データは interleaved f32 で保持。`Arc` で共有するため、複数の
/// スケジュール済みサンプルが同じバッファをゼロコピーで参照できる。
#[derive(Debug, Clone)]
pub struct Sample {
    /// インターリーブされた PCM サンプル（channel 数が 2 なら L, R, L, R, ...）
    pub data: Arc<Vec<f32>>,
    /// サンプリングレート（Hz）
    pub sample_rate: u32,
    /// チャンネル数（モノラル=1, ステレオ=2）
    pub channels: u16,
}

impl Sample {
    pub fn new(data: Vec<f32>, sample_rate: u32, channels: u16) -> Self {
        Self {
            data: Arc::new(data),
            sample_rate,
            channels,
        }
    }

    /// フレーム数（channels を剥がした時間軸の長さ）
    pub fn frames(&self) -> usize {
        self.data.len() / self.channels.max(1) as usize
    }

    /// サンプルの総再生時間（秒）
    pub fn duration_secs(&self) -> f64 {
        self.frames() as f64 / self.sample_rate as f64
    }
}
