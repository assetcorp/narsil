# qdrant retrieval (vector, hybrid, best-config vector profile)

## Environment

- Captured: 2026-08-04T19:19:29.884983+00:00
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
- Index setup: HNSW dense vectors with int8 scalar quantization and full-precision rescore (oversampling 2.0x), distance Cosine, over the shared precomputed vectors
- Operating point: search knob tuned to ann_recall@10 >= 0.99 against exact kNN over the same vectors

Retrieval quality vs human judgements:

| Dataset | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| beir/scifact/test | 0.6239 | 0.9227 | 0.5797 | 0.5849 |
| beir/nfcorpus/test | 0.3145 | 0.3094 | 0.1575 | 0.5168 |

Recall operating point (latency below is measured here, the matched-recall rule for ANN search):

| Dataset | Knob | Value | ANN recall@k | Target met | Secondary value | Secondary recall |
| --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | hnsw_ef | 32 | 0.9930 | yes | 16 | 0.9853 |
| beir/nfcorpus/test | hnsw_ef | 64 | 0.9916 | yes | 32 | 0.9721 |

Latency is measured at the operating point.

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | Index size | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 915 | 5.67 | n/a | 0.24 | 0.28 | 0.31 |
| beir/nfcorpus/test | 3633 | 917 | 3.96 | n/a | 0.26 | 0.30 | 0.33 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 1.30 | 1.48 | 1.57 |
| beir/nfcorpus/test | 1.35 | 1.55 | 1.68 |

Server-side time source per dataset:

- beir/scifact/test: top-level `time` field, seconds converted to ms (floating-millisecond resolution)
- beir/nfcorpus/test: top-level `time` field, seconds converted to ms (floating-millisecond resolution)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | QPS | Errors | Under-load p95 ms | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- |
| 16 | 740 | 0 | 39.18 | 15.9 | no |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | QPS | Errors | Under-load p95 ms | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- |
| 16 | 770 | 0 | 36.47 | 15.9 | no |

## Hybrid track

- Setup: int8-quantized dense HNSW (full-precision rescore) fused with BM25 sparse vectors (fastembed Qdrant/bm25, server IDF) via RRF
- Fusion: RRF (Query API fusion)

Retrieval quality vs human judgements:

| Dataset | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| beir/scifact/test | 0.7155 | 0.9577 | 0.6730 | 0.6762 |
| beir/nfcorpus/test | 0.3507 | 0.3241 | 0.1823 | 0.5650 |

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | Index size | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 1016 | 5.10 | n/a | 0.32 | 0.37 | 0.40 |
| beir/nfcorpus/test | 3633 | 918 | 3.96 | n/a | 0.32 | 0.37 | 0.39 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 1.60 | 1.81 | 1.96 |
| beir/nfcorpus/test | 1.57 | 1.73 | 1.89 |

Server-side time source per dataset:

- beir/scifact/test: top-level `time` field, seconds converted to ms (floating-millisecond resolution)
- beir/nfcorpus/test: top-level `time` field, seconds converted to ms (floating-millisecond resolution)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | QPS | Errors | Under-load p95 ms | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- |
| 16 | 685 | 0 | 41.49 | 15.9 | no |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | QPS | Errors | Under-load p95 ms | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- |
| 16 | 698 | 0 | 41.81 | 15.9 | no |
