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

The byte count of the payload that follows the header. A reader must read exactly that many bytes starting at offset 32.

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

The `envelope_format_version` field in the header fixes the payload schema, and the storage key tells the reader which payload type to expect: a partition, a vector index, or index metadata.

---

## Envelope Format Version 1

### Partition Payload

Each partition is written as its own `.nrsl` file holding text and field index data. Vector data goes into separate vector index files; see [Vector Index Payload](#vector-index-payload).

A version 1 partition payload is a MessagePack map:

```text
{
  index_name:       string
  partition_id:     uint32
  total_partitions: uint32
  language:         string
  schema:           Map<string, string>
  doc_count:        uint32
  avg_doc_length:   float32
  documents:        Map<string, Document>
  inverted_index:   Map<string, PostingList>
  field_indexes:    FieldIndexes
  surface_forms:    Map<string, SurfaceForm>   (optional, added in v1.1)
  vector_data:      Map<string, VectorData>    (optional)
  statistics:       Statistics
}
```

### Documents

`documents` maps a document ID to a `Document`:

```text
Document {
  fields:        Map<string, value>
  field_lengths: Map<string, uint16>
}
```

`fields` holds the raw field values keyed by field name, and a nested object uses a dot-separated key such as `author.name`. A vector field value never appears in `fields`, because it is held in the vector index file for that field. `field_lengths` holds the token count of each text field after analysis, which BM25 scoring reads.

### Inverted Index

`inverted_index` maps a token to a `PostingList`:

```text
PostingList {
  doc_freq: uint32
  postings: List<Posting>
}

Posting {
  doc_id:    string
  term_freq: uint16
  field:     string
  positions: List<uint16>
}
```

`doc_freq` is the number of documents in this partition that contain the token. `postings` holds one entry per document-and-field pair containing it. `positions` holds the token positions inside that field, numbered from zero, which highlighting and phrase matching read.

### Field Indexes

```text
FieldIndexes {
  numeric:  Map<string, List<NumericEntry>>
  boolean:  Map<string, BooleanIndex>
  enum:     Map<string, Map<string, List<string>>>
  geopoint: Map<string, List<GeopointEntry>>
}

NumericEntry {
  value:  float64
  doc_id: string
}

BooleanIndex {
  true_docs:  List<string>
  false_docs: List<string>
}

GeopointEntry {
  lat:    float64
  lon:    float64
  doc_id: string
}
```

Numeric entries are stored in ascending order of `value`, so a reader can binary-search them straight after decoding.

### Surface Forms

A surface form is the normalised but unstemmed spelling of an indexed token, exactly as the analyser produced it before stemming: lower-cased, possessives stripped, and diacritics handled as the language module requires. The `surface_forms` map lets the engine answer suggestion and prefix queries with words a reader recognises while the inverted index stays stemmed.

```text
SurfaceForm = [uint32, string]        [occurrence_count, index_token]
```

A writer records a surface only when stemming changed it, so a stored surface always differs from its token. A word the stemmer left alone is already an index token, and a reader derives its occurrence count on demand by taking the token's total term frequency and subtracting the counts of the stored surfaces that map to it. A token's total term frequency is the sum of the `term_freq` values in its posting list. A reader must skip any entry whose value is not a two-element array of that shape, and any entry whose token equals its surface.

`occurrence_count` records how often the surface occurred across all indexed text in the partition. The engine drops an entry once its count reaches zero, and it uses the counts only to choose between spellings that share an index token. Scoring ignores them. A reader resolves a surface's document frequency at read time from the posting list of its index token.

The field is optional, added in envelope format v1.1, and only an index configured to collect surface forms writes it. A reader treats an absent field as an empty map, and suggestion and prefix queries then fall back to the raw index terms.

### Statistics

```text
Statistics {
  total_documents:       uint32
  total_field_lengths:   Map<string, uint64>
  average_field_lengths: Map<string, float32>
  doc_frequencies:       Map<string, uint32>
}
```

`doc_frequencies` holds the per-token document frequency across this partition. Persisting it lets DFS and broadcast scoring work straight after a reload with nothing to recompute.

### Vector Data

`vector_data` embeds the partition's vectors in the payload, keyed by field path. The field is optional: a writer includes it when the payload must carry its vectors with it, such as a partition sent to another thread for an off-thread graph build, and a durable checkpoint leaves it out because the checkpoint stores vectors in the [vector index payload](#vector-index-payload) instead.

```text
VectorData {
  dimension:  uint16
  vectors:    List<EmbeddedVectorEntry>
  hnsw_graph: EmbeddedHnswGraph or nil
  sq8:        EmbeddedSQ8Data or absent
}

EmbeddedVectorEntry {
  doc_id: string
  vector: List<float32>
}

EmbeddedHnswGraph {
  entry_point:     string or nil
  max_layer:       uint8
  m:               uint8
  ef_construction: uint16
  metric:          string or absent
  nodes:           List<HnswNode>
}

EmbeddedSQ8Data {
  alpha:             float32
  offset:            float32
  quantized_vectors: Map<string, List<uint8>>
  vector_sums:       Map<string, float32>
  vector_sum_sqs:    Map<string, float32>
}
```

`HnswNode` is defined under [Vector Index Payload](#vector-index-payload). The embedded form carries at most one graph per field, and a reader treats an unrecognised `metric` value as absent.

---

### Version 2 Partition Payload

A version 2 partition payload is the columnar form of the same partition data, and it is what the durability checkpoint writes inside the snapshot bundle and the checkpoint segment files. It differs from version 1 in three ways: a `v` discriminator, posting lists stored as parallel columns, and field names interned into one shared list.

```text
{
  v:                uint8                      (2)
  index_name:       string
  partition_id:     uint32
  total_partitions: uint32
  language:         string
  schema:           Map<string, string>
  doc_count:        uint32
  avg_doc_length:   float32
  documents:        Map<string, Document>
  inverted_index:   ColumnarInvertedIndex
  field_indexes:    FieldIndexes
  surface_forms:    Map<string, SurfaceForm>   (optional)
  vector_data:      Map<string, VectorData>    (optional)
  statistics:       Statistics
}

ColumnarInvertedIndex {
  field_names: List<string>
  entries:     Map<string, ColumnarPostingList>
}

ColumnarPostingList {
  df:  uint32                     (document frequency)
  ids: List<string>               (document IDs, one per posting)
  tf:  List<uint16>               (term frequencies)
  fi:  bytes                      (indexes into field_names, one byte per posting)
  pos: List<List<uint16>> or nil  (positions per posting, nil when untracked)
}
```

Every other field keeps its version 1 meaning. The four posting columns are aligned: entry `i` of `ids`, `tf`, `fi`, and `pos` together describe one posting, and `fi` holds a byte offset into `field_names`, so a posting stores one byte where version 1 repeated the field name.

---

### Vector Index Payload

A vector index payload holds one vector field's full state. It appears in two places: as a value in the snapshot bundle's `vectorIndexes` map, and as the payload of a vector segment file under the [checkpoint segment keys](durability.md#segmented-checkpoint). Unlike every other payload, its field names are camelCase, because it is the one payload written without a snake_case translation layer; see [Serialisation](vector-index.md#serialisation).

A version 1 vector index payload is a MessagePack map:

```text
{
  fieldName: string
  dimension: uint16
  vectors:   List<VectorEntry>
  graphs:    List<HnswGraph>
  sq8:       SQ8Data or nil
}

VectorEntry {
  docId:  string
  vector: List<float32>
}

HnswGraph {
  entryPoint:     string or nil
  maxLayer:       uint8
  m:              uint8
  efConstruction: uint16
  metric:         string or absent
  nodes:          List<HnswNode>
}

HnswNode = [
  doc_id:      string,
  layer:       uint8,
  connections: List<[
    layer_index:  uint8,
    neighbor_ids: List<string>
  ]>
]

SQ8Data {
  alpha:            float32
  offset:           float32
  quantizedVectors: Map<string, List<uint8>>
  vectorSums:       Map<string, float32>
  vectorSumSqs:     Map<string, float32>
}
```

`graphs` is a list. An implementation holding one graph writes a list of length 1, and a segment-based implementation writes one graph per segment. The `vectors` list stays flat, with one entry per document whatever the graph count, and graphs reference vectors by `docId`.

An empty `graphs` list means the implementation searches by brute force, because the vector count has not reached the promotion threshold.

---

### Index Metadata Payload

Each index writes a metadata envelope under the key `<indexName>/meta`. It uses the same 32-byte header with a different payload:

```text
{
  index_name:            string
  schema:                Map<string, string>
  language:              string
  partition_count:       uint32
  bm25_params:           { k1: float32, b: float32 }
  created_at:            uint64               (milliseconds since the Unix epoch)
  engine_version:        string               (for example "0.1.0")
  vector_fields:         Map<string, VectorFieldMeta>
  embedding:             EmbeddingMeta        (optional)
  surface_forms_enabled: boolean              (optional)
  tokenizer:             string               (optional; the registered tokeniser name)
  stop_words:            string               (optional; the registered stop word set name)
  stop_word_list:        List<string>         (optional; the words of a literal stop word set)
  partition_limits:      PartitionLimits      (optional)
  default_scoring:       string               (optional; "local", "dfs", or "broadcast")
  track_positions:       boolean              (optional)
  strict:                boolean              (optional)
  required:              List<string>         (optional; field paths every document must supply)
  vector_promotion:      VectorPromotionMeta  (optional)
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
  max_docs_per_partition: uint32  (optional)
  max_partitions:         uint32  (optional)
}

VectorPromotionMeta {
  threshold:        uint32                                                  (optional)
  filter_threshold: uint32                                                  (optional)
  hnsw_config:      { m: uint32, ef_construction: uint32, metric: string }  (optional; each key optional)
  quantization:     string                                                  (optional; "sq8" or "none")
}
```

`vector_fields` lists every vector field with its configuration, so the engine knows which vector index files to load without scanning the storage keys.

The `embedding` block records the index's automatic embedding configuration: the field mappings defined in [Embedding Configuration](adapters.md#embedding-configuration), and the name the embedding adapter was registered under. The block is additive, so a reader that skips it treats the index as having no automatic embedding, which is exactly how every metadata payload written before the block existed behaves. The `adapter` name appears only when the index was created with a named adapter, because an adapter instance holds live resources and cannot be serialised. Recovery uses the name to rebind the adapter from the engine's registry; see [Index Metadata](durability.md#index-metadata).

The `surface_forms_enabled` field records that the index collects surface forms, as described in [Surface Forms](#surface-forms). A writer includes it only when collection is on, and a reader treats an absent field as off, matching every metadata payload written before the field existed. Recovery reads the value so that the index keeps collecting surfaces after a restart.

The `tokenizer` and `stop_words` fields record the names the index resolved its analysis from, as described in [Analysis Registry](adapters.md#analysis-registry). A writer includes each field only when the index configuration gave a name, because a tokeniser instance and a stop word function are code and no payload carries code. An engine with durability configured refuses an index whose analysis is given as code, as [Analysis Registry](adapters.md#analysis-registry) requires, so an absent field means the index analyses with the language default. An index configured with a literal stop word set persists the words themselves in `stop_word_list`, and a payload carries at most one of `stop_words` and `stop_word_list`. Recovery resolves each name against the engine's analysis registry so that a recovered index analyses text the way the original did; see [Index Metadata](durability.md#index-metadata).

The last six fields record the rest of the index configuration: the partition limits, the scoring mode, position tracking, strict document validation, the required field paths, and the vector promotion settings. All six are additive. A writer includes each field only when the index configuration set it, and a reader treats an absent field as that option's default, so a recovered index behaves exactly as the original did.

---

### Snapshot Bundle Payload

The snapshot-only persistence tier writes the whole index as one envelope under the key `<indexName>/snapshot`, and the write-ahead log tier reads that key as a legacy fallback. The envelope uses the same 32-byte header with the checksum flag set, and the payload is the snapshot bundle described in [Snapshot Checkpoint Format](durability.md#snapshot-checkpoint-format).

```text
{
  version:        uint8         (1)
  schema:         Map<string, string>
  language:       string
  tokenizer:      string        (optional; the registered tokeniser name)
  stop_words:     string        (optional; the registered stop word set name)
  stop_word_list: List<string>  (optional; the words of a literal stop word set)
  partitions:     List<bytes>   (one version 2 partition payload per entry)
  vectorIndexes:  Map<string, VectorIndexPayload>
  checkpoint:     List<PartitionCheckpoint>
}

PartitionCheckpoint {
  partitionId: uint32
  lastSeqNo:   uint64   (the highest write-ahead log seqNo this snapshot contains)
  primaryTerm: uint64
}
```

The bundle differs from the per-partition payload above: it carries every partition in one envelope, so a checkpoint replaces the whole index atomically. `checkpoint` records where write-ahead log replay resumes for each partition. It is additive, and a reader that skips it treats every `lastSeqNo` as 0. `tokenizer`, `stop_words`, and `stop_word_list` are additive too: they carry the same analysis as the index metadata payload, and a reader recreates the index with them, resolving each name as [Index Metadata](durability.md#index-metadata) describes. The log format, the recovery procedure, and the checkpoint rules are in [durability.md](durability.md).

---

## Storage Path Convention

A persistence adapter addresses stored bytes by string key:

| Key | Content |
|-----|---------|
| `<indexName>/meta` | Index metadata |
| `<indexName>/manifest` | Checkpoint segment manifest |
| `<indexName>/segments/<partitionId>/s<segmentId>` | One checkpoint segment, id zero-padded to 16 digits |
| `<indexName>/segments/<partitionId>/vec-<fieldPath>-g<generation>` | One vector field's index at one generation |
| `<indexName>/snapshot` | Whole-index checkpoint bundle, written by the snapshot-only tier and read as a legacy fallback |
| `<indexName>/wal/<partitionId>/<startSeqNo>` | Write-ahead log segment, start sequence number zero-padded to 16 digits |
| `<indexName>/wal/<partitionId>/commit` | Write-ahead log commit marker |

A filesystem adapter maps each key to a file path, so an index named `products` produces `data/products/meta`, `data/products/manifest`, and `data/products/segments/0/s0000000000000003`. The segmented keys are defined in [Segmented Checkpoint](durability.md#segmented-checkpoint).

---

## Version Compatibility Rules

These rules are permanent, and every implementation must follow them.

1. **Keep a deserialiser for every envelope format version ever released.** A v3 deserialiser still handles v1 and v2 payloads by filling in defaults for the fields those versions lack. An old deserialiser is never removed.

2. **Adding an optional field** is a minor version increase, from v1.0 to v1.1. Existing deserialisers ignore fields they do not know, which MessagePack supports directly because it preserves unknown keys.

3. **Removing or renaming a field** is a major version increase, from v1 to v2, and the new deserialiser joins the existing one instead of replacing it.

4. **Newer code reading an older envelope always works.** The newer deserialiser fills in defaults for every field added after the version it is reading.

5. **Older code reading a newer major version must reject the file** with a clear message, such as: 'This data was written by Narsil envelope format vN and requires Narsil >= X.Y.Z. You are running A.B.C.' Use the `ENVELOPE_VERSION_MISMATCH` error code.

6. **A file written by one implementation must be readable by every other**, in either direction, as long as both support the envelope format version named in the header.
