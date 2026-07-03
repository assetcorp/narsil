# Narsil server-app example

This example is a TanStack Start web application backed by a real Narsil HTTP server. Every search operation the app performs (index creation, dataset loading, search, suggestions, and statistics) travels over REST to a `@delali/narsil/server` instance. Together with the other examples it completes the lineup: `browser` embeds the engine in the page, `server-app` talks to the Narsil server from an application backend, and `http-server` is the server itself.

## How it works

The browser never talks to the Narsil server directly. The app's own server side (TanStack server functions plus two streaming endpoints) holds the REST client, keeps the API key out of the client bundle, and streams dataset-loading progress to the page as server-sent events.

```text
Browser  ->  app server (TanStack Start)  ->  Narsil HTTP server (REST)
```

Dataset loading works the same way: the app server reads the corpus files from `data/processed/`, pushes them to the Narsil server in size-capped `documents/_batch` requests, and reports progress to the page while it goes.

## Run it

Build the engine once, then start the app:

```bash
pnpm --filter @delali/narsil build
pnpm --filter @delali/narsil-example-server-app dev
```

`pnpm dev` starts a demo Narsil server on a loopback port automatically and prints its address, so one command gives you the full setup. The demo server registers every language the Wikipedia dataset uses and keeps its indexes in memory for the lifetime of the dev process.

The app itself serves on [http://localhost:3000](http://localhost:3000). Five views exercise the server: the search playground, the Ask view (chat with grounded answers), the relevance lab, the benchmark view (SciFact with relevance judgments), and the index inspector.

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

One caveat: the Wikipedia dataset creates one index per language, and the target server must have those languages registered. A stock `http-server` launcher ships with English only, so load TMDB or SciFact against it, or register the languages you need in your own launcher. The demo server has all of them.

## Ask: chat with your dataset

The Ask tab answers questions from whichever index you loaded, and nothing else. Narsil retrieves the passages, the app assembles a grounded prompt, and your own OpenAI-compatible model writes the answer while the retrieved documents appear beside it with the highlighted passages Narsil matched. A Keyword / Semantic / Hybrid toggle reruns the same question through different retrieval, so you can watch the sources, and the answer built from them, change while the model stays identical.

Bring your own key; the example ships no model:

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

Every key and URL is read only in server-side code, so none of them reach the browser bundle.

Pointing `NARSIL_SERVER_URL` at an external Narsil server? Embedding adapters are code, not config, so that server must register its own adapter under the name `openai` (see `embeddingAdapters` in `createServer`) for embedded dataset loads and vector queries to work.

## Datasets

The app loads the corpora from `data/processed/` at the repository root: TMDB movies (tiers from 1k to 100k documents), Wikipedia in ten languages, and SciFact (5,183 scientific abstracts with 300 test queries and relevance judgments, used by the benchmark view). Small tiers ship with the repository; larger ones come from GitHub Releases as described on the Datasets page.

## Scripts

```bash
pnpm dev        # start the demo Narsil server and the app
pnpm build      # production build of the app
pnpm test       # vitest
pnpm lint       # biome
pnpm typecheck  # tsc
```
