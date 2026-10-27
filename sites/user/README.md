# OrbitScore User Learning Site

OrbitScore のユーザー向け学習サイト (初心者向け 10 章のチュートリアル)。
詳細は [`docs/development/USER_LEARNING_SITE.md`](../../docs/development/USER_LEARNING_SITE.md) 参照。

## ローカルで閲覧する

`sites/user/` ディレクトリで実行:

### オフライン用 (飛行機・移動中)

```bash
npm run docs:build    # 一度ビルド
npm run docs:preview  # http://localhost:4173 で配信
```

ビルドさえ済んでいれば実行中ネットワークは不要。`dist/` を別の場所にコピーして任意の方法で閲覧することもできます。

### 編集しながら確認

```bash
npm run docs:dev      # http://localhost:5173 (HMR 付き)
```

> **Note**: `base: '/orbitscore/'` を設定しているため、 ローカル dev サーバは `http://localhost:5173/orbitscore/` で起動します (ブラウザで自動 redirect されない場合は手動アクセス)。

## ディレクトリ構成

- `index.md` — 章 1 「OrbitScore とは」 (landing 兼ねる)
- `getting-started/` — 章 2-3 (インストール、はじめての音)
- `basics/` — 章 4-8 (パターン、複数シーケンス、ポリリズム、オーディオ操作、ライブコーディング)
- `reference/` — 章 9 (メソッド早見表)
- `troubleshooting.md` — 章 10
- `STYLE_GUIDE.md` — 執筆規約 (ですます調、子供扱いしない、コードのみ、可用性表記)
- `scripts/check-availability.mjs` — 可用性表記の lint (`npm run docs:check`)
- `.translation-glossary.md` — ja → en の訳語表
- `.vitepress/` — VitePress 設定 (config, sidebar, theme)

## 可用性表記の検査

各章は frontmatter `host:`（`both` / `both+split` / `app` / `ext`）を持ち、機能ごとの可用性を
`> **対応**:`（en は `> **Availability**:`）の固定 5 形で書きます。規約は
[`STYLE_GUIDE.md`](STYLE_GUIDE.md) の「可用性表記（OrbitScore / OrbitStudio）」、
検査は `scripts/check-availability.mjs` です。リポジトリルートで:

```bash
npm run docs:check                               # dev サイトの引用検証と合わせて全章を検査
node sites/user/scripts/check-availability.mjs   # user サイトだけを検査
node sites/user/scripts/check-availability.mjs --release   # 未リリースの行を red にする（リリース前）
```

FAIL 行の末尾に規則 ID（`AV-HOST` / `AV-SYNTAX` / `AV-PLACE` / `AV-UNRELEASED` / `AV-I18N` /
`AV-HOST-SCOPE` / `AV-TERM`）が出るので、STYLE_GUIDE の同名の規則を読んで直します。
CI では `code-review.yml` の `Check doc citations and user-site availability notation` が、
手元では `.husky/pre-push` が同じ `docs:check` を走らせます。

## 公開 URL

- **公開先**: https://signalcompose.github.io/orbitscore/ (ja landing)
- **English**: https://signalcompose.github.io/orbitscore/en/
- 自動 deploy: `.github/workflows/deploy-sites.yml` (`main` の `sites/**` 変更で trigger)
- カスタムドメイン化は post-ICMC で別 issue (CNAME + `base` 切替で対応可)
