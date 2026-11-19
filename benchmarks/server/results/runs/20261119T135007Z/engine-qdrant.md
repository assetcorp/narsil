# qdrant retrieval (vector, hybrid)

## Environment

- Captured: 2026-11-19T14:00:06.710504+00:00
- Load machine: GCP c3-standard-8, us-west4-a
- OS / arch: Linux 7.0.0-1017-gcp / x86_64 (containerized: True)
- CPU: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical)
- Memory: 33.6 GB
- Engine machine label: GCP c3-standard-8, us-west4-a
- Engine machine: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical), 33.6 GB
- Network round trip to the engine machine: p50 0.086 ms, p99 0.147 ms over 200 TCP connects
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
- Index setup: HNSW dense vectors, distance Cosine, over the shared precomputed vectors
- Operating point: search knob tuned to ann_recall@10 >= 0.99 against exact kNN over the same vectors

Retrieval quality vs human judgements:

| Dataset | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| beir/scifact/test | 0.6239 | 0.9227 | 0.5797 | 0.5849 |
| beir/nfcorpus/test | 0.3148 | 0.3094 | 0.1576 | 0.5189 |
| dbpedia-entities-openai-100k | n/a | n/a | n/a | n/a |
| dbpedia-entities-openai-1m | n/a | n/a | n/a | n/a |

Recall operating point (latency below is measured here, the matched-recall rule for ANN search):

| Dataset | Knob | Value | ANN recall@k | Target met | Secondary value | Secondary recall |
| --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | hnsw_ef | 32 | 0.9923 | yes | 16 | 0.9753 |
| beir/nfcorpus/test | hnsw_ef | 64 | 0.9935 | yes | 32 | 0.9786 |
| dbpedia-entities-openai-100k | hnsw_ef | 128 | 0.9946 | yes | 32 | 0.9717 |
| dbpedia-entities-openai-1m | hnsw_ef | 192 | 0.9927 | yes | 64 | 0.9755 |

Latency is measured at the operating point.

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | On disk | Peak heap | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 1528 | 3.39 | n/a | 0.33 GB | 0.21 | 0.24 | 0.27 |
| beir/nfcorpus/test | 3633 | 1274 | 2.85 | n/a | 0.35 GB | 0.25 | 0.28 | 0.30 |
| dbpedia-entities-openai-100k | 100000 | 798 | 125.28 | n/a | 1.04 GB | 1.39 | 1.84 | 2.31 |
| dbpedia-entities-openai-1m | 995000 | 817 | 1218.56 | n/a | 1.56 GB | 3.59 | 5.27 | 6.21 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 0.50 | 0.56 | 0.61 |
| beir/nfcorpus/test | 0.54 | 0.61 | 0.69 |
| dbpedia-entities-openai-100k | 1.82 | 2.28 | 2.75 |
| dbpedia-entities-openai-1m | 4.04 | 5.73 | 6.67 |

