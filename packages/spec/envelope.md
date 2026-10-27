# Narsil Envelope Format Specification (.nrsl)

The `.nrsl` format is Narsil's binary serialisation format and its portable cross-language contract for storing and moving index data. Every conforming implementation must read and write it identically, whatever language it is written in.

Structure definitions use a language-neutral notation. `List<T>` is an ordered collection of `T`, `Map<K, V>` a mapping from keys to values, and `T or absent` a value that may be missing. Width-tagged names such as `uint32` and `float32` describe exact byte widths on disk and on the wire; each implementation maps them to its own types.

---

## File Extension

Files carry the `.nrsl` extension, which matches the magic bytes at the start of every file.

---

## 32-Byte Header (Permanent Contract)

This header never changes. It is the permanent contract across every version of Narsil and every language implementation. Each `.nrsl` file begins with exactly these 32 bytes:

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
14      4     uint32be  checksum                 CRC32 of the payload bytes
18      14    bytes     reserved                 All 0x00 on write
```

### Magic Bytes

The first four bytes must be `0x4E 0x52 0x53 0x4C`, which is ASCII `NRSL`. A reader must reject any file that starts with anything else.

### Envelope Format Version

One byte naming the payload schema, starting at 1. It increases on a breaking change to the payload structure, meaning a removed field, a renamed field, or a changed meaning. Adding an optional field needs no increase.

### Engine Version

Three bytes recording the `major.minor.patch` version of the engine that wrote the file. The value is diagnostic and changes nothing about how a reader decodes the payload.

### Payload Length

The byte count of the payload that follows the header. A reader must read exactly that many bytes starting at offset 32. A writer must reject a payload longer than 4,294,967,295 bytes with `PERSISTENCE_SAVE_FAILED`.

### File Size

A writer must keep every file that it writes, header included, at or below 2,147,483,647 bytes, which is the largest value of a signed 32-bit integer. Node.js reads at most that many bytes of a file in one call, so a larger file that one implementation writes can fail to load in another. A writer must split content that would pass the limit across several files where this specification allows that, and it must otherwise reject the write with `PERSISTENCE_SAVE_FAILED`.

### Checksum

A CRC32 of the payload bytes under the IEEE polynomial; see [CRC32](algorithms.md#crc32). When bit 3 of the flags is 0, this field is `0x00000000` and the reader checks nothing. When bit 3 is 1, the reader must compute the CRC32 over the payload bytes and compare it with this field. A mismatch means the data is corrupt.

### Reserved Bytes

Fourteen bytes held back for later use. A writer must set them to `0x00`, and a reader must ignore them. Candidates for those bytes include encryption key identifiers, partition metadata, creation timestamps, and parent envelope hashes for chain of custody.

---

## Flags

The flags field is 16 bits:

```text
Bit(s)   Meaning
------   -------
0        Compression enabled (0 = raw, 1 = compressed)
1-2      Compression algorithm (00 = none, 01 = gzip, 10 = lz4, 11 = zstd)
3        Checksum present (0 = no CRC32, 1 = CRC32 in bytes 14-17)
4        Encryption enabled (0 = plaintext, 1 = encrypted)
5-15     Reserved (0 on write, ignored on read)
```

### Compression

Bit 0 set to 1 means the payload is compressed, and bits 1 and 2 name the algorithm:

| Bits 1-2 | Algorithm | Support in v1 |
|----------|-----------|---------------|
| `00` | none | not applicable |
| `01` | gzip | required |
| `10` | lz4 | optional |
| `11` | zstd | optional |

Every v1 implementation must support gzip. The lz4 and zstd values are reserved for later use, and a v1 reader that meets either must reject the file with a clear message.

With compression on, `payload_length` counts the compressed bytes. The reader decompresses the payload before it decodes MessagePack.

### Encryption

Bit 4 set to 1 means the payload is encrypted. Version 1 defines no encryption scheme, so a v1 reader that meets an encrypted payload must reject it with a clear message.

---

## Payload Format

The payload starts at byte 32 and is encoded as [MessagePack](https://msgpack.org/).

The `envelope_format_version` field in the header fixes the payload schema, and the storage key tells the reader which payload type to expect. Version 4 marks a [keyword segment payload](#keyword-segment-payload), and version 5 marks the [index configuration payload](#index-configuration-payload) that a [snapshot archive](durability.md#snapshot-archive) holds.

---

## Index Data

### Field Types

A schema maps each field path to its type name. A type name is a base type followed by its options, each after a colon, as in `string:sortable:pattern`:

| Base type | Options |
|-----------|---------|
| `string`, `string[]` | `sortable`, `pattern`, `partial` |
| `verbatim`, `verbatim[]` | `sortable` |
| `number`, `number[]`, `boolean`, `boolean[]`, `enum`, `enum[]`, `geopoint`, `vector[n]` | none |

An implementation must store and compare a `verbatim` value exactly as written, as one piece of text that it indexes for [pattern search](algorithms.md#pattern-search). A writer must store a field's options in the order of the table, whatever order the caller gives them in. An implementation must raise `SCHEMA_INVALID_TYPE` for an unknown base type, for an option outside its base type's row, and for an option written twice. It must raise that error both when a caller creates an index and wherever it reads a schema, because a reader that skips a field of an unknown type can save the index again without that field's data.

An implementation must raise `SCHEMA_INVALID_TYPE` for a schema that declares more than 65,536 `string` and `string[]` fields, because a posting in a [keyword segment](#keyword-segment-payload) stores its field as a 16-bit number.

An implementation must raise `SCHEMA_INVALID_VECTOR_DIMENSION` when a caller creates an index with a `vector[n]` whose `n` is not a whole number from 1 to 4,096, and wherever it reads a schema whose `n` is not a whole number from 1 to 65,535. A [vector file](#vector-file-payload) of 65,536 vectors of 4,096 dimensions stays inside the [file size](#file-size) limit at every code width, while a writer splits the vector files of a wider field from an [earlier release](durability.md#earlier-layouts) into smaller files.

### Documents

A document is a MessagePack map of field values, which may nest further maps. The engine stores each document as the caller inserted it. The [vector files](#vector-file-payload) of each vector field hold that field's values, so a writer must remove every value that the schema declares as a vector before it stores a document, and a reader must discard any vector value that it finds in a stored document. The field length of a text field in a document is the field's token count after analysis, which is the `|D|` of that field in [Multi-Field Scoring](algorithms.md#multi-field-scoring).

An implementation must raise `DOC_VALIDATION_FAILED` for a document whose ID, field names, or string values hold a surrogate code point, U+D800 to U+DFFF, because RFC 3629 defines UTF-8 only for the code points outside that range. It must raise `SEARCH_INVALID_FILTER` for filter text that holds one as well. In a UTF-16 string, such a code point is a surrogate unit outside a pair, because a pair of surrogate units encodes one code point above U+FFFF.

An implementation must raise `DOC_VALIDATION_FAILED` when a caller writes a document whose MessagePack encoding, vector values included, is longer than 16,777,216 bytes, so that a [keyword segment](#keyword-segment-payload) that holds the document alone stays inside the [file size](#file-size) limit.

An implementation must raise `DOC_VALIDATION_FAILED` for a document ID that is empty or longer than 512 UTF-16 code units, so that every line of a [document export](durability.md#document-export) stays inside the length that a reader must accept.

### Surface Forms

A surface form is the normalised but unstemmed spelling of an indexed token, exactly as the analyser produced it before stemming: lower-cased, possessives stripped, and diacritics handled as the language module requires. Surface forms let the engine answer suggestion and prefix queries with words that a reader recognises while the inverted index stays stemmed.

A writer records a surface only where stemming changed it, so a stored surface always differs from its token. A word that the stemmer left alone is already an index token, so a reader derives its occurrence count on demand by taking the token's total term frequency and subtracting the counts of the stored surfaces that map to it. A token's total term frequency is the sum of the term frequencies of its postings. A reader must skip any entry whose token equals its surface.

The occurrence count of a surface records how often the surface occurred across all indexed text in the segment. The engine drops an entry once its count reaches zero. It uses the counts only to choose between spellings that share an index token, so no score depends on them. A reader resolves a surface's document frequency at read time from the postings of its index token.

A writer stores surface forms only for an index that collects them, while the engine answers suggestion and prefix queries from the raw index terms where a segment holds none.

---

### Keyword Segment Payload

A keyword segment payload holds the documents of one segment of the [segmented checkpoint](durability.md#segmented-checkpoint), together with their keyword index and field indexes as flat arrays, so that a reader can load the segment without analysing its documents again. Its field names are camelCase.

A version 1 keyword segment payload is a MessagePack map:

```text
{
  v:                   uint8                      (1)
  schema:              Map<string, string>
  tombstones:          List<string>               (IDs of documents that this segment removes from older segments)
  documentCount:       uint32
  ids:                 bytes                      (each document ID in UTF-8, in ordinal order)
  idOffsets:           bytes                      (uint32, documentCount + 1 values)
  idOrder:             bytes                      (uint32 per document, the ordinals in ascending ID order)
  documents:           bytes                      (each document as a MessagePack map, in ordinal order)
  documentOffsets:     bytes                      (uint32, documentCount + 1 values)
  fieldNames:          List<string>
  tokens:              bytes                      (each token in UTF-8, in ascending order)
  tokenOffsets:        bytes                      (uint32, one value more than the token count)
  documentFrequencies: bytes                      (uint32 per token)
  postingOffsets:      bytes                      (uint32, one value more than the token count)
  postingDocuments:    bytes                      (uint32 per posting, an ordinal)
  postingFrequencies:  bytes                      (uint16 per posting)
  postingFields:       bytes                      (uint16 per posting, an index into fieldNames)
  positionOffsets:     bytes or nil               (uint32, one value more than the posting count)
  positions:           bytes or nil               (uint32 per position)
  fieldLengths:        List<FieldLengthColumn>
  numeric:             List<ValueColumn>
  sizes:               List<ValueColumn>
  boolean:             List<BooleanColumn>
  enum:                List<EnumColumn>
  geopoint:            List<GeopointColumn>
  pattern:             List<PatternColumn>
  surfaceForms:        SurfaceFormColumn or nil
  partialWords:        PartialWordColumn or nil
}

