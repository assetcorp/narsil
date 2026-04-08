# Narsil Partitioning Specification

This document defines the partitioning system used by Narsil to
distribute large indexes across multiple independent shards. It
covers hash-based routing, auto-partitioning triggers, the
rebalancing protocol, query fan-out and merge, and deep pagination.
All Narsil implementations must follow these rules for consistent
behaviour.

---

## Overview

Large indexes are automatically split into multiple partitions
(shards). Each partition is an independent unit with its own
inverted index, document store, field indexes, geopoint storage,
and statistics. Vector data is stored separately in per-field
vector indexes (see [vector-index.md](vector-index.md)).
Partitioning is transparent to the caller; the API is identical
whether an index has 1 partition or 16.

---

## Document Routing

Documents are assigned to partitions using hash-based routing:

```text
partitionId = fnv1a(docId) % partitionCount
```

Where `fnv1a` is the FNV-1a hash function (see
[algorithms.md](algorithms.md#fnv-1a-hash)).

### Routing Properties

- **Deterministic:** The same `docId` always routes to the same
  partition for a given `partitionCount`.
- **Uniform distribution:** FNV-1a produces well-distributed hash
  values, so documents distribute evenly across partitions.
- **Dependent on partition count:** Changing `partitionCount`
  changes the routing for most documents, requiring a full
  rebalance.

### Document Retrieval

To retrieve a document by ID (e.g., `get(indexName, docId)`),
compute the target partition using the same hash and query only
that partition. No fan-out is needed for single-document operations.

---

## Auto-Partitioning

Every index starts with 1 partition. The engine monitors document
count per partition and triggers a rebalance when the threshold is
crossed.

### Trigger Conditions

A rebalance triggers when **any partition** exceeds
`maxDocsPerPartition` documents.

### Partition Count Calculation

```text
newPartitionCount = ceil(totalDocs / maxDocsPerPartition)
```

The developer does not set the partition count directly; they
configure the threshold. The engine calculates the appropriate
count.

### Auto-Partitioning Configuration

```text
partitions: {
  maxDocsPerPartition: 50000  (default)
  maxPartitions:       16     (optional cap, uncapped by default)
}
```

| Parameter             | Default | Description                          |
|-----------------------|---------|--------------------------------------|
| `maxDocsPerPartition` | 50,000  | Max documents before splitting       |
| `maxPartitions`       | none    | Optional upper bound on partitions   |

### Why 50,000?

The default threshold is based on the observation that BM25 search
latency stays under 10ms for partitions of 50K documents with
typical schemas. This should be validated by benchmarks that
measure p50/p95/p99 search latency at 10K, 25K, 50K, 75K, 100K,
and 200K documents per partition.

---

## Rebalancing Protocol

When a rebalance triggers, Narsil redistributes all documents
across a new set of partitions. The protocol supports concurrent
reads and writes during the rebalance.

### Sequence Numbers

Every write operation (insert, update, remove) receives a
monotonically increasing sequence number. These numbers are used
for idempotent WAQ replay.

### Write-Ahead Queue (WAQ)

During rebalance, new writes are buffered in a bounded write-ahead
queue:

```text
WriteAheadEntry {
  seq:      uint64   (monotonically increasing)
  op:       "insert" or "remove" or "update"
  docId:    string
  document: object or null  (present for insert/update)
}
```

The WAQ has a bounded capacity. When full, new writes are rejected
with error code `PARTITION_REBALANCING_BACKPRESSURE`, signaling
the caller to retry after a brief delay.

### Rebalance Steps

```text
1. COMPUTE new partition count:
   newCount = ceil(totalDocs / maxDocsPerPartition)
   Emit partitionRebalance event

2. CREATE new empty PartitionIndex instances

3. REDISTRIBUTE existing documents:
   For each document in all old partitions:
     newPartitionId = fnv1a(docId) % newCount
     Insert into the corresponding new partition
   Process in chunks of 1,000, yielding between chunks
   to avoid monopolizing compute resources. The yielding
   mechanism is runtime-specific (e.g., goroutine
   scheduling in Go, async yield in Rust, cooperative
   yielding in single-threaded runtimes).
   Vector data is unaffected by rebalancing because
   vector indexes are partition-agnostic.

4. REPLAY WAQ entries in sequence order:
   For each entry ordered by seq:
     newPartitionId = fnv1a(entry.docId) % newCount
     Apply the operation to the target new partition
     Skip if already processed (idempotency)

5. ATOMIC SWAP:
   Brief read-pause (microseconds) to swap partition map.
   Old partitions stay alive until in-flight reads complete
   (reference counting).

6. CLEANUP:
   Old partitions become eligible for reclamation once all
   in-flight reads complete. Flush new partitions to
   persistence.
```

### Concurrency During Rebalance

| Operation | Behavior |
| --- | --- |
| Reads | Continue against the OLD partition layout |
| Writes | Buffered in the WAQ with sequence numbers |
| Queries | Fan out to old partitions until swap |

### Cooperative Yielding

The redistribution step (step 3) processes documents in chunks and
yields between chunks. This prevents the rebalance from
monopolizing compute resources for extended periods. The yielding
mechanism is implementation-specific: single-threaded runtimes
must yield to the host scheduler between chunks; multi-threaded
runtimes may run the redistribution on a background thread
instead.

---

## Query Fan-Out and Merge

When a search query arrives for a multi-partition index, the
coordinator fans out to all partitions and merges the results.

### Fan-Out Steps (Text Search)

```text
1. Send the text query to ALL partitions in parallel.
2. Each partition runs the query against its local index:
   - Tokenize the query term
   - Look up tokens in the inverted index
   - Score documents using BM25
   - Apply filters
   - Return scored results (up to offset + limit)
3. Collect results from all partitions.
4. Merge into a single sorted array (merge K sorted lists).
5. Apply limit/offset or searchAfter cursor.
6. If facets: merge counts by summing values.
7. If groups: merge by group key, keep maxPerGroup.
8. Encode cursor for next page (if applicable).
9. Return the merged result.
```

### Hybrid Search (Text + Vector)

When a query includes both a text term and a vector, the
coordinator runs text search and vector search independently and
fuses the results. Text search fans out to partitions as above.
Vector search queries the per-field VectorIndex directly (no
partition fan-out). See
[vector-index.md](vector-index.md#hybrid-search) for the fusion
strategies and coordinator-level flow.

### Merge Algorithm

Merging K sorted lists (one per partition) uses a max-heap
(priority queue) ordered by score, highest first:

1. Initialize the heap with the first result from each partition.
2. Pop the highest-scoring result.
3. Push the next result from that partition (if available).
4. Repeat until `offset + limit` results have been collected.

This is O(N log K) where N is the number of results collected and
K is the partition count.

### Scoring Modes

The scoring mode affects the fan-out strategy:

**Local (default):** Single round trip. Each partition scores using
its own statistics.

**DFS (Distributed Frequency Statistics):** Two round trips.

- Phase 1: Collect `{ totalDocs, docFrequencies, avgFieldLengths }`
  from each partition.
- Compute global statistics by summing `totalDocs` and
  `docFrequencies`, and computing weighted `avgFieldLengths`.
- Phase 2: Send the query with global statistics to each partition.
  Partitions re-score using globally correct IDF values.

**Broadcast:** Single round trip. The coordinator maintains
pre-aggregated global statistics (updated periodically via the
invalidation adapter). Sends these statistics with the query.

See [algorithms.md](algorithms.md#distributed-bm25) for the BM25
distributed scoring formulas.

---

## Deep Pagination

Two pagination mechanisms are supported:

### Offset/Limit

Traditional pagination. Each partition returns `offset + limit`
results. The coordinator merges and skips the first `offset`.

```text
Query: { term: "widget", offset: 1000, limit: 20 }
Each partition returns: up to 1020 results
Coordinator: merge all, skip first 1000, return 20
```

This degrades for large offsets because each partition must
materialize and transfer `offset + limit` results.

### searchAfter Cursor

Cursor-based pagination. Each partition seeks to the cursor point
and returns `limit` results from there. O(limit) per partition
instead of O(offset + limit).

#### Cursor Format

Base64-encoded JSON:

```json
{
  "s": 4.523,
  "d": "doc-id-123",
  "p": {
    "0": { "s": 4.523, "d": "doc-id-123", "o": 12 },
    "1": { "s": 4.100, "d": "doc-id-456", "o": 8 }
  }
}
```

| Field | Description |
| --- | --- |
| `s` | Score (or sort value) of the last document |
| `d` | DocId of the last document (tiebreaker) |
| `p` | Per-partition cursor state with local offsets |

#### Tiebreaking

When multiple documents have the same score, they are ordered by
`docId` string comparison (lexicographic). This ensures stable,
deterministic pagination across requests.

#### Cursor Flow

```text
1. First query:
   - Fan out to all partitions with limit.
   - Merge results, take top `limit`.
   - Encode cursor from the last result's score,
     docId, and per-partition positions.
   - Return results + cursor.

2. Next query (with searchAfter cursor):
   - Decode cursor.
   - Fan out to all partitions. Each partition seeks
     to its cursor position.
   - Merge results, take top `limit`.
   - Encode new cursor.
   - Return results + cursor.
```

---

## Worker Assignment

When the engine operates in worker mode, partitions are assigned
to workers by hash:

```text
workerId = fnv1a(indexName) % workerCount
```

All partitions for a given index run on the same worker. This
avoids cross-worker coordination for per-index operations while
distributing different indexes across the worker pool.

### Default Worker Count

```text
workerCount = max(2, cpuCount - 1)
```

Capped at 8 by default. Configurable via
`NarsilConfig.workers.count`.

---

## Partition Lifecycle

### Creation

A new index starts with 1 partition (partitionId = 0). The
partition is created empty with initialised data structures.

### Splitting (Rebalance)

When the document count threshold is crossed, a rebalance creates
new partitions and redistributes documents (see the Rebalancing
Protocol section above).

### Partition Persistence

Each partition serialises independently to a `.nrsl` envelope. The
flush manager tracks dirty partitions and persists only those that
changed since the last flush.

Key format: `<indexName>/partition_<N>` (e.g.,
`products/partition_0`, `products/partition_3`).

### Deletion

When an index is dropped, all its partitions are removed from
memory and their persistence keys are deleted.

### Rebuild

If a partition is corrupted (CRC32 mismatch on load), the
`rebuildPartition(indexName, partitionId)` method reloads it from
persistence. If no persistence adapter is configured, a
`PERSISTENCE_LOAD_FAILED` error is raised.
