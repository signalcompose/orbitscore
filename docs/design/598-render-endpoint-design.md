# 設計: render エンドポイント — `mix.render(<path>)` × 実時間タップ × オフライン driver（#598 P2/P3・#241 `--render`）

**対象 issue**: #598（P2 オフライン driver / P3 プラグイン・instrument の offline 駆動・宛先のエンドポイント宣言）/ #241 `--render` / 地図 §7 (7)(8)(11)（実時間 per-bus stem・プレースホルダ・書き出しの操作面）
**前提**: `docs/design/611-output-line-design.md`（ライン模型・`OutputDest.kind: 'render'`・`SetBusLine`・`MasterLine`）/ `docs/design/694-session-log-editor-path-design.md`（`.orbslog` v2・replayer）
**正本**: `docs/specs-v2/MULTICHANNEL_RENDERING_DESIGN_598.md`（§4.1 OfflineRenderSession・§4.2 stem 意味論・§4.5 決定論・§5 P3・§P0-B/P0-D は**そのまま有効**。本書はその上に「宛先 = 宣言されたノード」を載せ、変わる箇所だけを書く）/ core spec MX.2.1
**状態**: 設計（実装しない）・2026-09-03・main `ca176f0` 実測

---

## 0. owner 裁定（2026-09-03・再議論しない）

| # | 裁定 | 出どころ |
|---|---|---|
| 1 | render の宛先は**エンドポイント宣言** `var stem = mix.render("stems/kick_%v.wav")` → `output(stem)`。番号・ファイル名・物理アウトを特別扱いしない | #598 コメント 8 / 地図 §4.A.3.1 |
| 2 | トラック別は **`%n` テンプレート**（宣言 1 行）。`%n` = シーケンス変数名（`sequence.ts:197-200 setName` で実装可能と実測） | 同上 |
| 3 | **解決後のパスが同じなら合算**（#611 決定 1 と同じ規則）。テンプレートなら分かれ、固定名なら混ざる | 同上 |
| 4 | パスは**譜面（`.orbs`）からの相対**（ログの置き場と同じ原則） | 同上 |
| 5 | master も同じ: `mix.render("mix_%v.wav")` を宣言して master ラインから `output` | 同上 |
| 6 | `outs:` の値が render ノードを指せる（#409） | 同上 |
| 7 | pre / post fader は**タップの位置**が答え（オプションにしない） | 同上 / memory `audio-line-order-is-the-model` |
| 8 | stem = 各バス stereo WAV・48k / f32・master post は stem に乗せない・`T` はレンダ要求のパラメータ・プラグインは必須（P3 は optional ではない） | #598 コメント 3 裁定 2/3/4・コメント 1 |
| 9 | `.orbslog` replay は別 issue（#241）だが `--render` は #598 P2 の driver へ「transport 順の評価列」を投入する**積** | #241 コメント 2 |
| 10 | 順序: ① ログ（#694）→ ② リプレイ確認（#241）→ ③ オフラインレンダ（本書） | #694 コメント 3 |

🔴 **owner 未決（§16 に隔離・本書はそこに触れない）**: プレースホルダの語彙（`%v` / `%d`）/ 3ch 以上を 1 ファイルに / 実時間 per-bus stem の優先順位と issue の置き場。

---

## 1. 到達点（1 文）

**`var stems = mix.render("stems/%n_%v.wav")` を宣言して `kick.output(stems, thru: true).output(master)` と書けば、実時間の演奏中は `stems/kick_001.wav` に kick の（タップ位置の）音が書かれ続け、`orbitscore replay <log> --render` または `render <score> --duration T` は同じライン・同じ engine の `render_block` を実時間より速く回して同じファイル群を作る。** 宛先は 1 種類（render ノード）で、**実時間で書くか高速で書くかは driver（時計）の差**だけになる（地図 §4.A.3「宛先は同じにできる可能性」→ 本書で「できる」）。

---

## 2. 現在地（一次情報）

| 事実 | 根拠 |
|---|---|
| `output(n)`（1..16）は `_renderBus` に**記録するだけ**。instrument は拒否 | `sequence.ts:376-400` / MX.2.1 |
| `RenderScore` manifest は P1 で受理・検証のみ。ハンドラは `NOT_IMPLEMENTED` | `session.rs:1941-1950` / `render-score.ts:42-51` / fixture `tests/fixtures/render-score-manifest.json` |
| `renderScore()` の**本番呼び出し元は 0**（`daemon-client.ts:615` のみ） | grep `renderScore(` |
| capture = master post-mix を 1 本、daemon 起動時 env のみ、開始 / 停止 RPC 無し | `engine_wrap.rs:4153` / `output.rs:1410-1425` / `session.rs` ハンドラ列挙（§10.4）|
| capture の producer `RingTapSink::commit` は wait-free / no-alloc。consumer `CaptureWriter` は off-thread・定期 header patch・RAII drop | `link_audio_ring.rs:14-49` / `capture.rs:173-310` / `capture.rs:87` |
| `render_block_with_sources` は cpal 非依存で、`insert_buses` の各 `buffer[..bs]` に post-insert 信号が残る | `output.rs:662-700` / 598 設計 §4.2 |
| out-of-process child の同期 offline 駆動は成立（bit-exact） | 598 設計 §3 / `orbit-audio-sandbox/src/offline.rs:82-200` |
| VST3 `Vst3ProcessMode` / CLAP `ClapRenderMode` は実装済み・**呼び出し元ゼロ** | `orbit-vst3-host/src/lib.rs:534,633,1174` / `orbit-clap-host/src/controller.rs:63-69` / #598 コメント 6 |
| 発音時刻の計算は `baseTime` / `loopIteration` の純算術。壁時計は timer と現在位置取得だけ（**41 箇所**・§10.1） | 598 設計 §P0-B / grep |
| `mix.output(1, 2)` / `mix.sum` / `mix.aux` はパーサ lookahead `['output','sum','aux']` で分岐 | `parse-statement.ts:140-149` / `:453-487` / `parser/types.ts:98-111` |
| output ノードはレシーバになれない（throw） | `runtime.ts:303-314`（doc 1 §3.7 で解除）|

---

