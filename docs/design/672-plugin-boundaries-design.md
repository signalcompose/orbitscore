# 設計: プラグインの境界を引く — DSL Plugin / DSP Plugin の契約と、残りとしてのコア（#672 / #671 / #674 / #321 / #497）

**対象 issue**: #672（契約 2 本の仕様）/ #671（DSL Plugin 化・段階 0〜5）/ #674（OSC 送信 = 種 B の 1 例目）/ #321（Link テンポの Rust 版・拡張点待ち）/ #497（Synth DSL・受け皿）/ #670（engine 切り出し・境界の帰結）
**関連**: `docs/design/611-output-line-design.md`（出口 = ライン要素・`OutputDest`）/ `docs/design/598-render-endpoint-design.md`（render = タップ宛先の first-party 実例）/ `docs/design/428-timed-event-queue-design.md`（種 B が消費する時刻付きイベント）/ `docs/design/634-pdc-layer-instrument-rack-design.md`（#669 標準プラグイン）/ `docs/design/668-e2e-foundation-design.md`（#668 = #671 の前提）
**正本（本書が起草する）**: `docs/specs-v2/DSL_PLUGIN_SPEC_v1.md` / `docs/specs-v2/DSP_PLUGIN_SPEC_v1.md`（未作成・`ls docs/specs-v2` で確認）。本書は両 spec の**規範文の草案と目次**を含む（§12）
**状態**: 設計（実装しない）・2026-09-03・main `ca176f0` 実測

---

## 0. owner 裁定（再議論しない）

| # | 裁定 | 出どころ |
|---|---|---|
| 1 | 🔴 **「コア」を先に定義しない。境界を 1 つずつ引いた残りがコア**。引く境界: VST3/CLAP・標準プラグイン・DSP プラグイン（Ableton Link のようなもの）・標準シンセプラグイン・DSL プラグイン | #672 コメント 2 / 地図 §1b.3 |
| 2 | 命名: **DSL Plugin**（語彙を足す）/ **DSP Plugin**（音を処理する）。`DSP` の既存用法（信号処理そのもの）との区別を §0 に明記 | #672 本文 |
| 3 | DSL Plugin の種: **A** 宣言のみ（engine 側 RT）/ **B** 宣言 + 自前の実行（RT 外）/ **C** 音の処理 → DSP Plugin Spec | #671 コメント 2 |
| 4 | DSP Plugin の実行クラス: (1) out-of-process CLAP/VST3 child / (2) 同梱の標準 CLAP / (3) **in-process WASM**（新規）/ (4) **egress / tap 型**（新規） | #672 チェックリスト / 地図 §4.E |
| 5 | 「engine に DSP を抱えない」（SC.10.8 (1)）は不変。WASM ランタイムはホストであって DSP ではない | 地図 §4.E |
| 6 | 順序: **#668（網羅 E2E）→ #672（spec）→ #671 段階 1-3 → 段階 4-5 → {#497, #674 種 B, #670, Link テンポの DSL Plugin 化}**。#674 の実装は #672 の後（DSL 表面の確認は先にできる） | #671 コメント 2 / 地図 §4.E |
| 7 | #321 PR3（Link テンポリーダー Rust 版）は **#671 段階 4 の判断が出るまで engine 内へ実装しない** | #321 チェックリスト |
| 8 | core の判定基準 2 本: 「他のプラグインが意味を持つために必要」+「**依存関係が強いものは core でよい**（迷ったら core）」。first-party も同じ拡張点で書く（裏口を残さない） | #671 コメント 1・2 |
| 9 | engine の依存は permissive・GPL は隔離（不変条件） | #292 §1 / `rust/Cargo.toml:26-34` |

🔴 **owner 未決（§18 に隔離）**: A4 実行形態（同一プロセス / 別プロセス + IPC / 混在）/ transport **書き**の競合規則 / #674 の DSL 表面 / #669 の DSL 表面 / WASM の実用域。

---

## 1. 到達点（1 文）

**5 本の境界（3rd-party・標準・タップ・標準シンセ・DSL）それぞれに「契約 = 型 + 実行の場所 + 失敗時の振る舞い + テストの義務」が書かれ、既存実装（child ホスティング・`orbit-std-gain`・`RingTapSink`・`BlockSource`・語彙 Set）がその契約の**実例**として位置づけられ、残ったもの（時間の基準・トランスポート・記譜・ソースの口・ラインの合成規則・RT 不変条件・スケジューラ・ホスト基盤）がコアとして**列挙で**確定する。**

---

## 2. 現在地（一次情報）

