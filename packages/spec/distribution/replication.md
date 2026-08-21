# Narsil Replication Specification

This document defines the replication protocol for a distributed cluster. It covers the replication log format, the sync protocol for a new or recovering node, failover, write durability, and in-sync replica tracking.

Structure definitions use a language-neutral notation. `List<T>` is an ordered collection of `T`, `Map<K, V>` a mapping from keys to values, `T or absent` a value that may be missing, and width-tagged names such as `uint64` describe exact byte widths on the wire.

---

## Replication Model

Each partition has exactly one primary node that accepts writes, and zero or more replica nodes that receive replicated operations from it. The primary is the serialisation point for a partition: it assigns the sequence numbers and fixes the order every replica applies.

### Write Path

```text
1. A client sends a mutation, whether an insert, an update, or a
   remove, to any node.
2. The receiving node routes the document to its partition with
   fnv1a(docId) modulo partitionCount.
3. The receiving node reads the allocation table to find that
   partition's primary.
4. When the receiving node is the primary:
   a. It applies the mutation locally.
   b. It generates the embeddings, when the index configures them,
      computing each one once.
   c. It writes the operation to the replication log.
   d. It sends the log entry over the node transport to every
      replica in the in-sync set, and to every replica whose
      admission it has asked the controller to confirm.
   e. It waits for each of those replicas to acknowledge.
   f. When a replica in the in-sync set fails to acknowledge:
        it finds the active controller with
          getLeaseHolder('_narsil/controller')
        it sends a replication.insync_remove message to the
          controller over the node transport
        it waits for the controller's replication.insync_confirm
   g. When a replica whose admission is pending fails to
      acknowledge, it abandons that admission.
   h. It checks that it still holds primary authority for the
      partition under the entry's primaryTerm.
   i. It raises the partition's commit point to the entry's seqNo.
   j. It acknowledges the write to the client.
5. When the receiving node is not the primary, it forwards the
   mutation to the primary over the node transport, and the primary
   takes over from step 4.
```

