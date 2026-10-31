# Narsil Durability Specification

This document defines how a single node survives a crash and restores its data on restart. Durability rests on two artefacts: a periodic snapshot, called the checkpoint, and a write-ahead log of every mutation since that checkpoint. On restart a node loads the snapshot and replays the log records the snapshot does not already contain. A filesystem deployment gets that full guarantee, and a persistence backend that is not filesystem-backed gets the weaker snapshot-only guarantee defined in [Snapshot-Only Persistence](#snapshot-only-persistence).

A write-ahead log record is the same entry the replication protocol uses; see [replication.md](distribution/replication.md). There is one log, not two. This document adds the on-disk framing, the fsync rules, recovery, checkpointing, and truncation that turn the in-memory replication log into a durable log. A single node uses it for crash recovery, and a cluster uses the same log for replication.

Every conforming implementation must read and write these formats identically, whatever language it is written in.

Structure definitions use a language-neutral notation. `List<T>` is an ordered collection of `T`, `Map<K, V>` a mapping from keys to values, and width-tagged names such as `uint32` describe exact byte widths on disk.

---

## Model

A node holds its index in memory. Persistence comes in two tiers, and each publishes a different guarantee.

### Tier 1: Write-Ahead Log Durability, Filesystem Only

The strong tier pairs a periodic snapshot with a write-ahead log.

- The **snapshot**, or checkpoint, is the full index state at a point in time, which a node writes as the files of a [segmented checkpoint](#segmented-checkpoint) and commits with one atomic write of their manifest. A node takes one periodically.
- The **write-ahead log** is an append-only, per-partition log of mutations. A mutation reaches the log durably before the write is acknowledged.

Recovery loads the latest snapshot and then replays the log records whose sequence number exceeds the snapshot's recorded checkpoint position. This tier needs a real filesystem, because it relies on append, fsync, and atomic rename. Its guarantee is that no acknowledged write is lost; see [Durability Modes](#durability-modes).

### Tier 2: Snapshot-Only Persistence, Any Backend

A persistence adapter that is not filesystem-backed cannot run a write-ahead log, because a key-to-bytes interface expresses neither append nor fsync. Such a backend persists periodic snapshots alone. Recovery restores the last snapshot and has no log to replay, so the guarantee is that the index is durable up to that snapshot and a crash loses every write made since. See [Snapshot-Only Persistence](#snapshot-only-persistence).

### Tier Selection

An implementation selects the tier from the backend: a filesystem-backed adapter runs Tier 1, and any other adapter runs Tier 2. The optional `durability.tier` field, `wal` or `snapshot`, overrides that selection. `tier: "snapshot"` forces snapshot-only persistence onto any adapter, a filesystem-backed one included; a deployment chooses this when several processes share one directory, because a node holds its write-ahead log directory alone; see [Directory Ownership](#directory-ownership). `tier: "snapshot"` without a persistence adapter raises `CONFIG_INVALID`, and `tier: "wal"` where no directory can be resolved raises `CONFIG_INVALID`. The write-ahead log fields `durability.directory`, `durability.mode`, `durability.flushIntervalMs`, `durability.segmentMaxBytes`, and `durability.compactionThreshold` cannot combine with `tier: "snapshot"`; the combination raises `CONFIG_INVALID`.

---

## Relationship to Other Documents

- **Log entry format.** [replication.md](distribution/replication.md) defines `ReplicationLogEntry` with its `seqNo`, `primaryTerm`, `operation`, `partitionId`, `indexName`, `documentId`, `document`, and `checksum` fields. The write-ahead log stores exactly that entry.
- **Snapshot container.** [envelope.md](envelope.md) defines the `.nrsl` 32-byte header, the CRC32 payload checksum, and the MessagePack payload.
- **Checksum.** CRC32 under the IEEE polynomial, defined in [CRC32](algorithms.md#crc32). The same algorithm covers the envelope checksum, the log frame checksum, the commit marker checksum, and the log entry checksum.

---

## Durability Modes

Write-ahead log durability runs in one of two modes, and the mode fixes the guarantee a node may publish.

### sync, the default

A write is acknowledged only after its log record and the commit marker have both been made durable by fsync. Writes that arrive while an fsync is in flight share the next fsync, so group commit spreads the fsync cost across many writes without weakening anything.

The guarantee is that no acknowledged write is lost to a process crash or a power cut, subject to the platform fsync behaviour in [Platform Notes](#platform-notes).

### async

A write is appended to the segment and acknowledged with no fsync. A background task fsyncs the segment and advances the commit marker every `flush_interval_ms`, 1000 by default. The marker therefore tracks the fsynced frontier alone, and records appended since the last fsync lie beyond it.

The guarantee is weaker: a power cut can lose the acknowledged writes of the last fsync window, up to `flush_interval_ms` worth. A clean process crash loses nothing, because the operating system flushes the buffered bytes and recovery replays the records beyond the frontier; see [Reading a Segment](#reading-a-segment).

### An fsync Error Is Fatal

An implementation must never retry a failed fsync and treat the retry as success. On some operating systems a failed fsync drops the dirty page, and the next fsync then reports success although the data never reached the disk. The write must not be acknowledged. Raise `PERSISTENCE_FSYNC_FAILED` as a fatal error and recover from the durable log.

---

## Directory Ownership

A node must hold its write-ahead log directory alone, so that no two processes append to one log.

- Before recovery lists the directory, the node must create the file `.narsil.lock` in the directory root without replacing an existing file. The file must contain four lines: the process id, the thread id, the process start time in milliseconds since the Unix epoch, and a random token that is unique to this open.
- The node should write the file under a temporary name and link it into place, so that a reader never finds it empty. On a filesystem without hard links, the node may create the file in place with exclusive creation.
- Where the file records a running process other than the node's own, the node must refuse to start with `CONFIG_INVALID`.
- Where the file records the node's own process id and a process start time within one second of the node's own, another open in the same process holds the directory, and the node must refuse to start with `CONFIG_INVALID`.
- Where the file records a process that no longer runs, the node's own process id with a start time more than one second away, or no process id, the node may delete the file and create it again.
- A second open of a directory from inside the process that holds it must fail with `CONFIG_INVALID`, and the node must identify the directory by its device and inode numbers, so that a symbolic link or another spelling of the path counts as the same directory.
- A node that fails after it creates the file and before it finishes starting must delete the file.
- The node must delete `.narsil.lock` on a clean shutdown, and only while the file still contains its own token.

The node must record the directory's device and inode numbers once the directory exists. It must compare them with the directory on disk, and read the token in `.narsil.lock`, before it acknowledges a `sync` write, before each checkpoint, and at an interval that should be no longer than one second. A missing directory, a directory with other numbers, and a lock file with another token are fatal: the node raises `PERSISTENCE_SAVE_FAILED`, acknowledges no later write, and reports the failure on its durability error channel.

A checkpoint that fails with an error of the host filesystem is fatal in the same way, and the node must report it as `PERSISTENCE_SAVE_FAILED` carrying the host error as its cause.

---

## Write-Ahead Log On-Disk Format

### Segment Files

The log for one partition is a sequence of append-only segment files.

- Each `(indexName, partitionId)` pair has one log.
- The key is `<indexName>/wal/<partitionId>/<startSeqNo>`, where `startSeqNo` is the sequence number of the segment's first record, written as 16 digits with leading zeros so that segments sort lexically in sequence order.
- A segment is append-only and is never modified in place. Reclaiming one means deleting the whole file; see [Checkpoint and Truncation](#checkpoint-and-truncation).
- A node must open a new segment before an append that would carry the active segment past `segment_max_bytes`, and when a checkpoint runs. `segment_max_bytes` is 67,108,864 by default, which is 64 MiB, and a node must refuse a value above 2,147,483,647 with `CONFIG_INVALID`, so that every segment stays inside the [file size](envelope.md#file-size) limit.

Because a segment is only ever appended to or deleted whole, a reader can never meet a stale record left over from an earlier use of the same bytes.

### Segment Header

Every segment file begins with exactly 8 bytes:

```text
Offset  Size  Type      Field               Description
------  ----  ----      -----               -----------
0       4     bytes     magic               "NRSW" (0x4E 52 53 57)
4       1     uint8     wal_format_version  Log framing version (1)
5       3     bytes     reserved            All 0x00 on write
```

A reader must reject a segment that does not begin with the `NRSW` magic, and must refuse, with a clear message, a segment whose `wal_format_version` is higher than the version it supports.

### Record Frame

Each record follows the segment header:

```text
Offset  Size  Type      Field          Description
------  ----  ----      -----          -----------
0       4     uint32be  record_length  Byte length of the payload
4       N     bytes     payload        MessagePack ReplicationLogEntry
4+N     4     uint32be  frame_crc32    CRC32 (IEEE) of the payload bytes
```

`payload` is the MessagePack encoding of the `ReplicationLogEntry` exactly as [replication.md](distribution/replication.md) defines it, the entry's own `checksum` field included.

`frame_crc32` covers the `payload` bytes alone. The entry's `checksum` field carries logical integrity for transfer between nodes, and the frame checksum carries on-disk integrity. Both use CRC32 under the IEEE polynomial.

### Commit Marker

A reader must not trust a record's `record_length` to find where the durable region of a segment ends, because a corrupt length would send the reader to the wrong offset and risk dropping acknowledged records without a word. Each partition therefore keeps a small commit marker that records, after every durable flush, exactly how far the active segment is durable.

The marker is stored at `<indexName>/wal/<partitionId>/commit`. It holds two fixed-size slots, so a torn marker write never destroys the last good value:

```text
Offset  Size  Type      Field                   Description
------  ----  ----      -----                   -----------
0       8     uint64be  write_seq               Marker write counter, increasing
8       8     uint64be  active_segment_seq_no   startSeqNo of the active segment
16      8     uint64be  durable_byte_length     Durable byte length of the active segment
24      8     uint64be  highest_durable_seq_no  Highest seqNo durable across the log
32      4     uint32be  marker_crc32            CRC32 (IEEE) of bytes 0 to 31
```

A slot is 36 bytes. Slot 0 starts at offset 0 and slot 1 at offset 36, so the marker file is 72 bytes.

A node updates the marker as the final step of a durable flush:

1. fsync the active segment, so that the appended records are durable.
2. Write the marker into the slot that was not written last, with `write_seq` increased by one, `durable_byte_length` set to the fsynced length, and `highest_durable_seq_no` set to the highest seqNo now durable across the log.
3. fsync the marker.

In sync mode a node acknowledges a write only after the marker fsync returns. A torn marker write fails its slot's CRC, and recovery falls back to the other slot, whose smaller `durable_byte_length` discards the unacknowledged tail. A node never acknowledges a write whose marker update is not yet durable.

Creating a new segment file, or creating the marker file for the first time, requires an fsync of the partition directory so that the new directory entry survives a crash.

The marker always names the current active segment. Rolling to a new segment advances the marker to it as part of the roll, so the marker never names a sealed segment and a checkpoint never deletes the segment that the marker names active; see [Checkpoint and Truncation](#checkpoint-and-truncation). In sync mode a node flushes on every group commit. In async mode a node flushes on the `flush_interval_ms` timer alone, so the marker lags the appended records by up to one interval and those records recover as described next.

### Reading a Segment

Recovery uses the commit marker to find each segment's durable region and then reads the records inside it.

1. Read the partition's commit marker and take the slot with the highest `write_seq` whose `marker_crc32` is valid. When neither slot is valid, or the marker is absent, the partition has no acknowledged log records beyond the snapshot and recovery replays nothing from the log.
2. Delete every segment whose `startSeqNo` is greater than `active_segment_seq_no`. Such a segment holds only unacknowledged records from a roll that a crash interrupted.
3. A segment whose `startSeqNo` is below `active_segment_seq_no` was sealed before the active segment opened, so it is durable in full. Read every record in it.
4. In the active segment, the first `durable_byte_length` bytes are the fsynced frontier. Read the records inside the frontier by byte offset, never by trusting a record's own length to find where the frontier ends.
5. Inside the frontier every record must be complete and valid. A `record_length` that overruns the frontier, a `frame_crc32` mismatch, a payload that fails to decode, a failed entry checksum, or a `seqNo` out of order is corruption of acknowledged, fsynced data. Recovery refuses to start and raises `PERSISTENCE_WAL_CORRUPT`.
6. Once every segment has been read up to the frontier, the highest `seqNo` read must equal `highest_durable_seq_no`. A lower value means a durable record is missing, which is corruption; refuse and raise `PERSISTENCE_WAL_CORRUPT`.
7. Past `durable_byte_length` in the active segment lie records appended but not yet fsynced, which stay unacknowledged in both modes. In async mode these are the records since the last flush; in sync mode they are the records of a write that a crash caught between its append and its fsync. Recovery parses them one at a time and replays each record that is complete, valid, and carries a `seqNo` above `highest_durable_seq_no`. It stops at the first record that is incomplete or fails its checksum, treats that as the torn tail, truncates the segment to the end of the last good record, and fsyncs it.

Recovery reads the fsynced frontier deterministically and treats any failure inside it as fatal, so a node reports every failure inside acknowledged, fsynced data. Recovery parses the tail beyond the frontier on a best-effort basis alone. In async mode that tail holds the window that the async guarantee already allows a node to lose, while in sync mode it holds writes that a node never acknowledges. A clean crash keeps the tail that the operating system flushed, while a power cut keeps the records up to the first torn frame.

---

## Atomic Write

A node must replace the content of a key atomically and durably wherever this document calls for an atomic write, skipping step 1 only where this document says so:

1. Wrap the payload in the `.nrsl` envelope with its CRC.
2. Write the bytes to a temporary file in the same directory as the destination.
3. fsync the temporary file.
4. Rename the temporary file over the key's file.
5. fsync the containing directory.

A crash before step 4 leaves the previous content in place, and recovery then discards the temporary file. Every fsync error is fatal, as [Durability Modes](#durability-modes) describes.

---

## Segmented Checkpoint

Both persistence tiers write the segmented checkpoint. It stores documents and vectors in files that later checkpoints leave unchanged, so the bytes that a checkpoint writes grow with the changes since the last checkpoint, while a checkpoint writes the graph of a changed vector field whole.

### Layout

A segmented checkpoint is a manifest, the segment files of each partition, and the vector files and graph parts of each vector field, stored under the keys in [Storage Path Convention](envelope.md#storage-path-convention). A writer must number a partition's segments upwards from zero and zero-pad each id to 16 digits, so that segment keys sort in creation order. A partition must hold at most 65,536 segments. Every file of the checkpoint must stay inside the [file size](envelope.md#file-size) limit.

A segment file is a `.nrsl` envelope with the checksum flag set and `envelope_format_version` 4, whose payload is a [keyword segment payload](envelope.md#keyword-segment-payload).

A vector file is a `.nrsl` envelope with the checksum flag set and `envelope_format_version` 2, whose payload is a [vector file payload](envelope.md#vector-file-payload). A writer must number a field's vector files upwards from zero, must zero-pad each id to 16 digits, and must leave a vector file unchanged after it writes the file.

A graph part is a `.nrsl` envelope with the checksum flag set and `envelope_format_version` 2, whose payload is a [vector graph payload](envelope.md#vector-graph-payload). A writer must number the parts of one generation upwards from zero. A vector field has one list of vector files and the graph parts of at most one generation for the whole index, because a [vector index](vector-index.md) covers every partition.

### Manifest

Writing the manifest commits a checkpoint. The manifest is a `.nrsl` envelope with the checksum flag set and `envelope_format_version` 2, whose payload is a MessagePack map. A reader must upgrade an index whose manifest `version` is 6, as [Earlier Layouts](#earlier-layouts) defines, and it must reject a manifest whose `version` is anything other than 6 or 7 with `ENVELOPE_VERSION_MISMATCH`.

```text
SegmentManifest {
  version:    uint8   (7)
  schema:     Map<string, string>
  language:   string
  checkpoint: List<PartitionCheckpoint>
  partitions: List<PartitionManifestEntry>
  vectors:    List<VectorFieldRef>   (one entry per vector field)
}

PartitionCheckpoint {
  partitionId: uint32
  lastSeqNo:   uint64   (the highest seqNo that the checkpoint holds)
  primaryTerm: uint64
  termHistory: List<TermStart> or absent   (a cluster partition copy's term history, in ascending order)
}

TermStart {
  primaryTerm: uint64
  firstSeqNo:  uint64   (the first seqNo that the copy holds under primaryTerm)
}

PartitionManifestEntry {
  partitionId:   uint32
  nextSegmentId: uint64
  segments:      List<SegmentRef>
}

SegmentRef {
  id:             uint64
  key:            string
  docCount:       uint32
  tombstoneCount: uint32
  bytes:          uint64   (the length of the file, header included)
  checksum:       uint32   (the checksum in the file's header)
}

VectorFieldRef {
  fieldPath:       string
  nextFileId:      uint64
  files:           List<VectorFileRef>
  graphGeneration: uint64          (the generation of the field's newest graph parts, 0 before its first)
  graphParts:      List<FileRef>   (in part order, empty while the field holds no graph)
}

VectorFileRef {
  id:       uint64
  key:      string
  count:    uint32         (the vectors in the file, dead ones included)
  dead:     bytes or nil   (one bit per vector, nil while every vector is live)
  bytes:    uint64         (the length of the file, header included)
  checksum: uint32         (the checksum in the file's header)
}

FileRef {
  key:      string
  bytes:    uint64   (the length of the file, header included)
  checksum: uint32   (the checksum in the file's header)
}
```

`checkpoint` records, for each partition, the highest `seqNo` that the checkpoint holds, so recovery must replay each partition's log from its `lastSeqNo + 1`.

`termHistory` records the [term history](distribution/replication.md#term-history) of a cluster partition copy up to `lastSeqNo`, and recovery extends it with the terms of the records that it replays. A writer must leave `termHistory` out for a standalone index. A reader must raise `PERSISTENCE_LOAD_FAILED` where the terms or the first seqNos of `termHistory` fail to ascend strictly, or where a first seqNo lies above `lastSeqNo`. A reader that finds no `termHistory` for a cluster partition copy starts the copy's history from the records that it replays, so that the history covers no `seqNo` at or below `lastSeqNo`.

A reader must raise `PERSISTENCE_LOAD_FAILED` for a listed key that differs from the key that [Storage Path Convention](envelope.md#storage-path-convention) builds for the entry, where a graph part's number is its position in `graphParts`. A reader must compare a file's length with `bytes` before it reads the file, and it must raise the same error for a file whose length or header checksum differs from the manifest, so that it loads no file other than the one that the checkpoint wrote.

The order of `files` numbers every vector of the field. The vectors of the first file take the numbers from 0 upwards in position order, and each later file continues from the number where the file before it ends. A dead vector keeps its number.

Vector `i` of a file is dead when bit `i mod 8` of byte `floor(i / 8)` of `dead` is 1, where bit 0 is the least significant. A `dead` that is present must hold `ceiling(count / 8)` bytes. A reader must reject with `PERSISTENCE_LOAD_FAILED` a `dead` of any other length, a `count` above 65,536, and a `count` that differs from the length of the file's `docIds`.

### Writing a Checkpoint

1. For each partition, read the log records between the previous checkpoint's `lastSeqNo` and the new one, and write their effect as one or more segments under the next segment ids, which the manifest must list after the partition's earlier segments. Between them, those segments must hold each document that the records inserted or updated, in exactly one segment, and a tombstone for each document that the records removed. A writer must start another segment before a segment's file would pass the [file size](envelope.md#file-size) limit. Write no segment for a partition with no changes. A writer may instead take a changed partition's whole content from the partition that it searches through, and write it as one or more segments under the next segment ids, split by the same rule. The manifest must then list those segments as the partition's only segments. The writer must take the content while it applies no mutation to the partition, so that the segments hold the effect of every record up to `lastSeqNo` and of no later record.
2. When any partition changed, write every vector of each field that no vector file of the previous manifest holds into new vector files of at most 65,536 vectors each, under the field's next file ids. A checkpoint with no changes must keep the previous vector files and graph parts. A vector file is the only place where a checkpoint stores a vector value, so the document segment of step 1 must hold none.
3. Mark as dead, in the new manifest, every listed vector whose document the field no longer holds with that value. That covers a removed document, a replaced vector, and a document that a log record stores with no value for the field, because the record replaces the document that the earlier vector came from.
4. A writer may replace a listed vector file by writing its live vectors into new vector files, and the new manifest must then omit the replaced file. The new files must also hold each dead vector of the replaced file that the graph parts of step 5 hold a node for, which the new manifest must mark dead. A writer should replace a file whose share of dead vectors without a node in those graph parts exceeds 0.2. A writer that recalibrates a field must replace every vector file of the field, so that every listed file holds its codes under one centroid.
5. When a field holds a graph, write the graph whole as the graph parts of the field's next graph generation. The parts must number their vectors by the new manifest's `files`, and they must hold a node for a dead vector only where the field's graph holds that vector as a tombstone.
6. A writer may take a field's vectors, graph, and codes from the vector index that it searches through. The vector files and the graph parts may then hold the effect of a log record above a partition's `lastSeqNo`, provided that the record is durable before step 8, because recovery replays that record over them.
7. When a partition's segment count exceeds the compaction threshold, 12 by default, merge adjacent segments of its list into one segment under the next segment id, so that the count returns to the threshold. The manifest must list the merged segment in the place of the segments that it replaces. A writer must merge fewer segments, or none, where the merged segment's file would pass the [file size](envelope.md#file-size) limit, and it may merge fewer for any other reason, such as to bound the memory that it uses during the merge.
8. Write the manifest over `<indexName>/manifest` with an [atomic write](#atomic-write). The manifest write is the commit point, so a crash before it leaves the previous manifest in force and the new files unreferenced.
9. Once the manifest is durable, delete every key that the previous manifest references and the new one does not.

### Structural-Merge Recovery

Recovery must load a partition by reading the segments that the manifest lists for it, in the order of that list, and merging them, so that the occurrence of a document in the segment nearest the end of the list wins and a tombstone removes the document from every segment before it in the list. Recovery must load each segment's keyword index and field indexes from the arrays that the segment stores, with no new analysis of its documents. Recovery must load each vector field once, from the live vectors of the vector files that the manifest lists for it and from the graph parts that the manifest lists for it. For each dead vector that the graph parts hold a node for, recovery must load the vector and keep its node as a tombstone. Recovery must treat a live vector that the graph parts hold no node for as a vector inserted after promotion; see [Post-Promotion Insertion](vector-index.md#post-promotion-insertion).

Recovery must delete every key under `<indexName>/segments/` that the manifest does not reference, because a checkpoint that crashes before its manifest write leaves such keys behind.

---

## Index Metadata

On index creation, on any change that affects the schema, and on a change of the [BM25 setting](algorithms.md#parameter-levels), a node persists the index metadata at `<indexName>/meta` using the metadata payload from [envelope.md](envelope.md#index-metadata-payload). That metadata lets recovery rebuild an index with its full configuration, with no call from the application.

After it makes a checkpoint durable, the node must persist the checkpoint's total document count in `document_count` before it completes the checkpoint.

When the metadata carries an `embedding` block, recovery restores the field mappings and rebinds the embedding adapter by its registered name. Rebinding validates the adapter's dimensions against every mapped vector field before the index uses it.

When the metadata names a tokeniser or a stop word set, recovery resolves each name against the engine's analysis registry before it creates the index. A name nothing is registered under raises `CONFIG_INVALID` and stops that index recovering, because an index whose analysis cannot be restored would answer every query against terms it never stored. An operator restores such an index by registering the missing name and starting the node again.

When no adapter of that name is registered at recovery time, the index still recovers in full: every document, term, and stored vector is available and keyword queries work. The operations that need the adapter, such as embedding a text query or embedding an inserted document that arrives without its vectors, fail with `EMBEDDING_CONFIG_INVALID` and name the missing adapter until it is registered. Registering the adapter later rebinds every recovered index that references it, with no data rebuilt and no document embedded a second time, because the write-ahead log and the snapshots store documents with their vectors already computed.

A checkpoint manifest must record in `analysisGeneration` the generation that produced its terms, and an absent value means 0. A writer must persist `pending_analysis` before it starts to build, and every metadata write must keep that member until a checkpoint of that generation is durable, because a crash can leave a committed manifest whose metadata has yet to change. The writer then persists the new settings and `analysis_generation` and leaves `pending_analysis` out.

Recovery must read the generation of the saved terms from the manifest, or from the [index configuration payload](envelope.md) of a tier that saves a snapshot with no manifest, before it creates the index. Where that generation equals the pending generation, recovery must take the pending settings as current and finish the metadata write. Where it equals `analysis_generation`, recovery must open the index under the current settings and start the pending change again, whatever `analysis.rebuild` holds, because a caller asked for that change. A generation that equals neither must raise `CONFIG_INVALID` and stop that index recovering, because the terms match no settings that the metadata records.

The rule above that a name with no registration stops an index recovering applies to the current settings alone. A name in `pending_analysis` with no registration must leave the index answering under its current settings, must report the failed rebuild, and must leave `pending_analysis` in place so that the next start tries again.

---

## Checkpoint and Truncation

An interval, a mutation count since the last checkpoint, or both together trigger a checkpoint:

1. Capture each partition's current head sequence number, `N_p`.
2. Write the [segmented checkpoint](#segmented-checkpoint), with the manifest's `checkpoint` list carrying `lastSeqNo = N_p` for each partition.
3. Persist the checkpoint's total document count in `document_count`.
4. Once the manifest and metadata are fully durable, delete for each partition every log segment whose highest `seqNo` is at or below `N_p`. Keep the segment containing `N_p`, because it also holds records above `N_p`, and keep every newer segment. Never delete the segment the partition's commit marker names active, even when all of its current records are at or below `N_p`, because new writes will extend it.

The ordering rule is absolute: the checkpoint must be fully durable before any log segment it covers is deleted, and that order is never reversed. A crash before step 4 leaves extra log segments, which recovery skips by sequence number with no harm done.

The commit marker always references the active segment, which a checkpoint never deletes, so truncation leaves the marker alone.

---

## Recovery

With persistence configured and no lifecycle settings, a node must recover on startup before it serves any request:

0. Finish every restore that a crash interrupted, as [Replacing an Index by Restore](#replacing-an-index-by-restore) defines.
1. Enumerate the persisted indexes from their `<indexName>/meta` keys.
2. For each index:
   1. Load `<indexName>/meta`, rebuild the schema, language, partition count, and vector fields, and create the index empty.
   2. Load `<indexName>/manifest` and verify the envelope CRC. When no manifest exists, every partition starts empty with `lastSeqNo` at 0.
   3. Load the partitions and vector indexes by [structural merge](#structural-merge-recovery) from the manifest, and read each partition's `lastSeqNo`.
   4. For each partition, read its log as described in [Reading a Segment](#reading-a-segment) and replay every record whose `seqNo` is above `lastSeqNo`.
3. After replay the index serves reads and writes, and each partition continues from the highest replayed `seqNo` plus one.

With lifecycle settings configured, a node must load each persisted index's metadata on startup, register the index closed, and defer snapshot and log recovery until the first operation names the index; it must finish recovery before the operation accesses index data.

Corruption is handled by kind:

- A checkpoint envelope CRC mismatch, in the manifest or in any file that it lists, is fatal for that index; raise `PERSISTENCE_CRC_MISMATCH`.
- Corruption in the middle of the log is fatal; raise `PERSISTENCE_WAL_CORRUPT`.
- A truncated active-segment tail is normal; truncate it and carry on.

---

## Earlier Layouts

Each release of the engine must open an index that the release before it saved, and it must rewrite that index in the current layout. Before 1.0, the earlier layout is the one that the [specification of engine 0.3.0](https://github.com/assetcorp/narsil/tree/narsil-ts@v0.3.0/packages/spec) defines: a version 6 manifest whose segment files hold version 2 partition payloads and whose vector fields each have one graph file, or a snapshot bundle under `<indexName>/snapshot`. A reader must reject any older layout with `ENVELOPE_VERSION_MISMATCH`, and the error must name [document export](#document-export) as the way to carry an index across more than one release.

A node must upgrade an index in the earlier layout as part of recovering it, before it serves the index, in four steps:

1. Load the index as the earlier release loads it, reading one earlier file at a time, and replay the log records above the checkpoint that the earlier layout records.
2. Write every file of a full checkpoint in the current layout, under keys that the earlier layout leaves unused. The vector files of the earlier layout keep their format, so the new manifest may list them as they stand, with their lengths and checksums.
3. Commit the upgrade by writing the current manifest over `<indexName>/manifest` with an [atomic write](#atomic-write), or by saving it through the adapter on the snapshot-only tier.
4. Delete every key that only the earlier layout lists, `<indexName>/snapshot` included.

The earlier layout stays whole until step 3, so a crash before that step leaves the index as the earlier release saved it. The next recovery then deletes the files that the crash left unlisted and starts the upgrade again. Where a current manifest and `<indexName>/snapshot` both exist, a crash interrupted step 4, so recovery must load the manifest and delete the bundle. A node holds the index in memory during the upgrade, as it does during any recovery, so the memory that the upgrade needs beyond the index itself is one earlier file that it reads and one new file that it writes at a time.

The upgrade keeps every document and every vector field of the index, including a document or a vector field above the limits that [Documents](envelope.md#documents) and [Field Types](envelope.md#field-types) set for new writes. The restore operation must accept the index snapshot that the earlier release's snapshot operation returned, and it must insert that snapshot's documents and vectors as new writes. Every node of a cluster must run the same release, because a node sends and accepts snapshot transfers in the current layout alone.

---

## Write Path

A mutation becomes durable before it is acknowledged, and a log record is written only for a mutation that has already applied in memory, so replay can never resurrect a write that failed or poison recovery.

For each mutation while the log is active:

1. Validate the document against the schema.
2. Apply the mutation to the in-memory partition, including any vector index work. When that fails, no log record is written and the caller receives the error.
3. Build the log entry. An `INDEX` entry carries the full transformed document as MessagePack bytes, computed embeddings included. A `DELETE` entry carries the `documentId` with `document` absent. Assign the partition's next `seqNo`. On a single node `primaryTerm` stays constant.
4. Append the framed record to the partition's active log segment, make it durable according to the [durability mode](#durability-modes), and update the [commit marker](#commit-marker).
5. Acknowledge the write.

A node serialises a partition's apply, sequence-number assignment, and append, so the in-memory apply order matches the log order and sequence numbers reach the disk strictly increasing. A failed durable append leaves the write unacknowledged, and an fsync error is fatal. A crash between step 2 and a durable step 4 loses the write, and that loss is correct because the write was never acknowledged.

---

## Snapshot-Only Persistence

A persistence adapter that is not filesystem-backed, such as an in-memory store, IndexedDB, an object store, or a key-value service, cannot run the write-ahead log, because a `save(key, bytes)` interface expresses neither append nor fsync. Such a backend persists checkpoints alone.

- On the same interval and mutation-count triggers that a checkpoint uses, the node writes a [segmented checkpoint](#segmented-checkpoint) through the adapter's `save`, one key for each file. The node writes no log, so it builds each segment from the whole content of a changed partition, as step 1 of [Writing a Checkpoint](#writing-a-checkpoint) allows.
- The node must save every file of a checkpoint before it saves the manifest, so that saving the manifest commits the checkpoint. It must delete the keys that only the previous manifest lists once that save returns. A filesystem-backed adapter must save the manifest with an [atomic write](#atomic-write).
- Recovery loads the manifest and the files that it lists through the adapter's `load` and replays no log. It must delete every key under `<indexName>/segments/` that the manifest does not list, which it finds through the adapter's `list`.

The guarantee is that the index is durable up to the last checkpoint, and a crash loses every write made since. A node must publish that weaker guarantee and must never imply the write-ahead log guarantee for a snapshot-only backend.

Configuring write-ahead log durability, by setting `durability.directory`, against a non-filesystem backend is a configuration error and raises `CONFIG_INVALID`.

---

## Snapshot Archive

A snapshot archive holds one checkpoint of an index, or of one partition of an index, as a single stream of bytes. The engine's snapshot operation returns the archive of an index, which its restore operation reads to create an index. A primary sends the archive of one partition to a replica during a [full snapshot](distribution/replication.md#tier-2-full-snapshot) sync.

An archive must use the pax interchange format that POSIX.1-2008 defines for the `pax` utility, with its entries in this order:

1. An entry named `config`, holding an [index configuration payload](envelope.md#index-configuration-payload).
2. An entry named `manifest`, holding the checkpoint's [manifest](#manifest).
3. One entry for each file that the manifest lists, in the order that the manifest lists them, named by the file's key without its leading `<indexName>/`.

A writer must write each entry as a regular file. Where the ustar `name` and `prefix` fields cannot hold an entry's name, the writer must precede the entry with a pax extended header that holds a `path` record. A reader must accept those two entry types alone. It must raise `PERSISTENCE_LOAD_FAILED` for any other entry type, for an entry out of the order above, for a later entry whose name the manifest does not list or that appears twice, for an entry whose length or checksum differs from the manifest, and for an archive that ends before it holds every file that the manifest lists. It must compare each entry's length with the manifest, or with the [file size](envelope.md#file-size) limit for `config` and `manifest`, before it reads the entry, so that no entry can make it allocate more than that limit.

A node with write-ahead log durability must take a checkpoint before it writes the archive of an index, and the archive must hold that checkpoint. The node must keep every file of that checkpoint until it finishes writing the archive or the caller abandons the archive, even after a later checkpoint stops listing those files. A node without write-ahead log durability, and a node that writes the archive of one partition, must build the archive's files from the index in memory while it applies no mutation to the content that the archive holds.

The archive of one partition must hold a manifest that lists that partition alone and no graph part, and vector files that hold the vectors of that partition's documents alone. Where a cluster partition copy writes the archive for a sync, the manifest must carry the copy's `termHistory`, and the segments must carry each document's write record, so that the replica that applies the archive can decide a [retry after an ended term](distribution/replication.md#retry-after-an-ended-term) once it becomes the primary.

A node that restores an archive into durable storage must write every other file before it writes the manifest, so that a crash during the restore leaves no manifest that lists a missing file. It must number the first write to each partition after the restore one above the `lastSeqNo` that the manifest records for that partition, because recovery replays only the log records above that number. Every node that restores an archive must decode every document before it serves the index, as the [keyword segment payload](envelope.md#keyword-segment-payload) requires. A replica that applies the archive of a partition must replace its copy of that partition with the archive's segments, must remove from each vector field the vectors of the documents that its copy held, and must insert every vector that the archive holds.

### Replacing an Index by Restore

A restore that names an existing index must leave that index serving every request until the restored index is complete, so that no request finds the index missing or partly loaded. A node therefore builds the restored index apart from the live one, checks every file and decodes every document, and only then replaces the live index. A restore that fails before the replacement leaves the live index as it was. Because the node holds the live index and the restored one at the same time, it must refuse a restore with `RESTORE_MEMORY_EXCEEDED` before it stages any file when its estimate of the memory that the restored index needs, added to the memory in use, would pass the node's heap limit or its process limit.

A node with durable storage writes the restored checkpoint under a staging prefix. A staging prefix is a top-level key prefix made of `.`, then a letter or a digit, then any number of letters, digits, `.`, `_`, and `-`, then `/`, and it never holds `..`. Index names begin with a letter or a digit, so recovery never takes a staging prefix for an index. A staging prefix must stay short whatever the index name, because a file system can limit one file name to 255 bytes while an index name can be that long, so a node must not build a staging prefix from the index name.

Once every staged file is durable, the node commits the replacement by writing a journal under the key `.swap-<digest>` with an [atomic write](#atomic-write), or by saving that key through the adapter on the snapshot-only tier. The digest is the SHA-256 of the index name's UTF-8 bytes, written as 64 lowercase hexadecimal digits, so the journal key stays short and each index has one. The journal holds two lines of UTF-8 text, the index name and then the staging prefix, and nothing else. It skips step 1 of the atomic write, because recovery checks every byte that it reads from the journal. A crash during that write can leave a temporary key that also begins with `.swap-`. On startup, a node must delete every key that begins with `.swap-` and whose remainder is not the digest of that key's own first line, and it must move nothing for that key.

The keys of the restored checkpoint, each relative to `<indexName>/`, are `meta`, `manifest`, and every file that the restored manifest lists. A node reads that manifest under the staging prefix while it is still there, and under `<indexName>/` once it has moved. The node then finishes the journal in three steps:

1. Move each key of the restored checkpoint that is still under the staging prefix to the same key under `<indexName>/`.
2. Remove every key under `<indexName>/` that is not a key of the restored checkpoint.
3. Delete the journal.

The node must delete the journal before the restored index writes any key under `<indexName>/`, such as a log record or a checkpoint file, because step 2 would remove that key if the steps ran again. Those steps leave the same keys however many times they run, whether the node moves directories, moves files one at a time, or saves each key under its new name and then deletes the staged key. On startup, before it enumerates the indexes, a node must finish every journal that it finds. It must then delete every staging prefix that no journal names, and it must leave `.narsil.lock`, which [Directory Ownership](#directory-ownership) defines, in place. A crash before the journal exists therefore leaves the old index, and a crash after the journal exists leaves the restored index, whole.

---

## Document Export

A document export holds the configuration and the documents of one index as JSON Lines, a text format that no release of the engine changes, so that an index can move across any number of releases, between implementations, or into a new schema. The engine's export operation writes it as a stream, and its import operation reads it.

Every line must hold one JSON object in UTF-8, ended by a line feed. The first line must be the header, and every later line must hold one document:

```text
{ "format": "narsil-export", "version": 1, "index": IndexConfiguration }
```

`index` holds the keys of the [index configuration payload](envelope.md#index-configuration-payload) as JSON. A document line holds the document as the engine stores it, with its ID under `id`, the value of each vector field as an array of numbers, and a tag in place of each value that JSON has no type for. A writer must write each number so that parsing it returns the same float64 value, negative zero included. A writer must take every document from one moment of the index, and a node with write-ahead log durability must take them from one checkpoint, whose files it must keep until the export ends, as a [snapshot archive](#snapshot-archive) does.

JSON has no type for a timestamp, for binary data, or for a NaN or infinite float, so a writer must write each such value as a tag. A tag is an object whose only key is one of the four names in this table:

| Stored value | Tag |
| --- | --- |
| A MessagePack timestamp | `{ "$date": [seconds, nanoseconds] }`, the two integers of the timestamp |
| A MessagePack binary value | `{ "$bytes": text }`, where `text` spells the bytes in the padded base64 alphabet of RFC 4648 |
| A float that is NaN, positive infinity, or negative infinity | `{ "$number": "NaN" }`, `{ "$number": "Infinity" }`, or `{ "$number": "-Infinity" }` |
| A map whose only key begins with `$` | `{ "$object": map }` |

A writer must wrap a stored map whose only key begins with `$` in an `$object` tag, because a reader treats every other object of that shape as a tag. It must raise `DOC_VALIDATION_FAILED` for a timestamp whose seconds lie outside -9,007,199,254,740,991 to 9,007,199,254,740,991, because that range is the widest in which float64 represents every integer exactly. It must raise the same error for a document that holds any other MessagePack extension type.

In a document line, a reader must treat every object whose only key begins with `$` as a tag. It must keep the keys of the map inside `$object` as they are, although it must convert the tags in that map's values. It must refuse with `DOC_VALIDATION_FAILED` a line that holds an object whose only key begins with `$` and names none of the four tags, a `$date` whose value is anything other than two integers with seconds in the range above and nanoseconds from 0 to 999,999,999, a `$bytes` text that differs from the padded base64 of the bytes that it decodes to, a `$number` text other than the three in the table, or an `$object` whose value is anything other than an object. A reader may refuse a `$date` that lies outside the range of its language's date type.

A reader must reject with `CONFIG_INVALID` an export whose first line is not a header of version 1. It must accept a line of up to 117,443,592 bytes, which is seven times the 16,777,216 bytes of the longest document that [Documents](envelope.md#documents) allows, plus 3,080 bytes for the document's ID. The factor of seven comes from an empty `$bytes` tag in a list, which spells two MessagePack bytes in 14 characters. The 3,080 bytes cover an ID of 512 UTF-16 code units that each take six characters as a JSON escape such as `\u0001`, together with the eight characters of `"id":"",`. A header fits inside the same length, because [Index Configuration Payload](envelope.md#index-configuration-payload) caps the configuration at 16,777,216 bytes, while the rest of the header takes 47 characters. The import operation must create the index from the header, or use an existing index whose schema matches the header where the caller names one. It must insert the documents in batches, so that it holds one batch in memory at a time. It must replace a document whose ID the index already holds, so that running an interrupted import again leaves the index equal to the export. After it refuses a line, it must go on with the next line. It must count every line that it refuses, and it must report the number and error code of the 1,000 refused lines with the lowest numbers, so that the report stays the same size however many lines a file holds.

---

## Platform Notes

- POSIX rename is atomic for concurrent readers, but atomicity is not durability. Durability needs the temporary-file fsync and the directory fsync from the [atomic write](#atomic-write).
- On Linux, fsync flushes to the storage device. On macOS, the runtime's fsync tries `F_FULLFSYNC`, a true flush to permanent storage, and falls back to a plain fsync only on volumes that lack support for it, such as some network and external disks. A node therefore gets process-crash durability on every platform, power-loss durability on Linux and on typical local macOS disks, and process-crash-only durability on the macOS volumes where `F_FULLFSYNC` is unavailable. No native extension is required.
- On Windows, renaming over an existing file is not guaranteed atomic and a directory fsync does nothing, so durability on Windows is best-effort.

---

## Error Codes

A node must reject an operation with `INDEX_REOPEN_CAPACITY_EXHAUSTED` when it names a closed index that already has the configured number of operations waiting for it to reopen.

| Code | Raised when |
|------|-------------|
| `INDEX_REOPEN_CAPACITY_EXHAUSTED` | An operation names a closed index that already has the configured number of operations waiting for it to reopen. |
| `PERSISTENCE_CRC_MISMATCH` | A snapshot envelope checksum does not match its payload. |
| `PERSISTENCE_WAL_CORRUPT` | A record inside a segment's durable region overruns the region, fails its checksum, fails to decode, breaks sequence-number order, or leaves the highest seqNo read short of the commit marker. |
| `PERSISTENCE_FSYNC_FAILED` | An fsync returns an error. The node acknowledges no write that the fsync covers, and the error is fatal. |
| `PERSISTENCE_LOAD_FAILED` | The node cannot read or decode a snapshot or log file. |
| `PERSISTENCE_SAVE_FAILED` | The node cannot write a snapshot or log file, or the durability directory is missing or replaced; see [Directory Ownership](#directory-ownership). |
| `CONFIG_INVALID` | A configuration asks for write-ahead log durability on a non-filesystem backend, for durability without a directory, or for the snapshot tier without a persistence adapter, or another running process holds the write-ahead log directory. |
| `RESTORE_MEMORY_EXCEEDED` | A restore needs more memory than the node has free, as [Replacing an Index by Restore](#replacing-an-index-by-restore) defines. The node refuses it before it stages any file, and the existing index keeps serving. |
