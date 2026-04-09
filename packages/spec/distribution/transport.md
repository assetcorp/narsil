# Narsil Transport Specification

This document defines the `NodeTransport` adapter contract and the
message types that flow between nodes in a Narsil cluster. A single
transport adapter handles both replication traffic (log entries,
snapshots) and query traffic (search requests, fetch requests).

---

## NodeTransport Adapter

The `NodeTransport` adapter abstracts the network layer between
Narsil nodes. All methods are asynchronous.

### NodeTransport Definition

```text
NodeTransport {
  [async] fn send(target: string, message: TransportMessage) -> TransportMessage
  [async] fn stream(target: string, message: TransportMessage, handler: fn(chunk: bytes) -> none) -> none
  [async] fn listen(handler: fn(message: TransportMessage, respond: fn(TransportMessage) -> none) -> none) -> fn() -> none
  [async] fn shutdown() -> none
}
```

### Method Contracts

#### send(target, message)

- Sends a request to the node at `target` (the `address` field
  from `NodeRegistration`) and waits for a response.
- Used for request/response patterns: query requests, fetch
  requests, statistics collection, replication entry forwarding.
- If the target node is unreachable or does not respond within
  the transport's configured timeout, the method returns an error.
- The transport must serialise the message as MessagePack before
  sending and deserialise the response.

#### stream(target, message, handler)

- Sends a request to the target node and receives a streamed
  response. The `handler` callback fires for each chunk of data.
- Used for snapshot transfer during recovery (the snapshot can be
  large and should not be buffered entirely in memory).
- The transport handles chunking and reassembly. Chunk boundaries
  are transport-specific and must not affect the semantic content.

#### listen(handler)

- Registers a handler for incoming messages from other nodes.
- The handler receives the message and a `respond` callback to
  send the reply.
- Returns an unsubscribe function that removes the handler.
  Calling the unsubscribe function stops the node from receiving
  new messages through this handler. This allows components like
  the controller to cleanly tear down their listener on
  step-down without shutting down the entire transport.
- A node must call `listen` before it can receive queries or
  replication entries from other nodes.
- Calling `listen` again replaces the previous handler. The old
  handler's unsubscribe function becomes a no-op.

#### shutdown()

- Closes all connections and stops listening.
- Must be idempotent.

---

## Transport Messages

All messages exchanged between nodes use a common envelope. The
envelope is serialised as MessagePack.

### Message Envelope

```text
TransportMessage {
  type:      string   (message type identifier)
  sourceId:  string   (nodeId of the sender)
  requestId: string   (unique ID for request/response correlation)
  payload:   bytes    (MessagePack-encoded payload, type-specific)
}
```

### Message Types

#### Replication Messages

| Type | Direction | Description |
| ------------- | -------------------- |
| `replication.forward` | Any node -> Primary | Forward a client mutation to the partition's primary |
| `replication.entry` | Primary -> Replica | A replication log entry to apply |
| `replication.ack` | Replica -> Primary | Acknowledgement of a replicated entry |
| `replication.sync_request` | Replica -> Primary | Request to begin sync (sends lastSeqNo, lastPrimaryTerm) |
| `replication.sync_entries` | Primary -> Replica | Batch of log entries for incremental catch-up |
| `replication.snapshot_start` | Primary -> Replica | Begin snapshot transfer (sends ReplicationSnapshotHeader) |
| `replication.snapshot_chunk` | Primary -> Replica | A chunk of snapshot data (streamed) |
| `replication.snapshot_end` | Primary -> Replica | Snapshot transfer complete |
| `replication.insync_remove` | Primary -> Controller | Request to remove a replica from the in-sync set |
| `replication.insync_confirm` | Controller -> Primary | Confirmation of in-sync set update |

#### Query Messages

| Type | Direction | Description |
| ------------- | -------------------- |
| `query.search` | Coordinator -> Data | Phase 1 query request with partitionIds and optional global stats |
| `query.search_result` | Data -> Coordinator | Phase 1 response with scored document IDs and facet counts |
| `query.fetch` | Coordinator -> Data | Phase 2 fetch request with specific document IDs |
| `query.fetch_result` | Data -> Coordinator | Phase 2 response with full document bodies |
| `query.stats` | Coordinator -> Data | DFS Phase 0 statistics collection request |
| `query.stats_result` | Data -> Coordinator | DFS Phase 0 response with partition statistics |

#### Cluster Messages

| Type | Direction | Description |
| ------------- | -------------------- |
| `cluster.ping` | Any -> Any | Health check |
| `cluster.pong` | Any -> Any | Health check response |
| `cluster.bootstrap_complete` | Data -> Controller | Reports that a partition has finished bootstrapping |

---

## Message Payloads

### replication.forward

A client mutation forwarded to the partition's primary. The
primary materialises this into an `INDEX` or `DELETE` replication
log entry. The operation field uses client-facing terminology
because the mutation has not yet been materialised.

