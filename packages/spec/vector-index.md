# Narsil Vector Index Specification

This document defines the vector index, which is how Narsil answers approximate nearest-neighbour search. The vector index is decoupled from partitioning: a partition owns text data, meaning its inverted index, field indexes, and document store, and each vector field owns an independent vector index of its own. Every implementation must follow the contracts here, and where the strategy is left to the runtime this document says so.

Structure definitions use a language-neutral notation. `List<T>` is an ordered collection of `T`, `Map<K, V>` a mapping from keys to values, `Set<T>` a collection of distinct elements, and `T or absent` a value that may be missing. Width-tagged names such as `float32` describe exact widths on disk and on the wire.

---

## Overview

A vector index is a per-field structure that stores vectors and answers similarity queries. It knows nothing of the partition layout and works at the index level.

Take an index whose schema is `{ title: "string", embedding: "vector[1536]" }`. There is one vector index, for the `embedding` field. The partitions hold `title` in their inverted index and document store, and the vector index holds every `embedding` vector across every document, whatever partition each document's text belongs to.

Decoupling exists because the two structures scale on different terms. Partition size is chosen to keep BM25 latency low, and splitting a vector index along those same lines would force every vector query to traverse several graphs and merge their results, which costs far more than one larger graph.

---

## VectorIndex Interface

Every implementation must provide these operations:

```text
VectorIndex {
  insert(docId: string, vector: List<float32>) -> nothing
  remove(docId: string) -> nothing
  search(query: List<float32>, k: uint32, options: SearchOptions) -> List<ScoredResult>
  getVector(docId: string) -> List<float32> or absent
  has(docId: string) -> boolean
  compact() -> nothing
  optimize() -> nothing
  maintenanceStatus() -> MaintenanceStatus
  serialize() -> VectorIndexPayload
  deserialize(payload: VectorIndexPayload) -> nothing

  size:      uint32   (read-only)
  dimension: uint16   (read-only)
}

SearchOptions {
  metric:        'cosine' or 'dotProduct' or 'euclidean'
  minSimilarity: float32 or absent
  filterDocIds:  Set<string> or absent
  efSearch:      uint16 or absent
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

Adds a vector, replacing whatever `docId` held before. The vector must carry exactly `dimension` elements, and an implementation must reject any other length with `VECTOR_DIMENSION_MISMATCH`.

### remove(docId)

Marks the vector as removed. An implementation may remove it immediately or leave a tombstone, where the vector stays in the graph and is kept out of every result. A tombstoned vector is physically removed by `compact`.

Removing a `docId` the index does not hold does nothing.

### search(query, k, options)

Returns up to `k` vectors closest to `query`, ordered by similarity, with the highest score first for cosine and dot product and the smallest distance first for Euclidean. Vectors tied on score order by document ID, ascending in [code point order](algorithms.md#code-point-order).

See [Filtered Search](#filtered-search) for what `filterDocIds` does, and [algorithms.md](algorithms.md) for the metric definitions.

`efSearch` sets the HNSW exploration factor. When it is absent the implementation uses its own default, recommended at 50. A higher value raises recall and costs latency.

### getVector(docId)

Returns the raw vector for a document, or absent when this index holds none for it. The coordinator uses it to rebuild whole documents when fetching one by ID and when attaching bodies to query results.

### compact()

Fast maintenance with bounded latency. It removes tombstoned vectors from the store and from any graph structure, and recalibrates the quantiser when quantisation is on.

`compact` must finish in time proportional to the number of tombstoned vectors, not to the size of the index, which is what makes it safe to call often, such as after a batch of deletes.

### optimize()

Expensive structural maintenance. It restructures the index for faster search: a segment-based implementation merges several graphs into fewer, larger ones, and a single-graph implementation rebuilds its graph for better connectivity.

Expect latency proportional to the total vector count. An implementation should avoid holding the processor for the whole run, so a single-threaded runtime yields periodically and a runtime with threads may run the work in the background.

Call `optimize` in three situations: after a large batch of inserts, when the buffer or the new segments need folding into the main graph; after `compact` has removed more than a fifth of the vectors, because the remaining graph has lost connectivity; and when `maintenanceStatus` reports more than one graph and search latency has risen, which means the cost of merging across graphs is mounting.

`optimize` must never corrupt a concurrent read. An implementation may block writes while it runs, or buffer them the way partition rebalancing buffers writes. Once it finishes, every later search must use the optimised structure, with no window in which a search runs against a half-optimised graph.

### maintenanceStatus()

Returns the figures a caller needs to decide when to run `compact` or `optimize`:

- `tombstoneRatio` is the fraction of vectors that are tombstoned, from 0 to 1. Above 0.1, run `compact`.
- `graphCount` is the number of HNSW graphs in the index. Above 1, `optimize` may cut search latency by merging them.
- `estimatedCompactMs` and `estimatedOptimizeMs` are rough estimates of how long each operation would take.

---

## Vector Storage Ownership

The vector index is the only owner of raw vector data, and no vector is stored in a partition's document store.

Inserting a document does three things:

1. Text and non-vector fields go into the partition's document store and are indexed in its inverted index and field indexes.
2. Vector fields are lifted out of the document and inserted into the matching vector index.
3. The partition's document store receives the document with its vector fields stripped.

Fetching a document by ID reverses that:

1. The coordinator reads the document from the partition, which gives it the text and non-vector fields.
2. For each vector field in the schema, it calls `getVector` on that field's index.
3. It merges the vectors back into the document before returning it.

That keeps one copy of each vector. At 1536 dimensions a vector occupies 6,144 bytes, so holding a million of them in both the document store and the vector index would waste roughly 6 GB.

### Rebalancing

A partition rebalance moves text and field index data alone. The vector index holds no partition assignment, so redistribution leaves it untouched and nothing about it needs rebuilding.

---

## Atomicity

A document insert is atomic. A document is either fully indexed, with its text fields in the partition and its vectors in the vector index, or invisible to every query. No query may observe a half-indexed document.

- When the partition insert succeeds and the vector insert fails, the partition insert must be rolled back before the error reaches the caller.
- When the vector insert succeeds and the partition insert fails, the vector insert must be rolled back.
- Schema validation and embedding generation must both finish before any write starts, which catches the common failures, meaning a dimension mismatch or an adapter error, at no rollback cost.
- A batch operation processes each document on its own, so one document's failure leaves the rest of the batch alone.

The mechanism is implementation-specific; the contract is that a document is fully indexed or invisible. A single-threaded runtime can lean on synchronous execution inside one scheduler tick, because a set of writes that completes without yielding is never observed half-done. A runtime with threads may use write-ahead logging with version-gated visibility, segment-level atomic visibility, or anything else that satisfies the contract.

---

## Hybrid Search

A query carrying both a text term and a vector runs hybrid search. Text indexes are held in partitions and vector indexes are independent, so the coordinator is where the two result sets fuse.

Fusion defines the order of hybrid results, and a sort would replace it, so a hybrid query carries no `sort`. An implementation must reject a query whose sort names any field while the query also carries `hybrid`, or both a term and a vector, with `SEARCH_INVALID_MODE`.

```text
1. Fan the text query out to every partition and collect
   { docId, bm25Score } results.
