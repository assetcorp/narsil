---
name: narsil
description: Adds search to an app with Narsil, either embedded in the app's process from TypeScript, Rust, Python, or Go, or served over HTTP from the TypeScript or Rust server to an app in any language. Covers full-text and typo-tolerant search, filters and facet counts, sorting and pagination, semantic and hybrid search through embedding adapters, answers that cite their sources, geosearch, search that keeps working offline in a browser, persistence and snapshots, and the multi-node cluster. Use when the user wants to add search, a search engine, a search bar, autocomplete, faceted filtering, semantic or vector search, or retrieval for an AI assistant to an app, and has not chosen another search engine. Also use when the user mentions Narsil, @delali/narsil, the delali-narsil crate or Python package, or the github.com/assetcorp/narsil Go modules, asks to add search through narsil.sondelali.com, or works in a project that already depends on one of them.
license: Apache-2.0
---

# Narsil

Narsil is one search engine with a package for each of four languages. Every package follows the same specification, reads and writes the same `.nrsl` index files, and raises the same error codes, so an index that one package saves opens in any other. Settings, queries, and results carry the same field names in every package and over HTTP, spelled in each language's style.

Copy this checklist and tick each item as you finish it:

```text skip
- [ ] 1. Choose the package
- [ ] 2. Read the language reference
- [ ] 3. Build what the user asked for
- [ ] 4. Verify and report
```

## 1. Choose the package

Embed Narsil when one process writes and searches the index, as a browser page does when it keeps an index for itself. Serve it when several services share one index, when an index has to outlive the app's deploys, or when the app's language has no Narsil package, and have each app call the server over HTTP.

| Language | Embed the engine | Call a server | Read |
| --- | --- | --- | --- |
| JavaScript or TypeScript | `@delali/narsil` | `@delali/narsil/client` | [references/typescript.md](references/typescript.md) |
| Rust | the `delali-narsil` crate | JSON over HTTP | [references/rust.md](references/rust.md) |
| Python | the `delali-narsil` package | the `narsil-client` package | [references/python.md](references/python.md) |
| Go | the `github.com/assetcorp/narsil/packages/go/engine` module | the `github.com/assetcorp/narsil/packages/go` module | [references/go.md](references/go.md) |
| Any other | none | JSON over HTTP | [references/server.md](references/server.md) |

To serve, start the image `ghcr.io/assetcorp/narsil`, which holds the TypeScript server, or its tags that end in `-rust`, which hold the Rust server. Both read the same settings and answer the same routes, and each image serves one node outside any cluster. Read [references/server.md](references/server.md) before you choose.

## 2. Read the language reference

Read the reference file that the table names for the project's language. It says how to find the installed version and its API, how to install the package, and what that package does differently. Take every name and option from the installed package's own types or documentation, because each one lists its defaults and its error codes.

## 3. Build what the user asked for

Open one engine per process and keep it for the life of the process. Give each field of an index's schema one of the types `string`, `verbatim`, `number`, `boolean`, `enum`, `geopoint`, or `vector[N]`, or a list form such as `string[]`, because the engine filters, sorts, and counts each field by its type. Add the options `sortable`, `pattern`, and `partial` to a `string` or `string[]` type, each after a colon, as in `string:sortable`, or add `sortable` alone to a `verbatim` or `verbatim[]` type. Declare a file path, a URL, or an order code as `verbatim`, because the engine keeps that value whole and leaves it out of keyword search.

Read the reference file for each capability that the task needs. Each one shows the TypeScript API, and the same fields apply in every package and in the JSON that the server takes:

| When the task needs | Read |
| --- | --- |
| Keyword search, typo tolerance, search as you type, filters, facet counts, sorting, grouping, pagination, highlighting, or geosearch | [references/search.md](references/search.md) |
| Search by meaning, hybrid search, an embedding adapter, or answers that cite their sources | [references/vectors.md](references/vectors.md) |
| Search inside a browser page that keeps working offline | [references/browser.md](references/browser.md) |
| An index that survives a restart, a snapshot, or closing idle indexes | [references/storage.md](references/storage.md) |
| A server, a client, React hooks, or moving an embedded index behind a server | [references/server.md](references/server.md) |
| Several nodes, replication, or failover | [references/cluster.md](references/cluster.md) |

Turn device sync on only for an index whose documents all belong to one user, because every device that syncs an index receives the whole index.

## 4. Verify and report

1. Type-check or compile the code against the installed package.
2. Execute it once, and confirm that a document that you insert comes back from a query that should match it.
3. Fix whatever fails and repeat both checks until they pass.
4. Report what you added, each check with its result, every experimental part in use, and every check that you could not perform.

## Gotchas

- With durability or persistence, the engine recovers every saved index when it opens, so creating an index under a saved name fails with `INDEX_ALREADY_EXISTS` after a restart. List the indexes first.
- Shut the engine down before the process exits, because shutting down flushes pending writes.
- An embedding adapter, a tokenizer, or a stop word function that an index uses has to be registered under its name in every process that opens the index, because a saved index records only the name.