FieldLengthColumn {
  field:   string
  lengths: bytes   (uint32 per document, in ordinal order)
}

ValueColumn {
  field:     string
  documents: bytes   (uint32 per entry, an ordinal)
  values:    bytes   (float64 per entry, in ascending order)
}

BooleanColumn {
  field:          string
  trueDocuments:  bytes   (uint32 per entry, an ordinal)
  falseDocuments: bytes   (uint32 per entry, an ordinal)
}

EnumColumn {
  field:     string
  values:    List<string>
  offsets:   bytes   (uint32, one value more than the value count)
  documents: bytes   (uint32 per entry, an ordinal)
}

GeopointColumn {
  field:      string
  documents:  bytes   (uint32 per entry, an ordinal)
  latitudes:  bytes   (float64 per entry)
  longitudes: bytes   (float64 per entry)
}

PatternColumn {
  field:     string
  documents: bytes   (uint32 per entry, an ordinal, in ascending order)
  runs:      bytes   (uint32 per code point, three code points per run, runs in ascending order)
  offsets:   bytes   (uint32, one value more than the run count)
  postings:  bytes   (uint32 per entry, an ordinal, in ascending order within each run)
}

SurfaceFormColumn {
  text:    bytes   (for each entry, its surface and then its index token, in UTF-8)
  offsets: bytes   (uint32, two values per entry plus one)
  counts:  bytes   (uint32 per entry, its occurrence count)
}

