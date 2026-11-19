# qdrant retrieval (vector, hybrid, best-config vector profile)

## Environment

- Captured: 2026-11-19T15:14:34.520253+00:00
- Load machine: GCP c3-standard-8, us-west4-a
- OS / arch: Linux 7.0.0-1017-gcp / x86_64 (containerized: True)
- CPU: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical)
- Memory: 33.6 GB
- Engine machine label: GCP c3-standard-8, us-west4-a
- Engine machine: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical), 33.6 GB
- Network round trip to the engine machine: p50 0.084 ms, p99 0.144 ms over 200 TCP connects
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
| beir/nfcorpus/test | 0.3148 | 0.3094 | 0.1575 | 0.5189 |
| dbpedia-entities-openai-100k | n/a | n/a | n/a | n/a |
| dbpedia-entities-openai-1m | n/a | n/a | n/a | n/a |

Recall operating point (latency below is measured here, the matched-recall rule for ANN search):

| Dataset | Knob | Value | ANN recall@k | Target met | Secondary value | Secondary recall |
| --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | hnsw_ef | 32 | 0.9953 | yes | 16 | 0.9833 |
| beir/nfcorpus/test | hnsw_ef | 64 | 0.9932 | yes | 32 | 0.9752 |
| dbpedia-entities-openai-100k | hnsw_ef | 128 | 0.9933 | yes | 32 | 0.9684 |
| dbpedia-entities-openai-1m | hnsw_ef | 160 | 0.9918 | yes | 64 | 0.9718 |

Latency is measured at the operating point.

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | On disk | Peak heap | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 1495 | 3.47 | n/a | 0.60 GB | 0.19 | 0.22 | 0.23 |
| beir/nfcorpus/test | 3633 | 1331 | 2.73 | n/a | 0.42 GB | 0.21 | 0.24 | 0.26 |
| dbpedia-entities-openai-100k | 100000 | 813 | 123.01 | n/a | 1.80 GB | 0.45 | 0.64 | 1.03 |
| dbpedia-entities-openai-1m | 995000 | 824 | 1207.68 | n/a | 2.48 GB | 1.61 | 2.98 | 3.60 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 0.47 | 0.52 | 0.56 |
| beir/nfcorpus/test | 0.50 | 0.55 | 0.59 |
| dbpedia-entities-openai-100k | 0.85 | 1.08 | 1.48 |
| dbpedia-entities-openai-1m | 2.04 | 3.42 | 4.06 |