```text
{
  indexName:     string
  documentId:    string
  operation:     'insert' or 'remove' or 'update'
  document:      bytes or null  (MessagePack-encoded full document for insert/update)
  updateFields:  map[string, any] or null  (changed fields only, for update)
}
```

The primary processes this message by:

- `insert`: Generates embeddings if configured, then writes an
  `INDEX` entry to the replication log.
- `update`: Fetches the existing document, merges `updateFields`,
  generates embeddings if needed, then writes an `INDEX` entry.
- `remove`: Writes a `DELETE` entry to the replication log.

### replication.entry

```text
{
  entry: ReplicationLogEntry  (see replication.md)
}
```

### replication.ack

```text
{
  seqNo:       uint64
  partitionId: uint32
  indexName:    string
}
```

### replication.sync_request

```text
{
  indexName:        string
  partitionId:      uint32
  lastSeqNo:        uint64
  lastPrimaryTerm:  uint64
}
```

### replication.sync_entries

```text
{
  entries: array[ReplicationLogEntry]
  isLast:  bool  (true if this is the final batch)
}
```

### replication.snapshot_start

```text
{
  header: ReplicationSnapshotHeader  (see replication.md)
  totalBytes: uint64  (expected total size for progress tracking)
}
```

### replication.snapshot_chunk

```text
{
  partitionId: uint32
  indexName:    string
  offset:      uint64  (byte offset within the full snapshot)
  data:        bytes   (chunk of snapshot data)
}
```

Delivered via the `stream()` method. The receiver reconstructs the
snapshot by writing chunks in offset order.

### replication.snapshot_end

```text
{
  partitionId: uint32
  indexName:    string
  totalBytes:  uint64  (final total for verification)
  checksum:    uint32  (CRC32 of the complete snapshot)
}
```

Signals that all chunks have been sent. The receiver verifies
`totalBytes` matches the accumulated data and validates the
checksum before loading the snapshot.

### replication.insync_remove

Sent by the primary to the active controller (discovered via
`getLeaseHolder('_narsil/controller')`) when a replica fails to
acknowledge a replication entry.

```text
{
  indexName:      string
  partitionId:    uint32
  replicaNodeId:  string  (the failed replica's nodeId)
  primaryTerm:    uint64  (current term, for stale-primary protection)
}
```

### replication.insync_confirm

Sent by the controller back to the primary after updating the
in-sync set.

```text
{
  indexName:    string
  partitionId:  uint32
  accepted:     bool    (false if the primaryTerm was stale)
}
```

### cluster.bootstrap_complete

Sent by a data node to the controller after the sync protocol
completes for a partition in `INITIALISING` state. The controller
validates the request and transitions the partition to `ACTIVE`.

The node retries with exponential backoff if the controller is
unreachable or rejects the request. This follows the same pattern
as Elasticsearch's `ShardStartedClusterStateTaskExecutor`.

```text
{
  indexName:    string
  partitionId:  uint32
  nodeId:       string  (the reporting node's nodeId)
  primaryTerm:  uint64  (the primaryTerm at bootstrap time)
}
```

The controller validates:

- `sourceId` of the transport message matches `nodeId` in the
  payload (prevents spoofing).
- The node is assigned to this partition (primary or replica).
- The `primaryTerm` matches the current assignment's term
  (rejects stale completions from old primary terms).
- The partition is in `INITIALISING` state (idempotent: returns
  `true` for already-`ACTIVE` partitions).

Response:

```text
{
  indexName:    string
  partitionId:  uint32
  accepted:     bool
}
```

### cluster.ping

```text
{
  timestamp: uint64  (sender's wall-clock time in milliseconds)
}
```

### cluster.pong

```text
{
  timestamp:       uint64  (original ping timestamp, echoed back)
  respondedAt:     uint64  (responder's wall-clock time in milliseconds)
}
```

---

## Shared Type Definitions

Types referenced by multiple message payloads.

### QueryParams

```text
QueryParams {
  term:         string or null
  filters:      FilterExpression or null
  sort:         array[SortField] or null
  group:        GroupConfig or null
  facets:       array[string] or null
  limit:        uint32  (default: 10)
  offset:       uint32  (default: 0)
  searchAfter:  string or null  (base64-encoded cursor)
  fields:       array[string] or null  (searched fields, null = all text fields)
  boost:        map[string, float32] or null  (per-field boost)
  tolerance:    uint8 or null  (fuzzy matching tolerance)
  threshold:    float32 or null  (minimum score)
  scoring:      'local' or 'dfs' or 'broadcast'  (default: 'local')
  vector:       VectorQueryParams or null
  hybrid:       HybridConfig or null
}

SortField {
  field:     string
  direction: 'asc' or 'desc'
}

GroupConfig {
  field:       string
  maxPerGroup: uint32  (default: 1)
}

VectorQueryParams {
  field: string
  value: array[float32] or null
  text:  string or null
  k:     uint32
}

HybridConfig {
  strategy: 'rrf' or 'linear'
  k:        uint32  (RRF constant, default: 60)
  alpha:    float32  (linear weight, default: 0.5)
}

FilterExpression = (implementation-defined, matching the existing
  filter specification in the Narsil query API)
```

