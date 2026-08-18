# Run a three-node Narsil cluster

This example runs three Narsil nodes as separate processes. The nodes replicate over TCP with mutual TLS, an etcd container coordinates allocation and failover, and every node serves client HTTP. The demo script ingests documents through one node, searches and reads through the other two, kills the ingest node, and shows the cluster promoting replicas and answering the full corpus without it.

## What runs

- Three node processes, `node-a`, `node-b`, and `node-c`, each holding the data, coordinator, and controller roles.
- One etcd container, which holds the allocation table, the node registry, and the controller lease.
- An HTTP server on every node, so a client can send any request to any node. Elasticsearch and Qdrant serve clients the same way.

The index is split into 6 partitions with 2 copies each, so losing any one node leaves a full copy of every partition.

| Node | HTTP | TCP |
| --- | --- | --- |
| node-a | 127.0.0.1:9701 | 127.0.0.1:9301 |
| node-b | 127.0.0.1:9702 | 127.0.0.1:9302 |
| node-c | 127.0.0.1:9703 | 127.0.0.1:9303 |

A cluster node serves index creation, writes, searches, and document reads over HTTP. It answers every other endpoint, such as suggest, snapshot, and the admin routes, with status 501 and the code `CLUSTER_OPERATION_UNSUPPORTED`, so a client learns the operation is missing rather than reading a wrong answer.

The nodes run without durability, so `docker compose down` and a process kill leave nothing behind. Replication is the only persistence in this example.

## Setup

The example needs Node.js 22 or newer, pnpm, and Docker with Compose.

The node processes import `@delali/narsil` and the certificate tool from the workspace, and both resolve to files under `dist/`. Build them once from the repository root:

```sh
pnpm install
pnpm --filter @delali/narsil build
pnpm --filter @delali/narsil-certutil build
```

Then, from this directory, generate the certificate authority and one certificate per node, and start etcd:

```sh
pnpm certs
pnpm etcd:up
```

## Run the demo

```sh
pnpm demo
```

The script starts the three nodes, creates the index through `node-a`, and waits until every partition is `ACTIVE` with two in-sync copies. It then ingests 30 documents through `node-a`, polls `node-b` until a search answers all 30, and reads one document through `node-c`, which fetches it from the node holding that partition. Finally it kills `node-a` with SIGKILL, waits for the controller to promote replicas, and repeats the search and the read against the survivors.

Each step prints with a timestamp. Failover waits on the etcd heartbeat lease, which this example sets to 5 seconds, so expect the failover step to take several seconds rather than milliseconds.

## Run nodes by hand

Each node reads its identity from `NODE_ID`:

```sh
NODE_ID=node-a pnpm node
NODE_ID=node-b pnpm node
NODE_ID=node-c pnpm node
```

With the nodes up, create an index and talk to any of them:

```sh
curl -X POST http://127.0.0.1:9701/indexes \
  -H 'content-type: application/json' \
  -d '{"name": "articles", "config": {"schema": {"title": "string", "body": "string"}}}'

curl -X POST http://127.0.0.1:9702/indexes/articles/search \
  -H 'content-type: application/json' \
  -d '{"term": "falconry"}'
```

## Tear down

```sh
pnpm etcd:down
```

This removes the etcd container and its volume. The certificates under `certs/` stay until you delete them.
