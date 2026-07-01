# Narsil in-process benchmark: Narsil vs Orama vs MiniSearch

Generated 2026-07-01T22:49:51.956Z

## Environment

| Field | Value |
| --- | --- |
| Node | v24.18.0 |
| OS / arch | Linux x64 |
| CPU | Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz |
| Total memory | 31GB |

## Engines

| Engine | Version |
| --- | --- |
| narsil | 0.1.8 |
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
| narsil v0.1.8 | 9,735 | 8,671 | 7,953 |
| orama v3.1.18 | 4,136 | 3,911 | 3,606 |
| minisearch v7.2.0 | 7,725 | 6,504 | 5,881 |

### Search latency p50 ms (p95)

| Engine | 1,000 docs | 10,000 docs | 50,000 docs |
| --- | ---: | ---: | ---: |
| narsil v0.1.8 | 0.070 (0.290) | 0.522 (1.649) | 2.778 (12.333) |
| orama v3.1.18 | 0.071 (0.676) | 1.385 (10.916) | 16.537 (385.658) |
| minisearch v7.2.0 | 0.070 (0.414) | 0.604 (3.409) | 5.551 (32.100) |

### Memory (MB)

| Engine | 1,000 docs | 10,000 docs | 50,000 docs |
| --- | ---: | ---: | ---: |
| narsil v0.1.8 | 10.1 | 51.6 | 191.9 |
| orama v3.1.18 | 11.4 | 87.3 | 398.2 |
| minisearch v7.2.0 | 6.7 | 41.6 | 175.1 |

## Full schema (text + numeric + enum)

### Insert throughput (docs/sec)

| Engine | 1,000 docs | 10,000 docs | 50,000 docs |
| --- | ---: | ---: | ---: |
| narsil v0.1.8 | 9,393 | 8,516 | 7,719 |
| orama v3.1.18 | 4,110 | 3,857 | 3,460 |
| minisearch v7.2.0 | 7,797 | 6,539 | 5,913 |

### Search latency p50 ms (p95)

| Engine | 1,000 docs | 10,000 docs | 50,000 docs |
| --- | ---: | ---: | ---: |
| narsil v0.1.8 | 0.075 (0.301) | 0.541 (1.643) | 3.343 (14.849) |
| orama v3.1.18 | 0.072 (0.690) | 1.423 (10.920) | 17.131 (382.245) |
| minisearch v7.2.0 | 0.077 (0.461) | 0.608 (3.161) | 4.885 (29.523) |

### Memory (MB)

| Engine | 1,000 docs | 10,000 docs | 50,000 docs |
| --- | ---: | ---: | ---: |
| narsil v0.1.8 | 10.1 | 51.9 | 193.7 |
| orama v3.1.18 | 11.5 | 88.3 | 402.5 |
| minisearch v7.2.0 | 6.7 | 41.6 | 175.1 |

### Filtered search latency p50 ms (p95)

| Engine | 1,000 docs | 10,000 docs | 50,000 docs |
| --- | ---: | ---: | ---: |
| narsil v0.1.8 | 0.025 (0.056) | 0.103 (0.211) | 0.569 (1.436) |
| orama v3.1.18 | 0.057 (0.225) | 0.912 (5.550) | 7.991 (160.676) |
| minisearch v7.2.0 | not supported | not supported | not supported |

## Vector search (Narsil vs Orama)

### Recall@10 vs exact KNN

| Engine | scifact | nfcorpus |
| --- | ---: | ---: |
| narsil v0.1.8 | 100.0% | 100.0% |
| orama v3.1.18 | 100.0% | 100.0% |

### Insert throughput (docs/sec)

| Engine | scifact | nfcorpus |
| --- | ---: | ---: |
| narsil v0.1.8 | 121,370 | 124,620 |
| orama v3.1.18 | 168,806 | 162,369 |

### Search latency p50 ms (p95 / p99)

| Engine | scifact | nfcorpus |
| --- | ---: | ---: |
| narsil v0.1.8 | 2.086 (2.150 / 2.569) | 1.507 (1.553 / 2.041) |
| orama v3.1.18 | 3.722 (3.863 / 4.229) | 2.581 (2.698 / 2.887) |

### Memory (MB)

| Engine | scifact | nfcorpus |
| --- | ---: | ---: |
| narsil v0.1.8 | 8.0 | 29.6 |
| orama v3.1.18 | 2.9 | 1.9 |

## Serialization (each engine on its shipped format)

| Engine | Serialize (ms) | Size (MB) | Deserialize+Search (ms) |
| --- | ---: | ---: | ---: |
| narsil v0.1.8 | 1889.3 | 172.5 | 2971.6 |
| orama v3.1.18 | 2049.8 | 193.8 | 3198.8 |
| minisearch v7.2.0 | 2084.1 | 73.2 | 1556.5 |

## Mutation

| Engine | Remove (docs/sec) | Search after remove (ms) | Reinsert (docs/sec) |
| --- | ---: | ---: | ---: |
| narsil v0.1.8 | 5,409 | 2.956 | 7,331 |
| orama v3.1.18 | 4,916 | 18.087 | 3,524 |
| minisearch v7.2.0 | 1,162 | 4.277 | 5,159 |

## Relevance quality (BEIR scifact, 5,183 docs, human judgments)

| Engine | nDCG@10 | P@10 | MAP | MRR | Queries |
| --- | ---: | ---: | ---: | ---: | ---: |
| narsil v0.1.8 | 0.6863 | 0.0913 | 0.6357 | 0.6479 | 300 |
| orama v3.1.18 | 0.4351 | 0.0657 | 0.3747 | 0.3845 | 300 |
| minisearch v7.2.0 | 0.2506 | 0.0373 | 0.2163 | 0.2198 | 300 |

## Cross-engine consistency

Corpus: BEIR scifact, 300 judged queries.

| Engine | Mean hits/query |
| --- | ---: |
| narsil | 2799.8 |
| orama | 3065.8 |
| minisearch | 2798.1 |

Mean pairwise top-10 overlap (Jaccard): 0.125

No zero-hit divergences: every engine returned matches for every query another engine matched.
