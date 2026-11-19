# opensearch retrieval (keyword, vector, hybrid, best-config vector profile)

## Environment

- Captured: 2026-11-19T17:20:50.586532+00:00
- Load machine: GCP c3-standard-8, us-west1-a
- OS / arch: Linux 7.0.0-1017-gcp / x86_64 (containerized: True)
- CPU: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical)
- Memory: 33.6 GB
- Engine machine label: GCP c3-standard-8, us-west1-a
- Engine machine: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical), 33.6 GB
- Network round trip to the engine machine: p50 0.085 ms, p99 0.146 ms over 200 TCP connects
- Memory cap per engine: 21.5 GB
- Tracks: keyword, vector, hybrid
- Keyword setup: BM25 k1=0.9 b=0.4 (custom default similarity); OpenSearch `english` analyzer
- Run depth: 1000; run tag: opensearch_bm25
- Engine build: version 3.10.0, commit b9f09249b4a9
- Engine image: opensearchproject/opensearch@sha256:02d6d6e40c820ae08233b60540aa5d3d9364d64e2dc724e38d6c8c794879b2a0
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
| beir/nfcorpus/test | 0.3149 | 0.3094 | 0.1576 | 0.5194 |
| dbpedia-entities-openai-100k | n/a | n/a | n/a | n/a |
| dbpedia-entities-openai-1m | n/a | n/a | n/a | n/a |

Recall operating point (latency below is measured here, the matched-recall rule for ANN search):

| Dataset | Knob | Value | ANN recall@k | Target met | Secondary value | Secondary recall |
| --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | ef_search | 64 | 0.9957 | yes | 32 | 0.9830 |
| beir/nfcorpus/test | ef_search | 128 | 0.9926 | yes | 64 | 0.9802 |
| dbpedia-entities-openai-100k | ef_search | 160 | 0.9915 | yes | 32 | 0.9532 |
| dbpedia-entities-openai-1m | ef_search | 768 | 0.9904 | yes | 64 | 0.9526 |

Latency is measured at the operating point.

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | On disk | Peak heap | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 1123 | 4.61 | 0.02 GB | 8.55 GB | 0.00 | 0.00 | 0.00 |
| beir/nfcorpus/test | 3633 | 1205 | 3.02 | 0.01 GB | 8.56 GB | 0.00 | 0.00 | 0.00 |
| dbpedia-entities-openai-100k | 100000 | 693 | 144.20 | 0.68 GB | 8.63 GB | 0.00 | 0.00 | 1.00 |
| dbpedia-entities-openai-1m | 995000 | 556 | 1788.81 | 6.81 GB | 9.23 GB | 2.00 | 4.00 | 5.00 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 0.86 | 0.96 | 1.05 |
| beir/nfcorpus/test | 0.93 | 1.04 | 1.13 |
| dbpedia-entities-openai-100k | 1.32 | 1.48 | 1.59 |
| dbpedia-entities-openai-1m | 2.94 | 4.75 | 6.14 |

