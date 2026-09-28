# Search-engine comparison (equal precision (every engine full float)): keyword, vector, hybrid

## Run conditions

- Vector and hybrid tracks hold every engine at full float (no quantization) for an equal-precision comparison.
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
| meilisearch | 1.54.0 | 1380adaaceba | keyword |
| opensearch | 3.8.0 | e5a3c5691be8 | keyword, vector, hybrid |
| qdrant | 1.19.1 | 6ab21cac18eb | vector, hybrid |
| typesense | 30.2 | sha256:610f2d34b1f9 | keyword |
| weaviate | 1.39.5 | sha256:c29b501d8fda | vector, hybrid |

## Keyword track

### beir/scifact/test

Retrieval quality (higher is better). A star marks the best in each column:

| Engine | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| narsil | 0.6814\* | 0.9253\* | 0.6417\* | 0.6494 |
| elasticsearch | 0.6789 | 0.9253\* | 0.6401 | 0.6506\* |
| meilisearch | 0.5018 | 0.5982 | 0.4809 | 0.4889 |
| opensearch | 0.6789 | 0.9253\* | 0.6401 | 0.6506\* |
| typesense | 0.5407 | 0.7501 | 0.5081 | 0.5191 |

Ingest throughput (higher is better) and query latency (lower is better). The headline latency is each engine's own server-side query time; a star marks the best in each column:

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 6351\* | 0.82\* | 0.12 | 0.28 | 0.40 |
| elasticsearch | 4042 | 1.28 | 1.00 | 1.00 | 2.00 |
| meilisearch | 1430 | 3.63 | 1.00 | 3.00 | 6.00 |
| opensearch | 5190 | 1.00 | 1.00 | 1.00 | 1.00 |
| typesense | 2075 | 2.50 | 12.00 | 45.00 | 63.00 |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 0.64\* | 0.85\* | 0.94\* |
| elasticsearch | 2.63 | 3.36 | 3.82 |
| meilisearch | 2.74 | 4.26 | 7.33 |
| opensearch | 2.46 | 3.07 | 3.42 |
| typesense | 13.80 | 47.03 | 64.54 |

Server-side time source per engine:

- narsil: response `elapsed` field (floating-millisecond resolution)
- elasticsearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- meilisearch: response `processingTimeMs` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- opensearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- typesense: response `search_time_ms` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)

Throughput under concurrent load (higher is better). Peak QPS is the highest sustained rate across the tested concurrency levels, and 'client-limited' flags an engine whose peak the harness capped, not the engine itself. A star marks the best:

| Engine | Peak QPS | 95% CI | At concurrency | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- |
| narsil | 4200\* | 4169 to 4212 | 8 | 2.91 | 5.10 | 1.57 | yes |
| elasticsearch | 2796 | 2750 to 2798 | 16 | 9.54 | 34.22 | 3.62 | no |
| meilisearch | 1559 | 1551 to 1565 | 16 | 16.60 | 41.20 | 5.45 | no |
| opensearch | 3027 | 2989 to 3031 | 16 | 8.72 | 29.98 | 3.41 | no |
| typesense | 331 | 331 to 333 | 32 | 271.06 | 572.10 | 7.47 | no |

Narsil has the best nDCG@10 at 0.6814 and has the fastest server-side p50 latency at 0.12 ms (among engines above the measurement floor).

### beir/nfcorpus/test

Retrieval quality (higher is better). A star marks the best in each column:

| Engine | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| narsil | 0.3278\* | 0.2489\* | 0.1532\* | 0.5305\* |
| elasticsearch | 0.3206 | 0.2457 | 0.1503 | 0.5255 |
| meilisearch | 0.2671 | 0.1553 | 0.1221 | 0.4443 |
| opensearch | 0.3206 | 0.2457 | 0.1503 | 0.5255 |
| typesense | 0.2237 | 0.2075 | 0.1101 | 0.3868 |

