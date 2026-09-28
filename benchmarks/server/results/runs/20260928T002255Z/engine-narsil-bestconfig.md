# narsil retrieval (keyword, vector, hybrid, best-config vector profile)

## Environment

- Captured: 2026-09-28T02:10:54.920843+00:00
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

## Vector track

- Embedding model: sentence-transformers/all-MiniLM-L6-v2 (384 dim, cosine)
- Index setup: HNSW over the shared precomputed vectors, OSQ 4-bit optimised scalar quantization with the graph built from codes and a full-precision rescore, cosine
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
| beir/scifact/test | efSearch | 16 | 0.9927 | yes | 16 | 0.9927 |
| beir/nfcorpus/test | efSearch | 128 | 0.9926 | yes | 16 | 0.9706 |
| dbpedia-entities-openai-100k | efSearch | 128 | 0.9919 | yes | 32 | 0.9577 |
| dbpedia-entities-openai-1m | efSearch | 384 | 0.9942 | yes | 64 | 0.9582 |

Latency is measured at the operating point.

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | Index size | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 2217 | 2.34 | 28.6 MB | 0.13 | 0.15 | 0.22 |
| beir/nfcorpus/test | 3633 | 1998 | 1.82 | 23.4 MB | 0.18 | 0.21 | 0.23 |
| dbpedia-entities-openai-100k | 100000 | 773 | 129.31 | 737.9 MB | 0.60 | 0.75 | 0.83 |
| dbpedia-entities-openai-1m | 995000 | 642 | 1549.10 | 2243.1 MB | 2.21 | 4.74 | 7.08 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 0.95 | 1.16 | 1.33 |
| beir/nfcorpus/test | 1.02 | 1.17 | 1.59 |
| dbpedia-entities-openai-100k | 2.42 | 2.73 | 3.59 |
| dbpedia-entities-openai-1m | 4.11 | 7.17 | 9.94 |

Server-side time source per dataset:

- beir/scifact/test: response `elapsed` field (floating-millisecond resolution)
- beir/nfcorpus/test: response `elapsed` field (floating-millisecond resolution)
- dbpedia-entities-openai-100k: response `elapsed` field (floating-millisecond resolution)
- dbpedia-entities-openai-1m: response `elapsed` field (floating-millisecond resolution)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 988 | n/a | 0 | 1.11 | 1.94 | 0.38 | 1.0 | no |
| 2 | 1 | 1764 | n/a | 0 | 1.41 | 31.06 | 0.82 | 2.0 | no |
| 4 | 1 | 2644 | n/a | 0 | 1.76 | 24.35 | 1.44 | 4.0 | no |
| 8 | 3 | 2782 | 2780 to 2798 | 0 | 4.27 | 34.85 | 1.66 | 8.0 | yes |
| 16 | 1 | 2738 | n/a | 0 | 9.75 | 57.18 | 1.66 | 16.0 | yes |
| 32 | 1 | 2552 | n/a | 0 | 20.75 | 55.91 | 1.47 | 31.9 | yes |
| 64 | 1 | 2420 | n/a | 0 | 48.19 | 101.98 | 1.48 | 63.5 | yes |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 916 | n/a | 0 | 1.19 | 19.27 | 0.39 | 1.0 | no |
| 2 | 1 | 1628 | n/a | 0 | 1.50 | 29.48 | 0.78 | 2.0 | no |
| 4 | 1 | 2529 | n/a | 0 | 1.84 | 32.41 | 1.58 | 4.0 | no |
| 8 | 3 | 2729 | 2699 to 2733 | 0 | 4.36 | 32.01 | 1.77 | 8.0 | no |
| 16 | 1 | 2669 | n/a | 0 | 10.08 | 43.91 | 1.75 | 16.0 | yes |
| 32 | 1 | 2506 | n/a | 0 | 21.29 | 63.75 | 1.67 | 31.9 | yes |
| 64 | 1 | 2404 | n/a | 0 | 47.19 | 99.43 | 1.65 | 63.5 | yes |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 378 | n/a | 0 | 2.62 | 43.55 | 0.56 | 1.0 | no |
| 2 | 1 | 718 | n/a | 0 | 3.23 | 62.54 | 1.04 | 2.0 | no |
| 4 | 1 | 1182 | n/a | 0 | 4.06 | 56.37 | 1.85 | 4.0 | no |
| 8 | 1 | 1335 | n/a | 0 | 8.95 | 61.34 | 2.26 | 8.0 | no |
| 16 | 3 | 1366 | 1347 to 1374 | 0 | 19.88 | 88.53 | 2.44 | 15.9 | no |
| 32 | 1 | 1311 | n/a | 0 | 40.26 | 100.55 | 2.40 | 31.3 | yes |
| 64 | 1 | 1283 | n/a | 0 | 88.50 | 152.82 | 2.44 | 63.2 | yes |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 262 | n/a | 0 | 4.61 | 29.58 | 0.72 | 1.0 | no |
| 2 | 1 | 475 | n/a | 0 | 5.52 | 27.49 | 1.36 | 2.0 | no |
| 4 | 1 | 828 | n/a | 0 | 6.34 | 17.06 | 2.57 | 4.0 | no |
| 8 | 1 | 1068 | n/a | 0 | 11.61 | 40.84 | 3.62 | 8.0 | no |
| 16 | 3 | 1154 | 1154 to 1177 | 0 | 24.25 | 58.61 | 3.82 | 15.9 | no |
| 32 | 1 | 1122 | n/a | 0 | 49.43 | 110.80 | 3.94 | 31.7 | no |
| 64 | 1 | 1095 | n/a | 0 | 103.14 | 184.64 | 3.79 | 62.5 | no |

