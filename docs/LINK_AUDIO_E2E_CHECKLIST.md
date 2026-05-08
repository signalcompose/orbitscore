# Link Audio End-to-End テスト - チェックリスト

**作成日**: 2026-05-07
**目的**: Epic #187 / Step 2 + Step 3.x 着地後の Live 12.4+ 連携の動作確認
**担当**: AI（テストファイル作成） + ユーザー（Live 操作と音質確認）

---

## 前提環境

- [ ] macOS (Apple Silicon)
- [ ] OrbitScore VS Code 拡張がインストール済 (`.vsix` from Step 4 release)
- [ ] Ableton Live 12.4+ 起動可能、 Link 機能有効
- [ ] `OrbitLinkAudio.scx` plugin が `~/Library/Application Support/SuperCollider/Extensions/` にある (Step 2 / Step 4 deliverable)
- [ ] テスト用 .orbs ファイル: `examples/10_link_audio.orbs`

---

## テストフロー

### A. Plugin 検出と起動

- [ ] **A-1**: VS Code 拡張のステータスバー → `🚀 Start Engine` でエンジン起動
- [ ] **A-2**: ログに `LinkAudio plugin loaded` 相当の表示が出る (Step 4 で wire される flip)
- [ ] **A-3**: 一方、 plugin が無い環境で `examples/10_link_audio.orbs` を実行 → console に「LinkAudio plugin not loaded — falls back to the hardware bus」 が **1 回だけ** 表示される (Step 3.2 fallback)

### B. Single channel publish

- [ ] **B-1**: `examples/10_link_audio.orbs` を VS Code で開く
- [ ] **B-2**: ファイル全体を保存して定義評価 (`Cmd+S`)
- [ ] **B-3**: Live 12.4 を起動、 Link を有効化
- [ ] **B-4**: Live で空のセッションを開き、 Audio トラックを 2 つ作成 (kick / snare)
- [ ] **B-5**: 各 Audio トラックの "Audio From" で OrbitScore peer の `kick` / `snare` を選択
- [ ] **B-6**: OrbitScore で `RUN(kick, snare)` を実行 (Step 3.5 example の最後)
- [ ] **B-7**: Live のメーターで両 channel に音が来ていることを確認 (kick / snare の発音タイミングが Live の grid と一致)

### C. Sum-by-name (drums bus)

- [ ] **C-1**: Live で 1 つの Audio トラックを `drums` channel に向ける
- [ ] **C-2**: OrbitScore で `RUN(hat_closed, hat_open, ghost)` (3 sequence が同 `drums` channel)
- [ ] **C-3**: Live メーターで、 全 3 sequence のミックス済み音声が **1 channel に合成されて** 受信されていることを確認
- [ ] **C-4**: ghost sequence の `gain(-12).pan(-30)` が Live 受信音に反映されている (左寄りで小さい音)

### D. Tempo / phase 双方向同期

- [ ] **D-1**: OrbitScore 側 `global.tempo(140)` を実行 → Live の Tempo display が `140 BPM` に追従
- [ ] **D-2**: Live 側で Tempo を `100` に変更 → OrbitScore のスケジューラが 100 BPM 相当の間隔で発音
- [ ] **D-3**: Live 側で Play/Stop 操作 → OrbitScore の scheduler が同期して start/stop (LinkAudio embedded transport)

### E. Sample rate mismatch detection

- [ ] **E-1**: Live セッション SR を `44100` に変更
- [ ] **E-2**: OrbitScore で `global.linkAudio()` (auto-detect) を実行 → console に target SR が `44100` に解決された旨が表示 (Step 2 plugin の auto-detect 結果)
- [ ] **E-3**: あるいは `global.linkAudio(44100)` で明示宣言 → 同上、 mismatch 警告なし
- [ ] **E-4**: Live セッション SR を `48000` に戻し、 `global.linkAudio(44100)` で実行 → ring buffer の連続ドロップ警告が console に出るか、 plugin 内で 44100→48000 のリサンプリングが行われる (Step 2 実装方針による)

### F. Hardware fallback

- [ ] **F-1**: `global.linkAudio()` を **書かない** .orbs ファイルを作成
- [ ] **F-2**: その中で `seq.output("test")` を呼ぶ
- [ ] **F-3**: 実行 → console に `global.linkAudio()` 未宣言の警告 (1 回のみ)
- [ ] **F-4**: 音声は通常通り hardware (ローカルスピーカー) から出る

### G. Plugin 不在時のフォールバック (Step 3.2 確認済)

- [ ] **G-1**: `~/Library/Application Support/SuperCollider/Extensions/OrbitLinkAudio.scx` を一時的に外す
- [ ] **G-2**: VS Code でエンジン再起動
- [ ] **G-3**: `global.linkAudio()` 宣言 + `seq.output("kick")` を実行
- [ ] **G-4**: console に「LinkAudio plugin not loaded — falls back to the hardware bus」 が **1 回だけ** 表示される
- [ ] **G-5**: 音声はローカルスピーカーから出る (Live は受信しない)
- [ ] **G-6**: plugin を戻して再起動 → 通常の LinkAudio 経路に戻る

---

## 既知の制限 (v1.2.0)

- ランタイム切替 (演奏中の `linkAudio()` on/off) は未対応 (v1.2.x で検討)
- mono / stereo (2ch まで)、 サラウンドや MultiChannel 出力は LinkAudio 仕様外
- LinkAudio API は alpha のため、 Live 側のマイナーアップデートで挙動が変わる可能性あり (`packages/sc-link-audio/src/link_audio_facade.hpp` で吸収)
- macOS arm64 only (Linux / Windows ビルドは scope 外)

---

## トラブルシュート

| 症状 | 原因候補 | 対処 |
|---|---|---|
| Live で channel 一覧に出ない | Live 12.4 未満 / Link Audio 設定オフ | Live のバージョン確認、 環境設定 → Link で Link Audio 有効化 |
| 連続ドロップ / プチプチ | publisher / subscriber SR 不一致 | `global.linkAudio(N)` で明示、 Live セッション SR を一致 |
| 音が出ない (Live メーター反応なし) | scsynth が boot していない | VS Code ステータスバーで engine 状態確認、 `🚀 Start Engine` |
| 同名 channel 合成されない | 別 plugin instance / 別 peer | OrbitScore は単一 peer 前提。 plugin の channel registry を再起動でリセット |
| console に warn が連発 | 未対応シナリオ (本仕様外) | warn 文を確認、 該当 issue (Epic #187) に再現条件を report |

---

## 関連ドキュメント

- [`docs/core/INSTRUCTION_ORBITSCORE_DSL.md`](core/INSTRUCTION_ORBITSCORE_DSL.md) §8.1 — Link Audio 仕様
- [`docs/research/LINK_AUDIO_API.md`](research/LINK_AUDIO_API.md) — Link Audio SDK 一次情報
- `examples/10_link_audio.orbs` — 動作する .orbs サンプル
- Epic #187 — 全 sub-step のトラッキング
