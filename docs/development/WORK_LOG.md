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

### docs: bring the README back in line with the shipped 4.1.0 (Sep 13, 2026)

**Issue**: #937。README を実体と 1 行ずつ突き合わせ、**乖離 7 件**を直した。

#### 🔴 最重要: 入門例が鳴らなかった

`README.md` の `Basic DSL Syntax` は `kick.play(...)` を書いて **`.output()` が無かった**。
#883（DSL 2.0・暗黙 master 終端の廃止）以降、**`output()` の無いシーケンスは無音**である。

| | `.output()` |
|---|---|
| `examples/01_getting_started.orbs` | ✅ |
| `sites/user/getting-started/first-sound.md:50` | ✅ |
| **`README.md`** | 🔴 **無し** |

`examples/` の audio 系 10 本はすべて `output(` を含む（0 は MIDI 専用の 2 本のみ）。
**README だけが取り残されていた** — 読者が最初にコピペするコードなので実害が一番大きい。
修正後の例は `parseAudioDSL` に通して **14 statements・エラー 0** を確認した。

#### 直した残り 6 件

| 箇所 | 何が古かったか |
|---|---|
| `Current Implementation Status` | **「2.0.0 is released」** — 同じ節の別行は 4.1.0 を名乗っており自己矛盾していた |
| `Development Status` の Phase 7 | **「SuperCollider Integration」が `<details>` の外**＝現況として読めた（#502 で削除済み） |
| `Testing` の件数 | `2271/58/2329`（2026-09-10）→ **`2497/76/2573`**（実測） |
| 拡張のインストール手順 | **`Developer: Install Extension from Location...` でソースフォルダを読ませていた** — #873 / #878 が露出した層を丸ごと飛ばす経路。`npx vsce package` → `.vsix` へ変更し、`pretest:e2e:cold-install` と同じ手順に揃えた |
| Technical Features | **セッションログ（`.orbslog`）に一言も触れていなかった**（既定 off・`ORBITSCORE_SESSION_LOG=1` で opt-in） |
| `#138` の行 / `Syntax highlighting (2.0.0)` | 前者は自動化済みの注記を追加、後者は無意味な版表記を削除 |

🔴 **ビルド手順も直した** — 旧手順は `cd packages/vscode-extension && npm run build` だったが、
engine の `dist` と daemon / plugin-child のバイナリを拡張へ入れるのは**ルートの `npm run build`**
である。拡張ディレクトリだけでビルドして package すると、中身の入っていない `.vsix` になる。

#### 🔴 自分の誤り: 層を 1 つ見て「存在しない」と判断しかけた

`seq.effect()` / `seq.instrument()` / `seq.ui()` について、`Sequence` クラスの public メソッドを
列挙して**「存在しない」と結論しかけた**。実際は **interpreter の dispatch**
（`packages/engine/src/interpreter/process-statement.ts:281,285`）と
`signal-chain/runtime.ts:53,76` が DSL 表面として扱っており、README の記述は正しかった。
**DSL の表面はクラスのメソッド一覧ではない。** [[enumeration-stops-one-level-too-early]]

同様に検算して**乖離が無かった**もの: `compressor()`/`limiter()`/`normalizer()` の no-op
（`rust-engine-player.ts:1462` が warn only）/ LinkAudio の default off（`Cargo.toml:23`）/
ディレクトリ構造 11 項目 / 参照している issue 番号 10 件の状態。

`docs:check` exit 0 / lint exit 0 / `tests/docs` + `tests/repo` 86 passed。

Closes #937

---

### docs: fold the remaining docs-sync PRs and fix the version claims they found (Sep 13, 2026)

**Issue**: #933。#930 / #907 / #902 / #901 / #900 を取り込み、**#904 と #929 は close**した。

#### 🔴 #904 はマージしてはいけなかった — が、発見は正しかった

#904 は「4.0.1 の bump が漏らしたページ」を直す PR で、**main は既に 4.1.0** なので
マージすると**版が巻き戻る**（`+` 側に `4.0.1` が 16 箇所）。
**しかし指摘は当たっていた** — 4.1.0 の bump が届いていない箇所が残っていた:

| 箇所 | 直前の値 | 直した値 |
|---|---|---|
| `docs/core/INDEX.md:5` | 拡張 **3.0.0** / `DSL_VERSION 1.2` | 4.1.0 / `DSL_VERSION 2.0` |
| `sites/dev/{,en/}editor/vscode-architecture.md:15` | package version **3.0.0** | 4.1.0 |
| `sites/dev/{,en/}editor/vscode-architecture.md:1154/1155` | version **3.0.0** | 4.1.0 |

**2 版分（3.0.0 → 4.0.1 → 4.1.0）取り残されていた。** #904 の中身だけ採って 4.1.0 で書いた。

#### 🔴 版の列挙はこれで 3 回連続で漏れている

| 版 | 漏れ | 後始末 |
|---|---|---|
| 4.0.1 | 複数ページ | `10d3c7eb`「follow the bump into the pages it missed」を後出し |
| 4.1.0 | `README.md:55` | PR #928 の中で修正 |
| **今回** | 上の 5 スポット | 本 PR |

原因は毎回同じで、**grep のパターンが「現在の版の数字」や特定の強調記法に依存していた**こと。
`**4.0.1**` と `"version"` を狙ったパターンは、`VS Code 拡張 **3.0.0**` や
`package version 3.0.0` を**構造的に拾えない**（探しているのが「古い版」ではなく
「**版を名乗っている場所**」だから）。

**今後は数字に依存しないパターンで数える**:

```
(拡張|extension)[^0-9]{0,40}[0-9]+\.[0-9]+\.[0-9]+|package version [0-9]+\.[0-9]+\.[0-9]+|Current release
```

24 箇所が挙がり、1 つずつ「現在の版を名乗るのか／履歴記述か」を判定した。
履歴（`DEVELOPMENT_MAP:240` の #883、各 provenance Note、`architecture-overview:620`）は触っていない。

#### ついでに直した 2 件

- `sites/dev/en/editor/vscode-architecture.md` の `contributes.commands` が **(17)** だったが、
  `package.json` の実体は **15**。ja 側は 15 で正しく、**en だけがずれていた**
- `docs/testing/{TESTING_GUIDE,PERFORMANCE_TEST}.md` のインストール例が
  `orbitscore-0.0.1.vsix` のままで、**コピペすると失敗する**。
  `orbitscore-darwin-arm64-*.vsix`（`release.yml:129` の命名と一致）へ直した。
  `docs/user/{ja,en}/GETTING_STARTED.md` にも同じ例があるが、**両方 DEPRECATED 宣言付き**なので触っていない

#### #902 の衝突は「分割前 vs 分割後」だった

HEAD 側が `output.rs:254-260` / `session.rs:691-718` という**分割前のパス**を指したままで、
#902 が `output/lines.rs` / `output/render.rs` / `session/dispatch.rs` へ貼り直していた。
**参照リストは #902 側を採り**、frontmatter は HEAD（`verified-against: f2245bb` が新しい）を採って、
Note は**両側の固有文を文単位で統合**した。

#### #929 は差分 0 だが中身が重要（→ issue へ）

🔴 **E2E-P が裁定 D′ と旧 `√2 · equal_power_pan` 則を区別できない**ことを指摘している。
`hardLeftCh1 / hardLeftCh0 ≤ 0.05` も `centerRms / noPanRms ≈ 1` も**旧則で通る** —
発音側の差は 3 本すべてに等しく掛かるので比を取ると消えるため。
その他の指摘とあわせて issue 化した。

`docs:check` exit 0 / lint exit 0 / `npm test` 全件 pass。

Closes #933

---

### docs: re-anchor the dev-site code pointers onto the #896 split (Sep 12, 2026)

**Date**: 2026-09-12 / **ブランチ**: `claude/docs-sync-pr896`

