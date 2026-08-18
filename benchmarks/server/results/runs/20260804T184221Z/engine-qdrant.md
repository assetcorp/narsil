# qdrant retrieval (vector, hybrid)

## Environment

- Captured: 2026-08-04T19:18:15.639389+00:00
- Machine: GCP c3-standard-8, us-central1-a
- OS / arch: Linux 6.17.0-1021-gcp / x86_64 (containerized: True)
- CPU: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical)
- Memory: 33.6 GB
- Memory cap per engine: 8.6 GB
- Tracks: vector, hybrid
- Keyword setup: None
- Run depth: 1000; run tag: qdrant
- Engine build: version 1.18.3, commit db8fa43fcb6a
- Engine image: qdrant/qdrant@sha256:0bd98fa7977f1e75694779359ca4e212822e5a71334e28421182f72f209d5286
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
| beir/scifact/test | hnsw_ef | 32 | 0.9937 | yes | 16 | 0.9743 |
| beir/nfcorpus/test | hnsw_ef | 128 | 0.9969 | yes | 32 | 0.9737 |

Latency is measured at the operating point.

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | Index size | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 907 | 5.72 | n/a | 0.28 | 0.32 | 0.34 |
| beir/nfcorpus/test | 3633 | 913 | 3.98 | n/a | 0.36 | 0.43 | 0.45 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 1.37 | 1.59 | 1.75 |
| beir/nfcorpus/test | 1.51 | 1.74 | 1.90 |

Server-side time source per dataset:

- beir/scifact/test: top-level `time` field, seconds converted to ms (floating-millisecond resolution)
- beir/nfcorpus/test: top-level `time` field, seconds converted to ms (floating-millisecond resolution)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | QPS | Errors | Under-load p95 ms | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- |
| 16 | 698 | 0 | 42.60 | 15.9 | no |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | QPS | Errors | Under-load p95 ms | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- |
| 16 | 703 | 0 | 41.35 | 15.9 | no |

## Hybrid track

- Setup: Dense HNSW fused with BM25 sparse vectors (fastembed Qdrant/bm25, server IDF) via RRF
- Fusion: RRF (Query API fusion)

Retrieval quality vs human judgements:

| Dataset | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| beir/scifact/test | 0.7155 | 0.9577 | 0.6730 | 0.6762 |
| beir/nfcorpus/test | 0.3515 | 0.3239 | 0.1826 | 0.5686 |

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | Index size | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 1004 | 5.16 | n/a | 0.38 | 0.43 | 0.45 |
| beir/nfcorpus/test | 3633 | 929 | 3.91 | n/a | 0.41 | 0.47 | 0.49 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 1.66 | 1.87 | 2.03 |
| beir/nfcorpus/test | 1.67 | 1.83 | 1.97 |

Server-side time source per dataset:

- beir/scifact/test: top-level `time` field, seconds converted to ms (floating-millisecond resolution)
- beir/nfcorpus/test: top-level `time` field, seconds converted to ms (floating-millisecond resolution)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | QPS | Errors | Under-load p95 ms | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- |
| 16 | 668 | 0 | 43.93 | 15.9 | no |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | QPS | Errors | Under-load p95 ms | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- |
| 16 | 683 | 0 | 42.87 | 15.9 | no |
