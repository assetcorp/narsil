# Search-engine comparison (equal precision (every engine full float)): keyword, vector, hybrid

## Run conditions

- Vector and hybrid tracks hold every engine at full float (no quantization) for an equal-precision comparison.
- OS / arch: Linux 6.12.76-linuxkit / aarch64
- Equal memory cap per engine: 8.6 GB
- Run depth: 1000; BM25 reference k1=0.9, b=0.4
- Shared embedding model: sentence-transformers/all-MiniLM-L6-v2 (384 dim, cosine); latency on the vector track is compared at matched ANN recall@10 >= 0.99.
- Same datasets, metrics, run depth, and strictly-decreasing run-file ordering for every engine.
- Dataset beir/scifact/test: content md5 5f7d1de60b170fc8027bb7898e2efca1 (ir_datasets-verified archive)
- Dataset beir/nfcorpus/test: content md5 a89dba18a62ef92f7d323ec890a0d38d (ir_datasets-verified archive)
- Headline latency is each engine's own reported query time, captured from the same call the client round-trip is timed around. Resolution differs by engine and is disclosed per engine; an engine that reports no server-side time shows it as not-available and is compared on client round-trip only.

## Engines and tracks

| Engine | Version | Build | Tracks |
| --- | --- | --- | --- |
| narsil | source (node:22-trixie-slim) | ab7fdf7bb864 | keyword, vector, hybrid |
| elasticsearch | 9.4.2 | c402c2b36d90 | keyword, vector, hybrid |
| meilisearch | 1.48.2 | 96d2d029e40b | keyword |
| opensearch | 3.7.0 | 72121f014083 | keyword, vector, hybrid |
| qdrant | v1.18.2 | 44ad62f8cd69 | vector, hybrid |
| typesense | 30.2 | sha256:610f2d34b1f9 | keyword |
| weaviate | 1.38.2 | sha256:107e8faae40e | vector, hybrid |

## Keyword track

### beir/scifact/test

Retrieval quality, higher is better (* marks the best in each column):

| Engine | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| narsil | 0.6781 | 0.9320\* | 0.6379 | 0.6456 |
| elasticsearch | 0.6789\* | 0.9253 | 0.6401\* | 0.6506\* |
| meilisearch | 0.3748 | 0.5302 | 0.3467 | 0.3534 |
| opensearch | 0.6789\* | 0.9253 | 0.6401\* | 0.6506\* |
| typesense | 0.3728 | 0.3923 | 0.3659 | 0.3784 |

Ingest and latency, latency lower is better (* marks the best in each column). The headline latency is each engine's own reported query time (server-side):

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 3937\* | 1.32\* | 0.54\* | 1.16\* | 1.61\* |
| elasticsearch | 1135 | 4.57 | 3.00 | 7.00 | 15.00 |
| meilisearch | 1383 | 3.75 | 0.00 | 2.00 | 4.00 |
| opensearch | 2546 | 2.04 | 1.00 | 4.00 | 7.00 |
| typesense | 2042 | 2.54 | 12.00 | 57.00 | 98.00 |

Client round-trip latency, the same queries timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 0.96\* | 1.76\* | 2.39\* |
| elasticsearch | 6.44 | 13.43 | 24.31 |
| meilisearch | 1.42 | 3.35 | 4.98 |
| opensearch | 3.20 | 7.82 | 11.93 |
| typesense | 13.80 | 58.99 | 99.25 |

Server-side time source per engine:

- narsil: response `elapsed` field (floating-millisecond resolution)
- elasticsearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- meilisearch: response `processingTimeMs` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- opensearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- typesense: response `search_time_ms` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)

Throughput under concurrent load, higher is better (* marks the best). Peak QPS is the highest sustained rate across the configured concurrency levels; client-limited marks an engine whose peak was capped by the harness rather than the engine:

| Engine | Peak QPS | At concurrency | Under-load p95 ms | Client-limited |
| --- | --- | --- | --- | --- |
| narsil | 1385 | 16 | 20.54 | no |
| elasticsearch | 364 | 16 | 86.33 | no |
| meilisearch | 1443\* | 16 | 19.86 | no |
| opensearch | 1168 | 16 | 29.05 | no |
| typesense | 269 | 16 | 179.62 | no |

Narsil standing: nDCG@10 rank 3/5 (best elasticsearch 0.6789); server-side p50 latency rank 1/3 (fastest narsil 0.54 ms, among engines whose server-side timing is above the measurement floor).

