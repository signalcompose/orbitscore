# Phase 6 リファクタリング分析

## 調査日: 2025-01-07

## 対象ファイルの詳細分析

### 🔴 最優先: parse-expression.ts (339行)

**問題のメソッド**:
- `parseArgument()`: **119行** (32-150行)
  - 複数のトークンタイプ処理（負の数、数値、文字列、識別子、ネスト構造）
  - 明らかにSRP違反
  - 各トークンタイプごとにメソッド分割が必要

**その他のメソッド**:
- `parseRandomValue()`: 54行 (155-208) ← 50行超
- `parsePlayWithModifier()`: 36行 (213-248)
- `parseNestedPlay()`: 58行 (253-310) ← 50行超
- `parseCompositeMeter()`: 23行 (315-337)

**リファクタリング方針**:
1. `parseArgument()`を分割:
   - `parseNegativeNumber()`
   - `parseNumber()`
   - `parseString()`
   - `parseIdentifier()`
   - `parseParenthesizedExpression()`
2. 50行超のメソッドも分割

**推奨アプローチ**: Expression Strategy Pattern
- 各トークンタイプごとにパーサー関数を作成
- `parseArgument()`をディスパッチャーとして使用

---

### 🟡 高優先度: parse-statement.ts (250行)

**問題のメソッド**:
- `parseMethodCall()`: **100行** (112-211)
  - `.force`修飾子の処理
  - メソッドチェーンの処理
  - transport commandの処理
  - 複数の責務

**その他のメソッド**:
- `parseVarDeclaration()`: 62行 (46-107) ← 50行超
- `parseArguments()`: 33行 (216-248)
- `parseStatement()`: 18行 (24-41)

**リファクタリング方針**:
1. `parseMethodCall()`を分割:
   - `parseForceModifier()`
   - `parseMethodChain()`
   - `parseTransportCommand()`
2. `parseVarDeclaration()`も分割

**推奨アプローチ**: Command Pattern
- メソッドコール、transport、chainごとに専用パーサー作成

---

### 🟢 中優先度: audio/supercollider/event-scheduler.ts (244行)

**問題のメソッド**:
- `executePlayback()`: **54行** (170-223) ← 50行超
  - ドリフト計算
  - Gain変換（dB → amplitude）
  - OSCメッセージ送信
  - 3つの責務

**その他のメソッド**:
- `scheduleSliceEvent()`: 49行 (52-100)
- `start()`: 26行 (105-130)
- その他は小さい（50行以下）

**リファクタリング方針**:
1. `executePlayback()`を分割:
   - `calculateDrift()`
   - `convertGainToAmplitude()`
   - `sendPlaybackMessage()`
2. 可能であれば`scheduleSliceEvent()`も分割

**推奨アプローチ**: Extract Method + Helper Functions
- 計算ロジックをヘルパー関数に抽出

---

### ✅ 完了済み: core/sequence.ts (365行)

**状態**: Phase 4-4で完了
**最大メソッドサイズ**: 36行 (`loop()`)
**評価**: ✅ 全メソッドが50行以下
**結論**: **追加のリファクタリング不要**

ファイルサイズが大きいのは、多くの小さなメソッドが存在するため。
これ以上の分割は過度なモジュール化となり、逆効果。

---

## Phase 6 実施計画

### Phase 6-1: parse-expression.ts (最優先)
- **理由**: 119行の巨大メソッド
- **Issue**: `#32 - Refactor parse-expression.ts`
- **期待削減**: 約200行（ヘルパー関数・モジュール分割）

### Phase 6-2: parse-statement.ts
- **理由**: 100行のメソッド
- **Issue**: `#33 - Refactor parse-statement.ts`
- **期待削減**: 約100行

### Phase 6-3: event-scheduler.ts (オプション)
- **理由**: 54行のメソッド（緊急性は低い）
- **Issue**: `#34 - Refactor event-scheduler.ts`
- **期待削減**: 約50行

### ❌ Phase 6-4: sequence.ts (不要)
- **理由**: 既にリファクタリング済み、全メソッド50行以下
- **結論**: スキップ

---

## 優先順位の理由

1. **parse-expression.ts**: 119行メソッドは明らかに大きすぎる（最優先）
2. **parse-statement.ts**: 100行メソッドも大きい（高優先）
3. **event-scheduler.ts**: 54行は許容範囲だが、改善の余地あり（中優先）
4. **sequence.ts**: 既に完了（不要）

---

## 成功基準

Phase 6完了後：
- ✅ 全メソッドが50行以下
- ✅ 各メソッドが単一責任
- ✅ 115 tests passed
- ✅ リンターエラー0件

---

## 推定作業時間

- Phase 6-1: 2-3時間（複雑な分割）
- Phase 6-2: 1-2時間
- Phase 6-3: 1時間（オプション）
- **合計**: 4-6時間