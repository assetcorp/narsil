# opensearch retrieval (keyword, vector, hybrid, best-config vector profile)

## Environment

- Captured: 2026-11-17T11:21:20.491486+00:00
- Load machine: GCP c3-standard-8, us-west1-a
- OS / arch: Linux 7.0.0-1017-gcp / x86_64 (containerized: True)
- CPU: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical)
- Memory: 33.6 GB
- Engine machine label: GCP c3-standard-8, us-west1-a
- Engine machine: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical), 33.6 GB
- Network round trip to the engine machine: p50 0.078 ms, p99 0.136 ms over 200 TCP connects
- Memory cap per engine: 21.5 GB
- Tracks: keyword, vector, hybrid
- Keyword setup: BM25 k1=0.9 b=0.4 (custom default similarity); OpenSearch `english` analyzer
- Run depth: 1000; run tag: opensearch_bm25
- Engine build: version 3.9.0, commit 4ee42a94e87f
- Engine image: opensearchproject/opensearch@sha256:3bf4fe26aeb9f7b03c0ebcb1302bb24e855ee6b89fd926d26a71a83ef6f7e076
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
| beir/nfcorpus/test | 0.3147 | 0.3094 | 0.1575 | 0.5184 |
| dbpedia-entities-openai-100k | n/a | n/a | n/a | n/a |
| dbpedia-entities-openai-1m | n/a | n/a | n/a | n/a |

Recall operating point (latency below is measured here, the matched-recall rule for ANN search):

| Dataset | Knob | Value | ANN recall@k | Target met | Secondary value | Secondary recall |
| --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | ef_search | 64 | 0.9980 | yes | 32 | 0.9833 |
| beir/nfcorpus/test | ef_search | 128 | 0.9947 | yes | 64 | 0.9808 |
| dbpedia-entities-openai-100k | ef_search | 160 | 0.9911 | yes | 32 | 0.9530 |
| dbpedia-entities-openai-1m | ef_search | 768 | 0.9904 | yes | 64 | 0.9523 |

Latency is measured at the operating point.

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | On disk | Peak heap | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 1079 | 4.80 | 0.02 GB | 8.43 GB | 0.00 | 0.00 | 0.00 |
| beir/nfcorpus/test | 3633 | 1172 | 3.10 | 0.01 GB | 8.44 GB | 0.00 | 0.00 | 0.00 |
| dbpedia-entities-openai-100k | 100000 | 683 | 146.33 | 0.68 GB | 8.53 GB | 0.00 | 1.00 | 1.00 |
| dbpedia-entities-openai-1m | 995000 | 477 | 2086.52 | 6.81 GB | 9.17 GB | 2.00 | 2.00 | 2.00 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 1.74 | 1.89 | 2.02 |
| beir/nfcorpus/test | 1.70 | 1.87 | 1.99 |
| dbpedia-entities-openai-100k | 2.90 | 3.10 | 3.26 |
| dbpedia-entities-openai-1m | 4.31 | 4.75 | 4.90 |

