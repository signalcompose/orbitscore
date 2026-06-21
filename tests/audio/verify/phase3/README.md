# Audio verification phase 3 — measurement primitives ↔ librosa (blind cross-check)

Issue #313（親 harness epic #307・研究記録 #308 / `docs/research/AUDIO_OUTPUT_VERIFICATION.md` §4.2/§4.4）。

## 目的

phase 1（#307/PR#310）・phase 2（#311/PR#312）の tier-c 検証が信頼してきた**測定プリミティブ**
（`orbit-audio-verify`: `region_rms` / `pan_from_lr_rms` / `detect_onset_threshold` / `detect_onset_matched`）
を、独立 MIR ツール **librosa**（別実装の oracle）と同一 PCM 上で突き合わせ、**プリミティブ層で
GRM 独立性を成立させる**（差分検証）。これまでプリミティブは Rust 単体テスト（既知アンカー値）でしか
裏付けがなく、誰も独立ツールと突き合わせていなかった。

## 独立性の質を正直に書き分ける（重要）

3 つのプリミティブは「独立性の質」が異なる。記録ではこれを混同しない。

| プリミティブ | 突き合わせ相手 | 独立性の質 | 捕まえるもの |
|---|---|---|---|
| **onset threshold**（本丸） | librosa spectral-flux peak-picking (`onset.onset_detect`) | **アルゴリズム独立** | 真の差分（別アルゴリズム）。検出位置の系統ずれ・取りこぼし |
| **onset matched** (`detect_onset_matched`) | scheduled 真値（librosa ではない） | **真値整合**（algorithm/impl 独立ではない） | matched-filter が真値からずれていないかの consistency。出力イベントのみ |
| **level** (`region_rms`) | librosa `feature.rms`（= `sqrt(mean(x²))`、式は同じ） | **実装独立** | channel stride / 窓境界 / dtype / 正規化 等の**配管バグ**（RMS の定義そのものではない） |
| **pan** (`pan_from_lr_rms`) | librosa per-ch `feature.rms` → 等パワー逆算（atan2 は純粋数学・既にアンカーテスト済） | **実装独立** | 各 ch RMS の一致 = atan2 入力の健全性のみ。atan2 の数学は別途 `analysis.rs` のアンカーで pin 済 |

→ onset(threshold) = アルゴリズム独立（本丸）/ level・pan = 実装独立 / onset(matched) = 真値整合。
**「RMS/pan の数学を独立に再導出した」とは主張しない。**

## seam（WAV codec を検証対象に混ぜない）

DUT は in-memory f32 を取るプリミティブなので、WAV 再エンコードの codec 経路を差分に混ぜない:

1. **Rust 側**（`orbit-audio-daemon` の example `export_verify_pcm`）: 既存 fixture を本番 `EngineWrap::play_at`
   でオフライン決定論レンダ（phase-2 Leg-1 と同経路）→ `CapturedAudio.data` を**生 LE interleaved f32**
   でダンプ + 自プリミティブで測定した値を JSON 出力。
2. **Python 側**（`cross_check.py`）: 生 PCM を `np.fromfile(dtype='<f4').reshape(-1, ch)` で読み、librosa を
   **numpy 配列に直接**かける（librosa はファイル不要）。Rust の測定 JSON と突き合わせ、比較 JSON を出力。

生 PCM は決定論的に再生成可能な中間物なので **`.gen/`（gitignore）** に置き、コミットは小さい JSON のみ。

## artifact 契約（両側が共有する単一の正）

### ① 生 PCM（Rust 書き / Python 読み・gitignore）
- パス: `test-assets/verify-fixtures/phase3/.gen/<fixture>.pcm`
- 形式: ヘッダ無し・little-endian IEEE-754 `f32`・frame interleaved `[L0,R0,L1,R1,…]`・channels=2・48000 Hz。
- frame 数 = `file_size_bytes / (4 * channels)`。

