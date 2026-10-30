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

A primary appends no entry under a term until it has started that term on every copy in the in-sync set, as [Starting a Term](#starting-a-term) defines.

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

A compensating entry is an ordinary replicated entry. Before a primary treats a rollback as complete, every replica in the in-sync set must either acknowledge the compensating entry or leave the set through the controller's compare-and-set on the allocation table, as the [Removal Flow](#removal-flow) defines. The primary sends each in-sync replica the failed write's entries together with their compensating entries, in log order, so that a replica that never received a failed entry applies both and ends up holding what the primary holds.

A primary answers the client with a definite refusal only once the rollback is complete. Where the rollback is still incomplete when `replicationTimeout` has passed since the write failed, the primary answers `REPLICATION_OUTCOME_UNKNOWN`, because a replica can still hold the failed write. A primary that abandons the compensating entry because its term is no longer current answers `REPLICATION_OUTCOME_UNKNOWN` too, because the new primary may hold the entry.

While a rollback is incomplete, the partition takes no new writes. The primary keeps the partition's write queue held, and it retries the rollback with backoff, giving each try at most `replicationTimeout`, so that no later write is ordered after an entry whose outcome is still open. Writes to other partitions carry on.

A client that receives `REPLICATION_OUTCOME_UNKNOWN` cannot tell whether the write took effect, so it should read the document before it retries. A node that forwarded the write must not retry it on the client's behalf, except where the primary abandoned the write because its term ended. The node may then send an insert to the new primary and settle the outcome against the copy that the new primary holds, and it may send an update or a remove again as [Retry After an Ended Term](#retry-after-an-ended-term) defines.

### Retry After an Ended Term

A primary that answers `REPLICATION_OUTCOME_UNKNOWN` with the reason `term_ended` for an update or a remove must tell the node that forwarded the write which entries it appended, through the `abandonedWrite` of its reply; see [transport.md](transport.md#replicationforward). The failed entry E is the entry whose `seqNo` and `primaryTerm` `abandonedWrite` carries, and its compensating entry C is the entry whose `seqNo` `compensationSeqNo` carries. C shares E's `primaryTerm`. `previousSeqNo` and `previousPrimaryTerm` give the document's [write record](#document-write-record) from before E. The primary must leave `abandonedWrite` out where the document held no write record before E.

Once the allocation table names a newer primary for the partition, the forwarding node may send the update or the remove to that primary again, carrying the numbers from `abandonedWrite` as its condition. The new primary decides the resend inside the partition's write queue, so that no other write to the partition comes between its check and its apply:

1. Where it holds E but not C, it acknowledges the write without applying it again, because its copy holds the write.
2. Where it holds both E and C and the document's write record equals C, or holds neither and the record equals the previous record, it applies the write, because no other write has touched the document since the old primary's attempt.
3. Otherwise it refuses with `REPLICATION_WRITE_CONFLICT`, because another write has touched the document since that attempt.

A copy holds the entry numbered `s` under term `t` where `s` is at or below the highest `seqNo` that the copy holds and its [term history](#term-history) gives term `t` for `s`. The new primary decides from its term history and from that highest `seqNo` alone, and it never scans its log, because a log that a restart reopened retains no entry below its persisted position. Holding C implies holding E, because C follows E in the same term. Where the term history no longer covers E's `seqNo`, or where the document holds no write record, the new primary answers `REPLICATION_OUTCOME_UNKNOWN`.

A forwarding node uses `abandonedWrite` for this resend alone, and it must never pass `abandonedWrite` to the client. Where a reply carries no `abandonedWrite`, the forwarding node passes `REPLICATION_OUTCOME_UNKNOWN` to the client.

### Starting a Term

A node that becomes primary under a new term must send [replication.term_start](transport.md#replicationterm_start) to every other copy in the in-sync set as soon as it learns that it leads the term, and before it appends the term's first entry, so that a copy whose log diverged leaves the in-sync set even when the partition receives no writes. The primary holds the partition's write queue until every copy has answered or has left the in-sync set, and it bounds that hold by its `replicationTimeout`.

A replica decides the message inside the partition's write queue. It records the term as accepted, and from then on it must never append an entry under an earlier term, including a compensating entry of its own from a term that it led. It then answers with [replication.term_start_ack](transport.md#replicationterm_start_ack), which carries its highest `seqNo` and the term that its [term history](#term-history) gives for it.

The primary decides each copy from that answer:

1. Where both numbers equal its own, the copy is in step and stays in the in-sync set.
2. Where the copy's highest `seqNo` is below the primary's, and the primary's term history gives the same term for that `seqNo`, the copy lacks entries at the end of the same history. The primary sends it those entries in a `replication.entry_batch`, and the copy stays in the in-sync set once it acknowledges them.
3. Otherwise, the primary asks the controller to remove the copy from the in-sync set, as the [Removal Flow](#removal-flow) defines. This covers a copy whose term history disagrees at its highest `seqNo`, and a copy whose highest `seqNo` is above the primary's, because that copy holds entries of an earlier term that the new primary lacks.

The primary also removes a copy that does not answer within its `replicationTimeout`, and one that refuses the message. A node from before this message sends no reply to it, so during a rolling upgrade the primary removes that copy once the timeout passes, and the copy rejoins through the [Sync Protocol](#sync-protocol). A removed copy whose term history disagrees receives a snapshot there, as [Choosing the Tier](#choosing-the-tier) defines.

Comparing the highest `seqNo` and its term is enough, because [Log Matching](#log-matching) guards every append: where two copies give the same term for one `seqNo`, they hold the same entries up to it. A port must keep both rules together, because either one alone lets a copy that diverged stay in the in-sync set.

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

### Document Write Record

Every copy of a cluster partition, the primary and each replica alike, keeps for each document that it holds the `seqNo` and `primaryTerm` of the entry that last wrote the document, which is the document's write record. A copy sets the record whenever it applies an `INDEX` entry, whether it appended the entry as the primary, received it as a replica, applied it during a [sync](#sync-protocol), or replayed it from its write-ahead log, and it drops the record together with the document when it applies a `DELETE` entry. A copy that loads a [keyword segment](../envelope.md#keyword-segment-payload), from its own checkpoint or from a snapshot that a sync sends, takes each document's record from that segment, and a document that the segment stores with no record holds none until an entry writes it again.

A standalone index, which runs outside a cluster, keeps no write record, and it writes none to the segments that it saves.

### Term History

Every copy of a cluster partition keeps a term history, which lists, for each primary term under which the copy holds entries, that term together with the first `seqNo` that the copy holds under it, in ascending order. The history gives the entry numbered `s` the term of the last listed term whose first `seqNo` is at or below `s`.

A copy appends to its history when it applies an entry of a term above the last listed term. A copy that discards its entries above `s`, as a replica does when it resyncs with a new primary, must drop every listed term whose first `seqNo` is above `s`. A copy that restores a snapshot replaces its history with the history that the snapshot carries. The [manifest](../durability.md#manifest) persists the history, and recovery extends it from the records that it replays.

A copy may drop a listed term once the term after it starts at or below both the oldest `seqNo` that its replication log retains and the `lastSeqNo` of its checkpoint, so that the history stays as long as the failovers that the retained log and the checkpoint span. The history then covers no `seqNo` below the first listed term's first `seqNo`, and a [retry after an ended term](#retry-after-an-ended-term) that asks about such an entry receives `REPLICATION_OUTCOME_UNKNOWN`.

### Log Matching

A replica that appends an entry at the `seqNo` after its highest must first check that its term history gives the entry's `previousPrimaryTerm` for its highest `seqNo`, or 0 where it holds no entry, and it must refuse the message with `REPLICATION_ENTRY_INVALID` where the two differ. The primary then removes the copy from the in-sync set, as the [Removal Flow](#removal-flow) defines, and the copy rejoins through the [Sync Protocol](#sync-protocol), where its disagreeing term history gives it a snapshot. A replica skips the check where the message carries no `previousPrimaryTerm`, and where it seeds an empty log from the entry after a completed sync.

Only the primary of a term appends entries under that term, and each primary appends a `seqNo` once, so one `seqNo` and one term identify one entry. Because every copy appends only where its own highest entry carries the term that the primary gives for that `seqNo`, two copies that give the same term for one `seqNo` hold the same entries up to it. Raft's log matching rule rests on the same argument.

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
   a. It writes the snapshot archive of the partition, as
      Snapshot Archive in durability.md defines.
   b. It prepends a replication snapshot header:
        ReplicationSnapshotHeader {
          lastSeqNo:   uint64   (the lastSeqNo that the archive's
                                 manifest records for the partition)
          primaryTerm: uint64
          partitionId: uint32
          indexName:   string
          checksum:    uint32   (CRC32 of the archive bytes)
        }
   c. It streams the archive to the replica over the node
      transport.
4. The replica verifies the checksum, then applies the archive
   to its copy of the partition.
5. The primary streams the log entries that arrived during the
   transfer, from the header's lastSeqNo + 1 to the current head.
6. The replica applies those entries.
7. The replica moves to steady-state replication.
```

### Choosing the Tier

The replica reports its state and the primary decides:

```text
when replica.lastSeqNo = 0 and primaryLog has discarded no entry:
  use tier 1, incremental
when primaryLog holds an entry at replica.lastSeqNo
     and that entry's primaryTerm equals replica.lastPrimaryTerm:
  use tier 1, incremental
otherwise:
  use tier 2, full snapshot
```

A replica must report in `lastPrimaryTerm` the `primaryTerm` of the entry at its `lastSeqNo`, and the `primaryTerm` of a `ReplicationSnapshotHeader` must hold the `primaryTerm` of the entry at the header's `lastSeqNo`, so that a replica whose log took another history from that point receives a snapshot.

### Partition State During Recovery

A replica that is still bootstrapping holds the partition in `INITIALISING` and serves no reads. A query that would route to it goes to another replica or to the primary instead. Once bootstrapping finishes, the controller moves the partition to `ACTIVE` on that replica, and it starts serving reads.

---

## In-Sync Replica Tracking

The in-sync set records which replicas are fully caught up with the primary. Only a replica in that set is eligible for promotion during failover. The controller stores a different list in the same field while a partition is `UNASSIGNED`, which [No Eligible Replica](#no-eligible-replica) describes.

A replica joins the in-sync set once it has applied every entry up to the partition's commit point. The commit point is the highest sequence number the primary has acknowledged to a client. The primary holds its own commit point, and the controller stores a floor on it in the partition assignment, raising that floor whenever it admits a replica and never lowering it.

A replica leaves the in-sync set when the primary detects it has failed, whether by a timeout on a forwarded entry or by a lost connection. The primary then asks the controller to remove it.

A primary sends each entry only to the copies that its own assignment for the entry's term lists in the in-sync set, together with the replicas whose admission it has asked the controller to confirm, and it leaves out every copy whose removal it has asked for under that term. It counts an acknowledgement only from a copy that it sent the entry to. A copy that the primary removed comes back only through the [Catch-Up Feed](#catch-up-feed) and an admission that the controller confirms, so an assignment that the primary read before the removal and that still lists the copy in the in-sync set never brings it back.

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

### Copy Failure

A node must fail its copy of a partition when the copy cannot apply an entry, including an entry whose `seqNo` does not follow the copy's last `seqNo`, and when it cannot write the partition's write-ahead log. Failing a copy affects that partition alone, and the node's other partitions keep serving.

A node whose failed copy is a replica must ask the controller to remove the copy from the in-sync set, as the [Removal Flow](#removal-flow) defines. It must then delete its index, its write-ahead log and its replication log for the partition, and bootstrap the partition as an empty copy, as [Sync Protocol](#sync-protocol) defines. An empty copy sends `lastSeqNo` 0 and `lastPrimaryTerm` 0 in its `replication.sync_request`.

A node whose failed copy is the primary must refuse every write for the partition with `PARTITION_NOT_PRIMARY` and ask the controller to fail the partition over. The controller must then act as [Failover](#failover) defines for a lost primary: it promotes an in-sync replica, or it follows [No Eligible Replica](#no-eligible-replica) where none remains. Once the node holds a replica of the partition, it follows the rule for a failed replica.

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

A replica must append each entry that it receives to its write-ahead log and make the entry durable under its [durability mode](../durability.md#durability-modes) before it acknowledges the entry.

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
   b. It prefers, in order, a candidate outside removingReplicas,
      then a candidate that has reported no storage errors, then a
      candidate that previously held the primary role, and breaks
      any remaining tie arbitrarily.
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

An empty in-sync set at the moment the primary fails, because every replica had already been removed, moves the partition to `UNASSIGNED`. It then serves neither reads nor writes until a node holding persisted data for that partition rejoins and the controller makes it primary, or the data is rebuilt from the system of record. A primary that gave the partition up through [Copy Failure](#copy-failure) as its last copy must reload the partition from its own checkpoint and write-ahead log before it lists the partition in `cluster.partition_stores`, and where that reload fails, it must leave the partition out of the answer and report a typed error giving the index and the partition, so that the partition stays `UNASSIGNED`.

The controller records the partition's last holders as it moves the partition so that it can recognise a returning node as one of them:

```text
1. The controller writes the failed primary and the replicas that
   were in the in-sync set into lastHolders, and it moves the
   partition to UNASSIGNED.
2. A node named in lastHolders registers with the cluster
   coordinator again.
3. The controller asks that node which partitions of the index it
   holds, over cluster.partition_stores.
4. The controller promotes the node when the answer names the
   partition and carries the indexUuid the coordinator holds:
   a. It sets primary to that node and leaves lastHolders as it
      stands, so a promotion that fails leaves the other holders
      on record.
   b. It raises the primaryTerm.
   c. It moves the partition to INITIALISING, and the node reports
      cluster.bootstrap_complete against its own copy.
5. The controller clears lastHolders as it moves the partition to
   ACTIVE.
6. The promoted primary numbers its first new entry one above
   the greater of the highest seqNo its own log recovered and
   the commitPoint the controller stored, so it reuses no
   seqNo its copy already holds.
```

The controller promotes only a node that lastHolders names, because a copy the list omits can be missing acknowledged writes. It records why the partition stays `UNASSIGNED` in [unassignedReason](cluster.md#unassignedreason) each time it asks, so an operator can tell whether the partition is waiting for a node to return or no node can restore it. The cluster keeps no copy of the partition when none of those nodes returns, so set `replicationFactor` high enough that the case stays unlikely in production.

A partition whose primary fails while the partition is in `INITIALISING` and `lastHolders` is absent has never reached `ACTIVE`, so it holds no acknowledged write. The controller records no `lastHolders` for it. It raises the `primaryTerm` and gives the primary to another eligible node as an empty copy in `INITIALISING`, as at index creation.

### Fencing a Stale Primary

The `primaryTerm` keeps a primary that lost its lease from corrupting a partition:

- A primary cut off from the network cannot renew its lease, and the controller promotes a new primary with a higher `primaryTerm`.
- The old primary that comes back and tries to replicate entries is rejected by the replicas, because its `primaryTerm` is stale.
- The old primary then reads the higher `primaryTerm` from the allocation table, demotes itself, and syncs from the new primary.
- A primary must refuse every write with `PARTITION_NOT_PRIMARY` once its node lease TTL, less a margin for clock drift, has passed since it sent the last lease renewal that the cluster coordinator accepted, because the controller may already have promoted another copy, and no replica sees a write that the primary refuses from its own copy.

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
| `REPLICATION_OUTCOME_UNKNOWN` | The write may or may not have taken effect, because it failed after the primary applied it and the primary could not confirm within `replicationTimeout` that every in-sync copy dropped it, or because the node that forwarded it lost its connection to the primary after sending it or stopped waiting for its answer. Its details carry `reason`, which is `term_ended` where the primary abandoned the write because its term ended, `rollback_open` where the rollback was still incomplete, `lease_lapsed` where the primary's registration lease lapsed before it acknowledged a write that it had applied, `forward_interrupted` where the node that forwarded an update or a remove lost its connection to the primary after it sent the write, and `forward_window_ended` where the node that forwarded the write stopped waiting for its answer once the 30,000 ms window of [Transport Messages](transport.md#transport-messages) closed. |
| `REPLICATION_WRITE_CONFLICT` | A new primary refused an update or a remove that a node sent again after the earlier primary's term ended, because another write touched the document after the earlier primary's attempt, as [Retry After an Ended Term](#retry-after-an-ended-term) defines. The write did not take effect. |
| `REPLICATION_ENTRY_INVALID` | A received entry is malformed, out of order, or not addressed to the receiving replica. |
| `REPLICATION_INSYNC_REMOVAL_FAILED` | The primary could not remove a failed replica from the in-sync set while it still held its term, because no controller was reachable or the controller rejected the request. A primary whose term has moved reports `PARTITION_NOT_PRIMARY` instead. |
| `PARTITION_NOT_PRIMARY` | A write reached a node that is not the primary for the target partition. |
| `PARTITION_UNASSIGNED` | The target partition has no primary, because every copy was lost. |
| `INSUFFICIENT_REPLICAS` | The `waitForActiveReplicas` check failed. |