| 事実 | 根拠 |
|---|---|
| 語彙 Set は手書き（`GLOBAL_DSL_METHODS` 18 語・`SEQUENCE_DSL_METHODS` 32 語）。1 語足すのに 4 箇所（facade / Set / reference / coverage baseline）を手で編集 | `signal-chain/runtime.ts:20-70` / #671 本文 §1 |
| 公開メソッドの分類テスト（DSL 語彙 か 内部 API か・未分類なら red） | `tests/interpreter/signal-chain-dispatch.spec.ts:613-800` |
| facade は 21 マネージャへ委譲済み（`vel` 等の例外あり） | #671 本文 §2 |
| 3rd-party プラグインは out-of-process child（CLAP 4 crate + VST3 2 crate + rack child）。RT 契約は #628（install ring・世代 retire） | `rust/crates/orbit-*-child` / `orbit-effect-rack-child` |
| 能力抽象（state / param / preset / UI）とスレッド境界の契約は spec 済み | `PLUGIN_CAPABILITY_ABSTRACTION_v1.md` CAP.1 / CAP.5 |
| ホストが使う規格拡張: CLAP `clap.render`（5 箇所）/ `CLAP_EXT_STATE`（4）/ VST3 `IAudioProcessor` `IHostApplication` `IComponentHandler` | grep（§13.3）|
| child はすべて `std::hint::spin_loop()` で待つ（本番コード 6 箇所） | grep（§13.2）/ #667 |
| 標準プラグインは同梱 CLAP・UI / state 無し・語彙として解決（SC.10.8 規範 (1)-(6)）。実例 `orbit-std-gain`・`ORBIT_STD_PLUGIN_DIR` | `SIGNAL_CHAIN_DSL_SPEC_v1.md:328-345` / `orbit-effect-rack-child/src/macos.rs:239` |
| LinkAudio は GPL 隔離 crate（workspace member にしない・feature `link-audio` default off）。Link テンポ FFI `orbit_link_set_tempo` / `orbit_link_session_tempo` は**ある** | `rust/Cargo.toml:26-34` / `orbit-link-audio/src/lib.rs:53-55` |
| TS 側 `setLinkTempo` は feature 未ビルドなら warn + skip | `rust-engine-player.ts:927-935` / `global.ts:547-551` |
| RT の「音を外へ流す」機構 = `PostMixSink` / `RingTapSink`（wait-free）+ `LinkChannelActivate`（reg-ring・readiness） | `link_audio_ring.rs:14-49` / `output.rs:547-565` |
| ソースの口 = `BlockSource { render, output(unit) }` + `SourceSlot { source, dests }`（instrument はこの形で土台に乗る） | `output.rs:270-273, 334-337` / #643 §4 |
| `orbit-audio-wasm` は **engine を WASM へ出す browser backend の stub**（逆方向）。daemon 内で WASM を走らせるランタイムは無い | `orbit-audio-wasm/Cargo.toml:8` |
| OSC 送信は 0 件。MIDI 送信は TS の `midi-scheduler.ts`（5ms poll・非 RT） | #674 本文 |
| MCP から語彙を発見する経路: `get_dev_doc` / `search_dev_docs`（dev サイトの Markdown を読む）・補完は `plugin-catalog-completion.ts`（カタログのみ） | `mcp-server.ts:1073-1116` |

---

## 3. 境界 1 — 3rd-party VST3 / CLAP（DSP Plugin 実行クラス (1)）

**契約 = 既存実装の明文化**。新しい機構は無い。

| 項目 | 契約（規範） | 実装の実例 |
|---|---|---|
| 実行の場所 | **out-of-process child**。daemon RT は shm 経由で block を渡し、+1 block の pipeline 遅延（effect）/ 同期 lockstep（offline）| `orbit-clap-effect-child` `orbit-vst3-effect-child` `orbit-effect-rack-child` / `orbit-audio-sandbox/src/offline.rs:82-200` |
| 能力 | CAP.1 の必須 4 能力（state get/set・param list/get/set）が無い形式はサポートを名乗らない | `PLUGIN_CAPABILITY_ABSTRACTION_v1.md` CAP.1 |
| スレッド | 音声処理以外は child の**メインスレッド**（CAP.5）| `orbit-child-runtime::run_child`（`lib.rs:251`）|
| RT 契約（daemon 側） | alloc / lock / syscall 無し。差し替えは install ring + 世代 retire | #628 / `output.rs` |
| プロセスモード | realtime / **offline**（VST3 `Vst3ProcessMode` / CLAP `clap.render`）。offline セッションは必ず offline を要求（doc 598 §7）| `orbit-vst3-host/src/lib.rs:534,633` / `orbit-clap-host/src/controller.rs:63-69` |
| 配置 | ラック要素（`effect([...])`）または instrument（ソース）。**どこに置けるか**は doc 610 の適用可能性表 | SC.10 |
| 失敗 | load 失敗 / crash / timeout は**診断に出す**（黙らない）。respawn は `MAX_CONSECUTIVE_FAST_RESPAWNS` | `instrument_host.rs` / #661 の教訓 |
| 🔴 既知の穴（spec は「あるべき姿」を書き、issue が差分を持つ）| child のアイドル busy-wait（#667）/ load 成功が無音（#661 調査）/ `--audio-device` の無音ストリーム（#661）| §13.2 / doc 662 |

