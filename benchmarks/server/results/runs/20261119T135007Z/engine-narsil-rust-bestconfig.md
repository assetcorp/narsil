# narsil-rust retrieval (keyword, vector, hybrid, best-config vector profile)

## Environment

- Captured: 2026-11-19T15:24:03.047409+00:00
- Load machine: GCP c3-standard-8, us-east1-b
- OS / arch: Linux 7.0.0-1017-gcp / x86_64 (containerized: True)
- CPU: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical)
- Memory: 33.6 GB
- Engine machine label: GCP c3-standard-8, us-east1-b
- Engine machine: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical), 33.6 GB
- Network round trip to the engine machine: p50 0.082 ms, p99 0.140 ms over 200 TCP connects
- Memory cap per engine: 21.5 GB
- Tracks: keyword, vector, hybrid
- Keyword setup: BM25 k1=0.9 b=0.4; language english, as the server reports it
- Run depth: 1000; run tag: narsil_rust_bm25
- Engine build: version 0.4.5, commit 3ad47df2c9c1
- Engine image: ir-benchmark-engine-narsil-rust@sha256:2357fdd456666f2ed9495367e892bc5f83efcce1a6ff972fdc4247487cec8f61
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
| beir/nfcorpus/test | 0.3149 | 0.3094 | 0.1576 | 0.5194 |
| dbpedia-entities-openai-100k | n/a | n/a | n/a | n/a |
| dbpedia-entities-openai-1m | n/a | n/a | n/a | n/a |

Recall operating point (latency below is measured here, the matched-recall rule for ANN search):

| Dataset | Knob | Value | ANN recall@k | Target met | Secondary value | Secondary recall |
| --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | efSearch | 16 | 0.9950 | yes | 16 | 0.9950 |
| beir/nfcorpus/test | efSearch | 128 | 0.9932 | yes | 16 | 0.9731 |
| dbpedia-entities-openai-100k | efSearch | 128 | 0.9909 | yes | 32 | 0.9597 |
| dbpedia-entities-openai-1m | efSearch | 296 | 0.9918 | yes | 64 | 0.9630 |

Latency is measured at the operating point.

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | On disk | Peak heap | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 2367 | 2.19 | 0.00 GB | 0.50 GB | 0.09 | 0.12 | 0.14 |
| beir/nfcorpus/test | 3633 | 1995 | 1.82 | 0.00 GB | 0.43 GB | 0.14 | 0.17 | 0.24 |
| dbpedia-entities-openai-100k | 100000 | 879 | 113.78 | 0.79 GB | 2.74 GB | 0.41 | 0.54 | 0.62 |
| dbpedia-entities-openai-1m | 995000 | 882 | 1127.97 | 7.95 GB | 10.11 GB | 1.36 | 1.80 | 1.92 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 0.34 | 0.42 | 0.47 |
| beir/nfcorpus/test | 0.41 | 0.49 | 0.54 |
| dbpedia-entities-openai-100k | 0.78 | 0.92 | 1.01 |
| dbpedia-entities-openai-1m | 1.77 | 2.22 | 2.36 |

