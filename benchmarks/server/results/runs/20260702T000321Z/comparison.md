# Search-engine comparison (equal precision (every engine full float)): keyword, vector, hybrid

## Run conditions

- Vector and hybrid tracks hold every engine at full float (no quantization) for an equal-precision comparison.
- Machine: GCP c3-standard-8, us-central1-a
- OS / arch: Linux 6.17.0-1020-gcp / x86_64
- Equal memory cap per engine: 8.6 GB
- Run depth: 1000; BM25 reference k1=0.9, b=0.4
- Shared embedding model: sentence-transformers/all-MiniLM-L6-v2 (384 dim, cosine); latency on the vector track is compared at matched ANN recall@10 >= 0.99.
- Every engine uses the same datasets, metrics, run depth, and strictly-decreasing run-file ordering.
- Dataset beir/scifact/test: content md5 5f7d1de60b170fc8027bb7898e2efca1 (ir_datasets-verified archive)
- Dataset beir/nfcorpus/test: content md5 a89dba18a62ef92f7d323ec890a0d38d (ir_datasets-verified archive)
- Headline latency is each engine's own reported query time, read from the same response the client round-trip wraps. Resolution differs by engine and is disclosed below; an engine that exposes no server-side time is marked not-available and compared on client round-trip only.

## Engines and tracks

| Engine | Version | Build | Tracks |
| --- | --- | --- | --- |
| narsil | source (node:22-trixie-slim) | f9bf113b343d | keyword, vector, hybrid |
| elasticsearch | 9.4.2 | c402c2b36d90 | keyword, vector, hybrid |
| meilisearch | 1.48.2 | 96d2d029e40b | keyword |
| opensearch | 3.7.0 | 72121f014083 | keyword, vector, hybrid |
| qdrant | v1.18.2 | 44ad62f8cd69 | vector, hybrid |
| typesense | 30.2 | sha256:610f2d34b1f9 | keyword |
| weaviate | 1.38.2 | sha256:107e8faae40e | vector, hybrid |

## Keyword track

### beir/scifact/test

Retrieval quality (higher is better). A star marks the best in each column:

| Engine | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| narsil | 0.6781 | 0.9320\* | 0.6379 | 0.6456 |
| elasticsearch | 0.6789\* | 0.9253 | 0.6401\* | 0.6506\* |
| meilisearch | 0.3748 | 0.5302 | 0.3467 | 0.3534 |
| opensearch | 0.6789\* | 0.9253 | 0.6401\* | 0.6506\* |
| typesense | 0.3728 | 0.3923 | 0.3659 | 0.3784 |

Ingest throughput (higher is better) and query latency (lower is better). The headline latency is each engine's own server-side query time; a star marks the best in each column:

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 3768 | 1.38 | 0.76 | 1.34 | 2.03 |
| elasticsearch | 3318 | 1.56 | 1.00 | 1.00 | 1.00 |
| meilisearch | 872 | 5.95 | 2.00 | 5.00 | 7.00 |
| opensearch | 3820\* | 1.36\* | 1.00 | 1.00 | 1.00 |
| typesense | 2034 | 2.55 | 20.00 | 88.00 | 114.00 |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 1.45\* | 2.08\* | 2.73\* |
| elasticsearch | 2.20 | 2.71 | 3.00 |
| meilisearch | 2.91 | 6.04 | 7.89 |
| opensearch | 2.17 | 2.62 | 2.85 |
| typesense | 22.16 | 89.38 | 115.89 |

Server-side time source per engine:

- narsil: response `elapsed` field (floating-millisecond resolution)
- elasticsearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- meilisearch: response `processingTimeMs` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- opensearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- typesense: response `search_time_ms` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)

Throughput under concurrent load (higher is better). Peak QPS is the highest sustained rate across the tested concurrency levels, and 'client-limited' flags an engine whose peak the harness capped, not the engine itself. A star marks the best:

| Engine | Peak QPS | At concurrency | Under-load p95 ms | Client-limited |
| --- | --- | --- | --- | --- |
| narsil | 1020\* | 16 | 27.73 | no |
| elasticsearch | 820 | 16 | 34.47 | no |
| meilisearch | 805 | 16 | 33.11 | no |
| opensearch | 811 | 16 | 34.96 | no |
| typesense | 188 | 16 | 240.04 | no |