**規範文（DSP_PLUGIN_SPEC §1 に置く）**: 「3rd-party プラグインは out-of-process で実行する。ホストは CAP.1 の必須能力・CAP.5 のスレッド境界・#628 の RT 不変条件を保証し、child が待機中に CPU を消費しないこと（#667）と、ロードの成否をログに出すこと（#661）を含む。」

---

## 4. 境界 2 — 標準プラグイン（実行クラス (2)）

SC.10.8 規範 (1)-(6) をそのまま契約にする。追加は **同梱と検証の義務**だけ:

| 項目 | 契約 |
|---|---|
| 形式 / 配布 | CLAP・アプリ同梱・`ORBIT_STD_PLUGIN_DIR`（rack child が解決 `macos.rs:239`）|
| 語彙 | **言語の語彙として解決**（`Gain(db: -6)`）。カタログを引かない。同名 3rd-party とは名前空間が分かれる |
| UI / state | 持たない。パラメータは DSL が正 |
| 🔴 検証の義務 | `bundle-macos.sh` で同梱され、`orbit-effect-rack-child --lib -- --ignored` の実機テストに**無条件で**登録される（CLAUDE.md「マージ前ゲート」）。新しい標準プラグインは**そのテストに 1 行足さないとマージしない** |
| DSL Plugin との関係 | 標準プラグイン = **種 C の実体 + 種 A の語彙（`Gain(...)` の呼び出し形と引数型）を 1 モジュールで登録**する（§7.2 `DslModule.rackElements`）。#669 が最初の適用先（表面は doc 634 §16 で裁定待ち）|
| 実装ライブラリ | 中身は permissive（例: Patina MIT・地図 §4.E）。engine には入れない（裁定 5）|

---

## 5. 境界 3 — タップ / egress 型（実行クラス (4)・owner の「Ableton Link のようなもの」）

### 5.1 何が「タップ」か

**RT のオーディオを受け取り、外へ流し、信号は素通しで先へ渡す**もの。今日 engine 内に 3 つある:

| 実例 | 受け取る | 外へ | 機構 |
|---|---|---|---|
| capture（`ORBIT_CAPTURE_WAV`） | master post | WAV | `RingTapSink` → `CaptureWriter`（`capture.rs`）|
| LinkAudio egress | named channel | Ableton Live | `LinkChannelActivate.sink`（`output.rs:553`）→ GPL consumer thread |
| render endpoint（doc 598 §5・新設） | ライン上の任意の点 | WAV | `RenderInstance.sink`（同じ `RingTapSink`）|

**共通の形** = `PostMixSink::commit(&[f32])`（`link_audio_ring.rs:14-16`・wait-free）+ 非 RT の consumer。

### 5.2 契約

```rust
/// DSP Plugin 実行クラス (4)。RT 側はこの 1 メソッドだけを呼ぶ（wait-free・alloc 無し・block ごと 1 回）。
pub trait TapSink: Send {
    fn commit(&mut self, interleaved: &[f32]);          // = 既存 PostMixSink
}
/// control 側の生成物: RT に渡す sink と、non-RT で動く consumer（thread / child / plugin 側）。
pub struct TapPlugin { pub sink: Box<dyn TapSink>, pub ready: Arc<AtomicBool> /* LinkChannelActivate.ready と同じ */ }
```

- **配置** = ライン上の `output(dest)` の宛先（doc 1 `OutputDest::Link` / `Render`）。**pre / post はタップの位置で決まる**（`output(link, thru: true).effect(...)` = 生を送る）。宛先プラグインは**ラック要素ではない**（レシーバにならない・doc 598 §3.1 と同じ）
- **戻り経路は無い**（egress 専用）。戻りが要るものは境界 1（insert）
- **readiness**: consumer が準備できるまで RT は commit しない（`ready`・`output.rs:557-563` のパターン）→ 「callback が push するが誰も drain しない ring」が構造的に無い
- **失敗**: consumer の死は control が検出して `ready = false` + 診断。RT は影響を受けない

### 5.3 実行の場所（2 形態・両方を契約に含める）

| 形態 | どこで動くか | 使いどころ | 根拠 |
|---|---|---|---|
| **(4a) in-process ring + thread** | daemon 内の非 RT thread | first-party（capture / render）・permissive のもの | 既存 `CaptureWriter` |
| **(4b) out-of-process CLAP（タップ配置）** | 境界 1 の child ホスティングをそのまま使い、**プラグインの出力を捨てる**（または `thru` で先へ）。プラグインは自分の非 RT thread で外部 I/O を行う（CLAP は許す） | **GPL / 外部 I/O のもの（LinkAudio egress の CLAP 化）** | +1 block 遅延は egress では無害。「1 child が両形式を同居ホスト」の機構が使える |

**LinkAudio egress → (4b)** が地図 §4.E「CLAP プラグイン化 🟢」の実装形。`orbit-link-audio` crate は **CLAP プラグインの中身**として別配布（GPL のまま・engine は知らない）。engine 側に残るのは `OutputDest::Link` の代わりの **`OutputDest::Tap(slot)`**（doc 1 §5.1 の `Link(usize)` を一般化。render も同じ列挙子で `Render(usize)` を吸収できるが、そこは doc 598 の実装順で決める・§18 (6)）。

