# Post-2.0 ロードマップ覚書（OrbitScore 本体の方向性）

> **ステータス: 探索段階・未 Issue 化。** 2026-06-18 に大和さんと整理した方向性メモであり、確定仕様ではない。Issue 化・実装着手の前に再検討する前提。
> WCTM コンサートシステム（締切 2026-08-07・Epic #224）とは**別トラック**。本書は OrbitScore 本体（言語・エンジン・エディタ・配布）の 2.0 以降の方向性のみ扱う。

---

## 0. 大方針 — engine-first

**ネイティブ音声エンジン（現状 scsynth）をどう用意するかが、すべての下流の起点。** これが決まり「アプリ的な形」で組めるようになってから、機能追加は**より実行的な形で再検討**する。順序を逆にすると手戻りになる（audio 側機能は engine 依存のため）。

2 つの軸を混同しない:
- **土台トラック（本書の主題）**: ネイティブエンジン + 専用アプリ化。
- **上物（features）**: 土台ができてから再検討（→ §3、deferred）。

---

## 1. ネイティブエンジン構想

現状: OrbitScore = TypeScript の DSL/パーサ/スケジューラ + **scsynth を OSC で駆動**して発音。

構想:
- **Tracktion Engine（C++/JUCE）を抱える** — 自作 DSP を避け、プラグインホスティング/再生/ミキシング/time-stretch を丸ごと再利用。OrbitScore 固有の追加は「Tracktion の post-mix 出力を JUCE の `audioDeviceIOCallbackWithContext` でタップ → 既存 `LinkAudioSink::commit`（RT-safe）に流す」程度。
- **VSCodium で専用デスクトップアプリ化**（確定方針・理由は UX と弄れる範囲の広さ）。ただし VSCodium は *fork* ではなく*上流 vscode を rebuild するスクリプト群*なので、専用アプリ化は **「リブランド rebuild（低保守）→ patch 付き rebuild → hard fork（Cursor 流・高保守）」の段階選択**ができる。「専用アプリにするか」ではなく「どの重さの手段で専用アプリ感を出すか」。
- **接続形態は「別ネイティブプロセス + IPC」が本命**（現状 scsynth と同じ構図）。既存の `packages/engine/src/audio/supercollider/` の **`OSCClient` seam に 1:1 で嵌まり**、`OSCClient` を差し替えるだけで DSL/スケジューラは無傷。N-API addon 同居案は JUCE の message loop 懸念があり保留。
- **LLM 連携（Claude CLI / .vsix）は差し替え可能な外付け層**に置く（WCTM の「脳なし Bridge + 差し替え可能ランタイム」思想 #29 と一貫）。

### 非Ableton DAW への導管（旧「case b」）— 後回し
「OrbitScore → 任意の DAW」へ音を出す導管プラグインは、**既存 Ableton Link Audio の `LinkAudioSource`（subscribe 側）を JUCE で VST3/AU/CLAP プラグイン化**する話（資産再利用。publisher 側は無改修）。OSS なので GPL ライセンスは不問。ただし **engine 確定後の優先度低**項目。既存の「音声を流す VST」で代替もできるため、DAW を録音機として使うだけなら急がない。

---

## 2. feasibility 検証の現状（正直な線引き）

詳細・一次情報は **`docs/research/NATIVE_ENGINE_TRACKTION_VSCODIUM.md`**。要点:

- ✅ **裏取り済（低リスク側）**: Tracktion のヘッドレス駆動（v3 clip-launcher + `Engine/Edit/TransportControl`）/ ライセンス整合（Tracktion=GPL3+、Link=GPLv2+、**JUCE 8=AGPLv3・別途取得要**）/ 出力 tap 点（`audioDeviceIOCallbackWithContext`）/ 別プロセス IPC 前例 / VSCodium ビルド形態。
- ⚠️ **未確証（しかも載せ替えの動機そのもの）**: 外部 **VST/AU/CLAP ホスティング**（Tracktion=Waveform 中核機能ゆえ低リスク推定だが一次情報未確認）/ VST GUI の Electron 共存 / N-API addon の message loop / fork 保守の定量。

