# narsil-rust retrieval (keyword, vector, hybrid)

## Environment

- Captured: 2026-11-17T18:36:15.974225+00:00
- Load machine: GCP c3-standard-8, us-central1-a
- OS / arch: Linux 7.0.0-1017-gcp / x86_64 (containerized: True)
- CPU: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical)
- Memory: 33.6 GB
- Engine machine label: GCP c3-standard-8, us-central1-a
- Engine machine: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical), 33.6 GB
- Network round trip to the engine machine: p50 0.084 ms, p99 0.158 ms over 200 TCP connects
- Memory cap per engine: 21.5 GB
- Tracks: keyword, vector, hybrid
- Keyword setup: BM25 k1=0.9 b=0.4; language english, as the server reports it
- Run depth: 1000; run tag: narsil_rust_bm25
- Engine build: version 0.4.4, commit ac4309dc5519
- Engine image: ir-benchmark-engine-narsil-rust@sha256:6cf8f1dfd61896283181eeacff87b10cf580d1652e549f3884449f7cfb25a1dd

## Keyword track

Retrieval quality vs Anserini BM25 reference:

| Dataset | nDCG@10 | Reference | Delta | Status | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| dbpedia-entities-openai-100k | n/a | n/a | n/a | no baseline | n/a | n/a | n/a |

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | On disk | Peak heap | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| dbpedia-entities-openai-100k | 100000 | 37071 | 2.70 | 0.09 GB | 0.62 GB | 0.04 | 0.22 | 0.28 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| dbpedia-entities-openai-100k | 0.71 | 0.95 | 1.19 |

Engine container memory through the whole track, load included (anonymous memory is the heap the kernel cannot reclaim; charged memory adds the page cache of the engine's files):

| Dataset | Peak anonymous | Peak charged | Samples |
| --- | --- | --- | --- |
| dbpedia-entities-openai-100k | 0.62 GB | 0.80 GB | 357 |

Server-side time source per dataset:

- dbpedia-entities-openai-100k: response `elapsed` field (floating-millisecond resolution)

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 1548 | n/a | 0 | 0.82 | 1.02 | 0.30 | 1.0 | no |
| 2 | 1 | 2995 | n/a | 0 | 0.88 | 1.19 | 0.60 | 2.0 | no |
| 4 | 3 | 5986 | 5973 to 6061 | 0 | 0.89 | 1.31 | 1.26 | 4.0 | no |
| 8 | 1 | 4883 | n/a | 0 | 2.42 | 2.96 | 1.11 | 8.0 | yes |
| 16 | 1 | 4349 | n/a | 0 | 6.21 | 10.40 | 0.86 | 16.0 | yes |
| 32 | 1 | 3854 | n/a | 0 | 13.24 | 29.14 | 0.74 | 31.9 | yes |
| 64 | 1 | 3534 | n/a | 0 | 30.61 | 56.98 | 0.68 | 63.6 | yes |

## Vector track

- Embedding model: sentence-transformers/all-MiniLM-L6-v2 (384 dim, cosine)
- Index setup: HNSW over the shared precomputed vectors, full precision (quantization off), cosine
- Operating point: search knob tuned to ann_recall@10 >= 0.99 against exact kNN over the same vectors

Retrieval quality vs human judgements:

| Dataset | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| dbpedia-entities-openai-100k | n/a | n/a | n/a | n/a |

Recall operating point (latency below is measured here, the matched-recall rule for ANN search):

| Dataset | Knob | Value | ANN recall@k | Target met | Secondary value | Secondary recall |
| --- | --- | --- | --- | --- | --- | --- |
| dbpedia-entities-openai-100k | efSearch | 128 | 0.9916 | yes | 32 | 0.9618 |

Latency is measured at the operating point.

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | On disk | Peak heap | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| dbpedia-entities-openai-100k | 100000 | 860 | 116.23 | 0.72 GB | 2.33 GB | 1.66 | 2.19 | 2.37 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| dbpedia-entities-openai-100k | 3.57 | 4.11 | 4.31 |

Engine container memory through the whole track, load included (anonymous memory is the heap the kernel cannot reclaim; charged memory adds the page cache of the engine's files):

| Dataset | Peak anonymous | Peak charged | Samples |
| --- | --- | --- | --- |
| dbpedia-entities-openai-100k | 2.33 GB | 4.32 GB | 883 |

Server-side time source per dataset:

- dbpedia-entities-openai-100k: response `elapsed` field (floating-millisecond resolution)

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 280 | n/a | 0 | 4.14 | 4.48 | 0.56 | 1.0 | no |
| 2 | 1 | 582 | n/a | 0 | 3.94 | 4.62 | 1.06 | 2.0 | no |
| 4 | 1 | 1114 | n/a | 0 | 4.17 | 4.96 | 2.14 | 4.0 | no |
| 8 | 1 | 1330 | n/a | 0 | 8.92 | 10.90 | 3.10 | 8.0 | no |
| 16 | 1 | 1610 | n/a | 0 | 16.02 | 95.29 | 4.10 | 15.9 | yes |
| 32 | 3 | 1650 | 1636 to 1656 | 0 | 32.84 | 118.79 | 4.50 | 31.8 | yes |
| 64 | 1 | 1533 | n/a | 0 | 71.43 | 149.18 | 4.08 | 63.3 | yes |

## Hybrid track

- Setup: BM25 (text) fused with HNSW vector search via Reciprocal Rank Fusion
- Fusion: RRF (k=60)

Retrieval quality vs human judgements:

| Dataset | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| dbpedia-entities-openai-100k | n/a | n/a | n/a | n/a |

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | On disk | Peak heap | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| dbpedia-entities-openai-100k | 100000 | 872 | 114.67 | 0.72 GB | 2.35 GB | 1.54 | 2.12 | 2.30 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| dbpedia-entities-openai-100k | 3.42 | 4.01 | 4.22 |

Engine container memory through the whole track, load included (anonymous memory is the heap the kernel cannot reclaim; charged memory adds the page cache of the engine's files):

| Dataset | Peak anonymous | Peak charged | Samples |
| --- | --- | --- | --- |
| dbpedia-entities-openai-100k | 2.35 GB | 4.33 GB | 679 |

Server-side time source per dataset:

- dbpedia-entities-openai-100k: response `elapsed` field (floating-millisecond resolution)

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 295 | n/a | 0 | 3.91 | 4.31 | 0.53 | 1.0 | no |
| 2 | 1 | 607 | n/a | 0 | 3.78 | 4.05 | 1.03 | 2.0 | no |
| 4 | 1 | 1163 | n/a | 0 | 4.00 | 4.78 | 2.09 | 4.0 | no |
| 8 | 1 | 1344 | n/a | 0 | 8.67 | 10.81 | 2.79 | 8.0 | no |
| 16 | 1 | 1613 | n/a | 0 | 15.87 | 103.02 | 3.81 | 15.9 | yes |
| 32 | 3 | 1645 | 1635 to 1646 | 0 | 32.86 | 118.42 | 4.11 | 31.8 | yes |
| 64 | 1 | 1517 | n/a | 0 | 70.47 | 169.29 | 3.76 | 63.3 | yes |
