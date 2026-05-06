# Translation Workflow — User & Dev Learning Sites

OrbitScore の learning サイト 2 つ (`sites/user/`, `sites/dev/`) を日本語から英語に翻訳するための workflow。

主に **Claude on the Web** や **CronCreate routine** に翻訳を委ねる前提で設計。Claude Code (本リポジトリで作業する claude) は事前準備と spike 章の確立を行い、bulk 翻訳は外部 agent に委ねる。

---

## 1. 全体像

```
事前準備 (本 PR 完了済):
  ├── glossary 整備
  │     ├── sites/user/.translation-glossary.md
  │     └── sites/dev/.translation-glossary.md
  ├── i18n config 整備
  │     ├── sites/user/.vitepress/config.ts (locales: ja root + en)
  │     ├── sites/user/.vitepress/sidebar.ts (sidebarJa + sidebarEn)
  │     ├── sites/dev/.vitepress/config.ts
  │     └── sites/dev/.vitepress/sidebar.ts
  ├── en/ stub 作成 (全章プレースホルダ)
  ├── spike 章翻訳
  │     ├── sites/user/en/getting-started/first-sound.md
  │     ├── sites/user/en/index.md
  │     └── sites/dev/en/orientation/architecture-overview.md
  └── 進捗 tracking
        └── docs/development/TRANSLATION_STATUS.md

Bulk 翻訳 (本 PR の範囲外、別 issue で実行):
  ├── 章単位 issue を切る (user 残り 9 章 + dev 残り 18 章)
  ├── Claude on the Web / CronCreate routine が拾って翻訳 PR 作成
  ├── preview deploy (Vercel 等) で目視確認
  └── merge後、TRANSLATION_STATUS.md を `done` に更新
```

---

## 2. 事前準備の成果物

本 PR で確立した:

### sites/user/
- `.translation-glossary.md` — 用語ペア、トーン、do-not-translate
- `.vitepress/config.ts` — `locales: { root, en }` 構造
- `.vitepress/sidebar.ts` — `sidebarJa` / `sidebarEn` を別 export
- `en/` 配下に全 10 章の stub（warning 表示）
- `en/index.md` および `en/getting-started/first-sound.md` を完全翻訳済（spike）

### sites/dev/
- `.translation-glossary.md` — verbatim 規律（§4）が CRITICAL
- `.vitepress/config.ts` — 同上
- `.vitepress/sidebar.ts` — 同上
- `en/` 配下に全 19 章 (Part 0-V) の stub
- `en/orientation/architecture-overview.md` を完全翻訳済（spike）

---

## 3. Bulk 翻訳の Issue テンプレート

各章ごとに以下の issue を作成する:

```markdown
**Title**: [en-translation] sites/<site>/<path>

**Body**:

## 翻訳対象

- ja 元ファイル: `sites/<site>/<path>.md`
- en 出力先: `sites/<site>/en/<path>.md` (現在 stub)

## 必読

1. `sites/<site>/.translation-glossary.md` — 用語ペア、トーン、do-not-translate 規律
2. `sites/<site>/STYLE_GUIDE.md` — 執筆規律
3. spike 翻訳例:
   - user: `sites/user/en/getting-started/first-sound.md`
   - dev: `sites/dev/en/orientation/architecture-overview.md`
4. ja 元ファイル本体

## 守るべき不変条件

### 共通
- frontmatter の `title` / `description` は英訳、その他は ja 版に合わせる
- 章相互 link は **相対 path 維持** (`./other.md` のままでよい、i18n 配下では同じ depth に置かれる)
- DSL コードブロック本体は byte 単位で同一
- ファイル名・パス・URL・キーボードショートカットは翻訳しない
- glossary §1 の用語ペアに従って整合性を保つ

### sites/dev 固有 (CRITICAL)
- コードブロックの `// <file>:<start>-<end>` line range は変えない
- `// ...` 省略マーカーは変えない
- 文字単位 verbatim 規律 (STYLE_GUIDE §5-bis) を保つ
- KaTeX 数式 (`$...$`、`$$...$$`) は完全同一
- Mermaid ノード文字列が日本語なら英訳、英語ならそのまま

