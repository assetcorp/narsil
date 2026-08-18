# typesense retrieval (keyword)

## Environment

- Captured: 2026-08-04T19:24:54.242299+00:00
- Machine: GCP c3-standard-8, us-central1-a
- OS / arch: Linux 6.17.0-1021-gcp / x86_64 (containerized: True)
- CPU: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical)
- Memory: 33.6 GB
- Memory cap per engine: 8.6 GB
- Tracks: keyword
- Keyword setup: Not BM25; the harness creates the text field with locale `en` and `stem` enabled, sorts by `_text_match`, and leaves every other setting at its default
- Run depth: 1000; run tag: typesense_textmatch
- Engine build: version 30.2
- Engine image: typesense/typesense@sha256:610f2d34b1f93d00762869da2c67736775e5798d19a2c8b91b014b8a0cc1e110
- Dataset beir/scifact/test: content md5 5f7d1de60b170fc8027bb7898e2efca1
- Dataset beir/nfcorpus/test: content md5 a89dba18a62ef92f7d323ec890a0d38d

## Keyword track

Retrieval quality vs Anserini BM25 reference:

| Dataset | nDCG@10 | Reference | Delta | Status | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 0.3728 | 0.6790 | -0.3062 | outside margin | 0.3923 | 0.3659 | 0.3784 |
| beir/nfcorpus/test | 0.1817 | 0.3220 | -0.1403 | outside margin | 0.1123 | 0.0839 | 0.3372 |

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | Index size | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 2224 | 2.33 | n/a | 20.00 | 87.00 | 118.00 |
| beir/nfcorpus/test | 3633 | 2083 | 1.74 | n/a | 0.00 | 7.00 | 16.00 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 22.13 | 88.99 | 120.12 |
| beir/nfcorpus/test | 1.22 | 8.33 | 17.46 |

Server-side time source per dataset:

- beir/scifact/test: response `search_time_ms` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- beir/nfcorpus/test: response `search_time_ms` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | QPS | Errors | Under-load p95 ms | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- |
| 16 | 189 | 0 | 244.21 | 15.3 | no |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | QPS | Errors | Under-load p95 ms | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- |
| 16 | 852 | 0 | 35.34 | 15.9 | no |
