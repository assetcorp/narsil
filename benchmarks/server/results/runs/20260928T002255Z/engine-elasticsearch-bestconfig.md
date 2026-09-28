# elasticsearch retrieval (keyword, vector, hybrid, best-config vector profile)

## Environment

- Captured: 2026-09-28T13:41:16.123712+00:00
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

## Vector track

- Embedding model: sentence-transformers/all-MiniLM-L6-v2 (384 dim, cosine)
- Index setup: dense_vector BBQ (bbq_hnsw, binary quantization) with full-precision rescore (oversample tuned to the recall target), similarity cosine
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
| beir/scifact/test | num_candidates | 16 | 0.9913 | yes | 16 | 0.9913 |
| beir/nfcorpus/test | num_candidates | 8192 | 0.9848 | NO | 16 | 0.9743 |
| dbpedia-entities-openai-100k | num_candidates | 2048 | 0.9925 | yes | 64 | 0.9663 |
| dbpedia-entities-openai-1m | num_candidates | 2048 | 0.9917 | yes | 128 | 0.9574 |

Latency is measured at the operating point.

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | Index size | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 1536 | 3.37 | 15.5 MB | 0.00 | 0.00 | 0.00 |
| beir/nfcorpus/test | 3633 | 1253 | 2.90 | 11.1 MB | 0.00 | 0.00 | 0.00 |
| dbpedia-entities-openai-100k | 100000 | 493 | 202.85 | 671.9 MB | 1.00 | 2.00 | 2.00 |
| dbpedia-entities-openai-1m | 995000 | 527 | 1887.17 | 6728.8 MB | 4.00 | 8.00 | 12.00 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 1.93 | 2.10 | 2.23 |
| beir/nfcorpus/test | 2.06 | 2.24 | 2.39 |
| dbpedia-entities-openai-100k | 4.14 | 4.81 | 5.13 |
| dbpedia-entities-openai-1m | 6.37 | 10.68 | 14.76 |

Server-side time source per dataset:

- beir/scifact/test: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- beir/nfcorpus/test: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- dbpedia-entities-openai-100k: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- dbpedia-entities-openai-1m: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 525 | n/a | 0 | 2.04 | 2.60 | 0.50 | 1.0 | no |
| 2 | 1 | 937 | n/a | 0 | 2.39 | 16.50 | 1.05 | 2.0 | no |
| 4 | 1 | 1655 | n/a | 0 | 2.70 | 3.72 | 1.94 | 4.0 | no |
| 8 | 1 | 2058 | n/a | 0 | 5.64 | 29.53 | 2.69 | 8.0 | no |
| 16 | 3 | 2177 | 2171 to 2210 | 0 | 11.67 | 38.49 | 2.85 | 16.0 | no |
| 32 | 1 | 2038 | n/a | 0 | 25.13 | 57.88 | 2.70 | 31.9 | no |
| 64 | 1 | 1981 | n/a | 0 | 57.88 | 108.04 | 2.60 | 63.4 | yes |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 474 | n/a | 0 | 2.27 | 3.03 | 0.55 | 1.0 | no |
| 2 | 1 | 862 | n/a | 0 | 2.62 | 10.33 | 1.11 | 2.0 | no |
| 4 | 1 | 1529 | n/a | 0 | 2.91 | 3.33 | 2.10 | 4.0 | no |
| 8 | 1 | 1964 | n/a | 0 | 5.98 | 7.90 | 2.97 | 8.0 | no |
| 16 | 3 | 2090 | 2083 to 2094 | 0 | 12.25 | 37.74 | 3.23 | 16.0 | no |
| 32 | 1 | 1983 | n/a | 0 | 25.82 | 52.03 | 3.07 | 31.9 | no |
| 64 | 1 | 1847 | n/a | 0 | 62.80 | 123.13 | 2.89 | 63.3 | no |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 247 | n/a | 0 | 4.69 | 5.12 | 0.57 | 1.0 | no |
| 2 | 1 | 468 | n/a | 0 | 5.17 | 6.41 | 1.11 | 2.0 | no |
| 4 | 1 | 824 | n/a | 0 | 5.79 | 17.00 | 2.10 | 4.0 | no |
| 8 | 1 | 1053 | n/a | 0 | 11.31 | 14.08 | 3.10 | 8.0 | no |
| 16 | 3 | 1139 | 1137 to 1141 | 0 | 22.85 | 34.74 | 3.37 | 15.9 | no |
| 32 | 1 | 1123 | n/a | 0 | 45.11 | 69.34 | 3.37 | 31.7 | no |
| 64 | 1 | 1057 | n/a | 0 | 103.69 | 181.09 | 3.25 | 62.9 | no |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 210 | n/a | 0 | 5.82 | 17.21 | 0.66 | 1.0 | no |
| 2 | 1 | 405 | n/a | 0 | 6.13 | 7.67 | 1.24 | 2.0 | no |
| 4 | 1 | 740 | n/a | 0 | 6.71 | 8.42 | 2.26 | 4.0 | no |
| 8 | 1 | 968 | n/a | 0 | 12.13 | 29.03 | 3.39 | 8.0 | no |
| 16 | 3 | 1075 | 1073 to 1079 | 0 | 24.27 | 37.80 | 3.71 | 15.9 | no |
| 32 | 1 | 1063 | n/a | 0 | 49.17 | 76.47 | 3.99 | 31.7 | no |
| 64 | 1 | 1016 | n/a | 0 | 104.87 | 179.04 | 3.87 | 62.8 | no |

