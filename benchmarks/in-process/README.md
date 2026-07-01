# Narsil Comparative Benchmarks

Side-by-side benchmarks that compare Narsil against other JavaScript search engines on the same BEIR corpora, in the same process, on the same machine.

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
pnpm --filter benchmarks bench -- --tiers consistency
```

## Run storage

Results are printed to stdout and saved under `results/runs/<run-id>/`, one directory per invocation. A run id is a UTC timestamp such as `20260630T160034Z`, so runs sort chronologically and a new run never overwrites a prior one. This mirrors the server suite's run store.

Each run directory holds:

- `run.json`: the run manifest, recording the run id, the creation time, the build identity (git commit, branch, and a dirty-tree flag), and the runtime environment (Node version, OS, arch, CPU, total memory).
- `results.json`: the comparative benchmark output that every downstream tool reads.
- `comparison.md`: a rendered Markdown report generated from `results.json` at the end of each run, holding the same tables the run prints to stdout.

The memory profiler writes `memory-profile.json` and `heap.heapsnapshot` into the run directory instead of these files.

The latest run is the lexically greatest valid run-id directory, so tooling resolves 'the current results' by reading the newest `results/runs/<run-id>/` directory; there is no `latest` symlink. Each run directory is tracked in git so results travel with the code that produced them; only heap snapshots stay out of version control, ignored through the global `*.heapsnapshot` rule.

## Datasets

The suite runs entirely on [BEIR](https://github.com/beir-cellar/beir) corpora, downloaded on first run and cached under `benchmarks/datasets/`. Two groups of tiers use two groups of data.

The performance tiers (text, full schema, serialization, and mutation) run on FiQA-2018, a 57,600-document financial question-answering corpus. FiQA ships passages without a title, numeric score, or category, so each document keeps its passage text as `body`, derives `score` from the body length, and derives `category` from a stable per-document hash. That gives the full-schema tier real numeric and enum fields to filter on.

The quality tiers (vector search, relevance, and consistency) run on SciFact (5,183 documents) and NFCorpus (3,633 documents), both of which carry human relevance judgments.

Performance scales: 1,000, 10,000, and 50,000 documents. Serialization and mutation run at 50,000.

## Tiers

### Text-Only Search (`--tiers text`)

Indexes `title` (string) and `body` (string) fields. Measures insert throughput, search latency, and memory at each scale.

### Full Schema (`--tiers full`)

Adds `score` (number) and `category` (enum) fields to the text schema. Measures the same metrics as the text tier plus filtered search latency (text search combined with field filters).

### Vector Search (`--tiers vector`)

Embeds the SciFact and NFCorpus corpora with the `Xenova/all-MiniLM-L6-v2` model (384-dim) and caches the vectors under `benchmarks/datasets/vectors/`. It measures vector insert throughput, top-10 search latency, memory, and recall@10 against an exact brute-force KNN baseline, so you see both speed and accuracy. Orama is the only competitor with vector support, so MiniSearch sits this tier out.

### Serialization (`--tiers serial`)

Measures serialize time, serialized size, and deserialize-plus-search time at 50,000 documents. Each engine runs on the serialization format it ships: Narsil on its binary snapshot, Orama on its json export, and MiniSearch on its json export. The suite doesn't roll its own serializer or work around an engine's format.

Orama's official persistence plugin (`@orama/plugin-data-persistence`) defaults to `binary`, but `binary`, `dpack`, and `seqproto` all fail on this index shape (tested against version 3.1.18), so `json` is Orama's only viable shipped format here. When an engine's shipped format can't serialize the index at all, the harness records a labeled capability limit for that engine and moves on; per-engine process isolation means one engine's failure never touches another's numbers.

### Mutations (`--tiers mutation`)

Measures remove throughput, search latency right after a bulk removal, and reinsert throughput at 50,000 documents. Engines without a remove API skip this tier.

### Relevance Quality (`--tiers relevance`)

Ranking accuracy against a [BEIR](https://github.com/beir-cellar/beir) dataset with human relevance judgments. Defaults to SciFact (5,183 documents, 300 judged test queries); pick another with `--relevance-dataset nfcorpus` or `--relevance-dataset fiqa`. Measures nDCG@10, P@10, MAP, and MRR. See the [search quality methodology](#search-quality-methodology) section below for details.

### Cross-Engine Consistency (`--tiers consistency`)

Indexes the same SciFact corpus in every engine, runs the judged queries through all of them, and reports how far their result sets agree. It records mean hits per query per engine and the mean pairwise top-10 Jaccard overlap, and it flags any query that one engine matched while another returned nothing. This catches an engine that silently drops or mangles documents even when its latency looks healthy.

## Results

Run `pnpm --filter benchmarks bench` and read the rendered report at `results/runs/<run-id>/comparison.md`, or the raw `results.json` beside it. The suite reports insert throughput, search latency (median and p95), filtered search latency, vector insert, search, and recall@10, memory, mutation throughput, and BEIR relevance quality (nDCG@10, P@10, MAP, MRR) per engine and scale.

## What's measured

**Insert throughput** (docs/sec) - Documents indexed per second. Measured across 5 iterations (2 warmup discarded) with a fresh index each time. Reported as median.

**Search latency** (ms/query) - Time to execute a full-text query. 100 varied queries per scale, with 10 warmup queries discarded. Reported as median and p95.

**Filtered search latency** (ms/query) - Full-text search combined with field filters (enum equality, numeric range). Same query methodology as above.

**Vector search latency** (ms/query) - Top-10 nearest-neighbor search on 384-dim embeddings. Reported as median and p95, alongside recall@10 against an exact KNN baseline.

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
