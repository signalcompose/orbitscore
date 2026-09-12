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

### refactor(daemon): move the bus-routing methods into a child module (Sep 12, 2026)

**Date**: 2026-09-12 / **ブランチ**: `888-c1-bus-lines`（base = `888-split-engine-wrap`）

#888 子 1 の**第 2 束**。🔴 **純粋な移動**。

`device_dest_from_wire` / `render_dest_rejected` / `link_dest_rejected` / `set_bus_line` /
`set_bus_routing` / `set_source_routing`（元 6956-7451・496 行）を
`src/engine_wrap/bus_lines.rs` へ。**ヘルパー 3 本を一緒に動かした**のは、置いていくと
モジュールを跨いで `pub(crate)` 化が要り、それは「移動」ではなく「変更」だから。

| | before | after |
|---|---|---|
| `engine_wrap.rs` | 6,014 コード行 | **5,585** |
| `engine_wrap/bus_lines.rs` | — | 433 |
| `excluded` | 7,730 | **7,730** |

**residual**: 素の変更行 1,013 → moved+ 496 == moved− 496 → **residual 21**
（うち 15 行は新設 doc コメント = **実質 6 行**）。ゲート (i) 通過。

🔴 **引用が 14 件落ちた**（7 箇所 ×2 言語）。第 1 束と違い、**移動したコード自体が引用されていた**ので
4 箇所は**ファイルパスごと** `bus_lines.rs` へ向け直した。残り 3 箇所は行番号のずれ。
`docs:check` は**先頭行しか照合しない**ので、末尾が関数シグネチャの途中で終わっていた 1 件を
引用元の文脈まで読んで確認した（「関数コメントが機構を一文で言い切っている」を見せる意図なので
doc コメント + シグネチャで正しい）。

**検証**: cfg 4 象限緑 + `clap-host` 単独 / `cargo fmt --check` / `cargo test` 58 passed /
`npm test` **2,445 passed**（不変）/ lint / `docs:check` 948 引用 0 failed。


### refactor(daemon): move the stats/health accessors out of engine_wrap.rs (Sep 12, 2026)

**Date**: 2026-09-12 / **ブランチ**: `888-c1-stats`（base = `888-split-engine-wrap`）
**担当**: 設計 = Fable / 実装・検証 = main

#888 子 1 の**第 1 束**。設計は `docs/design/888-child1-first-extraction.md`。
🔴 **純粋な移動**（本文は 1 行も書き換えていない）。

- `impl EngineWrap` の 40 メソッド（`clap_post_peak` 〜 `output_channels`・元 8972-9550）を
  **子モジュール** `src/engine_wrap/stats.rs` へ。`use super::*;` + `impl EngineWrap { … }` で包む
- 🔴 **可視性の変更 0 件**。子モジュールは親の private フィールド・private `use` に到達できる
  （兄弟モジュールにすると `pub(crate)` 化が多数必要で、それは「移動」ではなく「変更」）
- **インラインテスト mod は動かさない**（コード行に数えられず目標に寄与しない）。`excluded` は 7,730 で不変
- `mod stats;` は**先頭ではなく impl の閉じ括弧の直後**に置いた。先頭だと行番号が +2 ずれて
  dev サイトの引用が約 20 箇所動く

**結果**: `engine_wrap.rs` **6,418 → 6,014** コード行 / `stats.rs` 408（500 以下なので baseline 無し）。

**residual**（§5.1a の新ルールで初の実測）:

```
素の変更行 1,176  →  moved+ 579 == moved− 579  →  residual 18
```

うち 11 行は新設モジュールの doc コメントなので**実質 7 行**。移動した 579 行は 1 行も residual に出ていない。
ゲート (i) `moved+ == moved−` 通過。

**検証**（main が sandbox 外で実行）: `cargo fmt --check` / `clippy --all-targets -D warnings` /
**`scripts/check-cfg-matrix.sh` 4 象限緑** + `clap-host` 単独 / `cargo test -p orbit-audio-daemon` /
`npm test` **2,445 passed**（前と同数 = 期待値不変）/ lint / `docs:check` 948 引用 0 failed。

🔴 **`docs:check` は一度落ちた**（4 件 = 引用 2 箇所 ×2 言語）。ソースを動かすと引用が必ず動く。
`--fix` は行番号を合わせるだけなので、**新しい行を grep で探し、着地先の中身を目視で照合してから**
書き換えた（構造体が `}` で閉じ、メソッドが `}` で閉じることを確認）。
ずれ幅が −578 と −580 の 2 種類あるのは、`mod stats;` の挿入位置の前後で変わるため。

🔴 **cfg 4 象限を手書きループで確かめようとして壊した**（zsh は未クォートのパラメータを単語分割
しないので `--features clap-host` が 1 引数として渡り、全象限が偽の FAIL になった）。
CLAUDE.md が「ループを手書きしない」と記録しているとおりで、`scripts/check-cfg-matrix.sh` を使った。


### test: add a file-size ratchet for Rust and TS sources (Sep 12, 2026)

**Date**: 2026-09-12
**ブランチ**: `888-file-size-ratchet`
**担当**: 設計 = Fable / 実装 = Sonnet subagent（🔴 **Codex CLI は一度も起動していない**。
`codex:rescue` のラッパが自分で実装した。`codex-companion status` の `recent` が空で
`latestFinished` が null であることで確認）/ 検証・裁定 = main

#888 子タスク 0「仕組みだけ入れる（振る舞い不変）」。設計は
`docs/design/888-file-size-ratchet-design.md`。ソースは1行も変えていない。

**やったこと**:

- `tests/repo/code-lines.ts`: 「コード行」を数える純関数 `countCodeLines`。行単位の状態機械
  （通常 / 文字列 / raw 文字列 / テンプレートリテラル / ブロックコメント）で、空行・コメント
  専用行を除き、複数行の文字列やテンプレートリテラルの内側は中身に関わらず数える。Rust の
  `#[cfg(test)] mod`（`#[cfg(all(test, ...))]` を含む）はブロックごと除外する。終端で異常状態
  （閉じていない文字列・test mod）のまま終わったら例外を投げる（迷ったら数える側に倒す）。
- `tests/repo/file-size-targets.ts`: `git ls-files -z`（`:(glob)` magic 付き）で測定対象を列挙。
  Rust は `rust/crates/**/*.rs` から `tests/` `examples/` `benches/` `build.rs` `src/**/tests.rs`
  を除いたもの、TS は `packages/*/src/**/*.ts`。真空防止（除外適用前の生の列挙件数で判定）。
- `tests/repo/file-size-baseline.json`: 閾値超過ファイルだけを列挙した baseline（25件・Rust 15 /
  TS 10）。**実装のカウンタが出した現寸をそのまま登録**した。
- `tests/repo/file-size-ratchet.spec.ts`: 既存3本（`worklog-size.spec.ts` /
  `dsl-e2e-coverage.spec.ts` / `planning-issue-state.spec.ts`）と同型のラチェット+honesty。
  baseline を超えた成長は red、baseline が古くなった（消えた・実際より緩い）ら red。
- `tests/repo/code-lines.spec.ts`: `countCodeLines` の機能テスト（設計 §9.1 の F-1〜F-19 相当）。
- `tests/repo/file-size-targets.spec.ts`: 列挙そのもののテスト（設計 §9.2 の L-1 / L-2）。
  **レビューで未実装が判明して後から足した**（下記）。

**設計からの逸脱・補足**:

- 真空防止の閾値判定は、`tests/` 等の除外を適用した**後**の件数ではなく、`git ls-files` の
  **生の**結果に対して行うよう修正した。除外後の件数（Rust 95件）で判定すると、正当な除外で
  100件を割り、真空防止が誤って発火する。
- `listMeasuredFiles` に既定値付きの第2引数（pathspec 差し替え口）を足した。L-2 が真空防止の
  発火そのものを確かめるための注入口で、既定の挙動は変わらない。
- 🔴 **baseline の数値は設計文書 §5.1 の試作値と 25 件中 8 件で食い違い、main が「実装側が正しい」と
  裁定した**（設計 §11 の反証条件がそのまま発火したケース。設計文書の表は実装値に差し替え済み）。根拠:
  - **TS 10 件**: TypeScript 自身の**パーサ**を独立オラクルにして測り（`ts.createSourceFile` の葉
    トークンが占める文字を印し、JSDoc ノードは除外）、**実装の値と 10/10 完全一致**。
    `extension.ts` は **2,779**（試作の 3,004 は正規表現リテラル未対応による過大）
  - **Rust**: main が独立に `#[cfg(test)] mod` の除外レンジを列挙し 4 件中 3 件で一致。唯一ずれた
    `engine_wrap.rs` は **main の列挙の側のバグ**だった（Rust のフォーマット文字列の中の `{` `}` を
    brace として数え、`mod outproc_load_error_test_support` を 12279 行で早期終了。実際の終端は
    12557 行で、差の 278 行が実装との差と正確に一致した）

**🔴 レビューで塞いだ穴 — 「仕事が成功した時に開く」型**:

初回実装には設計 §4.1・§9.2 が名指しで要求していた **L-1（列挙に既知の代表ファイルが含まれることの
検査）が無かった**。真空防止のしきい値（Rust/TS とも 100 件）だけでは、pathspec が `:(glob)` magic を
欠いて `src/` 直下を落とす事故を**検出できない** — TS は非 glob でも 109 件（> 100）返るためである。

いまは `extension.ts` が baseline にあるため honesty 検査が偶然 red にするが、**子 4/5 でそのファイルを
分割して baseline から外した瞬間にその防御は消える。** main が再現した fail-before: baseline から 2 件を
外し（= 分割後の姿）`:(glob)` を落とすと、**23 ファイルが黙って測定対象から消えたままスイートは緑**
だった。L-1 を足した後は、同じ条件で red（exit=1）になることを main が確認している。

**検証**（すべて main が sandbox 外で実行。委譲先の緑は根拠にしていない）:
`npx vitest run --dir tests --config vitest.config.ts tests/repo`（**36件緑**）/
`npm test`（**166 files・2424 passed / 76 skipped**）/ `npm run lint`（緑）/
`npm run docs:check`（948 引用・0 failed）。**既存テストの期待値は 1 つも変えていない。**

変異検証（main が実行・5 件すべて red → restore 後 緑・baseline は byte 一致）: baseline 値の
+1 / −1 / エントリ削除 / 架空パス追加 / `threshold` を 600 へ。

**`/simplify` で適用した整理**（4 観点を並行レビュー・PR #894）:

- `code-lines.ts`: `pendingBuffer: Array<{isCode:boolean}>` → `pendingCount: number`。
  バッファに積まれる行は `isTestCfgAttrLine` / `ATTRIBUTE_LINE` / `MOD_OPEN_LINE` のどれかに
  **完全一致**した行だけで、行コメントや末尾コメント付きの行は一致しない。よって `isCode` は
  常に `true` で、持つ意味が無かった（main が正規表現を読んで検算）
- `file-size-ratchet.spec.ts`: 2 つの `it` が独立に呼んでいた `measureAll()` を `beforeAll` へ集約。
  同じ PR の `file-size-targets.spec.ts` が既に測定を共有しており、**同一 PR 内で同じ問題に 2 つの
  書き方が混在**していた。`beforeAll` を選んだのは、`measureAll()` が throw した時に collection
  エラーではなく**ファイル名付きのテスト失敗**として出るため
- `code-lines.spec.ts`: 3 つの `it` が共有していた `F-18` ラベルを `F-18a/b/c` に分けた
  （設計 §9.1 の F-18 は 1 行で 3 シナリオを束ねているので重複自体は仕様に忠実だが、識別できない）

**却下した指摘 1 件**（altitude 観点・`listMeasuredFiles` の第 2 引数が #887 の `__*ForTest` と同型という指摘）:

1. #887 が問題視しているのは**出荷される** `extension.ts` の裏口。`tests/repo/file-size-targets.ts`
   はテスト基盤そのもので出荷されない。既定値付き引数は通常の引数化である
2. 提案された「真空防止を純関数へ切り出す」は、**`listMeasuredFiles` がそれを呼んでいるかの配線が
   検証されなくなる**（CLAUDE.md が名指しで警告している形）
3. 指摘の「該当言語の pathspec が無ければチェックが素通りする」は事実誤認。ループは
   `Object.keys(MIN_FILES_PER_LANG)`（固定の `{rust, ts}`）を回しており、片方が欠ければ
   `0 < 100` で throw する（穴ではなくガードが働いている姿）

**リファクタ後の再検証**（main が実行）: 変異 5 件すべて再び red / `code-lines.ts` の
`commitPending` を殺す変異 2 種も red（除外側 4 件・code 側 2 件）/ `npm test` 2424 passed /
lint・`docs:check`・`typecheck:e2e` 緑。**baseline 25 件の値は 1 つも変わっていない**
（honesty 検査が `baseline == 実際` を要求するので、これが振る舞い保存の検算になる）。

**`/code:pr-review-team`（4 名）+ Fable 設計監査（並行）のラウンド 1**:

Critical 0。Important 5 件・Minor 17 件を main が集約し、**故障の向き**で仕分けた。

🔴 **修正前に置いたポリシー**（CLAUDE.md「横断的関心事は先にポリシーを書いてから一括適用」）:

> ラチェットの信用は「数え方が正しい」ことに依存する。数え方の誤りは **(a) 多く数える = 安全** /
> **(b) 少なく数える = 穴** に分かれ、§3.3 は (b) を禁じている。しかし heuristic を含む字句解析で
> (b) を*構成的に*排除することはできない。したがって **heuristic を改良するだけで済ませず、
> 独立したオラクルで全件を検算する**形に変える。

**直した 6 件**:

| # | 内容 |
|---|---|
| **F-1** | 🔴 **`code-lines-oracle.spec.ts` 新設** — TypeScript の**パーサ**を独立オラクルにして TS 全 132 件を検算。既知の差は shebang 1 件のみで許容リストに明示（設計 D9・§3.4） |
| **F-2** | **入れ子テンプレートリテラルで黙って少なく数える**穴を塞いだ。`templateStack` で `${…}` 置換の brace 深さを追う |
| **F-3** | 真空防止を **pathspec エントリ単位**にした。従来は lang 合計だったので、将来足すエントリが `:(glob)` を忘れて 0 件でも既存 132 件が支えて緑だった |
| **F-4** | ラチェット判定を純関数 `findViolations` / `findHonestyProblems` に切り出し、**合成データで §5.2 (a)〜(f) を網羅**。実データの 2 つの `it` は同じ関数を呼び続ける（配線を失わない） |
| **F-5** | throw メッセージに**壊れ始めた行番号**を入れた（設計 §8.1 が要求していたが未実装だった） |
| **F-6** | baseline JSON の**キー辞書順**を honesty 検査で強制（設計 §5.1 が要求） |

**直さなかった 3 件**（いずれも**安全側**に倒れ、現リポジトリに該当 0 件）:
`=>` 直後の正規表現（**throw する**）/ BOM のみの行（多く数える）/ `#[cfg(test)]` と `mod` の間の空行（除外されず多く数える）。

