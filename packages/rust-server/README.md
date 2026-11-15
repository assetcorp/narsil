# Narsil server for Rust

`delali-narsil-server` serves one Narsil node over HTTP and WebSocket from a Rust program. It answers every single-node route of [`openapi.json`](https://github.com/assetcorp/narsil/blob/main/packages/ts/openapi.json) with the statuses, error codes, and limits of the TypeScript server, so the TypeScript, Python, and Go clients call it unchanged. It also serves device sync and change capture, with the routes and WebSocket feeds that [the Narsil specification](https://github.com/assetcorp/narsil/tree/main/packages/spec) defines. The engine underneath is [`delali-narsil`](https://github.com/assetcorp/narsil/tree/main/packages/rust), so this server opens and saves the same `.nrsl` files as the TypeScript package.

The Rust server doesn't run cluster mode, which only the TypeScript package offers. The cluster routes, the backup routes, `/metrics`, and `/cluster/health` answer `501` with the code `CLUSTER_OPERATION_UNSUPPORTED`, as the TypeScript server does when it runs without a cluster.

This crate isn't published on crates.io. To deploy the Rust server without building it, run the container image `ghcr.io/assetcorp/narsil` under a tag that ends in `-rust`, such as `latest-rust`, which takes every setting from the variables that [the container specification](https://github.com/assetcorp/narsil/blob/main/packages/spec/container.md) defines. The [container guide](https://github.com/assetcorp/narsil/blob/main/docs/container-image.md) starts a node from that image.

## Serve an index from the command line

The crate builds a `narsil-server` binary, which reads its settings from the environment:

```bash
cargo build --release --bin narsil-server
NARSIL_DURABILITY_DIR=/var/lib/narsil NARSIL_API_KEY=change-me ./target/release/narsil-server
```

The server listens on `127.0.0.1:7700` until it receives `SIGTERM` or `SIGINT`, and it then finishes the requests in flight and closes the engine. Every request other than `/livez`, `/readyz`, `/health`, and `/version` needs the key in `Authorization: Bearer <key>` or in `x-api-key`.

| Variable | What it sets |
| --- | --- |
| `NARSIL_HOST`, `NARSIL_PORT` | The address and port, `127.0.0.1` and `7700` by default |
| `NARSIL_API_KEY` | The key that every request other than the probes must carry |
| `NARSIL_ALLOW_INSECURE` | `true` lets the server bind to an address other than loopback without a key |
| `NARSIL_DURABILITY_DIR` | The directory for the write-ahead log and checkpoints, where an unset value keeps every index in memory |
| `NARSIL_MAX_BODY_BYTES`, `NARSIL_MAX_IMPORT_BYTES` | The largest JSON body and the largest NDJSON import |
| `NARSIL_MAX_CONCURRENT` | The number of requests that the server handles at once, where 0 sets no limit |
| `NARSIL_SYNC`, `NARSIL_CHANGES` | `true` serves the device sync feed or the change feed |
| `NARSIL_INSTANCE_ID` | The identifier that marks this server's tasks |
| `NARSIL_BUILD_VERSION`, `NARSIL_BUILD_GIT_SHA`, `NARSIL_BUILD_DIRTY` | The build identity that `GET /version` reports |

## Serve an index from your program

`NarsilServer` takes the engine and a `ServerOptions`, whose fields match the options of the TypeScript `createServer`. The request check receives the method, the path, the headers, and the caller's address, and it can allow the request, allow it until a time, or deny it with a status and a code:

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

The server runs every engine call on Tokio's blocking pool, so a slow search or import leaves the other requests answering. `shutdown` stops accepting connections, gives the requests in flight up to 30 seconds, stops the running tasks, and closes the engine, while `close` does only the first two and leaves the tasks and the engine running.
