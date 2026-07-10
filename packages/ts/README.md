![Narsil, a distributed search engine](https://raw.githubusercontent.com/assetcorp/narsil/main/assets/banner.png)

# Narsil

[![CI](https://github.com/assetcorp/narsil/actions/workflows/ci.yml/badge.svg)](https://github.com/assetcorp/narsil/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@delali/narsil)](https://www.npmjs.com/package/@delali/narsil)
[![downloads](https://img.shields.io/npm/dw/@delali/narsil)](https://www.npmjs.com/package/@delali/narsil)
[![types](https://img.shields.io/badge/types-TypeScript-blue)](https://www.npmjs.com/package/@delali/narsil)
[![license](https://img.shields.io/npm/l/@delali/narsil)](https://github.com/assetcorp/narsil/blob/main/LICENSE)

Distributed search, reforged.

Narsil is a distributed search engine with full-text, vector, hybrid, and geosearch. One codebase runs in two contexts: embedded in your application process, where queries answer without a network hop, and as a standalone search server with a REST API, a write-ahead log, and bulk NDJSON ingest. Both contexts run the same engine and store indexes in the same cross-language binary format (.nrsl), so an index built in one loads in the other.

The engine partitions large indexes across workers and merges partition results into a single ranked answer. Its BM25 ranking matches the Anserini reference within 0.005 nDCG@10 on the BEIR datasets. On BEIR SciFact it ranks level with Elasticsearch and OpenSearch at 0.678 nDCG@10 and answers 1,020 keyword queries per second, about a quarter more than either ([benchmarks](https://github.com/assetcorp/narsil/blob/main/BENCHMARKS.md)). This TypeScript package is the reference implementation of the cross-language `.nrsl` format, and a second-language port in Go or Rust is the headline item on the [roadmap](https://github.com/assetcorp/narsil/blob/main/ROADMAP.md).

Try it in your browser at [narsil.sondelali.com/demo](https://narsil.sondelali.com/demo).

> *narsil* is the sword of Elendil in Tolkien's Lord of the Rings, shattered into shards and later reforged. The name maps to the architecture: data shatters into partitions, each shard is independently persisted, and every query reforges them into a unified result.

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Indexes](#indexes)
- [Documents](#documents)
- [Batch operations](#batch-operations)
- [Search](#search)
- [Vector search](#vector-search)
- [Hybrid search](#hybrid-search)
- [Geosearch](#geosearch)
- [Embedding adapters](#embedding-adapters)
- [Persistence](#persistence)
- [Durability](#durability)
- [Snapshots and restore](#snapshots-and-restore)
- [Partitions and rebalancing](#partitions-and-rebalancing)
- [Workers](#workers)
- [Multi-instance invalidation](#multi-instance-invalidation)
- [Plugins](#plugins)
- [Events](#events)
- [Errors](#errors)
- [Memory reporting](#memory-reporting)
- [Language support](#language-support)
- [HTTP server](#http-server)
- [Distribution](#distribution)
- [Search quality](#search-quality)
- [Runtime support](#runtime-support)

## Install

```bash
pnpm add @delali/narsil
```

Narsil requires Node.js 22 or newer. It also runs in Bun, Deno, and browsers; see [Runtime support](#runtime-support).

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
    fields: {
      inStock: { eq: true },
      price: { lte: 200 },
    },
  },
  boost: { title: 2.0 },
  limit: 10,
})
```

Every hit carries the document, its id, and its BM25 score. `results.count` reports how many documents matched in total, and `results.elapsed` reports the query time in milliseconds.

## Configuration

`createNarsil` accepts an optional `NarsilConfig` object. All fields are optional.

```ts
import { createNarsil } from '@delali/narsil'
import { createFilesystemPersistence } from '@delali/narsil/adapters/filesystem'

const narsil = await createNarsil({
  persistence: createFilesystemPersistence({ directory: './narsil-data' }),
  workers: { enabled: true, count: 4 },
  flush: { interval: 5000, mutationThreshold: 100 },
})
```

### NarsilConfig

| Field | Type | Description |
| --- | --- | --- |
| `persistence` | `PersistenceAdapter` | Sets the storage backend for persisted partitions. See [Persistence](#persistence). |
| `invalidation` | `InvalidationAdapter` | Coordinates cache eviction across processes or tabs. See [Multi-instance invalidation](#multi-instance-invalidation). |
| `plugins` | `NarsilPlugin[]` | Registers lifecycle hooks for document and search operations. See [Plugins](#plugins). |
| `idGenerator` | `() => string` | Replaces the default UUID v7 generator for document ids. |
| `workers` | `WorkerConfig` | Controls the worker thread pool for parallel search. See [Workers](#workers). |
| `flush` | `FlushConfig` | Controls when dirty partitions persist to storage. |
| `embedding` | `EmbeddingAdapter` | Sets the default adapter for auto-embedding text into vectors. See [Embedding adapters](#embedding-adapters). |
| `embeddingAdapters` | `Record<string, EmbeddingAdapter>` | Registers named adapters that index configs reference by name. Names persist in index metadata, so durability recovery can rebind them. |
| `durability` | `DurabilityConfig` | Enables write-ahead logging and snapshots. See [Durability](#durability). |

### WorkerConfig

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `false` | Turns on the worker thread pool for search. |
| `count` | `number` | CPU cores minus one, clamped between 2 and 8 | Sets the number of worker threads to spawn. |
| `promotionThreshold` | `number` | `10000` | Sets the per-index document count that triggers promotion to workers. |
| `totalPromotionThreshold` | `number` | `50000` | Sets the document count across all indexes that triggers promotion. |

### FlushConfig

| Field | Type | Description |
| --- | --- | --- |
| `interval` | `number` | Sets the milliseconds between persistence flushes. |
| `mutationThreshold` | `number` | Sets the mutation count that triggers a flush. |

### Tokenizer cache

The stemmer normalization cache auto-sizes based on the runtime environment. On Node.js it reads container memory limits through `process.constrainedMemory()`, in browsers it checks `navigator.deviceMemory`, and it falls back to a fixed default elsewhere.

This cache is process-global and shared across all Narsil instances in the same process. Override the size by calling `configureNormalizationCache` once at startup, before creating any instances:

```ts
import { configureNormalizationCache, createNarsil } from '@delali/narsil'

configureNormalizationCache(500_000)

const narsil = await createNarsil()
```

The value clamps to a floor of 50,000 and a ceiling of 2,000,000 entries. Invalid values (NaN, Infinity, negative numbers, and zero) throw a `NarsilError` with code `CONFIG_INVALID`.

Four functions manage the cache:

- `configureNormalizationCache(maxSize)` sets the maximum cache size.
- `clearNormalizationCache()` drops all cached entries, which reclaims memory after one-off indexing.
- `resetNormalizationCache()` clears the cache and resets the size to the auto-detected default.
- `getNormalizationCacheSize()` returns the current number of cached entries for monitoring.

## Indexes

`createIndex(name, config)` creates an index from a schema. The schema supports `string`, `number`, `boolean`, `enum`, `geopoint`, `vector[N]`, and the array variants `string[]`, `number[]`, `boolean[]`, and `enum[]`. Objects nest up to 4 levels deep. Narsil validates every document against the schema at insertion time.

```ts
await narsil.createIndex('articles', {
  schema: {
    title: 'string',
    body: 'string',
    author: {
      name: 'string',
      verified: 'boolean',
    },
    publishedYear: 'number',
  },
  language: 'english',
  required: ['title'],
})
```

### IndexConfig

| Field | Type | Description |
| --- | --- | --- |
| `schema` | `SchemaDefinition` | Declares the fields and their types. This field is required. |
| `language` | `string` | Selects the language module for tokenization and stemming. The default is `english`. |
| `partitions` | `PartitionConfig` | Sets `maxDocsPerPartition` and `maxPartitions`. See [Partitions and rebalancing](#partitions-and-rebalancing). |
| `defaultScoring` | `'local' \| 'dfs' \| 'broadcast'` | Sets the scoring mode used when a query does not pass one. See [Scoring modes](#scoring-modes). |
| `bm25` | `BM25Params` | Overrides the BM25 `k1` and `b` parameters. |
| `stopWords` | `Set<string> \| (defaults: Set<string>) => Set<string>` | Replaces or transforms the language module's stop word set. |
| `tokenizer` | `CustomTokenizer` | Replaces the built-in tokenizer with your own `tokenize(text)` implementation. |
| `trackPositions` | `boolean` | Stores token positions for highlighting. The default is `true`. |
| `surfaceForms` | `boolean` | Records the original spellings of stemmed words for suggestions and prefix completions. The default is `false`. See [Suggestions](#suggestions). |
| `vectorPromotion` | `VectorIndexConfig` | Tunes the HNSW promotion threshold, graph parameters, and quantization. See [Vector search](#vector-search). |
| `strict` | `boolean` | Rejects documents that carry fields missing from the schema. |
| `embedding` | `EmbeddingFieldConfig` | Maps text fields to vector fields for auto-embedding. See [Embedding adapters](#embedding-adapters). |
| `required` | `string[]` | Lists fields a document must carry; inserts without them fail with `DOC_MISSING_REQUIRED_FIELD`. |

### Index management

```ts
const indexes = narsil.listIndexes()
// [{ name: 'articles', documentCount: 1204, partitionCount: 1, language: 'english' }]

const stats = narsil.getStats('articles')
// { documentCount, partitionCount, estimatedMemoryBytes, language, schema }

await narsil.clear('articles')

await narsil.dropIndex('articles')
```

`clear` removes every document but keeps the index and its schema. `dropIndex` removes the index entirely, including its persisted data. Call `shutdown()` when the process is done with the engine; it stops workers, flushes durability state, and rejects further calls.

## Documents

### Insert

`insert(indexName, document, docId?, options?)` resolves the document id in this order: the explicit `docId` argument wins, then a string `id` field on the document itself, and otherwise Narsil generates a UUID v7. The method returns the resolved id.

```ts
const generatedId = await narsil.insert('products', { title: 'Trackball Mouse' })

const explicitId = await narsil.insert('products', { title: 'Split Keyboard' }, 'kb-042')

await narsil.insert('products', { id: 'kb-043', title: 'Tenkeyless Keyboard' })
```

Inserting an id that already exists fails with `DOC_ALREADY_EXISTS`, and `update` fails with `DOC_NOT_FOUND` when the id is missing, so an upsert checks `has()` first and picks the right call. The HTTP server's PUT endpoint packages that check as one request.

### Read

```ts
const doc = await narsil.get('products', 'kb-042')
// the document, or undefined when the id is unknown

const docs = await narsil.getMultiple('products', ['kb-042', 'kb-043'])
// Map<string, AnyDocument> holding only the ids that exist

const exists = await narsil.has('products', 'kb-042')

const count = await narsil.countDocuments('products')
```

### Update and remove

`update` replaces the whole document under an id. Internally it removes the old document and inserts the new one, with a fast path when the change touches nothing the index depends on.

```ts
await narsil.update('products', 'kb-042', { title: 'Split Ergonomic Keyboard' })

await narsil.remove('products', 'kb-042')
```

Both methods throw `DOC_NOT_FOUND` for an unknown id.

## Batch operations

`insertBatch`, `updateBatch`, and `removeBatch` process many documents in one call and return partial results. One bad document never aborts the batch: every failure is collected with its id and error, and every success is applied.

```ts
const result = await narsil.insertBatch('products', [
  { id: 'p1', title: 'USB-C Hub', price: 49 },
  { id: 'p2', title: 'Laptop Stand', price: 89 },
  { id: 'p3', title: 'Broken Doc', price: 'not-a-number' },
])

// result.succeeded => ['p1', 'p2']
// result.failed => [{ docId: 'p3', error: NarsilError(DOC_VALIDATION_FAILED) }]

await narsil.updateBatch('products', [
  { docId: 'p1', document: { title: 'USB-C Hub, 8 ports', price: 59 } },
])

await narsil.removeBatch('products', ['p1', 'p2'])
```

Batch inserts resolve ids from each document's `id` field and generate UUID v7 ids for the rest. Large batches process in chunks and yield the event loop between chunks, so searches stay responsive during a bulk load.

## Search

`query(indexName, params)` runs every search. The `mode` parameter selects `'fulltext'` (the default), `'vector'`, or `'hybrid'`.

### Full-text search

Full-text search scores with BM25. `fields` restricts the search to specific fields, and `boost` multiplies per-field scores.

```ts
const results = await narsil.query('products', {
  term: 'wireless keyboard',
  fields: ['title', 'description'],
  boost: { title: 2.0 },
  limit: 10,
  offset: 0,
})
```

`limit` defaults to 10. Each hit has the shape `{ id, score, document, highlights?, scoreComponents? }`. Pass `includeScoreComponents: true` to receive per-term frequencies, field lengths, and IDF values for debugging a ranking.

### Fuzzy matching

`tolerance` sets the maximum Levenshtein edit distance between a query term and an indexed term. It defaults to 0, which requires exact matches. `prefixLength` limits fuzzy candidates to terms sharing that many leading characters with the query term; it defaults to 2, and raising it makes fuzzy lookups faster and stricter. `exact: true` turns fuzzy expansion off for the whole query.

```ts
const results = await narsil.query('products', {
  term: 'keybaord',
  tolerance: 2,
  prefixLength: 3,
})
```

### Search as you type

`prefix: true` treats the last word of the query as an unfinished word, so `secur` matches documents containing `security`. Earlier words must match fully, and `tolerance` keeps applying to them while the unfinished word is completed instead of typo-corrected. Completions score against a shared document frequency and rank below full-word matches, so a document containing the exact typed word comes first. The option is off by default; turn it on for queries fired on every keystroke.

Completions match against the term dictionary, which stores stemmed tokens, so a typed word that runs past the end of a stem stops matching: `security` is indexed as `secur`, and the query `securi` finds nothing. Create the index with `surfaceForms: true` to match completions against the original spellings instead; the same setting gives [suggestions](#suggestions) their display words.

```ts
const results = await narsil.query('products', {
  term: 'mechanical keyb',
  prefix: true,
})
```

### Score and coverage thresholds

`minScore` drops hits scoring below a floor. `termMatch` sets how many query terms a document must match: `'any'` (the default) accepts one term, `'all'` requires every term, and a number requires at least that many terms.

```ts
const results = await narsil.query('products', {
  term: 'mechanical gaming keyboard',
  termMatch: 2,
  minScore: 1.5,
})
```

### Filters

Filter on any indexed field with comparison operators (`eq`, `ne`, `gt`, `lt`, `gte`, `lte`, `between`), string operators (`in`, `nin`, `startsWith`, `endsWith`), array operators (`containsAll`, `matchesAny`, `size`), and presence checks (`exists`, `notExists`, `isEmpty`, `isNotEmpty`). Combine filter expressions with `and`, `or`, and `not`.

```ts
const results = await narsil.query('products', {
  term: 'wireless',
  filters: {
    or: [
      { fields: { category: { eq: 'electronics' } } },
      { fields: { category: { eq: 'accessories' } } },
    ],
    fields: {
      price: { between: [10, 100] },
      tags: { containsAll: ['bluetooth'] },
    },
  },
})
```

Field conditions live under `fields`, and the `and`, `or`, and `not` combinators nest whole filter expressions, so any boolean shape is expressible. Filters narrow the candidates a search scores: a full-text query needs a `term` to produce hits, and in vector and hybrid modes the filters restrict which documents the vector search considers.

### Facets

Facets return value counts alongside the hits for building filter UIs. String and enum facets take a `limit` and a `sort` direction, and numeric facets take explicit `ranges`.

```ts
const results = await narsil.query('products', {
  term: 'laptop',
  facets: {
    category: { limit: 10, sort: 'desc' },
    price: { ranges: [{ from: 0, to: 500 }, { from: 500, to: 1000 }, { from: 1000, to: 5000 }] },
  },
})

// results.facets => { category: { values: { electronics: 42, computers: 28 }, count: 70 }, ... }
```

### Sort

`sort` orders hits by field values instead of score. Multiple entries apply in order, so the second field breaks ties in the first.

```ts
const results = await narsil.query('products', {
  term: 'keyboard',
  sort: { price: 'asc', title: 'asc' },
})
```

### Grouping

`group` collapses hits that share field values. `maxPerGroup` caps how many hits each group keeps, and an optional reducer folds every grouped document into an accumulated value.

```ts
const results = await narsil.query('products', {
  term: 'keyboard',
  group: {
    fields: ['category'],
    maxPerGroup: 3,
  },
})

// results.groups => [{ values: { category: 'electronics' }, hits: [...] }, ...]

const withTotals = await narsil.query('products', {
  term: 'keyboard',
  group: {
    fields: ['category'],
    reduce: {
      initialValue: () => 0,
      reducer: (total, doc) => (total as number) + ((doc.price as number) ?? 0),
    },
  },
})
```

### Highlighting

`highlight` returns snippets with tags marking where query terms appear. Highlighting needs `trackPositions` left at its default of `true`.

```ts
const results = await narsil.query('products', {
  term: 'mechanical',
  highlight: {
    fields: ['title', 'description'],
    preTag: '<mark>',
    postTag: '</mark>',
    maxSnippetLength: 160,
  },
})

// hit.highlights?.title.snippet => '<mark>Mechanical</mark> Keyboard'
```

### Pagination

Shallow pagination uses `limit` and `offset`. Deep pagination uses `searchAfter` cursors, which track a position per partition and keep latency flat at any depth. Every page's result carries a `cursor` string; pass it back as `searchAfter` to fetch the next page.

```ts
const firstPage = await narsil.query('products', { term: 'keyboard', limit: 20 })

if (firstPage.cursor) {
  const secondPage = await narsil.query('products', {
    term: 'keyboard',
    limit: 20,
    searchAfter: firstPage.cursor,
  })
}
```

A cursor is only valid for the same query parameters it came from. A malformed cursor fails with `SEARCH_INVALID_CURSOR`.

### Pinning

`pinned` places specific documents at fixed positions in the ranked results, which serves sponsored or editorial placements. Positions are zero-based.

```ts
const results = await narsil.query('products', {
  term: 'keyboard',
  pinned: [{ docId: 'kb-editorial-pick', position: 0 }],
})
```

### Scoring modes

Three scoring modes handle the statistics-skew problem that appears when an index spans partitions or instances:

- `'local'` scores each partition with its own statistics. It is the fastest mode and the default.
- `'dfs'` runs a two-phase query that first collects global term statistics, then scores with unified IDF values.
- `'broadcast'` has instances share statistics through the invalidation adapter, so scoring uses pre-computed global values.

Set a per-index default with `defaultScoring` in the index config, or set `scoring` per query:

```ts
const results = await narsil.query('products', {
  term: 'keyboard',
  scoring: 'dfs',
})
```

### Preflight

`preflight(indexName, params)` returns the match count for a query without materializing, ranking, or paginating hits. Use it to size a result set before running an expensive query.

```ts
const { count, elapsed } = await narsil.preflight('products', { term: 'keyboard' })
```

### Suggestions

`suggest(indexName, params)` returns autocomplete candidates. It tokenizes the input, takes the last word as the prefix, and ranks completions by the number of documents they match. By default the candidates are the stemmed tokens the index stores, so a catalogue containing "mechanical" suggests the stem `mechan`. Create the index with `surfaceForms: true` to suggest the words as they appear in your documents; the engine then records the original spelling of every word the stemmer changed and suggests `mechanical` instead.

```ts
await narsil.createIndex('products', {
  schema: { title: 'string', description: 'string' },
  surfaceForms: true,
})

const suggestions = await narsil.suggest('products', { prefix: 'mech', limit: 5 })
// suggestions.terms => [{ term: 'mechanical', documentFrequency: 12 }, ...]
```

## Vector search

Declare a `vector[N]` field in the schema and insert documents carrying arrays of that exact length. Small fields use an exact brute-force scan. Once a field reaches 1,024 vectors, the engine builds an HNSW graph in the background and switches the field to approximate search. The cutoff and graph parameters are configurable per index through `vectorPromotion`.

```ts
await narsil.createIndex('docs', {
  schema: {
    title: 'string',
    embedding: 'vector[768]',
  },
  vectorPromotion: {
    threshold: 2048,
    hnswConfig: { m: 16, efConstruction: 200, metric: 'cosine' },
    quantization: 'sq8',
  },
})

await narsil.insert('docs', {
  title: 'Distributed consensus',
  embedding: myPrecomputedVector,
})

const results = await narsil.query('docs', {
  mode: 'vector',
  vector: {
    field: 'embedding',
    value: myQueryVector,
    metric: 'cosine',
    similarity: 0.35,
    efSearch: 100,
  },
  limit: 10,
})
```

The `vector` parameter takes either a raw `value` array or a `text` string for auto-embedding, and passing both fails with `EMBEDDING_CONFIG_INVALID`. `metric` selects `'cosine'` (the default), `'dotProduct'`, or `'euclidean'`. `similarity` sets a score floor; hits below it drop before `limit` applies, so a page can come back short. For `euclidean`, the floor applies to the similarity mapping `1 / (1 + distance)`. `efSearch` raises HNSW recall at the cost of latency and has no effect while the field still uses the brute-force backend. A `value` whose length differs from the field's declared dimension fails with `VECTOR_DIMENSION_MISMATCH`.

Quantization mode `'sq8'` is the default; it stores scalar-quantized int8 vectors, which cuts vector memory roughly 4x. Set `quantization: 'none'` to keep full float32 vectors.

### Vector maintenance

Removed and updated vectors leave tombstones in the HNSW graph, which slows queries as they accumulate. Two maintenance calls clean up, and a status call reports whether either is worth running:

```ts
const status = narsil.vectorMaintenanceStatus('docs')
// [{ fieldName, tombstoneRatio, graphCount, bufferSize, building, estimatedCompactMs, estimatedOptimizeMs }]

await narsil.compactVectors('docs', 'embedding')

await narsil.optimizeVectors('docs', 'embedding')
```

`compactVectors` drops tombstones without rebuilding the graph and runs synchronously. `optimizeVectors` rebuilds the graph from live vectors, which takes longer and restores full query speed. Omit the field name to run maintenance on every vector field in the index.

## Hybrid search

Hybrid mode runs the full-text and vector searches in one query and fuses the two rankings. The vector side needs a query vector: pass a precomputed `value` array, or a `text` string that the index or instance embedding adapter turns into a vector. The `text` form needs an embedding adapter configured first, so passing `text` without one fails with `EMBEDDING_CONFIG_INVALID`; see [Embedding adapters](#embedding-adapters).

```ts
const results = await narsil.query('docs', {
  mode: 'hybrid',
  term: 'how do search engines scale',
  vector: { field: 'embedding', value: myQueryVector },
  hybrid: { strategy: 'rrf', k: 60 },
  limit: 10,
})
```

Two fusion strategies are available:

- `'rrf'` (the default) applies reciprocal rank fusion, which combines the two rankings by position instead of by score. `k` dampens the contribution of lower ranks and defaults to 60.
- `'linear'` normalizes both score sets to [0, 1] and blends them as `alpha * vector + (1 - alpha) * text`. `alpha` defaults to 0.5 and clamps to [0, 1].

```ts
const weighted = await narsil.query('docs', {
  mode: 'hybrid',
  term: 'partition rebalancing',
  vector: { field: 'embedding', value: myQueryVector },
  hybrid: { strategy: 'linear', alpha: 0.7 },
})
```

## Geosearch

Declare a `geopoint` field and insert documents with `{ lat, lon }` values. Geo conditions are filters that refine a search, so a geo query pairs a `term` (or a vector query) with a location filter, and it composes with other filters, facets, and every other query feature. A query with only a location filter and no `term` matches nothing, the same way any other filter refines a term search.

```ts
await narsil.createIndex('stores', {
  schema: {
    name: 'string',
    location: 'geopoint',
  },
})

await narsil.insert('stores', {
  name: 'Osu Night Market',
  location: { lat: 5.5571, lon: -0.1824 },
})

const nearby = await narsil.query('stores', {
  term: 'market',
  filters: {
    fields: {
      location: {
        radius: { lat: 5.556, lon: -0.1969, distance: 5, unit: 'km' },
      },
    },
  },
})

const inArea = await narsil.query('stores', {
  term: 'market',
  filters: {
    fields: {
      location: {
        polygon: {
          points: [
            { lat: 5.52, lon: -0.25 },
            { lat: 5.52, lon: -0.15 },
            { lat: 5.62, lon: -0.15 },
            { lat: 5.62, lon: -0.25 },
          ],
        },
      },
    },
  },
})
```

Radius filters measure Haversine distance by default and accept `unit: 'km' | 'mi' | 'm'`. Set `highPrecision: true` to switch to Vincenty's iterative formula for long-distance accuracy. Polygon filters test containment with ray casting. Both filter shapes accept `inside: false` to invert the match and return documents outside the area.

## Embedding adapters

Embedding adapters turn text into vectors automatically, on insert and at query time. Configure a default adapter for the whole engine, register named adapters, or set one per index. Map each vector field to the text fields it embeds; multiple source fields concatenate before embedding.

```ts
import { createNarsil } from '@delali/narsil'
import { createOpenAIEmbedding } from '@delali/narsil/embeddings/openai'

const narsil = await createNarsil({
  embedding: createOpenAIEmbedding({
    baseUrl: 'https://api.openai.com/v1',
    apiKey: process.env.OPENAI_API_KEY ?? '',
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

### Named adapters

An adapter instance is a function and cannot be serialized, so an index that names its adapter survives durability recovery: the engine persists the name in index metadata and rebinds it on the next start. Register names through the config or at runtime, and reference them from the index config:

```ts
import { createNarsil } from '@delali/narsil'
import { createOpenAIEmbedding } from '@delali/narsil/embeddings/openai'

const engine = await createNarsil({
  embeddingAdapters: {
    'openai-small': createOpenAIEmbedding({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: process.env.OPENAI_API_KEY ?? '',
      model: 'text-embedding-3-small',
      dimensions: 1536,
    }),
  },
  durability: { directory: './narsil-data' },
})

await engine.createIndex('articles', {
  schema: { title: 'string', embedding: 'vector[1536]' },
  embedding: {
    adapter: 'openai-small',
    fields: { embedding: ['title'] },
  },
})

engine.registerEmbeddingAdapter('openai-small', myReplacementAdapter)
```

`registerEmbeddingAdapter` rebinds every index referencing that name, which lets you rotate credentials or swap models without recreating indexes.

### Bundled adapters

| Adapter | Package | Dependencies |
| --- | --- | --- |
| OpenAI | `@delali/narsil/embeddings/openai` | The adapter has no dependencies and uses `fetch`. |
| Transformers.js | `@delali/narsil-embeddings-transformers` | The adapter needs `@huggingface/transformers` as a peer dependency. |

The OpenAI adapter retries retryable failures with exponential backoff and jitter, chunks batches at 2,048 inputs per request, and accepts a timeout and a retry cap. `baseUrl` points at any OpenAI-compatible endpoint, and `apiKey` accepts a string or a function returning one, so short-lived credentials work. The Transformers.js adapter runs models locally with lazy pipeline initialization, supports WebGPU, WASM, and CPU backends, and handles asymmetric models such as E5 and BGE through `documentPrefix` and `queryPrefix`. Its own [README](../embeddings-transformers/README.md) documents every option.

### Custom adapters

Build an adapter by satisfying the `EmbeddingAdapter` interface:

```ts
interface EmbeddingAdapter {
  embed(input: string, purpose: 'document' | 'query', signal?: AbortSignal): Promise<Float32Array>
  embedBatch?(inputs: string[], purpose: 'document' | 'query', signal?: AbortSignal): Promise<Float32Array[]>
  readonly dimensions: number
  shutdown?(): Promise<void>
}
```

When `embedBatch` is missing, Narsil falls back to parallel `embed()` calls with a concurrency limit of 8.

## Persistence

Persistence stores serialized partitions through a pluggable adapter. The package includes three adapters:

| Adapter | Import | Environment |
| --- | --- | --- |
| Memory | `@delali/narsil/adapters/memory` | The adapter works everywhere and is meant for tests. |
| Filesystem | `@delali/narsil/adapters/filesystem` | The adapter runs on Node.js, Bun, and Deno. |
| IndexedDB | `@delali/narsil/adapters/indexeddb` | The adapter runs in browsers. |

```ts
import { createNarsil } from '@delali/narsil'
import { createFilesystemPersistence } from '@delali/narsil/adapters/filesystem'

const narsil = await createNarsil({
  persistence: createFilesystemPersistence({ directory: './narsil-data' }),
  flush: { interval: 5000, mutationThreshold: 100 },
})
```

In the browser, `createIndexedDBPersistence({ dbName, storeName })` takes the same place, and both config fields are optional. Flushing is debounced: dirty partitions serialize on the `flush.interval` timer or after `flush.mutationThreshold` mutations, whichever fires first.

The serialization format is `.nrsl`, a 32-byte header followed by a MessagePack payload. The format is cross-language portable and specified in [`packages/spec`](../spec), so a Python or Rust implementation can read and write the same files.

A custom backend satisfies the `PersistenceAdapter` interface: `save(key, data)`, `load(key)`, `delete(key)`, and `list(prefix)`, all returning promises.

## Durability

Debounced persistence can lose the writes made after the last flush. Durability closes that window with a write-ahead log: every mutation appends to the log before it is acknowledged, periodic checkpoints capture the index state, and recovery replays the log over the newest checkpoint. Enable it with a directory:

```ts
const narsil = await createNarsil({
  durability: {
    directory: './narsil-data',
    mode: 'sync',
  },
})
```

`createNarsil` runs recovery before it resolves, so indexes, documents, and named embedding adapter bindings are back before the first call. `checkpoint(indexName)` forces a checkpoint outside the automatic schedule:

```ts
await narsil.checkpoint('products')
```

### DurabilityConfig

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `directory` | `string` | none | Sets the root directory for the log and checkpoints. |
| `mode` | `'sync' \| 'async'` | `'sync'` | Selects the acknowledgement contract described below. |
| `flushIntervalMs` | `number` | `1000` | Sets how often the async mode flushes the log to disk. |
| `segmentMaxBytes` | `number` | `67108864` | Caps a log segment at this size (64 MiB) before rolling to a new one. |
| `checkpointIntervalMs` | `number` | `300000` | Sets the time between automatic checkpoints (5 minutes). |
| `checkpointMutationThreshold` | `number` | `100000` | Sets the mutation count that triggers a checkpoint early. |
| `compactionThreshold` | `number` | `12` | Sets the checkpoint segment count that triggers compaction. |

In `sync` mode a write is not acknowledged until it is on disk, so a crash never loses a write your caller saw succeed. In `async` mode writes acknowledge immediately while the log flushes on `flushIntervalMs`, which is faster but can lose the final interval on a hard crash. Durability failures surface through the `durabilityError` event; see [Events](#events).

## Snapshots and restore

`snapshot(indexName)` serializes a whole index, including its documents, schema, and vector data, into one portable byte array. `restore(indexName, data)` rebuilds an index from those bytes, replacing the index if it already exists.

```ts
import { readFile, writeFile } from 'node:fs/promises'

const bytes = await narsil.snapshot('products')
await writeFile('./products.nrsl', bytes)

const saved = await readFile('./products.nrsl')
await narsil.restore('products', new Uint8Array(saved))
```

Snapshots use the same cross-language `.nrsl` envelope as persistence, so one engine's snapshot restores in another process, another machine, or another language implementation. Restoring bytes from an incompatible envelope version fails with `ENVELOPE_VERSION_MISMATCH`.

## Partitions and rebalancing

An index starts with the partition count set by `partitions.maxPartitions`, which defaults to 1. Documents route to partitions by FNV-1a hash of their id, which keeps routing deterministic across processes and languages. `partitions.maxDocsPerPartition` caps capacity: when an index holds `maxDocsPerPartition * partitionCount` documents, further inserts fail with `PARTITION_CAPACITY_EXCEEDED`.

```ts
await narsil.createIndex('logs', {
  schema: { message: 'string' },
  partitions: { maxPartitions: 4, maxDocsPerPartition: 250_000 },
})

await narsil.rebalance('logs', 8)

await narsil.updatePartitionConfig('logs', { maxDocsPerPartition: 500_000 })
```

`rebalance(indexName, targetPartitionCount)` reshapes the index to a new partition count while it stays online. Writes arriving during the reshape buffer in a write-ahead queue and replay in order when the reshape completes, and queries keep answering throughout. `updatePartitionConfig` adjusts the caps at runtime; it rejects a new capacity below the current document count with `PARTITION_CAPACITY_EXCEEDED` and rejects changes while a rebalance is running with `PARTITION_REBALANCING_BACKPRESSURE`.

Two measured costs are worth knowing before raising partition counts:

**Single-process overhead.** Partitioning pays off when shards live on separate workers or hosts. Inside one Node.js thread, going from 1 to 20 partitions costs about 14% of insert throughput, 28% of median search latency, and 27% at p95, with no scaling upside. Keep `maxPartitions` low for single-process deployments and raise it once partitions fan out.

**Rebalance latency spikes.** While a reshape runs, worst-tick p95 latency can climb to about 25ms compared with around 11ms in steady state. Schedule reshapes during low-traffic windows, or pre-size the index with `maxDocsPerPartition` so mid-load reshapes never become necessary.

## Workers

Search can move off the main thread through worker threads on Node.js and Bun, or Web Workers in browsers and Deno. With `workers.enabled: true`, the engine starts in direct mode and promotes itself to the worker pool once any index passes `promotionThreshold` documents or all indexes together pass `totalPromotionThreshold`. The API stays identical before and after promotion.

```ts
const narsil = await createNarsil({
  workers: {
    enabled: true,
    count: 4,
    promotionThreshold: 10_000,
    totalPromotionThreshold: 50_000,
  },
})
```

Promotion emits the `workerPromote` event, and a crashed worker emits `workerCrash`; see [Events](#events). Worker heap usage appears in `getMemoryStats()`.

## Multi-instance invalidation

When several engine instances share one persistence backend, the invalidation adapter tells the others which partitions changed so they evict stale cache instead of serving old data. The package includes two adapters, and `@delali/narsil/invalidation/noop` stubs the interface for single-instance deployments:

| Adapter | Import | Use case |
| --- | --- | --- |
| Filesystem | `@delali/narsil/invalidation/filesystem` | The adapter coordinates processes on one machine through marker files. |
| BroadcastChannel | `@delali/narsil/invalidation/broadcast-channel` | The adapter coordinates browser tabs through a BroadcastChannel. |

```ts
import { createNarsil } from '@delali/narsil'
import { createFilesystemPersistence } from '@delali/narsil/adapters/filesystem'
import { createFilesystemInvalidation } from '@delali/narsil/invalidation/filesystem'

const narsil = await createNarsil({
  persistence: createFilesystemPersistence({ directory: './narsil-data' }),
  invalidation: createFilesystemInvalidation({ directory: './narsil-data', pollInterval: 1000 }),
})
```

The invalidation channel also carries partition statistics for the `broadcast` scoring mode; see [Scoring modes](#scoring-modes). A custom adapter satisfies the `InvalidationAdapter` interface: `publish(event)`, `subscribe(handler)`, and `shutdown()`.

## Plugins

Plugins hook into the document and search lifecycle. A plugin is an object with a `name` and any of the optional hooks:

| Hook | Fires |
| --- | --- |
| `beforeInsert` / `afterInsert` | The hooks fire around every document insert, including each document of a batch. |
| `beforeUpdate` / `afterUpdate` | The hooks fire around every document update. |
| `beforeRemove` / `afterRemove` | The hooks fire around every document removal. |
| `beforeSearch` / `afterSearch` | The hooks fire around every query; `afterSearch` receives the results. |
| `onIndexCreate` / `onIndexDrop` | The hooks fire when an index is created or dropped. |

The interface also declares `onPartitionSplit` and `onWorkerPromote`, which are reserved for partition and worker lifecycle notifications; the engine does not fire them yet. Subscribe to the `partitionRebalance` and `workerPromote` [events](#events) for those signals today.

```ts
import { createNarsil, type NarsilPlugin } from '@delali/narsil'

const auditLog: NarsilPlugin = {
  name: 'audit-log',
  async afterInsert(ctx) {
    console.log(`indexed ${ctx.docId} into ${ctx.indexName}`)
  },
  async afterSearch(ctx) {
    console.log(`query on ${ctx.indexName} returned ${ctx.results?.hits.length ?? 0} hits`)
  },
}

const narsil = await createNarsil({ plugins: [auditLog] })
```

Hooks can be async, and `before*` hooks run to completion before the operation applies, so a thrown error in `beforeInsert` rejects the insert. Errors thrown in `after*` hooks log a warning and never fail the operation that already succeeded.

## Events

`on(event, handler)` subscribes to engine events and `off(event, handler)` unsubscribes. The payloads are typed through `NarsilEventMap`.

| Event | Payload | Meaning |
| --- | --- | --- |
| `persistenceError` | `{ indexName, partitionId, error, retriesExhausted }` | A partition flush failed; `retriesExhausted` reports whether the engine gave up. |
| `durabilityError` | `{ error }` | A write-ahead log or checkpoint operation failed. |
| `workerCrash` | `{ workerId, indexNames, error }` | A worker died; the engine reassigns its indexes. |
| `workerPromote` | `{ workerCount, reason }` | The engine moved search onto the worker pool. |
| `partitionRebalance` | `{ indexName, oldCount, newCount }` | A partition reshape completed. |

```ts
narsil.on('persistenceError', payload => {
  console.error(`flush failed for ${payload.indexName}:`, payload.error)
})
```

Subscribe to `persistenceError` and `durabilityError` in any deployment that persists data; they are the engine's only channel for reporting background write failures.

## Errors

Every failure throws a `NarsilError` carrying a stable string `code`, a human-readable `message`, and a `details` object with the values that produced the failure. The full set of codes is exported as `ErrorCodes`.

```ts
import { ErrorCodes, NarsilError } from '@delali/narsil'

try {
  await narsil.insert('products', { title: 42 })
} catch (err) {
  if (err instanceof NarsilError && err.code === ErrorCodes.DOC_VALIDATION_FAILED) {
    console.error(err.message, err.details)
  }
}
```

The codes you handle most often:

| Code | Thrown when |
| --- | --- |
| `INDEX_NOT_FOUND` / `INDEX_ALREADY_EXISTS` | An operation names an unknown index, or `createIndex` reuses a name. |
| `DOC_NOT_FOUND` / `DOC_ALREADY_EXISTS` | A read, update, or removal names an unknown id, or an insert reuses one. |
| `DOC_VALIDATION_FAILED` / `DOC_MISSING_REQUIRED_FIELD` | A document does not match the schema or omits a required field. |
| `SEARCH_INVALID_FIELD` / `SEARCH_INVALID_FILTER` / `SEARCH_INVALID_CURSOR` | A query names an unknown field, passes a malformed filter, or replays a bad cursor. |
| `VECTOR_DIMENSION_MISMATCH` | A vector's length differs from the field's declared dimension. |
| `EMBEDDING_FAILED` / `EMBEDDING_CONFIG_INVALID` | An adapter call failed, or the embedding configuration is contradictory. |
| `PARTITION_CAPACITY_EXCEEDED` / `PARTITION_REBALANCING_BACKPRESSURE` | An insert passes the capacity cap, or a config change collides with a running reshape. |
| `LANGUAGE_NOT_SUPPORTED` | An index config names a language module that was never imported. |
| `CONFIG_INVALID` | A configuration value is out of range or contradictory. |

## Memory reporting

Narsil reports memory at three levels: per index, per partition, and per runtime. `getStats(indexName)` returns `estimatedMemoryBytes`, a formula-based estimate for the index's main-thread partitions and vector structures.

```ts
const indexStats = narsil.getStats('products')

console.log(indexStats.estimatedMemoryBytes)
```

The estimate comes from document counts, posting lists, field indexes, and vector indexes. It excludes V8 object headers, allocator overhead, and other host runtime costs, so use it for comparing indexes inside one process rather than for sizing host memory.

`getPartitionStats(indexName)` returns the same estimate for each partition. The partition values sum to `getStats(indexName).estimatedMemoryBytes`.

```ts
const partitions = narsil.getPartitionStats('products')

for (const partition of partitions) {
  console.log(partition.partitionId, partition.estimatedMemoryBytes)
}
```

`getMemoryStats()` returns a runtime snapshot and worker reports. It is async because workers report their heap usage through the worker message channel.

```ts
const memory = await narsil.getMemoryStats()

console.log(memory.estimatedIndexBytes)
console.log(memory.process?.heapUsed)
console.log(memory.workers)
```

`memory.estimatedIndexBytes` sums `estimatedMemoryBytes` across every index in this Narsil instance. `memory.process` comes from `process.memoryUsage()` when the runtime exposes it. It measures the whole host process, so two Narsil instances in one Node.js process report the same process numbers, and browser runtimes return `null`. `memory.workers` lists `heapUsed`, `heapTotal`, and `external` for each active worker, and the array is empty before worker promotion.

## Language support

Narsil includes language modules for tokenization, stemming (Snowball algorithm), and stop word removal.

### Full support (tokenizer + stemmer + stop words)

Arabic, Armenian, Bulgarian, Danish, Dutch, English, Finnish, French, German, Greek, Hindi, Hungarian, Indonesian, Irish, Italian, Nepali, Norwegian, Portuguese, Romanian, Russian, Sanskrit, Serbian, Slovenian, Spanish, Swahili, Swedish, Tamil, Turkish, Ukrainian

### CJK support (character n-gram tokenizer + stop words)

Chinese (Mandarin), Japanese

### African language support

Swahili has full stemmer support. Tokenization and stop word support is available for Dagbani, Ewe, Ga, Hausa, Igbo, Twi (Akan), Yoruba, and Zulu.

Each language module is a separate entry point, so you only bundle the languages your application needs. Import the module and register it before you create an index that names it:

```ts
import { createNarsil, registerLanguage } from '@delali/narsil'
import { french } from '@delali/narsil/languages/french'
import { swahili } from '@delali/narsil/languages/swahili'
import { twi } from '@delali/narsil/languages/twi'

registerLanguage(french)
registerLanguage(swahili)
registerLanguage(twi)

const narsil = await createNarsil()
await narsil.createIndex('articles', { schema: { title: 'string' }, language: 'french' })
```

English is registered by default, so it needs no import. Naming a language you have not registered fails with `LANGUAGE_NOT_SUPPORTED`. `registerLanguage(module)` also adds a language of your own: a module carries a name, a tokenizer, a stemmer, and a stop word set, and any of the built-in language modules serves as a reference.

## HTTP server

`@delali/narsil/server` wraps an engine you build in a REST API. You own the engine and its configuration (durability, embedding adapters, workers), and the server shares it across requests. The HTTP layer runs on `uWebSockets.js`, an optional peer dependency:

```bash
pnpm add -E uWebSockets.js@github:uNetworking/uWebSockets.js#v20.58.0
```

```ts
import { createNarsil } from '@delali/narsil'
import { createServer } from '@delali/narsil/server'

const engine = await createNarsil({ durability: { directory: './narsil-data' } })

const server = createServer(engine, {
  host: '127.0.0.1',
  port: 7700,
})

await server.listen()
```

`ServerOptions` also accepts `cors`, an `onRequest` hook for authentication, `limits` for body-size and concurrency caps, `embeddingAdapters` that JSON index configs reference by name, a `taskStore` that keeps long-running task status across restarts, an `instanceId` for task recovery, and `allowInsecure` for trusted private networks. The server refuses to bind a non-loopback address without an `onRequest` hook, because the admin endpoints can destroy data.

The full surface:

| Method and path | Purpose |
| --- | --- |
| `GET /livez`, `GET /readyz`, `GET /health` | The probes report liveness and readiness without authentication. |
| `GET /version` | The endpoint reports the build identity stamped at startup. |
| `GET /stats/memory` | The endpoint returns `getMemoryStats()`. |
| `POST /indexes`, `GET /indexes`, `DELETE /indexes/{name}` | The endpoints create, list, and drop indexes. |
| `GET /indexes/{name}/stats`, `GET /indexes/{name}/partitions`, `GET /indexes/{name}/count` | The endpoints report index, partition, and document-count statistics. |
| `POST /indexes/{name}/_clear` | The endpoint removes every document but keeps the index. |
| `POST /indexes/{name}/documents` | The endpoint inserts one document. |
| `GET`, `PUT`, `PATCH`, `DELETE /indexes/{name}/documents/{id}` | The endpoints read, upsert, update, and remove one document. |
| `GET /indexes/{name}/documents/{id}/_exists` | The endpoint reports whether the id exists. |
| `POST /indexes/{name}/documents/_batch` | The endpoint runs a batch insert, update, or delete with partial results. |
| `POST /indexes/{name}/documents/_multi-get` | The endpoint fetches many documents by id. |
| `POST /indexes/{name}/documents/_import` | The endpoint streams an NDJSON corpus in bounded batches. |
| `POST /indexes/{name}/search`, `POST /indexes/{name}/search/preflight`, `POST /indexes/{name}/suggest` | The endpoints run queries, match counts, and autocomplete. |
| `POST /indexes/{name}/_checkpoint`, `GET /indexes/{name}/snapshot`, `POST /indexes/{name}/restore` | The endpoints force a checkpoint, download a snapshot, and restore one. |
| `GET /indexes/{name}/vector-maintenance`, `POST /indexes/{name}/vectors/_compact`, `POST /indexes/{name}/vectors/_optimize` | The endpoints report and run vector maintenance. |
| `POST /indexes/{name}/_rebalance`, `POST /indexes/{name}/partition-config` | The endpoints reshape partitions and adjust partition caps. |
| `GET /tasks`, `GET /tasks/{id}` | The endpoints report long-running task status. |

The [HTTP server example](examples/http-server/README.md) documents every endpoint with request and response bodies, curl walkthroughs, Docker packaging, and the environment-driven configuration of a production launcher.

## Distribution

`@delali/narsil/distribution` holds the building blocks of Narsil's multi-node cluster mode: node roles, replication, coordinator adapters, and query routing. The distribution layer is under active development and highly experimental. It currently runs only in-process, its APIs change without notice, and it is not ready for production deployments. The design is specified in [`packages/spec/distribution`](../spec/distribution), and this section will grow into full documentation once the cluster mode is runnable.

## Search quality

Ranking quality is measured against the [BEIR](https://github.com/beir-cellar/beir) SciFact corpus, 5,183 documents with 300 judged queries, where a human relevance judgment scores each query-document pair. Narsil runs in one process against Orama and MiniSearch, and every engine uses identical stop words (Lucene English, 35 terms), Porter stemming, and default BM25 parameters. Narsil takes the top nDCG@10 of the three.

**What these metrics mean:**

- **nDCG@10** measures whether the most relevant documents appear near the top of the results. A score of 1.0 means perfect ranking, and 0.0 means no relevant documents appear in the top 10.
- **P@10** is the fraction of the top 10 results that are relevant.
- **MAP** tracks precision at every rank where a relevant document appears. A higher MAP means relevant documents cluster near the top of the ranking.
- **MRR** measures how soon the first relevant result appears. A higher value means the first relevant document sits closer to the top.

A separate [SciFact regression test](src/__tests__/relevance/scifact.test.ts) runs in CI on the same corpus and fails the build if ranking quality drops below calibrated thresholds.

Reproduce these scores with `pnpm --filter benchmarks bench -- --tiers relevance`. The full quality, throughput, latency, and memory tables for all three engines are in [BENCHMARKS.md](https://github.com/assetcorp/narsil/blob/main/BENCHMARKS.md).

Narsil also runs as a search server. On the BEIR information-retrieval datasets it is measured against Elasticsearch, OpenSearch, Qdrant, Weaviate, Typesense, and Meilisearch across keyword, vector, and hybrid retrieval. See [the full benchmarks](https://github.com/assetcorp/narsil/blob/main/BENCHMARKS.md) for those results.

## Runtime support

| Runtime | Concurrency | Persistence | Invalidation |
| --- | --- | --- | --- |
| Node.js | `worker_threads` | Filesystem | Adapter-based |
| Bun | `worker_threads` | Filesystem | Adapter-based |
| Deno | Web Workers | Filesystem | BroadcastChannel |
| Browser | Web Workers | IndexedDB | BroadcastChannel |

The [browser example](examples/browser/README.md) shows an embedded engine with IndexedDB persistence, and the [server app example](examples/server-app/README.md) shows a full search UI backed by the HTTP server.

## License

Apache-2.0
