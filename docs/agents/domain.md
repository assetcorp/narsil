# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

This repo is single-context: one `CONTEXT.md` and one `docs/adr/` at the root cover all four packages.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root.
- **`docs/adr/`** — read ADRs that touch the area you're about to work in.

If either of these doesn't exist, **proceed silently**. Don't flag its absence; don't suggest creating it upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-partition-capacity-cap.md
│   └── 0002-replication-log-entry-format.md
├── docs/                              ← user-facing guides, not domain docs
└── packages/
    ├── spec/                          ← the cross-language contract
    ├── ts/                            ← the reference implementation
    ├── certutil/
    └── embeddings-transformers/
```

`packages/spec` holds the cross-language contract, and it outranks both `CONTEXT.md` and any ADR. Where a domain doc and the spec disagree, the spec wins and the domain doc is the thing to fix.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal, and it means one of two things: either you're inventing language the project doesn't use, in which case reconsider, or there's a real gap, in which case note it for `/domain-modeling`.

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders), but worth reopening because…_
