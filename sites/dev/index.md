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
| `draft` | writing agent による初稿、未 audit |
| `reviewed` | advisor audit 通過、yamato 読了 |
| `stable` | 長期 stable、再度 verify 済 |

## 用語

DSL / scsynth / time domain 等の用語は [Glossary](/glossary) に集約。

## ライセンス / 帰属

OrbitScore project の一部として、リポジトリの LICENSE に従う。
