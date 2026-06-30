# narsil retrieval (keyword, vector, hybrid)

## Environment

- Captured: 2026-06-29T15:18:06.799912+00:00
- Machine: Apple M3 Pro
- OS / arch: Linux 6.12.76-linuxkit / aarch64 (containerized: True)
- CPU: aarch64 (7 logical)
- Memory: 9.4 GB
- Memory cap per engine: 8.6 GB
- Tracks: keyword, vector, hybrid
- Keyword setup: BM25 k1=0.9 b=0.4; Narsil english analyzer (Porter stemmer, 70-word stop list)
- Run depth: 1000; run tag: narsil_bm25

## Keyword track

Retrieval quality vs Anserini BM25 reference:

| Dataset | nDCG@10 | Reference | Delta | Status | Recall@100 | MAP | MRR |
|---|---|---|---|---|---|---|---|
| beir/scifact/test | 0.6781 | 0.6790 | -0.0009 | within margin | 0.9320 | 0.6379 | 0.6456 |
| beir/nfcorpus/test | 0.3269 | 0.3220 | +0.0049 | within margin | 0.2491 | 0.1530 | 0.5284 |

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | Index size | Server p50 ms | Server p95 ms | Server p99 ms |
|---|---|---|---|---|---|---|---|
| beir/scifact/test | 5183 | 6182 | 0.84 | 17.8 MB | 0.44 | 0.84 | 1.15 |
| beir/nfcorpus/test | 3633 | 6527 | 0.56 | 13.3 MB | 0.08 | 0.39 | 0.56 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
|---|---|---|---|
| beir/scifact/test | 0.78 | 1.21 | 1.54 |
| beir/nfcorpus/test | 0.40 | 0.74 | 0.94 |

Server-side time source per dataset:

- beir/scifact/test: response `elapsed` field (floating-millisecond resolution)
- beir/nfcorpus/test: response `elapsed` field (floating-millisecond resolution)

## Vector track

- Embedding model: sentence-transformers/all-MiniLM-L6-v2 (384 dim, cosine)
- Index setup: HNSW over the shared precomputed vectors, full precision (SQ8 quantization off), cosine
- Operating point: search knob tuned to ann_recall@10 >= 0.99 against exact kNN over the same vectors

Retrieval quality vs human judgements:

| Dataset | nDCG@10 | Recall@100 | MAP | MRR |
|---|---|---|---|---|
| beir/scifact/test | 0.6239 | 0.9227 | 0.5797 | 0.5849 |
| beir/nfcorpus/test | 0.3145 | 0.3094 | 0.1575 | 0.5168 |

Recall operating point (latency below is measured here, the matched-recall rule for ANN search):

| Dataset | Knob | Value | ANN recall@k | Target met | Secondary value | Secondary recall |
|---|---|---|---|---|---|---|
| beir/scifact/test | efSearch | 64 | 0.9967 | yes | 16 | 0.9607 |
| beir/nfcorpus/test | efSearch | 128 | 0.9947 | yes | 32 | 0.9585 |

Latency is measured at the operating point.

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | Index size | Server p50 ms | Server p95 ms | Server p99 ms |
|---|---|---|---|---|---|---|---|
| beir/scifact/test | 5183 | 651 | 7.96 | 33.9 MB | 0.39 | 0.54 | 1.04 |
| beir/nfcorpus/test | 3633 | 664 | 5.47 | 24.6 MB | 0.69 | 0.85 | 1.12 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
|---|---|---|---|
| beir/scifact/test | 2.57 | 2.97 | 5.11 |
| beir/nfcorpus/test | 2.84 | 3.09 | 3.48 |

Server-side time source per dataset:

- beir/scifact/test: response `elapsed` field (floating-millisecond resolution)
- beir/nfcorpus/test: response `elapsed` field (floating-millisecond resolution)

## Hybrid track

- Setup: BM25 (text) fused with HNSW vector search via Reciprocal Rank Fusion
- Fusion: RRF (k=60)

Retrieval quality vs human judgements:

| Dataset | nDCG@10 | Recall@100 | MAP | MRR |
|---|---|---|---|---|
| beir/scifact/test | 0.7015 | 0.9643 | 0.6532 | 0.6596 |
| beir/nfcorpus/test | 0.3555 | 0.3239 | 0.1877 | 0.5727 |

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | Index size | Server p50 ms | Server p95 ms | Server p99 ms |
|---|---|---|---|---|---|---|---|
| beir/scifact/test | 5183 | 673 | 7.70 | 33.9 MB | 0.98 | 1.57 | 1.90 |
| beir/nfcorpus/test | 3633 | 668 | 5.44 | 24.6 MB | 0.65 | 1.15 | 1.48 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
|---|---|---|---|
| beir/scifact/test | 3.17 | 3.86 | 4.21 |
| beir/nfcorpus/test | 2.82 | 3.37 | 3.76 |

Server-side time source per dataset:

- beir/scifact/test: response `elapsed` field (floating-millisecond resolution)
- beir/nfcorpus/test: response `elapsed` field (floating-millisecond resolution)
