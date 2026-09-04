# Configuration

The [package README](../packages/ts/README.md) covers installation and the first query. This guide covers every option `createNarsil` takes, and the tokenizer cache that all its instances share.

`createNarsil` accepts an optional `NarsilConfig` object. All fields are optional.

```ts
import { createNarsil } from '@delali/narsil'
import { createFilesystemPersistence } from '@delali/narsil/adapters/filesystem'

const narsil = await createNarsil({
  persistence: createFilesystemPersistence({ directory: './narsil-data' }),
  workers: { count: 4 },
})
```

## NarsilConfig

| Field | Type | Description |
| --- | --- | --- |
| `persistence` | `PersistenceAdapter` | Sets the storage backend for persisted partitions. See [Persistence](persistence-and-durability.md#persistence). |
| `invalidation` | `InvalidationAdapter` | Coordinates cache eviction across processes or tabs. See [Multi-instance invalidation](partitions-and-workers.md#multi-instance-invalidation). |
| `plugins` | `NarsilPlugin[]` | Registers lifecycle hooks for document and search operations. See [Plugins](observability.md#plugins). |
| `idGenerator` | `() => string` | Replaces the default UUID v7 generator for document ids. |
| `workers` | `WorkerConfig` | Controls the worker copies that answer keyword queries in parallel and the vector search pool. See [Worker copies](partitions-and-workers.md#worker-copies). |
| `embedding` | `EmbeddingAdapter` | Sets the default adapter for auto-embedding text into vectors. See [Embedding adapters](embedding-adapters.md#embedding-adapters). |
| `embeddingAdapters` | `Record<string, EmbeddingAdapter>` | Registers named adapters that index configs reference by name. Names persist in index metadata, so durability recovery can rebind them. |
| `durability` | `DurabilityConfig` | Enables write-ahead logging and snapshots. See [Durability](persistence-and-durability.md#durability). |
| `analysis` | `AnalysisConfig` | Controls what the engine does with a recovered index whose stored terms no longer match its language module. See [Analysis revisions](language-support.md#analysis-revisions). |
| `lifecycle` | `IndexLifecycleConfig` | Sets the limits under which the engine closes idle indexes and keeps their files on disk. See [Index lifecycle](persistence-and-durability.md#index-lifecycle). |

## WorkerConfig

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `true` on Node.js, Bun, and Deno, `false` in a browser | Allows worker copies and the vector search pool. Set it to `false` to hold the process to one thread, which leaves both pools absent. |
| `count` | `number` | CPU cores minus one, clamped between 2 and 8 | Sets the thread budget the keyword copies and the vector search pool share, half each. |
| `promotionThreshold` | `number` | `1000` | Sets the document count at which an index gains worker copies. |
| `idleTimeoutMs` | `number` | `300000`, or `lifecycle.idleTimeoutMs` where that is smaller | Sets how long an index may go without a read or a write before the engine drops its copies. A value above `lifecycle.idleTimeoutMs` fails with `CONFIG_INVALID`. |
| `bootstrapModule` | `string` | none | Names a module every worker imports at startup so that the worker registers the languages, tokenizers, and stop word sets your indexes name. See [Worker copies](partitions-and-workers.md#worker-copies). |

## AnalysisConfig

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `rebuild` | `'auto' \| 'manual'` | `'auto'` | Chooses who rebuilds a stale index. `'auto'` starts the rebuild in the background at startup, and `'manual'` leaves it to your call to `rebuildAnalysis`. |
| `onStaleAnalysis` | `(index, rebuild) => void \| Promise<void>` | none | Runs once for each stale index at startup, before an automatic rebuild begins. It receives the index name, the language, the stored and current revisions, the document count, and a function that starts the rebuild. |

See [Analysis revisions](language-support.md#analysis-revisions) for what makes an index stale and what a rebuild costs.

## Tokenizer cache

The engine sizes the stemmer normalization cache from what the runtime reports about the machine it runs on. On Node.js it reads the container memory limit through `process.constrainedMemory()`, in a browser it reads `navigator.deviceMemory`, and on any other runtime it takes a fixed default.

This cache is process-global and shared across all Narsil instances in the same process. Override the size by calling `configureNormalizationCache` once at startup, before creating any instances:

```ts
import { configureNormalizationCache, createNarsil } from '@delali/narsil'

configureNormalizationCache(500_000)

const narsil = await createNarsil()
```

The value clamps to a floor of 50,000 entries and a ceiling of 2,000,000. `configureNormalizationCache` throws a `NarsilError` with code `CONFIG_INVALID` for `NaN`, for `Infinity`, for a negative number, and for zero.

Four functions manage the cache:

- `configureNormalizationCache(maxSize)` sets the maximum cache size.
- `clearNormalizationCache()` drops all cached entries, which reclaims memory after one-off indexing.
- `resetNormalizationCache()` clears the cache and resets the size to the auto-detected default.
- `getNormalizationCacheSize()` returns the current number of cached entries for monitoring.
