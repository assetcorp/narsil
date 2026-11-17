# qdrant retrieval (vector, hybrid, best-config vector profile)

## Environment

- Captured: 2026-11-17T09:00:10.098185+00:00
- Load machine: GCP c3-standard-8, us-west4-a
- OS / arch: Linux 7.0.0-1017-gcp / x86_64 (containerized: True)
- CPU: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical)
- Memory: 33.6 GB
- Engine machine label: GCP c3-standard-8, us-west4-a
- Engine machine: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical), 33.6 GB
- Network round trip to the engine machine: p50 0.087 ms, p99 0.159 ms over 200 TCP connects
- Memory cap per engine: 21.5 GB
- Tracks: vector, hybrid
- Keyword setup: None
- Run depth: 1000; run tag: qdrant
- Engine build: version 1.20.2, commit 23065a0bf685
- Engine image: qdrant/qdrant@sha256:d277592721d2e3b73f9b797b53cf05e6a5bb2134f6d13fdbda4ca51782afbcac
- Dataset beir/scifact/test: content md5 5f7d1de60b170fc8027bb7898e2efca1
- Dataset beir/nfcorpus/test: content md5 a89dba18a62ef92f7d323ec890a0d38d

## Vector track

- Embedding model: sentence-transformers/all-MiniLM-L6-v2 (384 dim, cosine)
- Index setup: HNSW dense vectors with 4-bit TurboQuant held in RAM and full-precision rescore (oversampling 2.0x), distance Cosine, over the shared precomputed vectors
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
| beir/scifact/test | hnsw_ef | 32 | 0.9937 | yes | 16 | 0.9807 |
| beir/nfcorpus/test | hnsw_ef | 64 | 0.9941 | yes | 16 | 0.9529 |
| dbpedia-entities-openai-100k | hnsw_ef | 128 | 0.9946 | yes | 16 | 0.9523 |
| dbpedia-entities-openai-1m | hnsw_ef | 192 | 0.9922 | yes | 64 | 0.9734 |

Latency is measured at the operating point.

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | On disk | Peak heap | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 1487 | 3.49 | n/a | 0.59 GB | 0.21 | 0.24 | 0.26 |
| beir/nfcorpus/test | 3633 | 1366 | 2.66 | n/a | 0.39 GB | 0.24 | 0.31 | 0.33 |
| dbpedia-entities-openai-100k | 100000 | 830 | 120.44 | n/a | 1.69 GB | 0.51 | 0.66 | 1.18 |
| dbpedia-entities-openai-1m | 995000 | 813 | 1223.79 | n/a | 2.56 GB | 1.84 | 3.24 | 3.76 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 1.27 | 1.41 | 1.49 |
| beir/nfcorpus/test | 1.31 | 1.46 | 1.58 |
| dbpedia-entities-openai-100k | 2.45 | 2.75 | 3.16 |
| dbpedia-entities-openai-1m | 3.81 | 5.22 | 5.79 |

