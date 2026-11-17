# meilisearch retrieval (keyword)

## Environment

- Captured: 2026-11-17T07:53:48.747416+00:00
- Load machine: GCP c3-standard-8, us-south1-b
- OS / arch: Linux 7.0.0-1017-gcp / x86_64 (containerized: True)
- CPU: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical)
- Memory: 33.6 GB
- Engine machine label: GCP c3-standard-8, us-south1-b
- Engine machine: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical), 33.6 GB
- Network round trip to the engine machine: p50 0.088 ms, p99 0.141 ms over 200 TCP connects
- Memory cap per engine: 21.5 GB
- Tracks: keyword
- Keyword setup: Not BM25; the harness sets `searchableAttributes` to the text field, sets `stopWords` to the Lucene English list the BM25 engines analyze with, searches with `matchingStrategy` `frequency` so a long question drops its commonest words first, reads `_rankingScore` as the score, and leaves every other setting at its default
- Run depth: 1000; run tag: meilisearch_rankrules
- Engine build: version 1.57.0, commit 1b782653f25c
- Engine image: getmeili/meilisearch@sha256:91bf09897482c17205c8faeca8daa8d57999fb9de20d862763cdfa92ba4ec790
- Dataset beir/scifact/test: content md5 5f7d1de60b170fc8027bb7898e2efca1
- Dataset beir/nfcorpus/test: content md5 a89dba18a62ef92f7d323ec890a0d38d

## Keyword track

Retrieval quality vs Anserini BM25 reference:

| Dataset | nDCG@10 | Reference | Delta | Status | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 0.5019 | 0.6790 | -0.1771 | outside margin | 0.5982 | 0.4823 | 0.4903 |
| beir/nfcorpus/test | 0.2654 | 0.3220 | -0.0566 | outside margin | 0.1554 | 0.1214 | 0.4415 |
| dbpedia-entities-openai-100k | n/a | n/a | n/a | no baseline | n/a | n/a | n/a |
| dbpedia-entities-openai-1m | n/a | n/a | n/a | no baseline | n/a | n/a | n/a |

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | On disk | Peak heap | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 1450 | 3.57 | n/a | 0.49 GB | 1.00 | 3.00 | 5.00 |
| beir/nfcorpus/test | 3633 | 1463 | 2.48 | n/a | 0.67 GB | 0.00 | 1.00 | 2.00 |
| dbpedia-entities-openai-100k | 100000 | 4584 | 21.82 | n/a | 0.96 GB | 1.00 | 2.00 | 3.00 |
| dbpedia-entities-openai-1m | 995000 | 458 | 2170.64 | n/a | 1.72 GB | 3.00 | 8.00 | 11.00 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 2.70 | 4.20 | 7.37 |
| beir/nfcorpus/test | 1.66 | 2.61 | 3.25 |
| dbpedia-entities-openai-100k | 2.04 | 3.39 | 4.25 |
| dbpedia-entities-openai-1m | 3.89 | 9.06 | 12.15 |

Engine container memory through the whole track, load included (anonymous memory is the heap the kernel cannot reclaim; charged memory adds the page cache of the engine's files):

| Dataset | Peak anonymous | Peak charged | Samples |
| --- | --- | --- | --- |
| beir/scifact/test | 0.49 GB | 0.50 GB | 311 |
| beir/nfcorpus/test | 0.67 GB | 0.72 GB | 307 |
| dbpedia-entities-openai-100k | 0.96 GB | 1.42 GB | 471 |
| dbpedia-entities-openai-1m | 1.72 GB | 8.35 GB | 9064 |

Server-side time source per dataset:

- beir/scifact/test: response `processingTimeMs` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- beir/nfcorpus/test: response `processingTimeMs` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- dbpedia-entities-openai-100k: response `processingTimeMs` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- dbpedia-entities-openai-1m: response `processingTimeMs` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 358 | n/a | 0 | 4.13 | 8.10 | 0.79 | 1.0 | no |
| 2 | 1 | 671 | n/a | 0 | 4.40 | 8.37 | 1.58 | 2.0 | no |
| 4 | 1 | 1176 | n/a | 0 | 5.09 | 10.50 | 3.17 | 4.0 | no |
| 8 | 1 | 1859 | n/a | 0 | 6.42 | 12.91 | 5.78 | 8.0 | no |
| 16 | 3 | 2067 | 2060 to 2071 | 0 | 12.55 | 27.60 | 6.86 | 16.0 | no |
| 32 | 1 | 2047 | n/a | 0 | 21.42 | 35.49 | 6.87 | 31.8 | no |
| 64 | 1 | 2019 | n/a | 0 | 37.12 | 52.45 | 6.81 | 63.3 | no |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 601 | n/a | 0 | 2.47 | 3.72 | 0.65 | 1.0 | no |
| 2 | 1 | 1107 | n/a | 0 | 2.66 | 3.85 | 1.33 | 2.0 | no |
| 4 | 1 | 1992 | n/a | 0 | 2.96 | 4.35 | 2.75 | 4.0 | no |
| 8 | 1 | 2939 | n/a | 0 | 3.98 | 6.02 | 4.51 | 8.0 | no |
| 16 | 3 | 3429 | 3428 to 3455 | 0 | 7.11 | 11.88 | 5.65 | 16.0 | yes |
| 32 | 1 | 3448 | n/a | 0 | 14.03 | 36.57 | 5.47 | 31.9 | yes |
| 64 | 1 | 3091 | n/a | 0 | 34.03 | 61.07 | 4.79 | 63.5 | yes |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 489 | n/a | 0 | 3.21 | 5.29 | 0.71 | 1.0 | no |
| 2 | 1 | 899 | n/a | 0 | 3.48 | 5.51 | 1.44 | 2.0 | no |
| 4 | 1 | 1586 | n/a | 0 | 3.99 | 6.91 | 2.88 | 4.0 | no |
| 8 | 1 | 2469 | n/a | 0 | 5.07 | 8.50 | 5.12 | 8.0 | no |
| 16 | 1 | 2933 | n/a | 0 | 8.83 | 23.83 | 6.40 | 16.0 | no |
| 32 | 3 | 2916 | 2908 to 2935 | 0 | 15.51 | 32.49 | 6.62 | 31.9 | no |
| 64 | 1 | 2847 | n/a | 0 | 27.40 | 51.40 | 6.55 | 63.5 | no |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 242 | n/a | 0 | 8.16 | 12.62 | 0.85 | 1.0 | no |
| 2 | 1 | 453 | n/a | 0 | 8.93 | 15.36 | 1.71 | 2.0 | no |
| 4 | 1 | 829 | n/a | 0 | 9.85 | 16.84 | 3.41 | 4.0 | no |
| 8 | 1 | 1276 | n/a | 0 | 12.34 | 21.53 | 6.25 | 8.0 | no |
| 16 | 1 | 1399 | n/a | 0 | 22.00 | 34.87 | 7.21 | 15.9 | no |
| 32 | 3 | 1408 | 1405 to 1409 | 0 | 36.20 | 59.87 | 7.22 | 31.8 | no |
| 64 | 1 | 1403 | n/a | 0 | 58.24 | 74.69 | 7.14 | 63.1 | no |
