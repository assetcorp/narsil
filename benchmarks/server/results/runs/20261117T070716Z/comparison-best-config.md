# Search-engine comparison (best config (each engine's recommended production quantization)): keyword, vector, hybrid

## Run conditions

- Vector and hybrid tracks use each engine's own recommended production quantization (narsil OSQ 4-bit, elasticsearch BBQ, narsil-rust OSQ 4-bit, opensearch SQfp16, qdrant TurboQuant 4-bit, weaviate 8-bit RQ). Every engine meets the same recall target through its own search-effort knob, so compression differs by engine by design.
- Load machine: GCP c3-standard-8, us-central1-a
- OS / arch: Linux 7.0.0-1017-gcp / x86_64
- Engine machine label: GCP c3-standard-8, us-central1-a
- Engine machine: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical), 33.6 GB
- Network round trip to the engine machine: p50 0.083 ms, p99 0.159 ms over 200 TCP connects
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
| narsil-rust | 0.4.3 | d3efdcbcb2d2 | keyword, vector, hybrid |
| opensearch | 3.9.0 | 4ee42a94e87f | keyword, vector, hybrid |
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
| narsil | efSearch | 16 | 0.9920 | yes |
| elasticsearch | num_candidates | 16 | 0.9920 | yes |
| narsil-rust | efSearch | 16 | 0.9937 | yes |
| opensearch | ef_search | 64 | 0.9980 | yes |
| qdrant | hnsw_ef | 32 | 0.9937 | yes |
| weaviate | ef | 64 | 0.9970 | yes |

Ingest throughput (higher is better) and query latency (lower is better). The headline latency is each engine's own server-side query time; a star marks the best in each column:

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 2035 | 2.55 | 0.13 | 0.16 | 0.24 |
| elasticsearch | 1373 | 3.78 | &lt;1 | &lt;1 | &lt;1 |
| narsil-rust | 2327\* | 2.23\* | 0.10 | 0.12 | 0.13 |
| opensearch | 1079 | 4.80 | &lt;1 | &lt;1 | &lt;1 |
| qdrant | 1487 | 3.49 | 0.21 | 0.24 | 0.26 |
| weaviate | 1754 | 2.95 | n/a | n/a | n/a |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 1.05 | 1.22 | 1.37 |
| elasticsearch | 1.84 | 2.01 | 2.14 |
| narsil-rust | 1.00\* | 1.14\* | 1.24\* |
| opensearch | 1.74 | 1.89 | 2.02 |
| qdrant | 1.27 | 1.41 | 1.49 |
| weaviate | 3.07 | 4.05 | 6.24 |

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
| narsil | 3380 | 3377 to 3389 | 4 | 1.32 | 12.34 | 1.63 | no |
| elasticsearch | 2658 | 2626 to 2662 | 16 | 9.33 | 35.55 | 3.14 | yes |
| narsil-rust | 3778\* | 3727 to 3784 | 4 | 1.19 | 1.70 | 1.11 | no |
| opensearch | 2801 | 2801 to 2802 | 16 | 8.86 | 25.40 | 2.92 | yes |
| qdrant | 3115 | 3093 to 3131 | 8 | 3.24 | 4.70 | 2.15 | yes |
| weaviate | 1667 | 1658 to 1671 | 32 | 40.34 | 75.64 | 7.82 | no |

Narsil ties for the best nDCG@10 (6-way tie at 0.6239) and ranks 2/3 on server-side p50 latency (fastest: narsil-rust, 0.10 ms, among engines above the measurement floor).

### beir/nfcorpus/test

Retrieval quality (higher is better). A star marks the best in each column:

| Engine | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| narsil | 0.3149\* | 0.3094 | 0.1576\* | 0.5194\* |
| elasticsearch | 0.3149\* | 0.3094 | 0.1576\* | 0.5194\* |
| narsil-rust | 0.3149\* | 0.3094 | 0.1576\* | 0.5194\* |
| opensearch | 0.3147 | 0.3094 | 0.1575 | 0.5184 |
| qdrant | 0.3147 | 0.3094 | 0.1576\* | 0.5179 |
| weaviate | 0.3148 | 0.3094 | 0.1575 | 0.5184 |

Matched-recall operating point per engine:

| Engine | Knob | Value | ANN recall@k | Target met |
| --- | --- | --- | --- | --- |
| narsil | efSearch | 128 | 0.9929 | yes |
| elasticsearch | num_candidates | 8192 | 0.9845 | NO |
| narsil-rust | efSearch | 128 | 0.9916 | yes |
| opensearch | ef_search | 128 | 0.9947 | yes |
| qdrant | hnsw_ef | 64 | 0.9941 | yes |
| weaviate | ef | 128 | 0.9923 | yes |

Ingest throughput (higher is better) and query latency (lower is better). The headline latency is each engine's own server-side query time; a star marks the best in each column:

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 1628 | 2.23 | 0.17 | 0.20 | 0.25 |
| elasticsearch | 1397 | 2.60 | &lt;1 | &lt;1 | &lt;1 |
| narsil-rust | 1982\* | 1.83\* | 0.14 | 0.16 | 0.17 |
| opensearch | 1172 | 3.10 | &lt;1 | &lt;1 | &lt;1 |
| qdrant | 1366 | 2.66 | 0.24 | 0.31 | 0.33 |
| weaviate | 1428 | 2.54 | n/a | n/a | n/a |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 1.08 | 1.24 | 1.35 |
| elasticsearch | 2.06 | 2.23 | 2.38 |
| narsil-rust | 1.06\* | 1.20\* | 1.29\* |
| opensearch | 1.70 | 1.87 | 1.99 |
| qdrant | 1.31 | 1.46 | 1.58 |
| weaviate | 3.10 | 4.07 | 6.33 |

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
| narsil | 3175 | 3133 to 3210 | 4 | 1.42 | 20.04 | 1.69 | no |
| elasticsearch | 2644† | 2643 to 2649 | 16 | 9.26 | 34.07 | 3.86 | yes |
| narsil-rust | 3552\* | 3516 to 3572 | 4 | 1.29 | 1.84 | 1.22 | no |
| opensearch | 2796 | 2792 to 2804 | 16 | 8.89 | 25.97 | 3.03 | yes |
| qdrant | 3141 | 3065 to 3169 | 8 | 3.23 | 4.69 | 2.39 | yes |
| weaviate | 1627 | 1608 to 1630 | 32 | 42.22 | 75.25 | 7.83 | no |

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
| narsil | efSearch | 16 | 1.0000 | yes |
| elasticsearch | num_candidates | 1536 | 0.9917 | yes |
| narsil-rust | efSearch | 128 | 0.9911 | yes |
| opensearch | ef_search | 160 | 0.9911 | yes |
| qdrant | hnsw_ef | 128 | 0.9946 | yes |
| weaviate | ef | 192 | 0.9929 | yes |