Engine container memory through the whole track, load included (anonymous memory is the heap the kernel cannot reclaim; charged memory adds the page cache of the engine's files):

| Dataset | Peak anonymous | Peak charged | Samples |
| --- | --- | --- | --- |
| beir/scifact/test | 0.50 GB | 0.53 GB | 542 |
| beir/nfcorpus/test | 0.43 GB | 0.45 GB | 697 |
| dbpedia-entities-openai-100k | 2.74 GB | 4.78 GB | 1535 |
| dbpedia-entities-openai-1m | 10.11 GB | 19.93 GB | 5328 |

Server-side time source per dataset:

- beir/scifact/test: response `elapsed` field (floating-millisecond resolution)
- beir/nfcorpus/test: response `elapsed` field (floating-millisecond resolution)
- dbpedia-entities-openai-100k: response `elapsed` field (floating-millisecond resolution)
- dbpedia-entities-openai-1m: response `elapsed` field (floating-millisecond resolution)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 3399 | n/a | 0 | 0.32 | 0.42 | 0.84 | 0.9 | no |
| 2 | 1 | 6368 | n/a | 0 | 0.34 | 0.46 | 1.75 | 1.8 | no |
| 4 | 1 | 10560 | n/a | 0 | 0.40 | 0.62 | 3.38 | 3.6 | no |
| 8 | 1 | 17315 | n/a | 0 | 0.55 | 0.82 | 5.32 | 7.1 | no |
| 16 | 1 | 26574 | n/a | 0 | 0.80 | 2.14 | 7.08 | 14.6 | no |
| 32 | 1 | 29796 | n/a | 0 | 1.48 | 4.58 | 7.52 | 30.3 | no |
| 64 | 1 | 30528 | n/a | 0 | 2.97 | 6.23 | 7.65 | 62.2 | no |
| 128 | 3 | 30671 | 30602 to 30696 | 0 | 6.04 | 9.26 | 7.69 | 126.1 | no |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 2730 | n/a | 0 | 0.39 | 0.50 | 0.86 | 0.9 | no |
| 2 | 1 | 5292 | n/a | 0 | 0.42 | 0.53 | 1.78 | 1.8 | no |
| 4 | 1 | 8964 | n/a | 0 | 0.48 | 0.77 | 3.48 | 3.7 | no |
| 8 | 1 | 14220 | n/a | 0 | 0.71 | 1.05 | 5.37 | 7.3 | no |
| 16 | 1 | 20405 | n/a | 0 | 1.08 | 2.26 | 7.00 | 14.9 | no |
| 32 | 1 | 22693 | n/a | 0 | 2.01 | 4.47 | 7.54 | 30.8 | no |
| 64 | 1 | 23421 | n/a | 0 | 3.98 | 6.58 | 7.70 | 62.7 | no |
| 128 | 3 | 23795 | 23768 to 23836 | 0 | 7.44 | 9.77 | 7.82 | 126.5 | no |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 1374 | n/a | 0 | 0.84 | 1.04 | 0.91 | 1.0 | no |
| 2 | 1 | 2528 | n/a | 0 | 0.90 | 1.12 | 1.78 | 1.9 | no |
| 4 | 1 | 4438 | n/a | 0 | 1.08 | 1.39 | 3.64 | 3.8 | no |
| 8 | 1 | 6728 | n/a | 0 | 1.72 | 2.55 | 5.80 | 7.7 | no |
| 16 | 1 | 8793 | n/a | 0 | 2.59 | 4.68 | 7.35 | 15.5 | no |
| 32 | 1 | 9186 | n/a | 0 | 4.43 | 6.97 | 7.87 | 31.5 | no |
| 64 | 3 | 9341 | 9285 to 9465 | 0 | 7.98 | 10.36 | 7.92 | 63.4 | no |
| 128 | 1 | 9345 | n/a | 0 | 15.03 | 17.28 | 7.92 | 127.0 | no |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 589 | n/a | 0 | 2.13 | 2.37 | 0.96 | 1.0 | no |
| 2 | 1 | 1136 | n/a | 0 | 2.20 | 2.74 | 1.89 | 2.0 | no |
| 4 | 1 | 2024 | n/a | 0 | 2.71 | 3.29 | 3.82 | 3.9 | no |
| 8 | 1 | 3022 | n/a | 0 | 3.89 | 5.49 | 6.29 | 7.9 | no |
| 16 | 3 | 3847 | 3716 to 3879 | 0 | 5.49 | 8.12 | 7.90 | 15.8 | no |
| 32 | 1 | 3824 | n/a | 0 | 9.83 | 11.94 | 7.94 | 31.7 | no |
| 64 | 1 | 3759 | n/a | 0 | 18.64 | 19.97 | 7.94 | 63.5 | no |
| 128 | 1 | 3870 | n/a | 0 | 35.80 | 38.02 | 7.94 | 126.6 | no |

## Hybrid track

- Setup: BM25 (text) fused with OSQ 4-bit optimised-scalar-quantized HNSW vector search (full-precision rescore) via Reciprocal Rank Fusion
- Fusion: RRF (k=60)

Retrieval quality vs human judgements:

| Dataset | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| beir/scifact/test | 0.7054 | 0.9643 | 0.6581 | 0.6648 |
| beir/nfcorpus/test | 0.3562 | 0.3238 | 0.1877 | 0.5759 |
| dbpedia-entities-openai-100k | n/a | n/a | n/a | n/a |
| dbpedia-entities-openai-1m | n/a | n/a | n/a | n/a |

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | On disk | Peak heap | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 2398 | 2.16 | 0.00 GB | 0.46 GB | 0.17 | 0.24 | 0.28 |
| beir/nfcorpus/test | 3633 | 1939 | 1.87 | 0.00 GB | 0.45 GB | 0.17 | 0.20 | 0.26 |
| dbpedia-entities-openai-100k | 100000 | 876 | 114.19 | 0.79 GB | 2.67 GB | 0.51 | 0.67 | 0.77 |
| dbpedia-entities-openai-1m | 995000 | 881 | 1129.37 | 7.19 GB | 9.76 GB | 2.06 | 3.09 | 3.69 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 0.47 | 0.57 | 0.61 |
| beir/nfcorpus/test | 0.43 | 0.51 | 0.58 |
| dbpedia-entities-openai-100k | 0.91 | 1.10 | 1.21 |
| dbpedia-entities-openai-1m | 2.49 | 3.54 | 4.14 |

Engine container memory through the whole track, load included (anonymous memory is the heap the kernel cannot reclaim; charged memory adds the page cache of the engine's files):

| Dataset | Peak anonymous | Peak charged | Samples |
| --- | --- | --- | --- |
| beir/scifact/test | 0.46 GB | 0.49 GB | 486 |
| beir/nfcorpus/test | 0.45 GB | 0.47 GB | 486 |
| dbpedia-entities-openai-100k | 2.67 GB | 4.71 GB | 1141 |
| dbpedia-entities-openai-1m | 9.76 GB | 18.39 GB | 3364 |

Server-side time source per dataset:

- beir/scifact/test: response `elapsed` field (floating-millisecond resolution)
- beir/nfcorpus/test: response `elapsed` field (floating-millisecond resolution)
- dbpedia-entities-openai-100k: response `elapsed` field (floating-millisecond resolution)
- dbpedia-entities-openai-1m: response `elapsed` field (floating-millisecond resolution)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 2696 | n/a | 0 | 0.42 | 0.54 | 0.86 | 0.9 | no |
| 2 | 1 | 4959 | n/a | 0 | 0.46 | 0.59 | 1.75 | 1.8 | no |
| 4 | 1 | 8338 | n/a | 0 | 0.55 | 1.33 | 3.48 | 3.7 | no |
| 8 | 1 | 13105 | n/a | 0 | 0.79 | 1.18 | 5.45 | 7.4 | no |
| 16 | 1 | 18650 | n/a | 0 | 1.18 | 2.65 | 7.01 | 15.0 | no |
| 32 | 1 | 20946 | n/a | 0 | 2.15 | 4.56 | 7.56 | 30.9 | no |
| 64 | 1 | 21660 | n/a | 0 | 4.28 | 7.05 | 7.74 | 62.8 | no |
| 128 | 3 | 21782 | 21769 to 21888 | 0 | 7.99 | 10.66 | 7.82 | 126.6 | no |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 2430 | n/a | 0 | 0.44 | 0.54 | 0.85 | 0.9 | no |
| 2 | 1 | 4873 | n/a | 0 | 0.46 | 0.58 | 1.77 | 1.9 | no |
| 4 | 1 | 8189 | n/a | 0 | 0.53 | 0.70 | 3.52 | 3.7 | no |
| 8 | 1 | 12622 | n/a | 0 | 0.82 | 1.35 | 5.40 | 7.4 | no |
| 16 | 1 | 17881 | n/a | 0 | 1.24 | 2.41 | 6.96 | 15.1 | no |
| 32 | 1 | 20107 | n/a | 0 | 2.24 | 4.63 | 7.54 | 30.9 | no |
| 64 | 1 | 20869 | n/a | 0 | 4.43 | 7.18 | 7.71 | 62.8 | no |
| 128 | 3 | 21494 | 21487 to 21504 | 0 | 7.96 | 10.47 | 7.88 | 126.6 | no |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 1169 | n/a | 0 | 1.01 | 1.27 | 0.92 | 1.0 | no |
| 2 | 1 | 2217 | n/a | 0 | 1.12 | 1.58 | 1.81 | 1.9 | no |
| 4 | 1 | 3897 | n/a | 0 | 1.27 | 1.72 | 3.70 | 3.9 | no |
| 8 | 1 | 5754 | n/a | 0 | 2.02 | 2.90 | 5.89 | 7.7 | no |
| 16 | 1 | 7425 | n/a | 0 | 3.05 | 5.55 | 7.47 | 15.6 | no |
| 32 | 1 | 8072 | n/a | 0 | 4.99 | 7.35 | 7.89 | 31.6 | no |
| 64 | 3 | 8433 | 8425 to 8540 | 0 | 8.77 | 11.03 | 7.92 | 63.5 | no |
| 128 | 1 | 8455 | n/a | 0 | 16.72 | 19.07 | 7.92 | 127.1 | no |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 408 | n/a | 0 | 3.42 | 5.18 | 0.97 | 1.0 | no |
| 2 | 1 | 791 | n/a | 0 | 3.51 | 5.52 | 1.90 | 2.0 | no |
| 4 | 1 | 1467 | n/a | 0 | 4.07 | 6.95 | 3.84 | 3.9 | no |
| 8 | 1 | 2216 | n/a | 0 | 5.50 | 9.18 | 6.50 | 7.9 | no |
| 16 | 1 | 2493 | n/a | 0 | 8.62 | 13.10 | 7.95 | 15.9 | no |
| 32 | 1 | 2679 | n/a | 0 | 14.44 | 18.96 | 7.94 | 31.8 | no |
| 64 | 1 | 2644 | n/a | 0 | 26.93 | 30.32 | 7.96 | 63.5 | no |
| 128 | 3 | 2756 | 2752 to 2761 | 0 | 49.87 | 53.18 | 7.94 | 126.2 | no |
