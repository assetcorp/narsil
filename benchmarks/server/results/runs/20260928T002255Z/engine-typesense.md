# typesense retrieval (keyword)

## Environment

- Captured: 2026-09-28T00:31:10.581342+00:00
- Machine: GCP c3-standard-8, us-east1-b
- OS / arch: Linux 7.0.0-1011-gcp / x86_64 (containerized: True)
- CPU: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical)
- Memory: 33.6 GB
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
| beir/scifact/test | 0.5407 | 0.6790 | -0.1383 | outside margin | 0.7501 | 0.5081 | 0.5191 |
| beir/nfcorpus/test | 0.2237 | 0.3220 | -0.0983 | outside margin | 0.2075 | 0.1101 | 0.3868 |
| dbpedia-entities-openai-100k | n/a | n/a | n/a | no baseline | n/a | n/a | n/a |
| dbpedia-entities-openai-1m | n/a | n/a | n/a | no baseline | n/a | n/a | n/a |

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | Index size | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 2075 | 2.50 | n/a | 12.00 | 45.00 | 63.00 |
| beir/nfcorpus/test | 3633 | 1890 | 1.92 | n/a | 0.00 | 5.00 | 9.00 |
| dbpedia-entities-openai-100k | 100000 | 8765 | 11.41 | n/a | 0.00 | 10.00 | 18.00 |
| dbpedia-entities-openai-1m | 995000 | 7456 | 133.45 | n/a | 2.00 | 25.00 | 48.00 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 13.80 | 47.03 | 64.54 |
| beir/nfcorpus/test | 1.41 | 6.39 | 10.47 |
| dbpedia-entities-openai-100k | 1.76 | 11.63 | 19.17 |
| dbpedia-entities-openai-1m | 3.27 | 26.68 | 49.01 |

Server-side time source per dataset:

- beir/scifact/test: response `search_time_ms` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- beir/nfcorpus/test: response `search_time_ms` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- dbpedia-entities-openai-100k: response `search_time_ms` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- dbpedia-entities-openai-1m: response `search_time_ms` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 58 | n/a | 0 | 47.36 | 80.12 | 0.96 | 1.0 | no |
| 2 | 1 | 110 | n/a | 0 | 48.40 | 78.25 | 1.91 | 2.0 | no |
| 4 | 1 | 196 | n/a | 0 | 56.93 | 93.10 | 3.79 | 3.9 | no |
| 8 | 1 | 263 | n/a | 0 | 76.75 | 143.10 | 6.54 | 7.9 | no |
| 16 | 1 | 301 | n/a | 0 | 136.06 | 269.07 | 7.41 | 15.5 | no |
| 32 | 3 | 331 | 331 to 333 | 0 | 271.06 | 572.10 | 7.47 | 30.3 | no |
| 64 | 1 | 308 | n/a | 0 | 558.45 | 976.01 | 7.48 | 57.8 | no |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 441 | n/a | 0 | 6.40 | 19.22 | 0.70 | 1.0 | no |
| 2 | 1 | 801 | n/a | 0 | 7.06 | 20.06 | 1.39 | 2.0 | no |
| 4 | 1 | 1416 | n/a | 0 | 7.73 | 22.55 | 2.71 | 4.0 | no |
| 8 | 1 | 1880 | n/a | 0 | 11.09 | 33.66 | 4.07 | 8.0 | no |
| 16 | 1 | 1948 | n/a | 0 | 19.79 | 52.82 | 4.49 | 15.9 | no |
| 32 | 1 | 1977 | n/a | 0 | 35.59 | 94.16 | 4.61 | 31.7 | no |
| 64 | 3 | 2376 | 2365 to 2379 | 0 | 49.89 | 92.05 | 3.22 | 63.3 | no |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 416 | n/a | 0 | 6.84 | 25.96 | 0.72 | 1.0 | no |
| 2 | 1 | 807 | n/a | 0 | 6.86 | 26.08 | 1.37 | 2.0 | no |
| 4 | 1 | 1358 | n/a | 0 | 8.28 | 33.80 | 2.76 | 4.0 | no |
| 8 | 1 | 1816 | n/a | 0 | 11.08 | 45.61 | 4.23 | 7.9 | no |
| 16 | 1 | 1875 | n/a | 0 | 19.18 | 61.01 | 4.96 | 15.6 | no |
| 32 | 3 | 1908 | 1906 to 1913 | 0 | 36.75 | 113.80 | 5.32 | 31.8 | no |
| 64 | 1 | 1834 | n/a | 0 | 62.81 | 128.53 | 5.35 | 63.1 | no |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 187 | n/a | 0 | 19.01 | 79.71 | 0.87 | 1.0 | no |
| 2 | 1 | 353 | n/a | 0 | 21.73 | 85.98 | 1.71 | 2.0 | no |
| 4 | 1 | 638 | n/a | 0 | 24.15 | 81.23 | 3.41 | 4.0 | no |
| 8 | 1 | 869 | n/a | 0 | 31.94 | 100.88 | 5.66 | 7.9 | no |
| 16 | 1 | 941 | n/a | 0 | 57.95 | 230.75 | 6.47 | 15.5 | no |
| 32 | 1 | 1413 | n/a | 0 | 58.86 | 210.00 | 5.95 | 31.4 | no |
| 64 | 3 | 1782 | 1782 to 1798 | 0 | 62.54 | 120.82 | 5.44 | 62.8 | no |
