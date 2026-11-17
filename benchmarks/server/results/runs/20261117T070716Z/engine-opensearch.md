# opensearch retrieval (keyword, vector, hybrid)

## Environment

- Captured: 2026-11-17T07:57:42.331110+00:00
- Load machine: GCP c3-standard-8, us-west1-a
- OS / arch: Linux 7.0.0-1017-gcp / x86_64 (containerized: True)
- CPU: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical)
- Memory: 33.6 GB
- Engine machine label: GCP c3-standard-8, us-west1-a
- Engine machine: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical), 33.6 GB
- Network round trip to the engine machine: p50 0.081 ms, p99 0.140 ms over 200 TCP connects
- Memory cap per engine: 21.5 GB
- Tracks: keyword, vector, hybrid
- Keyword setup: BM25 k1=0.9 b=0.4 (custom default similarity); OpenSearch `english` analyzer
- Run depth: 1000; run tag: opensearch_bm25
- Engine build: version 3.9.0, commit 4ee42a94e87f
- Engine image: opensearchproject/opensearch@sha256:3bf4fe26aeb9f7b03c0ebcb1302bb24e855ee6b89fd926d26a71a83ef6f7e076
- Dataset beir/scifact/test: content md5 5f7d1de60b170fc8027bb7898e2efca1
- Dataset beir/nfcorpus/test: content md5 a89dba18a62ef92f7d323ec890a0d38d

## Keyword track

Retrieval quality vs Anserini BM25 reference:

| Dataset | nDCG@10 | Reference | Delta | Status | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 0.6789 | 0.6790 | -0.0001 | within margin | 0.9253 | 0.6401 | 0.6506 |
| beir/nfcorpus/test | 0.3216 | 0.3220 | -0.0004 | within margin | 0.2458 | 0.1506 | 0.5281 |
| dbpedia-entities-openai-100k | n/a | n/a | n/a | no baseline | n/a | n/a | n/a |
| dbpedia-entities-openai-1m | n/a | n/a | n/a | no baseline | n/a | n/a | n/a |

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | On disk | Peak heap | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 5106 | 1.02 | 0.01 GB | 7.28 GB | 1.00 | 1.00 | 2.00 |
| beir/nfcorpus/test | 3633 | 7576 | 0.48 | 0.01 GB | 7.53 GB | 0.00 | 0.00 | 0.00 |
| dbpedia-entities-openai-100k | 100000 | 45590 | 2.19 | 0.03 GB | 7.58 GB | 0.00 | 0.00 | 0.00 |
| dbpedia-entities-openai-1m | 995000 | 47826 | 20.80 | 0.36 GB | 7.87 GB | 0.00 | 1.00 | 1.00 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 2.25 | 3.01 | 3.38 |
| beir/nfcorpus/test | 1.13 | 1.35 | 1.52 |
| dbpedia-entities-openai-100k | 1.18 | 1.44 | 1.61 |
| dbpedia-entities-openai-1m | 1.37 | 1.94 | 2.40 |

