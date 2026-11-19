# Search-engine comparison (best config (each engine's recommended production quantization)): keyword, vector, hybrid

## Run conditions

- Vector and hybrid tracks use each engine's own recommended production quantization (narsil OSQ 4-bit, narsil-rust OSQ 4-bit). Every engine meets the same recall target through its own search-effort knob, so compression differs by engine by design.
- Load machine: GCP c3-standard-8, us-central1-a
- OS / arch: Linux 7.0.0-1017-gcp / x86_64
- Engine machine label: GCP c3-standard-8, us-central1-a
- Engine machine: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical), 33.6 GB
- Network round trip to the engine machine: p50 0.083 ms, p99 0.141 ms over 200 TCP connects
- Equal memory cap per engine: 21.5 GB
- Node.js heap limit inside that cap, as each Narsil server reports it: narsil 16.1 GB, narsil-rust 21.5 GB
- Run depth: 1000; BM25 reference k1=0.9, b=0.4
- Shared embedding model: sentence-transformers/all-MiniLM-L6-v2 (384 dim, cosine); latency on the vector track is compared at matched ANN recall@10 >= 0.99.
- Every engine uses the same datasets, metrics, run depth, and strictly-decreasing run-file ordering.
- Headline latency is each engine's own reported query time, read from the same response the client round-trip wraps. Resolution differs by engine and is disclosed below; an engine that exposes no server-side time is marked not-available and compared on client round-trip only.

## Engines and tracks

| Engine | Version | Build | Tracks |
| --- | --- | --- | --- |
| narsil | 0.4.4 | ac4309dc5519 | keyword, vector, hybrid |
| narsil-rust | 0.4.4 | ac4309dc5519 | keyword, vector, hybrid |

## Vector track

### dbpedia-entities-openai-100k

Retrieval quality (higher is better). A star marks the best in each column:

| Engine | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| narsil | n/a | n/a | n/a | n/a |
| narsil-rust | n/a | n/a | n/a | n/a |

Matched-recall operating point per engine:

| Engine | Knob | Value | ANN recall@k | Target met |
| --- | --- | --- | --- | --- |
| narsil | efSearch | 128 | 0.9908 | yes |
| narsil-rust | efSearch | 128 | 0.9912 | yes |

Ingest throughput (higher is better) and query latency (lower is better). The headline latency is each engine's own server-side query time; a star marks the best in each column:

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 828 | 120.78 | 0.56 | 0.72 | 0.78 |
| narsil-rust | 878\* | 113.86\* | 0.46\* | 0.63\* | 0.72\* |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 2.42 | 2.64 | 2.82 |
| narsil-rust | 2.30\* | 2.53\* | 2.66\* |

Server-side time source per engine:

- narsil: response `elapsed` field (floating-millisecond resolution)
- narsil-rust: response `elapsed` field (floating-millisecond resolution)

Throughput under concurrent load (higher is better). Peak QPS is the highest sustained rate across the tested concurrency levels, and 'client-limited' flags an engine whose peak the harness capped, not the engine itself. A star marks the best:

| Engine | Peak QPS | 95% CI | At concurrency | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- |
| narsil | 1662\* | 1654 to 1665 | 16 | 15.94 | 99.14 | 2.21 | yes |
| narsil-rust | 1608 | 1596 to 1662 | 4 | 2.72 | 4.03 | 1.31 | no |

## Hybrid track

### dbpedia-entities-openai-100k

Retrieval quality (higher is better). A star marks the best in each column:

| Engine | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| narsil | n/a | n/a | n/a | n/a |
| narsil-rust | n/a | n/a | n/a | n/a |

Ingest throughput (higher is better) and query latency (lower is better). The headline latency is each engine's own server-side query time; a star marks the best in each column:

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 829 | 120.60 | 0.64\* | 0.80\* | 0.95 |
| narsil-rust | 870\* | 115.00\* | 0.65 | 0.85 | 0.95 |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 2.55\* | 2.79\* | 3.14 |
| narsil-rust | 2.56 | 2.85 | 3.01\* |

Server-side time source per engine:

- narsil: response `elapsed` field (floating-millisecond resolution)
- narsil-rust: response `elapsed` field (floating-millisecond resolution)

Throughput under concurrent load (higher is better). Peak QPS is the highest sustained rate across the tested concurrency levels, and 'client-limited' flags an engine whose peak the harness capped, not the engine itself. A star marks the best:

| Engine | Peak QPS | 95% CI | At concurrency | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- |
| narsil | 1649\* | 1648 to 1651 | 16 | 16.17 | 99.81 | 2.44 | yes |
| narsil-rust | 1646 | 1644 to 1654 | 16 | 16.00 | 102.55 | 1.79 | yes |
