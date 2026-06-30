# qdrant retrieval (vector, hybrid)

## Environment

- Captured: 2026-06-29T15:32:34.482284+00:00
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
- Index setup: HNSW dense vectors, distance Cosine, over the shared precomputed vectors
- Operating point: search knob tuned to ann_recall@10 >= 0.99 against exact kNN over the same vectors

Retrieval quality vs human judgements:

| Dataset | nDCG@10 | Recall@100 | MAP | MRR |
|---|---|---|---|---|
| beir/scifact/test | 0.6239 | 0.9227 | 0.5797 | 0.5849 |
| beir/nfcorpus/test | 0.3145 | 0.3094 | 0.1575 | 0.5168 |

Recall operating point (latency below is measured here, the matched-recall rule for ANN search):

| Dataset | Knob | Value | ANN recall@k | Target met | Secondary value | Secondary recall |
|---|---|---|---|---|---|---|
| beir/scifact/test | hnsw_ef | 64 | 0.9973 | yes | 16 | 0.9590 |
| beir/nfcorpus/test | hnsw_ef | 128 | 0.9975 | yes | 32 | 0.9684 |

Latency is measured at the operating point.

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | Index size | Server p50 ms | Server p95 ms | Server p99 ms |
|---|---|---|---|---|---|---|---|
| beir/scifact/test | 5183 | 1609 | 3.22 | n/a | 0.24 | 0.27 | 0.33 |
| beir/nfcorpus/test | 3633 | 1660 | 2.19 | n/a | 0.25 | 0.29 | 0.33 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
|---|---|---|---|
| beir/scifact/test | 0.72 | 0.83 | 0.90 |
| beir/nfcorpus/test | 0.74 | 0.84 | 0.95 |

Server-side time source per dataset:

- beir/scifact/test: top-level `time` field (seconds, converted to ms) (floating-millisecond resolution)
- beir/nfcorpus/test: top-level `time` field (seconds, converted to ms) (floating-millisecond resolution)

## Hybrid track

- Setup: Dense HNSW fused with BM25 sparse vectors (fastembed Qdrant/bm25, server IDF) via RRF
- Fusion: RRF (Query API fusion)

Retrieval quality vs human judgements:

| Dataset | nDCG@10 | Recall@100 | MAP | MRR |
|---|---|---|---|---|
| beir/scifact/test | 0.7155 | 0.9577 | 0.6730 | 0.6762 |
| beir/nfcorpus/test | 0.3510 | 0.3239 | 0.1823 | 0.5670 |

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | Index size | Server p50 ms | Server p95 ms | Server p99 ms |
|---|---|---|---|---|---|---|---|
| beir/scifact/test | 5183 | 1765 | 2.94 | n/a | 0.26 | 0.30 | 0.32 |
| beir/nfcorpus/test | 3633 | 1658 | 2.19 | n/a | 0.26 | 0.30 | 0.32 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
|---|---|---|---|
| beir/scifact/test | 0.80 | 0.88 | 0.98 |
| beir/nfcorpus/test | 0.78 | 0.88 | 0.95 |

Server-side time source per dataset:

- beir/scifact/test: top-level `time` field (seconds, converted to ms) (floating-millisecond resolution)
- beir/nfcorpus/test: top-level `time` field (seconds, converted to ms) (floating-millisecond resolution)
