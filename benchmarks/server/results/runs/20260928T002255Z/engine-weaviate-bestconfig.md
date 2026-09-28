# weaviate retrieval (vector, hybrid, best-config vector profile)

## Environment

- Captured: 2026-09-28T02:01:33.650954+00:00
- Machine: GCP c3-standard-8, us-east1-b
- OS / arch: Linux 7.0.0-1011-gcp / x86_64 (containerized: True)
- CPU: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical)
- Memory: 33.6 GB
- Memory cap per engine: 21.5 GB
- Tracks: vector, hybrid
- Keyword setup: None
- Run depth: 1000; run tag: weaviate
- Engine build: version 1.39.5
- Engine image: cr.weaviate.io/semitechnologies/weaviate@sha256:c29b501d8fdab55d8b3fbe8c3db78e286ba0708536e7039d894d01a84ca6ba8b
- Dataset beir/scifact/test: content md5 5f7d1de60b170fc8027bb7898e2efca1
- Dataset beir/nfcorpus/test: content md5 a89dba18a62ef92f7d323ec890a0d38d

## Vector track

- Embedding model: sentence-transformers/all-MiniLM-L6-v2 (384 dim, cosine)
- Index setup: HNSW dense vectors with 8-bit Rotational Quantization and full-precision rescore, distance cosine, over the shared precomputed vectors
- Operating point: search knob tuned to ann_recall@10 >= 0.99 against exact kNN over the same vectors

Retrieval quality vs human judgements:

| Dataset | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| beir/scifact/test | 0.6239 | 0.9227 | 0.5797 | 0.5849 |
| beir/nfcorpus/test | 0.3145 | 0.3094 | 0.1575 | 0.5168 |
| dbpedia-entities-openai-100k | n/a | n/a | n/a | n/a |
| dbpedia-entities-openai-1m | n/a | n/a | n/a | n/a |

Recall operating point (latency below is measured here, the matched-recall rule for ANN search):

| Dataset | Knob | Value | ANN recall@k | Target met | Secondary value | Secondary recall |
| --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | ef | 64 | 0.9957 | yes | 32 | 0.9823 |
| beir/nfcorpus/test | ef | 128 | 0.9920 | yes | 64 | 0.9724 |
| dbpedia-entities-openai-100k | ef | 192 | 0.9927 | yes | 32 | 0.9505 |
| dbpedia-entities-openai-1m | ef | 384 | 0.9922 | yes | 64 | 0.9583 |

Latency is measured at the operating point.

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | Index size | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 1731 | 2.99 | n/a | n/a | n/a | n/a |
| beir/nfcorpus/test | 3633 | 1238 | 2.94 | n/a | n/a | n/a | n/a |
| dbpedia-entities-openai-100k | 100000 | 595 | 168.12 | n/a | n/a | n/a | n/a |
| dbpedia-entities-openai-1m | 995000 | 584 | 1704.03 | n/a | n/a | n/a | n/a |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 3.26 | 4.16 | 6.94 |
| beir/nfcorpus/test | 3.33 | 4.24 | 7.32 |
| dbpedia-entities-openai-100k | 8.96 | 10.36 | 14.26 |
| dbpedia-entities-openai-1m | 10.84 | 12.06 | 13.65 |

Server-side time source per dataset:

