# Narsil Envelope Format Specification (.nrsl)

This document defines the binary serialization format used by all
Narsil implementations. The `.nrsl` format is the portable,
cross-language contract for persisting and transferring index data.
Any conforming implementation (TypeScript, Rust, Python, Go) must
read and write this format identically.

---

## File Extension

`.nrsl` matches the magic bytes and identifies Narsil data files.

---

## 32-Byte Header (Permanent Contract)

This header structure will NEVER change. It is the permanent contract
across all versions of Narsil, all language implementations, forever.
Every `.nrsl` file begins with exactly 32 bytes:

```text
Offset  Size  Type      Field                    Description
------  ----  ----      -----                    -----------
0       4     bytes     magic                    "NRSL" (0x4E 52 53 4C)
4       1     uint8     envelope_format_version  Payload schema version
5       1     uint8     engine_version_major     Narsil major version
6       1     uint8     engine_version_minor     Narsil minor version
7       1     uint8     engine_version_patch     Narsil patch version
8       4     uint32be  payload_length           Payload size in bytes
12      2     uint16be  flags                    Feature flags
14      4     uint32be  checksum                 CRC32 of payload bytes
18      14    bytes     reserved                 All 0x00 on write
```

Total header size: **32 bytes**.

### Magic Bytes

The first 4 bytes must be `0x4E 0x52 0x53 0x4C` (ASCII "NRSL").
Readers must reject any file that does not begin with these bytes.

### Envelope Format Version

A single byte identifying the payload schema. Starts at `1`.
Incremented on breaking changes to the payload structure (field
removals, renames, or semantic changes). Adding optional fields
does not require a version bump.

### Engine Version

Three bytes encoding the Narsil engine version that wrote the file
(`major.minor.patch`). This is informational and used for
diagnostics; it does not affect deserialization logic.

### Payload Length

The byte count of the payload that follows the header. Readers must
read exactly this many bytes starting at offset 32.

### Checksum

