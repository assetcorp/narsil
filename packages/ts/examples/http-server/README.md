# Narsil HTTP server

This launcher runs a Narsil engine as an HTTP service. It builds one engine, wraps it with `@delali/narsil/server`, and keeps serving requests until it gets a `SIGTERM` or `SIGINT`, then shuts the engine down cleanly.

## Run it locally

The server needs `uWebSockets.js`, the optional peer that handles HTTP. It's already a dev dependency here, so a workspace install gives you everything you need to run it locally.

```bash
pnpm --filter @delali/narsil build
node --experimental-strip-types packages/ts/examples/http-server/server.ts
```

The server prints the address it's listening on. Send it a few requests:

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
  -d '{"mode":"fulltext","term":"matrix","fields":["title"]}'
```

## Run it in Docker

Build the image from the repository root and run it:

```bash
docker build -f packages/ts/examples/http-server/Dockerfile -t narsil-server .
docker run --rm -p 7700:7700 narsil-server
```

## Configuration

Every setting reads from an environment variable, so the same image runs locally and in a container.

| Variable                  | Default     | What it does                                                  |
| ------------------------- | ----------- | ------------------------------------------------------------- |
| `NARSIL_HOST`             | `127.0.0.1` | Address the server binds to                                   |
| `NARSIL_PORT`             | `7700`      | Port the server binds to                                      |
| `NARSIL_DURABILITY_DIR`   | _unset_     | Enables filesystem durability rooted at this path             |
| `NARSIL_API_KEY`          | _unset_     | Requires this token via `Authorization: Bearer` or `x-api-key`|
| `NARSIL_ALLOW_INSECURE`   | `false`     | Permits a non-loopback bind with no API key (see below)       |
| `NARSIL_INSTANCE_ID`      | random      | Stable id that lets a restart fail this instance's own tasks  |
| `NARSIL_MAX_BODY_BYTES`   | `16777216`  | Caps the JSON request body (16 MiB)                           |
| `NARSIL_MAX_IMPORT_BYTES` | `104857600` | Caps NDJSON import and restore bodies (100 MiB)               |
| `NARSIL_MAX_CONCURRENT`   | _unbounded_ | Caps requests running engine work at once                     |

## Secure by default

The server binds to `127.0.0.1` by default, so nothing reaches it from the network until you say so. Bind to a public address like `0.0.0.0` with no API key and the server refuses to start, because the admin endpoints (`restore`, `drop`, `clear`, `rebalance`, and `optimize`) would hand anyone who reaches the port a one-request data wipe. Set `NARSIL_API_KEY` to require a token, or set `NARSIL_ALLOW_INSECURE=true` when the address sits on a trusted private network. Put a reverse proxy in front to terminate TLS. The health probes (`/livez` and `/readyz`) always answer without a key, so a load balancer can reach them.

## Task store

Long-running operations (`optimize`, `rebalance`, and `restore`) hand you back a task id that you poll at `GET /tasks/{id}`. By default that status lives in memory, so it disappears on restart and no other instance can see it. Pass a `taskStore` to `createServer` to keep the status across restarts and share it between instances. Any backend works as long as it implements the async `TaskStore` interface (`set`, `get`, `list`, and `delete`), so you can plug in Redis, Upstash over HTTP, DynamoDB, or a database. A shared store lets every instance report a task by id; the work still runs in one instance's memory, so the store shares status across instances without making the operation itself distributed.

## Bulk ingest

`POST /indexes/{name}/documents/_import` reads an `application/x-ndjson` stream, one JSON document per line. Each document's `id` field becomes its document id, so importing the same file twice updates in place and your search hits map straight back to your own corpus ids.

```bash
curl -X POST localhost:7700/indexes/movies/documents/_import \
  -H 'content-type: application/x-ndjson' \
  --data-binary $'{"id":"m1","title":"The Matrix"}\n{"id":"m2","title":"Inception"}'
```