## 3. DSL 表面

### 3.1 宣言: `var <name> = mix.render("<path template>")`

```orbs
var mix    = init global.mixer
var master = mix.output(1, 2)
var stems  = mix.render("stems/%n_%v.wav")     // テンプレート（%n で分岐）
var mixdl  = mix.render("mix_%v.wav")          // 固定名（合算）

kick .output(stems, thru: true).output(master)
snare.output(stems, thru: true).output(master)
master.output(mixdl, thru: true).output("1,2")  // master ラインから（doc 1 §3.5）
```

- 引数は**文字列 1 個**（`parseMixerNodeDecl` に `render` を足し `STRING` を expect・§4.1）。空文字・`.wav` 以外の拡張子はパースではなく **runtime error**（拡張子は v1 = WAV のみ・裁定 8）
- 相対パスの基準 = **譜面のディレクトリ**（`documentDirectory`・`global.ts:580`・doc 2 §3.4 の `scoreDir` と同じ）。絶対パスも可
- 再宣言（同名で別パス）は **live 差し替え**（S4 #522 の「再宣言は v1 では拒否」を render には適用しない — render は daemon のバス資源を掴まないので、`nodes` の `path` を更新して次の arm から効く）。同名・同パスは冪等
- render ノードは**レシーバにならない**（`effect()` を付けられない）。stem に処理を掛けたいならタップの前に置く（裁定 7）

### 3.2 使う側: `output(<renderNode>, thru: bool = false, db: number = 0)` — doc 1 §2.1 のまま

| 書き方 | 意味 |
|---|---|
| `kick.output(stems)` | 書くだけで鳴らさない（`thru: false` 既定・ラインはここで終わる）= **レンダ専用** |
| `kick.output(stems, thru: true).output(master)` | 書きつつ鳴らす（実時間 stem）|
| `kick.output(stems, thru: true).effect(comp).output(master)` | pre（生）を書く |
| `kick.effect(comp).output(stems, thru: true).output(master)` | post（comp 後）を書く |
| `kick.output(stems, db: -6)` | 書き込みレベル（dB・裁定 ②）|

🔴 **MX.2.1 §4.4.1「オフラインの宣言は live routing を変えない」は本書で失効する。** ライン模型では `thru` が明示なので非対称の規則は要らない。`kick.output(stems)`（thru 無し）は**ライブでは鳴らなくなる**。これは一方通行の意味論変更で、数値 `output(n)` の退役（doc 1 §14 (1)・推奨 A）と同じ PR で spec を書き換える。

### 3.3 テンプレートの展開（`%n` は確定・他は §16 (1)）

```ts
// packages/engine/src/core/global/render-endpoint.ts（新規・pure・unit test 対象）
export interface RenderTemplateContext {
  /** そのラインを持つシーケンスの変数名（master ラインは "master"） */
  readonly seqName: string
  /** 版番号（3 桁ゼロ埋め・§5.4 の arm ごとに +1）— 🔴 語彙は §16 (1) */
  readonly version: number
  /** arm 時刻（`formatLogStamp` と同じ YYYYMMDD-HHMMSS）— 🔴 語彙は §16 (1) */
  readonly stamp: string
}
/** 未知の `%x` は throw（黙って残さない）。`%%` は `%`。 */
export function expandRenderTemplate(template: string, ctx: RenderTemplateContext): string
export function hasPerSequencePlaceholder(template: string): boolean   // `%n` を含むか
```

- **`%n`** = `ctx.seqName`（裁定 2・確定）
- `%v` / `%d` は**表の行として実装できる形**にしておき、語彙は §16 (1)。展開関数の対応表 `PLACEHOLDERS: Record<string, (ctx) => string>` に行を足すだけ
- 展開は **TS（control 側）**で行い、daemon には**解決済み絶対パス**しか渡さない（598 設計 §4.3「state は絶対パス」と同じ層分け）

### 3.4 合算の規則（裁定 3）— インスタンス = 解決後の絶対パス

```
instanceKey = path.resolve(scoreDir, expandRenderTemplate(template, ctx))
```

同じ `instanceKey` を指すすべてのラインの出力は **1 ファイルへ加算**される（§5.2 の scratch 加算）。`%n` があれば seq ごとに別インスタンス、無ければ全 seq が同じインスタンス。**インスタンスの単位が「ノード」ではなく「解決後のパス」**なのが規則の全部。

### 3.5 `outs:`（裁定 6・#409）

`instrument("Battery", outs: { "kick": bd, "snare": stems })` — `outs:` の値は doc 1 §5.6 のとおり `OutputDest` に解決される（`{ kind: 'render', id }` を含む）。unit ごとの passthrough stage のラインが `Output(Render)` を持つだけで、本書に追加の機構は無い。

---

## 4. TS の型と signature

### 4.1 パーサ（`parse-statement.ts`）

| 行 | 変更 |
|---|---|
| `:146` `['output', 'sum', 'aux']` | `['output', 'sum', 'aux', 'render']` |
| `:459` `kind as 'output' \| 'sum' \| 'aux'` | `'render'` を足す |
| `:466-477` output の `(NUMBER, NUMBER)` | `else if (kind === 'render')`: `LPAREN` → `STRING` → `RPAREN`。`statement.path = string` |
| `parser/types.ts:106-111` `MixerNodeDecl` | `kind: 'output' \| 'sum' \| 'aux' \| 'render'`・`path?: string // render only` |

### 4.2 runtime ノード（`signal-chain/runtime.ts`）

```ts
export type MixerRuntimeNode =
  | { readonly kind: 'output'; readonly global: Global; readonly channels: readonly [number, number] }
  | { readonly kind: 'sum' | 'aux'; readonly global: Global; readonly handle: MixerBusHandle }
  | { readonly kind: 'render'; readonly global: Global; readonly id: string; readonly template: string }   // 新設
```

- `registerMixerNode`（`:190-258`）: `kind === 'render'` → `mixerGlobal.renders.declare(variableName, statement.path)`（§4.3）→ `node = { kind: 'render', global, id: variableName, template }`。再宣言は `declare` が冪等 / 差し替え（§3.1）
- `resolveMixerNode`（`:264-291`）: 不変（registry から引ける）
- `mixerNodeReceiver`（`:303-314`）: render は throw のまま（「レシーバにならない」§3.1）。文言を `render endpoints are write-only destinations: put effects before the tap` に変える

