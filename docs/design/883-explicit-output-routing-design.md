# #883 — 暗黙 master 終端の廃止（テキストが完全な真実）設計

> **Status**: 起案（2026-09-11・Fable）→ **main の設計審査を反映（同日・指摘 4 件: §2.2 D の instrument を固定上限に依存させない / skip の挿入位置と #282 / `send` だけのラインの診断 / §2.6 失敗時・未設定時の向きを master でなく無音へ）**。owner 裁定は [#883](https://github.com/signalcompose/orbitscore/issues/883) が正本で、本書はそれを実装可能な形に落とすもの。**#883 の裁定は再議論しない。**
> **位置づけ**: 4.0.0 / `DSL_VERSION` 2.0 の唯一の破壊的変更。凍結線（`NATIVE_MIGRATION_2026-09.md` §12.2）の前提「DSL 表面は O-surface で確定した」が崩れたので、3.0.0 で曲が書かれる前に直す。
> **関連**: [`611-output-line-design.md`](611-output-line-design.md)（§2.1 の暗黙終端をここで撤回）/ core spec MX.2 / SC.2.1 規範 (6)。

---

## 0. 裁定（#883・再議論しない）と本書が足す事実

| # | 裁定（#883） | 本書での扱い |
|---|---|---|
| R1 | 暗黙 master 終端を**完全に廃止**（P3）。「出口を 1 つも書かなければ暗黙」（P2）も却下 | §2 |
| R2 | 「**テキストが完全な真実**」。部分デフォルトを作らない | §2 / §3 |
| R3 | (i) master **ノード**が宣言なしに存在する = **維持** / (ii) 終端の無いラインに `output(master)` が**付く** = **廃止** | §2.2 |
| R4 | 4.0.0 / `DSL_VERSION` 2.0 | §7.5 |
| R5 | 既存譜面の後方互換は担保しない | §7 は「直す」手順であって互換機構ではない |
| R6 | 診断とセマンティクスは**同じリリース** | §6 の束の切り方 |

### 0.1 🔴 本書が一次ソースで確かめた事実 — 「暗黙 master」は **4 箇所**に実体がある

#883 のチェックリストは `audio-line.ts:333-342` の `program()` を「変更の中心」としているが、
**それを消しただけでは `kick.play()` は鳴り続ける。** 暗黙 master の実体は 1 箇所ではない:

| # | 実体 | どこで | 効く条件 | 出典 |
|---|---|---|---|---|
| A | `program()` が終端を**合成**する | TS | シーケンス / バスが **daemon にラインを持つ**（`_insertBus` 有り）時だけ | `packages/engine/src/core/sequence/audio-line.ts:335-342` |
| B | **バス無しの audio シーケンス**は engine が直接 `master.buffer` へ描画する | Rust | `.output()` / `.send()` / `.effect()` を 1 つも書かない audio シーケンス（= `kick_loop.orbs` 型） | `sequence.ts:715-716`（`pushBusLine` は `_insertBus` 無しで早期 return）/ `rust/crates/orbit-audio-native/src/output.rs:1855-1888`（`render_engine_with_sources_impl` が `master.buffer` へ）|
| C | **daemon のバス既定ライン**が `legacy(Master, [])` | Rust | `global.sum()` / `global.aux()` を宣言しただけで `SetBusLine` を一度も送っていないバス | `output.rs:1568-1575`（`with_activation` の `LineProgram::legacy(BusTarget::Master, &[])`）/ `output.rs:1121-1131`（`legacy_line_ops` = `[Rack, Output(Master)]`）。TS 側は宣言時に push しない（`mixer-manager.ts:298-306`）|
| D | **instrument の source routing** が `target: null` = Master。さらに daemon 側の初期値も `SourceDest::default()` = Master | Rust | `instrument()` 直後（`_insertBus` 無し・`ensureInstrumentSourceRouting` は早期 return） | `sequence.ts:960-961` / `rust/crates/orbit-audio-daemon/src/session.rs:490-520`（`target: null` → `None`）/ `engine_wrap.rs:7363`（`None => SourceDest::Master`）/ `output.rs:907-913`（`#[default] Master`）|

**A だけを消すと**: `kick.audio().play()`（B）は今までどおり鳴り、`global.sum("d")` + `kick.send(d,-6)` の `d` バス（C）は master へ流れ続ける。「出口を書かないラインが無音」という完了条件は **B・C・D を同時に閉じて初めて**満たされる（§1 D2 / D5 / D6）。
確度 **高**。反証: `program()` の合成だけを消した状態で `kick_loop.orbs` を実機で鳴らして無音になれば本節が誤り。

### 0.2 🔴 もう 1 つの制約 — `.output()` はバスを確保し、バスは **8 本**しか無い

`Sequence.output()` は `stageOutputElement` で `ensureSequenceInsertBus` を呼び（`sequence.ts:490`）、それは `BusPool.acquire` で **`seq-bus-0..7` の 8 スロット**から取る（`packages/engine/src/core/global/sequence-effect-manager.ts:29,44-50,98-104` / `effect-slot.ts:996-1005`。daemon 側の既定も 8・`engine_wrap.rs:2035`）。9 本目は **throw**（`seq.effect() insert bus pool exhausted`）。

今日は「バスが要るシーケンス（effect / 非 master 宛て / send）」だけが消費している。**`.output()` を全シーケンスに必須化し、かつ今の実装のまま**にすると、`examples/performance-demo.orbs`（`.play()` 24 箇所）のような譜面は **9 本目の `.output()` で落ちる。** これは #883 が想定していない新しい故障モードで、§2.3 で扱う。確度 **高**（コードの直読）。

🔴 **問いの立て方（main 審査 2026-09-11 で訂正）**: 固定上限は「設計で避けるもの」ではなく**撤廃が裁定済みのもの**である —
owner Q-598-5「マシンの上限まで使える。最適化で応える」（`598-render-endpoint-design.md:562`）/ `662-performance-and-visibility-design.md:23`「上限を決めない対象にトラック / インスト / Link を含む」/ #663（OPEN・プールを off-thread で伸ばす）/ owner 逐語「また制限を付けようとしていないか」（`634-pdc-layer-instrument-rack-design.md:683`）。
したがって本書が答える問いは「9 本の instrument は現実的か」ではなく **「#883 は固定上限に依存する箇所を新しく増やしていないか。増やすなら、どう増やさずに済ませるか」** である。答え: **増やさない**（§2.3・§2.3a）。バスを確保する契機は**今日の集合と同一**（rack / 非 master 宛て / thru / db≠0 / instrument の gain・pan）に保ち、`.output()` 単独と「出口なし」はバスを使わない。

---

## 1. 🔴 完了条件（何を満たせば done か・何を検証すれば正しいと言えるか）

「通るテスト」ではなく、**それぞれの条件に対応する検証手段**を固定する。すべて満たして done。

