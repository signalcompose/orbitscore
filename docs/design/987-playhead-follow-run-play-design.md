# #987 A: ライブ再生位置を「流した play()」に付ける — 設計

- 状態: 設計確定（2026-10-19）。起案は fresh Opus subagent、確認は main（§8）
- 範囲: Issue #987 の **A のみ**（拡張の中だけで直すバグフィックス）。B（`[STEP]` に世代番号を足して、反映の時点で切り替える）は作らず、Issue に残す
- 対象 commit: main `19910c16`。根拠の行番号はすべてこの commit のもの

---

## 0. 設計の前に確かめた事実

| # | 事実 | 根拠 |
|---|---|---|
| F1 | DSL のコメントは `//` から行末まで。文字列の外なら、どこで始まってもコメントになる | `packages/engine/src/parser/tokenizer.ts:61-68`, `:138-140` |
| F2 | ブロックコメント（`/* */`）は無い | `tokenizer.ts:268-278` |
| F3 | 文字列は `"` と `'`。`\` で次の 1 文字をエスケープする。改行では終わらず、閉じなければ EOF まで続く | `tokenizer.ts:116-133`, `:198-203` |
| F4 | `_play()` は実装されていない。`seq._play(` はパースエラーになる。仕様書も「設計のみ・未実装」と書いている | `tokenizer.ts:179-186`, `parse-statement.ts:665-671`, `docs/core/INSTRUCTION_ORBITSCORE_DSL.md:494-505` |
| F5 | 今の正規表現は `hh._play(1)` に当たらない。一方、`// hh.play(1)` と `"hh.play("` には当たる | `packages/vscode-extension/src/playhead.ts:226` |
| F6 | `play()` はパターンを上書きする。1 回の評価の中では最後の `play()` が残る。ループ中なら次の周期で反映される | `packages/engine/src/core/sequence.ts:1218-1245`, `:247-263` |
| F7 | カーソル実行（選択なし）の subject-block モードは、ファイル全体からその subject の行だけを集めて送る。`executionRange` は最初の行から最後の行までを覆うが、そのあいだにある別の subject の行は送られていない | `packages/vscode-extension/src/run-selection.ts:63-111` |
| F8 | `engineGeneration` は、エンジンの起動時と停止時に必ず増える | `engine-process.ts:424-425`, `:459-460`、`extension-state.ts:52`, `:116-118` |
| F9 | 再生位置や decoration を読む MCP ツールは無い | `mcp-tools-*.ts`、`mcp-types.ts:78-88` |
| F10 | 既存の gated E2E は `[STEP]` 行までしか見ていない。decoration は見ていない | `tests/e2e/orbitstudio-mcp-gated.spec.ts:3035-3145` |
| F11 | 既存の gated E2E は `run_selection` を 8 回、`evaluate_orbitscore` を 84 回呼ぶ。今回足すコードは、実機の各実行で必ず通る | 同ファイルの grep |
| F12 | vscode モックには `TextEditorRevealType` が無い。`onDidChangeTextDocument` の listener も捕まえていない | `tests/mocks/vscode.ts:158-219` |

## 1. 決定表

| 論点 | 決定 | 根拠 |
|---|---|---|
| 記録するもの | シーケンス名ごとに 1 件。`{ kind: 'call'; docUriString; callStart; openParen; engineGeneration }` か、墓標 `{ kind: 'invalidated'; docUriString; engineGeneration }`。`callStart` は seq 名の先頭、`openParen` は `play(` の `(` の、文書の中の文字オフセット | 最後に流した 1 件だけが意味を持つ（F6） |
| 置き場所 | 状態（Map）は `playhead-decorations.ts`。計算はすべて `playhead.ts` の純関数（vscode に依存しない） | 再生位置の状態はすでに `playhead-decorations.ts:24-27` にある。`playhead.ts:19-21` |
| 記録する時点 | `runSelection` の中で、`writeCodeToEngine` が成功した直後（`run-selection.ts:199-201` の後） | 送れなかったときに記録すると、表示が実際と食い違う |
| 送った範囲 | `runSelection` が `sentRanges: vscode.Range[]` を作る。選択あり → `[selection]`。subject-block → 集めた行（続き行を含む）を、**連続する行ごとにまとめた**範囲（§8 M1）。standalone → `[executionRange]` | F7。`executionRange` を走査すると、送っていない別の seq の `play(` まで記録してしまう |
| 範囲内に複数あるとき | 文書の順に走査し、seq ごとに後から見つかったもので上書きする | F6 |
| `_play()` | 対象にしない | F4 |
| コメントと文字列 | `playhead.ts` に字句スキャナを 1 つ足す。`//` から行末までがコメント。文字列は `"` と `'`、`\` でエスケープ。**閉じていない文字列は改行で終える**（tokenizer とは意図的に違える。打ちかけの `"` で、後ろの `play()` がすべて消えるのを防ぐ）。`/* */` はコメントとして扱わない | F1〜F3 |
| 既存関数への適用 | `findPlayArgRanges` / `findPlayArgRangeForPath` も「コメントの外の最初の呼び出し」を使う。`splitGroupElements` は、引数の中のコメントと文字列を飛ばす（コメント中の `,` や括弧で分けない。trim のときはコメントを空白として扱う） | 記録が無いときにも完了条件 C3 を効かせる。今は複数行の `play(` の中に `1, // kick` と書くと、`// kick\n 0` という範囲を光らせる |
| 編集への追従 | `onDidChangeTextDocument` の `contentChanges` を**配列の順に逐次**記録へ当てて、位置をずらす。`[callStart, openParen+1)`（`hh.play(` の部分）と重なる変更があれば、記録を墓標にする。さらに表示の直前に、記録の位置が今もコメントの外の `<seq>.play(` かを毎回確かめる | 下の「3 案の比較」 |
| 記録が無いとき | 今の振る舞い。見えているエディタのうち、最初に呼び出しが見つかったものの、コメントの外の最初の `play()` | 完了条件 C4 |
| 記録が使えないとき（墓標・確かめ直しで不一致） | **その seq の表示を消す**。最初の `play()` には戻さない | 鳴っている呼び出しを編集で消したあとに最初の `play()` へ戻ると、「別の場所へずれる」（Issue の完了条件 5）そのものになる |
| MCP `evaluate_orbitscore` | 送ったコードを同じスキャナで走査する。コメントの外に `<seq>.play(` が現れた seq の記録を捨てる（→ 最初の `play()` に戻る）。捨てるのは `writeCodeToEngine` が成功した直後（`agent-handlers.ts:77-79` の後） | Issue の完了条件 4 |
| どのエディタに付けるか | 記録があるとき: `visibleTextEditors` のうち、URI が一致するものだけ。見えていなければ何もしない。記録が無いとき: 今の「最初のもの」 | 完了条件 C1 |
| E2E | vscode モックを通した統合テストで止める。新しい MCP ツールは作らない。実機の見た目は main がマージ前に 1 回、スクリーンショットで確かめる（C6） | §7 |

### 編集への追従: 3 案の比較

- **(a) k 番目で覚える**: 上に `hh.play(` を 1 行足す、またはコメントアウトするだけで番号がずれ、別の呼び出しを光らせる。安全側に反するので採らない
- **(c) 文書の version が変わったら捨てる**: ライブコーディングでは流したあとに編集するのが普通なので、打鍵 1 つで最初の `play()` へ戻ってしまう。これは本 Issue のバグそのものなので採らない
- **(b) ずらす**: 引数の中の編集は記録を壊さない（引数は表示のたびに今の文書から切り直す）。呼び出しの頭を壊したときだけ墓標にする。**これを採る**

確かめ直しの規則:
- 記録の位置がコメントの中になった場合（行頭に `//` を足した等）は、**その回は消すが、記録は残す**。`//` を外せば表示が戻る
- 墓標にするのは、頭そのものが変更されたときだけ

### 寿命

| 出来事 | 記録 | active range |
|---|---|---|
| `⏹ <seq>` | 残す | 消す（今の振る舞い） |
| `✅ Global stopped` | 残す | 全部消す（今の振る舞い） |
| エンジンの停止・終了・再起動 | 世代番号が違えば「記録無し」として扱う（配線を足さない） | 全部消す（今の振る舞い） |
| 文書を閉じる | 何もしない | — |
| 拡張の再起動 | モジュールの状態ごと消える | — |
| `__resetPlayheadStateForTest` | 消す（追記する） | 消す |

### 別の seq の古い range

`applyPlayheadDecorations`（`playhead-decorations.ts:64-87`）は、どこかの seq が 1 歩進むたびに、全 seq の保存済み `vscode.Range` を描き直す。そのため編集のあと、まだ進んでいない seq の range が古い座標のまま描かれる（今もある問題）。

対策: 同じ change listener の中で、その文書の active range のうち、変更の開始位置より後ろに end があるものを削除する（`applyPlayheadDecorations` はここでは呼ばない）。削除した seq は、次に自分が進んだときに今の文書から描き直される。

## 2. 変更するファイル

| ファイル | 要点 |
|---|---|
| `packages/vscode-extension/src/playhead.ts` | ① 字句スキャナと `export interface PlayCall { seqName; callStart; openParen }`、`export function findPlayCalls(text): PlayCall[]`（コメントと文字列の外の `<ident>.play(` を文書の順に返す。境界条件は今の正規表現 `:226` と同じ） ② `splitGroupElements` をコメントと文字列に対応させる ③ `findPlayArgRanges(text, seq, openParen?)` / `findPlayArgRangeForPath(text, seq, argPath, openParen?)`（`openParen` を省くと最初の呼び出し。互換を保つ） ④ `resolvePlayheadStep(text, seq, argPath, anchor?)` → `{kind:'range', range}` / `{kind:'out-of-range'}` / `{kind:'no-call'}` ⑤ `shiftPlayCallAnchor(anchor, changes)` → 新しい anchor か `null` ⑥ `:216-221` の「MVP scope … first match」の docstring を書き換える |
| `packages/vscode-extension/src/playhead-decorations.ts` | ① `playheadSources` Map ② `recordPlayheadSources(document, sentRanges)` ③ `forgetPlayheadSourcesInCode(code)` ④ `notePlayheadDocumentChange(event)` ⑤ `showPlayheadStep` を記録のあり／なしで分ける ⑥ `__resetPlayheadStateForTest` に追記。新しい状態とコードは `handleStepLine`（`:96-107`）より後ろに置く（dev サイトの引用がずれないように） |
| `packages/vscode-extension/src/run-selection.ts` | 3 つの経路で `sentRanges` を作る。`writeCodeToEngine` が成功した直後に `recordPlayheadSources` を呼ぶ |
| `packages/vscode-extension/src/agent-handlers.ts` | `evaluateForAgent` で、`writeCodeToEngine` が成功した直後に `forgetPlayheadSourcesInCode(code)` を呼ぶ |
| `packages/vscode-extension/src/extension.ts` | `activate()` で `onDidChangeTextDocument(notePlayheadDocumentChange)` を登録する（診断用の listener とは別の 1 本） |
| `tests/mocks/vscode.ts` | `TextEditorRevealType` と、`onDidChangeTextDocument` の listener を捕まえる配列・reset を足す |

触らないもの: エンジン、`[STEP]` の書式、`engine-lifecycle.ts` の effect インターフェイス、`engine-process.ts`、設定、コマンド、MCP ツール。

`showPlayheadStep` の擬似コード:

```ts
const src = currentSource(step.seqName) // 世代が違う → undefined
if (src) {
  if (src.kind === 'invalidated') return clearPlayheadForSequence(step.seqName)
  const editor = visibleTextEditors.find(e => e.document.uri.toString() === src.docUriString)
  if (!editor) return
  const r = resolvePlayheadStep(editor.document.getText(), step.seqName, step.argPath, src)
  switch (r.kind) { // never で網羅を検査する
    case 'no-call': return clearPlayheadForSequence(step.seqName)
    case 'out-of-range': return // 前の表示を残す（今の振る舞い）
    case 'range': setActive(editor, r.range); return applyPlayheadDecorations()
  }
}
// 記録が無い: 今の振る舞い（コメントの外の最初の呼び出し、見えているエディタのうち最初のもの）
```

## 3. 完了条件

| # | 条件 | 検証 |
|---|---|---|
| C1 | 文書 A で流したあと、`[STEP]` は A を表示しているエディタにだけ付く。同じ seq の `play()` を持つ文書 B が `visibleTextEditors` の先頭にあっても B には付かない。A が見えていなければ、どこにも付かない | I1, I2 |
| C2 | 同じ seq の `play()` が複数あるとき、表示は最後に送った範囲の中の、文書の順で最後の `play()` に付く。subject-block でも、送った行だけが対象になる。`play()` を含まない範囲（`LOOP(hh)` 等）を流しても記録は変わらない。`._play(` は対象外 | P1〜P3, I3〜I7 |
| C3 | 行コメント、行末コメント、文字列の中の `<seq>.play(` には、記録の有無にかかわらず付かない。`play(` の引数の中のコメントで、引数の範囲を誤らない | P4〜P8, I8 |
| C4 | 記録が無いとき（起動直後、MCP evaluate で `<seq>.play(` を送った直後のその seq、エンジンの停止・再起動の後）は今と同じ振る舞い。`⏹ <seq>` と `✅ Global stopped` では記録は消えない | I9〜I13 |
| C5 | 流したあとの編集で、表示が別の `play()` や別の文字へ移らない。前への挿入 → 同じ呼び出しを追う。引数の中の編集 → 今の文字から切り直す（範囲外なら前の表示を残す）。頭を壊す・行ごと消す → 何も光らない。コメントアウト → 光らず、外せば戻る。別の seq の古い range は、古い座標で描き直されない | P9〜P11, I14〜I18 |
| C6 | 実機（stock VS Code）で、Issue の最小例を使う。① 上を流す → 上の行を動く ② 切り替えブロックを選択して流す → 1 周期以内に下の行へ移り、5〜8 歩目も光る ③ 上に `// hh.play(9, 9)` を足す → 表示は下に残る ④ 下の行を消す → 光らない。main がスクリーンショットで 1 回確かめる | 手動 |
| C7 | `npm test`・`npm run lint`・`npm run docs:check`・実機 gated 全件が緑 | 機械 |

## 4. テスト

### 4.1 純関数（`tests/vscode-extension/playhead.spec.ts` に追記）

| ID | 内容 |
|---|---|
| P1 | `findPlayCalls` が、コメントの外の play 呼び出しを文書の順にすべて返す。`callStart` / `openParen` は `indexOf` で求めた値と一致する |
| P2 | 識別子の境界は今の正規表現と同じ（`mydrum.play(` / `foo.drum.play(` は `drum` ではない。`drum . play (` は `drum`） |
| P3 | `hh._play(1)` → 0 件 |
| P4 | 行コメント・行末コメントの中の呼び出しを無視する |
| P5 | `"`・`'`・エスケープを含む文字列の中の呼び出しを無視する |
| P6 | 閉じていない文字列は改行で終わる |
| P7 | `/* hh.play(9) */` は 1 件（tokenizer に忠実であることを固定する） |
| P8 | 複数行の引数の中のコメントを飛ばす: `'hh.play(\n  1, // kick, (x\n  0\n)'` → `['1','0']` |
| P9 | `shiftPlayCallAnchor` は、頭より前の編集でずれる（`callStart` の位置への挿入もずれる） |
| P10 | `play(` より後ろの編集では anchor を変えない |
| P11 | 頭と重なる変更では `null`。2 つの変更を逐次で当てる表形式のテストも置き、当てたあとのテキストを `slice` すると `hh.play(` になることまで確かめる |
| P12 | `resolvePlayheadStep` が range / out-of-range / no-call を区別する |

既存テストの書き換え: `playhead.spec.ts:109` `uses the FIRST play call when the seq has several (MVP scope)` → `without an anchor, falls back to the FIRST non-comment play call`。期待値は同じで、先頭に `// drum.play(7)` を足した入力も同じ期待値にする。

### 4.2 vscode モックを通した統合テスト（新しいファイル `tests/vscode-extension/playhead-source.spec.ts`）

`runSelection()` を直接呼び、`handleStepLine` → タイマーを進める → `editor.setDecorations` の引数で判定する。

| ID | 内容 |
|---|---|
| I1 | visible = [B, A]（B が先頭）、A で流す → A にだけ付く |
| I2 | A で流したあと visible = [B] → どこにも付かない |
| I3 | Issue の最小例。下の行を選択して流す → `[STEP] hh 5` が下の行の 6 個目の要素に付く |
| I4 | 1 回の選択に `hh.play` が 2 つ → 後ろのもの |
| I5 | subject-block: 送っていない行（別の seq）は記録されない |
| I6 | `play()` を含まない範囲を流しても、記録は変わらない |
| I7 | stdin への書き込みに失敗したら、何も記録しない |
| I8 | 範囲内のコメントアウトされた `play` は記録しない |
| I9 | 記録が無いとき → コメントの外の最初の `play()` |
| I10 | MCP evaluate で `hh.play` を送る → hh の記録だけ捨てる |
| I11 | MCP evaluate で `LOOP(hh)` → 記録はそのまま |
| I12 | エンジンの世代が変わる → 記録無しとして扱う |
| I13 | `⏹ hh` / `✅ Global stopped` → 記録は残る |
| I14 | 上に `hh.play(7, 7)` の行を挿入 → 元の呼び出し（ずれた後の位置）を追う |
| I15 | 引数の中の編集 → 今の文字から切り直す。範囲外なら前の表示を残す |
| I16 | 流した行を削除 → 何も光らない（上の行には付かない） |
| I17 | 行頭に `// ` を挿入 → 消える。外す → 戻る |
| I18 | 編集の後、別の seq の古い Range を描き直さない |
| W1 | `activate()` が document-change の listener を登録している |

## 5. ドキュメント

| ファイル | 内容 |
|---|---|
| `CHANGELOG.md` `[Unreleased]` `### Fixed` | 修正の内容と、既知の制約（境目の最大 1 周期のずれ） |
| `docs/development/WORK_LOG.md` | コミットごと |
| `sites/dev/editor/mcp-and-gated-e2e.md` と `en/` | `playhead-decorations.ts:109-128` の引用の差し替え。散文「最初の `<seqName>.play(` を探し」の書き直し |
| `sites/dev/editor/execution-feedback.md` と `en/` | `:332` の散文の書き直し。すでに古い `playhead.ts:509-534` の訂正 |
| 引用の行ずれ全般 | `npm run docs:check`。`--fix` を使う場合は、引用が別の関数に着地していないかを目で確かめる |

ユーザー向けサイトに再生位置の記述は無い（grep で確認）。

本 PR の外（別 Issue の候補）:
1. `sites/user/basics/live-coding.md:179-193` が、未実装の `_play()` を使える機能として説明している（F4）
2. チェーンの途中の `play(`（`kick.beat(4 by 4)…play(1, 0, 1, 0)` 等）には、今も今後も再生位置が付かない
3. 拡張にある字句処理 4 つ（`dsl-completion-context.ts` / `plugin-name-diagnostics.ts` / `plugin-ui-at-cursor.ts` / 本 PR）の共通化

PR の本文は `Refs #987`（B が Issue に残るため、閉じない）。

## 6. 不確実な点

| ID | 内容 | 確信度 | 反証の仕方 |
|---|---|---|---|
| U1 | `contentChanges` は配列の順に逐次当てる意味論である（一次ソースは未確認） | 中 | 実機で複数カーソルの編集をして、表示が同じ呼び出しに残るかを見る。外れても、表示の直前の確かめ直しで大半を捕まえる |
| U2 | `setDecorations` で付けた装飾は、編集に追従して動く | 中 | C6 ③で確かめる。外れても、次の 1 歩で描き直される |
| U3 | 閉じていない文字列を改行で終える判断 | 中〜高 | 複数行にまたがる文字列を DSL が実際に使っていれば、ずれる |
| U4 | 文書の中ではコメントにあたる部分だけを選んで流すと、記録はされるが表示はされない（音は変わる） | 高 | owner がこの使い方を想定しているなら裁定が要る |
| U5 | エディタ経路では、評価に失敗しても記録は切り替わる（評価との相関が無い）。正確な相関は B で取る | 高 | — |
| U6 | 文書を閉じても記録を残す | 中 | 「閉じたら戻す」が好まれるなら、`onDidCloseTextDocument` で消す小さな変更で切り替えられる |

## 7. E2E を vscode モックの統合テストで止める理由

1. 観測する手段が無い（F9）。実機 E2E にするには新しい MCP ツールが要る。これは機能凍結中の拡張に新しい公開面を足すことになり、「新しいコマンドを足さない」という決定に触れる
2. debug ログに解決結果を出して `get_log` で読む案は、decoration ではなく解決関数の出力を見ることになる。モック統合テストと同じ範囲しか確かめられず、テストのためだけの出力形式が増える
3. 配線は、モック統合テストで本物の関数を端から端まで通せる（`runSelection` → 記録 → `handleStepLine` → `showPlayheadStep` → `applyPlayheadDecorations` → `editor.setDecorations`）
4. 実機でしか分からないのは U1 と U2 だけで、どちらも外れたときに今より悪くならないように作ってある。新しいコードが実機で throw しないことは、既存の gated 全件が確かめる（F11）
5. 見た目は C6 で main が 1 回確かめる。これを資産として残す E2E の代わりにしたことは、PR 本文に明記する

## 8. main の確認（2026-10-19）

- **M1（修正）**: subject-block の `sentRanges` は「集めた行ごと」ではなく、**連続する行（`parenBalance` で集めた続き行を含む）ごとにまとめた範囲**にする。行ごとに切ると、`hh\n  .play(` のように頭が行をまたぐ呼び出しを取りこぼす
- **M2（採用）**: 「記録が使えないときは消す」（最初の `play()` に戻さない）を採る。Issue の完了条件 5 の安全側の書き方と一致する
- **M3（採用）**: 引数の中のコメントへの対応（`splitGroupElements`）は範囲に含める。同じスキャナで済み、間違った引数を光らせる不具合を直すため
- **M4（採用）**: 別の seq の古い range の削除は範囲に含める。完了条件 5 の「別の文字へ移らない」に直接かかわるため
- **M5**: E2E は §7 のとおり。PR 本文と owner への報告で明示する
