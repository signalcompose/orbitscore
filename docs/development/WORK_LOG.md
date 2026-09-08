# OrbitScore Development Work Log

## Project Overview

A design and implementation project for a new music DSL (Domain Specific Language) independent of LilyPond. Supports TidalCycles-style selective execution and polyrhythm/polymeter expression.

## Development Environment

- **OS**: macOS (darwin 24.6.0)
- **Language**: TypeScript
- **Testing Framework**: vitest
- **Project Structure**: monorepo (packages/engine, packages/vscode-extension)
- **Version Control**: Git
- **Code Quality**: ESLint + Prettier with pre-commit hooks

---

## Recent Work

### docs: follow the merged O-wire bundle into the dev site (Sep 8, 2026)

**ブランチ**: `claude/docs-sync-pr811` / **追従元**: PR [#811](https://github.com/signalcompose/orbitscore/pull/811)（束 O-wire・merge commit `66efda5`）

ルーチン「マージされた PR にドキュメントとサイトを追従させる」による docs のみの変更。
**実装・テストは 1 行も変更していない。**

#### 追従した内容（ja / en 両方）

| 章 | 何を書いたか | 差分のどこ |
|---|---|---|
| `sites/dev/signal-chain/mixer-audio-line.md` | post-loop の本文が `effective_targets[i]` 分岐から **line program 実行**へ変わった。`LineOp` / `OutputDest` / `LineOutput.thru`、`validate_line_program` の install-time 拒否、`effective_line_output_dest` と `LineProgram::settled` という互換の 2 仕掛け、`LineExchange` の AtomicPtr + 世代カウンタ、marking pass と実行が **1 snapshot を共有する**理由 | `rust/crates/orbit-audio-native/src/output.rs:914-939,1043-1100,1249-1297,1301-1312,2049-2066,2160-2184` |
| `sites/dev/rust-engine/index.md` | `render_block_with_sources` に **直行デバイスライン**の段が増えた（`DeviceLineBuffer` / `direct_device_written` / `wrote` による遅延 zero-fill）。引用 range が capture tap と `cb_stats` を落としていたので本文の 5 段記述に合わせて復元 | `rust/crates/orbit-audio-native/src/output.rs:1651-1700,1926-1930` |
| `sites/dev/editor/vscode-architecture.md` | #773: stdout の bridge dispatch が `createLinePrefixer` + `StringDecoder` 経由になった。buffer をハンドラ内に置く理由（stale プロセスとの分離）、decode をこの経路だけに限った線引き、`end` での `decoder.end()` → `flush()` の順序 | `packages/vscode-extension/src/extension.ts:1479-1486,1516-1519,1534-1535,1578-1586` |
| `sites/dev/editor/mcp-and-gated-e2e.md` | evalMark 分岐が prefixer callback の中へ移ったこと（分岐と prefix 順は不変・取りこぼし経路が 1 つ減った）への cross-link | 同上 |

3 章の frontmatter は `verified-against: 66efda5` / `verified-at: 2026-09-08` に更新した。

#### 追従不要と判断したもの

- `docs/specs-v2/` / `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` / `sites/user/` / `docs/user/ja/USER_MANUAL.md`
  — この束は `packages/engine/` を 1 行も触っておらず、DSL 表面（構文・チェーンメソッド・宣言形式）も
  wire 契約も変わっていない。`SetBusLine` と DSL 表面は次の束（O3b / O-surface）
- `rust/crates/orbit-audio-daemon/src/test_tracing.rs`（#801）— テストハーネスのみ。dev サイトに該当章が無い
- `docs/design/611-output-line-design.md` — 起案時点のスナップショットなので後から書き換えない（ルーチン規約）

#### 検証

`npm run docs:build`（user / dev）と `npm run docs:check` を実行。結果は PR 本文に貼付。

出口の配線を入れ替える束。**振る舞いは変えない**ので、束の収束条件は
「**`OUTPUT_LINE_GOLDENS` / `O0-1` などの goldens が 1 つも動かないこと**」+ cargo 全緑 + 実機 gated 全件。
中身は PR-O3（`LineProgram` / `SetBusLine`）+ #773 + #801。

### fix(daemon): close the O-wire review round-1 findings (#611) (Sep 8, 2026)

**PR**: [#811](https://github.com/signalcompose/orbitscore/pull/811)（束 O-wire → main）/ **ブランチ**: `611-line-wire`

#### レビュー編成 — Fable を並行投入した（最後に回さない）

`/simplify` 4 エージェント（reuse / simplification / efficiency / altitude）と **Fable 設計監査を並行**起動。
**Critical 0 件**。発見クラスは規約どおり**直交**した:

| 層 | 見つけたもの |
|---|---|
| Sonnet 4 名 | 差分に**在る**ものの重複・冗長（4 件）|
| 🔴 **Fable** | 差分に**無い**もの — **silent な受理 2 件**・**UTF-8 の byte 境界**・**±12% で見逃せる誤りの具体的な範囲** |

#### 🔴 監査が main の読みを 2 箇所訂正した

1. 「bit 一致テストは変換の正しさしか見ていない」→ **静的な方は完全な同語反復**
   （`with_output_target` / `with_sends` は内部で同じ `LineProgram` を組む）。
   実行時の方は**別分岐だが両方とも新コード**。より正確だった
2. 「互換ミラーは特殊ケースの積み上げでは」→ **呼び出し元を追跡すると本番では常に `None`**。
   `with_routing_overrides` を呼ぶのは `output.rs` のテストだけで、
   実体は**旧経路との bit 一致を証明する現役の安全網**だった

#### 🔴 ±12% の許容で何が見逃せるか（監査が具体化）

| 誤り | 検出 |
|---|---|
| **`send` 係数 0.3 の誤り** | 🔴 **0.144〜0.456（−52%〜+52%）が通る** |
| 出力ゲイン ±1 dB / 全体の極性反転 / L/R 入れ替え | 通る |
| send の二重加算・消失 | 落ちる |

**穴は実在する。** これを知ったので cargo 層を厚くする判断ができた。

#### ポリシーを 1 つ決めてから適用した（指摘単位のローカルパッチにしない）

> **出口の配線において「未登録」「未配線」を silent に受理しない。**
> 反映されない入力（登録されていない bus、RT が実行しない op）は `Ok` を返さず `Err` にする。

このリポジトリでは「評価は成功するのに音が変わらない／変わる」形の欠陥が繰り返し出荷されている。
**silent な受理は、次の PR の配線忘れをそのまま本番へ通す。**

#### 直したもの

| # | 内容 |
|---|---|
| **A-1** | `set_bus_routing` が `bus_lines` に無い bus で **silent に `Ok`** を返していた → `Err`。🔴 **`Err` は atomic mirror と activation の両方より前**に返る |
| **A-2** | `Pan` / `Render` / `Link` を `validate_line_program` が受理し RT が無視 → `Err`。**「配線したらこの拒否行を消せ」とコメントに明記**（可用性ゲートであって形式制限ではない）|
| **A-3** | #773 が **UTF-8 の byte 境界**未対応（`data.toString()` per chunk で多バイト文字が U+FFFD 化）→ `StringDecoder` を **bridge dispatch の前段だけ**に。🔴 **`decoder.end()` を `flush()` の前**に置く（逆順だと最後の 1 文字が消える）|
| **B-1** | 実行時 bit 一致を **4 トポロジ**へ拡張（master のみ / sum のみ / output-only 更新で send 保持 / 2 send）|
| C-1〜C-4 | `BusLineInstaller` の重複定義 / sentinel デコード 2 箇所 / send オフセット 3 箇所 / `first_output` の三項分岐 2 箇所 |
| D-1〜D-3 | 退役 margin の論法を先例と書き分け / `Cell` の RT 専有は型でなく encapsulation 依存 / poisoning の注記 |

🔴 **A-3 の red-first が本物だった**: 修正前は実際に `"���本語の診断"` と化けていた。

#### 🔴 B-1 は要求より 1 段強く作られていた

bit 一致だけだと「**両方とも send を落としている**」場合も緑になる。
output-only 更新のテストが **「send バッファが非ゼロ」を別途 assert** しており、同語反復の穴が塞がれている。

#### なぜ (A) ではなく (B) を採ったか

監査は「旧 RT から bit-exact oracle を作る」(A) を推奨したが、**(B) トポロジを増やす**を採った。
理由: RT の shim 分岐（`legacy_targets` / `legacy_send_gains`）は**無改変の既存テスト 6 本が固定している**ので、
`shim ≡ program` を複数トポロジで示せば **推移的に「旧 RT ≡ program」**が言える。(A) より安く、ほぼ同じ強度。

#### 見送った指摘（理由つき）

| 指摘 | 見送りの理由 |
|---|---|
| RT の marking / execution 2 重 walk | **構造的**（`render_multi_feeds` が事前に完全な target を要求）・**パス数は元から 2 本**・**未測定**。2 人のレビュアーが独立に同判断 |
| `extension.ts` の stdout 二重 split | **#614 で穴を踏んだ高リスク領域**。軽微・未測定 |
| mono downmix の `0.5` が 2 箇所 | 意味論が違う（代入 vs 加算）|
| `LineControl` の薄いラッパー | 確信度 中・呼び出し側の書き換えを伴う・実害小 |
| `LineExchange` ≒ `ChainExchange` | 共有クレート抽出が要る・**PR-O6 まで形が固まらない** |

#### 監査の運用指摘 2 件も処理した

- **束の中身が正本とずれる**（O3b 分離）→ 計画 §1.10・§2.5 と設計 611 §12 に
  **PR-O3a / O3b の分割とその理由**を記録
- **追跡先が CLOSED 済み #801 のコメント**だった → issue
  [#813](https://github.com/signalcompose/orbitscore/issues/813) を独立して作成

#### 🔴 地図・計画・設計への反映が漏れていた（owner 指摘）

束を閉じる直前に owner から「先に送った内容は地図・設計・プランに反映してあるか」と問われ、
**一次ソースで確認したら不十分だった**。

| 文書 | O3a/O3b 分割 | 実機未検証の範囲 | #801 の実測訂正 |
|---|---|---|---|
| 地図 | 🔴 **無し**（「PR-O3」のまま）| 🔴 無し | 🔴 **「負荷依存」の古い記述が残存** |
| 計画 | ✅ | 🔴 無し | ✅ |
| 設計 611 | ✅ | 🔴 無し | — |

🔴 **地図の #801 行が「実測は負荷依存」のままだった。** これは同日の実測
（効く変数は `--test-threads`・除外実験で犯人は 1 本）で**否定された記述**である。
**古い事実が地図に残るのが一番まずい** — 地図は次のセッションが最初に読む層だから。

直したもの:

1. **地図 §4.A** — PR-O3 → **O3a / O3b**（可逆 vs 一方通行という分割理由つき）
2. **地図 #801 行** — 「負荷依存」を撤回し、`--test-threads` 依存と犯人 1 本の確定へ。**解決済みの印**
3. **地図 #773 行** — 解決済みの印 +「**UTF-8 byte 境界は直したが stderr 側（#756）は未対応**」
4. **設計 611 §10 冒頭** — 実機で一度も鳴っていない op の一覧 + **±12% で `send` 係数の −52%〜+52% が通る**根拠
5. **計画 §1.10 PR-O4 行** — 上記を「次の束で押さえる対象」として引き継ぎ

#### 🔴 スクリプトの成功出力を成果の証拠にしない（本日 2 回目）

設計 611 への書き込みが**一度空振りした**。見出しが
`## 10. E2E 項目（すべて MCP 経由…）` と括弧つきなのに `## 10. E2E 項目\n` をアンカーにしており、
`assert s.count(anchor)==1` が**部分文字列として成立してしまった**ため `ok` が出た。

**`ok` の後に grep で実在を確認したので気づけた。** 同日 1 件目はワークスペーステストの
中断ログを完走と読みかけた件で、いずれも「**実行が成功したこと**」と「**目的が達成されたこと**」を
取り違える型である。

#### 🔴 実機で検証されていない範囲（記録）

実機 gated が通している op は **{Rack, Output(Master,1.0), Output(Bus,1.0), Output(Bus,0.3)}** だけ。
**`Gain` op / `Device` 宛て / mono マージ / 複数 send / gain 0 での send 除去 は実機未検証**
（cargo の bit 一致では覆っている）。

---

### feat(daemon): line program and RT execution, legacy SetBusRouting mapped onto it (#611 PR-O3a) (Sep 8, 2026)

**Issue**: #611 / **ブランチ**: `611-o3a-line-program` → `611-line-wire`（小 PR）
**正本**: `docs/design/611-output-line-design.md` §5.1（型）・§5.3（RT アルゴリズム）

#### この PR の価値は「音が変わらないこと」にある

`OutputDest` / `LineOutput` / `LineOp` / `LineProgram` / `LineSlot` を新設し、RT の post-loop を
プログラム実行に置き換えた。**旧 `SetBusRouting` は内部で `LineProgram` を生成する形に写して互換を保つ。**
振る舞いを変えない配線の入れ替えなので、**「変わっていない」が最も決定的な検算**になる。

🔴 **wire（`SetBusLine`）と TS 側は含まない**（PR-O3b）。`LineOp::Pan` / `OutputDest::Render` /
`OutputDest::Link` は variant の定義のみで**実配線しない**（PR-O4 以降）。

#### 🔴 収束条件は満たされた — goldens は 10 桁一致

| golden | O3a 前（#773 の実機）| O3a 後 1 本目 | O3a 後 2 本目 |
|---|---|---|---|
| `noBus firstRms` | 0.0870166332**8518032** | 0.0870166332**7764678** | 0.0870166332**8789269** |
| `totalOverDry` | 1.3000000133**642298** | 1.3000000133**585945** | 1.3000000129**92668** |
| `effectOnly/dry` | 1.9952622670**586015** | 1.9952622670**915188** | 1.9952622669**054862** |
| `combined/dry` | 0.9999999201**338745** | 0.9999999201**503713** | 0.9999999200**459261** |

⚠️ **golden 定数（0.0846173）との +2.8% のずれは O3a 以前から存在していた**もので、±12% の
意味論許容に吸収されている。**この PR で動いたものは何も無い。**

#### 🔴 main の変異検証がテストの穴を 1 つ見つけた

`if !output.thru { … break }` は **2 箇所**ある。`if false {` へ変異させて実測:

| 箇所 | 役割 | 当初 | 修正後 |
|---|---|---|---|
| `output.rs:2161`（RT 実行側）| 加算の打ち切り | ✅ red | ✅ red |
| 🔴 `output.rs:2002`（**marking pass**）| `render_targets[target] = true` の打ち切り | 🔴 **70 件すべて緑**（生き残り）| ✅ **red** |

marking pass が止まらないと**本来描画されないバスが描画対象になり、自分のラインを実行して
master へ加算する** = **音が変わる**。**この束の収束条件が捕まえるべき種類の誤りが、
cargo 層では素通りしていた。**

対処として `marking_stops_before_bus_output_after_thru_false` と対照の
`marking_reaches_bus_output_after_thru_true` を追加（後段 inactive バスに sentinel 値を置き、
marking されれば zero-fill される／されなければ保存される、で区別する）。
🔴 **実装は 1 行も変えていない**（実装領域の SHA-256 照合で確認）。

#### 🔴 main が反証してほしい読み（Fable 監査へ回す）

互換の bit 一致テスト 2 本は「旧 API 構成」と「program 構成」を比べているが、
**O3a 以降は旧 API も内部で `LineProgram` を生成する**ので両方が同じ実行経路に収束する。
したがって保証されるのは**変換の正しさ**であって、
**「新しい RT 実行が O3a 以前と同じ音を出すこと」ではない。**
後者を保証しているのは**期待値を直書きした既存テスト（無改変）**と**実機 goldens（±12%）**だけ。

#### 退役規律は先例を踏襲した

`RetiredLineProgram::retired_at_generation` を**退役オブジェクト内**に保持する。
`orbit-effect-rack-child` の `StageList::retired_at_generation`（`:214, :247-249`）が
**「別の atomic をポインタの隣に置く形」を明示的に棄却している**ので、それに倣った。
世代は RT が `finish_generation()` で進め、**描画対象でない stage も含む全 stage** に対して
呼ぶので、非アクティブなバスの退役分も回収される。

#### 検証（🔴 すべて main が sandbox 外で実行）

| 何を | 結果 |
|---|---|
| `cargo fmt --all --check` | exit 0 |
| `cargo clippy --workspace --all-targets -- -D warnings` | exit 0 |
| `cargo clippy`（`outproc-effect,outproc-instrument`）| exit 0 |
| `cargo test --workspace --locked` | **608 passed / 0 failed / 38 ignored**（93 スイート・**完走マーカーで確認**）|
| `cargo test -p orbit-audio-native --lib` | **72 passed / 0 failed / 2 ignored** |
| 互換 bit 一致 2 本 | pass |
| 🔴 変異（marking pass）| 修正前 = 生き残り → 修正後 = **red** |
| 実機 gated（静穏時）| **29 passed / 1 failed** = `steps the live playhead`（**既知の main baseline**）のみ |
| 既存アサーションの削除・変更 | **0 件** |

#### 引用の再アンカー（64 件・うち 10 件は引用元の変更）

`output.rs` を大きく触ったので dev サイトの引用が 64 件落ちた。

| 種類 | 件数 | 対処 |
|---|---|---|
| 純粋な行ずれ | 54 | `check-citations.mjs --fix` |
| 🔴 **引用元の移動** | **10**（ja/en 各 5）| **手作業で新しい位置へ付け替え** |

後者は `render_block_with_sources` / `advance_gain` の doc / `render_engine_with_sources` /
`sources.is_empty()` / `collect_source_feeds` の 5 箇所で、**中身は同じで位置だけが動いた**もの。
行数を変えずに開始位置だけを移した。

検証: `npm run docs:check` → **984 citations verified, 0 failed**。

🔴 **`--fix` の後に必ず残件を確認する。** 64 → 10 に減った時点で満足すると、
**引用元が変わった 10 件が古いコードを見せ続ける**。#773（80 → 6）でも同じ形だった。

#### 🔴 実機の赤を実装のせいにしかけた（本日 2 件目）

1 本目の実機で `#611 O0-1` が落ちたが、原因は RMS ではなく **ERROR 行の増加**だった:

```
engine lock contention (N total); a block was silently zero-filled — this self-heals next block
```

`session.rs:987` の**既存**の WARNING（#401・engine 内部 Mutex の `try_lock` 失敗を可視化）で、
O3a の差分には無い。しかし **O3a 前の実機ログでは 0 回**だったので「無関係」とは言えず、
`LineSlot::install` が control 側で `Mutex` を取ることもあって**因果があり得た**。

**静穏時に測り直したら contention は 0 回・O0-1 は緑**だった。1 本目は `syspolicyd` が 30%
動いている最中の実行だった。

🔴 **本日 2 件目**（1 件目は `pipelined_host_with_real_child_is_gain_delayed_one_block`）。
**実機の赤は、実装を疑う前に静穏時に測り直す。** macOS のセキュリティ評価
（`syspolicyd` / `XprotectService`）は数十秒〜数分の単位で走り、その間だけ実機テストが落ちる。

---

### fix(test): anchor the tracing callsite interest so capture cannot go empty (#801) (Sep 7, 2026)

**Issue**: #801 / **ブランチ**: `801-tracing-interest-anchor` → `611-line-wire`（小 PR）

#### 実害 — ステージ 2 の 1 本目を出す前に 2 回起きた

`rust-ci.yml` は**全 PR で走る**。`device_switch_result_records_failure_and_success_through_the_same_path`
が `captured log: ""` で間欠的に落ちると、**赤の帰属ができなくなる**。

本日、**docs のみの PR 2 本**（[#800](https://github.com/signalcompose/orbitscore/pull/800) /
[#805](https://github.com/signalcompose/orbitscore/pull/805)・いずれも **Rust 差分 0 件**）で発生し、
#805 では**再実行（attempt 2）でも同じ失敗**をした。

#### 🔴 申し送りの前提が 1 つ崩れた — 「負荷依存」ではなく「スレッド数依存」

`/goal` は「**負荷をかけて再現条件を作れ**」だったが、**CPU 負荷は無関係だった**。
default feature の `--lib`（**55 テスト・1 回 0.01 秒**）を、負荷ゼロで 100 回ずつ:

| `--test-threads` | 失敗 / 100 |
|---|---|
| 1 | **0** |
| 2 | **16〜24** |
| 3 | 0 |
| 4（= `ubuntu-latest` は 4 コア）| **9** |
| 6 | **11** |

⚠️ `--test-threads 3` が 0 なのは**説明できていない**（不確実として残す）。
🔴 **CPU を 20 プロセスで飽和させた最初の試みは無駄足だった。変数の当て方を誤っていた。**

#### 🔴 除外実験で犯人を 1 本に確定した

| 条件（`--test-threads 2` × 100）| 失敗 |
|---|---|
| baseline（全 55）| **24** |
| `--skip select_audio_device_records_capture_owner_and_send_rejections` | 🔴 **0** |
| `--skip get_status_adds_effective_output_callback_state_and_last_switch_failure` | 22（**変化なし**）|

当初候補に挙げた `session::tests::get_status_...` は**無関係**だった（推測を実測が否定した）。

#### 機構（一次ソース `tracing-core 0.1.36`・設計は Fable・実証は main）

1. `never` を書くのは **初回登録（`DefaultCallsite::register`）の 1 回だけ**
2. 🔴 `MAX_LEVEL` の初期値は `OFF` で、マクロは `level_enabled!` を `interest()` より**先に**評価する
   → **犯人が初回登録者になれるのは、被害者が `Dispatch::new` を済ませた後だけ**（窓は数 µs）
3. 犯人が登録者になると `NoSubscriber` に解決して **`Interest::never()`** をキャッシュ
4. それが被害者の `rebuild_interest_cache()` **より後**・`error!` **より前**に着地すると **skip**
   （`never` は `enabled()` にフォールバックしない）

🔴 **2026-09-05 の緩和策のコメント「この順序依存を消す」は誤りだった。** 窓を狭めただけである。

#### 直し方 — グローバル「anchor」subscriber

`register_callsite` が**常に `Interest::sometimes()`** を返す subscriber を `set_global_default` で
1 回だけ入れる。以後どのスレッドが登録・再構築しても interest は `sometimes` に固定され
（`Interest::and` は異なる値なら `sometimes`）、判定は毎回**そのスレッドの `enabled()`** に落ちる。

`max_level_hint` は **`OFF`**。捕捉スコープが無い間は `MAX_LEVEL` が `OFF` のままなので、
**残り約 270 本の挙動とコストが現状と同一**（マクロが `level_enabled!` で短絡）。

#### 🔴 発注前に不確実性をゼロにした（最小クレートで 5 モード実行・各モード別プロセス）

| モード | 捕捉 |
|---|---|
| `baseline` / `preregistered`（`--test-threads=1` の形）| ERROR 行あり |
| **`race`** / **`firsthit-after-rebuild`**（実経路を順序づけた形）| 🔴 **`""`** |
| **`anchor`**（本修正）| ✅ ERROR 行あり |

`max_level_hint` を **`TRACE` と `OFF` の両方**で実行し、どちらでも `anchor` が捕捉できることを確認。
設計で唯一「中〜高」だった確信度を**実装発注の前に**潰した。

#### 入ったもの

| 場所 | 内容 |
|---|---|
| `test_tracing.rs`（新設・`#[cfg(test)]`）| `InterestAnchor` / `install_interest_anchor()` / 共通 `capture_tracing` / `simulate_subscriberless_rebuild` |
| `engine_wrap.rs` `EngineWrap::build` | `#[cfg(test)] install_interest_anchor()`。🔴 **`start_with` ではなく `build`**（`start_with` は integration test からも呼ばれ `cfg(test)` が付かない）|
| 捕捉 2 箇所 | 共通 helper へ。**誤ったコメントと `rebuild_interest_cache()` を削除**。重複していた writer 実装 2 つも 1 本化 |
| 決定論テスト | 犯人の実経路（別スレッド）+ 遅着 rebuild（別スレッド）の**両方**を置く |
| 衛生テスト | `with_default` 等が `test_tracing.rs` の外に現れたら赤（自分自身は `concat!` で除外）|

**犯人テストは書き換えていない** — subscriber を張らずに製品コードを呼ぶのは正当なテストで、
壊れていたのは**捕捉の仕組みの方**である。

#### 検証（🔴 すべて main が sandbox 外で実行した結果）

| 何を | 結果 |
|---|---|
| `cargo fmt --all --check` | exit 0 |
| `cargo clippy --workspace --all-targets -- -D warnings` | exit 0 |
| `cargo clippy`（`outproc-effect,outproc-instrument`）| exit 0 |
| `cargo test --workspace --locked` | **599 passed / 0 failed / 38 ignored**（93 スイート）|
| `cargo test`（feature 付き）| **326 passed / 0 failed / 13 ignored**（20 スイート）・`r9_missing_rt_ack` も緑 |
| 🔴 **red-first** | anchor の設置を外すと **`assertion left == right failed: captured log: ""` / `left: 0, right: 1`** |
| 100 回 × `--test-threads 2` | **0 / 100**（修正前 16〜24）|
| 100 回 × `--test-threads 4`（CI と同条件）| **0 / 100** |

#### 🔴 測定で 2 回つまずいた（同じ轍を踏まないための記録）

1. **空パスを実行して「100/100 失敗」と出した。** `ls -t ... | grep -v '\.d$'` が空を返し、
   `"" --test-threads 2` を 100 回叩いていた。**変数を表示していたので気づけた**
2. **中断された実行を「完走」と読みかけた。** ワークスペーステストが `orbit_effect_rack_child` の
   起動行で止まったログを、50 スイート分の集計で「455 passed」と報告した。
   🔴 **終了マーカー（`EXIT=`）を確認してから数字を使う。** 走らせ直したら 93 スイート・599 passed だった

#### 🔴 既知の赤を 1 件、台帳に足す

`pipelined_host_with_real_child_is_gain_delayed_one_block`（`orbit-audio-sandbox`）が 4 回連続で
落ちたが、**私の変更を外しても落ちた**。`docs/archive/WORK_LOG_2026-08.md:1557` に同じ記録があり、
原因は **macOS のセキュリティ評価**（実測: `syspolicyd` 42% / `XprotectService` 29%）。
**静穏になってから 3 回走らせると 0.1〜0.3 秒で pass**（負荷時は 7.00 秒 = タイムアウト）。
テスト自身が `#520` で「ビルド直後の child は macOS のセキュリティ評価で数秒〜24 秒止まりうる」と
警告している。**赤を実装のせいにする前に、静穏時に測り直す。**

#### 引用の再アンカー（22 件・すべて純粋な行ずれ）

`engine_wrap.rs` と `lib.rs` の行数が動いたので dev サイトの `// file:start-end` 引用が 22 件落ちた。
**今回は全件が純粋な行ずれ**で、`check-citations.mjs --fix` が再アンカーして解決した
（#773 のときは 80 件中 6 件が「引用元の変更」で手作業が要った）。

検証: `npm run docs:check` → **984 citations verified, 0 failed**。

🔴 **Rust / TS のどの PR でもこれは起きる。** `--fix` を掛けたあと**必ず残件を確認する**
（残るなら、それは行ずれではなく引用元が変わったということ）。

#### 触っていないもの（列挙として残す）

`orbit-audio-sandbox/src/transport.rs:3273` / `:3329` に**同型の脆さ**があるが、
**実害が観測されていない**ので本 PR の範囲外とした（束の差分予算）。
探索範囲つきの全列挙は [#801 のコメント](https://github.com/signalcompose/orbitscore/issues/801)に残した。
本筋は dev 専用クレート `orbit-tracing-testkit` へ抽出して両クレートで共有すること。

---

### fix(extension): buffer partial stdout lines before bridge dispatch (#773) (Sep 7, 2026)

**Issue**: #773 / **ブランチ**: `773-stdout-line-buffer` → `611-line-wire`（小 PR）

#### 何が壊れていたか

`setupStdoutHandler`（`extension.ts:1478`）は engine stdout を **chunk ごとに `output.split('\n')`**
していたが、**部分行を次の chunk へ持ち越していなかった**。JSON envelope が chunk 境界で割れると:

- 前半は `{"evalMark"` 等で始まるので分岐に入るが **JSON として不正** → 「malformed」警告
- 後半は prefix 判定を**すべてすり抜けて通常ログとして捨てられる**

→ **その要求の応答が失われる**。`evalMark` / `savePluginState` / `pluginUi` / `engineState` の
4 ブリッジすべてが同じ経路なので、MCP 経由の LLM と gated E2E が待ち続けて timeout する。

**この束で直す理由**: PR-O4 が `//#evalBegin` / `//#evalEnd` を導入して**この壊れたチャネルの
通信量を増やす**ので、増やす前に受け側を直す（計画 §3「ステージ 2 が実際に依存しているもの」）。

#### 直し方 — `createLinePrefixer` を **bridge dispatch だけ**に流用

同じファイルの `createLinePrefixer`（#756・`:1599`）が既に「`partial` を持ち越し、`end` で flush」の
正解形を持っていたので、それを **bridge の 4 分岐だけ**に被せた。

🔴 **ログ転写には使っていない。** 生 chunk と chunk 単位の `lines` は従来どおり即座に
`applyEngineStdoutChunk` へ渡すので、**ユーザーが見るログは 1 行も遅れない**し、
`createLinePrefixer` の空行除去も入らない。playhead / `//#selectAudioDevice` の呼び出し規約も不変。

buffer は `setupStdoutHandler` の**呼び出しごと** = process ごとに閉じているので、
stale な process の断片が現行 process の dispatch に混ざらない（#528 の stale ガードと同じ意図）。

#### 🔴 遅延は実際には起きない（一次確認）

バッファリングは「改行が来るまで待つ」ので、原理的には最後の 1 行が遅れうる。
だが 4 種の envelope はすべて `packages/engine/src/cli/repl-mode.ts` の
**`console.log(JSON.stringify(...))`** で出しており、`console.log` は**必ず改行を付ける**
（`:460` evalMark / `:167,177,482` savePluginState / `:244,250,440` pluginUi / `:332` engineState）。
したがって `end` の flush は**保険**であって、通常経路では発火しない。

#### 検証（main が sandbox 外で実行した結果）

| 何を | 結果 |
|---|---|
| `npm test`（全件） | **2324 passed / 58 skipped**（158 files passed / 4 skipped）|
| `npm run lint` | 緑（ESLint errors 0）|
| 🔴 **red-first**（main が実装だけ戻して実行）| **新規 7 本が red**。差分の実例: 期待 `{"savePluginState":{"requestId":...}}` に対し実際は **`{"savePluginState":{"reque`**（＝断片が dispatch されていた）|
| 等価ガード 2 本（ログ転写）| **前後とも緑** — 転写の挙動が変わっていないことの証拠 |

🔴 **委譲先の緑を根拠にしていない。** Codex は sandbox の loopback bind 制限で HTTP 系 31 件が
`listen EPERM` になり「all green とは報告しない」と正しく申告した。**その 31 件は main の
sandbox 外実行で緑**である（上表 2324 に含まれる）。

#### 追加したテスト（57 本中の新規 9 本）

| 何を | アサーション |
|---|---|
| 4 ブリッジそれぞれ、envelope を 2 chunk に割って投入 | `toHaveBeenCalledTimes(1)` + **完全な行**で `toHaveBeenNthCalledWith` + malformed 警告 **0 件** |
| 1 chunk に完成 2 本 + 末尾断片 | 完成分は**即座に** 2 回、断片は次の chunk で 3 回目 |
| 改行なしで `end` | flush されて**ちょうど 1 回** |
| process ごとの分離 | 別 process の断片が混ざらない |
| ログ転写（debug / 非 debug） | **即時・従来と同一**（空行の扱いを含む）|

#### 🔴 引用のずれを 2 種類に分けて直した（CI が捕まえた）

`extension.ts` に 49 行足したので、dev サイトの `// file:start-end` 引用 **80 件**が落ちた
（`code-review` ワークフローの `docs:check`）。**内訳は 2 種類で、直し方が違う。**

| 種類 | 件数 | 直し方 |
|---|---|---|
| **純粋な行ずれ** | 74 | `check-citations.mjs --fix` が再アンカー |
| 🔴 **本文の変更** | 6（ja/en 各 3）| **サイトが古い形のコードを逐語引用していた**ので、現在のコードで置き換えた |

後者は `{"evalMark"` / `{"pluginUi"` の分岐を引用していた 3 箇所（`editor/execution-feedback.md` /
`editor/mcp-and-gated-e2e.md` / `plugin-hosting/plugin-ui.md`）。分岐が `for` ループから
`createLinePrefixer` のコールバックへ移り、**インデントが 8 → 4 に変わった**ため機械的な
再アンカーでは合わなかった。地の文（「`setupStdoutHandler` に独立した分岐として置かれている」
「stdout ルータが `{"pluginUi"` の前方一致で拾う」）は現在も正しいので触っていない。

検証: `npm run docs:check` → **984 citations verified, 0 failed**。

🔴 **`--fix` の結果を確認せずに済ませない。** `--fix` 後もまだ 6 件落ちており、
そこだけが「行がずれた」ではなく「**引用元が変わった**」だった。件数が減ったことを
成功と読むと、古い記述がサイトに残る。

#### 直していないもの

`//#selectAudioDevice` も chunk 境界で割れうるが、そちらは既に専用の
「possible chunk-boundary split」警告を持っており、本 issue のスコープ外。
docstring の「chunk → 行の経路は 4 つ」の 3 番を現状に合わせて更新した。

---

### chore(docs): rotate WORK_LOG before the O-wire bundle (#804) (Sep 7, 2026)

**Issue**: #804 / **ブランチ**: `804-rotate-worklog`（main 直行・docs のみ）

#### なぜ今か — 束の途中で止まると commit ごと止まる

本体が **1,926 行**で上限 2,000 行（`tests/docs/worklog-size.spec.ts:19`）まで残り **74 行**だった。
束 O-wire（PR-O3 + #773 + #801）は小 PR を 3 本以上積むので、**束の途中で red になる**。

🔴 red になった時に止まるのは**テストではなく commit** — pre-commit フックが走るので、
「テストを直してから commit」ができない。2026-09-04 に実際に 2 回止まっており、
そのとき push だけが通って**中身の無いブランチを「push した」と報告**する事故になった
（`chore(hooks): verify a push actually landed (#742)` の記録・本 PR で archive へ移設）。
**着手前に片づけるのはこのため。**

#### 移設した範囲

| | |
|---|---|
| 移設 | 09-04〜09-06 の **19 見出し**（うち実エントリ 17・2 件は本文中のコード柵内） |
| 本体 | 1,926 行 → **1,141 行**（最新 20 エントリ = `PROJECT_RULES.md` §1a「latest 15-20 sections」） |
| 先 | `docs/archive/WORK_LOG_2026-09.md`（3,746 → 4,535 行）の新節 `## 09-04〜09-06 の追補` |

**本文は 1 文字も書き換えていない**（移設のみ）。アーカイブ側の H1 と本体末尾
`## Archived sections` の索引ラベルを `09-01〜09-05` → `09-01〜09-06` へ更新した。

#### 検証（結果を貼る・自己申告にしない）

| 何を | 結果 |
|---|---|
| `npx vitest run tests/docs/worklog-size.spec.ts` | **2 passed**（行数・索引の 2 件とも） |
| `npm run docs:check` | **984 citations verified, 0 failed** |
| 移設ブロックの同一性 | 🔴 `git show HEAD:...` の 1127-1911 行と archive 側を **文字列比較して一致**（`identical: True`）|
| 見出しの保存 | 39 → 本体 20 + archive 19（**欠落なし**）|
| 他文書からの名指し | `sites/**/*.md` に `development/WORK_LOG.md` の引用は **0 件**。既存の引用はすべて archive 側の `6.xxx` 番号なので影響なし |

🔴 **同一性を目視で済ませなかった理由**: 前回（2026-09-06）のローテーションは docs-sync の衝突解消と
重なって**見出しだけが本体に取り残される**事故を起こしている
（`docs: repair the orphan WORK_LOG headings the docs-sync merges left`・本 PR で archive へ移設）。
「移した」の自己申告ではなく、**移設元と移設先の文字列一致**を根拠にする。

---

### docs(planning): pull the CI flake (#801) into the O-wire bundle (Sep 7, 2026)

**ブランチ**: `801-pull-flake-into-o-wire`（main 直行・docs のみ・Closes #801 ではない — #801 は実装で閉じる）

#### 発端 — docs のみの PR で CI が落ちた

PR [#800](https://github.com/signalcompose/orbitscore/pull/800)（**`.md` 4 ファイルのみ・Rust 差分 0 件**）で
`fmt / clippy / test` が FAILURE になった。落ちたのは
`engine_wrap::select_audio_device_tests::device_switch_result_records_failure_and_success_through_the_same_path`
の **`captured log: ""`**（`engine_wrap.rs:10723`）。

🔴 **コード中のコメント自身がこの故障を記録していた**（`engine_wrap.rs:10704-10709`）:

> callsite の interest はプロセス全体で 1 つ。並列に走る別テストが同じ `tracing::error!` を
> **subscriber の無い状態**で先に踏むと `Interest::never()` がキャッシュされ、このテストの捕捉が**空**になる
> （**2026-09-05 に `--lib` 全件で 1 回発生**・単体と再実行では緑）。捕捉の直前に再構築して、この順序依存を消す。

**緩和策（`tracing::callsite::rebuild_interest_cache()`）は 2026-09-05 に入っているのに、09-07 に再発した。**
「この順序依存を消す」は達成できていない。→ **issue #801** を新規に立てた。

#### 実測（負荷依存・単一の失敗率は出さない）

| 実行 | 結果 |
|---|---|
| CI（ubuntu） | 🔴 **FAIL** → 再実行で **SUCCESS**（flaky の裏付け） |
| 手元 `--lib` 全件 × 5（他の処理と並走） | **2 FAIL / 5** |
| 手元 `--lib` 全件 × 10（アイドル） | 0 FAIL |
| 手元 当該テスト単体 × 10 | 0 FAIL |
| 手元 `--lib` 全件 × 5（`--test-threads=1`） | 0 FAIL |

⚠️ **途中で計測を 1 回壊した。** `$TMPDIR` がサンドボックスの内外で別を指すため
`> "$TMPDIR/a1.log"` のリダイレクトが失敗し、cargo の終了コードではなく**リダイレクトの失敗**で
「25 件すべて FAIL」に見えていた。書けるディレクトリを明示して取り直した値が上表。
🔴 **終了コードだけで判定せず、ログに期待する文字列（`captured log: ""`）が在るかで数え直した。**

#### 🔴 O-wire 束に引き込む（owner 2026-09-07）

計画 §3 の引き込み条件「**そのステージの受け入れ基準が依存しているものだけを、そのステージの
PR の中で直す**」に照らして引き込む。

**依存している根拠**: `rust-ci.yml` は**全 PR で走る**。間欠的に赤くなると
**ステージ 2 のどの PR でも「自分の変更のせいか」を切り分けさせる**ことになり、慣れると無視されて
ゲートが死ぬ — **#780 をステージ 2 の着手条件にしたのと同じクラス**。
**O-wire は Rust を触る束なので、この CI ジョブを最も多く回す。**

| 束 | 中身（更新後） | 概算 |
|---|---|---|
| **O-wire** | PR-O3 + **#773** + **#801** | 約 850 行 |

#### 反映先

- **実装プラン**: §2.5 束テーブル / §3 ステージ 2 の 3 束テーブル + 引き込みの理由 / 引き込み条件の表
- **地図**: §4.A の出口行 / §6.2 に **#801 の行を新設**
- **設計 611**: §12 の束テーブル
- Serena 引き継ぎメモリ + `/goal` プロンプト + auto-memory

#### 🔴 直し方は決めていない（未検証の仮説だけ残す）

`rebuild_interest_cache()` は**呼んだ時点**の interest を再計算するが、`with_default` のスコープに
入った後で**別スレッドが同じ callsite を subscriber 無しで踏む**と再びキャッシュが `never` へ倒れうる。
だとすれば「捕捉の直前に 1 回再構築」では足りない。**机上推論なので確定させず、
着手時に再現条件（負荷をかける）を作ってから直す**（#801 本文）。

#### 検証

- `npm run docs:check`: 984 citations verified / 0 failed
- `tests/docs/`: 2 passed

---

### docs(planning): split stage 2 into three bundles (Sep 7, 2026)
### docs(process): follow the three-bundle split into the workflow docs (Sep 7, 2026)

**追従元**: PR [#800](https://github.com/signalcompose/orbitscore/pull/800)（`799-split-stage2-bundles` → main・マージコミット `9672ba3`）/ **ブランチ**: `claude/docs-sync-pr800`

#### 何を追従したか

#800 は計画 §2.5 / 地図 §4.A / 設計 611 §12 の 3 点セットを直したが、**束テーブルの写しがもう 1 箇所ある**ことを拾えていなかった。`BUNDLE_BRANCH_WORKFLOW.md` §10 は旧 2 束（`O-dsl` = PR-O4・O5・O6・約 1,300 行）のまま残っていた。

| ファイル | 直した内容 |
|---|---|
| `docs/development/BUNDLE_BRANCH_WORKFLOW.md` §10 | 旧 2 束 → **3 束**（O-wire / O-surface / O-multiout）。検証列を追加し、**正本が計画 §2.5 である**ことを明記 |
| 同 §10.1（新設） | 3 束に切った 4 つの理由と払うコスト |
| 同 §5.1 | 🔴 **上限だけで切らず「検算の機会」でも切る**を一般規則として追加。数え方（**変更行 = `+` と `-` の合計**）も追加 |
| 同 §2 用語 | 「1 つの設計文書に対応する」→ **1 設計文書 = 1 束とは限らない**（611 は 3 束）|
| 同 §3 形 | 図の小 PR ラベル `O3 O4 O5 O6` を汎用の番号へ（1 束 = O3〜O6 ではなくなったため）|
| `docs/core/PROJECT_RULES.md` 束ブランチ運用 | 同上 2 点（1 設計文書 = 1 束ではない・変更行で数える）|
| `CLAUDE.md` 束の節 | 数え方と「検算の機会で切る」を 1 行で追記 |
| `docs/planning/IMPLEMENTATION_PLAN_2026-09.md` §3 | 🔴 **`#### 3 束に切る` が箇条書きの途中に空行なしで挿入されていた**ため、ステージ 2 の `- **結果**` / `- **確認**` / `- **閉じる**` 以降 20 行超が**この見出しの配下に回っていた**。見出しブロックをステージ 2 の末尾へ移動（**本文は 1 文字も変えていない**）|

#### 追従不要と判断したもの

`packages/` `rust/` の変更がゼロなので、DSL 仕様（`docs/specs-v2/` / `docs/core/INSTRUCTION_ORBITSCORE_DSL.md`）・ユーザー向け（`sites/user/` / `docs/user/`）・dev サイト（`sites/dev/`）はいずれも対象外。#800 は**まだ書かれていない PR の割り当て**を決めただけで、出荷された表面は変わっていない。



**ブランチ**: `799-split-stage2-bundles`（main 直行・docs のみ・Closes #799）

#### owner の問い

> ステージ２をいくつかの段階に分けて進めたいと考えています。キリのいい分け方はありますか？
> それともボリューム的に分けないでやっても問題ないですか？
> これは「分けろ」と言ってるのではなく**忖度ない進め方の意見**がほしいです。

**答え: 分ける。ただし理由は分量ではない。**

#### 3 束（計画 §2.5 が正本）

計画 §2.5 は既に **2 束**（`O-wire` = PR-O3 / `O-dsl` = PR-O4・O5・O6）だったので、**後者を割った**。

| 束 | 統合ブランチ | 中身 | 検証 |
|---|---|---|---|
| **O-wire** | `611-line-wire` | PR-O3 + **#773** | 🔴 **goldens が 1 つも動かないこと** + cargo |
| **O-surface** | `611-output-line` | PR-O4 + **daemon 台数のアサーション** | **E2E-2〜7 + E2E-10** |
| **O-multiout** | `611-multiout` | PR-O5 + PR-O6 | **E2E-9 + 全件緑** |

#### 🔴 切る理由（分量は四番目）

1. **O3 の検証は一度しか使えない機会。** PR-O3 は「旧 `SetBusRouting` の内部を program 生成へ写す
   （**互換維持**）」＝**振る舞いを変えない配線の入れ替え**なので、検証は「**goldens が動かないこと**」
   で済む（`OUTPUT_LINE_GOLDENS` / `O0-1` は実装済み）。**O4 と同じ束に入れるとこの検算は永久に失われる** —
   O4 は DSL 表面を変えるので goldens は*正当に*動き、「配線の入れ替えで音が変わったか」を二度と問えない
2. **O6 は旧経路を消す＝逃げ道を塞ぐ。** O4 と同じ束だと、赤が出たときに「新しい DSL が誤り」と
   「消したものがまだ必要だった」を区別できない。**逃げ道は O4 が実機で確かめられた後に塞ぐ**
3. **一方通行と可逆を混ぜない。** O4 は 🔴 一方通行（DSL 表面）、O5 / O6 は戻せる
4. **分量**: O4+O5+O6 = 約 1,850 **変更行**で束の上限 1,500 を超える

**払うコスト（正直に記録する）**: 束の締めのフルレビューが **1 回 → 3 回**。ただし束の中の小 PR は
どのみち分かれているので、増えるのは**締めのレビュー 2 回分**。

**採る根拠**: このリポジトリの反復する失敗モードは**帰属**である（#780 は仮説を 3 連続で外した。
E-gate をステージ 2 の前提にしたのも「毎回**自分の変更のせいかを切り分けさせる**」から）。

#### 🔴 訂正 2 件

| | #797 の記載 | 正しくは |
|---|---|---|
| daemon 台数のアサーションの置き場 | 「**PR-O6** と同じ PR」 | **PR-O4**。§1.10 の **O4 行の検証列が「E2E-2〜7・E2E-10」**と明記しており、**E2E-10（daemon respawn）は O4 の検証** |
| 束の「概算」行数の数え方 | 明記なし（旧「O-dsl 約 1,300 行」は net） | **変更行（`+` と `-` の合計）で数える**と §2.5 に明記。net だと同じ束が上限を跨いだり跨がなかったりする。**レビューが読む量は変更行** |

#### 反映先（3 点セット）

- **実装プラン**: §2.5 束テーブル（3 束 + 数え方の但し書き）/ §1.10 の PR-O3〜O6 行に束と根拠 /
  §3 ステージ 2 に構造・4 つの理由・コスト
- **地図**: §4.A の出口行に 3 束 + 切る理由の注記 / §6.2 の #624（置き場を O4 へ訂正）・
  **#773（束 O-wire へ引き込み）**・**#777（backlog）**
- **設計 611**: §12「PR 分割」に束の対応と、O3 を単独にする理由・O6 を O4 と分ける理由

#### 検証

- `npm run docs:check`: 984 citations verified / 0 failed
- `tests/docs/`: 2 passed

---
### docs(planning): follow up PR #797 — split the E-router bundle in the summary rows and fix the PR-E8 call site (Sep 7, 2026)

**ブランチ**: `claude/docs-sync-pr797`（docs 追従ルーチン・**docs のみ**。実装とテストは触っていない）

**追従元**: PR [#797](https://github.com/signalcompose/orbitscore/pull/797)（merge commit `c1144bd`・head `f008705c`）。
CI は head `f008705c` に対して **3 件すべて緑**（code-review / fmt・clippy・test / license・dependency gate）。

#### 1. 束 E-router の「割った」が要約行に届いていなかった

#797 §3 は **束 E-router を束として持たず割る**（#773 → ステージ 2 の PR / #777 → backlog）と決めたが、
**同じ文書の要約行 2 つと地図の 1 節が旧のまま**だった:

| 場所 | 旧 | 直した内容 |
|---|---|---|
| `IMPLEMENTATION_PLAN_2026-09.md:325` | 束一覧に「E-router / PR-E12 / 約 240 行 / ステージ 2 と並行可」 | 打ち消し + §3 への差し戻し。順序制約は #757 着手時に #777 と畳んで満たす旨を明記 |
| 同 `:406` | 現況一覧に「🔴 #757 の直前に置く」 | 同上 |
| `DEVELOPMENT_MAP.md:1131` 手前 | 「束 E-router の収束条件」が束前提のまま | 改訂の見出しを前に置き、**着手の単位が変わった**ことと**目標は変わらない**ことを分けた |

**放置した場合の実害**は #797 自身が書いたものと同型 — 束一覧を読んだ次の人が `777-line-router` を切りに行く。
🔴 **決定を本文に書いても、同じ文書の要約表が古いままなら決定は伝わらない。**

#### 2. 🔴 PR-E8 の「唯一の使用箇所」が別のテストだった

#797 は `orbitAudioDaemonPids()` の唯一の使用を「`:5391` の **#779 sweep** テスト」と書いたが**誤り**:

- `:5391` / `:5399` は **`#606 E2E-K3`**（`tests/e2e/orbitstudio-mcp-gated.spec.ts:5385`）の内側
- #779 の sweep テストは `:5446` から始まり、**この関数を呼んでいない**

さらに「gated spec に台数のアサーションは無い」も不正確で、`:5399-5404` に
`expect(startedDaemonPids).toHaveLength(1)` が**在る**。ただしこれは
「**このテスト自身の start が増やした daemon がちょうど 1 台**」という**差分**の主張で、
PR-E8 の狙い「**各 phase 境界で daemon が高々 1 台**」（総数）ではない。
**結論（E2E-10 が偽緑になりうる）は変わらない**ので、根拠だけ差し替えた。

🔴 **教訓**: #797 が残した「**『無い』は探索範囲とセットでしか成り立たない**」の隣に、
**「唯一の使用箇所」は行番号ではなくテスト名で書く**を並べた。行番号だけなら、
それがどの `it(` の内側かを確かめずに書ける — 実際そうなっていた。

#### 3. 追従不要と判断したもの

- **用語 `段 N` → `ステージ N`**: 残っている `段` は `make-local-release.sh` の手順（656）と
  daemon `run()` の `段 0.5`（`sites/dev/rust-engine/`）だけで、#797 が**意図して残した**ものと一致
- **dev サイト en**: `sites/dev/en/editor/vscode-architecture.md:102` は元から `stage 1` と書いており、
  ja 側の rename に対する en の追従は**既に済んでいた**（片翼になっていない）
- **DSL / MCP / OrbitStudio の各層**: #797 は `packages/` `rust/` を 1 行も触っていないので、
  `docs/specs-v2/` `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` `sites/user/` に追従先は無い

### docs(planning): rename 段 to ステージ and stop treating the remainder as a checklist (Sep 7, 2026)

**ブランチ**: `796-correct-remainder-table`（main 直行・docs のみ）

#### owner の指示（引用）

> 段と言うのをちょっとやめたいので**ステージ**と呼びますが、**ステージ０、１を完璧を目指して
> ずるずるとやると機能実装に進まない**ので、ステージ２との関連を考えてステージ２と今の
> 残っているものをどう進めるのかを見直してみてください。

#### 1. 用語 — 「段 N」→「ステージ N」（201 箇所）

計画 / 地図 / USER_OUTCOMES / 設計 668・649・656・739 / dev サイト 3 章。

🔴 **機能内の手順を表す「段」は残した**: 668 §7.2「分割の順序」・§12 の起動 3 段・
656 の署名手順 12 段・地図の機能別テーブルの `| 段 |`・「フェーダーという段は作らない」
（#649 の主題そのもの）。**同じ字で別の意味なので、数字付きを機械置換したあと 1 件ずつ文脈を見た。**

🔴 **その見直しで、機械置換が 16 箇所を誤爆していたのを見つけて戻した。**
`段 N` という**形は同じでもステージではない**もの:

| 誤爆 | 実際の意味 |
|---|---|
| `656:§4.2 段 3` / `段 10` / `段 1-3`（11 箇所） | `make-local-release.sh` の**手順**（§4.2 は「段の並び」= 12 手順）と §5.3 の**署名の実測手順** |
| `sites/dev/rust-engine/index.md` の `段 0.5`（3 箇所）/ `oop-children.md`（2 箇所） | daemon の **`run()` の起動手順**（孤児 shm 回収の置き場） |

判定は**置換後の数字の範囲**で機械化した: プロジェクトのステージは **0〜8** しか無いので、
`ステージ 10` や `ステージ 0.5` が出たら誤爆と分かる。残す判断も 1 件ずつ文脈を見て確定した
（656 の 13 箇所のうち **2 箇所だけ**が本当に `IMPLEMENTATION_PLAN` のステージ 8 を指していた）。

**教訓**: 用語の一括置換は、**同じ字の別用法を巻き込む**。数字付きに絞っても足りない —
**置換後に値域で検算する**手を持つと、目視より確実に落とせる。

WORK_LOG の過去エントリと archive は**書き換えていない**（記録なので）。

#### 2. 🔴 残余を「全部やる」対象から外した — 引き込み条件を置く

> **そのステージの受け入れ基準が依存しているものだけを、そのステージの PR の中で直す。**
> 依存していないものは backlog に置き、**どのステージの完了条件にもしない。**

**なぜ安全か**: 未カバー語はラチェット（`dsl-e2e-coverage.spec.ts`）が**増加を止めている**。
**債務の上限は既に機械が押さえており、返済速度を急ぐ理由が無い。**
「残っている＝危険」ではなく「残っている＋**上限が無い**＝危険」で、後者は潰してある。

#### 3. 結合を測った結果 — 2 件だけ本当に結合していた

| 残り | 結合 | 根拠 |
|---|---|---|
| **PR-E8 の狭いスライス** | 🔴 **結合** | ステージ 2 の受け入れ基準 **E2E-10 が daemon respawn**（doc 611 §10）。#624 は「旧 daemon が残ると**両方がデバイスへ出力し capture には片方しか写らない**」。gated spec に台数のアサーションは無い（`orbitAudioDaemonPids()` の使用は `:5391` の #779 sweep だけ）→ **E2E-10 が偽緑になりうる** |
| **#773** | 🔴 **結合** | **PR-O4 が `//#evalBegin` / `//#evalEnd` を導入**（`extension.ts:3000-3033`）。#773 が落とすのは `{"evalMark"` を含む封筒 → **ステージ 2 は壊れているチャネルの通信量を増やす** |
| #777 / PR-E5 / E6・E7 / E9 / E16 | ⚪ 無関係 | E2E-0〜11 に一度も現れない。36 語も `pan` / `mute` / `loop` / `midi` 等で、ステージ 2 が触るのは `output` / `send` / `thru:` / `db:` / `outs:`。`pan` のライン要素化は doc 611 §2.4b が**別 PR**と明記 |

**束 E-router を割った。** #773 はステージ 2 へ引き込み、#777 は backlog へ。
🔴 **これでも #757 の順序制約は保たれる**（#757 はこの先。着手時に #777 と畳めばよい）。

#### 反映先

- 計画 §3「安全網の残余」— チェックリスト → **引き込み条件 + 結合の測定結果 + 進め方の表**
- 計画 §3 ステージ 2 — 「残余は着手条件ではない」に **2 件だけ引き込む**旨を追記
- 地図 §6.2 #624 行 — 狭いスライスをステージ 2 に引き込む旨（**issue 全体は backlog**）
- 設計 668 §13.5.4 — 「並行可」は**まだ全部やる前提**だったので、方針変更の注記を追加

#### 検証

- `npm run docs:check`: 984 citations verified / 0 failed
- `tests/docs/`: 2 passed

---

### docs(planning): correct the safety-net remainder table (Sep 7, 2026)

**ブランチ**: `796-correct-remainder-table`（main 直行・docs のみ・Closes #796）

owner の「段 2 に着手するにあたって、並行でやる束もあるんだっけ？」に答えるため
**表を実物で読み直したところ、前日の PR #794 で自分が書いた行が 1 つ間違っていた。**

#### 🔴 誤りの中身

| 行 | #794 の記載 | 実際 |
|---|---|---|
| **PR-E4** | 「**部分**。正本 `dsl-surface.ts` が無い」 | ✅ **完了している。** 正本は `packages/engine/src/parser/dsl-surface.ts`（`DSL_SYNTAX_SURFACE` 13 件）で、ラチェットが `dsl-e2e-coverage.spec.ts:36` で import している。#668 のクローズコメントも PR-E4 を ✅（PR #715）と記録 |

原因は **`tests/e2e/` の下だけを探して `packages/engine/src/parser/` を見ていなかった**こと。
「成果物の実在で確認した」と表に書いておきながら、**探索範囲が狭くて不在と誤判定した。**

🔴 **教訓**: **「無い」は探索範囲とセットでしか成り立たない。** 不在を記録するときは
**どこを探したか**まで書く。書いてあれば、次の人はその範囲の外を疑える。
表の冒頭にこの注意書きを残した。

#### 精度が上がった行

| 行 | 旧 | 新 |
|---|---|---|
| **PR-E6 / E7** | ❓ 未確認 | ❌ **未カバー 36 語**（ラチェットの baseline が自認）: sequence 16 / global 7 / **syntax 13 件中 13 件** |
| **PR-E5** | ❌（`tests/docs/` を見た） | ❌（**リポジトリ全体を `find` で走査**）。加えて `dsl-e2e-coverage.spec.ts:219-222` が「A-10 は PR-E5 に割り当てられているが分割の隙間に落ちるのでここで塞ぐ」と明記しており、**ラチェット側も未存在を前提に書かれている** |
| **PR-E8** | ❓ `daemon-census.ts` は無い | ❌ **目的は未達だが部品は在る**。`orbitAudioDaemonPids()`（`:348-361`）は在るが使用は **1 箇所**（`:5391` の #779 sweep が起動前スナップショットに使う）。「各 phase 境界で daemon が高々 1 台」のアサーションは無い |

構文表面が 13/13 全部未カバーなのは、**正本を作る PR-E4 と埋める PR-E6/E7 が別作業**だからで矛盾ではない。

#### 段 2 と並行してよいもの（owner への回答）

- **束 E-router**（`777-line-router`・PR-E12・#777 → #773）— 🔴 **#757 の直前**。これが**唯一の順序制約**
- 束 **E-noise**（`775-capture-clock`・PR-E11・#775）— 🔴 **先に払わない**。段 2 の実機で U2 を観測してから
- 単発: **PR-E5**（#668-C）/ **PR-E9**（#640-A）/ **PR-E16**（#684）/ **PR-E6・E7**（#650 / #630 / #668-B）

#### 検証

- `npm run docs:check`: 984 citations verified / 0 failed
- `tests/docs/`: 2 passed

---

### docs(planning): record stage 0/1 completion and reshape the safety-net remainder (Sep 7, 2026)

**ブランチ**: `793-record-stage-state`（main 直行・docs のみ・Closes #793）

束 E-gate（PR #789・merge `900d4532`）が main へ入り段 1 も完了したので、**この時点の実状態を
地図・計画・設計へ反映**した。新しいセッションが引き継げるようにするのが目的。

#### 🔴 owner の指摘が起点

> 仕様とか PR の内容とか、いろいろ残して進めてきているので、**表面だけを見ずにきちっと
> エビデンスベースや議論の事実ベースで決めなきゃいけないこと**があるとかっていうのはこちらに聞いてください。

この指摘を受けて `/goal` の申し送りを鵜呑みにせず**一次ソースを読み直した**ところ、
**記録と実物のずれが 7 件**見つかった（直下の表の行数）。

#### 反映した内容

| 対象 | ずれ | 実際 |
|---|---|---|
| 計画 §3 段 1 | 「5 件」（#649/#645/#661/#606/**#385**） | owner が 2026-09-05 に **3 件へ限定**（#385 は「触らない」）。**段 1 は完了** |
| 計画 §3 段 0 | 閉じる条件に E-router と PR-E 群が残る | **目的（退行を機械で検出できる）は達成**（実機 29/30・新しい失敗ゼロ）。残りは **「安全網の残余」として段 2 と並行の別枠**へ（owner 裁定 2026-09-07） |
| 計画 §3 段 2 | 「着手条件」「#649 の改訂は裁定待ち」 | **着手条件は満たされた**。**#649 §7.3 / §10.1 の改訂は 2026-09-03 に済んでいる**（正本は doc 611） |
| 地図 §6.2 の #649 行 | 「spec 本文への反映はまだ」 | **反映済み**。残るのは core spec MX.3（`send` の線形 → dB）だけ |
| 地図 #779 / #780 の行 | #780 の原因が「move で保証されない」 | **その原因記述は誤り**。実際は `line!()` の定数展開によるパス衝突。対照実験が決め手 |
| 地図 | **#785 の行が無い** | 束 E-gate で新設した issue。追加した |
| 計画 §1.10 | **PR 番号が重複**（E10 / E11 / E12 が 2 回ずつ） | 後発 3 行を **E15 / E16 / E17** へ振り直した。「PR-E11 は済んだか」に**一意に答えられない**状態だった |

#### 🔴 同じ欠陥が設計文書 5 本にあった（見出しと本文の食い違い）

「§7.3 / §10.1 は裁定待ち」を 4 セッション延命させた原因を追ったところ、**doc 611 §14 の見出しが
`🔴 owner 裁定待ち` のままで、節末は「8 件すべて解消」と書いていた**。見出しだけを見る読み手には
未決に見える。同じ形を全設計文書で探したら **5 本**あった:

| 文書 | 節 | 実際 |
|---|---|---|
| `598-render-endpoint-design.md` | §16 | 9 件すべて ✅（2026-09-03） |
| `610-diagnostics-applicability-design.md` | §15 | 8 件すべて ✅ |
| `611-output-line-design.md` | §14 | 8 件すべて ✅・PR-O4 は着手可能 |
| `662-performance-and-visibility-design.md` | §17 | 6 件すべて ✅（回答ブロックが直下にある） |
| `694-session-log-editor-path-design.md` | §13 | 9 件すべて ✅ |

見出しを `✅ owner 裁定（… N 件すべて解消）` に直し、**なぜ食い違ったか**を各節に 1 ブロック残した。

🔴 **残る 6 本（#428 / #634 / #656 / #668 / #672 / #679）は本当に未決なので触っていない。**
一件ずつ表の行を読んで判定した（`✅` の付いた行数と本文の回答ブロックの両方を見る）。
**機械的に一括置換していたら、生きている裁定待ちを消していた。**

**教訓**: 節の状態は**見出しに出す**。本文だけを更新すると、目次と見出しが古い状態を配り続ける。

#### 段 0 の残り（成果物の実在で確認した）

| 項目 | 状態 |
|---|---|
| PR-E1 / E2 / E3 / E17 / #779 / #780 / #785 | ✅ 実在（E17 = 二重台帳。旧 E12 を改番）|
| **PR-E4** | **部分**（ラチェットは在るが正本 `dsl-surface.ts` が無い） |
| **PR-E5 / E9 / E16(root skip)** | ❌ 成果物が無い |
| PR-E6 / E7 / E8 | ❓ 未確認 |
| **束 E-router**（#777 / #773） | ❌ OPEN。🔴 **#757 の直前** |
| 束 E-noise（#775） | 段 0 から既に除外済み。**段 2 の実機で要否判断** |

**#543 / #650 / #630 / #624 / #640 / #684 が OPEN のままなのはこの残余のため。**
計画は「該当項目」と書いており、issue 全体が段 0 の対象だったわけではない。

#### 🔴 #385 は所属未定（owner 2026-09-07: 「今後決める」）

段 1 から外れたが、どの段で扱うかは未記載のまま。`must-fix` ラベルは維持（**演奏は壊れないが
利用者が機能に到達できない**種類）。

内容は **VS Code の Workspace Trust** の話で、macOS の署名や dylib とは無関係。
フォルダなしの単一ファイル起動（ライブコーディングの典型動線）だと未信頼 workspace が作られ、
**orbitscore 拡張も Claude Code 拡張も activation されない**（silent）。

⚠️ **本文の対策 2 に未検証の主張がある。**「`configurationDefaults` で
`security.workspace.trust.enabled: false` を既定化（**VSCodium 系カスタムの定番手法**）」に**出典が無い**。
同じ段落の前半（`workspaceTrust.ts` の probe）には「根拠:」と明記があるため、
**未検証の主張が検証済みの根拠と並んでいて区別がつかない**。`configurationDefaults` で
セキュリティ設定を上書きできるかも未確認。**本 PR では #385 の本文は触っていない**（記録のみ）。

🔴 **根拠を書くときは、どこまでが裏付けの範囲かも書く。**

#### この日の総括 — 「記録と実物のずれ」が同日 5 件

#780 の原因記述 / `Drop` がサイドカーを消していないという main の報告 / `ORBIT_GATED_ONLY` の位置づけ /
sweep の診断が `DaemonStartupError` で観測できるという主張 / #385 の「定番手法」。

**いずれも読んで筋が通るので誰も疑わなかった。** 確かめるコストは毎回極めて低かった
（`grep` 1 回・`sed -n` 1 回・対照実験 5 分）。文書は書いた時点では正しくても、
**コードが動けば黙って古くなる**。

#### 検証

`npm run docs:check` / `tests/docs`

### docs(dev-site): follow the E-gate bundle into the rack and hygiene chapters (Sep 6, 2026)

**ブランチ**: `claude/docs-sync-pr789`（base は `main`）

束 PR [#789](https://github.com/signalcompose/orbitscore/pull/789)（マージコミット `900d453` /
head `952a1c41`）への docs 追従。束の中間 PR（#783 / #784 / #788）はルーチンが個別に追従済み
（PR #786 / #787 / #790）だが、**束の締めで積んだ 2 コミット**（`809ea40` の `/simplify` と
`2aa42f9` のレビュー fix）は追従されないまま main に入っていた。ここはその差分に対する追従である。

#### 追従したもの

| 箇所 | 直した内容 | 差分の対応 |
|---|---|---|
| `sites/dev/signal-chain/index.md` / en 同パス | 新節「そのゲート自身が 2 つの欠陥を抱えていました（#780・#789）」を追加。`-- --ignored` が `#[ignore]` 付きのテスト**だけ**を走らせるため退行検知テストがどの自動経路でも走らなかったこと、`line!()` が定義位置で展開される定数で 4 fixture が同一 shm パスを共有し `create_shared` の `truncate(true)` が生きたマッピングを切り詰めていたこと、修正（`static AtomicU64` の連番）と退行検知テストを引用付きで記述 | `CLAUDE.md:665-669` / `rust/crates/orbit-effect-rack-child/src/tests.rs:646-654,670-676` |
| `sites/dev/editor/mcp-and-gated-e2e.md:1020` / en `:1024` | 「**8 本**すべて」→「**9 本**すべて」。`2aa42f9` が 9 本目（`keeps resolving at least one log-count helper from the real gated corpus`）を足したため。9 本目の説明段落と引用も追加 | `tests/e2e/gated-assertion-hygiene.spec.ts:688-703` |
| `sites/dev/rust-engine/index.md:870` / en `:897` | `outproc_shm_sweep.rs:134-163` → `:167-196`。`2aa42f9` が `sweep_orphaned_outproc_shm` の前に `tracing::debug!` と doc コメントを足して 33 行下がった | `rust/crates/orbit-audio-daemon/src/outproc_shm_sweep.rs:167-196` |
| `sites/dev/rust-engine/oop-children.md:628,667` / en `:654,694` | `orbitstudio-mcp-gated.spec.ts:5397-5462` → `:5445-5516`。`2aa42f9` が #779 の gated E2E より前に 49 行足した | `tests/e2e/orbitstudio-mcp-gated.spec.ts:5445-5516` |
| `sites/dev/editor/mcp-and-gated-e2e.md:1363` / en `:1373` | Sources の `gated-assertion-hygiene.spec.ts:1-68` → `:1-11,552-704`。`809ea40` が検出器を `scanGatedSources` へ抽出し `describe` が 552 行目へ動いた | 同ファイルの構造変更 |
| 上記 3 章の frontmatter | `verified-against` を `900d453` / `verified-at` を 2026-09-06 へ。冒頭 Note に #789 を追記 | — |

#### 🔴 行番号引用は「機械が見る形」だけが直っていた

`2aa42f9` は「行番号引用の off-by-one を 4 箇所訂正」と記録しているが、直っていたのは
**`// FILE:START-END` ヘッダ付きコードブロック**（`docs:check` が突合する形）だけだった。
**散文中の `path:line` と `## Sources` の箇条書きは機械検証の対象外**なので、同じ +48 / +33 の
ずれがそのまま残っていた。今回はそのうち **#789 の差分が動かしたと特定できるもの**だけを直している。

#### 追従不要と判断したもの

| 対象 | 理由 |
|---|---|
| `docs/specs-v2/` / `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` | DSL の構文・意味論は 1 行も変わっていない（`packages/engine/` の差分がゼロ） |
| `sites/user/` / `docs/user/ja/USER_MANUAL.md` | ユーザーが書く語は変わっていない |
| `docs/design/668-e2e-foundation-design.md` | この PR 自身が §13.5.3 の原因記述を訂正済み。過去の設計書は書き換えない |

**テスト・実装は変更していない**（ルーチンの禁止事項）。

### docs(dev-site): correct the hygiene-ratchet inventory after #785 (Sep 6, 2026)

**ブランチ**: `claude/docs-sync-pr788`（base は束の統合ブランチ `780-merge-gate`）

PR [#788](https://github.com/signalcompose/orbitscore/pull/788)（マージコミット `0bb337b` /
head `f3fd4d4`）への docs 追従。#788 は **テストのみのコード変更**（`packages/` / `rust/` は
1 行も触っていない）なので、追従先は dev サイトの「アサーション衛生」節に限られる。

#### 直したもの

| 箇所 | 直した内容 |
|---|---|
| `sites/dev/editor/mcp-and-gated-e2e.md:1020` / en `:1024` | 「**5 本**すべてがソース**文字列**を走査する」→ 「`describe('gated E2E assertion hygiene')` の **8 本**すべてがソースを**静的に読む**（多くは文字列走査、#761 と #785 の 2 本は AST）」。件数は #785 以前から陳腐化していて（7 本）、#785 の追加で 8 本になった。走査手段の記述も #761 の AST 化以降ずれていた |
| 同 `:1009` / en `:1013` | 「**後半 2 本**は片方向ずつを留めるペア」の指示対象が、#785 の `it` が 7 番目に挿入されたことで曖昧になった。stale ガードの 2 本を名前で名指しする形へ |
| 同 `:1007` / en `:1011` | ラチェットの**穴**を追記。provenance 追跡は 1 本の式の連鎖の中で閉じるので、件数を**ヘルパー関数の中で**作る形は名前によらず素通りする |
| 上記 2 ファイルの frontmatter | `verified-against: d2e94af` → `0bb337b`、冒頭 Note に #785 / PR #788 を追記 |

#### 🔴 #788 が「4 箇所すべて」と書いた形は、まだ 2 箇所残っている

新しい `logProvenanceStrictEqualityOffenders` は `get_log` の戻り値 → `.match(...).length` →
`toBe`/`toEqual` の連鎖を AST で辿るが、**`.match(...).length` がヘルパーの中にある**と辿れない。

| 箇所 | 形 |
|---|---|
| `tests/e2e/orbitstudio-mcp-gated.spec.ts:2601-2603` | `expect(countAttachFailures(afterShiftedAttachLog), ...).toBe(attachFailuresBeforeShifted)` |
| 同 `:2690-2692` | `expect(countAttachFailures(afterRestoredAttachLog), ...).toBe(attachFailuresBeforeRestored)` |

どちらも `countAttachFailures` → `tests/e2e/helpers/engine-log.ts` の `countLogMarker` を経由するため、
新ラチェットは**緑のまま**である。#788 本文の「🔴 除外リストは無い」は走査器の設計としては正しいが、
「機械的に全列挙した」の結果は 4 箇所ではなく 6 箇所だった。

🔴 教訓の反復: #761 は「名前で条件付けると漏れる」、#785 は「名前でなく値の出どころを見る」だった。
今回残ったのは **「値の出どころを見る」を 1 式の中でしか見ていない**ことによる漏れで、
**測定器の適用範囲そのものを機械で列挙していない**という同じ形をしている。

**テストは変更していない**（ルーチンの禁止事項）。

> 🔴 **追記（同日・main）**: 上の「まだ 2 箇所残っている」は**発見時点では正しく、その後解消した**。
> 束 PR [#789](https://github.com/signalcompose/orbitscore/pull/789) のレビューで **Fable 監査が
> 独立に同じ 2 箇所を報告**し、`2aa42f91` で
> **検出器を「形の列挙」から「log 由来の値を受けて件数を返す関数の解決」へ一段抽象化**（不動点まで
> 反復）したうえで 2 箇所も移行した。変異（ラッパー越しの形を復活）で赤・該当行の名指しを確認済み。
>
> **ルーティンと設計監査が、別経路で同じ穴に到達した**のは記録に値する。ルーティンは「ラチェットの
> 棚卸しを本文に書く」過程で、監査は「不在証明」の問いから。**測定器の適用範囲を機械で列挙していない**
> という同じ形を、両者が違う入口から見つけた。


### fix(test): close the review findings on the E-gate bundle (Sep 7, 2026)

**ブランチ**: `780-merge-gate`（束 PR [#789](https://github.com/signalcompose/orbitscore/pull/789) の
レビュー指摘。統合ブランチの先頭に積む）

レビュアー 4 名 + Fable 監査の結果。**Critical 0 / Important 4 / Minor 9**。
指摘単位のローカルパッチを避けるため、**修正の前にポリシーを 4 本決めてから**一括適用した。

#### 🔴 Important 4 件のうち 3 件は「差分に無いもの」だった

code-reviewer と comment-analyzer は Critical 0 / Important 0。彼らが見る層（差分に**在る**ものの
正しさ）には問題が無く、**差分に無いもの**（ラッパー越しの 2 箇所・走らない回帰テスト・届かない
診断）は別系統の目でなければ見えなかった。CLAUDE.md の「Sonnet チームと Fable は発見クラスが
直交する」がそのまま出た形。

| 指摘 | 出どころ | 処理 |
|---|---|---|
| 窓由来カウントの厳密等価が **2 箇所残る**（`:2603` / `:2692`）。`countAttachFailures` という**ローカル arrow ラッパー**越しなので **3 本のラチェットすべてが構造的に見えない** | Fable | **ポリシー 1**（下記）。2 箇所を移行し、束の主張を「4 箇所」→「**6 箇所**」に訂正 |
| 🔴 **回帰テストがどの自動経路でも走らない** | pr-test-analyzer | CLAUDE.md のマージ前ゲートに `--ignored` 無しの行を追加 |
| `probe_pid_liveness` の `Unknown` 分岐が無防備 | pr-test-analyzer | `pid=0` / `pid=u32::MAX` のテストを追加（実プロセス不要なので **ubuntu CI でも走る**） |
| sweep の診断が**起動成功時に構造的に到達不能** | silent-failure-hunter | **ポリシー 2**（下記）。提案された修正は却下 |

##### 回帰テストが走らなかった件（実測）

```
$ cargo test ... -p orbit-effect-rack-child --lib -- --ignored actual_fixtures_use_distinct_shm_paths
running 0 tests ... 19 filtered out          ← CLAUDE.md がゲートに指定したコマンド
$ cargo test ... -p orbit-effect-rack-child --lib actual_fixtures_use_distinct_shm_paths
test ... ok. 1 passed                        ← --ignored を外すと走る
```

`-- --ignored` は **`#[ignore]` を付けたテストしか実行しない**。#780 の回帰テストは実プラグイン
不要なので意図的に `#[ignore]` していない。したがって **CI（ubuntu なので `#[cfg(macos)]` は
存在しない）でもゲートでも二度と走らない**状態だった。`--include-ignored` はリポジトリで
1 箇所も使われていない（grep 実測）。**束自身の測定器が繋がっていなかった。**

#### ポリシー 1 — 「窓由来カウント」は**形**ではなく**出どころの連鎖**で閉じる

検出器はこれまで**値の形**を列挙してきた（名前 → `Before` の算術 → `.match().length` →
import した helper）。**ローカルラッパーは「次の形」**であり、1 つずつ足す限り必ず次が漏れる。

そこで形の列挙をやめ、**「log 由来の文字列を受けて件数を返す関数」を一般に解決**する
（`resolveLogCountHelperNames`）。関数宣言・arrow const のうち本体が第 1 引数に対する count 式で
あるものを helper として登録し、🔴 **集合が増えなくなるまで反復する**（ラッパーがラッパーを
包む場合に届くため）。

🔴 **私自身の列挙も一段手前で止まっていた。** 設計の「3 箇所」を疑って全列挙し 4 箇所を見つけたが、
その走査は `.match(` を手がかりにしていたので**ラッパー越しは最初から視野の外**だった。
「列挙を尽くした」と思ったときこそ、**何を手がかりに列挙したか**を疑う必要がある。

#### ポリシー 2 — 可観測性は「主張しない」。事実だけ書く

🔴 **silent-failure-hunter の提案（sweep を ready 行の後ろへ動かす）は採らなかった。**
`engine_wrap.rs:4797` が **engine 起動中に** master effect の shm を作る（ready 行より前）ので、
後ろへ動かすと自 PID 規則が**この daemon 自身の生きた shm を削除**する — この束が直したばかりの
SIGBUS のクラスを再導入する。レビュアーは TS 側と `main.rs` は読んだが `engine_wrap.rs` の
shm 生成までは辿っていなかった。**層をまたぐ契約は main が両層を読んで裁定する。**

指摘そのものは有効なので、届くようにする代わりに:

- E2E のコメントを**事実に訂正**（「起動失敗時には `DaemonStartupError` の診断として観測できる」は
  **偽**。`.stderr` を読む箇所はリポジトリに存在しない）
- 呼び出し順序の前提を doc に明文化（動かすと自分の shm を消す）
- 個別失敗に `tracing::debug!` で path と元 error を残す（既定の `info` では出ない）

#### ポリシー 3 / 4

行番号引用の off-by-one を 4 箇所で訂正（`:1396`→`:1397` 等）。`IMPLEMENTATION_PLAN` の PR-E13 行を
実態（6 箇所・provenance 検出器の新設）へ更新。ラチェットが**黙って空振り**する条件
（`engine-log` のファイル名変更）に赤を置いた。

#### 検証（main が実測）

| 項目 | 結果 |
|---|---|
| `gated-assertion-hygiene.spec.ts` | **29 passed**（25 → +4） |
| `tests/e2e/` 全体 | **106 passed / 37 skipped**（100 → +6） |
| daemon 両 feature | **275 passed / 0 failed**（274 → +1）・sweep のテストは **7 本** |
| `rack-child --lib`（`--ignored` 無し） | **16 passed**＝回帰テストが走るようになった |
| clippy **5 象限** | 4 象限 + `clap-host` すべて exit 0 |
| `typecheck:e2e` / `fmt` / `docs:check` | exit 0 / exit 0 / **978 verified 0 failed** |
| 🔴 **変異**（ラッパー越しの形を復活） | **赤・該当行を名指し**（`:2610`）→ 復元で 29 passed |

#### fix 差分の再点検（新しい故障モードは何か / どの実行コンテキストで走るか）

検出器の一般化は**より多く検出する**方向なのでリスクは偽陽性だが、最終判定は
`isLogDerivedText`（`get_log` 由来か）と AND されるため、引数が log 由来でなければ違反にならない
（陰性 corpus が境界を押さえている）。新コードの実行文脈は、検出器 = `npm test` 毎回、
`tracing::debug!` = daemon 起動時のみで既定フィルタでは出ない、`probe_pid_liveness` の 2 テスト =
実プロセス不要なので ubuntu CI でも走る、移行した 2 箇所 = 実機 gated のみ。


### refactor(test): apply the /simplify pass to the E-gate bundle (Sep 7, 2026)

**ブランチ**: `780-merge-gate`（束 PR [#789](https://github.com/signalcompose/orbitscore/pull/789) の
レビュー指摘。束運用どおり**統合ブランチの先頭に積む**）

`/simplify` の 4 観点（reuse / simplification / efficiency / altitude）を並行実行した結果。

#### 適用したもの

| 指摘 | 出どころ | 対処 |
|---|---|---|
| AST の走査骨格が **3 本目のコピー**（`sourceEntries` を回す → `createSourceFile` → 再帰 `visit` → `formattedNodeLine`） | reuse と simplification が**独立に一致** | `scanGatedSources(entries, makeOffenderAt)` を抽出し 3 本すべてを移行。`makeOffenderAt` はファイルごとに 1 回呼ばれるので、provenance 検出器の 2 パス前処理はそのクロージャに収まる。`createSourceFile` のエラー寛容性についての load-bearing なコメントも共有側へ移した |
| 🔴 **`countErrors` の別名で両方の検出器をすり抜ける** | altitude | provenance 検出器が `helpers/engine-log` からの import の**局所名**を解決し、`countErrors(<log 由来>)` / `countLogMarker(<log 由来>, ...)` も「件数」として追うようにした |

🔴 **altitude の指摘が的確だった**: 1 本目は `countErrors` を**リテラルな名前**で特別扱いしているだけなので、
`import { countErrors as ce }` にすると**どちらの検出器からも消える**。つまり 2 本目を作った目的
（名前依存の脆さの解消）が、1 本目の特例として**同じ脆さのまま残っていた**。

#### スキップしたもの（理由つき）

| 指摘 | 理由 |
|---|---|
| `newLogLines(...).filter(...)` を helper に畳む（simplification） | reuse が「確立済みイディオム」と判定して対立したので事実で裁定した。gated spec に **18 箇所**あり、新しい 4 箇所だけ畳むと**同じことを表す書き方が 2 つ並存**する。18 箇所すべての移行は束の範囲外（実機 15 分の回し直しも要る） |
| `sweep_dir` で `metadata()` を生存判定の後ろへ動かす（efficiency） | 正しい指摘だが利得が小さい。節約できるのは**生存 PID の orbit ファイル**の `lstat` だけで、定常状態は約 25 件、backlog の場合はほぼ全部 Dead なので `metadata()` は結局必要。検証済みの sweep とその分岐表テストを触る対価に見合わない |
| `create_shared` を `create_new(true)` にする（altitude Q1） | 筋は通るが **production の音声インフラの挙動変更**で、PID 再利用で同名の残骸があると**起動が失敗する**新しい経路を作る（sweep は 2 秒未満のファイルを残すので残骸が必ず消えている保証はない）。**別 issue に切った** |

#### altitude Q2 は設計の裏付けになった

「起動時 sweep は #448（SIGTERM ハンドラ）が入っても不要にならないバックストップか」への回答は
**Yes**。SIGKILL / OOM kill / panic-in-panic では、ハンドラを足しても `Drop` は走らない。
分割は妥当と独立に確認された。

#### 検証

| 項目 | 結果 |
|---|---|
| `gated-assertion-hygiene.spec.ts` | **25 passed**（corpus に陽性 1 + 陰性 1 を追加） |
| `tests/e2e/` 全体 | 100 passed / 37 skipped |
| `npm run typecheck:e2e` | exit 0 |
| 🔴 変異 1（helper 追跡を外す） | **新しい corpus が赤** |
| 🔴 変異 2（gated spec の 1 箇所を件数比較へ戻す） | **ラチェットが赤・該当行を名指し**（`:1643`） |


### docs: record the doc-sync review of PR #783 (Sep 6, 2026)

**ブランチ**: `claude/docs-sync-pr783`（doc-sync ルーチン・追従元は PR
[#783](https://github.com/signalcompose/orbitscore/pull/783) / merge commit `cac5c76`・
base は `main` ではなく束の統合ブランチ `780-merge-gate`）

PR #783（`fix(test): give every rack fixture its own shm path`）に対する追従レビュー。
**ドキュメントの実体的な追従は不要**と判断し、そう判断した理由と、追従できていない点を
ここに残す。

#### 追従不要と判断した理由

| 変更されたもの | 判断 |
|---|---|
| `rust/crates/orbit-effect-rack-child/src/tests.rs`（±24） | **テストのみの変更**。DSL 表面・MCP ツールの引数/返り値・評価経路のいずれも変わっていない |
| `CLAUDE.md` / `docs/development/BUNDLE_BRANCH_WORKFLOW.md` / `docs/design/668-e2e-foundation-design.md` / `docs/planning/IMPLEMENTATION_PLAN_2026-09.md` / `docs/development/WORK_LOG.md` | **ドキュメントそのものの修正**。下流に追従先が無い |

`ORBIT_GATED_ONLY` が実在しない env であるという記述訂正について、リポジトリ全体を
grep した結果、`sites/dev/` と `sites/user/` にはこの env への言及が 1 件も無く、
追従先が無いことを確認した。`sites/dev/` に
`rust/crates/orbit-effect-rack-child/src/tests.rs` の引用も存在しないため、
`// FILE:START-END` 引用の行ずれも発生していない。

#### 🔴 追従できていない点 1 — `-t` による絞り込みの記述が dev サイトと矛盾する

PR #783 は `CLAUDE.md:302` と `BUNDLE_BRANCH_WORKFLOW.md:71` で、小 PR のゲート
「その PR が足した E2E だけを実機で」の手段を **`ORBIT_GATED_ORBITSTUDIO=1` + vitest の
`-t`** と書き換えた。しかし dev サイトは、その `-t` が使えないことを記録している。

- `sites/dev/editor/mcp-and-gated-e2e.md:645` / `sites/dev/en/editor/mcp-and-gated-e2e.md:645`:
  「先頭の 1 本がアプリ起動・カタログ初期化・capture 付き engine 起動を担い、残りはその状態を
  前提にします（WORK_LOG 6.409 が『1 本だけを `-t` で絞ると `catalogClapEffectPath` 未初期化で
  落ちる』と記録しているのはこのためです）」

どちらが正しいかは**運用の判断**（先頭の 1 本を必ず含める形で `-t` を書くのか、
それとも段 2 のモジュール分割まで絞り込みは持たないのか）なので、doc-sync では直さない。

#### 追従できていない点 2 — 決定 D-4 は「入れる」のまま未実装

`docs/design/668-e2e-foundation-design.md:1082` の決定 **D-4** は
`ORBIT_GATED_ONLY` を「**A**: 入れる」で確定しており、`:428` の §7.2 段 3 にも
実行手段として載っている。PR #783 が訂正したのは CLAUDE.md 側の「既存の仕組みとして
参照していた」誤りであって、**決定 D-4 自体は未実装のまま残っている**。
設計文書は起案時点のスナップショットなので doc-sync では書き換えない。

#### 追従できていない点 3 — 回帰ガードが CI から見えない

`actual_fixtures_use_distinct_shm_paths`（`rust/crates/orbit-effect-rack-child/src/tests.rs:670-676`）
は `#[cfg(target_os = "macos")]` なので、`rust-ci.yml`（全ジョブ ubuntu）では**存在すらしない**。
無条件マージゲートを守るガードが、CI からは 1 度も走らない位置にある。PR #783 の WORK_LOG も
この事実を書いているが、`release.yml`（macos-14）は `pull_request` の paths フィルタに
`rust/**` が無いため、ここでも走らない。



### docs: sharpen the ORBIT_GATED_ONLY correction after the routine review (Sep 6, 2026)

**ブランチ**: `785-widen-count-ratchet`（束 `780-merge-gate`）

ルーティンの doc-sync PR [#786](https://github.com/signalcompose/orbitscore/pull/786) が、
**私が入れた訂正の精度不足を 2 点**指摘した。ルーティンは `docs:check` が見ない層
（引用を囲む本文の整合）を見るので、その指摘を反映する。

| 指摘 | 私が書いていたこと | 実際 |
|---|---|---|
| 1 | 「`ORBIT_GATED_ONLY` は**存在しない env**」 | 事実としては正しいが、**doc 668 の決定 D-4（`:1082`）で「A: 入れる」と確定済みの未実装機能**。誤りは「既存の仕組みとして参照していた」ことであって、名前を発明したわけではない |
| 2 | 「個々の絞り込みは vitest の `-t`」 | 🔴 **gated suite 本体では `-t` が効かない。** 先頭の 1 本がアプリ起動・カタログ初期化・capture 付き engine 起動を担い、残りはその状態に依存する（`sites/dev/editor/mcp-and-gated-e2e.md:645` / WORK_LOG 6.409 が「`catalogClapEffectPath` 未初期化で落ちる」と記録）。効くのは**自前でアプリを起動する自己完結テストだけ**（#779 の E2E は `launchIsolatedOrbitStudio` を呼ぶので `-t '779'` で走った） |

`CLAUDE.md:302` と `BUNDLE_BRANCH_WORKFLOW.md:71` の両方を実態に合わせた。

🔴 **私自身、#788 の PR 本文で「移行した 4 箇所を含む it は単独 `-t` では走らない」と書いていた。**
同じセッション内で片方に正しく書き、もう片方に不正確に書いていたことになる。ルーティンが
**両者を突き合わせた**ので見つかった。

#786 の 3 点目（回帰ガード `actual_fixtures_use_distinct_shm_paths` が `#[cfg(target_os = "macos")]`
なので ubuntu の `rust-ci.yml` からは**存在すらしない**）は事実。無条件マージゲートを守るガードが
CI から 1 度も走らない位置にある。**手元がこの検査の唯一の実行経路**という CLAUDE.md の記述と
整合しており、本 PR では変えない。


### test(e2e): widen the log-count ratchet to provenance, not identifier names (Sep 6, 2026)

**ブランチ**: `785-widen-count-ratchet`（束 `780-merge-gate` の小 PR・Part of #785）

束 E-gate の 3 本目。`get_log` の固定 500 行窓から数えた件数を**演算なしで厳密比較**している
箇所が残っており、既存の hygiene ラチェット 2 本はどちらも捕まえられなかった。

#### 🔴 対象は 3 箇所ではなく 4 箇所だった

設計（`668-e2e-foundation-design.md` §13.5.3）は `:1396` / `:1589` / `:1615` の 3 つを挙げていたが、
機械的に全列挙したところ **`:1378` の `.toBe(0)`** が漏れていた。

| 箇所 | 形 | 崩れ方 |
|---|---|---|
| `:1378` | `.toBe(0)`（`[OUTPROC_ATTACH_FAILED]` が窓に 0 件） | 🔴 **偽緑**（設計の一覧に無かった） |
| `:1397` / `:1590` / `:1616` | `.toBe(<countBefore>)` | 偽赤 |

**窓から流れ出る効果はカウントを減らす方向にしか働かない**ので、同じ 1 つの原因が比較の向きに
よって正反対の症状を出す。対処は 1 つ — 件数ではなく「**どの行が増えたか**」で語る
（`newLogLines`）。

対象外と確認したもの: `:1568` / `:1741` は `toBeLessThanOrEqual`。`stopsBefore`（`:2817` /
`:3060`）は `>` で比べる**待機の述語**でアサーションではない。

#### なぜ既存ラチェットが素通ししたか

1 本目（`bareErrorCountEqualityOffenders`）は検出条件が**識別子の名前**
（`/(?:errorsBefore|errorCount|catalogErrors)/i`）に依存している。実際の変数名は
`stoppedBeforeRejectedSave` / `attachFailuresBefore*` で一致しない。

🔴 **名前は書き手が自由に付けられるので、名前で条件付ける限り必ず漏れる。** #761 のラチェットが
「偽緑を防ぐために作られながら自分が偽緑の発生源だった」のも同じ構図（正規表現が `Before` で
**終わる**名前しか見ていなかった）。**測定器を名前で条件付けない**という教訓が 2 度目。

#### 変更

| ファイル | 内容 |
|---|---|
| `orbitstudio-mcp-gated.spec.ts` | 4 箇所を `newLogLines(before, after).filter(...)` → `toEqual([])` へ。`:1590` は before スナップショットがカウントのみだったのでログ本文を保持する形に変更。失敗メッセージに**増えた行そのもの**を出す |
| `gated-assertion-hygiene.spec.ts` | `logProvenanceStrictEqualityOffenders` を追加。**値の出どころ**を AST で辿る（`get_log` の戻り値 → `.match(...).length` → `toBe`/`toEqual`）。`?? []` の有無・分割代入・エイリアス・インライン形に対応。**除外リストは無い** |
| 同上 | 1 本目のコメントが「算術のない strict equality は逃げる。別 issue の対象」と書いていたのを実態に合わせて更新（4 箇所目も追記） |
| `sites/dev/editor/mcp-and-gated-e2e.md`（ja / en） | 引用の行ずれを `--fix` で貼り直し（**行番号だけの移動を差分で確認**）+ **3 本目のラチェットの説明を本文に追記**（`docs:check` は引用アンカーしか見ないので本文の陳腐化は機械が教えない） |

`toEqual([])` は「1 件も増えていない」という**より強い**主張であって緩和ではない。

#### 検証（main が本ツリーで実測）

| 項目 | 結果 |
|---|---|
| `gated-assertion-hygiene.spec.ts` | **23 passed**（新規 9 件: 陽性 4 種 + 陰性 4 種 + `toEqual` 確認） |
| `tests/e2e/` 全体 | **100 passed / 37 skipped**（6 files passed） |
| `npm run typecheck:e2e` | exit 0 |
| `npm run docs:check` | 972 verified / 0 failed |
| 🔴 **変異（1 箇所を件数の厳密等価へ戻す）** | **赤になり該当行を名指し**（`orbitstudio-mcp-gated.spec.ts:1643`）→ 復元で 23 passed |

🔴 委譲先は worktree に `packages/engine/node_modules` が無く `tests/e2e/` の 3 ファイルが
`uuid` 未解決で load 失敗すると報告したが、**本ツリーでは全件緑**だった。委譲先の赤も緑も、
main が回し直すまでは根拠にならない（本日 2 度目）。

#### 委譲先の切り替え

Codex が 2 回続けて**起動前に** sandbox に弾かれた（companion の git 利用 / 状態ディレクトリの
`mkdir` が `EPERM`）。「Codex が**使えない**」ケースなので規約どおり Sonnet subagent へ
フォールバックした（「収束しない」場合の main への昇格とは別の分岐）。


### docs(dev-site): document the startup shm sweep in RE-1 / RE-2 (Sep 6, 2026)

**ブランチ**: `claude/docs-sync-pr784`（PR [#784](https://github.com/signalcompose/orbitscore/pull/784)・
マージコミット `b513659` への docs 追従・base は束の統合ブランチ `780-merge-gate`）

#784 は dev サイトの**引用の行ずれ**（`lib.rs` / `main.rs` / `outproc_*.rs`）だけを直しており、
**sweep そのものの説明が本文に無い**状態だった。RE-2（OOP children）に節を足し、RE-1（daemon
アーキ概観）の #448 shutdown ギャップの節から繋いだ。

| ファイル | 内容 |
|---|---|
| `sites/dev/rust-engine/oop-children.md` / `sites/dev/en/rust-engine/oop-children.md` | 「起動時の孤児 shm 回収（#779）」節を新設（3 値述語・`Unknown` を残す理由・年齢下限・自 PID 規則と段 0.5 の関係・接頭辞定数の共有・サイドカーが同じ規則で拾われること・プロセス名照合を採らなかった理由・0 に収束しないこと）。frontmatter を `b513659` / 2026-09-06 に更新 |
| `sites/dev/rust-engine/index.md` / `sites/dev/en/rust-engine/index.md` | #448 の shutdown ギャップの節に「孤児化するのはプロセスだけではない」段落を追加し RE-2 へ接続。Sources に `outproc_shm_sweep.rs:134-163` と #779 / #784 を追加。frontmatter を `b513659` / 2026-09-06 に更新 |
| plugin-hosting / orientation / signal-chain / capture-verification（ja + en） | `## Sources` の行範囲が #784 の行ずれに追従していなかったので更新（`lib.rs:84-93`→`86-95` 他）。`## Sources` は `docs:check` の検査対象外なので機械的には落ちない |

DSL / MCP / OrbitStudio の表面は変わっていないので `docs/specs-v2/`・`docs/core/`・
`sites/user/`・`docs/user/ja/USER_MANUAL.md` は追従不要。

検証: `npm run docs:build`（user / dev 両方）・`npm run docs:check` を実行して緑。

### fix(daemon): unlink orphaned outproc shm at startup (Sep 6, 2026)

**ブランチ**: `779-startup-shm-sweep`（束 `780-merge-gate` の小 PR・Part of #779）

daemon が SIGTERM / SIGKILL / panic で死ぬと `Drop` が走らず、out-of-process の共有メモリが
`$TMPDIR` に残る（#779）。**起動時に孤児を回収する経路**を足した。

#### 🔴 起案時の前提のうち 2 つが一次ソースで否定された

| 前提 | 実際 |
|---|---|
| 「`Drop` がサイドカーを消していない」 | **誤り。** effect の `Drop` は `.chain.json` と `.apply.json` を両方消している（`outproc_effect.rs:1078-1088`）。**`:1077` で読むのを止めたのが原因** |
| 「`.respawn-args` が漏れている」 | **test 専用**。書き手は fixture script のみ、読み手 3 箇所はすべて test module 内 |

したがって **`Drop` には手を入れていない**。

#### 🔴 漏れるのは `pkill` の時だけではない

通常の `stop_engine` も `killChildGracefully` が **SIGTERM** を送り、daemon に SIGTERM ハンドラが
無い（`main.rs:21-25` が既知事項として記載済み）ので `Drop` は走らない。**engine を止めるたびに
約 25 ファイル漏れる**。

#### 設計（Fable 起案・main が 3 点を一次ソースで検証）

- **述語は 3 値**: `libc::kill(pid, 0)` を `Alive` / `Dead`(ESRCH) / `Unknown`(EPERM 等) に写す。
  🔴 **削除を許す腕は `Dead` と自 PID だけ**。`bool is_alive` にすると EPERM（プロセスは存在するが
  権限が無い）が死亡側へ落ちて**生きている shm を消す**
- 🔴 **プロセス名で「daemon かどうか」を照合する案は却下**。`cargo test` のテストバイナリも同じ
  名前の shm を作るので、照合すると**走行中のテストの mmap 先を unlink する** — #780 とまったく
  同じ故障を新しく作ることになる
- **年齢下限 2 秒**（TOCTOU の保険）。macOS では **mmap 経由の書き込みは msync まで mtime を進めず、
  SIGKILL でも進まない**ことを実験で確認したので、この下限は「起動から 2 秒未満で死んだ daemon を
  1 回先送りにする」以上の意味を持たない
- **置き場所**は `main.rs::run()` の `StartupOptions::from_env()` の後・`start_engine_with_device_switch`
  の前。🔴 **最初の shm 生成より前であることが自 PID 規則の正当性要件**
- 診断は **`tracing::info!` 1 行**。`eprintln!` は使わない（stderr は ERROR に分類され、gated の
  「ERROR 増 0」を自分で落とす）

#### 変更

| ファイル | 内容 |
|---|---|
| `outproc_shm_sweep.rs`（新規・cfg 無し） | 述語・parse・`sweep_dir`（純粋）・`sweep_orphaned_outproc_shm`（薄い殻）+ unit 6 本 |
| `main.rs` | 段 0 と段 1 の間で 1 行呼ぶ |
| `outproc_effect.rs` / `outproc_instrument.rs` | `unique_shm_path()` の `format!` を共有定数 `OUTPROC_SHM_PREFIX` で書く（生成側と走査側で名前がずれない） |
| `orbitstudio-mcp-gated.spec.ts` | gated E2E 1 本（死亡 PID のファイルを植えて消えること・**生存 PID のは残ること**を FS で確認） |

#### 検証（main が sandbox 外で実測）

| 項目 | 結果 |
|---|---|
| `check-cfg-matrix.sh --clippy` | **4 象限すべて緑** |
| `cargo test -p orbit-audio-daemon --features outproc-effect,outproc-instrument` | **274 passed / 0 failed**（protocol 32 passed） |
| sweep のユニット 6 本 | 全 ok |
| `npm run typecheck:e2e` | exit 0 |
| 変異 3 種（`Unknown` を削除側へ / 年齢下限 0 / 自 PID 規則を外す） | 委譲先が**それぞれ赤の実出力**を提出 |

🔴 委譲先が sandbox で「`tests/protocol.rs` 32 件 FAILED」と報告していたのは **localhost bind が
塞がれていたため**で、sandbox 外では 32 passed。**委譲先の赤も緑も、main が回し直すまでは根拠に
ならない**。

#### 🔴 これは緩和であって根治ではない

SIGTERM ハンドラの追加は別 issue（#448 / `main.rs` のコメントが「本 issue のスコープ外」と明記）。
掃除は**次回起動時**に効くので、定常状態は **0 ではなく 25〜60 ファイル**に収束する。

#### 検証時の落とし穴（実測）

`$TMPDIR` は実行環境で別のディレクトリを指す。**測るシェルは run と同じ環境でなければ意味がない。**

| ディレクトリ | 漏れ | PID 種類 |
|---|---|---|
| `/var/folders/kf/.../T`（通常起動の daemon） | 957 | 37（全部死亡） |
| `/tmp/claude-501`（sandbox 内のシェル） | 152 | 13 |


#### 🔴 実機 E2E は 1 回目が赤 — ただし「実装は正しく判定が間違っていた」

副オラクル（ログの `[outproc-shm-sweep] ... removed=` 行）が `removed=0` で落ちた。**その前の
ファイルシステムのアサーション 3 つは通っていた** — つまり掃除は実際に効き、死亡 PID のファイルは
消え、生存 PID のものは残っていた。

原因は `daemon-client.ts:891-910`。**ready 行が来るまで daemon の stderr は `stderrChunks` へ
溜めるだけで転送されない**（起動失敗時の診断用）。転送が始まるのは `collecting = false` の後で、
蓄積分が表に出るのは `:946` 以降の**エラー経路だけ**。sweep は最初の shm 生成より前＝ready 行より
前に走るので、**起動が成功する限りその INFO 行は `get_log` に現れない。**

設計は「tracing subscriber は `run()` より前に初期化済みだから届く」としていた。初期化の記述自体は
正しいが、障害は**受信側（クライアントの起動フェーズのバッファリング）**という一段外側にあった。
🔴 **「届く」を主張するには送信側だけでなく受信側まで辿る必要がある。**

これは欠陥ではなく設計どおり（「掃除が遅すぎて ready に間に合わない」という肝心の場合には
`DaemonStartupError` の診断として観測できる）ので、**E2E 側の副オラクルを外し、理由をコメントで
残した**。オラクルはファイルシステムのまま。

一度は「device 名の縮退警告も同じ理由で失われるのでは」と疑ったが**外れ**。縮退は
`device_fell_back` という構造化フィールドで ready の応答に載る（`engine_wrap.rs:4242`）。
issue は立てない。

#### 掃除が効いていることの実測

作業の途中で `/var/folders/kf/.../T` の `orbit-outproc-*` が **957 → 25** に落ちた。明示的に
掃除は実行していない。検証で回した `cargo test -p orbit-audio-daemon` の `tests/protocol.rs` が
daemon バイナリを spawn し、その daemon が起動時に 37 PID 分の孤児を回収したため。

🔴 **25 は設計の予測（1 daemon = master effect 1 + effect bus pool 8 + instrument slot 8 +
sum 4 + aux 4）とちょうど一致する。**

#### 🔴 dev 学習サイトの引用 24 件を CI で落とした（このブランチで `docs:check` を回していなかった）

`main.rs` / `lib.rs` / `outproc_effect.rs` / `outproc_instrument.rs` に行を足したので、
サイトが行範囲で引用している 24 箇所がずれた。**PR-E14 のブランチでは `docs:check` を回したが、
このブランチでは回さずに push した。**

- 22 件は `check-citations.mjs --fix` で貼り直し（**行番号だけの移動**を差分で確認した。
  `--fix` は「スニペットが移動しただけ」の時しか安全に使えない）
- 残る 2 件（`rust-engine/index.md` の ja / en）は**引用範囲の内部に行を挿入した**ので機械では
  直せない。`main.rs:78-133` → `78-136` へ広げ、逐語ブロックを差し替え、**本文にも段 0.5 の説明を
  足した**（`docs:check` は引用アンカーしか見ないので、本文の陳腐化は機械が教えない）

### docs: correct the ORBIT_GATED_ONLY reference — the env does not exist (Sep 6, 2026)

**ブランチ**: `780-fixture-shm-path`（束 `780-merge-gate` の小 PR）

束 E-gate の小 PR ゲートを実行しようとして、**手引きが実在しない道具を名指ししている**ことに
気づいた。

`CLAUDE.md:302` と `BUNDLE_BRANCH_WORKFLOW.md:71` が、小 PR のゲート
「**その PR が足した E2E だけを実機で**」の手段として `ORBIT_GATED_ONLY` を挙げていたが、
この env は**コードのどこにも実装されていない**（リポジトリ全体の grep で、この 2 つの
ドキュメント以外にヒットが無い）。

実在するのは:

| env / 手段 | 実体 |
|---|---|
| `ORBIT_GATED_ORBITSTUDIO` | gated suite 全体の on/off（`orbitstudio-mcp-gated.spec.ts:93` / `package.json:19`） |
| vitest の `-t` | 個々のテスト名で絞る |

両方の記述を実態に合わせ、`ORBIT_GATED_ONLY` が存在しないことを注記した。

🔴 **`docs:check` は引用のアンカーしか検査しないので、この種の「主張が実物とずれている」誤りは
機械が教えない。** 本日はこれで記録と実物のずれが 3 件目（#780 の原因記述 / `Drop` が
サイドカーを消していないという main の報告 / 本件）。いずれも読んで筋が通る内容だったため
疑われないまま残っていた。


### fix(test): give every rack fixture its own shm path (Sep 6, 2026)

**ブランチ**: `780-fixture-shm-path`（束 `780-merge-gate` の小 PR・Part of #780）

#780 の実体を直した。原因の特定と設計文書の訂正は直前のエントリを参照。

#### 変更

`ActualFixture::new` のパス生成を `line!()` から **`static SHM_SEQ: AtomicU64` の連番 + PID** へ。
production の `unique_shm_path()`（`outproc_effect.rs:318-325` / `outproc_instrument.rs:63-71`）と
同じ形に揃えた。`line!()` は定義位置で展開される定数なので、4 つの fixture が同一パスを共有し、
`create_shared` の `.truncate(true)` が他のテストの生きたマッピングを切り詰めていた。

#### テスト

`actual_fixtures_use_distinct_shm_paths`（**非 `#[ignore]`**）を追加。
`ActualFixture::new` を 2 回呼んで `path` が異なることを検査する。

🔴 **最初に提出された版はヘルパ関数だけを検査していて、`ActualFixture::new` に `line!()` を
書き戻しても緑のまま通った。** 差し戻して**実際の構築経路を通る形**にした。`line!()` を戻す変異で
赤になることを実出力で確認済み:

```
assertion `left != right` failed
  left: ".../orbit-rack-gain-41301-662.shm"
 right: ".../orbit-rack-gain-41301-662.shm"
```

`ActualFixture::new` は `create_shared` + `region_ptr` だけなので Gain.clap のバンドルは不要で、
`#[ignore]` にせず通常の `cargo test` で走る。ただし `ActualFixture` 自体が macOS 限定なので
`#[cfg(target_os = "macos")]` が付き、**CI（ubuntu）では走らない**。

#### 検証（main が本ツリーで実測）

| 項目 | 結果 |
|---|---|
| 無条件マージゲート `cargo test -p orbit-effect-rack-child --lib -- --ignored` を **10 回連続** | **10 PASS / 0 FAIL**（収束条件・修正前は並列 5 回で 1 FAIL） |
| `cargo clippy -p orbit-effect-rack-child --all-targets -- -D warnings` | exit 0 |
| `cargo fmt --all --check` | exit 0 |
| 残留 `orbit-rack-*` | 2（修正前からの残骸のみ。10 回回して増えていない） |

実装は Codex（`gpt-5.6-sol` / effort high）に委譲。検証は main が sandbox 外で実施した。


### docs(design): correct the recorded cause of #780 — a shared shm path, not a moved fixture (Sep 6, 2026)

**ブランチ**: `780-fixture-shm-path`（束 `780-merge-gate` の小 PR・Part of #780）

束 E-gate に着手し、#780（無条件マージゲートが SIGBUS / SIGSEGV で間欠的に落ちる）の
**設計文書に書かれていた原因が誤りだった**ことを実測で確認したので、実装より先に spec を訂正した
（PROJECT_RULES / CLAUDE.md 運用規則 6「spec が正本」）。

#### 何が誤っていたか

前日の記述は「`ActualFixture` が `_mmap`（実体）と `region`（その中を指す生ポインタ）を並べて
持ち、move すると両者の関係が型で保証されない」。**これは成り立たない**:

- `create_shared` が返すのは `MmapMut`。**構造体を move してもマップ先のアドレスは動かない**
  （`MmapMut` が持つのは (ptr, len) だけ）。`Box<dyn Any>` が実体を生かし続けるので
  `region` は有効なまま
- `KERN_PROTECTION_FAILURE` は「マップされているが書けない」であって、
  **ダングリングポインタの症状ではない**
- 🔴 この記述が示す修正方向（`region` を `_mmap` から導出する）では**故障が 1 つも直らない**

#### 実際の原因（実測で特定）

`ActualFixture::new`（`tests.rs:649-653`）が `line!()` でパスの一意性を作ろうとしているが、
**`line!()` はマクロを書いた位置（652 行目）で展開される定数**で、呼び出し元の行ではない。
`ActualFixture::new` を呼ぶのは `actual_gain()`（`:688`）1 箇所だけで、それを
**c16(`:711`) / c17(`:735`) / c18(`:760`・`:766`) の 4 箇所**が呼ぶ。したがって
**4 つの fixture がすべて同一パス `orbit-rack-gain-{pid}-652.shm` を共有していた。**

`create_shared`（`transport.rs:2031-2041`）は `.truncate(true)` で開くので、
**あるテストが他のテストの生きたマッピングを 0 バイトに切り詰める** → EOF の外側になった
ページへの書き込みで SIGBUS / SIGSEGV。スタック（`AudioChain::process_block` →
`AtomicUsize::store`）とも、スレッド絡みに依存する**間欠性**とも一致する。

| 実行形態 | 結果 |
|---|---|
| 並列（既定） | 5 回中 **1 回 FAIL**（`signal: 11, SIGSEGV`） |
| `--test-threads=1` | 5 回中 **0 回 FAIL** |
| `$TMPDIR` の残骸 | `orbit-rack-gain-81727-652.shm` が **1 個だけ**（4 fixture 分あるはずが 1 個） |

単一スレッドで落ちないのは、c18 が自分で 2 回束縛する分については切り詰めた後の古い
マッピングに触らないため。落ちるのは**テスト間の並列衝突**である。

#### 🔴 これで #780 の原因仮説は 3 連続で外れた

①漏れた shm ②`bundle-macos.sh` との競合 ③fixture の move。①②は前日に実測で反証済み、
③は**コードを読んだだけで実測しなかった**ために設計文書に載り、**直っても直らない修正方向まで
指示していた**。決め手はいずれも実測（クラッシュレポートの実スタック / 並列・単一スレッドの
対照実験）だった。**読んで筋が通ることは実測の代わりにならない。**

#### 変更

| ファイル | 内容 |
|---|---|
| `docs/design/668-e2e-foundation-design.md` §13.5.3 | 原因記述を差し替え。**訂正の記録を引用ブロックで残した**（同じ轍を踏まないため）。`$TMPDIR` 清掃を SIGBUS の説明に使っていた箇所も訂正 |
| `docs/planning/IMPLEMENTATION_PLAN_2026-09.md` §1.10 | PR-E14 の件名を `give every rack fixture its own shm path` に変更。依存を「PR-E10 の次」→「**PR-E10 と独立**」に（原因が #779 と無関係と判明したため） |

実装（パスを atomic カウンタで一意にする）は Codex に委譲。検証（10 回連続で緑）は main が
本ツリーで行う。🔴 **`--test-threads=1` を既定にする回避は採らない** — 欠陥を隠すだけで
並列環境で再発する。


### docs(planning): split the E-env bundle so stage 2 is not blocked by measurement noise (Sep 6, 2026)

**ブランチ**: `779-restructure-e-env-bundles`

owner の問い:「**段 0 が完全に収束するまで先に進めないのか？も検討したい。
先が長いので。着実に安全に進めたいが開発自体が停滞しないようにしたい。**」

#### 🔴 これで設計上の誤りが 1 つ見つかった

前日に E-env / E-router を「段 0 の完了条件から外さない」としたが、
**「段 0 の完了条件」と「段 2 に進む前提条件」を同一視していた。**

段 0 が守るのは「**退行を機械で検出できる**」こと。現在の実機は **27/29 が緑で、残る 2 件は
原因も帰属も特定済み**——**退行は既に検出できている**（新しい失敗が出れば区別がつく）。
E-env が直すのは「**測定のノイズを減らす**」ことであって、段 0 の目的そのものではない。
**目的の達成と品質改善を混同していた。**

#### 段 2 を止めるのは 1 件だけだった

| # | 段 2 を止めるか | 理由 |
|---|---|---|
| **#780** | 🔴 **止める** | **無条件マージゲート**なので段 2 の**どの PR でも毎回**落ちて切り分けを強いる。慣れると無視されてゲートが死ぬ |
| #779 | 止めない | ディスク・inode の圧力。掃除で回避できる |
| #775 | 止めない | 失敗が 1 件・場所が動くだけ。既知として扱える |
| 厳密等価 3 箇所 | 止めない | 対象が限定的 |

#### 2 束 → 3 束に再編

| 束 | 統合ブランチ | 中身 | 段との関係 |
|---|---|---|---|
| **E-gate** | `780-merge-gate` | #779 → #780 → 厳密等価 3 箇所 | 🔴 **段 2 の着手条件** |
| **E-router** | `777-line-router` | #777 → #773 → ring proxy | 並行可 |
| **E-noise** | `775-capture-clock` | #775 | 🔴 **段 0 の完了条件から外した**・並行可 |

**着手のゲートと束の完了条件を分けた。** 前者は軽く（#780 が 10 回連続で緑）、
後者は据え置き（gated 全件 3 回連続で失敗集合一致）。

🔴 **#775 は「必要かどうか」自体が未確定**。#779 / #780 を直すと消える可能性があるので、
**段 2 の実機で観測してから判断する**。3 回連続の実測（1 回 15 分 + 負荷待ち）は
この系列で最も重い投資なので、必要性が確定してから払う。

#### 🔴 #780 の原因を特定した（見積りのために実装を読んだ副産物）

```rust
struct ActualFixture {
    _mmap: Box<dyn std::any::Any>,                   // mmap の実体（型消去）
    region: *mut orbit_audio_sandbox::SharedRegion,  // その中を指す生ポインタ
}
```

`actual_gain()` がこれを**タプルで返し**呼び出し側が分解束縛するので、**move すると
`_mmap` と `region` の関係が型で保証されない**。`c18` は同じ `it` 内で 2 回束縛する。
SIGBUS が**間欠的**なのはこの不確定性と一致する。直す方向は
「`region` を生ポインタで持たず `_mmap` からその場で導出する」。

#### 反映先（3 層）

- 設計 `668-e2e-foundation-design.md` **§13.5.1 / §13.5.3 / §13.5.4**
- 計画 §2.5 束の割り当て・**§3 段 0 の閉じる**・**§3 段 2 に着手条件を新設**・PR-E11 の依存
- 地図 §4.G の 3 行

検証: `npm run docs:check` → 972 citations verified, 0 failed

---

## Archived sections

Older entries have been archived by month for readability:

- [2025-09](../archive/WORK_LOG_2025-09.md)
- [2025-10](../archive/WORK_LOG_2025-10.md)
- [2026-02](../archive/WORK_LOG_2026-02.md)
- [2026-04](../archive/WORK_LOG_2026-04.md)
- [2026-05](../archive/WORK_LOG_2026-05.md)
- [2026-06](../archive/WORK_LOG_2026-06.md)
- [2026-07](../archive/WORK_LOG_2026-07.md)
- [2026-08](../archive/WORK_LOG_2026-08.md)
- [2026-09（前半・09-01〜09-06）](../archive/WORK_LOG_2026-09.md)
