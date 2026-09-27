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

`await narsil.snapshot(indexName)` returns the whole index as a `Uint8Array` in the portable `.nrsl` format, and `await narsil.restore(indexName, bytes)` rebuilds it under that name, replacing any index that holds the name. Store the bytes as a backup, or send them to another process or a server. `restore` throws `ENVELOPE_INVALID_MAGIC` for bytes that are no snapshot, and `ENVELOPE_VERSION_MISMATCH` for another version of the format.

## Partitions

An index opens with one partition, or with `partitions: { maxPartitions }`, and it adds none on its own. `partitions.maxDocsPerPartition` caps the documents that each partition accepts, and the engine refuses a write past that cap with `PARTITION_CAPACITY_EXCEEDED`. `await narsil.rebalance(indexName, count)` changes the partition count, up to `maxPartitions`, while the index keeps answering queries.
