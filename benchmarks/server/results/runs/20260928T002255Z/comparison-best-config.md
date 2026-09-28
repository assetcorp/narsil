# Search-engine comparison (best config (each engine's recommended production quantization)): keyword, vector, hybrid

## Run conditions

- Vector and hybrid tracks use each engine's own recommended production quantization (narsil OSQ 4-bit, elasticsearch BBQ, opensearch SQfp16, qdrant TurboQuant 4-bit, weaviate 8-bit RQ). Every engine meets the same recall target through its own search-effort knob, so compression differs by engine by design.
- Machine: GCP c3-standard-8, us-central1-a
- OS / arch: Linux 7.0.0-1011-gcp / x86_64
- Equal memory cap per engine: 21.5 GB
- Java heap inside that cap, as each node reports it: elasticsearch 10.7 GB, opensearch 6.4 GB
- Run depth: 1000; BM25 reference k1=0.9, b=0.4
- Shared embedding model: sentence-transformers/all-MiniLM-L6-v2 (384 dim, cosine); latency on the vector track is compared at matched ANN recall@10 >= 0.99.
- Every engine uses the same datasets, metrics, run depth, and strictly-decreasing run-file ordering.
- Dataset beir/scifact/test: content md5 5f7d1de60b170fc8027bb7898e2efca1 (ir_datasets-verified archive)
- Dataset beir/nfcorpus/test: content md5 a89dba18a62ef92f7d323ec890a0d38d (ir_datasets-verified archive)
- Headline latency is each engine's own reported query time, read from the same response the client round-trip wraps. Resolution differs by engine and is disclosed below; an engine that exposes no server-side time is marked not-available and compared on client round-trip only.

## Engines and tracks

| Engine | Version | Build | Tracks |
| --- | --- | --- | --- |
| narsil | 0.3.0 | 5dc940c70724 | keyword, vector, hybrid |
| elasticsearch | 9.5.4 | 9170df19cae1 | keyword, vector, hybrid |
| opensearch | 3.8.0 | e5a3c5691be8 | keyword, vector, hybrid |
| qdrant | 1.19.1 | 6ab21cac18eb | vector, hybrid |
| weaviate | 1.39.5 | sha256:c29b501d8fda | vector, hybrid |

## Vector track

### beir/scifact/test

Retrieval quality (higher is better). A star marks the best in each column:

| Engine | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| narsil | 0.6239 | 0.9227 | 0.5797 | 0.5849 |
| elasticsearch | 0.6239 | 0.9227 | 0.5797 | 0.5849 |
| opensearch | 0.6239 | 0.9227 | 0.5797 | 0.5849 |
| qdrant | 0.6239 | 0.9227 | 0.5797 | 0.5849 |
| weaviate | 0.6239 | 0.9227 | 0.5797 | 0.5849 |

Matched-recall operating point per engine:

| Engine | Knob | Value | ANN recall@k | Target met |
| --- | --- | --- | --- | --- |
| narsil | efSearch | 16 | 0.9927 | yes |
| elasticsearch | num_candidates | 16 | 0.9913 | yes |
| opensearch | ef_search | 64 | 0.9967 | yes |
| qdrant | hnsw_ef | 32 | 0.9937 | yes |
| weaviate | ef | 64 | 0.9957 | yes |

Ingest throughput (higher is better) and query latency (lower is better). The headline latency is each engine's own server-side query time; a star marks the best in each column:

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 2217\* | 2.34\* | 0.13 | 0.15 | 0.22 |
| elasticsearch | 1536 | 3.37 | &lt;1 | &lt;1 | &lt;1 |
| opensearch | 1114 | 4.65 | &lt;1 | &lt;1 | &lt;1 |
| qdrant | 1510 | 3.43 | 0.23 | 0.27 | 0.30 |
| weaviate | 1731 | 2.99 | n/a | n/a | n/a |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 0.95\* | 1.16\* | 1.33\* |
| elasticsearch | 1.93 | 2.10 | 2.23 |
| opensearch | 1.60 | 1.79 | 1.90 |
| qdrant | 1.29 | 1.50 | 1.61 |
| weaviate | 3.26 | 4.16 | 6.94 |

