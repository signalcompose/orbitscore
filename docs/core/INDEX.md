# OrbitScore Documentation Index

OrbitScore is a live coding music DSL for VS Code with a bundled SuperCollider audio engine.

**Current release**: v1.1.0 (ICMC 2026 ready) — bundled scsynth, strict path resolver, automated release workflow.
**Supported platforms**: macOS (Apple Silicon, arm64) only. Intel macOS is untested. Windows / Linux is not supported in v1.x.

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
| [PROJECT_RULES.md](PROJECT_RULES.md) | Critical project rules — must-read before contributing |
| [INSTRUCTION_ORBITSCORE_DSL.md](INSTRUCTION_ORBITSCORE_DSL.md) | DSL v3.0 specification — single source of truth |
| [CONTEXT7_GUIDE.md](CONTEXT7_GUIDE.md) | Context7 (external library docs) usage |

---

## 🎯 Active spec set — v1.1 Pitch DSL + Session Log + WCTM (`docs/specs-v2/`)

進行中の v1.1（Pitch DSL / MIDI 出力）・Session Log・WCTM コンサートシステムの正本仕様。
**HTML が正本**（SVG アーキテクチャ図を含むため）。締切 2026-08-07（WCTM 本番）。進捗管理は **GitHub Epic #224**。
読み順は下表の番号通り（指示書 → Pitch DSL → Session Log → WCTM → 議論記録）:

| # | File | Purpose |
|---|---|---|
| 1 | [IMPLEMENTATION_INSTRUCTIONS.html](../specs-v2/IMPLEMENTATION_INSTRUCTIONS.html) | 作業指示書（フェーズ・依存グラフ・委譲方針・Known Decisions §7） |
| 2 | [PITCH_DSL_SPEC_v1.1.html](../specs-v2/PITCH_DSL_SPEC_v1.1.html) | Stage 1 = note DSL（度数 / root / mode / chord / `[ ]` / tie）仕様正本 |
| 3 | [SESSION_LOG_SPEC_v1.html](../specs-v2/SESSION_LOG_SPEC_v1.html) | 記録 `.orbslog`（因果ログ・三重スタンプ・リプレイ）仕様正本 |
| 4 | [WCTM_SYSTEM_SPEC_v1.html](../specs-v2/WCTM_SYSTEM_SPEC_v1.html) | コンサートシステム（Bridge MCP / ランタイム / Link 結合度）仕様正本 |
| 5 | [DESIGN_DISCUSSION_RECORD.md](../specs-v2/DESIGN_DISCUSSION_RECORD.md) | 設計経緯と棄却済み代替案（決定ログ #1-32。判断に迷ったときの参照） |

> ⚠️ §7 Known Decisions（+ 議論記録の決定ログ）は確定済み。**再設計・再議論しない**。

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
