# narsil keyword retrieval

## Environment

- Captured: 2026-06-29T01:00:27.491420+00:00
- OS / arch: Linux 6.12.76-linuxkit / aarch64 (containerized: True)
- CPU: aarch64 (7 logical)
- Memory: 9.4 GB
- Memory cap per engine: 8.6 GB
- Keyword setup: BM25 k1=0.9 b=0.4; Narsil english analyzer (Porter stemmer, 70-word stop list)
- Run depth: 1000; run tag: narsil_bm25

## Retrieval quality vs Anserini BM25 reference

| Dataset | nDCG@10 | Reference | Delta | Status | Recall@100 | MAP | MRR |
|---|---|---|---|---|---|---|---|
| beir/scifact/test | 0.6614 | 0.6790 | -0.0176 | within margin | 0.9098 | 0.6223 | 0.6290 |
| beir/nfcorpus/test | 0.3112 | 0.3220 | -0.0108 | within margin | 0.2364 | 0.1394 | 0.5133 |

## Operational metrics

| Dataset | Docs | Ingest docs/s | Build s | Index size | p50 ms | p95 ms | p99 ms |
|---|---|---|---|---|---|---|---|
| beir/scifact/test | 5183 | 4037 | 1.28 | 20.0 MB | 2.09 | 6.31 | 11.06 |
| beir/nfcorpus/test | 3633 | 3768 | 0.96 | 14.5 MB | 0.54 | 1.81 | 2.69 |
