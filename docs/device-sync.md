# Device sync

Device sync keeps a copy of one index on a phone, a laptop, or a browser tab, so the app searches and writes locally while it is offline. The device downloads a snapshot of the server's index once, reads every later change from a feed, and uploads its own writes when it can reach the server.

Turn sync on only for an index whose documents all belong to one user, because every device that syncs an index receives the whole index. Create one index for each user, such as `user-41`, and leave sync off for a public index and for any index that holds the data of several users or tenants.

## Serve sync from the server

The server keeps the sync routes off until you turn them on with the `sync` option, and it refuses to start with them on and no `onRequest` hook, because the hook decides which credential may read which index. The engine also needs write-ahead log durability, since the feed reads the log.

```ts
import { createNarsil } from '@delali/narsil'
import { createServer } from '@delali/narsil/server'

const engine = await createNarsil({ durability: { directory: './narsil-data' } })
const server = createServer(engine, {
  sync: true,
  onRequest: ctx => {
    const user = userOfCredential(ctx)
    if (user === null || !ctx.path.startsWith(`/indexes/${user.id}/`)) {
      return { status: 403, code: 'FORBIDDEN', message: 'This credential does not own that index' }
    }
    return { expiresAt: user.credentialExpiresAt }
  },
})
await server.listen()
await engine.updateSync('user-41', { enabled: true })
```

The hook runs on every request and on the upgrade of the feed. A browser can set no header on a WebSocket, so the device sends its credential as a second `Sec-WebSocket-Protocol` value after `narsil.sync.v1`, and the hook reads it from `ctx.headers['sec-websocket-protocol']`. The server answers the upgrade with `narsil.sync.v1` alone, so the credential never comes back in the response. Where the hook returns `{ expiresAt }`, the server closes the feed with close code 4401 at that time, and the device reconnects with a fresh credential.

`updateSync` takes two history limits. The server keeps the log segments that a checkpoint covers as history while a device syncs the index, so that a device that reconnects reads every change after its position. It deletes the oldest segment once it is older than `historyMaxAgeMs`, 30 days by default, and while history holds more bytes than `historyMaxBytes`, which defaults to the length of the published snapshot. A device whose position falls below the history loads the snapshot again.

History keeps every write to the index, including the writes of a document that a caller later removes. The server deletes those entries only when the history limits delete their segment, so a removed document's content can stay on the server's disk for up to `historyMaxAgeMs`, plus up to an hour until the next pass over history, after a checkpoint moves its segment into history. Turning sync off deletes the history at once. Where a removal has to leave the disk sooner, set a shorter `historyMaxAgeMs`.

Sync serves two routes for each index:

| Route | What it serves |
| --- | --- |
| `GET /indexes/{name}/sync/snapshot` | The published snapshot archive, with its entity tag and its length. A `Range` request with `If-Range` resumes a download. |
| `GET /indexes/{name}/sync/feed` | A WebSocket with the subprotocol `narsil.sync.v1`, which sends every change after the device's position. |

The `sync` option also takes an object with `windowBytes`, the unacknowledged bytes after which the server pauses a feed, 8,388,608 by default, `maxConnections`, 10,000 by default, `maxCatchUps`, the connections whose history the server reads at once, 32 by default, and `maxBufferedBytes`, 268,435,456 by default.

In a cluster, any node serves the routes. The cluster needs a backup store, because a node builds the device's first copy from a backup, and a node answers `SYNC_SNAPSHOT_PREPARING` with a `Retry-After` header while it takes that backup. Your backup listing shows these backups, and the cluster keeps the two newest that device sync takes for each index and deletes the older ones. It never deletes a backup that you take yourself, whatever you name it. A backup holds no vector graph, so a device builds the graph of each vector field after it loads a snapshot from a cluster.

## Sync a device

`@delali/narsil/sync` exports `createDeviceSync`, which works with an engine on the device and a store for the device's own state. `@delali/narsil/sync/filesystem` provides a store for Node.js and Electron, and `@delali/narsil/sync/indexeddb` provides one for a browser.

```ts
import { createNarsil } from '@delali/narsil'
import { createDeviceSync } from '@delali/narsil/sync'
import { createFilesystemDeviceStore } from '@delali/narsil/sync/filesystem'

const engine = await createNarsil({ durability: { directory: './device/engine' } })
const store = await createFilesystemDeviceStore({ directory: './device/sync' })
const sync = createDeviceSync({
  engine,
  indexName: 'user-41',
  url: 'https://search.example.com',
  store,
  credential: () => currentAccessToken(),
  onError: error => console.warn('device sync will retry', error),
})
await sync.start()

await sync.put('note-7', { title: 'Ferry times', body: 'The first boat leaves at 06:40' })
const results = await engine.query('user-41', { term: 'ferry' })
```

