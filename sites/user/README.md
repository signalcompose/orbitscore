# OrbitScore User Learning Site

OrbitScore のユーザー向け学習サイト。VitePress で構築。

## ローカル起動

```bash
npm install
npm run -w sites/user docs:dev
```

ブラウザで `http://localhost:5173/` （またはターミナルに表示される URL）を開きます。

## 静的サイト build

```bash
npm run -w sites/user docs:build
```

成果物は `sites/user/.vitepress/dist/` に出力されます。

## オフライン閲覧

build した `dist/` を別のディレクトリにコピーすれば、ネット接続なしで閲覧できます（飛行機内などで）:

```bash
npm run -w sites/user docs:build
cp -r sites/user/.vitepress/dist ~/orbitscore-user-docs
# あとは ~/orbitscore-user-docs を任意の方法で閲覧
```

VitePress の `docs:preview` を使う場合:

```bash
npm run -w sites/user docs:preview
```

## ディレクトリ構成

```
sites/user/
├── package.json
├── .vitepress/
│   ├── config.ts          # サイト全体の設定
│   ├── sidebar.ts         # サイドバー構成
│   └── theme/
├── index.md               # 章 1（landing 兼ねる）
├── STYLE_GUIDE.md         # 執筆規律（srcExclude 対象）
├── README.md              # 本ファイル（srcExclude 対象）
├── getting-started/       # 章 2-3
├── basics/                # 章 4-8
├── reference/             # 章 9
└── troubleshooting.md     # 章 10
```

## 関連ドキュメント

- [USER_LEARNING_SITE.md](../../docs/development/USER_LEARNING_SITE.md) — プロジェクトブリーフ
- [STYLE_GUIDE.md](./STYLE_GUIDE.md) — 執筆規律
- [USER_MANUAL.md](../../docs/user/ja/USER_MANUAL.md) — primary source（仕様書）

## 公開について

現時点ではローカル閲覧のみ。Web 公開（GitHub Pages 等）はコンテンツ完成後に別 issue で判断します。
