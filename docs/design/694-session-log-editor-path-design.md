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

## 2b. B の実測 — 今日のログでリプレイできるか（owner 指示 2026-09-03・実装を実走して確認）

owner: 「そもそもログが出ていた時に再現に使える形になっている様に中身が見えなかったという記憶。実装を調べてちゃんとリプレイできるのか？それがないとオフラインレンダリングができない」

**結論: 今日の writer が書くログは、そのままでは再現に使えない。** 欠けているのは 3 層で、(a) **記録の中身**（何が書かれているか）、(b) **時刻の意味**（`transport` が音楽時間になっていない）、(c) **ログの外にある原因**（プラグイン状態・import）。(a) は §3–§4 で設計済み、(b)(c) は本節で新たに設計に足す（§7.2 改訂・§10 PR-L7〜L9・§13 (8)(9)）。

### 2b.1 実走の方法（再現可能）

mock backend の `InterpreterV2`（`tests/session-log/session-log-integration.spec.ts:24-33` と同じ差し替え）に、拡張が実際に stdin へ書く形（`extension.ts:3013-3022` の注入込み）を `createReplSession(interpreter).pushLine`（`repl-mode.ts:300`）で 1 行ずつ流し、`Date.now` を `vi.spyOn` で進めた。`ORBITSCORE_SESSION_LOG` は `enableSessionLog` で直接 on。生成された `.orbslog` の全レコードが下の根拠。probe は `tests/` に残していない（scratch。同じ手順で E2E-S6 / E2E-R1 を書く）。

### 2b.2 生成されたログ（抜粋・`wall` は `Date.now` を差し替えたため負値 = probe の artefact）

```jsonl
{"type":"meta","logVersion":1,"engineVersion":"2.0.0","dslVersion":"1.1","startedAt":"2026-09-03T07:52:34.227Z","sourceFile":null}
{"type":"eval","transport":null,"effect":null,"code":"//#documentDirectory /tmp/orbslog-probe-u00VrW","sourceFile":null,"evalSource":"human"}
{"type":"eval","transport":null,"effect":null,"code":"var global = init GLOBAL","sourceFile":null,"evalSource":"human"}
{"type":"eval","transport":null,"effect":null,"code":"global.setDocumentDirectory(\"/tmp/orbslog-probe-u00VrW\")","sourceFile":null,"evalSource":"human"}
{"type":"eval","transport":null,"effect":null,"code":"global.tempo(120)", ...}
{"type":"eval","transport":null,"effect":null,"code":"global.beat(4 by 4)", ...}
{"type":"eval","transport":null,"effect":null,"code":"var kick = init global.seq", ...}
{"type":"eval","transport":null,"effect":null,"code":"global.start()", ...}
{"type":"transport","event":"start"}
{"type":"eval","transport":"1:3.000","effect":null,"code":"global.tempo(60)", ...}            ← 1000 ms 後（120 BPM で 2 拍 = 正しい）
{"type":"eval","transport":"1:2.010","effect":"2:1.000","code":"LOOP(kick)", ...}            ← その 10 ms 後。位置が**逆行**（1:3.000 → 1:2.010）
{"type":"eval","transport":"1:2.210","effect":null,"code":"kick.play(1, 0, 1, 0)", ...}
{"type":"eval","transport":"1:2.210","effect":null,"code":".gain(-6)", ...}                  ← チェーンが行で割れて 2 レコード
{"type":"eval","transport":"1:2.310","effect":null,"code":"global.stop()", ...}
{"type":"transport","transport":"1:2.310","event":"stop"}
```

ファイル名は `untitled.20260903-075234.orbslog`（cwd 直下）。

### 2b.3 欠落の一覧（`path:line` は main `ca176f0`）

