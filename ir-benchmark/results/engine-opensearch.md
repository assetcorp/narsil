# opensearch keyword retrieval

## Environment

- Captured: 2026-06-29T01:08:25.427665+00:00
- OS / arch: Linux 6.12.76-linuxkit / aarch64 (containerized: True)
- CPU: aarch64 (7 logical)
- Memory: 9.4 GB
- Memory cap per engine: 8.6 GB
- Keyword setup: BM25 k1=0.9 b=0.4 (custom default similarity, native Lucene BM25Similarity in 3.x); OpenSearch `english` analyzer (Porter stemmer, English stop words)
- Run depth: 1000; run tag: opensearch_bm25

## Retrieval quality vs Anserini BM25 reference

| Dataset | nDCG@10 | Reference | Delta | Status | Recall@100 | MAP | MRR |
|---|---|---|---|---|---|---|---|
| beir/scifact/test | 0.6789 | 0.6790 | -0.0001 | within margin | 0.9253 | 0.6401 | 0.6506 |
| beir/nfcorpus/test | 0.3206 | 0.3220 | -0.0014 | within margin | 0.2457 | 0.1503 | 0.5255 |

## Operational metrics

| Dataset | Docs | Ingest docs/s | Build s | Index size | p50 ms | p95 ms | p99 ms |
|---|---|---|---|---|---|---|---|
| beir/scifact/test | 5183 | 6989 | 0.74 | 7.0 MB | 0.89 | 1.39 | 2.11 |
| beir/nfcorpus/test | 3633 | 9683 | 0.38 | 5.1 MB | 0.61 | 0.79 | 0.94 |
