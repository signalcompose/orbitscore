# Repository Guide

このリポジトリのルール・計画・仕様はすべて `docs/` 以下に集約しています。

## 🚨 CRITICAL: セッション開始・再開時の必須アクション

**コンテキストがsummarizeされた後の新セッション、または新規セッション開始時には、AIエージェントは必ず以下を実行すること:**

### 1. このファイル（CLAUDE.md）を明示的に読み込む
- system-reminderとして提示されるだけでなく、Readツールで明示的に読み込むこと
- これにより、最新のルールと手順を確実に把握できます

### 2. 下記の「セッション開始時の必須アクション」セクションを実行する
- Serenaプロジェクトのアクティベート
- 必須ドキュメントの読み込み
- Serenaメモリの確認

**これにより、summarize後でもプロジェクトの記憶を完全に復元できます。**

---

## 🔴 CRITICAL RULES - 絶対に守るべきルール

**これらのルールは例外なく適用されます。違反は重大な問題を引き起こします。**

### 1. Git Workflow - Issue → Branch → PR の順序を必ず守る

**正しい順序（MUST FOLLOW）:**
```
Issue作成（番号取得）→ ブランチ作成（Issue番号含む）→ 実装 → PR作成 → Merge
```

**具体例:**
1. `gh issue create --title "[Feature] Add new feature"` → Issue #39作成
2. `git checkout -b 39-add-new-feature` → ブランチ名にIssue番号を含める
3. 実装・コミット
4. `gh pr create --body "Closes #39"` → PRにIssue番号を含める
5. マージ時にIssueが自動クローズ

**❌ 絶対にやってはいけないこと:**
- Issueを作成する前にブランチを作成する
- ブランチ名にIssue番号を含めない
- PR本文に`Closes #N`を含めない

**理由:** Issue-Branch-PRの紐付けにより、変更の追跡が可能になり、自動クローズにより作業漏れを防ぐ

### 2. ブランチ命名規則

**形式:** `<issue-number>-<descriptive-name>`

**例:**
- ✅ Good: `39-reserved-keywords-implementation`
- ✅ Good: `42-fix-audio-timing-bug`
- ❌ Bad: `feature/reserved-keywords-implementation` (Issue番号なし)
- ❌ Bad: `reserved-keywords` (Issue番号なし)
- ❌ Bad: `39-予約語実装` (日本語使用)

**重要:** ブランチ名は必ず英語のみ。日本語を使用すると一部のツールで問題が発生します。

### 3. セッション開始時の必須ドキュメント確認

**AIエージェントは必ずこのファイル（AGENTS.md）を最初に読むこと。**

その後、以下のドキュメントを確認：
1. `docs/PROJECT_RULES.md` - Git Workflow、コミットルール、テスト方針
2. `docs/CONTEXT7_GUIDE.md` - 外部ライブラリ参照ガイド
3. Serenaメモリ（`project_overview`, `current_issues`等）

**理由:** これらのドキュメントを読まずに作業を開始すると、ルール違反や不適切な実装が発生します。

---

## セッション開始時の必須アクション

**AIエージェントは、ユーザーからの最初のメッセージを受け取ったら、タスクに取り掛かる前に必ず以下を実行すること：**

1. **Serenaプロジェクトをアクティベート**
   - `serena-activate_project("orbitscore")`

2. **必須ドキュメントを読み込む**
   - `docs/PROJECT_RULES.md` - プロジェクトの必須ルール・コミット方針
   - `docs/CONTEXT7_GUIDE.md` - 外部ライブラリ参照ガイド

3. **Serenaメモリを確認**
   - `serena-list_memories` - 利用可能なメモリを確認
   - 関連するメモリがあれば読み込む（特に`project_overview`、`current_issues`を推奨）

**重要:** これらの準備アクションは自動実行されません。AIエージェントが最初のメッセージを受け取った時点で、明示的に実行する必要があります。ユーザーが「準備できてる？」と聞いた場合は、準備を実行してから完了を報告してください。

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