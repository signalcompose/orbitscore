---
title: "0-1. What is OrbitScore"
chapter-id: "0-1"
status: stub
---

> **Note**: This page is a work in progress. For now, please refer to the [Glossary](/en/glossary) and [ADR-002 DSL v3 Pivot](/en/decisions/adr-002-dsl-v3-pivot). The full version is planned to be written by yamato as the DSL designer (Epic [#166](https://github.com/signalcompose/orbitscore/issues/166)).

The DSL design philosophy of OrbitScore, its relationship to the paper, and why it was created (motivation and problem statement).

## Provisional Summary

- **Positioning**: A DSL for making music via live coding, with "execute code → hear sound immediately" as the core experience.
- **History**: v1 was implemented as MIDI-based, then pivoted to audio-based at v3 (details: [ADR-002](/en/decisions/adr-002-dsl-v3-pivot)).
- **Current**: v3.0 (SuperCollider audio engine), being polished toward ICMC 2026.

## Next Exploration Candidates

- Correspondence with the paper (ICMC 2026 submission)
- Positional differences from existing live-coding languages (TidalCycles, Sonic Pi, etc.)
- Why the "orbit" metaphor was chosen — origin of the name
