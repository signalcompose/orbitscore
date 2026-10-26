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

### docs(user-site): classify every chapter by host and label the extension-only paragraphs (Oct 26, 2026)

**Date**: 2026-10-26 / **ブランチ**: `claude/practical-shannon-91kqon-d2`（D-① の上に積む）/ **Issue**: [#848](https://github.com/signalcompose/orbitscore/issues/848)（計画 §7.1 の D-②・docs の連続 PR ②）

D-① の文法と lint に従って、user サイトの全章に `host:` を入れ、配布線で操作が違う段落を併記の形にした（別冊 §3 の表どおり・裁定 (20) A + owner の条件）。

- **frontmatter**: ja / en の 42 章に `host:`。`both` 17 / `both+split` 3（`first-sound` / `engine-settings` / `troubleshooting`）/ `ext` 1（`installation`）。別冊 §3.2 の表と同じ
- **併記**（`- **OrbitScore**:`・ja / en 共通。owner の指定で最初の `拡張版` / `Extension` から改名）: `index`（動作環境）・`live-coding`（`Cmd+Enter` をどこで押すか）・`instrument` / `effects`（Rescan Plugin Catalog）・`routing`（クイックフィックスの電球）・`engine-settings`（Output Device の一覧）・`troubleshooting`（電球・デバイス・報告に書くもの）・`first-sound`（用意するもの）
- **分割節の印** `<!-- host: ext -->`: `first-sound` のステップ 2・3 と「VS Code 拡張機能が起動しているか」/ `engine-settings` の「エンジンの起動と停止」/ `troubleshooting` の「VS Code で `Cmd+Enter` が動かない」。印は見えないので、見出しか最初の文で VS Code の手順と分かるようにした
- 🔴 **OrbitStudio の行は書いていない**: アプリの表面は「参照（作り直してよい）」で未確定（設計 848 §7.4）。今書くと拡張版の読者が読むページに未確定の OrbitStudio の情報が載る（owner (20) の条件に反する）。表面が決まった時（A-parity）に `- **OrbitStudio**:` を足す。PR で owner に確認する
- **主語**（`index` の「VS Code の上で」・`first-sound` の冒頭など）は A-parity 後（(20) A）なので触っていない。可用性の行（軸 B）は OrbitStudio の版が無いので書いていない
- lint の `HOST_MISSING_BASELINE`（D-① の暫定）を仕組みごと消した。`midi/link-audio.md` が拡張版のハーネスの旧称 `orbitstudio-mcp-gated.spec.ts` を出典に挙げていて AV-HOST-SCOPE が反応したので、旧称の識別子 2 つを除外する修正を D-① に入れた
- 確認: `npm run docs:check` 緑・`npm run docs:build:user` 成功（印は HTML に出ない）・実サイトを 4 通り壊して lint の red を確認

Part of #848

---

### docs(user-site): add the availability notation grammar and its lint (Oct 26, 2026)

**Date**: 2026-10-26 / **ブランチ**: `claude/practical-shannon-91kqon-d1` / **Issue**: [#848](https://github.com/signalcompose/orbitscore/issues/848)（計画 `IMPLEMENTATION_PLAN_NATIVE.md` §7.1 の D-①・docs の連続 PR ①）

user サイトを拡張版と OrbitStudio の両方に向けた 1 本の文書として保つための、可用性表記の文法と lint を入れた（別冊 `848-docs-structure-design.md` §3.4・§5・裁定 (16) A）。章への書き込みは次の PR（D-②）。

- **文法**: `sites/user/STYLE_GUIDE.md` に「可用性表記」の節 — frontmatter `host:`（`both` / `app` / `ext` / `both+split`・必須）・分割節の印 `<!-- host: ext|app -->`（見出しの次の行）・段落の併記（`- **OrbitScore**:` / `- **OrbitStudio**:`）・可用性の行（`> **対応**:` / `> **Availability**:` の固定 5 形）。配布線の名前は owner の指定（拡張版 = **OrbitScore** / DSL = **OrbitScore DSL** / ネイティブ版 = **OrbitStudio**・ja / en 共通）。最初は `拡張版` / `Extension` で書いたので、旧い名前の併記の行は `AV-TERM` で red にした
- **lint** `sites/user/scripts/check-availability.mjs` を `npm run docs:check` に連結（CI の `Check doc citations` で走る）。規則 `AV-HOST` / `AV-SYNTAX` / `AV-PLACE` / `AV-UNRELEASED`（`--release` で red）/ `AV-I18N` / **`AV-HOST-SCOPE`**（owner (20) の条件・台帳 P-13）/ `AV-TERM`
- **設計との差 2 点**（別冊を同じ PR で改訂）: AV-HOST-SCOPE を `both+split` の章にも掛けた / 分割節の印を見出しの**次の行**に置く（見出しの行に置くと VitePress が `aria-label` に印の文字列を入れることを `createMarkdownRenderer` で確かめた）
- **暫定**: 章にはまだ `host:` が無いので、lint の `HOST_MISSING_BASELINE`（42 章）で許し、D-② がこの一覧ごと消す。一覧は減らす方向にしか通らない（`host:` を持った章が残っていても、無い章が増えても red）
- **テスト** `tests/docs/check-availability.spec.ts`（40 件）: 一時ディレクトリに章を作り `--root` で lint を走らせる。STYLE_GUIDE の 5 形 × 2 言語がそのまま通ることも検査する（文書と lint の二重管理を作らない）。lint 側を 6 通り壊して（AV-HOST-SCOPE の無効化・`both+split` 除外・下位の節への継承なし・併記の行を許さない・`--release` 無視・空行検査なし）それぞれ red を確認
- `.husky/pre-push` の失敗文言に可用性表記の lint を足した

Part of #848

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

### feat: implement random pitch r / rr / random.<mode> (#967) (Sep 26, 2026)

**Date**: 2026-09-26 / **ブランチ**: `967-random-pitch-impl` / **Issue**: [#967](https://github.com/signalcompose/orbitscore/issues/967) / #969

設計 `docs/design/967-random-pitch-design.md` の実装。実装 = Codex（段ごとに発注）/ 監視と sandbox 外の検証 = main。

**段 1: パーサ**（Commit: `dfaa9434`）
- `r` / `rr` を `play()` 直下・`( )`・`{ }`・`[ ]` のどこでも同じ `random_degree` ノードとして読む（修飾子は既存の度数と同じ `parsePitchModifiers` を共有・`parser-utils.ts` へ移設）。`play()` の要素の位置だけで有効（`ExpressionParser` の `playElementContext`）なので `gain(r)` / `gain(r1%3)` / `pan(r0%10)` は不変
- `r<数字>` は後ろに `%` が続く時だけ乱数値、それ以外は名前参照（K13）
- `var X = random.<名前>` を `random_binding` 文として、ミキサー宣言の先読みより**前**で判定（今まで `random.sum` がミキサー宣言として受理されていた）
- `var r` / `var rr` / `_r` / `random.mode(...)` はパースエラー。名前参照の `^r` `~` `@v` `@g` は記録のみ（評価は段 2）
- #969: `mode(0, …)` をパースエラーに（今までは格子が NaN）
- テスト: 2589 → 2604 passed（新規 `tests/parser/random-degree.spec.ts` 15 件・先に red を確認）。既存の期待値の変更は `m7^1` の `chord_ref` に `rangeSet: true` が付く 1 行のみ

**段 2: 評価・timing・出力段**（Commit: `c07b85e5`）
- `random_binding` を評価して名前空間に `kind: 'random'`（格子と period を定義時に写し取る）。E3 / E4 / E6
- 名前参照の解決: ランダム音源は修飾子を引き継いだ格子つきのランダム度数へ（`r1^1` もスティッキー）。chord / pattern への `^r` `~` `@v` `@g` は E8。W2 / W3 / E5
- chord 変数の中の `r`（`var c = [1, r, 5]`）もランダム声部として持ち運ぶ（設計文書に無かった点を main が補った・K1 に揃える）
- voicing: `.close/.open/.shell/.rootless` は E7、`.drop/.invert` は許可。`.voicelead()` はランダム声部を計算から外す
- timing はランダム度数を格子つきの TimedEvent にする。**audio シーケンスではイベントを作らない**（オンセット数・時刻は不変を回帰テストで固定）+ W4
- 選択は出力段 Stage A（`midi/random-degree.ts`）で TimedEvent 1 件・ループ反復ごと。格子は 音源 → スコープの mode → Ionian の順
- ファイルサイズのラチェットを増やさないため `midi-planning.ts` / `process-value-binding.ts` を切り出し、baseline は 3 件とも**減った**（sequence 1369→1362 / process-statement 554→520 / parse-expression 1000→997）
- テスト: 2604 → 2639 passed（新規 `tests/midi/random-degree.spec.ts` 35 件。統計は N=20・重みは N=200 の二項 99.9% 区間。1 音の格子で「2 種以上」の判定が落ちるオラクル識別テストつき）

**段 3: 実機 E2E・台帳・ドキュメント**（Commit: `91d9c2d0`）
- `DslSyntaxId` に `random-pitch` / `random-binding` を追加し、台帳に `capture-pitch` で登録
- gated E2E 3 本（共有セッション群の末尾）: `random.two` と `(r, …).mode(two)` で 16 音を鳴らし、オンセットを追う窓で**全音が C4 / G4 の ±2%** かつ**両方が出る**（集合一致なので常に同じ音を返す実装は落ちる）/ `random.nope` の E3
- 実機の gated E2E 全件: **52 passed**（2026-10-04・915 秒）
- ユーザー向けサイト（日英）の `voicing.md` / `methods.md` に `r` / `rr` / `random.<mode>`。仕様書の「🚧 未実装」表記を「実装済み（4.3.0）」へ。#969 はパースエラーと明記
- dev サイトの引用: 行ずれ 26 ファイルを `--fix`、中身が変わった 4 組（日英 8 件）は今のコードに差し替え
- 🔴 未解決の観測（2026-09-26）: 隔離した VS Code（1.139.1）でエンジンを起動すると約 10〜20 秒後にウィンドウが黙って閉じる症状が出た（出荷済み 4.2.1 でも再現・今回の変更とは無関係）。10-04 の再実行では起きず、原因は未確定

**/simplify の修正**（Commit: `3f736d90`）— 4 観点（再利用・簡潔さ・効率・修正の深さ）のレビューを main が集約し Codex へ一括発注:
- 段 1・2 のモジュール切り出しで落ちた説明コメント（doc 9・インライン 3）を `origin/main` の原文どおり復元。ラチェットはコメント専用行を数えないので、落とす必要はなかった
- `emitRandomDegrees` を timing の再帰 6 か所へ位置引数で引き回すのをやめ、timing は常にイベントを作り、**`isNoteSequence()` を知る呼び出し元（`Sequence` の 2 か所・呼び出し元はこの 2 つだけと列挙済み）で audio のときだけ除く**。新しい分岐で引き回しを忘れて audio が鳴り出す事故を構造で防ぐ。`( )` / `{ }` / `[ ]` の audio 回帰テスト 3 件を修正前に測った値で固定
- `parseSignedNumber` の二重実装を一本化 / 修飾子コピー 4 か所をヘルパーへ / `evaluateChord` の別名 export を import 別名へ / 出力段の `[...lattice]` 毎回コピーをやめる / テストの準備を共通化
- 見送り: `kind` 判定の共通述語化（差分の外の既存コードに広がる）
- テスト 2639 → 2642 passed。baseline は `global.ts` 1103→1101 / `parse-expression.ts` 997→990 と**減少**

**レビュー ラウンド 1 の修正**（Commit: `699a35fb`）— `/code:pr-review-team`（4 名: Critical / Important 0）と **Opus 監査（Important 3）**を並行投入。Important はすべて監査側が実測で発見:
- 🔴 **I-3**: `play()` を `.midi()` / `.instrument()` より前に書くと乱数の音が黙って消え、誤った W4 が出た。audio / note を `play()` の評価時に判定していたため（段 2 の作りと /simplify の作りの両方に共通）。**方針を先に決めて一括適用**: 判定は出力（dispatch）の時点。timing はランダム度数を `sliceNumber: 0`（書かれた休符と同じ）の TimedEvent にし、audio は既存の「`sliceNumber > 0` だけ鳴らす」規則で構造的に鳴らさない。W4 は audio の出力経路（`isNoteSequence()` の早期 return の後ろ）でだけ出す。audio 回帰 4 件は「`0` を書いた場合と鳴り方が完全に同じ」へ強化
- I-1: ファイル import の宣言名の列挙から `random_binding` が漏れていた（`RandomBinding` のフィールドを他の束縛と同じ `variableName` に揃えて再発を防ぐ）
- I-2: chord 定義の中の `-1` がランダム声部まで消していた（内部表現の `degree: 1` に一致）
- Minor: `r1^1.r(p)` のスティッキー喪失 / `[r*2, 1]` の内部エラー（main と同じパースエラーへ）/ エディタが `random.sum` をミキサーとして読む / chord・pattern 参照の末尾 `r` が黙って消える（E8 へ）/ テスト 2 件の判定と名乗りのずれ / 消し残しの doc コメント
- テスト 2642 → 2651 passed。赤 → 緑を各修正で確認。設計文書 §3.10 を新方針に改訂

**レビュー ラウンド 2 の修正**（Commit: `39b96a3a`）— コードレビュー役 0 件 / bot なし / **Opus の fix 差分再監査が fix 起因の Important 1 件**:
- R2-1: `[ ]` の声部の `r1^1.r(p)` が running range を書き換えていた（ラウンド 1 の M-1 修正の分岐が、stack の声部かどうかを知らなかった）。stack の声部では structural として解決
- R2-2: 段 1 で stack の声部にも後置チェーンを通したため `[m7.drop(2), 5]` などが通っていた（main はパースエラー）。stack の声部の後置は `.r` / `.r(p)` だけにした。🔴 Codex の 1 回目は「名前が `r`+数字の形か」で受け付けを決めており、`var lead = random.dorian` の `[lead.r(1), 3]` がパースエラーになった（名前は利用者が自由に付ける・K3 / K13 違反）。2 回目で「パース時は名前を問わず受け付け、束縛の種類が分かる評価時に chord / pattern ならエラー」へ（E8 と同じ考え方）
- テスト 2651 → 2659 passed
### docs: follow the #967 random pitch spec into the dev learning site (#971 follow-up) (Sep 25, 2026)

> **2026-10-05 追記（main がマージ時に補正）**: 本 PR が書いた adr-002 の Note「`r` / `rr` / `random.<mode変数>` は spec が確定しただけで未実装」は、PR #973（実装・拡張 4.3.0）のマージで事実と食い違ったため、`main` を取り込む際に「#973 で実装・4.3.0 で出荷」へ直した。

**Date**: 2026-09-25 / **ブランチ**: `claude/docs-sync-pr971` / **追従元**: PR [#971](https://github.com/signalcompose/orbitscore/pull/971)（merge commit `0bab20a`）

PR #971（#967 の spec 確定・docs のみ）の追従。#971 自身が specs-v2 / core spec / WORK_LOG / planning と
`sites/dev/signal-chain/mixer-audio-line.md` の `// FILE:` 引用 2 件までは直しているので、**残っていた 2 種類だけ**を扱った。

**1. ADR-002 の未解決項目に答えを入れた**（`sites/dev/decisions/adr-002-dsl-v3-pivot.md` + `en/`）

「次の深掘り候補」にあった「`randseed` のサポート状況 — v1.0 にあったランダム性制御が v3.0 / Pitch DSL に
引き継がれているか」は、#971 の `SESSION_LOG_SPEC_v1.md` §5 の訂正（旧記述「現行 v3.0 にランダム機能は存在しない」は誤り）で
答えが確定した。v1.0 の `1r` の説明の直後に追記し、候補リストからは外した。

- ランダム性そのものは引き継がれている（Pitch DSL の `Xr` / `.r` / `^r` と audio の `gain(r)` / `pan(r)`）
- ただし **`1r` の「音高そのものを乱数で選ぶ」性質は引き継がれていない**。度数の乱数 `r` / `rr` / `random.<mode変数>` は
  #967 で spec が確定しただけで未実装（PITCH_DSL_SPEC §6.2.1・決定 #80〜#84）
- `randseed` は今も持たない方針（決定 #21 / #50）

**2. `INSTRUCTION_ORBITSCORE_DSL.md` への行番号参照を張り直した**

#971 が同ファイルの 1166 行目付近に P.12.1 を挿入して以降の行が +27 ずれた。`// FILE:` 形式ではないため
`docs:check` の対象外で、red にならないまま残っていた。

- `sites/dev/signal-chain/mixer-audio-line.md` + `en/` の Sources: `:1313-1325` → `:1340-1352`（内容は挿入前と一致を確認）
- `sites/dev/decisions/adr-002-dsl-v3-pivot.md` + `en/` の Sources: `:1983-2035` → `:2309-2364`

🔴 後者は **#971 以前から記述と中身が食い違っていた**（「§13 Versioning」と書いてあるが、`1983-2035` が指すのは
ミキサー / wire の節）。§13 Versioning の実体は現在 2309-2364 なので、参照の説明文が名指ししている節へ合わせた。
判断の根拠は行番号の照合だけで、仕様の判断は含まない。

**追従不要と判断したもの**: `sites/user/` `docs/user/ja/USER_MANUAL.md`（#967 は未実装。出荷済み 4.2.1 の読者が
到達できない機能を案内しないため）/ `sites/dev/` の editor 章（凍結版の差分なし）/ `docs/design/` `docs/archive/`
`docs/research/`（起案時点のスナップショット）。

**検証**: `npm run docs:build`（user / dev）+ `npm run docs:check` — 詳細は PR 本文。

---

### docs: specify random pitch selection r / rr / random.<mode> for the Pitch DSL (#967) (Sep 25, 2026)

**Date**: 2026-09-25 / **ブランチ**: `967-random-pitch-spec` / **Issue**: [#967](https://github.com/signalcompose/orbitscore/issues/967) / **Commit**: `4d8723ea`

Pitch DSL に「音高そのものをランダムに選ぶ」指定を加える仕様を確定した（docs のみ・実装は後続 PR、拡張 4.3.0 の想定）。
起案 = fresh Opus subagent（初版は候補リスト `r[…]` を推奨）→ owner が表面を決定 → 改訂 r2 → main 審査 → owner の最終決定。

**確定した表面**: 度数の位置に `r`（その音のスコープの格子から選ぶ。root = Ionian 1〜7 / mode = 格子全長）・`rr`（出現確率 0.5）・
`var r1 = random.<mode変数>`（ユーザー定義の mode を定義時に写し取るランダム音源。`random.mode(...)` や組み込みの旋法ライブラリは入れない）。
`^N` はスティッキー、振り直しは既存の `Xr` / `^r` と同じく発音ごと・サイクルごと・seed なし。audio シーケンスの意味は変えない。

**変更したファイル**:
- `docs/design/967-random-pitch-design.md`（新設）— 決定表・一次ソースの事実・意味論・診断・テスト計画・棄却案
- `docs/specs-v2/PITCH_DSL_SPEC_v1.1.md` — §2.1 / §2.2 / §3・§9.3（`seq.mode()` 未実装の明記）/ §6.1 / §6.2・§6.2.1（新設）/ §6.3
- `docs/specs-v2/DESIGN_DISCUSSION_RECORD.md` — §12.4 の位置の表に 2 行、§16 と決定 #80〜#84（#82 は #50「語彙を増やさない」の例外として `random` を記録）
- `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` — P.12.1（spec 確定・未実装と明記）と実装状況の要約
- `docs/specs-v2/SESSION_LOG_SPEC_v1.md` §5 / `docs/core/INDEX.md` の設計ノート表

**起案の過程で直した既存の不整合**（文書側のみ）:
- core spec P.12 の「`.r` は全声部を一緒に間引く」→ 実装どおり「声部ごとに独立」（`calculate-event-timing.ts:212-216`, `sequence.ts:1607`）
- core spec の「`r0%10` (random walk)」→「center ± range の一様乱数・直前値を持たない」（`random-utils.ts:16-25`）
- SESSION_LOG の「現行 v3.0 にランダム機能は存在しない」→ 現状に合わせて訂正

**別 issue に切り出したもの**: `Xr(p)` 未実装で `5r(p)` が並置として読まれる（#968）/ `mode(0, …)` が NaN の格子になる（#969）/ `seq.mode()` 未実装（#970）。

**レビュー反映**（Commit: `ff2d190c`）— docs のみなのでレビュー方法は advisor と相談し、main の設計文書通読 + fresh Opus 1 体の整合監査（記述の一致 / 根拠の実在 / 先取りの決定）とした:
- 🔴 旋法ライブラリを「無い／持たない」と書いていたのは、確定済みの決定 #58（教会旋法はライブラリ var 群）を黙って上書きしていた。owner の「組み込み変数じゃなくて定義した mode を…」は `random.` に渡すものの話なので、「定義なしで動く組み込みの `random.dorian` は無い・#58 は変えない」に改めた
- chord の名前参照への `@v` / `@g` をエラーに固定していたのは、open の #609（stack 全体への `@v`・owner 裁定済み・未実装）の先取り。#609 で決めると明記
- `rr` と `r r` は「同じトークン列」ではない（`rr` は 1 識別子）。意味が同じと改めた / DDR #81 の「パターン変数と同じ値渡し」は誤り（写し取るのは chord だけ）
- 同じ PR の編集でずれた設計文書の行番号 10 箇所を追従
- 地図に居場所が無かったので `DEVELOPMENT_MAP.md` §4.Q を新設し、凍結後の拡張版に新機能を載せる **owner の例外**を `NATIVE_MIGRATION_2026-09.md` §12.8 に記録
- 別件: issue 状態のスナップショット（09-08 生成）を更新すると、`DEVELOPMENT_MAP.md:1580`（閉じた #474 を「未実装」と書く行）がラチェットに掛かる。本 PR の範囲外なので更新はしていない
### docs: follow the v4.2.1 bump into the dev-site follow-up Notes (Sep 18, 2026)

**Date**: 2026-09-18 / **ブランチ**: `claude/docs-sync-pr962` / **追従元**: PR [#962](https://github.com/signalcompose/orbitscore/pull/962)（merge `c90bb15`）

#### 何が食い違っていたか

#962 は dev サイト 6 章（3 章 × ja/en）の**本文の版表記**を 4.2.0 → 4.2.1 へ更新したが、
同じファイルの `:9` にある**追従履歴 Note** は「v4.2.0 のリリースまで追従しました」のままだった。
Note は**過去の記録**なので #962 が触らなかったのは方針として正しい（PR 本文「意図的に触らない」）が、
**本文を動かした以上、その追従自体が記録されるべき 1 件**である。結果として、同一ファイル内で
本文が 4.2.1・Note が「4.2.0 まで」と食い違って残っていた。

この Note は版表記を前へ送るたびに 1 文を追記する運用になっている（#928 の 4.1.0・#941 の
v4.2.0 がそれぞれ 1 文ずつ積まれている）。同じ規約どおり v4.2.1 の 1 文を追記した。

#### 触っていないもの

| | |
|---|---|
| frontmatter `verified-against` / `verified-at` | **動かさない**。`ca745e8` / 2026-09-12 のまま。版表記だけの追従では全章を再検証していないので、動かすと検証範囲を過大に主張することになる。#928 / #941 の版表記追従でも動かしていない（Note は 09-13 / 09-14 を記録しているのに frontmatter は 09-12 のまま）という既存の運用に合わせた |
| 各章の読解本文 | 拡張は機能凍結（現 4.2.1）。editor 章は 4.2.0 時点のスナップショットとして扱う方針のため、Note 以外は触っていない |
| `docs/specs-v2/` / `sites/user/` / `docs/user/` | 拡張の版を 1 箇所も名乗っていない（`git grep` で 0 件）ので追従不要 |

#### 検証

```
npm run docs:check                          → 996 citations verified, 0 failed
npm run docs:build -w @orbitscore/user-site → build complete（dead link 0）
npm run docs:build -w @orbitscore/dev-site  → build complete（dead link 0）
```

---

### chore(release): bump the extension to 4.2.1 (Sep 18, 2026)

**Date**: 2026-09-18 / **ブランチ**: `961-release-4.2.1` / **Issue**: #961

#### なぜ patch か

**利用者に届く挙動の変化は 1 つだけ**で、DSL の表面・wire・出力の意味論は変えていない。

> 🔴 **cold install した `.vsix` で Docs パネルと user サイトの MCP ツールが使えるようになる**
> （#954 / PR [#955](https://github.com/signalcompose/orbitscore/pull/955)）

4.2.0 までは**出荷物にサイトのデータが 1 バイトも入っていなかった**（`unzip -l` で実測・`sites/`
のエントリが 0 件）。それなのにパス解決がモノレポ前提だったので、Marketplace / GitHub Release
から入れた利用者には**機能そのものが届いていなかった**。`.vsix` は **+2.5 MB**（9,876,835 →
12,385,004 bytes）。

同時に入った開発側の修正（**出荷物には影響しない**）: `.git/config` 汚染バグ（#951 / PR #956）・
呼称統一（#948）・`CHANGELOG.md` の 7 版分の遡及（#959）。

#### 🔴 版の掃除 — 「番号を固定して形を仮定しない」を今回も守った

過去 4 回連続で取りこぼしている（`README.md:55` / `docs/core/INDEX.md:5` / 強調記法を狙った
grep など）。今回は **素の `4.2.0` で数え、更新後は「古い番号が 0 件になったこと」で検算**した。

🔴 **道具も変えた**: `grep -rn` ではなく **`git grep`** を使う。worktree・`node_modules`・
`.vitepress/dist` は**追跡対象外なので原理的に混ざらない**。本日 `grep -rn` の除外パターンを
**4 回間違えた**（ベース不一致の 2 木比較 / 引き算の重複 / `grep -o` の出力に周辺文脈を期待 /
`^./` の有無）末の結論で、**パスの形を仮定するより、対象集合が正しい道具を選ぶ**方が確実である。

| | |
|---|---|
| 更新した箇所 | **19**（正本 `package.json` + 現在の版を名乗る 18 箇所 / 11 ファイル） |
| 触っていない箇所 | 各 dev サイト章 `:9` の**追従履歴 Note** 6 件（「v4.2.0 のリリースまで追従しました」= 過去の記録）と `docs/archive/` と本ログ |
| 検算 | 現在の版を名乗る箇所に `4.2.0` が **0 件** |

#### CHANGELOG

`[Unreleased]` を `[4.2.1] - 2026-09-18` へ。#955 の記述に加えて `get_user_doc` /
`search_user_docs` の新設（Added）と、dev サイトを同梱しない方針（Changed）を足した。
リンク参照も `[4.2.1]` を追加し `[Unreleased]` の compare 基点を移した。

#### 検証

```
npm run docs:check                          → 996 citations verified, 0 failed, 54 files
npm run docs:build -w @orbitscore/user-site → build complete（dead link 0）
npm run docs:build -w @orbitscore/dev-site  → build complete（dead link 0）
```

マージ前ゲート（ビルド + cold install の実機）は PR で実施する。

Closes #961

---

### docs: backfill CHANGELOG.md for the 7 untracked releases v1.1.1-v4.2.0 (#959) (Sep 18, 2026)

**Date**: 2026-09-18 / **ブランチ**: `959-changelog-backfill` / **Issue**: [#959](https://github.com/signalcompose/orbitscore/issues/959)

`CHANGELOG.md` が `[1.1.0] - 2026-05-06` で止まっており、以降の 7 版（v1.1.1 / v2.0.0 / v3.0.0 /
v4.0.0 / v4.0.1 / v4.1.0 / v4.2.0・約 4 ヶ月分）が未記載だった。docs のみの作業（実装・テストは
変更なし）。各版のタグ間差分（`git log --first-parent`）と `docs/archive/WORK_LOG_2026-{05,06,09}.md`
の該当エントリを一次情報として遡及記載した。

**根拠にした主なエントリ**: v1.1.1 = WORK_LOG_2026-05 6.87/6.88 / v2.0.0 = WORK_LOG_2026-06 6.116・
6.131 / v3.0.0 = WORK_LOG_2026-09「release: tag v3.0.0」「chore(release): bump the extension to
3.0.0」 / v4.0.0 = WORK_LOG_2026-09「design: explicit output routing (#883)」 / v4.0.1 = 同
「chore(release): bump the extension to 4.0.1」 / v4.1.0 = 同「chore(release): bump the extension
to 4.1.0」 / v4.2.0 = `docs/development/WORK_LOG.md`「chore(release): bump the extension to 4.2.0」。

**確証が持てず個別コミット単位までは書かなかったもの**: v2.0.0→v3.0.0 間（239 マージコミット・
約 3 ヶ月）は Rust デーモン移行・プラグインホスティング・ミキサーグラフ等を主要ピラー単位で要約し、
網羅的な列挙ではない旨を明記。`[Unreleased]` は #212（quantize）の内容を [1.1.1] へ移し、
v4.2.0 以降の実際の未リリース変更（#955: user サイトの `.vsix` 同梱漏れ修正）に差し替えた。

検証: `CHANGELOG.md` を参照するテストは存在しない（`grep -rl CHANGELOG tests/` 該当なし）ため
`npm test` への影響は無い想定。docs のみの変更。

---

### docs(hooks): follow PR #956 — record the GIT_* leak guard on the pre-edit-hook fixture (Sep 18, 2026)

**Date**: 2026-09-18 / **ブランチ**: `claude/docs-sync-pr956` / **追従元**: PR [#956](https://github.com/signalcompose/orbitscore/pull/956)（マージコミット `0004d6b`）

#956 は `tests/repo/pre-edit-hook.spec.ts` と `docs/development/WORK_LOG.md` の 2 ファイルのみ
（+124 / -2）。**DSL・ランタイム / MCP・エディタのいずれの層にも表面の変更が無い**ため、
`docs/specs-v2/` / `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` / `sites/user/` / `docs/user/ja/` /
`sites/dev/` に追従対象は無い（分類理由は下表）。

ただし **`.claude/hooks/README.md` が当該 spec を名指しで説明している**ので、そこだけ揃えた。

#### 直したもの

| ファイル | 変更 | 対応する差分 |
|---|---|---|
| `.claude/hooks/README.md:47-69` | `sanitizedGitEnv()` を通す義務・`GIT_ENV_LEAK_KEYS` の列挙・汚染検出 describe を追記 | `tests/repo/pre-edit-hook.spec.ts:53-61, 64-67, 71-81, 181-188` |
| `docs/development/WORK_LOG.md:22` | #951 エントリの **ブランチ名を PR の head ref へ**（`worktree-agent-a3106dacd95436d4e` → `951-git-env-leak`）+ PR / merge SHA を追記 | PR #956 head `64255d4` / merge `0004d6b` |

`.claude/hooks/README.md` の「**テスト**」段落は、使い捨て repo を 2 つ作る理由（本物の HEAD に
依存させない）しか書いていなかった。#956 が足した制約 —「この spec から git を呼ぶときは
env から `GIT_*` を落とす」— は fixture を次に触る人が**知らないと踏む**種類のもので、
コード側のコメントにしか無い状態だった。

#### 追従不要と判断したもの

| 対象 | 理由 |
|---|---|
| `docs/specs-v2/` / `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` | DSL の構文・意味論に差分が無い（変更は `tests/` 配下のみ） |
| `sites/user/` / `docs/user/ja/USER_MANUAL.md` | ユーザーが書く語に変更が無い |
| `sites/dev/`（全 9 章） | git フック / husky / テスト fixture を扱う章が無い（`grep -rn "husky\|pre-commit\|git hook\|\.git/config" sites/` が 0 件）。したがって `sites/dev/en/` 側の追記も発生しない |

---

### docs: follow PR #955 — the two learning sites now differ in how they ship (Sep 18, 2026)

**Date**: 2026-09-18 / **ブランチ**: `claude/docs-sync-pr955` / **追従元**: PR [#955](https://github.com/signalcompose/orbitscore/pull/955)（マージコミット `3899456`・Issue [#954](https://github.com/signalcompose/orbitscore/issues/954)）

#955 は「`.vsix` にサイトのデータが 1 バイトも入っていない」を直した PR で、同時に
**2 つの学習サイトの配り方が初めて分かれた**（user = 同梱する / dev = 同梱しない）。
この決定は owner 裁定（2026-09-18）で、コード側にはコメントとして残っているが、
**サイトの運用を語る文書側には 1 行も入っていなかった**ので入れた。

#### 直したもの

| ファイル | 変更 |
|---|---|
| `docs/core/INDEX.md` Dev Learning Site 節 | dev サイトは `.vsix` に同梱しない旨と、cold install での `get_dev_doc` / `search_dev_docs` / 503 の挙動（`DEV_DOCS_UNAVAILABLE_MESSAGE`）を追記 |
| `docs/core/INDEX.md` User Learning Site 節 | user サイトは Markdown + dist の両方が同梱される旨、`scripts/copy-user-site.sh` の行、monorepo 優先の解決順を追記 |
| `docs/development/DEV_LEARNING_SITE.md` §6 | 2026-07-17 の「ローカル配信を 2 経路予定」に対し、**dev を同梱する経路は取らない**ことが確定した旨を表付きで追記 |
| `docs/development/USER_LEARNING_SITE.md` §6 | 「拡張への同梱」を Deployment の項目として追加（呼び出し元・package 後ゲート・best-effort でない理由・cold install 後の読み口） |

#### 直さなかったもの

- **`sites/dev/editor/mcp-and-gated-e2e.md:188`（および en 同行）の MCP ツール表** — ドキュメント系を
  `get_dev_doc` / `search_dev_docs` の 2 本として載せており、#955 で 4 本になった事実に追いついていない。
  ただし **OrbitScore（拡張版）は 4.2.0 で機能凍結**（owner 裁定 2026-09-18）で、editor 章は
  その時点のスナップショットとして扱う運用なので**意図的に触っていない**
- **`docs/design/*`** — 起案時点のスナップショット。`887-extension-split-design.md:395` のツール番号表などは
  そのまま
- **`sites/user/` / `docs/user/`** — DSL の語は 1 つも変わっていない。Docs パネルはそもそも
  ユーザー向け文書に登場しないので、陳腐化した記述が無い

#### 検証

`npm ci` / `npm run docs:build -w @orbitscore/user-site` / `-w @orbitscore/dev-site` / `npm run docs:check`
（出力は PR 本文）。sites/ に変更が無いため引用（`// FILE:START-END`）の再アンカーは発生していない。

---

### fix(test): pre-edit-hook.spec.ts の fixture が共有 `.git/config` を汚染しないようにする (Sep 18, 2026)

**Date**: 2026-09-18 / **ブランチ**: `951-git-env-leak`（作業は worktree `worktree-agent-a3106dacd95436d4e` 上） / **Issue**: [#951](https://github.com/signalcompose/orbitscore/issues/951) / **PR**: [#956](https://github.com/signalcompose/orbitscore/pull/956)（merge `0004d6b`）

#### 実害

husky の `pre-commit` → `npm test` → vitest → `tests/repo/pre-edit-hook.spec.ts` という経路で、
このリポジトリの**共有 `.git/config`** の `user.name` / `user.email` / `core.bare` が書き換わった。
`core.bare=true` になると **git 操作が一切できなくなる**（`fatal: this operation must be run in
a work tree`）。手で復旧したが、次に踏めば再発する状態だった。

#### 原因

`makeRepo()` が使い捨てリポジトリを作るための `git init` / `git config` / `git commit` を、
**env を明示せず**（= `process.env` をそのまま継承して）呼んでいた。git はフックを起動する際
`GIT_DIR` 等を子プロセスの環境変数として設定するため、husky 経由の実行では vitest プロセスが
それを継承し、そのまま子プロセスへ再継承される。`cwd` を使い捨てリポジトリに向けていても
`GIT_DIR` が優先されるため、**書き込み先がこのリポジトリの共有 `.git`（worktree 構成では
common dir）にすり替わる**。`npx vitest run tests/repo/pre-edit-hook.spec.ts` を直接叩くだけ
では git 自身がこれらの環境変数を設定しないため再現しない。

#### 直したこと

`tests/repo/pre-edit-hook.spec.ts` に `sanitizedGitEnv()` を追加し、ファイル内で git / フック
スクリプトを呼ぶすべての箇所（`makeRepo()` 内の `git()` ヘルパ、前提テストの `head()`、
`decide()`）に明示的に渡すようにした。除去対象は `GIT_DIR` / `GIT_WORK_TREE` /
`GIT_INDEX_FILE` / `GIT_OBJECT_DIRECTORY` / `GIT_ALTERNATE_OBJECT_DIRECTORIES` /
`GIT_COMMON_DIR` / `GIT_PREFIX`。個別キーの `-c user.name=...` 上書きではなく env 側を洗う
方向を選んだ — `git init` 自体が `GIT_DIR` の影響で書き込み先を変えてしまうため、
`-c` では `git init` の対象リポジトリのすり替わりまでは防げない。

#### 汚染検出テストを追加（受け入れ基準）

同ファイルに `describe('fixture はこのリポジトリの .git/config を汚染しない（#951）')` を追加。
fixture（`makeRepo`）が git を呼ぶ**前**に `git config --list --local`（このリポジトリの
ローカル分）のスナップショットを取り、全 fixture 実行後に再度読んで**丸ごと文字列比較**する。
個別キーを列挙して当てにいく形は取らなかった — #951 のコメントで「最初 `user.email` だけ見て
『復元した』と報告した後、`core.bare` も壊れていたことが判明した」実例があり、同じ轍を踏む。

#### 検証

- `npx vitest run tests/repo/pre-edit-hook.spec.ts --config vitest.config.ts` で 7 件全て green
  （既存 6 件 + 新規汚染検出 1 件）。実行前後で `git config --list --local` を手動比較し、
  差分が無いことを確認（`core.bare=false` / `user.email=yamato@gmail.com` /
  `user.name=Hiroshi Yamato` のまま）
- 🔴 **上記は直接実行であり、Issue が指摘する再現条件（husky 経由）を満たさない。** この
  コミット自体が `.husky/pre-commit` → `npm test`（フル suite・このファイルを含む）を通るため、
  **このコミットが成立すること自体が husky 経由の検証**になる。コミット後、
  `git config --list --local` を再確認して問題ないことを見た

#### 判断に迷った点

- 汚染検出テストを既存の `pre-edit-hook.spec.ts` に同居させるか、別ファイルに切り出すか。
  汚染源が `makeRepo()` というこのファイル固有の fixture なので、検出も同じファイルに置いた
  （汚染源と検出が離れると、将来 fixture を変更した人が検出テストの存在に気づきにくくなる）
- `GIT_ENV_LEAK_KEYS` の網羅性: git のドキュメントに載っている「リポジトリ発見・上書き系」の
  環境変数を挙げたが、将来 git が新しい環境変数を追加した場合はこの列挙から漏れうる。
  そのための保険として汚染検出テスト（全体比較）を独立に置いている

---

### fix(docs): bundle the end-user docs site into the .vsix so it survives a cold install (Sep 18, 2026)

**Date**: 2026-09-18 / **ブランチ**: `954-vsix-docs-bundling` / **Issue**: [#954](https://github.com/signalcompose/orbitscore/issues/954)

出荷済みの `.vsix` にサイトのデータが 1 バイトも入っていなかった（`unzip -l *.vsix | grep -c 'sites/'` が 0）。
Docs パネル（WebView）と `get_dev_doc` は cold install で死んでいた。原因は
`mcp-server.ts` の `__dirname/../../..` がモノレポのルート決め打ちだったこと
（インストール済み拡張にはそのパスが存在しない）。

#### 実装した 4 点（owner 裁定どおり）

1. **パス解決を候補リスト化**（`mcp-docs.ts` に `resolveDevDocsLocation` /
   `resolveUserDocsLocation` を追加）。daemon バイナリの解決
   （`daemon-client.ts` の `resolveDaemonBinaryPath`: explicit → env → monorepo → 拡張同梱）と
   同じ「候補を順に existsSync、最初に見つかったものを使う」流儀。**順序はモノレポを先に見る**
   （daemon と同じ順）— こうすると **モノレポ dev host の挙動は一切変わらない**
   （モノレポ候補が常に先に見つかる）。dev サイトは owner 裁定により**同梱しない**ので
   候補は 1 本のみ（`available` で存在有無を返す）
2. **user サイト（Markdown 45 ファイル + built dist）を `.vsix` に同梱**。
   `scripts/copy-user-site.sh` を新設（`copy-daemon-bin.sh` と同じ形: ビルド→コピー、
   `npm run build:copy-user-site` として root package.json に配線、
   `pretest:e2e:cold-install` と `release.yml` の両方から呼ぶ）。コピー先
   `packages/vscode-extension/sites/user/` は `.gitignore` へ追加（`engine/` と同じ扱い —
   ビルド成果物であり手で編集しない）
3. **dev 側の「黙って null」をやめる**。`DEV_DOCS_UNAVAILABLE_MESSAGE` を新設し、
   HTTP 503 の body と `get_dev_doc`/`search_dev_docs` のエラーメッセージの両方に使う
   （公開 URL `https://signalcompose.github.io/orbitscore/dev/` を含む）
4. **`get_user_doc` / `search_user_docs` を新設**（`get_dev_doc`/`search_dev_docs` と同じ形）。
   これで MCP 経由で LLM が user サイト（DSL の使い方）を読む経路ができた

#### 検証

- ユニット/統合テスト: `resolveDevDocsLocation` / `resolveUserDocsLocation` の純粋関数テスト、
  HTTP 経由の `get_user_doc`/`search_user_docs` ラウンドトリップ、`tools/list` の順序テスト
  （23→28 本へ更新）を追加。`npm test` 全件 2588 passed / 79 skipped（既存含め regression 無し）
- `npm run typecheck:e2e` / `npx eslint` とも green
- **実際に `.vsix` をビルドして実測**（このセッションの sandbox 内・`npm run build` は成功した
  — 事前の懸念だった `safe-chain` の EPERM は発生しなかった）:
  `unzip -l orbitscore-darwin-arm64-4.2.0.vsix | grep -c 'sites/'` = **247**（旧: 0）、
  `sites/dev` = **0**（意図どおり同梱していない）、`sites/user/index.md` と
  `sites/user/.vitepress/dist/index.html` の両方が存在。`.vsix` サイズ増分は実測 **+7.08 MB**
  （`vsce package` の内訳表示 `sites/ (247 files) [7.08 MB]`）
- パッケージ済み `.vsix` を展開し、`__dirname` を実際のインストール先レイアウトに見立てて
  `resolveDevDocsLocation`/`resolveUserDocsLocation` を直接叩いて確認:
  `dev.available=false`・`user.source='extension-bundle'`・`get_user_doc` 相当の読み出しが
  実際に本文を返すことを確認した
- 🔴 **VS Code を実際に cold install して起動する E2E（`tests/e2e/vsix-cold-install-gated.spec.ts`）は
  この worktree では走らせていない**（`ORBIT_GATED_COLD_INSTALL` 未設定でスキップ・実機検証は
  main が sandbox 外で行う）。同 spec に `assertDocsBundled`（`get_user_doc` 成功・`get_dev_doc` が
  理由付きエラー・`/orbitscore/` が 200）を追加済みなので、次の cold-install ゲート実行時に
  自動でこの経路もカバーされる

#### 判断に迷った点

- **候補の優先順（モノレポ先 vs 同梱先）**: issue の見出しは「同梱優先 → モノレポ fallback」だったが、
  本文の必須事項は「モノレポでの挙動を変えない」で、同順序は設計判断に委ねられていた。
  daemon の前例（モノレポ→同梱）をそのまま踏襲し、**モノレポを先に見る**順にした
  （`vsce package` を一度ローカルで走らせた後に leftover が `packages/vscode-extension/sites/user/`
  へ残っていても、モノレポ dev host は自分の `sites/user` を見続けるという安全側の理由。
  コード内のコメントに理由を明記した）

---

### docs(index): follow PR #947 — the archive period label stayed at 09-12 (Sep 18, 2026)

**Date**: 2026-09-18 / **ブランチ**: `claude/docs-sync-pr947` / **追従元**: PR [#947](https://github.com/signalcompose/orbitscore/pull/947)（マージコミット `b89ce0e`）

#947 は docs のみの PR で、実装・テストは 1 行も触っていない（35 files すべて `README.md` /
`docs/` / `sites/`）。したがって仕様・ランタイム・エディタの各層に追従する対象は無い。
ただし **#947 自身がアーカイブの索引を 3 箇所のうち 2 箇所しか更新していなかった**ので、
残り 1 箇所を揃えた。

#### 直したもの（1 行）

| ファイル | 変更 |
|---|---|
| `docs/archive/WORK_LOG_2026-09.md:1` | H1 の期間ラベル `2026-09（前半・09-01〜09-12）` → `09-01〜09-13` |

#947 はアーカイブへ 20 エントリ（219 → 239）を移し、そこには **`(Sep 13, 2026)` の
エントリが 12 本**含まれていた（移設前のアーカイブには 0 本）。本体末尾の索引
（本体末尾 `## Archived sections` の索引行）と `docs/core/INDEX.md:177` は両方 `09-01〜09-13` へ
更新済みだったが、**アーカイブ側 H1 だけが `09-01〜09-12` のまま**だった。

🔴 **これは 3 度目の同じ取り残しである。** 同じ形の追従を過去に 2 回やっている
（`docs/archive/WORK_LOG_2026-09.md:1882` の「期間ラベルを `09-01〜09-06` → `09-01〜09-07`」、
および `:2497` の「docs(index): follow PR #805 — the archive period label stayed at 09-05」）。

原因は仕組みの穴で説明できる:

- `PROJECT_RULES.md` §1a のアーカイブ手順は「本体末尾に参照リンク」と
  「`docs/core/INDEX.md` の表」の 2 つしか挙げておらず、**アーカイブ側 H1 の期間ラベルを
  挙げていない**（`docs/core/PROJECT_RULES.md:118-125`）
- `tests/docs/worklog-size.spec.ts` が突合するのは本体の行数と
  「`## Archived sections` から辿れるファイル名」だけで、**期間ラベルは 3 箇所とも見ていない**
  （`tests/docs/worklog-size.spec.ts:36-50`）

手順に無く、テストも見ていないので、毎回人の注意力だけが防波堤になっている。
手順への追記とラチェット化は仕組みの変更なので、本 PR では**やらずに提案として出す**。

#### 直さなかったもの

- **`docs/user/en/USER_MANUAL.md`**: #947 は `docs/user/ja/USER_MANUAL.md` に
  「プラグイン UI: 右クリック（#939）」節を 16 行足したが en 側には足していない。
  これは片翼ではなく**意図された非対称**で、`README.md:245` が en 版を
  「deprecated, see learning site above」と明記しており、対になる公開文書
  （`sites/user/en/plugins/instrument.md` / `sites/user/en/mixing/effects.md`）は
  #947 が ja と対で更新している
- **直下のエントリ（「docs: fold the two pending docs-sync PRs, and archive 20 entries」）の
  移設前後の表にある「1,093 行 / 19 エントリ」**: 一見実測と合わないが
  （現在 1,159 行 / 20 エントリ）、**移設直後・本エントリ追記前**の値として正しい
  （`git show d67c9a5:docs/development/WORK_LOG.md | wc -l` = 1093）。自己参照の宿命であって誤りではない
- **`docs/design/883-explicit-output-routing-design.md:175` の壊れた行番号参照**: #947 の PR 本文
  §4 が既に owner へ挙げている。設計書は起案時点のスナップショットなので触らない

---

### docs: reconcile OrbitScore (frozen extension) vs OrbitStudio (native app) prose (Sep 18, 2026)

**Date**: 2026-09-18 / **ブランチ**: `948-terminology-prose` / **Issue**: #948 / **PR**: [#952](https://github.com/signalcompose/orbitscore/pull/952)（merge `966fa7b`）

2026-09-18 の呼称確定（OrbitScore = 拡張版・OrbitStudio = ネイティブ版）を受けて、それより前の
散文が旧い意味（拡張版）のまま残っている箇所を洗い出した。`grep -rio orbitstudio` は 1,100 件超
（識別子・`OrbitStudio.app` を含む）ヒットするため、5 系統（`sites/user/`・`sites/dev/`・
`docs/`（archive・design 除く）・`docs/design/`・`tests/`）に分けて並行で読み、1 行ずつ文脈判定
した。**一括置換（sed 等）は使っていない。**

**変換**: 37 ファイル・54 箇所（`OrbitScore` へ 52・「VS Code」へ 2）。内訳は `docs/` 15
（本ファイルを含む）・`sites/dev/` 11（ja/en 対）・`sites/user/` 4（ja/en 対）・`tests/` 3・
`rust/crates/orbit-audio-daemon` 2・`README.md` 1・`vitest.config.ts` 1。
識別子（`orbitstudio-mcp-gated.spec.ts` /
`ORBIT_GATED_ORBITSTUDIO` / `launchIsolatedOrbitStudio` / `dev.orbitscore.OrbitStudio` 等）・
ネイティブ版の計画/設計・`docs/archive/` は対象外のまま。

🔴 **訂正（2026-09-18・docs 追従ルーチンがマージ済み差分を実測）**: 起草時の「34 ファイル・
59 箇所」「`sites/dev/` 9」「ブランチ `948-orbitscore-orbitstudio-terminology`」はいずれも
差分と一致していなかったので、上の行を実測値へ直した。数え方は `git diff 53873a9 8439d96`
（= PR #952 の head `8439d96` と base `53873a9`）に対して:

- ファイル数 = `git diff --name-only` の行数 **37**
- 箇所数 = 本ファイルを除く 36 ファイルの `-` 行に現れる `OrbitStudio` **56 回**のうち、同じ行の
  `+` 側に残った **3 回**を引いて **53**。これに本ファイルの見出し 1 箇所（`feat(plugin-ui):
  float plugin windows above the editor while OrbitScore is frontmost` の #940 エントリ）を
  足して **54**
- うち 2 箇所は `OrbitScore` ではなく**「VS Code」**へ書き換わっている
  （`sites/dev/editor/vscode-architecture.md:93` と `sites/dev/en/editor/vscode-architecture.md:93`。
  下の owner 裁定の項を参照）

以下は **意図的に変換しなかった**（いずれも「拡張版を指す散文」ではないため）:
- `docs/development/POST_2.0_*`（12 ファイル）: Epic #292・2026-07 起案の計画文書群。
  `POST_2.0_ENGINE_AND_DISTRIBUTION.md` に「OrbitScore = 言語 / OrbitStudio = 専用アプリ
  （候補名）」の記述があり、当時から今回確定した命名と一致していたため無変換
- `docs/design/656-release-design.md` / `docs/research/EDITOR_HOST_AND_APP_SIZE.md` /
  `docs/planning/2026-09-03-issue-triage.md`: VSCodium フォークを「OrbitStudio」名でリブランド
  していた旧配布パイプライン（#830/#827 で廃止・`docs/planning/NATIVE_MIGRATION_2026-09.md` が
  「`OrbitStudio.app` = VSCodium フォーク」の枠組みを畳むと明記）。`sites/dev/editor/mcp-and-
  gated-e2e.md`（ja/en）にも同じ史実の説明段落があり、そのまま
- `docs/development/evidence/628-gated-evidence.md`: 実行ログの逐語キャプチャ（当時の実際の
  `describe` 名）
- `sessions/claude/20260707-mlts-live-jam/README.md`: 2026-07-07 時点の記録（archive 相当）
- `docs/research/WCTM_AGENT_HARNESS_EXTERNAL_DATA_RESEARCH.md` / `docs/specs-v2/DESIGN_DISCUSSION_RECORD.md`
  §「pi ベースの外部データ受信ハーネス」/ `WCTM_SYSTEM_SPEC_v1.md`: WCTM 文脈の小文字
  `orbitstudio`（対象リポジトリ外の可能性・owner 確認要）
- `CLAUDE.md:38` の「orbitstudio 集約」（Epic #413・private レポ名の可能性）
- `sites/dev/editor/vscode-architecture.md`（ja/en）1 箇所: 「OrbitScore 自身の拡張の宣言は
  効くが、**同居する `anthropic.claude-code` の宣言には効かない**」という対比の文で、後者を
  指す語を当初 fork が `OrbitScore` に変換していたのを **`OrbitStudio` へ差し戻した**（同一文に
  `OrbitScore` が二重に出て「拡張が拡張を同居させる」という意味不明な文になっていたため）。
  ここは今回定義の「OrbitScore」でも「OrbitStudio」でもない**第三の対象**（複数拡張を同居させる
  エディタプロセスそのもの）を指していた。🔴 **owner 裁定により「VS Code」と書き直した**
  （2026-09-18）。ja `:93` / en `:93` の 1 文ずつ。

  同じ行の後半「**OrbitStudio のビルド側で** workspace trust を既定 off にする層 2」
  （`product.overrides.json` + `build_orbitstudio.sh`）は**そのまま残した** — こちらは
  #830 / #827 で廃止済みの VSCodium フォークを当時「OrbitStudio」と呼んでいた**史実**で、
  識別子 `build_orbitstudio.sh` と結びついている

検証: `npm ci` / `npm run docs:build -w @orbitscore/user-site` / `-w @orbitscore/dev-site` /
`npm run docs:check` すべて green（996 citation 検証・0 failed・54 ファイル走査）。

---

### docs: fix the product names — OrbitScore is the extension, OrbitStudio is the native app (Sep 18, 2026)

**Date**: 2026-09-18 / **ブランチ**: `948-terminology-in-claude-md` / **Issue**: #948

**owner 確定（2026-09-18）**: 呼称が移動した。

| 語 | 指すもの |
|---|---|
| **OrbitScore** | **VS Code 拡張版**（機能凍結・現 4.2.0） |
| **OrbitStudio** | **macOS ネイティブ版アプリ**（これから作る・未着手） |

🔴 **2026-09-18 より前の記述では「OrbitStudio」が拡張版を指している。** 同じ語が 2 つの意味で
使われている状態なので、`CLAUDE.md` 冒頭に用語表を置いて**正本を 1 箇所に固定**した。

#### なぜ正本に書くか

ルーチンのプロンプトにだけ書いても、**同じ取り違えが別の場所で起きる**（実際に main が
この日 1 度やった。下記）。加えて **user サイトを OrbitStudio.app に同梱してローカル LLM に
読ませる計画**があり（設計 `848-docs-structure-design.md`）、**LLM は書いてあることを実行可能だと
解釈する**ので語の二義性はそのまま誤動作になる。

#### 既存記述の棚卸しは #948 へ

`grep -rio "orbitstudio"` で **1,103 箇所 / 176 ファイル**。内訳:

| 種別 | 件数 | 扱い |
|---|---|---|
| `OrbitStudio.app` | 71 | そのまま（ネイティブ版を指す） |
| 識別子（`orbitstudio-mcp-gated.spec.ts` / `ORBIT_GATED_ORBITSTUDIO` / `ORBITSTUDIO_APP` 等） | 597 | **当面そのまま**（本ファイルのマージ前ゲート手順が名指ししている） |
| **散文** | **435** | #948 の対象 |

🔴 **一括置換しない。** `NATIVE_MIGRATION_2026-09.md` と `docs/design/848-*.md` の散文には
**ネイティブ版を指す「OrbitStudio」が混ざっている**。

#### ルーチン（cloud routine `Documentation and test coverage update`）も修正した

`trig_01Qo1CTXp27QqJa6e6175BGS`。CLI（`/schedule` → `RemoteTrigger`）から更新できる
（**削除だけは Web / Desktop でしかできない**）。修正は 3 点:

1. 冒頭に**用語表**（正本は `CLAUDE.md`）と「**既存の記述をついでに書き換えない**」（#948 の仕事）
2. 分類表の「OrbitStudio（凍結版）」→ **「OrbitScore（VS Code 拡張・凍結）」**
3. 🔴 **「追従対象外」の範囲を狭めた**

3 が main の誤りだった。同日先に書いた「新ライン（追従対象外）」は **engine 線（`rust/` /
`packages/engine/`）まで除外してしまう**もので、O-multiout・ラック等の共有層が文書化されず、
**アプリの初回リリース時に一括で書くことになる**。main は直前に「リリーストリガーは差分を
まとめて読むから取りこぼす」と論じておきながら、**自分の制約で同じ状態を作っていた**。

> **除外は先送りであって削除ではない。**

正しくは「**OrbitStudio（ネイティブ app）の新規ディレクトリだけ**が追従対象外」。

#### 検証

`npm test` は pre-commit hook 経由（全件緑）。本 PR は `CLAUDE.md` と本ログのみで、
`sites/` のコード引用に触れていないため `docs:check` の対象差分は無い。

Part of #948

---

### docs(design): land the revised OrbitStudio design and the new docs-structure design (Sep 18, 2026)

**Date**: 2026-09-18 / **ブランチ**: `848-native-design-revised` / **Issue**: #848

Fable 起案の改訂版 4 本（計 **1,592 行**）を配置する。🔴 **main による審査はこれから**
（owner 指示により **#948 の用語統一を先に完了させてから**設計の議論に入る）。

| ファイル | 行数 | |
|---|---|---|
| `docs/design/848-native-orbitstudio-design.md` | 659 | 改訂（初版 577）。**§2b 改訂判定表**を新設 |
| `docs/design/848-docs-structure-design.md` | **380** | 🆕 **新設**（文書の保持構造・Q1〜Q4） |
| `docs/planning/IMPLEMENTATION_PLAN_NATIVE.md` | 241 | 改訂 |
| `docs/planning/NATIVE_DEVELOPMENT_MAP.md` | 312 | 改訂 |

初版は PR [#849](https://github.com/signalcompose/orbitscore/pull/849)（`848-native-design`
`1bd65b80`）に残る。**そのブランチは main から 277 コミット遅れ**ていたので、
main から切り直した。

#### なぜ改訂が要ったか

初版は **2026-09-11 の main `229d6387`** を根拠に書かれており、その後 #887 / #888 の
リファクタリングで §2「現在地」の表が古くなっていた。特に「**21 モジュールのうち `vscode` を
import するのは 2 本だけ・残り 19 本はそのまま層 2 へ移せる**」が §3 の結論の土台だった。

#### 主要な発見（main が実測で検算済み）

| 発見 | 出典 |
|---|---|
| 依存は **15 本 4,409 行 / pure 26 本 6,062 行**。ただし**依存の行数は 08-30 の 4,405 からほぼ不変** — #887 は依存コードを `extension.ts` から 14 ファイルへ**配った**だけ | `grep -rl "from 'vscode'"` |
| 🔴 **W-22「同梱 node」が失効**。#878 以降 engine は `spawn(process.execPath, …, {ELECTRON_RUN_AS_NODE:'1'})` | `engine-process.ts:407` |
| 🔴 **cold install で Docs パネル / `get_dev_doc` が動かない**。`.vsix` に `sites/` は同梱されないのにパス解決がモノレポ前提。**この経路の gated E2E は 0 本** | `mcp-server.ts:137-138` / `.vscodeignore` / `grep get_dev_doc tests/e2e/` |
| 「実装依存 / 非依存」は **1 軸ではなく 2 軸**（軸 A = host 表面・段落粒度 / 軸 B = 可用性・機能粒度） | 別冊 §2 |

#### 🔴 main のブリーフに誤りが 2 件あった

Fable が検算で発見した。どちらも main が調査報告を**検算せずに転記**したもの:

1. 「MCP 層 `mcp-*.ts` **9 ファイルは完全に vscode 非依存**」→ 誤り。9 本目
   `mcp-register-command.ts:12` が `import * as vscode`（`:159` で `showQuickPick`）。
   非依存は **8 本**
2. 「`*-bridge.ts` は **6 本**」→ **5 本**（`playhead-decorations.ts` はブリッジではない）

調査報告の**要約と列挙が食い違っていた**（列挙は正しく、要約が誤っていた）。
**列挙が一次情報で、要約は二次**である。

#### 裁定待ち

owner 裁定が要る項目が **7 件**（同梱範囲・可用性の表記法・凍結スナップショットの要否・
ルーチンのトリガー・リリース後の更新経路など。すべて Fable の推奨つき）。
#948 の完了後に整理して上げる。

Part of #848

---

### docs: fold the two pending docs-sync PRs, and archive 20 entries (Sep 18, 2026)

**Date**: 2026-09-18 / **ブランチ**: `946-fold-docs-sync-prs` / **Issue**: #946

拡張版の機能凍結（owner 裁定 2026-09-18）を受けて **OrbitStudio**（= macOS ネイティブ版。
今後この語は拡張版を指さない）の開発に入る前に、溜まっていた docs-sync PR 2 本を畳んだ。
`BUNDLE_BRANCH_WORKFLOW.md` §「束を開く前にルーティンの追従 PR を全部消化する」に従う。

| 畳んだ PR | 追従元 | マージ前の状態 |
|---|---|---|
| [#944](https://github.com/signalcompose/orbitscore/pull/944) | #941（右クリックで 1 つの UI / 窓の floating） | `CONFLICTING`・32 files |
| [#945](https://github.com/signalcompose/orbitscore/pull/945) | #943（4.2.0 bump） | `MERGEABLE`・1 file |

衝突したのは `WORK_LOG.md` の 1 ファイルのみで、dev / user サイトの 31 ファイルは auto-merge した。
時系列に合わせて 4.2.0 bump を上、#941 追従をその下（`#940 wiring fix` の直上）に置いた。

#### 🔴 アーカイブが誘発された — 規律が正しく発火した

エントリが 2 つ増えて **`WORK_LOG.md` が 2,017 行**になり、`tests/docs/worklog-size.spec.ts` が
red になって **commit が pre-commit hook で止まった**（`PROJECT_RULES §1a` の上限 2,000 行）。

**この hook 構成には、規律違反を直す途中経過そのものがコミットできないという性質がある。**
2,000 行を超えた状態では何もコミットできないので、アーカイブを別コミットに分けられない。
そのため owner 裁定により**マージとアーカイブを 1 コミットにまとめた**。

移設: 本体 38 エントリのうち**古い 20 エントリ（944 行）**を
`docs/archive/WORK_LOG_2026-09.md` へ（`PROJECT_RULES §1a`「最新 15-20 を残す」に従い 18 本残した）。

| | 移設前 | 移設後 |
|---|---|---|
| 本体 | 2,016 行 / 38 エントリ | **1,093 行 / 19 エントリ** |
| アーカイブ | 12,715 行 | 13,663 行（+948） |

索引は**本体末尾と `docs/core/INDEX.md` の両方**を更新した。この 2 つは
**移設前から範囲表記がずれていた**（本体「09-01〜09-12」/ INDEX「09-01〜09-11」）ので、
どちらも「09-01〜09-13」に揃えた。

#### 参照の張り替え

🔴 **本ログ内の自己参照が、2 度続けてずれた。** #945 のエントリが 4.2.0 bump の版掃除を
`:57` と**行番号で**名指ししていたが、マージで 21 行（→ `:78`）、本エントリの追加でさらに
61 行（→ `:139`）下がった。**追記のたびに壊れる形だった**ので、行番号ではなく
**見出し名（「軸が逆だった」節）で引く**形に変えた。

**次から本ログ内を行番号で自己参照しない。** 本ログは先頭に追記するので、
自己参照の行番号は**書いた瞬間から陳腐化が始まる**。

**直していない壊れた参照が 1 件ある**（発見のみ・報告）:
`docs/design/883-explicit-output-routing-design.md:175` が `docs/development/WORK_LOG.md:967` を
行番号で名指ししているが、行 967 は引用されている owner 発言（「マスターが 1、2 固定」）とは
別の内容を指している。**今回の移設は行 1059 以降を削ったので、この参照は移設前から壊れていた。**
設計書は起案時点のスナップショットなので触らない（`CLAUDE.md`「docs/design/ の過去の設計書を書き換えない」）。

#### 検証

```
npm test                                    → 2577 passed / 79 skipped（hook 経由・0 failed）
npm run docs:check                          → 996 citations verified, 0 failed, 54 files
npm run docs:build -w @orbitscore/user-site → exit 0（dead link 0）
npm run docs:build -w @orbitscore/dev-site  → exit 0（dead link 0）
```

Closes #946

---

### docs: report-only follow-up for the 4.2.0 release bump (#943) (Sep 14, 2026)

**ブランチ**: `claude/docs-sync-pr943` / **追従元**: PR [#943](https://github.com/signalcompose/orbitscore/pull/943)（merge `1276ab1f`）

**doc の追従は不要だった。** #943 は版番号の文字列と本ログのエントリしか変えておらず、
追従先（`CLAUDE.md` / `README.md` / `docs/core` / dev サイト ja+en 6 ページ）は PR 自身が更新済み。
本ログ 4.2.0 bump エントリの「軸が逆だった」節が言う「番号を固定して形を一切仮定しない」grep で検算し、
現在の版を名乗る箇所に `4.1.0` の残りが **0 件**であることを確認した
（`tests/vscode-extension/playhead.spec.ts:136` の `resolve('4.1.0')` は `play()` の引数パスで無関係）。

🔴 直さず報告（PR 本文へ）:

- **`CHANGELOG.md` が 4.2.0 で 6 版分の未記載**（`CHANGELOG.md:34` の `[1.1.0]` が最新）。
  4.1.0 の時（本ログ `:1015`）と同じ理由で、遡って書き起こすかはリリース判断
- **版表記の同期を守らせる仕組みが依然として無い**（#943 自身が `:47` で **4 回目**の取りこぼしを記録）。
  `scripts/check-release-tag-version.mjs` はタグ ↔ `package.json` しか見ず、`tests/docs/` に版の spec は無い

**検証**: `npm ci` / `docs:build`（user・dev）/ `docs:check` すべて exit 0・引用 986 件 0 failed。

---

### chore(release): bump the extension to 4.2.0 (Sep 14, 2026)

**Date**: 2026-09-14 / **ブランチ**: `942-release-4.2.0` / **Issue**: #942

#939 / #940（PR [#941](https://github.com/signalcompose/orbitscore/pull/941)）をマージしたので
拡張を **4.2.0** とする。

#### なぜ minor か

**新機能の追加で破壊的変更は無い**（semver の minor）。

- **#939**: 譜面上のプラグイン名を右クリック → **その 1 つだけ**の UI を開く経路。
  DSL の `ui("name")` は同名の挿入を全部開く（SC.10.10.1 規範 3）ため、人間には個別経路が無かった
- **#940**: VS Code が前面の時だけプラグイン窓を floating に（DAW と同じ振る舞い・
  child 自己完結で wire 変更なし）

DSL の表面・wire・出力の意味論はいずれも変えていない。
`ENGINE_VERSION 2.0.0` と `DSL_VERSION 2.0` は**別軸なので据え置き**
（`docs/design/656-release-design.md` §4.4）。

#### 🔴 版の列挙 — 番号非依存のパターンで洗った

**過去 3 回連続で 1 件落としている**（4.0.1 の post-fix commit / `README.md:55` /
`docs/core/INDEX.md:5` + `vscode-architecture.md` が ja/en とも **2 版分**取り残し）。
いずれも「現在の版番号」や特定の強調記法を狙ったパターンが原因だったので、
今回は **`(拡張|extension)` + 任意の版番号**という番号非依存の形で探した。

🔴 **それでも 4 回目の取りこぼしをした。** 番号を変数にしたが**形を固定した**パターン
（`(拡張|extension)` + 版番号）で探したため、次の **7 箇所**を最初の掃除で落とした:

| 落とした場所 | なぜ形が合わなかったか |
|---|---|
| `sites/dev/orientation/architecture-overview.md:617`（ja/en）— **正本を示す行** | 太字でなくバッククォート `` `4.1.0` `` |
| `sites/dev/decisions/adr-002-dsl-v3-pivot.md:17`（ja/en） | 「拡張」と版番号の間に括弧注記が入る |
| `sites/dev/editor/vscode-architecture.md:1159`（ja/en） | 「拡張 / extension」の語が無い（`— version 4.1.0、`） |
| `README.md:59` | `**` が版番号ではなく行全体を囲む |

**軸が逆だった。** 正しくは**番号（`4.1.0`）を固定して形を一切仮定しない**素の grep で探し、
ノイズ（vendored / lock / 履歴記述）は**後から**除く。検算も同じ方法で行い、
「更新した箇所の数」ではなく**古い番号が 0 件になったこと**を見る。

更新 **23 箇所 / 12 ファイル**:

| 種別 | ファイル |
|---|---|
| 正本 | `packages/vscode-extension/package.json` |
| 目次・仕様 | `CLAUDE.md` / `README.md`（2 箇所）/ `docs/core/INDEX.md` / `docs/core/INSTRUCTION_ORBITSCORE_DSL.md`（2 箇所） |
| dev サイト（ja/en） | `orientation/architecture-overview.md`（各 2 箇所）/ `editor/vscode-architecture.md`（各 2 箇所）/ `decisions/adr-002-dsl-v3-pivot.md`（各 1 箇所） |

冒頭 Note（追従履歴）は**過去の記述を書き換えず、追記する**形にした。
`docs/archive/` と WORK_LOG の過去エントリは時点の記録なので触っていない。

#### ついでに直したもの — lockfile が 4 版分取り残されていた

`package-lock.json` の `packages/vscode-extension` が **`2.1.0`** のままだった
（3.0.0 / 4.0.0 / 4.0.1 / 4.1.0 の**どのバンプでも更新されていない**）。
`npm install --package-lock-only` の差分は **1 行だけ**で副作用が無かったので取り込んだ。

⚠️ 実害は確認できていない（`npm ci` は CI で通り続けていた）。
出荷 `.vsix` の版は `packages/vscode-extension/package.json` が担うため、そちらは正しかった。

#### 検証

`npm test` **2577 passed / 79 skipped**・lint 0・`docs:check` 986 引用 0 failed・
ratchet 68 passed。

---

### docs: follow PR #941 (#939 / #940) in the dev and user sites (Sep 14, 2026)

マージ済み PR [#941](https://github.com/signalcompose/orbitscore/pull/941)（`939-plugin-ui-by-cursor` →
main・merge commit `c6b8f75`）への**ドキュメント追従のみ**。`packages/` / `rust/` / `tests/` は 1 行も
触っていない。

#### 🔴 散文の参照が、PR 自身のマージ時点で既に stale だった（4 回目）

#941 は本文のコード引用（` // FILE:START-END ` 付き）を張り直したが、**引用ブロックの外にある
`path:行` 参照**（各章末の「参考にしたコード」・表のセル・本文中の丸括弧）は
`docs:check` の検査対象外なので取りこぼしが残った。しかも PR 内の後続コミットが
`engine-process.ts` を +47 行動かしたため、**PR が自分で更新した参照まで**ずれていた。

`147b742..abbc545` の差分から old→new の行マッピングを作り、**引用ブロック外の参照だけ**を
機械的に張り直した（102 件 + basename 形 14 件 = 116 件・ja/en 対）。内容が動いていない参照は
触っていない。

**取りこぼしていた「内容の誤り」3 件**（行ずれではなく、記述が事実と食い違うもの）:

| 章 | 旧記述 | 実際 |
|---|---|---|
| `editor/vscode-architecture.md:707` ほか計 6 箇所 | 「engine の spawn が env へ積むのは debug フラグと capture seam だけ」 | **`ORBIT_HOST_BUNDLE_ID` が 3 つ目**（#940）。解決できないときは `delete` する |
| `signal-chain/index.md:885` | 「rack child の spawn は `--shm` / `--chain` / `--sample-rate` の 3 引数」 | env があるときだけ **`--host-bundle-id <値>` が付く** |
| `plugin-hosting/plugin-ui.md:153` | 「Accessory ポリシーで立ち上げ、`NSTimer` で service を呼ぶ」＋ appkit.rs:205-221 の引用 | その行範囲は #940 で**前面アプリ observer に入れ替わっており**、`NSTimer` は 234-242 へ移っていた（引用は緑・散文だけが嘘） |

3 件目は「引用が緑でも散文は検査されない」の再演である。**引用を張り直すときは、その引用が
支えている散文を読み直すこと。**

#### 追記した章

- `plugin-hosting/plugin-ui.md`（ja/en）— 「エディタ面: カーソルが乗っている 1 つだけを開く（#939）」と
  「窓を前面に浮かせる（#940）」の 2 節。`pluginUiAddressFor` / `desired_plugin_window_level` /
  `set_plugin_window_level` / `NSTimer` の引用 4 本を追加。frontmatter を `c6b8f75` / 2026-09-14 へ
- `editor/mcp-and-gated-e2e.md`（ja/en）— MCP ツール表に `open_plugin_ui_at_cursor` を追加。
  **登録の述語が #939 で「組」から「1 本ずつ」に変わった**ことを明記（旧 `if (open && close)` は
  片方だけ持つホストで両方消えた）
- `editor/execution-feedback.md`（ja/en）— `var verb = mix.aux` の**レシーバが任意の識別子へ一般化**
  された件（#940 レビュー）。`mix` はただの変数なので、別名の譜面ではバス宣言を取りこぼし、
  「LinkAudio が要る」診断が誤爆していた
- user サイト（ja/en）+ `docs/user/ja/USER_MANUAL.md` — **右クリック → `OrbitScore: Open Plugin UI`**。
  `ui("名前")` が全部開くのに対しカーソルの 1 つだけを開くこと、5 種の loud な失敗、
  macOS で窓がホスト前面時だけ浮くこと

#### 直さず報告に回したもの

- `docs/specs-v2/PLUGIN_UI_HOSTING_SPEC_v1.md`（UIH の正本）に**ウィンドウレベルの規範が無い**。
  仕様を決める作業なので追従では触らない（PR 本文で質問）
- `sites/dev/decisions/adr-003-scsynth-bundle.md` の `extension.ts:2053-2088` 等 4 件は
  **#887 の分割より前**を指しており、#941 とは無関係の既存 stale
- MCP の `chain_path` / `site` が gated E2E で一度も検査されていない（ユニットのみ）

#### 検証

```
npm ci                                     → exit 0
npm run docs:build -w @orbitscore/user-site → exit 0（dead link 0）
npm run docs:build -w @orbitscore/dev-site  → exit 0（dead link 0）
npm run docs:check                          → 996 citations verified, 0 failed, 54 files
```

引用は 986 → **996**（新規 10 本 = ja 5 + en 5）。

Follows #941 / #939 / #940

---

### fix: make the #940 wiring tests platform-independent, and pin the keyword mirror (Sep 14, 2026)

レビューラウンド 3。**すべて fix 起因**の指摘で、元差分（`main..113ec39e`）起因の
新規指摘は 0 件だった（CLAUDE.md の provenance 規律により、元差分のレビューは収束とみなす）。

#### 🔴 G1 — CI が red だった。手元（macOS）では緑

ラウンド 1 の F3 で足したテスト 2 本が、**実行環境の本物の `process.platform` に依存**していた。

```
FAIL tests/vscode-extension/engine-spawn-runtime.spec.ts
  AssertionError: expected undefined to be 'dev.orbitscore.OrbitStudio'
  AssertionError: expected "spy" to be called with ... "not inside a macOS .app"
Tests  2 failed | 2563 passed
```

`resolvePluginWindowHostBundleId` は `platform !== 'darwin'` で即 return するので、
ubuntu の CI では env も付かずログも出ない。兄弟テストは `'darwin'` を明示的に渡しており踏んでいない。

**直し方**: `process.platform` を `process.execPath` と**同じパターン**で固定する
（`Object.defineProperty` → `afterEach` で復元）。🔴 配線（env に載る / 消える）を見る目的を
失わないため、純関数直呼びには**しなかった** — このテストの存在理由は
「純関数は正しいが**配線だけ**壊れている」を捕まえることである（`setDocumentDirectory` と同型）。

**検証**: main が `process.platform = 'linux'` を setup で固定して再現 → **9 passed**。
「前」の証拠は CI の赤そのもの。

🔴 **これは [[local-gates-and-ci-see-different-layers]] の再発**である。main は実機ゲート 49 passed で
「全ゲート緑」と報告したが、その時 CI は赤だった（pending の時点で見たきり追っていなかった）。

#### G2 — `DSL_KEYWORDS` が engine の正本と何も結ばれていなかった

レビュアー 2 体が独立に指摘。ラウンド 2 で足した `DSL_KEYWORDS` は
`tokenizer.ts:18-27` の `AudioTokenizer.KEYWORDS` のハンドコピーだが、
ポインタコメントも agreement test も無かった。

🔴 **同じ fix 差分の中で F1 は正しいやり方を実践していた** — `engineCatalogOrder()` が
engine の `parseAudioDSL` / `resolveRackValue` を実際に呼んで突き合わせている。

しかも pr-test-analyzer が決定的な事実を出した: **この Set を空にしても 1 語消しても、
当時のテストは 1 件も red にならなかった**（`DSL_KEYWORDS.has(ident)` が真になる経路を
1 つも駆動していなかったため）。

**足したもの（2 種類・別のことを見る）**:
- **agreement test**: `tokenizer.ts:289` の `export const KEYWORDS` と集合が一致すること
  → 「ミラーが古くなったこと」を見る。`import` を 1 語消す変異で red を確認済み
- **振る舞いテスト**: 9 語それぞれ + `effect([...])` が `unresolved-receiver` になること
  → 「ガードが効いていること」を見る

🔴 **拡張のソースから engine を import はしない**（別プロセスなのでミラーは意図的）。
テストからだけ両方を見る。

#### G3〜G6

| id | 何を |
|---|---|
| G3 | `soloWindowLayer` の権限診断が実測 1 ケースから**因果を断定**していた → 「既知の原因の一つ」へ |
| G4 | 既定の `log` を best-effort に（catch 節から呼ばれるので、ログが投げると `startEngine` ごと落ちる）。🔴 **注入された logger は握り潰さない**ことをテストで固定 |
| G5 | `receiverBefore` の docstring が「statement」と書いていたが実装は**行頭**を取るだけ → 一文一行の前提を明記 |
| G6 | `DSL_KEYWORDS` の分類列挙が語と対応していなかった → 目的（全 9 語が receiver ではない）に絞った |

#### 🔴 dev サイトの本文引用 42 件が壊れていた — `docs:check` では捕まらない層

行番号の訂正（下記）を追う過程で発見。`main` では正確だった本文中の参照が、
この PR で **47〜53 行**ずれていた:

| シンボル | main | 現在 |
|---|---|---|
| `resolveDaemonForUI` | 57 | 104 |
| `autoStartConfiguredRustEngine` | 187 | 234 |
| `startEngine` | 255 | 302 |
| `writeCodeToEngine` | 592 | 645 |

🔴 **`docs:check` は構造的にこれを検査できない** — 対象はコードブロック内の
`// file:start-end` だけで、本文中の参照は見ていない。

**直し方**: 一括シフトは**しない**。`main` 時点の開始行の**内容**を取り、それが現在版に
**一意に存在する時だけ**書き換えた（`main` で既に古かった参照は触らない）。
一意に決まらなかった 2 種（`registerTool(` は 7 箇所ある）はシンボルを特定して手作業。

⚠️ **この作業で 2 回壊して戻した**。3 回目に成功。踏んだ順:
1. スクリプトが **fenced 引用まで**書き換えた（`--fix` が既に直した正しいものを壊す）
2. fenced を除外したのに `str.replace` が**ファイル全体の同一文字列を置換**して巻き添えにした
3. fenced 判定の正規表現に**行末アンカー**を付けたため、
   `// ...:404-468 (env の組み立てを省略)` のような**意図的な省略注記つき引用**を
   fenced と認識せず、また壊した ← **過去に同じ形で踏んでいる**

#### 行番号の訂正（main の誤り）

`tests/fixtures/mcp-e2e/output_line_position_matters.orbs` の当該行は **`:39`** であり、
main が書いた `:38` は誤り。しかも main は Fable の引用を「1 行ずれている」と述べたが、
**ずれていたのは main の数え方**だった。設計文書と WORK_LOG の 2 箇所を訂正。

#### 検証

`npm test` **2577 passed / 79 skipped**・lint 0・typecheck:e2e 0・ratchet 68 passed・
`docs:check` 986 引用 0 failed・**Linux 条件の再現 9 passed**。

実機 gated は再実行していない。ラウンド 3 は `process.platform` の固定とテスト追加・
コメント訂正が中心で、**本番経路の振る舞いを変えていない**ため
（直前の全件実行は 49 passed）。

---

### fix: never resolve a DSL keyword as a plugin-UI receiver (Sep 14, 2026)

レビューラウンド 2（1 件）。**ラウンド 1 の F2 修正が入れた新しい故障モード**を潰した。
CLAUDE.md の「fixer の差分は、ラウンドを閉じる前に再点検する — この修正が導入する
新しい故障モードは何か」に従い、main の受け入れ検証で見つけたもの。

#### 何が起きていたか

F2 で入れた正規表現は宣言部を**省略可能**にしていた:

```
^\s*(?:var\s+[A-Za-z_$][\w$]*\s*=\s*)?([A-Za-z_$][A-Za-z0-9_$]*)\b
```

その形に合わない入力では省略可能部分が**後戻り**し、キーワード `var` 自身を掴む:

```
var myRack = effect(["Comp"])   →   receiver = "var"
```

engine へ `"var"` が送られ `Unknown sequence 'var'` になる。黙りはしないが意味不明。
なお `var x = effect([...])` は**そもそも不正な DSL**（`rack.ts` の `resolveCall` は
`effect` を rack 語として受け付けない）なので、実害は文言の質だけ。

#### 直し方 — 後戻りを**構造的に不可能**にした

依頼はキーワード除外だけだったが、実装は 2 段にした:

1. 宣言部 `var <name> = ` を**先に切り落とす**（省略可能な部分が無くなるので後戻りできない）
2. その上で `DSL_KEYWORDS` のガード（防御の二段目）

`DSL_KEYWORDS` は `packages/engine/src/parser/tokenizer.ts:18-28` の
`AudioTokenizer.KEYWORDS` のミラー（9 語すべて一致を main が照合）。
このファイルは `PATH_DIRECT_PREFIXES` など engine の定数をミラーする方針なので、慣習に沿う。
⚠️ **ミラーなので、tokenizer に語が増えると古くなる**（失敗は loud・`Unknown sequence` になる）。

#### 検証

main が dist を**ビルドし直してから** receiver 10 ケースを実測し、退行 0 を確認:
`snare` / `kick` / `sum:drum` / `master` / `kick`(var 経由) / `sum:drums` /
**`null`(var myRack)** / `indented` / 3 連 `drums` / 派生 `sum:d`。

`npm test` **2565 passed / 79 skipped**・lint 0・typecheck:e2e 0・ratchet 68・
`docs:check` 986 引用 0 failed。

実機 gated は再実行していない。変更がキーワード除外に閉じており、
gated フィクスチャの receiver はすべて上のユニットで押さえられているため。

---

### fix: address the review round-1 findings for #939 / #940 (Sep 14, 2026)

レビュー 5 体（`/code:pr-review-team` フル編成 + Fable 監査を**並行**）の指摘を集約し、
main が実機コードで再現を取った 8 件を直した。

🔴 **本体は Critical 1 件 — #939 が防ぐために作られた失敗を、#939 自身が再導入していた。**

#### 何が起きていたか

```
drums.effect(["Echo", ["Echo", "Echo"], "Echo"])
engine の真の並び: [Echo#1, Echo#2, Echo#3, Echo#4] → UIH.5 index 1,2,3,4

  Echo#1 → index 1          ✅
  Echo#2 → FAIL "layer() … serial chains only"   ← layer は書かれていない
  Echo#3 → FAIL 同上
  Echo#4 → index 3, expectedName "Echo"          🔴 3 番目が開く
```

**`expectedName` ガードは名前が同じだと止められない**（`global.ts:1242` は名前しか比べない）。
つまり**エラーも警告も無しに別のインスタンスが開く**。

原因は engine との規則の食い違い。`packages/engine/src/signal-chain/rack.ts:196`:

```ts
return value.elements.flatMap((element) => resolveRackValue(element, env))
```

**素の配列は深さに関係なく親へ平坦化される。階層を作るのは `layer(...)` だけ**
（既存テスト `rack-value-resolution.spec.ts:188` が固定済み）。
スキャナは透過を **「その呼び出し語の最初の `[` か」**（`directArraySeen`）で決めており、
2 つ目以降の素の配列を layer の枝と誤認していた。

**なぜレビューまで残ったか**: フィクスチャが `layer([...])` 経由の入れ子しか持たず、
**`layer` を経由しない素の入れ子配列が 1 つも無かった**。
ユニット 2,542 件・実機 gated 48 件・`/simplify` 4 体を素通りしている。

#### 修正の規則（指摘単位のローカルパッチを避けるため、先に 5 本書いた）

| 規則 | 内容 |
|---|---|
| **P1** | チェーンのアドレスは engine の平坦化規則を 1 つだけ写す。階層を作るのは `layer` だけ |
| **P2** | receiver は **文の起点**で決まる（`.effect(` の直左ではない） |
| **P3** | 機能を黙って無効化しうる解決は、**両方の分岐で**ログを出す |
| **P4** | 登録の述語は、そのツールが**実際に使う**ハンドラだけを名指す |
| **P5** | 観測ヘルパは、絞り込みで空になったら**絞る前**を見せる |

#### 直したもの

| id | 何を |
|---|---|
| **F1** (P1) | `directArraySeen` と `TRANSPARENT_ROOT_ARRAY_WORDS` を**削除**し、`[` の直近 CallFrame が `layer` の時だけ階層を積む |
| **F2** (P2) | receiver を行の文頭から解決。`var <name> =` があれば右辺を起点に。失敗文言から誤った「1 行に書け」案内を削除 |
| **F3** (P3) | `resolvePluginWindowHostBundleId` の 4 分岐（成功 / `.app` 不在 / plist 読めない / キー不在）を `outputChannel` へ。`platform !== 'darwin'` は正常系なので黙る |
| **F4** (P4) | UI 3 ツールをそれぞれ自身のハンドラだけの述語へ分離。**登録順序は維持** |
| **F5** (P5) | `soloWindowLayer` のエラーにフィルタ前の一覧を含め、全 name が空なら画面録画権限を名指す |
| **F6** | `collectDerivedMixerBuses` の「読み手は 1 つ」コメントが**嘘だった**（`dsl-completion-context.ts:195-198` に残っている）。委譲は循環依存（`diagnostics-analysis.ts:8` が逆向きに import）なので**コメントを実態へ訂正** |
| **F7** | gated E2E が `.app/Contents/Info.plist` を `plutil` で読むようにし、bundle id の決め打ちを廃止 |
| **F8** | `.optionAll` は off-screen も含む（`CGWindow.h:137-145`）— コメント訂正 |

#### F2 の実測（訂正前 → 訂正後）

| 入力（すべて 1 行） | 前 | 後 |
|---|---|---|
| `snare.output(verb, thru: true, db: -6).effect(["Comp"])` — **core spec `:1796` の例** | undefined | `snare` |
| `kick.audio("k.wav").effect(["Comp"]).output()` | undefined | `kick` |
| `global.sum("drum").gain(-3).effect(["Comp"])` | undefined | `sum:drum` |
| `drums.effect(["A","B"]).effect(["C"])` の `C` | undefined | `drums` |

🔴 **仮定の話ではなかった。** この形は**リポジトリ自身の実機 E2E フィクスチャ**が使っている
（`tests/fixtures/mcp-e2e/output_line_position_matters.orbs:39`）。
しかも失敗文言が「keep receiver.effect([...]) on one line」— **1 行に書いてあるのに**。

#### テスト

**期待値を手書きしない形にした。** `engineCatalogOrder()` が同じ式を engine の
`parseAudioDSL` → `resolveRackValue` に実際に通し、その平坦順と拡張の index を突き合わせる。

- 素の入れ子 / **同名 4 つ** / 深い入れ子 / `chain()` を含む形（🔴 同名版が**区別するテスト** —
  名前が違う版だけでは `expectedName` が偶然守ってしまう）
- `layer` が引き続き拒否されること
- F2 の表の全行（core spec の行を含む）
- `startEngine` が `ORBIT_HOST_BUNDLE_ID` を env に載せる / 取れない時は**キーが消える**配線
- カーソルツールだけ欠けても既存 2 本が登録されること
- `window-layer` の権限診断（新規 `tests/e2e/window-layer-helper.spec.ts`）
- gated E2E に素の入れ子・同名 4 インスタンス版を 1 本追加（`index: 4` を要求し、
  **index 3 への close が失敗する**ことを確認）

#### 見送り・別 issue

| 指摘 | 判断 |
|---|---|
| `HOST_BUNDLE_ID_ARG` が 2 クレートに重複 | **見送り**。daemon は `orbit-child-runtime` に依存しておらず、共有には依存追加が要る。`--shm` も raw literal で 28 箇所に散っており慣習が無い。値がずれれば child が未知引数で落ちて loud |
| `set_plugin_window_level` が `NSApplication.windows()` **全部**にレベルを掛ける | **別 issue**。JUCE のポップアップ（独自レベル）が巻き込まれうるが、実プラグインでの確認が要る |

#### 🔴 レビュー運用で分かったこと

- **Fable を並行投入した意味があった**: Fable の I-1（receiver）と pr-test-analyzer の C1（入れ子）は
  **どちらも「差分に在るコードの誤り」ではなく「フィクスチャに無かったもの」**だった。
  code-reviewer（Critical 0 / Important 0）は差分を丁寧に追ったが、**無いものは見えない**
- **Codex が read-only sandbox で起動され、何もせず exit 0 で終わった**。`task` に **`--write`** が要る。
  `git status` にコード差分が無いことで気づいた。**「完了」を成果物で検算する**
- **dist が古いまま**で「修正が効いていない」と誤判定しかけた（[[ts-mutations-need-a-rebuild-before-real-machine]] と同型）

---

### refactor: apply the /simplify findings for #939 / #940 (Sep 14, 2026)

`/simplify`（reuse / simplification / efficiency / altitude の 4 体）が出した指摘のうち
4 件を採用、1 件を見送った。**挙動は変えていない**が、1 件は直す過程で**既存側の欠陥**が出た。

#### 🔴 直す過程で見つかった、指摘より重いもの — `mix.` 決め打ち

`plugin-name-diagnostics` が持っていた「3 本目の正規表現」を消す作業で、**既存 2 本の方が
間違っている**ことが分かった:

```
既存: /\bvar\s+(...)\s*=\s*mix\.(?:sum|aux)\b/g   ← 受け側が "mix" 決め打ち
```

`mix` は `var mix = init global.mixer`（SC.2.1）で作る**ただの変数**なので、
譜面が別名を付けた瞬間に **`declaredMixerBusNames` が派生バスを見落とす**。
[`INSTRUCTION_ORBITSCORE_DSL.md`](../core/INSTRUCTION_ORBITSCORE_DSL.md) MX.2 の例
（`var drums = mix.sum`）も `mix` を変数として導入している。受け側を一般の識別子にした。

一本化の先は `diagnostics-analysis.collectDerivedMixerBuses`。**この形を読む場所を 1 つにする**
のが目的で、3 本が文字集合もアンカリングも違っていた（同じ譜面が 3 通りに読まれうる状態）。

#### 採った 4 件

| 対象 | 何をしたか |
|---|---|
| `tests/e2e/helpers/window-layer.ts` | `execFileSync` → **`spawnSync`**。`run-cli.ts:35` が定める規約（`helpers.spec.ts` が pin）に反していた。`execFileSync` は**成功時に stdout しか返さない**ので、`CGWindowListCopyWindowInfo` が画面録画権限の警告を stderr へ出しつつ空配列を返す形が**「窓が無い」と読める**。`error` / `signal` / `status` / `stderr` を個別に見て throw する |
| `plugin-name-diagnostics.ts` | 語彙判定 4 箇所のインライン `\|\|` 連鎖を **3 つの名前付き集合**へ（`CATALOG_ROOT_WORDS` / `TRANSPARENT_ROOT_ARRAY_WORDS` / `ELEMENT_SEPARATOR_WORDS`）。**意図的な差**（`layer` は透過にしない）が並べて見える形になる |
| `diagnostics-analysis.ts` | 上記 `collectDerivedMixerBuses` を新設し、`plugin-name-diagnostics` が委譲 |
| `orbit-child-runtime` | `strip_host_bundle_id_argument` を新設。child 3 種（clap / vst3 instrument・effect rack macos）が持っていた「`--host-bundle-id` を読み捨てる」分岐を削除。**child 固有パーサに関心外のフラグを教えない**。単体テスト 3 件追加（child-runtime **40 passed**） |

#### 見送った 1 件 — `HOST_BUNDLE_ID_ARG` の daemon 側二重定義

daemon が `"--host-bundle-id"` を文字列リテラルで書いている箇所を定数へ寄せる指摘。
**`--shm` が raw literal で 28 箇所**に散っており、CLI 引数名を共有定数にする慣習が
このリポジトリに無い。レビュアー間でも評価が割れていた（reuse は指摘・altitude は
「既存慣習より厳密なので入れない」）ので、慣習を変えるなら別 PR とする。

#### 検証

`npm test` **2542 passed / 78 skipped**・`lint` 0・`typecheck:e2e` 0・
cfg 4 象限すべて緑・`cargo check --target x86_64-unknown-linux-gnu` 0・
実機 gated **48 passed**。

🔴 ファイルサイズ ratchet が 1 件赤になった。`strip_host_bundle_id_argument` の抽出で
`orbit-effect-rack-child/src/macos.rs` が **531 → 529 行**に*減った*のに baseline が
古いままだったため。baseline を下げた（ラチェットは減る方向にしか編集してはいけない、を守る側の発火）。

この追記で本体が **2,034 行**になり `worklog-size.spec.ts`（上限 2,000）も赤になったので、
末尾の 09-12 分 **415 行**を [`WORK_LOG_2026-09.md`](../archive/WORK_LOG_2026-09.md) へ移した。

---

### test(e2e): assert the plugin window level, and add a manual-gate score (#940) (Sep 14, 2026)

🔴 **設計 §5b の前提「窓の重なり順は自動で観測できない」は誤りだった。** それを根拠に
**全部を手動ゲートに置いていた**。owner の「テスト用のコードを書いて」で調べ直して分かった。

#### 何が読めるのか

`CGWindowListCopyWindowInfo` の **`kCGWindowLayer`**（0 = Normal / 3 = Floating）。
🔴 **child に `window.level()` を聞くのとは違う** — あれは*process が信じている値*で、
窓サーバが適用したかは分からない。`kCGWindowLayer` は**窓サーバ側の記録**なので、
レベルが効かなかった場合はここで食い違いとして出る。

実測（同じ child・同じビルド・**前面アプリだけ**を変えた）:

| 前面のアプリ | layer |
|---|---|
| `com.mitchellh.ghostty` | **0 = Normal** |
| `com.microsoft.VSCode` | **3 = Floating** |

#### 足したもの

- `tests/e2e/helpers/window-layer.swift` — 外部リーダ（**0.24 秒**）。1 行 1 JSON で依存を増やさない
- `tests/e2e/helpers/window-layer.ts` — `observeWindows` / `soloWindowLayer`。
  窓が 1 つでなければ **throw**（先頭を黙って選ぶと壊れた状態が数値として通る）
- gated E2E `#940` — ホスト前面 → floating → **別アプリ前面 → normal** → 戻すと floating
- `examples/manual-gates/939-940-plugin-ui.orbs` — 人が触る用（owner 依頼）。
  ⑥ に `twin.ui("CLAP Test Effect")` をコメントで置き、**同名 2 つが両方開く**のと
  右クリックで 1 つだけ開くのを**その場で見比べられる**ようにした

🔴 **区別するアサーションは「別アプリ前面で normal に戻る」。** 常時 floating を掛ける実装でも
「ホスト前面で floating」は通ってしまう。#935 と同型の失敗を避けるための本体。

#### 🔴 owner の環境で「効かない」と見えた理由 — また計測側だった

古いプロセスが残っていた: dev host **8 個** / daemon **2 個** / child 3 個。
child はいずれも **`--host-bundle-id` 無し**（#940 より前に起動したもの）で、
`desired_plugin_window_level` が `Normal` を返すのが**正しい動作**だった。
しかも `start_engine` が **`engine already running`** を返し、新ビルドの daemon は起動していなかった。

全部落として立て直すと、`Info.plist` → daemon の `ORBIT_HOST_BUNDLE_ID=com.microsoft.VSCode` →
child の `--host-bundle-id` → **layer 3** まで通った。**実装は最初から正しかった。**

昨日の「変異版 `dist` で dev host を起動」と**同じ形**。→ [[stale-processes-invalidate-real-machine-results]]

#### 途中で踏んだもの

`CLANG_MODULE_CACHE_PATH` に `/tmp` を使うと、swift が `/private/tmp` と**別物として扱い**
2 回目以降が `module 'Darwin' is defined in both` で落ちる。実体パスに固定した。

#### 検証

実機 gated **48 passed / skip 0**（#940 を含む）/ lint / `typecheck:e2e` /
`docs:check`（986 引用 0 失敗）/ `tests/repo` + `tests/docs` 86 passed。

Part of #940

---

### feat(plugin-ui): float plugin windows above the editor while OrbitScore is frontmost (#940) (Sep 14, 2026)

owner 裁定で **#939 の PR に畳んだ**（「振る舞いとしては同じ関心ですよね」）。
利用者から見れば「楽譜から UI を開く」ひとつの体験で、**#939 の手動ゲート中に発見**された。
加えて**手動ゲートは人手が要る一番高い工程**なので、分けると owner に 2 回やってもらうことになる。

🔴 main が当初「検算の機会で切る」を理由に分離を提案したのは**筋違い**だった。あの規律は
「**振る舞いを変えない**変更を、変える変更と混ぜるな」であり、本件は両方とも変え、互いの検算を潰さない。

#### 方式: child 自己完結 — **wire 変更なし**

child が `NSWorkspace` の `didActivateApplicationNotification` を購読し、
**前面が「ホストまたは自分自身」なら `NSFloatingWindowLevel`** を child の中だけで判定する。
ホストの bundle id は **spawn 時の固定値**（`ORBIT_HOST_BUNDLE_ID` → `--host-bundle-id`）。

🔴 **拡張側でフォーカスを検知する案を採らなかった理由**: `onDidChangeWindowState` は
VS Code のフォーカスしか見ないので、**プラグイン窓をクリックした瞬間に floating が外れる**。
child なら「自分が前面」を直接見られるので、この罠が構造的に起きない。
**wire を使わない方が正しい**という珍しいケース。

判定は純関数 `desired_plugin_window_level(host, child, frontmost, frontmost_is_child)` に切り出し。
**未指定時は `Normal`**（後方互換）。

#### 🔴 Codex が実測で見つけた穴（main の設計に無かった）

standalone の child では **`NSRunningApplication.current.bundleIdentifier` が `nil`** を返す
（Swift で実際に叩いて確認）。bundle id 比較だけでは「**窓自体をクリック**」が成立しない。
同一 `NSRunningApplication` オブジェクトの比較で塞いだ。IPC も host focus 購読も増やしていない。

#### 🔴 main の発注ミス: 500 行ラチェットの規律を書き忘れた

4 ファイルが超過した（`orbit-child-runtime/src/lib.rs` 551/500 ほか）。#939 のブリーフには
「`agent-handlers.ts` に足すな」と書いたのに、#940 では同じ規律が抜けていた。
baseline の書き換えは #888 子 0 の裁定で禁止なので**分割で対応**:

| 新規 | 内容 | コード行 |
|---|---|---|
| `orbit-child-runtime/src/appkit.rs` | AppKit run loop と `NSWorkspace` observer | 214 |
| `orbit-audio-daemon/src/outproc_child_command.rs` | effect child のコマンド構築 | 24 |
| `orbit-audio-daemon/src/outproc_instrument_transport.rs` | instrument の transport context | 18 |
| `orbit-effect-rack-child/src/macos/args.rs` | rack child の `Args` 型 | 6 |

`lib.rs` は **551 → 332 行**。🔴 **3 ファイルが `allowed` と同値**（余裕ゼロ）なので、
次に 1 行足すと赤くなる。レビューで扱う。

#### 引用の追従は `--fix` だけでは終わらなかった

10 件が `--fix` で解決できなかった。**コードが別ファイルへ移動**していたため
（`lib.rs:481-497` → `appkit.rs:205-221`）で、行シフトではない。ヘッダのパスごと直し、
**引用ブロックの中身も実コードから再同期**した。

🔴 `(env の組み立てを省略)` と注記のある**意図的な省略引用**を、再同期スクリプトが
全行で上書きしてしまい 1 度壊した。`git checkout` で戻し、範囲と差分行だけ手で直した。
**注記つきの引用は機械的な再生成の対象にしない。**

#### 🔴 `git add -A packages` で無関係な 18,916 行を巻き込みかけた

未追跡の `packages/sc-link-audio/`（ビルド成果物 + 埋め込み git リポジトリ）が入った。
`git reset` して**変更ファイルを明示**する形に直した（最終 1,424 行）。
memory `dont-use-git-add-all` を自分で破っていた。

#### 検証

`npm test` **2,542 passed / 77 skipped** / lint / `typecheck:e2e` / `docs:check`（986 引用 0 失敗）/
500 行ラチェット 70 passed / `cargo fmt --check` / `clippy --workspace --all-targets -D warnings` /
child-runtime 37 / daemon 305 / std-gain 実機 3 行。

🔴 **窓の重なり順は自動で観測できない。** 手動ゲート 4 項目（VS Code 前面で上に出る /
他アプリ前面で被さらない / **窓自体をクリックしても外れない** / 未指定時は normal）は**未了**。

Part of #940

---

### feat(extension): open one plugin's UI from the cursor position (#939) (Sep 14, 2026)

楽譜上のプラグイン名を右クリックし、`OrbitScore: Open Plugin UI` からそのインスタンスだけを
開く経路を追加した。同名の insert はカーソル位置から `chainPath` で区別し、engine へ渡す直前の
1 箇所だけで UIH.5 index に変換する。標準プラグイン（`Gain(...)`）もチェーン位置を消費し、
派生 sum / aux bus、master、直指定 bus の receiver を解決する。

MCP の `open_plugin_ui_at_cursor` は引数なしで同じ VS Code command id を `executeCommand` し、
メニューと同じ成功・失敗経路を通る。純関数・配線・manifest のユニット、同名 + `Gain` の gated
E2E を追加した。実機 E2E と右クリック手動ゲートは sandbox 外で実施する。

#### main の検証（工程 ④⑤・実装は Codex / 検証は main）

🔴 **委譲先の報告ではなく差分を読んで確かめた。** トラップ 4 点はいずれも正しく処理されていた:

| トラップ | 実装 |
|---|---|
| `Gain(...)` を数える | `,` を数えるのは `effect`/`instrument`/`layer`/`chain` の**フレーム直下のみ**。`Gain(db: -6, label: "x")` 内の `,` は数えず、`Gain(` 自体は要素を 1 つ進める |
| MCP が `executeCommand` を通る | `openPluginUiAtCursorForAgent` が command id を `executeCommand`。モック（`tests/mocks/vscode.ts:229-232`）も**登録済みハンドラへ委譲する形**に直っている |
| E2E の区別力 | `close_plugin_ui(index: 1)` が `no plugin UI opened` で**失敗**することを assert |
| engine 不可侵 | `packages/engine/**` / `rust/**` の差分ゼロ |

既存テストを触った 3 箇所（`mcp-server.spec.ts` / `engine-command-awaits.spec.ts` / `tests/mocks/vscode.ts`）は
**すべて追加または委譲化**で、期待値の変更は 1 つも無い。

🔴 **`npm test` は Codex の環境では完走していない**（sandbox の loopback 制限で
`listen EPERM 127.0.0.1` → `rust-engine-player.spec.ts` が 44 件 timeout）。
main が sandbox 外で回し直して **2,541 passed / 77 skipped / exit 0**。
500 行ラチェットの失敗も**新規ファイルが未追跡だったための人工物**で、index に入れれば 70 passed。
**「委譲先が緑と言った」では済ませない**という規律がそのまま効いた形。

#### main が直した 2 点

1. 🔴 **テスト名が実体と食い違っていた** — `'... the same plugin is inserted three times'` だが、
   フィクスチャは同名 CLAP **2 つ + `Gain`**。設計 §0b でフィクスチャを変えた時に**名前だけ
   取り残されていた**（Codex が報告で指摘してきた）。名前を実体に合わせ、設計側も同期した
2. **本エントリの見出しが日本語だった** — 規約は「タイトルは英語・本文は日本語」

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
- [2026-09（前半・09-01〜09-13）](../archive/WORK_LOG_2026-09.md) — #883 束 C のレビュー round 1、#883 束 S / 本体 (#883)、#888 子 1、#878、4.1.0 リリース (#926)、pan を両段とも減衰のみにした裁定 (#921/#922)、E2E-4/E2E-5 の実機実装 (#917) を含む
