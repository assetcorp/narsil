# Cluster mode

Narsil runs as a cluster of nodes that share one set of indexes. Each index splits into a fixed number of partitions, and every partition has one primary node that accepts its writes. The partition's replicas receive each write through a replication log before the client hears back. The documents in [`packages/spec/distribution`](../packages/spec/distribution) define the cross-language contract, and this guide covers the TypeScript implementation under `@delali/narsil/distribution`.

Cluster mode is experimental. The API changes between releases, so pin an exact version before you depend on it.

## Build a node

A node needs two adapters: a coordinator, which holds the cluster's shared state, and a transport, which carries messages between nodes. The in-memory pair runs a whole cluster inside one process, which is how the test suite exercises it.

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

A production cluster swaps both adapters and keeps the rest of the code identical. `createEtcdCoordinator` from `@delali/narsil/distribution/coordinator/etcd` stores the shared state in etcd. The TCP transport from `@delali/narsil/distribution/transport/tcp` or the gRPC transport from `@delali/narsil/distribution/transport/grpc` carries messages between hosts, and both support mutual TLS. The [cluster dashboard example](../packages/ts/examples/cluster-dashboard) runs three nodes this way against an etcd container, puts a fault injector on every link between them, and shows each partition's primary, in-sync set, and commit point as they change.

A node plays one or more of three roles. A `data` node holds partitions and serves searches. A `coordinator` node fans client requests out and merges the answers. A `controller` node stands for election, and the one holding the lease assigns partitions to nodes. A node carries all three roles by default, which suits a cluster of three nodes or fewer.

## Create, drop, and clear an index

`createIndex` publishes the schema through the coordinator, and the controller then assigns the partitions to nodes. The options set how the index spreads:

```ts
await node.createIndex(
  'products',
  { schema: { title: 'string', price: 'number' } },
  { partitionCount: 6, replicationFactor: 2 },
)
```

`partitionCount` is fixed for the life of the index, and it defaults to 5. `replicationFactor` counts the copies beyond the primary, and it defaults to 1, which means two copies of every partition. A factor of 0 keeps one copy, so a lost node then costs that partition's documents.

`dropIndex` removes the index from the whole cluster. The dropping node clears the index metadata and drops the schema. The controller observes the drop and empties the allocation, which every holder answers by dropping its local copy. The teardown finishes after the call returns, so a query racing the drop can reach a node whose copy is already gone. The name becomes reusable once the coordinator state is gone.

`clear` empties an index and keeps it. Each removal runs through the replication log the way a single `remove` does, so clearing a large index costs one listing and one batched removal per page.

## What a node does with the indexes it already holds

A node that stores its indexes on disk still holds them when it starts again, and the cluster may have moved on while it was down. Every index carries the identity the cluster gave it at creation, so a rejoining node compares that identity with the coordinator's and does one of three things:

- The identities match, so the node adopts its copy and serves it.
- The coordinator names another index under that name, which happens when you drop an index and create another with the same name, so the node drops its copy and takes the new index on from its primary. Without that check the old documents would come back under the new name.
- The coordinator holds nothing for the name, so the node keeps the data, serves none of it, and reports the index through the `onError` callback you configured. Every call naming that index fails with `INDEX_ORPHANED`, which the HTTP server answers with status 409. The node keeps the data because a coordinator that was wiped or restored from a backup looks exactly like one that never held the index, and it is the operator who decides. `dropIndex` on that node deletes the copy and frees the space.

## Writes

`insert`, `update`, and `remove` route each document to its partition's primary by hashing the document id. When this node is the primary, it applies the write locally, appends a log entry, and waits for every in-sync replica to acknowledge before it returns. When another node is the primary, this node forwards the mutation there and the primary takes over.

An `update` replaces the stored document whole, and the primary replicates the complete replacement rather than the changed fields, so every replica applies a self-contained document.

The batch calls group their work before sending it. `insertBatch`, `updateBatch`, and `removeBatch` split the documents by partition, apply each local group through one replication batch per partition, and send each remote primary one `replication.forward_batch` message carrying every document bound for it. One outcome per document comes back. A batch of one falls back to the plain single-document message, and a larger batch splits at 1,000 operations or 8 MB of document bytes per message.

A write that fails after it was applied locally rolls back before the error reaches you: a failed insert removes the document, and a failed update or remove restores the one that was there.

## Searches

`query` runs in two phases so that the cluster moves as few bytes as possible. The coordinator picks one copy of each partition, sends each selected node the query and the partition ids it was picked for, merges the scored ids into one ranking, and then fetches the full documents for the winning page alone. Each data node answers for exactly the named partitions, so two nodes holding overlapping copies never double-count a document.

A search answers from the partitions that replied, while the result's `coverage` counts the rest, giving `totalPartitions`, `queriedPartitions`, `timedOutPartitions`, and `failedPartitions`. Read those figures wherever a degraded answer would mislead a caller, because a lost partition lowers `count` and keeps its documents out of the ranking. An embedded engine fills the same field, counting every partition it holds as read, so you read the result the same way whether it came from an engine or from a cluster. While no partition is `ACTIVE` yet, which is the state an index passes through while the controller allocates it, the node answers from its own copy and counts every partition as failed, so the coverage marks that answer as one node's alone.

Set `query` on a node's configuration to change how it treats a partition it cannot reach. `allowPartialResults` is true by default, whereas false fails the whole search with `QUERY_PARTIAL_FAILURE` as soon as one partition times out, errors, or has no active copy. `partitionTimeout` is how many milliseconds the coordinator waits for each node, which is 5000 where you name none.

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
- `listDocuments` merges each node's page into one, in document-id order or in the sort order you name, and the cursor works across the whole cluster the way it does on a single engine.
- `preflight` sums the per-partition match counts.
- `suggest` merges completions and sums their document frequencies. Each node reports its most frequent completions alone, so a term that ranks low on every node can be undercounted, exactly as distributed facet counts can.

These reads fail rather than answer partially, because each returns a figure a missing partition would silently falsify. A partition with no reachable copy fails the call with `QUERY_NO_ACTIVE_REPLICA`.

## Node-local operations

`checkpoint`, `getMemoryStats`, `on`, and `off` reach the local engine of the node you call them on, because durability, process memory, and engine events are per-node facts. Ask each node for its own.

## What a cluster node refuses

`snapshot`, `restore`, `rebalance`, `updatePartitionConfig`, `rebuildAnalysis`, the vector maintenance calls, `listIndexes`, and the synchronous stats calls on the `Narsil` adapter fail with `CLUSTER_OPERATION_UNSUPPORTED`, which the HTTP server answers with status 501, so a caller learns the operation is missing rather than reading a wrong answer. `rebalance` stays refused because the specification fixes `partitionCount` for the life of an index, and the rest need a cluster-wide design that has not been built yet.

## Serve a cluster node over HTTP

`clusterNodeEngine` adapts a node to the same interface a single engine offers, so `createServer` from `@delali/narsil/server` serves it unchanged:

```ts
import { clusterNodeEngine } from '@delali/narsil/distribution'
import { createServer } from '@delali/narsil/server'

const server = createServer(clusterNodeEngine(node), { host: '0.0.0.0', port: 9701 })
await server.listen()
```

Every node can run a server, so a client may send any request to any node, and the node routes it from there.
