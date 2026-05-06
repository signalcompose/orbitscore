# OrbitScore Dev Learning Site

OrbitScore 実装の reading の足跡 (個人学習ノート)。
詳細は [`docs/development/DEV_LEARNING_SITE.md`](../../docs/development/DEV_LEARNING_SITE.md) 参照。

## ローカルで閲覧する

リポジトリルートで実行:

### オフライン用 (飛行機・移動中)

```bash
npm run docs:build    # 一度ビルド
npm run docs:preview  # http://localhost:4173 で配信
```

KaTeX フォント等は `public/katex/` に vendored 済。ビルドさえ済んでいれば実行中ネットワークは不要。

### 編集しながら確認

```bash
npm run docs:dev      # http://localhost:5173 (HMR 付き)
```

> **Note**: `base: '/orbitscore/dev/'` を設定しているため、 ローカル dev サーバは `http://localhost:5173/orbitscore/dev/` で起動します。

## ディレクトリ構成

- `index.md` — landing
- `orientation/` — Part 0 (全体像)
- `pipeline/` — Part I (DSL pipeline)
- `scheduling/` — Part II (時間表現と polymeter)
- `audio/` — Part III (SuperCollider 連携)
- `editor/` — Part IV (VS Code 拡張)
- `decisions/` — Part V ADR
- `glossary.md` — 用語集
- `STYLE_GUIDE.md` — 執筆規約 (verbatim 規律 §5-bis 含む)
- `.vitepress/` — VitePress 設定 (config, theme, mermaid-zoom)
- `public/katex/` — vendored KaTeX (offline 対応)
- `.audit/` — SoT 検証レポート (build 対象外)

## 公開 URL

- **公開先**: https://signalcompose.github.io/orbitscore/dev/ (ja)
- **English**: https://signalcompose.github.io/orbitscore/dev/en/
- 自動 deploy: `.github/workflows/deploy-sites.yml` (`main` の `sites/**` 変更で trigger)
- 個人学習ノートとして公開しているため、未完の章 (例: `orientation/what-is-orbitscore.md`) や
  日本語コードコメント残存 (citation 整合のため byte-identical 規律、 詳細は `.translation-glossary.md`) を含む。
- 完全な仕様は code (SoT) と `docs/` の DDD ドキュメントを参照のこと。