| # | 欠落 | 根拠（コード） | 根拠（ログ） | replay への影響 | 手当 |
|---|---|---|---|---|---|
| G1 | `code` に拡張の注入（`//#documentDirectory` 行・`global.setDocumentDirectory(...)`）が混じり、**メタ行だけの eval レコード**まで出る | `extension.ts:3013-3022` / `repl-mode.ts:371-376`（`source: code` をそのまま渡す）| 上の 1・3 行目 | 再生機の cwd に依存した絶対パスを再評価する。譜面を動かすと壊れる | §3.3（PR-L1a）|
| G2 | `sourceFile` が常に null → `untitled` / cwd 直下 | `repl-mode.ts:371-376`（`sourceFile` を渡さない）/ `session-log-writer.ts:124-127` | meta `sourceFile:null`・ファイル名 | `--score-dir` 無しでは `audio()` の相対解決先が無い | §3.2（PR-L1b）|
| G3 | **1 行 = 1 eval**。選択 1 回が N レコードになり、チェーン継続行（`.gain(-6)`）が単独の eval として実行・記録される | `repl-mode.ts:510-513` | `kick.play` / `.gain` の 2 行 | 記録粒度と提出粒度が違う。replay は行単位で再投入すれば**同じ結果**にはなるが、構文エラーの途中実行（§4.2）まで忠実に再現することになる | §4（PR-L2）|
| G4 | `evalSource` が常に `'human'`。MCP（`evaluate_orbitscore`）の eval に印が無い | `repl-mode.ts:375` 固定 / `extension.ts` `evaluateForAgent` → `writeCodeToEngine`（同じ stdin・印なし）| 全行 `"human"` | 再現性には影響しない。spec §3 の `agent` 識別（コンサートシステムの介助 / 自律の区別）が**成立していない** | フレームに属性を持たせる（§4.1 改訂・PR-L2）|
| G5 | **評価の結果が記録されない**。`recordEval` は `execute()` の**先頭**（`interpreter-v2.ts:156-167`）で、成功 / 失敗 / 診断は書かれない。REPL は `//#evalMark` で `ok` + `diagnostics` を**既に計算している**（`repl-mode.ts:402-417`）のに捨てている | 同左 | `kick.audio("does-not-exist.wav")` が成功と区別つかない | replay は「同じ失敗を再現する」のが正しい（因果の対称）。だが**検証**（`--verify`）と人間の読解に結果が要る | `type:'result'` レコード（§6 改訂・PR-L7）|
| G6 🔴 | **`transport` が音楽時間ではない**。`msToBarBeat` は「start からの経過 ms を**今の** tempo/beat で割る」（`global.ts:755-768`）ので、走行中に tempo/beat を変えると**過去まで書き換わる**（1:3.000 の 10 ms 後が 1:2.010）。`effect` と LOOP の quantize も同じ式（`quantize-manager.ts:61-72`・origin からの境界数 × 今の周期）で、tempo(60) の直後の LOOP は「+2990 ms」待った | `global.ts:726-745` / `transport-clock.ts:28`（origin は start 時に 1 回だけ・tempo 変更で再基準化しない）/ `global.ts:239-255`（`tempo()` は clock に触れない）| `1:3.000` → `1:2.010` の逆行・`effect:"2:1.000"` | (i) replayer が「記録時と同じ式の逆関数」を使えば**時刻としては自己整合**する（`wall` と同じ情報なので再現はできる）。(ii) しかし **`--until 57:1` の「57 小節目」が実際に鳴った 57 小節目と一致しない**・人間にもログが読めない・`effect` が嘘になる。(iii) LOOP の quantize 自体が tempo 変更後に**境界を飛ばす**（今日の挙動・replay とは独立のバグ）| **`TransportTimeline`**（§7.2 改訂・PR-L8）。quantize を同じ timeline に乗せるかは 🔴 §13 (8) |
| G7 🔴 | **プラグインの状態がログの外**。`instrument()` / `effect()` は `statePath` 省略時に `project.yaml` の `states[key]`（`project-state-store.ts:122`）を読み、`global.stop()` の auto-snapshot（`global.ts:700-711` → `:1409`）と `//#savePluginState` が**同じ相対パスへ上書き**する（`project-state-store.ts:234-235`・`:290`・版なし）。UI のつまみ操作（`//#pluginUi`・`repl-mode.ts:386-400`）は `execute()` を通らないので eval にならない | 同左 | probe は plugin 無し（mock）| replay の `instrument("x")` は**その後の別セッションで上書きされた状態**を読む → 同じ DSL で違う音。**オフラインレンダの再現性が成立しない**（#598 P3 の前提）| セッション開始時に状態を `orbslog/` へ写す（PR-L9・🔴 §13 (9)）|
| G8 | **import した module の中身がログに無い**。`processFileImports` は eval 時にディスクを読む（`process-file-import.ts:117`）。`code` は entry の文だけ | 同左 | — | module を編集した後の replay が別の曲になる | `type:'import'` レコード（path・sha256・本文。PR-L7）|
| G9 | **音声資産の同一性が無い**（`audio()` の wav は path のみ） | — | — | `--verify` で検出するしかない | `meta.assets` sha256（§7.5・PR-L6・裁定済み）|
| G10 | 乱数（`r` 等）は再抽選 | `sequence.ts:1322` / `:1327`・`random-utils.ts:19-22` | — | **仕様どおり**（原則 2「原因として記録し再度引く」）| なし |
| G11 | `midi-run.ts`（MIDI 単独実行）と `//#selectAudioDevice` / LinkAudio は記録外 | `interpreter-v2.ts:150-151` / `repl-mode.ts:441-445` | — | device 選択はハードウェアで再現に無関係。LinkAudio は裁定 (6) で扱わない | なし |

