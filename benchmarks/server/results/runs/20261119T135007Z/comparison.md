# Search-engine comparison (equal precision (every engine full float)): keyword, vector, hybrid

## Run conditions

- Vector and hybrid tracks hold every engine at full float (no quantization) for an equal-precision comparison.
- Load machine: GCP c3-standard-8, us-central1-a
- OS / arch: Linux 7.0.0-1017-gcp / x86_64
- Engine machine label: GCP c3-standard-8, us-central1-a
- Engine machine: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical), 33.6 GB
- Network round trip to the engine machine: p50 0.089 ms, p99 0.178 ms over 200 TCP connects
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
| narsil | 0.4.5 | 3ad47df2c9c1 | keyword, vector, hybrid |
| elasticsearch | 9.5.6 | fd1e8011342a | keyword, vector, hybrid |
| meilisearch | 1.57.0 | 1b782653f25c | keyword |
| narsil-rust | 0.4.5 | 3ad47df2c9c1 | keyword, vector, hybrid |
| opensearch | 3.10.0 | b9f09249b4a9 | keyword, vector, hybrid |
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
| narsil | 4421 | 1.17 | 0.09 | 0.17 | 0.26 |
| elasticsearch | 3709 | 1.40 | 1.00 | 1.00 | 2.00 |
| meilisearch | 1450 | 3.58 | 1.00 | 3.00 | 5.00 |
| narsil-rust | 7529\* | 0.69\* | 0.05 | 0.11 | 0.15 |
| opensearch | 5544 | 0.93 | 1.00 | 1.00 | 1.00 |
| typesense | 2115 | 2.45 | 12.00 | 45.00 | 63.00 |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 0.34 | 0.54 | 0.80 |
| elasticsearch | 2.11 | 2.82 | 3.14 |
| meilisearch | 2.24 | 3.71 | 6.41 |
| narsil-rust | 0.26\* | 0.33\* | 0.40\* |
| opensearch | 1.83 | 2.52 | 2.86 |
| typesense | 13.07 | 45.98 | 64.10 |

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
| narsil | 34198 | 34169 to 34213 | 128 | 6.43 | 15.49 | 7.91 | no |
| elasticsearch | 7208 | 7191 to 7237 | 128 | 22.72 | 35.67 | 7.90 | no |
| meilisearch | 2124 | 2114 to 2174 | 16 | 12.90 | 22.83 | 6.95 | no |
| narsil-rust | 56315\* | 56271 to 56361 | 128 | 3.37 | 6.46 | 7.48 | no |
| opensearch | 8713 | 8667 to 8734 | 128 | 18.81 | 25.98 | 7.93 | no |
| typesense | 333 | 330 to 334 | 32 | 287.98 | 528.92 | 7.92 | no |

Narsil ties for the best nDCG@10 (2-way tie at 0.6814) and ranks 2/3 on server-side p50 latency (fastest: narsil-rust, 0.05 ms, among engines above the measurement floor).

### beir/nfcorpus/test

Retrieval quality (higher is better). A star marks the best in each column:

| Engine | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| narsil | 0.3283\* | 0.2489\* | 0.1535\* | 0.5336\* |
| elasticsearch | 0.3217 | 0.2457 | 0.1503 | 0.5274 |
| meilisearch | 0.2654 | 0.1554 | 0.1214 | 0.4415 |
| narsil-rust | 0.3283\* | 0.2489\* | 0.1535\* | 0.5336\* |
| opensearch | 0.3217 | 0.2457 | 0.1503 | 0.5274 |
| typesense | 0.2420 | 0.2089 | 0.1171 | 0.4242 |

