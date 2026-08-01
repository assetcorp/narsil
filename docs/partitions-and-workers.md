# Partitions and workers

A large index splits across partitions, and its search moves onto worker threads as it grows. This guide covers partition routing, online rebalancing, worker promotion, and running several instances over one store.

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

**Single-process overhead.** Partitioning pays off when shards live on separate workers or hosts. Inside one Node.js thread, going from 1 to 20 partitions costs about 14% of insert throughput, 28% of median search latency, and 27% at p95, with no scaling upside. Keep `maxPartitions` low for single-process deployments and raise it once partitions fan out.

**Rebalance latency spikes.** While a reshape runs, worst-tick p95 latency can climb to about 25ms compared with around 11ms in steady state. Schedule reshapes during low-traffic windows, or pre-size the index with `maxDocsPerPartition` so mid-load reshapes never become necessary.

## Workers

Search can move off the main thread through worker threads on Node.js and Bun, or Web Workers in browsers and Deno. With `workers.enabled: true`, the engine starts in direct mode and promotes itself to the worker pool once any index passes `promotionThreshold` documents or all indexes together pass `totalPromotionThreshold`. The API stays identical before and after promotion.

```ts
const narsil = await createNarsil({
  workers: {
    enabled: true,
    count: 4,
    promotionThreshold: 10_000,
    totalPromotionThreshold: 50_000,
  },
})
```

Promotion emits the `workerPromote` event, and a crashed worker emits `workerCrash`; see [Events](observability.md#events). Worker heap usage appears in `getMemoryStats()`.

A worker thread receives an index's config by copy, so three conditions gate promotion. An inline `tokenizer` instance cannot cross the thread boundary, a `stopWords` function cannot either, and a worker holds no language other than English until a module registers one inside it. Register tokenizers and stop word sets by name (see [Named tokenizers and stop words](language-support.md#named-tokenizers-and-stop-words)), and point `workers.bootstrapModule` at a module that registers the languages and named analysis your indexes use; every worker imports it at startup.

```ts
const narsil = await createNarsil({
  workers: {
    enabled: true,
    bootstrapModule: new URL('./register-analysis.mjs', import.meta.url).href,
  },
})
```

An index that fails these checks stays on the main thread while eligible indexes promote, and the engine reports it once through the `workerPromoteFailure` event with `retryable: false`. A promotion that fails for a deterministic reason, such as a bootstrap module that does not register a needed language, blocks every later promotion and reports `retryable: false`; a transient failure reports `retryable: true` and retries on the next threshold check.

## Multi-instance invalidation

When several engine instances share one persistence backend, the invalidation adapter tells the others which partitions changed so they evict stale cache instead of serving old data. The package includes two adapters, and `@delali/narsil/invalidation/noop` stubs the interface for single-instance deployments:

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

Invalidation requires the snapshot durability tier, because the write-ahead log owns its directory exclusively and shares nothing between instances. A filesystem persistence adapter resolves to the write-ahead-log tier on its own, so the config above forces `tier: 'snapshot'`; without that line, `createNarsil` rejects the combination with `CONFIG_INVALID`. See [Durability](persistence-and-durability.md#durability) for the two tiers. Adapter failures never surface on the calls that trigger them, so subscribe to the `invalidationError` event in any multi-instance deployment; see [Events](observability.md#events).

The invalidation channel also carries partition statistics for the `broadcast` scoring mode: each instance publishes its statistics every five seconds and drops a peer's statistics after sixty seconds without an update. See [Scoring modes](full-text-search.md#scoring-modes). A custom adapter satisfies the `InvalidationAdapter` interface: `publish(event)`, `subscribe(handler)`, and `shutdown()`.
