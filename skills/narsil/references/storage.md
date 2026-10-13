# Persistence, durability, and snapshots

## Keep an index across a restart

```ts
import { createNarsil } from '@delali/narsil'
import { createFilesystemPersistence } from '@delali/narsil/adapters/filesystem'

const narsil = await createNarsil({ persistence: createFilesystemPersistence({ directory: './data/search' }) })

if (!narsil.listIndexes().some(index => index.name === 'orders')) {
  await narsil.createIndex('orders', { schema: { customer: 'string', item: 'string', total: 'number' } })
}
```

- A filesystem adapter puts the engine on the write-ahead log, which records every insert, update, and removal before the call resolves. With `durability: { mode: 'async' }`, each write resolves sooner, and a crash can lose the writes of the last flush interval, 1 second by default. The adapter creates its directory.
- The engine locks its directory, so `createNarsil` fails with `CONFIG_INVALID` for a second engine on the same directory until the first one shuts down. Give each process its own directory.
- To share one store between processes, pass `durability: { tier: 'snapshot' }` and an invalidation adapter from `@delali/narsil/invalidation/filesystem` to every process. `createNarsil` refuses an invalidation adapter on the write-ahead log with `CONFIG_INVALID`.
- Subscribe with `narsil.on('durabilityError', handler)`, because the engine reports a failed background save there and rejects no promise that the app holds.

## Close the indexes that nobody is using

With durability, `narsil.close(indexName)` releases an index from memory and `narsil.open(indexName)` loads it again, and a query or a write on a closed index reopens it on its own. `lifecycle: { idleTimeoutMs, maxOpenIndexes, maxOpenBytes }` makes the engine close indexes for you, which lets one process hold an index per tenant or per AI agent. `close` throws `CONFIG_INVALID` on an engine without durability.

## Move an index as one snapshot

`await narsil.snapshot(indexName)` returns a `ReadableStream` of the index's portable snapshot archive. Write the stream to a file as a backup, or send it to another process or a server. `await narsil.restore(indexName, data)` creates the index under that name from a `Uint8Array`, a `ReadableStream`, or an async iterable such as a Node.js file stream, and it replaces any index of that name. The engine checks every file of the archive before it replaces an existing index. It throws `PERSISTENCE_LOAD_FAILED` for a malformed archive and `ENVELOPE_VERSION_MISMATCH` for a format version other than the ones that this release implements.

## Move an index across releases

`await narsil.exportDocuments(indexName)` returns a `ReadableStream` of JSON Lines text, with the index configuration on the first line and one document on each later line. The format stays the same in every release, so `await narsil.importDocumentExport(indexName, data)` on a later release creates the index from the export. The engine replaces each document whose ID the index already contains. `refused` in the result holds the first 1,000 refused lines, each with its line number and error code. The engine opens an index that you saved with the previous release and rewrites it in the current layout, so use an export to move an index across more than one release.

## Partitions

An index opens with one partition, or with `partitions: { maxPartitions }`, and it adds none on its own. `partitions.maxDocsPerPartition` caps the documents that each partition accepts, and the engine refuses a write past that cap with `PARTITION_CAPACITY_EXCEEDED`. `await narsil.rebalance(indexName, count)` changes the partition count, up to `maxPartitions`, while the index keeps answering queries.