Server-side time source per engine:

- narsil: response `elapsed` field (floating-millisecond resolution)
- elasticsearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- opensearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- qdrant: top-level `time` field, seconds converted to ms (floating-millisecond resolution)
- weaviate: client round-trip only (no server-side query time exposed)

Throughput under concurrent load (higher is better). Peak QPS is the highest sustained rate across the tested concurrency levels, and 'client-limited' flags an engine whose peak the harness capped, not the engine itself. A star marks the best:

| Engine | Peak QPS | 95% CI | At concurrency | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- |
| narsil | 2782\* | 2780 to 2798 | 8 | 4.27 | 34.85 | 1.66 | yes |
| elasticsearch | 2177 | 2171 to 2210 | 16 | 11.67 | 38.49 | 2.85 | no |
| opensearch | 2331 | 2330 to 2332 | 16 | 11.01 | 28.76 | 2.66 | no |
| qdrant | 2464 | 2463 to 2477 | 8 | 4.74 | 6.33 | 1.92 | yes |
| weaviate | 1139 | 1135 to 1141 | 16 | 27.54 | 47.28 | 5.69 | no |

Narsil ties for the best nDCG@10 (5-way tie at 0.6239) and has the fastest server-side p50 latency at 0.13 ms (among engines above the measurement floor).

### beir/nfcorpus/test

Retrieval quality (higher is better). A star marks the best in each column:

| Engine | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| narsil | 0.3145 | 0.3094 | 0.1575 | 0.5168 |
| elasticsearch | 0.3145 | 0.3094 | 0.1575 | 0.5168 |
| opensearch | 0.3145 | 0.3094 | 0.1575 | 0.5168 |
| qdrant | 0.3145 | 0.3094 | 0.1575 | 0.5168 |
| weaviate | 0.3145 | 0.3094 | 0.1575 | 0.5168 |

Matched-recall operating point per engine:

| Engine | Knob | Value | ANN recall@k | Target met |
| --- | --- | --- | --- | --- |
| narsil | efSearch | 128 | 0.9926 | yes |
| elasticsearch | num_candidates | 8192 | 0.9848 | NO |
| opensearch | ef_search | 128 | 0.9935 | yes |
| qdrant | hnsw_ef | 64 | 0.9941 | yes |
| weaviate | ef | 128 | 0.9920 | yes |

Ingest throughput (higher is better) and query latency (lower is better). The headline latency is each engine's own server-side query time; a star marks the best in each column:

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 1998\* | 1.82\* | 0.18 | 0.21 | 0.23 |
| elasticsearch | 1253 | 2.90 | &lt;1 | &lt;1 | &lt;1 |
| opensearch | 1157 | 3.14 | &lt;1 | &lt;1 | &lt;1 |
| qdrant | 1238 | 2.93 | 0.25 | 0.29 | 0.31 |
| weaviate | 1238 | 2.94 | n/a | n/a | n/a |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 1.02\* | 1.17\* | 1.59\* |
| elasticsearch | 2.06 | 2.24 | 2.39 |
| opensearch | 1.77 | 1.91 | 2.04 |
| qdrant | 1.32 | 1.52 | 1.65 |
| weaviate | 3.33 | 4.24 | 7.32 |

Server-side time source per engine:

- narsil: response `elapsed` field (floating-millisecond resolution)
- elasticsearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- opensearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- qdrant: top-level `time` field, seconds converted to ms (floating-millisecond resolution)
- weaviate: client round-trip only (no server-side query time exposed)

Throughput under concurrent load (higher is better). Peak QPS is the highest sustained rate across the tested concurrency levels, and 'client-limited' flags an engine whose peak the harness capped, not the engine itself. A star marks the best:

| Engine | Peak QPS | 95% CI | At concurrency | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- |
| narsil | 2729\* | 2699 to 2733 | 8 | 4.36 | 32.01 | 1.77 | no |
| elasticsearch | 2090† | 2083 to 2094 | 16 | 12.25 | 37.74 | 3.23 | no |
| opensearch | 2299 | 2295 to 2301 | 16 | 11.28 | 29.39 | 2.73 | no |
| qdrant | 2424 | 2421 to 2425 | 8 | 4.84 | 6.29 | 2.06 | yes |
| weaviate | 1119 | 1117 to 1124 | 32 | 71.80 | 168.79 | 5.76 | no |

