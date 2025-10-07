# OrbitScore プロジェクトレビューガイドライン

## 🌐 言語設定 - CRITICAL REQUIREMENT

**⚠️ MANDATORY: ALL review comments MUST be written in JAPANESE (日本語) ⚠️**

**This is a CRITICAL requirement for this project. Failure to follow this will result in less effective communication with Japanese-speaking developers.**

- **ALL comments, explanations, and suggestions MUST be in Japanese**
- Technical terms can remain in English (例: SuperCollider, SynthDef, TypeScript)
- Code examples remain in English
- **Reason**: This project's developers are Japanese speakers, and Japanese communication is most efficient
- **IMPORTANT**: If you write in English, the review will be less effective for Japanese-speaking developers

## プロジェクト概要

OrbitScoreは、度数ベースの音楽DSLを持つライブコーディング用オーディオエンジンです。SuperColliderとの統合、カスタムDSL、VS Code拡張機能を含みます。

## セキュリティの重点領域

- **SuperColliderサーバーとの通信**: OSCメッセージの検証とエラーハンドリング
- **ファイル操作**: オーディオファイルパスの検証とサニタイゼーション
- **プロセス管理**: SuperColliderプロセスの適切な起動・終了処理

## アーキテクチャパターン

### DSL設計
- **仕様書準拠**: `docs/INSTRUCTION_ORBITSCORE_DSL.md`（v2.0）に厳密に従う
- **メソッドチェーン**: 仕様書で定義されたメソッドのみ使用
- **`play()`メソッドのネスト**: 括弧を使った構造の正しい実装
- **精度**: 小数第3位まで（3 decimal places）

### コード構造
- **モノレポ構成**: `packages/`配下にengine, parser, vscode-extensionを配置
- **TypeScript**: 厳格な型定義、デフォルトエクスポート禁止
- **テスト**: `tests/<module>/<feature>.spec.ts`の命名規則

### SuperCollider統合
- **SynthDef管理**: `packages/engine/supercollider/synthdefs/`に配置
- **setup.scdファイル**: SynthDef生成スクリプトの変更時は注意深くレビュー
  - パラメータの型と範囲の確認
  - エンベロープの適切な設定（doneAction: 2など）
  - バス番号の正しい使用（In.ar/Out.ar/ReplaceOut.ar）
- **オーディオデバイス**: 入力/出力/duplexの明確な分類
- **エラーハンドリング**: SuperColliderサーバーの起動失敗、SynthDef読み込みエラーの適切な処理

## コーディング規約

### TypeScript
- **明示的なエクスポート**: デフォルトエクスポート禁止
- **型定義**: すべての関数に戻り値の型を明記
- **定数使用**: マジックナンバー禁止、定数を使用

### 命名規則
- **関数**: camelCase
- **クラス**: PascalCase
- **定数**: UPPER_SNAKE_CASE
- **ファイル**: kebab-case

### ドキュメント
- **仕様書**: `docs/INSTRUCTION_ORBITSCORE_DSL.md`が最新のDSL仕様（v2.0）
- **実装計画**: `docs/IMPLEMENTATION_PLAN.md`でフェーズ管理

## よくある問題

### DSL関連
- **未定義メソッド**: 仕様書にないメソッドの追加（例: `config()`, `offset()`）
- **メソッドチェーン**: 仕様書で定義されたメソッドのみ使用
- **`play()`メソッドのネスト**: 括弧を使った構造の正しい実装
- **仕様書との整合性**: 最新のDSL仕様（v2.0）に厳密に従う

### SuperCollider関連
- **SynthDef未定義**: 使用前にSynthDefが読み込まれているか確認
- **オーディオデバイス**: デバイスIDの検証とエラーハンドリング
- **メモリリーク**: SuperColliderプロセスの適切なクリーンアップ

### テスト関連
- **ゴールデンファイル**: 回帰テスト用のゴールデンファイルの更新忘れ
- **非同期処理**: SuperColliderとの通信における適切なawait/Promise処理
- **テストの独立性**: 各テストが独立して実行可能か確認

## レビュー時の注意点

### 必須確認事項
1. **仕様書との整合性**: `docs/INSTRUCTION_ORBITSCORE_DSL.md`（v2.0）に厳密に準拠しているか
2. **テストの追加**: 新機能に対応するテストが追加されているか
3. **型安全性**: TypeScriptの型定義が適切か
4. **ライブパフォーマンスの安定性**: 本番環境での動作に影響する変更がないか

### パフォーマンス
- **オーディオバッファ**: 適切なバッファサイズとレイテンシ
- **メモリ使用**: 長時間実行時のメモリリーク
- **SuperCollider負荷**: 過度なOSCメッセージ送信の回避

### ライブコーディング特有の考慮事項
- **実行時エラー**: ライブパフォーマンス中のエラーハンドリング
- **状態管理**: グローバル状態の適切な管理
- **リアルタイム性**: オーディオ再生のタイミング精度

## 除外項目

以下は自動レビューの対象外としてください：
- **アーカイブファイル**: `docs/archive/`配下のファイル
- **生成ファイル**: `dist/`, `build/`, `*.scsyndef`
- **テストアセット**: `test-assets/`配下のオーディオファイル
- **一時ファイル**: `tmp/`配下のファイル

## 参考リンク

- [DSL仕様書](../docs/INSTRUCTION_ORBITSCORE_DSL.md)
- [実装計画](../docs/IMPLEMENTATION_PLAN.md)
- [プロジェクトルール](../docs/PROJECT_RULES.md)

---

## 🚨 FINAL REMINDER

**ALL REVIEW COMMENTS MUST BE IN JAPANESE (日本語) - NO EXCEPTIONS**

This is the most important rule for effective communication in this project.
