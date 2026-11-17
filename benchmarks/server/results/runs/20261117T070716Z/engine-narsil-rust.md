# narsil-rust retrieval (keyword, vector, hybrid)

## Environment

- Captured: 2026-11-17T07:59:26.996750+00:00
- Load machine: GCP c3-standard-8, us-east1-b
- OS / arch: Linux 7.0.0-1017-gcp / x86_64 (containerized: True)
- CPU: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical)
- Memory: 33.6 GB
- Engine machine label: GCP c3-standard-8, us-east1-b
- Engine machine: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical), 33.6 GB
- Network round trip to the engine machine: p50 0.083 ms, p99 0.162 ms over 200 TCP connects
- Memory cap per engine: 21.5 GB
- Tracks: keyword, vector, hybrid
- Keyword setup: BM25 k1=0.9 b=0.4; language english, as the server reports it
- Run depth: 1000; run tag: narsil_rust_bm25
- Engine build: version 0.4.3, commit d3efdcbcb2d2
- Engine image: ir-benchmark-engine-narsil-rust@sha256:be067e08a682414ea143df364953ecb90d1ed0f63712bc4c54f68c121b9a476e
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
| beir/scifact/test | 5183 | 7431 | 0.70 | 0.00 GB | 0.08 GB | 0.05 | 0.10 | 0.14 |
| beir/nfcorpus/test | 3633 | 6649 | 0.55 | 0.00 GB | 0.09 GB | 0.02 | 0.04 | 0.06 |
| dbpedia-entities-openai-100k | 100000 | 35699 | 2.80 | 0.09 GB | 0.63 GB | 0.04 | 0.22 | 0.28 |
| dbpedia-entities-openai-1m | 995000 | 21571 | 46.13 | 0.87 GB | 1.81 GB | 0.30 | 1.08 | 1.70 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 0.63 | 0.77 | 0.85 |
| beir/nfcorpus/test | 0.64 | 0.76 | 0.84 |
| dbpedia-entities-openai-100k | 0.72 | 0.94 | 1.07 |
| dbpedia-entities-openai-1m | 1.02 | 1.80 | 2.42 |

