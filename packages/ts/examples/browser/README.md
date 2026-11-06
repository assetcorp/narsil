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

Start on **Datasets**, which loads a corpus and unlocks the other tabs. The **World Places** dataset holds 1,251 places from Natural Earth's public-domain populated places, and `data/processed/places/ATTRIBUTION.md` at the repository root records where they come from and how the conversion works.

- **Search** runs full-text, vector, and hybrid queries. A hybrid query fuses the two lists by reciprocal rank or by a linear blend with a vector weight that you set, and a vector query takes a similarity floor and a graph search width. Text queries can match a phrase in double quotes, a prefix, or part of a word. You can also pin a document to a position, rerank the top results with a cross-encoder, count values into ranges, group the results and total a number field in each group, sort by the smallest or largest value of a list field, and count the matches before you search.
- **Documents** pages through the stored records under filters that you join with "all" or "any" and can negate one by one, and a field that allows patterns takes a wildcard or a regular expression. It also adds, edits, and deletes documents, and every other open tab shows each change.
- **Relevance** sets k1, b, and the field boosts for a single query, and it shows the default ranking and the tuned ranking side by side with each score broken down by field.
- **Map** finds the places within a distance of a point or inside a polygon that you click or type, and draws them on a world map that needs no map service.
- **Sync** keeps an index in this browser in step with the same index in the server app, as the next section describes.
- **Benchmark** sends the 300 SciFact claim queries to the index and reports nDCG@10, P@10, MAP, and MRR against the expert judgments.
- **Inspector** reports the schema, the partitions, the document counts, and the state of each vector field's graph. Its **Manage** tab edits synonyms, changes the language or the stop words of a live index, compacts and optimises the vector graphs, rebalances the partitions, and downloads or restores a snapshot or an export.

The **Your Dataset** card takes JSON or CSV of your own. The browser parses the file, detects its schema, and indexes it, so every byte stays on your machine.

The vector and hybrid modes embed each query in the page with `Xenova/all-MiniLM-L6-v2`, which the app downloads on the first vector or hybrid search and never before it. World Places ships with each place's vector already computed by that model, so loading it embeds nothing.

## Device sync

Device sync needs the server app as well, because the browser syncs with the search server behind it:

```bash
pnpm --filter @delali/narsil-example-server-app dev
pnpm --filter @delali/narsil-example-browser dev
```

The browser app passes every request under `/server-app` on to the server app at `http://localhost:3000`, and `NARSIL_SERVER_APP_URL` moves that address. Load a dataset in the server app, turn sync on for its index under **Inspector**, then **Manage**, and start sync for the same index name on this app's **Sync** page. The browser downloads the index, edits on either side reach the other, and a second tab of this app sends its edits through the tab that syncs. The server app signs a short-lived grant for one index at a time, and the search server refuses the sync feed to anyone without one.

## Scripts

```bash
pnpm dev        # start the app on port 5173
pnpm build      # production build
pnpm test       # vitest, then the Playwright end-to-end tests
pnpm test:e2e   # the Playwright end-to-end tests alone
pnpm lint       # biome
pnpm typecheck  # tsc
```
