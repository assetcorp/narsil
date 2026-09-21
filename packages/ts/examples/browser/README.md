# Narsil in the browser

This example loads the whole Narsil engine into the page, so your browser answers every search and your data stays on your own machine. A Web Worker holds the engine and indexes your documents there, which keeps the page responsive throughout. Because the IndexedDB adapter stores each index, an index that you build on one visit is still there on your next one.

## Run it

Build the engine first, because the app loads it from `dist/`:

```bash
pnpm --filter @delali/narsil build
pnpm --filter @delali/narsil-example-browser dev
```

The app serves on [http://localhost:5173](http://localhost:5173). Clear the site's browser storage whenever you want to start again from an empty index.

## The views

Start on **Datasets**, which loads a corpus and unlocks the other tabs.

- **Search** gives you facets, field boosts, sorting, highlighting, and pagination over the index that you loaded.
- **Documents** pages through the stored records without searching them.
- **Relevance** breaks the BM25 score down for each result, where you can change k1, b, and the field boosts to watch the ranking move.
- **Benchmark** sends the 300 SciFact claim queries to the index and reports nDCG@10, P@10, MAP, and MRR against the expert judgments.
- **Inspector** reports the schema, the partitions, the document counts, and the state of each vector field's graph.

The **Your Dataset** card takes JSON or CSV of your own. The browser parses the file, detects its schema, and indexes it, so every byte stays on your machine.

## Scripts

```bash
pnpm dev        # start the app on port 5173
pnpm build      # production build
pnpm test       # vitest
pnpm lint       # biome
pnpm typecheck  # tsc
```
