# Translation Prompt: User Site (ja → en)

このプロンプトは Claude Desktop / Claude on the Web に **そのまま貼り付けて** 使う想定です。

将来の routine 化を見据えて self-contained に書かれています。

---

## プロンプト本文 (ここから↓を copy)

```
You are translating the OrbitScore user-facing learning site from Japanese to English.

## Repository

https://github.com/signalcompose/orbitscore

You have GitHub access. Clone the repo, work on a new branch, and open a single PR when done.

## Required Reading (read these first, in order)

1. `sites/user/.translation-glossary.md` — terminology pairs, tone rules, do-not-translate list
2. `sites/user/STYLE_GUIDE.md` — writing rules (tone, structure, link conventions)
3. `sites/user/en/index.md` — translated landing page (use as reference for tone/style)
4. `sites/user/en/getting-started/first-sound.md` — translated chapter 3 (use as reference for tone/style)
5. `docs/development/TRANSLATION_WORKFLOW.md` — high-level workflow doc

## Chapters to Translate (8 total)

For each chapter, translate the Japanese source and overwrite the English stub at the same relative path under `sites/user/en/`:

| # | Source (ja) | Target (en, overwrite) | Title |
|---|---|---|---|
| 2 | `sites/user/getting-started/installation.md` | `sites/user/en/getting-started/installation.md` | Installation |
| 4 | `sites/user/basics/patterns.md` | `sites/user/en/basics/patterns.md` | Building Patterns |
| 5 | `sites/user/basics/multiple-sequences.md` | `sites/user/en/basics/multiple-sequences.md` | Multiple Sequences |
| 6 | `sites/user/basics/polyrhythm.md` | `sites/user/en/basics/polyrhythm.md` | Polymeter and Polyrhythm |
| 7 | `sites/user/basics/audio-manipulation.md` | `sites/user/en/basics/audio-manipulation.md` | Audio Manipulation |
| 8 | `sites/user/basics/live-coding.md` | `sites/user/en/basics/live-coding.md` | Live Coding |
| 9 | `sites/user/reference/methods.md` | `sites/user/en/reference/methods.md` | Reference |
| 10 | `sites/user/troubleshooting.md` | `sites/user/en/troubleshooting.md` | Troubleshooting |

The stub files currently contain only a "Translation in progress" warning. Overwrite them entirely with full translations.

Chapters 1 and 3 (`index.md` and `getting-started/first-sound.md`) are ALREADY translated as spike examples — use them as your tone/style reference, do NOT modify them.

## Critical Rules

### Do NOT translate (keep byte-identical)

- DSL/code block contents (e.g., `var global = init GLOBAL`)
- File paths (`kick.wav`, `./audio`, `examples/01_getting_started.orbs`)
- Method/function names (`audio()`, `play()`, `chop()`, etc.)
- Keyboard shortcuts (`Cmd+Enter`, `Cmd+Shift+P`)
- VS Code UI quotations (`🎵 OrbitScore: Ready`, `Extensions: Install from VSIX...`)
- Numbers and version strings

### DO translate

- Body prose
- Headings (`#`, `##`, `###`)
- Frontmatter `title` and `description` (preserve other fields if any)
- Inline link text (e.g., `[インストール](./installation.md)` → `[Installation](./installation.md)`)
- Comments inside code blocks if they are in Japanese (translate the comment, keep the code)

### Tone

Polite, friendly, kind — but **NOT condescending or childish**.

| NG | OK |
|---|---|
| "Let's give it a try!" | "Try the following." or "You can try it." |
| "You did it! Awesome!" | "This is the result." or "You have completed this step." |
| "Watch out!" | "Please note that..." |
| Excessive `🎉🚀✨` emojis | Use UI/code emojis (`🎵`, `✅`) only when they are in the source as UI quotations |

Use polite English equivalent of the ja ですます tone. Read the spike chapters (`en/index.md`, `en/getting-started/first-sound.md`) and match their register.