Ingest throughput (higher is better) and query latency (lower is better). The headline latency is each engine's own server-side query time; a star marks the best in each column:

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 4402 | 0.83 | 0.07 | 0.23 | 0.30 |
| elasticsearch | 6914 | 0.53 | &lt;1 | &lt;1 | &lt;1 |
| meilisearch | 1463 | 2.48 | &lt;1 | 1.00 | 2.00 |
| narsil-rust | 6717 | 0.54 | 0.02 | 0.04 | 0.05 |
| opensearch | 7625\* | 0.48\* | &lt;1 | &lt;1 | &lt;1 |
| typesense | 1968 | 1.85 | &lt;1 | 5.00 | 9.00 |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 0.32 | 0.59 | 0.71 |
| elasticsearch | 0.72 | 0.96 | 1.10 |
| meilisearch | 1.19 | 2.12 | 2.74 |
| narsil-rust | 0.22\* | 0.27\* | 0.31\* |
| opensearch | 0.68 | 0.90 | 1.01 |
| typesense | 0.82 | 5.79 | 9.80 |

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
| narsil | 51462 | 51319 to 51564 | 128 | 4.74 | 13.55 | 7.87 | no |
| elasticsearch | 13682 | 13677 to 13711 | 64 | 8.57 | 21.89 | 7.88 | no |
| meilisearch | 4166 | 4156 to 4196 | 128 | 36.16 | 40.20 | 6.22 | no |
| narsil-rust | 94225\* | 93724 to 94639 | 128 | 1.91 | 4.12 | 7.16 | yes |
| opensearch | 13527 | 13524 to 13537 | 64 | 8.36 | 15.22 | 7.92 | no |
| typesense | 4355 | 4333 to 4364 | 128 | 72.80 | 247.92 | 7.64 | no |

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
| narsil | 18039 | 5.54 | 0.06 | 0.23 | 0.31 |
| elasticsearch | 43438 | 2.30 | &lt;1 | &lt;1 | &lt;1 |
| meilisearch | 4660 | 21.46 | 1.00 | 2.00 | 3.00 |
| narsil-rust | 35693 | 2.80 | 0.03 | 0.21 | 0.28 |
| opensearch | 45892\* | 2.18\* | &lt;1 | &lt;1 | &lt;1 |
| typesense | 9098 | 10.99 | &lt;1 | 10.00 | 18.00 |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 0.30 | 0.52 | 0.64 |
| elasticsearch | 0.78 | 1.03 | 1.14 |
| meilisearch | 1.67 | 3.02 | 3.92 |
| narsil-rust | 0.24\* | 0.45\* | 0.52\* |
| opensearch | 0.66 | 0.89 | 1.05 |
| typesense | 1.20 | 11.13 | 18.60 |

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
| narsil | 33054 | 32983 to 33102 | 32 | 2.04 | 6.52 | 7.91 | no |
| elasticsearch | 12613 | 12538 to 12641 | 128 | 14.86 | 39.03 | 7.85 | no |
| meilisearch | 3206 | 3205 to 3237 | 16 | 8.71 | 14.57 | 6.65 | no |
| narsil-rust | 53510\* | 53422 to 53637 | 64 | 2.22 | 4.58 | 7.36 | no |
| opensearch | 13435 | 13356 to 13461 | 128 | 13.53 | 23.34 | 7.89 | no |
| typesense | 3429 | 3426 to 3438 | 32 | 24.14 | 272.28 | 7.53 | no |

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
| narsil | 18512 | 53.75 | 0.23 | 0.99 | 1.75 |
| elasticsearch | 46821\* | 21.25\* | &lt;1 | 1.00 | 1.00 |
| meilisearch | 461 | 2158.37 | 2.00 | 8.00 | 11.00 |
| narsil-rust | 22032 | 45.16 | 0.31 | 1.07 | 1.70 |
| opensearch | 45484 | 21.88 | &lt;1 | 1.00 | 1.00 |
| typesense | 7610 | 130.75 | 2.00 | 26.00 | 49.00 |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 0.54\* | 1.33\* | 2.12 |
| elasticsearch | 0.91 | 1.37 | 1.65\* |
| meilisearch | 3.29 | 8.40 | 11.61 |
| narsil-rust | 0.58 | 1.36 | 1.99 |
| opensearch | 0.93 | 1.56 | 2.04 |
| typesense | 2.73 | 26.53 | 49.48 |

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
| narsil | 8459 | 8380 to 8498 | 128 | 27.09 | 53.69 | 7.95 | no |
| elasticsearch | 7789 | 7766 to 7792 | 128 | 21.34 | 42.04 | 7.89 | no |
| meilisearch | 1387 | 1383 to 1414 | 16 | 22.81 | 38.63 | 7.28 | no |
| narsil-rust | 11792\* | 11749 to 11803 | 64 | 7.56 | 10.95 | 7.93 | no |
| opensearch | 7013 | 6997 to 7073 | 128 | 24.34 | 35.77 | 7.91 | no |
| typesense | 1052 | 1048 to 1067 | 128 | 277.61 | 481.98 | 7.94 | no |

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
| narsil | efSearch | 64 | 0.9960 | yes |
| elasticsearch | num_candidates | 64 | 0.9943 | yes |
| narsil-rust | efSearch | 64 | 0.9960 | yes |
| opensearch | ef_search | 64 | 0.9973 | yes |
| qdrant | hnsw_ef | 32 | 0.9923 | yes |
| weaviate | ef | 64 | 0.9967 | yes |

