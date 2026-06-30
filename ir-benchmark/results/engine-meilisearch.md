# meilisearch retrieval (keyword)

## Environment

- Captured: 2026-06-29T15:36:18.911561+00:00
- Machine: Apple M3 Pro
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

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | Index size | Server p50 ms | Server p95 ms | Server p99 ms |
|---|---|---|---|---|---|---|---|
| beir/scifact/test | 5183 | 1739 | 2.98 | n/a | 0.00 | 2.00 | 3.00 |
| beir/nfcorpus/test | 3633 | 1937 | 1.88 | n/a | 0.00 | 1.00 | 1.00 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
|---|---|---|---|
| beir/scifact/test | 1.35 | 2.85 | 3.80 |
| beir/nfcorpus/test | 0.80 | 1.46 | 1.89 |

Server-side time source per dataset:

- beir/scifact/test: response `processingTimeMs` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- beir/nfcorpus/test: response `processingTimeMs` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
