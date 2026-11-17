# Search-engine comparison (equal precision (every engine full float)): keyword, vector, hybrid

## Run conditions

- Vector and hybrid tracks hold every engine at full float (no quantization) for an equal-precision comparison.
- Load machine: GCP c3-standard-8, us-central1-a
- OS / arch: Linux 7.0.0-1017-gcp / x86_64
- Engine machine label: GCP c3-standard-8, us-central1-a
- Engine machine: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical), 33.6 GB
- Network round trip to the engine machine: p50 0.083 ms, p99 0.149 ms over 200 TCP connects
- Equal memory cap per engine: 21.5 GB
- Java heap inside that cap, as each node reports it: elasticsearch 10.7 GB, opensearch 6.4 GB
- Node.js heap limit inside that cap, as each Narsil server reports it: narsil 16.1 GB, narsil-rust 21.5 GB
- Run depth: 1000; BM25 reference k1=0.9, b=0.4
- Shared embedding model: sentence-transformers/all-MiniLM-L6-v2 (384 dim, cosine); latency on the vector track is compared at matched ANN recall@10 >= 0.99.
- Every engine uses the same datasets, metrics, run depth, and strictly-decreasing run-file ordering.
- Dataset beir/scifact/test: content md5 5f7d1de60b170fc8027bb7898e2efca1 (ir_datasets-verified archive)
- Dataset beir/nfcorpus/test: content md5 a89dba18a62ef92f7d323ec890a0d38d (ir_datasets-verified archive)
- Headline latency is each engine's own reported query time, read from the same response the client round-trip wraps. Resolution differs by engine and is disclosed below; an engine that exposes no server-side time is marked not-available and compared on client round-trip only.

## Engines and tracks

| Engine | Version | Build | Tracks |
| --- | --- | --- | --- |
| narsil | 0.4.3 | d3efdcbcb2d2 | keyword, vector, hybrid |
| elasticsearch | 9.5.6 | fd1e8011342a | keyword, vector, hybrid |
| meilisearch | 1.57.0 | 1b782653f25c | keyword |
| narsil-rust | 0.4.3 | d3efdcbcb2d2 | keyword, vector, hybrid |
| opensearch | 3.9.0 | 4ee42a94e87f | keyword, vector, hybrid |
| qdrant | 1.20.2 | 23065a0bf685 | vector, hybrid |
| typesense | 30.2 | sha256:610f2d34b1f9 | keyword |
| weaviate | 1.40.5 | sha256:fe848a3830c8 | vector, hybrid |

## Keyword track

### beir/scifact/test

Retrieval quality (higher is better). A star marks the best in each column:

| Engine | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| narsil | 0.6814\* | 0.9253\* | 0.6417\* | 0.6494 |
| elasticsearch | 0.6789 | 0.9253\* | 0.6401 | 0.6506\* |
| meilisearch | 0.5019 | 0.5982 | 0.4823 | 0.4903 |
| narsil-rust | 0.6814\* | 0.9253\* | 0.6417\* | 0.6494 |
| opensearch | 0.6789 | 0.9253\* | 0.6401 | 0.6506\* |
| typesense | 0.5503 | 0.7508 | 0.5164 | 0.5280 |

Ingest throughput (higher is better) and query latency (lower is better). The headline latency is each engine's own server-side query time; a star marks the best in each column:

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 4455 | 1.16 | 0.10 | 0.19 | 0.25 |
| elasticsearch | 4008 | 1.29 | 1.00 | 1.00 | 2.00 |
| meilisearch | 1450 | 3.57 | 1.00 | 3.00 | 5.00 |
| narsil-rust | 7431\* | 0.70\* | 0.05 | 0.10 | 0.14\* |
| opensearch | 5106 | 1.02 | 1.00 | 1.00 | 2.00 |
| typesense | 2108 | 2.46 | 12.00 | 45.00 | 63.00 |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 0.72 | 0.92 | 1.05 |
| elasticsearch | 2.60 | 3.28 | 3.60 |
| meilisearch | 2.70 | 4.20 | 7.37 |
| narsil-rust | 0.63\* | 0.77\* | 0.85\* |
| opensearch | 2.25 | 3.01 | 3.38 |
| typesense | 13.65 | 46.60 | 64.41 |

Server-side time source per engine:

- narsil: response `elapsed` field (floating-millisecond resolution)
- elasticsearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- meilisearch: response `processingTimeMs` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- narsil-rust: response `elapsed` field (floating-millisecond resolution)
- opensearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- typesense: response `search_time_ms` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)

Throughput under concurrent load (higher is better). Peak QPS is the highest sustained rate across the tested concurrency levels, and 'client-limited' flags an engine whose peak the harness capped, not the engine itself. A star marks the best:

| Engine | Peak QPS | 95% CI | At concurrency | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- |
| narsil | 5152 | 5064 to 5450 | 4 | 0.99 | 1.43 | 1.24 | no |
| elasticsearch | 3597 | 3520 to 3609 | 16 | 6.71 | 35.25 | 4.06 | yes |
| meilisearch | 2067 | 2060 to 2071 | 16 | 12.55 | 27.60 | 6.86 | no |
| narsil-rust | 5766\* | 5701 to 5869 | 4 | 0.83 | 1.18 | 1.24 | no |
| opensearch | 3842 | 3789 to 3881 | 16 | 6.30 | 25.77 | 3.97 | yes |
| typesense | 347 | 344 to 348 | 32 | 260.99 | 496.13 | 7.93 | no |

Narsil ties for the best nDCG@10 (2-way tie at 0.6814) and ranks 2/3 on server-side p50 latency (fastest: narsil-rust, 0.05 ms, among engines above the measurement floor).

### beir/nfcorpus/test

Retrieval quality (higher is better). A star marks the best in each column:

| Engine | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| narsil | 0.3283\* | 0.2489\* | 0.1535\* | 0.5336\* |
| elasticsearch | 0.3218 | 0.2457 | 0.1504 | 0.5281 |
| meilisearch | 0.2654 | 0.1554 | 0.1214 | 0.4415 |
| narsil-rust | 0.3283\* | 0.2489\* | 0.1535\* | 0.5336\* |
| opensearch | 0.3216 | 0.2458 | 0.1506 | 0.5281 |
| typesense | 0.2420 | 0.2089 | 0.1171 | 0.4242 |

Ingest throughput (higher is better) and query latency (lower is better). The headline latency is each engine's own server-side query time; a star marks the best in each column:

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 4290 | 0.85 | 0.05 | 0.18 | 0.23 |
| elasticsearch | 7450 | 0.49 | &lt;1 | &lt;1 | &lt;1 |
| meilisearch | 1463 | 2.48 | &lt;1 | 1.00 | 2.00 |
| narsil-rust | 6649 | 0.55 | 0.02 | 0.04 | 0.06 |
| opensearch | 7576\* | 0.48\* | &lt;1 | &lt;1 | &lt;1 |
| typesense | 1931 | 1.88 | &lt;1 | 5.00 | 9.00 |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 0.62\* | 0.83 | 0.96 |
| elasticsearch | 1.23 | 1.43 | 1.57 |
| meilisearch | 1.66 | 2.61 | 3.25 |
| narsil-rust | 0.64 | 0.76\* | 0.84\* |
| opensearch | 1.13 | 1.35 | 1.52 |
| typesense | 1.39 | 6.38 | 10.44 |

Server-side time source per engine:

- narsil: response `elapsed` field (floating-millisecond resolution)
- elasticsearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- meilisearch: response `processingTimeMs` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- narsil-rust: response `elapsed` field (floating-millisecond resolution)
- opensearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- typesense: response `search_time_ms` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)

Throughput under concurrent load (higher is better). Peak QPS is the highest sustained rate across the tested concurrency levels, and 'client-limited' flags an engine whose peak the harness capped, not the engine itself. A star marks the best:

| Engine | Peak QPS | 95% CI | At concurrency | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- |
| narsil | 5867 | 5860 to 5936 | 4 | 0.83 | 1.28 | 1.01 | no |
| elasticsearch | 3656 | 3641 to 3690 | 16 | 6.77 | 25.05 | 2.62 | yes |
| meilisearch | 3429 | 3428 to 3455 | 16 | 7.11 | 11.88 | 5.65 | yes |
| narsil-rust | 6411\* | 6269 to 6474 | 4 | 0.75 | 1.23 | 1.06 | no |
| opensearch | 3888 | 3883 to 3903 | 16 | 6.35 | 13.42 | 2.73 | yes |
| typesense | 2777 | 2754 to 2800 | 64 | 41.00 | 76.43 | 4.03 | yes |

Narsil ties for the best nDCG@10 (2-way tie at 0.3283) and ranks 2/2 on server-side p50 latency (fastest: narsil-rust, 0.02 ms, among engines above the measurement floor).

### dbpedia-entities-openai-100k

Retrieval quality (higher is better). A star marks the best in each column:

| Engine | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| narsil | n/a | n/a | n/a | n/a |
| elasticsearch | n/a | n/a | n/a | n/a |
| meilisearch | n/a | n/a | n/a | n/a |
| narsil-rust | n/a | n/a | n/a | n/a |
| opensearch | n/a | n/a | n/a | n/a |
| typesense | n/a | n/a | n/a | n/a |

Ingest throughput (higher is better) and query latency (lower is better). The headline latency is each engine's own server-side query time; a star marks the best in each column:

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 19281 | 5.19 | 0.07 | 0.26 | 0.35 |
| elasticsearch | 44187 | 2.26 | &lt;1 | &lt;1 | &lt;1 |
| meilisearch | 4584 | 21.82 | 1.00 | 2.00 | 3.00 |
| narsil-rust | 35699 | 2.80 | 0.04 | 0.22 | 0.28 |
| opensearch | 45590\* | 2.19\* | &lt;1 | &lt;1 | &lt;1 |
| typesense | 8973 | 11.14 | &lt;1 | 10.00 | 17.00 |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 0.75 | 1.01 | 1.20 |
| elasticsearch | 1.20 | 1.48 | 1.60 |
| meilisearch | 2.04 | 3.39 | 4.25 |
| narsil-rust | 0.72\* | 0.94\* | 1.07\* |
| opensearch | 1.18 | 1.44 | 1.61 |
| typesense | 1.75 | 11.56 | 18.87 |

