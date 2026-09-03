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

## 束 668-e2e-foundation — E2E 基盤（段 0・安全網）

正本: [`docs/design/668-e2e-foundation-design.md`](../design/668-e2e-foundation-design.md) /
[`docs/planning/IMPLEMENTATION_PLAN_2026-09.md`](../planning/IMPLEMENTATION_PLAN_2026-09.md) §1.10。
束ブランチ運用（[`BUNDLE_BRANCH_WORKFLOW.md`](BUNDLE_BRANCH_WORKFLOW.md)）の最初の束。

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