Engine container memory through the whole track, load included (anonymous memory is the heap the kernel cannot reclaim; charged memory adds the page cache of the engine's files):

| Dataset | Peak anonymous | Peak charged | Samples |
| --- | --- | --- | --- |
| beir/scifact/test | 0.33 GB | 0.41 GB | 599 |
| beir/nfcorpus/test | 0.35 GB | 0.41 GB | 651 |
| dbpedia-entities-openai-100k | 1.04 GB | 4.78 GB | 1579 |
| dbpedia-entities-openai-1m | 1.56 GB | 12.98 GB | 4543 |

Server-side time source per dataset:

- beir/scifact/test: top-level `time` field, seconds converted to ms (floating-millisecond resolution)
- beir/nfcorpus/test: top-level `time` field, seconds converted to ms (floating-millisecond resolution)
- dbpedia-entities-openai-100k: top-level `time` field, seconds converted to ms (floating-millisecond resolution)
- dbpedia-entities-openai-1m: top-level `time` field, seconds converted to ms (floating-millisecond resolution)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 2238 | n/a | 0 | 0.48 | 0.58 | 1.12 | 0.9 | no |
| 2 | 1 | 3598 | n/a | 0 | 0.58 | 0.68 | 2.28 | 1.9 | no |
| 4 | 1 | 5947 | n/a | 0 | 0.75 | 0.92 | 4.14 | 3.8 | no |
| 8 | 1 | 8424 | n/a | 0 | 1.24 | 1.83 | 5.97 | 7.6 | no |
| 16 | 1 | 9880 | n/a | 0 | 2.56 | 4.03 | 6.57 | 15.5 | no |
| 32 | 1 | 10920 | n/a | 0 | 5.14 | 8.53 | 6.79 | 31.5 | no |
| 64 | 1 | 11707 | n/a | 0 | 9.80 | 16.17 | 6.81 | 63.4 | no |
| 128 | 3 | 12585 | 12514 to 12588 | 0 | 17.79 | 28.52 | 6.91 | 127.1 | no |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 2061 | n/a | 0 | 0.51 | 0.59 | 1.21 | 0.9 | no |
| 2 | 1 | 3353 | n/a | 0 | 0.62 | 0.72 | 2.47 | 1.9 | no |
| 4 | 1 | 5479 | n/a | 0 | 0.82 | 1.02 | 4.35 | 3.8 | no |
| 8 | 1 | 7504 | n/a | 0 | 1.44 | 2.03 | 6.07 | 7.7 | no |
| 16 | 1 | 8705 | n/a | 0 | 2.95 | 4.57 | 6.68 | 15.6 | no |
| 32 | 1 | 9576 | n/a | 0 | 5.94 | 9.95 | 6.89 | 31.5 | no |
| 64 | 1 | 10362 | n/a | 0 | 11.03 | 18.25 | 6.96 | 63.4 | no |
| 128 | 3 | 10937 | 10928 to 10957 | 0 | 20.48 | 32.76 | 7.05 | 127.1 | no |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 611 | n/a | 0 | 2.04 | 2.90 | 1.75 | 1.0 | no |
| 2 | 1 | 913 | n/a | 0 | 2.87 | 3.29 | 3.56 | 2.0 | no |
| 4 | 1 | 1313 | n/a | 0 | 4.36 | 5.81 | 5.97 | 4.0 | no |
| 8 | 1 | 1442 | n/a | 0 | 8.97 | 13.03 | 6.91 | 7.9 | no |
| 16 | 1 | 1508 | n/a | 0 | 18.44 | 28.46 | 7.20 | 15.9 | no |
| 32 | 1 | 1478 | n/a | 0 | 33.60 | 57.75 | 7.62 | 31.8 | no |
| 64 | 1 | 1519 | n/a | 0 | 57.19 | 88.02 | 7.85 | 63.3 | no |
| 128 | 3 | 1525 | 1517 to 1536 | 0 | 96.93 | 137.20 | 7.89 | 125.5 | no |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 310 | n/a | 0 | 4.20 | 5.83 | 2.43 | 1.0 | no |
| 2 | 1 | 440 | n/a | 0 | 5.86 | 6.51 | 4.69 | 2.0 | no |
| 4 | 1 | 571 | n/a | 0 | 10.44 | 14.04 | 6.65 | 4.0 | no |
| 8 | 1 | 621 | n/a | 0 | 18.85 | 27.26 | 7.56 | 7.9 | no |
| 16 | 1 | 647 | n/a | 0 | 40.63 | 62.97 | 7.50 | 15.9 | no |
| 32 | 1 | 648 | n/a | 0 | 67.10 | 79.37 | 7.94 | 31.6 | no |
| 64 | 1 | 641 | n/a | 0 | 116.40 | 143.11 | 7.93 | 62.5 | no |
| 128 | 3 | 647 | 643 to 661 | 0 | 212.28 | 290.24 | 7.94 | 122.3 | no |

## Hybrid track

- Setup: Dense HNSW fused with server-side BM25 sparse vectors (qdrant/bm25, k1=0.9 b=0.4, average document length estimated on the first import batch, server IDF) via RRF
- Fusion: RRF (Query API fusion)

Retrieval quality vs human judgements:

| Dataset | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| beir/scifact/test | 0.7095 | 0.9577 | 0.6661 | 0.6700 |
| beir/nfcorpus/test | 0.3504 | 0.3236 | 0.1826 | 0.5703 |
| dbpedia-entities-openai-100k | n/a | n/a | n/a | n/a |
| dbpedia-entities-openai-1m | n/a | n/a | n/a | n/a |

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | On disk | Peak heap | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 1640 | 3.16 | n/a | 0.47 GB | 0.37 | 0.43 | 0.45 |
| beir/nfcorpus/test | 3633 | 1333 | 2.73 | n/a | 0.39 GB | 0.34 | 0.40 | 0.42 |
| dbpedia-entities-openai-100k | 100000 | 798 | 125.25 | n/a | 1.06 GB | 1.62 | 2.36 | 2.80 |
| dbpedia-entities-openai-1m | 995000 | 810 | 1228.98 | n/a | 1.47 GB | 4.86 | 7.70 | 8.87 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 0.77 | 0.84 | 0.89 |
| beir/nfcorpus/test | 0.73 | 0.82 | 0.86 |
| dbpedia-entities-openai-100k | 2.23 | 2.97 | 3.43 |
| dbpedia-entities-openai-1m | 5.50 | 8.37 | 9.52 |

Engine container memory through the whole track, load included (anonymous memory is the heap the kernel cannot reclaim; charged memory adds the page cache of the engine's files):

| Dataset | Peak anonymous | Peak charged | Samples |
| --- | --- | --- | --- |
| beir/scifact/test | 0.47 GB | 0.53 GB | 486 |
| beir/nfcorpus/test | 0.39 GB | 0.45 GB | 485 |
| dbpedia-entities-openai-100k | 1.06 GB | 5.79 GB | 1210 |
| dbpedia-entities-openai-1m | 1.47 GB | 11.69 GB | 3994 |

Server-side time source per dataset:

- beir/scifact/test: top-level `time` field, seconds converted to ms (floating-millisecond resolution)
- beir/nfcorpus/test: top-level `time` field, seconds converted to ms (floating-millisecond resolution)
- dbpedia-entities-openai-100k: top-level `time` field, seconds converted to ms (floating-millisecond resolution)
- dbpedia-entities-openai-1m: top-level `time` field, seconds converted to ms (floating-millisecond resolution)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 1458 | n/a | 0 | 0.73 | 1.19 | 1.10 | 1.0 | no |
| 2 | 1 | 2495 | n/a | 0 | 0.84 | 0.93 | 2.22 | 1.9 | no |
| 4 | 1 | 4313 | n/a | 0 | 1.03 | 1.25 | 4.20 | 3.8 | no |
| 8 | 1 | 6147 | n/a | 0 | 1.72 | 2.45 | 6.05 | 7.7 | no |
| 16 | 1 | 7148 | n/a | 0 | 3.45 | 5.25 | 6.70 | 15.7 | no |
| 32 | 1 | 7747 | n/a | 0 | 6.97 | 11.20 | 6.93 | 31.6 | no |
| 64 | 1 | 8290 | n/a | 0 | 13.28 | 20.61 | 6.97 | 63.5 | no |
| 128 | 3 | 8575 | 8521 to 8575 | 0 | 25.25 | 43.83 | 7.00 | 127.1 | no |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 1493 | n/a | 0 | 0.70 | 0.78 | 1.21 | 1.0 | no |
| 2 | 1 | 2570 | n/a | 0 | 0.82 | 0.94 | 2.50 | 1.9 | no |
| 4 | 1 | 4299 | n/a | 0 | 1.06 | 1.35 | 4.53 | 3.9 | no |
| 8 | 1 | 5789 | n/a | 0 | 1.86 | 2.57 | 6.21 | 7.8 | no |
| 16 | 1 | 6619 | n/a | 0 | 3.82 | 5.81 | 6.77 | 15.7 | no |
| 32 | 1 | 7145 | n/a | 0 | 7.66 | 12.40 | 6.98 | 31.7 | no |
| 64 | 1 | 7584 | n/a | 0 | 14.56 | 23.22 | 7.03 | 63.5 | no |
| 128 | 3 | 7866 | 7854 to 7870 | 0 | 27.48 | 46.84 | 7.06 | 127.1 | no |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 462 | n/a | 0 | 2.79 | 3.52 | 1.71 | 1.0 | no |
| 2 | 1 | 813 | n/a | 0 | 3.10 | 3.87 | 3.46 | 2.0 | no |
| 4 | 1 | 1179 | n/a | 0 | 4.74 | 6.41 | 5.83 | 4.0 | no |
| 8 | 1 | 1309 | n/a | 0 | 9.31 | 13.08 | 6.88 | 7.9 | no |
| 16 | 1 | 1311 | n/a | 0 | 20.08 | 30.25 | 7.17 | 15.9 | no |
| 32 | 1 | 1357 | n/a | 0 | 37.68 | 61.45 | 7.58 | 31.8 | no |
| 64 | 1 | 1376 | n/a | 0 | 71.55 | 115.94 | 7.70 | 63.3 | no |
| 128 | 3 | 1404 | 1389 to 1410 | 0 | 117.35 | 198.79 | 7.87 | 125.4 | no |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 227 | n/a | 0 | 6.23 | 7.05 | 2.33 | 1.0 | no |
| 2 | 1 | 388 | n/a | 0 | 6.66 | 7.36 | 4.59 | 2.0 | no |
| 4 | 1 | 510 | n/a | 0 | 11.64 | 15.33 | 6.53 | 4.0 | no |
| 8 | 1 | 557 | n/a | 0 | 21.35 | 32.21 | 7.38 | 7.9 | no |
| 16 | 1 | 586 | n/a | 0 | 42.59 | 71.76 | 7.56 | 15.9 | no |
| 32 | 1 | 579 | n/a | 0 | 75.74 | 129.58 | 7.88 | 31.6 | no |
| 64 | 1 | 595 | n/a | 0 | 130.92 | 193.24 | 7.94 | 62.3 | no |
| 128 | 3 | 599 | 592 to 599 | 0 | 227.97 | 299.75 | 7.93 | 121.8 | no |
