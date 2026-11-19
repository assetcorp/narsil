# meilisearch retrieval (keyword)

## Environment

- Captured: 2026-11-19T13:59:10.990927+00:00
- Load machine: GCP c3-standard-8, us-south1-b
- OS / arch: Linux 7.0.0-1017-gcp / x86_64 (containerized: True)
- CPU: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical)
- Memory: 33.6 GB
- Engine machine label: GCP c3-standard-8, us-south1-b
- Engine machine: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical), 33.6 GB
- Network round trip to the engine machine: p50 0.079 ms, p99 0.161 ms over 200 TCP connects
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
| beir/scifact/test | 5183 | 1450 | 3.58 | n/a | 0.49 GB | 1.00 | 3.00 | 5.00 |
| beir/nfcorpus/test | 3633 | 1463 | 2.48 | n/a | 0.71 GB | 0.00 | 1.00 | 2.00 |
| dbpedia-entities-openai-100k | 100000 | 4660 | 21.46 | n/a | 0.93 GB | 1.00 | 2.00 | 3.00 |
| dbpedia-entities-openai-1m | 995000 | 461 | 2158.37 | n/a | 1.73 GB | 2.00 | 8.00 | 11.00 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 2.24 | 3.71 | 6.41 |
| beir/nfcorpus/test | 1.19 | 2.12 | 2.74 |
| dbpedia-entities-openai-100k | 1.67 | 3.02 | 3.92 |
| dbpedia-entities-openai-1m | 3.29 | 8.40 | 11.61 |

Engine container memory through the whole track, load included (anonymous memory is the heap the kernel cannot reclaim; charged memory adds the page cache of the engine's files):

| Dataset | Peak anonymous | Peak charged | Samples |
| --- | --- | --- | --- |
| beir/scifact/test | 0.49 GB | 0.50 GB | 343 |
| beir/nfcorpus/test | 0.71 GB | 0.76 GB | 329 |
| dbpedia-entities-openai-100k | 0.93 GB | 1.37 GB | 624 |
| dbpedia-entities-openai-1m | 1.73 GB | 8.37 GB | 9171 |

Server-side time source per dataset:

- beir/scifact/test: response `processingTimeMs` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- beir/nfcorpus/test: response `processingTimeMs` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- dbpedia-entities-openai-100k: response `processingTimeMs` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- dbpedia-entities-openai-1m: response `processingTimeMs` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 453 | n/a | 0 | 3.53 | 7.37 | 0.96 | 1.0 | no |
| 2 | 1 | 833 | n/a | 0 | 3.79 | 7.82 | 1.90 | 2.0 | no |
| 4 | 1 | 1409 | n/a | 0 | 4.57 | 10.56 | 3.83 | 4.0 | no |
| 8 | 1 | 2112 | n/a | 0 | 6.04 | 11.88 | 6.58 | 7.9 | no |
| 16 | 3 | 2124 | 2114 to 2174 | 0 | 12.90 | 22.83 | 6.95 | 15.9 | no |
| 32 | 1 | 2118 | n/a | 0 | 20.51 | 32.01 | 6.83 | 31.8 | no |
| 64 | 1 | 2064 | n/a | 0 | 36.54 | 44.19 | 6.74 | 63.4 | no |
| 128 | 1 | 1989 | n/a | 0 | 68.77 | 75.19 | 6.64 | 125.5 | no |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 785 | n/a | 0 | 2.12 | 3.31 | 0.91 | 1.0 | no |
| 2 | 1 | 1547 | n/a | 0 | 2.15 | 3.45 | 1.83 | 2.0 | no |
| 4 | 1 | 2700 | n/a | 0 | 2.45 | 3.70 | 3.70 | 3.9 | no |
| 8 | 1 | 3943 | n/a | 0 | 3.37 | 5.07 | 6.07 | 7.9 | no |
| 16 | 1 | 4143 | n/a | 0 | 6.54 | 10.50 | 6.50 | 15.8 | no |
| 32 | 1 | 4040 | n/a | 0 | 11.24 | 14.51 | 6.38 | 31.8 | no |
| 64 | 1 | 3991 | n/a | 0 | 20.45 | 24.38 | 6.30 | 63.6 | no |
| 128 | 3 | 4166 | 4156 to 4196 | 0 | 36.16 | 40.20 | 6.22 | 126.6 | no |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 642 | n/a | 0 | 2.74 | 4.43 | 0.93 | 1.0 | no |
| 2 | 1 | 1191 | n/a | 0 | 2.88 | 5.21 | 1.86 | 2.0 | no |
| 4 | 1 | 2057 | n/a | 0 | 3.41 | 6.13 | 3.76 | 3.9 | no |
| 8 | 1 | 3134 | n/a | 0 | 4.43 | 7.74 | 6.24 | 7.9 | no |
| 16 | 3 | 3206 | 3205 to 3237 | 0 | 8.71 | 14.57 | 6.65 | 15.9 | no |
| 32 | 1 | 3135 | n/a | 0 | 14.60 | 20.05 | 6.54 | 31.8 | no |
| 64 | 1 | 2827 | n/a | 0 | 26.72 | 32.67 | 6.52 | 63.5 | no |
| 128 | 1 | 3075 | n/a | 0 | 45.28 | 49.53 | 6.40 | 126.5 | no |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 277 | n/a | 0 | 7.76 | 15.96 | 0.97 | 1.0 | no |
| 2 | 1 | 546 | n/a | 0 | 7.91 | 15.55 | 1.93 | 2.0 | no |
| 4 | 1 | 957 | n/a | 0 | 9.25 | 17.50 | 3.87 | 4.0 | no |
| 8 | 1 | 1387 | n/a | 0 | 12.24 | 21.29 | 6.87 | 7.9 | no |
| 16 | 3 | 1387 | 1383 to 1414 | 0 | 22.81 | 38.63 | 7.28 | 15.9 | no |
| 32 | 1 | 1392 | n/a | 0 | 36.73 | 57.34 | 7.17 | 31.7 | no |
| 64 | 1 | 1352 | n/a | 0 | 59.20 | 76.25 | 7.11 | 63.0 | no |
| 128 | 1 | 1348 | n/a | 0 | 106.04 | 119.91 | 7.15 | 124.2 | no |
