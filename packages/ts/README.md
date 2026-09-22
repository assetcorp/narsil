![Narsil, an open source search engine](https://raw.githubusercontent.com/assetcorp/narsil/main/assets/banner.png)

# Narsil

[![CI](https://github.com/assetcorp/narsil/actions/workflows/ci.yml/badge.svg)](https://github.com/assetcorp/narsil/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@delali/narsil)](https://www.npmjs.com/package/@delali/narsil)
[![downloads](https://img.shields.io/npm/dw/@delali/narsil)](https://www.npmjs.com/package/@delali/narsil)
[![types](https://img.shields.io/badge/types-TypeScript-blue)](https://www.npmjs.com/package/@delali/narsil)
[![license](https://img.shields.io/npm/l/@delali/narsil)](https://github.com/assetcorp/narsil/blob/main/LICENSE)

The search engine that scales with your data.

Narsil is an open source search engine with full-text, vector, hybrid, and geosearch on one typed index. You can embed Narsil in your application process, where the engine searches without a network hop, or deploy it as a standalone search server with a REST API, a write-ahead log, and bulk NDJSON ingest. Both forms contain the same engine, which stores indexes in one cross-language binary format (`.nrsl`), so you can load an index from one form into the other.

The engine partitions large indexes across workers and merges the results of the partitions into a single ranked list. This TypeScript package is the reference implementation of the `.nrsl` format, so a second implementation in Go or Rust is the headline item on the [roadmap](https://github.com/assetcorp/narsil/blob/main/ROADMAP.md).

<!-- BENCH:headline START -->
On BEIR SciFact, Narsil's BM25 ranking scores 0.681 nDCG@10, which is within 0.002 of the Anserini reference of 0.679. Elasticsearch scores 0.679 and OpenSearch scores 0.679 on the same queries. On SciFact, Narsil answers 958 keyword queries a second at its peak, and OpenSearch follows with 878. On SciFact with every engine held at 0.99 recall, Narsil answers 259 vector queries a second at its peak, while OpenSearch leads with 730. Narsil has the highest peak throughput in 2 of the 6 keyword, vector, and hybrid comparisons in the newest recorded run, so read each figure beside its table. The harness recorded these figures in run `20260804T184221Z` on 2026-08-04, on GCP c3-standard-8, us-central1-a. You'll find every dataset, every engine's settings, and the full method in [`BENCHMARKS.md`](https://github.com/assetcorp/narsil/blob/main/BENCHMARKS.md).
<!-- BENCH:headline END -->

Try it in your browser at [narsil.sondelali.com/demo](https://narsil.sondelali.com/demo). Read the full documentation at [narsil.sondelali.com/docs](https://narsil.sondelali.com/docs).

> *narsil* is the sword of Elendil in Tolkien's Lord of the Rings, shattered into shards and later reforged. The name fits the design, because the engine splits your data into partitions that it persists one by one, then merges their results into one ranked list for each query.

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [Features](#features)
- [Documentation](#documentation)
- [Examples](#examples)
- [Distribution](#distribution)
- [Search quality](#search-quality)
- [Runtime support](#runtime-support)
- [License](#license)

## Install

```bash
pnpm add @delali/narsil
```

Narsil works in Node.js 22 or newer, and in Bun, Deno, and browsers. The [Runtime support](#runtime-support) table covers each runtime.

On an arm64 or x64 machine under macOS, Linux, or Windows, the package manager also installs Narsil's native search core as an optional dependency, so the engine searches vector graphs through it. If you omit optional dependencies, Narsil searches those graphs through WebAssembly, with the same results, as it always does in a browser.

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

Every hit holds the document, its id, and its BM25 score. Beside the hits, `results.count` holds the total number of matching documents, `results.elapsed` holds the query time in milliseconds, and `results.coverage` counts the partitions behind the answer, so you can tell when a cluster answers from part of its data.

## Features

**Search.** For [full-text search](https://github.com/assetcorp/narsil/blob/main/docs/full-text-search.md), the engine scores with BM25 and supports field boosting, fuzzy matching through bounded Levenshtein distance, search as you type through last-word prefix matching, and term-coverage and score thresholds. You can combine a query with [filters, facets, sorting, grouping, cursor pagination, and pinned results](https://github.com/assetcorp/narsil/blob/main/docs/filters-facets-and-pagination.md).

**Vector and hybrid retrieval.** For [vector search](https://github.com/assetcorp/narsil/blob/main/docs/vector-search.md), the engine compares vectors by cosine similarity, dot product, or Euclidean distance. It scans a field exactly until the field holds 1,024 vectors, a count that you can change, after which it builds an HNSW graph with optimised scalar quantization on by default. Outside a browser, on an arm64 or x64 machine under macOS, Linux, or Windows, the engine searches that graph through a [native core in C](https://github.com/assetcorp/narsil/blob/main/docs/vector-search.md#native-search-core), which returns the same results as its WebAssembly search. For [hybrid search](https://github.com/assetcorp/narsil/blob/main/docs/hybrid-search.md), the engine fuses BM25 and vector rankings through reciprocal rank fusion or linear blending. [Embedding adapters](https://github.com/assetcorp/narsil/blob/main/docs/embedding-adapters.md) turn text into vectors on insert and query, through OpenAI, local Transformers.js models, or an adapter of your own.

**Geosearch.** [Geo filters](https://github.com/assetcorp/narsil/blob/main/docs/geosearch.md) match documents by radius, using Haversine or Vincenty distance, or by polygon containment. You can combine a geo filter with every other query feature.

**Storage.** [Persistence adapters](https://github.com/assetcorp/narsil/blob/main/docs/persistence-and-durability.md) store indexes on the filesystem, in IndexedDB, in memory, or in a backend of your own. With durability on, the engine keeps a write-ahead log with periodic checkpoints and recovers on its own after a crash. A snapshot captures a whole index as one portable byte array.

**Scale.** The engine routes each document to a [partition](https://github.com/assetcorp/narsil/blob/main/docs/partitions-and-workers.md) by a deterministic hash. When you call `rebalance()`, the engine reshapes the partitions online and buffers incoming writes in a write-ahead queue. Once an index holds 1,000 documents, the engine serves keyword queries from worker copies on half its worker threads, while the HTTP server receives requests on the threads that hold those copies.

**Operations.** The [HTTP server](https://github.com/assetcorp/narsil/blob/main/docs/http-server.md) subpath wraps an engine in a REST API with health probes, bulk NDJSON import, snapshot and restore endpoints, and task-based long operations. The [client](https://github.com/assetcorp/narsil/blob/main/docs/client.md) subpath calls every one of those routes from a browser or from Node under the engine's own method names. The [React](https://github.com/assetcorp/narsil/blob/main/docs/react.md) subpath exposes those methods to components as hooks. For observability, you have [events, plugins, and memory reporting](https://github.com/assetcorp/narsil/blob/main/docs/observability.md). [Language modules](https://github.com/assetcorp/narsil/blob/main/docs/language-support.md) cover 107 languages as separate entry points, including 20 African languages.

## Documentation

| Guide | What it covers |
| --- | --- |
| [Configuration](https://github.com/assetcorp/narsil/blob/main/docs/configuration.md) | Every `createNarsil` option, worker tuning, analysis rebuilds, and the tokenizer cache |
| [Indexes and documents](https://github.com/assetcorp/narsil/blob/main/docs/indexes-and-documents.md) | Schemas, index management, inserts, reads, updates, removals, and batch operations |
| [Full-text search](https://github.com/assetcorp/narsil/blob/main/docs/full-text-search.md) | Term queries, fuzzy matching, prefix completion, thresholds, highlighting, scoring modes, and suggestions |
| [Filters, facets, and pagination](https://github.com/assetcorp/narsil/blob/main/docs/filters-facets-and-pagination.md) | Field, array, presence, and geo filters, facet counts, sorting, grouping, cursors, and pinning |
| [Vector search](https://github.com/assetcorp/narsil/blob/main/docs/vector-search.md) | Vector fields, distance metrics, HNSW promotion, quantization, the native search core, and graph maintenance |
| [Hybrid search](https://github.com/assetcorp/narsil/blob/main/docs/hybrid-search.md) | Reciprocal rank fusion and linear blending of text and vector rankings |
| [Geosearch](https://github.com/assetcorp/narsil/blob/main/docs/geosearch.md) | Radius and polygon filters, and the two distance formulas |
| [Embedding adapters](https://github.com/assetcorp/narsil/blob/main/docs/embedding-adapters.md) | Automatic embedding on insert and query, named adapters, the bundled ones, and custom ones |
| [Persistence and durability](https://github.com/assetcorp/narsil/blob/main/docs/persistence-and-durability.md) | Storage backends, the write-ahead log, checkpoints, recovery, and snapshots |
| [Partitions and workers](https://github.com/assetcorp/narsil/blob/main/docs/partitions-and-workers.md) | Partition routing, online rebalancing, worker copies, and multi-instance invalidation |
| [Language support](https://github.com/assetcorp/narsil/blob/main/docs/language-support.md) | The 107 language modules, analysis revisions and rebuilds, and named tokenizers and stop words |
| [HTTP server](https://github.com/assetcorp/narsil/blob/main/docs/http-server.md) | Wrapping an engine in a REST API, every route it serves, and long-running tasks |
| [Cluster mode](https://github.com/assetcorp/narsil/blob/main/docs/cluster.md) | Multi-node indexes: nodes and roles, replication, routed writes, distributed searches and reads, and the calls that fail in a cluster |
| [Client](https://github.com/assetcorp/narsil/blob/main/docs/client.md) | Reaching a server from a browser or Node, following a task, and the codes it raises |
| [React](https://github.com/assetcorp/narsil/blob/main/docs/react.md) | The hooks over the client, one shared request per key, and loading a corpus from a component |
| [Observability](https://github.com/assetcorp/narsil/blob/main/docs/observability.md) | Plugin hooks, engine events, and memory reporting |
| [Errors](https://github.com/assetcorp/narsil/blob/main/docs/errors.md) | The codes you handle most often, and the three sets that `NarsilError.code` covers |

The [specification](https://github.com/assetcorp/narsil/tree/main/packages/spec) defines the `.nrsl` format, the analysis pipeline, and the replication invariants that every implementation must uphold.

## Examples

| Example | What it shows |
| --- | --- |
| [HTTP server](https://github.com/assetcorp/narsil/blob/main/packages/ts/examples/http-server/README.md) | The launcher serves the engine as a REST service with durability, API-key auth, and Docker packaging, while every setting comes from the environment. |
| [Browser](https://github.com/assetcorp/narsil/blob/main/packages/ts/examples/browser/README.md) | The app embeds the engine in a browser with IndexedDB persistence and Web Worker search. |
| [Server app](https://github.com/assetcorp/narsil/blob/main/packages/ts/examples/server-app/README.md) | The app calls the HTTP server through the client SDK and the React hooks to load corpora as import tasks. In its Ask view, you can ask questions about those corpora. |

## Distribution

`@delali/narsil/distribution` holds Narsil's multi-node cluster mode: nodes and roles, replication, coordinator adapters for etcd and in-process testing, TCP and gRPC transports with mutual TLS, and distributed query routing. A cluster node can create, drop, clear, write, update, search, list, count, and suggest across every partition. The [cluster dashboard example](https://github.com/assetcorp/narsil/tree/main/packages/ts/examples/cluster-dashboard) starts three nodes against etcd and shows the state of each partition while you cut the network links. Because the layer is experimental and we may change its APIs without notice, pin an exact version before you depend on it. The [cluster guide](https://github.com/assetcorp/narsil/blob/main/docs/cluster.md) covers the API, including the packages that the etcd coordinator and the gRPC transport each need. For the contract that every implementation must uphold, read [`packages/spec/distribution`](https://github.com/assetcorp/narsil/tree/main/packages/spec/distribution).

## Search quality

We measure ranking quality on the [BEIR](https://github.com/beir-cellar/beir) SciFact corpus, which holds 5,183 documents and 300 queries with human relevance judgements. We compare Narsil with Orama and MiniSearch in one process. All three use the same 33 Lucene English stop words and default BM25 parameters, although each one stems English in its own way. Narsil has the top nDCG@10 of the three.

**What these metrics mean:**

- **nDCG@10** measures whether the most relevant documents appear near the top of the results. A score of 1.0 means a perfect ranking, while 0.0 means that no relevant document appears in the top 10.
- **P@10** is the fraction of the top 10 results that are relevant.
- **MAP** tracks precision at every rank where a relevant document appears. A higher MAP means that relevant documents cluster near the top of the ranking.
- **MRR** measures how soon the first relevant result appears. A higher MRR means that the first relevant document appears nearer the top.

Continuous integration executes a separate [SciFact regression test](https://github.com/assetcorp/narsil/blob/main/packages/ts/src/__tests__/relevance/scifact.test.ts) on the same corpus. That test fails the build when ranking quality drops below calibrated thresholds.

Reproduce these scores with `pnpm --filter benchmarks bench -- --tiers relevance`. [BENCHMARKS.md](https://github.com/assetcorp/narsil/blob/main/BENCHMARKS.md) holds the full quality, throughput, and latency tables for all three engines.

Narsil also works as a search server. On the BEIR datasets, we compare the server with Elasticsearch, OpenSearch, Qdrant, Weaviate, Typesense, and Meilisearch across keyword, vector, and hybrid retrieval. See [the full benchmarks](https://github.com/assetcorp/narsil/blob/main/BENCHMARKS.md) for those results.

## Runtime support

| Runtime | Concurrency | Persistence | Invalidation |
| --- | --- | --- | --- |
| Node.js | `worker_threads` | Filesystem | Adapter-based |
| Bun | `worker_threads` | Filesystem | Adapter-based |
| Deno | Web Workers | Filesystem | BroadcastChannel |
| Browser | Web Workers | IndexedDB | BroadcastChannel |

The [browser example](https://github.com/assetcorp/narsil/blob/main/packages/ts/examples/browser/README.md) shows an embedded engine with IndexedDB persistence, while the [server app example](https://github.com/assetcorp/narsil/blob/main/packages/ts/examples/server-app/README.md) shows the same interface over the client SDK and the React hooks.

## License

Apache-2.0
