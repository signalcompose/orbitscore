# Serena Usage Guidelines

## When to Use Serena Tools
**Serena推奨場面**（複雑なコード解析・アーキテクチャ理解が必要）：
- コードベース全体の構造理解
- シンボル間の参照関係調査
- クラス・関数・変数の使用箇所特定
- ファイル間の依存関係分析
- 大規模リファクタリングの影響範囲調査
- 設計パターンの実装箇所探索
- バグの原因となる関連コード特定

## When to Use Regular Tools
**通常ツール推奨場面**（単純な作業）：
- 単純なファイル読み込み・編集
- 既知のファイル・関数への直接的な変更
- シンプルな文字列検索・置換

## Available Serena Tools
- `find_symbol` - シンボルの検索
- `find_referencing_symbols` - 参照の検索
- `get_symbols_overview` - ファイルの概要
- `search_for_pattern` - パターン検索
- `replace_symbol_body` - シンボルの置換
- `insert_after_symbol` - シンボル後に挿入
- `insert_before_symbol` - シンボル前に挿入
- `write_memory` - メモリファイルの作成
- `read_memory` - メモリファイルの読み込み

## Best Practices
- Use Serena tools for complex code analysis and architecture understanding
- Use regular tools for simple file operations
- Leverage Serena's symbolic analysis capabilities for efficient code exploration
- Combine Serena tools with regular tools for comprehensive development workflow