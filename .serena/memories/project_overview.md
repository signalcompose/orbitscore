# OrbitScore プロジェクト概要

## プロジェクト説明

OrbitScoreは、度数ベースの音楽DSLを持つライブコーディング用オーディオエンジンです。SuperColliderとの統合、カスタムDSL、VS Code拡張機能を含む包括的な音楽制作環境を提供します。

## 技術スタック

- **言語**: TypeScript
- **オーディオエンジン**: SuperCollider
- **アーキテクチャ**: モノレポ構成
- **パッケージ**: engine, parser, vscode-extension
- **テスト**: Jest（187/187テスト通過）

## 現在の状況（2025-01-07更新）

### ✅ 完了したフェーズ
- **Phase 11**: VS Code拡張機能のパッケージ化修正完了
- **Git Workflow**: 包括的な開発ワークフロー実装完了
- **ブランチ保護**: main/developブランチの完全保護設定完了
- **Worktree**: 本番環境分離（orbitscore-main/）設定完了
- **Cursor BugBot**: 日本語レビュー、プロジェクト固有ガイドライン設定完了

### 🎯 現在のフェーズ
- **開発環境**: 安定したGit Workflowで通常の機能開発準備完了
- **本番環境**: 保護されたmainブランチで常に安定状態を維持

### 📋 次の優先事項
- 通常の機能開発に戻る
- ライブパフォーマンスでの安定性を維持しながら新機能開発

## アーキテクチャ

### DSL設計
- **仕様書**: `docs/INSTRUCTION_ORBITSCORE_DSL.md`（v2.0）が最新
- **特徴**: 度数ベース、メソッドチェーン、`play()`メソッドのネスト構造
- **精度**: 小数第3位まで

### SuperCollider統合
- **SynthDef**: `packages/engine/supercollider/synthdefs/`に配置
- **setup.scd**: SynthDef生成スクリプト
- **オーディオデバイス**: 入力/出力/duplexの明確な分類

## 開発ワークフロー

### ブランチ構造
- **main**: 本番環境（完全保護）
- **develop**: 統合ブランチ（完全保護）
- **feature/**: 機能開発ブランチ

### 保護ルール
- PR必須、承認必須、管理者強制適用
- Cursor BugBotによる日本語レビュー
- ライブパフォーマンスの安定性を最優先

### Worktree
- **orbitscore/**: develop + feature branches（開発作業）
- **orbitscore-main/**: main branch（本番確認用）