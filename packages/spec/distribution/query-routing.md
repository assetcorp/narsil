# Narsil Distributed Query Routing Specification

This document defines how a query runs across a Narsil cluster. It covers the two-phase protocol, fan-out, result merging, DFS scoring, distributed facets, partial results, cursor pagination, and replica selection.

---

## Two-Phase Query Execution

A distributed query runs in two phases so that the cluster moves as few bytes as possible. The first phase transfers document IDs and scores alone. The second fetches full documents for the globally top-ranked results only.

### Phase 1: Query

```text
1. The coordinator receives a query from the client.
2. It reads the allocation table, held in a local cache that
   the allocation watch keeps current, to learn which
   partitions the target index has and which nodes hold them.
3. For each partition it selects one replica; see Replica
   Selection below.
4. It sends the query to each selected node over the node
   transport. The message carries:
     the query parameters (term, filters, sort, limit)
     the partition IDs to search on that node
     the global statistics, under DFS scoring
5. Each data node runs the query against the named local
   partitions, fanning out across them and merging the
   results exactly as a single instance does.
6. Each data node returns:
     the scored entries (docId, score, sort values)
     the facet counts, when facets were requested
     the hit count for each partition
7. The coordinator merges every returned list with the K-way
   merge, which uses a heap above four sources and a
   sequential merge at four or fewer. The merge orders by
   score then document ID, or by the sort value order when
   the query sorts, as the merge algorithm in
   partitioning.md defines.
8. The coordinator takes the global top-k from the merged list.
```

### Phase 2: Fetch

```text
1. The coordinator works out which node holds each of the
   top-k documents, by routing the docId to its partition
   with fnv1a(docId) modulo partitionCount and then reading
   the allocation table.
2. It sends a fetch request to each of those nodes, naming
   the document IDs it wants.
3. Each data node reads the full documents from its local
   document store and vector indexes.
4. The coordinator assembles the response:
     the full document bodies
     highlighting, when requested
     the facets merged in phase 1
     the total hit count, summed across partitions
     the coverage metadata
5. The coordinator returns the response to the client.
```

### Single-Partition Queries

A query that targets one partition, such as fetching a document by ID, goes out as one combined query-and-fetch request to the node holding that partition. The two phases collapse into a single round trip.

### Local Partitions

A coordinator that is also a data node runs the query against its own partitions in-process and takes no round trip for them. Only partitions on other nodes go through the node transport.

```text
Coordinator, also data node A, holding partitions 0-4.
Query for index 'products', partitions 0-9:
  local:  search partitions 0-4        -> local results
  remote: send to node B, partitions 5-9 -> remote results
  merge:  K-way merge of both          -> global top-k
```

### Sorted Queries