| # | 条件 | 検証手段（正本） | 束 |
|---|---|---|---|
| **D1** | `AudioLine.program()` が出口を**合成しない**（`[rack?] + elements` のみ）。ラックの位置マーカー合成は残す（§2.4） | unit `tests/core/audio-line.spec.ts` の `master()` 期待を全件書き換え（`:33-179`）。合成が残っていれば red | S |
| **D2** | **出口を 1 つも持たない audio シーケンス**（出口 = `output` / `send` / 裸バス形 / LinkAudio channel）は**スケジュールされず無音**。理由は 1 度だけログに出る | E2E **X1**（§8・差分法で RMS が基準と等しい・漏れれば 2 倍）+ `expectLogMarkerAtLeast`。unit `resolveDispatchChannel()` | S |
| **D2b** | 🔴 **#282 の再発防止**: skip は `isNoteSequence()` の早期 return（`sequence.ts:1865-1867`）より**後ろ**にある。出口を書かない `.midi()` シーケンスは `{ kind: 'hardware' }` のまま（MIDI は外部デバイスへ出るので無音にしてはならない）。instrument も `resolveDispatchChannel()` では skip しない（無音は §2.2 D の source routing で実現する） | unit `tests/core/sequence-output.spec.ts` に 2 本: 「`.midi()` + 出口なし → hardware」「`.instrument()` + 出口なし → hardware」（`:273` の既存テストと同型）| S |
| **D3** | `.output()` の引数省略 = `output("master")`（`Sequence` と `MixerBusHandle` の両方） | E2E **X2**（2 譜面の RMS 一致 ±0.02 かつ `noBus` golden ±0.12）+ unit | C |
| **D4** | sum へ `send` しただけのシーケンスの **dry は master へ届かない** | E2E **X3**（master RMS / plain = `10^(db/20)`。漏れれば `1 + 10^(db/20)`） | S |
| **D5** | 宣言しただけで出口を書かない sum / aux は**無音**。daemon のバス既定ラインが `[Rack]`（出口なし）であり、TS は宣言時に何も送らなくてよい（§2.6 (c)） | E2E **X4**（差分法）+ cargo unit D13(c) | S |
| **D6** | 出口を書かない instrument は**無音**。かつ `inst.output()`（master のみ）は**バスを消費せずに**鳴る（`getInsertBus() === undefined`） | E2E **X5**（`captureInstrumentScenario` 差分法・A/B）+ unit（`instrument()` 直後に `SetSourceRouting(…, {kind:'none'})`、`.output()` で `{kind:'master'}`、`_insertBus` は未確保のまま） | S |
| **D6b** | 🔴 **固定上限への依存を増やしていない**: バスを確保する契機の集合が今日と同一（§2.3a の表） | unit: 「audio `.output()` 単独」「instrument `.output()` 単独」「出口なし」の 3 ケースで `BusPool.acquire` が**呼ばれない**（`toHaveBeenCalledTimes(0)`）。今日バスを確保する 5 契機は**呼ばれる**（既存テストが守る）| S |
| **D7** | 編集時診断 (a): 出口の無いシーケンスの `.play(` に Warning（code `output-missing`）。(b) **aux 宛て `send` だけ**で終端が無いラインに Information（code `dry-not-routed`・§5.1）。sum 宛て `send` だけ・裸バス形・LinkAudio 宛ては**出さない** | unit `tests/vscode-extension/diagnostics-analysis.spec.ts`（正例 2 + 負例 3）+ E2E **X6**（`get_diagnostics`） | S |
| **D8** | quick fix: 診断位置から `<name>.output()` を挿入できる | unit（純関数）+ `tests/vscode-extension/` の vscode モックで CodeAction を実行 | S |
| **D9** | 補完: `.output(` 直後に `master` + 宣言済み sum / aux / ノード変数 | unit `detectDslCompletionContext` + provider | C |
| **D10** | **既存 golden が 1 つも動かない**（`OUTPUT_LINE_GOLDENS` 全キー・E2E-2〜P・E2E-7）— fixture に `.output()` を足した後で | `npm run test:e2e:gated` 全件緑。🔴 **これが束 C の検算そのもの**（§6） | C |
| **D11** | 版: `packages/vscode-extension/package.json` 4.0.0 / `version.ts` `DSL_VERSION = '2.0'`。3.0.0 の bump が触った 10 ファイル（commit `7f40ff84`）と同じ集合を更新 | `scripts/check-release-tag-version.mjs` が緑・`git show --stat 7f40ff84` の集合と突合 | S |
| **D12** | spec が**先に**改訂されている（運用規則 6）: core MX.2 §2.1 / SC.2.1 規範 (6) / 611 §2.1 撤回追記 / USER_MANUAL・learning site の全例に `.output()` | `npm run docs:check` 緑・§7 の表を消化 | 0 / C |
| **D13** | cargo: (a) `SetBusLine(bus, [rack])`（出口なし）が**受理され、そのバスの音がどこにも加算されない**。(b) `SetSourceRouting` の `target` が `{kind:'none'}` / `{kind:'master'}` / `{kind:'bus', name}` を受理し、`none` の unit は**どこにも加算されない**（§2.2 D）。旧 `null` / 文字列形は**拒否**（一方通行）。(c) **バス既定ライン `[Rack]`**: `SetBusLine` を一度も受けていないバスへ member が出しても hw に加算されない | 新 unit（`engine_wrap.rs` の `set_bus_line_*` 群に 1 本・`set_source_routing_*` 群に 2 本・`output.rs` の RT テストに `SourceDest::None` を 1 本・`session.rs:3162-3190` のパーサテストを書き換え・`output.rs:3896` `tagged_event_with_unattached_bus_still_drops` を「消費されるが hw は 0」へ書き換え） | S |
| **D15** | 🔴 **routing の失敗・未設定は無音であり、master へ落ちない**（§2.6 の規則）。対象 6 箇所 (a)〜(f) すべて | 手書き変異（CLAUDE.md「棄却案への差し戻し」型・PR あたり数件の枠）: `encode` / `decode` / バス既定ライン / `FeedDest` の 2 arm / slot 解放時の store を**それぞれ Master に戻すと red になる RT unit**。既存 `source_dest_cell_roundtrips_every_destination_and_defaults_invalid_values`（`output.rs:3360-3381`）の `Master` 期待を `None` へ反転させるのがその 1 本目 | S |
| **D14** | `npm test` 全緑・lint 緑・`cargo test` 緑・実機 gated 全件緑（主が sandbox 外で） | マージ前ゲート（CLAUDE.md） | 各束 |

束: **0** = spec 先行 PR（main 直行）/ **C** = 束 X-compat（振る舞いを変えない）/ **S** = 束 X-semantics（振る舞いを変える）。§6。

---

## 2. セマンティクス — 4 つの実体をどう閉じるか

### 2.1 規則（DSL の言葉で・spec に書く文）

> **ラインの出口は、譜面に書かれたものがすべてである。** 出口を 1 つも持たないラインの信号はどこへも加算されない（無音）。
> `master` は宣言なしに存在する**ノード**（受け手）だが、宛先として**書かれた時だけ**信号を受け取る。
> `.output()` の引数省略は `output("master")` の既定引数である（暗黙ではなく既定値）。

これで SC.2.1 規範 (6)「ミキサー宣言の無いファイルは暗黙 master(1,2) を持つ」は **(i) ノードの存在**の意味だけに縮む。決定 #75「素朴な 1 ファイル経路の保護」は `kick.audio("k.wav").play().output()` が import も mixer 宣言も要らないことで引き続き満たされる（#883 本文）。

### 2.2 実体ごとの閉じ方

| 実体（§0.1） | 変更 | 場所 | 確度 |
|---|---|---|---|
| **A** `program()` の合成 | 出口の合成を**削除**。`[rack]` の前置は残す（§2.4） | `audio-line.ts:335-342` を削る | 高 |
| **B** バス無し audio の直接描画 | `resolveDispatchChannel()` に **`skip` を 1 つ足す**: 「ラインに出口が無く、かつ LinkAudio channel も無い」→ `{ kind: 'skip', reason }`。既存の LinkAudio 用 skip（`sequence.ts:1874-1882`）と**同じ機構**（`logSkipOnce` で 1 度だけログ・throw しない・#645 の裁定を継承）。🔴 **挿入位置は `isNoteSequence()` の早期 return（`:1865-1867`）より後ろ**。前に置くと `.midi()` が無音になる — #282 で一度踏んでおり、同じ関数のコメントがそれを記録している。instrument も `isNoteSequence()` で hardware を返したままにし、無音は D で実現する | `sequence.ts:1856-1885`。呼び出し元は `:1787`・`:1900`・`:1946`・`:1994` の 4 箇所で、いずれも既に `skip` を処理している。回帰テストは D2b | 高 |
| **C** バス既定ライン | **daemon の既定を `legacy(Master, [])` から `[Rack]`（出口なし・無音）へ変える**（§2.6 (c)）。TS は宣言時に何も送らない — 「未設定 = 無音」が RT 層の規則になるので、宣言時 push という機構も、その順序問題（旧 F2）も消える。初稿は「wire 契約・他の cargo テストが依存」を理由に既定を維持していたが、**列挙したら依存は 1 テスト + 定義 2 箇所だった**（§2.6 (c) の表）| `output.rs:1573`（`with_activation`）と `engine_wrap.rs:2132`（`default_bus_line_program`・shadow の seed 元）を**同じ 1 関数**から取る（`engine_wrap.rs:2125-2131` の「exactly one place」の約束を守る）| 中 |
| **D** instrument の source routing | **バスを確保しない。** `SetSourceRouting` の `target` を**明示 3 値**にする（§2.2.1）: `instrument()` 直後に `{kind:'none'}`（どこにも加算しない）、`.output()`（master のみ）で `{kind:'master'}`、バスが要る契機（rack / 非 master 宛て / thru / db≠0 / gain・pan）で従来どおり `{kind:'bus', name}`。**バスを確保する契機は今日と同一**（`ensureInsertBusForInstrument` `sequence.ts:496-503` は変えない）| `sequence.ts:813-838` 末尾 + `ensureInstrumentSourceRouting`（`:960-985`）の dedup キーを bus 名から**宛先キー**へ一般化 | 中（wire 変更を伴う）|

**なぜ B を「全シーケンスに必ずバスを持たせる」で閉じないか**: 8 本のプール（§0.2）を出口の無いシーケンスにまで払うことになる。skip は既存機構で、ログも出る。

#### 2.2.1 `SetSourceRouting.target` の明示化（wire・🔴 一方通行）

今日の wire は `target: null | string` で、**`null` が「暗黙 master」**（`session.rs:495-520` / `engine_wrap.rs:7363`）。「テキストが完全な真実」を wire まで通すには、**master を書く値**と**どこにも出さない値**の両方が要る。`SetBusLine` の `dest` が既に持つ語彙（`{kind: master | bus | device | render | link}`・`session.rs:455-458`）に揃える:

| wire `target` | daemon | 送る時 |
|---|---|---|
| `{ "kind": "none" }` | 新 `SourceDest::None` — RT は unit の出力を**捨てる**（`output.rs:2141-2148` の `FeedDest` 変換に `Discard` arm を追加。`SourceDestCell` の encode に `END` の空きコードを 1 つ使う `:918-951`）。**`SourceDest::default()` も `None`**（§2.6 (b')） | 出口をすべて消した時（再評価で `output` を消した等）。`instrument()` 直後は daemon の既定が既に `None` なので送らなくてよい（送っても冪等） |
| `{ "kind": "master" }` | `SourceDest::Master`（既存） | `.output()` / `.output("master")` のみのライン（バス無し） |
| `{ "kind": "bus", "name": "seq-bus-n" }` | `SourceDest::Bus(index)`（既存） | バスを確保した時（今日と同じ契機） |
| `null` / 文字列 | **拒否**（`PARAM` エラー） | — |

- **daemon の初期値 `SourceDest::default()` は `Master` → `None` へ変える**（`output.rs:907-913`・§2.6 (b')）。初稿は「変えない・真実は TS が push する」としていたが、§2.6 の規則「未設定は無音」に反する。TS は**宣言された出口だけ**を送る（`master` / `bus`）。`engine_wrap.rs:3599-3676` の source-routing テストは `Master` 期待を `None` へ反転させる（D15 の変異の 1 つ）
- **一方通行**（wire 契約）なので **束 S の先頭に単独の小 PR（S-0）**として置く（`BUNDLE_BRANCH_WORKFLOW.md` §5.1「一方通行の決定を含む PR は束の先頭か単独に」）。TS クライアント（`packages/engine/src/audio/types.ts:249` の `target: string | null`）も同じ PR で型を変える
- `Link(_)` は instrument → LinkAudio が未配線（`sequence.ts:592-597` で拒否）なので wire には出さない

確度 **中**。反証: (a) `FeedDest` に「捨てる」相当が無く RT ループの構造上 1 arm で済まない（`output.rs:2100-2200` を実装時に読む）。(b) `SourceDestCell::decode` の `_ => Master` フォールバック（`:948`）が `None` のコードを master に読み替える — encode/decode を対で足し unit で往復を固定する。

### 2.3 🔴 プール上限への手当て — 「実現の省略」（realization elision）

`.output()`（引数省略 = master）を全シーケンスに要求すると、**現行実装では 9 本目で throw** する（§0.2）。選択肢:

| 案 | 内容 | 利点 | 欠点 |
|---|---|---|---|
| **A: プールを増やす** | TS `SEQUENCE_EFFECT_BUS_POOL_SIZE` と daemon 起動時の `ORBIT_EFFECT_BUS_POOL` を 32 等へ | 実装が単純 | **RT コストが未測定**（`InsertBusStage` は callback ごとに buffer clear + ライン実行。`output.rs:2540-2590`）。`noBus` golden（`kick_loop.orbs`）の音が**バス経由**になり、611 §9 の「バス無し経路 = bit 一致」の検算が消える |
| **B: 実現の省略（推奨）** | ラインが **`[output(master, thru:false, db:0)]` だけ**（rack 無し・他の出口無し）の間は**バスを確保しない**。engine の直接経路（§0.1 B）/ instrument は `SetSourceRouting {kind:'master'}`（§2.2.1）で実現する。rack / 非 master 宛て / thru / db≠0 が現れた時点で確保（既存の `adoptLineOnFirstBus` の延長） | `kick.output()` が**今日の `kick.play()` と bit 同一クラス**で鳴る（O0-1 golden がそのまま検算になる）。**プール消費は今日と同じ（固定上限への依存を増やさない）** | `stageOutputElement` に述語が 1 つ増える（**DSL の規則ではなく実装の実現規則**。テキストは変わらず完全な真実）|
| **C: #663（プールを off-thread で伸ばす）に依存させる** | 上限そのものを先に撤廃する | 正直 | #663 は **#662 バッチ B（余裕の表示）が前提**で「逆にしてはいけない」と明記（issue 本文）。機構は install ring の適用だが、RT 不変条件・世代退役・拡張中の無断音 E2E を含む**独立した束**になる。4.0.0 の破壊的変更を待たせる根拠にはならない。**B なら #883 は #663 の完了を必要としない**（依存を増やさないので、#663 が入った時に何も直さなくてよい）|

**推奨 B（instrument を含む）。** 理由は (1)「振る舞いを変えない束 C の検算（D10）を bit 同一クラスで保てる」(2)「**バスを確保する契機の集合が今日と同一**なので、固定上限に依存する箇所が 1 つも増えない」こと。gain / pan の固定値は今日も**バス無しでは発音側**に適用されている（core spec MX.1 の注記 `:1770-1776`）ので、B はその規則の延長であって新しい二重性ではない。

### 2.3a 🔴 固定上限への依存を増やしていないことの表（main 審査・指摘 1 への答え）

| 契機 | 今日バスを確保するか | 本変更後 | 出典 |
|---|---|---|---|
| `effect()` / rack | する | する（同じ） | `sequence.ts:904` |
| `output(非 master)` / `send()` / `thru:true` / `db≠0` | する | する（同じ） | `sequence.ts:490` |
| `output()` / `output("master")` 単独（audio） | **しない**（今日は出口自体が無い譜面に相当） | **しない**（実現の省略） | §2.3 B |
| `output()` 単独（instrument） | 該当なし（今日は暗黙 master） | **しない**（`SetSourceRouting {master}`） | §2.2.1 |
| instrument の `gain()` / `pan()` | する（発音側の経路が無い） | する（同じ・`ensureInsertBusForInstrument` は不変） | `sequence.ts:496-503` |
| 出口なし（audio） | しない | しない（dispatch skip） | §2.2 B |
| 出口なし（instrument） | 該当なし | **しない**（`SetSourceRouting {none}`） | §2.2.1 |

**増えた行はゼロ。** 上限の撤廃そのもの（#663）には触らず、#663 が入っても本書の経路は変えなくてよい。

述語（`audio-line.ts` に純関数として置く。`Sequence` は呼ぶだけ）:

```ts
/** バス（daemon ライン）が要る = ラインが「master へ素通し」以外の何かを含む。 */
export function lineNeedsBus(elements: readonly LineElement[]): boolean {
  return elements.some(
    (e) =>
      e.kind === 'rack' ||
      (e.kind === 'output' && !(e.dest.kind === 'master' && !e.thru && e.db === 0)),
  )
}
```

`stageOutputElement`（`sequence.ts:476-492`）は `this._insertBus ?? (lineNeedsBus(...) ? ensure : undefined)` にする。instrument も同じ述語に従い、バスが無い間は `SetSourceRouting` の宛先（`none` / `master`）で実現する（§2.2.1）。instrument の `gain()` / `pan()` だけは今日どおり `ensureInsertBusForInstrument` が確保する（発音側の適用経路が無い・MX.1 注記と同じ理由）。

確度 **中**。反証: (a) B のもとで `kick.output()` の O0-1 RMS が `noBus` golden から動く（差分法で判る）。(b) 後から rack を足した時の「バス確保 → 全量 push → 発音側の中立化」で音が二重になる（既存 C4 と同型・`sequence.ts:378-388` の注記）— E2E-G / E2E-6 が既に押さえている。**(b) は A を選んでも同じ経路を通る**ので B 固有ではない。

### 2.4 `program()` の `[rack]` 前置は残す

`audio-line.ts:343-345` はラックの**位置マーカー**を前置する。これは routing ではなく「ラックが無い時の既定位置」で、daemon 側では plugin 未ロードの `Rack` op は no-op。#883 R3 の (i)/(ii) の分類では routing に当たらないので**維持**。ただし #883 は「`program()` == `elements`」と書いているので、**この 1 点だけは #883 の記述と異なる**（本書 §11 の残件 1）。確度 中。

### 2.5 LinkAudio 宛て

`output("Kick Ch")` はライン要素を作らず `_outputChannel` に記録する（`sequence.ts:602-603`）。§2.2 B の skip 述語は **`_outputChannel` が有れば出口あり**と扱う（LinkAudio 有効時は既存の skip が既に効いている・`:1874`）。出荷ビルドでは egress 無効（CLAUDE.md）だが engine の一貫性のため述語に含める。

### 2.6 🔴 横断規則 — 表現できない / 未設定 / 失われた routing は master ではなく**無音**に倒す（main 審査・指摘 4）

**規則（1 段落）**: routing 状態が「書かれていない」「表現できない（範囲外・未知の宛先）」「失われた（解放済み・未配線）」のいずれかである時、その信号は**どこにも加算されない**。master へ落とすことは、最下層に暗黙 master を作り直すことであり、A〜D を閉じた意味を消す。これは #883 の grand truth「テキストが完全な真実」を RT 層へ適用したものであり、TS 層には既に同じ規則がある — 610 裁定 6「**別の出力への沈黙のフォールバックはそれ自体が驚き**」（`sequence.ts:1846-1849`・LinkAudio 未宣言のシーケンスを hardware へ落とさず skip する）。master ラインの `Device` 以外の出口が `debug_assert` + **無音で捨てる**（`output.rs:1972-1976`）のも同じ向きである。**箇所ごとに直さず、この規則を全箇所へ一括で適用する。**

**適用対象外（「例外」ではない・owner 裁定 2026-09-11）**:

🔴 **master トラックは `global` が所有する。** `mix.sum` / `mix.aux` と違って宣言されるノードではなく、
ラックとゲインは `global.effect()` / `global.gain()` で指す（`global.ts:445` / `:608`）。
**`master.output(...)` という表面は作らない**ので、master の device 出口
（`default_master_line_ops` → 1,2・`output.rs:1106`）は設定できる値ではなく **定数**である
（owner 2026-09-11「マスターが 1、2 固定にしておかないと…デバイスの変更で困ってしまう」・
`docs/development/WORK_LOG.md:967`）。違う出力を master 相当に使いたい場合は **aux を作ってそちらへ集める**（owner 同日）。

🔴 **「除外」と書かないこと。** 規則は「**設定できるものが未設定なら無音**」であり、設定できない定数は
その定義域に入らない。「除外」と書くと規則に穴を開けたように読め、後から「これも除外でよいのでは」と
侵食される。**暫定ではなく確定**である（`master` をレシーバにする案は owner が 2026-09-11 に不採用と裁定）。

**適用箇所（一次ソースで列挙・2026-09-11）**:

| # | 箇所 | 今日 | 適用後 | 到達可能性（優先度は下げない）|
|---|---|---|---|---|
| (a) | `SourceDestCell::encode`（`output.rs:939-946`） | `Bus(_) \| Link(_)` の範囲外 → `Self::MASTER` | → **`None` のコード** + `debug_assert!(false)`（master ラインの `:1975` と同型）。newtype 化（検証済み `BusIndex`）は `SourceDest::Bus(usize)` の全 store 箇所（`engine_wrap.rs:3616,7657,7855,14701`）と `OutputDest::Bus(usize)`（`LineOp`）の両系統に及ぶので**採らない**（影響範囲が 4.0.0 の変更と釣り合わない） | 制御側は起動時に `total ≤ MAX_INSERT_BUS_STAGES` を検査する（`engine_wrap.rs:2305-2310`）ので**今日は制御のバグ経由でしか到達しない**。#663 でプールが伸びれば関係は変わる |
| (b) | `SourceDestCell::decode`（`:948-955`） | `_ => Master` | → `_ => None`（`None` のコードを**先に**照合） | 同上 |
| (b') | `SourceDest::default()`（`:907-913`） | `#[default] Master` | → `#[default] None` | instrument スロットの初期値（`default_source_dests()`・`engine_wrap.rs:3573`）= **今日の instrument の暗黙 master そのもの**（§0.1 D）|
| (c) | バス既定ライン（`output.rs:1573` `with_activation` / `engine_wrap.rs:2132` `default_bus_line_program`） | `legacy(Master, [])` = `[Rack, Output(Master)]` | → **`[Rack]`**（出口なし）。2 箇所を 1 関数に畳む | **今日到達する**（§0.1 C・`global.sum()` だけのバスに member が出すと `render_targets` 経由で post-loop が走り master へ加算 `output.rs:2453-2485`）|
| (d) | `FeedDest` 変換の `Bus(index)` で位置が無い時（`output.rs:2142-2146`） | `map_or(FeedDest::Hardware, …)` | → `FeedDest::Discard`（新 arm・feed を push しない） | `set_source_routing` は宛先バスを activate する（`engine_wrap.rs:7347`）ので通常は位置がある。無い = 状態不整合 = 無音が正しい |
| (e) | 同 `Link(_) => FeedDest::Hardware`（`:2147-2148`） | 「PR-3 まで total hardware fallback」 | → `Discard`。instrument → LinkAudio は TS で拒否済み（`sequence.ts:592-597`）なので到達しないが、**到達したら鳴るのではなく黙る**向きに揃える | 未配線 |
| (f) | instrument スロット解放時の `dest.store(Master)`（`engine_wrap.rs:7657,7855`） | 解放済みスロットが Master を指す | → `store(None)` | 解放済みなので音源は無いが、「失われた routing = Master」の形を残さない |

🔴 **(a)〜(f) の外にもう 1 箇所ある — legacy `SetBusRouting`**（束 S のレビュー round 1 で
Fable 監査が発見・2026-09-12）。daemon は今も `SetBusRouting` を受理し、`output` 省略かつ
override 未設定（sentinel 0）の時に `decode_bus_routing_sentinel(0).unwrap_or(BusTarget::Master)`
で `[Rack, Output(Master), sends]` を install する。**#852 以降 DSL のどの経路からも送られない**
（TS 側の `busRoutings` は空のまま）ので実害はゼロだが、**この規則に反する唯一の残り**である。

本 PR では触らない: 正しい翻訳が「拒否」と「出口なしの line」の 2 通りあり、DSL から到達しない
legacy 契約の意味論を、振る舞いを変える束の締めで決めるのは検算の機会に合わない。
**コマンドごと撤去すれば両方とも不要**になるので [#886](https://github.com/signalcompose/orbitscore/issues/886)
へ切り出した。

**(c) の依存の列挙（「依存がある」と書く前に grep した結果）**:

| 種別 | 実際 |
|---|---|
| cargo テスト（`output.rs`） | **1 本**: `tagged_event_with_unattached_bus_still_drops`（`:3896-3919`・`InsertBusStage::new("dry", None, 4)` に既定ラインのまま event を流し **hw = √0.5** を assert）。他に `unattached(` / `InsertBusStage::new(` / `with_activation(` を使う 8 関数は `with_line` / `with_output_target` / `settled(...)` で出口を明示するか（`render_tagged_line` `:4011` / `render_marking_target_after_first_output` `:4278`）、inactive の bit 一致（`render_block_all_inactive_buses_bit_identical`）/ topology 検証のみで、既定ラインの**宛先**には依存しない |
| cargo テスト（`engine_wrap.rs`） | **0 本**。seed テスト群（`:3428-3530`）は `old_ops` を明示して `line_republish_seeds` を直接呼ぶ。`start_outproc_both_with_options` はヘルパ |
| daemon 統合テスト（`rust/crates/orbit-audio-daemon/tests/*.rs`） | **0 ファイル**（sum / aux を使うファイルはすべて `SetBusLine` か `SetBusRouting` を送っている・grep）|
| production の定義 | **2 箇所**（`output.rs:1573` / `engine_wrap.rs:2132`。後者は shadow の seed 元 `:2142-2148` と `:7140` で使われる）|
| 旧 `SetBusRouting` 経路（`engine_wrap.rs:7311`） | `legacy_line_ops(output_target, …)` を**明示**して install するので影響なし。TS からは #852 以降どの DSL 経路も呼ばない（`rust-engine-player.ts:1012-1019`）|

→ 既定を `[Rack]` に変える**コストは 1 テストの期待反転 + 定義の畳み込み**であり、初稿の却下理由は成り立たない。seed への影響: 既定 shadow に `Output(Master)` が無くなるので、最初の `SetBusLine` の `Output(Master)` は seed 0 から ramp する（240 frames ≈ 5 ms @48 kHz・`output.rs:1367`）。今日は seed 1.0 から始まる（バスは既に master へ出ていた）が、**変更後はバスが無音だった状態からの立ち上がり**なので 0 が正しい。golden（8 発・4 s の定常 RMS）には乗らない。

**F2（宣言時 push の順序逆転）はこの適用で消える**: TS は宣言時に何も送らず、最悪の状態が「無音」になる。

確度 **高**（(c) の列挙は grep・(a)(b)(d)(e)(f) はコードの直読）。反証: (c) の既定を `[Rack]` にした状態で `cargo test --workspace` を回し、上記 1 本以外が red になる。

---

## 3. バス / 出力エンドポイント / master の扱い（設計項目 2）

| 受け手 | ラインを持つか | 本変更後に `output()` が**必要**か | 根拠 |
|---|---|---|---|
| audio / instrument シーケンス | 持つ | **必要**（無ければ無音） | §2 |
| **sum / aux バス** | 持つ（`MixerBusHandle` → `AudioLine`・`mixer-manager.ts:396-405`） | **必要**（推奨・main の推奨と一致） | 下記 |
| master | 持つ（daemon 側 `default_master_line_ops`）が **DSL にレシーバ表面を設けない**（裁定 6・§11）。ラックとゲインは `global.effect()` / `global.gain()` が指す（`global.ts:445` / `:608`） | **不要**（(i) ノードとして存在し、出口は**定数** 1,2。R3 で維持・規則の適用対象外 §2.6） | `runtime.ts:295-335` / `global.ts:445` |
| 物理アウトノード `mix.output(n, m)` | **持たない**（レシーバではない・`runtime.ts:325-329`） | 対象外 | — |
| render / LinkAudio | 宛先であって受け手ではない | 対象外 | — |

**sum / aux に `output()` を要求する理由**（代替との比較）:

| 案 | 内容 | 判定 |
|---|---|---|
| **要求する（採用）** | `global.sum("drums")` は宣言だけでは無音。`sum("drums").output()` で master へ | 規則が 1 つ。「バスだけ暗黙」を残すと**部分デフォルト**（R2 違反）。#883 が挙げる実害（sum に glue を挿しても dry が迂回）は**メンバー側**の暗黙が原因だが、バス側にも暗黙が残れば「sum → 別の sum」を書いた時に同じ迂回が再発する |
| バスだけ暗黙 master | sum / aux は今日どおり | 部分デフォルト。aux に glue を挿し `verb.output(drums)` を書いた瞬間に master への dry が消える不連続（P2 却下と同じ形）|
| aux だけ暗黙 | send-return の慣習に合わせる | kind で規則が割れる。MX.2.2「kind による宛先の制限は設けない」と逆行 |

**帰結（利用者向け文）**: ミキサーを使う譜面は `sum("drums").output()` / `aux("verb").output()` を **1 行ずつ**書く。学習コストは #883 の「一度経験すれば終わり」と同じ。確度 **高**。

---

## 4. `.output()` の引数省略 = master（設計項目 3）

- `Sequence.output(dest?: string | number | OutputDest, opts?)`: `dest === undefined` → `{ kind: 'master' }` として `applyOutputElement` へ（`sequence.ts:540-548` の先頭に 1 分岐）。現行の「non-empty destination」チェック（`:548`）は**引数が渡された時だけ**に限定する
- `MixerBusHandle.output(dest?)`（`mixer-manager.ts:336-346`）も同じ
- interpreter: `callMethod(receiver, 'output', [])` で届く（`process-statement.ts:263-274` は `args.length > 0` の時だけノード解決するので変更不要）。パーサは空引数を既に受理する（`global.start()` が空引数）
- 裸形 `kick.master`（SC.4 規範 (2)・`process-statement.ts:246-262`）は既に `{kind:'master'}` を作るので**同値の別表記**。spec に「`.output()` ≡ `.output("master")` ≡ `.master`」と 1 行書く
- **同じ束に入れるか**: **束 C（互換）に入れる。** 引数省略は加法的で既存の音を変えない。先に入れておくと、束 C の fixture / docs の移行が短い形（`.output()`）で書け、束 S で移行をやり直さない

確度 **高**。反証: `output()` の空引数が `assertOutputOptions`（`audio-line.ts:60-69`）に引っかかる — 引っかからない（`opts` は既定 `{}`）。

---

## 5. 診断・quick fix・補完（設計項目 4・5）

### 5.1 診断 — 静的解析（拡張）+ 評価時ログ（engine）の 2 層

| 層 | 何を | どこで | 出典（前例）|
|---|---|---|---|
| **編集時** | `init global.seq` で宣言され `.play(` を持つが**出口が 1 つも無い**シーケンスの `.play(` 位置に **Warning**・`code: 'output-missing'` | `diagnostics-analysis.ts` に `analyzeMissingOutput(text)` を新設。`analyzeLinkAudioMissingOutput`（`:338-429`）を**一般化して吸収**（LinkAudio 条件を外し、出口判定を広げる）。`extension.ts:3779-3786` の登録を差し替え | 610 §3.2（4 値）|
| **評価時** | スケジュール直前に `logSkipOnce(reason)`（`sequence.ts:1826-1832`）で 1 度だけ | §2.2 B の skip。MCP 経路（LLM）はここで気づく | #645 |

**「出口がある」の判定（誤検知を出さないために必須）**: 次の**いずれか**が同じ名前に対して現れれば出口あり —
`<name>.output(` / `<name>.send(` / `<name>.master`（裸形）/ `<name>.<宣言済み sum・aux 名>`（裸形・`(` 有無どちらも）/ `<name>.midi(`（対象外）/ ファイルが `global.linkAudio()` を宣言し `<name>.output("...")` がある（既存）。
🔴 裸形（`kick.drums` / `kick.verb(-12)`）を見落とすと、既存の `analyzeLinkAudioMissingOutput` の正規表現（`\.output\s*\(` のみ・`:388`）をそのまま使った時に**正当な譜面へ誤警告**する。`extractDeclaredBusNames`（補完が既に持つ）を再利用する。

#### 5.1.1 🔴 `send` だけのライン — `send(aux)` と `send(sum)` で**正しい振る舞いが逆**

本変更後、終端の無いラインの dry は master へ届かない。それが**正しいか誤りか**は宛先の種類で決まる:

| 宛先 | 慣習 | dry は master に**残るべきか** | 本変更後の `kick.send(x, db)` 単独 | 診断 |
|---|---|---|---|---|
| **aux**（センド・リターン） | dry + リターンを master で混ぜる | **残るべき**（残らないとリバーブだけが鳴る） | dry が消える = **たいてい書き忘れ** | **Information**・code `dry-not-routed`（下記）|
| **sum**（サミングバス） | メンバーは sum を**経由して**master へ | **残ってはいけない**（残ると glue を迂回する = #883 の実害） | dry が消える = **正しい** | **出さない** |

🔴 これが 611 §2.1 が「`output` が 1 つも無ければ暗黙」案を却下した時に**見落としていた場合分け**である（却下理由「send を書いた行の dry が master へ届かなくなる」は aux の慣習だけを見ていた）。spec（MX.3・SC.4 規範 (1)）にもこの表を写す。

**折衷の設計（main 審査・指摘 3）**:
- **aux 宛て `send` しか出口が無い**ライン → `.play(` 位置に **Information**（Warning ではない・煩さを抑える）・code `dry-not-routed`・文面 `Sequence 'kick' only sends to aux 'verb' — its dry signal is not routed. Add .output() after the send to keep the dry signal, or ignore if this is intended.`・**quick fix は §5.2 と同じ**（`kick.output()` を挿入）
- **sum 宛て `send` を 1 つでも含む**ライン（aux との混在を含む）→ 出さない。sum のメンバーであることが読める
- **裸バス形**（`kick.verb(-12)` / `kick.drums`）も同じ規則で分類する（aux 名メソッド = send・sum 名 = output・SC.4）
- 判定には宣言の kind が要る: `extractDeclaredBusNames(text, 'sum' | 'aux')`（補完が既に持つ）と `mix.sum` / `mix.aux` のノード宣言を両方見る。**kind が判らない名前**（import 由来など）は**出さない**（誤警告より沈黙を選ぶ・#638 の catalog 診断と同じ理由で Warning にしない）

代替（却下）: 「診断は出さず quick fix だけ」— VS Code の CodeAction は診断か選択範囲に紐づくので、診断なしでは発見性が無い。「Warning」— 正当な譜面（aux 専用のパート）を黄色にし続ける。

**重大度 = Warning（推奨）**。理由:
- 610 §3.2 の語彙で `error` は「その受け手では**書けない**・今日 throw する」。出口の無いラインは**正当な譜面**（パートを準備してから配線する・一時的に黙らせる）で、throw もしない
- `evaluate_orbitscore` は診断があれば `ok: false`（`mcp-server.ts:98-107`）。Error にすると LLM が正当な譜面を「失敗」と読む
- 既存の LinkAudio 版は Error だが、その根拠「runtime will throw」（`extension.ts:3776-3778`）は #645 で skip に変わって**既に古い**。本 PR で一般化する際に Warning へ揃える（§11 残件 2 で owner 確認）

文面（案）: `Sequence 'kick' has no output — it will be silent. Add .output() to route it to master, or .output("<bus>") / .send("<aux>", db).`

### 5.2 quick fix — 新表面（CodeActionProvider）

拡張には `CodeActionProvider` が**存在しない**（`grep CodeAction packages/vscode-extension/src` = 0 件）。`vscode.languages.registerCodeActionsProvider` を 1 つ新設し、`code === 'output-missing'` の診断に対して **`<name>.output()` を診断行の直後に 1 行挿入**する `WorkspaceEdit` を返す。
- 位置は「診断が付いた `.play(` 文の次の行」。ライン順 = 信号順（MX.1）だが、`output()` 単独行は「1 文 = 1 バッチ」（611-o-surface §3.1）なので位置で意味が変わらない
- 純関数 `missingOutputQuickFixEdit(text, issue): { line, insertText }` を `diagnostics-analysis.ts` に置き、provider はそれを `WorkspaceEdit` に写すだけ（unit で純関数を・vscode モックで provider を検証。`tests/vscode-extension/` に配置）

確度 **中**（挿入位置の UX は実機で触るまで断定しない）。

### 5.3 補完（設計項目 5）

`dsl-completion-context.ts:78-84` は `.output("` で **sum 名だけ**、`.send("` で aux 名だけを出す。変更:

| 文脈 | 候補 | 根拠 |
|---|---|---|
| `.output("` | **`master`** + 宣言済み **sum + aux**（aux 宛て output は正当・MX.2.1） | `resolveNamedOutputDest`（`audio-line.ts:134-146`）の解決順そのもの |
| `.output(`（引用符なし・識別子） | `master` + ミキサーノード変数（`var drums = mix.sum` 等） | `process-statement.ts:263-274` |
| `.send("` | 変更なし（aux + sum。`send` は sum も受ける・`sequence.ts:661-665`）| |
| 物理アウト対 `"3,4"` | **出さない** | デバイス ch 数を静的に知る手段が無い。誤った候補は無いより悪い |

---

## 6. 束の切り方（設計項目 6・`BUNDLE_BRANCH_WORKFLOW.md` §5.1）

§5.1「上限より先に**検算の機会**で切る — 振る舞いを変えない PR と変える PR を同じ束に入れない」に従い、**3 つ**に切る。

| 順 | 単位 | ブランチ | 中身 | 検算（これでしか問えないもの） | 概算（変更行）|
|---|---|---|---|---|---|
| **0** | main 直行（仕様だけ・§5.2） | `883-spec` | core MX.2 §2.1 の書き換え（暗黙終端の段落 `:1800-1808` を「出口は書かれたものがすべて」へ）/ SC.2.1 規範 (6) を (i)/(ii) に分けて書く / 611 §2.1 に撤回追記（却下理由が aux しか見ていなかった）/ MX.1 注記の更新 / `DESIGN_DISCUSSION_RECORD` に決定ログ 1 件 | 文書レビュー（advisor 相談の軽いレビュー） | 〜150 |
| **1** | 束 **X-compat** | `883-explicit-output-compat` | (a) `.output()` 引数省略（§4）(b) 補完（§5.3）(c) **全 fixture / examples / docs / gated inline 譜面 / unit 譜面に `.output()` を明示**（§7）(d) 実現の省略の述語 `lineNeedsBus`（§2.3・この束では**常に今日と同じ判定**になる = `output(master)` 単独ならバス無し）| 🔴 **既存 golden が 1 つも動かない**（D10）。`.output()` を足しても音が変わらないことは**この束でしか問えない**（束 2 では正当に変わる譜面が混ざる）| 〜900（docs 例が多い。1,500 を超えるなら docs を 1a・code を 1b に分ける）|
| **2** | 束 **X-semantics** | `883-explicit-output` | **S-0（束の先頭・単独の小 PR・🔴 一方通行）**: `SetSourceRouting.target` の明示 3 値（§2.2.1・Rust + TS 型 + cargo unit D13(b)）。続いて (a) `program()` の合成削除（A）(b) dispatch skip（B・`isNoteSequence()` の後ろ）(c) バス宣言時 push（C）(d) instrument の `none` / `master` 送出（D・バス確保なし）(e) 診断 2 種 + quick fix（§5.1-5.2）(f) 版 4.0.0 / DSL 2.0（§7.5）(g) 新 E2E X1〜X6（§8）(h) cargo unit D13(a) | 新 E2E が**実装前に red・後に green**（TDD を E2E に適用）。golden は束 1 で明示済みなので**動かない**（動いたら退行）。S-0 は wire 契約なので**束の先頭**（§5.1「一方通行の決定は束の先頭か単独に」）| 〜700 |

- 束 1 → 束 2 の順は**逆にできない**: 束 2 を先に入れると、`.output()` の無い golden fixture が全部無音になり「実装の誤り」と「fixture 未移行」が区別できない（§5.1 末尾と同じ理屈）
- R6「診断とセマンティクスは同じリリース」は束 2 が両方を持つことで満たす。タグ `v4.0.0` は束 2 マージ後
- 各小 PR は「その PR が足した E2E だけを実機で」（CLAUDE.md）。束 2 の X1〜X6 は**自己完結譜面**なので `-t` で絞れる

確度 **高**（規則の適用）。反証: 束 1 の gated で golden が動いたら、`.output()` の明示が音を変えている = §2.3 B の述語か既存実装のどこかに暗黙が残っている。

---

## 7. 移行（設計項目 7）— 既存 fixture / golden / E2E / docs の更新順と期待値

**原則**: 後方互換機構は入れない（R5）。譜面を**直す**。直す順序は束 1 の中で「テストが読む物 → 人が読む物」。

### 7.1 fixture（`tests/fixtures/mcp-e2e/`・12 本）

| fixture | 出口を持たないシーケンス | 変更 | golden への影響 |
|---|---|---|---|
| `kick_loop.orbs` | `drum` | `drum.output()` を足す | `noBus`（0.0846173）**不変**（§2.3 B・bit 同一クラス）|
| `output_line_gain_effect.orbs` | `dry` / `effectOnly` / `kick`（3 本とも） | 3 本に `.output()` | `sequenceGainWithEffect` の比は**不変**（`effectOnly`・`kick` はラック有りなので今日も既にバス経由。`dry` は B でバス無しのまま）|
| `output_line_gain_element.orbs` | `dry` | `dry.output()` | 比は不変 |
| `output_line_multi_send.orbs` | `dry`・`kick`・`off` | 🔴 **`kick` と `off` は `send` だけ** → 本変更後 dry が master へ**届かなくなる**。E2E-S / E2E-S0 の判定式 `total/dry = 1 + Σ` は「dry + sends」を前提にしている。**譜面側に `kick.send(...).output()` を明示**して式を保つ（`send` の後に `output()` を書く = 既定ストリップと同じ順）| 式不変 |
| `output_line_pan.orbs` | なし（3 本とも `output(drms)`）… ただし **`drms` バス自身に出口が無い** | `drms.output()` を足す（§3）| 不変 |
| `output_line_position_matters.orbs` | `kickA`・`kickB`（thru の send だけ）・`kickC`・**`verb611e6` バス** | 3 本に `.output()`（thru の後ろに）・`verb611e6.output()` | E2E-6 の式（`total_B/plain = 2g`・A は三角不等式）は「aux + master」前提なので**譜面に output を明示して初めて不変** |
| `output_line_republish_seed.orbs` | **`drums611e7` バス** | `drums611e7.output()` | 不変 |
| `output_line_send.orbs` | `dry`・`kick`（send だけ）・**aux `o0rev611`** | `dry.output()`・`kick.send(...).output()`・`aux("o0rev611").output()` | `send.dbTotalOverDry` 不変 |
| `output_line_sugar_equivalence.orbs` | `dry`・`kickA`・`kickB`・**aux `vA` / `vB`** | 同上 | 不変 |
| `output_line_sum.orbs` | **sum `o0sum611`** | `sum("o0sum611").output()` | `sumOutput` 不変 |
| `output_line_thru_db.orbs` | `dry`・**aux `verb`** | `dry.output()`・`verb.output()` | E2E-2 不変 |
| `diagnostic_case.orbs` | （診断専用・評価しない） | 変更なし | — |

🔴 **バス（sum / aux）の出口も全 fixture で明示が要る**（§3）。上表の太字がそれで、**今日は daemon の既定（§0.1 C）で鳴っている**。
🔴 **期待値は式で持つ規律（`output-line-expectations.ts`）を守る**: 束 1 では**式を 1 つも変えない**。もし実機で動く値が出たら、それは式ではなく**譜面の移行漏れ**（上表）か §2.3 の述語の誤りとして扱う。

### 7.2 gated spec の inline 譜面

`tests/e2e/orbitstudio-mcp-gated.spec.ts` には `LOOP(` が 34 箇所・`.play(` 24 箇所・`.output(`/`.send(` 13 箇所。**inline 譜面を 1 つずつ開いて出口を確かめる**（一括置換はしない — memory「一括置換はしない」）。`dry` 基準シーケンス（`:2132` `:2168` `:2234` `:2368` 周辺）は特に確認する。🔴 **`instrument(` を含む inline 譜面（#643 系 `captureInstrumentScenario` の呼び手）も対象** — §2.6 (b') で instrument の既定宛先が `None` になるので、`.output()` が無い instrument 譜面は束 2 で全滅する（F16）。束 1 で先に足しておく。

### 7.3 unit spec

| spec | 変わる期待 |
|---|---|
| `tests/core/audio-line.spec.ts:33-179` | `master()` を期待から外す（D1）— **束 2** |
| `tests/core/sequence-output-send-mixer.spec.ts:210-240` | `masterOutput(false)` を期待から外す — **束 2** |
| `tests/interpreter/signal-chain-dispatch.spec.ts:621-638` | 「暗黙 master と共存」のテスト名と注釈を「`master` は宣言なしに**ノードとして**存在する」に書き換え（振る舞いは同じ）— 束 0/1 |
| `tests/interpreter/mixer-runtime.spec.ts:219-233` | 「implicit master」の語を (i) の意味に直す — 束 0/1 |
| `tests/vscode-extension/playhead.spec.ts` / `tests/e2e/end-to-end.spec.ts`（`describe.skip`）等の inline 譜面 | 音を見ないので**変更不要**（出口の有無は判定に無関係）。ただし `diagnostics-analysis.spec.ts` は §5.1 の新 analyzer のテストを足す |

### 7.4 docs / examples（人が読む物・束 1）

`.play(` を含み `.output(` を 1 つも含まないファイル（2026-09-11 実測・`grep` による）:

| 種別 | ファイル |
|---|---|
| examples | `performance-demo.orbs`(24) / `07_audio_control.orbs`(17) / `08_timing_verification.orbs`(16) / `06_method_chaining.orbs`(12) / `05_drum_patterns_simple.orbs`(8) / `04_nested_rhythms.orbs`(7) / `03_polymeter_polytempo.orbs`(5) / ほか `01`・`02`・`22` 等 |
| user docs | `docs/user/ja/USER_MANUAL.md`(23) / `docs/user/en/USER_MANUAL.md`(14) / `docs/testing/PERFORMANCE_TEST.md`(8) |
| learning site（user） | `sites/user/{,en/}basics/audio-manipulation.md`(16) / `patterns.md`(10) / `multiple-sequences.md`(10) / `polyrhythm.md`(7) / `live-coding.md`(7) / `midi/pitch-dsl.md`(22・MIDI は対象外だが instrument 例は要確認) / `midi/voicing.md`(7) |
| learning site（dev） | `sites/dev/{,en/}orientation/architecture-overview.md`(5) |
| spec | `docs/specs-v2/PITCH_DSL_SPEC_v1.1.md`(11・MIDI 例なら対象外) / `docs/core/INSTRUCTION_ORBITSCORE_DSL.md`（33 play / 39 out — 個別に確認）|

方針: **例は短い形 `.output()` で直す**（`kick.audio("k.wav").play(...)` の行に `.output()` を足すのではなく、**宣言チェーンの末尾**か独立行 `kick.output()`）。learning site は ja / en を同時に。`sites/dev` の引用（`// file:start-end`）は `audio-line.ts` / `sequence.ts` を指すものが **0 件**（`grep "file:...audio-line.ts"` = 0）だが、束ごとに `npm run docs:check` を回す（memory: 引用チェックは言語ゲートと同列）。

### 7.5 版（束 2）

3.0.0 の bump（commit `7f40ff84`）が触った集合と同じ 10 ファイル: `CLAUDE.md` / `README.md` / `docs/core/INSTRUCTION_ORBITSCORE_DSL.md`（版表記）/ `WORK_LOG.md` / `packages/engine/src/version.ts:17`（`DSL_VERSION = '2.0'`）/ `packages/vscode-extension/package.json:6`（`4.0.0`）/ `sites/dev/{,en/}decisions/adr-002-dsl-v3-pivot.md` / `sites/dev/{,en/}orientation/architecture-overview.md`。`ENGINE_VERSION` は別軸で触らない（656 §4.4）。`version.ts:1-13` の注記に「4.0.0 = 暗黙終端の廃止」を 1 行足す。

---

## 8. E2E 表（設計項目 8）— すべて MCP 経由・capture の数値で判定

共通規律: `ok` に assert しない（`run-score.ts:250-275` が既にそうしている）・ERROR は `expectNoNewErrors`（`<=`）または `expectLogMarkerAtLeast`・capture したら `steadyRms`。譜面は `tests/fixtures/mcp-e2e/` に新規（バス名は一意）。

🔴 **「無音」の測り方**: `runScore` の `captureSegment` は**初回に `waitForSound`（床 0.01・20 s）で発音を待つ**（`run-score.ts:280-292`）ので、無音だけの譜面は測れない。したがって無音の判定は**差分法**で行う — 同じ譜面に**出口を持つ基準シーケンス `ref`** を置き、対象が漏れていれば RMS が**足し合わさって増える**ことで検出する。同じ素材を同じスロットで鳴らすので合流は coherent（`output-line-expectations.ts:163-166`）= 漏れれば **2 倍**。判別力は 1.0 vs 2.0 で、実機許容 0.12 に対して十分。

| # | 譜面（要点） | 判定式 | 許容 | 押さえる完了条件 |
|---|---|---|---|---|
| **X1** 出口を書かないラインは無音 | `ref.audio("kick.wav").play(1,1,1,1).output()` + `orphan.audio("kick.wav").play(1,1,1,1)`（出口なし）。`LOOP(ref)` `LOOP(orphan)` | `steadyRms / OUTPUT_LINE_GOLDENS.noBus.rms ≈ 1.0`（漏れれば ≈ 2.0）。かつ `expectLogMarkerAtLeast(client, before, /orphan.*has no output/, 1)` | ±0.12 | D2 |
| **X2** `.output()` ≡ `.output("master")` | 譜面 A `kick.output()` / 譜面 B `kick.output("master")`（各 1 本・`kick_loop` 型） | `\|A/B − 1\| <= 0.02`（同一セッション再現性の既知値）かつ `A ≈ noBus.rms` | 0.02 / ±0.12 | D3 |
| **X3** sum サミングで dry が漏れない | `global.sum("s883")` + `kick.send("s883", -6)`（**出口なし**）+ `sum("s883").output()` + 別譜面 `plain`（`kick.output()`） | `send/plain ≈ 10^(-6/20) = 0.501`（dry が漏れれば `1 + 0.501 = 1.501`） | ±0.12 | D4（#883 の実害そのもの）|
| **X4** 宣言だけの sum は無音 | `ref.output()` + `global.sum("s883b")` + `kick.output("s883b")`（バスに出口なし） | `steadyRms ≈ noBus.rms`（バスが daemon 既定で master へ漏れれば ≈ 2.0 倍） | ±0.12 | D5（§0.1 C）|
| **X5** 出口を書かない instrument は無音・`.output()` はバス無しで鳴る | 既存 `captureInstrumentScenario`（`orbitstudio-mcp-gated.spec.ts:993-`）の harness で、A: `inst.output()` 有り → `expectSegmentsSounding` **かつ `get_engine_state` / ログに `seq-bus-` の確保が無い**（`expectLogMarkerAtLeast` の否定は使えないので、`SetBusLine` を送っていないことは unit D6 で固定し、E2E は音だけを見る）、B: 無し + `ref` audio シーケンス（発音待ち用）→ 区間 RMS が `ref` 単独と一致 | A: 可聴窓 ≥ 0.9 / B: ±0.12 | D6（§0.1 D・§2.2.1）|
| **X6** 診断 | fixture `output_missing_case.orbs`（`orphan` / `ref` / `sendAux`（aux 宛て `send` だけ）/ `sendSum`（sum 宛て `send` だけ）/ `bare`（`kick.master` 裸形））→ `open_file` → `get_diagnostics(path)` | `warning` + `code === 'output-missing'` が **`orphan.play(` の行に 1 件**・`information` + `code === 'dry-not-routed'` が **`sendAux.play(` の行に 1 件**・`ref` / `sendSum` / `bare` は 0 件。**評価はしない**（E2E-D1 と同じ「開くだけ」）| 件数は `>=1` と `=== 0`（診断は log 由来ではないので等号可）| D7 |
| **X8** #282 の再発防止（実機） | `global.linkAudio()` **無し**の譜面に `melody.midi("iac", 1).play(...)`（出口なし）+ `ref.output()` | `run_selection` 後、`get_log` に `melody` の skip 行が**現れない**（`countLogMarker(...) === 0` は log 由来の等号なので不可 → `expectNoNewErrors` の枠で「skip 文言を含む新規 ERROR 行が 0」を `newErrorLines` のフィルタで見る）| — | D2b |
| **X7**（束 1）既存 golden 不変 | 新規譜面なし | O0-1〜4・E2E-2〜P・E2E-7 が全件緑 | 既存 | D10 |

- X1 / X4 / X5 の「無音」は**ログを唯一の oracle にしない**（`gated-assertion-hygiene.spec.ts:573`）— 必ず RMS の差分で判定し、ログは補助
- 新しい語彙は無い（`output` は covered 済み・`dsl-e2e-coverage.spec.ts`）。baseline は増やさない

---

## 9. 失敗モード（設計項目 9）— この変更が**新しく**導入しうる故障

| # | 故障 | 起き方 | 検出 / 対策 |
|---|---|---|---|
| F1 | **skip 述語の抜け**で出口の無いシーケンスが鳴る | `scheduleEvents` / `scheduleEventsFromTime` / `run()` / `loop()` の 4 経路（`sequence.ts:1787,1900,1946,1994`）のうち 1 つが述語を通らない | X1 が捕まえる。述語は `resolveDispatchChannel()` の**中**に置き、呼び出し元は増やさない |
| F2 | ~~バス宣言時 push と `drums.output()` push の順序逆転~~ | **消滅**（§2.6 (c)）: TS は宣言時に何も送らず、daemon 既定が無音。順序が狂っても**最悪が無音**で、master へは落ちない | — |
| F3 | **`[rack]` だけの program を daemon が拒否**し、push 失敗 → stale | `set_bus_line`（`engine_wrap.rs:6980-7008`）・`parse_set_bus_line_params`（`session.rs:306-354`）・`install`（`output.rs:1240-`）に「出口必須」の検証は**見当たらない**（grep）が、未実証 | **D13 の cargo unit を実装より先に書く**。§2.6 (c) 適用後は拒否されても既定が無音なので**漏れない**（向きが変わる）。受理させるのは規則のため（既定と同じ形を送れないのは不整合）|
| F4 | instrument の即時バス確保で **9 本目の `instrument()` が throw**（今日は gain/pan 時に throw） | §2.2 D | 故障の**位置が早まるだけ**で新規ではない。エラー文言に「instrument はバスを 1 本使う（上限 8）」を含める。上限の引き上げは別 issue（§11）|
| F5 | 診断の**誤警告**（裸形 `kick.drums` / `kick.verb(-12)` を出口と認識しない） | §5.1 の判定が `\.output\(` だけ | unit に裸形・send-only・LinkAudio の**負例**を置く。X6 に `bare` を含める |
| F6 | quick fix の挿入位置が**ライン順の意味**を壊す | `output()` を rack の前に入れると thru の意味が変わる…が、`output()` 単独行は独立バッチ（1 文 = 1 バッチ）で終端の既定位置（`defaultRank` 4・`audio-line.ts:148-159`）に入る | 位置の意味は変わらない。unit で「挿入後の program が `[..., output(master)]` で終わる」ことを確認 |
| F7 | 束 1 で **`lineNeedsBus` が今日と違う判定**をし、golden が動く | 例: `output(master, db: 0)` を書いた譜面が今日はバス経由 → B ではバス無し → 音は同じはずだが bit は違う | D10（golden ±0.12）で捕まる。bit 一致は主張しない |
| F8 | `evaluate_orbitscore` の `ok` が **Warning で false になる** | `mcp-server.ts:98-107` は「診断があれば `ok:false`」— 実装が severity を見ていない可能性 | X6 で `run_selection` 後の `ok` を**観察**し（assert はしない）、Warning で false になるなら severity で分ける小修正を束 2 に含める |
| F9 | `_busLineStale` の再送（`sequence.ts:1953,2001`）が**出口の無いライン**を送り、意図せず `[rack]` を daemon に押し付ける | 無害（無音のまま）。ただし skip 済みシーケンスにバスは無い | — |
| F10 | LinkAudio 有効ファイルで `output("Kick Ch")` のシーケンスが **X1 の述語で skip** される | §2.5 の `_outputChannel` を述語に含め忘れ | unit `resolveDispatchChannel()` の LinkAudio 既存テスト（`tests/core/sequence-output.spec.ts:249-`）が守る |
| F11 | **#282 の再発**: skip を `isNoteSequence()` の早期 return より前に置き、`.midi()` が無音になる | `run()` / `loop()` は MIDI でも `resolveDispatchChannel()` を eager に呼ぶ（`sequence.ts:1946,1994`） | D2b の unit + X8。設計は「後ろに置く」と明記（§2.2 B）|
| F12 | **`SourceDestCell::decode` のフォールバック**（`output.rs:948` `_ => Master`）が `None` のコードを master へ読み替え、出口を書かない instrument が**鳴る** | encode に `None` を足し decode に足し忘れる / `END` のコードと衝突 | D13(b) の RT unit で `store(None)` → `load() == None` を往復で固定。`decode` の `_` arm は `None` を**先に**照合する |
| F13 | **instrument の source routing と `SetBusLine` の順序**: `.effect()` でバスを確保した時、`SetSourceRouting {bus}` が届く前に `{master}` のままの 1 block が鳴る（今日も同じ窓がある） | 今日の `ensureInstrumentSourceRouting` と同型 | 新規ではない。dedup キーを宛先キーへ一般化する際に「宛先が変わったら必ず再送」を unit で固定（`toHaveBeenCalledTimes(n)`・宛先の引数まで検証）|
| F14 | 診断 (b) `dry-not-routed` の **kind 誤判定**（aux と sum の同名宣言・`ambiguousMessage` `mixer-manager.ts:301-303`）| 同名が両 kind に在ると裸形の解決自体が loud エラー（SC.2.1 規範 (8)）| kind が一意に決まらない名前は**出さない**（§5.1.1）。unit に同名両宣言の負例 |
| F15 | **`FeedDest::Discard` で feed を push しないと、source の出力バッファが消費されず次 block へ持ち越す**（§2.6 (d)(e)） | `render_multi` 系が「event を必ず消費する」契約（`InsertBusStage` の doc `output.rs:1519-1522`）を source feed にも持っているか未確認 | 実装時に `collect_source_feeds` の呼び手を読み、Discard でも `slot.source.render()` は走る（出力は読まれないだけ）ことを RT unit で固定（`active_count` / 出力長の assert）|
| F16 | **`SourceDest::default() = None` に変えた結果、instrument が `.output()` を書くまで鳴らない**のは仕様どおりだが、**既存 gated E2E（#643 系 `captureInstrumentScenario`）の inline 譜面が `.output()` を書いていない**と全滅する | §7.2 の inline 譜面監査の対象に instrument 譜面を明示していなかった | §7.2 に「`instrument(` を含む inline 譜面は必ず `.output()` を足す」を追記（束 1 で実施）。束 1 の gated 全件緑（D10）が守る |

---

## 10. spec / 設計文書の改訂（束 0・実装より先・運用規則 6）

| 文書 | 箇所 | 改訂 |
|---|---|---|
| `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` | MX.2 `:1800-1808`（暗黙終端の段落） | 「出口は書かれたものがすべて。出口の無いラインは無音。`.output()` = `output("master")` = `.master`」に置換。🔴 の「条件は output が 1 つも無いではない」段落は**削除**（暗黙が無いので条件自体が消える）|
| 同 | MX.1 注記 `:1770-1776` | 「daemon にラインを持たない audio シーケンス」の記述を §2.3 B（実現の省略）に合わせる |
| 同 | MX.2.1 `:1817-1830` | `master` 行に「宛先として書かれた時だけ受け取る」|
| 同 | MX.3 | `kick.send(verb, -12)` の例に「これだけでは master へは行かない。`.output()` を続ける」を 1 行 |
| `docs/specs-v2/SIGNAL_CHAIN_DSL_SPEC_v1.md` | SC.2.1 規範 (6) `:78` | 「暗黙 master(1,2) を持つ」→「master **ノード**は宣言なしに存在する（(i)）。ラインへの自動ルーティング（(ii)）は無い（#883・DSL 2.0）」。決定 #75 の意味を (i) に限定 |
| 同 | SC.4 規範 (2) | `.master` 裸形 = `.output()` と同値 |
| 同 | 🔴 **SC.2 規範 (4) `:80`** | **今日の記述が裁定 6 と逆**（「出力エンドポイント（`mix.output(...)`）と**マスターもレシーバである**」「master も宛先を持てる 1 レシーバ」・例 `master.output(cue, thru: true)`）。→ 「**master トラックは `global` が所有する**。ラックとゲインは `global.effect()` / `global.gain()` で指す。`master.<...>` というレシーバ表面は設けない。出力エンドポイント（`mix.output(...)`）はレシーバではない（`runtime.ts:325-329` と一致）」へ書き換え。**この行を落とすと仕様と実装が逆を向いたまま残る** |
| `docs/design/611-output-line-design.md` | §2.1 `:83-87` / §2.6 既定ストリップ | 撤回追記: 「却下理由は aux（send-return）しか見ておらず、sum（サミング）では dry が届かない方が正しい場合分けが視野に無かった（#883）」。§2.6 の既定ストリップから `output(master)` を外す |
| `docs/specs-v2/DESIGN_DISCUSSION_RECORD.md` | 決定ログ | 1 件追加（P2 却下理由 = 不連続）|
| `docs/planning/DEVELOPMENT_MAP.md` | §3 注記・§4.A | 凍結線の前提が崩れた事実と、4.0.0 が凍結版になることを**事実が変わった瞬間**に書く（§5.1b）|
| `docs/planning/IMPLEMENTATION_PLAN_2026-09.md` | §2.5 表 | 束 X-compat / X-semantics を追加 |
| `docs/user/ja/USER_MANUAL.md` ほか §7.4 | 例 | `.output()` を明示 |

---

## 11. 裁定（owner 2026-09-11・**全 6 件確定。再議論しない**）

| # | 論点 | 裁定 |
|---|---|---|
| 1 | `program()` の `[rack]` 前置 | ✅ **残す**（§2.4）。ラックの位置マーカーは routing ではないので (ii) の対象外。#883 本文の「`elements` に畳む」はこの 1 点だけ不正確（issue にコメント済み） |
| 2 | 診断 (a) `output-missing` の重大度 | ✅ **Warning**（§5.1）。Error は `evaluate_orbitscore` の `ok:false` と衝突する（F8） |
| 3 | 診断 (b) `dry-not-routed` の重大度 | ✅ **Information**（§5.1.1）。aux 宛て `send` だけのラインに出す / sum 宛てと kind 不明には出さない |
| 4 | `SetSourceRouting.target` を明示 3 値へ（`null` = 暗黙 master を wire から消す） | ✅ **変える**（§2.2.1・一方通行）。instrument を固定上限に依存させずに (ii) を閉じる唯一の経路。利用者は owner のみ（memory「wire 破壊は安い・仕様の見落としが高い」） |
| 5 | 実現の省略（B・instrument を含む） | ✅ **採る**（§2.3）。DSL の規則ではなく実装の実現規則。`outs:` は unit ごとに宛先を持つので将来と衝突しない |
| 6 | §2.6 の規則と master の関係 | ✅ **master は `global` が所有する**（§2.6）。`master.output(...)` / `master.effect(...)` という表面は**作らない**。ラックとゲインは `global.effect()` / `global.gain()` のまま。したがって master の device 出口は定数であり、規則の**適用対象外**（「除外」ではない） |

### 裁定 6 の根拠（owner 逐語・2026-09-11）

> マスタートラックは global が持っている、でいいのでは？

> 違う output(3,4) をマスターに使いたくなったら、そういう aux を作ってそっちに皆が送ればいいだけ

**採った理由**（main の審査）: (1) master は `mix.sum` / `mix.aux` と違い**宣言されるノードではない**ので、
`global.tempo()` / `global.beat()` と同じ家族と見るのが素直。(2) `master` は SC.2.1 規範 (7) で
**出力エンドポイント専用の予約名**なので、裸のレシーバにすると同じ語が 2 つのものを指す。
(3) マスタリングは今日すでに `global.effect(["Comp", Gain(db: -3), "Limiter"])` で書ける
（`global.ts:445`・PH.2）ので機能の不足が無い。ゲインの位置も標準プラグイン `Gain` をラック内に置けば自由。

🔴 **この裁定は spec と逆を向いている箇所がある。**`SIGNAL_CHAIN_DSL_SPEC_v1.md` SC.2 規範 (4) は
今日「出力エンドポイントとマスターも**レシーバである**」「master も宛先を持てる 1 レシーバ」と書いている。
**束 0 で書き換える**（§10）。放置すると仕様と実装が逆を向いたまま残る
（memory `one-layer-of-the-spec-lags-the-ruling`）。

---

## 12. 確信度と反証方法

| 判断 | 確度 | 何を見れば誤りと分かるか |
|---|---|---|
| 暗黙 master の実体は 4 箇所（§0.1） | **高** | `program()` だけ変えて `kick_loop.orbs` が無音になる / `global.sum` 宣言だけのバスが無音になる |
| `.output()` 必須化 + 現行実装 = 9 本目で throw（§0.2） | **高** | `BusPool.acquire` の上限が別経路で回避されている |
| dispatch skip で B を閉じる（§2.2） | **高** | `resolveDispatchChannel` を通らない発音経路がある（4 経路以外）|
| 宣言時 push で C を閉じる（§2.2） | **中** | F2 の順序逆転が実機で起きる / F3 で daemon が `[rack]` を拒否する |
| `SetSourceRouting {none}` / `{master}` で D を閉じる（§2.2.1・バス確保なし） | **中** | `FeedDest` に「捨てる」相当が 1 arm で足せない（`output.rs:2100-2200` を実装時に読む）/ `SourceDestCell::decode` の `_ => Master` が `None` を吸う（F12・RT unit の往復で固定）/ `.output()` 後に plugin 出力が master へ**二重**に届く経路がある（X5-A の RMS が `ref` の 2 倍なら誤り）|
| skip は `isNoteSequence()` の後ろ（§2.2 B・#282） | **高** | D2b の unit が red / X8 で MIDI シーケンスに skip 行が出る |
| §2.6 (c) バス既定を `[Rack]` にしても壊れるのは 1 テスト + 定義 2 箇所 | **高**（grep で列挙） | `cargo test --workspace` で `tagged_event_with_unattached_bus_still_drops` 以外が red |
| §2.6 (d)(e) `FeedDest::Discard` が 1 arm で足せる | **中** | `collect_source_feeds` の呼び手が「feed の数 = unit の数」を前提にしている（`MAX_SOURCE_FEEDS` の ArrayVec を index で読む等）→ Discard を「push しない」ではなく「push するが加算先なし」にする |
| §2.6 (b') `SourceDest::default() = None` が instrument の暗黙 master を閉じる | **中** | `default_source_dests()` 以外に Master を書き込む初期化経路がある（`engine_wrap.rs:3573-3676` のテスト群で `Master` を期待する行が反転後も緑なら、別経路が Master を書いている）|
| 固定上限への依存を増やしていない（§2.3a） | **高** | D6b の unit で `BusPool.acquire` が `.output()` 単独か出口なしで呼ばれる |
| 実現の省略 B（§2.3・instrument を含む） | **中** | X2 で `kick.output()` の RMS が `noBus` golden から ±0.12 を超えて動く / 後から rack を足した時に二重（E2E-G・E2E-6）|
| `send(aux)` = dry が残るべき / `send(sum)` = 残るべきでない（§5.1.1） | **高**（慣習の記述） | owner が「aux でも dry を落とすのが既定」と裁定する — その場合 (b) の診断は丸ごと不要 |
| (b) の診断を Information にする（§5.1.1） | **低** | 実機で触って気づけない（Information は VS Code で点線表示・問題パネルに出るが目立たない）→ Warning へ上げる。逆に aux 専用パートで煩ければ code 単位で抑制できる設定を足す |
| sum / aux にも `output()` を要求（§3） | **高** | owner が「バスは暗黙でよい」と裁定する（規則の問題であって事実の問題ではない）|
| daemon は出口の無い program を受理し無音にする（F3・D13） | **中**（grep による不在） | D13 の cargo unit が red |
| 診断は静的（拡張の regex analyzer）で足りる（§5.1） | **中** | 裸形・import された宣言（`import { drums } from`）を regex が追えない → 誤警告。その場合は #610 の engine パーサ経路（未実装）へ移す |
| 束を 0 / 1 / 2 に切る（§6） | **高** | 束 1 の golden が動く（暗黙の残り）|
| 3.0.0 と同じ 10 ファイルの bump（§7.5） | **高** | `git show --stat 7f40ff84` と差分 |

---

## 付録 A — 読んだ一次ソース（本書の主張の出典）

- `packages/engine/src/core/sequence/audio-line.ts` `:1-423`（`program()` `:333-347`・`upsert` `:264-323`・`resolveNamedOutputDest` `:134-146`・`defaultRank` `:148-159`）
- `packages/engine/src/core/sequence.ts` `:360-780`・`:813-838`・`:896-1010`・`:1787-1832`・`:1856-1926`・`:1945-1960`・`:1995-2005`・`:2150-2175`
- `packages/engine/src/core/global.ts` `:460-530` / `global/sequence-effect-manager.ts` `:29-104` / `global/effect-slot.ts` `:985-1011` / `global/mixer-manager.ts` `:44,280-420`
- `packages/engine/src/signal-chain/runtime.ts` `:213-335` / `interpreter/process-statement.ts` `:235-290` / `version.ts`
- `packages/vscode-extension/src/diagnostics-analysis.ts` `:338-429` / `extension.ts` `:3345-3570,3700-3830` / `dsl-completion-context.ts` `:55-95` / `mcp-server.ts` `:98-107,820-838`
- `rust/crates/orbit-audio-native/src/output.rs` `:1106-1140,1240-1345,1540-1600,1855-1990,2540-2590` / `orbit-audio-daemon/src/engine_wrap.rs` `:2025-2065,2196-2199,6980-7160` / `session.rs` `:306-354,455-530`
- docs: core MX `:1740-1910` / SC spec `:66-220` / 611 `:60-160,766-842` / 611-o-surface §7-8 / BUNDLE §5.1 / 656 §4.4 / NATIVE_MIGRATION §12 / PLAN §2.5 / MAP §3
- tests: `audio-line.spec.ts` / `sequence-output-send-mixer.spec.ts:205-245` / `signal-chain-dispatch.spec.ts:615-640` / `mixer-runtime.spec.ts:215-262` / `output-line-expectations.ts` / `orbitstudio-mcp-gated.spec.ts:965-1000,5440-5520` / `helpers/run-score.ts:230-300` / `helpers/capture-windows.ts` / `helpers/engine-log.ts` / `gated-assertion-hygiene.spec.ts:553-652` / fixtures 12 本