## 完了条件

- [ ] `sites/<site>/en/<path>.md` を完全に書き換え (stub 削除)
- [ ] `npm run -w @orbitscore/<site>-site docs:build` がローカルで通る
- [ ] 章相互 link で en 版に正しくジャンプできる
- [ ] glossary §1 の用語逸脱なし
- [ ] (dev のみ) verbatim 規律 (§4) を守っている
- [ ] PR description に翻訳元 ja の commit hash を記載

## PR title 例

`docs(en): translate sites/user/getting-started/first-sound`

## TRANSLATION_STATUS.md 更新

merge 時に該当章を `pending` → `done` に変更する。
```

---

## 4. 翻訳作業の進め方 (on-the-web 向け簡易ガイド)

### Step 1: 文脈を読む

- glossary §1 の用語ペアを暗記レベルで把握
- spike 翻訳例を読んで「トーン」と「構造」を体感
- ja 元ファイルを通読

### Step 2: 翻訳

- 章本文の説明文・見出し・frontmatter を英訳
- **コードブロック本体は触らない** (コメントの和文は英訳)
- Sources セクションのリンクタイトルは英訳、path は同一
- Disclaimer は glossary §2 の例文を使用 (dev のみ)

### Step 3: ローカルビルド確認

```bash
cd sites/<site>
npm run docs:build
npm run docs:preview  # http://localhost:4173/en/<path>
```

dead link / build エラーが無いことを確認。

### Step 4: PR 作成

- title: `docs(en): translate sites/<site>/<path>`
- body: 翻訳元 commit hash、テスト確認済の旨、glossary 逸脱箇所があれば明示

### Step 5: マージ後

`docs/development/TRANSLATION_STATUS.md` の該当章を `done` に更新する PR を別途 (もしくは同 PR で同時更新)。

---

## 5. ローカル実行例 (動作確認時)

### Build

```bash
# user site
npm run -w @orbitscore/user-site docs:build

# dev site
npm run -w @orbitscore/dev-site docs:build
```

### Dev server

```bash
# user site
npm run -w @orbitscore/user-site docs:dev    # http://localhost:5173/

# dev site
npm run -w @orbitscore/dev-site docs:dev
```

### Preview (ビルド成果物)

```bash
npm run -w @orbitscore/user-site docs:preview   # http://localhost:4173/
npm run -w @orbitscore/dev-site docs:preview
```

`/en/<path>` 形式で英語ページにアクセスできる。Navbar 右上に言語スイッチャーが自動生成されている。

---

## 6. 既知の制約

- **検索**: VitePress の `search: { provider: 'local' }` はロケール横断検索になる (ja と en 結果が混在)。困ったらロケール別 index 設定を検討
- **ja 更新時の en 追従**: ja 章を更新したら en 章を「再翻訳要」 として TRANSLATION_STATUS.md でフラグ立てる必要あり (自動化は後で検討)
- **frontmatter の `verified-against`**: dev サイトは ja 翻訳元の commit を記録するため、en では翻訳完了時の ja commit-sha を記録すると整合性が保てる

---

## 7. 関連ドキュメント

- [`sites/user/.translation-glossary.md`](../../sites/user/.translation-glossary.md)
- [`sites/dev/.translation-glossary.md`](../../sites/dev/.translation-glossary.md)
- [`sites/user/STYLE_GUIDE.md`](../../sites/user/STYLE_GUIDE.md)
- [`sites/dev/STYLE_GUIDE.md`](../../sites/dev/STYLE_GUIDE.md)
- [`docs/development/USER_LEARNING_SITE.md`](./USER_LEARNING_SITE.md)
- [`docs/development/DEV_LEARNING_SITE.md`](./DEV_LEARNING_SITE.md)
- [`docs/development/TRANSLATION_STATUS.md`](./TRANSLATION_STATUS.md) — 進捗 tracker
