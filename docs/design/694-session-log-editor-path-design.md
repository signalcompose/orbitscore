# 設計: セッションログをエディタ経路で出し、リプレイできることを確認する（#694 / #695 / #241）

**対象 issue**: #694（エディタ経路でログが出ない・must-fix）/ #695（1 選択が複数レコードに割れる）/ #241（`orbitscore replay`）
**関連**: #598（`replay --render` の driver・`docs/design/598-render-endpoint-design.md`）/ #649 §10（評価バッチ境界・`docs/design/611-output-line-design.md` §3.9 と**同じ機構**）/ #662 §4.H.1（設定面）
**正本**: `docs/specs-v2/SESSION_LOG_SPEC_v1.md`（本書は spec の改訂案を §11 に含む。実装より先に spec を直す・運用規則 6）
**状態**: 設計（実装しない）・2026-09-03・main `ca176f0` 実測

---

## 0. owner 裁定（2026-09-03・再議論しない）

| # | 裁定 | 出どころ |
|---|---|---|
| 1 | 🔴 **順序**: ① エディタ経由で `.orbslog` が出る（#694）→ ② **本当にリプレイできるか確認**（#241・独立した作業）→ ③ オフラインレンダ（#598） | #694 コメント 3 / 地図 §9 |
| 2 | ログの置き場は **譜面の隣にディレクトリを作ってその中**（名前は未指定 → §13） | #694 コメント 3 |
| 3 | 「壊れている」は **A**（エディタから出ない）と **B**（出てもリプレイに足る情報が無い）の両方 | 地図 §9 |
| 4 | リプレイは**音楽時間駆動**（三重スタンプ）。壁時計駆動は棄却 | Known Decision #24（`IMPLEMENTATION_INSTRUCTIONS.md:138`・DDR `:205`） |
| 5 | リプレイヤーは**もう一人の評価送信者**（拡張と同じ口・専用経路なし） | spec §4 / Known Decision #30（DDR `:246`） |
| 6 | `--until` 後はエンジン状態のみ引き継ぐ（エディタには書かない） | Known Decision #25 |
| 7 | 検証はランダム由来イベントを構造比較（因果的同一性） | Known Decision #21 |
| 8 | `.orbslog` replay は #598 とは**別 issue**（= #241） | #598 コメント 3 裁定 5 |

---

## 1. 到達点（1 文）

**OrbitStudio で譜面を評価して `global.start()` すると、譜面の隣の `<DIR>/` に `<basename>.<YYYYMMDD-HHMMSS>.orbslog` が生成され、1 回の選択評価が 1 レコードとして残り、`orbitscore replay <log>` がそのログを**同じ interpreter・同じ engine**で鳴らし直して、capture の窓 RMS がライブと一致する。**

---

## 2. 現在地（一次情報・本書が変えるもの）

| 事実 | 根拠 | 本書 |
|---|---|---|
| gate は `env.ORBITSCORE_SESSION_LOG === '1'` のみ true | `packages/engine/src/cli/session-log-gate.ts:12-14` | 不変（拡張が値を**明示**で渡す。§3.1）|
| gate を呼ぶのは CLI の 2 箇所 | `cli/play-mode.ts:64` / `cli/repl-mode.ts:44` | 不変 |
| 拡張は `node <engine> repl` を `env = {...process.env}` + 4 変数で spawn | `packages/vscode-extension/src/extension.ts:2113-2163` | `ORBITSCORE_SESSION_LOG` を**設定から**足す（§3.1）|
| 拡張はファイル名を engine に渡さない（`//#documentDirectory` のみ） | `extension.ts:3013` / `repl-mode.ts:72-79` | `//#sourceFile` メタ行を新設（§3.2）|
| 拡張は `global.setDocumentDirectory("...")` を **DSL 文として注入**し、それが `code` に混じる | `extension.ts:3014-3024` / 記録は `interpreter-v2.ts:156-167` の `options.source` | 注入を廃止（`execute()` が同値を先に適用済み・§3.3）|
| REPL は **1 行ごとに** `execute()` する（独立にパースできれば文ごと） | `repl-mode.ts:510-513` `buffer += line; await executeCurrentBuffer(false)` | フレーム（`//#evalBegin` … `//#evalEnd`）で 1 選択 = 1 `execute()`（§4）|
| transport フックは**最初の GLOBAL** にだけ装着 | `interpreter-v2.ts:207-210` `sessionHooksInstalled` | 全 GLOBAL に装着（§5）|
| 置き場は `.orbs` の隣に直接 | `session-log-writer.ts:127` `dir = dirname(sourceFile)` | 隣の **`<DIR>/`** へ（§3.4）|
| `sourceFile` は絶対パス（play-mode が `path.resolve`）だが spec §3 は「相対」 | `play-mode.ts:70` / spec §3 表 | **ログ基準の相対**に統一・`logVersion: 2`（§6）|
| リポジトリ内に `.orbslog` は 0 本 | #694 コメント 1 | 読み手（replayer）の互換負債は無い |
| replayer は未実装 | #241 コメント 1 | §7 |
| dormant の理由「file-scoped が複数ファイルセッションに合わない」 | `docs/development/POST_2.0_ROADMAP_NOTES.md:60` | spec §2 は既に「セッションはエンジンに束縛・命名は start を評価したファイル」なので、**命名の不一致ではなく #694 の欠落が実体**（§13 に owner 確認を残す）|

---

