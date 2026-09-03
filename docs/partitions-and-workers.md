# Partitions and workers

A large index splits across partitions, and its search moves onto worker threads as it grows. This guide covers partition routing, online rebalancing, worker copies, and running several instances over one store.

## Partitions and rebalancing

An index starts with the partition count set by `partitions.maxPartitions`, which defaults to 1. Documents route to partitions by FNV-1a hash of their id, which keeps routing deterministic across processes and languages. `partitions.maxDocsPerPartition` caps capacity: when an index holds `maxDocsPerPartition * partitionCount` documents, further inserts fail with `PARTITION_CAPACITY_EXCEEDED`.

```ts
await narsil.createIndex('logs', {
  schema: { message: 'string' },
  partitions: { maxPartitions: 4, maxDocsPerPartition: 250_000, watermark: 0.8 },
})

await narsil.rebalance('logs', 8)

await narsil.updatePartitionConfig('logs', { maxDocsPerPartition: 500_000 })
```

`rebalance(indexName, targetPartitionCount)` reshapes the index to a new partition count while it stays online. Writes arriving during the reshape buffer in a write-ahead queue and replay in order when the reshape completes, and queries keep answering throughout.

`updatePartitionConfig` adjusts `maxDocsPerPartition`, `maxPartitions`, and `watermark` at runtime, and it writes the new limits into durability metadata, so they survive recovery. Three checks reject a change: a `maxPartitions` below the current partition count and a new capacity (`maxDocsPerPartition` times the current partition count) below the current document count both fail with `PARTITION_CAPACITY_EXCEEDED`, and any change while a rebalance runs fails with `PARTITION_REBALANCING_BACKPRESSURE`.

`partitions.watermark` adds an early warning before the hard cap. Set it to a fraction above 0 and at most 1, and the engine emits the `partitionWatermark` event, carrying the document count, the capacity, and the partition count, when an insert or a partition config change carries the index across `watermark * capacity` documents. The event then stays quiet while the count stays at or above that threshold, and it re-arms when the count drops back below it or when a rebalance or config change raises the capacity, so a listener can trigger one rebalance per crossing without debouncing. `createIndex` and `updatePartitionConfig` both validate the partition fields and reject a non-positive-integer cap or a watermark outside the range with `CONFIG_INVALID`.

Two measured costs are worth knowing before raising partition counts:

**Single-process overhead.** Partitioning pays off where the shards run on separate workers or on separate hosts. Inside one Node.js thread, going from 1 to 20 partitions costs about 14% of insert throughput, 28% of median search latency, and 27% at p95, and it buys no scaling in return. Keep `maxPartitions` low for a single-process deployment, and raise it once the partitions fan out.

**Rebalance latency spikes.** While a reshape runs, worst-tick p95 latency can climb to about 25ms compared with around 11ms in steady state. Schedule reshapes during low-traffic windows, or pre-size the index with `maxDocsPerPartition` so mid-load reshapes never become necessary.

## Worker copies

On Node.js, Bun, and Deno the engine holds a copy of each large index on every worker thread, so that keyword search uses every core without a setting. An index gains its copies once it holds `promotionThreshold` documents, which defaults to 1,000, because below that a query finishes sooner than the hop to a worker thread takes. A browser page holds no copies, and `workers.enabled: false` holds a Node.js process to one thread, which also leaves the vector search pool absent. The API stays identical whether or not an index holds copies.

```ts
const narsil = await createNarsil({
  workers: {
    count: 4,
    promotionThreshold: 1_000,
    idleTimeoutMs: 300_000,
  },
})
```

`workers.count` is the thread budget the keyword copies and the vector search pool share between them, half each. It defaults to the host's cores minus one, between 2 and 8, so a budget of 4 runs two keyword copies and two vector search workers.

The engine sends a whole query to the copy with the fewest queries in flight, so concurrent queries spread across the copies. A query that names several partitions may split across idle copies, each answering its own partitions, before the engine merges the answers. On SciFact, a query answers with the same hits, scores, count, and facets whether copies are on or off. At 16 concurrent clients the engine answers about three times as many queries per second with copies on as it does on one thread.

