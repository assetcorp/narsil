# opensearch retrieval (keyword, vector, hybrid)

## Environment

- Captured: 2026-11-19T14:01:06.483124+00:00
- Load machine: GCP c3-standard-8, us-west1-a
- OS / arch: Linux 7.0.0-1017-gcp / x86_64 (containerized: True)
- CPU: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical)
- Memory: 33.6 GB
- Engine machine label: GCP c3-standard-8, us-west1-a
- Engine machine: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical), 33.6 GB
- Network round trip to the engine machine: p50 0.088 ms, p99 0.162 ms over 200 TCP connects
- Memory cap per engine: 21.5 GB
- Tracks: keyword, vector, hybrid
- Keyword setup: BM25 k1=0.9 b=0.4 (custom default similarity); OpenSearch `english` analyzer
- Run depth: 1000; run tag: opensearch_bm25
- Engine build: version 3.10.0, commit b9f09249b4a9
- Engine image: opensearchproject/opensearch@sha256:02d6d6e40c820ae08233b60540aa5d3d9364d64e2dc724e38d6c8c794879b2a0
- Dataset beir/scifact/test: content md5 5f7d1de60b170fc8027bb7898e2efca1
- Dataset beir/nfcorpus/test: content md5 a89dba18a62ef92f7d323ec890a0d38d

## Keyword track

Retrieval quality vs Anserini BM25 reference:

| Dataset | nDCG@10 | Reference | Delta | Status | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 0.6789 | 0.6790 | -0.0001 | within margin | 0.9253 | 0.6401 | 0.6506 |
| beir/nfcorpus/test | 0.3217 | 0.3220 | -0.0003 | within margin | 0.2457 | 0.1503 | 0.5274 |
| dbpedia-entities-openai-100k | n/a | n/a | n/a | no baseline | n/a | n/a | n/a |
| dbpedia-entities-openai-1m | n/a | n/a | n/a | no baseline | n/a | n/a | n/a |

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | On disk | Peak heap | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 5544 | 0.93 | 0.01 GB | 7.21 GB | 1.00 | 1.00 | 1.00 |
| beir/nfcorpus/test | 3633 | 7625 | 0.48 | 0.01 GB | 7.52 GB | 0.00 | 0.00 | 0.00 |
| dbpedia-entities-openai-100k | 100000 | 45892 | 2.18 | 0.03 GB | 7.57 GB | 0.00 | 0.00 | 0.00 |
| dbpedia-entities-openai-1m | 995000 | 45484 | 21.88 | 0.36 GB | 7.82 GB | 0.00 | 1.00 | 1.00 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 1.83 | 2.52 | 2.86 |
| beir/nfcorpus/test | 0.68 | 0.90 | 1.01 |
| dbpedia-entities-openai-100k | 0.66 | 0.89 | 1.05 |
| dbpedia-entities-openai-1m | 0.93 | 1.56 | 2.04 |

