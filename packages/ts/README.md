![Narsil, a distributed search engine](https://raw.githubusercontent.com/assetcorp/narsil/main/assets/banner.png)

# Narsil

[![CI](https://github.com/assetcorp/narsil/actions/workflows/ci.yml/badge.svg)](https://github.com/assetcorp/narsil/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@delali/narsil)](https://www.npmjs.com/package/@delali/narsil)
[![downloads](https://img.shields.io/npm/dw/@delali/narsil)](https://www.npmjs.com/package/@delali/narsil)
[![types](https://img.shields.io/badge/types-TypeScript-blue)](https://www.npmjs.com/package/@delali/narsil)
[![license](https://img.shields.io/npm/l/@delali/narsil)](https://github.com/assetcorp/narsil/blob/main/LICENSE)

Distributed search, reforged.

Narsil is a distributed search engine with full-text, vector, hybrid, and geosearch. One codebase runs in two contexts: embedded in your application process, where queries answer without a network hop, and as a standalone search server with a REST API, a write-ahead log, and bulk NDJSON ingest. Both contexts run the same engine and store indexes in the same cross-language binary format (.nrsl), so an index built in one loads in the other.

The engine partitions large indexes across workers and merges partition results into a single ranked answer. Its BM25 ranking matches the Anserini reference within 0.006 nDCG@10 on the BEIR datasets. On BEIR SciFact it takes the top nDCG@10 at 0.681, narrowly ahead of Elasticsearch and OpenSearch at 0.679, and answers 958 keyword queries per second against their 841 and 878 ([benchmarks](https://github.com/assetcorp/narsil/blob/main/BENCHMARKS.md)). This TypeScript package is the reference implementation of the cross-language `.nrsl` format, and a second-language port in Go or Rust is the headline item on the [roadmap](https://github.com/assetcorp/narsil/blob/main/ROADMAP.md).

Try it in your browser at [narsil.sondelali.com/demo](https://narsil.sondelali.com/demo). Read the full documentation at [narsil.sondelali.com/docs](https://narsil.sondelali.com/docs).

> *narsil* is the sword of Elendil in Tolkien's Lord of the Rings, shattered into shards and later reforged. The name maps to the architecture: data shatters into partitions, the engine persists each shard on its own, and every query reforges them into one ranked answer.

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

Every hit holds the document, its id, and its BM25 score. `results.count` reports how many documents matched in total, `results.elapsed` reports the query time in milliseconds, and `results.coverage` reports how many partitions the search read, which is how you spot a cluster that answered from part of its data.

## Features

**Search.** [Full-text search](https://github.com/assetcorp/narsil/blob/main/docs/full-text-search.md) scores with BM25 and supports field boosting, fuzzy matching through bounded Levenshtein distance, search as you type through last-word prefix matching, and term-coverage and score thresholds. Queries compose with [filters, facets, sorting, grouping, cursor pagination, and pinned results](https://github.com/assetcorp/narsil/blob/main/docs/filters-facets-and-pagination.md).

**Vector and hybrid retrieval.** [Vector search](https://github.com/assetcorp/narsil/blob/main/docs/vector-search.md) serves cosine, dot-product, and Euclidean queries, starts on an exact scan, and promotes a field to an HNSW graph as it grows, with scalar quantization on by default. [Hybrid search](https://github.com/assetcorp/narsil/blob/main/docs/hybrid-search.md) fuses BM25 and vector rankings through reciprocal rank fusion or linear blending, and [embedding adapters](https://github.com/assetcorp/narsil/blob/main/docs/embedding-adapters.md) turn text into vectors on insert and query, through OpenAI, local Transformers.js models, or an adapter of your own.

**Geosearch.** [Geo filters](https://github.com/assetcorp/narsil/blob/main/docs/geosearch.md) match by radius, using Haversine or Vincenty distance, or by polygon containment, and they compose with every other query feature.

**Storage.** [Persistence adapters](https://github.com/assetcorp/narsil/blob/main/docs/persistence-and-durability.md) plug in filesystem, IndexedDB, memory, or custom backends. Durability adds a write-ahead log with periodic checkpoints and automatic recovery, and snapshots capture a whole index as one portable byte array.

**Scale.** [Partitioned indexes](https://github.com/assetcorp/narsil/blob/main/docs/partitions-and-workers.md) route documents by deterministic hash and reshape online through `rebalance()`, with writes buffering in a write-ahead queue during the reshape. Worker copies answer keyword queries on every core once an index holds 1,000 documents.

**Operations.** The [HTTP server](https://github.com/assetcorp/narsil/blob/main/docs/http-server.md) subpath wraps an engine in a REST API with health probes, bulk NDJSON import, snapshot and restore endpoints, and task-based long operations. The [client](https://github.com/assetcorp/narsil/blob/main/docs/client.md) subpath reaches every one of those routes from a browser or from Node under the engine's own method names, and the [React](https://github.com/assetcorp/narsil/blob/main/docs/react.md) subpath gives those methods to components as hooks. [Events, plugins, and memory reporting](https://github.com/assetcorp/narsil/blob/main/docs/observability.md) cover observability, and [language modules](https://github.com/assetcorp/narsil/blob/main/docs/language-support.md) cover 107 languages as separate entry points, 20 of them African.

## Documentation

| Guide | What it covers |
| --- | --- |
| [Configuration](../../docs/configuration.md) | Every `createNarsil` option, worker tuning, analysis rebuilds, and the tokenizer cache |
| [Indexes and documents](../../docs/indexes-and-documents.md) | Schemas, index management, inserts, reads, updates, removals, and batch operations |
| [Full-text search](../../docs/full-text-search.md) | Term queries, fuzzy matching, prefix completion, thresholds, highlighting, scoring modes, and suggestions |
| [Filters, facets, and pagination](../../docs/filters-facets-and-pagination.md) | Field, array, presence, and geo filters, facet counts, sorting, grouping, cursors, and pinning |
| [Vector search](../../docs/vector-search.md) | Vector fields, distance metrics, HNSW promotion, quantization, and graph maintenance |
| [Hybrid search](../../docs/hybrid-search.md) | Reciprocal rank fusion and linear blending of text and vector rankings |
| [Geosearch](../../docs/geosearch.md) | Radius and polygon filters, and the two distance formulas |
| [Embedding adapters](../../docs/embedding-adapters.md) | Automatic embedding on insert and query, named adapters, the bundled ones, and custom ones |
| [Persistence and durability](../../docs/persistence-and-durability.md) | Storage backends, the write-ahead log, checkpoints, recovery, and snapshots |
| [Partitions and workers](../../docs/partitions-and-workers.md) | Partition routing, online rebalancing, worker copies, and multi-instance invalidation |
| [Language support](../../docs/language-support.md) | The 107 language modules, analysis revisions and rebuilds, and named tokenizers and stop words |
| [HTTP server](../../docs/http-server.md) | Wrapping an engine in a REST API, every route it serves, and long-running tasks |
| [Cluster mode](../../docs/cluster.md) | Multi-node indexes: nodes and roles, replication, routed writes, distributed searches and reads, and what a cluster refuses |
| [Client](../../docs/client.md) | Reaching a server from a browser or Node, following a task, and the codes it raises |
| [React](../../docs/react.md) | The hooks over the client, one shared request per key, and loading a corpus from a component |
| [Observability](../../docs/observability.md) | Plugin hooks, engine events, and memory reporting |
| [Errors](../../docs/errors.md) | Every error code and what throws it |

The [specification](../spec/) defines the `.nrsl` format, the analysis pipeline, and the replication invariants that every implementation follows.

## Examples

| Example | What it shows |
| --- | --- |
| [HTTP server](examples/http-server/README.md) | The launcher runs the engine as a REST service with durability, API-key auth, and Docker packaging, and its README documents the full API surface. |
| [Browser](examples/browser/README.md) | The app embeds the engine in a browser with IndexedDB persistence and Web Worker search. |
| [Server app](examples/server-app/README.md) | The app reaches the HTTP server through the client SDK and the React hooks, loads corpora as import tasks, and answers questions from them in an Ask view. |

## Distribution

`@delali/narsil/distribution` holds Narsil's multi-node cluster mode: nodes and roles, replication, coordinator adapters for etcd and in-process testing, TCP and gRPC transports with mutual TLS, and distributed query routing. A cluster node creates, drops, clears, writes, updates, searches, lists, counts, and suggests across every partition, and the [cluster dashboard example](examples/cluster-dashboard) runs three nodes against etcd and shows what each partition does while you cut the links between them. The layer is experimental and its APIs change without notice, so pin an exact version before you depend on it. The [cluster guide](../../docs/cluster.md) covers the surface, and [`packages/spec/distribution`](../spec/distribution) specifies the contract every implementation follows.

## Search quality

Ranking quality is measured against the [BEIR](https://github.com/beir-cellar/beir) SciFact corpus, 5,183 documents with 300 judged queries, where a human relevance judgment scores each query-document pair. Narsil runs in one process against Orama and MiniSearch, and every engine uses identical stop words (Lucene English, 33 terms) and default BM25 parameters, while each one stems English with its own implementation. Narsil takes the top nDCG@10 of the three.

**What these metrics mean:**

- **nDCG@10** measures whether the most relevant documents appear near the top of the results. A score of 1.0 means perfect ranking, and 0.0 means no relevant documents appear in the top 10.
- **P@10** is the fraction of the top 10 results that are relevant.
- **MAP** tracks precision at every rank where a relevant document appears. A higher MAP means relevant documents cluster near the top of the ranking.
- **MRR** measures how soon the first relevant result appears. A higher value puts the first relevant document nearer the top.

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

The [browser example](examples/browser/README.md) shows an embedded engine with IndexedDB persistence, and the [server app example](examples/server-app/README.md) shows the same UI over the client SDK and the React hooks.

## License

Apache-2.0