## Hybrid track

- Setup: BM25 match fused with BBQ dense_vector kNN (full-precision rescore) via the RRF retriever; the RRF retriever is not part of Elastic's free licence, so this run uses Elasticsearch's self-generated trial licence
- Fusion: RRF retriever (rank_constant=60)

Retrieval quality vs human judgements:

| Dataset | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| beir/scifact/test | 0.7053 | 0.9610 | 0.6587 | 0.6643 |
| beir/nfcorpus/test | 0.3519 | 0.3215 | 0.1867 | 0.5634 |
| dbpedia-entities-openai-100k | n/a | n/a | n/a | n/a |
| dbpedia-entities-openai-1m | n/a | n/a | n/a | n/a |

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | Index size | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 1497 | 3.46 | 15.5 MB | 1.00 | 1.00 | 1.00 |
| beir/nfcorpus/test | 3633 | 1199 | 3.03 | 11.1 MB | 1.00 | 1.00 | 1.00 |
| dbpedia-entities-openai-100k | 100000 | 576 | 173.48 | 671.7 MB | 2.00 | 2.00 | 3.00 |
| dbpedia-entities-openai-1m | 995000 | 535 | 1860.27 | 6728.8 MB | 3.00 | 5.00 | 7.00 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 2.69 | 3.07 | 3.30 |
| beir/nfcorpus/test | 2.61 | 2.83 | 2.96 |
| dbpedia-entities-openai-100k | 4.52 | 5.13 | 5.44 |
| dbpedia-entities-openai-1m | 6.39 | 8.76 | 10.48 |

Server-side time source per dataset:

- beir/scifact/test: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- beir/nfcorpus/test: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- dbpedia-entities-openai-100k: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- dbpedia-entities-openai-1m: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 366 | n/a | 0 | 3.08 | 5.22 | 0.75 | 1.0 | no |
| 2 | 1 | 690 | n/a | 0 | 3.32 | 5.54 | 1.49 | 2.0 | no |
| 4 | 1 | 1199 | n/a | 0 | 3.87 | 4.70 | 2.82 | 4.0 | no |
| 8 | 1 | 1534 | n/a | 0 | 7.34 | 31.86 | 3.85 | 8.0 | no |
| 16 | 1 | 1722 | n/a | 0 | 14.50 | 35.68 | 4.32 | 16.0 | no |
| 32 | 3 | 1734 | 1729 to 1740 | 0 | 30.62 | 55.50 | 4.28 | 31.8 | no |
| 64 | 1 | 1648 | n/a | 0 | 66.81 | 105.77 | 4.08 | 63.2 | no |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 381 | n/a | 0 | 2.81 | 3.61 | 0.69 | 1.0 | no |
| 2 | 1 | 712 | n/a | 0 | 3.18 | 3.59 | 1.37 | 2.0 | no |
| 4 | 1 | 1270 | n/a | 0 | 3.49 | 4.15 | 2.64 | 4.0 | no |
| 8 | 1 | 1623 | n/a | 0 | 6.94 | 29.00 | 3.62 | 8.0 | no |
| 16 | 1 | 1808 | n/a | 0 | 13.85 | 37.79 | 4.01 | 16.0 | no |
| 32 | 3 | 1818 | 1817 to 1825 | 0 | 28.82 | 57.61 | 3.98 | 31.8 | no |
| 64 | 1 | 1723 | n/a | 0 | 64.24 | 108.81 | 3.71 | 63.3 | no |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 219 | n/a | 0 | 5.16 | 5.89 | 0.64 | 1.0 | no |
| 2 | 1 | 420 | n/a | 0 | 5.51 | 17.71 | 1.31 | 2.0 | no |
| 4 | 1 | 738 | n/a | 0 | 6.35 | 7.68 | 2.45 | 4.0 | no |
| 8 | 1 | 939 | n/a | 0 | 12.21 | 39.21 | 3.47 | 8.0 | no |
| 16 | 3 | 1024 | 1023 to 1027 | 0 | 24.45 | 34.74 | 3.91 | 15.9 | no |
| 32 | 1 | 1017 | n/a | 0 | 50.57 | 77.04 | 3.84 | 31.7 | no |
| 64 | 1 | 983 | n/a | 0 | 107.21 | 177.75 | 3.84 | 62.8 | no |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 171 | n/a | 0 | 6.96 | 7.85 | 0.75 | 1.0 | no |
| 2 | 1 | 320 | n/a | 0 | 7.66 | 9.21 | 1.46 | 2.0 | no |
| 4 | 1 | 607 | n/a | 0 | 7.99 | 25.26 | 2.72 | 4.0 | no |
| 8 | 1 | 794 | n/a | 0 | 14.14 | 28.91 | 3.89 | 8.0 | no |
| 16 | 1 | 867 | n/a | 0 | 28.72 | 48.97 | 4.34 | 15.9 | no |
| 32 | 3 | 873 | 872 to 884 | 0 | 59.02 | 86.78 | 4.47 | 31.7 | no |
| 64 | 1 | 863 | n/a | 0 | 122.13 | 174.90 | 4.41 | 62.6 | no |
