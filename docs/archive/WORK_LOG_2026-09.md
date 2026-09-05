# WORK_LOG Archive — 2026-09（前半）

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

## 2026-09-04: PR #724 追従 — dev 学習サイトをハーネス仕様の改訂に合わせる

**#724（#668 PR-E0）が `docs/testing/E2E_HARNESS_SPEC.md` を改訂した結果、dev 学習サイトの
記述と参照行が古くなった**ので、doc 側だけを追従させた。コード・テストは変更していない。

### 1. IV-3 章の「配線 smoke を置き換える計画」が失効した

`sites/dev/editor/mcp-and-gated-e2e.md` の「次の深掘り候補」に
「2 層構造が gated spec の『配線 smoke』をどう置き換える計画か」という項目が残っていた。
#724 はまさにその記述を削り、**2 層の役割を入れ替えた**（オフライン層 = 回帰の固定 /
実機層 = 語彙・構文表面の網羅）ので、この項目は問いとして成立しなくなった。

- ラチェットの節の末尾に `### ハーネス仕様が実装に追いついた（2026-09-04・#724）` を追加し、
  新旧の役割分担を表で示した。根拠は同章が既に書いていること — **ラチェットが数えているのは
  `readGatedSources()` 経由の実機 spec の語**である
- 「次の深掘り候補」は、#724 §2.1 が残した未決（台帳 2 が #671 段階 3 で導出に変わったあと
  手書き行とラチェットがどうなるか）へ差し替えた
- ja / en 両方を更新。frontmatter の `verified-against` を `c2010db`・`verified-at` を
  `2026-09-04` へ

### 2. 核仕様の行番号が +21 ずれた

#724 は `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` §10 に 21 行を挿入した（`### 🔴 DSL を足したら
E2E も足す`）。`// FILE:START-END` 形式の引用は #724 自身が再アンカーしているが、
**Sources 節の散文の行参照は機械検査の対象外**なので取り残されていた。

| 参照元 | 旧 | 新 | 備考 |
|---|---|---|---|
| `sites/dev/signal-chain/mixer-audio-line.md:885` / en:910 | `1616-1706` | `1667-1757` | Mixer / Routing（MX.1〜MX.5） |
| 同 `:886` / en:911 | `1247-1249` | `1298-1300` | master gain ramp が insert の前 |
| `sites/dev/decisions/adr-002-dsl-v3-pivot.md:279` / en:279 | `1933-1990` | `1983-2035` | §13 Versioning + Migration Notes |
| 同 `:280` / en:280 | `467-601` | `496-631` | §7 underscore prefix |
| 同 `:281` / en:281 | `336-432` | `365-462` | §5 片記号方式 |

🔴 **上表のうち #724 起因のずれは +21 のみ。** 実測すると 5 件とも #724 以前から
31〜35 行ずれており（base `89d6e26` で `1616` は Mixer 節ではなく PC 節の中だった）、
**散文の行参照には機械検査が無い**ことがそのまま残存していた。今回は行番号を足すのではなく、
各行の説明文が名指ししている節の実位置へ**再アンカー**した。


> **これはアーカイブです**（`docs/core/PROJECT_RULES.md` §1a）。
> 現行の作業ログは [`docs/development/WORK_LOG.md`](../development/WORK_LOG.md) にあります。
>
> **収録期間**: 2026-09-01 〜 2026-09-04
> **アーカイブ理由**: 本体が 2,000 行の上限（`tests/docs/worklog-size.spec.ts` が強制）を超えたため。
> **注意**: 番号付きの節（`6.4xx`）は他文書からの参照を壊さないよう**番号のまま**移してあります。

---

### fix(engine): hold the RUN tail timer and align its origin (#606 PR-K-A1) (Sep 4, 2026)

**Issue**: #606 / **ブランチ**: `606-run-termination-noteoff` / **PR-K-A1**（修正部分）

同ブランチの守りのテスト（`run-termination-noteoff.spec.ts`）に続けて、
計画 `IMPLEMENTATION_PLAN_2026-09.md:126` が定める **H1 / H2 の修正**を入れた。
守りのテストだけでは #606 の must-fix は閉じない（鎖は既にあったが、
その鎖を駆動するタイマ自体が 2 つの欠陥を持っていた）。

## 直した 2 つの欠陥

### H2 — 終端タイマの原点が 100 ms ずれていた

イベントは `scheduleTime = currentTime + 100` を原点に積むのに、自動停止タイマは
**「今」から `patternDuration`** で測っていた（`run-sequence.ts`）。停止が約 100 ms 早く来るので、
パターン末尾の note が鳴り切る前に `clearSequenceEventsFn` が走る。

`tailDelay = patternDuration + (scheduleTime - currentTime)` に揃えた。
🔴 **マジックナンバー 100 を 2 箇所に書かない** — `scheduleTime` から導いている。

### H1 — `setTimeout` のハンドルを捨てていた

キャンセルできないので、`RUN()` を再度呼ぶ / `LOOP()` へ切り替える / `global.stop()` すると、
**古いタイマが後から発火して新しく始まった再生を消す**（stale timer）。

ハンドルを既存の per-sequence `StateManager` に保持し（新機構を作らない）、
`run()` / `loop()` / `stop()` の 3 経路でキャンセルする。`setRunTimerFn` は**必須引数**にして、
将来の呼び出し元がハンドルを取り落とすことを型で防いだ。

## テスト

TDD で先に書いて red を確認してから直した（実出力は PR 本文）。

| 検査 | 内容 |
|---|---|
| H2 | `patternDuration` ちょうどでは clear されず、原点ぶんを足した時刻で clear される |
| H1 | 2 回目の `RUN()` / `LOOP()` 切替 / `global.stop()` のいずれでも、1 回目のタイマが
新しい再生を消さない。**`toHaveBeenCalledTimes` と引数まで検証**する |

## 🔴 `clearRunTimer` の分類（main が追加）

`private clearRunTimer()` を足したところ `signal-chain-dispatch.spec.ts` が red になった。
**TypeScript の `private` は実行時に残らない**ので、公開メソッド分類器からは未分類に見える。
内部 API リストへ追加した。

ただし **除外リストへの追加は「主張」にすぎない**（CLAUDE.md が #528 で名指しした事故は
「DSL 語彙であるべきものを除外リストへ誤分類し、テストは緑・実行時だけ壊れる」型）。
そこで**逆向きの実証**を 1 本足した — `kick.clearRunTimer()` が
`Unknown chain method` で弾かれること。**変異検証済み**:
`SEQUENCE_DSL_METHODS` に `clearRunTimer` を足すとこのテストが red になる。

## 検証

`npm test` **2220 passed / 52 skipped / 0 failed**（sandbox 外・main が実行）。
lint / `tsc --noEmit` ともに exit 0。

⚠️ 委譲先（Codex）は sandbox で全件を回せず `tests/core` の緑までしか確認できていなかった。
**上記 1 件の red は main が sandbox 外で回して初めて出た** — CLAUDE.md
「委譲先の green 報告は必ず main が回し直す」の実例がまた 1 件増えた。

---

### test(engine): pin the RUN-termination note-off release (#606 PR-K-A1) (Sep 4, 2026)

**Issue**: #606 / **ブランチ**: `606-run-termination-noteoff` / **PR-K-A1**

#### 🔴 実装は既にあった。足したのは「守り」である

着手前に実装を読んだところ、**発火点も配送機構も揃っていた**
（[[invent-rules-only-after-reading-the-code]] のとおり、規則を発明する前に読む）:

| 層 | 場所 |
|---|---|
| RUN 終端の発火 | `run-sequence.ts:60-63` の `setTimeout(… clearSequenceEventsFn(name) …, patternDuration)` |
| 経路の振り分け | `sequence.ts:1015-1023` `clearEvents()` → MIDI / instrument なら `clearOwner(name)` |
| 実際の note-off | `midi-scheduler.ts:211-214` `clearOwner()` が **`output.releaseOwner(owner)` を呼ぶ** |

つまり #606 の PR-K-A1 は「flush 機構を作る」仕事ではなかった。
地図に「配送機構は既にある・欠けているのは発火点だけ」と書いた（#731）が、
**発火点も既にあった** — さらに一段浅く見積もっていた。

#### ところが、この鎖を検査するテストが 1 本も無かった

`clearOwner()` から `releaseOwner()` の **1 行を落としても既存 2205 件は全部通る**。
**鳴りっぱなしは音にしか出ない**ので、ユニットで守らないと誰も気づけない
（[[consumerless-code-is-unprotected]]）。テスト 4 本を追加した。

#### 🔴 変異検証で穴が 1 つ見つかった（3 本 → 4 本）

