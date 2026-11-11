# Narsil Change Capture Specification

Change capture lets a backend service follow every insert, update, and removal on an index. The service saves a position for each partition, and after a restart it receives every change above those positions. A change can also hold the document as it stood before the write, and a subscriber to such an index can ask for the changes that match a filter alone.

A subscriber receives the documents of the whole index, so the developer decides which callers may subscribe. Narsil has no concept of a tenant or an owner, so a filter chooses what a subscriber receives and grants no access.

Change capture reuses the [write-ahead log](durability.md#write-ahead-log-on-disk-format), the [replication log entry](distribution/replication.md#log-entry-format), and three parts of device sync: the [index epoch](sync.md#index-epoch), the [positions](sync.md#positions), and the [history](sync.md#history). It adds a setting, the previous document in a log entry, a feed of changes, and positions in a [document export](durability.md#document-export).

---

## The Changes Setting

A caller turns change capture on for one index through the `changes` setting:

```text
ChangesSetting {
  enabled:          boolean
  previousDocument: boolean or absent  (false where absent)
  historyMaxAgeMs:  uint64 or absent   (2,592,000,000, which is 30 days, where absent)
  historyMaxBytes:  uint64 or absent   (the larger of the checkpoint length and 1,073,741,824 where absent)
}
```

The checkpoint length is the sum of the lengths of the files that the index's [manifest](durability.md#manifest) lists. The default never falls below 1,073,741,824 bytes, because an index that receives many updates and removals can stay small while its log grows. `previousDocument` takes effect only while `enabled` is true.

A node must refuse the setting with `CHANGES_DURABILITY_REQUIRED` for an index without [write-ahead log durability](durability.md#tier-1-write-ahead-log-durability-filesystem-only), because the feed takes its entries from the log. In a cluster, a node must refuse the setting with `CHANGES_BACKUP_STORE_REQUIRED` where the cluster has no [backup store](distribution/backups.md), because a cluster node builds a document export from a backup. It must also refuse the setting with `CHANGES_NOT_READY` while any registered node has a specification version below 1.5, because such a node keeps no history for change capture.

A node must persist the setting before it answers the caller, and every checkpoint of the index from then on must keep [history](#history).

Turning capture on gives the index a new [epoch](sync.md#index-epoch), except where the index has device sync on, because every device must load a fresh snapshot after a new epoch. When a caller turns capture off, the node must close every change feed connection of the index with close code 4410, and it must delete the index's history where `sync_active` is unset.

A change of `previousDocument` applies to every entry that the primary writes after the change, and it keeps the epoch. When a caller turns the option off, the node must close every connection whose subscription holds a filter, as [Filters](#filters) defines.

The index metadata holds the setting, and a [snapshot archive](durability.md#snapshot-archive) leaves it out, so that a copy that a caller restores onto another server serves no feed until a caller turns capture on there. A restore over an index with capture on keeps the index's setting.

---

## History

While capture is on, a node keeps the log segments that a checkpoint covers as [History](sync.md#history) defines, whether or not `sync_active` is set.

- An index with capture on and `sync_active` unset holds no published snapshot, so the node deletes a segment under the age limit and the byte limit alone.
- An index with capture on and `sync_active` set has two age limits and two byte limits. The node must apply the higher age limit and the higher byte limit, so that each feature keeps the history that its limits allow.
- Every copy of a partition in a cluster must keep history while capture is on, so that a new primary can serve the feed after a failover.

Log entries hold no time, so the age limit counts from the move into history. A removed document can therefore stay in history for `historyMaxAgeMs` after the checkpoint that moved its entries, and with `previousDocument` on, the entry of the removal holds the document's content as well. A developer who must erase a document at once can turn capture off for the index, together with device sync where it is on, and then turn each one on again, because the node deletes the history once both are off.

---

## Previous Document

With `previousDocument` on, the primary writes into each log entry the document that the entry replaces or removes. [Log Entry Format](distribution/replication.md#log-entry-format) defines the field and its checksum, and [Segment Header](durability.md#segment-header) defines the framing version of a segment that holds such an entry.

- The primary must take the previous document from the state of the partition after the entry with the next lower `seqNo`, so that the second of two writes to one document in one batch records the document that the first one left.
- The previous document is the complete document body, with every field and every computed vector, as `document` holds it for an `INDEX` entry.
- The primary must write the key with a nil value where the partition held no document under that ID, so that a reader can tell an insert from an update.
- A replica must store the entry as it receives it, and recovery must replay it as it reads it. Neither one computes the previous document again.
- A primary must write an entry of an index with `previousDocument` off without the key, with the bytes that specification version 1.4 gives that entry.

A [device feed](sync.md#the-feed) sends each entry as the log holds it, so a device of an index with both features on receives the previous document. The device must apply such an entry from `operation`, `documentId`, and `document` alone.

---

## The Change

A feed and the engine's changes operation both deliver a change in this form:

```text
Change {
  seqNo:            uint64
  type:             'put' or 'insert' or 'update' or 'remove'
  documentId:       string
  document:         Map<string, value> or absent   (the document after the write)
  previousDocument: Map<string, value> or absent   (the document before the write)
}
```

A node derives each change from one log entry:

| Entry | Change |
| --- | --- |
| `INDEX` without the `previousDocument` key | `put`, with `document` |
| `INDEX` with a nil `previousDocument` | `insert`, with `document` |
| `INDEX` with a `previousDocument` | `update`, with `document` and `previousDocument` |
| `DELETE` without the key, or with a nil value | `remove` |
| `DELETE` with a `previousDocument` | `remove`, with `previousDocument` |

`document` and `previousDocument` each hold the document as a MessagePack map, so a subscriber decodes a change in one pass. A node may copy the stored bytes of a document into the change without decoding them.

---

## The Feed

A server offers the feed as a WebSocket connection. It must answer the upgrade with the subprotocol `narsil.changes.v1` alone, because a subscriber can send its credential as a further subprotocol value, as a device does under [The Feed](sync.md#the-feed) of device sync. It must refuse a connection to an index without capture with `CHANGES_NOT_ENABLED`.

Every feed message is a MessagePack map in one binary frame:

```text
Subscriber to server:
  Subscribe  { type: 'subscribe', epoch: string or absent, positions: List<Position> or absent,
               filter: FilterExpression or absent }
  Ack        { type: 'ack', positions: List<Position> }

Server to subscriber:
  Subscribed { type: 'subscribed', epoch: string, partitionCount: uint32, positions: List<Position>,
               heads: List<Position>, bytesBehind: uint64, windowBytes: uint64, previousDocument: boolean }
  Changes    { type: 'changes', partitionId: uint32, changes: List<Change>, scannedSeqNo: uint64 }
  Resync     { type: 'resync', reason: 'epoch' or 'history' or 'ahead' }
```

A `subscribe` must hold both `epoch` and `positions` or neither of them. For a subscription with neither, the node takes each partition's head as the subscriber's position, and `subscribed` returns the epoch and those positions, so that a new subscriber can follow an index from the present without exporting it. A subscription with both resumes from the positions that it gives, and `subscribed` returns the same positions. `previousDocument` in `subscribed` holds the index's setting, so that a subscriber learns whether a change can hold the document before the write.

A node must close the connection with close code 1009 after a subscriber message longer than 65,536 bytes. It must close the connection with close code 1008 after any of these:

- a message that fails to decode, or a message of an unknown `type`
- a `subscribe` other than the connection's first message
- a `subscribe` that holds one of `epoch` and `positions` without the other
- an `epoch` that is not 32 lowercase hexadecimal digits
- a list of positions that leaves out a partition, repeats one, or holds a partition that the index lacks
- a `filter` that breaks the shape or the limits of a query's filters, or that tests a field which the schema leaves out
- an `ack` of a `seqNo` above both the partition's position in `subscribed` and the highest `scannedSeqNo` that the node has sent for that partition

The node must compare the subscriber's `epoch` with the index's before it checks the list of positions, as [The Feed](sync.md#the-feed) of device sync requires.

### Sending Changes

`heads`, the oldest `seqNo` of a partition, and the three `resync` cases have the meanings that [Sending Entries](sync.md#sending-entries) gives them. After `resync`, the node must close the connection with close code 4410.

Otherwise, the node answers `subscribed`, with `bytesBehind` as the length of the history and log between the subscriber's positions and the heads. It then sends, for each partition, a change for every entry above the subscriber's position in `seqNo` order, and later a change for every entry that a rising head covers. Under a filter, [Filters](#filters) defines what the node sends for each entry.

`scannedSeqNo` is the highest `seqNo` of the partition that the node has examined for this connection. It equals the `seqNo` of the message's last change where the subscription holds no filter. Under a filter, it can lie above that, and a node must send a `changes` message with an empty list at least once for every `windowBytes` of entries that it examines without sending a change, so that the position of a subscriber whose filter matches little still rises above the history's oldest entry.

The window, the bounded reads of segments, the bound on connections with its `TOO_MANY_REQUESTS` refusal, and the bound on catch-ups apply as Sending Entries defines them, with a separate count of connections and of catch-ups for each of the two feeds. The window counts the bytes of the changes that the node has sent and that the subscriber has not acknowledged.

A node keeps no record of a subscriber once its connection closes.

### Filters

A `filter` is a `FilterExpression`, as [QueryParams](distribution/transport.md#queryparams) describes it, under the limits that [Filters](native-core.md#filters) sets for a query's filters. A node must close a connection whose `subscribe` holds a filter with close code 4409, and with `CHANGES_PREVIOUS_DOCUMENT_REQUIRED` as the close reason, where the index has `previousDocument` off. It must close an open connection whose subscription holds a filter in the same way when a caller turns the option off.

The node tests the filter against the document before the write and against the document after it, and what it sends follows from the two results:

| Before | After | The node sends |
| --- | --- | --- |
| no match, or no document | match | `insert`, with `document` and no `previousDocument` |
| match | no match, or no document | `remove`, with `previousDocument` and no `document` |
| match | match | the change as it is |
| no match, or no document | no match, or no document | nothing |

A catch-up can reach an entry without the `previousDocument` key, which the primary wrote while the option was off, and such an entry gives the node no document before the write. Where the document after the write matches the filter, the node must send `put`. Otherwise, it must send `remove` with no `previousDocument`, so that the subscriber drops a document that matched before the write.

### In a Cluster

A subscriber can connect to any node. That node takes each partition's entries from the partition's primary with [sync.read](distribution/transport.md#syncread), and it sends a change only for an entry at or below the partition's [commit point](distribution/replication.md#in-sync-replica-tracking). A replica that applied a full snapshot holds no history below that snapshot, so a subscriber whose position lies below it receives `resync` after a failover to that replica. A node must refuse a connection with `CHANGES_NOT_READY` while any registered node has a specification version below 1.5, because such a node keeps no history for change capture.

---

## The Subscriber

- **Order.** A subscriber's position in a partition is the `scannedSeqNo` of the last `changes` message whose changes it has applied. A subscriber must apply the changes of a message before it saves that position, and it must acknowledge only saved positions.
- **Repeats.** A node delivers each change at least once, so a subscriber can receive a change again after a reconnection. Each change holds a whole document or a removal, so applying a change twice leaves the same result. A subscriber must count a `remove` of a document that it lacks as a success.
- **Resync.** After `resync`, a subscriber must take a [document export](#positions-in-a-document-export) of the index, replace its copy with the export's documents, and subscribe with the epoch and the positions in the export's header.
- **Engine.** An implementation that embeds the engine must offer an operation that returns the changes above a list of positions, under the same epoch, heads, and `resync` rules, so that a program can subscribe without a server. The operation must return each group of changes with its `partitionId` and its `scannedSeqNo`, as a `changes` message holds them, so that the program can save a position. Where the feed would send `resync`, the operation must return the resync and its reason as a result and then end, because a resync is an outcome that every subscriber handles, and the feed reports it as a message. Where the feed would close a connection with close code 1008 over an `epoch` or a list of positions, the operation must fail with `CHANGES_INVALID_POSITIONS`. It must fail with `CHANGES_NOT_ENABLED` for an index without capture, with `SEARCH_INVALID_FILTER` for a filter that breaks the shape or the limits of a query's filters, with `SEARCH_INVALID_FIELD` for a filter that tests a field which the schema leaves out, as a query's filter does, and with `CHANGES_PREVIOUS_DOCUMENT_REQUIRED` for a filter on an index with `previousDocument` off.

---

## Positions in a Document Export

The header of a document export of an index with capture on must hold the index's epoch and one position for each partition:

```text
{ "format": "narsil-export", "version": 1, "index": IndexConfiguration,
  "epoch": string, "positions": [{ "partitionId": uint32, "seqNo": uint64 }] }
```

Each position is the partition's `lastSeqNo` in the checkpoint that the writer takes the documents from, so the export holds the effect of every entry at or below its positions. A subscriber that replaces its copy with the export and subscribes from those positions therefore misses no change. A reader that imports the export must ignore both keys.

### In a Cluster

A cluster node builds the export of an index with capture on from a [backup](distribution/backups.md). The node must choose the newest backup of the index whose `syncEpoch` equals the index's epoch, and in which each partition's `lastSeqNo` is at or above the oldest `seqNo` of that partition's primary less one. Where no backup qualifies, the node must start a backup with `takenBy` set to `changes`, under a name that no backup holds, and it must answer `CHANGES_EXPORT_PREPARING` until that backup completes. The controller must delete each backup of the index whose manifest holds `takenBy` `changes`, other than the two with the latest `completedAt`, as [In a Cluster](sync.md#in-a-cluster) requires for the backups that device sync starts.

The node must write the documents of every `BackupPartition` in `partitionId` order, with the value of each vector field from the backup's vector files, and it must take each position from the partition's `lastSeqNo`.

---

## Error Codes

| Code | Raised when |
|------|-------------|
| `CHANGES_DURABILITY_REQUIRED` | A caller turns capture on for an index without write-ahead log durability. |
| `CHANGES_BACKUP_STORE_REQUIRED` | A caller turns capture on in a cluster without a backup store. |
| `CHANGES_NOT_READY` | A caller turns capture on, or a subscriber connects, while a registered node has a specification version below 1.5. |
| `CHANGES_NOT_ENABLED` | A subscriber asks for the feed, or a program asks for the changes, of an index without capture. |
| `CHANGES_PREVIOUS_DOCUMENT_REQUIRED` | A subscription holds a filter on an index with `previousDocument` off. |
| `CHANGES_EXPORT_PREPARING` | A cluster node is taking the backup that a document export needs. |
| `CHANGES_INVALID_POSITIONS` | A program that embeds the engine asks for changes with an `epoch` that is not 32 lowercase hexadecimal digits, with one of `epoch` and the positions without the other, or with a list of positions that leaves out a partition, repeats one, or holds a partition that the index lacks. |

| Close code | Meaning |
|------------|---------|
| 1001 | The node is shutting down, and the subscriber can connect again to any node. |
| 1008 | The subscriber sent a message that breaks the rules of [The Feed](#the-feed). |
| 1009 | The subscriber sent a message longer than 65,536 bytes. |
| 1011 | The node failed to serve the connection, and the subscriber can connect again. |
| 4401 | The credential that admitted the connection has expired. |
| 4409 | The index's setting refuses the subscription, and the close reason holds the error code. |
| 4410 | The subscriber must take a fresh document export. |
