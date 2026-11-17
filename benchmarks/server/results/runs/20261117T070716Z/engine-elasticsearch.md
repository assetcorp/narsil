# elasticsearch retrieval (keyword, vector, hybrid)

## Environment

- Captured: 2026-11-17T07:52:52.402848+00:00
- Load machine: GCP c3-standard-8, us-east4-a
- OS / arch: Linux 7.0.0-1017-gcp / x86_64 (containerized: True)
- CPU: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical)
- Memory: 33.6 GB
- Engine machine label: GCP c3-standard-8, us-east4-a
- Engine machine: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical), 33.6 GB
- Network round trip to the engine machine: p50 0.081 ms, p99 0.357 ms over 200 TCP connects
- Memory cap per engine: 21.5 GB
- Tracks: keyword, vector, hybrid
- Keyword setup: BM25 k1=0.9 b=0.4 (custom default similarity); Elasticsearch `english` analyzer
- Run depth: 1000; run tag: elasticsearch_bm25
- Engine build: version 9.5.6, commit fd1e8011342a
- Engine image: docker.elastic.co/elasticsearch/elasticsearch@sha256:79b4f1de4c15e6eca824723086a51e5934406d614d410cc11be77748cafac537
- Dataset beir/scifact/test: content md5 5f7d1de60b170fc8027bb7898e2efca1
- Dataset beir/nfcorpus/test: content md5 a89dba18a62ef92f7d323ec890a0d38d

## Keyword track

Retrieval quality vs Anserini BM25 reference:

| Dataset | nDCG@10 | Reference | Delta | Status | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 0.6789 | 0.6790 | -0.0001 | within margin | 0.9253 | 0.6401 | 0.6506 |
| beir/nfcorpus/test | 0.3218 | 0.3220 | -0.0002 | within margin | 0.2457 | 0.1504 | 0.5281 |
| dbpedia-entities-openai-100k | n/a | n/a | n/a | no baseline | n/a | n/a | n/a |
| dbpedia-entities-openai-1m | n/a | n/a | n/a | no baseline | n/a | n/a | n/a |

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | On disk | Peak heap | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 4008 | 1.29 | 0.01 GB | 11.62 GB | 1.00 | 1.00 | 2.00 |
| beir/nfcorpus/test | 3633 | 7450 | 0.49 | 0.01 GB | 11.88 GB | 0.00 | 0.00 | 0.00 |
| dbpedia-entities-openai-100k | 100000 | 44187 | 2.26 | 0.03 GB | 11.91 GB | 0.00 | 0.00 | 0.00 |
| dbpedia-entities-openai-1m | 995000 | 46325 | 21.48 | 0.36 GB | 11.93 GB | 0.00 | 0.00 | 1.00 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 2.60 | 3.28 | 3.60 |
| beir/nfcorpus/test | 1.23 | 1.43 | 1.57 |
| dbpedia-entities-openai-100k | 1.20 | 1.48 | 1.60 |
| dbpedia-entities-openai-1m | 1.38 | 1.81 | 2.07 |

