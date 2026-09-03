# 設計: E2E とテスト基盤 — 三者一致・共通ハーネス・実行の信頼性（#668-A / #650 / #630 / #543-(b) / #624 / #640 / #684）

**対象 issue**: #668（A の部分）/ #650 / #630 / #543（(b) 二重台帳のみ）/ #624 / #640 / #684
**関連**: #528（無音ハーネス事故）/ #614（`ok` の意味）/ #625（ERROR 件数の窓）/ #671（語彙の導出）/ #633（`ORBIT_KEEP_CAPTURES`）
**正本**: `docs/planning/DEVELOPMENT_MAP.md` §4.G / §4.G.1、CLAUDE.md「テストの積み上げ規律」「E2E が最重要」「仕組みで強制されている」、`docs/testing/E2E_HARNESS_SPEC.md`
**状態**: 設計（実装しない）・2026-09-03・main `ca176f0`

**本書が扱わないもの**（重複して書かない・参照する）:
`#543-(a)` 回帰 golden は [`611-output-line-design.md`](611-output-line-design.md) §9 が持つ。
各機能の E2E 項目そのものは [`611`](611-output-line-design.md) §10 / [`694`](694-session-log-editor-path-design.md) §9 / [`598`](598-render-endpoint-design.md) §12 が持つ。
本書は**それらが共通に踏む土台**（ハーネス・判定の型・仕組み）だけを設計する。

---

## 0. 裁定・確定事項（再議論しない）

| # | 確定 | 出どころ |
|---|---|---|
| 1 | 検証手段の順位は **仕様 → MCP 経由 E2E → 機能テスト → 変異（PR 外）** | CLAUDE.md「投資の順位」・owner 2026-08-29 |
| 2 | **MCP ツールはテスト用の裏口ではない**。E2E はユーザーと同じ動線を通る | CLAUDE.md・owner 2026-08-29 |
| 3 | `evaluate_orbitscore` の **`ok` に assert しない**。ERROR 件数は `<=` | CLAUDE.md・#614 / #625 |
| 4 | capture したら**数値を見る**（`gated-assertion-hygiene.spec.ts` が機械で守る） | 同上 |
| 5 | **並行機構を新設しない**。gated E2E は `tests/e2e/orbitstudio-mcp-gated.spec.ts` に積む | #630 本文・CLAUDE.md |
| 6 | 🔴 **実 GUI アプリの並列起動は禁止**（同名 spec の多重発見で 7 個同時起動・daemon 19 本残留の実害） | gated spec `:29-39` / `vitest.config.ts:26-45` |
| 7 | **#650 は #668 に統合して閉じる**（19 語 ⊂ 22 語） | MAP §4.G・#650 コメント 1 |
| 8 | 順序は **#668-A →（#650・#630）→ #543-(b)**。#624 / #640 / #684 は独立・小粒 | MAP §4.G |
| 9 | ラチェットの baseline は**減らす方向にしか編集しない** | CLAUDE.md「仕組みで強制されている」 |

🔴 **変異検証は本書の設計手段に含めない。** 位置づけは §14 に 1 節だけ置く。

---

## 1. 到達点（1 文）

**DSL の表面（語彙 + 構文）・実機 E2E・ユーザーリファレンスの三者が 1 つの正本から機械照合され、
どの設計文書の E2E 項目も「譜面を実機で評価して capture の数値で判定する」1 組の helper の上に
数行で書け、実行が負荷や環境で嘘をつかない状態。**

---

## 2. 現在地（一次情報・実測）

### 2.1 仕組みの側

| 仕組み | ファイル | 何を守るか | 穴 |
|---|---|---|---|
| E2E カバレッジのラチェット | `tests/e2e/dsl-e2e-coverage.spec.ts:39,49,63,89` | 未カバー語が**増えたら** red | ① **減らない**まま緑 ② **`.name(` しか見ない**（構文表面が測定外）③ 走査先が**1 ファイル決め打ち** |
| アサーション衛生 | `tests/e2e/gated-assertion-hygiene.spec.ts:18,30,46,58` | ERROR 厳密等価 / capture して rms を見ない / stale ガードの決め打ち | 走査先が**1 ファイル決め打ち**（`:18`） |
| ラック期待値表 | `tests/e2e/rack-chain-gain-expectations.ts:1-34` | 期待値を**式で持つ**（マジックナンバー禁止） | ラック専用 |
| stale バイナリガード | gated spec `:97-148` | 古い daemon を測らない | Rust のみ（TS/拡張の stale は見ない） |
| 実機ビルドの前置 | `package.json:18` `pretest:e2e:gated` | 古いバイナリで走らない | — |
| PID オラクルの純関数 | `tests/e2e/rack-child-pid-oracle.spec.ts` | ログ読み取りが黙って壊れない | — |
| リファレンス網羅 | **無い** | — | 🔴 **検査が存在しない** |
| 構文表面の一覧 | **無い**（`tokenizer.ts:18-27` の `KEYWORDS` は `private static`） | — | 🔴 正本が非公開 |

### 2.2 三者の実測（本設計で再現・main `ca176f0`）

抽出は `runtime.ts` の 2 つの Set と、リファレンスの `` `name(` `` 出現。

| | 件数 | 内訳 |
|---|---:|---|
| DSL 語彙（重複除く） | **44** | global 20 / sequence 32 |
| gated E2E 未カバー | **22** | `SEQUENCE_UNCOVERED_BASELINE` 16 + `GLOBAL_UNCOVERED_BASELINE` 8（重複 2） |
| **ja** リファレンス未記載 | **9** | `audioDevice compressor limiter loop mute normalizer run setDocumentDirectory unmute` |
| 🔴 **en** リファレンス未記載 | **13** | 上記 + `cell comp density hold`（**ja にしか無い 4 語**） |
| 語彙に無いのに載っている語 | 7 | `Gain`（プラグイン名）/ `LOOP` `MUTE` `RUN`（構文）/ `layer`（**予約・v1 はエラー**・`methods.md:378`）/ `method` `plugin`（散文の placeholder） |

**#668 本文の「リファレンス未記載 9 語」は ja のみの数**であり、**en は 4 語多い**。
en 側の検査が無いまま ja だけ埋めると、差は残る。

### 2.3 ハーネスの側（gated spec = 4,587 行・`it(` 20 件）

| 部品 | path:line | 状態 |
|---|---|---|
| ゲート env / skip | `:59-73`, `:358` | `describe.skipIf(!gated)` |
| tmpRoot / workspace 設定 / fixture work copy | `:642-727` | `#528` の深さ再現（`:672-687`）を含む |
| アプリ起動（`orbs` + `--extensionDevelopmentPath`） | `:728-759` | port は `39400 + rand(200)` |
| カタログ scan と一意性検査 | `:761-830` | 同名別実体を loud に落とす |
| engine 起動（capture は spawn 専用・retry 1 回） | `:428-475` | 🔴 R28 専用の名前のまま全体で使われている |
| instrument capture シナリオ | `:501-604` | 窓 RMS helper（`range`/`windows`/`rms`）を返す |
| teardown | `:607-635` | best-effort・tmpRoot 削除 |

🔴 **重複と非対称（実測）**:

- `countErrors` が **7 箇所**に別々に定義されている（`:522, 2170, 2748, 3181, 3487, 3995, 4490`）
- `ORBIT_KEEP_CAPTURES` を見るのは **`captureInstrumentScenario` だけ**（`:512-521`）。
  他の capture 3 箇所（`:3173, 3443, 3985`）は tmpRoot に書くので、**落ちると `afterAll`（`:628-634`）が
  WAV ごと消す** — #633 が「窓の外を見るために」入れた退路が、4 箇所中 3 箇所で効いていない
- `range`/`windows`/`rms` は `captureInstrumentScenario` のクロージャ内にあり、**外から使えない**

### 2.4 実行の信頼性（#624 / #640 / #684）