**owner の記憶と一致する箇所**: G1（`code` が注入で汚れて読めない）・G2（`untitled` が cwd に落ちる）・G3（1 行ずつ割れて選択の形が残らない）が「中身が見えなかった」の実体。**それに加えて** G6 / G7 は「見えていても再現できない」欠落で、オフラインレンダ（#598 P2/P3）が `.orbslog` を入力にする以上、**PR-R5 の前に塞ぐ**（§10・plan §1.2）。

### 2b.4 「再現できる」の定義（本書が保証する範囲・spec §2 原則 1–2 に従う）

| 再現する | 再現しない（設計上） |
|---|---|
| DSL の評価列と各評価の transport 位置（ms 精度・G6 の手当後は音楽時間）| 乱数の実現値（G10）|
| LOOP / RUN / 差し替えが効いた小節（transport 駆動 + 同じ quantize）| 外部入力（LinkAudio / MIDI in / OSC in）|
| セッション開始時点のプラグイン状態（G7 の手当後）| セッション**中**の UI 操作（つまみ）— `--verify` が start≠stop の差で警告する |
| import した module の本文（G8 の手当後）| 音声資産の中身（hash で**検出**だけ・G9）|
| 評価の成功 / 失敗（G5 の手当後・検証用）| — |

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

フレームは**属性**を持てる（G4 の手当）: `//#evalBegin {"evalSource":"agent"}`（JSON は任意・省略時 `human`）。`evaluateForAgent`（`extension.ts` MCP 経路）だけが `agent` を付け、`run_selection` は付けない。`execute()` の `evalSource` はこの属性から決める（`repl-mode.ts:375` の固定値を廃止）。

`createReplSession` に `let frame: { lines: string[]; evalSource: EvalSource } | null = null` を足す。`handleLine`:

| 行 | 動作 |
|---|---|
| `//#evalBegin [json]` | `frame !== null` なら `[ERROR] //#evalBegin while a frame is open — previous frame discarded`（診断に積む）。`frame = { lines: [], evalSource: json?.evalSource ?? 'human' }` |
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

実測（§2b.2）: 6 行の選択が 6 レコードになり、`kick.play(1, 0, 1, 0)` と継続行 `.gain(-6)` が**別々の eval** として実行・記録された。行単位の記録でも replay は同じ行単位で再投入すれば同じ結果になるが、「選択の形」がログに残らない（owner の記憶「中身が見えなかった」の一部）。

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

### 6b. v2 で足すレコード（G5 / G8 の手当・PR-L7）

