# Narsil in-process benchmark: Narsil vs Orama vs MiniSearch

Generated 2026-11-17T07:33:35.613Z

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
| narsil | 0.4.3 |
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
| narsil v0.4.3 | 11,941 | 13,323 | 12,493 |
| orama v3.1.18 | 4,287 | 3,941 | 3,588 |
| minisearch v7.2.0 | 7,878 | 6,648 | 5,931 |

### Search latency p50 ms (p95)

| Engine | 1,000 docs | 10,000 docs | 50,000 docs |
| --- | ---: | ---: | ---: |
| narsil v0.4.3 | 0.043 (0.084) | 0.075 (0.178) | 0.127 (0.473) |
| orama v3.1.18 | 0.075 (0.688) | 1.413 (10.292) | 16.834 (383.415) |
| minisearch v7.2.0 | 0.069 (0.404) | 0.594 (3.314) | 5.159 (31.372) |

### Heap plus external memory (MB)

| Engine | 1,000 docs | 10,000 docs | 50,000 docs |
| --- | ---: | ---: | ---: |
| narsil v0.4.3 | 1.1 | 6.6 | 23.1 |
| orama v3.1.18 | 11.4 | 87.3 | 398.2 |
| minisearch v7.2.0 | 6.7 | 41.6 | 175.1 |

## Full schema (text + numeric + enum)

### Insert throughput (docs/sec)

| Engine | 1,000 docs | 10,000 docs | 50,000 docs |
| --- | ---: | ---: | ---: |
| narsil v0.4.3 | 11,712 | 13,127 | 12,339 |
| orama v3.1.18 | 4,241 | 3,819 | 3,539 |
| minisearch v7.2.0 | 7,816 | 6,629 | 5,939 |

### Search latency p50 ms (p95)

| Engine | 1,000 docs | 10,000 docs | 50,000 docs |
| --- | ---: | ---: | ---: |
| narsil v0.4.3 | 0.043 (0.085) | 0.059 (0.130) | 0.127 (0.471) |
| orama v3.1.18 | 0.071 (0.532) | 1.424 (10.390) | 16.806 (385.058) |
| minisearch v7.2.0 | 0.069 (0.402) | 0.592 (3.152) | 5.100 (31.871) |

### Heap plus external memory (MB)

| Engine | 1,000 docs | 10,000 docs | 50,000 docs |
| --- | ---: | ---: | ---: |
| narsil v0.4.3 | 1.1 | 6.6 | 22.9 |
| orama v3.1.18 | 11.5 | 88.3 | 402.5 |
| minisearch v7.2.0 | 6.7 | 41.6 | 175.1 |

### Filtered search latency p50 ms (p95)

| Engine | 1,000 docs | 10,000 docs | 50,000 docs |
| --- | ---: | ---: | ---: |
| narsil v0.4.3 | 0.048 (0.084) | 0.082 (0.175) | 0.156 (0.307) |
| orama v3.1.18 | 0.057 (0.226) | 0.920 (5.599) | 7.955 (161.171) |
| minisearch v7.2.0 | not supported | not supported | not supported |

## Vector search (Narsil vs Orama)

### Recall@10 vs exact KNN

| Engine | scifact | nfcorpus |
| --- | ---: | ---: |
| narsil v0.4.3 | 100.0% | 100.0% |
| orama v3.1.18 | 100.0% | 100.0% |

### Insert throughput (docs/sec)

| Engine | scifact | nfcorpus |
| --- | ---: | ---: |
| narsil v0.4.3 | 51,912 | 47,345 |
| orama v3.1.18 | 184,469 | 187,576 |

### Search latency p50 ms (p95 / p99)

| Engine | scifact | nfcorpus |
| --- | ---: | ---: |
| narsil v0.4.3 | 1.079 (1.404 / 39.827) | 0.794 (0.920 / 34.103) |
| orama v3.1.18 | 3.751 (3.987 / 4.278) | 2.578 (2.694 / 2.798) |

### Heap plus external memory (MB)

| Engine | scifact | nfcorpus |
| --- | ---: | ---: |
| narsil v0.4.3 | 32.3 | 32.0 |
| orama v3.1.18 | 10.5 | 7.2 |

## Serialization (each engine on its shipped format)

| Engine | Serialize (ms) | Size (MB) | Deserialize+Search (ms) |
| --- | ---: | ---: | ---: |
| narsil v0.4.3 | 1387.8 | 70.1 | 510.9 |
| orama v3.1.18 | 2093.7 | 193.8 | 3412.7 |
| minisearch v7.2.0 | 2139.4 | 73.2 | 1554.7 |

## Mutation

| Engine | Remove (docs/sec) | Search after remove (ms) | Reinsert (docs/sec) |
| --- | ---: | ---: | ---: |
| narsil v0.4.3 | 7,838 | 0.193 | 8,988 |
| orama v3.1.18 | 4,786 | 18.574 | 3,507 |
| minisearch v7.2.0 | 1,151 | 4.587 | 5,751 |

## Relevance quality (BEIR scifact, 5,183 docs, human judgments)

| Engine | nDCG@10 | P@10 | MAP | MRR | Queries |
| --- | ---: | ---: | ---: | ---: | ---: |
| narsil v0.4.3 | 0.6840 | 0.0903 | 0.6355 | 0.6476 | 300 |
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
