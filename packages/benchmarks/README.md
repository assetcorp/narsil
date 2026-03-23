# Narsil Comparative Benchmarks

Side-by-side benchmarks comparing Narsil against other JavaScript full-text search engines on the same dataset, same process, same machine.

## Engines tested

- [Narsil](https://github.com/assetcorp/narsil) - Distributed full-text search engine
- [Orama](https://github.com/assetcorp/orama) - Full-text and vector search engine
- [MiniSearch](https://github.com/lucaong/minisearch) - In-memory full-text search

## Quick start

From the repository root:

```bash
# Build Narsil first (benchmarks import the built package)
pnpm --filter @delali/narsil build

# Install benchmark dependencies
pnpm install

# Run benchmarks
pnpm --filter benchmarks bench
```

Results are printed to stdout and saved to `results.json`.

## What's measured

**Insert throughput** (docs/sec) - How many documents each engine indexes per second. Measured across 5 iterations (2 warmup discarded) with a fresh index each time. Reported as median.

**Search latency** (ms/query) - Time to execute a full-text query against an indexed dataset. 100 varied queries per scale, with 10 warmup queries discarded. Reported as median and p95.

**Memory usage** (MB) - Heap memory consumed by the index after inserting all documents. Measured by diffing `process.memoryUsage().heapUsed` before and after indexing, with forced garbage collection between measurements (requires `--expose-gc`).

All three metrics are measured at multiple dataset sizes (1K, 10K, 50K documents) to reveal scaling characteristics.

## Dataset

Documents are generated deterministically from a seeded PRNG (seed: 42) with:

- 200-word technical vocabulary
- Zipfian word frequency distribution (common words appear far more often than rare ones)
- Titles: 3-12 words
- Bodies: 30-170 words (bell-curved distribution)
- Numeric score field (0-99)
- Categorical field (8 categories)

The same dataset is used for every engine at each scale, ensuring fair comparison. Anyone running these benchmarks will generate identical documents.

## Search quality (Cranfield benchmark)

The quality tier measures ranking accuracy against the [Cranfield Collection](https://ir-datasets.com/cranfield.html), the foundational test collection for information retrieval evaluation. Created in the 1960s at Cranfield University, it contains 1,400 aerodynamics journal abstracts, 225 natural-language queries, and 1,837 graded relevance judgments made by domain experts.

### Why Cranfield

Cranfield has **exhaustive** relevance judgments: every query-document pair was judged by experts on a 5-point scale. This eliminates the problem of unjudged relevant documents being treated as non-relevant, which plagues larger datasets with sparse judgments. The collection is small enough to run in CI (under 5 seconds) and has been the standard IR evaluation dataset for over 60 years.

### Fairness measures

All three engines are configured identically for this comparison:

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

### Running the quality benchmark

```bash
pnpm -C packages/benchmarks bench --tiers quality
```

Results are printed to stdout and saved to `results.json` under the `cranfieldQuality` key.

## Methodology notes

- Each engine runs with its default configuration for the English language. No custom tuning.
- Engines are benchmarked sequentially in the same process. GC is forced between measurements to reduce cross-contamination.
- All engines apply English stemming via a Porter stemmer. MiniSearch receives a custom `processTerm` function that applies the same stop words and stemmer used by Narsil and Orama.
- MiniSearch search returns all matching results (no internal pagination). Narsil and Orama default to returning 10 results. The scoring and ranking work is equivalent; the difference is in result serialization.
- Absolute numbers vary by hardware. The value is in the relative comparison between engines on the same machine.

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
