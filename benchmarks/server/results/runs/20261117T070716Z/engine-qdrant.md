# qdrant retrieval (vector, hybrid)

## Environment

- Captured: 2026-11-17T07:57:33.389110+00:00
- Load machine: GCP c3-standard-8, us-west4-a
- OS / arch: Linux 7.0.0-1017-gcp / x86_64 (containerized: True)
- CPU: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical)
- Memory: 33.6 GB
- Engine machine label: GCP c3-standard-8, us-west4-a
- Engine machine: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical), 33.6 GB
- Network round trip to the engine machine: p50 0.088 ms, p99 0.173 ms over 200 TCP connects
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
| beir/nfcorpus/test | 0.3149 | 0.3094 | 0.1576 | 0.5189 |
| dbpedia-entities-openai-100k | n/a | n/a | n/a | n/a |
| dbpedia-entities-openai-1m | n/a | n/a | n/a | n/a |

Recall operating point (latency below is measured here, the matched-recall rule for ANN search):

| Dataset | Knob | Value | ANN recall@k | Target met | Secondary value | Secondary recall |
| --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | hnsw_ef | 32 | 0.9917 | yes | 16 | 0.9747 |
| beir/nfcorpus/test | hnsw_ef | 128 | 0.9960 | yes | 32 | 0.9669 |
| dbpedia-entities-openai-100k | hnsw_ef | 128 | 0.9940 | yes | 32 | 0.9723 |
| dbpedia-entities-openai-1m | hnsw_ef | 192 | 0.9927 | yes | 64 | 0.9764 |

Latency is measured at the operating point.

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | On disk | Peak heap | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 1478 | 3.51 | n/a | 0.34 GB | 0.24 | 0.28 | 0.30 |
| beir/nfcorpus/test | 3633 | 1266 | 2.87 | n/a | 0.35 GB | 0.39 | 0.47 | 0.50 |
| dbpedia-entities-openai-100k | 100000 | 796 | 125.58 | n/a | 1.12 GB | 1.49 | 1.95 | 2.43 |
| dbpedia-entities-openai-1m | 995000 | 806 | 1234.82 | n/a | 1.52 GB | 3.90 | 5.60 | 6.49 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 1.28 | 1.42 | 1.50 |
| beir/nfcorpus/test | 1.46 | 1.63 | 1.73 |
| dbpedia-entities-openai-100k | 3.49 | 3.98 | 4.49 |
| dbpedia-entities-openai-1m | 5.95 | 7.68 | 8.55 |

