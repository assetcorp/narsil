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

An engine that holds many indexes can keep only the ones in use in memory. When you configure lifecycle settings, the engine closes an index that nobody is using and keeps its files on disk. The engine reopens the index the next time a caller uses it. Configure durability alongside these settings, because the engine saves a checkpoint before it releases an index and reads that checkpoint back when it reopens the index.

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

With lifecycle settings present, `createNarsil` reads only the metadata of each persisted index and registers the index as closed. The engine recovers an index's documents when the first operation on that index runs, which means an engine holding thousands of tenant indexes starts without loading any of them.

### IndexLifecycleConfig

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `idleTimeoutMs` | `number` | none | The engine closes an index after this many milliseconds without a read or a write. |
| `maxOpenIndexes` | `number` | none | The engine keeps at most this many indexes open, and it closes the least recently used one when the count goes over. |
| `maxOpenBytes` | `number` | none | The engine closes the least recently used indexes when the open ones use more than this many estimated bytes. |
| `maxReopenWaiters` | `number` | `64` | At most this many callers may wait while one index reopens. |

Pass an empty object, `lifecycle: {}`, when you want the closed startup state without any automatic close. The engine skips an automatic close while a request, a rebalance, an analysis rebuild, or worker activity is running on the index.

### Open and close

`close(indexName)` waits for the index's active operations to finish, and then it writes a checkpoint and releases the index's memory and worker copies. The engine keeps the index's files on disk. `open(indexName)` loads a closed index before any caller needs it, and it clears a parked recovery failure. `dropIndex` is the only way to delete an index, and it deletes a closed one without loading it.

```ts
await narsil.close('archive-2024')
await narsil.open('archive-2024')
```

Both methods fail with `CONFIG_INVALID` unless you configure durability.

### What reopens a closed index

The engine reopens a closed index when a caller reads from it or writes to it. The first caller starts the recovery, and each caller that arrives while it runs waits on that same recovery. `listIndexes`, `getStats`, and `getMemoryStats` answer from the registered metadata and load nothing. When more than `maxReopenWaiters` callers are waiting behind the first, the engine rejects the rest with `INDEX_REOPEN_CAPACITY_EXHAUSTED`. The HTTP server answers that code with status 503, and a client may retry.

When the recovery fails, the engine keeps the index closed and tries again on a later request. The engine waits 100 ms after the first failure and twice as long after each failure that follows. After the fifth failure the engine parks the index in the `reopen-failed` state. The engine then answers every request for that index with the stored recovery error and reads nothing from disk. `open()` clears the parked state and tries the recovery again.

### Observing lifecycle state

`listIndexes` reports each index's `state` as `open`, `closed`, or `reopen-failed`. It also reports a `reopenCount` of successful loads since the engine started. For a closed index, the engine reports the `documentCount` from its last checkpoint. When an older engine wrote the metadata without a count, the engine counts the checkpoint's documents once at startup and writes the count back into the metadata. `getMemoryStats` adds `openIndexCount`, `closedIndexCount`, and an engine-wide `reopenCount`; see [Memory reporting](observability.md#memory-reporting).

In a cluster, `close` closes the copy on the node you call. The controller leaves the allocation table, the replica sets, and the routing unchanged, and the node reopens its copy when it receives a routed read or write. See [Node-local operations](cluster.md#node-local-operations).

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
