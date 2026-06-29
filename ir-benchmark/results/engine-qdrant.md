# qdrant retrieval (vector, hybrid)

## Environment

- Captured: 2026-06-29T14:23:51.636972+00:00
- OS / arch: Linux 6.12.76-linuxkit / aarch64 (containerized: True)
- CPU: aarch64 (7 logical)
- Memory: 9.4 GB
- Memory cap per engine: 8.6 GB
- Tracks: vector, hybrid
- Keyword setup: None
- Run depth: 1000; run tag: qdrant

## Vector track

- Embedding model: sentence-transformers/all-MiniLM-L6-v2 (384 dim, cosine)
- Index setup: HNSW dense vectors, distance Cosine, over the shared precomputed vectors
- Operating point: search knob tuned to ann_recall@10 >= 0.99 against exact kNN over the same vectors

Retrieval quality vs human judgements:

| Dataset | nDCG@10 | Recall@100 | MAP | MRR |
|---|---|---|---|---|
| beir/scifact/test | 0.6239 | 0.9227 | 0.5797 | 0.5849 |

Recall operating point (latency below is measured here, the matched-recall rule for ANN search):

| Dataset | Knob | Value | ANN recall@k | Target met | Secondary value | Secondary recall |
|---|---|---|---|---|---|---|
| beir/scifact/test | hnsw_ef | 64 | 0.9977 | yes | 16 | 0.9597 |

Latency is measured at the operating point.

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | Index size | Server p50 ms | Server p95 ms | Server p99 ms |
|---|---|---|---|---|---|---|---|
| beir/scifact/test | 5183 | 1488 | 3.48 | n/a | 0.25 | 0.34 | 0.41 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
|---|---|---|---|
| beir/scifact/test | 0.73 | 0.93 | 1.13 |

Server-side time source per dataset:

- beir/scifact/test: top-level `time` field (seconds, converted to ms) (floating-millisecond resolution)

## Hybrid track

- Setup: Dense HNSW fused with BM25 sparse vectors (fastembed Qdrant/bm25, server IDF) via RRF
- Fusion: RRF (Query API fusion)

Retrieval quality vs human judgements:

| Dataset | nDCG@10 | Recall@100 | MAP | MRR |
|---|---|---|---|---|
| beir/scifact/test | 0.7155 | 0.9577 | 0.6730 | 0.6762 |

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | Index size | Server p50 ms | Server p95 ms | Server p99 ms |
|---|---|---|---|---|---|---|---|
| beir/scifact/test | 5183 | 1761 | 2.94 | n/a | 0.28 | 0.35 | 0.48 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
|---|---|---|---|
| beir/scifact/test | 0.82 | 1.03 | 1.37 |

Server-side time source per dataset:

- beir/scifact/test: top-level `time` field (seconds, converted to ms) (floating-millisecond resolution)
