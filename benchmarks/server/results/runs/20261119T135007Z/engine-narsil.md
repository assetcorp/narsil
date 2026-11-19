# narsil retrieval (keyword, vector, hybrid)

## Environment

- Captured: 2026-11-19T14:04:18.231588+00:00
- Load machine: GCP c3-standard-8, us-central1-a
- OS / arch: Linux 7.0.0-1017-gcp / x86_64 (containerized: True)
- CPU: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical)
- Memory: 33.6 GB
- Engine machine label: GCP c3-standard-8, us-central1-a
- Engine machine: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical), 33.6 GB
- Network round trip to the engine machine: p50 0.089 ms, p99 0.178 ms over 200 TCP connects
- Memory cap per engine: 21.5 GB
- Tracks: keyword, vector, hybrid
- Keyword setup: BM25 k1=0.9 b=0.4; language english, as the server reports it
- Run depth: 1000; run tag: narsil_bm25
- Engine build: version 0.4.5, commit 3ad47df2c9c1
- Engine image: ir-benchmark-engine-narsil@sha256:ba607a6c7326ee3d66fa9a6f1a4bd5a87744196ffa69fc5b6b195afa39e9a0f3
- Dataset beir/scifact/test: content md5 5f7d1de60b170fc8027bb7898e2efca1
- Dataset beir/nfcorpus/test: content md5 a89dba18a62ef92f7d323ec890a0d38d

## Keyword track

Retrieval quality vs Anserini BM25 reference:

| Dataset | nDCG@10 | Reference | Delta | Status | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 0.6814 | 0.6790 | +0.0024 | within margin | 0.9253 | 0.6417 | 0.6494 |
| beir/nfcorpus/test | 0.3283 | 0.3220 | +0.0063 | within margin | 0.2489 | 0.1535 | 0.5336 |
| dbpedia-entities-openai-100k | n/a | n/a | n/a | no baseline | n/a | n/a | n/a |
| dbpedia-entities-openai-1m | n/a | n/a | n/a | no baseline | n/a | n/a | n/a |

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | On disk | Peak heap | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 4421 | 1.17 | 0.00 GB | 0.82 GB | 0.09 | 0.17 | 0.26 |
| beir/nfcorpus/test | 3633 | 4402 | 0.83 | 0.00 GB | 0.95 GB | 0.07 | 0.23 | 0.30 |
| dbpedia-entities-openai-100k | 100000 | 18039 | 5.54 | 0.09 GB | 2.30 GB | 0.06 | 0.23 | 0.31 |
| dbpedia-entities-openai-1m | 995000 | 18512 | 53.75 | 0.94 GB | 6.50 GB | 0.23 | 0.99 | 1.75 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 0.34 | 0.54 | 0.80 |
| beir/nfcorpus/test | 0.32 | 0.59 | 0.71 |
| dbpedia-entities-openai-100k | 0.30 | 0.52 | 0.64 |
| dbpedia-entities-openai-1m | 0.54 | 1.33 | 2.12 |

