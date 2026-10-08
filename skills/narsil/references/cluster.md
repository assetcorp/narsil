# The multi-node cluster

The cluster under `@delali/narsil/distribution` spreads each index's partitions across nodes, replicates each partition, and routes writes to its primary. It is experimental, and its API can change without notice, so confirm with the user before you build on it. A single server with durability, from [server.md](server.md) and [storage.md](storage.md), needs no coordinator and no certificates.

1. Take every option from the installed types for `@delali/narsil/distribution`, `/distribution/coordinator/etcd`, `/distribution/transport/tcp`, and `/distribution/transport/grpc`, because the versioned documentation has no cluster page.
2. Install `etcd3`, and give every node a coordinator from `await createEtcdCoordinator({ endpoints, keyPrefix })`, pointed at the same etcd cluster, because etcd holds the cluster's shared state across hosts and restarts.
3. Give each node a transport from `createTcpTransport(nodeId, { host, port, tls })`, which needs no peer package, or from `createGrpcTransport(nodeId, { host, port, tls })` after you install `@grpc/grpc-js`. Pass `tls` on every node so that each connection is mutually authenticated, and create the certificates with `@delali/narsil-certutil`, which installs the `narsil-certutil` command.
4. Create each node with `await createClusterNode({ coordinator, transport, address, roles })`, join it with `await node.start()`, and create indexes through a node with `node.createIndex(name, config, { partitionCount, replicationFactor })`. `await node.shutdown()` hands its partitions on before the process exits.
5. Give the index's tokenizer and embedding adapter by registered name, and its stop words as a set or a registered name. Register those names and the language module on every node, because every node builds its own copy of the index.
6. Serve a node over HTTP with `createServer(clusterNodeEngine(node), { cluster: node.cluster })`. The adapter throws `CLUSTER_OPERATION_UNSUPPORTED` for `getStats`, `getPartitionStats`, and `listIndexes`, which the server answers with 501, so call those on the node, where they return promises.

`createInMemoryCoordinator` and `createInMemoryTransport` exist for tests alone. They hold every node inside one process and keep nothing once it exits, so use them in a test suite and never in a deployment.

A missing peer makes the etcd coordinator throw `COORDINATOR_DEPENDENCY_MISSING` and the gRPC transport throw `TRANSPORT_DEPENDENCY_MISSING`. A search that a slow or failed node leaves incomplete still returns hits, so read `results.coverage`, or set `query: { allowPartialResults: false }` on the node to fail it with `QUERY_PARTIAL_FAILURE`.
