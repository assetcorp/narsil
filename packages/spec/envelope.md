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

The `envelope_format_version` field in the header fixes the payload schema, and the storage key tells the reader which payload type to expect: a partition, a vector index, or index metadata. Version 3 marks the [index snapshot payload](#index-snapshot-payload), which the engine's snapshot operation returns to the caller instead of writing under a storage key.

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

`fields` holds the raw field values keyed by field name, and a nested object uses a dot-separated key such as `author.name`. A vector field value never appears in `fields`, because it is held in the vector index file for that field. A writer must remove every value the schema declares as a vector before it encodes a document. A reader must discard any vector value it finds in `fields`, because an earlier writer may have stored one there. `field_lengths` holds the token count of each text field after analysis, which BM25 scoring reads.

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
  codes:      OSQCodes or absent
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
```

[Vector Index Payload](#vector-index-payload) defines `HnswNode` and `OSQCodes`, whose records follow the order of `vectors`. The embedded form carries at most one graph per field, and a reader treats an unrecognised `metric` value as absent.

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

A vector index payload holds one part of one vector field's state, and a field spans `parts` payloads of at most 65,536 vectors each, in ordinal order. It appears as an entry of the `vectorIndexes` lists of the [snapshot bundle](#snapshot-bundle-payload) and of the [index snapshot](#index-snapshot-payload). Its field names are camelCase, because an implementation writes it without a snake_case translation layer; see [Serialisation](vector-index.md#serialisation).

A version 3 vector index payload is a MessagePack map:

```text
{
  v:         uint8            (3)
  fieldName: string
  dimension: uint16
  part:      uint32           (this payload's position in the field, from 0)
  parts:     uint32           (payloads in the field)
  docIds:    List<string>     (one per vector in this part, in ordinal order)
  graphs:    List<HnswGraph>
  codes:     OSQCodes or nil
  vectors:   bytes            (float32 components, dimension * 4 bytes per vector, in ordinal order)
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

OSQCodes {
  bits:     uint8            (8, 4, 2, or 1)
  centroid: List<float32>
  records:  bytes            (one record per vector in this part, in ordinal order)
}

OSQRecord = [
  code:       bytes,     (packed as Optimised Scalar Quantisation defines)
  lower:      float32,
  upper:      float32,
  correction: float32,
  sum:        uint32
]
```

Vector `i` of part `p` has ordinal `p * 65536 + i`, and a field with no vectors has one part holding none. Every number inside `vectors` and inside an `OSQRecord` is little-endian. A writer must write `vectors` as the last entry of the map with the compression flag at 0, so that a reader finds vector `i` of a part at `payload_length - (count - i) * dimension * 4` bytes into the payload, where `count` is the length of `docIds`.

`graphs` lists the field's graphs in the same order in every part, each repeating its header and holding in `nodes` the nodes of this part's vectors alone, so a reader assembles each graph from every part. An implementation holding one graph writes a list of length 1, and a segment-based implementation writes one graph per segment. An empty `graphs` list means the implementation searches by brute force, because the vector count stays below the promotion threshold.

A writer must set `codes`, with `bits` matching the mode, for an index that holds a graph under an `osq` mode, and it must write nil for every other index. `records` holds one `OSQRecord` per vector, whose `code` is packed as [Optimised Scalar Quantisation (OSQ)](algorithms.md#optimised-scalar-quantisation-osq) defines and takes `ceiling(dimension * bits / 8)` bytes, followed by 16 bytes of `lower`, `upper`, `correction`, and `sum`.

---

### Vector File Payload

A vector file payload holds at most 65,536 vectors of one vector field, and it is the payload of a vector file of the [segmented checkpoint](durability.md#segmented-checkpoint). Its field names are camelCase, as in the [vector index payload](#vector-index-payload).

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
```

`OSQCodes` keeps the layout that the vector index payload defines, with one record per vector of the file in position order. A writer must set `codes` by the rule that the vector index payload sets, and it must write `vectors` as the last entry of the map with the compression flag at 0 and every number little-endian. A reader therefore finds vector `i` at `payload_length - (count - i) * dimension * 4` bytes into the payload, where `count` is the length of `docIds`.

A reader must recalibrate a field that holds a graph under an `osq` mode when any of its vector files has nil `codes`, or when two of them disagree on `bits` or on `centroid`.

---

### Vector Graph Payload

A vector graph payload holds the graphs of one vector field, and it is the payload of a graph file of the [segmented checkpoint](durability.md#segmented-checkpoint). It names each vector by the number that the [manifest](durability.md#manifest) gives the vector. Its field names are camelCase, as in the [vector index payload](#vector-index-payload).

A version 1 vector graph payload is a MessagePack map:

```text
{
  v:         uint8                     (1)
  fieldName: string
  graphs:    List<NumberedHnswGraph>
}

NumberedHnswGraph {
  entryPoint:     uint32 or nil   (the number of the vector where every search starts)
  maxLayer:       uint8
  m:              uint16
  efConstruction: uint16
  metric:         string
  levels:         bytes           (one uint8 per vector number)
  neighbours:     bytes           (uint32 values, little-endian)
}
```

Byte `n` of `levels` must hold 0 where the graph has no node for vector `n`, and the node's top layer plus 1 otherwise. A vector whose number lies beyond the end of `levels` has no node.

`neighbours` must hold the nodes in number order. For each node it must hold one list per layer, from layer 0 to the node's top layer, and each list is a count followed by that many vector numbers.

A reader must skip a neighbour that is a dead vector, a vector with no node, or a node whose top layer lies below the layer of the list. A reader must reject a payload whose `neighbours` ends inside a list with `PERSISTENCE_LOAD_FAILED`. Where `entryPoint` is nil or is a vector with no node, a reader must start every search from a node on the graph's highest layer.

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

`vector_fields` lists every vector field with its configuration, so the engine knows which vector index files to load without scanning the storage keys. A reader must reject a `quantization` or `storage` value outside its set with `CONFIG_INVALID`, in this payload and in the [index snapshot payload](#index-snapshot-payload).

The `embedding` block records the index's automatic embedding configuration: the field mappings defined in [Embedding Configuration](adapters.md#embedding-configuration), and the name the embedding adapter was registered under. The block is additive, so a reader that skips it treats the index as having no automatic embedding, which is exactly how every metadata payload written before the block existed behaves. The `adapter` name appears only when the index was created with a named adapter, because an adapter instance holds live resources and cannot be serialised. Recovery uses the name to rebind the adapter from the engine's registry; see [Index Metadata](durability.md#index-metadata).

The `surface_forms_enabled` field records whether the index collects surface forms, as described in [Surface Forms](#surface-forms). A writer always includes it, and a reader treats an absent field as off, matching every metadata payload written before the field existed. Recovery reads the value so that the index keeps its setting after a restart.

The `analysis_revision` field records the [revision](adapters.md#revision) of the language module the index was written with. A reader compares it with the revision its own module for that language carries. A difference means the engine no longer analyses text the way the index was built, so the index's terms are stale, and the engine rebuilds them from the documents the partition payloads carry. An engine may answer a text query while that rebuild is outstanding, and it tells the caller the terms are stale when it does, because a term the current analysis produces differently reaches none of the postings the earlier analysis wrote. When the rebuild runs, whether the engine starts it on its own, and how it reports both the stale terms and the rebuild, are matters for the engine's configuration. The field is additive, and a reader that finds it absent treats the terms as stale too, because an index written before the field existed records nothing about the analysis that built it. Vector data and embeddings are unaffected, because the revision covers text analysis alone.

The `tokenizer` and `stop_words` fields record the names the index resolved its analysis from, as described in [Analysis Registry](adapters.md#analysis-registry). A writer includes each field only when the index configuration gave a name, because a tokeniser instance and a stop word function are code and no payload carries code. An engine with durability configured refuses an index whose analysis is given as code, as [Analysis Registry](adapters.md#analysis-registry) requires, so an absent field means the index analyses with the language default. An index configured with a literal stop word set persists the words themselves in `stop_word_list`, and a payload carries at most one of `stop_words` and `stop_word_list`. Recovery resolves each name against the engine's analysis registry so that a recovered index analyses text the way the original did; see [Index Metadata](durability.md#index-metadata).

The `partition_limits`, `default_scoring`, `track_positions`, `strict`, `required`, and `vector_promotion` fields record the rest of the index configuration: the partition limits, the scoring mode, position tracking, strict document validation, the required field paths, and the vector promotion settings. All six are additive. A writer includes each field only when the index configuration set it, and a reader treats an absent field as that option's default, so a recovered index behaves exactly as the original did.

The `index_uuid` field records the identity a cluster assigned the index when it was created, as [Index Metadata](distribution/cluster.md#index-metadata) defines it. A node running in cluster mode writes the value, and a single engine leaves it absent. A rejoining node compares the recovered value with the one the coordinator holds before it adopts the index, so the node never serves a predecessor's documents from an index created again under the same name; see [Joining the Cluster](distribution/cluster.md#joining-the-cluster). The field is additive, and a reader that finds it absent treats the index as belonging to no cluster.

The `held_partitions` field records the partitions of the index this copy holds, so that the node can name what it stored when the controller looks for a partition in `UNASSIGNED`. A node must add a partition to the list when it finishes bootstrapping that partition. It must remove a partition from the list when it deletes that partition's copy. A partition that holds no document must still appear in the list, because a controller reading a document count would treat an empty partition as one the node lost. A node must answer [cluster.partition_stores](distribution/transport.md#clusterpartition_stores) from this field. The field is additive, and a node that finds it absent must answer from the partitions whose document count is above zero, because an index written before the field existed records nothing about what it holds.

---

### Snapshot Bundle Payload

The snapshot-only persistence tier writes the whole index as one envelope under the key `<indexName>/snapshot`. The envelope uses the same 32-byte header with the checksum flag set, and the payload is the snapshot bundle described in [Snapshot Checkpoint Format](durability.md#snapshot-checkpoint-format).

```text
{
  version:        uint8         (2)
  schema:         Map<string, string>
  language:          string
  analysis_revision: string        (optional; the language module revision)
  tokenizer:         string        (optional; the registered tokeniser name)
  stop_words:        string        (optional; the registered stop word set name)
  stop_word_list:    List<string>  (optional; the words of a literal stop word set)
  partitions:        List<bytes>   (one version 2 partition payload per entry)
  vectorIndexes:  Map<string, List<VectorIndexPayload>>   (the parts of each field, in part order)
  checkpoint:     List<PartitionCheckpoint>
}

PartitionCheckpoint {
  partitionId: uint32
  lastSeqNo:   uint64   (the highest write-ahead log seqNo this snapshot contains)
  primaryTerm: uint64
}
```

The bundle differs from the per-partition payload above: it carries every partition in one envelope, so a checkpoint replaces the whole index atomically. `checkpoint` records where write-ahead log replay resumes for each partition. It is additive, and a reader that skips it treats every `lastSeqNo` as 0. `analysis_revision`, `tokenizer`, `stop_words`, and `stop_word_list` are additive too: they carry the same analysis as the index metadata payload, and a reader recreates the index with them, resolving each name as [Index Metadata](durability.md#index-metadata) describes and treating the revision as [Index Metadata](#index-metadata) above requires. The log format, the recovery procedure, and the checkpoint rules are in [durability.md](durability.md).

---

### Index Snapshot Payload

The engine's snapshot operation serialises one whole index into a single `.nrsl` envelope. The restore operation rebuilds the index from those bytes. A writer must set `envelope_format_version` to 3 and must set the checksum flag. The field names are camelCase, as in the [vector index payload](#vector-index-payload).

The payload is a MessagePack map:

```text
{
  version:          uint8                        (the partition payload version: 1 or 2)
  schema:           Map<string, string>
  language:         string
  analysisRevision: string                       (optional; the language module revision)
  tokenizer:        string                       (optional; the registered tokeniser name)
  stopWords:        string                       (optional; the registered stop word set name)
  stopWordList:     List<string>                 (optional; the words of a literal stop word set)
  bm25:             { k1: float32, b: float32 }  (optional; each key optional)
  surfaceForms:     boolean                      (a reader treats an absent value as true)
  partitionConfig:  PartitionSnapshotLimits      (optional)
  defaultScoring:   string                       (optional; "local", "dfs", or "broadcast")
  trackPositions:   boolean                      (optional)
  strict:           boolean                      (optional)
  required:         List<string>                 (optional; field paths every document must supply)
  vectorPromotion:  VectorSnapshotPromotion      (optional)
  embedding:        EmbeddingSnapshotConfig      (optional)
  partitions:       List<bytes>                  (one partition payload per entry, at the named version)
  vectorIndexes:    Map<string, List<VectorIndexPayload>>   (the parts of each field, in part order)
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

`version` names the partition payload version of every entry in `partitions`: 1 for the [version 1 partition payload](#partition-payload) and 2 for the [version 2 partition payload](#version-2-partition-payload). A writer must write version 2. `analysisRevision` follows the rules `analysis_revision` sets in the [index metadata payload](#index-metadata-payload); a writer must record it, and a reader must treat an index restored without one as holding stale terms. Each remaining optional field records one index configuration option, and a writer leaves it absent when the configuration left that option unset.

A writer must reject an index whose tokeniser or stop words are code rather than a registered name, because no payload carries code.

A reader must reject an index snapshot envelope whose `envelope_format_version` is not 3 with `ENVELOPE_VERSION_MISMATCH`.

---

## Storage Path Convention

A persistence adapter addresses stored bytes by string key:

| Key | Content |
|-----|---------|
| `<indexName>/meta` | Index metadata |
| `<indexName>/manifest` | Checkpoint segment manifest |
| `<indexName>/segments/<partitionId>/s<segmentId>` | One checkpoint segment, id zero-padded to 16 digits |
| `<indexName>/segments/vec-<fieldPath>-f<fileId>` | One vector file of one vector field for the whole index, file id zero-padded to 16 digits |
| `<indexName>/segments/vec-<fieldPath>-graph-g<generation>` | The graph file of one vector field for the whole index at one generation |
| `<indexName>/snapshot` | Whole-index checkpoint bundle, written by the snapshot-only tier |
| `<indexName>/wal/<partitionId>/<startSeqNo>` | Write-ahead log segment, start sequence number zero-padded to 16 digits |
| `<indexName>/wal/<partitionId>/commit` | Write-ahead log commit marker |

A filesystem adapter maps each key to a file path, so an index named `products` produces `data/products/meta`, `data/products/manifest`, and `data/products/segments/0/s0000000000000003`. The segmented keys are defined in [Segmented Checkpoint](durability.md#segmented-checkpoint).

---

## Version Compatibility Rules

These rules take effect at Narsil 1.0, and every implementation must follow them from then on. Before 1.0 a reader must reject a payload written in an earlier layout with `ENVELOPE_VERSION_MISMATCH`.

1. **Keep a deserialiser for every envelope format version ever released.** A v3 deserialiser still handles v1 and v2 payloads by filling in defaults for the fields those versions lack. An old deserialiser is never removed.

2. **Adding an optional field** is a minor version increase, from v1.0 to v1.1. Existing deserialisers ignore fields they do not know, which MessagePack supports directly because it preserves unknown keys.

3. **Removing or renaming a field** is a major version increase, from v1 to v2, and the new deserialiser joins the existing one instead of replacing it.

4. **Newer code reading an older envelope always works.** The newer deserialiser fills in defaults for every field added after the version it is reading.

5. **Older code reading a newer major version must reject the file** with a clear message, such as: 'This data was written by Narsil envelope format vN and requires Narsil >= X.Y.Z. You are running A.B.C.' Use the `ENVELOPE_VERSION_MISMATCH` error code.

6. **A file written by one implementation must be readable by every other**, in either direction, as long as both support the envelope format version named in the header.