## 3. #694 — エディタ経路で出す（A）

### 3.1 有効化の経路: VS Code 設定 → env（設定面 = 拡張の既存パターン）

#662 §4.H.1 論点 4「二重に作らない」への答え: **拡張には既に設定面がある**（`orbitscore.audioDevice` `package.json:388` / `orbitscore.engineDebug` `:394`）。
daemon の env 一覧（#662 バッチ A/B）は daemon プロセスの変数の話で、`ORBITSCORE_SESSION_LOG` は **engine（TS）プロセス**の変数。
#662 の一覧には「`ORBITSCORE_SESSION_LOG` — engine / restart 時に効く / 拡張設定 `orbitscore.sessionLog` が入口」と**記載だけ**する（§12）。

| 箇所 | 変更 |
|---|---|
| `packages/vscode-extension/package.json:388` の隣 | 設定 `orbitscore.sessionLog`: `"type": "boolean", "default": true, "description": "Write a .orbslog session log next to the score (SESSION_LOG_SPEC). Takes effect at engine start."` |
| `extension.ts:2119-2123`（`const env = { ...process.env }` の直後） | `env.ORBITSCORE_SESSION_LOG = resolveSessionLogSetting() ? '1' : '0'`（**必ず明示**で書く。継承 env に依存しない = `ORBITSCORE_ENGINE` `:2143-2146` と同じ規律） |
| `extension.ts:1690` の隣 | `function resolveSessionLogSetting(): boolean { return vscode.workspace.getConfiguration('orbitscore').get<boolean>('sessionLog', true) }` |
| `extension.ts:2129-2131` capture の隣 | `outputChannel?.appendLine(`📝 Session log: ${on ? 'on' : 'off'}`)`（起動ログに残す・#662 の「起動時に何を掴んだか出す」と同じ姿勢）|
| `session-log-gate.ts` | **不変**（`'1'` のみ true）。拡張が `'0'` を明示するので editor の既定 on と CLI の既定 opt-in が**独立に**決まる（§13 (2) が何であっても editor 側は不変）|

**既定 on の根拠**: spec §1「保存は自動。明示的な録音開始操作は存在しない」（規範）/ DDR 決定 #22「録り逃しゼロ・最良の演奏は録るつもりのないセッションで起きる」/ owner「ディレクトリを**デフォルトで**作って保存」。2.0.0 の dormant は「退避」（`play-mode.ts:57-61` のコメント・resurrect 可）であって設計ではない。

**設定変更の反映**: engine 起動時に読む（`restart` 属性）。`orbitscore.engineDebug` と同じ。設定を変えたら "Restart Engine"。

### 3.2 ファイル名の伝達: `//#sourceFile <absolute path>` メタ行（ログに混じらない制御チャネル）

既存メタ行群（`repl-mode.ts:72-105`: `documentDirectory` / `selectAudioDevice` / `savePluginState` / `pluginUi` / `evalMark`）と同じ帯域外チャネル。

**拡張側**（`extension.ts:3000-3033` `writeCodeToEngine`）:

```ts
function writeCodeToEngine(
  rawCode: string,
  documentDir: string | undefined,
  sourceFile: string | undefined,   // 新設: editor.document.isUntitled ? undefined : editor.document.uri.fsPath
): boolean
```

- `runSelection`（`:2873`）: `writeCodeToEngine(trimmedText, path.dirname(editor.document.uri.fsPath), editor.document.isUntitled ? undefined : editor.document.uri.fsPath)`
- `evaluateForAgent`（`:3045`）: `writeCodeToEngine(code, documentDir, undefined)`（agent には「開いているファイル」が無い。`untitled` フォールバック = §3.4）
- 送出順（1 評価）:

```
//#documentDirectory <dir>        ← 既存（I3 #456）
//#sourceFile <abs path>          ← 新設（ファイルがある時だけ）
//#evalBegin                      ← §4（フレーム）
<user code>
//#evalEnd
```

**REPL 側**（`repl-mode.ts`）:

```ts
const SOURCE_FILE_META_RE = /^\s*\/\/#sourceFile\s+(.+?)\s*$/
export function extractSourceFileMeta(line: string): string | undefined
```

- `createReplSession`（`:302`）に `let sessionSourceFile: string | undefined` を足し、`sessionDocumentDirectory`（`:312`）と同じ寿命（**最後の値が持続**・エディタは評価ごとに送るのでファイル切替に追従）
- `handleLine`（`:392`）: `//#documentDirectory` / `//#sourceFile` を**単独行として先に処理し、バッファへ積まない**（`selectAudioDevice` と同じ扱い `:493-498`）。inline 出現（生 stdin 互換）は従来どおり `extractDocumentDirectoryMeta(code)` で拾う
- `executeCurrentBuffer`（`:350-357`）: `interpreter.execute(ir, { source: recordCode, evalSource: 'human', documentDirectory: sessionDocumentDirectory, sourceFile: sessionSourceFile })`

**なぜ `//#documentDirectory` から導出しないか**: `dir` はファイル名を含まない（`untitled` と `mypiece` を区別できない）。**なぜ `sourceFile` だけにしないか**: `documentDirectory` は untitled バッファでも要る（workspace root）。2 本のままにする。

### 3.3 `code` の純度: 記録するのはユーザーが書いたテキストだけ

spec §3「`code` = 評価されたテキストそのまま（選択範囲の生文字列）」。現状は拡張の注入 2 種が混じる:

| 混じるもの | 根拠 | 対処 |
|---|---|---|
| `//#documentDirectory <dir>`（inline） | `extension.ts:3013` が code の先頭に付ける → `extractDocumentDirectoryMeta` は「code から取り除かず」（`:69`） | §3.2 で単独行化。inline 互換分は **`stripMetaLines(code)`** を記録直前に通す |
| `global.setDocumentDirectory("<abs>")` DSL 文 | `extension.ts:3014-3024` | **注入を廃止**する。`execute()` が `options.documentDirectory` を **statements より先に**適用済み（`interpreter-v2.ts:190-217`: import 後に復元・`processGlobalInit` 後に set）なので、同一 eval で GLOBAL を作る場合も含めて冗長。`globalInitialized`（`:2172`）は注入専用フラグなので同時に削除 |

```ts
// repl-mode.ts（新設・pure・unit test 対象）
/** `//#…` メタ行を落とす（記録する `code` の純度・SESSION_LOG_SPEC §3）。DSL の意味は不変（tokenizer が読み飛ばす行）。 */
export function stripMetaLines(code: string): string {
  return code.split('\n').filter((l) => !/^\s*\/\/#/.test(l)).join('\n')
}
```

**注入廃止の反証方法**: `tests/fixtures/mcp-e2e/kick_loop.orbs` は**相対** `audioPath("../../../test-assets/audio")` を使い、ヘッダで「注入が相対パス解決を担う」と明記している。既存 gated E2E（`orbitstudio-mcp-gated.spec.ts:922-949`）が注入廃止後も緑なら冗長の証明、赤なら `execute()` 側に穴がある（その時は注入を戻さず `execute()` を直す）。

**なぜリプレイに効くか**: 注入された絶対パスが `code` に残ると、リプレイ時に**記録時のマシンのパス**で `setDocumentDirectory` が実行され、別ディレクトリへ移したログや別マシンで `audio()` が壊れる。純度は「別の場所で鳴らせる」ための条件。

### 3.4 置き場: 譜面の隣のディレクトリ `<DIR>/`（名前は §13 (1)・定数 1 箇所）

```ts
// session-log-writer.ts（新設・export）
/** 譜面の隣に作るセッションログ用ディレクトリ名（SESSION_LOG_SPEC §2）。🔴 owner 裁定待ち §13 (1) — 本定数 1 箇所で決まる。 */
export const SESSION_LOG_DIRNAME = 'orbslog'   // 推奨値。裁定で置き換える
```

`start()`（`:123-172`）の変更:

```ts
const scoreDir = s.sourceFile ? path.dirname(s.sourceFile) : this.cwd
const dir = path.join(scoreDir, SESSION_LOG_DIRNAME)
try {
  fs.mkdirSync(dir, { recursive: true })
} catch (e) {
  this.disabled = true; this.filePath = null
  console.warn(`⚠️  session-log: failed to create ${dir} — logging disabled (playback continues): ${e}`)
  return
}
// 以降は既存の wx 排他ループ（:147-164）そのまま
```

- `sourceFile` 無し（untitled / agent 評価）: `cwd/<DIR>/untitled.<stamp>.orbslog`。拡張の engine は `cwd: workspaceRoot`（`extension.ts:2160`）なので **workspace root の `<DIR>/`**
- #598 の render パス「譜面からの相対」と同じ原則（#598 コメント 8「決まっていること」）
- 命名 `<basename>.<YYYYMMDD-HHMMSS>[-N].orbslog` は不変（`:147-155`）

### 3.5 観測可能にする（`ok` では証明にならない・E2E がファイルを見る）

`installSessionHooks`（`interpreter-v2.ts:94-108`）の `onStart` / `onStop` の直後に 1 行 JSON を stdout へ出す（既存の `{"evalMark":…}` 等と同じ流儀・`extension.ts:1486-1508` のディスパッチは**不要**、`get_log` の ring に載ればよい）:

```
{"sessionLog":{"event":"open","path":"/abs/.../orbslog/mypiece.20260903-213005.orbslog"}}
{"sessionLog":{"event":"close","path":"…"}}
{"sessionLog":{"event":"disabled","reason":"…"}}   ← writer が disabled になった時（console.warn の代わりではなく追加）
```

`SessionLogWriter.getFilePath()`（`:100`）は既にある。`stripLine`（`extension.ts` の `shouldFilterLine`）がこの行を落とさないことを unit で固定する。

---

## 4. #695 — 1 選択 = 1 レコード（selection-atomic framing）

### 4.1 機構: `//#evalBegin` / `//#evalEnd`（#649 §10.3・doc 1 §3.9 と**同一の機構**・二重に作らない）

`docs/design/611-output-line-design.md` §3.9 は同じフレームを `AudioLine.beginBatch()/endBatch()` に使う。**PR は 1 本**（§10 PR-L2）で、doc 1 の PR-O4 はそれに依存する。

```ts
// repl-mode.ts
const EVAL_BEGIN_META_RE = /^\s*\/\/#evalBegin\s*$/
const EVAL_END_META_RE = /^\s*\/\/#evalEnd\s*$/
```

`createReplSession` に `let frame: string[] | null = null` を足す。`handleLine`:

| 行 | 動作 |
|---|---|
| `//#evalBegin` | `frame !== null` なら `[ERROR] //#evalBegin while a frame is open — previous frame discarded`（診断に積む）。`frame = []` |
| `//#evalEnd` | `frame === null` なら `[ERROR] //#evalEnd without //#evalBegin`（診断に積む・無視）。それ以外は `code = frame.join('\n'); frame = null; await executeFrame(code)` |
| `//#evalMark` | **開いたフレームがあれば閉じて実行してから**報告（`:407-427` の「未完のまま残った入力を放置しない」と同じ理由）|
| その他のメタ行 | フレーム中でも即時処理（`selectAudioDevice` 等は帯域外・`:493-498`）|
| 通常行 | `frame !== null` なら `frame.push(line)`（**`executeCurrentBuffer` を呼ばない**）。`null` なら従来の 1 行処理（生 stdin 互換・不変）|

`executeFrame(code)`: `parseAudioDSL(code)` **1 回** → `execute(ir, { source: stripMetaLines(code), … })` **1 回**。パース失敗はフレーム全体を棄却して診断（`pendingDiagnostics`）へ。「未完」判定（`/\bEOF\b/`）は**フレームには適用しない**（フレームは提出の境界なので、未完 = 構文エラー）。

### 4.2 意味論の変化（明示）

| | 今日（行単位） | フレーム |
|---|---|---|
| 選択 3 文のうち 2 文目が構文エラー | 1 文目は**実行済み**、2 文目で停止 | **何も実行しない**（診断のみ）|
| ログ | 3 レコード（成功した文だけ…ではなく `recordEval` は実行前 `:156` なので成功 2 + 失敗 0） | 1 レコード |
| `play-mode`（ファイル全体） | 1 `execute()` | 不変（フレーム相当）|

「1 選択は 1 まとまり」は `play` と同じ意味論に**揃う**方向。これは仕様変更なので spec §3.1 を改訂する（§11）。

### 4.3 リプレイとの整合

replayer（§7）は 1 レコード = 1 `execute()` で投入するので、フレームで記録されたものは**同じ粒度**で再生される。行単位で記録された古い形式は存在しない（0 本）。

---

## 5. 複数 GLOBAL（#695 やること 2）

| 箇所 | 変更 |
|---|---|
| `interpreter-v2.ts:207-210` | `sessionHooksInstalled: boolean` → `private sessionHooked = new WeakSet<Global>()`。`processGlobalInit` の後で `state.globals` を走査し、未装着の Global 全部に `installSessionHooks(g, name)` |
| `installSessionHooks(global, name)` | クロージャが `name` を捕まえ、`writer.start({ …, global: name })` / `writer.stop(wall, pos, name)` |
| `session-log-writer.ts` | `SessionStart.global: string` / `stop(wall, transport, global)`。**セッションの開閉規則**: `filePath === null` の時の `start` → 新規ファイル（従来）。**既に開いている時の `start`（別 GLOBAL）→ 同じファイルへ `{"type":"transport","event":"start","global":"g2"}` を追記**（新規ファイルを開かない）。`stop` は `{"type":"transport","event":"stop","global":…}` を追記し、**走行中 GLOBAL の集合が空になった時だけ**ファイルを閉じる（`running: Set<string>`）|
| レコード形式 | `transport` レコードに `global`（GLOBAL の変数名）を**追加**（§6）。`eval` レコードは engine 単位なので不変 |

spec §1「セッションはエンジンに束縛」の唯一の一貫した読み。単一 GLOBAL では `running` が 1 要素なので**従来と同じ挙動**（integration test `tests/session-log/session-log-integration.spec.ts:131` 「2 回目の start は新ファイル」も不変）。

---

## 6. ログ形式の改訂（`logVersion: 2`・🔴 一方通行）

`logVersion: 1` の読み手は存在せず（replayer 未実装）、ファイルも 0 本なので今が変え時。以降は加算のみ。

| フィールド | v1 | v2 |
|---|---|---|
| `meta.logVersion` | 1 | **2** |
| `meta.sourceFile` / `eval.sourceFile` | 絶対（実装）/ 相対（spec） | **ログ基準の相対**: `path.relative(scoreDir, sourceFile)`（同ディレクトリなら basename）。`scoreDir` = `<DIR>/` の親 |
| `meta.scoreDir` | 無し | **追加しない**（ログの置き場が基準。移動したログには `replay --score-dir` で与える・§7.3）|
| `transport.global` | 無し | 追加（§5・単一 GLOBAL でも書く）|
| `eval.code` | 注入混在 | 純度（§3.3）|
| `meta.assets` | 無し（spec 例にはある） | **v2 でも書かない**。理由: `global.start()` 時に全サンプルの sha256 を取ると重い（同期 I/O が評価スレッドを止める）。spec §4「アセット検証・不一致は警告して続行」は `--verify` の仕事で、§13 (4) に置く |

replayer は `logVersion !== 2` を**拒否**する（`unsupported logVersion`）。

---

## 7. #241 — `orbitscore replay <log>`（忠実リプレイ・実時間）

### 7.1 口: `play` と同じ in-process（同じ interpreter・同じ engine）

拡張の口は REPL stdin、CLI `play` の口は `InterpreterV2.execute()` 直呼び（`play-mode.ts:70`）。どちらも**同じ `execute()`** に落ちる。replayer は `play` 型（in-process）にする — 1 レコード = 1 `execute()` が構造的に成立し、transport の現在位置を `Global` から直接読める。

```ts
// packages/engine/src/cli/replay-mode.ts（新規・約 200 行）
export interface ReplayOptions {
  logPath: string
  scoreDir?: string          // 省略時 = dirname(dirname(logPath))（<DIR>/ の親）
  until?: string             // "bar:beat"（§7.4）
  audioDevice?: string
}
export async function replayLog(opts: ReplayOptions): Promise<{ interpreter: InterpreterV2; shouldStartREPL: boolean }>
```

- `parse-arguments.ts:33-44` に `--until <pos>` / `--score-dir <dir>` を足す（`--render` は #598・doc 3 §8）
- `execute-command.ts:56` に `case 'replay'`。`printUsage` に 1 行

### 7.2 駆動: transport 時刻（裁定 4）

```ts
// global.ts（新設・pure・:755 msToBarBeat の逆関数）
/** 現在の tempo / beat で `"bar:beat"` に到達するまでの ms（負なら過去 = 即時）。transport 未走行なら null。 */
msUntilTransportPosition(pos: string): number | null
```

replayer のループ:

```
records = readOrbsLog(logPath)            // tests/session-log/helpers.ts:4 と同じ読み方
assert meta.logVersion === 2
for rec of records:
  eval  (transport === null)  → execute(rec) 即時（プリアンブル。global.start() を含む eval がここに来る）
  transport start             → 何もしない（start は直前の eval が起こした結果。到達確認だけ: global.getTransportPosition() !== null を assert）
  eval  (transport !== null)  → ms = g.msUntilTransportPosition(rec.transport); await sleep(max(0, ms)); execute(rec)
  transport stop              → 同上（到達確認）。until 無しならここで終了
execute(rec) = interpreter.execute(parseAudioDSL(rec.code), { source: rec.code, sourceFile: resolve(scoreDir, rec.sourceFile), documentDirectory: scoreDir, evalSource: 'replay' })
```

- **tempo 変更**はそれ自体が eval なので、次の目標時刻は「その eval を実行した後」に現在パラメータで計算する（記録時と同じ前提。DDR `:182`「参照系はログ内で自己完結」）
- **quantize** は engine が音楽時間で再解決する（`effect` は使わない・spec §3.1）
- 評価失敗はそのまま診断に出して**続行**（記録も成功／失敗を区別せず `recordEval` は実行前 `:156`。因果の記録として対称）
- replayer 自身のログ: CLI の gate に従う（`ORBITSCORE_SESSION_LOG=1` の時だけ）。既定 off にする理由: 再生のたびに `evalSource: "replay"` のログが増える

### 7.3 `--score-dir`

`sourceFile` は相対（§6）。既定の基準 `dirname(dirname(logPath))` はログを動かしていない限り正しい。動かしたら明示する。`audio()` の相対解決は `documentDirectory = scoreDir` で従来経路（`interpreter-v2.ts:215-217`）。

### 7.4 `--until <bar:beat>`（裁定 6）

v1 = **忠実リプレイを `until` で止めて REPL に引き継ぐ**（`shouldStartREPL: true` → `startREPL(interpreter)`・`execute-command.ts:70-72` と同型）。エンジン状態は引き継ぎ、エディタには何も書かない。
「`until` まで**高速で**畳み込む」変種は、quantize を正しく解くのに仮想クロック（#598 P2 の driver）が要るので**本書の範囲外**（doc 3 §8）。spec §8 Open Question 3（境界ちょうど）は §13 (3)。

### 7.5 `--verify`（裁定 7）— v1 は capture で行う

spec §5「スケジュール済み TimedEvent の比較」は**ライブ側のイベント列が記録されていない**ので実行不能（`.orbslog` は原因のみ・原則 1）。v1 の検証は **E2E-R1（§9）の capture 比較**で行い、イベント列比較は §13 (4)。

---

## 8. データの通り道 1 本（端から端まで）

```
[OrbitStudio] runSelection (extension.ts:2716)
  → writeCodeToEngine(text, dir, file)            // "//#documentDirectory", "//#sourceFile", "//#evalBegin", code, "//#evalEnd"
  → engine stdin (repl 'node cli-audio.js repl', env ORBITSCORE_SESSION_LOG='1')
[engine] createReplSession.handleLine
  → sessionDocumentDirectory / sessionSourceFile  // 単独メタ行
  → frame.push … "//#evalEnd" → executeFrame(code)
  → interpreter.execute(ir, { source: stripMetaLines(code), sourceFile, documentDirectory, evalSource: 'human' })
      → state.sessionLog.recordEval({ code, wall, transport: g.getTransportPosition(), effect, sourceFile: relative, evalSource })   // :156-167
      → statements … global.start() → _onTransportStart (global.ts:669)
          → writer.start({ stamp, wall, sourceFile, global })                     // mkdir <scoreDir>/<DIR>/, wx create, meta v2, preamble, start record
          → stdout {"sessionLog":{"event":"open","path":…}}                        // get_log に出る
[E2E] fs.existsSync(<scoreDir>/<DIR>/kick_loop.*.orbslog) && readOrbsLog(...)  // ファイルの実在と中身
[CLI] orbitscore replay <log> [--score-dir d]
  → readOrbsLog → preamble を即時 execute → transport 到達待ち → execute(evalSource:'replay') … stop で終了
  → ORBIT_CAPTURE_WAV で master を録る（daemon-start config・engine_wrap.rs:4153）→ 窓 RMS をライブの capture と比較
```

---

## 9. E2E（すべて MCP 経由・`tests/e2e/orbitstudio-mcp-gated.spec.ts`・`ok` に assert しない）

| # | シナリオ | 判定（ファイル・数値）|
|---|---|---|
| E2E-S1 | `open_file(kick_loop work copy)` → `set_selection` 全体 → `run_selection`（`global.start()` を含む）| `<workCopyDir>/<DIR>/kick_loop.<stamp>.orbslog` が **実在**（`waitUntil` 10s）。`readOrbsLog`: 1 行目 `meta.logVersion === 2`・`meta.sourceFile === 'kick_loop.orbs'`・`transport` `start` レコードに `global: 'global'`・eval レコードの `code` が**選択テキストと等しい**（`stripMetaLines` 後・注入無し）・`get_log` に `"sessionLog":{"event":"open"` が **1 回以上**（`>=`）|
| E2E-S2 | S1 の続きで `evaluate_orbitscore('global.stop()')` | 末尾が `{"type":"transport","event":"stop"}`・`get_log` に `"event":"close"` |
| E2E-S3（#695） | 2 文（`drum.play(1,0,1,0)` と `drum.gain(-6)`）を **1 選択**で `run_selection` | eval レコードが **1 件増える**・その `code` に両行を含む・`transport` が非 null |
| E2E-S4 | 拡張の設定 `orbitscore.sessionLog: false` で起動（`user-data-dir` の `settings.json` に書いて launch）→ S1 と同じ操作 | `<DIR>/` が**存在しない**・`get_log` に `Session log: off` |
| E2E-S5 | `evaluate_orbitscore`（agent・ファイル無し）だけで `global.start()` | `<tmpRoot>/<DIR>/untitled.<stamp>.orbslog` が実在 |
| E2E-S6（純度） | S1 のログ全レコード | どの `code` にも `//#` を含む行が無い・`setDocumentDirectory` を含む行が無い |
| E2E-R1（#241・受け入れ） | S1 のセッションを capture 付きで録る（`start_engine({capture_wav: A})`・LOOP 4 小節・`global.stop()`）→ `stop_engine` → **`orbitscore replay <log>`** を `ORBIT_CAPTURE_WAV=B` で子プロセス実行（`execFileSync(node, [cli-audio.js, 'replay', log])`）→ 終了を待つ | A と B の**小節窓 RMS 列**（既存 `captureInstrumentScenario` の窓 helper `:440-604` と同じ計算）が全窓で **±15%** 以内・両方の窓数が等しい・B の RMS > 0（無音でない）|
| E2E-R2 | R1 のログを別ディレクトリへ `cp` して `replay --score-dir <元>` | R1 と同じ判定（相対 `sourceFile` + `--score-dir` の証明）|
| E2E-R3 | `logVersion: 1` に書き換えた偽ログ | exit code ≠ 0・stderr に `unsupported logVersion` |

- 許容 ±15% の根拠: ライブ側は人間（E2E）の `run_selection` が transport 上のどこで走ったかに依存し、replay は記録された `bar:beat` で投入するので**同じ小節境界に quantize される**。差が出るのは録音開始オフセット（窓を `transport start` 記録の `wall` で揃える）
- capture 比較は `gated-assertion-hygiene.spec.ts` の「capture するなら rms を見る」に合致
- `dsl-e2e-coverage.spec.ts` のラチェット: 新しい DSL 語は無い（`start` / `stop` は covered 済み）。**変化なし**
- R1 は `orbitscore replay` を**ユーザーと同じ動線（CLI）**で叩く。MCP tool 化は §13 (5)

---

## 10. PR 分割（詳細は `IMPLEMENTATION_PLAN_2026-09.md`）

| PR | 内容 | 依存 | 一方通行 |
|---|---|---|---|
| PR-L0 `docs(spec): session log v2 — dir, frame, purity, replay` | spec §2/§3/§3.1/§4 改訂（§11）+ core spec `:63` | — | — |
| PR-L1 `feat(session-log): editor path enables logging, writes under <DIR>/` | 設定 + env（§3.1）/ `//#sourceFile`（§3.2）/ 純度 + 注入廃止（§3.3）/ `<DIR>/`（§3.4）/ stdout 通知（§3.5）/ `logVersion: 2` + 相対 `sourceFile`（§6）/ E2E-S1・S2・S4・S5・S6 | PR-L0 | **ディレクトリ名・形式 v2** |
| PR-L2 `feat(repl): //#evalBegin/End frame — one selection, one execute` | §4 + E2E-S3。**doc 1 PR-O4 の前提** | PR-L1 | 意味論（§4.2） |
| PR-L3 `feat(session-log): hook every GLOBAL; transport.global` | §5 + integration test | PR-L1 | 形式（加算のみ）|
| PR-L4 `feat(cli): orbitscore replay <log> — faithful, transport-driven` | §7.1-7.3 + `msUntilTransportPosition` + E2E-R1・R2・R3 | PR-L2（フレーム粒度で記録されたログが要る）| — |
| PR-L5 `feat(cli): replay --until — hand over to the REPL` | §7.4 | PR-L4 | — |

PR-L1 が大きければ **L1a（engine: writer/REPL/interpreter + unit/integration）/ L1b（extension: 設定・env・メタ行 + gated E2E）** に割る。L1a 単独では E2E-S1 は書けない（拡張が env を渡さない）ので、**L1a のマージゲートは integration test、L1b のゲートが E2E**。

---

## 11. spec 改訂（PR-L0・実装より先）

| spec | 節 | 改訂 |
|---|---|---|
| `SESSION_LOG_SPEC_v1.md` | §2 配置 | 「同一ディレクトリ」→「**同一ディレクトリ直下の `<DIR>/`**」。untitled は「エンジンの作業ディレクトリ直下の `<DIR>/`」|
| 同 | §3 表 | `sourceFile` = **ログ基準の相対**（`<DIR>/` の親から）。`transport` レコードに `global`。`logVersion: 2`。例の `assets` を「v2 では未出力（§13 (4)）」と注記 |
| 同 | §3.1 | 「`code` 粒度 = `execute()` 単位」→「**editor 経路はフレーム単位（1 選択 = 1 レコード）**・生 stdin は行単位・CLI play はファイル」。「editor は untitled フォールバック」→「`//#sourceFile` で伝達」。「単一 GLOBAL 前提」→ 削除（§5）|
| 同 | §4 | `--score-dir` / `--until` v1 の意味（REPL 引き継ぎ）/ `--verify` v1 = capture 比較・イベント列比較は未実装 / `logVersion` 拒否 |
| 同 | §8 | (3) は未決のまま。(2) プリアンブル保持期間は「直前の stop 以降」を実装が採っている（`:118-121` `preamble` は stop で消えないが start で drain）と明記 |
| `docs/core/INSTRUCTION_ORBITSCORE_DSL.md:62-64` | session log 節 | 「dormant by default」→ 「**OrbitStudio では既定 on（設定 `orbitscore.sessionLog`）・CLI は `ORBITSCORE_SESSION_LOG=1`**」（§13 (2) の裁定後に CLI 側を更新）|
| `docs/design/611-output-line-design.md` §3.9 | フレーム | 「REPL メタ行群に追加」→「**PR-L2 で入る同じフレームを使う**」に差し替え |

---

## 12. #662 一覧への記載（設計だけ・実装は #662）

| 変数 | プロセス | 属性 | 入口 |
|---|---|---|---|
| `ORBITSCORE_SESSION_LOG` | engine（TS） | restart（engine spawn 時） | VS Code 設定 `orbitscore.sessionLog`（既定 true）/ CLI は env |

---

## 13. 🔴 owner 裁定待ち（設計に混ぜていない・他は着手可能）

| # | 問い | 選択肢 | 推奨 | 影響範囲 |
|---|---|---|---|---|
| (1) | `<DIR>/` の名前 | A `orbslog/`（拡張子と同じ語・見える）/ B `.orbslog/`（隠す）/ C `sessions/` | **A**。spec §1「命名・選別は事後の操作」= ユーザーが Finder で見つける前提なので隠さない。`.orbslog` 拡張子と同じ語で検索性が高い | 定数 `SESSION_LOG_DIRNAME` 1 箇所（§3.4）|
| (2) | CLI（`play` / `repl`）も既定 on にするか | A on（gate を `!== '0'` に）/ B opt-in のまま | **B（現状維持）**。拡張は値を明示するので editor 側は独立（§3.1）。CLI は開発・テストで多用され、譜面の隣にログが増えるのを望まない場面がある | `session-log-gate.ts:13` の 1 行 + core spec `:63` |
| (3) | `--until` が境界ちょうどの時、待機中の quantize 差し替えを適用してから引き継ぐか | spec §8 (3) | v1 は忠実リプレイの停止点なので**問いが立たない**（境界に着く前に止めれば未適用、着けば適用）。高速畳み込み版で再燃 | PR-L5 以降 |
| (4) | `--verify` の実体 | A capture 比較のみ（v1）/ B ライブ側にイベント列 sidecar（`type:'event'` を**別ファイル**に）を足して構造比較 / C `meta.assets` の sha256（start 時に非同期で） | **A を v1**。B/C は「原因のみ記録」（原則 1）との整合を owner が判断 | PR-L4 の範囲 |
| (5) | replay を MCP tool（`replay_session_log`）として露出するか | A 露出（LLM 第一級）/ B CLI のみ | **A を後続**（#241 チェックリストに無い。E2E-R1 は CLI 動線で成立） | 新規 PR |
| (6) | POST_2.0 覚書の「LinkAudio トラックを捕捉しない」（`POST_2.0_ROADMAP_NOTES.md:60`）は本書で扱うか | LinkAudio の出力は**現象**（録音）で因果の記録の外（原則 1）| **扱わない**（Ableton 側が録る分業・spec §6）| — |
| (7) | dormant の根拠「file-scoped mismatch」は #694 の欠落と同一か | owner 確認（#694 コメント 1「未確認」）| 本書は「同一」と読む（§2 最終行）| §3.1 の既定 on の根拠の一部 |

---

## 13b. 呼び出し元の全列挙（grep 実行結果・main `ca176f0`）

```
$ grep -rn "SessionLogWriter\|recordEval\|shouldEnableSessionLog\|sessionLog\b" packages/engine/src packages/vscode-extension/src --include=*.ts | grep -v session-log-writer.ts
packages/engine/src/cli/session-log-gate.ts:12    export function shouldEnableSessionLog(env = process.env)   ← gate 定義
packages/engine/src/cli/repl-mode.ts:12,44         import / if (shouldEnableSessionLog()) enableSessionLog   ← 呼び手 1
packages/engine/src/cli/play-mode.ts:12,64         同上                                                      ← 呼び手 2
packages/engine/src/interpreter/interpreter-v2.ts:16,73-74,97,105,151-161,207   enableSessionLog / hooks / recordEval
packages/engine/src/interpreter/types.ts:8,29      InterpreterState.sessionLog?
（拡張側 packages/vscode-extension/src: 0 件 = #694 の欠落）

$ grep -rn "ORBITSCORE_\(ENGINE\|MCP_PORT\|DEBUG\|DSL\|SESSION_LOG\)" packages/vscode-extension/src --include=*.ts
extension.ts:446,451   ORBITSCORE_MCP_PORT（読み）
extension.ts:2123      env.ORBITSCORE_DEBUG = '1'
extension.ts:2143,2146 env.ORBITSCORE_ENGINE = 'rust' | 'sc'
（ORBITSCORE_SESSION_LOG: 0 件）

$ grep -n "writeCodeToEngine\|//#documentDirectory\|setDocumentDirectory" packages/vscode-extension/src/extension.ts
:111   コメント（globalInitialized の用途）
:2873  runSelection → writeCodeToEngine(trimmedText, dirname(fsPath))
:3000  function writeCodeToEngine(rawCode, documentDir)
:3013  `//#documentDirectory ${documentDir}\n` + codeToSend
:3014-3024  global.setDocumentDirectory(...) の DSL 注入（§3.3 で廃止）
:3045  evaluateForAgent → writeCodeToEngine(code, workspaceRoot)

$ grep -rn "orbslog" packages tests docs/specs-v2 scripts --include=*.ts --include=*.md -l | grep -v dist
packages/engine/src/cli/play-mode.ts / interpreter/interpreter-v2.ts / core/session-log/session-log-writer.ts / core/global.ts
tests/session-log/session-log-integration.spec.ts / helpers.ts / session-log-writer.spec.ts
docs/specs-v2/{MULTICHANNEL_RENDERING_DESIGN_598,SESSION_LOG_SPEC_v1,DESIGN_DISCUSSION_RECORD,IMPLEMENTATION_INSTRUCTIONS,PITCH_DSL_SPEC_v1.1,WCTM_SYSTEM_SPEC_v1}.md
（`.orbslog` を読む実装 = 0 件。replayer が最初の読み手）

$ grep -n "_onTransportStart\|_onTransportStop\|setTransportHooks" packages/engine/src/core/global.ts
:647-651 定義 / :669 start() 内で発火 / :694 stop() 内で発火（§5 の装着対象はこの 1 対のみ）
```

---

## 14. 失敗モード（握り潰される経路が無いこと）

| 状況 | 挙動 | 出口 |
|---|---|---|
| 設定 off | env `'0'` → writer 不装着 | 起動ログ `Session log: off` |
| `<DIR>/` mkdir 失敗（権限・読み取り専用） | `disabled = true`・再生継続 | `console.warn` + `{"sessionLog":{"event":"disabled"}}` |
| ファイル open 失敗 / EEXIST | 既存（`:152-163`）| 同上 |
| 書き込み失敗（disk full） | 既存（`:203-211`）| 同上 |
| `//#sourceFile` 無し（untitled / agent） | `untitled` フォールバック | meta `sourceFile: null` |
| `//#evalEnd` が届かない（engine 死・書き込み途絶） | 次の `//#evalMark` が閉じて実行 / engine 死なら拡張が bridge を drain（`:2219-2222`）| `[ERROR]` 診断 |
| `//#evalBegin` 二重 / `//#evalEnd` 単独 | 診断に積む・状態をリセット | `evalMark` で返る |
| フレーム内構文エラー | フレーム全体棄却 | 診断（`kind: 'parse'`）|
| replay: JSONL 1 行が壊れている | 行番号つきで停止（exit 2）| stderr |
| replay: `logVersion !== 2` | 停止（exit 2）| stderr `unsupported logVersion` |
| replay: `start` レコード無し（クラッシュで途中） | 停止（exit 2・「no transport start」）| stderr |
| replay: 目標 transport が過去（tempo 変更で逆転） | 即時投入（`max(0, ms)`）| stderr に 1 行 `late by N ms` |
| replay: eval 失敗（asset 欠落等） | 診断を出して続行（記録側と対称）| stderr `[ERROR]` |
| replay: `sourceFile` の解決先が無い | `documentDirectory` は `scoreDir` なので `audio()` が従来のエラーを出す | 同上 |

---

## 15. 確信度と反証方法

| 主張 | 確信度 | 反証方法 |
|---|---|---|
| 注入 DSL 文は冗長（§3.3） | 高 | 注入を外して既存 gated E2E（`:922-949`・相対 `audioPath`）を回す。赤なら `execute()` の順序に穴 |
| フレーム化で `play` と同じ意味論になる | 高 | `play-mode.ts:70` は 1 `execute()`。unit: 3 文のフレームで `execute` が 1 回・`recordEval` が 1 回（`toHaveBeenCalledTimes(1)`）|
| transport 駆動でライブと同じ小節に quantize される | 中〜高 | E2E-R1。落ちるなら `msUntilTransportPosition` と `msToBarBeat` の不一致か、`Date.now()` 基準と audio clock の乖離 → その時は replay の目標時刻を `audioEngine.getCurrentTime()` 基準へ寄せる（`getTransportPosition` も同じ基準に揃える必要があるので spec 変更） |
| 既定 on が既存 E2E を壊さない | 高 | 既存 gated suite 全件（ログが tmpRoot に増えるだけ）|
