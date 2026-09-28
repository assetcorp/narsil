# weaviate retrieval (vector, hybrid)

## Environment

- Captured: 2026-09-28T00:30:59.370287+00:00
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
- Index setup: HNSW dense vectors, distance cosine, over the shared precomputed vectors
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
| beir/scifact/test | ef | 64 | 0.9967 | yes | 32 | 0.9827 |
| beir/nfcorpus/test | ef | 192 | 0.9957 | yes | 64 | 0.9709 |
| dbpedia-entities-openai-100k | ef | 192 | 0.9931 | yes | 32 | 0.9519 |
| dbpedia-entities-openai-1m | ef | 512 | 0.9942 | yes | 64 | 0.9542 |

Latency is measured at the operating point.

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | Index size | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 1426 | 3.63 | n/a | n/a | n/a | n/a |
| beir/nfcorpus/test | 3633 | 1217 | 2.98 | n/a | n/a | n/a | n/a |
| dbpedia-entities-openai-100k | 100000 | 574 | 174.10 | n/a | n/a | n/a | n/a |
| dbpedia-entities-openai-1m | 995000 | 550 | 1810.05 | n/a | n/a | n/a | n/a |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 3.19 | 4.02 | 6.86 |
| beir/nfcorpus/test | 3.32 | 4.23 | 6.23 |
| dbpedia-entities-openai-100k | 9.44 | 10.66 | 13.03 |
| dbpedia-entities-openai-1m | 13.70 | 15.67 | 16.95 |

Server-side time source per dataset:

- beir/scifact/test: client round-trip only (no server-side query time exposed)
- beir/nfcorpus/test: client round-trip only (no server-side query time exposed)
- dbpedia-entities-openai-100k: client round-trip only (no server-side query time exposed)
- dbpedia-entities-openai-1m: client round-trip only (no server-side query time exposed)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 297 | n/a | 0 | 4.04 | 9.65 | 1.13 | 1.0 | no |
| 2 | 1 | 545 | n/a | 0 | 5.60 | 10.01 | 2.10 | 2.0 | no |
| 4 | 1 | 918 | n/a | 0 | 6.74 | 8.63 | 3.60 | 4.0 | no |
| 8 | 1 | 1182 | n/a | 0 | 11.05 | 17.02 | 5.27 | 8.0 | no |
| 16 | 3 | 1233 | 1222 to 1234 | 0 | 24.56 | 41.97 | 5.60 | 15.9 | no |
| 32 | 1 | 1213 | n/a | 0 | 60.44 | 163.77 | 5.62 | 31.7 | no |
| 64 | 1 | 1196 | n/a | 0 | 170.63 | 489.77 | 5.62 | 62.8 | no |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 286 | n/a | 0 | 4.23 | 6.94 | 1.08 | 1.0 | no |
| 2 | 1 | 530 | n/a | 0 | 5.87 | 7.41 | 1.98 | 2.0 | no |
| 4 | 1 | 873 | n/a | 0 | 7.08 | 8.86 | 3.65 | 4.0 | no |
| 8 | 1 | 1132 | n/a | 0 | 11.78 | 16.56 | 5.38 | 8.0 | no |
| 16 | 3 | 1172 | 1169 to 1172 | 0 | 25.87 | 44.99 | 5.70 | 15.9 | no |
| 32 | 1 | 1162 | n/a | 0 | 61.77 | 165.67 | 5.72 | 31.7 | no |
| 64 | 1 | 1146 | n/a | 0 | 200.06 | 534.55 | 5.72 | 62.4 | no |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 104 | n/a | 0 | 10.89 | 15.33 | 0.92 | 1.0 | no |
| 2 | 1 | 195 | n/a | 0 | 13.72 | 19.01 | 1.78 | 2.0 | no |
| 4 | 1 | 336 | n/a | 0 | 14.79 | 20.52 | 3.45 | 4.0 | no |
| 8 | 3 | 467 | 467 to 469 | 0 | 23.73 | 37.69 | 5.91 | 8.0 | no |
| 16 | 1 | 466 | n/a | 0 | 61.39 | 95.35 | 6.13 | 15.8 | no |
| 32 | 1 | 455 | n/a | 0 | 119.90 | 315.00 | 6.15 | 31.4 | no |
| 64 | 1 | 445 | n/a | 0 | 269.76 | 690.46 | 6.08 | 60.9 | no |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 79 | n/a | 0 | 14.54 | 21.39 | 0.88 | 1.0 | no |
| 2 | 1 | 148 | n/a | 0 | 18.16 | 20.81 | 1.70 | 2.0 | no |
| 4 | 1 | 266 | n/a | 0 | 19.20 | 29.09 | 3.47 | 4.0 | no |
| 8 | 1 | 370 | n/a | 0 | 28.96 | 46.17 | 6.18 | 8.0 | no |
| 16 | 3 | 362 | 359 to 371 | 0 | 72.89 | 138.53 | 6.37 | 15.8 | no |
| 32 | 1 | 368 | n/a | 0 | 140.58 | 287.20 | 6.48 | 31.3 | no |
| 64 | 1 | 358 | n/a | 0 | 270.95 | 404.82 | 6.45 | 60.8 | no |

