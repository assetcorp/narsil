# Contributing to Narsil

Thanks for your interest in Narsil. This guide covers how to set up the repository, run the checks, and propose a change.

## Prerequisites

- Node.js 22 or newer.
- pnpm 10.30.3, the version pinned in `package.json`. Run `corepack enable` and pnpm will match it.

## Set up the repository

```bash
git clone https://github.com/assetcorp/narsil.git
cd narsil
pnpm install
```

## Run the checks

The same checks run in continuous integration, so run them before you open a pull request.

```bash
pnpm build       # build every package
pnpm test        # run the test suites
pnpm lint        # run Biome
pnpm typecheck   # run the TypeScript compiler
pnpm format      # apply Biome formatting
```

## Repository layout

- `packages/ts` holds the TypeScript engine, the server subpath, and the distribution subpath.
- `packages/spec` holds the language-neutral specification for the `.nrsl` format and the algorithms.
- `packages/embeddings-transformers` and `packages/certutil` hold the local embedding adapter and the certificate CLI.
- `benchmarks` holds the in-process and server benchmark suites.

## Conventions

- Keep each source file under 400 lines. A module that outgrows one file becomes a directory under `core/`.
- Let Biome format the code. Do not hand-format around it.
- Write a comment only for a reason a reader cannot infer from the code.
- Anything that changes the `.nrsl` format starts from [`packages/spec`](packages/spec), because the format is a cross-language contract. A change there affects every future implementation.

## Propose a change

- For a small first change, look for issues labelled `good first issue`.
- For a bug, open an issue with the bug template so the report includes the version, the runtime, and a reproduction.
- For a larger change, open an issue to discuss the design before you write the code.

## Licence

By contributing, you agree your contribution is licensed under the Apache-2.0 licence that covers the project.