### 4.3 `RenderEndpointManager`（`packages/engine/src/core/global/render-endpoint-manager.ts`・新規・約 150 行）

```ts
export interface RenderDeclaration { readonly id: string; readonly template: string }
export interface RenderInstance {
  readonly key: string          // 解決後の絶対パス（§3.4）
  readonly renderId: string
  readonly seqName: string      // "%n" 無しなら "*"
  readonly slot: number         // daemon 側 RenderInstance slot（arm の戻り値）
}
export class RenderEndpointManager {
  constructor(private readonly engine: AudioEngineBackend, private readonly scoreDir: () => string)
  declare(id: string, template: string): RenderDeclaration        // 冪等 / 差し替え。daemon: DeclareRender
  get(id: string): RenderDeclaration | undefined
  /** `global.start()` 時: 参照されている (render × seq) を展開して daemon へ ArmRenders。戻り値で slot を得る */
  arm(refs: ReadonlyArray<{ renderId: string; seqName: string }>): Promise<ReadonlyArray<RenderInstance>>
  /** `global.stop()` / engine stop 時: DisarmRenders（ファイルを finalize） */
  disarm(): Promise<void>
  nextVersion(renderId: string): number     // arm ごとに +1（§16 (1) の語彙とは独立の内部カウンタ）
}
```

`Global` に `readonly renders = new RenderEndpointManager(...)` を足す（`global.ts` の `mixerManager` の隣）。`AudioLine`（doc 1 §3.1）の `output()` 解決順（doc 1 §3.3）で `resolveMixerNode(...).kind === 'render'` → `{ kind: 'render', id }`。

**arm の時機**: `Global.start()`（`global.ts:655-670`・transport 開始）の中で `renders.arm(refs)` を **await せずに**発行し（RT には影響なし・ファイルが開くまで数 ms は書かれない = 記録の先頭が欠けうる）… ではなく、**`start()` を async 化しない**ため、arm は `AudioLine.program()` が render を含むラインを**インストールした時点**（`SetBusLine` 送信時）に行う（§5.3）。transport 未走行の間にファイルが開いても書き込みは 0 フレーム（RT は transport 停止中に render しない…ではない — `render_block` は常に回る。**無音を書き続ける**ことになる）。

→ 決定: **arm = transport start / disarm = transport stop** に固定する。`Global.start()` は同期だが、`_onTransportStart` フック（`global.ts:669`）の直後に `void this.renders.arm(refs)` を発行し、arm 完了までの遅延は **`SetBusLine` の `Render` op が「未 arm なら no-op」**であることで吸収する（§5.2）。先頭の欠けは「arm の RTT（実測 1-3 ms・localhost WebSocket）」で、`%v` ごとのファイルの先頭で起きる。許容できない場合は §16 (4)。

### 4.4 wire（daemon protocol）— 🔴 一方通行

| コマンド | params | 戻り | 意味 |
|---|---|---|---|
| `DeclareRender` | `{ id: string, path_template: string }` | `{}` | 宣言の登録（ファイルは開かない）。同 id は差し替え |
| `ArmRenders` | `{ sample_rate?: u32, instances: [{ key: string, path: string, render_id: string }] }` | `{ slots: [{ key, slot: usize }] }` | 各 `path` を `CaptureWriter::create`（mkdir -p 込み）で開き、`RenderInstance` を RT へ install。`sample_rate` 省略 = stream の rate |
| `DisarmRenders` | `{}` | `{ files: [{ key, path, frames_written: u64, dropped_samples: u64 }] }` | RT から retire → writer `finish()` → レポート。**`dropped_samples > 0` は結果に載せる**（黙らない） |
| `SetBusLine` `dest` | `{ kind: 'render', key: string }` | — | doc 1 §4.1 の `WireDest` に `render` を足す。**`key` = 解決後パス**（slot は daemon が引く。未 arm の key は受理して no-op・arm 時に結線）|
| `RenderScore` v2 | §6.2 | §6.2 | オフライン |

`SetBusLine` 検証（doc 1 §4.1 の表）に 1 行: `render.key` が `DeclareRender` 済みの template から展開されたものか**は検証しない**（TS が唯一の展開者。daemon は key を不透明な文字列として扱う）。`ArmRenders` の `path` は絶対・非空・`.wav`。

### 4.5 数値 `output(n)` と `RenderScore` v1 の退役

| 箇所 | 変更 |
|---|---|
| `sequence.ts:376-400` | 数値分岐を削除（doc 1 §14 (1) 推奨 A）。`_renderBus` / `getRenderBus`（`:113,:411,:440`）/ snapshot `:1885` を削除 |
| `render-score.ts:20-24` `RenderScoreBus.name "1".."16"` | §6.2 の v2 型へ |
| `tests/fixtures/render-score-manifest.json` | v2 へ差し替え（両側が読む契約は維持・#598 コメント 6 前提 1）|
| core spec MX.2.1 | §13 |

---

## 5. Rust — `RenderInstance`（実時間タップ）

### 5.1 型（`rust/crates/orbit-audio-native/src/output.rs`・`LinkChannelActivate` `:547-565` の隣）

```rust
/// 解決後パス 1 本 = 1 インスタンス。同じ key を指す全ラインの出力を scratch に加算し、block 末尾で 1 回 commit する。
pub struct RenderInstance {
    pub key: String,
    /// per-block 加算用。control が `max_block_frames * 2` で事前確保（RT alloc 無し）。
    pub scratch: Vec<f32>,
    /// 今 block で 1 度でも加算されたか（commit の要否）。
    pub dirty: bool,
    /// producer。consumer（`CaptureWriter`）は control が保持（`OutputStream._capture` と同じ所有）。
    pub sink: RingTapSink,
    /// arm 完了フラグ（`LinkChannelActivate.ready` と同じ）。false の間は加算も commit もしない。
    pub ready: Arc<AtomicBool>,
}

/// callback が保持する render プール（`LinkEgress` と同型）。`reg_rx` から install、`retire_rx` で retire。
struct RenderPool {
    reg_rx: rtrb::Consumer<RenderInstance>,
    retire_rx: rtrb::Consumer<usize>,          // slot index
    instances: Vec<Option<RenderInstance>>,    // slot 固定。retire で None。容量は MAX_RENDER_INSTANCES（§16 (5)）
}
```

