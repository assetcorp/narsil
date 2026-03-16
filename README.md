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
import { Narsil } from '@delali/narsil'

const narsil = new Narsil()

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

## Runtime support (TypeScript)

| Runtime | Concurrency | Persistence | Invalidation |
| --- | --- | --- | --- |
| Node.js | `worker_threads` | Filesystem | Adapter-based |
| Bun | `worker_threads` | Filesystem | Adapter-based |
| Deno | Web Workers | Filesystem | BroadcastChannel |
| Browser | Web Workers | IndexedDB | BroadcastChannel |

## License

Apache-2.0
