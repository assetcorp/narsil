# Vector search

A vector field stores one dense embedding per document and answers nearest-neighbour queries over it. This guide covers the distance metrics, the HNSW graph a field promotes to, and the maintenance a changing index needs.

Declare a `vector[N]` field in the schema and insert documents carrying arrays of that exact length. The engine scans a small field exactly, comparing the query against every vector in it. Once a field reaches 1,024 vectors, the engine builds an HNSW graph in the background and answers from that graph approximately instead. The engine adds every later batch of 1,024 vectors to that same graph one vector at a time, so an import of any size builds one graph. The cutoff and graph parameters are configurable per index through `vectorPromotion`.

```ts
await narsil.createIndex('docs', {
  schema: {
    title: 'string',
    embedding: 'vector[768]',
  },
  vectorPromotion: {
    threshold: 2048,
    hnswConfig: { m: 16, efConstruction: 200, metric: 'cosine' },
    quantization: 'osq4',
    storage: 'memory',
  },
})

await narsil.insert('docs', {
  title: 'Distributed consensus',
  embedding: myPrecomputedVector,
})

const results = await narsil.query('docs', {
  mode: 'vector',
  vector: {
    field: 'embedding',
    value: myQueryVector,
    metric: 'cosine',
    similarity: 0.35,
    efSearch: 100,
    oversample: 3,
  },
  limit: 10,
})
```

The `vector` parameter takes either a raw `value` array or a `text` string for auto-embedding, and passing both fails with `EMBEDDING_CONFIG_INVALID`. `metric` selects `'cosine'` (the default), `'dotProduct'`, or `'euclidean'`. `similarity` sets a score floor; hits below it drop before `limit` applies, so a page can come back short. For `euclidean`, the floor applies to the similarity mapping `1 / (1 + distance)`. `efSearch` raises HNSW recall at the cost of latency and has no effect while the field still uses the brute-force backend. A `value` whose length differs from the field's declared dimension fails with `VECTOR_DIMENSION_MISMATCH`.

`quantization` selects how the engine codes each vector once the field holds a graph. Every `osq` mode applies optimised scalar quantization, which centres each vector on the field's centroid and then fits an interval to that vector alone. The digit in the mode name gives the bits that each dimension's code holds, so `osq8` stores a byte per dimension, while `osq4`, `osq2`, and `osq1` store four, two, and one bit. The engine places each new vector in the graph by scoring it against the codes of its neighbours. A search ranks its candidates by their codes before it re-scores the nearest of them against the full-precision vectors. When you leave `quantization` unset, the engine takes `osq4` at 384 dimensions and above and `osq8` below 384. `none` stores no code, so the engine ranks by the vectors alone. `oversample` sets how many times `limit` a quantized field re-scores before it returns the best `limit`. It defaults to 3 for `osq1` and `osq2` and to 2 for `osq8`. For `osq4` it defaults to 2 at 1,024 dimensions and above, but to 5 below 1,024, where a four-bit code ranks the true neighbours less reliably. A value below 1 fails with `CONFIG_INVALID`.

`storage` selects where the field keeps its full-precision vectors. A `memory` field holds them in memory. A `disk` field keeps its codes and its graph in memory, while it reads a full-precision vector from the field's checkpoint file whenever a search re-scores that candidate or a document read returns it. The field holds every vector in memory until it builds its first graph, because a search below the promotion threshold scans every vector. Once the field holds a graph, it reads from the file every vector a checkpoint has written, and it holds each remaining vector in memory until a checkpoint writes it. A checkpoint writes the graph and the codes beside the vectors, so a restart loads them and builds nothing. An engine with filesystem durability takes `disk` when you leave `storage` unset, and every other engine takes `memory`. Asking for `disk` on an engine without filesystem durability fails with `CONFIG_INVALID`.

## Vector maintenance

Removed and updated vectors leave tombstones in the HNSW graph, which slows queries as they accumulate. Two maintenance calls clean up, and a status call reports whether either is worth running:

```ts
const status = narsil.vectorMaintenanceStatus('docs')
// [{ fieldName, tombstoneRatio, graphCount, bufferSize, building, estimatedCompactMs, estimatedOptimizeMs }]

await narsil.compactVectors('docs', 'embedding')

await narsil.optimizeVectors('docs', 'embedding')
```

`compactVectors` drops tombstones without rebuilding the graph and runs synchronously. `optimizeVectors` adds the buffered vectors to the graph, so a run after a bulk import does only the insertions the graph is missing. It rebuilds the graph from every live vector only once you remove more than a fifth of the vectors the graph holds, because a graph that loses that many nodes loses its connectivity. Omit the field name to run maintenance on every vector field in the index.
