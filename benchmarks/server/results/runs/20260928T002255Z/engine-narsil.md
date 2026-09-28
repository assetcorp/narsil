# narsil retrieval (keyword, vector, hybrid)

## Environment

- Captured: 2026-09-28T00:33:09.910612+00:00
- Machine: GCP c3-standard-8, us-central1-a
- OS / arch: Linux 7.0.0-1011-gcp / x86_64 (containerized: True)
- CPU: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical)
- Memory: 33.6 GB
- Memory cap per engine: 21.5 GB
- Tracks: keyword, vector, hybrid
- Keyword setup: BM25 k1=0.9 b=0.4; language english, as the server reports it
- Run depth: 1000; run tag: narsil_bm25
- Engine build: version 0.3.0, commit 5dc940c70724
- Engine image: ir-benchmark-narsil@sha256:d40eb43adc649bea4416db209b7d42029a2fd70eb3632a528cd601a11ec45302
- Dataset beir/scifact/test: content md5 5f7d1de60b170fc8027bb7898e2efca1
- Dataset beir/nfcorpus/test: content md5 a89dba18a62ef92f7d323ec890a0d38d

## Keyword track

Retrieval quality vs Anserini BM25 reference:

| Dataset | nDCG@10 | Reference | Delta | Status | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 0.6814 | 0.6790 | +0.0024 | within margin | 0.9253 | 0.6417 | 0.6494 |
| beir/nfcorpus/test | 0.3278 | 0.3220 | +0.0058 | within margin | 0.2489 | 0.1532 | 0.5305 |
| dbpedia-entities-openai-100k | n/a | n/a | n/a | no baseline | n/a | n/a | n/a |
| dbpedia-entities-openai-1m | n/a | n/a | n/a | no baseline | n/a | n/a | n/a |

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | Index size | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 6351 | 0.82 | 16.9 MB | 0.12 | 0.28 | 0.40 |
| beir/nfcorpus/test | 3633 | 7231 | 0.50 | 12.7 MB | 0.04 | 0.17 | 0.25 |
| dbpedia-entities-openai-100k | 100000 | 33179 | 3.01 | 84.8 MB | 0.12 | 0.64 | 1.09 |
| dbpedia-entities-openai-1m | 995000 | 33616 | 29.60 | 869.4 MB | 2.72 | 9.83 | 14.90 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 0.64 | 0.85 | 0.94 |
| beir/nfcorpus/test | 0.54 | 0.80 | 0.99 |
| dbpedia-entities-openai-100k | 0.77 | 1.48 | 2.16 |
| dbpedia-entities-openai-1m | 3.67 | 11.28 | 18.11 |

Server-side time source per dataset:

