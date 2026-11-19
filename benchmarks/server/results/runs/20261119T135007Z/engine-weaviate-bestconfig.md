# weaviate retrieval (vector, hybrid, best-config vector profile)

## Environment

- Captured: 2026-11-19T15:41:20.758671+00:00
- Load machine: GCP c3-standard-8, us-west3-b
- OS / arch: Linux 7.0.0-1017-gcp / x86_64 (containerized: True)
- CPU: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical)
- Memory: 33.6 GB
- Engine machine label: GCP c3-standard-8, us-west3-b
- Engine machine: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical), 33.6 GB
- Network round trip to the engine machine: p50 0.079 ms, p99 0.148 ms over 200 TCP connects
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
| beir/nfcorpus/test | 0.3148 | 0.3094 | 0.1576 | 0.5179 |
| dbpedia-entities-openai-100k | n/a | n/a | n/a | n/a |
| dbpedia-entities-openai-1m | n/a | n/a | n/a | n/a |

Recall operating point (latency below is measured here, the matched-recall rule for ANN search):

| Dataset | Knob | Value | ANN recall@k | Target met | Secondary value | Secondary recall |
| --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | ef | 64 | 0.9970 | yes | 32 | 0.9817 |
| beir/nfcorpus/test | ef | 160 | 0.9929 | yes | 64 | 0.9703 |
| dbpedia-entities-openai-100k | ef | 160 | 0.9917 | yes | 32 | 0.9527 |
| dbpedia-entities-openai-1m | ef | 384 | 0.9921 | yes | 64 | 0.9570 |

Latency is measured at the operating point.

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | On disk | Peak heap | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 1768 | 2.93 | n/a | 14.97 GB | n/a | n/a | n/a |
| beir/nfcorpus/test | 3633 | 1424 | 2.55 | n/a | 0.61 GB | n/a | n/a | n/a |
| dbpedia-entities-openai-100k | 100000 | 657 | 152.29 | n/a | 2.13 GB | n/a | n/a | n/a |
| dbpedia-entities-openai-1m | 995000 | 668 | 1489.45 | n/a | 7.06 GB | n/a | n/a | n/a |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 2.38 | 3.28 | 5.74 |
| beir/nfcorpus/test | 2.46 | 3.67 | 5.56 |
| dbpedia-entities-openai-100k | 6.87 | 7.34 | 12.01 |
| dbpedia-entities-openai-1m | 8.86 | 9.84 | 11.82 |

