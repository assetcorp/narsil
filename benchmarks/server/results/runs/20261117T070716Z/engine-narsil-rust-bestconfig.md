# narsil-rust retrieval (keyword, vector, hybrid, best-config vector profile)

## Environment

- Captured: 2026-11-17T09:06:01.492843+00:00
- Load machine: GCP c3-standard-8, us-east1-b
- OS / arch: Linux 7.0.0-1017-gcp / x86_64 (containerized: True)
- CPU: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical)
- Memory: 33.6 GB
- Engine machine label: GCP c3-standard-8, us-east1-b
- Engine machine: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical), 33.6 GB
- Network round trip to the engine machine: p50 0.080 ms, p99 0.122 ms over 200 TCP connects
- Memory cap per engine: 21.5 GB
- Tracks: keyword, vector, hybrid
- Keyword setup: BM25 k1=0.9 b=0.4; language english, as the server reports it
- Run depth: 1000; run tag: narsil_rust_bm25
- Engine build: version 0.4.3, commit d3efdcbcb2d2
- Engine image: ir-benchmark-engine-narsil-rust@sha256:be067e08a682414ea143df364953ecb90d1ed0f63712bc4c54f68c121b9a476e
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
| beir/scifact/test | efSearch | 16 | 0.9937 | yes | 16 | 0.9937 |
| beir/nfcorpus/test | efSearch | 128 | 0.9916 | yes | 16 | 0.9706 |
| dbpedia-entities-openai-100k | efSearch | 128 | 0.9911 | yes | 32 | 0.9618 |
| dbpedia-entities-openai-1m | efSearch | 288 | 0.9914 | yes | 64 | 0.9628 |

Latency is measured at the operating point.

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | On disk | Peak heap | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 2327 | 2.23 | 0.00 GB | 1.06 GB | 0.10 | 0.12 | 0.13 |
| beir/nfcorpus/test | 3633 | 1982 | 1.83 | 0.00 GB | 0.56 GB | 0.14 | 0.16 | 0.17 |
| dbpedia-entities-openai-100k | 100000 | 879 | 113.73 | 0.79 GB | 2.79 GB | 0.46 | 0.63 | 0.71 |
| dbpedia-entities-openai-1m | 995000 | 882 | 1128.44 | 7.19 GB | 9.76 GB | 1.51 | 2.03 | 2.17 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 1.00 | 1.14 | 1.24 |
| beir/nfcorpus/test | 1.06 | 1.20 | 1.29 |
| dbpedia-entities-openai-100k | 2.30 | 2.52 | 2.66 |
| dbpedia-entities-openai-1m | 3.39 | 3.93 | 4.09 |

