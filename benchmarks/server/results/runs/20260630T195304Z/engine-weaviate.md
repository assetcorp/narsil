# weaviate retrieval (vector, hybrid)

## Environment

- Captured: 2026-06-30T20:14:45.732024+00:00
- OS / arch: Linux 6.12.76-linuxkit / aarch64 (containerized: True)
- CPU: aarch64 (5 logical)
- Memory: 5.2 GB
- Memory cap per engine: 8.6 GB
- Tracks: vector, hybrid
- Keyword setup: None
- Run depth: 1000; run tag: weaviate
- Engine build: version 1.38.2
- Engine image: cr.weaviate.io/semitechnologies/weaviate@sha256:107e8faae40ead5477fa6e2e86cc3da5a2d578d32d4586b4e23861d90eb3601c
- Dataset beir/scifact/test: content md5 5f7d1de60b170fc8027bb7898e2efca1
- Dataset beir/nfcorpus/test: content md5 a89dba18a62ef92f7d323ec890a0d38d

## Vector track

- Embedding model: sentence-transformers/all-MiniLM-L6-v2 (384 dim, cosine)
- Index setup: HNSW dense vectors, distance cosine, over the shared precomputed vectors
- Operating point: search knob tuned to ann_recall@10 >= 0.99 against exact kNN over the same vectors

Retrieval quality vs human judgements:

| Dataset | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| beir/scifact/test | 0.6239 | 0.9227 | 0.5797 | 0.5849 |
| beir/nfcorpus/test | 0.3145 | 0.3094 | 0.1575 | 0.5168 |

Recall operating point (latency below is measured here, the matched-recall rule for ANN search):

| Dataset | Knob | Value | ANN recall@k | Target met | Secondary value | Secondary recall |
| --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | ef | 64 | 0.9953 | yes | 32 | 0.9820 |
| beir/nfcorpus/test | ef | 128 | 0.9941 | yes | 64 | 0.9777 |

Latency is measured at the operating point.

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | Index size | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 416 | 12.45 | n/a | n/a | n/a | n/a |
| beir/nfcorpus/test | 3633 | 634 | 5.73 | n/a | n/a | n/a | n/a |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 6.55 | 15.29 | 24.80 |
| beir/nfcorpus/test | 7.50 | 18.47 | 42.81 |

Server-side time source per dataset:

- beir/scifact/test: client round-trip only (no server-side query time exposed)
- beir/nfcorpus/test: client round-trip only (no server-side query time exposed)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | QPS | Errors | Under-load p95 ms | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- |
| 16 | 209 | 0 | 183.69 | 15.6 | no |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | QPS | Errors | Under-load p95 ms | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- |
| 16 | 228 | 0 | 129.33 | 15.5 | no |

## Hybrid track

- Setup: BM25 over text fused with dense vectors via the hybrid operator (rankedFusion, alpha=0.5)
- Fusion: rankedFusion (alpha=0.5)

Retrieval quality vs human judgements:

| Dataset | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| beir/scifact/test | 0.6885 | 0.9577 | 0.6405 | 0.6513 |
| beir/nfcorpus/test | 0.3430 | 0.3180 | 0.1812 | 0.5600 |

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | Index size | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 362 | 14.31 | n/a | n/a | n/a | n/a |
| beir/nfcorpus/test | 3633 | 388 | 9.37 | n/a | n/a | n/a | n/a |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 10.91 | 36.31 | 74.08 |
| beir/nfcorpus/test | 3.72 | 9.43 | 16.10 |

Server-side time source per dataset:

- beir/scifact/test: client round-trip only (no server-side query time exposed)
- beir/nfcorpus/test: client round-trip only (no server-side query time exposed)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | QPS | Errors | Under-load p95 ms | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- |
| 16 | 182 | 0 | 181.36 | 15.5 | no |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | QPS | Errors | Under-load p95 ms | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- |
| 16 | 268 | 0 | 122.17 | 15.5 | no |
