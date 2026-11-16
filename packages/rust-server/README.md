# Narsil server for Rust

`delali-narsil-server` serves one Narsil node over HTTP and WebSocket from a Rust program. It answers every single-node route of [`openapi.json`](https://github.com/assetcorp/narsil/blob/main/packages/ts/openapi.json) with the statuses, error codes, and limits of the TypeScript server, so the TypeScript, Python, and Go clients can call it unchanged. It also serves device sync and change capture, with the routes and WebSocket feeds that [the Narsil specification](https://github.com/assetcorp/narsil/tree/main/packages/spec) defines. The engine underneath is [`delali-narsil`](https://github.com/assetcorp/narsil/tree/main/packages/rust), so this server opens and saves the same `.nrsl` files as the TypeScript package.

Only the TypeScript package runs cluster mode, so the Rust server answers the cluster routes, the backup routes, `/metrics`, and `/cluster/health` with `501` and the code `CLUSTER_OPERATION_UNSUPPORTED`, as the TypeScript server does when it has no cluster.

The crate is available only from this repository. To deploy the Rust server without building it, run the container image `ghcr.io/assetcorp/narsil` under a tag that ends in `-rust`, such as `latest-rust`. That image takes every setting from the variables that [the container specification](https://github.com/assetcorp/narsil/blob/main/packages/spec/container.md) defines. The [container guide](https://github.com/assetcorp/narsil/blob/main/docs/container-image.md) shows how you can start a node from that image.

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

`NarsilServer` takes the engine and a `ServerOptions`, which holds a field for every option of the TypeScript `createServer` except `cluster`. Its `query_suggestions_identify` field takes the place of `querySuggestions.identify`. The `on_request` check receives the method, the path, the headers, and the caller's address. It can allow the request, allow it until a set time, or deny it with a status and a code:

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