Ingest throughput (higher is better) and query latency (lower is better). The headline latency is each engine's own server-side query time; a star marks the best in each column:

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 7231 | 0.50 | 0.04 | 0.17 | 0.25 |
| elasticsearch | 7646\* | 0.48\* | &lt;1 | &lt;1 | &lt;1 |
| meilisearch | 1462 | 2.49 | &lt;1 | 1.00 | 2.00 |
| opensearch | 7185 | 0.51 | &lt;1 | &lt;1 | &lt;1 |
| typesense | 1890 | 1.92 | &lt;1 | 5.00 | 9.00 |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 0.54\* | 0.80\* | 0.99\* |
| elasticsearch | 1.23 | 1.45 | 1.57 |
| meilisearch | 1.83 | 2.77 | 3.41 |
| opensearch | 1.23 | 1.46 | 1.57 |
| typesense | 1.41 | 6.39 | 10.47 |

Server-side time source per engine:

- narsil: response `elapsed` field (floating-millisecond resolution)
- elasticsearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- meilisearch: response `processingTimeMs` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- opensearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- typesense: response `search_time_ms` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)

Throughput under concurrent load (higher is better). Peak QPS is the highest sustained rate across the tested concurrency levels, and 'client-limited' flags an engine whose peak the harness capped, not the engine itself. A star marks the best:

| Engine | Peak QPS | 95% CI | At concurrency | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- |
| narsil | 4940\* | 4719 to 4950 | 4 | 1.03 | 1.45 | 0.89 | no |
| elasticsearch | 3128 | 3128 to 3137 | 8 | 3.78 | 10.40 | 2.60 | no |
| meilisearch | 2428 | 2419 to 2463 | 16 | 10.59 | 29.64 | 4.15 | no |
| opensearch | 3252 | 3250 to 3261 | 16 | 8.04 | 17.54 | 2.79 | no |
| typesense | 2376 | 2365 to 2379 | 64 | 49.89 | 92.05 | 3.22 | no |

Narsil has the best nDCG@10 at 0.3278 and has the fastest server-side p50 latency at 0.04 ms (among engines above the measurement floor).

### dbpedia-entities-openai-100k

Retrieval quality (higher is better). A star marks the best in each column:

| Engine | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| narsil | n/a | n/a | n/a | n/a |
| elasticsearch | n/a | n/a | n/a | n/a |
| meilisearch | n/a | n/a | n/a | n/a |
| opensearch | n/a | n/a | n/a | n/a |
| typesense | n/a | n/a | n/a | n/a |

Ingest throughput (higher is better) and query latency (lower is better). The headline latency is each engine's own server-side query time; a star marks the best in each column:

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 33179 | 3.01 | 0.12 | 0.64 | 1.09 |
| elasticsearch | 38836\* | 2.57\* | &lt;1 | &lt;1 | &lt;1 |
| meilisearch | 4536 | 22.05 | 1.00 | 2.00 | 3.00 |
| opensearch | 38105 | 2.62 | &lt;1 | &lt;1 | &lt;1 |
| typesense | 8765 | 11.41 | &lt;1 | 10.00 | 18.00 |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 0.77\* | 1.48\* | 2.16 |
| elasticsearch | 1.25 | 1.58 | 1.76 |
| meilisearch | 2.14 | 3.49 | 4.41 |
| opensearch | 1.21 | 1.51 | 1.67\* |
| typesense | 1.76 | 11.63 | 19.17 |

Server-side time source per engine:

- narsil: response `elapsed` field (floating-millisecond resolution)
- elasticsearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- meilisearch: response `processingTimeMs` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- opensearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- typesense: response `search_time_ms` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)

Throughput under concurrent load (higher is better). Peak QPS is the highest sustained rate across the tested concurrency levels, and 'client-limited' flags an engine whose peak the harness capped, not the engine itself. A star marks the best:

| Engine | Peak QPS | 95% CI | At concurrency | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- |
| narsil | 4397\* | 4327 to 4401 | 8 | 2.82 | 5.42 | 1.42 | yes |
| elasticsearch | 3100 | 3075 to 3118 | 8 | 3.85 | 9.69 | 2.67 | no |
| meilisearch | 2039 | 2037 to 2044 | 32 | 22.59 | 51.57 | 4.72 | no |
| opensearch | 3242 | 3232 to 3245 | 16 | 8.07 | 17.71 | 2.80 | no |
| typesense | 1908 | 1906 to 1913 | 32 | 36.75 | 113.80 | 5.32 | no |