---

## 6. 境界 4 — 標準シンセプラグイン（owner「MIDI 以上の表現力」・#497）と in-process WASM（実行クラス (3)）

### 6.1 契約: ソースの口は `BlockSource`

engine のソースは `BlockSource { render(frames, transport) -> usize; output(unit) -> &[f32] }`（`output.rs:270-273`）。instrument child はこれの実装（shm を読む）。**標準シンセプラグインも同じ trait の実装**であり、土台（#643 の feed）に**追加の受け手を作らず**乗る（#679 の入力も同じ・doc 679）。

| 項目 | 契約 |
|---|---|
| 入力 | 時刻付きイベント（note / **周波数** / param）— doc 428 の queue。**MIDI 以上の表現力** = 周波数ベースのイベント種を queue に足す（#497 本文「named superset union に新イベント種」）|
| 出力 | `output(unit)` = 2ch interleaved・`outs:` で unit ごとに宛先（doc 1 §5.6）|
| 実行 | (a) **in-process Rust**（first-party・permissive）/ (b) **in-process WASM**（ユーザーランド・実行クラス (3)）|
| 同じ口の他の実装 | instrument child（既存）/ **Audio I/O 入力（#679・未着手・`docs/design/679-input-consistency-check.md`）** |
| RT | `render` は alloc / lock 無し。WASM は **instantiate を RT 外**で行い、RT は作り置きインスタンスの `process` を呼ぶ（地図 §4.E）|

### 6.2 実行クラス (3) in-process WASM — 契約の形だけ（実装はスパイクの後・§18 (5)）

```
WASM モジュールの契約（unworklet 由来・地図 §4.E）:
  - import を持たない（RT 安全性はコンパイル時に証明）
  - export: process(in_ptr, out_ptr, frames) / set_param(id, value) / note(...)（doc 428 の event を写す）
  - メモリは instantiate 時に確保・process 中に伸ばさない
ホスト（daemon 内）:
  - ランタイム crate は permissive であること（候補の license を採用時に確認・#670 の規律）
  - instantiate / compile は control thread。RT は `call` のみ
  - 🔴 スパイクで測るもの: 1 block あたりの `call` 往復時間（p99）と、その block 長に対する比（数値目標は置かない・地図 §7 (2)「実用域の確認」）
```

「engine に DSP を抱えない」との整合（裁定 5）: **ランタイムはホスト**（境界 1 の child ホスティングと同格）で、ユーザーの DSP はモジュールに閉じる。GPL 論点はユーザーコードのライセンスが engine に及ばないので干渉しない。

---

## 7. 境界 5 — DSL Plugin（#671）

### 7.1 種 A / B の契約（`DSL_PLUGIN_SPEC` §1）

| | 種 A（宣言のみ） | 種 B（宣言 + 自前の実行） |
|---|---|---|
| 提供するもの | 語彙 + 引数型 + **engine プリミティブへの翻訳** + docs + テスト | 同左 + **自前の実行系（RT 外）** |
| 実行の場所 | engine（TS の interpreter → daemon wire）。RT 安全性を損なわない | プラグイン側の非 RT thread / プロセス |
| 実例 | mixer 語彙（`gain` `pan` `send` `output` `effect`）・記譜（`voicelead` `density`）・**標準プラグインの呼び出し形**（§4）| **MIDI 出力（`midi()` + `midi-scheduler.ts` の 5ms poll = 既存の種 B の原型）**・OSC 送信（#674）・Link テンポ同期（#321 → 段階 4）|
| イベントの受け取り | — | doc 428 の **時刻付きイベント queue の consumer**（非 RT）。MIDI がそうであるように、`play()` の出力を音楽時間で受け取る |

### 7.2 登録 API（段階 1〜3・外部ロード無し・A4 に依存しない）

```ts
// packages/engine/src/dsl-plugin/module.ts（新規）
export type Receiver = 'global' | 'seq' | 'bus' | 'render' | 'master'          // doc 610 の受け手の種類と同じ集合
export interface ParamSchema { readonly name: string; readonly type: 'number' | 'string' | 'boolean' | 'pattern' | 'node' | 'rack'; readonly optional?: boolean; readonly named?: boolean }
export interface VocabularyEntry {
  readonly receiver: Receiver
  readonly name: string                       // 'gain'
  readonly params: readonly ParamSchema[]
  readonly applicability: Partial<Record<Receiver | 'midi' | 'instrument' | 'audio', 'ok' | 'error' | 'warn'>>   // doc 610 の表の行
  readonly doc: { readonly ja: string; readonly en: string }
  readonly example?: string
}
export interface DslModule {
  readonly id: string                          // 'orbit.mixer'
  readonly version: string
  readonly kind: 'A' | 'B'
  readonly vocabulary: readonly VocabularyEntry[]
  /** 種 A: facade の実装（既存マネージャへの委譲）。receiver ごとの実装オブジェクト */
  readonly impl: Partial<Record<Receiver, Record<string, (...args: unknown[]) => unknown>>>
  /** 種 A: ラック要素（標準プラグインの呼び出し形 `Gain(db:)`）*/
  readonly rackElements?: readonly { readonly name: string; readonly clapId: string; readonly params: readonly ParamSchema[] }[]
  /** 種 B: 実行系の起動 / 停止（RT 外）。時刻付きイベントの consumer を登録する */
  readonly runtime?: { start(ctx: HostContext): Promise<void>; stop(): Promise<void> }
  /** テストの義務（A7）: モジュールが自分の E2E を持つ。gated spec のファイルパス */
  readonly tests: { readonly unit: string; readonly e2e: string }
}
export function registerDslModule(m: DslModule): void            // 起動時に first-party を全部登録。失敗は throw（黙らない）
export function vocabularyOf(receiver: Receiver): ReadonlySet<string>   // ← SEQUENCE_DSL_METHODS / GLOBAL_DSL_METHODS の**導出元**
```