Engine container memory through the whole track, load included (anonymous memory is the heap the kernel cannot reclaim; charged memory adds the page cache of the engine's files):

| Dataset | Peak anonymous | Peak charged | Samples |
| --- | --- | --- | --- |
| beir/scifact/test | 1.06 GB | 1.07 GB | 385 |
| beir/nfcorpus/test | 0.56 GB | 0.57 GB | 503 |
| dbpedia-entities-openai-100k | 2.79 GB | 4.84 GB | 842 |
| dbpedia-entities-openai-1m | 9.76 GB | 18.47 GB | 3450 |

Server-side time source per dataset:

- beir/scifact/test: response `elapsed` field (floating-millisecond resolution)
- beir/nfcorpus/test: response `elapsed` field (floating-millisecond resolution)
- dbpedia-entities-openai-100k: response `elapsed` field (floating-millisecond resolution)
- dbpedia-entities-openai-1m: response `elapsed` field (floating-millisecond resolution)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 963 | n/a | 0 | 1.15 | 1.34 | 0.29 | 1.0 | no |
| 2 | 1 | 1960 | n/a | 0 | 1.14 | 1.36 | 0.56 | 2.0 | no |
| 4 | 3 | 3778 | 3727 to 3784 | 0 | 1.19 | 1.70 | 1.11 | 4.0 | no |
| 8 | 1 | 3223 | n/a | 0 | 3.47 | 4.22 | 1.01 | 8.0 | yes |
| 16 | 1 | 3036 | n/a | 0 | 8.74 | 24.87 | 0.96 | 16.0 | yes |
| 32 | 1 | 2789 | n/a | 0 | 18.19 | 36.47 | 0.83 | 31.9 | yes |
| 64 | 1 | 2669 | n/a | 0 | 40.88 | 74.64 | 0.79 | 63.5 | yes |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 931 | n/a | 0 | 1.18 | 1.43 | 0.31 | 1.0 | no |
| 2 | 1 | 1802 | n/a | 0 | 1.24 | 1.49 | 0.62 | 2.0 | no |
| 4 | 3 | 3552 | 3516 to 3572 | 0 | 1.29 | 1.84 | 1.22 | 4.0 | no |
| 8 | 1 | 3204 | n/a | 0 | 3.58 | 4.40 | 1.18 | 8.0 | yes |
| 16 | 1 | 3007 | n/a | 0 | 8.75 | 25.63 | 1.12 | 16.0 | yes |
| 32 | 1 | 2754 | n/a | 0 | 18.32 | 41.16 | 0.97 | 31.9 | yes |
| 64 | 1 | 2594 | n/a | 0 | 41.97 | 72.82 | 0.93 | 63.5 | yes |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 426 | n/a | 0 | 2.51 | 2.95 | 0.32 | 1.0 | no |
| 2 | 1 | 859 | n/a | 0 | 2.47 | 3.32 | 0.64 | 2.0 | no |
| 4 | 1 | 1669 | n/a | 0 | 2.65 | 3.77 | 1.25 | 4.0 | no |
| 8 | 1 | 1603 | n/a | 0 | 7.48 | 9.25 | 1.29 | 8.0 | no |
| 16 | 3 | 1670 | 1666 to 1673 | 0 | 15.83 | 98.12 | 1.40 | 16.0 | yes |
| 32 | 1 | 1599 | n/a | 0 | 31.63 | 109.47 | 1.32 | 31.8 | yes |
| 64 | 1 | 1545 | n/a | 0 | 69.70 | 146.20 | 1.28 | 63.3 | yes |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 311 | n/a | 0 | 3.73 | 4.04 | 0.51 | 1.0 | no |
| 2 | 1 | 623 | n/a | 0 | 3.75 | 4.30 | 1.00 | 2.0 | no |
| 4 | 1 | 1201 | n/a | 0 | 3.96 | 4.92 | 2.02 | 4.0 | no |
| 8 | 1 | 1412 | n/a | 0 | 8.34 | 10.33 | 2.53 | 8.0 | no |
| 16 | 3 | 1642 | 1642 to 1645 | 0 | 15.98 | 96.79 | 2.89 | 16.0 | yes |
| 32 | 1 | 1607 | n/a | 0 | 32.57 | 112.88 | 2.83 | 31.8 | yes |
| 64 | 1 | 1527 | n/a | 0 | 71.64 | 152.99 | 2.83 | 63.3 | yes |

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
| beir/scifact/test | 5183 | 2232 | 2.32 | 0.00 GB | 0.60 GB | 0.17 | 0.22 | 0.25 |
| beir/nfcorpus/test | 3633 | 1974 | 1.84 | 0.00 GB | 0.55 GB | 0.18 | 0.20 | 0.22 |
| dbpedia-entities-openai-100k | 100000 | 877 | 114.02 | 0.79 GB | 2.78 GB | 0.53 | 0.70 | 0.81 |
| dbpedia-entities-openai-1m | 995000 | 878 | 1132.66 | 7.19 GB | 9.78 GB | 1.92 | 2.83 | 3.39 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 1.13 | 1.28 | 1.44 |
| beir/nfcorpus/test | 1.11 | 1.26 | 1.34 |
| dbpedia-entities-openai-100k | 2.37 | 2.60 | 2.75 |
| dbpedia-entities-openai-1m | 3.80 | 4.72 | 5.30 |

Engine container memory through the whole track, load included (anonymous memory is the heap the kernel cannot reclaim; charged memory adds the page cache of the engine's files):

| Dataset | Peak anonymous | Peak charged | Samples |
| --- | --- | --- | --- |
| beir/scifact/test | 0.60 GB | 0.63 GB | 346 |
| beir/nfcorpus/test | 0.55 GB | 0.57 GB | 347 |
| dbpedia-entities-openai-100k | 2.78 GB | 4.83 GB | 655 |
| dbpedia-entities-openai-1m | 9.78 GB | 18.41 GB | 2926 |

Server-side time source per dataset:

- beir/scifact/test: response `elapsed` field (floating-millisecond resolution)
- beir/nfcorpus/test: response `elapsed` field (floating-millisecond resolution)
- dbpedia-entities-openai-100k: response `elapsed` field (floating-millisecond resolution)
- dbpedia-entities-openai-1m: response `elapsed` field (floating-millisecond resolution)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 868 | n/a | 0 | 1.28 | 1.64 | 0.34 | 1.0 | no |
| 2 | 1 | 1783 | n/a | 0 | 1.25 | 1.48 | 0.66 | 2.0 | no |
| 4 | 3 | 3493 | 3493 to 3541 | 0 | 1.28 | 1.75 | 1.32 | 4.0 | no |
| 8 | 1 | 3139 | n/a | 0 | 3.78 | 4.50 | 1.32 | 8.0 | yes |
| 16 | 1 | 3027 | n/a | 0 | 8.70 | 24.59 | 1.28 | 16.0 | yes |
| 32 | 1 | 2782 | n/a | 0 | 18.35 | 36.65 | 1.08 | 31.9 | yes |
| 64 | 1 | 2592 | n/a | 0 | 41.68 | 72.38 | 1.03 | 63.5 | yes |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 890 | n/a | 0 | 1.25 | 1.54 | 0.33 | 1.0 | no |
| 2 | 1 | 1768 | n/a | 0 | 1.26 | 1.54 | 0.64 | 2.0 | no |
| 4 | 3 | 3407 | 3379 to 3415 | 0 | 1.33 | 1.90 | 1.31 | 4.0 | no |
| 8 | 1 | 3077 | n/a | 0 | 3.79 | 4.55 | 1.27 | 8.0 | yes |
| 16 | 1 | 2997 | n/a | 0 | 8.73 | 28.02 | 1.25 | 16.0 | yes |
| 32 | 1 | 2753 | n/a | 0 | 18.16 | 38.24 | 1.07 | 31.9 | yes |
| 64 | 1 | 2575 | n/a | 0 | 42.49 | 78.54 | 0.99 | 63.6 | yes |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 407 | n/a | 0 | 2.63 | 2.94 | 0.35 | 1.0 | no |
| 2 | 1 | 819 | n/a | 0 | 2.64 | 3.10 | 0.67 | 2.0 | no |
| 4 | 1 | 1643 | n/a | 0 | 2.68 | 3.79 | 1.31 | 4.0 | no |
| 8 | 1 | 1594 | n/a | 0 | 7.50 | 11.02 | 1.42 | 8.0 | no |
| 16 | 3 | 1663 | 1661 to 1663 | 0 | 15.85 | 97.62 | 1.56 | 16.0 | yes |
| 32 | 1 | 1588 | n/a | 0 | 30.98 | 118.44 | 1.45 | 31.8 | yes |
| 64 | 1 | 1539 | n/a | 0 | 70.08 | 160.27 | 1.42 | 63.3 | yes |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 265 | n/a | 0 | 4.69 | 6.95 | 0.58 | 1.0 | no |
| 2 | 1 | 531 | n/a | 0 | 4.64 | 6.91 | 1.15 | 2.0 | no |
| 4 | 1 | 1018 | n/a | 0 | 4.98 | 8.64 | 2.32 | 4.0 | no |
| 8 | 1 | 1301 | n/a | 0 | 8.96 | 11.68 | 3.20 | 8.0 | no |
| 16 | 1 | 1614 | n/a | 0 | 15.93 | 94.04 | 4.14 | 16.0 | yes |
| 32 | 3 | 1656 | 1651 to 1663 | 0 | 33.15 | 115.69 | 4.30 | 31.8 | yes |
| 64 | 1 | 1527 | n/a | 0 | 71.00 | 162.86 | 3.98 | 63.3 | yes |
