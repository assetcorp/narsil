# qdrant retrieval (vector, hybrid)

## Environment

- Captured: 2026-09-28T00:30:55.177216+00:00
- Machine: GCP c3-standard-8, us-east1-b
- OS / arch: Linux 7.0.0-1011-gcp / x86_64 (containerized: True)
- CPU: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical)
- Memory: 33.6 GB
- Memory cap per engine: 21.5 GB
- Tracks: vector, hybrid
- Keyword setup: None
- Run depth: 1000; run tag: qdrant
- Engine build: version 1.19.1, commit 6ab21cac18eb
- Engine image: qdrant/qdrant@sha256:12364fe851b9f17356fc88189fc06d1b521262e04659ec7345975b00c9246a10
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
| beir/nfcorpus/test | 0.3145 | 0.3094 | 0.1575 | 0.5168 |
| dbpedia-entities-openai-100k | n/a | n/a | n/a | n/a |
| dbpedia-entities-openai-1m | n/a | n/a | n/a | n/a |

Recall operating point (latency below is measured here, the matched-recall rule for ANN search):

| Dataset | Knob | Value | ANN recall@k | Target met | Secondary value | Secondary recall |
| --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | hnsw_ef | 32 | 0.9937 | yes | 16 | 0.9760 |
| beir/nfcorpus/test | hnsw_ef | 64 | 0.9960 | yes | 32 | 0.9780 |
| dbpedia-entities-openai-100k | hnsw_ef | 128 | 0.9942 | yes | 32 | 0.9725 |
| dbpedia-entities-openai-1m | hnsw_ef | 192 | 0.9931 | yes | 64 | 0.9758 |

Latency is measured at the operating point.

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | Index size | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 1510 | 3.43 | n/a | 0.25 | 0.30 | 0.34 |
| beir/nfcorpus/test | 3633 | 1257 | 2.89 | n/a | 0.28 | 0.32 | 0.35 |
| dbpedia-entities-openai-100k | 100000 | 715 | 139.82 | n/a | 1.57 | 2.16 | 2.54 |
| dbpedia-entities-openai-1m | 995000 | 618 | 1609.15 | n/a | 3.69 | 5.39 | 6.33 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 1.32 | 1.53 | 1.66 |
| beir/nfcorpus/test | 1.38 | 1.56 | 1.71 |
| dbpedia-entities-openai-100k | 3.63 | 4.23 | 4.61 |
| dbpedia-entities-openai-1m | 5.81 | 7.50 | 8.49 |

Server-side time source per dataset:

- beir/scifact/test: top-level `time` field, seconds converted to ms (floating-millisecond resolution)
- beir/nfcorpus/test: top-level `time` field, seconds converted to ms (floating-millisecond resolution)
- dbpedia-entities-openai-100k: top-level `time` field, seconds converted to ms (floating-millisecond resolution)
- dbpedia-entities-openai-1m: top-level `time` field, seconds converted to ms (floating-millisecond resolution)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 753 | n/a | 0 | 1.49 | 1.92 | 0.47 | 1.0 | no |
| 2 | 1 | 1271 | n/a | 0 | 1.86 | 2.22 | 0.95 | 2.0 | no |
| 4 | 1 | 2117 | n/a | 0 | 2.17 | 3.28 | 1.72 | 4.0 | no |
| 8 | 3 | 2413 | 2411 to 2417 | 0 | 4.84 | 6.23 | 2.01 | 8.0 | yes |
| 16 | 1 | 2343 | n/a | 0 | 10.67 | 33.08 | 1.95 | 16.0 | yes |
| 32 | 1 | 2153 | n/a | 0 | 24.06 | 47.16 | 1.86 | 31.9 | yes |
| 64 | 1 | 2100 | n/a | 0 | 54.53 | 95.26 | 1.79 | 63.5 | yes |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 728 | n/a | 0 | 1.52 | 1.77 | 0.52 | 1.0 | no |
| 2 | 1 | 1233 | n/a | 0 | 1.90 | 2.53 | 1.04 | 2.0 | no |
| 4 | 1 | 2057 | n/a | 0 | 2.24 | 3.51 | 1.86 | 4.0 | no |
| 8 | 3 | 2359 | 2354 to 2364 | 0 | 5.01 | 6.53 | 2.19 | 8.0 | no |
| 16 | 1 | 2287 | n/a | 0 | 11.12 | 32.11 | 2.13 | 16.0 | yes |
| 32 | 1 | 2143 | n/a | 0 | 24.03 | 46.43 | 2.01 | 31.9 | yes |
| 64 | 1 | 2051 | n/a | 0 | 55.38 | 104.21 | 1.95 | 63.4 | yes |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 270 | n/a | 0 | 4.44 | 4.97 | 1.10 | 1.0 | no |
| 2 | 1 | 477 | n/a | 0 | 5.16 | 6.02 | 2.17 | 2.0 | no |
| 4 | 1 | 730 | n/a | 0 | 6.87 | 8.70 | 3.45 | 4.0 | no |
| 8 | 1 | 793 | n/a | 0 | 14.63 | 19.64 | 4.33 | 8.0 | no |
| 16 | 1 | 828 | n/a | 0 | 31.41 | 42.82 | 4.54 | 15.9 | no |
| 32 | 3 | 841 | 833 to 841 | 0 | 63.87 | 92.78 | 4.61 | 31.7 | no |
| 64 | 1 | 833 | n/a | 0 | 128.33 | 190.35 | 4.62 | 62.6 | no |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 180 | n/a | 0 | 7.25 | 8.06 | 1.66 | 1.0 | no |
| 2 | 1 | 319 | n/a | 0 | 7.68 | 8.81 | 3.21 | 2.0 | no |
| 4 | 1 | 450 | n/a | 0 | 12.05 | 17.34 | 4.73 | 4.0 | no |
| 8 | 1 | 506 | n/a | 0 | 23.61 | 33.72 | 5.44 | 8.0 | no |
| 16 | 1 | 506 | n/a | 0 | 51.41 | 77.48 | 5.64 | 15.9 | no |
| 32 | 1 | 519 | n/a | 0 | 102.53 | 141.68 | 5.83 | 31.5 | no |
| 64 | 3 | 525 | 522 to 529 | 0 | 162.16 | 226.20 | 5.89 | 62.0 | no |

## Hybrid track

- Setup: Dense HNSW fused with server-side BM25 sparse vectors (qdrant/bm25, k1=0.9 b=0.4, average document length estimated on the first import batch, server IDF) via RRF
- Fusion: RRF (Query API fusion)

Retrieval quality vs human judgements:

| Dataset | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| beir/scifact/test | 0.7141 | 0.9577 | 0.6722 | 0.6762 |
| beir/nfcorpus/test | 0.3499 | 0.3235 | 0.1826 | 0.5640 |
| dbpedia-entities-openai-100k | n/a | n/a | n/a | n/a |
| dbpedia-entities-openai-1m | n/a | n/a | n/a | n/a |

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | Index size | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 1573 | 3.29 | n/a | 0.37 | 0.43 | 0.45 |
| beir/nfcorpus/test | 3633 | 1296 | 2.80 | n/a | 0.36 | 0.41 | 0.45 |
| dbpedia-entities-openai-100k | 100000 | 734 | 136.24 | n/a | 1.68 | 2.41 | 2.81 |
| dbpedia-entities-openai-1m | 995000 | 633 | 1573.00 | n/a | 3.96 | 6.04 | 7.22 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 1.56 | 1.73 | 1.86 |
| beir/nfcorpus/test | 1.58 | 1.72 | 1.86 |
| dbpedia-entities-openai-100k | 3.93 | 4.66 | 5.09 |
| dbpedia-entities-openai-1m | 6.26 | 8.36 | 9.53 |

