# narsil retrieval (keyword, vector, hybrid)

## Environment

- Captured: 2026-11-17T08:07:06.756764+00:00
- Load machine: GCP c3-standard-8, us-central1-a
- OS / arch: Linux 7.0.0-1017-gcp / x86_64 (containerized: True)
- CPU: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical)
- Memory: 33.6 GB
- Engine machine label: GCP c3-standard-8, us-central1-a
- Engine machine: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical), 33.6 GB
- Network round trip to the engine machine: p50 0.083 ms, p99 0.149 ms over 200 TCP connects
- Memory cap per engine: 21.5 GB
- Tracks: keyword, vector, hybrid
- Keyword setup: BM25 k1=0.9 b=0.4; language english, as the server reports it
- Run depth: 1000; run tag: narsil_bm25
- Engine build: version 0.4.3, commit d3efdcbcb2d2
- Engine image: ir-benchmark-engine-narsil@sha256:141d1d0a2b0619b1a68a8df5bbabdc6e7f6f8da6d51e43ef2106d1eefbdb9049
- Dataset beir/scifact/test: content md5 5f7d1de60b170fc8027bb7898e2efca1
- Dataset beir/nfcorpus/test: content md5 a89dba18a62ef92f7d323ec890a0d38d

## Keyword track

Retrieval quality vs Anserini BM25 reference:

| Dataset | nDCG@10 | Reference | Delta | Status | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 0.6814 | 0.6790 | +0.0024 | within margin | 0.9253 | 0.6417 | 0.6494 |
| beir/nfcorpus/test | 0.3283 | 0.3220 | +0.0063 | within margin | 0.2489 | 0.1535 | 0.5336 |
| dbpedia-entities-openai-100k | n/a | n/a | n/a | no baseline | n/a | n/a | n/a |
| dbpedia-entities-openai-1m | n/a | n/a | n/a | no baseline | n/a | n/a | n/a |

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | On disk | Peak heap | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 4455 | 1.16 | 0.00 GB | 0.75 GB | 0.10 | 0.19 | 0.25 |
| beir/nfcorpus/test | 3633 | 4290 | 0.85 | 0.01 GB | 0.75 GB | 0.05 | 0.18 | 0.23 |
| dbpedia-entities-openai-100k | 100000 | 19281 | 5.19 | 0.09 GB | 2.26 GB | 0.07 | 0.26 | 0.35 |
| dbpedia-entities-openai-1m | 995000 | 18837 | 52.82 | 0.94 GB | 6.39 GB | 0.95 | 2.41 | 3.76 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 0.72 | 0.92 | 1.05 |
| beir/nfcorpus/test | 0.62 | 0.83 | 0.96 |
| dbpedia-entities-openai-100k | 0.75 | 1.01 | 1.20 |
| dbpedia-entities-openai-1m | 1.69 | 3.29 | 5.22 |

