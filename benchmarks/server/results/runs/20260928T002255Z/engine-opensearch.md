# opensearch retrieval (keyword, vector, hybrid)

## Environment

- Captured: 2026-09-28T00:31:16.116345+00:00
- Machine: GCP c3-standard-8, us-central1-a
- OS / arch: Linux 7.0.0-1011-gcp / x86_64 (containerized: True)
- CPU: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical)
- Memory: 33.6 GB
- Memory cap per engine: 21.5 GB
- Tracks: keyword, vector, hybrid
- Keyword setup: BM25 k1=0.9 b=0.4 (custom default similarity); OpenSearch `english` analyzer
- Run depth: 1000; run tag: opensearch_bm25
- Engine build: version 3.8.0, commit e5a3c5691be8
- Engine image: opensearchproject/opensearch@sha256:fafe3fc3587088674669235575aa166228c48bdb940294a8cdbbc1da75236a40
- Dataset beir/scifact/test: content md5 5f7d1de60b170fc8027bb7898e2efca1
- Dataset beir/nfcorpus/test: content md5 a89dba18a62ef92f7d323ec890a0d38d

## Keyword track

Retrieval quality vs Anserini BM25 reference:

| Dataset | nDCG@10 | Reference | Delta | Status | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 0.6789 | 0.6790 | -0.0001 | within margin | 0.9253 | 0.6401 | 0.6506 |
| beir/nfcorpus/test | 0.3206 | 0.3220 | -0.0014 | within margin | 0.2457 | 0.1503 | 0.5255 |
| dbpedia-entities-openai-100k | n/a | n/a | n/a | no baseline | n/a | n/a | n/a |
| dbpedia-entities-openai-1m | n/a | n/a | n/a | no baseline | n/a | n/a | n/a |

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | Index size | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 5190 | 1.00 | 7.2 MB | 1.00 | 1.00 | 1.00 |
| beir/nfcorpus/test | 3633 | 7185 | 0.51 | 5.2 MB | 0.00 | 0.00 | 0.00 |
| dbpedia-entities-openai-100k | 100000 | 38105 | 2.62 | 32.8 MB | 0.00 | 0.00 | 0.00 |
| dbpedia-entities-openai-1m | 995000 | 41740 | 23.84 | 356.9 MB | 0.00 | 1.00 | 1.00 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 2.46 | 3.07 | 3.42 |
| beir/nfcorpus/test | 1.23 | 1.46 | 1.57 |
| dbpedia-entities-openai-100k | 1.21 | 1.51 | 1.67 |
| dbpedia-entities-openai-1m | 1.36 | 1.95 | 2.39 |

Server-side time source per dataset:

- beir/scifact/test: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- beir/nfcorpus/test: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- dbpedia-entities-openai-100k: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- dbpedia-entities-openai-1m: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 544 | n/a | 0 | 2.18 | 4.50 | 1.35 | 1.0 | no |
| 2 | 1 | 1106 | n/a | 0 | 2.20 | 2.73 | 1.90 | 2.0 | no |
| 4 | 1 | 2113 | n/a | 0 | 2.31 | 4.44 | 2.63 | 4.0 | no |
| 8 | 1 | 2798 | n/a | 0 | 4.10 | 44.46 | 3.32 | 8.0 | no |
| 16 | 3 | 3027 | 2989 to 3031 | 0 | 8.72 | 29.98 | 3.41 | 16.0 | no |
| 32 | 1 | 2804 | n/a | 0 | 18.90 | 37.25 | 3.22 | 31.9 | no |
| 64 | 1 | 2558 | n/a | 0 | 45.90 | 85.11 | 2.96 | 63.5 | no |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 879 | n/a | 0 | 1.40 | 1.66 | 0.54 | 1.0 | no |
| 2 | 1 | 1505 | n/a | 0 | 1.60 | 2.03 | 1.02 | 2.0 | no |
| 4 | 1 | 2567 | n/a | 0 | 1.85 | 2.48 | 1.98 | 4.0 | no |
| 8 | 1 | 3194 | n/a | 0 | 3.74 | 8.19 | 2.73 | 8.0 | no |
| 16 | 3 | 3252 | 3250 to 3261 | 0 | 8.04 | 17.54 | 2.79 | 16.0 | no |
| 32 | 1 | 2960 | n/a | 0 | 17.76 | 38.52 | 2.50 | 31.9 | yes |
| 64 | 1 | 2784 | n/a | 0 | 42.00 | 87.53 | 2.29 | 63.5 | yes |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 839 | n/a | 0 | 1.46 | 2.32 | 0.50 | 1.0 | no |
| 2 | 1 | 1448 | n/a | 0 | 1.68 | 2.04 | 1.04 | 2.0 | no |
| 4 | 1 | 2514 | n/a | 0 | 1.91 | 2.57 | 2.01 | 4.0 | no |
| 8 | 1 | 3188 | n/a | 0 | 3.75 | 6.39 | 2.73 | 8.0 | no |
| 16 | 3 | 3242 | 3232 to 3245 | 0 | 8.07 | 17.71 | 2.80 | 16.0 | no |
| 32 | 1 | 2959 | n/a | 0 | 17.83 | 35.12 | 2.60 | 31.9 | no |
| 64 | 1 | 2690 | n/a | 0 | 43.24 | 84.06 | 2.39 | 63.5 | yes |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 705 | n/a | 0 | 1.93 | 4.52 | 0.69 | 1.0 | no |
| 2 | 1 | 1252 | n/a | 0 | 2.16 | 3.65 | 1.22 | 2.0 | no |
| 4 | 1 | 2181 | n/a | 0 | 2.46 | 3.91 | 2.32 | 4.0 | no |
| 8 | 1 | 2800 | n/a | 0 | 4.30 | 31.68 | 3.32 | 8.0 | no |
| 16 | 3 | 2994 | 2956 to 2999 | 0 | 8.95 | 27.69 | 3.55 | 16.0 | no |
| 32 | 1 | 2829 | n/a | 0 | 18.95 | 35.74 | 3.34 | 31.9 | no |
| 64 | 1 | 2630 | n/a | 0 | 45.30 | 80.11 | 3.04 | 63.5 | no |

## Vector track

- Embedding model: sentence-transformers/all-MiniLM-L6-v2 (384 dim, cosine)
- Index setup: knn_vector HNSW (faiss engine, inner product on L2-normalized vectors = cosine), over the shared precomputed vectors
- Operating point: search knob tuned to ann_recall@10 >= 0.99 against exact kNN over the same vectors

Retrieval quality vs human judgements:

| Dataset | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| beir/scifact/test | 0.6239 | 0.9227 | 0.5797 | 0.5849 |
| beir/nfcorpus/test | 0.3145 | 0.3094 | 0.1575 | 0.5168 |
| dbpedia-entities-openai-100k | n/a | n/a | n/a | n/a |
| dbpedia-entities-openai-1m | n/a | n/a | n/a | n/a |

Recall operating point (latency below is measured here, the matched-recall rule for ANN search):

| Dataset | Knob | Value | ANN recall@k | Target met | Secondary value | Secondary recall |
| --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | ef_search | 64 | 0.9957 | yes | 32 | 0.9827 |
| beir/nfcorpus/test | ef_search | 128 | 0.9947 | yes | 64 | 0.9783 |
| dbpedia-entities-openai-100k | ef_search | 128 | 0.9918 | yes | 32 | 0.9597 |
| dbpedia-entities-openai-1m | ef_search | 384 | 0.9940 | yes | 64 | 0.9586 |

Latency is measured at the operating point.

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | Index size | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 1002 | 5.17 | 23.7 MB | 0.00 | 0.00 | 1.00 |
| beir/nfcorpus/test | 3633 | 1120 | 3.24 | 16.8 MB | 0.00 | 0.00 | 0.00 |
| dbpedia-entities-openai-100k | 100000 | 366 | 273.58 | 1276.0 MB | 1.00 | 1.00 | 1.00 |
| dbpedia-entities-openai-1m | 995000 | 191 | 5218.66 | 12729.6 MB | 4.00 | 5.00 | 6.00 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 1.80 | 2.22 | 2.41 |
| beir/nfcorpus/test | 1.76 | 1.96 | 2.07 |
| dbpedia-entities-openai-100k | 3.45 | 3.87 | 4.04 |
| dbpedia-entities-openai-1m | 6.31 | 7.85 | 8.78 |

Server-side time source per dataset:

- beir/scifact/test: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- beir/nfcorpus/test: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- dbpedia-entities-openai-100k: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- dbpedia-entities-openai-1m: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 577 | n/a | 0 | 1.88 | 2.37 | 0.49 | 1.0 | no |
| 2 | 1 | 1051 | n/a | 0 | 2.20 | 2.57 | 0.98 | 2.0 | no |
| 4 | 1 | 1795 | n/a | 0 | 2.53 | 3.36 | 1.86 | 4.0 | no |
| 8 | 1 | 2224 | n/a | 0 | 5.32 | 12.16 | 2.56 | 8.0 | no |
| 16 | 3 | 2300 | 2297 to 2304 | 0 | 11.17 | 30.37 | 2.67 | 16.0 | no |
| 32 | 1 | 2156 | n/a | 0 | 24.30 | 43.33 | 2.50 | 31.9 | yes |
| 64 | 1 | 2112 | n/a | 0 | 54.64 | 94.48 | 2.47 | 63.4 | yes |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 562 | n/a | 0 | 1.97 | 2.48 | 0.50 | 1.0 | no |
| 2 | 1 | 994 | n/a | 0 | 2.35 | 2.84 | 1.00 | 2.0 | no |
| 4 | 1 | 1729 | n/a | 0 | 2.62 | 4.38 | 1.94 | 4.0 | no |
| 8 | 1 | 2168 | n/a | 0 | 5.47 | 7.75 | 2.67 | 8.0 | no |
| 16 | 3 | 2253 | 2244 to 2253 | 0 | 11.46 | 32.04 | 2.82 | 16.0 | no |
| 32 | 1 | 2125 | n/a | 0 | 24.46 | 48.60 | 2.66 | 31.8 | no |
| 64 | 1 | 2045 | n/a | 0 | 55.40 | 102.89 | 2.58 | 63.4 | yes |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 285 | n/a | 0 | 3.90 | 4.17 | 0.52 | 1.0 | no |
| 2 | 1 | 530 | n/a | 0 | 4.75 | 5.81 | 0.99 | 2.0 | no |
| 4 | 1 | 959 | n/a | 0 | 5.02 | 5.91 | 1.86 | 4.0 | no |
| 8 | 1 | 1151 | n/a | 0 | 10.43 | 12.91 | 2.70 | 8.0 | no |
| 16 | 3 | 1211 | 1209 to 1216 | 0 | 21.60 | 31.32 | 2.93 | 15.9 | no |
| 32 | 1 | 1172 | n/a | 0 | 43.29 | 69.49 | 2.94 | 31.8 | no |
| 64 | 1 | 1135 | n/a | 0 | 97.70 | 160.87 | 2.84 | 63.0 | no |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 171 | n/a | 0 | 7.32 | 8.07 | 0.71 | 1.0 | no |
| 2 | 1 | 338 | n/a | 0 | 7.45 | 10.71 | 1.38 | 2.0 | no |
| 4 | 1 | 592 | n/a | 0 | 8.75 | 18.21 | 2.55 | 4.0 | no |
| 8 | 1 | 791 | n/a | 0 | 14.98 | 20.97 | 4.10 | 8.0 | no |
| 16 | 3 | 869 | 869 to 872 | 0 | 30.14 | 44.07 | 4.66 | 15.9 | no |
| 32 | 1 | 865 | n/a | 0 | 61.02 | 101.09 | 4.86 | 31.7 | no |
| 64 | 1 | 864 | n/a | 0 | 116.46 | 166.63 | 4.80 | 62.5 | no |

## Hybrid track

- Setup: BM25 match fused with knn via a hybrid query and an RRF search pipeline
- Fusion: score-ranker-processor RRF (rank_constant=60)

Retrieval quality vs human judgements:

| Dataset | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| beir/scifact/test | 0.7053 | 0.9610 | 0.6587 | 0.6643 |
| beir/nfcorpus/test | 0.3522 | 0.3215 | 0.1867 | 0.5649 |
| dbpedia-entities-openai-100k | n/a | n/a | n/a | n/a |
| dbpedia-entities-openai-1m | n/a | n/a | n/a | n/a |

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | Index size | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 1090 | 4.75 | 23.7 MB | 1.00 | 2.00 | 2.00 |
| beir/nfcorpus/test | 3633 | 1147 | 3.17 | 16.8 MB | 1.00 | 1.00 | 1.00 |
| dbpedia-entities-openai-100k | 100000 | 370 | 270.29 | 1276.0 MB | 1.00 | 2.00 | 2.00 |
| dbpedia-entities-openai-1m | 995000 | 188 | 5290.81 | 12729.5 MB | 4.00 | 6.00 | 7.00 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 2.81 | 3.42 | 3.72 |
| beir/nfcorpus/test | 2.36 | 2.74 | 2.97 |
| dbpedia-entities-openai-100k | 3.97 | 4.44 | 4.64 |
| dbpedia-entities-openai-1m | 6.96 | 8.90 | 10.13 |

Server-side time source per dataset:

- beir/scifact/test: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- beir/nfcorpus/test: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- dbpedia-entities-openai-100k: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- dbpedia-entities-openai-1m: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 365 | n/a | 0 | 3.27 | 4.31 | 0.78 | 1.0 | no |
| 2 | 1 | 676 | n/a | 0 | 3.57 | 4.39 | 1.58 | 2.0 | no |
| 4 | 1 | 1215 | n/a | 0 | 3.93 | 4.70 | 2.59 | 4.0 | no |
| 8 | 1 | 1634 | n/a | 0 | 7.05 | 14.34 | 3.88 | 8.0 | no |
| 16 | 3 | 1775 | 1771 to 1781 | 0 | 14.62 | 37.12 | 4.32 | 15.9 | no |
| 32 | 1 | 1769 | n/a | 0 | 30.39 | 56.15 | 4.47 | 31.8 | no |
| 64 | 1 | 1741 | n/a | 0 | 62.22 | 103.41 | 4.39 | 63.3 | no |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 421 | n/a | 0 | 2.69 | 3.00 | 0.62 | 1.0 | no |
| 2 | 1 | 767 | n/a | 0 | 3.06 | 5.29 | 1.23 | 2.0 | no |
| 4 | 1 | 1356 | n/a | 0 | 3.49 | 4.06 | 2.41 | 4.0 | no |
| 8 | 1 | 1803 | n/a | 0 | 6.48 | 12.58 | 3.56 | 8.0 | no |
| 16 | 3 | 1934 | 1931 to 1937 | 0 | 13.43 | 32.86 | 3.90 | 16.0 | no |
| 32 | 1 | 1927 | n/a | 0 | 27.53 | 47.31 | 3.89 | 31.8 | no |
| 64 | 1 | 1809 | n/a | 0 | 63.22 | 106.93 | 3.52 | 63.3 | no |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 250 | n/a | 0 | 4.43 | 4.84 | 0.58 | 1.0 | no |
| 2 | 1 | 468 | n/a | 0 | 5.21 | 12.05 | 1.19 | 2.0 | no |
| 4 | 1 | 831 | n/a | 0 | 5.77 | 6.80 | 2.09 | 4.0 | no |
| 8 | 1 | 1041 | n/a | 0 | 11.47 | 14.43 | 3.19 | 8.0 | no |
| 16 | 3 | 1110 | 1109 to 1114 | 0 | 23.27 | 35.08 | 3.49 | 15.9 | no |
| 32 | 1 | 1094 | n/a | 0 | 46.70 | 70.45 | 3.43 | 31.7 | no |
| 64 | 1 | 1038 | n/a | 0 | 106.26 | 178.21 | 3.37 | 62.9 | no |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 152 | n/a | 0 | 8.17 | 10.09 | 0.75 | 1.0 | no |
| 2 | 1 | 296 | n/a | 0 | 8.59 | 11.47 | 1.43 | 2.0 | no |
| 4 | 1 | 504 | n/a | 0 | 10.65 | 13.81 | 2.87 | 4.0 | no |
| 8 | 1 | 712 | n/a | 0 | 16.25 | 21.75 | 4.44 | 8.0 | no |
| 16 | 1 | 781 | n/a | 0 | 33.67 | 50.72 | 5.02 | 15.9 | no |
| 32 | 1 | 784 | n/a | 0 | 66.04 | 114.49 | 5.18 | 31.6 | no |
| 64 | 3 | 792 | 791 to 795 | 0 | 119.59 | 215.81 | 5.20 | 62.6 | no |
