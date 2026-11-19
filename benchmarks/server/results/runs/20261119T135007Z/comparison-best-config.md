# Search-engine comparison (best config (each engine's recommended production quantization)): keyword, vector, hybrid

## Run conditions

- Vector and hybrid tracks use each engine's own recommended production quantization (narsil OSQ 4-bit, elasticsearch BBQ, narsil-rust OSQ 4-bit, opensearch SQfp16, qdrant TurboQuant 4-bit, weaviate 8-bit RQ). Every engine meets the same recall target through its own search-effort knob, so compression differs by engine by design.
- Load machine: GCP c3-standard-8, us-central1-a
- OS / arch: Linux 7.0.0-1017-gcp / x86_64
- Engine machine label: GCP c3-standard-8, us-central1-a
- Engine machine: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical), 33.6 GB
- Network round trip to the engine machine: p50 0.088 ms, p99 0.169 ms over 200 TCP connects
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
| narsil-rust | 0.4.5 | 3ad47df2c9c1 | keyword, vector, hybrid |
| opensearch | 3.10.0 | b9f09249b4a9 | keyword, vector, hybrid |
| qdrant | 1.20.2 | 23065a0bf685 | vector, hybrid |
| weaviate | 1.40.5 | sha256:fe848a3830c8 | vector, hybrid |

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
| narsil | efSearch | 16 | 0.9927 | yes |
| elasticsearch | num_candidates | 16 | 0.9907 | yes |
| narsil-rust | efSearch | 16 | 0.9950 | yes |
| opensearch | ef_search | 64 | 0.9957 | yes |
| qdrant | hnsw_ef | 32 | 0.9953 | yes |
| weaviate | ef | 64 | 0.9970 | yes |

Ingest throughput (higher is better) and query latency (lower is better). The headline latency is each engine's own server-side query time; a star marks the best in each column:

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 2100 | 2.47 | 0.12 | 0.17 | 0.22 |
| elasticsearch | 1431 | 3.62 | &lt;1 | &lt;1 | &lt;1 |
| narsil-rust | 2367\* | 2.19\* | 0.09 | 0.12 | 0.14 |
| opensearch | 1123 | 4.61 | &lt;1 | &lt;1 | &lt;1 |
| qdrant | 1495 | 3.47 | 0.19 | 0.22 | 0.23 |
| weaviate | 1768 | 2.93 | n/a | n/a | n/a |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 0.39 | 0.56 | 0.76 |
| elasticsearch | 1.05 | 1.15 | 1.23 |
| narsil-rust | 0.34\* | 0.42\* | 0.47\* |
| opensearch | 0.86 | 0.96 | 1.05 |
| qdrant | 0.47 | 0.52 | 0.56 |
| weaviate | 2.38 | 3.28 | 5.74 |

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
| narsil | 15809 | 15756 to 15840 | 32 | 4.35 | 58.43 | 7.93 | no |
| elasticsearch | 7656 | 7553 to 7680 | 64 | 13.39 | 65.31 | 7.87 | no |
| narsil-rust | 30671\* | 30602 to 30696 | 128 | 6.04 | 9.26 | 7.69 | no |
| opensearch | 8117 | 8113 to 8180 | 64 | 12.30 | 20.40 | 7.90 | no |
| qdrant | 14400 | 14381 to 14497 | 128 | 15.41 | 24.58 | 6.87 | no |
| weaviate | 1663 | 1653 to 1667 | 128 | 244.64 | 527.99 | 7.85 | no |

Narsil ties for the best nDCG@10 (6-way tie at 0.6239) and ranks 2/3 on server-side p50 latency (fastest: narsil-rust, 0.09 ms, among engines above the measurement floor).

### beir/nfcorpus/test

Retrieval quality (higher is better). A star marks the best in each column:

