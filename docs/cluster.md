# Cluster mode

Narsil operates as a cluster of nodes that share one set of indexes. The engine splits each index into a fixed number of partitions, each of which takes its writes through one primary node. Before the client receives its answer, every replica of that partition takes the write through a replication log. The documents in [`packages/spec/distribution`](../packages/spec/distribution) define the cross-language contract, while this guide covers the TypeScript implementation under `@delali/narsil/distribution`.

Cluster mode is experimental. The API may change between releases, so pin an exact version before you depend on it.

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

A node plays one or more of three roles. A `data` node holds partitions and serves searches. A `coordinator` node fans client requests out and merges the answers. A `controller` node stands for election. The node that holds the lease then assigns partitions to nodes. A node holds all three roles by default, which suits a cluster of three nodes or fewer. Every node registers with the coordinator whatever roles it holds, so the registry lists a coordinator-only node as well. The controller places partitions on `data` nodes alone.

## Create, drop, and clear an index

`createIndex` publishes the schema through the coordinator, and the controller then assigns the partitions to nodes. The call returns once every partition is in service, so a write that you send straight afterwards reaches a primary that holds the index. The options set how the engine spreads the index and how long the call waits:

```ts
await node.createIndex(
  'products',
  { schema: { title: 'string', price: 'number' } },
  { partitionCount: 6, replicationFactor: 2, waitForServingMs: 10_000 },
)
```

`partitionCount` defaults to 5 and stays fixed for the life of the index. `replicationFactor` counts the copies beyond the primary and defaults to 1, which means two copies of every partition. A factor of 0 keeps one copy, so you lose that partition's documents when the node holding it fails.

