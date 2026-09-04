# Claude Code Hooks

このディレクトリには、プロジェクトのルールを自動化するClaude Code Hooksが含まれています。

## 概要

Claude Code Hooksは、特定のイベント（セッション開始、コミット前、ブランチ作成前など）で自動的に実行されるスクリプトです。これにより、CLAUDE.mdとPROJECT_RULES.mdで定義されたルールを自動的にチェックし、ルール違反を防ぎます。

## 実装されているHooks

### 1. PreEdit/PreWrite Hook (`pre-edit-check.sh`) 🔴 NEW

**実行タイミング**: Edit/Writeツール使用前

**目的**: mainブランチでの直接実装を防止

**チェック内容**:
- 現在のブランチがmainでないか確認
- mainの場合は**実装をブロック**（exit 2）
- ブランチ名にIssue番号が含まれているか確認（警告のみ）

**動作**:
- mainでEdit/Writeを使おうとすると**ブロック**
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

### 6. PreMerge Review Gate (`pre-merge-review-gate.sh`) 🔴 NEW（#745）

**発火**: `PreToolUse` / matcher `Bash:gh pr merge.*`

**やること**: `gh pr merge <n>` の前に

1. PR 番号を取る
2. `gh pr view --json files` で **docs のみか code を含むか**を判定
3. code を含むなら、PR に **`review-gate: passed`** のコメントがあるか確認
4. 無ければ **ブロック**（`exit 2`）してゲート 5 段階のチェックリストを出す

🔴 **これは weak-form にしない。ブロックする。**
push の検証（#742）は「済んだことを見えるようにする」ので警告で足りたが、
**マージは戻せない**うえ、**無審査のコードが main に入る**実害が既に出ている。

**なぜ要るか**（2026-09-04 に実際にやった）: main 直行 PR のゲート 3
（`/simplify` → `/code:pr-review-team` + Fable）と 4（実機 E2E）を頭から落とし、
**code PR を 2 本 main に入れた**。#737 は `sequence.ts` / `event-scheduler.ts` を
触る変更で、レビューを一切通していない。
🔴 **同じ指摘を同じセッションの冒頭でも受けており、口頭の注意では再発した。**

**マーカーの限界**: hook は「フローが本当に走ったか」までは検証できない。
だが**黙って飛ばせなくなる**ことに意味がある（マーカーを貼る = 意図的な宣言になる）。

**通す手順**:

```bash
gh pr comment <n> --body 'review-gate: passed — simplify / pr-review-team / Fable / 実機 E2E'
```

**検証済み**（背景セキュリティレビューの指摘 3 件を直した後・全 7 パターン）:

| コマンド / 状況 | 結果 |
|---|---|
| `gh pr merge 744 --merge --admin`（code） | **ブロック**・`exit 2` |
| `gh pr merge --admin --merge 744`（**フラグが先**） | **ブロック**・`exit 2` |
| `cd /tmp && gh pr merge 744 --merge`（**前置あり**） | **ブロック**・`exit 2` |
| `gh pr merge --squash 744` | **ブロック**・`exit 2` |
| `gh pr merge 740 --merge`（docs のみ） | 通す・`exit 0` |
| `gh pr merge --admin 740`（docs のみ） | 通す・`exit 0` |
| 存在しない PR（**判定不能**） | **ブロック**・`exit 2` |
| code を含む PR・マーカー有り | 通す・`exit 0` |

🔴 **背景セキュリティレビューが初版の穴を 3 件指摘した**（いずれも実証して直した）:

| 指摘 | 初版の問題 | 直し方 |
|---|---|---|
| parser differential | `gh pr merge --admin 744` は「`merge` の直後の数字」を見る正規表現に当たらず**素通り**（実証: exit 0） | `merge` 以降のトークンを走査し**最初の裸の整数**を拾う |
| fail-open | `gh pr view` が失敗すると `exit 0` = **マージ許可** | **fail-closed**。判定できなければブロックする（判定を壊せば必ず通るゲートは機能しない） |
| matcher bypass | `Bash:gh pr merge.*` は**先頭一致**なので `cd x && gh pr merge …` に当たらない | matcher を `Bash:.*gh pr merge.*` に |

番号省略（`gh pr merge` のみ）は `gh pr view --json number` で**ブランチから引く**。
それでも取れなければブロックする。

---

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
3. `.claude/settings.json`に設定を追加
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
2. `.claude/settings.json`の設定を確認
3. `claude --debug`でデバッグモードで実行

### エラーメッセージが表示されない

1. スクリプトを直接実行してテスト：`./.claude/hooks/pre-commit-check.sh`
2. JSON形式が正しいか確認
3. エスケープ文字（`\n`）が正しく使用されているか確認

## 参考リンク

- [Claude Code Hooks Documentation](https://docs.claude.com/en/docs/claude-code/hooks)
- CLAUDE.md - プロジェクトルール
- docs/PROJECT_RULES.md - 詳細なルール