| 段階 | 変更 | 効果 |
|---|---|---|
| 1 | `runtime.ts:20-70` の 2 Set を `vocabularyOf('global')` / `vocabularyOf('seq')` の導出に置き換え、first-party を `DslModule` として登録（mixer / notation / pitch / sample / io / transport…・#671 コメント 1 の 31 語）| 手書き Set が消える。`signal-chain-dispatch.spec.ts:613-800` は「登録に無い public メソッドは内部 API 明示が要る」へ |
| 2 | `sites/user/reference/methods.md` を `vocabulary[].doc` から**生成**（`npm run docs:check` が突合）| #668 C が不要 |
| 3 | `dsl-e2e-coverage.spec.ts` の baseline を `DslModule.tests.e2e` から導出（各モジュールの E2E ファイルに語が現れるか）| 手入力 baseline が消える |

**段階 1 は挙動不変**（Set の中身が同じ）。既存全テスト + gated E2E が緑であることがゲート（#668 が前提・裁定 6）。

### 7.3 拡張点（段階 4・`HostContext`）

```ts
export interface HostContext {
  readonly transport: {
    read(): { tempo: number; beat: Meter; running: boolean; position: string | null }     // #408 と同じもの（統合）
    write(patch: { tempo?: number }, source: string): void   // 🔴 競合規則は §18 (2)。現行 `global.tempo()` が唯一の書き手
  }
  /** `play()` が生成した TimedEvent 列への介入（種 A の記譜系）。純関数・同期 */
  readonly events: { intercept(seq: string, f: (events: readonly TimedEvent[]) => readonly TimedEvent[]): () => void }
  /** オーディオラインへの要素登録（doc 1 §3.1 `LineElement`）。first-party の `gain` / `send` / `output` もここを通す（裁定 8「裏口を残さない」）*/
  readonly line: { registerElement(kind: string, toWire: (args: unknown) => WireLineOp): void }
  /** 種 B: 時刻付きイベントの購読（doc 428）。非 RT で届く */
  readonly timedEvents: { subscribe(seq: string, consumer: (ev: TimedEvent, atMs: number) => void): () => void }
  readonly log: { info(msg: string): void; error(msg: string): void }   // 診断は必ずここへ（黙らない）
}
```

- **Link テンポ同期の DSL Plugin 化**（裁定 7・#321 PR3 の行き先）: 種 B。`runtime.start` で Link セッションへ参加し、`transport.read()` を Link へ push（リーダー）/ Link の tempo を `transport.write()`（フォロワー）。**engine は Link を知らない**（`orbit-link-audio` は plugin 側の依存になる）。書きの競合規則は §18 (2)
- **#408（live tempo を読める state に）** = `transport.read()` そのもの（統合・#671 チェックリスト）

### 7.4 実行形態（A4）— 段階 1〜4 は形態に依存しない

| 形態 | 種 A | 種 B |
|---|---|---|
| 同一プロセス TS モジュール | 自然（翻訳だけ）| GPL 分離が弱い（同一プロセス）|
| 別プロセス + IPC | 過剰（翻訳のために IPC）| GPL 分離が強い。`orbit-child-runtime` を流用 |
| **混在** | first-party = 同一プロセス | 外部 / GPL = 別プロセス |

本書は **段階 1〜4 の API を「同一プロセスでも別プロセスでも同じ signature」**（`HostContext` は IPC 越しにも写せる関数集合）に留め、形態は §18 (1) の裁定に委ねる。**段階 5（外部ロード）だけが形態に依存する。**

---

## 8. 残り = コア（裁定 1・列挙で確定）

境界 1〜5 の**どれにも属さないもの**。#671 コメント 1 の 9 語と一致し、裁定 8（依存が強いものは core）で若干広い。

