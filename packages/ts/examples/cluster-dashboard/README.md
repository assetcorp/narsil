# Watch a three-node Narsil cluster survive a fault

This example runs three Narsil nodes as containers and coordinates them through etcd. Every path between them passes through a Toxiproxy link, so the dashboard at `http://127.0.0.1:3001` can cut one while you watch what the cluster does about it.

## What runs

- Three nodes, named `node-a`, `node-b`, and `node-c`, each hold the data, coordinator, and controller roles.
- One etcd container holds the node registry, the allocation table, and the controller lease.
- One Toxiproxy container provides six links: each node reaches etcd through one of them, and its peers reach its replication port through another.
- A TanStack Start dashboard reads the cluster from etcd and drives the nodes over HTTP.

Creating the index spreads it over 6 partitions at a replication factor of 1, so each partition lives on two of the three nodes and each node leads two partitions. Losing one node therefore moves leadership for the partitions it led and leaves those partitions on a single copy, which is what the board shows.

| Node | HTTP | Replication | Advertised as | Reaches etcd through |
| --- | --- | --- | --- | --- |
| node-a | 127.0.0.1:9701 | 9301 | toxiproxy-node-a:9301 | toxiproxy:4101 |
| node-b | 127.0.0.1:9702 | 9302 | toxiproxy-node-b:9302 | toxiproxy:4102 |
| node-c | 127.0.0.1:9703 | 9303 | toxiproxy-node-c:9303 | toxiproxy:4103 |

Each node advertises its proxy address to the coordinator, so a peer dials that proxy, and disabling that proxy from the dashboard stops the traffic reaching the node. Every node certificate therefore lists its own name, its proxy alias, and localhost among its subject alternative names, because the transport verifies the hostname it dialled.

The dashboard reaches etcd directly, so cutting a node's coordinator link stops that node reading the coordinator while the dashboard keeps reading it.

## Setup

The example needs Node.js 22 or newer, pnpm, and Docker with Compose.

The dashboard imports `@delali/narsil`, the certificate script imports `@delali/narsil-certutil`, and both resolve to files under `dist/`. Build them from the repository root before you run anything here:

```sh
pnpm install
pnpm --filter @delali/narsil build
pnpm --filter @delali/narsil-certutil build
```

The containers build both packages from source as well, so a change under `packages/ts/src` reaches the nodes the next time you bring the cluster up. Run the two builds on your own machine again whenever you change that source, because the dashboard reads the same output.

## Run it

The cluster and the dashboard each hold a terminal of their own. Start the cluster in the first one, from this directory:

```sh
pnpm cluster:up
```

Compose builds the image, generates a certificate authority with one certificate for each node, creates the six Toxiproxy links, and starts the three nodes. It stays in the foreground and streams what every container prints, so you can tell the cluster is ready when each node reports the ports it listens on:

```text
node-a-1  | [node-a] HTTP on 0.0.0.0:9701, replication on 0.0.0.0:9301, advertised as toxiproxy-node-a:9301
```

Start the dashboard in the second terminal:

```sh
pnpm dev
```