| type | いつ | フィールド | 用途 |
|---|---|---|---|
| `result` | フレームの `execute()` が返った直後（`//#evalMark` の `ok` / `diagnostics` と**同じ値**・`repl-mode.ts:402-417` を 1 箇所に寄せる）| `{ "type":"result", "wall", "ok": boolean, "diagnostics": [{kind, message}], "effect": string \| null }` — `effect` はここで**実行後**に確定した値（LOOP に限らず quantize 待ちの差し替えも）| `--verify` の比較・人間の読解。**replay の投入判断には使わない**（失敗も再現する = 因果の対称）|
| `import` | `processFileImports` が module を**初めて**読んだ時（セッション内で 1 回・`process-file-import.ts:117` の直後）| `{ "type":"import", "wall", "path": <ログ基準の相対>, "sha256", "code": <本文> }` | replay は `code` を**ディスクより優先**して評価する（module を編集しても同じ曲）。sha256 は `--verify` で今のディスクと照合 |
| `pluginState` | `start`（ログを開いた時）と `stop` の直後（PR-L9・§13 (9)）| `{ "type":"pluginState", "at": "start" \| "stop", "states": [{ "key", "path": <ログ基準の相対> }] }` | replay は `at:"start"` の path を `statePath` として渡す（`effect-slot.ts:617-621` の解決順の**先頭**に入れる）。`--verify` は start≠stop（bytes）なら「セッション中に状態が変わった」と警告 |

`eval` レコード自体のフィールドは変えない（§6 の表）。`transport` の**意味**だけ §7.2 で音楽時間に直す。

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

### 7.2 駆動: transport 時刻（裁定 4）— 🔴 まず `transport` を音楽時間にする（G6・PR-L8）

**今日の `bar:beat` は音楽時間ではない**（§2b.3 G6）。`msToBarBeat`（`global.ts:755-768`）は start からの経過 ms を**現在の** tempo/beat で割るので、走行中の `global.tempo()` / `global.beat()` で過去の位置まで動く。replay の目標時刻・`--until`・`effect`・人間の読解のすべてがこの値に乗るので、replayer より先に直す。

```ts
// packages/engine/src/core/global/transport-timeline.ts（新設・pure・約 80 行）
export interface TimelineSegment {
  readonly fromMs: number            // transport 原点からの ms（この区間の開始）
  readonly fromBeatUnits: number     // 開始時点の累積拍（meter 拍単位）
  readonly tempo: number
  readonly beat: { numerator: number; denominator: number }
}
export class TransportTimeline {
  constructor(initial: { tempo: number; beat: Meter })          // start() で生成
  /** 走行中に tempo / beat が変わった瞬間に呼ぶ。区間を閉じて新区間を開く（origin は動かさない）。 */
  change(atMs: number, next: { tempo?: number; beat?: Meter }): void
  msToBarBeat(elapsedMs: number): string                          // 区間ごとに積算
  barBeatToMs(pos: string): number                                // 逆関数（同じ区間表を逆に辿る）
  nextBoundaryMs(elapsedMs: number, q: QuantizeValue): number     // §13 (8) が A なら nextQuantizedTime の置き換え
}
```

`Global` は `TransportClock.start()` で timeline を作り、`tempo(value)` / `beat(...)` の中で `transportClock.running` なら `timeline.change(now - startTime, …)` を呼ぶ（`global.ts:239-255` に 1 行）。`getTransportPosition` / `getQuantizedEffectPosition` / 新設 `msUntilTransportPosition` はすべて timeline 経由。**stop で破棄**（transport 停止中は null のまま・不変）。

**quantize（LOOP 起動・差し替え）を同じ timeline に乗せるか**は挙動変更なので 🔴 §13 (8)。乗せない（B）場合、記録の `transport` は正しい音楽時間になるが、LOOP が実際に効く境界は今日のまま（tempo 変更後に飛ぶ）なので、replay は**その飛びも同じに再現する**（同じ関数を使うため）。乗せる（A）場合、境界の飛びが直り、`effect` と実際が一致する。

```ts
// global.ts（新設・pure・timeline の逆関数）
/** 現在の timeline で `"bar:beat"` に到達するまでの ms（負なら過去 = 即時）。transport 未走行なら null。 */
msUntilTransportPosition(pos: string): number | null
```

replayer のループ:

```
records = readOrbsLog(logPath)            // tests/session-log/helpers.ts:4 と同じ読み方
assert meta.logVersion === 2
imports = records.filter(type === 'import')            // path → code（ディスクより優先・§6b）
states  = records.find(type === 'pluginState' && at === 'start')   // key → statePath（§6b）
for rec of records:
  eval  (transport === null)  → execute(rec) 即時（プリアンブル。global.start() を含む eval がここに来る）
  transport start             → 何もしない（start は直前の eval が起こした結果。到達確認だけ: global.getTransportPosition() !== null を assert）
  eval  (transport !== null)  → ms = g.msUntilTransportPosition(rec.transport); await sleep(max(0, ms)); execute(rec)
  result / import / pluginState → 投入しない（--verify だけが読む。import は上で先読み済み）
  transport stop              → 同上（到達確認）。until 無しならここで終了
execute(rec) = interpreter.execute(parseAudioDSL(rec.code), { source: rec.code, sourceFile: resolve(scoreDir, rec.sourceFile), documentDirectory: scoreDir, evalSource: 'replay', importOverride: imports, pluginStateOverride: states })
```

- **tempo 変更**はそれ自体が eval なので、次の目標時刻は「その eval を実行した後」の timeline で計算する（記録側と同じ timeline なので一致する。DDR `:182`「参照系はログ内で自己完結」）
- **quantize** は engine が音楽時間で再解決する（`effect` は使わない・spec §3.1）
- 評価失敗はそのまま診断に出して**続行**（記録側も `result.ok:false` を残すだけで止まらない。因果の記録として対称）
- replayer 自身のログ: CLI の gate に従う（`ORBITSCORE_SESSION_LOG=1` の時だけ）。既定 off にする理由: 再生のたびに `evalSource: "replay"` のログが増える
- **`wall` は使わない**が捨てない: G6 の手当前に書かれた v1 ログは 0 本なので互換分岐は作らない（§2 最終行）

### 7.3 `--score-dir`

`sourceFile` は相対（§6）。既定の基準 `dirname(dirname(logPath))` はログを動かしていない限り正しい。動かしたら明示する。`audio()` の相対解決は `documentDirectory = scoreDir` で従来経路（`interpreter-v2.ts:215-217`）。

### 7.4 `--until <bar:beat>`（裁定 6）— 高速畳み込みを最初から設計する（owner 2026-09-03 Q-598-7・B）

v1 の「忠実リプレイを `until` で止めて REPL へ」は**残す**（`--until <pos> --realtime`）が、既定は**高速畳み込み**にする。owner:「先にやったほうが後から変えるところが増えない」。

**設計 = 宣言の再生 + 位置指定の transport 開始**（2 相）:

```
Phase A（仮想）: doc 598 §6.3 の driver（Clock DI + CollectingEngine）で、`transport < until` の eval を
                 仮想時刻どおりに畳み込む。得るのは「until 時点の状態」= 宣言（seq / line / plugin / quantize / tempo）と
                 「until 時点で LOOP 中のシーケンス集合」と「until 時点で quantize 待ちだった差し替えのうち effect <= until のもの」
Phase B（実機）: 実エンジン（REPL と同じ InterpreterV2）に対して
                 (1) 宣言系の eval を**即時に**再評価する（transport 命令・play/LOOP 起動を除く。effect <= until の差し替えは
                     Phase A の結果を反映した状態で評価するので「適用済み」になる）
                 (2) `global.start({ at: until })` — transport の原点を `now - ms(until)` に置いて開始する（新設・§7.4.1）
                 (3) Phase A で LOOP 中だった seq に LOOP を発行する。ループ機構は `currentTime = now - startTime`（`prepare-playback.ts:74`）
                     で次の小節境界を計算するので、位相は `until` から自然に続く
                 (4) `startREPL(interpreter)` へ引き継ぐ（エディタには何も書かない・Known Decision #25）
```

**spec §8 (3)「境界ちょうど」の状況（owner Q-694-3「どういうシチュか」）**: quantize = bar。ライブで **56:3** に `kick.play(1,0,0,1)` を評価した。差し替えは次の小節頭 **57:1** で効く（ログには `transport:"56:3.000"`、`result.effect:"57:1.000"`）。後日 `replay --until 57:1` で 57 小節目の頭まで畳み込んでライブへ引き継ぐとき、**引き継いだ瞬間の kick は新パターンか旧パターンか**、という問い。境界より手前（`--until 56:4`）なら明らかに旧、境界より後（`--until 57:2`）なら明らかに新で、**ちょうど 57:1** だけが両方に読める。

