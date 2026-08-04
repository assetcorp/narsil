# meilisearch retrieval (keyword)

## Environment

- Captured: 2026-08-04T19:26:51.228028+00:00
- Machine: GCP c3-standard-8, us-central1-a
- OS / arch: Linux 6.17.0-1021-gcp / x86_64 (containerized: True)
- CPU: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical)
- Memory: 33.6 GB
- Memory cap per engine: 8.6 GB
- Tracks: keyword
- Keyword setup: Not BM25; the harness sets `searchableAttributes` to the text field, reads `_rankingScore` as the score, and leaves every other setting at its default
- Run depth: 1000; run tag: meilisearch_rankrules
- Engine build: version 1.52.0, commit 5c2591ab8cc4
- Engine image: getmeili/meilisearch@sha256:d36e713e8f89483af1ab0d72011bbd503f5ab100b68ccbfad51c39e3f0a0567d
- Dataset beir/scifact/test: content md5 5f7d1de60b170fc8027bb7898e2efca1
- Dataset beir/nfcorpus/test: content md5 a89dba18a62ef92f7d323ec890a0d38d

## Keyword track

Retrieval quality vs Anserini BM25 reference:

| Dataset | nDCG@10 | Reference | Delta | Status | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 0.3748 | 0.6790 | -0.3042 | outside margin | 0.5302 | 0.3467 | 0.3534 |
| beir/nfcorpus/test | 0.2550 | 0.3220 | -0.0670 | outside margin | 0.1701 | 0.1167 | 0.4338 |

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | Index size | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 871 | 5.95 | n/a | 2.00 | 5.00 | 7.00 |
| beir/nfcorpus/test | 3633 | 1000 | 3.63 | n/a | 1.00 | 2.00 | 3.00 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 3.12 | 6.28 | 8.13 |
| beir/nfcorpus/test | 1.92 | 3.45 | 4.51 |

Server-side time source per dataset:

- beir/scifact/test: response `processingTimeMs` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- beir/nfcorpus/test: response `processingTimeMs` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | QPS | Errors | Under-load p95 ms | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- |
| 16 | 818 | 0 | 32.24 | 15.9 | no |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | QPS | Errors | Under-load p95 ms | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- |
| 16 | 893 | 0 | 30.91 | 15.9 | no |
