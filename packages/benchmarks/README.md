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

## Methodology notes

- Each engine runs with its default configuration for the English language. No custom tuning.
- Engines are benchmarked sequentially in the same process. GC is forced between measurements to reduce cross-contamination.
- Narsil and Orama apply English stemming by default. MiniSearch does not stem by default. This reflects how each engine is used out of the box.
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
