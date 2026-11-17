# weaviate retrieval (vector, hybrid, best-config vector profile)

## Environment

- Captured: 2026-11-17T09:15:19.832796+00:00
- Load machine: GCP c3-standard-8, us-west3-b
- OS / arch: Linux 7.0.0-1017-gcp / x86_64 (containerized: True)
- CPU: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical)
- Memory: 33.6 GB
- Engine machine label: GCP c3-standard-8, us-west3-b
- Engine machine: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical), 33.6 GB
- Network round trip to the engine machine: p50 0.078 ms, p99 0.145 ms over 200 TCP connects
- Memory cap per engine: 21.5 GB
- Tracks: vector, hybrid
- Keyword setup: None
- Run depth: 1000; run tag: weaviate
- Engine build: version 1.40.5
- Engine image: cr.weaviate.io/semitechnologies/weaviate@sha256:fe848a3830c8a96fc598c903e39bbaa84a84553e30362663c313643a0febe32a
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
| beir/nfcorpus/test | 0.3148 | 0.3094 | 0.1575 | 0.5184 |
| dbpedia-entities-openai-100k | n/a | n/a | n/a | n/a |
| dbpedia-entities-openai-1m | n/a | n/a | n/a | n/a |

Recall operating point (latency below is measured here, the matched-recall rule for ANN search):

| Dataset | Knob | Value | ANN recall@k | Target met | Secondary value | Secondary recall |
| --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | ef | 64 | 0.9970 | yes | 32 | 0.9823 |
| beir/nfcorpus/test | ef | 128 | 0.9923 | yes | 64 | 0.9690 |
| dbpedia-entities-openai-100k | ef | 192 | 0.9929 | yes | 32 | 0.9524 |
| dbpedia-entities-openai-1m | ef | 416 | 0.9925 | yes | 64 | 0.9536 |

Latency is measured at the operating point.

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | On disk | Peak heap | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 1754 | 2.95 | n/a | 15.38 GB | n/a | n/a | n/a |
| beir/nfcorpus/test | 3633 | 1428 | 2.54 | n/a | 0.59 GB | n/a | n/a | n/a |
| dbpedia-entities-openai-100k | 100000 | 658 | 151.99 | n/a | 2.19 GB | n/a | n/a | n/a |
| dbpedia-entities-openai-1m | 995000 | 664 | 1498.69 | n/a | 6.71 GB | n/a | n/a | n/a |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 3.07 | 4.05 | 6.24 |
| beir/nfcorpus/test | 3.10 | 4.07 | 6.33 |
| dbpedia-entities-openai-100k | 8.53 | 9.97 | 13.22 |
| dbpedia-entities-openai-1m | 10.40 | 11.45 | 12.96 |

