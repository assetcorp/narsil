# Narsil Partitioning Specification

A large index is split across several independent partitions, each holding a slice of the documents. This document defines how documents route to partitions, how a rebalance redistributes them, how a query fans out and merges, how deep pagination works, and how a listing pages through stored documents. Every implementation must follow these rules so that two implementations reading the same index return the same results.

Structure definitions use a language-neutral notation. `List<T>` is an ordered collection of `T`, `Map<K, V>` a mapping from keys to values, and `T or absent` a value that may be missing; each implementation expresses these in its own type system.

---

## Overview

A partition is a self-contained unit holding its own inverted index, document store, field indexes, geopoint storage, and statistics. Vector data is held apart from partitions in per-field vector indexes; see [vector-index.md](vector-index.md).

Partitioning never changes the caller's view. The API is the same whether an index has one partition or sixteen.

---

## Document Routing

Hash-based routing assigns each document to exactly one partition:

```text
partitionId = fnv1a(docId) modulo partitionCount
```

`fnv1a` is the 32-bit FNV-1a hash defined in [algorithms.md](algorithms.md#fnv-1a-hash).

Three properties follow from that rule:

- The same `docId` routes to the same partition for a given `partitionCount`, so routing is deterministic and needs no lookup table.
- FNV-1a spreads hash values evenly, so documents distribute evenly across partitions.
- Changing `partitionCount` changes the target for most documents, so a change in count requires a full rebalance.

To fetch a document by ID, compute its partition with the same hash and query that partition alone. A single-document operation never fans out.

---

## Capacity

An index starts with `maxPartitions` partitions, numbered from 0, and the option defaults to one. The partition count changes only through an explicit rebalance. The engine never splits a partition on its own.

### Configuration

```text
partitions {
  maxDocsPerPartition: integer   (optional, no default)
  maxPartitions:       integer   (optional, defaults to 1)
  watermark:           float     (optional, above 0 and at most 1)
}
```

`maxDocsPerPartition` and `maxPartitions` must each be a positive integer, and `watermark` must be above 0 and at most 1. A value outside its constraint raises `CONFIG_INVALID`.

### Capacity Enforcement

With `maxDocsPerPartition` set, the index capacity is `maxDocsPerPartition × partitionCount`. An insert fails with `PARTITION_CAPACITY_EXCEEDED` once the document count, together with any writes buffered for an active rebalance, reaches the capacity. During a rebalance, the smaller of the current and target partition counts sets the capacity, so every acknowledged write fits the new layout. With `maxDocsPerPartition` absent, the engine enforces no capacity.

A rebalance whose target count is above `maxPartitions` fails with `PARTITION_CAPACITY_EXCEEDED`. A configuration update fails the same way when its new capacity is below the current document count or its `maxPartitions` is below the current partition count.

### Watermark Event

With `maxDocsPerPartition` and `watermark` both set, the engine emits a `partitionWatermark` event when the document count reaches `watermark × capacity`:

```text
partitionWatermark {
  indexName:      string
  documentCount:  integer
  capacity:       integer
  partitionCount: integer
}
```

The engine emits the event once per crossing. The event arms again when the document count falls below the threshold or the capacity grows.

### Choosing a Partition Count

The caller picks the target count and passes it to the rebalance call. `ceiling(totalDocs / maxDocsPerPartition)` is the smallest count whose capacity holds the current documents, so a caller should add headroom above it.

---

## Rebalancing Protocol

A rebalance redistributes every document across a new set of partitions while reads and writes continue.

### Sequence Numbers

Every write, whether an insert, an update, or a remove, receives a sequence number that increases monotonically. Replay uses those numbers to stay idempotent.

### Write-Ahead Queue

Writes that arrive during a rebalance are buffered in a bounded write-ahead queue:

```text
WriteAheadEntry {
  seq:      integer            (64-bit, increases monotonically)
  op:       "insert" or "remove" or "update"
  docId:    string
  document: object or absent   (present for insert and update)
}
```

The queue holds a bounded number of entries. A write that arrives once the queue is full fails with `PARTITION_REBALANCING_BACKPRESSURE`, which tells the caller to retry after a short delay.

The engine validates a write and resolves its embeddings before buffering it, so a buffered document replays without further preparation. Batch writes buffer entry by entry under the same rules.

With durability configured, the engine appends a buffered write to the write-ahead log before acknowledging it, so a crash during a rebalance loses no acknowledged write.

### Rebalance Steps

```text
1. VALIDATE the caller's target count. It must be a
   positive integer, it must differ from the current
   count, and it must not exceed maxPartitions.

2. CREATE newCount empty partitions, where newCount is
   the validated target.

3. REDISTRIBUTE every document held by the old partitions:
     for each document:
       newPartitionId = fnv1a(docId) modulo newCount
       insert it into that new partition
   Process in chunks of 1,000 documents and yield to the
   host scheduler between chunks, so the rebalance never
   holds the processor for long. Each runtime picks its own
   yielding mechanism.
   Vector data needs no redistribution, because vector
   indexes hold no partition assignment.

4. SWAP the partition map. Reads pause for microseconds
   while the map changes. Old partitions stay alive until
   the reads already running against them finish, tracked
   by reference count. Emit a partitionRebalance event
   once the swap completes.

5. REPLAY the queued writes in sequence-number order:
     for each entry ordered by seq:
       newPartitionId = fnv1a(entry.docId) modulo newCount
       apply the operation to that new partition
       skip the entry when it was applied already
   An update whose document is absent applies as an insert,
   matching write-ahead-log recovery.

6. PERSIST the new layout. Write the index metadata, take
   a checkpoint covering every new partition, and remove
   the log segments of every partition past the new count.

7. RESYNCHRONISE every worker replica of the index, then
   drain and replay any writes buffered while steps 5 to 7
   ran, and repeat until the queue is empty.

8. RECLAIM the old partitions once the reads against them
   finish.
```

### Concurrency During a Rebalance

| Operation | Behaviour |
|-----------|-----------|
| Reads | Run against the old partition layout. |
| Writes | Enter the write-ahead queue with a sequence number. |
| Queries | Fan out to the old partitions until the swap. |

A second rebalance of an index already rebalancing fails with `PARTITION_REBALANCING_BACKPRESSURE`. Rebalances of different indexes run independently.

### Cooperative Yielding

Redistribution yields between chunks so that a rebalance of a large index never blocks other work for long. A single-threaded runtime must return control to its host scheduler between chunks. A runtime with threads may instead run the whole redistribution on a background thread.

---

## Query Fan-Out and Merge

A search against a multi-partition index runs on a coordinator that queries every partition and merges what comes back.

### Fan-Out Steps

```text
1. Send the query to every partition in parallel.
2. Each partition searches its own index:
     tokenise the query terms
     look the tokens up in the inverted index
     score the matching documents with BM25
     apply the filters
     return the scored results, up to offset + limit
3. Collect the results from every partition.
4. Merge them into one sorted list.
5. Apply limit and offset, or the searchAfter cursor.
6. Count facets over every matching document and sum the counts,
   when facets are requested.
7. Merge groups by group key, keeping maxPerGroup, when groups
   are requested.
8. Encode the cursor for the next page, when there is one.
9. Return the merged result.
```

### Hybrid Search

A query carrying both a text term and a vector runs the two searches independently and fuses the results. The text search fans out to the partitions as above. The vector search queries the per-field vector index directly and never fans out. See [Hybrid Search](vector-index.md#hybrid-search) for the fusion strategies and the coordinator flow.

### Merge Algorithm

Merging the K sorted lists, one per partition, uses a max-heap ordered by score, highest first, with ties in document ID order as [String Ordering](algorithms.md#string-ordering) defines. A query carrying a sort orders the heap by the [sort value order](algorithms.md#sort-value-order) instead.

The merge runs:

1. Seed the heap with the first result from each partition.
2. Pop the top result.
3. Push the next result from the partition the popped result came from, when that partition has one.
4. Repeat until `offset + limit` results have been collected.

That costs O(N log K), where N is the number of results collected and K is the partition count.

### Scoring Modes

The scoring mode decides how many round trips the fan-out takes.

**Local**, the default, takes one round trip, and each partition scores with its own statistics.

**DFS**, for distributed frequency statistics, takes two round trips. The first collects `totalDocs`, `docFrequencies`, and `avgFieldLengths` from each partition. The coordinator then sums `totalDocs` and `docFrequencies` and computes weighted `avgFieldLengths`. The second sends the query together with those global statistics, and each partition rescores against globally correct inverse document frequencies.

**Broadcast** takes one round trip. The coordinator already holds global statistics, refreshed periodically through the invalidation adapter, and sends them with the query.

The distributed scoring formulas are in [Distributed BM25](algorithms.md#distributed-bm25).

---

## Deep Pagination

Narsil supports two ways to page through results, and one window bounds how deep either reaches.

A query pages no further than the first 10,000 results, which is the result window. `offset + limit` must not exceed the window, and a request beyond it raises `SEARCH_RESULT_WINDOW_EXCEEDED`, which names the cursor as the way to reach the rest. A cursor pages past the window, because each page returns the `limit` results that follow its anchor. The engine considers every matching document when a query carries a sort, a group, a `threshold`, or a `termMatch` other than `any`, whatever the window. `count` reports the number of matching documents exactly.

### Offset and Limit

Each partition returns `offset + limit` results, and the coordinator merges them and skips the first `offset`:

```text
Query:              { term: "widget", offset: 1000, limit: 20 }
Each partition:     returns up to 1020 results
Coordinator:        merges all, skips 1000, returns 20
```

Cost grows with the offset, because every partition must build and transfer `offset + limit` results.

### searchAfter Cursor

A cursor makes each partition seek to the cursor point and return `limit` results from there, which costs O(limit) per partition instead of O(offset + limit).

#### Cursor Format

The cursor is base64-encoded JSON. One format serves search pagination and [Document Listing](#document-listing). A search without a sort encodes:

```json
{
  "v": 2,
  "a": "doc-id-123",
  "s": 4.523
}
```

A sorted search or a sorted listing encodes:

```json
{
  "v": 2,
  "a": "doc-id-123",
  "k": ["Widget", 42],
  "o": "[[\"title\",\"asc\"],[\"price\",\"desc\"]]"
}
```

| Field | Description |
|-------|-------------|
| `v` | The cursor format version, 2. A reader rejects any other value. |
| `a` | The document ID of the last document returned, the anchor. Always present. |
| `s` | The score of that document. Present when the query carries no sort. |
| `k` | The raw sort values of that document, one per sort field in sort order. Present when a sort is set. |
| `o` | The sort's fields and directions, serialised as the JSON text `[["field","asc"],...]`. Present exactly when `k` is. |

A cursor carries `s` or `k`, never both. A search without a sort anchors on `s` and `a`, a sorted search or listing anchors on `k` and `a`, and an unsorted listing anchors on `a` alone.

A reader must reject a cursor, raising `SEARCH_INVALID_CURSOR`, when any rule below fails:

- The encoded cursor is longer than 40,960 characters, which covers the largest payload the rules below allow.
- `v` is not 2, or `a` is empty, missing, or longer than 512 code points.
- `k` holds more than 8 values, or a value that is not a string of at most 512 code points, a finite number, a boolean, or null.
- `o` and `k` do not arrive together, or `o` differs from the request's own sort.

A sort names at most 8 fields, because the cursor carries one value per field. More raises `SEARCH_INVALID_FIELD`. A sort field name holds at most 255 characters, and a longer name raises `SEARCH_INVALID_FIELD` as well.

#### Tiebreaking

Documents sharing a score, or sharing every sort value, order by document ID, ascending in [code point order](algorithms.md#code-point-order), whatever the sort directions. That keeps pagination stable across requests and identical across implementations.

#### Cursor Flow

```text
First query:
  fan out to every partition with the limit
  merge the results and take the top `limit`
  encode a cursor from the last result
  return the results and the cursor

Next query, carrying the cursor:
  decode the cursor, rejecting it when `o` differs from
    the request's sort
  fan out to every partition with the same cursor
  each partition seeks past every document that orders at
    or before the anchor: by score then document ID for a
    search without a sort, and by the sort value order
    then document ID for a sorted one
  each partition returns up to `limit` results
  merge the results and take the top `limit`
  encode a new cursor
  return the results and the cursor
```

---

## Document Listing

The listing operation pages through the stored documents of an index without a search. It serves exports, browsing, and administrative views.

```text
list(indexName, params) -> {
  documents: List<{ id: string, document: Map<string, value> }>
  cursor:    string or absent   (absent on the last page)
  total:     uint32             (how many documents the listing covers)
}

params {
  cursor:   string or absent
  limit:    uint32 or absent            (default 10, capped at 10,000, raised to 1 when below 1)
  filters:  FilterExpression or absent
  sort:     List<SortField> or absent
  document: projection or absent
}
```

`FilterExpression`, `SortField`, and the projection form match the Narsil query API, as [transport.md](distribution/transport.md#queryparams) describes.

The listing behaves as follows:

- Without `sort`, documents come in document ID order, ascending in [code point order](algorithms.md#code-point-order).
- With `sort`, documents come in the [sort value order](algorithms.md#sort-value-order), and the sort obeys the 8-field cap of [Cursor Format](#cursor-format).
- `filters` narrows the listing to the documents it accepts, and `total` counts those documents.
- Each page holds the documents that order strictly after the cursor's anchor, and the cursor uses [Cursor Format](#cursor-format): an unsorted listing anchors on `a` alone, and a sorted one carries `k` and `o`.
- A listing gives no snapshot guarantee, so a write that lands between two pages may appear in a later page or not at all. The anchor still bounds every page, so no page repeats a document the cursor has passed.

---

## Worker Assignment

In worker mode, partitions are assigned to workers by hash:

```text
workerId = fnv1a(indexName) modulo workerCount
```

Every partition of one index runs on one worker, so a per-index operation needs no coordination between workers while different indexes still spread across the pool.

The default worker count is:

```text
workerCount = max(2, cpuCount - 1)
```

capped at 8. A caller overrides it through `NarsilConfig.workers.count`.

### What Crosses into a Worker

A worker runs in its own memory with its own registries, and the engine reaches it by passing messages, so data crosses and code does not. A schema, a stop word set given as a set, and a pair of BM25 parameters all cross. A tokeniser instance, a stop word function, a stemmer, and a language module are code, and none of them crosses.

An index therefore reaches a worker only when its configuration gives a name for each part of its analysis:

- The `language` setting names a language, and the worker resolves that name against its own language registry.
- The `tokenizer` and `stopWords` settings name registry entries, and the worker resolves each name against its own analysis registry, as [Analysis Registry](adapters.md#analysis-registry) describes.

### Worker Bootstrap

A worker starts with the engine's own registrations alone, which cover English and nothing further. The caller names a module that every worker imports before it builds any index, and that module registers whatever the caller's indexes name:

```text
workers {
  bootstrapModule: string   (optional, a module URL)
}
```

The engine sends the module to every worker and waits for each import to finish before it sends any other instruction. An import that fails, and a module that registers nothing an index names, each fail promotion and report it.

### Promotion Failure

The engine reads every index configuration before it starts a worker, and it refuses to promote when a configuration cannot cross:

| Condition | Report |
|-----------|--------|
| An index supplies a tokeniser instance. | The engine names the index and asks the caller to register the tokeniser and name it in the index configuration. |
| An index supplies a stop word function. | The engine names the index and asks the caller to register the function and name it in the index configuration. |
| An index names a language other than `english` while no bootstrap module is configured. | The engine names the index and the language, and asks the caller to configure a bootstrap module that registers it. |

A refusal raises `CONFIG_INVALID`, and the engine emits a `workerPromoteFailure` event carrying the reason, the error, and whether the engine will check again. A configuration failure fails the same way each time, so the engine reports it once and checks no further. A transient failure, such as a worker that fails to start, leaves the check in place. Under both failures the index answers every query in the calling thread, so a failed promotion costs throughput and leaves results correct.

---

## Partition Lifecycle

### Creation

A new index starts with `maxPartitions` partitions, defaulting to one, numbered from 0 and created empty with their data structures initialised.

### Splitting

An explicit rebalance call changes the partition count, following the rebalancing protocol above. The `partitionWatermark` event tells the caller when an index approaches its capacity.

### Persistence

Each partition serialises on its own into a `.nrsl` envelope. The flush manager tracks which partitions are dirty and persists only those that changed since the last flush.

The persistence key is `<indexName>/partition_<N>`, so the partitions of an index named `products` are stored under `products/partition_0`, `products/partition_1`, and so on.

### Deletion

Dropping an index removes every partition from memory and deletes every persistence key belonging to it.

### Rebuild

A partition that fails its CRC32 check on load is corrupt. Calling `rebuildPartition(indexName, partitionId)` reloads it from persistence. With no persistence adapter configured, that call raises `PERSISTENCE_LOAD_FAILED`.
