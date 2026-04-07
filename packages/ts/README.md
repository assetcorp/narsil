# Narsil

[![CI](https://github.com/assetcorp/narsil/actions/workflows/ci.yml/badge.svg)](https://github.com/assetcorp/narsil/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@delali/narsil)](https://www.npmjs.com/package/@delali/narsil)
[![downloads](https://img.shields.io/npm/dw/@delali/narsil)](https://www.npmjs.com/package/@delali/narsil)
[![types](https://img.shields.io/badge/types-TypeScript-blue)](https://www.npmjs.com/package/@delali/narsil)
[![license](https://img.shields.io/npm/l/@delali/narsil)](https://github.com/assetcorp/narsil/blob/main/LICENSE)

Distributed search, reforged.

Narsil is a distributed search engine with full-text, vector, hybrid, and geosearch. It auto-partitions large indexes across workers, serializes them into a cross-language binary format (.nrsl), and merges results back into a single ranked answer. The TypeScript package is the first implementation.

> *narsil* is the sword of Elendil in Tolkien's Lord of the Rings, shattered into shards and later reforged. The name maps to the architecture: data shatters into partitions, each shard is independently persisted, and every query reforges them into a unified result.

## Install

```bash
pnpm add @delali/narsil
```

Requires Node.js >= 22.

## Quick start

```ts
import { createNarsil } from '@delali/narsil'

const narsil = await createNarsil()

await narsil.createIndex('products', {
  schema: {
    title: 'string',
    description: 'string',
    price: 'number',
    inStock: 'boolean',
    category: 'enum',
    tags: 'string[]',
  },
  language: 'english',
})

await narsil.insert('products', {
  title: 'Mechanical Keyboard',
  description: 'Cherry MX Brown switches with PBT keycaps and USB-C connection',
  price: 129.99,
  inStock: true,
  category: 'electronics',
  tags: ['peripherals', 'typing', 'mechanical'],
})

const results = await narsil.query('products', {
  term: 'mechanical keyboard',
  filters: {
    inStock: { eq: true },
    price: { lte: 200 },
  },
  boost: { title: 2.0 },
  limit: 10,
})
```

## Configuration

`createNarsil` accepts an optional `NarsilConfig` object. All fields are optional.

```ts
import { createNarsil } from '@delali/narsil'

const narsil = await createNarsil({
  persistence: myAdapter,
  workers: { enabled: true, count: 4 },
  flush: { interval: 5000, mutationThreshold: 100 },
})
```

### NarsilConfig

| Field | Type | Description |
| --- | --- | --- |
| `persistence` | `PersistenceAdapter` | Storage backend for durable indexes (filesystem, IndexedDB, or custom) |
| `invalidation` | `InvalidationAdapter` | Cross-instance cache coordination adapter for multi-process or multi-tab setups |
| `plugins` | `NarsilPlugin[]` | Lifecycle hooks for insert, remove, update, search, and index events |
| `idGenerator` | `() => string` | Custom function for generating document IDs (defaults to UUID v7) |
| `workers` | `WorkerConfig` | Worker thread configuration for parallel search |
| `flush` | `FlushConfig` | Controls when dirty partitions persist to storage |
| `eagerLoad` | `boolean` | When `true`, loads all persisted data into memory at creation time |
| `embedding` | `EmbeddingAdapter` | Default adapter for auto-embedding text fields into vectors (see [Embedding adapters](#embedding-adapters)) |

### WorkerConfig

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `false` | Enables worker thread pool for search |
| `count` | `number` | CPU count | Number of worker threads to spawn |
| `promotionThreshold` | `number` | - | Document count per index that triggers auto-promotion to workers |
| `totalPromotionThreshold` | `number` | - | Total document count across all indexes that triggers auto-promotion |

### FlushConfig

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `interval` | `number` | - | Milliseconds between persistence flushes |
| `mutationThreshold` | `number` | - | Number of mutations that triggers a flush |

### Tokenizer cache

The stemmer normalization cache auto-sizes based on the runtime environment. On Node.js it reads container memory limits (via `process.constrainedMemory()`), in browsers it checks `navigator.deviceMemory`, and falls back to a sensible default elsewhere.

This cache is process-global, shared across all Narsil instances in the same process. You can override the size by calling `configureNormalizationCache` once at startup, before creating any instances:

```ts
import { configureNormalizationCache, createNarsil } from '@delali/narsil'

configureNormalizationCache(500_000)

const narsil = await createNarsil()
```

The value clamps to a floor of 50,000 and a ceiling of 2,000,000 entries. Invalid values (NaN, Infinity, negative numbers, zero) throw a `NarsilError` with code `CONFIG_INVALID`.

Four utility functions are available for cache management:

- `configureNormalizationCache(maxSize)` - set the maximum cache size
- `clearNormalizationCache()` - drop all cached entries (reclaim memory after one-off indexing)
- `resetNormalizationCache()` - clear the cache and reset the size to the auto-detected default
- `getNormalizationCacheSize()` - return the current number of cached entries (useful for monitoring)

## Features

### Full-text search

BM25 scoring with field boosting, fuzzy matching via bounded Levenshtein distance, exact phrase search, and configurable term matching policies. Specify how many query terms a document must match, set minimum score thresholds, and sort by any field.

### Auto-partitioning

Indexes split into shards when they grow beyond a configurable threshold. Partition assignment uses FNV-1a hashing for deterministic routing. Background rebalancing redistributes documents across new partitions without blocking queries, using a write-ahead queue for zero-downtime resharding.

### Worker isolation

Search operations move off the main thread through worker threads (Node.js, Bun) or Web Workers (browser, Deno). The engine starts in direct mode for small indexes and auto-promotes to workers once document counts cross a threshold. You keep using the same API throughout.

### Distributed BM25 scoring

Three scoring modes handle the partition-skew problem:

- **Local**: each partition scores with its own statistics (fastest, default)
- **DFS (Distributed Frequency Statistics)**: a two-phase query collects global term statistics first, then scores with unified IDF values
- **Broadcast**: instances share statistics through the invalidation adapter for pre-computed global scoring

### Vector search

Store and query high-dimensional embeddings with cosine similarity, dot product, or Euclidean distance. Small vector sets use brute-force linear scan. When a field exceeds 10,000 vectors, the engine builds an HNSW graph in the background and swaps the search backend transparently.

### Hybrid search

Combine full-text BM25 scores with vector similarity scores using weighted alpha blending. A single query searches both text and embeddings, normalizes both score sets to [0,1], and returns a merged ranking.

### Geosearch

Index latitude/longitude points and query by radius (Haversine or Vincenty distance) or polygon containment (ray casting). High-precision mode switches to Vincenty's iterative formula for long-distance accuracy.

### Filters

Filter on any indexed field using comparison operators (`eq`, `ne`, `gt`, `lt`, `gte`, `lte`, `between`), string operators (`in`, `nin`, `startsWith`, `endsWith`), array operators (`containsAll`, `matchesAny`, `size`), and presence checks (`exists`, `isEmpty`). Combine filters with explicit `and`, `or`, and `not` boolean combinators.

```ts
const results = await narsil.query('products', {
  term: 'wireless',
  filters: {
    or: [
      { category: { eq: 'electronics' } },
      { category: { eq: 'accessories' } },
    ],
    price: { between: [10, 100] },
    tags: { containsAll: ['bluetooth'] },
  },
})
```

### Faceted search

Get aggregate value counts alongside search results for building filter UIs.

```ts
const results = await narsil.query('products', {
  term: 'laptop',
  facets: {
    category: { limit: 10, sort: 'desc' },
    price: { ranges: [{ from: 0, to: 500 }, { from: 500, to: 1000 }, { from: 1000, to: 5000 }] },
  },
})
// results.facets.category.values => { electronics: 42, computers: 28, ... }
```

### Grouping

Group results by field values with optional custom reducers.

### Match highlighting

Get snippets with customizable pre/post tags marking where query terms appear in the original text.

```ts
const results = await narsil.query('products', {
  term: 'mechanical',
  highlight: {
    fields: ['title', 'description'],
    preTag: '<mark>',
    postTag: '</mark>',
  },
})
// hit.highlights.title.snippet => '<mark>Mechanical</mark> Keyboard'
```

### Embedding adapters

Auto-embed text fields into vectors on insert and query. Pass an `EmbeddingAdapter` at the instance level (shared default) or per-index. When a document is inserted without a pre-computed vector, Narsil concatenates the configured source text fields and calls the adapter to generate the embedding. On query, pass `text` instead of `value` to auto-embed the search phrase.

```ts
import { createNarsil } from '@delali/narsil'
import { createOpenAIEmbedding } from '@delali/narsil/embeddings/openai'

const narsil = await createNarsil({
  embedding: createOpenAIEmbedding({
    apiKey: process.env.OPENAI_API_KEY,
    model: 'text-embedding-3-small',
    dimensions: 1536,
  }),
})

await narsil.createIndex('articles', {
  schema: {
    title: 'string',
    body: 'string',
    embedding: 'vector[1536]',
  },
  embedding: {
    fields: {
      embedding: ['title', 'body'],
    },
  },
})

await narsil.insert('articles', {
  title: 'Distributed search engines',
  body: 'Partitioning data across shards improves throughput...',
})

const results = await narsil.query('articles', {
  mode: 'vector',
  vector: { field: 'embedding', text: 'how do search engines scale?' },
})
```

Two adapters ship with the project:

| Adapter | Package | Dependencies |
| --- | --- | --- |
| OpenAI | `@delali/narsil/embeddings/openai` | None (uses `fetch`) |
| Transformers.js | `@delali/narsil-embeddings-transformers` | `@huggingface/transformers` (peer) |

The OpenAI adapter includes retry logic with exponential backoff and jitter, batch chunking (up to 2,048 inputs per request), and configurable timeouts. The Transformers.js adapter runs models locally with lazy pipeline initialization, supports WebGPU/WASM/CPU backends, and handles asymmetric models through document/query prefixes.

Build a custom adapter by implementing the `EmbeddingAdapter` interface:

```ts
interface EmbeddingAdapter {
  embed(input: string, purpose: 'document' | 'query', signal?: AbortSignal): Promise<Float32Array>
  embedBatch?(inputs: string[], purpose: 'document' | 'query', signal?: AbortSignal): Promise<Float32Array[]>
  readonly dimensions: number
  shutdown?(): Promise<void>
}
```

If `embedBatch` is not provided, Narsil falls back to parallel `embed()` calls with a concurrency limit of 8.

### Term suggestions

Get autocomplete suggestions from the index's term dictionary. The API tokenizes the input, extracts the last word, and matches it against stored terms across all partitions. Results are ranked by document frequency.

```ts
const suggestions = await narsil.suggest('products', {
  prefix: 'mech',
  limit: 5,
})
// suggestions.terms => [{ term: 'mechan', documentFrequency: 12 }, ...]
```

### Cursor-based pagination

Deep pagination using `searchAfter` cursors that track position across partitions. No offset-based performance degradation for deep result sets.

### Results pinning

Inject specific documents at fixed positions in the result set, useful for sponsored or editorial content.

### Persistence

Plug in any storage backend through the persistence adapter interface. Three built-in adapters ship with the package:

| Adapter | Import | Environment |
| --- | --- | --- |
| Memory | `@delali/narsil/adapters/memory` | All |
| Filesystem | `@delali/narsil/adapters/filesystem` | Node.js, Bun, Deno |
| IndexedDB | `@delali/narsil/adapters/indexeddb` | Browser |

Persistence uses debounced flushing: dirty partitions serialize on a timer or after a mutation count threshold, whichever fires first. The serialization format is `.nrsl`, a 32-byte header followed by a MessagePack payload. The format is cross-language portable, so a Python or Rust implementation can read and write the same files.

### Multi-instance invalidation

When multiple instances share the same persistence backend, the invalidation adapter coordinates cache eviction. A filesystem adapter uses marker files for multi-process deployments. A BroadcastChannel adapter handles cross-tab coordination in browsers.

### Plugin system

Hook into the document and search lifecycle with plugins. Plugins can run before/after insert, remove, update, and search operations, and respond to index creation, partition splits, and worker promotions.

### Schema validation

Define typed schemas with support for `string`, `number`, `boolean`, `enum`, `geopoint`, `vector[N]`, and array variants (`string[]`, `number[]`, `boolean[]`, `enum[]`). Nested objects up to 4 levels deep. Documents are validated against the schema at insertion time.

## Language support

Narsil ships with language modules for tokenization, stemming (Snowball algorithm), and stop word removal.

### Full support (tokenizer + stemmer + stop words)

Arabic, Armenian, Bulgarian, Danish, Dutch, English, Finnish, French, German, Greek, Hindi, Hungarian, Indonesian, Irish, Italian, Nepali, Norwegian, Portuguese, Romanian, Russian, Sanskrit, Serbian, Slovenian, Spanish, Swahili, Swedish, Tamil, Turkish, Ukrainian

### CJK support (character n-gram tokenizer + stop words)

Chinese (Mandarin), Japanese

### African language support

Full stemmer support ships for Swahili. Tokenization and stop word support is available for Dagbani, Ewe, Ga, Hausa, Igbo, Twi (Akan), Yoruba, and Zulu.

Each language module is a separate entry point, so you only bundle the languages your application needs:

```ts
import '@delali/narsil/languages/french'
import '@delali/narsil/languages/swahili'
import '@delali/narsil/languages/twi'
```

## Search modes

| Mode | Method | Scoring |
| --- | --- | --- |
| Full-text | `mode: 'fulltext'` | BM25 with field boosting |
| Vector | `mode: 'vector'` | Cosine similarity, dot product, or Euclidean distance |
| Hybrid | `mode: 'hybrid'` | Weighted combination of BM25 + vector similarity |

## Search quality

Ranking quality is measured against the [Cranfield Collection](https://ir-datasets.com/cranfield.html), the foundational information retrieval benchmark created in the 1960s. It contains 1,400 documents and 225 queries with exhaustive human relevance judgments, meaning every query-document pair was scored by domain experts. All engines in this comparison use identical stop words (Lucene English, 35 terms), Porter stemming, and default BM25 parameters.

| Engine | nDCG@10 | P@10 | MAP | MRR |
| --- | ---: | ---: | ---: | ---: |
| **Narsil 0.1.1** | **0.3739** | **0.2458** | **0.2614** | **0.5638** |
| Orama 3.1.18 | 0.2911 | 0.1836 | 0.1846 | 0.4821 |
| MiniSearch 7.2.0 | 0.0077 | 0.0067 | 0.0027 | 0.0139 |

**What these metrics mean:**

- **nDCG@10** measures whether the most relevant documents appear near the top of the results. A score of 1.0 would mean perfect ranking; 0.0 means no relevant documents in the top 10.
- **P@10** is the fraction of the top 10 results that are relevant. Narsil averages about 2.5 relevant results in every top-10 list.
- **MAP** tracks precision at every rank where a relevant document appears. Higher MAP means relevant documents cluster near the top rather than being spread through the result set.
- **MRR** measures how far a user scrolls to find the first relevant result. Narsil's 0.56 means the first relevant document typically appears at position 2.

These scores fall within the expected range for BM25 on standard IR benchmarks (published BM25 baselines on BEIR datasets range from 0.24 to 0.63 nDCG@10). Narsil also runs a [Cranfield regression test](src/__tests__/relevance/cranfield.test.ts) in CI that fails the build if ranking quality drops below calibrated thresholds.

Reproduce: `pnpm -C packages/benchmarks bench --tiers quality`

## Runtime support (TypeScript)

| Runtime | Concurrency | Persistence | Invalidation |
| --- | --- | --- | --- |
| Node.js | `worker_threads` | Filesystem | Adapter-based |
| Bun | `worker_threads` | Filesystem | Adapter-based |
| Deno | Web Workers | Filesystem | BroadcastChannel |
| Browser | Web Workers | IndexedDB | BroadcastChannel |

## License

Apache-2.0