| コア | 内容 | なぜ境界の外に出せないか |
|---|---|---|
| 時間の基準 | `tempo` `beat` `length`・拍→ms の算術・quantize の解決 | 他の全プラグインのタイミングがこれに対する相対値 |
| トランスポート | `start` `stop` `run` `loop`・`TransportClock`・仮想クロック注入点（doc 598 §6.3）| 「いつ起きるか」の土台。書きは拡張点として**外へ貸す**が所有はコア |
| 記譜の構造 | `play()` のネスト分割・パターン束縛・`_` `@v`・`init`/`var`/`LOOP` 構文 | プラグインが書き込む場所そのもの |
| ソースの口 | `instrument` / `audio` の**スロット**（`SourceSlot` / `BlockSource`）と `outs:` | 音が生まれる点。実装（child / std synth / WASM / 入力）は境界 1・4・#679 |
| ラインの合成規則 | 「順序 = 信号順」・`thru` の意味・合算の規則（doc 1）| 要素はプラグイン、**並べ方の規則は core**（#671 コメント 1）|
| RT 不変条件 | alloc / lock / syscall 無し・install ring・世代 retire（#628）| プラグインの合意事項にすると誰も強制しない |
| スケジューラ | `event-scheduler` / `midi-scheduler` の**時刻解決**・doc 428 の queue | 種 B はこの consumer であって owner ではない |
| ホスト基盤 | child ホスティング・shm・supervisor・capability 抽象・pool | 境界 1〜4 が乗る土台 |
| ミキサーの土台 | バス pool・トポロジ・`SetBusLine` wire | 語彙は境界 5（種 A）、**実行は engine**（owner「実行はエンジン側」）|
| wire | daemon protocol | — |

**コアの語（DSL）**: `tempo` `beat` `length` `start` `stop` `run` `loop` `play` `instrument` `audio` `setDocumentDirectory`（ホスト注入）。それ以外の語は境界 5 のモジュールに属する（段階 1 で登録に移す）。

---

## 9. LLM から見えること（A5・裁定「LLM は第一級ユーザー」）

```
DslModule.vocabulary
  ├─ 補完: plugin-catalog-completion.ts と同じ機構で、登録語 + params を候補に（新設 dsl-vocabulary-completion.ts）
  ├─ 診断: applicability 行 → doc 610 の表の供給源（静的診断 + 実行時が同じ表を読む）
  ├─ get_dev_doc / search_dev_docs: 生成した reference/methods.md（段階 2）を読む
  └─ 新 MCP tool `list_dsl_vocabulary`（receiver → [{name, params, doc}]）: 生成物を介さず登録から直接返す
```

**届かなければ LLM は新語を使えない**（#672 A5）ので、`registerDslModule` は 4 面すべてへ同じ構造体を配る。E2E-P3（§15）。

---

## 10. 信頼境界とライフサイクル（A6）

| 項目 | 契約 |
|---|---|
| ロード順序 | first-party は起動時に固定順（transport → mixer → notation → pitch → sample → io）。外部（段階 5）は first-party の後・宣言の依存順 |
| バージョン | `DslModule.version` + `DSL_VERSION`（`version.ts:18`）。互換しない語の再定義は**登録失敗**（同名の上書きを許さない）|
| 失敗 | 登録失敗 = `registerDslModule` が throw → 起動ログ + 診断。**黙って無視しない**（#661 の教訓）。種 B の runtime 失敗 = `log.error` + その語彙は「実行系停止」診断（評価は受理・音は出ない旨を返す）|
| 第三者 | 段階 5 の判断（§18 (1)）まで first-party のみ。契約は同じ |

---

## 11. テストの契約（A7）

| 義務 | 仕組み |
|---|---|
| モジュールは unit + E2E を持つ | `DslModule.tests` が実在ファイルを指す（無ければ登録失敗）|
| E2E カバレッジは登録から導出 | 段階 3（§7.2）。baseline の手入力廃止 |
| 種 B は「外へ出たもの」を検証 | MIDI: 既存 / OSC: UDP 受信スタブ（#674）/ Link: headless receiver（`link-audio-verification` feature・`orbit-audio-daemon/Cargo.toml:28`）|
| 標準プラグインは実機ゲート | §4 |

---

## 12. 2 本の spec の目次と規範文（PR-P0 の成果物・実装より先）

### 12.1 `DSL_PLUGIN_SPEC_v1.md`

```
§0 Design Principles: (1) 語彙は登録から導出する（手書き Set を持たない）(2) コアは境界の残り（§8 の列挙）(3) first-party も同じ拡張点（裏口無し）(4) 失敗は黙らない (5) LLM から発見できる
§1 種 A / 種 B の契約（§7.1）
§2 登録 API（§7.2 の型）
§3 拡張点（§7.3）— transport read / write（競合規則は Open Question）/ events.intercept / line.registerElement / timedEvents.subscribe
§4 ライフサイクルと失敗（§10）
§5 テストの契約（§11）
§6 first-party モジュールの一覧（段階 1 の分割: transport(core) / mixer / notation / pitch / sample / io）
§7 種 B の実例: MIDI 出力（既存）/ OSC（#674・表面は Open Question）/ Link テンポ（#321）
§8 Open Questions: A4 実行形態 / transport 書きの競合 / 第三者への公開
```

### 12.2 `DSP_PLUGIN_SPEC_v1.md`

