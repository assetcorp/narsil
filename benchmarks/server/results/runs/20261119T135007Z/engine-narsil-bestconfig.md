# narsil retrieval (keyword, vector, hybrid, best-config vector profile)

## Environment

- Captured: 2026-11-19T15:38:27.659580+00:00
- Load machine: GCP c3-standard-8, us-central1-a
- OS / arch: Linux 7.0.0-1017-gcp / x86_64 (containerized: True)
- CPU: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical)
- Memory: 33.6 GB
- Engine machine label: GCP c3-standard-8, us-central1-a
- Engine machine: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical), 33.6 GB
- Network round trip to the engine machine: p50 0.088 ms, p99 0.169 ms over 200 TCP connects
- Memory cap per engine: 21.5 GB
- Tracks: keyword, vector, hybrid
- Keyword setup: BM25 k1=0.9 b=0.4; language english, as the server reports it
- Run depth: 1000; run tag: narsil_bm25
- Engine build: version 0.4.5, commit 3ad47df2c9c1
- Engine image: ir-benchmark-engine-narsil@sha256:ba607a6c7326ee3d66fa9a6f1a4bd5a87744196ffa69fc5b6b195afa39e9a0f3
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
| beir/scifact/test | efSearch | 16 | 0.9927 | yes | 16 | 0.9927 |
| beir/nfcorpus/test | efSearch | 128 | 0.9929 | yes | 16 | 0.9755 |
| dbpedia-entities-openai-100k | efSearch | 128 | 0.9918 | yes | 32 | 0.9605 |
| dbpedia-entities-openai-1m | efSearch | 256 | 0.9921 | yes | 64 | 0.9623 |

Latency is measured at the operating point.

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | On disk | Peak heap | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 2100 | 2.47 | 0.03 GB | 5.60 GB | 0.12 | 0.17 | 0.22 |
| beir/nfcorpus/test | 3633 | 1562 | 2.33 | 0.02 GB | 5.07 GB | 0.17 | 0.19 | 0.23 |
| dbpedia-entities-openai-100k | 100000 | 818 | 122.20 | 0.80 GB | 5.31 GB | 0.46 | 0.59 | 0.69 |
| dbpedia-entities-openai-1m | 995000 | 542 | 1835.54 | 7.98 GB | 10.81 GB | 1.15 | 1.51 | 1.64 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 0.39 | 0.56 | 0.76 |
| beir/nfcorpus/test | 0.43 | 0.51 | 0.80 |
| dbpedia-entities-openai-100k | 0.86 | 1.08 | 1.38 |
| dbpedia-entities-openai-1m | 1.58 | 1.99 | 2.33 |

