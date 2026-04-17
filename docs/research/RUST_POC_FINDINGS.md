# Research: Rust Audio Engine PoC (Issue #91) の初期所感

**調査日**: 2026-04-17
**ブランチ**: `91-rust-engine-poc`
**関連 Issue**: [#91](https://github.com/signalcompose/orbitscore/issues/91)

## 調査目的

Rust + `cpal` + `symphonia` で最小の「WAV ロード → 時間軸スケジュール → デスクトップ再生」が現実的に実装できるかを確認する。これが通れば、Phase 2（本実装）に進む判断材料となる。

## 実装サマリ

`rust/` 配下に単一 crate（`orbitscore-engine`）を新設。モジュール構成:

- `core/` — プラットフォーム非依存の `Engine` / `Sample` / `Scheduler`
- `native/` — `cpal` 経由の出力ストリームと `symphonia` デコーダ（`feature = "native"`）
- `wasm/` — `wasm-bindgen` / `AudioWorklet` のスタブ（`feature = "wasm"`、将来のウェブ版 "OrbitScore Lite" 向け予約）

Cargo features により `native` と `wasm` を排他的に選べる設計。デフォルトは `native`。

## 実行結果

```
$ cd rust && cargo run --example poc_play -- ../test-assets/audio/kick.wav ../test-assets/audio/snare.wav
loading ../test-assets/audio/kick.wav
loading ../test-assets/audio/snare.wav
  [0] sr=48000, ch=1, frames=24000, dur=0.500s
  [1] sr=48000, ch=1, frames=9600, dur=0.200s
output stream: sr=48000, ch=36
done
```

- `symphonia` が OrbitScore の test-assets の WAV を正しくデコード
- `cpal` のデフォルト出力デバイス（開発機は 36ch のインターフェース）でストリームが確立
- スケジューラが 500ms 間隔で kick / snare をラウンドロビン再生（6 秒間）
- クラッシュ / メモリリーク / パニック無し

## 発見・知見

### 1. デバイス構成に依存しない API 設計

当初は `Engine::new(48_000, 2)` のように固定 config でエンジンを作っていたが、実機の `default_output_config` が 36ch を返す環境では出力が破綻した。

`start_default_output() -> (Engine, OutputStream)` という形で、**cpal のデバイス config に合わせて Engine を構築**する API に変更。呼び出し側は config ミスマッチを意識しなくてよくなった。

### 2. モノラル → マルチチャンネル出力の扱い

scheduler の `render` で、出力チャンネル数が入力（モノラル）より多い場合は最後のチャンネルを繰り返す単純な duplicate 戦略を採った。本実装では `panLaw` や空間音響を考慮する必要がある（Phase 2 以降）。

### 3. symphonia のサンプル形式正規化

`AudioBufferRef` が F32 / S16 / S32 / U8 など複数型を返す。各型を `f32 [-1.0, 1.0]` に正規化する boilerplate が必要。汎用ヘルパー（`append_interleaved`）を用意して処理を集約した。

### 4. コンパイル時間

初回フルビルド（cpal + symphonia + 依存）で約 17 秒（ノート PC）。インクリメンタルは 0.3 秒程度。許容範囲内。

### 5. `cfg(feature = "wasm")` でのコード分離

WASM ビルドでは `cpal`, `symphonia` が不要。`dep:` プレフィックスで optional にすることで、`wasm` フィーチャだけ有効な時はこれらを引き込まないことを確認。実際の WASM ビルドは別 Issue（Phase 3）で検証。

## Known Limitations（PoC スコープ外）

### サンプリング周波数変換（SRC）未対応

現状の scheduler はソース WAV と出力デバイスの SR が一致するときのみ正しく再生できる。異なる場合はピッチとテンポがずれる。

| 条件 | 挙動 |
|---|---|
| 48kHz source + 48kHz output | ✅ 正しい（PoC が動いた条件） |
| 44.1kHz source + 48kHz output | ❌ 約 8.8% 早く再生（半音弱ピッチアップ） |
| 96kHz source + 48kHz output | ❌ 倍速再生（1 オクターブアップ） |

対応 Issue: [#100 sample rate conversion on sample load](https://github.com/signalcompose/orbitscore/issues/100)

### 業界 DAW の SRC ハンドリング（調査結果）

| DAW | タイミング | 備考 |
|---|---|---|
| Pro Tools | **オフライン（インポート時）** | 最高品質、"conversion quality" オプション |
| Logic Pro | オフライン（設定による） | インポート時変換 |
| Ableton Live | リアルタイム再生時 | SoX Resampler を採用していると言及されている（一次ソース未検証） |
| Reaper | リアルタイム再生時 | 異なる SR の混在に柔軟 |
| Bitwig Studio | リアルタイム再生時 | - |

業界共通の**ベストプラクティス**は「プロジェクト SR を固定し、素材は事前変換」。

### OrbitScore の選択: Pro Tools / Logic Pro 方式

ライブコーディング用途では:
- サンプルは事前ロード（ストリーミングではない）
- 低レイテンシ最重要
- 繰り返し再生

→ **ロード時に `rubato` (MIT) で Project SR に変換**するのが、品質・レイテンシ・実装容易性のバランスが最良。

## 次の検討事項

本 PoC のスコープ外、次に詰めるべき論点:

1. **サンプリング周波数変換**（Issue #100）— `rubato` によるロード時 SRC
2. **タイムストレッチ DSP**（Issue #92）— SoundTouch vs Rubato vs 独自実装
3. **ポリリズム / ポリメーター表現**（scheduler の時間軸抽象化）
4. **DSL パーサの統合**（現行 TS エンジンの `interpreter` 部分を Rust に移植する経路）
5. **リアルタイム性**（現在は `Mutex` で単純同期、ロックフリー化を検討）
6. **IPC プロトコル**（Issue #93）— Node 側フロントエンドとの通信設計

## 結論

**Rust 化は技術的に十分現実的**。
PoC のコード量はおよそ 300 行強で、cpal + symphonia のエコシステムが想像以上に成熟していた。Phase 2（本実装）に進めるだけの地固めは完了。

WASM 対応を初日から意識した feature 分離もスムーズで、将来の "OrbitScore Lite" ウェブ版への道が確保できている。

## 成果物

- `rust/` Cargo プロジェクト一式
- `rust/examples/poc_play.rs` — 実行可能な PoC
- 本ドキュメント
