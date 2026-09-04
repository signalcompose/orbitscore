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

### fix(studio): declare untrusted-workspace capability so a loose-file launch activates (Sep 4, 2026)

**Issue**: #385（`must-fix`）/ **ブランチ**: `385-untrusted-workspace-capability` / **PR-S-T1**

フォルダ無しの loose-file 起動（`orbs file.orbs` — ライブコーディングの典型動線）は**未信頼の
ad-hoc workspace** を作る。`capabilities.untrustedWorkspaces` を宣言していない拡張はそこで
**制限付き**になり **activate されない**。利用者には「何も起きない」ようにしか見えない。
🔴 **実害は拒否ではなく沈黙である。**

#### 🔴 `supported: true` — ガードは置かない（owner 裁定 + 2026-09-04 の再確認）

裁定（`docs/design/656-release-design.md` §16 (1)）は **`true`**、理由は「一般的な DAW の挙動に
併せて」。DAW はプロジェクトを開く時に信頼を問わずプラグインを読む。`"limited"` は**撤回済み**、
`false` は今日の挙動を宣言するだけで症状が直らない。

⚠️ **設計 §3.3 は撤回された `limited` 前提のまま `startEngine()` にガードを置く形で残っており、
plan の PR 名も "refuse loudly"（大声で断る）のままだった。** そのまま実装すると
**#385 の症状を大声にしただけ**になる。裁定表が「B ならガードが不要になる」と明記しているので、
**ガードは置かない**。

🔴 **さらに owner 確認（2026-09-04）: 確認ダイアログも足さない。**

> 一般的な DAW と同じ形にしないと、ライブコーディング中に毎回読み込みが走る時に、
> 何かが止まったり確認が入ったりすると、**とてもライブコーディングのライブ感が失われます**。
> 音楽制作として使っている時も、**通常の DAW と違うワークフローが顔を出してしまう**。

一度「拒否しないが黙らない」として `instrument(path)` に確認を出す案を出したが、**否定された**。
ライブコーディングは評価を繰り返す行為なので、1 回の確認が「毎回の中断」になる。
**このリポジトリの「沈黙は危険」という規律は失敗が見えないことに対するもので、
成功時の告知にまで拡張してはいけない。** 成功時は既に
`[orbit-effect-rack] child spawned …`（`outproc_effect.rs:671`）、失敗時は
`OUTPROC_ATTACH_FAILED`（`session.rs:2523`）が `get_log` に出ており、**足すものは無かった**。

#### `restrictedConfigurations` は 2 つだけ

基準は「**workspace が値を決めると別の実行ファイルが動く**」もの。`orbitscore.scsynthPath` は
実行ファイルのパスそのもの、`orbitscore.engine` は `sc` に倒すと `scsynthPath` を有効化する。
これは `supported` の値と独立に効く保護で、**ワークフローには一切現れない**。

🔴 `orbitscore.audioDevice` は**入れない** — デバイス名は実行対象を選ばないうえ、
**gated E2E のハーネスが workspace 設定に書く**ので入れると壊れる（設計 §3.2）。

#### 宣言そのものが成果物なので、それを検査するテストを付けた

`tests/vscode-extension/untrusted-workspace-capability.spec.ts`（5 本）。
**4 種類の変異がすべて別々のテストで捕まる**ことを確認した（実出力）:

```
変異A supported=false        → × supports untrusted workspaces …
変異B audioDevice を restrict → × restricts exactly … / × does not restrict settings that name a device …
変異C キーを綴り間違い        → × restricts exactly … / × only restricts settings this extension actually contributes
変異D description から根拠削除 → × explains why evaluation is allowed …
restore 後                    → cmp 一致
```

#### 検証

`npm test` **2201 passed** / 48 skipped ・ `typecheck:e2e` 0 ・ `lint` 0 ・
`check-citations.mjs` **922 verified / 0 failed**（`package.json` に 11 行足したので再アンカー）。

**実機 gated は対象外**。この PR が変えるのは**マニフェストの宣言**で、gated harness は
毎回新しい `--user-data-dir` を作り `--extensionDevelopmentPath` で起動するため、
**untrusted workspace の経路を今の harness では通らない**（設計 §3.5 が「trust の状態を
誰も固定していない」と書いているとおり）。層 2（product.json override・PR-S-T2）と
インストール済み拡張での E2E（§12・E2E-D1）が要る。

---

### docs(design): 詳細設計 11 本と実装プラン 2026-09 を起草 (Sep 3, 2026)

**Issue**: #611 / #694 / #598 / #672 / #634 / #428 / #610 / #662 / #656 / #668 / #679（設計のみ・実装なし）/ **ブランチ**: `claude/elegant-pasteur-l9gdrl`

owner 指示（2026-09-03）: 「① 詳細設計（`docs/design/`）と ② 実装プラン（PR 戦略）を作る。実装はしない。決まっていないところ以外は、そのまま作れる粒度で。曖昧さは owner 裁定待ちに隔離する」。

#### 成果物

| 文書 | 束 |
|---|---|
| `docs/design/611-output-line-design.md` | 出口の一般化（#611/#649/#543-a/#409/#647）— `output(dest, thru, db)`・`AudioLine`・`SetBusLine`・`LineProgram`・master ライン・engine 2ch 固定 |
| `docs/design/694-session-log-editor-path-design.md` | #694（設定 → env・`//#sourceFile`・`<DIR>/`・純度・v2）/ #695（`//#evalBegin/End` フレーム・複数 GLOBAL）/ #241（in-process replay・transport 駆動） |
| `docs/design/598-render-endpoint-design.md` | `mix.render(<path>)`・`%n`・合算 = 解決後パス・`RenderInstance`（実時間 stem）・`RenderScore` v2・評価列 × 仮想クロック driver・P3 差分 |
| `docs/design/672-plugin-boundaries-design.md` | 境界 5 本（3rd-party / 標準 / タップ / 標準シンセ / DSL）と残りのコア・`DslModule` / `HostContext`・2 spec の目次 |
| `docs/design/634-pdc-layer-instrument-rack-design.md` `428-timed-event-queue-design.md` `610-diagnostics-applicability-design.md` `662-performance-and-visibility-design.md` `656-release-design.md` `668-e2e-foundation-design.md` | subagent 起草 → main 検収（裁定の出どころ・path:line・裁定待ちの隔離を確認） |
| `docs/design/679-input-consistency-check.md` | 入力は着手しない裁定。今回の設計に矛盾が無いことを 12 観点で確認 |
| `docs/planning/IMPLEMENTATION_PLAN_2026-09.md` | 一方通行の判断 17 件 → PR 一覧（接頭辞 O/L/R/P/K/Q/D/V/S/E）→ 順序の根拠 → 段 0〜8 |

#### 設計上の主な判断（裁定の範囲内）

- フェーダー = 出口のレベル（裁定 ④）は「乗算 = 出口の op」なので位置ずれのクラスが消える。#649 の原因説明は撤回済み（コメント 1）なので E2E-1 は red-first
- render も log も「譜面からの相対」。`.orbslog` は今日 0 本なので `logVersion: 2` を今出す
- フレーム（`//#evalBegin/End`）は #649 §10.3 と #695 の**同一機構**（PR-L2 の 1 本）
- offline driver は最初から**評価列**を入力にする（`.orbs` = 1 eval・`.orbslog` = transport 順）。前提は Clock DI（core 17 箇所・挙動不変）
- コアは「境界の残り」として**列挙**で確定（#671 コメント 1 の 9:31 と整合）

#### 裁定待ち（設計に混ぜていない）

各文書の末尾節に隔離。地図 §9 の未決 9 件は埋めていない。新規に出た主なもの: `<DIR>/` の名前 / CLI のログ既定 / 数値 `output(n)` の退役 / プレースホルダ語彙 / 実時間 stem の issue の置き場 / A4 実行形態 / transport 書きの競合 / #674 表面 / midi の `output` 拒否。

#### 検証

docs のみ（コード変更なし）。`npm test` は未実行（変更対象外）。issue へは**コメントのみ**（本文・ラベル・close は触っていない）。

#### 追記（同日）: owner 裁定の反映

裁定シート（artifact）で owner が 66 問中 50 問に回答。推奨から変わったもの: 同一宛先の `output` は 2 要素として加算 / `pan` をライン要素に / mono 宛先は L+R マージ / `--until` は高速畳み込みを最初から設計 / `--verify` はイベント sidecar + assets hash / OSC はメッセージ値を `play()` に / `seq.root()` は note-name も受ける / `[...]@v` per-voice 分配 / `chop(n>1)` の tie は伸ばす / child の QoS を TIME_CONSTRAINT へ / node を同梱 / 標準プラグインの実装は WASM スパイク後。各設計文書の裁定待ち節と `IMPLEMENTATION_PLAN_2026-09.md`（W-18〜22・§4）へ反映。相談中 6 件はチャットで提示。

### 追記: Q-694-7 — 今日の `.orbslog` はリプレイに使えるか（実装を実走・同日）

owner: 「ログが出ていた時に再現に使える形になっている様に中身が見えなかった。実装を調べて
ちゃんとリプレイできるのか？それがないとオフラインレンダリングができないのでしっかり見て」

mock backend の `InterpreterV2` に、拡張が stdin へ書く形（`extension.ts:3013-3022` の注入込み）を
`createReplSession().pushLine` で流し、`Date.now` を差し替えてログを生成した（doc 694 §2b）。

**結論: そのままでは再現に使えない。** 欠落 11 件を `path:line` と生成ログの根拠つきで一覧化
（doc 694 §2b.3 G1〜G11）。owner の記憶「中身が見えなかった」は G1（注入で `code` が汚れる）・
G2（`untitled` が cwd に落ちる）・G3（1 行 = 1 eval で選択の形が残らない）の実体。**それに加えて**:

| 発見 | 実測 | 手当 |
|---|---|---|
| **`transport` が音楽時間ではない**（G6） | tempo 120→60 の 10 ms 後の stamp が `1:3.000` → **`1:2.010` に逆行**。LOOP の quantize も同式で「+2990 ms」待った | `TransportTimeline`（PR-L8）。quantize を乗せるかは 🔴 doc 694 §13 (8) |
| **プラグイン状態がログの外**（G7） | `stop()` の auto-snapshot と `//#savePluginState` が同じ相対パスへ上書き（版なし）。replay は後のセッションで上書きされた状態を読む | start/stop で `orbslog/<log>.states/` へ写す（PR-L9・🔴 §13 (9)）。**#598 P3（PR-R8）の前提** |
| 評価の結果・import 本文・MCP 由来の印が無い（G4/G5/G8） | REPL は `//#evalMark` で `ok` を計算済みなのに捨てている | `result` / `import` レコード + フレーム属性（PR-L7）|

plan: PR-L7/L8/L9 追加・PR-L4 は L7/L8 の後・PR-R5 は L8 の後・PR-R8 は L9 の後（W-23/24/25）。

同日の他の反映: Q-598-2 サラウンド → **B-lite**（N ch の render 器 + `output(at:, mono:)`・
エンコードは Logic。doc 598 §3.6・PR-R9）/ Q-610-5 確定（赤線 + その文だけスキップ）/
Q-656-1 `untrustedWorkspaces.supported: true`（DAW に合わせる）/ Q-656-2 #138 独立のまま。

**同日夕・残り 3 問が確定（すべて A・推奨どおり）**: Q-694-3 `--until` 境界ちょうどは適用済み /
Q-694-8 LOOP quantize も `TransportTimeline` に乗せる（tempo 変更後の境界の飛びを修正として記録）/
Q-694-9 プラグイン状態は start/stop で `orbslog/<log>.states/` へ写す。これで裁定シート 66 問は
すべて回答済み。doc 694 §0 に裁定 9〜11 を追加・plan §4 は「裁定待ち 0 件」。

**同日・ユーザー視点の到達点**（owner「各 PR が完了すると何が出来るのかユーザー視点で纏めて」）:
`docs/planning/USER_OUTCOMES_2026-09.md` を追加。plan §1 の 98 PR すべてに「完了するとできること」を
1 行ずつ、見え方（🎵 音・操作 30 / 👀 見える 25 / 🧱 土台 31 / 📄 仕様 12）と段を添えて記載。
「何も変わらない」PR はそのまま書く（土台の PR が続く週はそれが正しい状態）。

**同日・束ブランチ運用の採用**（owner「PR-O のような纏まりで stacked PR を積んで、纏まりが終わってから
レビューチームを走らせるのはどうか」→ 相談の結果、統合ブランチ方式で合意）:
`docs/development/BUNDLE_BRANCH_WORKFLOW.md` を追加。束ごとに統合ブランチを置き、小 PR は
CI + その PR の E2E 実機 + 目視の軽いゲートで入れ、統合ブランチ → main の束 PR で
`/simplify` → レビューチーム + Fable → 実機全件を 1 回だけ回す。束は 1,500 行以下で継ぎ目で切る
（OrbitScore は 7 束・フルレビュー 27 回 → 7 回）。純 stacked PR を採らない理由は squash との相性
（下の層が main に入るたび上の層の rebase が要る）。GitHub の stacked pull requests
（2026-07-30 公開プレビュー）は「層ごとにレビューを増やす」道具で目的が逆、プレビュー中は併用しない。
参照 17 件は URL の実在を確認（docs.github.com 等はプロキシで本文取得不可のため検索要約で確認）。
→ owner 了承（同日）で **#703** として別 PR に。bot の `if` は `claude-code-review.yml` **だけ**
（`code-review.yml` はジョブ名が `code-review` だがテスト CI 本体なので触らない）。plan §2.5 に束の割り当て表を追加。

---

### chore(meta): critical path の 27 issue に実装チェックリストを入れた (Sep 3, 2026)

**Issue**: #697 / **記法**: `docs/core/PROJECT_RULES.md` §1d

owner: 「地図でリンクしてる ISSUE に**実装内容のチェックリスト**を作って、実装時に**ちゃんと終わってるか**、
**終わってなければ理由は何か（変更になった、いらなくなったなど）をトラッキング**できるように」

#### 🔴 要点は「終わらなかった理由が残ること」

チェックが消える／黙って削られると**なぜやらなかったのかが次の人に分からない**。
本日それで実害が出た — **#506 の看板は SC.10.9 で撤回済み**だったのに、撤回が spec 側にしかなく
issue 本文が古いままで、main が **#680 を重複起票**した。

#### 記法（§1d）

```markdown
- [ ] 未着手
- [x] 完了 — PR #NNN / commit `abc1234`
- [x] ~~やらなくなった~~ — 🔴 **不要**: 理由（出どころ: MAP §4.X / #NNN / owner YYYY-MM-DD）
- [x] ~~形が変わった~~ — 🔴 **変更**: 何にどう変わったか（同上）
```

**項目を削除しない** / **完了には PR か commit** / **`[x]` は「解決済み」**（完了も「やらない」も。
**未解決だけが `[ ]`** なので**残数がそのまま残作業**）/ **理由には出どころ** /
🔴 **未決事項をチェックリスト化しない**（決めていないものを「やること」にしない）。

#### 対象 — 27 件（critical path のみ）

#543 #649 #645 #606 #634 #635 #636 #669 #659 #656 #661 #660 #662 #667 #663 #672 #671 #680
#428 #610 #644 #668 #694 #695 #679 #385 #611

**地図が参照する OPEN issue は 117 件**あるが、全件に入れると**更新されないチェックリストが 117 個**できる。

項目は**地図と issue 本文から導いた**。受け入れ基準は可能な限り**実測値**にした
（例: #649 は「`global.gain(-6)` で instrument の RMS が 0.08864 → 0.044」= #649 本文の実測）。

### docs(index): アーカイブ後の INDEX を追従させ、地図を目次に登録 (Sep 3, 2026)

**追従元**: PR #693（マージコミット `b9fad48`）/ **ブランチ**: `claude/docs-sync-pr693`

PR #693 は 9 本を `docs/archive/` へ移し、**現役ファイルからの参照リンクは全部直した**
（`INDEX.md` のリンク先も `../archive/...` に書き換わっている）。追従できていなかったのは
**目次の構造とラベル**の方で、2 点あった。

#### ① 移動した 8 本が「現役」の見出しの下に残っていた

`docs/core/INDEX.md:75-88`（追従前）は、見出し「設計ノート (`docs/design/`)」/
「Planning (`docs/planning/`)」の表に、リンク先だけ `../archive/` へ変わった行が
**現役の行と混在**していた。読者は見出しを信じて表を読むので、**アーカイブ済み文書を
現在の設計として読める**状態が残っていた — #696 が消そうとした「紛らわしいから」
そのものである。

現役（`643` / `649`）と分け、**アーカイブ済みの表を別に立てて「現在の正本」列**を持たせた。
列の値は移動時に各文書へ付けたバナー（例: `docs/archive/design/628-effect-chain-model.md:2`
「**現在の正本**: `SIGNAL_CHAIN_DSL_SPEC_v1.md` **SC.10**」）から採っており、新しい判断はしていない。

#### ② 🔴 `DEVELOPMENT_MAP.md` が目次に無かった

PR #693 が追加した本体（1388 行・**開発計画の正本**）が `INDEX.md` に**1 行も無く**、
Planning 節は**移動済みの 2 本だけ**を挙げていた。`grep` で確認した地図への参照は
リポジトリ全体で `PROJECT_RULES.md:34` の 1 箇所のみ。

地図 §0.2 は「**番号の検索ではなく、地図の見出しで探す**」を運用規則にしているが、
**その地図に目次から辿り着けない**。CLAUDE.md がセッション開始時の必読に挙げるのは
`INDEX.md` なので、ここに無いと運用規則が起動しない。地図と
`2026-09-03-issue-triage.md`（#696 が「現役」と明記）を Planning 節へ登録し、
§0.2 の起票規則を引用で添えた。

