# Narsil Transport Specification

This document defines the `NodeTransport` adapter contract and the messages that travel between nodes in a cluster. One transport adapter carries both replication traffic, meaning log entries and snapshots, and query traffic, meaning search and fetch requests.

Structure definitions use a language-neutral notation. `List<T>` is an ordered collection of `T`, `Map<K, V>` a mapping from keys to values, and `T or absent` a value that may be missing, encoded as MessagePack nil on the wire. Width-tagged names such as `uint32` describe the value range, not a fixed encoding; see [Wire Format](#wire-format).

---

## NodeTransport Adapter

The `NodeTransport` adapter covers the network layer between nodes. Every method is asynchronous.

```text
NodeTransport {
  async send(target: string, message: TransportMessage) -> TransportMessage
  async stream(target: string, message: TransportMessage, handler: (chunk: bytes) -> nothing) -> nothing
  async listen(handler: (message: TransportMessage, respond: async (TransportMessage) -> nothing) -> nothing) -> (() -> nothing)
  async shutdown() -> nothing
}
```

### send(target, message)

- Sends a request to the node at `target`, which is the `address` field of that node's registration, and waits for the response.
- It carries every request-and-response exchange: query requests, fetch requests, statistics collection, and replication entry forwarding.
- An unreachable target, or one that fails to answer within the configured timeout, produces an error.
- The transport must serialise the message as MessagePack before sending and decode the response.

### stream(target, message, handler)

- Sends a request and receives a streamed response, calling `handler` once per chunk.
- It carries snapshot transfer during recovery, where the snapshot can be large enough that buffering it whole in memory is unacceptable.
- The transport handles chunking and reassembly. Chunk boundaries are the transport's own business and must never change the meaning of what arrives.

### listen(handler)

- Registers a handler for messages arriving from other nodes. The handler receives the message and a `respond` callback for the reply.
- It returns an unsubscribe function that removes the handler, so a component such as the controller can tear its listener down on step-down without shutting the whole transport down.
- A node must call `listen` before it can receive queries or replication entries.
- Calling `listen` again replaces the previous handler, and the old unsubscribe function then does nothing.
- `respond` completes once the transport has taken the reply, and a handler sending many replies must await each one before it builds the next.
- A transport whose connection reports that it is full must hold that completion until the connection accepts more, so that a snapshot cannot outrun a slow receiver and exhaust the sender's memory. A transport that buffers without limit completes immediately.

### shutdown()

- Closes every connection and stops listening.
- It must be idempotent.

---

## Transport Messages

Every message between nodes uses one envelope, serialised as MessagePack:

```text
TransportMessage {
  type:      string   (message type identifier)
  sourceId:  string   (nodeId of the sender)
  requestId: string   (unique ID that pairs a response with its request)
  payload:   bytes    (MessagePack payload, shaped by the type)
}
```

### Replication Messages

| Type | Direction | Description |
|------|-----------|-------------|
| `replication.forward` | any node to primary | Forwards a client mutation to the partition's primary |
| `replication.forward_batch` | any node to primary | Forwards many client mutations to a node that is primary for their partitions |
| `replication.entry` | primary to replica | A replication log entry to apply |
| `replication.entry_batch` | primary to replica | Contiguous log entries for one partition, applied in order |
| `replication.ack` | replica to primary | Acknowledges a replicated entry |
| `replication.sync_request` | replica to primary | Asks to start a sync, carrying lastSeqNo and lastPrimaryTerm |
| `replication.sync_entries` | primary to replica | A batch of log entries for incremental catch-up |
| `replication.snapshot_start` | primary to replica | Starts a snapshot transfer, carrying the snapshot header |
| `replication.snapshot_chunk` | primary to replica | One streamed chunk of snapshot data |
| `replication.snapshot_end` | primary to replica | Ends the snapshot transfer |
| `replication.insync_add` | primary to controller | Asks to add a caught-up replica to the in-sync set |
| `replication.insync_remove` | primary to controller | Asks to remove a replica from the in-sync set |
| `replication.insync_confirm` | controller to primary | Confirms the in-sync set update |

### Query Messages

| Type | Direction | Description |
|------|-----------|-------------|
| `query.search` | coordinator to data node | Phase 1 query with partition IDs and, under DFS, global statistics |
| `query.search_result` | data node to coordinator | Phase 1 response with scored document IDs and facet counts |
| `query.fetch` | coordinator to data node | Phase 2 fetch for specific document IDs |
| `query.fetch_result` | data node to coordinator | Phase 2 response with full document bodies |
| `query.stats` | coordinator to data node | DFS phase 0 statistics request |
| `query.stats_result` | data node to coordinator | DFS phase 0 response with partition statistics |
| `query.count` | coordinator to data node | Per-partition document counts for named partitions |
| `query.count_result` | data node to coordinator | One count entry per named partition the node holds |
| `query.list` | coordinator to data node | One id-ordered page of stored documents from named partitions |
| `query.list_result` | data node to coordinator | The page entries with the values the merge orders by |
| `query.suggest` | coordinator to data node | Prefix completions drawn from named partitions |
| `query.suggest_result` | data node to coordinator | Completions with the document frequencies the coordinator sums |
| `query.preflight` | coordinator to data node | Match count for a query over named partitions |
| `query.preflight_result` | data node to coordinator | The match count, without any hits |

### Cluster Messages

| Type | Direction | Description |
|------|-----------|-------------|
| `cluster.ping` | any to any | Health check |
| `cluster.pong` | any to any | Health check response |
| `cluster.bootstrap_complete` | data node to controller | Reports that a partition finished bootstrapping |
| `cluster.partition_stores` | controller to data node | Asks which partitions of an index the node holds on disk |

---

## Message Payloads

### replication.forward

A client mutation forwarded to the partition's primary. The primary turns it into an `INDEX` or `DELETE` log entry. The `operation` field keeps the client-facing wording, because nothing has been materialised yet.

```text
{
  indexName:    string
  documentId:   string
  operation:    'insert' or 'remove' or 'update'
  document:     bytes or absent               (the full MessagePack document, for insert and update)
  updateFields: Map<string, value> or absent  (the changed fields alone, for update)
}
```

The primary handles each operation differently. An `insert` generates the embeddings when the index configures them and then writes an `INDEX` entry. An `update` reads the existing document, merges `updateFields`, generates any embeddings that changed, and writes an `INDEX` entry. An `update` whose `document` is present and whose `updateFields` is absent replaces the stored document whole. A `remove` writes a `DELETE` entry.

### replication.forward_batch

Many client mutations forwarded in one message to a node that is primary for their partitions. The receiver groups the operations by partition, applies each group through the same path a single forwarded mutation takes, and answers one result per operation.

```text
{
  indexName:  string
  operations: List<{
    documentId:   string
    operation:    'insert' or 'remove' or 'update'
    document:     bytes or absent               (the full MessagePack document, for insert and update)
    updateFields: Map<string, value> or absent  (the changed fields alone, for update)
  }>
}
```

A sender must keep one message under 1,000 operations and under 8 MB of document bytes, and it must split a larger batch across several messages. An operation whose partition the receiver is not primary for fails in the results rather than failing the message.

The response carries one result per operation, in operation order:

```text
{
  results: List<{
    documentId:   string
    success:      boolean
    errorCode:    string or absent   (the NarsilError code, present when success is false)
    errorMessage: string or absent   (present when success is false)
  }>
}
```

### replication.entry

```text
{
  entry: ReplicationLogEntry   (see replication.md)
}
```

### replication.entry_batch

```text
{
  entries: List<ReplicationLogEntry>   (see replication.md)
}
```

The entries must belong to one partition of one index, share one `primaryTerm`, and carry contiguous ascending sequence numbers. The replica applies them in order and answers one `replication.ack` carrying the last entry's `seqNo`, which acknowledges every entry in the batch. A failure on any entry fails the whole batch.

### replication.ack

```text
{
  seqNo:       uint64
  partitionId: uint32
  indexName:   string
}
```

### replication.sync_request

```text
{
  indexName:       string
  partitionId:     uint32
  lastSeqNo:       uint64
  lastPrimaryTerm: uint64
}
```

### replication.sync_entries

```text
{
  entries: List<ReplicationLogEntry>
  isLast:  boolean   (true on the final batch)
}
```

### replication.snapshot_start

```text
{
  header:     ReplicationSnapshotHeader   (see replication.md)
  totalBytes: uint64                      (the expected total, for progress reporting)
}
```

### replication.snapshot_chunk

```text
{
  partitionId: uint32
  indexName:   string
  offset:      uint64   (byte offset within the whole snapshot)
  data:        bytes    (one chunk of snapshot data)
}
```

Chunks arrive through `stream`, and the receiver rebuilds the snapshot by writing each chunk at its offset.

### replication.snapshot_end

```text
{
  partitionId: uint32
  indexName:   string
  totalBytes:  uint64   (the final total, for verification)
  checksum:    uint32   (CRC32 of the complete snapshot)
}
```

This message says every chunk has been sent. The receiver checks that `totalBytes` matches what it accumulated and verifies the checksum before it loads the snapshot.

### replication.insync_add

The primary sends this to the active controller once a replica's applied position reaches the commit point.

```text
{
  indexName:     string
  partitionId:   uint32
  replicaNodeId: string   (the caught-up replica's nodeId)
  primaryTerm:   uint64   (the current term, which fences a stale primary)
  appliedSeqNo:  uint64   (the highest seqNo the replica has acknowledged)
  commitPoint:   uint64   (the primary's commit point when it sent the request)
}
```

The controller checks five things:

- The message's `sourceId` is the assignment's primary, which stops a replica from admitting itself.
- The node is an assigned replica of this partition.
- The `primaryTerm` matches the assignment's current term.
- The partition is in `ACTIVE`.
- `appliedSeqNo` is at or above both the assignment's stored `commitPoint` and the request's `commitPoint`.

The controller answers with `replication.insync_confirm`. It raises the assignment's `commitPoint` to the request's value whenever it accepts, and that value never moves backwards.

### replication.insync_remove

The primary sends this to the active controller, found through `getLeaseHolder('_narsil/controller')`, when a replica fails to acknowledge a replication entry.

```text
{
  indexName:     string
  partitionId:   uint32
  replicaNodeId: string   (the failed replica's nodeId)
  primaryTerm:   uint64   (the current term, which fences a stale primary)
}
```

### replication.insync_confirm

The controller sends this back to the primary once it has updated the in-sync set.

```text
{
  indexName:   string
  partitionId: uint32
  accepted:    boolean   (false when the primaryTerm was stale)
}
```

### cluster.bootstrap_complete

A data node sends this to the controller once the sync protocol finishes for a partition in `INITIALISING`. The controller validates the request and moves the partition to `ACTIVE`.

The node retries with exponential backoff when the controller is unreachable or rejects the request.

```text
{
  indexName:   string
  partitionId: uint32
  nodeId:      string   (the reporting node's nodeId)
  primaryTerm: uint64   (the primaryTerm at bootstrap time)
}
```

The controller checks four things:

- The message's `sourceId` matches the `nodeId` in the payload, which blocks spoofing.
- The node is assigned to this partition, as primary or as replica.
- The `primaryTerm` matches the assignment's current term, which rejects a completion left over from an earlier term.
- The partition is in `INITIALISING`. The controller returns `false` for an `ACTIVE` partition, because its primary admits the replica through `replication.insync_add` instead.

The response is:

```text
{
  indexName:   string
  partitionId: uint32
  accepted:    boolean
}
```

### cluster.partition_stores

The controller sends this so that it can find a copy of a partition in `UNASSIGNED` on a node that has registered again.

```text
{
  indexName: string
}
```

The response is:

```text
{
  indexName:    string
  indexUuid:    string or absent   (the identity the node holds beside its copy)
  partitionIds: List<uint32>       (the partitions the node holds on disk)
}
```

The node answers from the `held_partitions` field of its own index metadata, which [Index Metadata Payload](../envelope.md#index-metadata-payload) defines. A partition the node holds appears in the list even where that partition holds no document. A node that adopted no copy of the index answers with an absent `indexUuid` and an empty list.

### cluster.ping

```text
{
  timestamp: uint64   (the sender's wall-clock time in milliseconds)
}
```

### cluster.pong

```text
{
  timestamp:   uint64   (the ping timestamp, echoed back)
  respondedAt: uint64   (the responder's wall-clock time in milliseconds)
}
```

---

## Shared Type Definitions

These types appear in more than one payload.

### QueryParams

```text
QueryParams {
  term:          string or absent
  filters:       FilterExpression or absent
  sort:          List<SortField> or absent
  group:         GroupConfig or absent
  facets:        List<string> or absent
  facetSize:     uint32 or absent                 (default 10, the bucket cap per facet field)
  limit:         uint32                           (default 10)
  offset:        uint32                           (default 0)
  searchAfter:   string or absent                 (base64-encoded cursor)
  fields:        List<string> or absent           (the fields searched; absent means every text field)
  boost:         Map<string, float32> or absent   (per-field boost)
  tolerance:     uint8 or absent                  (fuzzy matching tolerance)
  threshold:     float32 or absent                (minimum score)
  includeScores: boolean or absent                (default false; a sorted query computes scores only where true)
  scoring:       'local' or 'dfs' or 'broadcast'  (default 'local')
  termMatch:     'all' or 'any' or uint32 or absent   (absent means 'any'; a count names the minimum matching terms)
  prefixLength:  uint32 or absent                 (leading characters exempt from tolerance; default 2)
  prefix:        boolean or absent                (default false; completes the final token)
  exact:         boolean or absent                (default false; turns off tolerance and prefix completion)
  pinned:        List<PinnedEntry> or absent
  mode:          'fulltext' or 'vector' or 'hybrid' or absent
  vector:        VectorQueryParams or absent
  hybrid:        HybridConfig or absent
}

SortField {
  field:     string
  direction: 'asc' or 'desc'
}

GroupConfig {
  fields:      List<string>
  maxPerGroup: uint32   (default 1)
}

PinnedEntry {
  docId:    string
  position: uint32   (zero-based position in the merged results)
}

VectorQueryParams {
  field:      string
  value:      List<float32> or absent
  text:       string or absent
  similarity: float32 or absent   (score floor; absent keeps every scored hit)
  metric:     'cosine' or 'dotProduct' or 'euclidean' or absent   (default 'cosine')
  efSearch:   uint32 or absent    (HNSW exploration factor; absent uses the engine default)
}

HybridConfig {
  strategy: 'rrf' or 'linear' or absent   (default 'rrf')
  k:        uint32 or absent              (the RRF constant, default 60)
  alpha:    float32 or absent             (the linear weight, default 0.5)
}
```

A sender writes an omitted member as absent and a reader restores it as omitted, so a request and its wire round trip carry one [cursor binding](../partitioning.md#cursor-binding).

The enclosing `QueryParams.limit` sets the top-k count for vector search, so `VectorQueryParams` carries no limit of its own and there is one source of truth.

`FilterExpression` is implementation-defined and matches the filter form of the Narsil query API.

### GlobalStatistics

```text
GlobalStatistics {
  totalDocuments:      uint32
  docFrequencies:      Map<string, uint32>
  totalFieldLengths:   Map<string, uint64>
  averageFieldLengths: Map<string, float32>
}
```

### HighlightConfig

```text
HighlightConfig {
  fields:           List<string> or absent   (fields to highlight; absent means every matched field)
  before:           string                   (default '<mark>')
  after:            string                   (default '</mark>')
  maxSnippetLength: uint32                   (default 200)
}
```

### query.search

```text
{
  indexName:      string
  partitionIds:   List<uint32>
  params:         QueryParams
  globalStats:    GlobalStatistics or absent   (present under DFS scoring)
  facetShardSize: uint32 or absent             (the oversampled bucket count the coordinator set)
}
```

### query.search_result

```text
{
  results: List<{
    partitionId: uint32
    scored:      List<ScoredEntry>
    totalHits:   uint32
  }>
  facets: Map<string, List<FacetBucket>> or absent
  facetErrorBounds: Map<string, uint32> or absent
}

ScoredEntry {
  docId:      string
  score:      float32 or absent       (absent when a sort suppressed scoring)
  sortValues: List<value> or absent   (present when the query specifies a sort)
}

FacetBucket {
  value: string
  count: uint32
}
```

`sortValues` carries the raw values of the sort fields, one per field in sort order, each a string, a number, a boolean, or nil, read from the document before any folding. The coordinator merges sorted results with the [sort value order](../algorithms.md#sort-value-order), so a data node must never send pre-folded or pre-transformed values.

`score` is absent where the query named a sort without `includeScores`, because a [sorted query computes no relevance scores](../algorithms.md#string-ordering), and the coordinator then merges by sort values alone.

`facetErrorBounds` holds one figure per field in `facets`, which is the largest count the node left out of that field, and 0 where the node sent every bucket it holds. A node that sends `facets` must send it, and the coordinator sums the figures across nodes to report the [error bound](query-routing.md#distributed-facets).

### query.fetch

```text
{
  indexName:   string
  documentIds: List<{
    docId:       string
    partitionId: uint32
  }>
  fields:      List<string> or absent   (field projection; absent means every field)
  highlight:   HighlightConfig or absent
}
```

### query.fetch_result

```text
{
  documents: List<{
    docId:      string
    document:   Map<string, value>
    highlights: Map<string, List<string>> or absent
  }>
}
```

### query.stats

```text
{
  indexName:    string
  partitionIds: List<uint32>
  terms:        List<string>   (the query terms to collect frequencies for)
}
```

### query.stats_result

```text
{
  totalDocuments:    uint32
  docFrequencies:    Map<string, uint32>
  totalFieldLengths: Map<string, uint64>
}
```

### query.count

```text
{
  indexName:    string
  partitionIds: List<uint32>
}
```

### query.count_result

```text
{
  partitions: List<{
    partitionId:         uint32
    documentCount:       uint32
    estimatedMemoryBytes: uint64
  }>
  language: string   (the language module the node's local index analyses with)
}
```

The node answers for exactly the named partitions it holds, one entry per partition. The coordinator treats a named partition that is missing from every response as a failure, because a count with a partition missing is a wrong count rather than a partial one.

### query.list

```text
{
  indexName:    string
  partitionIds: List<uint32>
  cursor:       string or absent            (the listing cursor, passed unchanged to every node)
  limit:        uint32
  filters:      FilterExpression or absent
  sort:         List<SortField> or absent   (field-value order; absent means document-id order)
  fields:       List<string> or absent      (field projection; absent means every field)
}
```

### query.list_result

```text
{
  entries: List<{
    docId:      string
    document:   Map<string, value>
    sortValues: List<value> or absent   (present when the request carries a sort)
  }>
  total:   uint32    (documents the listing covers in the named partitions)
  hasMore: boolean   (true when matching documents remain past the returned page)
}
```

The node lists from the named partitions alone, in the order the request names, and returns up to `limit` entries past the cursor. The coordinator merges the pages, by document id in code point order or by the [sort value order](../algorithms.md#sort-value-order) when the request sorts, truncates to the client's limit, sums `total` across responses, and encodes the next cursor from the last merged entry. The listing continues while the merge dropped entries past the client's limit or any node reported `hasMore`.

### query.suggest

```text
{
  indexName:    string
  partitionIds: List<uint32>
  prefix:       string
  limit:        uint32   (the oversampled per-node count, ceiling(clientLimit * 1.5) + 10)
}
```

### query.suggest_result

```text
{
  terms: List<{
    term:              string
    documentFrequency: uint32
  }>
  analysisStale: boolean
}
```

The node completes the prefix from the named partitions alone. The coordinator merges by term, sums the document frequencies, orders by merged frequency with ties by term in code point order, and truncates to the client's limit. The oversampled per-node count bounds the undercount the same way [Distributed Facets](query-routing.md#distributed-facets) bounds theirs, and the merged counts stay approximate for a term that falls below the per-node count somewhere.

### query.preflight

```text
{
  indexName:    string
  partitionIds: List<uint32>
  params:       QueryParams
}
```

### query.preflight_result

```text
{
  count:         uint32   (documents the query matches in the named partitions)
  analysisStale: boolean
}
```

The node counts matches in the named partitions alone, and the coordinator sums the counts. The count, list, suggest, and preflight operations fail rather than answer partially: a named partition with no `ACTIVE` copy, or a node that fails or times out, fails the whole operation, because each returns a figure a missing partition would silently falsify.

---

## Wire Format

Every transport message is serialised as MessagePack under these rules:

- An integer uses the smallest MessagePack encoding that holds the value, whether positive fixint, uint8, uint16, uint32, or uint64.
- A string is UTF-8.
- A map keeps insertion order, so one implementation encodes the same message the same way every time. Field ordering need not match across languages, and every decoder must accept any key order.
- Binary data, meaning document bodies and snapshot chunks, uses MessagePack's `bin` format.
- An absent value is MessagePack nil.

### Maximum Message Size

A transport message, streamed snapshot chunks aside, must not exceed 64 MB, which stops a sender from forcing an unbounded allocation on the receiver. A sender whose response would exceed the limit, such as a fetch result carrying many large documents, must split it across several messages or return an error.

A snapshot chunk has no per-chunk limit of its own, because the streaming protocol controls the flow.

---

## Transport Timeouts

```text
TransportConfig {
  connectTimeout:     uint32   (milliseconds, default 5000)
  requestTimeout:     uint32   (milliseconds, default 30000)
  replicationTimeout: uint32   (milliseconds, default 10000)
  snapshotTimeout:    uint32   (milliseconds, default 300000)
}
```

| Parameter | Default | Meaning |
|-----------|---------|---------|
| `connectTimeout` | 5,000 ms | The longest wait to open a connection to a peer node |
| `requestTimeout` | 30,000 ms | The longest wait for a query request and its response |
| `replicationTimeout` | 10,000 ms | The longest wait for a replication entry acknowledgement |
| `snapshotTimeout` | 300,000 ms | The longest a complete snapshot transfer may take |

---

## Built-in Transport Adapters

| Adapter | Transport | Use |
|---------|-----------|-----|
| TcpTransport | Raw TCP with MessagePack framing | Server to server, with the lowest overhead |
| GrpcTransport | gRPC over HTTP/2, per [transport.proto](transport.proto) | Server to server, where gRPC tooling and infrastructure already exist |
| InMemoryTransport | Direct function calls | Testing and single-process development |

### gRPC Carrier

The gRPC adapter implements the `narsil.transport.v1.NodeTransport` service defined in [transport.proto](transport.proto). A `Send` request and its response each carry one MessagePack-serialised `TransportMessage` in the `Envelope.message` field, so the envelope encoding in [Wire Format](#wire-format) stays the contract and gRPC only frames it. An `OpenStream` request carries its message the same way, and each `Chunk.data` in the reply stream is one chunk for the caller's handler, in order. A listener error travels as an `Envelope` reply whose message has type `error`, which keeps gRPC statuses for transport faults alone.

### Community Adapter Guidelines

A community adapter, whether it carries QUIC, HTTP/2, or Unix sockets, must:

- Serialise every message as MessagePack.
- Support `send`, `stream`, and `listen`.
- Manage the connection lifecycle, including reconnection and backoff.
- Respect the timeout configuration.
- Frame messages so that message boundaries survive the transport.

---

## Error Codes

| Code | Raised when |
|------|-------------|
| `TRANSPORT_CONNECT_FAILED` | Opening a connection to a peer node failed. |
| `TRANSPORT_TIMEOUT` | A request did not finish within its configured timeout. |
| `TRANSPORT_MESSAGE_TOO_LARGE` | A non-streaming message exceeded the 64 MB limit. |
| `TRANSPORT_DECODE_FAILED` | A received message could not be decoded, because the MessagePack was corrupt or invalid. |
| `TRANSPORT_PEER_UNAVAILABLE` | The target node cannot be reached. |
