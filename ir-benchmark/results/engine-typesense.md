# typesense retrieval (keyword)

## Environment

- Captured: 2026-06-29T15:35:20.081998+00:00
- Machine: Apple M3 Pro
- OS / arch: Linux 6.12.76-linuxkit / aarch64 (containerized: True)
- CPU: aarch64 (7 logical)
- Memory: 9.4 GB
- Memory cap per engine: 8.6 GB
- Tracks: keyword
- Keyword setup: Native token match/proximity scoring (text_match), not BM25; english locale, Snowball stemming enabled, default typo tolerance
- Run depth: 1000; run tag: typesense_textmatch

## Keyword track

Retrieval quality vs Anserini BM25 reference:

| Dataset | nDCG@10 | Reference | Delta | Status | Recall@100 | MAP | MRR |
|---|---|---|---|---|---|---|---|
| beir/scifact/test | 0.3728 | 0.6790 | -0.3062 | outside margin | 0.3923 | 0.3659 | 0.3784 |
| beir/nfcorpus/test | 0.1817 | 0.3220 | -0.1403 | outside margin | 0.1123 | 0.0839 | 0.3372 |

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | Index size | Server p50 ms | Server p95 ms | Server p99 ms |
|---|---|---|---|---|---|---|---|
| beir/scifact/test | 5183 | 3086 | 1.68 | n/a | 11.00 | 50.00 | 72.00 |
| beir/nfcorpus/test | 3633 | 3854 | 0.94 | n/a | 0.00 | 3.00 | 8.00 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
|---|---|---|---|
| beir/scifact/test | 11.74 | 50.67 | 73.28 |
| beir/nfcorpus/test | 0.55 | 4.37 | 9.46 |

Server-side time source per dataset:

- beir/scifact/test: response `search_time_ms` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- beir/nfcorpus/test: response `search_time_ms` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
