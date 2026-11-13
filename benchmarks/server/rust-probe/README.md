# Rust server probe

This probe puts the `delali-narsil` Rust crate behind a small HTTP server, so that the server benchmark harness can measure the crate under the same load as the TypeScript server. It answers the question of whether a single-node Rust server would serve the DBpedia 1M dataset faster, or in less memory, than the TypeScript server does. It is a measurement tool, and nothing publishes it.

## What it serves

The probe accepts the requests that the benchmark sends through `src/ir_bench/drivers/narsil.py`, so the harness drives both servers through one driver class. It serves these routes:

- `GET /readyz` and `GET /version`
- `POST /indexes` and `DELETE /indexes/{name}`
- `POST /indexes/{name}/documents/_import`, which takes NDJSON
- `POST /indexes/{name}/search` for keyword, vector, and hybrid search
- `GET /indexes/{name}/count` and `GET /indexes/{name}/stats`
- `POST /indexes/{name}/vectors/_optimize`, `GET /indexes/{name}/vector-maintenance`, and `GET /tasks/{id}`
- `GET /stats/memory`

Select it with `./run-all.sh narsil narsil-rust`. The `narsil-rust` service in `docker-compose.yml` builds it from `narsil-rust-probe.Dockerfile`, with the same memory cap, durability directory, body limits, and jemalloc preload as the `narsil` service.

## Thread model

The server accepts connections on a Tokio multi-thread runtime through axum. It moves engine calls onto a separate Rayon pool so that a search leaves the socket threads available. Each `_optimize` task calls the engine on a separate thread. The HTTP and search thread counts both default to the available cores, and `NARSIL_HTTP_THREADS` and `NARSIL_SEARCH_THREADS` override them.

## Differences from the TypeScript server

The harness sends both servers the same documents, queries, BM25 parameters, HNSW settings, and precision profile. For equal precision it requests `quantization: none`. For best config it requests `osq4` from 384 dimensions and `osq8` below that, then tunes each server against the same exact-neighbour oracle. These differences can affect the comparison:

- The TypeScript server keeps its main index and, after promotion, a copy on every request thread. The probe shares one index across its search threads, which can reduce memory use. The default TypeScript request count is one on fewer than three cores and otherwise the core count minus one, bounded between two and eight. The probe uses one search thread per available core, so its default search parallelism can be higher. The TypeScript server also has a thread for long queries.
- The TypeScript import handler keeps up to four batches in progress within one request. The Rust handler inserts one batch at a time, while separate requests can import concurrently. Both handlers use batches of 1,000 documents and defer repeated IDs until the other batches finish. Serial batches can reduce Rust ingest throughput and temporary memory use.
- The probe uses `serde_json` for requests and imported documents, while the TypeScript server uses `JSON.parse`. The probe preserves ordinary JSON objects, including objects with a single `$`-prefixed key. Parser allocation and numeric conversion can affect ingest time and memory. The probe rejects invalid UTF-8, lone surrogate escapes, numbers beyond finite float64, and nesting beyond the parser's depth limit. The TypeScript parser can accept some of those inputs, so the probe can report different failures for malformed or extreme documents.
- The probe requires object-shaped requests and rejects unknown request fields, including unsupported index settings. The TypeScript server ignores unknown search fields. The benchmark sends object-shaped requests with known fields, so these checks do not change its answers.
- The TypeScript server budgets the combined bytes of request bodies and checks memory before parsing. The probe enforces each body's byte limit but has no combined body budget or parser memory admission check. Concurrent large requests can therefore consume more memory in the probe before the engine refuses writes, and the container can terminate it under that load. A production server needs admission control before these figures can predict its behaviour under overload.
- The TypeScript import handler checks a disconnect between batches. An import that has started on the Rust pool continues after a disconnect. Retries can therefore overlap with more unfinished Rust work, which can affect ingest latency and memory when connections fail.
- The probe's error bodies omit `details`, its index statistics omit `heldSearchStates`, and its memory statistics list no worker copies. Its task records omit `owner`. Axum can answer malformed paths or unsupported methods with a different status or body from the TypeScript router. The benchmark does not use those fields or requests.
- The probe serves no facets, groups, filters, highlights, asynchronous imports, authentication hooks, or cluster routes. The benchmark does not call them. Its `synonyms` index setting is also unsupported, so the separate synonym relevance experiment cannot use this probe.

## Recovery and measurement limits

Both supplied servers use in-memory task records, including when `NARSIL_DURABILITY_DIR` enables the document write-ahead log. After a restart, `GET /tasks/{id}` answers 404 for an earlier task. An accepted optimize request is therefore no promise that its task status will remain available. The caller can check the recovered documents and request optimization again. A process killed during an import can retain part of the unacknowledged request; the harness retries document IDs and treats duplicate-ID failures as already indexed.

Both containers use `BENCH_MEM_CAP`, the same body limits, and jemalloc. The harness samples each engine container's `memory.current` and the `anon` entry of `memory.stat` every 250 ms throughout each track, including loading and dropping the index. These sampled peaks can miss shorter spikes. Charged memory includes file cache and kernel allocations as well as anonymous memory. The separately recorded `memory.peak` covers the container's whole lifetime, including earlier tracks, so it is not a per-track peak. Index-size estimates use different formulas in the two engines, so use the cgroup figures for the memory comparison.

Both engines report query time inside the engine call. That time excludes HTTP parsing, waiting for a request or search thread, and serialising the response. Use the harness's client latency and throughput figures when assessing a server's response time under concurrent load.

## Checking that both servers agree

`tests/test_rust_probe_parity.py` loads one synthetic corpus into both servers through the harness's driver. It then checks every keyword, vector, and hybrid answer against a BM25, exact cosine, and reciprocal rank fusion model written in plain Python, which shares no code with either engine. The test skips unless two running servers are named:

```bash
NARSIL_PARITY_TS_URL=http://127.0.0.1:17700 \
NARSIL_PARITY_RUST_URL=http://127.0.0.1:17701 \
pytest tests/test_rust_probe_parity.py
```

## Building it outside Docker

```bash
cargo build --release --locked
NARSIL_PORT=17701 NARSIL_DURABILITY_DIR=/var/tmp/narsil-probe ./target/release/narsil-rust-probe
```

The server listens on loopback unless `NARSIL_ALLOW_INSECURE=true` lets it bind another address.

The HTTP and recovery tests start separate probe processes with temporary durability directories. Set `NARSIL_RUST_PROBE_BINARY` to the absolute path of the release binary and execute these tests from `benchmarks/server`:

```bash
python -m pytest -q tests/test_rust_probe_http.py tests/test_rust_probe_lifecycle.py
```

The tests cover malformed bodies, exact byte boundaries, duplicate IDs, task limits, concurrent index operations, and restarts during imports and optimization. They check stored documents and cosine scores against independently constructed expectations. A zero body limit rejects every non-empty body, matching the supplied TypeScript server.
