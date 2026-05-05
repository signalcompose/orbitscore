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
