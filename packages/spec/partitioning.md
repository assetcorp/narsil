# Narsil Partitioning Specification

A large index is split across several independent partitions, each holding a slice of the documents. This document defines how documents route to partitions, how a rebalance redistributes them, how a query fans out and merges, and how deep pagination works. Every implementation must follow these rules so that two implementations reading the same index return the same results.

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

## Auto-Partitioning

An index starts with one partition. The engine tracks the document count per partition and rebalances once the count crosses the configured threshold.

### Trigger

A rebalance triggers when any partition holds more than `maxDocsPerPartition` documents.

### Partition Count

```text
newPartitionCount = ceiling(totalDocs / maxDocsPerPartition)
```

The caller configures the threshold, and the engine derives the count. No caller sets the partition count directly.

### Configuration

```text
partitions {
  maxDocsPerPartition: integer   (default 50000)
  maxPartitions:       integer   (optional, no cap by default)
}
```

| Parameter | Default | Description |
|-----------|---------|-------------|
| `maxDocsPerPartition` | 50,000 | The document count above which a partition splits. |
| `maxPartitions` | none | An upper bound on the partition count. |

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

### Rebalance Steps

```text
1. COMPUTE the new partition count:
     newCount = ceiling(totalDocs / maxDocsPerPartition)
   Emit a partitionRebalance event.

2. CREATE newCount empty partitions.

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

4. REPLAY the queued writes in sequence-number order:
     for each entry ordered by seq:
       newPartitionId = fnv1a(entry.docId) modulo newCount
       apply the operation to that new partition
       skip the entry when it was applied already

5. SWAP the partition map. Reads pause for microseconds
   while the map changes. Old partitions stay alive until
   the reads already running against them finish, tracked
   by reference count.

6. RECLAIM the old partitions once those reads finish, and
   flush the new partitions to persistence.
```

### Concurrency During a Rebalance

| Operation | Behaviour |
|-----------|-----------|
| Reads | Run against the old partition layout. |
| Writes | Enter the write-ahead queue with a sequence number. |
| Queries | Fan out to the old partitions until the swap. |

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
6. Merge facet counts by summing them, when facets are requested.
7. Merge groups by group key, keeping maxPerGroup, when groups
   are requested.
8. Encode the cursor for the next page, when there is one.
9. Return the merged result.
```

### Hybrid Search

A query carrying both a text term and a vector runs the two searches independently and fuses the results. The text search fans out to the partitions as above. The vector search queries the per-field vector index directly and never fans out. See [Hybrid Search](vector-index.md#hybrid-search) for the fusion strategies and the coordinator flow.

### Merge Algorithm

Merging the K sorted lists, one per partition, uses a max-heap ordered by score, highest first:

1. Seed the heap with the first result from each partition.
2. Pop the highest-scoring result.
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

Narsil supports two ways to page through results.

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

The cursor is base64-encoded JSON:

```json
{
  "s": 4.523,
  "d": "doc-id-123"
}
```

| Field | Description |
|-------|-------------|
| `s` | The score, or the sort value, of the last document returned. |
| `d` | The document ID of that last document, used to break ties. |

#### Tiebreaking

Documents sharing a score are ordered by comparing `docId` lexicographically. That keeps pagination stable and deterministic across requests.

#### Cursor Flow

```text
First query:
  fan out to every partition with the limit
  merge the results and take the top `limit`
  encode a cursor from the last result's score and docId
  return the results and the cursor

Next query, carrying the cursor:
  decode the cursor
  fan out to every partition with the same cursor
  each partition seeks past every document whose score is
    below cursor.s, and past every document whose score
    equals cursor.s and whose docId sorts at or before
    cursor.d
  each partition returns up to `limit` results
  merge the results and take the top `limit`
  encode a new cursor
  return the results and the cursor
```

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

---

## Partition Lifecycle

### Creation

A new index starts with one partition, numbered 0, created empty with its data structures initialised.

### Splitting

Crossing the document threshold starts a rebalance, which creates the new partitions and redistributes the documents. See the rebalancing protocol above.

### Persistence

Each partition serialises on its own into a `.nrsl` envelope. The flush manager tracks which partitions are dirty and persists only those that changed since the last flush.

The persistence key is `<indexName>/partition_<N>`, so the partitions of an index named `products` are stored under `products/partition_0`, `products/partition_1`, and so on.

### Deletion

Dropping an index removes every partition from memory and deletes every persistence key belonging to it.

### Rebuild

A partition that fails its CRC32 check on load is corrupt. Calling `rebuildPartition(indexName, partitionId)` reloads it from persistence. With no persistence adapter configured, that call raises `PERSISTENCE_LOAD_FAILED`.
