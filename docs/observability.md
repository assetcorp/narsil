# Observability

The engine reports itself through three channels, and this guide covers all of them: plugin hooks around each operation, events for work that finishes in the background, and memory reporting.

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

Hooks can be async, and `before*` hooks run to completion before the operation applies, so a thrown error in `beforeInsert` rejects the insert. Errors thrown in `after*` hooks log a warning and never fail the operation that already succeeded.

## Events

`on(event, handler)` subscribes to engine events and `off(event, handler)` unsubscribes. The payloads are typed through `NarsilEventMap`.

| Event | Payload | Meaning |
| --- | --- | --- |
| `durabilityError` | `{ error }` | A write-ahead log append or a checkpoint write failed, on either tier. |
| `invalidationError` | `{ error }` | An invalidation adapter publish, subscribe, or reload failed. |
| `workerCrash` | `{ workerId, indexNames, error }` | A worker died; the engine reassigns its indexes. |
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

`memory.estimatedIndexBytes` sums `estimatedMemoryBytes` across every index in this Narsil instance. `memory.process` comes from `process.memoryUsage()` when the runtime exposes it. It measures the whole host process, so two Narsil instances in one Node.js process report the same process numbers, and browser runtimes return `null`. `memory.workers` lists `heapUsed`, `heapTotal`, and `external` for each active worker, and the array is empty before worker promotion.
