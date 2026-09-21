# Roadmap

Narsil is a search engine that stores its indexes in `.nrsl`, a language-neutral binary format that [`packages/spec`](packages/spec) specifies. Any implementation that reads and writes the format is a valid Narsil. The TypeScript package is the reference implementation, so the project checks every other implementation against it.

This roadmap lists the work that the project plans, and it will change as that work proceeds. It gives no dates. Open an issue to propose or discuss an item.

## Available now

- **Embedded engine.** The engine answers full-text, vector, hybrid, and geographic searches inside your application process, in Node.js, Bun, Deno, or the browser.
- **Single-node server.** A server exposes the same engine through a REST API, with a write-ahead log, bulk NDJSON import, and snapshot and restore.
- **The `.nrsl` format.** The engine persists and transfers every index in one binary format, so any runtime can load a file that another runtime writes.

## In progress

- **Cluster mode.** The multi-node mode under `@delali/narsil/distribution` provides node roles, replication, and query routing between nodes that connect over an in-process transport, TCP with mTLS, or gRPC. It is experimental, so its APIs may change without notice. The work ahead is to fuse the write-ahead log with replication and to prove failover and recovery under load. Cluster mode is the project's active focus.

## Planned

- **Keyword and hybrid search in the native search core.** An implementation in any language searches vectors through the native search core, which is one C library, but it answers a keyword query in its own code. The core will answer keyword and hybrid queries too, so that an implementation can call one search for every query. The TypeScript package will keep its own keyword, vector, and hybrid search, because a browser and a React Native app search through that code. This work comes before the second-language implementation, because that implementation would otherwise have to write keyword search again and match the reference on every query.
- **Disk-backed search.** The engine holds the keyword index, the vector graph, and the quantised codes in memory, so an index can grow no larger than the memory of the nodes that hold it. The full-precision vectors of a vector field whose `storage` is `disk` are the one structure that the engine reads from disk today. Under a later storage mode, the engine will search every structure on disk and use memory as a cache, as Lucene does with its segment files and Qdrant does with its memmap storage. A partition's capacity would then depend on its disk, so a cluster could hold more documents than its memory allows. The on-disk layout is part of the portable contract, so this work starts in [`packages/spec`](packages/spec).
- **Phrase search.** A quoted query such as `"olive oil"` will match only the documents where those words appear side by side in that order, as Elasticsearch's `match_phrase` and Meilisearch's quoted queries do. An index that you create with `trackPositions` on, which is the default, already stores the term positions that phrase matching uses. The `.nrsl` format already defines how those positions persist, so such an index will answer phrase queries with no rebuild and no format change. An index that you create with `trackPositions` off holds no positions, so you would have to rebuild it before it could answer a phrase query.
- **A second-language implementation.** A second implementation in Go or Rust will read and write the same `.nrsl` files and pass the same format tests as the reference. The choice between Go and Rust is open while the project weighs each language's runtime footprint, its concurrency model, and the ecosystem that it reaches. A second implementation would prove that the format is portable across languages.
- **A conformance suite for the format.** A shared set of format tests will let any implementation, in any language, check that it reads and writes `.nrsl` files identically to the reference.
- **Popular query suggestions.** Autocomplete today completes a word against the index vocabulary. Algolia's Query Suggestions suggests the whole queries that people search most, which it ranks by their number of searches and limits to the queries that return results. The engine would count the queries that people submit, and a periodic build step would turn those counts into an ordinary Narsil index. You could also seed that index by hand, so that a new deployment would have suggestions from its first day. Counting across a cluster needs a write path that merges concurrent counts, which cluster mode lacks today.

## How to get involved

Read [CONTRIBUTING.md](CONTRIBUTING.md) to set up the repository, and look for issues that carry the `good first issue` label to make a first change. For any change to the `.nrsl` format, start from the specification in [`packages/spec`](packages/spec).
