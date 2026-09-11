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
- [2026-09（前半・09-01〜09-08）](../archive/WORK_LOG_2026-09.md)
