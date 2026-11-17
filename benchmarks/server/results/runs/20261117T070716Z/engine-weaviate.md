# weaviate retrieval (vector, hybrid)

## Environment

- Captured: 2026-11-17T07:55:25.706628+00:00
- Load machine: GCP c3-standard-8, us-west3-b
- OS / arch: Linux 7.0.0-1017-gcp / x86_64 (containerized: True)
- CPU: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical)
- Memory: 33.6 GB
- Engine machine label: GCP c3-standard-8, us-west3-b
- Engine machine: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical), 33.6 GB
- Network round trip to the engine machine: p50 0.075 ms, p99 0.133 ms over 200 TCP connects
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
| beir/nfcorpus/test | 0.3146 | 0.3094 | 0.1575 | 0.5174 |
| dbpedia-entities-openai-100k | n/a | n/a | n/a | n/a |
| dbpedia-entities-openai-1m | n/a | n/a | n/a | n/a |

Recall operating point (latency below is measured here, the matched-recall rule for ANN search):

| Dataset | Knob | Value | ANN recall@k | Target met | Secondary value | Secondary recall |
| --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | ef | 64 | 0.9973 | yes | 16 | 0.9513 |
| beir/nfcorpus/test | ef | 128 | 0.9916 | yes | 64 | 0.9712 |
| dbpedia-entities-openai-100k | ef | 160 | 0.9914 | yes | 32 | 0.9509 |
| dbpedia-entities-openai-1m | ef | 416 | 0.9927 | yes | 64 | 0.9539 |

Latency is measured at the operating point.

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | On disk | Peak heap | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 1672 | 3.10 | n/a | 0.27 GB | n/a | n/a | n/a |
| beir/nfcorpus/test | 3633 | 1374 | 2.64 | n/a | 0.30 GB | n/a | n/a | n/a |
| dbpedia-entities-openai-100k | 100000 | 656 | 152.49 | n/a | 3.12 GB | n/a | n/a | n/a |
| dbpedia-entities-openai-1m | 995000 | 662 | 1503.75 | n/a | 15.13 GB | n/a | n/a | n/a |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 2.96 | 3.89 | 5.76 |
| beir/nfcorpus/test | 3.07 | 4.02 | 6.40 |
| dbpedia-entities-openai-100k | 8.89 | 9.64 | 12.27 |
| dbpedia-entities-openai-1m | 12.40 | 14.00 | 14.97 |

