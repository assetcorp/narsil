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

- The **snapshot**, or checkpoint, is the full index state at a point in time, written atomically as a `.nrsl` envelope; see [envelope.md](envelope.md). It is taken periodically.
- The **write-ahead log** is an append-only, per-partition log of mutations. A mutation reaches the log durably before the write is acknowledged.

Recovery loads the latest snapshot and then replays the log records whose sequence number exceeds the snapshot's recorded checkpoint position. This tier needs a real filesystem, because it relies on append, fsync, and atomic rename. Its guarantee is that no acknowledged write is lost; see [Durability Modes](#durability-modes).

### Tier 2: Snapshot-Only Persistence, Any Backend

A persistence adapter that is not filesystem-backed cannot run a write-ahead log, because a key-to-bytes interface expresses neither append nor fsync. Such a backend persists periodic snapshots alone. Recovery restores the last snapshot and has no log to replay, so the guarantee is that the index is durable up to that snapshot and a crash loses every write made since. See [Snapshot-Only Persistence](#snapshot-only-persistence).

### Tier Selection

An implementation selects the tier from the backend: a filesystem-backed adapter runs Tier 1, and any other adapter runs Tier 2. The optional `durability.tier` field, `wal` or `snapshot`, overrides that selection. `tier: "snapshot"` forces snapshot-only persistence onto any adapter, a filesystem-backed one included; a deployment chooses this when several processes share one directory, because the write-ahead log requires exclusive ownership of its directory. `tier: "snapshot"` without a persistence adapter raises `CONFIG_INVALID`, and `tier: "wal"` where no directory can be resolved raises `CONFIG_INVALID`.

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

## Write-Ahead Log On-Disk Format

### Segment Files

The log for one partition is a sequence of append-only segment files.

- Each `(indexName, partitionId)` pair has one log.
- The key is `<indexName>/wal/<partitionId>/<startSeqNo>`, where `startSeqNo` is the sequence number of the segment's first record, written as 16 digits with leading zeros so that segments sort lexically in sequence order.
- A segment is append-only and is never modified in place. Reclaiming one means deleting the whole file; see [Checkpoint and Truncation](#checkpoint-and-truncation).
- A new segment opens when the active segment grows past `segment_max_bytes`, 67108864 by default, which is 64 MB, or when a checkpoint runs.

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

The marker always names the current active segment. Rolling to a new segment advances the marker to it as part of the roll, so the marker never names a sealed segment and a checkpoint never deletes the segment the marker names active; see [Checkpoint and Truncation](#checkpoint-and-truncation). In sync mode this flush runs on every group commit. In async mode it runs only on the `flush_interval_ms` timer, so the marker lags the appended records by up to one interval and those records recover as described next.

### Reading a Segment

Recovery uses the commit marker to find each segment's durable region and then reads the records inside it.

1. Read the partition's commit marker and take the slot with the highest `write_seq` whose `marker_crc32` is valid. When neither slot is valid, or the marker is absent, the partition has no acknowledged log records beyond the snapshot and recovery replays nothing from the log.
2. Delete every segment whose `startSeqNo` is greater than `active_segment_seq_no`. Such a segment holds only unacknowledged records from a roll a crash interrupted.
3. A segment whose `startSeqNo` is below `active_segment_seq_no` was sealed before the active segment opened, so it is durable in full. Read every record in it.
4. In the active segment, the first `durable_byte_length` bytes are the fsynced frontier. Read the records inside the frontier by byte offset, never by trusting a record's own length to find where the frontier ends.
5. Inside the frontier every record must be complete and valid. A `record_length` that overruns the frontier, a `frame_crc32` mismatch, a payload that fails to decode, a failed entry checksum, or a `seqNo` out of order is corruption of acknowledged, fsynced data. Recovery refuses to start and raises `PERSISTENCE_WAL_CORRUPT`.
6. Once every segment has been read up to the frontier, the highest `seqNo` read must equal `highest_durable_seq_no`. A lower value means a durable record is missing, which is corruption; refuse and raise `PERSISTENCE_WAL_CORRUPT`.
7. Past `durable_byte_length` in the active segment lie records appended but not yet fsynced, which exist only in async mode. Recovery parses them one at a time and replays each record that is complete, valid, and carries a `seqNo` above `highest_durable_seq_no`. It stops at the first record that is incomplete or fails its checksum, treats that as the torn tail, truncates the segment to the end of the last good record, and fsyncs it.

Recovery reads the fsynced frontier deterministically and treats any failure inside it as fatal, so acknowledged, fsynced data is never dropped without a word. Only the async tail beyond the frontier is parsed on a best-effort basis, and that is exactly the window the async guarantee already allows to be lost: a clean async crash keeps the tail the operating system flushed, and a power cut keeps the records up to the first torn frame.

---

## Snapshot Checkpoint Format

A snapshot is a full-index checkpoint held in a single `.nrsl` envelope. The snapshot-only tier writes it on every persist. The write-ahead log tier writes the [segmented checkpoint](#segmented-checkpoint) instead, and reads this bundle only as a fallback for data written before segmented checkpoints existed.

The container is the `.nrsl` envelope from [envelope.md](envelope.md) with the checksum flag set; the CRC32 payload checksum is mandatory for a snapshot. The payload is the snapshot bundle, a MessagePack map. The envelope's `envelope_format_version` is 2, and the bundle's own `version` field is 1. The two are separate numbers, and a reader rejects a bundle whose `version` is anything other than 1.

```text
SnapshotBundle {
  version:        uint8         (1)
  schema:         Map<string, string>
  language:       string
  tokenizer:      string        (optional; the registered tokeniser name)
  stop_words:     string        (optional; the registered stop word set name)
  stop_word_list: List<string>  (optional; the words of a literal stop word set)
  partitions:     List<bytes>   (version 2 partition payloads)
  vectorIndexes:  Map<string, VectorIndexPayload>
  checkpoint:     List<PartitionCheckpoint>
}

PartitionCheckpoint {
  partitionId: uint32
  lastSeqNo:   uint64   (the highest seqNo this snapshot contains)
  primaryTerm: uint64
}
```

`checkpoint` records, per partition, the highest `seqNo` the snapshot already holds, and recovery replays each partition's log from `lastSeqNo + 1`. The field is additive: a reader that does not find it treats every partition's `lastSeqNo` as 0 and replays the whole log.

`tokenizer`, `stop_words`, and `stop_word_list` are additive as well. They carry the analysis from [Index Metadata](#index-metadata), so a reader recreates the index with the analysis the snapshot was taken with, and a name nothing is registered under raises `CONFIG_INVALID`.

### Atomic Snapshot Write

A snapshot must replace its predecessor atomically and durably:

1. Serialise the bundle and wrap it in the `.nrsl` envelope with its CRC.
2. Write the bytes to a temporary file in the same directory as the destination.
3. fsync the temporary file.
4. Rename the temporary file over `<indexName>/snapshot`.
5. fsync the containing directory.

A crash before step 4 leaves the previous snapshot intact and the temporary file is discarded during recovery. A crash after step 4 but before log truncation leaves the new snapshot alongside the full log, and recovery still reaches the correct state because replay filters by sequence number. Every fsync error is fatal, as described in [Durability Modes](#durability-modes).

---

## Segmented Checkpoint

The write-ahead log tier checkpoints incrementally, so the cost of a checkpoint scales with what changed since the last one rather than with the size of the index.

### Layout

A segmented checkpoint is a manifest plus per-partition segment files, stored under the keys in [Storage Path Convention](envelope.md#storage-path-convention). Segment ids count up from zero within a partition and are zero-padded to 16 digits, so segment keys sort in creation order, and a partition holds at most 65536 segments.

A segment file is a `.nrsl` envelope with the checksum flag set and `envelope_format_version` 2, and its payload is a MessagePack map:

```text
SegmentFile {
  payload:    bytes         (a version 2 partition payload holding the segment's documents)
  tombstones: List<string>  (document IDs this segment removes from older segments)
}
```

A vector segment file is the same envelope carrying a [vector index payload](envelope.md#vector-index-payload).

### Manifest

The manifest commits a checkpoint. It is a `.nrsl` envelope with the same flags, and its payload is a MessagePack map. A reader rejects a manifest whose `version` is anything other than 3.

```text
SegmentManifest {
  version:    uint8   (3)
  schema:     Map<string, string>
  language:   string
  checkpoint: List<PartitionCheckpoint>
  partitions: List<PartitionManifestEntry>
}

PartitionManifestEntry {
  partitionId:   uint32
  nextSegmentId: uint64
  segments:      List<SegmentRef>
  vectors:       List<VectorSegmentRef>
}

SegmentRef {
  id:             uint64
  key:            string
  docCount:       uint32
  tombstoneCount: uint32
}

VectorSegmentRef {
  fieldPath:  string
  generation: uint64
  key:        string
}
```

`checkpoint` carries the same list as the snapshot bundle, and recovery replays each partition's log from its `lastSeqNo + 1`.

### Writing a Checkpoint

1. For each partition, read the log records between the previous checkpoint's `lastSeqNo` and the new one, build one segment holding the documents those records inserted or updated and a tombstone for each document they removed, and write it under the next segment id. A partition with no changes writes no segment.
2. When a partition changed, rewrite each of its vector fields as a new vector segment at the next generation. A partition with no changes keeps its previous vector segments.
3. When a partition's segment count exceeds the compaction threshold, 12 by default, merge its oldest segments into one so the count returns to the threshold.
4. Write the manifest atomically over `<indexName>/manifest` with the same atomic write as the snapshot bundle. The manifest write is the commit point: a crash before it leaves the previous manifest in force and the new files unreferenced.
5. Once the manifest is durable, delete every key the previous manifest referenced that the new one does not, and delete the legacy `<indexName>/snapshot` bundle.

### Structural-Merge Recovery

Recovery loads a partition by reading its manifest-listed segments in id order and merging them: the newest occurrence of a document wins, and a tombstone removes the document from every older segment. Each vector field loads from its listed vector segment.

Keys under `<indexName>/segments/` that the manifest does not reference are deleted during recovery, because a checkpoint that crashed before its manifest write leaves them behind.

---

## Index Metadata

On index creation, and on any change that affects the schema, a node persists the index metadata at `<indexName>/meta` using the metadata payload from [envelope.md](envelope.md#index-metadata-payload). That metadata lets recovery rebuild an index with its full configuration, with no call from the application.

When the metadata carries an `embedding` block, recovery restores the field mappings and rebinds the embedding adapter by its registered name. Rebinding validates the adapter's dimensions against every mapped vector field before the index uses it.

When the metadata names a tokeniser or a stop word set, recovery resolves each name against the engine's analysis registry before it creates the index. A name nothing is registered under raises `CONFIG_INVALID` and stops that index recovering, because an index whose analysis cannot be restored would answer every query against terms it never stored. An operator restores such an index by registering the missing name and starting the node again.

When no adapter of that name is registered at recovery time, the index still recovers in full: every document, term, and stored vector is available and keyword queries work. The operations that need the adapter, such as embedding a text query or embedding an inserted document that arrives without its vectors, fail with `EMBEDDING_CONFIG_INVALID` and name the missing adapter until it is registered. Registering the adapter later rebinds every recovered index that references it, with no data rebuilt and no document embedded a second time, because the write-ahead log and the snapshots store documents with their vectors already computed.

---

## Checkpoint and Truncation

An interval, a mutation count since the last checkpoint, or both together trigger a checkpoint:

1. Capture each partition's current head sequence number, `N_p`.
2. Write the [segmented checkpoint](#segmented-checkpoint), with the manifest's `checkpoint` list carrying `lastSeqNo = N_p` for each partition.
3. Once the manifest is fully durable, meaning the directory fsync of its atomic write has returned, delete for each partition every log segment whose highest `seqNo` is at or below `N_p`. Keep the segment containing `N_p`, because it also holds records above `N_p`, and keep every newer segment. Never delete the segment the partition's commit marker names active, even when all of its current records are at or below `N_p`, because new writes will extend it.

The ordering rule is absolute: the checkpoint must be fully durable before any log segment it covers is deleted, and that order is never reversed. A crash between steps 2 and 3 leaves extra log segments, which recovery skips by sequence number with no harm done.

The commit marker always references the active segment, which a checkpoint never deletes, so truncation leaves the marker alone.

---

## Recovery

With persistence configured, a node recovers on startup before it serves any request:

1. Enumerate the persisted indexes from their `<indexName>/meta` keys.
2. For each index:
   1. Load `<indexName>/meta`, rebuild the schema, language, partition count, and vector fields, and create the index empty.
   2. Load `<indexName>/manifest` and verify the envelope CRC. When no manifest exists, fall back to `<indexName>/snapshot`; with neither present, every partition starts empty with `lastSeqNo` at 0.
   3. Load the partitions and vector indexes, by [structural merge](#structural-merge-recovery) from a manifest or by decoding the bundle from a legacy snapshot, and read each partition's `lastSeqNo`.
   4. For each partition, read its log as described in [Reading a Segment](#reading-a-segment) and replay every record whose `seqNo` is above `lastSeqNo`.
3. After replay the index serves reads and writes, and each partition continues from the highest replayed `seqNo` plus one.

Corruption is handled by kind:

- A checkpoint envelope CRC mismatch, in the manifest, a segment, or a snapshot bundle, is fatal for that index; raise `PERSISTENCE_CRC_MISMATCH`.
- Corruption in the middle of the log is fatal; raise `PERSISTENCE_WAL_CORRUPT`.
- A truncated active-segment tail is normal; truncate it and carry on.

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

A persistence adapter that is not filesystem-backed, such as an in-memory store, IndexedDB, an object store, or a key-value service, cannot run the write-ahead log, because a `save(key, bytes)` interface expresses neither append nor fsync. Such a backend persists snapshots alone.

- On the same interval and mutation-count triggers a checkpoint uses, the node writes the index snapshot, the same `.nrsl` envelope as [Tier 1](#tier-1-write-ahead-log-durability-filesystem-only), through the adapter's `save` under the key `<indexName>/snapshot`. No log is written.
- The snapshot write must be atomic at whatever granularity the backend offers. A single object-store PUT is atomic, and so is an IndexedDB transaction. A filesystem-backed adapter must use the temporary-file-then-rename sequence.
- Recovery loads the snapshot through the adapter's `load` and replays no log.

The guarantee is that the index is durable up to the last snapshot, and a crash loses every write made since. A node must publish that weaker guarantee and must never imply the write-ahead log guarantee for a snapshot-only backend.

Configuring write-ahead log durability, by setting `durability.directory`, against a non-filesystem backend is a configuration error and raises `CONFIG_INVALID`.

---

## Platform Notes

- POSIX rename is atomic for concurrent readers, but atomicity is not durability. Durability needs the temporary-file fsync and the directory fsync from the [atomic snapshot write](#atomic-snapshot-write).
- On Linux, fsync flushes to the storage device. On macOS, the runtime's fsync tries `F_FULLFSYNC`, a true flush to permanent storage, and falls back to a plain fsync only on volumes that lack support for it, such as some network and external disks. A node therefore gets process-crash durability on every platform, power-loss durability on Linux and on typical local macOS disks, and process-crash-only durability on the macOS volumes where `F_FULLFSYNC` is unavailable. No native extension is required.
- On Windows, renaming over an existing file is not guaranteed atomic and a directory fsync does nothing, so durability on Windows is best-effort.

---

## Error Codes

| Code | Raised when |
|------|-------------|
| `PERSISTENCE_CRC_MISMATCH` | A snapshot envelope checksum does not match its payload. |
| `PERSISTENCE_WAL_CORRUPT` | A record inside a segment's durable region overruns the region, fails its checksum, fails to decode, breaks sequence-number order, or leaves the highest seqNo read short of the commit marker. |
| `PERSISTENCE_FSYNC_FAILED` | An fsync returned an error. The write is not acknowledged, and the error is fatal. |
| `PERSISTENCE_LOAD_FAILED` | A snapshot or log file could not be read or decoded. |
| `PERSISTENCE_SAVE_FAILED` | A snapshot or log file could not be written. |
| `CONFIG_INVALID` | Write-ahead log durability was requested for a non-filesystem backend, durability was configured without a directory, or the snapshot tier was requested without a persistence adapter. |
