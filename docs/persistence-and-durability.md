# Persistence and durability

Persistence writes an index to a store, and durability adds a write-ahead log on top of it. This guide covers both, along with checkpoints, recovery, and portable snapshots.

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
