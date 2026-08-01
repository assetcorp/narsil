# Configuration

The [package README](../packages/ts/README.md) covers installation and the first query. This guide covers every option `createNarsil` takes, and the tokenizer cache that all its instances share.

`createNarsil` accepts an optional `NarsilConfig` object. All fields are optional.

```ts
import { createNarsil } from '@delali/narsil'
import { createFilesystemPersistence } from '@delali/narsil/adapters/filesystem'

const narsil = await createNarsil({
  persistence: createFilesystemPersistence({ directory: './narsil-data' }),
  workers: { enabled: true, count: 4 },
})
```

## NarsilConfig

| Field | Type | Description |
| --- | --- | --- |
| `persistence` | `PersistenceAdapter` | Sets the storage backend for persisted partitions. See [Persistence](persistence-and-durability.md#persistence). |
| `invalidation` | `InvalidationAdapter` | Coordinates cache eviction across processes or tabs. See [Multi-instance invalidation](partitions-and-workers.md#multi-instance-invalidation). |
| `plugins` | `NarsilPlugin[]` | Registers lifecycle hooks for document and search operations. See [Plugins](observability.md#plugins). |
| `idGenerator` | `() => string` | Replaces the default UUID v7 generator for document ids. |
| `workers` | `WorkerConfig` | Controls the worker thread pool for parallel search. See [Workers](partitions-and-workers.md#workers). |
| `embedding` | `EmbeddingAdapter` | Sets the default adapter for auto-embedding text into vectors. See [Embedding adapters](embedding-adapters.md#embedding-adapters). |
| `embeddingAdapters` | `Record<string, EmbeddingAdapter>` | Registers named adapters that index configs reference by name. Names persist in index metadata, so durability recovery can rebind them. |
| `durability` | `DurabilityConfig` | Enables write-ahead logging and snapshots. See [Durability](persistence-and-durability.md#durability). |
| `analysis` | `AnalysisConfig` | Controls what the engine does with a recovered index whose stored terms no longer match its language module. See [Analysis revisions](language-support.md#analysis-revisions). |

## WorkerConfig

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `false` | Turns on the worker thread pool for search. |
| `count` | `number` | CPU cores minus one, clamped between 2 and 8 | Sets the number of worker threads to spawn. |
| `promotionThreshold` | `number` | `10000` | Sets the per-index document count that triggers promotion to workers. |
| `totalPromotionThreshold` | `number` | `50000` | Sets the document count across all indexes that triggers promotion. |
| `bootstrapModule` | `string` | none | Names a module every worker imports at startup so that the worker registers the languages, tokenizers, and stop word sets your indexes name. See [Workers](partitions-and-workers.md#workers). |

## AnalysisConfig

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `rebuild` | `'auto' \| 'manual'` | `'auto'` | Chooses who rebuilds a stale index. `'auto'` starts the rebuild in the background at startup, and `'manual'` leaves it to your call to `rebuildAnalysis`. |
| `onStaleAnalysis` | `(index, rebuild) => void \| Promise<void>` | none | Runs once for each stale index at startup, before an automatic rebuild begins. It receives the index name, the language, the stored and current revisions, the document count, and a function that starts the rebuild. |

See [Analysis revisions](language-support.md#analysis-revisions) for what makes an index stale and what a rebuild costs.

## Tokenizer cache

The stemmer normalization cache auto-sizes based on the runtime environment. On Node.js it reads container memory limits through `process.constrainedMemory()`, in browsers it checks `navigator.deviceMemory`, and it falls back to a fixed default elsewhere.

This cache is process-global and shared across all Narsil instances in the same process. Override the size by calling `configureNormalizationCache` once at startup, before creating any instances:

```ts
import { configureNormalizationCache, createNarsil } from '@delali/narsil'

configureNormalizationCache(500_000)

const narsil = await createNarsil()
```

The value clamps to a floor of 50,000 and a ceiling of 2,000,000 entries. Invalid values (NaN, Infinity, negative numbers, and zero) throw a `NarsilError` with code `CONFIG_INVALID`.

Four functions manage the cache:

- `configureNormalizationCache(maxSize)` sets the maximum cache size.
- `clearNormalizationCache()` drops all cached entries, which reclaims memory after one-off indexing.
- `resetNormalizationCache()` clears the cache and resets the size to the auto-detected default.
- `getNormalizationCacheSize()` returns the current number of cached entries for monitoring.
