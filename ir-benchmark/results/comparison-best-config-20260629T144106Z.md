# Search-engine comparison (best config (each engine's recommended production quantization)): keyword, vector, hybrid

## Run conditions

- Vector and hybrid tracks use each engine's own recommended production quantization (Narsil SQ8, Elasticsearch BBQ, OpenSearch SQfp16, Qdrant int8 scalar, Weaviate 8-bit RQ), every engine held to the same recall target via its own search-effort knob. Compression differs by engine by design.
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
| qdrant | v1.18.2 | vector, hybrid |
| weaviate | 1.38.2 | vector, hybrid |

# Vector track

## beir/scifact/test

Retrieval quality, higher is better (* marks the best in each column):

| Engine | nDCG@10 | Recall@100 | MAP | MRR |
|---|---|---|---|---|
| narsil | 0.6239* | 0.9227* | 0.5797* | 0.5849* |
| elasticsearch | 0.6239* | 0.9227* | 0.5797* | 0.5849* |
| qdrant | 0.6239* | 0.9227* | 0.5797* | 0.5849* |
| weaviate | 0.6239* | 0.9227* | 0.5797* | 0.5849* |

Matched-recall operating point per engine:

| Engine | Knob | Value | ANN recall@k | Target met |
|---|---|---|---|---|
| narsil | efSearch | 64 | 0.9967 | yes |
| elasticsearch | num_candidates | 1024 | 0.9513 | NO |
| qdrant | hnsw_ef | 64 | 0.9987 | yes |
| weaviate | ef | 64 | 0.9953 | yes |

Ingest and latency, latency lower is better (* marks the best in each column). The headline latency is each engine's own reported query time (server-side):

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
|---|---|---|---|---|---|
| narsil | 567 | 9.14 | 0.33 | 0.60 | 1.32 |
| elasticsearch | 1665 | 3.11 | 0.00 | 0.00 | 1.00 |
| qdrant | 1618 | 3.20 | 0.19* | 0.23* | 0.26* |
| weaviate | 1698* | 3.05* | n/a | n/a | n/a |

Client round-trip latency, the same queries timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
|---|---|---|---|
| narsil | 2.49 | 3.10 | 4.15 |
| elasticsearch | 1.03 | 1.44 | 2.76 |
| qdrant | 0.68* | 0.78* | 0.85* |
| weaviate | 1.71 | 2.37 | 4.70 |

Server-side time source per engine:

- narsil: response `elapsed` field (floating-millisecond resolution)
- elasticsearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- qdrant: top-level `time` field (seconds, converted to ms) (floating-millisecond resolution)
- weaviate: client round-trip only (no server-side query time exposed)

Narsil standing: nDCG@10 rank 1/4 (best narsil 0.6239); server-side p50 latency rank 2/2 (fastest qdrant 0.19 ms, among engines whose server-side timing is above the measurement floor).

# Hybrid track

## beir/scifact/test

Retrieval quality, higher is better (* marks the best in each column):

| Engine | nDCG@10 | Recall@100 | MAP | MRR |
|---|---|---|---|---|
| narsil | 0.7015 | 0.9643* | 0.6532 | 0.6596 |
| elasticsearch | 0.7053 | 0.9610 | 0.6587 | 0.6643 |
| qdrant | 0.7155* | 0.9577 | 0.6730* | 0.6762* |
| weaviate | 0.6885 | 0.9577 | 0.6405 | 0.6513 |

Ingest and latency, latency lower is better (* marks the best in each column). The headline latency is each engine's own reported query time (server-side):

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
|---|---|---|---|---|---|
| narsil | 574 | 9.04 | 1.12 | 2.01 | 2.99 |
| elasticsearch | 1687 | 3.07 | 0.00 | 1.00 | 1.00 |
| qdrant | 1756* | 2.95* | 0.22* | 0.26* | 0.31* |
| weaviate | 1700 | 3.05 | n/a | n/a | n/a |

Client round-trip latency, the same queries timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
|---|---|---|---|
| narsil | 3.34 | 4.46 | 6.46 |
| elasticsearch | 1.41 | 1.72 | 2.15 |
| qdrant | 0.76* | 0.89* | 1.11* |
| weaviate | 2.71 | 4.99 | 7.93 |

Server-side time source per engine:

- narsil: response `elapsed` field (floating-millisecond resolution)
- elasticsearch: response `took` field (integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms)
- qdrant: top-level `time` field (seconds, converted to ms) (floating-millisecond resolution)
- weaviate: client round-trip only (no server-side query time exposed)

Narsil standing: nDCG@10 rank 3/4 (best qdrant 0.7155); server-side p50 latency rank 2/2 (fastest qdrant 0.22 ms, among engines whose server-side timing is above the measurement floor).
