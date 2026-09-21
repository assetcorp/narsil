# Watch a three-node Narsil cluster survive a fault

This example starts three Narsil nodes as containers that coordinate through etcd. Every link between them passes through a Toxiproxy proxy, so the dashboard at `http://127.0.0.1:3001` can cut one while you watch what the cluster does about it.

## What runs

- Three nodes, named `node-a`, `node-b`, and `node-c`, each hold the data, coordinator, and controller roles.
- One etcd container holds the node registry, the allocation table, and the controller lease.
- One Toxiproxy container provides six links, since each node reaches etcd through one of them while its peers reach its replication port through another.
- A TanStack Start dashboard reads the cluster from etcd and drives the nodes over HTTP.

| Node | HTTP | Replication | Advertised as | Reaches etcd through |
| --- | --- | --- | --- | --- |
| node-a | 127.0.0.1:9701 | 9301 | toxiproxy-node-a:9301 | toxiproxy:4101 |
| node-b | 127.0.0.1:9702 | 9302 | toxiproxy-node-b:9302 | toxiproxy:4102 |
| node-c | 127.0.0.1:9703 | 9303 | toxiproxy-node-c:9303 | toxiproxy:4103 |

The index spreads over six partitions at a replication factor of 1, so each partition has a copy on two of the three nodes and each node leads two of them. When one node drops out, the controller moves leadership for the partitions that node led, and those partitions carry on with a single copy, which is what the board shows.

Each node advertises its proxy address, so a peer dials the proxy. Disabling that proxy from the dashboard therefore stops the traffic reaching the node. The dashboard reaches etcd directly, which is why cutting a node's coordinator link stops that node reading the coordinator while the dashboard keeps reading it.

## Setup

You need Node.js 22 or newer, pnpm, and Docker with Compose. Build both packages first, because the dashboard and the certificate script load them from `dist/`:

```sh
pnpm install
pnpm --filter @delali/narsil build
pnpm --filter @delali/narsil-certutil build
```

Run those two builds again whenever you change `packages/ts/src`, because the containers build from source while the dashboard loads the same output.

## Run it

The cluster and the dashboard each take a terminal of their own. Start the cluster from this directory:

```sh
pnpm cluster:up
```

Compose builds the image, generates a certificate authority with one certificate for each node, creates the six Toxiproxy links, and starts the three nodes. It stays in the foreground and streams what every container prints, so you can tell that the cluster is ready once each node reports the ports that it listens on:

```text
node-a-1  | [node-a] HTTP on 0.0.0.0:9701, replication on 0.0.0.0:9301, advertised as toxiproxy-node-a:9301
```

Start the dashboard in the second terminal, and it serves on [http://127.0.0.1:3001](http://127.0.0.1:3001):

```sh
pnpm dev
```

Press Ctrl-C in the cluster terminal to stop the three nodes, which leaves the containers and everything that etcd recorded in place, so `pnpm cluster:up` brings the same cluster back. `pnpm cluster:down` removes all of it, and `pnpm cluster:reset` runs the two in sequence.

## What to try

Press **Create and ingest** first, which creates `forum-answers` and writes 2,000 answers from the FiQA forum dataset. The board fills in as the controller allocates the partitions, and every node ends up leading two of them.

- **Cut one node's coordinator link.** Its registration lease expires within five seconds, and the controller then promotes the copy of each partition that node led, which raises the term on those rows. Once you restore the link, the node registers again and rejoins the in-sync set after it has caught up. Cutting the link of the node that the board names as controller takes longer, because a standby has to wait for that node's controller lease to expire first.
- **Cut one node's replication link.** The primary that replicates to that node stops receiving acknowledgements, so it asks the controller to drop the node from the in-sync set, and the write still succeeds. Once you restore the link, the node catches up from the commit point that its primary recorded, so it rejoins without fetching a snapshot.
- **Cut the coordinator link of two nodes at once.** Every copy of some partition then belongs to a node that the coordinator no longer registers, so the controller moves that partition out of service and records the nodes that still hold its data under `Holds unserved`. Once you restore one of the links, the controller promotes that node back at a higher term.
- **Run the three reads while a link is cut.** The panel sends one term three ways through a single node. The search answers and reports its coverage, the count refuses outright because an exact read has no partial form, and the faceted search answers with the largest undercount that each field can hold.

## Security

This example publishes every port on loopback, so anyone on your own machine reaches all of them without a credential. Each node binds its HTTP server to `0.0.0.0` so that Docker can publish the port. The server refuses that address unless the caller supplies an authentication hook, because the admin routes would otherwise answer anyone who reaches the container, so `src/cluster-node.ts` sets `allowInsecure`. Replication between the nodes uses mutual TLS with a locally generated authority, while etcd answers over plain HTTP inside the Docker network. Put authentication in front of all three before you run anything like this outside your own machine.

## Where the pieces are

- [`src/topology.ts`](src/topology.ts) fixes the node identities, the ports, and the proxy names.
- [`src/cluster-node.ts`](src/cluster-node.ts) is the entry point that each container runs.
- [`src/lib/node-client.ts`](src/lib/node-client.ts) builds one `@delali/narsil/client` for each node, so every read and every write that the dashboard makes goes through the published client and its error codes.