2. Query the vector index for the vector field and collect
   { docId, similarityScore } results.
3. Fuse the two sets with the configured strategy.
4. Apply limit and offset, or the searchAfter cursor.
5. Attach the document bodies, rebuilt from the partition and the
   vector index.
```

### Fusion Strategies

Two strategies exist, configured per query:

```text
hybrid {
  strategy: 'rrf' or 'linear'
  k:        uint32    (the RRF constant, default 60, used by rrf alone)
  alpha:    float32   (a weight from 0 to 1, default 0.5, used by linear alone)
}
```

The default strategy is `rrf`.

#### Reciprocal Rank Fusion

RRF fuses by rank position instead of score magnitude, which is why it needs no normalisation: ranks compare directly across any two scoring systems.

For each document appearing in at least one list:

```text
rrf_score(doc) = SUM over each list L containing doc of
  1 / (k + rank_L(doc))
```

`rank_L(doc)` is the document's rank in list `L`, counted from 1, and `k` is a constant, 60 by default, that damps the pull of the top ranks.

A document in only one list gets a contribution from that list alone, and its contribution from the list it is missing from is zero, which is the same as ranking it infinitely far down.

The full algorithm is in [Reciprocal Rank Fusion](algorithms.md#reciprocal-rank-fusion).

#### Linear Combination

Linear combination fuses by score magnitude after min-max normalisation.

```text
1. Normalise the text scores into [0, 1]:
     normalised = (score - min_score) / (max_score - min_score)
   When every score is equal, normalised is 1.0.
2. Normalise the vector scores the same way.
3. For each document:
     combined = alpha * vectorScore + (1 - alpha) * textScore
   where alpha of 0 is pure text, 1 is pure vector, and 0.5 weights
   the two equally.
4. A document in only one list scores 0 for the list it is missing
   from.