Narsil ranks 3/5 on nDCG@10 (tied best: elasticsearch and opensearch, 0.6789) and has the fastest server-side p50 latency at 0.76 ms (among engines above the measurement floor).

### beir/nfcorpus/test

Retrieval quality (higher is better). A star marks the best in each column:

| Engine | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| narsil | 0.3269\* | 0.2491\* | 0.1530\* | 0.5284\* |
| elasticsearch | 0.3206 | 0.2457 | 0.1503 | 0.5255 |
| meilisearch | 0.2550 | 0.1701 | 0.1167 | 0.4338 |
| opensearch | 0.3206 | 0.2457 | 0.1503 | 0.5255 |
| typesense | 0.1817 | 0.1123 | 0.0839 | 0.3372 |

Ingest throughput (higher is better) and query latency (lower is better). The headline latency is each engine's own server-side query time; a star marks the best in each column:

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 3898 | 0.93 | 0.12 | 0.59 | 0.87 |
| elasticsearch | 6705\* | 0.54\* | &lt;1 | &lt;1 | &lt;1 |
| meilisearch | 1000 | 3.63 | &lt;1 | 2.00 | 3.00 |
| opensearch | 6612 | 0.55 | &lt;1 | &lt;1 | &lt;1 |
| typesense | 1923 | 1.89 | &lt;1 | 7.00 | 16.00 |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 0.80\* | 1.32\* | 1.59 |
| elasticsearch | 1.21 | 1.41 | 1.52\* |
| meilisearch | 1.82 | 3.32 | 4.21 |
| opensearch | 1.20 | 1.44 | 1.59 |
| typesense | 1.26 | 8.27 | 17.63 |

Server-side time source per engine:

- narsil: response `elapsed` field (floating-millisecond resolution)
- elasticsearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- meilisearch: response `processingTimeMs` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- opensearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- typesense: response `search_time_ms` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)

Throughput under concurrent load (higher is better). Peak QPS is the highest sustained rate across the tested concurrency levels, and 'client-limited' flags an engine whose peak the harness capped, not the engine itself. A star marks the best:

| Engine | Peak QPS | At concurrency | Under-load p95 ms | Client-limited |
| --- | --- | --- | --- | --- |
| narsil | 1019\* | 16 | 26.21 | no |
| elasticsearch | 944 | 16 | 29.31 | no |
| meilisearch | 872 | 16 | 30.92 | no |
| opensearch | 940 | 16 | 29.04 | no |
| typesense | 831 | 16 | 35.39 | no |

Narsil has the best nDCG@10 at 0.3269 and has the fastest server-side p50 latency at 0.12 ms (among engines above the measurement floor).

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
| narsil | efSearch | 64 | 0.9967 | yes |
| elasticsearch | num_candidates | 64 | 0.9950 | yes |
| opensearch | ef_search | 64 | 0.9957 | yes |
| qdrant | hnsw_ef | 32 | 0.9950 | yes |
| weaviate | ef | 64 | 0.9957 | yes |

Ingest throughput (higher is better) and query latency (lower is better). The headline latency is each engine's own server-side query time; a star marks the best in each column:

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 495 | 10.46 | 0.62 | 0.79 | 0.88 |
| elasticsearch | 939 | 5.52 | &lt;1 | &lt;1 | 1.00 |
| opensearch | 963 | 5.38 | &lt;1 | &lt;1 | 1.00 |
| qdrant | 905 | 5.73 | 0.28 | 0.33 | 0.36 |
| weaviate | 1025\* | 5.06\* | n/a | n/a | n/a |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 4.87 | 5.16 | 5.40 |
| elasticsearch | 2.04 | 2.51 | 2.77 |
| opensearch | 1.96 | 2.27 | 2.91 |
| qdrant | 1.43\* | 1.64\* | 1.84\* |
| weaviate | 3.26 | 4.21 | 6.68 |

Server-side time source per engine:

- narsil: response `elapsed` field (floating-millisecond resolution)
- elasticsearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- opensearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- qdrant: top-level `time` field (seconds, converted to ms) (floating-millisecond resolution)
- weaviate: client round-trip only (no server-side query time exposed)

