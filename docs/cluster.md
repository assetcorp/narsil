# Cluster mode

Narsil operates as a cluster of nodes that share one set of indexes. The engine splits each index into a fixed number of partitions, each of which takes its writes through one primary node. Before the client receives its answer, every replica of that partition takes the write through a replication log. The documents in [`packages/spec/distribution`](../packages/spec/distribution) define the cross-language contract, while this guide covers the TypeScript implementation under `@delali/narsil/distribution`.

## Build a node

A node needs two adapters: a coordinator, which holds the cluster's shared state, and a transport, which sends messages between nodes. The in-memory pair keeps a whole cluster inside one process, which is how the test suite exercises it.

```ts
import { createClusterNode } from '@delali/narsil/distribution'
import { createInMemoryCoordinator } from '@delali/narsil/distribution/coordinator/in-memory'
import { createInMemoryNetwork, createInMemoryTransport } from '@delali/narsil/distribution/transport/in-memory'

const coordinator = createInMemoryCoordinator()
const network = createInMemoryNetwork()

const node = await createClusterNode({
  coordinator,
  transport: createInMemoryTransport('node-a', network),
  address: 'node-a:9200',
  nodeId: 'node-a',
  roles: ['data', 'coordinator', 'controller'],
})
await node.start()
```

In a production cluster, you will swap both adapters and keep the rest of the code identical. `createEtcdCoordinator` from `@delali/narsil/distribution/coordinator/etcd` stores the shared state in etcd. The TCP transport from `@delali/narsil/distribution/transport/tcp` and the gRPC transport from `@delali/narsil/distribution/transport/grpc` each send messages between hosts and support mutual TLS. The [cluster dashboard example](../packages/ts/examples/cluster-dashboard) starts three nodes this way against an etcd container and places a fault injector on every link between them. It shows each partition's primary, in-sync set, and commit point as they change.

The etcd coordinator and the gRPC transport each load a package that Narsil declares as an optional peer dependency, so install the one you use:

```bash
pnpm add etcd3
pnpm add @grpc/grpc-js
```

Narsil loads that package at the moment you create the adapter, so the adapter raises `COORDINATOR_DEPENDENCY_MISSING` or `TRANSPORT_DEPENDENCY_MISSING` where the package is missing, and names the install command in the message. The TCP transport needs no extra package, because it works through the Node network and TLS modules.

etcd refuses any request larger than its `--max-request-bytes` setting, which is 1.5 MiB unless the operator changes it. The etcd coordinator measures each write before it sends the write, so that it can raise `CONFIG_INVALID` for a write that would pass the `maxRequestBytes` setting of `createEtcdCoordinator`. That setting matches the etcd default of 1,572,864 bytes, so give it the same value as `--max-request-bytes` wherever an etcd cluster uses another limit. `createIndex` raises `CONFIG_INVALID` for an index whose schema or settings would pass that size, after which the node withdraws whatever part of the index it had already written. When `maxRequestBytes` is more than 512 KiB above the etcd limit, a write in that gap can fail inside gRPC, after which the `etcd3` client stops sending requests to that etcd member for five seconds.

A node plays one or more of three roles. A `data` node holds partitions and serves searches. A `coordinator` node fans client requests out and merges the answers. A `controller` node stands for election. The node that holds the lease then assigns partitions to nodes. A node holds all three roles by default, which suits a cluster of three nodes or fewer. Every node registers with the coordinator whatever roles it holds, so the registry lists a coordinator-only node as well. The controller places partitions on `data` nodes alone.

## Connect to etcd over TLS

`createEtcdCoordinator` connects to etcd over TLS when you set `tls`, and it signs in as an etcd user when you set `auth`:

```ts
import { readFileSync } from 'node:fs'
import { createEtcdCoordinator } from '@delali/narsil/distribution/coordinator/etcd'

const coordinator = await createEtcdCoordinator({
  endpoints: ['https://etcd-1.internal:2379', 'https://etcd-2.internal:2379', 'https://etcd-3.internal:2379'],
  tls: {
    ca: readFileSync('/etc/narsil/etcd-ca.pem'),
    cert: readFileSync('/etc/narsil/etcd-client.pem'),
    key: readFileSync('/etc/narsil/etcd-client-key.pem'),
  },
  auth: { username: 'narsil', password: readFileSync('/etc/narsil/etcd-password', 'utf8').trim() },
})
```

`tls.ca` holds the certificate authority, in PEM form, that the certificate of every etcd member must chain to. Set `tls.cert` and `tls.key` together, also in PEM form, where etcd asks each client for a certificate. `auth` holds the `username` and the `password` of the etcd user. `createEtcdCoordinator` raises `CONFIG_INVALID` before it connects in each of these cases:

- `tls` sets one of `cert` and `key` without the other.
- `tls` is set while an endpoint starts with something other than `https://`.
- `auth` holds an empty user name or an empty password.
- `auth` would send the password over `http://` to a host other than a loopback address, which is `localhost`, `::1`, or an address that starts with `127.`.

