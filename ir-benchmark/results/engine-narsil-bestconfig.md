# narsil retrieval (keyword, vector, hybrid, best-config vector profile)

## Environment

- Captured: 2026-06-29T14:09:36.128776+00:00
- OS / arch: Linux 6.12.76-linuxkit / aarch64 (containerized: True)
- CPU: aarch64 (7 logical)
- Memory: 9.4 GB
- Memory cap per engine: 8.6 GB
- Tracks: keyword, vector, hybrid
- Keyword setup: BM25 k1=0.9 b=0.4; Narsil english analyzer (Porter stemmer, 70-word stop list)
- Run depth: 1000; run tag: narsil_bm25

## Vector track

- Embedding model: sentence-transformers/all-MiniLM-L6-v2 (384 dim, cosine)
- Index setup: HNSW over the shared precomputed vectors, SQ8 scalar quantization with full-precision rerank, cosine
- Operating point: search knob tuned to ann_recall@10 >= 0.99 against exact kNN over the same vectors

Retrieval quality vs human judgements:

| Dataset | nDCG@10 | Recall@100 | MAP | MRR |
|---|---|---|---|---|
| beir/scifact/test | 0.6239 | 0.9227 | 0.5797 | 0.5849 |

Recall operating point (latency below is measured here, the matched-recall rule for ANN search):

| Dataset | Knob | Value | ANN recall@k | Target met | Secondary value | Secondary recall |
|---|---|---|---|---|---|---|
| beir/scifact/test | efSearch | 64 | 0.9967 | yes | 16 | 0.9603 |

Latency is measured at the operating point.

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | Index size | Server p50 ms | Server p95 ms | Server p99 ms |
|---|---|---|---|---|---|---|---|
| beir/scifact/test | 5183 | 567 | 9.14 | 37.8 MB | 0.33 | 0.60 | 1.32 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
|---|---|---|---|
| beir/scifact/test | 2.49 | 3.10 | 4.15 |

Server-side time source per dataset:

- beir/scifact/test: response `elapsed` field (floating-millisecond resolution)

## Hybrid track

- Setup: BM25 (text) fused with SQ8-quantized HNSW vector search (full-precision rerank) via Reciprocal Rank Fusion
- Fusion: RRF (k=60)

Retrieval quality vs human judgements:

| Dataset | nDCG@10 | Recall@100 | MAP | MRR |
|---|---|---|---|---|
| beir/scifact/test | 0.7015 | 0.9643 | 0.6532 | 0.6596 |

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | Index size | Server p50 ms | Server p95 ms | Server p99 ms |
|---|---|---|---|---|---|---|---|
| beir/scifact/test | 5183 | 574 | 9.04 | 37.8 MB | 1.12 | 2.01 | 2.99 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
|---|---|---|---|
| beir/scifact/test | 3.34 | 4.46 | 6.46 |

Server-side time source per dataset:

- beir/scifact/test: response `elapsed` field (floating-millisecond resolution)