† missed the recall target, so its speed is shown but not ranked.

Narsil ties for the best nDCG@10 (5-way tie at 0.3145) and has the fastest server-side p50 latency at 0.18 ms (among engines above the measurement floor).

### dbpedia-entities-openai-100k

Retrieval quality (higher is better). A star marks the best in each column:

| Engine | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| narsil | n/a | n/a | n/a | n/a |
| elasticsearch | n/a | n/a | n/a | n/a |
| opensearch | n/a | n/a | n/a | n/a |
| qdrant | n/a | n/a | n/a | n/a |
| weaviate | n/a | n/a | n/a | n/a |

Matched-recall operating point per engine:

| Engine | Knob | Value | ANN recall@k | Target met |
| --- | --- | --- | --- | --- |
| narsil | efSearch | 128 | 0.9919 | yes |
| elasticsearch | num_candidates | 2048 | 0.9925 | yes |
| opensearch | ef_search | 192 | 0.9928 | yes |
| qdrant | hnsw_ef | 128 | 0.9940 | yes |
| weaviate | ef | 192 | 0.9927 | yes |

Ingest throughput (higher is better) and query latency (lower is better). The headline latency is each engine's own server-side query time; a star marks the best in each column:

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 773\* | 129.31\* | 0.60 | 0.75 | 0.83 |
| elasticsearch | 493 | 202.85 | 1.00 | 2.00 | 2.00 |
| opensearch | 679 | 147.24 | &lt;1 | 1.00 | 1.00 |
| qdrant | 712 | 140.36 | 0.54 | 0.74 | 1.07 |
| weaviate | 595 | 168.12 | n/a | n/a | n/a |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 2.42\* | 2.73\* | 3.59 |
| elasticsearch | 4.14 | 4.81 | 5.13 |
| opensearch | 2.93 | 3.13 | 3.27 |
| qdrant | 2.56 | 2.90 | 3.12\* |
| weaviate | 8.96 | 10.36 | 14.26 |

Server-side time source per engine:

- narsil: response `elapsed` field (floating-millisecond resolution)
- elasticsearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- opensearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- qdrant: top-level `time` field, seconds converted to ms (floating-millisecond resolution)
- weaviate: client round-trip only (no server-side query time exposed)

Throughput under concurrent load (higher is better). Peak QPS is the highest sustained rate across the tested concurrency levels, and 'client-limited' flags an engine whose peak the harness capped, not the engine itself. A star marks the best:

| Engine | Peak QPS | 95% CI | At concurrency | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- |
| narsil | 1366\* | 1347 to 1374 | 16 | 19.88 | 88.53 | 2.44 | no |
| elasticsearch | 1139 | 1137 to 1141 | 16 | 22.85 | 34.74 | 3.37 | no |
| opensearch | 1339 | 1337 to 1344 | 16 | 19.23 | 29.04 | 2.25 | yes |
| qdrant | 1278 | 1272 to 1283 | 8 | 9.47 | 11.69 | 2.37 | no |
| weaviate | 451 | 450 to 454 | 8 | 27.29 | 41.67 | 5.93 | no |

### dbpedia-entities-openai-1m

Retrieval quality (higher is better). A star marks the best in each column:

| Engine | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| narsil | n/a | n/a | n/a | n/a |
| elasticsearch | n/a | n/a | n/a | n/a |
| opensearch | n/a | n/a | n/a | n/a |
| qdrant | n/a | n/a | n/a | n/a |
| weaviate | n/a | n/a | n/a | n/a |

Matched-recall operating point per engine:

| Engine | Knob | Value | ANN recall@k | Target met |
| --- | --- | --- | --- | --- |
| narsil | efSearch | 384 | 0.9942 | yes |
| elasticsearch | num_candidates | 2048 | 0.9917 | yes |
| opensearch | ef_search | 1024 | 0.9916 | yes |
| qdrant | hnsw_ef | 192 | 0.9929 | yes |
| weaviate | ef | 384 | 0.9922 | yes |

