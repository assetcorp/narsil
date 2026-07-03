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

The app itself serves on [http://localhost:3000](http://localhost:3000). Four views exercise the server: the search playground, the relevance lab, the benchmark view (SciFact with relevance judgments), and the index inspector.

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

## Configuration

| Variable            | Default   | What it does                                                                                 |
| ------------------- | --------- | -------------------------------------------------------------------------------------------- |
| `NARSIL_SERVER_URL` | _unset_   | Uses this Narsil server instead of starting the demo server                                  |
| `NARSIL_API_KEY`    | _unset_   | Sent as `Authorization: Bearer` on every request; the demo server also enforces it when set  |
| `NARSIL_PORT`       | ephemeral | Pins the demo server to a fixed port                                                         |

The key and URL are read only in server-side code, so neither reaches the browser bundle.

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
