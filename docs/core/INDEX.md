# OrbitScore Documentation Index

OrbitScore is a live coding music DSL for VS Code with a bundled native audio engine (Rust `orbit-audio-daemon`) and MIDI output.

**Current release**: OrbitScore **2.0.0** (`ENGINE_VERSION 2.0.0` / `DSL_VERSION 1.1`、VS Code 拡張 2.1.0)。
**Audio backend**: Rust `orbit-audio-daemon` が既定（cutover #108・2026-07-03）。SuperCollider (scsynth) は `ORBITSCORE_ENGINE=sc` で opt-out できる旧既定経路。
**Supported platforms**: macOS (Apple Silicon, arm64) **only**。Intel Mac は**非対応**。Windows / Linux is not supported.

---

## 📚 Top-level entry points

- 🏠 [README.md](../../README.md) — Project overview, install pointer, status table
- 🛠️ [CLAUDE.md](../../CLAUDE.md) — Claude Code session start guide + review / E2E 規律
- 🎓 [User Learning Site](https://signalcompose.github.io/orbitscore/) — ユーザー向け正本（`sites/user/`）
- 🛠️ [Dev Learning Site](https://signalcompose.github.io/orbitscore/dev/) — 実装読解ノート（`sites/dev/`）
- 🎵 [INSTRUCTION_ORBITSCORE_DSL.md](INSTRUCTION_ORBITSCORE_DSL.md) — DSL specification (single source of truth)

---

## 🧭 Core (`docs/core/`)

| File | Purpose |
|---|---|
| [INDEX.md](INDEX.md) | This file — top-level navigation |
| [DESIGN_PRINCIPLES.md](DESIGN_PRINCIPLES.md) | プロダクト設計原則（LLM-first / 人間製成果物依存の禁止 / 対称ワークフロー）— 全機能仕様の上位規範 |
| [PROJECT_RULES.md](PROJECT_RULES.md) | Critical project rules — must-read before contributing |
| [INSTRUCTION_ORBITSCORE_DSL.md](INSTRUCTION_ORBITSCORE_DSL.md) | DSL specification — single source of truth（audio v3.0 + Pitch DSL v1.1 + PH / PC / MX / IM 各節） |
| [CONTEXT7_GUIDE.md](CONTEXT7_GUIDE.md) | Context7 (external library docs) usage |

---

## 🎯 Active spec set — v1.1 Pitch DSL + Session Log + WCTM (`docs/specs-v2/`)

v1.1（Pitch DSL / MIDI 出力）・Session Log・WCTM コンサートシステムの正本仕様。
**Markdown が正本**（#507 で HTML から移行。埋め込み SVG のアーキテクチャ図も仕様の一部）。進捗管理は **GitHub Epic #224**。
読み順は下表の番号通り（指示書 → Pitch DSL → Session Log → WCTM → 議論記録）:

> **⚠️ 本番トラック retarget（2026-07-12・統括 [#413](https://github.com/signalcompose/orbitscore/issues/413)）**: 藝大コンサート（2026-08-07）は不採択。旧「締切 2026-08-07」の前提は失効し、本番トラックは ICLC への proposal 提出方向へ retarget（年次・提出日・提出形態はいずれも要確認）。Max 必須の縛りも消滅。WCTM 各仕様（下表 #4）・議論記録（#5）は**藝大版のスナップショットとして凍結**（入口ノート参照）。

| # | File | Purpose |
|---|---|---|
| 1 | [IMPLEMENTATION_INSTRUCTIONS.md](../specs-v2/IMPLEMENTATION_INSTRUCTIONS.md) | 作業指示書（フェーズ・依存グラフ・委譲方針・Known Decisions §7） |
| 2 | [PITCH_DSL_SPEC_v1.1.md](../specs-v2/PITCH_DSL_SPEC_v1.1.md) | Stage 1 = note DSL（度数 / root / mode / chord / `[ ]` / tie）仕様正本 |
| 3 | [SESSION_LOG_SPEC_v1.md](../specs-v2/SESSION_LOG_SPEC_v1.md) | 記録 `.orbslog`（因果ログ・三重スタンプ・リプレイ）仕様正本 |
| 4 | [WCTM_SYSTEM_SPEC_v1.md](../specs-v2/WCTM_SYSTEM_SPEC_v1.md) | コンサートシステム（Bridge MCP / ランタイム / Link 結合度）仕様正本 |
| 5 | [DESIGN_DISCUSSION_RECORD.md](../specs-v2/DESIGN_DISCUSSION_RECORD.md) | 設計経緯と棄却済み代替案（決定ログ #1-32。判断に迷ったときの参照） |

> ⚠️ §7 Known Decisions（+ 議論記録の決定ログ）は確定済み。**再設計・再議論しない**。

---

## 🎛️ Active spec set — プラグイン / シグナルチェーン / ミキサー (`docs/specs-v2/`)

プラグイン能力（state / パラメータ / preset / UI）を **VST3 / CLAP / 将来の AU で同一の UX**
として提供するための正本仕様と、ラック形シグナルチェーン（SC.10）の仕様。進捗管理は
**GitHub Epic [#546](https://github.com/signalcompose/orbitscore/issues/546)**（VST ワークフロー）と
[#628](https://github.com/signalcompose/orbitscore/issues/628)（ラック）。

| # | File | Purpose |
|---|---|---|
| 1 | [PLUGIN_CAPABILITY_ABSTRACTION_v1.md](../specs-v2/PLUGIN_CAPABILITY_ABSTRACTION_v1.md) | 形式中立プラグイン能力抽象（CAP.n）— 能力一覧・規格対応表・規格間の非対称・スレッド境界 |
| 2 | [PLUGIN_UI_HOSTING_SPEC_v1.md](../specs-v2/PLUGIN_UI_HOSTING_SPEC_v1.md) | プラグイン UI ホスティング（UIH.n）— child 実行モデル（Cocoa runloop）・制御語彙・ウィンドウ所有・故障モード |
| 3 | [PLUGIN_UI_IMPLEMENTATION_DESIGN_474.md](../specs-v2/PLUGIN_UI_IMPLEMENTATION_DESIGN_474.md) | #474 の実装設計（P1〜P4c: evt リング・クローズ状態機械・NSWindow・MCP 開閉） |
| 4 | [PROJECT_FILE_SPEC_v1.md](../specs-v2/PROJECT_FILE_SPEC_v1.md) | プロジェクトファイル（PRJ.n）— `project.yaml` の登記モデル・保存タイミング・復元の単位 |
| 5 | [SIGNAL_CHAIN_DSL_SPEC_v1.md](../specs-v2/SIGNAL_CHAIN_DSL_SPEC_v1.md) | シグナルチェーン DSL（SC.n）— 二層意味論・ラック `[ ]`・標準プラグイン `Gain`・カタログ名前指し（SC.10） |
| 6 | [MULTICHANNEL_RENDERING_DESIGN_598.md](../specs-v2/MULTICHANNEL_RENDERING_DESIGN_598.md) | #598 RenderScore manifest / offline process mode の設計 |

> 上位規範は [DESIGN_PRINCIPLES.md](DESIGN_PRINCIPLES.md)、検証規律は
> [E2E_HARNESS_SPEC.md](../testing/E2E_HARNESS_SPEC.md)。設計記録は
> [#541](https://github.com/signalcompose/orbitscore/issues/541) /
> [#474](https://github.com/signalcompose/orbitscore/issues/474) /
> [#543](https://github.com/signalcompose/orbitscore/issues/543)。

### 設計ノート (`docs/design/`)

Issue 単位の実装設計（起案 Fable / 審査 main。**owner 確定事項は再議論しない**）:

| File | Issue | Purpose |
|---|---|---|
| [643-mixer-foundation-design.md](../design/643-mixer-foundation-design.md) | #643 | ミキサーの土台と、その上に乗るオプションの責務分離（instrument を source に） |
| [649-audio-line-design.md](../design/649-audio-line-design.md) | #649 | オーディオライン設計 v3（メソッドチェーン順序 = 決定論） |

#### アーカイブ済み（`docs/archive/design/`）

**正本が別にできたもの**を #696 で移動した（PR [#693](https://github.com/signalcompose/orbitscore/pull/693)）。
記録としては残るが**現在の正本ではない**ので、**新しい判断の根拠にしないこと**:

| File | Issue | 現在の正本 |
|---|---|---|
| [625-effect-replacement-design.md](../archive/design/625-effect-replacement-design.md) | #625 | **#625 CLOSED**（出荷済み・PR #627）/ 意味論は SC.10 |
| [628-effect-chain-model.md](../archive/design/628-effect-chain-model.md) | #628 | `docs/specs-v2/SIGNAL_CHAIN_DSL_SPEC_v1.md` **SC.10** |
| [628-rack-chain-implementation-design.md](../archive/design/628-rack-chain-implementation-design.md) | #628 | **#628 CLOSED**（出荷済み・PR #639）/ 意味論は SC.10 |
| [628-plan-reset.md](../archive/design/628-plan-reset.md) | #628 | **#628 CLOSED**（PR #639）/ 現在の計画は `DEVELOPMENT_MAP.md` §4.B |
| [628-gated-e2e-rack-design.md](../archive/design/628-gated-e2e-rack-design.md) | #628 | **#628 CLOSED** / E2E の現在地は `DEVELOPMENT_MAP.md` §4.G |
| [628-ui-pump-per-index-design.md](../archive/design/628-ui-pump-per-index-design.md) | #628/#633 | **#633 CLOSED**（出荷済み・PR #652）/ 現在地は `DEVELOPMENT_MAP.md` §4.B・§4.C |

> ⚠️ 設計書の「失敗モード ↔ テスト対応表」は**テスト対象の一覧**として読み、検証手段は CLAUDE.md の
> 「テストの積み上げ規律」で決め直す（設計書は本規則を上書きできない）。

---

## 🚧 Development (`docs/development/`)

| File | Purpose |
|---|---|
| [WORK_LOG.md](../development/WORK_LOG.md) | Recent development log（newest first。**every commit must be logged**） |
| [IMPLEMENTATION_PLAN.md](../development/IMPLEMENTATION_PLAN.md) | Phase-by-phase technical roadmap（audio DSL 移行期の記録・歴史的） |
| [BEAT_METER_SPECIFICATION.md](../development/BEAT_METER_SPECIFICATION.md) | Beat / meter / polymeter specification |
| [DEV_LEARNING_SITE.md](../development/DEV_LEARNING_SITE.md) | dev 学習サイト project brief + `vitepress-learning-site` skill 運用 overrides |
| [USER_LEARNING_SITE.md](../development/USER_LEARNING_SITE.md) | user 学習サイト project brief + 執筆規律 overrides |
| [TRANSLATION_WORKFLOW.md](../development/TRANSLATION_WORKFLOW.md) / [TRANSLATION_STATUS.md](../development/TRANSLATION_STATUS.md) | 学習サイト ja→en 翻訳の手順と進捗 |
| [enumeration-13.md](../development/enumeration-13.md) | 列挙 13 本（E2E の取り残しを出す手順） |
| [evidence/628-gated-evidence.md](../development/evidence/628-gated-evidence.md) | #628 実機ゲートの証跡 |

### Post-2.0 engine documents (`docs/development/POST_2.0_*`)

Rust エンジン移行（post-2.0）の計画・設計・spike 記録。HTML は SVG 図を含むため HTML のまま:

| File | Purpose |
|---|---|
| [POST_2.0_MASTER_PLAN.html](../development/POST_2.0_MASTER_PLAN.html) | post-2.0 マスター計画（エンジン優先ロードマップの正本） |
| [POST_2.0_ENGINE_AND_DISTRIBUTION.md](../development/POST_2.0_ENGINE_AND_DISTRIBUTION.md) | エンジン / pitch / song / 配布の方向性 |
| [POST_2.0_A0_RT_INTEGRATION_DESIGN.md](../development/POST_2.0_A0_RT_INTEGRATION_DESIGN.md) | A0 RT 統合設計（audio backend seam） |
| [POST_2.0_GAMMA_SANDBOX_SPIKE.md](../development/POST_2.0_GAMMA_SANDBOX_SPIKE.md) / [POST_2.0_GAMMA_LATENCY_FORK_SPIKE.md](../development/POST_2.0_GAMMA_LATENCY_FORK_SPIKE.md) | γ out-of-process sandbox の実現性 / レイテンシ policy spike |
| [POST_2.0_GAMMA_M1_DESIGN.md](../development/POST_2.0_GAMMA_M1_DESIGN.md) / [POST_2.0_GAMMA_M2_DESIGN.md](../development/POST_2.0_GAMMA_M2_DESIGN.md) | γ M1（effect child + shm transport）/ M2（instrument child + event wire） |
| [POST_2.0_VST3_HOSTING_PLAN.md](../development/POST_2.0_VST3_HOSTING_PLAN.md) / [POST_2.0_VST3_STEP0_SPIKE.md](../development/POST_2.0_VST3_STEP0_SPIKE.md) | VST3 hosting 計画と Step 0 spike |
| [POST_2.0_PLUGIN_HOST_KNOWHOW.md](../development/POST_2.0_PLUGIN_HOST_KNOWHOW.md) / [POST_2.0_PLUGIN_STRATEGY.html](../development/POST_2.0_PLUGIN_STRATEGY.html) | プラグインホスティングの知見と戦略 |
| [POST_2.0_MIXER_DSL_DESIGN.html](../development/POST_2.0_MIXER_DSL_DESIGN.html) / [POST_2.0_NOTATION_DSL_DESIGN.html](../development/POST_2.0_NOTATION_DSL_DESIGN.html) | ミキサー DSL / 記譜 DSL の設計ノート |
| [POST_2.0_ORBITSTUDIO_PLAN.md](../development/POST_2.0_ORBITSTUDIO_PLAN.md) / [POST_2.0_NEXT_STEPS.html](../development/POST_2.0_NEXT_STEPS.html) / [POST_2.0_ROADMAP_NOTES.md](../development/POST_2.0_ROADMAP_NOTES.md) / [POST_2.0_PITCH_MODEL_NOTES.md](../development/POST_2.0_PITCH_MODEL_NOTES.md) | OrbitStudio 計画・次段・ロードマップ・ピッチモデルのノート |

### Dev Learning Site (`sites/dev/`)

dev 学習サイト本体（VitePress、日英バイリンガル）。`main` の `sites/**` 変更で
`.github/workflows/deploy-sites.yml` が https://signalcompose.github.io/orbitscore/dev/ へ自動 deploy:

| Location | Purpose |
|---|---|
| [`sites/dev/`](../../sites/dev/) | dev 学習サイト VitePress プロジェクト（Part 0〜VIII: orientation / pipeline / scheduling / rust-engine / signal-chain / plugin-hosting / editor / SC 経路 / ADR） |
| [`sites/dev/STYLE_GUIDE.md`](../../sites/dev/STYLE_GUIDE.md) | 章執筆規約 (frontmatter / Sources / 次の深掘り候補 / §5-bis verbatim 引用) |
| [`sites/dev/scripts/check-citations.mjs`](../../sites/dev/scripts/check-citations.mjs) | 引用 (`// file:start-end`) を code と文字単位で突合する機械検証（`npm run docs:check`） |
| [`sites/dev/.plan/refresh-2026-07.md`](../../sites/dev/.plan/refresh-2026-07.md) | 2026-07 リフレッシュ計画と 2026-09 の到達状況 |

### User Learning Site (`sites/user/`)

user 向け学習サイト本体（VitePress、日英）。同 workflow で https://signalcompose.github.io/orbitscore/ へ deploy:

| Location | Purpose |
|---|---|
| [`sites/user/`](../../sites/user/) | user 学習サイト（getting-started / basics / midi / plugins / mixing / projects / reference / troubleshooting） |
| [`sites/user/STYLE_GUIDE.md`](../../sites/user/STYLE_GUIDE.md) | 章執筆規約 (ですます調、子供扱いしない、コードのみ) |

### Archived WORK_LOG (`docs/archive/`)

| Period | Archive |
|---|---|
| 2025-09 | [WORK_LOG_2025-09.md](../archive/WORK_LOG_2025-09.md) |
| 2025-10 | [WORK_LOG_2025-10.md](../archive/WORK_LOG_2025-10.md) |
| 2026-02 | [WORK_LOG_2026-02.md](../archive/WORK_LOG_2026-02.md) |
| 2026-04 | [WORK_LOG_2026-04.md](../archive/WORK_LOG_2026-04.md) |
| 2026-05 | [WORK_LOG_2026-05.md](../archive/WORK_LOG_2026-05.md) |
| 2026-06 | [WORK_LOG_2026-06.md](../archive/WORK_LOG_2026-06.md) |

---

## 🧪 Testing (`docs/testing/`)

| File | Purpose |
|---|---|
| [TESTING_GUIDE.md](../testing/TESTING_GUIDE.md) | Unit / integration test procedures |
| [E2E_HARNESS_SPEC.md](../testing/E2E_HARNESS_SPEC.md) | DSL 網羅 E2E ハーネス仕様（仕様書駆動・二重台帳監査・無人実行・改ざん耐性）— #543 の規範。実装は `tests/e2e/orbitstudio-mcp-gated.spec.ts`（`npm run test:e2e:gated`） |
| [LINK_AUDIO_E2E_CHECKLIST.md](../testing/LINK_AUDIO_E2E_CHECKLIST.md) | LinkAudio 実機チェックリスト |
| [QA_2.0.0.md](../testing/QA_2.0.0.md) / [QA_2.0.0_HUMAN_RUNBOOK.md](../testing/QA_2.0.0_HUMAN_RUNBOOK.md) | 2.0.0 リリース QA と人手 runbook |
| [PERFORMANCE_TEST.md](../testing/PERFORMANCE_TEST.md) | Live coding performance benchmarks |

CLAUDE.md の「テストの積み上げ規律」「E2E が最重要」「マージ前ゲート」が検証の運用規則。

---

## 🔬 Research (`docs/research/`)

### Rust engine / plugin hosting

| File | Status | Description |
|---|---|---|
| [RUST_POC_FINDINGS.md](../research/RUST_POC_FINDINGS.md) | ✅ 反映済 | Rust audio engine PoC 検証 |
| [ENGINE_DAEMON_PROTOCOL.md](../research/ENGINE_DAEMON_PROTOCOL.md) | 📝 Draft | Rust daemon IPC v0.1 草案（実装は protocol v0.2） |
| [RUST_PLUGIN_HOSTING.md](../research/RUST_PLUGIN_HOSTING.md) | ✅ 反映済 | Rust での CLAP / VST3 hosting 調査 |
| [PLUGIN_STATE_HOSTING.md](../research/PLUGIN_STATE_HOSTING.md) | ✅ 反映済 | プラグイン state の保存・復元 |
| [PLUGIN_CATALOG_SCANNING.md](../research/PLUGIN_CATALOG_SCANNING.md) | ✅ Implemented (#463) | プラグインカタログ scanner |
| [AUDIO_OUTPUT_VERIFICATION.md](../research/AUDIO_OUTPUT_VERIFICATION.md) | ✅ Implemented (#307〜#316) | DSL 静的スケジュール vs レンダ PCM の客観検証 |
| [DAW_AUDIO_ARCHITECTURE.md](../research/DAW_AUDIO_ARCHITECTURE.md) | 📚 参考 | DAW のオーディオアーキテクチャ調査 |
| [NATIVE_ENGINE_TRACKTION_VSCODIUM.md](../research/NATIVE_ENGINE_TRACKTION_VSCODIUM.md) | 📚 参考 | ネイティブエンジン / VSCodium 配布の調査 |
| [LINK_AUDIO_API.md](../research/LINK_AUDIO_API.md) | ✅ Implemented (#283, #324〜#333) | Ableton LinkAudio API 調査 |
| [PHASE0_VERIFICATION_REPORT.md](../research/PHASE0_VERIFICATION_REPORT.md) | ✅ | Pitch DSL Phase 0 事前検証 |
| [comping-voice-leading-design.md](../research/comping-voice-leading-design.md) | ✅ Implemented (#269, #271) | comp / voice-leading 設計 |

### ICMC v1.x bundle（SuperCollider 経路・opt-out 化済）

| File | Status | Description |
|---|---|---|
| [SCSYNTH_BUNDLE_MANIFEST.md](../research/SCSYNTH_BUNDLE_MANIFEST.md) | ✅ Implemented (#136) | scsynth bundle 構造、26 plugin 同梱 |
| [SCSYNTH_STANDALONE.md](../research/SCSYNTH_STANDALONE.md) | ✅ Implemented (#133) | scsynth standalone 起動検証 |
| [CODESIGN_PIPELINE.md](../research/CODESIGN_PIPELINE.md) | ✅ Implemented (#135) | macOS signing / notarize 戦略 (Apple Dev ID 不要) |

配布・ホスト環境の検証:

| File | Status | Description |
|---|---|---|
| [design/662-engine-visibility-and-limits.md](../design/662-engine-visibility-and-limits.md) | 📝 設計 (2026-08-31) | エンジンの可視化と上限の撤廃。余裕の表示・プール動的拡張・再起動要否の属性化 (#662/#663) |
| [EDITOR_HOST_AND_APP_SIZE.md](../research/EDITOR_HOST_AND_APP_SIZE.md) | 📝 調査記録 (2026-08-30) | 自作エディタ vs VSCodium の比較と、アプリ 889→481MB のトリム実測。ソースマップが 334MB |

### WCTM 調査群（旧前提のスナップショット・凍結）

`docs/research/WCTM_*`（機械の耳・作曲スキル・エージェントハーネス等 7 本）と `docs/specs-v2/DESIGN_DISCUSSION_RECORD.md` は、**旧前提（藝大 2026-08-07・Max 必須）下の調査・議論記録として意図的に凍結**する（記録改変は文脈破壊のため。抜けではない）。本番トラックの retarget（藝大不採択 → ICLC 方向・Max 脱必須。年次・提出日・形態は要確認）は統括 [#413](https://github.com/signalcompose/orbitscore/issues/413) を参照。

---

## 🗺️ Planning (`docs/planning/`)

| File | Purpose |
|---|---|
| [DEVELOPMENT_MAP.md](../planning/DEVELOPMENT_MAP.md) | 🔴 **開発計画の正本**（2026-09-03 制定）。open issue はこの地図に**合わせる**。§0 使い方と運用規則 / §1 再設計しない確定事項 / §1b 機能の持ち方 / §2 全体図 / §3 リリースまでの筋 / §4 領域ごとの地図 / §5 Epic の裁定 / §6 統合一覧 / §7 新規に必要な issue / §8 提案 / §9 未確認 |
| [2026-09-03-issue-triage.md](../planning/2026-09-03-issue-triage.md) | issue 棚卸し 164→120 とラベル運用の記録（#689）。**地図の入力として現役** |

> 🔴 **新規起票の前に地図の該当節を探す**（地図 §0.2）。**番号の検索ではなく、地図の見出しで探す** —
> `gh issue list` だけでは重複を防げなかった（2026-09-03 に #686→#218 / #680→#506+#522 の 2 件が同日に発生）。
> 地図に該当する節が無い作業は、**まず地図を更新する PR を出す**。

#### アーカイブ済み（`docs/archive/planning/`）

#696 で移動（PR [#693](https://github.com/signalcompose/orbitscore/pull/693)）。**新しい判断の根拠にしないこと**:

| File | 現在の正本 |
|---|---|
| [ROADMAP_2026.md](../archive/planning/ROADMAP_2026.md) | **`DEVELOPMENT_MAP.md`**（地図 §0.3: 本文書は歴史的スナップショットであり、現在の順序の根拠にしない） |
| [IMPROVEMENT_RECOMMENDATIONS.md](../archive/planning/IMPROVEMENT_RECOMMENDATIONS.md) | **`DEVELOPMENT_MAP.md`**（SC 時代の文書） |
| [2026-09-02-feature-map-comments.md](../archive/planning/2026-09-02-feature-map-comments.md) | **`DEVELOPMENT_MAP.md`** §4 各節 + **#679 / #680 / #681**（9 コメントは地図と issue へ転記済み） |

### Post-ICMC（起案時の計画・多くは実装済）

`docs/planning/post-icmc/`:

| File | Purpose |
|---|---|
| [RUST_ENGINE_MIGRATION_PLAN.md](../planning/post-icmc/RUST_ENGINE_MIGRATION_PLAN.md) | Rust audio engine 移行ロードマップ（cutover #108 で既定化済） |
| [AUDIO_ENGINE_CORE_ARCHITECTURE.md](../planning/post-icmc/AUDIO_ENGINE_CORE_ARCHITECTURE.md) | 3 層分離アーキテクチャ (Core / Plugins / App) |
| [ELECTRON_APP_PLAN.md](../planning/post-icmc/ELECTRON_APP_PLAN.md) | スタンドアロンアプリ計画（OrbitStudio は `scripts/orbitstudio/` の VSCodium ベースで進行） |
| [COLLABORATION_FEATURE_PLAN.md](../planning/post-icmc/COLLABORATION_FEATURE_PLAN.md) | マルチユーザー協調機能設計 |

### Short-term implementation plans (`docs/plans/`)

| File | Purpose |
|---|---|
| [orbit-audio-daemon-phase-1b-1.md](../plans/orbit-audio-daemon-phase-1b-1.md) | Rust daemon Phase 1b 実装計画（完了） |
| [rust-audio-workspace-split.md](../plans/rust-audio-workspace-split.md) | Rust Cargo workspace 構造計画（完了・現状は [rust/README.md](../../rust/README.md)） |

---

## 👥 User documentation (`docs/user/`)

正本は [User Learning Site](https://signalcompose.github.io/orbitscore/)（`sites/user/`）。以下はリポジトリ内の補助:

| File | Purpose |
|---|---|
| [user/ja/USER_MANUAL.md](../user/ja/USER_MANUAL.md) | 日本語版ユーザーマニュアル（#642 でプラグインメソッドを反映） |
| [user/ja/GETTING_STARTED.md](../user/ja/GETTING_STARTED.md) | 日本語版スタートガイド |
| [user/en/USER_MANUAL.md](../user/en/USER_MANUAL.md) | English user manual（#642 で日本語版と同期） |
| [user/en/GETTING_STARTED.md](../user/en/GETTING_STARTED.md) | English getting started |

---

## 📦 Archived specifications (`docs/archive/`)

DSL 仕様の変遷 (論文執筆・研究用):

| Version | Document | Status |
|---|---|---|
| audio v3.0 + Pitch DSL v1.1 (current) | [INSTRUCTION_ORBITSCORE_DSL.md](INSTRUCTION_ORBITSCORE_DSL.md) | ✅ Active |
| v1.0 (deprecated) | [archive/DSL_SPECIFICATION_v1.0_MIDI.md](../archive/DSL_SPECIFICATION_v1.0_MIDI.md) | 📚 Archived |

---

## 🔗 Quick links

- **Install / use**: [User Learning Site](https://signalcompose.github.io/orbitscore/)
- **DSL syntax**: [INSTRUCTION_ORBITSCORE_DSL.md](INSTRUCTION_ORBITSCORE_DSL.md)
- **Project rules**: [PROJECT_RULES.md](PROJECT_RULES.md)
- **Rust workspace**: [rust/README.md](../../rust/README.md)
- **Recent dev log**: [WORK_LOG.md](../development/WORK_LOG.md)
- **GitHub Releases (`.vsix` download)**: [github.com/signalcompose/orbitscore/releases](https://github.com/signalcompose/orbitscore/releases)
- **Issue tracker**: [github.com/signalcompose/orbitscore/issues](https://github.com/signalcompose/orbitscore/issues)

---

_Last updated: 2026-09-01 (dev site / docs refresh against commit 69dc968)_
