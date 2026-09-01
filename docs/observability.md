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
| `workerPromote` | `{ workerCount, reason }` | The engine moved search onto the worker pool. |
| `workerPromoteFailure` | `{ reason, error, retryable }` | A promotion failed, or an index cannot promote; `retryable` reports whether the engine tries again. See [Workers](partitions-and-workers.md#workers). |
| `partitionRebalance` | `{ indexName, oldCount, newCount }` | A partition reshape completed. |
| `partitionWatermark` | `{ indexName, documentCount, capacity, partitionCount }` | An index crossed its watermark fraction of capacity. See [Partitions and rebalancing](partitions-and-workers.md#partitions-and-rebalancing). |
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

`memory.estimatedIndexBytes` sums `estimatedMemoryBytes` across every index in this Narsil instance. `memory.openIndexCount` and `memory.closedIndexCount` report how many indexes hold memory and how many stay registered without it, and `memory.reopenCount` counts the loads that have succeeded since the engine started; all three matter once [lifecycle settings](persistence-and-durability.md#index-lifecycle) close idle indexes. `memory.process` comes from `process.memoryUsage()` when the runtime exposes it. It measures the whole host process, so two Narsil instances in one Node.js process report the same process numbers, and browser runtimes return `null`. `memory.workers` lists `heapUsed`, `heapTotal`, and `external` for each active worker, and the array is empty before worker promotion. Where the runtime offers `SharedArrayBuffer`, a worker attaches the frozen segments of a batch rather than copying them, so its `heapUsed` is often well below what the same index costs on the main thread; see [How a batch reaches the worker copies](partitions-and-workers.md#how-a-batch-reaches-the-worker-copies).