`RenderState`（`:1433-1442`）に `renders: RenderPool` を足す。doc 1 §5.1 の `OutputDest::Render(usize)` の `usize` = `instances` の slot。

**#679（入力・未着手）との関係**: `rec`（録音）は本機構の**消費者**になる（`docs/design/679-input-consistency-check.md` §1 (c)）。録ったものの命名・素材化は #679 で決め、本書は変えない。

### 5.2 RT アルゴリズム（doc 1 §5.3 の op 実行に 1 分岐足すだけ）

```
for op in line.ops:                                    // doc 1 §5.3
  Output { dest: Render(slot), thru, gain } =>
     if let Some(inst) = renders.instances[slot] && inst.ready.load(Acquire):
         for i in 0..bs: inst.scratch[i] += buffer[i] * gain_ramped
         inst.dirty = true
     if !thru { break }
…（全 stage・master ライン処理後）
for inst in renders.instances.iter_mut().flatten():
  if inst.dirty { inst.sink.commit(&inst.scratch[..bs]); inst.scratch[..bs].fill(0.0); inst.dirty = false }
```

- 未 arm（`None` / `ready == false`）は **no-op**（音は `thru` に従って続く）。「書くはずが書かれていない」は `DisarmRenders` の `frames_written == 0` と `get_log` の `[render] not armed` で見える（§11）
- `commit` は wait-free（ring 満杯は drop カウント → `DisarmRenders` の `dropped_samples`）。capture と同じ RT 契約
- `MasterLine`（doc 1 §5.2）の op も同じ分岐を通る（master → render・裁定 5）

### 5.3 control 側（`engine_wrap.rs` / `session.rs`）

| RPC | 処理 |
|---|---|
| `DeclareRender` | `HashMap<id, template>` に登録。何も開かない |
| `ArmRenders` | 各 instance: `fs::create_dir_all(parent)` → `CaptureWriter::create(path, sr, 2, ring_capacity)`（`capture.rs:186`）→ `RenderInstance { ready: false, … }` を `reg_tx.push`（満杯なら **エラーで返す**・黙って落とさない）→ RT が pool に入れる → control が `ready.store(true)`（Link の readiness と同じ順序 `:557-563`）→ slot を返す。同 key が arm 済みなら再利用（冪等）|
| `DisarmRenders` | 各 slot: `ready.store(false)` → `retire_tx.push(slot)` → RT が `None` にする → control が **1 block 待ってから** `CaptureWriter::finish()`（`capture.rs:299`・stop 後の commit が無いことを呼び出し側が保証する契約 `:165-172`）→ `CaptureReport` を集めて返す |
| daemon 終了 / stream rebuild | `CaptureWriter` の RAII drop（`:308`）で finalize。定期 header patch（`:87`）で途中でも開ける |
| `SetBusLine` の `render.key` | `key → slot` を control の `HashMap` で引く。未 arm なら `Render(NONE_SLOT)` で install し、arm 時に**ラインを再インストール**（`LineSlot` の差し替え・doc 1 §5.1）|

### 5.4 版（`%v`）と arm の単位

**1 arm = 1 版**。arm は transport start ごと（§4.3）なので、`global.stop()` → `global.start()` で `kick_001.wav` → `kick_002.wav`。同じ transport セッション内でラインを何度書き換えても**同じファイルに書き続ける**（インスタンス = 解決後パス・ラインの差し替えは op の差し替えであってファイルの開閉ではない）。上書きしない（`%v` 無しの固定名は **同じ版番号が無い**ので `wx` 排他で EEXIST → `-2` サフィックス・`session-log-writer.ts:147-155` と同じ規則を `ArmRenders` が持つ）。

---

## 6. オフライン driver（P2）— 598 設計 §4.1 を「ライン模型 + 仮想クロック」で読み替える

### 6.1 daemon: `OfflineRenderSession`（598 設計 §4.1 のまま・宛先だけ本書）

- 専有 `Engine::new(sr, 2)`・専有 `insert_buses`（manifest の bus ごとに `InsertBusStage` + `LineProgram`）・専有 `MasterLine`・専有 `RenderPool`
- driver loop: `render_block_with_sources(...)` → §5.2 の commit（sink は同じ `RingTapSink` + `CaptureWriter`。off-thread の意味は無いが**同じコード**で bit 一致の根拠になる）
- イベントは manifest の `events` を `start_sec` 順に block へ流し込む（P1 の shape）。**instrument は P3**（§7）
- 完了で全 writer を `finish()` → 結果に `files[]` と `ChildStats`（P3）を載せる

### 6.2 `RenderScore` v2（wire・🔴 一方通行・P1 の消費者は無い）

```ts
export interface RenderScoreV2 {
  sample_rate: number            // 既定 48000（裁定 8）
  block_frames: number
  duration_sec: number           // T（裁定 8: 要求のパラメータ）
  samples: RenderScoreSample[]   // 不変
  buses: Array<{ name: string; line: WireLineOp[]; chain: RenderScorePlugin[] }>   // line = doc 1 §4.1 の SetBusLine.line と同じ型
  master: { line: WireLineOp[]; chain: RenderScorePlugin[] }
  renders: Array<{ key: string; path: string }>            // 解決済み絶対パス（§3.4）
  events: RenderScoreEvent[]                               // bus = buses[].name（"seq-bus-0" 等・数値名を廃止）
}
```

- `out_dir` 廃止（パスは `renders[].path` で明示）。`buses[].name "1".."16"` 廃止
- `validate_render_score_params`（`session.rs:544-`）を v2 へ。`master` 必須の手書き `REQUIRED` ループ（#598 コメント 6 前提 3）は維持
- 結果: `{ files: [{ key, path, frames_written, dropped_samples }], blocks_rendered: u64, elapsed_ms: u64 }`（実時間比を**必ず記録**・598 設計 §5 P2 受け入れ）

