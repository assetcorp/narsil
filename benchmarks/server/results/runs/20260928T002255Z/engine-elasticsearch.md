# elasticsearch retrieval (keyword, vector, hybrid)

## Environment

- Captured: 2026-09-28T12:04:01.327597+00:00
- Machine: GCP c3-standard-8, us-central1-a
- OS / arch: Linux 7.0.0-1011-gcp / x86_64 (containerized: True)
- CPU: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical)
- Memory: 33.6 GB
- Memory cap per engine: 21.5 GB
- Tracks: keyword, vector, hybrid
- Keyword setup: BM25 k1=0.9 b=0.4 (custom default similarity); Elasticsearch `english` analyzer
- Run depth: 1000; run tag: elasticsearch_bm25
- Engine build: version 9.5.4, commit 9170df19cae1
- Engine image: docker.elastic.co/elasticsearch/elasticsearch@sha256:82ac14f43fe701992e601f4cc81e1c0d7dbc5a2576d8cd736006452925df4026
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
| beir/scifact/test | 5183 | 4042 | 1.28 | 7.3 MB | 1.00 | 1.00 | 2.00 |
| beir/nfcorpus/test | 3633 | 7646 | 0.48 | 5.2 MB | 0.00 | 0.00 | 0.00 |
| dbpedia-entities-openai-100k | 100000 | 38836 | 2.57 | 32.9 MB | 0.00 | 0.00 | 0.00 |
| dbpedia-entities-openai-1m | 995000 | 42304 | 23.52 | 357.6 MB | 0.00 | 1.00 | 1.00 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 2.63 | 3.36 | 3.82 |
| beir/nfcorpus/test | 1.23 | 1.45 | 1.57 |
| dbpedia-entities-openai-100k | 1.25 | 1.58 | 1.76 |
| dbpedia-entities-openai-1m | 1.44 | 1.93 | 2.23 |

Server-side time source per dataset:

- beir/scifact/test: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- beir/nfcorpus/test: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- dbpedia-entities-openai-100k: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- dbpedia-entities-openai-1m: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 495 | n/a | 0 | 2.38 | 3.02 | 1.32 | 1.0 | no |
| 2 | 1 | 1001 | n/a | 0 | 2.39 | 4.21 | 1.95 | 2.0 | no |
| 4 | 1 | 1880 | n/a | 0 | 2.59 | 7.38 | 2.87 | 4.0 | no |
| 8 | 1 | 2577 | n/a | 0 | 4.45 | 52.64 | 3.47 | 8.0 | no |
| 16 | 3 | 2796 | 2750 to 2798 | 0 | 9.54 | 34.22 | 3.62 | 16.0 | no |
| 32 | 1 | 2620 | n/a | 0 | 20.21 | 54.30 | 3.47 | 31.9 | no |
| 64 | 1 | 2364 | n/a | 0 | 50.05 | 88.84 | 3.19 | 63.5 | no |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 856 | n/a | 0 | 1.39 | 1.64 | 0.54 | 1.0 | no |
| 2 | 1 | 1487 | n/a | 0 | 1.59 | 1.96 | 0.99 | 2.0 | no |
| 4 | 1 | 2536 | n/a | 0 | 1.85 | 2.40 | 1.96 | 4.0 | no |
| 8 | 3 | 3128 | 3128 to 3137 | 0 | 3.78 | 10.40 | 2.60 | 8.0 | no |
| 16 | 1 | 3133 | n/a | 0 | 8.31 | 26.83 | 2.61 | 16.0 | no |
| 32 | 1 | 2856 | n/a | 0 | 18.50 | 39.24 | 2.37 | 31.9 | yes |
| 64 | 1 | 2826 | n/a | 0 | 41.06 | 80.04 | 2.27 | 63.5 | yes |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 794 | n/a | 0 | 1.55 | 1.96 | 0.52 | 1.0 | no |
| 2 | 1 | 1401 | n/a | 0 | 1.73 | 2.18 | 1.03 | 2.0 | no |
| 4 | 1 | 2448 | n/a | 0 | 1.98 | 2.43 | 1.99 | 4.0 | no |
| 8 | 3 | 3100 | 3075 to 3118 | 0 | 3.85 | 9.69 | 2.67 | 8.0 | no |
| 16 | 1 | 3100 | n/a | 0 | 8.42 | 26.33 | 2.69 | 16.0 | no |
| 32 | 1 | 2813 | n/a | 0 | 18.84 | 38.76 | 2.48 | 31.9 | yes |
| 64 | 1 | 2609 | n/a | 0 | 45.09 | 82.55 | 2.34 | 63.5 | yes |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 669 | n/a | 0 | 1.93 | 3.48 | 0.79 | 1.0 | no |
| 2 | 1 | 1203 | n/a | 0 | 2.16 | 3.20 | 1.42 | 2.0 | no |
| 4 | 1 | 2084 | n/a | 0 | 2.48 | 3.89 | 2.76 | 4.0 | no |
| 8 | 1 | 2598 | n/a | 0 | 4.65 | 14.93 | 3.55 | 8.0 | no |
| 16 | 3 | 2782 | 2773 to 2785 | 0 | 9.54 | 27.52 | 3.78 | 16.0 | no |
| 32 | 1 | 2703 | n/a | 0 | 19.65 | 38.38 | 3.66 | 31.9 | no |
| 64 | 1 | 2438 | n/a | 0 | 49.03 | 85.78 | 3.31 | 63.5 | no |

