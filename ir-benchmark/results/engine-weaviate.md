# weaviate retrieval (vector, hybrid)

## Environment

- Captured: 2026-06-29T10:40:25.851702+00:00
- Machine: Apple M3 Pro, macOS 26.5.1
- OS / arch: Linux 6.12.76-linuxkit / aarch64 (containerized: True)
- CPU: aarch64 (7 logical)
- Memory: 9.4 GB
- Memory cap per engine: 8.6 GB
- Tracks: vector, hybrid
- Keyword setup: None
- Run depth: 1000; run tag: weaviate

## Vector track

- Embedding model: sentence-transformers/all-MiniLM-L6-v2 (384 dim, cosine)
- Index setup: HNSW dense vectors, distance cosine, over the shared precomputed vectors
- Operating point: search knob tuned to ann_recall@10 >= 0.99 against exact kNN over the same vectors

Retrieval quality vs human judgements:

| Dataset | nDCG@10 | Recall@100 | MAP | MRR |
|---|---|---|---|---|
| beir/scifact/test | 0.6239 | 0.9227 | 0.5797 | 0.5849 |
| beir/nfcorpus/test | 0.3145 | 0.3094 | 0.1575 | 0.5168 |

Recall operating point (latency below is measured here, the matched-recall rule for ANN search):

| Dataset | Knob | Value | ANN recall@k | Target met | Secondary value | Secondary recall |
|---|---|---|---|---|---|---|
| beir/scifact/test | ef | 64 | 0.9950 | yes | 32 | 0.9840 |
| beir/nfcorpus/test | ef | 128 | 0.9923 | yes | 64 | 0.9755 |

Operational metrics (latency at the operating point):

| Dataset | Docs | Ingest docs/s | Build s | Index size | p50 ms | p95 ms | p99 ms |
|---|---|---|---|---|---|---|---|
| beir/scifact/test | 5183 | 1462 | 3.55 | n/a | 1.81 | 3.70 | 6.70 |
| beir/nfcorpus/test | 3633 | 1593 | 2.28 | n/a | 1.73 | 2.10 | 4.14 |

## Hybrid track

- Setup: BM25 over text fused with dense vectors via the hybrid operator (rankedFusion, alpha=0.5)
- Fusion: rankedFusion (alpha=0.5)

Retrieval quality vs human judgements:

| Dataset | nDCG@10 | Recall@100 | MAP | MRR |
|---|---|---|---|---|
| beir/scifact/test | 0.6885 | 0.9577 | 0.6405 | 0.6513 |
| beir/nfcorpus/test | 0.3431 | 0.3180 | 0.1812 | 0.5600 |

Operational metrics:

| Dataset | Docs | Ingest docs/s | Build s | Index size | p50 ms | p95 ms | p99 ms |
|---|---|---|---|---|---|---|---|
| beir/scifact/test | 5183 | 1339 | 3.87 | n/a | 2.62 | 3.99 | 7.30 |
| beir/nfcorpus/test | 3633 | 1694 | 2.15 | n/a | 2.26 | 4.08 | 6.00 |
