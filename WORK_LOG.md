# OrbitScore 開発作業ログ

## プロジェクト概要
LilyPond に依存しない新しい音楽DSL（Domain Specific Language）の設計・実装プロジェクト。TidalCycles風の選択範囲実行とポリリズム/ポリメーターをサポートする。

## 開発環境
- **OS**: macOS (darwin 24.6.0)
- **言語**: TypeScript
- **テストフレームワーク**: vitest
- **プロジェクト構造**: monorepo (packages/engine, packages/vscode-extension)
- **バージョン管理**: Git

## Phase 1: パーサ実装 (完了)

### 1.1 プロジェクト初期化
**日時**: 2024年12月19日
**作業内容**:
- monorepo構造の確認
- 既存ファイルの調査（ir.ts, parser.ts, scheduler.ts, midi.ts）
- demo.oscファイルの内容確認
- 実装計画書（IMPLEMENTATION_PLAN.md）の作成

**技術的決定**:
- IR型定義を契約として凍結
- 段階的実装アプローチの採用
- テスト駆動開発の採用

### 1.2 テストフレームワーク導入
**日時**: 2024年12月19日
**作業内容**:
- Node.js標準テストからvitestへの移行
- vitest設定ファイル（vitest.config.ts）の作成
- テストスクリプトの更新

**技術的決定**:
- vitestの採用理由: TypeScriptサポート、高速実行、モダンなAPI
- テストファイルの配置: `tests/parser/parser.spec.ts`

### 1.3 トークナイザー実装
**日時**: 2024年12月19日
**作業内容**:
- Tokenizerクラスの実装
- トークン型定義（TokenType, Token）
- キーワード、数値、文字列、記号の解析
- コメント処理（# 構文）
- 小数点と乱数サフィックス（r）の処理

**実装詳細**:
```typescript
export type TokenType = 
  | "KEYWORD" | "IDENTIFIER" | "NUMBER" | "STRING" | "BOOLEAN"
  | "LPAREN" | "RPAREN" | "LBRACE" | "RBRACE" | "LBRACKET" | "RBRACKET"
  | "COMMA" | "AT" | "PERCENT" | "COLON" | "ASTERISK" | "CARET" | "TILDE"
  | "SLASH" | "NEWLINE" | "EOF";
```

**技術的課題と解決**:
- 課題: `U0.5` 構文の解析（識別子に小数点を含む）
- 解決: `readIdentifier()` メソッドで `/[a-zA-Z0-9_.]/` パターンを使用

### 1.4 パーサー実装
**日時**: 2024年12月19日
**作業内容**:
- Parserクラスの実装
- グローバル設定パース（key, tempo, meter, randseed）
- シーケンス設定パース（bus, channel, meter, tempo, octave, etc.）
- イベントパース（度数、音価、和音、オクターブシフト、detune、ランダム）

**実装詳細**:
```typescript
export class Parser {
  private tokens: Token[];
  private pos: number = 0;
  
  private parseGlobalConfig(): GlobalConfig
  private parseSequenceConfig(): SequenceConfig
  private parseSequenceEvent(): SequenceEvent
  private parseDurationSpec(): DurationSpec
  private parsePitchSpec(): PitchSpec
}
```

### 1.5 音価構文の実装
**日時**: 2024年12月19日
**作業内容**:
- 秒単位: `@2s`
- 単位: `@U1.5`, `@U0.5`
- パーセント: `@25%2bars`
- 連符: `@[3:2]*U1`（未実装）

**技術的課題と解決**:
- 課題: `@25%2bars` 構文の解析
- 問題: `this.expect("KEYWORD")` で `bars` を期待していたが、`bars` は `IDENTIFIER` タイプ
- 解決: `this.expect("IDENTIFIER")` に修正

### 1.6 和音構文の実装
**日時**: 2024年12月19日
**作業内容**:
- IR型定義の拡張: `chord` 型の追加
- 和音構文: `(1@U0.5, 5@U1, 8@U0.25)` の解析
- 各音高に個別の音価を付与する設計

