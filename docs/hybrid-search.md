# Hybrid search

Hybrid search runs a BM25 ranking and a vector ranking in one query, and this guide covers the two ways it fuses them.

Hybrid mode runs the full-text and vector searches in one query and fuses the two rankings. The vector side needs a query vector: pass a precomputed `value` array, or a `text` string that the index or instance embedding adapter turns into a vector. The `text` form needs an embedding adapter configured first, so passing `text` without one fails with `EMBEDDING_CONFIG_INVALID`; see [Embedding adapters](embedding-adapters.md#embedding-adapters).

```ts
const results = await narsil.query('docs', {
  mode: 'hybrid',
  term: 'how do search engines scale',
  vector: { field: 'embedding', value: myQueryVector },
  hybrid: { strategy: 'rrf', k: 60 },
  limit: 10,
})
```

Two fusion strategies are available:

- `'rrf'` (the default) applies reciprocal rank fusion, which combines the two rankings by position instead of by score. `k` dampens the contribution of lower ranks and defaults to 60.
- `'linear'` normalizes both score sets to [0, 1] and blends them as `alpha * vector + (1 - alpha) * text`. `alpha` defaults to 0.5 and clamps to [0, 1].

```ts
const weighted = await narsil.query('docs', {
  mode: 'hybrid',
  term: 'partition rebalancing',
  vector: { field: 'embedding', value: myQueryVector },
  hybrid: { strategy: 'linear', alpha: 0.7 },
})
```