`waitForServingMs` bounds the wait and defaults to 30000. The call returns at the deadline whether or not the partitions are in service. It returns at once where no registered node holds the `controller` role or none holds the `data` role, because no node would allocate the index. The node refuses a write that arrives before the allocation exists, raising `QUERY_ROUTING_FAILED`, which names the state the cluster is in. A caller that passes 0 to skip the wait can therefore expect that code until the controller finishes. See [What a node serves](#what-a-node-serves).

`dropIndex` removes the index from the whole cluster. The dropping node clears the index metadata and drops the schema. The controller observes the drop and empties the allocation, which every holder answers by dropping its local copy. The teardown finishes after the call returns, so a query racing the drop can reach a node whose copy is already gone. The name becomes reusable once the coordinator state is gone.

`clear` empties an index and keeps it. The engine sends each removal through the replication log the way it sends a single `remove`, so it performs one listing and one batched removal per page while it clears a large index.

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

## Searches

`query` has two phases so that the cluster moves as few bytes as possible. The coordinator picks one copy of each partition, sends each selected node the query and the partition ids that it picked the node for, merges the scored ids into one ranking, and then fetches the full documents for the winning page alone. Each data node answers for exactly the named partitions, so two nodes holding overlapping copies never double-count a document.

The coordinator picks each copy by hashing the query together with the partition id and the id of each node that holds a copy, and it takes the node with the highest hash. Every coordinator therefore sends a repeated query, and each page of it, to the same copies for as long as those copies stay in service. That matters for a vector search, because each node builds its own graph for its copy, so two copies can return slightly different nearest neighbours for the same vector. Different queries hash to different copies, which spreads the load across them, and when a copy joins or leaves, the coordinator changes its choice only for the queries that hash highest on that copy. A single query that clients repeat many times reads each partition from one copy, so its share of the load stays on that copy.

A query that a data node refuses, such as one with a malformed filter, fails with the error that the node raises, since every node would raise the same one. Each data node counts facet values over its own partitions, and the coordinator merges them and returns up to each field's `limit`, 10 values by default, highest count first. For a facet with `ranges`, each node counts every range and the coordinator adds up the counts, so the totals are exact, and a facet that sets ranges and no `limit` returns every range. A cluster search counts up to 1,000 ranges on one field and fails with `CONFIG_INVALID` for more. For a facet with `sort: 'asc'`, each node sends the count of every value, up to 10,000 of them, so the coordinator finds the true lowest counts wherever no node holds more values than that.

The cluster answers from the partitions that reply, while the result's `coverage` counts the rest as `totalPartitions`, `queriedPartitions`, `timedOutPartitions`, and `failedPartitions`. Read those figures wherever a degraded answer would mislead a caller, because a lost partition lowers `count` and keeps its documents out of the ranking. An embedded engine fills the same field, counting as read every partition that it holds, so you read the result the same way whether it comes from an engine or from a cluster. While no partition is `ACTIVE` yet, which is the state an index passes through while the controller allocates it, the cluster reads nothing and counts every partition as failed, so the coverage tells you why the answer is empty.

Set `query` on a node's configuration to change how it treats a partition that it cannot reach. `allowPartialResults` is true by default. With `allowPartialResults: false`, the cluster fails the whole search with `QUERY_PARTIAL_FAILURE` as soon as one partition times out, errors, or holds no active copy. `partitionTimeout` sets how many milliseconds the coordinator waits for each node, and it defaults to 5000.

```ts
await createClusterNode({
  coordinator,
  transport: createInMemoryTransport('node-b', network),
  address: 'node-b:9200',
  query: { allowPartialResults: false, partitionTimeout: 2_000 },
})
```

## Exact reads

`countDocuments`, `getStats`, `getPartitionStats`, `listDocuments`, `suggest`, and `preflight` gather from one copy of every partition and merge:

- `countDocuments` sums per-partition document counts.
- `getStats` sums the counts and memory estimates, and reads the schema from the coordinator.
- `getPartitionStats` returns one entry per partition, in partition order.
- `listDocuments` merges each node's page into one, in document-id order or in the sort order you name, while the cursor works across the whole cluster the way it does on a single engine.
- `preflight` sums the per-partition match counts.
- `suggest` merges completions and sums their document frequencies. Each node reports its most frequent completions alone, so the merge can undercount a term that ranks low on every node, exactly as it can undercount a distributed facet.

These reads refuse to answer partially, because each returns a figure that a missing partition would silently falsify. The call fails with `QUERY_NO_ACTIVE_REPLICA` where a partition has no reachable copy, and it fails the same way where every copy of a partition is still bootstrapping.

## What a node serves

A node routes every read and every write for an index through the allocation table that the coordinator holds for it. While the coordinator holds the index metadata and no allocation table yet, the node refuses every read and every write with `QUERY_ROUTING_FAILED`, which the HTTP server answers with status 503. That window opens when `createIndex` publishes the schema and closes when the controller places the partitions. The refusal keeps one node's copy from taking a write that no other node would find. An index that the coordinator holds no metadata for is the one exception, because a node creates such an index on its own engine and serves it from its own copy.

A node reports where it stands through `node.cluster.getReadiness()`, which returns one of four states. `STARTING` covers the time before the node holds a registration. `JOINING` covers the time it spends bootstrapping a partition that the controller gives it, so a node returns to `JOINING` whenever the controller gives it another. `SERVING` means the node serves every partition that the controller allocates to it. `LEAVING` begins with shutdown. A node that leads a partition through `MIGRATING` or `DECOMMISSIONING` keeps reporting `SERVING`, because it keeps serving that partition until the transition finishes. `node.cluster.listNodes()` returns every registration that the coordinator holds, while `node.cluster.getControllerNodeId()` names the node holding the controller lease.

A node opens its replication listener before it registers, so a peer that reaches it early receives a refusal in place of a connection failure. Until the node joins, it answers every message with `NODE_NOT_READY`. A node holding no controller lease answers a controller message with `NODE_NOT_CONTROLLER`. The node that forwards a write to such a peer raises the code that the peer sends, which the HTTP server answers with status 503 as well.

## Node-local operations

`checkpoint`, `open`, `close`, `getMemoryStats`, `on`, and `off` reach the local engine of the node that you call them on, because durability, index memory, process memory, and engine events are per-node facts. Ask each node for its own. When you call `close`, the node releases only its own copy of the index, which it reopens when it receives a routed read or write. See [Index lifecycle](persistence-and-durability.md#index-lifecycle).

## What a cluster node refuses

`snapshot`, `restore`, `rebalance`, `updatePartitionConfig`, `rebuildAnalysis`, the vector maintenance calls, `listIndexes`, the synchronous stats calls, `waitForWrites`, and a write carrying `wait: true` on the `Narsil` adapter fail with `CLUSTER_OPERATION_UNSUPPORTED`, which the HTTP server answers with status 501, so a caller learns that the operation is missing. `rebalance` stays refused because the specification fixes `partitionCount` for the life of an index, while the rest still need a cluster-wide design.

## Serve a cluster node over HTTP

`clusterNodeEngine` adapts a node to the same interface that a single engine offers, so `createServer` from `@delali/narsil/server` serves it unchanged. Pass `node.cluster` as the `cluster` option so that the server reports the node's readiness and its view of the cluster:

```ts
import { clusterNodeEngine } from '@delali/narsil/distribution'
import { createServer } from '@delali/narsil/server'

const server = createServer(clusterNodeEngine(node), { host: '0.0.0.0', port: 9701, cluster: node.cluster })
await server.listen()
```

With that option set, `GET /readyz` answers 200 only while the node reports `SERVING`, `GET /cluster` reports every registered node and the controller, and `GET /indexes/{name}/cluster` reports one index's allocation partition by partition. The [HTTP server guide](http-server.md#cluster-routes) shows each body. Every node can serve HTTP, so a client may send any request to any node, and the node routes it from there.
