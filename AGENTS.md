# Working in this repository

`packages/spec` holds the cross-language contract, and it outranks the TypeScript code. `packages/ts` is the reference implementation, and any port to another language must match both.

Read the file you're editing and follow what it already does. The rules below cover what that reading leaves out.

## Rules

- Re-read and apply the user's writing guidelines fully, if available, whenever you are writing TS-Doc or any prose in the repo.
- Leave `packages/spec` alone. The developer owns every spec change and makes it directly. When your work needs a different header field, envelope version, payload encoding, client-facing error code, or replication invariant, say so and wait for their decision. Write no code against a spec change they have not approved.
- Keep every source file under 400 lines. Measure a file when you touch it, and split it before your change pushes it over. Turn a module that outgrows one file into a directory with an `index.ts` that re-exports it, and drop the module prefix from each filename inside. Copy `src/core/partition/` or `src/engine/mutations/`. The limit covers source only, and `src/languages/` is exempt as well, because each module ports a published stemmer and a reader checks those line by line against the reference.
- Keep everything tree-shakeable. A bundler must be able to drop any capability the caller never imports, so add no barrel that pulls siblings in, and register no optional capability at module load. `src/languages/registry.ts` holds English alone for exactly this reason, and a caller imports and registers any other language itself. Registering all of them there would pull every stop word list and every stemmer into every bundle, so leave that file as it is and make each new language reachable by direct import.
- Throw a `NarsilError` carrying a code from `ErrorCodes` in `src/errors.ts`, and let it propagate unchanged, because its code is what the server maps to an HTTP status. Add every new code in `ErrorCodes` or `ServerErrorCodes` to `STATUS_BY_CODE` in `src/server/errors.ts`, or the server answers 500. The `ClientErrorCodes` stay out of that map, because the HTTP client raises those after the response and no request can arrive under one.
- Leave `VERSION` in `src/index.ts` alone unless the developer asks for a new value. `serialization/envelope.ts` writes it into the engine-version bytes of every `.nrsl` file, where the format gives each part a single byte and nothing reads it back. It records the engine, and it carries no relation to the published package version, so never sync it to `package.json` and never bump it alongside a release.
- Put every test under its package's `src/__tests__/`, mirroring the directory it covers. All three packages collect `src/**/__tests__/**/*.test.ts`, and `packages/ts` adds `benchmarks/__tests__/`, so a test beside its source never runs.
- Never propose refusing, narrowing, or deferring a capability because implementing it properly is harder. Read how established engines solve it and what this repository already does, then propose that. `registerEmbeddingAdapter` in `src/narsil.ts` takes a name because an instance survives neither a worker boundary nor a restart, and a custom tokenizer, a stop word function, and a language module all need that same treatment.
- Write no `any`, no non-null assertion, and no `@ts-ignore` or `@ts-expect-error` under `packages/ts/src`. The package has none today; narrow the type instead.
- Give every exported function and every member of `Narsil` a TSDoc comment, because `tsup` carries it into the published `.d.ts`, where it becomes what a caller reads on hover in their editor. Open with what the caller gets, keep the prose plain and British, and describe each parameter and the return value. Reference another symbol with `{@link Narsil.insertBatch}`, which resolves inside this package. Paste no URL into a comment. That TSDoc is the only comment the repository carries: a non-exported function, a catch block, a test, a harness, and a fixture carry none, whatever the reason seems to be.
- Install with `pnpm add -E` from inside the target workspace, and leave the `dependencies` and `devDependencies` blocks alone otherwise.
- Run `pnpm nx run narsil-ts:lint`, `pnpm nx run narsil-ts:typecheck`, `pnpm nx run narsil-ts:build`, and `pnpm nx run narsil-ts:test` before you report a change done. Add the `narsil-certutil` and `narsil-embeddings-transformers` targets when you touch those packages, and follow `packages/ts/src/languages/README.md` when you touch `src/languages/`.

## Gotchas

