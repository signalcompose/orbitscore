//! Onset / 立ち上がり検出と末尾フェード線形性判定。
//!
//! ここも GRM 独立性の原則に従う純粋関数群。core レンダラの `equal_power_pan` /
//! `resolve_slice_region` を **import しない**。capture 経路を通す統合テストは
//! `tests/onset_fade_capture.rs` に分離し、合成フィクスチャで検証する。

use crate::capture::CapturedAudio;

/// 立ち上がり（onset）フレームをスカラー閾値で検出する。
///
/// チャンネル `ch` の先頭から走査し、`|sample| >= threshold_linear` を満たす
/// **最初のフレーム番号** を返す。一度も超えなければ `None`。
///
/// # 注意
/// 本レンダラは attack フェードを持たないため、スケジュール開始フレームから即座に
/// 定常振幅に達する。`threshold_linear` を body 振幅より低く設定すれば
/// 開始フレームをピンポイントで検出できる。
pub fn detect_onset_threshold(
    audio: &CapturedAudio,
    ch: usize,
    threshold_linear: f32,
) -> Option<usize> {
    let chs = audio.channels.max(1) as usize;
    if ch >= chs {
        return None;
    }
    (0..audio.frames()).find(|&f| audio.data[f * chs + ch].abs() >= threshold_linear)
}

/// マッチドフィルタ（交差相関）で `signal` 内の `template` の最適 lag を返す。
///
/// `signal` に対し `template` をスライドさせ、相関和が最大になる先頭オフセット
/// （= lag フレーム）を返す。整数フレーム精度（サブサンプル精度の放物線補間は
/// 将来拡張として残す）。
///
/// # 引数
/// * `signal` — 探索対象の 1ch 波形（呼び出し側でチャンネル抽出してから渡す）。
/// * `template` — 探すパターン。短い transient を推奨（持続 sine は自己相関が多峰
///   になりピーク位置が曖昧になるため不向き）。
///
/// # 戻り値
/// 相関最大の lag。`template` が空、または `signal.len() < template.len()` なら `None`。
///
/// # 将来拡張
/// サブサンプル精度が必要な場合は lag 近傍 3 点の放物線補間で実装できる（現在未実装）。
pub fn detect_onset_matched(signal: &[f32], template: &[f32]) -> Option<usize> {
    if template.is_empty() || signal.len() < template.len() {
        return None;
    }
    let lags = signal.len() - template.len() + 1;
    // 各 lag の相互相関を一度だけ計算してから最大を選ぶ。`max_by` 内で両被比較対象を
    // 都度計算する O(lags²·m) を O(lags·m) に落とし、「相関最大の lag を拾う」意図も
    // 読みやすくする。
    (0..lags)
        .map(|lag| {
            signal[lag..lag + template.len()]
                .iter()
                .zip(template.iter())
                .map(|(&s, &t)| s as f64 * t as f64)
                .sum::<f64>()
        })
        .enumerate()
        .max_by(|(_, a), (_, b)| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal))
        .map(|(lag, _)| lag)
}