Engine container memory through the whole track, load included (anonymous memory is the heap the kernel cannot reclaim; charged memory adds the page cache of the engine's files):

| Dataset | Peak anonymous | Peak charged | Samples |
| --- | --- | --- | --- |
| beir/scifact/test | 0.82 GB | 0.86 GB | 325 |
| beir/nfcorpus/test | 0.95 GB | 0.98 GB | 319 |
| dbpedia-entities-openai-100k | 2.30 GB | 2.42 GB | 540 |
| dbpedia-entities-openai-1m | 6.50 GB | 7.33 GB | 1081 |

Server-side time source per dataset:

- beir/scifact/test: response `elapsed` field (floating-millisecond resolution)
- beir/nfcorpus/test: response `elapsed` field (floating-millisecond resolution)
- dbpedia-entities-openai-100k: response `elapsed` field (floating-millisecond resolution)
- dbpedia-entities-openai-1m: response `elapsed` field (floating-millisecond resolution)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 4180 | n/a | 0 | 0.28 | 0.90 | 0.65 | 0.9 | no |
| 2 | 1 | 7731 | n/a | 0 | 0.32 | 1.24 | 1.33 | 1.8 | no |
| 4 | 1 | 12629 | n/a | 0 | 0.42 | 1.28 | 2.95 | 3.6 | no |
| 8 | 1 | 18388 | n/a | 0 | 0.56 | 2.21 | 5.44 | 7.2 | no |
| 16 | 1 | 32210 | n/a | 0 | 0.65 | 4.49 | 7.76 | 14.4 | no |
| 32 | 1 | 33656 | n/a | 0 | 1.68 | 6.35 | 7.91 | 30.3 | no |
| 64 | 1 | 33884 | n/a | 0 | 3.51 | 10.29 | 7.90 | 62.3 | no |
| 128 | 3 | 34198 | 34169 to 34213 | 0 | 6.43 | 15.49 | 7.91 | 126.2 | no |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 6050 | n/a | 0 | 0.17 | 0.84 | 0.58 | 0.8 | no |
| 2 | 1 | 10114 | n/a | 0 | 0.23 | 0.94 | 1.09 | 1.7 | no |
| 4 | 1 | 16852 | n/a | 0 | 0.29 | 1.09 | 2.37 | 3.5 | no |
| 8 | 1 | 24357 | n/a | 0 | 0.37 | 1.90 | 4.72 | 6.9 | no |
| 16 | 1 | 42191 | n/a | 0 | 0.72 | 3.33 | 7.04 | 14.0 | no |
| 32 | 1 | 50638 | n/a | 0 | 1.18 | 5.78 | 7.87 | 29.6 | no |
| 64 | 1 | 51124 | n/a | 0 | 2.48 | 9.35 | 7.88 | 61.5 | no |
| 128 | 3 | 51462 | 51319 to 51564 | 0 | 4.74 | 13.55 | 7.87 | 125.4 | no |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 4698 | n/a | 0 | 0.35 | 0.83 | 0.62 | 0.9 | no |
| 2 | 1 | 8465 | n/a | 0 | 0.39 | 1.10 | 1.27 | 1.8 | no |
| 4 | 1 | 13209 | n/a | 0 | 0.46 | 1.20 | 2.85 | 3.6 | no |
| 8 | 1 | 19004 | n/a | 0 | 0.68 | 2.95 | 5.56 | 7.2 | no |
| 16 | 1 | 31085 | n/a | 0 | 0.97 | 4.35 | 7.62 | 14.6 | no |
| 32 | 3 | 33054 | 32983 to 33102 | 0 | 2.04 | 6.52 | 7.91 | 30.5 | no |
| 64 | 1 | 31017 | n/a | 0 | 4.32 | 12.05 | 7.93 | 62.6 | no |
| 128 | 1 | 32700 | n/a | 0 | 6.87 | 17.49 | 7.90 | 126.1 | no |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 1912 | n/a | 0 | 1.14 | 2.96 | 0.86 | 0.9 | no |
| 2 | 1 | 3319 | n/a | 0 | 1.33 | 3.53 | 1.71 | 1.9 | no |
| 4 | 1 | 5852 | n/a | 0 | 1.59 | 4.24 | 3.52 | 3.8 | no |
| 8 | 1 | 6987 | n/a | 0 | 2.78 | 7.53 | 6.95 | 7.7 | no |
| 16 | 1 | 8186 | n/a | 0 | 4.47 | 11.56 | 7.93 | 15.7 | no |
| 32 | 1 | 8218 | n/a | 0 | 8.38 | 20.39 | 7.96 | 31.6 | no |
| 64 | 1 | 8267 | n/a | 0 | 15.29 | 32.61 | 7.95 | 63.5 | no |
| 128 | 3 | 8459 | 8380 to 8498 | 0 | 27.09 | 53.69 | 7.95 | 127.0 | no |

## Vector track

- Embedding model: sentence-transformers/all-MiniLM-L6-v2 (384 dim, cosine)
- Index setup: HNSW over the shared precomputed vectors, full precision (quantization off), cosine
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
| beir/scifact/test | efSearch | 64 | 0.9960 | yes | 32 | 0.9853 |
| beir/nfcorpus/test | efSearch | 128 | 0.9944 | yes | 64 | 0.9805 |
| dbpedia-entities-openai-100k | efSearch | 128 | 0.9915 | yes | 32 | 0.9605 |
| dbpedia-entities-openai-1m | efSearch | 280 | 0.9920 | yes | 64 | 0.9610 |

Latency is measured at the operating point.

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | On disk | Peak heap | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 1691 | 3.06 | 0.00 GB | 1.04 GB | 0.15 | 0.18 | 0.22 |
| beir/nfcorpus/test | 3633 | 1564 | 2.32 | 0.02 GB | 0.91 GB | 0.20 | 0.23 | 0.26 |
| dbpedia-entities-openai-100k | 100000 | 850 | 117.71 | 0.72 GB | 2.45 GB | 1.04 | 1.41 | 1.53 |
| dbpedia-entities-openai-1m | 995000 | 743 | 1339.09 | 7.20 GB | 10.88 GB | 2.98 | 4.04 | 4.27 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 0.46 | 0.55 | 0.82 |
| beir/nfcorpus/test | 0.50 | 0.58 | 0.93 |
| dbpedia-entities-openai-100k | 1.49 | 1.90 | 2.18 |
| dbpedia-entities-openai-1m | 3.45 | 4.52 | 4.79 |

Engine container memory through the whole track, load included (anonymous memory is the heap the kernel cannot reclaim; charged memory adds the page cache of the engine's files):

| Dataset | Peak anonymous | Peak charged | Samples |
| --- | --- | --- | --- |
| beir/scifact/test | 1.04 GB | 1.10 GB | 648 |
| beir/nfcorpus/test | 0.91 GB | 0.95 GB | 698 |
| dbpedia-entities-openai-100k | 2.45 GB | 4.65 GB | 1535 |
| dbpedia-entities-openai-1m | 10.88 GB | 20.19 GB | 5450 |

Server-side time source per dataset:

- beir/scifact/test: response `elapsed` field (floating-millisecond resolution)
- beir/nfcorpus/test: response `elapsed` field (floating-millisecond resolution)
- dbpedia-entities-openai-100k: response `elapsed` field (floating-millisecond resolution)
- dbpedia-entities-openai-1m: response `elapsed` field (floating-millisecond resolution)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 2437 | n/a | 0 | 0.43 | 0.95 | 0.74 | 0.9 | no |
| 2 | 1 | 5082 | n/a | 0 | 0.45 | 1.80 | 1.68 | 1.8 | no |
| 4 | 1 | 8516 | n/a | 0 | 0.56 | 2.91 | 3.44 | 3.7 | no |
| 8 | 1 | 12274 | n/a | 0 | 0.97 | 4.04 | 6.16 | 7.4 | no |
| 16 | 1 | 16622 | n/a | 0 | 1.63 | 7.81 | 7.93 | 15.2 | no |
| 32 | 1 | 16762 | n/a | 0 | 4.00 | 11.07 | 7.92 | 31.2 | no |
| 64 | 1 | 16924 | n/a | 0 | 6.64 | 16.02 | 7.93 | 63.1 | no |
| 128 | 3 | 16931 | 16925 to 16999 | 0 | 13.15 | 25.44 | 7.93 | 126.7 | no |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 2159 | n/a | 0 | 0.50 | 2.50 | 0.85 | 0.9 | no |
| 2 | 1 | 4237 | n/a | 0 | 0.50 | 1.77 | 1.63 | 1.9 | no |
| 4 | 1 | 7500 | n/a | 0 | 0.64 | 3.20 | 3.47 | 3.7 | no |
| 8 | 1 | 10866 | n/a | 0 | 1.09 | 4.32 | 6.32 | 7.5 | no |
| 16 | 1 | 13944 | n/a | 0 | 1.97 | 8.01 | 7.93 | 15.3 | no |
| 32 | 3 | 13799 | 13794 to 14027 | 0 | 4.57 | 11.98 | 7.94 | 31.3 | no |
| 64 | 1 | 14023 | n/a | 0 | 8.22 | 18.50 | 7.94 | 63.3 | no |
| 128 | 1 | 13791 | n/a | 0 | 16.19 | 30.88 | 7.94 | 127.0 | no |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 733 | n/a | 0 | 1.77 | 3.39 | 1.04 | 1.0 | no |
| 2 | 1 | 1496 | n/a | 0 | 1.74 | 3.43 | 2.07 | 1.9 | no |
| 4 | 1 | 2741 | n/a | 0 | 1.96 | 4.85 | 4.24 | 3.9 | no |
| 8 | 1 | 3530 | n/a | 0 | 4.04 | 9.20 | 7.32 | 7.8 | no |
| 16 | 1 | 3532 | n/a | 0 | 7.99 | 18.20 | 7.95 | 15.8 | no |
| 32 | 3 | 3589 | 3567 to 3592 | 0 | 16.35 | 32.14 | 7.94 | 31.7 | no |
| 64 | 1 | 3402 | n/a | 0 | 32.38 | 60.02 | 7.95 | 63.3 | no |
| 128 | 1 | 3342 | n/a | 0 | 65.49 | 110.77 | 7.97 | 126.5 | no |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 294 | n/a | 0 | 4.50 | 6.28 | 1.07 | 1.0 | no |
| 2 | 1 | 603 | n/a | 0 | 4.37 | 6.25 | 2.14 | 2.0 | no |
| 4 | 1 | 1095 | n/a | 0 | 4.91 | 7.56 | 4.37 | 4.0 | no |
| 8 | 1 | 1412 | n/a | 0 | 9.31 | 18.28 | 7.67 | 7.9 | no |
| 16 | 1 | 1428 | n/a | 0 | 17.76 | 37.44 | 7.96 | 15.9 | no |
| 32 | 1 | 1475 | n/a | 0 | 39.26 | 74.82 | 7.97 | 31.7 | no |
| 64 | 3 | 1659 | 1631 to 1663 | 0 | 67.17 | 125.34 | 7.96 | 63.2 | no |
| 128 | 1 | 1496 | n/a | 0 | 145.53 | 231.82 | 7.98 | 123.8 | no |

## Hybrid track

- Setup: BM25 (text) fused with HNSW vector search via Reciprocal Rank Fusion
- Fusion: RRF (k=60)

Retrieval quality vs human judgements:

| Dataset | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| beir/scifact/test | 0.7054 | 0.9643 | 0.6581 | 0.6648 |
| beir/nfcorpus/test | 0.3562 | 0.3238 | 0.1877 | 0.5759 |
| dbpedia-entities-openai-100k | n/a | n/a | n/a | n/a |
| dbpedia-entities-openai-1m | n/a | n/a | n/a | n/a |

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | On disk | Peak heap | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 1989 | 2.61 | 0.03 GB | 1.13 GB | 0.29 | 0.37 | 0.44 |
| beir/nfcorpus/test | 3633 | 1590 | 2.28 | 0.00 GB | 0.95 GB | 0.29 | 0.34 | 0.37 |
| dbpedia-entities-openai-100k | 100000 | 855 | 117.02 | 0.72 GB | 2.92 GB | 1.16 | 1.53 | 1.67 |
| dbpedia-entities-openai-1m | 995000 | 704 | 1413.38 | 7.20 GB | 10.20 GB | 3.48 | 4.84 | 5.56 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 0.68 | 0.82 | 1.07 |
| beir/nfcorpus/test | 0.63 | 0.72 | 1.02 |
| dbpedia-entities-openai-100k | 1.62 | 2.04 | 2.37 |
| dbpedia-entities-openai-1m | 4.01 | 5.38 | 6.18 |

Engine container memory through the whole track, load included (anonymous memory is the heap the kernel cannot reclaim; charged memory adds the page cache of the engine's files):

| Dataset | Peak anonymous | Peak charged | Samples |
| --- | --- | --- | --- |
| beir/scifact/test | 1.13 GB | 1.18 GB | 487 |
| beir/nfcorpus/test | 0.95 GB | 0.99 GB | 486 |
| dbpedia-entities-openai-100k | 2.92 GB | 5.16 GB | 1150 |
| dbpedia-entities-openai-1m | 10.20 GB | 19.33 GB | 3983 |

Server-side time source per dataset:

- beir/scifact/test: response `elapsed` field (floating-millisecond resolution)
- beir/nfcorpus/test: response `elapsed` field (floating-millisecond resolution)
- dbpedia-entities-openai-100k: response `elapsed` field (floating-millisecond resolution)
- dbpedia-entities-openai-1m: response `elapsed` field (floating-millisecond resolution)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 1835 | n/a | 0 | 0.60 | 2.70 | 0.92 | 0.9 | no |
| 2 | 1 | 3479 | n/a | 0 | 0.66 | 2.91 | 1.83 | 1.9 | no |
| 4 | 1 | 6278 | n/a | 0 | 0.79 | 1.85 | 3.50 | 3.8 | no |
| 8 | 1 | 9340 | n/a | 0 | 1.30 | 4.72 | 6.51 | 7.6 | no |
| 16 | 1 | 11643 | n/a | 0 | 2.23 | 8.70 | 7.94 | 15.5 | no |
| 32 | 1 | 11784 | n/a | 0 | 4.95 | 12.30 | 7.94 | 31.4 | no |
| 64 | 1 | 11814 | n/a | 0 | 9.62 | 20.07 | 7.95 | 63.3 | no |
| 128 | 3 | 11835 | 11798 to 11838 | 0 | 18.59 | 34.45 | 7.93 | 127.0 | no |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 1709 | n/a | 0 | 0.63 | 1.57 | 0.89 | 1.0 | no |
| 2 | 1 | 3296 | n/a | 0 | 0.69 | 3.14 | 1.80 | 1.9 | no |
| 4 | 1 | 6216 | n/a | 0 | 0.77 | 3.47 | 3.63 | 3.8 | no |
| 8 | 1 | 9177 | n/a | 0 | 1.35 | 4.75 | 6.55 | 7.6 | no |
| 16 | 1 | 11544 | n/a | 0 | 2.39 | 8.50 | 7.95 | 15.5 | no |
| 32 | 1 | 11550 | n/a | 0 | 5.12 | 13.28 | 7.95 | 31.4 | no |
| 64 | 1 | 11518 | n/a | 0 | 10.20 | 19.85 | 7.95 | 63.3 | no |
| 128 | 3 | 11604 | 11578 to 11613 | 0 | 18.88 | 36.38 | 7.94 | 126.9 | no |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 643 | n/a | 0 | 1.96 | 5.18 | 1.08 | 1.0 | no |
| 2 | 1 | 1286 | n/a | 0 | 1.98 | 6.81 | 2.16 | 2.0 | no |
| 4 | 1 | 2397 | n/a | 0 | 2.22 | 10.43 | 4.41 | 3.9 | no |
| 8 | 1 | 3032 | n/a | 0 | 5.07 | 18.08 | 7.44 | 7.9 | no |
| 16 | 1 | 3148 | n/a | 0 | 10.21 | 26.52 | 7.95 | 15.8 | no |
| 32 | 3 | 3218 | 3172 to 3228 | 0 | 19.40 | 43.57 | 7.95 | 31.8 | no |
| 64 | 1 | 3072 | n/a | 0 | 36.37 | 76.64 | 7.95 | 63.5 | no |
| 128 | 1 | 3051 | n/a | 0 | 71.00 | 127.61 | 7.95 | 126.3 | no |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 251 | n/a | 0 | 5.39 | 8.18 | 1.08 | 1.0 | no |
| 2 | 1 | 505 | n/a | 0 | 5.44 | 7.94 | 2.13 | 2.0 | no |
| 4 | 1 | 899 | n/a | 0 | 6.33 | 10.20 | 4.39 | 4.0 | no |
| 8 | 1 | 1214 | n/a | 0 | 10.96 | 20.71 | 7.72 | 7.9 | no |
| 16 | 1 | 1237 | n/a | 0 | 20.83 | 46.79 | 7.96 | 15.9 | no |
| 32 | 1 | 1297 | n/a | 0 | 42.32 | 79.08 | 7.96 | 31.7 | no |
| 64 | 3 | 1304 | 1280 to 1310 | 0 | 85.02 | 152.53 | 7.96 | 63.0 | no |
| 128 | 1 | 1241 | n/a | 0 | 173.63 | 268.35 | 7.97 | 124.3 | no |