```

Normalisation runs over the whole result set, meaning every text result from every partition and every result from the vector index, because those ranges are the true score distribution. Normalising per partition would compare scores that were never on the same scale.

---

## Filtered Search

With `filterDocIds` supplied, only vectors whose document ID is in that set can appear in the results.

### Selectivity Threshold

Filtered HNSW search degrades as the filter grows sparse. When the filter admits only a small fraction of the index, the graph walk keeps reaching nodes that fail the filter, and the search costs as much as a brute-force scan plus the traversal on top.

An implementation must apply a selectivity fallback:

```text
selectivity = size(filterDocIds) / totalVectors

if selectivity < filterThreshold:
  scan the vectors in filterDocIds by brute force
else:
  traverse the HNSW graph, applying the filter during the walk
```

The default `filterThreshold` is 0.03, and each index can set its own through the vector index configuration.

At 3% selectivity on an index of 100,000 vectors, the filter admits 3,000 vectors, and a brute-force pass over 3,000 vectors at 1536 dimensions is quick. An HNSW traversal that fails the filter on 97% of the nodes it reaches is far slower.

### Per-Graph Selectivity

When an index holds several HNSW graphs, as [Serialisation](#serialisation) allows, the selectivity check runs per graph rather than over the whole index. A filter that admits 3% of the index might admit 10% of one small graph, which is above the threshold, so a per-graph check makes better fallback decisions.

### Adaptive efSearch

Filtering cuts the graph's effective connectivity, so an implementation should raise `efSearch` to compensate:

```text
if filterDocIds is present and size(filterDocIds) < totalVectors:
  selectivity = size(filterDocIds) / totalVectors
  ef = max(efSearch, ceiling(k / max(selectivity, 0.01)))
  ef = min(ef, totalVectors)
