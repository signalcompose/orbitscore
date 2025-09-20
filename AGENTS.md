# Repository Guidelines

## Project Structure & Module Organization

Core TypeScript sources live in `packages/engine/src/` (parser/, scheduler.ts, midi.ts); avoid default exports and keep helpers colocated. The VS Code extension sits in `packages/vscode-extension/src/` with grammars under `syntaxes/`. Canonical docs are in `docs/`—review `PROJECT_RULES.md`, `IMPLEMENTATION_PLAN.md`, and `INSTRUCTIONS_NEW_DSL.md` before new work, and track outcomes in `WORK_LOG.md`. Executable examples sit in `examples/`, while tests belong in `tests/<module>/<feature>.spec.ts` alongside fixtures like `tests/golden-ir.json`.

## Build, Test, and Development Commands

Run `npm install` once to hydrate workspaces. `npm run build` compiles engine and extension; `npm run dev:engine` executes the engine via `ts-node`. `npm test` runs Vitest (append `-- --watch` for iteration). Enforce linting with `npm run lint` or `npm run lint:fix`, and format with `npm run format` pre-review.

## Coding Style & Naming Conventions

Prettier (2-space indent) and ESLint define layout; `lint-staged` enforces them on staged `.ts/.tsx`. Use camelCase for variables/functions, PascalCase for types/classes, and kebab-case filenames. Maintain explicit named exports, strong typings, and encode the DSL chromatic degrees (0 = rest, 1–12 = chromatic scale) rather than magic numbers.

## Documentation & Workflow Expectations

Follow the documentation-first cadence: update `docs/WORK_LOG.md` **before** committing, mirror status in `README.md`, and refresh other specs when behavior shifts. Each phase’s Definition of Done is listed in `docs/IMPLEMENTATION_PLAN.md`; confirm it before progressing. Record technical decisions, tests, and next steps so history remains auditable. EVERY commit must be recorded in `docs/WORK_LOG.md` and the README kept in sync.

## Testing Guidelines

Work test-first where practical. Place new specs in the matching domain folder under `tests/`, naming them `<feature>.spec.ts`. Handle golden IR changes deliberately and document them in the work log. Run `npm test` (or watch mode) before commits, covering new DSL constructs described in `docs/INSTRUCTIONS_NEW_DSL.md`.

## Commit & Pull Request Guidelines

Messages follow `<type>: <summary>` (types: feat, fix, docs, test, refactor, chore) with a body describing what, why, and impact. Keep commits small and focused, include documentation/tests, and record hashes in `WORK_LOG.md`.

Commit body template:

```
<detailed explanation>

what changed
why it changed
impact
```

Pre‑commit checklist:
- Tests pass (`npm test`)
- WORK_LOG.md updated (then sync README.md)
- Related docs updated
- Commit message is descriptive
- No stray `console.log` in production code
- Types are explicit and correct

Pull requests must explain intent, link issues, and show validation—screenshots or GIFs for extension UX, console output for engine flows. Verify `npm run build`, `npm test`, and `npm run lint` locally before requesting review.

## Domain & Configuration Notes

The engine reads `.env` via `dotenv`; never commit secrets. MIDI workflows assume macOS CoreMIDI with the IAC Bus enabled—document external setup changes in PRs. Maintain timing precision to three decimal places and seed randomness consistently, per the DSL specification.

MIDI/DSL specifics:
- Degree system: 0 = rest; 1–12 = chromatic degrees (C..B)
- Note range: 0–127; PitchBend: −8192..+8191
- Prefer channels 1–15 for MPE rotation
- Avoid magic numbers; use named constants reflecting DSL semantics

## Language & Encoding

- あなたの返答はUTF-8の日本語で返す。
- ユーザーが英語で指示をしてきた場合は、正しい英文で返答し、英作文の能力向上を支援し、あわせてユーザーの意図を確認する。
  - 誤りがある場合は丁寧に訂正案を提示（簡潔な理由付き）
  - 「理解した意図」を短く再確認し、必要なら選択肢を提示
