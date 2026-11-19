# elasticsearch retrieval (keyword, vector, hybrid, best-config vector profile)

## Environment

- Captured: 2026-11-19T16:16:30.584154+00:00
- Load machine: GCP c3-standard-8, us-east4-a
- OS / arch: Linux 7.0.0-1017-gcp / x86_64 (containerized: True)
- CPU: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical)
- Memory: 33.6 GB
- Engine machine label: GCP c3-standard-8, us-east4-a
- Engine machine: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical), 33.6 GB
- Network round trip to the engine machine: p50 0.085 ms, p99 0.179 ms over 200 TCP connects
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
| beir/nfcorpus/test | 0.3147 | 0.3094 | 0.1576 | 0.5179 |
| dbpedia-entities-openai-100k | n/a | n/a | n/a | n/a |
| dbpedia-entities-openai-1m | n/a | n/a | n/a | n/a |

Recall operating point (latency below is measured here, the matched-recall rule for ANN search):

| Dataset | Knob | Value | ANN recall@k | Target met | Secondary value | Secondary recall |
| --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | num_candidates | 16 | 0.9907 | yes | 16 | 0.9907 |
| beir/nfcorpus/test | num_candidates | 8192 | 0.9848 | NO | 16 | 0.9706 |
| dbpedia-entities-openai-100k | num_candidates | 1536 | 0.9922 | yes | 64 | 0.9655 |
| dbpedia-entities-openai-1m | num_candidates | 4096 | 0.9937 | yes | 128 | 0.9532 |

Latency is measured at the operating point.

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | On disk | Peak heap | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 1431 | 3.62 | 0.02 GB | 11.93 GB | 0.00 | 0.00 | 0.00 |
| beir/nfcorpus/test | 3633 | 1396 | 2.60 | 0.01 GB | 11.93 GB | 0.00 | 0.00 | 0.00 |
| dbpedia-entities-openai-100k | 100000 | 587 | 170.22 | 0.67 GB | 11.94 GB | 1.00 | 2.00 | 2.00 |
| dbpedia-entities-openai-1m | 995000 | 555 | 1791.43 | 6.73 GB | 11.94 GB | 4.00 | 6.00 | 7.00 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 1.05 | 1.15 | 1.23 |
| beir/nfcorpus/test | 1.24 | 1.34 | 1.61 |
| dbpedia-entities-openai-100k | 2.24 | 2.77 | 3.00 |
| dbpedia-entities-openai-1m | 4.99 | 7.06 | 8.16 |