- beir/scifact/test: response `elapsed` field (floating-millisecond resolution)
- beir/nfcorpus/test: response `elapsed` field (floating-millisecond resolution)
- dbpedia-entities-openai-100k: response `elapsed` field (floating-millisecond resolution)
- dbpedia-entities-openai-1m: response `elapsed` field (floating-millisecond resolution)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 1559 | n/a | 0 | 0.83 | 1.15 | 0.33 | 1.0 | no |
| 2 | 1 | 2624 | n/a | 0 | 1.01 | 1.35 | 0.72 | 2.0 | no |
| 4 | 1 | 4023 | n/a | 0 | 1.26 | 1.73 | 1.43 | 4.0 | no |
| 8 | 3 | 4200 | 4169 to 4212 | 0 | 2.91 | 5.10 | 1.57 | 8.0 | yes |
| 16 | 1 | 3953 | n/a | 0 | 6.72 | 11.44 | 1.54 | 16.0 | yes |
| 32 | 1 | 3573 | n/a | 0 | 14.98 | 31.31 | 1.39 | 31.9 | yes |
| 64 | 1 | 3516 | n/a | 0 | 32.93 | 57.99 | 1.36 | 63.6 | yes |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 1872 | n/a | 0 | 0.69 | 0.96 | 0.19 | 1.0 | yes |
| 2 | 1 | 3312 | n/a | 0 | 0.79 | 1.08 | 0.48 | 2.0 | no |
| 4 | 3 | 4940 | 4719 to 4950 | 0 | 1.03 | 1.45 | 0.89 | 4.0 | no |
| 8 | 1 | 4557 | n/a | 0 | 2.65 | 4.22 | 1.08 | 8.0 | yes |
| 16 | 1 | 4117 | n/a | 0 | 6.63 | 11.49 | 0.97 | 16.0 | yes |
| 32 | 1 | 3719 | n/a | 0 | 14.22 | 30.33 | 0.88 | 31.9 | yes |
| 64 | 1 | 3623 | n/a | 0 | 31.57 | 54.17 | 0.87 | 63.6 | yes |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 1546 | n/a | 0 | 0.99 | 1.72 | 1.13 | 1.0 | no |
| 2 | 1 | 2957 | n/a | 0 | 1.05 | 1.68 | 0.65 | 2.0 | no |
| 4 | 1 | 4233 | n/a | 0 | 1.39 | 4.32 | 1.34 | 4.0 | no |
| 8 | 3 | 4397 | 4327 to 4401 | 0 | 2.82 | 5.42 | 1.42 | 8.0 | yes |
| 16 | 1 | 4064 | n/a | 0 | 6.55 | 12.48 | 1.18 | 16.0 | yes |
| 32 | 1 | 3669 | n/a | 0 | 14.50 | 30.44 | 1.07 | 31.9 | yes |
| 64 | 1 | 3389 | n/a | 0 | 34.28 | 64.84 | 1.06 | 63.6 | yes |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 358 | n/a | 0 | 5.95 | 23.97 | 4.29 | 1.0 | no |
| 2 | 1 | 883 | n/a | 0 | 5.73 | 20.90 | 3.97 | 2.0 | no |
| 4 | 1 | 1804 | n/a | 0 | 5.88 | 22.01 | 4.35 | 4.0 | no |
| 8 | 1 | 2623 | n/a | 0 | 7.56 | 26.00 | 4.84 | 8.0 | no |
| 16 | 3 | 2842 | 2758 to 2888 | 0 | 12.94 | 40.46 | 4.82 | 15.9 | no |
| 32 | 1 | 2817 | n/a | 0 | 22.61 | 54.32 | 4.70 | 31.9 | no |
| 64 | 1 | 2694 | n/a | 0 | 45.29 | 74.90 | 4.28 | 63.4 | no |

## Vector track

- Embedding model: sentence-transformers/all-MiniLM-L6-v2 (384 dim, cosine)
- Index setup: HNSW over the shared precomputed vectors, full precision (quantization off), cosine
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
| beir/scifact/test | efSearch | 64 | 0.9943 | yes | 32 | 0.9803 |
| beir/nfcorpus/test | efSearch | 128 | 0.9941 | yes | 64 | 0.9789 |
| dbpedia-entities-openai-100k | efSearch | 128 | 0.9907 | yes | 32 | 0.9602 |
| dbpedia-entities-openai-1m | efSearch | 384 | 0.9936 | yes | 64 | 0.9617 |

Latency is measured at the operating point.

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | Index size | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 2112 | 2.45 | 26.8 MB | 0.16 | 0.19 | 0.21 |
| beir/nfcorpus/test | 3633 | 1979 | 1.84 | 21.9 MB | 0.20 | 0.24 | 0.27 |
| dbpedia-entities-openai-100k | 100000 | 745 | 134.18 | 134.6 MB | 1.45 | 1.99 | 2.18 |
| dbpedia-entities-openai-1m | 995000 | 498 | 1996.66 | 1196.7 MB | 6.32 | 8.99 | 9.54 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 1.00 | 1.24 | 1.36 |
| beir/nfcorpus/test | 1.06 | 1.25 | 1.40 |
| dbpedia-entities-openai-100k | 3.31 | 3.89 | 4.46 |
| dbpedia-entities-openai-1m | 8.24 | 10.94 | 11.70 |

Server-side time source per dataset:

- beir/scifact/test: response `elapsed` field (floating-millisecond resolution)
- beir/nfcorpus/test: response `elapsed` field (floating-millisecond resolution)
- dbpedia-entities-openai-100k: response `elapsed` field (floating-millisecond resolution)
- dbpedia-entities-openai-1m: response `elapsed` field (floating-millisecond resolution)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 896 | n/a | 0 | 1.29 | 1.97 | 0.32 | 1.0 | no |
| 2 | 1 | 1743 | n/a | 0 | 1.48 | 2.62 | 0.66 | 2.0 | no |
| 4 | 1 | 2719 | n/a | 0 | 1.74 | 3.43 | 1.22 | 4.0 | no |
| 8 | 3 | 2824 | 2820 to 2837 | 0 | 4.22 | 7.44 | 1.38 | 8.0 | yes |
| 16 | 1 | 2761 | n/a | 0 | 9.50 | 27.17 | 1.36 | 16.0 | yes |
| 32 | 1 | 2589 | n/a | 0 | 20.05 | 39.82 | 1.29 | 31.9 | yes |
| 64 | 1 | 2438 | n/a | 0 | 46.47 | 81.57 | 1.22 | 63.5 | yes |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 925 | n/a | 0 | 1.24 | 2.22 | 0.33 | 1.0 | no |
| 2 | 1 | 1702 | n/a | 0 | 1.35 | 3.40 | 0.71 | 2.0 | no |
| 4 | 1 | 2616 | n/a | 0 | 1.81 | 4.30 | 1.31 | 4.0 | no |
| 8 | 3 | 2744 | 2744 to 2752 | 0 | 4.35 | 7.74 | 1.56 | 8.0 | no |
| 16 | 1 | 2703 | n/a | 0 | 9.77 | 26.54 | 1.56 | 16.0 | yes |
| 32 | 1 | 2553 | n/a | 0 | 20.75 | 38.67 | 1.46 | 31.9 | yes |
| 64 | 1 | 2410 | n/a | 0 | 47.09 | 87.93 | 1.42 | 63.5 | yes |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 300 | n/a | 0 | 3.87 | 6.33 | 0.58 | 1.0 | no |
| 2 | 1 | 572 | n/a | 0 | 4.21 | 6.06 | 1.12 | 2.0 | no |
| 4 | 1 | 980 | n/a | 0 | 5.16 | 9.33 | 2.16 | 4.0 | no |
| 8 | 1 | 1154 | n/a | 0 | 10.52 | 19.27 | 3.00 | 8.0 | no |
| 16 | 1 | 1186 | n/a | 0 | 23.40 | 40.45 | 3.47 | 15.9 | no |
| 32 | 3 | 1197 | 1194 to 1203 | 0 | 43.58 | 70.02 | 3.17 | 31.8 | no |
| 64 | 1 | 1165 | n/a | 0 | 100.31 | 174.66 | 3.10 | 63.0 | no |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 129 | n/a | 0 | 10.74 | 13.66 | 0.86 | 1.0 | no |
| 2 | 1 | 252 | n/a | 0 | 11.07 | 26.57 | 1.63 | 2.0 | no |
| 4 | 1 | 448 | n/a | 0 | 12.93 | 22.70 | 3.11 | 4.0 | no |
| 8 | 1 | 647 | n/a | 0 | 20.43 | 46.00 | 5.03 | 8.0 | no |
| 16 | 3 | 670 | 663 to 675 | 0 | 43.48 | 89.14 | 5.53 | 15.9 | no |
| 32 | 1 | 662 | n/a | 0 | 85.11 | 136.90 | 5.65 | 31.4 | no |
| 64 | 1 | 672 | n/a | 0 | 158.94 | 226.45 | 5.50 | 61.5 | no |

## Hybrid track

- Setup: BM25 (text) fused with HNSW vector search via Reciprocal Rank Fusion
- Fusion: RRF (k=60)

Retrieval quality vs human judgements:

| Dataset | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| beir/scifact/test | 0.7026 | 0.9643 | 0.6543 | 0.6615 |
| beir/nfcorpus/test | 0.3560 | 0.3239 | 0.1878 | 0.5745 |
| dbpedia-entities-openai-100k | n/a | n/a | n/a | n/a |
| dbpedia-entities-openai-1m | n/a | n/a | n/a | n/a |

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | Index size | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 1971 | 2.63 | 27.0 MB | 0.32 | 0.47 | 0.60 |
| beir/nfcorpus/test | 3633 | 1952 | 1.86 | 21.9 MB | 0.27 | 0.34 | 0.41 |
| dbpedia-entities-openai-100k | 100000 | 739 | 135.36 | 132.0 MB | 1.62 | 2.22 | 2.48 |
| dbpedia-entities-openai-1m | 995000 | 477 | 2085.44 | 1140.2 MB | 7.01 | 10.40 | 13.00 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 1.21 | 1.43 | 1.57 |
| beir/nfcorpus/test | 1.16 | 1.45 | 1.62 |
| dbpedia-entities-openai-100k | 3.50 | 4.25 | 5.11 |
| dbpedia-entities-openai-1m | 9.03 | 12.57 | 15.61 |

