# qdrant retrieval (vector, hybrid, best-config vector profile)

## Environment

- Captured: 2026-06-29T15:33:00.327275+00:00
- Machine: Apple M3 Pro
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
| beir/nfcorpus/test | 0.3145 | 0.3094 | 0.1575 | 0.5168 |

Recall operating point (latency below is measured here, the matched-recall rule for ANN search):

| Dataset | Knob | Value | ANN recall@k | Target met | Secondary value | Secondary recall |
|---|---|---|---|---|---|---|
| beir/scifact/test | hnsw_ef | 64 | 0.9967 | yes | 16 | 0.9743 |
| beir/nfcorpus/test | hnsw_ef | 64 | 0.9920 | yes | 32 | 0.9666 |

Latency is measured at the operating point.

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | Index size | Server p50 ms | Server p95 ms | Server p99 ms |
|---|---|---|---|---|---|---|---|
| beir/scifact/test | 5183 | 1711 | 3.03 | n/a | 0.18 | 0.22 | 0.25 |
| beir/nfcorpus/test | 3633 | 1665 | 2.18 | n/a | 0.18 | 0.21 | 0.23 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
|---|---|---|---|
| beir/scifact/test | 0.67 | 0.79 | 0.91 |
| beir/nfcorpus/test | 0.66 | 0.74 | 0.82 |

Server-side time source per dataset:

- beir/scifact/test: top-level `time` field (seconds, converted to ms) (floating-millisecond resolution)
- beir/nfcorpus/test: top-level `time` field (seconds, converted to ms) (floating-millisecond resolution)

## Hybrid track

- Setup: int8-quantized dense HNSW (full-precision rescore) fused with BM25 sparse vectors (fastembed Qdrant/bm25, server IDF) via RRF
- Fusion: RRF (Query API fusion)

Retrieval quality vs human judgements:

| Dataset | nDCG@10 | Recall@100 | MAP | MRR |
|---|---|---|---|---|
| beir/scifact/test | 0.7155 | 0.9577 | 0.6730 | 0.6762 |
| beir/nfcorpus/test | 0.3510 | 0.3242 | 0.1823 | 0.5670 |

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | Index size | Server p50 ms | Server p95 ms | Server p99 ms |
|---|---|---|---|---|---|---|---|
| beir/scifact/test | 5183 | 1841 | 2.81 | n/a | 0.22 | 0.25 | 0.26 |
| beir/nfcorpus/test | 3633 | 1652 | 2.20 | n/a | 0.20 | 0.25 | 0.31 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
|---|---|---|---|
| beir/scifact/test | 0.74 | 0.81 | 0.89 |
| beir/nfcorpus/test | 0.73 | 0.93 | 1.30 |

Server-side time source per dataset:

- beir/scifact/test: top-level `time` field (seconds, converted to ms) (floating-millisecond resolution)
- beir/nfcorpus/test: top-level `time` field (seconds, converted to ms) (floating-millisecond resolution)
