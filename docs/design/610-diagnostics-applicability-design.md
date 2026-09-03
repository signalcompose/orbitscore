# 設計: 診断の整合 — 「何が書けて何が書けないか」を 1 枚の表にする（#610 / #644 / #645 ほか）

**対象 issue**: #610（診断の土台・🔴 前提）/ #644（適用可否の表）/ #645（演奏中の throw 2 箇所・`must-fix`）/ #280 / #255 / #583 / #609 / #620 / #665 (A)
**関連**: `docs/design/643-mixer-foundation-design.md`（instrument の出口ガード）/ `docs/design/611-output-line-design.md` §2.2・§3.5・§3.7（宛先の集合・master ライン・output ノードのレシーバ化）/ `docs/design/598-render-endpoint-design.md` §3.1・§3.2（render ノード）/ `docs/design/694-session-log-editor-path-design.md` §4（`//#evalBegin` フレーム）
**正本**: `docs/core/INSTRUCTION_ORBITSCORE_DSL.md`（本書は spec 改訂案を §12 に含む。実装より先に spec を直す・運用規則 6）
**状態**: 設計（実装しない）・2026-09-03・main `ca176f0` 実測

---

## 0. owner 裁定・確定事項（再議論しない）

| # | 裁定 | 出どころ |
|---|---|---|
| 1 | 🔴 **ライブコーディングなので実行を止めない。** エディタ側の診断で赤線を出し、エンジンは掴んでログに出す | owner 2026-08-29（#644 / #645）・地図 §4.F |
| 2 | #644 の**スコープはエディタ側の診断のみ**。エンジンの実行時挙動は変えない（無視する・止めない） | #644「🔴 スコープ」節・owner 2026-08-29 |
| 3 | 適用可否は**メソッドごとの `if` ではなくデータ（表）**で持ち、diagnostics が引く | #644 本文「実装方針」 |
| 4 | 不明な組み合わせは「**適用される**」側に倒す（誤検出で赤線を出す方が害が大きい） | #644「スコープ外」節 |
| 5 | #645 は **2 箇所のみ**。宣言時の throw 79 箇所は扱わない | #645「🔴 スコープ」節 |
| 6 | #645 の推奨は**無音スキップ + ログ**（フォールバックは「黙って別の場所から音が出る」別種の驚き） | #645 本文・コメント 2 |
| 7 | #645 は `get_log` に出る = 信号なので**通常の E2E で検証できる。変異検証は不要** | owner 指摘・#645 コメント 2 |
| 8 | 順序は **#610 → #644 → 残り**。#645 は独立（engine 側） | 地図 §4.F「順序」 |
| 9 | #665 の A（tie 診断）は **#644 の表の 1 行**として扱い、#665 は閉じない | 地図 §4.F「統合」・#665 コメント 2 |

---

## 1. 到達点（1 文）

**「どの受け手に、どのメソッドが、効くのか」が TS の定数 1 枚になり、エディタの赤線・エンジンの実行時ガード・仕様書の表が**その 1 枚から**導かれ、演奏中に不整合を見つけても throw せずログに出して無音でスキップする。**

---

## 2. 現在地（一次情報・本書が変えるもの）

### 2.1 診断は今どこで作られるか（3 つの表面・どれも別物を見ている）

| 表面 | 実体 | 何を見ているか | 本書 |
|---|---|---|---|
| **静的診断**（赤線・`get_diagnostics`） | `extension.ts:3965-4116` `updateDiagnostics` → `diagnostics-analysis.ts` の 5 関数 + `plugin-name-diagnostics.ts` | **生テキストの正規表現**。パーサを一切通らない | §4 で `parseAudioDSL` + 適用可否解析に載せ替え |
| **評価表面**（`evaluate_orbitscore` の `ok:false` + `diagnostics`） | `repl-mode.ts:331` `pendingDiagnostics` → `:412-419` `//#evalMark` で返す | engine の parse / runtime エラー | §6（#620 の帰属） |
| **ログ**（`get_log` の `[ERROR]`） | `repl-mode.ts:364` / `:381` `console.error('[ERROR] …')` → 拡張の outputChannel → `log-ring` | 同上 + 演奏中の非同期失敗 | §5（#645 の出口） |

🔴 **静的診断とエンジンが別々の文法を見ている**のが #610 の実体。`updateDiagnostics` の呼び出しは
`extension.ts:421`（open）/ `:426`（change）/ `:441` の 3 箇所で、いずれも `document.getText()` を
正規表現で走査するだけ。`[1,5,9]@v+10` が受理されるのは、そもそも誰も構文を見ていないから。

### 2.2 IR は位置を持たない（#610 の最大の制約・実測）

```
$ sed -n '261,274p' packages/engine/src/parser/types.ts
export type SequenceStatement = { type: 'sequence'; target: string; method: string; args: any[]; invocation?: …; chain?: MethodChain[] }
export type MethodChain      = { method: string; args: any[]; invocation?: 'bare' | 'call' }
```

**`line` / `column` がどこにも無い。** トークン（`AudioToken`）は持っている（`tokenizer.ts:14-15` で
**1 始まり**）。パースエラーも位置を**メッセージ文字列に埋めている**だけで構造を持たない
（`parser-utils.ts:50-52` `Expected ${type} but got ${token.type} at line …, column …`）。
→ §4.2 / §4.3。

### 2.3 適用可否は今どこに散っているか

| 事実 | 根拠 | 本書 |
|---|---|---|
| `Sequence` の DSL 語彙は 32 語（`SEQUENCE_DSL_METHODS`） | `signal-chain/runtime.ts:37-70` | 表の列（§3.3） |
| 種別ガードを持つのは `output` / `send` / `effect` / `midi` / `instrument` / `audio` / `chop` / `routeOutputFromDsl` / `routeSendFromDsl` のみ | `sequence.ts` の `isMidi()`/`isInstrument()`/`isNoteSequence()` 分岐（§9 に全列挙） | 表へ移す（if は残す） |
| `hold` `voicelead` `vl` `cell` `density` `comp` `gate` `vel` `octave` `root` はガード 0 | `sequence.ts:784-920`（本文に分岐が無い） | 表の `warn` 行 |
| 🔴 **`gain` / `pan` / `defaultGain` / `defaultPan` は midi でも instrument でも効かない** | `gainManager` / `panManager` の読み手は `sequence.ts:1553-1554` / `:1635-1636`（**どちらも直前で `_audioFilePath` を要求**）と `:1872-1873`（`getState()` = 検査用）の 3 箇所だけ。note 経路（`scheduleMidiEvents`）が運ぶのは `note/velocity/detune/onTime/offTime` のみ（`:1370-1378`） | #644 の「要精査」への答え（§3.3・§15 (3)） |
| バス（sum/aux）の語彙は 2 語（`effect` / `ui`）で、Global/Sequence の語は `guardBusChain` が段階エラーで拒否 | `runtime.ts:74` / `:96-136` | 表の `sum` / `aux` 列 |
| output ノードは**レシーバを持たない**（無条件 throw） | `runtime.ts:293-313` `mixerNodeReceiver` | #611 §3.7 で解禁。表は行を持つだけ |
| 文 target の解決順は globals > sequences > mixer nodes で、衝突時に無警告 | `process-statement.ts:69-86`（#583 本文の `:66-74` は**古い**） | §7.3 |
| 一方 persistence 側は同じ衝突を loud に扱う | `global.ts:919-927` `Unknown sequence '…'; a same-named mixer bus exists.` | §7.3 の文言の手本 |
| 文字列形 `global.sum("drum")` は同名シーケンスを**検査しない**（node-decl 形 `var drum = mix.sum` だけが検査する） | `global.ts:482-489` → `mixerManager.sum` に検査なし / `runtime.ts:196-206` にはある | §7.3 |
| 拡張は engine のモジュールを **runtime require** できる（実績あり） | `extension.ts:657` `require('../engine/dist/audio/engine-backend')` / `:679` scsynth-resolver。engine の `dist` は `packages/vscode-extension/engine/` へコピーされる（root `package.json` `build:copy-engine`） | §4.1 の経路 |
| ただし補完の語彙表は**複製 + 同期テスト**という別方針 | `dsl-method-catalog.ts:1-15`（「拡張プロセスは engine のモジュールを import しない」と書いてあるが `extension.ts:657` は require している）/ `tests/vscode-extension/dsl-method-catalog.spec.ts` | §4.1 で方針を 1 本にする |

---

## 3. 適用可否の単一表（#644 の中心）