Ingest throughput (higher is better) and query latency (lower is better). The headline latency is each engine's own server-side query time; a star marks the best in each column:

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 1691 | 3.06 | 0.15 | 0.18 | 0.22 |
| elasticsearch | 1125 | 4.61 | &lt;1 | 1.00 | 1.00 |
| narsil-rust | 2374\* | 2.18\* | 0.12 | 0.14 | 0.15 |
| opensearch | 1070 | 4.84 | &lt;1 | &lt;1 | 1.00 |
| qdrant | 1528 | 3.39 | 0.21 | 0.24 | 0.27 |
| weaviate | 1673 | 3.10 | n/a | n/a | n/a |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 0.46 | 0.55 | 0.82 |
| elasticsearch | 1.00 | 1.81 | 1.92 |
| narsil-rust | 0.37\* | 0.43\* | 0.49\* |
| opensearch | 0.87 | 1.40 | 1.53 |
| qdrant | 0.50 | 0.56 | 0.61 |
| weaviate | 2.29 | 3.19 | 4.81 |

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
| narsil | 16931 | 16925 to 16999 | 128 | 13.15 | 25.44 | 7.93 | no |
| elasticsearch | 8493 | 8246 to 8527 | 64 | 12.34 | 81.61 | 7.79 | no |
| narsil-rust | 27162\* | 27054 to 27221 | 128 | 6.76 | 9.65 | 7.77 | no |
| opensearch | 7957 | 7946 to 7980 | 64 | 12.57 | 19.90 | 7.89 | no |
| qdrant | 12585 | 12514 to 12588 | 128 | 17.79 | 28.52 | 6.91 | no |
| weaviate | 1788 | 1788 to 1791 | 16 | 18.03 | 32.20 | 7.86 | no |

Narsil ties for the best nDCG@10 (6-way tie at 0.6239) and ranks 2/3 on server-side p50 latency (fastest: narsil-rust, 0.12 ms, among engines above the measurement floor).

### beir/nfcorpus/test

Retrieval quality (higher is better). A star marks the best in each column:

| Engine | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| narsil | 0.3149\* | 0.3094 | 0.1576 | 0.5194\* |
| elasticsearch | 0.3147 | 0.3094 | 0.1576 | 0.5179 |
| narsil-rust | 0.3149\* | 0.3094 | 0.1576 | 0.5194\* |
| opensearch | 0.3147 | 0.3094 | 0.1576 | 0.5179 |
| qdrant | 0.3148 | 0.3094 | 0.1576 | 0.5189 |
| weaviate | 0.3148 | 0.3094 | 0.1576 | 0.5179 |

Matched-recall operating point per engine:

| Engine | Knob | Value | ANN recall@k | Target met |
| --- | --- | --- | --- | --- |
| narsil | efSearch | 128 | 0.9944 | yes |
| elasticsearch | num_candidates | 192 | 0.9901 | yes |
| narsil-rust | efSearch | 128 | 0.9910 | yes |
| opensearch | ef_search | 128 | 0.9950 | yes |
| qdrant | hnsw_ef | 64 | 0.9935 | yes |
| weaviate | ef | 160 | 0.9932 | yes |

Ingest throughput (higher is better) and query latency (lower is better). The headline latency is each engine's own server-side query time; a star marks the best in each column:

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 1564 | 2.32 | 0.20 | 0.23 | 0.26 |
| elasticsearch | 1230 | 2.95 | &lt;1 | &lt;1 | &lt;1 |
| narsil-rust | 2273\* | 1.60\* | 0.17 | 0.20 | 0.21 |
| opensearch | 1141 | 3.18 | &lt;1 | &lt;1 | &lt;1 |
| qdrant | 1274 | 2.85 | 0.25 | 0.28 | 0.30 |
| weaviate | 1379 | 2.63 | n/a | n/a | n/a |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 0.50 | 0.58 | 0.93 |
| elasticsearch | 1.11 | 1.24 | 1.32 |
| narsil-rust | 0.44\* | 0.50\* | 0.54\* |
| opensearch | 0.95 | 1.05 | 1.12 |
| qdrant | 0.54 | 0.61 | 0.69 |
| weaviate | 2.40 | 3.30 | 5.33 |

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
| narsil | 13799 | 13794 to 14027 | 32 | 4.57 | 11.98 | 7.94 | no |
| elasticsearch | 7288 | 7138 to 7290 | 64 | 13.91 | 66.90 | 7.86 | no |
| narsil-rust | 21238\* | 21167 to 21265 | 128 | 7.93 | 10.08 | 7.85 | no |
| opensearch | 7563 | 7551 to 7567 | 128 | 21.51 | 29.65 | 7.92 | no |
| qdrant | 10937 | 10928 to 10957 | 128 | 20.48 | 32.76 | 7.05 | no |
| weaviate | 1684 | 1681 to 1689 | 16 | 19.27 | 34.26 | 7.86 | no |

