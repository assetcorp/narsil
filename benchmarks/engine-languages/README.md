# Narsil in three languages

This suite measures the same Narsil engine in TypeScript on Node.js, in the Rust crate, and in the Go engine. All three search through the same C core, so the suite shows what each language adds around that core, and it compares no other search engine.

## What it measures

Each engine runs in a separate process on the same machine and reads the same workload files:

- Keyword search over the first 50,000 FiQA documents with 1,000 queries, which the embedded suite draws with seed 42.
- Vector and hybrid search over the 5,183 SciFact documents and their 300 queries, with 384-dimension vectors from `Xenova/all-MiniLM-L6-v2`.

For each engine, on 1 thread and on 8 threads, the suite reports queries per second, p50 and p99 latency, the insert rate, and resident memory. The insert rate counts the time that the engine spends inserting and optimising the vector graph, since TypeScript builds the graph when you optimise while Rust places each vector as it arrives.

Every engine uses the same settings: English analysis, a page of 10, float32 vectors with the cosine metric, an HNSW graph with `m` 16 and `efConstruction` 200, `efSearch` 50, and reciprocal rank fusion with `k` 60. Every engine also runs the same warm-up passes, the same measured passes, and the same number of repetitions, and the engine order rotates between repetitions.

The thread setting counts concurrent callers and sets the engine's worker budget to the same value. One caller disables worker copies. With 8 callers, TypeScript divides its budget between 4 keyword workers and 4 vector workers, Go configures 8 query workers, and Rust searches on the caller threads. Each engine keeps its standard scheduling policy. The CLI accepts 1 to 31 callers because TypeScript and Go cap their worker budgets at 31.

Rust and Go search one index in shared memory. TypeScript's threads share no memory, so its 8 callers share the Node.js main thread, which copies each query into a message to a worker thread and copies the answer back out of the reply. A keyword query takes tens of microseconds on 1 thread, so on 8 threads those copies and the wait for the shared main thread can take longer than the search itself, and TypeScript's 8-thread p50 can reach several times its 1-thread p50.

## How the answers are checked

A Python oracle in `oracle/` shares no code with any engine, and it checks every answer before the suite records a run:

- Keyword search must match the conformance text oracle's BM25 ranking: the same count, the same top 10, and scores within a relative 1e-12. Two documents whose scores fall within that tolerance count as tied, so an engine can order them either way, because two implementations of the same formula can round the last bit of a score differently.
- Vector search must score every hit within 1e-5 of the exact cosine that the oracle computes in plain Python, and its mean recall must reach the specification's floors of 0.95 at 10 and 0.90 at 100.
- Hybrid search fuses a text half and a vector half of 11 hits each, so each runner also reports both halves. The text half must match the oracle's BM25 top 11 under the keyword rule, the hybrid answer must equal the reciprocal rank fusion of the two halves, and its recall at 10 against the fusion of the text half with the exact vector top 11 must reach 0.95.
- The three engines must agree: their mean recall can differ by no more than 4 standard errors of the paired difference, and every document that two engines both return for a vector query must carry the same score from the shared C core.

During the measured passes each runner compares the count, the count-exact flag, and every hit's ID and score with the answer that the oracle checked. Rust keeps the same caller threads through warm-up and measurement so that their search buffers remain allocated.

## Run it

The suite needs Node.js 24, the Rust toolchain that `packages/rust/rust-toolchain.toml` pins, Go 1.26, Python 3.12 or later, and a C compiler. From the repository root:

```bash
pnpm install
pnpm nx run-many -t build --projects=narsil-ts,narsil-embeddings-transformers,@delali/narsil-native-build
pnpm --filter engine-languages-benchmark bench
```

Use `--size small` for a smaller workload and `BENCH_PROFILE=smoke` to write under `results/.smoke/`, which git ignores. The suite publishes a complete directory under `results/runs/<run-id>/` after the oracle accepts every answer. Each directory contains `results.json`, `report.md`, `verdict.json`, and `run.json`.
