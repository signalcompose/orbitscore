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


> **これはアーカイブです**（`docs/core/PROJECT_RULES.md` §1a）。
> 現行の作業ログは [`docs/development/WORK_LOG.md`](../development/WORK_LOG.md) にあります。
>
> **収録期間**: 2026-09-01 〜 2026-09-02
> **アーカイブ理由**: 本体が 2,000 行の上限（`tests/docs/worklog-size.spec.ts` が強制）を超えたため。
> **注意**: 番号付きの節（`6.4xx`）は他文書からの参照を壊さないよう**番号のまま**移してあります。

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
