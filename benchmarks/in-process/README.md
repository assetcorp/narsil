# Narsil Comparative Benchmarks

Side-by-side benchmarks comparing Narsil against other JavaScript search engines on the same Wikipedia dataset, same process, same machine.

## Engines tested

- [Narsil](https://github.com/assetcorp/narsil) - Distributed full-text and vector search engine
- [Orama](https://github.com/oramasearch/orama) - Full-text and vector search engine
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
pnpm --filter benchmarks bench -- --tiers relevance
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

Measures serialize time, serialized size, and deserialize+search time at 100,000 documents. Each engine is measured on the serialization format it actually ships: Narsil on its binary snapshot, Orama on its json export, and MiniSearch on its json export. The suite does not roll its own serializer or work around an engine's format.

Orama's official persistence plugin (`@orama/plugin-data-persistence`) defaults to `binary`, but `binary`, `dpack`, and `seqproto` all fail on this index shape at every meaningful scale (tested against version 3.1.18), so `json` is Orama's only viable shipped format here. Orama's json export builds one JavaScript string, and near 100,000 documents that string exceeds V8's single-string ceiling of about 512MB, so the serialize call throws `RangeError: Invalid string length`. The suite records this as a labeled capability limit of Orama's shipped json serialization; per-engine process isolation keeps it from affecting the other engines, and Narsil (binary) and MiniSearch (json) both complete at 100,000 documents.

### Mutations (`--tiers mutation`)

Measures update and remove throughput at 100,000 documents.

### Relevance Quality (`--tiers relevance`)

Ranking accuracy against a [BEIR](https://github.com/beir-cellar/beir) dataset with human relevance judgments. Defaults to SciFact (5,183 documents, 300 judged test queries); pick another with `--relevance-dataset nfcorpus` or `--relevance-dataset fiqa`. Measures nDCG@10, P@10, MAP, and MRR. See the [search quality methodology](#search-quality-methodology) section below for details.

## Results

Results are pending a fresh run on the current code. Run `pnpm --filter benchmarks bench` and read the output in `results/runs/<run-id>/results.json`. The suite reports insert throughput, search latency (median and p95), filtered search latency, vector insert and search, memory, and BEIR relevance quality (nDCG@10, P@10, MAP, MRR) per engine and scale.

## What's measured

**Insert throughput** (docs/sec) - Documents indexed per second. Measured across 5 iterations (2 warmup discarded) with a fresh index each time. Reported as median.

**Search latency** (ms/query) - Time to execute a full-text query. 100 varied queries per scale, with 10 warmup queries discarded. Reported as median and p95.

**Filtered search latency** (ms/query) - Full-text search combined with field filters (enum equality, numeric range). Same query methodology as above.

**Vector search latency** (ms/query) - Top-10 nearest neighbor search on high-dimensional embeddings. Reported as median and p95.

**Memory usage** (MB) - Heap memory consumed by the index after inserting all documents. Measured by diffing `process.memoryUsage().heapUsed` before and after, with forced garbage collection (requires `--expose-gc`).

## Search quality methodology

The relevance tier measures ranking accuracy against a [BEIR](https://github.com/beir-cellar/beir) dataset with human relevance judgments. Three datasets are available: SciFact (5,183 documents, 300 judged queries), NFCorpus (3,633 documents, 323 judged queries), and FiQA-2018 (57,600 documents, 648 judged queries). SciFact is the default because it runs in a few seconds.

### Why BEIR

BEIR is the standard modern benchmark for zero-shot retrieval, so scores here line up with published baselines and with the server suite, which scores the same corpora against Elasticsearch, OpenSearch, Qdrant, and others. Reusing one dataset family across both suites means a single number characterizes ranking quality whether Narsil runs in-process or as a server.

### Dataset sourcing and pinning

The corpora carry non-commercial and share-alike licenses, so the suite fetches each archive at run time rather than committing it. The first run downloads the dataset zip from the [BEIR distribution](https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/) and caches it under `benchmarks/datasets/` (gitignored). A committed manifest per dataset (`src/data/beir/manifests/`) pins the archive SHA-256, the document/query/judgment counts, and a corpus content fingerprint; every run verifies the loaded data against that pin and aborts on any mismatch. Regenerate the pins with `pnpm --filter benchmarks beir:update-pins` when intentionally moving to a new dataset version.

The fingerprint hashes the indexed text (`title` and `text` joined with a single space, both trimmed) of every document, so it proves the in-process and server suites scored the identical corpus, not just a dataset of the same name. It is recorded under `relevanceDataset` in each run's `results.json`.

### Fairness measures

All three engines are configured identically:

- **Stop words**: Lucene English list (33 terms) from `src/stopwords.ts`, applied to all engines
- **Stemming**: Porter stemmer for all engines (Narsil built-in, MiniSearch via `stemmer@2.0.1`, Orama via `stemming: true`)
- **Query processing**: All engines apply stop word removal and stemming to both indexing and search queries
- **Term matching**: All default to OR semantics (documents matching any query term are candidates)
- **No prefix or fuzzy matching** enabled for any engine
- **Default BM25 parameters** for all engines (no custom tuning)
- **Same document IDs**: All engines insert documents with the original BEIR document IDs, and search results are matched against human judgments using these IDs

### Metrics

Each engine returns its top 10 results per query, and the metrics are computed over that depth:

- **nDCG@10**: Normalized Discounted Cumulative Gain at rank 10 using exponential gain (2^rel - 1). Measures ranking quality with graded relevance.
- **P@10**: Fraction of the top 10 results that are relevant (relevance > 0).
- **MAP**: Mean Average Precision over the returned results. Tracks precision at each rank where a relevant document appears.
- **MRR**: Mean Reciprocal Rank, the reciprocal of the position of the first relevant result.

Queries with no relevant documents in the judgment set are excluded from the mean. BEIR grades already follow the standard convention (higher is more relevant, 0 is non-relevant), so no grade remapping is applied.

## Methodology notes

- Each engine runs with its default configuration for the English language. No custom tuning.
- Engines are benchmarked sequentially in the same process. GC is forced between measurements to reduce cross-contamination.
- All engines apply English stemming via a Porter stemmer. MiniSearch receives a custom `processTerm` function that applies the same stop words and stemmer used by Narsil and Orama.
- All three engines index without a defensive deep-copy of the caller's documents. Narsil runs with `skipClone: true`, and Orama's `insertMultiple` and MiniSearch's `addAll` likewise index the passed-in objects directly, so insert throughput compares the same work across engines.
- Plain-search latency is not directly comparable across all three engines. MiniSearch ranks and returns every matching document, while Narsil and Orama return the top 10 by default. MiniSearch's search options expose no result limit that reduces its internal ranking work, so the extra ranking cost stays in its measured latency and cannot be equalized in code. Each engine runs at its natural default and the tier output repeats this caveat.
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