Ingest throughput (higher is better) and query latency (lower is better). The headline latency is each engine's own server-side query time; a star marks the best in each column:

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 642 | 1549.10 | 2.21 | 4.74 | 7.08 |
| elasticsearch | 527 | 1887.17 | 4.00 | 8.00 | 12.00 |
| opensearch | 502 | 1983.87 | 7.00 | 16.00 | 24.00 |
| qdrant | 708\* | 1404.61\* | 1.73\* | 2.62\* | 3.05\* |
| weaviate | 584 | 1704.03 | n/a | n/a | n/a |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 4.11 | 7.17 | 9.94 |
| elasticsearch | 6.37 | 10.68 | 14.76 |
| opensearch | 9.14 | 18.32 | 26.93 |
| qdrant | 3.78\* | 4.69\* | 5.15\* |
| weaviate | 10.84 | 12.06 | 13.65 |

Server-side time source per engine:

- narsil: response `elapsed` field (floating-millisecond resolution)
- elasticsearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- opensearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- qdrant: top-level `time` field, seconds converted to ms (floating-millisecond resolution)
- weaviate: client round-trip only (no server-side query time exposed)

Throughput under concurrent load (higher is better). Peak QPS is the highest sustained rate across the tested concurrency levels, and 'client-limited' flags an engine whose peak the harness capped, not the engine itself. A star marks the best:

| Engine | Peak QPS | 95% CI | At concurrency | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- |
| narsil | 1154\* | 1154 to 1177 | 16 | 24.25 | 58.61 | 3.82 | no |
| elasticsearch | 1075 | 1073 to 1079 | 16 | 24.27 | 37.80 | 3.71 | no |
| opensearch | 1111 | 1109 to 1117 | 16 | 23.55 | 35.17 | 3.82 | no |
| qdrant | 1073 | 1070 to 1077 | 16 | 24.21 | 36.48 | 3.66 | no |
| weaviate | 406 | 404 to 412 | 16 | 70.91 | 137.97 | 6.23 | no |

## Hybrid track

### beir/scifact/test

Retrieval quality (higher is better). A star marks the best in each column:

| Engine | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| narsil | 0.7026 | 0.9643\* | 0.6543 | 0.6615 |
| elasticsearch | 0.7053 | 0.9610 | 0.6587 | 0.6643 |
| opensearch | 0.7053 | 0.9610 | 0.6587 | 0.6643 |
| qdrant | 0.7141\* | 0.9577 | 0.6722\* | 0.6762\* |
| weaviate | 0.6803 | 0.9577 | 0.6316 | 0.6410 |

Ingest throughput (higher is better) and query latency (lower is better). The headline latency is each engine's own server-side query time; a star marks the best in each column:

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 2114\* | 2.45\* | 0.29 | 0.46 | 0.57 |
| elasticsearch | 1497 | 3.46 | 1.00 | 1.00 | 1.00 |
| opensearch | 1151 | 4.50 | 1.00 | 1.00 | 2.00 |
| qdrant | 1596 | 3.25 | 0.35 | 0.40 | 0.43 |
| weaviate | 1406 | 3.69 | n/a | n/a | n/a |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 1.18\* | 1.41\* | 1.70\* |
| elasticsearch | 2.69 | 3.07 | 3.30 |
| opensearch | 2.60 | 3.12 | 3.36 |
| qdrant | 1.52 | 1.72 | 1.84 |
| weaviate | 4.25 | 6.92 | 10.42 |

Server-side time source per engine:

- narsil: response `elapsed` field (floating-millisecond resolution)
- elasticsearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- opensearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- qdrant: top-level `time` field, seconds converted to ms (floating-millisecond resolution)
- weaviate: client round-trip only (no server-side query time exposed)

Throughput under concurrent load (higher is better). Peak QPS is the highest sustained rate across the tested concurrency levels, and 'client-limited' flags an engine whose peak the harness capped, not the engine itself. A star marks the best:

| Engine | Peak QPS | 95% CI | At concurrency | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- |
| narsil | 2565\* | 2546 to 2581 | 16 | 10.39 | 49.13 | 2.21 | yes |
| elasticsearch | 1734 | 1729 to 1740 | 32 | 30.62 | 55.50 | 4.28 | no |
| opensearch | 1818 | 1797 to 1822 | 32 | 29.84 | 55.05 | 4.52 | no |
| qdrant | 2280 | 2265 to 2289 | 8 | 5.21 | 6.97 | 2.38 | no |
| weaviate | 625 | 624 to 627 | 16 | 50.43 | 93.02 | 6.60 | no |

Narsil ranks 4/5 on nDCG@10 (best: qdrant, 0.7141) and has the fastest server-side p50 latency at 0.29 ms (among engines above the measurement floor).

### beir/nfcorpus/test

Retrieval quality (higher is better). A star marks the best in each column:

| Engine | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| narsil | 0.3560\* | 0.3239\* | 0.1878\* | 0.5745\* |
| elasticsearch | 0.3519 | 0.3215 | 0.1867 | 0.5634 |
| opensearch | 0.3514 | 0.3216 | 0.1864 | 0.5618 |
| qdrant | 0.3502 | 0.3236 | 0.1826 | 0.5662 |
| weaviate | 0.3425 | 0.3193 | 0.1808 | 0.5534 |

Ingest throughput (higher is better) and query latency (lower is better). The headline latency is each engine's own server-side query time; a star marks the best in each column:

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 2041\* | 1.78\* | 0.24 | 0.30 | 0.38 |
| elasticsearch | 1199 | 3.03 | 1.00 | 1.00 | 1.00 |
| opensearch | 1151 | 3.16 | 1.00 | 1.00 | 1.00 |
| qdrant | 1243 | 2.92 | 0.34 | 0.39 | 0.42 |
| weaviate | 1219 | 2.98 | n/a | n/a | n/a |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 1.10\* | 1.25\* | 1.35\* |
| elasticsearch | 2.61 | 2.83 | 2.96 |
| opensearch | 2.35 | 2.63 | 2.75 |
| qdrant | 1.53 | 1.70 | 1.84 |
| weaviate | 4.26 | 6.58 | 10.11 |

Server-side time source per engine:

- narsil: response `elapsed` field (floating-millisecond resolution)
- elasticsearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- opensearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- qdrant: top-level `time` field, seconds converted to ms (floating-millisecond resolution)
- weaviate: client round-trip only (no server-side query time exposed)

Throughput under concurrent load (higher is better). Peak QPS is the highest sustained rate across the tested concurrency levels, and 'client-limited' flags an engine whose peak the harness capped, not the engine itself. A star marks the best:

| Engine | Peak QPS | 95% CI | At concurrency | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- |
| narsil | 2628\* | 2628 to 2645 | 16 | 10.09 | 66.20 | 2.06 | yes |
| elasticsearch | 1818 | 1817 to 1825 | 32 | 28.82 | 57.61 | 3.98 | no |
| opensearch | 1999 | 1982 to 2000 | 16 | 12.98 | 32.65 | 3.79 | no |
| qdrant | 2290 | 2286 to 2294 | 8 | 5.18 | 6.82 | 2.39 | no |
| weaviate | 709 | 708 to 713 | 16 | 45.33 | 79.33 | 6.38 | no |

Narsil has the best nDCG@10 at 0.3560 and has the fastest server-side p50 latency at 0.24 ms (among engines above the measurement floor).

### dbpedia-entities-openai-100k

Retrieval quality (higher is better). A star marks the best in each column:

| Engine | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| narsil | n/a | n/a | n/a | n/a |
| elasticsearch | n/a | n/a | n/a | n/a |
| opensearch | n/a | n/a | n/a | n/a |
| qdrant | n/a | n/a | n/a | n/a |
| weaviate | n/a | n/a | n/a | n/a |

