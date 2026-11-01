# Persistence and durability

Persistence writes an index to a store, and durability adds a write-ahead log on top of it. This guide covers both, along with checkpoints, recovery, the index lifecycle, portable snapshots, document exports, and indexes from an earlier release.

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
| `tier` | `'wal' \| 'snapshot'` | resolved from the adapter | Overrides tier selection. `'snapshot'` forces snapshot-only persistence onto any adapter, a filesystem-backed one included, which is the tier to pick where several processes share one directory, because the engine holds a write-ahead log directory alone. `'snapshot'` without a persistence adapter and `'wal'` without a resolvable directory both fail with `CONFIG_INVALID`, and `'snapshot'` also rejects the write-ahead log fields `directory`, `mode`, `flushIntervalMs`, `segmentMaxBytes`, and `compactionThreshold`. |
| `directory` | `string` | none | Sets the root directory for the log and checkpoints. |
| `mode` | `'sync' \| 'async'` | `'sync'` | Selects the acknowledgement contract described below. |
| `flushIntervalMs` | `number` | `1000` | Sets how often the async mode flushes the log to disk. |
| `segmentMaxBytes` | `number` | `67108864` | Caps a log segment at this size (64 MiB), so the engine rolls to a new segment before an append would pass the cap. `createNarsil` rejects a value above 2,147,483,647 with `CONFIG_INVALID`, because every file in the format has that limit. |
| `checkpointIntervalMs` | `number` | `300000` | Sets the time between automatic checkpoints (5 minutes). |
| `checkpointMutationThreshold` | `number` | `100000` | Sets the mutation count that triggers a checkpoint early. |
| `compactionThreshold` | `number` | `12` | Sets the checkpoint segment count that triggers compaction. |