### 6.3 TS driver: 「評価列 × 仮想クロック」— `.orbs` と `.orbslog` を同じ口で受ける

598 設計 §4.3 は「`.orbs` 1 本の静的状態 × T」（P0-B）だった。#241 前提「transport 順の評価列を受け取れる形」（#241 チェックリスト）を満たすため、driver の入力を**評価列**に一般化する:

```ts
// packages/engine/src/render/score-driver.ts（新規・約 300 行）
export interface ScoreEval { readonly atMs: number | null; readonly code: string; readonly sourceFile: string | null }
export interface ScoreInput { readonly evals: ReadonlyArray<ScoreEval>; readonly durationMs: number; readonly scoreDir: string }
export function scoreInputFromOrbs(orbsPath: string, durationMs: number): ScoreInput         // evals = [{ atMs: null, code: file }]
export function scoreInputFromOrbslog(logPath: string, scoreDir?: string): ScoreInput         // doc 2 §7.2 と同じ読み方。atMs = bar:beat → ms は仮想クロック上で逐次解決
export async function buildRenderScore(input: ScoreInput, opts: { sampleRate: number; blockFrames: number }): Promise<RenderScoreV2>
```

`buildRenderScore` の中身 = **仮想時間シミュレーション**:

1. `InterpreterV2` を `{ audioEngine: new CollectingEngine() }` で作る（`interpreter-v2.ts:48` の opts に既にある注入口）。`CollectingEngine` は `AudioEngineBackend` を実装し、`scheduleEvent` / `scheduleSliceEvent` を**配列に積む**（598 設計 P0-B の collector (a)）。`getCurrentTime()` は仮想時刻
2. **仮想クロック** `VirtualClock { now(): number; sleepUntil(ms) }` を `Global` / `TransportClock` / playback timer に注入（§10.1 の 41 箇所のうち **core の 17 箇所**を `clock.now()` / `clock.setTimeout()` へ。dispatch 層 `rust-engine-player.ts` の 15 箇所は driver が通らない）
3. イベント駆動ループ: 「次の timer」と「次の eval（`atMs`）」の早い方へ `clock` を進めて実行。`atMs === null` は t=0 で先に全部。`.orbslog` の `bar:beat` は **その時点の tempo / beat** で ms へ（doc 2 §7.2 と同じ規則・`Global.msUntilTransportPosition` を仮想クロックで評価）
4. `durationMs` まで進めたら、collector の events（絶対 ms・bus 名・gain/pan/slice）を `RenderScoreEvent[]` に、各 seq の `AudioLine.program()`（doc 1 §3.4）を `buses[].line` に、`global.masterLine` を `master.line` に、`renders` は `RenderEndpointManager` の展開結果（`%v` = 要求時に決める版）に写す
5. slice 領域は 2-phase（598 設計 P0-B「先に LoadSample → 尺取得」）。**collector の `LoadSample` は本物の daemon を叩く**（尺が要るため）— driver は daemon 接続を要する（offline でも daemon は使う・§6.1）

**なぜ静的列挙（P0-B (a)）を捨てないか**: `.orbs` 入力は evals 1 個 + timer だけなので、同じループが P0-B と同じ結果を出す（tempo 一定なら `scheduleEvents(collector, k, 0)` の直列呼び出しと同値）。**1 実装で 2 入力**。

**RNG**（598 設計 P0-B 注意）: manifest 構築時に焼き込まれるので「同一 manifest → bit 一致」は成立、「同一 .orbs → 同一 manifest」はシード無しでは不成立。spec の再現性は因果的同一性（Known Decision #21）なので**仕様どおり**。

### 6.4 CLI

```
orbitscore render <score.orbs> --duration <sec> [--sample-rate 48000] [--block 128]
orbitscore replay <log.orbslog> --render [--score-dir <dir>]      // doc 2 §7 の replay に --render を足す
```

`execute-command.ts:56` に `case 'render'`、`parse-arguments.ts` に `--duration` / `--render` / `--sample-rate` / `--block`。両方 `buildRenderScore` → `daemonClient.renderScore(v2)` → 結果を JSON 1 行で stdout（MCP から読める形・598 設計 §5 P2「進捗 / 完了 / 失敗の event 面」）。**MCP tool** `render_score` は §16 (6)。

---

## 7. P3 — プラグイン・instrument（598 設計 §5 P3 + P0-D 訂正をそのまま採る・差分のみ）

| 項目 | 598 設計 | 本書の差分 |
|---|---|---|
| out-of-process 同期 adapter（`render_through_child_sync` のループを `PostProcessor` 化）| §4.1 | 不変 |
| plugin state 復元（絶対パス） | §4.3 | 不変（`RenderScorePlugin.state`）|
| instrument offline 駆動 | P0-D「簡易 publish 系を昇格（transport_context 書き込み + per-block イベント数の事前検証）」 | 不変。manifest に `instruments: [{ bus, plugin, state, events: [{ start_sec, kind, note, velocity, … }] }]` を足す（`NeutralEvent` の wire 形は `PluginNoteOn/Off` `session.rs:2367-2372` の語彙を再利用）|
| オフラインモード通知 | P1 で型を用意・呼び出し元ゼロ | `OfflineRenderSession` の plugin load で **必ず** `Vst3ProcessMode::Offline` / `ClapRenderMode::Offline` を渡す。CLAP `clap.render` 無しは **warning を結果に載せて続行**（598 設計 P1）|
| 受け入れ「内容の一致」 | #598 コメント 2 | E2E-R5（§12）: Kontakt 相当の streaming instrument で realtime capture とオフラインの窓 RMS を突き合わせる |
| 失敗 | 「レンダ全体の明示エラー・部分成功の WAV を残さない」 | 不変。加えて **`ChildStats.process_errors > 0` は結果に載せて exit ≠ 0** |

---

## 8. `replay --render`（#241 × #598 の積・裁定 9）

```
.orbslog ──(doc 2 §7.2 の読み方)──▶ ScoreInput{evals with atMs}
        ──(§6.3 仮想クロック)──▶ RenderScoreV2 ──(§6.1)──▶ stems + master WAV
```