| 変異 | 結果 |
|---|---|
| `releaseOwner()` の呼び出しを削除 | **2 件 red** |
| `clearOwner()` の queue フィルタを `this.queue = []`（wildcard 全消し）へ | 🔴 **当初は 3 件とも green（生き残り）** |
| queue のクリアを削除 | **1 件 red** |

**解放（`releaseOwner`）の側は owner を見ていたが、予定（queue）の側は見ていなかった。**
片翼だけ守っていたことになる（[[enumeration-stops-one-level-too-early]]）。
「終端したシーケンスの予定だけが落ちる」を検査する 1 本を足したところ、この変異も red になった。

restore 後 4 件 green・`midi-scheduler.ts` は `cmp` で復元一致。

🔴 **1 種類の変異が red になっただけで結論してはいけない**という規律が、そのまま効いた実例。

#### 粒度（#729 で明文化した条文の実装側）

守っているのは **owner 単位の解放**である。daemon 側の「最後の砦」は
**instance 単位（全 owner）**で、`global.stop()` / shutdown / engine 異常終了の 3 場面だけ。
混同すると他シーケンスの発音を巻き込むので、テストのコメントに書き分けた。

### fix(e2e): clock capture segments off the capture file and open them on sound (#739 PR-O2a) (Sep 4, 2026)

**Issue**: #739 / **ブランチ**: `739-capture-windows-follow-sound` / **PR-O2a**
**設計**: `docs/design/739-capture-clock-design.md`（起案 Fable / 審査 main）

実機 gated E2E の「名前つき区間 RMS」測定器が、**楽器が鳴る前に窓を開けていた**。
#649 PR-O2 の受け入れ（E2E-1）が緑にならない原因は engine ではなく**測定器**だった。

## 直した 2 つの欠陥

1. **固定 settle 400 ms が音より早い。** `LOOP()` の小節量子化（120 BPM 4/4 = 2000 ms）＋
   プラグイン attach で音は約 3 秒後に出る。`unity` 窓は丸ごと無音で、
   **`global.gain(-6)` は楽器が一度も鳴る前に適用されていた**（実測 half/unity = 1.36）
2. **区間マッピングが壁時計からの逆算で、黙ってクランプする。**
   `Math.max(0, durationSec - (stopWall - from)/1000)` は実長が壁時計より短いと
   **ファイル先頭を指す**。settle を 2600 ms にしたら unity が 0.0632 → **0** と悪化した
   （窓を後ろへ動かすと逆に前を測る）

## 採った形

**キャプチャファイルのバイト長を時計にする** — `(stat.size - 44) / (channels × 4) / sampleRate`。
`stopWall` からの逆算を捨てた。「音が出たか」の待ちは**いつ窓を開けてよいか**を決めるだけで、
時計には使わない（header の flush 間隔 1 秒ぶんの不定性を時計に持ち込まないため）。

新規 `tests/e2e/helpers/capture-windows.ts` に A1 / U1 / U2 / U3 を内蔵し、
**5 箇所に複製されていた逆算式**（`run-score.ts` / gated spec の 4 箇所）をすべて置き換えた。

## 🔴 前提の訂正 3 件（一次ソースで確認）

| 当初の想定 | 事実 |
|---|---|
| 複製は 2 箇所 | **5 箇所**。E2E-1 は `run-score.ts` ではなく gated spec 内の別実装を使う |
| 受け入れは「各窓のオンセット数」 | **正弦系（CLAPTestSynth）にオンセットは出ない**。`gate(1)` は note-off が次の note-on と同時刻で連続音。オンセット数は**打楽器 fixture にだけ**意味を持つ |
| √(8/7) は写像の量子化 | **guard の非対称**（`rms` は guard 0.15・`onsets` は guard 0） |

## 🔴 レビューで塞いだ穴（変異で実証）

新しい衛生規則を足したが、**走査対象が写像の新しい住所を含んでいなかった**。
`gated-sources.ts` は `orbitstudio-mcp-gated.spec.ts` と `gated/**` しか見ておらず、
本 PR が写像を移した `helpers/` は対象外だった。

| 実験 | 結果 |
|---|---|
| `capture-windows.ts` に旧逆算式を植える | **green**（見逃す） |
| 対照: 走査対象のファイルに同じ変異 | **red**（規則自体は機能する） |
| `helpers/` を走査範囲に足して再実行 | **red**・違反行を名指し |
| 変異なしで hygiene + coverage | 16 件 green（巻き添えなし） |

🔴 **`gated-sources.ts` 自身の冒頭がこの失敗モードを予告していた** —
「シナリオを別ファイルへ出した瞬間に**衛生検査が新ファイルを見ず、黙って弱くなる**。
red にならないぶん危険で、検査が効いていないことに気づけない」。本 PR がまさにそれをやった。

あわせて、U3（区間の単調・非重複）の例外が**区間名の文字列 `'transition'`** で
表現されていたのを `CaptureSegment.overlapsPrevious` へ移した
（汎用ヘルパーが特定テストの語彙を知っている層の逆転を解消。CLAUDE.md
「不変条件をデータの配置で強制する」）。

## 🔴 実機 gated の収束（main が sandbox 外で 5 回実測）

| ラウンド | 失敗 | 退行 | 原因 |
|---|---|---|---|
| 1 | 23/24 | — | **#747**: worktree のビルド配置が壊れエンジンが起動せず（本 PR とは無関係） |
| 2 | 19/24 | — | main の実行ミス: 存在しない `ORBIT_KEEP_CAPTURES` ディレクトリ |
| 3 | 16/24 | **6** | **時計が 2 つあった**（`stat.size` vs WAV header の申告サイズ） |
| 4 | 12/24 | **2** | **小節量子化の 2 秒**を録り幅が勘定していなかった |
| **5（最終）** | **10/24** | **0** | — |

**baseline（`main`・同一条件）は 12/24。** 最終ラウンドは**退行ゼロ**で baseline より 2 件少ない。
残る 10 件はすべて baseline から存在するもの（`#643 E2E-1〜7` ほか）で、次の PR-O2（#649）の対象。

⚠️ 「減った 2 件」はプラグイン state 復元系で、ラウンド 4 でも同じ 2 件が差分に出ている。
**本 PR が直したというより flaky の可能性が高い。** 確実に言えるのは**退行ゼロ**の方。

### ラウンド 3 で塞いだもの — 時間軸の統一

`analyzeWavBuffer` は **header が申告する data サイズを優先**する
（`wav-analysis.ts:106`・0 か範囲外のときだけ EOF まで読む）。一方 `sync_header` は固定
96,000 interleaved samples ごと（48 kHz stereo なら約 1 秒、mono なら約 2 秒）にしか
patch しない。つまり区間は「`stat.size` 時間」で刻まれ、
バケットは「header 時間」で並んでいた（実測の差は 0.256 / 0.939 / 0.299 秒）。

解析の直前に申告サイズを 0 に上書きして EOF まで読ませ、**2 つの時間軸を構成的に一致させた**
（`readCaptureForAnalysis`）。許容値を緩める直し方は採らない — 緩めると末尾の区間が
黙って解析範囲から外れる。

### ラウンド 4 で塞いだもの — 小節量子化

残った 2 件（O0-3 / O0-4）は snap のバグに見えたが、キャプチャを解析すると
**2.000 秒ちょうどの無音**が区間の頭にあった:

```
onsets 8.06 →（2.000 s の無音）→ 10.06 10.56 11.06 … 13.06
```

`LOOP()` の**小節量子化**（120 BPM 4/4 = 2000 ms）で、O0-3 / O0-4 だけが演奏中に
`send` / `effect` を足すため発生する。録り幅を `小節 + 位相 + n·P + guard + snap 余裕` の式に直した
（PR 前 4000 → 6840 ms。4800 ms はラウンド 3 途中の値）。**snap は最初の onset から厳密に
`n·P` を測るので golden の値は動かない。**

### ついでに塞いだもの

`prepareCapturePath` — capture を書く直前にディレクトリを作り、前回の残骸を消す。
ディレクトリが無いと daemon の `File::create` が失敗し、テスト側には
「daemon-backed REPL ready after 30000ms」という**無関係に見えるタイムアウト**として現れる
（ラウンド 2 でこれに実機 1 回分を費やした）。変異検証済み。

## 検証

`npm test` **2226 passed / 52 skipped / 0 failed**（sandbox 外・main が実行）。
`typecheck:e2e` / lint ともに exit 0。`check-citations` **926 verified / 0 failed**
（本 PR で `tests/` の行が動いたため 12 箇所を再アンカーし、`captureInstrumentScenario` から
`capture-windows.ts` へ移動した引用を貼り直し、**逆算を説明していた本文も現状に合わせた**）。

---

### fix(studio): declare untrusted-workspace capability (#385 PR-S-T1) (Sep 4, 2026)

**Issue**: #385 / **ブランチ**: `385-untrusted-workspace-capability` / **PR-S-T1**

