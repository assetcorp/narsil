# Search-engine comparison (equal precision (every engine full float)): keyword, vector, hybrid

## Run conditions

- Vector and hybrid tracks hold every engine at full float (no quantization) for an equal-precision comparison.
- Machine: GCP c3-standard-8, us-central1-a
- OS / arch: Linux 6.17.0-1021-gcp / x86_64
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
| narsil | 0.2.2 | ad93b7f4fe58 | keyword, vector, hybrid |
| elasticsearch | 9.5.0 | 8d4246a64bc2 | keyword, vector, hybrid |
| meilisearch | 1.52.0 | 5c2591ab8cc4 | keyword |
| opensearch | 3.7.0 | 72121f014083 | keyword, vector, hybrid |
| qdrant | 1.18.3 | db8fa43fcb6a | vector, hybrid |
| typesense | 30.2 | sha256:610f2d34b1f9 | keyword |
| weaviate | 1.39.0 | sha256:7660940e14fa | vector, hybrid |

## Keyword track

### beir/scifact/test

Retrieval quality (higher is better). A star marks the best in each column:

| Engine | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| narsil | 0.6814\* | 0.9253\* | 0.6417\* | 0.6494 |
| elasticsearch | 0.6789 | 0.9253\* | 0.6401 | 0.6506\* |
| meilisearch | 0.3748 | 0.5302 | 0.3467 | 0.3534 |
| opensearch | 0.6789 | 0.9253\* | 0.6401 | 0.6506\* |
| typesense | 0.3728 | 0.3923 | 0.3659 | 0.3784 |

Ingest throughput (higher is better) and query latency (lower is better). The headline latency is each engine's own server-side query time; a star marks the best in each column:

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 3793 | 1.37 | 0.82 | 1.41 | 2.16 |
| elasticsearch | 3612 | 1.44 | 1.00 | 1.00 | 1.00 |
| meilisearch | 871 | 5.95 | 2.00 | 5.00 | 7.00 |
| opensearch | 4388\* | 1.18\* | 1.00 | 1.00 | 1.00 |
| typesense | 2224 | 2.33 | 20.00 | 87.00 | 118.00 |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 1.55\* | 2.39\* | 2.93 |
| elasticsearch | 2.23 | 2.65 | 2.99 |
| meilisearch | 3.12 | 6.28 | 8.13 |
| opensearch | 2.17 | 2.61 | 2.87\* |
| typesense | 22.13 | 88.99 | 120.12 |

Server-side time source per engine:

- narsil: response `elapsed` field (floating-millisecond resolution)
- elasticsearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- meilisearch: response `processingTimeMs` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- opensearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- typesense: response `search_time_ms` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)

Throughput under concurrent load (higher is better). Peak QPS is the highest sustained rate across the tested concurrency levels, and 'client-limited' flags an engine whose peak the harness capped, not the engine itself. A star marks the best:

| Engine | Peak QPS | At concurrency | Under-load p95 ms | Client-limited |
| --- | --- | --- | --- | --- |
| narsil | 958\* | 16 | 28.55 | no |
| elasticsearch | 841 | 16 | 33.48 | no |
| meilisearch | 818 | 16 | 32.24 | no |
| opensearch | 878 | 16 | 32.06 | no |
| typesense | 189 | 16 | 244.21 | no |

Narsil has the best nDCG@10 at 0.6814 and has the fastest server-side p50 latency at 0.82 ms (among engines above the measurement floor).

### beir/nfcorpus/test

Retrieval quality (higher is better). A star marks the best in each column:

| Engine | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| narsil | 0.3278\* | 0.2489\* | 0.1532\* | 0.5305\* |
| elasticsearch | 0.3206 | 0.2457 | 0.1503 | 0.5255 |
| meilisearch | 0.2550 | 0.1701 | 0.1167 | 0.4338 |
| opensearch | 0.3206 | 0.2457 | 0.1503 | 0.5255 |
| typesense | 0.1817 | 0.1123 | 0.0839 | 0.3372 |

Ingest throughput (higher is better) and query latency (lower is better). The headline latency is each engine's own server-side query time; a star marks the best in each column:

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 4135 | 0.88 | 0.13 | 0.63 | 0.91 |
| elasticsearch | 6695\* | 0.54\* | &lt;1 | &lt;1 | &lt;1 |
| meilisearch | 1000 | 3.63 | 1.00 | 2.00 | 3.00 |
| opensearch | 5917 | 0.61 | &lt;1 | &lt;1 | &lt;1 |
| typesense | 2083 | 1.74 | &lt;1 | 7.00 | 16.00 |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 0.81\* | 1.36\* | 1.64 |
| elasticsearch | 1.19 | 1.42 | 1.60 |
| meilisearch | 1.92 | 3.45 | 4.51 |
| opensearch | 1.19 | 1.42 | 1.56\* |
| typesense | 1.22 | 8.33 | 17.46 |

Server-side time source per engine:

- narsil: response `elapsed` field (floating-millisecond resolution)
- elasticsearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- meilisearch: response `processingTimeMs` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- opensearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- typesense: response `search_time_ms` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)

