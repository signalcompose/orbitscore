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
`docs/planning/2026-09-02-feature-map-comments.md` だけ**で、WORK_LOG 6.427 の
「事実確認で判明したこと」表（`docs/development/WORK_LOG.md:33`）は
**撤回前の「ブラウザ前提」を残したまま**マージされた。表の 3 行下（同 :35-41）が
その主張を明示的に誤りと書いているので、**同じ節の中で表と本文が矛盾**していた。

表の行を、撤回後の事実（生成 WASM は何も import しない＝ブラウザ前提ではない）に合わせた。
**評価の内容そのものは 6.427 の本文と `docs/planning/` の記述に従っただけで、新しい判断はしていない。**

#### 追従不要と判断した層

PR #678 の差分は `docs/development/WORK_LOG.md` と `docs/planning/2026-09-02-feature-map-comments.md`
の 2 ファイルのみ。`packages/` `rust/` `sites/` を 1 行も触っていないため、
DSL 仕様・MCP の表面・OrbitStudio の評価フローはいずれも変わっておらず、
`docs/specs-v2/` `docs/core/` `sites/user/` `sites/dev/` の追従先は無い。

🔴 planning 文書が記録した決定（#680 の「DSL はプレーン値」など）は**未実装の設計入力**であり、
`sites/dev/decisions/` の ADR（実装済みのアーキテクチャ決定を記録する場所）へは**書かない**。
実装が入った時点で書く。

---

### 6.427 docs(planning): 機能マップへの owner コメント 9 本を設計の入力へ (Sep 2, 2026)

**Issue**: #677 / **文書**: `docs/planning/2026-09-02-feature-map-comments.md`

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