In `sync` mode the engine acknowledges a write only once the log holds it on disk, so a crash never loses a write your caller saw succeed. In `async` mode it acknowledges the write at once and flushes the log every `flushIntervalMs`, which is faster and may lose the final interval on a hard crash. The engine reports a durability failure through the `durabilityError` event; see [Events](observability.md#events).

Only one engine may write a durability directory at a time. Before recovery, the engine writes a `.narsil.lock` file into the directory with its process id, its thread id, the time its process started, and a random token. `createNarsil` fails with `CONFIG_INVALID` while another running process, another thread, or another engine in the same process has the directory open, whether through the same path, another spelling of it, or a symbolic link. The engine deletes the file on `shutdown()`, and also when `createNarsil` fails after writing it, so that a retry in the same process can open the directory. A process that crashes leaves the file behind, which the next engine replaces because the file records a process that no longer runs. The engine identifies that process by its id together with its start time. On Linux, the engine also replaces the file when the recorded id now belongs to a thread of any process, or to a process that started more than a second after the recorded one and keeps no file open inside the directory. Both can happen once a container restarts or the machine reboots, because process ids then start again from 1. A running engine on Linux keeps its directory open until `shutdown()`, so a clock that steps forward after the engine starts can't make its directory look free. Where the engine can't read which files that process keeps open, as when another user runs it, the start time decides alone. Where the engine can't read a process's start time, as on macOS and Windows, `createNarsil` refuses a directory whose recorded id belongs to any running process, and the error gives the path of the lock file to delete. The engine reads the token again before it acknowledges each `sync` write and once a second, so writes fail with `PERSISTENCE_SAVE_FAILED` once another engine replaces the file.

Where the directory goes missing, or its path leads to a different directory, the engine emits `durabilityError` with `PERSISTENCE_SAVE_FAILED` and fails every later write with the same code. In `sync` mode it checks the directory before it acknowledges each write, so the first write after the loss fails, and in `async` mode it checks once a second. A checkpoint that the filesystem refuses, such as one into a read-only folder, fails with `PERSISTENCE_SAVE_FAILED` and stops later writes in the same way.

A checkpoint writes what changed since the checkpoint before it: the documents, and the vectors that arrived since, which go into new files of at most 65,536 vectors each. The engine leaves a written vector file unchanged, and it replaces a file once removals and updates leave more than a fifth of its vectors unused, or once a later checkpoint writes at least as many vectors as a partly filled file holds. It writes the graph of a changed vector field whole, in parts of at most 16,384 vectors each. While the documents that wait for a checkpoint hold 2 GiB or more, the engine holds each new write's acknowledgement until the checkpoint in progress covers some of them, because that bounds both the vectors that wait in memory for a file and the log that a recovery replays. A held write is already in the log, so it survives a crash like any acknowledged write.

Every file in the format has a limit of 2,147,483,647 bytes, because a single Node.js read call returns at most that many bytes of a file. The engine therefore starts a new document file before the current one would pass the limit. During compaction, it merges fewer files where the merged file would otherwise pass the limit too. Where a checkpoint would still need a larger file, the engine raises `PERSISTENCE_SAVE_FAILED` and writes no new manifest, so the previous checkpoint stays in force.

The engine opens a new log segment as a checkpoint starts, and once the checkpoint commits, it deletes each segment whose records the checkpoint holds, so a restart reads only the records that arrived after the checkpoint. A checkpoint that finds no new writes opens no segment.

`createNarsil` validates every durability field and rejects an invalid value with `CONFIG_INVALID`: an unknown `tier` or `mode` string, a non-finite number, a negative interval, or a size or threshold below 1. An interval of `0` disables that timer.

## Disk-backed search

An index can hold more text than its node has memory for. Set `textStorage` to `'disk'` when you create the index, and set `vectorPromotion.storage` to `'disk'` for any vector field:

```ts
const narsil = await createNarsil({ durability: { directory: './narsil-data' } })

await narsil.createIndex('articles', {
  schema: { title: 'string', body: 'string', embedding: 'vector[1536]' },
  textStorage: 'disk',
  vectorPromotion: { storage: 'disk' },
})
```

The HTTP server, its client, and a cluster take the same `textStorage` field in an index's config. The default is `'memory'`, which leaves an index exactly as it behaves without this setting. An engine without filesystem durability refuses `'disk'` with `CONFIG_INVALID`, because the engine reads the checkpoint's segment files by position.

A checkpoint moves the documents out of memory. Until the next checkpoint, the engine holds each new write in memory and writes it to the log, as it does for any index. Once a checkpoint covers those writes, the engine searches and reads them from the segment files, so you should wait for a checkpoint before you measure the memory of a loaded index. After a restart, the engine reads each segment's resident sections, replays the log above the checkpoint, and answers from the files. Each thread that searches holds a read cache of at most 128 MiB. The engine counts the main thread's cache in the index's memory, along with every structure that it keeps in memory, and `getMemoryStats` includes each worker's cache in that worker's `external` figure. `lifecycle.maxOpenBytes` therefore counts only the memory that the index uses on the main thread, however large its files grow.

The engine checks each block against its checksum when it first reads the block, and it refuses a damaged block with `PERSISTENCE_CRC_MISMATCH` or a file that it can't read with `PERSISTENCE_LOAD_FAILED`, so a search never answers from damaged bytes. It checks a whole segment before it merges that segment, and before it accepts a snapshot archive from outside the engine.

A merge, a partition copy, a rebalance, a text reanalysis, and an export each read the files in small pieces, so none of them holds a whole segment in memory. Compaction merges segments up to 1 GiB. Each worker copy opens the files itself. When a checkpoint replaces a file, the engine waits until every worker copy has moved to the new files and deletes the old file at the next checkpoint, so a running search can still read every file that it holds.

## Index lifecycle

An engine that holds many indexes can keep only the ones in use in memory. When you set an idle timeout or a limit on open indexes, the engine closes an index that nobody is using and keeps its files on disk. The engine reopens the index the next time a caller uses it. Configure durability alongside these settings, because the engine saves a checkpoint before it releases an index and reads that checkpoint back when it reopens the index.

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

`snapshot(indexName)` returns a stream of the index's snapshot archive. The archive is a pax file containing the index's configuration, the manifest of one checkpoint, and every file that the manifest lists. `restore(indexName, data)` creates an index from that archive under the name that you pass. Where an index of that name already exists, the engine replaces it. The `data` argument can be a `Uint8Array`, a `ReadableStream` of bytes, or an async iterable of byte chunks, such as a Node.js file stream.

```ts
import { createReadStream, createWriteStream } from 'node:fs'
import { Writable } from 'node:stream'

const archive = await narsil.snapshot('products')
await archive.pipeTo(Writable.toWeb(createWriteStream('./products.tar')))

await narsil.restore('products', createReadStream('./products.tar'))
```

With write-ahead log durability, the engine writes a checkpoint before it starts the stream, so the archive contains every write that the engine acknowledged before the call. The engine keeps that checkpoint's files on disk until the stream ends or you cancel it, even when it writes a later checkpoint without them. Without write-ahead log durability, the engine builds the archive's files from the index in memory.

The engine reads the archive one file at a time and checks the length and checksum of each file against the manifest. It then loads those files into a separate index, while the existing index goes on answering requests, and swaps the restored index in once it has loaded completely. When a check or the load fails, the engine raises an error and leaves the existing index unchanged and serving. With durability on, the engine writes the archive's files to a staging directory beside the index and keeps a journal while it moves them into place. If a crash interrupts the restore after the engine has written that journal, the engine finishes the move the next time it starts, so the index reopens as the restored one. If the crash comes before the journal exists, the engine deletes the staging directory, and the index reopens as it was.

| Code | Raised when |
| --- | --- |
| `PERSISTENCE_LOAD_FAILED` | The archive is malformed, or a file's length differs from the length in the manifest. |
| `PERSISTENCE_CRC_MISMATCH` | The checksum in a file's header differs from the checksum of the file's contents. |
| `ENVELOPE_VERSION_MISMATCH` | A file has a format version other than the ones that this release implements. |
| `CONFIG_INVALID` | The archive's index configuration is invalid. |
| `DOC_VALIDATION_FAILED` | The data is empty, or the release 0.3 snapshot file is invalid. |
| `RESTORE_MEMORY_EXCEEDED` | The restored index would need more JavaScript heap or more process memory than the process has free. The engine checks this from the manifest before it stages any file. When the restore replaces an index, the engine estimates from the largest need measured for this release plus 25%, and the existing index keeps serving if it refuses. When the restore creates an index, the engine estimates from the smallest need measured for this release less 25%, so that it refuses only a restore that cannot fit, and a refused restore creates no index. Before it refuses either kind, the engine runs one full garbage collection and checks again. Drop any existing index first to free its memory, or give the process more. |
| `WORKER_TIMEOUT` | A worker thread still holds the existing index 30 seconds after the engine asked every thread to let it go. The existing index keeps serving. |

[`packages/spec`](../packages/spec) defines the archive format, so you can restore a snapshot from this engine in another process, on another machine, or with another implementation of the format. `restore` also accepts the single `.nrsl` file that `snapshot` returned in release 0.3, which the engine loads by inserting the file's documents and vectors as new writes.

## Document export and import

A document export is a JSON Lines file containing an index's configuration and its documents. Its format stays the same in every release of the engine, so you can use an export to move an index across several releases or between implementations. The export is text, which means you can also edit its header and its documents to move them into a new schema.

```ts
import { createReadStream, createWriteStream } from 'node:fs'
import { Writable } from 'node:stream'

const lines = await narsil.exportDocuments('products')
await lines.pipeTo(Writable.toWeb(createWriteStream('./products.jsonl')))

const result = await narsil.importDocumentExport('products', createReadStream('./products.jsonl'))
// { imported: 1204, refusedCount: 0, refused: [] }
```

The first line of an export is a header containing the format name, the format version, and the index configuration. Each later line contains one document, with the document's ID under `id` and the value of each vector field as an array of numbers. The engine writes each number so that a JSON parser returns the same value that the index stores, negative zero included. With write-ahead log durability, the engine exports every document from one checkpoint, as it does for a snapshot; otherwise, it exports them from the index in memory at one moment.

JSON has no type for a date, for raw bytes, or for an infinite number or `NaN`, so the engine writes each such value as a tag. Each tag is an object with one key that begins with `$`, as this table shows:

| Value in the document | Text in the export |
| --- | --- |
| `new Date(1700000000123)` | `{"$date":[1700000000,123000000]}`, the seconds and nanoseconds since the start of 1970 |
| `new Uint8Array([1, 2, 3])` | `{"$bytes":"AQID"}`, the bytes in base64 |
| `NaN`, `Infinity`, and `-Infinity` | `{"$number":"NaN"}`, `{"$number":"Infinity"}`, and `{"$number":"-Infinity"}` |
| `{ $price: 4 }` | `{"$object":{"$price":4}}` |

The engine wraps an object whose only key begins with `$` in an `$object` tag, as the last row shows, because the import decodes every other object of that shape as a tag. The import converts each tag back into the value that the tag stands for. When an object has one key that begins with `$` and that key matches none of the four tags, or when a tag holds an invalid value, the import refuses the line.

When the name that you pass to `importDocumentExport` is free, the engine creates the index from the export's configuration. When an index of that name exists, the engine writes into it if every field has the same type in its schema as in the export's header. If any field's type differs, the engine raises `CONFIG_INVALID` before it writes a document. The engine raises the same error, again before it writes anything, when the first line is anything other than a version 1 header.

The engine writes the documents in batches of 1,000 and replaces any document whose ID the index already contains. Because it replaces existing documents, you can run an interrupted import again to make the index equal to the export. When a line is invalid or the engine rejects its document, the engine records the refusal and continues with the next line. In the result, `refusedCount` is the number of refused lines, while `refused` holds the 1,000 refusals with the lowest line numbers. Each entry contains the line number, where the header is line 1, along with the error code and a message.

## Indexes from an earlier release

The engine opens an index that you saved with release 0.3, on either durability tier, then rewrites the index in the current layout before it serves the index's first request. During the rewrite, the engine keeps every document and every vector, including any document or vector field that exceeds the [limits for new writes](indexes-and-documents.md#limits). It writes each new file under a key outside the release 0.3 layout and writes the new manifest last, which means the earlier files stay intact until the engine writes that manifest. If a crash interrupts the rewrite, the index stays in the release 0.3 layout. The engine then starts the rewrite again the next time it opens the index.

The engine emits `layoutUpgrade` as it starts, completes, or fails the rewrite of each index; see [Events](observability.md#events). Without lifecycle settings, `createNarsil` rewrites every such index before it resolves, so a handler that you register with `on` afterwards will miss those events. Pass the handler in the `events` setting of `createNarsil` to receive them, as in `createNarsil({ durability, events: { layoutUpgrade: report } })`. With lifecycle settings, the engine rewrites an index when it first opens the index, so a handler that you register with `on` once `createNarsil` resolves will also receive the events.

Release 0.3 accepted a `vectorPromotion.hnswConfig.m` of 1, which this release refuses for a new index. The engine opens such an index with an `m` of 2 and builds its vector graphs again.

When an index is in a layout from before release 0.3, the engine raises `ENVELOPE_VERSION_MISMATCH`. From this release onwards, you can move an index across more than one release if you export its documents with the release that you saved it with and import the export into the new release.