**実装詳細**:
```typescript
export type SequenceEvent =
  | { kind: "note"; pitches: PitchSpec[]; dur: DurationSpec }
  | { kind: "chord"; notes: { pitch: PitchSpec; dur: DurationSpec }[] }
  | { kind: "rest"; dur: DurationSpec };
```

### 1.7 テストとGolden IR作成
**日時**: 2024年12月19日
**作業内容**:
- demo.oscの完全解析テストの実装
- Golden IR JSONファイルの作成
- テストの成功確認

**テスト結果**:
- ✅ グローバル設定: key=C, tempo=120, meter=4/4 shared
- ✅ シーケンス設定: piano, IAC Driver Bus 1, channel 1, tempo 132, meter 5/4 independent
- ✅ 和音: `(1@U0.5, 5@U1, 8@U0.25)` → chord型
- ✅ 休符: `0@U0.5` → rest型
- ✅ 単音: `3@2s` → note型（秒単位）
- ✅ 複雑な音価: `12@25%2bars` → note型（パーセント単位）

## 技術的成果

### 1. DSL設計の特徴
- **構文の一貫性**: すべての音価が `@` プレフィックスを使用
- **型安全性**: TypeScriptによる厳密な型定義
- **拡張性**: IR型定義による契約ベースの設計

### 2. パーサ設計の特徴
- **レキサー・パーサ分離**: TokenizerとParserの明確な分離
- **エラーハンドリング**: 詳細なエラーメッセージ（行・列番号付き）
- **再帰下降パーサ**: 各構文要素に対応するメソッド

### 3. テスト設計の特徴
- **Golden IR**: demo.oscの期待されるIR出力をJSONファイルとして保存
- **回帰テスト**: パーサの変更による既存機能の破綻を検出
- **vitest**: モダンなテストフレームワークによる高速実行

## コミット履歴

### 主要コミット
1. `c880244` - feat: implement basic parser structure with tokenizer and parser classes
2. `d068930` - feat: add vitest testing framework and improve parser
3. `c481545` - feat: fix parser sequence config parsing and add chord support
4. `3a49dd5` - feat: complete Phase 1 parser implementation

### コミット戦略
- **小さな単位でのコミット**: 各機能を段階的にコミット
- **意味のあるコミットメッセージ**: 変更内容を明確に記述
- **テスト付きコミット**: 各機能にテストを追加

## 次のフェーズ

### Phase 2: Pitch/Bend変換
- 度数→MIDIノート+PitchBend変換の実装
- オクターブ・係数・detune合成
- MPE/チャンネル割り当て

### Phase 3: スケジューラ + Transport
- LookAhead=50ms, Tick=5msでのスケジューリング
- shared/independentメーター対応
- Transport機能（Loop/Jump/Mute/Solo）

### Phase 4: VS Code拡張
- 選択範囲実行機能
- Transport UI
- エンジン連携

### Phase 5: MIDI出力実装
- CoreMIDI経由でのIAC Bus出力
- @julusian/midiを使用した実装

## 論文執筆用メモ

### 研究の意義
1. **音楽DSLの新たなアプローチ**: LilyPondに依存しない独立したDSL
2. **ポリリズム/ポリメーターの表現**: shared/independentメーターの実装
3. **実用的な音楽制作環境**: VS Code統合による開発体験

### 技術的貢献
1. **型安全な音楽DSL**: TypeScriptによる厳密な型定義
2. **契約ベースの設計**: IR型定義による安定したAPI
3. **テスト駆動開発**: Golden IRによる回帰テスト

### 今後の研究課題
1. **パフォーマンス最適化**: 大規模楽譜の解析性能
2. **ユーザビリティ**: エラーメッセージの改善
3. **拡張性**: 新しい構文要素の追加

## 参考文献・関連研究
- TidalCycles: Live coding music with Haskell
- LilyPond: Music notation software
- Domain Specific Languages: Design and Implementation
- TypeScript: Typed JavaScript at Scale

---

**作成日**: 2024年12月19日
**作成者**: AI Assistant
**プロジェクト**: OrbitScore
**フェーズ**: Phase 1 完了