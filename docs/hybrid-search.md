# Hybrid search

Hybrid search runs a BM25 ranking and a vector ranking in one query, and this guide covers the two ways it fuses them.

The vector side of a hybrid query needs a query vector: pass a precomputed `value` array, or a `text` string that the index or instance embedding adapter turns into a vector. The `text` form needs an embedding adapter configured first, so passing `text` without one fails with `EMBEDDING_CONFIG_INVALID`; see [Embedding adapters](embedding-adapters.md#embedding-adapters).

```ts
const results = await narsil.query('docs', {
  mode: 'hybrid',
  term: 'how do search engines scale',
  vector: { field: 'embedding', value: myQueryVector },
  hybrid: { strategy: 'rrf', k: 60 },
  limit: 10,
})
```

The engine starts the vector ranking first and computes the BM25 ranking while the vector ranking is still in progress, so a hybrid query takes about as long as the slower of the two. The engine dispatches the BM25 ranking by the rule for [worker copies](partitions-and-workers.md#worker-copies), and it sends the vector ranking to the vector search pool once the field holds a graph.

The engine orders hybrid results by fusion, so it throws `SEARCH_INVALID_MODE` for a hybrid query that also sets a `sort`.

On one engine, `count` for a hybrid query holds the length of the fused list where you leave `hybrid.depth` out. Where you set it, `count` holds the keyword matches plus the vector results that match no keyword, unless a `minScore` trims the fused list, in which case it holds the length of that list. On a cluster, `count` holds the keyword matches alone. `countExact` is true only where each of the two rankings contains every matching document. The vector ranking contains only the candidates that the engine fetches for it, so for a field that holds a graph the engine reports a number at or below the true total.

Where you leave `hybrid.depth` out, the engine fetches a deeper vector ranking for each page, which means that the fused order can change from one page to the next. A cluster refuses a cursor on such a query with `SEARCH_INVALID_CURSOR`, so set `hybrid.depth` where you need the same order across a run of pages.

Where you set `hybrid.depth`, each of the two searches fetches that many results, and the engine pages through the top `depth` of the fused list. Every page of one query therefore comes from the same fused order, whether you page with `offset` or with the cursor that each result carries. The last page stops at `depth`, so it can hold fewer than `limit` hits, and a page that starts at `depth` or beyond raises `SEARCH_RESULT_WINDOW_EXCEEDED`. A larger `depth`, up to 10,000, lets you page further, although each search then fetches more results for every page.

Set `strategy` to one of two values:

- Under `'rrf'`, the default, the engine applies reciprocal rank fusion, which combines the two rankings by position alone. `k` reduces the weight of the lower ranks, and it is 60 by default.
- Under `'linear'`, the engine normalises both sets of scores to [0, 1] and blends them as `alpha * vector + (1 - alpha) * text`. `alpha` sets the weight of the vector side, and it is 0.5 by default.

The engine validates all four values before it searches. It throws a `NarsilError` with code `CONFIG_INVALID` for any `strategy` other than those two, for a `k` that is not a whole number of at least 1, for an `alpha` outside 0 to 1, and for a `depth` that is not a whole number from 1 to 10,000.

```ts
const weighted = await narsil.query('docs', {
  mode: 'hybrid',
  term: 'partition rebalancing',
  vector: { field: 'embedding', value: myQueryVector },
  hybrid: { strategy: 'linear', alpha: 0.7 },
})
```