PR [#896](https://github.com/signalcompose/orbitscore/pull/896)（#888 子 2・`session.rs` 2,605 → 439 /
`output.rs` 2,587 → 322 コード行）へのドキュメント追従。

#896 は `// FILE:START-END` 引用ブロックを分割後のモジュールへ張り直しており、`npm run docs:check`
は 948 件すべて緑である。**しかし `check-citations.mjs` が見ているのは引用ブロックだけ**で、
本文中のインライン参照と各章末「参考にしたコード」の `path:line` は検査対象外だった。
その結果、**dev サイトに 44 箇所の宙に浮いた参照が残っていた**（`output.rs:3290-3322` など、
445 行しかないファイルへの参照）。

本コミットはそれらを**シンボルから引き直して**再アンカーした（ja / en 両方）:

- `sites/dev/rust-engine/index.md` — コマンド表の出典が単一 `match` ではなくなった旨を追記し、
  `session/run_loop.rs` / `session/dispatch.rs` / `dispatch_plugin.rs` / `dispatch_transport.rs` へ分解
- `sites/dev/rust-engine/insert-bus.md` — `InsertBusStage` の 2 つの参照が同一定義に解決するため 1 本へ統合
- `sites/dev/rust-engine/capture-verification.md` — `CAPTURE_RING_SECONDS` / `OutputStream` と
  `render_block_with_sources` が別ファイルへ分かれたため 2 本へ分割
- `sites/dev/signal-chain/mixer-audio-line.md` — post-loop が `output/render_full.rs` へ移った
- `sites/dev/plugin-hosting/plugin-ui.md` — `ClosePluginUI` が `session/dispatch.rs` へ移った
- 上記 5 章の `verified-against` / `verified-at` を `9c29e45` / `2026-09-12` へ更新

`/docs` 側も 2 件:

- `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` — `validate_line_program` の `Pan` 受理と
  バス上 pan 則（`line_pan_coefficients`）を `output/line_program.rs` / `output/dsp.rs` へ
- `docs/research/ENGINE_DAEMON_PROTOCOL.md` — 最後の session 切断の判定を
  `session/params_plugin.rs` の `SessionRegistration::disconnect` へ

🔴 **発見: これらの参照は #896 より前から既に壊れていた。** 旧 `path:line` を `9d39d2e`
（#896 の base）で引き直したところ、**確認した 34 箇所のほぼ全部が無関係な行を指していた**
（例: `output.rs:823-846` は「active flag snapshot」と書かれていたが実際は `MasterLine::new`、
`session.rs:1271-1284` は「session 切断 trigger」と書かれていたが実際は outproc frames-clamped の
ticker）。**引用ブロックだけがラチェットで守られ、その隣の散文参照は誰にも検査されずに漂流していた。**
CLAUDE.md「規律を足す時は、同時にそれを守らせる仕組みを足すこと」の未適用箇所である。

**実装・テストは 1 行も変更していない。**

---

### docs: re-anchor the dev-site prose citations that PR #895 moved out of engine_wrap.rs (Sep 12, 2026)

**Date**: 2026-09-12 / **ブランチ**: `claude/docs-sync-pr895`

PR [#895](https://github.com/signalcompose/orbitscore/pull/895)（merge commit `9d39d2e`）の
ドキュメント追従。`engine_wrap.rs` は 6,418 → 424 コード行になり、21 の子モジュールへ実体が移った。

### 🔴 `docs:check` が見ていない引用が 40 件残っていた

PR #895 は `// FILE:START-END` の**コードブロック引用**（`docs:check` が文字単位で突合する層）を
すべて直していた。直っていなかったのは、**本文と「参考」節の散文引用**である。

| 層 | #895 で直ったか | 機械検査 |
|---|---|---|
| ` ```rust // path:start-end ` のコードブロック | ✅ | `sites/dev/scripts/check-citations.mjs`（948 件） |
| 本文の `` `engine_wrap.rs:6470-6560` `` 等 | ❌ **40 件が残存** | **無い** |

`check-citations.mjs` はフェンス直後のヘッダ行しか見ないので、散文に書かれた path:line は
**ラチェットの外側**にいる。今回はそこを実ファイルへ手で突き合わせて貼り直した。

🔴 **この 40 件は #895 より前から line がずれていた**（base `0819a88` で実測。例:
`engine_wrap.rs:4455` が指していたのは `path: &std::path::Path,` の行だった）。
ただし #895 で**ファイルそのものが変わった**ので、行ずれではなく到達不能になった。

### 直した範囲

`sites/dev/`（ja）と `sites/dev/en/`（en）の 6 章 × 2 言語:
`rust-engine/index.md` / `rust-engine/insert-bus.md` / `signal-chain/index.md` /
`signal-chain/mixer-audio-line.md` / `plugin-hosting/catalog.md` / `plugin-hosting/plugin-ui.md` /
`glossary.md` / `rust-engine/oop-children.md`。

置換は 40 件の行番号付き引用と 18 件の散文言及で、**ja / en の件数一致を assert して**適用した
（片方だけ直る事故を機械で防いだ）。

### DSL 正本（`docs/core/INSTRUCTION_ORBITSCORE_DSL.md`）も 5 箇所直した

MX.4 の「今日の現在地」表が `SetBusRouting` の kind 拒否と forward-only 拒否を
`engine_wrap.rs:7212-7216` / `:7237-7241` / `:5802-5806` / `:7207-7211` で引いていた。
実体は `engine_wrap/bus_lines.rs` の `set_bus_routing` にある:

| 規則 | 現在地 |
|---|---|
| `output '<name>' must be a sum bus` | `engine_wrap/bus_lines.rs:299-303` |
| `send '<name>' must be an aux bus` | `engine_wrap/bus_lines.rs:325-329` |
| forward-only（output） | `engine_wrap/bus_lines.rs:292-296` |
| forward-only（send） | `engine_wrap/bus_lines.rs:318-322` |

### frontmatter は触っていない（意図的）

`verified-against` を新しい SHA へ上げると「章全体を再検証した」と主張することになる。
本 PR が突き合わせたのは `engine_wrap/` 配下の引用だけで、同じ章が引いている
`session.rs` / `output.rs` は **PR [#896](https://github.com/signalcompose/orbitscore/pull/896)
（`9d39d2e` の直後にマージ）で分割済み**であり未検証である。`f23eb5d` のまま残すのが正しい。

### docs(dev-site): re-anchor the source pointers left behind by the #888 child-3 split (Sep 12, 2026)

**Date**: 2026-09-12 / **ブランチ**: `claude/docs-sync-pr897` / **追従元**: PR [#897](https://github.com/signalcompose/orbitscore/pull/897)（merge `6dcd80bb2086fd6ced22e0c9711a7063e45ee535`）

PR #897 は `orbit-vst3-host/src/lib.rs` / `orbit-plugin-scan/src/lib.rs` /
`orbit-audio-sandbox/src/transport.rs` を分割し、dev サイトの **`// FILE:START-END`
引用ヘッダ 32 件**を移動先へ追随させた。しかし各章末の **`## Sources` / 「Further reading」の
散文ポインタは旧パスのまま**残っていた。

🔴 **`docs:check` はこの取りこぼしを構造的に検出できない。**
`sites/dev/scripts/check-citations.mjs` が突合するのは ```` ```rust ```` ブロック先頭の
`// FILE:START-END` ヘッダだけで、**散文の中のバッククォート付きパスは走査対象外**である。
そのため #897 は `948 citations / 0 failed` で緑のまま、**17 種 34 箇所**（ja / en 対）の
死んだポインタを残せた。

本コミットはその 17 種すべてを移動先へ張り直した（ja / en 対で 8 ファイル・計 34 箇所）:

| 旧 | 新 |
|---|---|
| `transport.rs:79-87`（`EVT_SLOTS`） | `transport/layout.rs:33-41` |
| `transport.rs:265-277`（evt ring / `dirty_epoch`） | `transport/layout.rs:222-234` |
| `transport.rs:359-378`（`ReleaseAcquireSeq`） | `transport/event_ring.rs:37-56` |
| `transport.rs:512-538`（`EventRingChild::service`） | `transport/event_ring.rs:192-218` |
| `transport.rs:1213-1225`（`UiPumpNotification`） | `transport/ui_codec.rs:33-45` |
| `transport.rs:1355-1374`（`UiPumpState`） | `transport/ui_pump.rs:63-82` |
| `transport.rs:113-143,173-288`（`CONTROL_*` / `SharedRegion`） | `transport/layout.rs:67-97,127-239` |
| `transport.rs:2031-2041`（`create_shared`） | `transport/shm.rs:171-186` |
| `plugin-scan/src/lib.rs` 9 件（カタログ型・role 判定・scan dir・dedup・atomic write） | `types.rs` / `dirs.rs` / `clap_scan.rs` / `vst3_scan.rs` / `catalog_io.rs` |

`docs/planning/DEVELOPMENT_MAP.md` の 2 件（`extra_scan_dirs_from_env` の実装位置、
`reset_child_starting` の在処）も同様に張り直した。前者は「`CLAP_PATH` 対応は同じ関数に
1 行並べるだけ」という**着手手順そのもの**を指すポインタで、死んだままだと実装者が迷う。

`verified-against` / `verified-at` は**更新していない**。STYLE_GUIDE §4 の
「小規模 cross-link / 体裁修正のみ: 更新しない（本文内容と code の対応関係に変更がないため）」に
該当する — 純粋な移動なので本文の主張は 1 つも変わっていない。

検証: `npm run docs:build`（user / dev）両方緑 / `npm run docs:check` **948 citations / 0 failed**。
張り直した 17 種は docs:check の対象外なので、`sed -n '<start>p;<end>p'` で各範囲の先頭行・
末尾行を**実ファイルから目視照合**した。

### docs: follow the install-route change into the user site (Sep 12, 2026)

**Date**: 2026-09-12 / **ブランチ**: `claude/docs-sync-pr906`

PR [#906](https://github.com/signalcompose/orbitscore/pull/906)（マージコミット `85f29aa`）の追従。
同 PR で**リリースページが持つ内容が変わった**ため、user site の記述を合わせた。

### 何が食い違ったか

`release.yml` の `--notes-file` が先頭に置くのは、**Assets からの入れ方の 1 行と、正本
（`sites/user/getting-started/installation.md`）へのリンクと、動作環境の注意**である
（`.github/workflows/release.yml:244-264`）。**手順そのものはリリースページに載らない。**

一方 user site の installation 章は、`::: tip` の中で「リリースページを開くと、そのページに
インストール手順も載っています」と書いていた。#906 以前から v4.0.0 で外れていた約束であり、
#906 の後も**手順ではなくリンクが載る**ので、どちらの意味でも成り立たない。

### やったこと

| ファイル | 変更 |
|---|---|
| `sites/user/getting-started/installation.md:33` | tip を「Assets に直接行ける / 先頭に動作環境とこのページへのリンクが置かれる / 手順の正本はこのページ」に書き換え |
| `sites/user/en/getting-started/installation.md:33` | 同内容の英語版（バイリンガル必須） |

### やらなかったこと

- **`docs/user/ja/USER_MANUAL.md:65`** に同じ文が残っているが、この文書は **DEPRECATED で
  「履歴として保持」（#237）**。#906 でも同じ理由で意図的に触れていないため、追従対象から外した
- **`sites/dev/`** — 差分はリリースノートの生成（配布面）であり、dev site の章立て
  （内部構造・評価経路）に該当する節が無い
- **実装・テスト** — 変更なし（本追従はドキュメントのみ）
### docs: fold the four pending docs-sync PRs into one branch (Sep 13, 2026)

**Issue**: #931。bot の docs 同期 PR **4 本**（#923 / #916 / #925 / #915）をまとめて取り込んだ。

#### 🔴 1 本ずつ入れると、入れるたびに残りが衝突し直す

4 本とも `WORK_LOG.md` を触るので、**1 本 main へ入れた瞬間に残り 3 本が衝突する**。
実際 4.1.0 の作業で #927 を入れた直後、4 本が一斉に `CONFLICTING` になった。
1 つの枝で解消すれば、衝突解消もゲートも 1 回で済む。判定は GitHub の
`mergeStateStatus` が `UNKNOWN` を返し続けたので **`git merge-tree --write-tree` で手元実測**した。

#### 🔴 #916 が「黙って」取り込めていなかった

ループで 4 本を merge した時、**#916 だけマージコミットが作られていなかった**。
原因は**サンドボックス**で、#916 は `.claude/hooks/README.md` を触るが、このディレクトリは
**Bash も git も書き込み拒否**される（[[hook-guards-must-check-the-path-not-just-the-branch]]）。
`git merge` はエラーを出していたが、私の `grep -E 'CONFLICT|Merge made'` がその行を落としていた。

**「4 本回した」は根拠にならない。** `git merge-base --is-ancestor <head> HEAD` を
4 本すべてに対して回して初めて分かった。**ループの結果は件数ではなく到達性で検算する。**

#### zsh は未クォート変数を単語分割しない

`U=$(git diff --name-only --diff-filter=U)` を `for f in $U` で回したが、zsh では
**分割されず 1 つの文字列として渡り**、`FileNotFoundError` になった。bash の癖で書いていた。

#### 衝突の解消方針

| 対象 | 方針 |
|---|---|
| `WORK_LOG.md` の新規エントリ同士 | **両側保持**（別の作業の記録なので落とすものが無い） |
| 既にアーカイブ済みの 3 エントリ | **HEAD（空）を採る** — `### ` 見出しの集合演算で本体 × アーカイブの重複 0 を確認 |
| `mcp-and-gated-e2e.md` の Note | HEAD が追従チェーンの上位集合（#917 まで）なので HEAD を採り、#915 固有の分割告知だけ足す |
| アーカイブの索引行 | 両方の説明を統合 |

#### 検査（bot は但し書きを読まない）

#915 の貼り直しは**散文中のファイル参照**で、`docs:check` の対象外（逐語一致するのは
`// file:start-end` の引用ブロックだけ）。**5 件を抜き取って実ファイルと突き合わせ**、
`autoStartConfiguredRustEngine()` / 括弧バランス判定 / `deactivate()` / `EvalMarkBridge` /
`setupErrorHandler` のいずれも正しい位置に着地していることを確認した。

`docs:check` exit 0 / lint exit 0 / `tests/docs` + `tests/repo` 86 passed。
本体が 1,970 行になったので `test: add a file-size ratchet` を 1 件アーカイブへ移した（162 行）。

Closes #931

---

### docs(hooks): follow PR #914 in the hook docs (Sep 13, 2026)

PR [#914](https://github.com/signalcompose/orbitscore/pull/914)（merge commit `7061245`）が
`.claude/hooks/pre-edit-check.sh` の判定を「ブランチ名だけ」から
「ブランチ名 + **編集先が repo 配下か**」に変えたので、フックの挙動を書いている
ドキュメント 2 箇所を実装に追従させた（ドキュメントのみ・実装とテストは変更なし）。

#### 変更内容

- `.claude/hooks/README.md` §1: 「対象外 / 判定できない入力の倒し方」の表を追加。
  plan file（#153）と **repo 外の絶対パス**（#913）が allow、相対パス・`..` を含む絶対パス・
  `file_path` 無しは deny 側へ倒れることを明記。テストの所在（`tests/repo/pre-edit-hook.spec.ts`）も追記
- `CLAUDE.md` "Hook Protection": `pre-edit-check.sh` の説明に「**リポジトリ配下のみ**」を追記

#### 差分外だが同じ節にあった誤り（併せて訂正）

`.claude/hooks/README.md` はブロック方式を **exit 2** と書いていたが、実装は
Issue #119 以降 `permissionDecision: "deny"` の JSON を stdout に出して **exit 0** である
（`.claude/hooks/pre-edit-check.sh:91-92`）。#914 の差分ではないが、書き換えた同じ箇条書きの
中にあったため放置せず訂正した。

#### 追従不要と判断したもの

- `docs/specs-v2/` / `docs/core/INSTRUCTION_ORBITSCORE_DSL.md`: DSL の構文・意味論は無変更
- `sites/user/` / `sites/dev/`: 両サイトとも `pre-edit-check` / Claude Code hooks に言及していない
  （`grep -rl "pre-edit" sites/` が 0 件）。バイリンガル追従の対象も発生しない
- `docs/archive/WORK_LOG_2026-09.md`: #914 が WORK_LOG の行数上限（2,000 行）のために
  退避した既存エントリ。過去ログなので触らない

### docs: record the 4.1.0 follow in the dev-site provenance Notes (Sep 13, 2026)

PR [#928](https://github.com/signalcompose/orbitscore/pull/928)（#926・4.1.0 バンプ）への
docs 追従（実装・テストは変更なし）。

#928 は dev サイト 4 ページ（`orientation/architecture-overview.md` と
`decisions/adr-002-dsl-v3-pivot.md` の ja + en）の**本文の版表記だけ**を 4.1.0 に上げ、
同じページの冒頭 Note は「2026-09-12 に #883（拡張 **4.0.0**）まで追従しました」のままだった。
**本文と来歴注記が同一ファイル内で食い違う**ので、Note に 2026-09-13 の 4.1.0 追従を追記した。

`verified-against` / `verified-at` は**据え置き**。STYLE_GUIDE §4「`verified-against` の更新
ポリシー」では「小規模 cross-link / 体裁修正のみ」は更新しない、であり、版表記の差し替えは
本文と code の対応関係を変えない。2026-09-12 の #883 追従も同じ 4 ページで `56c34c3` /
`2026-09-11` を据え置いており、その前例に合わせた。

🔴 直さず報告（PR 本文へ）:

- **版表記の同期を守らせる仕組みが無い。** #928 の記述（本ログ上方）自身が「4.0.1 でも
  取りこぼして `10d3c7eb` を後から出した」「**2 回連続で同じ形**」と書いているのに、
  `packages/vscode-extension/package.json` の版と doc の版を突合するテストは存在しない
  （`tests/docs/` は `planning-issue-state` と `worklog-size` のみ）。CLAUDE.md の
  「規律を足す時は、同時にそれを守らせる仕組みを足すこと」に対して、仕組みだけが欠けている
- **`CHANGELOG.md` が 1.1.0（2026-05-06）で止まっている。** 2.0.0 / 3.0.0 / 4.0.0 / 4.0.1 /
  4.1.0 のどれも項が無く、`[Unreleased]` は #212 の内容のまま。どの版を遡って書き起こすかは
  リリース判断なので追従作業では決めない

Part of #926

---

### chore(release): bump the extension to 4.1.0 (Sep 13, 2026)

**Issue**: #926。出すのは **#922（振る舞いの修正）** + #918 / #920（テストのみ）。

#### 🔴 なぜ patch ではなく minor か

**patch は「振る舞いが変わらない」の意味**で、それは嘘になる（audio が +3 dB）。
**major でもない** — semver が問うのは**利用者の入力との契約**で、v3.0.0（設定とコマンドが消えた）
v4.0.0（暗黙 master が消えた）と違い、**4.1.0 では譜面を 1 文字も変えなくていい**。
加えて #922 は実質バグ修正（誤って 3 dB 減衰されていた audio を戻した）。
**minor が「聞いて分かる変化はあるが書いたものは壊れない」の信号。**

#### 🔴 版を名乗る箇所は 11 ではなく 12 あった

**最初の列挙は 11 で止まり、`README.md:55` を落とした**（`- **Post-2.0 (shipped on \`main\`,
extension 4.0.1)**` の行）。同じ README の 5 行目は直っていたので、**ファイル単位では
「直した」ように見えていた**。`git diff --stat` が `README.md | 2 +-` と出ているのを
「1 行で足りる」と読んだのが誤り。

パターンの穴はこうだった: 最初の grep は `**4.0.1**`（強調記法）と `"version"` を狙っており、
**地の文に埋まった `extension 4.0.1`** を拾わなかった。数え直しは
`(拡張|extension)[^0-9]{0,14}4\.0\.[0-9]` の双方向パターンで行い、残る 4.0.0 の言及が
**すべて #883 の履歴記述**であることまで確認した。


前回（4.0.1）も取りこぼして `10d3c7eb`「follow the bump into the pages it missed」を
後から出している。**2 回連続で同じ形で落ちた** — 「grep で列挙して件数を固定する」だけでは
足りず、**落ちるのは常にパターンが想定していない書き方の方**である。
内訳は `package.json` 正本 / `CLAUDE.md` / `README.md` **×2** / core spec ×2 /
dev サイト ja+en ×6。設計文書の「4.0.1」は当時の記録なので触っていない。
`ENGINE_VERSION` / `DSL_VERSION` は別軸（設計 656 §4.4）。

#### マージ前ゲート（main `77a17905` で実測）

実機 gated **46 passed / 46（skip 0）** / cold install exit 0 / build / std-gain 実機 3 行 /
CI 4 チェック全 pass。

🔴 **E2E-5 の比率は `× √2` が消えても不動** — `9.999999829984711`（期待 10・誤差 1.7e-8）。
絶対レベルは √2 倍（`0.0867` → `0.1226`）でも比率は動かないことを実測で確認。

#### リリースノートに書くこと

audio が +3 dB / 🔴 **ヘッドルームが 3 dB 減る**（リミッタが無い系なので重ねたミックスは
0 dBFS に近づく）/ pan がフルスケールを超えなくなった / gated が skip 0 の 46 件に。

### docs: follow PR #918 — the self-launching test placement rule, and two WORK_LOG separators (Sep 13, 2026)

PR [#918](https://github.com/signalcompose/orbitscore/pull/918)（マージ `77a1790`）の追従。
実装は触らない（差分は `tests/` と `CLAUDE.md` と WORK_LOG のみ）。

#### 1. 自前アプリのテストの配置規則が CLAUDE.md にしか無かった

元 PR は `launchIsolatedOrbitStudio()` が冒頭で `killHarnessInstances()` を呼ぶため、
自己完結のテストを共有セッションの途中に置くと後続が `ECONNREFUSED` で落ちることを
実測し、spec の境界にコメントを残した（`tests/e2e/orbitstudio-mcp-gated.spec.ts:6550-6553`）。
これはハーネスの不変条件なので、以下へ展開した:

- `docs/testing/E2E_HARNESS_SPEC.md` §3.1（新設）— 共有セッション / 自己完結の 2 種別と順序規則
- `sites/dev/editor/mcp-and-gated-e2e.md` と `sites/dev/en/editor/mcp-and-gated-e2e.md`
  — `killHarnessInstances()` の節の直後に節を 1 つ追加（引用は 6550-6553）。
  `verified-against` を `77a1790` へ、Note の追従先に #917 / #918 を追記

#### 2. WORK_LOG の区切りが 2 箇所崩れていた

| ファイル | 症状 |
|---|---|
| `docs/development/WORK_LOG.md` | #918 のエントリと次のエントリの間に `---` が無く、本文の次の行が `###` 見出しになっていた |
| `docs/archive/WORK_LOG_2026-09.md` | アーカイブへの追記で `---` が 2 連続になっていた |

どちらも他のエントリの形（空行 + `---` + 空行）に揃えた。

#### 検証

`npm run docs:build -w @orbitscore/user-site` / `-w @orbitscore/dev-site` / `npm run docs:check`。

#### 追従しなかったもの（PR 本文に出す）

- `sites/user/getting-started/engine-settings.md:29,33` の「チャンネル = ステレオ（2ch）」/
  「マルチチャンネル出力は未実装」が、同じサイトの `sites/user/mixing/routing.md:115` と
  食い違う。元 PR は 8ch デバイスで ch3/4 に音が出ることを実測しているが、
  この警告文の「マルチチャンネル出力」が DSL の宛先を指すのか設定 UI を指すのかは
  差分から確定できないので、書き換えずに報告に回した


---

### test(e2e): implement E2E-4/E2E-5 against a real >=4ch device (Sep 13, 2026)

owner が Loopback で **`OrbitScore E2E`（8ch）** を作成したので、`#611` O-surface で
唯一 skip されていた `E2E-4 / E2E-5` の本体を書いた。**実機 gated が初めて skip 0 の
46 passed になった**（#917 / #851 B-2）。

#### 固定したもの

| | 期待値 | 実測（4 周） |
|---|---|---|
| **E2E-5** `output(master, thru: true).output("3,4", db: -20)` | ch1/2 : ch3/4 = `10^(20/20)` | **9.999999818**（8 桁一致） |
| **E2E-4** `output(master, thru: false).output(cue)` | 終端の後ろには到達しない | `cutCue` = **厳密に 0** |

8ch あるので **ch5/6 を「誰も宛先にしていない対照」**として使い、E2E-4 の無音を
「小さい」ではなく「**未使用チャンネルと同じ床**」で判定している（4ch デバイスでは飛ばす）。

#### 🔴 Monitors を繋がなくてよいことを実測で確かめた

capture は **cpal へ渡す最終 `hw` を読み取り専用で tap** している
（`orbit-audio-native/src/output/render.rs:56-59`「tap であって mutation ではない」）ので、
デバイスがその先へ流すかに依存しない。クロックも刻む（**first callback 12 ms**）。
→ **BlackHole は不要**（設計 §8.3 の元案）。

#### red-first ではない。変異で代替した

O-surface の実装は v4.0.0 で出荷済みなので「実装前に書いて赤」は成立しない。
代わりに**期待値を壊す変異 2 種**で、この判定が区別できることを確かめた:

| 変異 | 結果 |
|---|---|
| E2E-5 の期待比 `10 → 3` | red（`expected 2.33 to be <= 0.12`） |
| E2E-4 が ch3/4 ではなく **ch1/2 を見る**（off-by-one） | red（`cutCue` が `cutMaster` と同値・`cutLeak = 1`） |

後者が重要で、**DSL は 1 始まり・`channelRms` は 0 始まり**なので取り違えが最も起きやすい。

#### 🔴 自分の誤り 3 つ

1. **配置**: 共有セッションのブロックの真ん中に置いたので、`launchIsolatedOrbitStudio` の
   `killHarnessInstances()` が共有アプリを殺し、後続の `#606 T1` / `E2E-K3` が
   `ECONNREFUSED` で落ちた。自前アプリ群の側へ移し、**境界にコメントを残した**
2. **後始末**: `fs.rmSync` を裸で呼んでいて `ENOTEMPTY` で 2 周続けて赤くなった
   （アサーションは全部通っていた）。**既に `removeHarnessTree` が
   kill → 終了待ち → best-effort 削除を持っていた**ので、手書きをやめてそれを使った
3. **Spotlight を索引中だと誤断**した。CPU は 0.0〜0.1% で、12 日間常駐していただけ。
   **メモリ使用量だけを見て動いていると推測した**のが誤り

#### 実機ゲートが 2 回メモリ不足で kill された

`claude` プロセスが **89 個 / 5.28GB**（11 日 23 時間動く `--resume` が 17 個）積み上がり、
free が 0.1GB まで落ちていた（swap は 0）。owner の許可を得て自分以外の **47 セッション**を停止し、
free 0.2GB → **8.5GB**。その後 1 周で全件緑。

#### 🔴 `-t` の限界を CLAUDE.md に足した

`-t 'E2E-4/E2E-5'` は 2 分で回る（自己完結テストなので）。**だが `-t` は
「そのテストが後続を壊すこと」を原理的に検出できない** — 上の誤り 1 は単独実行では
**自分だけ緑**になる。**開発は `-t`、影響の確認とマージ前ゲートは全件**。

### docs: follow the attenuate-only pan ruling into the specs and both sites (Sep 13, 2026)

PR [#922](https://github.com/signalcompose/orbitscore/pull/922)（#921 / `#851` B-3 の裁定 D′）へ
docs を追従（実装・テストは変更なし）。`docs/core/INSTRUCTION_ORBITSCORE_DSL.md` MX.4 に
「pan 則の改訂」を追記し、dev サイト SC-2 / RE-1 / RE-3 と user サイト `methods.md`（ja + en）を
`balance_pan`（中央素通り・端 `(1, 0)`）へ更新。audio が
+3 dB になる破壊的変更と `gain(-3)` の回避策を user 側に明記した。RE-1 の capture peak `0.70711` は「#921 より前の値・要再測定」と注記するに留めた（実機で測っていないため）。

🔴 **`docs/user/{ja,en}/USER_MANUAL.md` は追従させない**（main が bot の変更から落とした）。
両ファイルは冒頭で **`⚠️ DEPRECATED（非推奨・2.0.0 時点）… 本ファイルは履歴として保持しています（#237）`**
と宣言している。**履歴として凍結してあるものを現在の仕様へ更新すると、凍結の意味が消える**。
同じ判断は 2026-09-11 の「`USER_MANUAL.md` を直さない」（本ログ下方）と一致する。

🔴 SC-2 `Pan` 節のコードブロック 2 つが `line_pan_coefficients` を説明しながら `bus_topology.rs:226-229`（`channel_egress_active`）を引用していた誤りも直した。逐語一致なので `docs:check` は緑のまま通っていた — **引用チェッカは「正しい関数を引用しているか」を見ない**。

🔴 直さず報告: `INSTRUCTION_ORBITSCORE_DSL.md:1771`「`pan(random)` は発音側のまま」と #922 の前提「`event.pan` は本番コードで一度も設定されない」が食い違う（`packages/engine/src/core/sequence/scheduling/event-scheduler.ts:125`）。仕様判断なので追従作業では決めない。

### docs: record the #920 doc-sync audit (no spec follow-up needed) (Sep 13, 2026)

[#920](https://github.com/signalcompose/orbitscore/pull/920)（merge `59511c9`）の追従監査。
差分は `scheduler.rs` の `mod tests` 内テスト 1 本と #920 自身の WORK_LOG entry だけで、
**振る舞いを 1 行も変えていない**ため spec / site の追従は不要。`docs:check` 982 引用 0 失敗。

🔴 #920 が固定した「端で +3 dB」は **20 分後の #922（裁定 D′）が置き換えた**ので、
仕様文書へ書き写していない。書けば main と食い違う記述を新規に作ることになる。

追従できなかった点（E2E の穴・`docs/core/INSTRUCTION_ORBITSCORE_DSL.md:1992` の旧法則残存・
E2E-P の比のみアサーション）は **PR 本文に path:line 付きで列挙した**。E2E と baseline は触っていない。



---

### feat(audio)!: make both pan stages attenuate-only so panning can never clip (Sep 13, 2026)

`#851` B-3 の owner 裁定 **D′**（#921）。**発音側とライン側の両方**を減衰のみの
`balance_pan`（中央は素通り・端で持ち上げない）へ揃えた。

#### 🔴 調査で前提が覆った

裁定の選択肢は当初 A（現状維持）/ B（feed にも発音側 pan）/ C（DAW の pan 流儀）だったが、
**`event.pan` が本番コードで一度も設定されない**ことが分かって前提が変わった
（DSL の `pan` は wire 上 `BusLineOp::Pan` = ライン側へ行く・`session/params.rs:141`）。

つまり発音側の `equal_power_pan(event.pan)` は**定位ではなく、全 audio への固定 −3 dB**。
その結果:

- **audio は instrument feed より常時 3 dB 小さかった**（pan の有無に無関係）
- ライン側の `× √2` は「audio を戻す補正」として働き、**発音側を通らない feed だけを
  +3 dB へ押し上げて**いた

🔴 **一度 D（ライン側だけ減衰のみにする）を推奨して、実装前に撤回した。**
`dsp.rs` の doc コメントが `Do not remove the factor as "double compensation"` と
明示しており、発音側との合成を見ていなかった。**ライン側だけ変えると audio が端で
0.707 になって壊れる。** 発音側と対にして初めて成立する（それが D′）。

#### なぜ持ち上げをやめたか

🔴 **この系にはリミッタもクランプも無い**（実測）。`limiter()` / `compressor()` /
`normalizer()` は #502 で実装ごと消滅し代替経路が無く、float 出力にクランプも無い
（クランプは i16/i32/u16 変換時のみ）。**1.0 超はそのままデバイスへ行く。**
加えてライン Pan は**バランス**で、端へ振ると片チャンネルの中身を実際に捨てている。
`× √2` は**存在しないエネルギーを足していた**。

#### 旧則を固定していたテストは 16 件。うち pan のテストは 2 件だけだった

残る 14 件は `render_block_one_bus_applies_effect_then_sums` のような**合成・配線**のテストで、
期待値の式に `√0.5` が埋まっていた:

```
// center pan の equal-power gain は √0.5。tagged=2.0×√0.5×0.5、untagged=3.0×√0.5
```

**全 audio が一律に減衰されていたせいで、無関係なテストの算術にまで係数が漏れていた。**
これが「pan の設計判断ではなく audio 全体のレベルの問題だった」ことの裏づけになった。

🔴 置換は**網羅を確認してから**行った（18 箇所を grep で列挙し、期待件数を `assert` で固定）。
目的が「係数」でないテスト（channel stride / global gain）は、係数を落としても
**目的が残っているか**を見てから直した。

#### 実機の実測が予測と厳密に一致した

旧実測 `0.08701663` → 新実測 **`0.12306010509914503`**。比は **1.41421356 = √2**。
3 回の実測が 11 桁一致し、`noBus` と `sumOutput` も一致した（同じ信号が同じ経路を通るので
一致するのが正しい。旧 golden では 0.03% ずれていた）。

🔴 **旧 golden `0.0846173` は実測より 2.8% 低い緩い基準だった**（許容 12% に収まるので
誰も気づかない）。今回は実測値を根拠に置き換えたので基準が締まった。

#### 🔴 TS 側のユニットテストは 1 件も動かなかった

audio の絶対レベルが変わる変更なのに `npm test` 2,497 件が全部通った。
**この層を守っているのは E2E の golden だけ**である。

#### 補正機能は作らない

`.gain(db)` で書けるため。🔴 ただし **pan をスイープさせる時は補正量が位置で変わる**ので
`.gain()` では追随できない。必要になったら `global.panLaw()` を検討する。

#### 検証

`cargo test --workspace` 97 suite 緑 / fmt / clippy / cfg 4 象限 緑 /
`npm test` 2,497 passed / lint / `typecheck:e2e` 緑 / `docs:check` 982 引用 0 失敗 /
実機 gated **45 passed**（残る 1 件は E2E-4/E2E-5 の `unimplemented`。実装は PR #918 側で
このブランチには無い）。

---

### test(core): pin the instrument-feed vs centered-event pan asymmetry (Sep 13, 2026)

`#851` B-3 の裁定材料。**裁定そのものは owner**（#919）。

#### 🔴 まず訂正: 「未検証」は不正確だった

`#851` に「B-3 はまだ事実かは未検証」と書いたが、**「端で +3 dB」自体は cargo test が
既に固定していた**（`orbit-audio-native/src/output/startup.rs:2590` の `hard_left = SQRT_2`）。

未検証だったのは「**instrument feed が発音側の pan を通らない**」という**非対称の方**である。

#### 一次ソースで確認した事実

`render_multi_feeds` は feed を `*dst += *sample` と**素のまま加算**しており、
`equal_power_pan` を一切通らない。一方 audio event は通る（中央 0.707）。

| 素材 | 発音側 | ライン pan（端） | 着地 |
|---|---|---|---|
| audio event | 0.707（`equal_power_pan(0)`） | × √2 | **1.0 = unity** |
| instrument feed | **1.0（素通り）** | × √2 | **1.414 = +3 dB** |

#### 数値で固定した

`orbit-audio-core` に、**両者を同じ条件に並べて測る**テストを足した。
実測 `centered event = 0.70710677` / `feed = 1.0` / `ratio = √2`。

🔴 **`equal_power_pan(0) * SQRT_2` の掛け算では済ませていない。** それでは
**feed の経路を一度も通らない**ので、あとで誰かが feed にも発音側 pan を掛けても
緑のまま通る。`render_multi_feeds` を実際に走らせている。

変異 2 種で確認:

| 変異 | 結果 |
|---|---|
| feed にも発音側 pan を掛ける（= 非対称を解消する変更） | red（`feed must pass through unattenuated; actual=0.70710677`） |
| `equal_power_pan` を `(1,1)` にする | red（`centered event must be 1/sqrt(2); actual=1`） |

#### 🔴 未コミットのまま変異を当てて、新テストを消した

`git checkout -- <file>` で変異を戻そうとしたが、**テスト自体が未コミットだったので
一緒に消えた**。書き直して**先にコミットしてから**変異を当て直した。
memory `mutation-backup-must-use-tmpdir` は「コミット済みなら `git checkout --` が確実」と
書いているが、**その前提（コミット済み）を自分で満たしていなかった**。

#### 裁定に残る事実

**+3 dB は事実だが「クリップする」かは素材の振幅次第**（ピーク 0.708 超で 1.0 を超える）。
その先のリミッタ/飽和は未確認。選択肢 A（現状維持）/ B（feed にも発音側 pan）/
C（ライン pan の正規化を外す）と実測値は **`#851` のコメント**に整理した。
**B と C はどちらも既存の譜面の音を変える。**

---

### fix(hooks): let pre-edit-check.sh allow writes outside the repo on main (Sep 13, 2026)

owner 指摘:

> メモリ書くためだけにブランチ作るの良くないのでmainからでもメモリは書けるように出来んの？

#### 何が問題だったか

`.claude/hooks/pre-edit-check.sh` は `main` にいる時 Edit / Write を一律に deny していた。
判定は**ブランチ名だけ**で、**編集先のパスを見ていなかった**
（例外は `*/.claude/plans/*` のホワイトリスト 1 件）。

そのため**リポジトリの外**（`~/.claude/projects/<project>/memory/` / scratchpad / `~/.cvi`）も
巻き込まれ、**memory を 1 ファイル書くためだけに差分 0 のブランチを作って消す**という
運用が発生した（本日実際にやった）。

**このフックが守っているのは「main に直接実装を積まない」こと**で、repo の外は保護対象ではない。

#### 直し方

**リポジトリ外の絶対パスを一律に対象外にする。** 個別ホワイトリストは増やさない
（次に別の外部パスで同じことが起きる）。判定は「repo 配下かどうか」の 1 本。

**安全側の倒し方**: 相対パスは repo 相対なので repo 内扱い。
`..` を含む絶対パスは解決せず repo 内扱い（fail closed）。`file_path` 無しも deny へ落ちる。

#### 🔴 最初に書いたテストが 2 回続けて何も検査していなかった

**1 回目**: 「今 main にいるなら検査する」形にしたので、**feature ブランチと CI では
主要な検査が全部 skip され、空で緑**になった（memory `a-test-that-exists-may-never-run`）。
→ 使い捨ての git repo を 2 つ作り、HEAD を `main` / `1-feature` に固定して
`CLAUDE_PROJECT_DIR` で指す形に変えた。どのブランチから走らせても同じ判定を検査できる。

**2 回目**: fail-closed の検査に `${REPO}/../evil.ts` を使っていたが、これは
`"$PROJECT_DIR"/*` のグロブに `../evil.ts` が一致するので **`*..*` ガードが無くても deny** =
何も検査していなかった。**変異を当てて緑のまま通ったので判明した。**
→ **prefix から外れて `..` で repo 内へ戻る**形（`${REPO}-decoy/../${basename}/secret.ts`）に変えた。
これは `*..*` ガードが無いと allow に倒れるが、実際には repo 内へ着地する。

#### 変異検証（3 種・実出力を確認）

| 変異 | 結果 |
|---|---|
| `*..*` の fail-closed を外す | red（「判定できない入力は deny」が `expected 'allow' to be 'deny'`） |
| repo 内/外の判定を反転 | red（「repo 外は allow」と「repo 内は deny」の**両方**） |
| ガードを丸ごと無効化 | red（「repo 外は allow」） |

restore 後はいずれも 6 passed。

🔴 **`.claude/hooks/` は Bash の sandbox 書き込み拒否対象**なので、変異は Edit ツールで当てた。
最初は `python3` / `cp` で当てようとして**3 回とも書き込みが失敗しており、
「6 passed」は何も証明していなかった**（`git diff --stat` が無変更だったので気づいた）。

Closes #913

---

### docs(dev-site): re-anchor the extension-split file references and record the new module layout (Sep 13, 2026)

PR [#909](https://github.com/signalcompose/orbitscore/pull/909)（#887・`extension.ts` /
`mcp-server.ts` の 19 モジュール分割、マージコミット `ca745e8`）への**ドキュメント追従のみ**。
`packages/` と `rust/` とテストは 1 行も触っていない。

#### 何を直したか

dev 学習サイトの散文にある `extension.ts` / `mcp-server.ts` への行参照を、分割後の位置へ
付け替えた（ja / en 同時・合計 160 参照）。

- 範囲付き参照（`<file>:<a>-<b>`）: **110 件のうち 96 件**を再アンカー
- 基底名だけの参照（`` `extension.ts:3405` `` 等）: **62 件**を再アンカー
- `sites/dev/editor/vscode-architecture.md` の drift 節に、**分割の対応表**（主題 → 分割後の
  ファイル）と MCP `tools/list` の順序復帰（`8561210`）を追記
- 誤った地の文 2 件を修正: 「候補の組み立ては `extension.ts` 側」→ `dsl-providers.ts`、
  `EngineViewProvider` (`extension.ts` 側) → `engine-view-provider.ts`

#### 🔴 参照は分割より前から既に腐っていた

再アンカーの方法として、まず**分割前の `extension.ts` のその行範囲の中身**を新モジュール群から
内容一致で探した。**54 組中 17 組しか一致しなかった。**

原因は、**分割より前の時点で散文の行番号が既にずれていたこと**である。実測（`0f930f3` =
マージ直前の main）:

| 散文が指していた範囲 | 実際にそこに在ったもの | 記述 |
|---|---|---|
| `extension.ts:286-498` | `if (playheadActiveRanges.size > 0) {` | `activate()` 全体 |
| `extension.ts:500-521` | `decorationType.dispose()` | `deactivate()`（実際は 489 行目） |
| `extension.ts:2044-2198` | `globalInitialized = false` | `startEngine()`（実際は 1927 行目） |
| `extension.ts:3716-3726` | `function registerHoverProvider(` | カタログ不在の案内 |

**「範囲内」は「正しい」を意味しない**（#911 が同じ指摘をしている）。したがって内容一致では
引けず、**箇条書きが明示しているシンボル名で引き直した** — 各シンボルの定義位置を現在の
ツリーで読んで範囲を確定させている。

#### 直していないもの

- **#502 で削除された関数を指す 14 件**（`getConfiguredEngineKind()` /
  `resolveScsynthForUI()` / `startEngine()` の `sc` 分岐 / `bundleStatusItem` の engine kind
  コメント）。`sites/dev/decisions/adr-003-scsynth-bundle.md` と
  `sites/dev/editor/vscode-architecture.md:1066` に在る。**指す先が存在しない**ので範囲の
  付け替えでは直らず、箇条書きの文章そのものを書き換える判断が要る（#911 の 3 番）
- **`check-citations.mjs` に散文の範囲外検査を足すこと**（#911 の 1 番・本体）。仕組みの追加は
  テスト / スクリプトの変更なので、この追従 PR の範囲外


### docs(extension): fix a comment that the split itself made false, and record the split rationale (Sep 13, 2026)

`/code:peer-review-team` の comment-analyzer が出した 2 件。**コメントのみの変更**で、
差分にコメント行以外の追加 / 削除が 1 件も無いことを機械的に確認した。

#### 🔴 同じ PR 内で偽になったコメント

`docs-panels.ts` の `resolveDevDocsUrl` の doc が「`mcp-server.ts` の `DOCS_PUBLIC_BASE`」と
書いていたが、**定義元は `mcp-docs.ts:12`** で `mcp-server.ts` は再輸出しているだけ。

このコメントは `docs-panels.ts` を作った束 C（`9143a233`）の時点では**正しかった**。
束 F（`d8bda308`）で `mcp-docs.ts` を新設して定義元が移った時に、
**この横参照だけが追随しなかった。**

**束をまたいだ相互参照は自動では追随しない。** import なら型チェッカが捕まえるが、
**地の文の参照は誰も見ていない。**

#### 新設 19 モジュールのうち doc の無かった 6 本に module doc を足した

`mcp-sdk` / `mcp-types` / `mcp-docs` / `mcp-tools-engine` / `mcp-tools-editor` / `mcp-tools-plugins`。

🔴 **comment-analyzer の「他 16 ファイルには必ずある」は不正確だった** — doc が無いのは
40 ファイル中 12 件で、`completion-context.ts` / `plugin-state-bridge.ts` 等**分割前から
無いもの**も含まれる。「3 ファイルが普遍的な規約を破っている」わけではない。

ただし**設計 D5 の分割意図がコード側に一切残っていなかった**のは事実なので、
6 本に足した。特に `mcp-tools-*` には **`tools/list` の順序の制約**を書いた
（これが今日の退行の原因だった）。

#### 検証

差分がコメントのみ（機械確認）/ `npm test` 2,491 passed / lint 緑 / `tsc --noEmit` 緑 /
`typecheck:e2e` 緑 / `docs:check` 982 引用 0 失敗 / リポジトリのラチェット 64 passed。

**実機 gated は再実行していない。** コメントは出荷物の振る舞いに届かないので、
先の全件緑（`45 passed | 1 skipped`・`ratio 1.000015`）が有効なままである。

---

### fix(mcp): restore the tool registration order the split had changed (Sep 13, 2026)

Fable 監査が、Sonnet レビュアー 8 体が全員通した後に **MCP ツール一覧の順序の変化**を検出した。

#### 何が起きていたか

分割前の `mcp-server.ts` は docs 系 3 本（`get_dev_doc` / `search_dev_docs` /
`register_mcp_server`）を **plugin 系 6 本より後ろ**（23–25 番）に登録していた。
束 F で `registerEditorTools` に docs 系を含めたため、**17–19 番へ繰り上がり、
plugin 系 6 本が 3 つ後ろへずれた。**

MCP SDK の `tools/list` は `Object.entries(this._registeredTools)` を返す
= **登録順がそのまま一覧の順序**なので、これは**クライアントに見える観測可能な変化**である。

#### 🔴 なぜ 8 体が見落としたか — done 条件の検証コマンドが条件を見ていなかった

設計 §7.7 の done 条件は「25 本・**順序も**同一」と書いていたが、
指定していた検証コマンドが

```
grep -oE "'[a-z_]+'" | sort
```

で、**`| sort` が順序の情報を消していた。** レビュアーも私も Codex も
「集合が diff ゼロ」までしか確かめておらず、**順序は誰も見ていなかった**
（「列挙は一段手前で止まる」の形）。

**done 条件を書く時は、それを検査するコマンドが本当にその条件を見ているかを確かめること。**

#### 直し方

`registerDocsTools(server, handlers, docsSourceRoot)` を `mcp-tools-editor.ts` 内に切り出し、
`buildServer` を **engine → editor → plugins → docs** の 4 呼び出しにした。
これが分割前の 25 本の順序を再現する唯一の並びである。
副作用として `registerEditorTools` から `docsSourceRoot` が外れ、署名が揃った。

**恒久対策**: `mcp-server.spec.ts` に `tools/list keeps the exact registration order` を追加。
実サーバを立てて `tools/list` を叩き、順序を配列で固定する。
退行を再現する変異（docs を plugins の前へ）で red を確認済み。

#### 同時に直した 1 件

`extension.ts` の export が 27 → 28 に増えていた（`export type { EngineViewProvider }` を
分割時に足していた）。葉の `extension-state.ts` が根から型を取る形は設計が棄却した向きなので、
本籍の `engine-view-provider.ts` から取るようにし、根の型 re-export を落とした。
**main と HEAD の export 集合が完全一致（対称差が空）** になった。

#### 🔴 自分の件数主張が誤っていた

PR 本文と束 A のコミットに書いた「**31 箇所の代入を setter 化**」は再現できない。
実測は main の直接代入 **37 件** / HEAD の setter 呼び出し **32 件**。
設計 §14 の「件数の主張を書かない。何を変えたかを書く」に従い、
**数値を別の数値に差し替えず、主張自体を落とす**。

#### 別 issue に切り出した 1 件

散文の `## Sources` 参照 **110 件が存在しない行を指すようになった**（#911）。
`docs:check` はコードブロックのヘッダ引用しか見ないため、**982 件が緑のまま**起きていた。
108 件はこの分割が壊したもの。「振る舞い不変の分割」と「#887 より前から在る腐りの修復」を
同じ束に混ぜると双方の検算ができなくなるので分けた（`BUNDLE_BRANCH_WORKFLOW.md` §5.1）。

#### 検証

`npm test` 2,491 passed（既存の期待値は 1 つも変えていない）/ lint 緑 /
`tsc --noEmit` 緑 / `typecheck:e2e` 緑 / `docs:check` 982 引用 0 失敗 /
ファイルサイズのラチェット 64 passed。

---

### fix(extension): remove a docblock that was copy-pasted from extension.ts, and mechanize the check (Sep 12, 2026)

`/simplify` のラウンド 1（4 観点並行）で見つかった 1 件を直し、同じ欠陥クラスを機械化した。

#### 何が起きていたか

`diagnostics-provider.ts` と `dsl-providers.ts` に、**`extension.ts` を説明する docblock が
そのまま複製**されていた。死んだ `// import * as os from 'os'` 行まで一緒に付いてきていた。

どちらのファイルにも**正しいファイル固有の doc が先頭に既にある**ので、複製は 2 つ目に居た。
先頭が正しいと、人は 2 つ目を読み飛ばす。

`// import * as os from 'os'` は main の `extension.ts:6` に元からあったもので、
`extension.ts` 側は触っていない（この PR の持ち込みではない）。
複製された 2 ファイルは**この PR で新規追加**したので、両方とも分割作業でのコピペである。

#### 🔴 最初に書いた検査は何も見ていなかった

`module-doc-purity.spec.ts` に足した最初の版は**先頭の doc ブロックだけ**を見ていた。
複製は 2 つ目に居るので、**実際の欠陥を戻す変異を当てても緑のまま通った**。
「新しいテストが緑」は「そのテストが何かを検査している」証明にならない
（memory `test-assertions-must-discriminate` の 3 回目）。

書き直して**ファイル内のすべての doc ブロック**を対象にし、変異 3 種で red を確認した:

| 変異 | 結果 |
|---|---|
| TS 間のコピペ（実際に起きた欠陥を戻す） | red・両ファイルを名指し |
| baseline の組を解消して表から消さない | red（厳密等価の向き） |
| 無関係な Rust 2 ファイル間のコピペ | red・両ファイルを名指し |

#### baseline は 2 組

364 ファイル / 1,355 ブロックを走査して衝突は 2 件だけで、どちらも effect / instrument の
並行実装（同じ構造の同じフィールドに同じ説明）という正当なもの。`KNOWN_SHARED_DOCS` に明示した。
**厳密等価**にしてあるので、解消したら表から消さないと red になる。

#### 引用の追随

2 ファイルから 8 行 / 7 行を削ったので、引用 20 件が落ちた。`--fix` の後、
**start と end が同じだけ動いたこと**（範囲の長さが変わった引用 0 件）と、
**オフセットが実際の削除行数と一致すること**（−8 が 12 件 / −7 が 8 件・ファイル単位で一意）を
検算した。`--fix` が別ブロックへ着地した形は排除できている。

#### `__*ForTest` は減っていない（実測）

#887 本文が「何が実際に困るか」として挙げたテスト専用の裏口は、
**分割前 13 本 → 分割後 13 本で 1 本も減っていない**（本文の「14 本」は末尾が `...` の概数）。
裏口を外すにはテストを書き直す必要があり、それは「既存テストの期待値を 1 つも変えていない」
という #887 の検算そのものを壊す。**分割では解消しない**ことを記録しておく。

#### 検証

`npm test` 2,490 passed（2,488 + 新規 2 件・**既存の期待値は 1 つも変えていない**）/
lint 緑 / `tsc --noEmit` 緑 / `docs:check` 982 引用 0 失敗。

---

### refactor(extension): split mcp-server.ts — the TS split is complete (Sep 12, 2026)

**Date**: 2026-09-12 / **ブランチ**: `887-extension-split`

#887 の**束 F（最終）**。**`packages/vscode-extension/src/` の全ファイルが 500 コード行以下**に
なった（超過 **0 件**）。

| ファイル | コード行 |
|---|---|
| `mcp-server.ts` | 1,161 → **271** |
| `mcp-tools-editor.ts` | 251 |
| `mcp-tools-plugins.ts` | 217 |
| `mcp-types.ts` | 148 |
| `mcp-tools-engine.ts` | 140 |
| `mcp-docs.ts` | 129 |
| `mcp-sdk.ts` | 96 |

### `buildServer` は 616 コード行の単一関数だった

ファイルを分けても 1 つの式なので閾値を満たせない。`session.rs` の `handle_command`
（1,028 行の単一 `match`）と同じ問題で、**owner 裁定（#888 子 2）に倣い中身を引数付きの
`register*Tools` へ切った**。`registerTool` の本文はインデントも含めて不変。

Codex が **ツール名 25 本の一覧が diff ゼロ**であること、および条件付き登録の 3 群
（`save_plugin_state` / `open_plugin_ui`・`close_plugin_ui` / `register_mcp_server`）の
述語が byte 単位で一致することを確認した。

### #887 全体の成果

| ファイル | 前 | 後 |
|---|---|---|
| `extension.ts` | 2,779 | **301**（89% 削減） |
| `mcp-server.ts` | 1,161 | **271**（77% 削減） |

新設 **19 モジュール**。ラチェットの baseline は 19 → **17 件**（`packages/vscode-extension/src/`
からは 1 件も残っていない）。

🔴 **`npm test` は 7 束すべてで 2,488 passed。既存テストの期待値の変更は 0 件。**
これが分割の検算そのものである。

### 引用と散文

引用は束ごとに壊れ、合計 **約 300 件**を直した。手順は
`--fix`（行番号）→ 本文一致で再アンカー → 本文をソースから再生成、の 3 段。

🔴 **散文の帰属は 4 束連続で腐っていた**（`extension.ts` の…と書いてあるものが別モジュールへ移った）。
`docs:check` は行が合っているかしか見ない。束 F では `buildServer` の `registerTool` 群と
docs 配信部の帰属を直した。

### refactor(extension): extension.ts is under 500 code lines (Sep 12, 2026)

**Date**: 2026-09-12 / **ブランチ**: `887-extension-split`

#887 の**束 E**。**`extension.ts` が 2,779 → 301 コード行（89% 削減）**になり、
ラチェットの baseline から外れた。

| 新設 | コード行 |
|---|---|
| `dsl-providers.ts` | **302**（補完・quick fix・hover の登録） |
| `diagnostics-provider.ts` | **127**（`updateDiagnostics`） |

`extension.ts` に残ったのは `activate` / `deactivate` / `showCommands` / `restartEngine` /
`reloadWindow` / `isTransportCommand` と、import・再輸出ブロックだけ。

### 🔴 この束は main が直接やった

Codex の発注が sandbox の `EPERM`（companion のログ書き込み）で**起動しなかった**
（memory `codex-rescue-sandbox-broker-gotcha`）。残りが小さかったので main が実装した
（CLAUDE.md「4 ラウンド目は main が直す」の一般化）。

### 🔴 import は「推測」せず「引き写す」

新モジュールに import を**自分で書こうとして名前を 5 つ外した**
（`detectPitchScopeContext` / `detectPlayArgContext` / `detectOutputArgContext` /
`detectEffectArgContext` / `analyzeMissingOutput` の受け方）。

そこで**束 E 前の `extension.ts` の import 群 111 行をそのまま引き写し**、
未使用分を `eslint --format json` の指摘で機械的に刈る方式へ切り替えた。**推測が 0 になった。**
残った型エラー 2 件（`registerHoverProvider` / `updateDiagnostics` に `export` が必要）も
コンパイラが名指ししたものだけを直した。

### 散文参照は「範囲を保てない限り動かさない」

束 D で範囲を 1 点に潰した失敗を踏まえ、**束 E 前の内容と一致した場合のみ**移す実装にした。
今回は 12 件すべて一致せず（散文の行番号がもっと古い版を指している）、**据え置いた**。
壊すより据え置く方が良い。

### 検証

`npm test` **2,488 passed**（6 束連続で不変・**既存テストの期待値の変更 0 件**）/
`npm run lint` / `npm run typecheck:e2e` / `npm run build` / `npm run docs:check` 982 引用 /
`dsl-completion-provider.spec` 15 passed / `output-code-action.spec` 1 passed /
`public-surface.spec` 38 passed（設計 §7.6 の done 条件）。

**残るは `mcp-server.ts`（1,161）= 束 F。**

### refactor(extension): move evaluation and agent handlers out of extension.ts (Sep 12, 2026)

**Date**: 2026-09-12 / **ブランチ**: `887-extension-split`

#887 の**束 D**。純粋な移動。

| 新設 | コード行 |
|---|---|
| `agent-handlers.ts` | **392**（`*ForAgent` 17 本 + `__pluginUiForAgentForTest`） |
| `run-selection.ts` | **152** |
| `mcp-register-command.ts` | **152** |
| `plugin-commands.ts` | **127** |

`extension.ts` は 1,461 → **715** コード行（開始時 2,779 の **26%**。目標 500 まであと 215）。

Codex は全 10 塊を `9143a233` と **verbatim 一致**で照合し、27 export の維持も確認している。
`activate().handlers` のオブジェクトリテラルは byte-for-byte 不変。

### 🔴 Codex に `npm test` の全件を頼んだのが間違いだった（束 0〜C）

束 C の Codex が構造的な事実を報告した:

```
Error: listen EPERM: operation not permitted 127.0.0.1:<port>
Tests  107 failed | 2381 passed
```

**sandbox が loopback の listen を禁じるので、localhost を使う 4 スイート（107 テスト）は
原理的に走らない。** CLAUDE.md が「Codex は sandbox で daemon protocol（localhost bind）・
MCP 系・実機 E2E が原理的に走らない」と明記しているとおりで、**私が読んでいたはずのこと**。

束 B / C の Codex はどちらも「2,488 passed は自分の出力ではない」と明記して報告を拒んだ。
**正しい態度である。** 束 D からブリーフを focused な spec だけに変えたところ、
**衝突なしで完走した。**

### 🔴 散文の参照は「範囲を潰さずに」直す

散文中に `extension.ts:3000-3032` のような**行範囲つきの参照**が 12 件あり、これは引用 header
ではないので `docs:check` が一切見ない。機械的に「関数の定義行 1 点」へ置き換えたところ
`3000-3032` → `592` のように**範囲が潰れた**。**劣化なので取り消した。**

取り消しに `git checkout -- sites/dev` を使って**引用の再アンカーまで巻き戻し**、やり直した。
さらにその過程で `extension.ts:654-654`（`} else {` の 1 行）という**潰れた引用**を作ってしまい、
元の 50 行（`run-selection.ts:63-112`）へ復元した。

**範囲を保って移せた 2 件だけを移し、残り 10 件は据え置いた。** 内容が一致しないものを
機械で動かすと、今回のように壊す。

### 検証

`npm test` **2,488 passed**（5 束連続で不変・**既存テストの期待値の変更 0 件**）/
`npm run lint` / `npm run typecheck:e2e` / `npm run build` / `npm run docs:check` 982 引用 /
`public-surface.spec` 38 passed / `start-engine-for-agent.spec` 4 passed。

### refactor(extension): move view, docs and flash out of extension.ts (Sep 12, 2026)

**Date**: 2026-09-12 / **ブランチ**: `887-extension-split`

#887 の**束 C**。純粋な移動。

| 新設 | コード行 |
|---|---|
| `engine-view-provider.ts` | **243** |
| `flash-config.ts` | **222** |
| `docs-panels.ts` | **104** |

`extension.ts` は 1,991 → **1,461** コード行（開始時 2,779 の **53%**）。

🔴 既存の `engine-view.ts` へは入れていない。あれは header で「vscode 非依存」を宣言した
純モジュールで、vscode に触る配線は**対になる新ファイル**へ置く（設計 §4.1 / D4）。

### 🔴 引用が緑でも散文は検査されない（3 回目）

`vscode-architecture.md` が「`engine-view.ts` の純関数がノードを組み立て、**`extension.ts` の**
`EngineViewProvider` がそれを `vscode.TreeItem` に写します」と書いていた。ja/en とも直した。

**3 束連続で同じ形の腐りが出ている**（束 A: 行数と状態の置き場所 / 束 B: stdout ルータの帰属 /
束 C: `EngineViewProvider` の帰属）。`docs:check` は**行が合っているか**しか見ないので、
**移した関数名で散文を横断検索する**のを各束の手順に入れている。

### 🔴 委譲先と同じツリーで作業して衝突させた（main の運用ミス）

束 B の Codex が正直に報告した: 検証中に main（私）が `npm test` を並走させ、さらに
コミットまでしたため、**Codex は一度も全テストを完走できなかった**（exit 130 で停止）。
Codex は「2,488 passed は自分の出力ではない」と明記して報告を拒んでいる。**正しい態度である。**

memory `delegate-work-needs-its-own-worktree` がそのまま当たっている。
検証は main の仕事なので結果に影響は無いが、**委譲先の時間を無駄にした**。
以後の束では、ブリーフから「全テストを回す」を外し、**focused な spec だけを求める**。

なお Codex は **AST 比較で 26 関数すべての本文が IDENTICAL** であることを確認しており、
これは main の residual 分類より強い証拠である。

### 検証

`npm test` **2,488 passed**（4 束連続で不変・**既存テストの期待値の変更 0 件**）/
`npm run lint` / `npm run typecheck:e2e` / `npm run build` / `npm run docs:check` 982 引用 /
`engine-command-awaits.spec` 10 passed（設計 §7.4 の追加 done）/ `public-surface.spec` 38 passed。

### refactor(extension): move the engine wiring out of extension.ts (Sep 12, 2026)

**Date**: 2026-09-12 / **ブランチ**: `887-extension-split`

#887 の**束 B**。束 A で代入を setter に替えたので、ここは**純粋な移動**。

| 新設 | コード行 | 中身 |
|---|---|---|
| `engine-handlers.ts` | **321** | stdout / stderr / exit / error のハンドラ 9 本 |
| `engine-process.ts` | **423** | engine パス解決・`startEngine` / `stopEngine` / `toggleEngine` ほか 11 本 |

`extension.ts` は 2,662 → **1,991** コード行。

### 🔴 `engine-lifecycle.ts` へ戻さなかったことが、テストで証明された

issue #887 の本文は「stdout/exit ハンドラは `engine-lifecycle.ts`（既存）へ」と書いていたが、
設計（Fable 起案・main が `grep` で裏取り）がこれを覆した。
`extension-wiring.spec.ts:48` が `engine-lifecycle` を `vi.mock` して `applyEngineExit` /
`applyEngineError` を spy にしており、**同一モジュール内の呼び出しは mock を通らない**。
戻した瞬間に spy が一度も呼ばれなくなり、テストを書き換えるしかなくなる。

**`extension-wiring.spec.ts` が 58 passed であることが、mock 境界の外側に置けた証拠**である。

### 引用 122 件 — 束 A で作った手順がそのまま効いた

`--fix`（行番号のみ）70 → 本文をソースから再生成して再アンカー 52。
束 A で書いた再アンカー手順を `$TMPDIR` のスクリプトとして再利用した。

🔴 **引用が緑でも散文は検査されない（2 回目）。** `plugin-ui.md` が
「**`extension.ts` の** stdout ルータはこの結果行を拾います」と書いているのに、
引用は `engine-handlers.ts` を指していた。ja/en とも帰属を直した。
移した関数名 7 つで横断検索し、他に同型が無いことも確認した。

### 検証

`npm test` **2,488 passed**（束 0 / A と同値・**既存テストの期待値の変更 0 件**。
`tests/` の差分はラチェットの baseline のみ）/ `npm run lint` / `npm run typecheck:e2e` /
`npm run build` / `npm run docs:check` 982 引用 / `extension-wiring.spec` 58 passed /
`public-surface.spec` 38 passed。

### refactor(extension): move module state to a leaf and turn 31 assignments into setters (Sep 12, 2026)

**Date**: 2026-09-12 / **ブランチ**: `887-extension-split`

#887 の**束 A**。分割の核心で、以降の束が「純粋な移動」になるための前提。

### 読みは live binding・書きは setter

ES module の import 束縛は**代入できない**が、読みは常に最新値が見える。そこで:

- **読み出し約 220 箇所の本文は 1 文字も変えていない**
- **代入 31 箇所だけ**が `setX(v)` になった

新設は `extension-state.ts`（103 コード行・leaf）と `playhead-decorations.ts`（124）。
`__*ForTest` **13 本**は名前も引数も本文も変えず、閉じている状態と同じモジュールへ移し、
`extension.ts` が `export { … } from` で再輸出する。**テスト側 239 箇所の変更は 0**。

`extension.ts` は 2,779 → **2,662** コード行。

### residual 322 行をすべて分類した

設計 §7.2 の done 条件。**未分類 0**:

| 分類 | 行数 |
|---|---|
| setter の定義と本体 | 54 |
| setter の呼び出し | 32 |
| 局所定数化 / 旧宣言 | 31+ |
| import / 再輸出 | 89 |
| 宣言・関数に `export` を前置（移動） | 25 |
| doc / コメント | 11 |

分類中に `outputChannel.appendLine` → `channel.appendLine` が一度「未分類」に落ちたが、
設計 §4.5 が予告した **narrowing のための局所定数化**だった
（`const channel = vscode.window.createOutputChannel(...)` の直後に `setOutputChannel(channel)`。
**同一オブジェクト**であることを実物で確認）。

### 🔴 今朝作った L-3 ガードが、今日のうちに TS 側で仕事をした

新設 2 ファイルが `git add` 前だったため、ラチェットが**名指しで検出**した
（`docs/design/888-file-size-ratchet-design.md` §13.10）。Rust 側で踏んだ穴が TS でも同じ形で出る。

### 引用 124 件が壊れた — 3 段階で直した

| 手段 | 解決 |
|---|---|
| `--fix`（行番号のみ） | 88 |
| 本文一致で移動先を特定（`export` 前置を剥がす） | 12 |
| 先頭行・末尾行を鍵にした再アンカー + **本文をソースから再生成** | 22 |
| 手で 1 組 | 2 |

🔴 途中で relocate スクリプトが **`/tmp` の一時パスを markdown に書き込んだ**（2 件）。
候補ディレクトリに `/tmp` を渡した私の使い方の誤りで、直した。

🔴 **引用が緑になっても散文は検査されない。** `vscode-architecture.md` が
「`extension.ts` は 4,115 行の大きなファイルで、状態はモジュールレベル変数に置かれています」と
書いており、**分割後は両方とも事実でない**。ja/en とも実態に合わせた。

### 検証

`npm test` **2,488 passed**（束 0 と同値・**既存テストの期待値の変更 0 件**）/
`npm run lint` / `npm run typecheck:e2e` / `npm run build` / `npm run docs:check` 982 引用 /
`grep -cE '^let ' extension.ts` = **0**。

### test(extension): freeze the public surface before splitting extension.ts (Sep 12, 2026)

**Date**: 2026-09-12 / **ブランチ**: `887-extension-split`

#887（TS 分割）の**束 0 = 道具を先に置く**。**ソースは 1 行も動かしていない**
（`git diff --stat main -- packages/` が空）。

### 🔴 Rust で 2 度踏んだ欠陥の TS 版を先に塞ぐ

Rust では `pub` 項目が `pub(crate) use` 経由で crate 外から消え、**全ゲート緑のまま通過**した。
TS に `pub(crate)` は無いが、同型の欠陥は「再輸出ブロックから 1 本抜ける」「型だけ export されて
値が消える」形で出る。しかも **`tests/vscode-extension/` は一度も型検査されていなかった**
（`tsconfig.tests.json` の include は `tests/e2e/**` のみ）。

`tests/vscode-extension/public-surface.spec.ts` を置き、**tsc と vitest の 2 層**に通した。
凍結したのは `extension.ts` **27** + `mcp-server.ts` 値 **11** = **38 値**と、型 **25**。
（設計文書の一覧を写さず、現物を `grep -E '^export'` して突き合わせた結果が一致）

main が実測した fail-before **3 件**:

| 変異 | 検出した層 |
|---|---|
| 存在しない export を import | tsc **TS2724** |
| 型を値として使う | tsc **TS2693** |
| 🔴 **実際に `export` を 1 本消す** | vitest（実行時に `undefined`） |

3 番目が本題。Rust で踏んだ欠陥はこの形だった。

### 引用追随スクリプトもリポジトリへ

`sites/dev/scripts/relocate-citations.mjs`。引用は `extension.ts` **248 箇所** /
`mcp-server.ts` **46 箇所**あり、全束で動く。`--fix` は**行番号しか直せない**ので、
移動先を中身から特定するこれが要る。Rust 分割では scratchpad に置いていて毎回探していた。

### 検証

`npm test` **2,488 passed**（main の基準 2,450 + surface spec 38・**既存テストの期待値の変更 0 件**）/
`npm run typecheck:e2e` / `npm run lint` / `npm run docs:check` 982 引用。

### docs: link the install guide from README and every release (Sep 12, 2026)

**Date**: 2026-09-12 / **ブランチ**: `905-install-route-links`

owner の指摘から。「インストール手順は**リリースページに書く**のではなく、**マニュアルに載せて
README やリリースからリンクする**」という裁定に従った（#905）。

### 🔴 手書きの定型は次の版まで生き残らなかった

v3.0.0 のリリースページには **45 行の丁寧な手順**が手書きされていたが、**v4.0.0 では丸ごと消えた**。
`release.yml` は `gh release create --generate-notes` だけなので、**自動では何も付かない**。
v3.0.0 のものは後から手で書き足したものだった。

**これが「リリースページに書く」案を採らない実測の根拠**である。私は当初そちらを提案したが、
owner の案（正本へリンク）の方が正しい。複製は必ず本体より遅れる。

### やったこと

| 対象 | 変更 |
|---|---|
| `release.yml` | `--notes-file` で短い定型（動作環境 + 正本へのリンク）を先頭に置き、`--generate-notes` の changelog をその後ろへ。**次の版から自動で付く** |
| `README.md` | 既存の「Just want to use it?」節に正本へのリンクを足した |

正本は `sites/user/getting-started/installation.md`（版に依存しない書き方・公開済み。
https://signalcompose.github.io/orbitscore/getting-started/installation が 200 を返すことを確認）。

🔴 **heredoc の字下げを検証した。** YAML の `run: |` ブロック内に heredoc を書くと、字下げ次第で
markdown が丸ごとコードブロックになる。YAML を実際に展開して列 0 に揃うことを確認し、
生成物も実行して目視した。

### 🔴 やらなかったこと 2 件

- **README に新しい `## Install` 節を作らない** — 一度作ったが、既存の「Just want to use it?」と
  合わせて**三つ目の複製**になると気づいて取り消した
- **`docs/user/ja/USER_MANUAL.md` を直さない** — scsynth の記述など明らかに腐っているが、
  この文書は **DEPRECATED で「履歴として保持」（#237）** と明記されている。一度書き換えてから
  気づいて戻した。腐りは冒頭の 2 つのバナーが既に無効宣言しており、さらに「リリースページに
  手順が載っています」という 65 行目の約束は、上の `release.yml` の変更で**再び真になる**

### chore(release): bump the extension to 4.0.1 — the Rust split ships (Sep 12, 2026)

**Date**: 2026-09-12 / **ブランチ**: `888-release-4.0.1`

#888 の Rust 分割（子 0〜3）を 4.0.1 として出す。**patch である** — 振る舞いも DSL も
変えていないため（`/goal` の確定事項「4.0.1 は Rust 分割のみ」）。

| 軸 | 値 | 動いたか |
|---|---|---|
| 拡張（`.vsix` と git タグ・**正本**） | **4.0.0 → 4.0.1** | ✅ |
| `ENGINE_VERSION`（セッションログの meta） | 2.0.0 | 別軸・同期しない |
| `DSL_VERSION`（spec 版） | 2.0 | 別軸・同期しない |

`docs/design/656-release-design.md` §4.4 のとおり 3 つは別軸。
`node scripts/check-release-tag-version.mjs v4.0.1` が緑。

🔴 **歴史的記述は変えていない。** 「#883 で拡張を 4.0.0 に上げた」という記述は事実なので
そのまま残し、**「現在の版は〜」と現在形で述べている箇所だけ**を 4.0.1 にした
（README / CLAUDE.md / core spec 2 箇所 / dev サイト 4 箇所）。

### docs: land the four routine docs-sync PRs as one roundup (Sep 12, 2026)

**Date**: 2026-09-12 / **ブランチ**: `893-docs-sync-roundup`

#882 / #891 / #892 / #893 を 1 本に畳んだ。**4 本とも CONFLICTING** で、#888 の分割が main に
入った直後だったため放置すれば腐る一方だった（owner の指摘で着手）。前例は #867（9 本の roundup）。

衝突は 2 種類:

- **WORK_LOG**（4 本とも Recent Work へ追記）— 両方残す
- **`vscode-architecture.md` の「どの PR まで追従したか」の Note 行** — #884 / #885 / #889 の
  3 本すべてを反映した 1 文にまとめた。HEAD 側に残っていた「束 S（#885）はまだ反映していません」は
  **#885 を取り込んだ時点で古くなっていた**（2 段目の取り込みで前段の宣言が嘘になる型）

🔴 引用は 8 件壊れていたが、**すべて `extension.ts`** で #888 の Rust 分割とは無関係だった
（PR の base が古かったための一様な **+27 行**シフト）。`--fix` の着地先 4 件は散文と突き合わせて
確認済み — `updateDiagnostics` の `analyzeMissingOutput` ループ / `registerOutputCodeActionProvider`
の `provideCodeActions` / 補完候補の組み立て / トリガ文字の登録。

検証: `npm test` 2,450 passed / `npm run lint` / `npm run docs:check` **982 引用**（4 本が +34 件）。

### docs: follow PR #889 into the chapters and guides that still said `spawn('node')` (Sep 12, 2026)

**Date**: 2026-09-12
**ブランチ**: `claude/docs-sync-pr889`
**担当**: docs 追従ルーティン（マージ済み PR [#889](https://github.com/signalcompose/orbitscore/pull/889) を追う）

PR #889（#878・engine を VS Code 同梱の Node で起動）は dev サイトの引用ブロックを追従させたが、
**引用を囲む本文と図が古いまま**だった。`docs:check` は引用のアンカーしか見ないので red にならない
（`docs/core/PROJECT_RULES.md` の「ルーティンは機械が見ていない層を見ている」）。

#### 1. `spawn('node')` と言い続けていた本文・図

| 場所 | 何が古かったか |
|---|---|
| `sites/dev/orientation/architecture-overview.md:60` | mermaid のラベルが `child_process.spawn('node', ...)` / `env は debug フラグと capture seam のみ` |
| `sites/dev/editor/vscode-architecture.md:606` | 「debug フラグと capture seam（#307）だけを env へ積んで spawn します」 |

どちらも spawn の第 1 引数が `process.execPath` になり、env に `ELECTRON_RUN_AS_NODE` /
`ELECTRON_NO_ASAR` が加わった時点で事実でなくなっている。

#### 2. `daemonEnv()` が説明なしで引用に現れていた

`architecture-overview.md` の `spawnDaemon()` 引用には PR #889 で `env: daemonEnv(process.env)` が
入ったが、**`daemonEnv()` が何かを述べる本文が 1 行も無かった**。関数本体の引用と、
「自分が足したものを自分の出口で戻す」という根拠（および「ホスト由来の変数を第三者へ渡さない」を
根拠にしていない理由）を書いた。

#### 3. cold install ゲートがどの doc にも無かった

`npm run test:e2e:cold-install`（`ORBIT_GATED_COLD_INSTALL=1`）は CLAUDE.md のマージ前ゲートには
入ったが、**gated E2E を説明する章**（`sites/dev/editor/mcp-and-gated-e2e.md`）と
**テスト手順の doc**（`docs/testing/TESTING_GUIDE.md`）には無かった。前者に 1 節
（dev host が構造的に通らない 3 経路・strict / finder の差・オラクルが `ok` でなく RMS）を、
後者に実行手順を足した。

日英とも同一ターンで更新。`node sites/dev/scripts/check-citations.mjs` は 956 citations / 0 failed。

---

### docs: follow PR #885 in the user site, the manual and the editor chapters (Sep 12, 2026)

**Date**: 2026-09-12
**ブランチ**: `claude/docs-sync-pr885`
**担当**: docs-sync ルーチン（追従元 = PR [#885](https://github.com/signalcompose/orbitscore/pull/885)・マージ commit `f575f27`）

PR #885（暗黙 master 終端の廃止・#883 束 S）に、**ドキュメントだけ**を追従させた。実装・テストは
一切触っていない。

#### 1. ユーザー向けの記述が仕様と正反対のまま残っていた

#885 は `AudioLine.program()` の暗黙 `output(master)` 合成を削除したが、**ユーザーサイトは
「`output()` を 1 つも書かなかった場合は、線の最後に `output("master")` があるものとして
扱われます」と書いたまま**だった。ja / en の 4 箇所:

| ファイル | 旧記述 |
|---|---|
| `sites/user/mixing/routing.md:97` | 「これは今までどおりの動きです」 |
| `sites/user/en/mixing/routing.md:97` | 同上（en） |
| `sites/user/reference/methods.md:443` | 「線の最後に `output("master")` があるものとして扱われます」 |
| `sites/user/en/reference/methods.md:399` | 同上（en） |

いずれも「出口の無い線は無音」へ書き換え、`routing.md` には**出口を書き忘れたときの節**を新設した
（`output-missing` / `dry-not-routed` の 2 診断と quick fix、sum / aux バス自身にも出口が要ること）。
「音が鳴らない」は `troubleshooting.md` の先頭カテゴリなので、そこにも原因 1 件として足した。

同じ章の**譜面例そのもの**も 2 件古かった。`routing.md` の `send()` 節は「元の音自体は消えず、
そのまま master（または sum）へ流れ続けます」と書いており、これは #883 X3 が塞いだ挙動の説明に
なっていた。`send()` は今も分岐（`thru: true`）だが、その先に出口が無ければ dry はどこにも
届かない。`sum` の最初の例と `projects/import.md` の例も、バス自身の `output()` が無いため
**そのまま写すと無音**になる状態だった。

`docs/user/ja/USER_MANUAL.md` の instrument 節は「instrument の音は master へ直接ミックス
されます」と**無条件に**書いていた。#885 以降は出口を書いたときだけなので条件付きに直し、
「音が出ない」の原因リストにも出口の書き忘れを先頭で足した。

#### 2. dev サイトの診断章が旧仕様（LinkAudio 限定の Error）のままだった

#885 は `analyzeLinkAudioMissingOutput`（LinkAudio ファイル限定・Error・instrument 除外）を
`analyzeMissingOutput`（全ファイル・Warning + Information・**instrument は対象**・quick fix 付き）へ
置き換えたが、`sites/dev/editor/execution-feedback.md` の診断 6-8 節と 9 種の表は旧記述のまま
だった。表の行・守備範囲・severity の理由を書き換え、`code` の 3 分岐・severity 写像・
CodeActionProvider の節を足した（ja / en）。

- `sites/dev/editor/vscode-architecture.md`: `activate()` に増えた
  `registerOutputCodeActionProvider(context)` の 1 行を IntelliSense / 診断の登録節へ
- `sites/dev/editor/mcp-and-gated-e2e.md`: `get_diagnostics` が返す `DiagnosticEntry` に
  `code?` が増えたこと（エージェントが文言でなく識別子で分岐できる）

3 章とも `verified-against` を `f575f27` へ、`verified-at` を 2026-09-12 へ更新した。

#### 追従不要と判断したもの

- `docs/specs-v2/SIGNAL_CHAIN_DSL_SPEC_v1.md` / `DESIGN_DISCUSSION_RECORD.md`（決定 #78 / #79）は
  **束 S より前に更新済み**で、#885 の振る舞いと一致している
- `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` は #885 自身が更新済み（診断の「⏳ 未実装」→「✅ 実装済み」）
- `sites/dev/signal-chain/mixer-audio-line.md` ほか dev サイトの 20 章は #885 自身が更新済み
  （`SourceDest::None` / `FeedDest::Discard` / `PROTOCOL_VERSION 0.3` まで反映されている）
- `docs/design/883-explicit-output-routing-design.md` は起案時点のスナップショットなので触らない

#### 検証

`npm run docs:build`（user / dev）と `npm run docs:check` を通した。結果は PR 本文に貼ってある。

---

### docs(dev-site): follow PR #884 in the dev site and repair a mangled citation (Sep 12, 2026)

**Date**: 2026-09-12
**ブランチ**: `claude/docs-sync-pr884`（docs 追従ルーチン・main 宛 draft）
**対象**: PR [#884](https://github.com/signalcompose/orbitscore/pull/884)（#883 束 0+C・マージコミット `82acaa3`）

マージ済み PR #884 に dev 学習サイトを追従させた。**実装とテストは一切変更していない。**

#### 1. `sites/dev/pipeline/evaluation.md` の引用が壊れていた（🔴 docs:check は緑だった）

PR #884 で `check-citations.mjs --fix` が `evaluate-method.ts:58-145` を再アンカーした際、
**直前の別 docblock の末尾（` * ``` ` / ` */ `）を引用の先頭に取り込み、末尾は
`if (sawNamedArg) {` で切れていた**。引用は実ファイルと**文字単位で一致していた**ので
`docs:check` は 0 failed のまま通る — **この検査は「引用が意味のある単位か」を見ない。**

実ファイルを読み直し、`60-159`（`NAMED_ARG_SCHEMA` の docblock から `processArguments()` の
閉じ括弧まで）へ引用し直した。

#### 2. 追従した内容

| 章 | 足したもの |
|---|---|
| `pipeline/evaluation.md` | 名前付き引数だけの `output(db: -6)` で options 袋が**宛先の位置に座る**問題と、`output` / `send` に限って `undefined` を unshift して宛先位置を空ける処理（`evaluate-method.ts:145-158`）。判定に使う `isOutputDest()` が core 側と同一関数であること |
| `signal-chain/mixer-audio-line.md` | 新節「宛先の省略と『実現の省略』」— `output()` の宛先省略（既定引数であって暗黙要素ではない）/ `isOutputDest()` の 1 点賭け / `assertSendDestination()` が両 `send()` の契約であること / `lineNeedsBus()` による実現の省略と `gain`・`pan` 引き継ぎへの副作用 |
| `editor/vscode-architecture.md` | 補完を **3 系統 → 4 系統**に更新。`.output(` の宛先補完（`output-string` / `output-node` の 2 コンテキスト・`mixerNode` 除外の理由・トリガ文字 `(` の追加） |

ja / en 両方（STYLE_GUIDE のバイリンガル要件）。3 章の frontmatter の
`verified-against` / `verified-at` を `f575f27` / `2026-09-12` に更新した。

#### 3. 🔴 引用は `f575f27`（#885 マージ後の main）基準である

追従の起点は #884 だが、**束 S（PR [#885](https://github.com/signalcompose/orbitscore/pull/885)）が
既に main へ入っている**ため、branch を main から切った時点で `sequence.ts` /
`audio-line.ts` / `extension.ts` の行番号が動いていた。行ずれだけのものは `--fix` で再アンカーし、
**内容が変わっていた `lineNeedsBus()`（#885 が `isPlainMasterOutput()` を切り出した）は
実ファイルを読み直して引用し直した**。束 S 自身の追従（`AudioLine.program()` からの
暗黙 master 撤去・診断 2 種・版 4.0.0）は**このコミットには入っていない**。

#### 4. 追従できていない点（PR 本文に書き出しただけ・直していない）

- `.output()`（宛先省略）は E2E カバレッジのラチェットに**見えない** — 走査が
  `/\.([a-zA-Z][a-zA-Z0-9]*)\s*\(/` なので `.output()` と `.output("drum")` が同じ 1 語に潰れる
- `output(db: -6)` / `send(db: -6)`（名前付き引数だけの形）は unit のみ。**実機 gated E2E に無い**
- 実現の省略の目的（`.output()` 必須化で 8 本のプールを食い潰さない）を押さえる E2E が無い —
  X2 は 1 シーケンスの等価性しか測っていない

### docs: carry the install-route fix into the legacy ja manual (PR #880 追従) (Sep 11, 2026)

ルーティン docs 追従。追従元は PR [#880](https://github.com/signalcompose/orbitscore/pull/880)
（マージコミット `4e661467b0ff8997fc67b4b9bd6f31f1ef33e8d5`・docs のみ・CI 4/4 緑）。

#### 追従した 1 点

PR #880 は資産名の実物合わせ（`orbitscore-<version>.vsix` → `orbitscore-darwin-arm64-<version>.vsix`）を
**4 箇所**に入れたが、**`docs/user/ja/USER_MANUAL.md` が漏れていた**。

| 直した箇所 | 旧 | 新 |
|---|---|---|
| `docs/user/ja/USER_MANUAL.md:59` | `orbitscore-*.vsix` | `orbitscore-darwin-arm64-*.vsix` + Assets / releases/latest の導線 |
| 同 `:63`（CLI） | `code --install-extension orbitscore-*.vsix` | 同上のファイル名 |
| 同 `:65` | 「将来は VS Code Marketplace と Open VSX からも install 可能になる予定」 | **公開しない**（owner 2026-09-10・#880 の WORK_LOG に記録） |

接尾辞 `darwin-arm64` は `release.yml:45` の `VSIX_TARGET` を `vsce package --target` へ渡した結果であり
（`release.yml:118`）、**リリース資産にのみ付く**。版番号は #880 の方針どおり固定していない。

#### 追従不要と判断したもの

| 対象 | 理由 |
|---|---|
| `docs/user/{ja,en}/GETTING_STARTED.md:72` の `orbitscore-0.0.1.vsix` | **ローカルビルドの `.vsix`**（直前が `npm run build`）。`--target` を渡さない `vsce package` には接尾辞が付かないので #880 の資産名は当たらない。版が古いのは別件 |
| `docs/user/en/USER_MANUAL.md` | `.vsix` のダウンロード導線を**そもそも持たない**（build-from-source のみ）。ja と対になる記述が無い |
| `docs/user/ja/USER_MANUAL.md:55` の scsynth 同梱 | #502 の失効範囲。冒頭バナーが既にカバーしており、#880 の差分ではない |
| `sites/user/**`・`README.md`・`packages/vscode-extension/README.md` | #880 が ja / en とも更新済み |
| DSL / ランタイム / OrbitStudio の各層 | #880 は **docs のみ**（5 ファイル）。構文・意味論・MCP・評価経路のいずれも触っていない |

検証: `docs:build`（user / dev）緑・`docs:check` 944 / 0 failed。
### fix(plugin-scan): re-export vst3_scan publicly — my sed excluded digits (Sep 12, 2026)

**Date**: 2026-09-12 / **ブランチ**: `888-c3-vst3-host`

🔴 **Fable 監査の指摘を「既に直っている」と却下したが、誤りだった。** 私は**束 1 のブランチで**
検査しており、そこでは `orbit-plugin-scan` がまだ分割されていなかった（分割は束 3）。
stack 先端では `scan_vst3_bundle` / `dedup_entries` / `VstScanResult` が **E0603** で落ちる。

原因は私の `sed` の文字クラス:

```
s/^pub(crate) use \([a-z_]*\)::\*;$/pub use \1::*;/
```

`[a-z_]*` に**数字が入っていない**ため、`vst3_scan` だけが一致していなかった。
他 11 モジュールは直り、その 1 つだけが残った。

**今日置いたばかりの `tests/public_surface.rs` が stack 先端でこれを捕まえた。**
検算の道具を先に作ったことが効いている。

🔴 **教訓は 2 つ**: (a) **stacked PR では、下流の変更を含む先端で検算する**。上流の枝で
「無い」と言っても、下流で初めて現れる欠陥は見えない。(b) **機械的置換の網羅性は、置換対象の
一覧と突き合わせて確かめる**（`grep -c 'pub(crate) use'` が 0 になったことだけを見ていた）。

併せて `module-doc-purity.spec.ts` の「0 件なら必ず宣言せよ」という逆方向を外した。
カウンタが測れるのは**修飾子の絶対数**であって「分割で変えたか」ではなく、`pub(crate)` は
分割前から付いていることがある（`playback.rs` の `set_callback_alive`）。検証できる主張だけを残す。

### refactor(rust): split the last three Rust files — #888 child 3 done (Sep 12, 2026)

**Date**: 2026-09-12 / **ブランチ**: `888-c3-vst3-host`

🎯 **#888 子 3 完了。目標 6 ファイルがすべて 500 コード行以下になった。**

| ファイル | 前 | 後 | 新モジュール（コード行） |
|---|---|---|---|
| `orbit-vst3-host/src/lib.rs` | 2,388 | **455** | `setup` 466 / `effect` 406 / `instrument` 303 / `interfaces` 280 / `events` 276 / `probe` 232 |
| `orbit-plugin-scan/src/lib.rs` | 1,652 | **44** | `scan_run` 271 / `artifact_probe` 237 / `child_probe` 193 / `vst3_scan` 186 / `process` 180 / `macho` 175 / `types` 135 ほか 5 |
| `orbit-audio-sandbox/src/transport.rs` | 1,416 | **36** | `ui_pump` 478 / `mailbox` 374 / `event_ring` 218 / `shm` 160 / `layout` 93 / `ui_codec` 92 |

`npm test` は **2,445 passed で不変**（既存テストの期待値を 1 つも変えていない）。
cargo fmt / cfg 4 象限 / `clippy --workspace --all-targets -D warnings` / `cargo test --workspace`（93 スイート）/
lint / docs:check（948 引用）すべて緑。dev サイトの引用 32 件は `relocate-citations.mjs` で追随。

### 🔴 public API が黙って消える — `pub(crate) use` の罠

`pub fn` を private な子モジュールへ移し `pub(crate) use child::*;` で再エクスポートすると、
**crate 内はコンパイルが通るのに crate 外からは見えなくなる**。`cargo clippy -p <crate>` は
下流を見ないので捕まらない。実際 `orbit-vst3-host` の `probe_factory_descriptors` は
この形で public API から落ち、`orbit-plugin-scan` の 15 件は dead_code 警告で初めて露見した。

対処は `pub use child::*;`（低い可視性の項目はそのまま低いまま再エクスポートされる）。
検算として **分割前後で `^pub (fn|struct|enum|const|type|trait)` の集合を diff** し、
3 crate とも同一であることを確認した。

### 🔴 ラチェットが緑のまま閾値超過を見逃した — `git ls-files` は index を見る

新設した `host/interfaces.rs` は **576 コード行**あったが、`git add` 前だったため
`git ls-files` の列挙に現れず、**ラチェットは 11 テスト全緑**だった。設計 §13.10 が
この帰結を予告していたのに、実作業で踏んだ。真空防止（`minFiles`）は塞げない —
追跡済みファイルだけで件数のしきい値は満たされるからで、**L-1 / L-2 と同じ
「分割が成功した瞬間に実害化する」構造**をしている。

`listUntrackedMeasuredFiles` を足し、測定対象の未追跡ファイルが 1 つでもあれば赤にした
（**L-3**）。未追跡の `.rs` を置いて red、消して green を実測。設計 §13.10 に追記済み。
### fix(daemon): restore nine public items the split had hidden (Sep 12, 2026)

**Date**: 2026-09-12 / **ブランチ**: `888-b1-engine-wrap`

レビュー（`/code:pr-review-team` + Fable 監査）の指摘への対応。

### 🔴 公開面が 9 件、黙って crate 外から見えなくなっていた（Fable 監査）

`engine_wrap` は `lib.rs` で `pub mod` として公開されている。`BusKind` / `BusLineDest` /
`BusLineOp` / `SourceRoutingTarget` / `StreamGuard` / `StreamConfigSnapshot` /
`DEFAULT_{AUX,EFFECT,SUM}_BUS_POOL_PREFIX` は main では crate 外から見えていたが、
private な子モジュールへ移して `pub(crate) use` で再エクスポートしたため **E0603** になる。
**下流にまだ消費者が居ないので、全ゲートが緑のまま通過していた。**

🔴 **「分割前後で `^pub (fn|struct|…)` の集合を diff して同一」という私の検算は無効だった。**
宣言は `pub` のままで、**到達経路だけが失われる**からである。正しい検算は
**crate の外側からコンパイルすること** — 統合テストは外部 crate なので、そこで `use` できる
ことが到達可能性そのものの証明になる。

`tests/public_surface.rs` を 4 crate（daemon / sandbox / plugin-scan / vst3-host・計 143 項目）に
置いて main 時点の公開面を固定した。書く過程でもう 1 つ踏んだ: **統合テストでは `cfg(test)` が
真だが、参照先の lib は `--test` 無しでコンパイルされるので偽**。定義側の `#[cfg(any(test, X))]`
をそのまま写すと E0432 になる（`test` 項を落としてある）。

### module doc の 7 件が実態とずれていた（comment-analyzer）

最悪は `startup.rs` / `startup_instrument.rs` で、**可視性変更の説明がまるごと入れ替わって**いた
（前者が名指しした 2 関数はどちらも後者にある）。個別パッチではなく設計 §14 に開示ポリシーを
置き、21 モジュールへ一括適用した。**「N 行を除いて純粋な移動である」という件数の主張を禁じた** —
件数は doc が追随せず必ずずれる（書いている最中に自分でも 1 件ずらした）。
`tests/repo/module-doc-purity.spec.ts` で機械に突き合わせさせる。

### refactor(daemon): re-cut role.rs after the simplify review (Sep 12, 2026)

**Date**: 2026-09-12 / **ブランチ**: `888-b1-engine-wrap`

`/simplify` の altitude 指摘に対応。`role.rs` に同居していた**ストリーム/デバイスの
ライフサイクル型**（`StreamGuard` / `StreamConfigSnapshot` / `DeviceSwitchRequest` /
capture パス解決）166 行を、その主題そのものである `device_link.rs` へ移した。
併せて `engine_wrap/outproc_instrument.rs` を `outproc_instrument_slots.rs` へ改名
（crate 直下の同名 supervisor との衝突解消）、実態とずれた module doc 3 件を訂正、
`LoadedSample` を生成元の `playback.rs` へ移した。

🔴 **単一象限の unused 警告で import を消してはいけない。** デバイス群を移した後
`use role::*;` が default 象限で unused になったので消したところ、`outproc-*` 両 feature
象限が **E0432 で落ちた**（他象限のインラインテストが `super::ChildSlot` 等でこの glob 経由の
名前に到達している）。`#[allow(unused_imports)]` で戻し、理由をコメントに残した。
この赤は `check-cfg-matrix.sh ... | tail -2` で**終了コードが隠れて**おり、出力を読んで気づいた。

🔴 レビュー指摘の前提が誤っていた例: 「`LoadedSample` の消費者は `playback.rs` だけ」は
**`session.rs` が型名を書かずに（型推論で）使っている**ため誤り。名前の grep には掛からない。
### refactor(native): split output.rs — 2,587 to 322 code lines (Sep 12, 2026)

**Date**: 2026-09-12 / **ブランチ**: `888-c2-output`

🎯 **#888 子 2 完了。`output.rs` が 2,587 → 322 コード行。** 9 ファイルすべて 500 以下
（`device.rs` 327 / `lines.rs` 258 / `line_program.rs` 293 / `render.rs` 406 /
`render_full.rs` 237 / `dsp.rs` 173 / `bus_topology.rs` 156 / `startup.rs` 477）。

**これで 6 ファイル中 3 つが目標達成**（`engine_wrap.rs` 424 / `session.rs` 439 / `output.rs` 322）。

### 🔴 引用の追随が 68 件 — 自動化しないと回らない規模

`output.rs` は dev サイトから **34 箇所 ×2 言語**引用されていた。手で直すのは非現実的なので、
**引用ブロックの中身から移動先を特定して header を書き換える**スクリプトを書いた
（scratchpad の `relocate-citations.mjs`）。段階的に強化した経過:

| 版 | 方式 | 解決 | 残り |
|---|---|---|---|
| 1 | 先頭行が**一意に**一致する候補ファイルを探す | 50 | 18 |
| 2 | 先頭 5 行の連続一致で照合 | +0 | 18 |
| 3 | 🔴 **可視性修飾（`pub(super) ` 等）を剥がして照合** | +16 | 2 |
| 手動 | シグネチャが複数行に折り返された 2 件 | +2 | 0 |

版 2 が 1 件も増やさなかったのが示唆的で、**問題は「先頭行の曖昧さ」ではなく「行そのものが
変わったこと」**だった。分割で `pub(super) ` が前置されるので、素の文字列比較では永久に一致しない。

### 移動の内訳

デバイス解決 / ライン機構 / ラインプログラム / render 経路 / 最大の render 1 関数 /
DSP ヘルパー（ゲイン・パン・加算）/ bus topology 検証 / 起動系。
可視性は第 9〜11 束で確立した手法（フィールドまで含めた一括付与 →
**コンパイラの指摘行を使った収束ループ**）で処理した。

**検証**: cfg 4 象限緑 / `cargo fmt --check` / **`cargo clippy --workspace -D warnings` 緑** /
`cargo test --workspace --lib` **476 passed** / `npm test` **2,445 passed**（不変）/ lint /
`docs:check` 948 引用 0 failed。


### refactor(daemon): split session.rs — 2,605 to 439 code lines (Sep 12, 2026)

**Date**: 2026-09-12 / **ブランチ**: `888-c2-session`

🎯 **#888 子 2 の前半完了。`session.rs` が 2,605 → 439 コード行。** 7 ファイルすべて 500 以下
（`dispatch.rs` 411 / `dispatch_plugin.rs` 498 / `dispatch_transport.rs` 158 /
`params.rs` 289 / `params_plugin.rs` 413 / `run_loop.rs` 476）。

### 🔴 ここで初めて「純粋な移動」を超えた（owner 裁定 2026-09-12）

`handle_command` は **1,028 コード行の単一 `match` 式**だった。ファイルを分けても 1 つの式なので、
**行数だけでは閾値 500 を満たせない**。owner に諮り「**アームを関数へ切り出す**」を選んだ。

切り出した形（`dispatch_plugin.rs` / `dispatch_transport.rs`）:

```rust
pub(super) async fn handle_plugin_command(...) -> Option<Value> {
    Some(match method {
        "LoadPlugin" => { ... }     // アーム本体は 1 行も書き換えていない
        _ => return None,           // 該当しなければ親の match へ戻す
    })
}
```

🔴 **アーム本体は 1 行も書き換えていない。** 変わったのは (a) 関数シグネチャ (b) 呼び出し側の
3 行 (c) 早期 `return err(...)` を `return Some(err(...))` に包んだこと（**21 + 12 箇所**）。
**「既存テストの期待値を 1 つも変えていない」という検算は維持されている。**

(c) の包み直しは、第 11 束で確立した**コンパイラの指摘行を使うループ**でやった。
E0308 の行番号を抜いて該当行だけを包む処理を収束するまで回す。手で探すと必ず取りこぼす。

### 引用の追随 6 件

3 件は移動先が別ファイル、3 件は**範囲がファイル外**（`session.rs` が短くなったため
`range 2412-2413 is outside the file (2120 lines)`）。引用ブロックの中身から移動先を検索して
特定し、第 9 束で書いた再生成スクリプトで本文を同期した。**6 件とも着地先を目視で照合済み。**

**検証**: cfg 4 象限緑 + `clap-host` 単独 / `cargo fmt --check` / `cargo test` 58 passed /
`npm test` **2,445 passed**（不変）/ lint / `docs:check` 948 引用 0 failed。


### refactor(daemon): finish splitting engine_wrap.rs — 6,418 to 424 code lines (Sep 12, 2026)

**Date**: 2026-09-12 / **ブランチ**: `888-c1-ui-types`

🎯 **#888 子 1 完了。`engine_wrap.rs` が 6,418 → 424 コード行（閾値 500 以下）。**
baseline から削除した。子モジュール **21 本**、いずれも 500 以下。

第 12 束（最終）で移したもの: wire に載る公開型（`wire_types.rs` 130）/ `EngineWrap` の構築と
OOP プラグインの load 本体（`build_and_load.rs` 303）/ エフェクトバス stage の構築（`bus_stages.rs`）。

### 子 1 の全経過

```
6,418 → 6,014 → 5,585 → 5,127 → 4,409 → 3,655
      → 3,417 → 2,857 → 2,362 → 1,989 → 1,468 → 995 → 424
```

### 🔴 12 束を通して分かったこと

1. **「純粋な移動」は目標ではなく性質。** 相互依存があれば可視性の変更は避けられない。
   大事なのは**変更を最小に留め、それが residual に見えること**（第 4 束以降）
2. **必要な作業は対象の種類で変わる。** メソッド（1〜7 束）→ 自由関数（8 束）→
   構造体フィールド（9 束）→ トレイト（11 束）と、`pub(super)` を付ける対象が深くなった。
   元が 1 つの巨大モジュールだったので、内部の結合が可視化されていなかっただけ
3. 🔴 **境界の失敗には検出可能性の差がある。** 属性の分断は**コンパイルエラー**になるが、
   doc コメントの分断は **`cargo fmt --check` しか捕まえない**（第 4 束で実際に残った）
4. 🔴 **構文を正規表現で判定するのをやめ、コンパイラの指摘行を使う**方式に切り替えたら速くなった
   （第 11 束）。子 0 の **D9**（heuristic を改良せず基準を言語の正規実装に置く）と同じ転換
5. **cfg は定義側と一致させる** — 第 9・10 束で 2 度同じ誤りをした。
   毎回 `check-cfg-matrix.sh` を回していたので 2 回とも即座に検出できた

**検証**（全 12 束で毎回実施）: cfg 4 象限 + `clap-host` 単独 / `cargo fmt --check` /
`cargo test` / `npm test` **2,445 passed**（**12 束を通して 1 件も変わっていない**）/ lint /
`docs:check` 948 引用。


### refactor(daemon): move the OOP role abstraction into a child module (Sep 12, 2026)

**Date**: 2026-09-12 / **ブランチ**: `888-c1-role-traits`

#888 子 1 の**第 11 束**。`OutProcRole` トレイトとその 2 実装、`StreamGuard`、
リトライ付き push（696 行）を `engine_wrap/role.rs`（483 コード行）へ。
🔴 **`engine_wrap.rs` が 1,000 行を切った**（1,468 → **995** コード行）。

### 🔴 トレイトの中では `pub(super)` が使えない

一括で `pub(super)` を付けたところ **E0449「visibility qualifiers are not permitted here」が 33 件**
出た。トレイト定義の本体とトレイト実装ブロックのメソッドは、**可視性がトレイト側で決まる**ので
修飾子を書けない。これまでの束は inherent impl（`impl EngineWrap`）だったので出なかった。

**対処**: 正規表現で構文を判定するのをやめ、**コンパイラの指摘行をそのまま使って**外した。
`cargo clippy` の出力から `role.rs:<行>` を抜き、その行の `pub(super) ` を削るループを回して収束させた。
同じ手法を「フィールドが private」47 件にも使い、エラーメッセージから
`struct 名 + フィールド名` を抜いて該当行だけに付けた。

**再エクスポート 2 件**: `DeviceSwitchRequest`（`main.rs` から）と `ClapPluginRole`（`session.rs` から）。

**検証**: cfg 4 象限緑 + `clap-host` 単独 / `cargo fmt --check` / `cargo test` 58 passed /
`npm test` **2,445 passed**（不変）/ lint / `docs:check` 948 引用 0 failed。


### refactor(daemon): move the instrument slot types and plugin UI wiring out (Sep 12, 2026)

**Date**: 2026-09-12 / **ブランチ**: `888-c1-instrument-slot-types`

#888 子 1 の**第 10 束**。instrument slot の型群とプラグイン UI の配線（606 行）を 2 ファイルへ
（`instrument_slot_types.rs` 392 / `plugin_ui_wiring.rs` 144）。
`engine_wrap.rs` は **1,989 → 1,468** コード行。

**可視性**: `pub(super)` を 63 箇所（第 9 束の知見どおり**フィールドにも**）。
`PluginUiWiring` 等 5 つは `outproc_effect.rs` / `outproc_respawn_guard.rs` からも使われるので
`pub(crate)` のまま、親から再エクスポート。

🔴 **再エクスポートの cfg を狭く書いて 1 象限落とした。** `outproc-instrument` と書いたが、
定義側は `any(outproc-effect, outproc-instrument)` だった。**cfg は定義側と一致させる** —
第 9 束と同じ誤りを繰り返した。

**検証**: cfg 4 象限緑 + `clap-host` 単独 / `cargo fmt --check` / `cargo test` 58 passed /
`npm test` **2,445 passed**（不変）/ lint / `docs:check` 948 引用 0 failed。


### refactor(daemon): move the effect slot types and env parsing into a child module (Sep 12, 2026)

**Date**: 2026-09-12 / **ブランチ**: `888-c1-effect-slot-types`

#888 子 1 の**第 9 束**。`OutProcControl` / `EffectSlotEntry` / `BusKind` 系の型と
`ORBIT_*` 環境変数の解析（512 行）を `engine_wrap/effect_slot_types.rs`（390 コード行）へ。
🔴 **`engine_wrap.rs` が 2,000 行を切った**（2,362 → **1,989** コード行）。

### 🔴 構造体フィールドの可視性 — 第 8 束より一段深い

第 8 束は関数と型に `pub(super)` を付ければ済んだが、本束は **187 件が「フィールドが private」**
のエラーだった。親が構造体のフィールドを**直接触っている**ため、**フィールド 44 個**にも
`pub(super)` が要った（関数・型 30 個と合わせて 74 箇所）。

### 🔴 `session.rs` からの外部参照 — 再エクスポートが要った

`BusKind` / `BusLineDest` / `BusLineOp` / `SourceRoutingTarget` は **`session.rs` が
`crate::engine_wrap::` から名前で import** していた。親から `pub(crate) use` で再エクスポートした。

**cfg は定義側と一致させる必要があった**: `SourceRoutingTarget` だけ
`any(test, all(outproc-effect, outproc-instrument))` で他の 3 つと条件が違い、
まとめて 1 行にすると default ビルドで `unresolved import` になった。

### 🔴 引用の追随に新しい型が出た — 行番号ではなく**本文**が変わる

`pub(super)` を付けると**引用しているコード行そのものが変わる**。`--fix` は行番号しか直さないので
効かない。1 行ずつ置換したが**収束しなかった**（8 ラウンド回して残った）ので、
**引用ブロックの本文を実ファイルから再生成する**スクリプトを書いて解決した
（scratchpad の `resync-citations.mjs`）。差分は追加 40 / 削除 40 で対応しており、
**引用の追随以外の変更が無い**ことを確認済み。

**検証**: cfg 4 象限緑 + `clap-host` 単独 / `cargo fmt --check` / `cargo test` 58 passed /
`npm test` **2,445 passed**（不変）/ lint / `docs:check` 948 引用 0 failed。


### refactor(daemon): move the out-of-process slot helpers into child modules (Sep 12, 2026)

**Date**: 2026-09-12 / **ブランチ**: `888-c1-slot-helpers`

#888 子 1 の**第 8 束**。`impl EngineWrap` の**外**にある自由関数・小さな型（598 行）を
2 ファイルへ（`slot_helpers.rs` 397 / `slot_errors.rs` 122）。
`engine_wrap.rs` は **2,857 → 2,362** コード行。

### 🔴 これまでの束と性質が違う — モジュールレベルの item

第 1〜7 束は `impl` の**メソッド**を動かしてきたが、本束は**モジュールレベルの item**
（自由関数・`enum`・`struct`・`type`）が対象。2 つの新しい対処が要った:

1. **`pub(super)` を 35 箇所**に付けた（モジュールレベル 22 + `impl` 内 13）。
   メソッドと違い、自由関数は親と兄弟の両方から名前で呼ばれている
2. 🔴 **`use slot_helpers::*;` を親に足す必要があった。** `pub(super)` は**可視性を上げるだけで、
   名前をスコープへ持ち込まない**。これが無いと `cannot find function ... in this scope` になる

### 🔴 `clap-host` 単独ビルドで import が未使用になった

このモジュールの item は全部 `#[cfg(any(outproc-effect, outproc-instrument))]` なので、
`clap-host` 単独だと**中身が空になり `use super::*;` が未使用**になる。CI は `-D warnings` なので
落ちる。`#[allow(unused_imports)]` を付けた（中身が feature 次第で空になるモジュールの定型）。

### rustfmt の折り返し

`pub(super)` を足すと行が長くなり、rustfmt が引数の折り返しを要求する。
該当パッケージにだけ `cargo fmt` をかけた（`git diff --stat` で**他のファイルが変わっていない**ことを確認済み）。

**検証**: cfg 4 象限緑 + `clap-host` 単独 / `cargo fmt --check` / `cargo test` 58 passed /
`npm test` **2,445 passed**（不変）/ lint / `docs:check` 948 引用 0 failed。


### refactor(daemon): move the startup variants into child modules (Sep 12, 2026)

**Date**: 2026-09-12 / **ブランチ**: `888-c1-start-lifecycle`

#888 子 1 の**第 7 束**。cfg feature ごとの `start*()` variant（645 行）を 2 ファイルへ
（`startup.rs` 292 / `startup_instrument.rs` 276）。
`engine_wrap.rs` は **3,417 → 2,857** コード行。

**可視性の変更 2 行**（E3′）: `resolve_outproc_both_buffer_frames`（親のテスト 3 箇所）と
`start_outproc_both_with_options`（親に残る `start_with_options`）。

### 🔴 抽出範囲を 2 度取り違えた — 複数行属性の罠

`#[cfg(all(\n  feature = …,\n  …\n))]` は**複数行に跨る 1 つの属性**である。
`pub fn` の行から遡って「`#[` で始まる行」だけを見ると、**属性の途中で切ってしまう**。
実際 2 度失敗した:

1. 終端を 5657 に取り、`))]` だけを親に残した → **`expected item after attributes`**
2. 開始を 5017（`pub fn` の行）に取り、`#[cfg(all(` 〜 `))]` を親に残した → 同じエラー

**正しい境界**は「doc コメントの先頭」から「次の item の属性が始まる直前」。
第 4 束の doc コメント分断（fmt でしか気づけなかった）と違い、**こちらはコンパイルエラーになる**
ので気づける。属性の分断と**コメントの分断は検出可能性が違う**。

**検証**: cfg 4 象限緑 + `clap-host` 単独 / `cargo fmt --check` / `cargo test` 58 passed /
`npm test` **2,445 passed**（不変）/ lint / `docs:check` 948 引用 0 failed。


### refactor(daemon): move device switching and Link tempo into a child module (Sep 12, 2026)

**Date**: 2026-09-12 / **ブランチ**: `888-c1-device-link`

#888 子 1 の**第 6 束**。オーディオデバイス切替と Link テンポ（317 行）を
`engine_wrap/device_link.rs`（242 コード行）へ。
`engine_wrap.rs` は **3,655 → 3,417** コード行。

**可視性の変更 2 行**（E3′）: `record_stream_config`（親の `finish_start` から）と
`record_device_switch_result`（親のインラインテスト 3 箇所から）を `pub(super)` に。

🔴 **第 5 束の教訓を仕組みにした**: 抽出範囲の開始を手で選ぶのをやめ、
**doc コメントと属性を遡って item の真の開始行を求める関数**で決めた。
第 4 束の doc コメント分断は、開始行を目で選んだために起きていた。

**検証**: cfg 4 象限緑 + `clap-host` 単独 / `cargo fmt --check` / `cargo test` 58 passed /
`npm test` **2,445 passed**（不変）/ lint / `docs:check` 948 引用 0 failed（1 件を再アンカー）。


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
- [2026-09（前半・09-01〜09-12）](../archive/WORK_LOG_2026-09.md) — #883 束 C のレビュー round 1、#883 束 S / 本体 (#883)、#888 子 1、#878 を含む
