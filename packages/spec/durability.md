# Narsil Durability Specification

This document defines how a single Narsil node survives a crash and
restores its data on restart. Durability rests on two artefacts: a
periodic **snapshot** (the checkpoint) and a **write-ahead log**
(the WAL) of every mutation since that checkpoint. On restart, a node
loads the snapshot and replays the WAL records the snapshot does not
already contain.

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

A Narsil node holds its index in memory. Durability comes from:

- **Snapshot (checkpoint):** the full index state at a point in time,
  written atomically as a `.nrsl` envelope (see
  [envelope.md](envelope.md)). Taken periodically.
- **WAL:** an append-only, per-partition log of mutations. A mutation
  is made durable in the WAL before the write is acknowledged.

Recovery loads the latest snapshot, then replays WAL records whose
sequence number is greater than the snapshot's recorded checkpoint
position.

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
  the envelope checksum, the WAL frame checksum, and the log entry
  checksum.

---

## Durability Modes

A node runs in one of two durability modes. The mode determines the
guarantee a node may publish.

### sync (default)

A write is acknowledged only after its WAL record has been made
durable by an fsync. Concurrent writes that arrive while an fsync is in
flight share the next fsync (group commit), so fsync cost is amortised
without weakening the guarantee.

**Guarantee:** no acknowledged write is lost on process crash or power
loss, subject to the platform fsync semantics in
[Platform Notes](#platform-notes).

### async

A write is acknowledged before its WAL record is fsynced. A background
task fsyncs every `flush_interval_ms` (default `1000`).

**Guarantee:** on power loss, acknowledged writes from the last fsync
window (up to `flush_interval_ms`) can be lost. A clean process crash
loses nothing, because the operating system still flushes the buffered
bytes.

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
previous use of the same bytes. Sequence-number monotonicity (below) is
the additional guard.

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
- `frame_crc32` is computed over the `payload` bytes only. It is the
  on-disk torn-write guard. The entry's own `checksum` field carries
  logical integrity for cross-node transfer; the frame checksum carries
  on-disk integrity. Both use CRC32 (IEEE).

### Reading and the torn-tail rule

Recovery reads records sequentially from the end of the segment header:

1. If fewer than 4 bytes remain, the segment ends cleanly.
2. Read `record_length`. If it exceeds `segment_max_bytes` or exceeds
   the bytes remaining after accounting for the trailing 4-byte
   checksum, the final record is torn: truncate at this offset.
3. Read `payload` and `frame_crc32`. If fewer bytes remain than
   required, the final record is torn: truncate at this offset.
4. Compute CRC32 over `payload`. On mismatch:
   - If no valid record follows, the final record is torn: truncate.
   - If a valid record follows, the log has a hole. This is mid-log
     corruption, not a torn tail. Recovery must refuse to start and
     surface `PERSISTENCE_WAL_CORRUPT`.
5. Sequence numbers within a partition must strictly increase. A gap or
   an out-of-order `seqNo` with valid records following it is mid-log
   corruption: refuse and surface `PERSISTENCE_WAL_CORRUPT`.

A torn tail is always at the physical end of the last segment, with
nothing valid after it. That is the normal end-of-log signal after a
crash. On a torn tail, the segment is truncated to the offset of the
first bad or partial record and fsynced, so later appends continue
cleanly.

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
   `N_p`) and every newer segment.

**Ordering rule:** the snapshot must be fully durable before any WAL
segment it covers is deleted. This ordering is never reversed. A crash
between steps 2 and 3 leaves extra WAL segments that recovery harmlessly
skips by sequence number.

---

## Recovery

When persistence is configured and eager loading is enabled, a node
recovers on startup:

1. Enumerate persisted indexes from their `<indexName>/meta` keys.
2. For each index:
   1. Load `<indexName>/meta`; reconstruct the schema, language,
      partition count, and vector fields; create the index empty.
   2. Load `<indexName>/snapshot`. Verify the envelope CRC. If the
      snapshot is absent, every partition starts empty with
      `lastSeqNo = 0`.
   3. Deserialise the bundle; load partitions and vector indexes; read
      each partition's `lastSeqNo`.
   4. For each partition, open its WAL segments in sequence order and
      replay every record with `seqNo > lastSeqNo`, applying it to the
      partition. Apply the [torn-tail rule](#reading-and-the-torn-tail-rule)
      during replay.
3. After replay, the index serves reads and writes. New mutations
   continue from the highest replayed `seqNo + 1` per partition.

**Corruption handling:**

- Snapshot envelope CRC mismatch is fatal for that index; surface
  `PERSISTENCE_CRC_MISMATCH`.
- WAL mid-log corruption is fatal; surface `PERSISTENCE_WAL_CORRUPT`.
- A WAL torn tail is normal; truncate and continue.

---

## Write Path

For each mutation while the WAL is active:

1. Validate the document against the schema before any durable write.
2. Build the log entry. `INDEX` carries the full transformed document,
   including any computed embeddings, as MessagePack bytes. `DELETE`
   carries the `documentId` with `document = null`. Assign the
   partition's next `seqNo`. On a single node, `primaryTerm` is a
   constant.
3. Append the framed record to the partition's active WAL segment and
   make it durable per the [durability mode](#durability-modes) before
   acknowledging.
4. Apply the mutation to the in-memory partition.
5. Acknowledge the write.

If the durable append fails, the write is not acknowledged. An fsync
error is fatal.

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
| `PERSISTENCE_WAL_CORRUPT` | A WAL record fails its checksum or sequence-number check with valid records following it (mid-log corruption). |
| `PERSISTENCE_FSYNC_FAILED` | An fsync returned an error. The write is not acknowledged. Fatal. |
| `PERSISTENCE_LOAD_FAILED` | A snapshot or WAL file could not be read or decoded. |
| `PERSISTENCE_SAVE_FAILED` | A snapshot or WAL file could not be written. |
