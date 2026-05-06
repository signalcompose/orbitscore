# Translation Prompts

OrbitScore learning サイト 2 つを Claude Desktop / Claude on the Web に丸投げするための self-contained プロンプト集。

## 使い方

1. このディレクトリの該当ファイル (`translate-user-site.md` または `translate-dev-site.md`) を開く
2. 「プロンプト本文」 のコードブロック内 (`` ``` `` で囲まれた部分) を **そのまま全選択コピー**
3. Claude Desktop 等で on-the-web に渡す
4. on-the-web が PR を作成するのを待つ
5. PR が来たら local build / glossary 整合性 / トーン規律 を review
6. 問題なければ merge、`docs/development/TRANSLATION_STATUS.md` の進捗が `done` に更新されていることを確認

## ファイル一覧

| ファイル | 対象 | 章数 | 特記事項 |
|---|---|---|---|
| `translate-user-site.md` | `sites/user/` | 8 章（残り） | spike 章 2 つ既に完訳済 |
| `translate-dev-site.md` | `sites/dev/` | 18 章（残り） | **verbatim 規律 CRITICAL**、spike 章 1 つ既に完訳済 |

## ルーチン化への展望

両プロンプトとも将来 CronCreate routine で自動化する想定:

```
ja の章更新検出 → TRANSLATION_STATUS.md で outdated にマーク
                ↓
              該当章のプロンプトを on-the-web に dispatch
                ↓
              再翻訳 PR 作成 → review → merge
```

そのため、プロンプトは:
- Self-contained（外部 context 不要）
- 出力フォーマット明示
- Verification ステップ含む
- ジ章単位で再 dispatch 可能（将来の細粒度化に備える）

## 関連ドキュメント

- [`TRANSLATION_WORKFLOW.md`](../TRANSLATION_WORKFLOW.md) — 翻訳 workflow 全体
- [`TRANSLATION_STATUS.md`](../TRANSLATION_STATUS.md) — 章ごとの進捗
- `sites/user/.translation-glossary.md` — user サイト用語規律
- `sites/dev/.translation-glossary.md` — dev サイト用語規律 + verbatim 規律
