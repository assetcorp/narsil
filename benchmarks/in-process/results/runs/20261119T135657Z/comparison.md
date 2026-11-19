# Narsil in-process benchmark: Narsil vs Orama vs MiniSearch

Generated 2026-11-19T13:56:57.943Z

## Environment

| Field | Value |
| --- | --- |
| Node | v24.22.3 |
| OS / arch | Linux x64 |
| CPU | Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz |
| Total memory | 31GB |

## Engines

| Engine | Version |
| --- | --- |
| narsil | 0.4.5 |
| orama | 3.1.18 |
| minisearch | 7.2.0 |

## Methodology

| Setting | Value |
| --- | --- |
| Data source | BEIR fiqa (50,000 docs) |
| Scales | 1,000, 10,000, 50,000 |
| Seed | 42 |
| Insert iterations | 5 |
| Search warmup / repeat rounds | 2 / 5 |
| Search queries | 100 |
| Vector model | Xenova/all-MiniLM-L6-v2 (384d) |

## Relevance dataset identity

| Field | Value |
| --- | --- |
| Dataset | scifact |
| Documents | 5,183 |
| Queries | 300 |
| Archive SHA-256 | 536e14446a0ba56ed1398ab1055f39fe852686ecad24a6306c80c490fa8e0165 |
| Corpus fingerprint | 7eef964b1e3042197cafe04e912a8065b91bab2dd3e591cb277dcd369d6fa381 |

## Text-only search

### Insert throughput (docs/sec)

| Engine | 1,000 docs | 10,000 docs | 50,000 docs |
| --- | ---: | ---: | ---: |
| narsil v0.4.5 | 12,172 | 13,584 | 13,026 |
| orama v3.1.18 | 4,290 | 4,001 | 3,720 |
| minisearch v7.2.0 | 8,042 | 6,840 | 6,101 |

### Search latency p50 ms (p95)

| Engine | 1,000 docs | 10,000 docs | 50,000 docs |
| --- | ---: | ---: | ---: |
| narsil v0.4.5 | 0.049 (0.112) | 0.055 (0.128) | 0.129 (0.468) |
| orama v3.1.18 | 0.066 (0.580) | 1.361 (10.160) | 15.969 (384.472) |
| minisearch v7.2.0 | 0.079 (0.511) | 0.605 (3.383) | 4.457 (28.965) |

### Heap plus external memory (MB)

| Engine | 1,000 docs | 10,000 docs | 50,000 docs |
| --- | ---: | ---: | ---: |
| narsil v0.4.5 | 1.1 | 6.6 | 23.1 |
| orama v3.1.18 | 11.4 | 87.3 | 398.2 |
| minisearch v7.2.0 | 6.7 | 41.6 | 175.0 |

## Full schema (text + numeric + enum)

### Insert throughput (docs/sec)

| Engine | 1,000 docs | 10,000 docs | 50,000 docs |
| --- | ---: | ---: | ---: |
| narsil v0.4.5 | 11,149 | 13,236 | 12,769 |
| orama v3.1.18 | 4,253 | 4,042 | 3,631 |
| minisearch v7.2.0 | 7,978 | 6,841 | 6,108 |

### Search latency p50 ms (p95)

| Engine | 1,000 docs | 10,000 docs | 50,000 docs |
| --- | ---: | ---: | ---: |
| narsil v0.4.5 | 0.050 (0.123) | 0.059 (0.132) | 0.116 (0.453) |
| orama v3.1.18 | 0.066 (0.641) | 1.321 (10.764) | 15.977 (384.341) |
| minisearch v7.2.0 | 0.069 (0.418) | 0.595 (3.134) | 4.438 (34.411) |

### Heap plus external memory (MB)

| Engine | 1,000 docs | 10,000 docs | 50,000 docs |
| --- | ---: | ---: | ---: |
| narsil v0.4.5 | 1.1 | 6.5 | 22.9 |
| orama v3.1.18 | 11.5 | 88.3 | 402.5 |
| minisearch v7.2.0 | 6.7 | 41.6 | 175.1 |

### Filtered search latency p50 ms (p95)

| Engine | 1,000 docs | 10,000 docs | 50,000 docs |
| --- | ---: | ---: | ---: |
| narsil v0.4.5 | 0.052 (0.125) | 0.075 (0.122) | 0.150 (0.304) |
| orama v3.1.18 | 0.057 (0.225) | 0.906 (5.537) | 8.024 (161.452) |
| minisearch v7.2.0 | not supported | not supported | not supported |

## Vector search (Narsil vs Orama)

### Recall@10 vs exact KNN

| Engine | scifact | nfcorpus |
| --- | ---: | ---: |
| narsil v0.4.5 | 100.0% | 100.0% |
| orama v3.1.18 | 100.0% | 100.0% |

### Insert throughput (docs/sec)

| Engine | scifact | nfcorpus |
| --- | ---: | ---: |
| narsil v0.4.5 | 50,499 | 44,863 |
| orama v3.1.18 | 189,085 | 191,692 |

### Search latency p50 ms (p95 / p99)

| Engine | scifact | nfcorpus |
| --- | ---: | ---: |
| narsil v0.4.5 | 1.057 (1.128 / 39.116) | 0.807 (0.856 / 33.459) |
| orama v3.1.18 | 3.735 (3.877 / 4.283) | 2.584 (2.697 / 2.871) |

### Heap plus external memory (MB)

| Engine | scifact | nfcorpus |
| --- | ---: | ---: |
| narsil v0.4.5 | 34.1 | 32.4 |
| orama v3.1.18 | 10.5 | 7.2 |

## Serialization (each engine on its shipped format)

| Engine | Serialize (ms) | Size (MB) | Deserialize+Search (ms) |
| --- | ---: | ---: | ---: |
| narsil v0.4.5 | 1335.4 | 70.1 | 532.2 |
| orama v3.1.18 | 2080.6 | 193.8 | 3389.3 |
| minisearch v7.2.0 | 2126.7 | 73.2 | 1527.9 |

## Mutation

| Engine | Remove (docs/sec) | Search after remove (ms) | Reinsert (docs/sec) |
| --- | ---: | ---: | ---: |
| narsil v0.4.5 | 7,929 | 0.191 | 9,723 |
| orama v3.1.18 | 4,759 | 17.237 | 3,643 |
| minisearch v7.2.0 | 1,155 | 4.290 | 5,732 |

## Relevance quality (BEIR scifact, 5,183 docs, human judgments)

| Engine | nDCG@10 | P@10 | MAP | MRR | Queries |
| --- | ---: | ---: | ---: | ---: | ---: |
| narsil v0.4.5 | 0.6840 | 0.0903 | 0.6355 | 0.6476 | 300 |
| orama v3.1.18 | 0.4351 | 0.0657 | 0.3747 | 0.3845 | 300 |
| minisearch v7.2.0 | 0.2506 | 0.0373 | 0.2163 | 0.2198 | 300 |

## Cross-engine consistency

Corpus: BEIR scifact, 300 judged queries.

| Engine | Mean hits/query |
| --- | ---: |
| narsil | 2806.7 |
| orama | 3065.8 |
| minisearch | 2798.1 |

Mean pairwise top-10 overlap (Jaccard): 0.125

No zero-hit divergences: every engine returned matches for every query another engine matched.