PartialWordColumn {
  fields:     List<string>
  text:       bytes   (each written spelling in UTF-8)
  offsets:    bytes   (uint32, one value more than the entry count)
  tokens:     bytes   (uint32 per entry, an index into tokens)
  counts:     bytes   (uint32 per entry, its occurrence count)
  runs:       bytes   (uint32 per code point, three code points per run, runs in ascending order)
  runOffsets: bytes   (uint32, one value more than the run count)
  runEntries: bytes   (uint32 per member, an entry, in ascending order within each run)
}
```

Every number inside a `bytes` value is little-endian. An ordinal numbers a document of the segment, counting from 0 in the order of `ids`.

An offsets array divides a list into entries, so that entry `i` starts at value `i` and ends before value `i + 1`. Its first value must be 0, its values must never decrease, and its last value must equal the size of the list that it divides, counted in bytes for `ids`, `documents`, `tokens`, and `text`, and in values for every other list.

`tombstones` lists the IDs of the documents that this segment removes from the older segments of its partition. `schema` holds the schema of the segment's documents under the rules of [Field Types](#field-types). `idOrder` lists every ordinal once, in the order that sorts the IDs by code point. `documents` holds each document as [Documents](#documents) defines it, so a writer must leave every vector value out of it.

`tokens` holds each token of the segment once, sorted by code point, which matches the order of their UTF-8 bytes. Entry `t` of `postingOffsets` gives the postings of token `t`, which may name their documents in any order. Each posting names one document and one field and gives the token's term frequency in that field. `fieldNames` must hold at most 65,536 names. `documentFrequencies` holds the number of distinct documents among each token's postings. A writer must store a term frequency above 65,535 as 65,535. `positionOffsets` and `positions` are both nil where the index tracks no positions, and entry `p` of `positionOffsets` otherwise gives the positions of posting `p`, which number the token's places inside its field from zero for highlighting and phrase matching.

Each `FieldLengthColumn` holds, for every document, the field length of one text field as [Documents](#documents) defines it, with 0 for a document that holds no value in the field. `numeric` holds a `ValueColumn` for each `number` and `number[]` field, with one entry for each value of the field in each document. `sizes` holds a `ValueColumn` for each `string`, `verbatim`, and array field, with one entry for each document that holds a value in the field. The value of that entry is the length of the document's array, or 1 for a single string, or 0 for an empty string. Entry `v` of an `EnumColumn`'s `offsets` gives the documents that hold value `v` of its `values`, which must name each value once. Each `PatternColumn` holds the [pattern index](algorithms.md#pattern-index) of one pattern field. Its `documents` lists the documents that hold a value in the field. Entry `r` of its `offsets` gives the postings of run `r`, whose three code points `runs` holds from position `3r`. `surfaceForms` holds the [surface forms](#surface-forms) of the segment, and it is nil where the segment holds none.

`partialWords` holds the written spellings that [Partial-Word Search](algorithms.md#partial-word-search) matches. A writer must set it to nil only where the schema declares no `partial` field. Its `fields` lists the `partial` fields of the schema in code point order. Each entry gives a written spelling of more than three code points from those fields, the token of that spelling, and the number of times that the spelling occurs in those fields across the segment's documents. The entries must ascend strictly by spelling in code point order and then by token. Entry `r` of `runOffsets` gives the entries whose spelling holds run `r`, whose three code points `runs` holds from position `3r`.

Before it serves a query from the segment, a reader must raise `PERSISTENCE_LOAD_FAILED` for a `bytes` value whose length is not a whole number of its values, for an offsets array that breaks the rules above, for any column whose number of values differs from the count that the structure above gives it, and for `ids`, `tokens`, or `text` that is not valid UTF-8. It must raise the same error for an ordinal at or above `documentCount`, for a `postingFields` value at or above the length of `fieldNames`, for an `idOrder` that repeats an ordinal, and for a `documentFrequencies` value that is 0 or larger than its token's posting count. It must raise the same error where the tokens, the IDs taken in `idOrder` order, the runs of a `PatternColumn`, its `documents`, or the postings of one of its runs fail to ascend strictly, where an `EnumColumn` names a value twice, where a `ValueColumn`'s values descend or hold a NaN, where a `GeopointColumn` holds a latitude outside -90 to 90 or a longitude outside -180 to 180, and where exactly one of `positionOffsets` and `positions` is nil. It must raise the same error where a `PartialWordColumn` gives a token at or above the token count, a count of 0, or a `runEntries` value at or above its entry count, and where its entries, its runs, or the members of one of its runs fail to ascend strictly.

A reader may decode each document when it first reads the document, and it must raise `PERSISTENCE_LOAD_FAILED` where a document's bytes decode to anything other than a map. A node that restores a [snapshot archive](durability.md#snapshot-archive) must decode every document before it serves the index, because the archive can come from outside the node.

---

### Vector File Payload

A vector file payload holds at most 65,536 vectors of one vector field, and it is the payload of a vector file of the [segmented checkpoint](durability.md#segmented-checkpoint). Its field names are camelCase.

A version 1 vector file payload is a MessagePack map:

```text
{
  v:         uint8            (1)
  fieldName: string
  dimension: uint16
  docIds:    List<string>     (one per vector, in position order)
  codes:     OSQCodes or nil
  vectors:   bytes            (float32 components, dimension * 4 bytes per vector, in position order)
}