Engine container memory through the whole track, load included (anonymous memory is the heap the kernel cannot reclaim; charged memory adds the page cache of the engine's files):

| Dataset | Peak anonymous | Peak charged | Samples |
| --- | --- | --- | --- |
| beir/scifact/test | 0.34 GB | 0.42 GB | 440 |
| beir/nfcorpus/test | 0.35 GB | 0.41 GB | 518 |
| dbpedia-entities-openai-100k | 1.12 GB | 5.37 GB | 927 |
| dbpedia-entities-openai-1m | 1.52 GB | 12.71 GB | 3868 |

Server-side time source per dataset:

- beir/scifact/test: top-level `time` field, seconds converted to ms (floating-millisecond resolution)
- beir/nfcorpus/test: top-level `time` field, seconds converted to ms (floating-millisecond resolution)
- dbpedia-entities-openai-100k: top-level `time` field, seconds converted to ms (floating-millisecond resolution)
- dbpedia-entities-openai-1m: top-level `time` field, seconds converted to ms (floating-millisecond resolution)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 759 | n/a | 0 | 1.43 | 1.66 | 0.48 | 1.0 | no |
| 2 | 1 | 1437 | n/a | 0 | 1.50 | 1.73 | 1.01 | 2.0 | no |
| 4 | 1 | 2697 | n/a | 0 | 1.65 | 2.17 | 2.04 | 4.0 | no |
| 8 | 3 | 3070 | 3030 to 3077 | 0 | 3.35 | 4.85 | 2.43 | 8.0 | yes |
| 16 | 1 | 2779 | n/a | 0 | 8.96 | 27.40 | 2.19 | 16.0 | yes |
| 32 | 1 | 2564 | n/a | 0 | 20.06 | 39.03 | 2.04 | 31.9 | yes |
| 64 | 1 | 2404 | n/a | 0 | 45.26 | 78.11 | 2.09 | 63.5 | yes |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 672 | n/a | 0 | 1.61 | 2.07 | 0.60 | 1.0 | no |
| 2 | 1 | 1313 | n/a | 0 | 1.66 | 2.14 | 1.21 | 2.0 | no |
| 4 | 1 | 2434 | n/a | 0 | 1.93 | 2.42 | 2.44 | 4.0 | no |
| 8 | 3 | 3159 | 3101 to 3222 | 0 | 3.39 | 5.00 | 3.24 | 8.0 | yes |
| 16 | 1 | 2765 | n/a | 0 | 8.98 | 25.89 | 2.94 | 16.0 | yes |
| 32 | 1 | 2545 | n/a | 0 | 20.11 | 39.43 | 2.74 | 31.9 | yes |
| 64 | 1 | 2438 | n/a | 0 | 45.55 | 85.58 | 2.56 | 63.5 | yes |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 280 | n/a | 0 | 4.39 | 5.05 | 1.03 | 1.0 | no |
| 2 | 1 | 518 | n/a | 0 | 4.52 | 5.14 | 2.13 | 2.0 | no |
| 4 | 1 | 926 | n/a | 0 | 5.29 | 6.49 | 3.94 | 4.0 | no |
| 8 | 1 | 1189 | n/a | 0 | 9.60 | 12.87 | 5.94 | 8.0 | no |
| 16 | 1 | 1286 | n/a | 0 | 19.26 | 26.48 | 6.77 | 15.7 | no |
| 32 | 1 | 1396 | n/a | 0 | 35.46 | 112.72 | 7.33 | 31.8 | no |
| 64 | 3 | 1408 | 1407 to 1409 | 0 | 70.63 | 156.72 | 7.54 | 63.2 | yes |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 184 | n/a | 0 | 7.13 | 7.85 | 1.65 | 1.0 | no |
| 2 | 1 | 339 | n/a | 0 | 7.33 | 8.31 | 3.32 | 2.0 | no |
| 4 | 1 | 518 | n/a | 0 | 10.76 | 14.38 | 5.51 | 4.0 | no |
| 8 | 1 | 613 | n/a | 0 | 19.38 | 26.86 | 6.80 | 8.0 | no |
| 16 | 1 | 636 | n/a | 0 | 37.72 | 62.91 | 7.64 | 15.9 | no |
| 32 | 1 | 646 | n/a | 0 | 71.26 | 118.48 | 7.83 | 31.6 | no |
| 64 | 3 | 657 | 651 to 659 | 0 | 122.33 | 150.07 | 7.79 | 62.4 | no |

## Hybrid track

- Setup: Dense HNSW fused with server-side BM25 sparse vectors (qdrant/bm25, k1=0.9 b=0.4, average document length estimated on the first import batch, server IDF) via RRF
- Fusion: RRF (Query API fusion)

Retrieval quality vs human judgements:

| Dataset | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| beir/scifact/test | 0.7165 | 0.9577 | 0.6755 | 0.6796 |
| beir/nfcorpus/test | 0.3509 | 0.3235 | 0.1823 | 0.5672 |
| dbpedia-entities-openai-100k | n/a | n/a | n/a | n/a |
| dbpedia-entities-openai-1m | n/a | n/a | n/a | n/a |

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | On disk | Peak heap | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 1644 | 3.15 | n/a | 0.45 GB | 0.43 | 0.50 | 0.52 |
| beir/nfcorpus/test | 3633 | 1362 | 2.67 | n/a | 0.37 GB | 0.53 | 0.61 | 0.65 |
| dbpedia-entities-openai-100k | 100000 | 801 | 124.78 | n/a | 1.01 GB | 1.72 | 2.55 | 2.94 |
| dbpedia-entities-openai-1m | 995000 | 814 | 1221.70 | n/a | 1.70 GB | 4.87 | 7.68 | 8.92 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 1.59 | 1.74 | 1.85 |
| beir/nfcorpus/test | 1.69 | 1.83 | 1.95 |
| dbpedia-entities-openai-100k | 3.89 | 4.73 | 5.15 |
| dbpedia-entities-openai-1m | 7.06 | 9.88 | 11.10 |

Engine container memory through the whole track, load included (anonymous memory is the heap the kernel cannot reclaim; charged memory adds the page cache of the engine's files):

| Dataset | Peak anonymous | Peak charged | Samples |
| --- | --- | --- | --- |
| beir/scifact/test | 0.45 GB | 0.54 GB | 357 |
| beir/nfcorpus/test | 0.37 GB | 0.41 GB | 356 |
| dbpedia-entities-openai-100k | 1.01 GB | 5.31 GB | 747 |
| dbpedia-entities-openai-1m | 1.70 GB | 12.58 GB | 3465 |

Server-side time source per dataset:

- beir/scifact/test: top-level `time` field, seconds converted to ms (floating-millisecond resolution)
- beir/nfcorpus/test: top-level `time` field, seconds converted to ms (floating-millisecond resolution)
- dbpedia-entities-openai-100k: top-level `time` field, seconds converted to ms (floating-millisecond resolution)
- dbpedia-entities-openai-1m: top-level `time` field, seconds converted to ms (floating-millisecond resolution)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 630 | n/a | 0 | 1.70 | 3.66 | 0.65 | 1.0 | no |
| 2 | 1 | 1210 | n/a | 0 | 1.79 | 2.66 | 1.28 | 2.0 | no |
| 4 | 1 | 2262 | n/a | 0 | 1.95 | 2.62 | 2.57 | 4.0 | no |
| 8 | 3 | 3068 | 3045 to 3151 | 0 | 3.34 | 5.20 | 3.72 | 8.0 | yes |
| 16 | 1 | 2736 | n/a | 0 | 9.17 | 25.89 | 3.24 | 16.0 | yes |
| 32 | 1 | 2543 | n/a | 0 | 20.10 | 35.88 | 3.03 | 31.9 | yes |
| 64 | 1 | 2395 | n/a | 0 | 46.05 | 82.59 | 2.87 | 63.5 | yes |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 579 | n/a | 0 | 1.85 | 2.70 | 0.71 | 1.0 | no |
| 2 | 1 | 1137 | n/a | 0 | 1.89 | 4.52 | 1.37 | 2.0 | no |
| 4 | 1 | 2158 | n/a | 0 | 2.08 | 2.74 | 2.76 | 4.0 | no |
| 8 | 3 | 3032 | 3025 to 3043 | 0 | 3.36 | 5.34 | 4.00 | 8.0 | yes |
| 16 | 1 | 2738 | n/a | 0 | 9.08 | 26.24 | 3.61 | 16.0 | yes |
| 32 | 1 | 2553 | n/a | 0 | 19.67 | 36.16 | 3.39 | 31.9 | yes |
| 64 | 1 | 2394 | n/a | 0 | 45.80 | 84.38 | 3.19 | 63.5 | yes |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 259 | n/a | 0 | 4.59 | 5.21 | 1.04 | 1.0 | no |
| 2 | 1 | 484 | n/a | 0 | 4.82 | 6.02 | 2.13 | 2.0 | no |
| 4 | 1 | 860 | n/a | 0 | 5.71 | 6.87 | 3.96 | 4.0 | no |
| 8 | 1 | 1112 | n/a | 0 | 10.01 | 13.17 | 6.09 | 8.0 | no |
| 16 | 1 | 1212 | n/a | 0 | 19.97 | 26.37 | 6.97 | 15.9 | no |
| 32 | 1 | 1285 | n/a | 0 | 37.09 | 99.16 | 7.46 | 31.4 | no |
| 64 | 3 | 1291 | 1281 to 1295 | 0 | 76.34 | 159.39 | 7.56 | 62.9 | no |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 163 | n/a | 0 | 7.85 | 8.84 | 1.72 | 1.0 | no |
| 2 | 1 | 301 | n/a | 0 | 8.03 | 9.04 | 3.46 | 2.0 | no |
| 4 | 1 | 457 | n/a | 0 | 11.98 | 15.90 | 5.74 | 4.0 | no |
| 8 | 1 | 538 | n/a | 0 | 21.89 | 28.20 | 7.04 | 8.0 | no |
| 16 | 1 | 571 | n/a | 0 | 41.07 | 68.63 | 7.62 | 15.9 | no |
| 32 | 1 | 590 | n/a | 0 | 81.41 | 148.63 | 7.65 | 31.6 | no |
| 64 | 3 | 602 | 601 to 603 | 0 | 133.36 | 185.63 | 7.93 | 62.2 | no |
