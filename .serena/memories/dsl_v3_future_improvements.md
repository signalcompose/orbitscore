# DSL v3.0 Future Improvements

このメモリは、PR #45のClaude reviewで指摘された将来的な改善項目を記録しています。

## 関連PR・Issue
- PR #45: DSL v3.0 Implementation (Underscore prefix + Unidirectional toggle)
- レビューコメント: https://github.com/signalcompose/orbitscore/pull/45#issuecomment-3384185056

---

## Issue 1: _method()の即時適用の実装検証

### 優先度
中優先度（次のPRまたはユーザーフィードバック後）

### 背景
現在の実装では、`_tempo()`, `_beat()`, `_length()`などのアンダースコアメソッドは内部状態を変更しますが、実際に「再生トリガー」や「即時反映」が完全に機能しているかが不明確です。

### DSL仕様書の記載
```
_method() - 即時適用
- 値を保存 + 再生トリガー/即時反映
- ライブコーディング時の即座の変更に使用
```

### 確認が必要な点
1. `seamlessParameterUpdate()`メソッドが実際に機能しているか
   - 実装場所: `packages/engine/src/core/sequence.ts:130-148`
2. ループ中に`_tempo()`を呼んだ時、即座にテンポが変わるか
3. `_audio()`, `_chop()`, `_play()`にも同様のシームレス更新が必要か
4. 必要ない場合、なぜ`_tempo`/`_beat`/`_length`のみに適用されているか

### 推奨対応
1. 実際にループ再生中に`_tempo(120)`を実行し、即座にテンポが変わることを確認
2. 必要なら、`seamlessParameterUpdate()`を他のメソッドにも適用
3. 各メソッドの即時反映の仕様をコメントで明記
4. 統一的なシームレス更新パターンを設計・文書化

### 実装場所
- `packages/engine/src/core/sequence.ts` - _method()実装
- `packages/engine/src/core/global.ts` - Globalの_method()
- `docs/DEVELOPER_GUIDE.md`（新規セクション） - 設計ガイドライン

### 推定工数
2-3日（設計・実装・テスト含む）

---

## Issue 2: MUTE動作の仕様の妥当性確認

### 優先度
低優先度（ユーザーフィードバック待ち）

### 背景
現在の仕様では「MUTE only affects LOOP playback, not RUN」となっていますが、ユーザーがRUN中のシーケンスをミュートしたいケースがあるかもしれません。

### 確認が必要な点
1. RUN中にミュートできないことが本当に妥当か
2. ライブコーディングのユースケースで不便はないか
3. 将来的にRUNでもミュート可能にしたい場合、破壊的変更になるか

### 推奨対応
1. ユーザーフィードバック収集
2. 必要なら、別の予約語（例: SOLO）を検討
3. ドキュメントに「なぜRUNではミュートできないか」の設計判断を記録
   - 実装場所: `docs/INSTRUCTION_ORBITSCORE_DSL.md` - Design Rationale セクション

### 推定工数
- フィードバック収集: 継続的
- 仕様変更が必要な場合: 3-5日

---

## Issue 3: エッジケーステストの追加

### 優先度
中優先度（次のPRで対処可能）

### 背景
RUN/LOOP/MUTEコマンドの堅牢性を向上させるため、エッジケースのテストカバレッジを追加する必要があります。

### 不足しているテストシナリオ
1. **空のコマンド**: `RUN()`, `LOOP()`, `MUTE()`を引数なしで呼んだ場合
2. **重複シーケンス**: `RUN(kick, kick, kick)`のような重複
3. **存在しないシーケンス**: `RUN(nonexistent)`の場合（現在は警告のみ）
4. **RUN→LOOPの遷移**: RUN中のシーケンスをLOOPに移行した場合の挙動
5. **同時MUTE**: MUTE状態でRUNを呼んだ場合（MUTEはLOOPのみ有効）

### 実装場所
`tests/interpreter/unidirectional-toggle.spec.ts`

### 推定工数
1日（テスト実装・修正含む）

---

## Issue 4: パフォーマンス最適化

### 優先度
中優先度（次のPRで対処可能）

### 背景
`handleLoopCommand`で2回ループしており、最適化の余地があります。

### 該当箇所
`packages/engine/src/interpreter/process-statement.ts:224-251`

### 現在の実装
```typescript
// Stop sequences that are no longer in LOOP group
for (const seqName of oldLoopGroup) {
  if (!newLoopGroup.has(seqName)) {
    // ...stop
  }
}

// Execute loop() on included sequences
for (const seqName of sequenceNames) {
  // ...loop
}
```

### 提案
1回のループで統合、または差分計算を事前に行う：

```typescript
const toStop = [...oldLoopGroup].filter(name => !newLoopGroup.has(name))
const toStart = [...newLoopGroup].filter(name => !oldLoopGroup.has(name))

for (const seqName of toStop) {
  // stop
}

for (const seqName of toStart) {
  // loop
}
```

### 推定工数
0.5日

---

## Issue 5: ドキュメント充実

### 優先度
低優先度（将来的な改善）

### 背景
`INSTRUCTION_ORBITSCORE_DSL.md`には仕様は記載されていますが、実用的な使用例が少ないです。

### 追加すべき内容
1. セットアップフェーズとライブコーディングフェーズの完全な例
2. RUN/LOOP/MUTEの組み合わせパターン集
3. 移行ガイド（v2.0 → v3.0）の具体例を増やす
4. トラブルシューティングガイド

### 実装場所
- `docs/USER_MANUAL.md` - ユーザー向け実用例
- `docs/MIGRATION_GUIDE_v3.md`（新規作成） - 移行ガイド
- `examples/live-coding-patterns/`（新規ディレクトリ） - パターン集

### 推定工数
1-2日

---

## Issue 6: E2Eテストとインタプリタv2テストのSC依存性

### 優先度
低優先度（現状で問題なし）

### 背景
E2Eテストとinterpreter-v2.spec.tsは、SuperCollider起動が必要なためスキップされています。

### 対応済み
- テストファイルにコメント追加（2025-01-09）
- スキップ理由とテスト実行手順を明記

### 将来的な改善案
1. SCモックをさらに充実させ、SCなしでもE2Eテストを実行可能にする
2. CI環境でのSC起動を検討（Docker等）
3. 定期的な手動E2Eテスト実行のワークフローを確立

### 推定工数
- SCモック充実: 2-3日
- CI環境構築: 3-5日

---

## 総括

これらの改善項目は、DSL v3.0の基本実装が完了した後に取り組む予定です。優先度は以下の通り：

**高優先度（マージ前）**: ✅ 完了
- エラーハンドリング強化
- MUTE初期化の明確化

**中優先度（次のPRで対処可能）**:
- エッジケーステストの追加
- パフォーマンス最適化
- _method()の即時適用検証

**低優先度（将来的な改善）**:
- ドキュメント充実
- MUTE仕様の妥当性確認
- E2Eテストの改善

---

*作成日: 2025-01-09*
*関連PR: #45*
*次回更新: ユーザーフィードバック収集後、または次のPR作成時*