Engine container memory through the whole track, load included (anonymous memory is the heap the kernel cannot reclaim; charged memory adds the page cache of the engine's files):

| Dataset | Peak anonymous | Peak charged | Samples |
| --- | --- | --- | --- |
| beir/scifact/test | 0.27 GB | 0.33 GB | 502 |
| beir/nfcorpus/test | 0.30 GB | 0.35 GB | 546 |
| dbpedia-entities-openai-100k | 3.12 GB | 4.21 GB | 1203 |
| dbpedia-entities-openai-1m | 15.13 GB | 21.48 GB | 4709 |

Server-side time source per dataset:

- beir/scifact/test: client round-trip only (no server-side query time exposed)
- beir/nfcorpus/test: client round-trip only (no server-side query time exposed)
- dbpedia-entities-openai-100k: client round-trip only (no server-side query time exposed)
- dbpedia-entities-openai-1m: client round-trip only (no server-side query time exposed)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 317 | n/a | 0 | 3.84 | 7.02 | 1.09 | 1.0 | no |
| 2 | 1 | 613 | n/a | 0 | 4.55 | 7.84 | 2.07 | 2.0 | no |
| 4 | 1 | 1048 | n/a | 0 | 6.12 | 7.46 | 3.79 | 4.0 | no |
| 8 | 1 | 1528 | n/a | 0 | 7.92 | 12.01 | 6.34 | 8.0 | no |
| 16 | 1 | 1783 | n/a | 0 | 15.03 | 29.12 | 7.75 | 15.9 | no |
| 32 | 3 | 1785 | 1764 to 1791 | 0 | 33.64 | 58.40 | 7.85 | 31.8 | no |
| 64 | 1 | 1738 | n/a | 0 | 77.70 | 166.32 | 7.83 | 63.2 | no |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 307 | n/a | 0 | 3.99 | 7.65 | 1.12 | 1.0 | no |
| 2 | 1 | 596 | n/a | 0 | 5.24 | 6.62 | 2.01 | 2.0 | no |
| 4 | 1 | 1006 | n/a | 0 | 6.25 | 7.74 | 3.79 | 4.0 | no |
| 8 | 1 | 1487 | n/a | 0 | 8.13 | 20.17 | 6.44 | 8.0 | no |
| 16 | 3 | 1712 | 1711 to 1713 | 0 | 15.74 | 28.07 | 7.76 | 16.0 | no |
| 32 | 1 | 1707 | n/a | 0 | 35.30 | 65.73 | 7.84 | 31.8 | no |
| 64 | 1 | 1676 | n/a | 0 | 82.19 | 162.87 | 7.84 | 63.1 | no |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 111 | n/a | 0 | 9.43 | 13.34 | 0.90 | 1.0 | no |
| 2 | 1 | 211 | n/a | 0 | 12.72 | 15.36 | 1.76 | 2.0 | no |
| 4 | 1 | 379 | n/a | 0 | 13.46 | 17.98 | 3.56 | 4.0 | no |
| 8 | 1 | 570 | n/a | 0 | 18.73 | 26.14 | 6.68 | 8.0 | no |
| 16 | 3 | 621 | 618 to 623 | 0 | 44.86 | 73.15 | 7.82 | 15.9 | no |
| 32 | 1 | 601 | n/a | 0 | 90.36 | 190.62 | 7.77 | 31.5 | no |
| 64 | 1 | 589 | n/a | 0 | 189.30 | 618.13 | 7.76 | 62.1 | no |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 87 | n/a | 0 | 13.01 | 14.43 | 0.87 | 1.0 | no |
| 2 | 1 | 168 | n/a | 0 | 16.40 | 19.10 | 1.70 | 2.0 | no |
| 4 | 1 | 303 | n/a | 0 | 17.49 | 25.84 | 3.70 | 4.0 | no |
| 8 | 1 | 456 | n/a | 0 | 22.83 | 38.18 | 6.87 | 8.0 | no |
| 16 | 1 | 465 | n/a | 0 | 61.40 | 169.66 | 7.70 | 15.8 | no |
| 32 | 3 | 466 | 460 to 474 | 0 | 106.56 | 202.28 | 7.69 | 31.4 | no |
| 64 | 1 | 461 | n/a | 0 | 212.18 | 398.30 | 7.68 | 61.8 | no |

## Hybrid track

- Setup: BM25 k1=0.9 b=0.4 over text fused with dense vectors via the hybrid operator (rankedFusion, alpha=0.5)
- Fusion: rankedFusion (alpha=0.5)

Retrieval quality vs human judgements:

| Dataset | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| beir/scifact/test | 0.6840 | 0.9577 | 0.6366 | 0.6460 |
| beir/nfcorpus/test | 0.3428 | 0.3195 | 0.1809 | 0.5547 |
| dbpedia-entities-openai-100k | n/a | n/a | n/a | n/a |
| dbpedia-entities-openai-1m | n/a | n/a | n/a | n/a |

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | On disk | Peak heap | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 1681 | 3.08 | n/a | 0.30 GB | n/a | n/a | n/a |
| beir/nfcorpus/test | 3633 | 1453 | 2.50 | n/a | 0.26 GB | n/a | n/a | n/a |
| dbpedia-entities-openai-100k | 100000 | 653 | 153.07 | n/a | 2.79 GB | n/a | n/a | n/a |
| dbpedia-entities-openai-1m | 995000 | 668 | 1490.28 | n/a | 16.15 GB | n/a | n/a | n/a |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 4.02 | 5.75 | 8.05 |
| beir/nfcorpus/test | 3.77 | 5.27 | 7.63 |
| dbpedia-entities-openai-100k | 9.58 | 10.98 | 13.13 |
| dbpedia-entities-openai-1m | 20.05 | 33.02 | 38.22 |

Engine container memory through the whole track, load included (anonymous memory is the heap the kernel cannot reclaim; charged memory adds the page cache of the engine's files):

| Dataset | Peak anonymous | Peak charged | Samples |
| --- | --- | --- | --- |
| beir/scifact/test | 0.30 GB | 0.37 GB | 384 |
| beir/nfcorpus/test | 0.26 GB | 0.31 GB | 383 |
| dbpedia-entities-openai-100k | 2.79 GB | 3.76 GB | 876 |
| dbpedia-entities-openai-1m | 16.15 GB | 21.48 GB | 3891 |

Server-side time source per dataset:

- beir/scifact/test: client round-trip only (no server-side query time exposed)
- beir/nfcorpus/test: client round-trip only (no server-side query time exposed)
- dbpedia-entities-openai-100k: client round-trip only (no server-side query time exposed)
- dbpedia-entities-openai-1m: client round-trip only (no server-side query time exposed)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 231 | n/a | 0 | 5.47 | 9.16 | 2.02 | 1.0 | no |
| 2 | 1 | 410 | n/a | 0 | 8.18 | 10.02 | 3.68 | 2.0 | no |
| 4 | 1 | 632 | n/a | 0 | 10.01 | 12.19 | 6.00 | 4.0 | no |
| 8 | 1 | 775 | n/a | 0 | 16.64 | 21.42 | 7.57 | 8.0 | no |
| 16 | 1 | 803 | n/a | 0 | 35.73 | 62.23 | 7.93 | 15.9 | no |
| 32 | 3 | 822 | 816 to 822 | 0 | 75.82 | 130.27 | 7.89 | 31.6 | no |
| 64 | 1 | 821 | n/a | 0 | 147.28 | 255.94 | 7.91 | 62.6 | no |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 253 | n/a | 0 | 5.01 | 8.33 | 1.81 | 1.0 | no |
| 2 | 1 | 451 | n/a | 0 | 7.47 | 10.31 | 3.28 | 2.0 | no |
| 4 | 1 | 714 | n/a | 0 | 9.23 | 11.39 | 5.65 | 4.0 | no |
| 8 | 1 | 916 | n/a | 0 | 14.01 | 21.06 | 7.38 | 8.0 | no |
| 16 | 1 | 957 | n/a | 0 | 30.59 | 47.14 | 7.92 | 15.9 | no |
| 32 | 1 | 1011 | n/a | 0 | 59.42 | 98.52 | 7.88 | 31.7 | no |
| 64 | 3 | 1012 | 1005 to 1013 | 0 | 130.23 | 236.54 | 7.89 | 62.9 | no |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 102 | n/a | 0 | 11.04 | 14.64 | 1.14 | 1.0 | no |
| 2 | 1 | 191 | n/a | 0 | 11.93 | 16.99 | 2.17 | 2.0 | no |
| 4 | 1 | 335 | n/a | 0 | 14.25 | 19.08 | 4.36 | 4.0 | no |
| 8 | 1 | 476 | n/a | 0 | 23.01 | 32.36 | 7.09 | 8.0 | no |
| 16 | 3 | 512 | 501 to 512 | 0 | 55.86 | 91.20 | 7.94 | 15.9 | no |
| 32 | 1 | 498 | n/a | 0 | 104.88 | 252.90 | 7.89 | 31.3 | no |
| 64 | 1 | 498 | n/a | 0 | 193.41 | 287.05 | 7.92 | 61.7 | no |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 63 | n/a | 0 | 29.22 | 42.33 | 1.02 | 1.0 | no |
| 2 | 1 | 148 | n/a | 0 | 16.87 | 26.63 | 2.43 | 2.0 | no |
| 4 | 1 | 270 | n/a | 0 | 17.71 | 33.60 | 4.64 | 4.0 | no |
| 8 | 1 | 375 | n/a | 0 | 27.78 | 51.62 | 7.41 | 8.0 | no |
| 16 | 3 | 388 | 387 to 391 | 0 | 71.00 | 147.08 | 7.96 | 15.8 | no |
| 32 | 1 | 385 | n/a | 0 | 119.04 | 242.03 | 7.93 | 31.3 | no |
| 64 | 1 | 373 | n/a | 0 | 249.53 | 485.29 | 7.92 | 61.1 | no |
