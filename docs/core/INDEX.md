# OrbitScore Documentation Index

OrbitScore is a live coding music DSL for VS Code with a bundled SuperCollider audio engine.

**Current release**: v1.1.0 (ICMC 2026 ready) — bundled scsynth, strict path resolver, automated release workflow.
**Supported platforms**: macOS (Apple Silicon, arm64) **only**。Intel Mac は**非対応**（[PROJECT_RULES.md](PROJECT_RULES.md#platform-support) に決定と根拠）。Windows / Linux is not supported in v1.x.

---

## 📚 Top-level entry points

- 🏠 [README.md](../../README.md) — Project overview, install pointer, status table
- 🛠️ [CLAUDE.md](../../CLAUDE.md) — Claude Code session start guide
- 📖 [USER_MANUAL.md (日本語)](../user/ja/USER_MANUAL.md) — User manual (canonical, Japanese)
- 🎵 [INSTRUCTION_ORBITSCORE_DSL.md](INSTRUCTION_ORBITSCORE_DSL.md) — DSL specification (single source of truth, v3.0)

---

## 🧭 Core (`docs/core/`)

| File | Purpose |
|---|---|
| [INDEX.md](INDEX.md) | This file — top-level navigation |
| [DESIGN_PRINCIPLES.md](DESIGN_PRINCIPLES.md) | プロダクト設計原則（LLM-first / 人間製成果物依存の禁止 / 対称ワークフロー）— 全機能仕様の上位規範 |
| [PROJECT_RULES.md](PROJECT_RULES.md) | Critical project rules — must-read before contributing |
| [INSTRUCTION_ORBITSCORE_DSL.md](INSTRUCTION_ORBITSCORE_DSL.md) | DSL v3.0 specification — single source of truth |
| [CONTEXT7_GUIDE.md](CONTEXT7_GUIDE.md) | Context7 (external library docs) usage |

---

## 🎯 Active spec set — v1.1 Pitch DSL + Session Log + WCTM (`docs/specs-v2/`)

進行中の v1.1（Pitch DSL / MIDI 出力）・Session Log・WCTM コンサートシステムの正本仕様。
**HTML が正本**（SVG アーキテクチャ図を含むため）。進捗管理は **GitHub Epic #224**。
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

## 🎛️ Active spec set — VST ワークフロー（音色ループ）(`docs/specs-v2/`)

プラグイン能力（state / パラメータ / preset / UI）を **VST3 / CLAP / 将来の AU で同一の UX**
として提供するための正本仕様。進捗管理は **GitHub Epic [#546](https://github.com/signalcompose/orbitscore/issues/546)**。
読み順は下表の番号通り（能力抽象 → UI ホスティング → プロジェクトファイル）:

| # | File | Purpose |
|---|---|---|
| 1 | [PLUGIN_CAPABILITY_ABSTRACTION_v1.md](../specs-v2/PLUGIN_CAPABILITY_ABSTRACTION_v1.md) | 形式中立プラグイン能力抽象（CAP.n）— 能力一覧・規格対応表・**規格間の非対称（state dirty 通知）**・スレッド境界。下2本の共通土台 |
| 2 | [PLUGIN_UI_HOSTING_SPEC_v1.md](../specs-v2/PLUGIN_UI_HOSTING_SPEC_v1.md) | プラグイン UI ホスティング（UIH.n）— child 実行モデル変更（Cocoa runloop 化）・制御語彙拡張・ウィンドウ所有・故障モード |
| 3 | [PROJECT_FILE_SPEC_v1.md](../specs-v2/PROJECT_FILE_SPEC_v1.md) | プロジェクトファイル（PRJ.n）— `project.yaml` の登記モデル・保存タイミング（離散セーフポイント）・復元の単位 |

> 上位規範は [DESIGN_PRINCIPLES.md](DESIGN_PRINCIPLES.md)、検証規律は
> [E2E_HARNESS_SPEC.md](../testing/E2E_HARNESS_SPEC.md)。設計記録は
> [#541](https://github.com/signalcompose/orbitscore/issues/541) /
> [#474](https://github.com/signalcompose/orbitscore/issues/474) /
> [#543](https://github.com/signalcompose/orbitscore/issues/543)。

---

## 🚧 Development (`docs/development/`)

| File | Purpose |
|---|---|
| [WORK_LOG.md](../development/WORK_LOG.md) | Recent development log (May 2026 onward; older entries archived by month) |
| [IMPLEMENTATION_PLAN.md](../development/IMPLEMENTATION_PLAN.md) | Phase-by-phase technical roadmap |
| [BEAT_METER_SPECIFICATION.md](../development/BEAT_METER_SPECIFICATION.md) | Beat / meter / polymeter specification |
| [DEV_LEARNING_SITE.md](../development/DEV_LEARNING_SITE.md) | dev 学習サイト project brief + `vitepress-learning-site` skill 運用 overrides |
| [USER_LEARNING_SITE.md](../development/USER_LEARNING_SITE.md) | user 学習サイト project brief + 執筆規律 overrides |

### Dev Learning Site (`sites/dev/`)

dev 学習サイト本体 (VitePress、ローカル参照は `npm run -w sites/dev docs:dev`、deploy は post-ICMC で別 issue):

| Location | Purpose |
|---|---|
| [`sites/dev/`](../../sites/dev/) | dev 学習サイト VitePress プロジェクト、yamato 個人学習ノート |
| [`sites/dev/STYLE_GUIDE.md`](../../sites/dev/STYLE_GUIDE.md) | 章執筆規約 (frontmatter / Sources / 次の深掘り候補 / shallow first pass) |
| [`sites/dev/orientation/architecture-overview.md`](../../sites/dev/orientation/architecture-overview.md) | spike 章 (0-2 アーキテクチャ全景)、status: draft |

### User Learning Site (`sites/user/`)

user 向け学習サイト本体 (VitePress、ローカル参照は `npm run -w sites/user docs:dev`、deploy はコンテンツ完了後に別 issue):

| Location | Purpose |
|---|---|
| [`sites/user/`](../../sites/user/) | user 学習サイト VitePress プロジェクト、初心者向け 10 章 |
| [`sites/user/STYLE_GUIDE.md`](../../sites/user/STYLE_GUIDE.md) | 章執筆規約 (ですます調、子供扱いしない、コードのみ) |
| [`sites/user/index.md`](../../sites/user/index.md) | 章 1 「OrbitScore とは」 (landing 兼ねる) |

### Archived WORK_LOG (`docs/archive/`)

| Period | Archive |
|---|---|
| 2025-09 | [WORK_LOG_2025-09.md](../archive/WORK_LOG_2025-09.md) |
| 2025-10 | [WORK_LOG_2025-10.md](../archive/WORK_LOG_2025-10.md) |
| 2026-02 | [WORK_LOG_2026-02.md](../archive/WORK_LOG_2026-02.md) |
| 2026-04 | [WORK_LOG_2026-04.md](../archive/WORK_LOG_2026-04.md) |

---

## 🧪 Testing (`docs/testing/`)

| File | Purpose |
|---|---|
| [TESTING_GUIDE.md](../testing/TESTING_GUIDE.md) | Unit / integration test procedures |
| [E2E_HARNESS_SPEC.md](../testing/E2E_HARNESS_SPEC.md) | DSL 網羅 E2E ハーネス仕様（仕様書駆動・二重台帳監査・無人実行・改ざん耐性）— #543 の規範 |
| [PERFORMANCE_TEST.md](../testing/PERFORMANCE_TEST.md) | Live coding performance benchmarks |

---

## 🔬 Research (`docs/research/`)

ICMC v1.x の bundle / signing / standalone 検証 (PR #155 で結論を実装に反映済):

| File | Status | Description |
|---|---|---|
| [SCSYNTH_BUNDLE_MANIFEST.md](../research/SCSYNTH_BUNDLE_MANIFEST.md) | ✅ Implemented (#136) | scsynth bundle 構造、26 plugin 同梱 |
| [SCSYNTH_STANDALONE.md](../research/SCSYNTH_STANDALONE.md) | ✅ Implemented (#133) | scsynth standalone 起動検証 |
| [CODESIGN_PIPELINE.md](../research/CODESIGN_PIPELINE.md) | ✅ Implemented (#135) | macOS signing / notarize 戦略 (Apple Dev ID 不要) |
| [ENGINE_DAEMON_PROTOCOL.md](../research/ENGINE_DAEMON_PROTOCOL.md) | 📝 Draft | Rust daemon IPC v0.1 (post-ICMC) |
| [RUST_POC_FINDINGS.md](../research/RUST_POC_FINDINGS.md) | 📝 PoC | Rust audio engine 検証 (post-ICMC) |

### WCTM 調査群（旧前提のスナップショット・凍結）

`docs/research/WCTM_*`（機械の耳・作曲スキル・エージェントハーネス等 7 本）と `docs/specs-v2/DESIGN_DISCUSSION_RECORD.md` は、**旧前提（藝大 2026-08-07・Max 必須）下の調査・議論記録として意図的に凍結**する（記録改変は文脈破壊のため。抜けではない）。本番トラックの retarget（藝大不採択 → ICLC 方向・Max 脱必須。年次・提出日・形態は要確認）は統括 [#413](https://github.com/signalcompose/orbitscore/issues/413) を参照。

---

## 🗺️ Planning (`docs/planning/`)

### Current (active for v1.x)

| File | Purpose |
|---|---|
| [ROADMAP_2026.md](../planning/ROADMAP_2026.md) | 2026 ロードマップ (ICMC Hamburg 2026-05-10 〜 16 を含む) |
| [IMPROVEMENT_RECOMMENDATIONS.md](../planning/IMPROVEMENT_RECOMMENDATIONS.md) | 優先度付き改善提案 |

### Post-ICMC (deferred until after ICMC 2026)

`docs/planning/post-icmc/`:

| File | Purpose |
|---|---|
| [COLLABORATION_FEATURE_PLAN.md](../planning/post-icmc/COLLABORATION_FEATURE_PLAN.md) | マルチユーザー協調機能設計 |
| [ELECTRON_APP_PLAN.md](../planning/post-icmc/ELECTRON_APP_PLAN.md) | スタンドアロン Electron アプリ計画 |
| [RUST_ENGINE_MIGRATION_PLAN.md](../planning/post-icmc/RUST_ENGINE_MIGRATION_PLAN.md) | Rust audio engine 移行ロードマップ |
| [AUDIO_ENGINE_CORE_ARCHITECTURE.md](../planning/post-icmc/AUDIO_ENGINE_CORE_ARCHITECTURE.md) | 3 層分離アーキテクチャ (Core / Plugins / App) |

### Short-term implementation plans (`docs/plans/`)

| File | Purpose |
|---|---|
| [orbit-audio-daemon-phase-1b-1.md](../plans/orbit-audio-daemon-phase-1b-1.md) | Rust daemon Phase 1b 実装計画 |
| [rust-audio-workspace-split.md](../plans/rust-audio-workspace-split.md) | Rust Cargo workspace 構造計画 |

---

## 👥 User documentation (`docs/user/`)

| File | Purpose |
|---|---|
| [user/ja/USER_MANUAL.md](../user/ja/USER_MANUAL.md) | 日本語版ユーザーマニュアル (canonical) |
| [user/ja/GETTING_STARTED.md](../user/ja/GETTING_STARTED.md) | 日本語版スタートガイド |
| [user/en/USER_MANUAL.md](../user/en/USER_MANUAL.md) | English user manual (bundle 反映 TODO) |
| [user/en/GETTING_STARTED.md](../user/en/GETTING_STARTED.md) | English getting started |

---

## 📦 Archived specifications (`docs/archive/`)

DSL 仕様の変遷 (論文執筆・研究用):

| Version | Document | Status |
|---|---|---|
| v3.0 (current) | [INSTRUCTION_ORBITSCORE_DSL.md](INSTRUCTION_ORBITSCORE_DSL.md) | ✅ Active |
| v1.0 (deprecated) | [archive/DSL_SPECIFICATION_v1.0_MIDI.md](../archive/DSL_SPECIFICATION_v1.0_MIDI.md) | 📚 Archived |

---

## 🔗 Quick links

- **Install / use**: [USER_MANUAL.md](../user/ja/USER_MANUAL.md)
- **DSL syntax**: [INSTRUCTION_ORBITSCORE_DSL.md](INSTRUCTION_ORBITSCORE_DSL.md)
- **Project rules**: [PROJECT_RULES.md](PROJECT_RULES.md)
- **Recent dev log**: [WORK_LOG.md](../development/WORK_LOG.md)
- **GitHub Releases (`.vsix` download)**: [github.com/signalcompose/orbitscore/releases](https://github.com/signalcompose/orbitscore/releases)
- **Issue tracker**: [github.com/signalcompose/orbitscore/issues](https://github.com/signalcompose/orbitscore/issues)

---

_Last updated: 2026-05-02 (post-ICMC docs refactor, #158)_