In a browser, give the engine the IndexedDB persistence adapter and use the IndexedDB store:

```ts
import { createNarsil } from '@delali/narsil'
import { createIndexedDBPersistence } from '@delali/narsil/adapters/indexeddb'
import { createDeviceSync } from '@delali/narsil/sync'
import { createIndexedDBDeviceStore } from '@delali/narsil/sync/indexeddb'

const engine = await createNarsil({ persistence: createIndexedDBPersistence() })
const store = await createIndexedDBDeviceStore()
const sync = createDeviceSync({ engine, indexName: 'user-41', url: '/search-api', store, credential: getToken })
await sync.start()
```

Write through `sync.put` and `sync.remove`, because a write that goes straight to the engine never reaches the server. `put` saves the whole document under its ID, and a search on the device sees it at once. `remove` of a missing document succeeds. Each write waits in the store's queue until the server accepts it, so the app keeps working offline, and the device uploads the queue once it reaches the server again.

`sync.settled()` resolves once the device has uploaded its queue and holds every change up to the server's heads. `sync.status()` reports the connection, the number of queued writes, and the device's position. `sync.stop()` closes the feed and ends a download in progress, and the store stays open for the next `start()`.

## Conflicts and refused writes

The server keeps the last write that it receives, so a device that uploads after a long time offline replaces any change that reached the server in the meantime. To decide each conflict yourself, pass `upload`, which receives the queued writes and returns one outcome for each:

```ts
const sync = createDeviceSync({
  engine,
  indexName: 'user-41',
  url: 'https://search.example.com',
  store,
  upload: writes => api.applyNoteWrites(writes),
  onRefusedWrite: ({ write, error, serverDocument }) => showConflict(write.documentId, error, serverDocument),
})
```

An outcome is `{ accepted: true }` or `{ accepted: false, error }`, and a refused outcome can carry `serverDocument`, the backend's copy or `null`. Where the server or the backend refuses a write, the device replaces its copy of the document with the server's, drops the write from its queue, and calls `onRefusedWrite`. A refusal over HTTP is an answer with status 400, 413, or 422. The device retries every other failure, such as a lost connection or a 503, with a growing delay, and reports each one to `onError`.

## The snapshot

The device loads the published snapshot when it holds no copy, when the server's index has a new epoch, and when its position lies below the server's history. A rebalance, a clear, a restore, an analysis change, and turning sync off and on all give the index a new epoch. The device also loads the snapshot where the feed holds more bytes after its position than `replayLimitOfSnapshot` times the snapshot's length, which defaults to 1.

The store keeps a download in progress, so a device that restarts or loses its connection resumes the download from the last saved byte. Before the download, the device checks that it has registered the language, the tokenizer, and the stop words that the server's index uses, and it raises `SYNC_ANALYSIS_UNAVAILABLE` and keeps its copy where any of them is missing. Where the snapshot comes from an older revision of the language module, the device rebuilds the index's terms after the restore.

Where the device estimates that the old copy and the new one can't both fit in memory, it calls `chooseSnapshotLoad` with the archive's length, the memory that it needs, and the heap limit. Return `'load'` to drop the old copy and load the new one, or `'keep'` to keep the old copy, and call `sync.loadSnapshot()` later to load it. Without `chooseSnapshotLoad`, the device drops the old copy. A browser reports no heap limit, so a device in a browser skips the estimate.

After every restore and every restart, the device applies its queued writes again, so a write that the server has not accepted stays on the device.

## Vectors

A document with a vector field reaches the device with its vectors. A local write to an index with automatic embedding needs the embedding adapter on the device, or a vector in the document, and a text query on the device needs the same model.

## Errors

| Code | Raised when |
| --- | --- |
| `SYNC_DURABILITY_REQUIRED` | A caller turns sync on in an engine without write-ahead log durability. The server answers 409. |
| `SYNC_BACKUP_STORE_REQUIRED` | A caller turns sync on in a cluster without a backup store. The server answers 409. |
| `SYNC_NOT_READY` | A caller turns sync on, or a device connects, while a cluster node runs a release that can't serve the feed. The server answers 503. |
| `SYNC_NOT_ENABLED` | A device asks for the snapshot or the feed of an index with sync off. The server answers 404. |
| `SYNC_SNAPSHOT_PREPARING` | A cluster node is taking the backup that the snapshot needs. The server answers 503 with `Retry-After`. |
| `SYNC_ANALYSIS_UNAVAILABLE` | The device lacks the language, the tokenizer, or the stop words of the server's index. The device raises it itself. |

The feed closes with code 1008 after a message that breaks the protocol, 1009 after a device message longer than 65,536 bytes, 4401 when the credential expires, and 4410 when the device has to load a new snapshot.
