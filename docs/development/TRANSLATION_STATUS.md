# Translation Status — User & Dev Learning Sites

各章の翻訳進捗 tracker。章単位で `pending` / `in-progress` / `done` の 3 状態。
ja 元が更新されたら該当章を `outdated` に切り替え、再翻訳の trigger とする。

詳細は [TRANSLATION_WORKFLOW.md](./TRANSLATION_WORKFLOW.md) を参照。

---

## sites/user/ (10 章)

| # | パス | Status | Last translated against (ja commit) | PR |
|---|---|---|---|---|
| 1 | `index.md` | done (spike) | (本 PR) | - |
| 2 | `getting-started/installation.md` | done | 8ba937fd4fad51a4a606b840fc22b5f484e7c5f0 | - |
| 3 | `getting-started/first-sound.md` | done (spike) | (本 PR) | - |
| 4 | `basics/patterns.md` | done | 8ba937fd4fad51a4a606b840fc22b5f484e7c5f0 | - |
| 5 | `basics/multiple-sequences.md` | done | 8ba937fd4fad51a4a606b840fc22b5f484e7c5f0 | - |
| 6 | `basics/polyrhythm.md` | done | 8ba937fd4fad51a4a606b840fc22b5f484e7c5f0 | - |
| 7 | `basics/audio-manipulation.md` | done | 8ba937fd4fad51a4a606b840fc22b5f484e7c5f0 | - |
| 8 | `basics/live-coding.md` | done | 8ba937fd4fad51a4a606b840fc22b5f484e7c5f0 | - |
| 9 | `reference/methods.md` | done | 8ba937fd4fad51a4a606b840fc22b5f484e7c5f0 | - |
| 10 | `troubleshooting.md` | done | 8ba937fd4fad51a4a606b840fc22b5f484e7c5f0 | - |

**残り**: 0 章

---

## sites/dev/ (19 章)

| # | パス | Status | Last translated against (ja commit) | PR |
|---|---|---|---|---|
| - | `index.md` | done | 8ba937f | - |
| 0-1 | `orientation/what-is-orbitscore.md` | done | 8ba937f | - |
| 0-2 | `orientation/architecture-overview.md` | done (spike) | (本 PR) | - |
| I-1 | `pipeline/text-to-ast.md` | done | 8ba937f | - |
| I-2 | `pipeline/evaluation.md` | done | 8ba937f | - |
| I-3 | `pipeline/selective-execution.md` | done | 8ba937f | - |
| II-1 | `scheduling/time-representation.md` | done | 8ba937f | - |
| II-2 | `scheduling/polymeter.md` | done | 8ba937f | - |
| II-3 | `scheduling/event-queue.md` | done | 8ba937f | - |
| II-4 | `scheduling/transport.md` | done | 8ba937f | - |
| III-1 | `audio/supercollider.md` | done | 8ba937f | - |
| III-2 | `audio/audio-file-playback.md` | done | 8ba937f | - |
| III-3 | `audio/scsynth-bundle.md` | done | 8ba937f | - |
| IV-1 | `editor/vscode-architecture.md` | done | 8ba937f | - |
| IV-2 | `editor/execution-feedback.md` | done | 8ba937f | - |
| ADR | `decisions/adr-001-supercollider.md` | done | 8ba937f | - |
| ADR | `decisions/adr-002-dsl-v3-pivot.md` | done | 8ba937f | - |
| ADR | `decisions/adr-003-scsynth-bundle.md` | done | 8ba937f | - |
| - | `glossary.md` | done | 8ba937f | - |

**残り**: 0 章

---

## 全体進捗

- **完了**: 29 章 (user 10 + dev 19)
- **未着手**: 0 章
- **総章数**: 29 章

---

## ステータス定義

| Status | 意味 |
|---|---|
| `pending` | en stub のみ存在、未着手 |
| `in-progress` | 翻訳作業中（PR open） |
| `done` | 翻訳完了、ja 元と整合 |
| `outdated` | ja 元が更新されたが en が追従していない（再翻訳要） |

---

## ja 元更新時の手順

1. ja 章を更新する PR を merge
2. 該当章を本ファイルで `done` → `outdated` に変更
3. (任意) `Last translated against` 列を空にする
4. 再翻訳 issue を作成 (TRANSLATION_WORKFLOW.md のテンプレ使用)
