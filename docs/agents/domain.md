# Domain Docs

This page tells you how to read this repo's domain documentation before you explore the codebase.

This repo is single-context: one `CONTEXT.md` and one `docs/adr/` at the root cover all five packages.

## Before exploring, read these

- Read **`CONTEXT.md`** at the repo root.
- Read the ADRs in **`docs/adr/`** that touch the area you are about to work in.

If either of these doesn't exist, **proceed silently**. Don't flag its absence, and don't suggest creating it upfront. The `/domain-modeling` skill, which both `/grill-with-docs` and `/improve-codebase-architecture` reach, creates them once you resolve a term or settle a decision.

## File structure

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-primary-admits-replicas-to-the-in-sync-set.md
│   └── 0002-a-node-closes-idle-indexes-locally.md
├── docs/                              ← user-facing guides, not domain docs
└── packages/
    ├── spec/                          ← the cross-language contract
    ├── ts/                            ← the reference implementation
    ├── native/                        ← the search core in C
    ├── certutil/
    └── embeddings-transformers/
```

`packages/spec` holds the cross-language contract, which outranks both `CONTEXT.md` and any ADR. Where a domain doc and the spec disagree, the spec wins, so fix the domain doc.

## Use the glossary's vocabulary

When your output names a domain concept, in an issue title, a refactor proposal, a hypothesis, or a test name, use the term that `CONTEXT.md` defines. Never reach for a synonym that the glossary avoids.

Where the glossary holds no entry for the concept that you need, one of two things is true. Either you are inventing language that the project does not use, in which case reconsider it, or the glossary has a real gap, in which case note it for `/domain-modeling`.

## Flag ADR conflicts

Where your output contradicts an existing ADR, say so explicitly, and never override it in silence:

> _This contradicts ADR-0007, which says that the workers holding the copies receive the HTTP requests, and it is worth reopening because…_