### ② Rust 測定 JSON（Rust 書き・**committed**）
- パス: `test-assets/verify-fixtures/phase3/<fixture>.rust.json`
- スキーマ:
```jsonc
{
  "fixture": "per_event_gain",
  "sampleRate": 48000,
  "channels": 2,
  "frames": 168000,
  "pcmFile": ".gen/per_event_gain.pcm",
  "onsetThresholdRatio": 0.3,      // detect_onset_threshold の閾値 = この比率 × body peak（mono mix）
  "events": [
    {
      "sequenceName": "loud",
      "onsetSec": 0.1,
      "onsetFrameScheduled": 4800,        // golden の onsetSec × sr（ground truth）
      "onsetFrameThreshold": 4805,        // detect_onset_threshold（mono mix (L+R)/2）
      "onsetFrameMatched": 4800,          // detect_onset_matched（任意・per_event_gain のみ）。無ければ null
      "bodyWindow": [5056, 28200],        // [start,end) frames。RMS に使った窓
      "lRms": 0.350,
      "rRms": 0.350,
      "monoRms": 0.350,                   // (L+R)/2 の region_rms（onset 用 mono と同じ列）
      "pan": 0.001,                       // pan_from_lr_rms(lRms, rRms)
      "gainDb": -3.0
    }
  ]
}
```
- onset: **mono mix `(L+R)/2`** を作り、`detect_onset_threshold(threshold = onsetThresholdRatio × その mono の body peak)`。
  librosa の onset_detect も同じ mono に対して走らせる（チャンネル整合）。
- 各イベントの探索範囲は重複しないよう分離（fixture はイベント間に無音がある前提）。

### ③ 比較 JSON（Python 書き・**committed**）
- パス: `test-assets/verify-fixtures/phase3/<fixture>.compare.json`
- 各イベント・各メトリクスについて `{ scheduled, ours, librosa, deltaOursVsLibrosa, deltaLibrosaVsScheduled, withinTolerance }`、
  使用した許容、Python/librosa の版、総合 verdict を含む。

## 許容（校正値）

| メトリクス | 許容 | 根拠 |
|---|---|---|
| onset: ours(threshold) ↔ scheduled | ±2 ms（≈96 frames @48k） | レンダラに attack fade 無し → ほぼ sample-accurate |
| onset: matched ↔ scheduled | ±2 ms（≈96 frames @48k） | `detect_onset_matched` を scheduled 真値と整合確認（出力イベントのみ） |
| onset: librosa ↔ scheduled | ±15 ms（≈720 frames @48k） | spectral-flux+backtrack の系統先行（実測 max ≈ 9.3ms）を余裕で包む校正値（hop512=10.7ms の frame 解像度より広く） |
| level: ours ↔ librosa（RMS 相対誤差） | ≤ 3 % | 別実装の framing 差。`GAIN_DB_TOLERANCE`=±0.5dB とも整合 |
| pan: ours ↔ librosa | ±0.05（pan 単位） | `PAN_TOLERANCE` と同値 |

onset は **3-way**（ours / librosa / scheduled）。librosa 単独は弱いので scheduled を strong ground truth に据え、
librosa を独立 witness として併記する。検出は各 scheduled onset に最近接の librosa 検出を許容内でマッチ、
spurious（fade 尾）の超過検出は記録して verdict は「全 scheduled onset がマッチ」を要件にする。
`detect_onset_matched`（出力されたイベントのみ）は librosa オラクルでなく **scheduled 真値との整合**で grounding する
（threshold と同じ ±96 frame。Rust 別プリミティブが真値からずれていないことの確認）。

## CI 方針（owner 確定 2026-06-21）

**現状は CI gate にしない**。committed script + 版固定 `requirements.txt` + 本 README の
「Recorded validation」節 + `cross_check.py --selftest`（合成 PCM で機構の正常/異常検出を回帰ガード）で担保する。
理由: librosa/numba は版脆弱・onset は frame 解像度で gate だと flaky・回帰は既存 Rust アンカーテストがカバー。
grounding は一度実施して記録する性質。

**将来導入予定**（owner）。導入時は版固定 venv を job 化し、`cargo run --example export_verify_pcm`
→ `cross_check.py`（exit code を gate）を回せばよい（生成物は決定論）。その際は flaky 回避のため許容を再校正する。

## 実行手順（再現）

```bash
# 1. 生 PCM + Rust 測定 JSON を生成（決定論・再実行で同一バイト）
cargo run -p orbit-audio-daemon --example export_verify_pcm

# 2. venv で librosa cross-check（PyPI 到達が要る）
python3 -m venv tests/audio/verify/phase3/.venv
tests/audio/verify/phase3/.venv/bin/pip install -r tests/audio/verify/phase3/requirements.txt
tests/audio/verify/phase3/.venv/bin/python tests/audio/verify/phase3/cross_check.py
```

## Recorded validation

