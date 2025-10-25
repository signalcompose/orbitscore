# Claude Code Hooks

このディレクトリには、プロジェクトのルールを自動化するClaude Code Hooksが含まれています。

## 概要

Claude Code Hooksは、特定のイベント（セッション開始、コミット前、ブランチ作成前など）で自動的に実行されるスクリプトです。これにより、CLAUDE.mdとPROJECT_RULES.mdで定義されたルールを自動的にチェックし、ルール違反を防ぎます。

## 実装されているHooks

### 1. PreEdit/PreWrite Hook (`pre-edit-check.sh`) 🔴 NEW

**実行タイミング**: Edit/Writeツール使用前

**目的**: develop/mainブランチでの直接実装を防止

**チェック内容**:
- 現在のブランチがdevelop/mainでないか確認
- develop/mainの場合は**実装をブロック**（exit 2）
- ブランチ名にIssue番号が含まれているか確認（警告のみ）

**動作**:
- develop/mainでEdit/Writeを使おうとすると**ブロック**
- Issue番号のないブランチ名の場合は警告のみ

**重要**: このフックにより、ワークフロー違反（Issue・ブランチ作成前の実装開始）を**システムとして防止**

### 2. SessionStart Hook (`session-start.sh`) ⚠️ CRITICAL

**実行タイミング**: Claude Codeセッション開始時（startup, resume, **compact**）

**目的**: **Compacting conversation後の文脈回復**（最重要）

**重要性**: Compacting conversation後は、重要な約束事（プロジェクトルール、現在のIssue状況、Git状態など）が失われます。このフックは、それらを自動的に復元するために必須です。

**実行内容**:
```bash
1. mcp__serena__check_onboarding_performed - Onboarding状態確認
2. Serenaを使って現在の状況を確認
   - list_memoriesで利用可能なメモリを確認
   - 必要に応じてread_memoryで読み込む
3. git branch --show-current && git log -1 --oneline - Git状態確認
4. ブランチ名からIssue番号を確認（例: 57-dsl-clarification → Issue #57）
```

**動作**: additionalContextとしてリマインダーを出力（Claude側で自動認識）

**トリガー**:
- `compact`: Compacting conversation後（最重要）
- `resume`: セッション再開時（`--resume`, `/resume`）
- `startup`も可能だが、現在はcompactとresumeのみ設定

**詳細**: CLAUDE.mdの「⚠️ COMPACTING CONVERSATION後の必須手順」を参照

### 2. PreCompact Hook (`pre-compact.sh`)

**実行タイミング**: コンテキスト圧縮の**直前**

**目的**: 重要な情報の保存を促す

**チェック内容**:
- Serenaメモリへの作業状況保存
- `.claude/next-session-prompt.md`への引き継ぎメモ作成
- 未コミットの変更確認
- 重要な決定事項の記録

**動作**: 警告のみ（ブロックなし）

**重要**: まだコンテキストが残っている時に実行されるため、AIエージェントは現在の作業内容を保存できます。

### 3. PostCompact Hook (`post-compact.sh`)

**実行タイミング**: コンテキスト圧縮の**直後**（同じセッション継続）

**目的**: 圧縮後のセッション継続のための復元アクション

**チェック内容**:
- CLAUDE.mdの明示的な読み込み
- Serenaプロジェクトの再アクティベート
- 必須ドキュメントの読み込み
- Serenaメモリの確認
- 作業文脈の復元（現在のブランチ、未コミット変更、直近のコミット）

**動作**: 警告のみ（ブロックなし）

**重要**: PostCompactは**SessionStartとほぼ同じ復元アクション**を実行します。これは、コンテキスト圧縮により会話履歴が失われるため、新しいセッションと同様の復元が必要だからです。

### 4. PreCommit Hook (`pre-commit-check.sh`)

**実行タイミング**: `git commit`実行前

**目的**: コミット前の必須項目をチェック

**チェック内容**:
- WORK_LOG.mdが更新されているか（git diffで確認）
- 未更新の場合は警告メッセージを表示

**動作**: 警告のみ（ブロックなし）

