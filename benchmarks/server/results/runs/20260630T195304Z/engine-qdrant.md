# qdrant retrieval (vector, hybrid)

## Environment

- Captured: 2026-06-30T20:13:17.229973+00:00
- OS / arch: Linux 6.12.76-linuxkit / aarch64 (containerized: True)
- CPU: aarch64 (5 logical)
- Memory: 5.2 GB
- Memory cap per engine: 8.6 GB
- Tracks: vector, hybrid
- Keyword setup: None
- Run depth: 1000; run tag: qdrant
- Engine build: version 1.18.2, commit 44ad62f8cd69
- Engine image: qdrant/qdrant@sha256:75eab8c4ba42096724fdcfde8b4de0b5713d529dde32f285a1f86fdcb2c9e50c
- Dataset beir/scifact/test: content md5 5f7d1de60b170fc8027bb7898e2efca1
- Dataset beir/nfcorpus/test: content md5 a89dba18a62ef92f7d323ec890a0d38d

## Vector track

- Embedding model: sentence-transformers/all-MiniLM-L6-v2 (384 dim, cosine)
- Index setup: HNSW dense vectors, distance Cosine, over the shared precomputed vectors
- Operating point: search knob tuned to ann_recall@10 >= 0.99 against exact kNN over the same vectors

Retrieval quality vs human judgements:

| Dataset | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| beir/scifact/test | 0.6239 | 0.9227 | 0.5797 | 0.5849 |
| beir/nfcorpus/test | 0.3145 | 0.3094 | 0.1575 | 0.5168 |

Recall operating point (latency below is measured here, the matched-recall rule for ANN search):

| Dataset | Knob | Value | ANN recall@k | Target met | Secondary value | Secondary recall |
| --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | hnsw_ef | 64 | 0.9970 | yes | 32 | 0.9863 |
| beir/nfcorpus/test | hnsw_ef | 128 | 0.9947 | yes | 64 | 0.9820 |

Latency is measured at the operating point.

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | Index size | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 780 | 6.65 | n/a | 0.23 | 0.36 | 0.59 |
| beir/nfcorpus/test | 3633 | 1569 | 2.32 | n/a | 0.28 | 0.52 | 1.06 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 0.73 | 1.05 | 1.79 |
| beir/nfcorpus/test | 0.83 | 1.47 | 3.34 |

Server-side time source per dataset:

- beir/scifact/test: top-level `time` field (seconds, converted to ms) (floating-millisecond resolution)
- beir/nfcorpus/test: top-level `time` field (seconds, converted to ms) (floating-millisecond resolution)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | QPS | Errors | Under-load p95 ms | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- |
| 16 | 1604 | 0 | 17.73 | 16.0 | no |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | QPS | Errors | Under-load p95 ms | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- |
| 16 | 1147 | 1 (0.0%) | 34.43 | 15.8 | no |

## Hybrid track

- Setup: Dense HNSW fused with BM25 sparse vectors (fastembed Qdrant/bm25, server IDF) via RRF
- Fusion: RRF (Query API fusion)

Retrieval quality vs human judgements:

| Dataset | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| beir/scifact/test | 0.7155 | 0.9577 | 0.6730 | 0.6762 |
| beir/nfcorpus/test | 0.3512 | 0.3241 | 0.1825 | 0.5670 |

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | Index size | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 1654 | 3.13 | n/a | 0.32 | 0.47 | 0.64 |
| beir/nfcorpus/test | 3633 | 612 | 5.93 | n/a | 0.37 | 0.97 | 1.93 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 0.93 | 1.30 | 1.68 |
| beir/nfcorpus/test | 1.03 | 2.83 | 5.24 |

Server-side time source per dataset:

- beir/scifact/test: top-level `time` field (seconds, converted to ms) (floating-millisecond resolution)
- beir/nfcorpus/test: top-level `time` field (seconds, converted to ms) (floating-millisecond resolution)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | QPS | Errors | Under-load p95 ms | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- |
| 16 | 1477 | 0 | 19.32 | 15.9 | no |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | QPS | Errors | Under-load p95 ms | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- |
| 16 | 1024 | 0 | 31.27 | 15.7 | no |