Engine container memory through the whole track, load included (anonymous memory is the heap the kernel cannot reclaim; charged memory adds the page cache of the engine's files):

| Dataset | Peak anonymous | Peak charged | Samples |
| --- | --- | --- | --- |
| beir/scifact/test | 7.21 GB | 7.26 GB | 350 |
| beir/nfcorpus/test | 7.52 GB | 7.57 GB | 326 |
| dbpedia-entities-openai-100k | 7.57 GB | 7.69 GB | 527 |
| dbpedia-entities-openai-1m | 7.82 GB | 9.02 GB | 641 |

Server-side time source per dataset:

- beir/scifact/test: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- beir/nfcorpus/test: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- dbpedia-entities-openai-100k: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- dbpedia-entities-openai-1m: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 912 | n/a | 0 | 1.39 | 1.89 | 1.67 | 1.0 | no |
| 2 | 1 | 1963 | n/a | 0 | 1.30 | 1.94 | 2.59 | 1.9 | no |
| 4 | 1 | 3894 | n/a | 0 | 1.24 | 2.18 | 3.70 | 3.9 | no |
| 8 | 1 | 6061 | n/a | 0 | 1.90 | 22.92 | 6.00 | 7.8 | no |
| 16 | 1 | 7724 | n/a | 0 | 3.46 | 7.05 | 7.55 | 15.7 | no |
| 32 | 1 | 8623 | n/a | 0 | 7.30 | 13.15 | 7.92 | 31.6 | no |
| 64 | 1 | 8705 | n/a | 0 | 11.21 | 17.17 | 7.94 | 63.6 | no |
| 128 | 3 | 8713 | 8667 to 8734 | 0 | 18.81 | 25.98 | 7.93 | 127.3 | no |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 1853 | n/a | 0 | 0.68 | 0.91 | 0.83 | 1.0 | no |
| 2 | 1 | 3227 | n/a | 0 | 0.79 | 0.97 | 1.61 | 1.9 | no |
| 4 | 1 | 5753 | n/a | 0 | 0.87 | 1.11 | 3.38 | 3.9 | no |
| 8 | 1 | 8837 | n/a | 0 | 1.33 | 2.79 | 5.78 | 7.7 | no |
| 16 | 1 | 11343 | n/a | 0 | 2.32 | 5.01 | 7.36 | 15.6 | no |
| 32 | 1 | 13287 | n/a | 0 | 5.22 | 10.88 | 7.85 | 31.4 | no |
| 64 | 3 | 13527 | 13524 to 13537 | 0 | 8.36 | 15.22 | 7.92 | 63.4 | no |
| 128 | 1 | 13401 | n/a | 0 | 13.53 | 22.08 | 7.92 | 127.2 | no |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 1671 | n/a | 0 | 0.79 | 1.08 | 0.82 | 1.0 | no |
| 2 | 1 | 2985 | n/a | 0 | 0.89 | 1.18 | 1.70 | 1.9 | no |
| 4 | 1 | 5127 | n/a | 0 | 1.02 | 1.63 | 3.33 | 3.8 | no |
| 8 | 1 | 8190 | n/a | 0 | 1.44 | 4.21 | 5.82 | 7.7 | no |
| 16 | 1 | 10121 | n/a | 0 | 2.65 | 6.32 | 7.36 | 15.6 | no |
| 32 | 1 | 11601 | n/a | 0 | 5.96 | 11.69 | 7.84 | 31.5 | no |
| 64 | 1 | 12994 | n/a | 0 | 8.70 | 17.56 | 7.88 | 63.4 | no |
| 128 | 3 | 13435 | 13356 to 13461 | 0 | 13.53 | 23.34 | 7.89 | 127.2 | no |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 1078 | n/a | 0 | 1.48 | 2.95 | 0.99 | 1.0 | no |
| 2 | 1 | 1935 | n/a | 0 | 1.64 | 3.86 | 1.86 | 1.9 | no |
| 4 | 1 | 3468 | n/a | 0 | 1.85 | 4.53 | 3.60 | 3.9 | no |
| 8 | 1 | 5189 | n/a | 0 | 2.61 | 7.44 | 6.09 | 7.8 | no |
| 16 | 1 | 6322 | n/a | 0 | 4.77 | 9.90 | 7.56 | 15.8 | no |
| 32 | 1 | 6964 | n/a | 0 | 8.70 | 15.50 | 7.90 | 31.7 | no |
| 64 | 1 | 6903 | n/a | 0 | 14.01 | 21.87 | 7.91 | 63.6 | no |
| 128 | 3 | 7013 | 6997 to 7073 | 0 | 24.34 | 35.77 | 7.91 | 127.3 | no |

## Vector track

- Embedding model: sentence-transformers/all-MiniLM-L6-v2 (384 dim, cosine)
- Index setup: knn_vector HNSW (faiss engine, inner product on L2-normalized vectors = cosine), over the shared precomputed vectors
- Operating point: search knob tuned to ann_recall@10 >= 0.99 against exact kNN over the same vectors

Retrieval quality vs human judgements:

| Dataset | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| beir/scifact/test | 0.6239 | 0.9227 | 0.5797 | 0.5849 |
| beir/nfcorpus/test | 0.3147 | 0.3094 | 0.1576 | 0.5179 |
| dbpedia-entities-openai-100k | n/a | n/a | n/a | n/a |
| dbpedia-entities-openai-1m | n/a | n/a | n/a | n/a |

Recall operating point (latency below is measured here, the matched-recall rule for ANN search):

| Dataset | Knob | Value | ANN recall@k | Target met | Secondary value | Secondary recall |
| --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | ef_search | 64 | 0.9973 | yes | 32 | 0.9820 |
| beir/nfcorpus/test | ef_search | 128 | 0.9950 | yes | 64 | 0.9777 |
| dbpedia-entities-openai-100k | ef_search | 128 | 0.9916 | yes | 32 | 0.9545 |
| dbpedia-entities-openai-1m | ef_search | 248 | 0.9913 | yes | 64 | 0.9612 |

Latency is measured at the operating point.

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | On disk | Peak heap | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 1070 | 4.84 | 0.02 GB | 7.38 GB | 0.00 | 0.00 | 1.00 |
| beir/nfcorpus/test | 3633 | 1141 | 3.18 | 0.02 GB | 7.54 GB | 0.00 | 0.00 | 0.00 |
| dbpedia-entities-openai-100k | 100000 | 362 | 276.03 | 1.28 GB | 8.32 GB | 1.00 | 1.00 | 1.00 |
| dbpedia-entities-openai-1m | 995000 | 228 | 4371.76 | 12.73 GB | 14.59 GB | 3.00 | 4.00 | 5.00 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 0.87 | 1.40 | 1.53 |
| beir/nfcorpus/test | 0.95 | 1.05 | 1.12 |
| dbpedia-entities-openai-100k | 1.86 | 2.23 | 2.37 |
| dbpedia-entities-openai-1m | 3.50 | 4.83 | 5.82 |

Engine container memory through the whole track, load included (anonymous memory is the heap the kernel cannot reclaim; charged memory adds the page cache of the engine's files):

| Dataset | Peak anonymous | Peak charged | Samples |
| --- | --- | --- | --- |
| beir/scifact/test | 7.38 GB | 7.44 GB | 679 |
| beir/nfcorpus/test | 7.54 GB | 7.63 GB | 726 |
| dbpedia-entities-openai-100k | 8.32 GB | 11.03 GB | 2194 |
| dbpedia-entities-openai-1m | 14.59 GB | 21.47 GB | 17484 |

Server-side time source per dataset:

- beir/scifact/test: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- beir/nfcorpus/test: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- dbpedia-entities-openai-100k: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- dbpedia-entities-openai-1m: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 1190 | n/a | 0 | 0.90 | 1.06 | 0.87 | 1.0 | no |
| 2 | 1 | 2133 | n/a | 0 | 1.03 | 1.18 | 1.71 | 1.9 | no |
| 4 | 1 | 3754 | n/a | 0 | 1.17 | 1.53 | 3.49 | 3.9 | no |
| 8 | 1 | 5804 | n/a | 0 | 1.91 | 3.00 | 6.04 | 7.8 | no |
| 16 | 1 | 7055 | n/a | 0 | 3.61 | 7.74 | 7.48 | 15.7 | no |
| 32 | 1 | 7799 | n/a | 0 | 7.83 | 14.14 | 7.86 | 31.6 | no |
| 64 | 3 | 7957 | 7946 to 7980 | 0 | 12.57 | 19.90 | 7.89 | 63.5 | no |
| 128 | 1 | 7950 | n/a | 0 | 20.75 | 30.79 | 7.91 | 127.2 | no |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 1146 | n/a | 0 | 0.93 | 1.05 | 0.86 | 1.0 | no |
| 2 | 1 | 2059 | n/a | 0 | 1.07 | 1.47 | 1.74 | 1.9 | no |
| 4 | 1 | 3610 | n/a | 0 | 1.22 | 1.68 | 3.52 | 3.9 | no |
| 8 | 1 | 5543 | n/a | 0 | 2.01 | 2.93 | 6.06 | 7.8 | no |
| 16 | 1 | 6748 | n/a | 0 | 3.77 | 6.01 | 7.50 | 15.7 | no |
| 32 | 1 | 7423 | n/a | 0 | 8.17 | 14.16 | 7.87 | 31.6 | no |
| 64 | 1 | 7528 | n/a | 0 | 13.08 | 21.26 | 7.88 | 63.6 | no |
| 128 | 3 | 7563 | 7551 to 7567 | 0 | 21.51 | 29.65 | 7.92 | 127.2 | no |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 601 | n/a | 0 | 2.09 | 2.37 | 0.93 | 1.0 | no |
| 2 | 1 | 1081 | n/a | 0 | 2.31 | 3.44 | 1.81 | 2.0 | no |
| 4 | 1 | 2070 | n/a | 0 | 2.42 | 3.20 | 3.68 | 3.9 | no |
| 8 | 1 | 2646 | n/a | 0 | 4.34 | 7.11 | 6.38 | 7.9 | no |
| 16 | 1 | 3024 | n/a | 0 | 8.98 | 15.83 | 7.60 | 15.8 | no |
| 32 | 3 | 3219 | 3188 to 3222 | 0 | 15.47 | 22.52 | 7.93 | 31.8 | no |
| 64 | 1 | 2993 | n/a | 0 | 26.93 | 33.67 | 7.93 | 63.6 | no |
| 128 | 1 | 2961 | n/a | 0 | 48.89 | 60.89 | 7.95 | 126.8 | no |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 299 | n/a | 0 | 4.23 | 4.76 | 0.96 | 1.0 | no |
| 2 | 1 | 579 | n/a | 0 | 4.74 | 6.42 | 1.91 | 2.0 | no |
| 4 | 1 | 1021 | n/a | 0 | 5.60 | 6.98 | 3.82 | 4.0 | no |
| 8 | 1 | 1360 | n/a | 0 | 8.54 | 11.45 | 6.62 | 7.9 | no |
| 16 | 1 | 1524 | n/a | 0 | 16.41 | 22.64 | 7.87 | 15.9 | no |
| 32 | 1 | 1590 | n/a | 0 | 28.09 | 38.12 | 7.96 | 31.8 | no |
| 64 | 3 | 1719 | 1694 to 1753 | 0 | 44.91 | 60.49 | 7.96 | 63.5 | no |
| 128 | 1 | 1643 | n/a | 0 | 85.55 | 102.61 | 7.95 | 126.0 | no |

## Hybrid track

- Setup: BM25 match fused with knn via a hybrid query and an RRF search pipeline
- Fusion: score-ranker-processor RRF (rank_constant=60)

Retrieval quality vs human judgements:

| Dataset | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| beir/scifact/test | 0.7077 | 0.9610 | 0.6619 | 0.6676 |
| beir/nfcorpus/test | 0.3521 | 0.3213 | 0.1867 | 0.5633 |
| dbpedia-entities-openai-100k | n/a | n/a | n/a | n/a |
| dbpedia-entities-openai-1m | n/a | n/a | n/a | n/a |

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | On disk | Peak heap | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 1064 | 4.87 | 0.02 GB | 7.50 GB | 1.00 | 2.00 | 2.00 |
| beir/nfcorpus/test | 3633 | 1092 | 3.33 | 0.02 GB | 7.56 GB | 1.00 | 1.00 | 1.00 |
| dbpedia-entities-openai-100k | 100000 | 373 | 268.12 | 1.28 GB | 8.38 GB | 1.00 | 2.00 | 2.00 |
| dbpedia-entities-openai-1m | 995000 | 220 | 4517.24 | 12.73 GB | 14.84 GB | 3.00 | 5.00 | 6.00 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 1.97 | 2.47 | 2.70 |
| beir/nfcorpus/test | 1.47 | 1.77 | 1.96 |
| dbpedia-entities-openai-100k | 2.33 | 3.20 | 3.64 |
| dbpedia-entities-openai-1m | 4.30 | 6.01 | 7.25 |

Engine container memory through the whole track, load included (anonymous memory is the heap the kernel cannot reclaim; charged memory adds the page cache of the engine's files):

| Dataset | Peak anonymous | Peak charged | Samples |
| --- | --- | --- | --- |
| beir/scifact/test | 7.50 GB | 7.56 GB | 551 |
| beir/nfcorpus/test | 7.56 GB | 7.64 GB | 530 |
| dbpedia-entities-openai-100k | 8.38 GB | 11.44 GB | 1783 |
| dbpedia-entities-openai-1m | 14.84 GB | 21.47 GB | 17057 |

Server-side time source per dataset:

- beir/scifact/test: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- beir/nfcorpus/test: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- dbpedia-entities-openai-100k: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- dbpedia-entities-openai-1m: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 557 | n/a | 0 | 2.25 | 2.76 | 1.10 | 1.0 | no |
| 2 | 1 | 1024 | n/a | 0 | 2.46 | 3.28 | 2.07 | 2.0 | no |
| 4 | 1 | 1839 | n/a | 0 | 2.73 | 3.36 | 3.79 | 3.9 | no |
| 8 | 1 | 2733 | n/a | 0 | 4.26 | 6.88 | 6.39 | 7.9 | no |
| 16 | 1 | 3239 | n/a | 0 | 8.37 | 12.98 | 7.79 | 15.8 | no |
| 32 | 3 | 3352 | 3347 to 3371 | 0 | 13.86 | 19.39 | 7.93 | 31.8 | no |
| 64 | 1 | 3334 | n/a | 0 | 23.69 | 31.03 | 7.94 | 63.6 | no |
| 128 | 1 | 3355 | n/a | 0 | 42.56 | 51.82 | 7.95 | 126.9 | no |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 710 | n/a | 0 | 1.67 | 1.98 | 0.98 | 1.0 | no |
| 2 | 1 | 1307 | n/a | 0 | 1.84 | 2.24 | 1.86 | 2.0 | no |
| 4 | 1 | 2320 | n/a | 0 | 2.09 | 2.53 | 3.75 | 3.9 | no |
| 8 | 1 | 3469 | n/a | 0 | 3.29 | 4.82 | 6.26 | 7.8 | no |
| 16 | 1 | 4125 | n/a | 0 | 6.55 | 10.78 | 7.75 | 15.8 | no |
| 32 | 1 | 4315 | n/a | 0 | 11.27 | 17.42 | 7.94 | 31.7 | no |
| 64 | 3 | 4356 | 4351 to 4365 | 0 | 18.98 | 25.24 | 7.94 | 63.6 | no |
| 128 | 1 | 4350 | n/a | 0 | 34.15 | 41.38 | 7.96 | 127.1 | no |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 466 | n/a | 0 | 2.58 | 3.05 | 0.95 | 1.0 | no |
| 2 | 1 | 842 | n/a | 0 | 3.05 | 4.02 | 1.88 | 2.0 | no |
| 4 | 1 | 1562 | n/a | 0 | 3.23 | 4.32 | 3.82 | 4.0 | no |
| 8 | 1 | 2125 | n/a | 0 | 5.48 | 9.98 | 6.57 | 7.9 | no |
| 16 | 3 | 2449 | 2445 to 2481 | 0 | 10.90 | 16.45 | 7.77 | 15.9 | no |
| 32 | 1 | 2398 | n/a | 0 | 18.74 | 25.54 | 7.93 | 31.8 | no |
| 64 | 1 | 2344 | n/a | 0 | 33.11 | 45.92 | 7.90 | 63.5 | no |
| 128 | 1 | 2337 | n/a | 0 | 59.96 | 71.21 | 7.94 | 126.6 | no |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 243 | n/a | 0 | 5.42 | 8.97 | 0.98 | 1.0 | no |
| 2 | 1 | 470 | n/a | 0 | 6.01 | 10.28 | 1.94 | 2.0 | no |
| 4 | 1 | 862 | n/a | 0 | 6.40 | 11.78 | 3.87 | 4.0 | no |
| 8 | 1 | 1164 | n/a | 0 | 10.12 | 15.95 | 6.69 | 7.9 | no |
| 16 | 1 | 1296 | n/a | 0 | 19.17 | 27.67 | 7.89 | 15.9 | no |
| 32 | 1 | 1371 | n/a | 0 | 32.12 | 41.60 | 7.93 | 31.7 | no |
| 64 | 3 | 1396 | 1392 to 1403 | 0 | 55.06 | 74.17 | 7.93 | 63.4 | no |
| 128 | 1 | 1341 | n/a | 0 | 104.90 | 125.34 | 7.93 | 125.6 | no |
