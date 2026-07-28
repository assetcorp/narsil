# Narsil Invalidation Protocol

Several Narsil instances can run against one shared persistence backend, whether that backend is a filesystem, Redis, or object storage. Each instance holds its own in-memory copy of the partitions it serves, so a mutation in one instance leaves every other instance's copy out of date. The invalidation protocol closes that window: after an instance persists a mutated partition, it publishes an event, and every other instance evicts that partition so the next read reloads it from persistence.

Structure definitions below use a language-neutral notation. `List<T>` is an ordered collection of `T`, `Map<K, V>` is a mapping from keys to values, and `integer`, `text`, and `boolean` are the scalars they name. Each implementation expresses them in its own type system.

---

## Event Types

Two event types cross the invalidation adapter. Each carries a `type` discriminator and the `indexName` it concerns.

### Partition Invalidation

A partition event tells other instances that the listed partitions changed and must be reloaded from persistence.

```json
{
  "type": "partition",
  "indexName": "products",
  "partitions": [0, 3],
  "timestamp": 1700000000000,
  "sourceInstanceId": "a1b2c3d4-uuid"
}
```

| Field | Description |
|-------|-------------|
| `type` | Always `partition`. |
| `indexName` | The index whose partitions changed. |
| `partitions` | The partition IDs that changed, numbered from zero. |
| `timestamp` | Milliseconds since the Unix epoch, taken when the mutation was persisted. |
| `sourceInstanceId` | The UUID of the publishing instance. |

### Statistics Broadcast

A statistics event shares one instance's partition statistics so that other instances can score under the broadcast mode. See [Distributed BM25](algorithms.md#distributed-bm25).

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

| Field | Description |
|-------|-------------|
| `type` | Always `statistics`. |
| `indexName` | The index these statistics describe. |
| `instanceId` | The UUID of the publishing instance. |
| `stats.totalDocs` | The document count across every partition the instance holds. |
| `stats.docFrequencies` | A map from token to the number of documents containing it. |
| `stats.totalFieldLengths` | A map from field name to the summed length of that field. |

---

## Event Flow

### Publishing Instance

An instance that accepts a mutation follows this order:

1. The mutation modifies the in-memory partition.
2. The flush manager marks the partition dirty.
3. The flush timer fires, or the mutation count reaches the flush threshold.
4. The instance serialises each dirty partition into a `.nrsl` envelope.
5. The instance calls the persistence adapter's `save` method and waits for it to confirm.
6. The instance publishes one partition event naming the partitions that saved successfully.

A partition whose save failed stays dirty and is retried on a later flush, and its ID must not appear in the published event.

### Receiving Instance

1. The subscriber receives the event.
2. It compares `sourceInstanceId` with its own instance ID and ignores the event when the two match.
3. It evicts the named partitions from its in-memory cache.
4. On the next query or mutation that targets one of those partitions, it loads the bytes from persistence, deserialises the `.nrsl` envelope, and proceeds.

### Ordering Requirement

Publish after the persist confirms, never before. An event that arrives before the data is written makes the receiving instance evict its cache and reload the old bytes, which leaves it stale with no further event coming. The flush sequence is normative:

```text
serialise -> persist -> confirm persist -> publish invalidation
```

Every implementation must enforce this order.

---

## Statistics Broadcast Flow

The broadcast scoring mode runs on a timer:

1. On a configurable interval, recommended at 5 seconds, an instance collects the statistics of every partition it holds and publishes one statistics event.
2. A receiving instance merges the incoming statistics with its own and stores the result as its global statistics.
3. A query that asks for `scoring: "broadcast"` scores against those merged statistics.

Statistics are eventually consistent, and the staleness window equals the broadcast interval. Search relevance tolerates that window because small variations in inverse document frequency barely move result ordering.

### Merging Statistics

An instance merges the latest statistics from every instance, its own included:

```text
global.totalDocs =
  SUM over instances i of stats[i].totalDocs

global.docFrequencies[token] =
  SUM over instances i of stats[i].docFrequencies[token]

global.totalFieldLengths[field] =
  SUM over instances i of stats[i].totalFieldLengths[field]

global.averageFieldLengths[field] =
  global.totalFieldLengths[field] / global.totalDocs
```

Statistics are keyed by `instanceId`, so a fresh event from an instance replaces whatever that instance published before. When `global.totalDocs` is zero, every average field length is zero.

---

## Concurrency Model

The protocol gives eventual consistency with last-writer-wins semantics.

An implementation may rely on these guarantees:

- Every event is delivered at least once, so an adapter may deliver duplicates.
- Events from one instance arrive in the order that instance published them.
- No ordering holds across instances.

The protocol provides none of the following:

- Distributed locking.
- Leader election.
- Conflict resolution beyond last-writer-wins at the persistence layer.

### Delivery Limits

Delivery is best effort across subscriber lifetimes. The at-least-once guarantee above covers a subscribed instance; an instance that is not subscribed when an event is published, because it is offline, restarting, or not yet started, never receives that event. A missed partition event leaves the instance serving its stale copy until the next event for that index arrives. An application that cannot tolerate that window must reload on its own schedule or coordinate above Narsil.

### Conflicting Mutations

When two instances mutate the same partition at the same time, both persist their version under the same key and the later write replaces the earlier one. Both then publish invalidation events, and every instance, including the one whose write was replaced, reloads the surviving version. The replaced mutations are gone.

Search workloads accept that outcome because the index can always be rebuilt from the system of record the documents came from. An application that needs stronger consistency must coordinate above Narsil, with a distributed lock or a single mutation queue.

### Instance Identity

Each instance generates a unique `instanceId` (UUID v4 or v7) at startup and uses it in two places: as `sourceInstanceId` on partition events, so an instance can skip its own, and as `instanceId` on statistics events, so merged statistics stay keyed per instance. The value is ephemeral and changes on every restart.

---

## Built-in Adapter Behaviour

### NoopInvalidation

`publish`, `subscribe`, and `shutdown` all do nothing. This is the default, and it suits a single-instance deployment where no instance needs to hear from another.

### FilesystemInvalidation(directory)

- `publish` writes a JSON marker file into the directory, named `<timestamp>_<instanceId>_<random>.json`.
- `subscribe` polls the directory on an interval, recommended at 1 second. It reads new marker files, calls the handler for each, and deletes the files it processed.
- `shutdown` stops the polling timer.
- Each poll cycle also deletes marker files older than 60 seconds, so a crashed instance leaves nothing behind.

This adapter suits several processes on one machine sharing a directory.

### BroadcastChannelInvalidation(channelName)

- `publish` posts the event to a broadcast channel of the given name.
- `subscribe` listens on that channel and calls the handler for each message.
- `shutdown` closes the channel.

This adapter suits a browser deployment coordinating across tabs. Give the channel a name unique to the application, such as `narsil-invalidation`, so two applications on one origin never cross.

---

## Encoding

Events are encoded as JSON for transport. Each implementation must encode a given event the same way every time; field ordering need not match across languages.

A binary transport, such as a Redis adapter carrying MessagePack, keeps the same event structure and changes only the encoding. Encoding and decoding are the adapter's responsibility.