### dbpedia-entities-openai-1m

Retrieval quality (higher is better). A star marks the best in each column:

| Engine | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| narsil | n/a | n/a | n/a | n/a |
| elasticsearch | n/a | n/a | n/a | n/a |
| meilisearch | n/a | n/a | n/a | n/a |
| opensearch | n/a | n/a | n/a | n/a |
| typesense | n/a | n/a | n/a | n/a |

Ingest throughput (higher is better) and query latency (lower is better). The headline latency is each engine's own server-side query time; a star marks the best in each column:

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 33616 | 29.60 | 2.72 | 9.83 | 14.90 |
| elasticsearch | 42304\* | 23.52\* | &lt;1 | 1.00 | 1.00 |
| meilisearch | 479 | 2078.10 | 3.00 | 8.00 | 11.00 |
| opensearch | 41740 | 23.84 | &lt;1 | 1.00 | 1.00 |
| typesense | 7456 | 133.45 | 2.00 | 25.00 | 48.00 |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 3.67 | 11.28 | 18.11 |
| elasticsearch | 1.44 | 1.93\* | 2.23\* |
| meilisearch | 3.89 | 9.18 | 12.35 |
| opensearch | 1.36\* | 1.95 | 2.39 |
| typesense | 3.27 | 26.68 | 49.01 |

Server-side time source per engine:

- narsil: response `elapsed` field (floating-millisecond resolution)
- elasticsearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- meilisearch: response `processingTimeMs` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- opensearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- typesense: response `search_time_ms` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)

Throughput under concurrent load (higher is better). Peak QPS is the highest sustained rate across the tested concurrency levels, and 'client-limited' flags an engine whose peak the harness capped, not the engine itself. A star marks the best:

| Engine | Peak QPS | 95% CI | At concurrency | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- |
| narsil | 2842 | 2758 to 2888 | 16 | 12.94 | 40.46 | 4.82 | no |
| elasticsearch | 2782 | 2773 to 2785 | 16 | 9.54 | 27.52 | 3.78 | no |
| meilisearch | 1144 | 1134 to 1149 | 64 | 70.97 | 101.63 | 5.91 | no |
| opensearch | 2994\* | 2956 to 2999 | 16 | 8.95 | 27.69 | 3.55 | no |
| typesense | 1782 | 1782 to 1798 | 64 | 62.54 | 120.82 | 5.44 | no |

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
| narsil | efSearch | 64 | 0.9943 | yes |
| elasticsearch | num_candidates | 64 | 0.9940 | yes |
| opensearch | ef_search | 64 | 0.9957 | yes |
| qdrant | hnsw_ef | 32 | 0.9937 | yes |
| weaviate | ef | 64 | 0.9967 | yes |

Ingest throughput (higher is better) and query latency (lower is better). The headline latency is each engine's own server-side query time; a star marks the best in each column:

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 2112\* | 2.45\* | 0.16 | 0.19 | 0.21 |
| elasticsearch | 1111 | 4.66 | &lt;1 | 1.00 | 1.00 |
| opensearch | 1002 | 5.17 | &lt;1 | &lt;1 | 1.00 |
| qdrant | 1510 | 3.43 | 0.25 | 0.30 | 0.34 |
| weaviate | 1426 | 3.63 | n/a | n/a | n/a |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 1.00\* | 1.24\* | 1.36\* |
| elasticsearch | 1.83 | 2.75 | 2.94 |
| opensearch | 1.80 | 2.22 | 2.41 |
| qdrant | 1.32 | 1.53 | 1.66 |
| weaviate | 3.19 | 4.02 | 6.86 |

Server-side time source per engine:

- narsil: response `elapsed` field (floating-millisecond resolution)
- elasticsearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- opensearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- qdrant: top-level `time` field, seconds converted to ms (floating-millisecond resolution)
- weaviate: client round-trip only (no server-side query time exposed)

Throughput under concurrent load (higher is better). Peak QPS is the highest sustained rate across the tested concurrency levels, and 'client-limited' flags an engine whose peak the harness capped, not the engine itself. A star marks the best:

| Engine | Peak QPS | 95% CI | At concurrency | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- |
| narsil | 2824\* | 2820 to 2837 | 8 | 4.22 | 7.44 | 1.38 | yes |
| elasticsearch | 2235 | 2208 to 2236 | 16 | 11.44 | 33.78 | 2.64 | no |
| opensearch | 2300 | 2297 to 2304 | 16 | 11.17 | 30.37 | 2.67 | no |
| qdrant | 2413 | 2411 to 2417 | 8 | 4.84 | 6.23 | 2.01 | yes |
| weaviate | 1233 | 1222 to 1234 | 16 | 24.56 | 41.97 | 5.60 | no |

Narsil ties for the best nDCG@10 (5-way tie at 0.6239) and has the fastest server-side p50 latency at 0.16 ms (among engines above the measurement floor).

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
| narsil | efSearch | 128 | 0.9941 | yes |
| elasticsearch | num_candidates | 192 | 0.9904 | yes |
| opensearch | ef_search | 128 | 0.9947 | yes |
| qdrant | hnsw_ef | 64 | 0.9960 | yes |
| weaviate | ef | 192 | 0.9957 | yes |

Ingest throughput (higher is better) and query latency (lower is better). The headline latency is each engine's own server-side query time; a star marks the best in each column:

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 1979\* | 1.84\* | 0.20 | 0.24 | 0.27 |
| elasticsearch | 1260 | 2.88 | &lt;1 | &lt;1 | &lt;1 |
| opensearch | 1120 | 3.24 | &lt;1 | &lt;1 | &lt;1 |
| qdrant | 1257 | 2.89 | 0.28 | 0.32 | 0.35 |
| weaviate | 1217 | 2.98 | n/a | n/a | n/a |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 1.06\* | 1.25\* | 1.40\* |
| elasticsearch | 1.92 | 2.08 | 2.23 |
| opensearch | 1.76 | 1.96 | 2.07 |
| qdrant | 1.38 | 1.56 | 1.71 |
| weaviate | 3.32 | 4.23 | 6.23 |

Server-side time source per engine:

- narsil: response `elapsed` field (floating-millisecond resolution)
- elasticsearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- opensearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- qdrant: top-level `time` field, seconds converted to ms (floating-millisecond resolution)
- weaviate: client round-trip only (no server-side query time exposed)

Throughput under concurrent load (higher is better). Peak QPS is the highest sustained rate across the tested concurrency levels, and 'client-limited' flags an engine whose peak the harness capped, not the engine itself. A star marks the best:

| Engine | Peak QPS | 95% CI | At concurrency | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- |
| narsil | 2744\* | 2744 to 2752 | 8 | 4.35 | 7.74 | 1.56 | no |
| elasticsearch | 2168 | 2152 to 2176 | 16 | 11.76 | 35.03 | 2.91 | no |
| opensearch | 2253 | 2244 to 2253 | 16 | 11.46 | 32.04 | 2.82 | no |
| qdrant | 2359 | 2354 to 2364 | 8 | 5.01 | 6.53 | 2.19 | no |
| weaviate | 1172 | 1169 to 1172 | 16 | 25.87 | 44.99 | 5.70 | no |

Narsil ties for the best nDCG@10 (5-way tie at 0.3145) and has the fastest server-side p50 latency at 0.20 ms (among engines above the measurement floor).

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
| narsil | efSearch | 128 | 0.9907 | yes |
| elasticsearch | num_candidates | 768 | 0.9922 | yes |
| opensearch | ef_search | 128 | 0.9918 | yes |
| qdrant | hnsw_ef | 128 | 0.9942 | yes |
| weaviate | ef | 192 | 0.9931 | yes |