**答え（推奨）**: ライブでは 57:1 に到達した瞬間に、57:1 で効く差し替えは**もう効いている**。
したがって `--until 57:1` の状態 = **effect <= until の差し替えを適用済み**とする（Phase A は仮想クロックを `until` まで**含めて**進める）。
「まだ効いていない状態で止めたい」なら `--until 56:4.999` のように手前を指す。**この解釈で owner 確認をとる（§13 (3)）。**

#### 7.4.1 `Global.start({ at })`（新設・`global.ts:655` の隣）

```ts
/** transport を `at`（bar:beat）の位置から開始する。原点 = now - msOf(at)。stopped → running の遷移のみ（既存 start() と同じ冪等性）。 */
startAt(at: string): this
```

`TransportClock.start()`（`transport-clock.ts:26-30`）に `startTime` を外から与える経路（`startAtOrigin(originMs)`）を足す。`_onTransportStart` フックはそのまま発火し、ログには `{"type":"transport","event":"start","at":"57:1"}` を残す（v2 形式に `at` を**任意**で追加）。

**依存**: Clock DI（doc 598 PR-R4）と評価列 driver（PR-R5）。よって PR-L5 は PR-R5 の後。

### 7.5 `--verify`（裁定 7）— イベント列の sidecar を最初から持つ（owner 2026-09-03 Q-694-4）

owner:「後回しにすると負債が増える。きちんと比較ができる仕組みづくりをしておく」。capture 比較（E2E-R1）に加えて、**spec §5 の構造比較を実行可能にする**:

| 何を | どこへ | 形 |
|---|---|---|
| ライブ側のスケジュール済みイベント列（audio: `scheduleEvent` / `scheduleSliceEvent` の引数・note: `scheduleNote` の `onTime/offTime/key/velocity`）| **sidecar** `<log>.events.jsonl`（`.orbslog` と同じディレクトリ・同じ stem）。`.orbslog` 本体は原因のみ（原則 1）を守る | 1 行 = 1 イベント `{ "t": <transport ms>, "seq": "kick", "kind": "audio"\|"note", "slot": 3, "gain": -6, "pan": 0, "key": 60, ... }`（値は記録するが、比較は原則 2 のとおり**構造のみ**）|
| アセットの同一性 | `.orbslog` の meta `assets: [{ path, sha256 }]`（spec §3 の例のとおり）| `global.start()` 時に **worker thread で非同期にハッシュ**し、`{"type":"assets", ...}` レコードとして**後追いで追記**（start を待たせない）|

- 記録は `AudioEngineBackend` の手前（`Scheduler` interface `core/global/types.ts:11` の呼び出しを **decorator** で包む）に置く。engine には触らない
- `replay --verify` は同じ decorator で replay 側のイベント列を集め、**構造比較**（seq / kind / slot / 順序 / transport 時刻の許容差）を出す。ランダム由来（`^r` 等・`event-scheduler.ts:39,94`）は値を比較しない（Known Decision #21）
- 実装は **PR-L6**（PR-L4 の後）。E2E-R4: 同じセッションの replay で `--verify` が差分 0 を報告する

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
| PR-L5 `feat(cli): replay --until — fast-forward fold, then hand over to the REPL` | §7.4（2 相・`Global.startAt`・`--realtime` で忠実停止も残す）| PR-L4・**doc 598 PR-R4（Clock DI）・PR-R5（評価列 driver）** | ログ形式に `at`（任意・加算）|
| PR-L6 `feat(session-log): event sidecar + assets hash for replay --verify` | §7.5 | PR-L4 | sidecar ファイル形式 |
| PR-L7 `feat(session-log): result / import records; agent provenance from the MCP path` | §6b（`result` / `import`）+ §4.1 フレーム属性（G4 / G5 / G8）| PR-L2 | 形式（加算のみ）|
| PR-L8 `feat(core): TransportTimeline — bar:beat as musical time across tempo/beat changes` | §7.2 前半（G6）。`getTransportPosition` / `getQuantizedEffectPosition` / `msUntilTransportPosition` を timeline へ。quantize を乗せるかは §13 (8) | PR-L1a（integration test が要る）。**PR-L4 と PR-R5 の前提** | `transport` の**意味**（v1 ログ 0 本なので実害なし）・(8)=A なら LOOP quantize の挙動 |
| PR-L9 `feat(session-log): snapshot plugin states into orbslog/ at start and stop` | §6b `pluginState`（G7）。`orbslog/<log>.states/<key>.state` へ daemon `savePluginState`（auto-snapshot と同じ経路 `global.ts:1409`）。replay は start 側を `statePath` に渡す | PR-L1a・**#598 P3（PR-R8）の前提** | 🔴 §13 (9) |

