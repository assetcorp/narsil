![Narsil, a distributed search engine](https://raw.githubusercontent.com/assetcorp/narsil/main/assets/banner.png)

# Narsil

[![CI](https://github.com/assetcorp/narsil/actions/workflows/ci.yml/badge.svg)](https://github.com/assetcorp/narsil/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@delali/narsil)](https://www.npmjs.com/package/@delali/narsil)
[![downloads](https://img.shields.io/npm/dw/@delali/narsil)](https://www.npmjs.com/package/@delali/narsil)
[![types](https://img.shields.io/badge/types-TypeScript-blue)](https://www.npmjs.com/package/@delali/narsil)
[![license](https://img.shields.io/npm/l/@delali/narsil)](https://github.com/assetcorp/narsil/blob/main/LICENSE)

Distributed search, reforged.

Narsil is a distributed search engine with full-text, vector, hybrid, and geosearch. One codebase runs in two contexts: embedded in your application process, where queries answer without a network hop, and as a standalone search server with a REST API, a write-ahead log, and bulk NDJSON ingest. Both contexts run the same engine and store indexes in the same cross-language binary format (.nrsl), so an index built in one loads in the other.

The engine partitions large indexes across workers and merges partition results into a single ranked answer. Its BM25 ranking matches the Anserini reference within 0.005 nDCG@10 on the BEIR datasets, and one node answers 1,020 keyword queries per second on BEIR SciFact ([benchmarks](BENCHMARKS.md)). The TypeScript package is the first implementation.

> *narsil* is the sword of Elendil in Tolkien's Lord of the Rings, shattered into shards and later reforged. The name maps to the architecture: data shatters into partitions, each shard is independently persisted, and every query reforges them into a unified result.

## Packages

| Package | Description |
| --- | --- |
| [`@delali/narsil`](packages/ts) | The core search engine ships full-text, vector, hybrid, and geosearch, plus an HTTP server subpath. |
| [`@delali/narsil-embeddings-transformers`](packages/embeddings-transformers) | The adapter runs local embedding models through Hugging Face Transformers.js. |
| [`@delali/narsil-certutil`](packages/certutil) | The CLI generates and manages the TLS certificates Narsil clusters use, covering CA creation, node certificate signing, inspection, and format conversion. |

## Getting started

### Embedded

The engine installs as a package and runs inside your process, in Node.js, Bun, Deno, or a browser.

```bash
pnpm add @delali/narsil
```

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

### As a server

The same engine runs behind a REST API. The [http-server example](packages/ts/examples/http-server) is a production launcher: it binds to localhost by default, refuses a public bind without authentication, and reads its configuration from environment variables.

```bash
pnpm --filter @delali/narsil build
node --experimental-strip-types packages/ts/examples/http-server/server.ts
```

```bash
curl -X POST localhost:7700/indexes \
  -H 'content-type: application/json' \
  -d '{"name":"products","config":{"schema":{"title":"string","price":"number"}}}'
curl -X POST localhost:7700/indexes/products/documents \
  -H 'content-type: application/json' \
  -d '{"document":{"id":"p1","title":"Mechanical Keyboard","price":129.99}}'
curl -X POST localhost:7700/indexes/products/search \
  -H 'content-type: application/json' \
  -d '{"term":"keyboard"}'
```

The [HTTP server section](packages/ts/README.md#http-server) of the package README shows the embedding API, and the [example's README](packages/ts/examples/http-server/README.md) documents every endpoint with request and response bodies.

The [TypeScript package README](packages/ts/README.md) documents every feature with a working example. The highlights, each linked to its section:

## Features

**Search.** [Full-text search](packages/ts/README.md#full-text-search) scores with BM25 and supports field boosting, [fuzzy matching](packages/ts/README.md#fuzzy-matching) via bounded Levenshtein distance, and [term-coverage and score thresholds](packages/ts/README.md#score-and-coverage-thresholds). Queries compose with [filters](packages/ts/README.md#filters), [facets](packages/ts/README.md#facets), [sorting](packages/ts/README.md#sort), [grouping](packages/ts/README.md#grouping), [highlighting](packages/ts/README.md#highlighting), [cursor pagination](packages/ts/README.md#pagination), [pinned results](packages/ts/README.md#pinning), and [autocomplete suggestions](packages/ts/README.md#suggestions).

**Vector and hybrid retrieval.** [Vector search](packages/ts/README.md#vector-search) serves cosine, dot-product, and Euclidean queries, starts on an exact scan, and promotes a field to an HNSW graph as it grows, with scalar quantization on by default. [Hybrid search](packages/ts/README.md#hybrid-search) fuses BM25 and vector rankings through reciprocal rank fusion or linear blending, and [embedding adapters](packages/ts/README.md#embedding-adapters) turn text into vectors automatically on insert and query, through OpenAI, local Transformers.js models, or your own adapter.

**Geosearch.** [Geo filters](packages/ts/README.md#geosearch) match by radius (Haversine or Vincenty distance) or polygon containment, and they compose with every other query feature.

**Storage.** [Persistence adapters](packages/ts/README.md#persistence) plug in filesystem, IndexedDB, memory, or custom backends. [Durability](packages/ts/README.md#durability) adds a write-ahead log with periodic checkpoints and automatic recovery, and [snapshots](packages/ts/README.md#snapshots-and-restore) capture a whole index as one portable byte array. The `.nrsl` serialization format is specified in [`packages/spec`](packages/spec) so other language implementations read and write the same files.

**Scale.** [Partitioned indexes](packages/ts/README.md#partitions-and-rebalancing) route documents by deterministic hash and reshape online through `rebalance()`, with writes buffering in a write-ahead queue during the reshape. [Worker promotion](packages/ts/README.md#workers) moves search off the main thread once document counts cross a threshold, and [three scoring modes](packages/ts/README.md#scoring-modes) handle BM25 statistics skew across partitions and instances.

**Operations.** The [HTTP server](packages/ts/README.md#http-server) subpath wraps an engine in a REST API with health probes, bulk NDJSON import, snapshot and restore endpoints, and task-based long operations. [Events](packages/ts/README.md#events), [typed errors](packages/ts/README.md#errors), [plugins](packages/ts/README.md#plugins), and [memory reporting](packages/ts/README.md#memory-reporting) cover observability, and [language modules](packages/ts/README.md#language-support) ship for 39 languages as separate entry points.

## Examples

| Example | What it shows |
| --- | --- |
| [HTTP server](packages/ts/examples/http-server) | The launcher runs the engine as a REST service with durability, API-key auth, and Docker packaging, and its README documents the full API surface. |
| [Browser](packages/ts/examples/browser) | The app embeds the engine in a browser with IndexedDB persistence and Web Worker search. |
| [Server app](packages/ts/examples/server-app) | The app pairs a search UI with the HTTP server, including dataset loading and an embedding-backed Ask view. |

## Benchmarks

Narsil is portable, so it competes in two classes. Run as a search server, it goes up against Elasticsearch, OpenSearch, Qdrant, Weaviate, Typesense, and Meilisearch. Embedded inside one process, it goes up against the JavaScript libraries Orama and MiniSearch. [BENCHMARKS.md](BENCHMARKS.md) holds the full results, with charts for every track.

### Production search servers

On the [BEIR](https://github.com/beir-cellar/beir) information-retrieval datasets, served over HTTP, Narsil's BM25 ranks level with the Lucene engines on SciFact and takes the top nDCG@10, Recall@100, MAP, and MRR on NFCorpus. On the hybrid track it takes the top nDCG@10 on NFCorpus. Its BM25 reproduces the published Anserini baseline to within 0.005 nDCG@10 on both datasets, which is the calibration that makes the comparison trustworthy. The keyword, vector, and hybrid numbers for all six engines are in [BENCHMARKS.md](BENCHMARKS.md).

### In-process libraries

Measured in one process against Orama and MiniSearch, with the same stop words, the same Porter stemmer, and default BM25 parameters, Narsil takes the top nDCG@10 on the BEIR SciFact corpus. It inserts text faster than both libraries at every scale, and it returns searches faster than both as the corpus grows. On vector search, where MiniSearch has no equivalent, Narsil answers queries faster than Orama at matched recall on SciFact and NFCorpus, while Orama inserts vectors faster and holds a smaller footprint. The full quality, throughput, latency, and memory tables are in [BENCHMARKS.md](BENCHMARKS.md), and the method and reproduction steps are in [`benchmarks/in-process`](benchmarks/in-process).

## Configuration

The [TypeScript package README](packages/ts/README.md#configuration) documents `NarsilConfig`, worker and flush tuning, durability settings, and the tokenizer cache.

## Distribution status

The multi-node cluster mode under `@delali/narsil/distribution` is under active development and highly experimental. It runs only in-process today, and its APIs change without notice. The design is specified in [`packages/spec/distribution`](packages/spec/distribution).

## Runtime support

| Runtime | Concurrency | Persistence | Invalidation |
| --- | --- | --- | --- |
| Node.js | `worker_threads` | Filesystem | Adapter-based |
| Bun | `worker_threads` | Filesystem | Adapter-based |
| Deno | Web Workers | Filesystem | BroadcastChannel |
| Browser | Web Workers | IndexedDB | BroadcastChannel |

## License

Apache-2.0