### 3.1 行の軸 = 受け手の種類

| `ReceiverKind` | 何 | 判定 |
|---|---|---|
| `audio` | `seq` + `audio()` / `chop()` | `hasAudioSource()`（`sequence.ts:702`） |
| `midi` | `seq` + `midi()` | `isMidi()`（`:616`） |
| `instrument` | `seq` + `instrument()` | `isInstrument()`（`:696`） |
| `seq-undeclared` | `seq` だが種別 verb がまだ無い | 上 3 つが全部 false |
| `sum` / `aux` | `mix.sum` / `global.sum("…")` ほか | `isMixerBusHandle` / `resolveMixerBus` |
| `output-node` | `mix.output(1,2)` / 暗黙 `master` | `MixerRuntimeNode.kind === 'output'` |
| `render-node` | `mix.render("…")`（**未実装** — #598 §3.1） | 行だけ置く（§3.5） |
| `master-line` | `master.output(…)`（**未実装** — #611 §3.5） | 同上 |

🔴 **`seq-undeclared` を行として持つのが要点。** 静的診断は文書全体を見るので、ファイル内のどこかに
`audio()` があれば `audio` に確定できる。**どこにも無ければ確定できない**ので、裁定 4 に従って
**診断を出さない**。「順番に書いている途中で赤線が出る」を避けるための行であって、抜け道ではない。

### 3.2 判定は 4 値だけ（増やさない）

| `Verdict` | 意味 | エディタ | 実行時 |
|---|---|---|---|
| `ok` | 使える | 無し | 適用される |
| `error` | その受け手では**書けない** | 🔴 Error | 今日 throw する（§3.3 の `runtime` 欄で明示） |
| `warn` | 書けるが**効かない**（記録だけされる） | 🟡 Warning | 無視される（**変えない** = 裁定 2） |
| `unknown` | 判定しない | 無し | 適用されるものとして扱う |

**4 値以外を増やさない。** 「場所ごとに診断の方針が割れる」（地図 §4.F の共通の問い）は、
判定語彙が増えるところから始まる。

### 3.3 表（コードから実測・main `ca176f0`）

`ok` = 空欄。`R` 欄 = 今日の実行時挙動（`throw` / `ignore` / `apply`）。

| メソッド | audio | midi | instrument | sum/aux | output-node | 実測根拠 |
|---|---|---|---|---|---|---|
| `quantize` `tempo` `beat` `length` | | | | `error` | `error` | `sequence.ts:192/219/226/233` ガード無し・種に依らない。バスは `guardBusChain`（`runtime.ts:100-109`）が拒否 |
| `gain` `defaultGain` | | 🟡`warn` R:ignore | 🟡`warn` R:ignore | `error` | `error` | 🔴 §2.3 の実測。読み手 3 箇所すべてが audio 経路 |
| `pan` `defaultPan` | | 🟡`warn` R:ignore | 🟡`warn` R:ignore | `error` | `error` | 同上 |
| `output(sum名)` | | 🔴`error` R:throw | | `error` | `error` | `sequence.ts:362-367` |
| `output(数値)` | | 🟡`warn` R:ignore ⟨**裁定待ち §15 (1)**⟩ | 🔴`error` R:throw | `error` | `error` | `:381-386`（instrument）/ midi は素通り。core spec `:1225` と一致 |
| `output("名前")` | | 🟡`warn` R:ignore ⟨同上⟩ | 🔴`error` R:throw | `error` | `error` | `:405-410` / core spec `:1226` |
| `send` | | 🔴`error` R:throw | | `error` | `error` | `:459-464` |
| `effect` | | 🔴`error` R:throw | | | `error` | `:713-718` / バスは `BUS_DSL_METHODS`（`runtime.ts:74`） |
| `ui` | 🟡`warn` R:ignore | 🟡`warn` R:ignore | | | `error` | `sequence.ts:678-693`: 引数無しは `openPluginUiIdempotent(name, 0)` = instrument 前提。**引数ありの catalog effect UI は audio でも意味がある**ので §15 (4) |
| `midi` | 🔴`error` R:throw | | 🔴`error` R:throw | `error` | `error` | `:598-603` |
| `instrument` | 🔴`error` R:throw | 🔴`error` R:throw | | `error` | `error` | `:634-638` |
| `audio` `chop` | | 🔴`error` R:throw | 🔴`error` R:throw | `error` | `error` | `:923-926` / `:945-949` |
| `hold` `voicelead` `vl` `cell` `density` `comp` | 🟡`warn` R:ignore | | | `error` | `error` | #644 本文の裏取り（`event-scheduler.ts` に `_hold` 等の参照 0 件）。`_hold` の読み手は `sequence.ts:1512` のノート解決経路のみ |
| `gate` `vel` `octave` `root` | 🟡`warn` R:ignore | | | `error` | `error` | 同上。`applyGateAndLegato`（`:1466`）/ `_vel`（`:1329`）は note 経路のみ |
| `play` `run` `loop` `stop` `mute` `unmute` | | | | `error` | `error` | 種に依らない |
| `play` に `[ ]` を含む | 🔴`error` R:throw | | | — | — | `:1242-1252` `validateNonMidiDispatch`（§10-5） |
| `play` に `_`（tie）を含む | 🟡`warn` R:ignore | | | — | — | **#665 (A)**。`calculate-event-timing.ts:269-279` が tie を **`sliceNumber: 0`**（= 無音）にし、`event-scheduler.ts:100`/`:139` はスライス 0 を発音しない → **audio では `_` は休符と同義**。`tieSlots` / `PlayTie` の参照は `packages/engine/src/audio/` に **0 件**（grep 実測）で、消費は `sequence.ts:1466` の note-off 時刻のみ |

**spec の表との食い違い**（§12 で直す）:

| # | spec | 実装 | 判定 |
|---|---|---|---|
| (a) | core spec `:1225-1226`「`output(数値)` / `output("名前")` は midi で**素通り**（#644 で診断予定）」 | 一致 | 表の `warn` 行として**実装で表現**する（予定を消す） |
| (b) | core spec `:941` `seq.root(1)` … `:953`「**`seq.root()` は numeric-degree-only**（`seq.root(1)`, `seq.root(b6)`）」 | 🔴 **`seq.root(b6)` も動かない**。`b6` は `parseArgument` → ACCIDENTAL → `parsePitch()`（`parse-expression.ts:478-488`）で `PlayPitch` オブジェクトになり、`Sequence.root(degree: number)`（`:906-920`）の `Number.isInteger` を通らない。そもそも signature に alteration が無い | **新規の乖離**（#280 の派生・§7.1） |
| (c) | `specs-v2/PITCH_DSL_SPEC_v1.1.md:160` `seq.root(C)` | 拒否（#280） | specs-v2 が古い。core spec `:953` は既に実装側へ倒してある（**#280 の裁定は片方の spec にだけ入っている**） |
| (d) | core spec §3「Slice-to-Slot Fitting」 | ✅ 済（#665 B'・`ee782327`） | — |

### 3.4 型と signature（貼れる形）

```ts
// packages/engine/src/diagnostics/applicability.ts（新規・pure・約 200 行のうち大半が表）

export type ReceiverKind =
  | 'audio' | 'midi' | 'instrument' | 'seq-undeclared'
  | 'sum' | 'aux' | 'output-node' | 'render-node' | 'master-line'

export type Verdict = 'ok' | 'error' | 'warn' | 'unknown'

export interface Applicability {
  readonly verdict: Verdict
  /** 診断本文。`{recv}` = 受け手の変数名 / `{m}` = メソッド名 に展開する。 */
  readonly message?: string
  /**
   * 🔴 今日の**実行時**挙動。診断の文面と実装の乖離を機械で検出するために持つ
   * （§11 の逆方向テストがこの欄と `sequence.ts` の分岐を突き合わせる）。
   */
  readonly runtime: 'throws' | 'ignores' | 'applies'
  /** 出どころ（spec 節 / issue 番号）。根拠の無い行を作らせない。 */
  readonly source: string
}

/** メソッド名 → 受け手種別 → 判定。載っていない組み合わせは {@link DEFAULT_APPLICABILITY}。 */
export type ApplicabilityTable =
  Readonly<Record<string, Readonly<Partial<Record<ReceiverKind, Applicability>>>>>

export const APPLICABILITY: ApplicabilityTable = { /* §3.3 の表 */ }

/** 裁定 4「不明なら適用される側に倒す」。**この既定を `error` にしてはいけない**。 */
export const DEFAULT_APPLICABILITY: Applicability = {
  verdict: 'unknown', runtime: 'applies', source: '既定（#644 スコープ外節）',
}

export function applicabilityOf(method: string, receiver: ReceiverKind): Applicability
```

