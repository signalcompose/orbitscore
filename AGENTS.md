# Repository Guide

このリポジトリのルール・計画・仕様はすべて `docs/` 以下に集約しています。

## セッション開始時の必須アクション

**新しいセッション開始時、ユーザーからの最初の質問に答える前に、以下を必ず実行すること：**

1. `docs/PROJECT_RULES.md` を読み込む（運用ルール・コミット方針）
2. `docs/SERENA_GUIDE.md` を読み込む（Serena MCP使用ガイドライン）
3. `docs/CONTEXT7_GUIDE.md` を読み込む（Context7使用ガイドライン）
4. `docs/TOOL_SELECTION_GUIDE.md` を読み込む（ツール選択の判断基準）

**プロジェクトの現状把握が必要な場合は、Serenaを使用して以下を確認：**
- **直近の開発状況** → Serenaのメモリまたは`docs/WORK_LOG.md`を検索
- **現在の実装フェーズ** → Serenaで`docs/IMPLEMENTATION_PLAN.md`を検索
- **DSL仕様の詳細** → Serenaで`docs/INSTRUCTION_ORBITSCORE_DSL.md`を検索

これにより、トークン効率を保ちながら必要な情報だけを取得し、Serenaの長期記憶機能を活用します。

## 主要ドキュメント

### 必須ガイド（セッション開始時に読み込む）
- `docs/PROJECT_RULES.md` — プロジェクト運用ルール / コミット方針
- `docs/SERENA_GUIDE.md` — Serena MCP使用ガイドライン
- `docs/CONTEXT7_GUIDE.md` — Context7使用ガイドライン
- `docs/TOOL_SELECTION_GUIDE.md` — ツール選択の判断基準

### アクティブなドキュメント
- `docs/INDEX.md` — ドキュメントの総合ナビゲーション
- `docs/IMPLEMENTATION_PLAN.md` — 実装計画と進捗管理
- `docs/INSTRUCTION_ORBITSCORE_DSL.md` — DSL仕様（v2.0・現行版）
- `docs/WORK_LOG.md` — 開発ログ（各コミットで更新必須）

### アーカイブ（論文執筆・研究用）
- `docs/archive/DSL_SPECIFICATION_v1.0_MIDI.md` — 旧DSL仕様（MIDIベース）
- これらは開発過程の記録として保存されており、通常の開発作業では参照しない

Codex CLI / Cursor CLI など別エージェントで作業を引き継ぐ際も、これらドキュメントを共通の参照源としてください。

## ツール使用ガイド

上記の必須ガイドで、適切なツールの選択方法と使用方法を理解できます。

### クイックリファレンス

| 目的 | 使用ツール |
|------|-----------|
| 外部ライブラリのAPI | Context7 |
| プロジェクト内のコード構造 | Serena |
| プロジェクトのドキュメント | Read |
| ファイル編集 | StrReplace/MultiStrReplace |
| 文字列検索 | Grep |