OSQCodes {
  bits:     uint8            (8, 4, 2, or 1)
  centroid: List<float32>
  records:  bytes            (one OSQRecord per vector, in position order)
}

OSQRecord = [
  code:       bytes,     (packed as Optimised Scalar Quantisation defines)
  lower:      float32,
  upper:      float32,
  correction: float32,
  sum:        uint32
]
```

A writer must set `codes`, with `bits` matching the mode, for an index that holds a graph under an `osq` mode, and it must write nil for every other index. Each `OSQRecord` holds its `code`, packed as [Optimised Scalar Quantisation (OSQ)](algorithms.md#optimised-scalar-quantisation-osq) defines in `ceiling(dimension * bits / 8)` bytes, followed by 16 bytes of `lower`, `upper`, `correction`, and `sum`. `records` holds the records one after another with no padding between them. Every number inside `vectors` and inside an `OSQRecord` is little-endian. A writer must write `vectors` as the last entry of the map with the compression flag at 0, so that a reader can find vector `i` at `payload_length - (count - i) * dimension * 4` bytes into the payload, where `count` is the length of `docIds`.

A writer may put fewer than 65,536 vectors in a file, and it must do so where a full file would pass the [file size](#file-size) limit.

A reader must recalibrate a field that holds a graph under an `osq` mode when any of its vector files has nil `codes`, or when two of them hold different `bits` or `centroid` values.

---

### Vector Graph Payload

A vector graph payload holds one part of the graphs of one vector field, and it is the payload of a graph part of the [segmented checkpoint](durability.md#segmented-checkpoint). Part `p` covers up to 16,384 vector numbers from `p * 16384` upwards, which are the numbers that the [manifest](durability.md#manifest) gives the vectors. Its field names are camelCase.

A version 2 vector graph payload is a MessagePack map:

```text
{
  v:         uint8                     (2)
  fieldName: string
  graphs:    List<NumberedHnswGraph>
}

