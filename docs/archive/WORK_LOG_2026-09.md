# WORK_LOG Archive — 2026-09（09-01〜09-12）

## 09-08 以前の移設（本体の 2,000 行上限・2026-09-11）

### 09-11 分の移設（本体の 2,000 行上限・2026-09-12）

### 09-11 分の追加移設（本体の 2,000 行上限・2026-09-12・#888 子 1 の追記で超過）

### 09-11/09-12 分の追加移設（#888 子 1 の第 5〜8 束で超過・2026-09-12）

### さらなる移設（#888 子 1 完了・子 2 着手で超過・2026-09-12）

### 09-12 分の追加移設（routine docs-sync PR #909 の追記で 2,000 行超過・2026-09-13）

### feat(dsl)!: drop the implicit master terminal — the score text is the whole truth (#883 bundle S) (Sep 12, 2026)

**Date**: 2026-09-12
**Status**: 実装・実機検証完了（レビュー前）
**版**: 🔴 **4.0.0 / `DSL_VERSION` 2.0**（破壊的変更）
**担当**: 実装 = Codex（`gpt-5.6-sol` / effort **xhigh**）/ 裁定と検証 = main

#883 の**振る舞いを変える**半分。束 0+C（PR #884）の上に載る。

#### 閉じた 4 実体（§0.1）— **1 箇所ではない**

| 実体 | 変更 |
|---|---|
| **A** `program()` の暗黙終端 | 合成を削除（`[rack]` の前置は残す） |
| **B** バス無し audio の直接描画 | `resolveDispatchChannel()` に skip。🔴 **`isNoteSequence()` の早期 return より後ろ**（前だと MIDI が無音・#282 の再発） |
| **C** daemon のバス既定ライン | `legacy(Master, [])` → **`[Rack]`（無音）** |
| **D** instrument の source routing | `SetSourceRouting.target` を**明示 3 値**（`none` / `master` / `bus`）へ。🔴 **一方通行の wire 変更** |

#### 🔴 横断規則を 6 箇所へ適用（main の審査で要求したもの）

> routing 状態が「書かれていない」「表現できない」「失われた」いずれかの時、その信号はどこにも加算されない。
> **master へ倒すことは最下層に暗黙 master を作り直すこと**である。

| 箇所 | 実装 |
|---|---|
| `SourceDestCell::encode` | `Bus(_) \| Link(_) => Self::NONE` ← **Fable の監査も見ていなかった箇所** |
| `SourceDestCell::decode` | `_ => SourceDest::None` |
| `SourceDest::default()` | `#[default] None` |
| `FeedDest` 変換 ×2 | `None => Discard` / `Link(_) => Discard` |
| slot 解放時 | `store(SourceDest::None)` ×2 |

**除外は master トラック自身の device 出口のみ**（owner 裁定で 1,2 固定＝定数なので規則の定義域外）。

#### 🔴 実機 gated が 4 件落ちた — **すべて譜面・harness の誤り**（実装は無変更）

| 失敗 | 原因 |
|---|---|
| 既存 `sum-bus insert across restart` | **移行漏れ** — 束 S で「出口を書かない sum は無音」になったので `sum("drum").output()` が要る |
| X1 / X4 / X5 | 🔴 **`LOOP()` は追加ではなく置換** — `LOOP(a)` の次の `LOOP(b)` が a を止める。根拠は `calculateLoopDiff()`（`process-statement.ts:679`）→ `stopSequences(toStop)`（`:777`） |

**main が先に潰した仮説**（unit で実測）: `ref883.output()` は skip されず（`{kind:'hardware'}`）、
4 イベントをスケジュールし、`loop()` も throw しない。**TS 層は正しい**。
崩れたのは「では実機の無音は実装のせい」という推論の方で、**`LOOP` の意味論**が抜けていた
（個別に `loop()` を呼ぶ unit では原理的に再現しない形）。

Codex は同じ誤用があった **X8 も落ちる前に先回りで修正**し、**静的回帰テストも追加**した
（`gated-assertion-hygiene.spec.ts:557`）。

⚠️ **ただしその検査は名指しの 4 ファイルしか守らない。** 3 本の新 fixture が揃って踏んだ性質なので、
**一般化する価値がある**（例: gated fixture 内に `LOOP(` が 2 回以上現れたら red）。別途扱う。

#### 実機 gated の実測（main が sandbox 外で）

```
Tests  45 passed | 1 skipped (46) | 0 failed

[#883 X1] explicit-reference + orphan RMS: 0.08701663328815765      ← 漏れれば 2 倍
[#883 X2] omitted=0.0870166332954772  explicit=0.08701663328808863
[#883 X3] sendRms=0.0436116233054862  plainRms=0.0870166332927243
          ratio=0.5011872058848396                                   ← 期待 10^(-6/20)=0.5012
[#883 X4] reference + unterminated-sum member RMS: 0.087016633295434
[#883 X5] withSilentInstrument=0.08701663329662541  refRms=0.08701663329662539
```

🔴 **X3 が #883 の実害そのもの**（`send(sum)` の dry が master へ二重に届く）**を実測で塞いだ証拠**。
🔴 **X5 は小数点以下 16 桁が一致** — 出口を書かない instrument は基準の音に **1 bit も足していない**。

#### ゴールの収束条件

1 ✅（X1/X4/X5）/ 2 ✅（X3）/ 3 ✅（X6）/ 4 ✅ / 5 は次（4.0.0 リリース）。

---

### feat: require explicit output routing across TS, wire, and the Rust runtime (#883) (Sep 12, 2026)

**Date**: 2026-09-12
**Status**: ✅ 束 S 実装

出口を書かない audio / instrument と、出口を持たない sum / aux を無音にした。routing の
未設定・表現不能・喪失は master へ倒さず discard する 1 規則に統一し、wire の source routing は
`none` / `master` / `bus` の明示 3 値になった。MIDI は audio の skip より先に hardware dispatch を
確定するため、#282 の挙動を維持する。

編集時には出口無しを Warning (`output-missing`)、aux send だけを Information
(`dry-not-routed`) として `.play()` に示し、どちらにも `.output()` の quick fix を提供する。
実機 gated E2E X1 / X3 / X4 / X5 / X6 / X8 は追加のみ行い、sandbox 外で実行する。

この互換性のない変更に合わせ、拡張を **4.0.0**、`DSL_VERSION` を **2.0** にした。
`ENGINE_VERSION` は独立軸なので **2.0.0** のまま。

### fix: make send() require a destination in both implementations (#883 round 2) (Sep 12, 2026)

**Date**: 2026-09-12
**Status**: ✅ ラウンド 2 収束（PR #884）

#### 🔴 縮小レビューが **fix 起因の Critical** を捕まえた

ラウンド 1 で置いたポリシーを、main が**片翼にしか適用していなかった**。

| | ガード |
|---|---|
| `Sequence.send()` | ✅ あり |
| `MixerBusHandle.send()` | ❌ **無い** |

レビュアーが実際に走らせて wire の中身まで示した:

```
mix.sum('drum').send(db: -6)
  → processArguments が [undefined, {db:-6}] に整形（ラウンド 1 の修正）
  → MixerBusHandle.send(undefined, ...) → resolveDest(undefined) → {kind:'master'}
  → setBusLine に output(master, thru:true, -6dB) が**追加で 1 本**
  → 既存の直結と合わせて **master へ二重に鳴る**
```

🔴 **#883 が消そうとしている「dry が master へ漏れる」の派生形を、修正が自分で作っていた。**

#### 直し方 — 契約を 1 関数へ

```ts
// audio-line.ts — この 1 関数が両方の send() の契約
export function assertSendDestination(value: unknown, call: string): void
```

`send()` の宛先は **`output()` と違い必須**（どこにも送らない send は無い）。両方の `send()` が
これを呼ぶので、**片翼だけに書けるコードでなくなった**。

あわせて `resolveDest` / `send` のエラー文言が常に「null」と決め打ちしていたのを、
**実際に来た型**を出すよう直した（数値や真偽値を渡した人に嘘の情報を与えていた）。

#### 変異検証（main が実走）

| 変異 | 結果 |
|---|---|
| `MixerBusHandle` のガードを削除 | **red**（1 件） |
| 文言を "null" 決め打ちに戻す | **red**（3 件） |
| restore | **green**（4 件） |

#### 波及

Codex がラウンド 1 で書いたテスト 2 箇所が**旧文言**を期待していたので整合させ、
「なぜ `send()` は `output()` と文言が違うのか」と**この Critical への回帰検査であること**を
コメントに残した。

#### 🔴 実機 gated が 1 回 flake した（規律どおり再実行して確定させた）

1 回目: `#611 E2E-3` が **`ENGINE_LOCK_CONTENTION`** で落ちた。

```
[warning] ENGINE_LOCK_CONTENTION: engine lock contention (1 total);
          a block was silently zero-filled — this self-heals next block
```

これは **`severity=warning` として設計された事象**（`rust/crates/orbit-audio-daemon/tests/protocol.rs:1204`）
だが、`mem:stderr-is-classified-as-error`（engine の warn は全部 ERROR 行）により
`expectNoNewErrors` が ERROR として数える。

**`mem:implementation-right-oracle-wrong`（赤を実装のせいにする前に同じテストを走らせる）に従い、
断定せず再実行** — load 5.62 → 2.76 で**緑**。孤児 daemon 0 / 残存 dev host 0 も確認済み。

🔴 **残る論点（この束とは独立）**: `expectNoNewErrors` は「新規 ERROR が 0」を要求するが、
CLAUDE.md の規律は「ERROR 件数は固定 500 行窓なので**厳密等価にしない**（`<=`）」。
`ENGINE_LOCK_CONTENTION` は負荷次第で正当に発生するので、**分類器が warning を ERROR へ畳んでいる**
ことを別途扱う余地がある。

#### 検証（すべて main が sandbox 外で実測）

```
npm test    2364 passed | 68 skipped | 0 failed
lint 緑 / docs:check 948 引用 0 failed
実機 gated  39 passed | 1 skipped | 0 failed
[#883 X2] omittedRms=0.08701663329564219  explicitRms=0.08701663329564278
```
---

### chore(release): bump the extension to 3.0.0 and the DSL spec to 1.2 (#843) (Sep 11, 2026)

owner 裁定 2026-09-11（#851 A-1）: **`v3.0.0` / DSL 1.2**。

## 🔴 動かしたのは 1 つだけ — 正本は拡張の package.json

`docs/design/656-release-design.md` §4.4 が版の所在を確定させている:

| 場所 | 規則 | 今回 |
|---|---|---|
| `packages/vscode-extension/package.json` | 🔴 **正本**。`.vsix` / `.app` / タグの版はこれ | **2.1.0 → 3.0.0** |
| `ENGINE_VERSION` | **別軸**（セッションログの meta ヘッダ）。同期しない | **2.0.0 のまま** |
| `DSL_VERSION` | **別軸**（spec 版）。同期しない | 1.1 → **1.2**（別軸の理由で動かす） |
| ルート `package.json` | `private: true` で配布物にならない | 触らない（裁定待ち (7)） |

`DSL_VERSION` を上げたのは「拡張が 3.0.0 になったから」ではなく、**DSL の表面が変わったから**
（`send` の dB 化・`output(dest, thru, db)` の導入・`pan` のライン要素化）。理由が別なので
数字も揃わない。

🔴 **私は一度これを間違えた。** 「拡張 package.json・`ENGINE_VERSION`・`DSL_VERSION` の 3 つを
揃える」と報告し、`/simplify` の Altitude が §4.4 を示して正した。
`ENGINE_VERSION 2.0.0` と拡張 `2.1.0` の食い違いは**事故ではなく設計**だった。

## なぜ major か

- `ORBITSCORE_ENGINE` 環境変数・`orbitscore.engine` / `scsynthPath` 設定・
  `Force Kill scsynth` コマンド・MCP `force_kill_scsynth` を**削除**した（#502）
- `send` が**線形係数から dB へ**変わり、既存の譜面の意味が変わる

## 追従した記述

root `README.md`（2 箇所）・`CLAUDE.md`・`docs/core/INSTRUCTION_ORBITSCORE_DSL.md`（2 箇所）・
dev サイトの `version.ts` 引用 4 箇所。いずれも「3 つは別軸」と明記して、
次に読む人が同じ取り違えをしないようにした。


#### owner 裁定（2026-09-11）と、リリース直前の README 2 件

正本 `docs/planning/NATIVE_MIGRATION_2026-09.md` §12.7 が **未決**として残していた 2 件に
裁定が出た。

| 未決だったもの | 裁定 |
|---|---|
| バージョン番号 | **3.0.0 / DSL 1.2**（`send()` の dB 化で既存譜面の意味が変わるので semver では major） |
| タグ名前空間 | **`v3.0.0`**。`ext-v*` / `app-v*` の分離はネイティブ版の新ラインで行う（§12.3）。`release.yml` のトリガーは `v*` のままでよく、ワークフローの変更は不要 |

残り 3 件は裁定待ちではなく既に解消済み: SC 削除 = #840 / gated ハーネス = #831 /
README の導線 = #842。Marketplace publish は「行わない」（owner 2026-09-10）で、
リポジトリ変数 `PUBLISH_MARKETPLACE` が未設定のため publish ステップは skip される（実測）。

**ついでに直した README 2 件** — どちらも「これから打つタグが何をするか」と食い違っていた:

- `tag push で全 channel に自動 publish` → 当時の計画である旨と、現在は GitHub Release だけが
  作られることを明記
- 「ICMC v1.1.0 bundle release」節の見出しに historical を付け、表が挙げている scsynth 同梱は
  #502 で削除済みで**現在の `.vsix` に scsynth は入っていない**という注記を足した

出荷される `packages/vscode-extension/README.md` は元から SC 参照 0 件で、Marketplace 非公開も
正しく書かれている（実測）。直したのはリポジトリ表紙の側。

ガードの実測: `checkTagAgainstVersion('v3.0.0', '3.0.0', 'darwin-arm64')` → `{ok: true}` /
`('v3.0.0', '2.1.0')` → 版が食い違うと fail（#853）。**バージョンバンプがタグより前に入る必要がある**
ことをこのガードが担保している。

検証: `npm test` 2,338 passed / 0 failed・`npm run lint` 緑・引用 944 / 0 failed。

### docs: land the nine routine docs-sync PRs as one roundup (#867) (Sep 11, 2026)

凍結版リリース（#827）のタグを打つ前に、溜まっていたルーティン docs 追従 PR **9 本**
（#837 / #844 / #847 / #856 / #858 / #862 / #864 / #865 / #866）を統合ブランチ
`867-docs-sync-roundup` で 1 本にまとめて main へ入れた。**docs のみ**で `packages/` `rust/`
`tests/` `.github/` は触っていない。学習サイトはリリースの一部なので、タグ前に反映させる必要がある
（owner 2026-09-11）。

#### なぜ 1 本にまとめたか — 逐次マージだと兄弟の内容が消える

9 本すべてが `WORK_LOG.md` を触り、#844 と #856 は 13 ファイルを共有、#837 / #862 / #865 は
`sites/dev/editor/mcp-and-gated-e2e.md` の**同じ Note 行と同じ節**に追記していた。1 本ずつ main へ
入れると残り 8 本を毎回再同期することになり、しかも従来の解決規則「WORK_LOG は両側・他は追従側を
採る」は、**main 側に兄弟 PR の内容が入った後では兄弟の内容を落とす**（規則が前提にしていた
「main 側 = 古い baseline」が成り立たなくなるため）。

#### 衝突の解決（全 22 hunk・いずれも同じ事実の別表現か、同じアンカーへの独立追記）

| 種別 | 解決 |
|---|---|
| WORK_LOG の同一アンカーへの独立エントリ（4 箇所） | 両方残す |
| #844 × #856 の SC 削除記述（11 ファイル・18 hunk） | hunk ごとに**情報量の多い側**を採る。`glossary.md` の Sources 一覧（ja/en）と `index.md` の Part VII 行（ja/en）は #844 側（#836 / #838 の粒度と `daemon-client.ts` の行がある）、残りは #856 側 |
| `mcp-and-gated-e2e.md` の Note 追従リスト（ja/en） | #830・#860・#855 の 3 件を**合併**。frontmatter は最新の `a6e1f13` / 2026-09-11 |
| 同じ章の新設節（#862 の `###` 節 × #865 の散文） | 両方残す。#865 の散文を先（直前の #756 段落から続く）、#862 の `###` 節を後 |

🔴 **1 件だけ「両方残す」では壊れた**: #865 は #857 の WORK_LOG エントリを Recent Work の先頭へ
**移動**していたので、素朴に両側を残すと同じエントリが 2 箇所に出る。移動先を残して旧位置
（54 行）を削除した。**「両側を残す」は追記には正しく、移動には正しくない。**

#### 検証

`node sites/dev/scripts/check-citations.mjs` **944 citations verified / 0 failed**（`--fix` は
使わず素で実行）/ `npm test` **2,338 passed / 67 skipped / 0 failed** / `npm run lint` 緑 /
`docs:build` dev・user 両方緑。

Closes #867

### docs(sites): re-anchor three citations #859 left pointing at the wrong code (Sep 11, 2026)

PR [#860](https://github.com/signalcompose/orbitscore/pull/860)（merge `e4d4199`）の追従。
#860 自身が `34e12b3` で dev サイトを更新しているが、**引用の再アンカーが 3 箇所ずれていた**。
`check-citations.mjs` は「引用文字列が実ファイルと一致するか」しか見ないので、
**別の関数に一致してしまった引用は緑のまま通る**。

| 箇所 | 何が起きていたか |
|---|---|
| `sites/dev{,/en}/signal-chain/mixer-audio-line.md` | bus post-loop の `LineOp::Output` 腕を引用していたはずが、`execute_master_line`（master 側）の `LineOp::Output` 腕に再アンカーされていた。直後の本文「`Output` として実行されるのは `Master` / `Bus` / `Device` の 3 つ」と引用が食い違う（master 側は `Device` 以外を `debug_assert!(false)` で落とす）。`output.rs:2566-2592` へ戻した |
| 同上（pan 節） | `apply_line_pan` の引用が切り詰められ、直後の本文が指す **`√2`** が引用内に無くなっていた。`√2` は #859 で `line_pan_coefficients` へ切り出されたので、その関数（`output.rs:2227-2243`）の引用を足した |
| `sites/dev{,/en}/rust-engine/index.md` | `render_block_with_sources` の引用が 4 行はみ出して `execute_master_line` のシグネチャを含んでいた。`1846-1932`（関数の閉じ括弧）で止めた |

あわせて、#859 が**コード引用だけ更新して本文を更新しなかった**箇所を直した
（`sites/dev{,/en}/rust-engine/index.md` の `advance_gain` 節）。旧本文の
「block が ramp より長ければ 1 回で目標へ到達」は、いまはブロック**終端**の値の話であって、
ブロック内は `ramp_frames` サンプルかけて補間される。これは #859 が直した欠陥そのものなので、
そのまま残すと修正前の振る舞いを説明する文が残ることになる。

4 章の `verified-against` / `verified-at` を `e4d4199` / 2026-09-11 に更新。

検証: `npm run docs:check` **938 citations / 0 failed** / `docs:build`（user / dev）両方緑。

---

### docs(sites): follow PR #861 — record the mirror-image consequence of line-wise ERROR prefixing (Sep 11, 2026)

PR [#861](https://github.com/signalcompose/orbitscore/pull/861)（#860・merge `5ed3ce5`）の追従。

IV-3 章（`sites/dev/editor/mcp-and-gated-e2e.md`）は #756 の「`ERROR:` 前置が chunk 単位
だったので ERROR 件数が**構造的に過小**だった」までを書いていたが、**その裏返し**を
書いていなかった。行単位になったということは「engine の stderr に出た行はすべて `ERROR:`」
であり、**正常系の `warn!` 1 行で件数テストが巻き添えになる**。#861 はまさにそれで、
`query_note_port_index` の warn が `default-baseline cycle must add no ERROR: lines`
（`tests/e2e/orbitstudio-mcp-gated.spec.ts:3426-3430`）を落としていた。

ja / en の両方に節を追加（STYLE_GUIDE のバイリンガル必須）。ERROR 会計という 1 本の
計測系に**測定器の側**（前置の粒度）と**被測定側**（engine のログレベル）の 2 つの入口が
あり、**直す場所が正反対**であることを本文に残した。

`verified-against` は据え置き。1 節の追記であって章本文の書き直しではなく、STYLE_GUIDE
§4「小規模 cross-link / 体裁修正のみは更新しない」と「実質的に書き直したとき」の中間に
あたるため、章冒頭の Note（この章が従来から追従履歴を書いている場所）に #861 を追記する
方式を採った。

検証: `npm run docs:build`（user / dev）緑 / `npm run docs:check` 緑。

### docs: follow PR #852 in the user site and the diagnostics chapter (Sep 11, 2026)

マージ済み PR [#852](https://github.com/signalcompose/orbitscore/pull/852)（束 B・`611-dsl-surface` →
main・merge commit `ded9709`）の追従。**ドキュメントのみ**の変更で、`packages/` `rust/` `tests/` は触っていない。

#852 は core spec（`docs/core/INSTRUCTION_ORBITSCORE_DSL.md` MX.2 / MX.3 / MX.4 / MX.5）と
specs-v2（`SIGNAL_CHAIN_DSL_SPEC_v1.md` SC.4）を自分で更新していたが、**ユーザー向けの 3 ファイルが
旧仕様のまま残っていた** — いずれも「dB 化は決まったが未実装」「send は post-fader 固定」と書いており、
実装済みの今は**読んだ人が逆の行動を取る**記述になっていた。

## 直したもの

| ファイル | 何が古かったか |
|---|---|
| `sites/user/mixing/routing.md` / `en/` | `send(name, amount)` が線形・dB 化は未実装・post-fader 固定 |
| `sites/user/reference/methods.md` / `en/` | 同上 + `output()` の宛先が sum のみ・`thru:` / `db:` 不在 |
| `docs/user/ja/USER_MANUAL.md` | `output()` / `send()` の宛先を「sum バス」と書いていた |
| `sites/dev/editor/execution-feedback.md` / `en/` | 診断 6 がミキサー宛先を除外するようになったこと（#852 の `diagnostics-analysis.ts:257-262`）が未記載 |

追記した利用者から見える表面（すべて #852 の差分から読み取れるもの）:

- `send(aux, db)` の単位が **dB**（線形 `0.3` 相当は `-10.5`）。`amount:` は loud に throw
- `send(aux, db, enabled: false)` はチェーン上の位置を保持したまま送出を止める
- `output(dest, thru:, db:)`。`thru: false`（既定）が終端・`thru: true` がタップ
- `send(name, db)` ≡ `output(name, thru: true, db: db)`
- 宛先の解決順: 解決済みノード → `"master"` → 宣言済み sum/aux → `"L,R"` → LinkAudio channel
- `effect()` / `gain()` / `pan()` / `send()` / `output()` は**書いた順に 1 本の線**に並ぶ
- `sum` / `aux` バスも `output()` / `send()` / `gain()` / `pan()` を受ける（`BUS_DSL_METHODS`）
- `master` はミキサーノード名として予約・`mix.output(1, 2)` はデバイスであって master ではない
- `mix.output(n)` の 1 引数形はモノラル（L+R マージ）

## 書かなかったこと（PR 本文の「確認してほしい点」へ回した）

- core spec MX.5 の「sum ネスト不可」と、同 PR が MX.2.2 に書いた「sum が別の sum へ出せる ✅」が
  **食い違って見える**。どちらが正しいかは仕様の判断なので追従作業では直さない
- `gain()` / `pan()` の固定値が**バス未確保の audio シーケンスでは発音側に留まる**という条件分岐は、
  ユーザー向けページには書いていない（内部の割り当て事情で、書くと「位置が効かない場合がある」と
  読めてしまう）

検証: `npm run docs:build -w @orbitscore/user-site` 緑 / `-w @orbitscore/dev-site` 緑 /
`npm run docs:check` **938 citations verified, 0 failed**。

### docs(sites): follow PR #857 — a benign warn is an input to the release gate (#855) (Sep 11, 2026)

マージ済み PR [#857](https://github.com/signalcompose/orbitscore/pull/857)（merge commit `a6e1f13`）への
ドキュメント追従。**実装とテストは変更していない。**

## 追従先

**`sites/dev/editor/mcp-and-gated-e2e.md` / `sites/dev/en/editor/mcp-and-gated-e2e.md`**（ja/en 両方）。

この PR が直したのは engine 内部の TOCTOU だが、**観測可能な表面は ERROR 件数**である。
IV-3 の「`get_log` とリングバッファ」節は、この計数が信用できない理由を 2 つ挙げていた
（固定窓による false green・#756 以前の chunk 単位前置による**構造的な過小**）。#855 は
その 3 つ目で、向きが逆の**構造的な過大**にあたるので、同じ節に並べて書いた。

- `temp-file-manager.ts:98-118` を引用し、per-entry の `try` が ENOENT だけを飲む形を示す
- #840 のマージ前ゲートで `expected 9 to be less than or equal to 8` として出た実測を明記
- ループ全体を囲む `try` だと ENOENT 1 件で残りが掃除されない副次問題も残す
- 一般則を #756 と対にして締める:
  **engine のどこかの `console.warn` 1 行が、そのままリリース可否ゲートの入力になる**

frontmatter は `verified-against: a6e1f13` / `verified-at: 2026-09-11` へ更新し、
冒頭 Note の追従リストにも #855 を足した。

## WORK_LOG の並びを直した

#857 の WORK_LOG エントリ（Sep 11）が、マージ時のコンフリクト解消（`1c3056a`）で
**Sep 10 の #611 エントリ群の間**に入っていた。本文は変えず、位置だけ Recent Work の
先頭へ移した。#857 は #860 / #852 より後のマージなので、そこが時系列上の正しい位置になる。

## 追従不要と判断したもの

| 対象 | 理由 |
|---|---|
| `docs/specs-v2/` `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` | DSL の構文・意味論・`.orbslog` 形式に変更が無い |
| `sites/user/` `docs/user/ja/USER_MANUAL.md` | ユーザーが書く語に変更が無い。temp 掃除は DSL から不可視 |
| `rust/` 側の章 | diff は TypeScript の engine のみ。MCP ツールの引数・返り値・エラー挙動は不変 |
| `sites/dev/audio/audio-file-playback.md` | slicing 章だが SC 経路の歴史的読解で、`TempFileManager` を扱っていない |

### fix(engine): stop a benign temp-dir race from inflating the ERROR count (#855) (Sep 11, 2026)

#840 のマージ前ゲートで実機 gated が 2 件落ち、うち 1 件がこれだった。

```
AssertionError: expected 9 to be less than or equal to 8
ERROR: Failed to cleanup old directories: Error: ENOENT: no such file or directory,
       stat '.../T/orbitscore_1789065642138_xx52jsw'
```

**原因は TOCTOU**（`temp-file-manager.ts:93-110`）。`readdirSync` で列挙してから `statSync`
する間に、**別のエンジンインスタンスの同じ掃除**が同じディレクトリを消す。gated suite は
エンジンを何度も起動・停止するので、複数インスタンスが同じ temp root を奪い合う。

`catch` は「Ignore errors during cleanup」と書いているのに `console.warn` を出しており、
engine の stderr 分類で **`ERROR:` 行になる**（memory `stderr-is-classified-as-error` の再発）。
**ディレクトリが既に無いのは、このループが望んでいた結果そのもの**で失敗ではない。

**副次**: `try` がループ全体を囲んでいたので、**1 件 ENOENT が出た時点で残りを見ずに抜けて**
いた。孤児が溜まる。

## 🔴 変異検証が別の穴を見つけた

修正のテストに変異をかけたところ、**`orbitscore_` 接頭辞の判定を外しても全テストが緑**だった。
この掃除は**共有の `os.tmpdir()`** を舐めて **1 時間以上前のディレクトリを消す**ので、
接頭辞判定は**他アプリの temp を消さない唯一の歯止め**である。テストを足した。

| 変異 | 結果 |
|---|---|
| ENOENT も含め全部握り潰す | 1 failed |
| ENOENT も再送出（元の挙動へ戻す） | 1 failed |
| 1 時間の条件を外す（新しい dir も消す） | 1 failed |
| **接頭辞の判定を外す** | **最初は 4 passed（すり抜け）→ テスト追加後 1 failed** |
| restore | 5 passed・baseline とバイト一致 |

## テストはモックを使わず実物のファイルシステム条件で書いた

`os.tmpdir` も `fs.statSync` も **再定義できない**（`Cannot redefine property`）ので、
最初に書いた `vi.spyOn` 版は動かなかった。差し替えではなく**本物の条件**を作った:

| 条件 | 作り方 | Node が出すもの |
|---|---|---|
| レース | dangling symlink | 本物の `ENOENT` |
| レースでない失敗 | 自己参照 symlink | 本物の `ELOOP` |
| temp root の差し替え | `process.env.TMPDIR`（POSIX は呼び出しごとに読む） | — |

`chmod 444` は使えなかった — constructor 自身の `mkdirSync` が先に落ちて **cleanup に到達しない**。

捏造した mock 文言を検証するのは、このプロジェクトが列挙している弱いアサーションの典型なので、
結果的に良い方向へ転んだ。

`npm test` 2,283 passed / 0 failed・lint 緑・`typecheck:e2e` 緑・引用 934 / 0 failed。

Closes #855

---

### docs(sites): re-anchor the release.yml line references shifted by #853 (Sep 11, 2026)

PR [#853](https://github.com/signalcompose/orbitscore/pull/853)（タグと `.vsix` の版を照合する
release ガード）が `.github/workflows/release.yml` の `Setup Node.js` の直後に **10 行**挿入した。
旧 58 行目以降がすべて **+10** ずれている。

## #853 が直したもの・残したもの

| 種別 | 追従状況 |
|---|---|
| ` ```yaml // .github/workflows/release.yml:84-90` 形式の引用ブロック 2 箇所 | ✅ #853 が `94-100` / `184-193` へ更新済み（`docs:check` が突合するため) |
| 本文中の散文的な行参照 | ❌ 取り残された。`docs:check` はフェンス付き引用しか見ないので red にならない |

## 直した 4 行

| ファイル | 変更 | 参照先の実体（現行 release.yml） |
|---|---|---|
| `sites/dev/rust-engine/index.md:329` | `:88` → `:90` | `cargo build ... --features outproc-effect,outproc-instrument` |
| `sites/dev/en/rust-engine/index.md:338` | 同上 | 同上 |
| `sites/dev/signal-chain/index.md:1616` | `:86-98,191-200` → `:88-100,184-193` | 実 Gain テストのステップ / `.vsix` 内 `std-plugins/Gain.clap` の同梱ゲート |
| `sites/dev/en/signal-chain/index.md:1653` | 同上 | 同上 |

いずれも**執筆時点では正しかった**（`28606fa` 時点で `release.yml:88` は features 行、
`84a29a5` 時点で `86-98` / `191-200` は当該ステップ）。行ドリフトで腐っただけで、
記述の内容そのものは変わっていない。したがって章の `verified-against` / `verified-at` は
**更新していない** — 章全体を検証し直してはいないため。

## 追従不要と判断したもの

- `docs/design/656-release-design.md` の行参照（`:114` `:224` `:245-248` 等）も +10 ずれているが、
  **設計書は起案時点のスナップショット**なので書き換えない（routine 規則）。報告のみ
- `docs/planning/IMPLEMENTATION_PLAN_2026-09.md:239` の `release.yml:116-207` も同様に +10 ずれ（→ `126-217`）。計画文書なので報告のみ
- `docs/specs-v2/` / `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` — #853 は DSL の構文も意味論も
  変えていない（`packages/engine/` に差分なし）
- `sites/user/` / `docs/user/ja/USER_MANUAL.md` — ユーザーが書く語に変更なし

### fix(clap-host): stop warning on the normal path for effects without note ports (#860) (Sep 11, 2026)

束 B の最終ゲートで `auto-records and restores all five plugin receiver kinds` が落ちた。

```
AssertionError: default-baseline cycle must add no ERROR: lines
  → expected 10 to be less than or equal to 9

[daemon] WARN orbit_clap_host::controller: [orbit-clap-host] NotePortsExtension なし; port 0 を使用
```

## 正常系で警報が鳴っていた

`query_note_port_index`（`controller.rs:400`）は **すべての CLAP ロードで無条件に**
呼ばれる（`:246`）。**エフェクトが note ポートを持たないのは正常**で、port 0 という
フォールバックも CLAP の慣習どおり機能する。それを `warn!` で報せていた。

## なぜ ERROR 件数に乗るか

拡張は engine の stderr を**全行 `ERROR:` として**出力する（`extension.ts:1453`）。
これは**意図的な設計**で、#756 の記録が理由を書いている:

> `outputChannel.append('ERROR: ' + chunk)` と chunk 単位で前置していた。1 つの chunk に
> 複数行入ると 2 行目以降に `ERROR:` が付かず、gated E2E の ERROR 会計が**構造的に
> 過小カウント**する（= 偽緑）

つまり「実エラーを取りこぼさない」ために全行前置している。**分類側を緩めるのは筋が悪い**
（取りこぼす方向へ戻る）。

🔴 したがって**ノイズは源で止める**。`warn!` → `debug!`。
memory `stderr-is-classified-as-error` は「engine の warn は全部 ERROR 行」を
**4 回目の再発**として記録しているが、これまでの対処はテスト側だった。今回は発生源を直した。

## 失う情報

instrument が note ポートを持たない場合も debug になる。ただし port 0 のフォールバックは
機能するので、これは「動かない」ではなく「既定を使った」の報告であり、debug が妥当。

検証: `cargo fmt --check` 緑 / `cargo clippy -p orbit-clap-host --all-targets -- -D warnings` 緑 /
`cargo test -p orbit-clap-host --lib` **29 passed**。

### fix(native): interpolate gain and pan ramps inside the block (#859) (Sep 11, 2026)

owner 裁定 2026-09-11（#851 B-1・**案 A**）。E2E-7 が測っていたのは**実装の欠陥**であって
オラクルの欠陥ではなかった。

## 何が壊れていたか

ゲインは**ブロックあたりスカラー 1 個**として掛かっていた。`ramp_frames` は 5 ms = 240 で、
実機のブロック長は **512**。`frac = min(512/240, 1.0) = 1.0` なので
**ランプが 1 ブロックで完了する**（= ブロック境界の段差）。

`gain(-40)` → `gain(0)` は振幅が 0.01 → 1.0 に**1 サンプルで跳ぶ**。
実測: 切替時の一次差分 `0.6996` vs 信号自身の最大スルー `0.0407` → **17 倍**。

`advance_ramped_gain` の doc は "One block of the **click-free** gain ramp" と書いていたが、
**出荷時のバッファ長ではこの記述は偽**だった。

## 🔴 私の最初の推奨（案 D）は誤りだった

「出力バッファ長を env 化して E2E-7 を 64 フレームで回す」を推奨していたが、owner の
「rampの粒度がそれでいい根拠を説明して」で一次ソースを読み直し、**2 つの理由で撤回**した。

1. **出荷される振る舞いを何も変えない。** 512 で走るユーザーには段差が残る
2. **E2E-7 すら通らない見込み。** 64 でも `frac = 64/240 = 0.2667` で 4 段の階段になり、
   最大段差 0.264 × ピーク振幅 0.707 = **0.187** > 閾値 `4 × 0.0407 = 0.163`

推奨する前にこの算数をやるべきだった。

## 案 A の要点: ブロック終端をビット一致させる

現行式 `current += (target - current) × min(frames/ramp_frames, 1)` は
「ブロック先頭の距離を `ramp_frames` で割った固定ステップ」と等価なので:

```
step  = (target - start) / ramp_frames
at(f) = end                if f >= min(frames, ramp_frames)
        start + step * f   otherwise
```

`end` は**現行式をそのままの演算順序で 1 回だけ**計算した値。したがって
`at(frames) == end` がブロックの長短どちらでも成り立ち、**既存の実機 goldens
（E2E-2/3/6/G/P/S/10）は動かない**。これが検算そのもの。

## コスト

| 状態 | 現在 | 案 A |
|---|---|---|
| 定常（圧倒的多数） | 乗算 1（`gain == 1.0` なら省略） | **同じ**（`is_settled()` で同じ経路へ） |
| ランプ中 | 乗算 1 | 乗算 1 + 加算 1 を 240 サンプル分だけ |

pan は**位置ではなく L/R 係数**を線形補間する（位置を補間すると `equal_power_pan` の
cos/sin が毎サンプルになる）。`pan == 0.0` → `(1.0, 1.0)` の unity 早道は維持したので、
中央 pan と pan 無指定のビット一致も保たれる。

## 検証（🔴 main が sandbox 外で実行）

`cargo fmt --check` 緑 / `cargo clippy -p orbit-audio-native --all-targets -- -D warnings` 緑 /
`cargo test -p orbit-audio-native --lib` **88 passed** /
`cargo test -p orbit-audio-daemon --features outproc-effect --lib` **220 passed**。

実機 E2E-7 は束 B と合わせて main が本ツリーで確認する。

Closes #859
### fix(dsl): separate the master track from the device it outputs to (#611) (Sep 11, 2026)

🔴 **owner の訂正（2026-09-11）**。私が「1,2 ch は master の領分だから `mix.output(1,2)` は
master として扱う」と裁定を仰ぎ、owner が「master であり、それはつまりデバイスの 1,2 に
なるのでは」と応じた後、**その実装が概念を取り違えている**ことを owner が指摘した。

> マスタートラックとデバイスっていう概念を、トラックなのかデバイスなのかっていうのを
> ちゃんと分けた方がいいんじゃないですか。
>
> マスターっていうのは要するにシーケンスのトラックやサミング、オグジュアリーのトラックとかと
> 同じように、マスターのトラックですよね。

## 正しいモデル

```
kick ──┐
snare ─┼→ master トラック: [rack][gain][pan] → output → デバイス 1,2
hat  ──┘                    ↑ ここに合流する

pad  ─────────────────────────────────→ デバイス 3,4（トラックを経由しない）
```

- `output(master)` は **master トラックの頭に合流**する。その後 master のラックと
  `global.gain()` を通り、master が自分の出口として持っているデバイスへ出る
- `mix.output(1, 2)` は **デバイスの 1,2 ch を名指す**。トラックではない

**実装も元からそうだった**（`default_master_line_program()` は bus と同じ形の
`[Rack, Gain, Output]`）。混同していたのは **DSL の側**だった。

## 何が焼き付いていたか（直した順）

| 場所 | 旧 | 新 |
|---|---|---|
| `process-statement.ts` の糖衣 | `(1,2)` を `{kind:'master'}` に読み替え | `physicalOutputDest()` で**常にデバイス** |
| 同・引数経路 | `(1,2)` の特例が**無い**（糖衣と食い違い） | 同じヘルパを通す |
| `MixerRuntimeNode` | master = `{kind:'output', channels:[1,2]}` = **デバイスノード** | **`{kind:'master'}` = 第 3 の種類** |
| `registerMixerNode` | `var master = mix.output(...)` は**合法**（#523 IMPORTANT 6） | **拒否**（sum/aux と同じ理由） |
| `resolveMixerNode` | 明示ノードが 1 つでもあれば master を解決**しない** | 常に解決する |

🔴 **最後の行が一番効いている。** 旧実装には「この Global に明示ノードが 1 つでもあれば
`master` を解決しない」というガードがあった。これは master が**デバイスノードだった時代の
名前衝突対策**で、`var master = mix.output(...)` が宣言されうる前提だった。
`master` を予約語にした今は衝突が起きず、ガードは
**「sum を 1 つ宣言した瞬間に `kick.master` が壊れる」という宣言順依存**だけを残していた。

## master の出口は 1,2 固定のまま（owner 2026-09-11）

> マスターが1、2固定にしておかないと、一般的な DAW の操作とか設定で 1、2 じゃなくなって
> しまっているみたいなことが起こると、デバイスの変更で困ってしまうので

**固定であることと、「1,2 という名前が master を意味する」ことは別**。
master トラックの DSL ハンドル（`master.output(...)` / `master.effect(...)`）は
凍結線に入れない — 下の配線（daemon の `SetBusLine("master", ...)`）は既に通っているので、
新ラインで表面だけ足せる。

## 旧モデルを固定していたテスト 9 件を書き直した

`signal-chain-dispatch.spec.ts` 5 件 + `mixer-runtime.spec.ts` 4 件。
うち 1 件はテスト名自体が混同を記録していた:
「sum/aux を master と名付けるのは拒否するが、**output を master と名付けるのは合法に保つ**」。

## 変異検証

| 変異 | 結果 |
|---|---|
| `master` の予約を外す | 1 failed |
| `master` を解決しない（旧ガード相当） | **6 failed** |
| `(1,2)` の特例を復活させる | 1 failed |
| restore | 32 passed・baseline とバイト一致 |

`npm test` **2,325 passed / 67 skipped / 0 failed**・lint 緑・`typecheck:e2e` 緑・
引用 936 / 0 failed。

Part of #611

---

### fix(dsl): keep the instrument reschedule off the push-success path (#611) (Sep 11, 2026)

束 B の fix ラウンド（Codex）を **sandbox 外で回し直して**出た赤 1 件。

```
× gain() during LOOP clears pending notes via the plugin scheduler (clearOwner)
  → expected "clearOwner" to be called with arguments: [ 'synth' ]
     Number of calls: 0
```

🔴 **Codex の `npm test` にはこれが見えていなかった。** sandbox が localhost の bind を拒否し、
mock daemon / MCP HTTP 系が `listen EPERM` で **108 件落ちた**中に埋もれていた。
CLAUDE.md の「委譲先の緑は実機の緑ではない」が、そのままの形で出た。

## 何が起きたか

Codex は C5（push 失敗時に値がどこにも無くなる）を直すため、発音側の中立化を
**push 成功後**へ動かした。これは正しい。しかし `seamlessParameterUpdate` の呼び出しも
**一緒に**動かしてしまった。

元のコードのコメントが、動かしてはいけない理由を明示していた:

> instrument sequences have NO event-side gain path to conflict with the line's ramp (§5.2) —
> but they DO rely on seamlessParameterUpdate's immediate reschedule for an **unrelated reason**
> (clearing pending scheduled notes via the plugin scheduler's clearOwner)

**instrument の即時 reschedule は gain とは無関係の関心事**（保留中のノートを消す）なので、
**push の成否に依存させてはいけない** — daemon が拒否してもノートは消す必要がある。
テストの mock には Rust バックエンドが無いので `setBusLine` が必ず throw し、
`adoptLineOnFirstBus()` に到達せず `clearOwner` が 0 回になっていた。

## 直し方

2 つの関心事を分けた。

| 関心事 | どこで発火するか |
|---|---|
| 発音側の中立化（ライン側と二重に掛からないように） | **push 成功後**（`adoptLineOnFirstBus`・Codex の正しい部分） |
| 即時 reschedule（`clearOwner`） | **`gain()`/`pan()` の中**・push の成否と無関係 |

audio + バス有りだけ `skipReschedule=true` のまま（ライン側の ramp が継ぐ）。

## fixer は main が直接やった

CLAUDE.md の「fixer は Codex → 収束しなければ main」に対し、これは**新しい指摘**で
2 回落ちたものではない。ただし**差分を読み終えており**、ブリーフを書き起こすコストの方が
自分で直すより高い（`fable-main-may-implement-directly` の一般化）と判断した。

検証: `npm test` **2,322 passed / 67 skipped / 0 failed**・lint 緑・`typecheck:e2e` 緑・
引用 936 / 0 failed。

Part of #611

### fix(extension): stop warning that working output() targets have no effect (#611) (Sep 11, 2026)

束 B のレビューで Fable が見つけた片翼。**出荷物の欠陥だったので、後回しにせず凍結線に含めた。**

`analyzeOutputWithoutLinkAudio`（`diagnostics-analysis.ts:218`）の正規表現は

```js
/\.output\s*\(\s*["']([^"']*)["']\s*\)/g
```

で、**`"master"` も宣言済み sum/aux 名も `"3,4"` も除外していなかった**。凍結線の看板機能を書くと:

```
kick.output("master")
      ⚠️ seq.output() requires global.linkAudio() to be declared in this file.
         Without LinkAudio mode the channel name has no effect.
```

🔴 **同梱 README は「LinkAudio は出荷ビルドで動作せず、音も出ない」と明記している。**
つまりエディタは、**動いているコードに「効かない」と警告し、動かない機能を指さしていた。**
ユーザーが最初に見る面でこれが起きる。

**直し方**: #611 §2.1/§3.3 の解決順（`OutputDest` → `"master"` → 宣言済み sum/aux →
`"L,R"` 対 → LinkAudio）で **LinkAudio より前に解決する名前を除外**した。
sum/aux の宣言は 2 形式とも拾う（`global.sum("x")` の文字列形と `var x = mix.sum` の変数形 —
**後者は変数名がバス名**）。

宣言の収集は**ファイル全体**から行う（呼び出し行より上だけではない）。ライブコーディングの
ファイルは丸ごと再評価され、`global.sum(...)` はそれを使う sequence より**下**に書かれることが
普通にあるため。2 行下で宣言される名前を警告するのはノイズ。

**検証**（変異は `$TMPDIR` へバックアップしてから）:

| 変異 | 結果 |
|---|---|
| `master` の除外を削除 | 1 failed |
| sum/aux の除外を削除 | 3 failed |
| `"L,R"` の除外を削除 | 1 failed |
| 常に除外（警告そのものを殺す） | **5 failed** |
| コメント行も宣言として拾う | 1 failed |
| restore | 51 passed・baseline とバイト一致 |

4 番目が効いているのが要点で、**「除外しすぎ」も捕まる**（未宣言の名前は今も警告される）。

`npm test` 2,369 passed / 0 failed（+6）・lint 緑・`typecheck:e2e` 緑・引用 1,034 / 0 failed。

### refactor(dsl): apply the /simplify cleanup to the bundle-B line surface (#611) (Sep 11, 2026)

束 B（PR #852）に `/simplify` を回した。4 体（reuse / simplification / efficiency / altitude）
の指摘は 14 件、重複を畳んで 9 件。**3 体が同じ 1 件を指した**ので、そこから直した。

| # | 指摘 | 何体 | 対応 |
|---|---|---|---|
| 1 | 自己バッチの 4 行が `Sequence.upsertLine` と `MixerManager.applyLineElement` に逐語重複 | **3** | `AudioLine.upsertAutoBatch()` へ移した |
| 2 | `resolveLineDest` と `resolveDest` が同じ §3.3 の解決を二重に持つ | 2 | 共有 `resolveNamedOutputDest(value, lookupBus)` |
| 3 | `allLines` が `Set` で、破棄された行がプロセス寿命だけ残る | 2 | `Set<WeakRef<AudioLine>>` + 反復時の剪定 |
| 4 | `firstInBatch` は `cursor === 0` から導出できる | 1 | getter 化 |
| 5 | `outputs()` が本番から呼ばれていない | 1 | 削除（テストは `program()` 全体で見る形へ） |
| 6 | output 段取りの 5 行が 3 メソッドに重複 | 1 | `stageOutputElement()` |
| 7 | `gain()`/`pan()` の instrument insert-bus ブロックが重複 | 2 | `ensureInsertBusForInstrument()` |
| 8 | `MixerOutputOptions`/`MixerSendOptions` が `OutputOptions`/`SendOptions` の複製 | 1 | 共有版へ統合 |
| 9 | capture 定数がテストで再定義 | 1 | `capture-windows.ts` から export して import |

## 争点が 1 件あり、自分で検算した

指摘 8 について **reuse 側は「循環しないので統合できる」、simplification 側は
「循環 import があるので複製が正当」と逆の判断**をした。複製側のコメント自身が
「circular import を避けるため」と書いていた。

実際に読むと `audio-line.ts` の import は `audio-gain-utils` と `audio/types` の 2 本だけで、
**`sequence.ts` にも `global.ts` にも `mixer-manager.ts` にも依存していない葉**。
両者が既にここから import している以上、型をここへ置いても循環は起きない。
**reuse 側が正しく、コメントの正当化根拠は成立していなかった。**
simplification 側は `sequence.ts → global.ts → mixer-manager.ts` の向きだけを確認して、
両者が共通で依存する葉の存在を見落としていた。

## 指摘 4 は「フラグを消す」ではなく「導出を明示する」形にした

`firstInBatch` を単に消すと、「`cursor` はバッチ中 0 に戻らない」という不変条件が
暗黙になる。getter にして**その不変条件を doc に書いた**（`beginBatch()` だけが 0 にし、
どの `upsert` 経路も `<index> + 1`（index >= 0）を代入し、splice 分岐の `-= 1` は必ず
対の `+= 1` を伴う）。フラグという 2 つ目の写しは持たないが、根拠は残る。

## 🔴 `WeakRef` は tsconfig の `lib` に触れた

`WeakRef` は ES2021 で、この repo の `target` は ES2020 だった。最初 engine の
tsconfig だけに `"lib": ["ES2021"]` を足したところ engine は通ったが、
**`npm run typecheck:e2e` が `tsconfig.tests.json` で同じエラーを出した**
（memory `consumerless-code-is-unprotected` の「正本は `npm run typecheck:e2e`」どおり）。

`tsconfig.base.json` に 1 箇所だけ置いた。`target` は ES2020 のまま
（`WeakRef` はランタイムグローバルであって構文ではないのでダウンレベルは不要）。
そもそも root package.json が **Node >= 22 を要求**しているので、型面を ES2020 に絞るのは
実際のランタイムより狭い宣言だった。

## ラチェットが 1 件発火した

`tests/interpreter/signal-chain-dispatch.spec.ts` が `stageOutputElement` を
「未分類の Sequence メソッド」として赤にした。TS の `private` は実行時に残るので
prototype に見える。`ensureInsertBusForInstrument` と併せて内部 API 側に分類した。

検証: `npm test` **2,363 passed / 67 skipped / 0 failed** / `npm run lint` 緑 /
`npm run typecheck:e2e` 緑 / 引用 1,034 verified / 0 failed。
### docs: follow the merged #834 in the core spec, specs-v2 and the dev site (Sep 11, 2026)

マージ済み PR [#834](https://github.com/signalcompose/orbitscore/pull/834)（#611 束
O-surface の前半・merge commit `f23eb5d`）にドキュメントを追従させた。**実装とテストは
一切触っていない**（docs のみ）。

**追従した事実**（すべて #834 の差分から読み取れるもの）:

| 差分 | 直した先 |
|---|---|
| `SetBusLine` の op が 3 種（rack / gain / output）→ **4 種**（`pan` 追加）・`session.rs:358` のエラー文言も変わった | `sites/dev/rust-engine/index.md` と en の「op は 3 種」の段 |
| `dest.device` の `channels` が 2 要素固定 → **1 要素（mono）も受理**（`session.rs:423` の `matches!(channels.len(), 1 \| 2)`・範囲検証は `right` があるときだけ distinct を要求） | 同上（段を新設） |
| `validate_line_program` の `Pan` 拒否が外れ、RT で `√2 · equal_power_pan(p)` を掛けるようになった（`output.rs:2148-2182`） | 同上 + `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` MX.4 |
| `LineProgram::with_seeds` / `line_republish_seeds` で再 publish が実効値を引き継ぐようになった | `sites/dev/rust-engine/index.md`（master gain の節が「§5.1 の機構は PR-O4 と同時に入る」と未来形で書いていた）と en |
| 引用行のずれ（`engine_wrap.rs:3262-3284` → `:3349-3371`・`:9479-9488` → `:9741-9750`・`daemon-client.ts:86-96` → `:86-97`） | RE-1 ja / en の本文と further-reading（**中身を base と突合して「その記述が指すもの」だと確かめられた 3 件だけ**。RE-1 / SC-2 の further-reading には #834 より前から中身と合っていない範囲が他にもあるが、機械的にずらすと**別の誤りへ移すだけ**になるので触っていない） |
| MX.4 の ⚠️「`pan` と mono 宛先はまだ wire に無い」 | `docs/core/INSTRUCTION_ORBITSCORE_DSL.md`（**wire には入ったが TS に呼び出し元が無い**ことを明記） |
| SC.1 の「v1 の現在地」 | `docs/specs-v2/SIGNAL_CHAIN_DSL_SPEC_v1.md`（同上・現在地そのものは変わらない理由を書いた） |

🔴 **「wire に入った ≠ 譜面から見える」を毎回書いた。** `packages/engine` に `setBusLine` の
呼び出し元は 0 件（`grep -rn setBusLine packages --include=*.ts` は `daemon-client.ts` のみ）。
`seq.pan()` は今日も発音側の `Scheduler` を通る。

**あわせて直した既存の綻び**（#834 の差分起因ではない・PR 本文で開示）:
`docs/core/INSTRUCTION_ORBITSCORE_DSL.md` MX.2.2 の `engine_wrap.rs:5809-5813` / `:5828` は
**#834 より前から** `SelectAudioDevice` の stream 差し替えを指していた（WORK_LOG 2026-09-10 の
行も「壊れていた」と記録している）。MX.4 側だけが実測値へ直され、MX.2.2 の表が取り残されていた
ので、同じ実測値（`:7212-7216` / `:7237-7241`）へそろえた。

**frontmatter**: #834 は SC-2 / RE-3 の本文を書き換えたのに `verified-against` /
`verified-at` を据え置いていたので、4 ファイル（ja / en）を `f23eb5d` / 2026-09-11 へ更新した。

**追従不要と判断したもの**: `sites/user/reference/methods.md` と
`docs/user/ja/USER_MANUAL.md` の `pan(-100..100)`（DSL 表面は無変更）、
`docs/design/611-o-surface-bundle-design.md`（起案時点のスナップショットなので後から直さない）。

**検証**: `npm run docs:build -w @orbitscore/user-site` / `-w @orbitscore/dev-site` /
`npm run docs:check`（936 → 引用の増減なし・0 failed）。

---

### docs(native): correct the current_gains serialization table (#611) (Sep 11, 2026)

束 A のレビューラウンドを閉じる前の **fix 差分再点検**（1 レビュアー・問いは
「新しい故障モードは何か」「新コードはどの実行コンテキストで走るか」の 2 つ）で
出た Minor 1 件を直した。Critical / Important は 0。

**何が間違っていたか**: `LineControl::current_gains()` に付けた「どの mutex で
直列化されているか」の表が、1 行目を `EngineWrap::set_global_gain` としていた。
実際の `set_global_gain`（`engine_wrap.rs:9747`）は `master_gain` atomic へ store
するだけで、`master_line_program` にも `LineExchange` にも触れていない。
`current_gains()` の呼び出し元は 2 つとも `EngineWrap::set_bus_line`
（`engine_wrap.rs:6980`）の中 — `bus == "master"` 分岐（7047）と named-bus 分岐（7141）。

🔴 **なぜ実害になりうるか**: この表は「呼び手が install と直列化する契約であり
型では強制していない」ことを将来の監査者へ伝えるために足したもの。PR-O4 はまさに
`set_global_gain` を `SetBusLine("master", …)` へ切り替える予定なので、その担当者が
表を読んで「既に `master_line_program` で直列化されている」と誤解しうる。
**この PR が対処しようとした「規約を知らない 4 つ目の呼び出し元」問題を、
コメント自身の不正確さで再生産していた。**

**変更**: 表を 2 つに分けた。①`current_gains()` を呼ぶ経路（2 件・どちらも
`set_bus_line`）②同じ `LineExchange` へ install する経路（3 件・`current_gains()` を
呼ばない `set_bus_routing` を含む）。②が全部同じ mutex を取ることが「install どうし」も
「読む → install」も直列化される根拠なので、①だけでは説明が閉じない。
`set_global_gain` が現状この表に**入らない**ことと、PR-O4 で触るときに契約を新たに
満たす必要があることを明記した。

検証: `cargo fmt --check` 緑 / `cargo clippy -p orbit-audio-native --all-targets -- -D warnings` 緑。

### chore(docs): rotate WORK_LOG before closing the bundle-A review (#611) (Sep 11, 2026)

`tests/docs/worklog-size.spec.ts` が **2,104 行**で赤くなった（上限 2,000）。
PROJECT_RULES §1a どおりアーカイブへ回した。

**移設**: `Sep 7, 2026` 以前の 18 エントリ・1,326 行を
`docs/archive/WORK_LOG_2026-09.md` の先頭へ。本体は **2,103 → 775 行**。
アーカイブの期間ラベルを `09-01〜09-06` → `09-01〜09-07` に更新し、本体末尾の索引と
`docs/core/INDEX.md` の表も揃えた。

🔴 **一度失敗した手順を記録しておく**（同じ落とし穴を踏まないため）。移設範囲の終端を
`s.index("## Archived sections")` で取ったところ、**過去エントリの本文が引用している
同じ見出し**を拾って、18 件のうち 3 件しか移らなかった。`rindex`（最後の出現）で取り直した。
**WORK_LOG は自分自身の構造を語るので、見出し文字列は本文にも現れる。**

### fix(daemon): build the master default line in exactly one place, too (#611) (Sep 11, 2026)

`/code:pr-review-team` ラウンド 1（4 レビュアー）を束 A（PR #834）に回した。
**Critical 1 / Important 4 / Minor 2**。fixer は main。

#### 🔴 Critical — mono デバイスで seed が実体と食い違い、この機構が防ぐはずのポップを再導入する

`MasterLine::new` は初期 program の `dest.right` を **`Some(1)` に固定**していた。一方 daemon 側の
shadow `default_master_line_program(output_channels)` は `(output_channels > 1).then_some(1)` を
返していた。**1ch デバイスでは `dest` が食い違う**ので、`line_republish_seeds` の Output 照合が
外れ、新しい master Output の seed が既定の **0.0** に落ちる。鳴っていた master が一瞬無音から
5 ms かけてフェードインし直す — 設計 §4.3 が名指ししている失敗モードそのもの。

**2ch では偶然一致するので、開発機の実機検証でも顕在化しない。**

さらに `add_to_device` の境界検査は `debug_assert` だけなので、**実 1ch デバイスでは
`right: Some(1)` が RT で範囲外アクセスになる**（`device_base + 1` が mono バッファを超える）。

**対処**: `default_master_line_ops(output_channels)` を `orbit-audio-native` から export し、
`MasterLine::new` と daemon の shadow の**両方がこれを呼ぶ**ようにした。`MasterLine::new` は
`output_channels` を受け取る（呼び出し 11 箇所・production の 1 箇所は同スコープに `channels` が居た）。
**同じ日にバス側で `legacy_line_ops` へ統一したのと同じ手当てを master にも当てた**
— reviewer が「是正の一貫性の欠落」として指摘したとおり。

固定するテスト `master_line_starts_from_the_shared_default_ops_for_any_channel_count` を足し、
**旧バグ（`right: Some(1)` 固定）を再現する変異で赤・戻して緑**を実走で確認した。

#### Important — 設計 §11 が挙げた 6 件のうち 2 件がまだ未実装だった

前回の Fable 監査が 3 件を埋めた**その一段外側**に、`channels` の要素数（0 個 / 3 個以上）の拒否と
**mono の `left` が範囲外**の拒否が残っていた（既存テストは stereo ペアしか通しておらず
`right: None` の枝に到達していなかった）。
`set_bus_line_wire_rejects_device_channel_arity_and_mono_out_of_range` を追加。
**2 種類の変異（要素数制限を外す / mono 上限を外す）で赤**を確認。

**列挙は一段手前で止まる。** 同じ設計文書の同じ表で、2 回続けて起きた。

#### Important — 「center は unity」を近似で検査していた

`line_program_pan_is_normalized_and_executes_in_rt` の許容差は `1e-6` で、
`apply_line_pan` の中央早期リターンを消しても `sqrt(2)*cos(pi/4)` の **6e-8** のずれが埋もれて
**そのまま通った**。設計 §4.1 の「center は unity」は近似ではないので、**ビット一致**で見る形に
変えた。変異で `1.4142134` と `1.4142135` の 1 ulp を捉えることを確認。

#### Important — dev サイトが裁定と逆のことを書いていた（comment-analyzer の Critical）

「`EngineWrap` はこのハンドルを `SetBusLine("master", …)` だけでなく **`SetGlobalGain` からも**
呼ぶ」と書いてあったが、現在の `set_global_gain` は `master_gain.store(...)` の 1 行だけで、
line-program installer を**呼ばない**。ユニットテスト
`set_global_gain_only_updates_the_compatibility_atomic` が「must not republish」を assert している。
PR #823 の時点では正しかったが、O-wire-b のレビュー修正（`9e22e427`）で戻り、裁定 F2（写さない）で
確定していた。**文書だけが 1 層取り残されていた**（ゴールが警告している型）。ja / en とも訂正。

#### そのほか

- `line_republish_seeds` への行番号参照がずれていた（`2162-2193` → 実体は 2157-2188）ので、
  **行番号をやめて関数名で参照する**ようにした
- TS の `daemon-client-line-wire.spec.ts` が、この束が広げた型（`pan` op・mono の `channels: [number]`）を
  **1 件も通していなかった**。設計 §11 が検証コマンドとして名指ししているファイルなのに
  「実行はされるが変更点は通らない」状態だった。1 件追加
- `LineControl::current_gains()` の直列化契約を、**どの mutex かまで表で明記**した
  （code-reviewer の Minor: 「規約を知らない 4 つ目の呼び出し元が追加されると壊れる」）

#### レビュアー別

| | 結果 |
|---|---|
| code-reviewer | **Critical 0 / Important 0**（mutex 経路を追い直して UAF なしと確認・cargo で 31 件を実走） |
| silent-failure-hunter | **Critical 1** / Important 1 / Minor 2 |
| pr-test-analyzer | Important 3 / Minor 1 |
| comment-analyzer | **Critical 1** / Important 2 |

**検算**: `cargo test -p orbit-audio-native --lib` **84 passed** /
`-p orbit-audio-daemon --features outproc-effect --lib` **220 passed** /
`cargo fmt --check` 緑 / TS wire spec 2 passed。

#### 持ち越し（issue 化する）

silent-failure-hunter の Important #2: `LineExchange::install` は RT へ swap した**後**に
`retired` mutex を取るので、その mutex が poison すると **RT は新 program で鳴っているのに
呼び出し元へ Err が返る**。この束が新設した「shadow は install 成功時だけ前進する」不変条件は、
その既存の非 atomic 失敗経路では成立しない。発生確率は低いが**ログが 1 行も出ない**。
束 A の差分の外（既存仕様）なので **#850** に切り出した。

### refactor(daemon): build the default bus line in exactly one place (#611) (Sep 11, 2026)

束 A（PR #834）に `/simplify` を回した。**引き継ぎに「レビュー済み」とあったのを検算せず信じていた**
（記録を見ると `/simplify` も `/code:pr-review-team` も痕跡が無かった）。owner の指摘で気づいた。
memory `handoff-claims-need-primary-source-recheck` の再発である。

#### 🔴 Reuse と Altitude が**独立に同じ 1 点**を指摘

`default_bus_line_program()`（`engine_wrap.rs`）が `legacy_line_ops(BusTarget::Master, &[])` と
**同じ ops 列を手書きで再定義**していた。すぐ下の `initial_bus_line_shadows` のコメントは

> 🔴 The shadow is what a later `SetBusLine` seeds effective gains from. If it disagreed with
> what the bus is actually running, seeding would restore the wrong value and reintroduce the
> jump it exists to prevent — **so build it in exactly one place**

と書いているのに、**実装は 2 箇所で作っていた**。`legacy_line_ops` 側だけが変わると shadow が
旧い形で残り、未設定バスへの最初の `SetBusLine` が誤った seed から republish する
— **この機構が防ごうとしているポップを、この機構自身が再導入する**。
`legacy_line_ops` の呼び出しに置き換えた（1 行）。コメントの約束が実際に成立するようになった。

#### Efficiency — 中央パンの早道

`apply_line_pan` に unity の早期リターンが無く、`LineOp::Gain` が `gain != 1.0` で同じことを
しているのと非対称だった。RT コールバックのたびに `frames × 2` 回の無駄な乗算になる。

🔴 **副次的に丸め誤差が消える**。f32 では `sqrt(2) * cos(pi/4) = 0.99999994` で **1.0 ちょうどに
ならない**（実測）。省くことで `pan(0)` を書いた譜面が書かない譜面と一致し、設計 §4.1 の
「center で `(1, 1)`（unity）」が**文書どおり**になる。

#### Simplification — wire parse の形をそろえた

`pan` だけ「取得はアーム内にインライン・範囲検証は別関数」という、`gain`（1 関数）と違う分割に
なっていた。`parse_set_bus_line_pan` に揃えてアームを 1 行にした。エラーコードは
`PARAM_OUT_OF_RANGE` のまま残す（範囲外は「形が壊れている」ではない。`gain` 側を寄せるかは
既存挙動を巻き込むので本 PR では触らない）。

#### 🔴 到達できない入力でガードを検査していたテストを直した

`!pan.is_finite()` の枝を `validate_set_bus_line_pan(f64::NAN)` で検査していたが、
**非有限の pan は wire から到達できない**（2026-09-11 実測）: JSON に NaN / Infinity の
リテラルは無く、`serde_json` は `1e400` を `Error("number out of range")` として
**parse 時点で拒否する**。実際に来る形（数値でない → `MALFORMED_REQUEST`）を固定し直した。
ガード自体は型が保証していないので防御として残す。

#### 見送り

`#[inline]` が無いという指摘は**誤検知**（既に付いている。差分だけを読んだため）。
master line と bus post-loop の実行器 2 本を 1 本に畳む案は、Altitude が
「本 PR 以前からある構造で、`Pan` はそれに素直に追従しただけ。畳むなら Gain / Output も含む
別 PR」と判定したので見送る。

**検算**: `cargo test -p orbit-audio-native --lib` **83 passed** /
`-p orbit-audio-daemon --features outproc-effect --lib` **219 passed** /
`cargo fmt --check` 緑 / `cargo clippy --all-targets -- -D warnings` 緑。

### fix(e2e): copy the whole audio asset directory into the gated workspace (#611) (Sep 11, 2026)

**`#611 E2E-7` の無音の原因**。実機 gated で capture 20.2 s が **1,939,456 サンプルすべてゼロ**
だった。素材の長さでも DSL でもなく、**ハーネスが一時ワークスペースへ `kick.wav` だけを
コピーしていた**ため、`sine_440.wav` が存在しなかった。

#### 切り分けの経路（記録）

| 手順 | 結果 |
|---|---|
| capture を直接読む | 20.2 s・非ゼロサンプル **0** 件。「小さすぎて拾えない」ではなく完全な無音 |
| `gainDbToAmplitude(-40)` | **0.01**。下限クランプ無し。ゲインは原因でない |
| バスプールの枯渇を疑う | 枯渇時は throw する実装（`effect-slot.ts` の `BusPool.acquire`）で、ログにその文言なし |
| `mix.sum` の node 形を疑う | `registerMixerNode` は `mixerGlobal[kind](variableName)` を呼ぶだけで、**文字列形と同一経路**（`runtime.ts`） |
| 🔴 **エンジンを直接叩くプローブ** | 同じ譜面が**鳴った**。peak **0.007071** = `gainDbToAmplitude(-40) × equal_power_pan(0)` = 0.01 × 0.7071。譜面もエンジンも正常 |
| ハーネスの workspace 準備を読む | `prepareWorkspace` が `test-assets/audio/kick.wav` **1 ファイルだけ**を写していた（3 箇所とも） |

#### 直した形

**ディレクトリごと `fs.cpSync`** にした（3 箇所）。1 ファイルずつ列挙する設計をやめる。
**列挙は必ず一段手前で止まる** — 新しい fixture が新しい素材を使うたびにハーネスを直す形に
しない（memory `enumeration-stops-one-level-too-early`）。

#### あわせて足した観測手段

E2E-7 の `waitForSound` が落ちた時に **`get_log` の末尾を例外に添える**ようにした。
今回は「音が出ないまま時間切れ」としか言わず、原因の特定に実機実行を 2 本払った。
規律の順序（DSL を網羅した E2E → 実機で問題 → **ログで異常系を捕まえられるようにする**）
のとおり、まずログを出せるようにする。

#### 同じ実行で直したもう 2 件

- **`#661 D-2` / `D-3`**: 音の判定はすべて通っているのに、後始末の `ENOTEMPTY` だけで赤かった。
  `child.kill()` は SIGTERM を送るだけで、VS Code の agent host はその後も
  `<user-data-dir>/.../sdk-cache/` へ書き続ける。`force: true` は **ENOENT しか抑えない**。
  子の終了を待ってから消し、それでも残ったら警告して続ける `removeHarnessTree()` を置いた。
  **後始末でテストを落とさない。** 残骸は `/tmp/orbe2e-` 前置きなので次回開始時の掃除が拾う
- **`#611 E2E-7` の譜面**: `RUN` + 固定 sleep(300ms) → `LOOP` + `play(1, 0, 1, 0)` +
  **音が出るのを待つ**形へ。gated スイートで `RUN(` を使う譜面はこれ 1 本だけで、他は全部
  音を追いかけていた。`sine_440.wav` はちょうど 1.000 s（実測）なので、1.0 s 間隔の
  `play(1, 0, 1, 0)` なら隙間なく連なり、440 Hz は 1 s でちょうど 440 周期でつなぎ目の位相も連続する

### docs: follow the SetBusLine wire in the dev site and core spec (#823 追従) (Sep 8, 2026)

**ブランチ**: `claude/docs-sync-pr823` → `611-line-wire-b`（docs-sync ルーチン・PR [#823](https://github.com/signalcompose/orbitscore/pull/823) 追従）

マージ済み PR にドキュメントを追従させる定期ルーチンの成果物。**実装とテストは 1 行も触っていない。**

#### 直したもの

| 文書 | 何 |
|---|---|
| `sites/dev/signal-chain/mixer-audio-line.md`（+ `en/`） | `SetBusLine` の節を新設（wire 語彙・検証が session / `EngineWrap` の 2 層に分かれた理由・拒否 code の表・forward-only は残り kind 制約は無いこと・全か無かの publish・`master` も同じ publish に乗ったこと）。`verified-against` を `f6c9c37` へ |
| `sites/dev/rust-engine/index.md`（+ `en/`） | `set_global_gain` の節の記述を訂正（下記）|
| `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` MX.4 | 「v1 の現在地」の行番号が `engine_wrap.rs:5809-5813` 等で古かったので実測値へ。**wire 側の kind 制約は PR-O3b で外れたが、送信元がまだ無いので譜面から見える振る舞いは変わっていない**ことを追記 |

#### 🔴 差分と食い違っていた記述を 1 件訂正した — `explicit_line`

PR-O3b 本文・WORK_LOG・dev サイトの 3 箇所が「`explicit_line` は最初の `SetBusLine("master", …)` まで
`false` なので既存譜面は従来経路をそのまま通る」と書いていた。だが差分を読むと、
`MasterLine::line_program_installer` が返す closure は install 成功時に**無条件で**
`explicit_line` を立てる（`rust/crates/orbit-audio-native/src/output.rs:790-798`）。
そして `EngineWrap::set_global_gain` は `outproc-effect` build でそのハンドルを呼ぶ
（`rust/crates/orbit-audio-daemon/src/engine_wrap.rs:9284-9290`）。

したがって **`SetGlobalGain`（DSL の `global.gain()`）を 1 回受けた時点で** master の render は
`execute_master_line` 側（`output.rs:1719-1721`）へ移る。dev サイトの記述をコードに合わせて直し、
**出力にどう出るかは実機で測っていない**ので `NOTE: unverified` を付けた。

差分から読み取れる差は 2 つ（どちらも未測定）:

- ランプ長の出どころ — `MasterLine::ramp_frames` は sample_rate から算出、`LineSlot::new` の既定は
  **240 固定**（`output.rs:1196`）。`set_sample_rate` は insert bus の line にしか呼ばれない（同 `:2765`）
- 再 publish のたびに `LineProgram::new` が gain セルを **1.0 から**始める（同 `:1005-1020`）

**判断は仕様の側なので、追従作業では直していない。** #823 追従 PR の本文で質問として出している。

#### 検証

`npm run docs:build`（user / dev）と `npm run docs:check`（**1,026 citations verified / 0 failed**）。

---

### feat(daemon): SetBusLine wire command and TS client (#611 PR-O3b) (Sep 9, 2026)

**Issue**: #611 / **ブランチ**: `611-o3b-setbusline` → `611-line-wire-b`（小 PR）/
**実装**: Codex（`gpt-5.6-sol` / effort high・専用 worktree）/ **検証**: main（本ツリー）

#### 何を足したか

| 層 | 何 |
|---|---|
| `session.rs` | `parse_set_bus_line_params`（wire 形式の検証）+ dispatch。feature 無効ビルドは `UNSUPPORTED` |
| `engine_wrap.rs` | `set_bus_line`（意味論の検証 → `LineProgram` 構築 → 全検証後に一括 publish）・`SetGlobalGain` と master line の同期 |
| `output.rs` | 🔴 **`MasterLine.line` と `execute_master_line`**（下記）|
| `lib.rs` | O3a の型（`LineOp` / `LineOutput` / `LineProgram` / `OutputDest`）と installer の re-export |
| `protocol-types.ts` / `daemon-client.ts` | `'SetBusLine'` / `setBusLine()` / `WireDest` / `WireLineOp` |

🔴 **TS の呼び出し元は作っていない**（DSL から送るのは PR-O4）。
🔴 **旧 `SetBusRouting` は併存**（撤去は PR-O6）。既存テストは 1 行も書き換えていない。

#### 🔴 PR-O3a の実装漏れを 1 件埋めた — `MasterLine.line`

設計 611 **§5.2 は `MasterLine` に `line: LineSlot` を持たせる**と定め、**§4.1 の `bus` は `"master"` を
受理対象**にしている（`master` の自己参照を拒否する検証行がその証拠）。ところが **PR-O3a はそれを
入れていなかった** — main `2ca00f6a` の `output.rs` の `MasterLine` は `post` / `gain_target` などだけで、
**`SetBusLine("master", …)` を受理する先が無い**。

本 PR が §5.2 を埋めた。**互換は分岐で保つ**:

```
if master.explicit_line { execute_master_line(...) }   // publish 後
else { post → advance_gain → place_master_into_device }  // 従来経路（1 命令も変えていない）
```

`explicit_line` は最初の `SetBusLine("master", …)` が publish されるまで `false` なので、
**既存譜面は従来経路をそのまま通る**。O0 golden の bit 一致はこの分岐で構造的に保たれる
（既存の `legacy_*_bit_for_bit` 群が無改変で緑）。

⚠️ 計画 §1.10 の「触るファイル」欄が `output.rs` を落としていた（見積もりの漏れ）。
`BUNDLE_BRANCH_WORKFLOW` §5.1b に従い、**実装の前に**計画へ理由と追加の検証条件を書いた（`fc67c771`）。

#### 検証の層を分けた（main の裁定・2026-09-08）

`validate_line_program`（`output.rs`）は **RT 実行の可用性ゲート**であって wire の契約検証ではない。
そこは `Pan` / `Render` / `Link` を `OutputError::NoConfig` で拒否しており、**その文言を wire へ流すと
`DEVICE_CONFIG_ERROR` になって §4.1 のどの行とも一致しない**（`actionable_output_error_code` は
4 種の device エラーしか拾わない）。

したがって `set_bus_line` が §4.1 の表を**先に**適用する。**このゲートは無改変**（差分に出ていない）:

| §4.1 の行 | wire code | 経由する variant |
|---|---|---|
| 形式不正・`rack` 二重・`master` 自己参照・`render` 未登録 | `MALFORMED_REQUEST` | `OutProcEffectRequest` |
| `dest.bus` 未知 / forward-only 違反 | `OUTPROC_EFFECT_RUNTIME` | `OutProcEffect` |
| `dest.device` 範囲外・`a == b` | `PARAM_OUT_OF_RANGE` | （session の dispatch で直接）|
| `dest.link`（feature 無し） | `LINK_AUDIO_UNAVAILABLE` | `LinkAudioUnavailable` |
| feature 無効ビルド | `UNSUPPORTED` | （dispatch の `#[cfg(not(...))]`）|

🔴 **ブリーフ（09-07 起案）は 3 箇所を誤っていた**ので、着手前に一次ソースで検算して訂正した:
`engine_wrap.rs` の行番号（6227 → **6310**）/ feature 無効時の code（`OUTPROC_EFFECT_UNAVAILABLE`
→ **`UNSUPPORTED`**）/ wire code は variant 名と別物であること。**訂正しなければ、存在しない
エラー code を期待するテストが緑になっていた。**

#### 検証（🔴 すべて main が本ツリーで実行）

| 検証 | 結果 |
|---|---|
| `cargo test --workspace --locked` | **617 passed / 0 failed / 38 ignored** |
| `cargo test -p orbit-audio-daemon --features outproc-effect,outproc-instrument` | **339 passed / 0 failed / 13 ignored**（新規 `set_bus_line_*` 11 件を含む）|
| `cargo fmt --all --check` | 緑 |
| `cargo clippy --workspace --all-targets -- -D warnings` | 警告なし |
| `cargo clippy -p orbit-audio-daemon --features outproc-effect,outproc-instrument --all-targets` | 警告なし |
| `npm run lint` | 緑 |
| `npm test` | **2,329 passed / 58 skipped / 0 failed**（164 ファイル）|
| `npm run build` / `npm run typecheck:e2e` | 緑 |

🔴 **委譲先が走らせられなかったものが 2 つあった**:

1. **protocol 統合テスト 61 件** — Codex の sandbox は localhost bind を許さず
   `bind_localhost ... Operation not permitted` で全件落ちていた。**本ツリーでは bind エラー 0 件で全緑**
2. **TS 側すべて** — worktree に `node_modules` が無く、lint / vitest / tsc を一度も実行していない

**「Codex が緑と言った」だけでマージできる PR は構造的に存在しない**（CLAUDE.md）ことが、
そのまま再現した形。

#### main が差分を読んで直した点（1 件）

`output.rs` の従来経路を `else` 分岐へ包む際に、**設計判断を記録したコメント 3 ブロックが削除**されていた:
`g == 1.0` が bit 一致を崩さない理由 / デバイス配置の意味（設計 §5.3 row 6）/
🔴 **`hw` を全域 zero-fill してはいけない**理由（`place_master_into_device` が全要素を書くので、
1ch・2ch では毎ブロック二重 store になる。64 frames × 2ch で約 96,000 store/秒の無駄）。

**コードは無改変だがコメントだけ落ちる**類の欠落で、テストでは検出できない。復元した。

#### 🔴 CI が捕まえた検証漏れ — `docs:check` を手元で回していなかった

小 PR [#823](https://github.com/signalcompose/orbitscore/pull/823) の CI で `code-review` が落ちた。
原因は**実装ではなく dev サイトの引用**で、**102 件が FAIL**。Rust に +1,096 行入れたので
`// file:start-end` の行番号が動いたため。

**私（main）の検証漏れである**。cargo・vitest・lint・build・typecheck は回したのに、
**`npm run docs:check` を回していなかった**。`--no-verify` でコミットしたので pre-commit も走らず、
**CI が唯一の検出点になっていた**。

対処:

| 手 | 結果 |
|---|---|
| `node sites/dev/scripts/check-citations.mjs --fix` | 102 → **4 件**（スニペットの移動ぶんは自動で再アンカーされる）|
| 残り 4 件（ja/en の 2 箇所） | **引用の中身自体が変わっていた**ので `--fix` では直らず、コードブロックごと差し替えた |
| 地の文 | `EngineWrap::set_global_gain` の説明が「`MasterLine` の目標値へ atomic store するだけ」のままだった（本 PR で master line への再 publish が 1 段増えている）。ja / en とも追記した |

最終: **1,012 citations verified / 0 failed**・`npm run docs:build` 成功。

🔴 **教訓**: Rust に大きな差分を入れたら **`docs:check` は cargo と同じ列に置く**。
引用は「コードは正しいが記述が古い」を検出する層で、他のどのテストも代わりにならない。

#### `/simplify` の結果（4 観点を並行・束 PR [#824](https://github.com/signalcompose/orbitscore/pull/824)）

**適用したもの**:

| 指摘 | 出所 | 何をしたか |
|---|---|---|
| master 分岐と named bus 分岐で **Device 変換・Render/Link 拒否が一字一句同一** | altitude・simplification が**独立に**指摘 | `device_dest_from_wire` / `render_dest_rejected` / `link_dest_rejected` の 3 つへ抽出。両分岐から呼ぶ |
| `link` のエラー文言が「requires link-audio」で誤解を招く | altitude | **feature の有無ではなく RT が未配線だから拒否している**ので「is not wired into RT execution yet」へ。code は §4.1 どおり `LINK_AUDIO_UNAVAILABLE` のまま |
| `explicit_line` の**消える条件**がコメントに無い | altitude | 「PR-O4 で新表面が実機で確かめられ、PR-O6 で旧経路が撤去され、O0 golden を取り直した後」と明記 |
| `MasterLine::new` の既定 program が control 側 shadow と食い違う | simplification | **RT では一度も実行されない**（`explicit_line == false` の間は固定経路へ分岐する）ことを明記。不整合ではない |
| `explicit_line` は `SetGlobalGain` でも `true` になる | simplification | フィールドの doc に明記（名前は「明示的な line が入ったか」の意） |

🔴 **1 件は指摘が誤りだった（適用しかけて戻した）**。simplification が「`gain` の上限チェックが
session 側にしか無い＝乖離」と報告したので条件を揃えたが、**型が違うため乖離ではない**:
session は JSON の **f64** を受けるので `> f32::MAX` を弾いてから `as f32` する必要がある（変換で
`inf` になるのを防ぐ）。`engine_wrap` 側は既に **f32** で、`is_finite()` が `inf` を弾き、有限な f32 は
定義上 `f32::MAX` 以下。戻した上で**理由をコメントに残した**（次に同じ指摘が出ても即座に却下できる）。

**skip したもの**:

| 指摘 | skip の理由 |
|---|---|
| forward-only 判定が 3 箇所目 / activation ループが同一 | 相手の `set_bus_routing` は **PR-O6 で退役**（計画 §1.10）。今統合すると O6 で解く手間が増える。かつ `set_bus_line` が `bus_kinds` を見ないのは設計 §4.1 の**裁定 ③（kind は問わない）どおり** |
| `LineOp::Gain` の逐語重複（6 行 × 2） | 軽微。master と insert bus で buffer と `ramp_frames` の取得元が違い、抽出しても引数で受け渡すだけになる |
| `bus_lines` / `bus_line_programs` の二重 map | 旧 `SetBusRouting` と対になっており、PR-O6 で片方が消える |
| Render/Link の判断が 3 層 4 箇所 | 一本化は範囲が大きい。**一次情報は `validate_line_program`** である旨を各所のコメントに書いて代替した |

**efficiency は「該当なし」**が結論 — RT パス（`execute_master_line` / `LineSlot::load`）に
**alloc・lock・syscall は無く**、`LineSlot` / `LineExchange` の退役規律も PR-O3a の insert bus と
**同じ型をそのまま再利用**している。control 側の clone やロック区間の指摘はすべて
「ユーザー操作 1 回・低頻度」の規模だった。

適用後の再検証: cargo **617 / 339 passed・0 failed**（変更前と同数）・fmt・clippy 警告なし・
`docs:check` **1,012 verified / 0 failed**（helper 追加で行番号が動いたので `--fix` で再アンカー）。

#### 🔴 レビュー・ラウンド 1 — 既存機能の回帰を 1 件止めた

レビューチーム 4 名 + Fable 監査を**並行**投入（CLAUDE.md）。**Critical 5 / Important 3 / Minor 2**。

##### 最重要: `global.gain()` の可聴ポップ（**code-reviewer と Fable が独立に指摘**）

`SetGlobalGain` を master line へ写した結果、`LineProgram::new` が `current_gain` を全 op で 1.0 から
始めるため、**2 回目以降の `global.gain()` で ramp が unity から再開**する。直前の実効ゲイン
（例 −20 dB）から目標（−10 dB）へ寄る代わりに**一度 1.0 へ跳ね上がってから寄る** — 64 frame の
小バッファでは数ブロックかかるので可聴のポップになる。

🔴 **これは新機能の不足ではなく回帰**である。この PR の前は `SetGlobalGain` が `gain_target` atomic を
更新するだけで、`advance_gain` が**呼び出しをまたいで `gain_current` を連続させていた**。

**裁定と、その前にやったこと**: 設計 §4.2 は「**意味を変えない形で**写す」と書いており、条件を
満たしていない。運用規則 6 に従い**設計を先に更新**してから実装を直した:

| 文書 | 追記 |
|---|---|
| §4.2 | 🔴 **この写しは PR-O4 と同時**。O3b で写すと TS がまだ `SetGlobalGain` を送るので回帰する |
| §5.1 | 🔴 **再 publish 時の `current_gain` 初期値規則**（本書に欠けていた節）|

Fable が「**§5.1 に新 program の初期値規則が無い**」と指摘したのが要点だった。規則が無いので
実装者が判断できず、Codex は素直に `LineProgram::new` を使った。**規則を先に書く。**

##### 適用した fix（Codex・ポリシーを 1 本にまとめて一括発注）

| # | 何を |
|---|---|
| 1 | `set_global_gain` から master line 再 publish を**外した**（`master_gain.store` のみ＝この PR の前と同じ）|
| 2 | 🔴 **`master.line.set_sample_rate` の呼び忘れ**（Fable）。`LineSlot::new` は `ramp_frames: 240` 固定で、呼び出しは insert bus の 1 箇所だけだった → 44.1k / 96k で master の ramp が 5 ms からずれていた |
| 3a | `bus_actives` の活性化テスト（旧 `SetBusRouting` には前例があるのに新規側に無かった）|
| 3b | **device channel の 1 始まり → 0 始まり変換**。🔴 `device_dest_from_wire` は**どのテストからも一度も実行されていなかった** |
| 3c | `set_bus_line("master", …)` の成功系と全か無か（既存の master テストは installer を直接呼んでおり `set_bus_line` を通らなかった）|
| 3d | 裁定③（kind を問わない）の**正のテスト**。🔴 Codex が「**kind チェックを復活させても既存 290 件は全緑**」を先に実証してから追加した＝変異検証として機能した |
| 4 | `debug_assert!` が release で no-op であること・到達不能を保証するのは control 層だけであること・破れたら**無音でログにも残らない**ことをコメント化（実装は変えない）|
| 5 | `explicit_line` の doc から**一次文書に根拠の無い一文**を削除（`/simplify` で main が書いたもの）|

##### 検証（🔴 すべて main が本ツリーで実行）

| 検証 | 結果 |
|---|---|
| `cargo test --workspace` | **617 passed / 0 failed / 38 ignored** |
| `cargo test`（outproc features） | **344 passed / 0 failed / 13 ignored**（339 → 344・新規 5 件）|
| fmt / clippy 2 本 | 警告なし |
| `npm test` | **2,329 passed / 58 skipped** |
| `npm run lint` / `typecheck:e2e` / `docs:build` | 緑 |
| `npm run docs:check` | **1,012 verified / 0 failed**（Rust の行番号が動いたので `--fix` + 引用の中身を差し替え）|

🔴 **Codex は sandbox で cargo の 29 件 / 32 件を落としていた**（`bind_localhost ... Operation not
permitted`）。本ツリーでは **bind エラー 0 件で全緑**。「委譲先の緑は実機の緑ではない」が再現した。

##### owner の裁定を仰いでいる 2 件（O3b の範囲外）

Fable が **設計 §4.1 自体が 2026-09-03 の裁定を反映していない**ことを発見した:

- **`pan` op が wire に無い** — §2.4b / W-18 は「wire に `pan`」と書くが §4.1 の `WireLineOp` は 3 op
- **mono device が wire で表現できない** — §2.2 の `mix.output(3)` / §5.1 の `right: None` に対し、
  §4.1 の `channels: [number, number]` は 2 要素必須

実装は §4.1 に忠実なので**本 PR の欠陥ではない**。§4.1 の改訂自体は運用規則 6 に従い今やるべきだが、
束の範囲を広げる判断なので owner の裁定待ち。

#### 🔴 束の締め — 収束条件を満たした（2026-09-09 実測）

**マージ前ゲート**（無条件の 3 行 + build）:

| ゲート | 結果 |
|---|---|
| `npm run build` | errors 0 |
| `bash rust/crates/orbit-std-gain/bundle-macos.sh` | `Gain.clap` 生成 |
| `cargo test -p orbit-effect-rack-child --lib -- --ignored` | **3 passed**（実 gain プラグイン依存）|
| `cargo test -p orbit-effect-rack-child --lib`（`--ignored` **無し**）| **16 passed**（退行検知テストが実際に走った）|

**実機 gated 全件**（`npm run test:e2e:gated`・523 秒）: **29 passed / 1 failed**。

🔴 **収束条件「goldens が 1 つも動かないこと」を達成**:

| golden | 実測 |
|---|---|
| `#611 O0-1` no-bus RMS | `0.08701663328646671` / `0.0870166332956341`（2 セッション）|
| `#611 O0-2` sum-output RMS | `0.08701663328620282` |
| `#611 O0-3` `send(0.3)` の total/dry | **`1.300000013268198`**（= 1 + 0.3）|
| `#611 O0-4` `effect + gain(-6)` | `effectOnly 1.9952622668994517` / `combined 0.9999999200541101` |

**4 件とも通過**。`#611 O0-4`（#775 の間欠故障）も**今回は緑**で、U2 に該当するログは 0 行だった。

唯一の失敗は **`steps the live playhead`**（`timed out waiting for [STEP] markers ... after 20000ms`）で、
これは **main baseline の既知の赤**（台帳に記載済み）。**新しい赤は 0 件。**

孤児プロセス（`OrbitStudio` / `orbit-audio-daemon`）の残留なしも確認した。

⚠️ **ログの所在で 2 回つまずいた**: `nohup` を `dangerouslyDisableSandbox` で回すと `$TMPDIR` が
**sandbox 内とは別のパス**（`/var/folders/…/T/`）を指すため、sandbox 内から読めない。
**完了マーカー（`EXIT=`）を先に見て集計行が無いことに気づいた**ので、「テスト本体に到達していない」と
判断でき、実装ではなくログの所在を疑う方向に進めた。

#### 🔴 owner 裁定（2026-09-10）— §4.1 を改訂し、`pan` / mono の実装は PR-O4 へ

Fable が **設計 §4.1 だけが 2026-09-03 の裁定に追従していなかった**ことを発見した。

| 層 | mono `device` | `pan` op |
|---|---|---|
| §2.2 / §2.4b（DSL 表面・09-03 裁定）| `mix.output(3)` = L+R マージ（Q-611-5）✅ | ライン要素（Q-611-4）✅ |
| §2.x の TS 型（`:162` `:179`）| `[number,number] \| [number]` ✅ | `{ kind: 'pan' }` ✅ |
| §5.1 / §5.3（Rust 型・RT 式）| `Device { right: Option<usize> }` ✅ | `LineOp::Pan` と式 ✅ |
| 🔴 **§4.1（wire）** | **2 要素固定** ❌ | **3 op のみ** ❌ |

🔴 **PR-O3b の実装は §4.1 に忠実だったので、実装の欠陥ではない。**
**正本が古いと、忠実さがそのまま欠落になる。**

**裁定**: §4.1 を改訂し、**実装は両方 PR-O4（束 O-surface）で 1 回にまとめる**。

**なぜ O3b でやらないか**（2 件でコストが違うので分けて判断した）:

| | mono `device` | `pan` op |
|---|---|---|
| RT の実装 | ✅ **既にある**（`add_to_device` が `right: None` で L+R を 0.5 マージ）| ❌ **無い**（`validate_line_program` が拒否し実行側も空）|
| 必要な作業 | wire の型と parse（約 40 行）| wire + **RT 実行**（等パワー・約 150 行）|

`pan` は RT 実装を伴うので O3b に入れると**「振る舞いを変えない」という束の性格が壊れ、
goldens の「動かないこと」という検算が使えなくなる** — O3 を O3a / O3b に割ったのは
まさにこの検算を守るためだった。mono だけ先に足すと **wire を 2 回変える**ことになり、
一方通行の変更回数が増える。したがって**両方を O4 で 1 回にまとめる**。

⚠️ 計画 §2.1 の「1 PR で wire と DSL の両方を変えると golden の差分がどちら由来か分からない」に
抵触するが、**`pan` については §2.4b が既に「`pan` を含む譜面の golden は再ベースライン」と
裁定済み**（owner 受け入れ済み）なので、帰属問題はその範囲で扱える。

**更新した文書**: 設計 §4.1（型・検証表 2 行・経緯の引用ブロック）/ 計画 §1.10 の PR-O4 行
（wire + RT の `Pan`・`SetGlobalGain` の写しも O4）。

#### 未検証・次の束へ

- 実機 gated（**goldens が 1 つも動かないこと**）は**束の締め**で 1 回 → ✅ **上記のとおり達成**
- 🔴 **PR-O4 が引き継ぐもの**（本 PR では実装しない）: `pan` op の wire + RT / mono `device` の wire /
  `SetGlobalGain` の master line への写し（§4.2・ramp の実効値引き継ぎ機構とセット）
- `LineOp::Pan` の wire 表現は無い（§4.1 の `WireLineOp` に `pan` が無い・PR-O4）
- `dest.render` は登記簿（`DeclareRender`・PR-R2）が無いので今日はすべて拒否

---

### chore(docs): rotate WORK_LOG before the O-wire-b bundle (Sep 9, 2026)

**ブランチ**: `611-o3b-setbusline` → `611-line-wire-b`（束 O-wire-b の前処理）

`tests/docs/worklog-size.spec.ts` の上限 2,000 行に対し **1,998 行**（残り 2 行）だったので、
PR-O3b のエントリを書く前にローテーションした。

| | 前 | 後 |
|---|---|---|
| `docs/development/WORK_LOG.md` | 1,998 行 | **1,430 行** |
| `docs/archive/WORK_LOG_2026-09.md` | 4,535 行 | 5,119 行 |

移設したのは **Sep 6 のエントリ 11 件**。archive 側に
「## 09-06 の追補（本体の 2,000 行上限で移設・2026-09-09 第 3 回）」を新設して先頭へ入れた。
本体末尾の索引と `docs/core/INDEX.md` の表は **`2026-09（前半・09-01〜09-06）` のままで正しい**
（移したのが 09-06 の範囲内なので期間が変わらない）。

🔴 日付が混在していたので**行の位置ではなく見出しの日付で選別**した。Sep 6 群の間に
Sep 7 のエントリ 2 件（E-gate のレビュー fix と `/simplify`）が挟まっていたため、
行範囲で切ると一緒に移動してしまう。

---

### docs: restore the three index lines the #821 consolidation dropped (Sep 8, 2026)

**追従元**: PR [#821](https://github.com/signalcompose/orbitscore/pull/821)（マージコミット `2489218` / head `8c40ce8`）/ **ブランチ**: `claude/docs-sync-pr821`

#821 は 3 本のルーティン追従 PR（#809 / #818 / #820）を 1 コミットにまとめ直したが、**その過程で 3 行が落ちた**。PR 本文は「中身はそのまま」と書いており削除に触れていない。**同じ PR が入れた WORK_LOG 本文が、落ちた行を実在する前提で書いている**（#820 分「#819 は CLAUDE.md と INDEX.md からポインタを張った」/ #818 分「INDEX.md Planning 表に `issue-states.json` を登録」）ため、意図した削除ではなく取りこぼしと判断して復元した。

#### 直した箇所

| ファイル | 何を | 出どころ |
|---|---|---|
| `CLAUDE.md:181-183` | Development Commands 直後の macOS スキャン警告（`MACOS_DEV_SETUP.md` へのポインタ）| PR #819（`6e22a84`）が追加 → #821 が削除 |
| `docs/core/INDEX.md:118` | Development 表の `MACOS_DEV_SETUP.md` 行 | 同上 |
| `docs/core/INDEX.md:243` | Planning 表の `issue-states.json` 行（生成物・手で編集しない）| PR #818 に在ったが #821 に入らなかった |

復元前、`MACOS_DEV_SETUP.md` は `docs/testing/TESTING_GUIDE.md:30` と WORK_LOG 本文からしか辿れず、`issue-states.json` はどこからも索引されていなかった。🔴 **この取りこぼしを赤にするテストは無い**（`worklog-size.spec.ts` は行数とアーカイブ名、`planning-issue-state.spec.ts` は状態語の矛盾しか見ない）。提案は PR 本文へ回した。

#### 追従不要と判断したもの

#821 の差分 6 ファイルはすべて docs で、`packages/engine/`・`rust/`・`packages/vscode-extension/` に変更が無い。DSL の構文・意味論、MCP ツールの引数と返り値、エディタの評価経路のいずれも変わらないため、`docs/specs-v2/`・`docs/core/INSTRUCTION_ORBITSCORE_DSL.md`・`sites/user/`・`sites/dev/`（日英とも）は対象外。

---

### docs(testing): point the testing guide at the macOS setup trap (PR #819 follow-up) (Sep 8, 2026)

**追従元**: PR [#819](https://github.com/signalcompose/orbitscore/pull/819)（マージコミット `6e22a84` / head `5ef4151`） / **ブランチ**: `claude/docs-sync-pr819`

docs-sync ルーチンが PR #819 のマージを受けて実行。#819 は `docs/development/MACOS_DEV_SETUP.md` を
新設し、CLAUDE.md と `docs/core/INDEX.md` からポインタを張ったが、**Rust テストの手順書である
`docs/testing/TESTING_GUIDE.md` には張られていなかった**。同ガイドの Prerequisites は
「Rust toolchain」「macOS Apple Silicon」を要求しつつ、設定なしの macOS では
`cargo test --workspace` が 37 分かかる事実に触れていない。

#### 変更

- `docs/testing/TESTING_GUIDE.md` の System Requirements 直後に `MACOS_DEV_SETUP.md` への
  ポインタを追加（2,240 秒 → 66 秒・遅さの 91% はマルウェアスキャン・件数は不変）

#### 追従不要と判断したもの

#819 の差分は 4 ファイルすべてがドキュメント（CLAUDE.md / `docs/core/INDEX.md` /
`MACOS_DEV_SETUP.md` / WORK_LOG.md）で、`packages/engine/`・`rust/`・
`packages/vscode-extension/` に変更が無い。DSL の構文・意味論、MCP ツールの引数と返り値、
エディタの評価経路のいずれも変わらないため、`docs/specs-v2/`・
`docs/core/INSTRUCTION_ORBITSCORE_DSL.md`・`sites/user/`・`sites/dev/` は対象外。
`sites/dev/` は内部構造の解説サイトで開発機セットアップの章を持たない（`orientation/` は
`what-is-orbitscore.md` と `architecture-overview.md` のみ）。

---

### docs: follow up PR #815 — record the new planning-doc ratchet where the rules live (Sep 8, 2026)

**追従元**: PR [#815](https://github.com/signalcompose/orbitscore/pull/815)（#814・merge commit `5eaea2f`）/
**ブランチ**: `claude/docs-sync-pr815` → main（ルーティンのドキュメント追従）

PR #815 は**仕組み**（`tests/docs/planning-issue-state.spec.ts`）と**運用規則**
（`BUNDLE_BRANCH_WORKFLOW.md` §5.1b）を足したが、**それを列挙している既存の 3 箇所には入っていなかった**。
規律の一覧が実在の仕組みより古いままだと、次のセッションは「その仕組みは無い」と読む。

| 直した先 | 何を |
|---|---|
| `CLAUDE.md`「これらは仕組みで強制されている」 | 表に 1 行追加。**捕まえるのは状態語の矛盾だけ**で内容の誤りは通ることも併記（出典必須の運用へ送る）|
| `DEVELOPMENT_MAP.md` §0.2 | 運用規則 7（事実が変わった瞬間に地図を更新）・8（実測には出典）を追加。既存の規則 4「issue を閉じたら」より**広い**ことを明示 |
| `PROJECT_RULES.md` §1c（棚卸しの作法）| `KNOWN_STALE_BASELINE` が**棚卸しの入口**であること・直したら削ること・増やして通さないこと |
| `INDEX.md` Planning 表 | `docs/planning/issue-states.json` を**生成物**として登録 |

🔴 **`packages/` `rust/` `sites/` は 0 件。** 元 PR に実装の差分が無く、`sites/dev` は
コードの内部構造を扱う層なので追従先が無い（判断理由は PR 本文）。

---

### docs(index): follow PR #805 — the archive period label stayed at 09-05 (Sep 7, 2026)

**ブランチ**: `claude/docs-sync-pr805`（ルーチンによる docs 追従）

PR [#805](https://github.com/signalcompose/orbitscore/pull/805)（マージコミット `7a71f51`）の追従。
#805 は WORK_LOG のローテーションのみで、**DSL / ランタイム / OrbitStudio の表面は 1 行も動いていない**。
追従対象はアーカイブの索引 1 箇所だけだった。

#### 直した箇所

| ファイル | 内容 |
|---|---|
| `docs/core/INDEX.md:176` | 「Archived WORK_LOG」表の period 列 `2026-09（前半・09-01〜09-05）` → `09-01〜09-06` |

#805 はアーカイブ側 H1（`docs/archive/WORK_LOG_2026-09.md:1`）と本体末尾の索引
（`docs/development/WORK_LOG.md:1184`）を `09-01〜09-06` へ更新したが、`PROJECT_RULES.md:116` が
更新を義務づけている **3 箇所目の `docs/core/INDEX.md` が旧ラベルのまま**残っていた。

🔴 **仕組みがこの列を見ていない。** `tests/docs/worklog-size.spec.ts:44-53` の索引テストは
「`docs/archive/` にある `WORK_LOG_YYYY-MM.md` が本体末尾から辿れるか」= **ファイル名の存在**しか
照合しない。period 列のラベルも INDEX.md 側の表も検査範囲の外なので、ずれても緑のままになる。

#### 追従不要と判断したもの

- `docs/archive/WORK_LOG_2026-09.md`（+790 行）と `docs/development/WORK_LOG.md`（-786 行）の
  本文 — **移設のみで内容は不変**（#805 が文字列比較で同一性を確認済み）。参照先が本体から
  archive へ移るが、`sites/**` からの `development/WORK_LOG.md` 名指しは 0 件で、
  `sites/dev/editor/vscode-architecture.md:918`（および `en/` 同行）は既に archive を指している
- `sites/dev/` の各章 — 内部構造・評価経路は変わっていない
- `docs/specs-v2/` / `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` — DSL の構文・意味論は変わっていない

#### 🔴 #805 は `fmt / clippy / test` が赤いままマージされている

`device_switch_result_records_failure_and_success_through_the_same_path` の `captured log: ""`
（`rust/crates/orbit-audio-daemon/src/engine_wrap.rs:10723`）。**再実行（run_attempt 2）でも再発**。
既知の flaky #801 で、docs のみの差分とは無関係。PR [#808](https://github.com/signalcompose/orbitscore/pull/808)
（`801-tracing-interest-anchor`）が anchor subscriber で直しており、その run は緑。

---

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
| `sites/dev/rust-engine/insert-bus.md` | `InsertBusStage` の mixer 用 4 フィールド（`output_target` / `sends` / `routing_override` / `send_gain_overrides`）が **`line: LineSlot` の 1 本**へまとまった。`LineOp` の並びが「ラックの位置・gain・出口」を表す。source 無し専用の `render_engine_with_insert_buses` は `#[cfg(test)]` のラッパーへ後退 | `rust/crates/orbit-audio-native/src/output.rs:1314-1336,932-939,1785-1790` |
| `sites/dev/editor/execution-feedback.md` | stdout の 4 分岐が `for` ループから prefixer callback へ移った理由（引用のインデントが 8 → 4 になった）と、それ以前は `evalMark` 応答がまるごと失われて `evaluateForAgent()` が timeout していたこと | `packages/vscode-extension/src/extension.ts:1499-1507` |

5 章の frontmatter は `verified-against: 66efda5` / `verified-at: 2026-09-08` に更新した。

#### 🔴 先行する追従 PR 2 本をここへ統合した（#807 / #812 は close）

`claude/docs-sync-pr806`（#807・#773 の追従）と `claude/docs-sync-pr810`（#812・PR-O3a の追従）は、
**本 PR と同じ章の同じ主題を、1 つ前の code に対して**書いていた。#811 が束として main に入った時点で
両者の引用は壊れており（`docs:check` で 8 件 FAIL）、地の文も `StringDecoder` 導入前の説明のままだった。

そこで **両者にしか無いファイルだけを本 PR へ取り込み**、重複していた 4 章
（`vscode-architecture.md` / `mcp-and-gated-e2e.md` / `rust-engine/index.md` /
`signal-chain/mixer-audio-line.md`）は**本 PR の版＝最新 code に対する記述を採った**。
取り込んだのは上表の下 2 行。引用は `check-citations.mjs --fix` で再アンカーし、
PR 参照は束のマージ PR **#811** に統一した（dev サイトは main の履歴を基準にするため）。

🔴 **教訓**: ルーティンの追従 PR を溜めると、追従先の code が動いて**追従そのものが陳腐化する**。
6 本溜まった時点で 3 本が同じ章を奪い合っていた。`BUNDLE_BRANCH_WORKFLOW` §4 が
「束を開く前に全部消化する」と言っているのは、衝突だけでなくこの陳腐化も理由である。

#### 追従不要と判断したもの

- `docs/specs-v2/` / `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` / `sites/user/` / `docs/user/ja/USER_MANUAL.md`
  — この束は `packages/engine/` を 1 行も触っておらず、DSL 表面（構文・チェーンメソッド・宣言形式）も
  wire 契約も変わっていない。`SetBusLine` と DSL 表面は次の束（O3b / O-surface）
- `rust/crates/orbit-audio-daemon/src/test_tracing.rs`（#801）— テストハーネスのみ。dev サイトに該当章が無い
- `docs/design/611-output-line-design.md` — 起案時点のスナップショットなので後から書き換えない（ルーチン規約）

#### 検証

`npm run docs:build`（user / dev）と `npm run docs:check` を実行。結果は PR 本文に貼付。

---

### perf(test): the Rust test cycle was 91% macOS malware scanning — 2,240s to 66s (#816) (Sep 8, 2026)

**Issue**: #816 / **ブランチ**: `816-test-cycle-perf` → main（直行）

#### 発端（owner）

> テストは重要なのですが、**過剰なテストになっていませんか？** テストを正しく無駄なく行う方法はありませんか？

#### 🔴 答え: 過剰ではなかった。テストは 80 秒しか走っていない

`cargo test --workspace --locked`（1 ファイル変更後）の内訳を実測で分解した:

| 内訳 | 時間 | 割合 |
|---|---|---|
| ビルド + リンク | 101 秒 | 5% |
| **テスト自身の実行** | **80 秒** | 4% |
| 🔴 **バイナリ初回起動の macOS 検査** | **約 34 分** | **91%** |

決定的な観測 — **同じバイナリを 3 回起動**した:

```
run 1: 23.22 秒   ← 初回
run 2:  0.004 秒
run 3:  0.004 秒
```

CPU サンプリングで犯人も特定した: **前半 5 秒が `syspolicyd`（Gatekeeper）・後半 6 秒が
`XprotectService`（マルウェアスキャン）**。

🔴 **`cargo test` はこの検査にとって最悪のケース**である。テストバイナリは**1 回しか実行されない**ので
キャッシュが効く前に用済みになり、このワークスペースは**77 個**作る。しかも
**`XprotectService` はシングルスレッド**なので、並列に起動しても検査は 1 本ずつしか進まない。

#### 対策と結果

**ターミナル（Ghostty）をデベロッパツールに登録 + ターミナル再起動 + `cargo clean`**。

| | ベースライン | 対策後 |
|---|---|---|
| **所要** | **2,240 秒（37 分 20 秒）** | 🔴 **66 秒** |
| passed / failed / ignored | 615 / 0 / 38 | **615 / 0 / 38** |
| スイート数 | 93 | **93** |
| テストバイナリ | 77 | **77** |

🔴 **検証の範囲も結果も 1 つも変わらず 34 倍。** 「速度と正しさを交換する」類ではない。

#### 🔴 `cargo clean` が要る理由（ここを飛ばすと効かない）

設定は「**これから作られるバイナリ**」にしか効かない。`target` に残っている成果物（**71 GB** あった）は
**設定前のまま**なので検査され続ける。nextest の公式が
"You may also need to run `cargo clean` afterwards" と書いているとおりだった。

**設定だけ入れて `cargo clean` しなかった段階では、32 秒のまま変化しなかった。**

#### 効かなかったもの（記録・再試行の必要なし）

| 手 | 結果 |
|---|---|
| `codesign -v` で事前検証 | ❌ 13.6 秒かけても初回起動は 76 秒。**署名検証と実行時スキャンは別物** |
| バイナリを並列に warm up | ❌ `XprotectService` がシングルスレッドなので直列化する |
| `sudo spctl developer-mode enable-terminal` 単独 | ❌ **Terminal.app を追加するだけ**でトグルも ON にならない。Ghostty 利用時は無関係 |

⚠️ **並列 warm up の自作は危険**でもあった。`--list` を渡しても、テストバイナリではない実行ファイル
（`orbit-plugin-scan` / `sandbox-effect-child`）は**引数を無視して本体として起動する**。
実際にやってしまい 8 分以上走り続けた。**止めて方法を変えた。**

#### 🔴 このリポジトリは既に半分知っていた

`orbit-audio-sandbox/src/child.rs:107` の `warm_up_executable`（#520）が
「`cargo build` 直後の child は macOS のセキュリティ評価を伴い**数秒〜24 秒**止まりうる」と
コメントしていた。**個別のテストには対策済みで、テストサイクル全体には効いていなかった。**

同日「実機の赤を実装のせいにしかけた」3 件のうち 2 件も**同じ Gatekeeper** が原因だった。
**同じ現象に 3 つの別々の名前を付けて、別々に対処していた**ことになる。

#### 残したもの

- **`docs/development/MACOS_DEV_SETUP.md`**（新設）— 手順・トレードオフ・効かなかった手
- **CLAUDE.md の Development Commands** と **`docs/core/INDEX.md`** からポインタ
  （次のセッションが最初に読む場所に置く）

#### 🔴 owner の環境で変えたもの（リポジトリ外・戻す時の参照）

| # | 何を | 状態 |
|---|---|---|
| 1 | **Ghostty をデベロッパツールに登録（ON）** | 🔴 **これが効いた。外すと 37 分に戻る** |
| 2 | `sudo spctl developer-mode enable-terminal` | ⚪ **無関係**（Terminal.app 対象・トグル OFF）。戻してよい |
| 3 | `cargo-nextest` を `~/.cargo/bin` に導入 | ⚪ **未使用**。原因が別だったので出番が無かった |

⚠️ **戻し方**: `spctl` に `disable-terminal` は**無い**（main が誤って案内し訂正した）。
解除は **システム設定 → プライバシーとセキュリティ → デベロッパツール** で
トグル OFF か `−` で削除する。

#### 方針として採らなかったもの

**「`--workspace` を毎回回さない」は採らない。** 検証の範囲を狭める手であり、このリポジトリは
「委譲先の緑は実機の緑ではない」「配線は E2E でしか見えない」という失敗を繰り返している。
**範囲を狭めると同じクラスの事故が戻る。** 今回の対策は「**同じ検証を速くする**」だけなので失うものが無い。

---

### chore(docs): stop planning documents from drifting silently (#814) (Sep 8, 2026)

**Issue**: #814 / **ブランチ**: `814-doc-drift-check` → main（直行）

#### 発端 — owner の問い

束 O-wire を閉じる直前、owner に「**先に送った内容は地図・設計・プランに反映してあるか**」と問われ、
一次ソースで確認したら**不十分だった**。さらに「**現状の地図や設計、実装プランが正しいことは保証
できますか**」と問われ、**保証できないと答えた**（確認したのは 3 項目だけだった）。

🔴 **地図の #801 行が「実測は負荷依存」のままだった。** これは**同日の実測で否定された記述**である。
**地図は次のセッションが最初に読む層**なので、古い記述は**申し送りの誤りを再生産する** —
実際その束は、旧 `/goal` の「負荷をかけて再現条件を作る」という**誤った前提から始まっていた**。

#### 実測した規模

| 文書 | 参照している issue（ユニーク）|
|---|---|
| `DEVELOPMENT_MAP.md` | **174 件** |
| `IMPLEMENTATION_PLAN_2026-09.md` | 90 件 |

⚠️ **粗い検出（同一行に複数 issue）だと 18 件出るが、行の主題で絞ると 4 件**だった。
**数字を出すときは検出条件の粗さも一緒に言う** — 一度「18 件」とだけ報告して owner に問い返された。

#### ① 手順書に「いつ更新するか」を書いた（`BUNDLE_BRANCH_WORKFLOW.md` §5.1b）

**「後でまとめて書く」は必ず忘れる。** 同日の失敗はすべて「変わった直後に書かなかった」ことだった。

| 時点 | 何を | なぜ |
|---|---|---|
| 🔴 **事実が変わった瞬間** | **地図** | 「今どうなっているか」の層。次のセッションが最初に読む |
| 🔴 **決めた瞬間（実装の前）** | **計画・設計** | `CLAUDE.md` 運用規則 6「spec 側を先に更新してから実装する」|
| 束を閉じる前 | 3 文書の突合 | 上 2 つができていれば**確認だけ**で済む |

手順表にも 2 行足した（束を開く前の grep・束を閉じる前の突合）。

🔴 **「実測」を書くときは出典（日付 / PR / commit）を必須にする**とも定めた。
テストが捕まえるのは状態語の矛盾だけで、**内容の誤りは捕まらない**。
出どころがあれば次の人が「これは 09-07 の測定で 09-08 に否定されている」と気づける。

#### ② 突合テストを新設（`tests/docs/planning-issue-state.spec.ts`）

- 文書の `#NNN` を抽出 → **行の主題**（最初に現れる番号）が CLOSED かを判定
- CLOSED なのに `未着手` `引き込む` `予定` 等があれば **red**
- **ベースラインでラチェット**（`dsl-e2e-coverage.spec.ts` と同じ形）

🔴 **テストは GitHub API を叩かない。** issue の状態は
`docs/planning/issue-states.json`（`scripts/docs/refresh-issue-states.mjs` が生成）に固定する。
テストがネットワークとレート制限で落ちると、**#801 と同じ「赤の帰属ができない」状態**を持ち込む。

#### 🔴 テストが初回から本物を 5 件捕まえた

| 行 | 記述 | 実際 |
|---|---|---|
| `MAP:1136` `MAP:1139` | #773 を「**束 O-wire に引き込む**」 | **同日 CLOSED**（PR #811）|
| `PLAN:332` | #780 の束が「**ステージ 2 に着手する前提**」 | **09-07 完了**・ステージ 2 は着手済み |
| `PLAN:333` | #773 を「**引き込み**」 | 同上 |
| `PLAN:499` | #801 を「**O-wire に引き込む**」 | **同日 CLOSED** |

**5 件を直した。** 誤検知 3 件（行頭の番号が主題でない形）は**理由を書いてベースラインへ**。
主題の判定を賢くするより、**少数の誤検知を明示的に許容する**ほうが読みやすいと判断した。

#### 変異検証（main が実行）

| 変異 | 結果 |
|---|---|
| 閉じた issue を「未着手」と書く行を足す | ✅ **red**（該当行を名指し）|
| ベースラインから 1 件消す | ✅ **red** |

#### 🔴 変異の復元を確認して助かった

変異 2 のあと `git checkout -- tests/docs/planning-issue-state.spec.ts` で戻したつもりが、
**ファイルが未追跡（`??`）なので効いていなかった**。テストが赤のままで気づいた。
**「復元した」を確認せずに次へ進まない。**

#### このテストが捕まえないもの（過大評価しない）

| 誤りの型 | 捕まるか |
|---|---|
| 状態語の矛盾（CLOSED なのに「未着手」）| ✅ |
| 🔴 **内容の誤り**（「#801 は負荷依存」・issue は OPEN）| ❌ |
| 文書間のずれ（地図は「PR-O3」・計画は「PR-O3a」）| ❌ |

**同日いちばん危なかったのは 2 番目**で、そこは出典必須の運用で担保する。

---

## 束 O-wire（#611 ステージ 2・統合ブランチ `611-line-wire`）

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

### docs(index): follow PR #805 — the archive period label stayed at 09-05 (Sep 7, 2026)

**ブランチ**: `claude/docs-sync-pr805`（ルーチンによる docs 追従）

PR [#805](https://github.com/signalcompose/orbitscore/pull/805)（マージコミット `7a71f51`）の追従。
#805 は WORK_LOG のローテーションのみで、**DSL / ランタイム / OrbitStudio の表面は 1 行も動いていない**。
追従対象はアーカイブの索引 1 箇所だけだった。

#### 直した箇所

| ファイル | 内容 |
|---|---|
| `docs/core/INDEX.md:176` | 「Archived WORK_LOG」表の period 列 `2026-09（前半・09-01〜09-05）` → `09-01〜09-06` |

#805 はアーカイブ側 H1（`docs/archive/WORK_LOG_2026-09.md:1`）と本体末尾の索引
（`docs/development/WORK_LOG.md:1184`）を `09-01〜09-06` へ更新したが、`PROJECT_RULES.md:116` が
更新を義務づけている **3 箇所目の `docs/core/INDEX.md` が旧ラベルのまま**残っていた。

🔴 **仕組みがこの列を見ていない。** `tests/docs/worklog-size.spec.ts:44-53` の索引テストは
「`docs/archive/` にある `WORK_LOG_YYYY-MM.md` が本体末尾から辿れるか」= **ファイル名の存在**しか
照合しない。period 列のラベルも INDEX.md 側の表も検査範囲の外なので、ずれても緑のままになる。

#### 追従不要と判断したもの

- `docs/archive/WORK_LOG_2026-09.md`（+790 行）と `docs/development/WORK_LOG.md`（-786 行）の
  本文 — **移設のみで内容は不変**（#805 が文字列比較で同一性を確認済み）。参照先が本体から
  archive へ移るが、`sites/**` からの `development/WORK_LOG.md` 名指しは 0 件で、
  `sites/dev/editor/vscode-architecture.md:918`（および `en/` 同行）は既に archive を指している
- `sites/dev/` の各章 — 内部構造・評価経路は変わっていない
- `docs/specs-v2/` / `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` — DSL の構文・意味論は変わっていない

#### 🔴 #805 は `fmt / clippy / test` が赤いままマージされている

`device_switch_result_records_failure_and_success_through_the_same_path` の `captured log: ""`
（`rust/crates/orbit-audio-daemon/src/engine_wrap.rs:10723`）。**再実行（run_attempt 2）でも再発**。
既知の flaky #801 で、docs のみの差分とは無関係。PR [#808](https://github.com/signalcompose/orbitscore/pull/808)
（`801-tracing-interest-anchor`）が anchor subscriber で直しており、その run は緑。

---

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
| `sites/dev/rust-engine/insert-bus.md` | `InsertBusStage` の mixer 用 4 フィールド（`output_target` / `sends` / `routing_override` / `send_gain_overrides`）が **`line: LineSlot` の 1 本**へまとまった。`LineOp` の並びが「ラックの位置・gain・出口」を表す。source 無し専用の `render_engine_with_insert_buses` は `#[cfg(test)]` のラッパーへ後退 | `rust/crates/orbit-audio-native/src/output.rs:1314-1336,932-939,1785-1790` |
| `sites/dev/editor/execution-feedback.md` | stdout の 4 分岐が `for` ループから prefixer callback へ移った理由（引用のインデントが 8 → 4 になった）と、それ以前は `evalMark` 応答がまるごと失われて `evaluateForAgent()` が timeout していたこと | `packages/vscode-extension/src/extension.ts:1499-1507` |

5 章の frontmatter は `verified-against: 66efda5` / `verified-at: 2026-09-08` に更新した。

#### 🔴 先行する追従 PR 2 本をここへ統合した（#807 / #812 は close）

`claude/docs-sync-pr806`（#807・#773 の追従）と `claude/docs-sync-pr810`（#812・PR-O3a の追従）は、
**本 PR と同じ章の同じ主題を、1 つ前の code に対して**書いていた。#811 が束として main に入った時点で
両者の引用は壊れており（`docs:check` で 8 件 FAIL）、地の文も `StringDecoder` 導入前の説明のままだった。

そこで **両者にしか無いファイルだけを本 PR へ取り込み**、重複していた 4 章
（`vscode-architecture.md` / `mcp-and-gated-e2e.md` / `rust-engine/index.md` /
`signal-chain/mixer-audio-line.md`）は**本 PR の版＝最新 code に対する記述を採った**。
取り込んだのは上表の下 2 行。引用は `check-citations.mjs --fix` で再アンカーし、
PR 参照は束のマージ PR **#811** に統一した（dev サイトは main の履歴を基準にするため）。

🔴 **教訓**: ルーティンの追従 PR を溜めると、追従先の code が動いて**追従そのものが陳腐化する**。
6 本溜まった時点で 3 本が同じ章を奪い合っていた。`BUNDLE_BRANCH_WORKFLOW` §4 が
「束を開く前に全部消化する」と言っているのは、衝突だけでなくこの陳腐化も理由である。

#### 追従不要と判断したもの

- `docs/specs-v2/` / `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` / `sites/user/` / `docs/user/ja/USER_MANUAL.md`
  — この束は `packages/engine/` を 1 行も触っておらず、DSL 表面（構文・チェーンメソッド・宣言形式）も
  wire 契約も変わっていない。`SetBusLine` と DSL 表面は次の束（O3b / O-surface）
- `rust/crates/orbit-audio-daemon/src/test_tracing.rs`（#801）— テストハーネスのみ。dev サイトに該当章が無い
- `docs/design/611-output-line-design.md` — 起案時点のスナップショットなので後から書き換えない（ルーチン規約）

#### 検証

`npm run docs:build`（user / dev）と `npm run docs:check` を実行。結果は PR 本文に貼付。

---

### perf(test): the Rust test cycle was 91% macOS malware scanning — 2,240s to 66s (#816) (Sep 8, 2026)

**Issue**: #816 / **ブランチ**: `816-test-cycle-perf` → main（直行）

#### 発端（owner）

> テストは重要なのですが、**過剰なテストになっていませんか？** テストを正しく無駄なく行う方法はありませんか？

#### 🔴 答え: 過剰ではなかった。テストは 80 秒しか走っていない

`cargo test --workspace --locked`（1 ファイル変更後）の内訳を実測で分解した:

| 内訳 | 時間 | 割合 |
|---|---|---|
| ビルド + リンク | 101 秒 | 5% |
| **テスト自身の実行** | **80 秒** | 4% |
| 🔴 **バイナリ初回起動の macOS 検査** | **約 34 分** | **91%** |

決定的な観測 — **同じバイナリを 3 回起動**した:

```
run 1: 23.22 秒   ← 初回
run 2:  0.004 秒
run 3:  0.004 秒
```

CPU サンプリングで犯人も特定した: **前半 5 秒が `syspolicyd`（Gatekeeper）・後半 6 秒が
`XprotectService`（マルウェアスキャン）**。

🔴 **`cargo test` はこの検査にとって最悪のケース**である。テストバイナリは**1 回しか実行されない**ので
キャッシュが効く前に用済みになり、このワークスペースは**77 個**作る。しかも
**`XprotectService` はシングルスレッド**なので、並列に起動しても検査は 1 本ずつしか進まない。

#### 対策と結果

**ターミナル（Ghostty）をデベロッパツールに登録 + ターミナル再起動 + `cargo clean`**。

| | ベースライン | 対策後 |
|---|---|---|
| **所要** | **2,240 秒（37 分 20 秒）** | 🔴 **66 秒** |
| passed / failed / ignored | 615 / 0 / 38 | **615 / 0 / 38** |
| スイート数 | 93 | **93** |
| テストバイナリ | 77 | **77** |

🔴 **検証の範囲も結果も 1 つも変わらず 34 倍。** 「速度と正しさを交換する」類ではない。

#### 🔴 `cargo clean` が要る理由（ここを飛ばすと効かない）

設定は「**これから作られるバイナリ**」にしか効かない。`target` に残っている成果物（**71 GB** あった）は
**設定前のまま**なので検査され続ける。nextest の公式が
"You may also need to run `cargo clean` afterwards" と書いているとおりだった。

**設定だけ入れて `cargo clean` しなかった段階では、32 秒のまま変化しなかった。**

#### 効かなかったもの（記録・再試行の必要なし）

| 手 | 結果 |
|---|---|
| `codesign -v` で事前検証 | ❌ 13.6 秒かけても初回起動は 76 秒。**署名検証と実行時スキャンは別物** |
| バイナリを並列に warm up | ❌ `XprotectService` がシングルスレッドなので直列化する |
| `sudo spctl developer-mode enable-terminal` 単独 | ❌ **Terminal.app を追加するだけ**でトグルも ON にならない。Ghostty 利用時は無関係 |

⚠️ **並列 warm up の自作は危険**でもあった。`--list` を渡しても、テストバイナリではない実行ファイル
（`orbit-plugin-scan` / `sandbox-effect-child`）は**引数を無視して本体として起動する**。
実際にやってしまい 8 分以上走り続けた。**止めて方法を変えた。**

#### 🔴 このリポジトリは既に半分知っていた

`orbit-audio-sandbox/src/child.rs:107` の `warm_up_executable`（#520）が
「`cargo build` 直後の child は macOS のセキュリティ評価を伴い**数秒〜24 秒**止まりうる」と
コメントしていた。**個別のテストには対策済みで、テストサイクル全体には効いていなかった。**

同日「実機の赤を実装のせいにしかけた」3 件のうち 2 件も**同じ Gatekeeper** が原因だった。
**同じ現象に 3 つの別々の名前を付けて、別々に対処していた**ことになる。

#### 残したもの

- **`docs/development/MACOS_DEV_SETUP.md`**（新設）— 手順・トレードオフ・効かなかった手
- **CLAUDE.md の Development Commands** と **`docs/core/INDEX.md`** からポインタ
  （次のセッションが最初に読む場所に置く）

#### 🔴 owner の環境で変えたもの（リポジトリ外・戻す時の参照）

| # | 何を | 状態 |
|---|---|---|
| 1 | **Ghostty をデベロッパツールに登録（ON）** | 🔴 **これが効いた。外すと 37 分に戻る** |
| 2 | `sudo spctl developer-mode enable-terminal` | ⚪ **無関係**（Terminal.app 対象・トグル OFF）。戻してよい |
| 3 | `cargo-nextest` を `~/.cargo/bin` に導入 | ⚪ **未使用**。原因が別だったので出番が無かった |

⚠️ **戻し方**: `spctl` に `disable-terminal` は**無い**（main が誤って案内し訂正した）。
解除は **システム設定 → プライバシーとセキュリティ → デベロッパツール** で
トグル OFF か `−` で削除する。

#### 方針として採らなかったもの

**「`--workspace` を毎回回さない」は採らない。** 検証の範囲を狭める手であり、このリポジトリは
「委譲先の緑は実機の緑ではない」「配線は E2E でしか見えない」という失敗を繰り返している。
**範囲を狭めると同じクラスの事故が戻る。** 今回の対策は「**同じ検証を速くする**」だけなので失うものが無い。

---

### chore(docs): stop planning documents from drifting silently (#814) (Sep 8, 2026)

**Issue**: #814 / **ブランチ**: `814-doc-drift-check` → main（直行）

#### 発端 — owner の問い

束 O-wire を閉じる直前、owner に「**先に送った内容は地図・設計・プランに反映してあるか**」と問われ、
一次ソースで確認したら**不十分だった**。さらに「**現状の地図や設計、実装プランが正しいことは保証
できますか**」と問われ、**保証できないと答えた**（確認したのは 3 項目だけだった）。

🔴 **地図の #801 行が「実測は負荷依存」のままだった。** これは**同日の実測で否定された記述**である。
**地図は次のセッションが最初に読む層**なので、古い記述は**申し送りの誤りを再生産する** —
実際その束は、旧 `/goal` の「負荷をかけて再現条件を作る」という**誤った前提から始まっていた**。

#### 実測した規模

| 文書 | 参照している issue（ユニーク）|
|---|---|
| `DEVELOPMENT_MAP.md` | **174 件** |
| `IMPLEMENTATION_PLAN_2026-09.md` | 90 件 |

⚠️ **粗い検出（同一行に複数 issue）だと 18 件出るが、行の主題で絞ると 4 件**だった。
**数字を出すときは検出条件の粗さも一緒に言う** — 一度「18 件」とだけ報告して owner に問い返された。

#### ① 手順書に「いつ更新するか」を書いた（`BUNDLE_BRANCH_WORKFLOW.md` §5.1b）

**「後でまとめて書く」は必ず忘れる。** 同日の失敗はすべて「変わった直後に書かなかった」ことだった。

| 時点 | 何を | なぜ |
|---|---|---|
| 🔴 **事実が変わった瞬間** | **地図** | 「今どうなっているか」の層。次のセッションが最初に読む |
| 🔴 **決めた瞬間（実装の前）** | **計画・設計** | `CLAUDE.md` 運用規則 6「spec 側を先に更新してから実装する」|
| 束を閉じる前 | 3 文書の突合 | 上 2 つができていれば**確認だけ**で済む |

手順表にも 2 行足した（束を開く前の grep・束を閉じる前の突合）。

🔴 **「実測」を書くときは出典（日付 / PR / commit）を必須にする**とも定めた。
テストが捕まえるのは状態語の矛盾だけで、**内容の誤りは捕まらない**。
出どころがあれば次の人が「これは 09-07 の測定で 09-08 に否定されている」と気づける。

#### ② 突合テストを新設（`tests/docs/planning-issue-state.spec.ts`）

- 文書の `#NNN` を抽出 → **行の主題**（最初に現れる番号）が CLOSED かを判定
- CLOSED なのに `未着手` `引き込む` `予定` 等があれば **red**
- **ベースラインでラチェット**（`dsl-e2e-coverage.spec.ts` と同じ形）

🔴 **テストは GitHub API を叩かない。** issue の状態は
`docs/planning/issue-states.json`（`scripts/docs/refresh-issue-states.mjs` が生成）に固定する。
テストがネットワークとレート制限で落ちると、**#801 と同じ「赤の帰属ができない」状態**を持ち込む。

#### 🔴 テストが初回から本物を 5 件捕まえた

| 行 | 記述 | 実際 |
|---|---|---|
| `MAP:1136` `MAP:1139` | #773 を「**束 O-wire に引き込む**」 | **同日 CLOSED**（PR #811）|
| `PLAN:332` | #780 の束が「**ステージ 2 に着手する前提**」 | **09-07 完了**・ステージ 2 は着手済み |
| `PLAN:333` | #773 を「**引き込み**」 | 同上 |
| `PLAN:499` | #801 を「**O-wire に引き込む**」 | **同日 CLOSED** |

**5 件を直した。** 誤検知 3 件（行頭の番号が主題でない形）は**理由を書いてベースラインへ**。
主題の判定を賢くするより、**少数の誤検知を明示的に許容する**ほうが読みやすいと判断した。

#### 変異検証（main が実行）

| 変異 | 結果 |
|---|---|
| 閉じた issue を「未着手」と書く行を足す | ✅ **red**（該当行を名指し）|
| ベースラインから 1 件消す | ✅ **red** |

#### 🔴 変異の復元を確認して助かった

変異 2 のあと `git checkout -- tests/docs/planning-issue-state.spec.ts` で戻したつもりが、
**ファイルが未追跡（`??`）なので効いていなかった**。テストが赤のままで気づいた。
**「復元した」を確認せずに次へ進まない。**

#### このテストが捕まえないもの（過大評価しない）

| 誤りの型 | 捕まるか |
|---|---|
| 状態語の矛盾（CLOSED なのに「未着手」）| ✅ |
| 🔴 **内容の誤り**（「#801 は負荷依存」・issue は OPEN）| ❌ |
| 文書間のずれ（地図は「PR-O3」・計画は「PR-O3a」）| ❌ |

**同日いちばん危なかったのは 2 番目**で、そこは出典必須の運用で担保する。

---

## 束 O-wire（#611 ステージ 2・統合ブランチ `611-line-wire`）

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

## 09-07〜09-08 の移設（本体の 2,000 行上限で移設・2026-09-10）

> 移設元: `docs/development/WORK_LOG.md`。本体は最新 18 エントリを保持する（PROJECT_RULES §1a）。

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

## 09-06 の追補（本体の 2,000 行上限で移設・2026-09-09 第 3 回）

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

---

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

---

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

---

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

---

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

---

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

---

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

---

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

---

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

---

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

---

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

---

## 09-04〜09-06 の追補（本体の 2,000 行上限で移設・2026-09-07 第 2 回）

### docs(dev-site): follow PR #776 — line-wise `ERROR:` prefixing (Sep 6, 2026)

**ブランチ**: `claude/docs-sync-pr776`（ルーチンによる docs 追従）

束 PR [#776](https://github.com/signalcompose/orbitscore/pull/776)（マージコミット `d2e94af`）が
`packages/vscode-extension/src/extension.ts` に足した `createLinePrefixer`（#756）が dev サイトに
載っていなかったので追従した。#760 の `transport.rs` 側（`CHILD_STATUS_LOAD_FAILED` の doc コメント）は
束の中で `sites/dev/rust-engine/oop-children.md` の日英とも追従済みだったため対象外。

#### 変更

| ファイル | 内容 |
|---|---|
| `sites/dev/editor/vscode-architecture.md` / `en/` | 「stderr を『行』に戻す — `createLinePrefixer` (#756)」節を新設。`partial` の持ち越し・`flush()`・空行を emit しない判定の 3 点と、「chunk → 行」実装が repo 全体で 4 つあること |
| `sites/dev/editor/mcp-and-gated-e2e.md` / `en/` | ERROR 会計の節に、窓とは別の偽緑（chunk 単位前置による構造的な過小カウント）と #756 の解消を追記 |

引用は `packages/vscode-extension/src/extension.ts:1599-1619` / `:1635-1657` を逐語。
4 章とも `verified-against` を `d2e94af` へ更新した。

#### 追従しなかったもの

- `tests/` の変更（`gated-assertion-hygiene.spec.ts` のラチェット再設計・`capture-windows.ts` の
  `waitForQuiet` 切り出し）— ルーチンはテストを変更しない。`waitForQuiet` は
  `sites/dev/editor/mcp-and-gated-e2e.md` の窓の節に追記する候補として PR 本文へ回した
- `docs/` の計画・設計・WORK_LOG — 束の中で更新済み

---

### fix(e2e): apply review round 1 — the ratchet was itself producing a false green (Sep 6, 2026)

**ブランチ**: `761-gated-measurement`（束 PR [#776](https://github.com/signalcompose/orbitscore/pull/776)）

レビューフロー ②③④。`/code:pr-review-team` フル編成 4 体と **Fable 監査を並行**起動し、
指摘を集約 → 設計パスを 1 つ置いてから fixer（Codex）へ一括委譲した。

#### 🔴 最重要: ラチェットが自分の守備範囲について嘘をついていた

#761 が足したラチェットは、コメントで「変数名を `errorsBefore` 系に限定しない」と書きながら、
正規表現は `[Bb]efore` の**直後**に演算を要求しており、実際には「**Before で終わる名前**」に
限定されていた。対象ソースに**生きた違反が 8 箇所**あった:

```
:4562 spawnsBeforeFull.length + 1     :4569 aRestoresBeforeFull + 1
:4573 bRestoresBeforeFull + 1         :4705 bRestoresBeforeReadd + 1
:4961 spawnsBeforeMaster.length + 1   :5645 countErrors(log) >= errorsBeforeExpectedFailure + 1
:5682 countLogMarker(...) - switchFailuresBefore ... .toBe(1)
:2303 catalogErrorsAfter ... .toBe(catalogErrorsBefore)
```

すり抜け経路は 3 つ — ① Before が名前の**途中** ② **素の比較式**（matcher でない）
③ **代数的な書き換え**（`後 − 前` を先に計算して literal と比較）。

**「0 offenders」は将来の読み手に「この bug class は絶滅した」と読まれる。**
偽緑を防ぐために足した仕組みが、**それ自身が偽緑の発生源**になっていた。

**直し方**: 正規表現を広げるのではなく **TypeScript AST** で検出する形へ。3 経路を全部塞ぎ、
ログ由来でない baseline（`stateFilesBeforeDropB` / `daemonPidsBeforeStart`）は**由来の説明つきで
明示 allow-list**（黙って外れない）。ラチェットが赤くした 8 箇所は全部 `newLogLines` /
`newErrorLines` へ移行した。🔴 **意味は弱めていない** — 「ちょうど 1 件増えた」は
`newLogLines(...).filter(...).toHaveLength(1)` に対応する（main が 1 件ずつ確認）。

#### ラチェットに肯定形のテストを足した

従来は実コーパスへの `toEqual([])` だけ＝**否定形のみ**で、検出器が壊れても緑だった。
`offendingLines` / AST 検出器を `entries` を引数に取る純粋関数へ切り出し、fixture で
「複数行の違反を見つける」「コメントアウトは見つけない」「clean は空」「行番号が正しい」
「Before が名前の途中でも・素の比較でも・代数的書き換えでも見つける」を固定（7 → 14 本）。

#### `waitForQuiet` の偽緑と診断性

- **偽緑**: `quietSec` ぶんのデータが無くても `true` を返した（50 ms しか無くても「300 ms 静か」）。
  2 レビュアーが独立に指摘し、片方は実証した。`captureTailRms` が実際に読めた `durationSec` を
  返し、**被覆するまで quiet と判定しない**形へ
- **診断性**: `catch {}` が全例外を飲み、新しい `expect(e3Quiet).toBe(true)` は bare boolean しか
  報告しなかった（置き換える前の `toBeLessThan` は実測 RMS を出していたので**後退**）。
  最後の tail RMS と例外を保持し、失敗文に載せる
- **短読み**: `readSync` の戻り値を検査（ゼロ埋め＝無音に化ける）。兄弟の `readCaptureFormat` は
  既に検査していた非対称を解消

#### 🔴 私が譲らなかった点

Fable は暫定措置として **U2 を診断へ降格**（throw せず warn）を提案した。suite のフレークは
止まるが、**測定器を黙らせて完了条件の数を合わせる**ことになる。本束の主題と正面から矛盾するので
**採らない**。「3 → 2」のまま出し、失敗シグネチャを #775 に記録する。

#### fix 差分の再点検（ラウンドを閉じる前・問い 2 つ）

| 問い | 答え |
|---|---|
| **新しい故障モードは** | `ts.createSourceFile` は**エラー寛容**なので、対象がパースできなくなるとラチェットは**黙って無検出**になる。塞いでいるのは同じ CI job の `typecheck:e2e` であって検査自身ではない → **その依存をコメントに明記した**（step を消すなら parse 健全性の検査が要る） |
| **どの実行コンテキストで走るか** | ラチェットは通常の `npm test`（確認済み）。**`waitForQuiet` / `captureTailRms` の新経路と移行した 8 アサーションは gated 実機のみ**で、ユニットでは触れられない → **実機で回すまでこの差分は未検証** |

#### 検証（main が sandbox 外で実行）

| 何 | 結果 |
|---|---|
| `npm test` | **2300 passed / 57 skipped**（+12） |
| `typecheck:e2e` / eslint / `docs:check` | 0 / 0 / 968 verified 0 failed |
| 実機 gated 全 29 件 | 別掲（下記の追記） |

🔴 Codex 環境の `npm test` は `listen EPERM: 127.0.0.1` で失敗した（sandbox で localhost bind が
不可）。CLAUDE.md の「検証を委譲先に任せない」がそのまま当てはまるので、main が回し直した。

### refactor(e2e): apply the /simplify pass on the gated-measurement bundle (Sep 6, 2026)

**ブランチ**: `761-gated-measurement`（束 PR [#776](https://github.com/signalcompose/orbitscore/pull/776)）

束 PR のレビューフロー ①。4 エージェント（reuse / simplification / efficiency / altitude）を
並行起動し、指摘を重複排除して適用した。

#### 🔴 最重要: ラチェット自身が目的より狭かった（altitude）

#761 が足した `gated-assertion-hygiene.spec.ts` のラチェットは **1 行スコープ**だった。
撤去した違反がたまたま 1 行だっただけで、この suite の主流である複数行 `expect()` は素通りする:

```ts
expect(x, msg).toBeGreaterThanOrEqual(
  errorsBefore + 1,
)
```

**偽赤を防ぐために足した仕組みが、書き方を変えるだけで無効化される**状態だった。
`offendingLines()` を追加し、**コメント行を落としてから残りを連結**して照合、一致位置から
元の行番号を引き直す形へ。

**変異で実証**: 複数行に散らした違反を注入 → **red**（`…spec.ts:3749` と正しく報告）、復元で 7 passed。

#### efficiency: capture の末尾だけを読む

`waitForQuiet` は 100 ms ごとに `captureTailWindows` を呼び、**capture 全体**を `readFileSync` して
`analyzeWavBuffer` に渡していた。E3 の時点でファイルは ≈6 MiB、全フレームを 2 回走査して
≈825 窓を作り、**末尾 ≈15 窓（2%）しか使わない**。timeout まで回ると 100 ポーリング ≈600 MB。

`readCaptureFormat` と同じ `openSync` + 位置指定 `readSync` で**末尾のバイトだけ**を読む形へ
（`captureTailRms`）。併せて**返り値を RMS の配列だけに狭めた** — 末尾だけ読むと `startSec` は
ファイル先頭基準ではなくなるので、使われない座標を返して誤用を招くより契約を狭める。

**変異で実証**: 先頭から読む → red / `tailSec` を無視して全体を解析（旧形への退行）→ red。復元で 49 passed。

#### simplification

- `0.005` が 2 箇所（`waitForQuiet` の floor と E3 の RMS 判定）に増え、**コメントだけで同期**して
  いた。`E3_SILENCE_FLOOR_RMS` に括り出し、同期を約束するコメントを不要にした
- `ReturnType<typeof fakeChildProcess>` → 既存の `FakeChildProcess` を名指し

#### reuse / altitude → issue 化（束では直さない）

| # | 内容 |
|---|---|
| **#777** | `createDaemonStderrLineRouter` に **`flush()` が無い**。#756 と同じ欠陥クラスで、**daemon が panic して改行なしで死んだ時の最後の 1 行**が落ちる。#756 の doc コメント自身が「双子はこれを持たない」と書いており、**一般化した教訓が片方にしか適用されていなかった** |

`createLinePrefixer` の doc コメントに、双子の所在・同期すべき点・#777 を明記した。
共通化は拡張パッケージが `@orbitscore/engine` に依存していないため別問題（#777 に記載）。
### docs: follow PR #772 (stderr line prefix) (Sep 6, 2026)

**ブランチ**: `claude/docs-sync-pr772` / **追従元 PR** [#772](https://github.com/signalcompose/orbitscore/pull/772)（merge commit `2c0f4be`・base は束 `761-gated-measurement` であって main ではない）

PR #772 は `setupStderrHandler` の `ERROR:` 前置を chunk 単位から行単位へ移した（`createLinePrefixer` の追加）。**同 PR は dev サイトの引用ヘッダを行ずれに追従させたが、地の文は 1 行も足していない** — `ERROR:` 前置がどこで付くかは gated E2E の ERROR 会計そのものの前提なので、その説明を dev サイトへ入れる。**実装・テストは 1 行も変更していない。**

#### 直したもの

| 場所 | 何を |
|---|---|
| `sites/dev/editor/mcp-and-gated-e2e.md`（ja / en） | `## get_log とリングバッファ` に `### ERROR: の前置は誰が付けているのか` を新設。ERROR 件数が数えているのは「engine が `console.error` した回数」ではなく「拡張が `ERROR:` を書いた行数」であること、#756 まで前置が chunk 単位で構造的に過小カウントしていたこと、`createLinePrefixer` の 3 つの制約（部分行の持ち越し / `'end'` の flush / 空行スキップ）、`append` → `appendLine` へ移っても ring に入る行数は元から壊れていなかったこと、同じ chunk 境界の問題が stdout 側に #773 として残ることを記述。`extension.ts:1585-1605` / `:1621-1643` を逐語引用 |
| 同上・`## Sources` / `## 次の深掘り候補` / frontmatter | `createLinePrefixer()` / `setupStderrHandler()` の出典と #756 / #773 を追加。`verified-against` を `ef192ca` → `2c0f4be`、`verified-at` を `2026-09-06` に更新。🔴 **再検証したのは `get_log` 節のみ**で、章全体を読み直したわけではない |
| `sites/dev/editor/vscode-architecture.md`（ja / en） | spawn 直後の 5 ハンドラの節に、`setupStderrHandler` が行単位で前置すること・前置の粒度が gated E2E の目盛りであることを 1 段落追記し、IV-3 の新節へリンク |
| `docs/planning/DEVELOPMENT_MAP.md` / `docs/planning/IMPLEMENTATION_PLAN_2026-09.md` | #756 の行を ✅ 済みに更新（#760 と同じ書式・束経由で main へ入る旨を明記）。併せて 🔴 起案時の「`createDaemonStderrLineRouter` が同じ問題を解いている」を訂正 — engine 側の router は部分行を持ち越すが**終端の flush を持たない**（`packages/engine/src/audio/rust-engine/daemon-client.ts:167-182` に flush が無く、`:906-922` の呼び出し側も `end` で drain していない） |

#### 追従不要と判断したもの

- `docs/specs-v2/` / `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` / `sites/user/` / `docs/user/ja/USER_MANUAL.md` — DSL の構文も意味論もユーザーが書く語も変わっていない（差分は拡張の stderr 転記のみ）
- `tests/vscode-extension/extension-wiring.spec.ts` — テストのみの変更
- `docs/design/` / `docs/archive/` — 起案時点・過去ログのスナップショットなので書き換えない

#### 検証

| 何 | 結果 |
|---|---|
| `npm test` | 2288 passed / 57 skipped |
| `typecheck:e2e` / eslint / `docs:check` | 0 / 0 / 968 verified 0 failed |
| `npm ci` | exit 0 |
| `npm run docs:build -w @orbitscore/user-site` | build complete（13.16s） |
| `npm run docs:build -w @orbitscore/dev-site` | build complete（34.30s） |
| `npm run docs:check` | **972 citation(s) verified, 0 failed**, 58 files |

### fix(extension): prefix stderr per line, not per chunk (#756) (Sep 6, 2026)

**ブランチ**: `756-stderr-line-prefix`（base = 束 `761-gated-measurement`） / **Part of** [#756](https://github.com/signalcompose/orbitscore/issues/756)

束「gated の測定器」の 3 本目（最後）。`setupStderrHandler` は engine の stderr を
`outputChannel.append('ERROR: ' + chunk)` と **chunk 単位**で前置していた。1 つの chunk に
複数行入ると **2 行目以降に `ERROR:` が付かない**。

gated E2E の ERROR 会計（`countErrors` / `newErrorLines`）は `ERROR:` を数えるので、
**構造的に過小カウント**する（= 偽緑）。だから束の**最後**に置いた — 判定側（#760 / #761）を
正しくしてから測定器そのものを直す。

#### 変更

`createLinePrefixer` を追加し、`setupStderrHandler` を行単位へ。

| 論点 | 対処 |
|---|---|
| **部分行** | chunk 境界は行境界と一致しない。素朴な `split('\n')` だと行の後半が独立した行になり `ERROR:` が二重に付く → `partial` を持ち越す |
| **終端の取りこぼし** | 行に整えると**改行で終わらない最後の出力**が buffer に残る。過小カウントを直す変更が逆方向に同じ穴を開けることになるので、`end` で `flush()` する。🔴 engine 側の `createDaemonStderrLineRouter` はここを持っていない |
| **空行** | `ERROR: ` だけの行を作ると `countErrors` が**水増し**される。過小を直して過大を作らない |

#### 🔴 既存テストの注入先を移した（移さないと黙って何も検証しなくなる）

封じ込めテストは `append` を throw させて「例外が listener の外へ逃げない」ことを検査していた。
前置が `append` → `appendLine` へ移ったので、**注入先を移さないと発火せず、テストは緑のまま
封じ込めの退行を見逃す**。`logHandlerFailure` 自身も `appendLine` を使うため、
**`ERROR: ` 行だけ**を落として診断行は通す精密な注入にした。

#### 変異検証（実出力）

| 変異 | red になったテスト |
|---|---|
| `partial` の持ち越しを消す | **2 本**（チャンク跨ぎの結合 / 終端 flush） |
| `flush()` を no-op | **1 本**（末尾行の flush） |
| 空行スキップを外す | **1 本**（空行で前置しない） |
| 復元 | ✅ 48 passed |

#### 🔴 issue 本文と実装のずれ（報告のみ・本 PR では直さない）

> すぐ上の `setupStdoutHandler` は同じファイルで既に `split('\n')` して 1 行ずつ処理している。
> **stderr 側だけがこの対処を欠いている。**

**stdout も部分行をバッファリングしていない**（`extension.ts` の `setupStdoutHandler`）。
`output.split('\n')` をチャンクごとに処理するだけなので、`{"evalMark"` などの JSON envelope が
チャンク境界で割れると**両断片とも prefix 判定に落ちて「malformed」として捨てられる**。

本 PR では**直さない** — stdout の分割挙動は bridge の dispatch（#614 で一度壊れた高リスク領域）に
影響し、独自の E2E を伴う別作業になるため。別 issue として起票する。

### fix(e2e): say which log lines appeared instead of counting them (#761) (Sep 6, 2026)

**ブランチ**: `761-window-proof-assertions`（base = 束 `761-gated-measurement`） / **Part of** [#761](https://github.com/signalcompose/orbitscore/issues/761)

束「gated の測定器」の 2 本目。`get_log` は**固定 500 行窓**なので、「baseline より N 件増えた」と
いう主張は**古い行が窓から流れ出るだけで崩れる**（偽赤）。実測: 2026-09-05 に #618 E1-E6 が
`expected 6 to be greater than or equal to 7` で落ちた。

#### 直した 3 箇所

| 場所 | 旧 | 新 |
|---|---|---|
| 6c（`:1705`） | `.toBe(attachFailedBefore + 1)` = 窓内カウントの**等価比較** | `newLogLines` の `[OUTPROC_ATTACH_FAILED]` 行が**ちょうど 1 本** |
| #618 E4（poll） | `failedReplace.isError \|\| countErrors(after) > countErrors(before)` | ログ側だけを見る述語へ |
| #618 E4（判定） | 同じ論理和 + シナリオ冒頭 baseline との `>= errorsBefore + 1` | ① `isError` で loud を直接 ② 増えた行で「ログにも届いた」 |

🔴 **`:1705` は #760 の作業中に見つけたもの**で、既存ラチェットの正規表現が
`errorsBefore|errorCount|countErrors` しか見ないため**すり抜けていた**。

#### 🔴 先例に揃えた（推測ではなく、このリポジトリが既に採った形）

同じ「存在しないプラグイン」を使う #625 の「playing effect の replace/remove」シナリオ内の
R-E3 は、#628 の時点で
**すでに件数比較を捨てている**:

> 🔴 #628: ERROR 件数の前後比較はもう使わない。（略）判定は「B が鳴り続けているか」（音）と
> 「child PID が変わっていないか」（プロセス）で行う。

**#618 E4 だけが古い形のまま取り残されていた。**

#### 🔴 poll の述語が意味を持っていなかった

E4 の `waitUntil` は `failedReplace.isError || countErrors(...) > ...` を述語にしていた。
`isError` は **poll に入る前に確定した定数**なので、真なら**ログを 1 度も待たずに**即座に抜ける。
「失敗がログに届くのを待つ」という名前と実際の挙動が食い違っていた。

#### 🔴 シナリオ全体の件数比較は「置き換え」ではなく「撤去」した

`countErrors(finalLog) >= errorsBefore + 1` を `newErrorLines(baselineLog, finalLog)` へ
単純置換するのは**誤り**。`baselineLog`（テスト冒頭）と `finalLog` は 500 行窓が重ならないので、
**`finalLog` の全行が「新規」**になる。多重集合の差分は**窓が重なる時だけ**意味を持つ。
E4 の直前直後という重なる区間で主張し、撤去の理由をコメントに残した。

#### ラチェット（`gated-assertion-hygiene.spec.ts`）

窓由来のカウント baseline に `+ N` して主張する形を機械で禁止する。

- 既存の 1 本目は `GreaterThan` を含む行を**除外**するので `toBeGreaterThanOrEqual(before + 1)` を
  捕まえられない。ここが補完
- 変数名を `errorsBefore` 系に限定しない（`attachFailedBefore` を取り逃がした穴）
- ⚠️ **コメント行は除外する。** アンチパターンを説明した注釈自身を拾ってしまい、
  「正しく直したのに赤くなる」= 規律を説明できなくなる（本 PR で実際に発火した）

#### 変異検証（実出力・自己申告ではない）

| 変異 | 結果 |
|---|---|
| `.toBe(<name>Before + 1)` を再導入 | 🔴 **red**（1 failed / 6 passed） |
| `toBeGreaterThanOrEqual(errorsBefore + 1)` を再導入 | 🔴 **red**（1 failed / 6 passed） |
| 復元 | ✅ **7 passed** |

#### 🔴 偽赤が本物の赤を隠していた — E3 の窓も直した（スコープ拡張）

件数アサーションを撤去したところ、**同じ try 節の下流にあって一度も評価されていなかった**
アサーションが初めて走り、落ちた:

```
E3 rest pattern must be silent: expected 0.1004 to be less than 0.005
```

`:3733` は `try` の中、E3 の RMS 判定群は `try/finally` の**後**。`:3733` が throw していた間、
E3 は**到達不能**だった。**測定器が壊れていると、その下流の判定が全部見えなくなる**という、
この束の主題そのものの実例。

**`ORBIT_KEEP_CAPTURES` で WAV を残して実測**（250 ms バケット）:

```
 4.50–16.50s  ~0.155   E1 (CLAP) → E2 (VST3)
16.50–18.50s  0.00000  ← 休符は効いている（ちょうど 1 小節 = 2.0s @120BPM 4/4）
18.50–22.00s  ~0.155   E4 の play(1,1,1,1) が次の小節頭で復帰
```

**実装は正しく、窓の位置だけが誤り**だった。E3 は固定 `sleep(1000)` で窓を開けるが、
`play()` は次の小節境界で効くので 0〜2.0 秒ずれる。窓 15.50–18.00 の先頭 1.0 秒が音で、
√(1.0 × 0.155² / 2.5) = **0.098** ≒ 実測 **0.1004** と一致する。

**直し方**: `waitForSoundRestart` の段階 1（末尾が静かになるまで待つ）を **`waitForQuiet` として
切り出し**、E3 で窓を音に追従させた（#739 と同じ規律）。戻り値そのものが「休符に切り替えたら
無音になる」の実時間側の主張で、RMS 判定が WAV 側の主張になる。

> **スコープについて**: #761 の本文は ERROR 件数の話だが、束「gated の測定器」の主題は
> 「測定器が嘘をつく」こと。E3 も同じファイル・同じ型（固定 settle で置いた窓）であり、
> **この束の完了条件（実機の失敗 3 → 1）が要求する**ため同じ PR で直した。
### docs: follow PR #769 (attach failure assertion) (Sep 6, 2026)

**ブランチ**: `claude/docs-sync-pr769` / **追従元 PR** [#769](https://github.com/signalcompose/orbitscore/pull/769)（PR ブランチ先端 `f5d2ef5`、束への merge commit `a646c2e7`・base は束 `761-gated-measurement` であって main ではない）

PR #769 は `CHILD_STATUS_LOAD_FAILED` の doc コメントを実装へ合わせ直し、gated E2E のアンカーを
具体的な失敗理由へ変更した。**同 PR は dev サイトの引用（行範囲と逐語ブロック）を再アンカーしたが、
引用の周りの地の文と、誤った原因記述を持つ計画ドキュメントには触れていない。** その追従を行う。

#### 直したもの

| 場所 | 何を |
|---|---|
| `docs/planning/DEVELOPMENT_MAP.md` / `docs/planning/IMPLEMENTATION_PLAN_2026-09.md` | 🔴 **#760 の原因記述が誤っていた**。両表とも「存在しない CLAP は **child を spawn する前に discovery で落ちる**」と書いていたが、PR #769 が一次ソースで訂正したとおり **child は spawn される**。`RackController::load_initial` がロードに失敗し、詳細を publish してから `CHILD_STATUS_LOAD_FAILED` を立てて終了する。結論（`child exited before publishing READY` に到達しない）は同じだが理由が違う。併せて #769 で対処済みであることを記録 |
| `sites/dev/rust-engine/oop-children.md`（ja / en） | 「child-side READY handshake」節の**地の文**に `CHILD_STATUS_LOAD_FAILED` の説明が無かった。#769 で引用ブロックだけが差し替わり、読者が実際に読む散文は READY と respawn 注意しか語らない状態になっていた。load 失敗の診断経路（publish → status → daemon の Root 3-3 が watchdog signal より先に見る）と、コメントの誤りが gated E2E のアンカーの誤りを生んだ経緯を追記 |
| 同上・`## Sources` | `transport.rs` の行範囲を `113-140,170-285` → `113-143,173-288` に更新（#769 の行ずれに追従）。#760 / #769 を出典に追加 |
| 同上・frontmatter | `verified-against` を `69dc968` → `f5d2ef5`、`verified-at` / Note の日付を `2026-09-06` に更新。🔴 **再検証したのは READY handshake 節のみ**で、章全体を読み直したわけではない |

#### 追従不要と判断したもの

- `tests/e2e/orbitstudio-mcp-gated.spec.ts` / `rust/.../transport.rs` — 前者はテストのみ、後者は
  コメントのみの変更で、DSL 表面・MCP の引数/返り値・評価フローのいずれも変わっていない
- `docs/specs-v2/` / `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` / `sites/user/` /
  `docs/user/ja/USER_MANUAL.md` — ユーザーが書く語も DSL の意味論も変わっていない
- `docs/archive/` — 過去ログのスナップショットなので書き換えない

#### 検証

| 何 | 結果 |
|---|---|
| `npm ci` | exit 0 |
| `npm run docs:build -w @orbitscore/user-site` | build complete（16.40s） |
| `npm run docs:build -w @orbitscore/dev-site` | build complete（41.23s） |
| `npm run docs:check` | **968 citation(s) verified, 0 failed**, 58 files |

### fix(e2e): assert the attach failure's reason instead of a fallback wording (#760) (Sep 6, 2026)

**ブランチ**: `760-attach-failure-assertion`（base = 束 `761-gated-measurement`） / **Part of** [#760](https://github.com/signalcompose/orbitscore/issues/760)

束「gated の測定器」の 1 本目。実機 gated で `drives real OrbitStudio end-to-end …` が
**`main` でも落ちていた**（2026-09-05 実測）。実装ではなく**アサーションの欠陥**である。

#### 🔴 issue の原因記述が実装と食い違っていた（一次ソースで訂正）

| #760 本文の記述 | 実装（読んで確認） |
|---|---|
| 存在しない CLAP は **child を spawn する前に** discovery で落ちる | **child は spawn される。** `RackController::load_initial`（`rust/crates/orbit-effect-rack-child/src/lib.rs`）が CLAP のロードに失敗し、**詳細を publish してから** `CHILD_STATUS_LOAD_FAILED` を立てて終了する |

したがって「`child exited before publishing READY` に到達しない」という**結論は正しい**が、
理由が違う。daemon（`rust/crates/orbit-audio-daemon/src/engine_wrap.rs` の Root 3-3 分岐）は
この status を early-exit の watchdog signal **より先に**見るので、汎用文言ではなく
「index 0 の load がこう失敗した」という**具体的な理由**が上がる。

**期待文言が合わなくなったのは退行ではなく、診断が具体的になったから。**
テストが**最も具体性の低いフォールバック文言**にアンカーしていたため、エラー報告が
改善した瞬間に落ちた。

#### 直したもの

`tests/e2e/orbitstudio-mcp-gated.spec.ts` の 6c（#527 由来のロールバック確認）:

| 旧 | 新 |
|---|---|
| `.toContain('[OUTPROC_ATTACH_FAILED] child exited before publishing READY')` の 1 本 | ① 新しい `[OUTPROC_ATTACH_FAILED]` 行が出た ② 理由が**プラグインファイルを読めなかったこと** ③ **前のチェーンが保たれた** |

- **件数ではなく増えた行で語る**。`newLogLines`（#661 で main に入った）を使う。`get_log` は
  固定 500 行窓なので、件数比較は古い行が窓から流れ出るだけで動く
- ③ は 6c の主題（`EffectChainMap` のロールバック）そのものだが、**旧アサーションは一度も
  見ていなかった**。文言を実装に合わせるついでに、守るべきものを足した
- アンカーは `discovery.rs` / `controller.rs` の**ハードコード文言**。内側の
  `No such file or directory (os error 2)` は OS の strerror で**ロケール依存**なので使わない
- 1 本 49 秒の長いシナリオなので、🔴 **どのアサーションが何を守るか**をコメントに明記した（#760 の指示）

#### 併せて: stale な doc コメントを実装に合わせた

`rust/crates/orbit-audio-sandbox/src/transport.rs` の `CHILD_STATUS_LOAD_FAILED` は
**「現状は未使用の予約値」「write 箇所なし」**と書かれたままだった（実際には rack child が
書いている）。文末は文が壊れてもいた。**issue が原因を誤診したのはこの注釈が原因の可能性が高い**
ので、同じ PR で直す。コメントのみで挙動は変わらない。

#### 検証

| 何 | 結果 |
|---|---|
| `npm test` | 2280 passed / 57 skipped（exit 0） |
| `npm run typecheck:e2e` | 0 |
| `npx eslint` / `prettier --check`（対象ファイル） | 0 / 差分なし |
| `cargo check -p orbit-audio-sandbox` | 緑 |
| `gated-assertion-hygiene` / `dsl-e2e-coverage` ラチェット | 緑 |
| **実機 gated（当該シナリオ）** | ✅ **1 passed / 28 skipped**（54.5s・起動時 load 1.83 の clean な測定）。`main` で落ちていたシナリオが緑になり、実機の失敗は 3 件 → 2 件 |

#### 🔴 引用 42 件が陳腐化した — 手順の欠陥

行番号がずれたことで、dev 学習サイトが `orbitstudio-mcp-gated.spec.ts` と `transport.rs` を
**行範囲で引用**している箇所が 42 件失敗した（CI の `code-review` で発覚）。

**ローカルの `docs:check` は緑だったが、それは編集の「前」に走らせたもので検証になっていなかった。**

- 40 件は純粋な行ずれ → `check-citations.mjs --fix` が再アンカー
- **2 件は本文の変更**（`rust-engine/oop-children.md` の日英）。サイトが
  `CHILD_STATUS_LOAD_FAILED` の**古いコメントを逐語引用**していたので、新しい文面へ差し替えた。
  つまり**同じ事実誤りがサイト側にも載っていた**
- 地の文は `LOAD_FAILED` を「未使用」と書いていないため、散文の修正は不要（grep で確認）

### docs: follow PR #744 (post-push verify hook) (Sep 6, 2026)

**ブランチ**: `claude/docs-sync-pr744` / **追従元 PR** [#744](https://github.com/signalcompose/orbitscore/pull/744)（merge commit `7b93791`）

マージ済み PR #744（push が本当に入ったかを確認する PostToolUse フック）に、
ドキュメントを追従させた。**実装・テストは 1 行も変更していない。**

#### 追従したもの

| 場所 | 何が古かったか |
|---|---|
| `CLAUDE.md` の "Hook Protection" | 自動ガードの一覧に `post-push-verify.sh` が無かった（`pre-edit-check` / `pre-commit-check` / `session-start` の 3 件だけ） |

#### 🔴 ローテーションの取りこぼしを 2 件回収した

`docs/development/WORK_LOG.md` に、**本文が無い見出しだけの行**が 2 つ残っていた。

```
### fix(studio): declare untrusted-workspace capability (#385 PR-S-T1) (Sep 4, 2026)
### docs(649): follow the master line up in the spec and the dev site (Sep 5, 2026)
```

見出しの直後に次の見出しが続き、**後続エントリのタイトルを飲み込んで見える**状態だった。
本文は `docs/archive/WORK_LOG_2026-09.md`（`### fix(studio): declare untrusted-workspace...`）へ
既にローテーション済みで、**見出し行だけが本体に取り残されていた**もの。

- 1 件目は PR #744 のマージ衝突解消（merge commit `1283dda`・`# Conflicts: docs/development/WORK_LOG.md`）で新たに複製されたもの
- 2 件目は #744 の base（`4d7b63b`）に既に在ったもの

本文は archive にあるので、**本体側の見出し行 2 行を削除した**（archive は変更していない）。
PR #742 が「**やったつもりと実際のずれ**」を機械で見えるようにしたのと同じ型の取りこぼしが、
その PR 自身のマージで 1 件増えていた。
### docs: repair the orphan WORK_LOG headings the docs-sync merges left (Sep 6, 2026)

**追従元**: PR [#750](https://github.com/signalcompose/orbitscore/pull/750)（`385-map-record-trust-layer-2` → main・マージコミット `aa16f7a`）/ **ブランチ**: `claude/docs-sync-pr750`

マージ済み PR #750（#385 層 2 の繰り延べを地図に記録）への追従。**コードとテストは 1 行も変更していない。**

#### 🔴 何が起きていたか — 本文の消失ではなく「孤立見出し」

2026-09-06 に docs-sync 7 本を「1 本ずつ解消 → マージ」で処理した際、WORK_LOG の衝突を
**両側を残す**形で機械的に解いた。ところが同じ日に PR #754 が **WORK_LOG をローテーション**して
09-04 以前のエントリを `docs/archive/WORK_LOG_2026-09.md` へ移していたため、
「ブランチ側にはエントリがあり、main 側では移動済み」という組み合わせが生まれた。

結果、main の現行ログに
**`### fix(studio): declare untrusted-workspace capability (#385 PR-S-T1)` の見出しだけが 2 つ**
残った（本文なし・次の行がいきなり別の見出し）。

🔴 **本文は消えていない。** `docs/archive/WORK_LOG_2026-09.md:798` に無傷で残っている。
壊れていたのは**現行ログ側の見出しと、そこを指していた出典参照**である。

- 走査した結果、孤立見出しは**この 1 種類 2 箇所だけ**で、他への波及は無かった
- `sites/dev/editor/vscode-architecture.md:854`（+ `en/`）の検証マップが
  この WORK_LOG エントリを出典として名指ししており、**参照先が空になっていた**

#### 直したもの

| 場所 | 何が古かったか |
|---|---|
| `docs/development/WORK_LOG.md` | 孤立見出し 2 つを除去。本文はアーカイブ側が正なので現行ログへは戻さない |
| `sites/dev/editor/vscode-architecture.md`（+ `en/`） | 出典を `docs/archive/WORK_LOG_2026-09.md` へ向け直した（現行ログを指したままだと空を指す） |
| `sites/dev/editor/vscode-architecture.md`（+ `en/`） | workspace trust の節が「宣言 (層 1) を入れた」で終わっており、**層 1 では救えない**ことが書かれていなかった。同居する `anthropic.claude-code` が `untrustedWorkspaces.supported: false` を宣言していてこちらから足せず、loose-file 起動では LLM 側が黙って activate しないこと、層 2（PR-S-T2・ビルドで trust 既定 off）が #656 出荷前に残っていることを追記 |
| 同上 frontmatter | `verified-against` を `aa16f7a`・`verified-at` を 2026-09-06 に更新。冒頭 Note にも #750 までの追従を明記 |

#### 追従不要と判断したもの

- `docs/specs-v2/` / `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` — #750 は DSL の構文・意味論・`.orbslog` 形式を一切変えていない（差分は計画文書 2 ファイルのみ）
- `sites/user/reference/methods.md` / `docs/user/ja/USER_MANUAL.md` — ユーザーが書く語は増減していない
- `rust/` 系の章 — MCP ツールの引数・返り値・エラー挙動に変更なし
- `docs/design/656-release-design.md` — 起案時点のスナップショットなので触らない（#750 本文いわく設計側は既に層 2 を持っている）

#### 直していないもの（PR 本文へ回した）

E2E の穴・弱いアサーション・CI の指摘は書き出すだけにした。実機 gated は
`ORBIT_GATED_ORBITSTUDIO` が無い環境では skip されて緑になるため、この追従作業で E2E を積むと
一度も走っていないテストを積むことになる。`dsl-e2e-coverage.spec.ts` の baseline も編集していない。

### chore(hooks): verify a push actually landed (#742) (Sep 4, 2026)

**Issue**: #742 / owner 指摘「**繰り返さない様に仕組みでカバー出来るところはやりましょう**」

#### 同じ型の取りこぼしを 2 回踏んだ

**1. commit が落ちているのに push して「pushed」と報告した**

```bash
git commit -q -F - <<'EOF' ... EOF
git push -q origin <branch> && echo pushed
```

`git commit` が **husky の pre-commit で失敗**（WORK_LOG が 2000 行超過）しても、
**次の `git push` は走る**。リモートは既に最新なので「Everything up-to-date」で
**exit 0 = 成功**になり `echo pushed` が出る。
結果、**ブランチに何も入っていないのに「push した」と報告**していた。

**2. 自分の記録を上書きして消しかけた**

衝突解消中に `git checkout origin/main -- docs/development/WORK_LOG.md` を実行し、
**その PR の記録 49 行を丸ごと消した**まま commit しかけた。

どちらも **「やったつもり」と「実際」のずれ**。owner の
「先に進めることを優先して取りこぼして後で大変にならないように」で気づいた。

#### 仕組み

`PostToolUse` / matcher `Bash:git push.*` で、push 直後に
**ローカル HEAD とリモート追跡ブランチの SHA を突き合わせる**。

🔴 **ブロックはしない。** push 自体は済んでいるので止めても意味がなく、
**「入っていない」ことを見えるようにする**のが目的（既存の weak-form 方針）。

#### 意図的に不一致を作って確認した

| 状況 | 結果 |
|---|---|
| ローカルとリモートが一致 | 無言・`exit 0` |
| リモート未作成（初回 push 前） | 無言・`exit 0`（対象外） |
| コミットせずに HEAD だけ進んだ状態 | **鳴る**・`exit 2` |

#### 🔴 記録: フックは既に仕事をしていた

同じ日に **pre-commit フックが 2 回正しく止めてくれた**（WORK_LOG のローテーション超過）。
**仕組みは効いていて、出力を読まずに次へ行った私が問題だった。**
だから今回足したのは「止める」ものではなく「**見えるようにする**」ものにした。

---

### docs(649): follow the master line up in the spec and the dev site (Sep 5, 2026)

**Issue**: #649 / **ブランチ**: `claude/docs-sync-pr754` / **追従元 PR** [#754](https://github.com/signalcompose/orbitscore/pull/754)（merge commit `f2dadd9`）

マージ済み PR #754（#649 PR-O2・stereo 内部化 + master ライン）に、ドキュメントを追従させた。
**実装・テストは一切変更していない。**

#### 仕様（`docs/core/INSTRUCTION_ORBITSCORE_DSL.md`）

🔴 **PH.2b の既知の v1 制約が 1 つ解消され、順序が入れ替わった。**

| 変更前 | 変更後 |
|---|---|
| master gain ramp は per-sequence insert の**前**（DAW の「fader は insert 後」と逆） | master gain は **master ラック（PH.2）の後**。per-sequence insert も `global.effect()` も master gain の**手前**に来る（DAW と同じ並び） |

根拠は PR #754 の差分そのもの（`EngineWrap::set_global_gain` が core の scheduler ramp を
呼ばなくなり、`MasterLine`（rack → gain → デバイス配置）へ atomic store するだけになった）と、
設計正本 `docs/design/611-output-line-design.md` §5.2/§5.4「master のゲインは master ラインの
op としてラックの**後**に必ず来る」。

あわせて PH.4（instrument）の「`render_multi` の内側（event 混合後・**gain ramp の前**）で
合流する」から、production に存在しなくなった gain ramp への参照を外した。

#### dev 学習サイト（ja / en 両方）

- `sites/dev/rust-engine/index.md` — 「master ライン — engine の内部幅は常に 2ch」節を新設。
  `ENGINE_CHANNELS` / `place_master_into_device`（mono マージ・2ch memcpy・3ch 以上の 0 埋め）/
  `MasterLine::advance_gain`（構築時に確定する 5 ms ランプ）/ `EngineWrap::set_global_gain` を引用。
  `render_block_with_sources` の段数が 3 → 5 になったこと、ビット同一の条件が
  「ラック無し + gain 1.0 + 2ch デバイス」に変わったことを本文に反映
- `sites/dev/signal-chain/mixer-audio-line.md` — 「master gain の適用点が移った」節と
  「(5) 4 度目の読み直し」節を追加。(3)「master gain は今も insert の前」に解消の注記。
  E2E-1 が赤かったのは**オラクル**（`every(rms >= 0.01)` は LOOP の 80 ms の切れ目で
  原理的に満たせない）であって実装ではなかったこと、症状自体は `374e8b2d` で消えていたこと、
  PR-O2 が塞いだのは「ラックが生成した音が `global.gain()` を逃れる」残り半分であることを記載

両章とも `verified-against` を `f2dadd9` / `verified-at` を 2026-09-05 に更新した。

#### 追従不要と判断したもの

| 対象 | 理由 |
|---|---|
| `docs/specs-v2/` | master gain の適用位置に言及している箇所が無い（`grep "gain ramp\|master gain\|マスターゲイン\|global gain"` で 0 件）。SC.10 は順序ではなくラックの形を規定している |
| `sites/user/` / `docs/user/ja/USER_MANUAL.md` | `global.gain()` の適用位置を書いている箇所が無い。`sites/user/reference/methods.md` の `gain(dB)` は seq のフェーダーで、本 PR は触っていない |
| `docs/design/611-output-line-design.md` | PR #754 が §5.5 にオフラインレンダの注記を追加済み |

#### 検証

`npm ci` / `docs:build`（user・dev）/ `docs:check` — PR 本文に出力を貼付。

---

### docs(planning): record the eight issues cut out of the stage-1 must-fix work (#763) (Sep 5, 2026)

**Issue**: #763 / **ブランチ**: `763-record-cut-out-issues` / **PR** #764（マージ済み `490dc32c`）

段 1（#645 / #606 / #385 / #661 / #649）の must-fix を進める中でスコープ外として切り出した
issue 8 本を、地図と実装計画に記録した。切り出したまま放置すると「誰も追わない deferred」に
なるため、置き場と着手の目安を書いた。**docs のみの変更**（コード・テストは触っていない）。

#### 地図（`docs/planning/DEVELOPMENT_MAP.md`）

| 節 | 内容 |
|---|---|
| §4.H バッチ A | **#661 を ✅ に更新**（PR #748 でマージ済み）。**A' 行**を追加 |
| **§4.H.A'**（新設） | #661 から派生した 3 件（**#755** / **#759** / **#758**）と「なぜ #661 で直さなかったか」 |
| §4.G | 測定器の欠陥 3 件（**#761** / **#756** / **#760**） |
| **§4.J.1**（新設） | 拡張・daemon の内部整理（**#757** / **#752**）。振る舞いを変えないので急がないが、放置すると次の変更が高くつく類 |

#### 実装計画（`docs/planning/IMPLEMENTATION_PLAN_2026-09.md`）

- **§1.8 PR-V**: 「PR-V3 + PR-V4 は PR #748 でマージ済み・#661 は CLOSED」と owner 裁定を追記し、
  派生 3 件を **PR-V10 / PR-V6 / PR-V6 の後**へ割り当てた
- **§1.10 PR-E**: 測定器の欠陥 3 件と着手の順序（#761 は着手可 / #756 は #649 の baseline 比較の
  後 / #760 は独立）

#### 🔴 記録して見えたこと

**#761 / #756 / #760 は 3 本とも「測定器の欠陥」**で、いずれも「**実装が正しいのにテストが
赤 / 緑になる**」型だった。#649 も #661 も同じ形だったので、偶然ではなく**この段の主題**として
計画に束ねている。

#### あわせて直したもの

`DEVELOPMENT_MAP.md` に**存在しない §4.H.1 への参照**（599 行目）があったので §4.H へ寄せた。
新しい節は §4.H.A' と名付けて番号の衝突を避けている。

#### 検証

`docs:check` **926 verified / 0 failed**。コード変更なしのためビルド・実機 E2E は不要
（CLAUDE.md「docs のみの変更」）。CI は `code-review` / `fmt / clippy / test` /
`license / dependency gate` の 3 件すべて success。
### docs(planning): record the #385 layer-2 deferral on the map (Sep 5, 2026)

**Issue**: #385 / **ブランチ**: `385-map-record-trust-layer-2`

owner 判断（2026-09-05）で **#385 は段 1（must-fix の音の経路）では触らない**ことにした。
段 1 の対象は #649 / #661 / #606 の 3 件に限定する。

問題は「後にずらしたものが地図から落ちる」ことだった。`DEVELOPMENT_MAP.md` §4.J は
**層 1（宣言）と実機検証（#735）の 2 行しか持たず、層 2（ビルドで trust 既定 off）の行が無い**。
さらに「順序」の行が「#385（宣言）は独立で先にできる — **済**」とだけ書いてあり、
**#385 全体が終わったように読める**状態だった。

- §4.J に **層 2 の行**を追加（PR-S-T2・`product.overrides.json` + `build_orbitstudio.sh`・
  設計は `656-release-design.md` §3.4）
- 🔴 **層 1 では救えない理由**を明記 — `anthropic.claude-code` は
  `untrustedWorkspaces.supported: false` を宣言しており Anthropic 管理なのでこちらから足せない。
  loose-file 起動では **LLM 側が黙って activate しない**。LLM を第一級ユーザーに置く方針では
  出荷ブロッカーなので **#656 出荷の前**に入れる
- 「順序」の行を「層 1 は済 / **#385 はこれで完了ではない**」に書き替え

計画側（`IMPLEMENTATION_PLAN_2026-09.md` の PR-S-T2 行・`USER_OUTCOMES_2026-09.md` の段 8）と
設計側（`656-release-design.md` §3.4）は既に層 2 を持っていたので変更なし。**欠けていたのは地図だけ**。

### docs: follow PR #748 in the dev site and the user site (#661) (Sep 5, 2026)

**Issue**: #661 / **ブランチ**: `claude/docs-sync-pr748` / **追従元**: PR #748（merge commit `ef192ca`）

マージ済み PR #748（出力デバイスの生存確認と縮退）に、ドキュメントとサイトを追従させた。
**コードとテストは 1 行も変更していない。**

#### 直したもの

| 場所 | 何が古かったか |
|---|---|
| `sites/dev/editor/mcp-and-gated-e2e.md`（+ `en/`） | ツールカタログが `get_engine_state` を `{ running, liveCoding }` と書いていた。`output` / `callback` / `statusError` が抜けていた |
| 同上 | `get_engine_state` の節が無かった。`resolveEngineState` の 3 分岐と、予算 2.5 秒が「伸ばしても取れるようにはならない」理由（REPL の FIFO 直列化）を追加 |
| `sites/dev/rust-engine/index.md`（+ `en/`） | コマンド表の `GetStatus` / `SelectAudioDevice` 行。probe と `output` / `callback` の追加を反映 |
| 同上 | 「出力デバイスの生存確認」節を新設。probe を実 stream より**前**に置く理由（`insert_buses` / `sources` が `RenderState` へ move 済みになる）、cpal 0.15.3 の参照循環と `Drop` の `pause()`、`DeviceFallbackPolicy` が起動経路とライブ切替経路で逆になること |
| `sites/user/getting-started/engine-settings.md`（+ `en/`） | 「出力デバイスは OS のデフォルトに固定」「エンジン内からの選択は未実装（#484）」と書いてあった。**実装済み**（Output Device ノード・ライブ切替）なので書き換え、確認できなかった時の起動時 / 演奏中の振る舞いの違いと、`Restart Engine` が出る 3 条件を追記 |
| `sites/user/troubleshooting.md`（+ `en/`） | 「音が出ない」の項が OS 側の出力設定しか案内していなかった。OrbitScore 側の Output Device と起動時の縮退への導線を追加 |

#### 追従不要と判断したもの

- `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` — この PR は DSL の構文・意味論を変えていない。デバイス関連の記述も元から無い
- `sites/user/reference/methods.md` — 新しい DSL 語は増えていない（`global.audioDevice` は #484 で既出）
- `docs/research/ENGINE_DAEMON_PROTOCOL.md` — PR #748 自身が `GetStatus` の新フィールドと失敗コード表を追加済み
- `docs/design/661-audio-device-liveness-design.md` — 起案時点のスナップショットなので触らない

#### 検証

`npm run docs:build`（user / dev）と `npm run docs:check` を実行。出力は PR 本文に貼った。
### docs: follow up the merged #606 in the protocol spec and the dev site (Sep 5, 2026)

**Issue**: #606 / **ブランチ**: `claude/docs-sync-pr738` / **追従元**: PR #738（merge commit `46f5d7a`）

マージ済み PR #738 に対するドキュメント追従。**実装・テストは一切変更していない。**

#### 直したもの

- **`docs/research/ENGINE_DAEMON_PROTOCOL.md`**: `PluginAllNotesOff` の説明が
  「active note を **drain** し」のままだった。実装はレビュー ラウンド1 で
  **clone した snapshot から送出し、解放できた entry だけを除去する**形へ反転している
  （`engine_wrap.rs:7268-7317`）ので、記述が実装と食い違っていた。あわせて
  **`failed` の note は台帳に残り次回再試行される**ことと、session 切断 trigger が
  発火するのは**最後の確立済み session が切れたときだけ**であること（`session.rs:1271-1284`）を追記
- **`sites/dev/rust-engine/index.md`（+ en）**: daemon の RPC 表に `PluginAllNotesOff` の行が
  無かった。`GetStatus` の行にも `active_plugin_notes` が反映されていなかった。
  `SessionRegistration` と切断 trigger の解説を追加（`Drop` が解放を行わない理由も含む）
- **`sites/dev/scheduling/transport.md`（+ en）**: `seq.stop()` の箇条書きが
  「ループタイマーをキャンセルする」のままで、RUN 尻尾タイマーに触れていなかった。
  ハンドル保持（`runTimer`）と `tailDelay` の原点整合の解説を追加
- 上記 2 章は frontmatter の `verified-against` / `verified-at` を `46f5d7a` / `2026-09-05` へ更新

#### 引用の再アンカーで欠けていた行の復元

PR #738 は `check-citations --fix` で引用窓をずらしており、その結果
**閉じ括弧が窓から外れた**引用が 2 箇所あった（コード片が途中で切れて見える）。
実ファイルを読み直して範囲を延ばした。

| 引用 | 変更 |
|---|---|
| `session.rs`（rust-engine/index.md・en 両方） | `739-766` → `739-767`（`};` を復元） |
| `sequence.ts`（scheduling/transport.md・en 両方） | `1855-1880` → `1855-1883`（`return this` / `}` を復元） |

#### 検証

- `npm run docs:check` — **930 citations verified / 0 failed**（追従前 926）
- `npm run docs:build -w @orbitscore/user-site` — build complete
- `npm run docs:build -w @orbitscore/dev-site` — build complete

#### 追従せず報告に回したもの

- `GetStatus.active_plugin_notes` に **TS 側の読み手が 1 件も無い**
  （`packages/` / `tests/` を grep して 0 件）。設計 §1 H4 の問題意識が
  「台帳に読み手が 0 件」だったので、daemon 側だけ実装して**MCP から読めない片翼状態**になっている
- `SYNTAX_UNCOVERED_BASELINE` の `transport-run` / `transport-loop` は、#738 が足した
  T1 / E2E-K3 が実際に `RUN(...)` / `LOOP(...)` を評価しているのに残ったまま。
  🔴 **baseline は実機で緑を確認した者だけが減らせる**ので、ここでは編集していない
### docs(site): follow up #746 — capture clock invariants and the finalize precondition (Sep 5, 2026)

**追従元**: PR [#746](https://github.com/signalcompose/orbitscore/pull/746)（マージコミット `76a4056`）/ **ブランチ**: `claude/docs-sync-pr746`

マージ済み #746 に対するドキュメント追従。#746 自身が `sites/dev/editor/mcp-and-gated-e2e.md` の
写像の説明と引用アンカーを更新していたので、その差分では埋まっていなかった 2 点を足した。
`packages/` `rust/` の変更は無い PR なので、DSL 仕様 / ユーザー向けドキュメントの追従は不要。

#### 足したもの

1. **`sites/dev/editor/mcp-and-gated-e2e.md`（ja / en）— 不変条件 A1 / U1 / U2 / U3**
   `captureWindowsFrom` が区間写像の前に検査する 4 本が、どこにも書かれていなかった。
   これらは実機 gated で名前つきの Error として表面に出るので、読み手が遭遇する観測可能な表面である。
   U3 の例外が区間名の文字列 `'transition'` から `CaptureSegment.overlapsPrevious` へ移った経緯も
   併せて記録した（名前で例外を判定すると、同じ名前を別の意図で使った瞬間に検査が静かに緩む）。

2. **`sites/dev/rust-engine/capture-verification.md`（ja / en）— `finalize` は通常停止でも走らない**
   同章は `sync_header` の定期 patch を「**異常終了でも**開ける WAV」の話として書いていたが、
   #746 の `readCaptureForAnalysis` が一次ソースで確かめたのは **通常の client 停止も SIGTERM で、
   daemon に signal handler が無いので `CaptureWriter::Drop` → `finalize` は普段から走らない**
   ことだった（`rust/crates/orbit-audio-daemon/src/main.rs:21-30`・既知事項 #448）。
   header の申告サイズは常に最後の `sync_header` 時点で止まるため、区間解析する全経路で
   申告サイズの零化が要る。#739 の実機ではこれで 6 件が誤検知していた。
   あわせて `ORBIT_CAPTURE_WAV` のディレクトリが無いと engine 起動そのものが
   `DEVICE_CONFIG_ERROR "audio output init failed: capture writer error: No such file or directory"`
   で落ち、テスト側には「daemon-backed REPL ready after 30000ms」という無関係に見える
   タイムアウトとして現れる件を記録した。

両章の frontmatter `verified-against` / `verified-at` を `76a4056` / 2026-09-05 に更新。

#### 直していないもの（PR 本文へ回した）

E2E の穴と弱いアサーションの指摘は書き出すだけにした。実機 gated は
`ORBIT_GATED_ORBITSTUDIO` が無い環境では skip されて緑になるため、この追従作業で E2E を積むと
一度も走っていないテストを積むことになる。`dsl-e2e-coverage.spec.ts` の baseline も編集していない。

---

## 09-04〜09-05 の追補（本体の 2,000 行上限で移設・2026-09-07）

### docs(site): follow PR #730's untrusted-workspace capability into the dev site (Sep 4, 2026)

**追従元**: PR [#730](https://github.com/signalcompose/orbitscore/pull/730)（`385-untrusted-workspace-capability` → main・マージコミット `4f2ebd5`）/ **ブランチ**: `claude/docs-sync-pr730`

#730 は `packages/vscode-extension/package.json` に `capabilities.untrustedWorkspaces` を宣言した。
**マニフェストの宣言が振る舞いを決める**変更なので、拡張アーキテクチャの章に対応する節が必要だった。
コードとテストは変更していない。

#### 1. IV-1 章に「workspace trust と untrustedWorkspaces」を追加

`sites/dev/editor/vscode-architecture.md` は `activationEvents`（いつ起動するか）を書いていたが、
**「そもそも起動してよいか」を決める workspace trust** に触れていなかった。
`activation と activationEvents` の直後に節を足し、差分から確定できることだけを書いた:

- loose-file 起動（`orbs file.orbs`）は ad-hoc な未信頼 workspace になる（#385 の症状は沈黙）
- `supported: true` の根拠は `docs/design/656-release-design.md` §16 (1)（DAW に併せる）。
  `startEngine()` にガードは無い
- `restrictedConfigurations` は `supported` と独立に効き、基準は
  「workspace が値を決めると別の実行ファイルが動く」もの 2 件だけ。`audioDevice` が入らない理由も
- 実機の確認（`E2E-D1`）は **#735 へ分離済み**であり、この層が保証するのは宣言の内容まで

引用は `packages/vscode-extension/package.json:34-43` を verbatim で置いた。
目次・drift 表・関連用語・Sources と、`sites/dev/glossary.md` の
`workspace trust (untrustedWorkspaces)` 項も足した。ja / en 両方。
frontmatter の `verified-against` を `4f2ebd5`・`verified-at` を `2026-09-04` へ。

#### 2. `package.json` に 10 行入ったので、散文の行参照が +10 ずれた

#730 は `// FILE:START-END` 形式の引用（`catalog.md` のコードブロック）を再アンカーしているが、
**Sources 節や本文中の散文の行参照は `check-citations.mjs` の対象外**なので取り残されていた。
前回（#724 追従）と同じ型である。

| 参照元 | 旧 | 新 | 対象 |
|---|---|---|---|
| `sites/dev/plugin-hosting/catalog.md:1378` / en:1410 | `110-121` | `120-131` | `rescanPlugins` / `browsePlugins` コマンド |
| `sites/dev/editor/mcp-and-gated-e2e.md:129,1170` / en:129,1170 | `400-407` | `410-417` | `orbitscore.mcpServer.port` 設定 |

いずれも実ファイルで対象ブロックの位置を確かめてから書き換えた（コマンドは 120-131、
`mcpServer.port` は 410-417）。行参照の修正だけなので、この 2 章の `verified-against` は動かしていない。

---
### docs: follow PR #737's dispatch-skip contract into the specs and both sites (Sep 4, 2026)

**追従元**: PR [#737](https://github.com/signalcompose/orbitscore/pull/737)（`645-contain-playback-throws` → main・マージコミット `ef140b1`）/ **ブランチ**: `claude/docs-sync-pr737`

#737 は `Sequence.resolveDispatchChannel()` の **throw を撤去**し、戻り値を
`DispatchTarget = { kind: 'hardware' } | { kind: 'link'; channel } | { kind: 'skip'; reason }`
の tagged union にした（`sequence.ts:103-106`）。LinkAudio セッションで `.output()` を持たない
発音 sequence は、**runtime error ではなく無音スキップ + `logSkipOnce()` のログ 1 行**になる。
**この意味論の変更が 4 つの文書に追従していなかった。**

#### 直したもの

| 場所 | 追従した内容 |
|---|---|
| `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` §8.1.2 | 「`.play()` した時点で **runtime error** を投げる」を削除し、無音スキップ + dedup ログ + `DispatchTarget` の説明に置換。**hardware への silent fallback を行わない**点は不変 |
| `docs/specs-v2/MULTICHANNEL_RENDERING_DESIGN_598.md` §4.4.1 | 「`resolveDispatchChannel()` が throw し、ライブ中に kick が**停止**する」→「skip 判定に落ち、**無音になる**」。非対称の理由（オフライン宣言が live routing を壊さない）は変わらない |
| `sites/dev/editor/execution-feedback.md`（日英）§6-8 | 「runtime では throw として現れる」「7 と 8 が Error なのは runtime で必ず throw するから」を訂正。`DispatchTarget` の引用と、`undefined` を union から外した理由（`catch { return undefined }` が黙って hardware へ流す事故を型で潰す）を追加。drift 表に #645 行 |
| `sites/user/midi/link-audio.md`（日英） | 「ランタイムエラーを発生させます」→「無音でスキップされ、理由がログに出ます」。巻き添え停止を避けるための変更である旨を 1 段落 |

🔴 **ユーザーから見た壊れ方が変わった**: 以前は例外が出て気づけたが、いまは**音が出ないだけ**である。
気づく手段はログ（`[ERROR] Sequence '<name>': … このシーケンスは無音でスキップします。`）と
編集時診断 `analyzeLinkAudioMissingOutput` の 2 つになる。user site にその旨を書いた。

#### 追従しなかったもの

- `docs/design/610-diagnostics-applicability-design.md` — 起案時点のスナップショット（本 PR の設計正本そのもの）
- `sites/user/reference/methods.md` の `output("name")` 行 — 「`global.linkAudio()` 宣言時**必須**」は今も正しい（要件は不変・違反時の挙動だけが変わった）

#### 手順 3 の指摘（直さず PR 本文へ）

- `tests/e2e/dsl-e2e-coverage.spec.ts:86-96` — `GLOBAL_UNCOVERED_BASELINE` から `linkAudio` が
  削除されたが、gated sources 内の `.linkAudio(` は
  `tests/e2e/orbitstudio-mcp-gated.spec.ts:4583` / `:4593` の **コメント 2 箇所だけ**である。
  同 PR で gated E2E 本体（`it(...)`）は #736 へ切り出されて存在しない。ラチェットの走査は
  ソース文字列 `/\.([a-zA-Z][a-zA-Z0-9]*)\s*\(/g` なのでコメントでも満たされる
### fix(649): correct the attribution and add the test that actually guards the master line (Sep 5, 2026)

**Issue**: #649 / **ブランチ**: `649-stereo-internal-master-line` / **PR** #754

ゲート③（`/simplify` 4 体 + Fable 監査を並行）。**Critical 0 / Important 3**。
最大の指摘は「**この PR の Rust 差分を区別できる検証が存在しない**」だった。

#### 🔴 帰属の訂正 — E2E-1 が緑なのは本 PR の Rust 差分の効果ではない

Fable が `374e8b2d`（2026-08-29・**main に既に入っている**）を指摘した。そのコミット本文:

> instrument の音は `CompositePostProcessor` で master バッファへ直接加算されており、
> バスグラフの外にいた。これを `render_multi` の内側・event 混合後・gain ramp の前へ移し …
> **帰結: `global.gain` が instrument に効くようになった**

**推論で済ませず実機で反証した**（main の `rust/` + このブランチの `tests/`）:

```
✓ #643 E2E-1 applies global.gain(-6) … 9321ms
```

**main の rust でも緑**。つまり #649 の見出しの症状は 8/29 に main で消えており、E2E-1 が赤かったのは
**オラクルだけ**が原因だった。「段 1 の目的が証明された」という以前の報告は、事実（E2E-1 が緑）は
真だが**帰属が誤り**だった。

#### では本 PR の Rust 差分は何を直しているのか

**同じクラスの残り半分**。main では `global.effect()`（master ラック = `post`）が core の gain ramp の
**後**に走るので、**ラックが生成・変形した音は `global.gain()` を逃れる**。`MasterLine` は順序を
`rack → gain` に固定してこれを塞ぐ（設計 §5.2）。

🔴 **`Gain` のような線形ラックでは順序を区別できない**（乗算は可換）ので、DSL 経由の E2E では
測れない（`#611 O0-4` のテスト名「a linear rack cannot show order」がまさにこれ）。ユニットで押さえた:

```
master_gain_applies_after_the_master_rack_generates_sound
  FillPost(0.75) + gain 0.5 → hw = 0.375

変異（post と gain の順序を main の形へ戻す）:
  FAILED  master gain must attenuate what the master rack produced: [0.75, …]
```

**これが本 PR の Rust 差分を守る唯一のテスト**。あわせて `advance_gain` / `place_master_into_device`
（8ch の余剰チャンネル・mono マージ）にもユニットを足した。

#### `/simplify` の適用

| 指摘 | 直した形 |
|---|---|
| 🔴 **RT ホットパスで `hw` を二重に書いていた**（3 体が独立に指摘）— 全域 zero-fill の直後に `place_master_into_device` が全要素を上書き | zero-fill を削除し、余剰チャンネルの 0 埋めを配置関数の責務へ。2ch は `copy_from_slice` に。**64 frames × 2ch なら約 96,000 store/秒の無駄**だった |
| `ensure_buffer_len` が `MasterLine` と `InsertBusStage` で完全に同一 | 自由関数 `ensure_audio_buffer_len` へ集約 |
| `awaitSoundRestart` の 5 定数が 2 箇所に verbatim | `makeAwaitSoundRestart` ファクトリへ集約 |

#### Fable I-2 — 非 production feature が engine バッファをデバイス幅で解釈していた

`clap-host` は `ClapPostProcessor` に、`link-audio` は consumer に **`stream.channels`（デバイス幅）**を
渡していた。どちらも受け取るのは `master.buffer`（**常に 2ch**）なので、8ch デバイスでは frame 数が
1/4 になって音が化ける。`ENGINE_CHANNELS: usize = 2` を名前付き定数として公開し、両方をそれに揃えた。

production build には含まれない feature なので実害は無かったが、設計 §5.5 の
「events / feeds / stages はすべて 2ch」を**この 2 経路だけが継承していなかった**。

#### 検証

`npm test` 2251 passed / `typecheck:e2e` 0 / `lint` 0 /
`cargo test -p orbit-audio-native -p orbit-audio-daemon` **144 passed / 0 failed**（21 スイート）/
clippy **5 象限**（`clap-host` / `link-audio` を含む）全緑 / `docs:check` 926 verified 0 failed

---

### test(e2e): open the window after the sound restarts, not after a fixed settle (#649) (Sep 5, 2026)

**Issue**: #649 / **ブランチ**: `649-stereo-internal-master-line` / **PR** #754

**`#643 E2E-1` 〜 `E2E-7` の 7 本すべてが実機で緑**になった。落ちていたのは**判定側**で、
ミキサーの実装は最初から正しかった。

#### 実測（`ORBIT_KEEP_CAPTURES` で WAV を残し 20 ms 窓を並べた）

E2E-2 の capture:

```
0.00 – 3.06s  silent            ← 起動 + 小節量子化 + attach
3.06 – 4.98s  SOUND  max 0.1794 ← dry（0 dB）
4.98 – 5.06s  silent (0.08s)    ← LOOP の小節境界の切れ目
5.06 – 5.78s  SOUND  max 0.1794
5.78 – 7.08s  silent (1.30s)    ← dry.stop() → LOOP(wet) の量子化待ち
7.08 – 8.02s  SOUND  max 0.0899 ← wet
```

🔴 **比は `0.0899 / 0.1794 = 0.501`** — -6 dB の理論値ちょうど。**実装は正しい。**
落ちていたのは「wet の窓が 6.2 秒から開いて 85 窓中 46 窓しか可聴でない」という判定側だった。

#### 原因は 2 種類

| 原因 | 該当 | 直し方 |
|---|---|---|
| **窓が無音の上に開く** — `captureSegment` の発音待ちは**初回だけ**で、2 回目以降は固定 400 ms | E2E-2 / E2E-4 / E2E-6 | `waitForSoundRestart` を新設し、鳴らし直した後に**もう一度鳴り出すまで待つ** |
| **原理的に満たせない条件** — `every(rms >= 0.01)`（一度も途切れない） | E2E-7 | 他の 6 本と同じ `expectSegmentsSounding`（割合で見る）へ |

`waitForSoundRestart` は 2 段階:

1. **末尾が静かになるまで待つ**（前の LOOP が実際に止まった確認）。`quietTimeoutMs` 以内に
   静かにならなければ**そのまま次へ進む** — 切れ目なく続く譜面では静寂が来ないのが正しい
2. **末尾が可聴になるまで待つ**

`quietSec` は LOOP の小節境界の切れ目（**実測 80 ms**）より十分長く取る（0.3 秒）。短いと
段階 1 がその切れ目で成立してしまい、鳴り直しを待たずに返る。

🔴 **固定 settle を伸ばす形にしない。** 小節境界までの残り時間は評価のタイミング次第で
0〜1 小節ぶん変わるので、定数では追えない（前セッションで settle 2600 ms が反証済み）。

#### 実機（全件）

**5 failed / 21 passed（26 件）**。main baseline は **10 failed / 24**。

| 残る失敗 | 種別 |
|---|---|
| `drives real OrbitStudio end-to-end` | main baseline（**#760** で main を実測して確認） |
| `steps the live playhead` | main baseline（`Mixer bus name "drum" is ambiguous`） |
| `restores an MCP-saved …` | 環境要因の疑い（`Failed to cleanup old directories: ENOENT`） |
| `#606 E2E-K3` | **起動タイムアウト**（アサーション失敗ではない） |
| `#611 O0-4` | `snapped range must contain exactly 8 onsets; got 9`。**単独実行では緑**（`effectOnlyOverDry=1.9953` / `combinedOverDry=1.0000`）＝全件の文脈でだけ出る揺れ |

`npm test` 2251 passed / `typecheck:e2e` 0 / `lint` 0 / `docs:check` 926 verified 0 failed。

---

### test(e2e): fix the #643 audibility oracle — E2E-1 is green (Sep 5, 2026)

**Issue**: #649 / **ブランチ**: `649-stereo-internal-master-line`

🔴 **段 1 の目的「`global.gain(-6)` が instrument に効く」が実機のキャプチャ RMS で証明された。**

| | 失敗 |
|---|---|
| `main` baseline（同日・同一条件） | 10 / 24 |
| **#649（本コミット後）** | **8 / 26** |

`#643 E2E-1` / `E2E-3` / `E2E-5` が緑になった。新規の失敗 1 件は
`restored RMS 0.0307 vs 許容 0.03` の**境界落ち**で、実行ごとに揺れるプラグイン state 復元系。

#### 🔴 E2E-1 が赤かった本当の理由 — ミキサーではなくオラクル

`#649` のミキサー差分を載せても、E2E-1 は赤のままだった（退行ゼロ・改善ゼロ）。
`ORBIT_KEEP_CAPTURES` で WAV を残して実測したところ、**音も gain の変化も正しく写っていた**:

```
643-global-gain.wav  dur=7.96s
  0〜3.04s 無音（小節量子化 + プラグイン attach。#739 の記録どおり）
  3.04〜5.48s : 0.175〜0.179（持続音・安定）
  5.48s〜     : 0.087〜0.090   ← global.gain(-6)
  比 = 0.088 / 0.177 = 0.497   （-6 dB の理論値 0.501）
```

落ちていたのは前提条件 `windows(name).every((w) => w.rms >= 0.01)` だった。
0.01 未満の窓は **247 個中 11 個だけ**で、位置がすべて **4.96/4.98/5.00/5.02** と
**6.96/6.98/7.00/7.02** 秒。120 BPM の 1 小節は 2 秒なので **3.0 / 5.0 / 7.0 秒は LOOP の折り返し**で、
そこに **80 ms の切れ目**が入る。区間 2 秒は必ずこの境界を 1 つ含む。

**つまりこの条件は「音が出ているか」ではなく「一度も途切れないか」を見ており、
LOOP を跨ぐ限り原理的に満たせなかった。** 測りたいのは前者なので、
**大半の窓（既定 90%）が可聴であること**へ変えた。

#### 🔴 途中で 1 度、誤った修正を入れた（記録）

最初は「減衰音では全窓可聴を満たせない」と考え、**オンセット数**（`onsets(name).length >= 3`）に
置き換えた。実機は `got 0` で落ちた。理由は素材の取り違えで、#643 は**持続音**だった。
オンセット閾値は `max(全窓 RMS の中央値 × 4, 下限)` という**打楽器向け**の式で、実測すると:

| capture | 中央値 | max | 閾値 | オンセット |
|---|---|---|---|---|
| `643-global-gain`（持続音） | 0.0877 | 0.1794 | **0.3508** | **0**（閾値が max を超える） |
| `611-o0-no-bus-first`（打楽器） | 0.00001 | 0.3793 | 0.0200 | 15 |

同じ実行で O0-* が通り #643 が落ちる差は、**素材の違い**だった。

**推測で 2 回動くより、WAV を 1 回残した方が速かった。**

#### 残る #643 の 4 件は性質が違う

- **E2E-2 / E2E-4 / E2E-6**: `wet 34/85`・`sumAux 35/85`・`nextDry 52/85` と**区間の半分以上が本当に無音**。
  オラクルではなく、その経路で音が出ていない可能性がある
- **E2E-7**: `expected 7 to be greater than or equal to 8`（別のアサーション）

#### そのほか

`clap-host` feature でしかコンパイルされないテスト呼び出しが `EngineWrap::build` の
`master_gain` 追加に追従しておらず、pre-push の clippy が捕まえた。
🔴 **`check-cfg-matrix.sh` は 4 象限しか見ない**ので、`--features outproc-*` のビルドと
`npm test` が緑でもこの象限は一度もコンパイルされない。

### fix(661): close the review round-2 findings across all four layers (#661) (Sep 5, 2026)

**Issue**: #661 / **ブランチ**: `661-stream-liveness-instrumentation` / **PR** #748

ゲート③ ラウンド 2（`/code:pr-review-team` フル編成 4 体 + Fable 監査を並行）。
**Critical 0 / Important 5**（うち 3 体が同じ 1 件に収束）。設計パスを 1 つ置いてから一括で直した。

#### 設計パス P1 — ライブ切替の失敗を利用者にどう見せるか

分ける軸は「**いま鳴っている音を止めずに直せるか**」。表は
`packages/vscode-extension/src/engine-view.ts` の `SELECT_AUDIO_DEVICE_ERRORS` **1 箇所**に置き、
文言・再起動の要否・「既知かどうか」の 3 つをすべてそこから引く。

| code | 音 | Restart Engine |
|---|---|---|
| `AUDIO_DEVICE_UNAVAILABLE` | 鳴り続ける | ❌ 出さない |
| `AUDIO_DEVICE_STREAM_DEAD` | 鳴り続ける | ❌ 出さない |
| `AUDIO_DEVICE_SWITCH_UNAVAILABLE`（録音中） | 鳴り続ける | ✅ |
| `AUDIO_DEVICE_RATE_MISMATCH` | 鳴り続ける | ✅ |
| `AUDIO_DEVICE_SWITCH_RECOVERY_FAILED`（新設） | **止まっている** | ✅ |

🔴 これを直した理由: F4（名前不一致は縮退せず拒否）を実装したのに、**UI は未知コードとして
「Restart Engine」を提示**していた。再起動すると起動経路のポリシーで host 既定へ移るので、
**F4 が避けたかった「演奏中のタイプミスで音が内蔵スピーカーへ移る」を UI が自分で起こす**形だった。

`SwitchRecoveryFailed` を `primary` のコードへ畳むのもやめた。畳むと
`AUDIO_DEVICE_STREAM_DEAD` の「元の出力を継続します」が、**継続できていない**事象に付く。

#### 🔴 C-7 — 到達不能だった安全網を到達可能にした

`apply_device_switch` の「probe 成功 → 旧を pause → 新の build/play/confirm が失敗 → 旧を
`play()` で再開」は、**どのテストからも到達できなかった**。実ストリームを殺せる唯一のフォールト
`DeadRealStream` はプロセス全体に効き、daemon が起動できない（C-4 がそれを証明している）。

`StreamBuildStage { Startup, Switch }` と `OutputFault::DeadRealStreamOnSwitch` を足して到達可能にし、
gated Rust `C-7` を新設。**変異で赤を実測**:

```
変異なし                    : ok
guard.stream.play() を削除  : FAILED
  the old stream did not resume after a failed switch:
  before_rate=48, resumed_rate=0
```

`resumed_rate=0` = 旧ストリームは pause されたまま**恒久的に無音**。これが起きるのが最悪ケース。

#### E2E の判定を強くした

| テスト | 直前まで | 直した形 |
|---|---|---|
| **D-0** | `rms > 0` だけ | `output.device_name` が**要求名と一致**・`device_fell_back === false` |
| **D-2** | `rms > 0` だけ | `device_requested` が要求名・`device_fell_back === true`・`fallback_reason` に理由 |
| **D-1** | `toBe(before)` が両辺 undefined で**空振りで通る** | 先に `typeof … === 'string'` を固定。包含側も D-3 水準へ |
| **D-3** | 包含側が `ERROR:` 前置に依存（chunk 境界で**偽赤**） | 前置に依存しない `newLogLines` で数える |

🔴 D-0 は **#661 の受け入れテストそのもの**（「デバイス指定で音が出る」）なのに、`rms > 0` は
「何らかのデバイスから音が出た」しか言わない。このマシンは出力が実質 1 台なので、
**指定が無視されて既定に落ちても緑になっていた。**

デバイスの検査は**鳴っている間**に取る必要があった（`runScore` から戻った時点で engine は停止済みで
`get_engine_state` は `{running:false}` しか返さない）。1 度これで落ちてから直した。

#### その他

- `get_engine_state` の状態問い合わせ予算を 10 秒 → **2.5 秒**。`waitForEngine` はこのツールで
  `running` を 500 ms 間隔でポーリングするので、10 秒だと 30 秒予算で 3 回しか試せなかった
- 判定を `resolveEngineState`（`engine-state-bridge.ts`）へ切り出し、**3 分岐すべてに単体テスト**
  （停止中 / ブリッジが `ok:false` / ブリッジ自体が reject）
- 切替失敗のメッセージから `audio output init failed: ` の前置を落とした。**切替では何も init して
  いない**のに、ERROR ログ・`last_switch_failure`・MCP の返り値・UI 文言すべてに載っていた
- `engine-view.spec.ts` の入力を実形式 `[CODE] message` に揃えた（捏造した mock 文言だった）
- 設計 §4.5 に「1 回の失敗を 2 層が記録する」を明記。§6 受け入れ 7（**倍速になるか**）に結論を記載
- `docs/research/ENGINE_DAEMON_PROTOCOL.md` に `SelectAudioDevice` の失敗コード表を追加

#### §2.2「時間が倍速になるか」— 決着

**倍速にならない。ただしそれは `pause()` が 2 重に効いているから**で、リスク自体は実在した。
C-6 の実測（`--audio-device <既定の名前>` → host 既定へ切替）:

| 変異 | callbacks/s |
|---|---|
| 変異なし | **94**（等速） |
| (a) だけ削除 / (b) だけ削除 | 94（もう片方が効く） |
| **(a)(b) 両方削除** | **190**（ほぼ倍速） |

#### fix 差分の再点検（PROJECT_RULES §4）

`73b7abce..326e5fce` を 1 レビュアーで再点検。問いは 2 つだけ（新しい故障モード / 実行コンテキスト）。
**Critical 0 / Important 1**: 「`get_engine_state` の予算短縮が本番の観測性を下げる」。

一次ソースで裁定した結果、**予算では解決しない**:

`//#getEngineState` は REPL の `handleLine` の中で処理され、`createReplSession` の `pushLine` は
**全行を単一の FIFO promise チェーン**に載せる（`repl-mode.ts`「直列化の根拠 — #476」）。
instrument の attach は実測 30 秒超なので、10 秒でも 2.5 秒でも答えは返らない。伸ばして変わるのは
「同じ `statusError` を返すまでに何秒ブロックするか」だけ。

→ 2.5 秒は据え置き、コメントを **E2E 都合ではなく本番の根拠**に書き直して
`ENGINE_STATE_QUERY_BUDGET_MS` として定数化。本来の解決（状態問い合わせをキューの外で処理する）は
**#759** へ切り出した。

#### 別 issue へ分離（7 本）

**#755** `select_audio_device` が人間のクリックトグルを共有 /
**#756** `setupStderrHandler` の `ERROR:` 前置が chunk 単位 /
**#757** request 相関ブリッジが 5 本 625 行の重複 /
**#758** 捨てた旧ストリームの disconnect listener が共有 `StreamStats` に `device_lost` を書く /
**#759** `//#getEngineState` が評価キューの後ろに並ぶので長い await 中は状態が見えない

#### 検証（実機・sandbox 外）

```
gated Rust  C-1〜C-7  7 passed / 0 failed
gated MCP   #661 D-0 / D-2 / D-3  3 passed
```

🔴 `cargo test` を Bash の sandbox 内で回すと CoreAudio が塞がれ `Device::name()` が
backend error で落ちる（C-1 まで赤くなる）。実機オーディオのテストは sandbox 外で回すこと。

---


## 段 1 must-fix（09-05・#661 / #606 / #746）

`docs/development/WORK_LOG.md` が 2,000 行上限を超えたため 2026-09-06 に移設した分。

### fix(audio): gate output devices on callback liveness (#661 PR-V4) (Sep 5, 2026)

`--audio-device` で stream の build/play が成功しても callback が一度も来ず、無音のまま
daemon が起動成功していた問題に対し、`Engine` と callback-owned `RenderState` の生成前に
probe stream を開く liveness gate を追加した。probe は専用 `AtomicU64` を使うため、実 stream の
`StreamStats.callbacks` を汚さない。3 秒以内に callback が来ない名指し候補は起動時だけ host
既定へ 1 回縮退し、全候補 dead または実 stream の事後確認 dead は起動を失敗させる。

cpal 0.15.3 の名指し stream 参照循環に対して、`OutputStream::drop` は必ず内部 stream を
`pause()` してから field を破棄する。ライブ切替も旧 stream を先に pause し、新 stream の probe /
事後確認が失敗したら新 stream を pause+drop して旧 stream を再開する。異なる sample rate は
`AUDIO_DEVICE_RATE_MISMATCH` で拒否し、Engine の作り直しは行わない。

`GetStatus.output` に requested / fallback / reason / first callback ms を追加し、engine は正常時の
出力構成を INFO、縮退時だけ `❌ audio device fallback` を ERROR としてユーザーの `get_log` へ出す。
実機 gated Rust C-1〜C-6 と MCP D-1〜D-3 を追加した。

検証: Rust lib 105 passed / 2 ignored、daemon bin 7 passed、gated Rust はコンパイル成功、clippy
`--all-targets -D warnings` 成功、cfg 4 象限成功、`clap-host` build 成功、E2E hygiene 15 passed、
`typecheck:e2e` 成功。`link-audio` / `link-audio-verification` は worktree に Ableton Link submodule が
無く build.rs で失敗。実機 gated と C-6 の pause 除去変異は sandbox では実行しない。
### test(daemon): prove the all-notes-off ledger actually shrinks (#606 round-3) (Sep 5, 2026)

**Issue**: #606 / **ブランチ**: `606-run-termination-noteoff` / **PR** #738

fix 差分の再レビュー（4 体）。**指摘はすべて fix 起因**で、元差分起因の新規指摘は出なかった。

#### 🔴 最も重い指摘 — 中核の機構に検査が無かった

`plugin_all_notes_off` が**成功時に台帳から entry を除去することを検査するテストが 1 本も無かった**。
panic テストは `retain` ブロックに到達する前に止まるので、**ブロックを丸ごと削除する変異が全テストを通過**する。
放置すると台帳が永久に増え、次の解放で**死んだ note を送り続ける**。

- `plugin_all_notes_off_removes_every_released_entry_from_the_ledger` を追加。
  3 件解放して `released == 3` / `stale == 0` / `failed == 0` に加え、
  **`active_plugin_note_count() == 0`** と **ring へ 3 件届いたこと**を検査する
- 🔴 **変異で red を確認**: `retain` ブロック削除 → `left: 3 / right: 0`。
  このとき**既存の他 2 本は通ったまま**で、指摘が事実だったことも同時に裏付けられた

#### そのほか

- **重大度の逆転が半分しか直っていなかった**。`spawn_blocking` の `JoinError`（解放タスク自体が
  panic / cancel = **そもそも試みられていない**）が `warn!` のまま残っていたので `error!` に上げた
- bounded retry の「途中で成功する」分岐が、cfg を広げた後も**bare な `rtrb::Producer` を叩くだけ**で
  本番の `push_outproc_instrument_event`（instance 解決 + lock 分岐）を通っていなかった。
  容量 1 の ring を埋め、15 ms 後に consumer が drain する形で**実経路を通すテスト**を追加
- 設計書の `StopAll` 行参照が二度ずれていた（`2289-2292` → 実体は `2296-2299`）

#### 🔴 私の失敗 — 変異のバックアップに `git checkout --` を使った

未コミットの新テストごと巻き戻した。**git で戻せるのはコミット済みの内容だけ**で、
未コミットの追加があるときはファイル退避が正しい。生成スクリプトが残っていたので復旧できた。

#### 検証（main が sandbox 外で実測）

- `cargo test -p orbit-audio-daemon --features outproc-effect,outproc-instrument`
  — lib **259 passed** / protocol **32 passed**
- `cargo clippy --all-targets -- -D warnings` exit 0
- `npm test` **2251 passed / 0 failed** / `typecheck:e2e` / `lint` exit 0 / `docs:check` **926 verified / 0 failed**
- 実機 gated（`89e9d389`）: **10 failed / 16 passed・退行ゼロ**、`#606 T1` / `#606 E2E-K3` とも ✅

### fix(daemon): close review round-2 on the RUN-termination branch (#606) (Sep 5, 2026)

**Issue**: #606 / **ブランチ**: `606-run-termination-noteoff` / **PR** #738

レビュー 5 体のラウンド2。**実機の受け入れは先に達成している**（T1 / E2E-K3 とも緑・退行ゼロ）ので、
このラウンドで直したのは**診断・記録・テストの区別力**である。

#### 🔴 指摘が 1 件、レビュアー間で解けた

silent-failure が「panic 時に `SessionRegistration::drop` が解放しないので最後の砦が機能しない」（MEDIUM）、
pr-test-analyzer が「その経路にテストが無い」（Critical）と報告したが、Fable の経路列挙と
`main.rs:53-75` の実装で、**daemon の panic hook は `std::process::exit(1)` を呼び unwind しない**ことが分かった。
本番で Drop のフォールバック分岐には**到達しない**（そして daemon が死ねば `ParentWatch` で child も落ちるので音は止まる）。

ガード自体は将来の早期 return に対する保険として残し、**コメントを実体に合わせた**。

#### ポリシー A — 文書とコメントは実体を写す（5 件）

**この PR の fix 自身が作った不一致**だった:

- `clap-host` 単独ビルドは実装が `Ok(空 summary)` なのに、文書 2 箇所が `CLAP_UNAVAILABLE` のまま
- wire 例とフィールド説明に `failed` が無い（実装は常に返す）
- 設計 §3.5 の「quarantine 時は旧 child がまだ鳴っている可能性がある」という**前提そのものが誤り** —
  quarantine の全 variant で child は必ず殺される（`InstrumentChildSupervisor::drop` → watchdog が
  `CONTROL_QUIT` → `reap`）。実害は `released` の水増しに留まる。**#752 の scope に含めると明記**
- 設計 §4 の受け入れ表に T2 が残っていた（実装は**意図して置いていない**・理由はコード側にある）

#### ポリシー B — 診断は読める場所まで届かせる（2 件）

- **`GetStatus` に `active_plugin_notes` を追加**。設計 §1 H4 の問題意識が「台帳に読み手が 0 件」だったので、
  LLM が「stop 後に台帳が空か」を**ポーリングで確認できる**ようにした（`get_log` の 500 行窓に依存しない）
- 🔴 **main が Codex の差分を読んで 1 件直した**: 台帳が読めない（poison）時に **`GetStatus` 全体が失敗する**
  実装になっていた。それではデバイス・レート・uptime・render_contentions まで**異常時にこそ**失われる。
  **その 1 項目だけ `null` に縮退**させ、理由を ERROR ログに出す形にした（文書にも明記）
- disconnect trigger で「そもそも解放を試みられなかった」失敗が `warn!` だったのを `error!` に上げた
  （より軽い「一部の note の配送失敗」が `error!` で、重大度が逆転していた）

#### ポリシー C — テストは区別できる形に（2 件）

- 🔴 panic テストが台帳に **1 件しか注入しておらず**、「push 成功のたびにその場で remove」実装に変えても
  生き残っていた。**3 件注入**（配送成功済み / panic する / 未処理）に直し、変異で
  **`left: 2 / right: 3`** の red を実出力で確認
- 🔴 bounded retry の**「リトライ途中で成功する」分岐**が `#[cfg(feature = "clap-host")]` に閉じており、
  **本番構成（`outproc-instrument` 単体）ではコンパイルすらされていなかった**。cfg を広げ、
  `--features outproc-effect,outproc-instrument` で実走することを確認

#### 先送り（#752 に集約）

code-reviewer が `plugin_all_notes_off` 自身にも同型のレース（スナップショットと最終 `retain` の間の
NoteOn が消える）を見つけたが、**本番の daemon 接続は 1 本のみで RPC も直列化される**ため到達しない。
台帳に識別子を持たせる構造的な解は **#752** にまとめ、ここで部分的に変えない。

#### 検証（main が sandbox 外で実測）

- `cargo clippy --all-targets -- -D warnings` exit 0
- `cargo test -p orbit-audio-daemon` — protocol **29 passed** ほか全 green
- 同 `--features outproc-effect,outproc-instrument` — lib **257 passed** / protocol **32 passed**
- `npm test` **2251 passed / 0 failed** / `docs:check` **926 verified / 0 failed**

### refactor(daemon): apply the /simplify pass to the RUN-termination branch (#606) (Sep 5, 2026)

**Issue**: #606 / **ブランチ**: `606-run-termination-noteoff` / **PR** #738

ゲート③の `/simplify`（4 体並行）。効率観点は**指摘ゼロ**で、台帳のスナップショットは
stop/shutdown の cold path のみ、bounded retry は ring が空いていれば従来と同コスト
（closure 1 回・追加 allocation なし）と確認された。

#### 適用した 4 件

- **二乗平均の重複を解消**: `analysisTailRms` が式を再実装していた。#746 が
  `tests/e2e/helpers/capture-windows.ts` に `quadraticMeanRms` を切り出して main に入ったので、
  本ブランチを載せ替えて **import に差し替えた**（設計 §6.3）
- 🔴 **session カウンタを RAII ガードにした**（`SessionRegistration`）。`session_connected()` と
  `session_disconnected_is_last()` の間で read loop が **panic すると減算に到達せず**、
  `connected_sessions` が永久に加算されたままになる。そうなると**以後どの session が切れても
  最後の砦が二度と発火しない** — daemon が生きている限りずっと、である。
  同ファイルの `InstrumentReplacementReservation` と同じ「明示的な確定 + Drop の安全網」の形にした
- `wrap_err_to_protocol` の `OutProcInstrument` / `OutProcInstrumentStale` が同じ
  `ProtocolError` を返す完全重複だったので or-pattern に畳んだ
- `stopAll()` の 2 つの fire-and-forget が同一の catch ロジック（ログ文言だけ違う）を写していたので
  `warnUnlessDisconnected(label, err)` に切り出した

#### 適用しなかった 1 件と、その理由

`tailDelay = patternDuration + (scheduleTime - currentTime)` を `patternDuration + 100` に畳む案は
**採らない**。`scheduleTime` は 2 行上で `currentTime + 100` と定義されているので値は同じだが、
差で書いてあることに意味がある — **尻尾はイベントを実際に置いた原点から測る**必要があり、
`scheduleTime` の決め方が将来変わっても自動で追随する。この整合こそが「RUN 終端で音が止まる」の
前提なので、定数へ畳んで結合を切らない。**理由をコメントに書いた。**

テスト重複の指摘 1 件も見送った（アサーションを減らす方向なので）。

#### 先送りしたもの（設計 §6 に記録）

- 🔴 **台帳のキーを slot 同一性にする → #752**。`ReplacePlugin` のスナップショットと再ポイントの間に
  届いた旧 instance 宛 NoteOn は台帳に残り、次の `PluginAllNotesOff` が**新テナントへ NoteOff を送って
  鳴っている音を切る**。本 PR が直した欠陥の鏡像。**窓を狭めるだけでは閉じない**（`plugin_note_on` は
  push → 台帳 insert の順で、その間 control lock を持たない）。
  🔴 **本設計で「wire が名前しか運ばないから無理」と却下したのは誤りだった** —
  `push_outproc_instrument_event` は note の時点で名前→index を解決済みで、`tenant_generation` も既にある
- タイマーのライフサイクル管理点が 2 箇所に分かれている件（設計 §6.2）

#### 検証

- `npm test` **2251 passed / 0 failed**
- `cargo test -p orbit-audio-daemon --features outproc-effect,outproc-instrument`
  — lib **252 passed** / protocol **32 passed**
- `clippy --all-targets -- -D warnings` exit 0 / `typecheck:e2e` / `lint` exit 0

### fix(daemon): make the all-notes-off ledger survive its own failures (#606 round-1) (Sep 5, 2026)

**Issue**: #606 / **ブランチ**: `606-run-termination-noteoff` / **PR** #738

レビュー 5 体（Sonnet 4 + Fable）の指摘を 2 つの横断ポリシーへ集約して一括で直した。
指摘単位のローカルパッチは振動の主因なので置かない。

#### ポリシー A — 壊れた時に真因が残ること

台帳を **drain（取り切り）→ 失敗分を戻す**のをやめ、**clone → 送出 → 解放済みだけ除去**に向きを反転した。

- 🔴 旧実装はループ内で panic すると（`push_outproc_instrument_event` に
  `.expect("instance_index always maps to a pre-allocated slot")` がある）**台帳が丸ごと消え、
  二度と復元されなかった** — 最後の砦が最後の砦でなくなる。反転後は panic が「台帳が残る」＝安全側に倒れる
- 復帰用 `extend` と、そこにあった**無言の `poisoned.into_inner()`** が消えた（drain 側は大声の `Err`
  だったので扱いが非対称だった）
- `PluginAllNotesOffSummary` に `failed` を足し、配送に失敗しても **`Ok(summary)` を返す**。
  `Err` は台帳そのものが読めない（poison）時だけ。呼び手が知りたいのは「音が残ったか」で、
  それに答えるのは `failed > 0` という機械可読な数であって不透明な `Err` ではない
- 最初のエラーは released/stale/failed と一緒に `tracing::error!` へ 1 回だけ

#### ポリシー B — 暗黙の結合を検証する

台帳の鍵は**名前**だが、スロットの同一性は **index + 世代**である。この 2 つがずれる窓を塞いだ。

- 🔴 `ReplacePlugin` は `instance_index.insert(name, spare)` で**名前を新スロットへ向けた後**、
  teardown（最大 500 ms 待つ）を挟んでから名前一致で台帳を掃除していた。その窓で新テナントへ届いた
  NoteOn は同じ `(name, ch, key)` として台帳に入り、**巻き込まれて消える → その音が解放されず鳴りっぱなしになる**。
  **3 体のレビュアーが独立に指摘した唯一の項目**
- 修正: **再ポイントの前に**旧テナントの entry を写し取り、teardown 後は**その集合だけ**を消す。
  lock の入れ子は作らない（control を握ったまま台帳 lock を取らない）
- `push_outproc_instrument_event` を `push_with_bounded_retry` に載せた。in-process の兄弟は
  同じ物理状況（ring 満杯は一時的）に既に bounded retry を持っており、**片方だけ one-shot** だった
- 台帳 lock + poison 文言の 5 重複を `lock_active_notes` に集約（poison の扱いが構造として 1 つになる）

#### そのほか

- session 切断 trigger を「**最後の確立済み session が切れた時だけ**」に変更。台帳は daemon 全体で
  共有なので、2 つ目のクライアントが切れて 1 つ目の音が止まる形を避ける
- `clap-host` のみのビルドは空 summary を返す（`global.stop()` のたびの警告が消える）
- `engine_wrap.rs` の active-note 台帳コメントを実体に合わせた

#### 検証（main が sandbox 外で実測）

- `cargo clippy --all-targets -- -D warnings` exit 0
- `cargo test -p orbit-audio-daemon` — protocol **29 passed** ほか全 green
- `cargo test -p orbit-audio-daemon --features outproc-effect,outproc-instrument`
  — lib **252 passed** / protocol **32 passed** / `plugin_all_notes_off` 1 passed
- `npm test` **2224 passed / 0 failed**

🔴 Codex は sandbox で protocol テスト（loopback bind）を走らせられず 29 件 red と報告していた。
**同じテストが sandbox 外では全部 green** — 委譲先の赤も緑も main が回し直す。

### feat(audio): add daemon-side plugin all-notes-off fallback (#606 PR-K-A2) (Sep 5, 2026)

**Issue**: #606 / **ブランチ**: `606-run-termination-noteoff` / **PR-K-A2**

OOP instrument の active-note 台帳を drain して個別 `NoteOff` を送る
`EngineWrap::plugin_all_notes_off()` を追加した。配送関数はこの 1 本に集約し、明示
`PluginAllNotesOff` RPC と WebSocket session 切断直後の 2 箇所から起動する。これにより、
engine が異常終了して RPC を送れず daemon と instrument child だけが残る経路でも解放できる。
台帳 lock は drain 中だけ保持し、ring push 前に解放する。`ReplacePlugin` の旧 tenant entry は
teardown 成功時だけ除去し、quarantine 時は最後の砦が拾えるよう保持する。

TS は `RustEnginePlayer.stopAll()` の既存 `StopAll` の直後だけに flush を配線した。
空の要約は無言とし、`released` または `stale` が非 0 の時だけ stdout に要約を出す。
protocol/core spec に wire 契約と 2 trigger を記録した。

protocol / gated / TS テストは実装ファイルと分離して先に追加し、未実装状態で Rust は新 API
不在の E0599、Vitest は `pluginAllNotesOff is not a function` の red を確認した。sandbox の bind
制限下でも本体を実行できる socket 非依存 integration を実装後に補助追加した。実装後は Rust lib
（default: 39 passed、outproc-instrument: 131 passed / 1 ignored）、同 integration、対象 Vitest、
cfg 4 象限 clippy、E2E typecheck、lint が green。WebSocket integration は sandbox の loopback
bind が `EPERM`、実機 gated E2E は指示どおり未実行。全 `npm test` は 153 files / 2118 tests が
pass した一方、loopback 使用箇所が同じ `listen EPERM: operation not permitted 127.0.0.1` により
4 files / 106 tests fail（55 skipped）した。git metadata が親 worktree 配下にあるため sandbox が
`index.lock` を拒否し、要求された test-only / implementation の 2 commit は作成できなかった。

---

### test(e2e): make the phase sweep actually discriminate the float-family bug (#746 round-3) (Sep 5, 2026)

**Issue**: #739 / **ブランチ**: `739-capture-windows-follow-sound` / **PR** #746

ラウンド2 で入れた「500 位相スイープ」が、**守るべき欠陥を検出できていなかった**。

#### 何が起きていたか

ラウンド2 は「`onsets`（`w * WINDOW_SEC`）と `windows[].startSec`（`start / sampleRate`）が
**別の浮動小数の族**で、`>=` / `<` 比較が位相で 199/200/201 に揺れる」を整数バケット index への
統一で直し、500 位相スイープを常設した。

🔴 **main が変異検証したところ、ウィンドウ選択を元の族またぎ比較へ戻しても、そのスイープは緑のままだった。**

原因: スイープは**合成 WAV 内の打撃時刻を固定したまま capture 区間だけ**を 1 バケット内で動かすので、
`firstOnset` が実質 1〜2 値しか取らない。**ずれの発生源は絶対バケット index**（2 つの族の乖離は
`w` が大きいほど広がる）なので、区間を動かしても再現しない。

Codex が回した変異（`steadyRms` が NaN を返す）は「アサーションが結線されている」ことしか示しておらず、
**シナリオが欠陥を区別できるか**は示していなかった。

#### 直したこと

- **絶対 onset index を 1000 通り掃く**テストを追加。音を合成せず、`wav-analysis.ts` の 2 つの族を
  そのまま再現した stub を `steadyRms` / `measuredBucketCountForSteadyRms` に渡す
  （`resolveMeasuredRange` は `Pick<CaptureWindows,'windows'|'onsets'>` を取るのでスタブで足りる）
- 🔴 **変異で red を確認**: 族またぎ比較へ戻すと
  `expected [ 200, 199, 201 ] to deeply equal [ 200 ]` — Fable が実測した分布がそのまま出る。
  復元後 46 件 green（`cmp` で復元一致を確認）
- 500 位相スイープは**残す**（実音声の経路を端から端まで通す役）。ただしコメントに
  **「この変異はここでは生き残る」**と明記し、区別する役は新テストだと書いた

#### 同ラウンドで直した残り

- 500 位相スイープが `steadyRms` **本体**を全位相で呼ぶようにした（従来は診断関数だけで、
  onset 数一致・周期性・可聴床のアサーションを通っていなかった）
- `hitPeriodSec` が `ANALYSIS_BUCKET_SEC` の整数倍でなければ**明示的に throw**（暗黙の前提を検査）
- コメントの不正確 2 件（"four" → "five"、D-2 の根拠づけが下のテストに当てはまらない点）

#### 検証（main が本ツリーで実測）

- `npm test` **2238 passed / 0 failed**
- `typecheck:e2e` / `lint` exit 0
- `docs:check` **926 verified / 0 failed**
- 実機 gated: **`main` baseline 10/24 と失敗集合が完全一致 = 退行ゼロ**（同日・同一条件で baseline を取り直した）


### refactor: apply the second /simplify pass to the device-liveness branch (#661) (Sep 5, 2026)

**Issue**: #661 / **ブランチ**: `661-stream-liveness-instrumentation` / **PR** #748

F4 の実装と D-1/D-3 の書き換えが 1 回目の `/simplify`（`b535527f`）より後に入ったので、
`b535527f..HEAD` を対象に 2 回目を回した（reuse / simplification / efficiency / altitude の 4 体）。
Efficiency は指摘なし（RT コールバック本体・`FIRST_CALLBACK_DEADLINE` の起動予算・1 Hz ticker の
いずれにも新しいコストは入っていない）。

#### 適用した 5 件

| 指摘 | 直した形 |
|---|---|
| `requireCatalogPaths()` が `requireCatalogFixtures()` の完全な部分集合 | 後者が前者を呼ぶ形にして、パス検査を 1 箇所に戻した |
| `--list-audio-devices` で既定デバイス名を取る 5 行が **3 箇所**（D-0 / D-2 / D-3） | `tests/e2e/helpers/audio-devices.ts` を新設（`listOutputDevices` / `defaultOutputDeviceName`） |
| `session.rs` の `OutputError` → protocol code の表が **2 箇所**（直接の `Output` と `SwitchRecoveryFailed.primary`） | `actionable_output_error_code` に集約。6 アーム → 1 アーム |
| `select_audio_device` の `reject_device_switch` が **5 箇所**に散っていた | `dispatch_device_switch` が「owner thread に届く前」の失敗をまとめて `Err` で返し、記録は 1 箇所 |
| 🔴 `resolve_output_device(.., allow_fallback: bool)` / `select_live_output_device(.., allow_dead_fallback: bool)` | **`DeviceFallbackPolicy { FallBackToHostDefault, RejectAndKeepCurrent }`** に置換 |

最後の 1 件が本命。`allow_fallback` と `allow_dead_fallback` という**別名の裸の bool 2 つ**が、
実は owner 裁定（起動時 = host 既定へ縮退／ライブ切替 = 元のデバイスへ復帰）という**1 つの二値
ポリシー**だった。位置引数の `true` / `false` は取り違えてもコンパイルが通るので、
**実装が裁定文と食い違っていた F4 と同じクラスの回帰**が再発しうる形だった。
CLAUDE.md「型で潰す」の適用例（兄弟コールバックを 1 本に畳むのと同型）。

#### 別 issue へ分離した 3 件

| # | 指摘 | なぜ #661 でやらないか |
|---|---|---|
| **#755** | `select_audio_device` がエージェント経路でも人間のクリックトグル（`resolveDeviceClickAction`）を共有していて、**現在のデバイス名を渡すと engine が止まる** | MCP の観測可能な挙動が変わる。D-3 のアプリ分割はこれの回避 |
| **#756** | `setupStderrHandler` の `ERROR:` 前置が **chunk 単位**で、同じ chunk の 2 行目以降が数えられない | **gated 全体の測定器**を動かす。#649 が baseline 比較の最中 |
| **#757** | request 相関ブリッジが **5 本 625 行**の重複（`engine-state-bridge.ts` で 5 本目） | 既存 4 ファイルの書き換えを伴い、無関係な経路に回帰リスクを持ち込む |

#### `cargo test --lib` が 1 回だけ落ちた（順序依存・修正済み）

`device_switch_result_records_failure_and_success_through_the_same_path` が
`captured log: ""` で落ちた。単体実行と再実行は緑。

原因は **`tracing` の callsite interest がプロセス全体で 1 つ**であること。並列に走る別テストが
同じ `tracing::error!` を subscriber の無い状態で先に踏むと `Interest::never()` がキャッシュされ、
捕捉が空になる。捕捉の直前に `tracing::callsite::rebuild_interest_cache()` を呼ぶ形にして、
`--lib` 全件を 3 回連続で緑にした（同型の捕捉テストは 2 箇所あるので両方に入れた）。

#### 検証

`npm test` **2260 passed / 57 skipped** / `typecheck:e2e` 0 / `lint` 0 /
`cargo test -p orbit-audio-native -p orbit-audio-daemon` **152 passed / 0 failed**（22 スイート）/
clippy **5 象限**（4 象限 + `clap-host`）全緑 / `docs:check` **926 verified・0 failed**
（`--fix` で行番号アンカーのみ再固定・16 ファイル）。

---

### test(e2e): split D-3 into its own app and count its failure on both layers (#661) (Sep 5, 2026)

**Issue**: #661 / **ブランチ**: `661-stream-liveness-instrumentation` / **PR** #748

#661 の残り 1 件だった gated `D-3` を実機で緑にした。2 つの別々の欠陥があった。

#### 1. 「切替」ではなく「トグル」になっていた

実機で `audio device deselected and engine stopped: expected false to be true`。
`selectAudioDeviceForAgent`（`packages/vscode-extension/src/extension.ts`）は
`resolveDeviceClickAction` を通しており、**要求デバイスが現在の設定と同じなら「選択解除」**
として扱う（UI のクリック挙動）。D-2/D-3 は同じ fault アプリを共有していて、そのアプリは
`orbitscore.audioDevice` に**既定デバイス名**を持つ。このマシンには出力デバイスが実質 1 台
なので「実在するが現在設定と違う名前」が選べず、D-3 の要求が必ずトグルになっていた。

根は **D-2 と D-3 で必要なアプリ構成が逆**であること:

| | 必要な起動構成 |
|---|---|
| D-2 | 起動時に名前付きが dead → 既定へ縮退して鳴る → **名前付きで起動** |
| D-3 | 演奏中の切替候補が dead → 旧のまま鳴り続ける → **現在の設定と違う名前を要求** |

D-3 を独立した `it.skipIf` に切り出し、`orbitscore.audioDevice: '__default__'` で起動して
既定デバイスを**名前で**要求する形にした（`portBase: 39800`）。`dead-probe-requested` は
「要求された」デバイスに効くので probe が死ぬ。設計 §6 にもこの制約を明記した。

#### 2. 1 回の失敗を 2 層が別々の文言で記録していた

上を直すと今度は `expected [ Array(1) ] to deeply equal []`。除外条件が daemon 側の文言
（`audio output device switch to "X" failed`・`engine_wrap.rs` の `record_device_switch_result`）
だけを見ていたため、engine 側が出す `❌ live device switch to "X" failed: …`
（`packages/engine/src/cli/repl-mode.ts`）が「想定外の ERROR」として残っていた。

- 除外は共通部分 `device switch to "X" failed` で行う
- **利用者に届いたか**は engine 側の文言で「ちょうど 1 行」を要求する。daemon の tracing
  ERROR 行は `outputChannel.append('ERROR: ' + chunk)` が **chunk 単位**で前置するため、
  同じ chunk の 2 行目以降には `ERROR:` が付かず ERROR 行として数えられない
- 落ちた時にデバイス名を含むログ行を全部出す。実機は 1 回 15 秒かかる

#### 検証（実機・sandbox 外）

```
#661 D-0 honors a real named output device and produces audible capture RMS   8255ms  ✓
#661 D-2 falls back from a dead named device at startup and stays audible    14265ms  ✓
#661 D-3 keeps the old stream playing when a live switch candidate is dead   13099ms  ✓
```

`typecheck:e2e` 0 / `eslint` 0 / `prettier --check` 通過 / `docs:check` 926 verified・0 failed。

**関連**: [[reviewers-judge-one-layer-only]]（層をまたぐ契約は片翼だけ見ても分からない）

---

### fix(daemon): keep the current device when a live switch names a missing one (#661 F4) (Sep 5, 2026)

**Issue**: #661 / **ブランチ**: `661-stream-liveness-instrumentation` / **PR** #748

🔴 **owner 裁定 2026-09-05**: ライブ切替で名前が一致しない時は **元のデバイスへ復帰**（縮退しない）。

Fable 監査 F4 が、**実装と設計 §3 の裁定文が食い違っている**ことを見つけた。
`resolve_output_device` の not-found 縮退（`output.rs:315-346`）が**切替経路でも無条件に効く**ため、
存在しないデバイス名を指定すると `ok:true` で **host 既定へ移っていた**。
演奏中に `"Pro Tools Aggregate"` をタイプミスすると内蔵スピーカーへ音が移る形だった。

- `resolve_output_device` に `allow_fallback` を足し、**切替経路では名前不一致・出力不可のどちらでも
  縮退しない**（起動時の縮退は据え置き）。値は既存の `allow_dead_fallback`（起動 `true` / 切替 `false`）
  をそのまま流用した — 「これは起動か」という同じ問いなので、フラグを増やさない
- 新エラー `OutputError::DeviceUnavailable` → プロトコルコード **`AUDIO_DEVICE_UNAVAILABLE`**
- 設計 §3 の確定事項表に裁定を追記

#### E2E D-1 を裁定に合わせて書き換えた

D-1 は**現在の「既定へ移る」挙動を明示的に期待していた**ので、実装と同じラウンドで直した。

- 拒否されること（`isError === true`・メッセージにデバイス名）
- 🔴 **縮退の痕跡（`❌ audio device fallback: requested "..."`）が出ていないこと**
- 増えた ERROR は「切替に失敗した」1 種類だけ（`newErrorLines` で行単位に判定）
- 🔴 **鳴っているデバイスが変わっていないこと** — `get_engine_state` の `output.device_name` を前後で比較。
  **この比較は同ラウンドで新設した bridge があって初めて書ける**（それまで `get_engine_state` は
  `{running}` しか返さなかった）

#### 検証（main が sandbox 外で実測）

- 🔴 **clippy 全 5 象限 green**（default / clap-host / outproc-effect / outproc-instrument / 両方）
- `cargo test --features outproc-effect,outproc-instrument` — lib **268 passed** / protocol **32 passed**
- `npm test` **2260 passed / 0 failed** / `typecheck:e2e` / `lint` exit 0 / `docs:check` **926 verified 0 failed**
- **実機での D-1 / D-3 / D-0 の確認は未実施**

### fix(daemon): keep the old output live while probing a switch candidate (#661 / PR #748 round 1) (Sep 5, 2026)

実機計測で、失敗する切替が本来の 3 秒 probe timeout より約 1.6 秒早く
`STREAM_CALLBACK_STALLED` fatal を発生させ、約 3.1 秒の無音を作ることが判明した。
`apply_device_switch` を **probe → 旧 stream の pause → build → play → confirm** に変更し、
probe 失敗では旧 stream を一度も pause しない。probe と `OutputStream::drop` の
pause-before-drop は維持した。

併せて、probe / real-stream の `StreamDead` を phase で区別し、旧 stream 再開失敗時も元の
失敗理由を保持した。`select_audio_device` の早期拒否も `last_switch_failure` に記録する。
MCP `get_engine_state` は相関 REPL bridge 経由で daemon `GetStatus.output` / `callback` を返す。
gated E2E には、注入なしの実名デバイス起動 + capture RMS、D-3 の不足していた capture 前提確認、
ERROR 上限、`STREAM_CALLBACK_STALLED` 非増加を追加した。名前不一致時の F4 挙動は owner 判断待ちの
まま変更していない。

#### 🔴 この欠陥をどう掴んだか（Fable の予測 → main の実測）

Fable 監査 F1 が「pause が probe より前にあるので、1 Hz の ticker が 2 tick 連続で停止と判定し
**偽の FATAL が決定論的に出る**」と機構から予測し、**反証用のスクリプトを添えて**きた。
main が sandbox 外で回した実出力:

```
[switch-start  2674ms] SelectAudioDevice -> "MacBook Proのスピーカー"
[EVENT  4172ms] STREAM_CALLBACK_STALLED  severity=warning
[EVENT  5172ms] STREAM_CALLBACK_STALLED  severity=fatal     ← 偽の FATAL
[stderr 5802ms] ERROR ... produced no callback within 3000 ms  ← 本物のエラー
```

**本物のエラーより 1.6 秒早く FATAL が出る。** 設計 §6 D-3 の「ERROR が 1 行」は成立しておらず、
実際は DaemonError 2 件 + stderr ERROR 1 件だった。だから D-3 のアサーションは `>=` に緩められていた
（症状に合わせて期待を緩めると、原因が見えなくなる例）。

同時に、**成功する切替が `last_switch_failure` を `null` に戻す**ことも実測で確認できた。

#### レビュアー間で解けた誤検知 2 件

silent-failure が「起動時フォールバックが ERROR でない」「ライブ切替が黙ってすり替わる」と HIGH で
報告したが、どちらも **Rust 層だけを見て TS 層を見落としたもの**だった。

- 起動時の縮退の利用者向け ERROR は `reportAudioOutput`（`rust-engine-player.ts:904-928`）が
  `console.error('❌ audio device fallback: ...')` で出す。engine の stderr は `get_log` で ERROR 行になる
- ライブ切替は `select_live_output_device` の第 4 引数 `allow_dead_fallback` が **`false`**
  （起動は `true`）なので、黙ってすり替わらず `StreamDead` を返して旧デバイスへ復帰する

code-reviewer がこの二層構成を追ったことで解けた。**単層だけ見て「未実装」と判定しない。**

#### 検証（main が sandbox 外で実測・Codex が走らせられなかったもの）

- `cargo test -p orbit-audio-daemon --features outproc-effect,outproc-instrument`
  — lib **268 passed** / **protocol 32 passed**（Codex は sandbox の loopback 禁止で 32 failed と報告していた）
- `npm test` **2260 passed / 0 failed**（loopback を要する HTTP 31 件と daemon-client 32 件も含む）
- `typecheck:e2e` / `lint` exit 0 / `docs:check` **926 verified / 0 failed**

### refactor(daemon): apply the /simplify pass to the device-liveness branch (#661) (Sep 5, 2026)

**Issue**: #661 / **ブランチ**: `661-stream-liveness-instrumentation` / **PR** #748

ゲート③の `/simplify`（4 体並行）。再利用観点は指摘ゼロで、`StreamConfigSnapshot` が既に
`device_requested` / `device_fell_back` / `fallback_reason` / `first_callback_ms` を持っており、
owner 裁定（縮退して鳴らし続ける + 理由を `GetStatus` に記録）の形が型に入っていることが確認できた。

#### 🔴 最重要 — owner 裁定が半分しか実装されていなかった（2 体が独立に指摘）

設計 §3 の確定事項は「起動時 = host 既定へ縮退／**ライブ切替 = 元のデバイスへ復帰**。
**どちらも ERROR ログ + `GetStatus` に理由**」。しかし**起動時の縮退だけ**が `GetStatus` に残り、
**ライブ切替の失敗は `apply_device_switch` の Err 腕で `record_stream_config` も `tracing::error!` も
呼んでいなかった**。理由は RPC のエラー応答と CLI の `console.error` 一回きりにしか存在せず、
**`GetStatus` をポーリングする MCP 経路（LLM / UI の主経路）からは切替失敗が見えない**状態だった。

- 成功・失敗を **`record_device_switch_result` 1 本**へ合流。失敗時は要求デバイス名と理由を
  `tracing::error!` に出し、`StreamConfigSnapshot.last_switch_failure` へ保存する
- `record_stream_config` は snapshot を丸ごと差し替え、コンストラクタが `last_switch_failure: None`
  を置くので、**成功した切替が古い失敗理由を確実に消す**（main が実装を読んで確認）
- 🔴 E2E の D-3 は「ERROR が増えないこと」ではなく「**ちょうど 1 行増えること**」
  （`countErrors(log) >= errorsBeforeExpectedFailure + 1`）へ更新された。
  **ログを出さない方向で辻褄を合わせていない**

#### 却下した指摘（理由を残す）

効率観点が「前置き probe が二重 open を生んでいるので、実ストリームの初回コールバックだけを
ゲートにせよ」と提案したが、**設計で一度検討して却下済み**だった。設計 §4.1:

> `play()` 直後だけに置いてはいけない。`start_output_inner` は `insert_buses` / `sources` を
> `RenderState` に **move** するので、dead 判定後に作り直すには回収が要る。参照循環により
> **名指しデバイスでは `Arc::try_unwrap` が永遠に失敗し、回収できない**。

コストも実測済みで **probe + 事後確認で +20〜40 ms**、`FIRST_CALLBACK_DEADLINE = 3000 ms` は
**失敗時にしか効かない**。読まずに発注していたら直せない状態を作っていた。

#### そのほか適用

未使用の `probe_ms` を削除／`resolved` / `play_and_confirm` / `finish_start` へ重複を集約／
gated テストと E2E の起動ボイラープレートをヘルパー化。

#### 🔴 main が直したもの — リファクタが持ち込んだ型退行

`prepareWorkspace` コールバック経由の代入になったことで、`catalogClapSynthPath` 等 4 件と
`kickLoopWorkPath` が `string | undefined` のままになり `typecheck:e2e` が 6 件の error を出した。
`npm test` は vitest が型を見ないので**緑のまま**で、[[consumerless-code-is-unprotected]] と同じ形。
既存の `requireCatalogFixtures()` を使う形へ寄せ、`requireKickLoopWorkPath()` を足した。

#### 検証（main が sandbox 外で実測）

- 🔴 **clippy を全 5 象限で実行**（default / clap-host / outproc-effect / outproc-instrument /
  outproc 両方）— **すべて green**。`check-cfg-matrix.sh` は 4 象限しか見ないので `clap-host` が漏れる
- `cargo test --features outproc-effect,outproc-instrument` — lib **267 passed**
- `npm test` **2251 passed / 0 failed** / `typecheck:e2e` / `lint` exit 0 / `docs:check` **926 verified 0 failed**

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

## 2026-09-04: PR #724 追従 — dev 学習サイトをハーネス仕様の改訂に合わせる

**#724（#668 PR-E0）が `docs/testing/E2E_HARNESS_SPEC.md` を改訂した結果、dev 学習サイトの
記述と参照行が古くなった**ので、doc 側だけを追従させた。コード・テストは変更していない。

### 1. IV-3 章の「配線 smoke を置き換える計画」が失効した

`sites/dev/editor/mcp-and-gated-e2e.md` の「次の深掘り候補」に
「2 層構造が gated spec の『配線 smoke』をどう置き換える計画か」という項目が残っていた。
#724 はまさにその記述を削り、**2 層の役割を入れ替えた**（オフライン層 = 回帰の固定 /
実機層 = 語彙・構文表面の網羅）ので、この項目は問いとして成立しなくなった。

- ラチェットの節の末尾に `### ハーネス仕様が実装に追いついた（2026-09-04・#724）` を追加し、
  新旧の役割分担を表で示した。根拠は同章が既に書いていること — **ラチェットが数えているのは
  `readGatedSources()` 経由の実機 spec の語**である
- 「次の深掘り候補」は、#724 §2.1 が残した未決（台帳 2 が #671 段階 3 で導出に変わったあと
  手書き行とラチェットがどうなるか）へ差し替えた
- ja / en 両方を更新。frontmatter の `verified-against` を `c2010db`・`verified-at` を
  `2026-09-04` へ

### 2. 核仕様の行番号が +21 ずれた

#724 は `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` §10 に 21 行を挿入した（`### 🔴 DSL を足したら
E2E も足す`）。`// FILE:START-END` 形式の引用は #724 自身が再アンカーしているが、
**Sources 節の散文の行参照は機械検査の対象外**なので取り残されていた。

| 参照元 | 旧 | 新 | 備考 |
|---|---|---|---|
| `sites/dev/signal-chain/mixer-audio-line.md:885` / en:910 | `1616-1706` | `1667-1757` | Mixer / Routing（MX.1〜MX.5） |
| 同 `:886` / en:911 | `1247-1249` | `1298-1300` | master gain ramp が insert の前 |
| `sites/dev/decisions/adr-002-dsl-v3-pivot.md:279` / en:279 | `1933-1990` | `1983-2035` | §13 Versioning + Migration Notes |
| 同 `:280` / en:280 | `467-601` | `496-631` | §7 underscore prefix |
| 同 `:281` / en:281 | `336-432` | `365-462` | §5 片記号方式 |

🔴 **上表のうち #724 起因のずれは +21 のみ。** 実測すると 5 件とも #724 以前から
31〜35 行ずれており（base `89d6e26` で `1616` は Mixer 節ではなく PC 節の中だった）、
**散文の行参照には機械検査が無い**ことがそのまま残存していた。今回は行番号を足すのではなく、
各行の説明文が名指ししている節の実位置へ**再アンカー**した。


> **これはアーカイブです**（`docs/core/PROJECT_RULES.md` §1a）。
> 現行の作業ログは [`docs/development/WORK_LOG.md`](../development/WORK_LOG.md) にあります。
>
> **収録期間**: 2026-09-01 〜 2026-09-04
> **アーカイブ理由**: 本体が 2,000 行の上限（`tests/docs/worklog-size.spec.ts` が強制）を超えたため。
> **注意**: 番号付きの節（`6.4xx`）は他文書からの参照を壊さないよう**番号のまま**移してあります。

---

### fix(engine): hold the RUN tail timer and align its origin (#606 PR-K-A1) (Sep 4, 2026)

**Issue**: #606 / **ブランチ**: `606-run-termination-noteoff` / **PR-K-A1**（修正部分）

同ブランチの守りのテスト（`run-termination-noteoff.spec.ts`）に続けて、
計画 `IMPLEMENTATION_PLAN_2026-09.md:126` が定める **H1 / H2 の修正**を入れた。
守りのテストだけでは #606 の must-fix は閉じない（鎖は既にあったが、
その鎖を駆動するタイマ自体が 2 つの欠陥を持っていた）。

## 直した 2 つの欠陥

### H2 — 終端タイマの原点が 100 ms ずれていた

イベントは `scheduleTime = currentTime + 100` を原点に積むのに、自動停止タイマは
**「今」から `patternDuration`** で測っていた（`run-sequence.ts`）。停止が約 100 ms 早く来るので、
パターン末尾の note が鳴り切る前に `clearSequenceEventsFn` が走る。

`tailDelay = patternDuration + (scheduleTime - currentTime)` に揃えた。
🔴 **マジックナンバー 100 を 2 箇所に書かない** — `scheduleTime` から導いている。

### H1 — `setTimeout` のハンドルを捨てていた

キャンセルできないので、`RUN()` を再度呼ぶ / `LOOP()` へ切り替える / `global.stop()` すると、
**古いタイマが後から発火して新しく始まった再生を消す**（stale timer）。

ハンドルを既存の per-sequence `StateManager` に保持し（新機構を作らない）、
`run()` / `loop()` / `stop()` の 3 経路でキャンセルする。`setRunTimerFn` は**必須引数**にして、
将来の呼び出し元がハンドルを取り落とすことを型で防いだ。

## テスト

TDD で先に書いて red を確認してから直した（実出力は PR 本文）。

| 検査 | 内容 |
|---|---|
| H2 | `patternDuration` ちょうどでは clear されず、原点ぶんを足した時刻で clear される |
| H1 | 2 回目の `RUN()` / `LOOP()` 切替 / `global.stop()` のいずれでも、1 回目のタイマが
新しい再生を消さない。**`toHaveBeenCalledTimes` と引数まで検証**する |

## 🔴 `clearRunTimer` の分類（main が追加）

`private clearRunTimer()` を足したところ `signal-chain-dispatch.spec.ts` が red になった。
**TypeScript の `private` は実行時に残らない**ので、公開メソッド分類器からは未分類に見える。
内部 API リストへ追加した。

ただし **除外リストへの追加は「主張」にすぎない**（CLAUDE.md が #528 で名指しした事故は
「DSL 語彙であるべきものを除外リストへ誤分類し、テストは緑・実行時だけ壊れる」型）。
そこで**逆向きの実証**を 1 本足した — `kick.clearRunTimer()` が
`Unknown chain method` で弾かれること。**変異検証済み**:
`SEQUENCE_DSL_METHODS` に `clearRunTimer` を足すとこのテストが red になる。

## 検証

`npm test` **2220 passed / 52 skipped / 0 failed**（sandbox 外・main が実行）。
lint / `tsc --noEmit` ともに exit 0。

⚠️ 委譲先（Codex）は sandbox で全件を回せず `tests/core` の緑までしか確認できていなかった。
**上記 1 件の red は main が sandbox 外で回して初めて出た** — CLAUDE.md
「委譲先の green 報告は必ず main が回し直す」の実例がまた 1 件増えた。

---

### test(engine): pin the RUN-termination note-off release (#606 PR-K-A1) (Sep 4, 2026)

**Issue**: #606 / **ブランチ**: `606-run-termination-noteoff` / **PR-K-A1**

#### 🔴 実装は既にあった。足したのは「守り」である

着手前に実装を読んだところ、**発火点も配送機構も揃っていた**
（[[invent-rules-only-after-reading-the-code]] のとおり、規則を発明する前に読む）:

| 層 | 場所 |
|---|---|
| RUN 終端の発火 | `run-sequence.ts:60-63` の `setTimeout(… clearSequenceEventsFn(name) …, patternDuration)` |
| 経路の振り分け | `sequence.ts:1015-1023` `clearEvents()` → MIDI / instrument なら `clearOwner(name)` |
| 実際の note-off | `midi-scheduler.ts:211-214` `clearOwner()` が **`output.releaseOwner(owner)` を呼ぶ** |

つまり #606 の PR-K-A1 は「flush 機構を作る」仕事ではなかった。
地図に「配送機構は既にある・欠けているのは発火点だけ」と書いた（#731）が、
**発火点も既にあった** — さらに一段浅く見積もっていた。

#### ところが、この鎖を検査するテストが 1 本も無かった

`clearOwner()` から `releaseOwner()` の **1 行を落としても既存 2205 件は全部通る**。
**鳴りっぱなしは音にしか出ない**ので、ユニットで守らないと誰も気づけない
（[[consumerless-code-is-unprotected]]）。テスト 4 本を追加した。

#### 🔴 変異検証で穴が 1 つ見つかった（3 本 → 4 本）

| 変異 | 結果 |
|---|---|
| `releaseOwner()` の呼び出しを削除 | **2 件 red** |
| `clearOwner()` の queue フィルタを `this.queue = []`（wildcard 全消し）へ | 🔴 **当初は 3 件とも green（生き残り）** |
| queue のクリアを削除 | **1 件 red** |

**解放（`releaseOwner`）の側は owner を見ていたが、予定（queue）の側は見ていなかった。**
片翼だけ守っていたことになる（[[enumeration-stops-one-level-too-early]]）。
「終端したシーケンスの予定だけが落ちる」を検査する 1 本を足したところ、この変異も red になった。

restore 後 4 件 green・`midi-scheduler.ts` は `cmp` で復元一致。

🔴 **1 種類の変異が red になっただけで結論してはいけない**という規律が、そのまま効いた実例。

#### 粒度（#729 で明文化した条文の実装側）

守っているのは **owner 単位の解放**である。daemon 側の「最後の砦」は
**instance 単位（全 owner）**で、`global.stop()` / shutdown / engine 異常終了の 3 場面だけ。
混同すると他シーケンスの発音を巻き込むので、テストのコメントに書き分けた。

### fix(e2e): clock capture segments off the capture file and open them on sound (#739 PR-O2a) (Sep 4, 2026)

**Issue**: #739 / **ブランチ**: `739-capture-windows-follow-sound` / **PR-O2a**
**設計**: `docs/design/739-capture-clock-design.md`（起案 Fable / 審査 main）

実機 gated E2E の「名前つき区間 RMS」測定器が、**楽器が鳴る前に窓を開けていた**。
#649 PR-O2 の受け入れ（E2E-1）が緑にならない原因は engine ではなく**測定器**だった。

## 直した 2 つの欠陥

1. **固定 settle 400 ms が音より早い。** `LOOP()` の小節量子化（120 BPM 4/4 = 2000 ms）＋
   プラグイン attach で音は約 3 秒後に出る。`unity` 窓は丸ごと無音で、
   **`global.gain(-6)` は楽器が一度も鳴る前に適用されていた**（実測 half/unity = 1.36）
2. **区間マッピングが壁時計からの逆算で、黙ってクランプする。**
   `Math.max(0, durationSec - (stopWall - from)/1000)` は実長が壁時計より短いと
   **ファイル先頭を指す**。settle を 2600 ms にしたら unity が 0.0632 → **0** と悪化した
   （窓を後ろへ動かすと逆に前を測る）

## 採った形

**キャプチャファイルのバイト長を時計にする** — `(stat.size - 44) / (channels × 4) / sampleRate`。
`stopWall` からの逆算を捨てた。「音が出たか」の待ちは**いつ窓を開けてよいか**を決めるだけで、
時計には使わない（header の flush 間隔 1 秒ぶんの不定性を時計に持ち込まないため）。

新規 `tests/e2e/helpers/capture-windows.ts` に A1 / U1 / U2 / U3 を内蔵し、
**5 箇所に複製されていた逆算式**（`run-score.ts` / gated spec の 4 箇所）をすべて置き換えた。

## 🔴 前提の訂正 3 件（一次ソースで確認）

| 当初の想定 | 事実 |
|---|---|
| 複製は 2 箇所 | **5 箇所**。E2E-1 は `run-score.ts` ではなく gated spec 内の別実装を使う |
| 受け入れは「各窓のオンセット数」 | **正弦系（CLAPTestSynth）にオンセットは出ない**。`gate(1)` は note-off が次の note-on と同時刻で連続音。オンセット数は**打楽器 fixture にだけ**意味を持つ |
| √(8/7) は写像の量子化 | **guard の非対称**（`rms` は guard 0.15・`onsets` は guard 0） |

## 🔴 レビューで塞いだ穴（変異で実証）

新しい衛生規則を足したが、**走査対象が写像の新しい住所を含んでいなかった**。
`gated-sources.ts` は `orbitstudio-mcp-gated.spec.ts` と `gated/**` しか見ておらず、
本 PR が写像を移した `helpers/` は対象外だった。

| 実験 | 結果 |
|---|---|
| `capture-windows.ts` に旧逆算式を植える | **green**（見逃す） |
| 対照: 走査対象のファイルに同じ変異 | **red**（規則自体は機能する） |
| `helpers/` を走査範囲に足して再実行 | **red**・違反行を名指し |
| 変異なしで hygiene + coverage | 16 件 green（巻き添えなし） |

🔴 **`gated-sources.ts` 自身の冒頭がこの失敗モードを予告していた** —
「シナリオを別ファイルへ出した瞬間に**衛生検査が新ファイルを見ず、黙って弱くなる**。
red にならないぶん危険で、検査が効いていないことに気づけない」。本 PR がまさにそれをやった。

あわせて、U3（区間の単調・非重複）の例外が**区間名の文字列 `'transition'`** で
表現されていたのを `CaptureSegment.overlapsPrevious` へ移した
（汎用ヘルパーが特定テストの語彙を知っている層の逆転を解消。CLAUDE.md
「不変条件をデータの配置で強制する」）。

## 🔴 実機 gated の収束（main が sandbox 外で 5 回実測）

| ラウンド | 失敗 | 退行 | 原因 |
|---|---|---|---|
| 1 | 23/24 | — | **#747**: worktree のビルド配置が壊れエンジンが起動せず（本 PR とは無関係） |
| 2 | 19/24 | — | main の実行ミス: 存在しない `ORBIT_KEEP_CAPTURES` ディレクトリ |
| 3 | 16/24 | **6** | **時計が 2 つあった**（`stat.size` vs WAV header の申告サイズ） |
| 4 | 12/24 | **2** | **小節量子化の 2 秒**を録り幅が勘定していなかった |
| **5（最終）** | **10/24** | **0** | — |

**baseline（`main`・同一条件）は 12/24。** 最終ラウンドは**退行ゼロ**で baseline より 2 件少ない。
残る 10 件はすべて baseline から存在するもの（`#643 E2E-1〜7` ほか）で、次の PR-O2（#649）の対象。

⚠️ 「減った 2 件」はプラグイン state 復元系で、ラウンド 4 でも同じ 2 件が差分に出ている。
**本 PR が直したというより flaky の可能性が高い。** 確実に言えるのは**退行ゼロ**の方。

### ラウンド 3 で塞いだもの — 時間軸の統一

`analyzeWavBuffer` は **header が申告する data サイズを優先**する
（`wav-analysis.ts:106`・0 か範囲外のときだけ EOF まで読む）。一方 `sync_header` は固定
96,000 interleaved samples ごと（48 kHz stereo なら約 1 秒、mono なら約 2 秒）にしか
patch しない。つまり区間は「`stat.size` 時間」で刻まれ、
バケットは「header 時間」で並んでいた（実測の差は 0.256 / 0.939 / 0.299 秒）。

解析の直前に申告サイズを 0 に上書きして EOF まで読ませ、**2 つの時間軸を構成的に一致させた**
（`readCaptureForAnalysis`）。許容値を緩める直し方は採らない — 緩めると末尾の区間が
黙って解析範囲から外れる。

### ラウンド 4 で塞いだもの — 小節量子化

残った 2 件（O0-3 / O0-4）は snap のバグに見えたが、キャプチャを解析すると
**2.000 秒ちょうどの無音**が区間の頭にあった:

```
onsets 8.06 →（2.000 s の無音）→ 10.06 10.56 11.06 … 13.06
```

`LOOP()` の**小節量子化**（120 BPM 4/4 = 2000 ms）で、O0-3 / O0-4 だけが演奏中に
`send` / `effect` を足すため発生する。録り幅を `小節 + 位相 + n·P + guard + snap 余裕` の式に直した
（PR 前 4000 → 6840 ms。4800 ms はラウンド 3 途中の値）。**snap は最初の onset から厳密に
`n·P` を測るので golden の値は動かない。**

### ついでに塞いだもの

`prepareCapturePath` — capture を書く直前にディレクトリを作り、前回の残骸を消す。
ディレクトリが無いと daemon の `File::create` が失敗し、テスト側には
「daemon-backed REPL ready after 30000ms」という**無関係に見えるタイムアウト**として現れる
（ラウンド 2 でこれに実機 1 回分を費やした）。変異検証済み。

## 検証

`npm test` **2226 passed / 52 skipped / 0 failed**（sandbox 外・main が実行）。
`typecheck:e2e` / lint ともに exit 0。`check-citations` **926 verified / 0 failed**
（本 PR で `tests/` の行が動いたため 12 箇所を再アンカーし、`captureInstrumentScenario` から
`capture-windows.ts` へ移動した引用を貼り直し、**逆算を説明していた本文も現状に合わせた**）。

---

### fix(studio): declare untrusted-workspace capability (#385 PR-S-T1) (Sep 4, 2026)

**Issue**: #385 / **ブランチ**: `385-untrusted-workspace-capability` / **PR-S-T1**

フォルダ無しの loose-file 起動（`orbs file.orbs`）は**未信頼の ad-hoc workspace** を作る。
`capabilities.untrustedWorkspaces` を宣言していない拡張はそこで activate されず、
利用者には「何も起きない」ようにしか見える。**実害は拒否ではなく沈黙**である。

owner 裁定（`docs/design/656-release-design.md` §16 (1)・2026-09-03）は **`supported: true`**
「一般的な DAW の挙動に併せて」。`"limited"` は撤回済みなので `startEngine()` に trust ガードは置かない。

#### 🔴 レビューで自分のテストが「何も証明していない」と分かった（2 段階）

**① ユニット側**: `restrictedConfigurations` を `?? []` でフォールバックしていたため、
**宣言が丸ごと消えても `for...of []` が 0 周して green** になっていた。
フォールバックを外し、取り出せない形なら**その場で落とす**ようにした。変異で実証:

| 変異 | 旧 | 新 |
|---|---|---|
| `restrictedConfigurations` を削除 | 2 件**素通り** | **3 件 red** |
| `audioDevice` を restricted に追加 | — | **2 件 red** |
| `supported: false` | — | **1 件 red** |

restore 後 6 件 green・`package.json` は `cmp` で復元一致。

**② E2E 側（本 PR では出さない・**#735** へ切り出し）**: 正本計画は PR-S-T1 に
**E2E-D1（実機）**を課している。書いて実機で回したところ **dev モードでは緑になったが、
`capabilities` ブロックを丸ごと削除しても緑のまま**だった。
🔴 **`--extensionDevelopmentPath` は workspace trust の制限を迂回する**ためで、
設計が `ORBIT_GATED_EXT_MODE=installed` を要求していた理由が実験で裏付けられた。

installed モード（vsix を焼いて `--install-extension`）に切り替えると、
**導入は成功するのに拡張が activate しない**（trust を無効にしても同じなので trust は原因ではない）。
ここは #385 の症状とは別の観測性の問題なので **#735** へ切り出した。6 実験の結果はそちらに残してある。

**副産物**: `orbs --install-extension` は**失敗しても exit 0 を返す**（壊れた vsix で
「Failed Installing Extensions」を出しながら 0）。exit code で判定してはいけない。

#### 🔴 地図だけでなく設計と実装プランにも反映した（owner 指摘）

> 地図だけでなく設計と実装プランにも反映してあるかな？？

最初は `DEVELOPMENT_MAP.md` §4.J しか直しておらず、**この PR 自身が #727 で直したばかりの型**
（規範を変えたのに写しが古い）を繰り返すところだった。3 文書を揃えた:

| 文書 | 直した内容 |
|---|---|
| `DEVELOPMENT_MAP.md` §4.J | #385（宣言・✅ 済）と **#735（実機検証・未着手）**の 2 行に分離。#735 は **#659 の後** |
| `656-release-design.md` §12 | **E2E-D1 の期待値を反転**（`running: true` / 音が出る / `not trusted` は 0 行）。**E2E-D2 は取り消し線 + 理由**（裁定 (1) で trust の有無が挙動を変えなくなり D1 と同判定になるため）。**§12.1 を新設**して 6 実験の結果と「成果物なしで成立する」の訂正を記録 |
| `IMPLEMENTATION_PLAN_2026-09.md` §1.9 | PR-S-T1 の件名から **`and refuse loudly` を削除**・`extension.ts` を触るファイルから除外（裁定 (1) で trust ガードが不要になり「断る」対象が無い）。実機 E2E を **PR-S-T3（#735）**として新規行に分離 |

**「issue を立てた」だけでは追跡されない。** 地図は所在、設計は判定条件、計画は工数と順序を持つので、
1 つでも古いままだと次の起案者がそこを読んで誤る。

#### reuse: マニフェスト読み取りを共有ヘルパーへ

`playhead.spec.ts:211` が既に同じ `package.json` を**別の書き方**（`new URL(…, import.meta.url)`）で
読んでいた。`tests/helpers/vscode-extension-manifest.ts` を新設し、**両方をそこへ寄せた**
（新設だけして重複を残すと 1 箇所が 3 箇所になる）。`playhead.spec.ts` 33 件は通ったまま。

#### 検証

`npm run typecheck:e2e` 0 / `tests/vscode-extension/` **430 passed** / lint 0。

---

### docs(planning): schedule the capture-window fix as PR-O2a (#739) (Sep 4, 2026)

**Issue**: #739 / owner 相談 2026-09-04「**忘れてしまうことだけは避けたい**」

PR-O2 の実機検証で見つけた**測定器そのものの欠陥**を、予定に組み込んだ。

#### 何が壊れていたか

`captureSegment` の既定は **settle 400 ms**（`run-score.ts:272`）。ところが
`LOOP()` の**小節量子化**（120 BPM 4/4 = 2000 ms）＋ **プラグインの attach 時間**で、
**音が出るのは約 3 秒後**。キャプチャの時系列 RMS を直接見て確定した:

```
0.00–3.00s  0.0000   ← 完全な無音
3.00s       0.1195   ← ここで初めて音が出る
3.75–5.00s  0.0886   ← 定常
```

🔴 **`global.gain(-6)` は楽器が一度も音を出す前に適用されていた。**
`unity` 窓は丸ごと無音・`half` 窓だけが実音 → **E2E-1 は「0 dB の音」を一度も測っていない**。
比が 1.36（下げたのに大きい）になり、**engine の欠陥に見えていた**。

#### 🔴 固定値で追いかける修正は反証済み

settle を 400 → 2600 ms にしたら unity が **0.0632 → 0** と**悪化**した。
区間が**キャプチャ末尾からの逆算**なので、実長が壁時計より短いと `fromSec` が負 → 0 クランプ →
**ファイル先頭（まだ鳴っていない区間）**を指す。**窓を後ろへ動かすと逆に前を測る。**

#### いつやるか — **PR-O2 の直前**（縦依存を伸ばす）

`PR-O1 → PR-O0 → **PR-O2a（#739）** → PR-O2`

| 理由 | |
|---|---|
| **循環しない** | 受け入れを「**窓に入るオンセット数**」にすれば、instrument が鳴っていなくても判定できる。「E2E-1 が緑」を受け入れにしない |
| **PR-O0 → PR-O2 と同じ規律** | 段 1 は「golden で固定してから engine を変える」。今回も**測定器を直してから測る** |
| **段 2 前でないと高くつく** | 影響は gated spec の **34 箇所**。段 2 の束は全部この窓で assert するので、計器が不確かなまま始めると全測定を疑い直すことになる |

#### 記録先

| 文書 | 内容 |
|---|---|
| **#739** | 実測データ・反証した修正・実装チェックリスト |
| `DEVELOPMENT_MAP.md` §4.A | 「測定器」の行を #649 の**上**に置いた（順序が読める形） |
| `IMPLEMENTATION_PLAN_2026-09.md` §1.1 | **PR-O2a** を PR-O2 の直前に挿入 |

---

### docs(site): follow PR #727's output-line spec revision into the user site and SC-2 (Sep 4, 2026)

**追従元**: PR [#727](https://github.com/signalcompose/orbitscore/pull/727)（`611-output-line-spec` → main・マージコミット `d8191d1`）/ **ブランチ**: `claude/docs-sync-pr727`

#727 は spec だけを動かした docs-only PR で、`sites/dev/signal-chain/` の 2 章（日英）は
同じ PR の中で追従済みだった。**追従が漏れていたのは「ユーザーが書く語」の側**である。

#### 直したもの

| 場所 | 追従した規範 |
|---|---|
| `sites/user/mixing/routing.md`（日英） | MX.3: `send()` の第 2 引数が **dB になる**（`0.3` → +0.3 dB のサイレント変更）/ MX.5 から「post-fader 固定」が**削除**され、タップ位置は「書いた位置」になった |
| `sites/user/reference/methods.md`（日英） | 同上 + MX.2.3: **数値レンダーバス `seq.output(n)` は撤回**された |
| `sites/dev/signal-chain/mixer-audio-line.md`（日英） | 「`seq.output()` の 3 分岐」節に MX.2.3（数値分岐の撤回）と MX.2.1（LinkAudio は解決順の**最後**）の注記 |
| `sites/dev/decisions/adr-002-dsl-v3-pivot.md`（日英） | core spec への行番号引用 2 件を再アンカー（`1933-1990` → `2112-2164`・`467-601` → `496-631`） |

🔴 **実装は 1 行も変わっていない**ので、user site の表と本文は**今日の書き方のまま**にして、
「仕様は変わったが未実装」という注記を足す形にした。表を到達点で書き換えると、
読者が今日書けないコードを読むことになる。

🔴 **`send` の単位変更はエラーにならず音だけが変わる**（線形 0.3 → +0.3 dB ≒ 素通し）。
user site の両言語に `danger` ブロックで明示した。

#### 再アンカーについての但し書き

adr-002 の 2 件は **#727 以前から既にずれていた**（§13 Versioning は #727 前も 1983 行目で、
引用は 1933-1990 だった）。#727 が core spec を +63 行伸ばしてずれが広がったので、
この機会に両方を現在の節境界へ合わせた。3 件目の `336-432`（§5 = 315-468）は
節の内側の抜粋なので触っていない。

#### 検証

`npm ci` / `npm run docs:build -w @orbitscore/user-site` / `npm run docs:build -w @orbitscore/dev-site` /
`npm run docs:check` の 4 本すべて green（citation 922 件検証・0 failed）。

### fix(engine): contain the two playback-path throws (#645 PR-D0) (Sep 4, 2026)

**Issue**: #645 / **ブランチ**: `645-contain-playback-throws` / **PR-D0**

`LOOP()` 経路の throw 2 箇所を封じ、スキップをログに出す。ライブ中に kick が止まる実害の修正。
実装は `sequence.ts` の `DispatchTarget = hardware | link | skip` の tagged union +
`resolveDispatchChannel()`（throw しない）+ `logSkipOnce`。ユニット **13 本**。

#### 🔴 「ログ行が一切出ない」は誤りだった（実機 4 サイクル分の記録を訂正）

前回までの記録は「`d645Skip` のログ行が**一行も出ない**」としていた。診断を出して実測したところ、
**出ていた**:

```
… このシーケンスは無音でスキップします。      ← ✅ skip は記録されている
🔄 d645Skip (loop queued, +1998ms to next quantize boundary)
⏹ d645Skip (loop stopped)                      ← 停止する
🎚️ d645Live: gain=-3 dB (seamless)             ← ✅ 兄弟は生きている
```

**PR-D0 が守るべき性質は 3 つとも満たされている**:

| 性質 | 実測 |
|---|---|
| skip が黙って消えない | ✅ 「無音でスキップします」がログに出る |
| throw しない | ✅ 同一ブロックの `d645Live` が自分の `(seamless)` を出している |
| 兄弟を巻き添えにしない | ✅ 同上 |

🔴 **「ログが出ない」と 4 サイクル書き続けたのは、診断を出さずに症状だけを見ていたから。**
[[escalation-does-not-fix-opacity]] のとおり、見えない時は観測手段を先に作る。

#### 落ちていたのは**テストの主張が実装の契約を超えていた**箇所（→ #736）

| # | 主張 | 実装の契約 |
|---|---|---|
| 1 | 停止中の `d645Skip` にも `(seamless)` が出る | `seamlessParameterUpdate()` は `isLooping() \|\| isPlaying()` **かつ** `scheduler.isRunning && loopStartTime !== undefined` の時だけ出す（`sequence.ts:278-281`）。**停止中は出ない** |
| 2 | dedup を **ERROR 総数**で数える | skip は **stderr → ERROR に分類される**（#625 で 4 回再発した系譜）ので**他の ERROR が混ざり、dedup の証明にならない**。数えるなら skip メッセージの出現回数 |

**実機 gated は #736 へ分離**（owner 裁定 2026-09-04）。外した理由を spec 内のコメントに残したので、
次に読む人が「E2E を書き忘れた」と誤読しない。

#### 3 文書に反映

| 文書 | 内容 |
|---|---|
| `DEVELOPMENT_MAP.md` §4.A | #645（実装・✅）と **#736（実機 E2E の主張・未解決）**の 2 行に分離 |
| `IMPLEMENTATION_PLAN_2026-09.md` §1.7 | PR-D0 の検証列を「ユニット 13 本」に。**PR-D1（#736）**を新規行に |

#### 検証

`npm test` **2205 passed** / `npm run typecheck:e2e` 0 / lint 0 /
`check-citations` 922 verified 0 failed。

---

### docs(spec): fix the implicit-master condition found by the independent re-audit (Sep 4, 2026)

**Issue**: #611 / **ブランチ**: `611-output-line-spec` / **PR-O1**（段 1 の縦依存 1 本目）

修正コミット後の最終状態だけを**独立に**再監査させた（前回の監査結果は渡していない）。
**Critical が 1 件出た** — 1 回目の監査が見ていなかったものである。

#### 🔴 Critical: send を書くと本流が master へ届かない条件になっていた

仕様の 2 箇所が、単独では正しいのに**組み合わせると壊れる**形になっていた:

| 場所 | 記述 |
|---|---|
| MX.2 | ラインに **`output` が 1 つも無い** sequence に暗黙の `output(master, thru:false, db:0)` を付ける |
| MX.3 | **`send` は `output(aux, thru: true, db:)` の糖衣**である |

`kick.send(verb, -12)` **だけ**を書いた行は、後者により「`output` が 1 つ存在する」ので
**暗黙 master が付かない**。`thru: true` の出口は分岐であって終端ではないから、
**dry がどこにも行き着かない** — センドを挿した瞬間に本流が消える。
MX.3 の実例そのものがこの 1 行だった。

正しい条件は「**`thru: false` の `output`（＝終端）が 1 つも無い**」。
設計 611 §2.6 の既定ストリップが
`[ラック → gain → pan → sends(=output thru) → output(master)]` と
**sends と終端を別々に並べている**のが意図の正本で、条件の側が書き間違っていた。
core spec MX.2 / 設計 611 §2.1 / 同 §3.4 の 3 箇所を揃えた。

🔴 **糖衣を定義したら、その糖衣が既存の条件式に何を代入するかを確かめる。**
「`send` は `output` の糖衣」と「`output` が無ければ master」は、
どちらも単独では正しく、**並べた時にだけ壊れる**。

#### 併せて直した 4 件（いずれも「規範を変えたのに写しが古い」型）

| # | 場所 | 内容 |
|---|---|---|
| 1 | `SIGNAL_CHAIN_DSL_SPEC_v1.md:30,144-145` | **同一ファイル内**のコード例が「宣言層・後勝ち」のまま。直下の規範 (2) は「信号層・2 要素として加算」に書き換え済みで、例と規範が逆を言っていた |
| 2 | `sites/dev/signal-chain/index.md`（日英） | 二層意味論の表が旧版のまま（gain / pan / 出力先を宣言層に置いていた）。`mixer-audio-line.md` は両言語で直したのに、**同じ章の index が漏れた**。🔴 `check-citations` はコードフェンス引用しか見ないので、**散文の陳腐化は機械では捕まらない** |
| 3 | `docs/design/610-diagnostics-applicability-design.md:455,463,611` | 「`output(<aux 名>)` は Error」と owner 裁定 ③（**aux も `output` で指せる**）が**正反対**。特に **E2E-D6 は期待値が仕様と逆**で、そのまま実装すると誤ったテストが資産に積まれるところだった |
| 4 | `docs/design/611-output-line-design.md:248,276` | §14 (1) で「数値 render bus は撤回」と裁定したのに、§3.3 手順 5 が「裁定まで現状の `_renderBus` 互換」のまま残っていた（自分の裁定に自分が追従していない） |

#### 独立再監査の価値（記録）

1 回目の監査後に修正を入れ、**その結果だけを見せて**別個体に監査させたところ、
1 回目が見ていなかった Critical が出た。**同じ差分を 2 回見るのではなく、
修正後の状態を新しい目で見る**ことに意味があった。

#### 検証

`check-citations.mjs` 922 verified / 0 failed（行番号のずれを `--fix` で再アンカー・4 件）。

---

### docs(spec): output as a line element — MX.1/2/2.1/2.2/2.3/3/4/5, SC.2.1/4, #649 §10-12 (Sep 4, 2026)

**Issue**: #611（+ #649 / #643 の設計文書追従）/ **ブランチ**: `611-output-line-spec` / **PR-O1**（段 1 の前提・docs のみ）

段 1（must-fix）の縦依存 `PR-O1（spec）→ PR-O0（golden）→ PR-O2（engine）` の 1 本目。
**仕様を先に確定させてから golden を取り、その後にエンジンの内部を変える**という順序を守るための PR。
コード・テストは 1 行も変更していない。

#### 改訂（`docs/design/611-output-line-design.md` §11 の表がスコープ）

| 文書 | 箇所 | 内容 |
|---|---|---|
| `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` | 節ヘッダ / MX.1 | 固定トポロジ（source → insert → sum → master ＋ send → aux の並列タップ）を撤回し、**ラインは 4 種の要素の列**（ラック / ゲイン / パン / 出口）と定義。「フェーダーという段は存在しない」を明記 |
| 同 | **MX.2**（全面改稿）| `output(destination, thru:, db:)`。`thru:` 既定 `false`・`db:` は dB・出口はラインの 1 要素であって終端ではない |
| 同 | **MX.2.1**（新）| 宛先の集合（master / sum / aux / 物理 ch 対 / render / LinkAudio）と**名前解決の順序**。`"master"` 予約語 |
| 同 | **MX.2.2**（新）| 複数 `output` と合算規則（解決後の宛先が同じなら加算・同一宛先 2 回は 2 要素） |
| 同 | **MX.2.3**（旧 MX.2.1 を置換）| 数値 render bus `output(n)` の**撤回**（裁定 611 §14 (1) = A）。宛先は `mix.render(...)` の宣言ノード。`mix.output(3)` は物理アウト mono 宛て |
| 同 | MX.3 | `send(name, db)`。**単位を線形 `amount` から dB へ**・`output(aux, thru: true, db:)` の糖衣であることを明記・「post-fader 固定」を削除 |
| 同 | MX.4 | 固定トポロジの記述を **forward-only + 配列順 = トポロジカル順**へ。kind による制限（sum→sum 等）を設けない |
| 同 | MX.5 | v1 制約から「send は post-fader 固定」を削除 |
| 同 | §8.1.2 | 🔴 `output("master")` は **LinkAudio channel 名にならない**（予約語が解決順の先頭）ことを追記 |
| `docs/specs-v2/SIGNAL_CHAIN_DSL_SPEC_v1.md` | SC.2.1 規範 (4)(7) | **出力エンドポイントと master もレシーバ**（`master.output(cue, thru: true)`）。`master` 予約が `output()` の文字列宛先にも及ぶ |
| 同 | SC.4 規範 (1) + staging 注記 | aux 名メソッドの値は **dB**。`send` は `thru: true` の出口の糖衣。「v1 は post-insert 固定」注記を #611 PR-O3/O4 の staging へ差し替え |
| `docs/design/649-audio-line-design.md` | §7.3 / §10 / §10.1 / §10.4 / §11 / §12 | **§10〜§12 は 611 設計へ移管**（バナー）。各項に「611 での扱い（正本）」を併記 |
| `docs/design/643-mixer-foundation-design.md` | §1.5 / §12 | 出口の欠落が #611 で埋まったことを追記。`output()` 3 分岐は解決順 1 本に統合された |

#### 🔴 設計文書の内部矛盾を 1 件解消（doc 611）

§1 と §2.6 が「`pan` は発音側のまま」と書いたままだったが、**§2.4b と §14 (4) の owner 裁定（Q-611-4 = B）で
`pan` はライン要素に覆っていた**。起案時の記述が裁定に追従していなかったもので、裁定側に揃えた
（ライン要素は 3 種ではなく **4 種**）。PR-O4 の実装者がここを読んで誤るのを防ぐため。

#### dev 学習サイトの追従（同 PR に畳んだ）

`sites/dev/signal-chain/mixer-audio-line.md` と `sites/dev/en/signal-chain/mixer-audio-line.md` が
**core spec の実例ブロックを逐語引用**していたため、`check-citations.mjs` が 4 件 red になった。

- 引用の再アンカー（`:1681-1685` → `:1729-1733` / `:1733-1735` → `:1793-1795`）
- **中身が変わった引用は手で直した**: `kick.send("rev", 0.3)` → `kick.send(verb, -12)`
- 散文の事実誤りを訂正: 「MX.5 は send は post-fader 固定を明記しています」は**もう spec に無い**。
  ⚠️ **実装は今も post-insert 固定**なので、「spec は変わったが実装は PR-O4 まで変わらない」ことを
  両ページに明示した（引用検査は散文を見ないので、ここは人が見るしかない）

**spec 側で宣言形の実例を復元**した（改稿で `global.sum("drum")` の例が落ちていた）。
素朴な 1 ファイル経路（ノード変数を作らない書き方）の保護は恒久方針なので、実例は仕様に要る。

#### user 学習サイトは変更しない

`sites/user/mixing/routing.md` の「send は post-fader 固定です」は**現在の実装の事実**であり、
挙動が変わるのは PR-O4。user docs は「今できること」を書く場所なので、そこで追従させる。

#### Fable 監査（独立第二意見）で Important 4 件・Medium 2 件を修正

監査は「① §11 改訂表の不在証明 ② owner 裁定との整合 ③ 実装との乖離の表示」の 3 問。
**指摘はすべて main が一次ソースで裏取りしてから直した**（エージェントの報告を鵜呑みにしない）。

| # | 指摘 | 裏取り | 対処 |
|---|---|---|---|
| 1 | 「sum ネスト不可」（MX.2.2 / MX.5）が MX.4「kind で制限しない」と真逆 | `engine_wrap.rs:5809-5813` に kind 検証が実在し、**コメントが MX.4 を出典として引用**していた | 規範（到達点）と v1 制約（今日）を**併記**。MX.4 に現在地注記を追加 |
| 2 | **SC.1 の二層意味論が MX.1 と正反対**（`gain` / `pan` / 出力先が宣言層・可換・後勝ち）。SC.4 (2) も「後勝ち」 | 差分を読んで確認。doc 611 §11 の改訂表に **SC.1 が入っていなかった**（列挙漏れ） | SC.1 の表と規範 (2) を書き換え、`gain` / `pan` / 出口を**信号層**へ。SC.4 (2) も追従 |
| 3 | 🔴 「`output("master")` は実装済み」という現在地注記が**誤り** | `sequence.ts:405-413` は sum にも render にも一致しない名前を **LinkAudio channel として記録**する。既存契約 `tests/core/sequence-output.spec.ts:167-179` を実行して確認（27 passed） | 予約語が実在するのは **wire（`SetBusRouting`）だけ**で、DSL 側で届くのは `.master` 糖衣のみ、と書き直した |
| 4 | MX.2.1 の「sum への出力先指定を**解除**して master へ戻す」は旧 `SetBusRouting` の部分適用の意味論で、MX.2.2「2 要素として両方加算」と矛盾 | `engine_wrap.rs:5766-5771` が部分適用（三状態）の出典 | 規範は「宛先 master へ解決」に統一し、「解除」は v1 の現在地へ隔離 |
| 5 | mono マージ係数 `(L + R) * 0.5` は **owner 裁定に無い**（裁定は「片側を捨てずマージ」まで） | doc 611 §14 (5) の原文を確認 | 規範表から係数を外し、設計文書（611 §5.3）へ委ねた |
| 6 | MX.2.3「撤回」に現在地注記が無く「今は数値形が拒否される」と誤読しうる | `sequence.ts:373-400` は `output(1)` を**受理して記録**する。`runtime.ts:245-250` は `mix.output(3)` を throw | 現在地注記を追加。追従していない 2 文書（PH 節の表・`MULTICHANNEL_RENDERING_DESIGN_598.md` §4.4）は **PR-R0** の担当として明記 |

Low の指摘（`gain` / `pan` 節が未追従・`_line` という TS の private 識別子が規範文に露出・
SC.0 の `.verb(0.3)` が dB 化後は「+0.3 dB ≒ 素通し」の例になる・SC.7 の「send の amount」・
`:1309` の「pre/post-fader tap」・doc 611 §0 裁定 4 の参照先誤記）も同時に処理した。

**レビュー方法**: 監査の推奨に従い `/code:pr-review-team` のフル編成は回さない
（差分にコードが無く、Sonnet チームの強み = 変異実走・実行接地が**実行対象を持たない**。
本 PR の失敗クラスは「spec と spec の不整合」「現在地注記の誤り」で、いずれも**差分に無いもの**を
読んで初めて見える）。plan §1.1 も PR-O1 の検証を「docs のみ（advisor レビュー）」と定めている。

#### 実機 gated baseline を実測（段 1 の受け入れ判定の起点）

**`npm run test:e2e:gated` → 10 failed / 10 passed (20)**・355.89s。

🔴 **WORK_LOG #713 の baseline（11 failed）から 1 件減っている** —
`auto-records and restores all five plugin receiver kinds across a restart without explicit saves`
が段 0 の束（#722）のマージで **failed → passed** になった。
したがって**本セッションの baseline は 10 failed** であり、#713 の値をそのまま使ってはいけない。

失敗 10 件（段 1 が減らす対象）: `drives real OrbitStudio end-to-end` /
**#643 E2E-1〜E2E-7**（7 件）/ `steps the live playhead through an instrument() sequence` /
`replaces a playing instrument across CLAP/VST3 (#618 E1-E6)`。

**この PR は docs のみなので、この 10 件を 1 件も動かさない**（動かすのは PR-O2 から）。

#### WORK_LOG のローテーション（本 PR の副産物）

本節を足したことで WORK_LOG が **2009 行**になり、`tests/docs/worklog-size.spec.ts`
（PROJECT_RULES §1a・上限 2000 行）が red になった。**閾値は上げずにアーカイブした**:
2026-09-01〜09-02 の 9 節（389 行）を `docs/archive/WORK_LOG_2026-09.md` へ移し、
本体末尾の索引と `docs/core/INDEX.md` の「Archived WORK_LOG」表の**両方**を更新した
（§1a の注記どおり、テストが突合するのは本体末尾の索引だけで INDEX.md は検査されない）。
番号付きの節（`6.423`〜`6.429`）は他文書からの参照を壊さないよう**番号のまま**移した。

#### 検証

| ゲート | 結果 |
|---|---|
| `npm test` | **2196 passed** / 48 skipped（main と同数・docs のみなので不変が期待値） |
| `npm run typecheck:e2e` | エラー 0 |
| `check-citations.mjs` | **922 verified / 0 failed**（監査対応で行番号が再び動いたので再アンカー） |

実機 E2E は**このPRの対象外**（コード変更が無く、DSL の観測可能な表面を 1 つも足していない）。
段 1 で実機の判定が変わるのは PR-O2 から。

---

### test(e2e): capture goldens for existing scores (#543-a) (Sep 4, 2026)

**Issue**: #543 (a) / **ブランチ**: `543-output-line-goldens` / **PR-O0**（段 1 の縦依存 2 本目）

PR-O2 が engine の内部幅と master gain の位置を変える**前**に、
`docs/design/611-output-line-design.md` §9 の「今日の音」を実機 capture で固定する。
production code は 1 行も変更していない。

実装は Codex（`gpt-5.6-sol` / effort high）に委譲し、**測定と検証は main が実機で**行った
（sandbox では daemon・MCP・実機 E2E が原理的に走らないため）。

#### 🔴 実機で 3 件の問題が出て、いずれも「主張をテストの実力に合わせる」方向で解決した

##### 1. ハーネスの起動判定が 500 行窓で壊れていた（helper の潜在不具合）

O0-3 / O0-4 が `daemon-backed REPL ready after 30000ms` で落ちた。engine は起動していた。
原因は `run-score.ts` が **`get_log` の固定 500 行窓の中でマーカー件数の増加**を見ていたこと。
窓が飽和すると新しい行を足しても**古いマーカーが同時に押し出される**ので件数が増えない。
**ERROR 件数を厳密等価で見ない規律と同じ理由**である。段 0 の helper に消費者が付いて初めて露見した。

修正: **`start_engine` 直前のログ末尾を錨**にし、その後ろに出た分だけを見る。

🔴 **一度「錨が流れたら判定できないとして待つ」形にしたのは誤りで `#628 R28` を壊した。**
錨は前の窓の**末尾**から取り、窓は**先頭から**落ちるので、末尾が消えているならそれより古い行は
すべて消えている — つまり今の窓は全部が新しい出力である。**実機に出さなければ気づかなかった。**
`helpers.spec.ts` にテスト 6 本。「錨を完全に無視する」変異で 2 本 red・restore 一致を確認した。

##### 2. fixture のバス名が既存テストと衝突していた

gated スイートは**同じ engine セッションを使い回す**ので、`global.sum("drum")` が既存テスト
（`:1955-1956` が `drum` を **sum と aux の両方**で宣言）と衝突して「ambiguous」になる。
**衝突したまま録ると、音が意図した宛先へ行かないのに golden が録れてしまう。**
`o0sum611` / `o0rev611` へ改名した。

##### 3. 🔴 最初の測定は「音量」ではなく「窓に入ったヒット数」を測っていた

**当初「設計 §9 の期待式が実機と合わなかった」と結論したが、誤りだった**（Fable 監査で判明）。
`LOOP()` は既定で**次の小節境界まで待つ**（`quantize-manager.ts:70`・120 BPM 4/4 で 2000 ms）のに、
録り始めが `run_selection` の **500 ms 後**だったので、**窓の大半が発音前の無音**だった。
入るヒット数が窓ごとに違い（dry 3 発 / total 5 発）、その差を engine の性質だと読み違えた。
検算: `kick.wav`（エネルギー 0.00757189）から、当初の 4 つの golden はすべて
`sqrt(整数ヒット数 × 0.00378595 / 窓長)` と**有効 7 桁で一致**する。`send(0.3)` は線形 0.3、
`Gain(db:6)` は理論と 9 桁一致で、**どちらの式も成立していた**。

🔴 **測定手法の欠陥を engine の性質だと結論した。** 「未検証のモデルを assert しない」という方針は
正しいが、適用を誤ると**検証済みの一次ソースを「未検証」と呼ぶ**ことになる。

**直した形**: settle を 1 小節 + 余裕（2600 ms）にして定常状態で録る / 窓長を**ヒット周期の
整数倍**（500 ms × 8）にして位相依存を消す / 🔴 **`onsets(name).length` を assert** して
ヒット数を固定する（これで初めて RMS が「1 ヒットあたりの音量」になる）。

##### 4. 🔴 同じ誤りを 2 度した — 窓長のゆらぎを「`seq.gain` の系統差」と読んだ

測り方を直した後、`Gain(db: 6)` は理論と**有効 9 桁で一致**したのに `combined/dry` だけが
**1.069**（理論 1.0 から 6.9%）で、**2 回の実行が 5 桁一致**した。これを
「`seq.gain(-6)` は実は −5.42 dB」と結論しかけたが、**3 回目を回して全行の比を並べたら撤回した**。

**同じ 1.069 = √(8/7) が `noBus` にも `sumOutput` にも `effectOnly/dry` にも出る。**
窓の実効長が 1 ヒット分（500 ms / 4000 ms = 1/8）ゆらぐ測定アーチファクトで、
セグメントごとに独立に乗る。**系統差とは区別できない。**

🔴 **再現性は系統差の証拠にならない** — 測定系の量子化も再現する。系統差だと言うには
「**同じアーチファクトが他の行に出ていないこと**」の確認が要る。期待値は理論式のままにし、
許容をアーチファクトの幅（12%）に合わせた。**実測値をベタ書きすると、アーチファクトを
engine の性質として固定してしまう。** follow-up（本 PR の範囲外）: 窓を 16 発へ伸ばすか、
`runScore` の区間→capture 時刻の写像から量子化を取る。

#### `/simplify`（4 観点のレビュー → 適用）

🔴 **reuse / altitude**: `startR28Engine`（gated spec）が**同じ壊れた件数比較をローカルに再実装**して
おり、**既存 20 本すべてがこの経路を使う**。判定を錨方式へ統一し `markerCount` を削除した。
**simplification**: 動的 `import()` → 静的 import・harness を縮小 / `relativeDelta` を 1 本化。
⏭️ **スキップ**: engine 再起動 3→1 の統合（テスト単位の独立を優先）。

🔴 **`startR28Engine` はレビューの推奨と逆の判断をした。** altitude は現状維持を支持したが、
その理由は「**最初の消費者が付く時に寄せる**」であり、**その消費者が本 PR で付いた**。
当時は両方とも壊れていたが、いまは**片方だけ直っている**。見送られたのは「約 60 行の統合」で、
ここで直したのは**判定ロジックだけ**（構造は動かしていない）。

#### 検証（すべて main が実機で）

`npm test` **2202 passed** / 52 skipped ・ `typecheck:e2e` 0 ・ `lint` 0 ・
`check-citations.mjs` **922 verified / 0 failed** ・ **実機 gated 24 件中 13 passed / 11 failed**
（**O0-1〜O0-4 は 4 本とも green**）。

失敗 11 件 = 🔴 **baseline 10 件**（`drives real OrbitStudio end-to-end` / `#643 E2E-1〜E2E-7` /
`steps the live playhead` / `#618 E1-E6`）**+ plugin-state restore 系 1 件**。restore 系は実行ごとに
**別のテストが落ちる**（5 回の実行で `auto-records…` と `restores a non-default sum-bus insert…`
が入れ替わった）。本 PR は restore を触っていないので既存の不安定さと考えるが、**裏取りはしていない**。
途中、起動判定の誤った修正で `#628 R28` を落としたが、訂正後は baseline どおり passed に戻っている。

### docs(spec): add RUN termination and offline render to the note-off firing cases (Sep 4, 2026)

**Issue**: #606（`must-fix`）/ **ブランチ**: `606-noteoff-firing-spec` / **PR-K-A0**（spec 先行）

`docs/design/634-pdc-layer-instrument-rack-design.md` §3 の実装（PR-K-A1 / A2）に入る前に、
**note-off の発火点**を仕様側で確定させる。コードは 1 行も変更していない。

#### 🔴 「flush が無い」は誤り — 配送機構は在る

地図 §4.B の記述は誤りで、`run-sequence.ts → sequence.ts → midi-scheduler.ts → plugin-note-output.ts`
の経路は**実在する**。壊れているのは**その周り**である（設計 §3.1 の穴 4 つ）。
したがって本 spec 改訂も「機構を足す」話ではなく、**発火点の列挙に 2 つ足す**話である。

#### 改訂

| 文書 | 箇所 | 追加 |
|---|---|---|
| `PITCH_DSL_SPEC_v1.1.md` | §7-2 realization rule 2（Active note tracking） | **一発 `RUN()` の終端** / **オフラインレンダの終端** |
| `INSTRUCTION_ORBITSCORE_DSL.md` | Note lifecycle の Active-note tracking | 同上（英語側） |
| 同 | **PH.4 All Notes Off** | 同じ発火点 2 つ + 🔴 **daemon 側の「最後の砦」** |

#### 🔴 発火点が増えても配送機構は 1 本

3 箇所すべてに同じ注記を置いた。**場面ごとに別の flush を作らない。**
設計 §3.2 の責務 3 層（TS scheduler = owner ごとの解放 / daemon = instance ごとの最後の砦 /
child = 触らない）を仕様の言葉に落とした形である。

**child に flush を置かない理由**も設計から引いた: child は自分が受けた note の簿記を持たず、
持たせると `(port_index, channel, key)` 参照カウント（PH.4）の**正本が割れる**。

#### daemon の「最後の砦」を仕様に書いた理由

engine が保留 note を解放し切る前に死ぬと、**daemon は active note を追跡しているのに読み手が
いない**（設計 §3.1 の穴 H4・読み手 0 箇所）。これは
「**鳴りっぱなしを検出できるのに止められない**」状態なので、仕様の側で義務として書いた。
実装は PR-K-A2（wire に新 RPC を足す = 一方通行）。

##### 🔴 粒度を書き足した（Fable 監査の指摘）

初稿は「daemon が自身の追跡集合から note-off を送れること」までしか書いておらず、**粒度が
無かった**。2 行上には「**1 シーケンスの停止に wildcard な解放を使わない**」という規範があるので、
**サミング（複数シーケンス → 1 インスタンス）が入った時点で両者が衝突して読める。**

書き足した内容: 最後の砦は **instance 単位（そのインスタンスの全 owner）**である。daemon は
owner の境界を持たないので、これは wildcard 禁止の**例外ではなく適用外** — 通常の owner 単位の
解放経路から呼んではならない。発火してよいのは **`global.stop()` / shutdown / engine 異常終了**の
3 場面だけで、いずれも「そのインスタンスで鳴ってよいものが 1 つも無い」場面である。だから
サミングが入っても**巻き込む相手が存在せず**、参照カウント判定が不要になる。

粒度を書かない仕様は、実装時に「便利な flush」として owner 単位の経路から呼ばれる。
**義務だけ書いて適用範囲を書かないと、規範どうしが後で衝突する。**

#### 検証

`npm test` 2199 passed / 49 skipped（docs のみなので不変）・
`check-citations.mjs` 922 verified / 0 failed（行番号のずれを再アンカー）。

### docs(planning): record the VST3 / CLAP conventions the scanner does not follow (Sep 4, 2026)

**地図**: `docs/planning/DEVELOPMENT_MAP.md` **§4.C** / **ブランチ**: `546-plugin-spec-conventions`
/ owner 2026-09-04・**バグではなく機能改善**

#### 🔴 最初、DAW の「振る舞い」を写して規格を読んでいなかった

owner:

> オービットスタジオで今 **dylib を名指ししているという状態自体が、ちょっと異常**。
> VST も CLAP も基本的には**作法があるはず**なので、その作法を地図のどこかに入れていく。
> 他のものが使えているので、**他を実装した後でも全然いい**。**バグではなくて機能改善・改修。**

> 僕が言ってるのが VST や CLAP の作法ではないというか、**作法をちゃんと調べてやりましょう**。

初稿はフォーラム・製品ドキュメントから **Ableton / Bitwig の振る舞い**を写しただけだった。
owner の指摘で規格を読み直したところ、**振る舞いの観察からは出てこない義務**が見つかった。

#### 規格が定める作法と現在地

| # | 規格（一次情報・**強度**） | 現在地 |
|---|---|---|
| 1 | **CLAP: `CLAP_PATH` を問い合わせる — `must`**（`clap/include/clap/entry.h` 逐語 "a CLAP host **must** query the environment for a CLAP_PATH variable"） | 🔴 `CLAP_PATH` は見ていない。ただし **`ORBIT_PLUGIN_PATH`（`:` 区切り）は既に読んでいる**（`lib.rs:200-211` `extra_scan_dirs_from_env`）ので、**同じ関数に 1 本並べるだけ** |
| 2 | **CLAP: 各ディレクトリを再帰的に探索 — `should`**（同上。1 と違い義務ではない） | 🔴 **非再帰**（`list_bundle_candidates` の doc・同 `:228`。テスト `:2197` が非再帰を固定） |
| 3 | **CLAP: 1 `.clap` に複数プラグイン。factory で descriptor 列挙 → plugin ID で生成** | ✅ **実装済み**（`orbit-clap-host/src/discovery.rs:105-120` 全列挙 / `lib.rs:540-566` 1 バンドル→複数エントリ / `discovery.rs:125-137` ID で選択）。同一性は `(format, path, pluginId)` の複合キー（`lib.rs:1028-1034`） |
| 4 | **VST3: `moduleinfo.json` は 3.7.5 で導入、3.7.8 で `Contents/` → `Contents/Resources/`**（cmake の `SMTG_MODULEINFO_PATH_INSIDE_BUNDLE` で版差を確認） | ○ 参照している（`lib.rs:110`）。⚠️ **`Contents/Resources/` しか見ない**（`lib.rs:842`）ので **3.7.5〜3.7.7 のバンドルは ProbePending 送り** |
| 5 | **同一性は ID（CLAP=plugin ID / VST3=CID）、path は「所在」。ID → ファイルの対応表は規格に無く、所在の解決はホストの責務** | 🔴 `instrument(path)` が生パス（`plugin-resolver.ts:76-80`） |
| 6 | 検証を走らせるタイミング | 🔴 手動のみ（起動時はカタログ JSON を読むだけ・`plugin-catalog-reader.ts:132-150`） |

**1 は既存関数への 1 行追加。2 も小さい。5 は作り直しの規模**なので他の実装の後（owner）。

🔴 **初稿は 3 を「❓ 未確認」、5 を「規格はパスを同一性にしない」と書いていた。**
前者は**実装を読めば分かることを読まずに未確認と書いた**（[[invent-rules-only-after-reading-the-code]] の再発）。
後者は**言い過ぎ** — 規格は path を禁じているのではなく、同一性の担い手が ID だというだけである。
「作法を調べる」は規格側だけでなく**自分の現在地も一次情報で確かめる**ことを含む。

#### 保証のタイミングについての整理

owner: 「Logic や Studio One も**読み込めるということを確認するだけ**で、起動時に全てのプラグインが
メモリに読み込まれているわけではない。**インサートした時だけメモリ空間に出てくる。**
なので起動時のチェックは**品質保証的なもの**」。

調査でも一致した — Ableton は VST3 を常時スキャンにし、**AU は Apple の `auval` に外注**している。
Bitwig は**保証しきれないことを認めて隔離で解く**（ホスティングモード 5 段階）。
**OrbitScore は既に Bitwig 型の out-of-process + crash isolation を採っている。**

🔴 **これは [[live-coding-forbids-workflow-interruptions]] と対になる。** 保証を起動時に寄せるからこそ、
**演奏時に確認を挟む必要が無い**。「評価時に trust を問う」設計は DAW と**二重に**違っていた
（① 確認を挟む ② 判断を実行時に置く）。

### fix(engine): contain the two playback-path throws and log the skip (Sep 4, 2026)

**Issue**: #645（must-fix）/ **設計正本**: `docs/design/610-diagnostics-applicability-design.md` §5 / **PR**: PR-D0（Sonnet フォールバック実装・Codex が sandbox 制約で2回起動失敗）

owner 指示（2026-08-29）: 「ライブコーディングなのでエラー出して止まるのは基本よくない。内部的にちゃんと掴んでログに出すとかして実行に影響を出さない、とかにすれば別に普通に E2E テストでカバーできますよね」。

#### 対象の 2 throw と到達経路（5 経路・すべて main で行番号を取り直し済み）

| # | 場所 | 経路 | 直したか |
|---|---|---|---|
| 1 | `sequence.ts` `resolveDispatchChannel()` | `run()` `:1744` / `loop()` `:1791`（eager・await 連鎖） | ✅ throw→`DispatchTarget`（`skip`）+ `logSkipOnce()` |
| 2 | 同上 | 🔴 `seamlessParameterUpdate` `:273` → `scheduleEventsFromTime` `:1584`。`gain`/`pan`/`audio`/`chop`/`tempo`/`beat`/`length`/`play` から同期で入る（issue 本文が書いていない経路・再現条件として最有力） | ✅ 同上 |
| 3 | 同上 | `unmute()` `:1865` → 同上 | ✅ 同上（呼び出し元のみで解決） |
| 4 | `loop-sequence.ts` `safeSchedule`（`:113-129`） | 既に catch 済み。文言のみ `[ERROR] Sequence '<name>': loop scheduling error:` へ揃える | ✅ 文言合わせのみ |
| 5 | `loop-sequence.ts:104` / `run-sequence.ts` 初回 schedule | 1 と同じ経路で解決済み | ✅ 追加対応不要 |
| 6 | `event-scheduler.ts` `resolveAudioFilePath()`（定義 `:16` 改・呼び出し元 `:106`/`:193`） | パス非絶対（内部エラー自称） | ✅ throw→`undefined` を返しログ、呼び出し元が `return` |

#### 直し方（設計 §5.3 が確定）

- `resolveDispatchChannel(): DispatchTarget`（`{kind:'hardware'} | {kind:'link',channel} | {kind:'skip',reason}`）を新設。**`undefined` は使わない** — 旧 `undefined`（hardware 経路）とエラー時の `undefined` が同じ値になると黙ってハードウェアから音が出る（#645 が名指しした「別種の驚き」）
- `scheduleEvents`/`scheduleEventsFromTime`（sequence.ts 側の private ラッパー）は `kind === 'skip'` で **スケジュールせず return**（そのシーケンスだけ無音、他は継続）
- `run()`/`loop()` の eager 呼び出しは throw ではなく `logSkipOnce()` を呼ぶだけに変更（早期検知は残す）
- `logSkipOnce()`: `_dispatchSkipLoggedFor` で理由文字列をキーに重複抑止。**理由が変わった時**と **`.output()` が新しいチャンネルを設定した時**にリセット。ループは毎小節この経路を通るので、抑止が無いと `get_log` の 500 行窓を 1 シーケンスが埋め尽くす
- `event-scheduler.ts`: `resolveAudioFilePath(audioFilePath, sequenceName): string | undefined` へ変更。呼び出し元 2 箇所で `if (!resolvedFilePath) return`

#### テスト

- ユニット 13 本追加（`tests/core/sequence-link-audio-integration.spec.ts`）: run()/loop() が reject でなく resolve すること・`DispatchTarget` の3 kind・`logSkipOnce` のインスタンス単位 dedup（同一理由の連続呼び出しは1回だけログ）・`.output()` 呼び出しでの dedup キー reset（white-box。公開 API では2回目の skip を再現できないため）
- 既存ユニット 3 ファイル改修（throw 前提のテストを `DispatchTarget` 前提へ書き換え）
- gated E2E 1 本追加（`tests/e2e/orbitstudio-mcp-gated.spec.ts` 末尾）: `global.linkAudio()` 下で `.output()` 無しの LOOP が無音スキップ + ログされ、**別の（`.output()` 済みの）sequence の LOOP を止めない**ことを capture RMS で確認。続けて path 2（`.gain()` mid-loop）が同じ evaluation block を落とさないことを、**別の** `evaluate_orbitscore` 呼び出しでの gain 変化（RMS 差分）で確認。ERROR 件数はループ4秒超（2小節超）でも高々 +4 に収まることを assert（dedup の回帰証跡）
- `tests/e2e/dsl-e2e-coverage.spec.ts`: 新 E2E が `global.linkAudio()` を実機で評価するため `GLOBAL_UNCOVERED_BASELINE` から `linkAudio` を除去（ラチェットは減る方向のみ許可）

#### 検証（sandbox 内・実機 E2E は main が別途実施）

`npm test`（2199 passed / 49 skipped）・`npm run typecheck:e2e`・`npm run lint`・`npm run build`・`sites/dev` の `check-citations.mjs --fix`（`sequence.ts`/`event-scheduler.ts`/`loop-sequence.ts`/`dsl-e2e-coverage.spec.ts` の行番号シフトで 26 件の引用が機械的にずれたため再アンカーのみ実施・本文の書き換えなし）はすべて green。

#### 追記（実機 gated E2E が落ちた・main 実測 2026-09-04・修正済み）

main の実機実行で E2E-645 が `timed out waiting for #645 dispatch-skip log line` で failed
（他 10 件は baseline と同一の pre-existing 失敗で無関係）。**実装本体は問題なし**、テスト
ハーネスの前提検証不足が原因:

- `run_selection`（`evaluate_orbitscore` と違い）は評価完了を待たず、`isError` は
  「アクティブなエディタが無い」等の**機械的失敗**しか捉えない — 提出コードの実行時 throw
  （`global.linkAudio()` の v1 相互排他 throw 等・`global.ts:411-422`）は `get_log` にしか
  出ない。既存の `expect(run.isError).toBe(false)` はこの throw を素通りさせていた
- 修正: `global.linkAudio()` を単独の `run_selection` に分離し、直後に `get_log` で throw
  文言の有無を明示チェック（見つかれば「①linkAudio 自体が失敗」と名指しして即座に fail）。
  最終の skip ログ待ち `waitUntil` も try/catch で包み、タイムアウト時に「①は否定済みなので
  ②skip が起きなかった/③ログが窓外に流れた」の切り分けと `get_log` 末尾をエラーに含める
- `tests/e2e/helpers/run-score.ts` の `startEngineForRun`/`waitForEngineState`（`runScore()`
  が内部で使っていた既存の堅牢な起動処理）を export し、engine の (再) 起動をそちらへ委譲
  （`capture_wav` 要求時は必ず stop_engine→wait-false→start_engine、daemon ready timeout の
  retry-once、`🎵 Live coding mode` マーカー確認まで待つ — 単なる `get_engine_state.running`
  より確実）

検証（再実施）: `npm test`（2199 passed / 49 skipped・変化なし）・`typecheck:e2e`・`lint`・
`build`・`check-citations.mjs`（import 追加による行番号シフトで 46 件が再びずれたため
`--fix` で再アンカー）すべて green。実機 gated E2E は未実施（main が別途実施）。

#### 追記2（capture RMS の前提が崩れていた・main 実測 2026-09-04 の2回目・修正済み）

上の修正で前提診断は効き、skip はログに出ることが確認された。しかし別の assert
（`d645Live` の capture RMS）が `expected 0 to be greater than 0.01` で failed。main の一次
情報調査: `rust/crates/orbit-audio-daemon/Cargo.toml` の `link-audio` feature は default off・
gated ビルド（`pretest:e2e:gated`）も `--features outproc-effect,outproc-instrument` で
link-audio を含まない。「LinkAudio でも hardware にフォールバックして鳴る」という前提は
`rust-engine-player.ts` の**コメント**に書いてあっただけで、実機ログに
`LINK_AUDIO_UNAVAILABLE`/gap warning が1件も出ておらず、**裏取りできていなかった**。

- 修正: capture RMS への依存を全廃。証明手段を TS engine 側の `console.log` マーカーへ
  切替 — `🔄 <name> (loop started/queued)`（`loopSequence()`、dispatch 結果によらず無条件で
  発火）と `🎚️ <name>: gain=<x> dB (seamless)`（`seamlessParameterUpdate()`、
  `scheduleEventsFromTime` の private wrapper が skip で早期 return しても、呼び出し元自身の
  ログ行は必ず届く）。いずれも daemon RPC より手前の TS 側イベントなので、LinkAudio が
  daemon にコンパイルされているかに依存しない
- `LOOP(d645Skip)` + `LOOP(d645Live)`（経路1）・`d645Skip.gain(-6)` + `d645Live.gain(-3)`
  （経路2）を**それぞれ1つの `run_selection`（= 1評価ブロック）**にまとめ、後続の sibling
  マーカーが実際に出ることを確認 — pre-#645 なら先頭の throw が同ブロック内の後続文の実行を
  止めていたはず、というこの PR の主張そのものを検証する構造にした
- 別の `evaluate_orbitscore` 呼び出し（`d645Live.gain(-1)`、ブロックをまたぐ後続評価が汚染
  されないことの確認）は `pan` ではなく `gain` を再利用 —
  `dsl-e2e-coverage.spec.ts` の `SEQUENCE_UNCOVERED_BASELINE` に `pan` が残っており、新規に
  `.pan(` を書くとラチェットの「baseline は減らす方向のみ」に抵触するため
- テスト名から誤解を招く要素は無いため維持（「sibling を止めない」という主張は log マーカーで
  引き続き証明できている）。実行時間もこの変更で短縮（audio 用の settle sleep 群を削除）

検証（再実施）: `npm test`（2199 passed / 49 skipped・変化なし）・`typecheck:e2e`・`lint`・
`build`・`check-citations.mjs`（今回は行番号シフト無し・0 failed）すべて green。実機 gated
E2E は未実施（main が別途実施）。

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

---

### docs(design): 詳細設計 11 本と実装プラン 2026-09 を起草 (Sep 3, 2026)

**Issue**: #611 / #694 / #598 / #672 / #634 / #428 / #610 / #662 / #656 / #668 / #679（設計のみ・実装なし）/ **ブランチ**: `claude/elegant-pasteur-l9gdrl`

owner 指示（2026-09-03）: 「① 詳細設計（`docs/design/`）と ② 実装プラン（PR 戦略）を作る。実装はしない。決まっていないところ以外は、そのまま作れる粒度で。曖昧さは owner 裁定待ちに隔離する」。

#### 成果物

| 文書 | 束 |
|---|---|
| `docs/design/611-output-line-design.md` | 出口の一般化（#611/#649/#543-a/#409/#647）— `output(dest, thru, db)`・`AudioLine`・`SetBusLine`・`LineProgram`・master ライン・engine 2ch 固定 |
| `docs/design/694-session-log-editor-path-design.md` | #694（設定 → env・`//#sourceFile`・`<DIR>/`・純度・v2）/ #695（`//#evalBegin/End` フレーム・複数 GLOBAL）/ #241（in-process replay・transport 駆動） |
| `docs/design/598-render-endpoint-design.md` | `mix.render(<path>)`・`%n`・合算 = 解決後パス・`RenderInstance`（実時間 stem）・`RenderScore` v2・評価列 × 仮想クロック driver・P3 差分 |
| `docs/design/672-plugin-boundaries-design.md` | 境界 5 本（3rd-party / 標準 / タップ / 標準シンセ / DSL）と残りのコア・`DslModule` / `HostContext`・2 spec の目次 |
| `docs/design/634-pdc-layer-instrument-rack-design.md` `428-timed-event-queue-design.md` `610-diagnostics-applicability-design.md` `662-performance-and-visibility-design.md` `656-release-design.md` `668-e2e-foundation-design.md` | subagent 起草 → main 検収（裁定の出どころ・path:line・裁定待ちの隔離を確認） |
| `docs/design/679-input-consistency-check.md` | 入力は着手しない裁定。今回の設計に矛盾が無いことを 12 観点で確認 |
| `docs/planning/IMPLEMENTATION_PLAN_2026-09.md` | 一方通行の判断 17 件 → PR 一覧（接頭辞 O/L/R/P/K/Q/D/V/S/E）→ 順序の根拠 → 段 0〜8 |

#### 設計上の主な判断（裁定の範囲内）

- フェーダー = 出口のレベル（裁定 ④）は「乗算 = 出口の op」なので位置ずれのクラスが消える。#649 の原因説明は撤回済み（コメント 1）なので E2E-1 は red-first
- render も log も「譜面からの相対」。`.orbslog` は今日 0 本なので `logVersion: 2` を今出す
- フレーム（`//#evalBegin/End`）は #649 §10.3 と #695 の**同一機構**（PR-L2 の 1 本）
- offline driver は最初から**評価列**を入力にする（`.orbs` = 1 eval・`.orbslog` = transport 順）。前提は Clock DI（core 17 箇所・挙動不変）
- コアは「境界の残り」として**列挙**で確定（#671 コメント 1 の 9:31 と整合）

#### 裁定待ち（設計に混ぜていない）

各文書の末尾節に隔離。地図 §9 の未決 9 件は埋めていない。新規に出た主なもの: `<DIR>/` の名前 / CLI のログ既定 / 数値 `output(n)` の退役 / プレースホルダ語彙 / 実時間 stem の issue の置き場 / A4 実行形態 / transport 書きの競合 / #674 表面 / midi の `output` 拒否。

#### 検証

docs のみ（コード変更なし）。`npm test` は未実行（変更対象外）。issue へは**コメントのみ**（本文・ラベル・close は触っていない）。

#### 追記（同日）: owner 裁定の反映

裁定シート（artifact）で owner が 66 問中 50 問に回答。推奨から変わったもの: 同一宛先の `output` は 2 要素として加算 / `pan` をライン要素に / mono 宛先は L+R マージ / `--until` は高速畳み込みを最初から設計 / `--verify` はイベント sidecar + assets hash / OSC はメッセージ値を `play()` に / `seq.root()` は note-name も受ける / `[...]@v` per-voice 分配 / `chop(n>1)` の tie は伸ばす / child の QoS を TIME_CONSTRAINT へ / node を同梱 / 標準プラグインの実装は WASM スパイク後。各設計文書の裁定待ち節と `IMPLEMENTATION_PLAN_2026-09.md`（W-18〜22・§4）へ反映。相談中 6 件はチャットで提示。

### 追記: Q-694-7 — 今日の `.orbslog` はリプレイに使えるか（実装を実走・同日）

owner: 「ログが出ていた時に再現に使える形になっている様に中身が見えなかった。実装を調べて
ちゃんとリプレイできるのか？それがないとオフラインレンダリングができないのでしっかり見て」

mock backend の `InterpreterV2` に、拡張が stdin へ書く形（`extension.ts:3013-3022` の注入込み）を
`createReplSession().pushLine` で流し、`Date.now` を差し替えてログを生成した（doc 694 §2b）。

**結論: そのままでは再現に使えない。** 欠落 11 件を `path:line` と生成ログの根拠つきで一覧化
（doc 694 §2b.3 G1〜G11）。owner の記憶「中身が見えなかった」は G1（注入で `code` が汚れる）・
G2（`untitled` が cwd に落ちる）・G3（1 行 = 1 eval で選択の形が残らない）の実体。**それに加えて**:

| 発見 | 実測 | 手当 |
|---|---|---|
| **`transport` が音楽時間ではない**（G6） | tempo 120→60 の 10 ms 後の stamp が `1:3.000` → **`1:2.010` に逆行**。LOOP の quantize も同式で「+2990 ms」待った | `TransportTimeline`（PR-L8）。quantize を乗せるかは 🔴 doc 694 §13 (8) |
| **プラグイン状態がログの外**（G7） | `stop()` の auto-snapshot と `//#savePluginState` が同じ相対パスへ上書き（版なし）。replay は後のセッションで上書きされた状態を読む | start/stop で `orbslog/<log>.states/` へ写す（PR-L9・🔴 §13 (9)）。**#598 P3（PR-R8）の前提** |
| 評価の結果・import 本文・MCP 由来の印が無い（G4/G5/G8） | REPL は `//#evalMark` で `ok` を計算済みなのに捨てている | `result` / `import` レコード + フレーム属性（PR-L7）|

plan: PR-L7/L8/L9 追加・PR-L4 は L7/L8 の後・PR-R5 は L8 の後・PR-R8 は L9 の後（W-23/24/25）。

同日の他の反映: Q-598-2 サラウンド → **B-lite**（N ch の render 器 + `output(at:, mono:)`・
エンコードは Logic。doc 598 §3.6・PR-R9）/ Q-610-5 確定（赤線 + その文だけスキップ）/
Q-656-1 `untrustedWorkspaces.supported: true`（DAW に合わせる）/ Q-656-2 #138 独立のまま。

**同日夕・残り 3 問が確定（すべて A・推奨どおり）**: Q-694-3 `--until` 境界ちょうどは適用済み /
Q-694-8 LOOP quantize も `TransportTimeline` に乗せる（tempo 変更後の境界の飛びを修正として記録）/
Q-694-9 プラグイン状態は start/stop で `orbslog/<log>.states/` へ写す。これで裁定シート 66 問は
すべて回答済み。doc 694 §0 に裁定 9〜11 を追加・plan §4 は「裁定待ち 0 件」。

**同日・ユーザー視点の到達点**（owner「各 PR が完了すると何が出来るのかユーザー視点で纏めて」）:
`docs/planning/USER_OUTCOMES_2026-09.md` を追加。plan §1 の 98 PR すべてに「完了するとできること」を
1 行ずつ、見え方（🎵 音・操作 30 / 👀 見える 25 / 🧱 土台 31 / 📄 仕様 12）と段を添えて記載。
「何も変わらない」PR はそのまま書く（土台の PR が続く週はそれが正しい状態）。

**同日・束ブランチ運用の採用**（owner「PR-O のような纏まりで stacked PR を積んで、纏まりが終わってから
レビューチームを走らせるのはどうか」→ 相談の結果、統合ブランチ方式で合意）:
`docs/development/BUNDLE_BRANCH_WORKFLOW.md` を追加。束ごとに統合ブランチを置き、小 PR は
CI + その PR の E2E 実機 + 目視の軽いゲートで入れ、統合ブランチ → main の束 PR で
`/simplify` → レビューチーム + Fable → 実機全件を 1 回だけ回す。束は 1,500 行以下で継ぎ目で切る
（OrbitScore は 7 束・フルレビュー 27 回 → 7 回）。純 stacked PR を採らない理由は squash との相性
（下の層が main に入るたび上の層の rebase が要る）。GitHub の stacked pull requests
（2026-07-30 公開プレビュー）は「層ごとにレビューを増やす」道具で目的が逆、プレビュー中は併用しない。
参照 17 件は URL の実在を確認（docs.github.com 等はプロキシで本文取得不可のため検索要約で確認）。
→ owner 了承（同日）で **#703** として別 PR に。bot の `if` は `claude-code-review.yml` **だけ**
（`code-review.yml` はジョブ名が `code-review` だがテスト CI 本体なので触らない）。plan §2.5 に束の割り当て表を追加。

---

### chore(meta): critical path の 27 issue に実装チェックリストを入れた (Sep 3, 2026)

**Issue**: #697 / **記法**: `docs/core/PROJECT_RULES.md` §1d

owner: 「地図でリンクしてる ISSUE に**実装内容のチェックリスト**を作って、実装時に**ちゃんと終わってるか**、
**終わってなければ理由は何か（変更になった、いらなくなったなど）をトラッキング**できるように」

#### 🔴 要点は「終わらなかった理由が残ること」

チェックが消える／黙って削られると**なぜやらなかったのかが次の人に分からない**。
本日それで実害が出た — **#506 の看板は SC.10.9 で撤回済み**だったのに、撤回が spec 側にしかなく
issue 本文が古いままで、main が **#680 を重複起票**した。

#### 記法（§1d）

```markdown
- [ ] 未着手
- [x] 完了 — PR #NNN / commit `abc1234`
- [x] ~~やらなくなった~~ — 🔴 **不要**: 理由（出どころ: MAP §4.X / #NNN / owner YYYY-MM-DD）
- [x] ~~形が変わった~~ — 🔴 **変更**: 何にどう変わったか（同上）
```

**項目を削除しない** / **完了には PR か commit** / **`[x]` は「解決済み」**（完了も「やらない」も。
**未解決だけが `[ ]`** なので**残数がそのまま残作業**）/ **理由には出どころ** /
🔴 **未決事項をチェックリスト化しない**（決めていないものを「やること」にしない）。

#### 対象 — 27 件（critical path のみ）

#543 #649 #645 #606 #634 #635 #636 #669 #659 #656 #661 #660 #662 #667 #663 #672 #671 #680
#428 #610 #644 #668 #694 #695 #679 #385 #611

**地図が参照する OPEN issue は 117 件**あるが、全件に入れると**更新されないチェックリストが 117 個**できる。

項目は**地図と issue 本文から導いた**。受け入れ基準は可能な限り**実測値**にした
（例: #649 は「`global.gain(-6)` で instrument の RMS が 0.08864 → 0.044」= #649 本文の実測）。

### docs(index): アーカイブ後の INDEX を追従させ、地図を目次に登録 (Sep 3, 2026)

**追従元**: PR #693（マージコミット `b9fad48`）/ **ブランチ**: `claude/docs-sync-pr693`

PR #693 は 9 本を `docs/archive/` へ移し、**現役ファイルからの参照リンクは全部直した**
（`INDEX.md` のリンク先も `../archive/...` に書き換わっている）。追従できていなかったのは
**目次の構造とラベル**の方で、2 点あった。

#### ① 移動した 8 本が「現役」の見出しの下に残っていた

`docs/core/INDEX.md:75-88`（追従前）は、見出し「設計ノート (`docs/design/`)」/
「Planning (`docs/planning/`)」の表に、リンク先だけ `../archive/` へ変わった行が
**現役の行と混在**していた。読者は見出しを信じて表を読むので、**アーカイブ済み文書を
現在の設計として読める**状態が残っていた — #696 が消そうとした「紛らわしいから」
そのものである。

現役（`643` / `649`）と分け、**アーカイブ済みの表を別に立てて「現在の正本」列**を持たせた。
列の値は移動時に各文書へ付けたバナー（例: `docs/archive/design/628-effect-chain-model.md:2`
「**現在の正本**: `SIGNAL_CHAIN_DSL_SPEC_v1.md` **SC.10**」）から採っており、新しい判断はしていない。

#### ② 🔴 `DEVELOPMENT_MAP.md` が目次に無かった

PR #693 が追加した本体（1388 行・**開発計画の正本**）が `INDEX.md` に**1 行も無く**、
Planning 節は**移動済みの 2 本だけ**を挙げていた。`grep` で確認した地図への参照は
リポジトリ全体で `PROJECT_RULES.md:34` の 1 箇所のみ。

地図 §0.2 は「**番号の検索ではなく、地図の見出しで探す**」を運用規則にしているが、
**その地図に目次から辿り着けない**。CLAUDE.md がセッション開始時の必読に挙げるのは
`INDEX.md` なので、ここに無いと運用規則が起動しない。地図と
`2026-09-03-issue-triage.md`（#696 が「現役」と明記）を Planning 節へ登録し、
§0.2 の起票規則を引用で添えた。

#### ③ 棚卸し記録が、同じ PR で覆されたラベル状態を載せたままだった

`docs/planning/2026-09-03-issue-triage.md:115` は「`foundation` と `release-gate` の **2 枚のみ**」と
書き、C5 の表（同 `:96`）は **#197 に `release-gate`** を付けている。PR #693 はこの両方を覆した —
**`must-fix` を新設して 3 枚**にし、**#197 のラベルは外した**（WORK_LOG 上の記述: 「🔴 3 件目は
main の誤り — #197 に `release-gate` を付けたとき #656 と突き合わせていなかった。ラベルを外した」）。

この文書は #696 が「**地図の入力として現役**」と明記して残したものなので、放置すると
現役の文書が古いラベル状態を主張し続ける。**表の行は棚卸し時点の記録として保存**し、
§5 に**追記**として 2 点の変更と「ラベルの現在の状態は地図を見る」を書いた
（`docs/design/` の設計書と同じく、記録の書き換えはしない）。

#### 追従不要と判断した層

- **DSL/言語仕様・ランタイム/MCP・OrbitStudio**: PR #693 の差分 22 ファイルは
  `docs/` と `sites/dev/` のみ。`packages/` の実装は 1 行も無い。唯一の `rust/` の変更は
  `spike_s_concurrent_load.rs:15` の**行コメント内のパス文字列**で、コードではない
- **`sites/dev/`**: 参照パス 6 箇所が ja / en 対で既に直っている（`sites/dev/signal-chain/index.md:27`
  と `sites/dev/en/signal-chain/index.md:28` など）。地図の裁定（出口の一般化・`send` の dB 化）は
  **未実装の決定**であり、dev サイトは実装の解説なので、書くと「実装されていない挙動」の記述になる
- **`sites/user/` / `docs/user/`**: ユーザーが書く語は 1 つも増減していない

---

### chore(docs): 正本が別にできた設計・計画文書を 9 本アーカイブ (Sep 3, 2026)

**Issue**: #696 / **MAP §0.3**

owner: 「仕様検討したドキュメントは、イシューになって地図に書かれたものは**アーカイブ**しておこうか。**紛らわしいから**。」

#### なぜ

同じ主題の文書が複数あると誤読が起きる。**実例**: 本日 main が **#506（plugin-as-method）を読まずに
#680 を重複起票**した。#506 の看板（メソッド形）は **SC.10.9 で撤回済み**だったが、
撤回が spec 側にしかなく issue 本文が古いままだった。

#### 基準 —「正本が別にできたもの」

| 移した文書 | 現在の正本 |
|---|---|
| `628-effect-chain-model.md` | **spec SC.10**（文書自身が「確定・SC.10 として制定済み」と明記） |
| `628-plan-reset` / `628-rack-chain-implementation-design` / `628-gated-e2e-rack-design` / `628-ui-pump-per-index-design` | **#628 / #633 CLOSED**（PR #639 / #652 で出荷済み） |
| `625-effect-replacement-design.md` | **#625 CLOSED**（PR #627） |
| `ROADMAP_2026.md` / `IMPROVEMENT_RECOMMENDATIONS.md` | **`DEVELOPMENT_MAP.md`**（地図 §0.3 が「歴史的スナップショット」と明記） |
| `2026-09-02-feature-map-comments.md` | **地図 §4 各節 + #679 / #680 / #681** |

**残したもの**（issue が OPEN・**正本がまだ他に無い**）: `643-mixer-foundation-design.md`（PR-3 = #645 が残る）/
`649-audio-line-design.md`（設計のみ・実装なし）/ `662-engine-visibility-and-limits.md`（未着手）/
`2026-09-03-issue-triage.md`（地図の入力として現役）。

#### 🔴 参照を全部直した — ここが本体

**移動して参照が切れると、探せなくなって同じ重複が起きる。**

現役ファイル 12 本の参照を書き換え（`INDEX.md` / `INSTRUCTION_ORBITSCORE_DSL.md` / `WORK_LOG.md` /
`DEVELOPMENT_MAP.md` / `SIGNAL_CHAIN_DSL_SPEC_v1.md` / `spike_s_concurrent_load.rs` /
dev サイト 6 本）+ **アーカイブ同士の相互参照 5 本**。

各文書の冒頭に「**アーカイブ。現在の正本は〜。新しい判断の根拠にしないこと**」を付けた。

#### 検証

- **現役ファイルから移動前のパスを指す参照: 0 件**（`grep`）
- `npm run docs:check` **904 引用 / 0 failed**
- `npm run docs:build` dev / user とも成功
- `git diff -M` で**リネームとして検出**（内容は移動・参照のみ書き換え）

---

### docs(planning): 入力の DSL 表面と、入力が入ると変わる性能の性質 (Sep 3, 2026)

**Issue**: #692 / **正本**: `docs/planning/DEVELOPMENT_MAP.md` §4.O.1・§4.P.1

#### 🔴 入力の経路は現在ゼロ（実測）

| | 結果 |
|---|---|
| cpal の入力ストリーム | **0 件**（`build_input_stream` / `default_input` とも） |
| デバイス列挙 | **`list_output_devices` のみ**・`maxOutputChannels` だけ返す |
| `rebuild_output_stream(…buffer_frames, device_name)` | **出力専用**。入力用の対は無い |
| `CallbackTimeStats` / `StreamStats` | **出力コールバックの所要時間**のみ。**往復を測る手段が無い** |
| `input` / `rec` / `record` | **DSL 語彙に 0 件** = 新しい主語 |

**#661 / #660 / #662-A が扱っているのは全部「出力側」。** 入力はデバイスの列挙・選択・レート・
バッファ・統計が**すべて新規**。

#### §4.O.1 入力が入ると変わること（owner 2026-09-03）

> 性能向上とともに**サンプリング周波数の変更やレイテンシー、バッファの調整**が必要になりますよね。
> **特にインプット系があると。**

- 🔴 **レイテンシーが「往復」になる**（入力バッファ + 処理 + 出力バッファ）。
  性能ゴール「64 / 32」は memory の記述が出力バッファと out-of-process の +1 block の話なので
  **片道として読める** → **往復の目標値は未決**（§9・owner 確認）
- **サンプルレートは入出力で一致していなければならない**。#662 の「🔴 再起動」の理由が 1 つ増える
- **入力バッファは新規**（出力は #368 / #662-D と同じ場所）
- **クロックのずれ（drift）は main の推測**。owner は言っておらず実装にも該当なし → **未検証と明記**

**順序への影響**: 入力は「測れるようになってから」だけでなく、**入力自体が測る対象を増やす**。
**#662-B は一度で終わらず、入力が入った後にもう一度広がる。**

#### §4.P.1 入力の DSL 表面（owner のスケッチ・確定ではない）

> サンプリングも**インプットからオーディオが渡される DSL で表現されるべき**なのでは？
> `input.rec(…).effect` のように**順番でドライの録音かウェットの録音かも決められる。**

🔴 **§4.A.1 の規則が入力側にもそのまま効く** — `rec` はライン上の要素で、**位置が dry / wet を決める**:

```
input.rec().effect("Reverb")     ドライを録る
input.effect("Reverb").rec()     ウェットを録る
```

**専用のフラグが要らない。** パンチイン / アウトは **`play()` と同じパターン**（owner 提案）で、
**録音専用の構文も要らない**。

**出口との対称**: `output(宛先, thru, db)` ↔ `rec(パターン, …)`。
**`thru` = 入力モニターは main の読み**（owner は言っていない）と明示。

**未決**（§9・詳細は着手時に詰める・owner「まだ詳細決めきれないとは思うけど」）:
`input` の位置づけ（**文の受け手は今 globals / sequences / mixer nodes の 3 種** — 4 番目にするか
シーケンスの一種か）/ `rec` の引数（`play()` はスライス番号だが録音は 2 値）/ 録ったものの命名（テイク）。

**main の読み**: `input` を #643 の**ソース（feed）の一種**と決めれば、入力ラインは出力ラインと
同じ土台に乗り、`rec` は `output` と同じ資格の要素になる — **対称性がそのまま実装の形になる**。

---

### docs(planning): 設定変数・性能・入力（レコーディング）を地図へ (Sep 3, 2026)

**Issue**: #692 / **正本**: `docs/planning/DEVELOPMENT_MAP.md` §4.H.1・§4.O・§4.P

owner の確認 3 件で、**2 つの欠落と 1 つの分類ミス**が見つかった。

#### ① 設定変数の一覧化（§4.H.1・新設）

owner「設定のところに**変数を取り出して設定する**、とか **MIDI パニックを流すためのボタン**とか入ってる？」

| | 結果 |
|---|---|
| MIDI panic | ✅ 入っている（バッチ C・`midi-output.ts:90` 実装済み・**配線のみ**） |
| 設定変数 | 🔴 **部分的**。#662 が名指しするのは **5 項目**だが、本番ソースの env 変数は **33 個** |

`GetStatus` は**状態だけ**を返す（`session.rs:1349-1360`: version / sample_rate / channels /
loaded_samples / active_plays / uptime / render_contentions）。**設定値は 1 つも返さない。**
起動引数として渡せるのは `--audio-device` と `--list-audio-devices` **だけ**。

**#156（prefix 統一）が一覧化の前提**（`ORBITSCORE_*` 5 / `ORBIT_*` 28 の不統一が表に出る）。
**#694 の実装先が #662 の設定面になる可能性**（`ORBITSCORE_SESSION_LOG` を拡張から渡す手段が無い件）。

#### ② 性能（§4.O・新設）

owner「**マルチスレッドちゃんと使えてる？メモリは有効に使えてる？**」「**性能向上は必要。効率化大事です。**」

🔴 **地図に 1 件も無かった**（grep 0 件）。#667 / #590 / #640 は §4.I に個別の不具合として
入っていただけで、**性能という軸が存在しなかった**。

**owner の 2 つの問いは、いま答えられない** — スレッド構成はソースから読めるが（cpal RT /
audio owner `output.rs:128` / capture writer / tokio / supervisor）、**実測が無い**。

| 分かっていること | 実測値 |
|---|---|
| メモリは**起動時に固定確保** | 64 stage × sample_rate × channels = **2ch@48k で約 24.6 MB**（8ch で 4 倍・`output.rs:1408`） |
| instrument は **1 インスタンス 1 child** | Kontakt 6 台 = child 6。**各 child が 1 コアを食い切る**（#667）→ **実質の上限 = コア数** |
| RT の post-loop | 配列順で**直列**（`output.rs:943-975`）。並列化は未検討 |

**性能は他の裁定の前提**（#663 本文「バッチ B → 本 issue の順。逆にしてはいけない」/
#667 本文「#663 の前にこれを直さないと、上限だけ外して実際には増やせない」）。
順序: **#662-A → #662-B（測る）→ #667（直す）→ #663（外す）**。

#### 上限を決めない — owner の 5 語を定数で照合

| owner の語 | 実体 | #663 の対象か |
|---|---|---|
| トラック数 | `MAX_INSERT_BUS_STAGES = 64` | ✅ |
| インスト数 | `MAX_INSTRUMENT_SLOTS = 32` | ✅ |
| エフェクト数 | ラック内 N に上限定数なし | △ |
| 🔴 **アウトプット数** | **1 ラインの出口 = 1**（`_sumOutputBus` 単一）/ render bus 16 / Link ch 64 | **1 と 16 は #663 に無い** → **§4.A.1 の裁定（複数 `output`）と正面から衝突** |
| パス数 | send は stage 64 に従属 | ✅ |

#### ③ レコーディング = 入力の録音（§4.P・新設）— main の分類ミス

owner「**いやインプットの話したじゃん**」「**リアルタイムサンプリングが自然と Opcode Vision や、
Ableton・Bitwig のようなレコーディング機能になるはずです**」。

🔴 **#679 は「レコーディング機能の前段」ではなく、レコーディング機能そのもの。**
昨日のコメントに「Ableton, Bitwig, Opcode Vision 的なオーディオの扱い」と**既にあった**のに、
地図は引用だけ載せて**結論を書いていなかった**。§4.L の 1 行に埋もれ、「録音」の語で引けなかった。

**スコープへの影響**: 「フレーズを 1 つ録る」だけ作ると、後で録音機能を別に足すことになる。

**「録る」を 3 種に分離**（混ざっていた）:

| | 何を記録するか | 節 |
|---|---|---|
| `.orbslog` + `replay --render` | **評価の記録**（因果）→ 後から音を作り直す | §4.A.3 |
| capture / `output(<file>)` | **出力の音**（現象） | §4.A.3 |
| **#679** | **入力の音**（楽器の演奏）→ DSL の素材 | **§4.P** |

🔴 **capture は engine 起動時にしか指定できない**（`extension.ts:2130` で env・
`StartCapture` / `StopCapture` の RPC は **0 件**）。**演奏中に録る操作が無い**ので、
書き出し側も「レコーディング機能」として未完成。

---

### docs(planning): 退行を守る軸を地図に追加 — 譜面 108 本のうち音が固定されているのは 7 本 (Sep 3, 2026)

**Issue**: #692 / **正本**: `docs/planning/DEVELOPMENT_MAP.md` §4.G.1

owner の指摘「**E2E で既存機能が壊れてないかを守る件は書かれてる？**」→ **書かれていなかった。**
§4.G は「語が E2E に出てくるか」（カバレッジ）だけを扱っていた。

#### 🔴 なぜ致命的か

**本日の裁定はほぼ全部が既存の意味を変える**うえ、全部「**評価は成功するのに音が変わる**」形:

| 裁定 | 壊れ方 |
|---|---|
| `send` を dB へ | `send("rev", 0.3)` の音量が変わる。**エラーは出ない** |
| フェーダー = 出口の属性 | `global.gain()` が効くようになる = **今の音と変わる** |
| master = 出力先の 1 つ | 既定が保てないと**無音か二重** |
| `output` の `thru` | 既定 `false` なら不変の**はず**（要検証） |

`ok` でも `get_log` の ERROR でも捕まらない。**capture の数値でしか見えない。**

#### 実測: 譜面 108 本のうち、音のレベルで固定されているのは 7 本

| 置き場 | 本数 | 音を固定しているか |
|---|---|---|
| `test-assets/scores/` | 66 | ❌ **パースに使うだけ** |
| `examples/` | 24 | `examples/22` の 1 本だけ |
| `test-assets/verify-fixtures/` | 4 | ✅ Leg 1 / Leg 2 |
| `tests/fixtures/mcp-e2e/` | 2 | ✅ gated |
| その他 | 12 | ❌ |

🔴 **mixer（sum / aux / send）・instrument・プラグイン・`global.gain()` を通る譜面の
「この音になる」は 1 本も固定されていない** — **本日の裁定が触るのは全部そこ**。

#### owner 指示（逐語・§4.G.1 の冒頭に置いた）

> また**変異テストが増えて時間ばかり浪費するのは絶対に避けたい**ので E2E テストは重要です。
> **変異テストより「実際に動くか？」を、MCP 経由、つまりユーザーと同じ形でテストする**のが重要です。

これは新方針ではなく **CLAUDE.md の規律の再確認**（地図が引いていなかった）。
検証手段の順位: 1 仕様 → **2 MCP 経由 E2E**（カバレッジ = §4.G / 退行 = §4.G.1）→ 3 機能テスト →
**4 変異検証 = PR 外**（無人 `--in-diff` か週次）。

🔴 **実証が今日の議論のど真ん中**: `global.gain()` が instrument に効かない欠陥を、
**変異 35 件（80 分超）もユニット 2149 件も 1 件も捕まえず、キャプチャ E2E の RMS 実測だけが捕まえた**。
それが **#649** — **今日その設計（フェーダー = 出口のレベル）で消そうとしている当のバグ**。

#### 実装前に固定するもの（順序の条件）

`send` の現在の音 / `global.gain()` の現在の音（**効いていない状態 = バグの記録**）/
`output` を書かない譜面の宛先 / `seq.gain()`。**固定していないと「変わったのが意図した分だけか」を判定できない。**

受け入れ基準は #649 本文の実測がそのまま使える: `global.gain(-6)` で instrument の RMS が
**0.08864 → 0.044**（半分）になること。

#### #543 の分割を提案

#543 の「オフライン決定論層（同一 `.orbs` → ビット一致 PCM・CI 常駐）」が**退行の固定そのもの**。
**(a) 回帰の固定 / (b) 二重台帳（カバレッジ）**に分け、**(a) を裁定の実装より先**に置いた。

---

### docs(planning): 書き出しの筋 — replay がライブとオフラインの橋である (Sep 3, 2026)

**Issue**: #692 / **正本**: `docs/planning/DEVELOPMENT_MAP.md` §4.A.3

owner の問い: 「**アウトプットの音は全てレンダリングできるように。各トラックパラでレンダリングしたり、
マスターをレンダリングしたり**」「**順番ごとに実行するのをどうオフラインレンダリングに繋ぐか**」
「ライブコーディングで作ったものを録音する時にオフラインが要る（例: **840 / 1260**）」。

#### 🔴 答えは既に設計にあった

`SESSION_LOG_SPEC_v1.md` §4:

```
orbitscore replay <log> --render out.wav   # オフラインレンダー（faster-than-realtime）
```

> リプレイヤーはエンジンから見て**もう一人の評価送信者**（VS Code 拡張と同じ口）。
> **エンジン側に専用経路を作らない。** 駆動は **`transport` 時刻**。

**owner の「タイミングが合わない」懸念は、Known Decision で原理的に解けている** —
「リプレイは**音楽時間駆動**（三重スタンプ）」（棄却案: 壁時計駆動・`IMPLEMENTATION_INSTRUCTIONS.md:138`）。

#### 地図の分類ミスを訂正

🔴 **#241（L2 replayer CLI）を §4.M「研究トラック・本番後に実施」に置いていたのは誤り。**
WCTM の文脈でそう書かれていたのを写しただけで、**実際にはライブ → オフラインの橋**である。
**§4.A へ移した**（§2 の全体図も `#598 P2 → #241 replay → #598 P3`）。

#### 書き出しの経路は 3 つあり、違いは「時計」であって「宛先」ではない

| 経路 | 何を書くか | 時計 | 状態 |
|---|---|---|---|
| capture（`ORBIT_CAPTURE_WAV`） | **master 1 本**（`render_block` の post 後 `hw`） | 実時間 | ✅ 実装済み |
| #598 render | per-bus stem | 高速 | **P1 のみ ✅**（`10f3594c`・PR #612）/ P2・P3 ○ |
| `replay --render` | セッション全体（評価列） | 高速 | spec のみ（#241 ○） |

**`replay --render` と #598 は別ではなく積** — `--render` = 何を流すか（ログ = transport 順の評価列）、
#598 P2 = どこへ書くか + 誰が駆動するか。**順序: #598 P2 → #241 → #598 P3。**

🔴 **owner の要求のうち「演奏しながら各トラックをパラで」は今日どこにも無い**（capture は master 1 本、
#598 はオフライン）。`thru: true` が効く場所であり、§7 に新規候補として立てた。

#### 840 / 1260 を録るのに足りないもの

① replayer（#241）② オフライン driver（#598 P2）③ per-bus（P1 ✅）
④ 🔴 **editor 経路のファイル名伝達** — `SESSION_LOG_SPEC_v1.md:80`「editor 経路は現状エンジンへ
ファイル名を渡さない（`setDocumentDirectory` はディレクトリのみ）ため v1 は
**`untitled.<timestamp>.orbslog`** フォールバック。**follow-up**」。
**840 / 1260 はエディタ経路なので、ログの名前が付かず後から特定できない。④ だけ issue が無い。**

#### instrument が render bus を拒否している理由

**出口の問題ではない。** #598 P3（instrument child のオフライン駆動）が要るため。
**出口を一般化しても消えない**（P3 まで `output(n)` は「受理して無音」）。

#### 追加の裁定（owner 2026-09-03）

**A** `send` は残す（機能は `output` と同じ意味論だが名前が直感的）/ **B** `send` も dB へ統一
（🔴 移行の手当ては未決）/ **C** master は `output` の出力先の 1 つ。

---

### docs(planning): 出口の一般化 — owner 裁定 4 件と、機能の持ち方の原理 (Sep 3, 2026)

**Issue**: #692 / **正本**: `docs/planning/DEVELOPMENT_MAP.md` §1b・§4.A.1・§4.N

地図の初版を owner が読み、**昨日・本日の議論の帰結が入っていない**と指摘。順に反映した。

#### 入っていなかったもの

1. **#681（GUI）が §4 に節を持っていなかった** — §1 と §8 に 1 行ずつあるだけで「いつ・何の後にやるか」が読めなかった → **§4.N** を新設
2. **LinkAudio のプラグイン化と「スルー」が繋がっていなかった** — 別々の節に並んでいるだけ
3. **「機能の持ち方」という原理が §4.E に埋まっていた** → **§1b** として上位へ

#### 🔴 §1b — コアは最小に保ち、機能はプラグインで足す

owner「オーディオエンジンの**コア機能以外のプラグイン化・モジュール化や DSL のプラグイン化**などで
**拡張性を担保してかつライセンス問題を解決**しましょう」。

**この立場は 2026-06-30 から存在していた** — `POST_2.0_PLUGIN_STRATEGY` §1「規格に乗れる所は乗り、
自分たちにしか作れない fundamental に希少な開発リソースを寄せる。**§2–§7 はすべてこのメタ原則の
インスタンス**」（引用を一次資料で照合済み）。地図の初版はこれを 1 領域の話として埋めていた。

**ライセンスは目的ではなく帰結。** #671 の拡張点が入れば、LinkAudio は CLAP へ・Link テンポは
DSL Plugin へ出せて **engine 本体から GPL が消える**（「隔離」から「外へ出す」へ）。
**未決**: 「コア」とは何か（`PLUGIN_STRATEGY` は fundamental に audio DSL を含むが、
#671 はその語彙をプラグインで足すと言う。線は #672 で owner 裁定）。

#### 🔴 出口の一般化（§4.A.1）— owner 裁定 4 件

> ラインは要素の列であり、`output(宛先, スルー, レベル)` もその 1 要素。**宛先に特別なものは無い**
> （master / sum / aux / Link / デバイス ch は同じ軸）。**フェーダーは出口のレベルであって段ではない。**

| # | 裁定 | 帰結 |
|---|---|---|
| ① スルーの既定 | **`false`** | 既存譜面の意味が変わらない |
| ② レベルの単位 | **dB** | 🔴 `send("rev", 0.3)` の線形が例外 = **静かに壊れる**（0.3 は線形 -10.5 dB / dB では +0.3 dB）。移行は未決 |
| ③ `output` が aux を指せるか | **指せる** | `send` との差 4 点の最後が消え、**`send` は糖衣になる**（畳むかは未裁定） |
| ④ フェーダーの持ち方 | **`output` の level。`gain` は残す** | `gain` = ライン全体 / `output(db:)` = その宛先へ行く分 |

未決: ⑤ フラグ名（main 推奨 `thru`）/ `send` を畳むか / ② の移行。

#### 検証で分かったこと（すべて一次情報）

- 🔴 **#649 のバグの正体**: master gain は core の render 内で per-frame ramp（`scheduler.rs:444-455`）、
  その**後**に post-loop が stage を `hw` へ**素のまま**加算（`output.rs:958` `*dst += *s`）。
  一方 `send` は同じ合流点で `*d += *s * send.gain`（`:965`）。**同じ場所で send だけが乗算を持つ。**
  level を出口の属性にすると乗算が合流点に固定され、**位置ずれがクラスとして起きえなくなる**
- **「宛先に特別なものは無い」は 2026-07-18 に決定済み**（SC.2.1 `var master = mix.output(1, 2)`・
  規範 (4)「バス自身もレシーバ」・決定 #78「master は出力エンドポイントの予約名」）。**未実装なだけ**
- **AUX の「戻り」は `send` の性質ではなく aux バス自身の性質**（MX.1）。`send` と `output` を分ける理由にならない
- **main の読みが 1 点外れた**: `GainManager` は「ライン全体」でも「master への送り」でもなく、
  `calculateEventGain` で**イベント生成時に畳み込む**（`event-scheduler.ts:106`）= 適用点が発音点

#### engine 側に残る制約（規則では消えない・#611 の仕事）

トポロジの固定順と sum ネスト不可（MX.4）/ master のステレオ固定（`transport.rs:60`）/
LinkAudio とミキサーの相互排他（PH.5）/ PDC 無し（#634）。

---

### docs(planning): 開発計画の地図を制定し、issue をその写像にする (Sep 3, 2026)

**Issue**: #692 / **正本**: `docs/planning/DEVELOPMENT_MAP.md`（Fable 起案・611 行）

#### なぜ作ったか

2026-09-03 の 1 日で main が**同じ内容の issue を 2 回重複起票**した（#686→#218 / #680→#506+#522）。
2 回目は 1 回目の反省を `PROJECT_RULES.md` に書いた**直後**。

owner 判断: **注意力の問題ではなく、121 件を並列に並べたまま順序も包含関係も無いことが原因。
地図を作り、issue をそれに合わせる**（既存番号は活かす = 案 A）。

#### 地図が持つもの

§0 運用規則（**番号ではなく地図の見出しで探す**）/ §1 再設計しない確定事項 / §2 依存グラフ /
§3 リリースまでの筋 / §4 領域別 13 節 / §5 Epic 裁定（**Epic issue は作らない。地図の節がその役割を持つ**）/
§6 統合一覧 / §7 新規候補 / §8 確定事項への提案 / §9 未確認一覧。

#### main の受け入れ検証で確認した 3 件

| Fable の主張 | 検証 |
|---|---|
| #506 のメソッド形は撤回済み → #680 を正本に | ✅ SC.10 規範 (4)「メソッド形で指す形は**撤回する**」（SC.10.9・owner 確定 2026-08-27） |
| #546 の「復元側は 1 行も無い」は古い | ✅ `packages/engine/src/core/project-state-store.ts:122` が `manifest.states[key]` を読む |
| #197 と #656 が矛盾 | ✅ #656 本文に「**vsix は基本リリースしない。**」 |

🔴 **3 件目は main の誤り** — #197 に `release-gate` を付けたとき #656 と突き合わせていなかった。ラベルを外した。

#### owner 決定 2 件（地図に反映）

1. **配布は `.app` と `.vsix` の両方**（Marketplace 経由かは未決）→ #656 の「vsix は出さない」を撤回
2. 🔴 **`must-fix` ラベルを新設** — 「リリースゲートというかバグフィックスで必ずやらないとダメなやつ」。
   `release-gate`（出荷物が成立しない）とは軸が違う。#661 / #606 / #645 / #649 / #385 に付与

---

### docs(index): 棚卸し記録を INDEX の Planning 表に載せる (Sep 3, 2026)

**追従元**: PR #690（マージコミット `84a2e95`）/ **Issue**: #689

PR #690 が追加した `docs/planning/2026-09-03-issue-triage.md` が
`docs/core/INDEX.md` の Planning 表（`docs/core/INDEX.md:213-217`）に載っておらず、
**目次から辿れない**状態だった。INDEX は CLAUDE.md が「すべてのドキュメントの目次（必読）」と
位置づけている入口なので、そこに無い文書は次の棚卸しで**もう一度同じ調査をやり直すことになる**。

行を 1 本足し、クラスタ C1〜C6 の見出しとラベル運用（`PROJECT_RULES.md` §1b）への導線を書いた。

**追従不要と判断したもの**: PR #690 は `packages/` / `rust/` を 1 行も触っていないため、
DSL 仕様（`docs/specs-v2/` / `docs/core/INSTRUCTION_ORBITSCORE_DSL.md`）・ユーザー向け語彙
（`sites/user/`）・内部構造（`sites/dev/`）はいずれも変化していない。

### chore(meta): issue 棚卸し 164→120 とラベル運用の制定 (Sep 3, 2026)

**Issue**: #689 / **記録**: `docs/planning/2026-09-03-issue-triage.md`

open issue が 164 件まで溜まり、タイトルだけでは生死が判別できない状態だった。**1 件ずつ実装と
突き合わせて** 44 件を処理（**164 → 120**）。

#### 🔴 最も古い issue が、最も正しかった

**#218**（2026-05-09）は「閾値超過に気づかないまま WORK_LOG が肥大化する」と予測しており、
**そのとおり 7.5 倍（14,926 行）になった**。しかも本日 main が同じ問題を **#686 として重複起票**
している（起票前の既存確認を怠った）。**タイトルだけ見れば「古い chore」だった。**

→ 棚卸しの作法を `PROJECT_RULES.md` §1c に明文化した（更新日で判定しない／閉じる根拠を残す／
残す場合も現存の証拠を残す／起票前に重複を確認する）。

#### 判定が変わった例

**#92（タイムストレッチ選定）**: `rubato` が入っているので完了に見えるが、**rubato はリサンプラ**で
`fixpitch()` が要求するピッチ保持のストレッチではない。#213 が未実装のまま = **選定は済んでいない**。

#### ラベル運用（`PROJECT_RULES.md` §1b）

🔴 **種別ラベルは足さない。** 164 件中 **162 件がタイトルに Conventional Commits の接頭辞を持つ**ため
二重管理になる。既存ラベルは **20% にしか付いておらず**、`icmc-blocker` のように**過ぎた期限を
名前にしたもの**が腐っていた（`legacy:` へ改名）。

新設は 2 枚のみ: **`foundation`**（他の issue の前提）/ **`release-gate`**（リリース前に必要）。
この 2 枚で「基礎 → その上」の順序が機械的に読め、設計の発注順が決まる。

#### 見えたクラスタ（設計の入力）

個別に着手すると同じ設計を繰り返す群を 6 つ記録した:
**C1 診断の整合**（#280/#644/#610/#255）/ **C2 プラグインの生存管理**（#418/#626/#637/#342）/
**C3 daemon 起動の失敗面**（#129/#383/#130/#367）/ **C4 時間の粒度**（#428/#680/#674）/
**C5 配布**（#656/#197/#184/#385/#659/#321）/ **C6 ミキサーの出力側**（#611/#409/#647/#598）。

🔴 **C4 は不整合が具体的**: パラメータは CLAP も VST3 も**サンプル精度で送れる**のに、
ノートは今も即時メソッド（`engine_wrap.rs:4455` に明記）。

## 2026-09-03: マージ後の head ブランチは自動削除（規則を owner の決定に合わせる）

#702 / #704 のマージで head ブランチが消えているのに気づき owner に確認 → 「増えすぎるし後からでも
追えるので自動で消すようにした」（owner 2026-09-03）。PROJECT_RULES の「ブランチは消さない」
（4 箇所）・CLAUDE.md の Branch Structure・BUNDLE_BRANCH_WORKFLOW（3 箇所）を「マージ後は
GitHub 設定で自動削除・履歴は merge commit から辿る」に訂正。統合ブランチも束 PR のマージ後に
消えてよい（自動削除はマージ後にしか動かないので、小 PR の base が途中で消えることはない）。

## 2026-09-03: PR #704 の追従監査（ドキュメント変更なし・指摘 3 件）

ルーチン「マージ済み PR にドキュメントとサイトを追従させる」を PR #704（`703-bundle-branch-workflow`
→ main・merge commit `3fa1150`）に対して実行。**追従すべきドキュメント変更は 0 件**。

- 差分 6 ファイルはすべて規約文書と CI 定義（`CLAUDE.md` / `docs/core/PROJECT_RULES.md` /
  `docs/development/BUNDLE_BRANCH_WORKFLOW.md` / `docs/planning/IMPLEMENTATION_PLAN_2026-09.md` /
  `docs/development/WORK_LOG.md` / `.github/workflows/claude-code-review.yml`）で、
  `packages/engine/` `rust/` `packages/vscode-extension/` に変更が無い。DSL の構文・意味論、
  MCP ツールの契約、OrbitStudio の評価経路のいずれも変わっていないので、
  `docs/specs-v2/` `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` `sites/user/` `sites/dev/` は追従不要
- `squash` → `merge commit` の訂正は差分内で完結している（リポジトリ全体を grep して、
  規約文書に旧記述の残りは無い。`sites/dev/en/signal-chain/index.md:1230` の "squashed" は
  信号処理の記述で無関係）

**追従できていない点として PR で報告した 3 件**（本ルーチンでは直さない）:

1. `CLAUDE.md:301` と `docs/development/BUNDLE_BRANCH_WORKFLOW.md:70` が小 PR のゲートで
   `ORBIT_GATED_ONLY` を既存の仕組みとして参照しているが、実装が無い。
   実在するのは `ORBIT_GATED_ORBITSTUDIO`（`tests/e2e/orbitstudio-mcp-gated.spec.ts:59`）で
   suite 全体の on/off。`ORBIT_GATED_ONLY` は `docs/design/668-e2e-foundation-design.md:891`
   の決定 D-4（未実装）
2. `.github/workflows/claude-code-review.yml` の最終実行は 2026-06-17（run #278）。
   今回足した `if: github.base_ref == 'main'` の効果を Actions で観測できない
3. PR #704 は最終 head `7f53a5d` の CI 完了を待たずにマージされている
   （CI 開始 10:29:37Z / マージ 10:29:39Z）。赤ではないが、マージ時点では未検証

## 2026-09-03: 束ブランチ運用の採用（#703）

owner との相談（PR #702 セッション）で、レビューの単位を PR から**束**へ変更。小 PR は束の
統合ブランチへ軽いゲート（CI + その PR が足した E2E を実機で + 目視）で入れ、統合ブランチ → main の
束 PR で `/simplify` → `/code:pr-review-team` + Fable → 実機 E2E 全件を 1 回だけ回す。
手引きは `docs/development/BUNDLE_BRANCH_WORKFLOW.md`（PR #702）。

| ファイル | 変更 |
|---|---|
| `CLAUDE.md` | 「PR レビューワークフロー」に「レビューの単位は束」節を追加。マージ前ゲートの対象・禁止事項 2 件・Branch Structure・Quick Workflow |
| `docs/core/PROJECT_RULES.md` | 「Git Workflow and Branch Protection」に統合ブランチと束の手順表・`Part of #N` / `Closes #N` の使い分け |
| `.github/workflows/claude-code-review.yml` | ジョブに `if: github.base_ref == 'main'`。bot レビューは束 PR だけ。`code-review.yml`（テスト CI）は触らない |
| `PROJECT_RULES.md`「Merging PRs」ほか | 🔴 **squash はリポジトリ設定で禁止**（#702 のマージで API が 405 "Squash merges are not allowed" を返した。main の履歴も merge commit）。旧記述の `--squash` を `--merge` に訂正し、束ブランチ運用の文書も merge commit 前提に統一 |

## 2026-09-03: 出口・レンダ宛先・コア境界の裁定を地図と issue に同期

**背景**: 地図 §9 の未決約 40 件を「owner が決めるもの / 調べれば分かるもの」に分けたところ、
出口まわりの数件がその場で裁定された。

**owner 裁定**:

1. **同じ宛先へ 2 回 `output` = 合算**。正確には「**解決後の宛先**が同じなら合算」
2. **master は終端ではなく単にアウト先の 1 つ** — `output(master, thru).output("3,4")` で
   master を 3/4 でモニターできる。🔴 **「終端」という概念が無い**ので、地図 §9 の
   「master ラインの終端の書き方」は**問い自体が消滅**
3. **render の宛先 = エンドポイント宣言**（`var stem = mix.render("stems/%n_%v.wav")`）。
   トラック別は **`%n` テンプレート**で宣言 1 行に畳む
4. **「コア」は先に定義しない。境界を引いた残りがコア**（#672 が「定義待ち」で止まらなくなった）
5. **入力系は今はやらない。** ただし「入力とは instrument が Audio I/O のインプットに
   なっただけ」= 新しい受け手を作らない、という置き場所は決着
6. **ログは ① 出力（#694）→ ② 本当にリプレイできるか確認（#241）→ ③ オフラインレンダ（#598）** の順

**main の誤りと訂正**:

- 「`send(` を使う譜面が 0 本だから移行不要」と書いた。owner 訂正:
  **「実装と実際の利用は関係ない」**。仕様が線形と定めている以上 dB へ直すのは実装の仕事で、
  既存資産の有無とは無関係。地図 §9 の「B の移行の手当て」は**未決ではなく作業**に降格
- (c)（エンドポイント宣言）を推した時、**トラック 30 本なら宣言 30 行**になる後退を見落として
  いた。owner の指摘で `%n` テンプレートに至った

**コードで確認したこと**: `%n` は実装可能。シーケンスは変数への代入時に名前を受け取る
（`packages/engine/src/core/sequence.ts:197-200` の `setName` → `stateManager.setName` +
`global.registerSequence`）。エラー文言も既にそれを使う（同 :354）。追加の記法は要らない。

**記録先**: 地図（§1・§1b.3・§4.A.3.1 新設・§9・§10）と issue #611 / #598 / #672 / #409 /
#679 / #694 の 6 本。issue 側には**実装チェックリストへの追加分**も書いた。

### 追記: 地図がリンクする open issue 70 本にチェックリストを充填（同日）

owner 指示:

> 地図でリンクしてる ISSUE に実装チェックリストを作って、実装時にちゃんと終わってるか、
> **終わってなければ理由は何か（変更になった、いらなくなったなど）をトラッキングできる**ように

6 班（sonnet subagent）に領域ごとに並行委譲。**39 本は同日早い時間に投稿済みだったため
重複を避け、残りに新規投稿**した。`PROJECT_RULES.md` §1d の書式に統一。

🔴 **変異検証はどのチェックリストにも既定で入れていない**（owner 2026-09-03 の投資順位:
① 仕様 → ② MCP 経由の E2E → ③ 機能テスト → ④ 変異検証は最後の手段）。

**エージェントが見つけた実質的な問題**（すべて地図 §9 に記録）:

| 発見 | 中身 |
|---|---|
| **移管先が宙に浮いている** | #474 の cmd+click は 2026-08-28 に #633 へ移管された記録があるが、**#633 マージ後もコード上は未実装**（grep 0 件）。移管したまま誰も持っていない |
| **地図と issue の食い違い** | #138 の吸収先 — 地図 §6.1 は「#656 へ」、#138 自身の棚卸しコメントは「#659 と統合が自然」。どちらも根拠つき |
| **枝番号の不整合** | #484 の「D4」が **issue 本文に一度も登場しない**（2026-07-26 指摘・未解決） |
| **本文が SC 時代のまま** | #213 の実装計画が SuperCollider 前提で、地図 §1「SC 退役」と矛盾 |
| **本文が古い** | #546 Phase 3 の復元側は本文が「読むコードが 1 行もない」のままだが、実際は完了済み |
| **未実装の確定** | `ORBIT_OUTPUT_BUFFER_FRAMES`（#368）は grep で未実装と確認 |

## 同日の追加裁定（本コミットに含む）

- 🔴 **ICLC には出さない**（owner）。藝大不採択の retarget 先が消え、**本番トラックから
  締切が無くなった** → 開発の順序は**地図 §3 のリリース道筋が唯一**になる
- 🔴 **WCTM の開発はこのリポジトリでやらない**（owner）。作品開発は WCTM 側セッションが持ち、
  必要な機能は**そこから機能要望として降りてくる** → 降りてきたら**普通の機能 issue** として
  扱う（「研究トラック」という別枠に入れない）。地図 §4.M の見出しを
  「研究・作品トラック（🔴 このリポジトリでは進めない）」へ変更

## 2026-09-03: 死んだ `.env.example` を削除（#708）

**実害**: sandbox 内でフック付きコミットが**必ず失敗**していた。

```
[FAILED] error: lstat(".env.example"): Operation not permitted
  ✖ lint-staged failed due to a git error.
```

Claude Code の sandbox は `./.env*` の読み取りを拒否する（秘密の保護）。`lint-staged` は
コミット前に `git stash` するので、`.env.example` を lstat した時点で落ちる。
🔴 **エラーが「git error」としか出ないため lint の失敗と紛らわしく**、本日の PR-E1 でも
原因調査に時間を使った。

**なぜあったか**: `9a7a7bae`（2025-10-26）で BFG により `.env` を履歴から削除した際、
テンプレートとして作られた。**その後、参照する仕組みが消えていた**:

| 確認 | 結果 |
|---|---|
| 中身 | Slack 通知用 env 4 個 |
| その env を読むコード | **0 件** |
| `.env` を読み込む仕組み | **`dotenv` 依存なし。何も読んでいない** |
| Slack 連携の実体 | **無い**（`slack` のヒットは SuperCollider の vendor と英単語のみ） |

**残した注意点**: `.gitignore` の `!.env.example` / `!.env.sample` / `!.env.template` は
**外部ツール管理ブロック**（`[code:security-patterns:fbe2794b]`・生成元はリポジトリ内に無い）
なので触っていない。したがって**将来 `.env.example` を再び置くと同じ問題が再発する**。

## 2026-09-03: stale ガードが再ビルド不能なファイルで発火していた（#713）

**実害**: 🔴 **実機 gated E2E が起動段階で全部落ちる。しかもガードが指示する対処では解消しない。**

```
Error: gated E2E: the daemon binary is older than the Rust sources, so this run would measure stale code.
  newest source: rust/crates/orbit-vst3-host/tests/spike_s_concurrent_load.rs
  binary:        2026-09-02T02:05:35.862Z
  source:        2026-09-03T00:53:01.573Z
```

指示どおり `npm run test:e2e:gated` を回しても `pretest` の cargo は
`Finished release profile in 0.21s` で**何もビルドしない**。当然で、そのファイルは
`orbit-vst3-host` の**統合テストターゲット**であり、`orbit-audio-daemon` のバイナリの
依存グラフに入っていない。**バイナリの mtime は永久に更新されず、ガードは永久に赤。**

**なぜ今まで出なかったか**: mtime は **`git checkout` で現在時刻に更新される**。
ブランチを行き来すると無関係な Rust ファイルが「最新のソース」になる。

**修正**（`assertDaemonBinaryIsNotStale`）: 走査から **`tests` / `benches` / `examples`** を除外。
別の cargo ターゲットなので daemon バイナリに入らない。⚠️ **`src/` は除外しない** —
daemon が依存するコードが新しければ、ガードは本来の役目どおり赤くなるべきである。

**仕組みで守る**（規律を文章で持たない）: `gated-assertion-hygiene.spec.ts` に検査 2 本。

| 検査 | red になる条件 |
|---|---|
| 除外の維持 | `tests` / `benches` / `examples` の除外が消えたら |
| **行きすぎの防止** | **`src` まで除外したら**（ガードの目的自体が失われる） |

**変異で両方向を確認した**（実出力）:

```
変異A: 除外を消す        → × keeps the stale guard off cargo targets it can never rebuild
変異B: src も除外する    → × still lets the stale guard see the sources the daemon is built from
restore 後              → Tests  5 passed (5)   ／ cmp で復元一致を確認
```

### 🔴 副産物: 実機 gated は現在 main で 11 件が意図的に red

ガードを直して初めて中身が走り、**20 件中 9 passed / 11 failed** だと分かった。
これは**退行ではなく、修正より先に書かれたテスト**である（一次情報:
`docs/design/649-audio-line-design.md` §B-0「**E2E-1 を先に書いて red 固定**」)。
修正は**段 1**（PR-O2 / #649・plan §3「段 1 の結果: `global.gain(-6)` が instrument に効く」）。

**したがって段 0 の小 PR のゲートは「実機 gated 全通し」にできない。**
正しい判定は **「失敗集合が before/after で同一」**（新しい失敗を作っていない）。
baseline（main + 本修正・2026-09-03 実測）:

```
#643 E2E-1〜E2E-7（7 件）
auto-records and restores all five plugin receiver kinds across a restart without explicit saves
drives real OrbitStudio end-to-end: diagnostics-on-open, run_selection, live edit, capture verification
replaces a playing instrument across CLAP/VST3 ... (#618 E1-E6)
steps the live playhead through an instrument() sequence, rests included
```

E2E-2 / E2E-3 の dry RMS が **ちょうど 0**、E2E-1 の比が **1.27**（gain が効いていない値）
という内容も、段 1 が直す欠陥と一致している。

## 2026-09-03: #713 のガード変更に dev 学習サイトを追従させた（docs のみ）

**対象**: PR [#714](https://github.com/signalcompose/orbitscore/pull/714)（merge commit `f006a51`）。
コード・テストは一切変更していない。

PR #714 は引用のアンカー（`// FILE:START-END` 形式の見出し行）を直したが、**引用を囲む本文**と
`## Sources` の行範囲は旧状態のままだった。`docs:check` は前者しか検査しないので、後者は
red にならずに残った。この 2 種を追従させた。

**本文の乖離 2 件**（どちらも #714 で挙動が変わった箇所を古い説明のまま記述していた）:

| 場所 | 旧記述 | 実態 |
|---|---|---|
| `sites/dev/rust-engine/capture-verification.md` / `sites/dev/editor/mcp-and-gated-e2e.md` | ガードは `rust/**/*.rs` \| `Cargo.toml` を走査 | `tests` / `benches` / `examples` を除外する（#713） |
| `sites/dev/editor/mcp-and-gated-e2e.md` | 「残り **2 本**」（アサーション衛生は 3 本） | #713 で 2 本増えて **5 本** |

両章に #713 の節を足した。走査除外の理由（別 cargo ターゲットなので daemon バイナリに入らない・
`git checkout` が mtime を動かすので解消不能な赤になる）と、`src/` を除外しない理由、
`gated-assertion-hygiene.spec.ts` の 2 本が両方向を留めていることを書いた。
ja / en 両方（STYLE_GUIDE のバイリンガル必須）。

**`## Sources` の行範囲**: ガードが 15 行伸びたので、`orbitstudio-mcp-gated.spec.ts` の
128 行目以降を指す参照はすべて +15 ずれていた。6 章 × ja/en で 12 ファイル分を直した
（`78-152` → `78-166`、`1434-1468` → `1449-1483` など）。境界行は実ファイルで確認済み。

**frontmatter**: 本文を実質的に足した 2 章（RE-4 / IV-3）の `verified-against` を
`69dc968` → `f006a51`、`verified-at` を `2026-09-03` に更新した（STYLE_GUIDE
「章本文を実質的に書き直したとき: 必ず最新 commit に更新する」）。

### 追従の過程で見えた、直していない点

このセッションでは**指摘のみ**（テスト・実装は変更しない方針のため）。詳細は PR 本文。

1. `tests/e2e/gated-assertion-hygiene.spec.ts:76-83` / `:89-93` は gated spec の**ソース文字列**を
   正規表現で見るだけなので、「除外ブロックを `walk(full)` の**後ろ**へ動かす」変異
   （除外が到達不能になり #713 の赤が戻る）で **2 本とも緑のまま**になる
2. 同 `:77` は式の**字面**に依存するので、`Set` へ畳む等の挙動不変なリファクタで red になる
3. `assertDaemonBinaryIsNotStale()` は `tests/e2e/orbitstudio-mcp-gated.spec.ts:164-166` の
   `gated && appAvailable` の下でしか呼ばれない。CI は全ジョブ非 gated なので、
   #713 で足した 15 行は**どこでも 1 行も実行されていない**

## 2026-09-03: PR #700 のドキュメント追従（ICLC 取り下げ / WCTM の持ち先 / §10 の表崩れ）

**追従元**: PR [#700](https://github.com/signalcompose/orbitscore/pull/700)（マージコミット `ca176f0`・head `f5b16d8`）。
docs のみの変更で、`CLAUDE.md` の本番トラック注記・`docs/planning/DEVELOPMENT_MAP.md`・本 WORK_LOG を更新していた。

**#700 が `CLAUDE.md` にしか書かなかったため、同じ注記を持つ他のドキュメントが古いまま残っていた:**

| ファイル | 何が古かったか |
|---|---|
| `docs/core/INDEX.md:39` | 「本番トラックは ICLC への proposal 提出方向へ retarget（年次・提出日・提出形態はいずれも要確認）」 |
| `docs/core/INDEX.md:207` | 同じ retarget 注記（WCTM 調査群の凍結セクション） |
| `docs/core/INSTRUCTION_ORBITSCORE_DSL.md:18` | 「ICLC 提出方向へ retarget（年次・提出日・形態は要確認）」 |
| `sites/dev/decisions/adr-001-supercollider.md:267` / `:314`（+ `en` 対訳） | 「Consequences revisited」の 3. 学術的文脈が ICLC retarget で止まっていた |

いずれも **ICLC 取り下げ（owner 2026-09-03）・本番トラックに締切が無い・WCTM 本体の開発は本リポジトリで進めない**
の 3 点へ書き換えた。`sites/dev` は日英両方を更新（STYLE_GUIDE のバイリンガル必須）。

**#700 が入れた表崩れも直した**: `DEVELOPMENT_MAP.md` §10 で、追記の箇条書きと更新履歴テーブルのヘッダ行の間に
空行が無く、GFM ではテーブルがリスト項目の遅延継続として吸われて**描画されない**状態だった
（`docs/planning/DEVELOPMENT_MAP.md:1463-1464`）。空行を 1 行入れただけで、本文は変えていない。

**追従しなかったもの**: #700 が記録した出口・レンダ宛先・`%n` テンプレートの裁定は、地図自身が
「spec への反映は §6.2 の改訂候補（owner 裁定で行う）」と書いているため `docs/specs-v2/` と
`docs/core/INSTRUCTION_ORBITSCORE_DSL.md` へは**反映していない**（実装も未着手で、DSL 表面は変わっていない）。


## 2026-09-03: PR #709 追従 — 失効した landmine 記述を更新

PR #709（`7d2df31`・上記 #708）で `.env.example` を削除した結果、
`docs/development/POST_2.0_VST3_HOSTING_PLAN.md:256` の landmine 記述が**失効した**。

| | 内容 |
|---|---|
| 旧記述 | 「`.env.example` は sandbox read-deny → `git diff` が誤って削除表示。`git status --short` が権威」 |
| なぜ失効か | ファイルが実在しなくなったため、この誤検知は起きない |
| 🔴 なぜ放置できないか | **実際に削除された今、この記述は「`.env.example` の削除表示は無視してよい」と読める** — 真の削除を sandbox の誤検知と取り違えさせる |

取り消し線で旧記述を残したうえで、解消済みであることと、`.gitignore:55-57` の
un-ignore 行が残っているため**再設置すると再発する**ことを追記した。

**追従不要と判断した層**（PR #709 の差分は `.env.example` 削除と WORK_LOG 追記のみ）:

| 層 | 判断 |
|---|---|
| DSL/言語仕様（`packages/engine/`） | 差分に含まれない。構文・意味論・`.orbslog` 形式に変化なし |
| ランタイム/MCP（`rust/`） | 差分に含まれない。MCP ツールの引数・返り値・エラー挙動に変化なし |
| OrbitStudio（`packages/vscode-extension/`） | 差分に含まれない。評価フロー・診断・補完に変化なし |
| `sites/user/` `sites/dev/` | 削除したファイルを参照する記述は 0 件（repo 全体 grep で確認） |

## 2026-09-04: ルーティンのドキュメント追従 PR を溜めない規則（#718）

**実害**: ルーティンが出したドキュメント追従 PR **9 本のうち 8 本が衝突**し、1 本ずつ手で解決した。

| PR | 結果 |
|---|---|
| #716 / #717 | **出てすぐ入れた → clean** |
| #688 / #691 / #698 / #701 / #705 / #710 / #711 | **溜めた → 全部衝突** |

**原因**: ルーティン PR の差分は**「追従した時点の main」に対して計算されている**。その後 main に
入る 1 コミットごとに陳腐化する。待たせている間に #709 / #714 / #716 と束の追従が入り、
`WORK_LOG` の追記位置・`INDEX` の項目・各ドキュメントの **`## Sources` の行範囲**と
**引用のアンカー**が全部ずれた。

🔴 **片側を捨てると情報が落ちる**ので、機械的な解決ができない。実例:

- **#688**: 「archive パスへの修正」（PR 側）と「ICLC 取り下げの追記」（main 側）が**同じ行**で衝突。
  両方が正しいので、パスは PR 側・文末は main 側を採った
- **#711**: `## Sources` は束側が最新だったが、`helpers/rack-child-pid.ts` の行は PR 側にしか無かった

**規則**（owner 合意）:

1. main に何かをマージしたら、**ルーティン PR が出た時点でその場で入れる**
2. 遅くとも **統合ブランチを main から切る前**に全部消化する
3. 🔴 **base の選び方**: 追従先のファイルが**束にしか無い**なら base は **統合ブランチ**にする。
   main を base にすると引用が実ファイルを指せず `docs:check` が落ちる（#711 が実際その状態だった。
   #717 はルーティン自身が正しく束を base にしていた）

**止めない理由**: 🔴 **ルーティンは機械が見ていない層を見ている。** `docs:check` は**引用のアンカー
しか検査せず**、引用を囲む**本文**と **`## Sources` の行範囲**は検査しない。#716 はまさにそこを
検出した（#714 でガードの走査範囲を変えたのに、本文は「`rust/**/*.rs` を走査」のまま）。

**自動マージにもしない**: #688 の本文には事実誤認があった（「vitest を回す CI チェックは 1 本も
存在しない」— 実際は `code-review.yml:26` が `npm test` を実行している）。人が読む前提は変えない。

## 09-10 の移設（本体の 2,000 行上限・2026-09-11・凍結版リリース直前）

### docs(sites): follow #840 — the SC path is deleted, not "scheduled for deletion" (#502) (Sep 10, 2026)

束 [#840](https://github.com/signalcompose/orbitscore/pull/840) のマージ後追従（docs のみ・コードとテストは触っていない）。
束の中で docs 追従は概ね済んでいたが、**「削除が決まっている」で止まっていた記述**と、
**束の途中で自分の前半コミットに追い越された記述**が残っていた。

#### 図が prose と食い違っていた（0-2 アーキテクチャ全景）

`sites/dev/orientation/architecture-overview.md` は本文で「#502 で削除された」と書きながら、
**Mermaid の図は `audio/supercollider-player.ts` ノード・`env.ORBITSCORE_ENGINE` の spawn ラベル・
`ORBITSCORE_ENGINE=sc のときだけ` の点線・`scsynth` ノードを描いたまま**だった。
本章の図は「4 種類のプロセス」を説明する主役なので、prose だけ直しても読者は図を信じる。
図から SC を落とし、§「SuperCollider 経路」を過去形へ書き直した（ja / en）。

#### 束の中で自分に追い越された記述

| 記述 | 何が起きたか |
|---|---|
| `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` の master effects 警告ブロック | `94cfbfc` で置いた「`... not supported yet (A4 era) ...` を **1 回だけ** warn」が、同じ束の `7ce7afa`（warnOnce のキーを `(操作, effect 種別)` にした fix）で**古くなっていた**。新しい文言と、`compressor()` の次の `limiter()` が無言で失敗していた欠陥の記録に差し替え |
| `sites/dev/editor/vscode-architecture.md` の #836 warning ブロック | 「拡張側の TypeScript は #836 では触られていません（撤去は次の PR）」— その「次の PR」が同じ束の #838 で、`resolveScsynthForUI()` は関数ごと消えている |
| `sites/dev/glossary.md` の `bundle`(scsynth source) | 「型と分岐そのものは `scsynth-resolver.ts` に残っています」— #838 でファイルごと削除済み |

#### 実態と食い違っていた 3 件

- **`restrictedConfigurations`**: glossary が「2 件挙げている」と書いていたが、`package.json` は
  **空配列**（`orbitscore.scsynthPath` / `orbitscore.engine` が消えたため）。
  `vscode-architecture.md` は束の中で正しく直っていたので、glossary だけが取り残されていた
- **status bar item**: 「scsynth 解決状態 (priority 99)」→ `bundleStatusItem` は現在
  **daemon** が解決できないときだけ出る（`extension.ts` の `updateBundleStatus()`）
- **ADR-003 の回避方法**: 「残る回避方法は `ORBIT_SCSYNTH_PATH` だけ」→ #840 でそれを読むコードが
  無くなったので、**回避方法は残っていない**

#### LinkAudio — 表の 1 行だけが断定に戻っていた

`sites/dev/rust-engine/index.md` の command 表は `LINK_AUDIO_UNAVAILABLE` について
「TS 側は 1 回だけ warn して hardware で続行する」と断定していた。同じ章の本文は
`4d5aca0` の訂正（コメントが出典・実機では capture RMS 0 で警告も無し）を既に載せている。
**要約表が本文と反対のことを言っていた**ので、「設計の意図。実機ではそう振る舞っていない（未決）」へ。

#### やっていないこと

- `packages/` `rust/` の実装・テストは**一切変更していない**（`dsl-e2e-coverage.spec.ts` の baseline を含む）
- `docs/archive/WORK_LOG_*.md` は起案時点の記録なので触っていない
- `docs/specs-v2/` は SC / `ORBITSCORE_ENGINE` / master effects の記述を持たないため追従不要

---

### docs(link-audio): tell the truth about the deleted Link submodule and the unresolved fallback (#502) (Sep 10, 2026)

Fable 受け入れ監査（PR #840）の指摘を適用した。**Important 2 / Minor 4**。

#### 🔴 Important — 消した submodule を案内し続ける build script

`rust/crates/orbit-link-audio/build.rs` は Link のヘッダを
`packages/sc-link-audio/external_libraries/link` に既定で探し、無ければ
`git submodule update --init packages/sc-link-audio/external_libraries/link` を案内していた。
本束は `.gitmodules` と gitlink を消したので、**その案内はもう "no submodule mapping" で失敗する**。

`build.rs` の冒頭コメント自身が「Link submodule は **SC plugin と共有**する」と書いており、
**SC 専用ではなかった**。owner 裁定（`NATIVE_MIGRATION_2026-09.md` §12.5）は
`packages/sc-link-audio` を「**SC 専用なら**同時に削除」としていたので、共有物を消す判断は
明示的にはされていない。

| | |
|---|---|
| 出荷ビルド | **影響なし**。`link-audio` feature は default off |
| 新規クローン | `--features link-audio` が build.rs の panic で落ちる（実測: 新しい worktree に `link/include/ableton/LinkAudio.hpp` が存在しない） |
| 既存クローン | **成功してしまう**。gitlink を消しても git は submodule の作業ディレクトリを消さない。**手元の緑は証拠にならない** |
| CI | 検出不能。`rust-ci.yml` は ubuntu で、`build.rs` は `target_os != macos` で先に panic する |

**対処**: panic 文言を実態（`ORBIT_LINK_DIR` で Link の checkout を指す）に直し、
crate の扱いそのものを **#845** の裁定事項として立てた（main の推奨は crate の退役）。

#### 🔴 Important — リファレンス表が仕様と逆のことを書いていた

`sites/user/reference/methods.md`（ja / en）は LinkAudio 無効時に
「音はハードウェア出力に出て、警告が 1 回出ます」と**事実として断定**していた。
一方 spec §8.1 と `sites/user/midi/link-audio.md` は「設計の意図と実測が食い違っていて未決・
LinkAudio を前提にした演奏はしないこと」と書いている。**同じ束の中で矛盾していた。**
リファレンス側を「未決」に揃えた。

#### Minor

- **行番号での出典が既にずれていた**（`orbitstudio-mcp-gated.spec.ts:5113-5119` → 実際は 5252-5256）。
  main を merge するたびにずれるので、**行番号をやめて文言で参照する**ようにした
  （「A comment is not evidence of implementation behavior」で始まるコメント）。5 箇所
- 仕様の消し残し 3 件: 削除済みディレクトリを理由にフルパス表記を要求していた記述 /
  「Choose output device via command palette」（コマンドは本束で削除・現在は Engine view と MCP）/
  「buffer caching on the SC path」
- `sites/dev` の glossary（ja / en）が `ORBITSCORE_ENGINE` を**現行の環境変数として定義**し、
  `AudioEngineBackend` を「`SuperColliderPlayer` と `RustEnginePlayer` の両方が満たす」と
  書いていた。両方直した
- `sites/dev/**` の散文には同種が **107 行 / 20 ファイル**残っている。引用ブロックは
  付け替え済みで `docs:check` は緑だが散文が現在形。束の外へ切り出した（**#846**）
- 出荷 README の `✅ engine: rust (native)` と `numInputBusChannels` の記述は **#842 で解消済み**

#### 監査が「無し」と確認した主なもの

削除された識別子・設定キー・コマンド ID・MCP ツール名の残存参照（`build.rs` を除き 0）/
型検査を通らない経路（実行時 `require` は実在するモジュールのみ）/ `contributes.commands` 15 件 ⊆
`registerCommand` 18 件 / 旧 `SuperColliderPlayer` の public 面 19 メソッドの突合（Rust に無いのは
master effects・LinkAudio・device の 3 スタブで、いずれも本束が文書化済み）/ `sync-dist.js` の
写像（`rootDir: ./src` / `outDir: ./dist` と整合・read-only 実走で kept 440 / orphans 0）

### fix(engine): make each master effect warn, and stop audioDevice from promising a restart (#502) (Sep 10, 2026)

`/code:pr-review-team` ラウンド 1（4 レビュアー）の指摘を適用した。**Critical 1 / Important 2 /
Minor 1**、fixer は main（Codex は sandbox の EPERM で起動できなかった）。

#### 🔴 Critical — 2 つ目以降のマスターエフェクトが完全に無音で失敗していた

`RustEnginePlayer.addEffect` / `removeEffect` は `warnOnce('masterEffect', ...)` を
**discriminator 無しで**呼んでいた。`warningKey` は discriminator が無いと `kind` そのものを
キーにするので、**1 セッションにつき 1 回しか warn しない**。一方 `EffectsManager` は
`🎛️ Global: compressor(...)` を**無条件に**出す。したがって

```
global.compressor(...)   // warn が出る
global.limiter(...)      // ✅ に見えるログだけ出て、警告は出ない・音も変わらない
```

という普通のマスタリングチェーンで、2 つ目以降が**気づく手段なく落ちる**。
`(操作, effect 種別)` を discriminator にした。文言も「代わりに master バスへ
CLAP / VST3 プラグインを置け」まで言うようにした。

🔴 **既存テストがこの欠陥を固定していた**。`rust-engine-player.spec.ts` の
「master effect は 1 回 warn して no-op」は `expect(fxWarns.length).toBe(1)` で、
**3 種類の操作をして 1 回しか warn しないこと**を期待値にしていた。期待値を反転し、
種類ごと・操作ごとに warn すること（3 回）と、同じ操作の繰り返しは増えないことを固定した。

#### Important — `global.audioDevice()` が嘘の案内をしていた

`RustEnginePlayer.getCurrentOutputDevice()` は常に `undefined` を返すので、この DSL メソッドは
必ず `⚠️ Restart the engine to change audio device` を出して**何もしない**。再起動しても
変わらない。実際の切り替え経路は VS Code 設定 `orbitscore.audioDevice`（エンジンビュー /
MCP の `select_audio_device`）だけで、DSL からは配線されていない。
**行き先を名指しするメッセージ**に置き換えた。

#### Minor — `sync-dist.js` の `exists()` が全エラーを「不在」に畳んでいた

この判定はそのまま `fs.rm` の根拠になる。EACCES 等を不在に畳むと**正当な出力を消して
`.vsix` からモジュールが欠ける**（#654 と同じ形）。ENOENT だけを不在として扱い、
他は投げるようにした。

#### テスト — 出荷物の中身を決めるロジックにテストが 0 本だった

`pruneOrphanedOutputs()`（本束で新設）は `.vsix` に何が載るかを決めるが、
**間違えても npm test もビルドも緑のまま**通る。`sync-dist.js` を
`require.main === module` でガードして `require` 可能にし、
`tests/build/sync-dist-prune.spec.ts` に 7 件足した:
4 種類の接尾辞の削除 / `.tsx` 由来を残す / `.ts` 由来でない成果物に触らない /
空になったディレクトリを畳む / 入れ子を post-order で畳む /
生き残りがあれば親を残す / `sourceStemFor` の境界。

#### そのほか（comment-analyzer）

- `CONTRIBUTING.md` が `ORBITSCORE_ENGINE=sc` opt-out 経路を現在形で説明したままだった。
  README / CLAUDE.md / PROJECT_RULES / INDEX / CONTEXT7_GUIDE / TESTING_GUIDE は直っていて、
  **CONTRIBUTING.md だけ列挙から漏れていた**
- `README.md` と `CLAUDE.md` のテスト件数が 2026-09-02 の `2165 / 2233` のままで、
  本束が spec 7 本を消した後の値になっていなかった。**出典（日付・commit）付きで**
  `2271 passed / 58 skipped / 2329 total` に更新した

#### 指摘のうち採らなかったもの

- code-reviewer: Critical 0 / Important 0（型検査・全テスト・docs ビルド・`sync-dist.js` の
  実走まで確認した上で「配線漏れ無し」）
- pr-test-analyzer の Important 2（`chop-timing.spec.ts` の `sampleId` 未検証は本束が
  持ち込んだ後退ではない / docs:check 198 件は上記のとおり解消済み）

### refactor(build): prune the engine dist by source presence instead of by name (#502) (Sep 10, 2026)

`/simplify`（4 エージェント）の指摘を適用した。

**採用（altitude + efficiency の合流点）**: `packages/engine/scripts/sync-dist.js` の
`removeRetiredBackend()` は `audio/supercollider` / `supercollider-player.*` という
**SC 固有のファイル名を汎用ビルド道具の中に埋め込んでいた**。守りたかったのは
「`tsc --build` の増分は、ソースを消しても出力を消さない」ことであって SC ではない。
**`src` に対応する `.ts`（`.tsx`）が在るかで判定する `pruneOrphanedOutputs()`** に置き換えた。
次に何を消してもこのスクリプトを直す必要がない。1 ディレクトリ内は `Promise.all` で並行に
処理し、空になったディレクトリは畳む。`.ts` 以外から来た成果物には触らない。

旧 root-copy / bundle 経路が `engine/` 直下へ置いた `supercollider/` `scsynth/`
`audio/supercollider` は `tsc` の出力ではないので突き合わせでは拾えない。
**一度きりの移行掃除**として明示的に消す（コメントでそう書いた）。

**採用（消し残し）**: `ORBITSCORE_ENGINE=sc で SC に opt-out` を説明したままのコメントが
3 箇所残っていた（`interpreter-v2.ts` / `cli/repl-mode.ts` / `audio/rust-engine/index.ts`）。
env var も `resolveEngineKind()` も本束で消えているので、**存在しない経路を説明していた**。
`rust-engine-player.ts` の冒頭コメントは機械置換の跡で「既定（唯一の）バックエンド
（唯一のバックエンド）」と二重化していた。あわせて直した。
`packages/vscode-extension/package.json` は `keywords` と `scripts` から要素を消した跡が
空行 5 行として残っていたので削除した。

**見送り（理由を残す）**: `AudioDevice` 型（`audio/types.ts`）は `RustEnginePlayer` の
3 つのスタブ（常に `undefined` / `[]` / no-op）でしか使われておらず、同種の型が
`daemon-client.ts` の `AudioDeviceListEntry` と `mcp-server.ts` の `AudioDeviceInfo` にもある。
3 系統あるのは確かに冗長だが、**削除は `AudioEngine` インターフェースの変更**になり
凍結線の直前に入れる変更ではない。`AudioEngineBackend` の継ぎ目も、ネイティブ
OrbitStudio の新ライン（#827）で第 2 実装が来る見込みなので残す。

**検算**: `npm run build` 緑（`sync-dist.js` を実走）・`npm run lint` 緑・
`npm test` **2271 passed / 58 skipped / 2329**・引用チェック 934 件 / 0 失敗
（行シフト 4 件を `--fix` で再アンカー）。

### docs(spec): the LinkAudio fallback claim was a comment, not a measurement (#502) (Sep 10, 2026)

#833 で §8.1 に置いた警告ブロックは「daemon が `LINK_AUDIO_UNAVAILABLE` を返し、TS 側が
1 回だけ warn して継続する。出力は hardware のみ」と**断定していた**。これは
`rust-engine-player.ts` の `registerLinkAudioChannel` の**コメントの主張**であって、実測ではない。

`tests/e2e/orbitstudio-mcp-gated.spec.ts` に残っている記録によれば、2026-09-04 の main の
実機実行では `global.linkAudio()` 下の sequence の **capture RMS = 0**、かつ `get_log` に
`LINK_AUDIO_UNAVAILABLE` も gap 警告も出ていない。capture ベースの証明はこの理由で
取り下げられている。つまり**音が出ず、警告も出ない**。

仕様側を「設計の意図 / 実測」の 2 行表に書き換え、**どちらが正しいかは未決**であることと
出典を明記した。ユーザー学習サイト（`sites/user/midi/link-audio.md`）は #835 で既にこの
扱いになっており、**仕様だけが古い断定のまま残っていた**（memory
`one-layer-of-the-spec-lags-the-ruling` と同じ型）。

引用 4 件が行シフトで動いたので `--fix` で再アンカーした。

### docs(readme): rewrite the shipped README for the stable GitHub Release (#841) (Sep 10, 2026)

拡張版 stable リリース（#827 §12）の手順 4。`.vsix` に同梱される
`packages/vscode-extension/README.md` と root `README.md` を、**出荷物の実態**に合わせた。

**直した事実誤り 3 件**（いずれも出荷物に対して偽だった）:

| 箇所 | 旧記述 | 実測 |
|---|---|---|
| LinkAudio | 「OrbitScore acts as the Link tempo leader; Ableton Live follows OrbitScore's tempo」 | daemon の feature `link-audio` が default off。`copy-daemon-bin.sh` も `release.yml` も `--features outproc-effect,outproc-instrument` のみ。egress も §8.1.4 の tempo push も同じ feature に依存する |
| Intel Mac | 「Untested (bundled binary is universal but not actively verified)」 | `release.yml` の `VSIX_TARGET: darwin-arm64`。universal ではない。方針も Apple Silicon のみ |
| time-stretch / pitch shift | root README が `.time()` / `.fixpitch()` を Core Features に列挙 | `parser/types.ts:493` に「'time' and 'fixpitch' removed - not yet implemented」。#213 で defer 中 |

**追加**: `global.compressor()` / `limiter()` / `normalizer()` が native engine で no-op であることを
「Not in this build」表に明記した（#502 で唯一の実装だった SC synthdef が消えたため）。

**🔴 LinkAudio の記述を実測に合わせ直した（自分の初稿の誤り）**: 最初「音は hardware へ出る」と
書いたが、これは `rust-engine-player.ts` の**コメントの主張**であって実測ではない。
`tests/e2e/orbitstudio-mcp-gated.spec.ts` の記録によれば、2026-09-04 の実機実行では
`global.linkAudio()` 下の sequence の **capture RMS = 0**、かつ `get_log` に
`LINK_AUDIO_UNAVAILABLE` も gap 警告も出ていない。つまり**音が出ず警告も出ない**。
仕様（§8.1）とどちらが正しいかは未決なので、README には「未決であり LinkAudio を前提にした
演奏はしないこと」と書いた。ユーザー学習サイト（`sites/user/midi/link-audio.md`）は
#835 で既に同じ扱いになっていた。

**AU ホスティングの偽記載を削除**: walkthrough ステップ 4 が ja / en とも
「CLAP / VST3 / AU をホストできます」と書いていたが、`PluginFormat::from_env_value` は
`clap` / `vst3` **以外を Err で弾く**（`outproc_effect.rs:338-346`）。AU の child バイナリも
crate も存在しない。walkthrough の md と `package.json` の step description の両方を直した。
🔴 **walkthrough は `.vsix` に同梱されるので、これは出荷物の偽記載だった。**

**その他の追従**: `✅ engine: rust (native)` ステータスバー表示は #108 以降存在しない
（健全時はインジケータを出さない・`updateBundleStatus`）。コマンド一覧が 5 件しか載っておらず
プラグイン系・walkthrough・MCP 登録が抜けていた。設定一覧が 5 件で `engineDebug` /
`mcpServer.port` / `playheadPalette` が抜けていた。いずれも `package.json` の `contributes` から
実体を引いて書き直した。

**入手経路**: Marketplace / Open VSX には出さない（owner 2026-09-10）ので、
両 README とも **GitHub Release の `.vsix`** を先頭に置いた。

**版番号は据え置き**: 見出しから `(2.0.0)` を外して版に依存しない形にした。実際の版番号更新は
手順 5（owner 裁定）で行う。

### docs(spec): record that the global mastering effects are no-ops after the SC removal (#502) (Sep 10, 2026)

束 #840 を締める前の追従。`INSTRUCTION_ORBITSCORE_DSL.md` の Implementation Status は
`global.compressor()` / `limiter()` / `normalizer()` を **Completed Features ✅** に載せていたが、
実装は **SC の synthdef（`fxCompressor` / `fxLimiter` / `fxNormalizer`）だけ**で、#502 で
scsynth ごと削除した。`RustEnginePlayer.addEffect` は最初から
`⚠️  [rust-engine] master effect "..." is not supported yet (A4 era)` を 1 回 warn して
no-op に倒す実装で、**出荷される `.vsix` にはこの 3 つを実行する経路が無い**。

DSL 語彙（`signal-chain/runtime.ts` の `GLOBAL_DSL_METHODS`）には残っているため
**構文としては受理される**。表面から外すのは破壊的変更なので owner 裁定事項として保留し、
仕様側に警告ブロックを置いた（LinkAudio egress と同じ扱い）。代替は
CLAP / VST3 プラグインのラック（`global.effect(...)`）。

v2.0 の変更履歴側にも「SC と master effects はどちらも #502 で撤去、前者は Rust daemon に
置き換わり後者は代替なく no-op」を追記した。

**検算**: `sites/user/**` の compressor/limiter への言及は 2 件ともプラグイン effect
（`seq.effect()` / `sum("bus").effect()`）の話で、`global.compressor()` ではない。誤記なし。

### docs(readme): drop the deleted SuperCollider paths from the repository tree (#502) (Sep 10, 2026)

束 #840 を締める前の追従。root `README.md` のディレクトリ図が
`packages/engine/src/audio/supercollider/`・`packages/engine/supercollider/`・
`packages/sc-link-audio/` を**現存するものとして**描いていたため、実体に合わせた
（3 経路とも #838 / #836 で削除済み）。`vscode-extension/` が `packages/` の末子に
なったので罫線も直した。

残る `SuperCollider` の語（Phase 7 の完了表・#136 の merged 表・冒頭の「#502 で削除された」）は
**履歴の記述**なので残す。README 全体の書き換えは stable リリースの手順 4 で別途行う。
### docs: follow PR #838 in the dev site, the core spec and the user manuals (#502) (Sep 10, 2026)

PR [#838](https://github.com/signalcompose/orbitscore/pull/838)（merge commit `585f495`）に
ドキュメントを追従させた。**実装・テストは一切変更していない**（docs のみ）。

**直したもの**（いずれも #838 の差分で「現存する」記述が偽になった箇所）:

- `sites/dev/editor/vscode-architecture.md` — プロセスツリー図から scsynth 分岐を削除、
  全体図の mermaid から `getConfiguredEngineKind()` / `resolveScsynthForUI()` / scsynth ノードを削除、
  目次と見出し 2 件（アンカー切れの修正を含む）、Sources の `extension.ts` 行番号を実測値へ
  （`:653-710` → `:628-642` ほか）
- `sites/dev/glossary.md` — `ORBITSCORE_ENGINE` / `AudioEngineBackend` / StatusBarItem /
  workspace trust の各項と、SC 用語・scsynth resolver 用語のセクション見出しを「削除済み」へ
- `sites/dev/orientation/architecture-overview.md` — 全体図から SC ノードと
  `env.ORBITSCORE_ENGINE` エッジを削除、§SuperCollider 経路を過去形へ
- `sites/dev/{index,README}.md` / `.vitepress/sidebar.ts` /
  `orientation/what-is-orbitscore.md` — Part VII の「削除決定」→「削除済み」
- `sites/dev/pipeline/selective-execution.md` / `scheduling/{transport,event-queue}.md` —
  spawn 時の env・`createAudioEngine()` の意味論・削除済みファイルへの Sources 参照
- `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` — 「`supercollider/` にもう 1 つ
  `event-scheduler.ts` が**ある**からフルパスで書く」という根拠が失効した旨へ書き換え
- `docs/specs-v2/IMPLEMENTATION_INSTRUCTIONS.md` §2 — パッケージ一覧に失効注記
  （`packages/sc-link-audio` は #836、`supercolliderjs` は #838 で削除済み）
- `docs/user/{ja,en}/USER_MANUAL.md` — DEPRECATED バナーに、SC / scsynth 記述が
  全て失効した旨（`orbitscore.scsynthPath` / `orbitscore.engine` / `Force Kill scsynth` /
  `Select Audio Device` / `force_kill_scsynth` / `ORBITSCORE_ENGINE`）を追記
- 🔴 **日英両方**を更新（`sites/dev/en/` 配下の同一パス）

**検証**: `npm run docs:check` = **934 verified / 0 failed**（#838 merge 時点と同値）。
user-site / dev-site の `docs:build` はいずれも成功。`docs:check` を壊さないため
`INSTRUCTION_ORBITSCORE_DSL.md` の書き換えは**行数を保った**（+1 行で
`mixer-audio-line.md` の引用 4 件が落ちることを実測して回避）。

**注**: #838 の WORK_LOG 項目の「残課題」は「`docs:check` が 198 件失敗・未対応」と書いているが、
merge 時点では 0 failed で、当該作業は #838 内（`c18a962` ほか）で完了している。

### refactor(engine): remove the SuperCollider backend implementation and its editor surface (#502) (Sep 10, 2026)

owner 裁定（#827 / #502・`NATIVE_MIGRATION_2026-09.md` §12.5）に従い、SC バックエンドの
TypeScript 実装と拡張の編集表面を削除した（PR-SC3b・PR-SC3a の同梱まわり削除の続き）。

**削除**: `packages/engine/src/audio/supercollider/`（event-scheduler / buffer-manager /
osc-client / scsynth-resolver / synthdef-loader / link-audio-channels / types / index）・
`supercollider-player.ts`・`packages/engine/supercollider/`（synthdef アセット）・未参照の
`test-sc-*.js` スクラッチ9本・孤立 `packages/engine/package-lock.json`・テスト7本
（SC専用5本 + `link-audio-dispatch`/`link-audio-channels`。後ろ2本は `EventScheduler` 等を
直接 import しており import 整理では済まなかった）。

**🔴 `AudioDevice` 型の退避**: エンジン非依存の共有型だったため、ディレクトリ削除前に
`supercollider/types.ts` から `audio/types.ts` へ移した。

**🔴 実行時 require の罠**: `extension.ts` の `resolveScsynthForUI()` は
`require('.../supercollider/scsynth-resolver')` を実行時に呼んでおり、`tsc` の型検査を
通らない経路（戻り値を `as` で型付け）だったためソースを消しても緑のまま実行時に落ちる。
この関数ごと削除した。

**`ORBITSCORE_ENGINE` を完全に撤去**: 選べる第2エンジンが無い以上、1択を選ぶ env var は
死んだ分岐。`EngineKind`/`resolveEngineKind()` を撤去し `createAudioEngine()` は常に
`RustEnginePlayer` を返す。`orbitscore.engine`/`orbitscore.scsynthPath` 設定・
`Force Kill scsynth` コマンド・SC gated だった `Select Audio Device` コマンド・MCP
`force_kill_scsynth` ツールを削除（`restrictedConfigurations` は空配列に）。`extension.ts` の
`getConfiguredEngineKind()` 各種ガードと SC 専用関数群を撤去し Rust 経路のみへ折り畳んだ。

`rust-engine-player.ts:945` 付近のコメントを実態に合わせた（`warnOnce('outputChannel', ...)`
の呼び出しは1箇所のみ — 旧コメントは `scheduleEvent`/`scheduleSliceEvent` も呼ぶと誤記していた）。
`supercolliderjs` devDependency も削除（SC の TS 実装が無くなったため）。

**テスト**: `SuperColliderPlayer` をモックに使っていたテスト16本を `RustEnginePlayer` 基準へ
書き換え（`chop-timing.spec.ts` は実インスタンス化のため `loadBuffer` の mock 戻り値も
実シグネチャ `{ sampleId }` に合わせた）。件数: 2329 passed / 58 skipped / 2387 total →
**2261 passed / 58 skipped / 2319 total**（削除7本ぶん -68 件）。

**残課題だったもの（解消済み・2026-09-10）**: `npm run docs:check` が本 PR の行番号シフト
（`extension.ts` -444 行等）で 198 件失敗していた。束の締めで `--fix` の再アンカーと
引用内容の手直しを行い、**934 件検証 / 0 失敗**になった（`502-sc-removal` の
`b9f6ded1` 時点・main 実測）。

**件数の但し書き**: 上の `2261 passed / 2319 total` は #838 単体を回した時の値。
束を締めた時点（`b9f6ded1`）の実測は **2271 passed / 58 skipped / 2329 total** で、
差の +10 は #839 以降に入ったテスト。README と CLAUDE.md にはこちらの値と出典を書いた。

### docs(sites): follow PR #836 — the scsynth bundle is gone from the shipped .vsix (#502) (Sep 10, 2026)

**追従元**: PR [#836](https://github.com/signalcompose/orbitscore/pull/836)（merge `f2fa0cf`・base `502-sc-removal`）/ **ブランチ**: `claude/docs-sync-pr836`

#836 は同梱・ビルド・ライセンスだけを扱い `sites/` は対象外だったため、dev site に残っていた「scsynth は `.vsix` に同梱される」という**現在形の記述**を ja / en 両方で追従させた。`glossary.md`（`scsynth` と `bundle (scsynth source)` の 2 項。後者は `sync-dist.js` が同期のたびに `engine/scsynth` を消すため当たらない）・`decisions/adr-003-scsynth-bundle.md`（撤去 warning を冒頭に新設・回避策 2「`npm run build:bundle`」の失効・Consequences revisited に「そして bundle は撤去された」節・深掘り候補 4 件を取り消し線）・`editor/vscode-architecture.md`（出荷 `.vsix` には `bundle` 候補パスだけでなく `require` 対象の `scsynth-resolver` モジュール自体が無い）・`audio/audio-file-playback.md`（`libsndfile.dylib` 非同梱）。

`packages/` `rust/` `tests/` は不変（ルーチンの禁止事項）。`verified-against` は据え置き（章全体を再検証していないため・STYLE_GUIDE の更新ポリシー）。

### chore(build): remove the bundled scsynth, its GPL plugin, and the packaging steps (#502) (Sep 10, 2026)

owner 裁定（#827 / #502）に従い、拡張の出荷物から bundled scsynth と GPL の
`OrbitLinkAudio.scx` を外した。現行 release workflow は `v*` タグを契機に Marketplace / Open VSX
へ publish するため、GPL バイナリを含む `.vsix` が stable タグから配布される前に同梱経路を閉じる必要があった。

**削除したもの**: `packages/sc-link-audio/` 全体とその2 submodule 定義、scsynth の LICENSE / NOTICE、
bundle 抽出・検証・OSC boot-timeout patch script。root / extension の build は engine の SynthDef を
コピーせず、engine 自身の `sync-dist.js` にあった同じコピー経路も閉じた。`.vscodeignore` も
scsynth / SynthDef / legal の keep 指定を持たない。PR-SC3b まで source に
残る SC backend の生成済み JS と JS OSC runtime も `.vsix` から除外した。当該 runtime は未削除
source / test の clean build に限って必要なため devDependency へ隔離し、出荷 runtime dependencies
からは削除した（source と test ごとの完全削除は PR-SC3b）。`sync-dist.js` は extension 向けコピー後に
生成済み SC backend を除き、旧 root-copy / bundle が残した ignored artifact も掃除する。

**release gate**: SuperCollider の install / extract / pre-package verify を削除した。post-package gate は
Rust daemon、OOP child、plugin scanner、engine runtime dependencies、標準 CLAP の検証も担うため残し、
scsynth の `verify-bundle.sh` 呼び出しだけを除いた。



---

### docs(sites): follow PR #833 — LinkAudio egress is not in shipped builds (#502) (Sep 10, 2026)

**追従元**: PR [#833](https://github.com/signalcompose/orbitscore/pull/833)（merge commit `58b8c1c`・base `502-sc-removal`）/ **ブランチ**: `claude/docs-sync-pr833`

#833 は spec と guide を直したが、**`sites/` は対象外**（PR 本文で明記）だった。#833 が §8.1 に
書き下ろした「LinkAudio egress は出荷ビルドに入っていない」という事実は、user site / dev site の
どちらにも届いていなかったため、そこを追従させた。

**直したもの**:
- `sites/user(/en)/midi/link-audio.md`: 冒頭に「配布版では Live に音が届かない」警告を追加。
  前提条件から **OrbitLinkAudio.scx**（#502 で削除済み）を落とし、「送出が有効なビルド」に置換。
  「プラグイン内で加算合成」→「送出側で加算合成」。「OrbitLinkAudio.scx プラグインがない場合」節を
  「音声送出が使えないビルドの場合」へ改題。テンポ push も同じ feature に載るため無効である旨を追記
- `sites/user(/en)/reference/methods.md`: `linkAudio()` / `linkAudio(SR)` / `output("name")` に
  🔴 を付け、配布版で送出が動かないことを注記。ja 側の `midiLatency(ms)` の説明にあった
  「SC とのタイミング合わせ」（en には無い）を「オーディオとのタイミング合わせ」へ
- `sites/dev(/en)/rust-engine/index.md`: wire command 表の `RegisterLinkAudioChannel` /
  `SetLinkTempo` 行に feature gate を注記し、「LinkAudio egress は出荷ビルドに入っていない」節を新設
  （`Cargo.toml` の `[features]` と `copy-daemon-bin.sh:109` を逐語引用）。frontmatter の
  `verified-against` を `58b8c1c` へ
- `docs/development/TRANSLATION_STATUS.md`: #833 が足した注記は「`502-sc-sites` で進行中」と
  書いていたが、当該 PR（[#832](https://github.com/signalcompose/orbitscore/pull/832)）は既に
  base へ入っている。着地済みの内訳（audio 2 章は削除・ADR 2 本は残す）へ書き換え、
  dev の表の III-1 / III-3 を `削除済み (#832)` に。章数の集計（`完了 39 章` と `総章数 29 章` が
  矛盾していた）も揃えた

**🔴 仕様と実測の食い違いを見つけた（決めていない・PR 本文に質問として出す）**:
#833 の §8.1 は「egress が無ければ hardware へフォールバックし 1 回 warn する」と書いているが、
`tests/e2e/orbitstudio-mcp-gated.spec.ts` の「**A comment is not evidence of implementation behavior**」で始まるコメントには、2026-09-04 の実機で
**capture RMS = 0・警告マーカーも無し**という逆の実測が記録されており、さらに
「`global.linkAudio()` 下の dispatch は `skip` か `link` で、capture できる `hardware` には
決してならない」とも書かれている。**どちらが正しいかは仕様の判断**なので直さず、
両サイトには「確定していない」と明記して両論を並べた。

**検証**: `npm run docs:build`（user / dev とも成功）・`npm run docs:check` **942 verified / 0 failed**
（追従前は 936）・`npx vitest run --dir tests --globals docs/` 5 passed。


---

### docs: retire the SuperCollider backend from the specs and guides (#502) (Sep 10, 2026)

**Issue**: #502（東 `502-sc-removal` の docs サブタスク `502-sc-docs`）/ **作業ツリー**: `.claude/worktrees/502-sc-docs`

main が `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` §8 で確定した事実に、他の docs の文言を揃えた。

**確定した事実**（main の §8 編集より）:
- **Rust `orbit-audio-daemon` が唯一のバックエンド**。SuperCollider (scsynth) opt-out 経路と
  `ORBITSCORE_ENGINE` 環境変数は #502（2026-09-10）で削除された（cutover #108 で既定化されてから
  約2ヶ月後）
- 🔴 **LinkAudio egress は出荷ビルドで動作しない**。SC 版（`OrbitLinkAudio.scx`）は #502 で削除、
  Rust 版（`orbit-link-audio` crate・GPL 隔離）は daemon の feature `link-audio` が default off の
  ため `scripts/copy-daemon-bin.sh` / `.github/workflows/release.yml` のどちらの出荷ビルドにも
  含まれていない。理由は Ableton Link が GPL-2.0-or-later で、有効化すると GPL が出荷バイナリの
  依存グラフに入り、SC を削除した理由と同じ問題を作るため

**やったこと**:
- `README.md` / `CLAUDE.md` / `docs/core/PROJECT_RULES.md` / `docs/core/INDEX.md` /
  `docs/core/CONTEXT7_GUIDE.md` / `docs/testing/TESTING_GUIDE.md` の現在形の可用性主張
  （「SuperCollider は opt-out backend」等）を実態に合わせて修正。`PROJECT_RULES.md` の
  「SuperCollider Integration Tests」節（削除される `tests/audio/supercollider-gain-pan.spec.ts`
  を名指し）は節ごと落として番号を詰めた
- `docs/research/SCSYNTH_BUNDLE_MANIFEST.md` / `SCSYNTH_STANDALONE.md` / `LINK_AUDIO_API.md`・
  `docs/testing/LINK_AUDIO_E2E_CHECKLIST.md` の冒頭に歴史記録ヘッダを追加（本文は不変）
- `docs/AUDIO_TEST_CHECKLIST.md` / `AUDIO_TEST_SETUP.md` / `docs/testing/PERFORMANCE_TEST.md`
  （cutover #108 以前の SC セットアップ手順で INDEX.md からリンクされていた）・
  `docs/testing/QA_2.0.0.md` / `QA_2.0.0_HUMAN_RUNBOOK.md`（SC 依存の実機手順を含む QA 記録）・
  `docs/user/en(ja)/GETTING_STARTED.md`（SC インストールを前提とする現行リンクのガイド）に
  同様の歴史記録／非推奨の注記を追加。既存の `USER_MANUAL.md` の DEPRECATED 表記はそのまま
- `docs/development/TRANSLATION_STATUS.md` に、`sites/dev/` の SC 関連章の削除・書き換えが
  別 PR（`502-sc-sites`）で進行中であることを明記
- `examples/22_rust_engine_parity.orbs` のコメント（`ORBITSCORE_ENGINE=sc` を使う旧手順）を
  Rust 単独運用に合わせて修正。`.orbs` の実行行は変更していない

**歴史記述は残した**: README の Phase 7 Achievements・ICMC v1.x bundle 節、
`docs/development/POST_2.0_*` / `docs/planning/` / `docs/design/` の移行計画・設計分析
（`NATIVE_MIGRATION_2026-09.md` §12.5 の「#502 実測と順序」を含む）は、現在形の可用性主張ではなく
決定の記録なので変更していない。`docs/specs-v2/IMPLEMENTATION_INSTRUCTIONS.md`（Epic #224 管理下）
と `sites/` は対象外（前者は本タスクの範囲外・後者は別 PR）。

**`docs:check`**: main の §8 編集で行番号がずれた `sites/dev(/en)/signal-chain/mixer-audio-line.md`
の引用 4 件を `node sites/dev/scripts/check-citations.mjs --fix` で再アンカーした。
本 PR 単独では 1032 verified / 0 failed、`502-sc-sites`（#832）を取り込んだ後は 936 verified / 0 failed（章の削除で引用が減ったため）。


---

### docs(sites): drop the SuperCollider chapters and de-anchor ADR citations (#502) (Sep 10, 2026)

**Issue**: #502（束の1本・PR-SC2）/ **ブランチ**: `502-sc-sites`（base `502-sc-removal`）

owner 裁定（2026-09-10・#827 / #502）で SuperCollider (SC) バックエンドをコードごと削除する。
コード削除 PR（PR-SC3a/3b）より先に、学習サイト（`sites/dev/`）が SC のコードを引用している
箇所を外した。`sites/dev/scripts/check-citations.mjs`（`npm run docs:check`）は引用ヘッダ
`// path:line-line` を実コードと文字単位で突合するため、コードが消えた瞬間に red になる。
引用を先に外しておけば、コード削除 PR は docs:check を壊さずに進められる。

**消したもの**: SC 専用の解説ページ2本（ja/en 各対）— `audio/supercollider.md`（旧 III-1）、
`audio/scsynth-bundle.md`（旧 III-3）。sidebar からも該当エントリを削除し、他ページから
これらへのリンク（12箇所）をすべて ADR への参照または地の文に置き換えた。

**残したもの**: ADR-001 / ADR-003（決定の記録）。冒頭に「コードは削除決定/削除済み」の
warning ブロックを追加し、引用ヘッダを `path:start-end` → `path Lstart-end` 形式に変えて
`check-citations.mjs` の検査対象から外した（コード本体は1文字も変更していない）。
`audio/audio-file-playback.md`（旧 III-2）は主題が SC 実装の詳細読解のままだが、他章から
参照され続けているため削除せず、同様に引用を無効化した上で残した。加えて `event-queue.md` /
`glossary.md` / `orientation/architecture-overview.md` / `orientation/what-is-orbitscore.md` /
`editor/vscode-architecture.md` / `index.md` / `STYLE_GUIDE.md` / `sites/user/.translation-glossary.md`
の「SC は opt-out で選べる」という現在形の記述を「削除決定（#502）」の過去形・注記に更新した
（cutover #108 等の歴史記述はそのまま残した）。

**確認**: `npm run docs:check`（936 citation(s) verified, 0 failed）／
`npm -w @orbitscore/dev-site run docs:build`（VitePress ビルド green、dead link 0）／
`npm test`（2329 passed, 58 skipped, 0 failed）。

**やっていないこと**: `packages/` `rust/` `scripts/` `tests/` `.github/` のコード削除は本 PR の
範囲外（PR-SC3a/3b で対応）。本 PR の時点では SC のコードはまだ存在する。

### docs: follow the gated harness move onto stock VS Code (#830 / PR #831) (Sep 10, 2026)

**追従元**: PR [#831](https://github.com/signalcompose/orbitscore/pull/831)（マージコミット `229d638`）/ **ブランチ**: `claude/docs-sync-pr831`（docs のみ）

PR #831 は CLAUDE.md・README・`docs/planning/` 系・dev サイトの引用ブロックまでは直していたが、
**dev サイトの散文が「実 OrbitStudio.app を起動する」と言ったまま**残っていた。同じページの中で
コードブロックは `bin/code` と `/Applications/Visual Studio Code.app` を引用しているので、
本文と引用が食い違う状態だった。`sites/dev/glossary.md`（PR #831 で更新済み）とも矛盾していた。

| 直したもの | 場所 |
|---|---|
| 章タイトル・目次・導入・本文の「実 OrbitStudio.app を起動」 | `sites/dev/editor/mcp-and-gated-e2e.md` + `sites/dev/en/` の同パス |
| 「手元で走らせる」の前提が「OrbitStudio.app がビルド済み」だった（フォークのビルドスクリプトは PR #831 が削除済みで、到達できない手順） | 同上 |
| 手動ゲートの手順（CLAUDE.md が #830 で 3 点追記したのに散文は旧 2 段のまま） | 同上 / `sites/dev/signal-chain/index.md` + en |
| `killOrbitStudio()` → `killHarnessInstances()`（関数は PR #831 で改名済み） | 同上 |
| 実機層の駆動対象 | `docs/testing/E2E_HARNESS_SPEC.md:57` |
| 新設 2 ファイルを Sources に追加 | `tests/e2e/helpers/harness-processes.ts` / `tests/e2e/harness-processes.spec.ts` |

**直さずに注記したもの**: 「テスト一覧」表の行番号は PR #831 以前から古い（`it` は 20 本ではなく
30 本ある）。この PR の差分に起因しないので、行番号を機械的にずらすと**誤った番号のまま体裁だけ整う**。
表の見出しに「その時点のもの」と明記するに留めた。

### docs(user-site): follow PR #842 — install route, Intel support, and engine start (Sep 10, 2026)

PR [#842](https://github.com/signalcompose/orbitscore/pull/842)（`841-readme-stable` → `502-sc-removal`・
マージコミット `f90c22ce251108faa1ffe31374a9d8e5eb481afb`）が出荷 README を実測に合わせたので、
**ユーザー学習サイト側に残っていた同じ誤り**を追従させた。ja / en 両方。

| 直したもの | 旧記述 | 根拠 |
|---|---|---|
| Intel Mac | 「一部動作する可能性がありますが未検証」 | #842 が `release.yml` の `VSIX_TARGET: darwin-arm64` を根拠に「非対応」へ改めた。universal ではない |
| 入手経路 | 「将来は VS Code Marketplace と Open VSX からも直接インストールできる予定です」 | Marketplace / Open VSX には出さない（owner 2026-09-10・#842 本文） |
| エンジンの起動 | 「ステータスバーをクリックするとコマンド一覧が開くので **Start Engine** を選びます」 | ステータスバーの `command` は `orbitscore.showCommands` で、その実体は `orbitscore.engineView.focus`（`packages/vscode-extension/src/extension.ts:666-668`）。**コマンド一覧は開かず Audio Engine Settings ビューが開く**。また `Start Engine` という title のコマンドは存在せず、現在は `OrbitScore: Start / Stop Engine`（`orbitscore.toggleEngine`）である |
| デバッグ起動 | 「**Start Engine (Debug)** を選びます」 | `orbitscore.startEngineDebug` は `contributes.menus.commandPalette` で `when: "false"` にされておりパレットに出ない。ビュー側の `engineViewToggleDebug`（`extension.ts:2112-2122`）が設定 `orbitscore.engineDebug` を切り替える経路が実体 |

**変更ファイル**: `sites/user/getting-started/installation.md` / `engine-settings.md`、`sites/user/index.md`、
および `sites/user/en/` の同じ 3 ファイル。

**直さずに報告に回したもの**: `docs/user/ja/USER_MANUAL.md`（README で deprecated 宣言済み・
scsynth 同梱と `orbitscore.scsynthPath` を今も説明しており #502 と全面的に食い違う。1 行だけ直すと
かえって誤解を招くので触っていない）。

### test(e2e): launch the gated harness from stock VS Code (#830) (Sep 10, 2026)

🔴 **実機で回して 3 件の欠陥が出た。いずれも stock VS Code に切り替えて初めて現れたもので、
CI・ユニット・机上レビューのどれにも掛からない。** 実機ゲートを置いている理由そのもの。

| # | 症状 | 原因 |
|---|---|---|
| 1 | `The window terminated unexpectedly (reason: 'killed', code: '15')` のモーダルが出て**人待ちになる** | `pkill -f` が **Electron のヘルパーにも当たる**（同じ `--user-data-dir` 引数を継承するため）。レンダラを本体より先に殺すと本体が異常終了と判断する |
| 2 | 新規プロファイルの welcome / サインイン画面が毎回出る | stock VS Code の初回起動 UI。フォークはビルド時に無効化されていた |
| 3 | **MCP が 60 秒立たない** | `--user-data-dir` のパスが **105 文字**で、macOS の Unix ソケット上限 **103 文字**を超えた。VS Code 本体が `listen EINVAL` で即死し、ウィンドウが一度も開かない |

**出典**（2026-09-10・main が本ツリーで実測。owner のスクリーンショットが発端）:

- ヘルパーも一致する件: `pgrep -f 'MacOS/Code.*--user-data-dir=[^ ]*/orbitstudio-'` が
  **7 PID** を返した（本体 1 + Electron helper 群）
- ソケット長: 子プロセスの stderr に
  `WARNING: IPC handle ".../orbitstudio-named-device-0IgvF5/user-data/1.13-main.sock" is longer than 103 chars`
  と `Error: listen EINVAL` が出た。当該パスは `wc -c` で **105**。
  上限 103 は macOS の `sys/un.h` の `sun_path[104]` に由来する
- ⚠️ `os.tmpdir()` の長さ（ここでは 48 文字）は**マシンごとに変わる**ので、105 という数字は本機の値

**3 が本体で、いちばん質が悪い。** ハーネスからは「MCP が立たない」としか見えないので、
拡張が activation していないように読める。実際 main はそちらを 30 分調べた。
`os.tmpdir()` だけで 48 文字（`/var/folders/<2>/<28>/T/`）あり、説明的な prefix を足すと超える。

**対処**: temp root を `/tmp` へ移し prefix を短縮（`orbitstudio-` → `orbe2e-`）。加えて
**起動前にソケット長を検査して即座に理由を出す**（60 秒待って原因不明で落ちるのを避ける）。

🔴 **4 件目として「ワークスペースの信頼」を挙げていたが、実験で否定された（同日中に訂正）。**

途中で `--disable-workspace-trust` を足し、「`machine-overridable` の設定が未信頼ワークスペースで
無視されるからエンジンが起動しない」と書いた。しかし **`uuid` を入れた後にフラグを外して回すと通る**
（`#661 D-0` が 8.5 秒で緑）。「エンジンが起動しない」の原因は**最初から依存不足**であり、
信頼は無関係だった。フラグは削除した。

**なぜ誤ったか**: フラグを足した時点でまだ `uuid` が入っておらず、**前後どちらも赤**だった。
それを「フラグでは直らなかった」ではなく「フラグは必要」と読み、原因の説明まで書いてしまった。
🔴 **変化しなかった変数を原因に数えない。** 監査（Fable）が VS Code の実ソースを読み
「`machine-overridable` は未信頼でも落ちない。落ちるのは `restricted` だけ」と指摘し、
その反証手順（フラグ無しで 1 回起動する）に従って確かめた。

## 🔴 `pretest:e2e:gated` が engine の実行時依存を入れていなかった

診断の途中で `❌ daemon resolver failed: Cannot find module 'uuid'` が出た。
`npm run build` の `build:copy-engine` は dist をコピーするだけで、
`scripts/install-engine-deps.sh` を**呼んでいない**。**ビルドは緑・パッケージも成功し、
実行時にだけ落ちる**（#654 の `yaml` と同じクラス）。`pretest:e2e:gated` に追加した。

## 実機の結果

**29 passed / 1 failed**（528 秒）。落ちた 1 件は
`steps the live playhead through an instrument() sequence, rests included` で、
**main の既知ベースラインと同一**。新しい赤は無い。


実機 gated ハーネスの起動先を VSCodium フォークの OrbitStudio.app から stock VS Code へ切り替え、
`--extensionDevelopmentPath` と隔離した user-data / extensions dir をそのまま使う構成にした。
終了処理はアプリ名ではなく、ハーネス専用 `--user-data-dir` の共通接頭辞だけを対象にするため、
日常利用中の VS Code を巻き込まない。旧フォークのビルドスクリプトを削除し、非 archive 文書の
参照先を現行のネイティブ移行裁定へ更新した。フォークを畳む前にマージゲートを維持するための変更で、
実機 gated 全件の結果は main が本ツリーで実行して追記する。

---
### docs(planning): record the extension-stable freeze line and the native OrbitStudio line (#827) (Sep 10, 2026)

**Issue**: #827 / **ブランチ**: `827-stable-freeze-line` → main（docs のみ）

#### 何を決めたか（owner 裁定・2026-09-10）

別セッションで作られた「OrbitStudio ネイティブ移行 — 検討状況」を main が実測で検算し、owner が裁定した。
**会話の中でしか決まっていない状態**を解消するため、正本を `docs/planning/NATIVE_MIGRATION_2026-09.md` に置いた
（§0〜§11 = 検討状況をそのまま取り込み、**§12 = 裁定**。食い違えば §12 が正）。

| 裁定 | 内容 |
|---|---|
| 方針 | **拡張版を stable として凍結し `.vsix` をリリース**。制作（楽曲・インスタレーション）はこれを使う。以降はネイティブ OrbitStudio.app の新ラインへ |
| 🔴 凍結線 | **ステージ 2 の O-surface（PR-O4）完了**。DSL 表面の一方通行（W-2 / W-3 / W-18）がそこで確定し、以降は加法的 |
| 制作の要件 | 出口は master + sum / aux + **物理アウトのスピーカー振り分け**（O-surface に含まれる）。記録・render・ラック・`outs:` は不要。録音は `ORBIT_CAPTURE_WAV` で今日できる |
| 新ラインへ | O-multiout（PR-O5 / O6）・ステージ 3〜7・ステージ 8 は再定義（VSCodium フォークは畳む） |
| 凍結前に | SC 資産の削除（#502 を「削除」へ更新・GPL 同梱の解消・タグより前）/ gated ハーネスを stock VS Code 起動へ / README を導線へ |

#### main が実測で検算して直した点

- 🔴 検討状況の §2.6「フォークを畳んで失うのは 47 行のスクリプトと E2E のターゲット指定のみ」→
  **そのターゲット指定がマージゲート（実機 gated）そのもの**。ただしハーネス（`orbitstudio-mcp-gated.spec.ts:460-471`）は
  既に `--extensionDevelopmentPath` + 隔離 dir で起動しており、**フォーク固有は旧専用 CLI を指す 1 行だけ**。
  VS Code の `bin/code` に変えれば足りる
- SC 削除の影響: 実機 gated は **0 件**、ユニットは 22 ファイル（SC 専用 5 本は削除・17 は整理）
- 「凍結線はステージ 2 完了」→ 制作に `outs:` が要らないので **O-surface 完了まで縮んだ**。
  PR-O6 の「O4 が実機で確かめられた後」は stable 版の制作利用がそのまま満たす
- 未検証項目に **層 2 の多クライアント同時性**と **Swift アプリの CI（macOS ランナー）**を追加

#### 未決（本 PR で決めていない）

タグ名前空間（`ext-v*`）/ バージョン番号（`send` の dB 化は既存譜面の意味が変わるので semver なら 3.0.0）/
地図の全面再編（Fable 起案で別 issue）/ O-surface に `SetGlobalGain` の写しを含めるか（設計時に決める）。

---

### docs: follow the O-wire-b merge with the dev site and the core spec (Sep 10, 2026)

**追従元**: PR [#824](https://github.com/signalcompose/orbitscore/pull/824)（マージコミット `183b612`）/
**ブランチ**: `claude/docs-sync-pr824` / **性格**: ドキュメントのみ（`packages/` `rust/` `tests/` は無改変）

#### 直したもの

| 場所 | 何が食い違っていたか |
|---|---|
| `sites/dev/rust-engine/index.md` + `en/` | daemon コマンド表に **`SetBusLine` の行が無かった**（`session.rs` の match arm が 1 つ増えたのに表が 2026-09-01 のまま）。`SetBusLine` の wire 契約（2 段検証・全検証後に一度だけ publish・`dest` 5 種のうち受理は 3 種）と master line の 2 本立て（`explicit_line` / `execute_master_line`）を節として追加 |
| `sites/dev/signal-chain/mixer-audio-line.md` + `en/` | 「routing を daemon へ届ける」節が `SetBusRouting` を唯一の経路として説明していた。`SetBusLine` が併存すること・**TS に呼び出し元がまだ無い**こと・kind 制約が `SetBusRouting` 固有であることを Note で明示 |
| `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` MX.4 / MX.5 | 🔴 **引用行が壊れていた** — `engine_wrap.rs:5809-5813` / `:5802-5806` は本 PR の +644 行で `SelectAudioDevice` の stream 差し替え recovery になっていた。実際の kind 制約は `:6956-6960`（output）/ `:6981-6985`（send）、forward-only は `:6951-6955`。あわせて「制約が外れるのは PR-O3」という記述を実態へ（PR-O3 で入ったのは wire だけで、DSL は `SetBusRouting` のままなので**ユーザーから見える制約は変わっていない**・切り替えは PR-O4） |

#### 検証

`npm run docs:check` = **1018 verified / 0 failed / 58 files**、`docs:build`（user / dev）ともに成功。

🔴 **`docs:check` が見るのは `sites/dev/` の `// FILE:START-END` 引用だけ**で、`docs/core/` の
行参照は誰も突合していない。今回の壊れた 2 件がレビュー 4 段を素通りしたのはこのため。

---

## 束 O-wire-b（#611 ステージ 2・統合ブランチ `611-line-wire-b`）

`SetBusLine` の wire 契約を足す束。**DSL からは呼ばない**（送るのは PR-O4）ので、束の収束条件は
O-wire と同じ「**`OUTPUT_LINE_GOLDENS` / `#611 O0-1〜4` が 1 つも動かないこと**」+ cargo 全緑 + 実機 gated 全件。

---

### refactor(engine): route buses through SetBusLine without changing the DSL surface (#611) (Sep 10, 2026)

`AudioLine` に宛先・rack・gain・pan・output の型、評価バッチ内のカーソル規則、暗黙の rack / master
補完、wire 変換を集約した。規則 2 では要素削除後に cursor を 1 つ戻し、単文先頭の終端 output は
既存終端を同じ位置で置換する。同じ宛先の ordinal はバッチ内で数えるため、同一宛先への複数 output
も順序どおり保持できる。

`Sequence` / `Global` / `MixerBusHandle` の routing は `SetBusLine` を送るようにし、respawn 後も最後の
line intent を再送する。`Sequence.output(string | number)`、`send(name, amount)` の線形 amount、LinkAudio
と render bus の解決順は変更していない。送る program も従来の
`[rack, output(sum|master, thru: sends>0), sends…]` と同じである。

DSL 表面をこの段階で変えないのは、`OUTPUT_LINE_GOLDENS` / O0-1〜O0-4 が 1 つも動かないことを
配線の検算に使うためである。線形 send の dB 化や output の新しい引数を同時に入れると、golden が
動いた原因を「配線の誤り」と「単位・表面の変更」に切り分けられなくなるため、それらは次の PR に残した。

### feat(daemon): wire pan and mono device into SetBusLine, and carry effective gain across re-publish (#611) (Sep 10, 2026)

`SetBusLine` の wire 契約を拡張し、`pan` と 1 要素の device channels（L+R の mono merge）を
受理できるようにした。バスと master の RT では、発音側の center pan と重ねても音量が変わらない
`√2 × equal-power` の係数を block ごとに計算し、pan 位置そのものを 5 ms ramp する。

line の再 publish では、旧 program の実効値を atomic で読み、新旧 op を Gain/Pan の出現序数と
Output の宛先・出現序数で対応付けて seed する。これが無いと、演奏中に send を追加しただけで既存の
−12 dB send が一度 unity に跳ねてから戻り、約 5 ms の +12 dB burst と可聴の pop が生じるためである。
対応の無い新 Output は 0.0 から fade-in し、Gain は 1.0、Pan は指定位置から始める。旧
`SetBusRouting` の `LineProgram::legacy` / `settled` 経路は変更していない。

---
### ci(release): fail a tag push whose version disagrees with the .vsix (#843) (Sep 11, 2026)

**追記（`/simplify` 後・2026-09-11）**: cleanup 4 体のうち 2 体が実質的な指摘を出した。

🔴 **Altitude — 正本設計が既に同じ照合を規定していた。** `docs/design/656-release-design.md`
§4.4 が「`git describe --exact-match` があるとき、その tag が `v<拡張の version>` と一致すること」を
**`make-local-release.sh` のローカル preflight**（= **タグを作る前**）に置く設計として確定させていた。
私はそれを確認せずに CI 側だけを書いた。

**押された後より前に止まる方が良い** — タグ push は準公開的な行為で、間違えると remote タグの
削除と re-tag が要る。ただし手でタグを打つ経路が残る限り CI 側も**最後の砦**として意味がある。
そこで **`checkTagAgainstVersion` / `versionCore` を export したまま**にし、
設計文書の §4.4 に「preflight はこれを import すること・同じ規則を書き起こさないこと」を明記した。

🔴 **§4.4 は私の bump 計画の誤りも正した。** 私は「拡張 package.json・`ENGINE_VERSION`・
`DSL_VERSION` の 3 つを揃える」と書いていたが、§4.4 は明確に:

| 場所 | 規則 |
|---|---|
| `packages/vscode-extension/package.json` | 🔴 **正本**。`.vsix` / `.app` / タグの版はこれ |
| `ENGINE_VERSION` | **別軸**（セッションログの meta ヘッダ）。**同期しない** |
| `DSL_VERSION` | **別軸**（spec 版）。**同期しない** |

`ENGINE_VERSION 2.0.0` と拡張 `2.1.0` の食い違いは**事故ではなく設計**だった。

**Simplification** — `versionCore()` を package.json 側にも適用しているのに、
**接尾辞付きの package.json を渡すテストが 1 本も無かった**（裏づけの無い汎用性）。
テストを 1 本足して明示した（7 → 8 件）。

**Reuse / Efficiency** — 指摘なし。Reuse の Minor 1 件（テストの `REPO_ROOT` が
`bundled-child-binaries.spec.ts` と重複）は**見送った**: 実質 2 行で、
かつ**この PR の範囲外のファイル**に触ることになるため。



`release.yml` が**タグ名と `packages/vscode-extension/package.json` の version を
照合していなかった**。`vsce package` は資産名を package.json から取るので、`v3.0.0` を
打っても package.json が `2.1.0` のままなら、**Release のタイトルは v3.0.0・唯一の資産は
`orbitscore-darwin-arm64-2.1.0.vsix`** になる。どこにもエラーは出ず、
**ダウンロードした人にしか見えない**。

**照合は X.Y.Z のコアだけ**にした。既存タグを実測したところ、この repo の規約は
「prerelease の接尾辞はタグにだけ付き、package.json は素の X.Y.Z」だった:

| タグ | その時点の package.json |
|---|---|
| `v1.1.0-rc1` / `-rc2` / `-rc3` | `1.1.0` |
| `v1.0.1-rc1` | `1.0.1` |
| `v2.0.0` | `2.0.0` |

タグ全体を照合すると、この規約に沿った rc タグがすべて落ちる。

🔴 **ロジックをワークフローに埋めず `scripts/check-release-tag-version.mjs` へ出した。**
埋め込むと (a) タグを打つ前に手元で確かめられない (b) テストが書けない。
スクリプトなら `node scripts/check-release-tag-version.mjs v3.0.0` で事前に確認できる。

置き場所は **Setup Node.js の直後・`npm ci` の前**。約 25 分のビルドの手前で数秒で落ちる。
Setup Node.js より後にしたのは、runner イメージ同梱の Node ではなく**ピン留めした Node**で
走らせるため。

**検証**（変異は `$TMPDIR` へバックアップしてから実施）:

| 変異 | 結果 |
|---|---|
| 照合を `if (false)` に無効化 | 2 failed |
| workflow がスクリプトを呼ばなくなる | 1 failed |
| 接尾辞の除去をやめる（rc タグが落ちる） | 2 failed |
| エラー文から資産名を伏せる | 1 failed |
| restore | 7 passed・両ファイル baseline とバイト一致 |

🔴 **記録**: 最初の変異検証で `git checkout` を restore に使い、**新規ファイル（未追跡）は
戻らず、tracked なワークフローは自分の未コミット編集ごと消えた**。
`mutation-backup-must-use-tmpdir` の「コミット済みなら `git checkout --` が確実」は
**裏を返すと未コミットなら確実に壊す**。未コミットの作業に変異をかけるなら
`$TMPDIR` へコピーしてから。

### test(daemon): add the three bundle-A tests the design listed but never got (#611) (Sep 10, 2026)

Fable の受け入れ監査（束 A / PR #834）が **Important #1** として「設計 §11 が PR-A1 / PR-A2 の
検証として列挙したテストのうち 3 件が実在しない」ことを一次ソースで確認した。うち 2 件は
**「1 層だけ追従しない」退行の検出器そのもの**だった。

| 追加 | 何を数値で見るか |
|---|---|
| `output.rs` `master_line_pan_op_positions_the_master_buffer` | master line を `execute_master_line` へ直接流し、`Pan(-1.0)` 後の hw が `(√2, 0)` になること。buffer を全て 1.0 に揃えているのでゲインがそのまま出る |
| `session.rs` `set_bus_line_wire_pan_op_is_parsed_with_its_own_value` | `{"op":"pan","pan":0.25}` が受理され、`BusLineOp::Pan` の**中身が 0.25 と一致する**こと |
| `engine_wrap.rs` `set_bus_line_seed_for_a_new_gain_without_a_match_defaults_to_unity` | 旧に Gain が無い republish で、新 Gain の seed が既定 1.0 になること（0.5 でも 0.0 でもない） |

**なぜ必要だったか**: `LineOp` を match する実行器は master（`execute_master_line`）と
bus post-loop の **2 箇所**あり、既存テストは `render_tagged_line` 経由で **bus しか通って
いなかった**。master アームを `LineOp::Pan(_) => {}` に戻しても全件緑になる。wire 側も
形の不正（MALFORMED）しか見ておらず、`item.get("pan")` を `item.get("value")` に
取り違えても全件緑だった。

**変異検算**（3 件とも壊して赤・戻して緑を実走）:

| テスト | 変異 | 赤の実出力 |
|---|---|---|
| T1 | master 側 Pan アームを `LineOp::Pan(_) => {}` | `hard-left L=1` |
| T2 | `item.get("pan")` → `item.get("value")` | `'line[].pan' must be a number`（MALFORMED） |
| T3 | 対応無しの既定値 `1.0` → `0.0` | `left: [0.0, 0.0] / right: [1.0, 1.0]` |

production コードは **0 行**（変異は都度復元・`git diff --stat` で確認）。

**設計文書側も直した**: §4.1 に「√2 の合成が成り立つのは scheduler が鳴らす audio event に
限る」という**適用範囲**を書き足した（Fable Important #2）。`collect_source_feeds` が集める
instrument の feed は schedule 時の pan を通らないので、ライン上の Pan は
`√2 · equal_power_pan(p)` がそのまま出て、**両端で +3.01 dB** になる。中央比では
どちらも同じ等パワー則だが、絶対レベルが違う（audio event は中央が既に −3 dB）。
フルスケールの instrument を端まで振ると 0 dBFS を超えるので、**束 B の締めまでに
owner 裁定**とした（束 A では TS が `SetBusLine` を送らないので到達不能）。
§11 には欠落の経緯と「設計の検証欄を実装後にチェックリストとして突き合わせる」教訓を残した。
### feat(dsl): output(dest, thru, db), send in dB, pan as a line element (#611) (Sep 10, 2026)

`Sequence.output(dest, { thru, db })` / `send(aux, db, { enabled })` / `gain(db)` / `pan(v)` を
doc 611 §2-§3 の凍結表面へ切り替えた。解決順は `OutputDest` 解決済み → `"master"` 予約語 →
宣言済み sum/aux 名（aux も `output()` で指せるよう拡張）→ `"L,R"` 物理アウト対 → LinkAudio
channel 名（今日どおり）。数値 render bus の分岐は #611 §14 (1) のとおり解決順の外に残した
（撤回は別 PR-R 系のスコープ）。`mix.output(n)` の mono 宣言をパーサ・`MixerRuntimeNode` に足し、
`output(cue)`（`cue = mix.output(3,4)` のようなノード変数）は interpreter が
`state.mixers.nodes` を引いて `{kind:'device', channels}` へ解決してから `output()`/`send()` に
渡す。`MixerBusHandle`（sum/aux）にも同じ `output`/`send`/`gain`/`pan` を実装し、
`BUS_DSL_METHODS` へ追加した。

🔴 **`send` の dB 化で既存譜面の意味が変わる。** `kick.send("rev", 0.3)` は今日まで線形
0.3（30%）だったが、**+0.3 dB**（`10 ** (0.3/20) ≈ 1.0351` 倍・ほぼ素通し）と読まれる。名前付き
引数 `amount:` は改名されたとして loud に throw する（`db:` を使う）。golden `send`
（`tests/e2e/output-line-expectations.ts`）は `legacyTotalOverDry`（`1 + 0.3 = 1.3`）から
`dbTotalOverDry`（`1 + 10 ** (0.3/20) ≈ 2.0351`）へ切り替えた。

🔴 **`pan`/`gain`（固定値）は8本しかない insert bus プールを守るため無条件にライン要素へしない。**
`_insertBus` を持たない audio シーケンス（`effect()`/`output()`/`send()` 未宣言）では今日どおり
発音側に適用し、`_line` には要素として記録するだけに留める。バスが後から確保された瞬間
（`adoptLineOnFirstBus()`）に発音側をリセットし、`seamlessParameterUpdate` を即時再スケジュール
して二重適用を防ぐ。instrument は発音側の適用経路が無いため常にバスを確保する。
`examples/07_audio_control.orbs`（17 シーケンス・`gain()` 28 回）はこの分岐がないと 9 本目で
`pool exhausted` する。

`//#evalBegin` / `//#evalEnd` メタ行を `extension.ts`（`writeCodeToEngine`）と `repl-mode.ts`
（`AudioLine.beginBatchAll()`/`endBatchAll()`）に追加し、評価単位全体を 1 つのカーソルバッチに
した。フレーム外（生 stdin・単体テストの直接呼び出し）では各 DSL 呼び出しが自分だけの
1 要素バッチを開閉する（`Sequence.upsertLine()`）ので、`output("drums")` → `output("cue")` の
ような再宣言が今日どおり置換として効く。ガードは 2 つ: `beginBatch()` は開いたままのバッチを
暗黙に閉じてから開く。フレーム途中で拡張が落ちても、次の `//#evalBegin` が自己修復する
（統計評価文の内部エラーは `executeCurrentBuffer` の try/catch に吸収され `//#evalEnd` まで
届くので、`finally` の追加は不要だった）。ユニットで両系列を固定した
（`tests/cli/repl-eval-frame-meta.spec.ts`）。

goldens の分類（`tests/e2e/output-line-expectations.ts`）:
- `noBus` / `sumOutput` / `sequenceGainWithEffect` / `globalGainInstrument`: **不動**。
  バス無し audio は発音側適用のまま（音は同値）・`global.gain()` は atomic のまま（F2 裁定「写さない」）。
- `send`: **動く**（上記の式）。

`MixerBusHandle.output()`/`.send()`（旧 `routeOutput`/`routeSend`）は、拒否された push を
ロールバックせず「TS 側の宣言が真実・次呼び出しで全量再送」する自己修復方式へ揃えた
（`Sequence` が B1 で既に持っていた `_busLineStale` と同じ規律）。

判断を保留した点・設計との食い違い:
- `send(aux, ...)` の文字列解決は aux/sum バス名限定にし、`"master"`/`"3,4"`/LinkAudio へは
  広げなかった（設計は `OutputDest | string` としか書いておらず、aux 専用に狭めた）。
- E2E-4/E2E-5（4ch 以上のデバイス要）は `it.skip` + `console.warn` のプレースホルダのみ
  追加し、本体は書いていない（本機に該当デバイスが無く実装しても検証できない）。
- E2E-6（チェーン順序）・E2E-7（seed のポップ回避）・E2E-10（daemon respawn）・E2E-11（master
  gain の残響窓）は時間の制約で見送った。追加したのは E2E-2 / E2E-3 / E2E-S / E2E-S0 / E2E-G /
  E2E-P（実機は main が回す・未検証）。
- dev 学習サイト（`sites/dev/signal-chain/mixer-audio-line.md` 他）は多数の引用が本 PR で
  ずれたため `--fix` の機械的な再アンカーに加え、コード引用そのものを新しい実装へ差し替えた。
  ただし `SetBusRouting` 節と「Try it」節の周辺散文は歴史的経路の記録として残し、全面書き直しは
  行っていない（更新コールアウトで明示）。

### test(e2e): add the three O-surface E2E the freeze line requires (#611) (Sep 10, 2026)

凍結線の収束条件「O-surface E2E-2〜7 + E2E-10 が緑」の未達部分。B2 本体は時間制約で
この 3 本を落としていた。

| # | 何を固定するか | 判定式 |
|---|---|---|
| **E2E-6** | **位置が意味を持つこと**。`output(verb, thru: true)` を `effect([Gain(db: -12)])` の**前に**書くか**後に**書くかで混合が変わる | `g = 10^(-12/20)` として `total_A / total_B = (1 + g) / (2g)` ≈ 2.49。許容 `relativeDelta <= 0.12` |
| **E2E-7** | **再 publish の seed**。`gain(-40)` で鳴らしている最中に `gain(0)` へ切り替えてもクリックが出ない | 切替窓（±50 ms）の `max\|x[n]−x[n−1]\|` <= 定常窓の同 × 4 |
| **E2E-10** | daemon を `SIGKILL` しても音が戻り、**台数が 1 に収まる** | `relativeDelta(after, before) <= 0.05` かつ respawn 後の daemon PID が 1 個 |

**E2E-6 がなぜ `(1+g)/(2g)` か**（テストにも導出を書いた）: A は `output(verb, thru:true)` が
先なので **verb へ分岐した後に** Gain が掛かり、dry 側だけが減衰する → `total = g + 1`。
B は Gain が先なので**両方に**掛かる → `total = 2g`。これは評価フレームがあって初めて成立する
（選択範囲全体が 1 つのバッチになり、行の並び順が信号順になる）。

**E2E-7 が raw PCM を読む理由**: -40 dB → 0 dB の跳びは 1 サンプルの不連続なので、
20 ms の RMS / peak 窓では解像できない。`readCaptureForAnalysis` の float32 を直接読み、
**信号から切替点を特定する**（peak 0.01 の -40 dB は閾値 0.1 を跨がないので、envelope crossing が
そのまま `gain(0)` のランプ位置になる）。MCP 往復の壁時計に依存しない。

**E2E-10 の判断**: `expectNoNewErrors` を**呼ばない**。`SIGKILL` は意図的な fault injection で、
daemon の死そのものが ERROR に分類されるログを出す（既存の D-2 / D-3 も同じ扱い）。
`runScore()` は毎回 engine を止め直すため使えず、E2E-K3 と同じ手動 open/select/run で
1 セッションに収めた。capture は daemon 側のタップなので respawn で作り直される —
**before の RMS は kill の前に読み切る**（設計 §8.1 の注記どおり、1 本の `CaptureWindows` に
しない）。

🔴 **main が直した点**: 台数の待ちと判定が**同語反復**になっていた。`waitUntil` が
`currentPids.length === 1` を待ち、その後に `toHaveLength(1)` を assert していたので、
2 台で落ち着いた場合は waitUntil の timeout になり「respawn しなかった」という**誤った診断**が
出る。待つ条件を `>= 1` に緩め、**台数が 1 であることは assert 側で見る**ようにした。

**検算**（main が sandbox 外で実行）: `npm test` **2362 passed / 67 skipped / 2429**
（skip が 64 → 67 = 新規 3 本）・`lint` 緑・`typecheck:e2e` 緑・引用 1034 件 / 0 失敗・
gated env 未設定で spec の 39 件すべて skip。

### test(e2e): follow the dB send unit in the #643 E2E-4 golden (#611) (Sep 10, 2026)

**main が実機で回して見つけた**（委譲先の緑は実機の緑ではない）。束 B2 の実機 gated:
**33 passed / 2 failed / 1 skipped (36)**。

| 赤 | 判定 |
|---|---|
| `#643 E2E-4 preserves instrument contributions through output(sum) plus send(aux, gain)` | 🔴 **本束が動かした。追従漏れ** |
| `steps the live playhead through an instrument() sequence, rests included` | 既知の baseline 赤（設計 §8.4 の台帳。束 A の実機でも同じ 1 本だけが赤だった）。原因は fixture が `instrument()` + degree を書きながら `global.key()` を宣言していないこと＝**オラクル側の欠陥**で、本束の退行ではない |

**追従漏れの中身**: PR-O4 で `send` の第 2 引数が**線形係数から dB へ**変わった。
`#643 E2E-4` の譜面は `routeWet643.send("aux643", 0.5)` と書いており、旧解釈では 50%、
新解釈では **+0.5 dB（≈ ×1.06）**。したがって `total/dry` が 1.5 から **2.06** へ上がり、
`toBeLessThan(1.65)` で落ちた。

**直し方**: 同じ比を dB で書き直した（`send("aux643", -6)` → `10^(-6/20) = 0.501` →
`total/dry = 1.501`）。判定は式で書き、許容 ±0.15 は据え置き。**値を変えずに単位を変えた**ので、
このテストが守っていた「sum と aux の寄与が両方生きている」という性質は変わらない。

`send` を経路張りにだけ使っている 3 箇所（`fx625` / `fx628`）は送出量を判定していない
（oracle は ERROR 件数と child プロセスの有無）ので値は変えず、**dB として読むこと**を
先頭の 1 箇所に注記した。

### さらなる移設（#888 子 1 のレビュー追記で超過・2026-09-12）

### test(core): freeze the clock in the loop-quantize mock (#869) (Sep 11, 2026)

`tests/core/loop-quantize.spec.ts` の「snaps to the same boundary already crossed when
currentTime equals a boundary」が CI で間欠的に落ちていた（PR #847 の `code-review` ジョブ・
run 34560570537）。**#847 は docs 7 ファイルのみ**で、コードに触れていない。

#### 原因は `Date.now()` を 2 回呼んでいたこと

モックの `startTime` が getter で、アクセスのたびに `Date.now() - elapsedMs` を再計算していた。
呼ぶ側（`prepare-playback.ts:73-75`）はその直後に**別の `Date.now()`** を呼ぶ。この 2 回の間に
ミリ秒が繰り上がると `currentTime = elapsedMs + 1` になる。

このテストだけが **`elapsedMs = 2000`（小節境界ちょうど）** を突くので、+1ms で
`nextQuantizedTime` が「境界を過ぎた」と判定し、次の境界 **4000** を返す。他のテストは境界の
途中（1500 等）なので 1ms では判定が変わらない。

**プロダクションコードの欠陥ではない。** 実機の `startTime` は保存された数値で、読むたびに
動いたりしない。壊れていたのはモックの側。

#### 4000 には犯人候補が 2 つあった

`expected 4000 to be close to 2000` は、**(a) +1ms で次の小節**でも
**(b) 直前のテストの `global.quantize('2bar')` が漏れた**でも同じ値になる。(b) を潰してある:
`QuantizeManager._value` は private なインスタンスフィールド（既定 `'bar'`）で、`beforeEach` が
`Global` ごと作り直すため漏れる経路が無い（`packages/engine/src/core/global/quantize-manager.ts:75-76`）。

#### 機構の実測

旧モックと同じ 2 回読みを 500 万回回すと、**109 回**（0.0022%）で
`currentTime !== elapsedMs` になった。手元ではこの頻度だが、負荷のかかった CI runner では
2 回の `Date.now()` の間隔が広がるので、実際の発火率はこれより高い。

#### 直したもの

describe 全体で `Date.now` を固定値に固定し、`startTime` の getter も同じ定数から引く。
**両方が揃って初めて成立する** — getter だけ定数にして `Date.now` を生かすと、
`currentTime` が巨大な値になる。`afterEach` の `vi.restoreAllMocks()` が復元する。

検証: `npm test` **2,338 passed / 67 skipped / 0 failed** / `npm run lint` 緑 /
引用 938 / 0 failed。

Closes #869

### chore(release): bump the extension to 3.0.0 and the DSL spec to 1.2 (#843) (Sep 11, 2026)

owner 裁定 2026-09-11（#851 A-1）: **`v3.0.0` / DSL 1.2**。

## 🔴 動かしたのは 1 つだけ — 正本は拡張の package.json

`docs/design/656-release-design.md` §4.4 が版の所在を確定させている:

| 場所 | 規則 | 今回 |
|---|---|---|
| `packages/vscode-extension/package.json` | 🔴 **正本**。`.vsix` / `.app` / タグの版はこれ | **2.1.0 → 3.0.0** |
| `ENGINE_VERSION` | **別軸**（セッションログの meta ヘッダ）。同期しない | **2.0.0 のまま** |
| `DSL_VERSION` | **別軸**（spec 版）。同期しない | 1.1 → **1.2**（別軸の理由で動かす） |
| ルート `package.json` | `private: true` で配布物にならない | 触らない（裁定待ち (7)） |

`DSL_VERSION` を上げたのは「拡張が 3.0.0 になったから」ではなく、**DSL の表面が変わったから**
（`send` の dB 化・`output(dest, thru, db)` の導入・`pan` のライン要素化）。理由が別なので
数字も揃わない。

🔴 **私は一度これを間違えた。** 「拡張 package.json・`ENGINE_VERSION`・`DSL_VERSION` の 3 つを
揃える」と報告し、`/simplify` の Altitude が §4.4 を示して正した。
`ENGINE_VERSION 2.0.0` と拡張 `2.1.0` の食い違いは**事故ではなく設計**だった。

## なぜ major か

- `ORBITSCORE_ENGINE` 環境変数・`orbitscore.engine` / `scsynthPath` 設定・
  `Force Kill scsynth` コマンド・MCP `force_kill_scsynth` を**削除**した（#502）
- `send` が**線形係数から dB へ**変わり、既存の譜面の意味が変わる

## 追従した記述

root `README.md`（2 箇所）・`CLAUDE.md`・`docs/core/INSTRUCTION_ORBITSCORE_DSL.md`（2 箇所）・
dev サイトの `version.ts` 引用 4 箇所。いずれも「3 つは別軸」と明記して、
次に読む人が同じ取り違えをしないようにした。


#### owner 裁定（2026-09-11）と、リリース直前の README 2 件

正本 `docs/planning/NATIVE_MIGRATION_2026-09.md` §12.7 が **未決**として残していた 2 件に
裁定が出た。

| 未決だったもの | 裁定 |
|---|---|
| バージョン番号 | **3.0.0 / DSL 1.2**（`send()` の dB 化で既存譜面の意味が変わるので semver では major） |
| タグ名前空間 | **`v3.0.0`**。`ext-v*` / `app-v*` の分離はネイティブ版の新ラインで行う（§12.3）。`release.yml` のトリガーは `v*` のままでよく、ワークフローの変更は不要 |

残り 3 件は裁定待ちではなく既に解消済み: SC 削除 = #840 / gated ハーネス = #831 /
README の導線 = #842。Marketplace publish は「行わない」（owner 2026-09-10）で、
リポジトリ変数 `PUBLISH_MARKETPLACE` が未設定のため publish ステップは skip される（実測）。

**ついでに直した README 2 件** — どちらも「これから打つタグが何をするか」と食い違っていた:

- `tag push で全 channel に自動 publish` → 当時の計画である旨と、現在は GitHub Release だけが
  作られることを明記
- 「ICMC v1.1.0 bundle release」節の見出しに historical を付け、表が挙げている scsynth 同梱は
  #502 で削除済みで**現在の `.vsix` に scsynth は入っていない**という注記を足した

出荷される `packages/vscode-extension/README.md` は元から SC 参照 0 件で、Marketplace 非公開も
正しく書かれている（実測）。直したのはリポジトリ表紙の側。

ガードの実測: `checkTagAgainstVersion('v3.0.0', '3.0.0', 'darwin-arm64')` → `{ok: true}` /
`('v3.0.0', '2.1.0')` → 版が食い違うと fail（#853）。**バージョンバンプがタグより前に入る必要がある**
ことをこのガードが担保している。

検証: `npm test` 2,338 passed / 0 failed・`npm run lint` 緑・引用 944 / 0 failed。

### docs: land the nine routine docs-sync PRs as one roundup (#867) (Sep 11, 2026)

凍結版リリース（#827）のタグを打つ前に、溜まっていたルーティン docs 追従 PR **9 本**
（#837 / #844 / #847 / #856 / #858 / #862 / #864 / #865 / #866）を統合ブランチ
`867-docs-sync-roundup` で 1 本にまとめて main へ入れた。**docs のみ**で `packages/` `rust/`
`tests/` `.github/` は触っていない。学習サイトはリリースの一部なので、タグ前に反映させる必要がある
（owner 2026-09-11）。

#### なぜ 1 本にまとめたか — 逐次マージだと兄弟の内容が消える

9 本すべてが `WORK_LOG.md` を触り、#844 と #856 は 13 ファイルを共有、#837 / #862 / #865 は
`sites/dev/editor/mcp-and-gated-e2e.md` の**同じ Note 行と同じ節**に追記していた。1 本ずつ main へ
入れると残り 8 本を毎回再同期することになり、しかも従来の解決規則「WORK_LOG は両側・他は追従側を
採る」は、**main 側に兄弟 PR の内容が入った後では兄弟の内容を落とす**（規則が前提にしていた
「main 側 = 古い baseline」が成り立たなくなるため）。

#### 衝突の解決（全 22 hunk・いずれも同じ事実の別表現か、同じアンカーへの独立追記）

| 種別 | 解決 |
|---|---|
| WORK_LOG の同一アンカーへの独立エントリ（4 箇所） | 両方残す |
| #844 × #856 の SC 削除記述（11 ファイル・18 hunk） | hunk ごとに**情報量の多い側**を採る。`glossary.md` の Sources 一覧（ja/en）と `index.md` の Part VII 行（ja/en）は #844 側（#836 / #838 の粒度と `daemon-client.ts` の行がある）、残りは #856 側 |
| `mcp-and-gated-e2e.md` の Note 追従リスト（ja/en） | #830・#860・#855 の 3 件を**合併**。frontmatter は最新の `a6e1f13` / 2026-09-11 |
| 同じ章の新設節（#862 の `###` 節 × #865 の散文） | 両方残す。#865 の散文を先（直前の #756 段落から続く）、#862 の `###` 節を後 |

🔴 **1 件だけ「両方残す」では壊れた**: #865 は #857 の WORK_LOG エントリを Recent Work の先頭へ
**移動**していたので、素朴に両側を残すと同じエントリが 2 箇所に出る。移動先を残して旧位置
（54 行）を削除した。**「両側を残す」は追記には正しく、移動には正しくない。**

#### 検証

`node sites/dev/scripts/check-citations.mjs` **944 citations verified / 0 failed**（`--fix` は
使わず素で実行）/ `npm test` **2,338 passed / 67 skipped / 0 failed** / `npm run lint` 緑 /
`docs:build` dev・user 両方緑。

Closes #867

### docs(sites): re-anchor three citations #859 left pointing at the wrong code (Sep 11, 2026)

PR [#860](https://github.com/signalcompose/orbitscore/pull/860)（merge `e4d4199`）の追従。
#860 自身が `34e12b3` で dev サイトを更新しているが、**引用の再アンカーが 3 箇所ずれていた**。
`check-citations.mjs` は「引用文字列が実ファイルと一致するか」しか見ないので、
**別の関数に一致してしまった引用は緑のまま通る**。

| 箇所 | 何が起きていたか |
|---|---|
| `sites/dev{,/en}/signal-chain/mixer-audio-line.md` | bus post-loop の `LineOp::Output` 腕を引用していたはずが、`execute_master_line`（master 側）の `LineOp::Output` 腕に再アンカーされていた。直後の本文「`Output` として実行されるのは `Master` / `Bus` / `Device` の 3 つ」と引用が食い違う（master 側は `Device` 以外を `debug_assert!(false)` で落とす）。`output.rs:2566-2592` へ戻した |
| 同上（pan 節） | `apply_line_pan` の引用が切り詰められ、直後の本文が指す **`√2`** が引用内に無くなっていた。`√2` は #859 で `line_pan_coefficients` へ切り出されたので、その関数（`output.rs:2227-2243`）の引用を足した |
| `sites/dev{,/en}/rust-engine/index.md` | `render_block_with_sources` の引用が 4 行はみ出して `execute_master_line` のシグネチャを含んでいた。`1846-1932`（関数の閉じ括弧）で止めた |

あわせて、#859 が**コード引用だけ更新して本文を更新しなかった**箇所を直した
（`sites/dev{,/en}/rust-engine/index.md` の `advance_gain` 節）。旧本文の
「block が ramp より長ければ 1 回で目標へ到達」は、いまはブロック**終端**の値の話であって、
ブロック内は `ramp_frames` サンプルかけて補間される。これは #859 が直した欠陥そのものなので、
そのまま残すと修正前の振る舞いを説明する文が残ることになる。

4 章の `verified-against` / `verified-at` を `e4d4199` / 2026-09-11 に更新。

検証: `npm run docs:check` **938 citations / 0 failed** / `docs:build`（user / dev）両方緑。
---

### さらなる移設（#888 束のレビュー追記で超過・2026-09-12）

### fix(release): ship the extension's own runtime deps so the .vsix can activate (#873) (Sep 11, 2026)

🔴 **凍結版リリースのブロッカー。** cold install（#138・ゴールの最終段）で発見した。
素の VS Code に `.vsix` を入れると、**拡張が activate せずに落ちていた**。

```
Error: Cannot find module '@modelcontextprotocol/sdk/server/mcp.js'
  at Object.<anonymous> (.../local.orbitscore-3.0.0/dist/extension.js:74:22)
```

#### 原因 — npm workspaces の hoisting

`packages/vscode-extension/package.json` は `@modelcontextprotocol/sdk` と `zod` を実行時依存として
宣言しているが、どちらも npm workspaces が**リポジトリルートへ hoist** する。`.vscodeignore` は
`../../**` と `../*/**` でパッケージ外を全部落とすので、`vsce package` が同梱する
`extension/node_modules` は **`@types` と `undici-types` の 2 つだけ**だった（実測）。

`require` は遅延ではない: `dist/extension.js:74` → `require("./mcp-server")` →
`dist/mcp-server.js:51-53` がトップレベルで SDK と zod を要求する。よって activate が無条件に落ちる。

#### engine 側では 2 回起きていた事故が、拡張側だけ無防備だった

| 出典 | 欠けた依存 | 症状 |
|---|---|---|
| WORK_LOG 6.119 (Jun 17, 2026) | `@julusian/midi` / `uuid` / `ws` | engine が MIDI 初期化で落ちる |
| WORK_LOG 6.422 (Aug 30, 2026) | `yaml` | #654 の実機ゲートで発見。engine が最初の evaluate で落ちる |
| **#873** | **`@modelcontextprotocol/sdk`** | **activate() がそもそも走らない** |

対策の `scripts/install-engine-deps.sh` は **engine の依存しか見ていなかった**。ロジックを
`scripts/install-bundle-deps.sh` へ抽出し、engine と拡張の両方がそこを通るようにした（DRY）。

#### 置き場所が `dist/node_modules` なのには理由が 2 つある

1. **`vsce package` はパッケージ直下の `node_modules` を無条件に除外する。**
   `.vscodeignore` に `!node_modules/**` と書いても**上書きできない**（実測）。
   `engine/node_modules` や `dist/node_modules` のような入れ子は特別扱いされず普通に入る
2. **Node の解決順で最初に当たる。** `dist/mcp-server.js` から見て `dist/node_modules` は
   1 つ目の候補なので、パスの書き換えが要らない

パッケージ直下へ入れると**パッケージング自体が壊れる**: 依存が hoist 先とローカルの 2 箇所で
解決できるようになり、`vsce` の依存探索が 1 つの `.vsix` エントリに 2 つの元パスを出して
`the following files have the same case insensitive path` で失敗する。だから
`vsce package` には **`--no-dependencies`** を付け、探索そのものを止めてある。

#### CI が捕まえられなかった理由と、足したゲート

`release.yml` の post-package 検証は `packages/engine/package.json` の依存しか突合していなかった。
同型の検査を**拡張自身の依存**にも足した（`extension/dist/node_modules/<dep>` の実在確認）。
この PR は `packages/vscode-extension/**` と `release.yml` の両方を触るので、
release smoke が本 PR 上で実際に `.vsix` を作ってこのゲートを通す。

#### 検証 — cold install で音が出るところまで

空の `--extensions-dir` に `.vsix` を入れ、**`--extensionDevelopmentPath` を使わず**
インストール済み拡張として素の VS Code を起動し、MCP だけで駆動した。

| 確認 | 結果 |
|---|---|
| activate | ✅ `Cannot find module` 0 件 |
| MCP サーバ | ✅ 2 秒で listen |
| daemon の解決 | ✅ `/private/tmp/orbcold-e-*/local.orbitscore-3.0.0/engine/bin/darwin-arm64/orbit-audio-daemon` |
| 評価 | ✅ `ok` |
| **音** | ✅ capture 36.10 s・非ゼロ **46.7%**・**RMS 0.053537**・peak 1.133490 |

🔴 **daemon が拡張バンドルから解決された**ことが、cold install でしか通らない経路の確認にあたる。
dev host（`--extensionDevelopmentPath`）はリポジトリの `rust/target/release` を引くため、
`extension-bundle` 分岐を一度も通らない。#138 がここまで「⏳ Pending」だった穴がこれ。

検証: `npm test` 2,338 passed / 0 failed・`npm run lint` 緑・引用 944 / 0 failed
（`release.yml` に行を足したので `signal-chain/index.md` の `184-193` を `204-213` へ再アンカー。
着地先が標準プラグイン同梱ゲートであることを目視で確認済み）。

Closes #873


#### `/simplify` の反映（4 エージェント並行・#874）

| 指摘 | 対応 |
|---|---|
| `--prune` / merge の分岐を**どの呼び出し元も使っていない**（両方 `--prune`） | 削除。`dist/node_modules` へ寄せる前の探索の残骸だった。常に置き換える形に一本化 |
| `install-bundle-deps.sh` が `DEST_DIR` を作らないので wrapper が `mkdir` を持たされていた | `mkdir -p "$DEST_DIR"` にした |
| `release.yml` の依存検査ループが engine / extension で重複（同型が計 3 箇所） | 1 ループに畳んだ。`"<label>:<package.json>:<vsix 内の node_modules>"` の表を回す |
| `npm run build` のたびに `npm install` が 2 回走る | 宣言した依存の spec を `node_modules/.orbitscore-bundle-deps.json` に刻み、一致していれば skip。実測で 2 回目以降は `already current — skipping install` |
| 同じ JSON を `node -e` で 2 回読んでいた | 1 回に畳んだ（書き出しと同じ pass で名前も出す） |
| レジストリへの往復 | `npm install` に `--prefer-offline` を足した |
| esbuild という深い解が検討された形跡が残らない | **#875** を立て、`install-bundle-deps.sh` のヘッダから指した |

**見送ったもの**:

- **wrapper 2 本を 1 本に畳む** — `install-engine-deps.sh` は外部（CLAUDE.md の手動ゲート・root の `pretest:e2e:gated`・dev サイト）が名前で呼ぶので残す必要がある。`install-extension-deps.sh` を消すと、**「なぜ `dist/node_modules` なのか」という実測 2 件の知識**を `package.json` の 1 行に添える場所が無くなる。名前付きファイルに置く方の価値を取った
- **`scripts/orbitstudio/make-local-release.sh` が同じ機構を再実装している** — git 管理外（未追跡）で、`scripts/orbitstudio/` ごと畳む予定（正本 §12.7 の 3）。なお `extension/node_modules/$DEP` を見ているので、**黙って壊れた成果物を作るのではなく loud に落ちる**（安全な側）

#### 整理後にもう一度 cold install を通した

| 確認 | 結果 |
|---|---|
| activate | ✅ `Cannot find module` 0 件・MCP は 4 秒で listen |
| 評価 | ✅ `ok` |
| 音 | ✅ capture 15.04 s・非ゼロ **46.5%**・**RMS 0.052550**・peak 1.133490（前回と同一） |

CI ゲートの**負の確認**も取れている: 修正前の `.vsix` を展開したディレクトリに同じループを当てると
`::error::extension runtime dependency '@modelcontextprotocol/sdk' missing` で exit 1 になった。


#### レビューラウンド 1（4 レビュアー + Fable 監査を並行）と、その fix

**Critical 2 件はどちらも main（自分）の手が原因だった。**

| # | 誰が | 指摘 |
|---|---|---|
| C1 | silent-failure-hunter | `/simplify` で 2 つのループを 1 本に畳んだ際に足した `|| {}` が、**`dependencies` を読めない時に「何も検査せず緑」**を作っていた。旧 engine 版には `|| {}` が無く `TypeError` → `set -e` で落ちていた。`package.json` の typo 1 つで、この PR が塞いだ欠陥クラスがゲート側に復活する |
| C2 | comment-analyzer | 出典の `#209` / `#654` が**無関係の issue**（#209 = LinkAudio の feature、#654 = playhead の修正）。既存コメントの誤帰属を「3 回刺さった」という目立つ表へ増幅していた |

**Fable が Sonnet 4 体と直交して見つけたもの:**

- ゲートは**宣言された最上位の依存しか見ない**。sdk の推移依存 17 個が欠けても緑のまま MCP が落ちる
- **出荷版が lockfile と乖離**（sdk 1.29.0→1.30.0 / zod 4.4.3→4.6.2 / yaml 2.8.3→2.9.0 / midi 3.6.1→3.8.1）。**テストしたのと別の版を凍結版として出す**ことになっていた
- **ゲート自身を守るテストが無い**。同型の child バイナリのゲートには `bundled-child-binaries.spec.ts` があり、台帳照合とゲートの bash 実走の両方をやっている
- `release.yml` の `pull_request.paths` に install スクリプトが無く、それだけを触る PR は smoke が走らない

一方 **`vsce` の挙動についての実測クレームは、vsce 2.32.0 のソースで裏付けが取れた**（`collectAllFiles` が `.vscodeignore` 適用**前**に `node_modules/**` をハードコード除外し、そのパターンは入れ子にマッチしない）。ただし「無条件」は `--no-dependencies` 下でのみ真。

#### 設計パス（指摘ごとのローカルパッチにしない）

> **ゲートは「宣言を数える」のではなく「出荷物の中で実際に解決できるか」を検査する。
> チェックリストが空になったら「依存が無い」ではなく「読み方を間違えた」として loud に落とす。
> そしてゲート自身を守るテストを同じ PR に置く。**

`scripts/check-vsix-bundled-deps.mjs` を新設（前例: `check-release-tag-version.mjs`）。`release.yml` の
インライン 14 行はその呼び出し 1 行になり、**C1 の `|| {}` ごと消えた**。検査は
`createRequire(<出荷物内の実 require 元>).resolve(<実 specifier>)` で、解決した各パッケージの
`dependencies` を再帰的に辿る（コードは実行しない）。

#### 受け入れ検証（main が sandbox 外で実走・自己申告は根拠にしない）

🔴 **同一の壊れたツリーに対する新旧の比較**（`dist/node_modules/express` = sdk の推移依存を削除）:

| ゲート | 結果 |
|---|---|
| 旧（宣言された最上位ディレクトリのみ） | `all declared dependencies present — PASS` / **exit 0** |
| 新（出荷物内で実際に解決） | **exit 1** |

**検出力が名目でなく実際に増えている。**

壊し方を 3 通り試して全部 exit=1（原因を名指し）: 宣言依存の削除（`zod`）/ **推移依存の削除（`express`）** / engine 依存の削除（`yaml`）。

C1 の変異: `dependencies` → `dependencyes`（#873 と同型の typo）で **exit=1**、戻して **exit=0**。

lockfile 固定の実測 — 7 件すべて一致し、`uuid` は罠を回避（`packages/engine/node_modules/uuid` の
**13.0.2**。`node_modules/mermaid/node_modules/uuid` の 11.1.1 ではない）:

| 依存 | lockfile | 出荷 | 修正前 |
|---|---|---|---|
| `@modelcontextprotocol/sdk` | 1.29.0 | **1.29.0** | 1.30.0 |
| `zod` | 4.4.3 | **4.4.3** | 4.6.2 |
| `uuid` | 13.0.2 | **13.0.2** | — |
| `yaml` | 2.8.3 | **2.8.3** | 2.9.0 |
| `@julusian/midi` | 3.6.1 | **3.6.1** | 3.8.1 |

cold install をやり直し（**Finder 相当の最小 PATH** で起動）: activate ✅ / `Cannot find module` 0 件 /
MCP 4 秒 / `evaluate` ok / **engine ログの `ERROR:` 0 行** / capture 16.04 s・非ゼロ **42.7%**・
**RMS 0.050784**。

`npm test` **2,347 passed / 67 skipped / 0 failed**（+9）・lint 緑・`typecheck:e2e` 緑・
引用 944 / 0 failed（`release.yml` の行が動いたので 4 件を再アンカーし、着地先が
「実 Gain テスト」と「標準プラグイン同梱ゲート」であることを目視確認。散文の行参照も追従させた）。

#### 見送り・切り出し

- **wrapper 2 本を 1 本に畳む** — `install-engine-deps.sh` は外部が名前で呼ぶので残す必要があり、
  `install-extension-deps.sh` を消すと「なぜ `dist/node_modules` なのか」という実測 2 件の知識を
  置く場所が無くなる
- **#877**: cold install を再実行できる gated spec にする（#138 を #656 へ吸収する計画から切り離す —
  #656 はネイティブ `.app` 配布で別物・後の話）
- **#878**: `extension.ts:2000` の `spawn('node', …)` が PATH 依存で `process.execPath` の
  フォールバックが無い。実測では VS Code の shell 環境解決に救われて通ったが、**出荷の前提が
  他社実装の詳細に乗っている**
- **#875**: esbuild でバンドルして本機構ごと退役させる（宣言されていない import は今の機構では
  原理的に見えない）


#### fix 差分の再点検（ラウンドを閉じる前・1 レビュアー）

問いは 2 つだけ: 「この修正が導入する新しい故障モードは何か」「新コードはどの実行コンテキストで走るか」。
**Critical 0 / Important 3**。いずれも同じ向き — **保証が深さ 1 では本物で、深さ 2 以上で宣言検査へ退化する**。

🔴 **加えて、main 自身が 1 件見つけた**: `.vscodeignore` に**未コミットの変更が残っていた**。
`git commit` した**後**に Codex が書いたもので、「完了通知は稼働終了を意味しない」の実例。
内容は `!engine/node_modules/**` の削除で、理由として「入れ子は普通に入る」と書かれていた。

**実測したら理由が誤りだった**: 否定指定を外すと `engine/node_modules` の同梱が **422 → 317 件**へ減る。
つまり否定指定は load-bearing で、`**/*.ts` 等の一般規則が効いているのを打ち消していた。
ただし失われる 105 件の内訳は **`.ts` が 104 個とスタンプ 1 件**で、`.js` / `.node` /
パッケージの `package.json` は 1 つも落ちない。**変更自体は実害のないサイズ削減**（9.4 → 9.34 MB）
なので採用し、**コメントを実態に書き直した**（数字つきで）。

| 指摘 | 対応 |
|---|---|
| 推移依存の版が固定されていない（temp install に lockfile が無く range で再解決される） | **限界として明記**。宣言層の乖離（sdk 1.30.0 / zod 4.6.2 対 lockfile の 1.29.0 / 4.4.3）は潰れており、そこが譜面の振る舞いに効く層。グラフ全体の固定は lockfile の合成が要るので #875 へ |
| 深さ 2 以上は `require.resolve` ではなくディレクトリ探索（存在すれば通る） | **限界として明記**。全辺を実解決する案は**試して却下**されている — CJS が実際には require しない ESM-only の推移パッケージで**偽の赤**になり、リリースを理由なく止める |
| `catch {}` が内側のエラーを捨て、どの推移パッケージが欠けたか分からない | **直した**。`reason` を持ち回って診断に出す |

再点検後の実測 — `dist/node_modules/express`（sdk の推移依存）を削除:

```
::error::extension runtime specifier '@modelcontextprotocol/sdk/server/mcp.js' cannot be
resolved from extension/dist/mcp-server.js in the packaged .vsix
  — express cannot be resolved from .../node_modules/@modelcontextprotocol/sdk/package.json
```

**どの推移パッケージが欠けたかがログだけで分かる。** 以前は最上位の specifier しか出なかった。

`npm test` 2,347 passed / 0 failed・lint 緑・引用 944 / 0 failed・ゲートは実 `.vsix` で exit 0。

#### 🔴 CI が 3 回走っていなかった

`f83aa658` / `b99c1d04` / `af19ac93` の push で CI が 1 度も起動していなかった。原因は
**PR が `DIRTY`**（main と衝突）だったこと — GitHub は merge commit を計算できない PR では
`pull_request` ワークフローを走らせない。**緑でも赤でもなく「無」だったので、`gh pr checks` は
`no checks reported` としか言わない。** main をマージして解消した。

**教訓**: `gh pr checks` が「no checks reported」と言う時は、待つのではなく
`gh pr view --json mergeStateStatus` を見る。

### 4.0.1 リリース時の移設（本体の 2,000 行上限・2026-09-12）

### release: tag v3.0.0 — the extension line is frozen as stable (#827) (Sep 11, 2026)

owner 裁定 2026-09-10（#827・正本 `docs/planning/NATIVE_MIGRATION_2026-09.md` §12）の凍結線に到達した。
以降のネイティブ OrbitStudio.app は新ライン。

#### 裁定（2026-09-11）— §12.7 が未決として残していた 2 件

| 未決だったもの | 裁定 |
|---|---|
| バージョン | **3.0.0 / DSL 1.2**（`send()` の dB 化で既存譜面の意味が変わるので semver では major） |
| タグ名前空間 | **`v3.0.0`**。`ext-v*` / `app-v*` の分離は新ラインで（§12.3）。`release.yml` は `v*` トリガーのままで変更不要 |

残り 3 件は裁定待ちではなく解消済み: SC 削除 = #840 / gated ハーネス = #831 / README = #842。
Marketplace publish は「行わない」（owner 2026-09-10）で、`PUBLISH_MARKETPLACE` 未設定のため
publish ステップは skip される（`gh variable list` で実測）。

#### タグ直前の実測（main `61f947d7`）

| 確認 | 結果 |
|---|---|
| `npm test` | **2,347 passed / 67 skipped / 0 failed** |
| `npm run lint` | 緑 |
| `check-citations.mjs`（素で実行） | **944 / 0 failed** |
| `.vsix` の依存ゲート | engine 5/5・extension 2 宣言 + **3 specifier 解決** |
| 出荷物の `scsynth` / `supercollider` 参照 | **0** |
| タグ照合ガード（#853） | `v3.0.0` vs `3.0.0` → `{ok: true}` |
| マージ前ゲート（`orbit-effect-rack-child`） | `--ignored` **3 passed** / 通常 **16 passed** |

#### 🔴 凍結は 1 日延びた — cold install がブロッカーを出した

タグを打つ直前に cold install を回したところ、**`.vsix` が activate すらできなかった**（#873）。

```
Error: Cannot find module '@modelcontextprotocol/sdk/server/mcp.js'
```

**この時点でビルド・ユニット 2,338 件・lint・引用・`release.yml` の post-package ゲート全項目が
緑だった。** npm workspaces が拡張の実行時依存をルートへ hoist し、`vsce package` が同梱する
`extension/node_modules` には `@types` と `undici-types` しか入っていなかった。engine 側には
同型の事故が 2 回あり対策もあったのに（WORK_LOG 6.119 / 6.422）、**拡張自身の依存だけ無防備**だった。
MCP サーバ（#388）が入った時点から壊れていた可能性が高い。

**dev host は構造的にここを見ない**:

| 経路 | dev host（`--extensionDevelopmentPath`） | cold install |
|---|---|---|
| daemon の解決 | `monorepo-release`（リポジトリの `rust/target/release`） | **`extension-bundle`** |
| 拡張の実行時依存 | ルートに hoist されたものが walk-up で見つかる | **`.vsix` に入っているものだけ** |

#874 で直し、**ゲートを「宣言を数える」から「出荷物の中で実際に解決する」へ変えた**。
同一の壊れたツリー（sdk の推移依存 `express` を削除）に対して旧ゲートは exit 0、新ゲートは exit 1。

#### 今日 main に入ったもの

| PR | 内容 |
|---|---|
| #868 | ルーティン docs 追従 **9 本**を 1 本に統合（#837 / #844 / #847 / #856 / #858 / #862 / #864 / #865 / #866） |
| #870 | `loop-quantize` の 1ms レース（CI を間欠的に赤くしていた真因） |
| #871 | 拡張 3.0.0 / DSL 1.2 + リリース直前の README 2 件 |
| **#874** | **`.vsix` が activate できなかったブロッカー** + それを守るゲートとテスト |
| #876 / #872 | 上記の docs 追従 |

#### 新ラインへ送ったもの

| # | 内容 |
|---|---|
| #875 | esbuild でバンドルし、copy-a-node_modules の機構ごと退役させる |
| #877 | cold install を再実行できる gated spec にする（#138 を #656 から切り離す） |
| #878 | `extension.ts:2000` の `spawn('node', …)` が PATH 依存で `process.execPath` のフォールバックが無い |
| #849 | ネイティブ macOS OrbitStudio の設計 |


#### 収束条件の最終確認 — **公開された資産**で cold install

ローカルビルドではなく **GitHub Release からダウンロードした `.vsix`**（利用者が受け取るもの）で検証した。

| 検証 | 結果 |
|---|---|
| 資産の版 vs タグ | `3.0.0` = `v3.0.0` |
| 依存ゲート（`check-vsix-bundled-deps.mjs`） | engine 5/5・extension 2 宣言 + **3 specifier 解決** |
| `scsynth` / `supercollider` の参照 | **0** |
| activate | `Cannot find module` **0 件** |
| MCP サーバ | **4 秒**で listen |
| engine ログ | `ERROR:` **0 行** |
| **音** | capture **34.09 s**・非ゼロ **24.2%**・**RMS 0.038183**・peak 1.133490 |

🔴 **起動は Finder 相当の最小 PATH で行った**
（`/usr/local/bin:/System/Cryptexes/App/usr/bin:/usr/bin:/bin:/usr/sbin:/sbin`）。
`extension.ts:2000` の `spawn('node', …)` が PATH 依存なので（#878）、シェルから起動すると
この条件を検証したことにならない。

**`--extensionDevelopmentPath` は使っていない。** dev host はリポジトリの
`rust/target/release` から daemon を引き、依存もルートの hoist 先から walk-up で見つけるため、
**`extension-bundle` 解決と同梱依存のどちらも通らない**。#873 はまさにそこに隠れていた。

#### 🔴 署名・公証の実測（#881 を起票）

同梱ネイティブバイナリ 8 個は **ad-hoc 署名のみ**（`linker-signed` / `TeamIdentifier=not set`）。

| 確認 | 結果 |
|---|---|
| `spctl -a -vv -t execute` | **rejected** |
| quarantine を付けて実行 | **exit 137（SIGKILL）**+ 「Apple は…検証できませんでした」ダイアログ |
| VS Code の `--install-extension` 後の `xattr` | **0 件** → 実行 exit 0 |
| `ditto -x -k` / `/usr/bin/unzip` で展開 | **quarantine が伝播する** |

**動いているのは、VS Code の `.vsix` 展開が quarantine を付けないから**であって、署名が
通っているからではない。他社実装への暗黙の依存で、#878（`spawn('node')` が VS Code の
シェル環境解決に救われている）と同じ形。ネイティブ `.app` のラインでは逃げ道が無く必須になる。


#### インストール導線の実物合わせ

リリース後、**利用者が実際に辿る経路**を上から見て 2 件直した。

**1. GitHub Release の本文が空だった。** `release.yml` は `gh release create --generate-notes` を
使うので、出るのは **v2.0.0 以降の全 PR 一覧（279 行）**だけだった。**利用者が最初に見る場所**が
それでは使えないので、本文を書き直した:

- 動作環境の表（arm64 専用・Intel 非対応・VS Code 1.99.0 以上）
- インストール 3 方式（ダブルクリック / コマンドパレット / CLI）+ 更新手順
- 最初の音を出すまでの 4 ステップ + Walkthrough への導線
- 3 軸のバージョン（拡張 3.0.0 / `DSL_VERSION` 1.2 / `ENGINE_VERSION` 2.0.0）が同期しないこと
- **既知の制限**（LinkAudio は出荷ビルドで無効 / `compressor()` 等は no-op / `.time()` `.fixpitch()` は未実装）
- 変更履歴は `<details>` に畳んだ

**2. ドキュメントのファイル名が実物と違った。** 資産名は `orbitscore-darwin-arm64-3.0.0.vsix` だが、
README 2 本は `orbitscore-<version>.vsix`、ユーザーサイトは `orbitscore-*.vsix` と書いていた。
**ターゲット接尾辞が抜けている**のが原因なので、版番号は固定せず `darwin-arm64` だけ足した
（`orbitscore-darwin-arm64-<version>.vsix`）。版を書き込むと次のリリースで腐る。

併せてユーザーサイトに [releases/latest](https://github.com/signalcompose/orbitscore/releases/latest)
への導線と「Assets の中にある」の一言を足した。

#### 実測で確かめたこと（記述が現行実装と合っているか）

- 出荷 README の「Audio Engine Settings で出力デバイスを選ぶ」は**正しい**。
  `orbit-audio-daemon --list-audio-devices` は実環境で 2 件返す（`MacBook Proのスピーカー` /
  `Pro Tools Aggregate I/O`）。🔴 **サンドボックス内では `{"devices":[]}` を返す**ので、
  ここを検証する時はサンドボックスを外すこと
- MCP の `list_audio_devices` が「not supported with the Rust engine」を返すのは**別の話**で、
  こちらは意図的な未実装（`extension.ts:2950-2956`・doc 662 §6 / #660）。UI の経路とは違う

検証: 引用 944 / 0 failed・`npm test` 2,347 passed / 0 failed・lint 緑・
`docs:build -w @orbitscore/user-site` 緑。

### docs: follow the 3.0.0 / DSL 1.2 bump into the docs the bump missed (PR #871 追従) (Sep 11, 2026)

ルーティン docs 追従。追従元は PR [#871](https://github.com/signalcompose/orbitscore/pull/871)
（マージコミット `56c34c3`・head `d5decc2`）。**実装とテストは触っていない**（docs と dev サイトのみ）。

#871 は正本 3 箇所（`packages/vscode-extension/package.json` = 3.0.0 /
`packages/engine/src/version.ts` の `DSL_VERSION` = 1.2 / `ENGINE_VERSION` は据え置き）を動かし、
`CLAUDE.md`・root `README.md`・`docs/core/INSTRUCTION_ORBITSCORE_DSL.md`・dev サイトの
`version.ts` 引用 4 箇所を追従させた。**引用ブロックは更新されたが、その引用を説明している
散文が 1.1 / 2.1.0 のまま残っていた**ページがある。

| 直した箇所 | 何が食い違っていたか |
|---|---|
| `docs/core/INDEX.md:5` | 表紙が `DSL_VERSION 1.1` / 拡張 `2.1.0` を名乗ったまま |
| `README.md:55` | `Post-2.0 (shipped on main, extension 2.1.0)` |
| `sites/dev{,/en}/orientation/architecture-overview.md` | 引用ブロックは `1.2` なのに、直下の箇条書きが `DSL spec 1.1` / 拡張 `2.1.0` |
| `sites/dev{,/en}/decisions/adr-002-dsl-v3-pivot.md` | 同上（Sources 行が `DSL_VERSION = '1.1'`・導入の「ちなみに」段落が v1.1 / product 2.0.0） |
| `sites/dev{,/en}/editor/vscode-architecture.md` | 冒頭と Sources の `package version 2.1.0` |

いずれも「3 つは別軸で同期しない」（`docs/design/656-release-design.md` §4.4）を本文に書き足して、
次に読む人が #871 と同じ取り違え（WORK_LOG の「私は一度これを間違えた」）を繰り返さないようにした。
dev サイトは日英両方。frontmatter の `verified-against` / `verified-at` を更新した 3 章（6 ファイル）は、
Note 行に「**バージョン節だけ**追従した」と明記して、章全体を再検証したと読まれないようにしてある。

**直さずに報告に回したもの**（仕様の判断であって追従作業ではない）:

- `docs/specs-v2/PITCH_DSL_SPEC_v1.1.md:5` の docmeta が `"version":"1.1"`。`DSL_VERSION` は 1.2 に
  なったが、**1.2 の spec 文書は存在しない**。spec 正本をどう扱うかは owner 裁定事項
- `docs/specs-v2/SESSION_LOG_SPEC_v1.md:51` のメタヘッダ例が `"dslVersion":"1.1"`。同じ行の
  `"engineVersion":"1.1.0"` は #871 と無関係に古く（§5-5 で version 自動同期は #276 deferred と明記）、
  片方だけ直すと実在しないサンプルになる
- `docs/core/INSTRUCTION_ORBITSCORE_DSL.md:3,5` の `Product version: OrbitScore 2.0.0`。#871 で
  `CLAUDE.md` は「Product: 拡張 3.0.0」に変わったので、「product version」という軸を残すのかが未決

### docs: PR #870 のドキュメント追従レビュー — 追従不要（Sep 11, 2026）

マージ済み PR #870（`f56e02e7d03306f7d811b2d2edac9814baa38ee5`）に対するドキュメント追従レビュー。

**ドキュメントの追従は不要**と分類した。差分 2 ファイルの内訳は
`tests/core/loop-quantize.spec.ts`（モックの時計を固定するテストのみの変更）と
`docs/development/WORK_LOG.md`（PR 自身が記載済み）で、出荷物・DSL の意味論・MCP の表面・
OrbitStudio の評価経路のいずれにも差分が無い。`nextQuantizedTime()` の実装は無変更で、
`sites/dev/scheduling/transport.md:388-410` の記述と `docs/core/INSTRUCTION_ORBITSCORE_DSL.md:316-354`
は現行実装と一致している。

ただし**実機 E2E の穴**は残っている。この PR が固定した LOOP quantize の起動境界は、
`tests/e2e/dsl-e2e-coverage.spec.ts` の baseline 上で今も未カバーである
（`loop`/`quantize` が seq・global 両方に、`transport-loop` が構文側に載ったまま）。
詳細と再現手順は本コミットの PR 本文に記載した。**baseline は編集していない。**

### #887 TS 分割時の移設（本体の 2,000 行上限・2026-09-12）

### docs(spec): land the #883 rulings in the normative specs (bundle 0) (Sep 11, 2026)

**Date**: 2026-09-11
**Status**: ✅ 束 0 完了（spec 先行・運用規則 6）。実装（束 C / S）は未着手

#883 の裁定 6 件を正本へ落とした。**実装より先に spec を直す**（運用規則 6）。

| 文書 | 改訂 |
|---|---|
| `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` MX.2 | 暗黙終端の段落を「**出口は書かれたものがすべて。書かないラインは無音**」へ置換。旧規則は撤回理由（`send(aux)` と `send(sum)` で正しい振る舞いが逆）付きで引用ブロックに残した。`destination` を省略可（既定 `"master"`）に |
| `docs/specs-v2/SIGNAL_CHAIN_DSL_SPEC_v1.md` SC.2 規範 (4) | 🔴 **裁定 6 と逆を向いていた**（「マスターもレシーバである」「master も宛先を持てる 1 レシーバ」）→「**master トラックは `global` が所有する**。`master.<...>` のレシーバ表面は設けない。device 出口 1,2 は定数なので『未設定は無音』の**適用対象外**」へ |
| 同 SC.2 規範 (6) | 「暗黙 master(1,2) を持つ」を **(i) ノードの存在**だけに限定。(ii) 自動ルーティングの廃止を明記。決定 #75 は `.output()` を書いても import / マニフェスト不要なので引き続き満たされる |
| `docs/design/611-output-line-design.md` §2.1 | 撤回の追記。**却下判断が aux しか見ていなかった**こと、§9 の互換要件も制約でなくなったこと |
| `docs/specs-v2/DESIGN_DISCUSSION_RECORD.md` | 決定 **#78**（暗黙終端の廃止・P2 却下理由 = 不連続）と **#79**（master は global が所有）を追加。決定 #75 に「#78 で意味を (i) に限定」の注記 |
| `docs/planning/DEVELOPMENT_MAP.md` §3 | 🔴 **凍結線の前提が崩れた**ことを事実が変わった瞬間に記録（§5.1b）。凍結線は 4.0.0 へ |

#### ゲート

- `npm run docs:check`: **948 引用 / 0 failed**。spec の行ずれで 4 件落ちたので `--fix` を実行し、
  🔴 **着地先の内容を目視で照合**（`global.sum("drum") // group bus 宣言（冪等）` /
  `global.aux("rev") // return bus 宣言` が期待スニペットと一致）。
  memory `citation-fix-can-land-on-the-wrong-function`「緑は『行が合った』証明」に従う
- `tests/docs/`: 5 passed（`planning-issue-state` のラチェット含む）

#### 関連

#883 / #611 / 決定 #75 #78 #79

---

### design: explicit output routing — drop the implicit master terminal (#883) (Sep 11, 2026)

**Date**: 2026-09-11
**Status**: 設計完了・裁定 6 件すべて確定（実装未着手）
**成果物**: `docs/design/883-explicit-output-routing-design.md`（493 行）

#### 発端

LinkAudio の標準プラグイン化を検討する中で、`thru:` の意味論を追ったところ
**暗黙 master 終端の欠陥**が出た。owner 裁定で LinkAudio より先にこちらを片付けることにした。

🔴 **実測した欠陥**: `send()` は sum バスも受け取る（`sequence.ts:661-665`）。
`send` は `output(dest, thru: true)` の糖衣で**終端ではない**ので暗黙 master が付く。結果、

```js
global.sum("drums")
kick.send(drums, -6)
snare.send(drums, -6)
```

で master が受け取るのは **kick の dry + snare の dry + (kick+snare の合算)** =
**各素材が 2 回**。`drums` に挿したグルーコンプを **dry が迂回する**。

#### owner 裁定（grand truth）

> 音楽記述言語としての OrbitScore DSL は「**テキストが完全な真実**」であるべき

暗黙終端を**完全に廃止**する（P3）。「出口を 1 つも書かなければ暗黙」案（P2）も却下
— `kick.play()` は鳴るのに `.send(verb,-12)` を 1 つ足した瞬間に master への dry が消える
**不連続**が残るため。譜面の下位互換は担保しない（owner「そっちを直せばいい」）。

#### 設計が覆した #883 の前提

| # | 訂正 |
|---|---|
| 1 | 暗黙 master の実体は **1 箇所ではなく 4 箇所**（`program()` の合成 / バス無し audio の直接描画 / daemon のバス既定ライン / instrument の `target:null`）。A だけ消しても `kick.play()` は鳴り続ける |
| 2 | `.output()` 必須化は **9 本目で throw**（`SEQUENCE_EFFECT_BUS_POOL_SIZE = 8`）。出荷 example の **4 本**が 8 を超える（17 / 16 / 13 / 12） |
| 3 | `program()` は `elements` に完全には畳まない（`[rack]` の位置マーカーは routing ではない） |

#### main の審査で出た指摘（4 件・すべて反映）

1. 🔴 **固定上限は「避けるもの」ではなく「撤廃が裁定済みのもの」**（owner「実害ではない。正しく治すだけ」）。
   Q-598-5「マシンの上限まで使える」/ doc 662 §10「上限を決めない対象に**トラック / インスト**を含む」/ #663。
   → instrument の常時バス確保を撤回し、`SetSourceRouting.target` を明示 3 値へ（固定上限への依存が 1 行も増えない形）
2. skip は `resolveDispatchChannel()` の **`isNoteSequence()` 早期 return より後ろ**に置く。
   前に置くと **MIDI が無音**（同じ箇所のコメントが #282 で一度踏んだと記録）
3. `send(aux)` と `send(sum)` で**正しい振る舞いが逆**（aux は dry が残るのが正しい / sum は誤り）。
   611 §2.1 が P2 を却下した時に見落としていた場合分け
4. 🔴 **失敗時の向きが「鳴る」になっている** — 横断規則を 1 つ置いた:
   「routing 状態が未設定・表現不能・失われた時、その信号はどこにも加算されない」。
   適用 6 箇所（`encode` / `decode` / daemon 既定ライン / `FeedDest` 変換 2 / スロット解放）。
   副産物として **F2（TS の push 順序が狂うと鳴る）が消滅**した — 最悪の状態が無音になったため

#### 裁定 6 件（owner 2026-09-11）

`[rack]` 前置は残す / `output-missing` = Warning / `dry-not-routed` = Information /
`SetSourceRouting.target` を明示 3 値へ（一方通行）/ 実現の省略を採る /
🔴 **master トラックは `global` が所有する**。

最後の 1 件は owner 逐語「マスタートラックは global が持っている、でいいのでは？」。
`master.output(...)` / `master.effect(...)` という表面は**作らない**。マスタリングは
`global.effect(["Comp", Gain(db: -3), "Limiter"])` で今日すでに書ける（`global.ts:445`・PH.2）。
違う出力を使いたければ aux を作ってそちらへ集める（owner 同日）。

🔴 **この裁定は `SIGNAL_CHAIN_DSL_SPEC_v1.md` SC.2 規範 (4) と逆を向いている**
（今日は「マスターもレシーバである」と書いてある）。**束 0 で書き換える**。

#### 版

**4.0.0 / `DSL_VERSION` 2.0**。3.0.0 を major にした理由（`send()` の dB 化で譜面の意味が変わる）と
同じクラス — `kick.play()` が「鳴る」→「鳴らない」に変わる。

#### 束

**0**（spec 先行・main 直行）→ **C**（振る舞いを変えない）→ **S**（振る舞いを変える）。
C を先に置くのは「**golden が 1 つも動かない**」ことでしか C を検算できないため。

#### 関連

#883 / #663（プール上限の撤廃）/ #611（出力ライン設計・§2.1 に撤回追記）/ #282（MIDI の skip 誤爆）

---

### docs: follow the dev site to the .vsix dependency bundling fix (PR #874) (Sep 11, 2026)

マージ済み PR [#874](https://github.com/signalcompose/orbitscore/pull/874)（merge commit `a2ac724`）へのドキュメント追従。**コード・テストは一切変更していない。**

`sites/dev/editor/vscode-architecture.md` と `sites/dev/en/editor/vscode-architecture.md`（日英バイリンガル）に節を 1 つ追加した。置き場所は `activate()` の章の末尾で、理由は**この不具合が `activate()` の中ではなくモジュール読み込みで起きていた**から。同章は activate の中身だけを説明していて、「そもそも activate に到達しない」経路が抜けていた。

書いた内容:

- `packages/vscode-extension/src/mcp-server.ts:52-58` のトップレベル `require` が、MCP の port 設定や開いているファイルに関係なく activation を落とす構造であること
- 原因の npm workspaces hoisting と、`install-engine-deps.sh` / `install-extension-deps.sh` が共有する `scripts/install-bundle-deps.sh` の「ワークスペース root の無い一時ディレクトリで入れる」手口
- 同梱先が `dist/node_modules` である 2 つの理由と、`vsce package --no-dependencies`（`.github/workflows/release.yml:118`）
- post-package ゲートが `check-vsix-bundled-deps.mjs` に替わり、**宣言を数えるのではなく出荷物の実ファイルから解決する**ようになったこと。保証が depth 1 と depth > 1 で一様でないことも script の明示どおりに書いた

あわせて drift 表に 1 行、Sources に 7 行、frontmatter の `verified-against` を `a2ac724` へ。

🔴 **未追従として PR 本文に書き出したもの（この PR では直していない）**: cold install 経路は gated E2E から構造的に踏めない（`tests/e2e/orbitstudio-mcp-gated.spec.ts:728` が `--extensionDevelopmentPath` で起動するため、同梱が空でも緑になる）。#874 の cold install 検証は手動で、資産として積まれていない。

### 束 E 時点の移設（本体の 2,000 行上限・2026-09-12）

### refactor: fold the /simplify findings for #883 bundle C (Sep 11, 2026)

**Date**: 2026-09-11
**Status**: ✅ 完了（PR #884）

`/simplify` の 4 観点（reuse / simplification / efficiency / altitude）を並行起動。
**独立した 3 観点が同じ 2 機構に収束**したので、指摘単位ではなく**機構単位**で直した
（CLAUDE.md「指摘単位のローカルパッチは禁止・振動の主因」）。

| 機構 | 収束した観点 | 修正 |
|---|---|---|
| **A** 述語の所在 | reuse / efficiency / altitude の 3 つ | `lineNeedsBus` を `audio-line.ts` の **export 純関数**へ + `AudioLine.needsBus()`（`elements` を直読・コピーしない） |
| **B** 補完の重複 | reuse / efficiency / altitude の 3 つ | `scanVarDeclarations()` へ一本化 + 正規表現をモジュール定数へ |
| **C** 分岐の畳み込み | simplification のみ | `output(dest ?? {kind:'master'})` / `resolveDest` が `undefined` を吸収 |

#### A の根拠（3 観点が別々の理由で同じ結論に達した）

- **reuse**: 設計 §2.3 が「`audio-line.ts` に純関数として置く」と**コード例まで示していた**
- **efficiency**: `snapshot()` は `return [...this.elements]` で**配列を丸ごとコピー**する。
  述語は走査するだけなのでコピーは使い捨て。`elements` は private なので、
  **`audio-line.ts` に置くことが非コピーの唯一の経路**
- **altitude**: 束 S の instrument 経路（設計 §2.2.1）が**同じ述語**を使う。`Sequence` の
  private ローカル式のままだと、束 S は private へ手を伸ばすか書き写すかになり**ドリフトする**

#### B の根拠

`var NAME = <ident>.<member>` を拾うループが 2 箇所に写されており、`\b` の有無や
`output\s*\(` の扱いが将来ずれて**片方だけ直る**形だった。加えて 1 回の補完で同じ文書を
**4 回走査**していた（`matchAll`×2 + `split`×2）。`(` がトリガー文字に足されて発火頻度も上がる経路。

#### 採らなかった指摘

補完の `output-string` / `output-node` を 1 つの kind に畳む案は**却下**。
正規表現・語彙状態（`string` vs `code`）・候補の中身（バス"名" vs 変数"識別子"）・
`CompletionItemKind`（`Value` vs `Variable`）がすべて異なり、畳むと `mode` 判別フィールドが
要るだけで**複雑さは減らず名前が変わるだけ**（simplification agent が実読して同じ結論）。

#### 検証

```
Test Files  160 passed | 4 skipped (164)      Tests  2352 passed | 68 skipped (2420)
```

lint 緑 / 🔴 `git diff main...HEAD --exit-code -- tests/e2e/output-line-expectations.ts` **無出力**
（束 C の検算が simplify 後も保たれている）。

---

### feat(dsl): make output() default to master and migrate every score (#883 bundle C) (Sep 11, 2026)

**Date**: 2026-09-11
**Status**: 実装完了・main 検証中（実機 gated 未実施）
**担当**: 実装 = Codex（`gpt-5.6-sol` / effort high・2 ラウンド）/ 検証 = main

**束 C は「振る舞いを変えない」束。** 暗黙 master の廃止は束 S。

#### 中身

| 対象 | 変更 |
|---|---|
| `sequence.ts` / `mixer-manager.ts` | `output()` の宛先を省略可に（既定 `{kind:'master'}`）。**暗黙ではなく既定引数**なので要素は譜面に現れる |
| 同 | 🔴 **実現の省略**（設計 §2.3）: ラインが「素の master 出口」だけの間は**バスを確保しない**。`.output()` 必須化がプール 8 本を食い潰すのを防ぐ（出荷 example の 4 本が 8 を超える） |
| 拡張の補完 | `.output(` の引数位置で `master` / 宣言済み sum・aux / 物理アウトノードを候補に |
| fixture 11 本 + 新規 2 本 | §7.1 の表どおり `.output()` を明示。**バス自身の出口も** |
| examples 12 本 / `docs/user` / `sites/user` | 同上 |

#### 🔴 main の審査で 1 件差し戻した — 完了条件 D3（E2E X2）の欠落

Codex の 1 回目は inline 譜面の移行までで、**X2 を作っていなかった**。

進捗ログが `kick.master` のアサーション変更を「**stale な structural assertion**」と説明していたが、
実際には**振る舞いの変更**だった — 裸形 `.master` は今まで `seq-bus-0` を確保していたのに、
実現の省略で確保しなくなった（テストが実装に合わせて書き換えられた形）。

変更自体は設計どおりだが、**検証が無かった**:

- 設計 §2.3 はこれを**確度「中」**とし、反証条件を「X2 で RMS が `noBus` golden から ±0.12 を超えて動く」としている
- 既存 fixture は `output("master")` も裸形 `.master` も **1 つも使っていない** → 「既存 golden が動かない」が**この変更を素通りする**
- ラチェット（`dsl-e2e-coverage`）も効かない（`output` は既に covered なので新語彙として検出されない）

→ 譜面 2 本（`output_default_master_omitted.orbs` / `_explicit.orbs`）と X2 を追加させた。

#### 実現の省略が安全である構造的理由（main の確認）

省略が効くのは「ライン全体が素の master 出口」の場合のみ。そのとき:

| ケース | 変更前 | 変更後 |
|---|---|---|
| 出口なし → `dry.output()` | 暗黙 master → **直接経路** | 省略 → **直接経路** |
| `kick.gain(-6).output(drms)` | バス経路 | **バス経路**（述語が true） |

**経路が変わるケースが実質無い。** 唯一変わる明示 `output("master")` は使用譜面 0 本（grep 実測）。

#### 検証（main・sandbox 外）

🔴 **Codex は緑を装わなかった** —「`npm test` did not exit successfully, I am not claiming all three
acceptance checks passed」と報告。sandbox 内の失敗 4 ファイルはすべて loopback を立てるもので
`listen EPERM`。**sandbox 外で回し直したら消えた**:

```
Test Files  160 passed | 4 skipped (164)
     Tests  2352 passed | 68 skipped (2420)
  Duration  23.54s        （sandbox 内は 400s — MACOS_DEV_SETUP の「遅さの 91% はスキャン」と同型）
```

`npm run lint` 緑 / `npm run docs:check` 948 引用・0 failed /
`git diff --exit-code -- tests/e2e/output-line-expectations.ts` 無出力（**束 C の検算**）。

#### 残件（レビューへ送る）

- `dsl-completion-context.ts` の新規 2 関数が `lexicalStateAt(line, ...)` を**行単位**で呼んでおり、
  同じ関数内の既存パスは `lexicalStateAt(sourceText, ...)` を**全文**で呼んでいる。
  複数行コメント内の `var x = mix.sum` を候補に拾いうる（補完候補のみなので実害は軽微）
- 実現の省略の述語が `sequence.ts` に inline。設計 §2.3 は `audio-line.ts` の純関数を指定しており、
  束 S で同じ述語が要る（main のブリーフが `audio-line.ts` を範囲外にしたため。Codex の落ち度ではない）

#### 🔴 実機 gated が退行を 1 件捕まえた（`ph654`）— 束 C が**露見させた**既存の潜在欠陥

1 回目の gated: **1 failed / 38 passed**。

```
ERROR: Sequence 'ph654': MIDI degrees need a root. Declare global.key("C") (or set seq.root()).
```

ユニット 2352 件・lint・docs:check が全部緑で、**golden も 1 つも動いていない**状態で、実機だけが落ちた。

**原因**: `ph654` の譜面は `play(1, 0, 3, 0)` で**度数**を使うのに `global.key("C")` を持っていない。
他の instrument 譜面は **10 本すべてが持っている**（`:2078 :2117 :2160 :2216 :2272 :2316 :2367 :2865 :2967 :3336`）。
gated suite は **1 つの VS Code / エンジンを共有**するので、`ph654` は**先行譜面が設定した key を
継承して偶然通っていた**。束 C が先行譜面に `.output()` を足したことでその漏れが起きなくなり露見した。

🔴 **これは #883 の grand truth そのもの** — 譜面が他ファイルの残留状態に依存していた。
修正は「譜面に自分の前提を書かせる」（`global.key("C")` を追加）であって、テストを通すための
書き換えではない。**なぜ今まで通っていたか**をコメントに残した。

#### 実機 gated（2 回目・main が sandbox 外で）

```
Test Files  1 passed (1)
     Tests  39 passed | 1 skipped (40)
  Duration  685.13s
```

skip 1 件は E2E-4/E2E-5（>=4ch デバイス不在・既知）。

🔴 **X2 が実測で通った** — 設計が確度「中」としていた「実現の省略は bit 同一クラス」が裏づけられた:

```
[#883 X2] default-master RMS: {"omittedRms":0.08701663329273443,
                               "explicitRms":0.08701663329503133}
```

| 判定 | 実測 | 閾値 |
|---|---|---|
| `output()` ≡ `output("master")` | 相対差 **2.6e-11**（11 桁一致） | ≤ 0.02 |
| `output()` ≈ `noBus` golden（0.0846173） | 約 **2.8%** | ≤ 12% |

#### 関連

#883 / 設計 §2.3 §4 §5.3 §7.1 §7.2 / 完了条件 D3・D9・D10

---

### fix: close the review round-1 findings for #883 bundle C (Sep 11, 2026)

**Date**: 2026-09-11
**Status**: ✅ ラウンド 1 収束（PR #884）
**担当**: レビュー = `/simplify` 4 観点 + `/code:pr-review-team` 4 名 + **Fable 監査を並行** /
fix = Codex（コード）+ main（docs・spec）/ 裁定と検証 = main

#### 🔴 main が偽陽性 2 件を裁定した — どちらも**層をまたいだ誤判定**

| レビュアー | 主張 | 裁定の根拠 |
|---|---|---|
| pr-test-analyzer | 「instrument は `ensureInsertBusForInstrument()` が `instrument()` 宣言時に先にバスを確保するので影響なし」 | ❌ 呼び出し元は **`gain()`（`sequence.ts:372→396`）と `pan()`（`:425→449`）のみ**。`instrument()` からは **0 件** |
| silent-failure-hunter | **Critical**「再宣言で daemon の古いルーティングが黙って生き残る」 | ❌ Rust 側（`engine_wrap.rs:7656` `new_dest.store(old_dest.load())`）は**正しい**が、TS 側は `process-initialization.ts:91`「**Reuse existing sequence for REPL persistence**」で `_insertBus` を**保持**する |

`mem:reviewers-judge-one-layer-only` の再現。TS・インタプリタ・Rust をまたぐ契約は main が両端を読むしかない。

#### 実害 1 件（Fable だけが見つけた・main が再現確認）

**`kick.output(db: -6)` がオプションを宛先として食っていた。**

```
processArguments('output', [named_arg db:-6])  →  [{"db":-6}]   ← 引数 1 個・オブジェクト
  → Sequence.output({db:-6}) → typeof dest === 'object' → OutputDest として扱う
  → db は消える / バスを 1 本消費 / 宛先の無い wire op を daemon に送る
```

🔴 **束 0 で `destination` を省略可にした spec 改訂（main の作業）が、この形を正当にした帰結。**
Sonnet チーム 4 名は誰も見ていない — **差分に「無い」もの**（誰も書かなかった形）だったため。

#### 横断ポリシーを 1 つ置いてから全箇所へ適用（指摘単位のパッチにしない）

> `output()` / `send()` の引数は「宛先（省略可）」と「オプション」の 2 種類しかない。
> `OutputDest` は必ず `kind` を持ち、オプションバッグは持たない。**`undefined` だけが省略**であり、
> `null` は不正入力として loud に拒否する。

`isOutputDest()` を `audio-line.ts` に置き、**パーサ層（`evaluate-method.ts`）と呼び出し層
（`sequence.ts` / `mixer-manager.ts`）が同じ判別子を使う**。2 層で防ぐが**判別のルールは 1 つ**。

#### 直した内容

| # | 出どころ | 内容 |
|---|---|---|
| F-A | Fable | `output(db:)` / `send(db:)` の宛先スロットにオプションが入る |
| F-null | silent-failure-hunter | `output(null)` が黙って master に（**main が `/simplify` で入れた退行**） |
| F-B | code-reviewer | instrument `.output()` 単独が未検証 |
| F-C | pr-test-analyzer | `needsBus()` の thru / db≠0 分岐が未検証 |
| F-D | pr-test-analyzer + Fable | `mix.output(` で補完が誤爆 |
| F-E | comment-analyzer | **未実装の診断を現在形で断定**（main の spec 誤り） |
| F-G | Fable | 🔴 **MX.1 注記が実装と逆**（「`output()` が bus を確保した瞬間」）ほか設計 §10 の 5 行が未着地 |

🔴 **main 自身の誤りが 3 件**（F-null・F-E・F-G）。うち 2 件はこの PR で main が書いたもの。

#### Codex の変異検証（**実出力を貼らせた**・5 件すべて red → revert で green）

`needsBus()` の単純化 / instrument で無条件確保 / `unshift`→`push` / ノード除外の削除 /
`null` を通す — **すべて red**。pr-test-analyzer が予告した「述語を単純化する変異が全件緑で通る」穴が塞がった。

#### 引用チェックで踏んだこと

`--fix` が 8 件を直せなかった — **行ずれではなく引用元のコードが変わった**ため。実コードから
再抽出したところ、今度は**引用がコメントの途中から始まった**。
🔴 **緑は「行が合った」証明でしかない**（`mem:citation-fix-can-land-on-the-wrong-function`）ので、
範囲を `/**` の境界へ合わせ直した。

#### 検証（すべて main が sandbox 外で実測）

```
npm test    160 files / 2360 passed | 68 skipped (2428) / 0 failed   ← +8 は追加テスト
lint        緑
docs:check  948 引用 / 0 failed
実機 gated  39 passed | 1 skipped (40) / 0 failed
```

🔴 **X2 の再実測**（実現の省略が bit 同一クラスであることの裏づけ）:

```
[#883 X2] omittedRms=0.08701663328809114  explicitRms=0.08701663328672658
```

`tests/e2e/output-line-expectations.ts` の式は**1 つも変わっていない**（束 C の検算）。

---