Engine container memory through the whole track, load included (anonymous memory is the heap the kernel cannot reclaim; charged memory adds the page cache of the engine's files):

| Dataset | Peak anonymous | Peak charged | Samples |
| --- | --- | --- | --- |
| beir/scifact/test | 11.62 GB | 11.67 GB | 312 |
| beir/nfcorpus/test | 11.88 GB | 11.92 GB | 280 |
| dbpedia-entities-openai-100k | 11.91 GB | 12.04 GB | 367 |
| dbpedia-entities-openai-1m | 11.93 GB | 12.96 GB | 478 |

Server-side time source per dataset:

- beir/scifact/test: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- beir/nfcorpus/test: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- dbpedia-entities-openai-100k: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- dbpedia-entities-openai-1m: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 511 | n/a | 0 | 2.28 | 5.18 | 1.37 | 1.0 | no |
| 2 | 1 | 1081 | n/a | 0 | 2.17 | 9.30 | 2.08 | 2.0 | no |
| 4 | 1 | 2273 | n/a | 0 | 2.05 | 21.04 | 2.81 | 4.0 | no |
| 8 | 1 | 3032 | n/a | 0 | 3.61 | 49.11 | 3.62 | 8.0 | no |
| 16 | 3 | 3597 | 3520 to 3609 | 0 | 6.71 | 35.25 | 4.06 | 16.0 | yes |
| 32 | 1 | 3332 | n/a | 0 | 14.95 | 46.03 | 3.83 | 31.9 | yes |
| 64 | 1 | 2871 | n/a | 0 | 39.03 | 69.73 | 3.19 | 63.5 | yes |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 898 | n/a | 0 | 1.33 | 1.64 | 0.53 | 1.0 | no |
| 2 | 1 | 1645 | n/a | 0 | 1.44 | 1.78 | 0.97 | 2.0 | no |
| 4 | 1 | 3060 | n/a | 0 | 1.52 | 3.34 | 2.02 | 4.0 | no |
| 8 | 1 | 3517 | n/a | 0 | 3.29 | 4.77 | 2.53 | 8.0 | no |
| 16 | 3 | 3656 | 3641 to 3690 | 0 | 6.77 | 25.05 | 2.62 | 16.0 | yes |
| 32 | 1 | 3275 | n/a | 0 | 15.60 | 38.09 | 2.21 | 31.9 | yes |
| 64 | 1 | 2936 | n/a | 0 | 38.32 | 74.12 | 1.92 | 63.6 | yes |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 821 | n/a | 0 | 1.46 | 1.76 | 0.51 | 1.0 | no |
| 2 | 1 | 1558 | n/a | 0 | 1.54 | 1.83 | 1.03 | 2.0 | no |
| 4 | 1 | 2842 | n/a | 0 | 1.71 | 3.73 | 2.10 | 4.0 | no |
| 8 | 1 | 3532 | n/a | 0 | 3.30 | 4.09 | 2.68 | 8.0 | no |
| 16 | 3 | 3665 | 3650 to 3665 | 0 | 6.80 | 25.50 | 2.77 | 16.0 | yes |
| 32 | 1 | 3283 | n/a | 0 | 15.40 | 33.67 | 2.47 | 31.9 | yes |
| 64 | 1 | 2925 | n/a | 0 | 38.72 | 69.39 | 2.16 | 63.5 | yes |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 710 | n/a | 0 | 1.78 | 2.45 | 0.76 | 1.0 | no |
| 2 | 1 | 1317 | n/a | 0 | 1.90 | 3.22 | 1.57 | 2.0 | no |
| 4 | 1 | 2435 | n/a | 0 | 2.12 | 3.75 | 3.14 | 4.0 | no |
| 8 | 1 | 3176 | n/a | 0 | 3.65 | 10.75 | 4.27 | 8.0 | no |
| 16 | 3 | 3596 | 3578 to 3606 | 0 | 6.79 | 26.17 | 4.90 | 16.0 | yes |
| 32 | 1 | 3414 | n/a | 0 | 15.09 | 37.11 | 4.62 | 31.9 | yes |
| 64 | 1 | 2907 | n/a | 0 | 38.93 | 71.78 | 3.86 | 63.6 | yes |

## Vector track

- Embedding model: sentence-transformers/all-MiniLM-L6-v2 (384 dim, cosine)
- Index setup: dense_vector HNSW, similarity cosine, over the shared precomputed vectors
- Operating point: search knob tuned to ann_recall@10 >= 0.99 against exact kNN over the same vectors

Retrieval quality vs human judgements:

| Dataset | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| beir/scifact/test | 0.6239 | 0.9227 | 0.5797 | 0.5849 |
| beir/nfcorpus/test | 0.3144 | 0.3094 | 0.1574 | 0.5168 |
| dbpedia-entities-openai-100k | n/a | n/a | n/a | n/a |
| dbpedia-entities-openai-1m | n/a | n/a | n/a | n/a |

Recall operating point (latency below is measured here, the matched-recall rule for ANN search):

| Dataset | Knob | Value | ANN recall@k | Target met | Secondary value | Secondary recall |
| --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | num_candidates | 64 | 0.9967 | yes | 16 | 0.9553 |
| beir/nfcorpus/test | num_candidates | 160 | 0.9904 | yes | 64 | 0.9706 |
| dbpedia-entities-openai-100k | num_candidates | 768 | 0.9920 | yes | 32 | 0.9514 |
| dbpedia-entities-openai-1m | num_candidates | 2048 | 0.9923 | yes | 128 | 0.9588 |

Latency is measured at the operating point.

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | On disk | Peak heap | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 1117 | 4.64 | 0.02 GB | 11.77 GB | 0.00 | 1.00 | 1.00 |
| beir/nfcorpus/test | 3633 | 1242 | 2.92 | 0.01 GB | 11.88 GB | 0.00 | 0.00 | 0.00 |
| dbpedia-entities-openai-100k | 100000 | 568 | 176.12 | 0.65 GB | 11.92 GB | 2.00 | 3.00 | 4.00 |
| dbpedia-entities-openai-1m | 995000 | 417 | 2383.79 | 6.52 GB | 11.94 GB | 6.00 | 10.00 | 11.00 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 1.77 | 2.76 | 2.96 |
| beir/nfcorpus/test | 1.83 | 1.99 | 2.15 |
| dbpedia-entities-openai-100k | 4.44 | 5.68 | 6.21 |
| dbpedia-entities-openai-1m | 8.15 | 12.32 | 14.12 |

Engine container memory through the whole track, load included (anonymous memory is the heap the kernel cannot reclaim; charged memory adds the page cache of the engine's files):

| Dataset | Peak anonymous | Peak charged | Samples |
| --- | --- | --- | --- |
| beir/scifact/test | 11.77 GB | 11.82 GB | 506 |
| beir/nfcorpus/test | 11.88 GB | 11.98 GB | 576 |
| dbpedia-entities-openai-100k | 11.92 GB | 14.57 GB | 2183 |
| dbpedia-entities-openai-1m | 11.94 GB | 21.47 GB | 9186 |

Server-side time source per dataset:

- beir/scifact/test: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- beir/nfcorpus/test: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- dbpedia-entities-openai-100k: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- dbpedia-entities-openai-1m: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 576 | n/a | 0 | 1.88 | 2.22 | 0.47 | 1.0 | no |
| 2 | 1 | 1068 | n/a | 0 | 2.01 | 2.55 | 1.00 | 2.0 | no |
| 4 | 1 | 1981 | n/a | 0 | 2.15 | 20.85 | 2.11 | 4.0 | no |
| 8 | 1 | 2418 | n/a | 0 | 4.83 | 5.71 | 2.57 | 8.0 | no |
| 16 | 3 | 2670 | 2640 to 2674 | 0 | 9.33 | 36.98 | 2.86 | 16.0 | yes |
| 32 | 1 | 2498 | n/a | 0 | 20.70 | 45.84 | 2.63 | 31.9 | yes |
| 64 | 1 | 2220 | n/a | 0 | 51.91 | 92.38 | 2.34 | 63.5 | yes |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 532 | n/a | 0 | 2.01 | 2.30 | 0.51 | 1.0 | no |
| 2 | 1 | 1010 | n/a | 0 | 2.10 | 17.13 | 1.07 | 2.0 | no |
| 4 | 1 | 1926 | n/a | 0 | 2.23 | 2.60 | 2.17 | 4.0 | no |
| 8 | 1 | 2317 | n/a | 0 | 4.97 | 29.86 | 2.79 | 8.0 | no |
| 16 | 3 | 2655 | 2607 to 2668 | 0 | 9.29 | 38.16 | 3.16 | 16.0 | yes |
| 32 | 1 | 2466 | n/a | 0 | 20.93 | 52.58 | 2.94 | 31.9 | yes |
| 64 | 1 | 2320 | n/a | 0 | 48.03 | 79.88 | 2.70 | 63.5 | yes |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 219 | n/a | 0 | 5.69 | 6.70 | 0.61 | 1.0 | no |
| 2 | 1 | 435 | n/a | 0 | 5.79 | 7.63 | 1.21 | 2.0 | no |
| 4 | 1 | 780 | n/a | 0 | 6.77 | 8.38 | 2.43 | 4.0 | no |
| 8 | 1 | 1095 | n/a | 0 | 10.41 | 12.81 | 3.86 | 8.0 | no |
| 16 | 1 | 1427 | n/a | 0 | 17.01 | 109.58 | 5.52 | 15.9 | yes |
| 32 | 3 | 1540 | 1536 to 1545 | 0 | 32.78 | 122.86 | 6.30 | 31.8 | yes |
| 64 | 1 | 1434 | n/a | 0 | 74.43 | 203.62 | 5.90 | 63.1 | yes |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 124 | n/a | 0 | 11.71 | 14.83 | 0.79 | 1.0 | no |
| 2 | 1 | 245 | n/a | 0 | 12.02 | 15.60 | 1.52 | 2.0 | no |
| 4 | 1 | 435 | n/a | 0 | 14.26 | 19.68 | 3.04 | 4.0 | no |
| 8 | 1 | 694 | n/a | 0 | 17.45 | 22.46 | 5.66 | 8.0 | no |
| 16 | 3 | 816 | 815 to 817 | 0 | 31.10 | 44.20 | 7.61 | 15.9 | no |
| 32 | 1 | 754 | n/a | 0 | 58.20 | 72.37 | 7.49 | 31.7 | no |
| 64 | 1 | 790 | n/a | 0 | 114.00 | 139.17 | 7.72 | 62.7 | no |

## Hybrid track

- Setup: BM25 match fused with dense_vector kNN via the RRF retriever; the RRF retriever is not part of Elastic's free licence, so this run uses Elasticsearch's self-generated trial licence
- Fusion: RRF retriever (rank_constant=60)

Retrieval quality vs human judgements:

| Dataset | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| beir/scifact/test | 0.7082 | 0.9610 | 0.6625 | 0.6682 |
| beir/nfcorpus/test | 0.3523 | 0.3214 | 0.1867 | 0.5649 |
| dbpedia-entities-openai-100k | n/a | n/a | n/a | n/a |
| dbpedia-entities-openai-1m | n/a | n/a | n/a | n/a |

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | On disk | Peak heap | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 1468 | 3.53 | 0.02 GB | 11.85 GB | 1.00 | 1.00 | 2.00 |
| beir/nfcorpus/test | 3633 | 1251 | 2.90 | 0.01 GB | 11.89 GB | 1.00 | 1.00 | 1.00 |
| dbpedia-entities-openai-100k | 100000 | 583 | 171.66 | 0.65 GB | 11.93 GB | 2.00 | 3.00 | 4.00 |
| dbpedia-entities-openai-1m | 995000 | 433 | 2298.12 | 6.52 GB | 11.94 GB | 6.00 | 11.00 | 12.00 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 2.93 | 3.46 | 3.70 |
| beir/nfcorpus/test | 2.32 | 2.53 | 2.68 |
| dbpedia-entities-openai-100k | 4.94 | 6.18 | 6.75 |
| dbpedia-entities-openai-1m | 9.03 | 13.39 | 15.18 |

Engine container memory through the whole track, load included (anonymous memory is the heap the kernel cannot reclaim; charged memory adds the page cache of the engine's files):

| Dataset | Peak anonymous | Peak charged | Samples |
| --- | --- | --- | --- |
| beir/scifact/test | 11.85 GB | 11.94 GB | 388 |
| beir/nfcorpus/test | 11.89 GB | 11.98 GB | 382 |
| dbpedia-entities-openai-100k | 11.93 GB | 14.15 GB | 950 |
| dbpedia-entities-openai-1m | 11.94 GB | 21.47 GB | 7705 |

Server-side time source per dataset:

- beir/scifact/test: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- beir/nfcorpus/test: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- dbpedia-entities-openai-100k: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- dbpedia-entities-openai-1m: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 364 | n/a | 0 | 3.12 | 3.79 | 0.93 | 1.0 | no |
| 2 | 1 | 732 | n/a | 0 | 3.13 | 8.04 | 1.76 | 2.0 | no |
| 4 | 1 | 1395 | n/a | 0 | 3.32 | 15.21 | 3.10 | 4.0 | no |
| 8 | 1 | 1941 | n/a | 0 | 5.67 | 31.22 | 4.55 | 8.0 | no |
| 16 | 1 | 2481 | n/a | 0 | 9.66 | 32.14 | 5.93 | 16.0 | yes |
| 32 | 3 | 2582 | 2567 to 2584 | 0 | 19.86 | 54.29 | 6.15 | 31.9 | yes |
| 64 | 1 | 2278 | n/a | 0 | 48.75 | 82.87 | 5.40 | 63.5 | yes |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 425 | n/a | 0 | 2.52 | 2.77 | 0.68 | 1.0 | no |
| 2 | 1 | 811 | n/a | 0 | 2.66 | 3.03 | 1.38 | 2.0 | no |
| 4 | 1 | 1493 | n/a | 0 | 3.05 | 32.80 | 2.74 | 4.0 | no |
| 8 | 1 | 2010 | n/a | 0 | 5.52 | 30.52 | 3.88 | 8.0 | no |
| 16 | 3 | 2552 | 2547 to 2577 | 0 | 9.38 | 33.73 | 5.02 | 16.0 | yes |
| 32 | 1 | 2530 | n/a | 0 | 20.58 | 65.78 | 4.98 | 31.9 | yes |
| 64 | 1 | 2276 | n/a | 0 | 48.21 | 89.67 | 4.31 | 63.4 | yes |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 196 | n/a | 0 | 6.22 | 17.01 | 0.70 | 1.0 | no |
| 2 | 1 | 389 | n/a | 0 | 6.31 | 8.11 | 1.36 | 2.0 | no |
| 4 | 1 | 738 | n/a | 0 | 6.79 | 8.68 | 2.79 | 4.0 | no |
| 8 | 1 | 986 | n/a | 0 | 11.34 | 42.19 | 4.43 | 8.0 | no |
| 16 | 1 | 1246 | n/a | 0 | 19.54 | 53.99 | 5.91 | 15.9 | no |
| 32 | 1 | 1358 | n/a | 0 | 38.09 | 127.05 | 6.63 | 31.8 | no |
| 64 | 3 | 1395 | 1378 to 1405 | 0 | 77.62 | 175.06 | 6.83 | 63.2 | yes |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 116 | n/a | 0 | 12.32 | 15.14 | 0.84 | 1.0 | no |
| 2 | 1 | 232 | n/a | 0 | 12.46 | 16.83 | 1.66 | 2.0 | no |
| 4 | 1 | 410 | n/a | 0 | 14.50 | 19.80 | 3.34 | 4.0 | no |
| 8 | 1 | 631 | n/a | 0 | 18.52 | 25.27 | 5.68 | 8.0 | no |
| 16 | 1 | 739 | n/a | 0 | 32.89 | 45.35 | 7.64 | 15.9 | no |
| 32 | 1 | 698 | n/a | 0 | 62.72 | 85.48 | 7.35 | 31.6 | no |
| 64 | 3 | 749 | 741 to 750 | 0 | 118.00 | 144.69 | 7.74 | 62.7 | no |
