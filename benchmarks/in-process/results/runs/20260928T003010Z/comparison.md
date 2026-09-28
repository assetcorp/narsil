# Narsil in-process benchmark: Narsil vs Orama vs MiniSearch

Generated 2026-09-28T00:30:10.996Z

## Environment

| Field | Value |
| --- | --- |
| Node | v24.21.0 |
| OS / arch | Linux x64 |
| CPU | Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz |
| Total memory | 31GB |

## Engines

| Engine | Version |
| --- | --- |
| narsil | 0.3.0 |
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
| narsil v0.3.0 | 9,220 | 8,819 | 7,944 |
| orama v3.1.18 | 4,322 | 4,092 | 3,659 |
| minisearch v7.2.0 | 7,962 | 6,950 | 6,221 |

### Search latency p50 ms (p95)

| Engine | 1,000 docs | 10,000 docs | 50,000 docs |
| --- | ---: | ---: | ---: |
| narsil v0.3.0 | 0.048 (0.077) | 0.075 (0.160) | 0.125 (0.479) |
| orama v3.1.18 | 0.067 (0.642) | 1.360 (10.013) | 16.376 (383.778) |
| minisearch v7.2.0 | 0.071 (0.444) | 0.595 (3.216) | 4.334 (27.790) |

### Heap plus external memory (MB)

| Engine | 1,000 docs | 10,000 docs | 50,000 docs |
| --- | ---: | ---: | ---: |
| narsil v0.3.0 | 11.3 | 57.5 | 214.7 |
| orama v3.1.18 | 11.5 | 87.3 | 398.2 |
| minisearch v7.2.0 | 6.7 | 41.6 | 175.1 |

## Full schema (text + numeric + enum)

### Insert throughput (docs/sec)

| Engine | 1,000 docs | 10,000 docs | 50,000 docs |
| --- | ---: | ---: | ---: |
| narsil v0.3.0 | 9,124 | 8,609 | 7,864 |
| orama v3.1.18 | 4,287 | 4,016 | 3,653 |
| minisearch v7.2.0 | 7,953 | 6,910 | 6,175 |

### Search latency p50 ms (p95)

| Engine | 1,000 docs | 10,000 docs | 50,000 docs |
| --- | ---: | ---: | ---: |
| narsil v0.3.0 | 0.050 (0.080) | 0.065 (0.130) | 0.142 (0.512) |
| orama v3.1.18 | 0.064 (0.639) | 1.357 (10.078) | 15.712 (383.539) |
| minisearch v7.2.0 | 0.077 (0.480) | 0.592 (3.300) | 4.307 (26.581) |

### Heap plus external memory (MB)

| Engine | 1,000 docs | 10,000 docs | 50,000 docs |
| --- | ---: | ---: | ---: |
| narsil v0.3.0 | 11.4 | 57.9 | 216.4 |
| orama v3.1.18 | 11.5 | 88.3 | 402.5 |
| minisearch v7.2.0 | 6.7 | 41.6 | 175.0 |

### Filtered search latency p50 ms (p95)

| Engine | 1,000 docs | 10,000 docs | 50,000 docs |
| --- | ---: | ---: | ---: |
| narsil v0.3.0 | 0.040 (0.079) | 0.114 (0.167) | 0.447 (0.686) |
| orama v3.1.18 | 0.056 (0.223) | 0.906 (5.503) | 7.913 (160.245) |
| minisearch v7.2.0 | not supported | not supported | not supported |

## Vector search (Narsil vs Orama)

### Recall@10 vs exact KNN

| Engine | scifact | nfcorpus |
| --- | ---: | ---: |
| narsil v0.3.0 | 100.0% | 100.0% |
| orama v3.1.18 | 100.0% | 100.0% |

### Insert throughput (docs/sec)

| Engine | scifact | nfcorpus |
| --- | ---: | ---: |
| narsil v0.3.0 | 83,523 | 69,790 |
| orama v3.1.18 | 164,002 | 164,601 |

### Search latency p50 ms (p95 / p99)

| Engine | scifact | nfcorpus |
| --- | ---: | ---: |
| narsil v0.3.0 | 1.567 (1.957 / 7.856) | 1.099 (1.157 / 1.700) |
| orama v3.1.18 | 3.727 (3.869 / 4.265) | 2.586 (2.712 / 2.819) |

### Heap plus external memory (MB)

| Engine | scifact | nfcorpus |
| --- | ---: | ---: |
| narsil v0.3.0 | 37.9 | 38.5 |
| orama v3.1.18 | 10.5 | 7.2 |

## Serialization (each engine on its shipped format)

| Engine | Serialize (ms) | Size (MB) | Deserialize+Search (ms) |
| --- | ---: | ---: | ---: |
| narsil v0.3.0 | 2132.8 | 173.1 | 3277.6 |
| orama v3.1.18 | 2059.1 | 193.8 | 3232.6 |
| minisearch v7.2.0 | 2095.8 | 73.2 | 1439.3 |

## Mutation

| Engine | Remove (docs/sec) | Search after remove (ms) | Reinsert (docs/sec) |
| --- | ---: | ---: | ---: |
| narsil v0.3.0 | 4,379 | 0.279 | 7,170 |
| orama v3.1.18 | 4,961 | 16.934 | 3,617 |
| minisearch v7.2.0 | 1,162 | 4.177 | 5,391 |

## Relevance quality (BEIR scifact, 5,183 docs, human judgments)

| Engine | nDCG@10 | P@10 | MAP | MRR | Queries |
| --- | ---: | ---: | ---: | ---: | ---: |
| narsil v0.3.0 | 0.6840 | 0.0903 | 0.6355 | 0.6476 | 300 |
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
