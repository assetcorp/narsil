# Narsil server for Rust

`delali-narsil-server` serves one Narsil node over HTTP and WebSocket from a Rust program. It answers every single-node route of [`openapi.json`](https://github.com/assetcorp/narsil/blob/main/packages/ts/openapi.json) with the statuses, error codes, and limits of the TypeScript server, so the TypeScript, Python, and Go clients can call it unchanged. It also serves device sync and change capture, with the routes and WebSocket feeds that [the Narsil specification](https://github.com/assetcorp/narsil/tree/main/packages/spec) defines. The engine underneath is [`delali-narsil`](https://github.com/assetcorp/narsil/tree/main/packages/rust), so this server opens and saves the same `.nrsl` files as the TypeScript package.

When you build it with the `cluster` feature, the server can also start a node of a Narsil cluster and answer for the whole cluster, beside TypeScript nodes or in a cluster that holds only Rust nodes, as the section on joining a cluster below describes. Without a cluster, the server answers the cluster routes, the backup routes, `/metrics`, and `/cluster/health` with `501` and the code `CLUSTER_OPERATION_UNSUPPORTED`, as the TypeScript server does when it has no cluster.

Add the crate to a Rust program with `cargo add delali-narsil-server`, or install its `narsil-server` binary with `cargo install delali-narsil-server`. To deploy the Rust server without building it, run the container image `ghcr.io/assetcorp/narsil` under a tag that ends in `-rust`, such as `latest-rust`. That image takes every setting from the variables that [the container specification](https://github.com/assetcorp/narsil/blob/main/packages/spec/container.md) defines. The [container guide](https://github.com/assetcorp/narsil/blob/main/docs/container-image.md) shows how you can start a node from that image.

## Serve an index from the command line

The crate contains a `narsil-server` binary that reads its settings from the environment:

```bash
cargo build --release --bin narsil-server
NARSIL_DURABILITY_DIR=/var/lib/narsil NARSIL_API_KEY=change-me ./target/release/narsil-server
```

The server listens on `127.0.0.1:7700` until it receives `SIGTERM` or `SIGINT`. Once it receives either signal, it finishes the requests in flight before it closes the engine. When you set `NARSIL_API_KEY`, the server answers `/livez`, `/readyz`, `/health`, and `/version` without a key, but it accepts any other request only when the key is in the `Authorization: Bearer <key>` header or the `x-api-key` header.

| Variable | What it sets |
| --- | --- |
| `NARSIL_HOST`, `NARSIL_PORT` | The address and port, `127.0.0.1` and `7700` by default |
| `NARSIL_API_KEY` | The key that the server requires on every request other than the probes |
| `NARSIL_ALLOW_INSECURE` | `true` lets the server bind to an address other than loopback without a key |
| `NARSIL_DURABILITY_DIR` | The directory for the write-ahead log and checkpoints. While it is unset, the server keeps every index in memory |
| `NARSIL_MAX_BODY_BYTES`, `NARSIL_MAX_IMPORT_BYTES` | The largest JSON body and the largest NDJSON import |
| `NARSIL_MAX_CONCURRENT` | The number of requests that the server handles at once, where 0 removes the limit |
| `NARSIL_SYNC`, `NARSIL_CHANGES` | `true` makes the server serve the device sync feed or the change feed |
| `NARSIL_INSTANCE_ID` | The identifier that the server stamps on each of its tasks |
| `NARSIL_BUILD_VERSION`, `NARSIL_BUILD_GIT_SHA`, `NARSIL_BUILD_DIRTY` | The build identity that `GET /version` reports |

## Serve an index from your program

`NarsilServer` takes the engine and a `ServerOptions`, which holds a field for every option of the TypeScript `createServer` except `cluster`, because `NarsilServer::cluster` takes the place of that option. Its `query_suggestions_identify` field takes the place of `querySuggestions.identify`. The `on_request` check receives the method, the path, the headers, and the caller's address. It can allow the request, allow it until a set time, or deny it with a status and a code:

```rust,no_run
use std::sync::Arc;

use narsil::{Narsil, NarsilConfig};
use narsil_server::{
    BoxError, NarsilServer, RequestContext, RequestDecision, RequestDenial, ServerOptions,
};

fn main() -> Result<(), BoxError> {
    let runtime = tokio::runtime::Runtime::new()?;
    runtime.block_on(async {
        let engine = Arc::new(Narsil::open(NarsilConfig::default())?);
        let check = |context: RequestContext| async move {
            let allowed = context.headers.get("authorization").map(String::as_str)
                == Some("Bearer change-me");
            Ok::<_, BoxError>(if allowed {
                RequestDecision::Allow
            } else {
                RequestDecision::Deny(RequestDenial {
                    status: 401,
                    code: "UNAUTHORIZED".to_string(),
                    message: "A valid API key is required".to_string(),
                })
            })
        };
        let server = NarsilServer::new(
            engine,
            ServerOptions {
                port: Some(7700),
                on_request: Some(Arc::new(check)),
                ..ServerOptions::default()
            },
        )?;
        server.listen().await?;
        tokio::signal::ctrl_c().await?;
        server.shutdown().await?;
        Ok(())
    })
}
```

The server sends every search, write, and import to Tokio's blocking pool, so it keeps answering other requests while a slow search or import is in progress. `shutdown` stops accepting connections, gives the requests in flight up to 30 seconds to finish, stops the tasks in progress, and closes the engine. `close` takes only the first two of those steps, so the tasks and the engine keep working after it returns.

## Join a cluster

The `cluster` feature adds cluster mode through [`delali-narsil-cluster`](https://github.com/assetcorp/narsil/tree/main/packages/rust-cluster). Its etcd client compiles protocol buffer definitions as it builds, so the build needs `protoc` on the `PATH` or in the `PROTOC` variable:

```bash
cargo install delali-narsil-server --features cluster
NARSIL_CLUSTER_ETCD_ENDPOINTS=https://10.0.0.5:2379 \
NARSIL_CLUSTER_ETCD_CA_FILE=/etc/narsil/etcd-ca.pem \
NARSIL_CLUSTER_TRANSPORT_HOST=0.0.0.0 \
NARSIL_CLUSTER_ADVERTISED_ADDRESS=10.0.0.11:9300 \
NARSIL_CLUSTER_TLS_CERT_FILE=/etc/narsil/node.pem \
NARSIL_CLUSTER_TLS_KEY_FILE=/etc/narsil/node-key.pem \
NARSIL_CLUSTER_TLS_CA_FILE=/etc/narsil/ca.pem \
NARSIL_DURABILITY_DIR=/var/lib/narsil \
NARSIL_HOST=0.0.0.0 NARSIL_API_KEY=change-me \
narsil-server
```

When `NARSIL_CLUSTER_ETCD_ENDPOINTS` is set, the binary registers a node in etcd and joins the cluster with the roles in `NARSIL_CLUSTER_ROLES`. The node then serves HTTP for the whole cluster, so the server sends each write that it receives to the primary of the document's partition, wherever that primary is. The node reads and writes the same etcd records and sends the same node messages as a TypeScript node, which means that one cluster can hold Rust nodes, TypeScript nodes, or both. `GET /readyz` answers `200` only while the node reports `SERVING`, and its body names the node and the readiness that the node reports. On `SIGTERM` or `SIGINT`, the node leaves the cluster before the process exits. A build without the `cluster` feature refuses to start when `NARSIL_CLUSTER_ETCD_ENDPOINTS` is set.

| Variable | What it sets |
| --- | --- |
| `NARSIL_CLUSTER_ETCD_ENDPOINTS` | The etcd endpoints, separated by commas, which turn cluster mode on |
| `NARSIL_CLUSTER_KEY_PREFIX` | The prefix of every etcd key, so that one etcd cluster can hold several Narsil clusters |
| `NARSIL_CLUSTER_HEARTBEAT_TTL_SECONDS` | The seconds that etcd keeps the node's registration without a heartbeat |
| `NARSIL_CLUSTER_ETCD_CA_FILE`, `NARSIL_CLUSTER_ETCD_CERT_FILE`, `NARSIL_CLUSTER_ETCD_KEY_FILE` | The files that make the node reach etcd over TLS, where the certificate and the key are optional |
| `NARSIL_CLUSTER_ETCD_USERNAME`, `NARSIL_CLUSTER_ETCD_PASSWORD` | The etcd user that the node signs in as |
| `NARSIL_CLUSTER_ROLES` | The node's roles, from `data`, `coordinator`, and `controller`, which are all three by default |
| `NARSIL_CLUSTER_NODE_ID` | The node's id. While it is unset, the node keeps the id that it stores in `NARSIL_DURABILITY_DIR`, or a new one |
| `NARSIL_CLUSTER_TRANSPORT` | `tcp`, the default, or `grpc` |
| `NARSIL_CLUSTER_TRANSPORT_HOST`, `NARSIL_CLUSTER_TRANSPORT_PORT` | The address and port that the node listens on for other nodes, `127.0.0.1` and `9300` for `tcp` or `9301` for `grpc` by default |
| `NARSIL_CLUSTER_ADVERTISED_ADDRESS` | The `host:port` that other nodes reach this node at, which is the transport host and port by default |
| `NARSIL_CLUSTER_TLS_CERT_FILE`, `NARSIL_CLUSTER_TLS_KEY_FILE`, `NARSIL_CLUSTER_TLS_CA_FILE` | The files that make every connection between nodes mutual TLS |
| `NARSIL_CLUSTER_CONTROLLER_LEASE_TTL_MS`, `NARSIL_CLUSTER_STANDBY_RETRY_MS`, `NARSIL_CLUSTER_NODE_LEFT_DELAY_MS` | How long the controller lease lasts, how long a standby waits before it tries for the lease again, and how long the controller leaves a departed node's copies in place |
| `NARSIL_CLUSTER_PARTITION_COUNT`, `NARSIL_CLUSTER_REPLICATION_FACTOR` | The partition count and the replicas of each partition that every index created through this server gets, which are 5 and 1 by default |
| `NARSIL_CLUSTER_WAIT_FOR_SERVING_MS` | How many milliseconds an index create waits for every partition to serve, 30,000 by default, where 0 answers as soon as the cluster records the index |
| `NARSIL_CLUSTER_BACKUP_DIR`, `NARSIL_CLUSTER_BACKUP_KEY_PREFIX` | The directory that holds the cluster's backups and the key prefix that this cluster writes them under, which every node sets alike and which must be set together |

A node with the `data` role keeps its copies of partitions in an engine that writes its log and checkpoints to `NARSIL_DURABILITY_DIR`, so set that variable on every data node that has to keep its copies across a restart. Give the transport TLS on any network that other machines can reach, because a plain transport sends every document and every write between nodes as readable bytes.

Through a cluster node, the server answers searches, index creation and removal, document writes and reads, counts, document lists, suggestions, preflight counts, the index list, the index and partition figures, the allocation and replication factor routes, analysis changes, partition count changes, backups, restores, backup removal, device sync snapshots, document exports, the popular query suggestion routes, the sync and changes settings, NDJSON imports, clearing an index, its synonym set and BM25 settings, the rebuild of its analysis, the cluster topology, `/cluster/health`, and `/metrics`. Opening, closing, and checkpointing an index, and the memory figures of `/stats/memory`, reach this node's copies alone, as they do on a TypeScript node. A search with a rerank step reranks with the adapter that the node holds under the name that the search gives, and the binary registers none, so it answers such a search with `400` and `RERANK_CONFIG_INVALID`. The server answers snapshots, snapshot restores, the import of a document export, a partition configuration change, the vector maintenance routes, `_wait-for-writes`, and a write that sets `wait` to true with `501` and `CLUSTER_OPERATION_UNSUPPORTED`, as a TypeScript cluster node does.

From a program, start a `ClusterNode` from `delali-narsil-cluster` and pass it to `NarsilServer::cluster` with a `ClusterOptions`, which sets the partition count, the replication factor, and the serving wait of the indexes that the server creates, and with the same `ServerOptions`. The server registers the `rerank_adapters` of those options on the node, and it refuses to start with `CLUSTER_OPERATION_UNSUPPORTED` when they hold an embedding adapter, because a cluster node does not take one yet. That server's `shutdown` also shuts the node down, while the etcd coordinator and the transport stay open until you close them.