Engine container memory through the whole track, load included (anonymous memory is the heap the kernel cannot reclaim; charged memory adds the page cache of the engine's files):

| Dataset | Peak anonymous | Peak charged | Samples |
| --- | --- | --- | --- |
| beir/scifact/test | 0.08 GB | 0.09 GB | 272 |
| beir/nfcorpus/test | 0.09 GB | 0.10 GB | 267 |
| dbpedia-entities-openai-100k | 0.63 GB | 0.78 GB | 355 |
| dbpedia-entities-openai-1m | 1.81 GB | 2.80 GB | 568 |

Server-side time source per dataset:

- beir/scifact/test: response `elapsed` field (floating-millisecond resolution)
- beir/nfcorpus/test: response `elapsed` field (floating-millisecond resolution)
- dbpedia-entities-openai-100k: response `elapsed` field (floating-millisecond resolution)
- dbpedia-entities-openai-1m: response `elapsed` field (floating-millisecond resolution)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 1555 | n/a | 0 | 0.75 | 0.93 | 0.32 | 1.0 | no |
| 2 | 1 | 3002 | n/a | 0 | 0.78 | 0.98 | 0.62 | 2.0 | no |
| 4 | 3 | 5766 | 5701 to 5869 | 0 | 0.83 | 1.18 | 1.24 | 4.0 | no |
| 8 | 1 | 4826 | n/a | 0 | 2.43 | 2.85 | 1.10 | 8.0 | yes |
| 16 | 1 | 4316 | n/a | 0 | 6.18 | 10.69 | 0.98 | 16.0 | yes |
| 32 | 1 | 3814 | n/a | 0 | 13.44 | 31.53 | 0.83 | 31.9 | yes |
| 64 | 1 | 3460 | n/a | 0 | 32.59 | 56.92 | 0.75 | 63.6 | yes |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 1686 | n/a | 0 | 0.70 | 0.87 | 0.28 | 1.0 | no |
| 2 | 1 | 3218 | n/a | 0 | 0.71 | 0.91 | 0.53 | 2.0 | no |
| 4 | 3 | 6411 | 6269 to 6474 | 0 | 0.75 | 1.23 | 1.06 | 4.0 | no |
| 8 | 1 | 5048 | n/a | 0 | 2.28 | 2.76 | 0.89 | 8.0 | yes |
| 16 | 1 | 4348 | n/a | 0 | 6.25 | 10.88 | 0.75 | 16.0 | yes |
| 32 | 1 | 3807 | n/a | 0 | 13.45 | 29.95 | 0.63 | 31.9 | yes |
| 64 | 1 | 3667 | n/a | 0 | 29.59 | 53.57 | 0.61 | 63.7 | yes |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 1566 | n/a | 0 | 0.81 | 1.05 | 0.33 | 1.0 | no |
| 2 | 1 | 3009 | n/a | 0 | 0.84 | 1.15 | 0.62 | 2.0 | no |
| 4 | 3 | 5782 | 5762 to 5890 | 0 | 0.93 | 1.33 | 1.26 | 4.0 | no |
| 8 | 1 | 4942 | n/a | 0 | 2.40 | 2.88 | 1.15 | 8.0 | yes |
| 16 | 1 | 4339 | n/a | 0 | 6.23 | 10.31 | 0.89 | 16.0 | yes |
| 32 | 1 | 3816 | n/a | 0 | 13.40 | 29.51 | 0.75 | 31.9 | yes |
| 64 | 1 | 3525 | n/a | 0 | 30.57 | 52.51 | 0.71 | 63.6 | yes |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 960 | n/a | 0 | 1.73 | 3.48 | 0.55 | 1.0 | no |
| 2 | 1 | 1922 | n/a | 0 | 1.75 | 3.67 | 1.10 | 2.0 | no |
| 4 | 1 | 3517 | n/a | 0 | 1.95 | 4.43 | 2.26 | 4.0 | no |
| 8 | 1 | 4203 | n/a | 0 | 3.05 | 5.59 | 2.96 | 8.0 | no |
| 16 | 3 | 4291 | 4290 to 4300 | 0 | 6.08 | 10.22 | 3.08 | 16.0 | yes |
| 32 | 1 | 3846 | n/a | 0 | 13.31 | 30.20 | 2.70 | 31.9 | yes |
| 64 | 1 | 3501 | n/a | 0 | 31.22 | 56.98 | 2.61 | 63.7 | yes |

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
| beir/scifact/test | efSearch | 64 | 0.9967 | yes | 16 | 0.9520 |
| beir/nfcorpus/test | efSearch | 128 | 0.9926 | yes | 64 | 0.9765 |
| dbpedia-entities-openai-100k | efSearch | 128 | 0.9919 | yes | 32 | 0.9643 |
| dbpedia-entities-openai-1m | efSearch | 256 | 0.9916 | yes | 64 | 0.9630 |

Latency is measured at the operating point.

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | On disk | Peak heap | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 2249 | 2.30 | 0.00 GB | 0.20 GB | 0.13 | 0.15 | 0.17 |
| beir/nfcorpus/test | 3633 | 2072 | 1.75 | 0.00 GB | 0.15 GB | 0.19 | 0.22 | 0.24 |
| dbpedia-entities-openai-100k | 100000 | 856 | 116.86 | 0.72 GB | 2.33 GB | 1.47 | 2.05 | 2.22 |
| dbpedia-entities-openai-1m | 995000 | 851 | 1169.05 | 6.49 GB | 9.12 GB | 4.27 | 5.89 | 6.20 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 1.07 | 1.20 | 1.33 |
| beir/nfcorpus/test | 1.17 | 1.30 | 1.41 |
| dbpedia-entities-openai-100k | 3.37 | 3.97 | 4.19 |
| dbpedia-entities-openai-1m | 6.17 | 7.81 | 8.13 |

Engine container memory through the whole track, load included (anonymous memory is the heap the kernel cannot reclaim; charged memory adds the page cache of the engine's files):

| Dataset | Peak anonymous | Peak charged | Samples |
| --- | --- | --- | --- |
| beir/scifact/test | 0.20 GB | 0.22 GB | 461 |
| beir/nfcorpus/test | 0.15 GB | 0.17 GB | 499 |
| dbpedia-entities-openai-100k | 2.33 GB | 4.32 GB | 881 |
| dbpedia-entities-openai-1m | 9.12 GB | 17.06 GB | 3608 |

Server-side time source per dataset:

- beir/scifact/test: response `elapsed` field (floating-millisecond resolution)
- beir/nfcorpus/test: response `elapsed` field (floating-millisecond resolution)
- dbpedia-entities-openai-100k: response `elapsed` field (floating-millisecond resolution)
- dbpedia-entities-openai-1m: response `elapsed` field (floating-millisecond resolution)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 957 | n/a | 0 | 1.15 | 1.40 | 0.30 | 1.0 | no |
| 2 | 1 | 1842 | n/a | 0 | 1.20 | 1.70 | 0.59 | 2.0 | no |
| 4 | 3 | 3622 | 3596 to 3627 | 0 | 1.24 | 1.71 | 1.23 | 4.0 | no |
| 8 | 1 | 3187 | n/a | 0 | 3.70 | 4.40 | 1.17 | 8.0 | yes |
| 16 | 1 | 3043 | n/a | 0 | 8.63 | 23.52 | 1.12 | 16.0 | yes |
| 32 | 1 | 2794 | n/a | 0 | 18.25 | 36.28 | 0.96 | 31.9 | yes |
| 64 | 1 | 2644 | n/a | 0 | 41.54 | 70.25 | 0.91 | 63.5 | yes |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 862 | n/a | 0 | 1.28 | 1.57 | 0.35 | 1.0 | no |
| 2 | 1 | 1765 | n/a | 0 | 1.24 | 1.44 | 0.67 | 2.0 | no |
| 4 | 3 | 3409 | 3390 to 3434 | 0 | 1.31 | 1.98 | 1.37 | 4.0 | no |
| 8 | 1 | 3095 | n/a | 0 | 3.82 | 4.52 | 1.34 | 8.0 | yes |
| 16 | 1 | 3036 | n/a | 0 | 8.69 | 25.22 | 1.34 | 16.0 | yes |
| 32 | 1 | 2788 | n/a | 0 | 17.93 | 36.74 | 1.15 | 31.9 | yes |
| 64 | 1 | 2612 | n/a | 0 | 41.90 | 72.51 | 1.07 | 63.6 | yes |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 288 | n/a | 0 | 4.02 | 4.38 | 0.54 | 1.0 | no |
| 2 | 1 | 604 | n/a | 0 | 3.80 | 4.18 | 1.02 | 2.0 | no |
| 4 | 1 | 1139 | n/a | 0 | 4.33 | 5.41 | 2.10 | 4.0 | no |
| 8 | 1 | 1357 | n/a | 0 | 8.68 | 10.84 | 2.76 | 8.0 | no |
| 16 | 1 | 1620 | n/a | 0 | 15.97 | 95.53 | 3.69 | 15.9 | yes |
| 32 | 3 | 1641 | 1639 to 1652 | 0 | 32.90 | 112.84 | 3.96 | 31.8 | yes |
| 64 | 1 | 1528 | n/a | 0 | 72.35 | 154.58 | 3.68 | 63.3 | yes |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 169 | n/a | 0 | 7.74 | 8.31 | 0.74 | 1.0 | no |
| 2 | 1 | 355 | n/a | 0 | 7.32 | 8.36 | 1.41 | 2.0 | no |
| 4 | 1 | 691 | n/a | 0 | 7.62 | 8.73 | 2.80 | 4.0 | no |
| 8 | 1 | 969 | n/a | 0 | 11.68 | 14.68 | 4.32 | 8.0 | no |
| 16 | 3 | 1299 | 1285 to 1300 | 0 | 17.29 | 22.68 | 7.49 | 15.9 | no |
| 32 | 1 | 1266 | n/a | 0 | 30.73 | 38.24 | 7.97 | 31.8 | no |
| 64 | 1 | 1233 | n/a | 0 | 57.81 | 67.11 | 7.83 | 62.8 | no |

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
| beir/scifact/test | 5183 | 2316 | 2.24 | 0.00 GB | 0.16 GB | 0.20 | 0.25 | 0.29 |
| beir/nfcorpus/test | 3633 | 1963 | 1.85 | 0.00 GB | 0.15 GB | 0.22 | 0.25 | 0.27 |
| dbpedia-entities-openai-100k | 100000 | 859 | 116.46 | 0.72 GB | 2.42 GB | 1.58 | 2.16 | 2.33 |
| dbpedia-entities-openai-1m | 995000 | 849 | 1172.16 | 6.49 GB | 9.25 GB | 4.87 | 6.65 | 7.19 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 1.15 | 1.30 | 1.41 |
| beir/nfcorpus/test | 1.17 | 1.31 | 1.42 |
| dbpedia-entities-openai-100k | 3.47 | 4.06 | 4.26 |
| dbpedia-entities-openai-1m | 6.79 | 8.59 | 9.14 |

Engine container memory through the whole track, load included (anonymous memory is the heap the kernel cannot reclaim; charged memory adds the page cache of the engine's files):

| Dataset | Peak anonymous | Peak charged | Samples |
| --- | --- | --- | --- |
| beir/scifact/test | 0.16 GB | 0.18 GB | 344 |
| beir/nfcorpus/test | 0.15 GB | 0.17 GB | 344 |
| dbpedia-entities-openai-100k | 2.42 GB | 4.40 GB | 691 |
| dbpedia-entities-openai-1m | 9.25 GB | 17.32 GB | 3166 |

Server-side time source per dataset:

- beir/scifact/test: response `elapsed` field (floating-millisecond resolution)
- beir/nfcorpus/test: response `elapsed` field (floating-millisecond resolution)
- dbpedia-entities-openai-100k: response `elapsed` field (floating-millisecond resolution)
- dbpedia-entities-openai-1m: response `elapsed` field (floating-millisecond resolution)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 813 | n/a | 0 | 1.34 | 1.64 | 0.35 | 1.0 | no |
| 2 | 1 | 1701 | n/a | 0 | 1.31 | 1.82 | 0.67 | 2.0 | no |
| 4 | 3 | 3328 | 3307 to 3339 | 0 | 1.37 | 2.02 | 1.38 | 4.0 | no |
| 8 | 1 | 3048 | n/a | 0 | 3.85 | 4.53 | 1.40 | 8.0 | yes |
| 16 | 1 | 3027 | n/a | 0 | 8.67 | 23.33 | 1.41 | 16.0 | yes |
| 32 | 1 | 2772 | n/a | 0 | 18.31 | 35.50 | 1.21 | 31.9 | yes |
| 64 | 1 | 2592 | n/a | 0 | 41.85 | 70.80 | 1.13 | 63.6 | yes |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 868 | n/a | 0 | 1.27 | 1.47 | 0.35 | 1.0 | no |
| 2 | 1 | 1713 | n/a | 0 | 1.29 | 1.52 | 0.71 | 2.0 | no |
| 4 | 3 | 3276 | 3273 to 3302 | 0 | 1.37 | 1.93 | 1.45 | 4.0 | no |
| 8 | 1 | 2997 | n/a | 0 | 3.92 | 4.68 | 1.46 | 8.0 | yes |
| 16 | 1 | 3014 | n/a | 0 | 8.66 | 24.30 | 1.48 | 16.0 | yes |
| 32 | 1 | 2766 | n/a | 0 | 18.15 | 41.17 | 1.26 | 31.9 | yes |
| 64 | 1 | 2607 | n/a | 0 | 41.69 | 77.08 | 1.18 | 63.6 | yes |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 283 | n/a | 0 | 4.09 | 4.45 | 0.54 | 1.0 | no |
| 2 | 1 | 588 | n/a | 0 | 3.96 | 5.14 | 1.05 | 2.0 | no |
| 4 | 1 | 1143 | n/a | 0 | 4.07 | 5.30 | 2.12 | 4.0 | no |
| 8 | 1 | 1323 | n/a | 0 | 8.80 | 10.68 | 2.87 | 8.0 | no |
| 16 | 1 | 1616 | n/a | 0 | 15.93 | 98.10 | 3.90 | 15.9 | yes |
| 32 | 3 | 1647 | 1646 to 1649 | 0 | 32.91 | 114.49 | 4.24 | 31.8 | yes |
| 64 | 1 | 1526 | n/a | 0 | 70.51 | 148.68 | 3.83 | 63.3 | yes |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 154 | n/a | 0 | 8.37 | 9.70 | 0.76 | 1.0 | no |
| 2 | 1 | 322 | n/a | 0 | 7.98 | 9.61 | 1.46 | 2.0 | no |
| 4 | 1 | 593 | n/a | 0 | 9.03 | 11.55 | 2.96 | 4.0 | no |
| 8 | 1 | 855 | n/a | 0 | 13.23 | 16.93 | 5.29 | 8.0 | no |
| 16 | 3 | 1182 | 1178 to 1195 | 0 | 18.54 | 23.80 | 7.82 | 15.9 | no |
| 32 | 1 | 1105 | n/a | 0 | 34.46 | 40.62 | 7.96 | 31.7 | no |
| 64 | 1 | 1104 | n/a | 0 | 64.16 | 73.33 | 7.96 | 62.7 | no |