🔴 **Fable 監査が main の検証の穴を突いた**（設計 §13.8 に反映）: main の敵対ケース 4 件は
すべて「ブロックを塊のまま動かす」形だった。塊を崩す 2 型は residual をすり抜ける —
**(E) 1 文を関数間で移動**（振る舞いが変わるのに residual 0。git は 20 英数字以上なら 1 行でも
移動と認める）/ **(F) 消して 2 回足す**（複製が見えない）。対策として §13.4 に
`moved+ == moved−` と「短い moved ブロックは residual 扱い」の 2 ゲートを追加。
Fable はまた **TS オラクルを baseline の 10 件ではなく測定対象 132 件全件**に適用して
131/132 一致を確認しており、main の検証範囲が狭かったことも示した。

**設計文書の訂正**（main）: §3.1 の「誤判定は必ず例外で red になる」という**安全性の主張を撤回**
（偶数個のクォート / backtick で黙って通る経路が実在）・§4.2「Rust 96 件」→ **95 件**
（文書自身の算式も実測も 95）・§13.8〜§13.10 を新設・決定表に **D9 / D10** を追加。

**検証**（すべて main が sandbox 外で実行・委譲先の緑は根拠にしていない）:
`npm test` **167 files・2445 passed / 76 skipped**（+21 件）/ lint・`docs:check`（948 引用 0 failed）・
`typecheck:e2e` 緑 / `tests/repo` **57 件**。

**マージ前ゲート**（main が sandbox 外で実行）: `npm run build` ✅ / `bundle-macos.sh` + 
`rack-child --lib -- --ignored` **3 passed** + `--lib` **16 passed** ✅ /
**実機 gated E2E 45 passed / 1 skipped / 0 failed** ✅ / **cold install 2 passed** ✅ /
CI 3/3 pass ✅。

🔴 **実機 E2E は 1 回目が「走っていなかった」。** sandbox 内で `mktemp` が
`Operation not permitted` になり、しかも `| tail` のせいで **exit code 0 に化けていた**
（タスク通知も「completed (exit code 0)」と報告した）。出力の中身を読んで気づき、
sandbox 外で `set -o pipefail` 付きで回し直した。**終了コードと通知だけでは区別がつかない。**

### 🔴 owner 裁定: 分割束の上限は residual で数える（2026-09-12）

> フルレビュー 40 回はちょっと作業として重すぎる

`BUNDLE_BRANCH_WORKFLOW.md` に **§5.1a** を制定した。分割（純粋な移動）の束は
**residual 行数で 1,500 を判定**し、加えて **(i) `moved+ == moved−`**（複製・移動先の作り忘れ）と
**(ii) K 行未満の短い moved ブロックは residual 扱い**（1 文の関数間移動）の 2 ゲートを課す。
**最終防波堤は「既存テストの期待値を 1 つも変えていない」。**

根拠は実測（設計 §13.6〜§13.8）: 実素材の抽出で **686 変更行 → residual 2 行（0.3%）**。
敵対ケース 4 件は全部捕まえるが、**Fable 監査が見つけた抜け道 2 型**（1 文の関数間移動 = residual 0 /
消して 2 回足す = 複製が見えない）は追加ゲートが要る。

**見込み**: #888 の子 1〜3 は素の変更行なら約 40 束、residual なら **8〜9 束**。
fail-before / pass-after を main が再現: 入れ子テンプレート **4 → 5**・throw メッセージの行番号・
**オラクルが状態機械の破壊 2 種を検出**・honesty の `(f)` 分岐の変異が **red**（修正前は緑）・
baseline 変異 5 件がリファクタ後も全件 red。**baseline 25 件の値は 1 つも変わっていない。**

### refactor/test(engine): fold the #889 review rounds — env containment, wiring coverage, a trigger (Sep 12, 2026)

