# opensearch retrieval (keyword, vector, hybrid, best-config vector profile)

## Environment

- Captured: 2026-09-28T04:00:51.467639+00:00
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

## Vector track

- Embedding model: sentence-transformers/all-MiniLM-L6-v2 (384 dim, cosine)
- Index setup: knn_vector HNSW (faiss engine, 16-bit SQ / SQfp16 scalar quantization, inner product on L2-normalized vectors = cosine), over the shared precomputed vectors; 1-bit binary quantization cannot reach the recall target at this dimensionality
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
| beir/scifact/test | ef_search | 64 | 0.9967 | yes | 32 | 0.9873 |
| beir/nfcorpus/test | ef_search | 128 | 0.9935 | yes | 64 | 0.9780 |
| dbpedia-entities-openai-100k | ef_search | 192 | 0.9928 | yes | 32 | 0.9569 |
| dbpedia-entities-openai-1m | ef_search | 1024 | 0.9916 | yes | 128 | 0.9714 |

Latency is measured at the operating point.

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | Index size | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 1114 | 4.65 | 19.7 MB | 0.00 | 0.00 | 0.00 |
| beir/nfcorpus/test | 3633 | 1157 | 3.14 | 14.0 MB | 0.00 | 0.00 | 0.00 |
| dbpedia-entities-openai-100k | 100000 | 679 | 147.24 | 680.8 MB | 0.00 | 1.00 | 1.00 |
| dbpedia-entities-openai-1m | 995000 | 502 | 1983.87 | 6807.3 MB | 7.00 | 16.00 | 24.00 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 1.60 | 1.79 | 1.90 |
| beir/nfcorpus/test | 1.77 | 1.91 | 2.04 |
| dbpedia-entities-openai-100k | 2.93 | 3.13 | 3.27 |
| dbpedia-entities-openai-1m | 9.14 | 18.32 | 26.93 |

Server-side time source per dataset:

- beir/scifact/test: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- beir/nfcorpus/test: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- dbpedia-entities-openai-100k: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- dbpedia-entities-openai-1m: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 613 | n/a | 0 | 1.78 | 1.99 | 0.47 | 1.0 | no |
| 2 | 1 | 1068 | n/a | 0 | 2.21 | 2.58 | 0.95 | 2.0 | no |
| 4 | 1 | 1840 | n/a | 0 | 2.47 | 2.97 | 1.85 | 4.0 | no |
| 8 | 1 | 2255 | n/a | 0 | 5.22 | 12.29 | 2.54 | 8.0 | no |
| 16 | 3 | 2331 | 2330 to 2332 | 0 | 11.01 | 28.76 | 2.66 | 16.0 | no |
| 32 | 1 | 2183 | n/a | 0 | 23.77 | 43.60 | 2.48 | 31.9 | yes |
| 64 | 1 | 2053 | n/a | 0 | 56.45 | 106.50 | 2.42 | 63.4 | yes |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 584 | n/a | 0 | 1.85 | 2.11 | 0.48 | 1.0 | no |
| 2 | 1 | 1051 | n/a | 0 | 2.12 | 2.48 | 0.99 | 2.0 | no |
| 4 | 1 | 1800 | n/a | 0 | 2.52 | 3.10 | 1.89 | 4.0 | no |
| 8 | 1 | 2226 | n/a | 0 | 5.31 | 8.88 | 2.61 | 8.0 | no |
| 16 | 3 | 2299 | 2295 to 2301 | 0 | 11.28 | 29.39 | 2.73 | 16.0 | no |
| 32 | 1 | 2158 | n/a | 0 | 24.03 | 42.43 | 2.62 | 31.9 | no |
| 64 | 1 | 2073 | n/a | 0 | 55.79 | 97.67 | 2.49 | 63.4 | yes |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 346 | n/a | 0 | 3.05 | 3.35 | 0.43 | 1.0 | no |
| 2 | 1 | 644 | n/a | 0 | 3.46 | 4.68 | 0.86 | 2.0 | no |
| 4 | 1 | 1101 | n/a | 0 | 4.32 | 4.69 | 1.58 | 4.0 | no |
| 8 | 1 | 1294 | n/a | 0 | 9.20 | 13.44 | 2.11 | 8.0 | no |
| 16 | 3 | 1339 | 1337 to 1344 | 0 | 19.23 | 29.04 | 2.25 | 15.7 | yes |
| 32 | 1 | 1301 | n/a | 0 | 39.17 | 68.53 | 2.23 | 31.8 | yes |
| 64 | 1 | 1275 | n/a | 0 | 87.41 | 154.86 | 2.23 | 63.1 | yes |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 216 | n/a | 0 | 5.31 | 5.69 | 0.63 | 1.0 | no |
| 2 | 1 | 412 | n/a | 0 | 6.16 | 7.18 | 1.26 | 2.0 | no |
| 4 | 1 | 758 | n/a | 0 | 6.35 | 7.68 | 2.29 | 4.0 | no |
| 8 | 1 | 1020 | n/a | 0 | 11.68 | 16.77 | 3.45 | 8.0 | no |
| 16 | 3 | 1111 | 1109 to 1117 | 0 | 23.55 | 35.17 | 3.82 | 15.9 | no |
| 32 | 1 | 1069 | n/a | 0 | 49.67 | 76.49 | 4.24 | 31.7 | no |
| 64 | 1 | 1043 | n/a | 0 | 103.95 | 168.96 | 4.08 | 63.0 | no |

