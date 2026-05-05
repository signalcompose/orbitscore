# KaTeX assets (vendored)

このディレクトリは [`katex`](https://www.npmjs.com/package/katex) パッケージの
`dist/` から copy した CSS とフォントを保持しています。

## 何のためか

dev 学習サイトを **オフライン環境 (飛行機内、移動中、隔離 CI 等)** で読めるように
するため、KaTeX CSS とフォントを **CDN 経由ではなくサイト内に同梱** しています。

`.vitepress/config.ts` の `head` で次のように local 参照しています:

```ts
{
  rel: 'stylesheet',
  href: '/katex/katex.min.css',
}
```

## 同期方針

`package.json` の `katex` バージョンを更新したときは、本ディレクトリも同期
する必要があります (CSS のクラス名や font ファイル参照が古いままだと数式
レンダリングが壊れる)。

### 手動同期手順

```bash
# repository root から実行
cp node_modules/katex/dist/katex.min.css sites/dev/public/katex/
cp -r node_modules/katex/dist/fonts sites/dev/public/katex/
```

将来 `npm-postinstall` の自動 sync 化、または build script 統合は別 issue で
検討候補。

## ライセンス

KaTeX は [MIT License](https://github.com/KaTeX/KaTeX/blob/main/LICENSE) です。
本ディレクトリへの vendor copy にあたり、license 条項に従い派生物としての
利用に問題はありません。
