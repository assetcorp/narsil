# Search-engine comparison (equal precision (every engine full float)): keyword, vector, hybrid

## Run conditions

- Vector and hybrid tracks hold every engine at full float (no quantization) for an equal-precision comparison.
- Load machine: GCP c3-standard-8, us-central1-a
- OS / arch: Linux 7.0.0-1017-gcp / x86_64
- Engine machine label: GCP c3-standard-8, us-central1-a
- Engine machine: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical), 33.6 GB
- Network round trip to the engine machine: p50 0.092 ms, p99 0.167 ms over 200 TCP connects
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

## Keyword track

### dbpedia-entities-openai-100k

Retrieval quality (higher is better). A star marks the best in each column:

| Engine | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| narsil | n/a | n/a | n/a | n/a |
| narsil-rust | n/a | n/a | n/a | n/a |

Ingest throughput (higher is better) and query latency (lower is better). The headline latency is each engine's own server-side query time; a star marks the best in each column:

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 18265 | 5.48 | 0.09 | 0.28 | 0.37 |
| narsil-rust | 37071\* | 2.70\* | 0.04\* | 0.22\* | 0.28\* |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 0.78 | 1.06 | 1.22 |
| narsil-rust | 0.71\* | 0.95\* | 1.19\* |

Server-side time source per engine:

- narsil: response `elapsed` field (floating-millisecond resolution)
- narsil-rust: response `elapsed` field (floating-millisecond resolution)

Throughput under concurrent load (higher is better). Peak QPS is the highest sustained rate across the tested concurrency levels, and 'client-limited' flags an engine whose peak the harness capped, not the engine itself. A star marks the best:

| Engine | Peak QPS | 95% CI | At concurrency | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- |
| narsil | 4851 | 4539 to 5050 | 4 | 1.10 | 1.71 | 1.29 | no |
| narsil-rust | 5986\* | 5973 to 6061 | 4 | 0.89 | 1.31 | 1.26 | no |

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
| narsil | efSearch | 128 | 0.9914 | yes |
| narsil-rust | efSearch | 128 | 0.9916 | yes |

Ingest throughput (higher is better) and query latency (lower is better). The headline latency is each engine's own server-side query time; a star marks the best in each column:

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 831 | 120.35 | 1.42\* | 1.97\* | 2.17\* |
| narsil-rust | 860\* | 116.23\* | 1.66 | 2.19 | 2.37 |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 3.33\* | 3.91\* | 4.17\* |
| narsil-rust | 3.57 | 4.11 | 4.31 |

Server-side time source per engine:

- narsil: response `elapsed` field (floating-millisecond resolution)
- narsil-rust: response `elapsed` field (floating-millisecond resolution)

Throughput under concurrent load (higher is better). Peak QPS is the highest sustained rate across the tested concurrency levels, and 'client-limited' flags an engine whose peak the harness capped, not the engine itself. A star marks the best:

| Engine | Peak QPS | 95% CI | At concurrency | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- |
| narsil | 1644 | 1643 to 1660 | 32 | 32.96 | 114.31 | 4.36 | yes |
| narsil-rust | 1650\* | 1636 to 1656 | 32 | 32.84 | 118.79 | 4.50 | yes |

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
| narsil | 835 | 119.75 | 1.77 | 2.32 | 2.52 |
| narsil-rust | 872\* | 114.67\* | 1.54\* | 2.12\* | 2.30\* |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 3.69 | 4.27 | 4.55 |
| narsil-rust | 3.42\* | 4.01\* | 4.22\* |

Server-side time source per engine:

- narsil: response `elapsed` field (floating-millisecond resolution)
- narsil-rust: response `elapsed` field (floating-millisecond resolution)

Throughput under concurrent load (higher is better). Peak QPS is the highest sustained rate across the tested concurrency levels, and 'client-limited' flags an engine whose peak the harness capped, not the engine itself. A star marks the best:

| Engine | Peak QPS | 95% CI | At concurrency | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- |
| narsil | 1656\* | 1644 to 1660 | 32 | 32.54 | 112.36 | 4.90 | yes |
| narsil-rust | 1645 | 1635 to 1646 | 32 | 32.86 | 118.42 | 4.11 | yes |