Engine container memory through the whole track, load included (anonymous memory is the heap the kernel cannot reclaim; charged memory adds the page cache of the engine's files):

| Dataset | Peak anonymous | Peak charged | Samples |
| --- | --- | --- | --- |
| beir/scifact/test | 7.28 GB | 7.33 GB | 308 |
| beir/nfcorpus/test | 7.53 GB | 7.58 GB | 366 |
| dbpedia-entities-openai-100k | 7.58 GB | 7.70 GB | 366 |
| dbpedia-entities-openai-1m | 7.87 GB | 9.01 GB | 475 |

Server-side time source per dataset:

- beir/scifact/test: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- beir/nfcorpus/test: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- dbpedia-entities-openai-100k: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- dbpedia-entities-openai-1m: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 569 | n/a | 0 | 2.09 | 2.65 | 1.32 | 1.0 | no |
| 2 | 1 | 1188 | n/a | 0 | 1.96 | 3.54 | 1.97 | 2.0 | no |
| 4 | 1 | 2516 | n/a | 0 | 1.85 | 19.48 | 2.67 | 4.0 | no |
| 8 | 1 | 3266 | n/a | 0 | 3.38 | 32.03 | 3.53 | 8.0 | no |
| 16 | 3 | 3842 | 3789 to 3881 | 0 | 6.30 | 25.77 | 3.97 | 16.0 | yes |
| 32 | 1 | 3573 | n/a | 0 | 14.22 | 31.21 | 3.61 | 31.9 | yes |
| 64 | 1 | 3032 | n/a | 0 | 36.66 | 66.85 | 2.99 | 63.6 | yes |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 907 | n/a | 0 | 1.32 | 1.64 | 0.52 | 1.0 | no |
| 2 | 1 | 1734 | n/a | 0 | 1.36 | 2.27 | 1.00 | 2.0 | no |
| 4 | 1 | 3166 | n/a | 0 | 1.58 | 2.01 | 2.05 | 4.0 | no |
| 8 | 1 | 3703 | n/a | 0 | 3.16 | 6.39 | 2.62 | 8.0 | no |
| 16 | 3 | 3888 | 3883 to 3903 | 0 | 6.35 | 13.42 | 2.73 | 16.0 | yes |
| 32 | 1 | 3449 | n/a | 0 | 14.68 | 33.96 | 2.30 | 31.9 | yes |
| 64 | 1 | 3160 | n/a | 0 | 35.83 | 59.43 | 2.08 | 63.6 | yes |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 852 | n/a | 0 | 1.41 | 1.72 | 0.50 | 1.0 | no |
| 2 | 1 | 1625 | n/a | 0 | 1.49 | 2.00 | 1.06 | 2.0 | no |
| 4 | 1 | 3021 | n/a | 0 | 1.62 | 3.20 | 2.20 | 4.0 | no |
| 8 | 1 | 3667 | n/a | 0 | 3.17 | 6.21 | 2.77 | 8.0 | no |
| 16 | 3 | 3880 | 3871 to 3881 | 0 | 6.40 | 10.83 | 2.91 | 16.0 | yes |
| 32 | 1 | 3481 | n/a | 0 | 14.53 | 31.69 | 2.57 | 31.9 | yes |
| 64 | 1 | 3084 | n/a | 0 | 36.40 | 65.39 | 2.26 | 63.6 | yes |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 716 | n/a | 0 | 1.90 | 3.28 | 0.58 | 1.0 | no |
| 2 | 1 | 1355 | n/a | 0 | 2.02 | 3.50 | 1.25 | 2.0 | no |
| 4 | 1 | 2438 | n/a | 0 | 2.25 | 9.57 | 2.55 | 4.0 | no |
| 8 | 1 | 3387 | n/a | 0 | 3.45 | 21.10 | 3.78 | 8.0 | no |
| 16 | 3 | 3855 | 3842 to 3882 | 0 | 6.36 | 13.45 | 4.31 | 16.0 | yes |
| 32 | 1 | 3586 | n/a | 0 | 14.21 | 30.67 | 3.92 | 31.9 | yes |
| 64 | 1 | 3118 | n/a | 0 | 35.70 | 65.53 | 3.48 | 63.6 | yes |

## Vector track

- Embedding model: sentence-transformers/all-MiniLM-L6-v2 (384 dim, cosine)
- Index setup: knn_vector HNSW (faiss engine, inner product on L2-normalized vectors = cosine), over the shared precomputed vectors
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
| beir/scifact/test | ef_search | 64 | 0.9963 | yes | 32 | 0.9800 |
| beir/nfcorpus/test | ef_search | 128 | 0.9935 | yes | 64 | 0.9780 |
| dbpedia-entities-openai-100k | ef_search | 128 | 0.9917 | yes | 32 | 0.9610 |
| dbpedia-entities-openai-1m | ef_search | 288 | 0.9927 | yes | 64 | 0.9640 |

Latency is measured at the operating point.

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | On disk | Peak heap | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 1078 | 4.81 | 0.02 GB | 7.40 GB | 0.00 | 0.00 | 1.00 |
| beir/nfcorpus/test | 3633 | 1154 | 3.15 | 0.02 GB | 7.55 GB | 0.00 | 0.00 | 0.00 |
| dbpedia-entities-openai-100k | 100000 | 378 | 264.83 | 1.28 GB | 8.32 GB | 1.00 | 1.00 | 1.00 |
| dbpedia-entities-openai-1m | 995000 | 200 | 4978.40 | 12.73 GB | 14.46 GB | 3.00 | 4.00 | 5.00 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 1.62 | 2.06 | 2.31 |
| beir/nfcorpus/test | 1.67 | 1.82 | 1.93 |
| dbpedia-entities-openai-100k | 3.40 | 3.79 | 3.96 |
| dbpedia-entities-openai-1m | 5.42 | 6.78 | 7.74 |

Engine container memory through the whole track, load included (anonymous memory is the heap the kernel cannot reclaim; charged memory adds the page cache of the engine's files):

| Dataset | Peak anonymous | Peak charged | Samples |
| --- | --- | --- | --- |
| beir/scifact/test | 7.40 GB | 7.46 GB | 511 |
| beir/nfcorpus/test | 7.55 GB | 7.63 GB | 543 |
| dbpedia-entities-openai-100k | 8.32 GB | 11.26 GB | 1482 |
| dbpedia-entities-openai-1m | 14.46 GB | 21.47 GB | 18887 |

Server-side time source per dataset:

- beir/scifact/test: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- beir/nfcorpus/test: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- dbpedia-entities-openai-100k: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- dbpedia-entities-openai-1m: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 605 | n/a | 0 | 1.79 | 2.23 | 0.52 | 1.0 | no |
| 2 | 1 | 1146 | n/a | 0 | 1.89 | 3.14 | 1.01 | 2.0 | no |
| 4 | 1 | 2152 | n/a | 0 | 2.02 | 2.71 | 2.07 | 4.0 | no |
| 8 | 1 | 2486 | n/a | 0 | 4.65 | 5.50 | 2.55 | 8.0 | no |
| 16 | 3 | 2820 | 2796 to 2825 | 0 | 8.81 | 25.85 | 2.93 | 16.0 | yes |
| 32 | 1 | 2612 | n/a | 0 | 19.63 | 37.50 | 2.65 | 31.9 | yes |
| 64 | 1 | 2442 | n/a | 0 | 44.79 | 78.80 | 2.43 | 63.5 | yes |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 598 | n/a | 0 | 1.79 | 3.49 | 0.48 | 1.0 | no |
| 2 | 1 | 1112 | n/a | 0 | 1.95 | 2.99 | 0.99 | 2.0 | no |
| 4 | 1 | 2110 | n/a | 0 | 2.17 | 3.53 | 2.07 | 4.0 | no |
| 8 | 1 | 2475 | n/a | 0 | 4.67 | 10.73 | 2.64 | 8.0 | no |
| 16 | 3 | 2800 | 2796 to 2803 | 0 | 8.84 | 25.04 | 2.99 | 16.0 | yes |
| 32 | 1 | 2617 | n/a | 0 | 19.73 | 36.74 | 2.74 | 31.9 | yes |
| 64 | 1 | 2363 | n/a | 0 | 46.31 | 84.52 | 2.43 | 63.5 | yes |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 293 | n/a | 0 | 3.76 | 4.01 | 0.51 | 1.0 | no |
| 2 | 1 | 571 | n/a | 0 | 4.06 | 4.88 | 1.03 | 2.0 | no |
| 4 | 1 | 1059 | n/a | 0 | 4.71 | 5.73 | 2.08 | 4.0 | no |
| 8 | 1 | 1353 | n/a | 0 | 8.73 | 10.51 | 2.75 | 8.0 | no |
| 16 | 3 | 1590 | 1588 to 1600 | 0 | 15.54 | 97.07 | 3.67 | 16.0 | yes |
| 32 | 1 | 1585 | n/a | 0 | 32.97 | 113.03 | 3.71 | 31.8 | yes |
| 64 | 1 | 1451 | n/a | 0 | 75.32 | 167.48 | 3.47 | 63.2 | yes |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 195 | n/a | 0 | 6.27 | 6.68 | 0.67 | 1.0 | no |
| 2 | 1 | 391 | n/a | 0 | 6.50 | 8.88 | 1.32 | 2.0 | no |
| 4 | 1 | 702 | n/a | 0 | 7.71 | 9.69 | 2.66 | 4.0 | no |
| 8 | 1 | 1012 | n/a | 0 | 11.44 | 14.58 | 4.42 | 8.0 | no |
| 16 | 1 | 1327 | n/a | 0 | 18.63 | 25.23 | 6.46 | 15.8 | no |
| 32 | 3 | 1465 | 1464 to 1467 | 0 | 32.66 | 114.74 | 7.34 | 31.8 | yes |
| 64 | 1 | 1458 | n/a | 0 | 59.77 | 155.93 | 7.79 | 63.2 | yes |

## Hybrid track

- Setup: BM25 match fused with knn via a hybrid query and an RRF search pipeline
- Fusion: score-ranker-processor RRF (rank_constant=60)

Retrieval quality vs human judgements:

| Dataset | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| beir/scifact/test | 0.7070 | 0.9610 | 0.6609 | 0.6665 |
| beir/nfcorpus/test | 0.3522 | 0.3213 | 0.1867 | 0.5633 |
| dbpedia-entities-openai-100k | n/a | n/a | n/a | n/a |
| dbpedia-entities-openai-1m | n/a | n/a | n/a | n/a |

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | On disk | Peak heap | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 1058 | 4.90 | 0.02 GB | 7.50 GB | 1.00 | 2.00 | 2.00 |
| beir/nfcorpus/test | 3633 | 1163 | 3.12 | 0.02 GB | 7.56 GB | 1.00 | 1.00 | 1.00 |
| dbpedia-entities-openai-100k | 100000 | 378 | 264.85 | 1.28 GB | 8.44 GB | 1.00 | 2.00 | 2.00 |
| dbpedia-entities-openai-1m | 995000 | 193 | 5143.73 | 12.73 GB | 14.74 GB | 4.00 | 6.00 | 7.00 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 2.71 | 3.23 | 3.43 |
| beir/nfcorpus/test | 2.24 | 2.56 | 2.83 |
| dbpedia-entities-openai-100k | 3.97 | 4.63 | 5.21 |
| dbpedia-entities-openai-1m | 6.53 | 8.36 | 9.65 |

Engine container memory through the whole track, load included (anonymous memory is the heap the kernel cannot reclaim; charged memory adds the page cache of the engine's files):

| Dataset | Peak anonymous | Peak charged | Samples |
| --- | --- | --- | --- |
| beir/scifact/test | 7.50 GB | 7.59 GB | 424 |
| beir/nfcorpus/test | 7.56 GB | 7.64 GB | 399 |
| dbpedia-entities-openai-100k | 8.44 GB | 11.33 GB | 1308 |
| dbpedia-entities-openai-1m | 14.74 GB | 21.47 GB | 18995 |

Server-side time source per dataset:

- beir/scifact/test: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- beir/nfcorpus/test: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- dbpedia-entities-openai-100k: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- dbpedia-entities-openai-1m: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 377 | n/a | 0 | 3.10 | 3.95 | 0.75 | 1.0 | no |
| 2 | 1 | 727 | n/a | 0 | 3.25 | 4.05 | 1.47 | 2.0 | no |
| 4 | 1 | 1365 | n/a | 0 | 3.52 | 4.21 | 2.73 | 4.0 | no |
| 8 | 1 | 1923 | n/a | 0 | 5.76 | 11.68 | 4.35 | 8.0 | no |
| 16 | 1 | 2571 | n/a | 0 | 9.28 | 26.82 | 6.09 | 16.0 | yes |
| 32 | 3 | 2699 | 2697 to 2715 | 0 | 18.73 | 35.88 | 6.47 | 31.9 | yes |
| 64 | 1 | 2317 | n/a | 0 | 45.67 | 80.11 | 5.44 | 63.5 | yes |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 447 | n/a | 0 | 2.52 | 2.94 | 0.62 | 1.0 | no |
| 2 | 1 | 862 | n/a | 0 | 2.67 | 3.24 | 1.25 | 2.0 | no |
| 4 | 1 | 1589 | n/a | 0 | 2.95 | 5.63 | 2.52 | 4.0 | no |
| 8 | 1 | 2132 | n/a | 0 | 5.31 | 7.47 | 3.72 | 8.0 | no |
| 16 | 3 | 2678 | 2672 to 2680 | 0 | 9.03 | 25.85 | 4.82 | 16.0 | yes |
| 32 | 1 | 2661 | n/a | 0 | 19.31 | 36.29 | 4.84 | 31.9 | yes |
| 64 | 1 | 2339 | n/a | 0 | 46.75 | 82.82 | 3.94 | 63.5 | yes |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 249 | n/a | 0 | 4.43 | 4.99 | 0.58 | 1.0 | no |
| 2 | 1 | 491 | n/a | 0 | 4.77 | 5.63 | 1.16 | 2.0 | no |
| 4 | 1 | 945 | n/a | 0 | 4.96 | 5.86 | 2.35 | 4.0 | no |
| 8 | 1 | 1208 | n/a | 0 | 9.56 | 11.36 | 3.43 | 8.0 | no |
| 16 | 1 | 1545 | n/a | 0 | 15.51 | 96.68 | 4.64 | 15.9 | yes |
| 32 | 3 | 1562 | 1558 to 1563 | 0 | 33.01 | 115.91 | 4.97 | 31.8 | yes |
| 64 | 1 | 1414 | n/a | 0 | 77.62 | 158.65 | 4.54 | 63.2 | yes |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 161 | n/a | 0 | 7.58 | 10.94 | 0.73 | 1.0 | no |
| 2 | 1 | 318 | n/a | 0 | 8.01 | 11.65 | 1.49 | 2.0 | no |
| 4 | 1 | 600 | n/a | 0 | 8.65 | 12.27 | 2.93 | 4.0 | no |
| 8 | 1 | 867 | n/a | 0 | 12.82 | 16.65 | 5.13 | 8.0 | no |
| 16 | 1 | 1166 | n/a | 0 | 20.78 | 28.63 | 7.22 | 15.9 | no |
| 32 | 3 | 1194 | 1194 to 1205 | 0 | 37.55 | 51.95 | 7.89 | 31.8 | no |
| 64 | 1 | 1182 | n/a | 0 | 66.01 | 90.61 | 7.94 | 63.0 | no |