Ingest throughput (higher is better) and query latency (lower is better). The headline latency is each engine's own server-side query time; a star marks the best in each column:

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 745\* | 134.18\* | 1.45 | 1.99 | 2.18 |
| elasticsearch | 546 | 183.27 | 2.00 | 3.00 | 4.00 |
| opensearch | 366 | 273.58 | 1.00 | 1.00 | 1.00 |
| qdrant | 715 | 139.82 | 1.57 | 2.16 | 2.54 |
| weaviate | 574 | 174.10 | n/a | n/a | n/a |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 3.31\* | 3.89 | 4.46 |
| elasticsearch | 4.91 | 6.27 | 6.90 |
| opensearch | 3.45 | 3.87\* | 4.04\* |
| qdrant | 3.63 | 4.23 | 4.61 |
| weaviate | 9.44 | 10.66 | 13.03 |

Server-side time source per engine:

- narsil: response `elapsed` field (floating-millisecond resolution)
- elasticsearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- opensearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- qdrant: top-level `time` field, seconds converted to ms (floating-millisecond resolution)
- weaviate: client round-trip only (no server-side query time exposed)

Throughput under concurrent load (higher is better). Peak QPS is the highest sustained rate across the tested concurrency levels, and 'client-limited' flags an engine whose peak the harness capped, not the engine itself. A star marks the best:

| Engine | Peak QPS | 95% CI | At concurrency | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- |
| narsil | 1197 | 1194 to 1203 | 32 | 43.58 | 70.02 | 3.17 | no |
| elasticsearch | 986 | 980 to 996 | 16 | 25.94 | 57.26 | 4.00 | no |
| opensearch | 1211\* | 1209 to 1216 | 16 | 21.60 | 31.32 | 2.93 | no |
| qdrant | 841 | 833 to 841 | 32 | 63.87 | 92.78 | 4.61 | no |
| weaviate | 467 | 467 to 469 | 8 | 23.73 | 37.69 | 5.91 | no |

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
| narsil | efSearch | 384 | 0.9936 | yes |
| elasticsearch | num_candidates | 2048 | 0.9921 | yes |
| opensearch | ef_search | 384 | 0.9940 | yes |
| qdrant | hnsw_ef | 192 | 0.9931 | yes |
| weaviate | ef | 512 | 0.9942 | yes |

Ingest throughput (higher is better) and query latency (lower is better). The headline latency is each engine's own server-side query time; a star marks the best in each column:

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 498 | 1996.66 | 6.32 | 8.99 | 9.54 |
| elasticsearch | 471 | 2110.50 | 6.00 | 10.00 | 12.00 |
| opensearch | 191 | 5218.66 | 4.00 | 5.00\* | 6.00\* |
| qdrant | 618\* | 1609.15\* | 3.69\* | 5.39 | 6.33 |
| weaviate | 550 | 1810.05 | n/a | n/a | n/a |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 8.24 | 10.94 | 11.70 |
| elasticsearch | 8.86 | 13.17 | 15.07 |
| opensearch | 6.31 | 7.85 | 8.78 |
| qdrant | 5.81\* | 7.50\* | 8.49\* |
| weaviate | 13.70 | 15.67 | 16.95 |

Server-side time source per engine:

- narsil: response `elapsed` field (floating-millisecond resolution)
- elasticsearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- opensearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- qdrant: top-level `time` field, seconds converted to ms (floating-millisecond resolution)
- weaviate: client round-trip only (no server-side query time exposed)

Throughput under concurrent load (higher is better). Peak QPS is the highest sustained rate across the tested concurrency levels, and 'client-limited' flags an engine whose peak the harness capped, not the engine itself. A star marks the best:

| Engine | Peak QPS | 95% CI | At concurrency | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- |
| narsil | 670 | 663 to 675 | 16 | 43.48 | 89.14 | 5.53 | no |
| elasticsearch | 609 | 609 to 614 | 16 | 42.57 | 64.09 | 5.67 | no |
| opensearch | 869\* | 869 to 872 | 16 | 30.14 | 44.07 | 4.66 | no |
| qdrant | 525 | 522 to 529 | 64 | 162.16 | 226.20 | 5.89 | no |
| weaviate | 362 | 359 to 371 | 16 | 72.89 | 138.53 | 6.37 | no |

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
| narsil | 1971\* | 2.63\* | 0.32 | 0.47 | 0.60 |
| elasticsearch | 1424 | 3.64 | 1.00 | 1.00 | 2.00 |
| opensearch | 1090 | 4.75 | 1.00 | 2.00 | 2.00 |
| qdrant | 1573 | 3.29 | 0.37 | 0.43 | 0.45\* |
| weaviate | 1467 | 3.53 | n/a | n/a | n/a |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 1.21\* | 1.43\* | 1.57\* |
| elasticsearch | 3.03 | 3.61 | 3.90 |
| opensearch | 2.81 | 3.42 | 3.72 |
| qdrant | 1.56 | 1.73 | 1.86 |
| weaviate | 4.13 | 5.87 | 9.50 |

