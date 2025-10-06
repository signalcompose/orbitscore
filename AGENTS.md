# Repository Guide

このリポジトリのルール・計画・仕様はすべて `docs/` 以下に集約しています。

## セッション開始時の必須アクション

**新しいセッション開始時、ユーザーからの最初の質問に答える前に、以下を必ず実行すること：**

1. **Serenaプロジェクトをアクティベート**
   - `serena-activate_project("orbitscore")`

2. **必須ドキュメントを読み込む**
   - `docs/PROJECT_RULES.md` - プロジェクトの必須ルール・コミット方針
   - `docs/CONTEXT7_GUIDE.md` - 外部ライブラリ参照ガイド

3. **Serenaメモリを確認**
   - `serena-list_memories` - 利用可能なメモリを確認
   - 関連するメモリがあれば読み込む（特に`project_overview`、`current_issues`を推奨）

**プロジェクトの現状把握が必要な場合は、Serenaを使用して以下を確認：**
- **直近の開発状況** → Serenaで`docs/WORK_LOG.md`を検索
- **現在の実装フェーズ** → Serenaで`docs/IMPLEMENTATION_PLAN.md`を検索
- **DSL仕様の詳細** → Serenaで`docs/INSTRUCTION_ORBITSCORE_DSL.md`を検索

これにより、トークン効率を保ちながら必要な情報だけを取得し、Serenaの長期記憶機能を最大限に活用します。

## 主要ドキュメント

### 必須ガイド（セッション開始時に読み込む）
- `docs/PROJECT_RULES.md` — プロジェクト運用ルール / コミット方針
- `docs/CONTEXT7_GUIDE.md` — 外部ライブラリ参照ガイド
- **Serenaメモリ** — Serenaが管理する長期記憶（`serena-list_memories`で確認）

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

Serenaメモリに詳細なガイドラインがあります。特に以下を参照：
- `serena_usage_guidelines` - Serenaの使い方
- `development_guidelines` - 開発ガイドライン
- `code_style_conventions` - コーディング規約

### クイックリファレンス

| 目的 | 使用ツール |
|------|-----------|
| 外部ライブラリのAPI | Context7 |
| プロジェクト内のコード構造 | Serena |
| プロジェクトのドキュメント | Read |
| ファイル編集 | StrReplace/MultiStrReplace |
| 文字列検索 | Grep |