# narsil retrieval (keyword, vector, hybrid, best-config vector profile)

## Environment

- Captured: 2026-11-17T09:24:58.907007+00:00
- Load machine: GCP c3-standard-8, us-central1-a
- OS / arch: Linux 7.0.0-1017-gcp / x86_64 (containerized: True)
- CPU: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical)
- Memory: 33.6 GB
- Engine machine label: GCP c3-standard-8, us-central1-a
- Engine machine: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical), 33.6 GB
- Network round trip to the engine machine: p50 0.083 ms, p99 0.159 ms over 200 TCP connects
- Memory cap per engine: 21.5 GB
- Tracks: keyword, vector, hybrid
- Keyword setup: BM25 k1=0.9 b=0.4; language english, as the server reports it
- Run depth: 1000; run tag: narsil_bm25
- Engine build: version 0.4.3, commit d3efdcbcb2d2
- Engine image: ir-benchmark-engine-narsil@sha256:141d1d0a2b0619b1a68a8df5bbabdc6e7f6f8da6d51e43ef2106d1eefbdb9049
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
| beir/scifact/test | efSearch | 16 | 0.9920 | yes | 16 | 0.9920 |
| beir/nfcorpus/test | efSearch | 128 | 0.9929 | yes | 16 | 0.9749 |
| dbpedia-entities-openai-100k | efSearch | 16 | 1.0000 | yes | 16 | 0.9999 |
| dbpedia-entities-openai-1m | efSearch | 256 | 0.9915 | yes | 64 | 0.9647 |

Latency is measured at the operating point.

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | On disk | Peak heap | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 2035 | 2.55 | 0.00 GB | 5.17 GB | 0.13 | 0.16 | 0.24 |
| beir/nfcorpus/test | 3633 | 1628 | 2.23 | 0.00 GB | 4.73 GB | 0.17 | 0.20 | 0.25 |
| dbpedia-entities-openai-100k | 100000 | 852 | 117.39 | 0.80 GB | 4.03 GB | 106.55 | 112.81 | 120.28 |
| dbpedia-entities-openai-1m | 995000 | 569 | 1748.94 | 7.98 GB | 11.52 GB | 1.19 | 1.55 | 1.68 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 1.05 | 1.22 | 1.37 |
| beir/nfcorpus/test | 1.08 | 1.24 | 1.35 |
| dbpedia-entities-openai-100k | 208.71 | 216.34 | 222.43 |
| dbpedia-entities-openai-1m | 3.05 | 3.45 | 3.67 |

