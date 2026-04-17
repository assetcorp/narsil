# Narsil Distributed Query Routing Specification

This document defines how queries are executed across a Narsil
cluster. It covers two-phase query execution, distributed fan-out,
result merging, DFS scoring, distributed facets, partial results,
cursor pagination, and replica selection.

---

## Two-Phase Query Execution

Distributed queries use a two-phase protocol that minimises
network transfer. Phase 1 transfers only document IDs and scores.
Phase 2 fetches full documents for the globally top-ranked results
only.

### Phase 1: Query

```text
1. The coordinator receives a query from the client.
2. The coordinator reads the allocation table (cached locally,
   updated via watchAllocation) to determine which partitions
   exist for the target index and which nodes hold them.
3. For each partition, the coordinator selects one replica
   (see Replica Selection below).
4. The coordinator sends the full query to each selected node
   via NodeTransport. The message includes:
   - The query parameters (term, filters, sort, limit)
   - The partition IDs to search on that node
   - Global statistics (if DFS mode, see below)
5. Each data node executes the query against its local
   partitions using the existing fanOutQuery() and kWayMerge()
   logic. Each partition runs fulltextSearch() with BM25 scoring.
6. Each data node returns to the coordinator:
   - Scored document entries (docId, score, sort values)
   - Facet counts (if facets were requested)
   - Total hit count per partition
7. The coordinator merges all results using kWayMerge()
   (heap-based for >4 sources, sequential for <=4).
8. The coordinator determines the global top-k results.
```

### Phase 2: Fetch

```text
1. The coordinator identifies which nodes hold the top-k
   documents (using the partition routing: fnv1a(docId) %
   partitionCount, then the allocation table).
2. The coordinator sends fetch requests to those specific nodes,
   requesting full document bodies for the selected document IDs.
3. Each data node retrieves the full documents from its local
   document store and vector indexes.
4. The coordinator assembles the final response:
   - Full document bodies
   - Highlighting (if requested)
   - Facets (merged in Phase 1)
   - Total hit count (sum across all partitions)
   - Coverage metadata
5. The coordinator returns the response to the client.
```

### Single-Partition Optimisation

When a query targets only one partition (e.g., a `get()` by
document ID), the coordinator sends a combined query+fetch
request to the data node holding that partition. The two phases
collapse into a single network round trip.

### Local Partition Optimisation

When the coordinator node is also a data node holding some of
the relevant partitions, it executes the query against those
partitions locally without a network round trip. Only partitions
on remote nodes go through `NodeTransport`.

```text
Coordinator (also Data Node A, holding partitions 0-4):
  Query for index 'products' (partitions 0-9):
    Local: fanOutQuery(partitions 0-4)    -> local results
    Remote: NodeTransport.query(Node B, partitions 5-9) -> remote results
    Merge: kWayMerge(local, remote)       -> global top-k
```

---

## DFS Scoring Across the Cluster