That serves the dashboard on [http://127.0.0.1:3001](http://127.0.0.1:3001).

## Stop it

Press Ctrl-C in the cluster terminal to stop the three nodes. That leaves the containers, the certificates, and everything etcd recorded in place, so `pnpm cluster:up` brings the same cluster back. Remove all of it with:

```sh
pnpm cluster:down
```

`pnpm cluster:reset` runs the two in sequence, so the next run starts from an empty cluster.

## What to try

Press **Create and ingest** first. That creates `forum-answers` through `node-a` and writes 2,000 answers from the FiQA forum dataset, each carrying a topic derived from the words it uses. The board fills in as the controller allocates, every node ends up leading two partitions, and every partition reaches `active` with its copy in sync.

**Cut one node's coordinator link.** Its registration lease expires within about five seconds, and the controller then promotes the copy of each partition that node led, which raises the term on those rows and moves their chips into another column. Restore the link and the node registers again, takes back a copy of each partition it lost, and rejoins the in-sync set once it has caught up. The log on the right records each of those steps as it happens. Cut the link of the node the board names as controller and the wait runs longer, because a standby has to wait for that node's controller lease to expire before it can take over and run the promotions. One run here finished 6.1 seconds after the cut.

**Cut one node's replication link.** A primary that replicates to that node stops receiving acknowledgements, so it asks the controller to drop the node from the in-sync set, and the write still succeeds. That node's chips turn dashed and its in-sync column falls to 0/1. Once you restore the link, the node catches up from the commit point its primary recorded, so it rejoins without fetching a snapshot.

**Run the three reads while a link is cut.** The panel sends one term three ways through a single node, over the same client any application would use. The search answers and reports its coverage, so a smaller count comes with the number of partitions that went unread. The count refuses outright, because an exact read has no partial form, and the tile shows the code the client raised. The faceted search answers with the largest undercount each field can have, where a bound of zero proves the counts exact.

**Cut the coordinator link of two nodes at once.** Every copy of some partition then belongs to a node the coordinator no longer registers, so the controller moves that partition out of service and records the nodes that still hold its data. The partition table names the reason it cannot give the partition back, the node board names the holders under `Holds unserved`, and the log carries both. Restore one of the links and the controller asks that node what its copy holds, then promotes it back at a higher term.

**Watch the write path while the controller lease moves.** A primary may narrow its in-sync set only through the controller, so a write that loses a replica while no node holds that lease fails, and the in-sync set stays as it was. The lease expires five seconds after its holder loses etcd, and a standby takes it at its next attempt, which falls within another five seconds, so that whole window is where you can see this.

## Reading the dashboard

Each node row names the partitions it leads, the copies that keep up with their primary, and the copies that are catching up. The last of those columns, `Holds unserved`, names the partitions no node serves whose data this node still holds, which the controller reads from the allocation table's `lastHolders` and gives the partition back from. A failover moves partition numbers from one column to another, which is the quickest way to see what happened.

The partition table below gives the same allocation row by row. `Copies` counts the primary alongside its replicas against the replication factor plus one, `In sync` counts the replicas the primary still waits for, `Term` is the primary term that rises on every promotion, and `Commit` is the highest sequence number the primary has acknowledged for that partition. `Recovery` stays quiet while a node serves the partition, and it otherwise carries the `unassignedReason` the controller recorded alongside the nodes that still hold a copy.

The log beside it names each change the coordinator recorded, newest first, so a failover reads as a sequence: the lease expires, a replica is promoted at a higher term, and the in-sync set narrows and fills again.

## Security boundary

This example publishes every port on loopback and it authenticates nothing. Each node binds its HTTP server to `0.0.0.0` so that Docker can publish the port. The server refuses that address unless the caller supplies an `onRequest` hook or sets `allowInsecure`, because the admin endpoints would otherwise answer anyone who can reach the container, and `src/cluster-node.ts` sets the flag. Replication between the nodes uses mutual TLS with a locally generated authority, while etcd runs over plain HTTP inside the Docker network. The dashboard reaches etcd, the three nodes, and Toxiproxy without a credential. Put authentication in front of all three before you run anything like this outside your own machine.

## Where the pieces live

- [`src/topology.ts`](src/topology.ts) fixes the node identities, the ports, the proxy names, and the well-known controller lease key.
- [`src/cluster-node.ts`](src/cluster-node.ts) is the entry point each container runs.
- [`src/lib/cluster-observer.ts`](src/lib/cluster-observer.ts) holds one coordinator connection, watches the registry, the allocation table, and the schemas, and re-reads every two seconds, which is how a change of controller lease shows up as well.
- [`src/routes/api/cluster-stream.ts`](src/routes/api/cluster-stream.ts) streams each snapshot to the browser.
- [`src/lib/actions.functions.ts`](src/lib/actions.functions.ts) holds the server functions behind the buttons.
- [`src/lib/cluster-events.ts`](src/lib/cluster-events.ts) compares one snapshot with the last one and writes the log entries the dashboard shows.
- [`src/lib/node-client.ts`](src/lib/node-client.ts) builds one `@delali/narsil/client` client for each node, so every read and every write the dashboard makes goes through the published client and its error codes.