Throughput under concurrent load (higher is better). Peak QPS is the highest sustained rate across the tested concurrency levels, and 'client-limited' flags an engine whose peak the harness capped, not the engine itself. A star marks the best:

| Engine | Peak QPS | At concurrency | Under-load p95 ms | Client-limited |
| --- | --- | --- | --- | --- |
| narsil | 1089\* | 16 | 25.63 | no |
| elasticsearch | 975 | 16 | 28.98 | no |
| meilisearch | 893 | 16 | 30.91 | no |
| opensearch | 969 | 16 | 29.06 | no |
| typesense | 852 | 16 | 35.34 | no |

Narsil has the best nDCG@10 at 0.3278 and has the fastest server-side p50 latency at 0.13 ms (among engines above the measurement floor).

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
| elasticsearch | num_candidates | 64 | 0.9937 | yes |
| opensearch | ef_search | 64 | 0.9957 | yes |
| qdrant | hnsw_ef | 32 | 0.9937 | yes |
| weaviate | ef | 64 | 0.9950 | yes |

Ingest throughput (higher is better) and query latency (lower is better). The headline latency is each engine's own server-side query time; a star marks the best in each column:

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 486 | 10.66 | 0.82 | 1.09 | 1.23 |
| elasticsearch | 951 | 5.45 | &lt;1 | &lt;1 | 1.00 |
| opensearch | 962 | 5.39 | &lt;1 | 1.00 | 1.00 |
| qdrant | 907 | 5.72 | 0.28 | 0.32 | 0.34 |
| weaviate | 1010\* | 5.13\* | n/a | n/a | n/a |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 5.28 | 5.86 | 6.10 |
| elasticsearch | 2.09 | 2.40 | 2.87 |
| opensearch | 1.96 | 2.51 | 2.85 |
| qdrant | 1.37\* | 1.59\* | 1.75\* |
| weaviate | 3.24 | 4.15 | 6.64 |

Server-side time source per engine:

- narsil: response `elapsed` field (floating-millisecond resolution)
- elasticsearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- opensearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- qdrant: top-level `time` field, seconds converted to ms (floating-millisecond resolution)
- weaviate: client round-trip only (no server-side query time exposed)

Throughput under concurrent load (higher is better). Peak QPS is the highest sustained rate across the tested concurrency levels, and 'client-limited' flags an engine whose peak the harness capped, not the engine itself. A star marks the best:

| Engine | Peak QPS | At concurrency | Under-load p95 ms | Client-limited |
| --- | --- | --- | --- | --- |
| narsil | 259 | 16 | 104.47 | no |
| elasticsearch | 690 | 16 | 41.34 | no |
| opensearch | 730\* | 16 | 37.54 | no |
| qdrant | 698 | 16 | 42.60 | no |
| weaviate | 637 | 16 | 41.88 | no |

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
| narsil | efSearch | 128 | 0.9950 | yes |
| elasticsearch | num_candidates | 128 | 0.9938 | yes |
| opensearch | ef_search | 128 | 0.9944 | yes |
| qdrant | hnsw_ef | 128 | 0.9969 | yes |
| weaviate | ef | 128 | 0.9929 | yes |

Ingest throughput (higher is better) and query latency (lower is better). The headline latency is each engine's own server-side query time; a star marks the best in each column:

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 481 | 7.55 | 0.87 | 1.08 | 1.25 |
| elasticsearch | 1140\* | 3.19\* | &lt;1 | &lt;1 | &lt;1 |
| opensearch | 1100 | 3.30 | &lt;1 | &lt;1 | &lt;1 |
| qdrant | 913 | 3.98 | 0.36 | 0.43 | 0.45 |
| weaviate | 996 | 3.65 | n/a | n/a | n/a |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 5.25 | 5.59 | 6.04 |
| elasticsearch | 1.86 | 2.04 | 2.18 |
| opensearch | 1.97 | 2.18 | 2.36 |
| qdrant | 1.51\* | 1.74\* | 1.90\* |
| weaviate | 3.32 | 4.22 | 6.31 |

Server-side time source per engine:

- narsil: response `elapsed` field (floating-millisecond resolution)
- elasticsearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- opensearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- qdrant: top-level `time` field, seconds converted to ms (floating-millisecond resolution)
- weaviate: client round-trip only (no server-side query time exposed)

Throughput under concurrent load (higher is better). Peak QPS is the highest sustained rate across the tested concurrency levels, and 'client-limited' flags an engine whose peak the harness capped, not the engine itself. A star marks the best:

| Engine | Peak QPS | At concurrency | Under-load p95 ms | Client-limited |
| --- | --- | --- | --- | --- |
| narsil | 267 | 16 | 103.36 | no |
| elasticsearch | 715\* | 16 | 38.88 | no |
| opensearch | 710 | 16 | 39.60 | no |
| qdrant | 703 | 16 | 41.35 | no |
| weaviate | 632 | 16 | 42.24 | no |

Narsil ties for the best nDCG@10 (5-way tie at 0.3145) and ranks 2/2 on server-side p50 latency (fastest: qdrant, 0.36 ms, among engines above the measurement floor).