Narsil ties for the best nDCG@10 (2-way tie at 0.3149) and ranks 2/3 on server-side p50 latency (fastest: narsil-rust, 0.17 ms, among engines above the measurement floor).

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
| narsil | efSearch | 128 | 0.9915 | yes |
| elasticsearch | num_candidates | 768 | 0.9917 | yes |
| narsil-rust | efSearch | 128 | 0.9914 | yes |
| opensearch | ef_search | 128 | 0.9916 | yes |
| qdrant | hnsw_ef | 128 | 0.9946 | yes |
| weaviate | ef | 160 | 0.9917 | yes |

Ingest throughput (higher is better) and query latency (lower is better). The headline latency is each engine's own server-side query time; a star marks the best in each column:

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 850 | 117.71 | 1.04 | 1.41 | 1.53 |
| elasticsearch | 562 | 177.92 | 2.00 | 3.00 | 4.00 |
| narsil-rust | 886\* | 112.86\* | 1.02 | 1.40 | 1.52 |
| opensearch | 362 | 276.03 | 1.00 | 1.00 | 1.00 |
| qdrant | 798 | 125.28 | 1.39 | 1.84 | 2.31 |
| weaviate | 656 | 152.45 | n/a | n/a | n/a |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 1.49 | 1.90 | 2.18 |
| elasticsearch | 3.06 | 4.40 | 4.99 |
| narsil-rust | 1.41\* | 1.80\* | 1.93\* |
| opensearch | 1.86 | 2.23 | 2.37 |
| qdrant | 1.82 | 2.28 | 2.75 |
| weaviate | 7.30 | 7.77 | 10.77 |

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
| narsil | 3589 | 3567 to 3592 | 32 | 16.35 | 32.14 | 7.94 | no |
| elasticsearch | 1955 | 1921 to 1965 | 16 | 13.99 | 28.40 | 7.82 | no |
| narsil-rust | 4794\* | 4660 to 5195 | 32 | 8.03 | 10.04 | 7.93 | no |
| opensearch | 3219 | 3188 to 3222 | 32 | 15.47 | 22.52 | 7.93 | no |
| qdrant | 1525 | 1517 to 1536 | 128 | 96.93 | 137.20 | 7.89 | no |
| weaviate | 616 | 615 to 617 | 16 | 55.48 | 105.88 | 7.76 | no |

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
| narsil | efSearch | 280 | 0.9920 | yes |
| elasticsearch | num_candidates | 1536 | 0.9911 | yes |
| narsil-rust | efSearch | 264 | 0.9920 | yes |
| opensearch | ef_search | 248 | 0.9913 | yes |
| qdrant | hnsw_ef | 192 | 0.9927 | yes |
| weaviate | ef | 416 | 0.9927 | yes |

Ingest throughput (higher is better) and query latency (lower is better). The headline latency is each engine's own server-side query time; a star marks the best in each column:

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 743 | 1339.09 | 2.98 | 4.04 | 4.27 |
| elasticsearch | 503 | 1979.37 | 5.00 | 8.00 | 10.00 |
| narsil-rust | 878\* | 1132.82\* | 2.76\* | 3.73\* | 3.94\* |
| opensearch | 228 | 4371.76 | 3.00 | 4.00 | 5.00 |
| qdrant | 817 | 1218.56 | 3.59 | 5.27 | 6.21 |
| weaviate | 668 | 1489.98 | n/a | n/a | n/a |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 3.45 | 4.52 | 4.79 |
| elasticsearch | 5.75 | 9.31 | 10.89 |
| narsil-rust | 3.18\* | 4.17\* | 4.37\* |
| opensearch | 3.50 | 4.83 | 5.82 |
| qdrant | 4.04 | 5.73 | 6.67 |
| weaviate | 10.86 | 12.45 | 13.37 |

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
| narsil | 1659 | 1631 to 1663 | 64 | 67.17 | 125.34 | 7.96 | no |
| elasticsearch | 1118 | 1100 to 1133 | 32 | 44.46 | 58.92 | 7.94 | no |
| narsil-rust | 1971\* | 1849 to 2005 | 64 | 37.89 | 41.98 | 7.96 | no |
| opensearch | 1719 | 1694 to 1753 | 64 | 44.91 | 60.49 | 7.96 | no |
| qdrant | 647 | 643 to 661 | 128 | 212.28 | 290.24 | 7.94 | no |
| weaviate | 476 | 476 to 480 | 8 | 22.22 | 45.22 | 7.58 | no |