Engine container memory through the whole track, load included (anonymous memory is the heap the kernel cannot reclaim; charged memory adds the page cache of the engine's files):

| Dataset | Peak anonymous | Peak charged | Samples |
| --- | --- | --- | --- |
| beir/scifact/test | 5.60 GB | 5.64 GB | 541 |
| beir/nfcorpus/test | 5.07 GB | 5.11 GB | 700 |
| dbpedia-entities-openai-100k | 5.31 GB | 7.22 GB | 1545 |
| dbpedia-entities-openai-1m | 10.81 GB | 21.47 GB | 6890 |

Server-side time source per dataset:

- beir/scifact/test: response `elapsed` field (floating-millisecond resolution)
- beir/nfcorpus/test: response `elapsed` field (floating-millisecond resolution)
- dbpedia-entities-openai-100k: response `elapsed` field (floating-millisecond resolution)
- dbpedia-entities-openai-1m: response `elapsed` field (floating-millisecond resolution)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 2903 | n/a | 0 | 0.36 | 1.32 | 0.91 | 0.9 | no |
| 2 | 1 | 5150 | n/a | 0 | 0.41 | 1.30 | 1.67 | 1.8 | no |
| 4 | 1 | 8912 | n/a | 0 | 0.55 | 2.12 | 3.59 | 3.7 | no |
| 8 | 1 | 11154 | n/a | 0 | 1.21 | 16.45 | 6.51 | 7.5 | no |
| 16 | 1 | 15418 | n/a | 0 | 2.17 | 42.45 | 7.93 | 15.2 | no |
| 32 | 3 | 15809 | 15756 to 15840 | 0 | 4.35 | 58.43 | 7.93 | 31.2 | no |
| 64 | 1 | 15792 | n/a | 0 | 6.93 | 77.39 | 7.92 | 62.9 | no |
| 128 | 1 | 15766 | n/a | 0 | 13.46 | 93.68 | 7.92 | 126.8 | no |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 2418 | n/a | 0 | 0.42 | 1.24 | 0.87 | 0.9 | no |
| 2 | 1 | 4296 | n/a | 0 | 0.51 | 12.18 | 1.81 | 1.9 | no |
| 4 | 1 | 7907 | n/a | 0 | 0.61 | 11.85 | 3.71 | 3.7 | no |
| 8 | 1 | 9922 | n/a | 0 | 1.30 | 20.66 | 6.56 | 7.5 | no |
| 16 | 1 | 13168 | n/a | 0 | 2.49 | 43.57 | 7.94 | 15.4 | no |
| 32 | 1 | 13050 | n/a | 0 | 4.95 | 70.42 | 7.93 | 31.1 | no |
| 64 | 1 | 13136 | n/a | 0 | 8.57 | 80.39 | 7.91 | 62.5 | no |
| 128 | 3 | 13309 | 13273 to 13336 | 0 | 16.25 | 97.12 | 7.92 | 126.7 | no |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 1025 | n/a | 0 | 0.98 | 50.69 | 1.11 | 1.0 | no |
| 2 | 1 | 2077 | n/a | 0 | 1.10 | 25.09 | 2.30 | 1.9 | no |
| 4 | 1 | 3725 | n/a | 0 | 1.27 | 52.48 | 4.69 | 3.9 | no |
| 8 | 1 | 4852 | n/a | 0 | 3.09 | 63.98 | 7.24 | 7.7 | no |
| 16 | 1 | 5412 | n/a | 0 | 5.24 | 74.51 | 7.93 | 15.7 | no |
| 32 | 1 | 5346 | n/a | 0 | 12.27 | 90.01 | 7.92 | 31.7 | no |
| 64 | 3 | 5522 | 5462 to 5536 | 0 | 23.84 | 114.61 | 7.93 | 63.3 | no |
| 128 | 1 | 4859 | n/a | 0 | 64.29 | 154.04 | 7.96 | 127.0 | no |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 654 | n/a | 0 | 1.86 | 4.08 | 1.13 | 1.0 | no |
| 2 | 1 | 1283 | n/a | 0 | 1.91 | 4.03 | 2.31 | 2.0 | no |
| 4 | 1 | 2387 | n/a | 0 | 2.31 | 7.47 | 4.67 | 3.9 | no |
| 8 | 1 | 3067 | n/a | 0 | 5.21 | 11.76 | 7.49 | 7.9 | no |
| 16 | 1 | 3152 | n/a | 0 | 10.24 | 26.22 | 7.97 | 15.8 | no |
| 32 | 1 | 3222 | n/a | 0 | 19.67 | 51.12 | 7.95 | 31.7 | no |
| 64 | 1 | 3200 | n/a | 0 | 35.55 | 72.06 | 7.95 | 63.4 | no |
| 128 | 3 | 3766 | 3586 to 3931 | 0 | 60.15 | 124.87 | 7.96 | 126.6 | no |

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
| beir/scifact/test | 5183 | 2012 | 2.58 | 0.00 GB | 5.18 GB | 0.24 | 0.32 | 0.37 |
| beir/nfcorpus/test | 3633 | 1626 | 2.23 | 0.00 GB | 2.85 GB | 0.25 | 0.30 | 0.37 |
| dbpedia-entities-openai-100k | 100000 | 812 | 123.12 | 0.80 GB | 5.06 GB | 0.58 | 0.76 | 0.91 |
| dbpedia-entities-openai-1m | 995000 | 572 | 1740.12 | 7.98 GB | 12.63 GB | 2.04 | 4.46 | 5.88 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 0.61 | 0.72 | 0.92 |
| beir/nfcorpus/test | 0.61 | 0.71 | 0.95 |
| dbpedia-entities-openai-100k | 1.02 | 1.31 | 1.62 |
| dbpedia-entities-openai-1m | 2.56 | 5.03 | 6.42 |

Engine container memory through the whole track, load included (anonymous memory is the heap the kernel cannot reclaim; charged memory adds the page cache of the engine's files):

| Dataset | Peak anonymous | Peak charged | Samples |
| --- | --- | --- | --- |
| beir/scifact/test | 5.18 GB | 5.24 GB | 488 |
| beir/nfcorpus/test | 2.85 GB | 2.91 GB | 486 |
| dbpedia-entities-openai-100k | 5.06 GB | 7.40 GB | 1170 |
| dbpedia-entities-openai-1m | 12.63 GB | 21.47 GB | 5077 |

Server-side time source per dataset:

- beir/scifact/test: response `elapsed` field (floating-millisecond resolution)
- beir/nfcorpus/test: response `elapsed` field (floating-millisecond resolution)
- dbpedia-entities-openai-100k: response `elapsed` field (floating-millisecond resolution)
- dbpedia-entities-openai-1m: response `elapsed` field (floating-millisecond resolution)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 1768 | n/a | 0 | 0.61 | 11.62 | 0.94 | 0.9 | no |
| 2 | 1 | 3742 | n/a | 0 | 0.62 | 1.67 | 1.85 | 1.9 | no |
| 4 | 1 | 6512 | n/a | 0 | 0.78 | 12.94 | 3.97 | 3.8 | no |
| 8 | 1 | 8665 | n/a | 0 | 1.45 | 21.97 | 6.71 | 7.6 | no |
| 16 | 1 | 10622 | n/a | 0 | 3.34 | 43.40 | 7.95 | 15.5 | no |
| 32 | 3 | 10572 | 10571 to 10709 | 0 | 5.69 | 69.04 | 7.92 | 31.3 | no |
| 64 | 1 | 10615 | n/a | 0 | 10.67 | 75.80 | 7.95 | 63.4 | no |
| 128 | 1 | 10654 | n/a | 0 | 19.82 | 95.39 | 7.94 | 126.3 | no |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 1931 | n/a | 0 | 0.54 | 11.62 | 1.00 | 0.9 | no |
| 2 | 1 | 3718 | n/a | 0 | 0.60 | 2.08 | 1.86 | 1.9 | no |
| 4 | 1 | 6622 | n/a | 0 | 0.74 | 12.67 | 3.86 | 3.8 | no |
| 8 | 1 | 8763 | n/a | 0 | 1.39 | 19.81 | 6.74 | 7.6 | no |
| 16 | 1 | 10698 | n/a | 0 | 3.04 | 51.11 | 7.95 | 15.5 | no |
| 32 | 1 | 10673 | n/a | 0 | 5.59 | 68.89 | 7.91 | 31.2 | no |
| 64 | 3 | 10784 | 10711 to 10926 | 0 | 10.32 | 92.12 | 7.93 | 63.3 | no |
| 128 | 1 | 10734 | n/a | 0 | 19.23 | 101.83 | 7.93 | 126.1 | no |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 985 | n/a | 0 | 1.15 | 15.08 | 1.15 | 1.0 | no |
| 2 | 1 | 1800 | n/a | 0 | 1.25 | 50.88 | 2.23 | 1.9 | no |
| 4 | 1 | 3216 | n/a | 0 | 1.54 | 51.84 | 4.69 | 3.9 | no |
| 8 | 1 | 4292 | n/a | 0 | 3.86 | 54.28 | 7.36 | 7.8 | no |
| 16 | 1 | 4571 | n/a | 0 | 5.80 | 84.55 | 7.96 | 15.8 | no |
| 32 | 3 | 4789 | 4749 to 4795 | 0 | 13.45 | 97.41 | 7.96 | 31.6 | no |
| 64 | 1 | 4767 | n/a | 0 | 27.43 | 116.18 | 7.94 | 63.4 | no |
| 128 | 1 | 4723 | n/a | 0 | 60.20 | 140.38 | 7.91 | 126.0 | no |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 474 | n/a | 0 | 2.99 | 5.52 | 1.12 | 1.0 | no |
| 2 | 1 | 890 | n/a | 0 | 3.31 | 6.13 | 2.27 | 2.0 | no |
| 4 | 1 | 1630 | n/a | 0 | 3.95 | 9.36 | 4.58 | 3.9 | no |
| 8 | 1 | 2136 | n/a | 0 | 7.46 | 14.76 | 7.57 | 7.9 | no |
| 16 | 1 | 2204 | n/a | 0 | 13.30 | 28.78 | 7.95 | 15.9 | no |
| 32 | 1 | 2257 | n/a | 0 | 26.82 | 58.61 | 7.98 | 31.7 | no |
| 64 | 1 | 2381 | n/a | 0 | 48.19 | 92.23 | 7.97 | 63.2 | no |
| 128 | 3 | 2492 | 2471 to 2508 | 0 | 87.46 | 163.31 | 7.95 | 125.6 | no |