Engine container memory through the whole track, load included (anonymous memory is the heap the kernel cannot reclaim; charged memory adds the page cache of the engine's files):

| Dataset | Peak anonymous | Peak charged | Samples |
| --- | --- | --- | --- |
| beir/scifact/test | 0.75 GB | 0.78 GB | 277 |
| beir/nfcorpus/test | 0.75 GB | 0.77 GB | 269 |
| dbpedia-entities-openai-100k | 2.26 GB | 2.40 GB | 367 |
| dbpedia-entities-openai-1m | 6.39 GB | 7.22 GB | 622 |

Server-side time source per dataset:

- beir/scifact/test: response `elapsed` field (floating-millisecond resolution)
- beir/nfcorpus/test: response `elapsed` field (floating-millisecond resolution)
- dbpedia-entities-openai-100k: response `elapsed` field (floating-millisecond resolution)
- dbpedia-entities-openai-1m: response `elapsed` field (floating-millisecond resolution)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 1494 | n/a | 0 | 0.80 | 1.13 | 0.35 | 1.0 | no |
| 2 | 1 | 2728 | n/a | 0 | 0.88 | 1.23 | 0.66 | 2.0 | no |
| 4 | 3 | 5152 | 5064 to 5450 | 0 | 0.99 | 1.43 | 1.24 | 4.0 | no |
| 8 | 1 | 4639 | n/a | 0 | 2.55 | 3.75 | 1.69 | 8.0 | yes |
| 16 | 1 | 4313 | n/a | 0 | 6.14 | 10.26 | 1.24 | 16.0 | yes |
| 32 | 1 | 3780 | n/a | 0 | 13.70 | 33.01 | 0.95 | 31.9 | yes |
| 64 | 1 | 3578 | n/a | 0 | 31.08 | 53.57 | 0.92 | 63.7 | yes |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 1683 | n/a | 0 | 0.73 | 1.00 | 0.22 | 1.0 | no |
| 2 | 1 | 3238 | n/a | 0 | 0.75 | 1.08 | 0.46 | 2.0 | no |
| 4 | 3 | 5867 | 5860 to 5936 | 0 | 0.83 | 1.28 | 1.01 | 4.0 | no |
| 8 | 1 | 4953 | n/a | 0 | 2.39 | 2.89 | 1.15 | 8.0 | yes |
| 16 | 1 | 4332 | n/a | 0 | 6.15 | 10.05 | 0.93 | 16.0 | yes |
| 32 | 1 | 3805 | n/a | 0 | 13.47 | 28.82 | 0.79 | 31.9 | yes |
| 64 | 1 | 3437 | n/a | 0 | 31.28 | 57.72 | 0.65 | 63.6 | yes |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 1509 | n/a | 0 | 0.85 | 1.19 | 0.29 | 1.0 | no |
| 2 | 1 | 2872 | n/a | 0 | 0.91 | 1.32 | 0.59 | 2.0 | no |
| 4 | 3 | 5380 | 5311 to 5561 | 0 | 0.96 | 1.49 | 1.29 | 4.0 | no |
| 8 | 1 | 4674 | n/a | 0 | 2.54 | 3.64 | 1.55 | 8.0 | yes |
| 16 | 1 | 4316 | n/a | 0 | 6.14 | 10.58 | 1.19 | 16.0 | yes |
| 32 | 1 | 3801 | n/a | 0 | 13.54 | 31.85 | 0.99 | 31.9 | yes |
| 64 | 1 | 3492 | n/a | 0 | 31.26 | 58.17 | 0.93 | 63.6 | yes |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 726 | n/a | 0 | 2.37 | 6.09 | 3.27 | 1.0 | no |
| 2 | 1 | 1776 | n/a | 0 | 2.04 | 5.51 | 2.59 | 2.0 | no |
| 4 | 1 | 3040 | n/a | 0 | 2.51 | 6.36 | 3.62 | 4.0 | no |
| 8 | 1 | 3790 | n/a | 0 | 3.80 | 8.66 | 4.57 | 8.0 | no |
| 16 | 3 | 4265 | 4235 to 4278 | 0 | 6.40 | 14.69 | 4.77 | 16.0 | yes |
| 32 | 1 | 3983 | n/a | 0 | 13.38 | 29.42 | 4.36 | 31.9 | yes |
| 64 | 1 | 3433 | n/a | 0 | 31.66 | 57.40 | 3.91 | 63.6 | yes |

## Vector track

- Embedding model: sentence-transformers/all-MiniLM-L6-v2 (384 dim, cosine)
- Index setup: HNSW over the shared precomputed vectors, full precision (quantization off), cosine
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
| beir/scifact/test | efSearch | 64 | 0.9967 | yes | 16 | 1.0000 |
| beir/nfcorpus/test | efSearch | 128 | 0.9932 | yes | 32 | 0.9502 |
| dbpedia-entities-openai-100k | efSearch | 128 | 0.9917 | yes | 32 | 0.9625 |
| dbpedia-entities-openai-1m | efSearch | 288 | 0.9926 | yes | 64 | 0.9626 |

Latency is measured at the operating point.

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | On disk | Peak heap | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 1692 | 3.06 | 0.00 GB | 0.97 GB | 0.17 | 0.20 | 0.24 |
| beir/nfcorpus/test | 3633 | 1711 | 2.12 | 0.00 GB | 0.89 GB | 0.23 | 0.26 | 0.29 |
| dbpedia-entities-openai-100k | 100000 | 867 | 115.29 | 0.72 GB | 2.68 GB | 1.44 | 1.97 | 2.14 |
| dbpedia-entities-openai-1m | 995000 | 679 | 1464.81 | 7.20 GB | 10.70 GB | 4.63 | 6.42 | 6.79 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 1.10 | 1.26 | 1.38 |
| beir/nfcorpus/test | 1.20 | 1.35 | 1.45 |
| dbpedia-entities-openai-100k | 3.34 | 3.89 | 4.10 |
| dbpedia-entities-openai-1m | 6.57 | 8.37 | 8.77 |

Engine container memory through the whole track, load included (anonymous memory is the heap the kernel cannot reclaim; charged memory adds the page cache of the engine's files):

| Dataset | Peak anonymous | Peak charged | Samples |
| --- | --- | --- | --- |
| beir/scifact/test | 0.97 GB | 1.02 GB | 468 |
| beir/nfcorpus/test | 0.89 GB | 0.93 GB | 504 |
| dbpedia-entities-openai-100k | 2.68 GB | 4.91 GB | 895 |
| dbpedia-entities-openai-1m | 10.70 GB | 19.87 GB | 4243 |

Server-side time source per dataset:

- beir/scifact/test: response `elapsed` field (floating-millisecond resolution)
- beir/nfcorpus/test: response `elapsed` field (floating-millisecond resolution)
- dbpedia-entities-openai-100k: response `elapsed` field (floating-millisecond resolution)
- dbpedia-entities-openai-1m: response `elapsed` field (floating-millisecond resolution)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 907 | n/a | 0 | 1.22 | 2.26 | 0.36 | 1.0 | no |
| 2 | 1 | 1747 | n/a | 0 | 1.28 | 2.47 | 0.76 | 2.0 | no |
| 4 | 3 | 3261 | 3251 to 3338 | 0 | 1.44 | 2.68 | 1.46 | 4.0 | no |
| 8 | 1 | 3098 | n/a | 0 | 3.83 | 5.36 | 1.59 | 8.0 | yes |
| 16 | 1 | 3043 | n/a | 0 | 8.65 | 24.48 | 1.49 | 16.0 | yes |
| 32 | 1 | 2777 | n/a | 0 | 18.03 | 36.38 | 1.33 | 31.9 | yes |
| 64 | 1 | 2622 | n/a | 0 | 41.41 | 74.68 | 1.30 | 63.6 | yes |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 852 | n/a | 0 | 1.30 | 2.91 | 0.37 | 1.0 | no |
| 2 | 1 | 1677 | n/a | 0 | 1.32 | 3.34 | 0.76 | 2.0 | no |
| 4 | 3 | 3101 | 3071 to 3122 | 0 | 1.57 | 3.32 | 1.58 | 4.0 | no |
| 8 | 1 | 3011 | n/a | 0 | 3.92 | 5.55 | 1.74 | 8.0 | no |
| 16 | 1 | 3024 | n/a | 0 | 8.74 | 25.37 | 1.70 | 16.0 | yes |
| 32 | 1 | 2778 | n/a | 0 | 18.15 | 36.22 | 1.54 | 31.9 | yes |
| 64 | 1 | 2605 | n/a | 0 | 41.90 | 74.79 | 1.43 | 63.5 | yes |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 297 | n/a | 0 | 3.87 | 4.60 | 0.59 | 1.0 | no |
| 2 | 1 | 604 | n/a | 0 | 3.81 | 5.02 | 1.16 | 2.0 | no |
| 4 | 1 | 1153 | n/a | 0 | 4.06 | 5.22 | 2.36 | 4.0 | no |
| 8 | 1 | 1372 | n/a | 0 | 8.44 | 10.26 | 3.20 | 8.0 | no |
| 16 | 1 | 1634 | n/a | 0 | 15.56 | 95.26 | 4.16 | 16.0 | yes |
| 32 | 3 | 1649 | 1648 to 1652 | 0 | 32.99 | 115.82 | 4.17 | 31.8 | yes |
| 64 | 1 | 1529 | n/a | 0 | 71.13 | 153.82 | 3.88 | 63.3 | yes |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 161 | n/a | 0 | 8.23 | 9.00 | 0.80 | 1.0 | no |
| 2 | 1 | 325 | n/a | 0 | 8.14 | 8.84 | 1.60 | 2.0 | no |
| 4 | 1 | 614 | n/a | 0 | 8.67 | 10.08 | 3.25 | 4.0 | no |
| 8 | 1 | 868 | n/a | 0 | 13.70 | 19.23 | 5.29 | 8.0 | no |
| 16 | 3 | 1129 | 1123 to 1140 | 0 | 25.51 | 46.10 | 7.10 | 15.9 | no |
| 32 | 1 | 1073 | n/a | 0 | 54.91 | 99.66 | 7.42 | 31.6 | no |
| 64 | 1 | 1100 | n/a | 0 | 104.62 | 151.35 | 7.25 | 62.6 | no |

## Hybrid track

- Setup: BM25 (text) fused with HNSW vector search via Reciprocal Rank Fusion
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
| beir/scifact/test | 5183 | 1825 | 2.84 | 0.00 GB | 1.03 GB | 0.31 | 0.38 | 0.42 |
| beir/nfcorpus/test | 3633 | 1640 | 2.22 | 0.00 GB | 0.86 GB | 0.29 | 0.33 | 0.40 |
| dbpedia-entities-openai-100k | 100000 | 840 | 119.11 | 0.72 GB | 3.09 GB | 1.58 | 2.12 | 2.32 |
| dbpedia-entities-openai-1m | 995000 | 661 | 1504.93 | 7.20 GB | 10.66 GB | 5.22 | 7.22 | 8.07 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 1.30 | 1.46 | 1.56 |
| beir/nfcorpus/test | 1.26 | 1.41 | 1.55 |
| dbpedia-entities-openai-100k | 3.53 | 4.10 | 4.43 |
| dbpedia-entities-openai-1m | 7.20 | 9.21 | 10.17 |

Engine container memory through the whole track, load included (anonymous memory is the heap the kernel cannot reclaim; charged memory adds the page cache of the engine's files):

| Dataset | Peak anonymous | Peak charged | Samples |
| --- | --- | --- | --- |
| beir/scifact/test | 1.03 GB | 1.08 GB | 351 |
| beir/nfcorpus/test | 0.86 GB | 0.90 GB | 348 |
| dbpedia-entities-openai-100k | 3.09 GB | 5.10 GB | 700 |
| dbpedia-entities-openai-1m | 10.66 GB | 18.71 GB | 3984 |

Server-side time source per dataset:

- beir/scifact/test: response `elapsed` field (floating-millisecond resolution)
- beir/nfcorpus/test: response `elapsed` field (floating-millisecond resolution)
- dbpedia-entities-openai-100k: response `elapsed` field (floating-millisecond resolution)
- dbpedia-entities-openai-1m: response `elapsed` field (floating-millisecond resolution)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 772 | n/a | 0 | 1.42 | 3.81 | 0.45 | 1.0 | no |
| 2 | 1 | 1494 | n/a | 0 | 1.51 | 3.33 | 0.88 | 2.0 | no |
| 4 | 1 | 2807 | n/a | 0 | 1.80 | 3.11 | 1.80 | 4.0 | no |
| 8 | 1 | 2887 | n/a | 0 | 4.03 | 5.30 | 2.07 | 8.0 | no |
| 16 | 3 | 2985 | 2979 to 2997 | 0 | 8.83 | 25.09 | 2.00 | 16.0 | yes |
| 32 | 1 | 2773 | n/a | 0 | 18.22 | 36.77 | 1.96 | 31.9 | yes |
| 64 | 1 | 2575 | n/a | 0 | 42.26 | 74.48 | 1.71 | 63.6 | yes |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 789 | n/a | 0 | 1.40 | 4.06 | 0.43 | 1.0 | no |
| 2 | 1 | 1511 | n/a | 0 | 1.47 | 3.61 | 0.87 | 2.0 | no |
| 4 | 1 | 2900 | n/a | 0 | 1.57 | 3.89 | 1.78 | 4.0 | no |
| 8 | 1 | 2894 | n/a | 0 | 4.02 | 5.67 | 2.02 | 8.0 | no |
| 16 | 3 | 3006 | 2994 to 3021 | 0 | 8.75 | 24.15 | 2.04 | 16.0 | yes |
| 32 | 1 | 2757 | n/a | 0 | 18.62 | 36.39 | 1.81 | 31.9 | yes |
| 64 | 1 | 2612 | n/a | 0 | 41.46 | 70.25 | 1.69 | 63.6 | yes |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 283 | n/a | 0 | 4.06 | 5.84 | 0.63 | 1.0 | no |
| 2 | 1 | 567 | n/a | 0 | 4.07 | 6.58 | 1.24 | 2.0 | no |
| 4 | 1 | 1099 | n/a | 0 | 4.30 | 11.65 | 2.49 | 4.0 | no |
| 8 | 1 | 1311 | n/a | 0 | 8.71 | 13.28 | 3.45 | 8.0 | no |
| 16 | 1 | 1609 | n/a | 0 | 15.96 | 95.93 | 4.52 | 16.0 | yes |
| 32 | 3 | 1652 | 1642 to 1654 | 0 | 32.79 | 111.92 | 4.76 | 31.8 | yes |
| 64 | 1 | 1506 | n/a | 0 | 71.43 | 158.15 | 4.31 | 63.3 | yes |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 146 | n/a | 0 | 8.90 | 15.83 | 0.85 | 1.0 | no |
| 2 | 1 | 297 | n/a | 0 | 8.78 | 12.31 | 1.67 | 2.0 | no |
| 4 | 1 | 559 | n/a | 0 | 9.46 | 11.80 | 3.35 | 4.0 | no |
| 8 | 1 | 785 | n/a | 0 | 15.25 | 28.56 | 5.56 | 8.0 | no |
| 16 | 3 | 979 | 971 to 989 | 0 | 30.81 | 56.55 | 7.18 | 15.9 | no |
| 32 | 1 | 939 | n/a | 0 | 63.65 | 105.94 | 7.22 | 31.6 | no |
| 64 | 1 | 956 | n/a | 0 | 121.20 | 174.65 | 7.21 | 62.4 | no |