## Hybrid track

### beir/scifact/test

Retrieval quality (higher is better). A star marks the best in each column:

| Engine | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| narsil | 0.7054 | 0.9643\* | 0.6581 | 0.6648 |
| elasticsearch | 0.7078 | 0.9610 | 0.6620 | 0.6676 |
| narsil-rust | 0.7054 | 0.9643\* | 0.6581 | 0.6648 |
| opensearch | 0.7077 | 0.9610 | 0.6619 | 0.6676 |
| qdrant | 0.7095\* | 0.9577 | 0.6661\* | 0.6700\* |
| weaviate | 0.6840 | 0.9577 | 0.6366 | 0.6460 |

Ingest throughput (higher is better) and query latency (lower is better). The headline latency is each engine's own server-side query time; a star marks the best in each column:

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 1989 | 2.61 | 0.29 | 0.37 | 0.44 |
| elasticsearch | 1454 | 3.57 | 1.00 | 2.00 | 2.00 |
| narsil-rust | 2333\* | 2.22\* | 0.19 | 0.24\* | 0.27\* |
| opensearch | 1064 | 4.87 | 1.00 | 2.00 | 2.00 |
| qdrant | 1640 | 3.16 | 0.37 | 0.43 | 0.45 |
| weaviate | 1652 | 3.14 | n/a | n/a | n/a |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 0.68 | 0.82 | 1.07 |
| elasticsearch | 2.23 | 2.72 | 2.98 |
| narsil-rust | 0.50\* | 0.58\* | 0.63\* |
| opensearch | 1.97 | 2.47 | 2.70 |
| qdrant | 0.77 | 0.84 | 0.89 |
| weaviate | 3.19 | 5.50 | 6.87 |

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
| narsil | 11835 | 11798 to 11838 | 128 | 18.59 | 34.45 | 7.93 | no |
| elasticsearch | 3678 | 3673 to 3721 | 128 | 42.62 | 83.67 | 7.89 | no |
| narsil-rust | 19998\* | 19936 to 20005 | 128 | 8.32 | 10.80 | 7.86 | no |
| opensearch | 3352 | 3347 to 3371 | 32 | 13.86 | 19.39 | 7.93 | no |
| qdrant | 8575 | 8521 to 8575 | 128 | 25.25 | 43.83 | 7.00 | no |
| weaviate | 842 | 840 to 843 | 32 | 76.32 | 134.75 | 7.89 | no |

Narsil ranks 4/6 on nDCG@10 (best: qdrant, 0.7095) and ranks 2/3 on server-side p50 latency (fastest: narsil-rust, 0.19 ms, among engines above the measurement floor).

### beir/nfcorpus/test

Retrieval quality (higher is better). A star marks the best in each column:

| Engine | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| narsil | 0.3562\* | 0.3238\* | 0.1877\* | 0.5759\* |
| elasticsearch | 0.3522 | 0.3215 | 0.1867 | 0.5648 |
| narsil-rust | 0.3562\* | 0.3238\* | 0.1877\* | 0.5759\* |
| opensearch | 0.3521 | 0.3213 | 0.1867 | 0.5633 |
| qdrant | 0.3504 | 0.3236 | 0.1826 | 0.5703 |
| weaviate | 0.3428 | 0.3195 | 0.1810 | 0.5548 |