A CRC32 checksum of the payload bytes (using the IEEE polynomial,
see [algorithms.md](algorithms.md#crc32)). If bit 3 of the flags
field is `0`, this field is `0x00000000` and no checksum validation
is performed. If bit 3 is `1`, the reader must compute CRC32 over
the payload bytes and compare against this value. A mismatch
indicates data corruption.

### Reserved Bytes

14 bytes reserved for future use. Writers must set these to `0x00`.
Readers must ignore them. Possible future assignments include
encryption key identifiers, partition metadata, creation timestamps,
and parent envelope hashes for chain-of-custody.

---

## Flags (uint16, 16 bits)

```text
Bit(s)   Meaning
------   -------
0        Compression enabled (0 = raw, 1 = compressed)
1-2      Compression algorithm (00=none, 01=gzip, 10=lz4, 11=zstd)
3        Checksum present (0 = no CRC32, 1 = CRC32 in bytes 14-17)
4        Encryption enabled (0 = plaintext, 1 = encrypted)
5-15     Reserved (set to 0 on write, ignored on read)
```

### Compression

When bit 0 is `1`, the payload is compressed. Bits 1-2 identify
the algorithm:

| Bits 1-2 | Algorithm | v1 Support |
|----------|-----------|------------|
| `00`     | none      | N/A        |
| `01`     | gzip      | Required   |
| `10`     | lz4       | Optional   |
| `11`     | zstd      | Optional   |

All v1 implementations must support gzip. lz4 and zstd are flagged
in the header for future use; a v1 reader encountering lz4 or zstd
must reject the file with a clear error message.

When compression is enabled, the `payload_length` field refers to
the **compressed** size. The reader decompresses the payload before
MessagePack decoding.

### Encryption

When bit 4 is `1`, the payload is encrypted. The encryption scheme
is not defined in v1. A v1 reader encountering an encrypted payload
must reject it with a clear error message.

---

## Payload Format

The payload begins at byte 32 and is encoded using
[MessagePack](https://msgpack.org/). MessagePack was chosen for
cross-language portability, compact binary encoding, and native
support in every major programming language.

The payload schema is determined by the `envelope_format_version`
field in the header. The storage key determines which payload type
to expect (partition, vector index, or metadata).

---

## Envelope Format Version 1

### Partition Payload

Each partition is serialized as its own `.nrsl` envelope file.
Partition payloads contain text and field index data. Vector data
is stored separately in vector index files (see
[Vector Index Payload](#vector-index-payload)).

A v1 partition payload is a MessagePack map with these fields:

```text
{
  index_name:       string
  partition_id:     uint32
  total_partitions: uint32
  language:         string
  schema:           map[string, string]
  doc_count:        uint32
  avg_doc_length:   float32
  documents:        map[string, Document]
  inverted_index:   map[string, PostingList]
  field_indexes:    FieldIndexes
  statistics:       Statistics
}
```

### Documents

A map from document ID (string) to a `Document` structure:

```text
Document {
  fields:        map[string, value]
  field_lengths: map[string, uint16]
}
```

`fields` holds the raw document field values, keyed by field name.
Nested objects use dot-notation keys (e.g., `"author.name"`).
Vector field values are not included in `fields`; they are stored
in the vector index file for the corresponding field.
`field_lengths` holds token counts per text field after analysis,
used for BM25 scoring.

### Inverted Index

A map from token (string) to a `PostingList` structure:

```text
PostingList {
  doc_freq: uint32
  postings: array[Posting]
}

Posting {
  doc_id:    string
  term_freq: uint16
  field:     string
  positions: array[uint16]
}
```

`doc_freq` is the number of documents containing this token in the
partition. `postings` has one entry per (document, field) pair that
contains the token. `positions` holds zero-indexed token positions
within the field, used for highlighting and phrase matching.

### Field Indexes

```text
FieldIndexes {
  numeric:  map[string, array[NumericEntry]]
  boolean:  map[string, BooleanIndex]
  enum:     map[string, map[string, array[string]]]
  geopoint: map[string, array[GeopointEntry]]
}

NumericEntry {
  value:  float64
  doc_id: string
}

BooleanIndex {
  true_docs:  array[string]
  false_docs: array[string]
}

GeopointEntry {
  lat:    float64
  lon:    float64
  doc_id: string
}
```

Numeric entries are stored in sorted order by value to enable binary
search on deserialization.

### Statistics

```text
Statistics {
  total_documents:       uint32
  total_field_lengths:   map[string, uint64]
  average_field_lengths: map[string, float32]
  doc_frequencies:       map[string, uint32]
}
```

`doc_frequencies` stores per-token document frequency across this
partition. Persisted to support DFS and broadcast scoring modes
after reload without recomputation.

---

### Vector Index Payload

Each vector field is serialized as its own `.nrsl` envelope file,
separate from partition data. See
[vector-index.md](vector-index.md#serialization) for the full
payload schema and design rationale.

A v1 vector index payload is a MessagePack map:

```text
{
  field_name:  string
  dimension:   uint16
  vectors:     array[VectorEntry]
  graphs:      array[HnswGraph]
  sq8:         SQ8Data or null
}

VectorEntry {
  doc_id: string
  vector: array[float32]
}

HnswGraph {
  entry_point:     string or null
  max_layer:       uint8
  m:               uint8
  ef_construction: uint16
  metric:          string
  nodes:           array[HnswNode]
}

HnswNode = [
  doc_id:      string,
  layer:       uint8,
  connections: array[[
    layer_index: uint8,
    neighbor_ids: array[string]
  ]]
]

SQ8Data {
  alpha:              float32
  offset:             float32
  quantized_vectors:  map[string, array[uint8]]
  vector_sums:        map[string, float32]
  vector_sum_sqs:     map[string, float32]
}
```

The `graphs` field is an array. A single-graph implementation
writes an array of length 1. A segment-based implementation writes
one graph per segment. The `vectors` list is always flat (one entry
per document, regardless of graph count). Graphs reference vectors
by `doc_id`.

When `graphs` is empty, the implementation uses brute-force
similarity search (the vector count is below the promotion
threshold).

---

### Index Metadata Payload

Each index persists a metadata envelope at the key
`<indexName>/meta`. This uses the same 32-byte header but contains
a different payload structure:

```text
{
  index_name:      string
  schema:          map[string, string]
  language:        string
  partition_count: uint32
  bm25_params:     { k1: float32, b: float32 }
  created_at:      uint64  (Unix timestamp in milliseconds)
  engine_version:  string  (e.g., "0.1.0")
  vector_fields:   map[string, VectorFieldMeta]
}

VectorFieldMeta {
  dimension:    uint16
  metric:       string
  quantization: string
}
```

The `vector_fields` map lists all vector fields and their
configuration. This allows the engine to discover which vector
index files to load without scanning storage keys.

---

## Storage Path Convention

Persistence adapters use string keys that map to storage locations:

| Key Pattern                          | Content              |
|--------------------------------------|----------------------|
| `<indexName>/meta`                   | Index metadata       |
| `<indexName>/partition_<N>`          | Partition N data     |
| `<indexName>/vector/<fieldName>`     | Vector index data    |

For filesystem adapters, keys map to file paths:
`data/<indexName>/partition_0.nrsl`,
`data/<indexName>/vector/embedding.nrsl`, and
`data/<indexName>/meta.nrsl`.

---

## Version Compatibility Rules

These rules are permanent and must be followed by all
implementations:

1. **Code maintains deserializers for ALL shipped envelope format
   versions.** A v3 deserializer handles v1 and v2 payloads by
   filling in defaults for missing fields. Old deserializers are
   NEVER removed.

2. **Adding new optional fields** to the payload is a minor version
   bump (v1.0 -> v1.1). Existing deserializers ignore unknown
   fields. MessagePack handles this naturally since it preserves
   unknown keys.

3. **Removing or renaming fields** is a major version bump
   (v1 -> v2). A new deserializer is added alongside the existing
   one.

4. **Newer code reading older envelopes:** Always works. The newer
   deserializer fills in defaults for fields that were added after
   the older version.

5. **Older code reading newer major versions:** Reject with a clear
   error message such as: "This data was written by Narsil envelope
   format vN and requires Narsil >= X.Y.Z. You are running A.B.C."
   Use the `ENVELOPE_VERSION_MISMATCH` error code.

6. **Cross-language compatibility:** A `.nrsl` file written by the
   TypeScript implementation must be readable by the Rust, Python,
   or Go implementation (and vice versa), provided both support the
   envelope format version in the header.