- 実施日: 2026-06-21
- 実行環境: Python 3.11.14 / librosa 0.11.0 / numpy 2.4.6（venv = `tests/audio/verify/phase3/.venv`）
- 再現: `cargo run -p orbit-audio-daemon --example export_verify_pcm` → `cross_check.py`。本記録は leader が
  独立に再実行して `verdict: PASS`（exit 0）を確認済み。

### 結果サマリ（全 fixture PASS）

| fixture | level lRelErr/rRelErr（max） | pan Δ（max） | onset ours↔sched（max） | onset librosa↔sched | spurious | verdict |
|---|---|---|---|---|---|---|
| per_event_gain | 0.0 / 0.0 | 0.0 | 0 fr | −192〜−320 fr | 0 | **PASS** |
| pan_three_voices | 0.0 / 0.0 | 0.0 | 0 fr | −192〜−448 fr | 0 | **PASS** |
| chop_region | 0.0 / 0.0 | 0.0 | +9 fr | −64〜−192 fr | 4 | **PASS** |

- **pan**（pan_three_voices）: left/mid/right の `pan_rust` = −1.0000 / −0.49999994 / +0.9999999、librosa 由来 pan と Δ=0.0。
- **onset（本丸・アルゴリズム独立）**: ours（threshold）は scheduled に対し 0〜+9 frame（attack fade 無しでほぼ
  sample-accurate）。librosa（spectral-flux + backtrack）は scheduled より **−64〜−448 frame（≈−1.3〜−9.3 ms）
  先行**する系統傾向（定常到達直前のエネルギー急増 + backtrack による）。いずれも許容 ±720 frame(±15ms) 内。
  全 scheduled onset がマッチ。`chop_region` の spurious 4 件は chop 内部境界の繰り返し立ち上がりを librosa が
  個別検出したもので、scheduled onset は全件マッチ済みのため verdict に影響なし。

### 独立性の質（再掲・記録として明示）

- **onset = アルゴリズム独立**（librosa=spectral-flux vs ours=threshold）。これが本増分の load-bearing な grounding。
  librosa の検出値は ours とも scheduled とも異なる独立値（例: per_event_gain loud で librosa=4608, ours=scheduled=4800）。
- **level = 実装独立**。`librosa.feature.rms(frame_length=窓全体, center=False)` は Rust `region_rms` と同一窓で
  `sqrt(mean(x²))` を計算するため数値は f32 丸め以下で一致（lRelErr=0.0）。これは RMS の数学を独立に再導出した
  のではなく、**生 PCM の読み込み（np.fromfile の interleave/reshape）・channel 取り出し・dtype の配管が一致する
  ことの確認**である。`librosa.feature.rms` の **デフォルト `frame_length=2048` を使うと減衰信号で ~30% の系統ズレ**が
  出るため、窓長を明示する必要がある（`cross_check.py` docstring 参照）。
- **pan = 実装独立**。librosa 由来 per-ch RMS から atan2 で逆算（atan2 の数学は Rust と共有・`analysis.rs` の
  `pan_inversion_hits_known_anchors` で別途 pin 済み）。grounding は per-ch RMS の一致に帰着する。

### self-test（合成 PCM・機構の回帰ガード）

`cross_check.py --selftest` は合成 PCM で機構を回帰ガードする。**各検出器を 1 ケース 1 摂動で単独 flip 検証**:
正常系 PASS + spurious 検出 assert / level（RMS×1.5）/ pan（pan フィールドを中央から外す = L/R 等倍では捕まらない経路）/
onset(ours)（threshold +15000fr）/ onset(librosa)（scheduled を burst から遠ざけ librosa_matched=False を駆動）の
各 FAIL を確認済み。self-test 成果物は `.gen/_selftest.pcm` と `_selftest*` に作り try/finally で必ず削除する
（本物の `.gen/<fixture>.pcm` は巻き添えにしない。`_selftest*` も gitignore 済）。

### pr-review-team round-1 反映（2026-06-21）

内部レビュー（4 専門エージェント）の Critical/Important を反映: ① selftest を各検出器（level/pan/onset-ours/
onset-librosa）単独 flip + spurious assert に再設計（pan は L/R 等倍だと未検証だった）、② `detect_onset_matched` を
scheduled 真値と整合確認（従来は出力のみで未消費＝「4 プリミティブ grounding」が過大主張だった）、
③ PCM frame 数を `rust.json["frames"]` と照合（stale/truncated PCM を静かに通さない）、
④ `onsetFrameThreshold=null`/near-zero RMS 相対誤差/`_selftest*` gitignore の robustness 修正。