Engine container memory through the whole track, load included (anonymous memory is the heap the kernel cannot reclaim; charged memory adds the page cache of the engine's files):

| Dataset | Peak anonymous | Peak charged | Samples |
| --- | --- | --- | --- |
| beir/scifact/test | 8.55 GB | 8.65 GB | 679 |
| beir/nfcorpus/test | 8.56 GB | 8.64 GB | 727 |
| dbpedia-entities-openai-100k | 8.63 GB | 10.38 GB | 1779 |
| dbpedia-entities-openai-1m | 9.23 GB | 21.47 GB | 9155 |

Server-side time source per dataset:

- beir/scifact/test: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- beir/nfcorpus/test: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- dbpedia-entities-openai-100k: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- dbpedia-entities-openai-1m: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 1238 | n/a | 0 | 0.87 | 1.02 | 0.85 | 1.0 | no |
| 2 | 1 | 2176 | n/a | 0 | 1.02 | 1.33 | 1.71 | 1.9 | no |
| 4 | 1 | 3842 | n/a | 0 | 1.15 | 1.46 | 3.50 | 3.9 | no |
| 8 | 1 | 5909 | n/a | 0 | 1.86 | 2.81 | 5.86 | 7.8 | no |
| 16 | 1 | 7315 | n/a | 0 | 3.48 | 5.46 | 7.47 | 15.7 | no |
| 32 | 1 | 8022 | n/a | 0 | 7.66 | 13.95 | 7.83 | 31.6 | no |
| 64 | 3 | 8117 | 8113 to 8180 | 0 | 12.30 | 20.40 | 7.90 | 63.5 | no |
| 128 | 1 | 8109 | n/a | 0 | 20.63 | 32.86 | 7.90 | 127.3 | no |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 1192 | n/a | 0 | 0.91 | 1.01 | 0.86 | 1.0 | no |
| 2 | 1 | 2109 | n/a | 0 | 1.05 | 1.31 | 1.73 | 1.9 | no |
| 4 | 1 | 3668 | n/a | 0 | 1.20 | 1.73 | 3.55 | 3.9 | no |
| 8 | 1 | 5627 | n/a | 0 | 1.96 | 3.08 | 5.86 | 7.8 | no |
| 16 | 1 | 6858 | n/a | 0 | 3.76 | 7.96 | 7.49 | 15.7 | no |
| 32 | 1 | 7538 | n/a | 0 | 8.19 | 15.69 | 7.84 | 31.6 | no |
| 64 | 1 | 7667 | n/a | 0 | 12.94 | 21.09 | 7.87 | 63.6 | no |
| 128 | 3 | 7743 | 7685 to 7763 | 0 | 21.13 | 30.69 | 7.91 | 127.3 | no |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 828 | n/a | 0 | 1.34 | 1.45 | 0.90 | 1.0 | no |
| 2 | 1 | 1546 | n/a | 0 | 1.52 | 2.31 | 1.77 | 2.0 | no |
| 4 | 1 | 2771 | n/a | 0 | 1.69 | 2.62 | 3.63 | 3.9 | no |
| 8 | 1 | 4223 | n/a | 0 | 2.61 | 4.81 | 6.17 | 7.8 | no |
| 16 | 1 | 4725 | n/a | 0 | 5.33 | 9.08 | 7.44 | 15.8 | no |
| 32 | 1 | 5142 | n/a | 0 | 11.09 | 18.78 | 7.79 | 31.7 | no |
| 64 | 3 | 5168 | 5160 to 5185 | 0 | 18.41 | 28.03 | 7.85 | 63.6 | no |
| 128 | 1 | 5053 | n/a | 0 | 32.14 | 45.17 | 7.88 | 127.2 | no |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 353 | n/a | 0 | 3.27 | 3.73 | 0.95 | 1.0 | no |
| 2 | 1 | 674 | n/a | 0 | 3.90 | 5.35 | 1.89 | 2.0 | no |
| 4 | 1 | 1308 | n/a | 0 | 4.01 | 5.06 | 3.78 | 4.0 | no |
| 8 | 1 | 1900 | n/a | 0 | 6.10 | 10.31 | 6.52 | 7.9 | no |
| 16 | 1 | 2104 | n/a | 0 | 12.59 | 18.38 | 7.75 | 15.9 | no |
| 32 | 1 | 2174 | n/a | 0 | 20.62 | 30.24 | 7.92 | 31.8 | no |
| 64 | 1 | 2379 | n/a | 0 | 33.39 | 40.76 | 7.92 | 63.5 | no |
| 128 | 3 | 2849 | 2673 to 3018 | 0 | 52.96 | 67.58 | 7.95 | 126.8 | no |

## Hybrid track

- Setup: BM25 match fused with SQfp16-quantized knn via a hybrid query and an RRF search pipeline
- Fusion: score-ranker-processor RRF (rank_constant=60)

Retrieval quality vs human judgements:

| Dataset | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| beir/scifact/test | 0.7064 | 0.9610 | 0.6599 | 0.6665 |
| beir/nfcorpus/test | 0.3521 | 0.3216 | 0.1865 | 0.5638 |
| dbpedia-entities-openai-100k | n/a | n/a | n/a | n/a |
| dbpedia-entities-openai-1m | n/a | n/a | n/a | n/a |

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | On disk | Peak heap | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 1069 | 4.85 | 0.02 GB | 8.55 GB | 1.00 | 1.00 | 2.00 |
| beir/nfcorpus/test | 3633 | 1202 | 3.02 | 0.01 GB | 8.57 GB | 1.00 | 1.00 | 1.00 |
| dbpedia-entities-openai-100k | 100000 | 694 | 144.04 | 0.68 GB | 8.67 GB | 1.00 | 1.00 | 1.00 |
| dbpedia-entities-openai-1m | 995000 | 561 | 1773.15 | 6.81 GB | 9.37 GB | 3.00 | 6.00 | 9.00 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 1.77 | 2.28 | 2.50 |
| beir/nfcorpus/test | 1.44 | 1.70 | 1.86 |
| dbpedia-entities-openai-100k | 1.77 | 2.02 | 2.16 |
| dbpedia-entities-openai-1m | 3.88 | 7.26 | 9.79 |

Engine container memory through the whole track, load included (anonymous memory is the heap the kernel cannot reclaim; charged memory adds the page cache of the engine's files):

| Dataset | Peak anonymous | Peak charged | Samples |
| --- | --- | --- | --- |
| beir/scifact/test | 8.55 GB | 8.65 GB | 549 |
| beir/nfcorpus/test | 8.57 GB | 8.65 GB | 528 |
| dbpedia-entities-openai-100k | 8.67 GB | 10.41 GB | 1271 |
| dbpedia-entities-openai-1m | 9.37 GB | 21.47 GB | 6091 |

Server-side time source per dataset:

- beir/scifact/test: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- beir/nfcorpus/test: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- dbpedia-entities-openai-100k: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- dbpedia-entities-openai-1m: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 569 | n/a | 0 | 2.16 | 2.65 | 0.94 | 1.0 | no |
| 2 | 1 | 1051 | n/a | 0 | 2.39 | 3.11 | 1.89 | 2.0 | no |
| 4 | 1 | 1864 | n/a | 0 | 2.72 | 3.42 | 3.80 | 3.9 | no |
| 8 | 1 | 2763 | n/a | 0 | 4.19 | 6.15 | 6.37 | 7.9 | no |
| 16 | 1 | 3263 | n/a | 0 | 8.25 | 12.75 | 7.80 | 15.8 | no |
| 32 | 3 | 3353 | 3342 to 3362 | 0 | 13.92 | 20.37 | 7.95 | 31.8 | no |
| 64 | 1 | 3325 | n/a | 0 | 24.21 | 33.11 | 7.94 | 63.6 | no |
| 128 | 1 | 3349 | n/a | 0 | 44.43 | 58.10 | 7.94 | 126.9 | no |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 723 | n/a | 0 | 1.61 | 1.92 | 0.93 | 1.0 | no |
| 2 | 1 | 1317 | n/a | 0 | 1.84 | 2.45 | 1.90 | 2.0 | no |
| 4 | 1 | 2351 | n/a | 0 | 2.06 | 2.48 | 3.76 | 3.9 | no |
| 8 | 1 | 3513 | n/a | 0 | 3.27 | 5.67 | 6.27 | 7.8 | no |
| 16 | 1 | 4177 | n/a | 0 | 6.55 | 11.18 | 7.74 | 15.8 | no |
| 32 | 1 | 4330 | n/a | 0 | 11.37 | 18.24 | 7.92 | 31.8 | no |
| 64 | 3 | 4395 | 4347 to 4435 | 0 | 19.00 | 26.04 | 7.93 | 63.6 | no |
| 128 | 1 | 4371 | n/a | 0 | 34.49 | 46.97 | 7.95 | 127.1 | no |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 611 | n/a | 0 | 1.85 | 2.25 | 0.94 | 1.0 | no |
| 2 | 1 | 1102 | n/a | 0 | 2.15 | 3.27 | 1.91 | 2.0 | no |
| 4 | 1 | 1986 | n/a | 0 | 2.39 | 3.21 | 3.76 | 3.9 | no |
| 8 | 1 | 2962 | n/a | 0 | 3.81 | 7.34 | 6.44 | 7.9 | no |
| 16 | 1 | 3352 | n/a | 0 | 7.73 | 12.69 | 7.64 | 15.8 | no |
| 32 | 3 | 3515 | 3508 to 3549 | 0 | 14.08 | 21.76 | 7.88 | 31.8 | no |
| 64 | 1 | 3480 | n/a | 0 | 23.50 | 30.68 | 7.91 | 63.6 | no |
| 128 | 1 | 3381 | n/a | 0 | 44.32 | 56.82 | 7.88 | 126.9 | no |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 287 | n/a | 0 | 4.58 | 9.65 | 1.02 | 1.0 | no |
| 2 | 1 | 541 | n/a | 0 | 5.20 | 9.40 | 1.92 | 2.0 | no |
| 4 | 1 | 1034 | n/a | 0 | 5.45 | 9.78 | 3.84 | 4.0 | no |
| 8 | 1 | 1582 | n/a | 0 | 7.67 | 12.87 | 6.65 | 7.9 | no |
| 16 | 1 | 1700 | n/a | 0 | 14.92 | 24.90 | 7.81 | 15.9 | no |
| 32 | 1 | 1822 | n/a | 0 | 24.15 | 31.44 | 7.90 | 31.8 | no |
| 64 | 3 | 1952 | 1945 to 2019 | 0 | 39.46 | 55.20 | 7.90 | 63.5 | no |
| 128 | 1 | 1834 | n/a | 0 | 77.94 | 95.56 | 7.90 | 126.3 | no |