When the scoring mode is `dfs`, the coordinator collects global
term statistics before executing the query. This extends the
existing DFS protocol (see
[partitioning.md](../partitioning.md#scoring-modes)) to work
across nodes.

### DFS Protocol

```text
Phase 0 (Statistics Collection):
1. Coordinator sends a statistics request to each data node.
2. Each data node collects { totalDocs, docFrequencies,
   totalFieldLengths } from its local partitions using
   collectGlobalStats().
3. Coordinator merges all responses using mergePartitionStats().
4. The merged global statistics are included in the Phase 1
   query message.

Phase 1 (Query with Global Stats):
  Same as the standard Phase 1, but each data node scores
  documents using the provided global statistics instead of
  partition-local statistics.

Phase 2 (Fetch):
  Same as the standard Phase 2.
```

DFS mode adds one additional network round trip (Phase 0). Use it
when partition sizes or term distributions vary enough to affect
relevance ranking.

---

## Replica Selection

For each partition, the coordinator selects one replica to query.
The selection strategy is pluggable; the default is random.

### Random Selection (Default)

The coordinator picks a random replica from the set of `ACTIVE`
replicas for each partition (including the primary). This provides
even load distribution when replicas are homogeneous.

### Adaptive Selection (Optional)

An adaptive strategy tracks per-replica metrics (response time,
queue depth) and routes to the replica with the lowest estimated
latency. This is an implementation-defined optimisation. The spec
does not prescribe the adaptive algorithm, but implementations
that provide one should document its behaviour.

### Selection Contract

- The coordinator must only select replicas whose partition state
  is `ACTIVE`.
- Replicas in `INITIALISING` or `DECOMMISSIONING` states are
  excluded.
- If no `ACTIVE` replica is available for a partition, the
  coordinator either fails the query or returns partial results
  (see [Partial Results](#partial-results)).

---

## Partial Results

When some partitions are unavailable (no `ACTIVE` replica) or a
data node is slow to respond, the coordinator can return partial
results instead of failing the entire query.

### Coverage Metadata

Every query response includes coverage metadata:

```text
Coverage {
  totalPartitions:    uint32  (partitions that should be queried)
  queriedPartitions:  uint32  (partitions that responded)
  timedOutPartitions: uint32  (partitions that timed out)
  failedPartitions:   uint32  (partitions with errors)
}
```

### Partial Result Behaviour

The behaviour when partitions are unavailable is configurable:

```text
QueryConfig {
  allowPartialResults: bool  (default: true)
  partitionTimeout:    uint32  (milliseconds, default: 5000)
}
```

When `allowPartialResults` is `true` (default):
- The coordinator waits up to `partitionTimeout` for each
  data node.
- Partitions that time out or fail are excluded from the results.
- The response includes the `Coverage` metadata so the client can
  detect degraded results.
- BM25 scores may be less accurate because statistics from missing
  partitions are absent.

When `allowPartialResults` is `false`:
- Any partition failure or timeout causes the entire query to fail
  with error code `QUERY_PARTIAL_FAILURE`.

---

## Distributed Facets

When a query requests facets, each data node computes local facet
counts for its partitions. The coordinator merges these counts.

### Facet Merge Protocol

```text
1. The coordinator computes the oversampled bucket count:
     shardSize = ceil(facetSize * 1.5) + 10
   where facetSize is the client's requested bucket count
   (from QueryParams.facetSize, default 10).
2. The coordinator includes shardSize in the search request
   sent to each data node (as facetShardSize in query.search).
3. Each data node returns up to shardSize facet buckets per
   requested field, sorted by count descending.
4. The coordinator merges buckets from all data nodes:
   a. For each facet field, group buckets by value.
   b. Sum the counts for identical values.
   c. Sort by merged count descending.
   d. Truncate to facetSize.
5. The merged facets are included in the query response.
```

### Accuracy Tradeoff

Distributed facets are approximate. A term that is globally
frequent but falls below the `shardSize` threshold on individual
partitions may be undercounted or excluded entirely. Increasing
`shardSize` improves accuracy at the cost of more data transfer.

The response should include an error bound when feasible: the
sum of the largest excluded bucket count per data node. This tells
the client the maximum possible undercount for any term.

---

## Distributed Cursor Pagination

Cursor-based pagination (searchAfter) works across the cluster
by encoding the sort values of the last returned document.

### Cursor Format

The existing cursor format (see
[partitioning.md](../partitioning.md#searchafter-cursor)) extends
to distributed mode without changes. The cursor encodes:

```json
{
  "s": 4.523,
  "d": "doc-id-123"
}
```

### Distributed Cursor Flow

```text
1. First query:
   - Coordinator fans out to all data nodes.
   - Each data node returns scored results for its partitions.
   - Coordinator merges and takes top `limit` results.
   - Cursor encodes the last result's score and docId.

2. Next query (with searchAfter):
   - Coordinator decodes the cursor.
   - Fans out to all data nodes with the same cursor
     in the query parameters (searchAfter field).
   - Each data node passes the cursor to its local
     partitions. Each partition independently seeks
     past the cursor point.
   - Coordinator merges and takes top `limit`.
   - Encodes new cursor from the last result.
```

### Tiebreaker Requirement

The cursor requires a unique tiebreaker to guarantee deterministic
ordering. The document ID serves as this tiebreaker. When multiple
documents have the same score (or same sort value), they are
ordered by `docId` (lexicographic). This ensures stable pagination
across requests, even when documents have identical scores.

---

## Distributed Vector Search

Vector search follows the same two-phase protocol as text search.
Each data node searches its local vector index and returns scored
results. The coordinator merges results from all nodes.

### Vector Query Flow

```text
Phase 1:
  Coordinator sends the query vector to each data node.
  Each data node searches its local VectorIndex (HNSW or
  brute-force) and returns the top-k scored results
  (docId + similarity score).

Phase 2:
  Coordinator merges results, selects global top-k,
  fetches full documents from the relevant data nodes.
```

For HNSW-based search, each data node uses its local graph. The
approximate nature of HNSW means each node returns its best local
candidates, and the coordinator selects the global best from those.

### Distributed Hybrid Search

Hybrid search (text + vector) uses two separate fan-outs so
that the coordinator can fuse globally merged result sets.
Per-node fusion is not used because it degrades as partition
count grows.

#### Hybrid Query Flow

```text
1. The coordinator sends two search requests to each data
   node in parallel:
   a. A text-only request (term, filters, sort, limit;
      vector and hybrid fields set to null).
   b. A vector-only request (vector field populated;
      term set to null).
2. Each data node executes each request independently
   against its local partitions and returns one result set
   per request.
3. The coordinator merges all text results from all data
   nodes into a single ranked list.
4. The coordinator merges all vector results from all data
   nodes into a single ranked list.
5. The coordinator applies the configured fusion strategy
   on the two globally merged lists:
   - RRF: reciprocal rank fusion with the configured k
     constant.
   - Linear combination: weighted sum of normalised
     scores. Normalisation uses the full global score
     distribution (min/max across all nodes), not
     per-node ranges.
6. The coordinator selects the global top-k from the
   fused list.
7. Fetch phase for the top-k documents.
```

---

## Error Codes

| Code | When |
|---|---|
| `QUERY_PARTIAL_FAILURE` | A partition was unavailable and `allowPartialResults` is `false`. |
| `QUERY_NODE_TIMEOUT` | A data node did not respond within `partitionTimeout`. |
| `QUERY_ROUTING_FAILED` | The allocation table has no entry for the target index. |
| `QUERY_NO_ACTIVE_REPLICA` | No `ACTIVE` replica exists for one or more partitions. |
