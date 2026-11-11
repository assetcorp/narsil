# Roadmap

Narsil is a search engine that stores its indexes in the `.nrsl` binary format. A program in any language can load and save that format, because [`packages/spec`](packages/spec) specifies its layout. Any implementation that loads and saves the format counts as a valid Narsil. The TypeScript package is the reference implementation, so the maintainers check every other implementation against it.

The maintainers update this roadmap of planned work as the work proceeds. The roadmap contains no dates, since the plans in it can change. Open an issue to propose or discuss an item.

## Available now

Pattern search, partial-word search, synonyms, reranking, BM25 parameters, phrase search, changing an index's analysis, the OpenAPI description, disk-backed search, cluster backups, the React Native driver in `@delali/narsil-react-native`, device sync, and popular query suggestions are in the `next` tag on npm, and the next stable release will include them. The Rust implementation is on crates.io as `delali-narsil`, the Python client is on PyPI as `narsil-client`, and the Go implementation and the Go client are Go modules under [`packages/go`](packages/go).

- **Embedded engine.** The engine answers full-text, vector, hybrid, and geographic searches inside your application process, in Node.js, Bun, Deno, or the browser.
- **Single-node server.** The HTTP server offers the same engine through a REST API, with a write-ahead log, bulk NDJSON import, and snapshots that you can restore.
- **The `.nrsl` format.** The engine saves every index in one binary format, so any runtime can load a file that another runtime writes.
- **Cluster mode.** The engine can operate across several nodes under `@delali/narsil/distribution`, where the cluster keeps every write that it acknowledges.
- **Pattern search.** A filter can find text inside the value of a pattern field, or test that value against a wildcard pattern or a regular expression.
- **Partial-word search.** A query word can also match inside longer words, so a search for `proof` can find `waterproof`.
- **Synonyms.** With a synonym set, a search for 'coat' can also return the documents that contain 'jacket'.
- **Reranking.** A query can reorder its top hits with a cross-encoder, through a Cohere-compatible rerank service, a local Transformers.js model, or an adapter that you write.
- **BM25 parameters.** You can set `k1` and `b` for an index, for a field, and for one search, and you can change an index's setting without a rebuild.
- **Phrase search.** You can put words in double quotes in a term, as in `"olive oil"`, so that the engine returns only the documents that hold those words side by side and in that order.
- **Changing an index's analysis.** You can give a live index a new language, stop-word set, or tokeniser, and the index keeps answering searches while the engine rebuilds its terms.
- **OpenAPI description.** The npm package holds `openapi.json`, which describes every route of the HTTP server, so that you can generate a client in any language.
- **Disk-backed search.** An index can grow larger than its node's memory, because the engine keeps part of the index in memory and reads the rest from the index's files during each search.
- **Cluster backups.** A cluster can back up an index to S3, Google Cloud Storage, or a directory, and it can restore that backup as a new index on a cluster of any size, so that you can recover an index that somebody dropped or that a bad write damaged on every replica.
- **React Native driver.** The engine answers keyword and vector searches inside an iOS or Android app, in an Expo development build or in an app without Expo, and it searches vectors through the native search core, which the app's build compiles. The driver stores the index in files on the phone, with a write-ahead log.
- **Device sync.** A phone, a laptop, or a browser tab keeps a copy of one user's index, so that the app can search it and write to it while the device is offline. The device downloads a snapshot first, then reads each later change from the server over a WebSocket, and it uploads the writes that it made offline once it can reach the server. By default the last write to arrive wins, although your backend can decide each conflict instead. The [device sync guide](docs/device-sync.md) covers the routes, the credentials, and the conflicts.
- **Popular query suggestions.** A search box can suggest whole searches, such as 'trail shoes', that enough different people ran and then followed with a click. The feature stays off until you turn it on for an index, and the engine publishes the suggestions to an ordinary Narsil index. The [query suggestions guide](docs/query-suggestions.md) covers the counting and the privacy trade-offs.
- **Python and Go clients.** A Python 3.11 or Go 1.26 program can call every route of a Narsil server, or every node of a cluster, through a typed client in [`packages/python`](packages/python) or [`packages/go`](packages/go).
- **Rust implementation.** A Rust program can create, change, and search an index inside its process, with no Node.js server, through the crate in [`packages/rust`](packages/rust). The crate saves the same `.nrsl` files as the TypeScript package and passes the conformance suite.
- **Go implementation.** A Go program can do the same through the module in [`packages/go/engine`](packages/go/engine), which calls the native search core through cgo. The module saves the same `.nrsl` files as the TypeScript package and passes the conformance suite.
- **A conformance suite for the format.** The author of an implementation in any language can check that it reads and writes `.nrsl` files with the same content as the reference, and that it answers a fixed set of searches the same way. The suite is in [`packages/conformance`](packages/conformance).
- **Every search in the native search core.** The native search core is a C library that analyses text and answers keyword, vector, and hybrid searches, so that an implementation in any language can call one library for every search and port none of the 107 language modules. In Node.js the TypeScript package searches through the core, and it falls back to WebAssembly and TypeScript where the core cannot load. Browsers search through that WebAssembly and TypeScript code. The Rust crate and the Go module compile the same core as they build.

## Planned

- **A Python package that searches inside the process.** A Python package built on the Rust implementation will let a Python program create, change, and search an index inside its process, with no separate Node.js server. The HTTP server and cluster mode will stay in the TypeScript package, so that one server can serve programs in every language. The plan is in [#173](https://github.com/assetcorp/narsil/issues/173).

## How to get involved

Read [CONTRIBUTING.md](CONTRIBUTING.md) to set up the repository, and look for issues with the `good first issue` label to make a first change. For any change to the `.nrsl` format, start from the specification in [`packages/spec`](packages/spec).