## Hybrid track

- Setup: BM25 match fused with SQfp16-quantized knn via a hybrid query and an RRF search pipeline
- Fusion: score-ranker-processor RRF (rank_constant=60)

Retrieval quality vs human judgements:

| Dataset | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| beir/scifact/test | 0.7053 | 0.9610 | 0.6587 | 0.6643 |
| beir/nfcorpus/test | 0.3514 | 0.3216 | 0.1864 | 0.5618 |
| dbpedia-entities-openai-100k | n/a | n/a | n/a | n/a |
| dbpedia-entities-openai-1m | n/a | n/a | n/a | n/a |

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | Index size | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 1151 | 4.50 | 19.7 MB | 1.00 | 1.00 | 2.00 |
| beir/nfcorpus/test | 3633 | 1151 | 3.16 | 14.1 MB | 1.00 | 1.00 | 1.00 |
| dbpedia-entities-openai-100k | 100000 | 670 | 149.16 | 680.8 MB | 1.00 | 1.00 | 1.00 |
| dbpedia-entities-openai-1m | 995000 | 492 | 2023.94 | 6807.4 MB | 3.00 | 5.00 | 7.00 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 2.60 | 3.12 | 3.36 |
| beir/nfcorpus/test | 2.35 | 2.63 | 2.75 |
| dbpedia-entities-openai-100k | 3.44 | 3.72 | 3.89 |
| dbpedia-entities-openai-1m | 5.96 | 7.98 | 9.34 |

Server-side time source per dataset:

- beir/scifact/test: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- beir/nfcorpus/test: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- dbpedia-entities-openai-100k: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- dbpedia-entities-openai-1m: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 380 | n/a | 0 | 3.09 | 3.39 | 0.67 | 1.0 | no |
| 2 | 1 | 693 | n/a | 0 | 3.46 | 4.32 | 1.31 | 2.0 | no |
| 4 | 1 | 1218 | n/a | 0 | 3.93 | 4.67 | 2.58 | 4.0 | no |
| 8 | 1 | 1644 | n/a | 0 | 7.07 | 13.29 | 3.98 | 8.0 | no |
| 16 | 1 | 1799 | n/a | 0 | 14.34 | 36.37 | 4.40 | 16.0 | no |
| 32 | 3 | 1818 | 1797 to 1822 | 0 | 29.84 | 55.05 | 4.52 | 31.8 | no |
| 64 | 1 | 1795 | n/a | 0 | 58.73 | 105.24 | 4.46 | 63.3 | no |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 441 | n/a | 0 | 2.56 | 2.83 | 0.60 | 1.0 | no |
| 2 | 1 | 794 | n/a | 0 | 2.97 | 3.63 | 1.20 | 2.0 | no |
| 4 | 1 | 1405 | n/a | 0 | 3.34 | 3.84 | 2.36 | 4.0 | no |
| 8 | 1 | 1849 | n/a | 0 | 6.37 | 12.80 | 3.49 | 8.0 | no |
| 16 | 3 | 1999 | 1982 to 2000 | 0 | 12.98 | 32.65 | 3.79 | 16.0 | no |
| 32 | 1 | 1963 | n/a | 0 | 26.84 | 46.23 | 3.80 | 31.8 | no |
| 64 | 1 | 1859 | n/a | 0 | 62.13 | 100.32 | 3.40 | 63.4 | no |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 291 | n/a | 0 | 3.72 | 4.11 | 0.52 | 1.0 | no |
| 2 | 1 | 539 | n/a | 0 | 4.41 | 8.18 | 1.05 | 2.0 | no |
| 4 | 1 | 940 | n/a | 0 | 5.03 | 5.65 | 1.91 | 4.0 | no |
| 8 | 1 | 1169 | n/a | 0 | 10.29 | 12.06 | 2.71 | 8.0 | no |
| 16 | 3 | 1239 | 1232 to 1246 | 0 | 20.92 | 30.85 | 2.97 | 15.9 | no |
| 32 | 1 | 1199 | n/a | 0 | 42.94 | 67.42 | 2.90 | 31.8 | no |
| 64 | 1 | 1157 | n/a | 0 | 94.27 | 164.38 | 2.79 | 63.0 | no |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 182 | n/a | 0 | 6.60 | 9.74 | 0.69 | 1.0 | no |
| 2 | 1 | 348 | n/a | 0 | 7.27 | 12.29 | 1.41 | 2.0 | no |
| 4 | 1 | 637 | n/a | 0 | 7.82 | 12.78 | 2.55 | 4.0 | no |
| 8 | 1 | 880 | n/a | 0 | 13.36 | 20.52 | 4.01 | 8.0 | no |
| 16 | 3 | 963 | 963 to 967 | 0 | 26.97 | 42.44 | 4.50 | 15.9 | no |
| 32 | 1 | 935 | n/a | 0 | 57.06 | 90.42 | 4.84 | 31.7 | no |
| 64 | 1 | 934 | n/a | 0 | 108.25 | 185.59 | 4.82 | 62.7 | no |