- beir/scifact/test: client round-trip only (no server-side query time exposed)
- beir/nfcorpus/test: client round-trip only (no server-side query time exposed)
- dbpedia-entities-openai-100k: client round-trip only (no server-side query time exposed)
- dbpedia-entities-openai-1m: client round-trip only (no server-side query time exposed)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 288 | n/a | 0 | 4.14 | 10.61 | 1.32 | 1.0 | no |
| 2 | 1 | 520 | n/a | 0 | 6.28 | 11.64 | 2.45 | 2.0 | no |
| 4 | 1 | 860 | n/a | 0 | 7.12 | 9.39 | 4.10 | 4.0 | no |
| 8 | 1 | 1104 | n/a | 0 | 11.99 | 16.85 | 5.49 | 8.0 | no |
| 16 | 3 | 1139 | 1135 to 1141 | 0 | 27.54 | 47.28 | 5.69 | 15.9 | no |
| 32 | 1 | 1137 | n/a | 0 | 66.92 | 162.30 | 5.71 | 31.6 | no |
| 64 | 1 | 1127 | n/a | 0 | 194.80 | 423.11 | 5.70 | 62.8 | no |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 283 | n/a | 0 | 4.41 | 9.45 | 1.28 | 1.0 | no |
| 2 | 1 | 516 | n/a | 0 | 5.91 | 7.54 | 2.35 | 2.0 | no |
| 4 | 1 | 843 | n/a | 0 | 7.22 | 9.10 | 4.12 | 4.0 | no |
| 8 | 1 | 1085 | n/a | 0 | 11.94 | 17.58 | 5.51 | 8.0 | no |
| 16 | 1 | 1122 | n/a | 0 | 26.99 | 48.61 | 5.73 | 15.9 | no |
| 32 | 3 | 1119 | 1117 to 1124 | 0 | 71.80 | 168.79 | 5.76 | 31.7 | no |
| 64 | 1 | 1106 | n/a | 0 | 194.46 | 509.74 | 5.74 | 62.6 | no |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 109 | n/a | 0 | 10.47 | 15.88 | 1.02 | 1.0 | no |
| 2 | 1 | 199 | n/a | 0 | 13.60 | 18.77 | 1.94 | 2.0 | no |
| 4 | 1 | 340 | n/a | 0 | 16.80 | 22.80 | 3.72 | 4.0 | no |
| 8 | 3 | 451 | 450 to 454 | 0 | 27.29 | 41.67 | 5.93 | 8.0 | no |
| 16 | 1 | 446 | n/a | 0 | 64.51 | 102.81 | 6.03 | 15.8 | no |
| 32 | 1 | 436 | n/a | 0 | 152.56 | 284.69 | 6.19 | 31.4 | no |
| 64 | 1 | 429 | n/a | 0 | 354.63 | 742.99 | 6.24 | 61.3 | no |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 93 | n/a | 0 | 11.88 | 22.80 | 1.03 | 1.0 | no |
| 2 | 1 | 173 | n/a | 0 | 15.35 | 25.44 | 1.92 | 2.0 | no |
| 4 | 1 | 306 | n/a | 0 | 16.67 | 27.79 | 3.69 | 4.0 | no |
| 8 | 1 | 411 | n/a | 0 | 30.71 | 56.19 | 6.11 | 8.0 | no |
| 16 | 3 | 406 | 404 to 412 | 0 | 70.91 | 137.97 | 6.23 | 15.8 | no |
| 32 | 1 | 405 | n/a | 0 | 134.03 | 277.23 | 6.21 | 31.0 | no |
| 64 | 1 | 395 | n/a | 0 | 300.44 | 905.19 | 6.38 | 61.3 | no |

## Hybrid track

- Setup: BM25 over text fused with RQ-quantized dense vectors (full-precision rescore) via the hybrid operator (rankedFusion, alpha=0.5)
- Fusion: rankedFusion (alpha=0.5)

Retrieval quality vs human judgements:

| Dataset | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| beir/scifact/test | 0.6803 | 0.9577 | 0.6316 | 0.6410 |
| beir/nfcorpus/test | 0.3425 | 0.3193 | 0.1808 | 0.5534 |
| dbpedia-entities-openai-100k | n/a | n/a | n/a | n/a |
| dbpedia-entities-openai-1m | n/a | n/a | n/a | n/a |

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | Index size | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 1406 | 3.69 | n/a | n/a | n/a | n/a |
| beir/nfcorpus/test | 3633 | 1219 | 2.98 | n/a | n/a | n/a | n/a |
| dbpedia-entities-openai-100k | 100000 | 599 | 166.95 | n/a | n/a | n/a | n/a |
| dbpedia-entities-openai-1m | 995000 | 584 | 1703.95 | n/a | n/a | n/a | n/a |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 4.25 | 6.92 | 10.42 |
| beir/nfcorpus/test | 4.26 | 6.58 | 10.11 |
| dbpedia-entities-openai-100k | 9.95 | 11.23 | 16.99 |
| dbpedia-entities-openai-1m | 12.27 | 13.61 | 16.46 |

