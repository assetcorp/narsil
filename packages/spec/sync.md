# Narsil Device Sync Specification

Device sync lets an app search and change an index on a device that has no signal. The device holds an ordinary copy of the index and sends its own writes to the server once it reconnects. Through a feed, it then receives every change that the server accepts from any device or caller.

A device receives the whole index, so device sync applies only to an index whose every document belongs to the user of that device. A developer must leave sync off for a public index and for any index that holds the data of several users or tenants. Narsil has no concept of a tenant or an owner, so the developer decides what an index holds and who can read or write it. A developer who wants sync for many users creates one index for each user.

Device sync reuses the [write-ahead log](durability.md#write-ahead-log-on-disk-format), the [replication log entry](distribution/replication.md#log-entry-format), and the [snapshot archive](durability.md#snapshot-archive). It adds an index epoch, a history of the log segments that a checkpoint would otherwise delete, a published snapshot, and a feed.

---

## The Sync Setting

A caller turns sync on for one index through the `sync` setting:

```text
SyncSetting {
  enabled:         boolean
  historyMaxAgeMs: uint64 or absent   (2,592,000,000, which is 30 days, where absent)
  historyMaxBytes: uint64 or absent   (the length of the published snapshot where absent)
}
```

A node must refuse the setting with `SYNC_DURABILITY_REQUIRED` for an index without [write-ahead log durability](durability.md#tier-1-write-ahead-log-durability-filesystem-only), because the feed reads the log. In a cluster, a node must refuse the setting with `SYNC_BACKUP_STORE_REQUIRED` where the cluster has no [backup store](distribution/backups.md), because a cluster node takes a device's first copy from a backup. It must also refuse the setting with `SYNC_NOT_READY` while any registered node has a specification version below 1.3.

A node must refuse the setting with `CONFIG_INVALID` for an index with [popular query suggestions](query-suggestions.md) on, as [The Setting](query-suggestions.md#the-setting) defines.

Turning sync on gives the index a new [epoch](#index-epoch), except where the index has [change capture](changes.md) on, because every subscriber of the change feed must take a fresh document export after a new epoch. When a caller turns sync off, the node must release the published snapshot, and it must close every device feed connection of the index with close code 4410. It must also delete the index's history, except where the index has change capture on, because the change feed takes its entries from the same history.

The index metadata holds the setting, and a [snapshot archive](durability.md#snapshot-archive) leaves it out, so that a copy that a caller restores onto a device or onto another server serves no feed until a caller turns sync on there. A restore over an index with sync on keeps the index's setting.

---

## Index Epoch

The epoch identifies one history of an index. It is 16 random bytes, written as 32 lowercase hexadecimal digits. Each of these changes alters documents or sequence numbers without a log entry that a device or a [change feed](changes.md#the-feed) subscriber can apply, so a node must give an index with device sync or change capture on a new epoch on each of them, and it must persist the epoch before the change serves a request:

- turning on device sync or change capture while the other one is off
- `clear` on a single node, which empties the index with no log entry
- a restore over the index on a single node
- a change of the partition count, on a single node or in a cluster
- the switch of an [analysis change](adapters.md#analysis-changes)

A cluster removes each document through the log when a caller clears an index, so a clear in a cluster keeps the epoch. A cluster restores a backup only under a new index name, so a restore there creates an index without sync and without change capture.

A new epoch must release the published snapshot and delete the index's history, because both belong to the old epoch. The node must also send `resync` with the reason `epoch` on every device feed connection and every change feed connection of the index, and it must then close each one with close code 4410, so that no device and no subscriber goes on applying entries from the old history. In a cluster, each node does this when its metadata watch delivers the new epoch.

A change that alters no stored term and no document, such as a new BM25 setting or a new synonym set, keeps the epoch, and the node sends each connected device the new settings in a `settings` message.

The node stores the epoch in the index metadata, in the cluster's `IndexSettings`, and in the index configuration payload of every snapshot archive and every backup that it writes for the index. A backup manifest repeats the epoch, so that a node can choose a backup without loading its configuration.

A device's positions are valid only under the epoch under which the device read them, so a device whose epoch differs from the index's must load a fresh snapshot.

---

## Positions

Each partition numbers its own log entries, so a device's position is a list that holds the highest `seqNo` that the device has applied in each partition of the index:

```text
Position {
  partitionId: uint32
  seqNo:       uint64
}
```

A device must keep one `Position` for each partition, from 0 to the partition count less one. A partition count change gives the index a new epoch, so a list of positions never mixes two partition layouts.

The `checkpoint` list of a snapshot archive's manifest gives the archive's positions: each partition's `lastSeqNo` there is the device's position in that partition once it loads the archive.

---

## Published Snapshot

A node publishes one snapshot for each synced index, and every device of that user downloads the same bytes.

1. When a device first asks for the snapshot, the node must persist `sync_active` in the index metadata before it does anything else, so that the next checkpoint keeps [history](#history).
2. The node takes a checkpoint that holds no effect of a log record above any partition's `lastSeqNo`, as [Snapshot Archive](durability.md#snapshot-archive) requires of the checkpoint inside an archive.
3. It writes `<indexName>/sync/published` with an [atomic write](durability.md#atomic-write), which publishes the snapshot. That file is a `.nrsl` envelope with the checksum flag set and `envelope_format_version` 1, whose payload is this MessagePack map:

   ```text
   PublishedSnapshot {
     config:   bytes   (the whole index configuration envelope of the checkpoint)
     manifest: bytes   (the whole manifest envelope of the checkpoint)
   }
   ```

   One file holds both, so that a crash can never pair the configuration of one snapshot with the manifest of another.
4. From then on, the node must keep every file that the published manifest lists, even after a later checkpoint stops listing that file, until it publishes the next snapshot or releases this one. Unchanged files of later checkpoints are the same files, so the published snapshot costs disk only for the files that changed after the node published it.

The published snapshot is the snapshot archive of the published configuration, the published manifest, and the files that the manifest lists. A node must write every header block of that archive with mode `0644`, with owner, group, and modification time 0, with empty user and group names, and with no extended header record other than `path`, so that the archive has the same bytes each time that a node writes it. Its entity tag is the SHA-256 of the payload of `sync/published`, written as 64 lowercase hexadecimal digits, because the manifest records the key, the length, and the checksum of every other file.

A node must serve the archive with its entity tag and its length, and it must serve byte ranges, so that a device can resume a download. A range request whose `If-Range` names another entity tag receives the whole archive under the current tag. A node must keep a file readable while a download reads it, as [Directory Ownership](durability.md#directory-ownership) requires of every reader.

To publish the next snapshot, the node repeats steps 2 and 3, and it then deletes every file that the previous published manifest listed and that neither the index's manifest nor the new published manifest lists. To release the published snapshot, it deletes `sync/published`, then every file that only the published manifest listed, and it clears `sync_active`. A crash in either case leaves files that no manifest lists, and recovery deletes them.

### In a Cluster

A cluster node refuses `snapshot`, so it builds the device's first copy from a [backup](distribution/backups.md). When a device first asks for the snapshot, the node must set `syncActive` in the index's `IndexSettings` with compareAndSet before it chooses a backup, so that every copy starts to keep history. The node must choose the newest backup of the index whose `syncEpoch` equals the index's epoch, and in which each partition's `lastSeqNo` is at or above the oldest `seqNo` of that partition's primary less one, as [Sending Entries](#sending-entries) defines the oldest `seqNo`. Where no backup qualifies, the node must start a backup and answer `SYNC_SNAPSHOT_PREPARING` until the backup completes.

The node must start that backup with `takenBy` set to `sync`, under a name that no backup holds. Once such a backup completes, the controller must delete each backup of the index whose manifest carries `takenBy` `sync`, other than the two with the latest `completedAt`, as [Deleting a Backup](distribution/backups.md#deleting-a-backup) defines, so that these backups take bounded space. It must delete no backup whose manifest lacks `takenBy`, because a caller's backup belongs to the caller. The controller may also keep a backup that a download is reading.

The node sends the backup to the device as one snapshot archive, with headers written as for the published snapshot:

1. The `config` entry holds the backup's index configuration payload.
2. The `manifest` entry lists the segments of every `BackupPartition` in `partitionId` order, with each partition's `lastSeqNo` in `checkpoint`. It lists the vector files of every partition under new file ids, numbered upwards from zero in partition order, and it lists no graph part, because a backup holds none.
3. The other files follow in the order of that manifest.

That archive has the same bytes for the same backup on every node, so its entity tag is the SHA-256 of the backup manifest's bytes, and a device can resume its download from another node. A device that loads an archive with no graph part builds the graph as [Post-Promotion Insertion](vector-index.md#post-promotion-insertion) defines.

---

## History

Without sync and without [change capture](changes.md), a checkpoint deletes the log segments that it covers, as [Checkpoint and Truncation](durability.md#checkpoint-and-truncation) defines. While `sync_active` is set or change capture is on, a node keeps those segments as history, so that a device or a subscriber that reconnects can read every change after its position.

- At step 4 of Checkpoint and Truncation, the node must move each covered segment to `<indexName>/history/<partitionId>/<startSeqNo>-<movedAtMs>`, where both numbers are zero-padded to 16 digits, and where `movedAtMs` is the time of the move in milliseconds since the Unix epoch. The node must move the segment by a rename on the same filesystem and then fsync both directories. A node that finds a log segment gone while it reads the feed must look for that segment in history before it treats the entries as gone, because a checkpoint can move a segment during the read.
- Recovery must read no key under `<indexName>/history/`, because recovery reads every record of every log segment that it finds, while history can hold 30 days of writes.
- The node must delete a partition's oldest history segment once that segment's `movedAtMs` is older than `historyMaxAgeMs`, and while the history of the whole index holds more bytes than `historyMaxBytes`. It must always delete the oldest segment first, so that history holds no gap. Before it deletes a segment that holds an entry above the published snapshot's `lastSeqNo` for that partition, the node must publish the next snapshot, so that a device that falls behind the history can still start from the published snapshot. [History](changes.md#history) of change capture defines the limits of an index with change capture on.
- The node must delete a partition's history whenever it replaces that partition's log, as a replica does when it applies a full snapshot.

Log entries hold no time, so the age limit counts from the move into history. A removed document can therefore stay in history for `historyMaxAgeMs` after the checkpoint that moved its entries. A developer who must erase a document at once can turn sync off for the index and on again, which deletes the history and gives every device a fresh snapshot. On an index with change capture on, the developer must follow the steps that [History](changes.md#history) of change capture gives, because turning sync off there keeps the history.

---

## The Feed

A server offers the published snapshot as a download and the feed as a WebSocket connection. The server must answer the WebSocket upgrade with the subprotocol `narsil.sync.v1` alone, because a device can carry its credential as a further subprotocol value, and an answer that repeats that value can expose the credential.

Every feed message is a MessagePack map in one binary frame:

```text
Device to server:
  Subscribe  { type: 'subscribe', epoch: string, positions: List<Position> }
  Ack        { type: 'ack', positions: List<Position> }
  Checkpoint { type: 'checkpoint', id: uint32 }

Server to device:
  Subscribed { type: 'subscribed', epoch: string, partitionCount: uint32, heads: List<Position>,
               bytesBehind: uint64, snapshotBytes: uint64, windowBytes: uint64, settings: SyncSettings }
  Entries    { type: 'entries', partitionId: uint32, entries: List<ReplicationLogEntry> }
  Settings   { type: 'settings', settings: SyncSettings }
  Checkpoint { type: 'checkpoint', id: uint32, heads: List<Position> }
  Resync     { type: 'resync', reason: 'epoch' or 'history' or 'ahead' }

SyncSettings {
  language:         string
  tokenizer:        string or absent
  stopWords:        string or absent
  stopWordList:     List<string> or absent
  analysisRevision: string or absent
  bm25:             BM25Params or absent
  synonyms:         List<SynonymRule> or absent
}
```

Each key of `SyncSettings` has the type and the meaning of the key of the same name in the [index configuration payload](envelope.md#index-configuration-payload).

An entry of an index with change capture on can hold a `previousDocument`, as [Previous Document](changes.md#previous-document) defines, and a device must apply such an entry from `operation`, `documentId`, and `document` alone.

A node must close the connection with close code 1009 after a device message longer than 65,536 bytes, and with close code 1008 after a message that fails to decode, a message of an unknown `type`, a `subscribe` other than the connection's first message, an `epoch` that is not 32 lowercase hexadecimal digits, and a list of positions that leaves out a partition, repeats one, or holds a partition that the index lacks. It must also close the connection with 1008 after an `ack` above an entry that it has sent, so that a device can't release entries that it never received. The node must compare the device's `epoch` with the index's before it checks the list of positions, because a partition count change gives the index a new epoch, and a device that holds positions from the old layout must receive `resync` with the reason `epoch` and never close code 1008.

### Sending Entries

`heads` holds, for each partition, the highest `seqNo` that the node may send. On a single node, that is the partition's `highest_durable_seq_no` from the [commit marker](durability.md#commit-marker), so that the feed never sends a write that a crash can still lose. In a cluster, it is the partition's [commit point](distribution/replication.md#in-sync-replica-tracking).

A partition's oldest `seqNo` is the lowest `startSeqNo` among its history and log segments, or its head plus one where it holds no segment. After `subscribe`, the node must answer `resync` and then close the connection with close code 4410 in three cases:

- `epoch`, where the device's epoch differs from the index's
- `history`, where a device's `seqNo` lies below the partition's oldest `seqNo` less one
- `ahead`, where a device's `seqNo` lies above the highest `seqNo` that the partition holds

The `ahead` check compares a position with the highest `seqNo` that the partition holds, and never with its head, because a new primary's commit point can start below that of the primary before it, while a device at the earlier commit point holds nothing that the new primary lacks.

Otherwise, the node answers `subscribed`, with `bytesBehind` as the length of the history and log between the device's positions and the heads, so that the device can choose between reading the feed and loading the snapshot. It then sends, for each partition, every entry above the device's position in `seqNo` order, and later every entry that a rising head covers.

The node must stop sending to a connection while the entries that it has sent, and that the device has not acknowledged, hold more than `windowBytes`, which is 8,388,608 by default. It must still send an entry that alone holds more than `windowBytes` once the device has acknowledged every earlier entry. It keeps a connection's acknowledgements only while that connection is open.

The node must read history and log segments in bounded ranges, because a segment can hold 64 MiB. It must read them from their files, so that it can close an idle index while a device stays connected. It must bound the connections that it holds, and it must refuse a connection beyond that bound with `TOO_MANY_REQUESTS`. It must also bound the catch-ups that it reads at one time, and it holds a catch-up beyond that bound until another one ends.

A device sends `checkpoint` to learn the heads at the moment when the node reads that message. A device that sends it after the server acknowledges an upload therefore receives heads that cover every write of the upload.

### In a Cluster

A device can connect to any node. That node reads each partition from the partition's primary with [sync.read](distribution/transport.md#syncread). Every copy of a partition keeps history while `syncActive` is set, so that a new primary can serve the feed after a failover. A replica that applied a full snapshot holds no history below that snapshot, so a device whose position lies below it receives `resync` after a failover to that replica. A node must refuse a connection with `SYNC_NOT_READY` while any registered node has a specification version below 1.3, because such a node can't answer `sync.read`.

Each copy applies the history limits to its own history, and it publishes no snapshot before it deletes a segment, because only the controller takes a backup, and a backup covers every partition. A device whose position lies below the history then receives `resync`, and its next download can return `SYNC_SNAPSHOT_PREPARING` while a node takes a new backup.

---

## The Device

A synced index on a device is an ordinary Narsil index, so a local write is an ordinary write, and a search on the device sees it at once.

- **Queue.** The device must save each local write in a queue before it applies the write, and it must apply its queue again after a restart and after every restore. It uploads an insert or an update as the whole document through the server's write that replaces a document under its ID, because a repeated insert fails with `DOC_ALREADY_EXISTS`. It counts a remove of a missing document as a success. A developer can upload the queue through their own backend, which then decides each conflict, and otherwise the server keeps the last write that it receives.
- **Refused write.** Where the server refuses a write, the device must fetch the server's copy of that document, replace or remove its own copy, drop the write from its queue, and tell the app.
- **Applying the feed.** The device must never apply an entry to a document with a write in its queue, so that the feed can't undo a local edit before the server holds it. After each upload, the device must send `checkpoint`. It then keeps every entry that arrives, on disk and unapplied, until it holds every entry up to the answer's heads, and it applies the newest entry of each document, so that an entry from before the upload can't undo the uploaded edit. Between uploads, the device applies entries in `seqNo` order as they arrive.
- **Its own writes.** A log entry records no origin, so the device must skip an entry whose document equals the document that it already holds under that ID, which spares it a second build of that document's vectors.
- **Settings.** The device must apply the BM25 setting and the synonym set of `subscribed` and of each `settings` message to its own copy.
- **Positions.** The device must save its positions only once the changes that they cover are durable, and it must acknowledge only saved positions. After a crash, it applies its kept entries again in order. Each entry holds a whole document or a remove, so applying an entry twice leaves the same index.
- **Snapshot.** Before it downloads a snapshot, the device must compare `language`, `tokenizer`, `stopWords`, and `stopWordList` from `subscribed` with what it has registered, and it must raise `SYNC_ANALYSIS_UNAVAILABLE` and keep its copy where any of them is missing. Where `analysisRevision` differs from the revision of the device's own module, the restore marks the index stale, and the device starts the rebuild that [Index Metadata Payload](envelope.md#index-metadata-payload) describes. The device must check its memory before the download, and where the old and the new copy can't both fit, the app chooses whether to keep the old copy or to drop it and load the new one.
- **Vectors.** A local write to an index with automatic embedding needs the embedding adapter or a supplied vector, and a text query needs the same model.
- **Browser.** In a browser, the device keeps its queue, its kept entries, and its positions in IndexedDB, and it saves the index through the IndexedDB persistence adapter. That adapter saves the index at a checkpoint alone, as [Snapshot-Only Persistence](durability.md#snapshot-only-persistence) defines, so the device must save its positions after the checkpoint that holds their changes.

---

## Error Codes

| Code | Raised when |
|------|-------------|
| `SYNC_DURABILITY_REQUIRED` | A caller turns sync on for an index without write-ahead log durability. |
| `SYNC_BACKUP_STORE_REQUIRED` | A caller turns sync on in a cluster without a backup store. |
| `SYNC_NOT_READY` | A caller turns sync on, or a device connects, while a registered node has a specification version below 1.3. |
| `SYNC_NOT_ENABLED` | A device asks for the snapshot or the feed of an index without sync. |
| `SYNC_SNAPSHOT_PREPARING` | A cluster node is taking the backup that a device's snapshot needs. |
| `SYNC_ANALYSIS_UNAVAILABLE` | A device lacks the language, the tokeniser, or the stop words that the server's copy uses. |

| Close code | Meaning |
|------------|---------|
| 1001 | The node is shutting down, and the device can connect again to any node. |
| 1008 | The device sent a message that breaks the rules of [The Feed](#the-feed). |
| 1009 | The device sent a message longer than 65,536 bytes. |
| 1011 | The node failed to serve the connection, and the device can connect again. |
| 4401 | The credential that admitted the connection has expired. |
| 4410 | The device must load a fresh snapshot. |
