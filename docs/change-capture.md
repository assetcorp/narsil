# Change capture

Change capture lets a backend service follow every insert, update, and removal on one index, so that it can keep a cache, a second index, or a downstream system up to date. The service saves a position for each partition, and after a restart it receives every change above those positions.

A subscriber receives the documents of the whole index. Narsil records no tenant or owner for a document, so decide which services may follow an index before you turn capture on. A filter on a subscription chooses which changes the subscriber receives, and it grants no access.

## Turn capture on

Change capture reads the write-ahead log, so the engine needs write-ahead log durability. Turn it on for each index with `updateChanges`:

```ts
import { createNarsil } from '@delali/narsil'

const engine = await createNarsil({ durability: { directory: './narsil-data' } })
await engine.updateChanges('orders', { enabled: true, previousDocument: true })
const status = await engine.getChanges('orders')
```

`getChanges` returns the setting and the index's epoch. Turning capture on gives the index a new epoch, unless device sync is on, because both features share one epoch.

The setting takes four fields:

| Field | What it does |
| --- | --- |
| `enabled` | Turns capture on or off. |
| `previousDocument` | Writes into each log entry the document that the write replaces or removes. It defaults to false. |
| `historyMaxAgeMs` | The age after which the engine deletes a log segment from history. It defaults to 30 days. |
| `historyMaxBytes` | The byte count above which the engine deletes the oldest history segment. It defaults to the larger of the checkpoint's length and 1 GiB. |

With `previousDocument` on, a change can tell an insert from an update, and it holds the document as it stood before the write. The engine then reads the stored document on every update and removal, and it writes that old document into the log entry beside the new one. An index with capture off writes the same log as an index on a release without change capture.

The engine saves the setting in the index's metadata. A snapshot archive leaves it out, so a copy that you restore onto another server serves no feed until you turn capture on there.

## History

While capture is on, each checkpoint keeps the log segments that it covers as history, so that a subscriber that reconnects can read every change after its position. The engine deletes the oldest history segment once it is older than `historyMaxAgeMs`, and while history holds more bytes than `historyMaxBytes`. It checks history once an hour. A subscriber whose position falls below the oldest segment has to start again from a document export.

History keeps every write to the index, including the writes of a document that a caller later removes. With `previousDocument` on, the entry of the removal also holds the removed document. A removed document's content can therefore stay on the server's disk for `historyMaxAgeMs`, plus up to an hour until the next pass over history, after a checkpoint moves its segment into history. Where a removal has to leave the disk sooner, turn capture off, and device sync with it where sync is on, and then turn each one on again. The engine deletes the history once both are off.

## Follow changes in the engine

`followChanges` returns the changes of an index as an async iterable, so a program that embeds the engine needs no server:

<!-- example setup
import { type Change, type ChangePosition, createNarsil } from '@delali/narsil'
const engine = await createNarsil({ durability: { directory: './narsil-data' } })
declare function loadPositions(): Promise<{ epoch: string; positions: ChangePosition[] } | null>
declare function savePositions(saved: { epoch: string; positions: ChangePosition[] }): Promise<void>
declare function applyToCache(changes: Change[]): Promise<void>
declare function savePosition(partitionId: number, seqNo: number): Promise<void>
declare function rebuildFromExport(indexName: string): Promise<void>
-->
```ts
const saved = await loadPositions()
for await (const event of engine.followChanges('orders', saved ?? {})) {
  if (event.type === 'subscribed') {
    await savePositions({ epoch: event.epoch, positions: event.positions })
  } else if (event.type === 'changes') {
    await applyToCache(event.changes)
    await savePosition(event.partitionId, event.scannedSeqNo)
  } else {
    await rebuildFromExport('orders')
  }
}
```

Leave out `epoch` and `positions` to start at the index's current heads, or pass both to resume. The first event, `subscribed`, gives the epoch and the positions that the changes follow, so save both. Each `changes` event holds the changes of one partition in `seqNo` order. Apply them, and then save `scannedSeqNo` as that partition's position, so that a crash between the two repeats changes and never skips one.

Each change holds `seqNo`, `type`, `documentId`, and, where they apply, `document` and `previousDocument`:

| `type` | What happened |
| --- | --- |
| `insert` | A new document, written while `previousDocument` was on. `document` holds it. |
| `update` | A replaced document, written while `previousDocument` was on. `document` holds the new one and `previousDocument` the old one. |
| `put` | An insert or an update, written while `previousDocument` was off. `document` holds the new document. |
| `remove` | A removal. `previousDocument` holds the removed document where the option was on. |

A document holds every field and every computed vector. The engine delivers each change at least once, so a subscriber can receive a change again after a restart. Each change holds a whole document or a removal, so applying it twice leaves the same result. Count a `remove` of a document that your copy lacks as a success.

## Filters

With `previousDocument` on, a subscription can hold a filter in the syntax of a query's filters:

<!-- example setup
import { createNarsil } from '@delali/narsil'
const engine = await createNarsil({ durability: { directory: './narsil-data' } })
-->
```ts
const events = engine.followChanges('orders', { filter: { fields: { status: { eq: 'open' } } } })
```

The engine tests the filter against the document before the write and the document after it. A document that starts to match arrives as an `insert`, a document that stops matching arrives as a `remove` with its `previousDocument`, and a document that matches before and after arrives as the change itself. The subscriber receives nothing for a write that matches neither time.

A history entry that the engine wrote while `previousDocument` was off holds no document before the write. Under a filter, such an entry arrives as a `put` when the new document matches, and as a `remove` without `previousDocument` otherwise, so that the subscriber drops a document that matched before.

Under a filter, a `changes` event can hold an empty list, and its `scannedSeqNo` still moves past the entries that the engine examined. Save `scannedSeqNo` from every `changes` event, empty ones included, so that the position of a subscriber whose filter matches little stays above the oldest entry in history. The server's feed sends such an empty event at least once for every `windowBytes` of entries that it examines without a match.

## Resync

Where the positions no longer lead to the index's changes, the last event is `resync`, and the iteration ends. Its `reason` is `epoch` when the index has a new epoch, `history` when history no longer holds the entries above a position, and `ahead` when a position lies above every entry of its partition. A rebalance, a clear, a restore, an analysis change, and turning capture off and on all give the index a new epoch.

After a resync, take a document export of the index, replace your copy with its documents, and follow again from the epoch and the positions in the export's header:

<!-- example setup
import { type AnyDocument, type ChangePosition, createNarsil } from '@delali/narsil'
const engine = await createNarsil({ durability: { directory: './narsil-data' } })
declare function readExportLines(
  stream: ReadableStream<Uint8Array>,
): Promise<{ header: { epoch: string; positions: ChangePosition[] }; documents: AnyDocument[] }>
declare function replaceCacheWith(documents: AnyDocument[]): Promise<void>
declare function savePositions(saved: { epoch: string; positions: ChangePosition[] }): Promise<void>
-->
```ts
const { header, documents } = await readExportLines(await engine.exportDocuments('orders'))
await replaceCacheWith(documents)
await savePositions({ epoch: header.epoch, positions: header.positions })
```

The export is JSON Lines, and its first line is the header. The export of an index with capture on holds `epoch` and `positions` in that header, and each position is the last `seqNo` that the export's checkpoint holds for that partition. The client's `exportDocuments` and the server's `GET /indexes/{name}/export` return the same export.

## Serve the feed from the server

The server keeps the change feed off until you turn it on with the `changes` option. It refuses to start with the feed on and no `onRequest` hook, because the hook decides which credential may follow which index.

<!-- example setup
import type { RequestContext } from '@delali/narsil/server'
declare function serviceOfCredential(
  ctx: RequestContext,
): { mayFollow(path: string): boolean; credentialExpiresAt: number } | null
{example}
-->
```ts
import { createNarsil } from '@delali/narsil'
import { createServer } from '@delali/narsil/server'

const engine = await createNarsil({ durability: { directory: './narsil-data' } })
const server = createServer(engine, {
  changes: true,
  onRequest: ctx => {
    const service = serviceOfCredential(ctx)
    if (service === null || !service.mayFollow(ctx.path)) {
      return { status: 403, code: 'FORBIDDEN', message: 'This credential may not follow that index' }
    }
    return { expiresAt: service.credentialExpiresAt }
  },
})
await server.listen()
```

The server serves three routes for each index:

| Route | What it serves |
| --- | --- |
| `GET /indexes/{name}/changes` | The setting and the epoch, as `getChanges` returns them. |
| `PUT /indexes/{name}/changes` | Replaces the setting, as `updateChanges` does. |
| `GET /indexes/{name}/changes/feed` | A WebSocket with the subprotocol `narsil.changes.v1`, which sends every change after the subscriber's positions. |

The hook runs on every request and on the upgrade of the feed. A subscriber that can set no header on a WebSocket, such as a browser, sends its credential as a second `Sec-WebSocket-Protocol` value after `narsil.changes.v1`, and the hook reads it from `ctx.headers['sec-websocket-protocol']`. The server answers the upgrade with `narsil.changes.v1` alone, so the credential never comes back in the response. Where the hook returns `{ expiresAt }`, the server closes the feed with close code 4401 at that time.

The `changes` option also takes an object with `windowBytes`, the unacknowledged bytes after which the server pauses a subscriber, 8,388,608 by default, `maxConnections`, 10,000 by default, `maxCatchUps`, the connections whose history the server reads at once, 32 by default, and `maxBufferedBytes`, 268,435,456 by default. The server counts these apart from the device sync feed's.

## Follow changes with the client

The client's `followChanges` opens the feed and returns the same events as the engine:

<!-- example setup
import type { Change, ChangePosition } from '@delali/narsil/client'
declare const token: string
declare function loadPositions(): Promise<{ epoch: string; positions: ChangePosition[] } | null>
declare function applyToCache(changes: Change[]): Promise<void>
declare function savePosition(partitionId: number, seqNo: number): Promise<void>
{example}
-->
```ts
import { createNarsilClient } from '@delali/narsil/client'

const client = createNarsilClient({ url: 'https://search.example.com', apiKey: token })
const subscription = client.followChanges('orders', { ...(await loadPositions()), credential: token })
for await (const event of subscription) {
  if (event.type === 'changes') {
    await applyToCache(event.changes)
    await savePosition(event.partitionId, event.scannedSeqNo)
    subscription.ack([{ partitionId: event.partitionId, seqNo: event.scannedSeqNo }])
  }
}
```

The server stops sending once the changes that the subscriber has not acknowledged pass `windowBytes`, so call `ack` with each position once you have saved it, and never with a position that you have not saved. When the connection fails, the iteration ends with `CLIENT_CONNECTION_FAILED`, and you subscribe again from the saved positions.

## The feed protocol

A subscriber in any language can follow the feed. Each message is a MessagePack map in one binary WebSocket frame. The subscriber's first message is a `subscribe`:

```text skip
{ type: 'subscribe', epoch: string or absent, positions: [{ partitionId, seqNo }] or absent, filter: FilterExpression or absent }
```

The server answers with `subscribed`, which holds `epoch`, `partitionCount`, `positions`, `heads`, `bytesBehind`, `windowBytes`, `previousDocument`, and `vectorFields`, the path of every vector field in the schema, such as `meta.embedding`. A vector can arrive as an array of numbers or as a binary value that holds its float32 components in little-endian order, so read a binary value at one of those paths as a vector, and keep a binary value anywhere else as bytes, because a document can hold bytes in a field that the schema leaves out. It then sends `changes` messages, each with `partitionId`, `changes`, and `scannedSeqNo`, and the subscriber sends `{ type: 'ack', positions }` with a position for every partition once it has saved them. Where the positions no longer lead to the index's changes, the server sends `{ type: 'resync', reason }` and closes the connection with close code 4410. `document` and `previousDocument` in a change each hold the document as a MessagePack map. [The change capture specification](../packages/spec/changes.md) defines every message and rule.

The server closes the feed with these codes:

| Close code | Meaning |
| --- | --- |
| 1001 | The server is shutting down, and the subscriber can connect again to any node. |
| 1008 | The subscriber sent a message that breaks the protocol, such as a malformed epoch, a list of positions that leaves out a partition, or a filter past a query's limits. |
| 1009 | The subscriber sent a message longer than 65,536 bytes. |
| 1011 | The server failed to serve the connection, and the subscriber can connect again. |
| 4401 | The credential that admitted the connection has expired. |
| 4409 | The index's setting refuses the subscription, and the close reason holds the error code. |
| 4410 | The subscriber has to take a fresh document export, after a `resync` or after a caller turns capture off. |

## In a cluster

A subscriber can connect to any node, and that node reads each partition's changes from the partition's primary. It sends a change only once every in-sync copy of the partition holds the write, so the copy that becomes primary after a failover holds every change that a subscriber has received. Every copy of a partition keeps history, so a new primary serves the feed after a failover.

The cluster needs a backup store, because a node builds a document export of an index with capture on from a backup. A node answers the export with `CHANGES_EXPORT_PREPARING` and a `Retry-After` header while it takes that backup. Your backup listing shows these backups, and the cluster keeps the two newest that change capture takes for each index and deletes the older ones. It never deletes a backup that you take yourself.

Every node must run a release that supports change capture before a caller turns it on, and a node answers `CHANGES_NOT_READY` while an older node is registered. A cluster places no copy of an index with `previousDocument` on onto a node that runs an older release.

## Errors

| Code | Raised when |
| --- | --- |
| `CHANGES_DURABILITY_REQUIRED` | A caller turns capture on in an engine without write-ahead log durability. The server answers 409. |
| `CHANGES_BACKUP_STORE_REQUIRED` | A caller turns capture on in a cluster without a backup store. The server answers 409. |
| `CHANGES_NOT_READY` | A caller turns capture on, or a subscriber connects, while a cluster node runs a release that can't serve the feed. The server answers 503. |
| `CHANGES_NOT_ENABLED` | A subscriber asks for the feed, or a program asks for the changes, of an index with capture off. The server answers 404. |
| `CHANGES_PREVIOUS_DOCUMENT_REQUIRED` | A subscription holds a filter on an index with `previousDocument` off. The feed closes with code 4409, and the close reason holds the code. |
| `CHANGES_EXPORT_PREPARING` | A cluster node is taking the backup that a document export needs. The server answers 503 with `Retry-After`. |
| `CHANGES_INVALID_POSITIONS` | A program asks the engine for changes with a malformed epoch, with one of the epoch and the positions without the other, or with a list of positions that leaves out a partition, repeats one, or holds a partition that the index lacks. The server answers 400. |