A query carrying a sort makes each data node return the raw sort values of every entry in `ScoredEntry.sortValues`, and the coordinator merges by the [sort value order](../algorithms.md#sort-value-order). A sorted entry that arrives without its sort values cannot be merged, so the coordinator treats the node's response as a failure and [Partial Results](#partial-results) governs what happens next.

### Pinned Documents

The coordinator alone places pinned documents, after the merge and before the offset slice, so a data node serving a partition-scoped search must leave `pinned` unapplied. Each pinned document takes its zero-based position in the merged list with a score of 0, a pinned document the query also matched moves from its ranked place, and a repeated `docId` places once, at its first listed position. A position past the end clamps to the end only while every partition answered and the merge holds every match; otherwise a position at or beyond the paging depth stays off the page. The coordinator drops a pinned document no node stores, as the local engine does. A request carrying a cursor takes no pinning, because the pre-anchor prefix the positions count from is not part of the merge, and the cursor anchors on the last result that is not a pinned placement.

---

## DFS Scoring Across the Cluster

Under `dfs` scoring the coordinator collects global term statistics before it runs the query. This extends the single-instance DFS protocol described in [Scoring Modes](../partitioning.md#scoring-modes) across nodes.

```text
Phase 0, statistics collection:
  1. The coordinator sends a statistics request to each data node.
  2. Each data node collects totalDocs, docFrequencies, and
     totalFieldLengths from its local partitions.
  3. The coordinator merges every response by summing the counts.
  4. The merged statistics travel in the phase 1 query message.

Phase 1, query with global statistics:
  As above, except that each data node scores against the
  supplied global statistics in place of its own.

Phase 2, fetch:
  As above.
```

DFS costs one extra round trip. Use it when partition sizes or term distributions differ enough between partitions to move the ranking.

---

## Replica Selection

The coordinator picks one replica per partition. The strategy is pluggable, and the default is random.

**Random selection**, the default, picks a replica at random from the eligible copies of the partition, the primary included. Load spreads evenly when the replicas are alike.

**Adaptive selection** is optional. It tracks per-replica response time and queue depth and routes to the replica with the lowest estimated latency. The algorithm is implementation-defined; an implementation that offers one must document how it behaves.

The selection contract holds whichever strategy runs:

- The coordinator must select only the primary or an in-sync replica of a partition whose state is `ACTIVE`; see [In-Sync Replica Tracking](replication.md#in-sync-replica-tracking).
- Replicas in `INITIALISING` or `DECOMMISSIONING` are never selected.
- With no `ACTIVE` replica for a partition, the coordinator either fails the query or returns partial results; see [Partial Results](#partial-results).

---

## Partial Results

When a partition has no `ACTIVE` replica, or a data node answers too slowly, the coordinator can return what it has instead of failing the whole query.

### Coverage Metadata

Every query response carries coverage metadata:

```text
Coverage {
  totalPartitions:    uint32   (the partitions that should have been queried)
  queriedPartitions:  uint32   (the partitions that responded)
  timedOutPartitions: uint32   (the partitions that timed out)
  failedPartitions:   uint32   (the partitions that errored)
}
```

### Configuration

```text
QueryConfig {
  allowPartialResults: boolean  (default true)
  partitionTimeout:    uint32   (milliseconds, default 5000)
}
```

With `allowPartialResults` set to true, the coordinator waits up to `partitionTimeout` for each data node, drops the partitions that time out or fail, and returns the coverage metadata so that the client can spot a degraded answer. BM25 scores lose accuracy in that case, because the statistics of the missing partitions are missing too.

With `allowPartialResults` set to false, any partition failure or timeout fails the whole query with `QUERY_PARTIAL_FAILURE`.

---

## Distributed Facets

Each data node counts facets over its own partitions, and the coordinator merges those counts. A count covers every document the query matches rather than the documents the page returns.

```text
1. The coordinator computes the oversampled bucket count:
     shardSize = ceiling(facetSize * 1.5) + 10
   where facetSize is the bucket count the client asked for,
   from the query's facetSize parameter, 10 by default.
2. It sends shardSize to each data node as facetShardSize in
   the search message.
3. Each data node returns up to shardSize buckets per requested
   field, ordered by count, highest first, with ties by value
   in code point order, and the largest count it left out of
   that field as the field's error bound.
4. The coordinator merges the buckets:
     group the buckets of each field by value
     sum the counts of identical values
     order by merged count, highest first, ties by value in
       code point order
     truncate to facetSize
     sum the error bounds of each field across the nodes
5. The merged facets and their error bounds travel in the
   query response.
```

Distributed facet counts are approximate. A value that is frequent across the whole index but falls below `shardSize` on the individual partitions can be undercounted or missed altogether. A larger `shardSize` buys accuracy with transfer.

A response must carry one error bound per field it counts, and that figure is the largest undercount any value of the field can have. A node sets its own bound to the largest count it excluded from the field, and to 0 where it excluded nothing, so a bound of 0 on every node proves the field's counts exact. The coordinator sums the nodes' bounds rather than taking the largest, because each node undercounts a value independently of the rest.

---

## Distributed Grouping

Each data node groups its own matches and returns, per group, the group's field values and its best `maxPerGroup` entries, in the order the query orders hits. The coordinator merges groups whose field values are equal in field order, merges each merged group's entries with the K-way merge, truncates them to `maxPerGroup`, orders the groups by their first entry, score then document ID, and truncates the list to `group.limit` where the query sets one.

With no `group.limit`, every node returns every group and the merged groups are exact. With one, each node returns its top `ceiling(limit * 1.5) + 10` groups, oversampling the way [Distributed Facets](#distributed-facets) do, so a merged group's entries can miss members held by a node where the group fell below that bound.

A group reducer is a function, so it never crosses the wire. The coordinator holds the caller's reducer in-process and folds it over each merged group's fetched documents, and the HTTP server continues to refuse `group.reduce`. A hybrid query groups its text fan-out alone, as it counts facets.

---

## Distributed Cursor Pagination

Cursor pagination works across the cluster by encoding the sort position of the last document returned.

### Cursor Format

The cursor format defined in [searchAfter Cursor](../partitioning.md#searchafter-cursor) carries over to distributed mode unchanged:

```json
{
  "v": 3,
  "a": "doc-id-123",
  "s": 4.523,
  "q": "1b83aa27"
}
```

### Cursor Flow

```text
First query:
  the coordinator fans out to every data node
  each data node returns scored results for its partitions
  the coordinator merges them and takes the top `limit`
  the cursor encodes the last result

Next query, carrying the cursor:
  the coordinator decodes the cursor
  it fans out to every data node with the same cursor in the
    searchAfter parameter
  each data node passes the cursor down to its partitions, and
    each partition seeks past the cursor point on its own
  the coordinator merges the results and takes the top `limit`
  it encodes a new cursor from the last result
```

### Tiebreaker

A cursor needs a unique tiebreaker to order results deterministically, and the document ID is that tiebreaker. Documents sharing a score, or sharing every sort value, order by document ID, ascending in [code point order](../algorithms.md#code-point-order), which keeps pagination stable across requests and identical across implementations.

---

## Distributed Vector Search

Vector search follows the same two phases as text search. Each data node searches its local vector index and returns scored results, and the coordinator merges them.

```text
Phase 1:
  the coordinator sends the query vector to each data node
  each data node searches its local vector index, whether HNSW
    or brute force, and returns its top-k results as docId and
    similarity score

Phase 2:
  the coordinator merges those results, takes the global top-k,
    and fetches the full documents from the nodes holding them
```

HNSW search is approximate, so each node returns its best local candidates and the coordinator picks the global best from among them.

### Distributed Hybrid Search

A request routes as hybrid when it carries a vector and either a term or `mode: 'hybrid'`; an absent `hybrid` config fuses with RRF and its defaults. A hybrid request carrying a cursor is rejected with `SEARCH_INVALID_CURSOR`, because fused ranks do not seek.

A hybrid query runs two separate fan-outs so that the coordinator fuses two globally merged lists. Fusing on each node instead degrades as the partition count grows, because a node fuses only what its own partitions matched.

```text
1. The coordinator sends two search requests to each data node
   in parallel:
     a text-only request carrying term, filters, sort, and
       limit, with the vector, hybrid, and mode fields absent
     a vector-only request carrying the vector, with the term,
       hybrid, and mode fields absent
2. Each data node runs each request against its local
   partitions and returns one result set per request.
3. The coordinator merges every text result into one ranked list.
4. The coordinator merges every vector result into one ranked list.
5. The coordinator fuses those two lists with the configured
   strategy:
     RRF, reciprocal rank fusion with the configured k constant
     linear combination, a weighted sum of normalised scores,
       where normalisation uses the score range of the whole
       merged list rather than any single node's range
6. The coordinator takes the global top-k from the fused list.
7. The fetch phase runs for those top-k documents.
```

---

## Error Codes

| Code | Raised when |
|------|-------------|
| `QUERY_PARTIAL_FAILURE` | A partition was unavailable and `allowPartialResults` is false. |
| `QUERY_NODE_TIMEOUT` | A data node did not answer within `partitionTimeout`. |
| `QUERY_ROUTING_FAILED` | The allocation table holds no entry for the target index. |
| `QUERY_NO_ACTIVE_REPLICA` | One or more partitions have no `ACTIVE` replica. |
