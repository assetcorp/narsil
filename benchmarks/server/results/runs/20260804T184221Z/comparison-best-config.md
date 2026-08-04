# Search-engine comparison (best config (each engine's recommended production quantization)): keyword, vector, hybrid

## Run conditions

- Vector and hybrid tracks use each engine's own recommended production quantization (Narsil SQ8, Elasticsearch BBQ, OpenSearch SQfp16, Qdrant int8 scalar, Weaviate 8-bit RQ). Every engine meets the same recall target through its own search-effort knob, so compression differs by engine by design.
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
| opensearch | 3.7.0 | 72121f014083 | keyword, vector, hybrid |
| qdrant | 1.18.3 | db8fa43fcb6a | vector, hybrid |
| weaviate | 1.39.0 | sha256:7660940e14fa | vector, hybrid |

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
| elasticsearch | num_candidates | 256 | 0.9957 | yes |
| opensearch | ef_search | 64 | 0.9940 | yes |
| qdrant | hnsw_ef | 32 | 0.9930 | yes |
| weaviate | ef | 64 | 0.9953 | yes |

Ingest throughput (higher is better) and query latency (lower is better). The headline latency is each engine's own server-side query time; a star marks the best in each column:

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 288 | 18.00 | 0.45 | 0.55 | 0.68 |
| elasticsearch | 1163\* | 4.45\* | &lt;1 | &lt;1 | &lt;1 |
| opensearch | 1101 | 4.71 | &lt;1 | &lt;1 | &lt;1 |
| qdrant | 915 | 5.67 | 0.24 | 0.28 | 0.31 |
| weaviate | 1007 | 5.15 | n/a | n/a | n/a |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 4.82 | 5.13 | 6.02 |
| elasticsearch | 2.04 | 2.22 | 2.35 |
| opensearch | 1.93 | 2.16 | 2.33 |
| qdrant | 1.30\* | 1.48\* | 1.57\* |
| weaviate | 3.32 | 4.25 | 7.45 |

Server-side time source per engine:

- narsil: response `elapsed` field (floating-millisecond resolution)
- elasticsearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- opensearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- qdrant: top-level `time` field, seconds converted to ms (floating-millisecond resolution)
- weaviate: client round-trip only (no server-side query time exposed)

Throughput under concurrent load (higher is better). Peak QPS is the highest sustained rate across the tested concurrency levels, and 'client-limited' flags an engine whose peak the harness capped, not the engine itself. A star marks the best:

| Engine | Peak QPS | At concurrency | Under-load p95 ms | Client-limited |
| --- | --- | --- | --- | --- |
| narsil | 269 | 16 | 104.77 | no |
| elasticsearch | 705 | 16 | 40.19 | no |
| opensearch | 727 | 16 | 37.88 | no |
| qdrant | 740\* | 16 | 39.18 | no |
| weaviate | 625 | 16 | 43.32 | no |

Narsil ties for the best nDCG@10 (5-way tie at 0.6239) and ranks 2/2 on server-side p50 latency (fastest: qdrant, 0.24 ms, among engines above the measurement floor).

### beir/nfcorpus/test

Retrieval quality (higher is better). A star marks the best in each column:

| Engine | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| narsil | 0.3145 | 0.3094 | 0.1575\* | 0.5168 |
| elasticsearch | 0.3145 | 0.3094 | 0.1575\* | 0.5168 |
| opensearch | 0.3145 | 0.3094 | 0.1575\* | 0.5168 |
| qdrant | 0.3145 | 0.3094 | 0.1575\* | 0.5168 |
| weaviate | 0.3145 | 0.3094 | 0.1574 | 0.5168 |

Matched-recall operating point per engine:

| Engine | Knob | Value | ANN recall@k | Target met |
| --- | --- | --- | --- | --- |
| narsil | efSearch | 128 | 0.9947 | yes |
| elasticsearch | num_candidates | 512 | 0.9848 | NO |
| opensearch | ef_search | 128 | 0.9938 | yes |
| qdrant | hnsw_ef | 64 | 0.9916 | yes |
| weaviate | ef | 128 | 0.9938 | yes |

Ingest throughput (higher is better) and query latency (lower is better). The headline latency is each engine's own server-side query time; a star marks the best in each column:

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 462 | 7.87 | 0.52 | 0.65 | 0.73 |
| elasticsearch | 1409\* | 2.58\* | &lt;1 | &lt;1 | &lt;1 |
| opensearch | 1126 | 3.23 | &lt;1 | &lt;1 | &lt;1 |
| qdrant | 917 | 3.96 | 0.26 | 0.30 | 0.33 |
| weaviate | 990 | 3.67 | n/a | n/a | n/a |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 4.87 | 5.15 | 5.42 |
| elasticsearch | 1.90 | 2.02 | 2.19 |
| opensearch | 1.83 | 2.04 | 2.24 |
| qdrant | 1.35\* | 1.55\* | 1.68\* |
| weaviate | 3.38 | 4.28 | 7.45 |

Server-side time source per engine:

- narsil: response `elapsed` field (floating-millisecond resolution)
- elasticsearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- opensearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- qdrant: top-level `time` field, seconds converted to ms (floating-millisecond resolution)
- weaviate: client round-trip only (no server-side query time exposed)

Throughput under concurrent load (higher is better). Peak QPS is the highest sustained rate across the tested concurrency levels, and 'client-limited' flags an engine whose peak the harness capped, not the engine itself. A star marks the best:

| Engine | Peak QPS | At concurrency | Under-load p95 ms | Client-limited |
| --- | --- | --- | --- | --- |
| narsil | 270 | 16 | 102.27 | no |
| elasticsearch | 704 | 16 | 40.72 | no |
| opensearch | 726 | 16 | 38.96 | no |
| qdrant | 770\* | 16 | 36.47 | no |
| weaviate | 630 | 16 | 43.49 | no |

Narsil ties for the best nDCG@10 (5-way tie at 0.3145) and ranks 2/2 on server-side p50 latency (fastest: qdrant, 0.26 ms, among engines above the measurement floor).

## Hybrid track

### beir/scifact/test

Retrieval quality (higher is better). A star marks the best in each column:

| Engine | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| narsil | 0.7026 | 0.9643\* | 0.6543 | 0.6615 |
| elasticsearch | 0.7053 | 0.9610 | 0.6587 | 0.6643 |
| opensearch | 0.7053 | 0.9610 | 0.6587 | 0.6643 |
| qdrant | 0.7155\* | 0.9577 | 0.6730\* | 0.6762\* |
| weaviate | 0.6886 | 0.9577 | 0.6407 | 0.6513 |

Ingest throughput (higher is better) and query latency (lower is better). The headline latency is each engine's own server-side query time; a star marks the best in each column:

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 467 | 11.10 | 1.52 | 2.47 | 3.28 |
| elasticsearch | 1396\* | 3.71\* | 1.00 | 1.00 | 1.00 |
| opensearch | 1128 | 4.59 | 1.00 | 2.00 | 2.00 |
| qdrant | 1016 | 5.10 | 0.32 | 0.37 | 0.40 |
| weaviate | 1007 | 5.15 | n/a | n/a | n/a |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 5.89 | 6.92 | 7.70 |
| elasticsearch | 2.81 | 3.20 | 3.37 |
| opensearch | 2.90 | 3.37 | 3.65 |
| qdrant | 1.60\* | 1.81\* | 1.96\* |
| weaviate | 4.43 | 6.21 | 11.11 |

Server-side time source per engine:

- narsil: response `elapsed` field (floating-millisecond resolution)
- elasticsearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- opensearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- qdrant: top-level `time` field, seconds converted to ms (floating-millisecond resolution)
- weaviate: client round-trip only (no server-side query time exposed)

Throughput under concurrent load (higher is better). Peak QPS is the highest sustained rate across the tested concurrency levels, and 'client-limited' flags an engine whose peak the harness capped, not the engine itself. A star marks the best:

| Engine | Peak QPS | At concurrency | Under-load p95 ms | Client-limited |
| --- | --- | --- | --- | --- |
| narsil | 267 | 16 | 104.12 | no |
| elasticsearch | 652 | 16 | 41.70 | no |
| opensearch | 670 | 16 | 41.12 | no |
| qdrant | 685\* | 16 | 41.49 | no |
| weaviate | 505 | 16 | 53.35 | no |

Narsil ranks 4/5 on nDCG@10 (best: qdrant, 0.7155) and ranks 2/2 on server-side p50 latency (fastest: qdrant, 0.32 ms, among engines above the measurement floor).

### beir/nfcorpus/test

Retrieval quality (higher is better). A star marks the best in each column:

| Engine | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| narsil | 0.3560\* | 0.3239 | 0.1878\* | 0.5745\* |
| elasticsearch | 0.3517 | 0.3214 | 0.1867 | 0.5633 |
| opensearch | 0.3521 | 0.3216 | 0.1867 | 0.5653 |
| qdrant | 0.3507 | 0.3241\* | 0.1823 | 0.5650 |
| weaviate | 0.3425 | 0.3180 | 0.1804 | 0.5584 |

Ingest throughput (higher is better) and query latency (lower is better). The headline latency is each engine's own server-side query time; a star marks the best in each column:

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 464 | 7.83 | 0.80 | 1.66 | 2.11 |
| elasticsearch | 1432\* | 2.54\* | 1.00 | 1.00 | 1.00 |
| opensearch | 1135 | 3.20 | 1.00 | 1.00 | 1.00 |
| qdrant | 918 | 3.96 | 0.32 | 0.37 | 0.39 |
| weaviate | 1026 | 3.54 | n/a | n/a | n/a |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 5.36 | 6.31 | 7.00 |
| elasticsearch | 2.47 | 2.69 | 2.84 |
| opensearch | 2.40 | 2.74 | 2.96 |
| qdrant | 1.57\* | 1.73\* | 1.89\* |
| weaviate | 4.23 | 6.31 | 8.85 |

Server-side time source per engine:

- narsil: response `elapsed` field (floating-millisecond resolution)
- elasticsearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- opensearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- qdrant: top-level `time` field, seconds converted to ms (floating-millisecond resolution)
- weaviate: client round-trip only (no server-side query time exposed)

Throughput under concurrent load (higher is better). Peak QPS is the highest sustained rate across the tested concurrency levels, and 'client-limited' flags an engine whose peak the harness capped, not the engine itself. A star marks the best:

| Engine | Peak QPS | At concurrency | Under-load p95 ms | Client-limited |
| --- | --- | --- | --- | --- |
| narsil | 263 | 16 | 102.16 | no |
| elasticsearch | 666 | 16 | 42.77 | no |
| opensearch | 689 | 16 | 40.43 | no |
| qdrant | 698\* | 16 | 41.81 | no |
| weaviate | 538 | 16 | 49.00 | no |

Narsil has the best nDCG@10 at 0.3560 and ranks 2/2 on server-side p50 latency (fastest: qdrant, 0.32 ms, among engines above the measurement floor).
