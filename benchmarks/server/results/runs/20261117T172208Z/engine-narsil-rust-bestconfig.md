# narsil-rust retrieval (keyword, vector, hybrid, best-config vector profile)

## Environment

- Captured: 2026-11-17T18:46:04.629615+00:00
- Load machine: GCP c3-standard-8, us-central1-a
- OS / arch: Linux 7.0.0-1017-gcp / x86_64 (containerized: True)
- CPU: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical)
- Memory: 33.6 GB
- Engine machine label: GCP c3-standard-8, us-central1-a
- Engine machine: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical), 33.6 GB
- Network round trip to the engine machine: p50 0.086 ms, p99 0.144 ms over 200 TCP connects
- Memory cap per engine: 21.5 GB
- Tracks: keyword, vector, hybrid
- Keyword setup: BM25 k1=0.9 b=0.4; language english, as the server reports it
- Run depth: 1000; run tag: narsil_rust_bm25
- Engine build: version 0.4.4, commit ac4309dc5519
- Engine image: ir-benchmark-engine-narsil-rust@sha256:6cf8f1dfd61896283181eeacff87b10cf580d1652e549f3884449f7cfb25a1dd

## Vector track

- Embedding model: sentence-transformers/all-MiniLM-L6-v2 (384 dim, cosine)
- Index setup: HNSW over the shared precomputed vectors, OSQ 4-bit optimised scalar quantization with the graph built from codes and a full-precision rescore, cosine
- Operating point: search knob tuned to ann_recall@10 >= 0.99 against exact kNN over the same vectors

Retrieval quality vs human judgements:

| Dataset | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| dbpedia-entities-openai-100k | n/a | n/a | n/a | n/a |

Recall operating point (latency below is measured here, the matched-recall rule for ANN search):

| Dataset | Knob | Value | ANN recall@k | Target met | Secondary value | Secondary recall |
| --- | --- | --- | --- | --- | --- | --- |
| dbpedia-entities-openai-100k | efSearch | 128 | 0.9912 | yes | 32 | 0.9636 |

Latency is measured at the operating point.

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | On disk | Peak heap | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| dbpedia-entities-openai-100k | 100000 | 878 | 113.86 | 0.79 GB | 2.60 GB | 0.46 | 0.63 | 0.72 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| dbpedia-entities-openai-100k | 2.30 | 2.53 | 2.66 |

Engine container memory through the whole track, load included (anonymous memory is the heap the kernel cannot reclaim; charged memory adds the page cache of the engine's files):

| Dataset | Peak anonymous | Peak charged | Samples |
| --- | --- | --- | --- |
| dbpedia-entities-openai-100k | 2.60 GB | 4.64 GB | 848 |

Server-side time source per dataset:

- dbpedia-entities-openai-100k: response `elapsed` field (floating-millisecond resolution)

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 424 | n/a | 0 | 2.52 | 2.80 | 0.33 | 1.0 | no |
| 2 | 1 | 829 | n/a | 0 | 2.56 | 2.94 | 0.62 | 2.0 | no |
| 4 | 3 | 1608 | 1596 to 1662 | 0 | 2.72 | 4.03 | 1.31 | 4.0 | no |
| 8 | 1 | 1603 | n/a | 0 | 7.51 | 9.81 | 1.31 | 8.0 | no |
| 16 | 1 | 1645 | n/a | 0 | 16.08 | 99.20 | 1.55 | 16.0 | yes |
| 32 | 1 | 1606 | n/a | 0 | 33.04 | 132.28 | 1.47 | 31.8 | yes |
| 64 | 1 | 1503 | n/a | 0 | 71.84 | 170.93 | 1.25 | 63.3 | yes |

## Hybrid track

- Setup: BM25 (text) fused with OSQ 4-bit optimised-scalar-quantized HNSW vector search (full-precision rescore) via Reciprocal Rank Fusion
- Fusion: RRF (k=60)

Retrieval quality vs human judgements:

| Dataset | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| dbpedia-entities-openai-100k | n/a | n/a | n/a | n/a |

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | On disk | Peak heap | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| dbpedia-entities-openai-100k | 100000 | 870 | 115.00 | 0.79 GB | 2.58 GB | 0.65 | 0.85 | 0.95 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| dbpedia-entities-openai-100k | 2.56 | 2.85 | 3.01 |

Engine container memory through the whole track, load included (anonymous memory is the heap the kernel cannot reclaim; charged memory adds the page cache of the engine's files):

| Dataset | Peak anonymous | Peak charged | Samples |
| --- | --- | --- | --- |
| dbpedia-entities-openai-100k | 2.58 GB | 4.62 GB | 658 |

Server-side time source per dataset:

- dbpedia-entities-openai-100k: response `elapsed` field (floating-millisecond resolution)

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 385 | n/a | 0 | 2.83 | 3.39 | 0.37 | 1.0 | no |
| 2 | 1 | 760 | n/a | 0 | 2.85 | 3.23 | 0.74 | 2.0 | no |
| 4 | 1 | 1536 | n/a | 0 | 2.87 | 3.54 | 1.46 | 4.0 | no |
| 8 | 1 | 1551 | n/a | 0 | 7.75 | 11.65 | 1.66 | 8.0 | no |
| 16 | 3 | 1646 | 1644 to 1654 | 0 | 16.00 | 102.55 | 1.79 | 16.0 | yes |
| 32 | 1 | 1588 | n/a | 0 | 32.33 | 122.92 | 1.69 | 31.8 | yes |
| 64 | 1 | 1541 | n/a | 0 | 69.72 | 149.02 | 1.65 | 63.3 | yes |