→ 「実現可能」と語る際は、**動機の核心が未検証**である点を必ず併記する。

### de-risk スパイク順序
- **S1（最優先・editor 非依存）**: 「ヘッドレス Tracktion → **実プラグイン 1 つをホスト** → post-mix tap → 既存 `LinkAudioSink::commit`」を実機で通す。ホスティングを含めることで scsynth parity だけでなく**載せ替えの動機自体**を実証。現行スタックを壊さず並行可。
- **S2**: TS/Node から別プロセス+IPC で S1 のエンジンを駆動し、`OSCClient` seam に差し替えで嵌まる確認。
- **S3（engine 目処後）**: VSCodium の段階選択（軽い rebuild から始め、VST GUI 共存の要求分だけ重い側へ）。

---

## 3. 上物（features）は土台後に再検討 — deferred

**土台（engine + アプリ的な形）ができてから、より実行的な形で再検討する。今ロードマップに固定しない。** 理由:

- **session log（`.orbslog`）に実機で不具合が判明**（今回の QA 由来）→ 土台再設計の際に併せて見直すのが妥当。
- **ライブコーディングの実行（exe）タイミング**を実機で確認しておきたい（タイミング体感は土台に依存）。

対象（土台後に再検討する候補。順序・要否は再評価）:
- **engine 非依存**: MIDI / Pitch DSL 系 — #280（`seq.root(note-name)` 実バグ）/ #255（resolver 診断）/ #248（Phase 2 follow-up）。
- **棚卸し（追跡が実装に遅れている）**: #259（`.comp` C2a）・#212（launch quantize）は**コード実装済みなのに Issue が OPEN**。実体に合わせた棚卸しが要る。
- **engine 待ち（audio 表現力）**: #239（`slice()`）/ #213（`fixpitch()`/`time()` 本体）/ #238（audio sequence の `[ ]` stack）。S1 が固まるまで深追いしない。
- **session-log（`.orbslog`）の再設計** — 2.0.0 では **dormant 化済**（`ORBITSCORE_SESSION_LOG=1` opt-in、既定 off。writer/API/26 ユニットは保持）。理由: 現行は **file-scoped**（`<basename>.<stamp>.orbslog`）で、実機ライブの「**複数ファイルをまたぐ1セッション**」に合わず生成されない / LinkAudio トラックを捕捉しない設計ミスマッチ（6/18 ライブで判明）。**redesign 北極星**: ① **session-scoped**（ファイル単位でなく）② 全アクティブトラック捕捉（LinkAudio 出力含む）③ **L2 replay (#241) / post-concert 分析 (#242) が乗る形式**（両者は post-concert で新形式に re-base）。engine era の redesign 項目。

---

## 4. 近接の収束（本トラックと別・「あとで」枠）

- **2.0.0 リリース着地**: QA Epic #278 / PR #281。大和さんは「リリースは後でやる、今はやらない」と明言。本書の post-2.0 トラックとは独立。

---

## 5. 関連ドキュメント
- **エンジン方針 + ライセンス/配布/収益（最新の方向）**: `docs/development/POST_2.0_ENGINE_AND_DISTRIBUTION.md`（2026-06-19）。**engine の重心は Tracktion → 既存 Rust `rust/` に移動**（下記 feasibility doc の Tracktion 結論を更新）。
- **Pitch モデル再設計（root/key/scale/転調 + song 層）**: `docs/development/POST_2.0_PITCH_MODEL_NOTES.md`（engine 非依存）
- エンジン feasibility（Tracktion・一次情報）: `docs/research/NATIVE_ENGINE_TRACKTION_VSCODIUM.md`（**Tracktion 寄り結論は ENGINE_AND_DISTRIBUTION が更新**）
- 既存 LinkAudio の設計: `docs/research/LINK_AUDIO_API.md`
- WCTM（別トラック）: Epic #224 / `docs/specs-v2/`