Engine container memory through the whole track, load included (anonymous memory is the heap the kernel cannot reclaim; charged memory adds the page cache of the engine's files):

| Dataset | Peak anonymous | Peak charged | Samples |
| --- | --- | --- | --- |
| beir/scifact/test | 14.97 GB | 15.08 GB | 660 |
| beir/nfcorpus/test | 0.61 GB | 0.70 GB | 772 |
| dbpedia-entities-openai-100k | 2.13 GB | 3.25 GB | 1972 |
| dbpedia-entities-openai-1m | 7.06 GB | 20.43 GB | 7180 |

Server-side time source per dataset:

- beir/scifact/test: client round-trip only (no server-side query time exposed)
- beir/nfcorpus/test: client round-trip only (no server-side query time exposed)
- dbpedia-entities-openai-100k: client round-trip only (no server-side query time exposed)
- dbpedia-entities-openai-1m: client round-trip only (no server-side query time exposed)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 410 | n/a | 0 | 3.28 | 7.91 | 1.61 | 1.0 | no |
| 2 | 1 | 738 | n/a | 0 | 4.69 | 6.28 | 2.84 | 2.0 | no |
| 4 | 1 | 1176 | n/a | 0 | 5.68 | 7.08 | 5.09 | 4.0 | no |
| 8 | 1 | 1606 | n/a | 0 | 8.29 | 12.28 | 7.46 | 7.9 | no |
| 16 | 1 | 1657 | n/a | 0 | 21.50 | 44.75 | 7.79 | 15.9 | no |
| 32 | 1 | 1654 | n/a | 0 | 43.63 | 83.32 | 7.83 | 31.8 | no |
| 64 | 1 | 1659 | n/a | 0 | 93.79 | 195.20 | 7.85 | 63.1 | no |
| 128 | 3 | 1663 | 1653 to 1667 | 0 | 244.64 | 527.99 | 7.85 | 124.5 | no |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 395 | n/a | 0 | 3.42 | 5.93 | 1.48 | 1.0 | no |
| 2 | 1 | 708 | n/a | 0 | 5.03 | 6.39 | 2.79 | 2.0 | no |
| 4 | 1 | 1123 | n/a | 0 | 5.82 | 7.22 | 5.05 | 4.0 | no |
| 8 | 1 | 1535 | n/a | 0 | 8.70 | 13.22 | 7.42 | 7.9 | no |
| 16 | 1 | 1601 | n/a | 0 | 21.98 | 40.24 | 7.84 | 15.9 | no |
| 32 | 3 | 1606 | 1605 to 1606 | 0 | 44.23 | 87.43 | 7.85 | 31.7 | no |
| 64 | 1 | 1594 | n/a | 0 | 102.24 | 209.76 | 7.84 | 63.2 | no |
| 128 | 1 | 1601 | n/a | 0 | 252.67 | 530.28 | 7.87 | 125.0 | no |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 145 | n/a | 0 | 7.14 | 12.43 | 1.20 | 1.0 | no |
| 2 | 1 | 264 | n/a | 0 | 10.96 | 15.97 | 2.35 | 2.0 | no |
| 4 | 1 | 442 | n/a | 0 | 13.52 | 17.74 | 4.58 | 4.0 | no |
| 8 | 1 | 603 | n/a | 0 | 20.07 | 28.53 | 7.59 | 8.0 | no |
| 16 | 3 | 609 | 608 to 609 | 0 | 61.12 | 120.74 | 7.83 | 15.9 | no |
| 32 | 1 | 595 | n/a | 0 | 132.20 | 260.34 | 7.76 | 31.5 | no |
| 64 | 1 | 581 | n/a | 0 | 263.83 | 485.04 | 7.78 | 62.1 | no |
| 128 | 1 | 562 | n/a | 0 | 596.94 | 1235.15 | 7.79 | 119.7 | no |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 116 | n/a | 0 | 9.70 | 14.38 | 1.12 | 1.0 | no |
| 2 | 1 | 219 | n/a | 0 | 12.72 | 21.79 | 2.19 | 2.0 | no |
| 4 | 1 | 376 | n/a | 0 | 14.20 | 21.31 | 4.50 | 4.0 | no |
| 8 | 3 | 534 | 531 to 537 | 0 | 22.48 | 47.11 | 7.61 | 8.0 | no |
| 16 | 1 | 537 | n/a | 0 | 65.73 | 155.21 | 7.72 | 15.9 | no |
| 32 | 1 | 511 | n/a | 0 | 111.25 | 268.04 | 7.65 | 31.4 | no |
| 64 | 1 | 507 | n/a | 0 | 223.62 | 442.39 | 7.62 | 62.0 | no |
| 128 | 1 | 496 | n/a | 0 | 496.29 | 978.61 | 7.65 | 120.9 | no |

## Hybrid track

- Setup: BM25 over text fused with RQ-quantized dense vectors (full-precision rescore) via the hybrid operator (rankedFusion, alpha=0.5)
- Fusion: rankedFusion (alpha=0.5)

Retrieval quality vs human judgements:

| Dataset | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| beir/scifact/test | 0.6840 | 0.9577 | 0.6366 | 0.6460 |
| beir/nfcorpus/test | 0.3431 | 0.3194 | 0.1809 | 0.5562 |
| dbpedia-entities-openai-100k | n/a | n/a | n/a | n/a |
| dbpedia-entities-openai-1m | n/a | n/a | n/a | n/a |

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | On disk | Peak heap | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 1701 | 3.05 | n/a | 0.62 GB | n/a | n/a | n/a |
| beir/nfcorpus/test | 3633 | 1429 | 2.54 | n/a | 0.61 GB | n/a | n/a | n/a |
| dbpedia-entities-openai-100k | 100000 | 664 | 150.63 | n/a | 2.59 GB | n/a | n/a | n/a |
| dbpedia-entities-openai-1m | 995000 | 669 | 1487.62 | n/a | 7.09 GB | n/a | n/a | n/a |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 3.35 | 5.97 | 8.57 |
| beir/nfcorpus/test | 3.22 | 5.51 | 8.03 |
| dbpedia-entities-openai-100k | 7.75 | 8.40 | 15.20 |
| dbpedia-entities-openai-1m | 10.13 | 11.21 | 13.62 |

Engine container memory through the whole track, load included (anonymous memory is the heap the kernel cannot reclaim; charged memory adds the page cache of the engine's files):

| Dataset | Peak anonymous | Peak charged | Samples |
| --- | --- | --- | --- |
| beir/scifact/test | 0.62 GB | 0.71 GB | 509 |
| beir/nfcorpus/test | 0.61 GB | 0.70 GB | 510 |
| dbpedia-entities-openai-100k | 2.59 GB | 3.75 GB | 1356 |
| dbpedia-entities-openai-1m | 7.09 GB | 20.70 GB | 4102 |

Server-side time source per dataset:

- beir/scifact/test: client round-trip only (no server-side query time exposed)
- beir/nfcorpus/test: client round-trip only (no server-side query time exposed)
- dbpedia-entities-openai-100k: client round-trip only (no server-side query time exposed)
- dbpedia-entities-openai-1m: client round-trip only (no server-side query time exposed)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 283 | n/a | 0 | 5.90 | 8.90 | 2.66 | 1.0 | no |
| 2 | 1 | 461 | n/a | 0 | 8.15 | 10.26 | 4.52 | 2.0 | no |
| 4 | 1 | 636 | n/a | 0 | 10.17 | 14.11 | 6.51 | 4.0 | no |
| 8 | 1 | 752 | n/a | 0 | 16.87 | 25.91 | 7.88 | 8.0 | no |
| 16 | 1 | 763 | n/a | 0 | 43.33 | 75.16 | 7.88 | 15.9 | no |
| 32 | 3 | 781 | 779 to 792 | 0 | 80.74 | 140.61 | 7.89 | 31.6 | no |
| 64 | 1 | 772 | n/a | 0 | 186.62 | 326.74 | 7.90 | 62.4 | no |
| 128 | 1 | 760 | n/a | 0 | 450.64 | 934.25 | 7.91 | 120.1 | no |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 299 | n/a | 0 | 5.48 | 8.55 | 2.42 | 1.0 | no |
| 2 | 1 | 492 | n/a | 0 | 7.50 | 9.38 | 4.18 | 2.0 | no |
| 4 | 1 | 712 | n/a | 0 | 9.34 | 12.91 | 6.36 | 4.0 | no |
| 8 | 1 | 853 | n/a | 0 | 15.42 | 24.15 | 7.73 | 8.0 | no |
| 16 | 1 | 868 | n/a | 0 | 39.80 | 73.81 | 7.86 | 15.9 | no |
| 32 | 1 | 858 | n/a | 0 | 74.78 | 133.81 | 7.88 | 31.7 | no |
| 64 | 1 | 952 | n/a | 0 | 154.33 | 301.73 | 7.89 | 62.7 | no |
| 128 | 3 | 953 | 952 to 955 | 0 | 362.76 | 723.46 | 7.90 | 122.7 | no |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 128 | n/a | 0 | 8.14 | 14.08 | 1.57 | 1.0 | no |
| 2 | 1 | 227 | n/a | 0 | 11.86 | 16.08 | 2.96 | 2.0 | no |
| 4 | 1 | 367 | n/a | 0 | 15.95 | 20.88 | 5.43 | 4.0 | no |
| 8 | 3 | 478 | 477 to 479 | 0 | 25.15 | 33.94 | 7.84 | 7.9 | no |
| 16 | 1 | 477 | n/a | 0 | 77.41 | 139.59 | 7.91 | 15.8 | no |
| 32 | 1 | 466 | n/a | 0 | 165.10 | 282.53 | 7.89 | 31.3 | no |
| 64 | 1 | 454 | n/a | 0 | 291.18 | 481.28 | 7.87 | 61.8 | no |
| 128 | 1 | 433 | n/a | 0 | 758.37 | 1442.52 | 7.86 | 117.5 | no |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 101 | n/a | 0 | 10.93 | 14.58 | 1.73 | 1.0 | no |
| 2 | 1 | 184 | n/a | 0 | 14.09 | 23.46 | 3.25 | 2.0 | no |
| 4 | 1 | 301 | n/a | 0 | 16.27 | 31.90 | 5.80 | 4.0 | no |
| 8 | 3 | 371 | 369 to 374 | 0 | 31.40 | 62.14 | 7.86 | 7.9 | no |
| 16 | 1 | 372 | n/a | 0 | 88.70 | 159.32 | 7.89 | 15.9 | no |
| 32 | 1 | 368 | n/a | 0 | 138.80 | 540.90 | 7.89 | 31.3 | no |
| 64 | 1 | 353 | n/a | 0 | 295.88 | 592.29 | 7.87 | 60.6 | no |
| 128 | 1 | 344 | n/a | 0 | 589.38 | 1649.49 | 7.90 | 115.3 | no |
