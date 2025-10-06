# Serena MCP使用ガイドライン

## 基本方針

Serenaは**コードベースの理解**と**長期記憶の管理**に特化して使用する。
ドキュメントの単純な読み込みには通常ツール（Read）を使用。

## セッション開始時のSerena活用

**新しいセッション開始時、以下をSerenaで確認することを推奨：**

1. **既存メモリの確認**
   - `serena-list_memories` で保存されている知識を確認
   - 関連するメモリがあれば `serena-read_memory` で読み込む

2. **プロジェクト構造の把握**（初回セッションまたは大きな変更後）
   - `serena-get_symbols_overview` で主要ファイルの構造を把握

3. **最新の実装状況**（必要に応じて）
   - `docs/WORK_LOG.md`の最新エントリをSerenaで検索
   - 現在の実装フェーズを`IMPLEMENTATION_PLAN.md`から検索

## Serena推奨場面（コード解析）

以下の場合は**必ずSerenaを使用**：
- コードベース全体の構造理解
- シンボル間の参照関係調査（`find_referencing_symbols`）
- クラス・関数・変数の使用箇所特定（`find_symbol`）
- ファイル間の依存関係分析
- 大規模リファクタリングの影響範囲調査
- 設計パターンの実装箇所探索
- バグの原因となる関連コード特定
- 複雑なパターン検索（`search_for_pattern`）

## Serenaメモリ機能の活用

**`write_memory`を使うべきタイミング：**
- 複雑なアーキテクチャを理解した後（要約を保存）
- 重要な設計決定を発見した時
- 頻繁に参照する情報をまとめた時
- セッション終了前に重要な知見を記録

**メモリ命名規則：**
- `architecture_overview.md` - 全体アーキテクチャ
- `dsl_parser_design.md` - パーサー設計
- `audio_engine_implementation.md` - オーディオエンジン実装
- など、明確で検索しやすい名前を使用

## 通常ツール推奨場面

以下は**Serenaを使わない**：
- 単純なファイル読み込み（Read）
- 既知のファイル・関数への直接的な変更（StrReplace）
- シンプルな文字列検索（Grep）
- ドキュメントファイルの読み込み（Read）

## ドキュメント vs コード

| 対象 | ツール | 理由 |
|------|--------|------|
| `docs/*.md` | **Read** | ドキュメントは直接読む方が効率的 |
| `src/**/*.ts` | **Serena** | コードは構造理解が必要 |
| DSL仕様の確認 | **Read** | 仕様書は全文参照が基本 |
| DSLパーサー実装の理解 | **Serena** | 実装の構造・依存関係を把握 |

## 効率的なSerena活用パターン

### 1. 初回理解時
- `serena-get_symbols_overview` → 全体把握
- `serena-find_symbol` → 詳細調査
- `serena-write_memory` → 知見を記録

### 2. 機能追加時
- `serena-read_memory` → 過去の知見を確認
- `serena-find_referencing_symbols` → 影響範囲を特定

### 3. バグ修正時
- `serena-find_symbol` → 問題箇所を特定
- `serena-find_referencing_symbols` → 関連コードを調査

---

_このガイドラインに従うことで、Serenaの長期記憶機能を最大限に活用し、セッション間で知識を蓄積できます。_