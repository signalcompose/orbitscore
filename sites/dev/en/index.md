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

- **Part 0. Orientation** — the OrbitScore big picture (four tiers: extension / engine / Rust daemon / plugin children)
- **Part I. DSL Pipeline** — text → AST → evaluation
- **Part II. Scheduling** — time representation and polymeter, event queue, transport
- **Part III. Rust Engine** — the default backend `orbit-audio-daemon` (since cutover #108), OOP children, insert buses, the capture seam
- **Part IV. Signal Chain / Mixer** — racks (SC.10), sum / aux / send / output, master gain
- **Part V. Plugin Hosting** — CLAP / VST3 hosting, plugin UI, the catalog and replacement
- **Part VI. Editor Integration** — the VS Code extension, inline execution, the MCP server and gated real-device E2E
- **Part VII. SuperCollider Path** — historical reading of the former default path, still reachable with `ORBITSCORE_ENGINE=sc`
- **Part VIII. ADR / Glossary** — design decisions and glossary

Every chapter was re-verified against commit `69dc968` on 2026-09-01. The SuperCollider chapters are
kept rather than deleted; a warning at the top of each states that it is the opt-out path (this site
documents drift instead of erasing it — its "artifact framing").

### Mechanical citation checking

Every code block that starts with `// <file>:<start>-<end>` is compared character for character
against the code by `sites/dev/scripts/check-citations.mjs` (`npm run docs:check`). Any drift turns
red, so a chapter's trustworthiness can be judged from its `verified-against` frontmatter and from
whether this check is green.

The `status` in each chapter's frontmatter indicates the writing stage:

| status | meaning |
|---|---|
| `stub` | skeleton only, body not yet written |
| `draft` | initial draft by writing agent (may be advisor-audited, not yet read by yamato) |
| `reviewed` | passed advisor audit + yamato has read it |
| `stable` | long-term stable, re-verified against code |

## Glossary

DSL / daemon / plugin hosting / time domain terms are consolidated in the [Glossary](/en/glossary).

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