```

That keeps the search exploring enough candidates to find `k` results that pass the filter, even when most nodes it reaches do not.

---

## Scalar Quantisation (SQ8)

SQ8 compresses a float32 vector into uint8 values, cutting memory to a quarter. The quantised vectors give fast approximate distances during graph traversal, and the full-precision vectors stay for the final rescoring.

The quantisation formula, the calibration process, and the distance computation are in [Scalar Quantisation (SQ8)](algorithms.md#scalar-quantisation-sq8).

```text
VectorIndexConfig {
  quantization: 'sq8' or 'none'   (default 'sq8')
}
```

With `sq8` selected, the index calibrates its quantiser when the HNSW promotion threshold is reached, and recalibrates during `compact`.

---

## Cross-Implementation Result Equivalence

### Text Search Is Exactly Equivalent

Given the same index contents, the same query, and the same parameters, every implementation must return identical text results in identical order. BM25 is deterministic, and the tokeniser, the stemmer, and the scoring formula are all fixed in [BM25](algorithms.md#bm25-best-matching-25). Any divergence between implementations is a bug.

### Vector Search Is Equivalent by Recall

HNSW is probabilistic. Graph construction depends on random layer assignment, on insertion order, and on how ties break while selecting neighbours, so two implementations produce different graphs from identical data.

Every implementation must reach:

- recall@10 of 0.95 or better, measured against the exact nearest neighbours found by brute force on the same data.
- recall@100 of 0.90 or better, measured the same way.

Those floors apply at the default HNSW parameters, meaning `m` of 16, `efConstruction` of 200, and `efSearch` of 50. A higher `efSearch` should raise recall further.

An implementation may return different documents in a different order for the same vector query, as long as it meets the floors.

### Hybrid Search

The vector half of a hybrid query is approximate, so hybrid results inherit that contract and their order may differ between implementations.

### Conformance Testing

The cross-implementation conformance suite runs a fixed 10,000-vector dataset and a fixed set of queries. It asserts that text results are exactly identical, asserts that vector recall meets the floors against brute-force ground truth, and asserts nothing about vector result order.

---

## Concurrency

The vector index must be thread-safe at its interface boundary.

- **Concurrent reads are safe.** Several searches may run at once.
- **Concurrent reads and writes are safe.** A write must never corrupt a read running beside it. A read taken during a write may include or exclude the document being written, and must never return corrupt or partial state.
- **Concurrent writes may be serialised.** An implementation is free to take a lock and run writes one at a time.

The contract requires no lock-free reads, no concurrent writes, and no particular locking strategy. A single-threaded runtime satisfies it by construction, and a runtime with threads satisfies it with read-write locks, sharded locks, or an equivalent.

---

## HNSW Promotion

Search runs in two tiers:

- **Below the promotion threshold**, a brute-force linear scan answers every query. It is exact, deterministic, and free of graph overhead.
- **At or above the threshold**, HNSW answers the query. The graph is built from every existing vector when the threshold is reached, and later inserts go into the graph.

The default promotion threshold is 1,024 vectors, and each index can set its own through the vector index configuration.

Reaching the threshold triggers three steps: calibrate the quantiser across every vector in the store, when SQ8 is on; build the HNSW graph from every vector; and switch the search backend from brute force to HNSW.

### Promotion Contract

The specification fixes what a caller observes, not how the graph gets built:

- Before promotion completes, every search uses brute force and every result is exact.
- After promotion completes, every search uses HNSW and results are approximate, within the recall floors in [Cross-Implementation Result Equivalence](#cross-implementation-result-equivalence).
- During promotion, search must stay available. It may keep using brute force while the build runs in the background, or block until the build finishes.

Three strategies satisfy that contract:

- **Synchronous promotion** blocks the insert that crosses the threshold until the graph is built. It is the simplest to build and it puts a latency spike on that one insert.
- **Background promotion** returns from that insert at once and builds the graph asynchronously. Search keeps using brute force until the graph is ready and then switches. Nothing spikes, but brute-force search is slower for a large vector count during the build window.
- **Deferred promotion** waits until the first search after the threshold is crossed. Inserts never pay the construction cost, and that first search either blocks for the build or starts one in the background.

An implementation should document which strategy it uses and what that costs in latency.

### Post-Promotion Insertion

After promotion, new vectors have to reach the graph. An implementation chooses how:

- **Incremental insertion** puts each new vector straight into the graph through the standard HNSW insertion algorithm. It spreads the cost across inserts, and it grows expensive at a high `efConstruction` and a large dimension, because each insert costs O(efConstruction × m × dimension) distance computations across the layers.
- **Buffered insertion** stores new vectors flat and searches them by brute force. Once the buffer reaches its size threshold, or a maintenance operation runs, the whole buffer merges into the graph in one batch. That amortises the construction cost and builds a better graph than incremental insertion, at the cost of two search modes running while the buffer fills.
- **Segment-based insertion** puts new vectors into a new graph segment. Segments are searched independently and their results merged, and `optimize` merges the segments. Existing graphs are never modified, which fits the multi-graph serialisation format in [Serialisation](#serialisation).

The choice matters. Incremental insertion loses throughput as the index grows, because every insert traverses the graph. Buffered and segment-based insertion hold insert throughput steady and pay for it with more work at search time.

---

## Serialisation

Vector index data is serialised apart from partition data. The payload layout is defined once, in [Vector Index Payload](envelope.md#vector-index-payload).

### Storage

A vector index payload is persisted in two places: as a value in the snapshot bundle's `vectorIndexes` map, and as the payload of a vector segment file at `<indexName>/segments/<partitionId>/vec-<fieldPath>-g<generation>`, written by the [segmented checkpoint](durability.md#segmented-checkpoint). A partition payload that must carry its vectors with it, such as one sent to another thread, embeds them as [Vector Data](envelope.md#vector-data) instead.

### Multi-Graph Format

`graphs` is a list rather than one graph, which supports an implementation that keeps several graphs internally, such as a segment-based one.

- A single-graph implementation writes a list of length 1.
- A segment-based implementation writes one graph per segment.
- The `vectors` list stays flat, with one entry per document whatever the graph count, and graphs reference vectors by `docId`.

Every implementation must read a vector index file holding any number of graphs, zero included, where zero means the file stores vectors for brute-force search alone.

### Deserialisation Strategy

What an implementation does with the graphs it loads is its own choice. It may search each graph independently and merge the results, merge every graph into one on load, or mix the two by keeping the large graphs separate and merging the small ones.

This specification prescribes none of those. The recall floors in [Cross-Implementation Result Equivalence](#cross-implementation-result-equivalence) hold search quality steady whichever strategy an implementation picks.

---

## VectorIndex Configuration

```text
VectorIndexConfig {
  threshold:       uint32           (promotion threshold, default 1024)
  filterThreshold: float32          (selectivity fallback, default 0.03)
  quantization:    'sq8' or 'none'  (default 'sq8')
  hnswConfig {
    m:              uint8    (maximum connections, default 16)
    efConstruction: uint16   (build quality, default 200)
    metric:         'cosine' or 'dotProduct' or 'euclidean'
  }
}
```

Every field is optional, and an omitted field takes the default above.

---

## Index Metadata

The index metadata envelope defined in [envelope.md](envelope.md) carries vector field information, so that an implementation can find and load the vector index files without scanning storage keys:

```text
IndexMetadata {
  ...the other metadata fields...
  vector_fields: Map<string, VectorFieldMeta>
}

VectorFieldMeta {
  dimension:    uint16
  metric:       string
  quantization: string
}
```
