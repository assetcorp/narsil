# meilisearch retrieval (keyword)

## Environment

- Captured: 2026-09-28T00:34:03.950784+00:00
- Machine: GCP c3-standard-8, us-west1-a
- OS / arch: Linux 7.0.0-1011-gcp / x86_64 (containerized: True)
- CPU: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical)
- Memory: 33.6 GB
- Memory cap per engine: 21.5 GB
- Tracks: keyword
- Keyword setup: Not BM25; the harness sets `searchableAttributes` to the text field, sets `stopWords` to the Lucene English list the BM25 engines analyze with, searches with `matchingStrategy` `frequency` so a long question drops its commonest words first, reads `_rankingScore` as the score, and leaves every other setting at its default
- Run depth: 1000; run tag: meilisearch_rankrules
- Engine build: version 1.54.0, commit 1380adaaceba
- Engine image: getmeili/meilisearch@sha256:0bf32debcbfa8ba4e418679025f4935884972171513c92f0584689ff994a61df
- Dataset beir/scifact/test: content md5 5f7d1de60b170fc8027bb7898e2efca1
- Dataset beir/nfcorpus/test: content md5 a89dba18a62ef92f7d323ec890a0d38d

## Keyword track

Retrieval quality vs Anserini BM25 reference:

| Dataset | nDCG@10 | Reference | Delta | Status | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 0.5018 | 0.6790 | -0.1772 | outside margin | 0.5982 | 0.4809 | 0.4889 |
| beir/nfcorpus/test | 0.2671 | 0.3220 | -0.0549 | outside margin | 0.1553 | 0.1221 | 0.4443 |
| dbpedia-entities-openai-100k | n/a | n/a | n/a | no baseline | n/a | n/a | n/a |
| dbpedia-entities-openai-1m | n/a | n/a | n/a | no baseline | n/a | n/a | n/a |

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | Index size | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 1430 | 3.63 | n/a | 1.00 | 3.00 | 6.00 |
| beir/nfcorpus/test | 3633 | 1462 | 2.49 | n/a | 0.00 | 1.00 | 2.00 |
| dbpedia-entities-openai-100k | 100000 | 4536 | 22.05 | n/a | 1.00 | 2.00 | 3.00 |
| dbpedia-entities-openai-1m | 995000 | 479 | 2078.10 | n/a | 3.00 | 8.00 | 11.00 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 2.74 | 4.26 | 7.33 |
| beir/nfcorpus/test | 1.83 | 2.77 | 3.41 |
| dbpedia-entities-openai-100k | 2.14 | 3.49 | 4.41 |
| dbpedia-entities-openai-1m | 3.89 | 9.18 | 12.35 |

Server-side time source per dataset:

- beir/scifact/test: response `processingTimeMs` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- beir/nfcorpus/test: response `processingTimeMs` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- dbpedia-entities-openai-100k: response `processingTimeMs` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- dbpedia-entities-openai-1m: response `processingTimeMs` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 359 | n/a | 0 | 4.14 | 7.97 | 0.80 | 1.0 | no |
| 2 | 1 | 639 | n/a | 0 | 4.59 | 10.06 | 1.56 | 2.0 | no |
| 4 | 1 | 1102 | n/a | 0 | 5.33 | 10.41 | 3.08 | 4.0 | no |
| 8 | 1 | 1521 | n/a | 0 | 7.98 | 16.05 | 4.87 | 8.0 | no |
| 16 | 3 | 1559 | 1551 to 1565 | 0 | 16.60 | 41.20 | 5.45 | 15.9 | no |
| 32 | 1 | 1557 | n/a | 0 | 28.48 | 58.52 | 5.43 | 31.8 | no |
| 64 | 1 | 1506 | n/a | 0 | 50.40 | 99.92 | 5.36 | 63.1 | no |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 588 | n/a | 0 | 2.51 | 3.42 | 0.66 | 1.0 | no |
| 2 | 1 | 1015 | n/a | 0 | 2.85 | 4.04 | 1.29 | 2.0 | no |
| 4 | 1 | 1737 | n/a | 0 | 3.33 | 4.62 | 2.54 | 4.0 | no |
| 8 | 1 | 2300 | n/a | 0 | 5.23 | 8.04 | 3.71 | 8.0 | no |
| 16 | 3 | 2428 | 2419 to 2463 | 0 | 10.59 | 29.64 | 4.15 | 16.0 | no |
| 32 | 1 | 2429 | n/a | 0 | 19.63 | 38.44 | 4.18 | 31.9 | no |
| 64 | 1 | 2377 | n/a | 0 | 46.15 | 83.38 | 3.68 | 63.4 | no |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 468 | n/a | 0 | 3.37 | 5.26 | 0.72 | 1.0 | no |
| 2 | 1 | 849 | n/a | 0 | 3.70 | 6.08 | 1.41 | 2.0 | no |
| 4 | 1 | 1460 | n/a | 0 | 4.31 | 6.98 | 2.77 | 4.0 | no |
| 8 | 1 | 1959 | n/a | 0 | 6.49 | 10.91 | 4.22 | 8.0 | no |
| 16 | 1 | 2034 | n/a | 0 | 12.83 | 34.51 | 4.74 | 16.0 | no |
| 32 | 3 | 2039 | 2037 to 2044 | 0 | 22.59 | 51.57 | 4.72 | 31.8 | no |
| 64 | 1 | 1936 | n/a | 0 | 40.51 | 75.57 | 4.75 | 63.2 | no |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 232 | n/a | 0 | 8.55 | 12.98 | 0.85 | 1.0 | no |
| 2 | 1 | 456 | n/a | 0 | 8.42 | 13.84 | 1.68 | 2.0 | no |
| 4 | 1 | 788 | n/a | 0 | 10.22 | 18.68 | 3.34 | 4.0 | no |
| 8 | 1 | 1105 | n/a | 0 | 13.41 | 22.23 | 5.59 | 8.0 | no |
| 16 | 1 | 1123 | n/a | 0 | 26.04 | 44.98 | 6.04 | 15.9 | no |
| 32 | 1 | 1117 | n/a | 0 | 43.99 | 66.39 | 5.99 | 31.7 | no |
| 64 | 3 | 1144 | 1134 to 1149 | 0 | 70.97 | 101.63 | 5.91 | 62.7 | no |
