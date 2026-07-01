# Narsil Durability Specification

This document defines how a single Narsil node survives a crash and
restores its data on restart. Durability rests on two artefacts: a
periodic **snapshot** (the checkpoint) and a **write-ahead log**
(the WAL) of every mutation since that checkpoint. On restart, a node
loads the snapshot and replays the WAL records the snapshot does not
already contain. A filesystem deployment gets this full guarantee. A
non-filesystem persistence backend gets a weaker snapshot-only
guarantee, defined in [Snapshot-Only Persistence](#snapshot-only-persistence).

The WAL record is the same entry the replication protocol uses (see
[distribution/replication.md](distribution/replication.md)). There is
one log, not two: this document adds the on-disk framing, the
durability (fsync) rules, recovery, checkpointing, and truncation that
turn the in-memory replication log into a durable log. A node uses it
for crash recovery; a cluster rides the same log for replication.

Any conforming implementation (TypeScript, Rust, Python, Go) must read
and write these formats identically.

---

## Model

A Narsil node holds its index in memory. Persistence has two tiers, and
each publishes a different guarantee.

### Tier 1: WAL durability (filesystem)

The strong tier combines a periodic **snapshot** with a **write-ahead
log**.

- **Snapshot (checkpoint):** the full index state at a point in time,
  written atomically as a `.nrsl` envelope (see
  [envelope.md](envelope.md)). Taken periodically.
- **WAL:** an append-only, per-partition log of mutations. A mutation
  is made durable in the WAL before the write is acknowledged.

Recovery loads the latest snapshot, then replays the WAL records whose
sequence number is greater than the snapshot's recorded checkpoint
position. This tier requires a real filesystem, because it relies on
append, fsync, and atomic rename. Its guarantee is that no acknowledged
write is lost (see [Durability Modes](#durability-modes)).

### Tier 2: snapshot-only persistence (any backend)

A `PersistenceAdapter` that is not filesystem-backed cannot run a WAL,
because a key-to-bytes interface expresses neither append nor fsync.
These backends persist periodic snapshots only. Recovery restores the
last snapshot and there is no log to replay. The guarantee is that the
index is durable up to the last snapshot, so a crash loses every write
since that snapshot. See
[Snapshot-Only Persistence](#snapshot-only-persistence).

---

## Relationship to other specifications

- **Log entry format:** [replication.md](distribution/replication.md)
  defines `ReplicationLogEntry` (`seqNo`, `primaryTerm`, `operation`,
  `partitionId`, `indexName`, `documentId`, `document`, `checksum`).
  The WAL stores exactly this entry.
- **Snapshot container:** [envelope.md](envelope.md) defines the
  `.nrsl` 32-byte header, the CRC32 payload checksum, and the
  MessagePack payload.
- **Checksum:** CRC32 with the IEEE polynomial, as defined in
  [algorithms.md](algorithms.md#crc32). The same algorithm is used for
  the envelope checksum, the WAL frame checksum, the commit marker
  checksum, and the log entry checksum.

---

## Durability Modes

WAL durability runs in one of two modes. The mode determines the
guarantee a node may publish.

### sync (default)

A write is acknowledged only after its WAL record and the commit marker
have been made durable by fsync. Concurrent writes that arrive while an
fsync is in flight share the next fsync (group commit), so fsync cost is
amortised without weakening the guarantee.

**Guarantee:** no acknowledged write is lost on process crash or power
loss, subject to the platform fsync semantics in
[Platform Notes](#platform-notes).

### async

A write is appended to the segment and acknowledged without an fsync. A
background task fsyncs the segment and advances the commit marker every
`flush_interval_ms` (default `1000`). The marker therefore tracks only
the fsynced frontier; records appended since the last fsync sit beyond
it.

**Guarantee:** on power loss, acknowledged writes from the last fsync
window (up to `flush_interval_ms`) can be lost. A clean process crash
loses nothing, because the operating system flushes the buffered bytes
and recovery replays the records beyond the frontier (see
[Reading a segment](#reading-a-segment)).

### fsync errors are fatal

If an fsync returns an error, the implementation must not retry it and
assume success. On some operating systems a failed fsync drops the
dirty page, and a later fsync reports success without the data ever
reaching disk. The write must not be acknowledged. The implementation
surfaces a fatal error (`PERSISTENCE_FSYNC_FAILED`) and recovers from
the durable log. This is the PostgreSQL "fsyncgate" rule.

---

## WAL On-Disk Format

### Segment files

The WAL for a partition is a sequence of append-only **segment** files.

- One WAL per `(indexName, partitionId)`.
- Storage key / path convention:
  `<indexName>/wal/<partitionId>/<startSeqNo>` where `startSeqNo` is
  the 16-digit zero-padded sequence number of the first record in the
  segment, so segments sort lexically in sequence order.
- A segment is append-only. It is never modified in place. A segment is
  reclaimed only by deleting the whole file (see
  [Checkpoint and Truncation](#checkpoint-and-truncation)).
- A new segment starts when the active segment exceeds
  `segment_max_bytes` (default `67108864`, 64 MB) or at a checkpoint.

Because segments are append-only and deleted whole, never overwritten
in place, a reader can never encounter a stale leftover record from a
previous use of the same bytes.

### Segment header (8 bytes)

Every segment file begins with exactly 8 bytes:

```text
Offset  Size  Type      Field               Description
------  ----  ----      -----               -----------
0       4     bytes     magic               "NRSW" (0x4E 52 53 57)
4       1     uint8     wal_format_version  WAL framing version (1)
5       3     bytes     reserved            All 0x00 on write
```

Readers must reject a segment that does not begin with the `NRSW`
magic. A reader encountering a `wal_format_version` greater than it
supports must refuse the file with a clear error.

### Record frame

Each record follows the segment header:

```text
Offset  Size  Type      Field          Description
------  ----  ----      -----          -----------
0       4     uint32be  record_length  Byte length of the payload
4       N     bytes     payload        MessagePack ReplicationLogEntry
4+N     4     uint32be  frame_crc32    CRC32 (IEEE) of the payload bytes
```

- `payload` is the MessagePack encoding of the `ReplicationLogEntry`
  exactly as defined in [replication.md](distribution/replication.md),
  including the entry's own `checksum` field.
- `frame_crc32` is computed over the `payload` bytes only. The entry's
  own `checksum` field carries logical integrity for cross-node
  transfer; the frame checksum carries on-disk integrity. Both use CRC32
  (IEEE).

### Segment commit marker

A reader must not trust a record's `record_length` to find where the
durable region of a segment ends, because a corrupt length would point
the reader to the wrong place and risk silently dropping acknowledged
records. Each partition therefore keeps a small **commit marker** that
records, after every durable flush, exactly how far the active segment
is durable. This follows the Elasticsearch translog checkpoint design.

The marker lives at `<indexName>/wal/<partitionId>/commit`. It holds two
fixed-size slots so a torn marker write never destroys the last good
value:

```text
Offset  Size  Type      Field                   Description
------  ----  ----      -----                   -----------
0       8     uint64be  write_seq               Monotonic marker write counter
8       8     uint64be  active_segment_seq_no   startSeqNo of the active segment
16      8     uint64be  durable_byte_length     Durable byte length of the active segment
24      8     uint64be  highest_durable_seq_no  Highest seqNo durable across the WAL
32      4     uint32be  marker_crc32            CRC32 (IEEE) of bytes 0..31
```

Each slot is 36 bytes. Slot 0 begins at offset 0 and slot 1 at offset
36, so the marker file is 72 bytes.

A node updates the marker as the final step of a durable flush:

1. fsync the active segment, so the appended records are durable.
2. Write the marker to the slot that was not written last, with
   `write_seq` incremented, `durable_byte_length` set to the fsynced
   length, and `highest_durable_seq_no` set to the highest seqNo now
   durable across the WAL.
3. fsync the marker.

In sync mode, a node acknowledges a write only after the marker fsync
returns. If the marker write tears, its slot fails its CRC, and recovery
falls back to the other slot, whose smaller `durable_byte_length`
discards the un-acknowledged tail. A node never acknowledges a write
whose marker update is not yet durable.

When a node creates a new segment file, or the marker file for the first
time, it fsyncs the partition directory so the new directory entry
survives a crash.

The marker always names the current active segment. When a node rolls to
a new segment, it advances the marker to the new segment as part of the
roll, so the marker never names a sealed segment, and a checkpoint never
deletes the segment the marker names active (see
[Checkpoint and Truncation](#checkpoint-and-truncation)). In sync mode
this flush runs for every group commit. In async mode it runs only on
the `flush_interval_ms` timer, so the marker lags the appended records by
up to one interval, and those records are recovered as described in
[Reading a segment](#reading-a-segment).

### Reading a segment

Recovery uses the commit marker to find the durable region of each
segment, then reads records within that region.

1. Read the partition's commit marker. Choose the slot with the highest
   `write_seq` whose `marker_crc32` is valid. If neither slot is valid
   or the marker is absent, no acknowledged WAL records exist for the
   partition beyond the snapshot, and recovery replays nothing from the
   WAL.
2. Delete any segment whose `startSeqNo` is greater than
   `active_segment_seq_no`. Such a segment holds only un-acknowledged
   records from a roll that a crash interrupted.
3. A segment whose `startSeqNo` is below `active_segment_seq_no` was
   sealed before the active segment opened, so it is durable in full.
   Read every record in it.
4. For the active segment, the first `durable_byte_length` bytes are the
   fsynced frontier. Read the records inside the frontier by byte offset,
   never by trusting a record's own length to find where the frontier
   ends.
5. Inside the frontier, every record must be complete and valid. A
   `record_length` that overruns the frontier, a `frame_crc32` mismatch,
   a payload that fails to decode, a failed entry checksum, or an
   out-of-order `seqNo` is corruption of acknowledged, fsynced data.
   Recovery refuses to start and surfaces `PERSISTENCE_WAL_CORRUPT`.
6. After reading every segment up to the frontier, the highest `seqNo`
   read must equal `highest_durable_seq_no`. A lower value means a
   durable record is missing, which is corruption; refuse and surface
   `PERSISTENCE_WAL_CORRUPT`.
7. Beyond `durable_byte_length` in the active segment lie records that
   were appended but not yet fsynced, which exist only in async mode.
   Recovery parses them one by one and replays each record that is
   complete and valid and whose `seqNo` is greater than
   `highest_durable_seq_no`. It stops at the first record that is
   incomplete or fails its checksum, treats that as the torn tail,
   truncates the segment to the end of the last good record, and fsyncs
   it.

The fsynced frontier is read deterministically and any failure inside it
is fatal, so acknowledged, fsynced data is never silently dropped. Only
the async tail beyond the frontier is parsed best-effort, which is the
window the async guarantee already permits to be lost: a clean async
crash keeps the operating-system-flushed tail, and a power loss keeps
only the records up to the first torn frame.

---

## Snapshot (Checkpoint) Format

A snapshot is a full-index checkpoint stored as a single `.nrsl`
envelope.

- **Container:** the `.nrsl` envelope from [envelope.md](envelope.md),
  with the checksum flag set. The CRC32 payload checksum is mandatory
  for snapshots.
- **Payload:** the snapshot bundle, a MessagePack map. The
  `envelope_format_version` is `2`.

```text
SnapshotBundle {
  version:       uint8                          (2)
  schema:        map[string, string]
  language:      string
  partitions:    array[bytes]                   (per-partition payload-v2)
  vectorIndexes: map[string, VectorIndexPayload]
  checkpoint:    array[PartitionCheckpoint]
}

PartitionCheckpoint {
  partitionId: uint32
  lastSeqNo:   uint64   (highest seqNo included in this snapshot)
  primaryTerm: uint64
}
```

`checkpoint` records, per partition, the highest `seqNo` the snapshot
already contains. Recovery replays each partition's WAL from
`lastSeqNo + 1`. `checkpoint` is an additive field: a reader that does
not find it treats every partition's `lastSeqNo` as `0` and replays the
whole WAL.

### Atomic snapshot write

A snapshot must replace the previous one atomically and durably:

1. Serialise the bundle and wrap it in the `.nrsl` envelope (with CRC).
2. Write the bytes to a temporary file in the **same directory** as the
   destination.
3. fsync the temporary file.
4. rename the temporary file over `<indexName>/snapshot`.
5. fsync the containing directory.

A crash before step 4 leaves the previous snapshot intact; the
temporary file is discarded on recovery. A crash after step 4 but
before WAL truncation leaves the new snapshot plus the full WAL;
recovery still produces the correct state because replay filters by
sequence number. Each fsync error is fatal, as in
[Durability Modes](#durability-modes).

---

## Index Metadata

On index creation and on schema-affecting changes, a node persists the
index metadata at `<indexName>/meta` using the metadata payload from
[envelope.md](envelope.md#index-metadata-payload). Metadata lets
recovery rebuild an index (schema, language, partition count, vector
fields) without any application call.

---

## Checkpoint and Truncation

A checkpoint is triggered by an interval and/or a mutation count since
the last checkpoint. The procedure:

1. Capture each partition's current head sequence number `N_p`.
2. Serialise and atomically write the snapshot, embedding the
   `checkpoint` array with `lastSeqNo = N_p` per partition.
3. After the snapshot is fully durable (the directory fsync in the
   atomic write has returned), delete, for each partition, every WAL
   segment whose highest `seqNo` is less than or equal to `N_p`. Keep
   the segment that contains `N_p` (it also holds records greater than
   `N_p`) and every newer segment. Never delete the segment named by the
   partition's commit marker, even if all of its current records are at
   or below `N_p`, because new writes will extend it.

**Ordering rule:** the snapshot must be fully durable before any WAL
segment it covers is deleted. This ordering is never reversed. A crash
between steps 2 and 3 leaves extra WAL segments that recovery harmlessly
skips by sequence number.

The commit marker always references the active segment, which a
checkpoint never deletes, so truncation does not affect the marker.

---

## Recovery

On startup, when persistence is configured, a node recovers before it
serves requests:

1. Enumerate persisted indexes from their `<indexName>/meta` keys.
2. For each index:
   1. Load `<indexName>/meta`, reconstruct the schema, language,
      partition count, and vector fields, and create the index empty.
   2. Load `<indexName>/snapshot` and verify the envelope CRC. If the
      snapshot is absent, every partition starts empty with
      `lastSeqNo = 0`.
   3. Deserialise the bundle, load the partitions and vector indexes,
      and read each partition's `lastSeqNo`.
   4. For each partition, read its WAL as in
      [Reading a segment](#reading-a-segment) and replay every record
      with `seqNo > lastSeqNo`, applying it to the partition.
3. After replay, the index serves reads and writes. Each partition
   continues from the highest replayed `seqNo + 1`.

**Corruption handling:**

- A snapshot envelope CRC mismatch is fatal for that index; surface
  `PERSISTENCE_CRC_MISMATCH`.
- WAL mid-log corruption is fatal; surface `PERSISTENCE_WAL_CORRUPT`.
- A truncated active-segment tail is normal; truncate and continue.

---

## Write Path

A mutation is durable before it is acknowledged, and a WAL record is
written only for a mutation that has already applied in memory, so
replay can never resurrect a write that failed or poison recovery.

For each mutation while the WAL is active:

1. Validate the document against the schema.
2. Apply the mutation to the in-memory partition, including any vector
   index work. If this fails, no WAL record is written and the caller
   receives the error.
3. Build the log entry. `INDEX` carries the full transformed document,
   including any computed embeddings, as MessagePack bytes. `DELETE`
   carries the `documentId` with `document = null`. Assign the
   partition's next `seqNo`. On a single node, `primaryTerm` is a
   constant.
4. Append the framed record to the partition's active WAL segment, make
   it durable per the [durability mode](#durability-modes), and update
   the [commit marker](#segment-commit-marker).
5. Acknowledge the write.

A node serialises a partition's apply, sequence-number assignment, and
append, so the in-memory apply order matches the WAL sequence order and
sequence numbers reach disk strictly increasing. If the durable append
fails, the write is not acknowledged; an fsync error is fatal. A crash
between step 2 and a durable step 4 loses the write, but because that
write was never acknowledged, the loss is correct.

---

## Snapshot-Only Persistence

A `PersistenceAdapter` that is not filesystem-backed (an in-memory
store, IndexedDB, an object store, or a key-value service) cannot run
the WAL, because its `save(key, bytes)` interface expresses neither
append nor fsync. These backends persist snapshots only.

- On the same interval and mutation-count triggers as a checkpoint, the
  node writes the index snapshot, the same `.nrsl` envelope used in
  [Tier 1](#tier-1-wal-durability-filesystem), through the adapter's
  `save` at key `<indexName>/snapshot`. No WAL is written.
- The snapshot write must be atomic at the backend's granularity. A
  single object-store `PUT` and an IndexedDB transaction are atomic. A
  filesystem-backed adapter must use the atomic
  temporary-file-then-rename sequence.
- Recovery loads the snapshot through `adapter.load` and replays no log.

**Guarantee:** the index is durable up to the last snapshot. A crash
loses every write since that snapshot. A node must publish this weaker
guarantee and must not imply the WAL guarantee for a snapshot-only
backend.

Configuring WAL durability (a `durability.directory`) for a
non-filesystem backend is a configuration error and surfaces
`CONFIG_INVALID`.

---

## Platform Notes

- POSIX `rename` is atomic for concurrent readers, but atomicity is not
  durability. Durability requires the temporary-file fsync and the
  directory fsync in the [atomic snapshot write](#atomic-snapshot-write).
- On Linux, `fsync` flushes to the storage device. On macOS, Node's
  `fs.fsync` routes through libuv, which attempts `F_FULLFSYNC` (a true
  flush to permanent storage) and falls back to a plain `fsync` only on
  volumes that do not support it, such as some network or external
  disks. A pure-TypeScript Narsil node therefore gets process-crash
  durability on every platform, power-loss durability on Linux and on
  typical local macOS disks, and degrades to process-crash-only
  durability on the macOS volumes where `F_FULLFSYNC` is unavailable.
  No native addon is required.
- On Windows, rename over an existing file is not guaranteed atomic and
  a directory fsync is a no-op. Durability on Windows is best-effort.

---

## Error Codes

| Code | When |
|---|---|
| `PERSISTENCE_CRC_MISMATCH` | A snapshot envelope checksum does not match its payload. |
| `PERSISTENCE_WAL_CORRUPT` | A record inside a WAL segment's durable region overruns the region, fails its checksum, fails to decode, breaks sequence-number order, or leaves the highest read seqNo short of the commit marker. |
| `PERSISTENCE_FSYNC_FAILED` | An fsync returned an error. The write is not acknowledged. Fatal. |
| `PERSISTENCE_LOAD_FAILED` | A snapshot or WAL file could not be read or decoded. |
| `PERSISTENCE_SAVE_FAILED` | A snapshot or WAL file could not be written. |
| `CONFIG_INVALID` | WAL durability was requested for a non-filesystem backend, or durability was configured without a directory. |
