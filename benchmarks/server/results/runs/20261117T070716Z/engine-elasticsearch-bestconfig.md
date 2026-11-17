# elasticsearch retrieval (keyword, vector, hybrid, best-config vector profile)

## Environment

- Captured: 2026-11-17T09:49:34.560846+00:00
- Load machine: GCP c3-standard-8, us-east4-a
- OS / arch: Linux 7.0.0-1017-gcp / x86_64 (containerized: True)
- CPU: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical)
- Memory: 33.6 GB
- Engine machine label: GCP c3-standard-8, us-east4-a
- Engine machine: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical), 33.6 GB
- Network round trip to the engine machine: p50 0.079 ms, p99 0.146 ms over 200 TCP connects
- Memory cap per engine: 21.5 GB
- Tracks: keyword, vector, hybrid
- Keyword setup: BM25 k1=0.9 b=0.4 (custom default similarity); Elasticsearch `english` analyzer
- Run depth: 1000; run tag: elasticsearch_bm25
- Engine build: version 9.5.6, commit fd1e8011342a
- Engine image: docker.elastic.co/elasticsearch/elasticsearch@sha256:79b4f1de4c15e6eca824723086a51e5934406d614d410cc11be77748cafac537
- Dataset beir/scifact/test: content md5 5f7d1de60b170fc8027bb7898e2efca1
- Dataset beir/nfcorpus/test: content md5 a89dba18a62ef92f7d323ec890a0d38d

## Vector track

- Embedding model: sentence-transformers/all-MiniLM-L6-v2 (384 dim, cosine)
- Index setup: dense_vector BBQ (bbq_hnsw, binary quantization) with full-precision rescore (oversample tuned to the recall target), similarity cosine
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
| beir/scifact/test | num_candidates | 16 | 0.9920 | yes | 16 | 0.9920 |
| beir/nfcorpus/test | num_candidates | 8192 | 0.9845 | NO | 16 | 0.9762 |
| dbpedia-entities-openai-100k | num_candidates | 1536 | 0.9917 | yes | 64 | 0.9604 |
| dbpedia-entities-openai-1m | num_candidates | 4096 | 0.9935 | yes | 128 | 0.9572 |

Latency is measured at the operating point.

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | On disk | Peak heap | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 1373 | 3.78 | 0.02 GB | 11.95 GB | 0.00 | 0.00 | 0.00 |
| beir/nfcorpus/test | 3633 | 1397 | 2.60 | 0.01 GB | 11.96 GB | 0.00 | 0.00 | 0.00 |
| dbpedia-entities-openai-100k | 100000 | 719 | 138.99 | 0.67 GB | 11.96 GB | 1.00 | 1.00 | 2.00 |
| dbpedia-entities-openai-1m | 995000 | 480 | 2073.62 | 6.73 GB | 11.97 GB | 4.00 | 6.00 | 7.00 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 1.84 | 2.01 | 2.14 |
| beir/nfcorpus/test | 2.06 | 2.23 | 2.38 |
| dbpedia-entities-openai-100k | 3.69 | 4.17 | 4.40 |
| dbpedia-entities-openai-1m | 6.37 | 8.32 | 9.21 |