Engine container memory through the whole track, load included (anonymous memory is the heap the kernel cannot reclaim; charged memory adds the page cache of the engine's files):

| Dataset | Peak anonymous | Peak charged | Samples |
| --- | --- | --- | --- |
| beir/scifact/test | 0.59 GB | 0.70 GB | 432 |
| beir/nfcorpus/test | 0.39 GB | 0.50 GB | 470 |
| dbpedia-entities-openai-100k | 1.69 GB | 6.75 GB | 896 |
| dbpedia-entities-openai-1m | 2.56 GB | 13.66 GB | 3727 |

Server-side time source per dataset:

- beir/scifact/test: top-level `time` field, seconds converted to ms (floating-millisecond resolution)
- beir/nfcorpus/test: top-level `time` field, seconds converted to ms (floating-millisecond resolution)
- dbpedia-entities-openai-100k: top-level `time` field, seconds converted to ms (floating-millisecond resolution)
- dbpedia-entities-openai-1m: top-level `time` field, seconds converted to ms (floating-millisecond resolution)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 779 | n/a | 0 | 1.38 | 1.55 | 0.44 | 1.0 | no |
| 2 | 1 | 1524 | n/a | 0 | 1.41 | 1.60 | 0.91 | 2.0 | no |
| 4 | 1 | 2793 | n/a | 0 | 1.57 | 2.09 | 1.91 | 4.0 | no |
| 8 | 3 | 3115 | 3093 to 3131 | 0 | 3.24 | 4.70 | 2.15 | 8.0 | yes |
| 16 | 1 | 2783 | n/a | 0 | 9.19 | 26.29 | 1.92 | 16.0 | yes |
| 32 | 1 | 2545 | n/a | 0 | 20.12 | 37.21 | 1.74 | 31.9 | yes |
| 64 | 1 | 2389 | n/a | 0 | 46.32 | 85.05 | 1.64 | 63.5 | yes |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 777 | n/a | 0 | 1.39 | 1.61 | 0.47 | 1.0 | no |
| 2 | 1 | 1460 | n/a | 0 | 1.50 | 1.98 | 0.98 | 2.0 | no |
| 4 | 1 | 2746 | n/a | 0 | 1.61 | 1.85 | 2.08 | 4.0 | no |
| 8 | 3 | 3141 | 3065 to 3169 | 0 | 3.23 | 4.69 | 2.39 | 8.0 | yes |
| 16 | 1 | 2782 | n/a | 0 | 8.95 | 25.17 | 2.13 | 16.0 | yes |
| 32 | 1 | 2542 | n/a | 0 | 20.24 | 37.44 | 1.92 | 31.9 | yes |
| 64 | 1 | 2401 | n/a | 0 | 45.64 | 85.34 | 1.84 | 63.5 | yes |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 386 | n/a | 0 | 2.73 | 3.78 | 0.62 | 1.0 | no |
| 2 | 1 | 754 | n/a | 0 | 2.79 | 3.29 | 1.22 | 2.0 | no |
| 4 | 1 | 1423 | n/a | 0 | 3.09 | 3.76 | 2.41 | 3.9 | no |
| 8 | 3 | 1772 | 1733 to 1773 | 0 | 5.70 | 9.47 | 3.15 | 8.0 | yes |
| 16 | 1 | 1591 | n/a | 0 | 15.65 | 99.34 | 3.03 | 16.0 | yes |
| 32 | 1 | 1515 | n/a | 0 | 33.65 | 128.51 | 2.86 | 31.8 | yes |
| 64 | 1 | 1459 | n/a | 0 | 75.56 | 171.83 | 2.76 | 63.3 | yes |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 320 | n/a | 0 | 3.51 | 3.71 | 0.99 | 1.0 | no |
| 2 | 1 | 615 | n/a | 0 | 3.58 | 4.32 | 1.97 | 2.0 | no |
| 4 | 1 | 1111 | n/a | 0 | 4.40 | 5.43 | 3.75 | 4.0 | no |
| 8 | 1 | 1507 | n/a | 0 | 7.10 | 12.34 | 5.47 | 8.0 | no |
| 16 | 1 | 1543 | n/a | 0 | 16.02 | 95.61 | 5.64 | 15.9 | yes |
| 32 | 3 | 1579 | 1575 to 1583 | 0 | 33.37 | 112.48 | 5.90 | 31.8 | yes |
| 64 | 1 | 1441 | n/a | 0 | 73.70 | 161.68 | 5.35 | 63.2 | yes |

## Hybrid track

- Setup: TurboQuant 4-bit dense HNSW (full-precision rescore) fused with server-side BM25 sparse vectors (qdrant/bm25, k1=0.9 b=0.4, average document length estimated on the first import batch, server IDF) via RRF
- Fusion: RRF (Query API fusion)

Retrieval quality vs human judgements:

| Dataset | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| beir/scifact/test | 0.7128 | 0.9577 | 0.6705 | 0.6745 |
| beir/nfcorpus/test | 0.3508 | 0.3235 | 0.1823 | 0.5691 |
| dbpedia-entities-openai-100k | n/a | n/a | n/a | n/a |
| dbpedia-entities-openai-1m | n/a | n/a | n/a | n/a |

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | On disk | Peak heap | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 1645 | 3.15 | n/a | 0.43 GB | 0.36 | 0.41 | 0.43 |
| beir/nfcorpus/test | 3633 | 1330 | 2.73 | n/a | 0.42 GB | 0.35 | 0.40 | 0.42 |
| dbpedia-entities-openai-100k | 100000 | 796 | 125.69 | n/a | 1.78 GB | 0.70 | 1.10 | 1.56 |
| dbpedia-entities-openai-1m | 995000 | 825 | 1205.40 | n/a | 2.43 GB | 2.52 | 5.07 | 6.31 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 1.51 | 1.64 | 1.73 |
| beir/nfcorpus/test | 1.51 | 1.63 | 1.74 |
| dbpedia-entities-openai-100k | 2.86 | 3.28 | 3.77 |
| dbpedia-entities-openai-1m | 4.70 | 7.28 | 8.51 |

Engine container memory through the whole track, load included (anonymous memory is the heap the kernel cannot reclaim; charged memory adds the page cache of the engine's files):

| Dataset | Peak anonymous | Peak charged | Samples |
| --- | --- | --- | --- |
| beir/scifact/test | 0.43 GB | 0.50 GB | 357 |
| beir/nfcorpus/test | 0.42 GB | 0.48 GB | 354 |
| dbpedia-entities-openai-100k | 1.78 GB | 7.62 GB | 729 |
| dbpedia-entities-openai-1m | 2.43 GB | 12.80 GB | 3467 |

Server-side time source per dataset:

- beir/scifact/test: top-level `time` field, seconds converted to ms (floating-millisecond resolution)
- beir/nfcorpus/test: top-level `time` field, seconds converted to ms (floating-millisecond resolution)
- dbpedia-entities-openai-100k: top-level `time` field, seconds converted to ms (floating-millisecond resolution)
- dbpedia-entities-openai-1m: top-level `time` field, seconds converted to ms (floating-millisecond resolution)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 650 | n/a | 0 | 1.63 | 3.17 | 0.56 | 1.0 | no |
| 2 | 1 | 1256 | n/a | 0 | 1.72 | 2.23 | 1.17 | 2.0 | no |
| 4 | 1 | 2349 | n/a | 0 | 1.86 | 2.40 | 2.39 | 4.0 | no |
| 8 | 3 | 3112 | 3050 to 3135 | 0 | 3.36 | 5.15 | 3.42 | 8.0 | yes |
| 16 | 1 | 2736 | n/a | 0 | 9.12 | 24.71 | 2.83 | 16.0 | yes |
| 32 | 1 | 2543 | n/a | 0 | 20.33 | 37.62 | 2.72 | 31.9 | yes |
| 64 | 1 | 2374 | n/a | 0 | 45.92 | 82.99 | 2.71 | 63.5 | yes |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 656 | n/a | 0 | 1.66 | 2.46 | 0.56 | 1.0 | no |
| 2 | 1 | 1258 | n/a | 0 | 1.71 | 3.03 | 1.18 | 2.0 | no |
| 4 | 1 | 2380 | n/a | 0 | 1.85 | 2.57 | 2.41 | 4.0 | no |
| 8 | 3 | 3125 | 3088 to 3151 | 0 | 3.31 | 5.04 | 3.24 | 8.0 | yes |
| 16 | 1 | 2751 | n/a | 0 | 9.08 | 25.52 | 2.81 | 16.0 | yes |
| 32 | 1 | 2538 | n/a | 0 | 20.17 | 40.04 | 2.58 | 31.9 | yes |
| 64 | 1 | 2387 | n/a | 0 | 45.64 | 86.09 | 2.41 | 63.5 | yes |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 348 | n/a | 0 | 3.01 | 3.28 | 0.63 | 1.0 | no |
| 2 | 1 | 672 | n/a | 0 | 3.20 | 4.46 | 1.35 | 2.0 | no |
| 4 | 1 | 1284 | n/a | 0 | 3.42 | 4.57 | 2.64 | 4.0 | no |
| 8 | 3 | 1710 | 1698 to 1770 | 0 | 5.74 | 10.33 | 3.77 | 8.0 | yes |
| 16 | 1 | 1575 | n/a | 0 | 16.01 | 94.97 | 3.66 | 16.0 | yes |
| 32 | 1 | 1523 | n/a | 0 | 34.07 | 111.43 | 3.53 | 31.8 | yes |
| 64 | 1 | 1448 | n/a | 0 | 76.05 | 156.52 | 3.40 | 63.2 | yes |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 264 | n/a | 0 | 4.50 | 4.92 | 1.13 | 1.0 | no |
| 2 | 1 | 503 | n/a | 0 | 4.60 | 5.53 | 2.32 | 2.0 | no |
| 4 | 1 | 880 | n/a | 0 | 5.92 | 7.24 | 4.23 | 4.0 | no |
| 8 | 1 | 1187 | n/a | 0 | 9.56 | 12.82 | 6.04 | 8.0 | no |
| 16 | 1 | 1299 | n/a | 0 | 18.56 | 26.13 | 6.74 | 15.7 | no |
| 32 | 1 | 1390 | n/a | 0 | 37.09 | 111.84 | 7.21 | 31.8 | no |
| 64 | 3 | 1475 | 1463 to 1481 | 0 | 66.46 | 157.37 | 7.47 | 63.1 | yes |