```ts
// packages/engine/src/diagnostics/analyze-source.ts（新規・pure・約 150 行）

/** 位置は**トークンと同じ 1 始まり**（`tokenizer.ts:14-15`）。0 始まりへの変換は拡張の責務。 */
export interface DslDiagnostic {
  readonly line: number
  readonly column: number
  readonly endLine: number
  readonly endColumn: number
  readonly severity: 'error' | 'warning'
  readonly message: string
  /** 安定 ID（`parse/unexpected-token` / `applicability/hold-on-audio` …）。E2E とテストのアンカー。 */
  readonly code: string
}

/** パース → 種別解決 → 表引き。**投げない**（パース失敗も 1 件の診断にする）。 */
export function analyzeSource(source: string): DslDiagnostic[]
```

### 3.5 3 者が同じ表を読む形（#644 の「1 箇所に持つ」）

```
packages/engine/src/diagnostics/applicability.ts   ← 唯一の表（TS 定数）
  ├─ 拡張（静的診断）: extension.ts が analyze-source を **runtime require**（§4.1）
  ├─ 実行時（interpreter）: sequence.ts の既存 if は**残す**（裁定 2 で挙動は変えない）。
  │    ただし §11 の逆方向テストが「表の `runtime: 'throws'` 行 ⇔ 実際に throw する分岐」を照合する
  └─ spec: §12 の表を **`scripts/` で生成せず、テストで突き合わせる**（§11・生成物を repo に置かない）
```

🔴 **なぜ「表を読む」ではなく「表と照合する」のか**（interpreter 側）: 裁定 2 が「エンジンは一切
触らない」なので、if を表引きに**置き換える**のは #644 のスコープ外。表を**正**として、
if がそれに一致することをテストで固定する。置き換えは #611 / #643 の後続で自然に来る。

### 3.6 未実装の受け手（`render-node` / `master-line`）

行を**今から置く**。両方とも `mixerNodeReceiver`（`runtime.ts:293-313`）が今日 throw するので
全メソッドが `error` R:throw。#598 §3.1（render はレシーバにならない = 裁定 7）と #611 §3.7
（output ノードをレシーバにする）が入った時、**表の行を書き換えるだけ**で診断が追従する
— 列挙しておかないと #611 / #598 側で診断が後追いになる。

---

## 4. #610 — 拡張の診断を engine のパーサに載せる（🔴 前提・他の全部を塞いでいる）

### 4.1 経路: 拡張が engine の compiled JS を runtime require する

既存パターンをそのまま使う（`extension.ts:657` / `:679`。§2.3 最終行）。

```ts
// extension.ts:3965 updateDiagnostics の冒頭（正規表現群の前）
function analyzeWithEngine(text: string): DslDiagnostic[] | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const mod = require('../engine/dist/diagnostics/analyze-source') as {
      analyzeSource: (source: string) => DslDiagnostic[]
    }
    return mod.analyzeSource(text)
  } catch (err) {
    // 🔴 握り潰さない。require が壊れたら「診断が減った」ことに気づけないと #610 の再発になる。
    outputChannel?.appendLine(
      `⚠️ engine diagnostics unavailable — falling back to regex analyzers: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
    return undefined
  }
}
```

- 位置の変換は**この 1 箇所**: `new vscode.Range(d.line - 1, d.column - 1, d.endLine - 1, d.endColumn - 1)`。
  engine 側は 1 始まり（トークンと同じ）、VS Code は 0 始まり、`get_diagnostics` が再び +1 する
  （`extension.ts:3564-3565`）ので、**agent から見える番号は今日と同じ**
- **`dsl-method-catalog.ts` の複製方針との衝突**（§2.3）は本 PR で解消する: 補完の語彙は
  「拡張プロセスの起動時に常に要る」ので複製 + 同期テストのまま、**診断は require** にする。
  この線引きを `dsl-method-catalog.ts:6-9` のコメントへ書く（「import しない」は事実に反する）

### 4.2 パースエラーに位置を構造で持たせる（`ParseError`）

```ts
// packages/engine/src/parser/parse-error.ts（新規・約 20 行）
export class ParseError extends Error {
  constructor(
    message: string,                       // 🔴 文言は**一字も変えない**（下の理由）
    readonly line: number,                 // 1 始まり
    readonly column: number,
    readonly tokenType?: string,
  ) { super(message); this.name = 'ParseError' }
}
```

🔴 **メッセージ文字列を変えてはいけない。** `repl-mode.ts:363` が `/\bEOF\b/.test(error.message)` で
「複数行入力の途中」を判定している。ここを壊すと **#607 / #608 の「セッションが沈黙のまま
永久停止」が再発する**（同ファイルのコメント `:352-362` が実害を記録している）。
`ParseError` は **`Error` の subclass として位置フィールドを足すだけ**。

変換対象は `parser-utils.ts:50-52` の `expect`（位置付きの唯一の共通経路）+ `parse-expression.ts`
28 件 / `parse-statement.ts` 18 件のうち**位置を持てるもの**。位置が取れないものは
`ParseError` にせず素の `Error` のまま残し、`analyzeSource` が「ファイル先頭 1 行目」に落とす
（**推測の位置を書かない**）。

### 4.3 `analyzeSource` の中身（IR には位置が無い → 4 箇所で足す）

```ts
// parser/types.ts に追加（**この 3 型だけ**）
export interface SourceSpan { line: number; column: number; endLine: number; endColumn: number }
export type SequenceStatement = { …; span: SourceSpan }
export type GlobalStatement   = { …; span: SourceSpan }
export type MethodChain       = { …; span: SourceSpan }
```

構築箇所は **4 箇所だけ**（実測）で、いずれもメソッドの IDENTIFIER トークンを手に持っている:

| 箇所 | 何を書く |
|---|---|
| `parse-statement.ts:614`（`type: 'sequence'` を組む） | 文頭の target トークン 〜 メソッド名トークン |
| `parse-statement.ts:709`（bare 形） | 同上 |
| `parse-statement.ts:678`（`chain.push({ method, args })`） | `chainMethodResult.token` の line/column 〜 `+ method.length` |
| `parse-statement.ts:680`（bare hop） | 同上 |

`analyzeSource` の手順:

```
1. parseAudioDSL(source)  → 失敗なら ParseError を 1 件の DslDiagnostic（code 'parse/…'）にして return
2. IR から種別マップを作る: seqInits で名前を集め、statements/chain を走査して
   audio()/midi()/instrument() を見つけた名前に ReceiverKind を割り当てる（見つからなければ 'seq-undeclared'）
   — mixer は mixer_init / mixer_node_decl と global.sum("…")/aux("…") から
