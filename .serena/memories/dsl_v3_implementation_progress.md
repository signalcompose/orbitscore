# DSL v3.0 実装進捗

## 概要
アンダースコア接頭辞による設定/即時反映の統一仕様を実装中

## Issue & Branch
- **Issue**: #44 - DSL v3.0 - アンダースコア接頭辞による設定/即時反映の統一
- **Branch**: `44-dsl-v3-underscore-prefix`
- **Base Branch**: `42-setting-synchronization-system`

## 完了した作業（Phase 1）

### コミット: `f012e30`
- `gain()` と `pan()` を設定のみモードに変更
  - `seamlessParameterUpdate()` を呼ばない
- `_gain()` と `_pan()` を追加（即時反映）
  - `seamlessParameterUpdate()` を呼ぶ
- `defaultGain()` と `defaultPan()` を削除
- テスト更新（27 tests passed）

## 残作業

### Phase 2: 他のメソッドへの適用
以下のメソッドに同様の変更を適用する必要がある：

1. **tempo()**
   - 現在：バッファリング方式（playing/looping中は`_pendingTempo`に保存）
   - 変更後：設定のみ（バッファリングなし）
   - 追加：`_tempo()` で即時反映

2. **beat()**
   - 現在：バッファリング方式
   - 変更後：設定のみ
   - 追加：`_beat()` で即時反映

3. **length()**
   - 現在：バッファリング方式
   - 変更後：設定のみ
   - 追加：`_length()` で即時反映

4. **audio()**
   - 現在：バッファリング方式
   - 変更後：設定のみ
   - 追加：`_audio()` で即時反映

5. **chop()**
   - 現在：バッファリング方式
   - 変更後：設定のみ
   - 追加：`_chop()` で即時反映

6. **play()**
   - 現在：バッファリング方式
   - 変更後：設定のみ
   - 追加：`_play()` で即時反映

### Phase 3: トランスポート関数の片記号方式
- `STOP()` の削除（パーサー・インタプリタ）
- `UNMUTE()` の削除
- トランスポート関数のロジック修正
  - 指定されたシーケンス以外は自動停止/アンミュート

### Phase 4: ドキュメント更新
- `docs/INSTRUCTION_ORBITSCORE_DSL.md` → v3.0仕様に更新
- `docs/WORK_LOG.md` → セクション追加
- 使用例の更新

### Phase 5: PRマージ
- `42-setting-synchronization-system` へマージ

## 設計ノート

### バッファリングの廃止
Phase 1では `gain()/pan()` のバッファリングを廃止したが、Phase 2では `tempo()/beat()/length()/audio()/chop()/play()` のバッファリングも廃止する。

**現在の実装:**
```typescript
tempo(value: number): this {
  if (this.stateManager.isPlaying() || this.stateManager.isLooping()) {
    this._pendingTempo = value  // バッファに保存
  } else {
    this.tempoManager.setTempo(value)  // 即座に適用
  }
  return this
}
```

**新しい実装:**
```typescript
tempo(value: number): this {
  this.tempoManager.setTempo(value)  // 常に設定のみ
  return this
}

_tempo(value: number): this {
  this.tempoManager.setTempo(value)
  this.seamlessParameterUpdate('tempo', `${value} BPM`)  // 即時反映
  return this
}
```

### `applyPendingSettings()` の廃止
バッファリングを廃止するため、`applyPendingSettings()` メソッドも不要になる。

### `RUN()` と `LOOP()` の挙動変更
- 現在：`applyPendingSettings()` を呼んでバッファされた設定を反映
- 変更後：バッファがないため、現在の設定値をそのまま使用

## テスト戦略
- 既存のバッファリングテストを削除
- 新しい設定/即時反映のテストを追加
- setting-sync.spec.ts の大幅な変更が必要

## 注意点
- この変更は破壊的変更（Breaking Change）
- 既存のDSLコードで `RUN()` 前に設定を変更していた場合、動作が変わる可能性がある
- ただし、新しい仕様の方が直感的で予測可能