Ingest throughput (higher is better) and query latency (lower is better). The headline latency is each engine's own server-side query time; a star marks the best in each column:

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 1590 | 2.28 | 0.29 | 0.34 | 0.37 |
| elasticsearch | 1179 | 3.08 | 1.00 | 1.00 | 1.00 |
| narsil-rust | 2093\* | 1.74\* | 0.21 | 0.24 | 0.26 |
| opensearch | 1092 | 3.33 | 1.00 | 1.00 | 1.00 |
| qdrant | 1333 | 2.73 | 0.34 | 0.40 | 0.42 |
| weaviate | 1441 | 2.52 | n/a | n/a | n/a |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 0.63 | 0.72 | 1.02 |
| elasticsearch | 1.61 | 1.79 | 1.90 |
| narsil-rust | 0.49\* | 0.58\* | 0.63\* |
| opensearch | 1.47 | 1.77 | 1.96 |
| qdrant | 0.73 | 0.82 | 0.86 |
| weaviate | 3.06 | 4.48 | 7.47 |

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
| narsil | 11604 | 11578 to 11613 | 128 | 18.88 | 36.38 | 7.94 | no |
| elasticsearch | 4555 | 4523 to 4585 | 64 | 20.28 | 61.63 | 7.84 | no |
| narsil-rust | 18913\* | 18884 to 18916 | 128 | 8.64 | 11.02 | 7.88 | no |
| opensearch | 4356 | 4351 to 4365 | 64 | 18.98 | 25.24 | 7.94 | no |
| qdrant | 7866 | 7854 to 7870 | 128 | 27.48 | 46.84 | 7.06 | no |
| weaviate | 1019 | 1018 to 1020 | 128 | 282.38 | 635.05 | 7.89 | no |

Narsil ties for the best nDCG@10 (2-way tie at 0.3562) and ranks 2/3 on server-side p50 latency (fastest: narsil-rust, 0.21 ms, among engines above the measurement floor).

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
| narsil | 855 | 117.02 | 1.16 | 1.53 | 1.67 |
| elasticsearch | 551 | 181.45 | 2.00 | 4.00 | 4.00 |
| narsil-rust | 879\* | 113.71\* | 1.05 | 1.43\* | 1.56\* |
| opensearch | 373 | 268.12 | 1.00 | 2.00 | 2.00 |
| qdrant | 798 | 125.25 | 1.62 | 2.36 | 2.80 |
| weaviate | 662 | 151.08 | n/a | n/a | n/a |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 1.62 | 2.04 | 2.37 |
| elasticsearch | 3.53 | 4.83 | 5.39 |
| narsil-rust | 1.46\* | 1.84\* | 1.98\* |
| opensearch | 2.33 | 3.20 | 3.64 |
| qdrant | 2.23 | 2.97 | 3.43 |
| weaviate | 8.00 | 8.53 | 11.30 |

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
| narsil | 3218 | 3172 to 3228 | 32 | 19.40 | 43.57 | 7.95 | no |
| elasticsearch | 1562 | 1558 to 1579 | 128 | 99.18 | 142.88 | 7.94 | no |
| narsil-rust | 4647\* | 4423 to 4736 | 32 | 8.53 | 10.53 | 7.94 | no |
| opensearch | 2449 | 2445 to 2481 | 16 | 10.90 | 16.45 | 7.77 | no |
| qdrant | 1404 | 1389 to 1410 | 128 | 117.35 | 198.79 | 7.87 | no |
| weaviate | 513 | 509 to 520 | 8 | 20.60 | 32.01 | 7.85 | no |

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
| narsil | 704 | 1413.38 | 3.48 | 4.84 | 5.56 |
| elasticsearch | 445 | 2236.28 | 5.00 | 9.00 | 10.00 |
| narsil-rust | 880\* | 1130.64\* | 3.30 | 4.53\* | 5.02\* |
| opensearch | 220 | 4517.24 | 3.00\* | 5.00 | 6.00 |
| qdrant | 810 | 1228.98 | 4.86 | 7.70 | 8.87 |
| weaviate | 668 | 1489.22 | n/a | n/a | n/a |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 4.01 | 5.38 | 6.18 |
| elasticsearch | 6.51 | 10.17 | 11.80 |
| narsil-rust | 3.76\* | 4.99\* | 5.50\* |
| opensearch | 4.30 | 6.01 | 7.25 |
| qdrant | 5.50 | 8.37 | 9.52 |
| weaviate | 16.78 | 29.49 | 36.38 |

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
| narsil | 1304 | 1280 to 1310 | 64 | 85.02 | 152.53 | 7.96 | no |
| elasticsearch | 904 | 896 to 917 | 32 | 51.65 | 72.85 | 7.95 | no |
| narsil-rust | 1614\* | 1596 to 1650 | 64 | 42.97 | 47.06 | 7.96 | no |
| opensearch | 1396 | 1392 to 1403 | 64 | 55.06 | 74.17 | 7.93 | no |
| qdrant | 599 | 592 to 599 | 128 | 227.97 | 299.75 | 7.93 | no |
| weaviate | 380 | 372 to 381 | 32 | 121.20 | 328.90 | 7.91 | no |