| Engine | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| narsil | 0.3149\* | 0.3094 | 0.1576\* | 0.5194\* |
| elasticsearch | 0.3147 | 0.3094 | 0.1576\* | 0.5179 |
| narsil-rust | 0.3149\* | 0.3094 | 0.1576\* | 0.5194\* |
| opensearch | 0.3149\* | 0.3094 | 0.1576\* | 0.5194\* |
| qdrant | 0.3148 | 0.3094 | 0.1575 | 0.5189 |
| weaviate | 0.3148 | 0.3094 | 0.1576\* | 0.5179 |

Matched-recall operating point per engine:

| Engine | Knob | Value | ANN recall@k | Target met |
| --- | --- | --- | --- | --- |
| narsil | efSearch | 128 | 0.9929 | yes |
| elasticsearch | num_candidates | 8192 | 0.9848 | NO |
| narsil-rust | efSearch | 128 | 0.9932 | yes |
| opensearch | ef_search | 128 | 0.9926 | yes |
| qdrant | hnsw_ef | 64 | 0.9932 | yes |
| weaviate | ef | 160 | 0.9929 | yes |

Ingest throughput (higher is better) and query latency (lower is better). The headline latency is each engine's own server-side query time; a star marks the best in each column:

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 1562 | 2.33 | 0.17 | 0.19 | 0.23 |
| elasticsearch | 1396 | 2.60 | &lt;1 | &lt;1 | &lt;1 |
| narsil-rust | 1995\* | 1.82\* | 0.14 | 0.17 | 0.24 |
| opensearch | 1205 | 3.02 | &lt;1 | &lt;1 | &lt;1 |
| qdrant | 1331 | 2.73 | 0.21 | 0.24 | 0.26 |
| weaviate | 1424 | 2.55 | n/a | n/a | n/a |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 0.43 | 0.51 | 0.80 |
| elasticsearch | 1.24 | 1.34 | 1.61 |
| narsil-rust | 0.41\* | 0.49\* | 0.54\* |
| opensearch | 0.93 | 1.04 | 1.13 |
| qdrant | 0.50 | 0.55 | 0.59 |
| weaviate | 2.46 | 3.67 | 5.56 |

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
| narsil | 13309 | 13273 to 13336 | 128 | 16.25 | 97.12 | 7.92 | no |
| elasticsearch | 5917† | 5892 to 5918 | 64 | 15.92 | 50.18 | 7.88 | no |
| narsil-rust | 23795\* | 23768 to 23836 | 128 | 7.44 | 9.77 | 7.82 | no |
| opensearch | 7743 | 7685 to 7763 | 128 | 21.13 | 30.69 | 7.91 | no |
| qdrant | 12855 | 12847 to 12877 | 128 | 17.30 | 27.96 | 6.96 | no |
| weaviate | 1606 | 1605 to 1606 | 32 | 44.23 | 87.43 | 7.85 | no |

† missed the recall target, so its speed is shown but not ranked.

Narsil ties for the best nDCG@10 (3-way tie at 0.3149) and ranks 2/3 on server-side p50 latency (fastest: narsil-rust, 0.14 ms, among engines above the measurement floor).

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
| narsil | efSearch | 128 | 0.9918 | yes |
| elasticsearch | num_candidates | 1536 | 0.9922 | yes |
| narsil-rust | efSearch | 128 | 0.9909 | yes |
| opensearch | ef_search | 160 | 0.9915 | yes |
| qdrant | hnsw_ef | 128 | 0.9933 | yes |
| weaviate | ef | 160 | 0.9917 | yes |