## Vector track

- Embedding model: sentence-transformers/all-MiniLM-L6-v2 (384 dim, cosine)
- Index setup: dense_vector HNSW, similarity cosine, over the shared precomputed vectors
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
| beir/scifact/test | num_candidates | 64 | 0.9940 | yes | 32 | 0.9813 |
| beir/nfcorpus/test | num_candidates | 192 | 0.9904 | yes | 64 | 0.9678 |
| dbpedia-entities-openai-100k | num_candidates | 768 | 0.9922 | yes | 64 | 0.9690 |
| dbpedia-entities-openai-1m | num_candidates | 2048 | 0.9921 | yes | 128 | 0.9587 |

Latency is measured at the operating point.

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | Index size | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 1111 | 4.66 | 15.1 MB | 0.00 | 1.00 | 1.00 |
| beir/nfcorpus/test | 3633 | 1260 | 2.88 | 10.8 MB | 0.00 | 0.00 | 0.00 |
| dbpedia-entities-openai-100k | 100000 | 546 | 183.27 | 650.9 MB | 2.00 | 3.00 | 4.00 |
| dbpedia-entities-openai-1m | 995000 | 471 | 2110.50 | 6521.9 MB | 6.00 | 10.00 | 12.00 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 1.83 | 2.75 | 2.94 |
| beir/nfcorpus/test | 1.92 | 2.08 | 2.23 |
| dbpedia-entities-openai-100k | 4.91 | 6.27 | 6.90 |
| dbpedia-entities-openai-1m | 8.86 | 13.17 | 15.07 |

Server-side time source per dataset:

- beir/scifact/test: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- beir/nfcorpus/test: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- dbpedia-entities-openai-100k: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- dbpedia-entities-openai-1m: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 533 | n/a | 0 | 2.00 | 2.29 | 0.49 | 1.0 | no |
| 2 | 1 | 980 | n/a | 0 | 2.37 | 2.77 | 0.98 | 2.0 | no |
| 4 | 1 | 1716 | n/a | 0 | 2.61 | 3.05 | 1.87 | 4.0 | no |
| 8 | 1 | 2109 | n/a | 0 | 5.52 | 28.85 | 2.55 | 8.0 | no |
| 16 | 3 | 2235 | 2208 to 2236 | 0 | 11.44 | 33.78 | 2.64 | 16.0 | no |
| 32 | 1 | 2078 | n/a | 0 | 24.62 | 44.95 | 2.49 | 31.8 | yes |
| 64 | 1 | 1996 | n/a | 0 | 57.10 | 105.00 | 2.41 | 63.4 | yes |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 501 | n/a | 0 | 2.16 | 2.41 | 0.52 | 1.0 | no |
| 2 | 1 | 928 | n/a | 0 | 2.45 | 2.84 | 1.05 | 2.0 | no |
| 4 | 1 | 1626 | n/a | 0 | 2.74 | 3.21 | 1.98 | 4.0 | no |
| 8 | 1 | 2056 | n/a | 0 | 5.76 | 7.19 | 2.73 | 8.0 | no |
| 16 | 3 | 2168 | 2152 to 2176 | 0 | 11.76 | 35.03 | 2.91 | 16.0 | no |
| 32 | 1 | 2023 | n/a | 0 | 25.38 | 59.93 | 2.78 | 31.8 | no |
| 64 | 1 | 1976 | n/a | 0 | 57.45 | 101.96 | 2.71 | 63.4 | no |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 209 | n/a | 0 | 5.93 | 6.81 | 0.63 | 1.0 | no |
| 2 | 1 | 414 | n/a | 0 | 6.12 | 7.86 | 1.21 | 2.0 | no |
| 4 | 1 | 725 | n/a | 0 | 6.93 | 8.50 | 2.24 | 4.0 | no |
| 8 | 1 | 917 | n/a | 0 | 12.80 | 15.66 | 3.49 | 8.0 | no |
| 16 | 3 | 986 | 980 to 996 | 0 | 25.94 | 57.26 | 4.00 | 15.9 | no |
| 32 | 1 | 978 | n/a | 0 | 53.84 | 104.59 | 4.07 | 31.7 | no |
| 64 | 1 | 953 | n/a | 0 | 111.06 | 166.52 | 4.04 | 62.7 | no |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 115 | n/a | 0 | 12.76 | 16.43 | 0.78 | 1.0 | no |
| 2 | 1 | 225 | n/a | 0 | 12.86 | 16.60 | 1.51 | 2.0 | no |
| 4 | 1 | 398 | n/a | 0 | 15.24 | 22.26 | 2.95 | 4.0 | no |
| 8 | 1 | 578 | n/a | 0 | 20.95 | 31.17 | 4.78 | 8.0 | no |
| 16 | 3 | 609 | 609 to 614 | 0 | 42.57 | 64.09 | 5.67 | 15.9 | no |
| 32 | 1 | 595 | n/a | 0 | 82.00 | 121.08 | 5.73 | 31.6 | no |
| 64 | 1 | 591 | n/a | 0 | 168.70 | 207.17 | 5.58 | 61.9 | no |

## Hybrid track

- Setup: BM25 match fused with dense_vector kNN via the RRF retriever; the RRF retriever is not part of Elastic's free licence, so this run uses Elasticsearch's self-generated trial licence
- Fusion: RRF retriever (rank_constant=60)

Retrieval quality vs human judgements:

| Dataset | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| beir/scifact/test | 0.7053 | 0.9610 | 0.6587 | 0.6643 |
| beir/nfcorpus/test | 0.3521 | 0.3215 | 0.1867 | 0.5649 |
| dbpedia-entities-openai-100k | n/a | n/a | n/a | n/a |
| dbpedia-entities-openai-1m | n/a | n/a | n/a | n/a |

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | Index size | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 1424 | 3.64 | 15.1 MB | 1.00 | 1.00 | 2.00 |
| beir/nfcorpus/test | 3633 | 1253 | 2.90 | 10.8 MB | 1.00 | 1.00 | 1.00 |
| dbpedia-entities-openai-100k | 100000 | 571 | 175.15 | 651.0 MB | 2.00 | 4.00 | 4.00 |
| dbpedia-entities-openai-1m | 995000 | 406 | 2453.13 | 6522.4 MB | 7.00 | 11.00 | 13.00 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 3.03 | 3.61 | 3.90 |
| beir/nfcorpus/test | 2.45 | 2.68 | 2.91 |
| dbpedia-entities-openai-100k | 5.26 | 6.58 | 7.18 |
| dbpedia-entities-openai-1m | 9.51 | 14.02 | 16.10 |