### beir/nfcorpus/test

Retrieval quality, higher is better (* marks the best in each column):

| Engine | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| narsil | 0.3269\* | 0.2491\* | 0.1530\* | 0.5284\* |
| elasticsearch | 0.3206 | 0.2457 | 0.1503 | 0.5255 |
| meilisearch | 0.2550 | 0.1701 | 0.1167 | 0.4338 |
| opensearch | 0.3206 | 0.2457 | 0.1503 | 0.5255 |
| typesense | 0.1817 | 0.1123 | 0.0839 | 0.3372 |

Ingest and latency, latency lower is better (* marks the best in each column). The headline latency is each engine's own reported query time (server-side):

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 5565 | 0.65 | 0.10 | 0.56\* | 0.84\* |
| elasticsearch | 3729 | 0.97 | 1.00 | 1.00 | 2.00 |
| meilisearch | 1695 | 2.14 | 0.00 | 1.00 | 1.00 |
| opensearch | 10370\* | 0.35\* | 0.00 | 0.00 | 2.00 |
| typesense | 3432 | 1.06 | 0.00 | 4.00 | 10.00 |

Client round-trip latency, the same queries timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 0.53\* | 1.05\* | 1.42\* |
| elasticsearch | 2.92 | 4.82 | 8.05 |
| meilisearch | 0.87 | 1.56 | 2.04 |
| opensearch | 0.73 | 1.94 | 3.98 |
| typesense | 0.76 | 6.32 | 12.05 |

Server-side time source per engine:

- narsil: response `elapsed` field (floating-millisecond resolution)
- elasticsearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- meilisearch: response `processingTimeMs` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- opensearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- typesense: response `search_time_ms` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)

Throughput under concurrent load, higher is better (* marks the best). Peak QPS is the highest sustained rate across the configured concurrency levels; client-limited marks an engine whose peak was capped by the harness rather than the engine:

| Engine | Peak QPS | At concurrency | Under-load p95 ms | Client-limited |
| --- | --- | --- | --- | --- |
| narsil | 2125\* | 16 | 12.78 | no |
| elasticsearch | 292 | 16 | 120.74 | no |
| meilisearch | 1789 | 16 | 16.40 | no |
| opensearch | 1680 | 16 | 19.02 | no |
| typesense | 1781 | 16 | 18.59 | no |

Narsil standing: nDCG@10 rank 1/5 (best narsil 0.3269); server-side p50 latency rank 1/1 (fastest narsil 0.10 ms, among engines whose server-side timing is above the measurement floor).

## Vector track

### beir/scifact/test

Retrieval quality, higher is better (* marks the best in each column):

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
| narsil | efSearch | 64 | 0.9967 | yes |
| elasticsearch | num_candidates | 64 | 0.9947 | yes |
| opensearch | ef_search | 64 | 0.9947 | yes |
| qdrant | hnsw_ef | 64 | 0.9970 | yes |
| weaviate | ef | 64 | 0.9953 | yes |

Ingest and latency, latency lower is better (* marks the best in each column). The headline latency is each engine's own reported query time (server-side):

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 422 | 12.29 | 0.58 | 1.03 | 1.34 |
| elasticsearch | 528 | 9.81 | 0.00 | 1.00 | 2.00 |
| opensearch | 1147\* | 4.52\* | 1.00 | 3.00 | 5.00 |
| qdrant | 780 | 6.65 | 0.23\* | 0.36\* | 0.59\* |
| weaviate | 416 | 12.45 | n/a | n/a | n/a |

Client round-trip latency, the same queries timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 2.82 | 3.71 | 4.30 |
| elasticsearch | 1.22 | 2.91 | 4.38 |
| opensearch | 2.47 | 6.70 | 9.98 |
| qdrant | 0.73\* | 1.05\* | 1.79\* |
| weaviate | 6.55 | 15.29 | 24.80 |

Server-side time source per engine:

- narsil: response `elapsed` field (floating-millisecond resolution)
- elasticsearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- opensearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- qdrant: top-level `time` field (seconds, converted to ms) (floating-millisecond resolution)
- weaviate: client round-trip only (no server-side query time exposed)

Throughput under concurrent load, higher is better (* marks the best). Peak QPS is the highest sustained rate across the configured concurrency levels; client-limited marks an engine whose peak was capped by the harness rather than the engine:

| Engine | Peak QPS | At concurrency | Under-load p95 ms | Client-limited |
| --- | --- | --- | --- | --- |
| narsil | 536 | 16 | 52.51 | no |
| elasticsearch | 891 | 16 | 43.09 | no |
| opensearch | 768 | 16 | 45.03 | no |
| qdrant | 1604\* | 16 | 17.73 | no |
| weaviate | 209 | 16 | 183.69 | no |

Narsil standing: nDCG@10 rank 1/5 (best narsil 0.6239); server-side p50 latency rank 2/2 (fastest qdrant 0.23 ms, among engines whose server-side timing is above the measurement floor).

### beir/nfcorpus/test

Retrieval quality, higher is better (* marks the best in each column):

| Engine | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| narsil | 0.3145 | 0.3094 | 0.1575 | 0.5168 |
| elasticsearch | 0.3145 | 0.3094 | 0.1575 | 0.5168 |
| opensearch | 0.3145 | 0.3094 | 0.1575\* | 0.5168 |
| qdrant | 0.3145 | 0.3094 | 0.1575 | 0.5168\* |
| weaviate | 0.3145 | 0.3094 | 0.1575 | 0.5168 |

Matched-recall operating point per engine:

| Engine | Knob | Value | ANN recall@k | Target met |
| --- | --- | --- | --- | --- |
| narsil | efSearch | 128 | 0.9947 | yes |
| elasticsearch | num_candidates | 128 | 0.9910 | yes |
| opensearch | ef_search | 128 | 0.9935 | yes |
| qdrant | hnsw_ef | 128 | 0.9947 | yes |
| weaviate | ef | 128 | 0.9941 | yes |

Ingest and latency, latency lower is better (* marks the best in each column). The headline latency is each engine's own reported query time (server-side):

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 599 | 6.06 | 1.25 | 3.14 | 5.89 |
| elasticsearch | 650 | 5.59 | 2.00 | 4.00 | 8.00 |
| opensearch | 1424 | 2.55 | 0.00 | 2.00 | 3.00 |
| qdrant | 1569\* | 2.32\* | 0.28\* | 0.52\* | 1.06\* |
| weaviate | 634 | 5.73 | n/a | n/a | n/a |

Client round-trip latency, the same queries timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 3.95 | 8.26 | 13.68 |
| elasticsearch | 4.93 | 9.19 | 15.66 |
| opensearch | 1.49 | 5.87 | 7.87 |
| qdrant | 0.83\* | 1.47\* | 3.34\* |
| weaviate | 7.50 | 18.47 | 42.81 |

Server-side time source per engine:

- narsil: response `elapsed` field (floating-millisecond resolution)
- elasticsearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- opensearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- qdrant: top-level `time` field (seconds, converted to ms) (floating-millisecond resolution)
- weaviate: client round-trip only (no server-side query time exposed)

Throughput under concurrent load, higher is better (* marks the best). Peak QPS is the highest sustained rate across the configured concurrency levels; client-limited marks an engine whose peak was capped by the harness rather than the engine:

| Engine | Peak QPS | At concurrency | Under-load p95 ms | Client-limited |
| --- | --- | --- | --- | --- |
| narsil | 500 | 16 | 53.78 | no |
| elasticsearch | 759 | 16 | 65.72 | no |
| opensearch | 1343\* | 16 | 22.21 | no |
| qdrant | 1147 | 16 | 34.43 | no |
| weaviate | 228 | 16 | 129.33 | no |

Narsil standing: nDCG@10 rank 1/5 (best narsil 0.3145); server-side p50 latency rank 2/3 (fastest qdrant 0.28 ms, among engines whose server-side timing is above the measurement floor).

## Hybrid track

### beir/scifact/test

Retrieval quality, higher is better (* marks the best in each column):

| Engine | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| narsil | 0.7015 | 0.9643\* | 0.6532 | 0.6596 |
| elasticsearch | 0.7053 | 0.9610 | 0.6587 | 0.6643 |
| opensearch | 0.7053 | 0.9610 | 0.6587 | 0.6643 |
| qdrant | 0.7155\* | 0.9577 | 0.6730\* | 0.6762\* |
| weaviate | 0.6885 | 0.9577 | 0.6405 | 0.6513 |

