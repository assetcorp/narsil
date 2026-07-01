# Narsil in-process benchmark: Narsil vs Orama vs MiniSearch

Generated 2026-07-01T16:39:09.742Z

## Environment

| Field | Value |
| --- | --- |
| Node | v24.16.0 |
| OS / arch | Darwin arm64 |
| CPU | Apple M3 Pro |
| Total memory | 18GB |

## Engines

| Engine | Version |
| --- | --- |
| narsil | 0.1.7 |
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
| narsil v0.1.7 | 19,187 | 18,558 | 16,347 |
| orama v3.1.18 | 9,299 | 8,749 | 7,793 |
| minisearch v7.2.0 | 14,909 | 13,003 | 10,840 |

### Search latency p50 ms (p95)

| Engine | 1,000 docs | 10,000 docs | 50,000 docs |
| --- | ---: | ---: | ---: |
| narsil v0.1.7 | 0.035 (0.158) | 0.249 (0.760) | 1.142 (4.899) |
| orama v3.1.18 | 0.031 (0.260) | 0.493 (3.168) | 4.628 (112.838) |
| minisearch v7.2.0 | 0.044 (0.276) | 0.380 (2.165) | 2.877 (16.999) |

### Memory (MB)

| Engine | 1,000 docs | 10,000 docs | 50,000 docs |
| --- | ---: | ---: | ---: |
| narsil v0.1.7 | 10.0 | 51.6 | 192.0 |
| orama v3.1.18 | 11.4 | 87.3 | 398.2 |
| minisearch v7.2.0 | 6.7 | 41.6 | 175.1 |

## Full schema (text + numeric + enum)

### Insert throughput (docs/sec)

| Engine | 1,000 docs | 10,000 docs | 50,000 docs |
| --- | ---: | ---: | ---: |
| narsil v0.1.7 | 19,569 | 17,506 | 16,107 |
| orama v3.1.18 | 9,329 | 8,641 | 7,709 |
| minisearch v7.2.0 | 15,051 | 12,983 | 11,493 |

### Search latency p50 ms (p95)

| Engine | 1,000 docs | 10,000 docs | 50,000 docs |
| --- | ---: | ---: | ---: |
| narsil v0.1.7 | 0.037 (0.161) | 0.247 (0.751) | 1.156 (5.057) |
| orama v3.1.18 | 0.033 (0.271) | 0.477 (3.225) | 4.757 (67.923) |
| minisearch v7.2.0 | 0.045 (0.266) | 0.369 (2.149) | 2.662 (15.538) |

### Memory (MB)

| Engine | 1,000 docs | 10,000 docs | 50,000 docs |
| --- | ---: | ---: | ---: |
| narsil v0.1.7 | 10.1 | 52.0 | 193.6 |
| orama v3.1.18 | 11.5 | 88.3 | 402.5 |
| minisearch v7.2.0 | 6.7 | 41.6 | 175.0 |

### Filtered search latency p50 ms (p95)

| Engine | 1,000 docs | 10,000 docs | 50,000 docs |
| --- | ---: | ---: | ---: |
| narsil v0.1.7 | 0.013 (0.031) | 0.040 (0.100) | 0.221 (0.628) |
| orama v3.1.18 | 0.027 (0.076) | 0.269 (1.295) | 2.421 (25.052) |
| minisearch v7.2.0 | not supported | not supported | not supported |

## Vector search (Narsil vs Orama)

### Recall@10 vs exact KNN

| Engine | scifact | nfcorpus |
| --- | ---: | ---: |
| narsil v0.1.7 | 100.0% | 100.0% |
| orama v3.1.18 | 100.0% | 100.0% |

### Insert throughput (docs/sec)

| Engine | scifact | nfcorpus |
| --- | ---: | ---: |
| narsil v0.1.7 | 251,191 | 262,763 |
| orama v3.1.18 | 455,110 | 442,619 |

### Search latency p50 ms (p95 / p99)

| Engine | scifact | nfcorpus |
| --- | ---: | ---: |
| narsil v0.1.7 | 1.365 (1.433 / 1.507) | 0.975 (1.016 / 1.114) |
| orama v3.1.18 | 2.317 (2.411 / 2.537) | 1.597 (1.676 / 1.799) |

### Memory (MB)

| Engine | scifact | nfcorpus |
| --- | ---: | ---: |
| narsil v0.1.7 | 8.0 | 27.3 |
| orama v3.1.18 | 2.9 | 1.9 |

## Serialization (each engine on its shipped format)

| Engine | Serialize (ms) | Size (MB) | Deserialize+Search (ms) |
| --- | ---: | ---: | ---: |
| narsil v0.1.7 | 891.7 | 172.5 | 1508.5 |
| orama v3.1.18 | 905.9 | 193.8 | 1762.0 |
| minisearch v7.2.0 | 963.1 | 73.2 | 640.5 |

## Mutation

| Engine | Remove (docs/sec) | Search after remove (ms) | Reinsert (docs/sec) |
| --- | ---: | ---: | ---: |
| narsil v0.1.7 | 7,439 | 1.259 | 13,753 |
| orama v3.1.18 | 9,617 | 4.856 | 7,514 |
| minisearch v7.2.0 | 1,126 | 2.490 | 10,808 |

## Relevance quality (BEIR scifact, 5,183 docs, human judgments)

| Engine | nDCG@10 | P@10 | MAP | MRR | Queries |
| --- | ---: | ---: | ---: | ---: | ---: |
| narsil v0.1.7 | 0.6863 | 0.0913 | 0.6357 | 0.6479 | 300 |
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