Server-side time source per engine:

- narsil: response `elapsed` field (floating-millisecond resolution)
- elasticsearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- meilisearch: response `processingTimeMs` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- narsil-rust: response `elapsed` field (floating-millisecond resolution)
- opensearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- typesense: response `search_time_ms` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)

Throughput under concurrent load (higher is better). Peak QPS is the highest sustained rate across the tested concurrency levels, and 'client-limited' flags an engine whose peak the harness capped, not the engine itself. A star marks the best:

| Engine | Peak QPS | 95% CI | At concurrency | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- |
| narsil | 5380 | 5311 to 5561 | 4 | 0.96 | 1.49 | 1.29 | no |
| elasticsearch | 3665 | 3650 to 3665 | 16 | 6.80 | 25.50 | 2.77 | yes |
| meilisearch | 2916 | 2908 to 2935 | 32 | 15.51 | 32.49 | 6.62 | no |
| narsil-rust | 5782\* | 5762 to 5890 | 4 | 0.93 | 1.33 | 1.26 | no |
| opensearch | 3880 | 3871 to 3881 | 16 | 6.40 | 10.83 | 2.91 | yes |
| typesense | 2821 | 2808 to 2823 | 32 | 24.74 | 94.84 | 7.07 | no |

### dbpedia-entities-openai-1m

Retrieval quality (higher is better). A star marks the best in each column:

| Engine | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| narsil | n/a | n/a | n/a | n/a |
| elasticsearch | n/a | n/a | n/a | n/a |
| meilisearch | n/a | n/a | n/a | n/a |
| narsil-rust | n/a | n/a | n/a | n/a |
| opensearch | n/a | n/a | n/a | n/a |
| typesense | n/a | n/a | n/a | n/a |

Ingest throughput (higher is better) and query latency (lower is better). The headline latency is each engine's own server-side query time; a star marks the best in each column:

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 18837 | 52.82 | 0.95 | 2.41 | 3.76 |
| elasticsearch | 46325 | 21.48 | &lt;1 | &lt;1 | 1.00 |
| meilisearch | 458 | 2170.64 | 3.00 | 8.00 | 11.00 |
| narsil-rust | 21571 | 46.13 | 0.30 | 1.08 | 1.70 |
| opensearch | 47826\* | 20.80\* | &lt;1 | 1.00 | 1.00 |
| typesense | 7557 | 131.67 | 2.00 | 25.00 | 48.00 |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 1.69 | 3.29 | 5.22 |
| elasticsearch | 1.38 | 1.81 | 2.07\* |
| meilisearch | 3.89 | 9.06 | 12.15 |
| narsil-rust | 1.02\* | 1.80\* | 2.42 |
| opensearch | 1.37 | 1.94 | 2.40 |
| typesense | 3.29 | 26.99 | 49.58 |

Server-side time source per engine:

- narsil: response `elapsed` field (floating-millisecond resolution)
- elasticsearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- meilisearch: response `processingTimeMs` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- narsil-rust: response `elapsed` field (floating-millisecond resolution)
- opensearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- typesense: response `search_time_ms` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)

Throughput under concurrent load (higher is better). Peak QPS is the highest sustained rate across the tested concurrency levels, and 'client-limited' flags an engine whose peak the harness capped, not the engine itself. A star marks the best:

| Engine | Peak QPS | 95% CI | At concurrency | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- |
| narsil | 4265 | 4235 to 4278 | 16 | 6.40 | 14.69 | 4.77 | yes |
| elasticsearch | 3596 | 3578 to 3606 | 16 | 6.79 | 26.17 | 4.90 | yes |
| meilisearch | 1408 | 1405 to 1409 | 32 | 36.20 | 59.87 | 7.22 | no |
| narsil-rust | 4291\* | 4290 to 4300 | 16 | 6.08 | 10.22 | 3.08 | yes |
| opensearch | 3855 | 3842 to 3882 | 16 | 6.36 | 13.45 | 4.31 | yes |
| typesense | 2140 | 2136 to 2141 | 64 | 60.91 | 230.92 | 7.62 | no |

## Vector track

### beir/scifact/test

Retrieval quality (higher is better). A star marks the best in each column:

| Engine | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| narsil | 0.6239 | 0.9227 | 0.5797 | 0.5849 |
| elasticsearch | 0.6239 | 0.9227 | 0.5797 | 0.5849 |
| narsil-rust | 0.6239 | 0.9227 | 0.5797 | 0.5849 |
| opensearch | 0.6239 | 0.9227 | 0.5797 | 0.5849 |
| qdrant | 0.6239 | 0.9227 | 0.5797 | 0.5849 |
| weaviate | 0.6239 | 0.9227 | 0.5797 | 0.5849 |

Matched-recall operating point per engine:

| Engine | Knob | Value | ANN recall@k | Target met |
| --- | --- | --- | --- | --- |
| narsil | efSearch | 64 | 0.9967 | yes |
| elasticsearch | num_candidates | 64 | 0.9967 | yes |
| narsil-rust | efSearch | 64 | 0.9967 | yes |
| opensearch | ef_search | 64 | 0.9963 | yes |
| qdrant | hnsw_ef | 32 | 0.9917 | yes |
| weaviate | ef | 64 | 0.9973 | yes |

Ingest throughput (higher is better) and query latency (lower is better). The headline latency is each engine's own server-side query time; a star marks the best in each column:

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 1692 | 3.06 | 0.17 | 0.20 | 0.24 |
| elasticsearch | 1117 | 4.64 | &lt;1 | 1.00 | 1.00 |
| narsil-rust | 2249\* | 2.30\* | 0.13 | 0.15 | 0.17 |
| opensearch | 1078 | 4.81 | &lt;1 | &lt;1 | 1.00 |
| qdrant | 1478 | 3.51 | 0.24 | 0.28 | 0.30 |
| weaviate | 1672 | 3.10 | n/a | n/a | n/a |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 1.10 | 1.26 | 1.38 |
| elasticsearch | 1.77 | 2.76 | 2.96 |
| narsil-rust | 1.07\* | 1.20\* | 1.33\* |
| opensearch | 1.62 | 2.06 | 2.31 |
| qdrant | 1.28 | 1.42 | 1.50 |
| weaviate | 2.96 | 3.89 | 5.76 |

Server-side time source per engine:

- narsil: response `elapsed` field (floating-millisecond resolution)
- elasticsearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- narsil-rust: response `elapsed` field (floating-millisecond resolution)
- opensearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- qdrant: top-level `time` field, seconds converted to ms (floating-millisecond resolution)
- weaviate: client round-trip only (no server-side query time exposed)

Throughput under concurrent load (higher is better). Peak QPS is the highest sustained rate across the tested concurrency levels, and 'client-limited' flags an engine whose peak the harness capped, not the engine itself. A star marks the best:

| Engine | Peak QPS | 95% CI | At concurrency | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- |
| narsil | 3261 | 3251 to 3338 | 4 | 1.44 | 2.68 | 1.46 | no |
| elasticsearch | 2670 | 2640 to 2674 | 16 | 9.33 | 36.98 | 2.86 | yes |
| narsil-rust | 3622\* | 3596 to 3627 | 4 | 1.24 | 1.71 | 1.23 | no |
| opensearch | 2820 | 2796 to 2825 | 16 | 8.81 | 25.85 | 2.93 | yes |
| qdrant | 3070 | 3030 to 3077 | 8 | 3.35 | 4.85 | 2.43 | yes |
| weaviate | 1785 | 1764 to 1791 | 32 | 33.64 | 58.40 | 7.85 | no |

Narsil ties for the best nDCG@10 (6-way tie at 0.6239) and ranks 2/3 on server-side p50 latency (fastest: narsil-rust, 0.13 ms, among engines above the measurement floor).

### beir/nfcorpus/test

Retrieval quality (higher is better). A star marks the best in each column:

| Engine | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| narsil | 0.3149\* | 0.3094 | 0.1576\* | 0.5194\* |
| elasticsearch | 0.3144 | 0.3094 | 0.1574 | 0.5168 |
| narsil-rust | 0.3149\* | 0.3094 | 0.1576\* | 0.5194\* |
| opensearch | 0.3149\* | 0.3094 | 0.1576\* | 0.5194\* |
| qdrant | 0.3149\* | 0.3094 | 0.1576\* | 0.5189 |
| weaviate | 0.3146 | 0.3094 | 0.1575 | 0.5174 |

Matched-recall operating point per engine:

| Engine | Knob | Value | ANN recall@k | Target met |
| --- | --- | --- | --- | --- |
| narsil | efSearch | 128 | 0.9932 | yes |
| elasticsearch | num_candidates | 160 | 0.9904 | yes |
| narsil-rust | efSearch | 128 | 0.9926 | yes |
| opensearch | ef_search | 128 | 0.9935 | yes |
| qdrant | hnsw_ef | 128 | 0.9960 | yes |
| weaviate | ef | 128 | 0.9916 | yes |

Ingest throughput (higher is better) and query latency (lower is better). The headline latency is each engine's own server-side query time; a star marks the best in each column:

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 1711 | 2.12 | 0.23 | 0.26 | 0.29 |
| elasticsearch | 1242 | 2.92 | &lt;1 | &lt;1 | &lt;1 |
| narsil-rust | 2072\* | 1.75\* | 0.19 | 0.22 | 0.24 |
| opensearch | 1154 | 3.15 | &lt;1 | &lt;1 | &lt;1 |
| qdrant | 1266 | 2.87 | 0.39 | 0.47 | 0.50 |
| weaviate | 1374 | 2.64 | n/a | n/a | n/a |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 1.20 | 1.35 | 1.45 |
| elasticsearch | 1.83 | 1.99 | 2.15 |
| narsil-rust | 1.17\* | 1.30\* | 1.41\* |
| opensearch | 1.67 | 1.82 | 1.93 |
| qdrant | 1.46 | 1.63 | 1.73 |
| weaviate | 3.07 | 4.02 | 6.40 |