Engine container memory through the whole track, load included (anonymous memory is the heap the kernel cannot reclaim; charged memory adds the page cache of the engine's files):

| Dataset | Peak anonymous | Peak charged | Samples |
| --- | --- | --- | --- |
| beir/scifact/test | 11.93 GB | 12.05 GB | 638 |
| beir/nfcorpus/test | 11.93 GB | 12.03 GB | 2410 |
| dbpedia-entities-openai-100k | 11.94 GB | 14.67 GB | 4496 |
| dbpedia-entities-openai-1m | 11.94 GB | 21.47 GB | 10048 |

Server-side time source per dataset:

- beir/scifact/test: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- beir/nfcorpus/test: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- dbpedia-entities-openai-100k: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- dbpedia-entities-openai-1m: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 977 | n/a | 0 | 1.06 | 1.21 | 0.85 | 1.0 | no |
| 2 | 1 | 1821 | n/a | 0 | 1.18 | 1.32 | 1.73 | 1.9 | no |
| 4 | 1 | 3227 | n/a | 0 | 1.31 | 1.56 | 3.51 | 3.9 | no |
| 8 | 1 | 5021 | n/a | 0 | 2.00 | 2.79 | 5.91 | 7.8 | no |
| 16 | 1 | 6545 | n/a | 0 | 3.92 | 7.49 | 7.47 | 15.7 | no |
| 32 | 1 | 7422 | n/a | 0 | 8.21 | 32.76 | 7.81 | 31.6 | no |
| 64 | 3 | 7656 | 7553 to 7680 | 0 | 13.39 | 65.31 | 7.87 | 63.5 | no |
| 128 | 1 | 7526 | n/a | 0 | 22.34 | 73.95 | 7.82 | 127.2 | no |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 834 | n/a | 0 | 1.25 | 1.44 | 0.89 | 1.0 | no |
| 2 | 1 | 1520 | n/a | 0 | 1.42 | 1.66 | 1.76 | 2.0 | no |
| 4 | 1 | 2726 | n/a | 0 | 1.57 | 1.96 | 3.55 | 3.9 | no |
| 8 | 1 | 4199 | n/a | 0 | 2.41 | 3.41 | 5.98 | 7.8 | no |
| 16 | 1 | 5300 | n/a | 0 | 4.96 | 32.37 | 7.56 | 15.8 | no |
| 32 | 1 | 5883 | n/a | 0 | 10.00 | 42.99 | 7.86 | 31.7 | no |
| 64 | 3 | 5917 | 5892 to 5918 | 0 | 15.92 | 50.18 | 7.88 | 63.6 | no |
| 128 | 1 | 5873 | n/a | 0 | 26.87 | 74.10 | 7.86 | 127.2 | no |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 444 | n/a | 0 | 2.75 | 3.61 | 0.95 | 1.0 | no |
| 2 | 1 | 865 | n/a | 0 | 2.91 | 3.65 | 1.84 | 2.0 | no |
| 4 | 1 | 1594 | n/a | 0 | 3.08 | 4.34 | 3.70 | 3.9 | no |
| 8 | 1 | 2391 | n/a | 0 | 4.54 | 16.86 | 6.23 | 7.9 | no |
| 16 | 1 | 2894 | n/a | 0 | 9.19 | 22.61 | 7.63 | 15.8 | no |
| 32 | 3 | 3010 | 3009 to 3046 | 0 | 16.81 | 32.94 | 7.92 | 31.8 | no |
| 64 | 1 | 2973 | n/a | 0 | 28.97 | 53.75 | 7.94 | 63.6 | no |
| 128 | 1 | 2981 | n/a | 0 | 51.45 | 84.06 | 7.93 | 126.9 | no |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 218 | n/a | 0 | 6.30 | 7.50 | 0.96 | 1.0 | no |
| 2 | 1 | 417 | n/a | 0 | 6.78 | 8.95 | 1.93 | 2.0 | no |
| 4 | 1 | 822 | n/a | 0 | 6.73 | 8.57 | 3.83 | 4.0 | no |
| 8 | 1 | 1192 | n/a | 0 | 9.86 | 29.78 | 6.51 | 7.9 | no |
| 16 | 1 | 1393 | n/a | 0 | 18.46 | 25.86 | 7.88 | 15.9 | no |
| 32 | 3 | 1479 | 1476 to 1491 | 0 | 32.25 | 45.31 | 7.95 | 31.8 | no |
| 64 | 1 | 1457 | n/a | 0 | 58.68 | 80.00 | 7.94 | 63.4 | no |
| 128 | 1 | 1345 | n/a | 0 | 111.87 | 147.87 | 7.94 | 125.9 | no |

## Hybrid track

- Setup: BM25 match fused with BBQ dense_vector kNN (full-precision rescore) via the RRF retriever; the RRF retriever is not part of Elastic's free licence, so this run uses Elasticsearch's self-generated trial licence
- Fusion: RRF retriever (rank_constant=60)

Retrieval quality vs human judgements:

| Dataset | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| beir/scifact/test | 0.7059 | 0.9610 | 0.6592 | 0.6660 |
| beir/nfcorpus/test | 0.3525 | 0.3215 | 0.1868 | 0.5666 |
| dbpedia-entities-openai-100k | n/a | n/a | n/a | n/a |
| dbpedia-entities-openai-1m | n/a | n/a | n/a | n/a |

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | On disk | Peak heap | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 1537 | 3.37 | 0.02 GB | 11.93 GB | 1.00 | 1.00 | 1.00 |
| beir/nfcorpus/test | 3633 | 1384 | 2.63 | 0.01 GB | 11.94 GB | 1.00 | 1.00 | 1.00 |
| dbpedia-entities-openai-100k | 100000 | 511 | 195.71 | 0.67 GB | 11.94 GB | 2.00 | 2.00 | 2.00 |
| dbpedia-entities-openai-1m | 995000 | 543 | 1832.02 | 6.73 GB | 11.94 GB | 4.00 | 7.00 | 8.00 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 1.83 | 2.19 | 2.33 |
| beir/nfcorpus/test | 1.72 | 1.89 | 1.99 |
| dbpedia-entities-openai-100k | 2.80 | 3.37 | 3.61 |
| dbpedia-entities-openai-1m | 5.73 | 8.16 | 9.24 |

Engine container memory through the whole track, load included (anonymous memory is the heap the kernel cannot reclaim; charged memory adds the page cache of the engine's files):

| Dataset | Peak anonymous | Peak charged | Samples |
| --- | --- | --- | --- |
| beir/scifact/test | 11.93 GB | 12.06 GB | 516 |
| beir/nfcorpus/test | 11.94 GB | 12.03 GB | 513 |
| dbpedia-entities-openai-100k | 11.94 GB | 14.28 GB | 1493 |
| dbpedia-entities-openai-1m | 11.94 GB | 21.47 GB | 6303 |

Server-side time source per dataset:

- beir/scifact/test: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- beir/nfcorpus/test: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- dbpedia-entities-openai-100k: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- dbpedia-entities-openai-1m: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 561 | n/a | 0 | 2.08 | 2.37 | 1.07 | 1.0 | no |
| 2 | 1 | 1051 | n/a | 0 | 2.24 | 2.78 | 2.17 | 2.0 | no |
| 4 | 1 | 1883 | n/a | 0 | 2.52 | 13.90 | 4.29 | 3.9 | no |
| 8 | 1 | 2623 | n/a | 0 | 4.05 | 21.43 | 6.30 | 7.9 | no |
| 16 | 1 | 3260 | n/a | 0 | 7.47 | 20.08 | 7.62 | 15.8 | no |
| 32 | 1 | 3510 | n/a | 0 | 14.61 | 33.45 | 7.80 | 31.8 | no |
| 64 | 1 | 3572 | n/a | 0 | 24.71 | 49.00 | 7.87 | 63.7 | no |
| 128 | 3 | 3610 | 3586 to 3619 | 0 | 43.55 | 76.11 | 7.92 | 126.9 | no |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 605 | n/a | 0 | 1.78 | 1.96 | 1.02 | 1.0 | no |
| 2 | 1 | 1103 | n/a | 0 | 1.96 | 2.61 | 2.03 | 2.0 | no |
| 4 | 1 | 1987 | n/a | 0 | 2.23 | 2.85 | 3.98 | 3.9 | no |
| 8 | 1 | 2889 | n/a | 0 | 3.55 | 12.69 | 6.17 | 7.9 | no |
| 16 | 1 | 3574 | n/a | 0 | 6.63 | 36.07 | 7.54 | 15.8 | no |
| 32 | 1 | 3963 | n/a | 0 | 13.06 | 47.83 | 7.78 | 31.8 | no |
| 64 | 3 | 4056 | 4051 to 4057 | 0 | 22.28 | 61.01 | 7.82 | 63.6 | no |
| 128 | 1 | 4023 | n/a | 0 | 39.76 | 72.99 | 7.91 | 127.1 | no |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 360 | n/a | 0 | 3.31 | 3.90 | 1.03 | 1.0 | no |
| 2 | 1 | 696 | n/a | 0 | 3.46 | 4.04 | 2.02 | 2.0 | no |
| 4 | 1 | 1270 | n/a | 0 | 3.81 | 16.86 | 3.95 | 4.0 | no |
| 8 | 1 | 1848 | n/a | 0 | 5.83 | 19.28 | 6.26 | 7.9 | no |
| 16 | 1 | 2272 | n/a | 0 | 10.93 | 31.97 | 7.60 | 15.9 | no |
| 32 | 1 | 2320 | n/a | 0 | 20.49 | 43.63 | 7.88 | 31.8 | no |
| 64 | 3 | 2367 | 2353 to 2377 | 0 | 35.90 | 57.75 | 7.92 | 63.6 | no |
| 128 | 1 | 2364 | n/a | 0 | 65.06 | 99.81 | 7.90 | 126.8 | no |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 189 | n/a | 0 | 7.04 | 8.85 | 1.03 | 1.0 | no |
| 2 | 1 | 353 | n/a | 0 | 7.73 | 9.83 | 2.06 | 2.0 | no |
| 4 | 1 | 680 | n/a | 0 | 8.03 | 21.39 | 4.11 | 4.0 | no |
| 8 | 1 | 971 | n/a | 0 | 11.41 | 21.06 | 6.58 | 7.9 | no |
| 16 | 1 | 1140 | n/a | 0 | 21.67 | 30.82 | 7.85 | 15.9 | no |
| 32 | 3 | 1208 | 1200 to 1214 | 0 | 37.02 | 53.56 | 7.94 | 31.8 | no |
| 64 | 1 | 1138 | n/a | 0 | 73.60 | 92.32 | 7.95 | 63.3 | no |
| 128 | 1 | 1122 | n/a | 0 | 134.95 | 176.05 | 7.95 | 125.6 | no |
