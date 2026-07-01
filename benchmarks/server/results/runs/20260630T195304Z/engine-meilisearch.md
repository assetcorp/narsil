# meilisearch retrieval (keyword)

## Environment

- Captured: 2026-06-30T20:21:02.660020+00:00
- OS / arch: Linux 6.12.76-linuxkit / aarch64 (containerized: True)
- CPU: aarch64 (5 logical)
- Memory: 5.2 GB
- Memory cap per engine: 8.6 GB
- Tracks: keyword
- Keyword setup: Bucket-sort ranking rules (words, typo, proximity, attribute, sort, exactness), not BM25; _rankingScore for ordering; default typo tolerance and prefix search; no stemming or stop-word removal
- Run depth: 1000; run tag: meilisearch_rankrules
- Engine build: version 1.48.2, commit 96d2d029e40b
- Engine image: getmeili/meilisearch@sha256:544bdb7d1934e2dbeb02225b65f9b813221bc045d567c241a5be7319b50122b6
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
| beir/scifact/test | 5183 | 1383 | 3.75 | n/a | 0.00 | 2.00 | 4.00 |
| beir/nfcorpus/test | 3633 | 1695 | 2.14 | n/a | 0.00 | 1.00 | 1.00 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 1.42 | 3.35 | 4.98 |
| beir/nfcorpus/test | 0.87 | 1.56 | 2.04 |

Server-side time source per dataset:

- beir/scifact/test: response `processingTimeMs` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- beir/nfcorpus/test: response `processingTimeMs` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | QPS | Errors | Under-load p95 ms | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- |
| 16 | 1443 | 0 | 19.86 | 15.9 | no |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | QPS | Errors | Under-load p95 ms | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- |
| 16 | 1789 | 0 | 16.40 | 15.9 | no |
