# qdrant retrieval (vector, hybrid, best-config vector profile)

## Environment

- Captured: 2026-09-28T01:46:28.381634+00:00
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
- Index setup: HNSW dense vectors with 4-bit TurboQuant held in RAM and full-precision rescore (oversampling 2.0x), distance Cosine, over the shared precomputed vectors
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
| beir/scifact/test | hnsw_ef | 32 | 0.9937 | yes | 16 | 0.9813 |
| beir/nfcorpus/test | hnsw_ef | 64 | 0.9941 | yes | 16 | 0.9591 |
| dbpedia-entities-openai-100k | hnsw_ef | 128 | 0.9940 | yes | 16 | 0.9517 |
| dbpedia-entities-openai-1m | hnsw_ef | 192 | 0.9929 | yes | 64 | 0.9738 |

Latency is measured at the operating point.

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | Index size | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 1510 | 3.43 | n/a | 0.23 | 0.27 | 0.30 |
| beir/nfcorpus/test | 3633 | 1238 | 2.93 | n/a | 0.25 | 0.29 | 0.31 |
| dbpedia-entities-openai-100k | 100000 | 712 | 140.36 | n/a | 0.54 | 0.74 | 1.07 |
| dbpedia-entities-openai-1m | 995000 | 708 | 1404.61 | n/a | 1.73 | 2.62 | 3.05 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 1.29 | 1.50 | 1.61 |
| beir/nfcorpus/test | 1.32 | 1.52 | 1.65 |
| dbpedia-entities-openai-100k | 2.56 | 2.90 | 3.12 |
| dbpedia-entities-openai-1m | 3.78 | 4.69 | 5.15 |

Server-side time source per dataset:

- beir/scifact/test: top-level `time` field, seconds converted to ms (floating-millisecond resolution)
- beir/nfcorpus/test: top-level `time` field, seconds converted to ms (floating-millisecond resolution)
- dbpedia-entities-openai-100k: top-level `time` field, seconds converted to ms (floating-millisecond resolution)
- dbpedia-entities-openai-1m: top-level `time` field, seconds converted to ms (floating-millisecond resolution)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 751 | n/a | 0 | 1.49 | 1.74 | 0.45 | 1.0 | no |
| 2 | 1 | 1307 | n/a | 0 | 1.83 | 2.12 | 0.90 | 2.0 | no |
| 4 | 1 | 2174 | n/a | 0 | 2.11 | 3.17 | 1.63 | 4.0 | no |
| 8 | 3 | 2464 | 2463 to 2477 | 0 | 4.74 | 6.33 | 1.92 | 8.0 | yes |
| 16 | 1 | 2406 | n/a | 0 | 10.55 | 30.51 | 1.86 | 16.0 | yes |
| 32 | 1 | 2214 | n/a | 0 | 23.29 | 46.28 | 1.74 | 31.9 | yes |
| 64 | 1 | 2144 | n/a | 0 | 53.24 | 95.90 | 1.70 | 63.4 | yes |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 749 | n/a | 0 | 1.50 | 1.76 | 0.48 | 1.0 | no |
| 2 | 1 | 1267 | n/a | 0 | 1.86 | 2.32 | 0.97 | 2.0 | no |
| 4 | 1 | 2121 | n/a | 0 | 2.17 | 3.26 | 1.75 | 4.0 | no |
| 8 | 3 | 2424 | 2421 to 2425 | 0 | 4.84 | 6.29 | 2.06 | 8.0 | yes |
| 16 | 1 | 2352 | n/a | 0 | 10.72 | 31.24 | 2.00 | 16.0 | yes |
| 32 | 1 | 2187 | n/a | 0 | 23.68 | 44.50 | 1.88 | 31.9 | yes |
| 64 | 1 | 2091 | n/a | 0 | 54.46 | 108.84 | 1.81 | 63.5 | yes |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 379 | n/a | 0 | 2.81 | 3.15 | 0.57 | 1.0 | no |
| 2 | 1 | 691 | n/a | 0 | 3.80 | 4.20 | 1.17 | 2.0 | no |
| 4 | 1 | 1136 | n/a | 0 | 4.14 | 5.59 | 1.98 | 4.0 | no |
| 8 | 3 | 1278 | 1272 to 1283 | 0 | 9.47 | 11.69 | 2.37 | 8.0 | no |
| 16 | 1 | 1262 | n/a | 0 | 20.10 | 31.01 | 2.40 | 15.9 | yes |
| 32 | 1 | 1208 | n/a | 0 | 42.55 | 74.09 | 2.35 | 31.8 | yes |
| 64 | 1 | 1182 | n/a | 0 | 94.06 | 157.97 | 2.29 | 63.1 | yes |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 313 | n/a | 0 | 3.63 | 3.98 | 0.98 | 1.0 | no |
| 2 | 1 | 566 | n/a | 0 | 4.39 | 4.94 | 1.86 | 2.0 | no |
| 4 | 1 | 900 | n/a | 0 | 5.47 | 6.87 | 2.96 | 4.0 | no |
| 8 | 1 | 1025 | n/a | 0 | 11.83 | 15.41 | 3.62 | 8.0 | no |
| 16 | 3 | 1073 | 1070 to 1077 | 0 | 24.21 | 36.48 | 3.66 | 15.9 | no |
| 32 | 1 | 1059 | n/a | 0 | 49.17 | 79.61 | 3.78 | 31.7 | no |
| 64 | 1 | 1013 | n/a | 0 | 108.68 | 176.97 | 3.55 | 62.9 | no |

