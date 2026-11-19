# weaviate retrieval (vector, hybrid)

## Environment

- Captured: 2026-11-19T14:00:08.384823+00:00
- Load machine: GCP c3-standard-8, us-west3-b
- OS / arch: Linux 7.0.0-1017-gcp / x86_64 (containerized: True)
- CPU: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical)
- Memory: 33.6 GB
- Engine machine label: GCP c3-standard-8, us-west3-b
- Engine machine: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical), 33.6 GB
- Network round trip to the engine machine: p50 0.078 ms, p99 0.132 ms over 200 TCP connects
- Memory cap per engine: 21.5 GB
- Tracks: vector, hybrid
- Keyword setup: None
- Run depth: 1000; run tag: weaviate
- Engine build: version 1.40.5
- Engine image: cr.weaviate.io/semitechnologies/weaviate@sha256:fe848a3830c8a96fc598c903e39bbaa84a84553e30362663c313643a0febe32a
- Dataset beir/scifact/test: content md5 5f7d1de60b170fc8027bb7898e2efca1
- Dataset beir/nfcorpus/test: content md5 a89dba18a62ef92f7d323ec890a0d38d

## Vector track

- Embedding model: sentence-transformers/all-MiniLM-L6-v2 (384 dim, cosine)
- Index setup: HNSW dense vectors, distance cosine, over the shared precomputed vectors
- Operating point: search knob tuned to ann_recall@10 >= 0.99 against exact kNN over the same vectors

Retrieval quality vs human judgements:

| Dataset | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| beir/scifact/test | 0.6239 | 0.9227 | 0.5797 | 0.5849 |
| beir/nfcorpus/test | 0.3148 | 0.3094 | 0.1576 | 0.5179 |
| dbpedia-entities-openai-100k | n/a | n/a | n/a | n/a |
| dbpedia-entities-openai-1m | n/a | n/a | n/a | n/a |

Recall operating point (latency below is measured here, the matched-recall rule for ANN search):

| Dataset | Knob | Value | ANN recall@k | Target met | Secondary value | Secondary recall |
| --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | ef | 64 | 0.9967 | yes | 32 | 0.9820 |
| beir/nfcorpus/test | ef | 160 | 0.9932 | yes | 64 | 0.9700 |
| dbpedia-entities-openai-100k | ef | 160 | 0.9917 | yes | 32 | 0.9500 |
| dbpedia-entities-openai-1m | ef | 416 | 0.9927 | yes | 64 | 0.9547 |

Latency is measured at the operating point.

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | On disk | Peak heap | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 1673 | 3.10 | n/a | 0.33 GB | n/a | n/a | n/a |
| beir/nfcorpus/test | 3633 | 1379 | 2.63 | n/a | 0.27 GB | n/a | n/a | n/a |
| dbpedia-entities-openai-100k | 100000 | 656 | 152.45 | n/a | 3.00 GB | n/a | n/a | n/a |
| dbpedia-entities-openai-1m | 995000 | 668 | 1489.98 | n/a | 15.15 GB | n/a | n/a | n/a |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 2.29 | 3.19 | 4.81 |
| beir/nfcorpus/test | 2.40 | 3.30 | 5.33 |
| dbpedia-entities-openai-100k | 7.30 | 7.77 | 10.77 |
| dbpedia-entities-openai-1m | 10.86 | 12.45 | 13.37 |

