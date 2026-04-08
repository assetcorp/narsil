# Narsil Replication Specification

This document defines the replication protocol for distributed
Narsil clusters. It covers the replication log format, the sync
protocol for new and recovering nodes, the failover process, write
durability guarantees, and in-sync replica tracking.

---

## Replication Model

Narsil uses single-primary replication per partition. Each
partition has exactly one primary node that accepts writes and
zero or more replica nodes that receive replicated operations
from the primary.

This model follows the primary-backup pattern described in
Microsoft's PacificA paper, the same model used by Elasticsearch
and Solr. It provides a natural serialisation point for writes:
the primary assigns sequence numbers and controls operation
ordering.

### Write Path

```text
1. Client sends a mutation (insert, update, remove) to any node.
2. The receiving node determines the target partition using
   fnv1a(docId) % partitionCount.
3. The receiving node checks the allocation table to find the
   partition's primary.
4. If the receiving node IS the primary:
   a. Execute the mutation locally.
   b. Generate embeddings if configured (compute once).
   c. Write the operation to the replication log.
   d. Forward the log entry to all in-sync replicas via
      NodeTransport.
   e. Wait for all in-sync replicas to acknowledge.
   f. If a replica fails to acknowledge:
      - Discover the active controller via
        getLeaseHolder('_narsil/controller').
      - Send a replication.insync_remove message to the
        controller via NodeTransport.
      - Wait for the controller to confirm the removal
        (replication.insync_confirm).
   g. Acknowledge the write to the client.
5. If the receiving node is NOT the primary:
   - Forward the mutation to the primary via NodeTransport.
   - The primary handles it from step 4.
```

### Read Path

