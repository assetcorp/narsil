# @delali/narsil-native-build

This package holds the C source of Narsil's native search core, which searches the HNSW graph of a vector field. It also holds the scripts that build, test, and lint that source. The package itself is private, but the release script publishes the compiled core as the six platform packages under `npm/`.

## Build, test, and lint

- `pnpm --filter @delali/narsil-native-build build` compiles the core for this machine with `cc`.
- `node build.mjs <target>` compiles the core for `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-arm64-musl`, `linux-x64`, `linux-x64-musl`, `win32-arm64`, or `win32-x64`. You need Zig 0.16.0 on your path for the Linux and Windows targets.
- `pnpm --filter @delali/narsil-native-build test` tests the core in C under the sanitisers.
- `pnpm nx run narsil-ts:test` includes `identity.test.ts`, which compares the results of the core with those of the WebAssembly search.
- `pnpm --filter @delali/narsil-native-build lint` checks the C code with clang-tidy and clang-format. `lint.mjs` installs the pinned tools into `.lint-tools` the first time, so you need `python3` on your path.
- `pnpm --filter @delali/narsil-native-build format` formats the C code with clang-format.

Set `NARSIL_NATIVE_CORE_PATH` to the absolute path of a binary to make Narsil load that binary.

The 'Native Search Core' section of [`packages/spec/vector-index.md`](../spec/vector-index.md#native-search-core) is the contract for the memory that the core searches, so change the spec first whenever you change that memory.