Engine container memory through the whole track, load included (anonymous memory is the heap the kernel cannot reclaim; charged memory adds the page cache of the engine's files):

| Dataset | Peak anonymous | Peak charged | Samples |
| --- | --- | --- | --- |
| beir/scifact/test | 0.60 GB | 0.74 GB | 592 |
| beir/nfcorpus/test | 0.42 GB | 0.54 GB | 645 |
| dbpedia-entities-openai-100k | 1.80 GB | 7.65 GB | 1579 |
| dbpedia-entities-openai-1m | 2.48 GB | 13.30 GB | 4467 |

Server-side time source per dataset:

- beir/scifact/test: top-level `time` field, seconds converted to ms (floating-millisecond resolution)
- beir/nfcorpus/test: top-level `time` field, seconds converted to ms (floating-millisecond resolution)
- dbpedia-entities-openai-100k: top-level `time` field, seconds converted to ms (floating-millisecond resolution)
- dbpedia-entities-openai-1m: top-level `time` field, seconds converted to ms (floating-millisecond resolution)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 2334 | n/a | 0 | 0.45 | 0.55 | 1.03 | 0.9 | no |
| 2 | 1 | 3926 | n/a | 0 | 0.54 | 0.60 | 2.19 | 1.9 | no |
| 4 | 1 | 6344 | n/a | 0 | 0.69 | 0.82 | 3.97 | 3.8 | no |
| 8 | 1 | 9305 | n/a | 0 | 1.10 | 1.57 | 5.89 | 7.6 | no |
| 16 | 1 | 11132 | n/a | 0 | 2.27 | 3.58 | 6.54 | 15.5 | no |
| 32 | 1 | 12402 | n/a | 0 | 4.53 | 7.70 | 6.74 | 31.4 | no |
| 64 | 1 | 13529 | n/a | 0 | 8.35 | 13.36 | 6.79 | 63.3 | no |
| 128 | 3 | 14400 | 14381 to 14497 | 0 | 15.41 | 24.58 | 6.87 | 127.0 | no |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 2257 | n/a | 0 | 0.46 | 0.54 | 1.12 | 0.9 | no |
| 2 | 1 | 3738 | n/a | 0 | 0.57 | 0.64 | 2.36 | 1.9 | no |
| 4 | 1 | 5967 | n/a | 0 | 0.74 | 0.92 | 4.18 | 3.8 | no |
| 8 | 1 | 8504 | n/a | 0 | 1.23 | 1.73 | 6.01 | 7.6 | no |
| 16 | 1 | 10009 | n/a | 0 | 2.53 | 3.98 | 6.62 | 15.6 | no |
| 32 | 1 | 11125 | n/a | 0 | 5.12 | 8.76 | 6.85 | 31.5 | no |
| 64 | 1 | 12031 | n/a | 0 | 9.48 | 15.24 | 6.88 | 63.3 | no |
| 128 | 3 | 12855 | 12847 to 12877 | 0 | 17.30 | 27.96 | 6.96 | 127.0 | no |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 1251 | n/a | 0 | 0.91 | 1.06 | 1.48 | 1.0 | no |
| 2 | 1 | 1951 | n/a | 0 | 1.12 | 1.30 | 2.96 | 1.9 | no |
| 4 | 1 | 3086 | n/a | 0 | 1.64 | 2.18 | 5.16 | 3.9 | no |
| 8 | 1 | 3728 | n/a | 0 | 3.20 | 4.81 | 6.47 | 7.8 | no |
| 16 | 1 | 3934 | n/a | 0 | 6.74 | 10.33 | 6.98 | 15.8 | no |
| 32 | 1 | 4223 | n/a | 0 | 13.54 | 21.47 | 7.13 | 31.8 | no |
| 64 | 1 | 4555 | n/a | 0 | 24.32 | 41.61 | 7.44 | 63.6 | no |
| 128 | 3 | 4648 | 4600 to 4666 | 0 | 41.59 | 77.14 | 7.66 | 127.0 | no |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 858 | n/a | 0 | 1.38 | 1.77 | 1.90 | 1.0 | no |
| 2 | 1 | 1280 | n/a | 0 | 1.84 | 2.14 | 3.78 | 2.0 | no |
| 4 | 1 | 1822 | n/a | 0 | 3.12 | 4.25 | 5.88 | 3.9 | no |
| 8 | 1 | 2014 | n/a | 0 | 6.31 | 9.58 | 6.81 | 7.9 | no |
| 16 | 1 | 2133 | n/a | 0 | 12.62 | 20.97 | 7.23 | 15.9 | no |
| 32 | 1 | 2221 | n/a | 0 | 24.64 | 41.28 | 7.54 | 31.8 | no |
| 64 | 1 | 2416 | n/a | 0 | 42.27 | 70.83 | 7.65 | 63.5 | no |
| 128 | 3 | 2596 | 2566 to 2636 | 2 (0.0%) | 57.11 | 107.77 | 7.84 | 126.6 | no |

## Hybrid track

- Setup: TurboQuant 4-bit dense HNSW (full-precision rescore) fused with server-side BM25 sparse vectors (qdrant/bm25, k1=0.9 b=0.4, average document length estimated on the first import batch, server IDF) via RRF
- Fusion: RRF (Query API fusion)

Retrieval quality vs human judgements:

| Dataset | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| beir/scifact/test | 0.7157 | 0.9577 | 0.6744 | 0.6784 |
| beir/nfcorpus/test | 0.3504 | 0.3236 | 0.1824 | 0.5662 |
| dbpedia-entities-openai-100k | n/a | n/a | n/a | n/a |
| dbpedia-entities-openai-1m | n/a | n/a | n/a | n/a |

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | On disk | Peak heap | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 1662 | 3.12 | n/a | 0.54 GB | 0.34 | 0.39 | 0.42 |
| beir/nfcorpus/test | 3633 | 1331 | 2.73 | n/a | 0.44 GB | 0.31 | 0.36 | 0.38 |
| dbpedia-entities-openai-100k | 100000 | 823 | 121.44 | n/a | 1.71 GB | 0.66 | 0.94 | 1.34 |
| dbpedia-entities-openai-1m | 995000 | 822 | 1210.72 | n/a | 2.54 GB | 2.31 | 4.54 | 5.51 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 0.72 | 0.79 | 0.83 |
| beir/nfcorpus/test | 0.69 | 0.75 | 0.79 |
| dbpedia-entities-openai-100k | 1.26 | 1.54 | 1.95 |
| dbpedia-entities-openai-1m | 2.97 | 5.19 | 6.17 |

Engine container memory through the whole track, load included (anonymous memory is the heap the kernel cannot reclaim; charged memory adds the page cache of the engine's files):

| Dataset | Peak anonymous | Peak charged | Samples |
| --- | --- | --- | --- |
| beir/scifact/test | 0.54 GB | 0.65 GB | 487 |
| beir/nfcorpus/test | 0.44 GB | 0.53 GB | 486 |
| dbpedia-entities-openai-100k | 1.71 GB | 7.45 GB | 1180 |
| dbpedia-entities-openai-1m | 2.54 GB | 13.56 GB | 3887 |

Server-side time source per dataset:

- beir/scifact/test: top-level `time` field, seconds converted to ms (floating-millisecond resolution)
- beir/nfcorpus/test: top-level `time` field, seconds converted to ms (floating-millisecond resolution)
- dbpedia-entities-openai-100k: top-level `time` field, seconds converted to ms (floating-millisecond resolution)
- dbpedia-entities-openai-1m: top-level `time` field, seconds converted to ms (floating-millisecond resolution)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 1477 | n/a | 0 | 0.70 | 0.77 | 1.07 | 0.9 | no |
| 2 | 1 | 2649 | n/a | 0 | 0.79 | 0.94 | 2.28 | 1.9 | no |
| 4 | 1 | 4503 | n/a | 0 | 0.98 | 1.19 | 4.24 | 3.9 | no |
| 8 | 1 | 6386 | n/a | 0 | 1.64 | 2.31 | 6.11 | 7.7 | no |
| 16 | 1 | 7467 | n/a | 0 | 3.34 | 5.26 | 6.73 | 15.7 | no |
| 32 | 1 | 8097 | n/a | 0 | 6.70 | 10.61 | 6.94 | 31.6 | no |
| 64 | 1 | 8659 | n/a | 0 | 12.69 | 19.94 | 6.97 | 63.5 | no |
| 128 | 3 | 8973 | 8956 to 8974 | 0 | 24.04 | 40.84 | 7.00 | 127.1 | no |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 1561 | n/a | 0 | 0.68 | 0.76 | 1.16 | 1.0 | no |
| 2 | 1 | 2705 | n/a | 0 | 0.78 | 0.88 | 2.37 | 1.9 | no |
| 4 | 1 | 4526 | n/a | 0 | 1.00 | 1.55 | 4.36 | 3.8 | no |
| 8 | 1 | 6317 | n/a | 0 | 1.69 | 2.35 | 6.16 | 7.7 | no |
| 16 | 1 | 7318 | n/a | 0 | 3.44 | 5.33 | 6.77 | 15.7 | no |
| 32 | 1 | 7911 | n/a | 0 | 6.90 | 10.98 | 6.96 | 31.6 | no |
| 64 | 1 | 8449 | n/a | 0 | 12.95 | 20.29 | 6.96 | 63.5 | no |
| 128 | 3 | 8783 | 8782 to 8784 | 0 | 24.69 | 41.93 | 7.03 | 127.1 | no |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 828 | n/a | 0 | 1.33 | 1.53 | 1.41 | 1.0 | no |
| 2 | 1 | 1449 | n/a | 0 | 1.52 | 1.88 | 2.87 | 2.0 | no |
| 4 | 1 | 2379 | n/a | 0 | 2.07 | 2.73 | 5.10 | 3.9 | no |
| 8 | 1 | 2859 | n/a | 0 | 4.01 | 5.72 | 6.47 | 7.9 | no |
| 16 | 1 | 3164 | n/a | 0 | 7.93 | 12.00 | 7.01 | 15.9 | no |
| 32 | 1 | 3356 | n/a | 0 | 16.20 | 25.62 | 7.19 | 31.8 | no |
| 64 | 1 | 3469 | n/a | 0 | 30.41 | 48.29 | 7.45 | 63.6 | no |
| 128 | 3 | 3606 | 3512 to 3616 | 0 | 54.45 | 85.97 | 7.65 | 126.9 | no |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 481 | n/a | 0 | 2.71 | 3.49 | 1.94 | 1.0 | no |
| 2 | 1 | 865 | n/a | 0 | 2.90 | 3.66 | 3.85 | 2.0 | no |
| 4 | 1 | 1290 | n/a | 0 | 4.51 | 6.32 | 5.98 | 4.0 | no |
| 8 | 1 | 1364 | n/a | 0 | 9.04 | 13.21 | 6.90 | 7.9 | no |
| 16 | 1 | 1491 | n/a | 0 | 17.18 | 27.52 | 7.44 | 15.9 | no |
| 32 | 1 | 1533 | n/a | 0 | 34.85 | 55.99 | 7.53 | 31.8 | no |
| 64 | 1 | 1562 | n/a | 0 | 63.81 | 105.46 | 7.73 | 63.3 | no |
| 128 | 3 | 1598 | 1575 to 1625 | 0 | 101.82 | 188.85 | 7.85 | 125.8 | no |
