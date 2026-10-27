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

### docs: follow the DSL implementation grant into the planning documents (Oct 27, 2026)

**Date**: 2026-10-27 / **ブランチ**: `claude/docs-sync-pr1003` / **追従元**: PR [#1003](https://github.com/signalcompose/orbitscore/pull/1003)（merge `13bdc2e`・`Closes #998`）

docs 追従ルーチン。#1003 は「仕様書の本文は Apache-2.0 にしない / 言語の実装だけを Apache-2.0 の条件で許す / 機械が読む言語の定義 2 つは Apache-2.0」という形で #998 を閉じたが、**計画層の 3 文書が改訂前の「DSL の仕様書だけ Apache-2.0」のまま**だった。

- `docs/planning/NATIVE_DEVELOPMENT_MAP.md`（決着済みの行）と `docs/planning/IMPLEMENTATION_PLAN_NATIVE.md`（裁定 (9)）を #1003 の結果に合わせた。`protocol/` の決定（定義だけ Apache-2.0）はこれに影響されないことを明記（README の License 節が明記している）
- `docs/planning/NATIVE_MIGRATION_2026-09.md` の「ライセンス構成」に、機械が読む言語の定義 2 つの Apache-2.0 の例外と実装の許諾を足した。同節の `CONTRIBUTING.md:176` は、#1003 が同じ節に 2 行足したので `:178` にした
- `docs/research/WCTM_COMPOSITION_SKILL_RESEARCH.md` の `INSTRUCTION_ORBITSCORE_DSL.md:14` を `:20` に（許諾の節で 6 行ずれた。着地先は同じ `**Implementation Status**` の行）
- 🔴 仕様（DSL の構文・意味）は変わっていないので `docs/specs-v2/` と `docs/core/` の本文・`sites/user/`・`docs/user/` は触っていない。`sites/dev/` の引用は #1003 が `--fix` で直し済み（`docs:check` 緑で確認）

---

### docs(dev-site): follow up #1007 with the Origin rejection and the daemon-side parent watch (Oct 26, 2026)

**Date**: 2026-10-26 / **ブランチ**: `claude/docs-sync-pr1007` / **追従元**: PR [#1007](https://github.com/signalcompose/orbitscore/pull/1007)（マージコミット `42ec6a2`） / **Issue**: [#996](https://github.com/signalcompose/orbitscore/issues/996)

PR #1007 の追従。元 PR は `docs/research/ENGINE_DAEMON_PROTOCOL.md`（§2.1.2 / §2.2）・`docs/design/606-*.md`・WORK_LOG を直し、dev 学習サイトは**引用の再アンカーと spawn / `run()` の 2 箇所**だけを更新していた。残っていた 2 つの表面を dev サイトへ足す（実装・テストは触らない）。

- `sites/dev/rust-engine/index.md`（+ `en/`）の「boot 〜 teardown ライフサイクル」に **`Origin` ヘッダのある接続の 403 拒否**の節を追加（`server.rs:92-110` の `reject_browser_origin` と `:79-87` の `handle_connection` 側の畳み込みを引用）。元 PR は `server.rs` の引用を `serve` の行ずれ更新だけで通しており、`handle_connection` に入った関門はサイトのどこにも書かれていなかった
- 同章に **親（engine）の死の検知**の節を追加（`parent_watch.rs:7-18` / `daemon-spawn.ts:21-28` / `main.rs:208-229`）。主 = stdin の EOF・補助 = 親 PID の 2 段構え、引数による opt-in と前後互換、`_exit(0)` なので **#448 の `Drop` ギャップは閉じていない**ことを明記。元 PR が足したのは `run()` の段 -0.5 の 3 行コメントだけだった
- `sites/dev/rust-engine/oop-children.md`（+ `en/`）の `ParentWatch` 節に、daemon 側へ同名の兄弟が入ったことと **`orbit_audio_sandbox::ParentWatch` を共有しない 2 つの理由**（構築時の `getppid()` しか持たない・`outproc-*` feature の optional 依存）の相互参照を追加（`parent_watch.rs:9-12` を引用）
- `index.md` の Sources を `server.rs:1-79` → `1-110` に直し、`parent_watch.rs` と #996 / PR #1007 を追加。`index.md` の frontmatter は `verified-against: 42ec6a2` / `verified-at: 2026-10-26`（読み直したのは accept 経路と起動段だけ、と Note に明記）。`oop-children.md` は相互参照 1 節だけなので frontmatter は据え置き
- 追従不要と判断: `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` と `docs/specs-v2/`（DSL の構文・意味論・`.orbslog` は不変）/ `sites/user/` `docs/user/` と `sites/dev/editor/`（MCP ツールの引数・返り値・エラー挙動は不変。daemon の argv と stdio は利用者が書く語ではない）/ `.github/workflows/rust-ci.yml`・`CLAUDE.md`・`tests/`（ゲート手順と env の追加で、文書化は元 PR が済ませている）

---

### docs: archive the September 2026 WORK_LOG entries (Oct 27, 2026)

**Date**: 2026-10-27 / **ブランチ**: `1033-worklog-archive-2026-09` / **Issue**: [#1033](https://github.com/signalcompose/orbitscore/issues/1033)

main の WORK_LOG が 1,999 行で、上限 2,000 行（PROJECT_RULES §1a・`tests/docs/worklog-size.spec.ts`）の手前にあった。#1003 に main を取り込んだ時点で 2,019 行になり、`worklog-size` が赤になるのを確認した。

- 09-14〜09-26 の 25 節（1,365 行）を `docs/archive/WORK_LOG_2026-09.md` へ移した（既存の移設の印の並びに「09-14〜09-26 分の移設」を足し、新しい順のまま置いた）。本体は 633 行で、10 月の節はすべて残る
- 本体末尾の索引と `docs/core/INDEX.md` のアーカイブの表の 2026-09 を「09-01〜09-26」にした
- 移した節をファイル名まで名指ししていた参照 4 か所（`CHANGELOG.md` の 4.2.0・`848-docs-structure-design.md` の 2026-09-14 の実測 3 か所）をアーカイブへ向けた

Closes #1033

---

### docs: follow PR #1031 (split RustSec advisory gate) into the work log (Oct 26, 2026)

**Date**: 2026-10-26 / **ブランチ**: `claude/docs-sync-pr1031` / **追従元**: PR [#1031](https://github.com/signalcompose/orbitscore/pull/1031)（merge commit `2aa309d`・head `21d7b2f1`）

PR #1031（`cargo deny check advisories` を `rust-ci.yml` から分け、依存を変える PR と毎日の main で回す）の追従。
差分は CI のワークフロー 2 本・`.husky/pre-push`・WORK_LOG で、**DSL / ランタイム / 拡張の表面を 1 つも変えていない**。
したがって直した先は WORK_LOG の 1 か所だけである。

- #1031 の記録の「🔴 未実施: …（= 検出が生きていること）」が、**PR 自身の CI で解消済みだったのに残っていた**
  （4 本のコミットのうち最初の `72b8ec5` で書かれ、以降のコミットで更新されなかった）。追記で補正した。
  通知の経路は、main がマージ後に `workflow_dispatch` で確かめた（下の追記・2026-10-27）
- 追従不要と判断したものは PR 本文に理由付きで列挙した。要約: `sites/dev/` に CI / git フックを扱う章が無い
  （`docs/development/WORK_LOG.md:844` が別の追従で同じことを実測済み）・`sites/user/` と `docs/user/` は
  出荷済みの拡張の使い方だけを書く・`sites/dev/glossary.md:128` の「GPL 依存を `cargo-deny` で gate」は
  bans / licenses / sources が全 PR で走り続けるので記述のまま正しい
- 🔴 `.husky/pre-push` の advisory 判定が `rust-advisories.yml` の `paths` と 1 か所ずれている点は
  PR 本文で報告した（実装は変えない）

Part of #1030

---

### ci(rust): run RustSec advisories only on dependency changes and daily on main (Oct 26, 2026)

> **2026-10-26 追記（追従ルーチン）**: 下の「🔴 未実施」は**検出については解消済み**だった。この PR の
> head `21d7b2f1` で `advisory gate (RustSec)` が RUSTSEC-2026-0386 を検出して赤になっており
> （[run 40399798494](https://github.com/signalcompose/orbitscore/actions/runs/40399798494/job/121842278404)）、
> 同じ push の `license / dependency gate` は緑だった（＝分けた効果もここで確認できている）。
> 失敗の通知の経路（通知の段は `schedule` / `workflow_dispatch` だけで走る・
> `.github/workflows/rust-advisories.yml:76`）は、**マージ後に main が確かめた**（2026-10-27）:
> #1031 のマージ（`2aa309d`）の後に `workflow_dispatch` で回すと赤になり、追跡 issue #1032
> （ラベル `rust-advisory`）が自動で開いた（run 40418744985）。#1002 のマージ（`6257a83`）の後に
> もう一度回すと緑（run 40418998109）。#1032 と #1030 はそれを書いて閉じた。
> なお本 PR は `advisory gate (RustSec)` が赤のままマージされた（main の `Cargo.lock` に #1002 が
> 入っていないための期待どおりの赤。main に required status checks は無いのでマージは止まらない）。

**Date**: 2026-10-26 / **ブランチ**: `1030-rust-advisories-schedule` / **Issue**: [#1030](https://github.com/signalcompose/orbitscore/issues/1030)

2026-10-26 から Rust CI の `license / dependency gate` が、Rust に触れていない PR まで含めて全 PR で落ちていた（run #947〜#966 の 20 件すべて・docs だけの PR を含む）。原因は RUSTSEC-2026-0386（tokio 1.52.1）で、更新は #1002（#999）が持つ。この PR はその更新ではなく、**勧告の公開で無関係な PR が赤くなる構造**を直す。

- bans / licenses / sources は `Cargo.lock` と `deny.toml` だけで結果が決まるが、advisories は実行した日の RustSec DB でも決まる。全 PR で advisories を回すと、勧告 1 件で全 PR の赤がその PR の責任でなくなる（#801 と同じクラス）
- `rust-ci.yml` の `license / dependency gate` は `cargo deny check bans licenses sources` に（job 名は据え置き・GPL 隔離のゲートはそのまま全 PR で止める）
- 新しい `rust-advisories.yml`: `cargo deny check advisories` を、依存を変える PR（`rust/Cargo.lock` / `rust/Cargo.toml` / `rust/**/Cargo.toml` / `rust/deny.toml`）・このワークフロー自身を変える PR・毎日の main（21:23 UTC = 06:23 JST）・workflow_dispatch で回す。毎日の失敗は `rust-advisory` ラベルの追跡 issue に通知する
- 通知経路は workflow_dispatch でも試せるようにし、`deny` の失敗は勧告の検出だけに断定せず DB / crates.io の取得失敗も含む文面にして、通知本文に実行元の ref と SHA を載せる
- pre-push は新規ブランチを origin/main との 3 点差分で判定し、push refs は一時ファイルを使わず変数から各判定へ渡す
- 根拠: cargo-deny-action の README が "Recommended pipeline if using advisories, to avoid sudden breakages" として advisories を分けている（あちらは continue-on-error。ここは無関係な PR で回さない形）
- 確認: 2 つのワークフローを YAML として読み、トリガと実行コマンドを確かめた。`cargo deny check bans licenses sources` は手元で通過。🔴 未実施: マージ後の workflow_dispatch で、#1002 より前の main では RUSTSEC-2026-0386 で赤になること（= 検出が生きていること）
- 束の統合ブランチから切った小 PR は、統合ブランチに main が入るまで旧ワークフローで走る（pull_request は merge ref のワークフローを使う）

Part of #1030

#1030 はマージ後に `workflow_dispatch` で新しいワークフローを回し、勧告のある main で赤・#1002 の後で緑になることを確かめてから閉じる。

---

### fix(daemon): exit when the parent engine dies (Oct 26, 2026)

**Date**: 2026-10-26 / **ブランチ**: `claude/bold-hamilton-90v8nu-996`（#999 の上に積む） / **Issue**: [#996](https://github.com/signalcompose/orbitscore/issues/996)

設計 848 §4.7 の脅威モデルで見つかった、出荷済み 4.4.0 の daemon の穴の 2 つ目（設計 §4.4 F-1・台帳 P-05）。engine が SIGKILL で落ちると daemon が残っていた。

- **親の死の検知**（`orbit-audio-daemon/src/parent_watch.rs`）: 主 = stdin の EOF / 補助 = `getppid()` の付け替え（250ms 周期・child 側 `ParentWatch` と同じ判定）。🔴 **engine が引数（`--exit-on-stdin-eof` / `--parent-pid <pid>`）で明示した時だけ**働き、さらに stdin がパイプ（FIFO / socket）でなければ EOF を見ない — 古い engine（stdin = `/dev/null`・引数なし）と組んだ daemon が起動直後に終わらないため。監視は音声デバイスの初期化より前に張る。検知したら理由を stderr に書いて（best effort — engine が既に死んでいれば読み手はいない） `_exit(0)`（SIGTERM の既定の動作と同じ終わり方）
- **engine 側**: spawn の形を `daemon-spawn.ts` に切り出し、stdin を `'pipe'` にして閉じない + 上の 2 引数を渡す。`daemon-client.ts` は 782 → 779 コード行（ラチェットの baseline を下げた）
- tokio の `stdin()` は使わない（blocking pool 上の取り消せない `read` が runtime の終了を止める）。stdin は専用の OS スレッドで読む
- テスト: Rust 単体 7 件 / 実 daemon の結合 5 件（Linux では ALSA の既定 PCM を null に向けた HOME で起動するので CI の ubuntu でも走る）/ TS の spawn 配線 1 件（既存 2 件は argv の期待値を更新）/ engine の SIGKILL の実プロセステスト 1 件（`ORBIT_REAL_DAEMON=1` で gate）。daemon の 4 機構と engine の 3 配線を 1 つずつ外して red になることを確認した。途中で、**ready 前に終わった daemon を「起動できない環境」として skip していた**ため「パイプの確認を外す」変異が生き残ったので、skip の条件を「daemon が `"ready":false` を報告した時だけ」に絞った
- dev 学習サイトの引用のずれのうち行ずれだけのものを `check-citations.mjs --fix` で再アンカーし、中身が変わった 2 箇所 × 2 言語（spawn と `run()`）は抜粋と説明を手で更新。`docs/research/ENGINE_DAEMON_PROTOCOL.md` に §2.1.2（親の死の検知）を追記
- 🔴 未実施（帰国後に main が手元で）: macOS 実機のマージ前ゲート（ビルド + 実機 gated E2E 全件・cold install）、`#[cfg(target_os = "macos")]` のテスト、実 CoreAudio での「engine の SIGKILL → daemon が消える」
- その後の macOS 実機 gated で、`#606 E2E-K3` が「SIGKILL 後も daemon が生存する」という旧契約のため失敗。#996 の新契約に合わせ、kill 前の発音と 5 秒以内の daemon 自己終了を検証し、`_exit` で途中までになる WAV の末尾無音判定は外した
- `/simplify`（4 観点）の整理: ゾンビを除く生存判定を `tests/helpers/process-liveness.ts` に 1 本化（gated と実 daemon のテストから使う）/ `check_parent` の非 direct 分岐を既存の `probe_pid_liveness` に置き換え（ESRCH だけを消失とみなす意味は同じ）/ Rust の結合テストの待ちループを `gated_common::wait_until` に・stdin の enum を `Stdio` に・後始末を `Drop` のガードに。見送り: 起動引数の 1 回の解析・終了経路の集約・起動ハーネスの共通化（差分の範囲外）
- main が macOS で確認: daemon の lib 65・Origin 2・親の死 5（skip 0）/ 実 CoreAudio の parent-death 1 / `npm test` 2734 passed・87 skipped。dev サイトの引用 44 件は行ずれ（+1 / −10 / −12）だけを確認して `--fix`
- PR #1007 ラウンド 1: `ps` の exit 1 + 空出力だけを消失とし、その他の検査失敗を消失として隠さないよう TS / Rust の生存判定を統一した。
- 親 PID の境界ケースと socketpair EOF の結合テストを追加し、CI で実 daemon を必須化。child の stdin 継承と、意図した Origin 403 の二重 WARN も防いだ。
- E2E-K3 の題名を確かめていること（daemon が自分で終わる）に合わせ、守り手の範囲をコメントで正確にした（切断が引き金になることは `protocol.rs`・実 child への配送は `outproc_instrument_gated.rs`）。その gated テスト（`#[ignore]`・実測 12 秒）を **CLAUDE.md のマージ前ゲートに無条件で追加**した（レビューで「守り手が手動テストにしか無い」と分かったため）。`outproc_instrument.rs` が file-size ラチェット（705）を 1 行超えたので、stdio の設定を 1 文にまとめて戻した
- 見送り: 実プラグインで WebSocket だけを切る新しい gated テスト（設計の判断を含むので owner が決める）・`PARENT_PID_POLL_INTERVAL` への `PROVISIONAL(P-08)`（台帳は `rust/` を走査しない）・起動引数の 1 回の解析・終了経路の集約
- ラウンド 2（code-reviewer / silent-failure-hunter / pr-test-analyzer）で Critical・Important 0 に収束。Minor も直した: 結合テストの daemon ごとに ALSA の HOME を分ける（同時書き換えで `ORBIT_REQUIRE_REAL_DAEMON=1` の CI が揺れないように）/ その env を rust-ci.yml の job 全体へ / 生存判定の単体テスト 7 件（catch-all に戻すと 3 件 red を確認）/ CLAUDE.md のゲートに `ORBIT_REQUIRE_REAL_DAEMON=1` の parent_watch と実 engine の parent-death を追加 / 「理由を stderr に残す」は best effort と明記

Closes #996

---

### fix(daemon): reject WebSocket handshakes that carry an Origin header (Oct 26, 2026)

**Date**: 2026-10-26 / **ブランチ**: `claude/bold-hamilton-90v8nu-996`（#999 の上に積む） / **Issue**: [#996](https://github.com/signalcompose/orbitscore/issues/996)

設計 848 §4.7 の脅威モデルで見つかった、出荷済み 4.4.0 の daemon の穴の 1 つ目。

- daemon の accept を `accept_hdr_async` にし、`Origin` ヘッダのあるハンドシェイクを 403 で拒否する（値は見ない・`null` も拒否）。WebSocket のハンドシェイクには CORS の preflight が無く、daemon は `LoadPlugin { path }` を受け付けるので、ブラウザからの接続を通さない。ブラウザは必ず Origin を付け（RFC 6455 §4.1）、daemon の client（engine の `ws`）は付けない。repo 内の WebSocket client は engine と Rust テストの 2 つだけで、どちらも Origin を付けないことを確認した
- 戻り値の型は tungstenite の `Callback` が決めているので `clippy::result_large_err` を理由つきで allow
- テスト（`tests/handshake_origin.rs`）: 3 種の Origin（`https://…` / `null` / `http://127.0.0.1:…`）が 403 になり、拒否の後も accept loop が次の接続を受ける / Origin の無い接続は 101 で通り handshake フレームを受け取る。`accept_async` に戻す変異で red になることを確認
- `docs/research/ENGINE_DAEMON_PROTOCOL.md` §2.2 に規則を追記。dev 学習サイトの `server.rs` の引用を再アンカー

Part of #996

---

### fix(deps): bump tokio past RUSTSEC-2026-0386 so cargo-deny passes again (Oct 26, 2026)

**Date**: 2026-10-26 / **ブランチ**: `claude/bold-hamilton-90v8nu` / **Issue**: [#999](https://github.com/signalcompose/orbitscore/issues/999)

Rust CI の `license / dependency gate`（`cargo deny check`）が 2026-10-26 から落ちていた。原因は RUSTSEC-2026-0386（tokio の `AsyncFd::new` 系が I/O safety に反する・unsound）。`rust/Cargo.lock` の tokio 1.52.1 が該当していた。

- `cargo update -p tokio` で tokio を **1.52.1 → 1.54.1** へ（勧告の Solution は `>=1.51.6, <1.52.0 OR >=1.53.3`）。差分は `rust/Cargo.lock` の 2 行（version と checksum）だけで、tokio の依存の並びと `tokio-macros 2.7.0` は変わらない
- 勧告の対象 API（`AsyncFd`）は workspace の Rust コードで使っていない（`grep -rn AsyncFd` 0 件）。直接の実害ではなく、ゲートを戻すための更新
- 確認（Linux・cloud・cargo-deny 0.20.2）: 更新前の lock で `advisories FAILED`（RUSTSEC-2026-0386 を再現）→ 更新後 `advisories ok, bans ok, licenses ok, sources ok`。`cargo clippy --workspace --all-targets --locked -- -D warnings` / `cargo test --workspace --locked`（575 passed / 0 failed / 21 ignored）/ `cargo fmt --all --check` が緑
- 🔴 未実施: macOS 実機のマージ前ゲート（ビルド + 実機 gated E2E）。daemon は tokio の上で WebSocket と IPC を回すので、帰国後に main が手元で通す

Closes #999

---

### docs(index): list the OrbitStudio design and native plan in the docs index (Oct 26, 2026)

**Date**: 2026-10-26 / **ブランチ**: `claude/docs-sync-pr995` / **Issue**: [#848](https://github.com/signalcompose/orbitscore/issues/848)

PR [#995](https://github.com/signalcompose/orbitscore/pull/995)（マージ `4f6705e`）への追従。追従ルーチンによる docs のみの変更で、`packages/` `rust/` `tests/` は触っていない。

#995 は設計 2 本（`848-native-orbitstudio-design.md` / `848-docs-structure-design.md`）と計画 2 本（`IMPLEMENTATION_PLAN_NATIVE.md` / `NATIVE_DEVELOPMENT_MAP.md`）を新設したが、**`docs/core/INDEX.md`（すべてのドキュメントの目次）には 1 本も載っていなかった**（WORK_LOG 以外からの参照が 0 だった）。

- 設計ノートの表に 848 の 2 本を追加
- Planning の表に `NATIVE_DEVELOPMENT_MAP.md` と `IMPLEMENTATION_PLAN_NATIVE.md` を追加
- `DEVELOPMENT_MAP.md` の行に**主語が拡張版（凍結版）であること**を明記。#995 でマージされた地図が自ら「凍結線を越えた後の開発計画の正本」を名乗り「両者は同時に生きる」と書いているのに対し、INDEX は無条件に「開発計画の正本」と書いていて読者が衝突する
- `NATIVE_MIGRATION_2026-09.md` の行から、その裁定の上に立つ設計・計画・地図へのリンクを張った

検証: `npm run docs:build`（user / dev）と `npm run docs:check`（996 citations / 0 failed）が緑。仕様の判断・実装・テストは変更していない。

**追記（main・受け入れの確認）**: 別冊の行の「owner 裁定待ちは §10」は、別冊の冒頭の一文（`848-docs-structure-design.md:6`）が #995 で更新されずに残っていたのを写したもの。§10 自体は 2026-10-26 に全件裁定済みと書いている。INDEX の 2 行と別冊の冒頭を「裁定は §10 / §14.0・残る確認は Q-r2-1 / Q-r2-2」に直した（Q-r2-3 は #996 に `release-gate` が付いていることを `gh issue view 996` で確認）。

---

### docs(user-site): add the availability notation grammar and its lint (Oct 26, 2026)

**Date**: 2026-10-26 / **ブランチ**: `claude/practical-shannon-91kqon-d1` / **Issue**: [#848](https://github.com/signalcompose/orbitscore/issues/848)（計画 `IMPLEMENTATION_PLAN_NATIVE.md` §7.1 の D-①・docs の連続 PR ①）

user サイトを拡張版と OrbitStudio の両方に向けた 1 本の文書として保つための、可用性表記の文法と lint を入れた（別冊 `848-docs-structure-design.md` §3.4・§5・裁定 (16) A）。章への書き込みは次の PR（D-②）。

- **文法**: `sites/user/STYLE_GUIDE.md` に「可用性表記」の節 — frontmatter `host:`（`both` / `app` / `ext` / `both+split`・必須）・分割節の印 `<!-- host: ext|app -->`（見出しの次の行）・段落の併記（`- **OrbitScore**:` / `- **OrbitStudio**:`）・可用性の行（`> **対応**:` / `> **Availability**:` の固定 5 形）。配布線の名前は owner の指定（拡張版 = **OrbitScore** / DSL = **OrbitScore DSL** / ネイティブ版 = **OrbitStudio**・ja / en 共通）。最初は `拡張版` / `Extension` で書いたので、旧い名前の併記の行は `AV-TERM` で red にした
- **lint** `sites/user/scripts/check-availability.mjs` を `npm run docs:check` に連結（CI の `Check doc citations` で走る）。規則 `AV-HOST` / `AV-SYNTAX` / `AV-PLACE` / `AV-UNRELEASED`（`--release` で red）/ `AV-I18N` / **`AV-HOST-SCOPE`**（owner (20) の条件・台帳 P-13）/ `AV-TERM`
- **設計との差 2 点**（別冊を同じ PR で改訂）: AV-HOST-SCOPE を `both+split` の章にも掛けた / 分割節の印を見出しの**次の行**に置く（見出しの行に置くと VitePress が `aria-label` に印の文字列を入れることを `createMarkdownRenderer` で確かめた）
- **暫定**: 章にはまだ `host:` が無いので、lint の `HOST_MISSING_BASELINE`（42 章）で許し、D-② がこの一覧ごと消す。一覧は減らす方向にしか通らない（`host:` を持った章が残っていても、無い章が増えても red）
- **テスト** `tests/docs/check-availability.spec.ts`（124 件）: 一時ディレクトリに章を作り `--root` で lint を走らせる。STYLE_GUIDE の 5 形 × 2 言語がそのまま通ることも検査する（文書と lint の二重管理を作らない）。lint 側を壊した変異でも各検査が red になることを確認
- **レビュー反映**: 対象 0 件、可用性アンカーの near miss、未閉鎖 code fence、見出し内の分割印を loud に失敗させ、10 形すべての否定例と `--release` の 4 件を固定した
- `host:` の YAML コメント・引用符、厳密な引数解析、直下だけの除外、symlink directory の拒否、`HOST_MISSING_BASELINE` の免除件数表示を追加した
- 判定のテストは `FAIL <file>:<line>  [<rule>]` を 1 文字列として比較し、`a.md:1` が `a.md:12` に誤一致しない形にした
- **レビュー第 2 ラウンド**: near miss を行頭だけに絞って本文中の「対応」/ `Availability` の誤検出を解消し、frontmatter 内の分割印と、通常・壊れた symlink を `AV-HOST` で拒否するようにした
- **レビュー第 3 ラウンド（main が直接修正）**: 第 2 ラウンドで near miss を「行頭の 1 つの `>`」に絞りすぎ、R1 では赤だった `- **対応**:`・`1. **対応**:`・`>> **対応**:`・文中の `**対応**:`・小文字の `availability` などが黙って通っていた（同じ箇所が Codex で 2 回落ちたので main が直した。原因は main の R2 の依頼文「行頭の形だけ」）。候補を (a) 容器（字下げ・`>` の繰り返し・リスト記号）を剥がした行頭のラベル + コロン (b) 引用の中の強調したラベル + 空白（コロンの欠落）(c) 行のどこでも太字のラベル + コロン、の 3 つにし、`対応表`・`**対応**していない`・`Availability of plugins` は候補にしない
- `未リリース（` / `Unreleased (` はコードの外の全行（frontmatter・本文の文章）で探す（文書から grep を外したので lint が唯一の砦）。分割の印の候補は大小・コロンの有無を問わない（`<!-- Host: ext -->` などが黙って通っていた）。`--root` が読めない時だけ exit 2、章やディレクトリが読めない時は lint の誤り（exit 1・他の章も検査を続ける）。BOM・CRLF・可用性の行の末尾の空白は原因を名指しする
- テストは 82 → 124 件。各形のすべての枠を 1 つずつ崩す（版を 2 桁に・語を 1 つ消す）変種を生成して全部が AV-SYNTAX になることを確かめる。主要な 6 つの修正を 1 つずつ戻して、それぞれ対応するテストが赤になることを確かめた。#1006 の章（`git archive` で取り出したもの）にも当てて 0 エラー
- **レビュー第 4 ラウンド（main）**: 第 3 ラウンドの確認で、読めないサブディレクトリ（検索できないもの）で `lstatSync` が落ちて他の章の所見が消えること、インラインのコード・表のセル・HTML コメントの中の `**対応**:` と `> **対応** は次の通りです。` を書き損じと誤ることが分かった。`lstat` を try に入れ、候補の判定の前にインラインのコードと HTML コメントを外し、表の行は候補にしない。規則 (b) は「ラベルの後ろが OrbitScore / OrbitStudio / 未リリース / Unreleased か行末」に絞った。強調は `***` まで、分割の印の候補は `host` の後ろが空白・コロン・`=`・コメントの終わりの時だけ（`<!-- host-specific note -->` はふつうのコメント）
- 2 つの書き損じが重なる形（`>` もコロンも無い・ラベルの直後に空白が無い など）は、本文の誤検出と引き換えになるので広げず、lint の冒頭に既知の限界として書いた
- テストは 124 → 148 件（規則 (a)(b)(c) のどれが当たったかを区別できる入力・誤検出しない 4 形・見出し・分割の印の 4 形・CR の位置・単独の CR・タブと全角空白・読めない / 検索できないサブディレクトリ）。直した 6 か所を 1 つずつ戻して、それぞれ対応するテストが赤になることを確認
- `.husky/pre-push` の失敗文言に可用性表記の lint を足した

Part of #848

---

### docs(license): let anyone implement the DSL under Apache-2.0 while the spec documents keep their license (Oct 26, 2026)

**Date**: 2026-10-26 / **ブランチ**: `claude/practical-shannon-91kqon` / **Issue**: [#998](https://github.com/signalcompose/orbitscore/issues/998)

最初は「DSL の仕様書の本文を Apache-2.0 に」で作ったが（SPDX・`LICENSES/Apache-2.0.txt`・LICENSE の例外の節）、同日 owner が方針を変えた（#998 冒頭の「改訂」・「ドキュメントはコピーライトを保持していいのでは？DSL自体はApache2.0でいいと思うけど。」）。同じブランチで作り直した。

- **仕様書の本文はルートのライセンスのまま**（© Signal compose）。SPDX・`LICENSES/`・LICENSE と CONTRIBUTING の例外の記述は main の状態に戻した
- **実装の許諾**（案・未確定）: 仕様書 3 本（`INSTRUCTION_ORBITSCORE_DSL.md` / `PITCH_DSL_SPEC_v1.1.md` / `SIGNAL_CHAIN_DSL_SPEC_v1.md`）のタイトルの直下と README の License 節に、同じ文面の引用ブロック（英文 + 和文・英文が優先）。「文法と意味に沿った実装を、誰でも Apache License 2.0 の条件（第 3 条の特許の許諾を含む）で作り・使い・配布してよい。仕様書の本文の許諾ではない」。🔴 文面は法的な文書なので、確定は専門家か license@signalcompose.com の確認の後
- **機械が読む言語の定義**: owner の「一旦推奨で」（同日）で、推奨した 2 つ（`packages/vscode-extension/syntaxes/orbitscore-audio.tmLanguage.json`・`packages/vscode-extension/language-configuration.json`）を Apache-2.0 にした。TextMate 文法の JSON はコメントを持てない。`language-configuration.json` は VS Code が JSONC として読むが、2 つを同じ形に揃えるため REUSE の慣習の `<file>.license` に SPDX を置いた。sidecar を npm / vsce / GitHub が読むわけではなく、効力を持つのはルートの `LICENSE` の例外の節。README に一覧、`CONTRIBUTING.md` に貢献の扱い、`LICENSES/Apache-2.0.txt` に全文（sha256 `cfc7749b…`）。境界の 2 つ（`dsl-method-catalog.ts`・`dsl-surface.ts`）は対象外
- **検査** `tests/docs/dsl-implementation-grant.spec.ts`（25 件、うち `protocol/` 未作成の 1 件は skip。言語の定義の 11 件を含む: 文法ファイルの全件分類・`.license`・REUSE の包括指定・LICENSE と README の一覧・全文の sha256）: `docs/core/` と `docs/specs-v2/` の全文書の分類（未分類が増えたら red）/ 仕様書のタイトルの直下に節がある / 4 か所の文面が一致 / 仕様書の本文（節の外）に Apache の表記が無い / ほかの文書に節や Apache の SPDX が無い / README の一覧 / ルートの LICENSE が仕様書を切り出していない / `protocol/` が現れたら LICENSE が触れていること。節を消す・1 か所だけ文面を変える・SPDX を戻す・未分類の仕様書を足す・対象外に節を写す・README の一覧から消す、の 6 通りで red を確認
- **レビュー round 2**: 許諾本文と LICENSE の例外節を sha256 で固定し、ライセンス制御ファイル・SPDX/frontmatter・仕様書拡張子・extension manifest の言語定義参照を漏れなく分類する検査へ強化
- **参照の再照合**: 3 本の仕様書本文を一次ソースに、行追加でずれた参照と、以前から別箇所を指していた参照（SC.5 / SC.10 / Versioning / `outs:` / diagnostics 設計）を修正
- 節を足して行がずれた分、dev サイトの機械検証の引用 4 本を `check-citations.mjs --fix` で +6 し（着地先は同じ行）、ずれる前に正しかった散文の参照 `SIGNAL_CHAIN_DSL_SPEC_v1.md:36-47`（SC.1）の ja / en を `42-53` にした
- **レビュー round 3（main が直接修正）**: 許諾の固定と LICENSE の切り出しは Codex に 2 回出しても塞がりきらなかったので main が直した。節の 1 行目を形で固定（golden は 2 行目以降なので、1 行目の後ろへの追記が 4 か所揃えて通っていた）・ルートの LICENSE 全体を sha256 で固定（「仕様書は CC0」の節や「自由に複製してよい」の 1 文は、語やパスの検査では捕まらない）・ライセンスのファイルは名前の前方一致（`LICENSE-APACHE` / `COPYRIGHT` / `PATENTS` / 単数の `license/`）と、名前だけが当たる 2 つ（`.claude/license.local.md` / `notice.rs`）の理由つきの表・docs / sites の SPDX 表記はライセンスを問わず不可・README 全体と CONTRIBUTING とサイトの設定の Apache の言及を固定・DEVELOPMENT_MAP の取りこぼし 2 か所と 610 の節名（PH.4 → PH.1）
- 🔴 `protocol/`（S-rpc の #1008 が置く）が入った時は、ルートの LICENSE が `protocol/` に触れる必要がある（検査がそう求める）。その 1 行は owner の文面なので、#1003 と #1008 の後に入る方の PR で足し、LICENSE の golden も同じ PR で更新する

Closes #998

---

### docs(design): apply the owner's second-round rulings to the OrbitStudio design (Oct 26, 2026)

**Date**: 2026-10-26 / **ブランチ**: `848-native-design-review` / **Issue**: [#848](https://github.com/signalcompose/orbitscore/issues/848)

第 1 回で owner が説明を求めた 7 件を裁定シート第 2 回で問い直し、全件が決まった（すべて推奨どおり）。設計・計画・地図・別冊をその裁定に合わせて改訂した。起案は fresh Opus subagent（xhigh）、審査は main。

- **パリティの再定義**: 関門は「DSL が実行された結果は拡張版と同じ」（D-2）と能力。MCP ツールの名前・引数・戻りは v1（第 1 リリースまで）だけ関門で、`mcp-tools-v1.spec.ts` が版で自動的に切り替わる。評価の区切り方・画面・ログの文言は作り直してよい。拡張版の通信方式から来た制約（`document_path` の改行禁止）は引き継がない。拡張版の位置づけは「仕様書」から「回帰の検算台」へ
- **段階移行と「最後まで移行する」仕組み**: owner の条件「動いて安心して終わってしまうことがあるので」に応えて、**暫定物の台帳**（設計 §1.4・P-01〜P-18）を新設。各行に強制の仕組み（`PROVISIONAL(P-xx)` の印 + `tests/repo/native-provisional-ledger.spec.ts` + リリースの preflight = D-11）を置いた。評価の受付口は段階 1（足場 + 差分テスト）→ 段階 2（#997 の評価のかたち・新しい束 S-eval）
- **LLM の接続**: セキュリティの再検討（fresh Opus・一次ソース）を受けて、LLM の経路を **stdio の中継 = MCP サーバ → UDS（0700 / 0600）→ 層 2 の RPC** にした。TCP の `/mcp` は v1 で開かない。TCP の `/rpc`（WebView 専用）は Host + Origin（欠落も拒否）+ トークン。根拠は Claude Code の再接続の上限（HTTP 途中切断 5 回・初回 3 回・stdio 終了は手動）で、**トークンを外しても HTTP の登録では締め出しが残る**。中継の規則 RL-1〜8・締め出しの表 E1〜E13・D-12 を追加
- **評価の要求**に省略可能な `target`（文書の uri・版・範囲）を追加。評価のかたちは #997 で設計する
- **タイミング**: §4.6 を書き直し、測れる基準（capture のオンセット）と早い段階の測定（N0-d / T-1）、Rust の `ScheduleEvents` へ移す判断の規則を置いた
- (7) 拡張版は書き直さない / (9) `protocol/` は Apache-2.0（DSL の仕様書の Apache-2.0 は #998）
- **計画 §7**: クラウド（Linux）で続けて進める作業列 C-0〜C-12・D-①②と、帰国後に手元で行う L-1〜L-9
- main の審査で足したもの: Swift のシェル自身は層 2 に **UDS** で繋ぐ（TCP の `/rpc` は WebView 専用で、Origin の欠落を拒否する規則がシェルにかからない・設計 §5.2）/ 計画 N-3 に `--mcp` の削除を記録。advisor に通信の形（中継・UDS）と `target` を確認し、妥当と判断した

Part of #848

---

### docs(design): record the owner's rulings on the OrbitStudio design (Oct 26, 2026)

**Date**: 2026-10-26 / **ブランチ**: `848-native-design-review` / **Issue**: [#848](https://github.com/signalcompose/orbitscore/issues/848)

設計 848 の owner 裁定待ち 27 件を、owner 向けの裁定シート（artifact・db に選択と意見を保存）で問い、返ってきた裁定を設計・計画・地図・別冊に記録した。設計の中身は起案し直していない（裁定の記録と、その直接の帰結だけ）。

- **裁定済み 20 件**: 設計 §14.0 に owner の意見を原文で記録。🔴 **(5) 自動更新は推奨 A と異なり B（第 1 リリースに含める・既定で有効・opt-out）** → 設計 §9.3・計画 N4・地図を改訂。(6) は A に owner の条件（クラウドの作業は手元で引き継いでゲート・tag 時の GitHub は頻度とコストで決める）。(8) は「1 クライアントが複数の document を持つ」を §5.4 に明記。(20) は条件つき（拡張版の読者が OrbitStudio の記述を自分の手順として読まないこと）で、別冊 §3.4 の見直しが残る
- **4.4.0 の Origin 未検証**は owner が A（issue を 1 本）を選び **#996** に起票（daemon の Origin 拒否 + 親の死を知る機構・engine 線。拡張の `/mcp` は記録だけ）
- **説明待ち 7 件**（裁定はこれから）: §4.7 の反転（owner の懸念「ライブ中にトークンが切れて使えなくなると困る」）/ §4.5.1 の写し / (22) 評価の単位（owner は行・ブロック・意味の単位と `@import` をまたぐ評価を求めた）/ (23) / (3) / (7) / (9)
- **全体への意見**（「VSIX 版にあまり引っ張られることなく…過去の資産が後々邪魔をすることがないようにしてほしい」）は、設計の背骨（拡張版とのパリティを完了条件に置く）との関係を owner に確認中

Part of #848

---

### docs(design): revise the OrbitStudio design against 4.4.0 and fix the session protocol shape (Oct 23, 2026)

**Date**: 2026-10-23 / **ブランチ**: `848-native-design-review` / **Issue**: [#848](https://github.com/signalcompose/orbitscore/issues/848)

OrbitStudio（ネイティブ版）の設計 848 を、拡張 4.4.0（main `7410dcb0`）と外部参照の調査に合わせて改訂した。層 2（`packages/session`）の実装をクラウドのセッションに出すために、**プロトコルの形（一方通行の判断 N-1）をここで確定させる**のが目的。9/18 の改訂（`848-native-design-revised`・main に未マージ）は main から大きく遅れていたので、main から切り直したブランチに cherry-pick してから直した。

- **進め方**: main が審査（再測・所見 6 件）→ 外部参照の調査（Bitwig / SuperCollider / Sonic Pi / MCP 仕様 / MCP Inspector の CVE / Jupyter / VS Code server / Monaco × WKWebView × IME）→ advisor と方針を決定 → 起案は fresh subagent → main が本文と引用を読んで受け入れ
- **崩れていた前提**: 比較元 `1276ab1f` は 09-18 ではなく 09-14 の 4.2.0 マージ / 「4.2.0 で凍結・以後 bug fix のみ」（4.3.0・4.4.0 が owner の個別例外で出た）/ MCP ツールは 26 ではなく 28（`registerTool(` の字面の grep は 24 しか出さない）/ 「docs は `.vsix` に同梱されていない」（4.2.1 から偽）/ #757 は凍結版で閉じた
- **プロトコルの形**: `session.evaluate` は状態を持たない（`documentDirectory: string | null` を毎回必須・凍結版の三値は stdio の REPL の副産物）/ `evalId` はサーバが振る / `transport.step` に省略可能な `source` / `log.line` に `level`・`kind` / `docs.*` に `site` / `engine.start` に `hostBundleId`。**評価の単位（#987 Q2）は wire に焼かず §14 (22)**、実装の既定は凍結版と同じ意味論
- 🔴 **セキュリティの結論を反転**: 旧 §4.4・§11「`/mcp` が無認証だから `/rpc` にも付けない」を撤回し、`/rpc` と `/mcp` の両方にトークン + Origin 検証（Host 許可リストは残す）。現行 `/mcp` は MCP 仕様 2025-11-25 の MUST（Origin 検証）を満たしておらず、WebSocket は CORS の対象外なので Origin を見ない `/rpc` は任意の Web ページから届く。新設 §4.7（脅威モデル）・D-10・F-13
- **ライフサイクル**: F-1 に機構（stdin の EOF が主・`--parent-pid` が補助。daemon 側は engine 線への申し送り）/ F-12（層 2 だけが落ちた時の回復）を新設 / ハーネスがトークンを知る経路（`ORBITSCORE_SESSION_TOKEN_FILE` → `--token-file`）
- **完了条件**: D-1 の基準を v4.4.0（gated 56 `it`・`PARITY_BASELINE_TAG` の 1 か所から読む）/ D-6 を Monaco の既知 issue の再現手順に / D-9 は 4.2.1 の同梱の引き継ぎに
- **§14 に 4 件追加**: (22) 評価の単位 / (23) LLM へのトークンの渡し方 / (24) `.orbs` を 2 つ開いた時の共有 / (25) F-12 の自動再評価とプラグイン状態の喪失の伝え方
- 計画に束ごとの「実行環境」（Linux で完結 / macOS 実機が要る）の列を足した。地図の現在地を 4.4.0 に合わせた
- 出荷済み 4.4.0 の `/mcp` と daemon も Origin を検査していない（daemon は `accept_async` にヘッダ検査なし）。issue にするかは owner 判断待ち

Part of #848

---

### chore(release): bump the extension to 4.4.0 (Oct 23, 2026)

**Date**: 2026-10-23 / **ブランチ**: `992-release-4.4.0` / **Issue**: [#992](https://github.com/signalcompose/orbitscore/issues/992)

凍結版（拡張版 OrbitScore）を **4.4.0** として更新する。中身は PR #984〜#986（#964 / #966 / #684 / #974 / #777 / ログの行単位化・クラウドのセッションから手元で引き継ぎ）と PR #989（#982 VST3 の controller state・同じく引き継ぎ）。

- **版の決定**: #966 で MCP `evaluate_orbitscore` に任意の引数 `document_path` が増えた（後方互換の機能追加 = SemVer の minor）。4.3.0 と同じ考え方で 4.4.0（owner の「リリースまで進めて」に main が番号を添えて報告）
- 現在の版を名乗る箇所を 4.3.0 → 4.4.0: `packages/vscode-extension/package.json` / `CLAUDE.md` ×2 / `README.md` ×3 / `docs/core/INDEX.md` / core spec ×2 / dev サイト 3 章 × ja・en（ADR-002 の本文 17 行目を含む・前回と同じ範囲）。3 章の `:9` の追従履歴 Note に v4.4.0 の 1 文
- `CHANGELOG.md` に `[4.4.0]` 節と比較リンク
- 🔴 **追従ルーチンが今回の 4 本を「自己追従」として飛ばしていた**: 判定が head ブランチの接頭辞 `claude/` だけだったため、クラウドのセッションが作った PR（`claude/<ランダムな名前>`）も対象外になっていた（ルーチンの実行ログで確認）。owner の指示で、判定を `claude/docs-sync-` に狭めた（ルーチンの 3 か所の指示文を更新）。飛ばされた分の追従はこの PR で行う:
  - ユーザーサイト `plugins/instrument.md`（ja / en）: VST3 の state ファイルが `.vstpreset` container（component + controller）になったこと、別のプラグインの state はエラーになること
  - ユーザーサイト `midi/pitch-dsl.md`（ja / en）: コード変数の定義の中でも名前に修飾子を付けられる（#974）
  - 仕様・core spec・dev サイトの引用は各 PR の中で直してある
- 検算: 素の `4.3.0` の残りは、過去の版の記録（CHANGELOG・WORK_LOG・設計 967・P.12.1 の「4.3.0 で実装」など）だけ

### fix(vst3): save the controller state alongside the component state (#982) (Oct 6, 2026)

**Date**: 2026-10-06 / **ブランチ**: `claude/beautiful-cori-xy9bfk`（セッション指定のブランチ。命名規則 `<issue>-*` から外れる）/ **Issue**: [#982](https://github.com/signalcompose/orbitscore/issues/982)（Epic [#980](https://github.com/signalcompose/orbitscore/issues/980) 束 2）

VST3 の state 保存が `IComponent::getState` だけで、controller 側の state を保存していなかった。

- **refactor（振る舞い不変）**: `.vstpreset` の解析を `orbit-vst3-host/src/host/setup.rs` から新しい crate
  `rust/crates/orbit-vst3-preset` へ移した。`orbit-vst3-host` は crate 全体が `#![cfg(target_os = "macos")]` で、
  CI（ubuntu）では空 lib になり解析のテストが 1 本も走っていなかった。移した先は依存ゼロの純関数 crate なので
  `cargo test --workspace` で走る。`orbit-vst3-host` 側は `parse_vstpreset` を `Vst3HostError::State` へ写す
  薄いラッパにした。エラー文言（`malformed .vstpreset: …`）は移動前と同じで、それを固定するテストを足した。
  解析のテスト 4 本は `lib.rs` の `mod tests` から新 crate へそのまま移した
- **docs（仕様を先に改訂・CLAUDE.md 運用規則 6）**: `docs/specs-v2/PLUGIN_CAPABILITY_ABSTRACTION_v1.md` の
  CAP.2 が VST3 の `CAP-STATE-GET` を `IComponent::getState` だけと定義していたので、`IEditController::getState`
  を加え、保存形式の規定を **CAP.2a** として新設した（`.vstpreset` container・`Cont` を付けない 3 条件・
  旧形式の raw も読める・SDK との差）。根拠は VST3 SDK の一次ソースを取得して確認した
  （`vstpresetfile.cpp` の `savePreset` / `loadPreset`、`funknown.cpp` の `FUID::toString`、
  `fplatform.h` の `COM_COMPATIBLE`、`vstsinglecomponenteffect.h` の `getState` → `getEditorState` の別名化）。
  一次ソース表に 3 行追加。core spec PH.1 と PROJECT_FILE_SPEC PRJ.7 に 1 文ずつ追従
  - CAP 仕様の末尾は「改訂は owner 承認を要する」。owner は #982 の着手を指示したが、
    **仕様の文面そのものは owner の確認を経ていない**ので PR で確認を求める
- **fix（本体）**: 保存を `.vstpreset` container に変えた（CAP.2a）
  - `orbit-vst3-preset` に `build` / `class_id_ascii` / `controller_chunk_to_store` /
    `controller_echoes_component` を追加。テストは実装前に書いて red（未定義でコンパイル不可）を確認した。
    書き出しは **parser を使わずに手で組んだ期待バイト列**と突き合わせる（往復テストだけだと、書き出しと
    解析が同じ向きに間違えたときに気づけない）
  - `Vst3PluginMain` に component の class ID を持たせ、`capture_state` で `IComponent::getState`（必須）と
    `IEditController::getState`（任意）を取って container にする。controller の失敗は INFO の通知
    （`controller_state_capture_notice`・ERROR に倒すと E2E の ERROR 件数を壊す）を出し、component だけで保存する
  - **単一コンポーネント（Kontakt）の重複**: controller の口でも component state を返す plugin は、`Cont` を
    付けない（復元で全 state の `setState` が 2 回走るため）。さらに一度そう分かったインスタンスは以後
    controller の `getState` を呼ばない（毎回の保存で数十 MB 級を 2 回シリアライズするのを避ける・
    `Vst3PluginMain::controller_echoes_component`）。🔴 **Kontakt が実際にどちらの実装かは未確認**
  - 既存テストの追従（いずれも macOS 専用）: `orbit-vst3-host/tests/offline.rs` 2 本・
    `orbit-vst3-instrument-child/tests/{mailbox_wiring,save_during_playback}.rs`・
    `orbit-vst3-effect-child/tests/mailbox_wiring.rs` を「container を解析して `Comp` を照合」に変えた。
    effect の往復テストには `Cont` が付かないこと（oracle の controller は何も書かない）と header の class ID
    （oracle 冒頭コメントの Processor CID）の照合を追加
  - gain oracle に class ID の定数を足そうとしたら `file-size-ratchet`（基準 685 行）を 1 行超えたので取りやめ、
    期待値はテスト側（`tests/` は計測対象外）に書いた
- **検証**（この環境は Linux）:
  - ✅ `cargo test --workspace --locked`（CI と同じ・576 passed / 0 failed）/ `cargo clippy --workspace --all-targets
    --locked -D warnings` / `cargo fmt --all --check` / `npx vitest run tests/repo tests/docs`（74 passed）
  - ✅ macOS 向けの型チェック: `rustup target add aarch64-apple-darwin` の上で
    `cargo clippy --target aarch64-apple-darwin -p orbit-vst3-host -p orbit-vst3-preset -p orbit-vst3-instrument-child
    -p orbit-vst3-effect-child -p orbit-vst3-gain-oracle --all-targets -D warnings`（`coreaudio-sys` が macOS SDK を
    要するので daemon と rack child は対象外）
  - ✅ 手書き変異 3 件（class ID を小文字 16 進 / list offset を +1 / 単一コンポーネント判定の反転）がすべて red
  - ❌ **未実施**: macOS 専用テストの実行（上記の追従分を含む）・Kontakt の gated テスト・実機 E2E。
    owner の macOS 環境で回す必要がある
- **2026-10-23 手元（macOS）で引き継ぎ**（PR #989）:
  - macOS 専用の VST3 crate 5 つのテストを実行: **67 passed / 0 failed / 4 ignored**（ignored は実プラグイン依存）
  - `/simplify`（4 観点）の指摘を適用（振る舞いは不変）:
    - component と controller の state が同じかの全バイト比較を、保存 1 回につき 1 回にした（2 回走っていた）。
      ラッチの前に、判定を実行時に行う理由（SDK の単一コンポーネントでは `IEditController::getState` が
      `getEditorState` の別名で、component の state と別物になりうる）をコメントで書いた
    - state を取り出すときのバッファの丸ごとコピーを `std::mem::take` にした
    - 呼び出し元が 1 か所の薄いラッパ `parse_vstpreset` を外し、`From<MalformedPreset> for Vst3HostError` にした。
      エラー文言を固定するテストは `From` の変換を通る形で host crate へ移した
    - 見送り: テストの「container を解析して `Comp` を取り出す」重複（crate をまたぐので、まとめるとかえって複雑）、
      通知の文字列を作る関数（隣の既存関数に倣った形）、初回保存で controller の `getState` を 1 回呼ぶこと（静的に判定できない）
  - 引用のずれ 4 件（core spec PH.1 の 1 行の追記による）を直した（`sites/dev/{,en/}signal-chain/mixer-audio-line.md`）
- **`/code:pr-review-team` ラウンド 1 と Opus 監査の指摘を適用**（2026-10-23・実装 = Codex・検証 = main）:
  - 🔴 監査の結論: 保存形式・復元順序・main thread の制約・壊れたファイルの扱いは SDK の一次ソースと一致。ただし
    **`Cont` を書いて読み戻す経路と、単一コンポーネントの判定・ラッチを、どのテストも一度も通っていなかった**
    （oracle の controller が 0 バイトを返すため）
  - gain oracle に controller state の seam（環境変数）を足し、`Cont` の往復・SDK の復元順序・取得の 3 分岐
    （`kNotImplemented` / 失敗 / 成功）・単一コンポーネントを固定（`tests/controller_state.rs`）。
    `Cont` を捨てる・1 回でラッチする・通知を抑える、の 3 つの変異がそれぞれ red
  - ラッチを「**2 回続けて一致したら**」に変えた（レビュアー 4 者が「1 回の偶然の一致でエディタの state を失う」と指摘）
  - 取得失敗の INFO 通知をインスタンスごとに 1 回にし、プラグイン名を入れた
  - instrument のテストでも header の class ID を照合。旧形式（raw）を実際の復元経路で読むテスト
  - parse の重複 chunk を SDK と同じ先勝ちに。途中で切れた entry と 0 バイトの `Comp` は意図的に拒否（doc に明記）
  - probe の class ID の書式を `orbit_vst3_preset::class_id_ascii` に統一。gain oracle を分割（行数のラチェットの基準から外れた）
  - **Kontakt 8 の実測**（手元の state ファイル・gated テスト `kontakt_captures_state_three_times_and_reports_controller_chunks`）:
    3 回の capture で `Comp` = 4322 / 4319 / 4320 バイト、**`Cont` = 0**、所要時間は 0.1〜0.2 ms。
    → Kontakt の controller は state を返さない（二重シリアライズの懸念は Kontakt では起きない）。
    **`Comp` のサイズが毎回わずかに違う**（出力が決定論的でない）ので、仮に echo するプラグインでも、バイト比較では一致せず
    ラッチは立たない（監査 I-2 の指摘どおり。害は「毎回取る」側に倒れるだけ）
  - 見送り: 実機 E2E「保存 → 再起動 → 同じ音」。DSL / MCP にロード後の VST3 の state を変える手段が無く、
    synth oracle の state は音高を変えるので RMS では復元漏れを区別できない。必要な手段（state を変える MCP の seam か、
    RMS が変わる controller state 付きの oracle）は別 issue にする
  - macOS 専用の VST3 crate 6 つ: **84 passed / 0 failed / 4 ignored**（sandbox 外）
  - 実機 E2E の追加は #990 で追跡する
- **ラウンド 2**（修正の差分だけを 3 名で再レビュー）の指摘を直した:
  - 🔴 上の修正が持ち込んだもの: controller 用のストリームが作れないとき、通知なしで `None` を返していた（以前の `expect` は panic で気づけた）。
    INFO で通知する
  - 「不一致でラッチを数え直す」テストが、数え直さない実装と区別できなかった（一致 → 不一致 → 不一致の並びだった）。
    一致 → 不一致 → 一致の並びを足し、4 回目の保存でも controller の `getState` が呼ばれることを確かめる（数え直さない変異で red）
  - 通知は「直前と同じ失敗なら出さない」（結果コードが変わる・成功の後に失敗する、では再び出す）。ラッチが立った時に INFO を 1 回出す
  - テストが黙って走らない経路を塞いだ（bundle が無いと何もせずに通る・子プロセスの `0 passed`）。effect の header の class ID も照合。
    Kontakt の計測テストは `Comp` が空でないことと parse できることを assert する
  - macOS 専用の VST3 crate 6 つ: **90 passed / 0 failed / 4 ignored**。Kontakt 8 の再計測では `Comp` = 4320 バイトが 3 回とも同じ、
    `Cont` = 0（前回は 4322 / 4319 / 4320 で揺れた。出力は決定論的とは限らない）
- **840（Kontakt 8 × 6・音色を読み込んだ実際の作品）で確認**（2026-10-23・owner の依頼。作品のコピーを `/tmp` に作り、元のファイルには触れていない）:
  - 流れ: 旧形式（raw）の state で 6 台を読み込み、全層を 30 秒鳴らす → 止めて 6 台を MCP `save_plugin_state` で保存 →
    エンジンを再起動し、保存した container で読み直して同じものを鳴らす → 2 回のキャプチャを比べる
  - 保存の所要時間: **39〜207 ms**（state は 0.26〜5.5 MB。mailbox の上限 5 秒に対して十分小さい）
  - 6 台とも `.vstpreset` container になり、`Comp` は元の raw と同じ大きさ、**`Cont` は無し**（Kontakt の controller は state を返さない）。
    取得失敗の通知も出ていない
  - ERROR: 鳴らしている間・保存の間・読み直した後のどれも **0**
  - RMS: 1 回目 −21.47 dBFS、読み直した 2 回目 −21.32 dBFS（**差 0.15 dB**）→ 保存した state で同じ音色が戻った
  - 制約: MCP は再生中の保存を拒むので、保存は**止めてから**行った（6 台の Kontakt は読み込まれたまま）。再生中の保存
    （effect の差し替え時の `save_dropped`）の経路はこの確認では通っていない
  - 途中で見つかったこと: 音源の外部ドライブを接続していなかったため、Kontakt が state の読み込み中に**画面に出ないモーダルの
    ダイアログ**（`NSAlert runModal`）を出して止まり、OrbitScore 側には「60 秒たっても child が READY を返さない」としか出なかった。
    main でも同じ（#989 とは無関係）。child の起動が止まった理由を見える形にするのは、ネイティブ版の設計の論点
- **主要ホストとの突き合わせと仕様の見直し**（2026-10-23・owner の依頼で一次ソースを調査 → advisor と検討 → **owner 承認**・#982 にコメント）:
  - 一次ソース: Steinberg の dev portal（Persistence / FAQ）と SDK（`vstpresetfile.cpp`・`vstsinglecomponenteffect.h`・`funknown.cpp`）、
    JUCE・Ardour・Carla のソース、REAPER の形式の解析、Bitwig / PreSonus の DAWproject 仕様（`Vst3Plugin.java`）。
    Bitwig 自身の `.bwproject` は非公開で確かめられない
  - 揃っていたもの（変更なし）: `.vstpreset` container で保存（Ardour が同じ形式・DAWproject は「.vstpreset 形式で保存すべき」）、
    controller の取得失敗は `Comp` だけで保存（JUCE / Ardour）、復元の順序、旧形式の raw も読む
  - 🔴 **取り下げ**: 単一コンポーネントの重複判定（バイト比較・2 回一致のラッチ）。**調べたホストはどれも無条件に両方を保存**しており前例が無い。
    SDK の `SingleComponentEffect` は `getState` を `getEditorState` に別名化して両者を分け、nih-plug / iPlug2 / DPF / Kontakt 8 も
    controller の state は空 → 発動するプラグインが見つからない一方、偶然一致の後にエディタの state を失う偽陽性がある。
    controller の `getState` が 1 バイト以上を返したら常に `Cont` を付ける。比較・ラッチ・ラッチの通知・oracle の echo 系モードと、
    それを検査していたテスト 6 本を**機能の取り下げとして削除**した（名前は PR に列挙）。単一コンポーネントでも `Cont` が付くことを確かめる
    テストを残した（比較を戻す変異で red）
  - 🔴 **class ID の照合を追加**: 仕様にあった「ASCII 表現はプラットフォームでバイト順が違うので照合しない」は**誤り**だった
    （ASCII 表現は COM / 非 COM で同じ形。SDK の `loadPreset` と Ardour は不一致なら拒否）。復元のときに大文字小文字を区別せず照合し、
    不一致なら両方の ID を名指しして読み込みを失敗させる（PH.1 の「黙って鳴らさない」と同じ扱い）。raw は header が無いので照合しない。
    照合を外す変異で instrument / effect の両テストが red
  - 未対応として仕様に 1 行: プラグインに「プロジェクトの読み込み」と伝える `kStateType = Project`（JUCE / Ardour も渡さない）
  - 検証: macOS 専用の VST3 crate 6 つ **88 passed / 0 failed / 4 ignored**・clippy / fmt 緑。840 で #989 が保存した container
    （ピアノ）を class ID の照合つきで読み込めた（6.0 s）
  - 修正の差分だけの再レビュー（1 名）: Important 0。Minor 1 件（版をまたいで class ID を変えたプラグインの旧 ID の container を読む
    別名〔SDK の `otherClassIDArray`〕が無い）は、CAP.2a に**既知の制約**として 1 文書いた
  - 実機ゲート（`1b0be318`）: `npm test` 2659 passed・gated E2E **52/52**・cold install 2/2
### fix: apply the pr-review-team round 1 and audit findings to the stack (Oct 23, 2026)

**Date**: 2026-10-23 / **ブランチ**: `claude/affectionate-cori-hulchp`（stack の先端・PR #986 の head）/ 手元（macOS）で引き継ぎ

PR #984〜#986 の `/code:pr-review-team` ラウンド 1（4 名・#984 の差分）と、stack 全体の Opus 監査の指摘を直した（実装 = Codex・検証 = main）。

- **#777 の配線をテストで守る**（監査 Important）: daemon の stderr の `end` で最後の行を flush する 1 行を外しても全テストが緑だった。
  改行の無い最後の行で終わる偽 daemon のテストを足した（外すと `expected [] to include '[daemon] thread main panicked'` で red）
- **和音変数の `r1.r(0)` が鳴らない**ことを、`play()` の展開を通して固定した（テスト分析 Important。今までは `p=1` しか鳴らしていなかった。
  presence を捨てる変異で red）
- 和音定義の中で、以前はパースエラーだったのに黙って声部を落としていた形を、名指しのエラーにした（監査 Minor）:
  random-walk（`[r1%3, 3]`）と入れ子の `[ ]`。rack 配列中の `NAME.r` は、rack 判定より前に修飾子のエラーで落とす
- `evaluate_orbitscore` の基準: 改行を含む基準は resolver の段階で使わない（送らないのに「使った基準」として返していた）。
  `document_path` の確認で `ENOENT` / `ENOTDIR` 以外の失敗は、errno を含むエラーにした
- テストの区別力（2 要素の格子で乱数の経路を固定・落とすべきログ行が落ちることも確認・#966 の反例で `lib966` を名指し）、
  root の判定を「実際に読めるか」で行う形、仕様書の行番号の参照
- 🔴 **未決**: IM.6 の 4 番目（基準が無いとき、engine が前回の基準を使い続ける）は #966 の owner 決定（基準なし）と食い違う。owner の裁定待ち
- `npm test`: 2723 passed / 85 skipped（macOS・sandbox 外）
- **ラウンド 2**（修正の差分だけを 2 名で再レビュー）の指摘を直した:
  - 🔴 上の修正が持ち込んだ不具合: アクティブなエディタのディレクトリ（またはワークスペースのルート）に改行があると、
    黙って次の候補へ移って `ok: true` を返していた（= #966 で避けると決めた「見えない状態で基準が決まる」形）。`ok: false` で理由を返す
  - errno のテストが本物の `evaluateForAgent` の配線を通っていなかった。シンボリックリンクのループ（`ELOOP`）で、
    本物の `fs.statSync` を想定外の errno で失敗させる形にした（`chmod 000` は root で skip されるテストを増やし、
    `privileges-skip-ratchet` を落としたので使わない）。配線を戻すと red
  - 中心が負の数の random-walk（`r-2%3`）の文言のテスト
  - `npm test`: 2725 passed / 85 skipped
- **実機ゲート**（2026-10-23）: 1 回目は 52/55（#940・state 復元・#611 O0-1 の ERROR 件数）。main でも同じ全件を回すと
  state 復元が同じ行で落ち、ERROR 件数の別のテスト（#611 E2E-3）が落ちた。stack の 2 回目は **55/55**。
  → 3 件とも不安定なテストで、stack の退行ではないと判断。cold install 2/2、rack の cargo テストも通過
- 🔴 **IM.6 の 4 番目を #966 の owner 決定に戻した**（owner 2026-10-23・#966 にコメント）:
  #986 の `/code-review` 対応が「基準を送らない（engine は前回の基準を使い続ける）」に書き換えていたのを、
  「どれも無ければ**基準なし**（import は従来どおりエラー）」に戻す。前回の基準を使い続けると、ワークスペースを開かずに
  `.orbs` 以外を前面にして評価したとき、前回の別フォルダを基準に `import` が解決される（= #966 で避けると決めた形）。
  - 拡張は基準が無いとき**空の `//#documentDirectory`** を送り、REPL はそれを「基準なし」として保持する
    （`Global` の `documentDirectory` も消す）。結果は `documentDirectory: none`
  - テスト: 送ったバイト列（空のメタ行が評価の前に入る）・engine の実体（基準 → 空のメタ行 → 相対 `import` が基準なしのエラー）・
    gated E2E の 4 番目の局面（ワークスペースの無い専用セッション）。「何も送らない」に戻す変異で red
  - ラウンド 3 の Minor（空文字のワークスペースは `null`・ELOOP の errno の照合・改行の検査の順序）
  - `npm test`: 2733 passed / 86 skipped
  - 修正の差分だけの再レビュー（1 名）で Important 1 件: `writeCodeToEngine` が改行を含む基準を「送らない（`undefined`）」にしていた。
    送らないと REPL は前回の基準を使い続ける（= 上で禁じた形）。「基準なし（`null`）」として空のメタ行を送るよう main が直した
    （1 行・テストの期待値を合わせて変更。旧の行に戻すと red）。コメント 2 行の追加でずれた dev サイトの引用 4 件を直した（着地先は同じ行）

### fix: address the /code-review findings on this branch (Oct 6, 2026)

**Date**: 2026-10-06 / **ブランチ**: `claude/affectionate-cori-hulchp` / **対象**: `19910c1...HEAD`（#964 / #966 / #684 / #974 / #777 / #757 と /simplify）

owner が回した `/code-review` の 10 件をすべて直した（owner 指示: 推奨どおり全部・以前からある 2 件もあわせて）。
各修正は、修正を外すとテストが red になることを確認した。

- **退行（/simplify で私が入れた）**: `stackVoiceNames` を状態に移した時に `arrayElement` の条件を外し、`var fx = [layer(Reverb)]` の
  呼び出し引数まで音符として読んでいた。条件を戻し、`r` / `rr` の別分岐を同じ分岐へ畳んだ
- **#974 の穴**: `var X = [fx1.r]` は 1 声の和音として通り、ラック／未定義の名前が和音扱いになっていた。`classifyArrayBinding` で
  `NAME.r` の名前を素の参照と同じく判定（ラック → 修飾子エラー・未定義 → 既存の「chord でも rack でもない」エラー）。
  音符修飾子の判定は `random-degree.ts` の `hasNoteModifiers` 1 本に（chord / pattern / rack の 3 経路で共有）
- **#966 の穴**: 基準が決まらない時は `//#documentDirectory` を送らず、engine は直前の基準のまま（`repl-mode.ts:429`）なのに、結果は
  「none」と言っていた。結果を「not sent — the engine keeps its previous base」にし、core spec IM.6 の 4 を実際の挙動に合わせた
- **ring**: 持ち越しの途中で `appendLine` が来たら、持ち越しを独立した 1 行として先に出す（stderr の `ERROR:` 行と繋げない）
- **パス**（以前から）: `setDocumentDirectory("…")` に注入するパスの `"` をエスケープ（tokenizer の `\x` → `x` で往復することをエンジンのパーサで確認）。
  改行を含むディレクトリはメタ行が割れるので送らず警告。`document_path` に改行があれば解決時にエラー
- **daemon stderr**（以前から）: 起動中の収集から行ルータへの切り替えが行の途中で起きると、後半だけが level 無しで ERROR に落ちていた。
  起動成功時に収集分の末尾（`unterminatedTail`）をルータへ先に渡す。実プロセス（偽 daemon + mock server）のテストで、修正を外すと `[daemon] <port>` が ERROR になることを確認
- 整理: `isOrbitscoreDocument` の再利用・`writeCodeToEngine` の古い説明の更新・root-skip ラチェットを `tests/**/*.ts` へ広げ、helper で包むことを禁止
- ファイルサイズ: `daemon-client.ts`（1 回だけ使う `detachStderr` を畳んで 784 → 782）・`parse-expression.ts`（980 → 977）。どちらも baseline を下げた
- WORK_LOG が 2,000 行を超えたので、09-12 / 09-13 の 9 エントリ（423 行）を `docs/archive/WORK_LOG_2026-09.md` へ移した
- dev サイトの引用・散文（ring の例外）を更新

### refactor: apply the /simplify findings on this branch (Oct 6, 2026)

**Date**: 2026-10-06 / **ブランチ**: `claude/affectionate-cori-hulchp` / **対象**: `19910c1...HEAD` のコード差分（#964 / #966 / #684 / #974 / #777 / #757）

`/simplify`（再利用・簡素化・効率・修正の深さの 4 観点を並行）の指摘を集約して直した。

- **#974 の続き（修正の深さ）**: `stackVoiceNames` を引数で 2 段渡していたため、入れ子の `[ ]`（`var c = [[r1~0.5, 3], 5]`）では
  パースエラーのままだった。`ExpressionParser` の状態に移し、入れ子でも同じ読み方にした（引数の二重化も解消）。
  あわせて、`var X = [ … ]` はラックか和音かが実行時に決まるので、**ラック参照に付いた音符の修飾子を黙って捨てずにエラー**にした（`rack.ts` の `resolveRackValue`）。テスト 5 件
- **stdout の行バッファを 1 本に**: bridge 振り分けとログ転写が同じ文字列を別々の `createLinePrefixer` で二重に分割していた。
  1 本の `stdoutLines` のコールバックでログ行も集め、`transcribeLog` で書く（書く時機と、不正な封筒の警告より後に書く順序は不変）
- `CorrelatedLineBridge.request()` の位置引数 6 個をオプションオブジェクトに、`WriteLine` 型を共有
- テスト: `extension-wiring.spec.ts` の stdout 転写テスト 5 件の共通準備を `stdoutHarness()` に。
  gated E2E は `get_log` の窓を `LOG_WINDOW_LINES` で読む `readEngineLog()`（`tests/e2e/helpers/engine-log.ts`）を新設して新規テストで使用。
  root-skip のラチェットは隣のラチェットと同じ `git ls-files`（`file-size-targets.ts` の `gitLsFiles` を export）で列挙し、呼び出しの無いファイルは分割しない
- 細部: `tests/helpers/privileges.ts` の未使用 export を非公開に、`EvaluateResult` の `documentDirectory` を交差型で 1 回だけ宣言、
  `daemon-client.ts` の `daemon-stderr-lines.ts` と重複するコメントを 1 行の参照に
- `parse-expression.ts` の baseline を 982 → 980 に下げた。dev サイトの引用・散文（ja / en）を更新
- **見送った指摘**:
  - `engine-handlers.ts` の SC 時代の部分一致フィルタの削除（#964 本文の案 A）: 拡張は凍結中で、実機 gated の ERROR 件数を確かめられないため。別 Issue 候補
  - 既存 gated テスト 2 本の `runDslLines` と新規 `runLines` の共通化、`start_engine`〜`stop_engine` の `withEngine` 化: 実機で回せない既存テストに手を入れることになるため
  - 音声エンジンを mock したインタプリタ起動の共通化（既存 6 か所）、偽プロセスの stdin 記録の共通化: 差分の外に広がるため
  - `run-selection.ts` と `evaluate-document-directory.ts` の基準の共通化: 見た目だけの整理で、未保存エディタの扱いが変わる
  - `document_path` の `fs.statSync` を非同期に: 1 回あたり約 10 µs で、決定関数の同期の形を崩すほどの価値がない
  - 改行の無い長い行で `createLinePrefixer` が分割を繰り返す件: 既存の部品の性質で、今回の差分では悪化していない（バッファを 1 本にしたので回数は減った）
- 確認: `npm test` 2699 passed / 88 skipped / 0 failed（root）・lint・`docs:check` 0 failed

### refactor(extension): one request-correlation skeleton for the four requestId bridges (Oct 6, 2026)

**Date**: 2026-10-06 / **ブランチ**: `claude/affectionate-cori-hulchp` / **Issue**: [#757](https://github.com/signalcompose/orbitscore/issues/757)

requestId 相関・timeout・書き込み失敗・drain・重複拒否を持つクラスが 5 本、ほぼ一字一句同じ形で複製されていた。

- `packages/vscode-extension/src/correlated-line-bridge.ts` に骨格 `CorrelatedLineBridge<TResult, TContext>` を新設。
  `EvalMarkBridge` / `PluginUiBridge` / `PluginStateBridge` / `EngineStateBridge` はこれを継承し、
  メタコマンド名・結果行の parse・失敗の形・（plugin UI だけ）待っている要求の `action` との突き合わせを注入する。4 ファイルで 285 行減・89 行増
- **`DeviceSwitchBridge` は載せない**（Issue の「抽出時に判断」）: requestId を持たず送った順で相関する FIFO で、
  相関の仕組みが違うものを 1 つに畳むと、どちらの規則で相関しているかが型から読めなくなる
- 動作の差: `EngineStateBridge` に重複 requestId の拒否が入った（Issue が指摘していたずれ。requestId は `randomUUID()` なので実際には起きない）。
  `EvalMarkBridge` に `pendingCount` が増えた。それ以外の公開 API・文言は不変
- 🔴 **動作不変の確認**: 5 本のブリッジの spec を含む `tests/vscode-extension/` を**1 行も変えずに** 654 件全件緑。
  骨格への変異 5 種（重複チェック無効・`accept` 無視・待ち手なしで false・drain で pending を残す・write の false 無視）は、
  いずれも既存の spec が red にした
- dev サイト `plugin-hosting/plugin-ui.md`（ja / en）の引用を骨格へ付け替え、散文に #757 の構成を追記
- 動作を変える修正（#777・ログの行単位化）とはコミットを分けた（`BUNDLE_BRANCH_WORKFLOW.md` §5.1 の検算の機会を残すため）

### fix(extension): frame the non-debug log and the get_log ring by lines, not chunks (Oct 6, 2026)

**Date**: 2026-10-06 / **ブランチ**: `claude/affectionate-cori-hulchp` / **関連**: [#964](https://github.com/signalcompose/orbitscore/issues/964) の残り・設計 668 §13.5.2（束 E-router の「ring proxy」）

「chunk → 行」4 経路のうち、残っていた 2 つ（stdout のログ転写・`get_log` 用リングへの写し取り）を行単位にした。

- **ログ転写**（`setupStdoutHandler`・非 debug）: chunk ごとに `split` して `shouldFilterLine()` に通していたため、
  chunk 境界で割れた行の後半が独立に filter されていた。`🎚️ … play={"type":…}` の行が `"type"` の手前で割れると、
  `🎚️` の無い後半が `"type"` で落ちる（#964 の修正で残した穴）。bridge と同じ `StringDecoder` + `createLinePrefixer` を通し、
  残す行は chunk ごとに 1 回の `append` で書く。stdout の `end` で持ち越しを flush。UTF-8 の文字が chunk をまたいでも化けない
- **ring proxy**: `activate()` の monkey-patch を `log-ring.ts` の `tapOutputIntoLogRing()` に切り出し、`append` の改行の来ていない末尾を
  持ち越すようにした。`appendLine` は持ち越しと合わせて 1 行（チャネルに見えている行とリングの行を一致させる）。debug 起動の生 chunk も 1 行 = 1 エントリになる
- playhead（`[STEP]`）と `//#selectAudioDevice` は従来どおり生 chunk のまま（呼び出し規約を変えない）
- 🔴 **#773 のテストが固定していた「ログ転写は chunk 単位のまま」を変えた**。その PR の範囲を絞るための固定で、製品の要件ではない。
  新しい期待（割れた行は改行が来たときに 1 行で書く）に書き換えた
- テスト: `extension-wiring.spec.ts` に 4 件（割れた行・#964 の `"type"` の後半・UTF-8 の分割・`end` の flush）、`log-ring.spec.ts` に 3 件。
  修正を戻すと 7 件とも red を確認
- 🔴 `get_log` に入る行の形が変わる（割れた行が 1 行になる）ので、**実機 gated E2E 全件で確認が必要**（設計 668 の PR-E12 の注記と同じ）。この環境では未実行
- dev サイト（`editor/vscode-architecture.md`・`editor/mcp-and-gated-e2e.md`・ja / en）の引用と散文を更新

### fix(engine): flush the daemon's last stderr line when the stream ends (Oct 6, 2026)

**Date**: 2026-10-06 / **ブランチ**: `claude/affectionate-cori-hulchp` / **Issue**: [#777](https://github.com/signalcompose/orbitscore/issues/777)

`createDaemonStderrLineRouter` は改行の無い残りを持ち越すだけで吐き出す経路が無く、daemon が panic / SIGSEGV で
改行なしに死ぬと**クラッシュ経路の最後の 1 行**が落ちていた。

- owner 裁定（2026-10-06）: 計画では「#757 に着手する時点で #777 と畳む」（`IMPLEMENTATION_PLAN_2026-09.md` §2.5）。
  どちらも実機確認なしにはマージしないので、#757 と同じブランチでまとめて行う。動作を変える修正（本件）と
  変えないリファクタ（#757）はコミットを分ける
- 戻り値を拡張側の双子 `createLinePrefixer`（#756）と同じ `{ push, flush }` にし、`child.stderr` の `end` で `flush()` する
- `flush()` も level で振り分ける（panic の行は ERROR 側）。空白だけの残りは出さない（ERROR の水増し防止）。二重 flush は何も出さない
- ファイルサイズのラチェット: `daemon-client.ts` が baseline 804 を超えたので、状態を持たない行処理
  （`ANSI_ESCAPE_RE` / `isDaemonNonErrorTracingLine` / `createDaemonStderrLineRouter`）を `daemon-stderr-lines.ts` へ移し、baseline を 784 に下げた
- テスト: `tests/audio/rust-engine/daemon-client.spec.ts` に 2 件。`flush()` を空にする変異で red を確認
- 「chunk → 行」の 4 経路のうち daemon stderr はこれで flush を持つ。共有部品への一本化はパッケージ依存の判断が要るので範囲外のまま

### fix(pitch-dsl): read name modifiers in chord definitions the same way as play() (Oct 6, 2026)

**Date**: 2026-10-06 / **ブランチ**: `claude/affectionate-cori-hulchp` / **Issue**: [#974](https://github.com/signalcompose/orbitscore/issues/974)

- 🔴 **Issue の前提が実態と違った**: 「chord 定義の中の `NAME.r(p)` は警告で声部が落ちる」とあったが、DSL からは
  評価器のその分岐に届かず、**パースエラー**（`Expected comma or closing bracket but got DOT`）になっていた。
  調べると、chord 定義の `[ ]` では名前に付く修飾子 `.r` / `.r(p)` / `~` / `@v` / `^r` と `r.r(p)` がすべてパースエラーで、
  `play()` の `[ ]` ではすべて読める（実測の表は Issue への報告に記載）。PITCH_DSL_SPEC §6.2.1「どこでも同じ」に反する
- owner 裁定（2026-10-06）: **案 A** = chord 定義でも `play()` と同じ読み方にする
- パーサー: chord 定義（`parseChordBinding`）の配列だけ、名前の要素を `play()` の `[ ]` の声部と同じ処理
  （`parseStackNameVoice`。`parseStackElement` から切り出して共有）で読む。effect() / instrument() のラック配列は従来どおり
- 評価: `NAME.r(p)` の判定（ランダム音源ならランダム声部・chord / pattern への `.r` はエラー）を `resolveReferenceThin` に切り出し、
  `play()` と chord 定義で共有。chord / pattern の参照に付いたランダム専用の修飾子（`~` / `^r` / `@v` / `@g`）も、定義の中で
  `play()` と同じくエラーにした
- 🔴 もう 1 つの穴: `signal-chain/rack.ts` の `chordElement` が chord_ref を「名前と `^N`」だけで作り直しており、修飾子が**黙って落ちていた**
  （パーサーを直しただけでは `r1~0.5` の detune が消える）。参照をそのまま渡すようにした
- ファイルサイズのラチェット: `parse-expression.ts` が baseline 987 を超えたので、状態を持たない後置語彙
  （`VOICING_OPS` / `SCOPE_CHAIN_OPS` / `VOICING_ARITY` / `ScopeChain` / `collapseScopedRun`）を `parser/play-postfix-ops.ts` へ移した。
  baseline は 982 に**下げた**。dev サイトの `collapseScopedRun` の引用（ja / en）を新しい場所へ
- 仕様: PITCH_DSL_SPEC §6.2.1 と core spec P.12.1 に「chord 定義の声部も同じ」を追記
- テスト: `tests/midi/random-degree.spec.ts` に 6 件（確率つきランダム声部の保持・`play()` と同じ音・全修飾子・chord / pattern の拒否）。
  ソースの修正を戻すと 6 件とも red を確認
- gated E2E: 1 声の chord 変数 `[r1.r(1)]` を 16 回鳴らし、C4 / G4 だけ・両方が出ることをキャプチャで確認するテストを追加。
  🔴 **この環境では未実行**

### test: skip the three DAC-dependent cases when running as root (Oct 5, 2026)

**Date**: 2026-10-05 / **ブランチ**: `claude/affectionate-cori-hulchp` / **Issue**: [#684](https://github.com/signalcompose/orbitscore/issues/684)

`chmod 0o000` で「読めないファイル」を作って EACCES を期待するテスト 3 件が、root では DAC を迂回して読めてしまうため
必ず落ちていた（root のクラウド環境では pre-commit hook が常に通らない）。設計 668 §13（PR-E11）のとおり直した。

- `tests/helpers/privileges.ts` を新設（`RUNNING_AS_ROOT` / `skipWhenDacIsBypassed(context)`）。
  設計の `it.skipIf` ではなく `context.skip(条件, 理由)` を使い、**skip の理由がレポーターに出る**ようにした（#684 の受け入れ基準）
- 対象 3 件: `tests/interpreter/file-import.spec.ts`（import の EACCES 分類）・`tests/vscode-extension/mcp-server-docs.spec.ts` 2 件
- 設計の「併せて」: 呼び出し箇所のラチェット `tests/repo/privileges-skip-ratchet.spec.ts`（3 件から増えたら red。基準を 2 にすると red になることを確認）
- 実測: root で 3 件が `[root bypasses DAC: chmod 0o000 stays readable (#684)]` 付きで skip。
  `setpriv --reuid=65534` の非 root 実行では 3 件とも走って緑。root での `npm test` 全体: 2680 passed / 87 skipped / 0 failed

### fix(extension): resolve evaluate_orbitscore paths against the .orbs directory (Oct 5, 2026)

**Date**: 2026-10-05 / **ブランチ**: `claude/affectionate-cori-hulchp` / **Issue**: [#966](https://github.com/signalcompose/orbitscore/issues/966)

`evaluate_orbitscore` は基準ディレクトリ（`//#documentDirectory`）に常に最初のワークスペースフォルダを送っていたため、
`.orbs` がサブフォルダにあると import・`audio()`・plugin state の相対パスが `run_selection` とずれていた。
方針は owner と議論して決めた（記録: [#966 のコメント](https://github.com/signalcompose/orbitscore/issues/966#issuecomment-6005747794)）。

- **仕様を先に更新**: core spec IM.6 に順序を追記 — 引数 `document_path` → アクティブな OrbitScore エディタ → 最初のワークスペースフォルダ → 基準なし。
  使った基準を結果に含める
- `document_path` を入れた理由: 前面のタブはエージェントから指定できず、`open_file` で変えると人の画面を奪う。
  人の演奏と並行してエージェントが書き換える使い方（FuruFuruFruits / WCTM のハーネス）で競合しないようにするため。
  「人の操作を検知して待つ」案は、この問題の代わりにならないとして採らなかった（理由は上の Issue コメント）
- 実装: 決め方を純関数 `packages/vscode-extension/src/evaluate-document-directory.ts` に切り出し、`evaluateForAgent` から使う。
  存在しない `document_path` は黙って dirname を取らずエラー（engine へ何も送らない）。未保存（untitled）のエディタは基準にしない
- MCP: `evaluate_orbitscore` に任意の `document_path` を追加。結果の文言は従来どおり `ok` / `error:` で始まり、
  末尾に `(documentDirectory: <path>|none)` を付ける（コードを送らなかった失敗には付けない）
- テスト: `tests/vscode-extension/evaluate-document-directory.spec.ts`（決め方 9 件 + `evaluateForAgent` の配線 3 件。
  配線の 3 件は旧実装に戻すと red を確認）、`tests/vscode-extension/mcp-server.spec.ts`（スキーマ・引数の受け渡し・結果の文言）
- gated E2E: サブフォルダの `.orbs` から `import` を `evaluate_orbitscore` で評価し、前面のエディタ基準・ルートの失敗・
  `document_path` 優先（タブが切り替わらないこと）を確認するテストを追加。#630（import の実機確認 0 件）の初の実機カバーにもなる。
  🔴 **この環境では未実行**（ゲート未設定で skip のみ確認）
- dev サイト: `pipeline/selective-execution.md` の散文（ja / en）を新しい挙動に更新。引用の行ずれ（#964 分を含む 58 件）を
  `check-citations.mjs --fix` と手作業（中身が変わった 4 箇所 × ja / en）で直し、`docs:check` 0 failed

### fix(extension): keep play() update lines that carry object elements in the log (Oct 5, 2026)

**Date**: 2026-10-05 / **ブランチ**: `claude/affectionate-cori-hulchp` / **Issue**: [#964](https://github.com/signalcompose/orbitscore/issues/964)

ループ中に `play()` を差し替えたときの `🎚️ <seq>: play=… (next cycle)` 行が、パターンに
オブジェクトになる要素（入れ子 `(0, 1)`・タイ `_`・`1@v+10`・臨時記号 `b3`）を含むと
出力チャネル（= MCP の `get_log`）から消えていた。

- **原因**: `play()` はそれらの要素を JSON で行に書き出す（`packages/engine/src/core/sequence.ts` の `play()` 末尾）。
  非 debug 起動の `shouldFilterLine()`（`packages/vscode-extension/src/engine-handlers.ts`）は、
  SC 時代の OSC ダンプを隠すための部分一致で `"type"` を含む行を一律に落としており、
  残す一覧（`ERROR` / `⚠️` / `🎛️`）に `🎚️` が無かった（`🎛️` は U+1F39B で別の文字）
- **修正**: 残す一覧に `🎚️`（U+1F39A）を足した。残す判定は落とす判定より前にあるので、
  パラメータ更新の行は中身に関係なく残る。#964 のコメント（2026-10-05・WCTM からの報告）の案をそのまま採った
- **採らなかった案**（Issue 本文の A〜C・どれにするかは owner 未決）: A（SC 時代の条件群の削除）/ B（OSC ダンプの形への限定）は、
  daemon から転送される行（`"/` を含むパスや `channels` を含むデバイス情報）の扱いも変わり、
  `get_log` の固定 500 行窓に入る行の量が変わるので、実機 gated で確かめられないこの環境では入れなかった。
  C（ログを DSL 表記で出す）は `PlayElement` の全形について表記を決める必要があり、別作業とした
- **テスト**: `tests/vscode-extension/play-update-log-filter.spec.ts` を追加。行を手で書かず、
  実際のインタプリタ（mock の audio エンジン）にループ中の `play()` 差し替えを評価させて採った行を
  `shouldFilterLine()` に通す。修正を戻すと平らなパターン（対照）以外の 4 件が red・修正後は 6 件すべて緑（実測）
- **gated E2E**: `tests/e2e/orbitstudio-mcp-gated.spec.ts` に
  「入れ子の `play()` を `run_selection` → `get_log` に `🎚️ hat964: play=` が 1 行出る」を追加。
  🔴 **この環境（Linux・VS Code / 音声デバイス無し）では実行していない**。ゲート未設定で skip されることだけ確認した
- 4 形のうち `1@v+10` / `b3` は note シーケンス向けの形だが、テストでは audio シーケンスで評価して行を採った
  （note シーケンスは実 MIDI ポート / プラグインを要する。更新行は `seamlessParameterUpdate('play', …)` が出すもので、シーケンスの種類に依らない）
- 残る穴（未着手）: ログ転写は stdout の chunk ごとに `split('\n')` しており行を持ち越さない（`createLinePrefixer` の注記の経路 3・4）。
  長い `play=` 行が chunk 境界で割れると、`🎚️` を含まない後半は従来どおり部分一致で落ちうる（コードを読んでの推測・実測なし）
- この環境は root で動くため、`npm test` は #684 の権限テスト 3 件（`file-import.spec.ts` 1 件・`mcp-server-docs.spec.ts` 2 件）が落ちる。
  本変更を stash した状態でも同じ 3 件が落ちることを確認した（本変更とは無関係）

### docs: follow the 4.3.0 release into the specs (Oct 4, 2026)

> **2026-10-05 追記（main がマージ前に補正）**: 見出しの「`random` 自体も名前として使えなくなった」は実装より強かった（予約語は `r` / `rr` だけで、`random` という変数名は作れる。書けなくなったのは `var X = random.<名前>` をミキサー派生として読ませることだけ）。正本と core spec の見出しを「`random` という名前のミキサーからは派生できなくなった」へ直した。

**Date**: 2026-10-04 / **ブランチ**: `claude/docs-sync-pr977` / **追従元**: PR [#977](https://github.com/signalcompose/orbitscore/pull/977)（merge commit `5decc06`・head `eb96ae0`）

リリース PR #977（拡張 4.2.1 → **4.3.0**）の追従。版表記は #977 自身が全箇所を更新済みで、
残っていたのは **2 つ目のコミット `eb96ae0` が CHANGELOG にだけ書いた名前の衝突**だった。

- `random` という名前がミキサー派生のベースに使えなくなったこと（`var random = init global.mixer` の後の
  `var drums = random.sum` が書けない）を**仕様の正本へ**転記: `docs/specs-v2/PITCH_DSL_SPEC_v1.1.md` §6.2.1 の
  宣言の項 / `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` P.12.1 / 同 SC.2.1 の派生の例（読者が最初に当たる場所）
- 推測で書かず実装で裏を取った: `packages/engine/src/parser/parse-statement.ts:127-134` で
  `random` の分岐がミキサー派生の先読み（`<id>.output|sum|aux`）より**前**に置かれている
- `sites/user/` `docs/user/` は触っていない。ミキサー変数からの派生（`var X = mix.sum`）を**一度も教えていない**ため
  （`grep -rn 'init global.mixer\|mix\.sum\|mix\.aux' sites/user/ docs/user/` が 0 件）、読者が到達できない形についての
  注記を足すと混乱するだけになる。`random.<mode>` 自体は `sites/user/midi/voicing.md:90` で既に説明済み（#976 で追従）
- 版表記の検算: 素の `4.2.1` が残るのは CHANGELOG の過去の版の記録と dev サイトの `:9` の追従履歴 Note（いずれも過去の記録）だけ
- #977 が落とした空行（新しい節の末尾と次の `###` 見出しの間）を復帰

### chore(release): bump the extension to 4.3.0 (Oct 5, 2026)

**Date**: 2026-10-05 / **ブランチ**: `975-release-4.3.0` / **Issue**: [#975](https://github.com/signalcompose/orbitscore/issues/975) / **Commit**: `dd884dca`

凍結版（拡張版 OrbitScore）を **4.3.0** として更新する。中身は #967（音高の乱数 `r` / `rr` / `random.<mode変数>`・PR #971 仕様 / PR #973 実装）と #969（`mode(0, …)` をパースエラーに）。

- **版の決定**: owner は当初「4.2.2」と指示したが、main が SemVer（`CHANGELOG.md` 冒頭で宣言）では後方互換の新機能 = minor であること・前例（4.2.0 = 機能追加 / 4.2.1 = 修正）・`r` / `rr` が予約語になる変化を番号で伝えられることを挙げて 4.3.0 を推奨し、owner が採用（2026-10-05）
- 現在の版を名乗る箇所を 4.2.1 → 4.3.0: `packages/vscode-extension/package.json` / `CLAUDE.md` ×2 / `README.md` ×3 / `docs/core/INDEX.md` / core spec ×2 / dev サイト 3 章 × ja・en（前回 #961 と同じ範囲）
- `CHANGELOG.md` に `[4.3.0]` 節と比較リンク
- 追記（Commit: `d64cf5b5`・advisor の指摘）: `random.<名前>` が常にランダム音源として読まれるようになり、`random` という名前のミキサーからの派生（`var drums = random.sum`）が書けなくなった変化を CHANGELOG の Changed に 1 行
- #967 の文書の「4.3.0 想定」を「4.3.0 で出荷」へ（設計 967 / 地図 §4.Q / NATIVE §12.8 / 決定ログ §16.3）
- 🔴 検算は「古い番号が残っていないこと」で行った（memory の教訓）: 素の `4.2.1` は CHANGELOG の過去の版の記録 3 行だけ、「4.3.0 想定」は 0 件
- リリースは main に入った後のドキュメント追従 PR を先に入れてから（owner 2026-10-05）。#963（4.2.1 の Note）→ #972（#971 の追従。adr-002 の「未実装」を「#973 で実装・4.3.0 で出荷」へ main が補正）→ #976（#973 の追従・本文の参照 98 か所）の順に、衝突を main が解いてマージした
- #963 の規約（本文の版を送ったら `:9` の追従履歴 Note に 1 文）に従い、dev サイト 3 章 × ja・en の Note に v4.3.0 の 1 文を追記

### docs: follow PR #973 (random pitch) in the dev site citations (Oct 4, 2026)

**Date**: 2026-10-04 / **ブランチ**: `claude/docs-sync-pr973` / **追従元**: PR [#973](https://github.com/signalcompose/orbitscore/pull/973)（merge commit `9c66585`）

PR #973 は `// FILE:START-END` 形式の引用ヘッダ（`docs:check` が検証する層）を再アンカーしたが、
**散文と「Sources」節の `path:line` 参照は検証対象外**なので取り残されていた。その 98 箇所を再アンカーし、
あわせて差分で数が変わった記述を直した。実装・テストの変更は無い。

**再アンカー（98 箇所 / 22 ファイル・ja と en）**
- 各参照について、BASE (`0bab20a`) の該当行と HEAD (`f54a8e0`) の再計算後の行が**同一内容**であることを機械的に照合してから書き換えた（先頭行・末尾行の一致を必須条件にし、一致しないものは触っていない）
- この PR が触っていないファイルへの参照（`interpreter/types.ts` 等）は対象外

**数・列挙の追従**
- `Statement` union: 11 → 12 メンバー（`RandomBinding`）。mermaid の classDiagram と Sources 節も
- `DSL_SYNTAX_SURFACE`: 13 → 15（`random-pitch` / `random-binding`）
- `processStatement()` の case: +1（`random_binding`）
- `parseVarDeclaration()` の判別トークンに `random.` を追加
- `TimedEvent` の optional フィールド一覧に `randomDegree` を追加

**新規に書いた記述（差分から読み取れる範囲のみ）**
- `var X = random.<mode 変数>` の分岐がミキサー宣言の先読みより前に置かれていること（順序自体が仕様）
- `PlayRandomDegree` が度数を持たず修飾子だけを運ぶこと

🔴 frontmatter の `verified-against` / `verified-at` は**更新していない**。章全体を読み直したわけではなく、
引用の再アンカーと差分に対応する記述の追従のみだからである（PR #973 自身も更新していない）。

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
- [2026-09（09-01〜09-26）](../archive/WORK_LOG_2026-09.md) — #883 束 C のレビュー round 1、#883 束 S / 本体 (#883)、#888 子 1、#878、4.1.0 リリース (#926)、pan を両段とも減衰のみにした裁定 (#921/#922)、E2E-4/E2E-5 の実機実装 (#917) を含む。09-14〜09-26 分（4.2.0 / 4.2.1 のリリース・#939 / #940 の plugin UI・#954 の docs 同梱・#967 の乱数ピッチ・製品名の整理）は 2026-10-27 に移設（#1033）