Engine container memory through the whole track, load included (anonymous memory is the heap the kernel cannot reclaim; charged memory adds the page cache of the engine's files):

| Dataset | Peak anonymous | Peak charged | Samples |
| --- | --- | --- | --- |
| beir/scifact/test | 0.33 GB | 0.40 GB | 666 |
| beir/nfcorpus/test | 0.27 GB | 0.35 GB | 785 |
| dbpedia-entities-openai-100k | 3.00 GB | 3.98 GB | 1954 |
| dbpedia-entities-openai-1m | 15.15 GB | 21.47 GB | 7453 |

Server-side time source per dataset:

- beir/scifact/test: client round-trip only (no server-side query time exposed)
- beir/nfcorpus/test: client round-trip only (no server-side query time exposed)
- dbpedia-entities-openai-100k: client round-trip only (no server-side query time exposed)
- dbpedia-entities-openai-1m: client round-trip only (no server-side query time exposed)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 430 | n/a | 0 | 3.00 | 6.82 | 1.43 | 1.0 | no |
| 2 | 1 | 781 | n/a | 0 | 4.31 | 5.98 | 2.65 | 2.0 | no |
| 4 | 1 | 1251 | n/a | 0 | 5.39 | 6.68 | 4.82 | 4.0 | no |
| 8 | 1 | 1720 | n/a | 0 | 7.65 | 12.08 | 7.45 | 7.9 | no |
| 16 | 3 | 1788 | 1788 to 1791 | 0 | 18.03 | 32.20 | 7.86 | 15.9 | no |
| 32 | 1 | 1762 | n/a | 0 | 38.76 | 76.29 | 7.83 | 31.8 | no |
| 64 | 1 | 1749 | n/a | 0 | 83.44 | 208.06 | 7.85 | 63.3 | no |
| 128 | 1 | 1726 | n/a | 0 | 167.74 | 323.96 | 7.88 | 125.5 | no |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 410 | n/a | 0 | 3.17 | 5.39 | 1.37 | 1.0 | no |
| 2 | 1 | 736 | n/a | 0 | 4.69 | 6.12 | 2.59 | 2.0 | no |
| 4 | 1 | 1188 | n/a | 0 | 5.58 | 7.08 | 4.82 | 4.0 | no |
| 8 | 1 | 1623 | n/a | 0 | 8.18 | 12.46 | 7.44 | 7.9 | no |
| 16 | 3 | 1684 | 1681 to 1689 | 0 | 19.27 | 34.26 | 7.86 | 15.9 | no |
| 32 | 1 | 1670 | n/a | 0 | 39.85 | 77.99 | 7.84 | 31.8 | no |
| 64 | 1 | 1654 | n/a | 0 | 88.79 | 209.82 | 7.85 | 63.2 | no |
| 128 | 1 | 1634 | n/a | 0 | 209.34 | 537.13 | 7.86 | 124.7 | no |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 137 | n/a | 0 | 7.71 | 12.09 | 1.10 | 1.0 | no |
| 2 | 1 | 257 | n/a | 0 | 11.27 | 14.00 | 2.17 | 2.0 | no |
| 4 | 1 | 434 | n/a | 0 | 11.83 | 16.53 | 4.29 | 4.0 | no |
| 8 | 1 | 615 | n/a | 0 | 17.89 | 29.54 | 7.59 | 7.9 | no |
| 16 | 3 | 616 | 615 to 617 | 0 | 55.48 | 105.88 | 7.76 | 15.9 | no |
| 32 | 1 | 599 | n/a | 0 | 99.51 | 220.93 | 7.72 | 31.6 | no |
| 64 | 1 | 592 | n/a | 0 | 186.23 | 437.06 | 7.70 | 62.4 | no |
| 128 | 1 | 573 | n/a | 0 | 518.62 | 857.54 | 7.70 | 120.9 | no |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 99 | n/a | 0 | 11.55 | 33.33 | 1.09 | 1.0 | no |
| 2 | 1 | 193 | n/a | 0 | 14.64 | 17.53 | 2.00 | 2.0 | no |
| 4 | 1 | 332 | n/a | 0 | 16.46 | 25.03 | 4.16 | 4.0 | no |
| 8 | 3 | 476 | 476 to 480 | 0 | 22.22 | 45.22 | 7.58 | 7.9 | no |
| 16 | 1 | 467 | n/a | 0 | 70.92 | 166.05 | 7.64 | 15.9 | no |
| 32 | 1 | 447 | n/a | 0 | 110.80 | 303.19 | 7.60 | 31.4 | no |
| 64 | 1 | 446 | n/a | 0 | 227.16 | 377.24 | 7.63 | 61.8 | no |
| 128 | 1 | 439 | n/a | 0 | 508.83 | 1183.92 | 7.63 | 120.1 | no |

## Hybrid track

- Setup: BM25 k1=0.9 b=0.4 over text fused with dense vectors via the hybrid operator (rankedFusion, alpha=0.5)
- Fusion: rankedFusion (alpha=0.5)

Retrieval quality vs human judgements:

| Dataset | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| beir/scifact/test | 0.6840 | 0.9577 | 0.6366 | 0.6460 |
| beir/nfcorpus/test | 0.3428 | 0.3195 | 0.1810 | 0.5548 |
| dbpedia-entities-openai-100k | n/a | n/a | n/a | n/a |
| dbpedia-entities-openai-1m | n/a | n/a | n/a | n/a |

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | On disk | Peak heap | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 1652 | 3.14 | n/a | 0.36 GB | n/a | n/a | n/a |
| beir/nfcorpus/test | 3633 | 1441 | 2.52 | n/a | 0.30 GB | n/a | n/a | n/a |
| dbpedia-entities-openai-100k | 100000 | 662 | 151.08 | n/a | 3.10 GB | n/a | n/a | n/a |
| dbpedia-entities-openai-1m | 995000 | 668 | 1489.22 | n/a | 15.86 GB | n/a | n/a | n/a |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 3.19 | 5.50 | 6.87 |
| beir/nfcorpus/test | 3.06 | 4.48 | 7.47 |
| dbpedia-entities-openai-100k | 8.00 | 8.53 | 11.30 |
| dbpedia-entities-openai-1m | 16.78 | 29.49 | 36.38 |

Engine container memory through the whole track, load included (anonymous memory is the heap the kernel cannot reclaim; charged memory adds the page cache of the engine's files):

| Dataset | Peak anonymous | Peak charged | Samples |
| --- | --- | --- | --- |
| beir/scifact/test | 0.36 GB | 0.46 GB | 509 |
| beir/nfcorpus/test | 0.30 GB | 0.34 GB | 507 |
| dbpedia-entities-openai-100k | 3.10 GB | 4.15 GB | 1366 |
| dbpedia-entities-openai-1m | 15.86 GB | 21.47 GB | 4356 |

Server-side time source per dataset:

- beir/scifact/test: client round-trip only (no server-side query time exposed)
- beir/nfcorpus/test: client round-trip only (no server-side query time exposed)
- dbpedia-entities-openai-100k: client round-trip only (no server-side query time exposed)
- dbpedia-entities-openai-1m: client round-trip only (no server-side query time exposed)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 301 | n/a | 0 | 5.37 | 7.26 | 2.43 | 1.0 | no |
| 2 | 1 | 493 | n/a | 0 | 6.78 | 8.37 | 4.19 | 2.0 | no |
| 4 | 1 | 699 | n/a | 0 | 9.06 | 12.00 | 6.39 | 4.0 | no |
| 8 | 1 | 823 | n/a | 0 | 14.85 | 20.40 | 7.85 | 7.9 | no |
| 16 | 1 | 826 | n/a | 0 | 34.91 | 59.80 | 7.88 | 15.9 | no |
| 32 | 3 | 842 | 840 to 843 | 0 | 76.32 | 134.75 | 7.89 | 31.7 | no |
| 64 | 1 | 835 | n/a | 0 | 154.91 | 285.80 | 7.89 | 62.7 | no |
| 128 | 1 | 820 | n/a | 0 | 306.49 | 575.51 | 7.92 | 123.0 | no |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 313 | n/a | 0 | 4.56 | 7.95 | 2.22 | 1.0 | no |
| 2 | 1 | 522 | n/a | 0 | 7.00 | 9.14 | 3.94 | 2.0 | no |
| 4 | 1 | 765 | n/a | 0 | 8.87 | 11.28 | 6.27 | 4.0 | no |
| 8 | 1 | 941 | n/a | 0 | 13.92 | 22.79 | 7.85 | 8.0 | no |
| 16 | 1 | 949 | n/a | 0 | 34.17 | 60.30 | 7.86 | 15.9 | no |
| 32 | 1 | 902 | n/a | 0 | 71.55 | 124.48 | 7.87 | 31.6 | no |
| 64 | 1 | 1014 | n/a | 0 | 132.88 | 251.36 | 7.90 | 62.8 | no |
| 128 | 3 | 1019 | 1018 to 1020 | 0 | 282.38 | 635.05 | 7.89 | 124.0 | no |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 125 | n/a | 0 | 8.42 | 12.46 | 1.34 | 1.0 | no |
| 2 | 1 | 228 | n/a | 0 | 11.92 | 16.73 | 2.60 | 2.0 | no |
| 4 | 1 | 378 | n/a | 0 | 12.76 | 18.30 | 5.00 | 4.0 | no |
| 8 | 3 | 513 | 509 to 520 | 0 | 20.60 | 32.01 | 7.85 | 8.0 | no |
| 16 | 1 | 519 | n/a | 0 | 64.15 | 118.02 | 7.92 | 15.9 | no |
| 32 | 1 | 514 | n/a | 0 | 101.31 | 181.23 | 7.93 | 31.5 | no |
| 64 | 1 | 493 | n/a | 0 | 204.45 | 326.43 | 7.89 | 62.0 | no |
| 128 | 1 | 482 | n/a | 0 | 434.37 | 688.26 | 7.84 | 119.9 | no |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 48 | n/a | 0 | 36.25 | 48.32 | 0.83 | 1.0 | no |
| 2 | 1 | 162 | n/a | 0 | 16.05 | 24.78 | 2.65 | 2.0 | no |
| 4 | 1 | 288 | n/a | 0 | 17.16 | 38.09 | 5.29 | 4.0 | no |
| 8 | 1 | 376 | n/a | 0 | 27.01 | 54.59 | 7.89 | 8.0 | no |
| 16 | 1 | 377 | n/a | 0 | 89.57 | 139.37 | 7.96 | 15.8 | no |
| 32 | 3 | 380 | 372 to 381 | 0 | 121.20 | 328.90 | 7.91 | 31.3 | no |
| 64 | 1 | 369 | n/a | 0 | 289.19 | 755.84 | 7.90 | 61.3 | no |
| 128 | 1 | 355 | n/a | 0 | 696.28 | 993.60 | 7.86 | 117.8 | no |
