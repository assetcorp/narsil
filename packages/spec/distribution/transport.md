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
  async listen(handler: (message: TransportMessage, respond: (TransportMessage) -> nothing) -> nothing) -> (() -> nothing)
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
| `replication.entry` | primary to replica | A replication log entry to apply |
| `replication.ack` | replica to primary | Acknowledges a replicated entry |
| `replication.sync_request` | replica to primary | Asks to start a sync, carrying lastSeqNo and lastPrimaryTerm |
| `replication.sync_entries` | primary to replica | A batch of log entries for incremental catch-up |
| `replication.snapshot_start` | primary to replica | Starts a snapshot transfer, carrying the snapshot header |
| `replication.snapshot_chunk` | primary to replica | One streamed chunk of snapshot data |
| `replication.snapshot_end` | primary to replica | Ends the snapshot transfer |
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

### Cluster Messages

| Type | Direction | Description |
|------|-----------|-------------|
| `cluster.ping` | any to any | Health check |
| `cluster.pong` | any to any | Health check response |
| `cluster.bootstrap_complete` | data node to controller | Reports that a partition finished bootstrapping |

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

The primary handles each operation differently. An `insert` generates the embeddings when the index configures them and then writes an `INDEX` entry. An `update` reads the existing document, merges `updateFields`, generates any embeddings that changed, and writes an `INDEX` entry. A `remove` writes a `DELETE` entry.

### replication.entry

```text
{
  entry: ReplicationLogEntry   (see replication.md)
}
```

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
- The partition is in `INITIALISING`. The check is idempotent, so an already-`ACTIVE` partition returns `true`.

The response is:

```text
{
  indexName:   string
  partitionId: uint32
  accepted:    boolean
}
```

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
  term:        string or absent
  filters:     FilterExpression or absent
  sort:        List<SortField> or absent
  group:       GroupConfig or absent
  facets:      List<string> or absent
  facetSize:   uint32 or absent   (default 10, the bucket cap per facet field)
  limit:       uint32             (default 10)
  offset:      uint32             (default 0)
  searchAfter: string or absent   (base64-encoded cursor)
  fields:      List<string> or absent   (the fields searched; absent means every text field)
  boost:       Map<string, float32> or absent   (per-field boost)
  tolerance:   uint8 or absent    (fuzzy matching tolerance)
  threshold:   float32 or absent  (minimum score)
  scoring:     'local' or 'dfs' or 'broadcast'   (default 'local')
  vector:      VectorQueryParams or absent
  hybrid:      HybridConfig or absent
}

SortField {
  field:     string
  direction: 'asc' or 'desc'
}

GroupConfig {
  field:       string
  maxPerGroup: uint32   (default 1)
}

VectorQueryParams {
  field:      string
  value:      List<float32> or absent
  text:       string or absent
  similarity: float32 or absent   (score floor; absent keeps every scored hit)
}

HybridConfig {
  strategy: 'rrf' or 'linear'
  k:        uint32    (the RRF constant, default 60)
  alpha:    float32   (the linear weight, default 0.5)
}
```

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
}

ScoredEntry {
  docId:      string
  score:      float32
  sortValues: List<value> or absent   (present when the query specifies a sort)
}

FacetBucket {
  value: string
  count: uint32
}
```

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
| InMemoryTransport | Direct function calls | Testing and single-process development |

### Community Adapter Guidelines

A community adapter, whether it carries gRPC, QUIC, HTTP/2, or Unix sockets, must:

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