That last rule keeps the password from crossing a network in clear text, so a password over `http://` works only with an etcd on the same machine. Once the settings pass, the call reads from etcd before it returns, so that a wrong certificate or a wrong password fails the call itself and never a later write. It raises `COORDINATOR_AUTH_FAILED` when etcd refuses the user or the password, and `COORDINATOR_UNAVAILABLE` when no endpoint answers within 10 seconds or every endpoint fails the TLS handshake.

The coordinator recovers from two etcd failures while the node is up. When etcd cancels a watch, the coordinator opens it again and reads the keys once more, so that it reports every change that it missed. When etcd drops the lease that holds a node's registration, the coordinator writes the registration again under a new lease. Where an attempt at either fails, the coordinator tries again after 100 milliseconds, and it doubles that wait after each further failure up to 5 seconds.

## Keep a node's identity across restarts

A node with a durability directory keeps its id in that directory. Where you set no `nodeId`, `createClusterNode` generates an id the first time, writes the id to a `.narsil-node-id` file in `engine.durability.directory`, and reads it back every time after that, so that the controller recognises the copies that the node held before it stopped. A `nodeId` that you set takes precedence, and the node writes it to no file. A node without a durability directory takes a new id on every start, so the cluster treats it as a new node after each restart.

The engine of the node locks the durability directory before the node reads its id, so `createClusterNode` raises `CONFIG_INVALID` for a second node that points at a directory that another node holds. [Durability](persistence-and-durability.md#durability) explains how the lock works. `createClusterNode` raises `CONFIG_INVALID` as well where the `.narsil-node-id` file holds anything other than an id that a node wrote. Restore the file in that case, or delete it so that the node starts under a new id, which leaves the cluster to rebuild the copies that the node held.

A node that stops without leaving the cluster can leave its registration behind until its lease expires, which takes up to `nodeHeartbeatTtlSeconds` of the etcd coordinator, 30 seconds by default. Where the node restarts within that time, `start` waits for the earlier registration to lapse before it registers again, so that two registrations never claim one id at once. `start` raises `NODE_VERSION_INCOMPATIBLE` before it registers where the active controller follows a specification version with another major version, because nodes on different major versions can't share a cluster. The controller also places no partition on a node whose major version differs from its own.

When a data node leaves the cluster, whether it shut down or lost its coordinator lease, the controller promotes an in-sync replica at once for every partition that the node led. The controller then waits for `controller.nodeLeftDelayMs`, which is 60000 milliseconds by default, before it moves the replicas of the node to other nodes. A node that registers again under the same id within that time keeps its replicas and catches up on the writes that it missed, which can spare it a full copy of each partition. Set `nodeLeftDelayMs` to 0 where you want the controller to move the replicas as soon as a node leaves.

## Take a node out of the cluster

`node.decommission()` moves every copy off a node before the node leaves. The node marks its registration as draining, so the controller places nothing new on it. The controller then hands each partition that the node leads to an in-sync replica on another node. It moves each replica that the node holds by adding the new copy first, and it drops the old copy only once enough in-sync copies outside the move remain to meet the replication factor. The call returns once no allocation table holds the node and the node has shut down.

```ts
await node.decommission({ signal: AbortSignal.timeout(600_000) })
```

The drain waits for as long as the cluster has no other node that can take a copy, so pass `signal` where you want to stop waiting. An abort rejects the call with the reason of the signal, clears the draining mark, and leaves the node in the cluster. `node.shutdown()` leaves at once, so the controller treats the node as failed and waits for `nodeLeftDelayMs` before it moves the replicas of the node.

## Create, drop, and clear an index

`createIndex` publishes the schema through the coordinator, after which the controller assigns the partitions to nodes. The call returns once every partition is in service, so a primary that holds the index receives a write that you send straight afterwards. The options set how the engine spreads the index and how long the call waits:

```ts
await node.createIndex(
  'products',
  { schema: { title: 'string', price: 'number' } },
  { partitionCount: 6, replicationFactor: 2, waitForServingMs: 10_000 },
)
```

`partitionCount` defaults to 5. `replicationFactor` counts the copies beyond the primary and defaults to 1, which means two copies of every partition. A factor of 0 keeps one copy, so you lose that partition's documents when the node that holds it fails. You can change both later, as [Change the replication factor and the partition count](#change-the-replication-factor-and-the-partition-count) describes.

Every node creates its copy of the index with the configuration that you pass to `createIndex`, because the creating node stores that configuration in the coordinator beside the schema. A node cannot serialise code into the coordinator, so give the tokenizer and the embedding adapter by the names that you registered them under, and give the stop words as a set or as a registered name. For a tokenizer instance, an adapter instance, or a stop word function, `createIndex` raises `CONFIG_INVALID`. Register the language module and each of those names on every node, because any node can create a copy of the index or lead one of its partitions.

A node without filesystem durability raises `CONFIG_INVALID` as it creates its copy of an index whose `vectorPromotion.storage` is `disk`, so only the nodes with filesystem durability can hold that index's partitions. Give every data node filesystem durability before you create such an index.

In a cluster, `partitions.maxDocsPerPartition` caps each partition on its own, because a node can hold only some of an index's partitions. The primary of a partition fails an insert into it with `PARTITION_CAPACITY_EXCEEDED` once the partition holds that many documents, while each replica applies every write that its primary acknowledges. The hash can assign more document ids to one partition than to another, so inserts into a full partition can fail while inserts into the other partitions succeed. With `partitions.watermark` set, the primary emits `partitionWatermark` with a `partitionId` when one of its partitions crosses the threshold. When an index reaches its capacity, raise its partition count with `rebalance`, which spreads its documents over more partitions.

`waitForServingMs` bounds the wait and defaults to 30000. The call returns at the deadline whether or not the partitions are in service. It returns at once where no registered node holds the `controller` role or none holds the `data` role, because no node can allocate the index. A write that a node receives before the allocation exists fails with `QUERY_ROUTING_FAILED`, whose message gives the state of the cluster. A caller that passes 0 to skip the wait can therefore expect that code until the controller places the partitions. See [What a node serves](#what-a-node-serves).

`dropIndex` removes the index from the whole cluster. The node that receives the call clears the index metadata and drops the schema. The controller then empties the allocation, after which every node that holds a copy drops it. The teardown finishes after the call returns, so a client that queries during the teardown can hit a node whose copy is already gone. The name becomes reusable once the coordinator state is gone.

`clear` empties an index and keeps it. The engine sends each removal through the replication log the way it sends a single `remove`, so it performs one listing and one batched removal per page while it clears a large index.

## Change the replication factor and the partition count

`node.cluster.setReplicationFactor(indexName, replicationFactor)` changes how many replicas besides the primary each partition of an index keeps, as an integer from 0 to 255. The node sends the change to the active controller, which stores the factor in the index metadata and writes an allocation table that carries it before the call returns. A higher factor adds replicas, each of which catches up from its primary. A lower factor removes the surplus replicas, lagging ones first, and never removes the primary. The call raises `CONFIG_INVALID` for a factor outside that range, `INDEX_NOT_FOUND` where the cluster holds no index of that name, and `NODE_NOT_CONTROLLER` while no node holds the controller lease. Over HTTP, send `PUT /indexes/{name}/replication-factor`, which the [HTTP server guide](http-server.md#cluster-routes) describes.

`node.rebalance(indexName, targetPartitionCount)` moves an index onto a new number of partitions, from 1 to 65,536. The controller creates a hidden index with the new partition count and copies every document into it. Meanwhile the current partitions go on serving reads and writes, and the primary of each one forwards to the hidden index the writes that it takes during the copy. Once every current partition has forwarded all but 1,000 or fewer of its writes, the controller blocks writes to the index, waits for the hidden index to take the last of them, and points the index name at the new partitions in a single allocation write. Each cutover lasts 10 seconds at most, and a write that arrives during it fails with `PARTITION_REBALANCING_BACKPRESSURE`, which the HTTP server answers with status 409, so send that write again once the cutover ends. Where the hidden index has not caught up within those 10 seconds, the controller lifts the block and tries the cutover again later. After 10 tries the controller abandons the change, and the call raises `ALLOCATION_FAILED` while the index keeps its partitions. The call also raises `CONFIG_INVALID` for a count outside that range or equal to the current one, `PARTITION_REBALANCING_BACKPRESSURE` while another change to the same index is in progress, and `NODE_NOT_CONTROLLER` while no node holds the controller lease. Over HTTP, `POST /indexes/{name}/_rebalance` starts the change as a task, which [Tasks](http-server.md#tasks) describes. Once the change finishes, `node.cluster.getAllocation` returns the table of the new partitions under the name of the index.

## What a node does with the indexes that it already holds

A node that stores its indexes on disk still holds them when it starts again, although the cluster may have changed while it was down. The engine stores the identity that the cluster gives each index at creation, so a rejoining node compares that identity with the coordinator's and settles each index in one of three ways:

- The identities match, so the node adopts its copy and serves it.
- The coordinator names another index under that name, which happens when you drop an index and create another with the same name. The node then drops its copy and takes the new index on from its primary. Without that check, the old documents would come back under the new name.
- The coordinator holds nothing for the name, so the node keeps the data, serves none of it, and reports the index through the `onError` callback you configured. Every call naming that index fails with `INDEX_ORPHANED`, which the HTTP server answers with status 409. The node keeps the data because the engine cannot tell a wiped or restored coordinator from one that never held the index, and the operator settles which of the two it is. `dropIndex` on that node deletes the copy and frees the space.

## Writes

`insert`, `update`, and `remove` route each document to its partition's primary by hashing the document id. When this node is the primary, it applies the write locally, appends a log entry, and waits for every in-sync replica to acknowledge before it returns. When another node is the primary, this node forwards the mutation to it, so that primary takes over.

An `update` replaces the stored document whole. Because the primary replicates the complete replacement, every replica applies a self-contained document.

The node groups the work of a batch call before it sends anything. For `insertBatch`, `updateBatch`, and `removeBatch`, it splits the documents by partition and applies each local group through one replication batch per partition. It then sends each remote primary one `replication.forward_batch` message that holds every document for that primary, and it returns one outcome for each document. A batch of one falls back to the plain single-document message, while the engine splits a larger batch at 1,000 operations or 8 MB of document bytes per message.

When a write fails after the node applies it locally, the node rolls it back before it returns the error, so a failed insert removes the document, and a failed update or remove restores the document that the partition held before.

## When a node runs short of memory

Each node measures its memory once a second and sends the figures to the coordinator with every heartbeat. A node counts as full once its resident memory passes 90% of the memory that its host or its container allows, or once the old generation of its V8 heap passes 75% of the limit that `--max-old-space-size` sets. The node counts the old generation alone, because V8's minor collections empty the young generation without any help from the node, while a process runs out of memory only when the old generation can't grow. The node measures its heap limit exactly only where you set `--max-old-space-size` or `--max-old-space-size-percentage`. Where you set `--max-semi-space-size` alone, the node subtracts three times that size from V8's whole heap limit, because V8 reserves that much for the young generation. Where you set neither flag, the node subtracts the space that the young generation holds at that moment, because V8 reports no figure for the young generation's maximum, so the node's figure for the limit can be up to about 5% high. It counts as clear again once its resident memory falls below 80% and its old generation falls below 65%, and that gap keeps a node close to the limit from switching between the two states on every measurement. Before a node reports itself full, it runs a garbage collection, at most once every five seconds, so that only live data can hold the block in place.

The heap's levels are lower than the resident memory's because of a rule in V8. On Node 22 and Node 24, V8 stops the process with `Ineffective mark-compacts near heap limit` after four full collections in a row that each leave the old generation holding at least 80% of its limit while collection takes more than 60% of the thread's time. A full node holds its heap near the block level until it clears, so a block level of 90% held every full node inside that zone. One 192 MB node that blocked at 90% stopped this way while a client read back the documents that it held. The heap's levels therefore stay at 75% and 65%, or at the levels that you set where those are lower. The 5% between the block level and V8's line leaves room for the memory that a node takes on between two measurements. V8 sets no such rule for resident memory, so the node applies the levels that you set to it.

A node also turns full when it refuses a write because the write needs enough memory to take either figure past its block level, as long as that refusal still stands after a garbage collection and either figure is at its resume level or above. Without that rule, a stream of large batches can hold a node just below its block level, because the node refuses each batch before its memory reaches that level while the other nodes go on sending it writes. The resume-level condition keeps a node that holds little data clear when a client sends it a single write that is larger than its free memory. A node that turns full this way clears under the same resume levels.

While a node that holds a copy of an index reports full, every node refuses an insert or an update to that index with `CLUSTER_WRITE_BLOCKED`, which the HTTP server answers with status 429. The error's `details` carry the reason `node_memory_full`, the `indexName`, and the sorted `fullNodeIds`. A batch call fails whole, so none of its documents reach any partition. Removes, searches, and reads go through as usual, and an index with no copy on the full node keeps accepting writes. The node that receives a write enforces the block, and so does the primary that the write is forwarded to. A replica, however, applies every entry that reaches the replication log, because a replica that refused an entry would fall out of the in-sync set.

The HTTP server checks that it has the memory to parse a request body before it passes the write to the cluster. While the cluster blocks writes to an index, the server answers an insert, a `PUT`, a `PATCH`, or an import line whose body it can't parse in the free memory with the same `CLUSTER_WRITE_BLOCKED` refusal. Since a `_batch` call can contain removes, which the block lets through, the server answers an oversized one with `TOO_MANY_REQUESTS` and the reason `parse_would_fill_memory`. The server passes a smaller batch to the cluster, which applies it or refuses it under the block. The server parses a write's body only where the memory that parsing takes fits under 75% of the heap limit and 90% of the process limit. It parses a search, a suggestion, a `_multi-get`, a document list, and a `_batch` whose `action` is `delete` up to 95% of either limit, so that an operator can still read and remove documents on a full node. Above 95% it refuses even those with `TOO_MANY_REQUESTS` and the reason `parse_would_fill_memory`, so retry them once the requests in progress finish.

Each node judges its own state from its latest measurement and the state of every other node from the registrations that the coordinator's node watch delivers to it. A node rewrites its registration as soon as it turns full or clear, so the other nodes learn of the change as soon as the coordinator delivers that write. `GET /cluster` reports each node's `memory` figures, `full` among them, so you can see which node holds the block.

To lift the block, free memory on the node that reports full, or give it more:

- Remove documents from the indexes that have a copy on that node, or drop one of those indexes.
- Restart the node with a larger container limit or a larger `--max-old-space-size`.

The cluster accepts writes again once every node that holds a copy reports clear. Set `memory` on a node's configuration to move its two levels, each a fraction above 0 and at most 1. For the heap, the node uses the lower of each setting and its V8 cap of 75% or 65%, so this example moves only the levels for resident memory. `createClusterNode` raises `CONFIG_INVALID` where `resumeWritesBelow` is not below `blockWritesAbove`:

```ts
await createClusterNode({
  coordinator,
  transport: createInMemoryTransport('node-c', network),
  address: 'node-c:9200',
  memory: { blockWritesAbove: 0.85, resumeWritesBelow: 0.75 },
})
```

A burst of writes can fill a heap between two of the node's once-a-second measurements, so each node also bounds the documents of the inserts and updates that it holds in flight. The node counts a write's documents from the moment that it accepts the write until the write completes, both where a client sends the write to it and where another node forwards the write to it as primary. The bound is 2% of the heap limit by default. That default is low because indexing can take many times a document's size in heap. On Node 24 with workers off, a node needed about 27 bytes of heap for every byte of text while it indexed 2,000 documents of 120 words drawn from a 20,000-word vocabulary. When a new insert or update would carry the total past the bound, the node refuses it with `CLUSTER_WRITE_BLOCKED` and status 429, and the error's `details` include the reason `write_bytes_in_flight` together with the `nodeId`, the `requestBytes`, the `inFlightBytes`, and the `limitBytes`. The node accepts a write of any size when no other insert or update is in progress on it, because a client retries this refusal, so a write larger than the bound can otherwise never succeed. The per-document memory check below still applies to that write. Removes and replicated entries never count against the bound. Set `memory.inFlightWriteFraction` to move it, as a fraction above 0 and at most 1.

A primary also checks each document against the memory that indexing it can take, because the node's measurement shows only the memory in use before a write starts. Before it indexes a document, the primary works out a bound from the lengths of the document's strings without analysing the text. It refuses the document when its latest measurement plus that bound passes the block level of the heap or of the process. The node also counts the bound of every document that it is indexing, and the bound of every document that it has finished since its last measurement, because the memory that a finished document leaves behind appears only in a later measurement. The node adds these figures together for each document's bound:

- Each distinct term counts as 2,048 bytes, and a term in a partial-word field counts 512 bytes more. On Node 24, a distinct term took about 1.4 KiB of heap in a text field, and the partial-word index added about 280 bytes to it.
- A language that splits text on one repeated character class produces at most one term for every two characters, which covers every built-in language without n-grams. Chinese, Japanese, Korean, Thai, Lao, Khmer, and Burmese index n-grams, so they can produce one term for every character, and so can any language with another split pattern. Unicode normalisation can triple a string's length before the language splits it, so the bound triples the length too.
- A field with a custom tokeniser has no such limit, so the node runs the tokeniser on the field and counts the terms that it returns.
- A pattern field counts 1,536 bytes for each character, which is 512 bytes for each of the three characters that case folding can turn one character into. A run of three characters that no other value holds took about 370 bytes.
- An enum value counts 256 bytes. Every value in the document, whether it is a string, a number, a literal, an object, or an array, counts 256 bytes, every property of an object counts 128 bytes more, and every character of a string or a key and every byte of a binary value counts 24 bytes. On Node 22 and Node 24 alike, writing a number inside an array held about 193 bytes of heap at its peak, a literal about 99 bytes, an empty object about 74 bytes, and an object with one key that no other object used about 481 bytes. So the charge is at least 25% above each of those figures, because a change to how V8 lays objects out can move them. Two hundred fields that the schema leaves out took about 16 bytes of heap for every byte of the document.
- A vector field counts 5,120 bytes for each document that carries it, plus 80 bytes for each dimension that the schema gives it, whatever the length of the array that the document sends. The node doesn't count the vector's components as values as well. On Node 24 with workers off, while the HTTP server took batches of 250 documents, a batch at 1,536 dimensions raised the heap by about 40 bytes for each component at its peak, counting the request's text and its parsed array. The process's resident memory grew by about 14 bytes for each component at that peak. A document kept about 2.65 KB of heap whatever its dimension, while the index's resident memory kept about 2.5 KB for each document at 16 dimensions, 16.8 KB at 384 dimensions, and 35.8 KB at 1,536 dimensions, beyond what a document without a vector kept. The index builds its graph once it holds 1,024 vectors, and the batch that took it past that point peaked at up to 137 KB of heap for each of its documents at 1,536 dimensions, close to the 128 KB that the charge gives a document of that dimension.

The bound is far larger than the memory that honest text takes, about 27 bytes for each character, because it has to hold for any document that a client can send. A primary indexes a batch in groups of at most 1,000 documents, checking its memory before each group, so that a node with room takes whole groups while a node close to its limit takes fewer documents at a time. That check takes a new measurement once 10 ms have passed since the last one, or once the bounds of the documents taken since then pass 1% of the heap limit, and the node always measures again before it refuses a document. The check also counts the bytes in use in the young generation against the heap limit. V8 puts new objects, including the index data of the documents that the node indexed most recently, in the young generation, from which it moves the live ones into the old generation only at its next collection. A node that reads the old generation alone can therefore miss tens of megabytes of live index data. A 192 MB node that left those bytes out ran out of heap on 2 of 3 runs of one batch of 989 documents. The node's once-a-second measurement leaves them out as before, and so does the `full` flag, because only the old generation's growth runs a process out of memory. When even the next document of a batch does not fit, the primary refuses it and every later document of the batch for that partition, and it keeps every document that it has already indexed. Each refused document appears in the batch's `failed` list with `CLUSTER_WRITE_BLOCKED` and the reason `write_would_fill_memory`, so retry those documents once the writes in progress finish. A document whose bound passes the block level of the heap limit on its own gets the reason `write_exceeds_memory`, because it cannot fit even on an idle node, so split it into smaller documents. Before it refuses a document, the node can run a garbage collection and measure again, at most once a second, and it waits ten times as long as the last collection took before it runs another, so that these collections never take more than a tenth of the thread's time. When that limit holds a full collection back, the node collects the young generation alone, at most once every 10 ms, and measures again, because the young generation then holds only the objects that are still live. The HTTP server does the same before it refuses to parse a body. Removes and replicated entries never count against the bound.

When a primary refuses a write that another node forwarded to it, for any of these reasons, the entry node answers with the primary's code, message, and `details`, to which it adds the `indexName` and the `primaryNodeId`, so the reason reaches the client either way. A primary on an earlier release of Narsil sends no details, so the error's `details` then include only the `indexName` and the `primaryNodeId`.

The controller places partitions by size as well. Each node reports the estimated size of every partition that it holds, and the controller takes the largest size that any node reports for a partition, or 50 MiB for a partition that no node reports yet. It gives a node a new copy only where that copy fits, together with what the node already holds, within the node's `capacity.memoryBytes`, which defaults to 8,000,000,000 bytes, and it gives no new copy to a node that reports full.

## Searches

`query` has two phases so that the cluster moves as few bytes as possible. The coordinator picks one copy of each partition, sends each selected node the query and the partition ids that it picked the node for, merges the scored ids into one ranking, and then fetches the full documents for the winning page alone. Each data node answers for exactly the named partitions, so two nodes holding overlapping copies never double-count a document.

The coordinator picks each copy by hashing the query together with the partition id and the id of each node that holds a copy, and it takes the node with the highest hash. Every coordinator therefore sends a repeated query, and each page of it, to the same copies for as long as those copies stay in service. That matters for a vector search, because each node builds its own graph for its copy, so two copies can return slightly different nearest neighbours for the same vector. Different queries hash to different copies, which spreads the load across them, and when a copy joins or leaves, the coordinator changes its choice only for the queries that hash highest on that copy. A single query that clients repeat many times reads each partition from one copy, so its share of the load stays on that copy.

A query that a data node refuses, such as one with a malformed filter, fails with the error that the node raises, since every node would raise the same one. Each data node counts facet values over its own partitions, and the coordinator merges them and returns up to each field's `limit`, 10 values by default, highest count first. For a facet with `ranges`, each node counts every range and the coordinator adds up the counts, so the totals are exact, and a facet that sets ranges and no `limit` returns every range. A cluster search counts up to 1,000 ranges on one field and fails with `CONFIG_INVALID` for more. For a facet with `sort: 'asc'`, each node sends the count of every value, up to 10,000 of them, so the coordinator finds the true lowest counts wherever no node holds more values than that.

When the copy that the coordinator picked fails, times out, or cannot be reached, the coordinator sends that partition's part of the query to the next in-sync copy, in the order that the hash gives, and it fetches the documents in the same way. It counts a partition as timed out or failed only once every copy of it has timed out or failed, so a search finds every match while one in-sync copy of each partition answers. The coordinator sends a query that a node refuses to no other copy, because every copy would refuse it.

The cluster answers from the partitions that reply, while the result's `coverage` counts the rest as `totalPartitions`, `queriedPartitions`, `timedOutPartitions`, and `failedPartitions`. Read those figures wherever a degraded answer would mislead a caller, because a lost partition lowers `count` and keeps its documents out of the ranking. An embedded engine fills the same field, counting as read every partition that it holds, so you read the result the same way whether it comes from an engine or from a cluster. While no partition is `ACTIVE` yet, which is the state an index passes through while the controller allocates it, the cluster reads nothing and counts every partition as failed, so the coverage tells you why the answer is empty.

A query that carries `rerank` reranks on the coordinator that receives it. That node sends the data nodes the query without `rerank`, merges their rankings, reads the reranked fields of the top hits, and asks its own rerank adapter for scores. Register the adapter with `registerRerankAdapter` on every node that takes queries from clients, because the data nodes need none. See [Reranking](reranking.md#over-http-and-in-a-cluster).

Set `query` on a node's configuration to change how it treats a partition that it cannot reach. `allowPartialResults` is true by default. With `allowPartialResults: false`, the cluster fails the whole search with `QUERY_PARTIAL_FAILURE` as soon as one partition times out or errors on every copy, or holds no active copy. When one node stops a search with `SEARCH_WORK_CAP_EXCEEDED`, the cluster fails the whole search with that error, whatever value `allowPartialResults` holds, because the results of the other nodes would leave out every match that the stopped node had yet to find. `partitionTimeout` sets how many milliseconds the coordinator waits for each copy before it asks the next one, and it defaults to 5000. A search that meets a paused copy can therefore take up to that long again for each further copy that it asks.

```ts
await createClusterNode({
  coordinator,
  transport: createInMemoryTransport('node-b', network),
  address: 'node-b:9200',
  query: { allowPartialResults: false, partitionTimeout: 2_000 },
})
```

## Exact reads

`countDocuments`, `getStats`, `getPartitionStats`, `listDocuments`, `suggest`, and `preflight` gather from one copy of every partition, moving to the next in-sync copy where one fails, and merge:

- `countDocuments` sums per-partition document counts.
- `getStats` sums the counts and memory estimates, and reads the schema from the coordinator.
- `getPartitionStats` returns one entry per partition, in partition order.
- `listDocuments` merges each node's page into one, in document-id order or in the sort order you name, while the cursor works across the whole cluster the way it does on a single engine.
- `preflight` sums the per-partition match counts.
- `suggest` merges completions and sums their document frequencies. Each node reports its most frequent completions alone, so the merge can undercount a term that ranks low on every node, exactly as it can undercount a distributed facet.

These reads refuse to answer partially, because each returns a figure that a missing partition would silently falsify. The call fails with `QUERY_NO_ACTIVE_REPLICA` where a partition has no reachable copy, and it fails the same way where every copy of a partition is still bootstrapping.

`listIndexes` lists every index that the cluster holds a schema for, with its document count summed over every partition, and it fails with `QUERY_PARTIAL_FAILURE` where no copy of some partition answers its count. The state, the reopen count, and the stale analysis flag in each entry describe the copy on the node that you call. `rebuildAnalysis` rebuilds the terms of an index on every node that holds a copy, and it returns once every one of those nodes has finished. Each node rebuilds its own copies from their documents and skips a copy whose analysis is current. The call fails with `QUERY_PARTIAL_FAILURE` where a node fails, can't be reached, or leaves the cluster before it answers, and the error's `details.nodeIds` holds each such node.

## What a node serves

A node routes every read and every write for an index through its copy of the allocation table, which a watch on the coordinator keeps current. A node that already holds the table of an index therefore goes on routing requests for that index while the coordinator can't be reached. While the coordinator holds the index metadata and no allocation table yet, the node refuses every read and every write with `QUERY_ROUTING_FAILED`, which the HTTP server answers with status 503. That window opens when `createIndex` publishes the schema and closes when the controller places the partitions. The refusal keeps one node's copy from taking a write that no other node would find. An index that the coordinator holds no metadata for is the one exception, because a node creates such an index on its own engine and serves it from its own copy.

A node reports where it stands through `node.cluster.getReadiness()`, which returns one of four states. `STARTING` covers the time before the node holds a registration. `JOINING` covers the time it spends bootstrapping a partition that the controller gives it, so a node returns to `JOINING` whenever the controller gives it another. `SERVING` means the node serves every partition that the controller allocates to it. `LEAVING` begins with shutdown. A node that leads a partition through `MIGRATING` or `DECOMMISSIONING` keeps reporting `SERVING`, because it keeps serving that partition until the transition finishes. `node.cluster.listNodes()` returns every registration that the coordinator holds, while `node.cluster.getControllerNodeId()` names the node holding the controller lease.

A node opens its replication listener before it registers, so a peer that reaches it early receives a refusal in place of a connection failure. Until the node joins, it answers every message with `NODE_NOT_READY`. A node holding no controller lease answers a controller message with `NODE_NOT_CONTROLLER`. The node that forwards a write to such a peer raises the code that the peer sends, which the HTTP server answers with status 503 as well.

## Node-local operations

`checkpoint`, `open`, `close`, `getMemoryStats`, `on`, `off`, and `registerRerankAdapter` reach the local engine of the node that you call them on, because durability, index memory, process memory, engine events, and rerank adapters are per-node facts. Ask each node for its own. When you call `close`, the node releases only its own copy of the index, which it reopens when it receives a routed read or write. See [Index lifecycle](persistence-and-durability.md#index-lifecycle).

## What a cluster node refuses

`snapshot`, `restore`, `exportDocuments`, `importDocumentExport`, `updatePartitionConfig`, the vector maintenance calls, `registerEmbeddingAdapter`, `waitForWrites`, and a write carrying `wait: true` on the `Narsil` adapter fail with `CLUSTER_OPERATION_UNSUPPORTED`, which the HTTP server answers with status 501, so a caller learns that the operation is missing. The adapter's own `listIndexes`, `getStats`, and `getPartitionStats` fail the same way, because the `Narsil` interface declares them synchronous while a cluster answer needs a round trip. Call those three on the `ClusterNode`, where they return promises. The HTTP server answers the index list, the index figures, and the partition figures from the whole cluster.

## Serve a cluster node over HTTP

`clusterNodeEngine` adapts a node to the same interface that a single engine offers, so `createServer` from `@delali/narsil/server` serves it unchanged. Pass `node.cluster` as the `cluster` option so that the server reports the node's readiness and its view of the cluster:

```ts
import { clusterNodeEngine } from '@delali/narsil/distribution'
import { createServer } from '@delali/narsil/server'

const server = createServer(clusterNodeEngine(node), { host: '0.0.0.0', port: 9701, cluster: node.cluster })
await server.listen()
```

With that option set, `GET /readyz` answers 200 only while the node reports `SERVING`, `GET /cluster` reports every registered node and the controller, and `GET /indexes/{name}/cluster` reports one index's allocation partition by partition. The [HTTP server guide](http-server.md#cluster-routes) shows each body. Every node can serve HTTP, so a client may send any request to any node, and the node routes it from there.

### Check the health of the cluster

`GET /cluster/health` reports a `green`, `yellow`, or `red` status for the cluster and for each index, and `node.cluster.getHealth()` returns the same answer in code. The node works out each status from the allocation tables that it watches. An index is `green` when every partition is `ACTIVE` with a primary and `replicationFactor` in-sync replicas. It is `yellow` when every partition has a primary but some partition is not `ACTIVE` or holds fewer in-sync replicas, and it is `red` when some partition has no primary, so the documents in that partition can be neither read nor written. A primary or a replica counts only while its node stays registered with the coordinator. The cluster takes the worst status of its indexes, and a cluster that holds no index reports `green`. The route answers 200 whatever the status, so read the status from the body, which the [HTTP server guide](http-server.md#cluster-health) shows.

### Scrape the metrics

`GET /metrics` answers in the Prometheus text format, and `node.cluster.getMetrics()` returns the same figures as objects. Each node reports these series:

- `narsil_replication_lag`, labelled with `index`, `partition`, and `replica`, counts the entries that each replica has yet to acknowledge, for each partition that the node leads.
- `narsil_commit_point`, labelled with `index` and `partition`, holds the highest sequence number that the node has acknowledged to a client, for each partition that it leads.
- `narsil_commit_point_floor`, labelled with `index` and `partition`, holds the floor on the commit point that the allocation table stores for every partition in the cluster. The controller raises it only when it admits a replica, so it can trail `narsil_commit_point` by many writes.
- `narsil_in_sync_replicas`, labelled with `index` and `partition`, counts the replicas besides the primary in the in-sync set of every partition in the cluster.
- `narsil_coordinator_request_seconds`, labelled with `operation`, is a histogram of how long the calls from the node to the coordinator took, such as `getAllocation`, in buckets from 1 millisecond to 10 seconds. With the etcd coordinator, the histogram times the etcd requests behind each call.

Scrape every node, because each one reports the lag and the commit point only for the partitions that it leads. The health route and the metrics route both pass through the `onRequest` hook of the server, so they take the same authentication as the routes that change data, and a server that fronts a single engine answers both with 501. The [HTTP server guide](http-server.md#metrics) shows each series with its labels.

### Reach every node from the client

`createNarsilClient` from `@delali/narsil/client` takes a list of node URLs, so that the client moves on to another node when one fails:

```ts
import { createNarsilClient } from '@delali/narsil/client'

const client = createNarsilClient({
  url: ['https://narsil-1.internal:9701', 'https://narsil-2.internal:9701', 'https://narsil-3.internal:9701'],
})
```

The client sends each request to one URL, starting one place after the URL that took the previous request, so that requests spread across the nodes. It moves a request to the next URL when the connection fails, when the request times out, or when the node answers 502, 503, or 504, and it tries each URL at most once per request. The client repeats a request on another node only where repeating it can't apply a change twice:

- A read moves on after any of those failures. The client counts every `GET` as a read, along with a search, a preflight, a suggestion, a document list, and a `_multi-get`.
- A write moves on only where the client sent no byte of it, because the connection was refused or the host name didn't resolve, or where the node answered `NODE_NOT_READY`. A browser reports no reason for a failed connection, so a write from a browser moves on only after a `NODE_NOT_READY` answer.
- A write that times out, or that a node answers with 502, 503, or 504 and a code other than `NODE_NOT_READY`, fails with that error, so that you decide whether to send it again.
- A request whose body is a stream goes to one URL alone, because the client can't read the stream a second time.

After a URL refuses a connection, the client skips it for `urlSkipMs`, 1,000 milliseconds by default, and it doubles that wait after each further refusal up to `maxUrlSkipMs`, 30,000 milliseconds by default. Any answer from the URL other than 502, 503, or 504 ends the skip. The [client guide](client.md) covers the other options.