## Hybrid track

- Setup: TurboQuant 4-bit dense HNSW (full-precision rescore) fused with server-side BM25 sparse vectors (qdrant/bm25, k1=0.9 b=0.4, average document length estimated on the first import batch, server IDF) via RRF
- Fusion: RRF (Query API fusion)

Retrieval quality vs human judgements:

| Dataset | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| beir/scifact/test | 0.7141 | 0.9577 | 0.6722 | 0.6762 |
| beir/nfcorpus/test | 0.3502 | 0.3236 | 0.1826 | 0.5662 |
| dbpedia-entities-openai-100k | n/a | n/a | n/a | n/a |
| dbpedia-entities-openai-1m | n/a | n/a | n/a | n/a |

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | Index size | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 1596 | 3.25 | n/a | 0.35 | 0.40 | 0.43 |
| beir/nfcorpus/test | 3633 | 1243 | 2.92 | n/a | 0.34 | 0.39 | 0.42 |
| dbpedia-entities-openai-100k | 100000 | 711 | 140.74 | n/a | 0.68 | 0.98 | 1.28 |
| dbpedia-entities-openai-1m | 995000 | 712 | 1396.73 | n/a | 1.97 | 3.46 | 3.98 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 1.52 | 1.72 | 1.84 |
| beir/nfcorpus/test | 1.53 | 1.70 | 1.84 |
| dbpedia-entities-openai-100k | 2.88 | 3.26 | 3.57 |
| dbpedia-entities-openai-1m | 4.24 | 5.75 | 6.27 |

Server-side time source per dataset:

- beir/scifact/test: top-level `time` field, seconds converted to ms (floating-millisecond resolution)
- beir/nfcorpus/test: top-level `time` field, seconds converted to ms (floating-millisecond resolution)
- dbpedia-entities-openai-100k: top-level `time` field, seconds converted to ms (floating-millisecond resolution)
- dbpedia-entities-openai-1m: top-level `time` field, seconds converted to ms (floating-millisecond resolution)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 652 | n/a | 0 | 1.70 | 1.97 | 0.55 | 1.0 | no |
| 2 | 1 | 1137 | n/a | 0 | 2.06 | 2.72 | 1.09 | 2.0 | no |
| 4 | 1 | 1896 | n/a | 0 | 2.44 | 3.65 | 1.96 | 4.0 | no |
| 8 | 3 | 2280 | 2265 to 2289 | 0 | 5.21 | 6.97 | 2.38 | 8.0 | no |
| 16 | 1 | 2264 | n/a | 0 | 11.10 | 33.38 | 2.37 | 16.0 | yes |
| 32 | 1 | 2099 | n/a | 0 | 24.11 | 47.97 | 2.22 | 31.8 | yes |
| 64 | 1 | 2020 | n/a | 0 | 56.52 | 116.37 | 2.15 | 63.4 | yes |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 658 | n/a | 0 | 1.67 | 2.01 | 0.55 | 1.0 | no |
| 2 | 1 | 1144 | n/a | 0 | 2.05 | 2.75 | 1.09 | 2.0 | no |
| 4 | 1 | 1927 | n/a | 0 | 2.40 | 3.56 | 1.97 | 4.0 | no |
| 8 | 3 | 2290 | 2286 to 2294 | 0 | 5.18 | 6.82 | 2.39 | 8.0 | no |
| 16 | 1 | 2270 | n/a | 0 | 11.08 | 33.18 | 2.37 | 16.0 | yes |
| 32 | 1 | 2103 | n/a | 0 | 24.50 | 48.83 | 2.23 | 31.9 | yes |
| 64 | 1 | 2054 | n/a | 0 | 55.25 | 104.36 | 2.16 | 63.4 | yes |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 348 | n/a | 0 | 3.10 | 3.40 | 0.62 | 1.0 | no |
| 2 | 1 | 625 | n/a | 0 | 4.02 | 4.76 | 1.28 | 2.0 | no |
| 4 | 1 | 1035 | n/a | 0 | 4.53 | 6.05 | 2.21 | 4.0 | no |
| 8 | 3 | 1194 | 1194 to 1200 | 0 | 10.16 | 12.50 | 2.78 | 8.0 | no |
| 16 | 1 | 1199 | n/a | 0 | 21.39 | 30.44 | 2.81 | 15.9 | no |
| 32 | 1 | 1150 | n/a | 0 | 43.69 | 68.92 | 2.72 | 31.8 | no |
| 64 | 1 | 1121 | n/a | 0 | 96.50 | 168.00 | 2.68 | 63.0 | no |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 280 | n/a | 0 | 4.09 | 4.67 | 1.05 | 1.0 | no |
| 2 | 1 | 472 | n/a | 0 | 5.12 | 6.40 | 2.22 | 2.0 | no |
| 4 | 1 | 743 | n/a | 0 | 6.75 | 8.35 | 3.58 | 4.0 | no |
| 8 | 1 | 845 | n/a | 0 | 13.99 | 19.56 | 4.27 | 8.0 | no |
| 16 | 1 | 880 | n/a | 0 | 28.86 | 43.65 | 4.39 | 15.9 | no |
| 32 | 1 | 906 | n/a | 0 | 58.67 | 85.78 | 4.51 | 31.7 | no |
| 64 | 3 | 912 | 909 to 915 | 0 | 117.40 | 178.55 | 4.42 | 62.7 | no |
