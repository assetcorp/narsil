# elasticsearch retrieval (keyword, vector, hybrid)

## Environment

- Captured: 2026-11-19T13:58:53.882409+00:00
- Load machine: GCP c3-standard-8, us-east4-a
- OS / arch: Linux 7.0.0-1017-gcp / x86_64 (containerized: True)
- CPU: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical)
- Memory: 33.6 GB
- Engine machine label: GCP c3-standard-8, us-east4-a
- Engine machine: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical), 33.6 GB
- Network round trip to the engine machine: p50 0.090 ms, p99 0.166 ms over 200 TCP connects
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
| beir/nfcorpus/test | 0.3217 | 0.3220 | -0.0003 | within margin | 0.2457 | 0.1503 | 0.5274 |
| dbpedia-entities-openai-100k | n/a | n/a | n/a | no baseline | n/a | n/a | n/a |
| dbpedia-entities-openai-1m | n/a | n/a | n/a | no baseline | n/a | n/a | n/a |

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | On disk | Peak heap | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 3709 | 1.40 | 0.01 GB | 11.55 GB | 1.00 | 1.00 | 2.00 |
| beir/nfcorpus/test | 3633 | 6914 | 0.53 | 0.01 GB | 11.81 GB | 0.00 | 0.00 | 0.00 |
| dbpedia-entities-openai-100k | 100000 | 43438 | 2.30 | 0.03 GB | 11.86 GB | 0.00 | 0.00 | 0.00 |
| dbpedia-entities-openai-1m | 995000 | 46821 | 21.25 | 0.36 GB | 11.90 GB | 0.00 | 1.00 | 1.00 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 2.11 | 2.82 | 3.14 |
| beir/nfcorpus/test | 0.72 | 0.96 | 1.10 |
| dbpedia-entities-openai-100k | 0.78 | 1.03 | 1.14 |
| dbpedia-entities-openai-1m | 0.91 | 1.37 | 1.65 |

