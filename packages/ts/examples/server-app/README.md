# Narsil server app

This example is a TanStack Start web application that reads from a Narsil HTTP server through `@delali/narsil/client`, with every page built on the hooks in `@delali/narsil/react`.

The browser calls this app, where `src/routes/api/narsil.$.ts` forwards public dataset requests with the server's API key. Personal notes use a separate grant for their uploads, snapshot reads, and sync feed. The proxy passes that grant unchanged, and the search server checks its index and expiry.

```text
Browser (@delali/narsil/react)  ->  this app (/api/narsil)  ->  Narsil HTTP server
```

## Run it

```bash
pnpm --filter @delali/narsil build
pnpm --filter @delali/narsil-example-server-app dev
```

`pnpm dev` starts a demo Narsil server on a loopback port and prints its address, so one command gives you the app and its search server. The app itself serves on [http://localhost:3000](http://localhost:3000).

That demo server keeps its indexes in `.narsil-data` inside this package and replays them at the next start, so a corpus that you load once survives every later `pnpm dev`, along with any vectors that you paid to embed. Delete the directory to reset every index, or set `NARSIL_DATA_DIR` to move it elsewhere. Run one dev server per data directory, because the engine takes no cross-process lock on it.

## The pages

Each page is a short route file over the hooks, so `src/routes/search.tsx` is `useQuery` and `useSuggest` over a deferred form value. Start on Datasets, which loads a corpus and opens the other seven pages:

- **Search** is the query playground, with the same controls as the browser example: full-text, vector, and hybrid modes, phrase, prefix, and partial-word matching, pinned results, cross-encoder reranking, range facets, list-field sorting, and a match count before the search. Group totals stay in the browser example, because the HTTP API carries no reducer function.
- **Ask** answers questions from the loaded index.
- **Documents** pages through the stored records under filters joined with "all" or "any", including wildcard and regular expression tests on pattern fields, and it adds, edits, and deletes documents on the search server.
- **Relevance** sets k1, b, and the field boosts for a single query and compares the tuned ranking with the default one.
- **Map** finds the places within a distance of a point or inside a polygon.
- **Benchmark** scores SciFact against its relevance judgments.
- **Inspector** reports the partitions and each vector field's graph. Its **Manage** tab edits synonyms, changes the analysis, maintains the vector graphs, rebalances the partitions, and takes and restores snapshots and exports.

The browser example's **Sync** page creates its notes space automatically. A signed HttpOnly cookie binds the space to one browser, whose named tabs keep separate local copies. The cookie uses SameSite=Strict and Secure over HTTPS. The grant route accepts only same-origin requests and grants only the cookie's space. Notes indexes stay out of the public index list, task records, memory reports, and Ask. The demo stores its signing key beside its indexes so that a restart preserves the browser's access.

## Ask a question of your dataset

The **Ask** tab answers from the index that you loaded. Narsil retrieves the passages, which this app assembles into a grounded prompt. Your own OpenAI-compatible model then writes the answer beside the documents that it drew on, and a Keyword, Semantic, and Hybrid toggle sends the same question through each retrieval mode while the model stays fixed.

Bring your own key, because the example carries no model:

```bash
OPENAI_API_KEY=sk-... pnpm --filter @delali/narsil-example-server-app dev
```

With the key set, a dataset load embeds each document through the OpenAI embedding model. Without a key, the demo server embeds with `Xenova/all-MiniLM-L6-v2` on its own CPU, so the semantic and hybrid modes work either way. The demo server loads that model and the `Xenova/ms-marco-MiniLM-L-6-v2` reranker on their first use, so the server starts without waiting for either one. An index keeps the model that embedded it, so remove a dataset and load it again after you set or remove the key.

## Point it at your own server

With `NARSIL_SERVER_URL` set, the app skips the demo server:

```bash
node --experimental-strip-types packages/ts/examples/http-server/server.ts
NARSIL_SERVER_URL=http://127.0.0.1:7700 pnpm --filter @delali/narsil-example-server-app dev
```

Your own server needs two things. Because the Wikipedia dataset creates one index per language while a stock `http-server` launcher registers English alone, register those language modules yourself or load TMDB or SciFact. Embedded loads and vector queries need an embedding adapter registered under the name `openai` when a key is set, or `minilm` without one, and reranking needs a rerank adapter registered as `cross-encoder`, because an adapter is code and no environment variable carries it across. Device sync needs `sync: true` in `createServer`, plus an `onRequest` hook that accepts the grants that this app signs with `NARSIL_SYNC_GRANT_SECRET`, as `demo-server.ts` shows.

## Configuration

| Variable | Default | What it does |
| --- | --- | --- |
| `NARSIL_SERVER_URL` | unset | Uses this Narsil server and skips the demo server |
| `NARSIL_API_KEY` | generated for the bundled server | Admits dataset administration; notes requests use a scoped grant |
| `NARSIL_DATA_DIR` | `.narsil-data` here | Puts the demo server's indexes somewhere else |
| `NARSIL_PORT` | ephemeral | Pins the demo server to a fixed port |
| `OPENAI_API_KEY` | unset | Turns on the Ask view and document embedding |
| `ASK_LLM_MODEL` | `gpt-5-mini` | Names the chat model that writes the answers |
| `ASK_LLM_BASE_URL` | `https://api.openai.com/v1` | Takes any OpenAI-compatible chat endpoint, and it also reads `OPENAI_BASE_URL` |
| `ASK_LLM_API_KEY` | `OPENAI_API_KEY` | Gives the chat model a separate key |
| `ASK_EMBEDDING_MODEL` | `text-embedding-3-small` | Names the embedding model registered on the demo server |
| `ASK_EMBEDDING_DIMENSIONS` | `1536` | Sets the vector width, which must match the model |
| `ASK_EMBEDDING_BASE_URL` | `https://api.openai.com/v1` | Takes any OpenAI-compatible embeddings endpoint |
| `ASK_EMBEDDING_API_KEY` | `OPENAI_API_KEY` | Gives the embedding model a separate key |
| `NARSIL_SYNC_GRANT_SECRET` | persisted in `notes-cookie.key` beside the indexes | Signs notes cookies and device sync grants, and it needs at least 32 characters |
| `NARSIL_SYNC_GRANT_MS` | `900000` | Sets how long a device sync grant lasts, from 1 second to 24 hours |

## Scripts

```bash
pnpm dev        # start the demo Narsil server and the app
pnpm build      # production build of the app
pnpm test       # vitest, then the Playwright end-to-end tests
pnpm test:e2e   # the Playwright end-to-end tests alone
pnpm lint       # biome
pnpm typecheck  # tsc
```
