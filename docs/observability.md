# Observability

The engine reports on its own work through three channels, and this guide covers all of them: plugin hooks around each operation, events for work that finishes in the background, and memory reporting.

## Plugins

Plugins hook into the document and search lifecycle. A plugin is an object with a `name` and any of the optional hooks:

| Hook | Fires |
| --- | --- |
| `beforeInsert` / `afterInsert` | The hooks fire around every document insert, including each document of a batch. |
| `beforeUpdate` / `afterUpdate` | The hooks fire around every document update. |
| `beforeRemove` / `afterRemove` | The hooks fire around every document removal. |
| `beforeSearch` / `afterSearch` | The hooks fire around every query; `afterSearch` receives the results. |
| `onIndexCreate` / `onIndexDrop` | The hooks fire when an index is created or dropped. |

The interface also declares `onPartitionSplit` and `onWorkerPromote`, which are reserved for partition and worker lifecycle notifications; the engine does not fire them yet. Subscribe to the `partitionRebalance` and `workerPromote` [events](#events) for those signals today.

```ts
import { createNarsil, type NarsilPlugin } from '@delali/narsil'

const auditLog: NarsilPlugin = {
  name: 'audit-log',
  async afterInsert(ctx) {
    console.log(`indexed ${ctx.docId} into ${ctx.indexName}`)
  },
  async afterSearch(ctx) {
    console.log(`query on ${ctx.indexName} returned ${ctx.results?.hits.length ?? 0} hits`)
  },
}

const narsil = await createNarsil({ plugins: [auditLog] })
```

A hook may be async, and every `before*` hook runs to completion before the operation applies, so an error thrown in `beforeInsert` rejects the insert. Where an `after*` hook throws, the engine logs a warning and leaves the operation that already succeeded alone.

## Events

`on(event, handler)` subscribes to engine events and `off(event, handler)` unsubscribes. The payloads are typed through `NarsilEventMap`.

| Event | Payload | Meaning |
| --- | --- | --- |
| `durabilityError` | `{ error }` | A write-ahead log append or a checkpoint write failed, on either tier. |
| `invalidationError` | `{ error }` | An invalidation adapter publish, subscribe, or reload failed. |
| `workerCrash` | `{ workerId, indexNames, error }` | A worker died. The pool drops it, its pending requests fail with `WORKER_CRASHED`, and the remaining workers keep answering; with none left, queries fall back to the main thread. |
| `workerPromote` | `{ workerCount, reason }` | An index gained worker copies, whether it reached the copy threshold or loaded its copies again after an idle spell. |
| `workerPromoteFailure` | `{ reason, error, retryable }` | An index could not gain worker copies; `retryable` reports whether the engine tries again. See [Worker copies](partitions-and-workers.md#worker-copies). |
| `partitionRebalance` | `{ indexName, oldCount, newCount }` | A partition reshape completed. |
| `partitionWatermark` | `{ indexName, documentCount, capacity, partitionCount }` | An index crossed its watermark fraction of capacity. See [Partitions and rebalancing](partitions-and-workers.md#partitions-and-rebalancing). |
| `heapPressure` | `{ indexName, heapUsed, heapLimit, estimatedMemoryBytes }` | The process heap crossed nine tenths of its limit during a write to the named index or a load of it. See [The Node heap limit](#the-node-heap-limit). |
| `analysisRebuild` | `{ indexName, status, partitionsRebuilt, partitionCount, error? }` | A rebuild of an index's terms started, completed, or failed. See [Analysis revisions](language-support.md#analysis-revisions). |

```ts
narsil.on('durabilityError', payload => {
  console.error('durability write failed:', payload.error)
})
```

Subscribe to `durabilityError` in any deployment that persists data, and to `invalidationError` in any deployment that runs several instances; the events are the engine's only channel for reporting background failures.

## Memory reporting

Narsil reports memory at three levels: per index, per partition, and per runtime. `getStats(indexName)` returns `estimatedMemoryBytes`, a formula-based estimate for the index's main-thread partitions and vector structures.

```ts
const indexStats = narsil.getStats('products')

console.log(indexStats.estimatedMemoryBytes)
```

The estimate comes from document counts, posting lists, field indexes, and vector indexes. It excludes V8 object headers, allocator overhead, and other host runtime costs, so use it for comparing indexes inside one process rather than for sizing host memory.

`getPartitionStats(indexName)` returns the same estimate for each partition. The partition values sum to `getStats(indexName).estimatedMemoryBytes`.

```ts
const partitions = narsil.getPartitionStats('products')

for (const partition of partitions) {
  console.log(partition.partitionId, partition.estimatedMemoryBytes)
}
```

`getMemoryStats()` returns a runtime snapshot and worker reports. It is async because workers report their heap usage through the worker message channel.

```ts
const memory = await narsil.getMemoryStats()

console.log(memory.estimatedIndexBytes)
console.log(memory.process?.heapUsed)
console.log(memory.workers)
```

`memory.estimatedIndexBytes` sums `estimatedMemoryBytes` across every index in this Narsil instance. `memory.openIndexCount` is the number of open indexes, `memory.closedIndexCount` is the number of closed ones, and `memory.reopenCount` is the number of successful index loads since the engine started. Watch the three fields when [lifecycle settings](persistence-and-durability.md#index-lifecycle) close idle indexes. `memory.process` comes from `process.memoryUsage()` when the runtime exposes it, and its `heapLimit` comes from V8's heap statistics. It measures the whole host process, so two Narsil instances in one Node.js process report the same process numbers, and browser runtimes return `null`. `memory.workers` lists `heapUsed`, `heapTotal`, `heapLimit`, and `external` for each active worker, and the array is empty until the first index gains copies. `memory.workerCopies` holds one entry per index. Its `scaledOut` flag is true while every worker holds a copy of that index, and its `reloadCount` counts the times an idle spell dropped the copies and a later request loaded them again; see [Worker copies](partitions-and-workers.md#worker-copies). Where the runtime offers `SharedArrayBuffer`, a worker attaches the frozen segments of a batch rather than copying them, so its `heapUsed` is often well below what the same index costs on the main thread; see [How a batch reaches the worker copies](partitions-and-workers.md#how-a-batch-reaches-the-worker-copies).

## The Node heap limit

`memory.process.heapLimit` is the number of bytes the V8 heap may grow to. Once a write or a load needs more than that, Node ends the process with a `FATAL ERROR: Reached heap limit` message that no `catch` can take, so an index that does not fit under the limit fails to load on a machine that has room for it. Node sets the default limit from the memory the host or the container reports, at half of it and no more than about 2 GB, and a large host may get about 4 GB. Measured on Node 22.23 in Docker, a container with a 2 GB limit gets a 1,048 MB heap, containers with 4 GB, 8 GB, and 20 GB limits all get 2,096 MB, and a 24 GB laptop running Node 24.16 outside a container gets 4,288 MB. Set the limit before the first large index. `--max-old-space-size-percentage=75` takes a share of the container's memory, or of the host's memory outside a container, and `--max-old-space-size=6144` takes megabytes. Both go on the `node` command line or in `NODE_OPTIONS`, and the percentage flag needs Node 22.21 or newer. Keep a share back for what the process holds outside the heap, which is the vectors, the frozen segments, and the worker copies' own heaps; a vector-heavy index may need a lower share than a keyword index.

The [server image](../packages/ts/examples/http-server/Dockerfile) and the [cluster example image](../packages/ts/examples/cluster-dashboard/Dockerfile.node) set `NODE_OPTIONS=--max-old-space-size-percentage=75`, so an 8 GB container gives the engine a heap of about 6 GB. Pass your own `NODE_OPTIONS` to the container to change the share.

The engine emits `heapPressure` when the heap crosses nine tenths of the limit during a write to an index, a restore, a reopen, or the recovery of persisted indexes at start-up, where the event names the largest index. The event names the index, the heap in use, the limit, and the index's `estimatedMemoryBytes`. It fires once per crossing and arms again once the heap falls below eight tenths of the limit, so a listener can raise an alert per crossing without debouncing. Where no listener is subscribed, as at start-up, the engine writes the same warning to the console.

```ts
narsil.on('heapPressure', payload => {
  console.warn(`heap at ${payload.heapUsed} of ${payload.heapLimit} bytes after writing ${payload.indexName}`)
})
```
