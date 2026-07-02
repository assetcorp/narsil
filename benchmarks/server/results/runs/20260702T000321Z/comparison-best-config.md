# Search-engine comparison (best config (each engine's recommended production quantization)): keyword, vector, hybrid

## Run conditions

- Vector and hybrid tracks use each engine's own recommended production quantization (Narsil SQ8, Elasticsearch BBQ, OpenSearch SQfp16, Qdrant int8 scalar, Weaviate 8-bit RQ). Every engine meets the same recall target through its own search-effort knob, so compression differs by engine by design.
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
| opensearch | 3.7.0 | 72121f014083 | keyword, vector, hybrid |
| qdrant | v1.18.2 | 44ad62f8cd69 | vector, hybrid |
| weaviate | 1.38.2 | sha256:107e8faae40e | vector, hybrid |

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
| elasticsearch | num_candidates | 128 | 0.9950 | yes |
| opensearch | ef_search | 64 | 0.9967 | yes |
| qdrant | hnsw_ef | 32 | 0.9940 | yes |
| weaviate | ef | 64 | 0.9953 | yes |

Ingest throughput (higher is better) and query latency (lower is better). The headline latency is each engine's own server-side query time; a star marks the best in each column:

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 300 | 17.30 | 0.38 | 0.47 | 0.51 |
| elasticsearch | 1129 | 4.59 | &lt;1 | &lt;1 | &lt;1 |
| opensearch | 1146\* | 4.52\* | &lt;1 | &lt;1 | &lt;1 |
| qdrant | 916 | 5.66 | 0.27 | 0.31 | 0.34 |
| weaviate | 1010 | 5.13 | n/a | n/a | n/a |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 4.62 | 4.89 | 5.12 |
| elasticsearch | 2.01 | 2.16 | 2.31 |
| opensearch | 1.78 | 1.97 | 2.21 |
| qdrant | 1.37\* | 1.58\* | 1.70\* |
| weaviate | 3.40 | 4.26 | 6.91 |

Server-side time source per engine:

- narsil: response `elapsed` field (floating-millisecond resolution)
- elasticsearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- opensearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- qdrant: top-level `time` field (seconds, converted to ms) (floating-millisecond resolution)
- weaviate: client round-trip only (no server-side query time exposed)

Throughput under concurrent load (higher is better). Peak QPS is the highest sustained rate across the tested concurrency levels, and 'client-limited' flags an engine whose peak the harness capped, not the engine itself. A star marks the best:

| Engine | Peak QPS | At concurrency | Under-load p95 ms | Client-limited |
| --- | --- | --- | --- | --- |
| narsil | 270 | 16 | 99.62 | no |
| elasticsearch | 681 | 16 | 40.09 | no |
| opensearch | 709\* | 16 | 38.69 | no |
| qdrant | 698 | 16 | 41.24 | no |
| weaviate | 616 | 16 | 43.13 | no |

Narsil ties for the best nDCG@10 (5-way tie at 0.6239) and ranks 2/2 on server-side p50 latency (fastest: qdrant, 0.27 ms, among engines above the measurement floor).

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
| narsil | efSearch | 128 | 0.9950 | yes |
| elasticsearch | num_candidates | 512 | 0.9858 | NO |
| opensearch | ef_search | 128 | 0.9938 | yes |
| qdrant | hnsw_ef | 64 | 0.9926 | yes |
| weaviate | ef | 128 | 0.9935 | yes |

Ingest throughput (higher is better) and query latency (lower is better). The headline latency is each engine's own server-side query time; a star marks the best in each column:

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 463 | 7.84 | 0.51 | 0.62 | 0.75 |
| elasticsearch | 1353\* | 2.69\* | &lt;1 | &lt;1 | &lt;1 |
| opensearch | 1129 | 3.22 | &lt;1 | &lt;1 | &lt;1 |
| qdrant | 912 | 3.98 | 0.28 | 0.32 | 0.35 |
| weaviate | 995 | 3.65 | n/a | n/a | n/a |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 4.76 | 5.16 | 5.49 |
| elasticsearch | 1.96 | 2.13 | 2.30 |
| opensearch | 1.80 | 1.97 | 2.13 |
| qdrant | 1.40\* | 1.61\* | 1.80\* |
| weaviate | 3.54 | 4.50 | 6.97 |

Server-side time source per engine:

- narsil: response `elapsed` field (floating-millisecond resolution)
- elasticsearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- opensearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- qdrant: top-level `time` field (seconds, converted to ms) (floating-millisecond resolution)
- weaviate: client round-trip only (no server-side query time exposed)

Throughput under concurrent load (higher is better). Peak QPS is the highest sustained rate across the tested concurrency levels, and 'client-limited' flags an engine whose peak the harness capped, not the engine itself. A star marks the best:

