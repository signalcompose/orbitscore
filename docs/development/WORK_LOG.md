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
- [2026-09（前半・09-01〜09-05）](../archive/WORK_LOG_2026-09.md)