Engine container memory through the whole track, load included (anonymous memory is the heap the kernel cannot reclaim; charged memory adds the page cache of the engine's files):

| Dataset | Peak anonymous | Peak charged | Samples |
| --- | --- | --- | --- |
| beir/scifact/test | 11.55 GB | 11.60 GB | 356 |
| beir/nfcorpus/test | 11.81 GB | 11.86 GB | 323 |
| dbpedia-entities-openai-100k | 11.86 GB | 12.00 GB | 531 |
| dbpedia-entities-openai-1m | 11.90 GB | 12.93 GB | 638 |

Server-side time source per dataset:

- beir/scifact/test: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- beir/nfcorpus/test: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- dbpedia-entities-openai-100k: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- dbpedia-entities-openai-1m: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 712 | n/a | 0 | 1.70 | 2.25 | 1.64 | 1.0 | no |
| 2 | 1 | 1594 | n/a | 0 | 1.58 | 3.60 | 2.65 | 2.0 | no |
| 4 | 1 | 3255 | n/a | 0 | 1.49 | 6.16 | 3.67 | 3.9 | no |
| 8 | 1 | 5109 | n/a | 0 | 2.19 | 35.21 | 6.09 | 7.8 | no |
| 16 | 1 | 6409 | n/a | 0 | 4.16 | 12.44 | 7.55 | 15.7 | no |
| 32 | 1 | 7090 | n/a | 0 | 8.78 | 16.92 | 7.89 | 31.7 | no |
| 64 | 1 | 7144 | n/a | 0 | 13.82 | 26.50 | 7.89 | 63.6 | no |
| 128 | 3 | 7208 | 7191 to 7237 | 0 | 22.72 | 35.67 | 7.90 | 127.3 | no |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 1672 | n/a | 0 | 0.75 | 0.94 | 0.86 | 1.0 | no |
| 2 | 1 | 3089 | n/a | 0 | 0.81 | 0.99 | 1.64 | 1.9 | no |
| 4 | 1 | 5299 | n/a | 0 | 0.92 | 1.23 | 3.32 | 3.9 | no |
| 8 | 1 | 8437 | n/a | 0 | 1.34 | 2.16 | 5.78 | 7.7 | no |
| 16 | 1 | 10910 | n/a | 0 | 2.37 | 9.66 | 7.33 | 15.6 | no |
| 32 | 1 | 13009 | n/a | 0 | 4.82 | 14.27 | 7.80 | 31.4 | no |
| 64 | 3 | 13682 | 13677 to 13711 | 0 | 8.57 | 21.89 | 7.88 | 63.4 | no |
| 128 | 1 | 13559 | n/a | 0 | 14.20 | 34.33 | 7.86 | 127.2 | no |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 1527 | n/a | 0 | 0.88 | 1.14 | 0.85 | 1.0 | no |
| 2 | 1 | 2595 | n/a | 0 | 1.00 | 1.28 | 1.64 | 1.9 | no |
| 4 | 1 | 4656 | n/a | 0 | 1.12 | 2.08 | 3.35 | 3.9 | no |
| 8 | 1 | 7419 | n/a | 0 | 1.55 | 8.72 | 5.88 | 7.7 | no |
| 16 | 1 | 9020 | n/a | 0 | 2.93 | 15.59 | 7.35 | 15.6 | no |
| 32 | 1 | 10877 | n/a | 0 | 5.94 | 20.98 | 7.77 | 31.5 | no |
| 64 | 1 | 12432 | n/a | 0 | 9.12 | 29.54 | 7.82 | 63.4 | no |
| 128 | 3 | 12613 | 12538 to 12641 | 0 | 14.86 | 39.03 | 7.85 | 127.2 | no |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 1156 | n/a | 0 | 1.27 | 2.31 | 1.08 | 1.0 | no |
| 2 | 1 | 2100 | n/a | 0 | 1.36 | 2.22 | 2.14 | 1.9 | no |
| 4 | 1 | 3702 | n/a | 0 | 1.54 | 2.64 | 4.37 | 3.9 | no |
| 8 | 1 | 5187 | n/a | 0 | 2.41 | 8.81 | 6.40 | 7.8 | no |
| 16 | 1 | 6404 | n/a | 0 | 4.49 | 11.02 | 7.69 | 15.7 | no |
| 32 | 1 | 7370 | n/a | 0 | 8.23 | 22.62 | 7.86 | 31.6 | no |
| 64 | 1 | 7614 | n/a | 0 | 13.09 | 28.23 | 7.91 | 63.6 | no |
| 128 | 3 | 7789 | 7766 to 7792 | 0 | 21.34 | 42.04 | 7.89 | 127.2 | no |

## Vector track

- Embedding model: sentence-transformers/all-MiniLM-L6-v2 (384 dim, cosine)
- Index setup: dense_vector HNSW, similarity cosine, over the shared precomputed vectors
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
| beir/scifact/test | num_candidates | 64 | 0.9943 | yes | 16 | 0.9527 |
| beir/nfcorpus/test | num_candidates | 192 | 0.9901 | yes | 64 | 0.9678 |
| dbpedia-entities-openai-100k | num_candidates | 768 | 0.9917 | yes | 64 | 0.9701 |
| dbpedia-entities-openai-1m | num_candidates | 1536 | 0.9911 | yes | 128 | 0.9589 |

Latency is measured at the operating point.

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | On disk | Peak heap | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 1125 | 4.61 | 0.02 GB | 11.70 GB | 0.00 | 1.00 | 1.00 |
| beir/nfcorpus/test | 3633 | 1230 | 2.95 | 0.01 GB | 11.81 GB | 0.00 | 0.00 | 0.00 |
| dbpedia-entities-openai-100k | 100000 | 562 | 177.92 | 0.65 GB | 11.88 GB | 2.00 | 3.00 | 4.00 |
| dbpedia-entities-openai-1m | 995000 | 503 | 1979.37 | 6.52 GB | 11.90 GB | 5.00 | 8.00 | 10.00 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 1.00 | 1.81 | 1.92 |
| beir/nfcorpus/test | 1.11 | 1.24 | 1.32 |
| dbpedia-entities-openai-100k | 3.06 | 4.40 | 4.99 |
| dbpedia-entities-openai-1m | 5.75 | 9.31 | 10.89 |

Engine container memory through the whole track, load included (anonymous memory is the heap the kernel cannot reclaim; charged memory adds the page cache of the engine's files):

| Dataset | Peak anonymous | Peak charged | Samples |
| --- | --- | --- | --- |
| beir/scifact/test | 11.70 GB | 11.75 GB | 674 |
| beir/nfcorpus/test | 11.81 GB | 11.91 GB | 824 |
| dbpedia-entities-openai-100k | 11.88 GB | 13.98 GB | 4394 |
| dbpedia-entities-openai-1m | 11.90 GB | 21.47 GB | 10206 |

Server-side time source per dataset:

- beir/scifact/test: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- beir/nfcorpus/test: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- dbpedia-entities-openai-100k: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- dbpedia-entities-openai-1m: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 1121 | n/a | 0 | 0.95 | 1.09 | 0.83 | 1.0 | no |
| 2 | 1 | 1945 | n/a | 0 | 1.10 | 1.52 | 1.70 | 1.9 | no |
| 4 | 1 | 3462 | n/a | 0 | 1.21 | 1.78 | 3.44 | 3.9 | no |
| 8 | 1 | 5540 | n/a | 0 | 1.79 | 2.52 | 5.90 | 7.8 | no |
| 16 | 1 | 7230 | n/a | 0 | 3.49 | 6.00 | 7.43 | 15.7 | no |
| 32 | 1 | 8182 | n/a | 0 | 7.36 | 73.20 | 7.69 | 31.6 | no |
| 64 | 3 | 8493 | 8246 to 8527 | 0 | 12.34 | 81.61 | 7.79 | 63.5 | no |
| 128 | 1 | 8396 | n/a | 0 | 20.42 | 85.48 | 7.86 | 127.2 | no |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 927 | n/a | 0 | 1.15 | 1.33 | 0.87 | 1.0 | no |
| 2 | 1 | 1717 | n/a | 0 | 1.24 | 1.62 | 1.77 | 1.9 | no |
| 4 | 1 | 3160 | n/a | 0 | 1.36 | 1.61 | 3.54 | 3.9 | no |
| 8 | 1 | 4822 | n/a | 0 | 2.06 | 2.92 | 5.95 | 7.8 | no |
| 16 | 1 | 6297 | n/a | 0 | 4.07 | 23.50 | 7.54 | 15.7 | no |
| 32 | 1 | 6997 | n/a | 0 | 8.47 | 34.00 | 7.74 | 31.2 | no |
| 64 | 3 | 7288 | 7138 to 7290 | 0 | 13.91 | 66.90 | 7.86 | 63.5 | no |
| 128 | 1 | 7241 | n/a | 0 | 22.93 | 86.15 | 7.86 | 127.2 | no |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 336 | n/a | 0 | 4.12 | 5.11 | 0.99 | 1.0 | no |
| 2 | 1 | 620 | n/a | 0 | 4.60 | 5.87 | 1.90 | 2.0 | no |
| 4 | 1 | 1202 | n/a | 0 | 4.71 | 6.17 | 3.78 | 4.0 | no |
| 8 | 1 | 1660 | n/a | 0 | 7.08 | 20.45 | 6.44 | 7.9 | no |
| 16 | 3 | 1955 | 1921 to 1965 | 0 | 13.99 | 28.40 | 7.82 | 15.9 | no |
| 32 | 1 | 1819 | n/a | 0 | 26.49 | 34.90 | 7.96 | 31.8 | no |
| 64 | 1 | 1889 | n/a | 0 | 45.58 | 61.04 | 7.96 | 63.5 | no |
| 128 | 1 | 1842 | n/a | 0 | 86.17 | 131.82 | 7.92 | 126.4 | no |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 175 | n/a | 0 | 9.02 | 13.10 | 0.97 | 1.0 | no |
| 2 | 1 | 345 | n/a | 0 | 9.13 | 14.43 | 1.93 | 2.0 | no |
| 4 | 1 | 604 | n/a | 0 | 10.95 | 14.80 | 3.87 | 4.0 | no |
| 8 | 1 | 862 | n/a | 0 | 14.94 | 46.88 | 6.70 | 7.9 | no |
| 16 | 1 | 1022 | n/a | 0 | 26.95 | 36.93 | 7.93 | 15.9 | no |
| 32 | 3 | 1118 | 1100 to 1133 | 0 | 44.46 | 58.92 | 7.94 | 31.8 | no |
| 64 | 1 | 984 | n/a | 0 | 88.49 | 116.92 | 7.96 | 63.2 | no |
| 128 | 1 | 958 | n/a | 0 | 163.74 | 229.46 | 7.92 | 125.0 | no |

## Hybrid track

- Setup: BM25 match fused with dense_vector kNN via the RRF retriever; the RRF retriever is not part of Elastic's free licence, so this run uses Elasticsearch's self-generated trial licence
- Fusion: RRF retriever (rank_constant=60)

Retrieval quality vs human judgements:

| Dataset | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| beir/scifact/test | 0.7078 | 0.9610 | 0.6620 | 0.6676 |
| beir/nfcorpus/test | 0.3522 | 0.3215 | 0.1867 | 0.5648 |
| dbpedia-entities-openai-100k | n/a | n/a | n/a | n/a |
| dbpedia-entities-openai-1m | n/a | n/a | n/a | n/a |

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | On disk | Peak heap | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 1454 | 3.57 | 0.02 GB | 11.79 GB | 1.00 | 2.00 | 2.00 |
| beir/nfcorpus/test | 3633 | 1179 | 3.08 | 0.01 GB | 11.81 GB | 1.00 | 1.00 | 1.00 |
| dbpedia-entities-openai-100k | 100000 | 551 | 181.45 | 0.65 GB | 11.90 GB | 2.00 | 4.00 | 4.00 |
| dbpedia-entities-openai-1m | 995000 | 445 | 2236.28 | 6.52 GB | 11.90 GB | 5.00 | 9.00 | 10.00 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 2.23 | 2.72 | 2.98 |
| beir/nfcorpus/test | 1.61 | 1.79 | 1.90 |
| dbpedia-entities-openai-100k | 3.53 | 4.83 | 5.39 |
| dbpedia-entities-openai-1m | 6.51 | 10.17 | 11.80 |

Engine container memory through the whole track, load included (anonymous memory is the heap the kernel cannot reclaim; charged memory adds the page cache of the engine's files):

| Dataset | Peak anonymous | Peak charged | Samples |
| --- | --- | --- | --- |
| beir/scifact/test | 11.79 GB | 11.85 GB | 517 |
| beir/nfcorpus/test | 11.81 GB | 11.91 GB | 510 |
| dbpedia-entities-openai-100k | 11.90 GB | 14.53 GB | 1451 |
| dbpedia-entities-openai-1m | 11.90 GB | 21.47 GB | 7965 |

Server-side time source per dataset:

- beir/scifact/test: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- beir/nfcorpus/test: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- dbpedia-entities-openai-100k: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- dbpedia-entities-openai-1m: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 531 | n/a | 0 | 2.22 | 2.82 | 1.29 | 1.0 | no |
| 2 | 1 | 1051 | n/a | 0 | 2.26 | 3.04 | 2.30 | 2.0 | no |
| 4 | 1 | 1908 | n/a | 0 | 2.50 | 14.49 | 4.34 | 3.9 | no |
| 8 | 1 | 2666 | n/a | 0 | 3.97 | 30.62 | 6.30 | 7.9 | no |
| 16 | 1 | 3307 | n/a | 0 | 7.35 | 36.42 | 7.56 | 15.8 | no |
| 32 | 1 | 3558 | n/a | 0 | 14.28 | 39.68 | 7.80 | 31.8 | no |
| 64 | 1 | 3650 | n/a | 0 | 24.05 | 61.41 | 7.85 | 63.6 | no |
| 128 | 3 | 3678 | 3673 to 3721 | 0 | 42.62 | 83.67 | 7.89 | 126.9 | no |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 641 | n/a | 0 | 1.69 | 2.04 | 1.03 | 1.0 | no |
| 2 | 1 | 1188 | n/a | 0 | 1.82 | 2.23 | 2.10 | 2.0 | no |
| 4 | 1 | 2185 | n/a | 0 | 2.00 | 2.42 | 4.09 | 3.9 | no |
| 8 | 1 | 3114 | n/a | 0 | 3.24 | 20.33 | 6.18 | 7.9 | no |
| 16 | 1 | 3973 | n/a | 0 | 5.89 | 38.27 | 7.54 | 15.8 | no |
| 32 | 1 | 4408 | n/a | 0 | 11.94 | 38.32 | 7.75 | 31.8 | no |
| 64 | 3 | 4555 | 4523 to 4585 | 0 | 20.28 | 61.63 | 7.84 | 63.6 | no |
| 128 | 1 | 4554 | n/a | 0 | 36.55 | 75.21 | 7.88 | 127.1 | no |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 278 | n/a | 0 | 4.79 | 6.24 | 1.02 | 1.0 | no |
| 2 | 1 | 549 | n/a | 0 | 4.87 | 6.12 | 2.03 | 2.0 | no |
| 4 | 1 | 1005 | n/a | 0 | 5.41 | 21.08 | 4.01 | 4.0 | no |
| 8 | 1 | 1372 | n/a | 0 | 8.40 | 46.13 | 6.37 | 7.9 | no |
| 16 | 1 | 1532 | n/a | 0 | 16.24 | 40.04 | 7.75 | 15.9 | no |
| 32 | 1 | 1563 | n/a | 0 | 29.01 | 60.61 | 7.91 | 31.8 | no |
| 64 | 1 | 1558 | n/a | 0 | 52.98 | 94.85 | 7.91 | 63.4 | no |
| 128 | 3 | 1562 | 1558 to 1579 | 0 | 99.18 | 142.88 | 7.94 | 126.2 | no |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 155 | n/a | 0 | 9.93 | 12.81 | 1.03 | 1.0 | no |
| 2 | 1 | 309 | n/a | 0 | 9.97 | 12.98 | 2.06 | 2.0 | no |
| 4 | 1 | 524 | n/a | 0 | 11.94 | 18.76 | 4.12 | 4.0 | no |
| 8 | 1 | 744 | n/a | 0 | 16.61 | 22.98 | 6.61 | 7.9 | no |
| 16 | 1 | 903 | n/a | 0 | 28.94 | 44.87 | 7.89 | 15.9 | no |
| 32 | 3 | 904 | 896 to 917 | 0 | 51.65 | 72.85 | 7.95 | 31.8 | no |
| 64 | 1 | 830 | n/a | 0 | 103.17 | 139.23 | 7.92 | 63.2 | no |
| 128 | 1 | 821 | n/a | 0 | 193.99 | 255.16 | 7.94 | 124.6 | no |
