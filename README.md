![Narsil, an open source search engine](https://raw.githubusercontent.com/assetcorp/narsil/main/assets/banner.png)

# Narsil

[![CI](https://github.com/assetcorp/narsil/actions/workflows/ci.yml/badge.svg)](https://github.com/assetcorp/narsil/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@delali/narsil)](https://www.npmjs.com/package/@delali/narsil)
[![downloads](https://img.shields.io/npm/dw/@delali/narsil)](https://www.npmjs.com/package/@delali/narsil)
[![types](https://img.shields.io/badge/types-TypeScript-blue)](https://www.npmjs.com/package/@delali/narsil)
[![license](https://img.shields.io/npm/l/@delali/narsil)](https://github.com/assetcorp/narsil/blob/main/LICENSE)

The search engine that scales with your data.

Narsil is an open source search engine with full-text, vector, hybrid, and geosearch on one typed index. You can embed Narsil in your application process, where the engine searches without a network hop, or deploy it as a standalone search server with a REST API, a write-ahead log, and bulk NDJSON ingest. Both forms contain the same engine, which stores indexes in one cross-language binary format (`.nrsl`), so you can load an index from one form into the other.

The engine partitions large indexes across workers and merges the results of the partitions into a single ranked list.

<!-- BENCH:headline START -->
On BEIR SciFact, Narsil's BM25 ranking scores 0.681 nDCG@10, which is within 0.002 of the Anserini reference of 0.679. Elasticsearch scores 0.679 and OpenSearch scores 0.679 on the same queries. On SciFact, Narsil answers 958 keyword queries a second at its peak, and OpenSearch follows with 878. On SciFact with every engine held at 0.99 recall, Narsil answers 259 vector queries a second at its peak, while OpenSearch leads with 730. Narsil has the highest peak throughput in 2 of the 6 keyword, vector, and hybrid comparisons in the newest recorded run, so read each figure beside its table. The harness recorded these figures in run `20260804T184221Z` on 2026-08-04, on GCP c3-standard-8, us-central1-a. You'll find every dataset, every engine's settings, and the full method in [`BENCHMARKS.md`](BENCHMARKS.md).
<!-- BENCH:headline END -->

Try it in your browser at [narsil.sondelali.com/demo](https://narsil.sondelali.com/demo). Read the full documentation at [narsil.sondelali.com/docs](https://narsil.sondelali.com/docs).

> *narsil* is the sword of Elendil in Tolkien's Lord of the Rings, shattered into shards and later reforged. The name fits the design, because the engine splits your data into partitions that it persists one by one, then merges their results into one ranked list for each query.

## Project status

Narsil comes in three parts at two levels of maturity.

| Part | Status | Details |
| --- | --- | --- |
| Embedded engine (`@delali/narsil`) | Stable | You embed the engine in your process for full-text, vector, hybrid, and geosearch. It reports failures through typed error codes. Continuous integration tests it on Node 22 and 24. |
| Single-node server (`@delali/narsil/server`) | Stable | A REST API wraps the same engine, with a write-ahead log, bulk NDJSON import, and snapshot and restore. |
| Multi-node cluster (`@delali/narsil/distribution`) | Experimental | The cluster adds node roles, replication, and query routing over an in-process transport, TCP with mTLS, or gRPC. We may change its APIs without notice. |

Every Narsil implementation must load and save the `.nrsl` binary format, which is the contract between them. This TypeScript package is the reference implementation of that format, so a second implementation in Go or Rust is the headline item on the [roadmap](ROADMAP.md).

## Packages

| Package | Description |
| --- | --- |
| [`@delali/narsil`](packages/ts) | This package holds the core search engine for full-text, vector, hybrid, and geosearch, plus an HTTP server subpath. |
| [`@delali/narsil-native-*`](packages/native) | Six platform packages hold the native search core in C, through which `@delali/narsil` searches vector graphs on macOS, Linux, and Windows. |
| [`@delali/narsil-embeddings-transformers`](packages/embeddings-transformers) | The adapter computes embeddings from local models through Hugging Face Transformers.js. |
| [`@delali/narsil-certutil`](packages/certutil) | The CLI creates certificate authorities, signs node certificates, and inspects and converts the TLS certificates that Narsil clusters use. |

## Getting started

### Embedded

Install the engine as a package to use it inside your process in Node.js, Bun, Deno, or a browser:

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

A REST API wraps the same engine. The [http-server example](packages/ts/examples/http-server) is a production launcher, which binds to 127.0.0.1 by default and takes its configuration from environment variables. It stops with an error when you bind it to a public address without authentication.

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

The [HTTP server guide](docs/http-server.md) covers every route and the embedding API, while the [example's README](packages/ts/examples/http-server/README.md) covers configuring the launcher, containerising it, and binding it safely.

Each guide under [`docs/`](docs/) covers one area with working examples. In the list of features below, each feature links to the guide that covers it.

## Features

**Search.** For [full-text search](docs/full-text-search.md#basic-queries), the engine scores with BM25 and supports field boosting, [fuzzy matching](docs/full-text-search.md#fuzzy-matching) through bounded Levenshtein distance, [search as you type](docs/full-text-search.md#search-as-you-type) through last-word prefix matching, and [term-coverage and score thresholds](docs/full-text-search.md#score-and-coverage-thresholds). You can combine a query with [filters](docs/filters-facets-and-pagination.md#filters), [facets](docs/filters-facets-and-pagination.md#facets), [sorting](docs/filters-facets-and-pagination.md#sort), [grouping](docs/filters-facets-and-pagination.md#grouping), [highlighting](docs/full-text-search.md#highlighting), [cursor pagination](docs/filters-facets-and-pagination.md#pagination), [pinned results](docs/filters-facets-and-pagination.md#pinning), and [autocomplete suggestions](docs/full-text-search.md#suggestions).

**Vector and hybrid retrieval.** For [vector search](docs/vector-search.md#vector-search), the engine compares vectors by cosine similarity, dot product, or Euclidean distance. It scans a field exactly until the field holds 1,024 vectors, a count that you can change, after which it builds an HNSW graph with optimised scalar quantization on by default. Outside a browser, on an arm64 or x64 machine under macOS, Linux, or Windows, the engine searches that graph through a [native core in C](docs/vector-search.md#native-search-core), which returns the same results as its WebAssembly search. For [hybrid search](docs/hybrid-search.md#hybrid-search), the engine fuses BM25 and vector rankings through reciprocal rank fusion or linear blending. [Embedding adapters](docs/embedding-adapters.md#embedding-adapters) turn text into vectors on insert and query, through OpenAI, local Transformers.js models, or an adapter of your own.

**Geosearch.** [Geo filters](docs/geosearch.md#geosearch) match documents by radius, using Haversine or Vincenty distance, or by polygon containment. You can combine a geo filter with every other query feature.

**Storage.** [Persistence adapters](docs/persistence-and-durability.md#persistence) store indexes on the filesystem, in IndexedDB, in memory, or in a backend of your own. With [durability](docs/persistence-and-durability.md#durability) on, the engine keeps a write-ahead log with periodic checkpoints and recovers on its own after a crash. A [snapshot](docs/persistence-and-durability.md#snapshots-and-restore) captures a whole index as one portable byte array. With [lifecycle settings](docs/persistence-and-durability.md#index-lifecycle), the engine closes idle indexes and reopens one when a caller uses it, so one engine can hold more indexes than can fit in memory. [`packages/spec`](packages/spec) specifies the `.nrsl` serialization format so that implementations in other languages can load and save the same files.

**Scale.** The engine routes each document to a [partition](docs/partitions-and-workers.md#partitions-and-rebalancing) by a deterministic hash. When you call `rebalance()`, the engine reshapes the partitions online and buffers incoming writes in a write-ahead queue. Once an index holds 1,000 documents, the engine serves keyword queries from [worker copies](docs/partitions-and-workers.md#worker-copies) on half its worker threads, while the [HTTP server receives requests on the threads that hold those copies](docs/partitions-and-workers.md#request-threads). The engine [analyses each batch once](docs/partitions-and-workers.md#how-a-batch-reaches-the-worker-copies) and passes the result to every copy. You can choose among [three scoring modes](docs/full-text-search.md#scoring-modes) for BM25 statistics that differ across partitions and instances.

**Operations.** The [HTTP server](docs/http-server.md#http-server) subpath wraps an engine in a REST API with health probes, bulk NDJSON import, snapshot and restore endpoints, and task-based long operations. The [client](docs/client.md#client) subpath calls every one of those routes from a browser or from Node under the engine's own method names. Its `waitForTask` returns once a long load finishes. The [React](docs/react.md#react) subpath exposes those methods to components as hooks, which send one request for each distinct set of arguments. For observability, you get [events](docs/observability.md#events), [typed errors](docs/errors.md#errors), [plugins](docs/observability.md#plugins), and [memory reporting](docs/observability.md#memory-reporting). [Language modules](docs/language-support.md#language-support) cover 107 languages as separate entry points, including 20 African languages.

## Examples

| Example | What it shows |
| --- | --- |
| [Live demo](https://narsil.sondelali.com/demo) | The hosted demo works entirely in the browser, so you can try search without installing anything. |
| [HTTP server](packages/ts/examples/http-server) | The launcher serves the engine as a REST service with durability, API-key auth, and Docker packaging, and every setting comes from the environment. |
| [Browser](packages/ts/examples/browser) | The app embeds the engine in a browser with IndexedDB persistence and Web Worker search. |
| [Server app](packages/ts/examples/server-app) | The app calls the HTTP server through the client SDK and the React hooks to load corpora as import tasks. In its Ask view, you can ask questions about those corpora. |

## Benchmarks

Because Narsil works both embedded and as a server, we benchmark it in two classes. We compare the server with Elasticsearch, OpenSearch, Qdrant, Weaviate, Typesense, and Meilisearch, and the embedded engine with the JavaScript libraries Orama and MiniSearch. [BENCHMARKS.md](BENCHMARKS.md) holds the full results, with charts for every track.

### Production search servers

Over HTTP on the [BEIR](https://github.com/beir-cellar/beir) SciFact and NFCorpus datasets, Narsil has the top BM25 nDCG@10 on SciFact, ahead of the Lucene engines, and the top nDCG@10, Recall@100, MAP, and MRR on NFCorpus. On the hybrid track, it has the top nDCG@10 on NFCorpus. Its BM25 nDCG@10 is within 0.006 of the published Anserini baseline on both datasets. [BENCHMARKS.md](BENCHMARKS.md) holds the keyword, vector, and hybrid numbers for all seven engines.

### In-process libraries

When we measure Narsil in one process against Orama and MiniSearch, with the same stop words and default BM25 parameters for all three, Narsil has the top nDCG@10 on BEIR SciFact, although each library stems English in its own way. It inserts text faster than both libraries at every scale that we measure. At 10,000 and 50,000 documents it also searches faster than both, although at 1,000 documents the three libraries stay within 0.004 ms of one another. Because MiniSearch has no vector search, we compare vector search against Orama alone. Narsil searches vectors faster than Orama at the same recall on SciFact and NFCorpus, although Orama inserts them faster. [BENCHMARKS.md](BENCHMARKS.md) holds the full quality, throughput, and latency tables. For the method and the steps to reproduce them, read [`benchmarks/in-process`](benchmarks/in-process).

## Documentation

| Guide | What it covers |
| --- | --- |
| [Configuration](docs/configuration.md) | Every `createNarsil` option, worker tuning, analysis rebuilds, and the tokenizer cache |
| [Indexes and documents](docs/indexes-and-documents.md) | Schemas, index management, inserts, reads, updates, removals, and batch operations |
| [Full-text search](docs/full-text-search.md) | Term queries, fuzzy matching, prefix completion, thresholds, highlighting, scoring modes, and suggestions |
| [Filters, facets, and pagination](docs/filters-facets-and-pagination.md) | Field, array, presence, and geo filters, facet counts, sorting, grouping, cursors, and pinning |
| [Vector search](docs/vector-search.md) | Vector fields, distance metrics, HNSW promotion, quantization, the native search core, and graph maintenance |
| [Hybrid search](docs/hybrid-search.md) | Reciprocal rank fusion and linear blending of text and vector rankings |
| [Geosearch](docs/geosearch.md) | Radius and polygon filters, and the two distance formulas |
| [Embedding adapters](docs/embedding-adapters.md) | Automatic embedding on insert and query, named adapters, the bundled ones, and custom ones |
| [Persistence and durability](docs/persistence-and-durability.md) | Storage backends, the write-ahead log, checkpoints, recovery, the index lifecycle, and snapshots |
| [Partitions and workers](docs/partitions-and-workers.md) | Partition routing, online rebalancing, worker copies, and multi-instance invalidation |
| [Language support](docs/language-support.md) | The 107 language modules, analysis revisions and rebuilds, and named tokenizers and stop words |
| [HTTP server](docs/http-server.md) | Wrapping an engine in a REST API, every route it serves, and long-running tasks |
| [Cluster mode](docs/cluster.md) | Multi-node indexes: nodes and roles, replication, routed writes, distributed searches and reads, and the calls that fail in a cluster |
| [Client](docs/client.md) | Reaching a server from a browser or Node, following a task, and the codes it raises |
| [React](docs/react.md) | The hooks over the client, one shared request per key, and loading a corpus from a component |
| [Observability](docs/observability.md) | Plugin hooks, engine events, and memory reporting |
| [Errors](docs/errors.md) | Every error code and what throws it |

The [specification](packages/spec/) defines the `.nrsl` format, the analysis pipeline, and the replication invariants that every implementation must uphold.

## Distribution status

The multi-node cluster mode under `@delali/narsil/distribution` is under active development and experimental. It works over an in-process transport for tests, and over TCP with mTLS or gRPC between processes. We may change its APIs without notice, so keep it out of production for now. [`packages/spec/distribution`](packages/spec/distribution) specifies the design.

## Runtime support

| Runtime | Concurrency | Persistence | Invalidation |
| --- | --- | --- | --- |
| Node.js | `worker_threads` | Filesystem | Adapter-based |
| Bun | `worker_threads` | Filesystem | Adapter-based |
| Deno | Web Workers | Filesystem | BroadcastChannel |
| Browser | Web Workers | IndexedDB | BroadcastChannel |

## License

Apache-2.0