Engine container memory through the whole track, load included (anonymous memory is the heap the kernel cannot reclaim; charged memory adds the page cache of the engine's files):

| Dataset | Peak anonymous | Peak charged | Samples |
| --- | --- | --- | --- |
| beir/scifact/test | 5.17 GB | 5.19 GB | 388 |
| beir/nfcorpus/test | 4.73 GB | 4.78 GB | 506 |
| dbpedia-entities-openai-100k | 4.03 GB | 5.97 GB | 5685 |
| dbpedia-entities-openai-1m | 11.52 GB | 21.47 GB | 5324 |

Server-side time source per dataset:

- beir/scifact/test: response `elapsed` field (floating-millisecond resolution)
- beir/nfcorpus/test: response `elapsed` field (floating-millisecond resolution)
- dbpedia-entities-openai-100k: response `elapsed` field (floating-millisecond resolution)
- dbpedia-entities-openai-1m: response `elapsed` field (floating-millisecond resolution)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 912 | n/a | 0 | 1.18 | 11.38 | 0.37 | 1.0 | no |
| 2 | 1 | 1764 | n/a | 0 | 1.26 | 14.53 | 0.85 | 2.0 | no |
| 4 | 3 | 3380 | 3377 to 3389 | 0 | 1.32 | 12.34 | 1.63 | 4.0 | no |
| 8 | 1 | 3195 | n/a | 0 | 3.79 | 22.21 | 1.82 | 8.0 | yes |
| 16 | 1 | 3037 | n/a | 0 | 8.66 | 28.22 | 1.65 | 16.0 | yes |
| 32 | 1 | 2780 | n/a | 0 | 18.23 | 38.21 | 1.42 | 31.9 | yes |
| 64 | 1 | 2618 | n/a | 0 | 41.28 | 78.77 | 1.36 | 63.5 | yes |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 870 | n/a | 0 | 1.24 | 19.48 | 0.39 | 1.0 | no |
| 2 | 1 | 1671 | n/a | 0 | 1.30 | 16.20 | 0.82 | 2.0 | no |
| 4 | 3 | 3175 | 3133 to 3210 | 0 | 1.42 | 20.04 | 1.69 | 4.0 | no |
| 8 | 1 | 3030 | n/a | 0 | 3.89 | 24.68 | 1.81 | 8.0 | yes |
| 16 | 1 | 3035 | n/a | 0 | 8.66 | 55.09 | 1.82 | 16.0 | yes |
| 32 | 1 | 2777 | n/a | 0 | 18.20 | 57.64 | 1.62 | 31.9 | yes |
| 64 | 1 | 2611 | n/a | 0 | 42.16 | 75.34 | 1.52 | 63.5 | yes |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 5 | n/a | 0 | 218.93 | 219.96 | 1.27 | 1.0 | no |
| 2 | 3 | 8 | 8 to 8 | 0 | 241.07 | 346.39 | 2.33 | 1.9 | no |
| 4 | 1 | 8 | n/a | 0 | 470.41 | 582.90 | 2.38 | 3.5 | no |
| 8 | 1 | 7 | n/a | 0 | 938.33 | 1190.53 | 2.38 | 6.2 | yes |
| 16 | 1 | 6 | n/a | 0 | 2020.73 | 2241.05 | 2.42 | 9.8 | yes |
| 32 | 1 | 3 | n/a | 151 (86.8%) | 3903.32 | 3962.92 | 6.14 | 7.9 | yes |
| 64 | 1 | 3 | n/a | 152 (87.4%) | 3834.99 | 3915.42 | 6.40 | 7.4 | yes |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 258 | n/a | 0 | 3.54 | 9.39 | 1.03 | 1.0 | no |
| 2 | 1 | 662 | n/a | 0 | 3.48 | 4.34 | 1.21 | 2.0 | no |
| 4 | 1 | 1270 | n/a | 0 | 3.83 | 6.48 | 2.43 | 4.0 | no |
| 8 | 1 | 1416 | n/a | 0 | 8.13 | 11.22 | 2.94 | 7.8 | no |
| 16 | 3 | 1649 | 1646 to 1650 | 0 | 15.87 | 97.32 | 3.34 | 16.0 | yes |
| 32 | 1 | 1627 | n/a | 0 | 33.03 | 109.89 | 3.20 | 31.8 | yes |
| 64 | 1 | 1528 | n/a | 0 | 70.81 | 155.24 | 3.26 | 63.3 | yes |

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
| beir/scifact/test | 5183 | 1782 | 2.91 | 0.03 GB | 4.84 GB | 0.25 | 0.32 | 0.36 |
| beir/nfcorpus/test | 3633 | 1632 | 2.23 | 0.00 GB | 2.55 GB | 0.24 | 0.27 | 0.30 |
| dbpedia-entities-openai-100k | 100000 | 842 | 118.71 | 0.80 GB | 3.72 GB | 106.39 | 112.52 | 120.15 |
| dbpedia-entities-openai-1m | 995000 | 543 | 1833.22 | 7.98 GB | 11.30 GB | 1.84 | 3.03 | 3.91 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 1.22 | 1.39 | 1.53 |
| beir/nfcorpus/test | 1.19 | 1.33 | 1.41 |
| dbpedia-entities-openai-100k | 209.53 | 218.54 | 223.39 |
| dbpedia-entities-openai-1m | 3.77 | 4.99 | 5.94 |

Engine container memory through the whole track, load included (anonymous memory is the heap the kernel cannot reclaim; charged memory adds the page cache of the engine's files):

| Dataset | Peak anonymous | Peak charged | Samples |
| --- | --- | --- | --- |
| beir/scifact/test | 4.84 GB | 4.91 GB | 354 |
| beir/nfcorpus/test | 2.55 GB | 2.61 GB | 350 |
| dbpedia-entities-openai-100k | 3.72 GB | 5.82 GB | 5679 |
| dbpedia-entities-openai-1m | 11.30 GB | 21.47 GB | 5170 |

Server-side time source per dataset:

- beir/scifact/test: response `elapsed` field (floating-millisecond resolution)
- beir/nfcorpus/test: response `elapsed` field (floating-millisecond resolution)
- dbpedia-entities-openai-100k: response `elapsed` field (floating-millisecond resolution)
- dbpedia-entities-openai-1m: response `elapsed` field (floating-millisecond resolution)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 778 | n/a | 0 | 1.38 | 11.35 | 0.47 | 1.0 | no |
| 2 | 1 | 1578 | n/a | 0 | 1.37 | 19.38 | 0.92 | 2.0 | no |
| 4 | 1 | 2798 | n/a | 0 | 1.65 | 20.40 | 2.10 | 4.0 | no |
| 8 | 1 | 2906 | n/a | 0 | 4.01 | 25.99 | 2.23 | 8.0 | no |
| 16 | 3 | 3009 | 2992 to 3011 | 0 | 8.76 | 46.93 | 2.20 | 16.0 | yes |
| 32 | 1 | 2748 | n/a | 0 | 18.44 | 62.84 | 1.94 | 31.9 | yes |
| 64 | 1 | 2572 | n/a | 0 | 42.29 | 77.09 | 1.78 | 63.4 | yes |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 800 | n/a | 0 | 1.33 | 14.89 | 0.45 | 1.0 | no |
| 2 | 1 | 1569 | n/a | 0 | 1.37 | 18.28 | 0.93 | 2.0 | no |
| 4 | 1 | 2870 | n/a | 0 | 1.48 | 20.47 | 1.91 | 3.9 | no |
| 8 | 1 | 2966 | n/a | 0 | 3.92 | 26.82 | 2.19 | 8.0 | no |
| 16 | 3 | 3012 | 3012 to 3026 | 0 | 8.67 | 55.88 | 2.13 | 16.0 | yes |
| 32 | 1 | 2760 | n/a | 0 | 18.24 | 60.86 | 1.90 | 31.9 | yes |
| 64 | 1 | 2597 | n/a | 0 | 41.95 | 80.90 | 1.78 | 63.5 | yes |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 5 | n/a | 0 | 221.27 | 238.42 | 1.32 | 1.0 | no |
| 2 | 3 | 8 | 8 to 8 | 0 | 241.53 | 344.94 | 2.35 | 1.9 | no |
| 4 | 1 | 8 | n/a | 0 | 476.14 | 601.02 | 2.40 | 3.5 | no |
| 8 | 1 | 7 | n/a | 0 | 931.36 | 1173.97 | 2.41 | 6.2 | yes |
| 16 | 1 | 6 | n/a | 0 | 2042.05 | 2231.79 | 2.47 | 9.6 | yes |
| 32 | 1 | 3 | n/a | 151 (86.3%) | 3715.07 | 3762.98 | 6.21 | 8.4 | yes |
| 64 | 1 | 3 | n/a | 153 (86.9%) | 4210.22 | 4240.32 | 6.40 | 8.0 | yes |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 267 | n/a | 0 | 4.82 | 7.38 | 0.67 | 1.0 | no |
| 2 | 1 | 527 | n/a | 0 | 4.97 | 7.71 | 1.40 | 2.0 | no |
| 4 | 1 | 1015 | n/a | 0 | 5.35 | 8.82 | 2.84 | 4.0 | no |
| 8 | 1 | 1284 | n/a | 0 | 9.35 | 14.60 | 4.00 | 8.0 | no |
| 16 | 1 | 1597 | n/a | 0 | 16.19 | 96.93 | 4.88 | 15.9 | yes |
| 32 | 3 | 1646 | 1644 to 1647 | 0 | 32.75 | 119.55 | 5.00 | 31.8 | yes |
| 64 | 1 | 1502 | n/a | 0 | 70.62 | 161.26 | 4.74 | 63.2 | yes |