3. もう一度 statements/chain を走査し、(method, receiverKind) を APPLICABILITY で引く
4. verdict が 'error' / 'warn' の行だけ DslDiagnostic にする（span はそのホップのもの）
```

### 4.4 段階（#610 と #644 を同じ PR にしない）

| 段階 | 出すもの | なぜ分けるか |
|---|---|---|
| **PR-D1（#610）** | パースエラーだけを赤線にする。**既存の正規表現アナライザは残す** | 「diagnostics クリーン = エンジンが受理」を**最短で**成立させる。#610 の受け入れ（エンジンが拒否する構文で赤線が出る）はこれで満たす |
| **PR-D2（#644）** | 適用可否の表 + `analyzeSource` の 2〜4 段 | 表は #610 が無いと種別を確定できない（正規表現では `audio()` と `midi()` を確実に分けられない） |
| **PR-D3** | 正規表現アナライザのうち**表で置き換えられたもの**を落とす | `analyzeLinkAudioMissingOutput`（`diagnostics-analysis.ts:300-390`）は「シーケンス名の正規表現を全行に当てる」実装で、`kicker` が `kick` に当たらないよう `\b` で防いでいる — IR ならこの手当てが**要らなくなる**。ただし**落とすのは E2E で同値を確認してから**（§11） |

---

## 5. #645 — 演奏中の throw 2 箇所（`must-fix`）

### 5.1 現在地の訂正（issue の行番号は古い）

| issue の記載 | main `ca176f0` の実測 |
|---|---|
| `sequence.ts:1505` `resolveDispatchChannel()` | **`sequence.ts:1609`**（メソッド定義は `:1593`） |
| 呼び出し元は `:1467` / `:1549` / `:1570` | **`:1571`（`scheduleEventsFromTime`）/ `:1653`（`scheduleEvents`）/ `:1674`（`run()`）/ `:1721`（`loop()`）** |
| `event-scheduler.ts:18` `resolveAudioFilePath()` | 一致（`:16` 定義・`:18` throw）。呼び出し元は `:95` / `:182` |

### 5.2 到達経路ごとの今日の挙動（**すでに掴まれている経路がある**）

| # | 経路 | 今日 | 直すか |
|---|---|---|---|
| 1 | `run()` `:1674` / `loop()` `:1721`（eager・await 連鎖） | REPL が `[ERROR]` → **その評価ブロックの以降の文が実行されない**。鳴っているものは止まらない | ✅ 直す |
| 2 | 🔴 `seamlessParameterUpdate` `:273` → `scheduleEventsFromTime` `:1571`。**`gain` / `pan` / `audio` / `chop` / `tempo` / `beat` / `length` / `play` のセッターから同期で入る** | 演奏中に `kick.gain(-6)` と書くだけで throw → 評価ブロックが落ちる | ✅ 直す（**issue が書いていない経路**） |
| 3 | `unmute()` `:1839` → 同上 | 同上 | ✅ 直す |
| 4 | ループタイマー `loop-sequence.ts:187` / `:197` | **`safeSchedule`（`:115-126`）が既に catch** して `${name}: loop scheduling error:` を出し、ループは生き続ける | 文言を揃えるだけ |
| 5 | ループ初回 `loop-sequence.ts:104` / `run-sequence.ts:56` | 1 と同じ（await 連鎖の中） | 1 と同時に解決 |

**#645 の「ライブ中に kick が止まる」の再現条件**は 2 が最も現実的である。1 は「そのブロックが
走らない」、4 は「既に無害化されている」。**issue 本文の記述（1 だけ）より広い。**

### 5.3 直し方: `undefined` の多義を型で潰す

今日の signature は `resolveDispatchChannel(): string | undefined` で、**`undefined` = 「LinkAudio
off だからハードウェアバス」**を意味する（`:1585-1586`）。ここでエラー時に `undefined` を返すと
**黙ってハードウェアから音が出る** — #645 が「別種の驚き」として名指しした挙動そのもの。

```ts
// packages/engine/src/core/sequence.ts
/** 発音先の解決結果。🔴 `undefined` は使わない — hardware と skip は**別の値**でなければならない。 */
export type DispatchTarget =
  | { readonly kind: 'hardware' }                       // LinkAudio off（今日の undefined）
  | { readonly kind: 'link'; readonly channel: string } // LinkAudio on + output 済み
  | { readonly kind: 'skip'; readonly reason: string }  // LinkAudio on + output 未設定 → 無音（裁定 6）

resolveDispatchChannel(): DispatchTarget   // throw しない
```

- `scheduleEvents` `:1653` / `scheduleEventsFromTime` `:1571`: `kind === 'skip'` なら
  **スケジュールせずに return**（そのシーケンスだけ無音。他は継続）
- `run()` `:1674` / `loop()` `:1721`: eager 呼び出しは**残す**（早く気づける）が、throw ではなく
  `logSkipOnce()` を呼ぶだけにする
- ログの重複抑止: `_dispatchSkipLoggedFor?: string` を持ち、**理由が変わった時と `output()` が
  設定された時にリセット**する。ループは毎小節ここを通るので、抑止が無いと `get_log` の
  500 行窓（`log-ring`）を 1 シーケンスが埋め尽くす
- 出口: `console.error('[ERROR] Sequence …: <reason> — このシーケンスは無音でスキップします。')`
  → 拡張の outputChannel → `get_log`（§2.1）

```ts
// packages/engine/src/core/sequence/scheduling/event-scheduler.ts
/** 絶対パスでなければ `undefined`（呼び出し元が 1 件ログして skip する）。🔴 throw しない。 */
function resolveAudioFilePath(audioFilePath: string, sequenceName: string): string | undefined
```

`:95` / `:182` の 2 箇所で `if (!resolvedFilePath) { console.error('[ERROR] …'); return }`。
**「内部エラーだから到達不能」の前提は検証しない**（#645 本文: 不在証明は机上推論で確定させない）
— 到達したらログに出る、という形にすれば前提の真偽を実測に委ねられる。

### 5.4 #643 PR-3 との関係

#645 コメント 1 は「#643 PR-3 と同じ PR で出す予定」としている。本書は **PR-D0 として独立**を推す
（§13）。理由: #645 は `must-fix` で `foundation` である #610 にも #643 にも依存せず、
上の 2 ファイルだけで閉じる。#643 PR-3 に相乗りさせると、instrument → LinkAudio の配線が
決まるまで `must-fix` が出荷されない。

---

## 6. #620 — 診断の帰属（まず実機再現）

`repl-mode.ts:331` `pendingDiagnostics` は**マーカー間のグローバル蓄積**で、`:412-413` の
`//#evalMark` が全部回収してクリアする。マーカーを送らない投入経路は `runSelection`
（`extension.ts:2873` が `writeCodeToEngine` を呼ぶだけ。`evaluateForAgent` `:3059` だけが
`evalMarkBridge.send` を使う）。**構造上、#620 は成立する。**

🔴 **再現が先**（issue の「検証すべきこと」）。E2E-620-A（§11）が再現の実体であり、
**赤にならなければ設計は捨てる**（どこかに別の防御がある）。

再現したときの対処は **選択肢 3（マーカー無し経路にも暗黙のマーカーを付ける）** を推す:

- `writeCodeToEngine` は `runSelection` / `evaluateForAgent` の**両方が通る唯一の口**
  （`extension.ts:2873` / `:3045`）。ここで常にマーカーを送れば経路が揃う
- #694 §4 / #611 §3.9 が**同じ場所に `//#evalBegin` / `//#evalEnd` フレームを入れる**。
  フレームの終端が「提出の境界」なので、**`//#evalEnd` を診断の回収点として兼ねられる**
  （新しい機構を作らない）
- 選択肢 1（投入前 flush）は往復 2 回、選択肢 2（tagging）は `executeCurrentBuffer` まで
  識別子を運ぶ配線が要る。**フレームが入るなら 3 が最も安い**

→ #620 の実装は **#694 PR-L2 / #611 PR の後**。それまでは §11 の再現テストだけを持つ。

---

## 7. 残りの issue を表の行へ

### 7.1 #280 — `seq.root()`（🔴 spec が 2 つに割れている）

