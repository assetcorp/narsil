# Narsil Vector Index Specification

This document defines the vector index system used by Narsil for
approximate nearest neighbor (ANN) search. The vector index is
decoupled from the partitioning system: partitions own text indexes
(inverted index, field indexes, document store), while each vector
field gets its own independent VectorIndex. All Narsil
implementations (TypeScript, Rust, Go) must follow the contracts
defined here. Where implementation strategy is explicitly left to
the runtime, this document says so.

---

## Overview

A VectorIndex is a per-field data structure that stores vectors and
provides similarity search. It is independent of the partition
layout and operates at the index level, not the partition level.

For an index with schema `{ title: "string", embedding: "vector[1536]" }`,
there is one VectorIndex for the `embedding` field. Partitions hold
the `title` field in their inverted index and document store.
The VectorIndex holds all `embedding` vectors across all documents,
regardless of which partition their text fields belong to.

### Why Decoupled

Narsil's partitioning system was designed for BM25 full-text
search. The default partition threshold (50,000 documents) keeps
BM25 latency under 10ms. When vector data is co-located with
partitions, a 50K document index splits into 5 partitions of 10K
each. Vector search must traverse 5 independent HNSW graphs and
merge results. HNSW is O(log N), so a single 50K graph takes ~4ms,
but 5 graphs + fan-out + merge takes ~28ms: a 7x overhead from
partitioning.

All production vector search systems (Qdrant, Weaviate,
Elasticsearch) decouple vector indexing from text indexing. The
vector index topology is determined by vector search performance
characteristics, not by text search partitioning needs.

---

## VectorIndex Interface

Every VectorIndex implementation must provide these operations:

```text
VectorIndex {
  fn insert(docId: string, vector: float32 array) -> none
  fn remove(docId: string) -> none
  fn search(query: float32 array, k: uint32, options: SearchOptions) -> array[ScoredResult]
  fn getVector(docId: string) -> float32 array or null
  fn has(docId: string) -> bool
  fn compact() -> none
  fn optimize() -> none
  fn maintenanceStatus() -> MaintenanceStatus
  fn serialize() -> VectorIndexPayload
  fn deserialize(payload: VectorIndexPayload) -> none

  [read-only] size: uint32
  [read-only] dimension: uint16
}

SearchOptions {
  metric:          'cosine' or 'dotProduct' or 'euclidean'
  minSimilarity:   float32 or null
  filterDocIds:    set[string] or null
  efSearch:        uint16 or null
}

ScoredResult {
  docId: string
  score: float32
}

MaintenanceStatus {
  tombstoneRatio:      float32
  graphCount:          uint32
  estimatedCompactMs:  uint32
  estimatedOptimizeMs: uint32
}
```

### insert(docId, vector)

Adds a vector to the index. If a vector for `docId` already exists,
it is replaced. The vector must have exactly `dimension` elements;
implementations must reject mismatched dimensions with error code
`VECTOR_DIMENSION_MISMATCH`.

### remove(docId)

Marks the vector for removal. Implementations may use tombstone-based
lazy removal (the vector remains in the graph but is excluded from
search results) or immediate removal. Tombstoned vectors are
physically removed during `compact()`.

Removing a non-existent `docId` is a no-op.

### search(query, k, options)

Returns up to `k` vectors most similar to `query`, ranked by
similarity score (highest first for cosine and dotProduct, lowest
distance first for euclidean).

