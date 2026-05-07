# OrbitScore Development Work Log

## Project Overview

A design and implementation project for a new music DSL (Domain Specific Language) independent of LilyPond. Supports TidalCycles-style selective execution and polyrhythm/polymeter expression.

## Development Environment

- **OS**: macOS (darwin 24.6.0)
- **Language**: TypeScript
- **Testing Framework**: vitest
- **Project Structure**: monorepo (packages/engine, packages/vscode-extension)
- **Version Control**: Git
- **Code Quality**: ESLint + Prettier with pre-commit hooks

---

## Recent Work

### 6.79 Epic #187: Link Audio docs + VS Code support (Step 3.3 + 3.5) (May 07, 2026)

**Date**: May 07, 2026
**Status**: ⏳ IN PROGRESS（PR #191 draft、 着陸後 review 待ち）
**Branch**: `190-link-audio-dsl-syntax` (consolidated PR)
**Issue**: Epic #187 / Step 3.3 (syntax + completion + diagnostic) と Step 3.5 (docs + examples)

**動機**: 当初は Step 3.x を sub-step ごとに別 PR にする計画だったが、 review 負担最適化のため TypeScript + docs で完結する全 sub-step を PR #191 に統合。 本エントリは Step 3.3 と Step 3.5 のコミットをまとめて記録する。 PR #193 (Step 3.2) は #191 に fast-forward マージして close 済。

**Step 3.5 — DSL spec + examples + E2E checklist** (commit `2879ca1`):

- `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` §8 (DAW Integration) を全面改訂、 §8.1 (Link Audio Output) として正式仕様化:
  - §8.1.1 Global mode declaration (`global.linkAudio([SR])`、 once-per-file、 hardware と排他)
  - §8.1.2 Per-sequence channel binding (`seq.output("name")`、 同名 channel sum)
  - §8.1.3 Plugin lifecycle (scsynth 起動 / 終了 紐づけ、 ランタイム切替は v1.2.0 非対応)
  - §8.1.4 Live 側操作手順
- `examples/10_link_audio.orbs` 新規 (single channel publish / drums bus sum / per-sequence gain+pan の 3 パターン)
- `examples/README.md` チュートリアル一覧と ファイル一覧を更新
- `docs/LINK_AUDIO_E2E_CHECKLIST.md` 新規 (Live 12.4+ + plugin の手動 E2E、 A〜G の 7 セクション + トラブルシュート)

**Step 3.3 — VS Code 拡張対応**:

- `packages/vscode-extension/syntaxes/orbitscore-audio.tmLanguage.json`:
  - global methods に `linkAudio` を追加
  - sequence methods に `output` を追加
  - 両方の patterns で entity.name.function ハイライトに乗せる
- `packages/vscode-extension/src/completion-context.ts`:
  - MethodChainContext に hasLinkAudio / hasOutput フラグ追加
  - global completion に `linkAudio(${1:48000})` を追加 (まだ宣言されていないとき)
  - sequence completion に `output("${1:channel-name}")` を追加 (audio 設定後 + まだ output 未指定時)
- `packages/vscode-extension/src/diagnostics-analysis.ts`:
  - GLOBAL_ONCE_METHODS に `linkAudio` を追加 (existing once-per-file diagnostic を再利用)
  - 新規 `analyzeOutputWithoutLinkAudio()` — `seq.output()` が呼ばれているのに `global.linkAudio()` が宣言されていない場合に警告。 file 全体走査、 行コメント除去、 commented-out も正しく無視
- `packages/vscode-extension/src/extension.ts`:
  - `updateDiagnostics` 末尾に `analyzeOutputWithoutLinkAudio` を wire
- `tests/vscode-extension/diagnostics-analysis.spec.ts`:
  - 新規 8 ケース (analyzeOutputWithoutLinkAudio: 6 ケース + global once linkAudio 重複: 2 ケース)

**検証**: npm test で 314 件 pass / 23 件 skip (累計 +48 件、 regression なし)。 husky pre-commit hook で全 commit が lint + format + build pass。

