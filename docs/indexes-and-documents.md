# Indexes and documents

An index holds documents under a schema that fixes the type of every field. This guide covers creating one, writing documents into it, and changing them one at a time or in batches.

## Indexes

`createIndex(name, config)` creates an index from a schema. Each field of the schema has one of the types `string`, `verbatim`, `number`, `boolean`, `enum`, `geopoint`, or `vector[N]`, or one of the list types `string[]`, `verbatim[]`, `number[]`, `boolean[]`, or `enum[]`. A developer can nest objects up to 4 levels deep in a schema. Narsil validates every document against the schema as it inserts the document.

```ts
await narsil.createIndex('articles', {
  schema: {
    title: 'string:sortable',
    body: 'string',
    slug: 'verbatim',
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

### Text fields

The engine splits a `string` value into words, so it can find the document by any word in the value. It stores a `verbatim` value exactly as written, as one piece of text. Because the engine keeps that value whole, it leaves a `verbatim` field out of keyword search, although it can test the whole value in a filter. Declare a file path, a URL, an order code, or a log line as `verbatim`.

Add any of three options to a `string` or `string[]` type, each after a colon and in any order:

| Option | Effect |
| --- | --- |
| `sortable` | The engine can sort by the field. On a single `string` field, it can also [test a text range](filters-facets-and-pagination.md#text-ranges). |
| `pattern` | The engine raises `DOC_VALIDATION_FAILED` for a value in the field that is longer than the [pattern value limit](#pattern-value-limit). A later release will add pattern search, which will test the field. |
| `partial` | A later release will add partial-word search, which will match parts of the words in the field. |

Add `sortable` alone to a `verbatim` or `verbatim[]` type. The engine stores the options in the order `sortable`, `pattern`, `partial`, whatever their order in the type name, so `getStats` returns `string:sortable:partial` for a field declared as `string:partial:sortable`. It raises `SCHEMA_INVALID_TYPE` for an unknown type, for an option outside the list for its type, such as `number:sortable` or `verbatim:pattern`, and for an option written twice. It applies the same check whenever it loads a schema, as it reopens an index from disk, restores a snapshot, or receives a schema from the cluster. For that reason, an engine raises the same error for an index with a type from a newer version, so that it serves an index only with all of its fields.

To sort by a text field, the engine keeps up to the first 512 code points of every document's value in memory, against 8 bytes per document for a number field. It therefore sorts by a `string`, `verbatim`, `string[]`, or `verbatim[]` field only where the field's type includes `sortable`, while it raises `SEARCH_INVALID_FIELD` for a sort on any other field of those types. Declare a sorted `string[]` field as `string[]:sortable` for that reason. The engine fixes the schema once the index exists, so decide which text fields a caller sorts on before creating the index.

### Pattern value limit

The engine raises `DOC_VALIDATION_FAILED` for a document whose value in a `verbatim` field, or in a field whose type includes `pattern`, is longer than the index's `patternValueLimit` in code points. It tests each element of a list on its own. Set `patternValueLimit` to a whole number from 1 to 65,536, or leave it unset for a limit of 8,192 code points. For any other value, `createIndex` throws `CONFIG_INVALID`. Where a developer sets a limit, the engine writes it into the index metadata and into each snapshot, so that it can apply the same limit after it reopens or restores the index.

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
| `strict` | `boolean` | The engine rejects a document with a field that the schema does not declare, and throws `SEARCH_INVALID_FIELD` for a filter, sort, facet, or group on such a field. |
| `embedding` | `EmbeddingFieldConfig` | Maps text fields to vector fields for auto-embedding. See [Embedding adapters](embedding-adapters.md#embedding-adapters). |
| `required` | `string[]` | Lists the fields that every document must hold. An insert or an update of a document that lacks one fails with `DOC_MISSING_REQUIRED_FIELD`, alone and in a batch. |
| `patternValueLimit` | `number` | The engine raises `DOC_VALIDATION_FAILED` for a value longer than this many code points in a `verbatim` field or in a field whose type includes `pattern`. Set a whole number from 1 to 65,536, or leave it unset for 8,192. See [Pattern value limit](#pattern-value-limit). |

### Index management

```ts
const indexes = narsil.listIndexes()
// [{ name: 'articles', documentCount: 1204, partitionCount: 1, language: 'english', state: 'open', reopenCount: 0 }]

const stats = narsil.getStats('articles')
// { documentCount, partitionCount, estimatedMemoryBytes, language, schema }

await narsil.clear('articles')

await narsil.dropIndex('articles')
```

`clear` removes every document but keeps the index and its schema. `dropIndex` removes the index entirely, including its persisted data. Call `shutdown()` once you have finished with the engine. The call stops the workers and flushes the durability state, after which the engine throws `INSTANCE_SHUT_DOWN` for every later call.

With durability configured, `close(indexName)` releases an index's memory and keeps its files on disk, and `open(indexName)` reopens the index. This is how one engine can hold more indexes than fit in memory. Read each entry's `state` and `reopenCount` to see whether the engine has the index in memory and how many times it has reopened it. For a closed index, the engine reports the `documentCount` from its last checkpoint. See [Index lifecycle](persistence-and-durability.md#index-lifecycle).

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

### Writes and worker copies

Once an index holds worker copies, a write returns as soon as the main copy holds it, and the copies apply it afterwards, so a query that a copy answers can come back without a write that returned before it. Pass `wait: true` in the options of `insert`, `update`, `remove`, or a batch call to make that write return only once every copy has applied it, or call `waitForWrites(indexName)` after a run of writes.

```ts
await narsil.insert('products', { id: 'kb-044', title: 'Compact Keyboard' }, undefined, { wait: true })

await narsil.removeBatch('products', ['p1', 'p2'])
await narsil.waitForWrites('products')
```

See [Writes and the copies](partitions-and-workers.md#writes-and-the-copies) for the rule and for how the HTTP server carries the option.

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