フォルダ無しの loose-file 起動（`orbs file.orbs`）は**未信頼の ad-hoc workspace** を作る。
`capabilities.untrustedWorkspaces` を宣言していない拡張はそこで activate されず、
利用者には「何も起きない」ようにしか見える。**実害は拒否ではなく沈黙**である。

owner 裁定（`docs/design/656-release-design.md` §16 (1)・2026-09-03）は **`supported: true`**
「一般的な DAW の挙動に併せて」。`"limited"` は撤回済みなので `startEngine()` に trust ガードは置かない。

#### 🔴 レビューで自分のテストが「何も証明していない」と分かった（2 段階）

**① ユニット側**: `restrictedConfigurations` を `?? []` でフォールバックしていたため、
**宣言が丸ごと消えても `for...of []` が 0 周して green** になっていた。
フォールバックを外し、取り出せない形なら**その場で落とす**ようにした。変異で実証:

| 変異 | 旧 | 新 |
|---|---|---|
| `restrictedConfigurations` を削除 | 2 件**素通り** | **3 件 red** |
| `audioDevice` を restricted に追加 | — | **2 件 red** |
| `supported: false` | — | **1 件 red** |

restore 後 6 件 green・`package.json` は `cmp` で復元一致。

**② E2E 側（本 PR では出さない・**#735** へ切り出し）**: 正本計画は PR-S-T1 に
**E2E-D1（実機）**を課している。書いて実機で回したところ **dev モードでは緑になったが、
`capabilities` ブロックを丸ごと削除しても緑のまま**だった。
🔴 **`--extensionDevelopmentPath` は workspace trust の制限を迂回する**ためで、
設計が `ORBIT_GATED_EXT_MODE=installed` を要求していた理由が実験で裏付けられた。

installed モード（vsix を焼いて `--install-extension`）に切り替えると、
**導入は成功するのに拡張が activate しない**（trust を無効にしても同じなので trust は原因ではない）。
ここは #385 の症状とは別の観測性の問題なので **#735** へ切り出した。6 実験の結果はそちらに残してある。

**副産物**: `orbs --install-extension` は**失敗しても exit 0 を返す**（壊れた vsix で
「Failed Installing Extensions」を出しながら 0）。exit code で判定してはいけない。

#### 🔴 地図だけでなく設計と実装プランにも反映した（owner 指摘）

> 地図だけでなく設計と実装プランにも反映してあるかな？？

最初は `DEVELOPMENT_MAP.md` §4.J しか直しておらず、**この PR 自身が #727 で直したばかりの型**
（規範を変えたのに写しが古い）を繰り返すところだった。3 文書を揃えた:

| 文書 | 直した内容 |
|---|---|
| `DEVELOPMENT_MAP.md` §4.J | #385（宣言・✅ 済）と **#735（実機検証・未着手）**の 2 行に分離。#735 は **#659 の後** |
| `656-release-design.md` §12 | **E2E-D1 の期待値を反転**（`running: true` / 音が出る / `not trusted` は 0 行）。**E2E-D2 は取り消し線 + 理由**（裁定 (1) で trust の有無が挙動を変えなくなり D1 と同判定になるため）。**§12.1 を新設**して 6 実験の結果と「成果物なしで成立する」の訂正を記録 |
| `IMPLEMENTATION_PLAN_2026-09.md` §1.9 | PR-S-T1 の件名から **`and refuse loudly` を削除**・`extension.ts` を触るファイルから除外（裁定 (1) で trust ガードが不要になり「断る」対象が無い）。実機 E2E を **PR-S-T3（#735）**として新規行に分離 |

**「issue を立てた」だけでは追跡されない。** 地図は所在、設計は判定条件、計画は工数と順序を持つので、
1 つでも古いままだと次の起案者がそこを読んで誤る。

#### reuse: マニフェスト読み取りを共有ヘルパーへ

`playhead.spec.ts:211` が既に同じ `package.json` を**別の書き方**（`new URL(…, import.meta.url)`）で
読んでいた。`tests/helpers/vscode-extension-manifest.ts` を新設し、**両方をそこへ寄せた**
（新設だけして重複を残すと 1 箇所が 3 箇所になる）。`playhead.spec.ts` 33 件は通ったまま。

#### 検証

`npm run typecheck:e2e` 0 / `tests/vscode-extension/` **430 passed** / lint 0。

---

### docs(planning): schedule the capture-window fix as PR-O2a (#739) (Sep 4, 2026)

**Issue**: #739 / owner 相談 2026-09-04「**忘れてしまうことだけは避けたい**」

PR-O2 の実機検証で見つけた**測定器そのものの欠陥**を、予定に組み込んだ。

#### 何が壊れていたか

`captureSegment` の既定は **settle 400 ms**（`run-score.ts:272`）。ところが
`LOOP()` の**小節量子化**（120 BPM 4/4 = 2000 ms）＋ **プラグインの attach 時間**で、
**音が出るのは約 3 秒後**。キャプチャの時系列 RMS を直接見て確定した:

```
0.00–3.00s  0.0000   ← 完全な無音
3.00s       0.1195   ← ここで初めて音が出る
3.75–5.00s  0.0886   ← 定常
```

🔴 **`global.gain(-6)` は楽器が一度も音を出す前に適用されていた。**
`unity` 窓は丸ごと無音・`half` 窓だけが実音 → **E2E-1 は「0 dB の音」を一度も測っていない**。
比が 1.36（下げたのに大きい）になり、**engine の欠陥に見えていた**。

#### 🔴 固定値で追いかける修正は反証済み

settle を 400 → 2600 ms にしたら unity が **0.0632 → 0** と**悪化**した。
区間が**キャプチャ末尾からの逆算**なので、実長が壁時計より短いと `fromSec` が負 → 0 クランプ →
**ファイル先頭（まだ鳴っていない区間）**を指す。**窓を後ろへ動かすと逆に前を測る。**

#### いつやるか — **PR-O2 の直前**（縦依存を伸ばす）

`PR-O1 → PR-O0 → **PR-O2a（#739）** → PR-O2`

| 理由 | |
|---|---|
| **循環しない** | 受け入れを「**窓に入るオンセット数**」にすれば、instrument が鳴っていなくても判定できる。「E2E-1 が緑」を受け入れにしない |
| **PR-O0 → PR-O2 と同じ規律** | 段 1 は「golden で固定してから engine を変える」。今回も**測定器を直してから測る** |
| **段 2 前でないと高くつく** | 影響は gated spec の **34 箇所**。段 2 の束は全部この窓で assert するので、計器が不確かなまま始めると全測定を疑い直すことになる |

#### 記録先

| 文書 | 内容 |
|---|---|
| **#739** | 実測データ・反証した修正・実装チェックリスト |
| `DEVELOPMENT_MAP.md` §4.A | 「測定器」の行を #649 の**上**に置いた（順序が読める形） |
| `IMPLEMENTATION_PLAN_2026-09.md` §1.1 | **PR-O2a** を PR-O2 の直前に挿入 |

---

### docs(site): follow PR #727's output-line spec revision into the user site and SC-2 (Sep 4, 2026)