- 尺 `T` = ログの `transport stop` の `wall - start.wall`（無ければ `--duration` 必須）
- `evalSource: 'replay'` で評価（ログを二重に書かない・doc 2 §7.2）
- `--until` の高速畳み込み変種（doc 2 §7.4）は**同じ仮想クロック**で成立する（`until` まで進めて実エンジンへ状態を写す部分は別途・§16 (7)）

---

## 9. データの通り道 1 本（実時間 stem）

```
[DSL] var stems = mix.render("stems/%n_%v.wav")
  → parse: MixerNodeDecl{kind:'render', path}          (parse-statement.ts:453)
  → registerMixerNode → global.renders.declare('stems', template) → daemon DeclareRender{id, path_template}
[DSL] kick.output(stems, thru: true).output(master)
  → AudioLine.upsert(output{dest:{kind:'render', id:'stems'}, thru:true, db:0})   (doc 1 §3.2)
  → program() → SetBusLine{bus:'seq-bus-0', line:[rack, output{dest:{kind:'render', key:'/abs/stems/kick_001.wav'}, thru:true, gain:1}, output{dest:master}]}
      key は TS が今の版で展開（arm 前は「次の版」）
[DSL] global.start()
  → _onTransportStart → renders.arm([{renderId:'stems', seqName:'kick'}]) → daemon ArmRenders{instances:[{key, path}]}
  → control: create_dir_all → CaptureWriter::create → reg_tx.push(RenderInstance) → RT pool へ → ready=true → slot
  → SetBusLine 再インストール（key → slot 結線）
[RT] render_block: seq-bus-0 の buffer → Output(Render(slot)) で scratch += buffer → block 末尾 commit → ring
[thread] CaptureWriter が ring を drain → stems/kick_001.wav（定期 header patch）
[DSL] global.stop()
  → _onTransportStop → renders.disarm() → daemon DisarmRenders → retire → finish → {files:[{key,path,frames_written,dropped_samples}]} → stdout 1 行 JSON（get_log）
[E2E] fs.existsSync(stems/kick_001.wav) && analyzeWavBuffer(...).rms > 0 && dropped_samples === 0
```

---

## 10. 呼び出し元の全列挙（grep 実行結果・main `ca176f0`）

### 10.1 壁時計 / timer（仮想クロック注入の対象・非テスト・41 箇所）

```
$ grep -rn "Date\.now()\|setTimeout(\|setInterval(" packages/engine/src/core packages/engine/src/audio packages/engine/src/interpreter --include=*.ts
core/global.ts:728,741                         getTransportPosition / getQuantizedEffectPosition   → clock.now()
core/global/transport-clock.ts:28              start() の origin                                    → clock.now()
core/sequence.ts:270,1827                      seamless reschedule / unmute                         → clock.now()
core/sequence/playback/loop-sequence.ts:147,148,149,158,177   armDelay / setTimeout / unmute       → clock.now() / clock.setTimeout()
core/sequence/playback/prepare-playback.ts:74  currentTime                                          → clock.now()
core/sequence/playback/run-sequence.ts:60      auto-stop setTimeout                                 → clock.setTimeout()
interpreter/interpreter-v2.ts:62,85            engineT0 / wallMs（session log の wall）             → clock.now()（replay の wall は記録側の値を使わない）
core/global/midi-transport-scheduler.ts:14     コメントのみ
core/project-state-store.ts, audio/slicing/temp-file-manager.ts, audio/supercollider/*  → driver が通らない（SC 退役・一時ファイルの stamp）
audio/rust-engine/rust-engine-player.ts:148,484,575,583,731,845,1470,1473,1474,1574,1598,1703,1705   dispatch 層（CollectingEngine に置き換わるので対象外）
audio/rust-engine/daemon-client.ts:4 箇所      request timeout（対象外）
```

**core 17 箇所**（上 8 ファイル）を `Clock` interface（`now()` / `setTimeout()` / `clearTimeout()`）へ。既定実装は `Date.now` / `global.setTimeout` で**ビット同一**（差し替えは DI・挙動不変）。

### 10.2 `_renderBus` の読み手（退役・§4.5）

```
$ grep -n "_renderBus\|renderBus" packages/engine/src/core/sequence.ts
113 / 369 / 379 / 389 / 399 / 411 / 440 / 1885
```

### 10.3 `RenderScore` の利用（v2 へ）

```
$ grep -rn "renderScore(" packages --include=*.ts | grep -v dist          → daemon-client.ts:615 のみ（本番呼び出し元 0）
$ grep -n "RenderScore" rust/crates/orbit-audio-daemon/src/session.rs     → 148, 410-459（型）, 495-566（検証）, 1941（ハンドラ）
tests/fixtures/render-score-manifest.json                                   → v2 に差し替え
```

### 10.4 daemon RPC 一覧（`session.rs:1298-2282`・render 系は無い）

```
Ping ListAudioDevices SelectAudioDevice GetStatus LoadSample UnloadSample RegisterLinkAudioChannel SetLinkTempo LoadPlugin
ApplyEffectChain ReplacePlugin UnloadPlugin GetPluginState RenderScore OpenPluginUI ClosePluginUI AckUiSafepoint PlayAt Stop StopAll
SetGlobalGain SetBusRouting SetSourceRouting InjectFault
```

→ 追加: `DeclareRender` / `ArmRenders` / `DisarmRenders`（+ doc 1 の `SetBusLine`）。

### 10.5 capture の producer / consumer（再利用）

```
output.rs:230   _capture: Option<CaptureWriter>（OutputStream・stream より後に宣言 = drop 順）
output.rs:553   LinkChannelActivate.sink: RingTapSink
output.rs:1419-1425  CaptureWriter::create(path, sample_rate, channels, ring_capacity)
capture.rs:186  pub fn create(path, sample_rate, channels, ring_capacity) -> io::Result<(RingTapSink, CaptureWriter)>
capture.rs:299  pub fn finish(self) -> io::Result<CaptureReport>
link_audio_ring.rs:29  RingTapSink::new(capacity) -> (Self, rtrb::Consumer<f32>, Arc<AtomicU64>)
```

### 10.6 パーサの分岐（§4.1）