**順序の要点（§2b の帰結）**: PR-L4（replayer）は **L2 + L7 + L8 の後**、#598 の PR-R5（評価列 driver）も **L8 の後**、PR-R8（P3 instrument offline）は **L9 の後**。「ログを読んで再生する」側を先に作ると、読める形になっていないログを相手にすることになる。

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
| (1) ✅ **A `orbslog/`（owner 2026-09-03）** | `<DIR>/` の名前 | A `orbslog/`（拡張子と同じ語・見える）/ B `.orbslog/`（隠す）/ C `sessions/` | **A**。spec §1「命名・選別は事後の操作」= ユーザーが Finder で見つける前提なので隠さない。`.orbslog` 拡張子と同じ語で検索性が高い | 定数 `SESSION_LOG_DIRNAME` 1 箇所（§3.4）|
| (2) ✅ **B opt-in のまま（owner 2026-09-03）** | CLI（`play` / `repl`）も既定 on にするか | A on（gate を `!== '0'` に）/ B opt-in のまま | **B（現状維持）**。拡張は値を明示するので editor 側は独立（§3.1）。CLI は開発・テストで多用され、譜面の隣にログが増えるのを望まない場面がある | `session-log-gate.ts:13` の 1 行 + core spec `:63` |
| (3) 🔴 **相談中**（owner「理解がまだできない。どういうシチュなの？」→ §7.4 に具体例〔56:3 で評価した差し替えが 57:1 で効く時の `--until 57:1`〕を書いた。チャットでも説明・確認待ち）| `--until` が境界ちょうどの時、待機中の quantize 差し替えを適用してから引き継ぐか | spec §8 (3) | v1 は忠実リプレイの停止点なので**問いが立たない**（境界に着く前に止めれば未適用、着けば適用）。高速畳み込み版で再燃 | PR-L5 以降 |
| (4) ✅ **B + C（owner 2026-09-03: 比較の仕組みを最初から）** → §7.5 に反映・PR-L6 | `--verify` の実体 | A capture 比較のみ（v1）/ B ライブ側にイベント列 sidecar（`type:'event'` を**別ファイル**に）を足して構造比較 / C `meta.assets` の sha256（start 時に非同期で） | **A を v1**。B/C は「原因のみ記録」（原則 1）との整合を owner が判断 | PR-L4 の範囲 |
| (5) ✅ **A 露出する（owner 2026-09-03）** | replay を MCP tool（`replay_session_log`）として露出するか | A 露出（LLM 第一級）/ B CLI のみ | **A を後続**（#241 チェックリストに無い。E2E-R1 は CLI 動線で成立） | 新規 PR |
| (6) ✅ **A 扱わない（owner 2026-09-03: ログに残るのは DSL と実行内容。Ableton 側で受けられるかは Ableton の設定）** | POST_2.0 覚書の「LinkAudio トラックを捕捉しない」（`POST_2.0_ROADMAP_NOTES.md:60`）は本書で扱うか | LinkAudio の出力は**現象**（録音）で因果の記録の外（原則 1）| **扱わない**（Ableton 側が録る分業・spec §6）| — |
| (7) ✅ **実測で確定（owner 2026-09-03「ログが出ていた時に再現に使える形になっていなかった」→ §2b で実走）** | dormant の根拠は何か | — | **「env が渡っていない」に加えて、出ていたログ自体が再現に使えない形**（§2b.3 G1/G2/G3 = 見えない、G6/G7 = 見えても再現できない）。手当は PR-L1〜L9 | §2b |
| (8) 🔴 **新規**（G6）| LOOP / 差し替えの **quantize を `TransportTimeline` に乗せるか** | A 乗せる（tempo 変更後も境界が連続・`effect` と実際が一致・**LOOP 起動タイミングの挙動変更**）/ B 乗せない（記録だけ音楽時間・LOOP は今日どおり tempo 変更後に境界が飛ぶ・replay はその飛びも再現）| **A**。今日の飛びは「経過 ms を新周期で割り直す」実装の副作用で、誰も意図していない（`quantize-manager.ts:61-72` に設計意図の記述なし）。ただし `play()` の意味論ではなく **transport の意味論**なので owner 裁定 | PR-L8 の 1 分岐（`nextQuantizedTime` の呼び手 = `prepare-playback.ts` / LOOP 起動）|
| (9) 🔴 **新規**（G7）| プラグイン状態の写し方 | A `orbslog/<log>.states/` へ **start と stop でファイルを写す**（daemon `savePluginState`・plugin 1 個あたり数 ms〜数十 ms・非同期・auto-snapshot と同経路）/ B start 時に **sha256 だけ**記録し replay で不一致を警告 / C 何もしない（replay は「今の」状態を読む）| **A**。B/C はオフラインレンダ（#598 P3）が「同じ DSL で違う音」になり、owner の目的（840 / 1260 を後日レンダ）に反する。UI のつまみ操作はどのみち残らないので、`--verify` が start≠stop で警告する | PR-L9 |

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
| replay: `import` レコードの `code` と今のディスクの sha256 が違う | `code` を使って評価（再現優先）・stderr に 1 行 `import <path> differs from disk` | stderr |
| replay: `pluginState` の `path` が無い（`orbslog/` を動かした） | 従来の解決順（`project.yaml`）へ**落とさない**。停止（exit 2・「state snapshot missing」）— 黙って別の音で鳴らさない | stderr |
| 記録: start 時の状態写しに失敗（daemon エラー） | `pluginState` レコードに `{ key, error }` を残して**再生継続**（flight recorder） | `console.warn` + `get_log` |
| 記録: 走行中の `tempo()` / `beat()` で timeline が区間を切る | 位置は連続（逆行しない）。integration test: 120→60 の 10 ms 後が `1:3.010` | — |