#### ③ 棚卸し記録が、同じ PR で覆されたラベル状態を載せたままだった

`docs/planning/2026-09-03-issue-triage.md:115` は「`foundation` と `release-gate` の **2 枚のみ**」と
書き、C5 の表（同 `:96`）は **#197 に `release-gate`** を付けている。PR #693 はこの両方を覆した —
**`must-fix` を新設して 3 枚**にし、**#197 のラベルは外した**（WORK_LOG 上の記述: 「🔴 3 件目は
main の誤り — #197 に `release-gate` を付けたとき #656 と突き合わせていなかった。ラベルを外した」）。

この文書は #696 が「**地図の入力として現役**」と明記して残したものなので、放置すると
現役の文書が古いラベル状態を主張し続ける。**表の行は棚卸し時点の記録として保存**し、
§5 に**追記**として 2 点の変更と「ラベルの現在の状態は地図を見る」を書いた
（`docs/design/` の設計書と同じく、記録の書き換えはしない）。

#### 追従不要と判断した層

- **DSL/言語仕様・ランタイム/MCP・OrbitStudio**: PR #693 の差分 22 ファイルは
  `docs/` と `sites/dev/` のみ。`packages/` の実装は 1 行も無い。唯一の `rust/` の変更は
  `spike_s_concurrent_load.rs:15` の**行コメント内のパス文字列**で、コードではない
- **`sites/dev/`**: 参照パス 6 箇所が ja / en 対で既に直っている（`sites/dev/signal-chain/index.md:27`
  と `sites/dev/en/signal-chain/index.md:28` など）。地図の裁定（出口の一般化・`send` の dB 化）は
  **未実装の決定**であり、dev サイトは実装の解説なので、書くと「実装されていない挙動」の記述になる
- **`sites/user/` / `docs/user/`**: ユーザーが書く語は 1 つも増減していない

---

### chore(docs): 正本が別にできた設計・計画文書を 9 本アーカイブ (Sep 3, 2026)

**Issue**: #696 / **MAP §0.3**

owner: 「仕様検討したドキュメントは、イシューになって地図に書かれたものは**アーカイブ**しておこうか。**紛らわしいから**。」

#### なぜ

同じ主題の文書が複数あると誤読が起きる。**実例**: 本日 main が **#506（plugin-as-method）を読まずに
#680 を重複起票**した。#506 の看板（メソッド形）は **SC.10.9 で撤回済み**だったが、
撤回が spec 側にしかなく issue 本文が古いままだった。

#### 基準 —「正本が別にできたもの」

| 移した文書 | 現在の正本 |
|---|---|
| `628-effect-chain-model.md` | **spec SC.10**（文書自身が「確定・SC.10 として制定済み」と明記） |
| `628-plan-reset` / `628-rack-chain-implementation-design` / `628-gated-e2e-rack-design` / `628-ui-pump-per-index-design` | **#628 / #633 CLOSED**（PR #639 / #652 で出荷済み） |
| `625-effect-replacement-design.md` | **#625 CLOSED**（PR #627） |
| `ROADMAP_2026.md` / `IMPROVEMENT_RECOMMENDATIONS.md` | **`DEVELOPMENT_MAP.md`**（地図 §0.3 が「歴史的スナップショット」と明記） |
| `2026-09-02-feature-map-comments.md` | **地図 §4 各節 + #679 / #680 / #681** |

**残したもの**（issue が OPEN・**正本がまだ他に無い**）: `643-mixer-foundation-design.md`（PR-3 = #645 が残る）/
`649-audio-line-design.md`（設計のみ・実装なし）/ `662-engine-visibility-and-limits.md`（未着手）/
`2026-09-03-issue-triage.md`（地図の入力として現役）。

#### 🔴 参照を全部直した — ここが本体

**移動して参照が切れると、探せなくなって同じ重複が起きる。**

現役ファイル 12 本の参照を書き換え（`INDEX.md` / `INSTRUCTION_ORBITSCORE_DSL.md` / `WORK_LOG.md` /
`DEVELOPMENT_MAP.md` / `SIGNAL_CHAIN_DSL_SPEC_v1.md` / `spike_s_concurrent_load.rs` /
dev サイト 6 本）+ **アーカイブ同士の相互参照 5 本**。

各文書の冒頭に「**アーカイブ。現在の正本は〜。新しい判断の根拠にしないこと**」を付けた。

#### 検証

- **現役ファイルから移動前のパスを指す参照: 0 件**（`grep`）
- `npm run docs:check` **904 引用 / 0 failed**
- `npm run docs:build` dev / user とも成功
- `git diff -M` で**リネームとして検出**（内容は移動・参照のみ書き換え）

---

### docs(planning): 入力の DSL 表面と、入力が入ると変わる性能の性質 (Sep 3, 2026)

**Issue**: #692 / **正本**: `docs/planning/DEVELOPMENT_MAP.md` §4.O.1・§4.P.1

#### 🔴 入力の経路は現在ゼロ（実測）

| | 結果 |
|---|---|
| cpal の入力ストリーム | **0 件**（`build_input_stream` / `default_input` とも） |
| デバイス列挙 | **`list_output_devices` のみ**・`maxOutputChannels` だけ返す |
| `rebuild_output_stream(…buffer_frames, device_name)` | **出力専用**。入力用の対は無い |
| `CallbackTimeStats` / `StreamStats` | **出力コールバックの所要時間**のみ。**往復を測る手段が無い** |
| `input` / `rec` / `record` | **DSL 語彙に 0 件** = 新しい主語 |

**#661 / #660 / #662-A が扱っているのは全部「出力側」。** 入力はデバイスの列挙・選択・レート・
バッファ・統計が**すべて新規**。

#### §4.O.1 入力が入ると変わること（owner 2026-09-03）

> 性能向上とともに**サンプリング周波数の変更やレイテンシー、バッファの調整**が必要になりますよね。
> **特にインプット系があると。**

- 🔴 **レイテンシーが「往復」になる**（入力バッファ + 処理 + 出力バッファ）。
  性能ゴール「64 / 32」は memory の記述が出力バッファと out-of-process の +1 block の話なので
  **片道として読める** → **往復の目標値は未決**（§9・owner 確認）
- **サンプルレートは入出力で一致していなければならない**。#662 の「🔴 再起動」の理由が 1 つ増える
- **入力バッファは新規**（出力は #368 / #662-D と同じ場所）
- **クロックのずれ（drift）は main の推測**。owner は言っておらず実装にも該当なし → **未検証と明記**

**順序への影響**: 入力は「測れるようになってから」だけでなく、**入力自体が測る対象を増やす**。
**#662-B は一度で終わらず、入力が入った後にもう一度広がる。**

#### §4.P.1 入力の DSL 表面（owner のスケッチ・確定ではない）

> サンプリングも**インプットからオーディオが渡される DSL で表現されるべき**なのでは？
> `input.rec(…).effect` のように**順番でドライの録音かウェットの録音かも決められる。**

🔴 **§4.A.1 の規則が入力側にもそのまま効く** — `rec` はライン上の要素で、**位置が dry / wet を決める**:

```
input.rec().effect("Reverb")     ドライを録る
input.effect("Reverb").rec()     ウェットを録る
```

**専用のフラグが要らない。** パンチイン / アウトは **`play()` と同じパターン**（owner 提案）で、
**録音専用の構文も要らない**。

**出口との対称**: `output(宛先, thru, db)` ↔ `rec(パターン, …)`。
**`thru` = 入力モニターは main の読み**（owner は言っていない）と明示。

**未決**（§9・詳細は着手時に詰める・owner「まだ詳細決めきれないとは思うけど」）:
`input` の位置づけ（**文の受け手は今 globals / sequences / mixer nodes の 3 種** — 4 番目にするか
シーケンスの一種か）/ `rec` の引数（`play()` はスライス番号だが録音は 2 値）/ 録ったものの命名（テイク）。

**main の読み**: `input` を #643 の**ソース（feed）の一種**と決めれば、入力ラインは出力ラインと
同じ土台に乗り、`rec` は `output` と同じ資格の要素になる — **対称性がそのまま実装の形になる**。

---

### docs(planning): 設定変数・性能・入力（レコーディング）を地図へ (Sep 3, 2026)

**Issue**: #692 / **正本**: `docs/planning/DEVELOPMENT_MAP.md` §4.H.1・§4.O・§4.P

owner の確認 3 件で、**2 つの欠落と 1 つの分類ミス**が見つかった。

#### ① 設定変数の一覧化（§4.H.1・新設）

owner「設定のところに**変数を取り出して設定する**、とか **MIDI パニックを流すためのボタン**とか入ってる？」

| | 結果 |
|---|---|
| MIDI panic | ✅ 入っている（バッチ C・`midi-output.ts:90` 実装済み・**配線のみ**） |
| 設定変数 | 🔴 **部分的**。#662 が名指しするのは **5 項目**だが、本番ソースの env 変数は **33 個** |

`GetStatus` は**状態だけ**を返す（`session.rs:1349-1360`: version / sample_rate / channels /
loaded_samples / active_plays / uptime / render_contentions）。**設定値は 1 つも返さない。**
起動引数として渡せるのは `--audio-device` と `--list-audio-devices` **だけ**。

**#156（prefix 統一）が一覧化の前提**（`ORBITSCORE_*` 5 / `ORBIT_*` 28 の不統一が表に出る）。
**#694 の実装先が #662 の設定面になる可能性**（`ORBITSCORE_SESSION_LOG` を拡張から渡す手段が無い件）。

#### ② 性能（§4.O・新設）

owner「**マルチスレッドちゃんと使えてる？メモリは有効に使えてる？**」「**性能向上は必要。効率化大事です。**」

🔴 **地図に 1 件も無かった**（grep 0 件）。#667 / #590 / #640 は §4.I に個別の不具合として
入っていただけで、**性能という軸が存在しなかった**。

**owner の 2 つの問いは、いま答えられない** — スレッド構成はソースから読めるが（cpal RT /
audio owner `output.rs:128` / capture writer / tokio / supervisor）、**実測が無い**。

| 分かっていること | 実測値 |
|---|---|
| メモリは**起動時に固定確保** | 64 stage × sample_rate × channels = **2ch@48k で約 24.6 MB**（8ch で 4 倍・`output.rs:1408`） |
| instrument は **1 インスタンス 1 child** | Kontakt 6 台 = child 6。**各 child が 1 コアを食い切る**（#667）→ **実質の上限 = コア数** |
| RT の post-loop | 配列順で**直列**（`output.rs:943-975`）。並列化は未検討 |

**性能は他の裁定の前提**（#663 本文「バッチ B → 本 issue の順。逆にしてはいけない」/
#667 本文「#663 の前にこれを直さないと、上限だけ外して実際には増やせない」）。
順序: **#662-A → #662-B（測る）→ #667（直す）→ #663（外す）**。

#### 上限を決めない — owner の 5 語を定数で照合

| owner の語 | 実体 | #663 の対象か |
|---|---|---|
| トラック数 | `MAX_INSERT_BUS_STAGES = 64` | ✅ |
| インスト数 | `MAX_INSTRUMENT_SLOTS = 32` | ✅ |
| エフェクト数 | ラック内 N に上限定数なし | △ |
| 🔴 **アウトプット数** | **1 ラインの出口 = 1**（`_sumOutputBus` 単一）/ render bus 16 / Link ch 64 | **1 と 16 は #663 に無い** → **§4.A.1 の裁定（複数 `output`）と正面から衝突** |
| パス数 | send は stage 64 に従属 | ✅ |

#### ③ レコーディング = 入力の録音（§4.P・新設）— main の分類ミス

owner「**いやインプットの話したじゃん**」「**リアルタイムサンプリングが自然と Opcode Vision や、
Ableton・Bitwig のようなレコーディング機能になるはずです**」。

🔴 **#679 は「レコーディング機能の前段」ではなく、レコーディング機能そのもの。**
昨日のコメントに「Ableton, Bitwig, Opcode Vision 的なオーディオの扱い」と**既にあった**のに、
地図は引用だけ載せて**結論を書いていなかった**。§4.L の 1 行に埋もれ、「録音」の語で引けなかった。

**スコープへの影響**: 「フレーズを 1 つ録る」だけ作ると、後で録音機能を別に足すことになる。

**「録る」を 3 種に分離**（混ざっていた）:

| | 何を記録するか | 節 |
|---|---|---|
| `.orbslog` + `replay --render` | **評価の記録**（因果）→ 後から音を作り直す | §4.A.3 |
| capture / `output(<file>)` | **出力の音**（現象） | §4.A.3 |
| **#679** | **入力の音**（楽器の演奏）→ DSL の素材 | **§4.P** |

🔴 **capture は engine 起動時にしか指定できない**（`extension.ts:2130` で env・
`StartCapture` / `StopCapture` の RPC は **0 件**）。**演奏中に録る操作が無い**ので、
書き出し側も「レコーディング機能」として未完成。

---

### docs(planning): 退行を守る軸を地図に追加 — 譜面 108 本のうち音が固定されているのは 7 本 (Sep 3, 2026)

**Issue**: #692 / **正本**: `docs/planning/DEVELOPMENT_MAP.md` §4.G.1

owner の指摘「**E2E で既存機能が壊れてないかを守る件は書かれてる？**」→ **書かれていなかった。**
§4.G は「語が E2E に出てくるか」（カバレッジ）だけを扱っていた。

#### 🔴 なぜ致命的か

**本日の裁定はほぼ全部が既存の意味を変える**うえ、全部「**評価は成功するのに音が変わる**」形:

| 裁定 | 壊れ方 |
|---|---|
| `send` を dB へ | `send("rev", 0.3)` の音量が変わる。**エラーは出ない** |
| フェーダー = 出口の属性 | `global.gain()` が効くようになる = **今の音と変わる** |
| master = 出力先の 1 つ | 既定が保てないと**無音か二重** |
| `output` の `thru` | 既定 `false` なら不変の**はず**（要検証） |

`ok` でも `get_log` の ERROR でも捕まらない。**capture の数値でしか見えない。**

#### 実測: 譜面 108 本のうち、音のレベルで固定されているのは 7 本

| 置き場 | 本数 | 音を固定しているか |
|---|---|---|
| `test-assets/scores/` | 66 | ❌ **パースに使うだけ** |
| `examples/` | 24 | `examples/22` の 1 本だけ |
| `test-assets/verify-fixtures/` | 4 | ✅ Leg 1 / Leg 2 |
| `tests/fixtures/mcp-e2e/` | 2 | ✅ gated |
| その他 | 12 | ❌ |

🔴 **mixer（sum / aux / send）・instrument・プラグイン・`global.gain()` を通る譜面の
「この音になる」は 1 本も固定されていない** — **本日の裁定が触るのは全部そこ**。

#### owner 指示（逐語・§4.G.1 の冒頭に置いた）

> また**変異テストが増えて時間ばかり浪費するのは絶対に避けたい**ので E2E テストは重要です。
> **変異テストより「実際に動くか？」を、MCP 経由、つまりユーザーと同じ形でテストする**のが重要です。

これは新方針ではなく **CLAUDE.md の規律の再確認**（地図が引いていなかった）。
検証手段の順位: 1 仕様 → **2 MCP 経由 E2E**（カバレッジ = §4.G / 退行 = §4.G.1）→ 3 機能テスト →
**4 変異検証 = PR 外**（無人 `--in-diff` か週次）。

🔴 **実証が今日の議論のど真ん中**: `global.gain()` が instrument に効かない欠陥を、
**変異 35 件（80 分超）もユニット 2149 件も 1 件も捕まえず、キャプチャ E2E の RMS 実測だけが捕まえた**。
それが **#649** — **今日その設計（フェーダー = 出口のレベル）で消そうとしている当のバグ**。

#### 実装前に固定するもの（順序の条件）

`send` の現在の音 / `global.gain()` の現在の音（**効いていない状態 = バグの記録**）/
`output` を書かない譜面の宛先 / `seq.gain()`。**固定していないと「変わったのが意図した分だけか」を判定できない。**

受け入れ基準は #649 本文の実測がそのまま使える: `global.gain(-6)` で instrument の RMS が
**0.08864 → 0.044**（半分）になること。

#### #543 の分割を提案

#543 の「オフライン決定論層（同一 `.orbs` → ビット一致 PCM・CI 常駐）」が**退行の固定そのもの**。
**(a) 回帰の固定 / (b) 二重台帳（カバレッジ）**に分け、**(a) を裁定の実装より先**に置いた。

---

### docs(planning): 書き出しの筋 — replay がライブとオフラインの橋である (Sep 3, 2026)

**Issue**: #692 / **正本**: `docs/planning/DEVELOPMENT_MAP.md` §4.A.3

owner の問い: 「**アウトプットの音は全てレンダリングできるように。各トラックパラでレンダリングしたり、
マスターをレンダリングしたり**」「**順番ごとに実行するのをどうオフラインレンダリングに繋ぐか**」
「ライブコーディングで作ったものを録音する時にオフラインが要る（例: **840 / 1260**）」。

#### 🔴 答えは既に設計にあった

`SESSION_LOG_SPEC_v1.md` §4:

```
orbitscore replay <log> --render out.wav   # オフラインレンダー（faster-than-realtime）
```

> リプレイヤーはエンジンから見て**もう一人の評価送信者**（VS Code 拡張と同じ口）。
> **エンジン側に専用経路を作らない。** 駆動は **`transport` 時刻**。

**owner の「タイミングが合わない」懸念は、Known Decision で原理的に解けている** —
「リプレイは**音楽時間駆動**（三重スタンプ）」（棄却案: 壁時計駆動・`IMPLEMENTATION_INSTRUCTIONS.md:138`）。

#### 地図の分類ミスを訂正