Ingest throughput (higher is better) and query latency (lower is better). The headline latency is each engine's own server-side query time; a star marks the best in each column:

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 852 | 117.39 | 106.55 | 112.81 | 120.28 |
| elasticsearch | 719 | 138.99 | 1.00 | 1.00 | 2.00 |
| narsil-rust | 879\* | 113.73\* | 0.46 | 0.63 | 0.71 |
| opensearch | 683 | 146.33 | &lt;1 | 1.00 | 1.00 |
| qdrant | 830 | 120.44 | 0.51 | 0.66 | 1.18 |
| weaviate | 658 | 151.99 | n/a | n/a | n/a |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 208.71 | 216.34 | 222.43 |
| elasticsearch | 3.69 | 4.17 | 4.40 |
| narsil-rust | 2.30\* | 2.52\* | 2.66\* |
| opensearch | 2.90 | 3.10 | 3.26 |
| qdrant | 2.45 | 2.75 | 3.16 |
| weaviate | 8.53 | 9.97 | 13.22 |

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
| narsil | 8 | 8 to 8 | 2 | 241.07 | 346.39 | 2.33 | no |
| elasticsearch | 1532 | 1524 to 1534 | 16 | 16.06 | 115.09 | 3.85 | yes |
| narsil-rust | 1670 | 1666 to 1673 | 16 | 15.83 | 98.12 | 1.40 | yes |
| opensearch | 1607 | 1601 to 1608 | 16 | 15.58 | 97.50 | 2.34 | yes |
| qdrant | 1772\* | 1733 to 1773 | 8 | 5.70 | 9.47 | 3.15 | yes |
| weaviate | 602 | 601 to 603 | 16 | 47.47 | 82.37 | 7.84 | no |

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
| narsil | efSearch | 256 | 0.9915 | yes |
| elasticsearch | num_candidates | 4096 | 0.9935 | yes |
| narsil-rust | efSearch | 288 | 0.9914 | yes |
| opensearch | ef_search | 768 | 0.9904 | yes |
| qdrant | hnsw_ef | 192 | 0.9922 | yes |
| weaviate | ef | 416 | 0.9925 | yes |

Ingest throughput (higher is better) and query latency (lower is better). The headline latency is each engine's own server-side query time; a star marks the best in each column:

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 569 | 1748.94 | 1.19\* | 1.55\* | 1.68\* |
| elasticsearch | 480 | 2073.62 | 4.00 | 6.00 | 7.00 |
| narsil-rust | 882\* | 1128.44\* | 1.51 | 2.03 | 2.17 |
| opensearch | 477 | 2086.52 | 2.00 | 2.00 | 2.00 |
| qdrant | 813 | 1223.79 | 1.84 | 3.24 | 3.76 |
| weaviate | 664 | 1498.69 | n/a | n/a | n/a |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 3.05\* | 3.45\* | 3.67\* |
| elasticsearch | 6.37 | 8.32 | 9.21 |
| narsil-rust | 3.39 | 3.93 | 4.09 |
| opensearch | 4.31 | 4.75 | 4.90 |
| qdrant | 3.81 | 5.22 | 5.79 |
| weaviate | 10.40 | 11.45 | 12.96 |

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
| narsil | 1649\* | 1646 to 1650 | 16 | 15.87 | 97.32 | 3.34 | yes |
| elasticsearch | 1274 | 1267 to 1275 | 64 | 83.21 | 127.51 | 7.13 | no |
| narsil-rust | 1642 | 1642 to 1645 | 16 | 15.98 | 96.79 | 2.89 | yes |
| opensearch | 1592 | 1581 to 1599 | 32 | 32.81 | 116.33 | 4.55 | yes |
| qdrant | 1579 | 1575 to 1583 | 32 | 33.37 | 112.48 | 5.90 | yes |
| weaviate | 523 | 520 to 527 | 16 | 55.02 | 134.26 | 7.71 | no |

## Hybrid track

### beir/scifact/test

Retrieval quality (higher is better). A star marks the best in each column:

| Engine | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| narsil | 0.7054 | 0.9643\* | 0.6581 | 0.6648 |
| elasticsearch | 0.7071 | 0.9610 | 0.6608 | 0.6676 |
| narsil-rust | 0.7054 | 0.9643\* | 0.6581 | 0.6648 |
| opensearch | 0.7069 | 0.9610 | 0.6608 | 0.6665 |
| qdrant | 0.7128\* | 0.9577 | 0.6705\* | 0.6745\* |
| weaviate | 0.6840 | 0.9577 | 0.6366 | 0.6460 |

