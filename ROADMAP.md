# Roadmap

Narsil is defined by a language-neutral binary format, `.nrsl`, specified in [`packages/spec`](packages/spec). Any implementation that reads and writes the format is a valid Narsil. The TypeScript package is the reference implementation, and every other implementation is checked against it.

This roadmap sets out where the project is heading. It covers direction and intent, and it will change as the work proceeds. It does not commit to dates. To propose or discuss an item, open an issue.

## Available now

- **Embedded engine.** Full-text, vector, hybrid, and geosearch run inside your application process, in Node.js, Bun, Deno, or the browser.
- **Single-node server.** The same engine runs behind a REST API, with a write-ahead log, bulk NDJSON import, and snapshot and restore.
- **The `.nrsl` format.** A single binary format persists and transfers indexes, so a file written by one runtime loads in another.

## In progress

- **Cluster mode.** The multi-node mode under `@delali/narsil/distribution` provides node roles, replication, and query routing, but it runs only in-process today. The work ahead makes it deployable across separate processes and machines, fuses the write-ahead log with replication, and proves failover and recovery under load. This is a major focus for the project.

## Planned

- **Disk-backed search.** The engine answers every query from structures it holds in memory, so an index can grow no larger than the memory of the nodes that hold it. A second storage mode will search the on-disk data directly and treat memory as a cache, the way Lucene reads its segment files and Qdrant serves its memmap storage. The disk beneath a partition would then set its capacity, so a cluster could hold billions of documents. The on-disk layout is part of the portable contract, so this work starts in [`packages/spec`](packages/spec).
- **Phrase search.** A quoted query such as `"olive oil"` will match only the documents where those words appear side by side in that order, the way Elasticsearch's `match_phrase` and Meilisearch's quoted queries behave. An index created with `trackPositions` on, which is the default, already stores the term positions that phrase matching uses. The `.nrsl` format already defines how those positions persist, so phrase queries will reach such an index with no rebuild and no format change. An index created with `trackPositions` off holds no positions, so it would need a rebuild before it could answer a phrase query.
- **A second-language implementation.** A second implementation in Go or Rust will read and write the same `.nrsl` files and pass the same format tests as the reference. The choice between Go and Rust is open, and the decision will weigh runtime footprint, the concurrency model, and the ecosystem each language reaches. This is the headline item, because a second implementation proves the format is portable across languages.
- **A conformance suite for the format.** A shared set of format tests will let any implementation, in any language, check that it reads and writes `.nrsl` files identically to the reference.
- **Popular query suggestions.** Autocomplete today completes a word against the index vocabulary. Established engines instead suggest whole queries other people have searched, ranked by how often they were searched and filtered to those that returned results. The engine would count submitted queries, and a periodic build step would turn those counts into an ordinary Narsil index that you can also seed by hand, so a new deployment has something to suggest on its first day. Counting across a cluster depends on a write path that merges rather than overwrites, which cluster mode does not offer today.

## How to get involved

Read [CONTRIBUTING.md](CONTRIBUTING.md) to set up the repository, and look for issues labelled `good first issue` to make a first change. For anything that touches the `.nrsl` format, start from the specification in [`packages/spec`](packages/spec).
