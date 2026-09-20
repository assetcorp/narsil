# Narsil Vector Index Specification

This document defines the vector index, which Narsil uses to answer approximate nearest-neighbour searches. A vector index is independent of partitioning, because a partition owns its inverted index, its field indexes, and its document store, while each vector field owns one vector index. Every implementation must follow the contracts here, and this document says where a runtime may choose its own strategy.

Structure definitions use a language-neutral notation. `List<T>` is an ordered collection of `T`, `Map<K, V>` is a mapping from keys to values, `Set<T>` is a collection of distinct elements, and `T or absent` is a value that may be missing. Width-tagged names such as `float32` describe exact widths on disk and on the wire.

---

## Overview

A vector index is a per-field structure that stores vectors and answers similarity queries. It holds no partition layout, because it covers the whole index.

An index whose schema is `{ title: "string", embedding: "vector[1536]" }` has one vector index, which the `embedding` field owns. The partitions hold `title` in their inverted index and document store, while the vector index holds the `embedding` vector of every document, whatever partition holds that document's text.

The two structures scale differently. An operator chooses a partition size that keeps BM25 latency low, whereas a vector index that followed those partitions would make every vector query walk several graphs and merge their results, which costs more than a walk of one larger graph.

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

`insert` stores a vector under `docId`, in place of any vector that `docId` holds. The vector must hold exactly `dimension` elements, and an implementation must reject any other length with `VECTOR_DIMENSION_MISMATCH`.

### remove(docId)

`remove` marks the vector of `docId` as removed. An implementation may remove the vector at once, or it may leave a tombstone, which keeps the vector in the graph while every search skips it. `compact` takes a tombstoned vector out of the graph. `remove` does nothing for a `docId` that the index lacks.

### search(query, k, options)