Server-side time source per dataset:

- beir/scifact/test: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- beir/nfcorpus/test: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- dbpedia-entities-openai-100k: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- dbpedia-entities-openai-1m: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 361 | n/a | 0 | 3.16 | 3.68 | 0.87 | 1.0 | no |
| 2 | 1 | 691 | n/a | 0 | 3.35 | 4.17 | 1.66 | 2.0 | no |
| 4 | 1 | 1237 | n/a | 0 | 3.76 | 4.79 | 2.84 | 4.0 | no |
| 8 | 1 | 1565 | n/a | 0 | 7.19 | 31.47 | 3.81 | 8.0 | no |
| 16 | 1 | 1738 | n/a | 0 | 14.42 | 44.32 | 4.23 | 16.0 | no |
| 32 | 3 | 1753 | 1749 to 1754 | 0 | 30.20 | 56.21 | 4.23 | 31.8 | no |
| 64 | 1 | 1670 | n/a | 0 | 66.13 | 99.16 | 4.04 | 63.3 | no |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 405 | n/a | 0 | 2.65 | 2.99 | 0.69 | 1.0 | no |
| 2 | 1 | 749 | n/a | 0 | 3.02 | 13.22 | 1.38 | 2.0 | no |
| 4 | 1 | 1337 | n/a | 0 | 3.32 | 3.87 | 2.62 | 4.0 | no |
| 8 | 1 | 1698 | n/a | 0 | 6.75 | 9.53 | 3.50 | 8.0 | no |
| 16 | 3 | 1859 | 1858 to 1873 | 0 | 13.39 | 43.66 | 3.85 | 16.0 | no |
| 32 | 1 | 1863 | n/a | 0 | 27.81 | 54.21 | 3.79 | 31.8 | no |
| 64 | 1 | 1751 | n/a | 0 | 63.18 | 106.56 | 3.55 | 63.3 | no |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 194 | n/a | 0 | 6.28 | 7.33 | 0.71 | 1.0 | no |
| 2 | 1 | 369 | n/a | 0 | 6.63 | 35.61 | 1.48 | 2.0 | no |
| 4 | 1 | 646 | n/a | 0 | 7.65 | 9.52 | 2.59 | 4.0 | no |
| 8 | 1 | 824 | n/a | 0 | 13.63 | 41.27 | 3.70 | 8.0 | no |
| 16 | 3 | 907 | 901 to 912 | 0 | 27.55 | 42.23 | 4.21 | 15.9 | no |
| 32 | 1 | 903 | n/a | 0 | 58.75 | 99.94 | 4.36 | 31.7 | no |
| 64 | 1 | 887 | n/a | 0 | 120.00 | 177.40 | 4.24 | 62.7 | no |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 110 | n/a | 0 | 12.79 | 18.37 | 0.84 | 1.0 | no |
| 2 | 1 | 215 | n/a | 0 | 13.52 | 18.18 | 1.61 | 2.0 | no |
| 4 | 1 | 392 | n/a | 0 | 14.24 | 19.80 | 3.09 | 4.0 | no |
| 8 | 1 | 517 | n/a | 0 | 22.58 | 34.18 | 4.91 | 8.0 | no |
| 16 | 1 | 566 | n/a | 0 | 44.08 | 69.31 | 5.72 | 15.8 | no |
| 32 | 1 | 563 | n/a | 0 | 84.64 | 136.62 | 5.70 | 31.5 | no |
| 64 | 3 | 570 | 566 to 572 | 0 | 168.27 | 222.74 | 5.79 | 62.0 | no |
