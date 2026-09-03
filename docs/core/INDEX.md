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
| [625-effect-replacement-design.md](../archive/design/625-effect-replacement-design.md) | #625 | effect insert の差し替え・削除（同一スロットで建て直す） |
| [628-effect-chain-model.md](../archive/design/628-effect-chain-model.md) | #628 | エフェクトチェーンモデル（現在地の実測と到達点） |
| [628-rack-chain-implementation-design.md](../archive/design/628-rack-chain-implementation-design.md) | #628 | ラックチェーンの実装設計 |
| [628-plan-reset.md](../archive/design/628-plan-reset.md) | #628 | 計画の立て直し（Cmd+Click を #633 へ移管） |
| [628-gated-e2e-rack-design.md](../archive/design/628-gated-e2e-rack-design.md) | #628 | ラックの実機 gated E2E 設計 |
| [628-ui-pump-per-index-design.md](../archive/design/628-ui-pump-per-index-design.md) | #628/#633 | `UiEventPump` の per-index / per-window 化 |
| [643-mixer-foundation-design.md](../design/643-mixer-foundation-design.md) | #643 | ミキサーの土台と、その上に乗るオプションの責務分離（instrument を source に） |
| [649-audio-line-design.md](../design/649-audio-line-design.md) | #649 | オーディオライン設計 v3（メソッドチェーン順序 = 決定論） |
| [611-output-line-design.md](../design/611-output-line-design.md) | #611/#649/#543-a/#409/#647 | 出口の一般化 — `output(dest, thru, db)` がライン要素・`SetBusLine`・master ライン（2026-09-03） |
| [694-session-log-editor-path-design.md](../design/694-session-log-editor-path-design.md) | #694/#695/#241 | セッションログをエディタ経路で出し、フレームで 1 選択 1 レコード、`orbitscore replay` で確認 |
| [598-render-endpoint-design.md](../design/598-render-endpoint-design.md) | #598/#241 | render エンドポイント `mix.render(<path>)` × 実時間 stem × オフライン driver（評価列 × 仮想クロック） |
| [672-plugin-boundaries-design.md](../design/672-plugin-boundaries-design.md) | #672/#671/#674/#321/#497 | プラグインの境界 5 本と、残りとしてのコア。DSL Plugin / DSP Plugin 契約の草案 |
| [634-pdc-layer-instrument-rack-design.md](../design/634-pdc-layer-instrument-rack-design.md) | #606/#634/#635/#636/#669 | リリースゲート連鎖: note-off flush → PDC → layer → instrument rack → 標準プラグイン |
| [428-timed-event-queue-design.md](../design/428-timed-event-queue-design.md) | #428/#680/#674/#460 | 時刻付き非オーディオイベントの共通 queue（note / param / 種 B の consumer） |
| [610-diagnostics-applicability-design.md](../design/610-diagnostics-applicability-design.md) | #610/#644/#645 ほか | 「何が書けて何が書けないか」の単一表・演奏中の throw 封じ込め |
| [662-performance-and-visibility-design.md](../design/662-performance-and-visibility-design.md) | #662 A-E/#661/#667/#663/#156 | 可視化・設定一覧・性能（何を測るか）— `662-engine-visibility-and-limits.md` の差分 |
| [656-release-design.md](../design/656-release-design.md) | #659/#656/#385/#138 | 配布: ローカルリリース → 署名・公証 → cold-install smoke |
| [668-e2e-foundation-design.md](../design/668-e2e-foundation-design.md) | #668/#650/#630/#543-b/#624/#640/#684 | E2E 基盤: 共通 helper・二重台帳・決定論 |
| [679-input-consistency-check.md](../design/679-input-consistency-check.md) | #679 | 入力（レコーディング）の整合確認のみ（着手しない） |

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
| [ROADMAP_2026.md](../archive/planning/ROADMAP_2026.md) | 2026 ロードマップ (ICMC Hamburg 2026-05-10 〜 16 を含む) |
| [IMPROVEMENT_RECOMMENDATIONS.md](../archive/planning/IMPROVEMENT_RECOMMENDATIONS.md) | 優先度付き改善提案 |
| **[DEVELOPMENT_MAP.md](../planning/DEVELOPMENT_MAP.md)** | 🔴 **現在の正本**: 全 open issue の地図・リリースまでの筋（§3）・未決一覧（§9）（2026-09-03） |
| [IMPLEMENTATION_PLAN_2026-09.md](../planning/IMPLEMENTATION_PLAN_2026-09.md) | 設計文書 11 本の PR 戦略（一方通行の判断・PR 一覧・順序の根拠・段）（2026-09-03） |
| [`USER_OUTCOMES_2026-09.md`](../planning/USER_OUTCOMES_2026-09.md) | 各 PR が完了するとユーザーは何ができるか（plan §1 の PR ごとに 1 行・見え方の凡例つき） |
| [`BUNDLE_BRANCH_WORKFLOW.md`](../development/BUNDLE_BRANCH_WORKFLOW.md) | 束ブランチ運用: 小 PR は統合ブランチへ軽いゲートで、フルレビューと実機検証は束 PR で 1 回（他リポジトリへの導入手順・GitHub stacked PR との違い・参照つき） |
| [2026-09-03-issue-triage.md](../planning/2026-09-03-issue-triage.md) | issue 棚卸し（地図の前段） |

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
