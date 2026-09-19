# Contributing to Narsil

This guide covers how to set up the repository, check a change, and propose it.

## Prerequisites

- You need Node.js 22 or newer.
- You need pnpm 10.30.3, the version in the `packageManager` field of `package.json`. Once you enable Corepack with `corepack enable`, Corepack uses that version whenever you call pnpm in this repository.
- A C compiler must be on your path as `cc`, because `pnpm build` compiles the native search core.
- Python 3 must be on your path as `python3`, because `pnpm lint` installs the pinned clang tools and Zig into `packages/native/.lint-tools` through it.

## Set up the repository

```bash
git clone https://github.com/assetcorp/narsil.git
cd narsil
pnpm install
```

## Check a change

Continuous integration executes the same checks, so execute them yourself before you open a pull request.

```bash
pnpm build       # build every package
pnpm test        # test every package
pnpm lint        # check the code with Biome, clang-tidy, and clang-format
pnpm typecheck   # type-check the TypeScript
pnpm format      # apply Biome formatting
pnpm --filter @delali/narsil-native-build format   # apply clang-format to the C code
```

## Repository layout

- `packages/ts` holds the TypeScript engine, the server subpath, and the distribution subpath.
- `packages/spec` holds the language-neutral specification for the `.nrsl` format and the algorithms.
- `packages/native` holds the native search core in C, its Node-API binding, and the scripts that build, test, and lint them.
- `packages/embeddings-transformers` and `packages/certutil` hold the local embedding adapter and the certificate CLI.
- `benchmarks` holds the in-process and server benchmark suites.

## Conventions

- Keep each source file under 400 lines. When you split a module across several files, put them in a directory with an `index.ts` that re-exports the module, as `packages/ts/src/core/partition/` does.
- Let Biome format the code, and keep the layout that it writes.
- Let clang-format lay out the C code, following `packages/native/.clang-format`.
- `pnpm lint` exits with an error on any clang-tidy finding, because clang-tidy reports every finding as an error under `packages/native/.clang-tidy`.
- In VS Code or Cursor, install the clangd extension and remove or disable Microsoft's C/C++ extension so that the editor shows the lint's findings as you type.
- `.vscode/settings.json` holds the path to the clangd that `pnpm lint` installs in `packages/native/.lint-tools`, so lint once before you open a C file.
- [`packages/native/README.md`](packages/native/README.md) covers how to build, test, and lint the native search core.
- Start any change to the `.nrsl` format in [`packages/spec`](packages/spec), because the format is a cross-language contract that every future implementation must match.
- When you add a language, or change how the engine analyses text in an existing one, you need steps beyond the usual lint, typecheck, build, and test targets. [`packages/ts/src/languages/README.md`](packages/ts/src/languages/README.md) holds every command, when to use it, and which of them continuous integration executes.

## Propose a change

- For a small first change, look for issues labelled `good first issue`.
- For a bug, open an issue with the bug template so that the report includes the version, the runtime, and a reproduction.
- For a larger change, open an issue to discuss the design before you write the code.

## Licence

By contributing, you agree that your contribution falls under the Apache-2.0 licence that covers the project.