Ingest throughput (higher is better) and query latency (lower is better). The headline latency is each engine's own server-side query time; a star marks the best in each column:

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 818 | 122.20 | 0.46 | 0.59 | 0.69 |
| elasticsearch | 587 | 170.22 | 1.00 | 2.00 | 2.00 |
| narsil-rust | 879\* | 113.78\* | 0.41 | 0.54 | 0.62 |
| opensearch | 693 | 144.20 | &lt;1 | &lt;1 | 1.00 |
| qdrant | 813 | 123.01 | 0.45 | 0.64 | 1.03 |
| weaviate | 657 | 152.29 | n/a | n/a | n/a |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 0.86 | 1.08 | 1.38 |
| elasticsearch | 2.24 | 2.77 | 3.00 |
| narsil-rust | 0.78\* | 0.92\* | 1.01\* |
| opensearch | 1.32 | 1.48 | 1.59 |
| qdrant | 0.85 | 1.08 | 1.48 |
| weaviate | 6.87 | 7.34 | 12.01 |

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
| narsil | 5522 | 5462 to 5536 | 64 | 23.84 | 114.61 | 7.93 | no |
| elasticsearch | 3010 | 3009 to 3046 | 32 | 16.81 | 32.94 | 7.92 | no |
| narsil-rust | 9341\* | 9285 to 9465 | 64 | 7.98 | 10.36 | 7.92 | no |
| opensearch | 5168 | 5160 to 5185 | 64 | 18.41 | 28.03 | 7.85 | no |
| qdrant | 4648 | 4600 to 4666 | 128 | 41.59 | 77.14 | 7.66 | no |
| weaviate | 609 | 608 to 609 | 16 | 61.12 | 120.74 | 7.83 | no |

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
| narsil | efSearch | 256 | 0.9921 | yes |
| elasticsearch | num_candidates | 4096 | 0.9937 | yes |
| narsil-rust | efSearch | 296 | 0.9918 | yes |
| opensearch | ef_search | 768 | 0.9904 | yes |
| qdrant | hnsw_ef | 160 | 0.9918 | yes |
| weaviate | ef | 384 | 0.9921 | yes |

Ingest throughput (higher is better) and query latency (lower is better). The headline latency is each engine's own server-side query time; a star marks the best in each column:

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 542 | 1835.54 | 1.15\* | 1.51\* | 1.64\* |
| elasticsearch | 555 | 1791.43 | 4.00 | 6.00 | 7.00 |
| narsil-rust | 882\* | 1127.97\* | 1.36 | 1.80 | 1.92 |
| opensearch | 556 | 1788.81 | 2.00 | 4.00 | 5.00 |
| qdrant | 824 | 1207.68 | 1.61 | 2.98 | 3.60 |
| weaviate | 668 | 1489.45 | n/a | n/a | n/a |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 1.58\* | 1.99\* | 2.33\* |
| elasticsearch | 4.99 | 7.06 | 8.16 |
| narsil-rust | 1.77 | 2.22 | 2.36 |
| opensearch | 2.94 | 4.75 | 6.14 |
| qdrant | 2.04 | 3.42 | 4.06 |
| weaviate | 8.86 | 9.84 | 11.82 |

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
| narsil | 3766 | 3586 to 3931 | 128 | 60.15 | 124.87 | 7.96 | no |
| elasticsearch | 1479 | 1476 to 1491 | 32 | 32.25 | 45.31 | 7.95 | no |
| narsil-rust | 3847\* | 3716 to 3879 | 16 | 5.49 | 8.12 | 7.90 | no |
| opensearch | 2849 | 2673 to 3018 | 128 | 52.96 | 67.58 | 7.95 | no |
| qdrant | 2596 | 2566 to 2636 | 128 | 57.11 | 107.77 | 7.84 | no |
| weaviate | 534 | 531 to 537 | 8 | 22.48 | 47.11 | 7.61 | no |

## Hybrid track

### beir/scifact/test

Retrieval quality (higher is better). A star marks the best in each column:

| Engine | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| narsil | 0.7054 | 0.9643\* | 0.6581 | 0.6648 |
| elasticsearch | 0.7059 | 0.9610 | 0.6592 | 0.6660 |
| narsil-rust | 0.7054 | 0.9643\* | 0.6581 | 0.6648 |
| opensearch | 0.7064 | 0.9610 | 0.6599 | 0.6665 |
| qdrant | 0.7157\* | 0.9577 | 0.6744\* | 0.6784\* |
| weaviate | 0.6840 | 0.9577 | 0.6366 | 0.6460 |

