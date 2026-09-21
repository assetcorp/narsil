# Narsil server app

This example is a TanStack Start web application that reads from a Narsil HTTP server through `@delali/narsil/client`, with every page built on the hooks in `@delali/narsil/react`.

The browser calls this app, where `src/routes/api/narsil.$.ts` passes each request on to the search server with the API key attached, so every credential stays on the server.

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

Each page is a short route file over the hooks, so `src/routes/search.tsx` is `useQuery` and `useSuggest` over a deferred form value. Start on Datasets, which loads a corpus and opens the other six pages:

- **Search** is the query playground, with facets, boosts, sorting, and highlighting.
- **Ask** answers questions from the loaded index.
- **Documents** pages through the stored records.
- **Relevance** breaks the BM25 score down for each result.
- **Benchmark** scores SciFact against its relevance judgments.
- **Inspector** reports the partitions and each vector field's graph.

## Ask a question of your dataset

The **Ask** tab answers from the index that you loaded. Narsil retrieves the passages, which this app assembles into a grounded prompt. Your own OpenAI-compatible model then writes the answer beside the documents that it drew on, and a Keyword, Semantic, and Hybrid toggle sends the same question through each retrieval mode while the model stays fixed.

Bring your own key, because the example carries no model:

```bash
OPENAI_API_KEY=sk-... pnpm --filter @delali/narsil-example-server-app dev
```

With the key set, a dataset load also embeds each document through the demo server's embedding adapter, which turns on the semantic and hybrid modes. Keyword mode works without a key. An index that you loaded before setting the key holds no vectors, so remove that dataset and load it again to embed it.

## Point it at your own server

With `NARSIL_SERVER_URL` set, the app skips the demo server:

```bash
node --experimental-strip-types packages/ts/examples/http-server/server.ts
NARSIL_SERVER_URL=http://127.0.0.1:7700 pnpm --filter @delali/narsil-example-server-app dev
```

Your own server needs two things. Because the Wikipedia dataset creates one index per language while a stock `http-server` launcher registers English alone, register those language modules yourself or load TMDB or SciFact. Embedded loads and vector queries need an adapter registered under the name `openai` through `embeddingAdapters` in `createServer`, because an adapter is code and no environment variable carries it across.

## Configuration

| Variable | Default | What it does |
| --- | --- | --- |
| `NARSIL_SERVER_URL` | unset | Uses this Narsil server and skips the demo server |
| `NARSIL_API_KEY` | unset | Travels as `Authorization: Bearer` on every request, and the demo server enforces it when set |
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

## Scripts

```bash
pnpm dev        # start the demo Narsil server and the app
pnpm build      # production build of the app
pnpm test       # vitest
pnpm lint       # biome
pnpm typecheck  # tsc
```
