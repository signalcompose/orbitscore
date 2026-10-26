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

### feat(engine): add the host output port and stop capturing the console in layer 2 (Oct 26, 2026)

**Date**: 2026-10-26 / **ブランチ**: `1022-d3-output-port`（`1022-d5-strict-parser` の上・stacked の draft）/ **Issue**: [#1022](https://github.com/signalcompose/orbitscore/issues/1022)（束 S-eval の N1-d3・台帳 P-07）

- engine に出力の口 **`host`** を足した（`audio/engine-backend.ts` = engine とその外の境界の契約を置く既存のモジュール。新しいファイルは足さない）: `host.log` / `warn` / `error`（`console` と同じ引数）と `host.step({seq, argPath, atEpochMs})`。**既定は console**（凍結版の REPL・`orbitscore play` が書く行は今と同じ。step は `[STEP] …` の 1 行）で、呼んだその時に `console.*` を引くので既存テストの spy もそのまま効く。`setHostOutput` で差し込み、`null` で既定へ
- engine の `console.log/warn/error` を **29 ファイル 142 か所**で `host.*` に置き換えた（`cli/` と CLI の入口 `cli-audio.ts` は CLI 自身の出力なので対象外・コメントは書き換えない）。`[STEP]` を出す 2 か所（audio の dispatch・`midi-scheduler.ts`）は型つきの `host.step` に
- 名前を `host` にしたのは、`engineOutput.log(` が `console.log(` より長く prettier の折り返しが増えて、ファイルの大きさのラチェットを超えたため（`host` はどのファイルの名前とも衝突しない）。それでも import の 1 行で超えた 4 ファイルは、値と型が混ざった複数行の import を「値の import」と「型の import」に分けて 1 行に収めた（リポジトリに既にある書き方）。縮んだ 6 ファイルの baseline を下げた
- 層 2: console の横取り（`console-capture.ts`・`PROVISIONAL(P-07)`）を消し、`engine-output.ts`（`host` に差し込む受け手。`util.format` で 1 行ずつ `log.line` の分類へ・step は `transport.step` へ）に置き換えた。`SessionCore` の `captureConsole` / `consolePassthrough` は `attachEngineOutput` に（テスト 5 か所の設定を更新）。**台帳 P-07 を閉じた**
- テスト: engine の口 2 本（既定は console と同じ引数・差し込みと戻し）・層 2 の受け手（console の横取りのテストを受け手のテストへ書き換え）と「層 2 が口に付き、`transport.step` を流し、dispose で console へ返す」1 本・**`[STEP]` を出す 2 か所（audio の dispatch・MIDI）が文字列ではなく型つきの step で口へ出す**ことを 1 本ずつ（層 2 は口を通らない `[STEP]` の行も拾えるので、文字列に戻しても層 2 の挙動は変わらず、ここでしか気づけない）。台帳の spec の例を P-07 → P-25 / P-08 へ
- 変異 11 種（既定の step を消す・`null` で戻さない・warn を log へ・log を import 時の console に固定・層 2 が付かない・dispose で返さない・warn を stdout へ・step を受け手で捨てる・step を流さない・audio / MIDI の marker を文字列に戻す）がすべて red
- dev 学習サイト: engine のコードを引用している 150 件が `console.*` → `host.*` で一致しなくなった。変更前と変更後のソースの行の対応（difflib）で引用の区間を写し、`--fix` で行番号を付け直した（26 ページ・日英）。内容の差は `console.* → host.*` と `[STEP]` の 2 か所の `host.step({…})` だけであることを差分で確かめた。`[STEP]` の節（scheduling/event-queue・日英）に口の説明を 1 段落足した
- 現在のコードを説明するコメント 5 か所の `console.*` を `host.*` に（過去の経緯を書いたコメントはそのまま）。`packages/session/CLAUDE.md` の「engine が console に書く行は層 2 が横取りする」を口の記述に更新

### feat(parser): reject characters the DSL does not use, except ; (Oct 26, 2026)

**Date**: 2026-10-26 / **ブランチ**: `1022-d5-strict-parser`（同じ小 PR の 2 つ目のコミット）/ **Issue**: [#1022](https://github.com/signalcompose/orbitscore/issues/1022)（束 S-eval の N1-d5 の後半・設計 997 Q-7 = A）

- `tokenizer.ts`: 文字列とコメントの外の、DSL が使わない文字（`!` `?` 英字でない文字など）を、黙って捨てる代わりに `Unexpected character "…" at line L, column C` にした。`;` だけは文の区切りとして明示的に読み飛ばす（spec E-7）。文言に `EOF` を入れない（凍結版の REPL のため）
- 🔴 **Q-7 は owner がまだ見ていない**（実装の着手時に見つけた — 設計 997 §4.2 の訂正）。Q-3 と同じ類として「推奨で進めて」の範囲で採ったが、**戻せるように独立したコミット**にした
- `parseAudioDSLWithSpans` はトークナイザの失敗も位置つきの `DslSyntaxError` にする（トークン化を try の中へ）
- dev 学習サイトの `KEYWORDS` の引用（日英）の行がずれたので `--fix` で付け直し、着地先を目で照合した
- 既存テストは 1 件も落ちなかった。追跡されている `.orbs` の検査に新しい文言を足した。テスト 4 本を追加（3 つの入力の文言と位置・`;` と文字列・コメントは通る）

### feat(parser): report unreadable statements as syntax errors (Oct 26, 2026)

**Date**: 2026-10-26 / **ブランチ**: `1022-d5-strict-parser`（`1022-d1-intake` の上・stacked の draft）/ **Issue**: [#1022](https://github.com/signalcompose/orbitscore/issues/1022)（束 S-eval の N1-d5・設計 997 Q-3 = A・#965）

- `parse-statement.ts`: 文の頭が `var` / `import` / `RUN` / `LOOP` / `MUTE` / 識別子のどれでもない時（以前はトークンを 1 つ捨てて黙って進んだ）と、`.` の無い識別子（以前は黙って読み飛ばした）を、位置つきの構文エラーにした。文言は `parser-utils.ts` の `unreadableStatement` / `missingDot`（`parse-statement.ts` を太らせない — ファイルの大きさのラチェットの baseline を 648 → 646 に下げた）
- 🔴 文言に `EOF` を入れない: パーサは凍結版の REPL も使い、REPL は `EOF` を含むパースのエラーを「入力の途中」と読んで次の行を待つ。`kick` だけの行が次の正しい行を巻き込まないよう、入力の終端は「the end of the input」と書く
- パーサは凍結版と共有なので、差分テストの記録 5 件の**凍結版の側**も変わった（断片が 0 文で黙って通る代わりにエラーになる）。記録を更新し、#965 / #631 の 2 件は「差はバッチだけ」に理由を書き直した。記録を直す手間を減らすため、差分テストに `PRINT_EVAL_DIFFERENCES=<ファイル>` で今の観測を書き出す口を足した
- dev 学習サイト（text-to-ast・日英）の `parseStatement` の抜粋を新しいコードに差し替え、「どれでもなければ構文エラー」の 1 文を足した。行のずれた引用 2 か所は `--fix` で付け直して着地先を目で照合
- 新しいテスト `tests/parser/strict-statements.spec.ts` 7 本（4 つの入力の文言と位置・`EOF` を言わない・今まで通った書き方は通る・**追跡されている `.orbs` が新しいエラーに当たらない**）

### feat(session): replace the evaluation intake with the #997 model (Oct 26, 2026)

**Date**: 2026-10-26 / **ブランチ**: `1022-d1-intake`（`1022-d0-docs` の上・stacked の draft）/ **Issue**: [#1022](https://github.com/signalcompose/orbitscore/issues/1022)（束 S-eval の N1-d1 + N1-d2）

- engine（既存のファイルに足した・新しいファイルは足さない）:
  - `audio-parser.ts`: 文の走査を `forEachStatement` に切り出し（`parse()` の結果は不変）、`parseAudioDSLWithSpans` を追加（文をソースの順に範囲つきで返す・LSP と同じ行の規則・構文エラーは同じ文言で位置つきの `DslSyntaxError`。位置は文言の `at line, column` → 入力の終端 → 読んでいた文の先頭の順で決める）
  - `interpreter-v2.ts`: `executeStatements` を追加（ソースの順に 1 文ずつ・実行時エラーはその文だけ・import の失敗は残りを止める・記録 1 件・`onStatement` / `onFailure`）。記録とフックの装着を `execute()` と共通の helper に切り出した（`execute()` の振る舞いは不変）
- 層 2 の受付口（`evaluation-intake.ts`）を置き換えた: 1 度に読み、構文エラーなら何も実行せずバッチも開かない、文が無ければ何もしない、1 要求 = 1 バッチ。診断に 1.1 の `range`。実行時エラーは失敗したその時にログへ（凍結版と同じ順）。滞留の報告は実行中の文と後ろで待つ要求の数。**台帳 P-01 を閉じた**
- 差分テストを「**違いの記録**」に書き換えた（N1-d2 を同じ PR に入れた — 受付口を置き換えると段階 1 の「一致」が落ちるため）。凍結版との差 13 件を、実測した観測（両側）と設計 997 §6 の番号つきで持つ。一覧に無い差・観測の違いは red。設計 997 §6.1 に実測から V-21〜V-24 を足した
- 既存テストは消さずに期待値を新しい意味論へ更新（`evaluation-intake.spec.ts` の全件・偽の interpreter 5 か所を `executeStatements` へ・`session-core.spec.ts` の包み直し）。新しいテスト: `tests/parser/parse-with-spans.spec.ts` 9 本・`tests/interpreter/execute-statements.spec.ts` 7 本・受付口の「エンジンの想定外の失敗でもバッチを閉じる」1 本。台帳の spec の 2 件は「今ある足場の例」として P-01 を名指していたので P-07 に替えた（P-01 の印が消えたことも確かめる）
- engine の行がずれたので dev 学習サイトの引用 8 か所を付け直した（6 か所は `--fix` で着地先を目で照合、パーサの走査の抜粋 2 か所は新しいコードに差し替えて `forEachStatement` / `parseAudioDSLWithSpans` を 1 文で説明）
- 変異 8 件ですべて red（import の失敗で止めない / 最初の失敗で止める / 文ごとに記録 / 宣言を前へ寄せる / onFailure を無視 / パースの前にバッチ / 列を 1 始まり / 文が無くても実行）

### docs(spec): adopt the #997 recommendations and specify the evaluation unit (Oct 26, 2026)

**Date**: 2026-10-26 / **ブランチ**: `1022-d0-docs`（`997-evaluation-model-design` の上・stacked の draft）/ **Issue**: [#1022](https://github.com/signalcompose/orbitscore/issues/1022)（束 S-eval の N1-d0）

- owner「推奨でとりあえず進めて」（2026-10-26）で設計 997 §9 の Q-1〜Q-6 を推奨どおりに採用した。記録は設計 997 §0 の 8 と §9 の「採用」
- 実装の前に一次ソースで確かめ直し、D-E3 の記述を訂正した: `;` を捨てているのはパーサではなく**トークナイザ**の「Skip unknown characters」。`;` 以外の文字（`!` `?` `$` や英字でない文字）も同じ経路で黙って捨てられている → **Q-7**（推奨 A = `;` を除いて構文エラー）を足し、Q-3 と同じ類として採用（owner 未見・独立したコミットにする）。追跡されている `.orbs` 127 本でこの種の文字に頼るものは 0
- spec を先に直した（運用規則 6）: `INSTRUCTION_ORBITSCORE_DSL.md` に「評価の単位」（host ごとの区切り方・OrbitStudio の規則 E-1〜E-7）/ `SESSION_LOG_SPEC_v1.md` §3.1 に「層 2 では要求 1 つ = 1 レコード」/ 設計 848 §5.3.1 に #997 の答え
- プロトコル 1.1（MINOR・追加のみ）: 評価の診断に省略可能な `range` / `documentRange`、`StepSource` に省略可能な `document`（共通の `DocumentRange`）。TS を生成し直した。版を名指す既存テスト 3 件の期待値を 1.1 に更新
- spec に節を足して行がずれたので、dev 学習サイトの引用 4 か所を `check-citations.mjs --fix` で付け直した（中身は同じ）

### docs(design): draft the evaluation model for the native line (Oct 26, 2026)

**Date**: 2026-10-26 / **ブランチ**: `997-evaluation-model-design`（`1017-c3-reverse-requests` の上・docs だけの draft）/ **Issue**: [#997](https://github.com/signalcompose/orbitscore/issues/997)（計画 §7.1 の C-12）

- `docs/design/997-evaluation-model-design.md` を起案した（実装しない・owner の確認待ち）
- 土台: 段階 1 の受付口（`packages/session/src/eval/evaluation-intake.ts`）に本物の `parseAudioDSL` を通し、今の区切り方の振る舞いを 12 通り実測した（読めない文が 0 文で `ok`・行頭の `.` のチェーンが黙って捨てられる・空行 2 連が文を割る・行ごとの評価では IM.1 が効かない ほか）。追跡されている `.orbs` 127 本でパーサの読み飛ばしに頼るものは 0
- 関連 6 件（#965 / #620 / #695 / #987 / #630 / #631）を一次ソースで分類（区切り方が原因なのは #695 と #965 の半分。#620 は層 2 では構造的に起きない。#987 は拡張版の文字列照合が原因だが、出どころは評価の側でしか作れない）
- 推奨: 区切りは 3 層（展開 / 分割 / まとまり）に分け、展開は凍結版のまま・分割は「要求を 1 度にパースして文で切り、ソースの順に実行」・まとまりは「要求 1 つ = 1 バッチ = 1 記録」。構文エラーは全体を実行しない / 実行時エラーはその文だけ（今と同じ）。#987 は世代番号（owner が #987 に残した B 案）を層 2 が文の位置へ対応づける。実装は TypeScript のまま（評価は音の時刻の経路に乗っていない）
- owner に確かめること 6 件（Q-1〜Q-6。うち Q-3 = `;` と読めない文の扱い、Q-6 = 複数行の import は DSL の構文に触れる）と、owner の「バグ的な振る舞い」の例の欄（§6.2）を空けた
- `docs/core/INDEX.md` の設計ノートの表に行を足した

### feat(session): forward the reverse editor requests and resolve run selection in layer 2 (Oct 26, 2026)

**Date**: 2026-10-26 / **ブランチ**: `1017-c3-reverse-requests`（`1017-c2-language-services` の上に積んだ小 PR・stacked の draft）/ **Issue**: [#1017](https://github.com/signalcompose/orbitscore/issues/1017)（束 S-editor・計画 §7.1 の C-11 = N1-c3）

- RPC サーバに**層 2 → エディタの逆方向のリクエスト**（`requestEditor`）: `id` で答えを突き合わせ、`x-editor-request` の params / result をスキーマで検査する。エディタが無ければ `NO_EDITOR_ATTACHED`、期限（置き値 10 秒・台帳 P-08 の行に追記）までに答えなければ `EDITOR_TIMEOUT`、答える前に切れれば `NO_EDITOR_ATTACHED`、形の違う答えは `INTERNAL_ERROR`（理由はログ）。黙らない（§5.4）
- `SessionCore`: `editor.openFile` / `setSelection` / `editReplace` / `saveFile` / `configureFlash` をエディタへ転送（`saveFile` が成功したら、**頼んだ時点の版**を保存済みにする = 答えの前に入った変更は dirty のまま）
- `editor.runSelection`: エディタには選択の位置（`SelectionSnapshot`）だけを聞き、評価する範囲は層 2 の `host/selection-block.ts`（凍結版 `getLineSubject` と範囲の決め方の書き直し）で決めて `session.evaluate` と同じ経路で評価する。検査の順と文言は凍結版 `runSelectionForAgent` と同じ。LLM の実行では選択をカーソルへ畳む（凍結版 #390）。写しの版と選択の版が違えば評価しない
- `plugin.openUiAtCursor`: 凍結版 `plugin-ui-at-cursor.ts` を写し（import の差し替え + VS Code のコマンドの境界の関数を除く）、**同期済みの選択**から組んだエディタを渡して `plugin.openUi` を呼ぶ（§5.3.3）。engine への口は `language/plugin-ui-shim.ts`（台帳 P-25）
- **凍結版との突き合わせ**（`editor-parity.spec.ts`）: 凍結版の `runSelection` を mock で走らせて engine へ書いたテキストと flash の範囲を 16 通り、`openPluginUiAtCursor` の戻り値と engine への引数を 12 通り比べる
- **台帳 P-19 を閉じた**: v1 の C→S のメソッドがすべて層 2 のハンドラを持つ（`session-core-methods.spec.ts` がスキーマのファイルと突き合わせる）。サーバの「未実装」の分岐と中継の「`METHOD_NOT_FOUND` もエディタ無し」の分岐から印を外した（前者は「このサーバにハンドラが無い」に言い換え、後者は消した = 既存テストの期待値を「投げ直す」に更新）
- F-12: 層 2 を起動し直してエディタが document を送り直すと、`session.getState` / `editor.getState` が元と同じになり `run_selection` が通る（`editor-reverse.spec.ts`）
- 判明（PR に提案）: v1 に**評価した範囲をエディタへ伝える口が無い**（凍結版は runSelection が自分で flash した。層 2 が subject-block を決めるので、エディタは flash する範囲を知らない）

### feat(session): run the frozen completion and diagnostics in layer 2 behind a vscode-shaped shim (Oct 26, 2026)

**Date**: 2026-10-26 / **ブランチ**: `1017-c2-language-services`（`1017-c1-document-sync` の上に積んだ小 PR・stacked の draft）/ **Issue**: [#1017](https://github.com/signalcompose/orbitscore/issues/1017)（束 S-editor・計画 §7.1 の C-11 = N1-c2 の前半）

- 凍結版の言語機能 8 本を `packages/session/src/language/` へ写した（`diagnostics-analysis` / `dsl-completion-context` / `dsl-method-catalog` はそのまま、`plugin-catalog-completion` / `plugin-name-diagnostics` は import のパス、`completion-context` / `diagnostics-provider` / `dsl-providers` は `vscode` と `extension-state` を shim に差し替え）。差は `frozen-copies` のパッチが固定する
- `language/vscode-shim.ts`: 写しが触る名前だけを持つ器（値を入れて持つだけ・描画も UI も無い）→ 台帳 **P-25** を新設（拡張版の退役で層 2 の形へ書き直す）
- `language/language-services.ts`: 同期済みの写しを VS Code の文書の形に見せ、3 つの補完 provider を登録の順に呼ぶ（明示的に補完を呼んだ時と同じ）・`updateDiagnostics` の結果を凍結版 `getDiagnosticsForAgent` と同じ形（1 始まり・重さの名前・code）に直す
- `SessionCore`: `editor.didOpen` / `didChange` で診断を計算して `editor.diagnostics` を送る（計算の間に版が進んだら古い結果は送らない）・`didClose` で空を送ってマーカーを消す・`editor.getDiagnostics`（パスを渡せば必ず 1 件・渡さなければ診断のある文書だけ・エディタが無ければ空）・`editor.complete`
- **凍結版との突き合わせ**（`language-parity.spec.ts`）: 凍結版の本体を vitest の `vscode` の mock で走らせ、同じ文書で診断 7 件・補完 8 件を比べる。mock が持たない `workspace.findFiles` / `fs` を使う `import` の補完は層 2 の側だけで確かめた
- 判明: v1 のスキーマに **hover と quick fix（output-missing の修正）のメソッドが無い**（凍結版の `registerHoverProvider` / `registerOutputCodeActionProvider`）。設計 §5.7 の列挙からも漏れていた（PR に提案）

Part of #1017

---

### feat(session): sync the editor's documents into layer 2 and answer editor state from the copy (Oct 26, 2026)

**Date**: 2026-10-26 / **ブランチ**: `1017-c1-document-sync`（統合ブランチ `1017-session-editor` の最初の小 PR・draft）/ **Issue**: [#1017](https://github.com/signalcompose/orbitscore/issues/1017)（束 S-editor・計画 §7.1 の C-10 / C-11 = N1-c1）

- C-10: 束 S-editor の issue #1017 を起票し、統合ブランチ `1017-session-editor` を S-mcp の最後の小 PR（#1016）の先端から切った。計画 §2.1 の S-mcp / S-editor の行のブランチ名を実際の名前に（台帳 P-15 の仮置きを外した）
- `host/document-store.ts`: エディタが開いている document の写し。LSP と同じ 0 始まり・UTF-16 の座標で `editor.didChange` の範囲の置き換えを当てる（`\n` / `\r\n` / `\r`・範囲の外は端へ寄せる）。古い・重複した版と、開いていない文書への変更は当てずに理由を残す
- `SessionCore`: `editor.did*` の 5 通知は `editor` capability を持つクライアントからだけ受ける。`editor.getState` / `editor.getDocumentText` は同期済みの写しから（凍結版と同じく位置は 1 始まり・アクティブな文書が無ければ全欄 null・エディタが付いていなければ `NO_EDITOR_ATTACHED`）。`session.getState` の `documents` / `activeUri` を埋めた。エディタのクライアントが離れたら写しを捨てる（再接続で `didOpen` が再送される・F-12）
- IM.6 の第 2 候補が `editor.didChangeActive` に従うことを、中継と同じ RPC ハンドラ + `buildServer` で確かめた（アクティブな `.orbs` → その文書のディレクトリ / 未保存の文書 → ワークスペース）
- `languageId` は拡張子から推定、`isDirty` は「開いてから変わったか」の近似 → 台帳 **P-24** を新設（`didOpen` に言語、`didSave` 通知がプロトコルに無い）

Part of #1017

---

### test(e2e): add the native parity ledger and the MCP tools v1 gate (Oct 26, 2026)

**Date**: 2026-10-26 / **ブランチ**: `1011-b4-parity`（`1011-b3-harness` の上に積んだ小 PR・stacked の draft）/ **Issue**: [#1011](https://github.com/signalcompose/orbitscore/issues/1011)（束 S-mcp・計画 §7.1 の C-9 = N1-b4）

- **パリティ台帳** `tests/e2e/native-parity-ledger.ts`（設計 §1.2 D-1）: `PARITY_BASELINE_TAG = v4.4.0` の gated `it` 56 題名を全件分類。全件 `native-required`（拡張版の形だけを確かめる題名は無かった・設計の予備判定と同じ）。題名ごとに根拠（DSL の結果か能力か）・`needsEditor`・`app`（自前でアプリを起こすか、先頭の題名が起こしたアプリと状態に依るか）
- `needsEditor` / `app` は手で書くが、spec が **構文木の解析**（`helpers/gated-suite-analysis.ts`: `.call('<tool>'` を同じファイルの関数と helpers を辿って集める）と突き合わせる。基準タグが手元にあれば、台帳の題名 = タグの時点の題名も確かめる（CI の浅い clone にはタグが無い）
- gated suite に `beforeEach` を 1 つ足し、台帳の分類でターゲットに無い題名を理由つきで skip（headless の needs-editor・先頭の題名が skip される時の shared。`vscode` では何もしない）
- **MCP ツールの v1 関門** `tests/protocol/mcp-tools-v1.spec.ts`（設計 §6.1）: 中継の `tools/list`（名前・順序・input schema）を、凍結版の `startOrbitScoreMcpServer` に全 handler のスタブを渡して得た `tools/list` と比べる。例外の表は 2 件（`evaluate_orbitscore` / `register_mcp_server`・どちらも振る舞いの違い）。`MCP_V1_GATE_UNTIL`（未定 = null）と `apps/OrbitStudio/VERSION` で比べる相手をスナップショットへ自動で切り替える。台帳 P-03 を `open` に
- dev 学習サイト（ja / en）の gated spec の引用 44 か所を、`beforeEach` と import で 8 行ずれた分だけ付け直した（`check-citations.mjs --fix`・すべて同じ中身への平行移動）
- 🔴 判明: headless で残る題名は **1 件**（`#779`）。先頭の題名がエディタを使い、かつ後続の 49 題名が依る共有のアプリと状態（カタログの走査の結果など）を作るため（PR に選択肢と推奨を記録）

Part of #1011

---

### test(e2e): add the headless gated target that talks to layer 2 through the relay (Oct 26, 2026)

**Date**: 2026-10-26 / **ブランチ**: `1011-b3-harness`（`1011-b2-relay` の上に積んだ小 PR・stacked の draft）/ **Issue**: [#1011](https://github.com/signalcompose/orbitscore/issues/1011)（束 S-mcp・計画 §7.1 の C-8 = N1-b3）

- `ORBIT_GATED_TARGET = vscode | headless | native`（既定 `vscode` = 今日のまま・設計 §10.2）。差は起動と MCP の取り方だけで、シナリオ本体は 1 文字も変えていない
- `headless`: `node packages/session/dist/cli.js session --runtime-dir <tmpRoot>/r [--workspace-root <tmpRoot>] --docs-dir <repo>`（TCP なし）+ 中継 `cli.js relay` を stdio で起こす。runtime-dir は 0700・ソケットのパスは実体で 103 バイト以内を確かめる。凍結版の拡張が起動時に行う engine の自動起動（`orbitscore.audioDevice`）は、アプリと同じく RPC の `engine.start` で層 2 に頼む
- `helpers/mcp-client.ts` に `StdioMcpClient`（`McpClient` の派生・シナリオの型はそのまま）、`helpers/gated-target.ts` に起動とプロセスの見つけ方。teardown の sweep は headless の時だけ層 2 と中継のプロセスも数える
- `native` は起動で「apps/OrbitStudio（束 N2）が要る」と落ちる（黙って skip しない）→ 台帳 **P-23** を新設（`apps/OrbitStudio/Package.swift` が現れた時に印が残っていれば red）
- unit（ゲートの外・11 件）: 既定が `vscode`・runtime-dir・起動引数・設定の写し・sweep の正規表現・本物の headless の起動（vite-node で src を起こす）
- dev 学習サイト（ja / en）の gated spec の引用を 43 行のずれに合わせて付け直した（`check-citations.mjs --fix`・着地を確認）。`mcp-and-gated-e2e.md` の `:107-131` は中身が変わった（`appAvailable`）ので、引用を `:113-143` の新しいコードに差し替え、`ORBIT_GATED_TARGET` の 1 段落を足した

Part of #1011

---

### feat(session): add the orbitscore relay (stdio MCP server) and session.registerMcp (Oct 26, 2026)

**Date**: 2026-10-26 / **ブランチ**: `1011-b2-relay`（`1011-b1b-mcp-tools` の上に積んだ小 PR・stacked の draft）/ **Issue**: [#1011](https://github.com/signalcompose/orbitscore/issues/1011)（束 S-mcp・計画 §7.1 の C-7 = N1-b2）

- **中継** `cli.js relay [--runtime-dir]`（`packages/session/src/relay/relay-main.ts`）: stdio の MCP サーバ。ツール層は C-6 の `buildServer` + RPC ハンドラ。RPC 1 回ごとにソケットへ繋ぎ（RL-3）、届かなければ 100 / 250 / 500 ms の待ちで繋ぎ直してから「OrbitStudio is not running (or is restarting)」（待ちは置き値 → 台帳 P-08 に印）。送った後に切れたら再送せず「unknown whether it ran」（RL-4）、MAJOR 違いは「updated — reconnect orbitstudio with /mcp」（RL-5）。終了は stdin の EOF と SIGINT / SIGTERM だけ（RL-1・RL-7）
- **`session.registerMcp`**（`host/mcp-registration.ts`）: user scope は `claude mcp add --transport stdio --scope user orbitstudio -- <スタブ>`、project scope は `.mcp.json` の `mcpServers.orbitstudio` に `${HOME}/…` の stdio の行（凍結版の `orbitscore` の行は残す）。**鍵もポートも書かない**。`port` は受け取るが使わず、応答で伝える（§6.1 の裁定による例外）。スタブの置き場は §6.3 の提案のまま → 台帳 **P-22** を新設
- 検査: 中継のプロセス（7 件: 上流なしの 28 本と `server/discover` の即答・`kill -9` の後も PID が同じで次が通る・再送しない・MAJOR 違い・stdout は MCP のフレームだけ・SIGINT から 100 ms 以内・stdin の EOF・中継越しの `register_mcp_server`）/ RPC 1 回分の規則（5 件）/ 登録の形（9 件・`claude` CLI は差し替え）

Part of #1011

---

### feat(session): move the MCP tool layer into layer 2 and back its handlers with the session RPC (Oct 26, 2026)

**Date**: 2026-10-26 / **ブランチ**: `1011-b1b-mcp-tools`（`1011-b1-layer2-methods` の上に積んだ小 PR・stacked の draft）/ **Issue**: [#1011](https://github.com/signalcompose/orbitscore/issues/1011)（束 S-mcp・計画 §7.1 の C-6 = N1-b1 の後半）

- **MCP 層の写し**（`packages/session/src/mcp/`）: `mcp-sdk` / `mcp-tools-engine` / `mcp-tools-plugins` はそのまま。`mcp-types`（同期だった handler 5 本を `Promise<T> | T` に広げた）/ `mcp-tools-editor`（その 5 か所を `await`・docs 系 4 本は層 2 の `docs.*` を読む `DocsToolSource`）/ `evaluate-document-directory`（改行の制約を写さない・§6.1 の裁定による例外）は差を `tests/session/frozen-copies/*.patch` に記録し、写し = 原本 + パッチであることを `git diff --no-index` で検査する（パッチの無い写しは差 0）
- `build-server.ts`: 凍結版と同じ engine → editor → plugins → docs の順で登録（`tools/list` の 28 本・同じ順序）。handler が**投げた**失敗（層 2 に届かない等）は凍結版の `errorResult` と同じ封筒で返す
- `rpc-tool-handlers.ts`: `OrbitScoreToolHandlers` を層 2 の RPC で満たす（28 本すべて）。`evaluate_orbitscore` の IM.6 は中継側で `session.getState`（engine・`activeUri`・`--workspace-root`）+ `editor.getState`（パス・言語）から組み立て、凍結版と同じく engine の確認を IM.6 のエラーより先に行う。`document_path` があれば `target: { uri }` を付ける
- `rpc/client.ts`: UDS の RPC クライアント（`session.hello` → MAJOR の確認 → `session.attach`）。失敗を「層 2 のエラー / 送った後に切れた（RL-4）/ MAJOR 違い（RL-5）/ 届かない（RL-3）」に分ける
- スキーマ: `session.getLog` の `lines`（小数・0・負）・`audio.analyze` の `wavPath` / `windowMs`・`docs.get` の `path` の制約を、凍結版の MCP ツールが受けていた範囲に緩めた（受ける範囲を広げるだけ）
- 移した unit: IM.6（16 件・改行のケースは「改行を含む実在のパスが解決される」に置き換え）/ `buildServer`（20 件・HTTP の節は v1 に `/mcp` が無いので移さない）/ 端から端まで（23 件: MCP クライアント → RPC → 本物の RPC サーバ → `SessionCore`）
- 設計 §6 に「同じ型のうち 5 本は同期で満たせない」を追記

Part of #1011

---

### feat(session): add the layer-2 audio, plugin and docs methods with the docs HTTP routes (Oct 26, 2026)

**Date**: 2026-10-26 / **ブランチ**: `1011-b1-layer2-methods`（統合ブランチ `1011-session-mcp` の最初の小 PR・draft）/ **Issue**: [#1011](https://github.com/signalcompose/orbitscore/issues/1011)（束 S-mcp・計画 §7.1 の C-6 = N1-b1 の前半）

- **層 2 のメソッド**（`packages/session/src/host/layer2-methods.ts`）: `audio.listDevices` / `selectDevice` / `analyze`・`plugin.saveState` / `openUi` / `closeUi` / `list` / `rescan`・`docs.get` / `search`。振る舞いと文言は凍結版の MCP ハンドラ（`agent-handlers.ts` / `plugin-commands.ts`）と同じ。凍結版が子プロセスへメタ行で頼んでいたもの（`//#savePluginState` / `//#pluginUi` / `//#selectAudioDevice`）は in-process の `InterpreterV2` を直接呼ぶ
- **docs の在りか**（`host/docs-sites.ts`）: `--docs-dir`（複数可・先勝ち）でモノレポの形（`sites/<site>`）と `.app` の同梱の形（`user` + `user-site`・dev なし）を受ける。dev が無い時の `docs.*` は全部 `DOCS_UNAVAILABLE`（凍結版の `DEV_DOCS_UNAVAILABLE_MESSAGE`）
- **docs の HTTP**（`rpc/docs-http.ts`・TCP だけ）: `/orbitscore/**`・`/orbitscore/dev/**`（最長一致で dev が先）・`/docs`（302）。503（未ビルド・base 違い・dev なし）/ 405 / 403（Host）を凍結版 `handleHttp` と同じ応答で返す。応答に CSP（値は置き値 → 台帳 **P-21** を新設）
- **凍結版からの写し**（`services/wav-analysis.ts`・`services/engine-view.ts`・`plugin-catalog-reader.ts`・`mcp/mcp-docs.ts`・`mcp/mcp-types.ts`）と、写しが一致していることの spec（一覧は `tests/session/frozen-copies.ts`・拡張版と共存する間だけ = 台帳 P-09 に追記）。`module-doc-purity.spec.ts` は**写しと原本の組だけ**を doc の重複から外す（一致が強制されている組は「別ファイルの doc を貼った」欠陥ではない。写しが第三のファイルと doc を共有すれば従来どおり red — 変異で確認）
- `audio.selectDevice` の選択は層 2 のメモリにだけ持つ（凍結版は設定に書いて次の起動へ持ち越した。v1 の設定はアプリの環境設定なので持ち主が未決 → 台帳 **P-20** を新設・応答から「persisted for next start」を外した）
- WORK_LOG の 09-14 分（11 エントリ）を `docs/archive/WORK_LOG_2026-09.md` へ移設（2,000 行の上限）

Part of #1011

---

### feat(session): add the orbitscore session CLI with the ready line and the parent-death shutdown (Oct 26, 2026)

**Date**: 2026-10-26 / **ブランチ**: `1001-a3-session-cli`（`1001-a2-session-server` の上に積んだ小 PR・stacked の draft）/ **Issue**: [#1001](https://github.com/signalcompose/orbitscore/issues/1001)（束 S-rpc・計画 §7.1 の C-4 = N1-a3）

- `packages/session/src/cli.ts` + `session-main.ts`: `node dist/cli.js session [--runtime-dir] [--port] [--token-file] [--docs-dir]… [--web-dir] [--workspace-root] [--parent-pid] [--host-bundle-id] [--plugin-catalog] [--plugin-scan-path]`。`--mcp` は無い（未知の引数として拒否）
- **ready 行**（stdout の 1 行目だけ）: `{"ready":true,"socket","port","protocol_version","token"}`。`port` と `token` は TCP を開いた時だけ。起動の失敗は stderr に `{"ready":false,"error":{code,message}}`（`RUNTIME_DIR_UNSAFE` / `SOCKET_PATH_TOO_LONG` / `SESSION_ALREADY_RUNNING` / `TOKEN_FILE_UNSAFE` / `BAD_ARGUMENTS` / `LISTEN_FAILED`・秘密なし）
- **F-1**: stdin がパイプ（FIFO かソケット）の時だけ EOF で、`--parent-pid` の PID が消えても、SIGINT / SIGTERM / `session.shutdown` と同じ経路（engine を止める → サーバを閉じてソケットを消す）で終了。`--parent-pid` の周期 1 秒は置き値（台帳 P-08 を `open`）
- `--token-file`（0600 でなければ拒否・F-12 で同じトークンを使う）/ `/app/` の静的配信（`--web-dir`・Host 検査・`frame-ancestors 'none'`・外へ出ない）
- 実プロセスのテスト（vite-node で build 前に起こす）: stdin を閉じると終了 / 親を SIGKILL すると終了 / パイプでない stdin の EOF では終わらない / SIGKILL の後に同じ runtime-dir・port・トークンファイルで起動し直して再 attach（F-12 の層 2 側）/ 本物の `InterpreterV2` で daemon が起動前に死ぬと `engine.start` が失敗を返す
- 計画 §2.1 に束 S-rpc の実測の変更行（8,368）を記録（上限 1,500 の約 5.6 倍・切り直しは #1001 に提案）

Part of #1001

---

### feat(session): add the session RPC server over a Unix socket and loopback TCP (Oct 26, 2026)

**Date**: 2026-10-26 / **ブランチ**: `1001-a2-session-server`（`1001-a1-protocol-schema` の上に積んだ小 PR・stacked の draft）/ **Issue**: [#1001](https://github.com/signalcompose/orbitscore/issues/1001)（束 S-rpc・計画 §7.1 の C-3 = N1-a2）

- **RPC サーバ**（`packages/session/src/rpc/`）: UDS と TCP の 2 リスナー・`/rpc` のハンドラは 1 つ。`session.hello` → `session.attach`（attach より前のメソッドは close 1008）。TCP は Host 許可リスト + Origin（欠落・`null` も拒否 = 403）+ トークン（定数時間の比較・欠落と不一致は close 1008）。UDS はトークン不要で、runtime-dir 0700（所有者と mode を検査し、広ければ起動しない）+ ソケット 0600。取り残しのソケットは消し、生きているソケットがあれば起動しない。パスが長すぎれば macOS は `getconf DARWIN_USER_TEMP_DIR` へ退避。TCP に `/mcp` は無い（404）。params と結果はスキーマ（Ajv 2020）で検査し、スキーマの外の結果は wire に出さない
- **層 2 の芯**（`packages/session/src/host/`）: `EngineHost`（`InterpreterV2` を in-process で持つ。凍結版が子プロセスの env / 引数で渡していたものを daemon を起こす前に写す・停止は凍結版 `cli/shutdown.ts` の順で `quit()` の後に応答）/ `SessionCore`（`session.evaluate`・`getState`・`getLog`・`shutdown`・`engine.*`・`evalId`・`target` の記憶）/ `LogHub`（ring は凍結版と同じ文字列・容量 1000・既定 50）/ `log-classify`（凍結版 `shouldFilterLine` の写しを凍結版と同じ答えか事例で確かめる・daemon の level）
- **console の横取り**（台帳 P-07 を `open`）: engine の `[STEP]` → `transport.step`（`source: null`）、`✅ Global running` 等 → `transport.state`、それ以外 → `log.line`。評価の最中の行に `evalId` / `clientId` を付ける
- 未実装のメソッドは `METHOD_NOT_FOUND`（台帳に **P-19** を新設・設計 §1.4.1 にも行）。スキーマに `ENGINE_NOT_RUNNING` を足した（設計 §5.9 S-8）
- 設計 §5.3.2 の未確認（`engine.stop` が daemon の消滅を待つか）を確かめた: `quit()` は SIGTERM の経路では `exit` を待つが、SIGKILL へ昇格した経路は待たない（設計 §5.9 に記録・engine 線への提案）

Part of #1001

---

### feat(protocol): add the session protocol v1 schema, the generated TS types and the Apache-2.0 license (Oct 26, 2026)

**Date**: 2026-10-26 / **ブランチ**: `1001-a1-protocol-schema`（`1001-a0-eval-intake` の上に積んだ小 PR・stacked の draft）/ **Issue**: [#1001](https://github.com/signalcompose/orbitscore/issues/1001)（束 S-rpc・計画 §7.1 の C-2 = N1-a1）

- **正本** `protocol/session/v1/session.schema.json`（JSON Schema 2020-12）: 型（`$defs`）と、メソッドの一覧 `x-methods`（方向・種類・`x-surfaces`・`x-mcp-tools`・エディタへの転送 `x-editor-request`）とエラーコード `x-errors`。メソッドは設計 §5.3 の写像（`session.evaluate` の `target`・`evalId`・`transport.step` の `source`・`log.line` の `level` / `kind`・`session.attach` の `token`）
- **生成** `scripts/protocol/generate.mjs`（`json-schema-to-typescript` 15.0.4・repo の prettier 設定で整形）→ `protocol/gen/ts/session/v1/session.d.ts`（型と、メソッド名 → 型の対応表）。`npm run protocol:generate` / `protocol:check`。`npm test` の `tests/protocol/generated-types.spec.ts` も差分ゼロを検査。N0-b までは TS 側だけ（台帳 P-18 を `open`・印は生成スクリプト）
- **D-4**（`tests/protocol/surface-coverage.spec.ts`）: `gui` を持つメソッドは `mcp` も持つ。`x-mcp-tools` の和集合 = 凍結版の 28 本
- **`protocol/LICENSE`** = Apache-2.0 の全文（一方通行 N-14）。sha256 を spec で固定。`protocol/` は npm workspace の `@orbitscore/protocol`（`license: Apache-2.0`）にし、層 2 は型を `@orbitscore/protocol/gen/ts/...` から読む
- 設計 §5.9 に、スキーマを書いた時に補ったもの 7 件（`x-surfaces` の語彙・attach の版と MAJOR だけの拒否・`didOpen` の `version` ほか）を owner の確認待ちとして記録
- ルートの `package.json` の workspaces に `protocol` を足して行がずれたので、dev サイトの引用 4 か所（`package.json:19` / `:20-21`）を `check-citations.mjs --fix` で直し、着地先（`test` と `pretest:e2e:gated` の行）を目で確かめた

Part of #1001

---

### feat(session): add the evaluation intake scaffold, its parity test and the provisional ledger (Oct 26, 2026)

**Date**: 2026-10-26 / **ブランチ**: `1001-a0-eval-intake`（統合ブランチ `1001-session-rpc` 向けの小 PR・stacked の draft・PR #1005）/ **Issue**: [#1001](https://github.com/signalcompose/orbitscore/issues/1001)（束 S-rpc・計画 §7.1 の C-0 / C-1）

OrbitStudio の層 2 `packages/session` を新設し、最初の小 PR（N1-a0）を入れた。クラウド（Linux）の作業で、音は出していない。

- **評価の受付口の足場**（`packages/session/src/eval/evaluation-intake.ts`・台帳 P-01）: 凍結版 `createReplSession` の区切り方の写し。写す相手は MCP の経路（`writeCodeToEngine` の枠 + `//#evalMark`）。結果は構造化した値（`ok` / `diagnostics` / `documentDirectory`）で返し、stderr の行は `log`（`kind` = diagnostic / stall / session）へ。engine は `@orbitscore/engine/dist/<module>` で読み、テストでは vitest の alias で src に向ける（`npm test` は build より前に走る）
- **差分テスト**（`tests/session/eval-intake-parity.spec.ts`・台帳 P-02）: 凍結版の側は拡張の本物の `writeCodeToEngine` が書いた行を流す。`execute()` の呼び出し・バッチの開閉・`[ERROR]` の行を起きた順に比べ、各評価の診断も比べる。コーパス 23 件（#607 / #612 / #614 / #476・#997 の検証ケース 8 件）。写しを 6 通りに壊すとそれぞれ該当ケースが red になることを確かめた
- **暫定物の台帳**（`tests/repo/native-provisional-ledger.ts` / `.spec.ts`・設計 §1.4.2）: P-01〜P-18 と検査 1〜7。release モード（`ORBIT_RELEASE_PREFLIGHT=1`）は今は落ちる（足場が開いているので正しい）
- **D-8 の follow-up**（台帳 P-10 を閉じた）: `planning-issue-state.spec.ts` の `DOCUMENTS` に新地図と新計画
- 計画 §2.1 と地図 §4.A に #1001 と統合ブランチ名を記録

Part of #1001

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
- [2026-09（前半・09-01〜09-14）](../archive/WORK_LOG_2026-09.md) — #939 / #940（カーソル位置のプラグイン UI・プラグイン窓の前面化）と 4.2.0 リリース (#943)、#883 束 C のレビュー round 1、#883 束 S / 本体 (#883)、#888 子 1、#878、4.1.0 リリース (#926)、pan を両段とも減衰のみにした裁定 (#921/#922)、E2E-4/E2E-5 の実機実装 (#917) を含む
