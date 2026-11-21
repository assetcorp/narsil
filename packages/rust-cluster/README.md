# Narsil cluster for Rust

`delali-narsil-cluster` connects a Rust process to a Narsil cluster that TypeScript nodes also belong to. It holds the TCP and gRPC node transports, which send the same bytes as the TypeScript transports, and the etcd coordinator, which writes the same records under the same keys. [The distribution specification](https://github.com/assetcorp/narsil/tree/main/packages/spec/distribution) defines both, and the crate's tests check each one against a TypeScript node.

A `ClusterNode` joins the cluster the way a TypeScript node does. It refuses to join while the active controller follows another major specification version, waits for an earlier registration under its id to lapse, registers in etcd, and writes its registration again on every heartbeat. It answers `cluster.ping` over either transport, and it refuses every request that it cannot serve with `NODE_NOT_READY`, so that a TypeScript peer that reaches it receives a stated refusal.

## Build requirements

The crate needs `protoc`, the Protocol Buffers compiler, at build time, because `etcd-client` compiles the etcd API definitions while it builds. Install `protoc` from [the protobuf releases](https://github.com/protocolbuffers/protobuf/releases), and either put it on your `PATH` or set `PROTOC` to the path of the binary. The engine crate, `delali-narsil`, needs no `protoc`, because it holds no network code.

## Start a node

The program below starts a node with the `coordinator` and `controller` roles over the TCP transport, and it serves until it receives `Ctrl-C`. The node opens its listener before it registers, so a peer that reads the registration can reach it at once. A node that shuts down removes its registration and gives up the controller lease where it holds it, and etcd removes the registration of a node that stops renewing its lease once the heartbeat TTL passes.

```rust,no_run
use std::sync::Arc;

use narsil::Map;
use narsil_cluster::SPEC_VERSION;
use narsil_cluster::coordinator::etcd::{EtcdCoordinator, EtcdCoordinatorConfig};
use narsil_cluster::coordinator::{NodeCapacity, NodeRegistration};
use narsil_cluster::node::{ClusterNode, ClusterNodeConfig, generate_node_id, next_started_at};
use narsil_cluster::transport::NodeTransport;
use narsil_cluster::transport::tcp::{TcpTransport, TcpTransportConfig};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let node_id = generate_node_id()?;
    let coordinator = Arc::new(
        EtcdCoordinator::connect(EtcdCoordinatorConfig {
            endpoints: vec!["http://127.0.0.1:2379".to_string()],
            ..EtcdCoordinatorConfig::default()
        })
        .await?,
    );
    let transport: Arc<dyn NodeTransport> =
        Arc::new(TcpTransport::new(node_id.clone(), TcpTransportConfig::default())?);
    let registration = NodeRegistration {
        node_id,
        address: "10.0.0.5:9300".to_string(),
        roles: vec!["coordinator".to_string(), "controller".to_string()],
        capacity: NodeCapacity::default(),
        started_at: next_started_at(),
        version: SPEC_VERSION.to_string(),
        extra: Map::new(),
    };
    let node = ClusterNode::new(ClusterNodeConfig::new(
        Arc::clone(&coordinator),
        Arc::clone(&transport),
        registration,
    ))?;
    node.start().await?;

    tokio::signal::ctrl_c().await?;
    node.shutdown().await;
    transport.shutdown().await;
    coordinator.shutdown().await;
    Ok(())
}
```

`GrpcTransport` takes the place of `TcpTransport` for a cluster whose nodes speak gRPC, and both take a `TlsConfig` that makes every connection mutual TLS. `EtcdCoordinatorConfig` takes the TLS certificates and the etcd user that a secured etcd cluster asks for. With several endpoints, the coordinator skips an endpoint for 5 seconds once it fails three calls in a row, and it sends each call to the other endpoints meanwhile.

## What a Rust node does in a cluster

A Rust node takes the `coordinator` role, the `controller` role, or both. `ClusterNode::new` refuses the `data` role with `CONFIG_INVALID`, because a Rust node holds no index and replicates no write yet, so every partition of every index stays on the TypeScript data nodes.

A node with the `controller` role stands for the controller lease against every other controller node, Rust or TypeScript, and takes the lease over once its holder stops renewing it. While it holds the lease, it places the partitions of each index on the data nodes, moves the partitions of a data node that leaves the cluster to the node's in-sync replicas, gives an unserved partition back to a returning node that holds its data, and tears down the allocation of a dropped index. It answers `replication.insync_add`, `replication.insync_remove`, `replication.primary_resign`, and `cluster.bootstrap_complete` with the same checks and the same etcd writes as a TypeScript controller. A data node that follows another major specification version receives no partition from it.

The Rust controller runs none of the long jobs that a TypeScript controller runs. It refuses these requests with `CLUSTER_OPERATION_UNSUPPORTED`, which the TypeScript HTTP server answers with status 501:

- `cluster.replication_factor`, which changes the replication factor of an index.
- `cluster.rebalance`, which changes the partition count of an index.
- `cluster.backup`, `cluster.backup_restore`, and `cluster.backup_delete`, which take, restore, and delete a backup.
- `suggestions.build`, which builds the query suggestions of an index.

It leaves every record of a job that it does not run exactly as it finds it, including a partition count change, a reshard, a change of analysis, and a backup that a TypeScript controller started. Such a job pauses while a Rust node holds the lease, and it carries on once a TypeScript controller takes the lease back. A change of analysis that a client asks for during that time waits the same way.
