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
    quantization: 'sq8',
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
  },
  limit: 10,
})
```

The `vector` parameter takes either a raw `value` array or a `text` string for auto-embedding, and passing both fails with `EMBEDDING_CONFIG_INVALID`. `metric` selects `'cosine'` (the default), `'dotProduct'`, or `'euclidean'`. `similarity` sets a score floor; hits below it drop before `limit` applies, so a page can come back short. For `euclidean`, the floor applies to the similarity mapping `1 / (1 + distance)`. `efSearch` raises HNSW recall at the cost of latency and has no effect while the field still uses the brute-force backend. A `value` whose length differs from the field's declared dimension fails with `VECTOR_DIMENSION_MISMATCH`.

Quantization mode `'sq8'` is the default; it stores scalar-quantized int8 vectors, which cuts vector memory roughly 4x. Set `quantization: 'none'` to keep full float32 vectors.

## Vector maintenance

Removed and updated vectors leave tombstones in the HNSW graph, which slows queries as they accumulate. Two maintenance calls clean up, and a status call reports whether either is worth running:

```ts
const status = narsil.vectorMaintenanceStatus('docs')
// [{ fieldName, tombstoneRatio, graphCount, bufferSize, building, estimatedCompactMs, estimatedOptimizeMs }]

await narsil.compactVectors('docs', 'embedding')

await narsil.optimizeVectors('docs', 'embedding')
```

`compactVectors` drops tombstones without rebuilding the graph and runs synchronously. `optimizeVectors` adds the buffered vectors to the graph, so a run after a bulk import does only the insertions the graph is missing. It rebuilds the graph from every live vector only once you remove more than a fifth of the vectors the graph holds, because a graph that loses that many nodes loses its connectivity. Omit the field name to run maintenance on every vector field in the index.