Ingest throughput (higher is better) and query latency (lower is better). The headline latency is each engine's own server-side query time; a star marks the best in each column:

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 2012 | 2.58 | 0.24 | 0.32 | 0.37 |
| elasticsearch | 1537 | 3.37 | 1.00 | 1.00 | 1.00 |
| narsil-rust | 2398\* | 2.16\* | 0.17 | 0.24 | 0.28 |
| opensearch | 1069 | 4.85 | 1.00 | 1.00 | 2.00 |
| qdrant | 1662 | 3.12 | 0.34 | 0.39 | 0.42 |
| weaviate | 1701 | 3.05 | n/a | n/a | n/a |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 0.61 | 0.72 | 0.92 |
| elasticsearch | 1.83 | 2.19 | 2.33 |
| narsil-rust | 0.47\* | 0.57\* | 0.61\* |
| opensearch | 1.77 | 2.28 | 2.50 |
| qdrant | 0.72 | 0.79 | 0.83 |
| weaviate | 3.35 | 5.97 | 8.57 |

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
| narsil | 10572 | 10571 to 10709 | 32 | 5.69 | 69.04 | 7.92 | no |
| elasticsearch | 3610 | 3586 to 3619 | 128 | 43.55 | 76.11 | 7.92 | no |
| narsil-rust | 21782\* | 21769 to 21888 | 128 | 7.99 | 10.66 | 7.82 | no |
| opensearch | 3353 | 3342 to 3362 | 32 | 13.92 | 20.37 | 7.95 | no |
| qdrant | 8973 | 8956 to 8974 | 128 | 24.04 | 40.84 | 7.00 | no |
| weaviate | 781 | 779 to 792 | 32 | 80.74 | 140.61 | 7.89 | no |

Narsil ranks 4/6 on nDCG@10 (best: qdrant, 0.7157) and ranks 2/3 on server-side p50 latency (fastest: narsil-rust, 0.17 ms, among engines above the measurement floor).

### beir/nfcorpus/test

Retrieval quality (higher is better). A star marks the best in each column:

| Engine | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| narsil | 0.3562\* | 0.3238\* | 0.1877\* | 0.5759\* |
| elasticsearch | 0.3525 | 0.3215 | 0.1868 | 0.5666 |
| narsil-rust | 0.3562\* | 0.3238\* | 0.1877\* | 0.5759\* |
| opensearch | 0.3521 | 0.3216 | 0.1865 | 0.5638 |
| qdrant | 0.3504 | 0.3236 | 0.1824 | 0.5662 |
| weaviate | 0.3431 | 0.3194 | 0.1809 | 0.5562 |

Ingest throughput (higher is better) and query latency (lower is better). The headline latency is each engine's own server-side query time; a star marks the best in each column:

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 1626 | 2.23 | 0.25 | 0.30 | 0.37 |
| elasticsearch | 1384 | 2.63 | 1.00 | 1.00 | 1.00 |
| narsil-rust | 1939\* | 1.87\* | 0.17 | 0.20 | 0.26 |
| opensearch | 1202 | 3.02 | 1.00 | 1.00 | 1.00 |
| qdrant | 1331 | 2.73 | 0.31 | 0.36 | 0.38 |
| weaviate | 1429 | 2.54 | n/a | n/a | n/a |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 0.61 | 0.71 | 0.95 |
| elasticsearch | 1.72 | 1.89 | 1.99 |
| narsil-rust | 0.43\* | 0.51\* | 0.58\* |
| opensearch | 1.44 | 1.70 | 1.86 |
| qdrant | 0.69 | 0.75 | 0.79 |
| weaviate | 3.22 | 5.51 | 8.03 |

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
| narsil | 10784 | 10711 to 10926 | 64 | 10.32 | 92.12 | 7.93 | no |
| elasticsearch | 4056 | 4051 to 4057 | 64 | 22.28 | 61.01 | 7.82 | no |
| narsil-rust | 21494\* | 21487 to 21504 | 128 | 7.96 | 10.47 | 7.88 | no |
| opensearch | 4395 | 4347 to 4435 | 64 | 19.00 | 26.04 | 7.93 | no |
| qdrant | 8783 | 8782 to 8784 | 128 | 24.69 | 41.93 | 7.03 | no |
| weaviate | 953 | 952 to 955 | 128 | 362.76 | 723.46 | 7.90 | no |

