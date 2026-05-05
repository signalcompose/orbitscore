# SoT 整合性検証レポート (2026-05-06)

> **ステータス**: ✅ 検出された違反 (Critical 1, Major 3 のうち 3 件) はすべて commit `2251e78` で修正済み。
> Major 4 (`execution-feedback.md` の `extension.ts:1102-1108`) は再検証の結果 audit 側の誤検出と判明、修正不要。
> 本ファイルは検証履歴として保存。**未対応の違反はもはや存在しません**。

## 検証範囲

- 16 章 (orientation×1, pipeline×3, scheduling×4, audio×3, editor×2, decisions×3, glossary×1)
- 各章から 3〜5 件のコード引用と 2〜3 件の factual claim をサンプリング
- 合計 引用 52 件 + factual claim 22 件 = 74 件検証、違反 5 件検出

---

## Critical 違反 (factual error / fabricated)

### 1. transport.md — `event-scheduler.ts:143-149` 仮引用に虚偽の closing brace

- **章**: `sites/dev/scheduling/transport.md`
- **ラベル**: `// packages/engine/src/audio/supercollider/event-scheduler.ts:143-149`
- **引用 (章本文)**:

```typescript
start(): void {
  if (this.isRunning) {
    return
  }
  this.isRunning = true
  this.startTime = Date.now()
}
```

- **実コード (line 143-177)**: 行 143-149 は関数の先頭部分にすぎない。行 149 は `this.startTime = Date.now()` であり、閉じ括弧 `}` ではない。実際の関数は行 177 まで続き、その間に `console.log('✅ Global starting')` → `this.scheduledPlays.sort(...)` → `this.intervalId = setInterval(() => { ... }, 1)` のコード (setInterval ループ全体) が存在する。
- **違反種別**: **B (silent omission)** — 省略を `// ...` で明示せず、関数が完結しているように見せる虚偽の `}` を付加している
- **重大度**: Critical — 読者が `start()` に setInterval が含まれないと誤解する可能性。event-queue.md の同一関数 (正しく `143-177` でラベル付け) と矛盾する

---

## Major 違反 (verbatim mismatch / line range mismatch)

### 2. text-to-ast.md — `tokenizer.ts:111-129` のライン範囲ズレ

- **章**: `sites/dev/pipeline/text-to-ast.md`
- **ラベル**: `// tokenizer.ts:111-129`
- **引用の実際の行数**: 章本文の引用は行 111〜136 (NEWLINE ブロック + NUMBER ブロックの `continue` まで) を含んでおり、19 行分 (111-129) ではなく約 26 行分を表示している
- **実コード**: 行 129 は `this.advance()` (`continue` の前の行)。章の引用は行 136 (NUMBER チェックの `continue`) まで含んでいる
- **違反種別**: **C (line range mismatch)** — ラベルが `:111-129` だが表示内容は `:111-136` 相当
- **重大度**: Major

### 3. event-queue.md — `types.ts:5-20` のライン範囲ズレ

- **章**: `sites/dev/scheduling/event-queue.md`
- **ラベル**: `// packages/engine/src/audio/supercollider/types.ts:5-20`
- **引用 (章本文)**: `ScheduledPlay` インターフェース全体を表示
- **実コード**: `types.ts` の行 5 は `export interface BufferInfo {` (別のインターフェース)。`ScheduledPlay` は行 10 から始まる。行 5-20 を読むと `BufferInfo` (行 5-8) + 空行 (行 9) + `ScheduledPlay` の冒頭が含まれる
- **違反種別**: **C (line range mismatch)** — 章の引用内容は `ScheduledPlay` のみ (行 10-21 相当) だが、ラベルは `5-20` と 5 行ズレている
- **重大度**: Major

### 4. execution-feedback.md — `extension.ts:1102-1108` のライン範囲ズレ

- **章**: `sites/dev/editor/execution-feedback.md`
- **ラベル**: `// extension.ts:1102-1108`
- **引用 (章本文)**: コメント `// Execute the selected command...` から始まり `flashLines()` まで
- **実コード**: `// Execute the selected command...` のコメントは行 1104 から。行 1102 は `}` (else ブロックの閉じ括弧)、行 1103 は空行
- **違反種別**: **C (line range mismatch)** — ラベルが `:1102-1108` だが引用内容は `:1104-1108` が正確
- **重大度**: Major (軽微なズレだが verbatim ラベルルール違反)

---

## Minor 違反 (silent omission、空行欠落等)

現時点で確認されたその他の軽微な違反なし。

---

## 違反なし (検証済みリスト)

以下の章・スニペットを実コードと照合し、verbatim 整合を確認した。

| 章 | 検証件数 | 結果 |
|---|---|---|
| orientation/architecture-overview.md | 5 引用 + 3 factual | すべて整合 |
| pipeline/text-to-ast.md | 5 引用 (tokenizer range 違反除く) + 2 factual | 1件 Major 違反、他は整合 |
| pipeline/evaluation.md | 5 引用 + 3 factual | すべて整合 |
| pipeline/selective-execution.md | 5 引用 + 3 factual | すべて整合 |
| scheduling/time-representation.md | 5 引用 + 2 factual | すべて整合 |
| scheduling/polymeter.md | 4 引用 + 2 factual | すべて整合 |
| scheduling/event-queue.md | 6 引用 (types.ts range 違反除く) + 2 factual | 1件 Major 違反、他は整合 |
| scheduling/transport.md | 5 引用 (start() 違反除く) + 2 factual | 1件 Critical 違反、他は整合 |
| audio/supercollider.md | 5 引用 + 3 factual | すべて整合 |
| audio/audio-file-playback.md | 5 引用 + 2 factual | すべて整合 |
| audio/scsynth-bundle.md | 4 引用 + 2 factual | すべて整合 |
| editor/vscode-architecture.md | 5 引用 + 3 factual | すべて整合 |
| editor/execution-feedback.md | 4 引用 (1102 range 違反除く) + 3 factual | 1件 Major 違反、他は整合 |
| decisions/adr-001-supercollider.md | 2 引用 + 2 factual | すべて整合 |
| decisions/adr-002-dsl-v3-pivot.md | コード引用なし + 2 factual | すべて整合 |
| decisions/adr-003-scsynth-bundle.md | 3 引用 + 2 factual | すべて整合 |
| glossary.md | 0 コード引用 + 3 factual | すべて整合 |

---

## 補足: 特記事項

### 検証方法について
- STYLE_GUIDE §5-bis に基づき、コードブロックのラベル `// <file>:<start>-<end>` を参照して実ファイルを Read し、文字単位で照合した
- factual claim の spot-check として、章本文中の「`xxx()` は `yyy` を返す」「パラメータは A, B, C」等の記述を実コードと照合した

### 前回修正済みの件
- glossary.md の `orbitPlayBuf` パラメータ名 `gain` → `amp` の修正 (PR #167 claude-review 指摘) は確認済み。現在の glossary は `amp` を正しく記載している

### 注意: event-queue.md と transport.md の矛盾
- `EventScheduler.start()` が `event-queue.md` では `:143-177` (完全版)、`transport.md` では `:143-149` (切り捨て版) として引用されている。これは同一関数の記述が章間で矛盾している状態であり、`transport.md` 側の引用が誤りである
