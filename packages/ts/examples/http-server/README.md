# Narsil HTTP server

This launcher runs a Narsil engine as an HTTP service. It builds one engine, wraps it with `@delali/narsil/server`, and keeps serving requests until it gets a `SIGTERM` or `SIGINT`, then shuts the engine down cleanly. The full REST surface is documented in the [API reference](#api-reference) below.

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

| Variable                  | Default     | What it does                                                   |
| ------------------------- | ----------- | -------------------------------------------------------------- |
| `NARSIL_HOST`             | `127.0.0.1` | Sets the address the server binds to.                          |
| `NARSIL_PORT`             | `7700`      | Sets the port the server binds to.                             |
| `NARSIL_DURABILITY_DIR`   | unset       | Enables filesystem durability rooted at this path.             |
| `NARSIL_API_KEY`          | unset       | Requires this token via `Authorization: Bearer` or `x-api-key`.|
| `NARSIL_ALLOW_INSECURE`   | `false`     | Permits a non-loopback bind with no API key (see below).       |
| `NARSIL_INSTANCE_ID`      | random      | Sets a stable id that lets a restart fail this instance's own tasks. |
| `NARSIL_MAX_BODY_BYTES`   | `16777216`  | Caps the JSON request body (16 MiB).                           |
| `NARSIL_MAX_IMPORT_BYTES` | `104857600` | Caps NDJSON import and restore bodies (100 MiB).               |
| `NARSIL_MAX_CONCURRENT`   | unbounded   | Caps requests running engine work at once.                     |
| `NARSIL_BUILD_VERSION`    | unset       | Sets the package version reported at `GET /version`.           |
| `NARSIL_BUILD_GIT_SHA`    | unset       | Sets the git commit reported at `GET /version`.                |
| `NARSIL_BUILD_DIRTY`      | `false`     | Marks the build as coming from a dirty working tree.           |

## Durability

By default the server keeps everything in memory, so a restart starts empty. Set `NARSIL_DURABILITY_DIR` to a writable path and the engine writes every change to a write-ahead log, takes periodic snapshots, and replays the log automatically the next time it starts, so your data survives a restart. In your own code you set this on the engine and hand it to the server:

```ts
const engine = await createNarsil({ durability: { directory: '/var/lib/narsil' } })
const server = createServer(engine)
await server.listen()
```

The default mode is `sync`: a write isn't acknowledged until it's on disk, so a crash never loses a write your client already saw succeed. Switch to `mode: 'async'` and writes ack right away while the log flushes about once a second, which runs faster but can lose that last second on a hard crash. Durability needs a real filesystem; back it with a store that has none and you get snapshot-only durability, which holds your data as of the most recent snapshot.

## Secure by default

The server binds to `127.0.0.1` by default, so nothing reaches it from the network until you say so. Bind to a public address like `0.0.0.0` with no API key and the server refuses to start, because the admin endpoints (`restore`, `drop`, `clear`, `rebalance`, and `optimize`) would hand anyone who reaches the port a one-request data wipe. Set `NARSIL_API_KEY` to require a token, or set `NARSIL_ALLOW_INSECURE=true` when the address sits on a trusted private network. Put a reverse proxy in front to terminate TLS. The health probes (`/livez` and `/readyz`) and `/version` always answer without a key, so a load balancer can reach them.

## Task store

Long-running operations (`optimize`, `rebalance`, and `restore`) hand you back a task id that you poll at `GET /tasks/{id}`. By default that status lives in memory, so it disappears on restart and no other instance can see it. Pass a `taskStore` to `createServer` to keep the status across restarts and share it between instances. Any backend works as long as it implements the async `TaskStore` interface (`set`, `get`, `list`, and `delete`), so you can plug in Redis, Upstash over HTTP, DynamoDB, or a database. A shared store lets every instance report a task by id; the work still runs in one instance's memory, so the store shares status across instances without making the operation itself distributed.

## API reference

Every JSON endpoint takes and returns `application/json`. Failures return an error envelope with a stable code, a message, and optional details:

```json
{ "error": { "code": "INDEX_NOT_FOUND", "message": "Index \"movies\" not found", "details": {} } }
```

Engine error codes map to HTTP statuses: validation problems return 400, missing indexes and documents return 404, conflicts and capacity limits return 409, a busy worker returns 429, backend faults such as persistence failures return 503, and everything unexpected returns 500. The server adds its own codes for transport problems: `INVALID_JSON` and `EMPTY_BODY` (400), `PAYLOAD_TOO_LARGE` (413), `TOO_MANY_REQUESTS` (503 when the concurrency cap is hit), and `NOT_FOUND` (404 for unknown routes).

### Health and build info

| Method and path | Response |
| --- | --- |
| `GET /livez` | The probe returns `{ "status": "ok" }` whenever the process can serve HTTP. |
| `GET /readyz` | The probe returns `{ "status": "ready" }`, or 503 `{ "status": "unavailable" }` until the engine is ready and again once shutdown begins. |
| `GET /health` | The alias answers exactly like `/livez`. |
| `GET /version` | The endpoint returns `{ "name": "narsil", "version", "gitSha", "dirty" }` with nulls where the build stamped nothing. |
| `GET /stats/memory` | The endpoint returns the engine's memory report: process heap, estimated index bytes, and per-worker heap. |

The probes and `/version` skip the authentication hook; every other endpoint runs it.

### Indexes

**`POST /indexes`** creates an index. The body carries a name and a declarative config: `schema` is required, and `language`, `partitions`, `defaultScoring`, `bm25`, `stopWords` (an array of strings), `trackPositions`, `vectorPromotion`, `strict`, `embedding`, and `required` are optional. Function-valued engine options (a custom tokenizer or a group reducer) cannot cross JSON; an embedding adapter is referenced by the name it was registered under on the server.

```bash
curl -X POST localhost:7700/indexes \
  -H 'content-type: application/json' \
  -d '{
    "name": "movies",
    "config": {
      "schema": { "title": "string", "year": "number" },
      "language": "english"
    }
  }'
```

The response is 201 `{ "name": "movies" }`. Reusing a name fails with 409 `INDEX_ALREADY_EXISTS`. An index that auto-embeds text needs the server built with named adapters (`createServer(engine, { embeddingAdapters: { ... } })`); the JSON config then references one by name, for example `"embedding": { "adapter": "openai-small", "fields": { "plotEmbedding": ["title"] } }`. This launcher registers none, so schemas with vector fields expect pre-computed vectors in the documents.

| Method and path | Response |
| --- | --- |
| `GET /indexes` | The endpoint returns `{ "indexes": [{ "name", "documentCount", "partitionCount", "language" }] }`. |
| `DELETE /indexes/{name}` | The endpoint drops the index and returns `{ "name", "dropped": true }`. |
| `GET /indexes/{name}/stats` | The endpoint returns document count, partition count, estimated memory, language, and the schema. |
| `GET /indexes/{name}/partitions` | The endpoint returns `{ "partitions": [{ "partitionId", "documentCount", "estimatedMemoryBytes" }] }`. |
| `GET /indexes/{name}/count` | The endpoint returns `{ "count": 1204 }`. |
| `POST /indexes/{name}/_clear` | The endpoint removes every document, keeps the index, and returns `{ "name", "cleared": true }`. |

### Documents

**`POST /indexes/{name}/documents`** inserts one document. The body is `{ "document": {...}, "id"?: "...", "options"?: {...} }`. The id resolves in the same order as the embedded API: the `id` field in the body wins, then a string `id` inside the document, and otherwise the engine generates a UUID v7. The response is 201 `{ "id": "..." }`.

```bash
curl -X POST localhost:7700/indexes/movies/documents \
  -H 'content-type: application/json' \
  -d '{"document":{"id":"m1","title":"The Matrix","year":1999}}'
```

**`GET /indexes/{name}/documents/{id}`** returns `{ "document": {...} }`, or 404 `DOC_NOT_FOUND`.

**`GET /indexes/{name}/documents/{id}/_exists`** returns `{ "exists": true }` without fetching the document.

**`PUT /indexes/{name}/documents/{id}`** upserts. When the id exists the document is replaced and the response is 200 `{ "id", "created": false }`; otherwise it is inserted and the response is 201 `{ "id", "created": true }`. The body is `{ "document": {...} }`.

**`PATCH /indexes/{name}/documents/{id}`** replaces the document under an existing id and returns `{ "id" }`. The body carries the complete new document, and an unknown id fails with 404; there is no field-level merge.

**`DELETE /indexes/{name}/documents/{id}`** removes the document and returns `{ "id", "removed": true }`.

**`POST /indexes/{name}/documents/_batch`** runs a bulk mutation. `action` selects `"insert"` (the default, with a `documents` array), `"update"` (with an `updates` array of `{ docId, document }`), or `"delete"` (with a `docIds` array). The response reports partial results, so one bad document never aborts the batch:

```json
{
  "succeeded": ["m1", "m2"],
  "failed": [{ "docId": "m3", "error": { "code": "DOC_VALIDATION_FAILED", "message": "..." } }]
}
```

**`POST /indexes/{name}/documents/_multi-get`** takes `{ "docIds": ["m1", "m2"] }` and returns `{ "documents": { "m1": {...}, "m2": {...} } }`, holding only the ids that exist.

**`POST /indexes/{name}/documents/_import`** streams an NDJSON corpus, one JSON document per line, with each line's `id` field becoming the document id. The stream processes in bounded batches and yields the event loop between batches, so searches and health probes stay responsive during a load. Per-line parse failures and per-document engine failures collect into the response instead of aborting the import:

```bash
curl -X POST localhost:7700/indexes/movies/documents/_import \
  -H 'content-type: application/x-ndjson' \
  --data-binary $'{"id":"m1","title":"The Matrix"}\n{"id":"m2","title":"Inception"}'
```

```json
{ "indexed": 2, "failed": 0, "errors": [] }
```

Each entry in `errors` carries a `code`, a `message`, and either the `line` number that failed to parse or the `docId` the engine rejected. Importing the same file twice updates in place, so your search hits map straight back to your own corpus ids.

### Search

**`POST /indexes/{name}/search`** takes the same query parameters as the embedded `query()` method, documented in the [package README](../../README.md#search): `term`, `fields`, `filters`, `boost`, `mode`, `vector`, `hybrid`, `facets`, `sort`, `group`, `limit`, `offset`, `searchAfter`, `highlight`, `pinned`, `minScore`, `termMatch`, `tolerance`, `prefixLength`, `exact`, `scoring`, and `includeScoreComponents`. The response is the engine's result: `{ "hits", "count", "elapsed", "cursor"?, "facets"?, "groups"? }`. Custom group reducers are functions and cannot cross JSON, so a body carrying `group.reduce` fails with 400; `group.fields` and `group.maxPerGroup` work over HTTP.

```bash
curl -X POST localhost:7700/indexes/movies/search \
  -H 'content-type: application/json' \
  -d '{
    "term": "matrix",
    "filters": { "fields": { "year": { "gte": 1990 } } },
    "highlight": { "fields": ["title"] },
    "limit": 10
  }'
```

**`POST /indexes/{name}/search/preflight`** takes the same body and returns `{ "count", "elapsed" }` without materializing hits, which sizes a result set before an expensive query.

**`POST /indexes/{name}/suggest`** takes `{ "prefix": "mat", "limit"?: 5 }` and returns autocomplete candidates ranked by document frequency: `{ "terms": [{ "term", "documentFrequency" }], "elapsed" }`.

### Snapshots and checkpoints

**`GET /indexes/{name}/snapshot`** streams the index as a binary `.nrsl` envelope (`application/octet-stream`). The snapshot is portable across processes, machines, and language implementations.

**`POST /indexes/{name}/restore`** takes that binary envelope as the raw request body and rebuilds the index from it, replacing the index if it exists. Restore runs as a task: the response is 202 `{ "taskId", "type": "restore", "status" }`, and you poll `GET /tasks/{taskId}` for completion. An empty body fails with 400 `EMPTY_BODY`.

```bash
curl localhost:7700/indexes/movies/snapshot -o movies.nrsl
curl -X POST localhost:7700/indexes/movies/restore \
  -H 'content-type: application/octet-stream' \
  --data-binary @movies.nrsl
```

**`POST /indexes/{name}/_checkpoint`** forces a durability checkpoint outside the automatic schedule and returns `{ "ok": true }`. Without durability configured it is a no-op that still returns `{ "ok": true }`.

### Vector maintenance

**`GET /indexes/{name}/vector-maintenance`** reports per-field graph health: `{ "fields": [{ "fieldName", "tombstoneRatio", "graphCount", "bufferSize", "building", "estimatedCompactMs", "estimatedOptimizeMs" }] }`.

**`POST /indexes/{name}/vectors/_compact`** drops tombstones without rebuilding the graph and returns `{ "ok": true }` when done. The optional body `{ "field": "plotEmbedding" }` targets one field; omit it to compact every vector field.

**`POST /indexes/{name}/vectors/_optimize`** rebuilds the graph from live vectors, which takes longer and restores full query speed. It runs as a task: the response is 202 `{ "taskId", "type": "optimizeVectors", "status" }`. The same optional `field` body applies.

### Partitions

**`POST /indexes/{name}/_rebalance`** reshapes the index to a new partition count while it stays online. The body is `{ "targetPartitionCount": 8 }`, and the response is 202 `{ "taskId", "type": "rebalance", "status" }`.

**`POST /indexes/{name}/partition-config`** adjusts `maxDocsPerPartition` and `maxPartitions` at runtime and returns `{ "ok": true }`. A capacity below the current document count fails with `PARTITION_CAPACITY_EXCEEDED`, and changes during a running rebalance fail with `PARTITION_REBALANCING_BACKPRESSURE`.

### Tasks

**`GET /tasks`** lists every task record the store holds. **`GET /tasks/{id}`** returns one record, or 404 `TASK_NOT_FOUND`:

```json
{
  "id": "01890a5d-...",
  "type": "rebalance",
  "indexName": "movies",
  "status": "succeeded",
  "owner": "narsil-pod-1",
  "createdAt": 1719936000000,
  "startedAt": 1719936000012,
  "completedAt": 1719936004321
}
```

`status` moves through `queued`, `running`, and then `succeeded` or `failed`; a failed record carries the error envelope under `error`. Give each instance a stable `NARSIL_INSTANCE_ID` so a restarted instance marks its own interrupted tasks as failed instead of leaving them stuck in `running`.
