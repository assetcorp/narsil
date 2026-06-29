# meilisearch retrieval (keyword)

## Environment

- Captured: 2026-06-29T10:42:28.834615+00:00
- Machine: Apple M3 Pro, macOS 26.5.1
- OS / arch: Linux 6.12.76-linuxkit / aarch64 (containerized: True)
- CPU: aarch64 (7 logical)
- Memory: 9.4 GB
- Memory cap per engine: 8.6 GB
- Tracks: keyword
- Keyword setup: Bucket-sort ranking rules (words, typo, proximity, attribute, sort, exactness), not BM25; _rankingScore for ordering; default typo tolerance and prefix search; no stemming or stop-word removal
- Run depth: 1000; run tag: meilisearch_rankrules

## Keyword track

Retrieval quality vs Anserini BM25 reference:

| Dataset | nDCG@10 | Reference | Delta | Status | Recall@100 | MAP | MRR |
|---|---|---|---|---|---|---|---|
| beir/scifact/test | 0.3748 | 0.6790 | -0.3042 | outside margin | 0.5302 | 0.3467 | 0.3534 |
| beir/nfcorpus/test | 0.2550 | 0.3220 | -0.0670 | outside margin | 0.1701 | 0.1167 | 0.4338 |

Operational metrics:

| Dataset | Docs | Ingest docs/s | Build s | Index size | p50 ms | p95 ms | p99 ms |
|---|---|---|---|---|---|---|---|
| beir/scifact/test | 5183 | 1766 | 2.94 | n/a | 1.43 | 3.19 | 3.99 |
| beir/nfcorpus/test | 3633 | 1912 | 1.90 | n/a | 0.85 | 1.57 | 2.03 |