| 事象 | 一次情報 |
|---|---|
| capture は engine 側のタップなので**デバイスへの二重出力が写らない** | #624 本文 |
| 失敗時に engine が残る構造は不変（成功 run では重複ゼロ・失敗 run に `engine is already running` 4 回） | #624 コメント 1 |
| `host_child_integration.rs:73` の deadline は **5 秒**・負荷 9.95 で 3 回とも fail | #640 本文 |
| gated `#628 R28` が 13 回中 8 回 `daemon-backed REPL ready after 30000ms` で失敗 | #640 コメント 1 |
| daemon の ready-line timeout は **10 秒**（`daemon-client.ts:86`）。起動は 3 段（`main.rs:97` engine → `:106` bind → `:115` ready）で、**ready 前の段に 1 行もログが無い** | 実測 |
| 🔴 `DaemonStartupError.stderr` / `.exitCode`（`errors.ts:15-24`）は**どこからも読まれていない**（grep 実測・§後述）。起動失敗の唯一の材料が捨てられている | 実測 |
| root で必ず落ちる 3 件は `chmod 0o000` 依存（`file-import.spec.ts:187` / `mcp-server-docs.spec.ts:66,78`） | #684 本文 |

---

## 3. #668-A — 三者一致を「赤くなる形」にする

### 3.1 正本の形（production に置く・テストは読むだけ）

```
packages/engine/src/signal-chain/runtime.ts        GLOBAL_DSL_METHODS / SEQUENCE_DSL_METHODS   ← 既存
packages/engine/src/parser/dsl-surface.ts          DSL_SYNTAX_SURFACE                          ← 🔴 新規
        │
        ├─→ tests/e2e/dsl-coverage-ledger.ts       台帳（語/構文 → シナリオ → 観測タイプ）      ← 🔴 新規
        ├─→ tests/e2e/dsl-e2e-coverage.spec.ts     E2E 網羅（既存・走査先と粒度を拡張）
        └─→ tests/docs/reference-coverage.spec.ts  リファレンス網羅（ja / en）                  ← 🔴 新規
```

**構文表面の正本**（`.name(` では測れない表面。現在どこにも一覧が無い）:

```ts
// packages/engine/src/parser/dsl-surface.ts（新規・production）
/** パーサが受理する「メソッド呼び出しでない」DSL 表面。tokenizer / parse-statement の分岐と 1:1。 */
export type DslSyntaxId =
  | 'var-init-global'   // var g = init GLOBAL              tokenizer.ts:19-20, parse-statement.ts:62
  | 'var-init-seq'      // var s = init global.seq          parse-statement.ts:385
  | 'import'            // import { x } from "./a.orbs"     tokenizer.ts:26, parse-statement.ts:67
  | 'file-import'       // file_import 文                    audio-parser.ts:94,106
  | 'transport-run'     // RUN(x)                           parse-statement.ts:72
  | 'transport-loop'    // LOOP(x)                          同上
  | 'transport-mute'    // MUTE(x)                          同上
  | 'beat-by'           // n by 4                           tokenizer.ts:21
  | 'play-nested'       // play(1, (1,1), 1)
  | 'event-modifier'    // 1@v+10 / ^2 / ~ / @g
  | 'tie'               // _                                （audio では無視・#665）
  | 'underscore-method' // _gain(...) 等（適用形・spec §7）
  | 'chain-multiline'   // 複数行にまたがるチェーン（spec §3 Multiline）

export const DSL_SYNTAX_SURFACE: readonly DslSyntaxId[] = [/* 上を列挙 */]
```

🔴 **`tokenizer.ts:18-27` の `KEYWORDS` を `export` して流用するだけでは足りない**
（`play-nested` / `event-modifier` / `tie` はキーワードではない）。ただし
**`KEYWORDS` ⊆ `DSL_SYNTAX_SURFACE` の被覆を 1 本のテストで確かめる**（キーワードを足して
表面を足し忘れたら red）。そのため `KEYWORDS` は `export` する（`private static` → `static readonly` + 名前付き export）。

### 3.2 台帳（#543-(b) の実体・§9 も参照）

