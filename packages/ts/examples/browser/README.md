# Narsil browser example

This example runs the full Narsil engine inside the page. Indexing and search happen in a Web Worker, your data stays on your machine, and the whole app deploys as static files. Together with the other examples it completes the lineup: `browser` embeds the engine in the page, `server-app` talks to the Narsil server from an application backend, and `http-server` is the server itself.

## How it works

A Web Worker owns the Narsil instance, so the page stays responsive while indexing runs. The page calls the worker over a small typed bridge, and each method on it mirrors the one on `Narsil` it forwards to.

```text
Page (React)  ->  Web Worker (Narsil engine)  ->  IndexedDB (@delali/narsil/adapters/indexeddb)
```

The engine writes its own indexes through the IndexedDB persistence adapter, and `createNarsil` recovers them before it resolves, so an index built on one visit is there on the next without loading anything again. `checkpoint` runs at the end of each load rather than waiting for the engine's own schedule. Clear the site's browser storage to start fresh.

Every language the Wikipedia dataset offers is registered before the engine starts, because recovery rebuilds each index under the language it was created with.

## Run it

Build the engine once, then start the app:

```bash
pnpm --filter @delali/narsil build
pnpm --filter @delali/narsil-example-browser dev
```

The app serves on [http://localhost:5173](http://localhost:5173). Everything after that happens in your browser.

## Views

- **Datasets** loads and configures the corpora. Tabs unlock as data becomes available: Search and Relevance open once a text dataset is indexed, Benchmark opens once SciFact is indexed, and Inspector opens with any index.
- **Search** is the playground: instant results, facets, field boosts, sorting, highlighting, and pagination.
- **Relevance** breaks down BM25 scoring per result and lets you tune k1, b, and field boosts to watch the ranking change.
- **Benchmark** runs the 300 SciFact claim queries against the index and reports nDCG@10, P@10, MAP, and MRR against expert relevance judgments.
- **Inspector** shows the index structure: schema, partitions, document counts, memory statistics, and the state of each vector field's graph.

## Datasets

The app loads the corpora from `data/processed/` at the repository root: TMDB movies (tiers from 1k to 100k documents), Wikipedia in ten languages with per-language tokenization, and SciFact (5,183 scientific abstracts with 300 test queries and relevance judgments, used by the benchmark view). The repository carries the small tiers, and larger ones download from GitHub Releases with streamed progress.

The **Your Dataset** card indexes your own data: upload JSON or CSV, review the auto-detected schema, pick the searchable fields, and search it like any built-in dataset. The file is parsed and indexed entirely in the browser.

## Scripts

```bash
pnpm dev        # start the app on port 5173
pnpm build      # production build
pnpm test       # vitest
pnpm lint       # biome
pnpm typecheck  # tsc
```