NumberedHnswGraph {
  entryPoint:         uint32 or nil   (the number of the vector where every search starts)
  maxLayer:           uint8
  m:                  uint16
  efConstruction:     uint16
  metric:             string
  levels:             bytes           (one uint8 per vector that the part covers)
  neighbours:         bytes           (uint32 values, little-endian)
  shuffledBuildCount: uint32          (optional; the vector count at the last shuffled build)
}
```

Every part of a field must list the same graphs in the same order, with the same `entryPoint`, `maxLayer`, `m`, `efConstruction`, `metric`, and `shuffledBuildCount` for each graph. In every part but the last, each graph must hold 16,384 bytes of `levels`, and in the last part each graph must hold from 1 to 16,384 bytes. A field that holds a graph must have at least one part. A writer must give each vector a node in at most one graph. A reader must reject parts that break any of these rules with `PERSISTENCE_LOAD_FAILED`.

Byte `i` of `levels` in part `p` describes vector `p * 16384 + i`, and it must hold 0 where the graph has no node for that vector and the node's top layer plus 1 otherwise. A vector whose number lies beyond the last part has no node.

`neighbours` must hold the nodes of the part in number order. For each node it must hold one list per layer, from layer 0 to the node's top layer, and each list is a count followed by that many vector numbers, any of which may lie in another part.

`shuffledBuildCount` is the number of vectors that the graph held when the implementation last built it from every vector in a shuffled order, as [Insertion Order](vector-index.md#insertion-order) requires. A writer must write the field only for a graph that it has built in that way. When a reader finds no `shuffledBuildCount` on a graph, it must treat the graph as one that an earlier release built in the order that its vectors arrived.

At the largest `m` of 512 and the highest top layer of 32 that [HNSW](algorithms.md#hnsw-hierarchical-navigable-small-world) allows, the lists of one node fill at most 69,765 bytes, so a part of 16,384 vectors holds at most about 1.14 GB and stays inside the [file size](#file-size) limit.

A reader must skip a neighbour that is a vector with no node or a node whose top layer lies below the layer of the list. A reader must reject a payload whose `neighbours` ends inside a list with `PERSISTENCE_LOAD_FAILED`. Where `entryPoint` is nil or is a vector with no node, a reader must start every search from a node on the graph's highest layer.

---

### Index Metadata Payload

Each index writes a metadata envelope under the key `<indexName>/meta`. It uses the same 32-byte header with a different payload:

```text
{
  index_name:            string
  schema:                Map<string, string>
  language:              string
  partition_count:       uint32
  document_count:        uint64               (optional; documents in the last completed checkpoint)
  bm25_params:           { k1: float32, b: float32 }
  created_at:            uint64               (milliseconds since the Unix epoch)
  engine_version:        string               (for example "0.1.0")
  vector_fields:         Map<string, VectorFieldMeta>
  embedding:             EmbeddingMeta        (optional)
  surface_forms_enabled: boolean              (optional)
  analysis_revision:     string               (optional; the language module revision)
  tokenizer:             string               (optional; the registered tokeniser name)
  stop_words:            string               (optional; the registered stop word set name)
  stop_word_list:        List<string>         (optional; the words of a literal stop word set)
  partition_limits:      PartitionLimits      (optional)
  default_scoring:       string               (optional; "local", "dfs", or "broadcast")
  track_positions:       boolean              (optional)
  strict:                boolean              (optional)
  required:              List<string>         (optional; field paths every document must supply)
  vector_promotion:      VectorPromotionMeta  (optional)
  pattern_value_limit:   uint32               (optional; the most code points a pattern field value may hold)
  index_uuid:            string               (optional; the cluster identity of the index)
  held_partitions:       List<uint32>         (optional; the partitions of the index this copy holds)
}

