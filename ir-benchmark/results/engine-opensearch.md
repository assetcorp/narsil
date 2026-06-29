# opensearch retrieval (keyword, vector, hybrid)

## Environment

- Captured: 2026-06-29T10:38:11.376386+00:00
- Machine: Apple M3 Pro, macOS 26.5.1
- OS / arch: Linux 6.12.76-linuxkit / aarch64 (containerized: True)
- CPU: aarch64 (7 logical)
- Memory: 9.4 GB
- Memory cap per engine: 8.6 GB
- Tracks: keyword, vector, hybrid
- Keyword setup: BM25 k1=0.9 b=0.4 (custom default similarity, native Lucene BM25Similarity in 3.x); OpenSearch `english` analyzer (Porter stemmer, English stop words)
- Run depth: 1000; run tag: opensearch_bm25

## Keyword track

Retrieval quality vs Anserini BM25 reference:

| Dataset | nDCG@10 | Reference | Delta | Status | Recall@100 | MAP | MRR |
|---|---|---|---|---|---|---|---|
| beir/scifact/test | 0.6789 | 0.6790 | -0.0001 | within margin | 0.9253 | 0.6401 | 0.6506 |
| beir/nfcorpus/test | 0.3206 | 0.3220 | -0.0014 | within margin | 0.2457 | 0.1503 | 0.5255 |

Operational metrics:

| Dataset | Docs | Ingest docs/s | Build s | Index size | p50 ms | p95 ms | p99 ms |
|---|---|---|---|---|---|---|---|
| beir/scifact/test | 5183 | 7398 | 0.70 | 7.0 MB | 1.06 | 2.04 | 3.54 |
| beir/nfcorpus/test | 3633 | 3218 | 1.13 | 5.1 MB | 0.79 | 3.35 | 9.63 |

## Vector track

- Embedding model: sentence-transformers/all-MiniLM-L6-v2 (384 dim, cosine)
- Index setup: knn_vector HNSW (faiss engine, inner product on L2-normalized vectors = cosine), over the shared precomputed vectors
- Operating point: search knob tuned to ann_recall@10 >= 0.99 against exact kNN over the same vectors

Retrieval quality vs human judgements:

| Dataset | nDCG@10 | Recall@100 | MAP | MRR |
|---|---|---|---|---|
| beir/scifact/test | 0.6239 | 0.9227 | 0.5797 | 0.5849 |
| beir/nfcorpus/test | 0.3145 | 0.3094 | 0.1575 | 0.5168 |

Recall operating point (latency below is measured here, the matched-recall rule for ANN search):

| Dataset | Knob | Value | ANN recall@k | Target met | Secondary value | Secondary recall |
|---|---|---|---|---|---|---|
| beir/scifact/test | ef_search | 64 | 0.9970 | yes | 16 | 0.9500 |
| beir/nfcorpus/test | ef_search | 128 | 0.9935 | yes | 64 | 0.9780 |

Operational metrics (latency at the operating point):

| Dataset | Docs | Ingest docs/s | Build s | Index size | p50 ms | p95 ms | p99 ms |
|---|---|---|---|---|---|---|---|
| beir/scifact/test | 5183 | 1328 | 3.90 | 23.7 MB | 1.18 | 1.89 | 4.55 |
| beir/nfcorpus/test | 3633 | 1261 | 2.88 | 16.8 MB | 1.04 | 1.49 | 3.09 |

## Hybrid track

- Setup: BM25 match fused with knn via a hybrid query and an RRF search pipeline
- Fusion: score-ranker-processor RRF (rank_constant=60)

Retrieval quality vs human judgements:

| Dataset | nDCG@10 | Recall@100 | MAP | MRR |
|---|---|---|---|---|
| beir/scifact/test | 0.7053 | 0.9610 | 0.6587 | 0.6643 |
| beir/nfcorpus/test | 0.3517 | 0.3213 | 0.1867 | 0.5633 |

Operational metrics:

| Dataset | Docs | Ingest docs/s | Build s | Index size | p50 ms | p95 ms | p99 ms |
|---|---|---|---|---|---|---|---|
| beir/scifact/test | 5183 | 1327 | 3.91 | 23.7 MB | 2.05 | 3.94 | 7.42 |
| beir/nfcorpus/test | 3633 | 1644 | 2.21 | 16.8 MB | 1.32 | 1.62 | 2.12 |