🔴 **#241（L2 replayer CLI）を §4.M「研究トラック・本番後に実施」に置いていたのは誤り。**
WCTM の文脈でそう書かれていたのを写しただけで、**実際にはライブ → オフラインの橋**である。
**§4.A へ移した**（§2 の全体図も `#598 P2 → #241 replay → #598 P3`）。

#### 書き出しの経路は 3 つあり、違いは「時計」であって「宛先」ではない

| 経路 | 何を書くか | 時計 | 状態 |
|---|---|---|---|
| capture（`ORBIT_CAPTURE_WAV`） | **master 1 本**（`render_block` の post 後 `hw`） | 実時間 | ✅ 実装済み |
| #598 render | per-bus stem | 高速 | **P1 のみ ✅**（`10f3594c`・PR #612）/ P2・P3 ○ |
| `replay --render` | セッション全体（評価列） | 高速 | spec のみ（#241 ○） |

**`replay --render` と #598 は別ではなく積** — `--render` = 何を流すか（ログ = transport 順の評価列）、
#598 P2 = どこへ書くか + 誰が駆動するか。**順序: #598 P2 → #241 → #598 P3。**

🔴 **owner の要求のうち「演奏しながら各トラックをパラで」は今日どこにも無い**（capture は master 1 本、
#598 はオフライン）。`thru: true` が効く場所であり、§7 に新規候補として立てた。

#### 840 / 1260 を録るのに足りないもの

① replayer（#241）② オフライン driver（#598 P2）③ per-bus（P1 ✅）
④ 🔴 **editor 経路のファイル名伝達** — `SESSION_LOG_SPEC_v1.md:80`「editor 経路は現状エンジンへ
ファイル名を渡さない（`setDocumentDirectory` はディレクトリのみ）ため v1 は
**`untitled.<timestamp>.orbslog`** フォールバック。**follow-up**」。
**840 / 1260 はエディタ経路なので、ログの名前が付かず後から特定できない。④ だけ issue が無い。**

#### instrument が render bus を拒否している理由

**出口の問題ではない。** #598 P3（instrument child のオフライン駆動）が要るため。
**出口を一般化しても消えない**（P3 まで `output(n)` は「受理して無音」）。

#### 追加の裁定（owner 2026-09-03）

**A** `send` は残す（機能は `output` と同じ意味論だが名前が直感的）/ **B** `send` も dB へ統一
（🔴 移行の手当ては未決）/ **C** master は `output` の出力先の 1 つ。

---

### docs(planning): 出口の一般化 — owner 裁定 4 件と、機能の持ち方の原理 (Sep 3, 2026)

**Issue**: #692 / **正本**: `docs/planning/DEVELOPMENT_MAP.md` §1b・§4.A.1・§4.N

地図の初版を owner が読み、**昨日・本日の議論の帰結が入っていない**と指摘。順に反映した。

#### 入っていなかったもの

1. **#681（GUI）が §4 に節を持っていなかった** — §1 と §8 に 1 行ずつあるだけで「いつ・何の後にやるか」が読めなかった → **§4.N** を新設
2. **LinkAudio のプラグイン化と「スルー」が繋がっていなかった** — 別々の節に並んでいるだけ
3. **「機能の持ち方」という原理が §4.E に埋まっていた** → **§1b** として上位へ

#### 🔴 §1b — コアは最小に保ち、機能はプラグインで足す

owner「オーディオエンジンの**コア機能以外のプラグイン化・モジュール化や DSL のプラグイン化**などで
**拡張性を担保してかつライセンス問題を解決**しましょう」。

**この立場は 2026-06-30 から存在していた** — `POST_2.0_PLUGIN_STRATEGY` §1「規格に乗れる所は乗り、
自分たちにしか作れない fundamental に希少な開発リソースを寄せる。**§2–§7 はすべてこのメタ原則の
インスタンス**」（引用を一次資料で照合済み）。地図の初版はこれを 1 領域の話として埋めていた。

**ライセンスは目的ではなく帰結。** #671 の拡張点が入れば、LinkAudio は CLAP へ・Link テンポは
DSL Plugin へ出せて **engine 本体から GPL が消える**（「隔離」から「外へ出す」へ）。
**未決**: 「コア」とは何か（`PLUGIN_STRATEGY` は fundamental に audio DSL を含むが、
#671 はその語彙をプラグインで足すと言う。線は #672 で owner 裁定）。

#### 🔴 出口の一般化（§4.A.1）— owner 裁定 4 件

> ラインは要素の列であり、`output(宛先, スルー, レベル)` もその 1 要素。**宛先に特別なものは無い**
> （master / sum / aux / Link / デバイス ch は同じ軸）。**フェーダーは出口のレベルであって段ではない。**

| # | 裁定 | 帰結 |
|---|---|---|
| ① スルーの既定 | **`false`** | 既存譜面の意味が変わらない |
| ② レベルの単位 | **dB** | 🔴 `send("rev", 0.3)` の線形が例外 = **静かに壊れる**（0.3 は線形 -10.5 dB / dB では +0.3 dB）。移行は未決 |
| ③ `output` が aux を指せるか | **指せる** | `send` との差 4 点の最後が消え、**`send` は糖衣になる**（畳むかは未裁定） |
| ④ フェーダーの持ち方 | **`output` の level。`gain` は残す** | `gain` = ライン全体 / `output(db:)` = その宛先へ行く分 |

未決: ⑤ フラグ名（main 推奨 `thru`）/ `send` を畳むか / ② の移行。

#### 検証で分かったこと（すべて一次情報）

- 🔴 **#649 のバグの正体**: master gain は core の render 内で per-frame ramp（`scheduler.rs:444-455`）、
  その**後**に post-loop が stage を `hw` へ**素のまま**加算（`output.rs:958` `*dst += *s`）。
  一方 `send` は同じ合流点で `*d += *s * send.gain`（`:965`）。**同じ場所で send だけが乗算を持つ。**
  level を出口の属性にすると乗算が合流点に固定され、**位置ずれがクラスとして起きえなくなる**
- **「宛先に特別なものは無い」は 2026-07-18 に決定済み**（SC.2.1 `var master = mix.output(1, 2)`・
  規範 (4)「バス自身もレシーバ」・決定 #78「master は出力エンドポイントの予約名」）。**未実装なだけ**
- **AUX の「戻り」は `send` の性質ではなく aux バス自身の性質**（MX.1）。`send` と `output` を分ける理由にならない
- **main の読みが 1 点外れた**: `GainManager` は「ライン全体」でも「master への送り」でもなく、
  `calculateEventGain` で**イベント生成時に畳み込む**（`event-scheduler.ts:106`）= 適用点が発音点

#### engine 側に残る制約（規則では消えない・#611 の仕事）

トポロジの固定順と sum ネスト不可（MX.4）/ master のステレオ固定（`transport.rs:60`）/
LinkAudio とミキサーの相互排他（PH.5）/ PDC 無し（#634）。

---

### docs(planning): 開発計画の地図を制定し、issue をその写像にする (Sep 3, 2026)

**Issue**: #692 / **正本**: `docs/planning/DEVELOPMENT_MAP.md`（Fable 起案・611 行）

#### なぜ作ったか

2026-09-03 の 1 日で main が**同じ内容の issue を 2 回重複起票**した（#686→#218 / #680→#506+#522）。
2 回目は 1 回目の反省を `PROJECT_RULES.md` に書いた**直後**。

owner 判断: **注意力の問題ではなく、121 件を並列に並べたまま順序も包含関係も無いことが原因。
地図を作り、issue をそれに合わせる**（既存番号は活かす = 案 A）。

#### 地図が持つもの

§0 運用規則（**番号ではなく地図の見出しで探す**）/ §1 再設計しない確定事項 / §2 依存グラフ /
§3 リリースまでの筋 / §4 領域別 13 節 / §5 Epic 裁定（**Epic issue は作らない。地図の節がその役割を持つ**）/
§6 統合一覧 / §7 新規候補 / §8 確定事項への提案 / §9 未確認一覧。

#### main の受け入れ検証で確認した 3 件

| Fable の主張 | 検証 |
|---|---|
| #506 のメソッド形は撤回済み → #680 を正本に | ✅ SC.10 規範 (4)「メソッド形で指す形は**撤回する**」（SC.10.9・owner 確定 2026-08-27） |
| #546 の「復元側は 1 行も無い」は古い | ✅ `packages/engine/src/core/project-state-store.ts:122` が `manifest.states[key]` を読む |
| #197 と #656 が矛盾 | ✅ #656 本文に「**vsix は基本リリースしない。**」 |

🔴 **3 件目は main の誤り** — #197 に `release-gate` を付けたとき #656 と突き合わせていなかった。ラベルを外した。

#### owner 決定 2 件（地図に反映）

1. **配布は `.app` と `.vsix` の両方**（Marketplace 経由かは未決）→ #656 の「vsix は出さない」を撤回
2. 🔴 **`must-fix` ラベルを新設** — 「リリースゲートというかバグフィックスで必ずやらないとダメなやつ」。
   `release-gate`（出荷物が成立しない）とは軸が違う。#661 / #606 / #645 / #649 / #385 に付与

---

### docs(index): 棚卸し記録を INDEX の Planning 表に載せる (Sep 3, 2026)

**追従元**: PR #690（マージコミット `84a2e95`）/ **Issue**: #689

PR #690 が追加した `docs/planning/2026-09-03-issue-triage.md` が
`docs/core/INDEX.md` の Planning 表（`docs/core/INDEX.md:213-217`）に載っておらず、
**目次から辿れない**状態だった。INDEX は CLAUDE.md が「すべてのドキュメントの目次（必読）」と
位置づけている入口なので、そこに無い文書は次の棚卸しで**もう一度同じ調査をやり直すことになる**。

行を 1 本足し、クラスタ C1〜C6 の見出しとラベル運用（`PROJECT_RULES.md` §1b）への導線を書いた。

**追従不要と判断したもの**: PR #690 は `packages/` / `rust/` を 1 行も触っていないため、
DSL 仕様（`docs/specs-v2/` / `docs/core/INSTRUCTION_ORBITSCORE_DSL.md`）・ユーザー向け語彙
（`sites/user/`）・内部構造（`sites/dev/`）はいずれも変化していない。

### chore(meta): issue 棚卸し 164→120 とラベル運用の制定 (Sep 3, 2026)

**Issue**: #689 / **記録**: `docs/planning/2026-09-03-issue-triage.md`

open issue が 164 件まで溜まり、タイトルだけでは生死が判別できない状態だった。**1 件ずつ実装と
突き合わせて** 44 件を処理（**164 → 120**）。

#### 🔴 最も古い issue が、最も正しかった

**#218**（2026-05-09）は「閾値超過に気づかないまま WORK_LOG が肥大化する」と予測しており、
**そのとおり 7.5 倍（14,926 行）になった**。しかも本日 main が同じ問題を **#686 として重複起票**
している（起票前の既存確認を怠った）。**タイトルだけ見れば「古い chore」だった。**

→ 棚卸しの作法を `PROJECT_RULES.md` §1c に明文化した（更新日で判定しない／閉じる根拠を残す／
残す場合も現存の証拠を残す／起票前に重複を確認する）。

#### 判定が変わった例

**#92（タイムストレッチ選定）**: `rubato` が入っているので完了に見えるが、**rubato はリサンプラ**で
`fixpitch()` が要求するピッチ保持のストレッチではない。#213 が未実装のまま = **選定は済んでいない**。

#### ラベル運用（`PROJECT_RULES.md` §1b）

🔴 **種別ラベルは足さない。** 164 件中 **162 件がタイトルに Conventional Commits の接頭辞を持つ**ため
二重管理になる。既存ラベルは **20% にしか付いておらず**、`icmc-blocker` のように**過ぎた期限を
名前にしたもの**が腐っていた（`legacy:` へ改名）。

新設は 2 枚のみ: **`foundation`**（他の issue の前提）/ **`release-gate`**（リリース前に必要）。
この 2 枚で「基礎 → その上」の順序が機械的に読め、設計の発注順が決まる。

#### 見えたクラスタ（設計の入力）

個別に着手すると同じ設計を繰り返す群を 6 つ記録した:
**C1 診断の整合**（#280/#644/#610/#255）/ **C2 プラグインの生存管理**（#418/#626/#637/#342）/
**C3 daemon 起動の失敗面**（#129/#383/#130/#367）/ **C4 時間の粒度**（#428/#680/#674）/
**C5 配布**（#656/#197/#184/#385/#659/#321）/ **C6 ミキサーの出力側**（#611/#409/#647/#598）。

🔴 **C4 は不整合が具体的**: パラメータは CLAP も VST3 も**サンプル精度で送れる**のに、
ノートは今も即時メソッド（`engine_wrap.rs:4455` に明記）。

---

### docs: アーカイブで切れた WORK_LOG への相互参照を移動先へ張り替えた (Sep 2, 2026)

