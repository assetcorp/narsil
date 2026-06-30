# Search-engine comparison (best config (each engine's recommended production quantization)): keyword, vector, hybrid

## Run conditions

- Vector and hybrid tracks use each engine's own recommended production quantization (Narsil SQ8, Elasticsearch BBQ, OpenSearch SQfp16, Qdrant int8 scalar, Weaviate 8-bit RQ), every engine held to the same recall target via its own search-effort knob. Compression differs by engine by design.
- Machine: Apple M3 Pro
- OS / arch: Linux 6.12.76-linuxkit / aarch64
- Equal memory cap per engine: 8.6 GB
- Run depth: 1000; BM25 reference k1=0.9, b=0.4
- Shared embedding model: sentence-transformers/all-MiniLM-L6-v2 (384 dim, cosine); latency on the vector track is compared at matched ANN recall@10 >= 0.99.
- Same datasets, metrics, run depth, and strictly-decreasing run-file ordering for every engine.
- Headline latency is each engine's own reported query time, captured from the same call the client round-trip is timed around. Resolution differs by engine and is disclosed per engine; an engine that reports no server-side time shows it as not-available and is compared on client round-trip only.

## Engines and tracks

| Engine | Version | Tracks |
|---|---|---|
| narsil | source (node:22-trixie-slim) | keyword, vector, hybrid |
| elasticsearch | 9.4.2 | keyword, vector, hybrid |
| opensearch | 3.7.0 | keyword, vector, hybrid |
| qdrant | v1.18.2 | vector, hybrid |
| weaviate | 1.38.2 | vector, hybrid |

# Vector track

## beir/scifact/test

Retrieval quality, higher is better (* marks the best in each column):

| Engine | nDCG@10 | Recall@100 | MAP | MRR |
|---|---|---|---|---|
| narsil | 0.6239* | 0.9227* | 0.5797* | 0.5849* |
| elasticsearch | 0.6239* | 0.9227* | 0.5797* | 0.5849* |
| opensearch | 0.6239* | 0.9227* | 0.5797 | 0.5849 |
| qdrant | 0.6239* | 0.9227* | 0.5797* | 0.5849* |
| weaviate | 0.6239* | 0.9227* | 0.5797* | 0.5849* |

Matched-recall operating point per engine:

| Engine | Knob | Value | ANN recall@k | Target met |
|---|---|---|---|---|
| narsil | efSearch | 64 | 0.9967 | yes |
| elasticsearch | num_candidates | 1024 | 0.9960 | yes |
| opensearch | ef_search | 64 | 0.9970 | yes |
| qdrant | hnsw_ef | 64 | 0.9967 | yes |
| weaviate | ef | 64 | 0.9953 | yes |

Ingest and latency, latency lower is better (* marks the best in each column). The headline latency is each engine's own reported query time (server-side):

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
|---|---|---|---|---|---|
| narsil | 674 | 7.69 | 0.27 | 0.41 | 0.58 |
| elasticsearch | 1866* | 2.78* | 0.00 | 0.00 | 0.00 |
| opensearch | 1697 | 3.05 | 0.00 | 0.00 | 0.00 |
| qdrant | 1711 | 3.03 | 0.18* | 0.22* | 0.25* |
| weaviate | 1638 | 3.16 | n/a | n/a | n/a |

Client round-trip latency, the same queries timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
|---|---|---|---|
| narsil | 2.42 | 2.77 | 3.30 |
| elasticsearch | 1.06 | 1.17 | 1.29 |
| opensearch | 0.85 | 0.97 | 1.15 |
| qdrant | 0.67* | 0.79* | 0.91* |
| weaviate | 1.66 | 1.97 | 4.79 |

Server-side time source per engine:

- narsil: response `elapsed` field (floating-millisecond resolution)
- elasticsearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- opensearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- qdrant: top-level `time` field (seconds, converted to ms) (floating-millisecond resolution)
- weaviate: client round-trip only (no server-side query time exposed)

Narsil standing: nDCG@10 rank 1/5 (best narsil 0.6239); server-side p50 latency rank 2/2 (fastest qdrant 0.18 ms, among engines whose server-side timing is above the measurement floor).

## beir/nfcorpus/test

Retrieval quality, higher is better (* marks the best in each column):

| Engine | nDCG@10 | Recall@100 | MAP | MRR |
|---|---|---|---|---|
| narsil | 0.3145* | 0.3094* | 0.1575 | 0.5168* |
| elasticsearch | 0.3145* | 0.3094* | 0.1575 | 0.5168 |
| opensearch | 0.3145* | 0.3094* | 0.1575* | 0.5168 |
| qdrant | 0.3145* | 0.3094* | 0.1575 | 0.5168 |
| weaviate | 0.3145* | 0.3094* | 0.1574 | 0.5168 |

Matched-recall operating point per engine:

| Engine | Knob | Value | ANN recall@k | Target met |
|---|---|---|---|---|
| narsil | efSearch | 128 | 0.9938 | yes |
| elasticsearch | num_candidates | 512 | 0.9848 | NO |
| opensearch | ef_search | 128 | 0.9941 | yes |
| qdrant | hnsw_ef | 64 | 0.9920 | yes |
| weaviate | ef | 128 | 0.9938 | yes |