### Cross-chapter links

Keep relative paths. Both ja and en versions live at the same depth so paths translate 1:1:

- ja: `[インストール](./installation.md)` → en: `[Installation](./installation.md)`
- ja: `[パターンを作る](../basics/patterns.md)` → en: `[Building Patterns](../basics/patterns.md)`

### Glossary terminology

Follow `sites/user/.translation-glossary.md` §1 strictly. Examples:

- ライブコーディング → live coding
- シーケンス → sequence
- パターン → pattern
- ポリメーター → polymeter
- ポリリズム → polyrhythm
- 拍子 → time signature
- 拍 → beat
- 拡張機能 → extension
- 同梱 → bundled
- バスドラム / キック → kick (not "kick drum")

If a term is not in the glossary, infer from context and note it in the PR description.

## Workflow

1. Create a branch: `en-translation-user-site`
2. Translate all 8 chapters by overwriting the stub files at `sites/user/en/<path>.md`
3. Run locally to verify:
   ```bash
   npm install
   npm run -w @orbitscore/user-site docs:build
   ```
   Build must pass with no dead links.
4. Update `docs/development/TRANSLATION_STATUS.md`:
   - For each of the 8 user chapters in the table, change `Status` from `pending` to `done`
   - Set `Last translated against (ja commit)` to the current `main` HEAD commit hash
   - Update the `残り: 8 章` summary line to reflect the new count (`残り: 0 章` if all done)
5. Commit with title: `docs(en): translate user site chapters (8)`
6. Open a PR against `main` with title: `Translate user site to English (8 chapters)`

## PR Description Template

```
## Summary

8 章の英訳を完了。spike 章 (index.md, first-sound.md) と同じトーン・glossary に従って翻訳。

## Translated chapters

- [ ] getting-started/installation.md (Installation)
- [ ] basics/patterns.md (Building Patterns)
- [ ] basics/multiple-sequences.md (Multiple Sequences)
- [ ] basics/polyrhythm.md (Polymeter and Polyrhythm)
- [ ] basics/audio-manipulation.md (Audio Manipulation)
- [ ] basics/live-coding.md (Live Coding)
- [ ] reference/methods.md (Reference)
- [ ] troubleshooting.md (Troubleshooting)

(Replace [ ] with [x] for completed chapters)

## Source ja commit

Translated against `main` at <commit-sha-here>.

## Verification

- [ ] `npm run -w @orbitscore/user-site docs:build` passes locally
- [ ] No dead links
- [ ] Glossary §1 terms used consistently
- [ ] Tone matches spike chapters (no condescending/childish phrasing)

## Glossary terms not found in glossary

(List any terms you had to infer, or write "None")
```

## Verification Checklist (before opening PR)

- [ ] All 8 stub files overwritten with full translations
- [ ] `docs:build` passes with no dead links
- [ ] Frontmatter `title` and `description` translated for all 8 files
- [ ] Cross-chapter links use relative paths (`./other.md`, `../section/other.md`)
- [ ] Code blocks unchanged (DSL, file paths, method names preserved)
- [ ] Glossary §1 terminology applied consistently
- [ ] No "Let's...", "You did it!", or other condescending phrasing
- [ ] `TRANSLATION_STATUS.md` updated with `done` and commit hash

## Notes

- This is a single-PR-for-all-chapters approach (not one PR per chapter), per project preference.
- The output should read like a polite English tutorial written for absolute beginners — clear, kind, and respectful, but not childish.
- If you encounter a term that should be added to the glossary, mention it in the PR description so the glossary can be updated separately.
```

---

## Routine 化への展望

このプロンプトは将来 CronCreate routine で自動化する想定:

1. ja の章が更新された commit を検出
2. `TRANSLATION_STATUS.md` の該当章を `done` → `outdated` に変更
3. このプロンプトを on-the-web に投げて再翻訳 PR を作成
4. PR review → merge