Engine container memory through the whole track, load included (anonymous memory is the heap the kernel cannot reclaim; charged memory adds the page cache of the engine's files):

| Dataset | Peak anonymous | Peak charged | Samples |
| --- | --- | --- | --- |
| beir/scifact/test | 11.95 GB | 12.07 GB | 483 |
| beir/nfcorpus/test | 11.96 GB | 12.05 GB | 1358 |
| dbpedia-entities-openai-100k | 11.96 GB | 14.14 GB | 1778 |
| dbpedia-entities-openai-1m | 11.97 GB | 21.47 GB | 8366 |

Server-side time source per dataset:

- beir/scifact/test: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- beir/nfcorpus/test: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- dbpedia-entities-openai-100k: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- dbpedia-entities-openai-1m: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 547 | n/a | 0 | 1.95 | 2.24 | 0.50 | 1.0 | no |
| 2 | 1 | 1018 | n/a | 0 | 2.11 | 2.49 | 1.04 | 2.0 | no |
| 4 | 1 | 1902 | n/a | 0 | 2.26 | 18.21 | 2.17 | 4.0 | no |
| 8 | 1 | 2348 | n/a | 0 | 4.91 | 5.75 | 2.75 | 8.0 | no |
| 16 | 3 | 2658 | 2626 to 2662 | 0 | 9.33 | 35.55 | 3.14 | 16.0 | yes |
| 32 | 1 | 2469 | n/a | 0 | 20.93 | 43.00 | 2.91 | 31.9 | yes |
| 64 | 1 | 2307 | n/a | 0 | 48.05 | 84.66 | 2.66 | 63.5 | yes |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 497 | n/a | 0 | 2.13 | 2.52 | 0.54 | 1.0 | no |
| 2 | 1 | 917 | n/a | 0 | 2.34 | 2.61 | 1.12 | 2.0 | no |
| 4 | 1 | 1712 | n/a | 0 | 2.53 | 13.79 | 2.32 | 4.0 | no |
| 8 | 1 | 2217 | n/a | 0 | 5.11 | 28.47 | 3.16 | 8.0 | no |
| 16 | 3 | 2644 | 2643 to 2649 | 0 | 9.26 | 34.07 | 3.86 | 16.0 | yes |
| 32 | 1 | 2563 | n/a | 0 | 20.22 | 40.35 | 3.72 | 31.9 | yes |
| 64 | 1 | 2246 | n/a | 0 | 49.87 | 95.48 | 3.16 | 63.5 | yes |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 268 | n/a | 0 | 4.17 | 4.59 | 0.54 | 1.0 | no |
| 2 | 1 | 517 | n/a | 0 | 4.51 | 5.66 | 1.08 | 2.0 | no |
| 4 | 1 | 1004 | n/a | 0 | 4.57 | 6.46 | 2.19 | 4.0 | no |
| 8 | 1 | 1265 | n/a | 0 | 9.36 | 21.75 | 2.98 | 8.0 | no |
| 16 | 3 | 1532 | 1524 to 1534 | 0 | 16.06 | 115.09 | 3.85 | 15.9 | yes |
| 32 | 1 | 1521 | n/a | 0 | 34.27 | 119.14 | 3.87 | 31.8 | yes |
| 64 | 1 | 1433 | n/a | 0 | 75.43 | 167.89 | 3.59 | 63.3 | yes |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 165 | n/a | 0 | 7.90 | 9.43 | 0.72 | 1.0 | no |
| 2 | 1 | 320 | n/a | 0 | 8.19 | 10.85 | 1.40 | 2.0 | no |
| 4 | 1 | 620 | n/a | 0 | 8.50 | 15.51 | 2.82 | 4.0 | no |
| 8 | 1 | 950 | n/a | 0 | 11.82 | 14.58 | 4.64 | 8.0 | no |
| 16 | 1 | 1271 | n/a | 0 | 19.08 | 27.76 | 6.61 | 15.9 | no |
| 32 | 1 | 1273 | n/a | 0 | 40.94 | 57.26 | 7.14 | 31.8 | no |
| 64 | 3 | 1274 | 1267 to 1275 | 0 | 83.21 | 127.51 | 7.13 | 62.1 | no |

## Hybrid track

- Setup: BM25 match fused with BBQ dense_vector kNN (full-precision rescore) via the RRF retriever; the RRF retriever is not part of Elastic's free licence, so this run uses Elasticsearch's self-generated trial licence
- Fusion: RRF retriever (rank_constant=60)

Retrieval quality vs human judgements:

| Dataset | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| beir/scifact/test | 0.7071 | 0.9610 | 0.6608 | 0.6676 |
| beir/nfcorpus/test | 0.3516 | 0.3216 | 0.1863 | 0.5623 |
| dbpedia-entities-openai-100k | n/a | n/a | n/a | n/a |
| dbpedia-entities-openai-1m | n/a | n/a | n/a | n/a |

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | On disk | Peak heap | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 1562 | 3.32 | 0.02 GB | 11.95 GB | 1.00 | 1.00 | 1.00 |
| beir/nfcorpus/test | 3633 | 1234 | 2.94 | 0.01 GB | 11.96 GB | 1.00 | 1.00 | 1.00 |
| dbpedia-entities-openai-100k | 100000 | 718 | 139.20 | 0.67 GB | 11.96 GB | 1.00 | 2.00 | 2.00 |
| dbpedia-entities-openai-1m | 995000 | 631 | 1577.82 | 6.73 GB | 11.97 GB | 4.00 | 7.00 | 8.00 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 2.57 | 2.96 | 3.16 |
| beir/nfcorpus/test | 2.44 | 2.64 | 2.78 |
| dbpedia-entities-openai-100k | 4.23 | 4.72 | 4.96 |
| dbpedia-entities-openai-1m | 7.15 | 9.37 | 10.65 |

Engine container memory through the whole track, load included (anonymous memory is the heap the kernel cannot reclaim; charged memory adds the page cache of the engine's files):

| Dataset | Peak anonymous | Peak charged | Samples |
| --- | --- | --- | --- |
| beir/scifact/test | 11.95 GB | 12.08 GB | 390 |
| beir/nfcorpus/test | 11.96 GB | 12.06 GB | 388 |
| dbpedia-entities-openai-100k | 11.96 GB | 14.53 GB | 798 |
| dbpedia-entities-openai-1m | 11.97 GB | 21.47 GB | 4743 |

Server-side time source per dataset:

- beir/scifact/test: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- beir/nfcorpus/test: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- dbpedia-entities-openai-100k: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- dbpedia-entities-openai-1m: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 376 | n/a | 0 | 3.01 | 3.73 | 0.75 | 1.0 | no |
| 2 | 1 | 722 | n/a | 0 | 3.13 | 12.99 | 1.54 | 2.0 | no |
| 4 | 1 | 1325 | n/a | 0 | 3.56 | 13.41 | 3.02 | 4.0 | no |
| 8 | 1 | 1869 | n/a | 0 | 5.84 | 30.88 | 4.58 | 8.0 | no |
| 16 | 1 | 2421 | n/a | 0 | 9.85 | 39.43 | 6.07 | 16.0 | no |
| 32 | 3 | 2580 | 2570 to 2584 | 0 | 19.87 | 45.11 | 6.42 | 31.9 | yes |
| 64 | 1 | 2360 | n/a | 0 | 46.35 | 73.59 | 5.86 | 63.5 | yes |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 395 | n/a | 0 | 2.69 | 9.43 | 0.71 | 1.0 | no |
| 2 | 1 | 755 | n/a | 0 | 2.85 | 3.22 | 1.41 | 2.0 | no |
| 4 | 1 | 1414 | n/a | 0 | 3.07 | 13.31 | 2.91 | 4.0 | no |
| 8 | 1 | 1903 | n/a | 0 | 5.81 | 25.00 | 4.13 | 8.0 | no |
| 16 | 1 | 2504 | n/a | 0 | 9.57 | 32.82 | 5.56 | 16.0 | yes |
| 32 | 3 | 2557 | 2546 to 2595 | 0 | 20.29 | 56.87 | 5.70 | 31.9 | yes |
| 64 | 1 | 2251 | n/a | 0 | 48.25 | 88.44 | 4.80 | 63.4 | yes |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 236 | n/a | 0 | 4.72 | 5.09 | 0.63 | 1.0 | no |
| 2 | 1 | 454 | n/a | 0 | 5.01 | 6.60 | 1.26 | 2.0 | no |
| 4 | 1 | 860 | n/a | 0 | 5.47 | 6.75 | 2.51 | 4.0 | no |
| 8 | 1 | 1157 | n/a | 0 | 10.02 | 23.19 | 3.70 | 8.0 | no |
| 16 | 1 | 1451 | n/a | 0 | 16.85 | 134.69 | 4.86 | 15.9 | yes |
| 32 | 3 | 1519 | 1519 to 1528 | 0 | 34.49 | 144.55 | 5.14 | 31.8 | yes |
| 64 | 1 | 1390 | n/a | 0 | 77.93 | 171.79 | 4.71 | 63.2 | yes |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 148 | n/a | 0 | 8.57 | 12.36 | 0.80 | 1.0 | no |
| 2 | 1 | 284 | n/a | 0 | 9.23 | 11.83 | 1.56 | 2.0 | no |
| 4 | 1 | 555 | n/a | 0 | 9.19 | 21.89 | 3.12 | 4.0 | no |
| 8 | 1 | 826 | n/a | 0 | 13.32 | 18.34 | 5.07 | 8.0 | no |
| 16 | 1 | 1030 | n/a | 0 | 22.75 | 48.28 | 6.67 | 15.9 | no |
| 32 | 1 | 1027 | n/a | 0 | 48.53 | 62.14 | 6.99 | 31.7 | no |
| 64 | 3 | 1068 | 1066 to 1089 | 0 | 95.82 | 128.87 | 7.27 | 62.9 | no |