```
parse-statement.ts:140-149（lookahead）/ :453-487（parseMixerNodeDecl）/ parser/types.ts:98-111 / process-file-import.ts:64（import 経由の宣言も同じ型）
```

---

## 11. 失敗モード（握り潰される経路が無いこと）

| 状況 | 挙動 | 出口 |
|---|---|---|
| `mix.render("")` / 拡張子が `.wav` 以外 | runtime error（宣言時）| 診断 |
| 未知のプレースホルダ `%x` | `expandRenderTemplate` が throw（宣言時に検査） | 診断 |
| `output(stems)` の `stems` が render 以外 / 未宣言 | doc 1 §3.3 の解決失敗 | 診断 |
| `ArmRenders`: mkdir / open 失敗 | RPC エラー（該当 instance 名入り）・**他 instance も arm しない**（all-or-nothing）| TS が診断 + `get_log` |
| `ArmRenders`: reg ring 満杯 / slot 枯渇 | RPC エラー | 同上 |
| 未 arm のまま演奏 | RT no-op・音は `thru` どおり | `DisarmRenders` の `frames_written: 0` + `[render] key … was never armed` を stdout |
| ring 満杯（drop） | `dropped_samples` に計上・**結果に載せる** | `DisarmRenders` 結果 / E2E が `=== 0` を assert |
| daemon 異常終了 | RAII finalize・定期 header patch で開ける | ファイル自体 |
| `global.stop()` 無しで engine 停止 | `OutputStream` drop → writer drop（`output.rs:230` の宣言順）| 同上 |
| 同一 key を 2 回 arm | 冪等（既存 slot を返す）| — |
| 固定名で既存ファイル | `wx` EEXIST → `-2` … | 結果の `path` に実際の名前 |
| offline: manifest v1 形 | `MALFORMED_REQUEST`（`logVersion` 相当の `schema: 2` を必須にする）| RPC エラー |
| offline: child crash / timeout（P3） | レンダ全体エラー・部分 WAV を**削除** | RPC エラー + exit ≠ 0 |
| offline: `process_errors > 0` | 結果に載せて exit ≠ 0 | stdout JSON |

---

## 12. E2E（MCP 経由・`orbitstudio-mcp-gated.spec.ts`・数値で判定）

| # | シナリオ | 判定 |
|---|---|---|
| E2E-R1（実時間 stem） | `mix.render("stems/%n_%v.wav")`・`kick.output(stems, thru:true).output(master)`・`global.start()`・LOOP 4 小節・`global.stop()` | `<scoreDir>/stems/kick_001.wav` が実在・`analyzeWavBuffer` の rms > 0・`get_log` の DisarmRenders 結果に `dropped_samples: 0`・master capture の窓 RMS と stem の窓 RMS が一致（±10%・`thru` の証明）|
| E2E-R2（合算） | `kickL.output(bd)` / `kickR.output(bd)`（固定名） | ファイルが 1 本・RMS が単独時の約 2 倍（同相加算・式は expectations に）|
| E2E-R3（pre/post） | `output(stems, thru:true).effect([Gain(db:-12)])` vs `effect([Gain(db:-12)]).output(stems, thru:true)` | 2 譜面の stem RMS が 10^(-12/20) 倍違う（裁定 7）|
| E2E-R4（版） | `global.stop()` → `global.start()` | `kick_002.wav` が増える・`001` は不変（サイズ同じ）|
| E2E-R5（offline・P2 受け入れ） | 同じ譜面を `orbitscore render <orbs> --duration 8` | 生成ファイル群が E2E-R1 と同名・**同一 manifest 2 回で bit 一致**（598 設計 §4.5）・実時間比を結果 JSON から読んで記録（閾値は置かない・598 設計 §5 P2）・8 バス構成で bleed 無し（他バスの窓が無音）|
| E2E-R6（`replay --render`） | doc 2 E2E-R1 のログ → `replay <log> --render` | 実時間 capture（ライブ）と窓 RMS 一致（±15%）|
| E2E-R7（未 arm） | `output(stems)` を書いたまま `global.start()` を評価しない | ファイル無し・`get_log` に `never armed` |
| E2E-R8（P3・内容の一致） | streaming instrument（owner 常用）で realtime capture vs offline | 窓 RMS 一致・`process_errors == 0`・`processed == 期待 block 数` |
| E2E-R9（master → render） | `master.output(mixdl, thru:true).output("1,2")` | `mix_001.wav` の RMS が capture と一致 |

- `dsl-e2e-coverage.spec.ts`: `render` は `GLOBAL_DSL_METHODS` に載らない（mixer node 宣言はパーサ経由・`.render(` の出現は E2E ソースに現れるので `methodsExercisedByGatedE2E` は拾う）。**baseline は増やさない**
- capture するなら rms を見る（hygiene）。ERROR 件数は `<=`
- 🔴 **前提（doc 668 §10）**: `analyzeWavBuffer` は mono に潰す（`wav-analysis.ts:127-132`）。E2E-R2（合算の RMS）は mono でよいが、**E2E-R5 の bleed（他バスの窓が無音）を multi-ch ファイルで見る形にする場合と E2E-R9（`"1,2"` の ch 指定）は PR-E3（per-channel 解析）が先**。stem は 2ch WAV 1 本ずつなので R1/R3/R4 は mono 解析で足りる

---

## 13. spec 改訂（実装より先）

| spec | 改訂 |
|---|---|
| core spec MX.2.1 | 数値 `output(n)` を**削除**し、`mix.render(<path>)` 宣言 + `output(node, thru, db)` に置換。§4.4.1 の非対称規則を削除（doc 1 §11 の MX 改訂と同じ PR）|
| core spec SC.2.1 | mixer node の種類に `render` を足す（宣言のみ・レシーバにならない）|
| `SIGNAL_CHAIN_DSL_SPEC_v1.md:122` `outs:` | 値に render ノードを含む |
| `MULTICHANNEL_RENDERING_DESIGN_598.md` §4.3 / §4.4 | manifest v2（§6.2）・DSL 表面を本書へ参照 / §4.3 末尾「別フロントエンド」→ #241（§8）|
| `SESSION_LOG_SPEC_v1.md` §4 | `--render` は本書 §8 |