Throughput under concurrent load (higher is better). Peak QPS is the highest sustained rate across the tested concurrency levels, and 'client-limited' flags an engine whose peak the harness capped, not the engine itself. A star marks the best:

| Engine | Peak QPS | At concurrency | Under-load p95 ms | Client-limited |
| --- | --- | --- | --- | --- |
| narsil | 267 | 16 | 100.23 | no |
| elasticsearch | 649 | 16 | 43.03 | no |
| opensearch | 670 | 16 | 41.67 | no |
| qdrant | 681\* | 16 | 42.80 | no |
| weaviate | 630 | 16 | 42.64 | no |

Narsil ties for the best nDCG@10 (5-way tie at 0.6239) and ranks 2/2 on server-side p50 latency (fastest: qdrant, 0.28 ms, among engines above the measurement floor).

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
| narsil | efSearch | 128 | 0.9954 | yes |
| elasticsearch | num_candidates | 128 | 0.9926 | yes |
| opensearch | ef_search | 128 | 0.9944 | yes |
| qdrant | hnsw_ef | 64 | 0.9910 | yes |
| weaviate | ef | 128 | 0.9954 | yes |

Ingest throughput (higher is better) and query latency (lower is better). The headline latency is each engine's own server-side query time; a star marks the best in each column:

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 487 | 7.46 | 0.79 | 0.96 | 1.10 |
| elasticsearch | 1154\* | 3.15\* | &lt;1 | &lt;1 | &lt;1 |
| opensearch | 1099 | 3.30 | &lt;1 | &lt;1 | &lt;1 |
| qdrant | 911 | 3.99 | 0.33 | 0.39 | 0.42 |
| weaviate | 999 | 3.64 | n/a | n/a | n/a |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 5.05 | 5.37 | 5.82 |
| elasticsearch | 1.93 | 2.12 | 2.26 |
| opensearch | 1.80 | 2.00 | 2.12 |
| qdrant | 1.47\* | 1.69\* | 1.82\* |
| weaviate | 3.43 | 4.38 | 6.91 |

Server-side time source per engine:

- narsil: response `elapsed` field (floating-millisecond resolution)
- elasticsearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- opensearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- qdrant: top-level `time` field (seconds, converted to ms) (floating-millisecond resolution)
- weaviate: client round-trip only (no server-side query time exposed)

Throughput under concurrent load (higher is better). Peak QPS is the highest sustained rate across the tested concurrency levels, and 'client-limited' flags an engine whose peak the harness capped, not the engine itself. A star marks the best:

| Engine | Peak QPS | At concurrency | Under-load p95 ms | Client-limited |
| --- | --- | --- | --- | --- |
| narsil | 264 | 16 | 104.11 | no |
| elasticsearch | 692 | 16 | 39.07 | no |
| opensearch | 708\* | 16 | 38.66 | no |
| qdrant | 675 | 16 | 43.01 | no |
| weaviate | 608 | 16 | 44.08 | no |

Narsil ties for the best nDCG@10 (5-way tie at 0.3145) and ranks 2/2 on server-side p50 latency (fastest: qdrant, 0.33 ms, among engines above the measurement floor).

## Hybrid track

### beir/scifact/test

Retrieval quality (higher is better). A star marks the best in each column:

| Engine | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| narsil | 0.7015 | 0.9643\* | 0.6532 | 0.6596 |
| elasticsearch | 0.7053 | 0.9610 | 0.6587 | 0.6643 |
| opensearch | 0.7053 | 0.9610 | 0.6587 | 0.6643 |
| qdrant | 0.7155\* | 0.9577 | 0.6730\* | 0.6762\* |
| weaviate | 0.6885 | 0.9577 | 0.6405 | 0.6513 |