```
§0 Design Principles: (1) engine に DSP を抱えない（SC.10.8）(2) 「DSP Plugin」は音を処理する契約の名で、信号処理一般（既存 30 ファイルの用法）とは区別する (3) RT 契約は #628 (4) ランタイム（child / WASM）はホストであって DSP ではない
§1 実行クラス (1) out-of-process 3rd-party（§3）
§2 実行クラス (2) 標準プラグイン（§4・SC.10.8 (1)-(6) + 検証の義務）
§3 実行クラス (4) タップ / egress（§5・`TapSink` + readiness + 配置 = 出口）
§4 実行クラス (3) in-process WASM（§6.2・契約の形。ランタイム採用はスパイク後）
§5 標準シンセプラグイン（§6.1・`BlockSource` + 周波数イベント）
§6 DSL からの見え方（`effect([...])` の記法・順序 = 信号順・state）
§7 既知の穴（#667 / ロード診断 / #661）= 「あるべき姿」と issue の差分
§8 Open Questions: WASM ランタイムの選定 / (4b) と (4a) の使い分け基準
```

---

## 13. 呼び出し元の全列挙（grep 実行結果・main `ca176f0`）

### 13.1 語彙 Set の読み手

```
$ grep -rn "SEQUENCE_DSL_METHODS\|GLOBAL_DSL_METHODS\|BUS_DSL_METHODS" packages tests --include=*.ts | grep -v dist
packages/engine/src/signal-chain/runtime.ts        （定義 :20-70 + guardBusChain の参照）
packages/engine/src/interpreter/…                   （dispatch の判定）
tests/interpreter/signal-chain-dispatch.spec.ts:613-800
tests/e2e/dsl-e2e-coverage.spec.ts:34-37
```
（段階 1 で `vocabularyOf()` に置き換える対象。実装時に再 grep して差分ゼロを確認する）

### 13.2 child の busy-wait（本番コード・#667 の対象）

```
$ grep -rn "spin_loop" rust/crates --include=*.rs | grep -v target | grep -v "/tests/" | grep -v "spike"
orbit-clap-instrument-child/src/main.rs:252
orbit-vst3-instrument-child/src/main.rs:354
orbit-vst3-effect-child/src/main.rs:148
orbit-effect-rack-child/src/macos.rs:573
orbit-clap-effect-child/src/main.rs:141
orbit-audio-sandbox/src/bin/sandbox-instrument-child.rs:104 / sandbox-effect-child.rs:86
```

### 13.3 ホストが使う規格拡張

```
CLAP: clap.render ×5 / CLAP_EXT_STATE ×4（orbit-clap-host/src）
VST3: IAudioProcessor ×20 / IHostApplication ×6 / IComponentHandler ×6（orbit-vst3-host/src）
```
→ DSP_PLUGIN_SPEC §1「ホストが提供する拡張」の一覧の初期値。**gui / params / note-ports は grep に出ないので、child 側（`orbit-child-ui` 等）を含めて実装時に再列挙する**（本書の限界）。

### 13.4 Link テンポの書き手（transport write の現行）

```
global.ts:239        tempo(value?)                  ← DSL（唯一の書き手）
global.ts:547-551    Link へ push（setLinkTempo）    ← 読みの転送
rust-engine-player.ts:927-935  setLinkTempo（feature 未ビルドなら warn）
orbit-link-audio/src/lib.rs:53-55  orbit_link_set_tempo / orbit_link_session_tempo（FFI・実装済み）
```

---

## 14. 失敗モード

| 状況 | 挙動 | 出口 |
|---|---|---|
| 同名語の二重登録 | `registerDslModule` throw | 起動ログ + 診断 |
| `tests.e2e` が実在しない | 登録失敗 | 同上 |
| 種 B runtime.start 失敗 | 語彙は残り、評価時に「実行系が停止」診断 | `[ERROR]` → `get_log` |
| 種 B の外部 I/O 失敗（UDP / Link） | `log.error`・音楽は止めない | 同上 |
| タップ consumer 死亡 | `ready=false`・RT は commit しない | 診断 |
| WASM `call` が block 長を超える | RT は打ち切れない → **スパイクで実用域外なら採用しない**（§18 (5)）| — |
| 標準プラグイン未同梱 | rack child が `ORBIT_STD_PLUGIN_DIR` を解決できず load 失敗 = 診断 | `[ERROR]` + 実機ゲート red |

---

## 15. E2E（MCP 経由・数値で判定）

| # | シナリオ | 判定 |
|---|---|---|
| E2E-P1（段階 1 挙動不変） | 既存 gated suite 全件 | 緑のまま（Set 導出前後で `vocabularyOf` の中身が集合として等しい unit も併置）|
| E2E-P2（種 B・OSC・#674 表面確定後） | `seq.osc(...)`（表面は §18 (3)）を評価・LOOP 2 小節 | UDP 受信スタブが**時刻・アドレス・値**を受ける。到着時刻の間隔が拍間隔 ± lookahead 幅 |
| E2E-P3（A5） | `list_dsl_vocabulary` と `get_dev_doc('reference/methods.md')` | 登録語がすべて両方に現れる（差集合が空）|
| E2E-P4（(4b) タップ CLAP） | テスト用タップ CLAP（受けた block を UDP へ流す fixture）を `output(tap, thru: true).output(master)` | 受信側の RMS が master capture の RMS と一致（±10%）・master は不変 |
| E2E-P5（標準プラグイン） | `effect([Gain(db: -6)])` | 既存（rack expectations）|
| E2E-P6（Link テンポ DSL Plugin・段階 4 後） | `link-audio-verification` receiver で `global.tempo(132)` → セッション tempo 132 | headless readback（#321 層B）|