Server-side time source per dataset:

- beir/scifact/test: response `elapsed` field (floating-millisecond resolution)
- beir/nfcorpus/test: response `elapsed` field (floating-millisecond resolution)
- dbpedia-entities-openai-100k: response `elapsed` field (floating-millisecond resolution)
- dbpedia-entities-openai-1m: response `elapsed` field (floating-millisecond resolution)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 819 | n/a | 0 | 1.43 | 1.78 | 0.41 | 1.0 | no |
| 2 | 1 | 1470 | n/a | 0 | 1.67 | 3.34 | 0.88 | 2.0 | no |
| 4 | 1 | 2319 | n/a | 0 | 2.08 | 4.50 | 1.65 | 4.0 | no |
| 8 | 1 | 2583 | n/a | 0 | 4.62 | 8.98 | 1.95 | 8.0 | no |
| 16 | 3 | 2602 | 2588 to 2604 | 0 | 10.18 | 28.55 | 1.98 | 16.0 | yes |
| 32 | 1 | 2432 | n/a | 0 | 21.84 | 39.58 | 1.90 | 31.9 | yes |
| 64 | 1 | 2324 | n/a | 0 | 49.65 | 87.92 | 1.85 | 63.5 | yes |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 834 | n/a | 0 | 1.41 | 3.92 | 0.39 | 1.0 | no |
| 2 | 1 | 1585 | n/a | 0 | 1.49 | 3.75 | 0.83 | 2.0 | no |
| 4 | 1 | 2411 | n/a | 0 | 1.95 | 4.11 | 1.54 | 4.0 | no |
| 8 | 1 | 2618 | n/a | 0 | 4.53 | 8.87 | 1.81 | 8.0 | no |
| 16 | 3 | 2633 | 2619 to 2639 | 0 | 10.05 | 28.25 | 1.78 | 16.0 | yes |
| 32 | 1 | 2483 | n/a | 0 | 21.25 | 39.49 | 1.73 | 31.9 | yes |
| 64 | 1 | 2366 | n/a | 0 | 48.81 | 82.71 | 1.61 | 63.5 | yes |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 284 | n/a | 0 | 4.14 | 7.53 | 0.62 | 1.0 | no |
| 2 | 1 | 543 | n/a | 0 | 4.57 | 9.44 | 1.22 | 2.0 | no |
| 4 | 1 | 909 | n/a | 0 | 5.63 | 15.09 | 2.34 | 4.0 | no |
| 8 | 1 | 1115 | n/a | 0 | 10.91 | 21.22 | 3.19 | 8.0 | no |
| 16 | 3 | 1187 | 1185 to 1190 | 0 | 23.14 | 38.43 | 3.44 | 15.9 | no |
| 32 | 1 | 1167 | n/a | 0 | 45.54 | 69.23 | 3.49 | 31.8 | no |
| 64 | 1 | 1114 | n/a | 0 | 101.79 | 165.13 | 3.40 | 62.9 | no |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 113 | n/a | 0 | 12.73 | 20.05 | 0.92 | 1.0 | no |
| 2 | 1 | 228 | n/a | 0 | 12.38 | 35.23 | 1.67 | 2.0 | no |
| 4 | 1 | 386 | n/a | 0 | 15.93 | 25.39 | 3.23 | 4.0 | no |
| 8 | 1 | 568 | n/a | 0 | 23.49 | 48.19 | 5.32 | 8.0 | no |
| 16 | 1 | 599 | n/a | 0 | 48.55 | 102.66 | 5.73 | 15.9 | no |
| 32 | 1 | 605 | n/a | 0 | 93.64 | 140.67 | 5.75 | 31.3 | no |
| 64 | 3 | 617 | 616 to 621 | 0 | 173.51 | 266.36 | 5.77 | 61.4 | no |