**Step 3 consolidated PR (#191) の最終姿**:
- Step 3.1 DSL syntax (4 commits)
- Step 3.2 dispatch wiring (5 commits、 旧 PR #193 から fast-forward)
- Step 3.5 docs + examples (1 commit)
- Step 3.3 VS Code 拡張 (本コミット)
- 計 11+ commits、 約 1500 行の追加 (TypeScript + docs)

**Step 3.4 (動的切替 + latency offset) は本 PR スコープ外** (v1.2.x 持ち越し)。 当初 Issue #190 の checklist にあったが、 着地後の review で必要性を再判断する想定。

**残作業**:
- Step 2: SC plugin (C++ UGen) `OrbitLinkAudioOut` 実装、 別 branch / 別 PR
- Step 4: ブート pipeline での plugin available 検出 + flip、 build pipeline の `.scx` 同梱、 別 PR
- Step 3.4: 動的切替 + latency offset (v1.2.x 検討)

**次の Step**: γ (Step 2.1 SC plugin skeleton) を別 branch / 別 PR で着手。

---

### 6.78 Issue #192 / Epic #187: Link Audio dispatch wiring (Step 3.2) (May 07, 2026)

**Date**: May 07, 2026
**Status**: ⏳ IN PROGRESS（PR draft、 着陸後 review 待ち）
**Branch**: `192-link-audio-dispatch` (stacked on `190-link-audio-dsl-syntax`)
**Issue**: #192 (Step 3.2) / Epic: #187

**動機**: Step 3.1 (#190) で導入した DSL state (`Global._linkAudioEnabled`, `Sequence._outputChannel`) を **実際のスケジューリング経路** に流す。 SC plugin (Step 2) が未実装の段階でも contract layer を完成させ、 plugin 着地時に SynthDef 名と channel ID が噛み合うよう scaffolding を準備する。

**設計方針**:
- outputChannel を optional param として scheduler interface に追加 (完全な後方互換)
- Sequence layer で「Global.linkAudio() 有効時のみ outputChannel を渡す」 判定を一元化 (resolveDispatchChannel)
- EventScheduler.sendPlaybackMessage で 3 通り dispatch:
  1. outputChannel + plugin available → `orbitPlayBufLink` SynthDef + channel arg
  2. outputChannel + plugin missing → `orbitPlayBuf` fallback + 1 回 warn
  3. outputChannel なし → 既存 `orbitPlayBuf`
- plugin available フラグは default false、 Step 4 のブート pipeline で SynthDef discovery 後に true へ flip する想定

**変更内容** (4 commit):

1. `feat(engine): add LinkAudioChannelRegistry for name → channelId mapping` (4b271e5)
   - `packages/engine/src/audio/supercollider/link-audio-channels.ts` (新規)
   - 同名 channel への複数 sequence は idempotent に同じ ID 解決 (sum-by-name 前提)
   - `tests/audio/link-audio-channels.spec.ts` (6 ケース)

2. `refactor(engine): thread outputChannel through scheduler signatures` (d2cfc88)
   - Scheduler interface (`global/types.ts`) に outputChannel?: string optional 追加
   - SuperColliderPlayer / EventScheduler signatures + ScheduledPlay/PlaybackOptions types を拡張
   - 完全な後方互換 (既存呼出は undefined を渡してパス)

3. `feat(engine): dispatch SynthDef based on outputChannel with hardware fallback` (d79968e)
   - EventScheduler に LinkAudioChannelRegistry インスタンス + plugin available フラグ + warn フラグ
   - `setLinkAudioPluginAvailable()` / `isLinkAudioPluginAvailable()` / `getLinkAudioChannelRegistry()` public API
   - sendPlaybackMessage で 3 通り dispatch + plugin 不在時 1 回 warn
   - `tests/audio/link-audio-dispatch.spec.ts` (8 ケース)

4. `feat(engine): wire Sequence dispatch channel to global LinkAudio mode` (125ab5f)
   - Sequence に resolveDispatchChannel() 追加 — linkAudio off ならば undefined 返す
   - ScheduleEventsOptions / ScheduleEventsFromTimeOptions に outputChannel?: string 追加
   - sequence-side helper (`scheduling/event-scheduler.ts`) で scheduler.scheduleEvent / scheduleSliceEvent への thread
   - `tests/core/sequence-link-audio-integration.spec.ts` (4 ケース)

**End-to-end dispatch contract が成立**:

DSL → core → scheduler → plugin の全レイヤーで outputChannel 配線完了:
1. DSL: `seq.output("kick")` (Step 3.1)
2. Core: `Sequence._outputChannel` + `Global._linkAudioEnabled` (Step 3.1)
3. Dispatch decision: `resolveDispatchChannel()` (本 sub-step)
4. Scheduling pipeline: `ScheduleEventsOptions.outputChannel` (本 sub-step)
5. SC Player: `scheduleEvent(..., outputChannel)` (本 sub-step)
6. EventScheduler: SynthDef 名切替 + channel id 解決 (本 sub-step)
7. SC plugin の `orbitPlayBufLink` (Step 2 で実装予定)

**検証**: npm test で 306 件 pass / 23 件 skip (新規 18 件追加)、 regression なし。 husky pre-commit hook で 4 commit すべて lint + format + build pass。

**残作業 (別 sub-issue)**:
- Step 2: SC plugin (C++ UGen) 実装 — `orbitPlayBufLink` SynthDef 提供、 plugin available フラグの flip タイミング Step 4 で wire
- Step 3.3: VS Code 拡張対応 (syntax highlighting、 completion、 厳密 diagnostic)
- Step 3.4: 動的切替 (immediate output) + latency offset
- Step 3.5: docs (`INSTRUCTION_ORBITSCORE_DSL.md`) + examples

**stacked PR の状態**:
- PR #189 (Step 1 research) → main 待ち
- PR #190 (Step 3.1 DSL syntax) → main 待ち
- PR #192 (Step 3.2 dispatch、 本 sub-step) → 190-link-audio-dsl-syntax を base に作成、 #190 が main に landing したら自動 rebase

**次の Step**: Step 1 PR (#189) merge → Step 3.1 PR (#190) merge → 本 PR (#192) merge → Step 2 (SC plugin 実装) 着手。 Step 3.3 / 3.4 / 3.5 は Step 2 と並行可能。

---

### 6.77 Issue #190 / Epic #187: Link Audio DSL syntax (Step 3.1) (May 07, 2026)

**Date**: May 07, 2026
**Status**: ⏳ IN PROGRESS（PR draft、 着陸後 review 待ち）
**Branch**: `190-link-audio-dsl-syntax`
**Issue**: #190 (Step 3.1) / Epic: #187

**動機**: Epic #187 の Step 3.1。 LinkAudio output layer の DSL 表面構文 (`global.linkAudio([SR])` + `seq.output("channel-name")`) を parser・AST・コア state レベルで受理し、 単体テストでカバーする。 SC plugin / dispatch / VS Code 拡張は別 sub-step (3.2 / 3.3 / 3.4 / 3.5) で扱い、 本 Issue は **DSL 表面の文法対応のみ** に絞る。

**設計方針** (Epic #187 §0 を継承):
- LinkAudio mode は once-per-file 宣言で hardware 出力と排他
- `seq.output("name")` は channel name のみ (kind は Global mode から implicit)
- ランタイム切替は v1.2.0 非対応 (immediate 系 `_method()` は本 sub-step では未実装)
- SR 戦略は plugin 内リサンプリング (auto-detect → DSL override → 48k fallback)

**変更内容**:

`packages/engine/src/core/global/link-audio-manager.ts` 新規:
- LinkAudioManager クラス。 _enabled / _targetSampleRate を保持、 linkAudio(targetSR?) で enable

`packages/engine/src/core/global/types.ts`:
- GlobalState に linkAudioEnabled / linkAudioTargetSampleRate を追加

`packages/engine/src/core/global.ts`:
- LinkAudioManager をインスタンス化、 linkAudio(targetSR?) / isLinkAudioEnabled() メソッド追加、 getState() に LinkAudio state を merge

`packages/engine/src/core/sequence.ts`:
- _outputChannel フィールド追加、 output(channelName) メソッド (chainable) + getOutputChannel() アクセサ
- output() 呼出時に Global.linkAudio() 未宣言なら console.warn (例外を投げない、 厳密チェックは Step 3.3 の VS Code diagnostic で)

`packages/engine/src/core/sequence/types.ts`:
- SequenceState に outputChannel?: string を追加

`tests/core/global-link-audio.spec.ts` 新規 (7 ケース):
- default disabled、 有効化、 明示 SR、 44.1k 受理、 chainable、 上書き、 explicit→undefined への戻し

`tests/core/sequence-output.spec.ts` 新規 (7 ケース):
- default undefined、 記録、 chainable、 上書き、 Global 未宣言時 warn、 Global 宣言済み時 warn なし、 hyphen + underscore 受理

`tests/audio-parser/link-audio-syntax.spec.ts` 新規 (8 ケース):
- tokenizer / parser を変更せずに既存 method-call 経路で受理されることを確認
- global.linkAudio() の args の有無 + 値伝播
- seq.output() の hyphen / underscore 受理、 chain 組み合わせ
- 複合プログラム (global.tempo + global.linkAudio + var init + seq chain)

**parser を触らなかった理由**:
既存 tokenizer keyword は `var, init, by, GLOBAL, force, RUN, LOOP, MUTE` のみで、 `linkAudio` / `output` は IDENTIFIER として通る。 AST は generic な `target / method / args` 構造なので追加メソッドのために schema 変更は不要。

**`init` prefix の扱い (要 review)**:
ユーザーレビューで「init global.linkAudio()」 案が選択されたが、 既存 parser では `init` は変数宣言専用 (`var x = init GLOBAL` / `var s = init global.seq`)。 厳密に `init global.linkAudio()` 形を実装するには parser 拡張 (`parseGlobalInit` を method-call 受理に拡張) が必要。 本 PR では既存 conventions (`global.tempo()` 等) と揃った `global.linkAudio()` 形を採用 (parser 拡張不要)。 着陸後の review で「init prefix 必須かどうか」 をユーザー判断仰ぐ。

**コミット構成 (小コミット 3 本)**:
- `68fb4d6` feat(engine): add Global.linkAudio() for LinkAudio mode declaration
- `7cfd85b` feat(engine): add Sequence.output() for LinkAudio channel binding
- `d1ffdcf` test(parser): verify LinkAudio DSL syntax parses via existing generic path

**検証**: npm test で 288 件 pass / 23 件 skip (新規 22 件追加)、 regression なし。 lint-staged hook (eslint + prettier) を 3 commit すべて pass、 build も pass。

**残作業 (別 sub-issue)**:
- Step 3.2: dispatch ロジック (SuperColliderPlayer 側 SynthDef 切替、 channel ID 管理)
- Step 3.3: VS Code 拡張対応 (syntax / completion / 厳密 diagnostic)
- Step 3.4: 動的切替 + latency offset
- Step 3.5: docs (`INSTRUCTION_ORBITSCORE_DSL.md`) + examples

**次の Step**: Step 1 PR (#189) merge → Step 2 (SC plugin 実装) 着手。 Step 3 残 sub-step は Step 2 の進捗と並行可能。

---

### 6.74 Deploy user + dev learning sites to GitHub Pages (May 06, 2026)

**Date**: May 06, 2026
**Status**: ⏳ IN PROGRESS (PR pending)
**Branch**: `claude/review-issues-gyJUJ`
**関連 Issue**: #183 (deploy user site), #165 (deploy dev site), #181 (translation sync gap), #166 Epic (dev learning site)

**動機**: ICMC 2026 Hamburg (5/10-16) の発表に向けて、user / dev 両学習サイトの公開導線を確立する。Twitter / QR / 論文から飛んできた閲覧者が Web 上で内容を読める状態にする。 user は内容完成・dev は「個人学習ノート」 として未完を含むまま公開する方針。

**設計方針**:
- 同一 repo・GitHub Actions deploy・subpath split:
  - user → `https://signalcompose.github.io/orbitscore/`
  - dev → `https://signalcompose.github.io/orbitscore/dev/`
- カスタムドメイン (post-ICMC) は CNAME + `base` 切替で対応可
- dev サイトは未完 (#166 stub 章、#181 ja code comment 残存) を含むまま公開:
  - landing の disclaimer (「個人学習ノート」「code が SoT」) で読者期待値を制御
  - `.translation-glossary.md` で「code 内 ja コメントは byte-identical (英訳しない)」 を明文化
  - `what-is-orbitscore.md` stub には Glossary / ADR-002 への pointer を追加 (迷子防止)

**変更内容**:

Workflow:
- `.github/workflows/deploy-sites.yml` 新規 — `main` の `sites/**` 変更で trigger、 user / dev を 1 artifact に集約 → Pages deploy

VitePress config:
- `sites/user/.vitepress/config.ts` — `base: '/orbitscore/'` 追加
- `sites/dev/.vitepress/config.ts` — `base: '/orbitscore/dev/'` 追加、 KaTeX CSS link を base 込みに更新

Translation glossary (#181 sync gap 対応):
- `sites/dev/.translation-glossary.md` §2 を改訂:
  - 「code 内 ja コメントは byte-identical (英訳しない)」 を明文化、citation 整合を最優先する根拠を記載
  - 「commit message 引用は ja のまま (verbatim quote)」 を追加

Stub 暫定対応 (#166 Epic 残作業):
- `sites/dev/orientation/what-is-orbitscore.md` (ja/en) — stub のまま、Glossary と ADR-002 への pointer を追加、「暫定的な要点」 を 3 行で書き起こし、Epic #166 で yamato 直筆予定を明記

README:
- `README.md` (root) — Learning Sites (web) セクション追加、 4 link
- `sites/user/README.md` — 「公開について」 → 「公開 URL」 に置換、 deploy workflow 説明
- `sites/dev/README.md` — 「公開 URL」 セクション追加、 個人学習ノートとして未完を含むことを明記

**ビルド確認**:
- `npm run docs:build -w @orbitscore/user-site` ✅ 成功 (18.57s)
- `npm run docs:build -w @orbitscore/dev-site` ✅ 成功 (23.92s)
- 生成 HTML の asset href が `/orbitscore/` および `/orbitscore/dev/` で正しく prefix 化されることを確認
- workflow の combine step (user dist → root + dev dist → /dev/) を local 模擬実行、両 index.html 生成確認

**残タスク (post-deploy)**:
- Repo Settings → Pages → Source = "GitHub Actions" を web UI で有効化 (yamato 操作)
- カスタムドメイン取得 + CNAME 設定 + `base` 切替 (post-ICMC、別 PR)
- #181 残作業: 8 ファイルの ja code comment は glossary 改訂で「byte-identical 規律」 として正規化 (修正不要)
- #166 Epic: `what-is-orbitscore.md` の本文完成 (post-ICMC、 yamato 直筆)

### 6.73 Translation prep: i18n setup, glossaries, spike translations (May 06, 2026)

**Date**: May 06, 2026
**Status**: ⏳ IN PROGRESS（マージ前 review 待ち）
**Branch**: `prep-translation-i18n-setup`

**動機**: dev / user 両学習サイトの日英翻訳を効率化するための事前準備。bulk 翻訳は Claude on the Web / CronCreate routine に委ねる前提で、品質と整合性を保証するインフラを Claude Code 側で確立する。

**設計方針**:
- VitePress 標準の i18n 機能を使用（locales: ja root + en）
- 用語ペア・トーン・do-not-translate を `.translation-glossary.md` に明示
- spike 章を Claude Code で完訳して on-the-web の reference template とする
- 章単位 issue で並列翻訳できる workflow

**変更内容**:

`sites/user/`:
- `.translation-glossary.md` 新規（用語ペア、ですます調 → polite English の翻訳例、章タイトル英訳一覧）
- `.vitepress/config.ts` を `locales: { root, en }` 構造に書き換え
- `.vitepress/sidebar.ts` を `sidebarJa` / `sidebarEn` に分離
- `en/` 配下に全 10 章 stub を作成（warning ボックス表示）
- `en/index.md` (章 1) を完訳（spike）
- `en/getting-started/first-sound.md` (章 3) を完訳（spike）

`sites/dev/`:
- `.translation-glossary.md` 新規（user とは別のトーン規律と verbatim 規律を含む、CRITICAL §4）
- `.vitepress/config.ts` を i18n 対応化、README.md を srcExclude に追加
- `.vitepress/sidebar.ts` を `sidebarJa` / `sidebarEn` に分離
- `en/` 配下に全 19 章 stub を作成
- `en/orientation/architecture-overview.md` (spike 章) を sub-agent dispatch で完訳

`docs/development/`:
- `TRANSLATION_WORKFLOW.md` 新規（翻訳 workflow、章単位 issue テンプレ、ローカル実行例）
- `TRANSLATION_STATUS.md` 新規（29 章の進捗 tracker、status 定義、ja 更新時の手順）

**ビルド確認**: 両サイト build クリーン通過。`/en/` 配下の各 stub と spike 章が表示でき、navbar 右上に言語スイッチャーが自動生成されることを確認。

**残タスク（別 issue で扱う）**:
- bulk 翻訳: user 残り 8 章 + dev 残り 18 章（章単位 issue で Claude on the Web に dispatch）
- ja 元更新時の en 自動 outdated 検出（CronCreate routine 化）
- Web デプロイ（GitHub Pages 等）

---

### 6.72 Issue #174: Build user-facing learning site (sites/user/) (May 06, 2026)

**Date**: May 06, 2026
**Status**: ⏳ IN PROGRESS（マージ前 review 待ち）
**Branch**: `174-user-learning-site`
**Issue**: #174

**動機**: ICMC で論文に興味を持った人や VS Code 拡張をインストールしたユーザーが、OrbitScore で実際に音を出してライブコーディングを始められるようにする「優しく丁寧な」初心者向け学習サイトを構築。dev サイト (`sites/dev/`) と並行して、UX 寄りの learning resource を整備する。

**設計方針**:
- 場所: `sites/user/`（VitePress、`@orbitscore/user-site` workspace）
- 言語: 日本語のみ（英語版は別 issue で on-the-web / CronCreate routine で後追い）
- 想定読者: 完全初心者、小学校高学年〜中学生レベルでも理解可能、子供扱いせず
- トーン: ですます調、friendly、kind、親切丁寧
- 表現: コードのみ（動画・GIF・スクリーンショットなし、必要なら Mermaid のみ）
- SoT 関係: `docs/user/ja/USER_MANUAL.md` を primary source として再構成（dev サイトとは異なり code 直接引用ではない）

**章構成（10 章）**:
1. OrbitScore とは（landing 兼ねる）
2. インストール
3. はじめての音
4. パターンを作る
5. 複数のシーケンス
6. ポリメーター・ポリリズム
7. オーディオ操作
8. ライブコーディング
9. リファレンス（チートシート）
10. トラブルシューティング

**変更内容**:

- `docs/development/USER_LEARNING_SITE.md` 新規作成（DEV_LEARNING_SITE.md 形式準拠の project brief）
- `sites/user/` VitePress project 一式を新規作成（package.json、.vitepress/config.ts + sidebar.ts + theme/、STYLE_GUIDE.md、README.md）
- 全 10 章を執筆（sub-agent 並列 dispatch、Group A/B/C で 9 章、spike 章 first-sound.md は手書き）
- `docs/core/INDEX.md` に user 学習サイトの section を追加

**執筆 workflow**:
- spike 章: 章 3 first-sound.md を手書きでトーン基準を確立
- bulk: sub-agent を 3 並列で dispatch（Group A: 章 2, 10 / Group B: 章 4, 5, 6 / Group C: 章 7, 8, 9）
- self-check: ですます調違反、子供扱いトーン、過剰絵文字を grep で検出 → 違反なし

**ビルド確認**: `npm run -w sites/user docs:build` クリーン通過、dead link なし、syntax warning なし。

**別 issue で扱う**:
- 英語版翻訳（dev サイトの英語化と同時に）
- Web デプロイ（GitHub Pages or Vercel）
- マーケットプレイス公開後の install ページ更新

---

### 6.71 Issue #171: Diagnostics for global once-per-file & audioPath ordering (May 06, 2026)

**Date**: May 06, 2026
**Status**: ⏳ IN PROGRESS（マージ前動作確認待ち）
**Branch**: `171-global-once-per-file-diagnostics`
**Issue**: #171
**Version**: 1.1.1 → **1.1.2**

**動機**:
- パス解決の runtime エラーは Output Channel にしか出ず、入力時点で気づきにくい（デモ中だと致命的）
- DSL の意図: `global` の state-setting メソッドは単一情報源、live coding の正攻法は「行を書き換えて再評価」
- `global.audioPath()` は `seq.audio()` より前にないと、絶対化のタイミングがズレる

**設計方針**: VS Code 拡張の静的 diagnostic として実装（parser レベルでは syntax error にできない、構文上は valid）。Engine/parser 一切無変更、テストも無変更。

**変更内容**:

`packages/vscode-extension/src/extension.ts`:
- 既存の `updateDiagnostics()` 関数末尾に 2 つの解析パスを追加
- Analysis 1: `global.<method>()` の重複検出（state-setting 10 メソッド対象）
  - 対象: tempo, beat, audioPath, start, stop, gain, key, normalizer, limiter, compressor
  - 対象外: `init global.seq`, LOOP/RUN/MUTE
  - 2 回目以降の出現に Warning severity の Diagnostic
- Analysis 2: audioPath ordering 検出
  - 最初の `global.audioPath(` 出現位置を取得
  - 各 `\.audio("...")` 呼び出しについて、相対パスかつ audioPath より前に出現または audioPath 不在 → Warning
  - 絶対パス（`/`, `~/`, `C:\`）はスキップ

`package.json` (root) / `packages/vscode-extension/package.json`: 1.1.1 → 1.1.2

`sites/dev/editor/execution-feedback.md`: 「診断のチェック内容は 3 種類」を 5 種類に拡張、新節 4・5 を追加

**テスト結果**: 247 passed / 23 skipped / 270 total（engine 無変更のため）

**マージ前動作確認**:
- once-per-file: tempo 重複に warning、init global.seq / LOOP は warning なし
- ordering: audio() が audioPath() より前で warning、絶対パスはスキップ
- 既存ファイル: `05_live_coding_session.orbs` で tempo 2-3 回目に warning（想定通り）

---

### 6.70 Issue #170: Rename file extension from .osc to .orbs (May 06, 2026)

**Date**: May 06, 2026
**Status**: ⏳ IN PROGRESS（マージ前動作確認待ち）
**Branch**: `170-rename-extension-to-orbs`
**Issue**: #170
**Version**: 1.1.0 → **1.1.1**

**動機**:
- OSC (Open Sound Control) との混同回避（ICMC コミュニティで衝突）
- 論文では拡張子に言及がないため、ICMC 前のいまが切り替えタイミングとして最適
- `.orbs` は orbit との語感連続性、ブランド整合、衝突小

**設計方針**: 後方互換なし（ICMC 前で外部影響限定的、清潔なコードベース優先）

**変更内容**:

ファイルリネーム (82 ファイル、`.osc` → `.orbs`):
- `examples/` (11 ファイル)
- `test-assets/scores/` (66 ファイル)
- `test-audio/` (5 ファイル)

VS Code 拡張:
- `packages/vscode-extension/package.json`: 言語登録の extensions を `.osc` → `.orbs` に変更、version 1.1.0 → 1.1.1

ソースコード（コメント、JSDoc 例、エラーメッセージ）:
- `packages/engine/src/cli-audio.ts`, `cli/execute-command.ts`, `cli/parse-arguments.ts`, `cli/play-mode.ts`
- `packages/engine/src/core/global.ts`, `core/global/audio-manager.ts`, `core/sequence.ts`
- `packages/vscode-extension/src/extension.ts`
- すべてコメント・docstring・エラーメッセージ内の `.osc` 文字列のみ。プログラム的な拡張子チェック（`.endsWith('.osc')` 等）は元から存在せず

ドキュメント:
- `sites/dev/` 6 ファイル更新
- `docs/` (active) 約 15 ファイル更新（archive は意図的に温存）
- `README.md`, `CONTRIBUTING.md`, `examples/README.md`, `test-assets/README.md`, `packages/vscode-extension/README.md`

バージョンバンプ:
- root `package.json`: 1.0.1 → 1.1.1
- `packages/vscode-extension/package.json`: 1.1.0 → 1.1.1

**RC 番号を版番に含めない理由**: VS Code Extension パネルが `1.1.0-rc3` の suffix を表示しないため、複数 .vsix を区別できない。patch を毎回上げる方式に切り替え。

**未更新（意図的）**:
- `docs/archive/WORK_LOG_*.md`: 過去の作業記録、当時の事実として保存
- `CLAUDE.md.backup`: 古い snapshot、編集対象外

**テスト結果**: 247 passed / 23 skipped / 270 total

**.vsix**: `packages/vscode-extension/orbitscore-1.1.1.vsix` (7.18 MB, 2510 files)

**マージ前動作確認**:
- [ ] `.orbs` ファイル開いて syntax highlight が効く
- [ ] `.orbs` ファイルで `Cmd+Enter` (runSelection) 動作
- [ ] `.orbs` ファイル開くと syntax highlight が効かない（プレーンテキスト扱い）
- [ ] CLI `orbitscore-audio play examples/01_getting_started.orbs` 動作

---

### 6.69 Issue #168: Eliminate environment-dependent audio file path resolution (May 06, 2026)

**Date**: May 06, 2026
**Status**: ✅ COMPLETE
**Branch**: `168-audio-path-environment-independence`
**Issue**: #168

**動機**: `audioPath()` および `audio()` のパス解決に `process.cwd()` フォールバックが残っており、開発環境依存（VS Code workspace の有無、エンジン spawn 時の cwd 等）でサイレントに誤解決される懸念があった。デモ時に「音が鳴らない」事故になりうる。

**設計方針**:
- パスは 2 種類のみを許容: 絶対パス、または `.orbs` ファイルからの相対パス
- `process.cwd()` フォールバックを完全排除 → 明示エラー
- `documentDirectory` を常に保証する仕組みを engine / VS Code 拡張 / CLI 各層に整備

**変更内容**:

Engine:
- `packages/engine/src/core/global/audio-manager.ts`: 相対パス + documentDirectory 未設定の場合に明示エラー
- `packages/engine/src/core/sequence.ts`: `audio()` で同様のエラー化
- `packages/engine/src/interpreter/process-statement.ts`: 冗長な防御的解決を削除（`_audioFilePath` は常に絶対パス前提に簡素化）
- `packages/engine/src/core/sequence/scheduling/event-scheduler.ts`: `process.cwd()` フォールバックを assertion に変更
- `packages/engine/src/core/sequence/playback/prepare-playback.ts`: 同上
- `packages/engine/src/interpreter/interpreter-v2.ts`: `execute()` に `documentDirectory` オプションを追加し、global 初期化後に自動セット
- `packages/engine/src/cli/play-mode.ts`: `.orbs` ファイルパスから documentDirectory を自動導出して execute に渡す

VS Code 拡張:
- `packages/vscode-extension/src/extension.ts`: `setDocumentDirectory` の自動注入を「global ブロック評価時のみ」から拡張。`globalInitialized` フラグでセッション状態を追跡し、init 後の任意の評価でもコード先頭に prepend するように変更（`.orbs` ファイル切り替えにも追従）

テスト:
- `tests/core/audio-path-resolution.spec.ts` 新規追加（7 テスト）: 絶対パス受理、documentDirectory 経由解決、未設定エラー、各ケースを網羅
- `tests/core/dsl-v3-underscore-methods.spec.ts`: setUp で `setDocumentDirectory('/tmp/test')` を追加
- `tests/timing/chop-timing.spec.ts`: 同上

ドキュメント:
- `sites/dev/glossary.md`: `setDocumentDirectory` エントリを新仕様に更新（注入タイミング 2 種、CLI 自動導出、フォールバック非存在を明記）
- `sites/dev/pipeline/selective-execution.md`: 注入ロジック節を書き換え
- `sites/dev/editor/execution-feedback.md`: 同上

**テスト結果**: 247 passed / 23 skipped / 270 total

**破壊的変更**: 暗黙の `cwd` 依存で動いていたコードはエラーになる。ICMC 前のため外部影響は限定的と判断。

---

### 6.68 Issue #162: Scaffold dev learning site + spike chapter 0-2 (May 05, 2026)

**Date**: May 05, 2026
**Status**: ✅ COMPLETE (Phase A 完走、Phase B は別 issue)
**Branch**: `162-scaffold-dev-learning-site`
**Issue**: #162

**Work Content**: dev 学習サイトの **Phase A**: VitePress scaffold + spike 章 (0-2 アーキテクチャ全景) を 1 PR で end-to-end。前 PR #161 で skill 導入と project brief は済、本 PR はその次段。

**目的**: skill loop (Phase 4 scaffold → Phase 5 writing → Phase 6 build → Phase 7 verify → Phase 8 advisor audit) が機能するかを 1 章で validate し、Phase B の bulk parallel writing に進む前提条件を確立する。

**新規 / 更新ファイル**:
- 新規: `sites/dev/` (VitePress project root、`type: module`)
  - `package.json` (`@orbitscore/dev-site`、deps: vitepress, vitepress-plugin-mermaid, mermaid, @vscode/markdown-it-katex, katex)
  - `.vitepress/config.ts` (Mermaid + KaTeX 設定、cleanUrls、srcExclude STYLE_GUIDE)
  - `.vitepress/sidebar.ts` (16 章の TOC export)
  - `.vitepress/theme/index.ts` (default theme re-export、Vue component の global 登録は意図的に避けた)
  - `index.md` (landing、 個人学習ノート disclaimer + status table)
  - `STYLE_GUIDE.md` (frontmatter 規約、`## Sources` 規約、`## 次の深掘り候補` 必須、shallow first pass 制約 400-800 行目安、tone)
  - `orientation/architecture-overview.md` (spike 章、status `draft`、書き手 = sub-agent / advisor audit 通過)
  - 残り 15 章 stub (frontmatter `status: stub` + 1 行説明、Phase B で本文)
- 更新: root `package.json` (workspaces に `sites/*` 追加)
- 更新: `.gitignore` (`sites/*/.vitepress/cache/`, `sites/*/.vitepress/dist/`)
- 更新: `docs/core/INDEX.md` (新 section: dev 学習サイト)

**spike 章執筆プロセス**:
1. **Phase 5 (writing)**: general-purpose sub-agent (model: sonnet) を 1 つ dispatch、`packages/engine/src/` 全体構造 + `vscode-extension/src/extension.ts` + `audio/supercollider/scsynth-resolver.ts` 等を primary source として読ませて書かせた
2. **Phase 6 (build)**: 初回 build で 3 dead link 検出 (sub-agent が stub の path を guess していた)、normalize fix
3. **Phase 8 (audit)**: advisor で audit。 1 件 Critical (「Electron renderer」 → 正確には 「Extension Host (Node.js、Renderer から fork)」) + 2 件 Minor (UDP/TCP 不一致、heartbeat → /status query) を flag、すべて修正

**学んだこと (Phase B 設計への反映)**:
- sub-agent の cross-link は **必ず stub の path を読み込ませる** prompt にする (推測しがち)
- advisor audit が conceptual error (process model 誤認) を catch できることが実証された (cross-LLM-family audit に格上げしなくても spike 段階では十分)
- shallow first pass の 1 章は 318 行で overview として機能する。Phase B の他章も同 scale を狙う

**完了条件**:
- [x] `sites/dev/` で VitePress build pass (dead link 0)
- [x] 0-2 章が `status: draft` で完成 (advisor audit critical / minor すべて適用済)
- [x] 残り 15 章が `status: stub` で存在
- [x] STYLE_GUIDE.md 完成
- [x] WORK_LOG / INDEX 更新

**未完了 (yamato 作業)**:
- 0-2 章を読み、code に戻って Sources の line range / code snippet 逐語性を verify
- mental model が更新できたら別 commit で `status: reviewed` に格上げ

**Out of Scope (別 issue)**:
- Phase B: 残り 15 章の bulk writing (Part 別 sub-agent 並列 dispatch)
- Phase C: cross-chapter polish + Glossary 統一 + 深掘り backlog 整理
- Phase D: GitHub Pages deploy (post-ICMC)

---

### 6.67 Issue #160: Install vitepress-learning-site skill (May 05, 2026)

**Date**: May 05, 2026
**Status**: ✅ COMPLETE (infra のみ、scaffold は別 PR)
**Branch**: `160-install-vitepress-learning-skill`
**Issue**: #160

**Work Content**: dev 学習サイト構築 (post-ICMC) の前段として [yuichkun/.claude](https://github.com/yuichkun/.claude/tree/main/skills/vitepress-learning-site) の `vitepress-learning-site` skill を `.claude/skills/` 配下に install。作者承諾済、verbatim copy (上流 commit `66e544d`)。本 PR は infra のみ、サイト本体の scaffold は別 issue で対応予定。

**動機**: LLM 駆動開発で生じる「実装レイヤーの理解の構造的欠落」 (仕様考案 → LLM 実装 → 動作確認、という cycle で実装中に知識が獲得されない問題) を補う仕組み。dev 学習サイトを開発サイクルに組み込むことで、code から explanation を生成 → audit → 著者が読んで編集する loop を回す。

**install 構成** (12 ファイル、verbatim):
- `.claude/skills/vitepress-learning-site/SKILL.md`
- `.claude/skills/vitepress-learning-site/references/*.md` (8 ファイル)
- `.claude/skills/vitepress-learning-site/assets/*` (3 ファイル)

**設計上の決定 (advisor 経由で確定)**:
- `.claude/skills-config/` のような新規 convention を **発明しない** (Claude Code 公式 schema との衝突リスク、discovery が指示ベース、community precedent ゼロ、bus factor 悪化の懸念)
- 代わりに **既存 pattern (project CLAUDE.md → docs/development/ への参照)** を使う
- skill overrides + project brief は [`docs/development/DEV_LEARNING_SITE.md`](DEV_LEARNING_SITE.md) に集約
- CLAUDE.md に `## 🎓 Skill: vitepress-learning-site の運用` section を追加し、skill 起動前に DEV_LEARNING_SITE.md を必ず読む指示を明記

**新規 / 更新ファイル**:
- 新規: `.claude/skills/vitepress-learning-site/` 配下 12 ファイル
- 新規: `docs/development/DEV_LEARNING_SITE.md` (project brief + skill Phase 1-8 overrides)
- 更新: `CLAUDE.md` (skill 運用 section 追加、Documentation Structure list に DEV_LEARNING_SITE エントリ追加)
- 更新: `docs/core/INDEX.md` (Development table に DEV_LEARNING_SITE エントリ追加)
- 更新: 本ファイル (エントリ追加)

**Skill overrides の主要決定** (詳細は DEV_LEARNING_SITE.md):
- audience = self (yamato 自身、実装学習)
- language = 日本語 only (start)、en は post-ICMC で検討
- primary source = own codebase
- site location = `sites/dev/`、章構造は code tree mirror
- external audit = advisor (会話 context) で代替、Codex/Gemini は precondition でない
- 各章 frontmatter に `verified-against: <commit-sha>` 必須 (doc rot を解消ではなく document する artifact framing)
- deploy = post-ICMC で GitHub Pages、initial は local-only

**Out of Scope (別 issue / 別 PR で対応)**:
- dev 学習サイト本体の scaffold (`sites/dev/` の VitePress 設定、章ファイル骨格)
- routine 設計 (PR merge 時の章更新 trigger 等、post-ICMC)
- ICMC 用 minimum user site
- 既存 docs/ から dev/user 両サイトへの段階的移行

---

### 6.66 Issue #137: Marketplace + Open VSX automated publish workflow (May 02, 2026)

**Date**: May 02, 2026
**Status**: ✅ COMPLETE (workflow file 完成、secrets 登録は user 作業)
**Branch**: `137-marketplace-publish-workflow`
**Issue**: #137 (Epic #131 Phase 1 — ICMC v1.0)

**Work Content**: PR #155 (Issue #136 scsynth bundle) マージ完了後の release 自動化。tag push (`v*`) trigger で GitHub Release / VS Code Marketplace / Open VSX に自動 publish する workflow を追加。`-rc` / `-alpha` / `-beta` suffix の prerelease tag は GitHub Release のみ自動化、Marketplace と Open VSX は stable tag のみ。

**実装**:
- `.github/workflows/release.yml` 新規作成 (macos-14 runner)
- pipeline:
  1. checkout + setup-node
  2. `brew install --cask supercollider` (bundle source)
  3. `npm ci` + `npm run build` (engine + extension)
  4. `npm run build:bundle` (scsynth 抽出)
  5. `npm run verify:bundle` (pre-package integrity gate)
  6. `npx vsce package --target $VSIX_TARGET --no-yarn` (currently `darwin-arm64`、env var で集約)
  7. `.vsix` 解凍 → verify-bundle.sh で **post-package signature 維持**確認
  8. tag で release type 判定 (stable iff `^v[0-9]+\.[0-9]+\.[0-9]+$`、それ以外は test/smoke tag も含めすべて prerelease 扱い)
  9. `gh release create` (prerelease/stable + `--generate-notes` で auto changelog)
  10. stable のみ `vsce publish` + `ovsx publish`
  11. GitHub Actions job summary に release 情報

**Security 対策**: `${{ github.ref_name }}` を直接 `run:` で展開せず `env:` 経由で shell 変数として参照 (workflow injection 緩和、参照: github.blog/security/vulnerability-research/)。

**必要 secrets** (user 作業):
- `VSCE_PAT`: VS Code Marketplace publisher token (Azure DevOps PAT)
- `OVSX_PAT`: Open VSX namespace token (Eclipse Foundation アカウント)
- **Apple Developer ID 不要** — SC project の既存 notarized signature を流用 (`docs/research/CODESIGN_PIPELINE.md` で確定)

**動作シナリオ**:
- `git tag v1.1.0 && git push origin v1.1.0` → 全 channel publish
- `git tag v1.1.0-rc4 && git push origin v1.1.0-rc4` → GitHub Release prerelease のみ
- 既存の手動 prerelease (rc1-rc3) も同パイプラインで再現可能

**後続**:
- user による secrets 登録 (`gh secret set VSCE_PAT --repo signalcompose/orbitscore` 等)
- 初回 publisher 取得 (Signal compose、Marketplace + Open VSX)
- 動作確認: 試験 tag (`v0.0.0-test1` 等) で workflow が走るか smoke

---

### 6.65 Issue #136: scsynth bundle integration in vscode-extension (May 02, 2026)

**Date**: May 02, 2026
**Status**: ✅ COMPLETE (PR pending review)
**Branch**: `136-bundle-scsynth-vscode-extension`
**Issue**: #136 (Epic #131 Phase 1 — ICMC v1.0)

**Work Content**: ICMC 2026 リリースの最大インストール障壁 (SC.app の手動 install 強要) を解消するため、scsynth + 26 plugins + libsndfile.dylib (~11.5MB) を `.vsix` に同梱、path resolver を extension/engine 共通化、bundle 不在時の first-run UX を実装。旧 #146 の (1)(2) (bundle 検出 + Notification) を統合 (CodeX レビュー承認、#146 close 済)。

**Version**: 1.0.1 → **1.1.0** (Phase 13 で minor bump、scsynth bundle 同梱は major feature)

**実装** (18 commits、各単独で `npm test` 通過):

| # | Commit | 内容 |
|---|--------|------|
| 1 | `63e298b` | feat(audio): add scsynth path resolver with multi-source fallback |
| 2 | `24a2e5c` | refactor(audio): wire SuperColliderPlayer through scsynth resolver |
| 3 | `a4bad3b` | feat(vscode-extension): add orbitscore.scsynthPath setting and pass to engine |
| 4 | `7880462` | refactor(vscode-extension): unify selectAudioDevice through scsynth resolver |
| 5 | `9663a83` | feat(vscode-extension): add bundle status bar and first-run notification |
| 6 | `aca6450` | feat(build): add scsynth bundle extract/verify scripts and legal placeholders |
| 7 | `e25894d` | docs(worklog,readme): record scsynth bundle integration |
| 8 | `1569110` | refactor(audio): drop SC.app/spotlight fallback from scsynth resolver |
| 9 | `08c2855` | refactor(vscode-extension): align UX with strict bundle requirement |
| 10 | `5f93169` | docs(worklog,readme,build-guide): document strict resolver and dev workaround |
| 11 | `98277db` | docs(platform): scope v1.0 to macOS Apple Silicon only |
| 12 | `bb94fe6` | fix(review): address claude-review feedback (libsndfile LGPL, JSDoc, DRY, dead code) |
| 13 | `58d9825` | docs(extension-readme): restructure for marketplace + bump version to 1.1.0 |
| 14 | `df3e8f7` | refactor(vscode-extension): rename killSuperCollider command to forceKillScsynth |
| 15 | `fbd033a` | fix(vscode-extension): exec→execFile in selectAudioDevice + status bar settings target |
| 16 | `e82e0ef` | fix(vscode-extension): skip engine spawn when scsynth unresolvable (avoid double error notice) |
| 17 | `2f8f4d8` | refactor(vscode-extension): reuse pre-check resolution + execFile for all killall (review minors) |
| 18 | this | docs(legal): embed GPL-3.0 verbatim + NOTICE aggregation clause (closes #139) |

**新規ファイル**:
- `packages/engine/src/audio/supercollider/scsynth-resolver.ts` (resolver 本体、strict mode)
- `tests/audio/scsynth-resolver.spec.ts` (10 unit tests、CI 実行可)
- `scripts/extract-scsynth-bundle.sh` (SC.app 自動 discovery + 26 plugin filter + 検証)
- `scripts/verify-bundle.sh` (`.vsix` 解凍後の signature/permission 確認)
- `packages/vscode-extension/legal/scsynth-LICENSE.GPL-3.0` (#139 placeholder)
- `packages/vscode-extension/legal/scsynth-NOTICE` (GPL-3.0 §6 corresponding source URL 明記)

**Path resolver 仕様** (engine 側に唯一存在、extension は `require` で再利用):
1. `opts.explicit` (caller 明示)
2. `process.env.ORBIT_SCSYNTH_PATH` (extension が settings から渡す)
3. Bundle (`<engine root>/scsynth/Contents/Resources/scsynth`)

**Strict mode の理由** (本 PR レビュー過程で確定): 当初は SC.app fallback と Spotlight も持っていたが、ICMC リリース目標 (「SC が無くても動く」) に対して fallback はテストの意味を曖昧にすると判断。bundle 抽出失敗を SC.app が肩代わりして production の不具合を隠蔽するリスクを排除するため、Phase 8 で fallback を削除。bundle が無ければ即 `ScsynthNotFoundError` で fail loud。各候補で `fs.statSync` + 実行権限ビット (`mode & 0o111`) を検査。`daemon-client.ts:417-433` の `resolveDaemonBinary()` パターン流用。

**Dev workflow への影響**:
- engine 単独 CLI (`npm run dev:engine`) で SC.app に依存していた dev は `ORBIT_SCSYNTH_PATH=/Applications/SuperCollider.app/Contents/Resources/scsynth` を env で渡す
- vscode-extension 経由 (通常 user) は build pipeline で bundle 同梱、何もしなくて OK

**First-run UX** (CodeX 指摘「status bar degraded」反映 + Phase 9 で strict mode 整合):
- StatusBar item (priority 99) で source 別に icon: `bundle` (✅) / `env`/`explicit` (⚙️ custom) / 解決失敗 (❌ error 背景)
- `startEngine()` 実行時に解決失敗 → 毎回 `showErrorMessage` (Open Settings / View Logs)
- 当初設計の "Don't Show Again" dismiss 機構は廃止 (silent fallback がない以上、Notice を黙らせる選択肢自体が不適切)

**リリース戦略** (本 PR レビュー過程で確定):
- ICMC v1.0 初回は **GitHub Release に `.vsix` を添付**して配布、ユーザは ダウンロード + ダブルクリック (or `code --install-extension`) で install
- Marketplace 自動 publish (#137) は ICMC ブロッカーから降格可能 (別 issue で再整理)

**動作環境** (v1.0): **macOS (Apple Silicon)** のみ。bundle scsynth は universal binary だが、Intel Mac は未テスト。Windows / Linux は scsynth bundle に対応 binary が同梱されないため非対応 (cross-platform は将来 issue で扱う)。Marketplace publish 時は `vsce package --target darwin-arm64` で OS gate を明示する想定。

**実機検証 (SC 3.14.1 環境)**:
- `npm run build:bundle` → 11MB bundle 生成、26 plugins、universal arm64+x86_64
- `npm run verify:bundle` → 11/11 checks pass (signature valid、TeamIdentifier=HE5VJFE9E4)
- engine test 240 pass / 23 skipped (resolver 10 新規 + 既存 230 維持、Phase 8 で sc-app/spotlight test 1 件削減)
- TypeScript build clean、ESLint clean

**スコープ外** (本 PR で実装しない):
- #137 Marketplace 自動 publish workflow (リリース戦略変更で ICMC ブロッカーから降格、別 issue で再整理予定)
- #138 cold-install acceptance test (実機 SC-less Mac で別途検証)
- #151 OrbitScore: Check Audio Setup (post-icmc)
- #152 OrbitScore: Open Examples (post-icmc)
- #156 環境変数名統一 (post-icmc、Phase 15 review feedback)

**スコープに吸収** (本 PR で完了):
- #139 LICENSE/NOTICE 文言洗練 → Phase 18 で GPL-3.0 verbatim 同梱 + NOTICE に separate works (OSC IPC) aggregation 明記 + libsndfile LGPL-2.1 区別 (Phase 12)。本 PR マージで #139 close。

**後続**:
- 本 PR マージ → #138 で SC-less Mac の cold-install 検証
- #138 通過 → 手動 GitHub Release で `.vsix` 配布開始
- ICMC 2026 リリース ready

---

### 6.64 Issue #153: pre-edit-check.sh allow plan-mode plan files (May 02, 2026)

**Date**: May 02, 2026
**Status**: ✅ COMPLETE
**Branch**: `153-hook-allow-plans-dir`
**Issue**: #153

**Work Content**: Claude Code plan mode の plan file (`.claude/plans/<name>.md`) 書込が main ブランチで `pre-edit-check.sh` にブロックされ workflow が完結しない問題を解決。Issue #136 (scsynth bundle) の plan 作成中に発見した hook 改善作業。

**実装**:
- `.claude/hooks/pre-edit-check.sh` 修正
  - stdin から `tool_input.file_path` を読み取る処理を追加 (jq 優先、python3 fallback)
  - `case` 判定で `*/.claude/plans/*` パスは早期 `exit 0` で通過
- 既存の main 編集 deny ロジックと branch 命名警告は無改修

**検証**:
- Sanity test 7 ケースすべて pass
  - feature branch + 通常 file → exit 0 (既存通り)
  - feature branch + plan file → exit 0 (新挙動、early allow)
  - 空 stdin / malformed JSON / `tool_input.file_path` 欠落 → exit 0 (graceful)
  - simulated main + plan file → exit 0 (新挙動、early allow)
  - simulated main + 通常 file → deny JSON 出力 + exit 0 (既存通り)

**後続**:
- 本 fix で plan mode workflow が main ブランチでも完結可能に
- 将来 `claude-tools` リポジトリに汎用 branch-protection plugin を作る際の参考実装

---


---

## Archived sections

Older entries have been archived by month for readability:

- [2025-09](../archive/WORK_LOG_2025-09.md)
- [2025-10](../archive/WORK_LOG_2025-10.md)
- [2026-02](../archive/WORK_LOG_2026-02.md)
- [2026-04](../archive/WORK_LOG_2026-04.md)

