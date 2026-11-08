# Narsil in the browser

This example answers searches locally in a Web Worker and stores its indexes in IndexedDB between visits. Dataset documents stay in the browser. The Sync page sends demo notes to the server so that two devices can search and edit separate local copies.

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
- **Sync** searches and edits personal demo notes across two devices, with separate local storage for each device.
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

Open **Sync** and give this tab a device name, such as `laptop`. The app creates a notes space and turns sync on, separately from the public datasets. Open the device menu beside the name and choose **Open another device in a new tab**, then name that tab `phone`. Each device keeps a separate index and upload queue in IndexedDB, and a tab lock stops two tabs from opening the same device.

Save a note on `laptop` and watch it arrive on `phone`. Then turn the **Sync** switch off on one device, edit a note, and search for it there; the status strip counts the edit under **Queued to push**. Turning the switch back on delivers the queued edit through the server to the other device. Local reads and writes also continue while an open page has no network connection, and sync retries when the connection returns. Queued edits survive a reload, which starts sync again.

The browser forwards requests under `/server-app` to the server app at `http://localhost:3000`; `NARSIL_SERVER_APP_URL` changes that address. The server creates a notes space and binds it to this browser with a signed HttpOnly cookie. All tabs in this browser share the space. A short-lived grant admits uploads, snapshot reads, and the sync feed for that space, while the dataset proxy hides notes indexes and refuses their administrative routes. Opening a second browser creates a separate notes space.

## Scripts

```bash
pnpm dev        # start the app on port 5173
pnpm build      # production build
pnpm test       # vitest, then the Playwright end-to-end tests
pnpm test:e2e   # the Playwright end-to-end tests alone
pnpm lint       # biome
pnpm typecheck  # tsc
```
