# Context7使用ガイドライン

## 基本方針

Context7は**外部ライブラリ・フレームワークのドキュメント参照**に使用する。
プロジェクト内のコードやドキュメントには使用しない。

## Context7推奨場面

以下の場合は**Context7を使用**：
- 外部ライブラリのAPI仕様を確認したい時
- フレームワークの使い方がわからない時
- 依存パッケージの最新ドキュメントを参照したい時
- ベストプラクティスを確認したい時

## このプロジェクトで使用する主要ライブラリ

- **TypeScript** - 言語仕様・型システム
- **Node.js** - ランタイムAPI
- **VS Code Extension API** - 拡張機能開発
- **SuperCollider** - オーディオエンジン（scsynth）
- **Web Audio API** - ブラウザオーディオ（将来的に）

## 使用手順

### 1. ライブラリIDの解決
```
context7-resolve-library-id("typescript")
context7-resolve-library-id("vscode")
```

### 2. ドキュメント取得
```
context7-get-library-docs(libraryID, topic="decorators")
```
- `topic`パラメータで特定の機能に絞り込み可能

## Context7を使わない場面

以下は**Context7を使用しない**：
- OrbitScoreプロジェクト内のコード理解 → **Serena**
- プロジェクトのドキュメント参照 → **Read**
- 一般的なプログラミング知識 → **自身の知識**

## 効率的な組み合わせパターン

### 例1: 新しいVS Code拡張機能を実装
1. Context7でVS Code APIを確認
2. Serenaで既存の拡張コードを理解
3. 実装

### 例2: TypeScriptの高度な型を使いたい
1. Context7でTypeScript型システムを確認
2. プロジェクト内の類似実装をSerenaで検索
3. 実装

### 例3: SuperColliderとの連携を改善
1. Context7でSuperCollider APIを確認
2. Serenaで現在の統合コードを分析
3. 改善実装

---

_Context7を活用することで、外部ライブラリの最新情報に基づいた正確な実装が可能になります。_