Server-side time source per engine:

- narsil: response `elapsed` field (floating-millisecond resolution)
- elasticsearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- narsil-rust: response `elapsed` field (floating-millisecond resolution)
- opensearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- qdrant: top-level `time` field, seconds converted to ms (floating-millisecond resolution)
- weaviate: client round-trip only (no server-side query time exposed)

Throughput under concurrent load (higher is better). Peak QPS is the highest sustained rate across the tested concurrency levels, and 'client-limited' flags an engine whose peak the harness capped, not the engine itself. A star marks the best:

| Engine | Peak QPS | 95% CI | At concurrency | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- |
| narsil | 3101 | 3071 to 3122 | 4 | 1.57 | 3.32 | 1.58 | no |
| elasticsearch | 2655 | 2607 to 2668 | 16 | 9.29 | 38.16 | 3.16 | yes |
| narsil-rust | 3409\* | 3390 to 3434 | 4 | 1.31 | 1.98 | 1.37 | no |
| opensearch | 2800 | 2796 to 2803 | 16 | 8.84 | 25.04 | 2.99 | yes |
| qdrant | 3159 | 3101 to 3222 | 8 | 3.39 | 5.00 | 3.24 | yes |
| weaviate | 1712 | 1711 to 1713 | 16 | 15.74 | 28.07 | 7.76 | no |

Narsil ties for the best nDCG@10 (4-way tie at 0.3149) and ranks 2/3 on server-side p50 latency (fastest: narsil-rust, 0.19 ms, among engines above the measurement floor).

### dbpedia-entities-openai-100k

Retrieval quality (higher is better). A star marks the best in each column:

| Engine | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| narsil | n/a | n/a | n/a | n/a |
| elasticsearch | n/a | n/a | n/a | n/a |
| narsil-rust | n/a | n/a | n/a | n/a |
| opensearch | n/a | n/a | n/a | n/a |
| qdrant | n/a | n/a | n/a | n/a |
| weaviate | n/a | n/a | n/a | n/a |

Matched-recall operating point per engine:

| Engine | Knob | Value | ANN recall@k | Target met |
| --- | --- | --- | --- | --- |
| narsil | efSearch | 128 | 0.9917 | yes |
| elasticsearch | num_candidates | 768 | 0.9920 | yes |
| narsil-rust | efSearch | 128 | 0.9919 | yes |
| opensearch | ef_search | 128 | 0.9917 | yes |
| qdrant | hnsw_ef | 128 | 0.9940 | yes |
| weaviate | ef | 160 | 0.9914 | yes |

Ingest throughput (higher is better) and query latency (lower is better). The headline latency is each engine's own server-side query time; a star marks the best in each column:

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 867\* | 115.29\* | 1.44 | 1.97 | 2.14 |
| elasticsearch | 568 | 176.12 | 2.00 | 3.00 | 4.00 |
| narsil-rust | 856 | 116.86 | 1.47 | 2.05 | 2.22 |
| opensearch | 378 | 264.83 | 1.00 | 1.00 | 1.00 |
| qdrant | 796 | 125.58 | 1.49 | 1.95 | 2.43 |
| weaviate | 656 | 152.49 | n/a | n/a | n/a |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 3.34\* | 3.89 | 4.10 |
| elasticsearch | 4.44 | 5.68 | 6.21 |
| narsil-rust | 3.37 | 3.97 | 4.19 |
| opensearch | 3.40 | 3.79\* | 3.96\* |
| qdrant | 3.49 | 3.98 | 4.49 |
| weaviate | 8.89 | 9.64 | 12.27 |

Server-side time source per engine:

- narsil: response `elapsed` field (floating-millisecond resolution)
- elasticsearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- narsil-rust: response `elapsed` field (floating-millisecond resolution)
- opensearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- qdrant: top-level `time` field, seconds converted to ms (floating-millisecond resolution)
- weaviate: client round-trip only (no server-side query time exposed)

Throughput under concurrent load (higher is better). Peak QPS is the highest sustained rate across the tested concurrency levels, and 'client-limited' flags an engine whose peak the harness capped, not the engine itself. A star marks the best:

| Engine | Peak QPS | 95% CI | At concurrency | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- |
| narsil | 1649\* | 1648 to 1652 | 32 | 32.99 | 115.82 | 4.17 | yes |
| elasticsearch | 1540 | 1536 to 1545 | 32 | 32.78 | 122.86 | 6.30 | yes |
| narsil-rust | 1641 | 1639 to 1652 | 32 | 32.90 | 112.84 | 3.96 | yes |
| opensearch | 1590 | 1588 to 1600 | 16 | 15.54 | 97.07 | 3.67 | yes |
| qdrant | 1408 | 1407 to 1409 | 64 | 70.63 | 156.72 | 7.54 | yes |
| weaviate | 621 | 618 to 623 | 16 | 44.86 | 73.15 | 7.82 | no |

### dbpedia-entities-openai-1m

Retrieval quality (higher is better). A star marks the best in each column:

| Engine | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| narsil | n/a | n/a | n/a | n/a |
| elasticsearch | n/a | n/a | n/a | n/a |
| narsil-rust | n/a | n/a | n/a | n/a |
| opensearch | n/a | n/a | n/a | n/a |
| qdrant | n/a | n/a | n/a | n/a |
| weaviate | n/a | n/a | n/a | n/a |

Matched-recall operating point per engine:

| Engine | Knob | Value | ANN recall@k | Target met |
| --- | --- | --- | --- | --- |
| narsil | efSearch | 288 | 0.9926 | yes |
| elasticsearch | num_candidates | 2048 | 0.9923 | yes |
| narsil-rust | efSearch | 256 | 0.9916 | yes |
| opensearch | ef_search | 288 | 0.9927 | yes |
| qdrant | hnsw_ef | 192 | 0.9927 | yes |
| weaviate | ef | 416 | 0.9927 | yes |

Ingest throughput (higher is better) and query latency (lower is better). The headline latency is each engine's own server-side query time; a star marks the best in each column:

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 679 | 1464.81 | 4.63 | 6.42 | 6.79 |
| elasticsearch | 417 | 2383.79 | 6.00 | 10.00 | 11.00 |
| narsil-rust | 851\* | 1169.05\* | 4.27 | 5.89 | 6.20 |
| opensearch | 200 | 4978.40 | 3.00\* | 4.00\* | 5.00\* |
| qdrant | 806 | 1234.82 | 3.90 | 5.60 | 6.49 |
| weaviate | 662 | 1503.75 | n/a | n/a | n/a |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 6.57 | 8.37 | 8.77 |
| elasticsearch | 8.15 | 12.32 | 14.12 |
| narsil-rust | 6.17 | 7.81 | 8.13 |
| opensearch | 5.42\* | 6.78\* | 7.74\* |
| qdrant | 5.95 | 7.68 | 8.55 |
| weaviate | 12.40 | 14.00 | 14.97 |

Server-side time source per engine:

- narsil: response `elapsed` field (floating-millisecond resolution)
- elasticsearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- narsil-rust: response `elapsed` field (floating-millisecond resolution)
- opensearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- qdrant: top-level `time` field, seconds converted to ms (floating-millisecond resolution)
- weaviate: client round-trip only (no server-side query time exposed)

Throughput under concurrent load (higher is better). Peak QPS is the highest sustained rate across the tested concurrency levels, and 'client-limited' flags an engine whose peak the harness capped, not the engine itself. A star marks the best:

| Engine | Peak QPS | 95% CI | At concurrency | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- |
| narsil | 1129 | 1123 to 1140 | 16 | 25.51 | 46.10 | 7.10 | no |
| elasticsearch | 816 | 815 to 817 | 16 | 31.10 | 44.20 | 7.61 | no |
| narsil-rust | 1299 | 1285 to 1300 | 16 | 17.29 | 22.68 | 7.49 | no |
| opensearch | 1465\* | 1464 to 1467 | 32 | 32.66 | 114.74 | 7.34 | yes |
| qdrant | 657 | 651 to 659 | 64 | 122.33 | 150.07 | 7.79 | no |
| weaviate | 466 | 460 to 474 | 32 | 106.56 | 202.28 | 7.69 | no |

## Hybrid track

### beir/scifact/test

Retrieval quality (higher is better). A star marks the best in each column:

| Engine | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| narsil | 0.7054 | 0.9643\* | 0.6581 | 0.6648 |
| elasticsearch | 0.7082 | 0.9610 | 0.6625 | 0.6682 |
| narsil-rust | 0.7054 | 0.9643\* | 0.6581 | 0.6648 |
| opensearch | 0.7070 | 0.9610 | 0.6609 | 0.6665 |
| qdrant | 0.7165\* | 0.9577 | 0.6755\* | 0.6796\* |
| weaviate | 0.6840 | 0.9577 | 0.6366 | 0.6460 |

Ingest throughput (higher is better) and query latency (lower is better). The headline latency is each engine's own server-side query time; a star marks the best in each column:

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 1825 | 2.84 | 0.31 | 0.38 | 0.42 |
| elasticsearch | 1468 | 3.53 | 1.00 | 1.00 | 2.00 |
| narsil-rust | 2316\* | 2.24\* | 0.20 | 0.25 | 0.29\* |
| opensearch | 1058 | 4.90 | 1.00 | 2.00 | 2.00 |
| qdrant | 1644 | 3.15 | 0.43 | 0.50 | 0.52 |
| weaviate | 1681 | 3.08 | n/a | n/a | n/a |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 1.30 | 1.46 | 1.56 |
| elasticsearch | 2.93 | 3.46 | 3.70 |
| narsil-rust | 1.15\* | 1.30\* | 1.41\* |
| opensearch | 2.71 | 3.23 | 3.43 |
| qdrant | 1.59 | 1.74 | 1.85 |
| weaviate | 4.02 | 5.75 | 8.05 |

Server-side time source per engine:

- narsil: response `elapsed` field (floating-millisecond resolution)
- elasticsearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- narsil-rust: response `elapsed` field (floating-millisecond resolution)
- opensearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- qdrant: top-level `time` field, seconds converted to ms (floating-millisecond resolution)
- weaviate: client round-trip only (no server-side query time exposed)

Throughput under concurrent load (higher is better). Peak QPS is the highest sustained rate across the tested concurrency levels, and 'client-limited' flags an engine whose peak the harness capped, not the engine itself. A star marks the best:

| Engine | Peak QPS | 95% CI | At concurrency | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- |
| narsil | 2985 | 2979 to 2997 | 16 | 8.83 | 25.09 | 2.00 | yes |
| elasticsearch | 2582 | 2567 to 2584 | 32 | 19.86 | 54.29 | 6.15 | yes |
| narsil-rust | 3328\* | 3307 to 3339 | 4 | 1.37 | 2.02 | 1.38 | no |
| opensearch | 2699 | 2697 to 2715 | 32 | 18.73 | 35.88 | 6.47 | yes |
| qdrant | 3068 | 3045 to 3151 | 8 | 3.34 | 5.20 | 3.72 | yes |
| weaviate | 822 | 816 to 822 | 32 | 75.82 | 130.27 | 7.89 | no |

Narsil ranks 4/6 on nDCG@10 (best: qdrant, 0.7165) and ranks 2/3 on server-side p50 latency (fastest: narsil-rust, 0.20 ms, among engines above the measurement floor).

### beir/nfcorpus/test

Retrieval quality (higher is better). A star marks the best in each column:

| Engine | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| narsil | 0.3562\* | 0.3238\* | 0.1877\* | 0.5759\* |
| elasticsearch | 0.3523 | 0.3214 | 0.1867 | 0.5649 |
| narsil-rust | 0.3562\* | 0.3238\* | 0.1877\* | 0.5759\* |
| opensearch | 0.3522 | 0.3213 | 0.1867 | 0.5633 |
| qdrant | 0.3509 | 0.3235 | 0.1823 | 0.5672 |
| weaviate | 0.3428 | 0.3195 | 0.1809 | 0.5547 |

Ingest throughput (higher is better) and query latency (lower is better). The headline latency is each engine's own server-side query time; a star marks the best in each column:

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 1640 | 2.22 | 0.29 | 0.33 | 0.40 |
| elasticsearch | 1251 | 2.90 | 1.00 | 1.00 | 1.00 |
| narsil-rust | 1963\* | 1.85\* | 0.22 | 0.25 | 0.27 |
| opensearch | 1163 | 3.12 | 1.00 | 1.00 | 1.00 |
| qdrant | 1362 | 2.67 | 0.53 | 0.61 | 0.65 |
| weaviate | 1453 | 2.50 | n/a | n/a | n/a |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 1.26 | 1.41 | 1.55 |
| elasticsearch | 2.32 | 2.53 | 2.68 |
| narsil-rust | 1.17\* | 1.31\* | 1.42\* |
| opensearch | 2.24 | 2.56 | 2.83 |
| qdrant | 1.69 | 1.83 | 1.95 |
| weaviate | 3.77 | 5.27 | 7.63 |

Server-side time source per engine:

- narsil: response `elapsed` field (floating-millisecond resolution)
- elasticsearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- narsil-rust: response `elapsed` field (floating-millisecond resolution)
- opensearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- qdrant: top-level `time` field, seconds converted to ms (floating-millisecond resolution)
- weaviate: client round-trip only (no server-side query time exposed)

Throughput under concurrent load (higher is better). Peak QPS is the highest sustained rate across the tested concurrency levels, and 'client-limited' flags an engine whose peak the harness capped, not the engine itself. A star marks the best:

| Engine | Peak QPS | 95% CI | At concurrency | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- |
| narsil | 3006 | 2994 to 3021 | 16 | 8.75 | 24.15 | 2.04 | yes |
| elasticsearch | 2552 | 2547 to 2577 | 16 | 9.38 | 33.73 | 5.02 | yes |
| narsil-rust | 3276\* | 3273 to 3302 | 4 | 1.37 | 1.93 | 1.45 | no |
| opensearch | 2678 | 2672 to 2680 | 16 | 9.03 | 25.85 | 4.82 | yes |
| qdrant | 3032 | 3025 to 3043 | 8 | 3.36 | 5.34 | 4.00 | yes |
| weaviate | 1012 | 1005 to 1013 | 64 | 130.23 | 236.54 | 7.89 | no |

Narsil ties for the best nDCG@10 (2-way tie at 0.3562) and ranks 2/3 on server-side p50 latency (fastest: narsil-rust, 0.22 ms, among engines above the measurement floor).

### dbpedia-entities-openai-100k

Retrieval quality (higher is better). A star marks the best in each column:

| Engine | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| narsil | n/a | n/a | n/a | n/a |
| elasticsearch | n/a | n/a | n/a | n/a |
| narsil-rust | n/a | n/a | n/a | n/a |
| opensearch | n/a | n/a | n/a | n/a |
| qdrant | n/a | n/a | n/a | n/a |
| weaviate | n/a | n/a | n/a | n/a |