**Date**: 2026-09-12
**ブランチ**: `878-engine-spawn-without-path`（PR [#889](https://github.com/signalcompose/orbitscore/pull/889)）
**担当**: レビュー = `/simplify` 4 観点 + pr-review-team 4 体 + Fable 監査（並行）/ 裁定と fix = main

#878 の修正本体（1 つ前の項）に対するレビュー 3 波を畳んだ記録。**本項が無かったのは
`simplify-commits-still-need-worklog` の再発**で、Fable 監査に指摘されて足している。

#### 1. 🔴 `ELECTRON_RUN_AS_NODE` が daemon とプラグイン子まで漏れていた（altitude）

`spawnDaemon()` は `env` を渡しておらず全継承だった。Rust 側は `Command::new` の際に
`env_clear` / `env_remove` を**一切呼んでいない**（実測 0 件）ので、**第三者のプラグイン
ホストまで**届いていた。Node ↔ ネイティブの唯一の受け渡し地点に `daemonEnv()` を置いて断つ。

🔴 **根拠は「自分が足したものを自分の出口で戻す」**に限定した。Fable 監査の指摘どおり、
「ホスト由来の変数を第三者へ渡さない」を根拠にすると**不十分**である — 拡張ホストの env には
`VSCODE_*` や他の `ELECTRON_*` も乗っており（VS Code 自身は端末を起こす時
`sanitizeProcessEnvironment` で `/^(ELECTRON|VSCODE)_.+$/` を丸ごと落とす）、ここは素通しする。
そこまでやるなら別の設計判断。

#### 2. 🔴 純関数は守られ、**配線が無防備**だった（変異で実証）

| | 結果 |
|---|---|
| `env: daemonEnv(process.env)` → `env: process.env`（呼び出し側が helper を迂回） | **62 件すべて緑** |

`consumerless-code-is-unprotected` そのもの。既存の実 spawn ハーネス（`#484 D1` の argv
recorder）に env のダンプを足し、**子プロセスの env を直接見る**テストを追加。同じ変異で
**red**、復元で **green（63/63）** を実走で確認した。

🔴 「`ELECTRON_RUN_AS_NODE` が無いこと」だけを見ると env ごと空にする実装でも通るので、
**他の変数が届いていること**（`PATH=`）まで見る。

#### 3. 🔴 cold install テストに**実行の引き金が無かった**

`ORBIT_GATED_COLD_INSTALL` を参照する npm script も workflow も**存在しなかった** —
`a-test-that-exists-may-never-run` の形で、#878 の修正を守る唯一のテストが誰にも
走らされない位置にあった。

- `npm run test:e2e:cold-install`（`pretest:` で build → `.vsix` パッケージ）を追加
- CLAUDE.md のマージ前ゲートに**無条件の 1 行**として追記

レビュアーは `release.yml`（macos-14）への追加を提案したが、**GitHub の macOS runner には
VS Code が入っておらず音声デバイスも無い**。`test:e2e:gated` と同じく**手元が唯一の実行経路**
であることを明記した。

#### 4. 一次ソースで裏を取った 3 件

| 問い | 結果 |
|---|---|
| Electron の `runAsNode` fuse を VS Code が将来切ったら偽の「起動した」になるのでは（silent-failure レビュー） | **切れない**。VS Code 自身の CLI が `ELECTRON_RUN_AS_NODE=1 "$ELECTRON" "$CLI"` で動き（`Contents/Resources/app/bin/code`）、拡張ホストの fork（`out/bootstrap-fork.js`）も依存する。切れば `code` が壊れる |
| N-API prebuild が読めたのは偶然か | **偶然ではない**。ローダは `node-gyp-build` ではなく **`pkg-prebuilds`** で、**N-API の時は Electron 判定へ入らず** `node-napi-v7.node` に決定論的に落ちる（`pkg-prebuilds/bindings.js`） |
| 素の node との意味論差は無いか | **1 つある**。`ELECTRON_RUN_AS_NODE` の子では asar フックが生きており、`fs` が「`.asar` で終わるディレクトリ」をアーカイブ扱いする。engine は利用者の与えたパスを読むので、`ELECTRON_NO_ASAR=1` を併記して差を消した |

#### 5. 直した事実誤り

- コメントの「VS Code **1.104 系**」→ **1.134.0**（この機の実測値。出典を足したコミットで版を間違えていた）
- `resetExtensionEngineTestState()` が `__set*ForTest` の**全部ではなく 4 本**であること、残り 2 本の
  使い手、**完全性を強制する仕組みが無い**ことを明記（誤解を与える記述だった）
- `656-release-design.md` の**7 箇所**が「PATH の `node`」のまま（§2 現在地 / §9 データの通り道 /
  §10 grep 貼付 / §14 PR-C2 / §15 確信度 / §16 裁定待ち / §6.3 冒頭）。`IMPLEMENTATION_PLAN` と
  `USER_OUTCOMES` の PR-S-C2 行にも注記。**裁定を更新したのに追従していない層**が残る
  （`one-layer-of-the-spec-lags-the-ruling`）を、今回は 7 層で踏んでいた

#### 6. 🔴 自分で作った CI の赤

`/simplify` で `extension.ts` の 1 行を畳んだ後、`docs:check` を回し直さずに push し、
**CI で 74 件**落として初めて気づいた。`pre-push` に `docs:check` を足して仕組みで止めた
（🔴 **rust ゲートより前**に置く — 後ろだと rust を触らない push で走らない）。

#### 採らなかった指摘

| 指摘 | 裁定 |
|---|---|
| 遅延クラッシュが auto-start 経路でしか通知されない | #533 からの**既存構造**で本 PR 起因ではない。#890 へ切り出し |
| ユニット 3 本を 1 本に畳む | 畳むと最初の `expect` で止まり残り 2 つの結果が見えない。回帰ゲートには独立した失敗信号の方が価値がある |
| 拡張の `package.json` に `engines.node` を足す | **逆効果**。VS Code 同梱の Node を使う以上、利用者に node を要求しない方が正しい |
| `selectRootPids` での teardown | `--user-data-dir` が `mkdtemp` で一意なので blanket `pkill` の故障モードが成立しない |
| 起動フラグ列の共通定数化 | 45 本の gated suite 本体を触る。#888 へ |
| `which claude`（`extension.ts`）も同じ PATH 依存 | 同じ故障クラスだが node ではなく、直すには設計が要る（別 issue 候補） |

`npm test` **2,354 passed / 0 failed**・lint 緑・`typecheck:e2e` 緑・引用 **948 / 0 failed**・
**cold install 2/2**（`npm run test:e2e:cold-install` で実走）。実機 gated は main と同一の
既知 red 1 件（`ph654`・PR #884 が修正済み）。

Part of #878

---

### fix(extension): start the engine with VS Code's own Node instead of PATH (#878) (Sep 12, 2026)

**Date**: 2026-09-12
**ブランチ**: `878-engine-spawn-without-path`（base = `main`）
**担当**: 実測・実装・検証 = main

#883 の cold install 検証（4.0.0 のリリース前倒し確認）の副産物として、**#878 が確定で再現する条件を
特定した**ので直した。

#### 何が壊れていたか

`extension.ts` は engine をこう起動していた:

```ts
child_process.spawn('node', [enginePath, ...args], { ... })
```

**`node` を PATH から引いている。** Finder / launchd から起動された VS Code の PATH は `/etc/paths` の
最小構成で、`nodenv` / Homebrew で node を入れている環境（珍しくない）ではそこに node が無い。
engine は `spawn node ENOENT` で起動せず、**症状は「エンジンが起動しない」だけ**なので原因が PATH だとは
利用者にまず分からない。

#878 は「VS Code のシェル環境解決に救われて**実際には通った**」と記録されていた。本日、**通らない条件**を
実測で特定した:

| 起動のしかた | 結果 |
|---|---|
| `Contents/MacOS/Code`（Finder 相当） | 音が出る |
| `bin/code`（CLI ラッパ）+ node の無い PATH | 🔴 **`spawn node ENOENT`** |
| `bin/code` + `SHELL` あり + node の無い PATH | 🔴 **同じく起動しない** |

CLI ラッパ経由だと VS Code は**ログインシェルの環境解決を省く**（端末から引き継ぐ前提）。
`code .` を、nodenv を初期化しないログインシェルから叩けば同じ条件になる。

#### 直し方 — 🔴 裁定を更新した（Q-656-8b）

`docs/design/656-release-design.md` §6.3 は同じ問題に対して **(A) `process.execPath` +
`ELECTRON_RUN_AS_NODE=1`** と **(B) node を同梱** を挙げ、**2026-09-03 に owner が B を裁定**していた。

**その裁定の前提は 2026-09-10（#827）で変わっている。** 当時の配布物は VSCodium フォークの `.app` で、
指定された同梱先も `.app/Contents/...` だった。フォークを畳んで**拡張線は `.vsix` のみ**になった今、
`.vsix` は Node を持っているホスト（VS Code）の中で動くので、B は 50MB 超の同梱と署名対象 +1 を払って
**ホストが既に持っているもの**を二重に運ぶことになる。

→ owner 裁定（2026-09-12・**Q-656-8b**）: **拡張線は A**。B は**ネイティブ `.app` 向けとして残る**
（借りる VS Code が無いのでそちらでは A が使えない）。配布物が違うので矛盾しない。

#### A が成立することの実測（仮定していない）

| 確かめたこと | 結果 |
|---|---|
| `process.execPath` は素のままで Node か | ❌ **ならない**（`Unable to find helper app` で落ちる）→ `ELECTRON_RUN_AS_NODE=1` が要る |
| VS Code 同梱の Node 版 | **24.18.1**（本リポジトリの要求は `>=22.0.0`）✅ |
| ネイティブアドオン（`@julusian/midi` の N-API v7 prebuild）が読めるか | ✅ **素の node と同じ**（port count 14 で一致）。`electron-` prefix の prebuild は無いので事前に疑ったが、実際には解決された |
| PATH 依存の spawn が他に無いか | ✅ **1 箇所だけ**（`fork()` も Rust 側からの node 起動も無し） |

#### 積んだテスト

- `tests/vscode-extension/engine-spawn-runtime.spec.ts`（3 本・ユニット）— 何を spawn したか。
  「絶対パスであること」だけを見ると `/usr/local/bin/node` 決め打ちでも通るので、**`process.execPath`
  そのもの**であることと `ELECTRON_RUN_AS_NODE=1` を見る
- 🔴 `tests/e2e/vsix-cold-install-gated.spec.ts`（2 本・`ORBIT_GATED_COLD_INSTALL=1` でゲート）—
  **dev host はこの層を構造的に通らない**（`dev-host-is-blind-to-the-packaged-artifact`）。
  空の extensions-dir へ `.vsix` を入れ、`--extensionDevelopmentPath` **無し**で起動して
  **capture WAV の RMS まで**見る。**strict**（CLI ラッパ + node の無い PATH + `SHELL` 無し）が #878 を、
  **finder**（app 本体を直接起動）が #873 を守る

#### 変異検証（実走・自己申告ではない）

| | 結果 |
|---|---|
| 変異（`process.execPath` → `'node'`・env を戻す）→ 再パッケージ → strict | 🔴 **red**（`🛑 Engine process error: spawn node ENOENT`） |
| 復元 → 再パッケージ → 2 本とも | ✅ **green**（19.4 s） |

#### ゲート

`npm test` **2,350 passed / 69 skipped / 0 failed**・`typecheck:e2e` 緑・lint 緑・
引用 948 / 0 failed・**cold install 2/2**（strict / finder）。

dev サイトの 6 箇所は `--fix` では直らなかった（行番号ではなく**中身**が変わったため）ので、
引用ブロックと本文・mermaid ラベルを手で追従させた。

Closes #878
### fix(dsl): make the missing-output diagnostic read the whole chain (#883 束 S・レビュー round 1) (Sep 12, 2026)

**Date**: 2026-09-12
**ブランチ**: `883-explicit-output-semantics`（PR [#885](https://github.com/signalcompose/orbitscore/pull/885)）
**担当**: レビュー = pr-review-team 4 体 + Fable 監査（並行）/ 裁定と fix = main

束 S のレビュー round 1。**5 体の指摘を 4 つの機構に畳んで一度に当てた**（指摘単位のローカル
パッチはしない）。

#### 1. 診断がチェーンの途中の出口を読めていなかった（Important・**3 体が独立に到達**）

`analyzeMissingOutput()` のレシーバ判定は、**「行がこのシーケンスのものか」と「どのメソッドか」を
1 本の正規表現で兼ねていた**。名前の直後しか見ないので、チェーンの途中に置いた出口が消える。
`.output(` だけが `chainReceiver` でチェーン対応しており、**非対称がそのまま残っていた**のが証拠。

実測（fix 前・5 件とも red）:

| 譜面 | 出ていた診断 | 正しい診断 |
|---|---|---|
| `kick.audio("k.wav").send("verb", -12)` | `output-missing`（"it will be silent"） | `dry-not-routed` |
| `kick.gain(-3).master` | `output-missing` | なし（裸形 master は正当な出口） |
| `kick.gain(-3).drums` | `output-missing` | なし |
| `kick.send("verb",-12).send("drums",-6)` | `dry-not-routed` | なし（2 本目が sum） |
| `kick.audio("k.wav").play(1)`（出口なし） | **なし** | `output-missing` |

最後の 1 行は逆方向の取りこぼしで、**発火点の `play(` 自体がチェーン途中だと 1 件も警告されない**。
レビュアー 2 体はここに触れていない — main が probe で列挙して見つけた。

**直し方**: レシーバの 2 つの仕事を分けた。行の帰属は `\b<name>\b`、メソッドは
レシーバを含まないモジュール定数（`OUTPUT_CALL` / `MASTER_ACCESS` / `SEND_CALL` / `PLAY_CALL` /
`MIDI_CALL`）。**バス名のパターンも文書ごとに 1 度だけ**組み立てる（打鍵ごとに走る診断なので、
シーケンス数 × 行数 × バス数 の再コンパイルを避ける）。1 行に 2 つ置いた `send` を両方読めるように
なったのは副次効果。

#### 2. 「無音へ倒す」時に痕跡を残す（Important 1 + Minor 1）

§2.6 は「表現できない routing は無音」だが、**仕様上の無音と不変条件違反は区別が付かなければ
ならない**。ライブ中に「書き忘れ」と「バグ」を切り分ける手段が要る。

| 箇所 | 直す前 | 直した後 |
|---|---|---|
| `output.rs` `SourceDestCell::encode` の範囲外 fallback | `debug_assert!` のみ。`[profile.release]` は `debug-assertions` を上書きしていない（既定 false）ので**出荷ビルドでは何も残らない** | `eprintln!` を併記（`encode` の呼び手は制御プレーンのみ・実測） |
| `output.rs` `decode` | — | **据え置き**。RT コールバック（`collect_source_feeds`）から呼ばれる。唯一の書き手が `encode` なので追える旨をコメントに |
| `sequence.ts` `instrumentSourceRoutingTarget()` の inconsistent route | 無言で `{kind:'none'}` | 既存の `logSkipOnce()` を再利用（per-reason dedup 付き） |

#### 3. wire の版を上げた（Fable 監査・②-4）

本 PR で `SetSourceRouting.target` が非互換になった（`null` / 生文字列を受け付けない）のに
`PROTOCOL_VERSION` は scaffold 以来 `'0.2'` のままだった。**版を上げないとずれは handshake ではなく
最初の `SetSourceRouting` まで露見せず、その間 instrument は旧既定の master で鳴り続ける**
（孤児 daemon を掴んだ時に実際に起きうる）。`'0.3'` へ。不一致は `daemon-client.ts` の
両経路で loud に落ちる（実装済みの機構・新設ではない）。

#### 4. 記録と前提条件

- `tests/vscode-extension/output-code-action.spec.ts` が**ディスクにあるのに一度もコミットされて
  いなかった**（pr-test-analyzer）。D8 の quick fix 配線が無防備だった。コミットに含めた
- `InsertBusStage::with_output_target` / `with_sends` に前提条件を明記（`[Rack]` 既定の stage に
  対しては前者が黙って捨て、後者が panic する）
- `resolveDispatchChannel()` の skip を **LinkAudio 抜き**で押さえる unit を 1 本追加（既存の
  1 本は `global.linkAudio()` を先に呼んでおり、LinkAudio ゲートと区別が付かなかった）

#### D15 の変異表（Fable 監査が実走・各 1 行変異 → 対象 test → `git checkout --` で復元）

設計 §2.6 の 6 箇所（+ `#[default]`）を Master に戻すと red になることの記録。**テストは効いており、
欠けていたのは記録だけ**だった。

| 変異 | red になった test |
|---|---|
| `encode` の範囲外 fallback `NONE` → `MASTER`（`output.rs`） | `source_dest_cell_roundtrips_every_destination_and_defaults_invalid_values` |
| `decode` の `_ => None` → `Master` | 同上 |
| `SourceDest` の `#[default]` を `None` → `Master` | 同上 |
| `default_bus_line_ops` → `legacy(Master, &[])` | `tagged_event_with_unattached_bus_is_consumed_without_reaching_hardware` |
| Bus 位置なしの `map_or(Discard, …)` → `Hardware` | `unregistered_source_bus_is_silent_…` |
| `Link(_) => Discard` → `Hardware` | `unwired_link_source_is_silent_…` |
| slot 解放時の `store(None)` → `store(Master)` ×2（`engine_wrap.rs`） | `r1_replace_migrates_all_unit_destinations_then_resets_every_freed_unit` |

#### 採らなかった指摘と理由

| 指摘 | 裁定 |
|---|---|
| 変数参照の `send(v, -6)` で `dry-not-routed` が沈黙する（silent-failure-hunter Important） | **誤検知**。`extractDeclaredBusNames()` は `scanVarDeclarations` で `var v = mix.aux(...)` も拾う。実測で `dry-not-routed` が出る |
| `_insertBus` が一度確保すると解放されない（Minor） | 本 PR 以前からの性質。プール上限そのものは #663（撤廃）の土俵なので別 |
| LinkAudio で `output-missing` が Error → Warning（Minor） | **仕様どおり**。owner の収束条件 3 が「Warning + quick fix」と明示している |
| legacy `SetBusRouting` に暗黙 master が 1 箇所残る（Fable ③-2） | **本 PR では触らない**。#852 以降 DSL からは到達不能な legacy wire コマンドで、正しい翻訳は「拒否」か「出口なしの line」かの判断が要る。別 issue（下記）に切り出し、コマンドの撤去と一緒に閉じる |
| `kick.output(1)`（render のみ）でエディタと実行時が逆を向く | #598 周辺。別 |

`npm test` **2,383 passed / 74 skipped / 0 failed**・lint 緑・`cargo test --workspace`
**627 passed / 0 failed**・引用 948 / 0 failed。

Part of #883

---

### feat(dsl)!: drop the implicit master terminal — the score text is the whole truth (#883 bundle S) (Sep 12, 2026)

**Date**: 2026-09-12
**Status**: 実装・実機検証完了（レビュー前）
**版**: 🔴 **4.0.0 / `DSL_VERSION` 2.0**（破壊的変更）
**担当**: 実装 = Codex（`gpt-5.6-sol` / effort **xhigh**）/ 裁定と検証 = main

#883 の**振る舞いを変える**半分。束 0+C（PR #884）の上に載る。

#### 閉じた 4 実体（§0.1）— **1 箇所ではない**

| 実体 | 変更 |
|---|---|
| **A** `program()` の暗黙終端 | 合成を削除（`[rack]` の前置は残す） |
| **B** バス無し audio の直接描画 | `resolveDispatchChannel()` に skip。🔴 **`isNoteSequence()` の早期 return より後ろ**（前だと MIDI が無音・#282 の再発） |
| **C** daemon のバス既定ライン | `legacy(Master, [])` → **`[Rack]`（無音）** |
| **D** instrument の source routing | `SetSourceRouting.target` を**明示 3 値**（`none` / `master` / `bus`）へ。🔴 **一方通行の wire 変更** |

#### 🔴 横断規則を 6 箇所へ適用（main の審査で要求したもの）

> routing 状態が「書かれていない」「表現できない」「失われた」いずれかの時、その信号はどこにも加算されない。
> **master へ倒すことは最下層に暗黙 master を作り直すこと**である。

| 箇所 | 実装 |
|---|---|
| `SourceDestCell::encode` | `Bus(_) \| Link(_) => Self::NONE` ← **Fable の監査も見ていなかった箇所** |
| `SourceDestCell::decode` | `_ => SourceDest::None` |
| `SourceDest::default()` | `#[default] None` |
| `FeedDest` 変換 ×2 | `None => Discard` / `Link(_) => Discard` |
| slot 解放時 | `store(SourceDest::None)` ×2 |

**除外は master トラック自身の device 出口のみ**（owner 裁定で 1,2 固定＝定数なので規則の定義域外）。

#### 🔴 実機 gated が 4 件落ちた — **すべて譜面・harness の誤り**（実装は無変更）

| 失敗 | 原因 |
|---|---|
| 既存 `sum-bus insert across restart` | **移行漏れ** — 束 S で「出口を書かない sum は無音」になったので `sum("drum").output()` が要る |
| X1 / X4 / X5 | 🔴 **`LOOP()` は追加ではなく置換** — `LOOP(a)` の次の `LOOP(b)` が a を止める。根拠は `calculateLoopDiff()`（`process-statement.ts:679`）→ `stopSequences(toStop)`（`:777`） |

**main が先に潰した仮説**（unit で実測）: `ref883.output()` は skip されず（`{kind:'hardware'}`）、
4 イベントをスケジュールし、`loop()` も throw しない。**TS 層は正しい**。
崩れたのは「では実機の無音は実装のせい」という推論の方で、**`LOOP` の意味論**が抜けていた
（個別に `loop()` を呼ぶ unit では原理的に再現しない形）。

Codex は同じ誤用があった **X8 も落ちる前に先回りで修正**し、**静的回帰テストも追加**した
（`gated-assertion-hygiene.spec.ts:557`）。

⚠️ **ただしその検査は名指しの 4 ファイルしか守らない。** 3 本の新 fixture が揃って踏んだ性質なので、
**一般化する価値がある**（例: gated fixture 内に `LOOP(` が 2 回以上現れたら red）。別途扱う。

#### 実機 gated の実測（main が sandbox 外で）

```
Tests  45 passed | 1 skipped (46) | 0 failed

[#883 X1] explicit-reference + orphan RMS: 0.08701663328815765      ← 漏れれば 2 倍
[#883 X2] omitted=0.0870166332954772  explicit=0.08701663328808863
[#883 X3] sendRms=0.0436116233054862  plainRms=0.0870166332927243
          ratio=0.5011872058848396                                   ← 期待 10^(-6/20)=0.5012
[#883 X4] reference + unterminated-sum member RMS: 0.087016633295434
[#883 X5] withSilentInstrument=0.08701663329662541  refRms=0.08701663329662539
```

🔴 **X3 が #883 の実害そのもの**（`send(sum)` の dry が master へ二重に届く）**を実測で塞いだ証拠**。
🔴 **X5 は小数点以下 16 桁が一致** — 出口を書かない instrument は基準の音に **1 bit も足していない**。

#### ゴールの収束条件

1 ✅（X1/X4/X5）/ 2 ✅（X3）/ 3 ✅（X6）/ 4 ✅ / 5 は次（4.0.0 リリース）。

---

### feat: require explicit output routing across TS, wire, and the Rust runtime (#883) (Sep 12, 2026)

**Date**: 2026-09-12
**Status**: ✅ 束 S 実装

出口を書かない audio / instrument と、出口を持たない sum / aux を無音にした。routing の
未設定・表現不能・喪失は master へ倒さず discard する 1 規則に統一し、wire の source routing は
`none` / `master` / `bus` の明示 3 値になった。MIDI は audio の skip より先に hardware dispatch を
確定するため、#282 の挙動を維持する。

編集時には出口無しを Warning (`output-missing`)、aux send だけを Information
(`dry-not-routed`) として `.play()` に示し、どちらにも `.output()` の quick fix を提供する。
実機 gated E2E X1 / X3 / X4 / X5 / X6 / X8 は追加のみ行い、sandbox 外で実行する。

この互換性のない変更に合わせ、拡張を **4.0.0**、`DSL_VERSION` を **2.0** にした。
`ENGINE_VERSION` は独立軸なので **2.0.0** のまま。

### fix: make send() require a destination in both implementations (#883 round 2) (Sep 12, 2026)

**Date**: 2026-09-12
**Status**: ✅ ラウンド 2 収束（PR #884）

#### 🔴 縮小レビューが **fix 起因の Critical** を捕まえた

ラウンド 1 で置いたポリシーを、main が**片翼にしか適用していなかった**。

| | ガード |
|---|---|
| `Sequence.send()` | ✅ あり |
| `MixerBusHandle.send()` | ❌ **無い** |

レビュアーが実際に走らせて wire の中身まで示した:

```
mix.sum('drum').send(db: -6)
  → processArguments が [undefined, {db:-6}] に整形（ラウンド 1 の修正）
  → MixerBusHandle.send(undefined, ...) → resolveDest(undefined) → {kind:'master'}
  → setBusLine に output(master, thru:true, -6dB) が**追加で 1 本**
  → 既存の直結と合わせて **master へ二重に鳴る**
```

🔴 **#883 が消そうとしている「dry が master へ漏れる」の派生形を、修正が自分で作っていた。**

#### 直し方 — 契約を 1 関数へ

```ts
// audio-line.ts — この 1 関数が両方の send() の契約
export function assertSendDestination(value: unknown, call: string): void
```

`send()` の宛先は **`output()` と違い必須**（どこにも送らない send は無い）。両方の `send()` が
これを呼ぶので、**片翼だけに書けるコードでなくなった**。

あわせて `resolveDest` / `send` のエラー文言が常に「null」と決め打ちしていたのを、
**実際に来た型**を出すよう直した（数値や真偽値を渡した人に嘘の情報を与えていた）。

#### 変異検証（main が実走）

| 変異 | 結果 |
|---|---|
| `MixerBusHandle` のガードを削除 | **red**（1 件） |
| 文言を "null" 決め打ちに戻す | **red**（3 件） |
| restore | **green**（4 件） |

#### 波及

Codex がラウンド 1 で書いたテスト 2 箇所が**旧文言**を期待していたので整合させ、
「なぜ `send()` は `output()` と文言が違うのか」と**この Critical への回帰検査であること**を
コメントに残した。

#### 🔴 実機 gated が 1 回 flake した（規律どおり再実行して確定させた）

1 回目: `#611 E2E-3` が **`ENGINE_LOCK_CONTENTION`** で落ちた。

```
[warning] ENGINE_LOCK_CONTENTION: engine lock contention (1 total);
          a block was silently zero-filled — this self-heals next block
```

これは **`severity=warning` として設計された事象**（`rust/crates/orbit-audio-daemon/tests/protocol.rs:1204`）
だが、`mem:stderr-is-classified-as-error`（engine の warn は全部 ERROR 行）により
`expectNoNewErrors` が ERROR として数える。

**`mem:implementation-right-oracle-wrong`（赤を実装のせいにする前に同じテストを走らせる）に従い、
断定せず再実行** — load 5.62 → 2.76 で**緑**。孤児 daemon 0 / 残存 dev host 0 も確認済み。

🔴 **残る論点（この束とは独立）**: `expectNoNewErrors` は「新規 ERROR が 0」を要求するが、
CLAUDE.md の規律は「ERROR 件数は固定 500 行窓なので**厳密等価にしない**（`<=`）」。
`ENGINE_LOCK_CONTENTION` は負荷次第で正当に発生するので、**分類器が warning を ERROR へ畳んでいる**
ことを別途扱う余地がある。

#### 検証（すべて main が sandbox 外で実測）

```
npm test    2364 passed | 68 skipped | 0 failed
lint 緑 / docs:check 948 引用 0 failed
実機 gated  39 passed | 1 skipped | 0 failed
[#883 X2] omittedRms=0.08701663329564219  explicitRms=0.08701663329564278
```

---

### fix: close the review round-1 findings for #883 bundle C (Sep 11, 2026)

**Date**: 2026-09-11
**Status**: ✅ ラウンド 1 収束（PR #884）
**担当**: レビュー = `/simplify` 4 観点 + `/code:pr-review-team` 4 名 + **Fable 監査を並行** /
fix = Codex（コード）+ main（docs・spec）/ 裁定と検証 = main

#### 🔴 main が偽陽性 2 件を裁定した — どちらも**層をまたいだ誤判定**

| レビュアー | 主張 | 裁定の根拠 |
|---|---|---|
| pr-test-analyzer | 「instrument は `ensureInsertBusForInstrument()` が `instrument()` 宣言時に先にバスを確保するので影響なし」 | ❌ 呼び出し元は **`gain()`（`sequence.ts:372→396`）と `pan()`（`:425→449`）のみ**。`instrument()` からは **0 件** |
| silent-failure-hunter | **Critical**「再宣言で daemon の古いルーティングが黙って生き残る」 | ❌ Rust 側（`engine_wrap.rs:7656` `new_dest.store(old_dest.load())`）は**正しい**が、TS 側は `process-initialization.ts:91`「**Reuse existing sequence for REPL persistence**」で `_insertBus` を**保持**する |

`mem:reviewers-judge-one-layer-only` の再現。TS・インタプリタ・Rust をまたぐ契約は main が両端を読むしかない。

#### 実害 1 件（Fable だけが見つけた・main が再現確認）

**`kick.output(db: -6)` がオプションを宛先として食っていた。**

```
processArguments('output', [named_arg db:-6])  →  [{"db":-6}]   ← 引数 1 個・オブジェクト
  → Sequence.output({db:-6}) → typeof dest === 'object' → OutputDest として扱う
  → db は消える / バスを 1 本消費 / 宛先の無い wire op を daemon に送る
```

🔴 **束 0 で `destination` を省略可にした spec 改訂（main の作業）が、この形を正当にした帰結。**
Sonnet チーム 4 名は誰も見ていない — **差分に「無い」もの**（誰も書かなかった形）だったため。

#### 横断ポリシーを 1 つ置いてから全箇所へ適用（指摘単位のパッチにしない）

> `output()` / `send()` の引数は「宛先（省略可）」と「オプション」の 2 種類しかない。
> `OutputDest` は必ず `kind` を持ち、オプションバッグは持たない。**`undefined` だけが省略**であり、
> `null` は不正入力として loud に拒否する。

`isOutputDest()` を `audio-line.ts` に置き、**パーサ層（`evaluate-method.ts`）と呼び出し層
（`sequence.ts` / `mixer-manager.ts`）が同じ判別子を使う**。2 層で防ぐが**判別のルールは 1 つ**。

#### 直した内容

| # | 出どころ | 内容 |
|---|---|---|
| F-A | Fable | `output(db:)` / `send(db:)` の宛先スロットにオプションが入る |
| F-null | silent-failure-hunter | `output(null)` が黙って master に（**main が `/simplify` で入れた退行**） |
| F-B | code-reviewer | instrument `.output()` 単独が未検証 |
| F-C | pr-test-analyzer | `needsBus()` の thru / db≠0 分岐が未検証 |
| F-D | pr-test-analyzer + Fable | `mix.output(` で補完が誤爆 |
| F-E | comment-analyzer | **未実装の診断を現在形で断定**（main の spec 誤り） |
| F-G | Fable | 🔴 **MX.1 注記が実装と逆**（「`output()` が bus を確保した瞬間」）ほか設計 §10 の 5 行が未着地 |

🔴 **main 自身の誤りが 3 件**（F-null・F-E・F-G）。うち 2 件はこの PR で main が書いたもの。

#### Codex の変異検証（**実出力を貼らせた**・5 件すべて red → revert で green）

`needsBus()` の単純化 / instrument で無条件確保 / `unshift`→`push` / ノード除外の削除 /
`null` を通す — **すべて red**。pr-test-analyzer が予告した「述語を単純化する変異が全件緑で通る」穴が塞がった。

#### 引用チェックで踏んだこと

`--fix` が 8 件を直せなかった — **行ずれではなく引用元のコードが変わった**ため。実コードから
再抽出したところ、今度は**引用がコメントの途中から始まった**。
🔴 **緑は「行が合った」証明でしかない**（`mem:citation-fix-can-land-on-the-wrong-function`）ので、
範囲を `/**` の境界へ合わせ直した。

#### 検証（すべて main が sandbox 外で実測）

```
npm test    160 files / 2360 passed | 68 skipped (2428) / 0 failed   ← +8 は追加テスト
lint        緑
docs:check  948 引用 / 0 failed
実機 gated  39 passed | 1 skipped (40) / 0 failed
```

🔴 **X2 の再実測**（実現の省略が bit 同一クラスであることの裏づけ）:

```
[#883 X2] omittedRms=0.08701663328809114  explicitRms=0.08701663328672658
```

`tests/e2e/output-line-expectations.ts` の式は**1 つも変わっていない**（束 C の検算）。

---

### refactor: fold the /simplify findings for #883 bundle C (Sep 11, 2026)

**Date**: 2026-09-11
**Status**: ✅ 完了（PR #884）

`/simplify` の 4 観点（reuse / simplification / efficiency / altitude）を並行起動。
**独立した 3 観点が同じ 2 機構に収束**したので、指摘単位ではなく**機構単位**で直した
（CLAUDE.md「指摘単位のローカルパッチは禁止・振動の主因」）。

| 機構 | 収束した観点 | 修正 |
|---|---|---|
| **A** 述語の所在 | reuse / efficiency / altitude の 3 つ | `lineNeedsBus` を `audio-line.ts` の **export 純関数**へ + `AudioLine.needsBus()`（`elements` を直読・コピーしない） |
| **B** 補完の重複 | reuse / efficiency / altitude の 3 つ | `scanVarDeclarations()` へ一本化 + 正規表現をモジュール定数へ |
| **C** 分岐の畳み込み | simplification のみ | `output(dest ?? {kind:'master'})` / `resolveDest` が `undefined` を吸収 |

#### A の根拠（3 観点が別々の理由で同じ結論に達した）

- **reuse**: 設計 §2.3 が「`audio-line.ts` に純関数として置く」と**コード例まで示していた**
- **efficiency**: `snapshot()` は `return [...this.elements]` で**配列を丸ごとコピー**する。
  述語は走査するだけなのでコピーは使い捨て。`elements` は private なので、
  **`audio-line.ts` に置くことが非コピーの唯一の経路**
- **altitude**: 束 S の instrument 経路（設計 §2.2.1）が**同じ述語**を使う。`Sequence` の
  private ローカル式のままだと、束 S は private へ手を伸ばすか書き写すかになり**ドリフトする**

#### B の根拠

`var NAME = <ident>.<member>` を拾うループが 2 箇所に写されており、`\b` の有無や
`output\s*\(` の扱いが将来ずれて**片方だけ直る**形だった。加えて 1 回の補完で同じ文書を
**4 回走査**していた（`matchAll`×2 + `split`×2）。`(` がトリガー文字に足されて発火頻度も上がる経路。

#### 採らなかった指摘

補完の `output-string` / `output-node` を 1 つの kind に畳む案は**却下**。
正規表現・語彙状態（`string` vs `code`）・候補の中身（バス"名" vs 変数"識別子"）・
`CompletionItemKind`（`Value` vs `Variable`）がすべて異なり、畳むと `mode` 判別フィールドが
要るだけで**複雑さは減らず名前が変わるだけ**（simplification agent が実読して同じ結論）。

#### 検証

```
Test Files  160 passed | 4 skipped (164)      Tests  2352 passed | 68 skipped (2420)
```

lint 緑 / 🔴 `git diff main...HEAD --exit-code -- tests/e2e/output-line-expectations.ts` **無出力**
（束 C の検算が simplify 後も保たれている）。

---

### feat(dsl): make output() default to master and migrate every score (#883 bundle C) (Sep 11, 2026)

**Date**: 2026-09-11
**Status**: 実装完了・main 検証中（実機 gated 未実施）
**担当**: 実装 = Codex（`gpt-5.6-sol` / effort high・2 ラウンド）/ 検証 = main

**束 C は「振る舞いを変えない」束。** 暗黙 master の廃止は束 S。

#### 中身

| 対象 | 変更 |
|---|---|
| `sequence.ts` / `mixer-manager.ts` | `output()` の宛先を省略可に（既定 `{kind:'master'}`）。**暗黙ではなく既定引数**なので要素は譜面に現れる |
| 同 | 🔴 **実現の省略**（設計 §2.3）: ラインが「素の master 出口」だけの間は**バスを確保しない**。`.output()` 必須化がプール 8 本を食い潰すのを防ぐ（出荷 example の 4 本が 8 を超える） |
| 拡張の補完 | `.output(` の引数位置で `master` / 宣言済み sum・aux / 物理アウトノードを候補に |
| fixture 11 本 + 新規 2 本 | §7.1 の表どおり `.output()` を明示。**バス自身の出口も** |
| examples 12 本 / `docs/user` / `sites/user` | 同上 |

#### 🔴 main の審査で 1 件差し戻した — 完了条件 D3（E2E X2）の欠落

Codex の 1 回目は inline 譜面の移行までで、**X2 を作っていなかった**。

進捗ログが `kick.master` のアサーション変更を「**stale な structural assertion**」と説明していたが、
実際には**振る舞いの変更**だった — 裸形 `.master` は今まで `seq-bus-0` を確保していたのに、
実現の省略で確保しなくなった（テストが実装に合わせて書き換えられた形）。

変更自体は設計どおりだが、**検証が無かった**:

- 設計 §2.3 はこれを**確度「中」**とし、反証条件を「X2 で RMS が `noBus` golden から ±0.12 を超えて動く」としている
- 既存 fixture は `output("master")` も裸形 `.master` も **1 つも使っていない** → 「既存 golden が動かない」が**この変更を素通りする**
- ラチェット（`dsl-e2e-coverage`）も効かない（`output` は既に covered なので新語彙として検出されない）

→ 譜面 2 本（`output_default_master_omitted.orbs` / `_explicit.orbs`）と X2 を追加させた。

#### 実現の省略が安全である構造的理由（main の確認）

省略が効くのは「ライン全体が素の master 出口」の場合のみ。そのとき:

| ケース | 変更前 | 変更後 |
|---|---|---|
| 出口なし → `dry.output()` | 暗黙 master → **直接経路** | 省略 → **直接経路** |
| `kick.gain(-6).output(drms)` | バス経路 | **バス経路**（述語が true） |

**経路が変わるケースが実質無い。** 唯一変わる明示 `output("master")` は使用譜面 0 本（grep 実測）。

#### 検証（main・sandbox 外）

🔴 **Codex は緑を装わなかった** —「`npm test` did not exit successfully, I am not claiming all three
acceptance checks passed」と報告。sandbox 内の失敗 4 ファイルはすべて loopback を立てるもので
`listen EPERM`。**sandbox 外で回し直したら消えた**:

```
Test Files  160 passed | 4 skipped (164)
     Tests  2352 passed | 68 skipped (2420)
  Duration  23.54s        （sandbox 内は 400s — MACOS_DEV_SETUP の「遅さの 91% はスキャン」と同型）
```

`npm run lint` 緑 / `npm run docs:check` 948 引用・0 failed /
`git diff --exit-code -- tests/e2e/output-line-expectations.ts` 無出力（**束 C の検算**）。

#### 残件（レビューへ送る）

- `dsl-completion-context.ts` の新規 2 関数が `lexicalStateAt(line, ...)` を**行単位**で呼んでおり、
  同じ関数内の既存パスは `lexicalStateAt(sourceText, ...)` を**全文**で呼んでいる。
  複数行コメント内の `var x = mix.sum` を候補に拾いうる（補完候補のみなので実害は軽微）
- 実現の省略の述語が `sequence.ts` に inline。設計 §2.3 は `audio-line.ts` の純関数を指定しており、
  束 S で同じ述語が要る（main のブリーフが `audio-line.ts` を範囲外にしたため。Codex の落ち度ではない）

#### 🔴 実機 gated が退行を 1 件捕まえた（`ph654`）— 束 C が**露見させた**既存の潜在欠陥

1 回目の gated: **1 failed / 38 passed**。

```
ERROR: Sequence 'ph654': MIDI degrees need a root. Declare global.key("C") (or set seq.root()).
```

ユニット 2352 件・lint・docs:check が全部緑で、**golden も 1 つも動いていない**状態で、実機だけが落ちた。

**原因**: `ph654` の譜面は `play(1, 0, 3, 0)` で**度数**を使うのに `global.key("C")` を持っていない。
他の instrument 譜面は **10 本すべてが持っている**（`:2078 :2117 :2160 :2216 :2272 :2316 :2367 :2865 :2967 :3336`）。
gated suite は **1 つの VS Code / エンジンを共有**するので、`ph654` は**先行譜面が設定した key を
継承して偶然通っていた**。束 C が先行譜面に `.output()` を足したことでその漏れが起きなくなり露見した。

🔴 **これは #883 の grand truth そのもの** — 譜面が他ファイルの残留状態に依存していた。
修正は「譜面に自分の前提を書かせる」（`global.key("C")` を追加）であって、テストを通すための
書き換えではない。**なぜ今まで通っていたか**をコメントに残した。

#### 実機 gated（2 回目・main が sandbox 外で）

```
Test Files  1 passed (1)
     Tests  39 passed | 1 skipped (40)
  Duration  685.13s
```

skip 1 件は E2E-4/E2E-5（>=4ch デバイス不在・既知）。

🔴 **X2 が実測で通った** — 設計が確度「中」としていた「実現の省略は bit 同一クラス」が裏づけられた:

```
[#883 X2] default-master RMS: {"omittedRms":0.08701663329273443,
                               "explicitRms":0.08701663329503133}
```

| 判定 | 実測 | 閾値 |
|---|---|---|
| `output()` ≡ `output("master")` | 相対差 **2.6e-11**（11 桁一致） | ≤ 0.02 |
| `output()` ≈ `noBus` golden（0.0846173） | 約 **2.8%** | ≤ 12% |

#### 関連

#883 / 設計 §2.3 §4 §5.3 §7.1 §7.2 / 完了条件 D3・D9・D10

---

### docs(spec): land the #883 rulings in the normative specs (bundle 0) (Sep 11, 2026)

**Date**: 2026-09-11
**Status**: ✅ 束 0 完了（spec 先行・運用規則 6）。実装（束 C / S）は未着手

#883 の裁定 6 件を正本へ落とした。**実装より先に spec を直す**（運用規則 6）。

| 文書 | 改訂 |
|---|---|
| `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` MX.2 | 暗黙終端の段落を「**出口は書かれたものがすべて。書かないラインは無音**」へ置換。旧規則は撤回理由（`send(aux)` と `send(sum)` で正しい振る舞いが逆）付きで引用ブロックに残した。`destination` を省略可（既定 `"master"`）に |
| `docs/specs-v2/SIGNAL_CHAIN_DSL_SPEC_v1.md` SC.2 規範 (4) | 🔴 **裁定 6 と逆を向いていた**（「マスターもレシーバである」「master も宛先を持てる 1 レシーバ」）→「**master トラックは `global` が所有する**。`master.<...>` のレシーバ表面は設けない。device 出口 1,2 は定数なので『未設定は無音』の**適用対象外**」へ |
| 同 SC.2 規範 (6) | 「暗黙 master(1,2) を持つ」を **(i) ノードの存在**だけに限定。(ii) 自動ルーティングの廃止を明記。決定 #75 は `.output()` を書いても import / マニフェスト不要なので引き続き満たされる |
| `docs/design/611-output-line-design.md` §2.1 | 撤回の追記。**却下判断が aux しか見ていなかった**こと、§9 の互換要件も制約でなくなったこと |
| `docs/specs-v2/DESIGN_DISCUSSION_RECORD.md` | 決定 **#78**（暗黙終端の廃止・P2 却下理由 = 不連続）と **#79**（master は global が所有）を追加。決定 #75 に「#78 で意味を (i) に限定」の注記 |
| `docs/planning/DEVELOPMENT_MAP.md` §3 | 🔴 **凍結線の前提が崩れた**ことを事実が変わった瞬間に記録（§5.1b）。凍結線は 4.0.0 へ |

#### ゲート

- `npm run docs:check`: **948 引用 / 0 failed**。spec の行ずれで 4 件落ちたので `--fix` を実行し、
  🔴 **着地先の内容を目視で照合**（`global.sum("drum") // group bus 宣言（冪等）` /
  `global.aux("rev") // return bus 宣言` が期待スニペットと一致）。
  memory `citation-fix-can-land-on-the-wrong-function`「緑は『行が合った』証明」に従う
- `tests/docs/`: 5 passed（`planning-issue-state` のラチェット含む）

#### 関連

#883 / #611 / 決定 #75 #78 #79

---

### design: explicit output routing — drop the implicit master terminal (#883) (Sep 11, 2026)

**Date**: 2026-09-11
**Status**: 設計完了・裁定 6 件すべて確定（実装未着手）
**成果物**: `docs/design/883-explicit-output-routing-design.md`（493 行）

#### 発端

LinkAudio の標準プラグイン化を検討する中で、`thru:` の意味論を追ったところ
**暗黙 master 終端の欠陥**が出た。owner 裁定で LinkAudio より先にこちらを片付けることにした。

🔴 **実測した欠陥**: `send()` は sum バスも受け取る（`sequence.ts:661-665`）。
`send` は `output(dest, thru: true)` の糖衣で**終端ではない**ので暗黙 master が付く。結果、

```js
global.sum("drums")
kick.send(drums, -6)
snare.send(drums, -6)
```

で master が受け取るのは **kick の dry + snare の dry + (kick+snare の合算)** =
**各素材が 2 回**。`drums` に挿したグルーコンプを **dry が迂回する**。

#### owner 裁定（grand truth）

> 音楽記述言語としての OrbitScore DSL は「**テキストが完全な真実**」であるべき

暗黙終端を**完全に廃止**する（P3）。「出口を 1 つも書かなければ暗黙」案（P2）も却下
— `kick.play()` は鳴るのに `.send(verb,-12)` を 1 つ足した瞬間に master への dry が消える
**不連続**が残るため。譜面の下位互換は担保しない（owner「そっちを直せばいい」）。

#### 設計が覆した #883 の前提

| # | 訂正 |
|---|---|
| 1 | 暗黙 master の実体は **1 箇所ではなく 4 箇所**（`program()` の合成 / バス無し audio の直接描画 / daemon のバス既定ライン / instrument の `target:null`）。A だけ消しても `kick.play()` は鳴り続ける |
| 2 | `.output()` 必須化は **9 本目で throw**（`SEQUENCE_EFFECT_BUS_POOL_SIZE = 8`）。出荷 example の **4 本**が 8 を超える（17 / 16 / 13 / 12） |
| 3 | `program()` は `elements` に完全には畳まない（`[rack]` の位置マーカーは routing ではない） |

#### main の審査で出た指摘（4 件・すべて反映）

1. 🔴 **固定上限は「避けるもの」ではなく「撤廃が裁定済みのもの」**（owner「実害ではない。正しく治すだけ」）。
   Q-598-5「マシンの上限まで使える」/ doc 662 §10「上限を決めない対象に**トラック / インスト**を含む」/ #663。
   → instrument の常時バス確保を撤回し、`SetSourceRouting.target` を明示 3 値へ（固定上限への依存が 1 行も増えない形）
2. skip は `resolveDispatchChannel()` の **`isNoteSequence()` 早期 return より後ろ**に置く。
   前に置くと **MIDI が無音**（同じ箇所のコメントが #282 で一度踏んだと記録）
3. `send(aux)` と `send(sum)` で**正しい振る舞いが逆**（aux は dry が残るのが正しい / sum は誤り）。
   611 §2.1 が P2 を却下した時に見落としていた場合分け
4. 🔴 **失敗時の向きが「鳴る」になっている** — 横断規則を 1 つ置いた:
   「routing 状態が未設定・表現不能・失われた時、その信号はどこにも加算されない」。
   適用 6 箇所（`encode` / `decode` / daemon 既定ライン / `FeedDest` 変換 2 / スロット解放）。
   副産物として **F2（TS の push 順序が狂うと鳴る）が消滅**した — 最悪の状態が無音になったため

#### 裁定 6 件（owner 2026-09-11）

`[rack]` 前置は残す / `output-missing` = Warning / `dry-not-routed` = Information /
`SetSourceRouting.target` を明示 3 値へ（一方通行）/ 実現の省略を採る /
🔴 **master トラックは `global` が所有する**。

最後の 1 件は owner 逐語「マスタートラックは global が持っている、でいいのでは？」。
`master.output(...)` / `master.effect(...)` という表面は**作らない**。マスタリングは
`global.effect(["Comp", Gain(db: -3), "Limiter"])` で今日すでに書ける（`global.ts:445`・PH.2）。
違う出力を使いたければ aux を作ってそちらへ集める（owner 同日）。

🔴 **この裁定は `SIGNAL_CHAIN_DSL_SPEC_v1.md` SC.2 規範 (4) と逆を向いている**
（今日は「マスターもレシーバである」と書いてある）。**束 0 で書き換える**。

#### 版

**4.0.0 / `DSL_VERSION` 2.0**。3.0.0 を major にした理由（`send()` の dB 化で譜面の意味が変わる）と
同じクラス — `kick.play()` が「鳴る」→「鳴らない」に変わる。

#### 束

**0**（spec 先行・main 直行）→ **C**（振る舞いを変えない）→ **S**（振る舞いを変える）。
C を先に置くのは「**golden が 1 つも動かない**」ことでしか C を検算できないため。

#### 関連

#883 / #663（プール上限の撤廃）/ #611（出力ライン設計・§2.1 に撤回追記）/ #282（MIDI の skip 誤爆）

---

### docs: follow the dev site to the .vsix dependency bundling fix (PR #874) (Sep 11, 2026)

マージ済み PR [#874](https://github.com/signalcompose/orbitscore/pull/874)（merge commit `a2ac724`）へのドキュメント追従。**コード・テストは一切変更していない。**

`sites/dev/editor/vscode-architecture.md` と `sites/dev/en/editor/vscode-architecture.md`（日英バイリンガル）に節を 1 つ追加した。置き場所は `activate()` の章の末尾で、理由は**この不具合が `activate()` の中ではなくモジュール読み込みで起きていた**から。同章は activate の中身だけを説明していて、「そもそも activate に到達しない」経路が抜けていた。

書いた内容:

- `packages/vscode-extension/src/mcp-server.ts:52-58` のトップレベル `require` が、MCP の port 設定や開いているファイルに関係なく activation を落とす構造であること
- 原因の npm workspaces hoisting と、`install-engine-deps.sh` / `install-extension-deps.sh` が共有する `scripts/install-bundle-deps.sh` の「ワークスペース root の無い一時ディレクトリで入れる」手口
- 同梱先が `dist/node_modules` である 2 つの理由と、`vsce package --no-dependencies`（`.github/workflows/release.yml:118`）
- post-package ゲートが `check-vsix-bundled-deps.mjs` に替わり、**宣言を数えるのではなく出荷物の実ファイルから解決する**ようになったこと。保証が depth 1 と depth > 1 で一様でないことも script の明示どおりに書いた

あわせて drift 表に 1 行、Sources に 7 行、frontmatter の `verified-against` を `a2ac724` へ。

🔴 **未追従として PR 本文に書き出したもの（この PR では直していない）**: cold install 経路は gated E2E から構造的に踏めない（`tests/e2e/orbitstudio-mcp-gated.spec.ts:728` が `--extensionDevelopmentPath` で起動するため、同梱が空でも緑になる）。#874 の cold install 検証は手動で、資産として積まれていない。

### release: tag v3.0.0 — the extension line is frozen as stable (#827) (Sep 11, 2026)

owner 裁定 2026-09-10（#827・正本 `docs/planning/NATIVE_MIGRATION_2026-09.md` §12）の凍結線に到達した。
以降のネイティブ OrbitStudio.app は新ライン。

#### 裁定（2026-09-11）— §12.7 が未決として残していた 2 件

| 未決だったもの | 裁定 |
|---|---|
| バージョン | **3.0.0 / DSL 1.2**（`send()` の dB 化で既存譜面の意味が変わるので semver では major） |
| タグ名前空間 | **`v3.0.0`**。`ext-v*` / `app-v*` の分離は新ラインで（§12.3）。`release.yml` は `v*` トリガーのままで変更不要 |

残り 3 件は裁定待ちではなく解消済み: SC 削除 = #840 / gated ハーネス = #831 / README = #842。
Marketplace publish は「行わない」（owner 2026-09-10）で、`PUBLISH_MARKETPLACE` 未設定のため
publish ステップは skip される（`gh variable list` で実測）。

#### タグ直前の実測（main `61f947d7`）

| 確認 | 結果 |
|---|---|
| `npm test` | **2,347 passed / 67 skipped / 0 failed** |
| `npm run lint` | 緑 |
| `check-citations.mjs`（素で実行） | **944 / 0 failed** |
| `.vsix` の依存ゲート | engine 5/5・extension 2 宣言 + **3 specifier 解決** |
| 出荷物の `scsynth` / `supercollider` 参照 | **0** |
| タグ照合ガード（#853） | `v3.0.0` vs `3.0.0` → `{ok: true}` |
| マージ前ゲート（`orbit-effect-rack-child`） | `--ignored` **3 passed** / 通常 **16 passed** |

#### 🔴 凍結は 1 日延びた — cold install がブロッカーを出した

タグを打つ直前に cold install を回したところ、**`.vsix` が activate すらできなかった**（#873）。

```
Error: Cannot find module '@modelcontextprotocol/sdk/server/mcp.js'
```

**この時点でビルド・ユニット 2,338 件・lint・引用・`release.yml` の post-package ゲート全項目が
緑だった。** npm workspaces が拡張の実行時依存をルートへ hoist し、`vsce package` が同梱する
`extension/node_modules` には `@types` と `undici-types` しか入っていなかった。engine 側には
同型の事故が 2 回あり対策もあったのに（WORK_LOG 6.119 / 6.422）、**拡張自身の依存だけ無防備**だった。
MCP サーバ（#388）が入った時点から壊れていた可能性が高い。

**dev host は構造的にここを見ない**:

| 経路 | dev host（`--extensionDevelopmentPath`） | cold install |
|---|---|---|
| daemon の解決 | `monorepo-release`（リポジトリの `rust/target/release`） | **`extension-bundle`** |
| 拡張の実行時依存 | ルートに hoist されたものが walk-up で見つかる | **`.vsix` に入っているものだけ** |

#874 で直し、**ゲートを「宣言を数える」から「出荷物の中で実際に解決する」へ変えた**。
同一の壊れたツリー（sdk の推移依存 `express` を削除）に対して旧ゲートは exit 0、新ゲートは exit 1。

#### 今日 main に入ったもの

| PR | 内容 |
|---|---|
| #868 | ルーティン docs 追従 **9 本**を 1 本に統合（#837 / #844 / #847 / #856 / #858 / #862 / #864 / #865 / #866） |
| #870 | `loop-quantize` の 1ms レース（CI を間欠的に赤くしていた真因） |
| #871 | 拡張 3.0.0 / DSL 1.2 + リリース直前の README 2 件 |
| **#874** | **`.vsix` が activate できなかったブロッカー** + それを守るゲートとテスト |
| #876 / #872 | 上記の docs 追従 |

#### 新ラインへ送ったもの

| # | 内容 |
|---|---|
| #875 | esbuild でバンドルし、copy-a-node_modules の機構ごと退役させる |
| #877 | cold install を再実行できる gated spec にする（#138 を #656 から切り離す） |
| #878 | `extension.ts:2000` の `spawn('node', …)` が PATH 依存で `process.execPath` のフォールバックが無い |
| #849 | ネイティブ macOS OrbitStudio の設計 |


#### 収束条件の最終確認 — **公開された資産**で cold install

ローカルビルドではなく **GitHub Release からダウンロードした `.vsix`**（利用者が受け取るもの）で検証した。

| 検証 | 結果 |
|---|---|
| 資産の版 vs タグ | `3.0.0` = `v3.0.0` |
| 依存ゲート（`check-vsix-bundled-deps.mjs`） | engine 5/5・extension 2 宣言 + **3 specifier 解決** |
| `scsynth` / `supercollider` の参照 | **0** |
| activate | `Cannot find module` **0 件** |
| MCP サーバ | **4 秒**で listen |
| engine ログ | `ERROR:` **0 行** |
| **音** | capture **34.09 s**・非ゼロ **24.2%**・**RMS 0.038183**・peak 1.133490 |

🔴 **起動は Finder 相当の最小 PATH で行った**
（`/usr/local/bin:/System/Cryptexes/App/usr/bin:/usr/bin:/bin:/usr/sbin:/sbin`）。
`extension.ts:2000` の `spawn('node', …)` が PATH 依存なので（#878）、シェルから起動すると
この条件を検証したことにならない。

**`--extensionDevelopmentPath` は使っていない。** dev host はリポジトリの
`rust/target/release` から daemon を引き、依存もルートの hoist 先から walk-up で見つけるため、
**`extension-bundle` 解決と同梱依存のどちらも通らない**。#873 はまさにそこに隠れていた。

#### 🔴 署名・公証の実測（#881 を起票）

同梱ネイティブバイナリ 8 個は **ad-hoc 署名のみ**（`linker-signed` / `TeamIdentifier=not set`）。

| 確認 | 結果 |
|---|---|
| `spctl -a -vv -t execute` | **rejected** |
| quarantine を付けて実行 | **exit 137（SIGKILL）**+ 「Apple は…検証できませんでした」ダイアログ |
| VS Code の `--install-extension` 後の `xattr` | **0 件** → 実行 exit 0 |
| `ditto -x -k` / `/usr/bin/unzip` で展開 | **quarantine が伝播する** |

**動いているのは、VS Code の `.vsix` 展開が quarantine を付けないから**であって、署名が
通っているからではない。他社実装への暗黙の依存で、#878（`spawn('node')` が VS Code の
シェル環境解決に救われている）と同じ形。ネイティブ `.app` のラインでは逃げ道が無く必須になる。


#### インストール導線の実物合わせ

リリース後、**利用者が実際に辿る経路**を上から見て 2 件直した。

**1. GitHub Release の本文が空だった。** `release.yml` は `gh release create --generate-notes` を
使うので、出るのは **v2.0.0 以降の全 PR 一覧（279 行）**だけだった。**利用者が最初に見る場所**が
それでは使えないので、本文を書き直した:

- 動作環境の表（arm64 専用・Intel 非対応・VS Code 1.99.0 以上）
- インストール 3 方式（ダブルクリック / コマンドパレット / CLI）+ 更新手順
- 最初の音を出すまでの 4 ステップ + Walkthrough への導線
- 3 軸のバージョン（拡張 3.0.0 / `DSL_VERSION` 1.2 / `ENGINE_VERSION` 2.0.0）が同期しないこと
- **既知の制限**（LinkAudio は出荷ビルドで無効 / `compressor()` 等は no-op / `.time()` `.fixpitch()` は未実装）
- 変更履歴は `<details>` に畳んだ

**2. ドキュメントのファイル名が実物と違った。** 資産名は `orbitscore-darwin-arm64-3.0.0.vsix` だが、
README 2 本は `orbitscore-<version>.vsix`、ユーザーサイトは `orbitscore-*.vsix` と書いていた。
**ターゲット接尾辞が抜けている**のが原因なので、版番号は固定せず `darwin-arm64` だけ足した
（`orbitscore-darwin-arm64-<version>.vsix`）。版を書き込むと次のリリースで腐る。

併せてユーザーサイトに [releases/latest](https://github.com/signalcompose/orbitscore/releases/latest)
への導線と「Assets の中にある」の一言を足した。

#### 実測で確かめたこと（記述が現行実装と合っているか）

- 出荷 README の「Audio Engine Settings で出力デバイスを選ぶ」は**正しい**。
  `orbit-audio-daemon --list-audio-devices` は実環境で 2 件返す（`MacBook Proのスピーカー` /
  `Pro Tools Aggregate I/O`）。🔴 **サンドボックス内では `{"devices":[]}` を返す**ので、
  ここを検証する時はサンドボックスを外すこと
- MCP の `list_audio_devices` が「not supported with the Rust engine」を返すのは**別の話**で、
  こちらは意図的な未実装（`extension.ts:2950-2956`・doc 662 §6 / #660）。UI の経路とは違う

検証: 引用 944 / 0 failed・`npm test` 2,347 passed / 0 failed・lint 緑・
`docs:build -w @orbitscore/user-site` 緑。

### docs: follow the 3.0.0 / DSL 1.2 bump into the docs the bump missed (PR #871 追従) (Sep 11, 2026)

ルーティン docs 追従。追従元は PR [#871](https://github.com/signalcompose/orbitscore/pull/871)
（マージコミット `56c34c3`・head `d5decc2`）。**実装とテストは触っていない**（docs と dev サイトのみ）。

#871 は正本 3 箇所（`packages/vscode-extension/package.json` = 3.0.0 /
`packages/engine/src/version.ts` の `DSL_VERSION` = 1.2 / `ENGINE_VERSION` は据え置き）を動かし、
`CLAUDE.md`・root `README.md`・`docs/core/INSTRUCTION_ORBITSCORE_DSL.md`・dev サイトの
`version.ts` 引用 4 箇所を追従させた。**引用ブロックは更新されたが、その引用を説明している
散文が 1.1 / 2.1.0 のまま残っていた**ページがある。

| 直した箇所 | 何が食い違っていたか |
|---|---|
| `docs/core/INDEX.md:5` | 表紙が `DSL_VERSION 1.1` / 拡張 `2.1.0` を名乗ったまま |
| `README.md:55` | `Post-2.0 (shipped on main, extension 2.1.0)` |
| `sites/dev{,/en}/orientation/architecture-overview.md` | 引用ブロックは `1.2` なのに、直下の箇条書きが `DSL spec 1.1` / 拡張 `2.1.0` |
| `sites/dev{,/en}/decisions/adr-002-dsl-v3-pivot.md` | 同上（Sources 行が `DSL_VERSION = '1.1'`・導入の「ちなみに」段落が v1.1 / product 2.0.0） |
| `sites/dev{,/en}/editor/vscode-architecture.md` | 冒頭と Sources の `package version 2.1.0` |

いずれも「3 つは別軸で同期しない」（`docs/design/656-release-design.md` §4.4）を本文に書き足して、
次に読む人が #871 と同じ取り違え（WORK_LOG の「私は一度これを間違えた」）を繰り返さないようにした。
dev サイトは日英両方。frontmatter の `verified-against` / `verified-at` を更新した 3 章（6 ファイル）は、
Note 行に「**バージョン節だけ**追従した」と明記して、章全体を再検証したと読まれないようにしてある。

**直さずに報告に回したもの**（仕様の判断であって追従作業ではない）:

- `docs/specs-v2/PITCH_DSL_SPEC_v1.1.md:5` の docmeta が `"version":"1.1"`。`DSL_VERSION` は 1.2 に
  なったが、**1.2 の spec 文書は存在しない**。spec 正本をどう扱うかは owner 裁定事項
- `docs/specs-v2/SESSION_LOG_SPEC_v1.md:51` のメタヘッダ例が `"dslVersion":"1.1"`。同じ行の
  `"engineVersion":"1.1.0"` は #871 と無関係に古く（§5-5 で version 自動同期は #276 deferred と明記）、
  片方だけ直すと実在しないサンプルになる
- `docs/core/INSTRUCTION_ORBITSCORE_DSL.md:3,5` の `Product version: OrbitScore 2.0.0`。#871 で
  `CLAUDE.md` は「Product: 拡張 3.0.0」に変わったので、「product version」という軸を残すのかが未決

### docs: PR #870 のドキュメント追従レビュー — 追従不要（Sep 11, 2026）

マージ済み PR #870（`f56e02e7d03306f7d811b2d2edac9814baa38ee5`）に対するドキュメント追従レビュー。

**ドキュメントの追従は不要**と分類した。差分 2 ファイルの内訳は
`tests/core/loop-quantize.spec.ts`（モックの時計を固定するテストのみの変更）と
`docs/development/WORK_LOG.md`（PR 自身が記載済み）で、出荷物・DSL の意味論・MCP の表面・
OrbitStudio の評価経路のいずれにも差分が無い。`nextQuantizedTime()` の実装は無変更で、
`sites/dev/scheduling/transport.md:388-410` の記述と `docs/core/INSTRUCTION_ORBITSCORE_DSL.md:316-354`
は現行実装と一致している。

ただし**実機 E2E の穴**は残っている。この PR が固定した LOOP quantize の起動境界は、
`tests/e2e/dsl-e2e-coverage.spec.ts` の baseline 上で今も未カバーである
（`loop`/`quantize` が seq・global 両方に、`transport-loop` が構文側に載ったまま）。
詳細と再現手順は本コミットの PR 本文に記載した。**baseline は編集していない。**

### fix(release): ship the extension's own runtime deps so the .vsix can activate (#873) (Sep 11, 2026)

🔴 **凍結版リリースのブロッカー。** cold install（#138・ゴールの最終段）で発見した。
素の VS Code に `.vsix` を入れると、**拡張が activate せずに落ちていた**。

```
Error: Cannot find module '@modelcontextprotocol/sdk/server/mcp.js'
  at Object.<anonymous> (.../local.orbitscore-3.0.0/dist/extension.js:74:22)
```

#### 原因 — npm workspaces の hoisting

`packages/vscode-extension/package.json` は `@modelcontextprotocol/sdk` と `zod` を実行時依存として
宣言しているが、どちらも npm workspaces が**リポジトリルートへ hoist** する。`.vscodeignore` は
`../../**` と `../*/**` でパッケージ外を全部落とすので、`vsce package` が同梱する
`extension/node_modules` は **`@types` と `undici-types` の 2 つだけ**だった（実測）。

`require` は遅延ではない: `dist/extension.js:74` → `require("./mcp-server")` →
`dist/mcp-server.js:51-53` がトップレベルで SDK と zod を要求する。よって activate が無条件に落ちる。

#### engine 側では 2 回起きていた事故が、拡張側だけ無防備だった

| 出典 | 欠けた依存 | 症状 |
|---|---|---|
| WORK_LOG 6.119 (Jun 17, 2026) | `@julusian/midi` / `uuid` / `ws` | engine が MIDI 初期化で落ちる |
| WORK_LOG 6.422 (Aug 30, 2026) | `yaml` | #654 の実機ゲートで発見。engine が最初の evaluate で落ちる |
| **#873** | **`@modelcontextprotocol/sdk`** | **activate() がそもそも走らない** |

対策の `scripts/install-engine-deps.sh` は **engine の依存しか見ていなかった**。ロジックを
`scripts/install-bundle-deps.sh` へ抽出し、engine と拡張の両方がそこを通るようにした（DRY）。

#### 置き場所が `dist/node_modules` なのには理由が 2 つある

1. **`vsce package` はパッケージ直下の `node_modules` を無条件に除外する。**
   `.vscodeignore` に `!node_modules/**` と書いても**上書きできない**（実測）。
   `engine/node_modules` や `dist/node_modules` のような入れ子は特別扱いされず普通に入る
2. **Node の解決順で最初に当たる。** `dist/mcp-server.js` から見て `dist/node_modules` は
   1 つ目の候補なので、パスの書き換えが要らない

パッケージ直下へ入れると**パッケージング自体が壊れる**: 依存が hoist 先とローカルの 2 箇所で
解決できるようになり、`vsce` の依存探索が 1 つの `.vsix` エントリに 2 つの元パスを出して
`the following files have the same case insensitive path` で失敗する。だから
`vsce package` には **`--no-dependencies`** を付け、探索そのものを止めてある。

#### CI が捕まえられなかった理由と、足したゲート

`release.yml` の post-package 検証は `packages/engine/package.json` の依存しか突合していなかった。
同型の検査を**拡張自身の依存**にも足した（`extension/dist/node_modules/<dep>` の実在確認）。
この PR は `packages/vscode-extension/**` と `release.yml` の両方を触るので、
release smoke が本 PR 上で実際に `.vsix` を作ってこのゲートを通す。

#### 検証 — cold install で音が出るところまで

空の `--extensions-dir` に `.vsix` を入れ、**`--extensionDevelopmentPath` を使わず**
インストール済み拡張として素の VS Code を起動し、MCP だけで駆動した。

| 確認 | 結果 |
|---|---|
| activate | ✅ `Cannot find module` 0 件 |
| MCP サーバ | ✅ 2 秒で listen |
| daemon の解決 | ✅ `/private/tmp/orbcold-e-*/local.orbitscore-3.0.0/engine/bin/darwin-arm64/orbit-audio-daemon` |
| 評価 | ✅ `ok` |
| **音** | ✅ capture 36.10 s・非ゼロ **46.7%**・**RMS 0.053537**・peak 1.133490 |

🔴 **daemon が拡張バンドルから解決された**ことが、cold install でしか通らない経路の確認にあたる。
dev host（`--extensionDevelopmentPath`）はリポジトリの `rust/target/release` を引くため、
`extension-bundle` 分岐を一度も通らない。#138 がここまで「⏳ Pending」だった穴がこれ。

検証: `npm test` 2,338 passed / 0 failed・`npm run lint` 緑・引用 944 / 0 failed
（`release.yml` に行を足したので `signal-chain/index.md` の `184-193` を `204-213` へ再アンカー。
着地先が標準プラグイン同梱ゲートであることを目視で確認済み）。

Closes #873


#### `/simplify` の反映（4 エージェント並行・#874）

| 指摘 | 対応 |
|---|---|
| `--prune` / merge の分岐を**どの呼び出し元も使っていない**（両方 `--prune`） | 削除。`dist/node_modules` へ寄せる前の探索の残骸だった。常に置き換える形に一本化 |
| `install-bundle-deps.sh` が `DEST_DIR` を作らないので wrapper が `mkdir` を持たされていた | `mkdir -p "$DEST_DIR"` にした |
| `release.yml` の依存検査ループが engine / extension で重複（同型が計 3 箇所） | 1 ループに畳んだ。`"<label>:<package.json>:<vsix 内の node_modules>"` の表を回す |
| `npm run build` のたびに `npm install` が 2 回走る | 宣言した依存の spec を `node_modules/.orbitscore-bundle-deps.json` に刻み、一致していれば skip。実測で 2 回目以降は `already current — skipping install` |
| 同じ JSON を `node -e` で 2 回読んでいた | 1 回に畳んだ（書き出しと同じ pass で名前も出す） |
| レジストリへの往復 | `npm install` に `--prefer-offline` を足した |
| esbuild という深い解が検討された形跡が残らない | **#875** を立て、`install-bundle-deps.sh` のヘッダから指した |

**見送ったもの**:

- **wrapper 2 本を 1 本に畳む** — `install-engine-deps.sh` は外部（CLAUDE.md の手動ゲート・root の `pretest:e2e:gated`・dev サイト）が名前で呼ぶので残す必要がある。`install-extension-deps.sh` を消すと、**「なぜ `dist/node_modules` なのか」という実測 2 件の知識**を `package.json` の 1 行に添える場所が無くなる。名前付きファイルに置く方の価値を取った
- **`scripts/orbitstudio/make-local-release.sh` が同じ機構を再実装している** — git 管理外（未追跡）で、`scripts/orbitstudio/` ごと畳む予定（正本 §12.7 の 3）。なお `extension/node_modules/$DEP` を見ているので、**黙って壊れた成果物を作るのではなく loud に落ちる**（安全な側）

#### 整理後にもう一度 cold install を通した

| 確認 | 結果 |
|---|---|
| activate | ✅ `Cannot find module` 0 件・MCP は 4 秒で listen |
| 評価 | ✅ `ok` |
| 音 | ✅ capture 15.04 s・非ゼロ **46.5%**・**RMS 0.052550**・peak 1.133490（前回と同一） |

CI ゲートの**負の確認**も取れている: 修正前の `.vsix` を展開したディレクトリに同じループを当てると
`::error::extension runtime dependency '@modelcontextprotocol/sdk' missing` で exit 1 になった。


#### レビューラウンド 1（4 レビュアー + Fable 監査を並行）と、その fix

**Critical 2 件はどちらも main（自分）の手が原因だった。**

| # | 誰が | 指摘 |
|---|---|---|
| C1 | silent-failure-hunter | `/simplify` で 2 つのループを 1 本に畳んだ際に足した `|| {}` が、**`dependencies` を読めない時に「何も検査せず緑」**を作っていた。旧 engine 版には `|| {}` が無く `TypeError` → `set -e` で落ちていた。`package.json` の typo 1 つで、この PR が塞いだ欠陥クラスがゲート側に復活する |
| C2 | comment-analyzer | 出典の `#209` / `#654` が**無関係の issue**（#209 = LinkAudio の feature、#654 = playhead の修正）。既存コメントの誤帰属を「3 回刺さった」という目立つ表へ増幅していた |

**Fable が Sonnet 4 体と直交して見つけたもの:**

- ゲートは**宣言された最上位の依存しか見ない**。sdk の推移依存 17 個が欠けても緑のまま MCP が落ちる
- **出荷版が lockfile と乖離**（sdk 1.29.0→1.30.0 / zod 4.4.3→4.6.2 / yaml 2.8.3→2.9.0 / midi 3.6.1→3.8.1）。**テストしたのと別の版を凍結版として出す**ことになっていた
- **ゲート自身を守るテストが無い**。同型の child バイナリのゲートには `bundled-child-binaries.spec.ts` があり、台帳照合とゲートの bash 実走の両方をやっている
- `release.yml` の `pull_request.paths` に install スクリプトが無く、それだけを触る PR は smoke が走らない

一方 **`vsce` の挙動についての実測クレームは、vsce 2.32.0 のソースで裏付けが取れた**（`collectAllFiles` が `.vscodeignore` 適用**前**に `node_modules/**` をハードコード除外し、そのパターンは入れ子にマッチしない）。ただし「無条件」は `--no-dependencies` 下でのみ真。

#### 設計パス（指摘ごとのローカルパッチにしない）

> **ゲートは「宣言を数える」のではなく「出荷物の中で実際に解決できるか」を検査する。
> チェックリストが空になったら「依存が無い」ではなく「読み方を間違えた」として loud に落とす。
> そしてゲート自身を守るテストを同じ PR に置く。**

`scripts/check-vsix-bundled-deps.mjs` を新設（前例: `check-release-tag-version.mjs`）。`release.yml` の
インライン 14 行はその呼び出し 1 行になり、**C1 の `|| {}` ごと消えた**。検査は
`createRequire(<出荷物内の実 require 元>).resolve(<実 specifier>)` で、解決した各パッケージの
`dependencies` を再帰的に辿る（コードは実行しない）。

#### 受け入れ検証（main が sandbox 外で実走・自己申告は根拠にしない）

🔴 **同一の壊れたツリーに対する新旧の比較**（`dist/node_modules/express` = sdk の推移依存を削除）:

| ゲート | 結果 |
|---|---|
| 旧（宣言された最上位ディレクトリのみ） | `all declared dependencies present — PASS` / **exit 0** |
| 新（出荷物内で実際に解決） | **exit 1** |

**検出力が名目でなく実際に増えている。**

壊し方を 3 通り試して全部 exit=1（原因を名指し）: 宣言依存の削除（`zod`）/ **推移依存の削除（`express`）** / engine 依存の削除（`yaml`）。

C1 の変異: `dependencies` → `dependencyes`（#873 と同型の typo）で **exit=1**、戻して **exit=0**。

lockfile 固定の実測 — 7 件すべて一致し、`uuid` は罠を回避（`packages/engine/node_modules/uuid` の
**13.0.2**。`node_modules/mermaid/node_modules/uuid` の 11.1.1 ではない）:

| 依存 | lockfile | 出荷 | 修正前 |
|---|---|---|---|
| `@modelcontextprotocol/sdk` | 1.29.0 | **1.29.0** | 1.30.0 |
| `zod` | 4.4.3 | **4.4.3** | 4.6.2 |
| `uuid` | 13.0.2 | **13.0.2** | — |
| `yaml` | 2.8.3 | **2.8.3** | 2.9.0 |
| `@julusian/midi` | 3.6.1 | **3.6.1** | 3.8.1 |

cold install をやり直し（**Finder 相当の最小 PATH** で起動）: activate ✅ / `Cannot find module` 0 件 /
MCP 4 秒 / `evaluate` ok / **engine ログの `ERROR:` 0 行** / capture 16.04 s・非ゼロ **42.7%**・
**RMS 0.050784**。

`npm test` **2,347 passed / 67 skipped / 0 failed**（+9）・lint 緑・`typecheck:e2e` 緑・
引用 944 / 0 failed（`release.yml` の行が動いたので 4 件を再アンカーし、着地先が
「実 Gain テスト」と「標準プラグイン同梱ゲート」であることを目視確認。散文の行参照も追従させた）。

#### 見送り・切り出し

- **wrapper 2 本を 1 本に畳む** — `install-engine-deps.sh` は外部が名前で呼ぶので残す必要があり、
  `install-extension-deps.sh` を消すと「なぜ `dist/node_modules` なのか」という実測 2 件の知識を
  置く場所が無くなる
- **#877**: cold install を再実行できる gated spec にする（#138 を #656 へ吸収する計画から切り離す —
  #656 はネイティブ `.app` 配布で別物・後の話）
- **#878**: `extension.ts:2000` の `spawn('node', …)` が PATH 依存で `process.execPath` の
  フォールバックが無い。実測では VS Code の shell 環境解決に救われて通ったが、**出荷の前提が
  他社実装の詳細に乗っている**
- **#875**: esbuild でバンドルして本機構ごと退役させる（宣言されていない import は今の機構では
  原理的に見えない）


#### fix 差分の再点検（ラウンドを閉じる前・1 レビュアー）

問いは 2 つだけ: 「この修正が導入する新しい故障モードは何か」「新コードはどの実行コンテキストで走るか」。
**Critical 0 / Important 3**。いずれも同じ向き — **保証が深さ 1 では本物で、深さ 2 以上で宣言検査へ退化する**。

🔴 **加えて、main 自身が 1 件見つけた**: `.vscodeignore` に**未コミットの変更が残っていた**。
`git commit` した**後**に Codex が書いたもので、「完了通知は稼働終了を意味しない」の実例。
内容は `!engine/node_modules/**` の削除で、理由として「入れ子は普通に入る」と書かれていた。

**実測したら理由が誤りだった**: 否定指定を外すと `engine/node_modules` の同梱が **422 → 317 件**へ減る。
つまり否定指定は load-bearing で、`**/*.ts` 等の一般規則が効いているのを打ち消していた。
ただし失われる 105 件の内訳は **`.ts` が 104 個とスタンプ 1 件**で、`.js` / `.node` /
パッケージの `package.json` は 1 つも落ちない。**変更自体は実害のないサイズ削減**（9.4 → 9.34 MB）
なので採用し、**コメントを実態に書き直した**（数字つきで）。

| 指摘 | 対応 |
|---|---|
| 推移依存の版が固定されていない（temp install に lockfile が無く range で再解決される） | **限界として明記**。宣言層の乖離（sdk 1.30.0 / zod 4.6.2 対 lockfile の 1.29.0 / 4.4.3）は潰れており、そこが譜面の振る舞いに効く層。グラフ全体の固定は lockfile の合成が要るので #875 へ |
| 深さ 2 以上は `require.resolve` ではなくディレクトリ探索（存在すれば通る） | **限界として明記**。全辺を実解決する案は**試して却下**されている — CJS が実際には require しない ESM-only の推移パッケージで**偽の赤**になり、リリースを理由なく止める |
| `catch {}` が内側のエラーを捨て、どの推移パッケージが欠けたか分からない | **直した**。`reason` を持ち回って診断に出す |

再点検後の実測 — `dist/node_modules/express`（sdk の推移依存）を削除:

```
::error::extension runtime specifier '@modelcontextprotocol/sdk/server/mcp.js' cannot be
resolved from extension/dist/mcp-server.js in the packaged .vsix
  — express cannot be resolved from .../node_modules/@modelcontextprotocol/sdk/package.json
```

**どの推移パッケージが欠けたかがログだけで分かる。** 以前は最上位の specifier しか出なかった。

`npm test` 2,347 passed / 0 failed・lint 緑・引用 944 / 0 failed・ゲートは実 `.vsix` で exit 0。

#### 🔴 CI が 3 回走っていなかった

`f83aa658` / `b99c1d04` / `af19ac93` の push で CI が 1 度も起動していなかった。原因は
**PR が `DIRTY`**（main と衝突）だったこと — GitHub は merge commit を計算できない PR では
`pull_request` ワークフローを走らせない。**緑でも赤でもなく「無」だったので、`gh pr checks` は
`no checks reported` としか言わない。** main をマージして解消した。

**教訓**: `gh pr checks` が「no checks reported」と言う時は、待つのではなく
`gh pr view --json mergeStateStatus` を見る。

### test(core): freeze the clock in the loop-quantize mock (#869) (Sep 11, 2026)

`tests/core/loop-quantize.spec.ts` の「snaps to the same boundary already crossed when
currentTime equals a boundary」が CI で間欠的に落ちていた（PR #847 の `code-review` ジョブ・
run 34560570537）。**#847 は docs 7 ファイルのみ**で、コードに触れていない。

#### 原因は `Date.now()` を 2 回呼んでいたこと

モックの `startTime` が getter で、アクセスのたびに `Date.now() - elapsedMs` を再計算していた。
呼ぶ側（`prepare-playback.ts:73-75`）はその直後に**別の `Date.now()`** を呼ぶ。この 2 回の間に
ミリ秒が繰り上がると `currentTime = elapsedMs + 1` になる。

このテストだけが **`elapsedMs = 2000`（小節境界ちょうど）** を突くので、+1ms で
`nextQuantizedTime` が「境界を過ぎた」と判定し、次の境界 **4000** を返す。他のテストは境界の
途中（1500 等）なので 1ms では判定が変わらない。

**プロダクションコードの欠陥ではない。** 実機の `startTime` は保存された数値で、読むたびに
動いたりしない。壊れていたのはモックの側。

#### 4000 には犯人候補が 2 つあった

`expected 4000 to be close to 2000` は、**(a) +1ms で次の小節**でも
**(b) 直前のテストの `global.quantize('2bar')` が漏れた**でも同じ値になる。(b) を潰してある:
`QuantizeManager._value` は private なインスタンスフィールド（既定 `'bar'`）で、`beforeEach` が
`Global` ごと作り直すため漏れる経路が無い（`packages/engine/src/core/global/quantize-manager.ts:75-76`）。

#### 機構の実測

旧モックと同じ 2 回読みを 500 万回回すと、**109 回**（0.0022%）で
`currentTime !== elapsedMs` になった。手元ではこの頻度だが、負荷のかかった CI runner では
2 回の `Date.now()` の間隔が広がるので、実際の発火率はこれより高い。

#### 直したもの

describe 全体で `Date.now` を固定値に固定し、`startTime` の getter も同じ定数から引く。
**両方が揃って初めて成立する** — getter だけ定数にして `Date.now` を生かすと、
`currentTime` が巨大な値になる。`afterEach` の `vi.restoreAllMocks()` が復元する。

検証: `npm test` **2,338 passed / 67 skipped / 0 failed** / `npm run lint` 緑 /
引用 938 / 0 failed。

Closes #869

### chore(release): bump the extension to 3.0.0 and the DSL spec to 1.2 (#843) (Sep 11, 2026)

owner 裁定 2026-09-11（#851 A-1）: **`v3.0.0` / DSL 1.2**。

## 🔴 動かしたのは 1 つだけ — 正本は拡張の package.json

`docs/design/656-release-design.md` §4.4 が版の所在を確定させている:

| 場所 | 規則 | 今回 |
|---|---|---|
| `packages/vscode-extension/package.json` | 🔴 **正本**。`.vsix` / `.app` / タグの版はこれ | **2.1.0 → 3.0.0** |
| `ENGINE_VERSION` | **別軸**（セッションログの meta ヘッダ）。同期しない | **2.0.0 のまま** |
| `DSL_VERSION` | **別軸**（spec 版）。同期しない | 1.1 → **1.2**（別軸の理由で動かす） |
| ルート `package.json` | `private: true` で配布物にならない | 触らない（裁定待ち (7)） |

`DSL_VERSION` を上げたのは「拡張が 3.0.0 になったから」ではなく、**DSL の表面が変わったから**
（`send` の dB 化・`output(dest, thru, db)` の導入・`pan` のライン要素化）。理由が別なので
数字も揃わない。

🔴 **私は一度これを間違えた。** 「拡張 package.json・`ENGINE_VERSION`・`DSL_VERSION` の 3 つを
揃える」と報告し、`/simplify` の Altitude が §4.4 を示して正した。
`ENGINE_VERSION 2.0.0` と拡張 `2.1.0` の食い違いは**事故ではなく設計**だった。

## なぜ major か

- `ORBITSCORE_ENGINE` 環境変数・`orbitscore.engine` / `scsynthPath` 設定・
  `Force Kill scsynth` コマンド・MCP `force_kill_scsynth` を**削除**した（#502）
- `send` が**線形係数から dB へ**変わり、既存の譜面の意味が変わる

## 追従した記述

root `README.md`（2 箇所）・`CLAUDE.md`・`docs/core/INSTRUCTION_ORBITSCORE_DSL.md`（2 箇所）・
dev サイトの `version.ts` 引用 4 箇所。いずれも「3 つは別軸」と明記して、
次に読む人が同じ取り違えをしないようにした。


#### owner 裁定（2026-09-11）と、リリース直前の README 2 件

正本 `docs/planning/NATIVE_MIGRATION_2026-09.md` §12.7 が **未決**として残していた 2 件に
裁定が出た。

| 未決だったもの | 裁定 |
|---|---|
| バージョン番号 | **3.0.0 / DSL 1.2**（`send()` の dB 化で既存譜面の意味が変わるので semver では major） |
| タグ名前空間 | **`v3.0.0`**。`ext-v*` / `app-v*` の分離はネイティブ版の新ラインで行う（§12.3）。`release.yml` のトリガーは `v*` のままでよく、ワークフローの変更は不要 |

残り 3 件は裁定待ちではなく既に解消済み: SC 削除 = #840 / gated ハーネス = #831 /
README の導線 = #842。Marketplace publish は「行わない」（owner 2026-09-10）で、
リポジトリ変数 `PUBLISH_MARKETPLACE` が未設定のため publish ステップは skip される（実測）。

**ついでに直した README 2 件** — どちらも「これから打つタグが何をするか」と食い違っていた:

- `tag push で全 channel に自動 publish` → 当時の計画である旨と、現在は GitHub Release だけが
  作られることを明記
- 「ICMC v1.1.0 bundle release」節の見出しに historical を付け、表が挙げている scsynth 同梱は
  #502 で削除済みで**現在の `.vsix` に scsynth は入っていない**という注記を足した

出荷される `packages/vscode-extension/README.md` は元から SC 参照 0 件で、Marketplace 非公開も
正しく書かれている（実測）。直したのはリポジトリ表紙の側。

ガードの実測: `checkTagAgainstVersion('v3.0.0', '3.0.0', 'darwin-arm64')` → `{ok: true}` /
`('v3.0.0', '2.1.0')` → 版が食い違うと fail（#853）。**バージョンバンプがタグより前に入る必要がある**
ことをこのガードが担保している。

検証: `npm test` 2,338 passed / 0 failed・`npm run lint` 緑・引用 944 / 0 failed。

### docs: land the nine routine docs-sync PRs as one roundup (#867) (Sep 11, 2026)

凍結版リリース（#827）のタグを打つ前に、溜まっていたルーティン docs 追従 PR **9 本**
（#837 / #844 / #847 / #856 / #858 / #862 / #864 / #865 / #866）を統合ブランチ
`867-docs-sync-roundup` で 1 本にまとめて main へ入れた。**docs のみ**で `packages/` `rust/`
`tests/` `.github/` は触っていない。学習サイトはリリースの一部なので、タグ前に反映させる必要がある
（owner 2026-09-11）。

#### なぜ 1 本にまとめたか — 逐次マージだと兄弟の内容が消える

9 本すべてが `WORK_LOG.md` を触り、#844 と #856 は 13 ファイルを共有、#837 / #862 / #865 は
`sites/dev/editor/mcp-and-gated-e2e.md` の**同じ Note 行と同じ節**に追記していた。1 本ずつ main へ
入れると残り 8 本を毎回再同期することになり、しかも従来の解決規則「WORK_LOG は両側・他は追従側を
採る」は、**main 側に兄弟 PR の内容が入った後では兄弟の内容を落とす**（規則が前提にしていた
「main 側 = 古い baseline」が成り立たなくなるため）。

#### 衝突の解決（全 22 hunk・いずれも同じ事実の別表現か、同じアンカーへの独立追記）

| 種別 | 解決 |
|---|---|
| WORK_LOG の同一アンカーへの独立エントリ（4 箇所） | 両方残す |
| #844 × #856 の SC 削除記述（11 ファイル・18 hunk） | hunk ごとに**情報量の多い側**を採る。`glossary.md` の Sources 一覧（ja/en）と `index.md` の Part VII 行（ja/en）は #844 側（#836 / #838 の粒度と `daemon-client.ts` の行がある）、残りは #856 側 |
| `mcp-and-gated-e2e.md` の Note 追従リスト（ja/en） | #830・#860・#855 の 3 件を**合併**。frontmatter は最新の `a6e1f13` / 2026-09-11 |
| 同じ章の新設節（#862 の `###` 節 × #865 の散文） | 両方残す。#865 の散文を先（直前の #756 段落から続く）、#862 の `###` 節を後 |

🔴 **1 件だけ「両方残す」では壊れた**: #865 は #857 の WORK_LOG エントリを Recent Work の先頭へ
**移動**していたので、素朴に両側を残すと同じエントリが 2 箇所に出る。移動先を残して旧位置
（54 行）を削除した。**「両側を残す」は追記には正しく、移動には正しくない。**

#### 検証

`node sites/dev/scripts/check-citations.mjs` **944 citations verified / 0 failed**（`--fix` は
使わず素で実行）/ `npm test` **2,338 passed / 67 skipped / 0 failed** / `npm run lint` 緑 /
`docs:build` dev・user 両方緑。

Closes #867

### docs(sites): re-anchor three citations #859 left pointing at the wrong code (Sep 11, 2026)

PR [#860](https://github.com/signalcompose/orbitscore/pull/860)（merge `e4d4199`）の追従。
#860 自身が `34e12b3` で dev サイトを更新しているが、**引用の再アンカーが 3 箇所ずれていた**。
`check-citations.mjs` は「引用文字列が実ファイルと一致するか」しか見ないので、
**別の関数に一致してしまった引用は緑のまま通る**。

| 箇所 | 何が起きていたか |
|---|---|
| `sites/dev{,/en}/signal-chain/mixer-audio-line.md` | bus post-loop の `LineOp::Output` 腕を引用していたはずが、`execute_master_line`（master 側）の `LineOp::Output` 腕に再アンカーされていた。直後の本文「`Output` として実行されるのは `Master` / `Bus` / `Device` の 3 つ」と引用が食い違う（master 側は `Device` 以外を `debug_assert!(false)` で落とす）。`output.rs:2566-2592` へ戻した |
| 同上（pan 節） | `apply_line_pan` の引用が切り詰められ、直後の本文が指す **`√2`** が引用内に無くなっていた。`√2` は #859 で `line_pan_coefficients` へ切り出されたので、その関数（`output.rs:2227-2243`）の引用を足した |
| `sites/dev{,/en}/rust-engine/index.md` | `render_block_with_sources` の引用が 4 行はみ出して `execute_master_line` のシグネチャを含んでいた。`1846-1932`（関数の閉じ括弧）で止めた |

あわせて、#859 が**コード引用だけ更新して本文を更新しなかった**箇所を直した
（`sites/dev{,/en}/rust-engine/index.md` の `advance_gain` 節）。旧本文の
「block が ramp より長ければ 1 回で目標へ到達」は、いまはブロック**終端**の値の話であって、
ブロック内は `ramp_frames` サンプルかけて補間される。これは #859 が直した欠陥そのものなので、
そのまま残すと修正前の振る舞いを説明する文が残ることになる。

4 章の `verified-against` / `verified-at` を `e4d4199` / 2026-09-11 に更新。

検証: `npm run docs:check` **938 citations / 0 failed** / `docs:build`（user / dev）両方緑。
### docs(sites): follow PR #861 — record the mirror-image consequence of line-wise ERROR prefixing (Sep 11, 2026)

PR [#861](https://github.com/signalcompose/orbitscore/pull/861)（#860・merge `5ed3ce5`）の追従。

IV-3 章（`sites/dev/editor/mcp-and-gated-e2e.md`）は #756 の「`ERROR:` 前置が chunk 単位
だったので ERROR 件数が**構造的に過小**だった」までを書いていたが、**その裏返し**を
書いていなかった。行単位になったということは「engine の stderr に出た行はすべて `ERROR:`」
であり、**正常系の `warn!` 1 行で件数テストが巻き添えになる**。#861 はまさにそれで、
`query_note_port_index` の warn が `default-baseline cycle must add no ERROR: lines`
（`tests/e2e/orbitstudio-mcp-gated.spec.ts:3426-3430`）を落としていた。

ja / en の両方に節を追加（STYLE_GUIDE のバイリンガル必須）。ERROR 会計という 1 本の
計測系に**測定器の側**（前置の粒度）と**被測定側**（engine のログレベル）の 2 つの入口が
あり、**直す場所が正反対**であることを本文に残した。

`verified-against` は据え置き。1 節の追記であって章本文の書き直しではなく、STYLE_GUIDE
§4「小規模 cross-link / 体裁修正のみは更新しない」と「実質的に書き直したとき」の中間に
あたるため、章冒頭の Note（この章が従来から追従履歴を書いている場所）に #861 を追記する
方式を採った。

検証: `npm run docs:build`（user / dev）緑 / `npm run docs:check` 緑。

### docs: follow PR #852 in the user site and the diagnostics chapter (Sep 11, 2026)

マージ済み PR [#852](https://github.com/signalcompose/orbitscore/pull/852)（束 B・`611-dsl-surface` →
main・merge commit `ded9709`）の追従。**ドキュメントのみ**の変更で、`packages/` `rust/` `tests/` は触っていない。

#852 は core spec（`docs/core/INSTRUCTION_ORBITSCORE_DSL.md` MX.2 / MX.3 / MX.4 / MX.5）と
specs-v2（`SIGNAL_CHAIN_DSL_SPEC_v1.md` SC.4）を自分で更新していたが、**ユーザー向けの 3 ファイルが
旧仕様のまま残っていた** — いずれも「dB 化は決まったが未実装」「send は post-fader 固定」と書いており、
実装済みの今は**読んだ人が逆の行動を取る**記述になっていた。

## 直したもの

| ファイル | 何が古かったか |
|---|---|
| `sites/user/mixing/routing.md` / `en/` | `send(name, amount)` が線形・dB 化は未実装・post-fader 固定 |
| `sites/user/reference/methods.md` / `en/` | 同上 + `output()` の宛先が sum のみ・`thru:` / `db:` 不在 |
| `docs/user/ja/USER_MANUAL.md` | `output()` / `send()` の宛先を「sum バス」と書いていた |
| `sites/dev/editor/execution-feedback.md` / `en/` | 診断 6 がミキサー宛先を除外するようになったこと（#852 の `diagnostics-analysis.ts:257-262`）が未記載 |

追記した利用者から見える表面（すべて #852 の差分から読み取れるもの）:

- `send(aux, db)` の単位が **dB**（線形 `0.3` 相当は `-10.5`）。`amount:` は loud に throw
- `send(aux, db, enabled: false)` はチェーン上の位置を保持したまま送出を止める
- `output(dest, thru:, db:)`。`thru: false`（既定）が終端・`thru: true` がタップ
- `send(name, db)` ≡ `output(name, thru: true, db: db)`
- 宛先の解決順: 解決済みノード → `"master"` → 宣言済み sum/aux → `"L,R"` → LinkAudio channel
- `effect()` / `gain()` / `pan()` / `send()` / `output()` は**書いた順に 1 本の線**に並ぶ
- `sum` / `aux` バスも `output()` / `send()` / `gain()` / `pan()` を受ける（`BUS_DSL_METHODS`）
- `master` はミキサーノード名として予約・`mix.output(1, 2)` はデバイスであって master ではない
- `mix.output(n)` の 1 引数形はモノラル（L+R マージ）

## 書かなかったこと（PR 本文の「確認してほしい点」へ回した）

- core spec MX.5 の「sum ネスト不可」と、同 PR が MX.2.2 に書いた「sum が別の sum へ出せる ✅」が
  **食い違って見える**。どちらが正しいかは仕様の判断なので追従作業では直さない
- `gain()` / `pan()` の固定値が**バス未確保の audio シーケンスでは発音側に留まる**という条件分岐は、
  ユーザー向けページには書いていない（内部の割り当て事情で、書くと「位置が効かない場合がある」と
  読めてしまう）

検証: `npm run docs:build -w @orbitscore/user-site` 緑 / `-w @orbitscore/dev-site` 緑 /
`npm run docs:check` **938 citations verified, 0 failed**。

### docs(sites): follow PR #857 — a benign warn is an input to the release gate (#855) (Sep 11, 2026)

マージ済み PR [#857](https://github.com/signalcompose/orbitscore/pull/857)（merge commit `a6e1f13`）への
ドキュメント追従。**実装とテストは変更していない。**

## 追従先

**`sites/dev/editor/mcp-and-gated-e2e.md` / `sites/dev/en/editor/mcp-and-gated-e2e.md`**（ja/en 両方）。

この PR が直したのは engine 内部の TOCTOU だが、**観測可能な表面は ERROR 件数**である。
IV-3 の「`get_log` とリングバッファ」節は、この計数が信用できない理由を 2 つ挙げていた
（固定窓による false green・#756 以前の chunk 単位前置による**構造的な過小**）。#855 は
その 3 つ目で、向きが逆の**構造的な過大**にあたるので、同じ節に並べて書いた。

- `temp-file-manager.ts:98-118` を引用し、per-entry の `try` が ENOENT だけを飲む形を示す
- #840 のマージ前ゲートで `expected 9 to be less than or equal to 8` として出た実測を明記
- ループ全体を囲む `try` だと ENOENT 1 件で残りが掃除されない副次問題も残す
- 一般則を #756 と対にして締める:
  **engine のどこかの `console.warn` 1 行が、そのままリリース可否ゲートの入力になる**

frontmatter は `verified-against: a6e1f13` / `verified-at: 2026-09-11` へ更新し、
冒頭 Note の追従リストにも #855 を足した。

## WORK_LOG の並びを直した

#857 の WORK_LOG エントリ（Sep 11）が、マージ時のコンフリクト解消（`1c3056a`）で
**Sep 10 の #611 エントリ群の間**に入っていた。本文は変えず、位置だけ Recent Work の
先頭へ移した。#857 は #860 / #852 より後のマージなので、そこが時系列上の正しい位置になる。

## 追従不要と判断したもの

| 対象 | 理由 |
|---|---|
| `docs/specs-v2/` `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` | DSL の構文・意味論・`.orbslog` 形式に変更が無い |
| `sites/user/` `docs/user/ja/USER_MANUAL.md` | ユーザーが書く語に変更が無い。temp 掃除は DSL から不可視 |
| `rust/` 側の章 | diff は TypeScript の engine のみ。MCP ツールの引数・返り値・エラー挙動は不変 |
| `sites/dev/audio/audio-file-playback.md` | slicing 章だが SC 経路の歴史的読解で、`TempFileManager` を扱っていない |

### fix(engine): stop a benign temp-dir race from inflating the ERROR count (#855) (Sep 11, 2026)

#840 のマージ前ゲートで実機 gated が 2 件落ち、うち 1 件がこれだった。

```
AssertionError: expected 9 to be less than or equal to 8
ERROR: Failed to cleanup old directories: Error: ENOENT: no such file or directory,
       stat '.../T/orbitscore_1789065642138_xx52jsw'
```

**原因は TOCTOU**（`temp-file-manager.ts:93-110`）。`readdirSync` で列挙してから `statSync`
する間に、**別のエンジンインスタンスの同じ掃除**が同じディレクトリを消す。gated suite は
エンジンを何度も起動・停止するので、複数インスタンスが同じ temp root を奪い合う。

`catch` は「Ignore errors during cleanup」と書いているのに `console.warn` を出しており、
engine の stderr 分類で **`ERROR:` 行になる**（memory `stderr-is-classified-as-error` の再発）。
**ディレクトリが既に無いのは、このループが望んでいた結果そのもの**で失敗ではない。

**副次**: `try` がループ全体を囲んでいたので、**1 件 ENOENT が出た時点で残りを見ずに抜けて**
いた。孤児が溜まる。

## 🔴 変異検証が別の穴を見つけた

修正のテストに変異をかけたところ、**`orbitscore_` 接頭辞の判定を外しても全テストが緑**だった。
この掃除は**共有の `os.tmpdir()`** を舐めて **1 時間以上前のディレクトリを消す**ので、
接頭辞判定は**他アプリの temp を消さない唯一の歯止め**である。テストを足した。

| 変異 | 結果 |
|---|---|
| ENOENT も含め全部握り潰す | 1 failed |
| ENOENT も再送出（元の挙動へ戻す） | 1 failed |
| 1 時間の条件を外す（新しい dir も消す） | 1 failed |
| **接頭辞の判定を外す** | **最初は 4 passed（すり抜け）→ テスト追加後 1 failed** |
| restore | 5 passed・baseline とバイト一致 |

## テストはモックを使わず実物のファイルシステム条件で書いた

`os.tmpdir` も `fs.statSync` も **再定義できない**（`Cannot redefine property`）ので、
最初に書いた `vi.spyOn` 版は動かなかった。差し替えではなく**本物の条件**を作った:

| 条件 | 作り方 | Node が出すもの |
|---|---|---|
| レース | dangling symlink | 本物の `ENOENT` |
| レースでない失敗 | 自己参照 symlink | 本物の `ELOOP` |
| temp root の差し替え | `process.env.TMPDIR`（POSIX は呼び出しごとに読む） | — |

`chmod 444` は使えなかった — constructor 自身の `mkdirSync` が先に落ちて **cleanup に到達しない**。

捏造した mock 文言を検証するのは、このプロジェクトが列挙している弱いアサーションの典型なので、
結果的に良い方向へ転んだ。

`npm test` 2,283 passed / 0 failed・lint 緑・`typecheck:e2e` 緑・引用 934 / 0 failed。

Closes #855

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
- [2026-09（前半・09-01〜09-11）](../archive/WORK_LOG_2026-09.md)