Ingest throughput (higher is better) and query latency (lower is better). The headline latency is each engine's own server-side query time; a star marks the best in each column:

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 1782 | 2.91 | 0.25 | 0.32 | 0.36 |
| elasticsearch | 1562 | 3.32 | 1.00 | 1.00 | 1.00 |
| narsil-rust | 2232\* | 2.32\* | 0.17 | 0.22 | 0.25 |
| opensearch | 1140 | 4.55 | 1.00 | 2.00 | 2.00 |
| qdrant | 1645 | 3.15 | 0.36 | 0.41 | 0.43 |
| weaviate | 1756 | 2.95 | n/a | n/a | n/a |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 1.22 | 1.39 | 1.53 |
| elasticsearch | 2.57 | 2.96 | 3.16 |
| narsil-rust | 1.13\* | 1.28\* | 1.44\* |
| opensearch | 2.71 | 3.24 | 3.44 |
| qdrant | 1.51 | 1.64 | 1.73 |
| weaviate | 4.05 | 6.26 | 9.16 |

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
| narsil | 3009 | 2992 to 3011 | 16 | 8.76 | 46.93 | 2.20 | yes |
| elasticsearch | 2580 | 2570 to 2584 | 32 | 19.87 | 45.11 | 6.42 | yes |
| narsil-rust | 3493\* | 3493 to 3541 | 4 | 1.28 | 1.75 | 1.32 | no |
| opensearch | 2684 | 2671 to 2687 | 32 | 18.78 | 35.33 | 6.76 | yes |
| qdrant | 3112 | 3050 to 3135 | 8 | 3.36 | 5.15 | 3.42 | yes |
| weaviate | 792 | 791 to 794 | 64 | 176.04 | 302.00 | 7.90 | no |

Narsil ranks 4/6 on nDCG@10 (best: qdrant, 0.7128) and ranks 2/3 on server-side p50 latency (fastest: narsil-rust, 0.17 ms, among engines above the measurement floor).

### beir/nfcorpus/test

Retrieval quality (higher is better). A star marks the best in each column:

| Engine | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| narsil | 0.3562\* | 0.3238\* | 0.1877\* | 0.5759\* |
| elasticsearch | 0.3516 | 0.3216 | 0.1863 | 0.5623 |
| narsil-rust | 0.3562\* | 0.3238\* | 0.1877\* | 0.5759\* |
| opensearch | 0.3520 | 0.3213 | 0.1867 | 0.5633 |
| qdrant | 0.3508 | 0.3235 | 0.1823 | 0.5691 |
| weaviate | 0.3428 | 0.3195 | 0.1810 | 0.5546 |

Ingest throughput (higher is better) and query latency (lower is better). The headline latency is each engine's own server-side query time; a star marks the best in each column:

| Engine | Ingest docs/s | Build s | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- |
| narsil | 1632 | 2.23 | 0.24 | 0.27 | 0.30 |
| elasticsearch | 1234 | 2.94 | 1.00 | 1.00 | 1.00 |
| narsil-rust | 1974\* | 1.84\* | 0.18 | 0.20 | 0.22 |
| opensearch | 1172 | 3.10 | 1.00 | 1.00 | 1.00 |
| qdrant | 1330 | 2.73 | 0.35 | 0.40 | 0.42 |
| weaviate | 1453 | 2.50 | n/a | n/a | n/a |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 1.19 | 1.33 | 1.41 |
| elasticsearch | 2.44 | 2.64 | 2.78 |
| narsil-rust | 1.11\* | 1.26\* | 1.34\* |
| opensearch | 2.29 | 2.59 | 2.74 |
| qdrant | 1.51 | 1.63 | 1.74 |
| weaviate | 3.88 | 5.84 | 8.17 |

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
| narsil | 3012 | 3012 to 3026 | 16 | 8.67 | 55.88 | 2.13 | yes |
| elasticsearch | 2557 | 2546 to 2595 | 32 | 20.29 | 56.87 | 5.70 | yes |
| narsil-rust | 3407\* | 3379 to 3415 | 4 | 1.33 | 1.90 | 1.31 | no |
| opensearch | 2673 | 2671 to 2677 | 32 | 19.24 | 36.98 | 5.08 | yes |
| qdrant | 3125 | 3088 to 3151 | 8 | 3.31 | 5.04 | 3.24 | yes |
| weaviate | 954 | 954 to 956 | 64 | 149.17 | 276.23 | 7.89 | no |