## Hybrid track

- Setup: BM25 k1=0.9 b=0.4 over text fused with dense vectors via the hybrid operator (rankedFusion, alpha=0.5)
- Fusion: rankedFusion (alpha=0.5)

Retrieval quality vs human judgements:

| Dataset | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| beir/scifact/test | 0.6803 | 0.9577 | 0.6316 | 0.6410 |
| beir/nfcorpus/test | 0.3425 | 0.3195 | 0.1808 | 0.5548 |
| dbpedia-entities-openai-100k | n/a | n/a | n/a | n/a |
| dbpedia-entities-openai-1m | n/a | n/a | n/a | n/a |

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | Index size | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 1467 | 3.53 | n/a | n/a | n/a | n/a |
| beir/nfcorpus/test | 3633 | 1245 | 2.92 | n/a | n/a | n/a | n/a |
| dbpedia-entities-openai-100k | 100000 | 579 | 172.63 | n/a | n/a | n/a | n/a |
| dbpedia-entities-openai-1m | 995000 | 548 | 1816.34 | n/a | n/a | n/a | n/a |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 4.13 | 5.87 | 9.50 |
| beir/nfcorpus/test | 4.05 | 5.99 | 9.37 |
| dbpedia-entities-openai-100k | 10.16 | 11.06 | 13.51 |
| dbpedia-entities-openai-1m | 16.17 | 33.04 | 41.59 |

Server-side time source per dataset:

- beir/scifact/test: client round-trip only (no server-side query time exposed)
- beir/nfcorpus/test: client round-trip only (no server-side query time exposed)
- dbpedia-entities-openai-100k: client round-trip only (no server-side query time exposed)
- dbpedia-entities-openai-1m: client round-trip only (no server-side query time exposed)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 228 | n/a | 0 | 5.95 | 10.99 | 1.99 | 1.0 | no |
| 2 | 1 | 386 | n/a | 0 | 8.62 | 12.04 | 3.48 | 2.0 | no |
| 4 | 1 | 563 | n/a | 0 | 11.64 | 16.23 | 5.34 | 4.0 | no |
| 8 | 1 | 662 | n/a | 0 | 19.26 | 31.79 | 6.54 | 8.0 | no |
| 16 | 3 | 679 | 670 to 680 | 0 | 43.50 | 81.24 | 6.53 | 15.9 | no |
| 32 | 1 | 670 | n/a | 0 | 102.00 | 212.38 | 6.51 | 31.6 | no |
| 64 | 1 | 661 | n/a | 0 | 268.49 | 611.30 | 6.52 | 61.7 | no |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 234 | n/a | 0 | 5.10 | 11.55 | 1.83 | 1.0 | no |
| 2 | 1 | 401 | n/a | 0 | 8.29 | 12.52 | 3.29 | 2.0 | no |
| 4 | 1 | 599 | n/a | 0 | 11.08 | 15.48 | 5.15 | 4.0 | no |
| 8 | 1 | 726 | n/a | 0 | 18.44 | 30.23 | 6.34 | 8.0 | no |
| 16 | 1 | 755 | n/a | 0 | 44.62 | 85.86 | 6.49 | 15.9 | no |
| 32 | 3 | 766 | 765 to 767 | 0 | 97.11 | 239.57 | 6.37 | 31.5 | no |
| 64 | 1 | 753 | n/a | 0 | 266.32 | 626.38 | 6.35 | 61.8 | no |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 98 | n/a | 0 | 10.76 | 17.35 | 1.12 | 1.0 | no |
| 2 | 1 | 178 | n/a | 0 | 14.04 | 17.56 | 2.12 | 2.0 | no |
| 4 | 1 | 301 | n/a | 0 | 15.55 | 21.85 | 4.07 | 4.0 | no |
| 8 | 1 | 399 | n/a | 0 | 27.57 | 43.30 | 6.21 | 8.0 | no |
| 16 | 3 | 396 | 395 to 402 | 0 | 71.94 | 126.63 | 6.31 | 15.8 | no |
| 32 | 1 | 397 | n/a | 0 | 134.19 | 401.72 | 6.30 | 31.3 | no |
| 64 | 1 | 381 | n/a | 0 | 495.99 | 994.35 | 6.43 | 58.8 | no |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 67 | n/a | 0 | 16.81 | 18.45 | 1.20 | 1.0 | no |
| 2 | 1 | 135 | n/a | 0 | 18.25 | 29.93 | 2.45 | 2.0 | no |
| 4 | 1 | 232 | n/a | 0 | 20.70 | 40.37 | 4.44 | 4.0 | no |
| 8 | 1 | 297 | n/a | 0 | 37.55 | 63.43 | 6.55 | 7.9 | no |
| 16 | 3 | 307 | 301 to 307 | 0 | 85.00 | 138.71 | 6.69 | 15.8 | no |
| 32 | 1 | 295 | n/a | 0 | 171.09 | 688.31 | 6.67 | 30.5 | no |
| 64 | 1 | 290 | n/a | 0 | 352.51 | 573.80 | 6.72 | 58.7 | no |
