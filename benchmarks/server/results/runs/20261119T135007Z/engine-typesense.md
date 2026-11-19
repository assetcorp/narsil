# typesense retrieval (keyword)

## Environment

- Captured: 2026-11-19T14:00:16.070357+00:00
- Load machine: GCP c3-standard-8, us-west2-a
- OS / arch: Linux 7.0.0-1017-gcp / x86_64 (containerized: True)
- CPU: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical)
- Memory: 33.6 GB
- Engine machine label: GCP c3-standard-8, us-west2-a
- Engine machine: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical), 33.6 GB
- Network round trip to the engine machine: p50 0.077 ms, p99 0.148 ms over 200 TCP connects
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
| beir/scifact/test | 5183 | 2115 | 2.45 | n/a | 0.18 GB | 12.00 | 45.00 | 63.00 |
| beir/nfcorpus/test | 3633 | 1968 | 1.85 | n/a | 0.19 GB | 0.00 | 5.00 | 9.00 |
| dbpedia-entities-openai-100k | 100000 | 9098 | 10.99 | n/a | 0.29 GB | 0.00 | 10.00 | 18.00 |
| dbpedia-entities-openai-1m | 995000 | 7610 | 130.75 | n/a | 0.64 GB | 2.00 | 26.00 | 49.00 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 13.07 | 45.98 | 64.10 |
| beir/nfcorpus/test | 0.82 | 5.79 | 9.80 |
| dbpedia-entities-openai-100k | 1.20 | 11.13 | 18.60 |
| dbpedia-entities-openai-1m | 2.73 | 26.53 | 49.48 |

Engine container memory through the whole track, load included (anonymous memory is the heap the kernel cannot reclaim; charged memory adds the page cache of the engine's files):

| Dataset | Peak anonymous | Peak charged | Samples |
| --- | --- | --- | --- |
| beir/scifact/test | 0.18 GB | 0.21 GB | 503 |
| beir/nfcorpus/test | 0.19 GB | 0.23 GB | 461 |
| dbpedia-entities-openai-100k | 0.29 GB | 0.44 GB | 617 |
| dbpedia-entities-openai-1m | 0.64 GB | 1.96 GB | 1217 |

Server-side time source per dataset:

- beir/scifact/test: response `search_time_ms` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- beir/nfcorpus/test: response `search_time_ms` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- dbpedia-entities-openai-100k: response `search_time_ms` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- dbpedia-entities-openai-1m: response `search_time_ms` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 60 | n/a | 0 | 45.64 | 77.70 | 0.99 | 1.0 | no |
| 2 | 1 | 119 | n/a | 0 | 45.43 | 76.56 | 1.98 | 2.0 | no |
| 4 | 1 | 197 | n/a | 0 | 55.77 | 101.40 | 3.96 | 4.0 | no |
| 8 | 1 | 275 | n/a | 0 | 78.92 | 139.94 | 7.05 | 7.9 | no |
| 16 | 1 | 283 | n/a | 0 | 151.91 | 281.96 | 7.89 | 15.4 | no |
| 32 | 3 | 333 | 330 to 334 | 0 | 287.98 | 528.92 | 7.92 | 30.8 | no |
| 64 | 1 | 314 | n/a | 0 | 547.00 | 969.09 | 7.94 | 59.0 | no |
| 128 | 1 | 267 | n/a | 0 | 785.72 | 1282.96 | 7.93 | 112.1 | no |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 605 | n/a | 0 | 5.69 | 18.34 | 0.92 | 1.0 | no |
| 2 | 1 | 1157 | n/a | 0 | 6.21 | 20.08 | 1.84 | 1.9 | no |
| 4 | 1 | 2061 | n/a | 0 | 6.91 | 24.47 | 3.70 | 3.9 | no |
| 8 | 1 | 3009 | n/a | 0 | 9.26 | 31.27 | 6.36 | 7.8 | no |
| 16 | 1 | 3168 | n/a | 0 | 16.89 | 54.27 | 7.34 | 15.7 | no |
| 32 | 1 | 3169 | n/a | 0 | 33.90 | 114.00 | 7.71 | 31.5 | no |
| 64 | 1 | 3191 | n/a | 0 | 57.40 | 188.84 | 7.74 | 63.0 | no |
| 128 | 3 | 4355 | 4333 to 4364 | 0 | 72.80 | 247.92 | 7.64 | 124.7 | no |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 444 | n/a | 0 | 7.41 | 28.88 | 0.94 | 1.0 | no |
| 2 | 1 | 869 | n/a | 0 | 7.59 | 28.29 | 1.86 | 2.0 | no |
| 4 | 1 | 1653 | n/a | 0 | 8.34 | 30.18 | 3.74 | 3.9 | no |
| 8 | 1 | 2727 | n/a | 0 | 10.22 | 48.08 | 6.41 | 7.8 | no |
| 16 | 1 | 3165 | n/a | 0 | 14.99 | 73.46 | 7.19 | 15.7 | no |
| 32 | 3 | 3429 | 3426 to 3438 | 0 | 24.14 | 272.28 | 7.53 | 31.6 | no |
| 64 | 1 | 3326 | n/a | 0 | 36.91 | 126.37 | 7.50 | 62.9 | no |
| 128 | 1 | 3072 | n/a | 0 | 80.15 | 243.49 | 7.86 | 125.8 | no |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 184 | n/a | 0 | 21.79 | 79.74 | 0.97 | 1.0 | no |
| 2 | 1 | 362 | n/a | 0 | 23.43 | 79.51 | 1.94 | 2.0 | no |
| 4 | 1 | 675 | n/a | 0 | 24.90 | 102.10 | 3.89 | 3.9 | no |
| 8 | 1 | 972 | n/a | 0 | 32.60 | 172.50 | 6.83 | 7.9 | no |
| 16 | 1 | 938 | n/a | 0 | 67.78 | 223.34 | 7.81 | 15.8 | no |
| 32 | 1 | 505 | n/a | 0 | 262.47 | 418.22 | 7.95 | 31.3 | no |
| 64 | 1 | 447 | n/a | 0 | 570.73 | 825.99 | 7.95 | 57.0 | no |
| 128 | 3 | 1052 | 1048 to 1067 | 0 | 277.61 | 481.98 | 7.94 | 118.9 | no |