Server-side time source per dataset:

- beir/scifact/test: client round-trip only (no server-side query time exposed)
- beir/nfcorpus/test: client round-trip only (no server-side query time exposed)
- dbpedia-entities-openai-100k: client round-trip only (no server-side query time exposed)
- dbpedia-entities-openai-1m: client round-trip only (no server-side query time exposed)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 219 | n/a | 0 | 6.69 | 11.09 | 2.18 | 1.0 | no |
| 2 | 1 | 369 | n/a | 0 | 8.97 | 12.52 | 3.77 | 2.0 | no |
| 4 | 1 | 529 | n/a | 0 | 12.31 | 17.11 | 5.57 | 4.0 | no |
| 8 | 1 | 618 | n/a | 0 | 21.53 | 34.25 | 6.55 | 8.0 | no |
| 16 | 3 | 625 | 624 to 627 | 0 | 50.43 | 93.02 | 6.60 | 15.9 | no |
| 32 | 1 | 625 | n/a | 0 | 113.09 | 233.63 | 6.59 | 31.5 | no |
| 64 | 1 | 619 | n/a | 0 | 277.42 | 544.38 | 6.58 | 61.5 | no |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 220 | n/a | 0 | 6.74 | 11.85 | 2.02 | 1.0 | no |
| 2 | 1 | 378 | n/a | 0 | 8.78 | 13.11 | 3.53 | 2.0 | no |
| 4 | 1 | 559 | n/a | 0 | 11.72 | 16.30 | 5.37 | 4.0 | no |
| 8 | 1 | 677 | n/a | 0 | 20.16 | 34.92 | 6.40 | 8.0 | no |
| 16 | 3 | 709 | 708 to 713 | 0 | 45.33 | 79.33 | 6.38 | 15.9 | no |
| 32 | 1 | 706 | n/a | 0 | 102.93 | 209.29 | 6.40 | 31.6 | no |
| 64 | 1 | 704 | n/a | 0 | 279.00 | 586.04 | 6.39 | 62.3 | no |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 99 | n/a | 0 | 10.75 | 18.35 | 1.36 | 1.0 | no |
| 2 | 1 | 176 | n/a | 0 | 14.25 | 19.25 | 2.50 | 2.0 | no |
| 4 | 1 | 288 | n/a | 0 | 19.64 | 25.05 | 4.45 | 4.0 | no |
| 8 | 1 | 361 | n/a | 0 | 33.68 | 45.80 | 6.35 | 7.9 | no |
| 16 | 3 | 358 | 357 to 361 | 0 | 82.46 | 143.14 | 6.40 | 15.8 | no |
| 32 | 1 | 353 | n/a | 0 | 199.23 | 354.05 | 6.38 | 31.1 | no |
| 64 | 1 | 342 | n/a | 0 | 391.57 | 813.85 | 6.40 | 60.9 | no |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 82 | n/a | 0 | 13.59 | 31.46 | 1.71 | 1.0 | no |
| 2 | 1 | 149 | n/a | 0 | 15.90 | 33.26 | 2.95 | 2.0 | no |
| 4 | 1 | 241 | n/a | 0 | 20.42 | 37.12 | 4.97 | 4.0 | no |
| 8 | 1 | 291 | n/a | 0 | 41.00 | 79.19 | 6.59 | 7.8 | no |
| 16 | 3 | 291 | 290 to 294 | 0 | 96.91 | 239.67 | 6.73 | 15.8 | no |
| 32 | 1 | 285 | n/a | 0 | 180.06 | 366.23 | 6.76 | 30.4 | no |
| 64 | 1 | 285 | n/a | 0 | 386.34 | 860.07 | 6.81 | 60.2 | no |
