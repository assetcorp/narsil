# Narsil HTTP server

A runnable, env-configurable launcher that exposes a Narsil engine over HTTP. It
builds one engine, wraps it with `@delali/narsil/server`, and serves requests
until it receives `SIGTERM` or `SIGINT`.

## Run it locally

The server needs the optional peer `uWebSockets.js`. It is already a dev
dependency of this package, so a workspace install covers local runs.

```bash
pnpm --filter @delali/narsil build
node --experimental-strip-types packages/ts/examples/http-server/server.ts
```

The server prints the address it bound to. Try it:

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

```bash
docker build -f packages/ts/examples/http-server/Dockerfile -t narsil-server .
docker run --rm -p 7700:7700 narsil-server
```

## Configuration

| Variable                  | Default     | Purpose                                                       |
| ------------------------- | ----------- | --------------------------------------------------------------|
| `NARSIL_HOST`             | `0.0.0.0`   | Listen address                                                |
| `NARSIL_PORT`             | `7700`      | Listen port                                                   |
| `NARSIL_DURABILITY_DIR`   | _unset_     | Enable filesystem durability rooted at this path              |
| `NARSIL_API_KEY`          | _unset_     | Require this token via `Authorization: Bearer` or `x-api-key` |
| `NARSIL_MAX_BODY_BYTES`   | `16777216`  | JSON request body cap (16 MiB)                                |
| `NARSIL_MAX_IMPORT_BYTES` | `104857600` | NDJSON import and restore body cap (100 MiB)                  |
| `NARSIL_MAX_CONCURRENT`   | _unbounded_ | Cap on requests running engine work at once                   |

Terminate TLS at a reverse proxy in front of the server. Health probes
(`/livez`, `/readyz`) bypass the API key so a load balancer can always reach them.

## Bulk ingest

`POST /indexes/{name}/documents/_import` accepts an `application/x-ndjson` stream,
one JSON document per line. A document's `id` field becomes its document id, so a
re-import is idempotent and search hits map back to your corpus ids.

```bash
curl -X POST localhost:7700/indexes/movies/documents/_import \
  -H 'content-type: application/x-ndjson' \
  --data-binary $'{"id":"m1","title":"The Matrix"}\n{"id":"m2","title":"Inception"}'
```