Server-side time source per dataset:

- beir/scifact/test: top-level `time` field, seconds converted to ms (floating-millisecond resolution)
- beir/nfcorpus/test: top-level `time` field, seconds converted to ms (floating-millisecond resolution)
- dbpedia-entities-openai-100k: top-level `time` field, seconds converted to ms (floating-millisecond resolution)
- dbpedia-entities-openai-1m: top-level `time` field, seconds converted to ms (floating-millisecond resolution)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 633 | n/a | 0 | 1.74 | 2.08 | 0.55 | 1.0 | no |
| 2 | 1 | 1109 | n/a | 0 | 2.12 | 2.99 | 1.11 | 2.0 | no |
| 4 | 1 | 1875 | n/a | 0 | 2.46 | 4.04 | 1.99 | 4.0 | no |
| 8 | 3 | 2238 | 2237 to 2248 | 0 | 5.30 | 6.83 | 2.42 | 8.0 | no |
| 16 | 1 | 2230 | n/a | 0 | 11.25 | 32.47 | 2.39 | 16.0 | yes |
| 32 | 1 | 2075 | n/a | 0 | 25.15 | 46.30 | 2.26 | 31.9 | yes |
| 64 | 1 | 2011 | n/a | 0 | 55.94 | 104.23 | 2.20 | 63.4 | yes |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 651 | n/a | 0 | 1.68 | 1.95 | 0.58 | 1.0 | no |
| 2 | 1 | 1124 | n/a | 0 | 2.07 | 2.67 | 1.16 | 2.0 | no |
| 4 | 1 | 1883 | n/a | 0 | 2.45 | 3.47 | 2.06 | 4.0 | no |
| 8 | 3 | 2234 | 2230 to 2234 | 0 | 5.32 | 6.82 | 2.50 | 8.0 | no |
| 16 | 1 | 2224 | n/a | 0 | 11.34 | 33.68 | 2.49 | 16.0 | yes |
| 32 | 1 | 2079 | n/a | 0 | 24.72 | 49.50 | 2.34 | 31.9 | yes |
| 64 | 1 | 2006 | n/a | 0 | 56.25 | 100.11 | 2.24 | 63.4 | yes |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 251 | n/a | 0 | 4.66 | 5.22 | 1.12 | 1.0 | no |
| 2 | 1 | 445 | n/a | 0 | 5.35 | 6.24 | 2.24 | 2.0 | no |
| 4 | 1 | 673 | n/a | 0 | 7.41 | 10.38 | 3.68 | 4.0 | no |
| 8 | 1 | 740 | n/a | 0 | 15.98 | 21.10 | 4.44 | 8.0 | no |
| 16 | 1 | 771 | n/a | 0 | 33.09 | 47.46 | 4.75 | 15.9 | no |
| 32 | 1 | 774 | n/a | 0 | 68.77 | 105.81 | 4.68 | 31.7 | no |
| 64 | 3 | 777 | 776 to 781 | 0 | 133.94 | 202.21 | 4.75 | 62.5 | no |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 179 | n/a | 0 | 7.15 | 8.64 | 1.66 | 1.0 | no |
| 2 | 1 | 287 | n/a | 0 | 8.60 | 10.15 | 3.22 | 2.0 | no |
| 4 | 1 | 410 | n/a | 0 | 12.95 | 17.41 | 5.05 | 4.0 | no |
| 8 | 1 | 453 | n/a | 0 | 26.17 | 38.56 | 5.55 | 8.0 | no |
| 16 | 1 | 466 | n/a | 0 | 55.11 | 82.51 | 5.74 | 15.9 | no |
| 32 | 1 | 479 | n/a | 0 | 105.71 | 152.54 | 5.94 | 31.4 | no |
| 64 | 3 | 489 | 488 to 495 | 0 | 170.21 | 230.15 | 6.12 | 62.0 | no |
