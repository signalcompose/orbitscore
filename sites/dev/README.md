# OrbitScore Dev Learning Site

OrbitScore 実装の技術面を解説するラーニングドキュメント。
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
- `scheduling/` — Part II (時間表現・polymeter・event queue・transport)
- `rust-engine/` — Part III (既定バックエンド `orbit-audio-daemon`・OOP children・insert bus・capture)
- `signal-chain/` — Part IV (ラック SC.10・ミキサー / オーディオライン)
- `plugin-hosting/` — Part V (概観・プラグイン UI・カタログと差し替え)
- `editor/` — Part VI (VS Code 拡張・インライン実行・MCP と gated E2E)
- `audio/` — Part VII (SuperCollider 経路 = `ORBITSCORE_ENGINE=sc` の opt-out・歴史的読解)
- `decisions/` — Part VIII ADR
- `glossary.md` — 用語集
- `en/` — 上記の英語ミラー (同名パス)
- `STYLE_GUIDE.md` — 執筆規約 (verbatim 規律 §5-bis 含む)
- `scripts/check-citations.mjs` — 引用の機械検証 (`npm run docs:check`、`--fix` で行ずれを再アンカー)
- `.vitepress/` — VitePress 設定 (config, sidebar, theme, mermaid-zoom)
- `public/katex/` — vendored KaTeX (offline 対応)
- `.plan/` / `.audit/` — 計画・SoT 検証レポート (build 対象外)

## 引用の検証

本文中の `// <file>:<start>-<end>` 付きコードブロックは code と文字単位で一致させる規律 (STYLE_GUIDE §5-bis)。
リポジトリルートで:

```bash
npm run docs:check                                   # 全章を検証 (red があれば exit 1)
node sites/dev/scripts/check-citations.mjs --fix     # 行ずれだけの引用を現在の行へ再アンカー
node sites/dev/scripts/check-citations.mjs sites/dev/rust-engine/index.md   # 特定ファイルのみ
```

章を書き直したら frontmatter の `verified-against` を検証時の commit に更新する。

## 公開 URL

- **公開先**: https://signalcompose.github.io/orbitscore/dev/ (ja)
- **English**: https://signalcompose.github.io/orbitscore/dev/en/
- 自動 deploy: `.github/workflows/deploy-sites.yml` (`main` の `sites/**` 変更で trigger)
- 個人学習ノートとして運用しているため、未完の章 (例: `orientation/what-is-orbitscore.md`) や
  日本語コードコメント残存 (citation 整合のため byte-identical 規律、 詳細は `.translation-glossary.md`) を含む。
- 全章は 2026-09-01 に commit `69dc968` へ再検証済 (各章 frontmatter の `verified-against` 参照)。
- 完全な仕様は code (SoT) と `docs/` の DDD ドキュメントを参照のこと。
