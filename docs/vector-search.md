# Vector search

A vector field holds one dense embedding per document so that the engine can find the nearest neighbours of a query among those embeddings. This guide covers the distance metrics, the HNSW graph that the engine builds for a large field, the native core that searches that graph, and the maintenance calls that clean up a graph after you remove or update vectors.

Declare a `vector[N]` field in the schema, and insert documents that hold arrays of exactly that length. The engine searches a small field exactly, by comparing the query with every vector in the field. Once a field holds 1,024 vectors, the engine builds an HNSW graph for it in the background, after which it searches that graph approximately for each query. The engine adds every later vector to that same graph one vector at a time, so it builds one graph however large the import is. You can set the cutoff and the graph parameters for each index through `vectorPromotion`.

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

In the `vector` parameter, pass either a raw `value` array or a `text` string for the engine to embed. For a query with both, the engine throws a `NarsilError` with code `EMBEDDING_CONFIG_INVALID`. Set `metric` to `'cosine'`, which is the default, or to `'dotProduct'` or `'euclidean'`. Set `similarity` to give the scores a floor. The engine drops every hit below that floor before it applies `limit`, so a page can hold fewer than `limit` hits. For `euclidean`, the engine compares the floor with the similarity `1 / (1 + distance)`. When you raise `efSearch`, the HNSW search can find more of the true neighbours, although each query takes longer. The engine applies `efSearch` only once the field holds a graph. For a `value` whose length differs from the field's declared dimension, the engine throws a `NarsilError` with code `VECTOR_DIMENSION_MISMATCH`.

Set `quantization` to choose how the engine codes each vector once the field holds a graph. In every `osq` mode, the engine applies optimised scalar quantization, which means that it centres each vector on the field's centroid and then fits an interval to that vector alone. The digit in the mode name is the number of bits in each dimension's code, so the engine stores a byte per dimension under `osq8`, and four, two, and one bit under `osq4`, `osq2`, and `osq1`. The engine places each new vector in the graph by scoring it against the codes of its neighbours. When the engine searches, it ranks the candidates by their codes before it re-scores the nearest of them against the full-precision vectors. When you leave `quantization` unset, the engine uses `osq4` at 384 dimensions and above, and `osq8` below 384. Under `none`, the engine stores no code and ranks by the vectors alone.

Set `oversample` to choose how many times `limit` the engine re-scores in a quantized field before it returns the best `limit`. The default is 3 for `osq1` and `osq2`, and 2 for `osq8`. For `osq4`, the default is 2 at 1,024 dimensions and above, but 5 below 1,024, because the engine ranks the true neighbours less reliably by a four-bit code in fewer dimensions. For a value below 1, the engine throws a `NarsilError` with code `CONFIG_INVALID`.

Set `storage` to choose where the engine keeps the field's full-precision vectors. Under `memory`, the engine holds them in memory. Under `disk`, the engine keeps the field's codes and graph in memory, while it loads a full-precision vector from the field's checkpoint file whenever it re-scores a candidate or returns a vector from a document read. The engine holds every vector of the field in memory until it builds the field's first graph, because it scans every vector when it searches a field below the promotion threshold. Once the field holds a graph, the engine loads from the checkpoint file each vector that the file holds, while it keeps each other vector in memory until it writes that vector at the next checkpoint. At each checkpoint, the engine writes the vectors that arrived since the last one into new files, with their codes, and it writes the graph, so after a restart it loads them and builds nothing. The engine frees the memory a whole block at a time, once the field holds a graph and a file holds every vector in that block. A process that has written since its last checkpoint therefore still holds its part-filled blocks, while a fresh load allocates only for what the files hold. An engine with filesystem durability uses `disk` when you leave `storage` unset, while every other engine uses `memory`. For `disk` on an engine without filesystem durability, the engine throws a `NarsilError` with code `CONFIG_INVALID`.

## Native search core

Outside a browser, Narsil searches and maintains a vector field through a native core written in C, which returns the same documents with the same scores as Narsil's WebAssembly search. The core searches the field's HNSW graph, re-scores the candidates of that search, and scans the vectors of a field that holds no graph. It also places each new vector in the graph, takes removed vectors out of the graph, and writes the field's codes. npm installs the core with `@delali/narsil` for macOS, Linux, and Windows on arm64 and x64.

Narsil does the same work through WebAssembly in a browser, on any other platform, and wherever the runtime cannot load the core. Narsil prints one warning on each thread that falls back, naming the reason. To hold a process to the WebAssembly search, set `NARSIL_SEARCH_BACKEND=wasm` before you start it. That variable takes `native` or `wasm`, in upper case or lower, while any other value raises a `NarsilError` with code `CONFIG_INVALID`. To load a core from a path of your own, such as one that you compiled, set `NARSIL_NATIVE_CORE_PATH` to the file. Set `NARSIL_REQUIRE_NATIVE_CORE=1` to hold a process to the core alone. Narsil then raises a `NarsilError` with code `CONFIG_INVALID` every time that it needs a core and finds none. To find out which path a server takes, call `GET /version` and read its `vectorSearch` field, which holds `native` or `wasm`.

For a `disk` field, the core maps each checkpoint file that holds the field's vectors into memory, and it compares a query with a vector inside that mapping. Leave those files unchanged while Narsil is up, because macOS and Linux end a process that touches a mapped page beyond the end of a file that another process truncated.

## Vector maintenance

When you remove or update a vector, the engine leaves a tombstone in the HNSW graph, so each query takes longer as those tombstones accumulate. Two maintenance calls clean up the graph. To decide whether either is worth making, call `vectorMaintenanceStatus`, which reports each field's tombstone ratio and the time that each maintenance call would take:

```ts
const status = narsil.vectorMaintenanceStatus('docs')
// [{ fieldName, tombstoneRatio, graphCount, bufferSize, building, estimatedCompactMs, estimatedOptimizeMs }]

await narsil.compactVectors('docs', 'embedding')

await narsil.optimizeVectors('docs', 'embedding')
```

`compactVectors` drops the tombstones synchronously, without rebuilding the graph. `optimizeVectors` adds the buffered vectors to the graph, so after a bulk import it inserts only the vectors that the graph lacks. It rebuilds the graph from every live vector only once you remove more than a fifth of the vectors that the graph holds, because the graph can lose its connectivity when it loses that many nodes. Whenever `optimizeVectors` rebuilds the graph of a quantized field, the engine first takes the field's centroid again from the live vectors and writes every code again, while `compactVectors` leaves the centroid and the codes as they are. Omit the field name to maintain every vector field in the index.