Ingest and latency, latency lower is better (* marks the best in each column). The headline latency is each engine's own reported query time (server-side):

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 625 | 8.29 | 1.43 | 2.87 | 4.56 |
| elasticsearch | 1088 | 4.76 | 1.00 | 2.00 | 4.00 |
| opensearch | 801 | 6.47 | 3.00 | 5.00 | 10.00 |
| qdrant | 1654\* | 3.13\* | 0.32\* | 0.47\* | 0.64\* |
| weaviate | 362 | 14.31 | n/a | n/a | n/a |

Client round-trip latency, the same queries timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 3.77 | 5.93 | 8.54 |
| elasticsearch | 1.98 | 4.23 | 6.77 |
| opensearch | 5.95 | 9.93 | 16.45 |
| qdrant | 0.93\* | 1.30\* | 1.68\* |
| weaviate | 10.91 | 36.31 | 74.08 |

Server-side time source per engine:

- narsil: response `elapsed` field (floating-millisecond resolution)
- elasticsearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- opensearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- qdrant: top-level `time` field (seconds, converted to ms) (floating-millisecond resolution)
- weaviate: client round-trip only (no server-side query time exposed)

Throughput under concurrent load, higher is better (* marks the best). Peak QPS is the highest sustained rate across the configured concurrency levels; client-limited marks an engine whose peak was capped by the harness rather than the engine:

| Engine | Peak QPS | At concurrency | Under-load p95 ms | Client-limited |
| --- | --- | --- | --- | --- |
| narsil | 448 | 16 | 60.58 | no |
| elasticsearch | 332 | 16 | 120.27 | no |
| opensearch | 456 | 16 | 78.82 | no |
| qdrant | 1477\* | 16 | 19.32 | no |
| weaviate | 182 | 16 | 181.36 | no |

Narsil standing: nDCG@10 rank 4/5 (best qdrant 0.7155); server-side p50 latency rank 2/3 (fastest qdrant 0.32 ms, among engines whose server-side timing is above the measurement floor).

### beir/nfcorpus/test

Retrieval quality, higher is better (* marks the best in each column):

| Engine | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| narsil | 0.3555\* | 0.3239 | 0.1877\* | 0.5727\* |
| elasticsearch | 0.3516 | 0.3214 | 0.1866 | 0.5633 |
| opensearch | 0.3517 | 0.3213 | 0.1867 | 0.5633 |
| qdrant | 0.3512 | 0.3241\* | 0.1825 | 0.5670 |
| weaviate | 0.3430 | 0.3180 | 0.1812 | 0.5600 |

Ingest and latency, latency lower is better (* marks the best in each column). The headline latency is each engine's own reported query time (server-side):

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 473 | 7.68 | 0.97 | 1.78 | 2.60 |
| elasticsearch | 676 | 5.37 | 2.00 | 7.00 | 13.00 |
| opensearch | 1282\* | 2.83\* | 1.00 | 2.00 | 5.00 |
| qdrant | 612 | 5.93 | 0.37\* | 0.97\* | 1.93\* |
| weaviate | 388 | 9.37 | n/a | n/a | n/a |

Client round-trip latency, the same queries timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 3.21 | 4.61 | 6.51 |
| elasticsearch | 5.99 | 12.33 | 22.29 |
| opensearch | 1.89 | 4.84 | 7.68 |
| qdrant | 1.03\* | 2.83\* | 5.24\* |
| weaviate | 3.72 | 9.43 | 16.10 |

Server-side time source per engine:

- narsil: response `elapsed` field (floating-millisecond resolution)
- elasticsearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- opensearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- qdrant: top-level `time` field (seconds, converted to ms) (floating-millisecond resolution)
- weaviate: client round-trip only (no server-side query time exposed)

Throughput under concurrent load, higher is better (* marks the best). Peak QPS is the highest sustained rate across the configured concurrency levels; client-limited marks an engine whose peak was capped by the harness rather than the engine:

| Engine | Peak QPS | At concurrency | Under-load p95 ms | Client-limited |
| --- | --- | --- | --- | --- |
| narsil | 570 | 16 | 50.01 | no |
| elasticsearch | 279 | 16 | 115.23 | no |
| opensearch | 1025\* | 16 | 31.44 | no |
| qdrant | 1024 | 16 | 31.27 | no |
| weaviate | 268 | 16 | 122.17 | no |

Narsil standing: nDCG@10 rank 1/5 (best narsil 0.3555); server-side p50 latency rank 2/3 (fastest qdrant 0.37 ms, among engines whose server-side timing is above the measurement floor).