```ts
// tests/e2e/dsl-coverage-ledger.ts
/** §5 の判定の型と 1:1。`smoke`（評価が通っただけ）は件数をラチェットで減らす。 */
export type ObservationKind =
  | 'capture-rms' | 'capture-onset' | 'capture-pitch' | 'capture-bits'
  | 'log-text' | 'file' | 'smoke'

export interface CoverageEntry {
  /** DSL 語（`runtime.ts` の Set の要素）または構文 id（`DslSyntaxId`）。 */
  readonly surface: string
  /** gated spec の `it(` タイトルに実在する文字列（部分一致で照合する）。 */
  readonly scenario: string
  readonly observation: ObservationKind
  /** 仕様セクション ID（台帳 1・§9）。無い表面は明示的に null。 */
  readonly specSection: string | null
}

export const DSL_COVERAGE_LEDGER: readonly CoverageEntry[] = [/* … */]
```

### 3.3 検査（何が赤くなるか）

| # | 検査 | red になる条件 | 置き場 |
|---|---|---|---|
| A-1 | 語彙 ↔ E2E（既存ラチェットの拡張） | 未カバー語が baseline に**無い**のに現れた | `dsl-e2e-coverage.spec.ts` |
| A-2 | **構文表面 ↔ E2E** | `DSL_SYNTAX_SURFACE` の id が gated 群のどこにも現れず baseline にも無い | 同上 |
| A-3 | `KEYWORDS` ⊆ `DSL_SYNTAX_SURFACE` | キーワードを足して表面 id を足し忘れた | 同上 |
| A-4 | **台帳のシナリオが実在する** | `CoverageEntry.scenario` に一致する `it(` タイトルが gated 群に無い | 同上 |
| A-5 | **`smoke` のラチェット** | `observation: 'smoke'` の件数が baseline を超えた | 同上（`E2E_HARNESS_SPEC` §4） |
| A-6 | **リファレンス網羅（ja）** | 語彙の語が ja に項として無く、baseline にも無い | `tests/docs/reference-coverage.spec.ts` |
| A-7 | **リファレンス網羅（en）** | 同（en 用の別 baseline） | 同上 |
| A-8 | **ja / en の対称** | ja にあって en に無い語が baseline を超えた | 同上 |
| A-9 | **幻のドキュメント** | 語彙にも構文表面にも無い語が、分類（`plugin-name` / `reserved` / `prose`）**未申告**で載っている | 同上 |
| A-10 | baseline の誠実さ（既存 `:118-133` と同型） | baseline に残ったまま実は covered / documented | 両方 |

**A-9 の分類**（実測 7 語の行き先。`layer` は `methods.md:378` が「記法のみ予約・v1 では使うとエラー」と
**明記している**ので、黙認ではなく申告として持つ）:

```ts
export const REFERENCE_NON_VOCABULARY: Readonly<Record<string, 'plugin-name' | 'reserved' | 'prose' | 'syntax'>> = {
  Gain: 'plugin-name', LOOP: 'syntax', MUTE: 'syntax', RUN: 'syntax',
  layer: 'reserved',   // #635 未実装・リファレンスが「使うとエラー」と明記
  method: 'prose', plugin: 'prose',
}
```

### 3.4 走査先を 1 箇所にする（分割の前提・§7）

```ts
// tests/e2e/gated-sources.ts（新規・A-1〜A-5 と hygiene が共有）
/** gated E2E の実体を構成する全ファイル。分割してもここに足すだけで両検査が追随する。 */
export const GATED_SOURCE_FILES: readonly string[] = /* glob: tests/e2e/orbitstudio-mcp-gated.spec.ts + tests/e2e/gated/**\/*.ts */
export function readGatedSources(): string
export function gatedItTitles(): readonly string[]
```

🔴 **これを先に入れないと分割できない。** 現在 `dsl-e2e-coverage.spec.ts:39` と
`gated-assertion-hygiene.spec.ts:18` が**それぞれ 1 ファイルを決め打ち**しているので、
シナリオを別ファイルへ出した瞬間に **(a) カバー済みの語が未カバー扱いで red**、
**(b) 衛生検査が新ファイルを見ない（黙って弱くなる）** が同時に起きる。

### 3.5 ラチェットの終わり方

baseline が空になったら **baseline 配列そのものを削除**し、未カバー・未記載が 1 語でも red にする（#668 本文 3）。
**#671 段階 1-3 が入れば A-1 / A-6 は「生成が壊れていないこと」の確認に役割が変わる**（#668 コメント 3・4）。
本設計は #671 と競合しない（検査は生成の後も残る）。

---

## 4. 共通 helper（`tests/e2e/helpers/` に貼れる signature・実装はしない）

**方針: `captureInstrumentScenario`（`:501-604`）を置き換えず包む。**
あれは「instrument を 1 本立てて区間を録る」という**用途特化**で、7 つの `#643` シナリオが依存している。
下の `runScore` は**より薄い層**で、`captureInstrumentScenario` は将来これを内部で使う形へ寄せられる
（本設計では**寄せない**。既存 7 本の意味を変えないことを優先する）。

### 4.1 セッション（起動・tmpRoot・fixture・cleanup）

```ts
// tests/e2e/helpers/gated-session.ts
/** `requireCatalogFixtures()`（gated spec `:382-414`）の戻り値をそのまま型にしたもの（8 フィールド）。 */
export type GatedCatalog = ReturnType<typeof requireCatalogFixtures>

export interface GatedSession {
  readonly client: McpClient
  /** 実行ごとの隔離ルート。workspace であり、afterAll で消える。 */
  readonly tmpRoot: string
  readonly catalog: GatedCatalog
  /** 落ちた時に WAV を残す先。`ORBIT_KEEP_CAPTURES` があればそこ、無ければ tmpRoot。 */
  captureWavPath(slug: string): string
}
```

🔴 **`captureWavPath` を helper にするのが本節でいちばん実害を消す。**
現在 `ORBIT_KEEP_CAPTURES` を見るのは 4 箇所中 1 箇所だけで、残り 3 箇所は**落ちた瞬間に証拠が消える**（§2.3）。

### 4.2 譜面を work copy にして実機で評価する 1 関数

```ts
// tests/e2e/helpers/run-score.ts
export interface ScoreSource {
  /** 一時ファイル名の元。capture / work copy の basename に使う。 */
  readonly slug: string
  /** 譜面。行配列（テスト内で組む）か、リポジトリの fixture パス。 */
  readonly lines?: readonly string[]
  readonly fixturePath?: string
  /**
   * 🔴 fixture のリポジトリ相対**深さ**を tmpRoot 配下に再現する（既定 true）。
   * #528: フラットな tmpRoot へ写すと `audioPath("../../../…")` が外へ出て
   * `[SAMPLE_NOT_FOUND]` になり、**capture が無音のまま緑**になった。
   */
  readonly preserveDepth?: boolean
}

export interface CaptureWindows {
  readonly analysis: WavAnalysis           // packages/vscode-extension/src/wav-analysis.ts:22
  readonly capturePath: string
  /** 区間名 → その区間の窓を二乗平均した RMS。`captureInstrumentScenario:598` と同一計算。 */
  rms(segment: string, guardSec?: number): number
  /** 区間の窓列（peak を見たい時・不連続の検査）。 */
  windows(segment: string, guardSec?: number): ReadonlyArray<{ startSec: number; peak: number; rms: number }>
  /** 区間内のオンセット時刻（時間構造）。`analysis.onsets` の絞り込み。 */
  onsets(segment: string): readonly number[]
}

export interface ScoreRunContext {
  readonly session: GatedSession
  /** 追加評価（`evaluate_orbitscore`）。`ok` に assert しない — 診断は §4.4 で見る。 */
  evaluate(code: string): Promise<void>
  /** 名前つき区間を録る（settle → duration）。`captureInstrumentScenario:537-545` と同型。 */
  captureSegment(name: string, durationMs?: number, settleMs?: number): Promise<void>
}

/**
 * work copy → open_file → set_selection（全体）→ run_selection → body → stop → capture 解析。
 * capture を要求すると engine を一度落として `capture_wav` 付きで起動し直す（spawn 専用オプション）。
 */
export function runScore(
  session: GatedSession,
  source: ScoreSource,
  body?: (ctx: ScoreRunContext) => Promise<void>,
  opts?: { capture?: boolean },
): Promise<CaptureWindows | undefined>
```

**「全体を選択する」の意味**: `set_selection({ start_line: 1, start_char: 1, end_line: <行数>, end_char: 999_999 })`
（現行 `:551-557` と同じ）。行数は `lines`／fixture の実行数から取る。**エディタ経路を通す**ので
拡張が注入する `global.setDocumentDirectory(...)` が乗る（#528 / #630 が守りたい経路そのもの）。

### 4.3 ファイルの実在を待つ

```ts
// tests/e2e/helpers/wait-for-file.ts
/** `waitUntil`（mcp-client.ts:126）の薄い包み。生成物（.orbslog / stem / states）の待ち合わせに使う。 */
export function waitForFile(
  absPath: string,
  opts?: { timeoutMs?: number; intervalMs?: number; minBytes?: number },
): Promise<void>

/** ディレクトリ内で glob に一致する最初のファイル（`<name>.<stamp>.orbslog` のように名前が可変な生成物）。 */
export function waitForMatchingFile(
  dir: string,
  pattern: RegExp,
  opts?: { timeoutMs?: number; intervalMs?: number },
): Promise<string>
```

**`minBytes`** が要る理由: `.orbslog` も stem WAV も**作成と書き込みが別**なので、
存在だけを見ると 0 バイトを掴む。#694 E2E-S1 / #598 E2E-R1 が両方これを踏む位置にいる。

### 4.4 `get_log` の判定（ERROR は `<=`・マーカーは `>=`）

```ts
// tests/e2e/helpers/engine-log.ts
export const LOG_WINDOW_LINES = 500   // 🔴 固定窓。#625 — 件数の厳密等価は窓外へ流れた瞬間に嘘になる

export function countLogMarker(log: string, marker: string | RegExp): number

/** ERROR 行数のスナップショット。差分で語るための起点。 */
export function errorBaseline(client: McpClient): Promise<number>

/**
 * 「この操作は ERROR を増やさなかった」。`toBeLessThanOrEqual(baseline)` + 失敗時にログ末尾を添える。
 * 🔴 等価比較にしない（`gated-assertion-hygiene.spec.ts:30-44` が機械で禁じている）。
 */
export function expectNoNewErrors(client: McpClient, baseline: number, label: string): Promise<void>

/** 「この文言が少なくとも n 回出た」。マーカーの `>=` 判定（`startR28Engine:435` の markerCount の一般化）。 */
export function expectLogMarkerAtLeast(
  client: McpClient, marker: string | RegExp, atLeast: number, label: string,
): Promise<void>
```

これで `countErrors` の **7 重定義**（§2.3）が 1 本になる。

### 4.5 MCP を通らない経路 — CLI（`orbitscore replay` / `render`）

**原則の例外はここだけ**（[`694`](694-session-log-editor-path-design.md) §9 E2E-R1 / [`598`](598-render-endpoint-design.md) §12 E2E-R5・R6）。
CLI は MCP tool を持たないが、**ユーザーが実際に叩く動線**なので E2E は子プロセスで叩く。

```ts
// tests/e2e/helpers/run-cli.ts
export interface CliResult {
  readonly status: number          // 🔴 0 以外を握り潰さない（#694 E2E-R3 は status ≠ 0 が判定）
  readonly stdout: string
  readonly stderr: string
  readonly durationMs: number
}

/**
 * `node <repoRoot>/packages/engine/dist/cli-audio.js <...args>` を子プロセスで実行する。
 * bin 名は `orbitscore`（packages/engine/package.json:8-10）だが、E2E は **dist を直接**叩く
 * ——グローバルインストールに依存しないため。`pretest:e2e:gated`（package.json:18）が dist の鮮度を保証する。
 */
export function runOrbitscoreCli(
  args: readonly string[],
  opts?: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number },
): CliResult
```

**注意（設計上の制約）**: CLI は自分で daemon を起動する。**MCP 側の engine を止めてから**呼ぶこと
（§7 の daemon 本数の不変条件と同じ理由）。`ORBIT_CAPTURE_WAV` は CLI 側の env で渡す。

---

## 5. 判定の型（どの観測を選ぶか）

| 型 | 使う場面 | 実装 | 許容 |
|---|---|---|---|
| **窓 RMS** | 音量・ルーティング・フェーダー・send | `analyzeWavBuffer(buf, { windowMs: 20 })`（`wav-analysis.ts:115`）→ 区間平均 | **比**で書く。絶対値は環境で動く |
| **オンセット** | 時間構造（polymeter / quantize / loop / length） | `analysis.onsets` / `onsetGaps`（`wav-analysis.ts:31-34`） | 相対 |
| **基本周波数** | 音程（root / octave / vel は別） | `estimateFundamentalHz`（`wav-analysis.ts:180`） | セント |
| **bit 一致** | 「変わっていないこと」の証明（`thru:false` 既定など） | 同一入力・同一 driver で 2 回録って `Buffer.equals` | 0 |
| **許容幅つき golden** | 実機層で決定論が取れない経路 | 期待値を**式**で持つ（`rack-chain-gain-expectations.ts` と同じ規律） | 式の隣に定数 1 つ |
| **ログ文言** | エラー系（存在しないファイル・循環 import） | `get_log` の部分一致 | — |
| **ファイル** | 生成物（`.orbslog` / stem / states） | `waitForFile` + 中身 | — |

🔴 **`smoke`（評価が通っただけ）は台帳で申告し、件数をラチェットで減らす**（A-5）。
`E2E_HARNESS_SPEC` §4 が「smoke タイプは監査で警告」と定めているが、**現在その監査は存在しない**。

**弱いアサーションの型**（CLAUDE.md 列挙・本設計で避ける）: 部分一致の偶然マッチ / 引数名をアンカーにする /
捏造 mock 文言 / 「分類されていること」しか見ない逆方向テスト。

---

## 6. 決定論 — instrument / プラグイン経路で capture を固定できるか

🔴 **これは MAP §9 の未決である。本書では埋めない。** 埋めずに**分岐の両方に耐える形**を設計する。

| 経路 | 決定論の見込み | 根拠 | 取り方 |
|---|---|---|---|
| audio シーケンス（サンプル再生） | ✅ 取れている | Leg 1（`verify_schedule_pcm.rs`）が StubBackend でオフライン決定論レンダ | golden JSON + PCM |
| master capture（実時間・1 本） | 実時間ゆらぎのみ | `capture_realtime_gated.rs` が `drops == 0` で自己検証 | 窓 RMS の**比** |
| **instrument / プラグイン**（out-of-process child） | ❓ **未確認** | child の spawn 時刻・plugin 内部 state・#640 の負荷依存 | **許容幅つき golden**（`E2E_HARNESS_SPEC` §3 実機層） |

**設計上の帰結**（未決に依存しない部分）:

1. 期待値は**常に比で書く**。絶対 RMS を golden にしない（`rack-chain-gain-expectations.ts:20-32` と同じ）
2. **同一 run 内の 2 区間を比べる**（`unity` / `half` のように）。run 間の比較は最後の手段
3. bit 一致は **audio 経路と「変わらないことの証明」にだけ**使う（#611 E2E-0）。instrument に要求しない
4. 決定論が取れないと判明したら、**台帳の `observation` を `capture-bits` → `capture-rms` に落とす**だけで済む形にする（判定の型が台帳の 1 フィールドなので、テストの構造は変わらない）

---

## 7. 実行時間と分割（🔴 並列起動は禁止）

### 7.1 制約（動かせない）

- `test:e2e:gated`（`package.json:19`）は **`--pool=forks --poolOptions.forks.singleFork=true`**。
  実 GUI アプリと実オーディオデバイスは**同時に 1 つ**しか使えない（gated spec `:29-39` の SAFETY）
- 1 シナリオの下限は「engine 停止 → capture 付き起動 → settle 1s → 区間 2s×n → stop → settle 1s」
  （`captureInstrumentScenario:527-576`）。**区間を増やすより run を増やす方が高い**
- `TEST_TIMEOUT_MS = 120_000`（`:218`）

### 7.2 分割の順序（安い順）

| 段 | やること | 効果 | 前提 |
|---|---|---|---|
| **1** | **1 run に語を詰める** — 同じ engine 起動の中で区間を分けて複数語を観測する（`mute` → `unmute` → `pan` は 1 譜面で足りる） | 起動回数が語数に比例しなくなる | — |
| **2** | **シナリオ本体をモジュールへ出す**（`tests/e2e/gated/*.ts`・**`.spec.ts` にしない**） | 4,587 行が割れる。**vitest の発見単位は 1 ファイルのまま**なので起動も 1 回のまま | §3.4 の `GATED_SOURCE_FILES` |
| 3 | **選択実行** `ORBIT_GATED_ONLY=<正規表現>` で `it` を絞る | 反復時のターンアラウンド | 既定は全件（絞りっぱなしを防ぐ） |
| 4 | spec ファイル自体の分割 | ❌ **推さない** | 各ファイルが自前でアプリを起動する（起動が n 倍）。共有するには vitest の `isolate: false` が要り、**モジュール状態の共有はテスト間の隠れ依存を増やす** |

🔴 **段 2 が「分割」の本命**。ファイルを割る（段 4）のではなく**中身を割る**。
`it(` の登録は 1 ファイルに残し、本体を `import` する。

```ts
// tests/e2e/orbitstudio-mcp-gated.spec.ts（登録だけが残る）
import { muteUnmuteScenario } from './gated/transport-mute'
it.skipIf(!appAvailable)('#668-B mute/unmute drop and restore the captured RMS',
  () => muteUnmuteScenario(session()), TEST_TIMEOUT_MS)
```

### 7.3 測るもの（閾値は置かない）

- suite 全体の wall time と、**engine 起動回数**（`start_engine` の呼び出し数）
- 語あたりの追加コスト（段 1 の効果はこれで見える）

---

## 8. #650 / #630 の割り付け（#668-B の中身）

**#650 は #668 に統合**（確定事項 7）。19 語は 22 語の部分集合なので、以下は #668-B の内訳として書く。

| 束 | 語 / 表面 | 1 譜面にまとめる単位 | 観測 |
|---|---|---|---|
| **B-0**（最優先） | 🔴 **`import` / `file_import`**（#630） | 別ファイルを import する譜面 1 本 + 失敗 2 本 | `capture-rms`（import 先の seq が鳴る）+ `log-text`（不在 / 循環） |
| B-1 | `mute` / `unmute` / `loop` | 1 譜面・区間 3 つ（鳴る → mute → unmute） | `capture-rms`（落ちる / 戻る） |
| B-2 | `pan` / `defaultPan` | 1 譜面・L/R | `capture-rms`（**チャンネル別**・§10 の課題） |
| B-3 | `vel` / `defaultGain` / `gain` の相互作用 | 1 譜面・区間 2 つ | `capture-rms` |
| B-4 | `root` / `octave` | 1 譜面（instrument 経路） | `capture-pitch` |
| B-5 | `hold` / `length` / `quantize` | 1 譜面 | `capture-onset` |
| B-6 | `cell` / `density` / `comp` / `vl` / `voicelead` | 記譜・構造 | `capture-onset` / `capture-pitch` |
| B-7 | `midi` / `midiLatency` / `linkAudio` | 外部接続 | `log-text`（音では見えない） |
| B-8 | `audioDevice` | 🔴 **#661 が直るまで書けない**（#668 本文「関連」） | — |
| B-9 | 構文表面 | `n by 4` / `play` ネスト / `1@v+10` / `_` / `_method()` | `capture-onset` / `capture-pitch` |
| — | `compressor` / `limiter` / `normalizer` | 🔴 **書かない**（#669 段階 1 で語彙から消える・#668 コメント 1・2） | — |

### 8.1 #630（import）の被覆 — issue の 4 項目そのまま

| # | シナリオ | 判定 |
|---|---|---|
| I-1 | **エディタ経由**の相対パス解決: work copy に `main.orbs` と `drums.orbs` を置き、`open_file(main)` → `set_selection` 全体 → `run_selection` | import 先で宣言した seq が**鳴る**（区間 RMS > floor）。🔴 `evaluate_orbitscore` の生テキスト経路と**別に**通す（`setDocumentDirectory` が効く経路） |
| I-2 | 音まで通す | I-1 の RMS が dry 期待値の窓内 |
| I-3 | ERROR が増えない | `expectNoNewErrors`（`<=`） |
| I-4 | 失敗経路 | 存在しないファイル / 循環 import で `get_log` に期待文言 |

🔴 **I-1 の work copy は深さを再現する**（`preserveDepth`・§4.2）。フラットに置くと相対解決の検査にならない。

---

## 9. #543-(b) 二重台帳 — どこに置き、何を機械が守るか

**結論: ラチェットの一般化として `tests/e2e/dsl-coverage-ledger.ts` に置く**（§3.2）。別ファイルの新機構は作らない。

| 台帳 | 照合 | 実装 | #671 後 |
|---|---|---|---|
| **台帳 2**（実装 ↔ テスト） | `runtime.ts` の Set + `DSL_SYNTAX_SURFACE` ↔ 台帳 ↔ gated 群の `it(` | A-1 / A-2 / A-4 | 🔴 **生成に置き換わって不要**（MAP §4.G・#668 コメント 4） |
| **台帳 1**（仕様 ↔ テスト） | spec のセクション ID ↔ `CoverageEntry.specSection` | A-11（下） | **残る**（コードから導出できない唯一の軸） |

```
A-11: spec のセクション ID を機械抽出し、各 ID が
      {surface = E2E が要る}｜{non-surface = 理由つき} のどちらかに分類されていること。
      未分類なら red。
```

**先例**: `tests/interpreter/signal-chain-dispatch.spec.ts`（公開メソッドは DSL 語彙か内部 API か・
**未分類なら red**）。同じ形を仕様セクションへ適用する。

**ID の抽出（実測・見出し形式が揃っていない）**:

| ファイル | ID を持つ見出し | 形式 |
|---|---:|---|
| `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` | 40 | `### P.3 …` |
| `docs/specs-v2/SIGNAL_CHAIN_DSL_SPEC_v1.md` | 29 | `## SC.2` / `### SC.2.1` |
| `docs/specs-v2/PLUGIN_UI_HOSTING_SPEC_v1.md` | 15 | 同型 |
| `docs/specs-v2/PROJECT_FILE_SPEC_v1.md` | 12 | 同型 |
| `docs/specs-v2/PLUGIN_CAPABILITY_ABSTRACTION_v1.md` | 9 | 同型 |
| `docs/specs-v2/PITCH_DSL_SPEC_v1.1.md` | 0 | 🔴 **`### 2.1 Root scope` の数値形**（`P.x` は core spec 側にある） |

→ **ファイルごとに抽出パターンを宣言する**（1 つの正規表現で押し切らない）。
パターンに一致しない見出しは「ID を持たない節」として扱い、**台帳の対象外**であることを申告させる。

🔴 **順序**: 台帳 1（A-11）は **#668-A の後・#671 とは独立**。台帳 2 は #671 段階 3 で導出に変わる。
MAP §4.G が「#543 の設計は #671 段階 1-3 の後に見直す」としているのは**台帳 2 の話**であり、
**台帳 1 は先に入れてよい**（本設計の読み・§21 で反証方法を書く）。

---

## 10. 🔴 capture の解析が mono に潰れている（pan / チャンネル分離が原理的に測れない）

**実測**: `analyzeWavBuffer`（`packages/vscode-extension/src/wav-analysis.ts:115`）は
`:127-132` で全チャンネルを加算平均して**モノラルにしてから**窓 RMS を取る。
`WavAnalysis`（`:22-47`）にチャンネル別の系列は無く、MCP の `analyze_audio`（`mcp-server.ts:994-1021`）も
その形しか返さない。gated spec に `readFloatLE` は **0 件**（grep 実測）。

チャンネル別 RMS は **Rust 側にしか無い**（`rust/crates/orbit-audio-verify/src/analysis.rs:23 region_rms /
:41 channel_rms / :97 pan_from_lr_rms`）。オフライン Leg 1 と `capture_realtime_gated.rs` はそれを使うが、
**MCP 経由の gated E2E からは届かない。**

**このまま書けない E2E**: `pan` / `defaultPan` の L/R RMS 差（#650 優先 2 = 本書 §8 B-2）／
ch3/4 が無音・ch1/2 は有音（[`611`](611-output-line-design.md) §10 E2E-4・E2E-5）／
8ch で bleed 無し（[`598`](598-render-endpoint-design.md) §12 E2E-R5）。**4 件とも mono に潰れて常に緑になる。**

### 設計

```ts
// packages/vscode-extension/src/wav-analysis.ts（既存を拡張・破壊しない）
export interface ChannelWindow { readonly startSec: number; readonly peak: number; readonly rms: number }

export interface WavAnalysis {
  // …既存はそのまま（後方互換・`analysis.windows` は mono のまま）
  /** チャンネル別の窓系列（`opts.perChannel` 指定時のみ）。index = チャンネル番号。 */
  readonly channelWindows?: ReadonlyArray<ReadonlyArray<ChannelWindow>>
  /** チャンネル別の全体 RMS（同上）。 */
  readonly channelRms?: readonly number[]
}

export function analyzeWavBuffer(
  buf: Buffer,
  opts?: { windowMs?: number; perChannel?: boolean },
): WavAnalysis
```

MCP 側は `analyze_audio` に `per_channel: z.boolean().optional()` を足す
（**エージェントも同じ動線で見られる**ようにする — MCP は裏口ではない）。

helper 側:

```ts
// tests/e2e/helpers/run-score.ts の CaptureWindows に追加
  /** 区間 × チャンネルの RMS。pan / 分離 / stem の判定はここを使う。 */
  channelRms(segment: string, channel: number, guardSec?: number): number
```

🔴 **既定は mono のまま**（既存 20 本の `it(` の意味を変えない）。`perChannel` を要求した時だけ増える。

---

## 11. #624 — 孤児 daemon の二重出力が capture に写らない

**問題の構造**（#624 本文）: capture は engine 側のタップなので、**デバイスへ二重に出ていても片方しか写らない**。
全アサーションが緑のまま実機では二重に鳴る。気づけるのは人の耳だけ。

**設計（issue の提案どおり・安い）**:

```ts
// tests/e2e/helpers/daemon-census.ts
/**
 * 走っている daemon の PID。
 * 🔴 `pgrep -x orbit-audio-daemon` を使う（**実行ファイル名の完全一致**）。
 * `-f` にすると vitest 自身のコマンドラインや、このソースを開いたエディタまで一致する。
 * 名前は repo 固有（`rust/crates/orbit-audio-daemon/Cargo.toml:15`）。child は別名
 * （`orbit-effect-rack-child` / `orbit-clap-*-child` / `orbit-vst3-*-child`）なので混ざらない。
 */
export function daemonPids(): readonly number[]

/** 上限を超えていたら PID と経過時間つきで落ちる。 */
export function expectAtMostOneDaemon(label: string): void

/** teardown 用。0 本であることを確認し、残っていたら loud に報告する。 */
export function expectNoDaemon(label: string): void
```

**呼ぶ位置（choke point は 3 つだけ）**:

| 位置 | 期待 | path:line |
|---|---|---|
| アプリ起動 + engine auto-start の後 | `<= 1` | gated spec `:840`（auto-start した engine の running 確認の直後） |
| engine 再起動のたび | `<= 1` | `startR28Engine`（`:428-475`）の成功パス末尾 — **全 capture シナリオがここを通る** |
| teardown | `== 0` | `afterAll`（`:607-635`）の `killOrbitStudio()` の後 |

**setup 側の後始末**: setup 冒頭の `killOrbitStudio()`（`:641`）と対に、
**残留 daemon を刈る**（同じ「このマシンを専有する」前提。SAFETY の但し書きは `pkill -x` の
完全一致で満たす）。刈った本数は**ログに出す** — 前回の run が漏らした証拠になる。

🔴 **これは二重出力を「直す」設計ではない。**「次に落ちたときに機械的に分かる」ようにするだけ
（#624 コメント 1 の結論そのもの）。原因（失敗時に engine が残る構造）は残る。

---

## 12. #640 — 負荷で落ちるテスト（A: Rust / B: gated 起動）

### 12.A `host_child_integration.rs`（`cargo test --workspace`）

| チェックリスト項目 | 設計 |
|---|---|
| 失敗時に **load average** を出す（推奨案 4） | `assert!` のメッセージに `getloadavg(3)` の 1 分値を入れる。**判定は変えない**ので誤検出が増えない |
| `#[ignore]` に寄せるなら「遅い」と「実機要」を区別 | 🔴 `--ignored` は両者を区別しない（#629）。区別は **feature フラグ**（例 `gated-device`）で行い、`#[ignore]` は「遅い」専用にする |
| deadline 延長 / warm-up 強化のどちらを採るか | **未決**（§22 D-1） |

`host_child_integration.rs:73` の `assert!` メッセージに `load1={:.2}`（`getloadavg` の 1 分値）と
「静穏時に単独で再実行して切り分けること」を足すだけ。**判定式は触らない。**

**なぜ 4 を先に入れるか**: #628 のマージ前検証で「PR の退行か」を切り分けるのに時間を払った（#640 本文）。
**判定を緩めずに切り分けコストだけを下げる**のはこの案だけ。

### 12.B gated E2E の起動タイムアウト（`#628 R28` が 13 回中 8 回失敗）

🔴 **本筋（案 3「なぜ 30 秒で ready にならないか観測する」）に、そのまま効く欠陥が見つかった。**

```
daemon-client.ts:880-941   ready 前の stderr を stderrChunks に貯める
                :934-939   timeout で DaemonStartupError(message, stderr, exitCode) を投げる
errors.ts:15-24            .stderr / .exitCode を保持
────────────────────────── 🔴 grep 実測: この 2 つを読む箇所は repo に存在しない
```

つまり **起動が遅れた理由の唯一の材料が、集められた直後に捨てられている。**

さらに daemon 側は **ready 前に 1 行もログを出さない**:

| 段 | path:line | 所要が支配的になりうる理由 | 現在のログ |
|---|---|---|---|
| device 解決 + cpal stream 構築 | `main.rs:97`（`start_engine_with_device_switch`） | Aggregate デバイス probe・`coreaudiod` 競合 | 🔴 無し |
| WebSocket bind | `main.rs:106` | ポート枯渇 | 🔴 無し |
| ready line 出力 | `main.rs:115-126` | — | 出力後に `:128` の `listening on` |

**設計**:

1. **daemon に段マーカーを足す**（`tracing::info!` で 3 段 + 各段の経過 ms）。
   subscriber は `main.rs:33-38` で**最初に**立っているので、ready 前でも stderr に出る
2. **`DaemonStartupError.stderr` / `.exitCode` を必ずログへ出す**（engine の起動失敗経路 1 箇所）。
   これで `get_log` に「どの段で止まったか」が残り、E2E の失敗報告からそのまま読める
3. E2E 側は既存の retry（`startR28Engine:428-475`・**既知の ready-line timeout だけ 1 回**）を維持。
   **retry 回数を増やさない**（原因を隠す）
4. 暫定の timeout 延長（案 1）は **未決**（§22 D-2）— 1 と 2 を入れてから測って決める

**受け入れ**（#640 チェックリスト）: 負荷下（load 9+）で走らせたとき、失敗が
「本物の退行」か「負荷起因」かが **1 と 2 の出力だけで区別できる**こと。

---

## 13. #684 — root で必ず落ちる 3 件（hook 迂回の常態化）

**推奨は issue の案 A**（root では skip）。理由も issue のとおり:
落ちる理由が「テストの前提（DAC が効く）が満たされない」ことなので、前提が無い環境では skip が素直。

```ts
// tests/helpers/privileges.ts（新規・3 spec が共有）
/**
 * root は DAC を迂回して `chmod 0o000` のファイルを読めてしまうため、
 * 「読めないファイル」を前提にしたテストは**成立しない**（#684）。
 * CI（GitHub Actions）は非 root なので検出力は落ちない。
 */
export const RUNNING_AS_ROOT: boolean = process.getuid?.() === 0
export const SKIP_AS_ROOT_REASON = 'root bypasses DAC: chmod 0o000 stays readable (#684)'
```

| 対象 | path:line | 変更 |
|---|---|---|
| import の EACCES 分類 | `tests/interpreter/file-import.spec.ts:185-198` | `it.skipIf(RUNNING_AS_ROOT)` |
| `readDevDoc` の TOCTOU | `tests/vscode-extension/mcp-server-docs.spec.ts:59-72` | 同 |
| `searchDevDocs` の walk 継続 | 同 `:74-88` | 同 |

**受け入れ**（issue のまま）: root / 非 root どちらでも `npm test` が緑・**skip の理由が読める**・
ルーチンが `--no-verify` 無しでコミットできる。

🔴 **案 C（hook 側で root なら `npm test` を飛ばす）は採らない** — 守る対象が消える（issue の評価どおり）。

**併せて**: skip が増えると「root では未検証」が見えなくなるので、
**`RUNNING_AS_ROOT` を使う spec の件数をラチェットする**（3 件から増えたら red）。
`.husky/pre-commit` は `npm test` を回すだけなので変更不要。

---

## 14. 変異検証の置き場（1 節だけ）

**PR のクリティカルパスに置かない**（CLAUDE.md・owner 2026-08-29）。順序は
**DSL 網羅 E2E → 実機で問題 → ログで異常系 → それでも捕まらない時だけ変異**。

- 「このテスト、実は何も見ていないのでは」を問う時だけ、**無人の `cargo-mutants --test-tool nextest --in-diff`**
- 網羅的な変異は **PR とは別のタイミングでまとめて**（`E2E_HARNESS_SPEC` §6.3 の「自動定期ジョブ化」がこれに当たる）
- 🔴 **本書の設計項目に「変異で守る」と書く場所は無い。**
  §3 の検査はすべて**集合差**で、§4-§10 はすべて**capture の数値**で守る

---

## 15. データの通り道 1 本（#630 I-1・端から端まで）

```
[test] runScore(session, { slug:'import-editor', fixturePath:'tests/fixtures/mcp-e2e/import_main.orbs', preserveDepth:true })
  → work copy: <tmpRoot>/tests/fixtures/mcp-e2e/{import_main.orbs, import_drums.orbs}   // 深さを再現（#528）
  → session.captureWavPath('import-editor')                                             // ORBIT_KEEP_CAPTURES を尊重
  → stop_engine → waitForEngine(false) → start_engine({capture_wav})                    // capture は spawn 専用（:436-443）
  → open_file(<work copy>)                                                              // mcp-server.ts:691
  → set_selection(1,1,<行数>,999999)                                                     // :709
  → run_selection                                                                       // :748
[extension] 全評価の先頭に global.setDocumentDirectory("<work copy の dir>") を注入      // #528 の当事者
[engine]  parseAudioDSL → import 文 → process-file-import.ts が dir 基準で解決
  → import_drums.orbs を評価 → seq が共有名前空間へ合成 → LOOP で発音
[daemon]  master へ合流 → ORBIT_CAPTURE_WAV へ float32 WAV
[test] evaluate('global.stop()') → stop_engine → waitForEngine(false)
  → analyzeWavBuffer(capture, { windowMs: 20 })
  → rms('imported') > floor                       // 音が出た＝配線が通った
  → expectNoNewErrors(client, baseline, 'import')  // <= （500 行窓・#625）
  → expectAtMostOneDaemon('after import scenario') // #624
```

🔴 **`evaluate_orbitscore` の生テキスト経路では I-1 にならない**（`setDocumentDirectory` の注入が
乗るのは**エディタ経路**）。#630 が名指しで要求しているのはこの違いである。

---

## 16. 呼び出し元の全列挙（grep 実行結果・main `ca176f0`）

**A. gated spec のパスを決め打ちしている箇所**（§3.4 で 1 本化する対象）

```
$ grep -rn "orbitstudio-mcp-gated" --include=*.ts --include=*.json --include=*.md tests/ package.json docs/testing | grep -v "^tests/e2e/orbitstudio-mcp-gated.spec.ts:"
tests/e2e/helpers/mcp-client.ts:5: * gated E2E spec (tests/e2e/orbitstudio-mcp-gated.spec.ts). Deliberately
tests/e2e/rack-child-pid-oracle.spec.ts:12:import { latestRackChildPid, rackChildPidsFromLog } from './orbitstudio-mcp-gated.spec'
tests/e2e/gated-assertion-hygiene.spec.ts:18:const GATED_SPEC = path.resolve(__dirname, 'orbitstudio-mcp-gated.spec.ts')
tests/e2e/dsl-e2e-coverage.spec.ts:39:const GATED_SPEC = path.resolve(__dirname, 'orbitstudio-mcp-gated.spec.ts')
package.json:19:    "test:e2e:gated": "ORBIT_GATED_ORBITSTUDIO=1 npx vitest run --dir tests --config vitest.config.ts --globals --pool=forks --poolOptions.forks.singleFork=true e2e/orbitstudio-mcp-gated"
docs/testing/E2E_HARNESS_SPEC.md:6:> 現行の gated E2E（`tests/e2e/orbitstudio-mcp-gated.spec.ts`）は配線 smoke であり、
```

🔴 `rack-child-pid-oracle.spec.ts:12` は **spec ファイルから import している**。
分割時にここが壊れる（純関数の置き場を helper へ移す必要がある）。

**B〜E**（出力が短いものはまとめて貼る）

```
$ grep -rn "ORBIT_GATED_ORBITSTUDIO" --include=*.ts --include=*.json --include=*.sh --include=*.yml . | grep -v node_modules
./tests/e2e/orbitstudio-mcp-gated.spec.ts:11 / :59      ./package.json:19          ← ゲート env はこの 2 箇所だけ

$ grep -n "captureInstrumentScenario" tests/e2e/orbitstudio-mcp-gated.spec.ts
501（定義）/ 1438 / 1474 / 1512 / 1559 / 1603 / 1645 / 1691   ← #643 E2E-1〜E2E-7（包む対象・置き換えない）

$ grep -rn "0o000" tests/ packages/ --include=*.ts                                  ← #684 の 3 件はここで尽きる
tests/vscode-extension/mcp-server-docs.spec.ts:66 / :78    tests/interpreter/file-import.spec.ts:187

$ grep -rn "pgrep\|pkill" tests/ scripts/ --include=*.ts --include=*.sh             ← #624 が足す先の既存作法
tests/e2e/orbitstudio-mcp-gated.spec.ts:231 (pkill -f OrbitStudio.app/Contents/MacOS) / :253 (pgrep -f <pluginPath>)
tests/audio/rust-engine/daemon-client.spec.ts:1012（コメントのみ）

$ grep -n "ORBIT_KEEP_CAPTURES" tests/e2e/orbitstudio-mcp-gated.spec.ts             ← §2.3 の非対称
512 / 519 / 520   ← captureInstrumentScenario の中だけ。:3173 / :3443 / :3985 の capture は tmpRoot 直書き

$ grep -n "readFloatLE\|channel_rms" tests/e2e/orbitstudio-mcp-gated.spec.ts        ← §10
（0 件）
```

**F. `DaemonStartupError` の生成と消費（#640-B の根拠）**

```
$ grep -rn "DaemonStartupError" packages/engine/src packages/vscode-extension/src --include=*.ts
packages/engine/src/audio/rust-engine/daemon-client.ts:39,934,961,971,990,1019   （生成 5 箇所）
packages/engine/src/audio/rust-engine/errors.ts:15,20                            （定義）
packages/engine/src/audio/rust-engine/index.ts:19                                （再輸出）

$ grep -rn "startupError\|err.stderr\|error.stderr\|\.exitCode" packages/engine/src packages/vscode-extension/src --include=*.ts
packages/engine/src/audio/rust-engine/daemon-client.ts:378,937   （spawn 側の child.exitCode）
packages/engine/src/audio/rust-engine/errors.ts:22               （代入）
packages/vscode-extension/src/extension.ts:2239                  （別プロセスの exitCode）
```

🔴 **`DaemonStartupError` の `.stderr` を読む箇所は 0 件。**

---

## 17. 失敗モード（握り潰される経路が無いこと）

| # | 失敗 | 現状 | 本設計での扱い |
|---|---|---|---|
| F-1 | capture が無音なのに緑 | #528 で発生（ハーネス不備） | 🔴 `runScore` は **capture を要求したら rms のアサーションを義務**にする（`gated-assertion-hygiene.spec.ts:46-56` がソースで機械検査） |
| F-2 | 落ちた時に WAV が消えて追えない | 4 箇所中 3 箇所（§2.3） | `session.captureWavPath()` に一本化（§4.1） |
| F-3 | ERROR 件数の窓外流出で嘘の緑/赤 | 対策済（`<=`） | helper が `<=` しか提供しない（`expectNoNewErrors`） |
| F-4 | `ok: true` を根拠にする | #614 以降も**評価後の非同期失敗**は `get_log` のみ | helper に `ok` を返さない。診断は §4.4 経由 |
| F-5 | 孤児 daemon の二重出力 | capture に写らない | §11 の本数 assert（**検出のみ**・原因は残る） |
| F-6 | 起動が遅れた理由が消える | `.stderr` 未読（§16 F） | §12.B の 1・2 |
| F-7 | 語を足して E2E を書き忘れる | ラチェットで検出 | **構文表面まで拡張**（A-2） |
| F-8 | リファレンスだけずれる | 🔴 検査が無い | A-6 / A-7 / A-8 |
| F-9 | 分割してラチェット/衛生が黙って効かなくなる | 🔴 起きうる | `GATED_SOURCE_FILES`（§3.4）を**先に**入れる |
| F-10 | root 環境で hook が常に迂回される | 発生中 | §13 |
| F-11 | 台帳のシナリオ名が実体とずれる | — | A-4（`it(` タイトル照合） |
| F-12 | `smoke` だけで網羅したことにする | 🔴 起きうる | A-5（件数ラチェット） |
| F-13 | pan / 分離が mono に潰れて常に緑 | 🔴 **現在そう**（§10） | `perChannel` を足す |

---

## 18. E2E 項目（本設計そのものが足す分・すべて MCP 経由）

本設計の大半は**メタテスト**（`npm test` で常時走る）だが、**gated にも足す**:

| # | シナリオ | 判定 |
|---|---|---|
| E-1 | #630 I-1（エディタ経路の import） | import 先 seq の区間 RMS > floor・ERROR 増えず（`<=`） |
| E-2 | #630 I-4（存在しないファイル） | `get_log` に期待文言・**engine が生きたまま** |
| E-3 | #630 I-4（循環 import） | 同上 |
| E-4 | #668-B B-1（`mute` / `unmute` / `loop`） | 1 譜面 3 区間: 鳴る → **RMS が floor 近くまで落ちる** → 戻る |
| E-5 | #668-B B-2（`pan` / `defaultPan`） | **チャンネル別 RMS**（§10 が前提）L/R の比が期待式どおり |
| E-6 | #624 | 各 engine 再起動の後で daemon 本数 `<= 1`・teardown 後 `== 0` |

- `ok` に assert しない / ERROR は `<=` / capture したら数値を見る
- 🔴 **`dsl-e2e-coverage.spec.ts` の baseline は増やさない。** E-4 / E-5 は
  `mute` `unmute` `loop` `pan` `defaultPan` を baseline から**減らす**
- ゲート env 未設定で **skip されること**を確認（通常の `npm test` を壊さない）

---

## 19. spec 改訂（実装より先・運用規則 6）

| 文書 | 節 | 改訂 |
|---|---|---|
| `docs/testing/E2E_HARNESS_SPEC.md` | §3「実機層は**代表構文のみ**」 | 🔴 **改訂**: 語彙・構文表面の**網羅は実機層（gated）で取る**（ラチェットが強制する）。オフライン決定論層は**回帰の固定**（同一 `.orbs` → bit 一致）に役割を絞る。出どころ: MAP §4.G（「#668-B = 未カバー語を埋める」は gated spec の語を数えている）+ owner 2026-09-03「MCP 経由、ユーザーと同じ形で」 |
| 同 | §2 台帳 | 台帳 1 / 台帳 2 の**置き場と寿命**を書く（台帳 2 は #671 段階 3 で導出に変わる・台帳 1 は残る。§9） |
| 同 | §4 | 観測タイプを列挙に固定（`ObservationKind`）。「smoke は監査で警告」を**件数ラチェット**として具体化 |
| 同 | §6.3 変異スイープ | 🔴 **改訂**: 「自動定期ジョブ化」= **PR のクリティカルパス外**であることを明記（CLAUDE.md 2026-08-29 の改訂に合わせる）。`cargo-mutants --in-diff` を名指す |
| 同 | 冒頭の但し書き | 「現行 gated は配線 smoke であり暫定」→ **現状に合わせて更新**（`it(` 20 件・capture 数値判定・ラチェット/衛生の 2 検査が既にある） |
| `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` | §10 Testing Guidelines | 三者一致の仕組み（§3）と「DSL を足したら E2E も足す」を 1 段落で参照（運用規則 7: core spec と specs-v2 の乖離を作らない） |

---

## 20. PR 分割

| PR | 内容 | 触るファイル / 概算 | 依存 | 検証 | 一方通行 |
|---|---|---|---|---|---|
| **PR-E0** `docs(testing): E2E harness spec — ledger placement, observation kinds, mutation off the critical path` | §19 の spec 改訂 | `docs/testing/E2E_HARNESS_SPEC.md` +80/-20 | — | docs のみ（advisor 相談・CLAUDE.md） | — |
| **PR-E1** `test(e2e): one source list for the gated suite` | `GATED_SOURCE_FILES`（§3.4）+ 2 検査の走査先差し替え + `rack-child-pid-oracle` の import 元を helper へ | `tests/e2e/gated-sources.ts` 新規 +60 / 既存 3 本 ±40 | — | `npm test`（緑のまま = 挙動不変） | — |
| **PR-E2** `test(e2e): shared harness helpers (session, runScore, log, file, cli)` | §4 の 5 モジュール。**既存 20 本は書き換えない**（`countErrors` の 7 重定義だけ差し替え） | `tests/e2e/helpers/*.ts` 新規 +400 / gated spec -60 | PR-E1 | 実機 gated 全通し（挙動不変の確認） | — |
| **PR-E3** `feat(mcp): per-channel WAV analysis` | §10（`wav-analysis.ts` + `analyze_audio` + helper） | engine/extension +120 | PR-E2 | 実機 MCP: `analyze_audio(per_channel:true)` の値を既存 mono と突き合わせ | 🔴 **MCP tool 表面**（追加のみ） |
| **PR-E4** `test: syntax surface source of truth + coverage ratchet` | `dsl-surface.ts`・`KEYWORDS` の export・A-1〜A-5 | engine +80 / tests +200 | PR-E1 | `npm test`（baseline を現状で記録して**緑で入る**） | — |
| **PR-E5** `test(docs): reference coverage for ja and en` | A-6〜A-10 | `tests/docs/reference-coverage.spec.ts` +180 | PR-E4 | `npm test` | — |
| **PR-E6** `test(e2e): import runs from the editor path` | #630 I-1〜I-4（E-1〜E-3） | fixtures 2 本 + gated +150 | PR-E2 | 🔴 実機 gated + `get_log` | — |
| **PR-E7** `test(e2e): mute, unmute, loop, pan on real hardware` | #668-B B-1 / B-2（E-4 / E-5）+ baseline を 5 語減らす | gated +200 | PR-E3・PR-E4 | 実機 gated（capture の数値） | — |
| **PR-E8** `test(e2e): assert at most one daemon at every phase boundary` | §11 | `tests/e2e/helpers/daemon-census.ts` +80 / gated +30 | PR-E2 | 実機 gated | — |
| **PR-E9** `test: report load average when a child deadline expires` | §12.A | `host_child_integration.rs` +30 | — | `cargo test -p orbit-audio-sandbox` を負荷下で | — |
| **PR-E10** `fix(daemon): log the startup stages and surface DaemonStartupError.stderr` | §12.B の 1・2 | `main.rs` +25 / `daemon-client.ts` +20 | — | 実機で engine 再起動 → `get_log` に段マーカー | — |
| **PR-E11** `test: skip DAC-dependent cases when running as root` | §13 | `tests/helpers/privileges.ts` +25 / 2 spec ±20 | — | root / 非 root 両方で `npm test` | — |
| **PR-E12** `test: dual ledger — spec sections must be classified` | §9 台帳 1（A-11） | `tests/e2e/dsl-coverage-ledger.ts` +250 | PR-E4 | `npm test` | — |

**残りの語（B-3〜B-9）は PR-E7 と同型**なので、束ごとに 1 PR ずつ積む（baseline が残高として見える）。
`audioDevice`（B-8）は **#661 の後**。`compressor` / `limiter` / `normalizer` は **#669 段階 1 で語彙から消える**ので書かない。

---

## 21. 確信度と反証方法

| 主張 | 確信度 | 反証方法 |
|---|---|---|
| ラチェットと衛生検査は走査先が 1 ファイル決め打ちで、分割すると黙って壊れる | **高** | `dsl-e2e-coverage.spec.ts:39` / `gated-assertion-hygiene.spec.ts:18` を読む。シナリオを別ファイルへ移して `npm test` すれば即 red |
| `DaemonStartupError.stderr` はどこからも読まれていない | **高** | §16 F の grep。読む箇所が出てきたら §12.B の 2 は不要 |
| `analyzeWavBuffer` は mono に潰すので pan が測れない | **高** | `wav-analysis.ts:127-132`。反証: gated spec に channel 別の測定があること（grep 実測 0 件） |
| `ORBIT_KEEP_CAPTURES` が 4 箇所中 1 箇所でしか効かない | **高** | `grep -n ORBIT_KEEP_CAPTURES tests/e2e/orbitstudio-mcp-gated.spec.ts` → `:512-521` のみ |
| 段 2（本体をモジュールへ）で起動回数が増えない | **中** | vitest の発見単位はファイル。`it(` の登録が 1 ファイルに残る限り 1 セッション。反証: import 側の副作用でモジュールが二重評価される場合 |
| 台帳 1（仕様セクション）は #671 と独立に入れられる | **中** | #671 が導出するのは**実装の語彙**であって仕様セクション ID ではない。反証: #671 段階 3 が spec からも生成する設計になっていること |
| root skip で検出力が落ちない | **中** | CI（GitHub Actions）が非 root であること。反証: CI が root コンテナに変わった時 |
| daemon 本数 `<= 1` が偽陽性を出さない | **中** | 別プロジェクト・別セッションの daemon が同時に走らない前提（`killOrbitStudio` と同じ専有前提）。反証: owner が手元で OrbitStudio を開いたまま E2E を回す運用 |

---

## 22. 🔴 owner 裁定待ち（本文はこれに依存せず着手できる）

| # | 論点 | 選択肢 | 推奨 | 影響範囲 |
|---|---|---|---|---|
| **D-1** | **#640-A の deadline をどうするか**（#640 チェックリスト「どちらを採るか決める」） | **A**: 5s → 30s へ延ばす（「遅い」と「壊れている」の区別が鈍る）／**B**: `warm_up_executable` の強化（効果が読めない）／**C**: 変えず、load average の報告だけ（PR-E9）で様子を見る | **C** を先に入れて実測してから決める | `host_child_integration.rs` のみ |
| **D-2** | **#640-B の暫定対応**（issue が「❓ 未確認・owner 判断待ち」と明記） | **A**: 起動 timeout 30s → 60s／**B**: retry 回数を増やす／**C**: 入れない（PR-E10 の観測を先に） | **C**（原因を隠さない・#640 コメント 1 も「本筋は案 3」） | gated spec の起動経路 |
| **D-3** | **実機 gated E2E を無人で回すか**（`E2E_HARNESS_SPEC` §5「実機層は実機 Mac のスケジュール実行へ」は未実装。owner の耳の前で音が鳴る） | **A**: 手動トリガーのまま（現状）／**B**: 実機 Mac のスケジュール実行 | **A** のまま（B は音が鳴る時間帯の合意が要る） | 運用のみ・コード変更なし |
| **D-4** | **`ORBIT_GATED_ONLY` を入れるか**（§7 段 3） | **A**: 入れる（反復が速い）／**B**: 入れない（絞りっぱなしで全件が回らなくなる事故を避ける） | **A** + 「絞ったら結果に loud な注記」 | gated spec のみ |

**未決（MAP §9・埋めない）**: instrument・プラグイン経路の capture を**決定論的に固定できるか**。
本設計は §6 のとおり**どちらでも成立する形**にしてある（決定論が取れなければ台帳の `observation` を落とすだけ）。