## Hybrid track

### beir/scifact/test

Retrieval quality (higher is better). A star marks the best in each column:

| Engine | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| narsil | 0.7026 | 0.9643\* | 0.6543 | 0.6615 |
| elasticsearch | 0.7053 | 0.9610 | 0.6587 | 0.6643 |
| opensearch | 0.7053 | 0.9610 | 0.6587 | 0.6643 |
| qdrant | 0.7155\* | 0.9577 | 0.6730\* | 0.6762\* |
| weaviate | 0.6885 | 0.9577 | 0.6405 | 0.6513 |

Ingest throughput (higher is better) and query latency (lower is better). The headline latency is each engine's own server-side query time; a star marks the best in each column:

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 301 | 17.23 | 1.74 | 2.68 | 3.41 |
| elasticsearch | 1053 | 4.92 | 1.00 | 1.00 | 2.00 |
| opensearch | 1094\* | 4.74\* | 1.00 | 2.00 | 2.00 |
| qdrant | 1004 | 5.16 | 0.38 | 0.43 | 0.45\* |
| weaviate | 1018 | 5.09 | n/a | n/a | n/a |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 6.10 | 7.12 | 7.92 |
| elasticsearch | 2.94 | 3.45 | 3.68 |
| opensearch | 2.80 | 3.31 | 3.55 |
| qdrant | 1.66\* | 1.87\* | 2.03\* |
| weaviate | 4.38 | 5.90 | 10.53 |

Server-side time source per engine:

- narsil: response `elapsed` field (floating-millisecond resolution)
- elasticsearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- opensearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- qdrant: top-level `time` field, seconds converted to ms (floating-millisecond resolution)
- weaviate: client round-trip only (no server-side query time exposed)

Throughput under concurrent load (higher is better). Peak QPS is the highest sustained rate across the tested concurrency levels, and 'client-limited' flags an engine whose peak the harness capped, not the engine itself. A star marks the best:

| Engine | Peak QPS | At concurrency | Under-load p95 ms | Client-limited |
| --- | --- | --- | --- | --- |
| narsil | 269 | 16 | 96.55 | no |
| elasticsearch | 642 | 16 | 42.91 | no |
| opensearch | 656 | 16 | 42.84 | no |
| qdrant | 668\* | 16 | 43.93 | no |
| weaviate | 516 | 16 | 52.89 | no |

Narsil ranks 4/5 on nDCG@10 (best: qdrant, 0.7155) and ranks 2/2 on server-side p50 latency (fastest: qdrant, 0.38 ms, among engines above the measurement floor).

### beir/nfcorpus/test

Retrieval quality (higher is better). A star marks the best in each column:

| Engine | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| narsil | 0.3560\* | 0.3239\* | 0.1878\* | 0.5745\* |
| elasticsearch | 0.3516 | 0.3216 | 0.1866 | 0.5633 |
| opensearch | 0.3521 | 0.3216 | 0.1867 | 0.5653 |
| qdrant | 0.3515 | 0.3239\* | 0.1826 | 0.5686 |
| weaviate | 0.3427 | 0.3180 | 0.1811 | 0.5584 |

Ingest throughput (higher is better) and query latency (lower is better). The headline latency is each engine's own server-side query time; a star marks the best in each column:

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 481 | 7.56 | 1.26 | 1.89 | 2.22 |
| elasticsearch | 1216\* | 2.99\* | 1.00 | 1.00 | 1.00 |
| opensearch | 1093 | 3.32 | 1.00 | 1.00 | 1.00 |
| qdrant | 929 | 3.91 | 0.41 | 0.47 | 0.49 |
| weaviate | 1013 | 3.59 | n/a | n/a | n/a |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 5.68 | 6.43 | 7.22 |
| elasticsearch | 2.44 | 2.67 | 2.81 |
| opensearch | 2.69 | 3.05 | 3.27 |
| qdrant | 1.67\* | 1.83\* | 1.97\* |
| weaviate | 4.06 | 5.34 | 8.79 |

Server-side time source per engine:

- narsil: response `elapsed` field (floating-millisecond resolution)
- elasticsearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- opensearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- qdrant: top-level `time` field, seconds converted to ms (floating-millisecond resolution)
- weaviate: client round-trip only (no server-side query time exposed)

Throughput under concurrent load (higher is better). Peak QPS is the highest sustained rate across the tested concurrency levels, and 'client-limited' flags an engine whose peak the harness capped, not the engine itself. A star marks the best:

| Engine | Peak QPS | At concurrency | Under-load p95 ms | Client-limited |
| --- | --- | --- | --- | --- |
| narsil | 263 | 16 | 104.09 | no |
| elasticsearch | 672 | 16 | 41.40 | no |
| opensearch | 681 | 16 | 39.40 | no |
| qdrant | 683\* | 16 | 42.87 | no |
| weaviate | 547 | 16 | 47.77 | no |

Narsil has the best nDCG@10 at 0.3560 and ranks 2/2 on server-side p50 latency (fastest: qdrant, 0.41 ms, among engines above the measurement floor).