Ingest and latency, latency lower is better (* marks the best in each column). The headline latency is each engine's own reported query time (server-side):

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
|---|---|---|---|---|---|
| narsil | 660 | 5.50 | 0.42 | 0.51 | 0.70 |
| elasticsearch | 2185* | 1.66* | 0.00 | 0.00 | 0.00 |
| opensearch | 1873 | 1.94 | 0.00 | 0.00 | 0.00 |
| qdrant | 1665 | 2.18 | 0.18* | 0.21* | 0.23* |
| weaviate | 1753 | 2.07 | n/a | n/a | n/a |

Client round-trip latency, the same queries timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
|---|---|---|---|
| narsil | 2.57 | 2.80 | 3.21 |
| elasticsearch | 0.93 | 1.00 | 1.07 |
| opensearch | 0.87 | 0.99 | 1.11 |
| qdrant | 0.66* | 0.74* | 0.82* |
| weaviate | 1.70 | 2.15 | 5.04 |

Server-side time source per engine:

- narsil: response `elapsed` field (floating-millisecond resolution)
- elasticsearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- opensearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- qdrant: top-level `time` field (seconds, converted to ms) (floating-millisecond resolution)
- weaviate: client round-trip only (no server-side query time exposed)

Narsil standing: nDCG@10 rank 1/5 (best narsil 0.3145); server-side p50 latency rank 2/2 (fastest qdrant 0.18 ms, among engines whose server-side timing is above the measurement floor).

# Hybrid track

## beir/scifact/test

Retrieval quality, higher is better (* marks the best in each column):

| Engine | nDCG@10 | Recall@100 | MAP | MRR |
|---|---|---|---|---|
| narsil | 0.7015 | 0.9643* | 0.6532 | 0.6596 |
| elasticsearch | 0.7053 | 0.9610 | 0.6587 | 0.6643 |
| opensearch | 0.7053 | 0.9610 | 0.6587 | 0.6643 |
| qdrant | 0.7155* | 0.9577 | 0.6730* | 0.6762* |
| weaviate | 0.6885 | 0.9577 | 0.6405 | 0.6513 |

Ingest and latency, latency lower is better (* marks the best in each column). The headline latency is each engine's own reported query time (server-side):

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
|---|---|---|---|---|---|
| narsil | 664 | 7.80 | 1.01 | 2.05 | 2.94 |
| elasticsearch | 1738 | 2.98 | 0.00 | 0.00 | 1.00 |
| opensearch | 1814 | 2.86 | 0.00 | 1.00 | 1.00 |
| qdrant | 1841* | 2.81* | 0.22* | 0.25* | 0.26* |
| weaviate | 1703 | 3.04 | n/a | n/a | n/a |

Client round-trip latency, the same queries timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
|---|---|---|---|
| narsil | 3.23 | 4.55 | 7.02 |
| elasticsearch | 1.38 | 1.59 | 1.71 |
| opensearch | 1.44 | 1.74 | 1.88 |
| qdrant | 0.74* | 0.81* | 0.89* |
| weaviate | 2.70 | 4.54 | 8.61 |

Server-side time source per engine:

- narsil: response `elapsed` field (floating-millisecond resolution)
- elasticsearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- opensearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- qdrant: top-level `time` field (seconds, converted to ms) (floating-millisecond resolution)
- weaviate: client round-trip only (no server-side query time exposed)

Narsil standing: nDCG@10 rank 4/5 (best qdrant 0.7155); server-side p50 latency rank 2/2 (fastest qdrant 0.22 ms, among engines whose server-side timing is above the measurement floor).

## beir/nfcorpus/test

Retrieval quality, higher is better (* marks the best in each column):

| Engine | nDCG@10 | Recall@100 | MAP | MRR |
|---|---|---|---|---|
| narsil | 0.3555* | 0.3239 | 0.1877* | 0.5727* |
| elasticsearch | 0.3517 | 0.3215 | 0.1867 | 0.5633 |
| opensearch | 0.3517 | 0.3216 | 0.1867 | 0.5633 |
| qdrant | 0.3510 | 0.3242* | 0.1823 | 0.5670 |
| weaviate | 0.3421 | 0.3180 | 0.1804 | 0.5569 |

Ingest and latency, latency lower is better (* marks the best in each column). The headline latency is each engine's own reported query time (server-side):

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
|---|---|---|---|---|---|
| narsil | 657 | 5.53 | 0.53 | 0.96 | 1.31 |
| elasticsearch | 2170* | 1.67* | 0.00 | 0.00 | 0.00 |
| opensearch | 1858 | 1.96 | 0.00 | 0.00 | 1.00 |
| qdrant | 1652 | 2.20 | 0.20* | 0.25* | 0.31* |
| weaviate | 1785 | 2.04 | n/a | n/a | n/a |

Client round-trip latency, the same queries timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
|---|---|---|---|
| narsil | 2.71 | 3.18 | 3.67 |
| elasticsearch | 1.17 | 1.36 | 1.53 |
| opensearch | 1.26 | 1.49 | 1.62 |
| qdrant | 0.73* | 0.93* | 1.30* |
| weaviate | 2.31 | 3.89 | 6.23 |

Server-side time source per engine:

- narsil: response `elapsed` field (floating-millisecond resolution)
- elasticsearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- opensearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- qdrant: top-level `time` field (seconds, converted to ms) (floating-millisecond resolution)
- weaviate: client round-trip only (no server-side query time exposed)

Narsil standing: nDCG@10 rank 1/5 (best narsil 0.3555); server-side p50 latency rank 2/2 (fastest qdrant 0.20 ms, among engines whose server-side timing is above the measurement floor).
