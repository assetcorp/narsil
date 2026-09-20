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
  oversample:    float32 or absent
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

`oversample` sets how deep a [quantised](#quantisation) index re-scores against full-precision vectors:

```text
depth      = ceiling(k * oversample)
candidates = traverse the graph by estimated distance with ef = maximum(efSearch, depth)
rescored   = the depth nearest candidates, scored by the metric on full-precision vectors
return the best k of rescored
```

An implementation must reject an `oversample` that is not a finite number of at least 1 with `CONFIG_INVALID`. It must ignore `oversample` on an index whose quantisation is `none`. When `oversample` is absent the implementation uses its own default, recommended at 3 for `osq1` and `osq2` and at 2 for `osq4` and `osq8`.

### getVector(docId)

Returns the raw vector for a document, or absent when this index holds none for it. The coordinator uses it to rebuild whole documents when fetching one by ID and when attaching bodies to query results.

### compact()

Fast maintenance with bounded latency. It removes tombstoned vectors from the store and from any graph structure, and recalibrates the quantiser when quantisation is on.

`compact` must finish in time proportional to the number of tombstoned vectors, not to the size of the index, which is what makes it safe to call often, such as after a batch of deletes.

### optimize()

`optimize` restructures the index for faster search: a segment-based implementation merges several graphs into fewer, larger ones, while a single-graph implementation folds its buffered vectors into the graph. A single-graph implementation must rebuild the graph once callers have removed more than a fifth of its vectors.

Expect latency proportional to the total vector count. An implementation must release the processor during the operation, so a single-threaded runtime must yield between chunks and a runtime with threads may do the work in the background.

Call `optimize` in three situations: after a large batch of inserts, when the buffer or the new segments need folding into the main graph; after `compact` has removed more than a fifth of the vectors, because the remaining graph has lost connectivity; and when `maintenanceStatus` reports more than one graph and search latency has risen, which means the cost of merging across graphs is mounting.

`optimize` must leave every concurrent read correct. An implementation may block writes while it works, or buffer them the way partition rebalancing buffers writes. Once it finishes, every later search must use the optimised structure, and a search in flight must see either the old structure or the new one.

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

## Quantisation

A quantised index stores a compact code for every vector as well as the full-precision vector. A search ranks candidates by distances estimated from the codes and then re-scores the nearest of them against their full-precision vectors, as [search](#searchquery-k-options) defines.

```text
VectorIndexConfig {
  quantization: 'osq8' or 'osq4' or 'osq2' or 'osq1' or 'none'   (default by dimension)
}
```

An `osq8`, `osq4`, `osq2`, or `osq1` index stores eight, four, two, or one bits per dimension, as [Optimised Scalar Quantisation (OSQ)](algorithms.md#optimised-scalar-quantisation-osq) defines. An index set to `none` stores no code. When `quantization` is absent, an implementation must use `osq4` at 384 dimensions and above and `osq8` below 384.

A quantised index calibrates its quantiser once its vector count reaches the HNSW promotion threshold, and it calibrates again during `compact`. A quantised index places a new vector in the graph by scoring it as a query against the codes of its neighbours.

---

## Vector Storage

```text
VectorIndexConfig {
  storage: 'memory' or 'disk'   (default by environment)
}
```

A `memory` index holds its full-precision vectors in memory. A `disk` index holds its codes and its graph in memory, and it reads a full-precision vector from its vector file by position, as [Vector Index Payload](envelope.md#vector-index-payload) defines, when a search re-scores a candidate or a caller fetches a document. When `storage` is absent, an implementation must use `disk` for an index with filesystem durability and `memory` otherwise. An implementation must reject `disk` on an index without filesystem durability with `CONFIG_INVALID`, and it may hold the vectors of a `disk` index in memory until promotion.

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

## Native Search Core

The native search core is the vector search written in C, which every implementation uses as its standard search. An implementation must search a graph through the native search core wherever its platform can load native code and the store holds that graph's codes or vectors in memory. An implementation may search through its own code anywhere else, and wherever the deployment selects its own search. That search must return the same documents with the same scores as the native search core returns for the same graph and the same query.

### Interface

The core's C interface must use C types alone. To search, an implementation must pass the graph, the store, the query vector, the metric, the candidate count, and its thread slot. The core then returns that many of the nearest ordinals with their distances, nearest first. To place a vector, the implementation must pass that vector and its top layer in place of the query, so that the core returns the candidates of every layer from that top layer down to 0. The implementation must select the neighbours from those candidates, prune the lists, and write the lists while it follows [Locks](#locks).

### Shared Memory

An implementation must give the core the memory that holds a graph, its codes, and its vectors, because the core searches that memory in place. Every value in that memory must be little-endian. The implementation must leave a region at the same address when it grows that region. A writer must make the new bytes of a region readable before it stores any value that refers to them.

```text
Graph {
  header:     int32[160]
  nodeLevels: uint8 per ordinal               (the node's top layer plus 1, or 0 where the graph holds no node)
  level0:     int32[mMax0 + 2] per ordinal    (a count, then that many neighbour ordinals)
  upperBase:  int32 per ordinal               (the position in upper of the node's layer 1 list plus 1, or 0)
  upper:      int32[m + 2] per upper layer    (a count, then that many neighbour ordinals)
  locks:      int32 per ordinal
  tombstones: uint8 per ordinal               (1 once a caller removes the document)
  heldLocks:  int32[32] per thread slot
}

GraphHeader {
  word 0:   entryPoint        (the ordinal where a search starts, or -1)
  word 1:   topLayer          (the entry point's top layer, or -1)
  word 2:   m
  word 3:   mMax0
  word 4:   efConstruction
  word 5:   metric            (0 for cosine, 1 for dotProduct, 2 for euclidean)
  word 32:  nodeCount
  word 33:  tombstoneCount
  word 64:  upperUsed         (the int32 values of upper in use)
  word 65:  slots             (the ordinals in use)
  word 96:  graphLock
  word 97:  writersWaiting
  word 128: entryLock
}
```

A writer must store the lists of a node's upper layers in consecutive entries of `upper`, in ascending layer order. A writer must leave 0 in every header word that `GraphHeader` omits.

```text
Store {
  header:      int32[16]
  codes:       List<CodeBlock>
  codePresent: uint8 per ordinal      (1 where the ordinal holds a record)
  centroid:    float32[dimension]
  vectors:     List<VectorBlock or nil>
  magnitudes:  float64 per ordinal
  present:     uint8 per ordinal      (1 where the ordinal holds a live vector)
}

StoreHeader {
  word 0: slots
  word 1: liveCount
  word 2: vectorBlockCount
  word 3: calibrated                  (1 while the codes are valid)
  word 4: codeCount
  word 5: docIdBytes                  (the bytes of the implementation's document id table in use)
  word 6: codeBlockCount
  word 7: calibrationGeneration
  word 8: releasedVectorsToDisk       (1 once the implementation writes any vector of the store to disk)
}
```

A `CodeBlock` must hold `OSQRecord`s, as [Vector Index Payload](envelope.md#vector-index-payload) defines, with no padding between them. Each entry of a `VectorBlock` must hold one vector in a span of `dimension * 4` bytes, which the implementation rounds up to a multiple of 16. Every block of a list must hold the same number of entries, so ordinal `o` is entry `o mod entriesPerBlock` of block `floor(o / entriesPerBlock)`. A `vectors` entry is nil where the index holds that block's vectors on disk, so the implementation must re-score the candidates of that block itself. The core reads words 0, 3, and 4 of the store header alone.

The core must skip an ordinal at or above `slots` and a list that ends above `upperUsed`, because a corrupt value could otherwise send the core outside a region.

### Locks

Every thread that reads or writes a shared graph must follow this protocol. The thread must read and write every lock word atomically, because another thread may change the word at any moment.

The lock word of a node holds a version in its upper 30 bits, `writerWaiting` in bit 1, and `writeHeld` in bit 0.

```text
readNeighbours(ord, layer) -> List<int32>
  repeat:
    before = locks[ord]
    when writeHeld is clear in before:
      list = a copy of the node's list at layer
      when locks[ord] equals before:
        return list

lockNode(ord)
  repeat:
    seen = locks[ord]
    when writeHeld is clear in seen and compareAndSwap(locks[ord], seen, seen + 1) succeeds:
      return
    otherwise:
      the thread may set writerWaiting in locks[ord] and sleep until another thread wakes it

unlockNode(ord)
  released = locks[ord] with writeHeld and writerWaiting clear, plus 4
  previous = exchange(locks[ord], released)
  when writerWaiting is set in previous:
    wake the threads that sleep on locks[ord]
```

A writer must hold the lock of a node while it changes any list of that node.

`graphLock` holds the number of threads that search or place, or -1 while one thread holds the graph alone. A thread must raise `graphLock` by 1 before it reads the graph and lower `graphLock` by 1 afterwards. That thread must wait while `graphLock` is -1 or `writersWaiting` is above 0. A thread that needs the graph alone must raise `writersWaiting` by 1, swap `graphLock` from 0 to -1, and lower `writersWaiting` by 1. That thread must store 0 in `graphLock` when it finishes, and wake the threads that sleep on `graphLock`. A thread must swap `entryLock` from 0 to -1 before it stores `entryPoint` and `topLayer`, then store 0 in `entryLock`.

Every thread must record the locks that it holds in its own 32 words of `heldLocks`, so that the implementation can release the locks of a thread that dies.

```text
HeldLocks {
  word 0: the ordinal whose lock the thread holds plus 1, or 0
  word 1: the value that the thread stores in that lock word when it takes the lock
  word 2: 1 while graphLock counts the thread
  word 4: 1 while writersWaiting counts the thread
}
```

---

## Concurrency

The vector index must be thread-safe at its interface boundary.

- **Concurrent reads are safe.** An implementation may serve several searches at once.
- **Concurrent reads and writes are safe.** A write must never corrupt a read that overlaps it. A read that overlaps a write may include or exclude the document of that write, but it must never return corrupt or partial state.
- **Concurrent writes may be serialised.** An implementation may take a lock and apply its writes one at a time.

An implementation whose graph the native search core searches must follow [Locks](#locks). Any other implementation may choose its locking strategy. A single-threaded runtime satisfies the contract by construction, while a runtime with threads satisfies it with read-write locks, sharded locks, or an equivalent.

---

## HNSW Promotion

Search runs in two tiers:

- **Below the promotion threshold**, a brute-force linear scan answers every query. It is exact, deterministic, and free of graph overhead.
- **At or above the threshold**, HNSW answers the query. The graph is built from every existing vector when the threshold is reached, and later inserts go into the graph.

The default promotion threshold is 1,024 vectors, and each index can set its own through the vector index configuration.

Reaching the threshold triggers three steps: calibrate the quantiser across every vector in the store, when quantisation is on; build the HNSW graph from every vector; and switch the search backend from brute force to HNSW.

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

A vector index payload holds one part of a field, and its parts are persisted in two places: as the list under the field in the snapshot bundle's `vectorIndexes` map, and as the payloads of the vector segment files at `<indexName>/segments/<partitionId>/vec-<fieldPath>-g<generation>-p<part>`, written by the [segmented checkpoint](durability.md#segmented-checkpoint). A partition payload that must carry its vectors with it, such as one sent to another thread, embeds them as [Vector Data](envelope.md#vector-data) instead.

### Multi-Graph Format

`graphs` is a list rather than one graph, which supports an implementation that keeps several graphs internally, such as a segment-based one.

- A single-graph implementation writes a list of length 1.
- A segment-based implementation writes one graph per segment.
- The vectors keep one ordinal order across the parts whatever the graph count, and graphs reference vectors by `docId`.

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
  quantization:    'osq8' or 'osq4' or 'osq2' or 'osq1' or 'none'  (default by dimension)
  storage:         'memory' or 'disk'                              (default by environment)
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