Narsil ties for the best nDCG@10 (2-way tie at 0.3562) and ranks 2/3 on server-side p50 latency (fastest: narsil-rust, 0.17 ms, among engines above the measurement floor).

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
| narsil | 812 | 123.12 | 0.58 | 0.76 | 0.91 |
| elasticsearch | 511 | 195.71 | 2.00 | 2.00 | 2.00 |
| narsil-rust | 876\* | 114.19\* | 0.51 | 0.67 | 0.77 |
| opensearch | 694 | 144.04 | 1.00 | 1.00 | 1.00 |
| qdrant | 823 | 121.44 | 0.66 | 0.94 | 1.34 |
| weaviate | 664 | 150.63 | n/a | n/a | n/a |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 1.02 | 1.31 | 1.62 |
| elasticsearch | 2.80 | 3.37 | 3.61 |
| narsil-rust | 0.91\* | 1.10\* | 1.21\* |
| opensearch | 1.77 | 2.02 | 2.16 |
| qdrant | 1.26 | 1.54 | 1.95 |
| weaviate | 7.75 | 8.40 | 15.20 |

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
| narsil | 4789 | 4749 to 4795 | 32 | 13.45 | 97.41 | 7.96 | no |
| elasticsearch | 2367 | 2353 to 2377 | 64 | 35.90 | 57.75 | 7.92 | no |
| narsil-rust | 8433\* | 8425 to 8540 | 64 | 8.77 | 11.03 | 7.92 | no |
| opensearch | 3515 | 3508 to 3549 | 32 | 14.08 | 21.76 | 7.88 | no |
| qdrant | 3606 | 3512 to 3616 | 128 | 54.45 | 85.97 | 7.65 | no |
| weaviate | 478 | 477 to 479 | 8 | 25.15 | 33.94 | 7.84 | no |

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
| narsil | 572 | 1740.12 | 2.04\* | 4.46 | 5.88 |
| elasticsearch | 543 | 1832.02 | 4.00 | 7.00 | 8.00 |
| narsil-rust | 881\* | 1129.37\* | 2.06 | 3.09\* | 3.69\* |
| opensearch | 561 | 1773.15 | 3.00 | 6.00 | 9.00 |
| qdrant | 822 | 1210.72 | 2.31 | 4.54 | 5.51 |
| weaviate | 669 | 1487.62 | n/a | n/a | n/a |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 2.56 | 5.03 | 6.42 |
| elasticsearch | 5.73 | 8.16 | 9.24 |
| narsil-rust | 2.49\* | 3.54\* | 4.14\* |
| opensearch | 3.88 | 7.26 | 9.79 |
| qdrant | 2.97 | 5.19 | 6.17 |
| weaviate | 10.13 | 11.21 | 13.62 |

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
| narsil | 2492 | 2471 to 2508 | 128 | 87.46 | 163.31 | 7.95 | no |
| elasticsearch | 1208 | 1200 to 1214 | 32 | 37.02 | 53.56 | 7.94 | no |
| narsil-rust | 2756\* | 2752 to 2761 | 128 | 49.87 | 53.18 | 7.94 | no |
| opensearch | 1952 | 1945 to 2019 | 64 | 39.46 | 55.20 | 7.90 | no |
| qdrant | 1598 | 1575 to 1625 | 128 | 101.82 | 188.85 | 7.85 | no |
| weaviate | 371 | 369 to 374 | 8 | 31.40 | 62.14 | 7.86 | no |
