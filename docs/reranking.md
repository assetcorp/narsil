# Reranking

Reranking reorders the top hits of a search with a second model, called a cross-encoder, which reads the query and each document together and so scores relevance more closely than BM25 or an embedding comparison can. The engine first ranks the query as it always does, whether it is a keyword, vector, or hybrid query. It then sends the text of the top hits to a rerank adapter and orders those hits by the scores that come back.

```ts
import { createNarsil } from '@delali/narsil'
import { createHttpReranker } from '@delali/narsil/rerankers/http'

const narsil = await createNarsil({
  rerankAdapters: {
    cohere: createHttpReranker({
      baseUrl: 'https://api.cohere.com/v2',
      model: 'rerank-v3.5',
      apiKey: process.env.COHERE_API_KEY ?? '',
    }),
  },
})

const results = await narsil.query('articles', {
  term: 'how do search engines scale',
  rerank: { adapter: 'cohere', fields: ['title', 'body'], window: 50 },
})
```

## The rerank option

A query reranks when it carries `rerank`, which takes four settings:

| Setting | Description |
| --- | --- |
| `adapter` | The name under which you registered the rerank adapter. An unregistered name raises `RERANK_CONFIG_INVALID`. |
| `fields` | The text fields whose values make up each document that the adapter scores, in that order and one line for each value. Each member of a list field takes a line of its own, and a document without a value in a field adds nothing for it. A field that the schema does not declare as `string`, `string[]`, `verbatim`, or `verbatim[]` raises `RERANK_CONFIG_INVALID`, and so does a field that the list gives twice. |
| `query` | The text that the adapter compares with each document. When you leave it out, the engine sends the query's `term`, or else its `vector.text`, and a query with neither raises `RERANK_CONFIG_INVALID`. |
| `window` | How many of the top hits the adapter scores, from 1 to the engine's `maxRerankWindow`. Where you leave it out, the engine takes the smallest of 100, `maxRerankWindow`, and, on a hybrid query, `hybrid.depth`. A hybrid query reranks its fused list at `hybrid.depth`, so a `window` that you set above that depth raises `RERANK_CONFIG_INVALID`. |

Each reranked hit takes the adapter's score as its `score`. The hits past the window follow in their first order, and the engine scales their scores down where needed, so no hit past the window scores above a reranked hit. A query that sets both `rerank` and `sort` raises `SEARCH_INVALID_MODE`, because each of them sets the order of the hits.

`count` and `countExact` match those of the same query without `rerank`, so a pinned document from outside the matches counts on the first page as it does on a plain query. `facets` and `groups` come from the first ranking. The engine places pinned documents after it reranks, so a pin keeps its position. For a vector query, and for a query that places pins, the engine ranks the query a second time at the depth of the page, so that it counts the hits as the plain query does.

## Pages and cursors

The engine reranks the same top hits for every page of one query, so the pages of a reranked query never repeat or skip a hit. Page with `offset` or with the cursor that each result carries. A reranked cursor records how far into the reranked order the next page starts, and it works only for the query that produced it, so a cursor that you send back with another `rerank` setting raises `SEARCH_INVALID_CURSOR`. The engine asks the adapter for scores once for each page, which means that every page costs one model call.

A page that holds no hits, such as a page past the last hit or a query with `limit: 0`, makes no model call.

## Registering adapters

Register an adapter under a name in the `rerankAdapters` setting, or later with `registerRerankAdapter`. A registration under a name that you already used replaces the adapter for every later query. Each query gives the name of its adapter, so an index stores nothing about reranking and needs no rebuild when you change the model.

```ts
import { createTransformersReranker } from '@delali/narsil-embeddings-transformers/reranker'

narsil.registerRerankAdapter('minilm', createTransformersReranker())
```

Two engine settings bound the work that one query can ask of a model:

| Setting | Default | Description |
| --- | --- | --- |
| `maxRerankWindow` | `100` | The largest `window` that a query may set, from 1 to 1,000. |
| `rerankTimeout` | `30000` | How long, in milliseconds, the engine waits for an adapter before it cancels the call through the adapter's abort signal and raises `RERANK_FAILED`. |

The engine calls each adapter's `shutdown` once when the engine shuts down.

## The bundled adapters

`@delali/narsil/rerankers/http` calls any service that serves the Cohere-compatible `/rerank` route, which Cohere, Jina, vLLM, and Infinity all serve. It sends `{ model, query, documents }` and reads `results[{ index, relevance_score }]`. It retries a 429, 500, 502, 503, or 504 reply with backoff, honours a `Retry-After` header, and splits a long list across requests of at most `maxDocumentsPerRequest` documents, which defaults to 1,000. The API key can be a string or a function that returns one, so a caller can rotate keys without rebuilding the adapter. The adapter keeps the key out of every error that it raises.

`@delali/narsil-embeddings-transformers/reranker` scores documents with a cross-encoder in Transformers.js, in Node.js or in a browser. It loads `Xenova/ms-marco-MiniLM-L-6-v2` by default on its first call, which downloads the model files, so warm it with one call before you take traffic. By default it returns a sigmoid score from 0 to 1, and `activation: 'none'` returns the raw logit.

## Writing an adapter

A rerank adapter is an object with a `rerank` method and an optional `shutdown` method:

```ts
import type { RerankAdapter } from '@delali/narsil'

const substringReranker: RerankAdapter = {
  async rerank(query, documents, signal) {
    signal?.throwIfAborted()
    return documents.map(document => (document.includes(query) ? 1 : 0))
  },
}
```

`rerank` must return one finite number for each document, in the order of `documents`, with a higher number for a more relevant document. The engine raises `RERANK_FAILED` when the adapter throws, returns a list of another length, returns a score that is not a finite number, or outlasts `rerankTimeout`. Stop work once `signal` aborts, because the engine has then given up on the call.

## Over HTTP and in a cluster

The [HTTP server](http-server.md) takes `rerankAdapters` among its options and registers them on the engine that it wraps. The request threads send each model call to the main thread, which holds the adapters. Its `limits.maxRerankWindow` sets the largest window that a remote client may ask for, from 1 up to the engine's `maxRerankWindow`, and it defaults to 100. Where a request leaves `window` out, the server lowers the default window to this limit as well. A larger window answers 400 `INVALID_REQUEST`. The server answers `RERANK_CONFIG_INVALID` with 400 and `RERANK_FAILED` with 503.

In a [cluster](cluster.md), the coordinator node that receives a reranked query reranks it with its own adapter, so register the adapter on every node that takes queries from clients. The data nodes rank and count the query as they do without `rerank`, so they need no adapter.