See [Filtered Search](#filtered-search) for the behavior when
`filterDocIds` is provided. See [algorithms.md](algorithms.md) for
similarity metric definitions.

`efSearch` controls the HNSW exploration factor. When `null`, the
implementation uses its default (50). Higher values improve recall
at the cost of latency.

### getVector(docId)

Returns the raw vector for a document, or `null` if the document
has no vector in this index. Used by the coordinator to reconstruct
full documents during `get()` and query result attachment.

### compact()

Fast, bounded-latency maintenance. Removes tombstoned vectors from
the store and any graph structures. Recalibrates quantization
parameters if quantization is enabled.

Implementations must complete `compact()` in time proportional to
the number of tombstoned vectors, not the total index size. This
operation is safe to call frequently (e.g., after a batch of
deletes).

### optimize()

Expensive structural maintenance. Restructures the vector index for
improved search performance. For segment-based implementations, this
merges multiple graphs into fewer, larger graphs. For single-graph
implementations, this rebuilds the graph from scratch for optimal
connectivity.

Callers should expect latency proportional to total vector count.
Implementations should avoid monopolizing compute resources during
this operation. Single-threaded runtimes should yield periodically;
multi-threaded runtimes may run the operation on a background thread.

#### When to call optimize()

- After a large batch of inserts when using buffered or
  segment-based post-promotion insertion. The buffer or new
  segments are merged into the main graph.
- After `compact()` has removed a significant fraction of vectors
  (> 20%), since the remaining graph may have degraded connectivity.
- When `maintenanceStatus().graphCount > 1` and search latency
  has increased, indicating that multi-graph merge overhead is
  accumulating.

#### Interaction with concurrent operations

- `optimize()` must not corrupt concurrent reads. Implementations
  may block writes during optimize or buffer them (same WAQ pattern
  as partition rebalancing).
- After `optimize()` completes, subsequent searches must use the
  optimized structure. There must be no window where a search uses
  a partially-optimized graph.

### maintenanceStatus()

Returns metrics that help callers decide when to run `compact()` or
`optimize()`:

- `tombstoneRatio`: Fraction of vectors that are tombstoned
  (0.0 to 1.0). When this exceeds 0.1 (10%), `compact()` is
  recommended.
- `graphCount`: Number of HNSW graphs in the index. When this
  exceeds 1, `optimize()` may improve search latency by merging
  graphs.
- `estimatedCompactMs`: Rough estimate of `compact()` duration.
- `estimatedOptimizeMs`: Rough estimate of `optimize()` duration.

---

## Vector Storage Ownership

The VectorIndex is the single owner of raw vector data. Vectors are
NOT stored in the partition's document store.

When a document is inserted:

1. Text and non-vector fields are stored in the partition's document
   store and indexed in the partition's inverted index and field
   indexes.
2. Vector fields are extracted from the document and inserted into
   the corresponding VectorIndex.
3. The partition's document store receives the document with vector
   fields stripped.

When a document is retrieved via `get(docId)`:

1. The coordinator fetches the document from the partition (text and
   non-vector fields).
2. For each vector field in the schema, the coordinator calls
   `vectorIndex.getVector(docId)`.
3. The coordinator merges the vector fields back into the document
   before returning to the caller.

This eliminates memory duplication. At 1536 dimensions, each vector
is 6,144 bytes. For 1M documents, storing vectors in both the
document store and the vector index would waste ~6GB.

### Rebalancing

Because the VectorIndex is partition-agnostic, partition rebalancing
does not affect vector data. When partitions are redistributed,
only text and field index data moves between partitions. The
VectorIndex is untouched. This is a significant simplification over
the previous architecture where vector data had to be rebuilt for
each new partition.

---

## Atomicity

A document insert is atomic. A document is either fully indexed
(text fields in the partition, vector fields in the VectorIndex) or
not visible to any query. No query may observe a partially-indexed
document.

### Contract

- If the partition insert succeeds and the VectorIndex insert fails,
  the partition insert must be rolled back before the error
  propagates.
- If the VectorIndex insert succeeds and the partition insert fails,
  the VectorIndex insert must be rolled back.
- Schema validation and embedding generation must happen before any
  writes. This catches the most common failures (dimension mismatch,
  adapter errors) with zero rollback cost.
- Batch operations process each document independently. A failure
  in one document does not affect other documents in the batch.

### Mechanism

The atomicity mechanism is implementation-specific. The spec defines
the contract (fully indexed or not visible), not the implementation:

- Single-threaded runtimes can rely on synchronous execution within
  a single scheduler tick. If all writes complete synchronously
  without yielding, no reader can observe intermediate state.
- Multi-threaded runtimes (e.g., Rust, Go) may use write-ahead
  logging with version-gated visibility, segment-level atomic
  visibility, or another mechanism that satisfies the contract.

---

## Hybrid Search

When a query includes both a text term and a vector, Narsil runs
hybrid search. Because text indexes live in partitions and vector
indexes are independent, hybrid search fuses results at the
coordinator level.

### Hybrid Search Flow

```text
1. Fan out the text query to all partitions.
   Collect text results: array[{ docId, bm25Score }]

2. Query the VectorIndex for the vector field.
   Collect vector results: array[{ docId, similarityScore }]

3. Fuse the two result sets using the configured strategy.

4. Apply limit/offset or searchAfter cursor.

5. Attach document bodies (reconstructed from partition + VectorIndex).
```

### Fusion Strategies

Two fusion strategies are supported. The strategy is configured
per query:

```text
hybrid: {
  strategy: 'rrf' or 'linear'
  k:        uint32      (RRF constant, default 60, rrf only)
  alpha:    float32     (weight 0.0-1.0, default 0.5, linear only)
}
```

Default strategy: `rrf`.

#### Reciprocal Rank Fusion (RRF)

RRF fuses results by rank position, not score magnitude.
Normalization is unnecessary because ranks are directly comparable
across any scoring system.

For each document that appears in at least one result list:

```text
rrf_score(doc) = SUM for each list L where doc appears:
  1 / (k + rank_L(doc))
```

Where `rank_L(doc)` is the 1-indexed rank of the document in list
`L`, and `k` is a constant (default 60) that dampens the influence
of high-ranked results.

Documents that appear in only one list receive a score contribution
from that list only. Their contribution from the missing list is 0
(equivalent to rank = infinity).

See [algorithms.md](algorithms.md#reciprocal-rank-fusion) for the
full algorithm specification.

#### Linear Combination

Fuses results by score magnitude after min-max normalization.

```text
1. Normalize text scores to [0, 1]:
   normalized = (score - min_score) / (max_score - min_score)
   If all scores are equal, normalized = 1.0.

2. Normalize vector scores to [0, 1] using the same formula.

3. For each document:
   combined = alpha * vectorScore + (1 - alpha) * textScore

   Where alpha is the weight parameter (0.0 = pure text,
   1.0 = pure vector, 0.5 = equal weight).

4. Documents in only one list receive 0.0 for the missing score.
```

Normalization happens over the full result set (all documents from
all partitions for text, all results from the VectorIndex for
vectors). This is more correct than per-partition normalization
because the score ranges represent the true global distribution.

---

## Filtered Search

When `filterDocIds` is provided to `VectorIndex.search()`, only
vectors whose docId is in the filter set are eligible for results.

### Selectivity Threshold

Filtered HNSW search degrades when the filter is sparse relative
to the index. When the filter passes a small fraction of vectors,
the HNSW walk encounters frequent dead ends (nodes that don't pass
the filter), degrading to near-brute-force performance with graph
traversal overhead.

Implementations must apply a selectivity-based fallback:

```text
selectivity = size(filterDocIds) / totalVectors

if selectivity < filterThreshold:
  Brute-force scan only the vectors in filterDocIds.
else:
  HNSW traversal with filter applied during the walk.
```

The default `filterThreshold` is 0.03 (3%). This is configurable
per index via `VectorIndexConfig.filterThreshold`.

At 3% selectivity on a 100K index, the filter passes 3,000 vectors.
Brute-force over 3,000 vectors is fast (~1-2ms at 1536 dimensions).
HNSW traversal with 97% dead-end rate would be significantly slower.

### Per-Graph Selectivity

When the index contains multiple HNSW graphs (see
[Serialization](#serialization)), the selectivity check applies
per graph, not globally. A filter that passes 3% of the total index
might pass 10% of a smaller graph, which is above the threshold.
Per-graph selectivity produces more accurate fallback decisions.

### Adaptive efSearch

When using HNSW with a filter, implementations should increase
`efSearch` to compensate for the reduced effective graph
connectivity:

```text
if filterDocIds is provided and size(filterDocIds) < totalVectors:
  selectivity = size(filterDocIds) / totalVectors
  ef = max(efSearch, ceil(k / max(selectivity, 0.01)))
  ef = min(ef, totalVectors)
```

This ensures the search explores enough candidates to find `k`
filtered results even when most graph nodes are filtered out.

---

## Scalar Quantization (SQ8)

SQ8 compresses float32 vectors to uint8, providing 4x memory
savings. Quantized vectors are used for fast approximate distance
computation during HNSW traversal. Full-precision vectors are kept
for final rescoring.

### SQ8 Algorithm

See [algorithms.md](algorithms.md#scalar-quantization-sq8) for the
quantization formula, calibration process, and distance computation.

### SQ8 Configuration

```text
VectorIndexConfig {
  quantization: 'sq8' or 'none'   (default: 'sq8')
}
```

When `quantization` is `'sq8'`, the VectorIndex calibrates the
quantizer when the HNSW promotion threshold is reached and
recalibrates during `compact()`.

---

## Cross-Implementation Result Equivalence

### Text Search: Exact Equivalence

Given the same index contents, the same query, and the same
parameters, all implementations must return identical text search
results in identical order. BM25 is deterministic. The tokenizer,
stemmer, and scoring formula are specified precisely in
[algorithms.md](algorithms.md#bm25-best-matching-25). Any
divergence between implementations is a bug.

### Vector Search: Recall-Based Equivalence

HNSW is a probabilistic data structure. Graph construction depends
on random layer assignment, insertion order, and tie-breaking during
neighbor selection. Different implementations will produce different
graphs even for identical data.

All implementations must achieve:

- **recall@10 >= 0.95** measured against brute-force exact nearest
  neighbors on the same data.
- **recall@100 >= 0.90** measured against brute-force exact nearest
  neighbors on the same data.

These thresholds apply at the default HNSW parameters (M=16,
efConstruction=200, efSearch=50). Higher `efSearch` values should
produce higher recall.

Implementations may return different documents in different orders
for the same vector query, provided the recall floors are met.

### Hybrid Search

Because the vector component is approximate, hybrid search results
inherit the approximate contract. Result ordering may differ across
implementations for the same query.

### Conformance Testing

The cross-implementation conformance test suite uses:

1. A fixed dataset provided as a test fixture (10K vectors).
2. A fixed set of queries.
3. Assertions that text search results are exactly identical.
4. Assertions that vector search recall meets the floors against
   brute-force ground truth.
5. No assertions on identical vector result ordering.

---

## Concurrency

The VectorIndex must be thread-safe at its interface boundary.

### Contract

- **Concurrent reads are safe.** Multiple search operations may
  execute simultaneously.
- **Concurrent reads and writes are safe.** A write must not corrupt
  a concurrent read. A read during a write may return results that
  either include or exclude the document being written, but must
  never return corrupted or partial state.
- **Concurrent writes may be serialized.** Implementations are free
  to serialize write operations (e.g., via a mutex). Concurrent
  write support is not required.

### What Is Not Required

- Lock-free reads.
- Concurrent writes (serialization is acceptable).
- A specific locking strategy.

Single-threaded runtimes satisfy this contract automatically.
Multi-threaded runtimes implement it via read-write locks,
sharded locks, or equivalent mechanisms.

---

## HNSW Promotion

The VectorIndex uses a two-tier search strategy:

- **Below the promotion threshold:** Brute-force linear scan. Exact,
  deterministic, no graph overhead.
- **At or above the promotion threshold:** HNSW approximate search.
  The graph is built from all existing vectors when the threshold is
  reached. Subsequent inserts go directly into the graph.

The default promotion threshold is 1,024 vectors. This is
configurable via `VectorIndexConfig.threshold`.

### Promotion Process

When the vector count reaches the threshold:

1. If SQ8 quantization is enabled, calibrate the quantizer on all
   vectors in the store.
2. Build an HNSW graph from all vectors.
3. Switch the search backend from brute-force to HNSW.

### Promotion Contract

The spec defines the observable contract, not the construction
mechanism:

- **Before promotion completes:** All search operations use
  brute-force. Results are exact.
- **After promotion completes:** Search operations use HNSW.
  Results are approximate (subject to the recall floors defined in
  [Cross-Implementation Result Equivalence](#cross-implementation-result-equivalence)).
- **During promotion:** Search operations must remain available.
  They may use brute-force (if promotion runs in the background)
  or block until promotion completes (if promotion is synchronous).

Implementations choose their own promotion strategy:

- **Synchronous promotion:** The Nth insert blocks until the HNSW
  graph is built. Simple to implement. Causes a latency spike on
  the triggering insert.
- **Background promotion:** The Nth insert returns immediately.
  Graph construction runs asynchronously. Search continues using
  brute-force until the graph is ready, then switches to HNSW.
  No latency spike, but brute-force search may be slower for
  large vector counts during the build window.
- **Deferred promotion:** Graph construction is deferred until the
  first search query after the threshold is crossed. Inserts never
  pay the construction cost. The first search after threshold
  either blocks for construction or triggers a background build.

All three strategies satisfy the contract. Implementations should
document which strategy they use and its latency characteristics.

### Post-Promotion Insertion

After promotion, new vectors must be added to the HNSW graph.
Implementations choose the insertion strategy:

- **Incremental insertion:** Each new vector is inserted directly
  into the HNSW graph via the standard HNSW insertion algorithm.
  This spreads the cost across inserts but becomes expensive at
  high efConstruction values and large dimensions (each insert
  requires O(efConstruction * M * dimensions) distance
  computations across multiple layers).
- **Buffered insertion:** New vectors are stored flat and searched
  via brute-force. When the buffer reaches a size threshold or a
  maintenance operation runs, the buffer is merged into the HNSW
  graph in a single batch. This amortizes the graph construction
  cost and produces better graph quality than incremental
  insertion at the cost of mixed search modes during the buffer
  window.
- **Segment-based insertion:** New vectors form a new HNSW graph
  segment. Multiple segments are searched independently and
  results are merged. The `optimize()` operation merges segments.
  This avoids modifying existing graphs and supports the
  multi-graph serialization format defined in
  [Serialization](#serialization).

The choice of strategy has significant performance implications.
Incremental insertion throughput degrades with index size due to
per-insert graph traversal cost. Buffered and segment-based
strategies maintain constant insert throughput at the cost of
additional search-time complexity. Production vector databases
(Qdrant, Milvus, Lucene) use buffered or segment-based strategies
for this reason.

---

## Serialization

Vector index data is serialized separately from partition data.
Each vector field produces its own `.nrsl` envelope file.

### Storage Path

```text
<indexName>/vector/<fieldName>
```

For example, an index named `products` with a vector field
`embedding` stores its vector index at `products/vector/embedding`.

### Vector Index Payload

The vector index payload is a MessagePack map:

```text
VectorIndexPayload {
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

### Multi-Graph Format

The `graphs` field is an array, not a single graph. This supports
implementations that maintain multiple HNSW graphs internally
(e.g., segment-based architectures):

- A single-graph implementation writes an array of length 1.
- A segment-based implementation writes one graph per segment.
- The `vectors` list is always flat (one entry per document,
  regardless of graph count). Graphs reference vectors by `doc_id`.

All implementations must be able to read a vector index file
containing any number of graphs (including zero, which indicates
brute-force-only storage).

### Deserialization Strategy

The search strategy after deserialization is implementation-specific:

- An implementation may search each graph independently and merge
  results (segment-style).
- An implementation may merge all graphs into a single graph on
  load (single-graph-style).
- An implementation may use a combination (e.g., keep large graphs
  separate, merge small ones).

The spec does not prescribe the strategy. The recall-based
equivalence contract (see [Cross-Implementation Result Equivalence](#cross-implementation-result-equivalence))
ensures consistent search quality regardless of strategy.

---

## VectorIndex Configuration

```text
VectorIndexConfig {
  threshold:       uint32   (promotion threshold, default 1024)
  filterThreshold: float32  (selectivity fallback, default 0.03)
  quantization:    'sq8' or 'none'  (default 'sq8')
  hnswConfig: {
    m:               uint8    (max connections, default 16)
    efConstruction:  uint16   (build quality, default 200)
    metric:          'cosine' or 'dotProduct' or 'euclidean'
  }
}
```

All fields are optional. Omitted fields use the defaults listed
above.

---

## Index Metadata Changes

The index metadata envelope (see [envelope.md](envelope.md)) must
include vector field information so that implementations can locate
and load vector index files:

```text
IndexMetadata {
  ...existing fields...
  vector_fields: map[string, VectorFieldMeta]
}

VectorFieldMeta {
  dimension:    uint16
  metric:       string
  quantization: string
}
```

This allows the engine to discover which vector index files exist
for an index without scanning storage keys.