Narsil ties for the best nDCG@10 (2-way tie at 0.3562) and ranks 2/3 on server-side p50 latency (fastest: narsil-rust, 0.18 ms, among engines above the measurement floor).

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
| narsil | 842 | 118.71 | 106.39 | 112.52 | 120.15 |
| elasticsearch | 718 | 139.20 | 1.00 | 2.00 | 2.00 |
| narsil-rust | 877\* | 114.02\* | 0.53 | 0.70 | 0.81 |
| opensearch | 689 | 145.05 | 1.00 | 1.00 | 1.00 |
| qdrant | 796 | 125.69 | 0.70 | 1.10 | 1.56 |
| weaviate | 655 | 152.59 | n/a | n/a | n/a |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 209.53 | 218.54 | 223.39 |
| elasticsearch | 4.23 | 4.72 | 4.96 |
| narsil-rust | 2.37\* | 2.60\* | 2.75\* |
| opensearch | 3.38 | 3.68 | 3.83 |
| qdrant | 2.86 | 3.28 | 3.77 |
| weaviate | 9.44 | 10.89 | 13.25 |

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
| narsil | 8 | 8 to 8 | 2 | 241.53 | 344.94 | 2.35 | no |
| elasticsearch | 1519 | 1519 to 1528 | 32 | 34.49 | 144.55 | 5.14 | yes |
| narsil-rust | 1663 | 1661 to 1663 | 16 | 15.85 | 97.62 | 1.56 | yes |
| opensearch | 1567 | 1546 to 1567 | 16 | 16.14 | 97.55 | 3.38 | yes |
| qdrant | 1710\* | 1698 to 1770 | 8 | 5.74 | 10.33 | 3.77 | yes |
| weaviate | 466 | 463 to 467 | 16 | 67.88 | 106.82 | 7.92 | no |

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
| narsil | 543 | 1833.22 | 1.84\* | 3.03 | 3.91 |
| elasticsearch | 631 | 1577.82 | 4.00 | 7.00 | 8.00 |
| narsil-rust | 878\* | 1132.66\* | 1.92 | 2.83\* | 3.39\* |
| opensearch | 516 | 1928.88 | 3.00 | 8.00 | 11.00 |
| qdrant | 825 | 1205.40 | 2.52 | 5.07 | 6.31 |
| weaviate | 666 | 1493.20 | n/a | n/a | n/a |

Client round-trip latency for the same queries, timed around the HTTP call:

| Engine | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| narsil | 3.77\* | 4.99 | 5.94 |
| elasticsearch | 7.15 | 9.37 | 10.65 |
| narsil-rust | 3.80 | 4.72\* | 5.30\* |
| opensearch | 5.92 | 10.61 | 13.96 |
| qdrant | 4.70 | 7.28 | 8.51 |
| weaviate | 11.83 | 13.00 | 14.52 |

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
| narsil | 1646 | 1644 to 1647 | 32 | 32.75 | 119.55 | 5.00 | yes |
| elasticsearch | 1068 | 1066 to 1089 | 64 | 95.82 | 128.87 | 7.27 | no |
| narsil-rust | 1656\* | 1651 to 1663 | 32 | 33.15 | 115.69 | 4.30 | yes |
| opensearch | 1559 | 1547 to 1561 | 32 | 32.45 | 115.19 | 6.56 | yes |
| qdrant | 1475 | 1463 to 1481 | 64 | 66.46 | 157.37 | 7.47 | yes |
| weaviate | 370 | 366 to 371 | 16 | 80.91 | 159.28 | 7.94 | no |