Engine container memory through the whole track, load included (anonymous memory is the heap the kernel cannot reclaim; charged memory adds the page cache of the engine's files):

| Dataset | Peak anonymous | Peak charged | Samples |
| --- | --- | --- | --- |
| beir/scifact/test | 8.43 GB | 8.54 GB | 513 |
| beir/nfcorpus/test | 8.44 GB | 8.52 GB | 549 |
| dbpedia-entities-openai-100k | 8.53 GB | 10.26 GB | 1055 |
| dbpedia-entities-openai-1m | 9.17 GB | 21.47 GB | 7800 |

Server-side time source per dataset:

- beir/scifact/test: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- beir/nfcorpus/test: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- dbpedia-entities-openai-100k: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- dbpedia-entities-openai-1m: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 574 | n/a | 0 | 1.87 | 2.13 | 0.50 | 1.0 | no |
| 2 | 1 | 1147 | n/a | 0 | 1.89 | 2.25 | 1.00 | 2.0 | no |
| 4 | 1 | 2121 | n/a | 0 | 2.07 | 4.25 | 2.06 | 4.0 | no |
| 8 | 1 | 2448 | n/a | 0 | 4.69 | 5.50 | 2.54 | 8.0 | no |
| 16 | 3 | 2801 | 2801 to 2802 | 0 | 8.86 | 25.40 | 2.92 | 16.0 | yes |
| 32 | 1 | 2636 | n/a | 0 | 19.46 | 36.67 | 2.75 | 31.9 | yes |
| 64 | 1 | 2427 | n/a | 0 | 45.77 | 82.26 | 2.47 | 63.5 | yes |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 587 | n/a | 0 | 1.86 | 2.10 | 0.50 | 1.0 | no |
| 2 | 1 | 1125 | n/a | 0 | 1.93 | 2.20 | 1.03 | 2.0 | no |
| 4 | 1 | 2073 | n/a | 0 | 2.18 | 4.06 | 2.07 | 4.0 | no |
| 8 | 1 | 2508 | n/a | 0 | 4.63 | 13.98 | 2.74 | 8.0 | no |
| 16 | 3 | 2796 | 2792 to 2804 | 0 | 8.89 | 25.97 | 3.03 | 16.0 | yes |
| 32 | 1 | 2593 | n/a | 0 | 19.67 | 36.58 | 2.72 | 31.9 | yes |
| 64 | 1 | 2386 | n/a | 0 | 46.70 | 85.23 | 2.50 | 63.5 | yes |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 345 | n/a | 0 | 3.06 | 3.26 | 0.43 | 1.0 | no |
| 2 | 1 | 682 | n/a | 0 | 3.14 | 3.55 | 0.86 | 2.0 | no |
| 4 | 1 | 1311 | n/a | 0 | 3.31 | 3.85 | 1.77 | 4.0 | no |
| 8 | 1 | 1444 | n/a | 0 | 8.26 | 85.53 | 2.05 | 8.0 | no |
| 16 | 3 | 1607 | 1601 to 1608 | 0 | 15.58 | 97.50 | 2.34 | 16.0 | yes |
| 32 | 1 | 1566 | n/a | 0 | 34.21 | 114.00 | 2.36 | 31.8 | yes |
| 64 | 1 | 1480 | n/a | 0 | 74.40 | 154.55 | 2.19 | 63.3 | yes |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 240 | n/a | 0 | 4.68 | 4.98 | 0.59 | 1.0 | no |
| 2 | 1 | 467 | n/a | 0 | 5.31 | 6.44 | 1.21 | 2.0 | no |
| 4 | 1 | 910 | n/a | 0 | 5.42 | 6.19 | 2.41 | 4.0 | no |
| 8 | 1 | 1258 | n/a | 0 | 9.20 | 13.07 | 3.29 | 8.0 | no |
| 16 | 1 | 1568 | n/a | 0 | 15.57 | 98.17 | 4.34 | 15.9 | yes |
| 32 | 3 | 1592 | 1581 to 1599 | 0 | 32.81 | 116.33 | 4.55 | 31.8 | yes |
| 64 | 1 | 1453 | n/a | 0 | 74.04 | 168.07 | 4.47 | 63.2 | yes |

## Hybrid track

- Setup: BM25 match fused with SQfp16-quantized knn via a hybrid query and an RRF search pipeline
- Fusion: score-ranker-processor RRF (rank_constant=60)

Retrieval quality vs human judgements:

| Dataset | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| beir/scifact/test | 0.7069 | 0.9610 | 0.6608 | 0.6665 |
| beir/nfcorpus/test | 0.3520 | 0.3213 | 0.1867 | 0.5633 |
| dbpedia-entities-openai-100k | n/a | n/a | n/a | n/a |
| dbpedia-entities-openai-1m | n/a | n/a | n/a | n/a |

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | On disk | Peak heap | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 1140 | 4.55 | 0.02 GB | 8.43 GB | 1.00 | 2.00 | 2.00 |
| beir/nfcorpus/test | 3633 | 1172 | 3.10 | 0.01 GB | 8.44 GB | 1.00 | 1.00 | 1.00 |
| dbpedia-entities-openai-100k | 100000 | 689 | 145.05 | 0.68 GB | 8.60 GB | 1.00 | 1.00 | 1.00 |
| dbpedia-entities-openai-1m | 995000 | 516 | 1928.88 | 6.81 GB | 9.25 GB | 3.00 | 8.00 | 11.00 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 2.71 | 3.24 | 3.44 |
| beir/nfcorpus/test | 2.29 | 2.59 | 2.74 |
| dbpedia-entities-openai-100k | 3.38 | 3.68 | 3.83 |
| dbpedia-entities-openai-1m | 5.92 | 10.61 | 13.96 |

Engine container memory through the whole track, load included (anonymous memory is the heap the kernel cannot reclaim; charged memory adds the page cache of the engine's files):

| Dataset | Peak anonymous | Peak charged | Samples |
| --- | --- | --- | --- |
| beir/scifact/test | 8.43 GB | 8.53 GB | 429 |
| beir/nfcorpus/test | 8.44 GB | 8.53 GB | 406 |
| dbpedia-entities-openai-100k | 8.60 GB | 10.34 GB | 815 |
| dbpedia-entities-openai-1m | 9.25 GB | 21.47 GB | 6291 |

Server-side time source per dataset:

- beir/scifact/test: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- beir/nfcorpus/test: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- dbpedia-entities-openai-100k: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- dbpedia-entities-openai-1m: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 365 | n/a | 0 | 3.20 | 3.57 | 0.69 | 1.0 | no |
| 2 | 1 | 696 | n/a | 0 | 3.45 | 4.57 | 1.38 | 2.0 | no |
| 4 | 1 | 1329 | n/a | 0 | 3.60 | 7.13 | 2.85 | 4.0 | no |
| 8 | 1 | 1895 | n/a | 0 | 5.80 | 8.57 | 4.40 | 8.0 | no |
| 16 | 1 | 2537 | n/a | 0 | 9.54 | 28.07 | 6.28 | 16.0 | yes |
| 32 | 3 | 2684 | 2671 to 2687 | 0 | 18.78 | 35.33 | 6.76 | 31.9 | yes |
| 64 | 1 | 2323 | n/a | 0 | 45.80 | 77.87 | 5.68 | 63.5 | yes |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 438 | n/a | 0 | 2.58 | 2.95 | 0.62 | 1.0 | no |
| 2 | 1 | 840 | n/a | 0 | 2.73 | 3.16 | 1.26 | 2.0 | no |
| 4 | 1 | 1559 | n/a | 0 | 3.00 | 7.11 | 2.63 | 4.0 | no |
| 8 | 1 | 2091 | n/a | 0 | 5.39 | 8.74 | 3.80 | 8.0 | no |
| 16 | 1 | 2670 | n/a | 0 | 9.06 | 26.09 | 5.05 | 16.0 | yes |
| 32 | 3 | 2673 | 2671 to 2677 | 0 | 19.24 | 36.98 | 5.08 | 31.9 | yes |
| 64 | 1 | 2343 | n/a | 0 | 46.06 | 81.87 | 4.19 | 63.5 | yes |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 293 | n/a | 0 | 3.69 | 4.33 | 0.51 | 1.0 | no |
| 2 | 1 | 564 | n/a | 0 | 4.00 | 4.44 | 1.03 | 2.0 | no |
| 4 | 1 | 1097 | n/a | 0 | 4.07 | 7.77 | 2.14 | 4.0 | no |
| 8 | 1 | 1308 | n/a | 0 | 9.10 | 10.74 | 2.73 | 8.0 | no |
| 16 | 3 | 1567 | 1546 to 1567 | 0 | 16.14 | 97.55 | 3.38 | 16.0 | yes |
| 32 | 1 | 1529 | n/a | 0 | 34.34 | 135.64 | 3.38 | 31.8 | yes |
| 64 | 1 | 1434 | n/a | 0 | 76.99 | 172.96 | 3.11 | 63.3 | yes |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 198 | n/a | 0 | 6.13 | 9.48 | 0.65 | 1.0 | no |
| 2 | 1 | 389 | n/a | 0 | 6.63 | 9.40 | 1.33 | 2.0 | no |
| 4 | 1 | 721 | n/a | 0 | 7.05 | 11.57 | 2.59 | 4.0 | no |
| 8 | 1 | 1083 | n/a | 0 | 10.47 | 13.79 | 4.06 | 8.0 | no |
| 16 | 1 | 1470 | n/a | 0 | 16.24 | 98.82 | 5.86 | 15.9 | yes |
| 32 | 3 | 1559 | 1547 to 1561 | 0 | 32.45 | 115.19 | 6.56 | 31.8 | yes |
| 64 | 1 | 1453 | n/a | 0 | 72.67 | 152.40 | 6.29 | 63.2 | yes |
