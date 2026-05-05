# Phase 2: Research Discipline

Before writing, bind each planned section to primary sources. This file codifies the rules for *what counts* and *how to capture* bindings.

## Source hierarchy (strict priority)

When multiple sources describe the same thing, prefer in this order:

1. **Authoritative specification or standard** — W3C/WHATWG/ECMA/RFC/IEC/AES/ITU/ISO documents; official SDK headers; language specs; reference implementations as the published canon.
2. **First-party official documentation** — the vendor's / project's own docs hosted on their domain, ideally with a version or commit anchor.
3. **Primary source code** — when docs are absent or ambiguous, the implementation is authoritative (with an explicit commit pin).
4. **Established standard textbook** — for domain fundamentals where there's no online spec (e.g., DSP foundations, electromagnetics).
5. **Peer-reviewed papers** — for claims about performance, algorithms, or subjective perception.

Secondary and **should not** ground factual claims on their own:

- Blog posts, Medium articles, YouTube videos, Stack Overflow answers
- Community wikis, community docs
- Wikipedia — usable as an index/navigation aid to find primary sources, not as the citation itself
- LLM-generated content anywhere

If a secondary source is the only available artifact, that's a signal the claim is **weak** and should either be dropped, flagged with an unverified marker, or elevated by finding the primary source.

## Per-domain source pointers

Claude has training-data knowledge of most of these, but **do not rely on memory** — the point of the discipline is verification.

| Domain | Primary sources |
|--------|-----------------|
| Web platform | W3C TR, WHATWG Living Standards, ECMA-262, MDN (as navigation to specs) |
| JavaScript runtimes | V8 blog for V8, Node.js docs for Node APIs, Deno/Bun official docs |
| Language specs | TC39 for JS; language reference manuals (Rust Reference, Go spec, Python Language Reference, etc.) |
| OS / kernel | Official kernel docs, syscall manpages from the official tree |
| Cloud platform APIs | Vendor official API reference with version anchor |
| Protocols | IETF RFCs, W3C standards |
| Audio / signal | IEC / AES / ITU standards; Oppenheim-Schafer, Zölzer, Pirkle as textbook anchors |
| Cryptography | NIST publications, IETF RFCs, reference implementations (libsodium, OpenSSL) |
| Databases | Vendor official docs + source (Postgres, MySQL, SQLite all have canonical docs) |
| SDK / framework APIs | Official headers in the repo; release notes for version-specific claims |

## The binding table

Output of Phase 2 is a table (embed in the plan file):

```
| Section (Part.Chapter) | Primary sources | Notes |
|------------------------|-----------------|-------|
| 1.1 Sampling theorem   | Oppenheim §4.2; Zölzer §1.3 | Standard DSP; no online spec |
| 2.5 Audio contract     | Bencina "RT programming 101"; JUCE docs | RT discipline canonical source |
| 4.3 Component split    | github.com/steinbergmedia/vst3_pluginterfaces — ivstcomponent.h, ivsteditcontroller.h | Pin commit SHA |
| 5.2 Worklet contract   | W3C Web Audio API §1.32.5 | Direct spec §-anchor |
```

## Verification before binding

Each binding must pass these checks before inclusion:

1. **URL actually resolves** — `WebFetch` the URL and confirm the page exists and is not a 404 or redirect to a landing page. Sandbox or network restrictions may cause transient failures; retry at least once.
2. **Claimed content is actually there** — skim the fetched content for the term/section being cited. A link to the repo root is *not* a binding to a specific function.
3. **For GitHub links** — use a `blob/<commit-sha>` or `blob/<tag>` URL, not `blob/main`, unless the project is actively being rev'd and the binding is understood to be intentionally floating.
4. **For specs with TR versions** — cite the specific version (e.g., Web Audio 1.1) if the surface area differs between versions.

## Deep-linking is the point

A reference to `steinberg.help/` or `vst3_dev_portal/` top page is **not** a binding. The writing agent should then be forced to dig further. Push deeper:

- Find the specific page/chapter in the vendor docs
- Find the specific `#anchor` within that page
- For headers, find the line range

The test: a reader following the citation in a fresh browser should land within seconds on the sentence or code that grounds the claim.

## When the primary source doesn't exist

Some topics have no primary source — they are *consensus practices* in a community (e.g., "don't allocate on the audio thread" is folklore-level but universally enforced). For these:

- Cite two or more *independent secondary authorities* that state the practice
- Explicitly note the lack of a primary source in the page's Sources section
- Use the `> NOTE: community practice — not in a single primary source` marker inline if the claim is load-bearing

This is better than inventing a citation, and it's a useful signal for the auditor about where the skill's content stands on less-firm ground.
