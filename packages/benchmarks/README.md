# Narsil Comparative Benchmarks

Side-by-side benchmarks comparing Narsil against other JavaScript search engines on the same Wikipedia dataset, same process, same machine.

## Engines tested

- [Narsil](https://github.com/assetcorp/narsil) - Distributed full-text and vector search engine
- [Orama](https://github.com/assetcorp/orama) v3.1.18 - Full-text and vector search engine
- [MiniSearch](https://github.com/lucaong/minisearch) v7.2.0 - In-memory full-text search

## Quick start

From the repository root:

```bash
pnpm run build

pnpm --filter benchmarks bench
```

Run a single tier:

```bash
pnpm --filter benchmarks bench -- --tiers text
pnpm --filter benchmarks bench -- --tiers full
pnpm --filter benchmarks bench -- --tiers vector
pnpm --filter benchmarks bench -- --tiers serial
pnpm --filter benchmarks bench -- --tiers mutation
pnpm --filter benchmarks bench -- --tiers quality
```

Results are printed to stdout and saved to `results.json`.

## Dataset

All benchmarks use [English Wikipedia](https://en.wikipedia.org) articles. The dataset is downloaded on first run and cached locally. Articles are processed into a standard format with `title`, `body`, `score` (derived from article length), and `category` (hashed from title) fields.

Scales: 1,000 / 10,000 / 50,000 / 100,000 documents.

## Tiers

### Tier 1: Text-Only Search

Indexes `title` (string) and `body` (string) fields. Measures insert throughput, search latency, and memory at each scale.

### Tier 2: Full Schema (with filters)

Adds `score` (number) and `category` (enum) fields to the text schema. Measures the same metrics as Tier 1 plus filtered search latency (text search combined with field filters).

### Tier 3: Vector Search

Indexes synthetic 1536-dim and 3072-dim embeddings. Measures vector insert throughput, vector search latency (top-10), and memory. Orama is the only competitor with vector support; MiniSearch is excluded.

### Tier 4: Serialization

Measures serialize time, serialized size, and deserialize+search time at 100,000 documents.

### Tier 5: Mutations

Measures update and remove throughput at 100,000 documents.

### Tier 6: Search Quality (Cranfield)

Ranking accuracy against the [Cranfield Collection](https://ir-datasets.com/cranfield.html) with 1,400 documents and 225 queries with exhaustive human relevance judgments. Measures nDCG@10, P@10, MAP, and MRR. See the [quality methodology](#search-quality-methodology) section below for details.

## Latest results (Apple M3 Pro, 18GB, Node.js v22)

### Insert throughput (docs/sec, Wikipedia data)

| Engine | 1K | 10K | 50K | 100K |
| --- | ---: | ---: | ---: | ---: |
| **Narsil** | **7,246** | **7,546** | **8,450** | **7,375** |
| Orama 3.1.18 | 4,261 | 1,858 | 4,477 | 3,801 |
| MiniSearch 7.2.0 | 5,399 | 4,698 | 5,059 | 4,715 |

### Search latency (ms median / p95, Wikipedia data)

| Engine | 1K | 10K | 50K | 100K |
| --- | ---: | ---: | ---: | ---: |
| Narsil | 0.036 / 0.18 | 0.058 / 1.41 | 0.070 / 3.35 | 0.366 / 15.5 |
| Orama 3.1.18 | 0.020 / 0.09 | 0.057 / 1.40 | 0.179 / 5.37 | 0.405 / 34.9 |
| MiniSearch 7.2.0 | 0.018 / 0.15 | 0.036 / 1.19 | 0.143 / 4.98 | 0.255 / 15.0 |

### Filtered search latency (ms median, full schema)

| Engine | 1K | 10K | 50K | 100K |
| --- | ---: | ---: | ---: | ---: |
| **Narsil** | **0.014** | **0.024** | **0.119** | **0.250** |
| Orama 3.1.18 | 0.027 | 0.142 | 2.413 | 4.569 |

MiniSearch does not support field filters.

### Vector search (1536-dim, top-10)

| Engine | 10K insert/s | 50K insert/s | 100K insert/s | 100K search ms |
| --- | ---: | ---: | ---: | ---: |
| **Narsil** | **57,867** | **48,167** | **40,494** | **65.7** |
| Orama 3.1.18 | 54,697 | 40,638 | 32,960 | 180.5 |

### Memory (MB, Wikipedia data)

| Engine | 1K | 10K | 50K | 100K |
| --- | ---: | ---: | ---: | ---: |
| Narsil | 23.0 | 132.3 | 398.8 | 734.3 |
| Orama 3.1.18 | 22.5 | 168.7 | 607.2 | 1,184.2 |
| MiniSearch 7.2.0 | 14.8 | 94.6 | 323.4 | 625.2 |

### Search quality (Cranfield Collection)

| Engine | nDCG@10 | P@10 | MAP | MRR |
| --- | ---: | ---: | ---: | ---: |
| **Narsil** | **0.3739** | **0.2458** | **0.2614** | **0.5638** |
| Orama 3.1.18 | 0.2911 | 0.1836 | 0.1846 | 0.4821 |
| MiniSearch 7.2.0 | 0.0077 | 0.0067 | 0.0027 | 0.0139 |

## What's measured

**Insert throughput** (docs/sec) - Documents indexed per second. Measured across 5 iterations (2 warmup discarded) with a fresh index each time. Reported as median.

**Search latency** (ms/query) - Time to execute a full-text query. 100 varied queries per scale, with 10 warmup queries discarded. Reported as median and p95.

**Filtered search latency** (ms/query) - Full-text search combined with field filters (enum equality, numeric range). Same query methodology as above.

**Vector search latency** (ms/query) - Top-10 nearest neighbor search on high-dimensional embeddings. Reported as median and p95.

**Memory usage** (MB) - Heap memory consumed by the index after inserting all documents. Measured by diffing `process.memoryUsage().heapUsed` before and after, with forced garbage collection (requires `--expose-gc`).

## Search quality methodology

The quality tier measures ranking accuracy against the [Cranfield Collection](https://ir-datasets.com/cranfield.html), created in the 1960s at Cranfield University. It contains 1,400 aerodynamics journal abstracts, 225 natural-language queries, and 1,837 graded relevance judgments made by domain experts.

### Why Cranfield

Cranfield has **exhaustive** relevance judgments: every query-document pair was judged by experts on a 5-point scale. This eliminates the problem of unjudged relevant documents being treated as non-relevant, which plagues larger datasets with sparse judgments. The collection is small enough to run in CI (under 5 seconds) and has been the standard IR evaluation dataset for over 60 years.

### Fairness measures

All three engines are configured identically:

- **Stop words**: Lucene English list (35 terms) from `src/stopwords.ts`, applied to all engines
- **Stemming**: Porter stemmer for all engines (Narsil built-in, MiniSearch via `stemmer@2.0.1`, Orama via `stemming: true`)
- **Query processing**: All engines apply stop word removal and stemming to both indexing and search queries
- **Term matching**: All default to OR semantics (documents matching any query term are candidates)
- **No prefix or fuzzy matching** enabled for any engine
- **Default BM25 parameters** for all engines (no custom tuning)
- **Same document IDs**: All engines insert documents with the original Cranfield numeric IDs, and search results are matched against human judgments using these IDs

### Metrics

- **nDCG@10**: Normalized Discounted Cumulative Gain at rank 10 using exponential gain (2^rel - 1). Measures ranking quality with graded relevance.
- **P@10**: Fraction of the top 10 results that are relevant (relevance > 0).
- **MAP**: Mean Average Precision computed from the top 10 results. Tracks precision at each rank where a relevant document appears.
- **MRR**: Mean Reciprocal Rank, the reciprocal of the position of the first relevant result.

Queries where no relevant documents exist in the judgment set are excluded from the mean computation.

### Relevance grade normalization

The original Cranfield grades are inverted (1 = most relevant). The benchmark normalizes them to the standard convention (higher = more relevant):

| Original | Meaning | Normalized |
| --- | --- | ---: |
| 1 | Complete answer | 4 |
| 2 | High relevance | 3 |
| 3 | Useful background | 2 |
| 4 | Minimum interest | 1 |
| -1 | Not relevant | 0 |

## Methodology notes

- Each engine runs with its default configuration for the English language. No custom tuning.
- Engines are benchmarked sequentially in the same process. GC is forced between measurements to reduce cross-contamination.
- All engines apply English stemming via a Porter stemmer. MiniSearch receives a custom `processTerm` function that applies the same stop words and stemmer used by Narsil and Orama.
- MiniSearch search returns all matching results (no internal pagination). Narsil and Orama default to returning 10 results. The scoring and ranking work is equivalent; the difference is in result serialization.
- Absolute numbers vary by hardware. The value is in the relative comparison between engines on the same machine.
- Statistical confidence intervals (bootstrap 95% CI) are computed for insert speedup comparisons and included in the full output.

## Adding a new engine

1. Create an adapter in `src/adapters/` that implements the `SearchEngine` interface:

```typescript
import type { BenchDocument, SearchEngine } from '../types'

export function createMyEngineAdapter(): SearchEngine {
  return {
    name: 'my-engine',
    async create() { /* initialize empty index */ },
    async insert(documents: BenchDocument[]) { /* batch insert */ },
    async search(query: string) { /* full-text search, return hit count */ },
    async teardown() { /* cleanup */ },
  }
}
```

2. Import and register it in `src/run.ts` alongside the existing adapters.

3. Add the package to `package.json` dependencies with an exact version.
