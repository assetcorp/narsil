# meilisearch retrieval (keyword)

## Environment

- Captured: 2026-06-29T02:27:26.159181+00:00
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
| beir/nfcorpus/test | 0.2550 | 0.3220 | -0.0670 | outside margin | 0.1701 | 0.1167 | 0.4338 |

Operational metrics:

| Dataset | Docs | Ingest docs/s | Build s | Index size | p50 ms | p95 ms | p99 ms |
|---|---|---|---|---|---|---|---|
| beir/nfcorpus/test | 3633 | 1917 | 1.90 | n/a | 0.87 | 1.65 | 2.09 |
