# typesense retrieval (keyword)

## Environment

- Captured: 2026-06-29T10:41:28.730600+00:00
- Machine: Apple M3 Pro, macOS 26.5.1
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

Operational metrics:

| Dataset | Docs | Ingest docs/s | Build s | Index size | p50 ms | p95 ms | p99 ms |
|---|---|---|---|---|---|---|---|
| beir/scifact/test | 5183 | 3964 | 1.31 | n/a | 12.18 | 52.74 | 75.10 |
| beir/nfcorpus/test | 3633 | 3399 | 1.07 | n/a | 0.60 | 4.65 | 9.75 |