Engine container memory through the whole track, load included (anonymous memory is the heap the kernel cannot reclaim; charged memory adds the page cache of the engine's files):

| Dataset | Peak anonymous | Peak charged | Samples |
| --- | --- | --- | --- |
| beir/scifact/test | 15.38 GB | 15.50 GB | 499 |
| beir/nfcorpus/test | 0.59 GB | 0.69 GB | 542 |
| dbpedia-entities-openai-100k | 2.19 GB | 3.34 GB | 1258 |
| dbpedia-entities-openai-1m | 6.71 GB | 19.87 GB | 4573 |

Server-side time source per dataset:

- beir/scifact/test: client round-trip only (no server-side query time exposed)
- beir/nfcorpus/test: client round-trip only (no server-side query time exposed)
- dbpedia-entities-openai-100k: client round-trip only (no server-side query time exposed)
- dbpedia-entities-openai-1m: client round-trip only (no server-side query time exposed)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 303 | n/a | 0 | 4.04 | 9.09 | 1.25 | 1.0 | no |
| 2 | 1 | 578 | n/a | 0 | 5.33 | 9.09 | 2.36 | 2.0 | no |
| 4 | 1 | 991 | n/a | 0 | 6.51 | 7.70 | 4.10 | 4.0 | no |
| 8 | 1 | 1447 | n/a | 0 | 8.47 | 22.30 | 6.50 | 8.0 | no |
| 16 | 1 | 1654 | n/a | 0 | 17.10 | 29.52 | 7.72 | 15.9 | no |
| 32 | 3 | 1667 | 1658 to 1671 | 0 | 40.34 | 75.64 | 7.82 | 31.8 | no |
| 64 | 1 | 1658 | n/a | 0 | 92.23 | 185.68 | 7.83 | 63.1 | no |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 298 | n/a | 0 | 4.10 | 8.19 | 1.22 | 1.0 | no |
| 2 | 1 | 575 | n/a | 0 | 5.54 | 6.98 | 2.17 | 2.0 | no |
| 4 | 1 | 981 | n/a | 0 | 6.49 | 7.75 | 4.13 | 4.0 | no |
| 8 | 1 | 1415 | n/a | 0 | 8.70 | 21.28 | 6.50 | 8.0 | no |
| 16 | 1 | 1615 | n/a | 0 | 17.22 | 30.78 | 7.75 | 15.9 | no |
| 32 | 3 | 1627 | 1608 to 1630 | 0 | 42.22 | 75.25 | 7.83 | 31.8 | no |
| 64 | 1 | 1613 | n/a | 0 | 90.33 | 170.53 | 7.84 | 63.1 | no |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 115 | n/a | 0 | 10.02 | 14.62 | 0.99 | 1.0 | no |
| 2 | 1 | 217 | n/a | 0 | 12.43 | 15.58 | 1.90 | 2.0 | no |
| 4 | 1 | 377 | n/a | 0 | 14.76 | 18.08 | 3.74 | 4.0 | no |
| 8 | 1 | 557 | n/a | 0 | 20.94 | 27.99 | 6.64 | 8.0 | no |
| 16 | 3 | 602 | 601 to 603 | 0 | 47.47 | 82.37 | 7.84 | 15.9 | no |
| 32 | 1 | 584 | n/a | 0 | 122.80 | 206.21 | 7.83 | 31.5 | no |
| 64 | 1 | 578 | n/a | 0 | 235.54 | 418.79 | 7.84 | 62.1 | no |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 98 | n/a | 0 | 11.32 | 19.86 | 0.96 | 1.0 | no |
| 2 | 1 | 184 | n/a | 0 | 14.70 | 23.12 | 1.91 | 2.0 | no |
| 4 | 1 | 336 | n/a | 0 | 15.14 | 25.87 | 3.70 | 4.0 | no |
| 8 | 1 | 509 | n/a | 0 | 22.63 | 39.58 | 6.72 | 8.0 | no |
| 16 | 3 | 523 | 520 to 527 | 0 | 55.02 | 134.26 | 7.71 | 15.9 | no |
| 32 | 1 | 511 | n/a | 0 | 107.27 | 246.70 | 7.74 | 31.1 | no |
| 64 | 1 | 505 | n/a | 0 | 207.03 | 351.98 | 7.71 | 61.9 | no |

## Hybrid track

- Setup: BM25 over text fused with RQ-quantized dense vectors (full-precision rescore) via the hybrid operator (rankedFusion, alpha=0.5)
- Fusion: rankedFusion (alpha=0.5)

Retrieval quality vs human judgements:

| Dataset | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| beir/scifact/test | 0.6840 | 0.9577 | 0.6366 | 0.6460 |
| beir/nfcorpus/test | 0.3428 | 0.3195 | 0.1810 | 0.5546 |
| dbpedia-entities-openai-100k | n/a | n/a | n/a | n/a |
| dbpedia-entities-openai-1m | n/a | n/a | n/a | n/a |

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | On disk | Peak heap | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 1756 | 2.95 | n/a | 0.63 GB | n/a | n/a | n/a |
| beir/nfcorpus/test | 3633 | 1453 | 2.50 | n/a | 0.60 GB | n/a | n/a | n/a |
| dbpedia-entities-openai-100k | 100000 | 655 | 152.59 | n/a | 2.42 GB | n/a | n/a | n/a |
| dbpedia-entities-openai-1m | 995000 | 666 | 1493.20 | n/a | 6.88 GB | n/a | n/a | n/a |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 4.05 | 6.26 | 9.16 |
| beir/nfcorpus/test | 3.88 | 5.84 | 8.17 |
| dbpedia-entities-openai-100k | 9.44 | 10.89 | 13.25 |
| dbpedia-entities-openai-1m | 11.83 | 13.00 | 14.52 |

Engine container memory through the whole track, load included (anonymous memory is the heap the kernel cannot reclaim; charged memory adds the page cache of the engine's files):

| Dataset | Peak anonymous | Peak charged | Samples |
| --- | --- | --- | --- |
| beir/scifact/test | 0.63 GB | 0.73 GB | 387 |
| beir/nfcorpus/test | 0.60 GB | 0.69 GB | 385 |
| dbpedia-entities-openai-100k | 2.42 GB | 3.58 GB | 869 |
| dbpedia-entities-openai-1m | 6.88 GB | 21.47 GB | 3606 |

Server-side time source per dataset:

- beir/scifact/test: client round-trip only (no server-side query time exposed)
- beir/nfcorpus/test: client round-trip only (no server-side query time exposed)
- dbpedia-entities-openai-100k: client round-trip only (no server-side query time exposed)
- dbpedia-entities-openai-1m: client round-trip only (no server-side query time exposed)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 232 | n/a | 0 | 6.20 | 10.01 | 2.19 | 1.0 | no |
| 2 | 1 | 401 | n/a | 0 | 8.70 | 11.02 | 3.87 | 2.0 | no |
| 4 | 1 | 608 | n/a | 0 | 10.50 | 13.70 | 6.20 | 4.0 | no |
| 8 | 1 | 745 | n/a | 0 | 16.82 | 22.75 | 7.59 | 8.0 | no |
| 16 | 1 | 771 | n/a | 0 | 40.18 | 65.07 | 7.92 | 15.9 | no |
| 32 | 1 | 789 | n/a | 0 | 77.88 | 132.67 | 7.89 | 31.6 | no |
| 64 | 3 | 792 | 791 to 794 | 0 | 176.04 | 302.00 | 7.90 | 62.6 | no |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 241 | n/a | 0 | 5.72 | 9.57 | 1.93 | 1.0 | no |
| 2 | 1 | 430 | n/a | 0 | 7.93 | 9.88 | 3.52 | 2.0 | no |
| 4 | 1 | 672 | n/a | 0 | 9.87 | 12.69 | 5.84 | 4.0 | no |
| 8 | 1 | 871 | n/a | 0 | 14.84 | 21.12 | 7.51 | 8.0 | no |
| 16 | 1 | 904 | n/a | 0 | 35.56 | 67.08 | 7.90 | 15.9 | no |
| 32 | 1 | 943 | n/a | 0 | 68.90 | 115.73 | 7.86 | 31.7 | no |
| 64 | 3 | 954 | 954 to 956 | 0 | 149.17 | 276.23 | 7.89 | 62.7 | no |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 105 | n/a | 0 | 10.79 | 14.65 | 1.24 | 1.0 | no |
| 2 | 1 | 191 | n/a | 0 | 13.30 | 16.81 | 2.50 | 2.0 | no |
| 4 | 1 | 326 | n/a | 0 | 16.98 | 20.29 | 4.63 | 4.0 | no |
| 8 | 1 | 439 | n/a | 0 | 26.67 | 35.02 | 7.19 | 8.0 | no |
| 16 | 3 | 466 | 463 to 467 | 0 | 67.88 | 106.82 | 7.92 | 15.9 | no |
| 32 | 1 | 458 | n/a | 0 | 165.86 | 290.59 | 7.91 | 31.4 | no |
| 64 | 1 | 451 | n/a | 0 | 315.38 | 509.71 | 7.90 | 61.6 | no |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 86 | n/a | 0 | 12.98 | 27.72 | 1.58 | 1.0 | no |
| 2 | 1 | 158 | n/a | 0 | 14.91 | 28.71 | 2.98 | 2.0 | no |
| 4 | 1 | 264 | n/a | 0 | 18.79 | 32.40 | 5.52 | 4.0 | no |
| 8 | 1 | 359 | n/a | 0 | 31.93 | 53.74 | 7.46 | 7.9 | no |
| 16 | 3 | 370 | 366 to 371 | 0 | 80.91 | 159.28 | 7.94 | 15.8 | no |
| 32 | 1 | 364 | n/a | 0 | 140.35 | 288.82 | 7.93 | 31.3 | no |
| 64 | 1 | 352 | n/a | 0 | 273.87 | 541.44 | 7.91 | 60.5 | no |