**追従元**: PR [#687](https://github.com/signalcompose/orbitscore/pull/687)（merge commit `9ee375b`）/ **Issue**: #686

#### 何が切れていたか

#687 が 6〜8 月の **299 セクション**を `docs/archive/WORK_LOG_2026-0{6,7,8}.md` へ移した結果、
他文書が `docs/development/WORK_LOG.md` §6.xxx と**ファイル名まで名指し**で引いていた箇所が、
**そのファイルにもう存在しない節**を指すようになった。番号は保存されているので、壊れたのは
番号ではなく**パス**である。

#### やったこと

1. **相互参照の張り替え（96 行 / 40 ファイル）**: 行内の節番号がすべて同じアーカイブへ移った 84 行は
   機械置換。07 と 08 にまたがる 12 行（`sites/dev/{,en/}` の glossary / catalog / plugin-ui /
   rust-engine/index / execution-feedback / vscode-architecture）は、境界（07 は 6.347 まで・
   08 は 6.348 から）で分けて手で書き分けた。ja / en 両方
2. **`docs/core/INDEX.md`**: 「Archived WORK_LOG」表に 2026-07 / 2026-08 の行が無かったので追加。
   本体末尾の索引には両方あり、**INDEX.md だけが取り残されていた**
3. **`docs/core/PROJECT_RULES.md` §1a**: アーカイブ手順に「INDEX.md の表も更新する」「名指しの
   相互参照を張り替える」の 2 項を追加。あわせて `docs/WORK_LOG.md` という誤ったパスを
   `docs/development/WORK_LOG.md` へ修正

#### 仕組みの穴（次のアーカイブで同じことが起きる）

`tests/docs/worklog-size.spec.ts` が突合するのは **WORK_LOG.md 末尾の索引と `docs/archive/` の実体**
だけで、`docs/core/INDEX.md` の表も、他文書からの名指し参照も見ていない。今回はどちらも
取り残されていた。§1a に手順として書いたが、**強制はされていない**。

#### 実装・テストは 1 行も触っていない

`packages/` `rust/` `tests/` は無変更（`tests/e2e/orbitstudio-mcp-gated.spec.ts` と
`tests/vscode-extension/mcp-server.spec.ts` の `WORK_LOG 6.189` 等はコメント内の番号のみの
言及で、ファイル名を名指ししていないため対象外）。

### chore(docs): WORK_LOG をアーカイブし、番号を廃止し、閾値をテストで強制した (Sep 2, 2026)

**Issue**: #686 / **このエントリから番号を振らない**（本作業で決めた規則の最初の適用）

#### 何が壊れていたか

`PROJECT_RULES.md` §1a のアーカイブ規則が **7.5 倍破られていた**。

| 規則 | 実測（2026-09-02） |
|---|---|
| 2,000 行 / 100KB を超えたらアーカイブ | **14,926 行 / 1,221 KB** |
| 最新 15-20 セクションを残す | **403 セクション**（うちエントリ 311） |
| 月ごとに `docs/archive/` へ | 最後のアーカイブは **2026-06**。本体が 6/18〜今日を抱えていた |

規則自体は 2025-09 から存在し、`docs/archive/` に 2025-09〜2026-06 の実績もある。
**仕組みが無いまま人の記憶に頼ったため、6 月以降だけ止まっていた。**

#### やったこと

1. **アーカイブ**: 6 月 56 件 / 7 月 168 件 / 8 月 80 件を `docs/archive/WORK_LOG_2026-0{6,7,8}.md` へ。
   本体は 9 月分 7 件のみ（**14,926 → 333 行**）
2. **番号の廃止**: 新規エントリは `### <type>: <要約> (Mon D, YYYY)`。
   🔴 **既存 311 件の番号は消していない**（`WORK_LOG 6.131` 等の既存参照を壊さないため）
3. **閾値の強制**: `tests/docs/worklog-size.spec.ts`

#### なぜ番号をやめたか

**並行作業で衝突する。** 2026-09-02 の 1 日で 3 回発生し、うち 1 回は PR #685 と #682 が
両方 `6.428` を名乗ってマージコンフリクトになり、**`pull_request` のワークフローが
マージコミットを作れず CI が 1 本も起動しなかった**。エラーもチェックも出ないので、
外からは Actions の障害に見えた（実際 6 時間そう疑った）。

**番号を消しても衝突自体は無くならない**（git は挿入位置で判定する）。ただし
「どちらが 6.428 か」を考える必要が消え、両方残して日付順に並べるだけになる。

`.gitattributes` の `merge=union` は**採らなかった** — 既存エントリの編集と追記が重なると
**衝突を報告せずに両方の行を残す**ため（静かに重複が入る）。

**分割案（1 エントリ 1 ファイル）も却下。** この log は「grep で入って周辺を読む」使われ方を
しており（本日 6.423 の「3 failed」を追ったのがまさにそれ）、分割すると周辺が失われる。

#### 検証

- **移動の完全性**: 旧本体のエントリ見出し 311 件が、移動後に**欠落 0・重複 0**
- **変異検証（2 種・実出力を確認）**:
  - 1,800 行を追記 → `stays under 2000 lines` **のみ** red
  - 索引から `2026-07` のリンクを削除 → `keeps the archive index in step` **のみ** red
    （`expected [ 'WORK_LOG_2026-07.md' ] to deeply equal []`）
  - いずれも restore して `cmp` で一致を確認
- `npm test` 2167 passed / 68 skipped / **0 failed**
- `npm run docs:check` 904 引用 0 failed、`npm run lint` 成功

---

### 6.429 docs: chop(1) の訂正をユーザー向け 3 面と dev サイトへ波及させた (Sep 2, 2026)

**追従元**: PR [#683](https://github.com/signalcompose/orbitscore/pull/683)（マージコミット `8157d3d`）/ 関連 #665

#683 は core spec (`docs/core/INSTRUCTION_ORBITSCORE_DSL.md` §3) に
**「スロット合わせが起きるのは `chop(n>1)` の時だけ」**を明記したが、
**同じ誤読を生む記述が下流のドキュメントに残っていた**ので、そこだけを揃えた。
コード・テストは変更していない。

#### 直した箇所

| ファイル | 直前の記述 | 問題 |
|---|---|---|
| `sites/user/basics/audio-manipulation.md`（+ en） | 「`length()` は再生速度を変えるため、音程も連動して変わります」 | 無条件。`chop(1)` では起きない |
| `sites/user/reference/methods.md`（+ en） | `length(N)` …（再生速度・音程が変わる） | 同上 |
| `docs/user/ja/USER_MANUAL.md` | 「`length()`は各イベントの時間を変更し、結果として音程も変化します」「ネストで時間が短くなると…音程が高くなります」 | 同上。例自体は `chop(4)` なので正しいが、地の文が無条件 |
| `sites/dev/scheduling/event-queue.md`（+ en） | `slice` が optional である理由を書いていなかった | 分岐そのものが未記載 |

dev サイトには分岐の実コード
（`packages/engine/src/core/sequence/scheduling/event-scheduler.ts:111-138`）を引用した節を足した。
**`scheduleEvent` が尺もレートも受け取らない**ことが、非 chop 経路で速度を変えられない理由である。

`sites/user/basics/patterns.md:113-114` は**すでに `chop()` で条件付けされていた**ため変更なし。
`docs/user/en/USER_MANUAL.md` は簡約版で該当する主張を持たない。

#### spec 側の参照パスをフルパスにした

#683 が書いた `core/sequence/scheduling/event-scheduler.ts` は basename が一意でない
（`packages/engine/src/audio/supercollider/event-scheduler.ts` が別に存在する）ため、
`packages/engine/src/core/sequence/scheduling/event-scheduler.ts:111-138` へ直した。
この 3 行の挿入で後続行がずれるので、`check-citations.mjs --fix` で
`sites/dev{,/en}/signal-chain/mixer-audio-line.md` の spec 引用 4 本を再アンカーしている
（1658-1662 → 1660-1664 / 1710-1712 → 1712-1714。**行ずれのみで内容は不変**）。

#### 確認済み: `docs/specs-v2/` との食い違いは無い

`specs-v2` 側（PITCH_DSL / SIGNAL_CHAIN / DESIGN_DISCUSSION_RECORD）に
スロット合わせの意味論を述べた記述は無く、core spec の訂正と競合しない。
### 6.428 docs: 6.427 の事実確認表が同じ節の撤回と矛盾していたのを修正 (Sep 2, 2026)

**追従元**: PR #678（マージコミット `70818ad`）/ **ブランチ**: `claude/docs-sync-pr678`

PR #678 の途中コミット `215af35` は unworklet の評価を撤回したが、**撤回したのは
`docs/archive/planning/2026-09-02-feature-map-comments.md` だけ**で、WORK_LOG 6.427 の
「事実確認で判明したこと」表（`docs/development/WORK_LOG.md:33`）は
**撤回前の「ブラウザ前提」を残したまま**マージされた。表の 3 行下（同 :35-41）が
その主張を明示的に誤りと書いているので、**同じ節の中で表と本文が矛盾**していた。

表の行を、撤回後の事実（生成 WASM は何も import しない＝ブラウザ前提ではない）に合わせた。
**評価の内容そのものは 6.427 の本文と `docs/planning/` の記述に従っただけで、新しい判断はしていない。**

#### 追従不要と判断した層

PR #678 の差分は `docs/development/WORK_LOG.md` と `docs/archive/planning/2026-09-02-feature-map-comments.md`
の 2 ファイルのみ。`packages/` `rust/` `sites/` を 1 行も触っていないため、
DSL 仕様・MCP の表面・OrbitStudio の評価フローはいずれも変わっておらず、
`docs/specs-v2/` `docs/core/` `sites/user/` `sites/dev/` の追従先は無い。

🔴 planning 文書が記録した決定（#680 の「DSL はプレーン値」など）は**未実装の設計入力**であり、
`sites/dev/decisions/` の ADR（実装済みのアーキテクチャ決定を記録する場所）へは**書かない**。
実装が入った時点で書く。

---

### 6.427 docs(planning): 機能マップへの owner コメント 9 本を設計の入力へ (Sep 2, 2026)

**Issue**: #677 / **文書**: `docs/archive/planning/2026-09-02-feature-map-comments.md`

アーティファクト上のコメントは repo の外にあり、そのままでは設計の入力にならない。9 本を転記し、
既存 issue との対応・事実確認・詰めるべき点を書いた。**issue の新規起票はしていない**（owner 判断）。

#### 事実確認で判明したこと

| 主張 | 確認結果 |
|---|---|
| Splice に MCP サーバがある | ✅ 公式リモート MCP（`https://mcp.splice.com/mcp`・beta）。検索・stack・ダウンロード |
| `ShmKnd/Patina` | ✅ 実在・MIT。**C++17 標準ライブラリのみ**のアナログモデリング DSP |
| `yuichkun/unworklet` | ✅ 実在・MIT。TypeScript → WASM。**ブラウザ前提ではない**（生成 WASM は何も import しない。下記の撤回を参照） |

🔴 **unworklet について main が最初に書いた反論は誤りだった**（owner の指摘で撤回）。
「AudioWorklet 前提なのでホストが違う・WASM だけ借りても RT 安全性は付いてこない」と書いたが、
`packages/core/src/compile/emit.ts` を読むと **生成 WASM は何も import せず**
（`addFunctionImport` はリポジトリ全体で 0 件）、export は `process` 1 本と成長しない線形メモリだけ。
README 冒頭も "for any audio thread: browser, **server**, or microcontroller"、
`@unworklet/offline` は "pure JS over `WebAssembly.instantiate`"。**RT 安全性はコンパイル時に
証明される WASM 自体の性質**なのでホストを替えても失われない。

→ **Rust ホストからは wasmtime で instantiate してメモリに書き `process` を呼ぶだけ。**
残る作業は `compile/layout.ts` が決める `Layout`（バッファ／パラメータ／state のオフセット）を
**ビルド時に JSON で吐いて `.wasm` と対にする**契約決め。instantiate は RT スレッド外で行い、
sample rate が焼き込まれる点（48kHz）を考慮する。

**unworklet と Patina は競合しない**: 前者は「ユーザーランドに DSP を解放する実行系」、
後者は「同梱する標準プラグインの中身」（#669）。owner の当初の整理どおり。

#### スコープが変わるもの

**#666（Splice）**: LLM は MCP から探してローカルへ落とせるので、OrbitScore はパスを受け取るだけでよい。
「Splice を統合する」→「**ダウンロード先をプロジェクトが解決できる形にする**」へ縮む（#456 と同じ問題）。

#### 起票した 3 件（#679 / #680 / #681）

| issue | 内容 | 状態 |
|---|---|---|
| **#679** | リアルタイム・サンプリング | **設計 issue**。オーディオ入力の経路が現在無い（`capture.rs` は出力方向）。トリガー意味論・録音物の同一性・保存先・位相・分割単位を決めてから実装 |
| **#680** | プラグインのパラメータを DSL から動かす | **CC は不要と判明。** API は両形式にあり、経路も既に通っている（CLAP `effect.rs:239` / VST3 `lib.rs:2534`）。**DSL はプレーン値（案 B）を owner が決定** |
| **#681** | MCP の HTTP 面を使った GUI | **設計 issue**。🔴 **「GUI の操作結果が必ず DSL テキストに落ちる」を owner が前提として明言** |

#### #680 の調査結果

両形式ともパラメータは**サンプル精度**で送れ、**名前・単位・既定値も取れる**
（CLAP `ParamInfo` は `name` / `module`（階層パス）/ `min_value` / `max_value`、
VST3 `ParameterInfo` は `title` / `units` / `stepCount` / `defaultNormalizedValue`）。

🔴 **VST3 には数値としての min/max が無い**（正規化 0..1 のみ）。CAP.6-1 を守るため
DSL をプレーン値に統一し、VST3 側は `getParamValueByString("-6 dB")` で変換する。
書式のプラグイン依存は、`orbit-plugin-scan` のカタログ作成時に両端を引いて範囲を記録して軽減する。

#### owner の手続き上の指摘

機能マップの分類は issue の**タイトルから**起こしたもので、160 件の本文は読んでいない。
棚卸し候補 64 件も更新日だけの判定なので、**閉じる前に中身を読む**必要がある。

---

### 6.426 docs: レビュー指摘の反映 — 引用検証を CI へ、テスト件数を緑の実行から採り直し、`ok` の旧記述を一掃 (Sep 2, 2026)

**ブランチ**: `claude/developer-site-docs-update-0obpim`（PR #673 のレビュー指摘 3 件）

#### ① `docs:check` が誰からも呼ばれていなかった

288 引用中 246 red を 0 にした検証器を入れながら、**どのワークフローからも実行していなかった**。
次に誰かが引用をずらしても知らされない状態だったので、`code-review.yml` に
`npm run docs:check` を追加した。

実際にこの PR 内で機能した: `log-ring.ts` のコメントを 3 行増やしたところ、
`mcp-and-gated-e2e.md:350` の引用（ja / en）が **red になった**。`--fix` で 33-45 → 35-47 へ
再アンカーして 902 引用 0 failed に戻している。

#### ② テスト件数が「3 failed だった実行」の値だった

| | 記録されていた値 | 実測（2026-09-02・macOS 通常ユーザー） |
|---|---|---|
| `npm test` | 2162 passed / 68 skipped / 2233 total | **2165 passed / 68 skipped / 2233 total** |

**2162 + 68 = 2230 で total に 3 足りない。** 差の 3 は 6.423 が正直に記録していた
「root では chmod が効かず EACCES を期待する 3 件が落ちる」で、その**赤い実行の passed 数が
緑の件数として** CLAUDE.md / README / TESTING_GUIDE へ転記されていた。

TESTING_GUIDE に「件数は緑の実行から採る。passed + skipped が total に一致しない数字は、
落ちた分がどこかにある」を注記として残した。

#### ③ `#614` の訂正が正本へ反映されていなかった

IV-3 章は `evaluate_orbitscore` の `ok` の意味が #614 で変わったことを突き止めていたのに、
**`CLAUDE.md` には旧記述が 3 箇所（413 / 614 / 662 行）残っていた**。CLAUDE.md は毎セッション
読まれる運用文書なので、ここが古いと実際に伝播する（本セッションで作成中だったルーチンの
プロンプトにも旧記述が引き写されていた）。

3 箇所と `packages/vscode-extension/src/log-ring.ts` の「唯一のチャネル」コメントを、
**「`ok` は評価時の診断を捉える。評価後に非同期に起きる失敗は今も `get_log` にしか出ない」**
へ更新。IV-3 章（ja / en）の該当段落も、旧コメントが「残っている」から「本 PR で改めた」へ改稿した。

**検証**: `npm test` 2165 passed / 0 failed、`npm run docs:check` 902 引用 0 failed、
`npm run docs:build -w @orbitscore/dev-site` 成功（dead link 0）。

---

### 6.425 chore(rust): rtrb 0.3.4 → 0.3.5 — 新規 advisory RUSTSEC-2026-0274 で PR #673 の deny gate が赤に (Sep 2, 2026)

**発見経路**: docs のみの PR [#673](https://github.com/signalcompose/orbitscore/pull/673) の
「license / dependency gate」（`cargo deny check`）。`rust/README.md` を触ったため `rust/**` の
paths フィルタに掛かって走った。

#### 何が赤だったか

`rtrb 0.3.4` に対する advisory **RUSTSEC-2026-0274**（`ReadChunk::commit` で要素の `Drop` が panic すると
head が進まず double free / use-after-free）。**本 PR の差分とは無関係**（advisory の公開が原因で、
2026-08-29 の直前 PR 群は同じ lockfile で緑だった）。main には push トリガの Rust CI が無いため
「main でも赤」を run で示すことはできないが、同じ `Cargo.lock` である以上 main も同条件。

#### 直し方

advisory の Solution どおり patch bump（`cargo update -p rtrb --precise 0.3.5`）。`Cargo.lock` の 2 行だけ。
0.3.5 は「fix のみ」（0.4.0 は `is_abandoned()` の挙動が変わるため採らない）。

**検証**（Linux コンテナ）: 0.3.4 と 0.3.5 の `src/` を diff して差分が内部の `Drop` ガード追加のみ
（公開 API 不変）であることを確認。ALSA ヘッダを入れて `cargo check -p orbit-audio-native -p orbit-clap-host`
（rtrb の呼び出し側）が成功。`cargo deny` は本環境に無いため、gate の緑は CI で確認する。

---

### 6.424 docs(dev-site): 2026-09 リフレッシュ — 全章を 69dc968 へ再検証し、post-July の 5 章を新設 (Sep 1, 2026)

**ブランチ**: `claude/developer-site-docs-update-0obpim`（6.423 の続き）。各章の ja / en を同一ターンで執筆・
再検証し、`npm run docs:check` が 0 failed であることをコミット条件にした。本エントリは章ごとのコミットで追記する。

#### 総括（2026-09-02 締め）

| 指標 | 導入前（6.423 時点） | 締め |
|---|---|---|
| 章数（ja） | 24 | **29**（新章 SC-1 / SC-2 / PH-2 / PH-3 / IV-3） |
| 引用（header 付きコードブロック・ja + en） | 288 件中 **246 red** | **902 件・0 failed**（58 ファイル） |
| `verified-against` | 0a4b598（2026-05）/ 3983828（2026-07） | 全章 **69dc968**（stub の 0-1 を除く） |
| `npm run docs:build -w @orbitscore/dev-site` | — | 成功（dead link 0） |

**進め方**: 章ごとに 1 サブエージェント（ja / en 同時・引用は `sed -n` で読んでから貼る・チェッカー 0 failed で完了）を
9 体並列に投入し、main は目次・landing・用語集・リポジトリ側ドキュメントを担当。各エージェントの報告から
「既存テキストの誤り」を拾い、spec 側の実装事実開示（PH.1 の段落）だけ本セッションで直した。

**2026-05 版に含まれていた事実誤認（再検証で判明・各章で訂正済み）**: I-1 のトークン数「18」/ II-2 のループ機構
（`setTimeout(patternDuration)`）/ II-4「loop timer は `global.stop()` を生き延びる」/ III-3 の `.gitignore:36` /
IV-2 の `flashLines` 引数。**いずれも通るテストでは見えない種類の誤り**で、引用の機械検証が入ったことで
以後は「行ずれ」として red になる。

**エージェント報告で拾った、コード / 他ドキュメント側の未修正事項（本 PR のスコープ外・要 Issue 化）**:
- `engine-backend.ts:62` が parity の内訳を「WORK_LOG 6.181」と指すが、実体は 6.179（6.181 は WCTM 研究）
- `extension.ts` は cutover を「#369」、engine / WORK_LOG は「#108」と呼んでいる
- `docs/specs-v2/PLUGIN_UI_HOSTING_SPEC_v1.md` UIH.5 の数値 index 形 `seq.ui(1)` は PH.2c（#628）で撤回済み。
  `PLUGIN_UI_IMPLEMENTATION_DESIGN_474.md` の `EVT_SLOTS = 3` は出荷値 2 と不一致
- `INSTRUCTION_ORBITSCORE_DSL.md` PH.4 / SC.3.1 の「effect チェーンの後勝ちは未実装」は #625 / #628 で失効
- `docs/research/ENGINE_DAEMON_PROTOCOL.md` の `ScanPlugins` コマンドは実装では拡張が scanner を spawn する形に変更済み
- `log-ring.ts` / `gated-assertion-hygiene.spec.ts` / CLAUDE.md の「`ok` は stdin へ書けただけ」は #614 以前の文言
  （評価後の非同期失敗が `get_log` にしか出ない点は今も真）
- `parent_watch.rs` の「4 つの child バイナリ」コメント（rack child で 5 つ目）、`output.rs:619` の doc comment 断片、
  `interpreter-v2.ts:171` の "Ensure SuperCollider is booted"
- `EventRingHost::observe_dirty_epoch` の consumer（#577 PR-C debounce）は未配線に見える（`#[allow(dead_code)]`）

**新章の長さ**: SC-1 1564 行 / PH-3 1389 行 / PH-2 1226 行 / IV-3 1022 行 / SC-2 919 行（ja）。STYLE_GUIDE §3 の
400〜800 行目安を超えるが、半分前後が逐語引用で、削ると根拠が落ちるため `status: draft` のまま Phase C で判断する。

**未実行**: 各新章の "Try it" は本セッション（Linux コンテナ・OrbitStudio 無し）では実行しておらず、
`unverified` として明記してある。実機での確認は macOS 側で `npm run test:e2e:gated` と併せて行う。

#### 章ごとのコミット

| コミット | 内容 |
|---|---|
| STYLE_GUIDE | §5 に「path はリポジトリルートからの相対パス（basename 不可）」、§5-bis に機械検証節（`npm run docs:check` / `--fix`）、§10 を「日英バイリンガル必須」へ（2026-07-17 決定の反映漏れ） |
| 0-2 / I-1〜3 再検証 | 0-2 アーキテクチャ全景を**全面書き直し**: 3 プロセス（extension / engine / scsynth）→ 4 種（Extension Host / engine / `orbit-audio-daemon` / plugin children）、`startEngine()` の daemon 事前チェックと `ORBITSCORE_ENGINE` 明示、MCP 節、`resolveDaemonBinaryPath` の探索順、Rust 経路のシーケンス図、version landmarks（DSL v3.0 は構文世代ラベルで `DSL_VERSION 1.1` とは別物）。I-1: トークン 19 → 32（旧版の「18」も誤り）、`import` / `fileImports` / Statement 11 種 / `collapseScopedRun`、`expect()` の REPL 未完判定は `EOF` のみ（#607）。I-2: `AudioEngineBackend`・`execute()` の 6 段順序・mixer namespace ガード・`resolveChainDispatch`。I-3: `writeCodeToEngine()` を MCP と共有、`//#documentDirectory` / `//#evalMark` メタ行、`createReplSession` FIFO（#476）、`\bEOF\b` のみの未完判定（#607 / #612）。引用 132 件 0 failed |
| III-1〜3 / ADR-001〜003 再検証 | SuperCollider 経路 3 章と ADR-001 / 003 は冒頭 `::: warning` で opt-out 経路（`ORBITSCORE_ENGINE=sc`）と明記し、`create-audio-engine.ts` / `engine-backend.ts` を短く引用。III-3: `.gitignore:36` の主張は誤りで `.gitignore:47` + `.vscodeignore:36` へ訂正、engine kind で呼び出し自体が gate される節と `resolveDaemonBinaryPath()` が同じ strict パターンを継承した節を追加。ADR-001 / 003: "Consequences revisited (2026-09)" 節（cutover の parity 根拠 = WORK_LOG 6.179、bundle 温存 = 6.186、daemon の署名は unverified）。ADR-002: `ENGINE_VERSION 2.0.0` / `DSL_VERSION 1.1` を別軸と明記。May 版の snippet は先頭行のインデントが落ちていたため `--fix` が効かず、48 件を手で再引用 |
| IV-1 / IV-2 再検証 | IV-1 をほぼ書き直し: プロセスツリー（daemon / scsynth の分岐）、4 bridge、`activate()` の log-ring monkey-patch と MCP / auto-start、コマンド表（contributed 17 + internal 2、`when` gating）、Activity Bar view、補完 3 系統、`startEngine` の env / spawn / handler、`//#` メタ行と `writeCodeToEngine`、`engine-lifecycle.ts`、#532 SIGKILL 修正、drift 表 15 行。IV-2: `writeCodeToEngine()` + `//#documentDirectory`、`flashLines` の `isWholeLine: true`（旧記述を訂正）、live playhead（`playhead.ts`）、`//#evalMark`、診断 9 種の表と #638 unknown-plugin warning。引用 176 件 0 failed |
| II-1〜4 再検証 | scheduling 4 章（ja / en）を 0a4b598 → 69dc968 へ。II-2: 2026-05 版の「`setTimeout(patternDuration)`」は #389 以降誤りで、`LOOP_TIMER_LEAD_MS`（100 ms 前に発火・絶対グリッドから再計算）と launch quantize × polymeter（`seq.loop()` は**グローバル**小節境界で開始）へ書き換え。II-3: 主線を Rust 経路（`rust-engine-player.ts` の `ScheduledPlay` / 8 段ガード / `[STEP]`・3 段 look-ahead 表）にし、SC 経路は opt-out として残置。`convertGainToAmplitude()` は消失 → `audio-gain-utils.ts`。II-4: `TransportClock` を唯一の時刻原点として記述、launch quantize 節を追加、旧版の「シーケンスの loop timer は `global.stop()` を生き延びる」は**誤り**（`TransportControl.stop()` が先に `sequence.stop()` で `clearTimeout`）と訂正。引用 106 件 0 failed |
| RE-1〜4 + PH-1 再検証 | 2026-07-17 版（3983828 / 5b227da）を 69dc968 へ。RE-1: protocol v0.2 のコマンド表を `match` の腕から再構築（`Command` は enum ではなく `method: String` の struct）、audio owner thread（#484）、`render_shared_block` の `try_lock`。RE-2: `SPAWNABLE_CHILD_BINARIES`（rack child が唯一の到達可能 effect 経路）、`SharedRegion` 末尾（mailbox / evt リング / `active_stage_index`）。RE-3: 「1 seq = 1 insert・.clap のみ」を PH.2b / PH.2d / SC.10 の before / after 表へ、`BusPool` + `EffectChainMap`。RE-4: #651 ヘッダ定期 patch・stale binary ガード・#643。PH-1: DSL 表と format 表（`.vst3` 両ロール可）を再構築。全 10 ファイルをですます調へ。引用 114 件 0 failed |
| PH-3 + 用語集 | `plugin-hosting/catalog.md`（ja 1389 行 / en 1421 行・引用 42 件）。`orbit-plugin-scan` のクラッシュ隔離と atomic write、PC.2 の名前解決（NFC・vendor / format 修飾・CLAP > VST3）、エディタ側 reader / 補完 / 評価前診断（#638）、instrument 差し替え #618（spare slot）、effect 差し替え #625 → #628（in-place rebuild → `ApplyEffectChain` prepare-commit）。用語集 ja / en に Rust Engine / Plugin Hosting・Signal Chain / MCP・E2E の 3 節（23 語）を追加し SC 節を opt-out 経路と明記 |
| 目次・landing | `sidebar.ts`（Part III を Rust Engine に昇格、Part IV Signal Chain / Mixer 新設、SC 経路を Part VII collapsed へ）、`index.md` ja / en、`sites/dev/README.md`、`.plan/refresh-2026-07.md` §8 |
| PH-2 | `plugin-hosting/plugin-ui.md`（ja 1226 行 / en 1245 行・引用 34 件）。`seq.ui()` → TS → daemon → child の配線、Cocoa main-thread 制約と `orbit-child-runtime`、evt リング（`EVT_SLOTS = 2`）と `dirty_epoch`、クローズ状態機械（`Closed` = ドレーン条件）、safepoint (b)、#633 per-window pump。unverified 3 件（timeout 値の根拠・CGWindowList 経路の撤去記録・Try it 未実行）を明記 |
| IV-3 | `editor/mcp-and-gated-e2e.md`（ja / en 各 1022 行・引用 40 件）。拡張内 MCP サーバ（WCTM Agent Bridge の系譜・`ORBITSCORE_MCP_PORT` 優先・25 tool の一覧）、gated E2E ハーネス（stale binary ガード・capture WAV の RMS 判定・ratchet と hygiene）、playhead `[STEP]`。#614 以降 `evaluate_orbitscore.ok` は eval mark を待つが、評価後の非同期失敗は依然 `get_log` にしか出ないことを整理 |
| SC-1 | `signal-chain/index.md`（ja 1564 行 / en 1598 行・引用 51 件）。ラック `[ ]` の値意味論、`RackRecipe`、LCS 差分による再評価、`ApplyEffectChain` wire、`orbit-effect-rack-child` の prepare-commit、標準 `Gain` の dB 契約と CI ゲート。コードの逐語引用が約 900 行を占めるため 800 行目安を超過（draft のまま） |
| SC-2 | `signal-chain/mixer-audio-line.md`（ja 919 行 / en 944 行・引用 40 件）。sum / aux / send / output / master gain。#643 の「master gain が instrument に効かない」は**原因未特定**（WORK_LOG 6.420 が仮説を撤回）として記述し、#649 オーディオラインは設計のみ（HEAD に実装なし）と明記 |

---

### 6.423 docs: リポジトリ側ドキュメントを Rust 既定の実態へ揃え、dev サイト引用の機械検証を導入 (Sep 1, 2026)

**ブランチ**: `claude/developer-site-docs-update-0obpim` / 対象 commit `69dc968`

#### 何が乖離していたか

| ドキュメント | 記述 | 実態 |
|---|---|---|
| `docs/core/INDEX.md` | 「bundled SuperCollider audio engine」、dev サイト deploy は post-ICMC、最終更新 2026-05-02 | Rust daemon が既定（cutover #108）、サイトは稼働中。`docs/design/`・`SIGNAL_CHAIN_DSL_SPEC`・POST_2.0 群・research 9 本が未掲載 |
| `README.md` | SC エンジン前提のタグライン・技術スタック・構成図、テスト 1652 件 | Rust / plugin hosting / mixer が主機能。`rust/`・`sites/`・`tests/e2e/` が構成に無い |
| `rust/README.md` | 「Phase 1a 完了」、crate 4 個 | crate 22 個（children / host / scanner / std-gain / link-audio） |
| `CLAUDE.md` Quick Reference | 「v3.0 (SuperCollider Audio Engine)」、テスト 1333 件 | 2162 passed / 68 skipped（2026-09-01 実測） |
| `INSTRUCTION_ORBITSCORE_DSL.md` §1 / §9 / Implementation Status | 「Initializes AudioEngine with SuperCollider」 | `createAudioEngine()` が既定で `RustEnginePlayer`。SC は `ORBITSCORE_ENGINE=sc` |
| `docs/testing/TESTING_GUIDE.md` | SC を前提条件に列挙、テスト 220 件 | SC は opt-out 経路のみ。実機検証の正本は gated E2E |

**方針**: 仕様（SoT）は再設計せず、**実装事実の開示部分だけ**を直した（§1 の初期化説明・§9 の実装ノート・
Implementation Status のエンジン見出し）。設計・語彙には触れていない。

#### dev 学習サイトの引用の機械検証（`sites/dev/scripts/check-citations.mjs`）

STYLE_GUIDE §5-bis「`// <file>:<start>-<end>` 付きコードブロックは code と文字単位で一致」は
これまで人手の audit（`.audit/sot-verification-2026-05-06.md`）でしか守られていなかった。
CLAUDE.md の「規律を足す時は、同時にそれを守らせる仕組みを足す」に従い、スクリプトへ落とした:

- 全 `.md` の fenced block 先頭行を header として解釈し、`// ...` を省略ワイルドカードとして
  順序付きで突き合わせる。末尾 `// ...` の禁則（range 末尾で終わるのに置く）も検出
- basename だけの header（`types.ts:7-26`）は候補が複数あれば **ambiguous** として red
- `--fix`: snippet が他の行へ**そのまま移動**しただけなら header を再アンカーする（内容の drift は直さない）
- `npm run docs:check`（root）/ `sites/dev` の `docs:check` script として登録

**導入時の実測**: 50 ファイル・288 引用のうち **246 が red**（85%）。`--fix` で 71 件が行ずれとして
再アンカーされ、残り 172 件は内容の drift（SC 経路の関数消失・`event-scheduler.ts` の分割・
Rust 側の関数移動）で、章の再検証が必要な状態だった（次項 6.424 で対応）。

#### 併せて更新

- `docs/development/DEV_LEARNING_SITE.md` §3（ディレクトリの実態）・§7（決定済み / 未決）
- `docs/development/TRANSLATION_STATUS.md`（dev 19 章 → 29 章）
- `CONTRIBUTING.md`（integration test の対象を gated E2E へ）
- `INSTRUCTION_ORBITSCORE_DSL.md` PH.1「v1 の現在地」: #643 反映時に旧文「PR-1a はまだ移設していない」と新文「✅ 実装済み」が同一文に継ぎ合わさっていたのを、時系列が読める形へ整理（SC-2 章執筆エージェントの指摘）

#### テスト実測（2026-09-01・Linux コンテナ・root）

`npm test`: 2162 passed / 68 skipped / **3 failed**。失敗 3 件はいずれも「読めないファイルを EACCES として扱う」
テスト（`tests/interpreter/file-import.spec.ts` 1 件・development docs helpers 2 件）で、**root ユーザーでは
chmod が効かないため**の環境要因。macOS の通常ユーザーでは対象外。

---

## Archived sections

Older entries have been archived by month for readability:

- [2025-09](../archive/WORK_LOG_2025-09.md)
- [2025-10](../archive/WORK_LOG_2025-10.md)
- [2026-02](../archive/WORK_LOG_2026-02.md)
- [2026-04](../archive/WORK_LOG_2026-04.md)
- [2026-05](../archive/WORK_LOG_2026-05.md)
- [2026-06](../archive/WORK_LOG_2026-06.md)
- [2026-07](../archive/WORK_LOG_2026-07.md)
- [2026-08](../archive/WORK_LOG_2026-08.md)

## 2026-09-03: マージ後の head ブランチは自動削除（規則を owner の決定に合わせる）

#702 / #704 のマージで head ブランチが消えているのに気づき owner に確認 → 「増えすぎるし後からでも
追えるので自動で消すようにした」（owner 2026-09-03）。PROJECT_RULES の「ブランチは消さない」
（4 箇所）・CLAUDE.md の Branch Structure・BUNDLE_BRANCH_WORKFLOW（3 箇所）を「マージ後は
GitHub 設定で自動削除・履歴は merge commit から辿る」に訂正。統合ブランチも束 PR のマージ後に
消えてよい（自動削除はマージ後にしか動かないので、小 PR の base が途中で消えることはない）。

## 2026-09-03: PR #704 の追従監査（ドキュメント変更なし・指摘 3 件）

ルーチン「マージ済み PR にドキュメントとサイトを追従させる」を PR #704（`703-bundle-branch-workflow`
→ main・merge commit `3fa1150`）に対して実行。**追従すべきドキュメント変更は 0 件**。

- 差分 6 ファイルはすべて規約文書と CI 定義（`CLAUDE.md` / `docs/core/PROJECT_RULES.md` /
  `docs/development/BUNDLE_BRANCH_WORKFLOW.md` / `docs/planning/IMPLEMENTATION_PLAN_2026-09.md` /
  `docs/development/WORK_LOG.md` / `.github/workflows/claude-code-review.yml`）で、
  `packages/engine/` `rust/` `packages/vscode-extension/` に変更が無い。DSL の構文・意味論、
  MCP ツールの契約、OrbitStudio の評価経路のいずれも変わっていないので、
  `docs/specs-v2/` `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` `sites/user/` `sites/dev/` は追従不要
- `squash` → `merge commit` の訂正は差分内で完結している（リポジトリ全体を grep して、
  規約文書に旧記述の残りは無い。`sites/dev/en/signal-chain/index.md:1230` の "squashed" は
  信号処理の記述で無関係）

**追従できていない点として PR で報告した 3 件**（本ルーチンでは直さない）:

1. `CLAUDE.md:301` と `docs/development/BUNDLE_BRANCH_WORKFLOW.md:70` が小 PR のゲートで
   `ORBIT_GATED_ONLY` を既存の仕組みとして参照しているが、実装が無い。
   実在するのは `ORBIT_GATED_ORBITSTUDIO`（`tests/e2e/orbitstudio-mcp-gated.spec.ts:59`）で
   suite 全体の on/off。`ORBIT_GATED_ONLY` は `docs/design/668-e2e-foundation-design.md:891`
   の決定 D-4（未実装）
2. `.github/workflows/claude-code-review.yml` の最終実行は 2026-06-17（run #278）。
   今回足した `if: github.base_ref == 'main'` の効果を Actions で観測できない
3. PR #704 は最終 head `7f53a5d` の CI 完了を待たずにマージされている
   （CI 開始 10:29:37Z / マージ 10:29:39Z）。赤ではないが、マージ時点では未検証

## 2026-09-03: 束ブランチ運用の採用（#703）

owner との相談（PR #702 セッション）で、レビューの単位を PR から**束**へ変更。小 PR は束の
統合ブランチへ軽いゲート（CI + その PR が足した E2E を実機で + 目視）で入れ、統合ブランチ → main の
束 PR で `/simplify` → `/code:pr-review-team` + Fable → 実機 E2E 全件を 1 回だけ回す。
手引きは `docs/development/BUNDLE_BRANCH_WORKFLOW.md`（PR #702）。

| ファイル | 変更 |
|---|---|
| `CLAUDE.md` | 「PR レビューワークフロー」に「レビューの単位は束」節を追加。マージ前ゲートの対象・禁止事項 2 件・Branch Structure・Quick Workflow |
| `docs/core/PROJECT_RULES.md` | 「Git Workflow and Branch Protection」に統合ブランチと束の手順表・`Part of #N` / `Closes #N` の使い分け |
| `.github/workflows/claude-code-review.yml` | ジョブに `if: github.base_ref == 'main'`。bot レビューは束 PR だけ。`code-review.yml`（テスト CI）は触らない |
| `PROJECT_RULES.md`「Merging PRs」ほか | 🔴 **squash はリポジトリ設定で禁止**（#702 のマージで API が 405 "Squash merges are not allowed" を返した。main の履歴も merge commit）。旧記述の `--squash` を `--merge` に訂正し、束ブランチ運用の文書も merge commit 前提に統一 |

## 2026-09-03: 出口・レンダ宛先・コア境界の裁定を地図と issue に同期

**背景**: 地図 §9 の未決約 40 件を「owner が決めるもの / 調べれば分かるもの」に分けたところ、
出口まわりの数件がその場で裁定された。

**owner 裁定**:

1. **同じ宛先へ 2 回 `output` = 合算**。正確には「**解決後の宛先**が同じなら合算」
2. **master は終端ではなく単にアウト先の 1 つ** — `output(master, thru).output("3,4")` で
   master を 3/4 でモニターできる。🔴 **「終端」という概念が無い**ので、地図 §9 の
   「master ラインの終端の書き方」は**問い自体が消滅**
3. **render の宛先 = エンドポイント宣言**（`var stem = mix.render("stems/%n_%v.wav")`）。
   トラック別は **`%n` テンプレート**で宣言 1 行に畳む
4. **「コア」は先に定義しない。境界を引いた残りがコア**（#672 が「定義待ち」で止まらなくなった）
5. **入力系は今はやらない。** ただし「入力とは instrument が Audio I/O のインプットに
   なっただけ」= 新しい受け手を作らない、という置き場所は決着
6. **ログは ① 出力（#694）→ ② 本当にリプレイできるか確認（#241）→ ③ オフラインレンダ（#598）** の順

**main の誤りと訂正**:

- 「`send(` を使う譜面が 0 本だから移行不要」と書いた。owner 訂正:
  **「実装と実際の利用は関係ない」**。仕様が線形と定めている以上 dB へ直すのは実装の仕事で、
  既存資産の有無とは無関係。地図 §9 の「B の移行の手当て」は**未決ではなく作業**に降格
- (c)（エンドポイント宣言）を推した時、**トラック 30 本なら宣言 30 行**になる後退を見落として
  いた。owner の指摘で `%n` テンプレートに至った

**コードで確認したこと**: `%n` は実装可能。シーケンスは変数への代入時に名前を受け取る
（`packages/engine/src/core/sequence.ts:197-200` の `setName` → `stateManager.setName` +
`global.registerSequence`）。エラー文言も既にそれを使う（同 :354）。追加の記法は要らない。

**記録先**: 地図（§1・§1b.3・§4.A.3.1 新設・§9・§10）と issue #611 / #598 / #672 / #409 /
#679 / #694 の 6 本。issue 側には**実装チェックリストへの追加分**も書いた。

### 追記: 地図がリンクする open issue 70 本にチェックリストを充填（同日）

owner 指示:

> 地図でリンクしてる ISSUE に実装チェックリストを作って、実装時にちゃんと終わってるか、
> **終わってなければ理由は何か（変更になった、いらなくなったなど）をトラッキングできる**ように

6 班（sonnet subagent）に領域ごとに並行委譲。**39 本は同日早い時間に投稿済みだったため
重複を避け、残りに新規投稿**した。`PROJECT_RULES.md` §1d の書式に統一。

🔴 **変異検証はどのチェックリストにも既定で入れていない**（owner 2026-09-03 の投資順位:
① 仕様 → ② MCP 経由の E2E → ③ 機能テスト → ④ 変異検証は最後の手段）。

**エージェントが見つけた実質的な問題**（すべて地図 §9 に記録）:

| 発見 | 中身 |
|---|---|
| **移管先が宙に浮いている** | #474 の cmd+click は 2026-08-28 に #633 へ移管された記録があるが、**#633 マージ後もコード上は未実装**（grep 0 件）。移管したまま誰も持っていない |
| **地図と issue の食い違い** | #138 の吸収先 — 地図 §6.1 は「#656 へ」、#138 自身の棚卸しコメントは「#659 と統合が自然」。どちらも根拠つき |
| **枝番号の不整合** | #484 の「D4」が **issue 本文に一度も登場しない**（2026-07-26 指摘・未解決） |
| **本文が SC 時代のまま** | #213 の実装計画が SuperCollider 前提で、地図 §1「SC 退役」と矛盾 |
| **本文が古い** | #546 Phase 3 の復元側は本文が「読むコードが 1 行もない」のままだが、実際は完了済み |
| **未実装の確定** | `ORBIT_OUTPUT_BUFFER_FRAMES`（#368）は grep で未実装と確認 |

## 同日の追加裁定（本コミットに含む）

- 🔴 **ICLC には出さない**（owner）。藝大不採択の retarget 先が消え、**本番トラックから
  締切が無くなった** → 開発の順序は**地図 §3 のリリース道筋が唯一**になる
- 🔴 **WCTM の開発はこのリポジトリでやらない**（owner）。作品開発は WCTM 側セッションが持ち、
  必要な機能は**そこから機能要望として降りてくる** → 降りてきたら**普通の機能 issue** として
  扱う（「研究トラック」という別枠に入れない）。地図 §4.M の見出しを
  「研究・作品トラック（🔴 このリポジトリでは進めない）」へ変更

## 2026-09-03: 死んだ `.env.example` を削除（#708）

**実害**: sandbox 内でフック付きコミットが**必ず失敗**していた。

```
[FAILED] error: lstat(".env.example"): Operation not permitted
  ✖ lint-staged failed due to a git error.
```

Claude Code の sandbox は `./.env*` の読み取りを拒否する（秘密の保護）。`lint-staged` は
コミット前に `git stash` するので、`.env.example` を lstat した時点で落ちる。
🔴 **エラーが「git error」としか出ないため lint の失敗と紛らわしく**、本日の PR-E1 でも
原因調査に時間を使った。

**なぜあったか**: `9a7a7bae`（2025-10-26）で BFG により `.env` を履歴から削除した際、
テンプレートとして作られた。**その後、参照する仕組みが消えていた**:

| 確認 | 結果 |
|---|---|
| 中身 | Slack 通知用 env 4 個 |
| その env を読むコード | **0 件** |
| `.env` を読み込む仕組み | **`dotenv` 依存なし。何も読んでいない** |
| Slack 連携の実体 | **無い**（`slack` のヒットは SuperCollider の vendor と英単語のみ） |

**残した注意点**: `.gitignore` の `!.env.example` / `!.env.sample` / `!.env.template` は
**外部ツール管理ブロック**（`[code:security-patterns:fbe2794b]`・生成元はリポジトリ内に無い）
なので触っていない。したがって**将来 `.env.example` を再び置くと同じ問題が再発する**。

## 2026-09-03: stale ガードが再ビルド不能なファイルで発火していた（#713）

**実害**: 🔴 **実機 gated E2E が起動段階で全部落ちる。しかもガードが指示する対処では解消しない。**

```
Error: gated E2E: the daemon binary is older than the Rust sources, so this run would measure stale code.
  newest source: rust/crates/orbit-vst3-host/tests/spike_s_concurrent_load.rs
  binary:        2026-09-02T02:05:35.862Z
  source:        2026-09-03T00:53:01.573Z
```

指示どおり `npm run test:e2e:gated` を回しても `pretest` の cargo は
`Finished release profile in 0.21s` で**何もビルドしない**。当然で、そのファイルは
`orbit-vst3-host` の**統合テストターゲット**であり、`orbit-audio-daemon` のバイナリの
依存グラフに入っていない。**バイナリの mtime は永久に更新されず、ガードは永久に赤。**

**なぜ今まで出なかったか**: mtime は **`git checkout` で現在時刻に更新される**。
ブランチを行き来すると無関係な Rust ファイルが「最新のソース」になる。

**修正**（`assertDaemonBinaryIsNotStale`）: 走査から **`tests` / `benches` / `examples`** を除外。
別の cargo ターゲットなので daemon バイナリに入らない。⚠️ **`src/` は除外しない** —
daemon が依存するコードが新しければ、ガードは本来の役目どおり赤くなるべきである。

**仕組みで守る**（規律を文章で持たない）: `gated-assertion-hygiene.spec.ts` に検査 2 本。

| 検査 | red になる条件 |
|---|---|
| 除外の維持 | `tests` / `benches` / `examples` の除外が消えたら |
| **行きすぎの防止** | **`src` まで除外したら**（ガードの目的自体が失われる） |

**変異で両方向を確認した**（実出力）:

```
変異A: 除外を消す        → × keeps the stale guard off cargo targets it can never rebuild
変異B: src も除外する    → × still lets the stale guard see the sources the daemon is built from
restore 後              → Tests  5 passed (5)   ／ cmp で復元一致を確認
```

### 🔴 副産物: 実機 gated は現在 main で 11 件が意図的に red

ガードを直して初めて中身が走り、**20 件中 9 passed / 11 failed** だと分かった。
これは**退行ではなく、修正より先に書かれたテスト**である（一次情報:
`docs/design/649-audio-line-design.md` §B-0「**E2E-1 を先に書いて red 固定**」)。
修正は**段 1**（PR-O2 / #649・plan §3「段 1 の結果: `global.gain(-6)` が instrument に効く」）。

**したがって段 0 の小 PR のゲートは「実機 gated 全通し」にできない。**
正しい判定は **「失敗集合が before/after で同一」**（新しい失敗を作っていない）。
baseline（main + 本修正・2026-09-03 実測）:

```
#643 E2E-1〜E2E-7（7 件）
auto-records and restores all five plugin receiver kinds across a restart without explicit saves
drives real OrbitStudio end-to-end: diagnostics-on-open, run_selection, live edit, capture verification
replaces a playing instrument across CLAP/VST3 ... (#618 E1-E6)
steps the live playhead through an instrument() sequence, rests included
```

E2E-2 / E2E-3 の dry RMS が **ちょうど 0**、E2E-1 の比が **1.27**（gain が効いていない値）
という内容も、段 1 が直す欠陥と一致している。

## 2026-09-03: #713 のガード変更に dev 学習サイトを追従させた（docs のみ）

**対象**: PR [#714](https://github.com/signalcompose/orbitscore/pull/714)（merge commit `f006a51`）。
コード・テストは一切変更していない。

PR #714 は引用のアンカー（`// FILE:START-END` 形式の見出し行）を直したが、**引用を囲む本文**と
`## Sources` の行範囲は旧状態のままだった。`docs:check` は前者しか検査しないので、後者は
red にならずに残った。この 2 種を追従させた。

**本文の乖離 2 件**（どちらも #714 で挙動が変わった箇所を古い説明のまま記述していた）:

| 場所 | 旧記述 | 実態 |
|---|---|---|
| `sites/dev/rust-engine/capture-verification.md` / `sites/dev/editor/mcp-and-gated-e2e.md` | ガードは `rust/**/*.rs` \| `Cargo.toml` を走査 | `tests` / `benches` / `examples` を除外する（#713） |
| `sites/dev/editor/mcp-and-gated-e2e.md` | 「残り **2 本**」（アサーション衛生は 3 本） | #713 で 2 本増えて **5 本** |

両章に #713 の節を足した。走査除外の理由（別 cargo ターゲットなので daemon バイナリに入らない・
`git checkout` が mtime を動かすので解消不能な赤になる）と、`src/` を除外しない理由、
`gated-assertion-hygiene.spec.ts` の 2 本が両方向を留めていることを書いた。
ja / en 両方（STYLE_GUIDE のバイリンガル必須）。

**`## Sources` の行範囲**: ガードが 15 行伸びたので、`orbitstudio-mcp-gated.spec.ts` の
128 行目以降を指す参照はすべて +15 ずれていた。6 章 × ja/en で 12 ファイル分を直した
（`78-152` → `78-166`、`1434-1468` → `1449-1483` など）。境界行は実ファイルで確認済み。

**frontmatter**: 本文を実質的に足した 2 章（RE-4 / IV-3）の `verified-against` を
`69dc968` → `f006a51`、`verified-at` を `2026-09-03` に更新した（STYLE_GUIDE
「章本文を実質的に書き直したとき: 必ず最新 commit に更新する」）。

### 追従の過程で見えた、直していない点

このセッションでは**指摘のみ**（テスト・実装は変更しない方針のため）。詳細は PR 本文。

1. `tests/e2e/gated-assertion-hygiene.spec.ts:76-83` / `:89-93` は gated spec の**ソース文字列**を
   正規表現で見るだけなので、「除外ブロックを `walk(full)` の**後ろ**へ動かす」変異
   （除外が到達不能になり #713 の赤が戻る）で **2 本とも緑のまま**になる
2. 同 `:77` は式の**字面**に依存するので、`Set` へ畳む等の挙動不変なリファクタで red になる
3. `assertDaemonBinaryIsNotStale()` は `tests/e2e/orbitstudio-mcp-gated.spec.ts:164-166` の
   `gated && appAvailable` の下でしか呼ばれない。CI は全ジョブ非 gated なので、
   #713 で足した 15 行は**どこでも 1 行も実行されていない**

## 2026-09-03: PR #700 のドキュメント追従（ICLC 取り下げ / WCTM の持ち先 / §10 の表崩れ）

**追従元**: PR [#700](https://github.com/signalcompose/orbitscore/pull/700)（マージコミット `ca176f0`・head `f5b16d8`）。
docs のみの変更で、`CLAUDE.md` の本番トラック注記・`docs/planning/DEVELOPMENT_MAP.md`・本 WORK_LOG を更新していた。

**#700 が `CLAUDE.md` にしか書かなかったため、同じ注記を持つ他のドキュメントが古いまま残っていた:**

| ファイル | 何が古かったか |
|---|---|
| `docs/core/INDEX.md:39` | 「本番トラックは ICLC への proposal 提出方向へ retarget（年次・提出日・提出形態はいずれも要確認）」 |
| `docs/core/INDEX.md:207` | 同じ retarget 注記（WCTM 調査群の凍結セクション） |
| `docs/core/INSTRUCTION_ORBITSCORE_DSL.md:18` | 「ICLC 提出方向へ retarget（年次・提出日・形態は要確認）」 |
| `sites/dev/decisions/adr-001-supercollider.md:267` / `:314`（+ `en` 対訳） | 「Consequences revisited」の 3. 学術的文脈が ICLC retarget で止まっていた |

いずれも **ICLC 取り下げ（owner 2026-09-03）・本番トラックに締切が無い・WCTM 本体の開発は本リポジトリで進めない**
の 3 点へ書き換えた。`sites/dev` は日英両方を更新（STYLE_GUIDE のバイリンガル必須）。

**#700 が入れた表崩れも直した**: `DEVELOPMENT_MAP.md` §10 で、追記の箇条書きと更新履歴テーブルのヘッダ行の間に
空行が無く、GFM ではテーブルがリスト項目の遅延継続として吸われて**描画されない**状態だった
（`docs/planning/DEVELOPMENT_MAP.md:1463-1464`）。空行を 1 行入れただけで、本文は変えていない。

**追従しなかったもの**: #700 が記録した出口・レンダ宛先・`%n` テンプレートの裁定は、地図自身が
「spec への反映は §6.2 の改訂候補（owner 裁定で行う）」と書いているため `docs/specs-v2/` と
`docs/core/INSTRUCTION_ORBITSCORE_DSL.md` へは**反映していない**（実装も未着手で、DSL 表面は変わっていない）。


## 2026-09-03: PR #709 追従 — 失効した landmine 記述を更新

PR #709（`7d2df31`・上記 #708）で `.env.example` を削除した結果、
`docs/development/POST_2.0_VST3_HOSTING_PLAN.md:256` の landmine 記述が**失効した**。

| | 内容 |
|---|---|
| 旧記述 | 「`.env.example` は sandbox read-deny → `git diff` が誤って削除表示。`git status --short` が権威」 |
| なぜ失効か | ファイルが実在しなくなったため、この誤検知は起きない |
| 🔴 なぜ放置できないか | **実際に削除された今、この記述は「`.env.example` の削除表示は無視してよい」と読める** — 真の削除を sandbox の誤検知と取り違えさせる |

取り消し線で旧記述を残したうえで、解消済みであることと、`.gitignore:55-57` の
un-ignore 行が残っているため**再設置すると再発する**ことを追記した。

**追従不要と判断した層**（PR #709 の差分は `.env.example` 削除と WORK_LOG 追記のみ）:

| 層 | 判断 |
|---|---|
| DSL/言語仕様（`packages/engine/`） | 差分に含まれない。構文・意味論・`.orbslog` 形式に変化なし |
| ランタイム/MCP（`rust/`） | 差分に含まれない。MCP ツールの引数・返り値・エラー挙動に変化なし |
| OrbitStudio（`packages/vscode-extension/`） | 差分に含まれない。評価フロー・診断・補完に変化なし |
| `sites/user/` `sites/dev/` | 削除したファイルを参照する記述は 0 件（repo 全体 grep で確認） |

## 2026-09-04: ルーティンのドキュメント追従 PR を溜めない規則（#718）

**実害**: ルーティンが出したドキュメント追従 PR **9 本のうち 8 本が衝突**し、1 本ずつ手で解決した。

| PR | 結果 |
|---|---|
| #716 / #717 | **出てすぐ入れた → clean** |
| #688 / #691 / #698 / #701 / #705 / #710 / #711 | **溜めた → 全部衝突** |

**原因**: ルーティン PR の差分は**「追従した時点の main」に対して計算されている**。その後 main に
入る 1 コミットごとに陳腐化する。待たせている間に #709 / #714 / #716 と束の追従が入り、
`WORK_LOG` の追記位置・`INDEX` の項目・各ドキュメントの **`## Sources` の行範囲**と
**引用のアンカー**が全部ずれた。

🔴 **片側を捨てると情報が落ちる**ので、機械的な解決ができない。実例:

- **#688**: 「archive パスへの修正」（PR 側）と「ICLC 取り下げの追記」（main 側）が**同じ行**で衝突。
  両方が正しいので、パスは PR 側・文末は main 側を採った
- **#711**: `## Sources` は束側が最新だったが、`helpers/rack-child-pid.ts` の行は PR 側にしか無かった

**規則**（owner 合意）:

1. main に何かをマージしたら、**ルーティン PR が出た時点でその場で入れる**
2. 遅くとも **統合ブランチを main から切る前**に全部消化する
3. 🔴 **base の選び方**: 追従先のファイルが**束にしか無い**なら base は **統合ブランチ**にする。
   main を base にすると引用が実ファイルを指せず `docs:check` が落ちる（#711 が実際その状態だった。
   #717 はルーティン自身が正しく束を base にしていた）

**止めない理由**: 🔴 **ルーティンは機械が見ていない層を見ている。** `docs:check` は**引用のアンカー
しか検査せず**、引用を囲む**本文**と **`## Sources` の行範囲**は検査しない。#716 はまさにそこを
検出した（#714 でガードの走査範囲を変えたのに、本文は「`rust/**/*.rs` を走査」のまま）。

**自動マージにもしない**: #688 の本文には事実誤認があった（「vitest を回す CI チェックは 1 本も
存在しない」— 実際は `code-review.yml:26` が `npm test` を実行している）。人が読む前提は変えない。

## 束 668-e2e-foundation — E2E 基盤（段 0・安全網）

正本: [`docs/design/668-e2e-foundation-design.md`](../design/668-e2e-foundation-design.md) /
[`docs/planning/IMPLEMENTATION_PLAN_2026-09.md`](../planning/IMPLEMENTATION_PLAN_2026-09.md) §1.10。
束ブランチ運用（[`BUNDLE_BRANCH_WORKFLOW.md`](BUNDLE_BRANCH_WORKFLOW.md)）の最初の束。

### PR-E2 追従: dev サイトを共有ハーネス層まで追従させる（docs のみ）

PR #712（merge `affdf69`）に対するドキュメント追従。**実装・テストは一切変更していない。**

**追加**（`sites/dev/editor/mcp-and-gated-e2e.md` と `sites/dev/en/` の同パス）:

- 新節「共有ハーネス層 — `tests/e2e/helpers/`」。5 モジュールの一覧と、
  `expectNoNewErrors`（`engine-log.ts:51-62`）/ `captureWavPath`（`gated-session.ts:47-51`）/
  `runScore` の `evaluate`（`run-score.ts:187-196`）を verbatim 引用
- 🔴 **capture パスの実測値は 13 箇所**（`grep -c "captureWavPath(" tests/e2e/orbitstudio-mcp-gated.spec.ts`）。
  PR #712 の本文と上の PR-E2 節は「11 箇所」と書いているが、実ファイルは 13。
  `ORBIT_KEEP_CAPTURES` を見ていたのが 1 箇所だけだった点は変わらない
- `ORBIT_KEEP_CAPTURES` の既存段落に「spec 全体で効くようになったのは PR-E2 以降」を追記
- `tests/e2e/helpers/` が `GATED_SOURCE_GLOBS`（`tests/e2e/gated-sources.ts:29-35`）に**含まれない**ことを明記

**行番号の再アンカー**（PR #712 は fenced code block の引用ヘッダだけを直したので、
散文中の行参照が残っていた）:

- 「テスト一覧」表の 20 本の行番号（`638→636` 〜 `4483→4473`）
- `plugin-ui.md` / `catalog.md` / `mixer-audio-line.md` / `signal-chain/index.md` /
  `capture-verification.md` の Sources 節の行範囲（ja / en 各 5 ファイル）
- 対応は old/new のテキスト一致で 1 行ずつ照合済み（推定ではない）

**検証**: `npm run docs:build`（user / dev）と `npm run docs:check` はすべて緑。

### PR-E2: 共通 helper を切り出す

正本: 設計 §4.1〜4.5。**実装は Codex**（`gpt-5.6-sol` / effort high）、**検証は main**。

**追加**（`tests/e2e/helpers/`・計 524 行）:

| モジュール | 中身 |
|---|---|
| `engine-log.ts` | `LOG_WINDOW_LINES` / `countLogMarker` / `countErrors` / `errorBaseline` / `expectNoNewErrors`（`toBeLessThanOrEqual`）/ `expectLogMarkerAtLeast` |
| `gated-session.ts` | `GatedCatalog` / `GatedSession` / `captureWavPath` / `createGatedSession` |
| `run-score.ts` | `ScoreSource` / `CaptureWindows` / `ScoreRunContext` / `runScore` |
| `wait-for-file.ts` | `waitForFile` / `waitForMatchingFile`（`minBytes` つき — 生成と書き込みが別なので存在だけ見ると 0 バイトを掴む） |
| `run-cli.ts` | `CliResult` / `runOrbitscoreCli`（`replay` / `render` の E2E 用。MCP を通らない唯一の例外） |

**gated spec の変更は機械的置換のみ**（+18/−28）。シナリオのロジック・アサーション順序は無変更:

- 🔴 **`countErrors` の 7 重定義が 1 本になった。** 変更前の定義位置は
  `496 / 2144 / 2722 / 3155 / 3461 / 3969 / 4464` 行（発注時の実測と完全一致）。
  変更後 `grep -c "const countErrors = (log"` = **0**
- 🔴 **capture WAV のパス構築 13 箇所を `captureWavPath` に統一。** 変更前は
  `ORBIT_KEEP_CAPTURES` を見るのが **492 行の 1 箇所だけ**で、残りは素の `path.join` だったため
  **落ちた瞬間に証拠の WAV が消えていた**。`ORBIT_KEEP_CAPTURES` 未設定時のパスが
  変更前と同一であることを実測で確認（接頭辞 `643-` は元から両分岐に付いていた）
- 638 行のローカル変数 `captureWavPath` が import した関数名と衝突するため
  `captureWavFile` にリネーム（参照 3 箇所も追随）

**main の受け入れ監査で 1 件直した**（Codex は「食い違いなし」と報告していた）:

> 🔴 `runScore` の `evaluate` が **設計 §4.2 に反して `isError` を assert していた**。
> コメントには設計の文言（「`ok` に assert しない」）が書いてあるのに、コードが逆をしていた。
> **診断が出ることを確かめる E2E**（doc 610 の異常系は「この譜面は診断を出す」が判定条件）で
> `runScore` が使えなくなるため、設計どおり assert しない形に直した。
> 診断の判定は `engine-log.ts` の `expectNoNewErrors` / `expectLogMarkerAtLeast` が担う。

**検証**（main が sandbox 外で回した実測）:

- `npx tsc --noEmit` / `npx eslint tests/e2e` → 0
- `npm test` → **2167 passed / 48 skipped**（gated は 20 tests / 20 skipped = `it(` を増減させていない）
- `node sites/dev/scripts/check-citations.mjs` → **904 verified / 0 failed**
  （gated spec の行が動いたので 44 件ずれ、40 件は `--fix`、4 件は `captureWavFile` の
  リネームで本文が変わったため手で修正）

**残る注意**: `runScore` は本 PR ではどのシナリオからも使われていない（設計どおり「既存 20 本は
書き換えない」）。**最初の消費者は PR-E3**（`channelRms` を足す）なので、実行での検証はそこで付く。

### PR-E1: gated E2E の走査先を 1 箇所にする

**なぜ先に入れるか**（設計 §3.4・§11 F-9）。ラチェット（`dsl-e2e-coverage.spec.ts:39`）と
衛生検査（`gated-assertion-hygiene.spec.ts:18`）が**それぞれ 1 ファイルを決め打ち**していたため、
シナリオを別ファイルへ出した瞬間に

- **(a)** カバー済みの語が未カバー扱いになってラチェットが red
- **(b)** 衛生検査が新ファイルを見ず、**黙って弱くなる**

が同時に起きる。🔴 **(b) は red にならないぶん危険**で、検査が効いていないことに気づけない。
分割（PR-E2 以降）の前提として、走査先を `tests/e2e/gated-sources.ts` に集約した。

**変更**:

- `tests/e2e/gated-sources.ts`（新規）— `GATED_SOURCE_FILES` / `readGatedSources()` /
  `readGatedSourceEntries()` / `gatedItTitles()`。`gated/` 配下は**まだ存在しない**が、
  作られた時点で自動的に走査対象に入る（`.spec.ts` にしないので vitest の発見単位は 1 本のまま）
- **ソースが 0 本なら throw する。** 入口 spec の改名やディレクトリ移動で空になると、両検査が
  「何も見つからなかった」を「違反ゼロ」と読んで**全件 green のまま無意味になる**
- 衛生検査の違反報告を **`file:line`** 形式にした（連結後の行番号では追えないため）
- `tests/e2e/helpers/rack-child-pid.ts`（新規）— `rackChildPidsFromLog` /
  `latestRackChildPid` を gated spec から移した。`rack-child-pid-oracle.spec.ts` が
  **`.spec.ts` から import していた**のを解消（spec 分割で import 元が消えるため）

**検証**:

- `npm test` → **2167 passed / 48 skipped**（挙動不変）
- 🔴 **層が効いていることを実行で確認した。** `tests/e2e/gated/__probe.ts` に ERROR 件数の
  厳密等価を置くと衛生検査が **red** になり、**`gated/__probe.ts:7`** と報告した。
  この PR 以前ならこのファイルは走査されず、検査は黙って通っていた。確認後に削除し、緑に戻した

### PR-E4: DSL 構文表面の正本と網羅ラチェット

**なぜ入れるか**（設計 §3.1〜3.3）。従来のラチェットは `.name(` だけを走査するため、
`play` のネスト、event modifier、tie、複数行 chain のような**メソッド呼び出しでない構文**を
増やして E2E を書き忘れても green のままだった。production に 13 構文の正本を置き、語彙・
構文・tokenizer keyword・台帳・観測タイプの退行を A-1〜A-5 で止める。

**変更**:

- `packages/engine/src/parser/dsl-surface.ts`（新規）— 設計 §3.1 の `DslSyntaxId` 13 個と
  `DSL_SYNTAX_SURFACE`。推測による追加はしない
- `tokenizer.ts` — `AudioTokenizer.KEYWORDS` を `static readonly` にし、読み取り専用の
  `KEYWORDS` 名前付き export を追加。既存の `.has(id)` 呼び出しは不変
- `tests/e2e/dsl-coverage-ledger.ts`（新規）— `ObservationKind` / `CoverageEntry` /
  `DSL_COVERAGE_LEDGER`。E4 は E2E を増やさないため、台帳と smoke baseline は 0 から開始
- `dsl-e2e-coverage.spec.ts` — A-1〜A-5。走査は `readGatedSources()` / `gatedItTitles()` を通し、
  構文 baseline 13 個は減らす方向だけ、smoke baseline は増やさない

**ラチェットの実効性**:

- A-1: `SEQUENCE_DSL_METHODS` に `__a1_probe` → `expected [ '__a1_probe' ] to deeply equal []`
- A-2: 構文正本に `a2-probe` → `expected [ 'a2-probe' ] to deeply equal []`
- A-3: tokenizer に `A3_PROBE` → `unmappedKeywords: [ "A3_PROBE" ]`
- A-4: 台帳に存在しないシナリオ → `missing gated scenario` を含む行を列挙して red
- A-5: smoke 行を 1 件追加 → `expected 1 to be less than or equal to 0`

各 probe は個別の red 確認直後に逆パッチで戻し、対象 spec は **9 passed** に復帰した。

**検証**:

- `npx tsc --noEmit -p tsconfig.json` → exit 0（出力なし）
- `npx eslint packages/engine/src/parser tests/e2e` → exit 0（出力なし）
- `npm test` → sandbox の `listen EPERM: operation not permitted 127.0.0.1` により
  **105 failed / 2066 passed / 48 skipped**。権限回避は行わず実出力を記録
- `cd sites/dev && node scripts/check-citations.mjs` → **904 citations verified / 0 failed**
  （初回 6 件 red → `--fix` と引用本文の手修正で再アンカー）

**設計との差分として残す事項**:

- 現行 `gatedItTitles()` は curried な `it.skipIf(...)(title, ...)` 20 件を抽出できず 0 件を返す。
  ブリーフどおり helper と gated spec は変更せず、E4 の台帳は空から開始した
- tokenizer の `force` は `parse-statement.ts` で transport の `.force` modifier として受理されるが、
  設計 §3.1 の 13 構文には独立 id が無い。正本は増やさず、A-3 では transport 3 id に対応づけた

#### main の受け入れ監査で 1 件直した — `gatedItTitles()` が題名を 1 件も拾えていなかった

🔴 **PR-E1 で main（私）が入れた `gatedItTitles()` のバグ。** gated suite は 20 箇所すべて

```ts
it.skipIf(!appAvailable)(
  'drives real OrbitStudio end-to-end: …',
```

という**カリー化された呼び出し**で書かれており、題名は**2 つ目の呼び出しの第 1 引数**にある。
PR-E1 の正規表現は `it(` の直後に文字列が来る前提だったので、**題名を 1 件も拾えていなかった。**

**なぜ PR-E1 では気づけなかったか**: `gatedItTitles()` に**テストが無く、消費者もいなかった**。
拾えなくても「照合対象が無い」だけで誰も困らない。**検査 A-4（台帳のシナリオが実在するか）が
消費し始めた瞬間に、空振りで緑 → 正当な台帳エントリで誤 red、という壊れ方をする。**

**修正**:

- 正規表現を `it.skipIf(<cond>)(` のカリー形に対応させた（直呼びも引き続き拾う）
- 🔴 **題名が 0 件なら throw する。** `readGatedSources()` には同じガードを入れていたのに、
  題名側に入れ忘れていた。**黙って空を返す層は、消費者が現れるまで壊れていることが分からない**
- `tests/e2e/gated-sources.spec.ts`（新規）— **走査の層に初めてテストを付けた**

**変異で確認した（実出力）**:

```
旧正規表現に戻す + 台帳に実在シナリオを入れる
  → × picks up titles from the curried it.skipIf(...) form the suite actually uses
  → × returns titles that the coverage ledger can anchor to
  → × A-4 keeps every coverage-ledger scenario anchored to a gated it title
  → Error: gated E2E の it( 題名が 1 件も見つからない。…
復元後 → Tests  13 passed (13)   ／ cmp で 2 ファイルの復元一致を確認
```

**A-1〜A-5 も 1 本ずつ変異で確認した**（main の実測）:

| 変異 | red になった検査 |
|---|---|
| 構文 id を足して台帳に入れない | A-2 |
| tokenizer に予約語を足す | A-3 |
| 台帳に存在しないシナリオを書く | A-4 |
| 台帳に `smoke` 行を足す | A-5（+ A-4） |

いずれも restore 後に緑へ戻り、`cmp` で 3 ファイルの復元一致を確認した。

**検証**（main が sandbox 外で回した実測）: `tsc` 0 / `eslint` 0 /
`npm test` **2171 passed / 48 skipped**（+4 = A-2〜A-5）/ `check-citations.mjs` **904 verified / 0 failed**。

### PR-E1 の docs 追従（dev 学習サイト IV-3）

PR [#707](https://github.com/signalcompose/orbitscore/pull/707)（マージコミット `8bc65cf`）に
dev 学習サイトを追従させた。コード・テストは触っていない。

**なぜ必要か**: #707 は「ラチェットと衛生検査の走査先を `gated-sources.ts` に集約する」という
**構造の変更**で、IV-3 章はその 2 検査を「gated spec のソースを読む」と説明していた。
引用の再アンカー（#707 の 2 コミット目）はコードブロックの行番号だけを直すので、
**本文と `## Sources` の行範囲は古いまま残っていた**。

**変更**:

- `sites/dev/editor/mcp-and-gated-e2e.md` / `sites/dev/en/editor/mcp-and-gated-e2e.md`
  - §8 に「走査先は 1 箇所が持つ」節を追加（`GATED_SOURCE_GLOBS` / 空なら throw /
    `readGatedSources()` と `readGatedSourceEntries()` の使い分け / `file:line` 報告）
  - ラチェットの説明を「gated spec の中に」から「`readGatedSources()` が返す
    gated E2E のソース全体に」へ
  - §3 の `rackChildPidsFromLog` の出典を `tests/e2e/helpers/rack-child-pid.ts` へ
  - `## Sources` に `gated-sources.ts` / `helpers/rack-child-pid.ts` を追加、
    `orbitstudio-mcp-gated.spec.ts` の行範囲を再アンカー（import +1 / PID オラクル移動 -27）
  - `verified-against` を `8bc65cf`・`verified-at` を 2026-09-03 へ
- `sites/dev/{,en/}plugin-hosting/{catalog,plugin-ui}.md` /
  `{,en/}signal-chain/{index,mixer-audio-line}.md` / `{,en/}rust-engine/capture-verification.md`
  — `## Sources` の `orbitstudio-mcp-gated.spec.ts` 行範囲を同じ規則で再アンカー。
  本文の対応関係は変わらないので `verified-against` は据え置き（STYLE_GUIDE §4）

**検証**: `npm ci` / `npm run docs:build -w @orbitscore/user-site` /
`npm run docs:build -w @orbitscore/dev-site` / `npm run docs:check`（910 citations / 0 failed）

### PR-E3: capture の解析を per-channel でも取れるようにする

**なぜ入れるか**（設計 §10）。`analyzeWavBuffer` は `wav-analysis.ts:127-132` で**全チャンネルを
加算平均してモノラルにしてから**窓 RMS を取る。`WavAnalysis` にチャンネル別の系列は無く、
MCP の `analyze_audio` もその形しか返さない（gated spec に `readFloatLE` は **0 件**）。
チャンネル別 RMS は Rust 側（`orbit-audio-verify`）にしか無く、**MCP 経由の gated E2E からは届かない**。

🔴 **このままでは書けない E2E が 4 件あり、いずれも mono に潰れて常に緑になる**:
`pan` / `defaultPan` の L/R 差（#650）／ ch3-4 が無音・ch1-2 は有音（doc 611 E2E-4・5）／
8ch で bleed 無し（doc 598 E2E-R5）。

**変更**（実装は Codex・検証は main）:

- `wav-analysis.ts` — `ChannelWindow` 型 / `WavAnalysis.channelWindows` / `channelRms` /
  `analyzeWavBuffer(buf, { perChannel })`。**既定は mono のまま**（spread で、指定時だけ増える）
- `mcp-server.ts` / `extension.ts` — `analyze_audio` に `per_channel` を追加。
  設計の要求どおり**エージェントも同じ動線で見られる**ようにした（MCP は裏口ではない）
- `tests/e2e/helpers/run-score.ts` — `CaptureWindows.channelRms(segment, channel, guardSec?)`

**ユニットテスト 4 本**（既存 14 本は無変更）。決定的なのは 3 本目 —
**片チャンネルだけに信号がある WAV** で `channelRms[1] === 0` かつ **`mono rms === channelRms[0] / 2`**
を検証する。**mono 潰しの欠陥そのものを数値で固定**している。

#### 🔴 実機の capture で mono と突き合わせた（main の実測）

実機 gated が生成した**44.1 秒・ステレオ**の capture を、同じ関数で両方の呼び方で解析した:

```
ch数        : 2
durationSec : 44.117
mono rms    : 0.061970
channelRms  : 0.061970  0.061970
L/R 比       : 1.0000
既定の不変性 : {}            ← perChannel 無指定では両フィールドとも undefined
```

**3 つの値が小数 6 桁まで一致。** 合成データの hard-pan テストが「**分離できる**」ことを、
この実機値が「**mono と矛盾しない**」ことを示す。片方だけでは足りない。

**検証**: `tsc` 0 / `eslint` 0 / `npm test` **2173 passed / 48 skipped**（+4）/
`check-citations.mjs` **904 verified / 0 failed**。

### 束の締め: `/simplify` の適用

4 観点（reuse / simplification / efficiency / altitude）を並行で回した結果。

| 指摘 | 判断 |
|---|---|
| `readGatedSources()` と `readGatedSourceEntries()` が**同じ throw ガードを 2 箇所**に持つ | ✅ 前者を後者から導出。**ガードが 1 箇所に** |
| 二乗平均の式が `rms()` と `channelRms()` に重複 | ✅ `quadraticMeanRms()` に集約 |
| `run-score.ts` の `markerCount` が `engine-log.ts` の `countLogMarker` と**完全に同一実装** | ✅ 寄せた |
| `run-score.ts` が gated spec の `startR28Engine` を**約 60 行コピー**している | 🔶 **follow-up**（下記） |
| per-channel から mono を導出して二重走査を避ける | ❌ **却下 — 数値が変わる**（下記） |

#### 🔴 却下: per-channel から mono を導出する案

「`channelRms` の平均で mono の `rms` / `windows` を導出すれば、バッファを 1 回しか走査しなくて済む」
という提案。**これは既定の数値を変える。**

mono の RMS は `sqrt(mean(((L+R)/2)²))`、チャンネル別 RMS の平均は `(rms_L + rms_R)/2` で、
**別物**である。無相関・同電力の L/R で実測:

```
mono の RMS      : 0.407428
ch別 RMS の平均  : 0.580297
比               : 0.7021      ← 理論値 1/√2 ≈ 0.7071
```

🔴 **一致するのは L=R か片チャンネル無音のときだけ**で、**既存 14 本のテストはまさにその特殊ケース
しか見ていない**。採用していれば**全件緑のまま通り、実際の音楽素材でだけ静かに壊れた**。
per-channel を入れた動機（「mono に潰すと分離が測れない」）と同じ構図が、逆向きに出た形である。

#### efficiency / altitude 班の指摘

| 指摘 | 判断 |
|---|---|
| `readGatedSources()` / `gatedItTitles()` に**メモ化が無く、220KB のソースを読み直す** | ✅ **適用** |
| `perChannel` + `windowMs` 併用時に**同じバッファを 3 回全走査** | 🔶 **follow-up**（下記） |
| `windowsFor()` が区間ごとに filter する | ❌ 指摘に当たらず（高々 2200 要素の配列走査） |
| `GATED_SOURCE_GLOBS` のファイル名決め打ち | ❌ **今のままでよい** — `gated/` を `.spec.ts` にしないのは**意図的**（vitest に発見させず、実 GUI の並列起動を避ける）。制約から導かれた形 |
| 台帳が空で A-4 / A-5 が空振り | ❌ **設計どおり**（§3.5「台帳は空から開始する」）。箱を先に作り、中身は後続 PR |

**メモ化の実測**（2026-09-04）: 対象は 220KB・4566 行の gated spec 1 本。
`gated-sources.spec.ts` だけで**同じファイルを 3 回**、`dsl-e2e-coverage.spec.ts` で**2 回**読んでいた
（`gatedItTitles()` が内部で `readGatedSources()` を呼ぶため）。合計 **+4 回の冗長読み込み**と、
4566 行に対する `matchAll` の再実行。対照的に `gated-assertion-hygiene.spec.ts` は
**モジュール先頭で 1 回だけ読んで保持**しており、そちらが正しい形だった。

#### 🔶 follow-up: `wav-analysis.ts` の窓ループが 3 箇所に手書き

`analyzeWavBuffer` 本体の窓ループ / `windowSeries` / `channelSeries` が同型で、
`MIN_WINDOW_MS` / `MAX_WINDOW_SERIES` の cap チェックまで一字一句同じ。
`{ windowMs, perChannel }` 併用時は**同じバッファを 3 回全走査**する
（44 秒・48kHz・ステレオで `readFloatLE` が約 1267 万回 = 最小構成の 3 倍）。

🔴 **ただし「per-channel から mono を導出する」形では直せない**（上記のとおり数値が変わる）。
正しい形は**窓イテレーション自体を共有関数にし、1 パスで mono と per-channel の
アキュムレータを同時に更新する**こと。**この束では直さない** — 既存 20 本の capture 値を
変えないことが最優先で、いま `run-score` に消費者がいないため実害もゼロ。
**次に窓ロジックを触る時の踏み台**として記録する。

#### 🔶 follow-up: `startR28Engine` の重複

`run-score.ts:989-1044` が gated spec の `startR28Engine` / `waitForEngine`（`:406-466`）を
マーカー文字列・retry 構造・エラー整形まで含めてほぼ丸ごと再実装している。指摘は正しい。

**この束では寄せない**: 解消には gated spec から helper を切り出す必要があり、**20 シナリオが依存する
構造を束の締め直前に動かす**ことになる。設計 §4 も「本設計では寄せない — 既存 7 本の意味を変えない
ことを優先する」と明記している。**リスクゼロの部分（`markerCount`）だけ取った。**

**最初の消費者が付く時に寄せる**のが安全（今は `run-score` にも `startR28Engine` にも
新しい消費者がいないので、形が確定していない）。

### 束の締め: Fable 監査の結果

🔴 **監査が私（main）の壊したビルドを捕まえた。**

#### 0. `/simplify` の適用でビルドを壊していた（main の誤り）

`quadraticMeanRms` を `function waitForEngineState(` の前に挿入したつもりが、実際のコードは
**`async function waitForEngineState(`** で、**`async` と `function` の間**に入っていた:

```ts
async /** ... */
function quadraticMeanRms(...) { ... }

function waitForEngineState(...) { await ... }   // ← async が剥がれた
```

`tsc --noEmit -p tsconfig.tests.json` が **TS2304 / TS2355 / TS1308** で落ちる状態。

🔴 **なぜ気づかなかったか、が本質**:

| | |
|---|---|
| `npm test` が緑だった | **`run-score.ts` をどの spec も import していない**（gated spec が取るのは `captureWavPath` だけ） |
| 私が回した `tsc -p tsconfig.json` が 0 だった | 🔴 **こちらは `tests/` を見ない**。**正本のゲートは `npm run typecheck:e2e`（`tsconfig.tests.json`）** |

**消費者のいないコードは、テストでもデフォルトの型チェックでも守られない。**
以後 `tests/` を触ったら **`npm run typecheck:e2e`** を回す。

#### 1〜3. 適用した指摘

| 指摘 | 対処 |
|---|---|
| 🔴 **hygiene が `runScore(..., { capture: true })` を capture 経路と認識しない**（設計 §17 F-1 の配線漏れ） | 検出条件に `capture:\s*true` を追加。**入れ忘れると新シナリオが何も測らなくても通る** |
| **A-3 は `KEYWORDS` が空なら真空で通る** | `expect(KEYWORDS.size).toBeGreaterThan(0)` を先頭に |
| **構文 / smoke の baseline の誠実さ検査が PR 分割の隙間に落ちている**（§3.3 は「両方」、§20 は A-10 を PR-E5 = `reference-coverage.spec.ts` のみに割当） | **A-10 をこの束に追加**（台帳に載った構文が baseline に残っていたら red / smoke baseline が実数より緩ければ red） |
| **`GatedCatalog` が手写しで、片方に field を足すと黙ってずれる** | gated spec の return に **`satisfies GatedCatalog`** を付けて機械で結んだ |

**`satisfies` が効くことを実行で確認した**: `GatedCatalog` に field を 1 つ足すと
`orbitstudio-mcp-gated.spec.ts(406,7): error TS1360` で落ち、復元すると exit 0 に戻る。

#### 4. 監査が「指摘無し」とした項目（一次ソースで確認済み）

- **`analyzeWavBuffer` の既定戻り値**: main 版と束版を cjs 化し、合成 WAV 3 種 × opts 3 種の
  **9 通りすべてで `JSON.stringify` が byte 一致**
- **`gatedItTitles()` の正規表現**: gated spec の 20 箇所すべてを回収。括弧入りの題名も正しく閉じる
- **`z.boolean().optional()`**: `required` に入らないので、`per_channel` を送らない既存クライアントは
  既定経路。戻り値も素通しで `channelWindows` は削られない

#### 5. 🔴 残る不在: PR-E0（spec 改訂）が束にも main にも無い

`docs/testing/E2E_HARNESS_SPEC.md` の main 最終更新は 2026-07-28 で、`ObservationKind` /
smoke 件数ラチェット / 「§3 網羅は実機層で取る」の改訂が入っていない。設計は
**「実装より先・運用規則 6」**と明記している。**いま台帳の `ObservationKind` は
正本より先にコードが確定した状態**。→ 束 PR の本文に明記し、owner 判断を仰ぐ。

### 束の締め: レビューチーム 4 名の結果

🔴 **3 名が独立に同じ Critical を検出**（`/simplify` の async 剥がれ）。既に修正済みだったが、
**3 系統が別々に同じ結論に着いた**ことは記録に値する。

#### ポリシー: 消費者のいない層は、テストでも型チェックでも守られない

この束はその壊れ方を **2 回**踏んだ:

1. `gatedItTitles()` がカリー形を **1 件も拾えず、空振りで緑**だった
2. `/simplify` で `waitForEngineState` から **`async` が剥がれた** — `npm test` は緑
   （`run-score.ts` に消費者がいない）、`tsc -p tsconfig.json` も 0（**`tests/` を見ない**）

したがって **helper には消費者が現れる前に直接テストを付ける**。対象は
**① コメントに書かれた受け入れ条件**と **② 壊れても黙って通る箇所**に絞る（網羅ではない）。

`tests/e2e/helpers/helpers.spec.ts`（新規・12 件）を追加。**変異で 3 件を確認**:

```
captureWavPath が env を無視     → × redirects to ORBIT_KEEP_CAPTURES ...
countLogMarker が g を補わない   → × counts a regex marker whether or not ...
waitForFile が minBytes を無視   → × does not settle for a file that is still being written
復元後                           → Tests  12 passed (12)   ／ cmp で 3 ファイル一致
```

#### 🔴 自分のテストが何も証明していなかった件（変異で発覚）

`waitForMatchingFile` の「`g` 付き正規表現の `lastIndex` 持ち越し」を Minor 指摘として受け、
リセットを入れてテストを書いた。**変異でリセットを外しても緑のままだった。**

理由: `test()` は `lastIndex` が末尾を超えると **false を返すと同時に 0 へ戻す**ので、
**次のポーリングで見つかる** — ループが吸収する。**観測可能な欠陥ではなかった。**

対処: リセットの 1 行は残す（呼び出し元の regex の状態に依存しない方が読みやすい）が、
**コメントとテスト名を「何を証明していないか」まで書く形に直した**。
主張をテストの実力に合わせないと、次に読む人が守られていると誤解する。

#### 事実の誤りを 3 件直した（comment-analyzer の指摘・すべて一次ソースで確認）

| 誤り | 実際 |
|---|---|
| WORK_LOG「capture パス **11 箇所**」 | **13 箇所**（`grep -c "captureWavPath("` = 13） |
| `dsl-surface.ts` の `import` → `tokenizer.ts:26` | **`:27`**（`:26` は `'MUTE'`） |
| WORK_LOG「**636 行**のローカル変数」 | **638 行** |

#### 残した指摘

- **`run-cli.ts` が timeout の signal を握り潰す** / **`collect()` が symlink を辿らない** —
  いずれも**現時点で消費者ゼロ**。最初の消費者が付く時に形が決まるので、そこで対処する
- **`analyze_audio(per_channel)` の MCP 配線に E2E が無い**（設計 §20 PR-E3 の受け入れ基準）—
  下記のとおり束 PR に明記して owner 判断を仰ぐ

### 束の締め: silent-failure レビューの結果（helper 3 件を直した）

いずれも**消費者ゼロの helper** — 最初の利用者が付く前が、直す最も安いタイミングだった。

#### 1. 🔴 `evaluate()` が `ok: false` を完全に握り潰していた

設計 §4.2 は「`ok` に assert しない」と言っているが、**「握り潰せ」とは言っていない。**

> `ok` は**必要条件**であって、十分条件でないことは**何も見ない理由にならない**（レビュー指摘）

**具体的な故障**: セットアップ用 `evaluate("...")` に typo があると、その場で `ok: false` が
返るのに捨てられ、**後段の capture/RMS アサーションが「音が鳴っていない」という形で落ちる**。
書いた本人はオーディオの不具合を疑って延々探すことになる。

→ **assert はせず、`console.warn` で見えるようにした**（診断が出ることを確かめる E2E を妨げない）。

#### 2. `run-cli.ts` の `stderr: ''` は「何も出なかった」ではなく「出ても見えない」だった

`execFileSync` は**成功時に stdout の文字列しか返さない**。exit 0 のまま警告だけ stderr に出す
CLI の検証が**原理的に書けなかった**。→ `spawnSync` に変更し、**`signal` も返す**
（タイムアウトで殺されたのと非ゼロ終了は別の失敗で、区別できないと調査が空回りする）。

#### 3. `try/finally` の cleanup 失敗が本来の失敗を隠していた

JS では `finally` が投げると `try` の例外を**完全に置き換える**。よりによって
「エンジンが落ちる」ことを検証するテストほど停止処理も一緒に転ぶので、見えるのが
本質と無関係な「停止待ちタイムアウト」だけ、という事故になる。

→ 元の例外を優先して投げる形に。⚠️ **最初の修正は `finally` 内で throw していて、
lint の `no-unsafe-finally` が「別の形の同じ問題」を指摘した** — ブロックを抜けてから投げる形に直した。

#### 🔴 自分のテストが 2 回続けて何も証明していなかった

| 回 | 書いたテスト | 変異の結果 |
|---|---|---|
| 1 | `waitForMatchingFile` の `lastIndex` リセット | **リセットを外しても緑**（ポーリングが吸収する） |
| 2 | `run-cli` の stderr 回収 | **stderr を捨てても緑**（`typeof x === 'string'` は `''` でも通る） |

**共通する誤り: 形（type / 存在）を検査して、区別できる振る舞いを検査していない。**

2 件目は**前提そのものを実行で固定する**形に書き直した — `execFileSync` と `spawnSync` に
同じ子プロセス（stderr へ書いて exit 0）を流し、**前者は `''`・後者は `'warned'`** を返すことを
示す。これは変異で red になることを確認済み（`'warned'` を `''` にすると落ちる）。
1 件目は**証明できないと明記する**形にした。

## 2026-09-04: PR-E0 — ハーネス仕様を現状に合わせる（#668 §19）

**Fable 監査が「設計要求の不在」として見つけたもの。** 設計 §19 は spec 改訂を
**「実装より先・運用規則 6」**と明記しているが、`docs/testing/E2E_HARNESS_SPEC.md` の
最終更新は **2026-07-28** のままで、**台帳の `ObservationKind` は正本より先にコードが
確定した状態**だった。

### 改訂した 6 項目（設計 §19 の表どおり）

| 節 | 改訂 |
|---|---|
| 冒頭の但し書き | 「現行 gated は配線 smoke であり暫定」→ **現状に更新**。`it(` 20 件・capture の数値判定・ラチェット/衛生の 2 検査が既にある |
| §2.1（新設） | **台帳の置き場と寿命**。台帳 1（仕様 ↔ テスト）は**残る**（コードから導出できない唯一の軸）／台帳 2 は **#671 段階 3 で導出に変わる** |
| §3 | 🔴 **網羅は実機層で取る**（旧版は逆だった）。オフライン層は**回帰の固定**（bit 一致）に絞る |
| §4.1（新設） | **観測タイプを列挙で固定**（`ObservationKind`）。`smoke` は「監査で警告」ではなく**件数ラチェット**（警告は読まれないが red は止まる） |
| §6.3 | 🔴 **変異スイープを PR のクリティカルパス外に**。`cargo-mutants --in-diff` を名指す |
| core spec §10 | 三者一致の仕組みと「**DSL を足したら E2E も足す**」を参照（運用規則 7・乖離を作らない） |

### §3 の改訂がいちばん大きい

旧版は網羅を**オフライン層**に、実機層を「代表構文のみ」に割り当てていた。**現状と逆だった。**

- **ラチェットが数えているのは gated spec の語**である（実機層のソースを走査している）
- owner 確定（2026-09-03）:「**MCP 経由、つまりユーザーと同じ形でテストするのが重要**」
- 実害: `global.gain()` が instrument に効いていなかった欠陥は、**変異 35 件・ユニット 2149 件が
  すべて素通りし、キャプチャの RMS 実測だけが捕まえた**

**仕様の方が実装より古いまま置かれていた**ので、正本を現状に追いつかせた。
