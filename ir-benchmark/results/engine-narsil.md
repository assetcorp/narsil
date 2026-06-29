# narsil retrieval (keyword, vector, hybrid)

## Environment

- Captured: 2026-06-29T10:31:26.423743+00:00
- Machine: Apple M3 Pro, macOS 26.5.1
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

Operational metrics:

| Dataset | Docs | Ingest docs/s | Build s | Index size | p50 ms | p95 ms | p99 ms |
|---|---|---|---|---|---|---|---|
| beir/scifact/test | 5183 | 5687 | 0.91 | 17.8 MB | 0.81 | 1.33 | 1.66 |
| beir/nfcorpus/test | 3633 | 6125 | 0.59 | 13.3 MB | 0.41 | 0.77 | 0.97 |

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
| beir/nfcorpus/test | efSearch | 128 | 0.9944 | yes | 32 | 0.9567 |

Operational metrics (latency at the operating point):

| Dataset | Docs | Ingest docs/s | Build s | Index size | p50 ms | p95 ms | p99 ms |
|---|---|---|---|---|---|---|---|
| beir/scifact/test | 5183 | 635 | 8.16 | 33.9 MB | 2.66 | 3.38 | 4.60 |
| beir/nfcorpus/test | 3633 | 640 | 5.68 | 24.6 MB | 3.10 | 5.26 | 10.99 |

## Hybrid track

- Setup: BM25 (text) fused with HNSW vector search via Reciprocal Rank Fusion
- Fusion: RRF (k=60)

Retrieval quality vs human judgements:

| Dataset | nDCG@10 | Recall@100 | MAP | MRR |
|---|---|---|---|---|
| beir/scifact/test | 0.7015 | 0.9643 | 0.6532 | 0.6596 |
| beir/nfcorpus/test | 0.3555 | 0.3239 | 0.1877 | 0.5727 |

Operational metrics:

| Dataset | Docs | Ingest docs/s | Build s | Index size | p50 ms | p95 ms | p99 ms |
|---|---|---|---|---|---|---|---|
| beir/scifact/test | 5183 | 604 | 8.58 | 33.9 MB | 3.41 | 4.46 | 6.74 |
| beir/nfcorpus/test | 3633 | 576 | 6.31 | 24.6 MB | 3.17 | 3.86 | 4.47 |
