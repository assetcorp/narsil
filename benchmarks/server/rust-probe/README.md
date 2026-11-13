# Rust server probe

This probe puts the `delali-narsil` Rust crate behind a small HTTP server, so that the server benchmark harness can measure the crate under the same load as the TypeScript server. It answers the question of whether a single-node Rust server would serve the DBpedia 1M dataset faster, or in less memory, than the TypeScript server does. It is a measurement tool, and nothing publishes it.

## What it serves

The probe speaks the routes that `src/ir_bench/drivers/narsil.py` calls, with the same request and response shapes as the TypeScript server, so the harness drives both servers through one driver class:

- `GET /readyz` and `GET /version`
- `POST /indexes` and `DELETE /indexes/{name}`
- `POST /indexes/{name}/documents/_import`, which takes NDJSON
- `POST /indexes/{name}/search` for keyword, vector, and hybrid search
- `GET /indexes/{name}/count` and `GET /indexes/{name}/stats`
- `POST /indexes/{name}/vectors/_optimize`, `GET /indexes/{name}/vector-maintenance`, and `GET /tasks/{id}`
- `GET /stats/memory`

Select it with `./run-all.sh narsil narsil-rust`. The `narsil-rust` service in `docker-compose.yml` builds it from `narsil-rust-probe.Dockerfile`, with the same memory cap, durability directory, body limits, and jemalloc preload as the `narsil` service.

## Thread model

The server accepts connections on a Tokio multi-thread runtime through axum, and it moves every engine call onto a separate Rayon pool so that a long search never blocks a thread that is reading sockets. A graph build for `_optimize` runs on a thread of its own and reports through the task record. Both thread counts default to the number of cores, and `NARSIL_HTTP_THREADS` and `NARSIL_SEARCH_THREADS` override them.

## Differences from the TypeScript server

The two servers match on the harness's routes, so the harness measures them with the same code. They still differ in the ways below, and each one can move a figure.

- **Index copies.** The TypeScript server keeps a copy of each index on every request thread, which is 7 copies on an 8-core machine. The probe keeps one copy that every search thread reads, so its memory can come out lower for that reason alone.
- **Threads.** The TypeScript server answers on its request threads, which number one fewer than the cores up to 8, plus a thread for long queries. The probe uses one search thread for each core. On 8 cores the probe can therefore put one more thread on searches.
- **JSON parsing.** The probe parses a request body with `serde_json` and an imported document with the crate's `parse_json`, while the TypeScript server uses `JSON.parse` for both. On a 1,536-dimension vector, parsing is a small share of the time that an insert takes.
- **Unknown search fields.** The probe refuses a field that it does not know, while the TypeScript server ignores it. The harness sends only known fields, so this changes no figure.
- **Error bodies and stats.** The probe's error bodies carry no `details`, its stats leave out `heldSearchStates`, and its `/stats/memory` lists no worker copies. The harness reads none of these to compute a figure.
- **Search features.** The probe serves no facets, groups, filters, highlights, or cluster routes, because the harness's search requests use none of them.

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