VectorFieldMeta {
  dimension:    uint16
  metric:       string
  quantization: string
}

EmbeddingMeta {
  adapter: string  (optional; the name the adapter was registered under)
  fields:  Map<string, string or List<string>>
}

PartitionLimits {
  max_docs_per_partition: uint32   (optional)
  max_partitions:         uint32   (optional)
  watermark:              float64  (optional)
}

VectorPromotionMeta {
  threshold:        uint32                                                  (optional)
  filter_threshold: float64                                                 (optional; a selectivity ratio between 0 and 1)
  hnsw_config:      { m: uint32, ef_construction: uint32, metric: string }  (optional; each key optional)
  quantization:     string                                                  (optional; "osq8", "osq4", "osq2", "osq1", or "none")
  storage:          string                                                  (optional; "memory" or "disk")
}
```

`document_count` must equal the total number of documents in the last completed checkpoint. A reader must treat an absent `document_count` as unknown.

`vector_fields` lists every vector field with its configuration, so the engine knows which vector index files to load without scanning the storage keys. A reader must reject a `quantization` or `storage` value outside its set with `CONFIG_INVALID`, in this payload and in the [index configuration payload](#index-configuration-payload).

The `embedding` block records the index's automatic embedding configuration: the field mappings defined in [Embedding Configuration](adapters.md#embedding-configuration), and the name the embedding adapter was registered under. The block is additive, so a reader that skips it treats the index as having no automatic embedding, which is exactly how every metadata payload written before the block existed behaves. The `adapter` name appears only when the index was created with a named adapter, because an adapter instance holds live resources and cannot be serialised. Recovery uses the name to rebind the adapter from the engine's registry; see [Index Metadata](durability.md#index-metadata).

The `surface_forms_enabled` field records whether the index collects surface forms, as described in [Surface Forms](#surface-forms). A writer always includes it, and a reader treats an absent field as off, matching every metadata payload written before the field existed. Recovery reads the value so that the index keeps its setting after a restart.

The `analysis_revision` field records the [revision](adapters.md#revision) of the language module that produced the index's terms. A reader compares it with the revision that its own module for that language carries. A difference means the engine no longer analyses text the way the index was built, so the index's terms are stale, and the engine rebuilds them from the documents that the index's segments hold. An engine may answer a text query while that rebuild is outstanding, and it tells the caller the terms are stale when it does, because a term the current analysis produces differently reaches none of the postings that the earlier analysis wrote. When the rebuild runs, whether the engine starts it on its own, and how it reports both the stale terms and the rebuild, are matters for the engine's configuration. The field is additive, and a reader that finds it absent treats the terms as stale too, because an index written before the field existed records nothing about the analysis that built it. A writer must leave the field absent where it knows no revision for the terms that it writes, such as for an index that it restores without the field and has yet to rebuild. Vector data and embeddings are unaffected, because the revision covers text analysis alone.

The `tokenizer` and `stop_words` fields record the names the index resolved its analysis from, as described in [Analysis Registry](adapters.md#analysis-registry). A writer includes each field only when the index configuration gave a name, because a tokeniser instance and a stop word function are code and no payload carries code. An engine with durability configured refuses an index whose analysis is given as code, as [Analysis Registry](adapters.md#analysis-registry) requires, so an absent field means the index analyses with the language default. An index configured with a literal stop word set persists the words themselves in `stop_word_list`, and a payload carries at most one of `stop_words` and `stop_word_list`. Recovery resolves each name against the engine's analysis registry so that a recovered index analyses text the way the original did; see [Index Metadata](durability.md#index-metadata).

The `partition_limits`, `default_scoring`, `track_positions`, `strict`, `required`, `vector_promotion`, and `pattern_value_limit` fields record the rest of the index configuration: the partition limits, the scoring mode, position tracking, strict document validation, the required field paths, the vector promotion settings, and the [pattern value limit](algorithms.md#pattern-search). All seven are additive. A writer includes each field only when the index configuration sets it, and a reader treats an absent field as that option's default, so a recovered index behaves exactly as the original did.

The `index_uuid` field records the identity a cluster assigned the index when it was created, as [Index Metadata](distribution/cluster.md#index-metadata) defines it. A node running in cluster mode writes the value, and a single engine leaves it absent. A rejoining node compares the recovered value with the one the coordinator holds before it adopts the index, so the node never serves a predecessor's documents from an index created again under the same name; see [Joining the Cluster](distribution/cluster.md#joining-the-cluster). The field is additive, and a reader that finds it absent treats the index as belonging to no cluster.

The `held_partitions` field records the partitions of the index this copy holds, so that the node can name what it stored when the controller looks for a partition in `UNASSIGNED`. A node must add a partition to the list when it finishes bootstrapping that partition. It must remove a partition from the list when it deletes that partition's copy. A partition that holds no document must still appear in the list, because a controller reading a document count would treat an empty partition as one the node lost. A node must answer [cluster.partition_stores](distribution/transport.md#clusterpartition_stores) from this field. The field is additive, and a node that finds it absent must answer from the partitions whose document count is above zero, because an index written before the field existed records nothing about what it holds.

---

### Index Configuration Payload

An index configuration payload records the configuration of one index, so that the restore operation can create the index from a [snapshot archive](durability.md#snapshot-archive) with the configuration that it had. A writer must set `envelope_format_version` to 5 and must set the checksum flag. Its field names are camelCase.

An implementation must raise `CONFIG_INVALID` when a caller creates an index whose configuration payload is longer than 16,777,216 bytes, the size of the longest document that [Documents](#documents) allows, so that the header of a [document export](durability.md#document-export) stays inside the line length that a reader must accept.

The payload is a MessagePack map:

```text
{
  schema:            Map<string, string>
  language:          string
  analysisRevision:  string                       (optional; the language module revision)
  tokenizer:         string                       (optional; the registered tokeniser name)
  stopWords:         string                       (optional; the registered stop word set name)
  stopWordList:      List<string>                 (optional; the words of a literal stop word set)
  bm25:              { k1: float32, b: float32 }  (optional; each key optional)
  surfaceForms:      boolean                      (a reader treats an absent value as true)
  partitionConfig:   PartitionSnapshotLimits      (optional)
  defaultScoring:    string                       (optional; "local", "dfs", or "broadcast")
  trackPositions:    boolean                      (optional)
  strict:            boolean                      (optional)
  required:          List<string>                 (optional; field paths every document must supply)
  vectorPromotion:   VectorSnapshotPromotion      (optional)
  patternValueLimit: uint32                       (optional; the most code points a pattern field value may hold)
  embedding:         EmbeddingSnapshotConfig      (optional)
}