- **Every worker loads its entry from `dist/`.** `workers/factory.ts`, `vector/hnsw-worker-dispatch.ts`, `serialization/checksum-dispatch.ts`, and `persistence/durability/checkpoint-worker-dispatch.ts` each rewrite their own `/src/` path to a `/dist/*.mjs` path. Build before you run a test that loads worker copies, builds an HNSW graph off-thread, checksums off-thread, or offloads a checkpoint.
- **Worker copies are on by default everywhere but a browser.** `createNarsil()` with no `workers` setting loads a copy of any index onto every worker once it holds 1,000 documents, so a test that inserts that many documents spawns threads and needs `dist/` built. Pass `workers: { enabled: false }` in a test whose subject is the main copy alone.
- **Node builtins break the browser bundle.** Lint, typecheck, and the tests all pass when a file under `src/` imports `node:fs`; only `scripts/check-browser-bundle.mjs` reports it, and it walks the import graph from `dist/index.browser.mjs` and `dist/client.mjs`, which `pnpm build` produces before running the check. Add every new browser-facing entry to that list. Route Node-only code through a `#platform/*` subpath declared in the `imports` block of `packages/ts/package.json`, with a `.browser.ts` variant beside the Node one.
- **`narsil-ts:lint` checks `src/` only.** That target skips `packages/ts/scripts/`, `packages/ts/wasm/`, and `packages/ts/benchmarks/`. `typecheck:tooling` type-checks those three, and root `pnpm format` formats them.
- **The default test target skips the slow suites.** `narsil-ts:test` excludes `vector/recall.test.ts`. Recall runs under `test:recall`, etcd integration under `test:etcd` against a live endpoint in `NARSIL_ETCD_ENDPOINT`, and embedding end-to-end under `test:embeddings` with `NARSIL_TEST_EMBEDDINGS=1`. Continuous integration runs recall and embedding only when a pull request touches their paths.
- **A language change needs steps the usual four targets do not cover.** Changing analysis means bumping the module's revision, adding a language means writing the fixture the coverage gate requires, and an alphabet with lookalike letters means recording a substitution count. `packages/ts/src/languages/README.md` lists every command, when to run it, and which ones continuous integration enforces. Read it before you edit `src/languages/`.
- **Root `pnpm test` skips the example apps.** It excludes `@delali/narsil-example-*` and covers the three packages plus the benchmarks project. Run `pnpm test:examples` when you change the browser or server-app example.
- **A generator writes `BENCHMARKS.md`, `nx release` writes each `CHANGELOG.md`, and `packages/ts/wasm/build.ts` writes `src/vector/simd-wasm-binary.ts`.** `benchmarks/writeup/generate.py` fills the regions between the `<!-- BENCH:<id> START -->` markers from the newest recorded run, and continuous integration fails when the committed page differs from a fresh generation. Edit the source each one reads.
- **A benchmark run is a committed artifact.** The writeup reads the newest run directory under each suite's `results/`, so running a suite changes what the published page reports. Run one only when you're asked to.
- **`etcd3` and `uWebSockets.js` are optional peer dependencies.** `distribution/coordinator/etcd/loader.ts` and `server/runtime.ts` load them by dynamic import. A static import of either breaks every install that leaves the optional dependency out.
- **A write during rebalancing goes to the write-ahead queue.** `partitioning/write-ahead-queue.ts` throws `PARTITION_REBALANCING_BACKPRESSURE` once it holds 10,000 entries, and it replays entries in sequence-number order.
- **The write-ahead log and the replication log share one entry format.** `persistence/durability/manager.ts` builds each log record with `buildEntry` from `distribution/replication/entry-checksum.ts`, so a change to `ReplicationLogEntry` or to its checksum changes what recovery reads off disk.
- **A worker never receives live partition state.** `core/partition/wire-payload.ts` converts it first and maps internal ordinals back to external document IDs. Convert any new structure that holds internal ordinals the same way.
- **The dependency age gate refuses a package published less than four days ago,** and the supply-chain gate refuses an unpinned action reference, a `pull_request_target` trigger, and any URL dependency other than the pinned `uWebSockets.js`.

Read `CONTRIBUTING.md` for the house style and `ROADMAP.md` for where the project is heading. Cluster mode under `src/distribution/` is the project's active focus, so preserve its recovery and failover invariants when you change replication or bootstrap code.

## Agent skills

### Issue tracker

Issues live as GitHub issues on `assetcorp/narsil`, and every operation runs through the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical roles, each label string equal to its name. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` and one `docs/adr/` at the repo root cover all four packages. See `docs/agents/domain.md`.