A node forwarding many mutations to one primary should send them in a single `replication.forward_batch` message, and the primary then answers one outcome per mutation; see [transport.md](transport.md#replicationforward_batch).

### Rollback of a Failed Write

A primary must never leave a locally applied mutation visible when the write fails before it can be acknowledged. That covers a failure while forwarding to in-sync replicas, a failure while removing a failed replica from the in-sync set, and a failure while checking that the node still holds primary authority for the partition.

A primary that has already applied an insert locally must remove that document before it returns the failure. A primary that has already applied a remove locally must restore the document that was visible before, again before it returns the failure.

The log is append-only, so a primary that has already appended the entry must not remove it. It must append a compensating entry before it returns the failure, because a replica catching up through the [Sync Protocol](#sync-protocol) receives every appended entry whether or not the primary acknowledged the write.

| Rolled-back entry | Compensating entry |
|-------------------|--------------------|
| `INDEX` over a document that existed before | `INDEX` carrying that earlier document |
| `INDEX` of a document that did not exist | `DELETE` |
| `DELETE` | `INDEX` carrying the removed document |

A primary must append the compensating entry under the same `primaryTerm` as the entry it compensates. Where the rollback runs because that term is no longer current, the primary must abandon the compensating entry, because a new primary owns the log from the newer term onwards.

A primary rolling back a batch must compensate every entry it appended for that batch, in the reverse of the order it appended them.

When the rollback itself fails, which covers a failed local restore and a failed compensating append alike, the primary must still refuse to acknowledge the write. It reports `REPLICATION_ROLLBACK_FAILED` with enough context to identify both the original write failure and the rollback failure. An implementation may then mark the local partition unhealthy or take it out of service; the partition must not carry on serving reads that could expose the unacknowledged mutation.

### Read Path

Any node holding a replica of the requested partition can serve reads. The coordinator picks one replica per partition for each query; see [Replica Selection](query-routing.md#replica-selection).

---

## Replication Log

The replication log is an append-only, per-partition log of mutation operations. The primary writes to it for every mutation and forwards the entries to the replicas.

### Log Entry Format

Each entry is serialised as MessagePack:

```text
ReplicationLogEntry {
  seqNo:       uint64           (increases monotonically within a partition)
  primaryTerm: uint64           (increases on primary failover)
  operation:   'INDEX' or 'DELETE'
  partitionId: uint32
  indexName:   string
  documentId:  string
  document:    bytes or absent  (MessagePack document, present for INDEX)
  checksum:    uint32           (CRC32 of the seven content fields)
}
```

#### seqNo

A counter scoped to a single partition and assigned by the primary. The first operation on a partition carries `seqNo` 1. Sequence numbers never reset, not even after failover, and a new primary continues from the highest `seqNo` held in the in-sync set.

Sequence numbers are per partition, so no ordering holds between partitions.

#### primaryTerm

A counter that increases each time a partition elects a new primary. It works as a fencing token: a replica rejects an entry whose `primaryTerm` is below its current term, which stops a primary that was partitioned away from the cluster, and still believes it holds authority, from writing stale data.

The controller increases the term during failover and writes it to the cluster coordinator.

#### operation

An `INDEX` entry inserts or updates a document. Its `document` field holds the full transformed document body, computed embeddings included, and a replica applies it by indexing that document into its local partition. The primary materialises every update into a full `INDEX` entry before it enters the log, so a replica always receives a complete document.

A `DELETE` entry removes a document. Its `document` field is absent, and a replica applies it by removing the document from its local partition.

There is no `UPDATE` operation. The primary resolves a partial update into a full `INDEX` entry, which keeps replicas simple: every entry they receive is self-contained and depends on no earlier entry.

#### document

For an `INDEX` entry, this is the complete document body serialised as MessagePack, with every field, whether text, numeric, boolean, enum, or geopoint, and every computed vector embedding. A replica decodes and indexes it without running the embedding adapter or any other transformation.

For a `DELETE` entry, the field is absent.

#### checksum

The checksum covers the seven content fields, which is every field except `checksum` itself. An implementation encodes those fields as a MessagePack array in exactly this order:

```text
[seqNo, primaryTerm, operation, partitionId, indexName, documentId, document]
```

and computes CRC32 with the IEEE polynomial over the resulting bytes. The positional array form and that field order are the contract. The checksum input is a MessagePack array, not the keyed map that stores and transmits the entry, so every language derives identical bytes and an identical checksum for the same entry.

This logical checksum differs from the write-ahead log frame checksum in [Record Frame](../durability.md#record-frame). The frame checksum covers the framed payload bytes on disk, and this one covers the seven content fields and travels with the entry between nodes.

Adding, removing, or reordering a content field changes these bytes and the checksum, so it is a breaking format change that must raise the log framing version instead of altering the layout in place. A replica verifies the checksum before it applies an entry, and recovery recomputes it while reading a segment. A mismatch means corruption and must be reported as an error; recovery raises `PERSISTENCE_WAL_CORRUPT`.

---

## Log Retention

The replication log is bounded so that memory use stays bounded. Once the log passes its capacity, the oldest entries are discarded.

```text
ReplicationConfig {
  logRetentionBytes: uint64  (default 268435456, which is 256 MB)
}
```

The 256 MB default per partition gives most workloads enough headroom to cover a rolling update. A document with a 1536-dimension embedding produces a log entry of roughly 10 to 12 KB, so 256 MB holds somewhere between 22,000 and 26,000 operations.

Size the retention against your own write throughput and the longest replica outage you expect to survive without a full snapshot:

```text
retentionBytes >= writeRateBytesPerSec * maxOfflineSeconds
```

The retention mechanism is implementation-defined. A circular buffer, an append-only file with periodic truncation, and an in-memory ring buffer that overflows to disk all satisfy the contract. Whatever the mechanism, it must look up entries by `seqNo` efficiently, because the recovery protocol asks for every entry from a given sequence number onward.

---

## Sync Protocol

A replica that needs to catch up with the primary, whether it is a new node, a node returning after downtime, or a node newly assigned the partition, runs the sync protocol against the primary.

A replica must send `replication.sync_request` again once it has applied the sync so that the primary records its new position.

### Two-Tier Recovery

The primary picks the tier, based on whether its log still covers the replica's gap.

#### Tier 1: Incremental Catch-Up

The fast path runs when the primary's log still holds every entry the replica missed:

```text
1. The replica connects to the primary over the node transport.
2. The replica sends { lastSeqNo, lastPrimaryTerm }.
3. The primary checks whether its log holds entries from
   lastSeqNo + 1 onward.
4. When it does:
   a. The primary streams every log entry from lastSeqNo + 1 to
      the current head.
   b. The replica applies each entry to its local partition.
   c. The replica acknowledges each batch.
   d. Once caught up, the replica moves to steady-state
      replication and receives new entries as they are written.
```

#### Tier 2: Full Snapshot

The fallback runs when the primary's log no longer holds what the replica needs, because retention truncated past the replica's `lastSeqNo`:

```text
1. The replica connects to the primary and sends
   { lastSeqNo, lastPrimaryTerm }.
2. The primary finds that its log does not cover the gap.
3. The primary starts a snapshot transfer:
   a. It serialises the partition in the .nrsl format, the same
      format persistence snapshots use.
   b. It prepends a replication snapshot header:
        ReplicationSnapshotHeader {
          lastSeqNo:   uint64   (the seqNo at snapshot time)
          primaryTerm: uint64
          partitionId: uint32
          indexName:   string
          checksum:    uint32   (CRC32 of the snapshot bytes)
        }
   c. It streams the snapshot to the replica over the node
      transport.
4. The replica verifies the checksum, then decodes and loads the
   partition.
5. The primary streams the log entries that arrived during the
   transfer, from the header's lastSeqNo + 1 to the current head.
6. The replica applies those entries.
7. The replica moves to steady-state replication.
```

### Choosing the Tier

The replica reports its state and the primary decides:

```text
if primaryLog.oldestSeqNo <= replica.lastSeqNo + 1:
  use tier 1, incremental
else:
  use tier 2, full snapshot
```

### Partition State During Recovery

A replica that is still bootstrapping holds the partition in `INITIALISING` and serves no reads. A query that would route to it goes to another replica or to the primary instead. Once bootstrapping finishes, the controller moves the partition to `ACTIVE` on that replica, and it starts serving reads.

---

## In-Sync Replica Tracking

The in-sync set records which replicas are fully caught up with the primary. Only a replica in that set is eligible for promotion during failover.

A replica joins the in-sync set once it has applied every entry up to the partition's commit point. The commit point is the highest sequence number the primary has acknowledged to a client. The primary holds its own commit point, and the controller stores a floor on it in the partition assignment, raising that floor whenever it admits a replica and never lowering it.

A replica leaves the in-sync set when the primary detects it has failed, whether by a timeout on a forwarded entry or by a lost connection. The primary then asks the controller to remove it.

A replica that reads an `ACTIVE` assignment naming it outside the in-sync set must run the sync protocol against the primary. The primary feeds it from there through the [Catch-Up Feed](#catch-up-feed), and asks the controller to admit it once it has caught up.

### Finding the Controller

The primary calls `getLeaseHolder('_narsil/controller')` on the cluster coordinator, which returns the `nodeId` of the active controller. The primary looks that node's `address` up in its cached node registry, kept current by the node watch, and sends the removal request over the node transport.

### Removal Flow

```text
1. The primary forwards a log entry to replica R.
2. Replica R fails to acknowledge within the replication timeout.
3. The primary finds the active controller with
   getLeaseHolder('_narsil/controller').
4. The primary sends a replication.insync_remove message to the
   controller over the node transport:
     { indexName, partitionId, replicaNodeId, primaryTerm }
5. The controller checks that primaryTerm matches the current term
   in the allocation table, which stops a stale primary from
   removing replicas.
6. The controller updates the assignment's inSyncSet in the cluster
   coordinator with a compare-and-set.
7. The controller replies with replication.insync_confirm:
     { indexName, partitionId, accepted: true }
8. The primary resumes the write path at step 4h.
```

A controller that rejects the request, because the `primaryTerm` is stale, replies with `accepted: false`. The primary must then refuse to acknowledge the write, and it should reread the allocation table for the current primary assignment, because another node may have taken over.

The write reaches the client only after the controller confirms the in-sync set update. That guarantees every acknowledged write exists on every replica in the current in-sync set.

The in-sync set is stored in the cluster coordinator as the `inSyncSet` field of a partition assignment; see [Allocation Table](cluster.md#allocation-table). The controller updates it atomically with a compare-and-set on the allocation table.

### Catch-Up Feed

A primary must send every assigned replica outside the in-sync set the entries that replica lacks, because a replica that receives nothing between writes never reaches the commit point.

The primary keeps one applied position for each such replica. It takes that position from the replica's `replication.sync_request`, and it raises the position whenever the replica acknowledges a batch.

A `replication.sync_request` reporting a position below the recorded one opens a fresh sync session, so the primary must lower the recorded position to the reported one, and must discard every acknowledgement still in flight from before that request. A primary that kept the higher position instead would count entries the replica no longer holds, and a failover to that replica would then lose acknowledged writes.

The primary sends the entries above the recorded position in sequence-number order, and it may group contiguous entries into one `replication.entry_batch` message. It must bound the bytes it holds in flight across every partition it leads, so that a replica rejoining an idle cluster cannot exhaust the primary's memory.

The primary asks the controller to admit a replica once that replica's recorded position reaches the primary's own log end; see [replication.insync_add](transport.md#replicationinsync_add). The controller admits it only when the position is at or above the stored commit point.

A replica whose recorded position falls below the oldest entry the primary retains must leave the feed and run the [Sync Protocol](#sync-protocol) again, because the primary can no longer send it what it lacks.

---

## Write Durability

Every write replicates to every in-sync replica before it is acknowledged, and that is not configurable. The primary sends each entry to every replica in the in-sync set, and to every replica whose admission it has asked the controller to confirm, and it must wait for all of them. Every other assigned replica receives that entry through the [Catch-Up Feed](#catch-up-feed) instead, so no assigned replica misses an entry and no lagging replica holds a write up. The primary raises the partition's commit point to the entry's `seqNo` once it acknowledges the write.

A primary may group contiguous entries for one partition into a single `replication.entry_batch` message, and the replica's one acknowledgement of the batch's last entry then covers every entry in it. A primary must send each partition's entries in sequence-number order, whichever message carries them.

A replica that fails during replication is removed from the in-sync set through the controller, and the primary then acknowledges. The write is durable on every remaining in-sync replica. A replica that fails while its admission is pending stays outside the set, so the primary abandons that admission and acknowledges without it.

### Waiting for Active Replicas

Before a write starts, the primary can check that a minimum number of copies are alive. `waitForActiveReplicas` configures that check, and its default of 1 means only the primary itself must be active.

```text
ReplicationConfig {
  waitForActiveReplicas: uint8  (default 1)
}
```

Setting it to 2 makes the primary reject writes whenever fewer than two copies, the primary and one replica, are alive. That buys a stronger durability guarantee at the cost of write availability during a partial failure.

The setting gates the write before it starts and changes nothing about replication itself, which always goes to every in-sync replica.

---

## Failover

When a partition's primary fails, the controller promotes a replica.

```text
1. The failed node's lease expires in the cluster coordinator, or
   the node deregisters itself.
2. A node_left event fires.
3. The controller reads the in-sync set of every partition the
   failed node was primary for.
4. For each affected partition:
   a. The controller picks a new primary from the in-sync set.
   b. It prefers, in order, a candidate that has reported no
      storage errors, then a candidate that previously held the
      primary role, and breaks any remaining tie arbitrarily.
      Sequence numbers play no part, because in-sync membership
      already proves every candidate holds every acknowledged
      operation.
   c. The controller increases the primaryTerm.
   d. The controller writes the updated allocation table and
      in-sync set to the cluster coordinator.
5. Every node observes the allocation change:
   a. The new primary starts accepting writes.
   b. The other replicas connect to it for replication.
   c. A returning old primary sees the higher primaryTerm, demotes
      itself to replica, and syncs from the new primary.
```

### No Eligible Replica

An empty in-sync set at the moment the primary fails, because every replica had already been removed, moves the partition to `UNASSIGNED`. It then serves neither reads nor writes until a node holding persisted data for that partition rejoins and the controller makes it primary, or the data is rebuilt from the system of record.

That is a data-loss situation. Set `replicationFactor` high enough that it stays unlikely in production.

### Fencing a Stale Primary

The `primaryTerm` keeps a primary that lost its lease from corrupting a partition:

- A primary cut off from the network cannot renew its lease, and the controller promotes a new primary with a higher `primaryTerm`.
- The old primary that comes back and tries to replicate entries is rejected by the replicas, because its `primaryTerm` is stale.
- The old primary then reads the higher `primaryTerm` from the allocation table, demotes itself, and syncs from the new primary.

---

## Embedding Handling

The primary computes every embedding once and replicates it inside the document body, so a replica never runs the embedding adapter.

```text
1. The primary receives an insert against an index that configures
   embeddings.
2. The primary runs the embedding adapter to produce the vectors.
3. The resulting document, embeddings included, enters the
   replication log as an INDEX entry.
4. Each replica receives that entry with the vectors already
   computed.
5. Each replica indexes the document, vectors included, without
   calling the embedding adapter.
```

Only a primary needs access to the embedding adapter, so a replica runs with no embedding infrastructure at all.

---

## Error Codes

| Code | Raised when |
|------|-------------|
| `REPLICATION_LOG_FULL` | The log has reached its retention limit and the write cannot be buffered. |
| `REPLICATION_ENTRY_CORRUPT` | A received log entry failed its CRC32 checksum. |
| `REPLICATION_SNAPSHOT_CORRUPT` | A received snapshot failed its CRC32 checksum. |
| `REPLICATION_TERM_MISMATCH` | A replica received an entry carrying a stale primaryTerm. |
| `REPLICATION_SYNC_FAILED` | The sync protocol, incremental or snapshot, failed to finish. |
| `REPLICATION_ROLLBACK_FAILED` | A primary-local mutation failed before acknowledgement and the rollback failed too. |
| `REPLICATION_ENTRY_INVALID` | A received entry is malformed, out of order, or not addressed to the receiving replica. |
| `REPLICATION_INSYNC_REMOVAL_FAILED` | The primary could not remove a failed replica from the in-sync set, because no controller was reachable or the controller rejected the request. |
| `PARTITION_NOT_PRIMARY` | A write reached a node that is not the primary for the target partition. |
| `PARTITION_UNASSIGNED` | The target partition has no primary, because every copy was lost. |
| `INSUFFICIENT_REPLICAS` | The `waitForActiveReplicas` check failed. |
