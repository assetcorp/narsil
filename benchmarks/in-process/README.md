# Narsil Comparative Benchmarks

Side-by-side benchmarks comparing Narsil against other JavaScript search engines on the same Wikipedia dataset, same process, same machine.

## Engines tested

- [Narsil](https://github.com/assetcorp/narsil) - Distributed full-text and vector search engine
- [Orama](https://github.com/assetcorp/orama) - Full-text and vector search engine
- [MiniSearch](https://github.com/lucaong/minisearch) - In-memory full-text search

Engine versions are read from the installed packages at run time and recorded in each run's output, so reported results stay tied to whatever versions you actually ran.

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
pnpm --filter benchmarks bench -- --tiers cranfield
```

## Run storage

Results are printed to stdout and saved under `results/runs/<run-id>/`, one directory per invocation. A run id is a UTC timestamp such as `20260630T160034Z`, so runs sort chronologically and a new run never overwrites a prior one. This mirrors the server suite's run store.

Each run directory holds:

- `run.json`: the run manifest, recording the run id, the creation time, the build identity (git commit, branch, and a dirty-tree flag), and the runtime environment (Node version, OS, arch, CPU, total memory).
- `results.json`: the comparative benchmark output. The memory profiler writes `memory-profile.json` and `heap.heapsnapshot` into the same run directory instead.

The latest run is the lexically greatest valid run-id directory, so tooling resolves "the current results" by reading the newest `results/runs/<run-id>/` directory; there is no `latest` symlink. The `results/` directory is gitignored, so run output stays out of version control by default.

## Dataset

All benchmarks use [English Wikipedia](https://en.wikipedia.org) articles. The dataset is downloaded on first run and cached locally. Articles are processed into a standard format with `title`, `body`, `score` (derived from article length), and `category` (hashed from title) fields.

Scales: 1,000 / 10,000 / 50,000 / 100,000 documents.

## Tiers

### Text-Only Search (`--tiers text`)

Indexes `title` (string) and `body` (string) fields. Measures insert throughput, search latency, and memory at each scale.

### Full Schema (`--tiers full`)

Adds `score` (number) and `category` (enum) fields to the text schema. Measures the same metrics as the text tier plus filtered search latency (text search combined with field filters).

### Vector Search (`--tiers vector`)

Indexes synthetic 1536-dim and 3072-dim embeddings. Measures vector insert throughput, vector search latency (top-10), and memory. Orama is the only competitor with vector support; MiniSearch is excluded.

### Serialization (`--tiers serial`)

Measures serialize time, serialized size, and deserialize+search time at 100,000 documents.

### Mutations (`--tiers mutation`)

Measures update and remove throughput at 100,000 documents.

### Cranfield Relevance (`--tiers cranfield`)

Ranking accuracy against the [Cranfield Collection](https://ir-datasets.com/cranfield.html) with 1,400 documents and 225 queries with exhaustive human relevance judgments. Measures nDCG@10, P@10, MAP, and MRR. See the [search quality methodology](#search-quality-methodology) section below for details.

## Results

Results are pending a fresh run on the current code. Run `pnpm --filter benchmarks bench` and read the output in `results/runs/<run-id>/results.json`. The suite reports insert throughput, search latency (median and p95), filtered search latency, vector insert and search, memory, and Cranfield relevance (nDCG@10, P@10, MAP, MRR) per engine and scale.

## What's measured

**Insert throughput** (docs/sec) - Documents indexed per second. Measured across 5 iterations (2 warmup discarded) with a fresh index each time. Reported as median.

**Search latency** (ms/query) - Time to execute a full-text query. 100 varied queries per scale, with 10 warmup queries discarded. Reported as median and p95.

**Filtered search latency** (ms/query) - Full-text search combined with field filters (enum equality, numeric range). Same query methodology as above.

**Vector search latency** (ms/query) - Top-10 nearest neighbor search on high-dimensional embeddings. Reported as median and p95.

**Memory usage** (MB) - Heap memory consumed by the index after inserting all documents. Measured by diffing `process.memoryUsage().heapUsed` before and after, with forced garbage collection (requires `--expose-gc`).

## Search quality methodology

The Cranfield tier measures ranking accuracy against the [Cranfield Collection](https://ir-datasets.com/cranfield.html), created in the 1960s at Cranfield University. It contains 1,400 aerodynamics journal abstracts, 225 natural-language queries, and 1,837 graded relevance judgments made by domain experts.

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