**追従元**: PR [#727](https://github.com/signalcompose/orbitscore/pull/727)（`611-output-line-spec` → main・マージコミット `d8191d1`）/ **ブランチ**: `claude/docs-sync-pr727`

#727 は spec だけを動かした docs-only PR で、`sites/dev/signal-chain/` の 2 章（日英）は
同じ PR の中で追従済みだった。**追従が漏れていたのは「ユーザーが書く語」の側**である。

#### 直したもの

| 場所 | 追従した規範 |
|---|---|
| `sites/user/mixing/routing.md`（日英） | MX.3: `send()` の第 2 引数が **dB になる**（`0.3` → +0.3 dB のサイレント変更）/ MX.5 から「post-fader 固定」が**削除**され、タップ位置は「書いた位置」になった |
| `sites/user/reference/methods.md`（日英） | 同上 + MX.2.3: **数値レンダーバス `seq.output(n)` は撤回**された |
| `sites/dev/signal-chain/mixer-audio-line.md`（日英） | 「`seq.output()` の 3 分岐」節に MX.2.3（数値分岐の撤回）と MX.2.1（LinkAudio は解決順の**最後**）の注記 |
| `sites/dev/decisions/adr-002-dsl-v3-pivot.md`（日英） | core spec への行番号引用 2 件を再アンカー（`1933-1990` → `2112-2164`・`467-601` → `496-631`） |

🔴 **実装は 1 行も変わっていない**ので、user site の表と本文は**今日の書き方のまま**にして、
「仕様は変わったが未実装」という注記を足す形にした。表を到達点で書き換えると、
読者が今日書けないコードを読むことになる。

🔴 **`send` の単位変更はエラーにならず音だけが変わる**（線形 0.3 → +0.3 dB ≒ 素通し）。
user site の両言語に `danger` ブロックで明示した。

#### 再アンカーについての但し書き

adr-002 の 2 件は **#727 以前から既にずれていた**（§13 Versioning は #727 前も 1983 行目で、
引用は 1933-1990 だった）。#727 が core spec を +63 行伸ばしてずれが広がったので、
この機会に両方を現在の節境界へ合わせた。3 件目の `336-432`（§5 = 315-468）は
節の内側の抜粋なので触っていない。

#### 検証

`npm ci` / `npm run docs:build -w @orbitscore/user-site` / `npm run docs:build -w @orbitscore/dev-site` /
`npm run docs:check` の 4 本すべて green（citation 922 件検証・0 failed）。

### fix(engine): contain the two playback-path throws (#645 PR-D0) (Sep 4, 2026)

**Issue**: #645 / **ブランチ**: `645-contain-playback-throws` / **PR-D0**

`LOOP()` 経路の throw 2 箇所を封じ、スキップをログに出す。ライブ中に kick が止まる実害の修正。
実装は `sequence.ts` の `DispatchTarget = hardware | link | skip` の tagged union +
`resolveDispatchChannel()`（throw しない）+ `logSkipOnce`。ユニット **13 本**。

#### 🔴 「ログ行が一切出ない」は誤りだった（実機 4 サイクル分の記録を訂正）

前回までの記録は「`d645Skip` のログ行が**一行も出ない**」としていた。診断を出して実測したところ、
**出ていた**:

```
… このシーケンスは無音でスキップします。      ← ✅ skip は記録されている
🔄 d645Skip (loop queued, +1998ms to next quantize boundary)
⏹ d645Skip (loop stopped)                      ← 停止する
🎚️ d645Live: gain=-3 dB (seamless)             ← ✅ 兄弟は生きている
```

**PR-D0 が守るべき性質は 3 つとも満たされている**:

| 性質 | 実測 |
|---|---|
| skip が黙って消えない | ✅ 「無音でスキップします」がログに出る |
| throw しない | ✅ 同一ブロックの `d645Live` が自分の `(seamless)` を出している |
| 兄弟を巻き添えにしない | ✅ 同上 |

🔴 **「ログが出ない」と 4 サイクル書き続けたのは、診断を出さずに症状だけを見ていたから。**
[[escalation-does-not-fix-opacity]] のとおり、見えない時は観測手段を先に作る。

#### 落ちていたのは**テストの主張が実装の契約を超えていた**箇所（→ #736）

| # | 主張 | 実装の契約 |
|---|---|---|
| 1 | 停止中の `d645Skip` にも `(seamless)` が出る | `seamlessParameterUpdate()` は `isLooping() \|\| isPlaying()` **かつ** `scheduler.isRunning && loopStartTime !== undefined` の時だけ出す（`sequence.ts:278-281`）。**停止中は出ない** |
| 2 | dedup を **ERROR 総数**で数える | skip は **stderr → ERROR に分類される**（#625 で 4 回再発した系譜）ので**他の ERROR が混ざり、dedup の証明にならない**。数えるなら skip メッセージの出現回数 |

**実機 gated は #736 へ分離**（owner 裁定 2026-09-04）。外した理由を spec 内のコメントに残したので、
次に読む人が「E2E を書き忘れた」と誤読しない。

#### 3 文書に反映

| 文書 | 内容 |
|---|---|
| `DEVELOPMENT_MAP.md` §4.A | #645（実装・✅）と **#736（実機 E2E の主張・未解決）**の 2 行に分離 |
| `IMPLEMENTATION_PLAN_2026-09.md` §1.7 | PR-D0 の検証列を「ユニット 13 本」に。**PR-D1（#736）**を新規行に |

#### 検証

`npm test` **2205 passed** / `npm run typecheck:e2e` 0 / lint 0 /
`check-citations` 922 verified 0 failed。

---

### docs(spec): fix the implicit-master condition found by the independent re-audit (Sep 4, 2026)

**Issue**: #611 / **ブランチ**: `611-output-line-spec` / **PR-O1**（段 1 の縦依存 1 本目）

修正コミット後の最終状態だけを**独立に**再監査させた（前回の監査結果は渡していない）。
**Critical が 1 件出た** — 1 回目の監査が見ていなかったものである。

#### 🔴 Critical: send を書くと本流が master へ届かない条件になっていた

仕様の 2 箇所が、単独では正しいのに**組み合わせると壊れる**形になっていた:

| 場所 | 記述 |
|---|---|
| MX.2 | ラインに **`output` が 1 つも無い** sequence に暗黙の `output(master, thru:false, db:0)` を付ける |
| MX.3 | **`send` は `output(aux, thru: true, db:)` の糖衣**である |

`kick.send(verb, -12)` **だけ**を書いた行は、後者により「`output` が 1 つ存在する」ので
**暗黙 master が付かない**。`thru: true` の出口は分岐であって終端ではないから、
**dry がどこにも行き着かない** — センドを挿した瞬間に本流が消える。
MX.3 の実例そのものがこの 1 行だった。

正しい条件は「**`thru: false` の `output`（＝終端）が 1 つも無い**」。
設計 611 §2.6 の既定ストリップが
`[ラック → gain → pan → sends(=output thru) → output(master)]` と
**sends と終端を別々に並べている**のが意図の正本で、条件の側が書き間違っていた。
core spec MX.2 / 設計 611 §2.1 / 同 §3.4 の 3 箇所を揃えた。

🔴 **糖衣を定義したら、その糖衣が既存の条件式に何を代入するかを確かめる。**
「`send` は `output` の糖衣」と「`output` が無ければ master」は、
どちらも単独では正しく、**並べた時にだけ壊れる**。

#### 併せて直した 4 件（いずれも「規範を変えたのに写しが古い」型）

| # | 場所 | 内容 |
|---|---|---|
| 1 | `SIGNAL_CHAIN_DSL_SPEC_v1.md:30,144-145` | **同一ファイル内**のコード例が「宣言層・後勝ち」のまま。直下の規範 (2) は「信号層・2 要素として加算」に書き換え済みで、例と規範が逆を言っていた |
| 2 | `sites/dev/signal-chain/index.md`（日英） | 二層意味論の表が旧版のまま（gain / pan / 出力先を宣言層に置いていた）。`mixer-audio-line.md` は両言語で直したのに、**同じ章の index が漏れた**。🔴 `check-citations` はコードフェンス引用しか見ないので、**散文の陳腐化は機械では捕まらない** |
| 3 | `docs/design/610-diagnostics-applicability-design.md:455,463,611` | 「`output(<aux 名>)` は Error」と owner 裁定 ③（**aux も `output` で指せる**）が**正反対**。特に **E2E-D6 は期待値が仕様と逆**で、そのまま実装すると誤ったテストが資産に積まれるところだった |
| 4 | `docs/design/611-output-line-design.md:248,276` | §14 (1) で「数値 render bus は撤回」と裁定したのに、§3.3 手順 5 が「裁定まで現状の `_renderBus` 互換」のまま残っていた（自分の裁定に自分が追従していない） |

#### 独立再監査の価値（記録）

1 回目の監査後に修正を入れ、**その結果だけを見せて**別個体に監査させたところ、
1 回目が見ていなかった Critical が出た。**同じ差分を 2 回見るのではなく、
修正後の状態を新しい目で見る**ことに意味があった。

#### 検証

`check-citations.mjs` 922 verified / 0 failed（行番号のずれを `--fix` で再アンカー・4 件）。

---

### docs(spec): output as a line element — MX.1/2/2.1/2.2/2.3/3/4/5, SC.2.1/4, #649 §10-12 (Sep 4, 2026)

**Issue**: #611（+ #649 / #643 の設計文書追従）/ **ブランチ**: `611-output-line-spec` / **PR-O1**（段 1 の前提・docs のみ）

段 1（must-fix）の縦依存 `PR-O1（spec）→ PR-O0（golden）→ PR-O2（engine）` の 1 本目。
**仕様を先に確定させてから golden を取り、その後にエンジンの内部を変える**という順序を守るための PR。
コード・テストは 1 行も変更していない。

#### 改訂（`docs/design/611-output-line-design.md` §11 の表がスコープ）

| 文書 | 箇所 | 内容 |
|---|---|---|
| `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` | 節ヘッダ / MX.1 | 固定トポロジ（source → insert → sum → master ＋ send → aux の並列タップ）を撤回し、**ラインは 4 種の要素の列**（ラック / ゲイン / パン / 出口）と定義。「フェーダーという段は存在しない」を明記 |
| 同 | **MX.2**（全面改稿）| `output(destination, thru:, db:)`。`thru:` 既定 `false`・`db:` は dB・出口はラインの 1 要素であって終端ではない |
| 同 | **MX.2.1**（新）| 宛先の集合（master / sum / aux / 物理 ch 対 / render / LinkAudio）と**名前解決の順序**。`"master"` 予約語 |
| 同 | **MX.2.2**（新）| 複数 `output` と合算規則（解決後の宛先が同じなら加算・同一宛先 2 回は 2 要素） |
| 同 | **MX.2.3**（旧 MX.2.1 を置換）| 数値 render bus `output(n)` の**撤回**（裁定 611 §14 (1) = A）。宛先は `mix.render(...)` の宣言ノード。`mix.output(3)` は物理アウト mono 宛て |
| 同 | MX.3 | `send(name, db)`。**単位を線形 `amount` から dB へ**・`output(aux, thru: true, db:)` の糖衣であることを明記・「post-fader 固定」を削除 |
| 同 | MX.4 | 固定トポロジの記述を **forward-only + 配列順 = トポロジカル順**へ。kind による制限（sum→sum 等）を設けない |
| 同 | MX.5 | v1 制約から「send は post-fader 固定」を削除 |
| 同 | §8.1.2 | 🔴 `output("master")` は **LinkAudio channel 名にならない**（予約語が解決順の先頭）ことを追記 |
| `docs/specs-v2/SIGNAL_CHAIN_DSL_SPEC_v1.md` | SC.2.1 規範 (4)(7) | **出力エンドポイントと master もレシーバ**（`master.output(cue, thru: true)`）。`master` 予約が `output()` の文字列宛先にも及ぶ |
| 同 | SC.4 規範 (1) + staging 注記 | aux 名メソッドの値は **dB**。`send` は `thru: true` の出口の糖衣。「v1 は post-insert 固定」注記を #611 PR-O3/O4 の staging へ差し替え |
| `docs/design/649-audio-line-design.md` | §7.3 / §10 / §10.1 / §10.4 / §11 / §12 | **§10〜§12 は 611 設計へ移管**（バナー）。各項に「611 での扱い（正本）」を併記 |
| `docs/design/643-mixer-foundation-design.md` | §1.5 / §12 | 出口の欠落が #611 で埋まったことを追記。`output()` 3 分岐は解決順 1 本に統合された |

#### 🔴 設計文書の内部矛盾を 1 件解消（doc 611）

§1 と §2.6 が「`pan` は発音側のまま」と書いたままだったが、**§2.4b と §14 (4) の owner 裁定（Q-611-4 = B）で
`pan` はライン要素に覆っていた**。起案時の記述が裁定に追従していなかったもので、裁定側に揃えた
（ライン要素は 3 種ではなく **4 種**）。PR-O4 の実装者がここを読んで誤るのを防ぐため。

#### dev 学習サイトの追従（同 PR に畳んだ）

`sites/dev/signal-chain/mixer-audio-line.md` と `sites/dev/en/signal-chain/mixer-audio-line.md` が
**core spec の実例ブロックを逐語引用**していたため、`check-citations.mjs` が 4 件 red になった。

- 引用の再アンカー（`:1681-1685` → `:1729-1733` / `:1733-1735` → `:1793-1795`）
- **中身が変わった引用は手で直した**: `kick.send("rev", 0.3)` → `kick.send(verb, -12)`
- 散文の事実誤りを訂正: 「MX.5 は send は post-fader 固定を明記しています」は**もう spec に無い**。
  ⚠️ **実装は今も post-insert 固定**なので、「spec は変わったが実装は PR-O4 まで変わらない」ことを
  両ページに明示した（引用検査は散文を見ないので、ここは人が見るしかない）

**spec 側で宣言形の実例を復元**した（改稿で `global.sum("drum")` の例が落ちていた）。
素朴な 1 ファイル経路（ノード変数を作らない書き方）の保護は恒久方針なので、実例は仕様に要る。

#### user 学習サイトは変更しない

`sites/user/mixing/routing.md` の「send は post-fader 固定です」は**現在の実装の事実**であり、
挙動が変わるのは PR-O4。user docs は「今できること」を書く場所なので、そこで追従させる。

#### Fable 監査（独立第二意見）で Important 4 件・Medium 2 件を修正

監査は「① §11 改訂表の不在証明 ② owner 裁定との整合 ③ 実装との乖離の表示」の 3 問。
**指摘はすべて main が一次ソースで裏取りしてから直した**（エージェントの報告を鵜呑みにしない）。

| # | 指摘 | 裏取り | 対処 |
|---|---|---|---|
| 1 | 「sum ネスト不可」（MX.2.2 / MX.5）が MX.4「kind で制限しない」と真逆 | `engine_wrap.rs:5809-5813` に kind 検証が実在し、**コメントが MX.4 を出典として引用**していた | 規範（到達点）と v1 制約（今日）を**併記**。MX.4 に現在地注記を追加 |
| 2 | **SC.1 の二層意味論が MX.1 と正反対**（`gain` / `pan` / 出力先が宣言層・可換・後勝ち）。SC.4 (2) も「後勝ち」 | 差分を読んで確認。doc 611 §11 の改訂表に **SC.1 が入っていなかった**（列挙漏れ） | SC.1 の表と規範 (2) を書き換え、`gain` / `pan` / 出口を**信号層**へ。SC.4 (2) も追従 |
| 3 | 🔴 「`output("master")` は実装済み」という現在地注記が**誤り** | `sequence.ts:405-413` は sum にも render にも一致しない名前を **LinkAudio channel として記録**する。既存契約 `tests/core/sequence-output.spec.ts:167-179` を実行して確認（27 passed） | 予約語が実在するのは **wire（`SetBusRouting`）だけ**で、DSL 側で届くのは `.master` 糖衣のみ、と書き直した |
| 4 | MX.2.1 の「sum への出力先指定を**解除**して master へ戻す」は旧 `SetBusRouting` の部分適用の意味論で、MX.2.2「2 要素として両方加算」と矛盾 | `engine_wrap.rs:5766-5771` が部分適用（三状態）の出典 | 規範は「宛先 master へ解決」に統一し、「解除」は v1 の現在地へ隔離 |
| 5 | mono マージ係数 `(L + R) * 0.5` は **owner 裁定に無い**（裁定は「片側を捨てずマージ」まで） | doc 611 §14 (5) の原文を確認 | 規範表から係数を外し、設計文書（611 §5.3）へ委ねた |
| 6 | MX.2.3「撤回」に現在地注記が無く「今は数値形が拒否される」と誤読しうる | `sequence.ts:373-400` は `output(1)` を**受理して記録**する。`runtime.ts:245-250` は `mix.output(3)` を throw | 現在地注記を追加。追従していない 2 文書（PH 節の表・`MULTICHANNEL_RENDERING_DESIGN_598.md` §4.4）は **PR-R0** の担当として明記 |

Low の指摘（`gain` / `pan` 節が未追従・`_line` という TS の private 識別子が規範文に露出・
SC.0 の `.verb(0.3)` が dB 化後は「+0.3 dB ≒ 素通し」の例になる・SC.7 の「send の amount」・
`:1309` の「pre/post-fader tap」・doc 611 §0 裁定 4 の参照先誤記）も同時に処理した。

**レビュー方法**: 監査の推奨に従い `/code:pr-review-team` のフル編成は回さない
（差分にコードが無く、Sonnet チームの強み = 変異実走・実行接地が**実行対象を持たない**。
本 PR の失敗クラスは「spec と spec の不整合」「現在地注記の誤り」で、いずれも**差分に無いもの**を
読んで初めて見える）。plan §1.1 も PR-O1 の検証を「docs のみ（advisor レビュー）」と定めている。

#### 実機 gated baseline を実測（段 1 の受け入れ判定の起点）

**`npm run test:e2e:gated` → 10 failed / 10 passed (20)**・355.89s。

🔴 **WORK_LOG #713 の baseline（11 failed）から 1 件減っている** —
`auto-records and restores all five plugin receiver kinds across a restart without explicit saves`
が段 0 の束（#722）のマージで **failed → passed** になった。
したがって**本セッションの baseline は 10 failed** であり、#713 の値をそのまま使ってはいけない。

失敗 10 件（段 1 が減らす対象）: `drives real OrbitStudio end-to-end` /
**#643 E2E-1〜E2E-7**（7 件）/ `steps the live playhead through an instrument() sequence` /
`replaces a playing instrument across CLAP/VST3 (#618 E1-E6)`。

**この PR は docs のみなので、この 10 件を 1 件も動かさない**（動かすのは PR-O2 から）。

#### WORK_LOG のローテーション（本 PR の副産物）

本節を足したことで WORK_LOG が **2009 行**になり、`tests/docs/worklog-size.spec.ts`
（PROJECT_RULES §1a・上限 2000 行）が red になった。**閾値は上げずにアーカイブした**:
2026-09-01〜09-02 の 9 節（389 行）を `docs/archive/WORK_LOG_2026-09.md` へ移し、
本体末尾の索引と `docs/core/INDEX.md` の「Archived WORK_LOG」表の**両方**を更新した
（§1a の注記どおり、テストが突合するのは本体末尾の索引だけで INDEX.md は検査されない）。
番号付きの節（`6.423`〜`6.429`）は他文書からの参照を壊さないよう**番号のまま**移した。

#### 検証

| ゲート | 結果 |
|---|---|
| `npm test` | **2196 passed** / 48 skipped（main と同数・docs のみなので不変が期待値） |
| `npm run typecheck:e2e` | エラー 0 |
| `check-citations.mjs` | **922 verified / 0 failed**（監査対応で行番号が再び動いたので再アンカー） |

実機 E2E は**このPRの対象外**（コード変更が無く、DSL の観測可能な表面を 1 つも足していない）。
段 1 で実機の判定が変わるのは PR-O2 から。

---

### test(e2e): capture goldens for existing scores (#543-a) (Sep 4, 2026)

**Issue**: #543 (a) / **ブランチ**: `543-output-line-goldens` / **PR-O0**（段 1 の縦依存 2 本目）

PR-O2 が engine の内部幅と master gain の位置を変える**前**に、
`docs/design/611-output-line-design.md` §9 の「今日の音」を実機 capture で固定する。
production code は 1 行も変更していない。

実装は Codex（`gpt-5.6-sol` / effort high）に委譲し、**測定と検証は main が実機で**行った
（sandbox では daemon・MCP・実機 E2E が原理的に走らないため）。

#### 🔴 実機で 3 件の問題が出て、いずれも「主張をテストの実力に合わせる」方向で解決した

##### 1. ハーネスの起動判定が 500 行窓で壊れていた（helper の潜在不具合）

O0-3 / O0-4 が `daemon-backed REPL ready after 30000ms` で落ちた。engine は起動していた。
原因は `run-score.ts` が **`get_log` の固定 500 行窓の中でマーカー件数の増加**を見ていたこと。
窓が飽和すると新しい行を足しても**古いマーカーが同時に押し出される**ので件数が増えない。
**ERROR 件数を厳密等価で見ない規律と同じ理由**である。段 0 の helper に消費者が付いて初めて露見した。

修正: **`start_engine` 直前のログ末尾を錨**にし、その後ろに出た分だけを見る。

🔴 **一度「錨が流れたら判定できないとして待つ」形にしたのは誤りで `#628 R28` を壊した。**
錨は前の窓の**末尾**から取り、窓は**先頭から**落ちるので、末尾が消えているならそれより古い行は
すべて消えている — つまり今の窓は全部が新しい出力である。**実機に出さなければ気づかなかった。**
`helpers.spec.ts` にテスト 6 本。「錨を完全に無視する」変異で 2 本 red・restore 一致を確認した。

##### 2. fixture のバス名が既存テストと衝突していた

gated スイートは**同じ engine セッションを使い回す**ので、`global.sum("drum")` が既存テスト
（`:1955-1956` が `drum` を **sum と aux の両方**で宣言）と衝突して「ambiguous」になる。
**衝突したまま録ると、音が意図した宛先へ行かないのに golden が録れてしまう。**
`o0sum611` / `o0rev611` へ改名した。

##### 3. 🔴 最初の測定は「音量」ではなく「窓に入ったヒット数」を測っていた

**当初「設計 §9 の期待式が実機と合わなかった」と結論したが、誤りだった**（Fable 監査で判明）。
`LOOP()` は既定で**次の小節境界まで待つ**（`quantize-manager.ts:70`・120 BPM 4/4 で 2000 ms）のに、
録り始めが `run_selection` の **500 ms 後**だったので、**窓の大半が発音前の無音**だった。
入るヒット数が窓ごとに違い（dry 3 発 / total 5 発）、その差を engine の性質だと読み違えた。
検算: `kick.wav`（エネルギー 0.00757189）から、当初の 4 つの golden はすべて
`sqrt(整数ヒット数 × 0.00378595 / 窓長)` と**有効 7 桁で一致**する。`send(0.3)` は線形 0.3、
`Gain(db:6)` は理論と 9 桁一致で、**どちらの式も成立していた**。

🔴 **測定手法の欠陥を engine の性質だと結論した。** 「未検証のモデルを assert しない」という方針は
正しいが、適用を誤ると**検証済みの一次ソースを「未検証」と呼ぶ**ことになる。

**直した形**: settle を 1 小節 + 余裕（2600 ms）にして定常状態で録る / 窓長を**ヒット周期の
整数倍**（500 ms × 8）にして位相依存を消す / 🔴 **`onsets(name).length` を assert** して
ヒット数を固定する（これで初めて RMS が「1 ヒットあたりの音量」になる）。

##### 4. 🔴 同じ誤りを 2 度した — 窓長のゆらぎを「`seq.gain` の系統差」と読んだ

測り方を直した後、`Gain(db: 6)` は理論と**有効 9 桁で一致**したのに `combined/dry` だけが
**1.069**（理論 1.0 から 6.9%）で、**2 回の実行が 5 桁一致**した。これを
「`seq.gain(-6)` は実は −5.42 dB」と結論しかけたが、**3 回目を回して全行の比を並べたら撤回した**。

**同じ 1.069 = √(8/7) が `noBus` にも `sumOutput` にも `effectOnly/dry` にも出る。**
窓の実効長が 1 ヒット分（500 ms / 4000 ms = 1/8）ゆらぐ測定アーチファクトで、
セグメントごとに独立に乗る。**系統差とは区別できない。**

🔴 **再現性は系統差の証拠にならない** — 測定系の量子化も再現する。系統差だと言うには
「**同じアーチファクトが他の行に出ていないこと**」の確認が要る。期待値は理論式のままにし、
許容をアーチファクトの幅（12%）に合わせた。**実測値をベタ書きすると、アーチファクトを
engine の性質として固定してしまう。** follow-up（本 PR の範囲外）: 窓を 16 発へ伸ばすか、
`runScore` の区間→capture 時刻の写像から量子化を取る。

#### `/simplify`（4 観点のレビュー → 適用）

🔴 **reuse / altitude**: `startR28Engine`（gated spec）が**同じ壊れた件数比較をローカルに再実装**して
おり、**既存 20 本すべてがこの経路を使う**。判定を錨方式へ統一し `markerCount` を削除した。
**simplification**: 動的 `import()` → 静的 import・harness を縮小 / `relativeDelta` を 1 本化。
⏭️ **スキップ**: engine 再起動 3→1 の統合（テスト単位の独立を優先）。

🔴 **`startR28Engine` はレビューの推奨と逆の判断をした。** altitude は現状維持を支持したが、
その理由は「**最初の消費者が付く時に寄せる**」であり、**その消費者が本 PR で付いた**。
当時は両方とも壊れていたが、いまは**片方だけ直っている**。見送られたのは「約 60 行の統合」で、
ここで直したのは**判定ロジックだけ**（構造は動かしていない）。

#### 検証（すべて main が実機で）

`npm test` **2202 passed** / 52 skipped ・ `typecheck:e2e` 0 ・ `lint` 0 ・
`check-citations.mjs` **922 verified / 0 failed** ・ **実機 gated 24 件中 13 passed / 11 failed**
（**O0-1〜O0-4 は 4 本とも green**）。

失敗 11 件 = 🔴 **baseline 10 件**（`drives real OrbitStudio end-to-end` / `#643 E2E-1〜E2E-7` /
`steps the live playhead` / `#618 E1-E6`）**+ plugin-state restore 系 1 件**。restore 系は実行ごとに
**別のテストが落ちる**（5 回の実行で `auto-records…` と `restores a non-default sum-bus insert…`
が入れ替わった）。本 PR は restore を触っていないので既存の不安定さと考えるが、**裏取りはしていない**。
途中、起動判定の誤った修正で `#628 R28` を落としたが、訂正後は baseline どおり passed に戻っている。

### docs(spec): add RUN termination and offline render to the note-off firing cases (Sep 4, 2026)

**Issue**: #606（`must-fix`）/ **ブランチ**: `606-noteoff-firing-spec` / **PR-K-A0**（spec 先行）

`docs/design/634-pdc-layer-instrument-rack-design.md` §3 の実装（PR-K-A1 / A2）に入る前に、
**note-off の発火点**を仕様側で確定させる。コードは 1 行も変更していない。

#### 🔴 「flush が無い」は誤り — 配送機構は在る

地図 §4.B の記述は誤りで、`run-sequence.ts → sequence.ts → midi-scheduler.ts → plugin-note-output.ts`
の経路は**実在する**。壊れているのは**その周り**である（設計 §3.1 の穴 4 つ）。
したがって本 spec 改訂も「機構を足す」話ではなく、**発火点の列挙に 2 つ足す**話である。

#### 改訂

| 文書 | 箇所 | 追加 |
|---|---|---|
| `PITCH_DSL_SPEC_v1.1.md` | §7-2 realization rule 2（Active note tracking） | **一発 `RUN()` の終端** / **オフラインレンダの終端** |
| `INSTRUCTION_ORBITSCORE_DSL.md` | Note lifecycle の Active-note tracking | 同上（英語側） |
| 同 | **PH.4 All Notes Off** | 同じ発火点 2 つ + 🔴 **daemon 側の「最後の砦」** |

#### 🔴 発火点が増えても配送機構は 1 本

3 箇所すべてに同じ注記を置いた。**場面ごとに別の flush を作らない。**
設計 §3.2 の責務 3 層（TS scheduler = owner ごとの解放 / daemon = instance ごとの最後の砦 /
child = 触らない）を仕様の言葉に落とした形である。

**child に flush を置かない理由**も設計から引いた: child は自分が受けた note の簿記を持たず、
持たせると `(port_index, channel, key)` 参照カウント（PH.4）の**正本が割れる**。

#### daemon の「最後の砦」を仕様に書いた理由

engine が保留 note を解放し切る前に死ぬと、**daemon は active note を追跡しているのに読み手が
いない**（設計 §3.1 の穴 H4・読み手 0 箇所）。これは
「**鳴りっぱなしを検出できるのに止められない**」状態なので、仕様の側で義務として書いた。
実装は PR-K-A2（wire に新 RPC を足す = 一方通行）。

##### 🔴 粒度を書き足した（Fable 監査の指摘）

初稿は「daemon が自身の追跡集合から note-off を送れること」までしか書いておらず、**粒度が
無かった**。2 行上には「**1 シーケンスの停止に wildcard な解放を使わない**」という規範があるので、
**サミング（複数シーケンス → 1 インスタンス）が入った時点で両者が衝突して読める。**

書き足した内容: 最後の砦は **instance 単位（そのインスタンスの全 owner）**である。daemon は
owner の境界を持たないので、これは wildcard 禁止の**例外ではなく適用外** — 通常の owner 単位の
解放経路から呼んではならない。発火してよいのは **`global.stop()` / shutdown / engine 異常終了**の
3 場面だけで、いずれも「そのインスタンスで鳴ってよいものが 1 つも無い」場面である。だから
サミングが入っても**巻き込む相手が存在せず**、参照カウント判定が不要になる。

粒度を書かない仕様は、実装時に「便利な flush」として owner 単位の経路から呼ばれる。
**義務だけ書いて適用範囲を書かないと、規範どうしが後で衝突する。**

#### 検証

`npm test` 2199 passed / 49 skipped（docs のみなので不変）・
`check-citations.mjs` 922 verified / 0 failed（行番号のずれを再アンカー）。

### docs(planning): record the VST3 / CLAP conventions the scanner does not follow (Sep 4, 2026)

**地図**: `docs/planning/DEVELOPMENT_MAP.md` **§4.C** / **ブランチ**: `546-plugin-spec-conventions`
/ owner 2026-09-04・**バグではなく機能改善**

#### 🔴 最初、DAW の「振る舞い」を写して規格を読んでいなかった

owner:

> オービットスタジオで今 **dylib を名指ししているという状態自体が、ちょっと異常**。
> VST も CLAP も基本的には**作法があるはず**なので、その作法を地図のどこかに入れていく。
> 他のものが使えているので、**他を実装した後でも全然いい**。**バグではなくて機能改善・改修。**

> 僕が言ってるのが VST や CLAP の作法ではないというか、**作法をちゃんと調べてやりましょう**。

初稿はフォーラム・製品ドキュメントから **Ableton / Bitwig の振る舞い**を写しただけだった。
owner の指摘で規格を読み直したところ、**振る舞いの観察からは出てこない義務**が見つかった。

#### 規格が定める作法と現在地

| # | 規格（一次情報・**強度**） | 現在地 |
|---|---|---|
| 1 | **CLAP: `CLAP_PATH` を問い合わせる — `must`**（`clap/include/clap/entry.h` 逐語 "a CLAP host **must** query the environment for a CLAP_PATH variable"） | 🔴 `CLAP_PATH` は見ていない。ただし **`ORBIT_PLUGIN_PATH`（`:` 区切り）は既に読んでいる**（`lib.rs:200-211` `extra_scan_dirs_from_env`）ので、**同じ関数に 1 本並べるだけ** |
| 2 | **CLAP: 各ディレクトリを再帰的に探索 — `should`**（同上。1 と違い義務ではない） | 🔴 **非再帰**（`list_bundle_candidates` の doc・同 `:228`。テスト `:2197` が非再帰を固定） |
| 3 | **CLAP: 1 `.clap` に複数プラグイン。factory で descriptor 列挙 → plugin ID で生成** | ✅ **実装済み**（`orbit-clap-host/src/discovery.rs:105-120` 全列挙 / `lib.rs:540-566` 1 バンドル→複数エントリ / `discovery.rs:125-137` ID で選択）。同一性は `(format, path, pluginId)` の複合キー（`lib.rs:1028-1034`） |
| 4 | **VST3: `moduleinfo.json` は 3.7.5 で導入、3.7.8 で `Contents/` → `Contents/Resources/`**（cmake の `SMTG_MODULEINFO_PATH_INSIDE_BUNDLE` で版差を確認） | ○ 参照している（`lib.rs:110`）。⚠️ **`Contents/Resources/` しか見ない**（`lib.rs:842`）ので **3.7.5〜3.7.7 のバンドルは ProbePending 送り** |
| 5 | **同一性は ID（CLAP=plugin ID / VST3=CID）、path は「所在」。ID → ファイルの対応表は規格に無く、所在の解決はホストの責務** | 🔴 `instrument(path)` が生パス（`plugin-resolver.ts:76-80`） |
| 6 | 検証を走らせるタイミング | 🔴 手動のみ（起動時はカタログ JSON を読むだけ・`plugin-catalog-reader.ts:132-150`） |

**1 は既存関数への 1 行追加。2 も小さい。5 は作り直しの規模**なので他の実装の後（owner）。

🔴 **初稿は 3 を「❓ 未確認」、5 を「規格はパスを同一性にしない」と書いていた。**
前者は**実装を読めば分かることを読まずに未確認と書いた**（[[invent-rules-only-after-reading-the-code]] の再発）。
後者は**言い過ぎ** — 規格は path を禁じているのではなく、同一性の担い手が ID だというだけである。
「作法を調べる」は規格側だけでなく**自分の現在地も一次情報で確かめる**ことを含む。

#### 保証のタイミングについての整理

owner: 「Logic や Studio One も**読み込めるということを確認するだけ**で、起動時に全てのプラグインが
メモリに読み込まれているわけではない。**インサートした時だけメモリ空間に出てくる。**
なので起動時のチェックは**品質保証的なもの**」。

調査でも一致した — Ableton は VST3 を常時スキャンにし、**AU は Apple の `auval` に外注**している。
Bitwig は**保証しきれないことを認めて隔離で解く**（ホスティングモード 5 段階）。
**OrbitScore は既に Bitwig 型の out-of-process + crash isolation を採っている。**

🔴 **これは [[live-coding-forbids-workflow-interruptions]] と対になる。** 保証を起動時に寄せるからこそ、
**演奏時に確認を挟む必要が無い**。「評価時に trust を問う」設計は DAW と**二重に**違っていた
（① 確認を挟む ② 判断を実行時に置く）。

### fix(engine): contain the two playback-path throws and log the skip (Sep 4, 2026)

**Issue**: #645（must-fix）/ **設計正本**: `docs/design/610-diagnostics-applicability-design.md` §5 / **PR**: PR-D0（Sonnet フォールバック実装・Codex が sandbox 制約で2回起動失敗）

owner 指示（2026-08-29）: 「ライブコーディングなのでエラー出して止まるのは基本よくない。内部的にちゃんと掴んでログに出すとかして実行に影響を出さない、とかにすれば別に普通に E2E テストでカバーできますよね」。

#### 対象の 2 throw と到達経路（5 経路・すべて main で行番号を取り直し済み）

| # | 場所 | 経路 | 直したか |
|---|---|---|---|
| 1 | `sequence.ts` `resolveDispatchChannel()` | `run()` `:1744` / `loop()` `:1791`（eager・await 連鎖） | ✅ throw→`DispatchTarget`（`skip`）+ `logSkipOnce()` |
| 2 | 同上 | 🔴 `seamlessParameterUpdate` `:273` → `scheduleEventsFromTime` `:1584`。`gain`/`pan`/`audio`/`chop`/`tempo`/`beat`/`length`/`play` から同期で入る（issue 本文が書いていない経路・再現条件として最有力） | ✅ 同上 |
| 3 | 同上 | `unmute()` `:1865` → 同上 | ✅ 同上（呼び出し元のみで解決） |
| 4 | `loop-sequence.ts` `safeSchedule`（`:113-129`） | 既に catch 済み。文言のみ `[ERROR] Sequence '<name>': loop scheduling error:` へ揃える | ✅ 文言合わせのみ |
| 5 | `loop-sequence.ts:104` / `run-sequence.ts` 初回 schedule | 1 と同じ経路で解決済み | ✅ 追加対応不要 |
| 6 | `event-scheduler.ts` `resolveAudioFilePath()`（定義 `:16` 改・呼び出し元 `:106`/`:193`） | パス非絶対（内部エラー自称） | ✅ throw→`undefined` を返しログ、呼び出し元が `return` |

#### 直し方（設計 §5.3 が確定）

- `resolveDispatchChannel(): DispatchTarget`（`{kind:'hardware'} | {kind:'link',channel} | {kind:'skip',reason}`）を新設。**`undefined` は使わない** — 旧 `undefined`（hardware 経路）とエラー時の `undefined` が同じ値になると黙ってハードウェアから音が出る（#645 が名指しした「別種の驚き」）
- `scheduleEvents`/`scheduleEventsFromTime`（sequence.ts 側の private ラッパー）は `kind === 'skip'` で **スケジュールせず return**（そのシーケンスだけ無音、他は継続）
- `run()`/`loop()` の eager 呼び出しは throw ではなく `logSkipOnce()` を呼ぶだけに変更（早期検知は残す）
- `logSkipOnce()`: `_dispatchSkipLoggedFor` で理由文字列をキーに重複抑止。**理由が変わった時**と **`.output()` が新しいチャンネルを設定した時**にリセット。ループは毎小節この経路を通るので、抑止が無いと `get_log` の 500 行窓を 1 シーケンスが埋め尽くす
- `event-scheduler.ts`: `resolveAudioFilePath(audioFilePath, sequenceName): string | undefined` へ変更。呼び出し元 2 箇所で `if (!resolvedFilePath) return`

#### テスト

- ユニット 13 本追加（`tests/core/sequence-link-audio-integration.spec.ts`）: run()/loop() が reject でなく resolve すること・`DispatchTarget` の3 kind・`logSkipOnce` のインスタンス単位 dedup（同一理由の連続呼び出しは1回だけログ）・`.output()` 呼び出しでの dedup キー reset（white-box。公開 API では2回目の skip を再現できないため）
- 既存ユニット 3 ファイル改修（throw 前提のテストを `DispatchTarget` 前提へ書き換え）
- gated E2E 1 本追加（`tests/e2e/orbitstudio-mcp-gated.spec.ts` 末尾）: `global.linkAudio()` 下で `.output()` 無しの LOOP が無音スキップ + ログされ、**別の（`.output()` 済みの）sequence の LOOP を止めない**ことを capture RMS で確認。続けて path 2（`.gain()` mid-loop）が同じ evaluation block を落とさないことを、**別の** `evaluate_orbitscore` 呼び出しでの gain 変化（RMS 差分）で確認。ERROR 件数はループ4秒超（2小節超）でも高々 +4 に収まることを assert（dedup の回帰証跡）
- `tests/e2e/dsl-e2e-coverage.spec.ts`: 新 E2E が `global.linkAudio()` を実機で評価するため `GLOBAL_UNCOVERED_BASELINE` から `linkAudio` を除去（ラチェットは減る方向のみ許可）

#### 検証（sandbox 内・実機 E2E は main が別途実施）

`npm test`（2199 passed / 49 skipped）・`npm run typecheck:e2e`・`npm run lint`・`npm run build`・`sites/dev` の `check-citations.mjs --fix`（`sequence.ts`/`event-scheduler.ts`/`loop-sequence.ts`/`dsl-e2e-coverage.spec.ts` の行番号シフトで 26 件の引用が機械的にずれたため再アンカーのみ実施・本文の書き換えなし）はすべて green。

#### 追記（実機 gated E2E が落ちた・main 実測 2026-09-04・修正済み）

main の実機実行で E2E-645 が `timed out waiting for #645 dispatch-skip log line` で failed
（他 10 件は baseline と同一の pre-existing 失敗で無関係）。**実装本体は問題なし**、テスト
ハーネスの前提検証不足が原因:

- `run_selection`（`evaluate_orbitscore` と違い）は評価完了を待たず、`isError` は
  「アクティブなエディタが無い」等の**機械的失敗**しか捉えない — 提出コードの実行時 throw
  （`global.linkAudio()` の v1 相互排他 throw 等・`global.ts:411-422`）は `get_log` にしか
  出ない。既存の `expect(run.isError).toBe(false)` はこの throw を素通りさせていた
- 修正: `global.linkAudio()` を単独の `run_selection` に分離し、直後に `get_log` で throw
  文言の有無を明示チェック（見つかれば「①linkAudio 自体が失敗」と名指しして即座に fail）。
  最終の skip ログ待ち `waitUntil` も try/catch で包み、タイムアウト時に「①は否定済みなので
  ②skip が起きなかった/③ログが窓外に流れた」の切り分けと `get_log` 末尾をエラーに含める
- `tests/e2e/helpers/run-score.ts` の `startEngineForRun`/`waitForEngineState`（`runScore()`
  が内部で使っていた既存の堅牢な起動処理）を export し、engine の (再) 起動をそちらへ委譲
  （`capture_wav` 要求時は必ず stop_engine→wait-false→start_engine、daemon ready timeout の
  retry-once、`🎵 Live coding mode` マーカー確認まで待つ — 単なる `get_engine_state.running`
  より確実）

検証（再実施）: `npm test`（2199 passed / 49 skipped・変化なし）・`typecheck:e2e`・`lint`・
`build`・`check-citations.mjs`（import 追加による行番号シフトで 46 件が再びずれたため
`--fix` で再アンカー）すべて green。実機 gated E2E は未実施（main が別途実施）。

#### 追記2（capture RMS の前提が崩れていた・main 実測 2026-09-04 の2回目・修正済み）

上の修正で前提診断は効き、skip はログに出ることが確認された。しかし別の assert
（`d645Live` の capture RMS）が `expected 0 to be greater than 0.01` で failed。main の一次
情報調査: `rust/crates/orbit-audio-daemon/Cargo.toml` の `link-audio` feature は default off・
gated ビルド（`pretest:e2e:gated`）も `--features outproc-effect,outproc-instrument` で
link-audio を含まない。「LinkAudio でも hardware にフォールバックして鳴る」という前提は
`rust-engine-player.ts` の**コメント**に書いてあっただけで、実機ログに
`LINK_AUDIO_UNAVAILABLE`/gap warning が1件も出ておらず、**裏取りできていなかった**。

- 修正: capture RMS への依存を全廃。証明手段を TS engine 側の `console.log` マーカーへ
  切替 — `🔄 <name> (loop started/queued)`（`loopSequence()`、dispatch 結果によらず無条件で
  発火）と `🎚️ <name>: gain=<x> dB (seamless)`（`seamlessParameterUpdate()`、
  `scheduleEventsFromTime` の private wrapper が skip で早期 return しても、呼び出し元自身の
  ログ行は必ず届く）。いずれも daemon RPC より手前の TS 側イベントなので、LinkAudio が
  daemon にコンパイルされているかに依存しない
- `LOOP(d645Skip)` + `LOOP(d645Live)`（経路1）・`d645Skip.gain(-6)` + `d645Live.gain(-3)`
  （経路2）を**それぞれ1つの `run_selection`（= 1評価ブロック）**にまとめ、後続の sibling
  マーカーが実際に出ることを確認 — pre-#645 なら先頭の throw が同ブロック内の後続文の実行を
  止めていたはず、というこの PR の主張そのものを検証する構造にした
- 別の `evaluate_orbitscore` 呼び出し（`d645Live.gain(-1)`、ブロックをまたぐ後続評価が汚染
  されないことの確認）は `pan` ではなく `gain` を再利用 —
  `dsl-e2e-coverage.spec.ts` の `SEQUENCE_UNCOVERED_BASELINE` に `pan` が残っており、新規に
  `.pan(` を書くとラチェットの「baseline は減らす方向のみ」に抵触するため
- テスト名から誤解を招く要素は無いため維持（「sibling を止めない」という主張は log マーカーで
  引き続き証明できている）。実行時間もこの変更で短縮（audio 用の settle sleep 群を削除）

検証（再実施）: `npm test`（2199 passed / 49 skipped・変化なし）・`typecheck:e2e`・`lint`・
`build`・`check-citations.mjs`（今回は行番号シフト無し・0 failed）すべて green。実機 gated
E2E は未実施（main が別途実施）。

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