Ingest throughput (higher is better) and query latency (lower is better). The headline latency is each engine's own server-side query time; a star marks the best in each column:

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 840 | 119.11 | 1.58 | 2.12 | 2.32 |
| elasticsearch | 583 | 171.66 | 2.00 | 3.00 | 4.00 |
| narsil-rust | 859\* | 116.46\* | 1.58 | 2.16 | 2.33 |
| opensearch | 378 | 264.85 | 1.00 | 2.00\* | 2.00\* |
| qdrant | 801 | 124.78 | 1.72 | 2.55 | 2.94 |
| weaviate | 653 | 153.07 | n/a | n/a | n/a |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 3.53 | 4.10 | 4.43 |
| elasticsearch | 4.94 | 6.18 | 6.75 |
| narsil-rust | 3.47\* | 4.06\* | 4.26\* |
| opensearch | 3.97 | 4.63 | 5.21 |
| qdrant | 3.89 | 4.73 | 5.15 |
| weaviate | 9.58 | 10.98 | 13.13 |

Server-side time source per engine:

- narsil: response `elapsed` field (floating-millisecond resolution)
- elasticsearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- narsil-rust: response `elapsed` field (floating-millisecond resolution)
- opensearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- qdrant: top-level `time` field, seconds converted to ms (floating-millisecond resolution)
- weaviate: client round-trip only (no server-side query time exposed)

Throughput under concurrent load (higher is better). Peak QPS is the highest sustained rate across the tested concurrency levels, and 'client-limited' flags an engine whose peak the harness capped, not the engine itself. A star marks the best:

| Engine | Peak QPS | 95% CI | At concurrency | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- |
| narsil | 1652\* | 1642 to 1654 | 32 | 32.79 | 111.92 | 4.76 | yes |
| elasticsearch | 1395 | 1378 to 1405 | 64 | 77.62 | 175.06 | 6.83 | yes |
| narsil-rust | 1647 | 1646 to 1649 | 32 | 32.91 | 114.49 | 4.24 | yes |
| opensearch | 1562 | 1558 to 1563 | 32 | 33.01 | 115.91 | 4.97 | yes |
| qdrant | 1291 | 1281 to 1295 | 64 | 76.34 | 159.39 | 7.56 | no |
| weaviate | 512 | 501 to 512 | 16 | 55.86 | 91.20 | 7.94 | no |

### dbpedia-entities-openai-1m

Retrieval quality (higher is better). A star marks the best in each column:

| Engine | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| narsil | n/a | n/a | n/a | n/a |
| elasticsearch | n/a | n/a | n/a | n/a |
| narsil-rust | n/a | n/a | n/a | n/a |
| opensearch | n/a | n/a | n/a | n/a |
| qdrant | n/a | n/a | n/a | n/a |
| weaviate | n/a | n/a | n/a | n/a |

Ingest throughput (higher is better) and query latency (lower is better). The headline latency is each engine's own server-side query time; a star marks the best in each column:

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 661 | 1504.93 | 5.22 | 7.22 | 8.07 |
| elasticsearch | 433 | 2298.12 | 6.00 | 11.00 | 12.00 |
| narsil-rust | 849\* | 1172.16\* | 4.87 | 6.65 | 7.19 |
| opensearch | 193 | 5143.73 | 4.00\* | 6.00\* | 7.00\* |
| qdrant | 814 | 1221.70 | 4.87 | 7.68 | 8.92 |
| weaviate | 668 | 1490.28 | n/a | n/a | n/a |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 7.20 | 9.21 | 10.17 |
| elasticsearch | 9.03 | 13.39 | 15.18 |
| narsil-rust | 6.79 | 8.59 | 9.14\* |
| opensearch | 6.53\* | 8.36\* | 9.65 |
| qdrant | 7.06 | 9.88 | 11.10 |
| weaviate | 20.05 | 33.02 | 38.22 |

Server-side time source per engine:

- narsil: response `elapsed` field (floating-millisecond resolution)
- elasticsearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- narsil-rust: response `elapsed` field (floating-millisecond resolution)
- opensearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- qdrant: top-level `time` field, seconds converted to ms (floating-millisecond resolution)
- weaviate: client round-trip only (no server-side query time exposed)

Throughput under concurrent load (higher is better). Peak QPS is the highest sustained rate across the tested concurrency levels, and 'client-limited' flags an engine whose peak the harness capped, not the engine itself. A star marks the best:

| Engine | Peak QPS | 95% CI | At concurrency | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- |
| narsil | 979 | 971 to 989 | 16 | 30.81 | 56.55 | 7.18 | no |
| elasticsearch | 749 | 741 to 750 | 64 | 118.00 | 144.69 | 7.74 | no |
| narsil-rust | 1182 | 1178 to 1195 | 16 | 18.54 | 23.80 | 7.82 | no |
| opensearch | 1194\* | 1194 to 1205 | 32 | 37.55 | 51.95 | 7.89 | no |
| qdrant | 602 | 601 to 603 | 64 | 133.36 | 185.63 | 7.93 | no |
| weaviate | 388 | 387 to 391 | 16 | 71.00 | 147.08 | 7.96 | no |
