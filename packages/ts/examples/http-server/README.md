# Narsil HTTP server

This launcher serves one Narsil engine over HTTP. It builds the engine and wraps it with `@delali/narsil/server`, then answers requests until the process receives `SIGTERM` or `SIGINT`, at which point it shuts the engine down cleanly. Every setting comes from an environment variable, so the same image serves your laptop and your cluster.

For the routes themselves, read the [HTTP server guide](../../../../docs/http-server.md), which covers every one of them.

## Run it locally

A workspace install here already provides `uWebSockets.js`, the optional peer that handles HTTP for the server.

```bash
pnpm --filter @delali/narsil build
node --experimental-strip-types packages/ts/examples/http-server/server.ts
```

It prints the address that it listens on. Create an index, add a document, and search it:

```bash
curl localhost:7700/livez
curl -X POST localhost:7700/indexes \
  -H 'content-type: application/json' \
  -d '{"name":"movies","config":{"schema":{"title":"string"}}}'
curl -X POST localhost:7700/indexes/movies/documents \
  -H 'content-type: application/json' \
  -d '{"document":{"id":"m1","title":"The Matrix"}}'
curl -X POST localhost:7700/indexes/movies/search \
  -H 'content-type: application/json' \
  -d '{"term":"matrix","fields":["title"]}'
```

## Run it in Docker

```bash
docker build -f packages/ts/examples/http-server/Dockerfile -t narsil-server .
docker run --rm -p 7700:7700 --memory 4g narsil-server
```

The image sets `NODE_OPTIONS=--max-old-space-size-percentage=75`, so the engine's heap may grow to three quarters of the memory you give the container. Node ends the process once an index outgrows that limit, so size `--memory` for the indexes that you expect. Pass `-e NODE_OPTIONS=--max-old-space-size-percentage=60` to change the share, which [the observability guide](../../../../docs/observability.md#the-node-heap-limit) explains.

The image also loads jemalloc in place of glibc's allocator through `LD_PRELOAD`, because glibc holds on to memory that the server's threads have freed while jemalloc returns it to the system. Pass `-e LD_PRELOAD=` when you want glibc's allocator back.

## Configuration

| Variable | Default | What it does |
| --- | --- | --- |
| `NARSIL_HOST` | `127.0.0.1` | Sets the address the server binds to |
| `NARSIL_PORT` | `7700` | Sets the port the server binds to |
| `NARSIL_API_KEY` | unset | Requires this token as `Authorization: Bearer` or `x-api-key` |
| `NARSIL_ALLOW_INSECURE` | `false` | Permits a non-loopback bind with no API key |
| `NARSIL_DURABILITY_DIR` | unset | Turns on filesystem durability rooted at this path |
| `NARSIL_WORKERS` | cores minus one, between 2 and 8 | Sets how many request threads receive requests, each of which holds the worker copies |
| `NARSIL_PROMOTION_THRESHOLD` | `1000` | Sets the document count at which an index gains worker copies |
| `NARSIL_INSTANCE_ID` | random | Sets a stable id, so a restart fails this instance's own unfinished tasks |
| `NARSIL_MAX_BODY_BYTES` | `16777216` | Caps the JSON request body at 16 MiB |
| `NARSIL_MAX_IMPORT_BYTES` | `104857600` | Caps NDJSON import and restore bodies at 100 MiB |
| `NARSIL_MAX_CONCURRENT` | unbounded | Caps the requests running engine work at once |
| `NARSIL_BUILD_VERSION` | unset | Sets the package version reported at `GET /version` |
| `NARSIL_BUILD_GIT_SHA` | unset | Sets the git commit reported at `GET /version` |
| `NARSIL_BUILD_DIRTY` | `false` | Marks the build as coming from a dirty working tree |

A host with fewer than three cores runs one request thread whatever `NARSIL_WORKERS` says.

## Durability

The server keeps everything in memory by default, so it comes back empty after a restart. With `NARSIL_DURABILITY_DIR` set to a writable path, the engine writes every change to a write-ahead log, checkpoints every five minutes, and replays the log at the next start, so your data survives a restart.

In the default `sync` mode the engine flushes before a write resolves, so a crash never loses a write that your client already saw succeed. `mode: 'async'` flushes once a second, which is faster and can lose that last second in a hard crash. Set either one on the engine that you hand to `createServer`, which [the durability guide](../../../../docs/persistence-and-durability.md) covers:

```ts
const engine = await createNarsil({ durability: { directory: '/var/lib/narsil' } })
const server = createServer(engine)
await server.listen()
```

## Bind it safely

The server binds to `127.0.0.1`, so it answers callers on that machine alone until you widen the address. Binding a public address such as `0.0.0.0` with no API key makes the server refuse to start, because the admin routes (`restore`, `drop`, `clear`, `rebalance`, and `optimize`) would hand anyone who reaches the port a one-request data wipe. Set `NARSIL_API_KEY` to require a token, or set `NARSIL_ALLOW_INSECURE=true` where the address belongs to a trusted private network. Put a reverse proxy in front to terminate TLS. The probes `/livez` and `/readyz`, together with `/version`, always answer without a key, so your load balancer can reach them.