`search` returns up to `k` of the vectors closest to `query`. It orders them by the highest score first for cosine and dot product, and by the smallest distance first for Euclidean. It orders the vectors that tie on score by document ID, ascending in [code point order](algorithms.md#code-point-order).

See [Filtered Search](#filtered-search) for what `filterDocIds` does, and [algorithms.md](algorithms.md) for the metric definitions.

`efSearch` sets the HNSW exploration factor. When `efSearch` is absent, an implementation must use its own default, and the recommended default is 50. A higher value raises recall and lengthens the search.

`oversample` sets how deep a [quantised](#quantisation) index re-scores against full-precision vectors:

```text
depth      = ceiling(k * oversample)
candidates = traverse the graph by estimated distance with ef = maximum(efSearch, depth)
rescored   = the depth nearest candidates, scored by the metric on full-precision vectors
return the best k of rescored
```

An implementation must accept an `oversample` that is a finite number of at least 1, and it must reject any other value with `CONFIG_INVALID`. It must ignore `oversample` on an index whose quantisation is `none`. When `oversample` is absent, an implementation must use its own default, and the recommended defaults are 3 for `osq1` and `osq2` and 2 for `osq4` and `osq8`.

### getVector(docId)

`getVector` returns the raw vector of a document, or absent where the index holds no vector for that document. The coordinator calls it to rebuild a whole document when a caller fetches one by ID, and when the coordinator attaches bodies to query results.

### compact()

`compact` removes tombstoned vectors from the store and from every graph. It must finish in a time proportional to the number of tombstoned vectors, whatever the size of the index, so that a caller can call it after every batch of deletes.

### optimize()

`optimize` restructures the index for faster search. A segment-based implementation merges several graphs into fewer, larger ones, while a single-graph implementation folds its buffered vectors into the graph. A single-graph implementation must rebuild the graph once callers remove more than a fifth of its vectors. A quantised index must recalibrate its quantiser whenever `optimize` rebuilds or merges a graph, as Lucene recomputes its centroid when it merges segments.

A caller should expect latency proportional to the total vector count. An implementation must release the processor during the operation, so a single-threaded runtime must yield between chunks and a runtime with threads may do the work in the background.

A caller should call `optimize` in three situations:

- A large batch of inserts leaves a buffer or new segments that the main graph must absorb.
- `compact` removes more than a fifth of the vectors, which leaves the graph with fewer connections.
- `maintenanceStatus` reports more than one graph while search latency rises, which means that each search pays to merge across those graphs.

`optimize` must leave every concurrent read correct. An implementation may block writes while it works, or buffer them as partition rebalancing buffers writes. Once it finishes, every later search must use the optimised structure, and a search in flight must see either the old structure or the new one.

### maintenanceStatus()

`maintenanceStatus` returns the figures that a caller needs to decide when to call `compact` or `optimize`:

- `tombstoneRatio` is the fraction of vectors whose tombstone is set, from 0 to 1. A caller should call `compact` above 0.1.
- `graphCount` is the number of HNSW graphs in the index. Above 1, `optimize` may lower search latency, because it merges the graphs.
- `estimatedCompactMs` and `estimatedOptimizeMs` are rough estimates of how long each operation would take.

---

## Vector Storage Ownership

The vector index is the only owner of raw vector data, so a partition's document store holds no vector.

An implementation must insert a document in three steps:

1. It indexes the text and non-vector fields in the partition's inverted index and field indexes.
2. It moves each vector field out of the document and inserts that vector into the matching vector index.
3. It stores the document, without its vector fields, in the partition's document store.

The coordinator must fetch a document by ID in three steps:

1. It reads the document from the partition, which returns the text and non-vector fields.
2. It calls `getVector` on the index of each vector field in the schema.
3. It merges the vectors back into the document before it returns that document.

The index therefore holds one copy of each vector. A vector of 1,536 dimensions takes 6,144 bytes, so a second copy of a million such vectors in the document store would take about 6 GB.

### Rebalancing

A partition rebalance moves text and field index data alone. The vector index holds no partition assignment, so a rebalance leaves the vector index as it is.

---

## Atomicity

A document insert is atomic. Every query must observe a document either as fully indexed, with its text fields in the partition and its vectors in the vector index, or as absent.

- When the partition insert succeeds and the vector insert fails, an implementation must roll the partition insert back before the error reaches the caller.
- When the vector insert succeeds and the partition insert fails, an implementation must roll the vector insert back.
- Schema validation and embedding generation must both finish before any write starts, so that a dimension mismatch or an adapter error fails before any write needs a rollback.
- A batch operation processes each document on its own, so one document's failure leaves the rest of the batch alone.

An implementation may choose its mechanism, provided that a document is fully indexed or absent. A single-threaded runtime may rely on synchronous execution inside one scheduler tick, because no query can observe a set of writes that completes without yielding. A runtime with threads may use write-ahead logging with version-gated visibility, segment-level atomic visibility, or any other mechanism that satisfies the contract.

---

## Hybrid Search

A query that holds both a text term and a vector is a hybrid search. Partitions hold the text indexes while each vector index is independent, so the coordinator fuses the two result sets.

Fusion defines the order of hybrid results, which a sort would replace, so a hybrid query must hold no `sort`. An implementation must reject a query with `SEARCH_INVALID_MODE` where its sort names any field and the query also holds `hybrid`, or holds both a term and a vector.

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

A query selects one of two strategies:

```text
hybrid {
  strategy: 'rrf' or 'linear'
  k:        uint32    (the RRF constant, default 60, used by rrf alone)
  alpha:    float32   (a weight from 0 to 1, default 0.5, used by linear alone)
}
```

The default strategy is `rrf`.

#### Reciprocal Rank Fusion

RRF fuses by rank position, so it needs no normalisation, because ranks compare directly across any two scoring systems.

For each document that appears in at least one list:

```text
rrf_score(doc) = SUM over each list L containing doc of
  1 / (k + rank_L(doc))
```

`rank_L(doc)` is the document's rank in list `L`, counted from 1. `k` is a constant, 60 by default, that lowers the weight of the top ranks.

A document that appears in one list alone receives the contribution of that list, while the other list contributes zero.

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

An implementation must normalise over the whole result set, which holds every text result from every partition and every result from the vector index. Normalising per partition would compare scores from different scales.

---

## Filtered Search

Where a caller supplies `filterDocIds`, a search must return only vectors whose document ID is in that set.

### Selectivity Threshold

A filtered HNSW search slows as its filter admits fewer vectors. When the filter admits a small fraction of the index, the graph walk reaches many nodes that fail the filter, so the search costs as much as a brute-force scan plus the walk.

An implementation must apply a selectivity fallback:

```text
selectivity = size(filterDocIds) / totalVectors

if selectivity < filterThreshold:
  scan the vectors in filterDocIds by brute force
else:
  traverse the HNSW graph, applying the filter during the walk
```

The default `filterThreshold` is 0.03, and each index can set its own through the vector index configuration.

At 3% selectivity on an index of 100,000 vectors, the filter admits 3,000 vectors, which a brute-force pass scores directly. An HNSW walk of the same index fails the filter on about 97% of the nodes that it reaches.

### Per-Graph Selectivity

When an index holds several HNSW graphs, as [Serialisation](#serialisation) allows, an implementation must check selectivity for each graph. A filter that admits 3% of the index can admit 10% of one small graph, which is above the threshold, so the implementation walks that graph.

### Adaptive efSearch

Filtering cuts the graph's effective connectivity, so an implementation should raise `efSearch` to compensate:

```text
if filterDocIds is present and size(filterDocIds) < totalVectors:
  selectivity = size(filterDocIds) / totalVectors
  ef = max(efSearch, ceiling(k / max(selectivity, 0.01)))
  ef = min(ef, totalVectors)
```

The search then explores enough candidates to find `k` results that pass the filter, even when most of the nodes that it reaches fail the filter.

---

## Quantisation

A quantised index stores a compact code for every vector as well as the full-precision vector. A search ranks candidates by the distances that it estimates from the codes, and it then re-scores the nearest of them against their full-precision vectors, as [search](#searchquery-k-options) defines.

```text
VectorIndexConfig {
  quantization: 'osq8' or 'osq4' or 'osq2' or 'osq1' or 'none'   (default by dimension)
}
```

An `osq8`, `osq4`, `osq2`, or `osq1` index stores eight, four, two, or one bits per dimension, as [Optimised Scalar Quantisation (OSQ)](algorithms.md#optimised-scalar-quantisation-osq) defines. An index whose `quantization` is `none` stores no code. When `quantization` is absent, an implementation must use `osq4` at 384 dimensions and above and `osq8` below 384.

A quantised index calibrates its quantiser once its vector count reaches the HNSW promotion threshold, and it calibrates again when `optimize` rebuilds or merges a graph. A quantised index places a new vector in the graph by scoring it as a query against the codes of its neighbours.

---

## Vector Storage

```text
VectorIndexConfig {
  storage: 'memory' or 'disk'   (default by environment)
}
```

A `memory` index holds its full-precision vectors in memory. A `disk` index holds its codes and its graph in memory, while it reads a full-precision vector from its vector file by position, as [Vector Index Payload](envelope.md#vector-index-payload) defines, when a search scores that vector or a caller fetches a document. When `storage` is absent, an implementation must use `disk` for an index with filesystem durability and `memory` otherwise. An implementation must reject `disk` on an index without filesystem durability with `CONFIG_INVALID`, and it may hold the vectors of a `disk` index in memory until promotion.

---

## Cross-Implementation Result Equivalence

### Text Search Is Exactly Equivalent

Given the same index contents, the same query, and the same parameters, every implementation must return identical text results in identical order. BM25 is deterministic, because [BM25](algorithms.md#bm25-best-matching-25) fixes the tokeniser, the stemmer, and the scoring formula. Any divergence between implementations is a defect.

### Vector Search Is Equivalent by Recall

HNSW is probabilistic. Graph construction depends on random layer assignment, on insertion order, and on how ties break while a builder selects neighbours, so two implementations can produce different graphs from identical data.

Every implementation must reach recall@10 of 0.95 or better and recall@100 of 0.90 or better. Both figures compare a search with the exact nearest neighbours that a brute-force scan finds on the same data.

Those floors apply at the default HNSW parameters, meaning `m` of 16, `efConstruction` of 200, and `efSearch` of 50. A higher `efSearch` should raise recall further.

An implementation may return different documents in a different order for the same vector query, as long as it meets the floors.

### Hybrid Search

The vector half of a hybrid query is approximate, so the recall floors govern hybrid results too, and their order may differ between implementations.

### Conformance Testing

The conformance suite searches a fixed dataset of 10,000 vectors with a fixed set of queries. It asserts that text results are identical and that vector recall meets the floors against brute-force ground truth, while it asserts nothing about the order of vector results.

---

## Native Search Core

The native search core is the C library that every implementation uses as its standard to search vectors and to build graphs. An implementation must perform every operation of [Interface](#interface) through the native search core wherever its platform can load native code. An implementation may perform those operations in its own code anywhere else, and wherever the deployment selects that code. That code must return the same documents with the same scores as the native search core returns for the same graph and the same query.

### Interface

The core's C interface must use C types alone.

```text
NativeSearchCore {
  search(graph, store, query: List<float32>, metric, candidateCount: uint32, threadSlot: uint32) -> List<Candidate>
  score(store, query: List<float32>, metric, ordinals: List<int32>) -> List<float64>
  place(graph, store, ordinal: int32, topLayer: int32, metric, threadSlot: uint32) -> 'placed' or 'needsRoom'
  remove(graph, ordinal: int32, threadSlot: uint32) -> nothing
  compact(graph, store, metric, threadSlot: uint32) -> nothing
  calibrate(store, metric, ordinals: List<int32>) -> nothing
  quantise(store, metric, ordinals: List<int32>) -> nothing
}

Candidate {
  ordinal:  int32
  distance: float64
}
```

`search` must return the `candidateCount` nearest ordinals, nearest first, as [Search](algorithms.md#search) defines. It must walk the graph by the distances that it estimates from the codes while `calibrated` is 1, and by the metric on full-precision vectors otherwise.

`score` must return the distance from `query` to the full-precision vector of each ordinal, and infinity for an ordinal whose vector the store lacks. An implementation must call `score` when it re-scores the candidates of a search and when it scans vectors by brute force.

`place` must link the node of `ordinal` into every layer from `topLayer` down to 0, as [Insertion](algorithms.md#insertion) defines, and it must raise `nodeCount` by 1. It must store that node as the entry point where the graph holds no entry point. It must first lower `tombstoneCount` by 1 where the `tombstones` entry of `ordinal` holds 1, and then store 0 in that entry.

Before an implementation calls `place`, it must store the vector of `ordinal`, call `quantise` for that ordinal while `calibrated` is 1, and grow every region of the graph until the region can hold the node and its lists. `place` must return `needsRoom` and leave the graph unchanged where `slotCapacity` or `upperCapacity` leaves no room for the node, so that the implementation can grow the region and call `place` again.

`remove` must store 1 in the `tombstones` entry of `ordinal` and raise `tombstoneCount` by 1. It must also move the entry point to the live node with the highest top layer where `ordinal` is the entry point.

`compact` must take every tombstoned node out of the graph, as [Removal](algorithms.md#removal) defines, and lower `nodeCount` and `tombstoneCount` by 1 for each node. An implementation must hold the graph alone, as [Locks](#locks) defines, while it calls `compact`, and `compact` must change the graph only while `graphLock` holds -1.

`calibrate` must store the centroid of the vectors of `ordinals` in `centroid`, as [Centroid](algorithms.md#centroid) defines. It must then raise `calibrationGeneration` by 1 and store 1 in `calibrated`.

`quantise` must write the `OSQRecord` of each ordinal from its full-precision vector, as [Quantisation](algorithms.md#quantisation) defines. It must raise `codeCount` by 1 where the `codePresent` entry of that ordinal holds 0, and then store 1 in that entry.

The core must follow [Locks](#locks) in every operation that reads or writes a graph.

### Shared Memory

An implementation must give the core the memory that holds a graph, its codes, and its vectors, because the core works on that memory in place. It must also give the core the path of every vector file, because the core maps each file into memory. Every value in that memory and in those files must be little-endian. The implementation must leave a region at the same address when it grows that region. A writer must make the new bytes of a region readable before it stores any value that refers to them, which includes `upperCapacity` and `slotCapacity`.

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
  word 66:  upperCapacity     (the int32 values that upper can hold)
  word 67:  slotCapacity      (the ordinals that every region with one entry per ordinal can hold)
  word 96:  graphLock
  word 97:  writersWaiting
  word 128: entryLock
}
```

A writer must store the lists of a node's upper layers in consecutive entries of `upper`, in ascending layer order. A writer must leave 0 in every header word that `GraphHeader` omits.

```text
Store {
  header:       int32[16]
  codes:        List<CodeBlock>
  codePresent:  uint8 per ordinal     (1 where the ordinal holds a record)
  centroid:     float32[dimension]
  vectors:      List<VectorBlock or nil>
  magnitudes:   float64 per ordinal
  present:      uint8 per ordinal     (1 where the ordinal holds a live vector)
  vectorFile:   int32 per ordinal     (the position in files of the file that holds the vector, or -1 where a block holds it)
  vectorOffset: uint32 per ordinal    (the byte offset of the vector in that file)
  files:        List<string>          (the path of each vector file)
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

A `CodeBlock` must hold `OSQRecord`s, as [Vector Index Payload](envelope.md#vector-index-payload) defines, with no padding between them. Each entry of a `VectorBlock` must hold one vector in a span of `dimension * 4` bytes, which the implementation rounds up to a multiple of 16. Every block of a list must hold the same number of entries, so ordinal `o` is entry `o mod entriesPerBlock` of block `floor(o / entriesPerBlock)`. A `vectors` entry is nil where the index holds every vector of that block on disk. The core must read a vector whose `vectorFile` entry is 0 or above from that file, at its `vectorOffset`. An implementation must leave a vector file unchanged while a core maps it, and it must detach every core from that file before it deletes the file. The core uses words 0, 3, 4, and 7 of the store header alone.

The core must skip an ordinal at or above `slots`, a list that ends above `upperUsed`, and a vector that ends beyond its file, because a corrupt value could otherwise send the core outside a region.

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

A vector index answers a search in one of two ways:

- **Below the promotion threshold**, a brute-force linear scan answers every query. It is exact, deterministic, and free of graph overhead.
- **At or above the threshold**, HNSW answers the query. An implementation builds the graph from every existing vector when the vector count reaches the threshold, and it places every later insert in that graph.

The default promotion threshold is 1,024 vectors, and each index can set its own through the vector index configuration.

When the vector count reaches the threshold, an implementation must take three steps in order:

1. It calibrates the quantiser from every vector in the store, when quantisation is on.
2. It builds the HNSW graph from every vector.
3. It switches its search from brute force to HNSW.

### Promotion Contract

This specification fixes what a caller observes, while an implementation chooses how it builds the graph:

- Before promotion completes, every search uses brute force and every result is exact.
- After promotion completes, every search uses HNSW and results are approximate, within the recall floors in [Cross-Implementation Result Equivalence](#cross-implementation-result-equivalence).
- During promotion, search must stay available. An implementation may keep answering by brute force while it builds the graph in the background, or it may block until the build finishes.

Three strategies satisfy that contract:

- **Synchronous promotion** blocks the insert that crosses the threshold until the implementation finishes the graph. It is the simplest strategy, and that one insert takes as long as the whole build.
- **Background promotion** returns from that insert at once and builds the graph asynchronously. Every search keeps using brute force until the graph is ready. No insert waits for the build, but each search pays for a brute-force scan until the build ends.
- **Deferred promotion** waits for the first search after the vector count crosses the threshold. Every insert then skips the construction cost, while that first search either blocks for the build or starts one in the background.

An implementation should document which strategy it uses and what that costs in latency.

### Post-Promotion Insertion

After promotion, an implementation must add each new vector to the graph in one of three ways:

- **Incremental insertion** puts each new vector straight into the graph through the standard HNSW insertion algorithm. It spreads the cost across inserts, and that cost grows with a high `efConstruction` and a large dimension, because each insert costs O(efConstruction × m × dimension) distance computations across the layers.
- **Buffered insertion** stores new vectors flat and searches them by brute force. Once the buffer reaches its size threshold, or a caller starts a maintenance operation, the implementation merges the whole buffer into the graph in one batch. That batch spreads the construction cost over many vectors, while every search covers both the buffer and the graph until the merge.
- **Segment-based insertion** puts new vectors into a new graph segment. A search covers each segment independently and merges their results, and `optimize` merges the segments. The implementation leaves existing graphs unchanged, which suits the multi-graph format in [Serialisation](#serialisation).

Incremental insertion loses throughput as the index grows, because every insert walks the graph. Buffered and segment-based insertion keep insert throughput steady, and each search does more work in exchange.

---

## Serialisation

An implementation must serialise vector index data apart from partition data. [Vector Index Payload](envelope.md#vector-index-payload) defines the payload layout.

### Storage

A vector index payload holds one part of a field. An implementation persists those parts in two places. The snapshot bundle holds them as the list under the field in its `vectorIndexes` map, and the [segmented checkpoint](durability.md#segmented-checkpoint) writes them as the payloads of the vector segment files at `<indexName>/segments/<partitionId>/vec-<fieldPath>-g<generation>-p<part>`. A partition payload that must hold its own vectors, such as one that a thread sends to another thread, embeds them as [Vector Data](envelope.md#vector-data).

### Multi-Graph Format

`graphs` is a list, so that an implementation can keep several graphs, as a segment-based implementation does.

- A single-graph implementation writes a list of length 1.
- A segment-based implementation writes one graph per segment.
- The vectors keep one ordinal order across the parts whatever the graph count, and graphs reference vectors by `docId`.

Every implementation must read a vector index file that holds any number of graphs, zero included, where zero means that the file stores vectors for brute-force search alone.

### Deserialisation Strategy

An implementation may choose what it does with the graphs that it loads. It may search each graph independently and merge the results, merge every graph into one on load, or keep the large graphs separate while it merges the small ones. The recall floors in [Cross-Implementation Result Equivalence](#cross-implementation-result-equivalence) apply whichever strategy an implementation chooses.

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

The index metadata envelope that [envelope.md](envelope.md) defines holds the vector field information, so that an implementation can find and load the vector index files without scanning storage keys:

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