Ingest throughput (higher is better) and query latency (lower is better). The headline latency is each engine's own server-side query time; a star marks the best in each column:

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 778\* | 128.53\* | 0.73 | 1.07 | 1.29 |
| elasticsearch | 576 | 173.48 | 2.00 | 2.00 | 3.00 |
| opensearch | 670 | 149.16 | 1.00 | 1.00 | 1.00 |
| qdrant | 711 | 140.74 | 0.68 | 0.98 | 1.28 |
| weaviate | 599 | 166.95 | n/a | n/a | n/a |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 2.57\* | 3.02\* | 3.98 |
| elasticsearch | 4.52 | 5.13 | 5.44 |
| opensearch | 3.44 | 3.72 | 3.89 |
| qdrant | 2.88 | 3.26 | 3.57\* |
| weaviate | 9.95 | 11.23 | 16.99 |

Server-side time source per engine:

- narsil: response `elapsed` field (floating-millisecond resolution)
- elasticsearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- opensearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- qdrant: top-level `time` field, seconds converted to ms (floating-millisecond resolution)
- weaviate: client round-trip only (no server-side query time exposed)

Throughput under concurrent load (higher is better). Peak QPS is the highest sustained rate across the tested concurrency levels, and 'client-limited' flags an engine whose peak the harness capped, not the engine itself. A star marks the best:

| Engine | Peak QPS | 95% CI | At concurrency | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- |
| narsil | 1335\* | 1329 to 1336 | 16 | 20.49 | 90.07 | 2.66 | no |
| elasticsearch | 1024 | 1023 to 1027 | 16 | 24.45 | 34.74 | 3.91 | no |
| opensearch | 1239 | 1232 to 1246 | 16 | 20.92 | 30.85 | 2.97 | no |
| qdrant | 1194 | 1194 to 1200 | 8 | 10.16 | 12.50 | 2.78 | no |
| weaviate | 358 | 357 to 361 | 16 | 82.46 | 143.14 | 6.40 | no |

### dbpedia-entities-openai-1m

Retrieval quality (higher is better). A star marks the best in each column:

| Engine | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| narsil | n/a | n/a | n/a | n/a |
| elasticsearch | n/a | n/a | n/a | n/a |
| opensearch | n/a | n/a | n/a | n/a |
| qdrant | n/a | n/a | n/a | n/a |
| weaviate | n/a | n/a | n/a | n/a |

Ingest throughput (higher is better) and query latency (lower is better). The headline latency is each engine's own server-side query time; a star marks the best in each column:

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 643 | 1547.94 | 3.11 | 6.45 | 9.52 |
| elasticsearch | 535 | 1860.27 | 3.00 | 5.00 | 7.00 |
| opensearch | 492 | 2023.94 | 3.00 | 5.00 | 7.00 |
| qdrant | 712\* | 1396.73\* | 1.97\* | 3.46\* | 3.98\* |
| weaviate | 584 | 1703.95 | n/a | n/a | n/a |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 5.32 | 9.16 | 12.65 |
| elasticsearch | 6.39 | 8.76 | 10.48 |
| opensearch | 5.96 | 7.98 | 9.34 |
| qdrant | 4.24\* | 5.75\* | 6.27\* |
| weaviate | 12.27 | 13.61 | 16.46 |

Server-side time source per engine:

- narsil: response `elapsed` field (floating-millisecond resolution)
- elasticsearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- opensearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- qdrant: top-level `time` field, seconds converted to ms (floating-millisecond resolution)
- weaviate: client round-trip only (no server-side query time exposed)

Throughput under concurrent load (higher is better). Peak QPS is the highest sustained rate across the tested concurrency levels, and 'client-limited' flags an engine whose peak the harness capped, not the engine itself. A star marks the best:

| Engine | Peak QPS | 95% CI | At concurrency | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- |
| narsil | 1017\* | 1014 to 1018 | 64 | 109.46 | 192.00 | 4.59 | no |
| elasticsearch | 873 | 872 to 884 | 32 | 59.02 | 86.78 | 4.47 | no |
| opensearch | 963 | 963 to 967 | 16 | 26.97 | 42.44 | 4.50 | no |
| qdrant | 912 | 909 to 915 | 64 | 117.40 | 178.55 | 4.42 | no |
| weaviate | 291 | 290 to 294 | 16 | 96.91 | 239.67 | 6.73 | no |