---

## 15. 確信度と反証方法

| 主張 | 確信度 | 反証方法 |
|---|---|---|
| 注入 DSL 文は冗長（§3.3） | 高 | 注入を外して既存 gated E2E（`:922-949`・相対 `audioPath`）を回す。赤なら `execute()` の順序に穴 |
| フレーム化で `play` と同じ意味論になる | 高 | `play-mode.ts:70` は 1 `execute()`。unit: 3 文のフレームで `execute` が 1 回・`recordEval` が 1 回（`toHaveBeenCalledTimes(1)`）|
| transport 駆動でライブと同じ小節に quantize される | 中〜高 | E2E-R1。落ちるなら `msUntilTransportPosition` と `msToBarBeat` の不一致か、`Date.now()` 基準と audio clock の乖離 → その時は replay の目標時刻を `audioEngine.getCurrentTime()` 基準へ寄せる（`getTransportPosition` も同じ基準に揃える必要があるので spec 変更） |
| 既定 on が既存 E2E を壊さない | 高 | 既存 gated suite 全件（ログが tmpRoot に増えるだけ）|
| 今日の `transport` は tempo 変更で逆行する（G6） | **実測済み**（§2b.2: `1:3.000` → `1:2.010`）| — |
| `TransportTimeline` で replay の目標時刻がライブと一致する | 高 | integration: 記録側 timeline と replay 側 timeline に同じ tempo 列を与えて `barBeatToMs(msToBarBeat(x)) === x`（区間境界の前後 1 ms を含む）|
| 状態写し（PR-L9）でオフラインレンダが再現する | 中 | E2E-R8（doc 598）: つまみを動かして stop → 別の状態で replay --render → start 側の状態で鳴る（RMS がライブ capture と一致）|
