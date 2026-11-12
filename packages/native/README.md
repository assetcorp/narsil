# @delali/narsil-native-build

This package holds the C source of Narsil's native search core, which every Narsil implementation calls for text analysis and for every search. The core analyses text with each of the language modules, scores keyword searches with BM25, fuses keyword and vector rankings for a hybrid search, searches a vector field, builds and compacts the field's HNSW graph, and writes the field's codes. The package also holds the scripts that build, test, and lint that source.

## Who builds the core

| Implementation | How it gets the core |
| --- | --- |
| [`@delali/narsil`](../ts) outside a browser | The release script compiles the core with its Node binding into the six platform packages under `npm/`, and npm installs the one that matches the machine as an optional dependency of `@delali/narsil`. |
| [`@delali/narsil-react-native`](../react-native) | The app's iOS or Android build compiles the core from the sources inside the package. |
| [`delali-narsil`](../rust) | The release copies `src` and `include` into the crate, and the crate's build script compiles them with the `cc` crate. |
| [`packages/go/engine`](../go/engine) | The module holds a copy of `src` and `include` under `internal/core`, and cgo compiles it with the Go program. |

In a browser, and wherever `@delali/narsil` cannot load the core, the TypeScript package does the same work through WebAssembly and TypeScript and returns the same results. This package is private, so npm never installs it.

## Build, test, and lint

- `pnpm --filter @delali/narsil-native-build build` compiles the core for this machine with `cc`.
- `node build.mjs <target>` compiles the core for `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-arm64-musl`, `linux-x64`, `linux-x64-musl`, `win32-arm64`, or `win32-x64`. You need Zig 0.16.0 on your path for the Linux and Windows targets.
- `pnpm --filter @delali/narsil-native-build test` tests the core in C under the sanitisers. It also refuses every allocation that each tested operation makes, one at a time, and it fails when the core misses an error, leaks, or keeps an allocation site that no test refuses.
- `pnpm --filter @delali/narsil-native-build fuzz` fuzzes each target under `fuzz/` for 60 seconds with libFuzzer, AddressSanitizer, and UndefinedBehaviorSanitizer. Pass `--seconds <n>` to change the time, and name targets to fuzz only those. You need clang with its libFuzzer runtime, and you can set `NARSIL_FUZZ_CC` to choose a specific clang such as `clang-18`.
- `node fuzz/run.mjs --replay` replays every input under `fuzz/corpus/` without libFuzzer. Each input there once made a target fail, so add every new failing input to its target's directory alongside the fix.
- `pnpm --filter @delali/narsil-native-build test:binding` builds the binding under AddressSanitizer and UndefinedBehaviorSanitizer on Linux, runs the TypeScript tests that load the core against it, and fails on any memory error or any leak that the core or the binding allocated. Build the TypeScript package first, so that the tests that copy an index onto worker threads run as well.
- `pnpm nx run narsil-ts:test` includes the tests under `src/__tests__/vector/native`, which compare the results, the graph, and the codes of the core with those of the WebAssembly search.
- `pnpm --filter @delali/narsil-native-build lint` checks the C code with clang-tidy and clang-format. `lint.mjs` installs the pinned tools into `.lint-tools` on its first use, so you need `python3` on your path. Pass a part such as `1/2` to run only that share of the checks, as continuous integration does on Linux.
- `pnpm --filter @delali/narsil-native-build format` formats the C code with clang-format.

Set `NARSIL_NATIVE_CORE_PATH` to the absolute path of a binary to make `@delali/narsil` load that binary.

## Change the core

The 'Native Search Core' section of [`packages/spec/vector-index.md`](../spec/vector-index.md#native-search-core) is the contract for the core's operations and for the memory that the core works on, so change the spec first whenever you change either.

After you change a file under `src` or `include`, run `go run ./internal/corecopy -write` in `packages/go/engine` to refresh the Go module's copy. The Go engine's continuous integration runs the same command without `-write`, and it fails when the copy differs from this package.