`dsl-e2e-coverage.spec.ts` は段階 3 で導出型に置き換わる（baseline を増やさない規律はそのまま機械で守る）。

---

## 16. PR 分割

| PR | 内容 | 依存 | 一方通行 |
|---|---|---|---|
| PR-P0 `docs(spec): DSL Plugin / DSP Plugin contracts v1` | §12 の 2 spec + core spec への参照 1 行 | #668 の E2E 基盤（doc 668）が**先** | — |
| PR-P1 `refactor(dsl): derive vocabulary sets from module registration (behaviour-preserving)` | §7.2 段階 1・first-party 6 モジュール・`signal-chain-dispatch.spec` 改訂 | PR-P0 | — |
| PR-P2 `feat(docs): generate reference/methods.md from module declarations` | 段階 2 + `docs:check` | PR-P1 | — |
| PR-P3 `feat(test): derive DSL E2E coverage from registered modules` | 段階 3 | PR-P1 | — |
| PR-P4 `feat(dsl): HostContext extension points (transport read, events.intercept, line.registerElement, timedEvents)` | §7.3・`write` は §18 (2) の裁定後 | PR-P1・doc 428 PR（queue）・doc 1 PR-O4 | API |
| PR-P5 `feat(daemon): TapSink class — OutputDest::Tap and tap placement for out-of-process CLAP` | §5 | doc 1 PR-O3・doc 598 PR-R2 | wire |
| PR-P6 `feat(dsl-plugin): OSC output as the first kind-B module` | #674・§18 (3) 裁定後 | PR-P4・doc 428 | DSL |
| PR-P7 `feat(dsl-plugin): Link tempo as a kind-B module (engine knows no Link)` | #321 PR3 の行き先 | PR-P4・§18 (2) | — |
| PR-P8 `spike(daemon): in-process WASM process() latency probe` | §6.2 の測定のみ | — | — |

**並行可能**: PR-P8（スパイク）は独立・最初に出せる。PR-P2 と PR-P3 は独立。

---

## 17. 確信度と反証方法

| 主張 | 確信度 | 反証 |
|---|---|---|
| 段階 1 は挙動不変にできる | 高 | 導出 Set の集合等価 unit + gated 全件 |
| タップ (4b) で LinkAudio を CLAP に出せる | 中 | E2E-P4 の fixture が成立するか（child が「出力を捨てる」配置を受けるか = `SetBusLine` の `thru` で表現できるか）|
| `BlockSource` が標準シンセの口として足りる | 中 | 周波数イベントを `NeutralEvent` に足した時に `render(frames, transport)` の引数で足りるか（doc 428 の queue が transport と一緒に届く前提）|
| WASM が RT で実用域 | 未知 | PR-P8 |

---

## 18. 🔴 owner 裁定待ち

| # | 問い | 選択肢 | 推奨 | 影響 |
|---|---|---|---|---|
| (1) | A4 実行形態 | A 同一プロセス / B 別プロセス + IPC / **C 混在** | **C**（first-party = 同一プロセス・外部 / GPL = 別プロセス）。段階 1〜4 は形態非依存に設計済み | PR 段階 5 のみ |
| (2) | transport **書き**の競合規則 | A 単一 writer（`leader` を宣言した 1 モジュールだけ・DSL `global.tempo()` は leader 時に拒否 / follower 時に通す）/ B 最後の書きが勝つ + ログ / C 優先度 | **A**（Link の leader / follower の意味そのもの・競合を構造で消す）| PR-P4 の `write` |
| (3) | #674 OSC の DSL 表面 | 宛先: `seq.osc("host:port")` / 名前参照 + `global.oscTarget(...)`。送るもの: A 音符写像 / B `address()` + 値 / C 両方 | **名前参照 + C**（インスタレーション用途に B が要る・既存譜面は A で動く）| PR-P6 |
| (4) | #669 標準プラグインの表面 | doc 634 §16 | 同左 | — |
| (5) | WASM ランタイム採用の可否 | PR-P8 の実測後 | 測ってから | 実行クラス (3) |
| (6) | `OutputDest::Link` / `Render` を `Tap(slot)` に統合するか | A 統合 / B 別列挙子のまま | **B を先に出し、PR-P5 で統合**（doc 598 の実装順を止めない）| doc 1 §5.1 |
| (7) | 第三者への公開（段階 5）の時期 | first-party のみ / 公開 | first-party のみで 1 リリース | — |
