# Narsil Transport Specification

This document defines the `NodeTransport` adapter contract and the messages that travel between nodes in a cluster. One transport adapter carries both replication traffic, meaning log entries and snapshots, and query traffic, meaning search and fetch requests.

Structure definitions use a language-neutral notation. `List<T>` is an ordered collection of `T`, `Map<K, V>` a mapping from keys to values, and `T or absent` a value that may be missing, which [Wire Format](#wire-format) encodes. Width-tagged names such as `uint32` describe the value range, not a fixed encoding; see [Wire Format](#wire-format).

---

## NodeTransport Adapter

The `NodeTransport` adapter covers the network layer between nodes. Every method is asynchronous.

```text
NodeTransport {
  async send(target: string, message: TransportMessage) -> TransportMessage
  async stream(target: string, message: TransportMessage, handler: (chunk: bytes) -> nothing) -> nothing
  async listen(handler: (message: TransportMessage, respond: async (TransportMessage) -> nothing) -> nothing) -> (() -> nothing)
  async shutdown() -> nothing
  timeouts: TransportConfig or absent
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
- Each chunk that `handler` receives is the payload of one `respond` call on the receiving node, whole and in order. The chunk carries no `type`, `sourceId`, or `requestId`, so a receiver tells the kinds of chunk apart by the keys that each payload holds, and a transport must never split one payload or join two.
- A stream ends once the responding handler has finished. A handler that fails must send its failure as a last chunk whose payload is the error payload that [Transport Messages](#transport-messages) defines, so that the receiver finds `error: true` in it, and each carrier below defines how a stream ends when the listener itself fails.
- Where the caller's `handler` fails on a chunk, the transport must end that stream with the handler's failure, and it must keep the connection open for every other request that shares the connection.

### listen(handler)

- Registers a handler for messages arriving from other nodes. The handler receives the message and a `respond` callback for the reply.
- It returns an unsubscribe function that removes the handler, so a component such as the controller can tear its listener down on step-down without shutting the whole transport down.
- A node must call `listen` before it can receive queries or replication entries.
- A node sends no reply to a request whose `type` it does not recognise, so the sender's wait for that request ends at its timeout. A sender of a request type that an older node can lack must therefore bound its wait and treat the timeout as a failure of that request, as a primary does with `replication.term_start`.
- Calling `listen` again replaces the previous handler, and the old unsubscribe function then does nothing.
- `respond` completes once the transport has taken the reply, and a handler sending many replies must await each one before it builds the next.
- A transport whose connection reports that it is full must hold that completion until the connection accepts more, so that a snapshot cannot outrun a slow receiver and exhaust the sender's memory. A transport that buffers without limit completes immediately.
- A transport must also complete `respond` once the connection closes or the caller cancels the request, so that the handler can finish and release the resources that it holds.

### shutdown()

- Closes every connection and stops listening.
- It must be idempotent.

### timeouts

- It reports the [Transport Timeouts](#transport-timeouts) that this transport enforces.
- A node bounds an in-sync removal and each try to complete a rollback with its `replicationTimeout`, so that both end within the wait that the transport gives a replication entry.
- A node whose transport leaves `timeouts` absent uses the defaults that [Transport Timeouts](#transport-timeouts) lists.

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

A sender must give each request a `requestId` that none of its other unanswered requests to the same node holds. A receiver must answer a request whose `requestId` repeats that of an earlier request, because a sender can reuse a `requestId` once the earlier exchange is over.

A node whose handler fails a request must answer with a message whose `type` is the request's `type` followed by `.error`, and whose payload holds the failure:

```text
{
  error:   true
  code:    string                        (the NarsilError code)
  message: string
  details: Map<string, value> or absent  (the NarsilError details)
  abandonedWrite: AbandonedWrite or absent   (on a replication.forward refusal alone; see replication.forward)
}
```

A node that answers a `send` with success must give the answer the type that this table lists for the request, or the request's own type where the table lists none:

| Request | Answer type |
|---------|-------------|
| `replication.entry`, `replication.entry_batch` | `replication.ack` |
| `replication.term_start` | `replication.term_start_ack` |
| `replication.insync_add`, `replication.insync_remove`, `replication.primary_resign` | `replication.insync_confirm` |
| `query.search`, `query.fetch`, `query.stats`, `query.count`, `query.list`, `query.suggest`, `query.preflight` | The request's type followed by `_result` |
| `cluster.ping` | `cluster.pong` |

A node that reads an answer must treat it as a failure where its type ends in `.error`, where its type is `error`, or where its payload holds `error: true`. A node must answer a request whose payload breaks the shape of its type with an error reply, and never with a success reply. On every type, the node must use `TRANSPORT_DECODE_FAILED` where the payload is not valid MessagePack, except on a `replication.sync_request`, which the primary refuses with `SNAPSHOT_SYNC_REQUEST_INVALID`. Where the payload decodes but breaks the shape, the node must use the code that the type's section gives for that fault, and where the section gives none, it must use `REPLICATION_ENTRY_INVALID` for a `replication.forward`, a `replication.forward_batch`, a `replication.entry`, a `replication.entry_batch`, or a `replication.term_start`, and `CONFIG_INVALID` for every other type.

A primary sets `abandonedWrite` on a `replication.forward.error` where `code` is `REPLICATION_OUTCOME_UNKNOWN` with the reason `term_ended` for an update or a remove whose document held a write record and whose compensating entry the primary appended. The forwarding node uses `abandonedWrite` to send the write again with its condition fields, as [Retry After an Ended Term](replication.md#retry-after-an-ended-term) defines, and it must never pass `abandonedWrite` to the client.

When a primary refuses a forwarded mutation, the node that forwarded it must pass the primary's `code`, `message`, and `details` to the client, except that it first retries a `PARTITION_NOT_PRIMARY` refusal for up to 30,000 ms. Where the refusal's details carry `heldIndexUuid`, the receiver still holds an earlier index of that name, so the forwarding node retries after a delay that starts at 50 ms and doubles up to 1,000 ms, and it reads the allocation table again before each attempt. Where the details carry `state` as `INITIALISING`, the node that received the write from the client must retry after the same delays and with the same read before each attempt, whether it forwarded the write or is the primary, so that the write can succeed once the partition is `ACTIVE`. Otherwise it retries once the allocation table names another primary or a higher `primaryTerm` for the partition. It passes the last refusal to the client when the window ends, and it retries each refused result of a batch in the same way. It retries a forward that the transport failed with `TRANSPORT_CONNECT_FAILED`, and a forward that the receiver refused with `NODE_NOT_READY`, within the same 30,000 ms and after the same delays, and it reads the allocation table again before each attempt, so that the forward reaches a primary that the controller promoted in the meantime. Neither failure can leave the write applied, because a forward that failed with `TRANSPORT_CONNECT_FAILED` never left the sender, and a node answers `NODE_NOT_READY` before it decides any write. A forward that the transport failed with `TRANSPORT_PEER_UNAVAILABLE` may have reached the primary and applied, so the forwarding node retries it only for an insert, which succeeds where it finds the document stored with the fields that it sent. It answers an update or a remove that failed in this way with `REPLICATION_OUTCOME_UNKNOWN` and the reason `forward_interrupted`, and it never sends that write again, because a second apply could overwrite a write that another client made in between. Once a forward has failed with `TRANSPORT_PEER_UNAVAILABLE`, the forwarding node answers any later refusal of that write with `REPLICATION_OUTCOME_UNKNOWN` and the reason `forward_interrupted`, because the first attempt may have applied. It applies these rules to each operation of a `replication.forward_batch` on its own. It does not retry a forward that failed with `TRANSPORT_TIMEOUT`, because the primary may still apply it. It retries a `REPLICATION_OUTCOME_UNKNOWN` refusal whose reason is `term_ended` within the same 30,000 ms, once the allocation table names another primary or a higher `primaryTerm` for the partition: an insert as above, and an update or a remove with the condition fields of [replication.forward](#replicationforward) where the refusal carries `abandonedWrite`. Where the new primary answers `DOC_ALREADY_EXISTS` to an insert that the forwarding node sent again after a `term_ended` refusal, and the node cannot read the new primary's copy of the document, the node must answer the client with the `term_ended` refusal, because the first attempt may have stored the document. It passes any other `REPLICATION_OUTCOME_UNKNOWN` refusal to the client. Where an earlier attempt of a write was refused with `REPLICATION_OUTCOME_UNKNOWN` and the reason `term_ended`, and no later attempt succeeds, the node must answer the client with that `term_ended` refusal in place of any later refusal other than `REPLICATION_WRITE_CONFLICT`, because the earlier attempt may have stored the write, while a later `PARTITION_NOT_PRIMARY` or `DOC_ALREADY_EXISTS` states only that the later attempt did not. It passes a later `REPLICATION_WRITE_CONFLICT` to the client, because the new primary decides that refusal from its copy's write record, which shows that the earlier attempt holds no effect there, as [Retry After an Ended Term](replication.md#retry-after-an-ended-term) defines. Where one write meets both `forward_interrupted` and `term_ended`, the node answers with the reason that came first, because that attempt is the first that may have stored the write. The 30,000 ms window caps the whole wait for one write, counted from its first attempt, so where the window closes while an attempt still waits for its answer, the forwarding node stops waiting and answers `REPLICATION_OUTCOME_UNKNOWN` with the reason `forward_window_ended`, because that attempt may still apply. It discards the answer of that attempt when the answer arrives, and it treats each operation of a `replication.forward_batch` that still waits in the same way. Once the window has closed, the node must send no operation of that batch that it has yet to send, because the client already holds an answer for that operation and may write the document again.

### Replication Messages

| Type | Direction | Description |
|------|-----------|-------------|
| `replication.forward` | any node to primary | Forwards a client mutation to the partition's primary |
| `replication.forward_batch` | any node to primary | Forwards many client mutations to a node that is primary for their partitions |
| `replication.entry` | primary to replica | A replication log entry to apply |
| `replication.entry_batch` | primary to replica | Contiguous log entries for one partition, applied in order |
| `replication.term_start` | primary to replica | Starts a new primary term on a copy, carrying the primary's lastSeqNo and lastPrimaryTerm |
| `replication.term_start_ack` | replica to primary | Answers a term start with the copy's own lastSeqNo and lastPrimaryTerm |
| `replication.ack` | replica to primary | Acknowledges a replicated entry |
| `replication.sync_request` | replica to primary | Asks to start a sync, carrying lastSeqNo and lastPrimaryTerm |
| `replication.sync_entries` | primary to replica | A batch of log entries for incremental catch-up |
| `replication.snapshot_start` | primary to replica | Starts a snapshot transfer, carrying the snapshot header |
| `replication.snapshot_chunk` | primary to replica | One streamed chunk of snapshot data |
| `replication.snapshot_end` | primary to replica | Ends the snapshot transfer |
| `replication.insync_add` | primary to controller | Asks to add a caught-up replica to the in-sync set |
| `replication.insync_remove` | primary or failed replica to controller | Asks to remove a replica from the in-sync set |
| `replication.insync_confirm` | controller to primary | Confirms the in-sync set update |
| `replication.primary_resign` | primary to controller | Gives up a partition whose copy failed |

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
| `cluster.partition_stores` | controller, dropping node, or primary to data node | Asks which partitions of an index the node holds on disk |
| `cluster.replication_factor` | any node to controller | Changes the replication factor of an index |
| `cluster.rebuild_analysis` | any node to data node | Rebuilds the terms of every copy of an index that the node holds |
| `cluster.rebalance` | any node to controller | Changes the partition count of an index |
| `cluster.reshard_start` | controller to primary | Starts or resumes copying one partition into the new generation |
| `cluster.reshard_forward` | primary to primary | Copies documents and removals into the new generation |
| `cluster.reshard_cutover` | controller to primary | Blocks or lifts writes for the cutover |
| `cluster.reshard_purge` | primary to primary | Removes one old partition's documents from the new generation |
| `cluster.backup` | any node to controller | Backs up an index to the store |
| `cluster.backup_restore` | any node to controller | Restores a backup as a new index |
| `cluster.backup_delete` | any node to controller | Deletes a backup and the files that no other backup lists |
| `cluster.backup_partition` | controller to primary | Saves one partition of a backup |
| `cluster.restore_partition` | controller to primary | Loads one partition of a restore |
| `cluster.index_settings` | any node to data node | Asks a node to apply the synonym set that the coordinator holds for an index |

### Sync Messages

| Type | Direction | Description |
|------|-----------|-------------|
| `sync.read` | any node to primary | Reads the entries of one partition for a [device feed](../sync.md#the-feed) or a [change feed](../changes.md#the-feed) |

### Suggestion Messages

| Type | Direction | Description |
|------|-----------|-------------|
| `suggestions.counts` | any node to any node | Streams the [query counts](../query-suggestions.md#history) of one index that the node holds |
| `suggestions.build` | any node to controller | Asks for a [build](../query-suggestions.md#building) of the suggestions of one index |

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
  indexUuid:    string or absent              (the identity of the index that the sender's allocation table names)
  ifSeqNo:              uint64 or absent   (the write record that the document must hold, with ifPrimaryTerm)
  ifPrimaryTerm:        uint64 or absent
  abandonedSeqNo:       uint64 or absent   (the failed entry that the earlier primary appended)
  abandonedPrimaryTerm: uint64 or absent   (the term of that entry and of its compensating entry)
  compensationSeqNo:    uint64 or absent   (the compensating entry that the earlier primary appended)
}

AbandonedWrite {
  seqNo:               uint64   (the failed entry)
  primaryTerm:         uint64   (the term of the failed entry and of its compensating entry)
  compensationSeqNo:   uint64   (the compensating entry)
  previousSeqNo:       uint64   (the document's write record from before the failed entry)
  previousPrimaryTerm: uint64
}
```

The five condition fields, `ifSeqNo`, `ifPrimaryTerm`, `abandonedSeqNo`, `abandonedPrimaryTerm`, and `compensationSeqNo`, travel together or not at all. A sender sets them only on an `update` or a `remove` that it sends again as [Retry After an Ended Term](replication.md#retry-after-an-ended-term) defines, taking `ifSeqNo` and `ifPrimaryTerm` from the `previousSeqNo` and `previousPrimaryTerm` of the `AbandonedWrite` that the earlier primary answered, and the other three from its `seqNo`, `primaryTerm`, and `compensationSeqNo`. A primary that receives them decides the write under the rules of that section. A primary must refuse with `REPLICATION_ENTRY_INVALID` a forward that carries some of the five fields but not all of them, and one that carries them on an `insert`.

A primary that applies the write must answer with this payload:

```text
{
  documentId: string   (the ID of the document that the write stored or removed)
  success:    true
}
```

The primary handles each operation differently. An `insert` generates the embeddings when the index configures them and then writes an `INDEX` entry. An `update` whose `document` is present replaces the stored document whole and ignores `updateFields`. An `update` that carries `updateFields` alone reads the stored document, sets each top-level key of `updateFields` on it in place of the value that the key held, generates any embeddings that changed, and writes an `INDEX` entry, and the primary must refuse it with `DOC_NOT_FOUND` where it stores no document under `documentId`. The primary must read the stored document for such an update inside the partition's write queue, after it decides each earlier operation on that document in the same message, so that the update keeps the fields that an earlier update sets. A primary must refuse with `REPLICATION_ENTRY_INVALID` an `insert` without a `document` and an `update` with neither field. A `remove` writes a `DELETE` entry.

A receiver that holds its copy of the partition under an `indexUuid` other than the one a request carries must refuse the request, because the name now belongs to another index: a forward with `PARTITION_NOT_PRIMARY`, a replication entry or batch with `INDEX_NOT_FOUND`, and a sync request with `SNAPSHOT_SYNC_INDEX_NOT_FOUND`. Where the request carries no `indexUuid`, the receiver skips this check. A forward refusal of this kind must carry `heldIndexUuid`, the `indexUuid` of the copy that the receiver holds, in its details.

### replication.forward_batch

Many client mutations forwarded in one message to a node that is primary for their partitions. The receiver groups the operations by partition, applies each group through the same path a single forwarded mutation takes, and answers one result per operation.

```text
{
  indexName:  string
  operations: List<{
    documentId:           string
    operation:            'insert' or 'remove' or 'update'
    document:             bytes or absent               (the full MessagePack document, for insert and update)
    updateFields:         Map<string, value> or absent  (the changed fields alone, for update)
    ifSeqNo:              uint64 or absent              (the condition fields of replication.forward)
    ifPrimaryTerm:        uint64 or absent
    abandonedSeqNo:       uint64 or absent
    abandonedPrimaryTerm: uint64 or absent
    compensationSeqNo:    uint64 or absent
  }>
  indexUuid:  string or absent   (the identity of the index that the sender's allocation table names)
}
```

A sender must put between 1 and 1,000 operations in one message, and it must split a larger batch across several messages so that the documents of one message hold at most 8,388,608 bytes, unless one document alone holds more. A primary must refuse with `REPLICATION_ENTRY_INVALID` a message that holds no operation or more than 1,000. An operation whose partition the receiver is not primary for fails in the results, and the other operations of the message proceed.

The response carries one result per operation, in operation order:

```text
{
  results: List<{
    documentId:   string
    success:      boolean
    errorCode:    string or absent   (the NarsilError code, present when success is false)
    errorMessage: string or absent   (present when success is false)
    errorDetails: Map<string, value> or absent   (the NarsilError details, when success is false)
    abandonedWrite: AbandonedWrite or absent     (see replication.forward)
  }>
}
```

The node that forwarded the batch must pass each failed result's `errorCode`, `errorMessage`, and `errorDetails` to the client. A result carries `abandonedWrite` where its `errorCode` is `REPLICATION_OUTCOME_UNKNOWN` with the reason `term_ended` for an update or a remove whose document held a write record and whose compensating entry the primary appended. The forwarding node uses `abandonedWrite` to send that operation again with its condition fields, as [Retry After an Ended Term](replication.md#retry-after-an-ended-term) defines, and it must never pass `abandonedWrite` to the client.

### replication.entry

```text
{
  entry: ReplicationLogEntry   (see replication.md)
  indexUuid: string or absent   (the identity of the index that the sender's allocation table names)
  previousPrimaryTerm: uint64 or absent   (the term that the sender's term history gives for the seqNo before the entry, 0 where the entry's seqNo is 1)
}
```

### replication.entry_batch

```text
{
  entries: List<ReplicationLogEntry>   (see replication.md)
  indexUuid: string or absent   (the identity of the index that the sender's allocation table names)
  previousPrimaryTerm: uint64 or absent   (the term that the sender's term history gives for the seqNo before the first entry, 0 where that entry's seqNo is 1)
}
```

A primary must set `previousPrimaryTerm` on every `replication.entry` and `replication.entry_batch` that it sends, including the entries of a rollback and of the [Catch-Up Feed](replication.md#catch-up-feed), wherever its [term history](replication.md#term-history) covers the `seqNo` before the first entry. A replica checks it as [Log Matching](replication.md#log-matching) defines, and it skips the check where the field is absent, so that a primary from before this field can still replicate to it during a rolling upgrade.

The entries must belong to one partition of one index, share one `primaryTerm`, and carry contiguous ascending sequence numbers. The replica applies them in order and answers one `replication.ack` carrying the last entry's `seqNo`, which acknowledges every entry in the batch. A failure on any entry fails the whole batch.

### replication.term_start

```text
{
  indexName:       string
  partitionId:     uint32
  primaryTerm:     uint64   (the term that the sender starts)
  lastSeqNo:       uint64   (the sender's highest seqNo, 0 for an empty log)
  lastPrimaryTerm: uint64   (the term that the sender's term history gives for lastSeqNo, 0 for an empty log)
  indexUuid:       string or absent   (the identity of the index that the sender's allocation table names)
}
```

A new primary sends this to every other copy in the in-sync set, as [Starting a Term](replication.md#starting-a-term) defines. A replica that holds its copy under another `indexUuid` refuses it with `INDEX_NOT_FOUND`, in the same way as a replication entry.

### replication.term_start_ack

```text
{
  indexName:       string
  partitionId:     uint32
  lastSeqNo:       uint64   (the replica's highest seqNo, 0 for an empty log)
  lastPrimaryTerm: uint64   (the term that the replica's term history gives for lastSeqNo, 0 for an empty log)
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
  indexUuid:       string or absent   (the identity of the index that the sender's allocation table names)
  syncSession:     string or absent   (the session of the sync that the replica applied, absent where the request opens a sync)
}
```

A replica opens a sync with a request that carries no `syncSession`. Once it has applied that sync, it reports its new position in a second request that carries the `syncSession` of the sync that it applied, as [Catch-Up Feed](replication.md#catch-up-feed) defines.

A primary must answer a `replication.sync_request` through `stream` with the payloads of one of these two sequences:

```text
incremental catch-up:
  one or more replication.sync_entries
full snapshot:
  replication.snapshot_start
  zero or more replication.snapshot_chunk
  replication.snapshot_end
  one or more replication.sync_entries
```

The primary must send the entries of one answer in sequence-number order with no gap, from the request's `lastSeqNo` + 1 for an incremental catch-up and from the snapshot header's `lastSeqNo` + 1 after a snapshot. The primary must split those entries into batches that each fit within the [Maximum Message Size](#maximum-message-size), and it must set `isLast` to true on the last batch alone.

A replica must tell the payloads of one answer apart by their keys: a payload with `error: true` is an error reply, a payload with `entries` or `isLast` is a `replication.sync_entries`, the first other payload is the `replication.snapshot_start`, a payload with `offset` and `data` is a `replication.snapshot_chunk`, and a payload with `totalBytes` and `checksum` is the `replication.snapshot_end`. A replica must stop reading the answer at the first payload that follows the batch that sets `isLast`, and it must report `SNAPSHOT_SYNC_DECODE_FAILED` where that payload is not valid MessagePack, `SNAPSHOT_SYNC_PRIMARY_ERROR` where it is an error reply, and `SNAPSHOT_SYNC_FRAME_INVALID` for any other payload, because the replica can read keys only from a payload that decodes, and an error reply carries the primary's reason.

A primary that refuses or abandons a sync must send an error reply as the last payload of the answer, with one of these codes:

| Code | Sent when |
|------|-----------|
| `SNAPSHOT_SYNC_REQUEST_INVALID` | The request is malformed, or its `lastPrimaryTerm` is above the primary's term |
| `SNAPSHOT_SYNC_ALLOCATION_UNAVAILABLE` | The primary could not read the allocation table |
| `SNAPSHOT_SYNC_UNAUTHORIZED` | The index has no allocation, the receiving node is not the partition's primary, or the sender holds no copy of the partition |
| `SNAPSHOT_SYNC_NOT_ASSIGNED` | The partition has no assignment, or each copy of the index that the sender holds is in a state other than `ACTIVE`, `INITIALISING`, or `MIGRATING` |
| `SNAPSHOT_SYNC_INDEX_NOT_FOUND` | The primary holds no copy of the index, or holds one under another `indexUuid` |
| `SNAPSHOT_SYNC_CAPACITY_EXHAUSTED` | The primary is sending as many snapshots as its limits allow |
| `SNAPSHOT_SYNC_SNAPSHOT_FAILED` | The primary could not build the snapshot |
| `REPLICATION_SYNC_FAILED` | The request reports a sync that is not the sender's current one |

A replica must use these codes for the failures that it finds during a sync, and it reports each one as the `innerCode` of `NODE_BOOTSTRAP_FAILED`, as [Joining the Cluster](cluster.md#joining-the-cluster) defines:

| Code | Raised when |
|------|-------------|
| `SNAPSHOT_SYNC_ALLOCATION_UNAVAILABLE` | The replica could not read the allocation table, or the coordinator holds none for the index |
| `SNAPSHOT_SYNC_NOT_ASSIGNED` | The replica finds no assignment for the partition, or finds another primary in it |
| `SNAPSHOT_SYNC_SCHEMA_UNAVAILABLE` | The replica could not read the index's schema or found none, or its read of the index metadata failed with an error that has no code |
| `SNAPSHOT_SYNC_NO_TARGETS` | The replica could not resolve an address of the primary |
| `SNAPSHOT_SYNC_TRANSPORT_FAILED` | The request failed in transport, the report of the synced position failed in transport or timed out, or the primary answered that report with a snapshot |
| `SNAPSHOT_SYNC_TIMEOUT` | The sync passed its deadline, or no time remained for the report of the synced position |
| `SNAPSHOT_SYNC_DECODE_FAILED` | A payload of the answer is not valid MessagePack |
| `SNAPSHOT_SYNC_FRAME_INVALID` | A payload breaks the shape or the order of the answer, the answer carries two sync sessions, or `isLast` is missing from the last batch or set on an earlier one |
| `SNAPSHOT_SYNC_CHUNK_MISSING` | The answer ended with no sync payload, or with fewer snapshot bytes than `totalBytes` |
| `SNAPSHOT_SYNC_HEADER_INVALID` | The first snapshot payload is not a `replication.snapshot_start`, or its header, its `totalBytes`, or its `syncSession` breaks the type that the message gives |
| `SNAPSHOT_SYNC_HEADER_MISMATCH` | The snapshot header, a chunk, or the end names an index or a partition other than the one that the request names, a chunk's `partitionId` is not a non-negative integer, or the end's `totalBytes` differs from the start's |
| `SNAPSHOT_SYNC_CHUNK_OUT_OF_ORDER` | A chunk's `offset` is not a non-negative integer, or it differs from the offset where the chunk before it ended |
| `SNAPSHOT_SYNC_CHUNK_SIZE_EXCEEDED` | A chunk carries more than 65,536 bytes, or more than the bytes of `totalBytes` that remain |
| `SNAPSHOT_SYNC_CHUNK_OVERFLOW` | The bytes received would pass `totalBytes` after a chunk that the size check let through |
| `SNAPSHOT_SYNC_END_MISSING` | The answer ended after a `replication.snapshot_start` with no `replication.snapshot_end` |
| `SNAPSHOT_SYNC_CHECKSUM_MISMATCH` | The end's `checksum` differs from the header's, or the CRC32 of the received archive differs from the header's `checksum` |
| `SNAPSHOT_SYNC_PRIMARY_ERROR` | The primary sent an error reply, whose `code` and `message` the replica copies into the details as `primaryCode` and `primaryMessage` |
| `SNAPSHOT_SYNC_RESTORE_FAILED` | The replica could not create, check, write, or restore its local copy |

An error from a schema check, a metadata read, or an entry check must keep the code that it has. A node must also report `SNAPSHOT_SYNC_RESTORE_FAILED` directly to its error handler where a primary's copy fails the schema check during its bootstrap or where the node cannot drop a copy that it removes.

A replica may send the request to the primary's next address within the same sync after `SNAPSHOT_SYNC_TRANSPORT_FAILED`, `SNAPSHOT_SYNC_TIMEOUT`, `SNAPSHOT_SYNC_DECODE_FAILED`, `SNAPSHOT_SYNC_FRAME_INVALID`, `SNAPSHOT_SYNC_CHUNK_MISSING`, `SNAPSHOT_SYNC_CHUNK_OUT_OF_ORDER`, `SNAPSHOT_SYNC_CHUNK_OVERFLOW`, `SNAPSHOT_SYNC_END_MISSING`, or `SNAPSHOT_SYNC_CHECKSUM_MISMATCH`, or where `primaryCode` is `SNAPSHOT_SYNC_ALLOCATION_UNAVAILABLE`, `SNAPSHOT_SYNC_CAPACITY_EXHAUSTED`, `SNAPSHOT_SYNC_SNAPSHOT_FAILED`, or `REPLICATION_SYNC_FAILED`. It must end the sync on every other code in these two tables, although it may start a new sync after the backoff of its bootstrap, whatever the code.

### replication.sync_entries

```text
{
  entries:     List<ReplicationLogEntry>
  isLast:      boolean   (true on the final batch)
  syncSession: string    (the session that the primary opened for this sync)
}
```

### replication.snapshot_start

```text
{
  header:      ReplicationSnapshotHeader   (see replication.md)
  totalBytes:  uint64                      (the size of the snapshot archive in bytes)
  syncSession: string                      (the session that the primary opened for this sync)
}
```

### replication.snapshot_chunk

```text
{
  partitionId: uint32
  indexName:   string
  offset:      uint64   (byte offset within the snapshot archive)
  data:        bytes    (one chunk of the archive)
}
```

The sender delivers chunks through `stream`, and the receiver rebuilds the [snapshot archive](../durability.md#snapshot-archive) by writing each chunk at its offset. The sender must put at most 65,536 bytes in each chunk, must start the first chunk at offset 0, and must start each later chunk at the offset where the chunk before it ended. A receiver must refuse a chunk that breaks one of these rules or that would carry the archive past `totalBytes`.

### replication.snapshot_end

```text
{
  partitionId: uint32
  indexName:   string
  totalBytes:  uint64   (the final total, for verification)
  checksum:    uint32   (CRC32 of the complete archive)
}
```

The sender sends this message after the last chunk, with the `totalBytes` of the `replication.snapshot_start` and the `checksum` of its header. Before it applies the archive, the receiver must check that both values match the start message and that it received exactly `totalBytes` bytes whose CRC32 equals `checksum`.

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
  inSyncVersion: uint64   (the assignment's inSyncVersion that the primary last read)
  replicaStartedAt: string   (the startedAt of the replica's registration, which the primary read before it sent the proof)
}
```

The controller checks eight things:

- The message's `sourceId` is the assignment's primary, which stops a replica from admitting itself.
- The node is an assigned replica of this partition.
- The `primaryTerm` matches the assignment's current term.
- The partition is in `ACTIVE`.
- `appliedSeqNo` is at or above both the assignment's stored `commitPoint` and the request's `commitPoint`.
- The replica's node is registered with the cluster coordinator, because the controller removes an unregistered node from the in-sync set on its next allocator run.
- The replica's registered `startedAt` equals `replicaStartedAt`, which the controller checks in the same atomic operation as the write that adds the replica, through the `replicaRegistration` of [putAllocation](cluster.md#getallocationindexname-and-putallocationindexname-table-expectedversion-writernodeid-replicaregistration), because a node that restarted after it acknowledged the proof can hold an empty copy.
- `inSyncVersion` equals the assignment's stored [inSyncVersion](cluster.md#insyncversion), because a request that the primary sent before a removal must never add the replica back.

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

A replica whose copy of the partition failed sends this request for itself, as [Copy Failure](replication.md#copy-failure) defines, with `replicaNodeId` set to its own `nodeId` and `primaryTerm` set to the term in the allocation table. The controller accepts a request whose `sourceId` is the assignment's primary or the `replicaNodeId`, and it refuses every other sender. It accepts the request for a replica already outside the in-sync set, and it still raises the partition's [inSyncVersion](cluster.md#insyncversion) with a table write, so that an admission request still in flight for that replica can never add it back.

### replication.insync_confirm

The controller sends this back to the primary once it has updated the in-sync set.

```text
{
  indexName:   string
  partitionId: uint32
  accepted:    boolean   (false when the primaryTerm was stale)
}
```

### replication.primary_resign

A primary whose copy of a partition failed sends this to the active controller, as [Copy Failure](replication.md#copy-failure) defines.

```text
{
  indexName:   string
  indexUuid:   string
  partitionId: uint32
  primaryTerm: uint64   (the term at which the sender leads the partition)
}
```

The controller must refuse the request unless the message's `sourceId` is the assignment's primary, `primaryTerm` equals the assignment's term, and `indexUuid` equals the index that the coordinator holds. The controller then acts as [Failover](replication.md#failover) defines for a lost primary, and it writes the allocation table with a compare-and-set on the version that it read. It answers with `replication.insync_confirm`, whose `accepted` is false when it refused the request or its compare-and-set failed.

### cluster.bootstrap_complete

The primary of a partition in `INITIALISING` sends this to the controller once its copy is ready. The controller validates the request and moves the partition to `ACTIVE`. A replica sends none, because its primary admits it through `replication.insync_add` once the partition is `ACTIVE`.

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
- The node is the partition's primary, because the partition serves only once its primary holds a copy.
- The `primaryTerm` matches the assignment's current term, which rejects a completion left over from an earlier term.
- The partition is in `INITIALISING`. The controller returns `false` to a replica, and for an `ACTIVE` partition, because the primary admits each replica through `replication.insync_add`.

The response is:

```text
{
  indexName:   string
  partitionId: uint32
  accepted:    boolean
}
```

### cluster.partition_stores

The controller sends this so that it can find a copy of a partition in `UNASSIGNED` on a node that has registered again. The node that received a drop request sends it to confirm that no data node still holds a copy, as [Index Deletion Flow](cluster.md#index-deletion-flow) describes. A primary sends it to a replica before an admission request where its log retains no entry at the replica's position, as [Catch-Up Feed](replication.md#catch-up-feed) describes.

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

The node must list each partition in the `held_partitions` field of its index metadata, which [Index Metadata Payload](../envelope.md#index-metadata-payload) defines, and each partition whose copy holds a document, in ascending order, so that a partition that holds no document appears and a copy written before `held_partitions` existed stays recoverable. It must leave out a partition whose copy failed until that copy reloads cleanly from the node's checkpoint and log. A node that adopted no copy of the index answers with an absent `indexUuid` and an empty list.

### cluster.replication_factor

A node sends this to the active controller, which it finds with `getLeaseHolder`, to change the replication factor of an index.

```text
{
  indexName:         string
  replicationFactor: uint8
}
```

The controller refuses the request with `NODE_NOT_CONTROLLER` where it holds no controller lease, with `CONFIG_INVALID` where the factor is not an integer from 0 to 255, and with `INDEX_NOT_FOUND` where the coordinator holds no metadata for the index. Otherwise it stores the factor in the index metadata with `compareAndSet`, writes the allocation table, and answers with the same payload. [Index Creation Flow](cluster.md#index-creation-flow) gives the rules for applying the new factor.

### cluster.rebuild_analysis

A node sends this to every node that holds a copy of an index, as [Index Creation Flow](cluster.md#index-creation-flow) describes for a rebuild.

```text
{
  indexName: string
  indexUuid: string   (the identity that the coordinator holds for the index)
  generation:   uint64 or absent                  (a pending change; an absent value asks for a revision rebuild)
}
```

A node that holds no copy under that `indexUuid` answers with an empty list, so that it never rebuilds an index of the same name that a caller created again. Otherwise it answers once each rebuild finishes:

```text
{
  indexName:         string
  rebuiltPartitions: List<uint32>   (the copies that it rebuilt, leaving out each copy that was already current)
  generation:   uint64 or absent    (the generation of the request, absent where the request carried none)
}
```

A node must refuse with `CONFIG_INVALID` a request whose `generation` is present and below 1.

### cluster.rebalance

A node sends this to the active controller to start a [partition count change](cluster.md#partition-count-change).

```text
{
  indexName:            string
  targetPartitionCount: uint32
}
```

The controller refuses the request with `NODE_NOT_CONTROLLER` where it holds no controller lease, with `INDEX_NOT_FOUND` where the coordinator holds no metadata for the index, with `CONFIG_INVALID` for a count that the creation flow would refuse or that equals the current count, and with `PARTITION_REBALANCING_BACKPRESSURE` while another change to the index runs. Otherwise it answers once it has written the record:

```text
{
  indexName:        string
  jobId:            string
  targetGeneration: string
}
```

### cluster.reshard_start

The controller sends this to the primary of a partition of the current generation, at the start of the copy and again after it promotes a new primary.

```text
{
  indexName:            string
  jobId:                string
  sourceGeneration:     string
  targetGeneration:     string
  partitionId:          uint32
  sourcePartitionCount: uint32
  targetPartitionCount: uint32
}
```

A repeat with the same `jobId` and `partitionId` changes nothing while the copy for that partition runs. The primary answers:

```text
{
  jobId:         string
  partitionId:   uint32
  snapshotSeqNo: uint64
}
```

### cluster.reshard_forward

A primary of the current generation sends this to a primary of the new generation.

```text
{
  targetGeneration:  string
  jobId:             string
  sourcePartitionId: uint32
  sourcePrimaryTerm: uint64
  operations:        List<{
    documentId: string
    operation:  'replace' or 'remove'
    document:   bytes or absent   (the encoded document, present for replace)
  }>
}
```

The receiving primary must refuse the batch with `ALLOCATION_FAILED` where no rebalance record gives `jobId` as its job and `targetGeneration` as its new generation, because an operation of the batch skips the checks of a client write. The receiving primary refuses the batch with `REPLICATION_TERM_MISMATCH` where `sourcePrimaryTerm` is lower than the highest that it has accepted for that `jobId` and `sourcePartitionId`. Otherwise it replicates each operation as an ordinary entry, and it answers with one result per operation, in the shape of the results of [replication.forward_batch](#replicationforward_batch).

### cluster.reshard_cutover

The controller sends this to the primary of each partition of the current generation.

```text
{
  indexName:   string
  jobId:       string
  partitionId: uint32
  action:      'block' or 'lift'
}
```

The primary answers once every write that it accepted before a `block` has finished:

```text
{
  jobId:       string
  partitionId: uint32
  lastSeqNo:   uint64   (the primary's forwardable end after a block, and 0 after a lift)
}
```

A primary must refuse with `ALLOCATION_FAILED` a `block` whose `jobId` differs from the job of the rebalance record of `indexName`, or that arrives where `indexName` holds no such record.

### cluster.reshard_purge

A primary of the current generation sends this to every primary of the new generation before it restarts its copy from a new snapshot.

```text
{
  targetGeneration:     string
  jobId:                string
  sourcePartitionCount: uint32
  sourcePartitionId:    uint32
}
```

The receiving primary must refuse the request with `ALLOCATION_FAILED` where no rebalance record gives `jobId` as its job and `targetGeneration` as its new generation, or where `targetGeneration` is not a hidden generation whose partitions it leads, because the purge removes documents without a client's request. Otherwise each receiving primary removes every document that it holds in `targetGeneration` whose ID routes to `sourcePartitionId` under `sourcePartitionCount`, and it answers:

```text
{
  removed: uint32
}
```

### cluster.backup

A node sends this to the active controller to [take a backup](backups.md#taking-a-backup).

```text
{
  backupName: string
  indexName:  string
  takenBy:    string or absent   ("sync" for a backup that device sync starts, and "changes" for one that change capture starts)
  queryHistory: boolean or absent (true where the caller asks for query history)
}
```

The controller refuses it with `NODE_NOT_CONTROLLER` where it holds no controller lease, and with the errors that the flow lists. Otherwise it answers once it has recorded the job:

```text
{
  jobId: string
}
```

### cluster.backup_restore

A node sends this to the active controller to [restore a backup](backups.md#restoring-a-backup).

```text
{
  backupName:        string
  indexName:         string
  replicationFactor: uint8 or absent    (the backup's factor where absent)
  constraints:       AllocationConstraints or absent   (the backup's constraints where absent)
}
```

The controller refuses and answers as it does for `cluster.backup`.

### cluster.backup_delete

A node sends this to the active controller to [delete a backup](backups.md#deleting-a-backup).

```text
{
  backupName: string
}
```

The controller refuses and answers as it does for `cluster.backup`.

### cluster.backup_partition

The controller sends this to the primary of one partition, at the start of a backup, again after it promotes a new primary, and again to learn the partition's state.

```text
{
  jobId:       string
  backupName:  string
  indexName:   string   (the generation that serves the index)
  partitionId: uint32
}
```

A repeat with the same `jobId` and `partitionId` starts nothing new while the partition runs. The primary answers with its state:

```text
{
  jobId:       string
  partitionId: uint32
  status:      'running' or 'done' or 'failed'
  result:      BackupPartitionResult or absent   (present when done)
  error:       { code: string, message: string } or absent   (present when failed)
}

BackupPartitionResult {
  partition:     BackupPartition   (as backups.md defines)
  config:        StoredFile
  filesStored:   uint32            (the files that this partition saved)
  bytesStored:   uint64
}
```

A primary keys each task by `jobId`, `indexName`, and `partitionId`. It must start the task on the first request for that key, answer `running` until the task ends, and keep a `done` answer for 600,000 ms after the task ends. It must forget a failed task once it has answered `failed`, so that the next request starts the task again.

The controller must send the request again every 500 ms while the answer is `running`. It must also send it again, for up to 120,000 ms after its first request or after the last `running` answer, after a refusal with `QUERY_NO_ACTIVE_REPLICA`, `PARTITION_NOT_PRIMARY`, `NODE_NOT_READY`, or `NODE_NOT_JOINED`, and it must fail the partition on any other refusal.

### cluster.restore_partition

The controller sends this to the primary of one partition of the generation that a restore creates, and again to learn the partition's state.

```text
{
  jobId:       string
  backupName:  string
  indexName:   string   (the generation)
  partitionId: uint32
}
```

The primary reads the backup's manifest itself, and it answers with the state as it does for `cluster.backup_partition`, without `result`.

### cluster.index_settings

A node sends this to each node that holds a partition of an index once it replaces the synonym set of that index, as [Synonym Set Replacement Flow](cluster.md#synonym-set-replacement-flow) defines.

```text
{
  indexName: string   (the generation that serves the index)
  indexUuid: string   (the identity of that generation, whose synonym set changed)
}
```

The response is:

```text
{
  indexName: string
  applied:   boolean   (false where the node holds no copy under that indexUuid)
}
```

The receiving node must read the index metadata and the synonym set from the coordinator itself, so that the newest stored set wins when two replacements reach it out of order. It must answer only once its copy and every worker copy of it apply the stored set. A node that holds no copy under that `indexUuid` answers with `applied` false, because it applies the stored set when it creates its copy.

### sync.read

A node sends this to the primary of one partition to read the entries that it sends through a [device feed](../sync.md#the-feed) or a [change feed](../changes.md#the-feed).

```text
{
  indexName:   string   (the generation that serves the index)
  indexUuid:   string   (the identity of that generation)
  partitionId: uint32
  afterSeqNo:  uint64
  maxBytes:    uint32   (at least 1)
}
```

The primary answers with the entries above `afterSeqNo`, up to `head` and up to `maxBytes` of entries, where it always sends at least one entry that is due:

```text
{
  entries:      List<ReplicationLogEntry>
  head:         uint64   (the lower of the partition's commit point and the highest seqNo in the primary's write-ahead log)
  highestSeqNo: uint64   (the higher of the highest seqNo in its write-ahead log and the end of its replication log)
  oldestSeqNo:  uint64   (as Sending Entries in sync.md defines, and at least afterSeqNo + 2 where the entries above afterSeqNo left the log during the read)
  bytesBehind:  uint64
}
```

The primary must send the entries in ascending `seqNo` order, each above `afterSeqNo`, at most `head`, and of the requested partition, and a reader must refuse a reply that breaks one of these rules. A node refuses a malformed request with `CONFIG_INVALID`. A node that no longer leads the partition refuses with `PARTITION_NOT_PRIMARY`, whereas the primary of a partition in `INITIALISING` refuses with `QUERY_NO_ACTIVE_REPLICA`, as [Read Path](replication.md#read-path) defines. A node whose copy carries another `indexUuid` refuses with `INDEX_NOT_FOUND`, and one that keeps no write-ahead log refuses with `SYNC_DURABILITY_REQUIRED`.

### suggestions.counts

A node sends this through `stream` to read the [query counts](../query-suggestions.md#history) that another node holds for one index.

```text
{
  indexName: string
}
```

The node saves the counts of the current day, then streams each history file of the index that it holds, its restored files included, in key order, comparing UTF-8 bytes. For each file, it sends a `uint16be` length followed by that many bytes of the file's key relative to `_query-counts/<indexName>/` in UTF-8, then a `uint32be` length followed by that many bytes of the file. The stream ends after the last file. A node that holds no file sends one empty chunk, because a stream ends only after its first chunk, and the receiver reads an empty chunk as no data. A node must stream at most one file at a time, so that it never holds the history of an index in memory. The receiver must stop reading, and treat the node as one that gave no answer, where a key length passes 64 bytes, where a key is neither `<day>.nrsl` nor `restored/<day>-<n>.nrsl` as [History](../query-suggestions.md#history) defines them, or where a file length passes the limit that History sets for a history file.

### suggestions.build

A node sends this to the active controller when a caller asks for a build.

```text
{
  indexName: string
  trigger:   string   ("caller")
}
```

The controller refuses it with `NODE_NOT_CONTROLLER` where it holds no controller lease, with `INDEX_NOT_FOUND` where the coordinator holds no metadata for the index, and with `QUERY_SUGGESTIONS_NOT_ENABLED` where the feature is off. Otherwise it answers once the build starts, or once it skips the build:

```text
{
  buildId: string
  status:  string   ("running" or "skipped")
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
  term:          string or absent
  filters:       FilterExpression or absent
  sort:          List<SortField> or absent
  group:         GroupConfig or absent
  facets:        List<FacetField> or absent       (at most 64)
  facetSize:     uint32 or absent                 (default 10, the bucket cap per facet field)
  limit:         uint32                           (default 10)
  offset:        uint32                           (default 0)
  searchAfter:   string or absent                 (base64-encoded cursor)
  fields:        List<string> or absent           (the fields searched; absent means every text field)
  boost:         Map<string, float32> or absent   (per-field boost)
  tolerance:     uint8 or absent                  (fuzzy matching tolerance, at most 10)
  threshold:     float32 or absent                (minimum score)
  includeScores: boolean or absent                (default false; controls public sorted response scores)
  scoring:       'local' or 'dfs' or 'broadcast'  (default 'local')
  termMatch:     'all' or 'any' or uint32 or absent   (absent means 'any'; a count names the minimum matching terms)
  prefixLength:  uint32 or absent                 (leading characters exempt from tolerance, at most 1,024; default 2)
  prefix:        boolean or absent                (default false; completes the final token)
  partialWords:  boolean or absent                (default false; matches query words inside longer indexed words)
  exact:         boolean or absent                (default false; turns off tolerance, prefix completion, and partial-word matching)
  pinned:        List<PinnedEntry> or absent
  mode:          'fulltext' or 'vector' or 'hybrid' or absent
  vector:        VectorQueryParams or absent
  hybrid:        HybridConfig or absent
  analysisGeneration: uint64 or absent            (the generation that the coordinator read; an absent value means 0)
  bm25:          BM25Params or absent             (the parameters that the search sets; see Parameter Levels in algorithms.md)
  indexBm25:     BM25Params or absent             (the coordinator's value of the index's setting; absent where the sender predates it or holds no metadata for the index)
}

SortField {
  field:     string
  direction: 'asc' or 'desc'
  mode:      'min' or 'max' or 'avg' or 'median' or absent
}

FacetField {
  field:  string
  sort:   'asc' or 'desc' or absent   (absent means 'desc')
  ranges: List<FacetRange> or absent  (at most 1,000)
}

FacetRange {
  from: float64   (inclusive)
  to:   float64   (exclusive)
}

GroupConfig {
  fields:      List<string>
  maxPerGroup: uint32           (default 1)
  limit:       uint32 or absent (caps the groups returned; absent returns every group)
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
  oversample: float32 or absent   (re-score depth multiplier; absent uses the engine default)
  rescoreWindow: uint32 or absent   (the hybrid re-score window, which a coordinator sets on the vector fan-out of a hybrid query that sets depth; absent re-scores as oversample defines)
}

HybridConfig {
  strategy: 'rrf' or 'linear' or absent   (default 'rrf')
  k:        uint32 or absent              (the RRF constant, default 60)
  alpha:    float32 or absent             (the linear weight, default 0.5)
  depth:    uint32 or absent              (the results that each search fetches; absent fetches by page)
}
```

A reader must reject with `CONFIG_INVALID` a `rescoreWindow` that is not a whole number from 1 to 10,000.

A reader must reject with `CONFIG_INVALID` a `bm25` that breaks [Parameter Levels](../algorithms.md#parameter-levels). It must reject an `indexBm25` that does not have the `BM25Params` shape or that holds a value that is not a finite number, and it must accept a value outside the ranges there, because an index can store one.

A sender writes every member, encoding an absent value as nil, and a reader restores nil as omitted, so a request and its wire round trip carry one [cursor binding](../partitioning.md#cursor-binding) and a reader rejects a payload whose member is missing. A reader must restore as absent a member that a later revision of this document added to the end of a structure, where the payload omits it, so that a node accepts a request from a node one release older; it must still reject a payload that omits any other member.

The enclosing `QueryParams.limit` sets the top-k count for vector search, so `VectorQueryParams` carries no limit of its own and there is one source of truth.

[FilterExpression](#filterexpression) defines `filters`.

### FilterExpression

The `filters` of a query, a listing, and a [change feed](../changes.md#filters) take this form:

```text
FilterExpression {
  fields: Map<string, FieldFilter> or absent   (1 to 256 fields)
  and:    List<FilterExpression> or absent     (1 to 256 expressions)
  or:     List<FilterExpression> or absent     (1 to 256 expressions)
  not:    FilterExpression or absent
}

FieldFilter {                                  (1 to 256 operators)
  eq, ne:                  string or float64 or boolean
  gt, gte, lt, lte:        float64 or string
  between:                 [float64, float64] or [string, string]
  in, nin:                 List<string>
  startsWith, endsWith:    string
  contains, wildcard, regex: string
  caseFold:                boolean
  tolerance:               0 or 1 or 2 or 'auto'
  containsAll, matchesAny: List<string or float64 or boolean>
  size:                    FieldFilter   (eq, ne, gt, gte, lt, lte, and between alone, with numbers)
  exists, notExists:       boolean
  isEmpty, isNotEmpty:     boolean
  radius:  { lat: float64, lon: float64, distance: float64, unit: 'km' or 'mi' or 'm', inside: boolean or absent, highPrecision: boolean or absent }
  polygon: { points: List<{ lat: float64, lon: float64 }>, inside: boolean or absent }
}
```

An expression must hold at least one key. A document matches an expression where it matches every key: each field's `FieldFilter`, every member of `and`, at least one member of `or`, and not `not`. A document matches a `FieldFilter` where it passes every operator in it. A document holds a field where the field's value is present and not nil, and a `string`, `verbatim`, or list field that holds `""` or `[]` holds that field. A list field passes a test where one of its elements passes, except under `ne` and `nin`, which pass a document that holds the field and whose every element differs from the operand.

| Operator | Field types | A document passes when |
|----------|-------------|------------------------|
| `eq` | A field whose values have the operand's kind; a string operand needs an `enum`, `enum[]`, or pattern field | a value equals the operand, comparing strings exactly, with no case folding and no Unicode normalisation |
| `ne` | As `eq` | it holds the field and no value equals the operand |
| `gt`, `gte`, `lt`, `lte` | `number` or `number[]`; a string operand needs a `string` or `verbatim` field whose type includes `sortable` | a value lies past the bound, comparing strings as [Sort Value Order](../algorithms.md#sort-value-order) defines |
| `between` | As `gt` | one value lies from the first bound to the second, both included |
| `in` | As a string `eq` | a value equals a member of the list |
| `nin` | As a string `eq` | it holds the field and no value equals a member of the list |
| `startsWith`, `endsWith` | As a string `eq` | a value starts or ends with the operand |
| `contains`, `wildcard`, `regex` | A pattern field | a value passes the test that [Pattern Search](../algorithms.md#pattern-search) defines |
| `caseFold` | A pattern field | `eq`, `ne`, `in`, `nin`, `startsWith`, `endsWith`, `contains`, `wildcard`, and `regex` compare as [Folded Tests](../algorithms.md#folded-tests) defines |
| `tolerance` | A pattern field with a string `eq` | the `eq` matches as [Typo Test](../algorithms.md#typo-test) defines |
| `containsAll` | A list field whose elements have the operands' kind; strings need a pattern field | it holds the field and every operand equals an element, so an empty list passes every document that holds the field |
| `matchesAny` | As `containsAll` | an operand equals an element, so an empty list passes no document |
| `size` | A list field | the list's length passes every operator in it |
| `exists`, `notExists` | Any field | `exists: true` and `notExists: false` pass a document that holds the field, and `exists: false` and `notExists: true` pass one that does not |
| `isEmpty`, `isNotEmpty` | Any field | `isNotEmpty: true` passes a document that holds the field with a length other than 0, and `isEmpty: true` passes every other document, with `false` reversing either |
| `radius` | `geopoint` | the point lies at most `distance` from `lat` and `lon`, in kilometres, miles of 1,609.344 metres, or metres, by [Haversine](../algorithms.md#haversine-distance) on a sphere of radius 6,371,008.8 metres, or by [Vincenty](../algorithms.md#vincenty-distance) where `highPrecision` is true |
| `polygon` | `geopoint` | [ray casting](../algorithms.md#point-in-polygon-ray-casting) places the point inside the ring of `points` |

Under `radius` and `polygon`, an absent `inside` means true, and `inside: false` passes a document that holds the field and whose point lies outside.

A node must refuse with `SEARCH_INVALID_FIELD` a filter on a field that the schema does not declare, and with `SEARCH_INVALID_FILTER` a filter that breaks this section, that pairs an operator with another field type, or that breaks any of these limits:

- An expression nests at most 30 levels, where the root is level 0 and each `and`, `or`, and `not` adds one level.
- A filter holds at most 1,024 tests, where `caseFold` and `tolerance` count none, `size` counts one for each of its operators, every other operator counts one, and each `FieldFilter` counts at least one.
- A string operand holds at most 1,024 code points, a list operand holds at most 65,536 items, and a number operand is finite.
- `lat` lies from -90 to 90, `lon` from -180 to 180, `distance` is at least 0, and `points` holds 3 to 65,536 points.

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
  keepAliveMs:    uint32 or absent             (present when the coordinator will fetch from a search context)
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
  groups: List<GroupEntry> or absent   (present when the query carries `group`)
  contextId: string or absent          (present when the node opened a search context)
}

ScoredEntry {
  docId:      string
  score:      float64 or absent       (absent when a sort suppressed scoring)
  sortValues: List<value> or absent   (present when the query specifies a sort)
}

FacetBucket {
  value: string
  count: uint32
}

GroupEntry {
  values: Map<string, value>   (one value per grouping field, keyed by field)
  scored: List<ScoredEntry>    (the node's best hits of the group, at most maxPerGroup)
}
```

A response carries at most 65,536 groups, so a query whose matches group more finely than that must set `group.limit`.

`sortValues` carries one value per sort field, in sort order. A data node must send for each field the value that the field's mode selects from the document, as [Where Each Order Applies](../algorithms.md#where-each-order-applies) defines: the element that `min` or `max` picks from an array, the mean or median of its numbers under `avg` or `median`, and a string cut to its first 512 code points. It must send that value as a string, a finite number, or a boolean, send nil where the document holds no such value, and never fold the case of a string, because the coordinator merges sorted results with the [sort value order](../algorithms.md#sort-value-order).

For a sorted query without grouping or `includeScores`, the node omits `score` from its reply. A sorted grouped query must preserve raw relevance scores in its grouped replies for [group ordering and reducers](query-routing.md#distributed-grouping), even where the caller omits `includeScores` or sets it to false. The coordinator may request `includeScores` internally to retain those scores, but it must honour the caller's setting when assembling the public response. Sorted entry merging always uses sort values and document ID, independently of score presence. [String Ordering](../algorithms.md#string-ordering) defines when the node must compute scores.

A present relevance score may be finite, positive infinity, negative infinity, or NaN, in ordinary and hybrid results and in grouped entries alike. The node must preserve that numeric value through MessagePack, and the coordinator must accept it at each `ScoredEntry.score` while retaining the validation rules for every other field. Score strings belong to HTTP responses and cursors alone. Ranked selection and merging follow [Score Order](../algorithms.md#score-order), and [Distributed Grouping](query-routing.md#distributed-grouping) keeps the raw text-leg scores of a hybrid query.

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
  vectors:     boolean or absent        (whether the node returns vector fields; absent means true)
  highlight:   HighlightConfig or absent   (reserved: a coordinator must send nil, and a node must ignore it)
  contextId:   string or absent         (the search context to read; absent means the current documents)
  releaseContext: bool or absent        (whether the node frees the context after this read; absent means true)
}
```

A node that receives `contextId` must read every named document from that [search context](query-routing.md#search-contexts), ignore each `partitionId`, and answer `SEARCH_CONTEXT_MISSING` where it holds no such context and the request names at least one document. `contextId` holds at most 64 characters, and `keepAliveMs` is a positive integer of milliseconds.

A coordinator must send `vectors: false` in a `query.fetch` or a `query.list` whose read leaves every vector field out, as [Vector Fields in Results](../partitioning.md#vector-fields-in-results) decides, and a node that receives it must leave every vector field out of each document that it returns. A node from before this member ignores it, so a coordinator must apply the read's projection to every document that a node returns.

### query.fetch_result

```text
{
  documents: List<{
    docId:      string
    document:   Map<string, value>
    highlights: Map<string, List<string>> or absent   (reserved: a node must send nil)
  }>
}
```

A node must answer with one entry for each named document that it stores, or that the search context holds where the request carries `contextId`, in the order that the request names them, and it must leave out every other document.

### query.stats

```text
{
  indexName:    string
  partitionIds: List<uint32>
  terms:        List<string>                (the query terms to collect frequencies for, which the node analyses)
  expansion:    StatsExpansion or absent    (the query's matching options; absent counts the terms and the synonyms that the copy's synonym set adds, with no other expansion)
  tokens:       List<string> or absent      (tokens to count as given, with no analysis or expansion)
  analysisGeneration: uint64 or absent            (the generation that the coordinator read; an absent value means 0)
}

StatsExpansion {
  tolerance:    uint8 or absent
  prefixLength: uint32 or absent
  prefix:       boolean or absent
  partialWords: boolean or absent
  exact:        boolean or absent
  fields:       List<string> or absent
}
```

A coordinator must fill `terms` with the non-empty pieces of the query's `term`, split at each run of the Unicode `White_Space` characters other than U+0085 and of U+FEFF, and it must send an empty `terms` where the query has no `term`.

### query.stats_result

```text
{
  totalDocuments:    uint32
  docFrequencies:    Map<string, uint32>
  totalFieldLengths: Map<string, uint64>
  expanded:          List<string> or absent   (each token that a prefix completion or a partial-word search reached)
}
```

### query.count

```text
{
  indexName:    string
  partitionIds: List<uint32>
  everyCopy:    boolean or absent   (true where the coordinator reads only the size figures of every copy)
}
```

A node must answer a `query.count` that sets `everyCopy` to true for every named partition that it holds, whatever the partition's state and whether its copy is in the in-sync set, because the coordinator takes only `savedBytes`, `vectorSavedBytes`, and `logBytes` from that answer. A node that predates the field ignores it, because a node ignores a key that it does not know.

### query.count_result

```text
{
  partitions: List<{
    partitionId:         uint32
    documentCount:       uint32
    estimatedMemoryBytes: uint64
    savedBytes:          uint64 or absent   (the saved size of the node's copy of the partition)
    vectorSavedBytes:    uint64 or absent   (the copy's share of the node's vector files and graph parts)
    logBytes:            uint64 or absent   (the log size of the node's copy of the partition)
  }>
  language: string   (the language module the node's local index analyses with)
}
```

The node answers for exactly the named partitions it holds, one entry per partition. The coordinator treats a named partition that is missing from every response as a failure, because a count with a partition missing is a wrong count rather than a partial one.

A node must set `savedBytes` and `logBytes` as [Saved Size](../durability.md#saved-size) defines them for a partition, and it must leave out each figure that those rules give it no value for. A node must split the bytes of the vector files and graph parts that its manifest lists for the index among every partition of the index that it holds, in proportion to their `documentCount`, or in equal parts where those partitions hold no document. It must round each share down and add the bytes left over to the share of the partition with the lowest id, so that the shares add up to those bytes, and it must set `vectorSavedBytes` to each share.

In the stats of an index, the coordinator must report as the saved size the sum of `savedBytes` and `vectorSavedBytes`, and as the log size the sum of `logBytes`, over the copy that it reads for each partition. In the stats of a partition, it must report that copy's `savedBytes` and `logBytes`. The coordinator must also report each of those figures summed over every copy that the allocation table lists, so it must send `query.count` with `everyCopy` set to true to every other copy as well, and it must never take `documentCount` or `estimatedMemoryBytes` from that answer. Where another copy fails to answer, the coordinator must report the sums over every copy as absent, and it must not fail the stats call. The coordinator must report a figure as absent wherever an answer that it adds up leaves that figure out.

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
  vectors:      boolean or absent           (whether the node returns vector fields; absent means true)
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

The node lists from the named partitions alone, in the order the request names, and returns up to `limit` entries past the cursor. It must fill `sortValues` as [query.search_result](#querysearch_result) defines, from the stored document whatever `fields` the request projects. The coordinator merges the pages, by document id in code point order or by the [sort value order](../algorithms.md#sort-value-order) when the request sorts, truncates to the client's limit, sums `total` across responses, and encodes the next cursor from the last merged entry. The listing continues while the merge dropped entries past the client's limit or any node reported `hasMore`.

### query.suggest

```text
{
  indexName:    string
  partitionIds: List<uint32>
  prefix:       string
  limit:        uint32   (the oversampled per-node count, ceiling(clientLimit * 1.5) + 10)
  analysisGeneration: uint64 or absent            (the generation that the coordinator read; an absent value means 0)
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

- An integer uses the smallest MessagePack encoding that holds the value, whether positive fixint, uint8, uint16, uint32, or uint64, and a negative integer uses the smallest signed encoding.
- An integer must lie between -(2^53 - 1) and 2^53 - 1, because a reader that holds numbers as float64 cannot hold a larger one exactly.
- A number that is not a whole number uses float64. A writer may encode a float-typed value that holds a whole number, such as a boost of 1, as an integer, so a reader must accept an integer wherever a structure declares a float.
- A writer that sends a document holding -0 must encode every number as float64, so that the sign survives: every number of the encoded document where the document travels as `bin`, and every number of the whole payload where documents travel as maps, as in `query.search_result`, `query.fetch_result`, and `query.list_result`. A reader must therefore accept a float64 that holds a whole number wherever a structure declares an integer.
- A string is UTF-8, and every string header, binary header, map header, and array header uses the smallest MessagePack encoding that holds its length.
- A map keeps insertion order, so one implementation encodes the same message the same way every time. Field ordering need not match across languages, and every decoder must accept any key order.
- Binary data uses MessagePack's `bin` format. That covers an encoded document in a write or a replication entry, a snapshot chunk, and the value of a vector field inside a document map, which holds the vector's float32 values in little-endian byte order.
- An absent value is MessagePack nil, and a writer may leave its key out instead. A reader must treat a missing key exactly as nil, except where a structure gives the two different meanings, as `previousDocument` does in [Log Entry Format](replication.md#log-entry-format), and except in the members of `QueryParams` itself, which a writer must always send as [QueryParams](#queryparams) defines.
- A reader must ignore every key that a structure does not define, so that a node can add a member without breaking a node on an earlier specification version.

### Maximum Message Size

A transport message, a snapshot chunk included, must not exceed 64 MiB, which is 67,108,864 bytes, so that a sender cannot force an unbounded allocation on the receiver. The TCP carrier counts the bytes of the frame map that follows the length prefix, and the gRPC carrier counts the bytes of the encoded `TransportMessage`. A sender whose response would exceed the limit, such as a fetch result carrying many large documents, must split it across several messages or return an error.

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
| `requestTimeout` | 30,000 ms | The longest wait for the answer to every `send` that `replicationTimeout` does not cover, `replication.forward` and every `cluster.*` message included |
| `replicationTimeout` | 10,000 ms | The longest wait for the answer to a `replication.entry`, a `replication.entry_batch`, or a `replication.term_start` |
| `snapshotTimeout` | 300,000 ms | The longest wait for the next chunk of a snapshot transfer, so that a transfer of any size can finish while the sender keeps sending chunks |

---

## Built-in Transport Adapters

| Adapter | Transport | Use |
|---------|-----------|-----|
| TcpTransport | Raw TCP with MessagePack framing | Server to server, with the lowest overhead |
| GrpcTransport | gRPC over HTTP/2, per [transport.proto](transport.proto) | Server to server, where gRPC tooling and infrastructure already exist |
| InMemoryTransport | Direct function calls | Testing and single-process development |

Every node of a cluster must use the same carrier, because a TCP node and a gRPC node cannot exchange a message. A node's registered `address` is `host:port`, where `host` is a DNS name, an IPv4 address, or an IPv6 address in square brackets, and the port is the one that the node's carrier listens on, 9300 by default for TCP and 9301 for gRPC.

Where a carrier is configured with TLS, every connection must use mutual TLS: the server must require a client certificate that chains to the configured authority, and the client must check the server's certificate against the host in the target address. No carrier ties a certificate to a `nodeId`, so a receiver takes the sender's identity from the `sourceId` that the sender declares, and only TLS stops a host outside the cluster from declaring one.

A carrier answers a request that its listener cannot handle with a `TransportMessage` whose `type` is `error`, whose `sourceId` is empty, and whose `payload` holds the failure's message as UTF-8 text, not as MessagePack. The `requestId` is the request's, or empty where the request could not be decoded. A receiver must check for this `type` before it decodes a payload as MessagePack.

### TCP Carrier

The TCP carrier sends frames over one connection per peer address, which many requests share. Each frame is a 4-byte big-endian length followed by that many bytes, which hold a MessagePack map:

```text
Frame {
  frameType: uint8    (1 = request, 2 = response, 3 = stream chunk, 4 = stream end)
  requestId: string   (the requestId of the request that the frame belongs to)
  data:      bytes
}
```

- Both ends of each connection must set `TCP_NODELAY` so that the kernel sends a short frame without waiting for the peer to acknowledge an earlier frame.
- A request frame holds one encoded `TransportMessage` in `data`, for `send` and for `stream` alike, and the message `type` alone tells the receiver whether to answer once or to stream.
- The receiver must send every frame of the answer back on the connection that carried the request. The first `respond` goes out as a response frame holding the whole encoded `TransportMessage`, and each later `respond` goes out as a stream chunk frame holding only the payload.
- Once its handler finishes, the receiver must send a stream end frame with empty `data` after any handler that responded at least once, and a caller that used `send` ignores that frame.
- A `stream` caller passes the payload of the response frame, and the `data` of each stream chunk frame, to its handler in order, and it finishes at the stream end frame.
- Where the listener itself fails, the receiver sends the carrier's `error` message as a response frame and sends no stream end frame.
- A receiver must close a connection that sends a frame longer than 67,108,864 bytes or a frame that it cannot decode, with no answer, and it must ignore any frame on an inbound connection that is not a request frame.
- A receiver accepts at most 256 inbound connections and closes each one beyond that.

### gRPC Carrier

The gRPC adapter implements the `narsil.transport.v1.NodeTransport` service defined in [transport.proto](transport.proto). A `Send` request and its response each carry one MessagePack-serialised `TransportMessage` in the `Envelope.message` field, so the envelope encoding in [Wire Format](#wire-format) stays the contract and gRPC only frames it. An `OpenStream` request carries its message the same way, and each `Chunk.data` in the reply stream is the payload of one `respond` call, in order. A listener error on `Send` travels as the carrier's `error` message in the reply `Envelope`, which keeps gRPC statuses for transport faults alone. `OpenStream` cannot carry that message, so a server must end the stream with status `UNAVAILABLE` where no listener is registered, `INVALID_ARGUMENT` where it cannot decode the request, and `UNKNOWN` where the listener fails or finishes without a chunk.

Every channel must accept messages of up to 67,109,888 bytes in each direction, which is the message limit plus 1,024 bytes for the `Envelope`. A client must send keepalive pings every 30,000 ms with a 10,000 ms timeout, even with no call open, so a server must permit pings at that interval with no call open. A client must set a deadline on each `Send` equal to the request's timeout, and it must time an `OpenStream` by the wait for each chunk, as [Transport Timeouts](#transport-timeouts) defines for a snapshot. A server must keep a `Send` open until its listener answers or the client's deadline passes, and it may end a call that carries no deadline after `requestTimeout`. A server must accept at most 256 inbound connections and close each one beyond that, as the TCP carrier does.

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
| `TRANSPORT_CONNECT_FAILED` | The sender could not hand the message to the peer node, because opening a connection failed or the sender's own transport had shut down, so the peer never received it. |
| `TRANSPORT_TIMEOUT` | A request did not finish within its configured timeout. |
| `TRANSPORT_MESSAGE_TOO_LARGE` | A non-streaming message exceeded the 64 MB limit. |
| `TRANSPORT_DECODE_FAILED` | A received message could not be decoded, because the MessagePack was corrupt or invalid. |
| `TRANSPORT_PEER_UNAVAILABLE` | The connection to the peer node failed after the sender handed it the message, so the peer may have received the message and acted on it. |
| `INTERNAL_ERROR` | An operation fails for a cause that has no other code, such as an unexpected error in a handler. |
