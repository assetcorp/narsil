![Narsil, a distributed search engine](https://raw.githubusercontent.com/assetcorp/narsil/main/assets/banner.png)

# Narsil

[![CI](https://github.com/assetcorp/narsil/actions/workflows/ci.yml/badge.svg)](https://github.com/assetcorp/narsil/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@delali/narsil)](https://www.npmjs.com/package/@delali/narsil)
[![downloads](https://img.shields.io/npm/dw/@delali/narsil)](https://www.npmjs.com/package/@delali/narsil)
[![types](https://img.shields.io/badge/types-TypeScript-blue)](https://www.npmjs.com/package/@delali/narsil)
[![license](https://img.shields.io/npm/l/@delali/narsil)](https://github.com/assetcorp/narsil/blob/main/LICENSE)

Distributed search, reforged.

Narsil is a distributed search engine with full-text, vector, hybrid, and geosearch. One codebase runs in two contexts: embedded in your application process, where queries answer without a network hop, and as a standalone search server with a REST API, a write-ahead log, and bulk NDJSON ingest. Both contexts run the same engine and store indexes in the same cross-language binary format (.nrsl), so an index built in one loads in the other.

The engine partitions large indexes across workers and merges partition results into a single ranked answer. Its BM25 ranking matches the Anserini reference within 0.006 nDCG@10 on the BEIR datasets. On BEIR SciFact it takes the top nDCG@10 at 0.681, just ahead of Elasticsearch and OpenSearch at 0.679, and answers 958 keyword queries per second against their 841 and 878 ([benchmarks](BENCHMARKS.md)). The TypeScript package is the reference implementation.

Try it in your browser at [narsil.sondelali.com/demo](https://narsil.sondelali.com/demo). Read the full documentation at [narsil.sondelali.com/docs](https://narsil.sondelali.com/docs).

> *narsil* is the sword of Elendil in Tolkien's Lord of the Rings, shattered into shards and later reforged. The name maps to the architecture: data shatters into partitions, each shard is independently persisted, and every query reforges them into a unified result.

## Project status

Narsil comes in three parts at two levels of maturity.

| Part | Status | Details |
| --- | --- | --- |
| Embedded engine (`@delali/narsil`) | Stable | You embed the engine in your process for full-text, vector, hybrid, and geosearch. It reports failures through typed error codes, and its continuous integration runs the test suite on Node 22 and 24. |
| Single-node server (`@delali/narsil/server`) | Stable | The same engine runs behind a REST API, with a write-ahead log, bulk NDJSON import, and snapshot and restore. |
| Multi-node cluster (`@delali/narsil/distribution`) | Experimental | The cluster provides node roles, replication, and query routing, but it runs only in-process today and its APIs change without notice. |

The `.nrsl` binary format is the contract that every Narsil implementation reads and writes. This TypeScript package is the reference implementation that validates the format, and a second-language port in Go or Rust is the headline item on the [roadmap](ROADMAP.md).

## Packages

| Package | Description |
| --- | --- |
| [`@delali/narsil`](packages/ts) | The core search engine provides full-text, vector, hybrid, and geosearch, plus an HTTP server subpath. |
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

The [HTTP server guide](docs/http-server.md) shows the embedding API, and the [example's README](packages/ts/examples/http-server/README.md) documents every endpoint with request and response bodies.

Each guide under [`docs/`](docs/) documents one area with working examples. The highlights:

## Features

**Search.** [Full-text search](docs/full-text-search.md#basic-queries) scores with BM25 and supports field boosting, [fuzzy matching](docs/full-text-search.md#fuzzy-matching) via bounded Levenshtein distance, [search as you type](docs/full-text-search.md#search-as-you-type) through last-word prefix matching, and [term-coverage and score thresholds](docs/full-text-search.md#score-and-coverage-thresholds). Queries compose with [filters](docs/filters-facets-and-pagination.md#filters), [facets](docs/filters-facets-and-pagination.md#facets), [sorting](docs/filters-facets-and-pagination.md#sort), [grouping](docs/filters-facets-and-pagination.md#grouping), [highlighting](docs/full-text-search.md#highlighting), [cursor pagination](docs/filters-facets-and-pagination.md#pagination), [pinned results](docs/filters-facets-and-pagination.md#pinning), and [autocomplete suggestions](docs/full-text-search.md#suggestions).

**Vector and hybrid retrieval.** [Vector search](docs/vector-search.md#vector-search) serves cosine, dot-product, and Euclidean queries, starts on an exact scan, and promotes a field to an HNSW graph as it grows, with scalar quantization on by default. [Hybrid search](docs/hybrid-search.md#hybrid-search) fuses BM25 and vector rankings through reciprocal rank fusion or linear blending, and [embedding adapters](docs/embedding-adapters.md#embedding-adapters) turn text into vectors automatically on insert and query, through OpenAI, local Transformers.js models, or your own adapter.

**Geosearch.** [Geo filters](docs/geosearch.md#geosearch) match by radius (Haversine or Vincenty distance) or polygon containment, and they compose with every other query feature.

**Storage.** [Persistence adapters](docs/persistence-and-durability.md#persistence) plug in filesystem, IndexedDB, memory, or custom backends. [Durability](docs/persistence-and-durability.md#durability) adds a write-ahead log with periodic checkpoints and automatic recovery, and [snapshots](docs/persistence-and-durability.md#snapshots-and-restore) capture a whole index as one portable byte array. The `.nrsl` serialization format is specified in [`packages/spec`](packages/spec) so other language implementations read and write the same files.

**Scale.** [Partitioned indexes](docs/partitions-and-workers.md#partitions-and-rebalancing) route documents by deterministic hash and reshape online through `rebalance()`, with writes buffering in a write-ahead queue during the reshape. [Worker promotion](docs/partitions-and-workers.md#workers) moves search off the main thread once document counts cross a threshold, and [three scoring modes](docs/full-text-search.md#scoring-modes) handle BM25 statistics skew across partitions and instances.

**Operations.** The [HTTP server](docs/http-server.md#http-server) subpath wraps an engine in a REST API with health probes, bulk NDJSON import, snapshot and restore endpoints, and task-based long operations. The [client](docs/client.md#client) subpath reaches every one of those routes from a browser or from Node under the engine's own method names, and `waitForTask` follows a long load to its finish. The [React](docs/react.md#react) subpath gives those methods to components as hooks, which share one request per set of arguments. [Events](docs/observability.md#events), [typed errors](docs/errors.md#errors), [plugins](docs/observability.md#plugins), and [memory reporting](docs/observability.md#memory-reporting) cover observability, and [language modules](docs/language-support.md#language-support) cover 107 languages as separate entry points, 20 of them African.

## Examples

| Example | What it shows |
| --- | --- |
| [Live demo](https://narsil.sondelali.com/demo) | The hosted demo runs Narsil in the browser, so you can try search without installing anything. |
| [HTTP server](packages/ts/examples/http-server) | The launcher runs the engine as a REST service with durability, API-key auth, and Docker packaging, and its README documents the full API surface. |
| [Browser](packages/ts/examples/browser) | The app embeds the engine in a browser with IndexedDB persistence and Web Worker search. |
| [Server app](packages/ts/examples/server-app) | The app reaches the HTTP server through the client SDK and the React hooks, loads corpora as import tasks, and answers questions from them in an Ask view. |

## Benchmarks

Narsil is portable, so it competes in two classes. Run as a search server, it goes up against Elasticsearch, OpenSearch, Qdrant, Weaviate, Typesense, and Meilisearch. Embedded inside one process, it goes up against the JavaScript libraries Orama and MiniSearch. [BENCHMARKS.md](BENCHMARKS.md) holds the full results, with charts for every track.

### Production search servers

On the [BEIR](https://github.com/beir-cellar/beir) information-retrieval datasets, served over HTTP, Narsil's BM25 takes the top nDCG@10 on SciFact, narrowly ahead of the Lucene engines, and takes the top nDCG@10, Recall@100, MAP, and MRR on NFCorpus. On the hybrid track it takes the top nDCG@10 on NFCorpus. Its BM25 reproduces the published Anserini baseline to within 0.006 nDCG@10 on both datasets, which is the calibration that makes the comparison trustworthy. The keyword, vector, and hybrid numbers for all seven engines are in [BENCHMARKS.md](BENCHMARKS.md).

### In-process libraries

Measured in one process against Orama and MiniSearch, with the same stop words and default BM25 parameters, and with each engine stemming English its own way, Narsil takes the top nDCG@10 on the BEIR SciFact corpus. It inserts text faster than both libraries at every scale, and it returns searches faster than both as the corpus grows. On vector search, where MiniSearch has no equivalent, Narsil answers queries faster than Orama at matched recall on SciFact and NFCorpus, while Orama inserts vectors faster and holds a smaller footprint. The full quality, throughput, latency, and memory tables are in [BENCHMARKS.md](BENCHMARKS.md), and the method and reproduction steps are in [`benchmarks/in-process`](benchmarks/in-process).

## Documentation

| Guide | What it covers |
| --- | --- |
| [Configuration](docs/configuration.md) | Every `createNarsil` option, worker tuning, analysis rebuilds, and the tokenizer cache |
| [Indexes and documents](docs/indexes-and-documents.md) | Schemas, index management, inserts, reads, updates, removals, and batch operations |
| [Full-text search](docs/full-text-search.md) | Term queries, fuzzy matching, prefix completion, thresholds, highlighting, scoring modes, and suggestions |
| [Filters, facets, and pagination](docs/filters-facets-and-pagination.md) | Field, array, presence, and geo filters, facet counts, sorting, grouping, cursors, and pinning |
| [Vector search](docs/vector-search.md) | Vector fields, distance metrics, HNSW promotion, quantization, and graph maintenance |
| [Hybrid search](docs/hybrid-search.md) | Reciprocal rank fusion and linear blending of text and vector rankings |
| [Geosearch](docs/geosearch.md) | Radius and polygon filters, and the two distance formulas |
| [Embedding adapters](docs/embedding-adapters.md) | Automatic embedding on insert and query, named adapters, the bundled ones, and custom ones |
| [Persistence and durability](docs/persistence-and-durability.md) | Storage backends, the write-ahead log, checkpoints, recovery, and snapshots |
| [Partitions and workers](docs/partitions-and-workers.md) | Partition routing, online rebalancing, worker promotion, and multi-instance invalidation |
| [Language support](docs/language-support.md) | The 107 language modules, analysis revisions and rebuilds, and named tokenizers and stop words |
| [HTTP server](docs/http-server.md) | Wrapping an engine in a REST API, every route it serves, and long-running tasks |
| [Client](docs/client.md) | Reaching a server from a browser or Node, following a task, and the codes it raises |
| [React](docs/react.md) | The hooks over the client, one shared request per key, and loading a corpus from a component |
| [Observability](docs/observability.md) | Plugin hooks, engine events, and memory reporting |
| [Errors](docs/errors.md) | Every error code and what throws it |

The [specification](packages/spec/) defines the `.nrsl` format, the analysis pipeline, and the replication invariants that every implementation follows.

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
