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

## ディレクトリ構成

- `index.md` — 章 1 「OrbitScore とは」 (landing 兼ねる)
- `getting-started/` — 章 2-3 (インストール、はじめての音)
- `basics/` — 章 4-8 (パターン、複数シーケンス、ポリリズム、オーディオ操作、ライブコーディング)
- `reference/` — 章 9 (メソッド早見表)
- `troubleshooting.md` — 章 10
- `STYLE_GUIDE.md` — 執筆規約 (ですます調、子供扱いしない、コードのみ)
- `.vitepress/` — VitePress 設定 (config, sidebar, theme)

## 公開について

現時点ではローカル閲覧のみ。Web 公開 (GitHub Pages 等) はコンテンツ完成後に別 issue で判断します。
