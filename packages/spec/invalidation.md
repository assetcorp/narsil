# Narsil Invalidation Protocol

This document defines the pub/sub invalidation protocol used to
coordinate multiple Narsil instances. When one instance mutates and
persists index data, the invalidation protocol notifies other
instances to evict stale partitions from their in-memory caches.

---

## Problem

When multiple processes or pods each run their own Narsil instance
against shared persistence (filesystem, Redis, S3), a mutation in
one instance makes the other instances' in-memory caches stale.
Without coordination, those instances serve outdated search results
until they restart or the data ages out of cache.

---

## Event Types

Two event types flow through the invalidation adapter:

### Partition Invalidation

Notifies instances that specific partitions have been updated and
should be reloaded from persistence.

```json
{
  "type": "partition",
  "indexName": "products",
  "partitions": [0, 3],
  "timestamp": 1700000000000,
  "sourceInstanceId": "a1b2c3d4-uuid"
}
```

| Field              | Description                             |
|--------------------|-----------------------------------------|
| `type`             | Always `"partition"`.                   |
| `indexName`        | The index whose partitions changed.     |
| `partitions`       | Partition IDs (zero-indexed) updated.   |
| `timestamp`        | When the mutation was persisted (ms).   |
| `sourceInstanceId` | UUID of the publishing instance.        |

### Statistics Broadcast

Shares partition statistics for the broadcast scoring mode (see
[algorithms.md](algorithms.md#distributed-bm25)).

```json
{
  "type": "statistics",
  "indexName": "products",
  "instanceId": "a1b2c3d4-uuid",
  "stats": {
    "totalDocs": 50000,
    "docFrequencies": { "widget": 120 },
    "totalFieldLengths": { "title": 250000 }
  }
}
```

| Field                     | Description                         |
|---------------------------|-------------------------------------|
| `type`                    | Always `"statistics"`.              |
| `indexName`               | The index these statistics describe.|
| `instanceId`              | UUID of the publishing instance.    |
| `stats.totalDocs`         | Total doc count across partitions.  |
| `stats.docFrequencies`    | Token-to-document-count map.        |
| `stats.totalFieldLengths` | Field-to-total-length map.          |

---

## Event Flow

The invalidation protocol follows a strict ordering to prevent
stale reads:

### Mutation Flow (Publishing Instance)

```text
1. Instance A receives a mutation (insert, update, or remove)
2. The mutation modifies the in-memory partition
3. The partition is marked dirty in the flush manager
4. The flush manager's timer or mutation threshold triggers:
   a. Serialize the dirty partition to .nrsl envelope
   b. Call persistence adapter's save() method
   c. WAIT for save() to confirm (complete successfully)
   d. THEN publish invalidation event
5. Flush is complete
```

### Invalidation Flow (Receiving Instance)

```text
1. Instance B's subscriber receives the event
2. Check sourceInstanceId: if self-published, ignore
3. Evict the specified partitions from in-memory cache
4. On the next query or mutation targeting those partitions:
   a. Load the fresh partition data from persistence
   b. Deserialize the .nrsl envelope
   c. Proceed with the operation
```

### Critical Ordering Requirement

**Publish AFTER persist, never before.** If an invalidation event
arrives at another instance before the data is persisted, the
receiving instance evicts its cache, attempts to reload, and gets
stale data. The flush sequence must be:

```text
serialize -> persist -> confirm persist -> publish invalidation
```

This ordering is non-negotiable and must be enforced by all
implementations.

---

## Statistics Broadcast Flow

For the broadcast scoring mode:

```text
1. On a configurable interval (default: 5 seconds):
   a. Collect local statistics from all partitions
   b. Publish a "statistics" event
2. Receiving instances:
   a. Merge incoming statistics with their own
   b. Store the merged result as "global statistics"
3. Queries with scoring: "broadcast" use the merged stats
```

Statistics are eventually consistent. The staleness window equals
the broadcast interval. This is acceptable for search relevance
because small IDF variations have minimal impact on result ordering.

### Merging Statistics

When multiple instances publish statistics, the coordinator merges:

```text
global.totalDocs =
  SUM(stats[i].totalDocs) for all instances i

global.docFrequencies[token] =
  SUM(stats[i].docFrequencies[token]) for all instances i

global.totalFieldLengths[field] =
  SUM(stats[i].totalFieldLengths[field]) for all instances i

global.averageFieldLengths[field] =
  global.totalFieldLengths[field] / global.totalDocs
```

Each instance's latest published statistics replace any previous
statistics from that instance (keyed by `instanceId`).

---

## Concurrency Model

The invalidation protocol provides **eventual consistency** with
**last-writer-wins** semantics.

### Guarantees

- Events are delivered at least once (adapters may deliver
  duplicates).
- Events from a single instance are delivered in order (FIFO per
  source).
- No global ordering guarantee across instances.

### Non-Guarantees

- No distributed locking.
- No leader election.
- No conflict resolution beyond last-writer-wins at the persistence
  layer.

### Conflict Scenario

If two instances mutate the same partition simultaneously:

1. Both persist their version to the same key.
2. The last write wins in the persistence layer.
3. Both publish invalidation events.
4. All instances (including the "loser") reload the winning version.
5. The "losing" mutations are lost.

This is acceptable for search workloads where the search index can
always be rebuilt from an external source of truth (database).
Applications requiring stronger consistency should coordinate at a
layer above Narsil (e.g., using distributed locks or a mutation
queue).

### Instance Identity

Each Narsil instance generates a unique `instanceId` (UUID v4 or
v7) at startup. This ID is used in:

- `sourceInstanceId` field of partition invalidation events (to skip
  self-published events).
- `instanceId` field of statistics broadcast events (to key
  per-instance statistics).

The `instanceId` is ephemeral; it changes on every restart.

---

## Built-in Adapter Behavior

### NoopInvalidation

- `publish()`: Does nothing.
- `subscribe()`: Does nothing.
- `shutdown()`: Does nothing.
- Use case: Single-instance deployment where no coordination is
  needed. This is the default.

### FilesystemInvalidation(directory)

- `publish()`: Writes a JSON marker file to the directory. Filename
  format: `<timestamp>_<instanceId>_<random>.json`.
- `subscribe()`: Polls the directory on an interval (default: 1
  second). Reads new marker files, calls the handler for each, then
  deletes processed files.
- `shutdown()`: Stops the polling timer.
- Use case: Multi-process deployment on a single machine.
- Marker files older than 60 seconds are cleaned up on each poll
  cycle (stale marker protection).

### BroadcastChannelInvalidation(channelName)

- `publish()`: Posts the event to a `BroadcastChannel` with the
  given name.
- `subscribe()`: Listens for messages on the `BroadcastChannel`,
  calls the handler.
- `shutdown()`: Closes the `BroadcastChannel`.
- Use case: Browser environment, cross-tab coordination.
- The channel name should be unique per application to avoid
  conflicts (e.g., `"narsil-invalidation"`).

---

## Encoding

Events are encoded as JSON for transport. The encoding must be
deterministic within a single implementation (field ordering does
not need to match across languages, but each language must
consistently produce the same encoding for the same event).

For binary transports (e.g., a future Redis adapter using
MessagePack), the event structure remains the same; only the
encoding changes. The adapter is responsible for encoding/decoding.
