# Narsil in-process benchmark: Narsil vs Orama vs MiniSearch

Generated 2026-08-04T18:02:08.484Z

## Environment

| Field | Value |
| --- | --- |
| Node | v24.19.0 |
| OS / arch | Linux x64 |
| CPU | Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz |
| Total memory | 31GB |

## Engines

| Engine | Version |
| --- | --- |
| narsil | 0.2.2 |
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
| narsil v0.2.2 | 10,271 | 9,899 | 8,903 |
| orama v3.1.18 | 4,273 | 3,969 | 3,611 |
| minisearch v7.2.0 | 7,886 | 6,729 | 6,063 |

### Search latency p50 ms (p95)

| Engine | 1,000 docs | 10,000 docs | 50,000 docs |
| --- | ---: | ---: | ---: |
| narsil v0.2.2 | 0.067 (0.302) | 0.497 (1.599) | 2.522 (11.149) |
| orama v3.1.18 | 0.066 (0.655) | 1.391 (10.261) | 16.622 (382.361) |
| minisearch v7.2.0 | 0.070 (0.418) | 0.603 (3.453) | 5.486 (32.503) |

### Memory (MB)

| Engine | 1,000 docs | 10,000 docs | 50,000 docs |
| --- | ---: | ---: | ---: |
| narsil v0.2.2 | 10.0 | 50.6 | 191.3 |
| orama v3.1.18 | 11.4 | 87.3 | 398.2 |
| minisearch v7.2.0 | 6.7 | 41.6 | 175.1 |

## Full schema (text + numeric + enum)

### Insert throughput (docs/sec)

| Engine | 1,000 docs | 10,000 docs | 50,000 docs |
| --- | ---: | ---: | ---: |
| narsil v0.2.2 | 10,003 | 8,718 | 8,319 |
| orama v3.1.18 | 4,124 | 3,702 | 3,530 |
| minisearch v7.2.0 | 7,734 | 6,305 | 6,011 |

### Search latency p50 ms (p95)

| Engine | 1,000 docs | 10,000 docs | 50,000 docs |
| --- | ---: | ---: | ---: |
| narsil v0.2.2 | 0.073 (0.301) | 0.538 (1.627) | 3.029 (13.695) |
| orama v3.1.18 | 0.071 (0.662) | 1.473 (10.503) | 16.753 (387.795) |
| minisearch v7.2.0 | 0.070 (0.431) | 0.624 (3.471) | 4.435 (29.148) |

### Memory (MB)

| Engine | 1,000 docs | 10,000 docs | 50,000 docs |
| --- | ---: | ---: | ---: |
| narsil v0.2.2 | 10.0 | 51.0 | 192.9 |
| orama v3.1.18 | 11.5 | 88.3 | 402.5 |
| minisearch v7.2.0 | 6.7 | 41.6 | 175.1 |

### Filtered search latency p50 ms (p95)

| Engine | 1,000 docs | 10,000 docs | 50,000 docs |
| --- | ---: | ---: | ---: |
| narsil v0.2.2 | 0.025 (0.060) | 0.111 (0.224) | 0.556 (1.342) |
| orama v3.1.18 | 0.057 (0.226) | 0.930 (5.644) | 8.010 (162.378) |
| minisearch v7.2.0 | not supported | not supported | not supported |

## Vector search (Narsil vs Orama)

### Recall@10 vs exact KNN

| Engine | scifact | nfcorpus |
| --- | ---: | ---: |
| narsil v0.2.2 | 100.0% | 100.0% |
| orama v3.1.18 | 100.0% | 100.0% |

### Insert throughput (docs/sec)

| Engine | scifact | nfcorpus |
| --- | ---: | ---: |
| narsil v0.2.2 | 113,843 | 128,931 |
| orama v3.1.18 | 165,533 | 200,559 |

### Search latency p50 ms (p95 / p99)

| Engine | scifact | nfcorpus |
| --- | ---: | ---: |
| narsil v0.2.2 | 2.074 (2.229 / 2.619) | 1.471 (1.512 / 1.984) |
| orama v3.1.18 | 3.728 (3.864 / 4.293) | 2.581 (2.698 / 2.822) |

### Memory (MB)

| Engine | scifact | nfcorpus |
| --- | ---: | ---: |
| narsil v0.2.2 | 8.0 | 29.4 |
| orama v3.1.18 | 2.9 | 1.9 |

## Serialization (each engine on its shipped format)

| Engine | Serialize (ms) | Size (MB) | Deserialize+Search (ms) |
| --- | ---: | ---: | ---: |
| narsil v0.2.2 | 1827.7 | 172.4 | 2981.5 |
| orama v3.1.18 | 2093.8 | 193.8 | 3358.4 |
| minisearch v7.2.0 | 2100.8 | 73.2 | 1533.1 |

## Mutation

| Engine | Remove (docs/sec) | Search after remove (ms) | Reinsert (docs/sec) |
| --- | ---: | ---: | ---: |
| narsil v0.2.2 | 5,071 | 2.832 | 7,755 |
| orama v3.1.18 | 4,857 | 17.913 | 3,537 |
| minisearch v7.2.0 | 1,168 | 4.262 | 5,936 |

## Relevance quality (BEIR scifact, 5,183 docs, human judgments)

| Engine | nDCG@10 | P@10 | MAP | MRR | Queries |
| --- | ---: | ---: | ---: | ---: | ---: |
| narsil v0.2.2 | 0.6840 | 0.0903 | 0.6355 | 0.6476 | 300 |
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