| Engine | Peak QPS | At concurrency | Under-load p95 ms | Client-limited |
| --- | --- | --- | --- | --- |
| narsil | 266 | 16 | 101.76 | no |
| elasticsearch | 669 | 16 | 41.68 | no |
| opensearch | 694 | 16 | 40.07 | no |
| qdrant | 698\* | 16 | 40.62 | no |
| weaviate | 612 | 16 | 43.11 | no |

Narsil ties for the best nDCG@10 (5-way tie at 0.3145) and ranks 2/2 on server-side p50 latency (fastest: qdrant, 0.28 ms, among engines above the measurement floor).

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
| narsil | 481 | 10.77 | 1.44 | 2.33 | 3.04 |
| elasticsearch | 1320\* | 3.93\* | 1.00 | 1.00 | 1.00 |
| opensearch | 1179 | 4.40 | 1.00 | 1.00 | 2.00 |
| qdrant | 1012 | 5.12 | 0.34 | 0.38 | 0.41 |
| weaviate | 1010 | 5.13 | n/a | n/a | n/a |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 5.72 | 6.74 | 7.48 |
| elasticsearch | 2.76 | 3.19 | 3.41 |
| opensearch | 2.73 | 3.20 | 3.42 |
| qdrant | 1.62\* | 1.83\* | 1.91\* |
| weaviate | 4.48 | 6.60 | 10.43 |

Server-side time source per engine:

- narsil: response `elapsed` field (floating-millisecond resolution)
- elasticsearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- opensearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- qdrant: top-level `time` field (seconds, converted to ms) (floating-millisecond resolution)
- weaviate: client round-trip only (no server-side query time exposed)

Throughput under concurrent load (higher is better). Peak QPS is the highest sustained rate across the tested concurrency levels, and 'client-limited' flags an engine whose peak the harness capped, not the engine itself. A star marks the best:

| Engine | Peak QPS | At concurrency | Under-load p95 ms | Client-limited |
| --- | --- | --- | --- | --- |
| narsil | 262 | 16 | 98.67 | no |
| elasticsearch | 621 | 16 | 43.36 | no |
| opensearch | 657\* | 16 | 42.02 | no |
| qdrant | 646 | 16 | 44.65 | no |
| weaviate | 490 | 16 | 55.78 | no |

Narsil ranks 4/5 on nDCG@10 (best: qdrant, 0.7155) and ranks 2/2 on server-side p50 latency (fastest: qdrant, 0.34 ms, among engines above the measurement floor).

### beir/nfcorpus/test

Retrieval quality (higher is better). A star marks the best in each column:

| Engine | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| narsil | 0.3555\* | 0.3239 | 0.1877\* | 0.5727\* |
| elasticsearch | 0.3517 | 0.3214 | 0.1867 | 0.5633 |
| opensearch | 0.3521 | 0.3216 | 0.1867 | 0.5653 |
| qdrant | 0.3514 | 0.3242\* | 0.1826 | 0.5686 |
| weaviate | 0.3425 | 0.3180 | 0.1812 | 0.5584 |

Ingest throughput (higher is better) and query latency (lower is better). The headline latency is each engine's own server-side query time; a star marks the best in each column:

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 475 | 7.65 | 0.66 | 1.30 | 1.66 |
| elasticsearch | 1389\* | 2.62\* | 1.00 | 1.00 | 1.00 |
| opensearch | 1150 | 3.16 | 1.00 | 1.00 | 1.00 |
| qdrant | 927 | 3.92 | 0.34 | 0.40 | 0.42 |
| weaviate | 1002 | 3.63 | n/a | n/a | n/a |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 4.95 | 5.64 | 6.27 |
| elasticsearch | 2.48 | 2.72 | 2.90 |
| opensearch | 2.49 | 2.84 | 3.06 |
| qdrant | 1.61\* | 1.81\* | 1.93\* |
| weaviate | 4.43 | 6.13 | 9.61 |

Server-side time source per engine:

- narsil: response `elapsed` field (floating-millisecond resolution)
- elasticsearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- opensearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- qdrant: top-level `time` field (seconds, converted to ms) (floating-millisecond resolution)
- weaviate: client round-trip only (no server-side query time exposed)

Throughput under concurrent load (higher is better). Peak QPS is the highest sustained rate across the tested concurrency levels, and 'client-limited' flags an engine whose peak the harness capped, not the engine itself. A star marks the best:

| Engine | Peak QPS | At concurrency | Under-load p95 ms | Client-limited |
| --- | --- | --- | --- | --- |
| narsil | 271 | 16 | 100.93 | no |
| elasticsearch | 634 | 16 | 42.84 | no |
| opensearch | 659 | 16 | 40.95 | no |
| qdrant | 661\* | 16 | 43.17 | no |
| weaviate | 516 | 16 | 52.80 | no |

Narsil has the best nDCG@10 at 0.3555 and ranks 2/2 on server-side p50 latency (fastest: qdrant, 0.34 ms, among engines above the measurement floor).
