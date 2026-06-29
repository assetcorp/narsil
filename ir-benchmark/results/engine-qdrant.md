# qdrant retrieval (vector, hybrid)

## Environment

- Captured: 2026-06-29T10:39:54.297689+00:00
- Machine: Apple M3 Pro, macOS 26.5.1
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
| beir/scifact/test | hnsw_ef | 64 | 0.9970 | yes | 16 | 0.9600 |
| beir/nfcorpus/test | hnsw_ef | 128 | 0.9978 | yes | 32 | 0.9709 |

Operational metrics (latency at the operating point):

| Dataset | Docs | Ingest docs/s | Build s | Index size | p50 ms | p95 ms | p99 ms |
|---|---|---|---|---|---|---|---|
| beir/scifact/test | 5183 | 1545 | 3.35 | n/a | 0.76 | 1.02 | 1.48 |
| beir/nfcorpus/test | 3633 | 1409 | 2.58 | n/a | 0.79 | 1.16 | 1.61 |

## Hybrid track

- Setup: Dense HNSW fused with BM25 sparse vectors (fastembed Qdrant/bm25, server IDF) via RRF
- Fusion: RRF (Query API fusion)

Retrieval quality vs human judgements:

| Dataset | nDCG@10 | Recall@100 | MAP | MRR |
|---|---|---|---|---|
| beir/scifact/test | 0.7155 | 0.9577 | 0.6730 | 0.6762 |
| beir/nfcorpus/test | 0.3504 | 0.3238 | 0.1822 | 0.5634 |

Operational metrics:

| Dataset | Docs | Ingest docs/s | Build s | Index size | p50 ms | p95 ms | p99 ms |
|---|---|---|---|---|---|---|---|
| beir/scifact/test | 5183 | 1670 | 3.10 | n/a | 0.81 | 1.09 | 1.46 |
| beir/nfcorpus/test | 3633 | 1535 | 2.37 | n/a | 0.89 | 1.57 | 2.76 |
