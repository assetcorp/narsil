# Narsil cluster for Rust

`delali-narsil-cluster` connects a Rust process to a Narsil cluster that TypeScript nodes also belong to. It holds the TCP and gRPC node transports, which send the same bytes as the TypeScript transports, and the etcd coordinator, which writes the same records under the same keys. [The distribution specification](https://github.com/assetcorp/narsil/tree/main/packages/spec/distribution) defines both, and the crate's tests check each one against a TypeScript node.

A node built on this crate registers in etcd, keeps its registration alive under a lease, and answers `cluster.ping` over either transport. It refuses every other request with `NODE_NOT_READY`, so that a TypeScript peer that reaches it receives a stated refusal. Register such a node with the `coordinator` role alone, because the controller places partitions only on nodes that hold the `data` role.

## Build requirements

The crate needs `protoc`, the Protocol Buffers compiler, at build time, because `etcd-client` compiles the etcd API definitions while it builds. Install `protoc` from [the protobuf releases](https://github.com/protocolbuffers/protobuf/releases), and either put it on your `PATH` or set `PROTOC` to the path of the binary. The engine crate, `delali-narsil`, needs no `protoc`, because it holds no network code.

## Start a node

The program below registers a node in etcd and serves the TCP transport until it receives `Ctrl-C`. Since the node opens its listener before it registers, a peer that reads the registration can reach it at once. A node that leaves removes its registration, and etcd removes the registration of a node that stops renewing its lease once the heartbeat TTL passes.

```rust,no_run
use narsil::Map;
use narsil_cluster::SPEC_VERSION;
use narsil_cluster::coordinator::etcd::{EtcdCoordinator, EtcdCoordinatorConfig};
use narsil_cluster::coordinator::{NodeCapacity, NodeRegistration};
use narsil_cluster::node::{generate_node_id, next_started_at, not_ready_handler};
use narsil_cluster::transport::NodeTransport;
use narsil_cluster::transport::tcp::{TcpTransport, TcpTransportConfig};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let node_id = generate_node_id()?;
    let coordinator = EtcdCoordinator::connect(EtcdCoordinatorConfig {
        endpoints: vec!["http://127.0.0.1:2379".to_string()],
        ..EtcdCoordinatorConfig::default()
    })
    .await?;
    let transport = TcpTransport::new(node_id.clone(), TcpTransportConfig::default())?;
    let listening = transport.listen(not_ready_handler(node_id.clone())).await?;
    coordinator
        .register_node(&NodeRegistration {
            node_id: node_id.clone(),
            address: "10.0.0.5:9300".to_string(),
            roles: vec!["coordinator".to_string()],
            capacity: NodeCapacity::default(),
            started_at: next_started_at(),
            version: SPEC_VERSION.to_string(),
            extra: Map::new(),
        })
        .await?;

    tokio::signal::ctrl_c().await?;
    coordinator.deregister_node(&node_id).await?;
    listening.stop();
    transport.shutdown().await;
    coordinator.shutdown().await;
    Ok(())
}
```

`GrpcTransport` takes the place of `TcpTransport` for a cluster whose nodes speak gRPC, and both take a `TlsConfig` that makes every connection mutual TLS. `EtcdCoordinatorConfig` takes the TLS certificates and the etcd user that a secured etcd cluster asks for. With several endpoints, the coordinator skips an endpoint for 5 seconds once it fails three calls in a row, and it sends each call to the other endpoints meanwhile.
