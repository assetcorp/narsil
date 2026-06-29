# weaviate retrieval (vector, hybrid, best-config vector profile)

## Environment

- Captured: 2026-06-29T14:24:55.990147+00:00
- OS / arch: Linux 6.12.76-linuxkit / aarch64 (containerized: True)
- CPU: aarch64 (7 logical)
- Memory: 9.4 GB
- Memory cap per engine: 8.6 GB
- Tracks: vector, hybrid
- Keyword setup: None
- Run depth: 1000; run tag: weaviate

## Vector track

- Embedding model: sentence-transformers/all-MiniLM-L6-v2 (384 dim, cosine)
- Index setup: HNSW dense vectors with 8-bit Rotational Quantization and full-precision rescore, distance cosine, over the shared precomputed vectors
- Operating point: search knob tuned to ann_recall@10 >= 0.99 against exact kNN over the same vectors

Retrieval quality vs human judgements:

| Dataset | nDCG@10 | Recall@100 | MAP | MRR |
|---|---|---|---|---|
| beir/scifact/test | 0.6239 | 0.9227 | 0.5797 | 0.5849 |

Recall operating point (latency below is measured here, the matched-recall rule for ANN search):

| Dataset | Knob | Value | ANN recall@k | Target met | Secondary value | Secondary recall |
|---|---|---|---|---|---|---|
| beir/scifact/test | ef | 64 | 0.9953 | yes | 32 | 0.9807 |

Latency is measured at the operating point.

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | Index size | Server p50 ms | Server p95 ms | Server p99 ms |
|---|---|---|---|---|---|---|---|
| beir/scifact/test | 5183 | 1698 | 3.05 | n/a | n/a | n/a | n/a |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
|---|---|---|---|
| beir/scifact/test | 1.71 | 2.37 | 4.70 |

Server-side time source per dataset:

- beir/scifact/test: client round-trip only (no server-side query time exposed)

## Hybrid track

- Setup: BM25 over text fused with RQ-quantized dense vectors (full-precision rescore) via the hybrid operator (rankedFusion, alpha=0.5)
- Fusion: rankedFusion (alpha=0.5)

Retrieval quality vs human judgements:

| Dataset | nDCG@10 | Recall@100 | MAP | MRR |
|---|---|---|---|---|
| beir/scifact/test | 0.6885 | 0.9577 | 0.6405 | 0.6513 |

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | Index size | Server p50 ms | Server p95 ms | Server p99 ms |
|---|---|---|---|---|---|---|---|
| beir/scifact/test | 5183 | 1700 | 3.05 | n/a | n/a | n/a | n/a |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
|---|---|---|---|
| beir/scifact/test | 2.71 | 4.99 | 7.93 |

Server-side time source per dataset:

- beir/scifact/test: client round-trip only (no server-side query time exposed)
