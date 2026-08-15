# Narsil server-app example

This example is a TanStack Start web application backed by a real Narsil HTTP server. Every call it makes goes through `@delali/narsil/client`, and every page reads through the hooks in `@delali/narsil/react`. Together with the other examples it completes the lineup: `browser` embeds the engine in the page, `server-app` talks to the Narsil server through the client SDK, and `http-server` is the server itself.

## How it works

The pages hold a client that points at this app rather than at the search server, because anybody can read what a browser bundle was built with. `src/routes/api/narsil.$.ts` passes each request on with the API key attached, so the browser reaches every route the SDK uses and the credential stays here.

```text
Browser (@delali/narsil/react)  ->  this app (/api/narsil)  ->  Narsil HTTP server
```

A dataset load starts on this app's server, because the corpus files sit on its disk: `startDatasetLoadFn` creates the index and hands the documents to `startImport`, which answers with a task record. From there the browser follows the task through `useTasks`, and the search server owns the work. A load therefore carries on when the page closes, a page opened mid-load picks it up, and the stop button is `cancelTask`. A corpus you upload yourself never takes that detour: the browser already holds it, so `useImport` sends it straight through the proxy.

The demo server raises two limits for these corpora, both in `demo-server.ts`: `maxImportBytes` covers the 168 MB French Wikipedia sample, and `importBatchSize` keeps each embedding request inside the provider's token ceiling.

## Run it

Build the engine once, then start the app:

```bash
pnpm --filter @delali/narsil build
pnpm --filter @delali/narsil-example-server-app dev
```

`pnpm dev` starts a demo Narsil server on a loopback port automatically and prints its address, so one command gives you the full setup. The demo server registers every language the Wikipedia dataset uses and persists its indexes to `.narsil-data` in this package (override the location with `NARSIL_DATA_DIR`). Loaded datasets survive dev-server restarts through the engine's snapshot and write-ahead-log recovery, and documents embedded with your OpenAI key recover with their vectors, so a restart never repeats an embedding spend. Delete the `.narsil-data` directory to reset every index. The directory has no cross-process lock, so run one dev server per data directory.

The app itself serves on [http://localhost:3000](http://localhost:3000). Six views exercise the server: the datasets page, the search playground, the Ask view (chat with grounded answers), the relevance lab, the benchmark view (SciFact with relevance judgments), and the index inspector.

Every one of them is a short route file over a hook, so the page reads as the code you would write yourself. `src/routes/search.tsx` is `useQuery` and `useSuggest` over a deferred form value; `src/routes/documents.tsx` is `useDocuments` with the browsing state beside it; `src/routes/inspector.tsx` reads the partitions and the vector-graph state through the client.

Since the demo server speaks plain REST, you can query it directly while the app runs. Its address appears in the dev console:

```bash
curl -X POST http://127.0.0.1:PORT/indexes/scifact/search \
  -H 'content-type: application/json' \
  -d '{"term":"protein","limit":3}'
```

## Point it at your own server

Set `NARSIL_SERVER_URL` and the app skips the demo server and uses yours instead. The `http-server` example is a ready-made launcher:

```bash
node --experimental-strip-types packages/ts/examples/http-server/server.ts
NARSIL_SERVER_URL=http://127.0.0.1:7700 pnpm --filter @delali/narsil-example-server-app dev
```

One caveat: the Wikipedia dataset creates one index per language, and the target server must have those languages registered. A stock `http-server` launcher registers English alone, so load TMDB or SciFact against it, or register the languages you need in your own launcher. The demo server has all of them.

## Ask: chat with your dataset

The Ask tab answers questions from whichever index you loaded, and nothing else. Narsil retrieves the passages, the app assembles a grounded prompt, and your own OpenAI-compatible model writes the answer while the retrieved documents appear beside it with the highlighted passages Narsil matched. A Keyword / Semantic / Hybrid toggle reruns the same question through different retrieval, so you can watch the sources, and the answer built from them, change while the model stays identical.

Bring your own key; the example carries no model:

```bash
OPENAI_API_KEY=sk-... pnpm --filter @delali/narsil-example-server-app dev
```

With the key set, dataset loads also embed documents through the demo server's embedding adapter, which turns on the semantic and hybrid modes. Without it, keyword mode works fully and the page explains what to configure. Indexes loaded before the key was set have no vectors; remove and reload the dataset to embed them.

## Configuration

| Variable                   | Default                     | What it does                                                                                |
| -------------------------- | --------------------------- | ------------------------------------------------------------------------------------------- |
| `NARSIL_SERVER_URL`        | _unset_                     | Uses this Narsil server instead of starting the demo server                                 |
| `NARSIL_API_KEY`           | _unset_                     | Sent as `Authorization: Bearer` on every request; the demo server also enforces it when set |
| `NARSIL_PORT`              | ephemeral                   | Pins the demo server to a fixed port                                                        |
| `OPENAI_API_KEY`           | _unset_                     | Enables the Ask view: answer generation and document embedding                              |
| `ASK_LLM_MODEL`            | `gpt-5-mini`                | Chat model used for answers                                                                 |
| `ASK_LLM_BASE_URL`         | `https://api.openai.com/v1` | Any OpenAI-compatible chat endpoint (also reads `OPENAI_BASE_URL`)                          |
| `ASK_LLM_API_KEY`          | `OPENAI_API_KEY`            | Separate key for the chat model                                                             |
| `ASK_EMBEDDING_MODEL`      | `text-embedding-3-small`    | Embedding model registered on the demo server                                               |
| `ASK_EMBEDDING_DIMENSIONS` | `1536`                      | Vector width; must match the model                                                          |
| `ASK_EMBEDDING_BASE_URL`   | `https://api.openai.com/v1` | Any OpenAI-compatible embeddings endpoint                                                   |
| `ASK_EMBEDDING_API_KEY`    | `OPENAI_API_KEY`            | Separate key for embeddings                                                                 |

Every key and URL is read only in server-side code, so none of them reach the browser bundle. The proxy route passes anything the SDK sends on to the search server, which is what a demo wants and what a production app would narrow to the routes its pages need.

An external Narsil server named by `NARSIL_SERVER_URL` must register its own adapter under the name `openai`, which `embeddingAdapters` in `createServer` covers, because an embedding adapter is code and no configuration value carries it across. Embedded dataset loads and vector queries work once it does.

## Datasets

The app loads the corpora from `data/processed/` at the repository root: TMDB movies (tiers from 1k to 100k documents), Wikipedia in ten languages, and SciFact (5,183 scientific abstracts with 300 test queries and relevance judgments, used by the benchmark view). The repository carries the small tiers, and larger ones come from GitHub Releases as described on the Datasets page.

## Scripts

```bash
pnpm dev        # start the demo Narsil server and the app
pnpm build      # production build of the app
pnpm test       # vitest
pnpm lint       # biome
pnpm typecheck  # tsc
```