The engine emits `workerPromote` when an index gains its copies and `workerCrash` when a worker dies; see [Events](observability.md#events). `getMemoryStats()` reports each worker's heap and, under `workerCopies`, whether each index holds copies now.

An index that receives no read or write for `idleTimeoutMs`, five minutes by default, gives up its copies and keeps its main copy open. The next read or write on that index loads the copies again while the main copy answers it, and `getMemoryStats().workerCopies` counts each reload under `reloadCount`. Where you also set `lifecycle.idleTimeoutMs`, the copies drop before the index closes. `createNarsil` rejects a `workers.idleTimeoutMs` above the lifecycle interval with `CONFIG_INVALID`, and where you leave `workers.idleTimeoutMs` unset the copies take the smaller of five minutes and that interval. A batch that arrives while the copies reload runs on the main copy, and the copies receive its writes once they hold the index.

When a worker dies, the survivors keep answering, and after a delay the engine spawns a replacement, loads every copy onto it, and puts it back into rotation. A write to a copy while the replacement loads it reaches the replacement once the load finishes, and the main copy answers queries on that index in the meantime. When every worker in the pool dies, the engine drops the pool and answers from the main copy, and the next request after the delay starts a new pool and loads the copies again. The delay starts at one second and doubles on each failed attempt up to a minute. A pool that fails to start, because its bootstrap module fails to import for instance, waits the same way, and `workerPromoteFailure` fires once per attempt.

A worker thread receives an index's config by copy, so three conditions gate whether an index can gain copies. An inline `tokenizer` instance cannot cross the thread boundary, a `stopWords` function cannot either, and a worker holds no language other than English until a module registers one inside it. Register tokenizers and stop word sets by name (see [Named tokenizers and stop words](language-support.md#named-tokenizers-and-stop-words)), and point `workers.bootstrapModule` at a module that registers the languages and named analysis your indexes use; every worker imports it at startup.

```ts
const narsil = await createNarsil({
  workers: {
    bootstrapModule: new URL('./register-analysis.mjs', import.meta.url).href,
  },
})
```

An index that fails these checks stays on the main thread while eligible indexes gain copies, and the engine reports it once through the `workerPromoteFailure` event with `retryable: false`. A pool start that fails for a deterministic reason, such as a bootstrap module that does not register a needed language, blocks every later attempt and reports `retryable: false`; a transient failure reports `retryable: true`, and the engine tries again on the next write or read that finds an index at the threshold.

## How a batch reaches the worker copies

Each worker holds a copy of the whole index, because any copy may answer any query. Every copy therefore needs the documents you insert, and the way they arrive changes what a large batch costs.

A batch of 64 documents or more, on an index the pool already holds, takes the segment path. The engine analyses each document once, builds one segment per partition from the result, and sends that segment to the copies. Where the runtime offers `SharedArrayBuffer`, the engine freezes the segment into shared memory and every copy attaches the same bytes, so the engine pays for the analysis and the posting lists once, however many copies you run. Where the runtime offers none, which includes a browser page that is not cross-origin isolated, the engine sends the segment to each copy to merge instead, and that path indexes the same documents and answers the same queries.

A smaller batch, and any insert on an index with no worker copies, takes the per-document path instead, which builds no segment at all.

Segments accumulate as you keep inserting, so a partition holding eight of them compacts them into one in the background while queries keep answering. Once no write has reached the index for one second, a worker merges every remaining segment of each partition into one, on every copy and on the main copy alike, so that a copy answers a query about as fast as the main copy does alone. All of this runs without configuration, and `getMemoryStats()` reports what each worker holds.

## Multi-instance invalidation

When several engine instances share one persistence backend, the invalidation adapter publishes which partitions have changed, so that the other instances evict their stale cache instead of answering from it. The package includes two adapters, and `@delali/narsil/invalidation/noop` stubs the interface for single-instance deployments:

| Adapter | Import | Use case |
| --- | --- | --- |
| Filesystem | `@delali/narsil/invalidation/filesystem` | The adapter coordinates processes on one machine through marker files. |
| BroadcastChannel | `@delali/narsil/invalidation/broadcast-channel` | The adapter coordinates browser tabs through a BroadcastChannel. |

```ts
import { createNarsil } from '@delali/narsil'
import { createFilesystemPersistence } from '@delali/narsil/adapters/filesystem'
import { createFilesystemInvalidation } from '@delali/narsil/invalidation/filesystem'

const narsil = await createNarsil({
  persistence: createFilesystemPersistence({ directory: './narsil-data' }),
  invalidation: createFilesystemInvalidation({ directory: './narsil-data', pollInterval: 1000 }),
  durability: { tier: 'snapshot' },
})
```

Invalidation requires the snapshot durability tier, because the write-ahead log requires exclusive use of its directory and passes nothing between instances. A filesystem persistence adapter resolves to the write-ahead-log tier on its own, so the config above sets `tier: 'snapshot'`; without that line, `createNarsil` rejects the combination with `CONFIG_INVALID`. See [Durability](persistence-and-durability.md#durability) for the two tiers. An adapter failure never appears on the call that triggered it, so subscribe to the `invalidationError` event in any multi-instance deployment; see [Events](observability.md#events).

The invalidation channel also carries partition statistics for the `broadcast` scoring mode: each instance publishes its statistics every five seconds and drops a peer's statistics after sixty seconds without an update. See [Scoring modes](full-text-search.md#scoring-modes). A custom adapter satisfies the `InvalidationAdapter` interface: `publish(event)`, `subscribe(handler)`, and `shutdown()`.
