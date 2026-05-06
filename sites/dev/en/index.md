---
title: "OrbitScore Dev — Personal Learning Notes"
chapter-id: index
status: stable
---

# OrbitScore Dev — Personal Learning Notes

> **Note**: This site is not "documentation" but rather **a trace of the author's (yamato) reading of the OrbitScore implementation**. The code is the truth; this site is merely a snapshot of understanding at that point in time.

Given that we currently use an LLM (Claude Code, etc.) as the primary implementer, there is a structural deficit on the author's side: **understanding of the implementation layer does not accumulate**. This site exists to compensate for that, built and maintained through a loop of generating explanations from the code → auditing with another LLM → the author reading and editing.

For details, see [`docs/development/DEV_LEARNING_SITE.md`](https://github.com/signalcompose/orbitscore/blob/main/docs/development/DEV_LEARNING_SITE.md) (project brief).

## Structure

- **Part 0. Orientation** — the OrbitScore big picture
- **Part I. DSL Pipeline** — text → AST → evaluation
- **Part II. Scheduling** — time representation and polymeter
- **Part III. Audio Rendering** — integration with SuperCollider
- **Part IV. Editor Integration** — VS Code extension
- **Part V. ADR / Glossary** — design decisions and glossary

The `status` in each chapter's frontmatter indicates the writing stage:

| status | meaning |
|---|---|
| `stub` | skeleton only, body not yet written |
| `draft` | initial draft by writing agent (may be advisor-audited, not yet read by yamato) |
| `reviewed` | passed advisor audit + yamato has read it |
| `stable` | long-term stable, re-verified against code |

## Glossary

DSL / scsynth / time domain terms are consolidated in the [Glossary](/en/glossary).

## Reading Locally / Offline

How to read this in environments without network connectivity, such as on a plane or while traveling. KaTeX fonts and other assets are vendored under `sites/dev/public/katex/`, so everything works with the built files alone.

### Recommended: Static Build + Preview (Fully Offline)

From the repository root:

```bash
npm run docs:build    # generates static files in sites/dev/.vitepress/dist/
npm run docs:preview  # serves locally at http://localhost:4173
```

→ Once built, no network is required during execution. If you build before takeoff, all chapters can be read on the plane.

### Development: Dev Server with HMR

```bash
npm run docs:dev      # http://localhost:5173, file changes reflected instantly
```

→ Use this when you want to check chapters as you edit them.

### Pre-flight Checklist

1. Run `npm run docs:build` to generate `dist/`
2. Open `npm run docs:preview` in a browser and confirm Mermaid diagrams and KaTeX equations render correctly
3. Disconnect Wi-Fi once and reload to confirm the rendering doesn't break
4. If the above is OK, you can read it on the plane with peace of mind

## License / Attribution

As part of the OrbitScore project, this follows the LICENSE in the repository.
