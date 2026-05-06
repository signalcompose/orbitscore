---
title: "0-1. OrbitScore とは何か"
chapter-id: "0-1"
status: stub
---

> **Note**: 本ページは執筆中です。当面は [Glossary](/glossary) と [ADR-002 DSL v3 Pivot](/decisions/adr-002-dsl-v3-pivot) を参照してください。 完成版は yamato 自身が DSL 設計者として執筆予定 (Epic [#166](https://github.com/signalcompose/orbitscore/issues/166))。

OrbitScore の DSL 設計哲学、論文との関係、なぜ作ったか (動機・問題提起)。

## 暫定的な要点

- **位置付け**: ライブコーディングで音楽を作るための DSL。 "code を実行 → 即時に音が出る" を中核体験とする。
- **歴史**: v1 は MIDI ベースで実装、v3 で audio-based に pivot (詳細: [ADR-002](/decisions/adr-002-dsl-v3-pivot))。
- **現状**: v3.0 (SuperCollider audio engine) で ICMC 2026 に向けて製品化中。

## 次の深掘り候補

- 論文 (ICMC 2026 submission) との対応関係
- 既存ライブコーディング言語 (TidalCycles、Sonic Pi 等) との position の差
- なぜ「楕円軌道」 のメタファを選んだか — 命名の由来