Ingest throughput (higher is better) and query latency (lower is better). The headline latency is each engine's own server-side query time; a star marks the best in each column:

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 487 | 10.63 | 1.61 | 2.32 | 3.07 |
| elasticsearch | 1042 | 4.97 | 1.00 | 1.00 | 2.00 |
| opensearch | 1080\* | 4.80\* | 1.00 | 2.00 | 2.00 |
| qdrant | 1006 | 5.15 | 0.37 | 0.43 | 0.47\* |
| weaviate | 1017 | 5.09 | n/a | n/a | n/a |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 5.90 | 6.68 | 7.36 |
| elasticsearch | 2.89 | 3.42 | 3.88 |
| opensearch | 2.82 | 3.32 | 3.53 |
| qdrant | 1.69\* | 1.89\* | 2.05\* |
| weaviate | 4.40 | 6.12 | 10.14 |

Server-side time source per engine:

- narsil: response `elapsed` field (floating-millisecond resolution)
- elasticsearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- opensearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- qdrant: top-level `time` field (seconds, converted to ms) (floating-millisecond resolution)
- weaviate: client round-trip only (no server-side query time exposed)

Throughput under concurrent load (higher is better). Peak QPS is the highest sustained rate across the tested concurrency levels, and 'client-limited' flags an engine whose peak the harness capped, not the engine itself. A star marks the best:

| Engine | Peak QPS | At concurrency | Under-load p95 ms | Client-limited |
| --- | --- | --- | --- | --- |
| narsil | 261 | 16 | 99.56 | no |
| elasticsearch | 622 | 16 | 43.17 | no |
| opensearch | 633\* | 16 | 42.30 | no |
| qdrant | 632 | 16 | 45.05 | no |
| weaviate | 504 | 16 | 54.45 | no |

Narsil ranks 4/5 on nDCG@10 (best: qdrant, 0.7155) and ranks 2/2 on server-side p50 latency (fastest: qdrant, 0.37 ms, among engines above the measurement floor).

### beir/nfcorpus/test

Retrieval quality (higher is better). A star marks the best in each column:

| Engine | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| narsil | 0.3555\* | 0.3239 | 0.1877\* | 0.5727\* |
| elasticsearch | 0.3519 | 0.3216 | 0.1867 | 0.5634 |
| opensearch | 0.3521 | 0.3216 | 0.1867 | 0.5653 |
| qdrant | 0.3508 | 0.3242\* | 0.1825 | 0.5650 |
| weaviate | 0.3425 | 0.3180 | 0.1804 | 0.5584 |

Ingest throughput (higher is better) and query latency (lower is better). The headline latency is each engine's own server-side query time; a star marks the best in each column:

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 478 | 7.60 | 1.04 | 1.72 | 2.05 |
| elasticsearch | 1154\* | 3.15\* | 1.00 | 1.00 | 1.00 |
| opensearch | 1103 | 3.29 | 1.00 | 1.00 | 1.00 |
| qdrant | 916 | 3.97 | 0.39 | 0.46 | 0.49 |
| weaviate | 1011 | 3.59 | n/a | n/a | n/a |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 5.37 | 6.06 | 6.62 |
| elasticsearch | 2.47 | 2.73 | 2.90 |
| opensearch | 2.43 | 2.76 | 2.95 |
| qdrant | 1.69\* | 1.88\* | 2.03\* |
| weaviate | 4.20 | 5.89 | 8.73 |

Server-side time source per engine:

- narsil: response `elapsed` field (floating-millisecond resolution)
- elasticsearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- opensearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- qdrant: top-level `time` field (seconds, converted to ms) (floating-millisecond resolution)
- weaviate: client round-trip only (no server-side query time exposed)

Throughput under concurrent load (higher is better). Peak QPS is the highest sustained rate across the tested concurrency levels, and 'client-limited' flags an engine whose peak the harness capped, not the engine itself. A star marks the best:

| Engine | Peak QPS | At concurrency | Under-load p95 ms | Client-limited |
| --- | --- | --- | --- | --- |
| narsil | 263 | 16 | 102.96 | no |
| elasticsearch | 630 | 16 | 44.04 | no |
| opensearch | 668\* | 16 | 40.12 | no |
| qdrant | 647 | 16 | 44.26 | no |
| weaviate | 532 | 16 | 49.87 | no |

Narsil has the best nDCG@10 at 0.3555 and ranks 2/2 on server-side p50 latency (fastest: qdrant, 0.39 ms, among engines above the measurement floor).