| 事実 | 根拠 |
|---|---|
| `seq.root(C)` は runtime 拒否 | `sequence.ts:911-919` / `parse-expression.ts:809-813` |
| **core spec は既に実装側へ倒してある**（`:953`「numeric-degree-only」・「Using a note name at seq level is an error (#280)」） | `INSTRUCTION_ORBITSCORE_DSL.md:953-955` |
| **specs-v2 は倒していない**（`seq.root(C) // シーケンス既定のピッチコンテキスト`） | `PITCH_DSL_SPEC_v1.1.md:160` |
| 🔴 core spec 自身の例 `seq.root(b6)` も**動かない**（§3.3 (b)） | `parse-expression.ts:478-488` → `sequence.ts:911` |

**#280 は「どちらに倒すか owner 判断」（地図 §4.F）だが、core spec は既に片方へ倒れている。**

✅ **owner 裁定（2026-09-03 Q-610-2）: B「実装を spec に」— `seq.root()` は note-name（`C` / `b6` 等）も受ける。**
owner:「既に実装されているならそれを使ってよい。キーと関係なく矯正できる」。帰結:
- `sequence.ts:906-920` の signature を `root(value: number | PlayPitch)` に広げ、note-name は**絶対ピッチ**として解決（`key` と無関係に root を固定できる = owner の「矯正」）
- `parse-statement` の引数解釈は既に `PlayPitch` を作る（`parse-expression.ts:478-488`）ので、runtime 拒否（`:911`）を外す側の変更
- core spec `:953-955` を「numeric-degree-only」から「数値 = 度数・note-name = 絶対ピッチ」へ**戻す**（specs-v2 `:160` はそのまま正）
- 表: `root × seq-*` は `ok`。引数型の検査は表ではなく引数スキーマ（§14 の予想どおり「引数スキーマ欄」が要る）
- PR: **PR-D7** `feat(dsl): accept note names in seq.root()`（PR-D1 の後・E2E: `seq.root(C)` と `seq.root(b6)` で capture の基本周波数が変わる = `estimateFundamentalHz`）

### 7.2 #255 — リゾルバ端（🔴 1 は**既に実装済み**）

| 項目 | 現在地 |
|---|---|
| 1. 未束縛名がスロットを消す vs 休符 | ✅ **休符（推奨 a）で実装済み**。`resolve-chords.ts:99-105`「#255: an unbound standalone name is rendered as a REST … (decision: a)」。`warnings` は `sequence.ts:977-979` で `console.warn` に出る | 
| 2. 空パターン束縛 `var x = ()` | ❌ 未対応。`parsePatternBinding`（`parse-statement.ts:334-369`）は空を作れる。`processPatternBinding`（`process-statement.ts:346-352`）も無検査 |

- 1 は **issue 本文とチェックリストが古い**（§16 の「不要」候補）。spec（§6/§6.5）への明記だけ残る
- 2 は **`analyzeSource` の 1 診断**にする（`code: 'binding/empty-pattern'`・Warning）。
  パーサで拒否すると**ライブコーディング中に書きかけの `var x = (` が赤で止まる**ので、
  裁定 1（実行を止めない）に従い parser reject は採らない
- リゾルバの `warnings` は今 `console.warn` にしか出ない（= `get_log` には出るが `[ERROR]` ではない）。
  **静的診断にも同じ文言を出す**のが「3 者が同じ表を読む」の帰結だが、warnings はテキストではなく
  IR 解決の結果なので、`analyzeSource` からは**束縛の有無しか見えない**。
  → `analyzeSource` は「未束縛名」を検出できる（`chord_binding` / `pattern_binding` / `import` を集める）。
  **`import chords` の中身までは見えない**ので、import があるファイルではこの診断を出さない（裁定 4）

### 7.3 #583 — 文 target の名前空間

| 穴 | 根拠 | 直し方 |
|---|---|---|
| (i) 同名の seq と sum/aux が併存すると `drum.effect(X)` が黙ってシーケンス側 | `process-statement.ts:69-86` の順（globals > sequences > mixer nodes） | **文字列形の宣言側で塞ぐ**: `global.sum(name)` / `aux(name)` が同名 seq/global を見つけたら throw。node-decl 形（`runtime.ts:196-206`）が**既にやっている**ことを文字列形にも入れるだけで、非対称が消える。文言は `global.ts:919-927` に揃える |
| (ii) `seq.output("drum")` で `drum` が aux のみ宣言済みだと LinkAudio 名として解釈され、無関係な warn | `sequence.ts:354-374` が `resolveSumBus` しか見ない → `:425-430` の「without 'global.linkAudio()'」warn | `resolveMixerBus`（`global.ts:502-504`・kind 込み）へ変える。aux ヒット時は「aux は `send()` の宛先。`output()` は sum を指す」と**実状に即した**エラー |

(i) は**破壊的になり得る**（今日 `global.sum("kick")` と `var kick = init global.seq` が同居する譜面は
throw するようになる）。ただし **その譜面は今日すでに壊れている**（`drum.effect` がバスへ行かない）ので、
本書は「静かな誤動作 → loud」を破壊的変更に数えない。§15 (5) に置いて owner に確認する。

(ii) は表の行にならない（**引数の値**に依存する診断）。`analyzeSource` は
`global.sum("…")` / `global.aux("…")` / `mix.sum` / `mix.aux` の宣言を集めるので、
**静的にも判定できる** — `output(<aux 名>)` は `code: 'routing/output-targets-aux'` の Error。

### 7.4 #609 — スタック全体 `@v`

- 現状: `([1,5,9]@v+10, _, 0)` はパーサ未対応。`parseStack`（`parse-expression.ts:1059-1092`）は
  `]` の後に **`^N` だけ**を受ける（`:1085-1091`）
- **#610 が入れば、この構文には自動的に赤線が出る**（パースが落ちるので）。#609 の「採らない場合」
  （誘導エラー）は **#610 の副産物として満たされる**が、文言は `Expected RPAREN but got AT` のままで
  誘導になっていない
- 誘導文言を出すには `parseStack` の `]` 後に **AT を明示的に検出して専用の `ParseError`** を投げる
  （数行）。「per-voice に展開してください」を出す。**仕様に足すかどうかとは独立に実装できる**
- ✅ **owner 裁定（2026-09-03 Q-610-6）: A 足す** — `[...]@v` は各 voice へ分配し、voice 側の `@v` が勝つ。`parseStack`（`parse-expression.ts:1059-1092`）の `]` 後に AT を受けて stack 全体の velocity を各 `PlayPitch` に写す + spec §2.5 に規範を足す。**PR-D5 の範囲が「誘導文言」から「実装」へ広がる**（+40 行程度・E2E: `[1,5,9]@v+10` と `[1@v+10,5@v+10,9@v+10]` の capture RMS が一致）

### 7.5 #665 (A) — audio の tie

表の最終行（§3.3）。`code: 'applicability/tie-on-audio'` の Warning。
文言は「audio シーケンスの `_` は **`0`（休符）と同じ**で、直前の音を伸ばさない。
非 chop / `chop(1)` はファイル全体が自然尺で鳴り、`chop(n>1)` はスロット尺へ詰められる
（core spec §3）」。

✅ **owner 裁定（2026-09-03 Q-610-7）: B 与える**（「表現として面白い。両方できるとよい」）。帰結:
- `chop(n>1)` の `_` は**直前スロットを伸ばす**（`event-scheduler.ts` の `eventSlotDuration` を tie の個数ぶん加算）。#665 の varispeed のとおり**時間が伸びればピッチは下がる**
- 「両方」= ピッチを保ったまま伸ばす方は **#213 の `time()` / `fixpitch()`（Signalsmith）** の領分。tie の意味論は本書、伸ばし方の選択は #213 が担う（表現を 2 種類持てる）
- 表の行は `warn` → `ok`（`chop(1)` / 非 chop は従来どおり `_` = 休符と同義のまま `warn`）。PR-D3 の 1 行 + `event-scheduler.ts` の変更は #665 側の PR

---

## 8. データの通り道 1 本（端から端まで）

```
[編集] OrbitStudio で .orbs を開く / 打鍵
  → extension.ts:421 / :426 / :441  updateDiagnostics(document, collection)
  → analyzeWithEngine(text)                            // §4.1 runtime require（失敗なら正規表現へ縮退 + ログ）
      → engine/dist/diagnostics/analyze-source.js
          → parseAudioDSL(source)                      // parser/audio-parser.ts:121
              └ 失敗 → ParseError{line,column}         // §4.2（文言は不変・repl-mode の EOF 判定を壊さない）
          → 種別マップ（audio / midi / instrument / seq-undeclared / sum / aux / output-node）
          → 各 (method, kind) を APPLICABILITY で引く  // §3.4
          → DslDiagnostic[]（1 始まり）
  → new vscode.Range(line-1, column-1, …) + severity   // 変換はここ 1 箇所
  → collection.set(document.uri, diagnostics)          // extension.ts:4116
[観測] MCP get_diagnostics(path)
  → getDiagnosticsForAgent (extension.ts:3550-3578)    // line+1 / character+1 で 1 始まりへ戻す
[評価] run_selection / evaluate_orbitscore
  → writeCodeToEngine (extension.ts:3000)              // #620: ここが唯一の共通の口
  → engine stdin → repl-mode.executeCurrentBuffer
      → parse 失敗 → console.error('[ERROR] …') + pendingDiagnostics.push({kind:'parse'})
      → 実行時 throw → 同上（kind:'runtime'）
  → //#evalMark → {"evalMark":{requestId, ok, diagnostics}} → evalMarkBridge → evaluate_orbitscore の ok:false
[演奏中] loop timer → scheduleEvents → resolveDispatchChannel()  // §5.3
  → {kind:'skip'} → console.error('[ERROR] … 無音でスキップ') → outputChannel → log-ring → get_log
  → **throw しない**（他のシーケンスは鳴り続ける）
```

---

## 9. 呼び出し元の全列挙（grep 実行結果・main `ca176f0`）

```
$ grep -rn "resolveDispatchChannel" packages/engine/src --include=*.ts
packages/engine/src/core/sequence.ts:395:      // 次の schedule で `resolveDispatchChannel()` が「has no .output() channel set」を
packages/engine/src/core/sequence.ts:1571:      outputChannel: this.resolveDispatchChannel(),
packages/engine/src/core/sequence.ts:1593:  resolveDispatchChannel(): string | undefined {
packages/engine/src/core/sequence.ts:1653:      outputChannel: this.resolveDispatchChannel(),
packages/engine/src/core/sequence.ts:1674:    this.resolveDispatchChannel()
packages/engine/src/core/sequence.ts:1721:    this.resolveDispatchChannel()

$ grep -rn "resolveAudioFilePath" packages/engine/src --include=*.ts
packages/engine/src/core/sequence/scheduling/event-scheduler.ts:16:function resolveAudioFilePath(audioFilePath: string): string {
packages/engine/src/core/sequence/scheduling/event-scheduler.ts:95:  const resolvedFilePath = resolveAudioFilePath(audioFilePath)
packages/engine/src/core/sequence/scheduling/event-scheduler.ts:182:  const resolvedFilePath = resolveAudioFilePath(audioFilePath)

$ grep -n "updateDiagnostics" packages/vscode-extension/src/extension.ts
421:        updateDiagnostics(document, diagnosticCollection)
426:        updateDiagnostics(event.document, diagnosticCollection)
441:      updateDiagnostics(document, diagnosticCollection)
3965:async function updateDiagnostics(

$ grep -n "analyze[A-Z]" packages/vscode-extension/src/extension.ts | grep -v import
4044:  for (const issue of analyzeGlobalOncePerFile(text)) {
4053:  for (const issue of analyzeAudioPathOrdering(text)) {
4062:  for (const issue of analyzeOutputWithoutLinkAudio(text)) {
4074:  for (const issue of analyzeLinkAudioMissingOutput(text)) {
4085:  for (const issue of analyzeEmptyOutputArg(text)) {
4104:  for (const issue of analyzeUnknownPluginNames(text, loadPluginCatalog()?.plugins)) {

$ grep -n "isMidi()\|isInstrument()\|isNoteSequence()" packages/engine/src/core/sequence.ts
362:    if (this.isMidi()) {        # output(sum名) を拒否
381:    if (this.isInstrument()) {  # output(数値) を拒否
405:    if (this.isInstrument()) {  # output("名前") を拒否
459:    if (this.isMidi()) {        # send() を拒否
489:    if (this.isMidi()) {        # routeOutputFromDsl を拒否
506:    if (this.isMidi()) {        # routeSendFromDsl を拒否
598:    if (this.isInstrument()) {  # midi() を拒否
616:  isMidi(): boolean {
634:    if (… || this.isMidi()) {   # instrument() を拒否
696:  isInstrument(): boolean {
713:    if (this.isMidi()) {        # effect() を拒否
731:    if (!this.isInstrument() || !this._insertBus) return …
774:  isNoteSequence(): boolean {
923:    if (this.isNoteSequence()) {  # audio() を拒否
945:    if (this.isNoteSequence()) {  # chop() を拒否
1007:    return this.isNoteSequence() ? … : …
1016:    if (this.isMidi()) { … } else if (this.isInstrument()) { … }
1140:    if (!this.isNoteSequence()) return   # validateMidiDispatch
1172:    if (!this.isNoteSequence()) return
1243:    if (this.isNoteSequence()) return    # validateNonMidiDispatch（[ ] in audio）
1416:    if (this.isInstrument()) {           # resolveNoteTarget
1434:    if (!this.isInstrument() || detune === 0) return detune
1543:    if (this.isNoteSequence()) {         # scheduleEventsFromTime の早期分岐
1602:    if (this.isNoteSequence()) {         # resolveDispatchChannel の MIDI 免除
1625:    if (this.isNoteSequence()) {         # scheduleEvents の早期分岐
```

**この 25 行が §3.3 の表の `runtime` 欄の全根拠**であり、§11 の逆方向テストが照合する対象。

---

## 10. 失敗モード（握り潰される経路が無いこと）

| 状況 | 挙動 | 出口 |
|---|---|---|
| `require('../engine/dist/diagnostics/…')` が失敗（stale dist・ビルド漏れ） | 正規表現アナライザへ縮退 | ⚠️ 1 行を outputChannel（**黙って診断が減らない**）。`mcp-server-stale-dist.spec.ts` と同型 |
| `analyzeSource` が例外を投げた | 縮退 + ⚠️ | 同上。`analyzeSource` 自体は**投げない契約**なので、投げたらそれ自体がバグ |
| パースエラーが位置を持たない（`ParseError` でない素の `Error`） | 1 行目・1 桁目に落とす | 診断は出る。**推測の位置を書かない** |
| 種別が確定できない（`seq-undeclared`） | 診断を出さない | 裁定 4 |
| `import chords` があるファイルの未束縛名（#255） | 診断を出さない | 裁定 4（§7.2） |
| 表に無い (method, kind) | `unknown` → 診断なし | `DEFAULT_APPLICABILITY`（§3.4） |
| 表に載せ忘れた新メソッド | **テストが red**（§11 の全数テスト） | — |
| 表と実装の乖離（`runtime:'throws'` なのに throw しない） | **テストが red**（§11 の照合テスト） | — |
| #645: LinkAudio on + `.output()` 未設定で `run()`/`loop()` | 無音スキップ・他は継続 | `[ERROR] … 無音でスキップします` → `get_log`（1 回だけ） |
| #645: 同上で毎小節ループ | ログは**理由が変わるまで 1 回** | 500 行窓を埋めない |
| #645: `.output()` を後から設定 | 抑止フラグをリセット → 次の skip があれば再度ログ | 直った/直っていないが観測できる |
| #645: 絶対パスでない audio path | 無音スキップ + `[ERROR]` | `get_log`。到達不能の前提を実測に委ねる |
| #620: マーカー無し経路の診断 | （再現後）フレーム終端で回収 | `evaluate_orbitscore` が他人のエラーを返さない |
| 診断の位置変換ミス（1 始まり ↔ 0 始まり） | — | 変換は `extension.ts` の 1 箇所。unit で往復を固定（§11） |

---

## 11. E2E とテスト（すべて MCP 経由・`ok` に assert しない・ERROR は `<=`）

| # | シナリオ（MCP ツールだけで駆動） | 判定 |
|---|---|---|
| **E2E-D1**（#610 受け入れ） | 新 fixture `tests/fixtures/mcp-e2e/engine_rejects_case.orbs` に `([1,5,9]@v+10, _, 0)` を書く → `open_file` → `get_diagnostics(path)` | `severity === 'error'` の診断が **1 件以上**。`message` が `AT` を含む（誘導文言を入れたら `code` でアンカーする）。**評価は一切しない**（`diagnostic_case.orbs` と同じ「開くだけ」の性質） |
| **E2E-D2**（#610 の対偶） | 既存 `tests/fixtures/mcp-e2e/kick_loop.orbs` を `open_file` → `get_diagnostics` → `set_selection` 全体 → `run_selection` | 診断 0 件 **かつ** `get_log` の `[ERROR]` が `<=` 既定値。**「クリーン = 受理」を両側から押さえる**のがこのテストの本体 |
| **E2E-D3**（#644 warn） | `kick.audio("…").hold().voicelead().octave(2)` の fixture → `open_file` → `get_diagnostics` | `severity === 'warning'` が 3 件以上・`message` に `hold` / `voicelead` / `octave` が現れる。**同じファイルを `run_selection` して音が出る**（capture RMS > 0）= 裁定 2「実行時の挙動は変わらない」の証明 |
| **E2E-D4**（#644 error / midi） | `melody.midi("…", 1).send("verb", -6)` | `severity === 'error'` が 1 件。`run_selection` すると `get_log` に `[ERROR]` が現れる（表の `runtime:'throws'` と一致） |
| **E2E-D5**（#665 A） | `gong.audio("…").chop(1).play(1, _, 0, 0)` を録り、続けて `play(1, 0, 0, 0)` を録る | tie の Warning が 1 件。**2 つの capture の窓 RMS 列が一致**（`_` が休符と同義であることの数値証明・§3.3 最終行の `sliceNumber: 0` 経路） |
| **E2E-D6**（#583 (ii)） | `global.aux("verb")` + `kick.output("verb")` | `severity === 'error'`（`output` は sum を指す）。`run_selection` の `get_log` に **LinkAudio の warn が出ない** |
| **E2E-645-A**（#645 受け入れ） | `global.linkAudio()` + `.output()` 無しの `kick` を `run_selection` で LOOP → **その後**別の選択で `snare` を LOOP | capture WAV の窓 RMS で **snare が鳴っている**（> 0）。`get_log` に `無音でスキップ` を含む行が **1 件以上**。ERROR 総数は `<=` |
| **E2E-645-B**（#645 経路 2・§5.2） | 645-A の状態で `kick.gain(-6)` だけを `run_selection` | 続く `evaluate_orbitscore('snare.gain(-3)')` の `diagnostics` に kick 由来の文言が**含まれない**、かつ capture RMS で snare の音量が変わる（= 評価ブロックが落ちていない） |
| **E2E-620-A**（#620 再現・🔴 まずこれ） | `run_selection` で構文エラーを出す → 続けて `evaluate_orbitscore('global.tempo(120)')` | **再現テスト**: `result.diagnostics` に前の選択のエラー文言が含まれたら #620 は実在。修正後は含まれない |

**ラチェット**（`tests/e2e/dsl-e2e-coverage.spec.ts`）: 本書は **DSL 語を 1 つも足さない**ので baseline は
不変。ただし E2E-D3 が `hold` / `voicelead` / `octave` を、E2E-D5 が `chop` を実機で評価するので、
`SEQUENCE_UNCOVERED_BASELINE` から **`hold` / `voicelead` / `octave` を消せる**（減らす方向は常に可）。
消さないと「keeps the baseline honest」テストが red になる（`:127-135`）。

**ユニット / 逆方向テスト**（`tests/interpreter/signal-chain-dispatch.spec.ts` に足す。**新しい機構を作らない**）:

| テスト | 契約 |
|---|---|
| 全数 | `SEQUENCE_DSL_METHODS` ∪ `GLOBAL_DSL_METHODS` ∪ `BUS_DSL_METHODS` の**全語が `APPLICABILITY` に載っている**（#644 受け入れ「載せ忘れを検出」） |
| 照合 | 表の `runtime: 'throws'` 行 ⇔ 実際に `Sequence` を作って呼ぶと throw する。**`ignores` 行は throw しない**。§9 の 25 行との突き合わせを機械化する |
| 既定 | `DEFAULT_APPLICABILITY.verdict === 'unknown'`（裁定 4 が `error` に反転していないこと） |
| 位置 | `analyzeSource` の各診断の `line`/`column` が **1 始まり**で、そのオフセットのテキストがメソッド名で始まる |
| 縮退 | `analyzeWithEngine` が require 失敗時に `undefined` を返し、正規表現アナライザの結果が残る（`tests/vscode-extension/` に `vscode` モック経由で） |

**変異検証は提案しない**（CLAUDE.md の順序: 仕様 → MCP 経由 E2E → 機能テスト → それでも
捕まらない時だけ）。#645 は owner が明示的に「ログに出る = 信号なので通常の E2E で検証できる」
と述べている（裁定 7）。

---

## 12. spec 改訂（実装より先・運用規則 6）

| spec | 節 | 改訂 |
|---|---|---|
| `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` | 新設（PH.4 の表 `:1223-1226` の位置） | 🔴 **適用可否の表**を §3.3 の形で本文に置く。今の表は「midi × instrument」の 2 列 3 行だけで、audio 列も `hold` 系の行も無い。「素通り（#644 で診断予定）」→「**素通り（エディタが Warning）**」 |
| 同 | `:953-955`（P.5） | `seq.root(b6)` を例から**外す**（§3.3 (b)・実装が受けない）。または #15 (2) の裁定で実装側を直す |
| 同 | §8.1.2（LinkAudio strict mode） | 「`.output()` 未設定は**ハードエラー**」→「**エディタが Error・実行時は無音でスキップしてログに出す**」（#645） |
| `docs/specs-v2/PITCH_DSL_SPEC_v1.1.md` | `:160` | `seq.root(C)` を core spec `:953` と揃える（**2 つの spec が違うことを言っている**のが今の状態） |
| 同 | §6 / §6.5 | #255-1 の決定（未束縛名 = 休符 1 スロット保持 + warning）を**明記**する。実装は済んでいるのに spec に無い |
| `docs/design/611-output-line-design.md` | §3.7 | 「`mixerNodeReceiver` が output で throw」を解く時、**本書 §3.3 の `output-node` 列を同じ PR で書き換える**と 1 行足す（後追いを防ぐ） |
| `docs/design/598-render-endpoint-design.md` | §3.1 | 同様に `render-node` 列（裁定 7「レシーバにならない」）を参照させる |

---

## 13. PR 分割

| PR | 内容 | 対象チェックリスト | 触るファイル / 概算 | 依存 | 検証 | 一方通行 |
|---|---|---|---|---|---|---|
| **PR-D0** `fix(engine): contain the two playback-path throws and log the skip` | §5 全部 | #645 の 1・2・3 項 | `sequence.ts`（+60/-20）/ `event-scheduler.ts`（+20/-8）/ unit | **無し**（独立） | E2E-645-A / -B。実機 MCP: linkAudio 譜面を `run_selection` → `get_log` | `resolveDispatchChannel` の戻り型（内部 API・DSL 表面ではない） |
| **PR-D1** `docs(spec): one applicability table for receivers and methods` | #644 の表の**仕様側**・#280 の spec 1 本化・#255-1 の明記 | #644-1 の前段 / #280 / #255-1 | `INSTRUCTION_ORBITSCORE_DSL.md` / `PITCH_DSL_SPEC_v1.1.md`（docs のみ） | — | docs のみ（`/simplify` 不要・advisor 相談） | — |
| **PR-D2** `fix(diagnostics): run the engine parser behind the editor diagnostics` | §4.1 / §4.2 / §4.4 PR-D1 段 | #610 の 2 項 | `parser/parse-error.ts`（新規 20）/ `parser-utils.ts`（+10）/ `diagnostics/analyze-source.ts`（新規 60・まだパースのみ）/ `extension.ts`（+40）/ unit | PR-D1（spec が先） | **E2E-D1 / E2E-D2** | 診断の増加（今まで通っていた譜面に赤線が出る） |
| **PR-D3** `feat(diagnostics): applicability table drives the editor warnings` | §3 全部 + §4.3 | #644 の全項 / #665 (A) | `parser/types.ts` + `parse-statement.ts` 4 箇所（span）/ `diagnostics/applicability.ts`（新規 200）/ `analyze-source.ts`（+90）/ `signal-chain-dispatch.spec.ts`（+120） | PR-D2 | **E2E-D3 / -D4 / -D5**・全数テスト・照合テスト | 診断の増加 |
| **PR-D4** `fix(interpreter): loud diagnostics for name collisions and aux output` | §7.3 (i)(ii) | #583 の受け入れ 2 項 | `global.ts`（+15）/ `mixer-manager.ts`（+10）/ `sequence.ts`（+12）/ `analyze-source.ts`（+20） | PR-D3（表が要る） | **E2E-D6** | (i) は挙動変更（§15 (5)） |
| **PR-D5** `feat(dsl): distribute stack-level @v to voices; empty pattern binding guidance` | §7.2-2 / §7.4（**owner 裁定 A: 実装**） | #255-2 / #609 | `parse-expression.ts`（+50）/ `analyze-source.ts`（+15）/ `PITCH_DSL_SPEC` §2.5 | PR-D3 | E2E: `[1,5,9]@v+10` と per-voice 展開の capture RMS 一致 | DSL 表面（加算） |
| **PR-D7** `feat(dsl): accept note names in seq.root()` | §7.1（**owner 裁定 B**） | #280 | `sequence.ts:906-920`（+20）/ core spec `:953-955` / 表の引数スキーマ欄 | PR-D1 | E2E: `seq.root(C)` / `seq.root(b6)` で `estimateFundamentalHz` が期待値 | DSL 表面（加算） |
| **PR-D6** `fix(engine): attribute diagnostics to the submission that caused them` | §6 | #620 | `repl-mode.ts` / `extension.ts` | **#694 PR-L2 または #611 PR**（フレーム） | **E2E-620-A**（先に再現） | — |

**PR-D3 の後**に、正規表現アナライザの整理（§4.4 PR-D3 段）を別 PR で行う。E2E-D1〜D6 が
同値を押さえてからでないと**診断が黙って減る**。

---

## 14. 確信度と反証方法

| 主張 | 確信度 | 反証方法 |
|---|---|---|
| `seq.gain()` / `seq.pan()` が midi・instrument で効かない（§2.3） | **高**（読み手 3 箇所を全列挙） | instrument 譜面で `seq.gain(-20)` を評価し capture RMS を比べる。変われば main の読み違い |
| 拡張から `analyze-source` を require できる | **高**（`extension.ts:657` / `:679` の実績・`dist` はコピーされる） | ビルド後 `.vsix` を作り実機で `get_diagnostics`。落ちたら `engine/dist` の配置が変わっている |
| `ParseError` 化が `repl-mode.ts:363` の EOF 判定を壊さない | **高**（文言を変えないので） | 未完入力（`kick.play(1,` で改行）を REPL に入れ、沈黙せず待つこと。壊れたら #607 の再発 |
| #645 の実害経路は `seamlessParameterUpdate`（§5.2 の 2）が主 | **中**（コードからの推論。実機再現は未実施） | E2E-645-B。落ちなければ経路 1 だけが実害 |
| #620 は実在する | **中**（構造からの推論・issue も「再現未実施」と書いている） | **E2E-620-A**。再現しなければ設計ごと捨てる |
| `seq-undeclared` 行で誤検出が消える | **中**（ライブコーディングの実際の打鍵順は未観測） | 実機で 1 行ずつ書きながら赤線が点滅しないか見る。点滅するなら「保存時のみ表引き」へ落とす |
| 表を data で持てば #280 / #609 / #665A が「1 行」になる | **中**（#280 は引数型の話で、列ではなく引数の検査が要る） | PR-D3 で #665A は 1 行に収まり、#280 は収まらないと予想。収まらなければ表に「引数スキーマ」欄を足す |

---

## 15. 🔴 owner 裁定待ち（設計に混ぜていない・他は着手可能）

| # | 問い | 選択肢 | 推奨 | 影響範囲 |
|---|---|---|---|---|
| (1) ✅ **A 据え置き（owner 2026-09-03）** | 🔴 **midi の `output(数値)` / `output("名前")` を拒否するか**（`sequence.ts:378-384` / `:402-404` のコメントが「破壊的変更になるため owner 確認待ちで据え置き」と明記） | A 据え置き（表は `warn` = 黄線のみ）/ B 拒否（`error` + throw・instrument と対称） | **A**。裁定 2「エンジンは触らない」と整合し、#644 の受け入れ（赤線が出て実行は止まらない）も満たす。B は既存譜面が落ちる | 表の 2 行 + `sequence.ts` 2 箇所。**この裁定が出るまで PR-D3 は A で実装できる**（表の値を変えるだけ） |
| (2) ✅ **B 実装を spec に（owner 2026-09-03・推奨から変更）** → §7.1 改訂・PR-D7 | #280 をどちらに倒すか | A spec を実装に（core spec `:953` は既にこれ。`seq.root()` は数値のみ）/ B 実装を spec に（note-name と `b6` を受ける） | **A**。ただし core spec `:953` の `seq.root(b6)` は**どちらでも直す必要がある**（§3.3 (b)） | A なら docs 2 ファイル。B なら `sequence.ts:906-920` の signature 変更 + `parse-statement` の引数解釈 |
| (3) ✅ **A（owner 2026-09-03:「オーディオ機能はオーディオのラインで動かす」）** | `gain` / `pan` が note シーケンスで効かないのを **診断で言う**か、**効くようにする**か | A 表で `warn`（本書）/ B #611 §2.4 の `LineOp::Gain` を待つ（効くようになる） | **A を今・B が来たら表の行を `ok` に**。#611 は大きく、`must-fix` の診断を待たせる理由が無い | 表の 4 行。#611 側に「本書の表を更新する」と 1 行 |
| (4) ✅ **A（owner 2026-09-03）** | `seq.ui()` の引数無し形を audio シーケンスで `warn` にするか | A する（instrument 前提なので）/ B しない（catalog effect の UI は audio でも開く） | **A**（引数無しのみ）。引数ありは `ok` のまま。`sequence.ts:678-693` の分岐と一致する | 表の 1 セル |
| (5) 🔴 **相談中**（owner「ライブコーディングという側面で考えて」）。提案: 演奏中に throw で全体を止めない = **赤線（`error`）+ 評価時はその文だけ `[ERROR]` でスキップし既存の名前が勝つ**（フレームの残りは実行する）。black-hole にしないため `get_log` に必ず出す | #583 (i) の「同名 seq と sum/aux の併存を throw にする」は破壊的変更か | A 破壊的として扱い据え置き / B 「今日すでに壊れている」ので loud 化してよい | **B**。node-decl 形は既に throw する（`runtime.ts:196-206`）ので、文字列形だけ黙っているのが非対称 | `global.ts` / `mixer-manager.ts` 各 1 箇所 |
| (6) ✅ **A 足す（owner 2026-09-03）** → §7.4 改訂・PR-D5 | #609 を仕様に足すか | A 足す（`[...]@v` を per-voice に分配・per-voice が勝つ）/ B 足さない（誘導エラーのみ） | 本書は**判断しない**。ただし **B は #610 の副産物として今すぐ得られる**ので、A の裁定を待たずに誘導文言だけ出す（§7.4） | A なら `parseStack` + spec §2.5。B なら `parse-expression.ts` に数行 |
| (7) ✅ **B 与える（owner 2026-09-03・「両方できるといい」→ ピッチ保持は #213）** → §7.5 改訂 | #665 の `chop(n>1)` で tie に意味を与えるか | A 与えない（`warn` のまま）/ B 与える | 本書は**判断しない**（#665 コメント 2 の未確認項目のまま）。A は今すぐ実装できる | A なら表の 1 行。B なら `event-scheduler.ts` の `eventSlotDuration` |
| (8) ✅ **B デバウンス（owner 2026-09-03）** | `analyzeSource` を **打鍵ごと**に走らせるか、保存時 / 一定時間後にするか | A 打鍵ごと（今と同じ頻度）/ B デバウンス / C 保存時のみ | **B**。今の正規表現は軽いが `parseAudioDSL` は全文パース。**閾値は書かない** — 測るのは「1000 行の `.orbs` で `analyzeSource` が 1 回にかかる時間」と「打鍵中の入力遅延」 | `extension.ts:426` の change ハンドラ |

---

## 16. 🔴 issue チェックリストに対する「不要 / 変更」判定

| issue | 項目 | 判定 | 理由（出どころ） |
|---|---|---|---|
| **#255** | 「1 の挙動（drop vs rest）を決定し spec に反映、テスト追加」 | 🔴 **変更**: 実装は**済んでいる**（推奨 a = 休符保持）。残るのは **spec への明記のみ** | `resolve-chords.ts:99-105` のコメント「#255: an unbound standalone name is rendered as a REST … (decision: a)」（本書 §7.2） |
| **#645** | 「呼び出し元は `sequence.ts:1467` / `:1549` / `:1570`」「`sequence.ts:1505`」 | 🔴 **変更**: 行番号が古い。実際は throw が `:1609`、呼び出し元は `:1571` / `:1653` / `:1674` / `:1721`。さらに **`seamlessParameterUpdate`（`:273`）と `unmute()`（`:1839`）という issue に無い実害経路がある** | 本書 §5.1 / §5.2（grep 実測・§9） |
| **#645** | 「ループタイマー経路も throw で止まる」（本文の含意） | 🔴 **不要**: ループタイマー経路は **`safeSchedule`（`loop-sequence.ts:115-126`）が既に catch している**。文言を揃えるだけ | 本書 §5.2 の 4 行目 |
| **#583** | 「`process-statement.ts:66-74`」 | 🔴 **変更**: 現在は `:69-86` | 本書 §2.3 |
| **#280** | 「対応方針（どちらかを選ぶ）」 | 🔴 **変更**: **core spec は既に選択肢 2（spec を実装に合わせる）で改訂済み**（`:953-955`）。未解決なのは (a) specs-v2 が未追従（`:160`）と (b) **core spec 自身の例 `seq.root(b6)` も動かない**という新しい乖離 | 本書 §3.3 (b)(c) / §7.1 |
| **#665** | 「A を #644 の表の 1 行として扱う」 | ✅ そのとおり（本書 §3.3 最終行・§7.5）。追加の判定なし | 地図 §4.F「統合」 |
| **#644** | 「`gain` / `pan` / `quantize` の各種での意味論の確定 → 表を作る過程で精査し、不明なら『適用される』側に倒す」 | ✅ **精査した**: `quantize` は種に依らず `ok`、**`gain` / `pan` / `defaultGain` / `defaultPan` は midi・instrument とも `warn`**（不明ではなく、効かないことが確定した） | 本書 §2.3 / §3.3（読み手 3 箇所の全列挙） |
| **#609** | 「採らない場合: 誘導エラーで十分（#610 と連動）」 | ✅ **#610 が入れば赤線は自動で出る**。誘導文言だけ数行で足せるので、仕様裁定を待たずに着手可能 | 本書 §7.4 |
