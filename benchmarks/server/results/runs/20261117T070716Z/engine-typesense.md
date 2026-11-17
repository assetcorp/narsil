# typesense retrieval (keyword)

## Environment

- Captured: 2026-11-17T08:03:50.176508+00:00
- Load machine: GCP c3-standard-8, us-west2-a
- OS / arch: Linux 7.0.0-1017-gcp / x86_64 (containerized: True)
- CPU: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical)
- Memory: 33.6 GB
- Engine machine label: GCP c3-standard-8, us-west2-a
- Engine machine: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical), 33.6 GB
- Network round trip to the engine machine: p50 0.080 ms, p99 0.141 ms over 200 TCP connects
- Memory cap per engine: 21.5 GB
- Tracks: keyword
- Keyword setup: Not BM25; the harness creates the text field with locale `en` and `stem` enabled, applies the Lucene English stop words the BM25 engines analyze with, sets `drop_tokens_threshold` to the number of results requested so a long question drops words until that many documents match, sorts by `_text_match`, and leaves every other setting at its default
- Run depth: 1000; run tag: typesense_textmatch
- Engine build: version 30.2
- Engine image: typesense/typesense@sha256:610f2d34b1f93d00762869da2c67736775e5798d19a2c8b91b014b8a0cc1e110
- Dataset beir/scifact/test: content md5 5f7d1de60b170fc8027bb7898e2efca1
- Dataset beir/nfcorpus/test: content md5 a89dba18a62ef92f7d323ec890a0d38d

## Keyword track

Retrieval quality vs Anserini BM25 reference:

| Dataset | nDCG@10 | Reference | Delta | Status | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 0.5503 | 0.6790 | -0.1287 | outside margin | 0.7508 | 0.5164 | 0.5280 |
| beir/nfcorpus/test | 0.2420 | 0.3220 | -0.0800 | outside margin | 0.2089 | 0.1171 | 0.4242 |
| dbpedia-entities-openai-100k | n/a | n/a | n/a | no baseline | n/a | n/a | n/a |
| dbpedia-entities-openai-1m | n/a | n/a | n/a | no baseline | n/a | n/a | n/a |

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | On disk | Peak heap | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 2108 | 2.46 | n/a | 0.21 GB | 12.00 | 45.00 | 63.00 |
| beir/nfcorpus/test | 3633 | 1931 | 1.88 | n/a | 0.25 GB | 0.00 | 5.00 | 9.00 |
| dbpedia-entities-openai-100k | 100000 | 8973 | 11.14 | n/a | 0.28 GB | 0.00 | 10.00 | 17.00 |
| dbpedia-entities-openai-1m | 995000 | 7557 | 131.67 | n/a | 0.64 GB | 2.00 | 25.00 | 48.00 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 13.65 | 46.60 | 64.41 |
| beir/nfcorpus/test | 1.39 | 6.38 | 10.44 |
| dbpedia-entities-openai-100k | 1.75 | 11.56 | 18.87 |
| dbpedia-entities-openai-1m | 3.29 | 26.99 | 49.58 |

Engine container memory through the whole track, load included (anonymous memory is the heap the kernel cannot reclaim; charged memory adds the page cache of the engine's files):

| Dataset | Peak anonymous | Peak charged | Samples |
| --- | --- | --- | --- |
| beir/scifact/test | 0.21 GB | 0.24 GB | 458 |
| beir/nfcorpus/test | 0.25 GB | 0.28 GB | 300 |
| dbpedia-entities-openai-100k | 0.28 GB | 0.43 GB | 451 |
| dbpedia-entities-openai-1m | 0.64 GB | 1.96 GB | 1051 |

Server-side time source per dataset:

- beir/scifact/test: response `search_time_ms` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- beir/nfcorpus/test: response `search_time_ms` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- dbpedia-entities-openai-100k: response `search_time_ms` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- dbpedia-entities-openai-1m: response `search_time_ms` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 58 | n/a | 0 | 47.20 | 77.67 | 0.96 | 1.0 | no |
| 2 | 1 | 115 | n/a | 0 | 46.76 | 77.50 | 1.91 | 2.0 | no |
| 4 | 1 | 203 | n/a | 0 | 52.43 | 90.30 | 3.82 | 4.0 | no |
| 8 | 1 | 277 | n/a | 0 | 75.30 | 142.56 | 6.92 | 7.9 | no |
| 16 | 1 | 313 | n/a | 0 | 131.76 | 271.48 | 7.87 | 15.6 | no |
| 32 | 3 | 347 | 344 to 348 | 0 | 260.99 | 496.13 | 7.93 | 30.3 | no |
| 64 | 1 | 328 | n/a | 0 | 503.96 | 933.61 | 7.94 | 58.7 | no |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 443 | n/a | 0 | 6.41 | 19.12 | 0.69 | 1.0 | no |
| 2 | 1 | 825 | n/a | 0 | 7.01 | 21.02 | 1.40 | 2.0 | no |
| 4 | 1 | 1557 | n/a | 0 | 7.40 | 22.85 | 2.79 | 4.0 | no |
| 8 | 1 | 2359 | n/a | 0 | 9.44 | 28.91 | 4.78 | 8.0 | no |
| 16 | 1 | 2462 | n/a | 0 | 16.32 | 45.86 | 5.41 | 16.0 | no |
| 32 | 1 | 2382 | n/a | 0 | 32.14 | 81.55 | 5.82 | 31.9 | no |
| 64 | 3 | 2777 | 2754 to 2800 | 0 | 41.00 | 76.43 | 4.03 | 63.1 | yes |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 420 | n/a | 0 | 6.76 | 26.05 | 0.70 | 1.0 | no |
| 2 | 1 | 807 | n/a | 0 | 6.83 | 27.36 | 1.37 | 2.0 | no |
| 4 | 1 | 1496 | n/a | 0 | 7.75 | 35.08 | 2.74 | 4.0 | no |
| 8 | 1 | 2340 | n/a | 0 | 9.49 | 39.56 | 5.09 | 8.0 | no |
| 16 | 1 | 2645 | n/a | 0 | 13.85 | 106.04 | 6.16 | 15.9 | no |
| 32 | 3 | 2821 | 2808 to 2823 | 0 | 24.74 | 94.84 | 7.07 | 31.9 | no |
| 64 | 1 | 2623 | n/a | 0 | 45.32 | 124.19 | 7.33 | 63.3 | no |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 186 | n/a | 0 | 19.96 | 80.01 | 0.87 | 1.0 | no |
| 2 | 1 | 363 | n/a | 0 | 21.06 | 79.93 | 1.71 | 2.0 | no |
| 4 | 1 | 656 | n/a | 0 | 23.80 | 81.38 | 3.46 | 3.9 | no |
| 8 | 1 | 1061 | n/a | 0 | 26.61 | 98.68 | 6.33 | 8.0 | no |
| 16 | 1 | 1032 | n/a | 0 | 64.00 | 213.93 | 7.57 | 15.8 | no |
| 32 | 1 | 1472 | n/a | 0 | 68.10 | 413.87 | 7.66 | 30.4 | no |
| 64 | 3 | 2140 | 2136 to 2141 | 0 | 60.91 | 230.92 | 7.62 | 62.5 | no |
