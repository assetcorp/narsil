# Roadmap

Narsil is a search engine that stores its indexes in the `.nrsl` binary format. A program in any language can load and save that format, because [`packages/spec`](packages/spec) specifies its layout. Any implementation that loads and saves the format counts as a valid Narsil. The TypeScript package is the reference implementation, so the maintainers check every other implementation against it.

The maintainers update this roadmap of planned work as the work proceeds. The roadmap contains no dates, since the plans in it can change. Open an issue to propose or discuss an item.

## Available now

Pattern search, partial-word search, synonyms, reranking, BM25 parameters, phrase search, changing an index's analysis, the OpenAPI description, disk-backed search, and cluster backups are in the `next` tag on npm, and the next stable release will include them. The React Native driver is in the repository, and its package, `@delali/narsil-react-native`, isn't on npm yet.

- **Embedded engine.** The engine answers full-text, vector, hybrid, and geographic searches inside your application process, in Node.js, Bun, Deno, or the browser.
- **Single-node server.** The HTTP server offers the same engine through a REST API, with a write-ahead log, bulk NDJSON import, and snapshots that you can restore.
- **The `.nrsl` format.** The engine saves every index in one binary format, so any runtime can load a file that another runtime writes.
- **Cluster mode.** The engine can operate across several nodes under `@delali/narsil/distribution`, where the cluster keeps every write that it acknowledges.
- **Pattern search.** A filter can find text inside the value of a pattern field, or test that value against a wildcard pattern or a regular expression.
- **Partial-word search.** A query word can also match inside longer words, so a search for `proof` can find `waterproof`.
- **Synonyms.** With a synonym set, a search for 'coat' can also return the documents that contain 'jacket'.
- **Reranking.** A query can reorder its top hits with a cross-encoder, through a Cohere-compatible rerank service, a local Transformers.js model, or an adapter of your own.
- **BM25 parameters.** You can set `k1` and `b` for an index, for a field, and for one search, and you can change an index's setting without a rebuild.
- **Phrase search.** You can put words in double quotes in a term, as in `"olive oil"`, so that the engine returns only the documents that hold those words side by side and in that order.
- **Changing an index's analysis.** You can give a live index a new language, stop-word set, or tokeniser, and the index keeps answering searches while the engine rebuilds its terms.
- **OpenAPI description.** The npm package holds `openapi.json`, which describes every route of the HTTP server, so that you can generate a client in any language.
- **Disk-backed search.** An index can grow larger than its node's memory, because the engine keeps part of the index in memory and reads the rest from the index's files during each search.
- **Cluster backups.** A cluster can back up an index to S3, Google Cloud Storage, or a directory, and it can restore that backup as a new index on a cluster of any size, so that you can recover an index that somebody dropped or that a bad write damaged on every replica.
- **React Native driver.** The engine answers keyword and vector searches inside an iOS or Android app, in an Expo development build or in an app without Expo, and it searches vectors through the native search core, which the app's build compiles. The driver stores the index in files on the phone, with a write-ahead log.

## Planned

The maintainers will build these items in the order of this list.

1. **Two-way device sync.** An app will be able to search and change an index on a device with no signal. Sync is for an index that belongs to one user, because a device receives the whole index, so a developer must leave it off for a public or shared index. A device will load a snapshot of the index first. After that, the server will send the device each document change that follows the device's saved position, with the document's vectors, over a WebSocket, while the device will send its own changes to the server. The developer decides what an index holds and who can read or write it. By default, the last write to arrive will win, although a developer can send a device's writes through their own backend so that the backend decides conflicts. When a device falls too far behind the server, it will load a fresh snapshot, as a device does under Sirannon's device sync. The maintainers will build device sync on the React Native driver and on cluster backups. The plan is in [#151](https://github.com/assetcorp/narsil/issues/151).
2. **Python and Go clients.** The only published client today is in TypeScript, so a Python or Go program has to write its own HTTP requests to reach a Narsil server. Each new client will offer the same operations as the TypeScript client. The plan is in [#152](https://github.com/assetcorp/narsil/issues/152).
3. **Popular query suggestions.** Today the engine's autocomplete suggests single words from the index's vocabulary. [Algolia's Query Suggestions](https://www.algolia.com/doc/guides/building-search-ui/ui-and-ux-patterns/query-suggestions) suggests whole queries, which it ranks by the number of times that people searched for them in the last 30 days, and it drops any query with fewer results than a minimum that you set. For any index where a developer turns this on, the engine will count the searches that lead to a click, and on a schedule, a build step will publish each phrase that at least four people searched for to an ordinary Narsil index. You will also be able to fill that index by hand so that your users see suggestions from the first day of a new deployment. In a cluster, each node will keep its own counts, and the node that builds the suggestions will read them from the other nodes. The plan is in [#164](https://github.com/assetcorp/narsil/issues/164).
4. **A conformance suite for the format.** With a shared set of format tests, the authors of any implementation will be able to check that it loads and saves `.nrsl` files with the same content as the reference, and that it answers the same searches. The plan is in [#167](https://github.com/assetcorp/narsil/issues/167).
5. **Text analysis, keyword search, and hybrid search in the native search core.** The native search core is a C library. Today an implementation in any language searches vectors through that library, but it analyses text and answers keyword queries in code written in that language. The core will analyse text and answer keyword and hybrid queries too, so that an implementation can call one library for every search and port none of the 107 language modules. The TypeScript package will keep a TypeScript copy of text analysis and of keyword, vector, and hybrid search, because browsers search through that code, while React Native apps will search through the core. The maintainers will build this item before the Rust and Go implementations, since without it the authors of each implementation will have to write text analysis and keyword search again and match the reference on every query. The plan is in [#168](https://github.com/assetcorp/narsil/issues/168).
6. **Rust and Go implementations.** An implementation in Rust, and after it one in Go, will load and save the same `.nrsl` files and pass the same format tests as the reference. Each will call the native search core for text analysis and for every search, so that a Rust or Go program can search inside its process with no separate Node.js server.

## How to get involved

Read [CONTRIBUTING.md](CONTRIBUTING.md) to set up the repository, and look for issues with the `good first issue` label to make a first change. For any change to the `.nrsl` format, start from the specification in [`packages/spec`](packages/spec).