/// エンベロープ列が **線形減衰** かどうかを最小二乗残差で判定する。
///
/// `envelope` は振幅の時系列（整流済み or 定数振幅 fixture の末尾窓 |値| 列）。
/// 本体レベルから ~0 へ（または終端値まで）線形に下るかを検証する。
///
/// # 判定方法
/// 最小二乗で 1 次回帰（y = a·x + b）をフィットし、残差の二乗平均平方根（RMSE）を
/// 本体振幅（先頭値）で正規化する。正規化 RMSE が `tolerance` 以下なら線形と判定。
///
/// 指数減衰（`y = A·r^x`）は対数領域では線形に見えるが振幅領域では非線形 →
/// 正規化 RMSE が大きくなり `false` を返す。
///
/// # 引数
/// * `envelope` — 振幅列（先頭ほど大きい下降列を想定）。
/// * `tolerance` — 正規化 RMSE の許容上限。`0.05`（5%）程度が目安。
///
/// # 戻り値
/// 線形と判定できれば `true`、指数的または不規則なら `false`。
/// `envelope` の長さが 2 未満または先頭値が 0 なら `false`（判定不能）。
pub fn fade_slope_is_linear(envelope: &[f32], tolerance: f32) -> bool {
    if envelope.len() < 2 {
        return false;
    }
    let first = envelope[0];
    if first == 0.0 {
        return false;
    }
    let n = envelope.len() as f64;
    // 1 次最小二乗: x = 0, 1, ..., n-1
    let sum_x: f64 = n * (n - 1.0) / 2.0;
    let sum_x2: f64 = n * (n - 1.0) * (2.0 * n - 1.0) / 6.0;
    let sum_y: f64 = envelope.iter().map(|&v| v as f64).sum();
    let sum_xy: f64 = envelope
        .iter()
        .enumerate()
        .map(|(i, &v)| i as f64 * v as f64)
        .sum();
    let denom = n * sum_x2 - sum_x * sum_x;
    if denom.abs() < f64::EPSILON {
        return false;
    }
    let a = (n * sum_xy - sum_x * sum_y) / denom;
    let b = (sum_y - a * sum_x) / n;
    // 残差の RMSE を先頭振幅（本体レベル）で正規化
    let mse: f64 = envelope
        .iter()
        .enumerate()
        .map(|(i, &v)| {
            let pred = a * i as f64 + b;
            let err = v as f64 - pred;
            err * err
        })
        .sum::<f64>()
        / n;
    let normalized_rmse = mse.sqrt() / first as f64;
    normalized_rmse <= tolerance as f64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::CapturedAudio;

    /// テスト用に `CapturedAudio` を直接構築するヘルパ。
    fn mk_captured(data: Vec<f32>, channels: u16) -> CapturedAudio {
        CapturedAudio::new(data, channels, 48_000)
    }

    // ─── detect_onset_threshold ───────────────────────────────────────────────

    /// 先頭 600 フレーム無音 → その後 1.0 が続く mono CapturedAudio。
    /// block 境界（512）をまたぐ位置 600 に onset があることを確認する。
    #[test]
    fn onset_threshold_detects_exact_frame_past_block_boundary() {
        let mut data = vec![0.0f32; 600];
        data.extend(vec![1.0f32; 200]);
        let cap = mk_captured(data, 1);
        // 閾値 0.5 → フレーム 600 で初めて超える
        assert_eq!(detect_onset_threshold(&cap, 0, 0.5), Some(600));
    }

    /// 全区間無音 → None を返す。
    #[test]
    fn onset_threshold_returns_none_on_silence() {
        let cap = mk_captured(vec![0.0f32; 200], 1);
        assert_eq!(detect_onset_threshold(&cap, 0, 0.5), None);
    }

    /// 負の振幅でも |sample| で判定するため検出できる。
    #[test]
    fn onset_threshold_detects_negative_transient() {
        let mut data = vec![0.0f32; 100];
        data.push(-0.8);
        data.extend(vec![0.0f32; 100]);
        let cap = mk_captured(data, 1);
        assert_eq!(detect_onset_threshold(&cap, 0, 0.5), Some(100));
    }

    /// 無効なチャンネル番号 → None。
    #[test]
    fn onset_threshold_invalid_channel_returns_none() {
        let cap = mk_captured(vec![1.0f32; 10], 1);
        assert_eq!(detect_onset_threshold(&cap, 1, 0.5), None);
    }

    // ─── detect_onset_matched ─────────────────────────────────────────────────

    /// 短い transient（バースト窓）を既知 lag に埋め込んだ signal で、正しい lag を返す。
    /// 持続 sine でなく短い bursts を使うのは自己相関の多峰回避のため。
    #[test]
    fn matched_filter_finds_embedded_transient_at_known_lag() {
        // template: 短い三角バースト [0.2, 0.8, 1.0, 0.8, 0.2]
        let template = vec![0.2f32, 0.8, 1.0, 0.8, 0.2];
        // signal: 先頭 300 フレーム 0、lag=300 から template を埋め込み
        let lag = 300usize;
        let mut signal = vec![0.0f32; lag];
        signal.extend_from_slice(&template);
        signal.extend(vec![0.0f32; 100]); // 末尾パディング
        assert_eq!(detect_onset_matched(&signal, &template), Some(lag));
    }

    /// template が空なら None。
    #[test]
    fn matched_filter_returns_none_for_empty_template() {
        let signal = vec![1.0f32; 100];
        assert_eq!(detect_onset_matched(&signal, &[]), None);
    }

    /// signal より template が長ければ None。
    #[test]
    fn matched_filter_returns_none_when_template_longer_than_signal() {
        let signal = vec![0.0f32; 3];
        let template = vec![0.0f32; 5];
        assert_eq!(detect_onset_matched(&signal, &template), None);
    }

    // ─── fade_slope_is_linear ─────────────────────────────────────────────────

    /// 線形ランプ [1.0, 0.75, 0.5, 0.25, 0.0] → true。
    #[test]
    fn linear_ramp_is_detected_as_linear() {
        let ramp = vec![1.0f32, 0.75, 0.5, 0.25, 0.0];
        assert!(fade_slope_is_linear(&ramp, 0.05));
    }

    /// 指数減衰 [1.0, 0.6, 0.36, 0.216, 0.1296, 0.0778] → false。
    #[test]
    fn exponential_decay_is_not_linear() {
        // base 0.6 の指数列（振幅領域では非線形）
        let exp_decay: Vec<f32> = (0..6).map(|i| 0.6f32.powi(i)).collect();
        assert!(!fade_slope_is_linear(&exp_decay, 0.05));
    }

    /// 長さ 1 以下では判定不能 → false。
    #[test]
    fn too_short_envelope_returns_false() {
        assert!(!fade_slope_is_linear(&[1.0], 0.05));
        assert!(!fade_slope_is_linear(&[], 0.05));
    }

    /// 先頭値 0 → false（正規化の分母がゼロ）。
    #[test]
    fn zero_amplitude_envelope_returns_false() {
        let ramp = vec![0.0f32, 0.0, 0.0];
        assert!(!fade_slope_is_linear(&ramp, 0.05));
    }
}
