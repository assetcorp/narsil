# qdrant retrieval (vector, hybrid, best-config vector profile)

## Environment

- Captured: 2026-06-29T14:24:06.587482+00:00
- OS / arch: Linux 6.12.76-linuxkit / aarch64 (containerized: True)
- CPU: aarch64 (7 logical)
- Memory: 9.4 GB
- Memory cap per engine: 8.6 GB
- Tracks: vector, hybrid
- Keyword setup: None
- Run depth: 1000; run tag: qdrant

## Vector track

- Embedding model: sentence-transformers/all-MiniLM-L6-v2 (384 dim, cosine)
- Index setup: HNSW dense vectors with int8 scalar quantization and full-precision rescore (oversampling 2.0x), distance Cosine, over the shared precomputed vectors
- Operating point: search knob tuned to ann_recall@10 >= 0.99 against exact kNN over the same vectors

Retrieval quality vs human judgements:

| Dataset | nDCG@10 | Recall@100 | MAP | MRR |
|---|---|---|---|---|
| beir/scifact/test | 0.6239 | 0.9227 | 0.5797 | 0.5849 |

Recall operating point (latency below is measured here, the matched-recall rule for ANN search):

| Dataset | Knob | Value | ANN recall@k | Target met | Secondary value | Secondary recall |
|---|---|---|---|---|---|---|
| beir/scifact/test | hnsw_ef | 64 | 0.9987 | yes | 16 | 0.9757 |

Latency is measured at the operating point.

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | Index size | Server p50 ms | Server p95 ms | Server p99 ms |
|---|---|---|---|---|---|---|---|
| beir/scifact/test | 5183 | 1618 | 3.20 | n/a | 0.19 | 0.23 | 0.26 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
|---|---|---|---|
| beir/scifact/test | 0.68 | 0.78 | 0.85 |

Server-side time source per dataset:

- beir/scifact/test: top-level `time` field (seconds, converted to ms) (floating-millisecond resolution)

## Hybrid track

- Setup: int8-quantized dense HNSW (full-precision rescore) fused with BM25 sparse vectors (fastembed Qdrant/bm25, server IDF) via RRF
- Fusion: RRF (Query API fusion)

Retrieval quality vs human judgements:

| Dataset | nDCG@10 | Recall@100 | MAP | MRR |
|---|---|---|---|---|
| beir/scifact/test | 0.7155 | 0.9577 | 0.6730 | 0.6762 |

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | Index size | Server p50 ms | Server p95 ms | Server p99 ms |
|---|---|---|---|---|---|---|---|
| beir/scifact/test | 5183 | 1756 | 2.95 | n/a | 0.22 | 0.26 | 0.31 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
|---|---|---|---|
| beir/scifact/test | 0.76 | 0.89 | 1.11 |

Server-side time source per dataset:

- beir/scifact/test: top-level `time` field (seconds, converted to ms) (floating-millisecond resolution)
