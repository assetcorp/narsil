# Persistence and durability

Persistence writes an index to a store, and durability adds a write-ahead log on top of it. This guide covers both, along with checkpoints, recovery, the index lifecycle, and portable snapshots.

## Persistence

Persistence stores serialized partitions through a pluggable adapter. The package includes three adapters:

| Adapter | Import | Environment |
| --- | --- | --- |
| Memory | `@delali/narsil/adapters/memory` | The adapter works everywhere and is meant for tests. |
| Filesystem | `@delali/narsil/adapters/filesystem` | The adapter runs on Node.js, Bun, and Deno. |
| IndexedDB | `@delali/narsil/adapters/indexeddb` | The adapter runs in browsers. |

```ts
import { createNarsil } from '@delali/narsil'
import { createFilesystemPersistence } from '@delali/narsil/adapters/filesystem'

const narsil = await createNarsil({
  persistence: createFilesystemPersistence({ directory: './narsil-data' }),
})
```

In the browser, `createIndexedDBPersistence({ dbName, storeName })` takes the same place, and both config fields are optional. A filesystem adapter runs the write-ahead log durability tier, so a crash never loses a write the engine acknowledged. Every other adapter persists snapshots on the checkpoint triggers: the `durability.checkpointIntervalMs` timer or `durability.checkpointMutationThreshold` mutations, whichever fires first. See [Durability](#durability) for both tiers and the `tier` override.

The serialization format is `.nrsl`, a 32-byte header followed by a MessagePack payload. The format is cross-language portable and specified in [`packages/spec`](../packages/spec), so a Python or Rust implementation can read and write the same files.

A custom backend satisfies the `PersistenceAdapter` interface: `save(key, data)`, `load(key)`, `delete(key)`, and `list(prefix)`, all returning promises.

## Durability

Snapshot-only persistence may lose the writes made after the last checkpoint. Durability closes that window with a write-ahead log. The engine appends every mutation to the log before it acknowledges the write, and it captures the index state in a checkpoint on a schedule, so recovery replays the log over the newest checkpoint. Enable it with a directory:

```ts
const narsil = await createNarsil({
  durability: {
    directory: './narsil-data',
    mode: 'sync',
  },
})
```

`createNarsil` runs recovery before it resolves, so every index is in place before your first call, holding its documents and its full config: partition limits, the scoring default, position tracking, strictness, required fields, vector promotion settings, named embedding adapter bindings, and its stop words and tokenizer. A stop word `Set` persists as an explicit word list, and a named tokenizer or stop word set persists by name, so register the names before calling `createNarsil` (see [Named tokenizers and stop words](language-support.md#named-tokenizers-and-stop-words)). An inline tokenizer instance and a stop word function cannot persist, so use the named forms for any index that must survive recovery unchanged. `checkpoint(indexName)` forces a checkpoint outside the automatic schedule:

```ts
await narsil.checkpoint('products')
```

### DurabilityConfig

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `tier` | `'wal' \| 'snapshot'` | resolved from the adapter | Overrides tier selection. `'snapshot'` forces snapshot-only persistence onto any adapter, a filesystem-backed one included, which is the tier to pick where several processes share one directory, because the write-ahead log requires exclusive use of its own. `'snapshot'` without a persistence adapter and `'wal'` without a resolvable directory both fail with `CONFIG_INVALID`, and `'snapshot'` also rejects the write-ahead log fields `directory`, `mode`, `flushIntervalMs`, `segmentMaxBytes`, and `compactionThreshold`. |
| `directory` | `string` | none | Sets the root directory for the log and checkpoints. |
| `mode` | `'sync' \| 'async'` | `'sync'` | Selects the acknowledgement contract described below. |
| `flushIntervalMs` | `number` | `1000` | Sets how often the async mode flushes the log to disk. |
| `segmentMaxBytes` | `number` | `67108864` | Caps a log segment at this size (64 MiB) before rolling to a new one. |
| `checkpointIntervalMs` | `number` | `300000` | Sets the time between automatic checkpoints (5 minutes). |
| `checkpointMutationThreshold` | `number` | `100000` | Sets the mutation count that triggers a checkpoint early. |
| `compactionThreshold` | `number` | `12` | Sets the checkpoint segment count that triggers compaction. |

In `sync` mode the engine acknowledges a write only once the log holds it on disk, so a crash never loses a write your caller saw succeed. In `async` mode it acknowledges the write at once and flushes the log every `flushIntervalMs`, which is faster and may lose the final interval on a hard crash. The engine reports a durability failure through the `durabilityError` event; see [Events](observability.md#events).

`createNarsil` validates every durability field and rejects an invalid value with `CONFIG_INVALID`: an unknown `tier` or `mode` string, a non-finite number, a negative interval, or a size or threshold below 1. An interval of `0` disables that timer.

## Index lifecycle

An engine that holds many indexes can keep only the busy ones in memory. Lifecycle settings close an idle index while its durable files stay on disk, until the next request that names the index loads it back. The settings require durability, because a close writes a checkpoint and a reopen recovers from one.

```ts
const narsil = await createNarsil({
  durability: { directory: './narsil-data' },
  lifecycle: {
    idleTimeoutMs: 900_000,
    maxOpenIndexes: 100,
    maxOpenBytes: 4_000_000_000,
  },
})
```

With lifecycle settings present, `createNarsil` reads each persisted index's metadata alone, registers the index as closed, and defers snapshot and log recovery until an operation names it, so an engine holding thousands of tenant indexes starts without loading any of them.

### IndexLifecycleConfig

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `idleTimeoutMs` | `number` | none | Closes an index after this long without a read or a write. |
| `maxOpenIndexes` | `number` | none | Caps how many indexes stay open, closing the least recently used above the cap. |
| `maxOpenBytes` | `number` | none | Caps the estimated bytes the open indexes may hold in total, closing the least recently used first. |
| `maxReopenWaiters` | `number` | `64` | Caps how many callers may queue behind one index's reopen. |

An empty object, `lifecycle: {}`, enables the closed startup state without any automatic trigger. An automatic close skips an index while a request, a rebalance, an analysis rebuild, or worker activity is in flight on it.

### Open and close

`close(indexName)` waits for the index's active operations to finish, writes a fresh checkpoint, and releases the index's worker copies and heap, while its files stay on disk. `open(indexName)` loads a closed index ahead of traffic, and it resets a parked recovery failure. `dropIndex` stays the deletion path, and it removes a closed index without reopening it.

```ts
await narsil.close('archive-2024')
await narsil.open('archive-2024')
```

Both methods need durability, and each one fails with `CONFIG_INVALID` without it.

### What reopens a closed index

Reads and writes reopen the index they name, so a caller pays only the first request's recovery time. `listIndexes`, `getStats`, and `getMemoryStats` answer from registered metadata without loading anything. Concurrent requests arriving during a reopen share the one recovery. Past `maxReopenWaiters` of them, the engine rejects the excess with `INDEX_REOPEN_CAPACITY_EXHAUSTED`, which the HTTP server answers with status 503, so a client should retry once the load settles.

When recovery itself fails, the engine keeps the index closed, retries on a later request after a backoff that starts at 100 ms and doubles per failure, and parks the index as `reopen-failed` after the fifth failure. The engine answers every request for a parked index with the cached recovery error and performs no disk read for it. `open()` resets the parked state and tries the recovery again.

### Observing lifecycle state

`listIndexes` reports each index's `state`, which is `open`, `closed`, or `reopen-failed`, and a `reopenCount` of successful loads since the engine started. A closed index reports the `documentCount` its last checkpoint recorded, or `null` where its metadata predates checkpoint counts. `getMemoryStats` adds `openIndexCount`, `closedIndexCount`, and a whole-engine `reopenCount`; see [Memory reporting](observability.md#memory-reporting).

In a cluster, `close` acts on the node you call it on: the allocation table, the replica sets, and the routing stay as they are, and a routed read or write that reaches the node reopens its local copy. See [Node-local operations](cluster.md#node-local-operations).

## Snapshots and restore

`snapshot(indexName)` serializes a whole index, including its documents, schema, and vector data, into one portable byte array. `restore(indexName, data)` rebuilds an index from those bytes, replacing the index if it already exists.

```ts
import { readFile, writeFile } from 'node:fs/promises'

const bytes = await narsil.snapshot('products')
await writeFile('./products.nrsl', bytes)

const saved = await readFile('./products.nrsl')
await narsil.restore('products', new Uint8Array(saved))
```

Snapshots use the same cross-language `.nrsl` envelope as persistence, so one engine's snapshot restores in another process, another machine, or another language implementation. Restoring bytes from an incompatible envelope version fails with `ENVELOPE_VERSION_MISMATCH`.
