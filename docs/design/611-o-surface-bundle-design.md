# #611 束 O-surface（PR-O4）の実装設計 — 凍結線の束

**Issue**: [#611](https://github.com/signalcompose/orbitscore/issues/611)（出口の一般化）/ [#827](https://github.com/signalcompose/orbitscore/issues/827)（凍結線）
**正本の上位**: [`611-output-line-design.md`](611-output-line-design.md)（doc 611・設計）/ [`NATIVE_MIGRATION_2026-09.md`](../planning/NATIVE_MIGRATION_2026-09.md) §12（裁定）/ [`IMPLEMENTATION_PLAN_2026-09.md`](../planning/IMPLEMENTATION_PLAN_2026-09.md) §1.1 PR-O4 行・§2.5
**起案**: 2026-09-10（Fable・effort high）/ **前提コード**: main `58f558f5`（PR #828 マージ後）。行番号はすべてこの commit での実読値
**位置づけ**: doc 611 が持たない「束としての PR 分割・各 PR の完了条件・未決 2 件の裁定案・E2E の具体」を埋める。**doc 611 §0 / §14・§12 の裁定は再設計しない**。改善案は §13 に隔離

---

## 0. 結論（状態: ✅ **owner 裁定 3 件すべて済み 2026-09-10** + main 審査済み）

| 問い | 結論 | 節 |
|---|---|---|
| 束は 1 つか 2 つか | **2 束**。**O-surface-rt**（Rust wire + RT・goldens 不動で検算・約 750 行）→ **O-surface**（TS DSL + E2E・goldens が式どおり動く・約 2,000 行）。後者は 1,500 を超えるので、超過分の扱いを §2.3 に書く | §2 |
| F1 フレーム（`//#evalBegin/End`） | **凍結版には入れない**。バッチ = **1 文（メソッドチェーン）** とし、E2E-6 は文内チェーンで成立させる。選択範囲単位のバッチは新ライン PR-L2 | §3.1 |
| F2 `SetGlobalGain` の master line への写し | **写さない**。`global.gain()` は atomic のまま。master line の TS 表面（doc 611 §3.5 / §3.7）も凍結版では作らない | §3.2 |
| 🔴 依頼文に無かった問題 1 | **`SetBusLine` の再 publish で実効ゲインが 1.0 から再開する**（`output.rs:1012-1044`）のは `SetGlobalGain` に限らない。TS が `SetBusLine` を送り始めた瞬間に**演奏中のすべての `output()` / `send()` / `gain()` 再評価がポップを出す**。引き継ぎ機構は F2 と無関係に**本束の必須要件** | §4.3 |
| 🔴 依頼文に無かった問題 2 | `seq.gain(固定)` / `seq.pan(固定)` を無条件にライン要素にすると、**insert bus プールが 8 本**（`sequence-effect-manager.ts:29` / `engine_wrap.rs:2032`）なので **9 本目のシーケンスで throw する**。`examples/07_audio_control.orbs` は 17 シーケンス・28 `gain()`。バス無しシーケンスでは発音側適用を保つ（音は同値） | §5.2 |
| 依頼文に無かった問題 3 | doc 611 §3.2 の擬似コード規則 2 に**カーソルの off-by-one**がある（`[rack, gain, output]` に `gain().effect()` を再評価すると `[gain, output, rack]` になる） | §5.1 |

---

## 1. 依頼文 §3 の事実 F1〜F8 の検算（実読）

| # | 依頼文の主張 | 実読の結果 | 判定 |
|---|---|---|---|
| F1 | `//#evalBegin` 未実装。バッチ無しだと E2E-6 が成立しない | `grep evalBegin` 0 件。REPL は行ごとに `executeCurrentBuffer` を呼ぶ（`repl-mode.ts:519-521`）ので**1 文 = 1 execute** は今日でも成立。doc 611 §3.2 の「バッチ外 = 既定位置へ挿入」で `output(verb,thru).effect()` を評価すると rack が先頭へ入り `[rack, output verb]` になる → E2E-6 不成立は**正しい**。ただし**文（チェーン）をバッチにすれば成立する**（§3.1） | 成立（ただし解は別） |
| F2 | 写しの ramp 引き継ぎ機構が未設計 | `LineProgram::new` は全 op 1.0 開始（`output.rs:1012-1014, 1022-1044`）。`SetGlobalGain` は atomic のみ（`engine_wrap.rs:9485-9488`・`ramp_sec` 未使用）。写しは不要だが**機構自体は必要**（§0 問題 1） | 成立・帰結は拡大 |
| F3 | `pan` op と mono `device` は TS 型・daemon parse に無い。RT に mono マージはあり Pan は無い | `daemon-client.ts:86-96`（`channels: [number, number]`・`pan` 無し）/ `session.rs:385-388`（`len() == 2` フィルタ）/ `output.rs:2082-2091`（mono マージ実装済み）/ `output.rs:1316-1320`（Pan 拒否）`:1834` `:2287`（no-op） | 成立 |
| F4 | respawn replay は旧 wire を再送 | `rust-engine-player.ts:790-794` の順序、`reapplyBusRoutingAfterRespawn :1011-1023`（`SetBusRouting`）/ `reapplyGlobalGainAfterRespawn :1062-1075` | 成立 |
| F5 | link の error code が warn-once と噛み合わず静かに落ちる | **否定（現行コードは整合している）**: `registerLinkAudioChannel`（`:946-963`）は `LINK_AUDIO_UNAVAILABLE` だけを warn-once し、daemon もその code を返す（`session.rs:2919-2921`）。噛み合わないのは**これから書く `setBusLine` に同じ warn-once を写した場合**: `SetBusLine` の `dest.link` は今日 `LINK_AUDIO_UNAVAILABLE` で拒否され（`engine_wrap.rs:6738-6745`）、拒否は**全か無か**なので line 全体（master 出口を含む）が落ちる。§5.6 で規則として塞ぐ | 否定（罠は実在） |
| F6 | `per_channel` 実装済み | `mcp-server.ts:1014-1036` / `wav-analysis.ts:132,188` / helper `channelRms`（`capture-windows.ts:697-707`）| 成立。**ただし本機の出力デバイスは 2ch のみ**（`--list-audio-devices` 実測 2026-09-10: `MacBook Proのスピーカー` 2ch / `Pro Tools Aggregate I/O` 2ch・BlackHole 無し）→ ch3/4 の E2E は skip 条件付き（§8.3） |
| F7 | 既知の赤 = `steps the live playhead`・#775 は消えた可能性 | gated spec `:2437` に実在。#775 の消滅は本書では確認していない（実機は main が回す） | 保留 |
| F8 | 概算 1,200 行は超える | 束 O-wire-b の実測は **code 1,255 / 全体 3,157**（`git diff --shortstat 183b6125^1 183b6125`: 33 files, +2,373 −784。うち docs / sites が約 1,900）。本束の見積は §2.2 | 成立 |

---

## 2. 束の構成

### 2.1 推奨: 2 束（検算の機会で切る・BUNDLE §5.1）

```
束 A  O-surface-rt   統合ブランチ 611-surface-rt   ← main
   PR-A1 🔴 wire: mono device + pan op（Rust parse/validate + TS 型のみ）  ← 一方通行・先頭
   PR-A2    RT: Pan 実行 + 実効ゲイン引き継ぎ（seed）+ 拒否解除            ← 可逆（内部）
   検算: OUTPUT_LINE_GOLDENS / O0-1〜O0-4 が 1 つも動かないこと + cargo（TS はまだ SetBusLine を送らない）

束 B  O-surface      統合ブランチ 611-output-line   ← main（束 A マージ後）
   PR-B1    TS 配線: AudioLine + Sequence/Global/MixerBusHandle を SetBusLine へ + respawn replay
            （DSL 表面は不変・program は今日の形）  小 PR ゲート = O0 goldens 不動 + E2E-10
   PR-B2 🔴 DSL 表面: output(dest, thru:, db:) / send dB / pan 要素 / mono / 名前付き引数 / 解決順
            小 PR ゲート = E2E-2〜7・E2E-P・E2E-D（§8）を実機で
   PR-B3    docs: spec「v1 の現在地」注記・doc 610 行・coverage baseline・WORK_LOG
   検算: goldens が §7 の式どおりに動く（O0-3 のみ動く・他 3 本は不動）
```

**なぜ A を分けるか**: 束 A は TS から呼ばれない（`setBusLine` の呼び出し元は今日ゼロ・`grep` で `daemon-client.ts:716` の定義のみ）。したがって **A の検証は「goldens が動かないこと」で済み、B と同じ束に入れるとその検算は永久に失われる**（O3a/O3b と O4 を分けたのと同じ理由・doc 611 §12 引用ブロック）。A の RT 変更（Pan 実行・seed）は `SetBusRouting` 経路の `LineProgram::legacy`（`output.rs:1046-1066`・`settled`）に触れないので、既存譜面は bit 一致のまま。

**なぜ B の中を B1 / B2 に割るか**: B1 は「`SetBusRouting` → `SetBusLine` の配線入れ替え」で、program は今日と同じ `[rack, output(sum|master, thru: sends>0), sends…]`（`output.rs:1046-1066` と同形）。**小 PR ゲートで O0 が不動であることを確かめてから** B2 で表面を変える。B2 で O0-3 が動いた時、それが配線の誤りか dB 化の誤りかを B1 のゲート結果で切り分けられる。

### 2.2 小 PR の列と概算（変更行 = `+`と`-`の合計・BUNDLE §5.1）

| PR | 触るファイル | 概算 | 一方通行 |
|---|---|---|---|
| **A1** | `session.rs`（`parse_set_bus_line_dest` `:373-425` mono 受理・`pan` op 追加・`validate_set_bus_line_device_channels` `:427-453`）・`engine_wrap.rs`（`BusLineOp :2097` に `Pan`・`BusLineDest::Device{right: Option}`・`device_dest_from_wire :6711-6719`・`set_bus_line :6753` の解決）・`daemon-client.ts:86-96` 型・cargo/vitest test | 約 300 | 🔴 wire |
| **A2** | `output.rs`（`validate_line_program :1316-1320` 解除・`execute_master_line :1834` と post-loop `:2287` の Pan 実行・`current_gain` を `AtomicU32` 化 `:1003-1007`・seed 付き構築 `:1012-1044`）・`scheduler.rs:105` を `pub` + `lib.rs:19` re-export・`engine_wrap.rs`（bus ごとの shadow `Vec<LineOp>` と seed 計算）・cargo test | 約 450 | 可逆 |
| **B1** | `core/sequence/audio-line.ts`（新）・`sequence.ts`（`:144-150, 381-604, 1759, 1807, 1955-1978`）・`global.ts:513-523`・`mixer-manager.ts:74-84, 300-345`・`audio/types.ts:217-221`・`rust-engine-player.ts`（`setBusLine` + intent cache + replay `:790-794, 1011-1023`）・既存 spec 5 本（doc 611 §7.1）の書き直し・`audio-line.spec.ts`（新） | 約 900 | — |
| **B2** | `sequence.ts`（`output()` 解決順・`send(aux, db)`・`gain/pan` の line 化）・`event-scheduler.ts:38-70, 125, 238`・`evaluate-method.ts:58-85`（`NAMED_ARG_SCHEMA`）・`process-statement.ts:181-250`・`runtime.ts:74, 302-314`・`parse-statement.ts:453-480` + `parser/types.ts:105-111`（mono）・`dsl-surface.ts`・fixtures（`tests/fixtures/mcp-e2e/` 4〜5 譜面）・gated spec（E2E 8 本）・`output-line-expectations.ts` | 約 950 | 🔴 DSL 表面 |
| **B3** | core spec MX.2〜MX.5 の「v1 の現在地」注記（`:1737-1940`）・§8.1.2（`:689-691`）・SC.4 注記（`:153-157`）・doc 610 §3 行（`:115-116`）・`dsl-e2e-coverage.spec.ts:76`（`pan` を baseline から外す）・地図・WORK_LOG | 約 150 | — |

**合計**: 束 A ≈ 750・束 B ≈ 2,000。

### 2.3 束 B が 1,500 を超える件（正直に書く）

B は 1,500 を約 500 超える。選択肢:

| 案 | 内容 | 払うもの |
|---|---|---|
| (a) **推奨** | 2 束のまま。B1 を統合ブランチ上で先にマージし**その時点で main が O0 4 本 + E2E-10 を実機で回す**（小 PR ゲート）。締めのレビューは 1 回 | 締めの差分が 2,000 行 |
| (b) | B1 を第 3 の束 `611-line-ts` として独立（約 900）。B2+B3 で約 1,100 | フルレビュー +1 回 |

(a) を推奨する理由: B1 の検算（goldens 不動）は小 PR ゲートで**失われずに**取れる（B2 が入る前に main が回す）。(b) が (a) に勝るのは「締めのレビューが 2,000 行を読めない」時だけで、それは main が判断する。**確信度 中** — 反証: B1 の小 PR ゲートで O0 が動いたら、(b) に切り替えて B1 単独で締める。

### 2.4 順序と base

`611-surface-rt` → main（束 PR・フルゲート）→ `611-output-line` を main から切る → B1 → B2 → B3 → 束 PR。**B1 は A のマージ後にしか始められない**（`WireLineOp` の `pan` / mono 型に依存）が、B1 の AudioLine 単体（`audio-line.ts` + unit）は A と並行で書ける。

---

## 3. 未決 2 件の裁定案

### 3.1 F1 — フレーム `//#evalBegin/End`（状態: ✅ **owner 裁定 2026-09-10 — 入れる**）

🔴 **owner 裁定: 入れる。** 起案の推奨（1 文 = バッチ）は**却下された**。

> これは「エディタが選択範囲全体を 1 つの評価単位として送り、行の並び順がそのまま信号順になる」で
> ないと振る舞いに一貫性が持たせられないのでは？

**採る理由**: 起案は「行を跨ぐ並べ替えは制作の要件に無い」を根拠にしていたが、要件の有無ではなく
**一貫性**が争点だった。チェーン内では順序が信号順なのに、行に分けた途端に既定ストリップ順へ倒れるのは、
同じ DSL の中に 2 つの規則があることになる。オーディオラインは「置いた位置で役割が決まる」
（#649 §7.6）のだから、位置の読み取り単位は**利用者が 1 回の操作で送る範囲**でなければならない。

**入れる範囲（最小）**: `repl-mode.ts` にメタ行 2 種を足し、`extension.ts` の `writeCodeToEngine` が
送出テキストを挟む。`begin` で全 `AudioLine.beginBatch()`、`end` で `endBatch()`。
🔴 **W-8「構文エラーで全体棄却」は入れない**（それは PR-L2 = 新ラインの意味論）。

🔴 **必須のガード**（起案が挙げた故障モード）: `//#evalEnd` が届かないまま拡張が落ちると `inBatch` が
立ったままになり、以後の生 stdin がバッチ内として振る舞う。**`beginBatch` は「前のバッチが開いていれば
暗黙に閉じてから開く」**ことと、**評価の失敗経路でも `endBatch` を通る**ことを実装で保証する。
ユニットで「begin → begin → end」と「begin → 例外」の 2 系列を固定する。

| 観点 | フレーム有り（doc 611 §3.9 最小版） | 文 = バッチ（推奨） |
|---|---|---|
| E2E-6（pre/post をチェーン順で） | 成立 | **成立**（`kick.output(verb, thru: true).effect([...])` は 1 文） |
| 複数文に分けた要素を再評価で並べ替える（#649 §10.2 帰結 2） | 成立 | **不成立**（文ごとにカーソルが 0 に戻る。並べ替えたければ 1 文に書く） |
| 触る所 | `repl-mode.ts:448-521` にメタ行 2 種・`extension.ts:3117-3149` に前置/後置・W-8「構文エラーで全体棄却」の意味論 | `process-statement.ts:275-288`（`applyMethodChain` の `guardBusChain` 前で `beginBatch`、`return result` 前で `endBatch`）のみ |
| 一方通行性 | 計画 §0 W-8 は「評価の意味論」として一方通行。凍結版で最小版を入れると PR-L2 で**もう一度**意味を変える | 無し（フレームを後から足すと文バッチはその内側で自然に退化する） |
| 既存挙動への影響 | `//#evalEnd` が来るまで `inBatch` が立ったまま（拡張が途中で死ぬと生 stdin が「バッチ内」で動く） | 無し |

**根拠**: 制作の要件（§12.2）は「master + sum / aux + 物理アウト」で、行を跨ぐ並べ替えは要件に無い。doc 611 §2.6 は「#649 §10.1-§10.5 を採用」と書くが、§10.3 は「唯一の新機構」= フレームそのものであり、PR-L2 は §12.3 で新ラインへ回された。**確信度 中高** — 反証: owner が「複数行に分けて書いた `kick.gain(-6)` / `kick.effect(...)` を並べ替えたい」と言えば、フレーム最小版（+26 行）を B2 に足す。その場合 W-8 の「全体棄却」は入れず、`beginBatch`/`endBatch` の呼び出しだけにする。

**owner に問う 1 文**: 凍結版で「別々の行に書いた要素を、行を並べ替えて再評価すると信号順も変わる」機能は要りますか（要らなければチェーン内の順序だけで、行を跨ぐ順序は新ラインへ）。

### 3.2 F2 — `SetGlobalGain` の master line への写し（状態: ✅ **owner 裁定 2026-09-10 — 写さない**）

🔴 **owner 裁定: 写さない。** master は**宛先として書く形**（下表の A）で足りる。

```orbs
// A: master を「宛先」として書く（採用）
drums.effect(["Glue"]).output(master, thru: true).output(cue, db: -20)
```

**推奨どおり: 写さない。`global.gain()` は `SetGlobalGain`（atomic）のまま。master line の TS（`masterLine` / `masterOutput` / output ノードのレシーバ化 = doc 611 §3.5 / §3.7）は凍結版では作らない。**

| | 写す | 写さない（推奨） |
|---|---|---|
| 触るファイル | `global.ts:601-612`（`gain` → `setBusLine('master', …)`）・`masterLine` 新設・`rust-engine-player.ts:1062-1075, 1286-1298`（intent を line に）・`session.rs:2589-2612`（受理時に master program を差し替え）・`runtime.ts:302-314`（output ノードをレシーバに）・`mixer-manager.ts`・unit | `global.ts` 無変更。`runtime.ts:302-314` の文言から「#484 D4」を外すだけ |
| 行数 | 約 +350 | 約 +6 |
| `explicit_line`（`output.rs:757`）| 全譜面が `execute_master_line` 経路へ → O0-1/O0-2 の bit 一致検算を**同じ束で**失う | 固定互換経路のまま。O0 不動 |
| E2E-11（残響比が fader で変わらない） | 本束の検証項目 | 今日の互換経路が既に rack → gain の順（`output.rs:1746-1753`）。E2E-11 は**新規機構無しで書ける**ので B2 に入れる（§8.1） |
| `master.output(cue, thru: true)`（裁定 2 の形） | 書ける | **書けない**。ただし裁定 2 の用例 `drums.effect(["Glue"]).output(master, thru: true).output(cue, db: -20)` は **sum の line** なので書ける（§12.2 の要件はこれで足りる） |

**根拠**: 制作の要件に「master gain をラックの前後へ置き替える」は無い。写しは §4.3 の引き継ぎ機構が入れば技術的には可能だが、O0 の bit 一致検算を同じ束で失うのが大きい。**確信度 高** — 反証: owner が `master.output(cue)`（master ノードを主語にする形）を凍結版で使うなら写す側へ。

**owner に問う 1 文**: 凍結版で master を主語にした `master.output(cue, thru: true)` / `master.gain(-6)` を書く必要はありますか（sum を主語にした `drums.output(master, thru: true).output(cue)` で足りるなら写しは新ラインへ）。

---

## 4. Rust — wire と RT（束 A）

### 4.1 `pan` op — RT 実装

**法則の共有**: `orbit_audio_core::scheduler::equal_power_pan`（`scheduler.rs:105-109`・現在 `fn`・private）を `pub fn` にし `lib.rs:19` で re-export、`output.rs` から使う。二重定義しない（doc 611 §2.4b）。

**🔴 正規化（設計判断・main 審査）**: バス上の Pan op は `√2 · equal_power_pan(p)` を掛ける。

- 発音側は既に center で `(1/√2, 1/√2)` を掛けている（`scheduler.rs:264-266`・`pan_center_applies_equal_power_minus_3db :687`）。バス上でもう一度素の等パワーを掛けると **`seq.pan(0)` を書いただけで −3 dB** 下がる（書かない譜面と 3 dB ずれる）
- `√2 · (cos θ, sin θ)` は center で `(1, 1)`（unity）、hard-left で `(√2, 0)`。発音側 center と合成すると `(1/√2·√2, 0) = (1, 0)` = **今日の発音側 hard-left と同じ**。任意の p で `event_center × line_pan(p) = event_pan(p)` が成り立つ（両者とも per-channel スカラーなので、比は `cos θ / cos(π/4)`）
- したがって **rack を持たない譜面の `pan` golden は丸め誤差以外動かない**。動くのは「rack + pan」譜面（適用点がラック後へ移る）だけ。doc 611 §2.4b の「再ベースライン」はこの範囲に縮む

**🔴 適用範囲（Fable 受け入れ監査 2026-09-10・Important #2）**: 上の「任意の p で `event_center × line_pan(p) = event_pan(p)`」が成り立つのは、**発音側の `equal_power_pan` を通った信号**、つまり scheduler が鳴らす audio event に限る。

`collect_source_feeds` が集める **instrument（out-of-process プラグイン）の feed は schedule 時の pan を通らない**（`scheduler.rs` の適用は `schedule()` の中で `Engine.output_channels == 2` の時に precompute する経路だけ）。したがって instrument に対するライン上の Pan は `√2 · equal_power_pan(p)` がそのまま出る:

| p | audio event（発音側 center と合成） | instrument feed（発音側 pan 無し） |
|---|---|---|
| 0（中央） | `(0.707, 0.707)` — pan を書かない譜面と同じ | `(1.0, 1.0)` — pan を書かない譜面と同じ |
| ±1（両端） | `(1.0, 0)` | `(1.414, 0)` = **+3.01 dB** |

**どちらも等パワー則で、中央比では同じ +3 dB** である（audio event は中央が既に −3 dB 下がっているぶん、両端が unity に着地する）。違うのは**絶対レベル**で、フルスケールの instrument を端まで振ると 0 dBFS を超える。

🔴 **owner 裁定事項**: instrument feed にも中央 `1/√2` を掛けて audio event と絶対レベルをそろえるか（＝pan を書かない instrument が一律 3 dB 下がる）、現状のまま「中央 unity・両端 +3 dB」を pan 則として受け入れるか。**束 A では到達不能**（凍結版の TS は `SetBusLine` を送らない）。**束 B で `synth.pan(...)` が到達可能になる**（§5.2 の規則で instrument は必ずバスを確保してラインで pan する）ので、束 B の締めまでに決める。

**ramp**: Pan は `current_gain[k]` に **pan 位置 p（−1..1）** を保持し、block ごとに `advance_ramped_gain`（`output.rs:713-717`）で目標へ寄せ、その p から `(gL, gR)` を計算する（trig は block ごと 1 回・alloc/lock 無し）。`settled` / seed の値は目標そのもの（§4.3）。Pan の位置変更でクリックを出さないため。

**RT 実行**（`execute_master_line :1834` と post-loop `:2287` の `LineOp::Pan(_) => {}` を置換）:

```rust
LineOp::Pan(target) => {
    let p = line_gain(program, op_index, target, frames, ramp_frames);   // ここでは「現在の pan 位置」
    let (l, r) = equal_power_pan(p);
    let (gl, gr) = (l * SQRT_2, r * SQRT_2);
    for frame in 0..frames { buf[frame*2] *= gl; buf[frame*2+1] *= gr; }
}
```

master line 上の Pan（`SetBusLine("master")`）も同じ分岐で動くが、凍結版の TS は master へ送らない。

### 4.2 mono `device` — wire

| 層 | 変更 | 場所 |
|---|---|---|
| TS 型 | `WireDest.device.channels: [number, number] \| [number]`・`WireLineOp` に `{ op: 'pan'; pan: number }`（−1..1） | `daemon-client.ts:86-96` |
| parse | `channels` は長さ **1 または 2**。1 要素は `Device { left, right: None }`。`BusLineDest::Device` を `right: Option<usize>` に。`op: "pan"` を受理し `pan` は有限かつ `-1 <= pan <= 1`、外れたら `PARAM_OUT_OF_RANGE`（doc 611 §4.1 表） | `session.rs:373-425`・`engine_wrap.rs:2087-2100` |
| 検証 | 1 要素なら `1 <= n <= output_channels` のみ（`a != b` は 2 要素だけ） | `session.rs:427-453` |
| 解決 | `device_dest_from_wire(left, right: Option<usize>)`。RT の `add_to_device` は `right: None` を既に扱う（`output.rs:2082-2091`） | `engine_wrap.rs:6711-6719` |
| エラー文言 | `"'line[].dest.channels' must be a one- or two-element integer array"` | `session.rs:386-388` |

### 4.3 🔴 再 publish 時の実効ゲイン引き継ぎ（seed）— 本束の必須要件

**故障シナリオ**（今日の `LineProgram::new` で TS が `SetBusLine` を送ると必ず起きる）: `kick.send(verb, -12)` で演奏中に `kick.send(delay, -6)` を足す → line 全置換 → verb 宛て op の `current_gain` が **1.0 から 0.25 へ 5 ms かけて下がる** = リバーブへ 5 ms の +12 dB バースト。`kick.gain(-40)` → `kick.gain(0)` は目標が 1.0 なので **ramp が存在せず 1 サンプルで跳ぶ**（E2E-7 が捕まえる）。

**設計（control 側 seed・RT 構造は変えない）**:

1. `LineProgram.current_gain` を `Box<[Cell<f32>]>` から **`Box<[AtomicU32]>`**（Relaxed）にする。RT の store は ARM64 では通常 store と同コスト。これで control が**読める**（doc 611 §5.1「読むと競合する」は `Cell` の話で、atomic なら data race ではない）
2. `LineControl` に `current_gains() -> Vec<f32>`（live pointer を deref して atomics を load。control が唯一の swap 主体なので pointer は有効）を足す
3. `engine_wrap.rs` は bus ごとに直前に publish した `Vec<LineOp>` を shadow に持つ（master は `master_line_program :1762` が既にある。`bus_line_programs :1757` の隣に `bus_line_shadows: Mutex<HashMap<String, Vec<LineOp>>>`）
4. `set_bus_line` は新 program を作る前に `(旧 ops, 旧 current)` を読み、**キー対応**で seed を決める: `Gain` は Gain 同士の出現序数、`Pan` は Pan 同士、`Output` は `(dest, 出現序数)` が一致する旧 op から `current` を引き継ぐ。対応が無い新 op の seed は **Gain → 1.0 / Pan → 目標 p / Output → 0.0**（新しいタップは無音からフェードイン）
5. `LineProgram::with_seeds(ops, seeds)` を足し、`new`（全 1.0）は test / legacy 以外から呼ばない

**staleness の上限**: control が読んでから RT が swap を見るまでに RT が進める量は「ramp 進行中の op が 1〜数 block 分」だけ。ramp は 5 ms で完了するので、seed の誤差は **ramp 中に差し替えた場合に限り最大 1 block 分**（可聴の不連続にはならない）。

**cargo test**: `LineSlot` に旧 program `[Output(master, 0.1)]` を install → RT を 1 block 回して current が 0.1 に到達 → 新 program `[Output(master, 1.0)]` を seed 付きで install → 次 block の `line_gain` の**最初の返り値が 0.1 + (1.0−0.1)·frames/ramp** であること（seed 無しなら 1.0）。対応の無い新 Output は 0.0 から始まることも 1 件。**確信度 中高** — 反証: E2E-7 の一次差分（§8.1）。

### 4.4 `validate_line_program` の拒否解除

`output.rs:1316-1320` の `Pan` アームを削除し、`line_program_install_rejects_unwired_pan :3782` を「Pan が受理され RT で L/R が変わる」テストに置き換える。`Render` / `Link` の拒否は残す（RT 未配線のまま・§5.6）。

---

## 5. TS — `AudioLine` と DSL（束 B）

### 5.1 `AudioLine`（doc 611 §3.1〜§3.4 を採る・変更点のみ）

| 項目 | doc 611 | 本書 | 理由 |
|---|---|---|---|
| `pan` 要素の値 | −1..1 | **DSL 値 −100..100 を保持**し、wire で `/100`（`rust-engine-player.ts:1812` の発音側と同じ換算） | `PanManager` が −100..100（`pan-manager.ts:15,36`）。2 か所で換算しない |
| バッチ境界 | `//#evalBegin/End` | **同じ**（owner 裁定 2026-09-10 で採用・§3.1 / §5.7） | 行を跨いだ順序が信号順に出ないと、チェーン内と規則が 2 つになる |
| 規則 2 の擬似コード | `splice(i,1); splice(cursor,0,e); cursor += 1` | **`splice(i,1); cursor -= 1; splice(cursor,0,e); cursor += 1`** | 規則 2 は常に `i < cursor` なので、削除で cursor の指す位置が 1 つ前へずれる。doc のままだと `[rack, gain, output]` に `gain().effect()` → `[gain, output, rack]` |
| 終端の既定位置 | 未定義 | **バッチの先頭要素が `thru: false` の output で、既に終端があれば、その終端を置換**（位置は旧終端のまま） | `kick.output("drums")` の後に `kick.output("cue")` を単文で評価した時、今日の「出力先を替える」意味を保つ。2 要素にすると旧終端の後ろで到達不能になり無音 |
| 新規要素の既定位置（バッチ先頭のみ） | 既定ストリップ | 同じ: `[rack → gain → pan → sends(thru:true) → output(thru:false)]`。**2 つ目以降の新規要素はカーソル位置**（規則 3） | E2E-6 の `output(verb, thru:true).effect()` で rack が verb の後ろへ入る |
| `elementKey` の ordinal | バッチ内で数える | 同じ | |

**擬似コード（最終形）**:

```
beginBatch(): cursor = 0; first = true; ordinals.clear()
upsert(e):
  k = key(e, ordinal(e))
  i = index(k)
  if first:                                   # バッチ先頭
    first = false
    if i >= 0: elements[i] = e; cursor = i + 1; return            # 値更新・位置不変（規則 1/4）
    if e は終端 output かつ 既存終端 t あり: elements[t] = e; cursor = t + 1; return
    insertAtDefault(e); cursor = 挿入位置 + 1; return
  if i >= cursor: elements[i] = e; cursor = i + 1                 # 規則 1
  elif i >= 0: splice(i,1); cursor -= 1; splice(cursor,0,e); cursor += 1   # 規則 2（修正）
  else: splice(cursor,0,e); cursor += 1                           # 規則 3
program(): 終端が無ければ末尾に output(master,false,0)。rack が無ければ先頭に rack
```

### 5.2 🔴 `seq.gain(固定)` / `seq.pan(固定)` — ライン要素だがバス無しでは発音側

**制約**: line が daemon に存在するのは `_insertBus` を持つシーケンスだけ（`scheduleEvents :1618` の `insertBus`）。プールは **8**（`sequence-effect-manager.ts:29` / `engine_wrap.rs:2032`・`sequence-effect.spec.ts:194` が固定）。`examples/07_audio_control.orbs` は 17 シーケンス・`.gain()` 28 回・`.pan()` 16 回。**無条件にバスを取ると 9 本目で `pool exhausted` を throw する** — 凍結版の「既存譜面を壊さない」に反する。

**規則**:

| シーケンス | `gain(固定)` / `pan(固定)` の適用点 | 発音側の値 |
|---|---|---|
| audio・`_insertBus` 無し | **発音側**（今日どおり `calculateEventGain :38-70` / `eventPan :125,238`）。`_line` には要素として記録する | 実値 |
| audio・`_insertBus` 有り（effect / output / send を宣言済み） | **ライン**（`LineOp::Gain` / `Pan`） | **0 dB / center** |
| instrument | **バスを確保してライン**（`ensureSequenceInsertBus :477`）。発音側経路が無い（doc 610 §3 `:115-116` が `warn` にしている理由）| — |
| `gain(random)` / `pan(random)` | 発音側のまま（doc 611 §2.4） | 実値 |

**なぜ音が同じか**: rack が無ければ「ラック前 / 後」の区別は存在せず、スカラーは加算と可換。pan は §4.1 の正規化で発音側と合成が一致する。**観測できる差は ramp（クリック無し）だけ**で、それはバス有りの側が良い方向。

**バス確保時の引き継ぎ**: `effect()` / `output()` / `send()` が初めて `_insertBus` を確保した時、`_line` の gain/pan 要素を含む program を `syncBusLine()` し、**演奏中なら `seamlessParameterUpdate('gain', …)`（`sequence.ts:277-300` の即時再スケジュール）** を 1 回呼んで発音側を 0 dB / center へ切り替える。呼ばないと次の小節境界まで二重に掛かる（§10 失敗モード）。

**`seamlessParameterUpdate` の扱い**: バス有りの `gain(固定)` は line の ramp が担うので再スケジュールしない（ログ行 `🎚️ … (seamless)` は残す）。

### 5.3 `Sequence` の変更（doc 611 §3.3 に対する差分のみ）

| 行 | 変更 |
|---|---|
| `:144-150` | `_sumOutputBus` / `_auxSends` / `buildRoutingSends :88` を廃止し `_line = new AudioLine()`。`_busRoutingStale` → `_busLineStale`（`:1759` `:1807` の自己修復はそのまま） |
| `:381-467` `output()` | doc 611 §3.3 の解決順。**`{kind:'link'}` はラインに置かない**（§5.6）。LinkAudio 分岐（`:437-466`）は `_outputChannel` を設定して今日どおり終わる。**`_renderBus`（`:135, :407-432`）と数値分岐は触らない** — core spec MX.2.3 `:1863-1866` が撤回の**実装**を #598 PR-R 系に置いており、doc 611 §3.3 表の「廃止」より spec が正本（`getRenderBus :475` の読み手 `render-score.ts` も残る）|
| `:490-517` `send()` | `send(aux: string \| OutputDest, db: number, opts: { enabled?: boolean })`。`enabled: false` → `db = -Infinity` → wire gain 0 |
| `:520-556` `routeOutputFromDsl` / `routeSendFromDsl` | `OutputDest` と dB を受ける await 版。`pushBusLine()` へ |
| `:558-604` | `pushBusLine` / `syncBusLine`: `global.setBusLine(bus, toWire(this._line.program()))`。`DaemonProtocolError` は `❌ … SetBusLine(bus) was rejected — routing was NOT applied` + stale。文言は `:594-597` と同形 |
| `:1599-1619` | `gainDb` / `pan` は §5.2 の表に従い 0 / center を渡す |
| `:1955-1978` `getState()` | `line: this._line.snapshot()` を足し `renderBus` を消す |

`toWire(program)`: `gain` は `gainDbToAmplitude(db)`（`-Infinity` → 0）、`pan` は `/100`、`dest` は `destKey` の逆写像。`{kind:'link'}` は生成しない（型で `WireDest` に link はあるが TS の `OutputDest` から link を wire に落とす関数を**書かない**）。

### 5.4 `Global` / `MixerBusHandle` / interpreter

| 箇所 | 変更 |
|---|---|
| `global.ts:513-523` | `setBusLine(bus, line)` を追加（`audioEngine.setBusLine` が無ければ throw）。`setBusRouting` は残す（呼び出し元ゼロ・O6 で削除） |
| `audio/types.ts:217-221` | `setBusLine?(bus: string, line: WireLineOp[]): Promise<void>`。`WireDest` / `WireLineOp` は `audio/types.ts` へ移し `daemon-client.ts` が re-export |
| `mixer-manager.ts:74-84` | `routeOutput(output)` / `routeSend(bus, amount)` → `output(dest, opts)` / `send(bus, db, opts)`。`:321-345` の `routings` → `lines: Map<bus, AudioLine>`、送信は `setBusLine` |
| `runtime.ts:74` | `BUS_DSL_METHODS` に `output` / `send` / `gain` / `pan` を追加。`:302-314` の throw 文言から「#484 D4」を外す（output ノードは凍結版でもレシーバにしない・§3.2） |
| `evaluate-method.ts:58-85` | `NAMED_ARG_SCHEMA = { output: { thru:'boolean', db:'number' }, send: { db:'number', enabled:'boolean' } }`。該当するものは options オブジェクトに畳み、無い名前は従来の staged error |
| `process-statement.ts:181-231`（aux 糖衣） | `amount:` → **`db:`**（§14 (2)）。値は dB として `send()` へ。`amount:` が来たら「`db:` に改名された」と loud に throw |
| `process-statement.ts:232-250`（sum / output 糖衣） | `(1,2)` 限定 throw を外し、output ノードは `{kind:'device', channels}` に解決。`master` は `{kind:'master'}` |
| `output(verb)` の識別子引数 | `parseArguments :773` は IDENTIFIER を式として `parseIdentifier` に渡す。`output` / `send` の第 1 引数だけ interpreter で `state.mixers.nodes` → `OutputDest` に解決する（doc 611 §3.8）。未宣言なら既存の `Variable not found` 系文言 |
| `parse-statement.ts:453-480` + `parser/types.ts:110` | `mix.output(n)` を受理し `channels: [number] \| [number, number]` |
| `signal-chain-dispatch.spec.ts:613` の分類 | 新 public メソッド（`setBusLine` 等）は内部 API に分類する行を足す（未分類だと red） |

### 5.5 respawn replay（F4）

`RustEnginePlayer` に `busLines: Map<string, WireLineOp[]>`（`busRoutings :441-444` の隣）。`setBusLine` は intent-first / `DaemonProtocolError` で revert（`:983-1002` と同形）。`reapplyBusLinesAfterRespawn()` を `reapplyBusRoutingAfterRespawn` の**直後**（`:792`）に足す。旧 replay は残す（B1 以降 production では空）。`respawn` 後に seed は「対応無し」なので Output は 0.0 からフェードイン（5 ms）。**E2E-10 で検証**（§8.1）。

### 5.6 link の扱い（F5 の結論）

- TS は `SetBusLine` に `dest.link` を**生成しない**（`OutputDest.link` はラインに置かず、`_outputChannel` + 発音側 tag で今日どおり）。`effect()` と LinkAudio の併用は既に拒否されている（`mixer-manager.ts` の LinkAudio gate・`resolveEffectRack` の文言）ので「link + line」は起こらない
- `RustEnginePlayer.setBusLine` は **`LINK_AUDIO_UNAVAILABLE` を特別扱いしない**（`registerLinkAudioChannel :946-963` の warn-once を写さない）。全か無かの拒否を warn-once にすると line 全体が黙って落ちる
- unit: `setBusLine` が `LINK_AUDIO_UNAVAILABLE` の `DaemonProtocolError` を **rethrow** し intent を revert すること 1 件


### 5.7 🔴 評価フレーム `//#evalBegin` / `//#evalEnd`（owner 裁定 2026-09-10 で採用）

**入れる範囲は最小**。W-8「構文エラーで全体棄却」は**入れない**（それは PR-L2 = 新ラインの意味論）。

| 箇所 | 変更 |
|---|---|
| `extension.ts` `writeCodeToEngine` | 送出テキストを `//#evalBegin\n … \n//#evalEnd` で挟む。`//#documentDirectory` の**後** |
| `repl-mode.ts` のメタ行群 | `EVAL_BEGIN_META_RE` / `EVAL_END_META_RE` を追加。`begin` で全 `AudioLine.beginBatch()`、`end` で `endBatch()` |
| MCP `evaluate_orbitscore` | 同じ `writeCodeToEngine` を通るので追加作業なし |

🔴 **必須のガード**（起案が挙げた故障モード）: `//#evalEnd` が届かないまま拡張が落ちると `inBatch` が
立ったままになり、以後の生 stdin がバッチ内として振る舞う。

1. **`beginBatch()` は「前のバッチが開いていれば暗黙に閉じてから開く」**
2. **評価が例外で終わる経路でも `endBatch()` を通る**（`finally`）

ユニットで **「begin → begin → end」**と**「begin → 例外 → 次の begin」**の 2 系列を固定する。

**生 stdin（手動 REPL）** はフレーム無しなので「値だけ更新・位置不変」に退化する（doc 611 §3.2）。

---

## 6. `AudioLine` のユニットテスト表（`tests/core/audio-line.spec.ts`・新設）

| # | 操作（バッチ = `[...]` 1 つ） | 期待 `program()` |
|---|---|---|
| U1 | 空 | `[rack, output(master,false,0)]`（暗黙 master・§3.4） |
| U2 | `[send(verb,-12)]` | `[rack, output(verb,true,-12), output(master,false,0)]`（send だけの行も master へ届く・doc 611 §2.1 🔴） |
| U3 | `[output(verb,true).rack]` | `[output(verb,true,0), rack, output(master)]`（E2E-6 pre） |
| U4 | `[rack.output(verb,true)]` | `[rack, output(verb,true,0), output(master)]`（E2E-6 post） |
| U5 | `[rack]`, `[gain(-6)]`, `[pan(-100)]`（3 文） | `[rack, gain, pan, output(master)]`（既定ストリップ） |
| U6 | `[gain(-6)]`, `[rack]`（順序逆） | `[rack, gain, output(master)]`（rack の既定は先頭・Q-611-8） |
| U7 | `[rack, gain(-6), output(master)]` 後に `[gain(-12).rack]` | `[gain(-12), rack, output(master)]`（規則 2・**修正版 cursor**。doc 611 の擬似コードでは `[gain, output, rack]` になることを対照で示す） |
| U8 | `[output(drums)]`, `[output(cue)]`（2 文・両方終端） | `[rack, output(cue,false)]`（終端置換・§5.1） |
| U9 | `[output(drums).output(cue)]`（1 文） | `[rack, output(drums,false), output(cue,false)]`（cue は到達不能・engine は制限しない・§14 (3)） |
| U10 | `[output(verb,true).rack.output(verb)]` | verb が 2 要素（ordinal 0/1・Q-611-3 B） |
| U11 | `[send(verb,-12)]`, `[send(verb,-6)]`（2 文） | verb 1 要素・db −6（値更新・位置不変） |
| U12 | `[send(verb,-12, enabled:false)]` | `db: -Infinity` → `toWire` の gain `0` |
| U13 | `toWire`: `gain(-6)` → `0.501187`、`pan(-100)` → `-1`、`device [3]` → `channels:[3]`、`link` 要素 → **throw**（生成しない） |
| U14 | `Sequence.gain(-6)`（バス無し）→ `scheduleEvents` に渡る `gainDb` は −6 / `effect()` 後は 0 で line に `gain(-6)`（§5.2） |
| U15 | instrument の `gain(-6)` → `ensureSequenceInsertBus` が呼ばれ `setBusLine` に `gain` op |
| U16 | `setBusLine` reject（`DaemonProtocolError`）→ `❌` 1 行 + `_busLineStale`、次の `scheduleEvents` で再送 1 回（`toHaveBeenCalledTimes`） |

---

## 7. DSL 表面の互換 — goldens の 3 分類（`OUTPUT_LINE_GOLDENS` `output-line-expectations.ts:135-204`）

| key | 譜面 | 分類 | 式 |
|---|---|---|---|
| `noBus` | `kick_loop.orbs` | **不動** | バス無し・SetBusLine 送出なし。許容 0.12（既存） |
| `sumOutput` | `kick.output("o0sum611")` | **不動** | program `[rack, output(sum,false,1.0)]` は `LineProgram::legacy` と同じ形。gain 1.0 |
| `send` | `kick.send("o0rev611", 0.3)` | **動く** | `legacyTotalOverDry = 1.3` → **`dbTotalOverDry = 1 + 10^(0.3/20) = 2.0351`**（既に定義済み `:170`）。O0-3 の期待値を `dbTotalOverDry` に切り替える（B2） |
| `sequenceGainWithEffect` | `effect([Gain(db:6)]).gain(-6)` | **不動（式の上で）** | `Gain` 標準プラグインはスカラー（`orbit-std-gain/src/lib.rs`）で `gain(-6)` と可換。ラック前→後へ移っても積は unity。`:184-190` の注記どおり順序は E2E-6 が担う |
| `globalGainInstrument` | E2E-1 | **不動** | `global.gain()` は atomic のまま（§3.2） |
| （`pan` 譜面） | 無し | **再ベースライン不要** | §4.1 の正規化で rack 無し譜面は丸め誤差のみ。rack + pan 譜面は golden が無い |

---

## 8. E2E 表（`tests/e2e/orbitstudio-mcp-gated.spec.ts`・すべて MCP 経由・capture の数値で判定）

共通: `ok` に assert しない・ERROR は `expectNoNewErrors`（`<=`）・capture したら `steadyRms` / `channelRms`。譜面は `tests/fixtures/mcp-e2e/`（バス名は一意にする・`output_line_sum.orbs` の注記）。dry 基準は O0-3 と同じ「dry シーケンスを先に鳴らし `dry.stop()` → 対象を `LOOP`」の 2 区間法。合流は coherent（`output-line-expectations.ts:163-166`）。

### 8.1 本束の E2E

| # | 譜面（要点） | 区間 | 判定式 | 許容 | 押さえる op |
|---|---|---|---|---|---|
| E2E-2 | `kick.output(verb, thru: true, db: -12).output(master)` | dry / total | `total/dry = 1 + 10^(-12/20) = 1.251` | ±0.12 | `Output(Bus, 0.251)` + thru |
| E2E-3 | 譜面 A `kick.send(verb, -12)` / 譜面 B `kick.output(verb, thru: true, db: -12)` | total_A / total_B | `\|A/B − 1\| <= 0.02`（同一セッション・2 回再現性の既知値） | 0.02 | 糖衣の同値 |
| E2E-6 | A `kick.output(verb, thru: true).effect([Gain(db: -12)])` / B `kick.effect([Gain(db: -12)]).output(verb, thru: true)` | total_A / total_B | `(1 + g) / (2g)`, `g = 10^(-12/20)` → **2.49** | ±0.12 | 位置 = 意味（#649 受け入れ 3/4）|
| E2E-S | `kick.send(verb, -12).send(dly, -6)`（aux 2 本） | dry / total | `1 + 0.251 + 0.501 = 1.752` | ±0.12 | **複数 send** |
| E2E-S0 | `kick.send(verb, -12, enabled: false)` | dry / total | `total/dry = 1.0` | ±0.05 | **gain 0 の send** |
| E2E-G | `kick.output(drums).gain(-6)` を **`kick.gain(-6).output(drums)`** に書く（gain は終端の前） | dry / gained | `10^(-6/20) = 0.501` | ±0.12 | **`LineOp::Gain`**（実機初） |
| E2E-D | `var out12 = mix.output(1, 2)` + `global.gain(-12)` + A `kick.output(out12)` / B `kick.output(master)` | A / B | `10^(12/20) = 3.98`（Device 宛ては master gain を通らない・裁定 2） | ±0.12 | **`Device` 宛て**（2ch で可）|
| E2E-M | `var mono1 = mix.output(1)` + `kick.output(mono1)` | `channelRms(0)` / `channelRms(1)` vs 参照 | ch0 = 参照 ch0（±0.05）・ch1 <= 0.02·ch0 | | **mono マージ**（2ch で可・kick は L=R なので `(L+R)/2 = L`）|
| E2E-P | `kick.pan(-100).output(drums)` / `kick.pan(0).output(drums)` / pan 無し | `channelRms` | hard-left: ch1 <= 0.02·ch0。center: ch0/ch1 が pan 無しと ±0.03（√2 正規化の証明） | | **`LineOp::Pan`**・coverage baseline から `pan` を外す |
| E2E-7 | `sine_440.wav`（1 s・`test-assets/audio`）を `chop(1).play(1)` で連続・`tone.gain(-40).output(drums)` → 演奏中に `tone.gain(0)` | 切替 ±50 ms の PCM | `max\|x[n]−x[n−1]\|`（切替窓） `<= 4 ×` 同（定常窓）。440 Hz・振幅 A の定常一次差分は `≈ 0.058A`、seed 無しの跳びは `≈ 0.99A` | 4× | **§4.3 の seed**。WAV は `readCaptureForAnalysis`（`capture-windows.ts:88`）で読む |
| E2E-10 | E2E-2 の譜面で total を測る → `orbitAudioDaemonPids()`（`:348-360`）で daemon PID を取り `SIGKILL` → respawn を `get_engine_state` と PID 差分で待つ → 再測 | before / after | `\|after/before − 1\| <= 0.05`・**respawn 後の daemon 台数 = 1**（#624 の狭いスライス）| | replay（§5.5）|
| E2E-11 | `kick.effect([Reverb]).output(master)` 再生中に `global.gain(0)` → `global.gain(-12)` | 直接音窓 / 残響尾窓 | 比が前後で ±0.10・絶対値 `10^(-12/20)` | | 互換経路の rack → gain 順（新機構無し）|

⚠️ E2E-10 の capture は daemon 側のタップ（`ORBIT_CAPTURE_WAV`）なので respawn で **WAV が作り直される**。before の RMS は kill の前に読み切る（1 つの `CaptureWindows` にしない）。**確信度 中** — 反証: respawn 後の WAV が同パスで追記されるなら 1 本で測れる。

### 8.2 doc 611 §10「実機で一度も鳴っていない op」との対応

| op | E2E |
|---|---|
| `LineOp::Gain` | E2E-G・E2E-7 |
| `Device` 宛て | E2E-D（2ch 対）・E2E-5（3/4・§8.3）|
| mono マージ | E2E-M（ch1 単独・2ch で可）|
| 複数 send | E2E-S |
| gain 0 の send | E2E-S0 |
| `Pan` | E2E-P |

### 8.3 多チャンネルデバイスが要る E2E（状態: ✅ **owner 回答 2026-09-10 — Loopback で作る**）

E2E-4（`thru: false` の後ろの `output(cue)` は無音）と E2E-5（`output(master, thru: true).output("3,4", db: -20)` の ch1/2 : ch3/4 = `10^(20/20)`）は **出力 4ch 以上**のデバイスが要る。本機（2026-09-10 実測 `--list-audio-devices`）は 2ch のみ。

- `listOutputDevices()`（`audio-devices.ts:22-29`）に `maxOutputChannels`（daemon は既に返す）を通し、`>= 4` のデバイスが無ければ **`it.skip` + `console.warn('[E2E-4/5] no >=4ch output device — install BlackHole 16ch to run')`**。skip はテスト名に `(needs >=4ch device)` を含める
- ある場合は `launchIsolatedOrbitStudio`（`:438`）で `orbitscore.audioDevice` にそのデバイス名を渡す自己完結テスト（`#661 D-0 :5519` と同形・`-t` で単独実行可）

✅ **owner 回答 2026-09-10: BlackHole は不要**。本機には **Loopback.app が導入済み**（`/Applications/Loopback.app`・main 実測）で、
**出力チャンネル数を任意に決めた仮想デバイスを作れる**。したがって E2E-4 / E2E-5 は BlackHole を入れずに実行できる。

🔴 **ただし 2026-09-10 時点では 4ch 以上のデバイスが存在しない**（`system_profiler SPAudioDataType` の出力デバイスは
内蔵スピーカー 2ch と Pro Tools Aggregate I/O 2ch のみ）。**Loopback で 4ch 以上の仮想デバイスを 1 つ作る**必要がある
（GUI 操作なので owner が行う）。作成後はデバイス名を `orbitscore.audioDevice` に渡す自己完結テストにする。
capture は「デバイスへ出る実信号」を録るので、仮想デバイスでも判定は成立する（聴く必要はない）。

### 8.4 既知の赤の台帳（新しい赤だけを見る）

| テスト | 状態 | 出典 |
|---|---|---|
| `steps the live playhead through an instrument() sequence`（`:2437`）| main baseline で赤 | 依頼文 F7 |
| `#611 O0-4`（`:5285`）| #775。E-gate 後に消えた可能性 — **束 A の締めで観測して更新する** | 計画 §3 ステージ 2 |

---

## 9. spec 改訂の残り（実装より先・B3 だが**内容は B2 着手前に確定**）

MX.2〜MX.5 の規範本文は PR-O1 で改訂済み（`:1737-1940` 実読）。残るのは「v1 の現在地」注記と本書で決めた 3 点:

| 文書 | 箇所 | 改訂 |
|---|---|---|
| core spec | MX.2.1 `:1803-1810`（予約語）・`:1834-1846`（未実装表）・MX.3 `:1892-1894`・MX.4「PR-O3 の到達点」`:1908-1925`・§8.1.2 `:691` | 「PR-O4 で実装」→「実装済み（束 O-surface・PR #）」。**追記**: (a) `seq.gain(固定)` / `seq.pan(固定)` は「ライン要素。ただし daemon にラインを持たない audio シーケンスでは engine が発音側で同値に適用する」(b) バッチ = 1 文（行を跨ぐ順序主張は新ライン）(c) master を主語にした `output` は新ライン |
| core spec | MX.2.3 `:1848-1866` | 撤回の実装は触らない（PR-R 系のまま）。ただし `:1865-1866`「`mix.output(3)` は throw / mono 宛ての受理も未実装」は本束で偽になるので更新 |
| `SIGNAL_CHAIN_DSL_SPEC_v1.md` | SC.4 注記 `:153-157` | 「v1 の現在地」を実装済みへ。`amount:` → `db:` の改名を明記 |
| doc 610 | §3 `:115-116` | instrument 行の `gain` / `pan` を `ok` に（audio・バス無しは今日どおり `ok`）|
| doc 611 | §3.2 規則 2・§2.6・§3.9 | 規則 2 の cursor 修正（§5.1）。§2.6 / §3.9 に「凍結版はバッチ = 1 文。フレームは PR-L2」の引用ブロック |
| `dsl-e2e-coverage.spec.ts` | `:76` | `pan` を `SEQUENCE_UNCOVERED_BASELINE` から外す（E2E-P） |

---

## 10. 失敗モード（doc 611 §8 の続き・本束で新たに増える経路）

| 何が壊れうるか | 検出 | 出るもの | 演奏 |
|---|---|---|---|
| `SetBusLine` 再 publish で実効ゲインが 1.0 から再開 | E2E-7（一次差分）・cargo seed test | — | ポップ（§4.3 で塞ぐ）|
| バス確保時に発音側とラインで gain が二重に掛かる（次の小節境界まで） | U14 + 実機で `effect()` 追加直後の窓 | −6 dB が 1 小節だけ −12 dB | §5.2 の即時再スケジュールで塞ぐ |
| プール枯渇（9 本目の `effect`/`output`/`send`） | 既存 `pool exhausted` throw（`sequence-effect-manager.ts:48-49`） | 評価エラー | 止めない。**`gain`/`pan` だけでは起きない**（§5.2）|
| `dest.link` を wire に載せて line 全体が拒否される | U13（`toWire` が throw）+ §5.6 unit | `❌ … rejected` | 起きない（生成しない）|
| `LINK_AUDIO_UNAVAILABLE` を warn-once に写して黙る | §5.6 unit（rethrow） | — | — |
| 終端を 2 つ書いて後ろが無音（U9） | エディタ診断（#644 の表・新ライン）| 今は出ない | 止めない。凍結版は spec に「後ろへは流れない」と明記 |
| `amount:` を書いた旧譜面 | `process-statement.ts` の loud な throw | 「`amount:` は `db:` に改名」 | 評価失敗 |
| `send("rev", 0.3)` を dB で読む（静かに壊れる） | 検出不能 | — | §7 の式・spec MX.3 の注記で告知 |
| respawn 後に line が初期値へ戻る | E2E-10 | `❌ failed to restore bus line` | replay で復元 |
| respawn 後に daemon が 2 台（#624） | E2E-10 の台数アサーション | — | 二重出力 |
| Pan 位置変更のクリック | Pan の ramp（§4.1）。E2E-P では測らない | — | — |
| デバイス切替で mono `Device{left}` が範囲外 | 既存 `rebuild_output_stream` 後の再検証（doc 611 §8）— **本束では触らない** | | |

---

## 11. 各小 PR の完了条件（Codex ブリーフへ転記できる粒度）

### PR-A1（wire）
- **done**: `SetBusLine` が `{op:"pan", pan}` と `device.channels` 1 要素を受理し、`pan` 範囲外は `PARAM_OUT_OF_RANGE`、`channels` 3 要素以上 / 0 は `MALFORMED_REQUEST`、mono の `n` 範囲外は `PARAM_OUT_OF_RANGE`。`BusLineDest::Device.right: Option<usize>`。`daemon-client.ts` の `WireDest` / `WireLineOp` が型で同じ形。TS の呼び出し元は**作らない**
- **検証**: `cargo test --manifest-path rust/Cargo.toml -p orbit-audio-daemon --lib set_bus_line`（新規 6 件: mono 受理 / 3 要素拒否 / mono 範囲 / pan 受理 / pan 範囲 / pan 非数）+ `npx vitest run tests/audio/rust-engine/daemon-client-line-wire.spec.ts` + `npm run lint`。**この時点で Pan は RT 未配線なので `install` が拒否する** — A1 の cargo test は parse まで（`engine.set_bus_line` の Pan は A2 で緑になる。A1 では「Pan を含む line は `NoConfig` で拒否」を**明示的に**固定）
- **やらない**: `output.rs` を触らない。既存 spec の期待値を変えない

### PR-A2（RT）
- **done**: `LineOp::Pan` が両ループで L/R を掛ける（`√2·equal_power_pan`・`orbit_audio_core` の関数を使う）。`current_gain` が `AtomicU32`。`set_bus_line` が bus ごとの shadow から seed を計算し、`LineProgram::with_seeds` で install。`validate_line_program` の Pan 拒否が消える
- **検証**: cargo（新規 8 件: Pan hard-left で R=0 / center で unity / ramp が 1 block で目標へ / seed 引き継ぎ（§4.3 の 1 件）/ 対応無し Output は 0 から / Gain は 1.0 から / master line の Pan / 旧 `line_program_install_rejects_unwired_pan` の置換）+ **互換 bit 一致 4 トポロジ**（O-wire の既存テスト）が緑 + `cargo clippy --all-targets`。**main が実機**: O0-1〜O0-4 不動（束 A の締め）
- **やらない**: `SetGlobalGain` を触らない。`explicit_line` の分岐を触らない

> **🔴 監査で見つかった欠落と、その埋め合わせ（2026-09-10）**
>
> Fable の受け入れ監査（Important #1）が、上の 2 節が列挙したテストのうち **3 件が実在しない**ことを一次ソースで確認した。うち 2 件は「1 層だけ追従しない」退行の**検出器そのもの**だった。
>
> | 欠けていたもの | なぜ危ないか | 追加したテスト |
> |---|---|---|
> | master line の `LineOp::Pan` を通す RT テスト | `LineOp` を match する実行器は master（`execute_master_line`）と bus post-loop の **2 箇所**あり、既存テストは `render_tagged_line` 経由で **bus しか通っていなかった**。master アームを `LineOp::Pan(_) => {}` に戻しても全件緑 | `output.rs` `master_line_pan_op_positions_the_master_buffer` |
> | wire の `{"op":"pan","pan":x}` の**肯定側** | 既存は形の不正（MALFORMED）しか見ておらず、`item.get("pan")` を `item.get("value")` に取り違えても全件緑 | `session.rs` `set_bus_line_wire_pan_op_is_parsed_with_its_own_value` |
> | `line_republish_seeds` の「対応無し Gain → 既定 1.0」分岐 | 既存は新 Gain がすべて旧に対応物を持つケースだけを押さえていた | `engine_wrap.rs` `set_bus_line_seed_for_a_new_gain_without_a_match_defaults_to_unity` |
>
> 3 件とも**壊して赤・戻して緑**を実走で確認した（変異は `LineOp::Pan(_) => {}` / `get("pan")` → `get("value")` / 既定値 `1.0` → `0.0`）。
>
> **教訓**: 設計に「検証」として書いたテストが、実装後に**在ることを誰も照合していなかった**。次の束では、設計の検証欄をチェックリストとして機械的に突き合わせる。

### PR-B1（TS 配線）
- **done**: `AudioLine`（§5.1 擬似コード・U1〜U13）。`Sequence` / `MixerBusHandle` が `SetBusLine` を送り `SetBusRouting` の production 呼び出し元がゼロ（`grep -rn "setBusRouting(" packages/engine/src` が `global.ts` の互換定義と `rust-engine-player.ts` の replay だけ）。`RustEnginePlayer.setBusLine` + intent cache + `reapplyBusLinesAfterRespawn`。**DSL 表面は不変**（`output(string)` / `send(name, amount)` の signature と単位はこの PR では変えない — program は今日の形）
- **検証**: `npm test`（既存 5 spec の書き直し含め全緑）+ `npx vitest run tests/core/audio-line.spec.ts` + `npm run typecheck:e2e` + **main が実機**: O0-1〜O0-4 不動 + **E2E-10**（本 PR で足す）
- **やらない**: `send` の単位・`pan` の line 化・名前付き引数はこの PR に入れない

### PR-B2（DSL 表面）
- **done**: `output(dest, thru:, db:)` / `send(aux, db, enabled:)` / `"master"` 予約語 / `"3,4"` / `mix.output(n)` / `output(drums)` のノード変数 / aux 糖衣の `db:` / `gain`・`pan` の §5.2 規則 / `amount:` の loud throw（`output(n)` は触らない・§5.3）。fixtures と E2E-2, 3, 6, 7, 10（B1 で済）, 11, S, S0, G, D, M, P、E2E-4/5 は skip 条件付き。`OUTPUT_LINE_GOLDENS.send` の期待を `dbTotalOverDry` へ
- **検証**: `npm test` + `npm run docs:check` + **main が実機**: `ORBIT_GATED_ORBITSTUDIO=1 npm run test:e2e:gated`（全件。`-t` は suite 本体では効かない・CLAUDE.md）。O0-3 が `2.035` へ動き、O0-1/2/4 は不動
- **red-first**: E2E-2 / E2E-6 / E2E-7 / E2E-P は実装前に書いて赤（E2E-2/6 は named_arg の staged error で赤、E2E-7 は seed が無い B1 状態で… **B1 は seed 済み A2 の上に乗るので E2E-7 は B2 で最初から緑になり得る**。その場合は A2 の cargo seed test が red-first の役を担ったことを報告に書く）

### PR-B3（docs）
- **done**: §9 の表の全行。`planning-issue-state.spec.ts` と `dsl-e2e-coverage.spec.ts` が緑。WORK_LOG
- **検証**: `npm test`（docs 系 spec）

---

## 12. 確信度と反証方法

| 判断 | 確信度 | 反証するにはこれを見る |
|---|---|---|
| seed 機構が無いと本束は出荷できない（§4.3） | 高 | `output.rs:1022-1044` を読む。`settled=false` で全 op 1.0。E2E-7 を seed 無しで走らせ一次差分が 0.9A |
| 文 = バッチで E2E-6 が成立（§3.1） | 高 | U3 / U4 |
| `√2` 正規化で rack 無し pan 譜面が動かない（§4.1） | 中高 | E2E-P center と pan 無しの `channelRms` 比。合わなければ発音側の center 係数が `1/√2` でない |
| バス無し audio は発音側でよい（§5.2） | 高 | rack が無い経路にスカラーの非可換点が無いこと（`render_multi_feeds` は加算のみ）。反証 = `examples/07` の capture が B2 前後で動く |
| プール 8 が制約（§5.2） | 高 | `sequence-effect-manager.ts:29`・`engine_wrap.rs:2032`・`sequence-effect.spec.ts:194` |
| control 側 seed の staleness が可聴でない（§4.3） | 中 | E2E-7 を ramp 進行中（切替を 2 回 3 ms 間隔で）に行い一次差分を見る |
| 束 B の B1 ゲートで検算が保てる（§2.3） | 中 | B1 マージ時の O0 4 本。動けば 3 束へ |
| E2E-10 の capture が respawn で作り直される（§8.1） | 中 | `engine_wrap.rs` の capture 起動経路（`ORBIT_CAPTURE_WAV` は spawn 時 env）|
| doc 611 §3.2 規則 2 の off-by-one（§5.1） | 高 | U7 を doc の擬似コードで実装して赤 |
| 終端置換規則（§5.1 U8）は再設計に当たらない | 中 | doc 611 §3.2 は「バッチ外 = 値更新 / 既定位置挿入」で終端が 2 つになる場合を定義していない。main が「再設計」と判断すれば U8 を「2 要素 + 診断」に変える（実装差は 5 行） |

---

## 13. 提案（実装計画には入れない・再設計に当たるものはここだけ）

1. **プール 8 → 32**（`SEQUENCE_EFFECT_BUS_POOL_SIZE` / `DEFAULT_EFFECT_BUS_POOL_SIZE`・`MAX_INSERT_BUS_STAGES = 64` の内側）。§5.2 の二重経路を無くし全シーケンスをラインに統一できる。コストは stage buffer 384 KB × 24 と RT の marking pass。ただし「`gain()` を呼ぶシーケンス数に上限が付く」ので凍結版ではなく #663 と一緒に
2. **`SetBusLine` に `seed` を wire で渡す**案は採らなかった（TS が実効値を知らない）。逆に **RT 側引き継ぎ**（旧 program pointer を新 program に持たせ RT が最初の block で copy）は control-seed より正確だが、install が 2 回連続した時の合成が要る。E2E-7 が control-seed で落ちたらこちら
3. **エディタ診断「この後ろには音が流れません」**（U9）は #644 の表の 1 行として新ラインへ。凍結版では spec の明記のみ
4. **`send` の線形→dB の静かな破壊**（§7）に対し、凍結版リリースノートで `send(name, 0.3)` 形の全 `.orbs` を `grep` で列挙する 1 行スクリプトを添える（`grep -rnE '\.send\("[^"]+",\s*0?\.[0-9]'`）
5. doc 611 §3.9 / #649 §10.3 のフレームを新ラインで入れる時、**W-8 の「全体棄却」と「バッチ境界」を別 PR に分ける**（後者は加法的、前者は一方通行）