Any node holding a replica of the requested partition can serve
reads. The coordinator selects one replica per partition for each
query (see [query-routing.md](query-routing.md#replica-selection)).

---

## Replication Log

The replication log is an append-only, per-partition log of
mutation operations. The primary writes to this log for every
mutation and forwards entries to replicas.

### Log Entry Format

Each log entry is serialised as MessagePack with these fields:

```text
ReplicationLogEntry {
  seqNo:       uint64    (monotonically increasing per partition)
  primaryTerm: uint64    (increments on primary failover)
  operation:   'INDEX' or 'DELETE'
  partitionId: uint32
  indexName:   string
  documentId:  string
  document:    bytes or null  (MessagePack-encoded document, present for INDEX)
  checksum:    uint32         (CRC32 of the entry bytes)
}
```

### Field Definitions

#### seqNo

A monotonically increasing counter scoped to a single partition.
The primary assigns sequence numbers. The first operation on a
partition has `seqNo = 1`. Sequence numbers never reset, even
after primary failover. The new primary continues from the
highest `seqNo` in the in-sync set.

Sequence numbers are per-partition, not global. There is no
cross-partition ordering guarantee.

#### primaryTerm

A counter that increments each time a new primary is elected for
a partition. The `primaryTerm` serves as a fencing token: if a
replica receives an entry with a `primaryTerm` lower than its
current term, it rejects the entry. This prevents zombie
primaries (nodes that were network-partitioned but still think
they are primary) from writing stale data.

The controller increments the `primaryTerm` during failover and
writes it to the `ClusterCoordinator`.

#### operation

Two types:

- `INDEX`: Insert or update a document. The `document` field
  contains the full, transformed document body including any
  computed embeddings. Replicas apply this by indexing the
  document into their local partition. All updates are
  materialised into full `INDEX` operations at the primary
  before entering the log, so replicas always receive complete
  documents.

- `DELETE`: Remove a document. The `document` field is `null`.
  Replicas apply this by removing the document from their local
  partition.

There is no `UPDATE` operation type. Partial updates are resolved
at the primary into a full `INDEX` entry. This keeps replicas
simple: they always receive self-contained operations with no
dependencies on previous entries.

#### document

For `INDEX` operations: the complete document body, serialised as
MessagePack. This includes all fields (text, numeric, boolean,
enum, geopoint) and all computed vector embeddings. Replicas
deserialise and index this document without running the embedding
adapter or any other transformation.

For `DELETE` operations: `null`.

#### checksum

CRC32 of the log entry bytes (all fields except the checksum
itself), using the IEEE polynomial. Replicas must verify the
checksum before applying the entry. A mismatch indicates
corruption in transit and must be reported as an error.

---

## Log Retention

The replication log is bounded to prevent unbounded memory growth.
When the log exceeds its capacity, the oldest entries are
discarded.

### Retention Configuration

```text
ReplicationConfig {
  logRetentionBytes: uint64  (default: 268435456, which is 256 MB)
}
```

The default of 256 MB per partition provides enough headroom for
most workloads during rolling updates. For a document with a
1536-dimension vector embedding, each log entry is roughly 10-12
KB. At 256 MB, the log holds approximately 22,000-26,000
operations.

Deployers should size the retention based on their write
throughput and maximum expected replica downtime:

```text
retentionBytes >= writeRateBytesPerSec * maxOfflineSeconds
```

### Retention Mechanism

The retention mechanism is implementation-defined. Options
include:

- Circular buffer (like Galera's gcache)
- Append-only file with periodic truncation
- In-memory ring buffer with overflow to disk

The mechanism must support efficient lookup by `seqNo` (the
recovery protocol queries 'all entries from seqNo N onward').

---

## Sync Protocol

When a replica needs to catch up with the primary (new node
joining, node recovering after downtime, or partition reassigned),
the sync protocol runs between the primary and the replica.

### Two-Tier Recovery

The protocol uses two tiers. The primary chooses the appropriate
tier based on whether its log covers the replica's gap.

#### Tier 1: Incremental Catch-Up (Fast Path)

When the primary's log still contains all entries the replica
has missed:

```text
1. Replica connects to primary via NodeTransport.
2. Replica sends: { lastSeqNo, lastPrimaryTerm }
3. Primary checks: does the log contain entries from
   lastSeqNo + 1 onward?
4. If yes:
   a. Primary streams all log entries from lastSeqNo + 1
      to the current head.
   b. Replica applies each entry to its local partition.
   c. Replica acknowledges each batch.
   d. After catching up, the replica enters steady-state
      replication (receives new entries as they are written).
```

#### Tier 2: Full Snapshot (Fallback)

When the primary's log no longer contains the entries the
replica needs (the log was truncated past the replica's
`lastSeqNo`):

```text
1. Replica connects to primary, sends: { lastSeqNo, lastPrimaryTerm }
2. Primary checks: log does NOT cover the gap.
3. Primary initiates snapshot transfer:
   a. Serialise the partition using the .nrsl format
      (same as persistence snapshots).
   b. Prepend a replication snapshot header:
      ReplicationSnapshotHeader {
        lastSeqNo:     uint64   (the seqNo at snapshot time)
        primaryTerm:   uint64
        partitionId:   uint32
        indexName:      string
        checksum:       uint32  (CRC32 of the snapshot bytes)
      }
   c. Stream the snapshot to the replica via NodeTransport.
4. Replica receives the snapshot:
   a. Verify the checksum.
   b. Deserialise and load the partition.
5. Primary then streams any log entries that arrived during
   the snapshot transfer (from lastSeqNo + 1 in the snapshot
   header to the current head).
6. Replica applies those entries.
7. Replica enters steady-state replication.
```

### Recovery Decision

The primary makes the decision. The replica provides its state;
the primary determines the path:

```text
if primaryLog.oldestSeqNo <= replica.lastSeqNo + 1:
  use Tier 1 (incremental)
else:
  use Tier 2 (full snapshot)
```

### Partition State During Recovery

While a replica is bootstrapping (state: `INITIALISING`), it does
not serve reads. Queries that would route to this replica are
redirected to other replicas or the primary. Once bootstrapping
completes, the controller transitions the partition to `ACTIVE`
on this replica, and it begins serving reads.

---

## In-Sync Replica Tracking

The in-sync set tracks which replicas are fully caught up with
the primary. Only replicas in the in-sync set are eligible for
primary promotion during failover.

### How a Replica Enters the In-Sync Set

A replica joins the in-sync set when it has applied all log
entries up to the primary's current `seqNo`. This happens at the
end of the sync protocol (after incremental catch-up or snapshot
transfer is complete).

### How a Replica Leaves the In-Sync Set

The primary detects that a replica has failed (timeout on
forwarded log entry, connection lost). The primary requests the
controller to remove the replica from the in-sync set.

#### Discovery

The primary discovers the active controller's address by calling
`getLeaseHolder('_narsil/controller')` on the `ClusterCoordinator`
adapter. This returns the `nodeId` of the active controller. The
primary then looks up the controller's `address` from its cached
node registry (populated via `watchNodes`) and sends the removal
request via `NodeTransport`.

#### Removal Flow

```text
1. Primary forwards a log entry to replica R.
2. Replica R fails to acknowledge within the replicationTimeout.
3. Primary discovers the active controller via
   getLeaseHolder('_narsil/controller').
4. Primary sends a replication.insync_remove message to the
   controller via NodeTransport:
   { indexName, partitionId, replicaNodeId, primaryTerm }
5. Controller verifies the primaryTerm matches the current term
   in the allocation table (prevents stale primaries from
   removing replicas).
6. Controller updates the PartitionAssignment's inSyncSet in
   the ClusterCoordinator using compareAndSet.
7. Controller sends a replication.insync_confirm message back
   to the primary: { indexName, partitionId, accepted: true }
8. Primary acknowledges the write to the client.
```

If the controller rejects the request (stale `primaryTerm`), it
responds with `accepted: false`. The primary must not acknowledge
the write and should check the allocation table for the current
primary assignment, as it may have been superseded.

The write is NOT acknowledged to the client until the controller
confirms the in-sync set update. This guarantees that every
acknowledged write exists on every replica in the current in-sync
set.

### In-Sync Set Persistence

The in-sync set is stored in the `ClusterCoordinator` as the
`inSyncSet` field of `PartitionAssignment` (see
[cluster.md](cluster.md#allocationtable)). The controller updates
it atomically using `compareAndSet` on the allocation table.

---

## Write Durability

Every write replicates to all in-sync replicas before
acknowledgement. This is not configurable. The primary always
forwards the operation to every replica in the in-sync set and
waits for all of them to acknowledge.

If a replica fails during replication, the primary removes it
from the in-sync set (via the controller) and then acknowledges.
The write is durable on all remaining in-sync replicas.

### Pre-Check: Wait for Active Replicas

Before a write begins, the primary can optionally check that a
minimum number of replicas are alive. This is configurable via
`waitForActiveReplicas` (default: 1, meaning only the primary
itself must be active).

```text
ReplicationConfig {
  waitForActiveReplicas: uint8  (default: 1)
}
```

Setting this to a higher value (e.g., 2) means the primary
rejects writes when fewer than 2 total copies (primary + 1
replica) are alive. This provides stronger durability
guarantees at the cost of reduced write availability during
partial failures.

This is a pre-check gate, not the replication behaviour. The
replication always goes to all in-sync replicas regardless of
this setting.

---

## Failover

When a partition's primary fails, the controller promotes a
replica to primary.

### Failover Protocol

```text
1. The primary node's lease expires in the ClusterCoordinator
   (or the node explicitly deregisters).
2. A node_left event fires.
3. The controller reads the in-sync set for each partition
   where the failed node was primary.
4. For each affected partition:
   a. The controller selects a new primary from the in-sync
      set.
   b. Selection criteria (in order):
         - No storage errors reported
         - Previously held the primary role (preference)
         - Arbitrary tiebreak if multiple candidates are equal
      Sequence numbers are NOT used for selection because
      in-sync set membership already guarantees all candidates
      have every acknowledged operation.
   c. The controller increments the primaryTerm.
   d. The controller writes the updated allocation table and
      in-sync set to the ClusterCoordinator.
5. All nodes observe the allocation change:
   a. The new primary starts accepting writes.
   b. Other replicas connect to the new primary for replication.
   c. If the old primary comes back, it sees a higher
      primaryTerm and demotes itself to replica. It then syncs
      from the new primary.
```

### No Eligible Replica

If the in-sync set is empty when the primary fails (all replicas
were already removed), the partition transitions to `UNASSIGNED`.
The partition is unavailable for reads and writes until:

- A node with persisted data for the partition rejoins and the
  controller assigns it as primary.
- The data is rebuilt from an external source.

This is a data-loss scenario. The `replicationFactor`
configuration should be set high enough to make this unlikely in
production deployments.

### Zombie Primary Protection

The `primaryTerm` prevents zombie primaries from causing
corruption:

- When a primary is network-partitioned, it cannot renew its
  lease. The controller promotes a new primary with a higher
  `primaryTerm`.
- If the old primary recovers and tries to replicate entries to
  replicas, the replicas reject entries with the old
  `primaryTerm`.
- The old primary discovers the higher `primaryTerm` in the
  allocation table, demotes itself, and syncs from the new
  primary.

---

## Embedding Handling

Embeddings are computed once at the primary and replicated as part
of the document body. Replicas never run the embedding adapter.

### Flow

```text
1. Primary receives an insert with embedding configuration.
2. Primary runs the EmbeddingAdapter to generate vectors.
3. The resulting document (with embeddings included) is written
   to the replication log as an INDEX entry.
4. Replicas receive the INDEX entry with pre-computed embeddings.
5. Replicas index the document, including the embedding vectors,
   without calling the EmbeddingAdapter.
```

This means only primary nodes need access to the embedding
adapter. Replicas can operate without any embedding infrastructure.

---

## Error Codes

| Code | When |
|---|---|
| `REPLICATION_LOG_FULL` | The replication log has reached its retention limit and the write cannot be buffered. |
| `REPLICATION_ENTRY_CORRUPT` | CRC32 checksum mismatch on a received log entry. |
| `REPLICATION_SNAPSHOT_CORRUPT` | CRC32 checksum mismatch on a received snapshot. |
| `REPLICATION_TERM_MISMATCH` | A replica received an entry with a stale primaryTerm. |
| `REPLICATION_SYNC_FAILED` | The sync protocol (incremental or snapshot) failed to complete. |
| `PARTITION_NOT_PRIMARY` | A write was routed to a node that is not the primary for the target partition. |
| `PARTITION_UNASSIGNED` | The target partition has no primary (all copies lost). |
| `INSUFFICIENT_REPLICAS` | The waitForActiveReplicas pre-check failed. |
