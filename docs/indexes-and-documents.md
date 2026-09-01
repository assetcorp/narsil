# Indexes and documents

An index holds documents under a schema that fixes the type of every field. This guide covers creating one, writing documents into it, and changing them one at a time or in batches.

## Indexes

`createIndex(name, config)` creates an index from a schema. The schema supports `string`, `string:sortable`, `number`, `boolean`, `enum`, `geopoint`, `vector[N]`, and the array variants `string[]`, `number[]`, `boolean[]`, and `enum[]`. Objects nest up to 4 levels deep. Narsil validates every document against the schema at insertion time.

`string:sortable` is a `string` in every respect, and a sort may name it. Ordering text costs far more memory per document than ordering a number, so a sort naming a plain `string` field raises `SEARCH_INVALID_FIELD`. A schema is fixed once the index exists, so decide which text fields a caller sorts on before you create it.

```ts
await narsil.createIndex('articles', {
  schema: {
    title: 'string',
    body: 'string',
    author: {
      name: 'string',
      verified: 'boolean',
    },
    publishedYear: 'number',
  },
  language: 'english',
  required: ['title'],
})
```

### IndexConfig

| Field | Type | Description |
| --- | --- | --- |
| `schema` | `SchemaDefinition` | Declares the fields and their types. This field is required. |
| `language` | `string` | Selects the language module for tokenization and stemming. The default is `english`. |
| `partitions` | `PartitionConfig` | Sets `maxDocsPerPartition`, `maxPartitions`, and the `watermark` fraction that fires an early capacity warning. See [Partitions and rebalancing](partitions-and-workers.md#partitions-and-rebalancing). |
| `defaultScoring` | `'local' \| 'dfs' \| 'broadcast'` | Sets the scoring mode used when a query does not pass one. See [Scoring modes](full-text-search.md#scoring-modes). |
| `bm25` | `BM25Params` | Overrides the BM25 `k1` and `b` parameters. |
| `stopWords` | `StopWordOverride \| string` | Replaces or transforms the language module's stop word set, inline or by the name of a set registered with `registerStopWords`. See [Named tokenizers and stop words](language-support.md#named-tokenizers-and-stop-words). |
| `tokenizer` | `CustomTokenizer \| string` | Replaces the built-in tokenizer with your own `tokenize(text)` implementation, inline or by the name of a tokenizer registered with `registerTokenizer`. See [Named tokenizers and stop words](language-support.md#named-tokenizers-and-stop-words). |
| `trackPositions` | `boolean` | Stores token positions in each posting, which the `.nrsl` format carries for readers that match phrases. The default is `true`, and highlighting works either way. |
| `surfaceForms` | `boolean` | Records the original spellings of stemmed words for suggestions and prefix completions. The default is `true`. See [Suggestions](full-text-search.md#suggestions). |
| `vectorPromotion` | `VectorIndexConfig` | Tunes the HNSW promotion threshold, graph parameters, and quantization. See [Vector search](vector-search.md#vector-search). |
| `strict` | `boolean` | Rejects documents that carry fields missing from the schema. |
| `embedding` | `EmbeddingFieldConfig` | Maps text fields to vector fields for auto-embedding. See [Embedding adapters](embedding-adapters.md#embedding-adapters). |
| `required` | `string[]` | Lists fields a document must carry; inserts without them fail with `DOC_MISSING_REQUIRED_FIELD`. |

### Index management

```ts
const indexes = narsil.listIndexes()
// [{ name: 'articles', documentCount: 1204, partitionCount: 1, language: 'english', state: 'open', reopenCount: 0 }]

const stats = narsil.getStats('articles')
// { documentCount, partitionCount, estimatedMemoryBytes, language, schema }

await narsil.clear('articles')

await narsil.dropIndex('articles')
```

`clear` removes every document but keeps the index and its schema. `dropIndex` removes the index entirely, including its persisted data. Call `shutdown()` when the process is done with the engine; it stops workers, flushes durability state, and rejects further calls.

With durability configured, `close(indexName)` releases an index's memory and keeps its files on disk, and `open(indexName)` loads the index back. This is how one engine can hold more indexes than fit in memory. Read each entry's `state` and `reopenCount` to see whether the engine has the index in memory and how many times it has loaded it. For a closed index, the engine reports the `documentCount` from its last checkpoint. See [Index lifecycle](persistence-and-durability.md#index-lifecycle).

## Documents

### Insert

`insert(indexName, document, docId?, options?)` resolves the document id in this order: the explicit `docId` argument wins, then a string `id` field on the document itself, and otherwise Narsil generates a UUID v7. The method returns the resolved id.

```ts
const generatedId = await narsil.insert('products', { title: 'Trackball Mouse' })

const explicitId = await narsil.insert('products', { title: 'Split Keyboard' }, 'kb-042')

await narsil.insert('products', { id: 'kb-043', title: 'Tenkeyless Keyboard' })
```

Inserting an id that already exists fails with `DOC_ALREADY_EXISTS`, and `update` fails with `DOC_NOT_FOUND` where the id is missing, so an upsert would have to check `has()` first and pick the call that fits. The HTTP server's PUT endpoint packages that check as one request.

### Read

```ts
const doc = await narsil.get('products', 'kb-042')
// the document, or undefined when the id is unknown

const docs = await narsil.getMultiple('products', ['kb-042', 'kb-043'])
// Map<string, AnyDocument> holding only the ids that exist

const exists = await narsil.has('products', 'kb-042')

const count = await narsil.countDocuments('products')
```

### List

`listDocuments` reads the stored documents in document-id order without searching, which is how you page through a whole index. Leave the cursor out for the first page, pass back the cursor each page carries, and stop when it comes back null.

```ts
let cursor: string | undefined

do {
  const page = await narsil.listDocuments('products', { limit: 100, cursor })
  for (const entry of page.documents) {
    console.log(entry.id, entry.document)
  }
  cursor = page.cursor ?? undefined
} while (cursor !== undefined)
```

A document that stays in the index for the whole listing comes back exactly once. The engine skips a document you remove part-way through, and it returns one you insert part-way through as soon as that document's id sorts above the cursor.

The cursor holds no engine state, so it stays valid after a restart, a snapshot restore, and a rebalance. Reaching the last page of a large index costs what reaching the first page costs.

The engine compares ids by their Unicode code points, so `'10'` sorts ahead of `'9'`. Every machine and every Narsil implementation produces the same order.

`filters` narrows the listing to the documents your filter accepts, and `total` then counts those documents. `document` takes the same projection [`query`](full-text-search.md) takes. Pass it to drop a vector field, because a field the projection keeps is copied out of the store for every listed document, and the engine reads its vector back out of the index as well.

```ts
const page = await narsil.listDocuments('products', {
  limit: 100,
  filters: { fields: { price: { lte: 50 } } },
  document: { exclude: ['embedding'] },
})
```

`sort` orders the listing by field value rather than by id. Name each field with its direction, either as an object or as a list of `{ field, direction }` entries. The engine applies the fields in the order they are listed, and it breaks a tie on document id, so a full walk still returns every document exactly once. The engine sorts by at most eight fields, because the cursor carries one value for each of them.

```ts
const page = await narsil.listDocuments('products', {
  limit: 100,
  sort: { price: 'desc', title: 'asc' },
})
```

The engine reads every document the listing covers to build a sorted page, so a sorted listing usually costs more than the default order on a large index. It holds one page of documents while it selects, so the memory it needs is set by the page size rather than by the size of the index.

The engine ties each cursor to the sort and the filters that produced it. Sending a cursor back under a different `sort` or different `filters` throws `SEARCH_INVALID_CURSOR`, and so does a cursor the engine never issued.

### Update and remove

`update` replaces the whole document under an id. Internally it removes the old document and inserts the new one, with a fast path when the change touches nothing the index depends on.

```ts
await narsil.update('products', 'kb-042', { title: 'Split Ergonomic Keyboard' })

await narsil.remove('products', 'kb-042')
```

Both methods throw `DOC_NOT_FOUND` for an unknown id.

## Batch operations

`insertBatch`, `updateBatch`, and `removeBatch` process many documents in one call and return partial results. One bad document never aborts the batch, because the engine records every failure with its id and error, and applies every success.

```ts
const result = await narsil.insertBatch('products', [
  { id: 'p1', title: 'USB-C Hub', price: 49 },
  { id: 'p2', title: 'Laptop Stand', price: 89 },
  { id: 'p3', title: 'Broken Doc', price: 'not-a-number' },
])

// result.succeeded => ['p1', 'p2']
// result.failed => [{ docId: 'p3', error: NarsilError(DOC_VALIDATION_FAILED) }]

await narsil.updateBatch('products', [
  { docId: 'p1', document: { title: 'USB-C Hub, 8 ports', price: 59 } },
])

await narsil.removeBatch('products', ['p1', 'p2'])
```

Batch inserts resolve ids from each document's `id` field and generate UUID v7 ids for the rest. The engine processes a large batch in chunks and yields the event loop between them, so searches keep answering during a bulk load. On an index the worker pool already holds, a batch of 64 documents or more is analysed once and sent to the copies as a segment; see [How a batch reaches the worker copies](partitions-and-workers.md#how-a-batch-reaches-the-worker-copies).