Server-side time source per engine:

- narsil: response `elapsed` field (floating-millisecond resolution)
- elasticsearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- opensearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- qdrant: top-level `time` field, seconds converted to ms (floating-millisecond resolution)
- weaviate: client round-trip only (no server-side query time exposed)

Throughput under concurrent load (higher is better). Peak QPS is the highest sustained rate across the tested concurrency levels, and 'client-limited' flags an engine whose peak the harness capped, not the engine itself. A star marks the best:

| Engine | Peak QPS | 95% CI | At concurrency | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- |
| narsil | 2602\* | 2588 to 2604 | 16 | 10.18 | 28.55 | 1.98 | yes |
| elasticsearch | 1753 | 1749 to 1754 | 32 | 30.20 | 56.21 | 4.23 | no |
| opensearch | 1775 | 1771 to 1781 | 16 | 14.62 | 37.12 | 4.32 | no |
| qdrant | 2238 | 2237 to 2248 | 8 | 5.30 | 6.83 | 2.42 | no |
| weaviate | 679 | 670 to 680 | 16 | 43.50 | 81.24 | 6.53 | no |

Narsil ranks 4/5 on nDCG@10 (best: qdrant, 0.7141) and has the fastest server-side p50 latency at 0.32 ms (among engines above the measurement floor).

### beir/nfcorpus/test

Retrieval quality (higher is better). A star marks the best in each column:

| Engine | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| narsil | 0.3560\* | 0.3239\* | 0.1878\* | 0.5745\* |
| elasticsearch | 0.3521 | 0.3215 | 0.1867 | 0.5649 |
| opensearch | 0.3522 | 0.3215 | 0.1867 | 0.5649 |
| qdrant | 0.3499 | 0.3235 | 0.1826 | 0.5640 |
| weaviate | 0.3425 | 0.3195 | 0.1808 | 0.5548 |

Ingest throughput (higher is better) and query latency (lower is better). The headline latency is each engine's own server-side query time; a star marks the best in each column:

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 1952\* | 1.86\* | 0.27 | 0.34 | 0.41 |
| elasticsearch | 1253 | 2.90 | 1.00 | 1.00 | 1.00 |
| opensearch | 1147 | 3.17 | 1.00 | 1.00 | 1.00 |
| qdrant | 1296 | 2.80 | 0.36 | 0.41 | 0.45 |
| weaviate | 1245 | 2.92 | n/a | n/a | n/a |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 1.16\* | 1.45\* | 1.62\* |
| elasticsearch | 2.45 | 2.68 | 2.91 |
| opensearch | 2.36 | 2.74 | 2.97 |
| qdrant | 1.58 | 1.72 | 1.86 |
| weaviate | 4.05 | 5.99 | 9.37 |

Server-side time source per engine:

- narsil: response `elapsed` field (floating-millisecond resolution)
- elasticsearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- opensearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- qdrant: top-level `time` field, seconds converted to ms (floating-millisecond resolution)
- weaviate: client round-trip only (no server-side query time exposed)

Throughput under concurrent load (higher is better). Peak QPS is the highest sustained rate across the tested concurrency levels, and 'client-limited' flags an engine whose peak the harness capped, not the engine itself. A star marks the best:

| Engine | Peak QPS | 95% CI | At concurrency | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- |
| narsil | 2633\* | 2619 to 2639 | 16 | 10.05 | 28.25 | 1.78 | yes |
| elasticsearch | 1859 | 1858 to 1873 | 16 | 13.39 | 43.66 | 3.85 | no |
| opensearch | 1934 | 1931 to 1937 | 16 | 13.43 | 32.86 | 3.90 | no |
| qdrant | 2234 | 2230 to 2234 | 8 | 5.32 | 6.82 | 2.50 | no |
| weaviate | 766 | 765 to 767 | 32 | 97.11 | 239.57 | 6.37 | no |