---

## 14. PR 分割（詳細は `IMPLEMENTATION_PLAN_2026-09.md`）

| PR | 内容 | 依存 | 一方通行 |
|---|---|---|---|
| PR-R0 `docs(spec): render endpoints — mix.render, template, merge rule` | §13 | doc 1 PR-O1 | — |
| PR-R1 `feat(dsl): mix.render(<path>) endpoint declaration + %n template` | §3・§4.1-4.3（TS のみ・daemon 未接続でも宣言と解決が動く）+ unit | doc 1 PR-O4（`OutputDest.render`）| DSL |
| PR-R2 `feat(daemon): DeclareRender / ArmRenders / DisarmRenders + RenderInstance pool` | §4.4・§5 + cargo test（RT no-op / commit / retire）| doc 1 PR-O3（`LineProgram`）| wire |
| PR-R3 `feat(render): realtime stems end-to-end` | arm/disarm の TS 配線（§4.3）+ E2E-R1/R2/R3/R4/R7/R9 | PR-R1・PR-R2 | — |
| PR-R4 `refactor(core): inject Clock (Date.now / setTimeout) — behaviour-preserving` | §10.1 の 17 箇所 + 既存全テスト green（bit 同一） | — | — |
| PR-R5 `feat(render): score driver — evals × virtual clock → RenderScore v2` | §6.3 + `CollectingEngine` + unit（`.orbs` と `.orbslog` が同じ manifest を出す固定ケース）| PR-R4・doc 2 PR-L4 | — |
| PR-R6 `feat(daemon): OfflineRenderSession (P2) — RenderScore v2 renders stems` | §6.1-6.2 + fixture v2 + cargo test（bit 一致）| PR-R2 | wire |
| PR-R7 `feat(cli): orbitscore render / replay --render` | §6.4・§8 + E2E-R5/R6 | PR-R5・PR-R6 | — |
| PR-R8 `feat(render): P3 plugins + instruments offline` | §7 + E2E-R8 | PR-R6・#634/#636 の instrument rack（§16 (8)）| — |

**並行可能**: PR-R4（Clock DI）は他と独立で最初に出せる。PR-R2 と PR-R1 は独立（wire と DSL）。PR-R6 は PR-R3 と独立。

---

## 15. 確信度と反証方法

| 主張 | 確信度 | 反証方法 |
|---|---|---|
| 実時間 stem は capture の producer/consumer の再利用で RT 契約を満たす | 高 | `RingTapSink::commit` と `CaptureWriter` は既に RT 経路で稼働。反証: `dropped_samples > 0` が E2E-R1 で出る |
| 「同じ宛先を実時間 / 高速で書く」は driver の差だけ | 高 | E2E-R1 と R5 が同名ファイルを出し、窓 RMS が一致する |
| 仮想クロック注入は挙動不変 | 高 | PR-R4 で既存 2100 件 + gated が緑（DI の既定は `Date.now`）|
| `.orbslog` を同じ driver で畳める | 中 | PR-R5 の unit: `.orbs` 1 本と、それを 1 eval にしたログが**同一 manifest**を出す。tempo 変更を含むログで quantize の解決がライブと一致するかは E2E-R6 が判定 |
| arm の RTT で先頭が欠けるのは許容範囲 | 中 | E2E-R1 の stem 先頭窓を測る。許容できなければ §16 (4) |

---

## 16. 🔴 owner 裁定待ち（設計に混ぜていない・他は着手可能）

| # | 問い | 選択肢 | 推奨 | 影響 |
|---|---|---|---|---|
| (1) | プレースホルダの語彙 | `%v`（版・3 桁）/ `%d`（日時 `YYYYMMDD-HHMMSS`・`.orbslog` と同じ `formatLogStamp`）/ 他 | **`%n` `%v` `%d` の 3 つ**。`.orbslog` の stamp 関数を流用 | `PLACEHOLDERS` 表の行（§3.3）|
| (2) | 3ch 以上を 1 ファイルに | `quad.pair(3,4)` / `output(quad, ch:[3,4])` / **作らない** | **作らない**（stem 用途に要求が無い・main 推奨に同意）| — |
| (3) | 実時間 per-bus stem（§5）の優先順位と置き場 | A #598 に含める / B 新規 issue（地図 §7 (7)(11)）/ C #611 に足す | **B（新規・「書き出しの操作面」）**。ただし機構は本書で確定済みなので、順序だけの問題。オフライン（PR-R5-R7）を先に出すのが owner の目的（840 / 1260 を録る）に沿う | PR-R2/R3 の順番 |
| (4) | arm の RTT で版の先頭が欠ける（§4.3）を許容するか | A 許容 / B `global.start()` を async にして arm を await / C transport start の前に「予告 arm」（ラインのインストール時に開く・transport 停止中は commit しない） | **C**（RT は `transport.running` を見て commit を gate・無音を書かない）| §5.2 に 1 分岐 |
| (5) | `MAX_RENDER_INSTANCES`（RT pool の容量） | 上限を決めない（owner）が RT pool は固定長 | 既定 16・env `ORBIT_RENDER_INSTANCES`・**#663 の off-thread 拡張で撤廃** | 定数 1 つ |
| (6) | `render_score` / `arm_renders` を MCP tool にするか | A する / B CLI のみ | **A**（LLM 第一級・「書き出しの操作面」(i) の MCP 面）| 新規 PR |
| (7) | `replay --until` の高速畳み込み（仮想クロックで `until` まで進めて**実エンジンへ状態を写す**） | 状態の写し方（ラインは `SetBusLine` 再送で写せる・**走行中 LOOP の位相**は transport の再開位置で決まる）| 設計は別書（doc 2 §7.4）| — |
| (8) | P3 の instrument offline は #636（instrument rack）の後か | 598 設計 P0-D は簡易 publish 昇格 | **#636 の後**（rack が変わると経路が 2 度変わる）| PR-R8 の位置 |
| (9) | `T` 無しの `render <orbs>` | A 必須 / B LOOP 無しなら最長パターン長 | **A（必須）**（裁定 8「要求のパラメータ」）| CLI 引数 |