**理由**: PROJECT_RULESでは、すべてのコミットでWORK_LOG.mdの更新が必須

### 3. PreBranch Hook (`pre-branch-check.sh`)

**実行タイミング**: `git checkout -b`実行前

**目的**: ブランチ命名規則をリマインド

**リマインド内容**:
- ブランチ名の形式: `<issue-number>-<descriptive-name>`
- 英語のみ使用（日本語禁止）
- Issue作成 → ブランチ作成の正しい手順

**動作**: 警告のみ（ブロックなし）

## 設定ファイル

`.claude/settings.json`にHooksの設定が記載されています：

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "compact",
        "hooks": [{
          "type": "command",
          "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/session-start.sh"
        }]
      },
      {
        "matcher": "resume",
        "hooks": [{
          "type": "command",
          "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/session-start.sh"
        }]
      }
    ],
    "PreCompact": [
      {
        "hooks": [{
          "type": "command",
          "command": ".claude/hooks/pre-compact.sh"
        }]
      }
    ],
    "PostCompact": [
      {
        "hooks": [{
          "type": "command",
          "command": ".claude/hooks/post-compact.sh"
        }]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Bash:git commit.*",
        "hooks": [{
          "type": "command",
          "command": ".claude/hooks/pre-commit-check.sh"
        }]
      },
      {
        "matcher": "Bash:git checkout -b.*",
        "hooks": [{
          "type": "command",
          "command": ".claude/hooks/pre-branch-check.sh"
        }]
      }
    ]
  }
}
```

## Hookのカスタマイズ

### 警告メッセージの変更

各スクリプトの`cat << 'EOF'`セクションでJSON形式のメッセージを編集できます。

### ブロック機能の追加

現在、すべてのHooksは警告のみ（`exit 0`）です。ブロックするには：

1. スクリプトで条件チェックを追加
2. 違反時に`exit 2`を返す

例：
```bash
if [ 条件 ]; then
  cat << 'EOF'
{
  "error": "エラーメッセージ"
}
EOF
  exit 2  # ブロック
fi
```

### 新しいHookの追加

1. `.claude/hooks/`に新しいスクリプトを作成
2. 実行権限を付与：`chmod +x .claude/hooks/new-hook.sh`
3. `.claude/config.json`に設定を追加
4. テスト実行：`./.claude/hooks/new-hook.sh`

## デバッグ

Hooksの実行詳細を確認するには：

```bash
claude --debug
```

## 注意事項

- **セキュリティ**: Hooksはシェルコマンドを実行するため、信頼できるスクリプトのみを使用
- **実行権限**: すべてのスクリプトに実行権限が必要（`chmod +x`）
- **環境変数**: `CLAUDE_PROJECT_DIR`を使用してプロジェクトルートを参照
- **柔軟性**: 現在は警告のみで、緊急時はHookの警告を無視して作業可能

## 今後の拡張予定

### Phase 2（中優先度）

- **PreToolUse(gh pr create)**: PR作成前のチェック
  - `Closes #N`の有無確認
  - ブランチ名とIssue番号の整合性確認

- **PreCompact Hook**: コンテキスト圧縮前の自動保存
  - 作業状況のテキストファイル保存
  - Serenaメモリ更新の提案

### Phase 3（低優先度）

- **PostToolUse(npm test)**: テスト実行後のログ記録
  - テスト結果の自動記録
  - 失敗時の詳細ログ保存

## トラブルシューティング

### Hookが実行されない

1. スクリプトに実行権限があるか確認：`ls -la .claude/hooks/`
2. `.claude/config.json`の設定を確認
3. `claude --debug`でデバッグモードで実行

### エラーメッセージが表示されない

1. スクリプトを直接実行してテスト：`./.claude/hooks/pre-commit-check.sh`
2. JSON形式が正しいか確認
3. エスケープ文字（`\n`）が正しく使用されているか確認

## 参考リンク

- [Claude Code Hooks Documentation](https://docs.claude.com/en/docs/claude-code/hooks)
- CLAUDE.md - プロジェクトルール
- docs/PROJECT_RULES.md - 詳細なルール