### GlobalStatistics

```text
GlobalStatistics {
  totalDocuments:      uint32
  docFrequencies:      map[string, uint32]
  totalFieldLengths:   map[string, uint64]
  averageFieldLengths: map[string, float32]
}
```

### HighlightConfig

```text
HighlightConfig {
  fields:  array[string] or null  (fields to highlight, null = all matched)
  before:  string  (default: '<mark>')
  after:   string  (default: '</mark>')
  maxSnippetLength: uint32  (default: 200)
}
```

### query.search

```text
{
  indexName:     string
  partitionIds:  array[uint32]
  params:        QueryParams  (term, filters, sort, limit, offset, etc.)
  globalStats:   GlobalStatistics or null  (present in DFS mode)
}
```

### query.search_result

```text
{
  results: array[{
    partitionId: uint32
    scored:      array[ScoredEntry]
    totalHits:   uint32
  }]
  facets: map[string, array[FacetBucket]] or null
}

ScoredEntry {
  docId:      string
  score:      float32
  sortValues: array[any] or null  (present when sort is specified)
}

FacetBucket {
  value: string
  count: uint32
}
```

### query.fetch

```text
{
  indexName:    string
  documentIds:  array[{
    docId:       string
    partitionId: uint32
  }]
  fields:       array[string] or null  (field projection, null = all)
  highlight:    HighlightConfig or null
}
```

### query.fetch_result

```text
{
  documents: array[{
    docId:    string
    document: map[string, any]
    highlights: map[string, array[string]] or null
  }]
}
```

### query.stats

```text
{
  indexName:    string
  partitionIds: array[uint32]
  terms:        array[string]  (query terms to collect frequencies for)
}
```

### query.stats_result

```text
{
  totalDocuments:    uint32
  docFrequencies:    map[string, uint32]
  totalFieldLengths: map[string, uint64]
}
```

---

## Wire Format

All transport messages are serialised as MessagePack. The encoding
follows these rules:

- Integers use the smallest MessagePack encoding that fits the
  value (positive fixint, uint8, uint16, uint32, uint64).
- Strings are UTF-8 encoded.
- Maps preserve insertion order for deterministic serialisation
  within a single implementation. Cross-language field ordering
  does not need to match; deserialisers must handle any key order.
- Binary data (document bodies, snapshot chunks) uses MessagePack's
  `bin` format.
- Null values use MessagePack's `nil`.

### Maximum Message Size

Individual transport messages (excluding streamed snapshot chunks)
must not exceed 64 MB. This prevents unbounded memory allocation
on the receiving side. If a response would exceed this limit (e.g.,
a fetch result with many large documents), the sender must split
it into multiple messages or return an error.

Snapshot chunks have no per-chunk size limit; the streaming
protocol handles flow control.

---

## Transport Timeout Configuration

```text
TransportConfig {
  connectTimeout:    uint32  (milliseconds, default: 5000)
  requestTimeout:    uint32  (milliseconds, default: 30000)
  replicationTimeout: uint32  (milliseconds, default: 10000)
  snapshotTimeout:    uint32  (milliseconds, default: 300000)
}
```

| Parameter | Default | Description |
| ------------- | -------------------- |
| `connectTimeout` | 5,000 ms | Maximum time to establish a connection to a peer node |
| `requestTimeout` | 30,000 ms | Maximum time to wait for a query request/response |
| `replicationTimeout` | 10,000 ms | Maximum time to wait for a replication entry acknowledgement |
| `snapshotTimeout` | 300,000 ms | Maximum time for a complete snapshot transfer |

---

## NodeTransport Built-in Adapters

| Adapter | Transport | Use Case |
| ------------- | -------------------- |
| TcpTransport | Raw TCP with MessagePack framing | Server-to-server, lowest overhead |
| InMemoryTransport | Direct function calls | Testing and single-process development |

### Community Adapter Guidelines

Community adapters (gRPC, QUIC, HTTP/2, Unix sockets, etc.) must:

- Serialise all messages as MessagePack.
- Support the `send`, `stream`, and `listen` methods.
- Handle connection lifecycle (reconnection, backoff).
- Respect the timeout configuration.
- Provide message framing that preserves message boundaries.

---

## Error Codes

| Code | When |
| ------------- | -------------------- |
| `TRANSPORT_CONNECT_FAILED` | Failed to establish a connection to a peer node. |
| `TRANSPORT_TIMEOUT` | A request did not complete within the configured timeout. |
| `TRANSPORT_MESSAGE_TOO_LARGE` | A non-streaming message exceeded the 64 MB limit. |
| `TRANSPORT_DECODE_FAILED` | Failed to deserialise a received message (corrupt or invalid MessagePack). |
| `TRANSPORT_PEER_UNAVAILABLE` | The target node is not reachable. |