Narsil has the best nDCG@10 at 0.3560 and has the fastest server-side p50 latency at 0.27 ms (among engines above the measurement floor).

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
| narsil | 739\* | 135.36\* | 1.62 | 2.22 | 2.48 |
| elasticsearch | 571 | 175.15 | 2.00 | 4.00 | 4.00 |
| opensearch | 370 | 270.29 | 1.00 | 2.00\* | 2.00\* |
| qdrant | 734 | 136.24 | 1.68 | 2.41 | 2.81 |
| weaviate | 579 | 172.63 | n/a | n/a | n/a |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 3.50\* | 4.25\* | 5.11 |
| elasticsearch | 5.26 | 6.58 | 7.18 |
| opensearch | 3.97 | 4.44 | 4.64\* |
| qdrant | 3.93 | 4.66 | 5.09 |
| weaviate | 10.16 | 11.06 | 13.51 |

Server-side time source per engine:

- narsil: response `elapsed` field (floating-millisecond resolution)
- elasticsearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- opensearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- qdrant: top-level `time` field, seconds converted to ms (floating-millisecond resolution)
- weaviate: client round-trip only (no server-side query time exposed)

Throughput under concurrent load (higher is better). Peak QPS is the highest sustained rate across the tested concurrency levels, and 'client-limited' flags an engine whose peak the harness capped, not the engine itself. A star marks the best:

| Engine | Peak QPS | 95% CI | At concurrency | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- |
| narsil | 1187\* | 1185 to 1190 | 16 | 23.14 | 38.43 | 3.44 | no |
| elasticsearch | 907 | 901 to 912 | 16 | 27.55 | 42.23 | 4.21 | no |
| opensearch | 1110 | 1109 to 1114 | 16 | 23.27 | 35.08 | 3.49 | no |
| qdrant | 777 | 776 to 781 | 64 | 133.94 | 202.21 | 4.75 | no |
| weaviate | 396 | 395 to 402 | 16 | 71.94 | 126.63 | 6.31 | no |

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
| narsil | 477 | 2085.44 | 7.01 | 10.40 | 13.00 |
| elasticsearch | 406 | 2453.13 | 7.00 | 11.00 | 13.00 |
| opensearch | 188 | 5290.81 | 4.00 | 6.00\* | 7.00\* |
| qdrant | 633\* | 1573.00\* | 3.96\* | 6.04 | 7.22 |
| weaviate | 548 | 1816.34 | n/a | n/a | n/a |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 9.03 | 12.57 | 15.61 |
| elasticsearch | 9.51 | 14.02 | 16.10 |
| opensearch | 6.96 | 8.90 | 10.13 |
| qdrant | 6.26\* | 8.36\* | 9.53\* |
| weaviate | 16.17 | 33.04 | 41.59 |

Server-side time source per engine:

- narsil: response `elapsed` field (floating-millisecond resolution)
- elasticsearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- opensearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- qdrant: top-level `time` field, seconds converted to ms (floating-millisecond resolution)
- weaviate: client round-trip only (no server-side query time exposed)

Throughput under concurrent load (higher is better). Peak QPS is the highest sustained rate across the tested concurrency levels, and 'client-limited' flags an engine whose peak the harness capped, not the engine itself. A star marks the best:

| Engine | Peak QPS | 95% CI | At concurrency | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- |
| narsil | 617 | 616 to 621 | 64 | 173.51 | 266.36 | 5.77 | no |
| elasticsearch | 570 | 566 to 572 | 64 | 168.27 | 222.74 | 5.79 | no |
| opensearch | 792\* | 791 to 795 | 64 | 119.59 | 215.81 | 5.20 | no |
| qdrant | 489 | 488 to 495 | 64 | 170.21 | 230.15 | 6.12 | no |
| weaviate | 307 | 301 to 307 | 16 | 85.00 | 138.71 | 6.69 | no |