PartitionSnapshotLimits {
  maxDocsPerPartition: uint32   (optional)
  maxPartitions:       uint32   (optional)
  watermark:           float64  (optional)
}

VectorSnapshotPromotion {
  threshold:       uint32                                                 (optional)
  filterThreshold: float64                                                (optional; a selectivity ratio between 0 and 1)
  hnswConfig:      { m: uint32, efConstruction: uint32, metric: string }  (optional; each key optional)
  quantization:    string                                                 (optional; "osq8", "osq4", "osq2", "osq1", or "none")
  storage:         string                                                 (optional; "memory" or "disk")
}

EmbeddingSnapshotConfig {
  adapter: string                                (optional; the name the adapter was registered under)
  fields:  Map<string, string or List<string>>
}
```

The rules for `analysis_revision` in the [index metadata payload](#index-metadata-payload) apply to `analysisRevision`, so a writer must record the revision that produced the terms that the envelope holds, or leave the field absent where it knows none. A reader must treat an index restored without one as holding stale terms. Each remaining optional field records one index configuration option, and a writer must leave it absent where the configuration leaves that option unset.

A writer must reject an index whose tokeniser or stop words are code, because a payload can hold a registered name but no code.

A reader must reject an index configuration envelope whose `envelope_format_version` is not 5 with `ENVELOPE_VERSION_MISMATCH`.

---

## Storage Path Convention

A persistence adapter addresses stored bytes by string key:

| Key | Content |
|-----|---------|
| `<indexName>/meta` | Index metadata |
| `<indexName>/manifest` | Checkpoint segment manifest |
| `<indexName>/segments/<partitionId>/s<segmentId>` | One checkpoint segment, id zero-padded to 16 digits |
| `<indexName>/segments/vec-<fieldPath>-f<fileId>` | One vector file of one vector field for the whole index, file id zero-padded to 16 digits |
| `<indexName>/segments/vec-<fieldPath>-graph-g<generation>-p<part>` | One graph part of one vector field for the whole index at one generation, part number zero-padded to 16 digits |
| `<indexName>/wal/<partitionId>/<startSeqNo>` | Write-ahead log segment, start sequence number zero-padded to 16 digits |
| `<indexName>/wal/<partitionId>/commit` | Write-ahead log commit marker |

A filesystem adapter maps each key to a file path, so an index named `products` produces `data/products/meta`, `data/products/manifest`, and `data/products/segments/0/s0000000000000003`. The segmented keys are defined in [Segmented Checkpoint](durability.md#segmented-checkpoint).

---

## Version Compatibility Rules

These rules take effect at Narsil 1.0, and every implementation must follow them from then on. Before 1.0, each release must open and upgrade the layout of the release before it, as [Earlier Layouts](durability.md#earlier-layouts) defines, and a reader must reject any older layout with `ENVELOPE_VERSION_MISMATCH`.

1. **Keep a deserialiser for every envelope format version ever released.** A v3 deserialiser still handles v1 and v2 payloads by filling in defaults for the fields those versions lack. An old deserialiser is never removed.

2. **Adding an optional field** is a minor version increase, from v1.0 to v1.1. Existing deserialisers ignore fields they do not know, which MessagePack supports directly because it preserves unknown keys.

3. **Removing or renaming a field** is a major version increase, from v1 to v2, and the new deserialiser joins the existing one instead of replacing it.

4. **Newer code reading an older envelope always works.** The newer deserialiser fills in defaults for every field added after the version it is reading.

5. **Older code reading a newer major version must reject the file** with a clear message, such as: 'This data was written by Narsil envelope format vN and requires Narsil >= X.Y.Z. You are running A.B.C.' Use the `ENVELOPE_VERSION_MISMATCH` error code.

6. **A file written by one implementation must be readable by every other**, in either direction, as long as both support the envelope format version named in the header.
