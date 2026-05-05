---
title: "OrbitScore Dev — 個人学習ノート"
chapter-id: index
status: stable
---

# OrbitScore Dev — 個人学習ノート

> **Note**: 本サイトは「ドキュメント」ではなく **OrbitScore 実装に関する著者 (yamato) の reading の足跡** です。code が真実、本サイトはその時点の理解の snapshot に過ぎません。

LLM (Claude Code 等) を主要な実装担当として運用している現状、著者側に **実装レイヤーの理解が蓄積しない** という構造的欠落がある。本サイトはそれを補うため、code から explanation を生成 → 別 LLM で audit → 著者が読んで編集する loop で構築・維持される。

詳細は [`docs/development/DEV_LEARNING_SITE.md`](https://github.com/signalcompose/orbitscore/blob/main/docs/development/DEV_LEARNING_SITE.md) (project brief) 参照。

## 構成

- **Part 0. Orientation** — OrbitScore 全体像
- **Part I. DSL Pipeline** — text → AST → 評価
- **Part II. Scheduling** — 時間表現と polymeter
- **Part III. Audio Rendering** — SuperCollider との連携
- **Part IV. Editor Integration** — VS Code 拡張
- **Part V. ADR / Glossary** — 設計判断と用語集

各章 frontmatter の `status` で執筆段階が分かる:

| status | 意味 |
|---|---|
| `stub` | 骨格のみ、本文未執筆 |
| `draft` | writing agent による初稿 (advisor audit 済の場合あり、yamato 読了は未) |
| `reviewed` | advisor audit 通過 + yamato 読了 |
| `stable` | 長期 stable、再度 code 突合済 |

## 用語

DSL / scsynth / time domain 等の用語は [Glossary](/glossary) に集約。

## ローカル / オフラインで読む

飛行機・移動中などネットワーク接続がない環境で読むための手順。KaTeX フォント等は `sites/dev/public/katex/` に vendored 済なので、ビルド済みファイルだけで完結します。

### 推奨: 静的ビルド + preview (オフライン完結)

リポジトリルートで:

```bash
npm run docs:build    # sites/dev/.vitepress/dist/ に静的ファイル生成
npm run docs:preview  # http://localhost:4173 でローカル配信
```

→ 一度ビルドすれば実行中ネットワーク不要。離陸前に build しておけば機内でも全章閲覧可能。

### 開発時: HMR 付き dev server

```bash
npm run docs:dev      # http://localhost:5173、ファイル変更が即時反映
```

→ 章を編集しながら確認したいときに使う。

### 飛行機前のチェックリスト

1. `npm run docs:build` で `dist/` 生成
2. `npm run docs:preview` でブラウザを開き、Mermaid 図と KaTeX 数式が表示されることを確認
3. 一度 Wi-Fi を切ってリロードし、表示が崩れないことを確認
4. ↑ が OK なら機内で安心して読める

## ライセンス / 帰属

OrbitScore project の一部として、リポジトリの LICENSE に従う。