## Hybrid track

- Setup: BM25 (text) fused with OSQ 4-bit optimised-scalar-quantized HNSW vector search (full-precision rescore) via Reciprocal Rank Fusion
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
| beir/scifact/test | 5183 | 2114 | 2.45 | 33.1 MB | 0.29 | 0.46 | 0.57 |
| beir/nfcorpus/test | 3633 | 2041 | 1.78 | 23.0 MB | 0.24 | 0.30 | 0.38 |
| dbpedia-entities-openai-100k | 100000 | 778 | 128.53 | 670.8 MB | 0.73 | 1.07 | 1.29 |
| dbpedia-entities-openai-1m | 995000 | 643 | 1547.94 | 2285.7 MB | 3.11 | 6.45 | 9.52 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 1.18 | 1.41 | 1.70 |
| beir/nfcorpus/test | 1.10 | 1.25 | 1.35 |
| dbpedia-entities-openai-100k | 2.57 | 3.02 | 3.98 |
| dbpedia-entities-openai-1m | 5.32 | 9.16 | 12.65 |

Server-side time source per dataset:

- beir/scifact/test: response `elapsed` field (floating-millisecond resolution)
- beir/nfcorpus/test: response `elapsed` field (floating-millisecond resolution)
- dbpedia-entities-openai-100k: response `elapsed` field (floating-millisecond resolution)
- dbpedia-entities-openai-1m: response `elapsed` field (floating-millisecond resolution)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 787 | n/a | 0 | 1.51 | 3.45 | 0.46 | 1.0 | no |
| 2 | 1 | 1454 | n/a | 0 | 1.70 | 18.80 | 0.92 | 2.0 | no |
| 4 | 1 | 2269 | n/a | 0 | 2.09 | 20.50 | 1.77 | 4.0 | no |
| 8 | 1 | 2538 | n/a | 0 | 4.71 | 34.04 | 2.16 | 8.0 | no |
| 16 | 3 | 2565 | 2546 to 2581 | 0 | 10.39 | 49.13 | 2.21 | 15.9 | yes |
| 32 | 1 | 2421 | n/a | 0 | 21.89 | 71.51 | 2.06 | 31.9 | yes |
| 64 | 1 | 2381 | n/a | 0 | 48.60 | 84.76 | 1.99 | 63.5 | yes |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 853 | n/a | 0 | 1.30 | 19.29 | 0.41 | 1.0 | no |
| 2 | 1 | 1529 | n/a | 0 | 1.55 | 2.67 | 0.92 | 2.0 | no |
| 4 | 1 | 2403 | n/a | 0 | 1.95 | 23.22 | 1.65 | 4.0 | no |
| 8 | 1 | 2608 | n/a | 0 | 4.59 | 26.90 | 2.06 | 8.0 | no |
| 16 | 3 | 2628 | 2628 to 2645 | 0 | 10.09 | 66.20 | 2.06 | 16.0 | yes |
| 32 | 1 | 2455 | n/a | 0 | 21.91 | 61.71 | 1.92 | 31.9 | yes |
| 64 | 1 | 2336 | n/a | 0 | 49.90 | 95.41 | 1.81 | 63.5 | yes |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 345 | n/a | 0 | 3.15 | 60.68 | 0.57 | 1.0 | no |
| 2 | 1 | 692 | n/a | 0 | 3.57 | 34.75 | 1.10 | 2.0 | no |
| 4 | 1 | 1092 | n/a | 0 | 4.42 | 63.83 | 2.04 | 4.0 | no |
| 8 | 1 | 1295 | n/a | 0 | 9.31 | 67.33 | 2.46 | 8.0 | no |
| 16 | 3 | 1335 | 1329 to 1336 | 0 | 20.49 | 90.07 | 2.66 | 15.9 | no |
| 32 | 1 | 1270 | n/a | 0 | 41.89 | 116.64 | 2.62 | 31.3 | no |
| 64 | 1 | 1249 | n/a | 0 | 90.69 | 172.60 | 2.61 | 62.9 | no |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 201 | n/a | 0 | 8.06 | 30.19 | 0.77 | 1.0 | no |
| 2 | 1 | 377 | n/a | 0 | 8.56 | 27.06 | 1.54 | 2.0 | no |
| 4 | 1 | 605 | n/a | 0 | 11.44 | 32.53 | 3.69 | 4.0 | no |
| 8 | 1 | 908 | n/a | 0 | 14.93 | 49.76 | 4.39 | 8.0 | no |
| 16 | 1 | 988 | n/a | 0 | 30.01 | 70.95 | 4.77 | 15.9 | no |
| 32 | 1 | 996 | n/a | 0 | 58.62 | 96.32 | 4.87 | 31.6 | no |
| 64 | 3 | 1017 | 1014 to 1018 | 0 | 109.46 | 192.00 | 4.59 | 62.5 | no |
