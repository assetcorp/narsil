# Narsil Conformance Suite Specification

The conformance suite in `packages/conformance` lets the author of a Narsil implementation in any language check it against the reference. This document defines the JSON form of each kind of file, the rule that decides when two files hold the same content, and the damaged files that a reader must refuse.

Two correct writers can produce different bytes for the same content. A writer compresses each document block of a [paged keyword segment](envelope.md#paged-keyword-segment-payload) with DEFLATE, which [RFC 1951](https://www.rfc-editor.org/rfc/rfc1951) lets two compressors encode differently, and two MessagePack encoders can choose different widths for the same integer. The suite therefore compares content, and it never compares bytes.

---

## The Checks

The suite holds a sample file of each kind below, each with a JSON file of its expected content, and it runs four checks:

1. **Read.** The implementation reads each sample file and writes the content that it read in the JSON form of that kind. The suite compares that JSON with the expected JSON.
2. **Write.** The implementation writes a file of each kind from the expected JSON. The suite reads that file through the reference and compares its content with the expected JSON.
3. **Damaged files.** The implementation reads each damaged file, and it must raise the error code that the suite gives for that file.
4. **Files that must open.** The implementation reads each of these files, and it must succeed and return the expected content.

The sample files of each kind must between them hold every key, every optional value, and every alternative that this specification defines for that kind, so that no rule goes unchecked. That covers both `storage` values of a vector field, the `seqNos`, `primaryTerms`, and `termHistory` of a cluster partition copy, each `bits` value of `codes`, a segment that tracks positions, a gzip envelope of each kind that allows one, and the archive of one partition.

The suite must keep the files that an [earlier release](durability.md#earlier-layouts) wrote for as long as this specification requires a reader to open them. Before 1.0, those are a checkpoint directory of engine 0.3.0, a snapshot bundle under `<indexName>/snapshot`, and an index snapshot that the 0.3.0 snapshot operation returned. For each, the expected JSON maps every document ID to the document that a reader must recover, with values in the form that [Values](#values) defines.

The suite also holds the vectors, the queries, and the expected results that [Conformance Testing](vector-index.md#conformance-testing) describes. It fetches them from a release artifact whose SHA-256 digest the suite pins, and it refuses an artifact whose digest differs from the pin.

---

## Same Content

Two files hold the same content where their JSON forms are equal. Two JSON values are equal under these rules:

- Two objects are equal where they hold the same keys and equal values under each key. The order of the keys is free.
- Two arrays are equal where they hold equal values in the same order.
- Two numbers are equal where they hold the same value. An integer and a float of the same value are equal, because a MessagePack encoder can write a float that holds a whole number as an integer. For the same reason, 0 equals -0 inside a MessagePack value, while a document export must keep -0, as [Document Export](durability.md#document-export) requires, so the suite compares the sign of a zero in an export. Where this specification names the width of a MessagePack float, a reader must accept either width, as [Index Metadata Payload](envelope.md#index-metadata-payload) already requires of `bm25_params`. A number inside a `bytes` value keeps its width, because the width fixes its bytes.
- Two strings are equal where they hold the same code points.

A sample file must hold no integer above 9,007,199,254,740,991, so that a JSON reader that parses every number as a float64 reads each integer exactly.

---

## Values

### Header

The JSON form of a `.nrsl` header is this object:

```text
{
  envelopeFormatVersion: uint8
  compression:           'none' or 'gzip'
  checksum:              boolean   (whether the checksum flag is set)
}
```

The engine version, `payload_length`, the checksum value, and the reserved bytes stay out of it, because [Engine Version](envelope.md#engine-version) makes the engine version diagnostic, the payload fixes `payload_length` and the checksum, and a reader ignores the reserved bytes.

### Values inside MessagePack

A MessagePack value takes the JSON form that [Document Export](durability.md#document-export) gives it, with the `$date`, `$bytes`, `$number`, and `$object` tags. A nil becomes `null`, and a key that a payload leaves out stays out of the JSON. Map keys keep the names that this specification gives them, in the case that each payload uses.

### Numbers inside `bytes`

A `bytes` value that this specification fills with numbers of one width becomes a JSON array of those numbers, as `uint16`, `uint32`, `uint64`, `float32`, or `float64` values. A JSON form must write a `float32` so that parsing it and rounding the result to `float32` give the stored value. It must write a NaN or an infinite value as the `$number` tag.

### Lists with offsets

A `bytes` value that an offsets array divides into text or MessagePack entries becomes one JSON array of its entries, and the offsets array stays out, because a writer computes it:

| Payload values | JSON array |
|----------------|------------|
| `ids` with `idOffsets` | one string per document |
| `tokens` with `tokenOffsets` | one string per token |
| `documents` with `documentOffsets` | one document per ordinal, in the form of [Values inside MessagePack](#values-inside-messagepack) |
| `SurfaceFormColumn.text` with `offsets` | one `[surface, token]` pair per entry |
| `PartialWordColumn.text` with `offsets` | one string per entry |

An offsets array that divides a list of numbers stays a list of numbers, such as `postingOffsets`, `positionOffsets`, the `offsets` of an `EnumColumn` and of a `PatternColumn`, `runOffsets`, and `removalOffsets`.

### Placement

Where a value records where other bytes lie, or how a writer encoded them, the JSON form leaves it out, and a writer computes it. That covers:

- the `offset`, `length`, `pageBytes`, and `checksums` of every section
- `head` and `headLength` in a payload, and `headChecksum`, together with `headOffset` and `headLength` in a manifest entry inside a snapshot archive
- the `idOffsets` of a vector file and the `nodeOffsets` of a graph part
- `documentBlocks` and the DEFLATE bytes of a paged segment
- the `record_length` and `frame_crc32` of each log record, the `checksum` of each log entry, and the `marker_crc32` of each commit marker slot
- the tar headers and pax records of a snapshot archive, and the `bytes` and `checksum` of each file that its manifest lists

Where this specification requires a writer to store a head, because the field's `storage` is `disk`, the JSON form carries `"storage": "disk"`, and the suite checks that the file holds the head.

---

## The JSON Form of Each Kind

### Keyword segment

[Keyword Segment Payload](envelope.md#keyword-segment-payload) defines the payload. The JSON form is `{ header, payload }`, where `payload` holds every key of the payload under the rules above. `positionOffsets` and `positions` are `null` where the payload holds nil, and `seqNos` and `primaryTerms` are absent where the payload leaves them out.

### Paged keyword segment

[Paged Keyword Segment Payload](envelope.md#paged-keyword-segment-payload) defines the payload:

```text
{
  header:   Header
  head:     { v, schema, tombstones, documentCount, fieldNames }
  sections: Map<string, value>   (one key per section that the segment holds)
}
```

`sections` holds every section of the segment other than `documentBlocks`:

- `postings` becomes three keys, `postingDocuments`, `postingFrequencies`, and `postingFields`, each one list across every token in token order, which a writer divides with `postingOffsets`.
- `documents` becomes one array of documents in ordinal order, because a block boundary depends on encoded sizes.
- `ids` with `idOffsets`, and `tokens` with `tokenOffsets`, each become one array of strings, as in a keyword segment.
- `blockSummaries` becomes an array of `{ postingEnd, maxTermFrequency, minFieldLength, maxEntriesPerDocument, documentCount }` objects.
- `idSample` becomes an array of `[id, position]` pairs.
- `fieldLengths`, `numeric`, `sizes`, `boolean`, `enum`, `geopoint`, `pattern`, `partialWords`, and `surfaceForms` take the form that they take in a keyword segment.
- Every other section becomes an array of its numbers.

### Vector file

[Vector File Payload](envelope.md#vector-file-payload) defines the payload:

```text
{
  header:  Header
  storage: 'memory' or 'disk'
  payload: {
    v, fieldName, dimension, docIds,
    codes:      null or { bits, centroid, records: List<{ code: List<uint8>, lower, upper, correction, sum }> }
    magnitudes: List<float64> or absent
    idOrder:    List<uint32> or absent
    vectors:    List<List<float32>>   (one list per vector, in position order)
  }
}
```

The independent decoder of the suite also checks that `vectors` is the last entry of the payload map.

### Vector graph part

[Vector Graph Payload](envelope.md#vector-graph-payload) defines the payload:

```text
{
  header:  Header
  storage: 'memory' or 'disk'
  payload: {
    v, fieldName,
    graphs: List<{
      entryPoint, maxLayer, m, efConstruction, metric,
      shuffledBuildCount:   uint32 or absent
      calibratedMeanLength: float64 or absent
      levels:     List<uint8>
      neighbours: List<List<List<uint32>>>   (per node in number order, one list per layer from layer 0)
    }>
  }
}
```

### Manifest

[Manifest](durability.md#manifest) defines the payload. The JSON form is `{ header, payload }`, where `payload` mirrors the map and `dead` is `null` or an array of its bytes as `uint8` values. A manifest on its own keeps every value of each entry, `bytes` and `checksum` included.

### Index metadata

[Index Metadata Payload](envelope.md#index-metadata-payload) defines the payload. The JSON form is `{ header, payload }`, where `payload` mirrors the map with its snake_case keys.

### Index configuration

[Index Configuration Payload](envelope.md#index-configuration-payload) defines the payload. The JSON form is `{ header, payload }`, where `payload` mirrors the map with its camelCase keys.

### Log segment

[Segment Header](durability.md#segment-header), [Record Frame](durability.md#record-frame), and [Log Entry Format](distribution/replication.md#log-entry-format) define the file:

```text
{
  walFormatVersion: uint8
  records: List<{ seqNo, primaryTerm, operation, partitionId, indexName, documentId, document: value or absent }>
}
```

`document` holds the decoded document in the form of [Values inside MessagePack](#values-inside-messagepack).

### Commit marker

[Commit Marker](durability.md#commit-marker) defines the file:

```text
{
  slots: List<{ writeSeq, activeSegmentSeqNo, durableByteLength, highestDurableSeqNo } or null>   (slot 0, then slot 1)
}
```

A slot is `null` where its `marker_crc32` fails, so that the JSON form of a marker with one torn slot gives the slot that a reader must use.

### Backup manifest

[Backup Manifest](distribution/backups.md#backup-manifest) defines the payload. The JSON form is `{ header, payload }`, where `payload` mirrors the map, `sha256` and `bytes` included.

### Snapshot archive

[Snapshot Archive](durability.md#snapshot-archive) defines the file:

```text
{
  entries: List<{ name: string, content: the JSON form of that entry's kind }>   (in archive order)
}
```

### Document export

[Document Export](durability.md#document-export) defines the file. The JSON form is `{ header, documents }`, where `header` is the parsed first line and `documents` holds every later line as a parsed object, so that the spelling of each number and the order of the keys are free.

---

## Damaged Files

The suite must hold one damaged file for each rule of this specification that requires a reader to raise an error, together with the error code that the rule names. A damaged file must break that rule alone, and it must carry a correct checksum everywhere outside the bytes that its rule covers, so that a reader can raise no other code first. A rule that covers a file in its checkpoint, such as a vector file whose length differs from the manifest, takes a small checkpoint directory that holds the manifest and the files that the rule needs.

The suite must also hold a file for each rule that requires a reader to accept something that looks wrong, such as reserved bytes and reserved flag bits that are not 0, a torn record past the commit marker's frontier, one torn slot of a commit marker, a `bm25` value that [Parameter Levels](algorithms.md#parameter-levels) tells a reader to load, and an export line of the longest length that a reader must accept.

An implementation passes a damaged file when it raises the named code and loads none of the file's content. A damaged line of a document export is the one exception, because the import refuses that line and goes on, so an implementation passes it when its import reports that line with the named code and imports every other line.
