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

The engine starts the vector ranking first and runs the BM25 ranking while the vector ranking is still in flight, so a hybrid query takes about as long as the slower of the two. The BM25 ranking follows the dispatch rule for [worker copies](partitions-and-workers.md#worker-copies), and the vector ranking goes to the vector search pool once the field holds a graph.

Fusion defines the order of hybrid results, so a hybrid query takes no `sort`. A hybrid query that also names a `sort` fails with `SEARCH_INVALID_MODE`.

`count` reports the size of the fused list, and `countExact` is true only where both rankings return every document that they match. The BM25 ranking returns every match, while the vector ranking returns the candidates that the engine fetches for it, so a hybrid query over a field that has grown a graph reports a number at or below the true total.

Fusion places each document by its position in the two rankings, and the engine fetches a deeper vector ranking for each page, so the fused order shifts from one page to the next. Page a keyword search or a vector search where you need a ranking that holds steady over a long run of pages.

The `strategy` field takes one of two values:

- `'rrf'` (the default) applies reciprocal rank fusion, which combines the two rankings by position and reads no score. `k` dampens the contribution of lower ranks and defaults to 60.
- `'linear'` normalizes both score sets to [0, 1] and blends them as `alpha * vector + (1 - alpha) * text`. `alpha` weights the vector side and defaults to 0.5.

The engine checks all three values before it searches. Any `strategy` other than those two, a `k` that is not a whole number of at least 1, and an `alpha` outside 0 to 1 each raise a `NarsilError` with code `CONFIG_INVALID`.

```ts
const weighted = await narsil.query('docs', {
  mode: 'hybrid',
  term: 'partition rebalancing',
  vector: { field: 'embedding', value: myQueryVector },
  hybrid: { strategy: 'linear', alpha: 0.7 },
})
```
