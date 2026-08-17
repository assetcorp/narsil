# HTTP server

The server subpath turns an engine into a REST service, and this guide covers every route it serves.

`@delali/narsil/server` wraps an engine you build in a REST API. You own the engine and its configuration (durability, embedding adapters, workers), and the server shares it across requests. The HTTP layer runs on `uWebSockets.js`, an optional peer dependency:

```bash
pnpm add -E uWebSockets.js@github:uNetworking/uWebSockets.js#v20.58.0
```

```ts
import { createNarsil } from '@delali/narsil'
import { createServer } from '@delali/narsil/server'

const engine = await createNarsil({ durability: { directory: './narsil-data' } })

const server = createServer(engine, {
  host: '127.0.0.1',
  port: 7700,
})

await server.listen()
```

`ServerOptions` also accepts `cors`, an `onRequest` hook for authentication, `limits` for body-size, concurrency, result-window, and fetch-count caps, `embeddingAdapters` that JSON index configs reference by name, a `taskStore` that keeps long-running task status across restarts, an `instanceId` for task recovery, and `allowInsecure` for trusted private networks. The server refuses to bind a non-loopback address without an `onRequest` hook, because the admin endpoints can destroy data.

The full surface:

| Method and path | Purpose |
| --- | --- |
| `GET /livez`, `GET /readyz`, `GET /health` | The probes report liveness and readiness without authentication. |
| `GET /version` | The endpoint reports the build identity stamped at startup. |
| `GET /capabilities` | The endpoint lists the optional routes this server serves, and it needs no key either. See [Tasks](#tasks). |
| `GET /stats/memory` | The endpoint returns `getMemoryStats()`. |
| `POST /indexes`, `GET /indexes`, `DELETE /indexes/{name}` | The endpoints create, list, and drop indexes. |
| `GET /indexes/{name}/stats`, `GET /indexes/{name}/partitions`, `GET /indexes/{name}/count` | The endpoints report index, partition, and document-count statistics. |
| `POST /indexes/{name}/_clear` | The endpoint removes every document but keeps the index. |
| `POST /indexes/{name}/documents` | The endpoint inserts one document. |
| `GET`, `PUT`, `PATCH`, `DELETE /indexes/{name}/documents/{id}` | The endpoints read, upsert, update, and remove one document. |
| `GET /indexes/{name}/documents/{id}/_exists` | The endpoint reports whether the id exists. |
| `POST /indexes/{name}/documents/_batch` | The endpoint runs a batch insert, update, or delete with partial results. |
| `POST /indexes/{name}/documents/_multi-get` | The endpoint fetches many documents by id. |
| `POST /indexes/{name}/documents/_list` | The endpoint pages through every stored document, in document-id order or in an order the body names. See [Listing documents](#listing-documents). |
| `POST /indexes/{name}/documents/_import` | The endpoint streams an NDJSON corpus in bounded batches, and `?async=true` runs it as a task instead. See [Tasks](#tasks). |
| `POST /indexes/{name}/search`, `POST /indexes/{name}/search/preflight`, `POST /indexes/{name}/suggest` | The endpoints run queries, match counts, and autocomplete. Each response carries `analysisStale: true` while the index holds terms an earlier analysis produced. See [Analysis revisions](language-support.md#analysis-revisions). |
| `POST /indexes/{name}/_checkpoint`, `GET /indexes/{name}/snapshot`, `POST /indexes/{name}/restore` | The endpoints force a checkpoint, download a snapshot, and restore one. |
| `GET /indexes/{name}/vector-maintenance`, `POST /indexes/{name}/vectors/_compact`, `POST /indexes/{name}/vectors/_optimize` | The endpoints report and run vector maintenance. |
| `POST /indexes/{name}/_rebalance`, `POST /indexes/{name}/partition-config` | The endpoints reshape partitions and adjust partition caps. |
| `POST /indexes/{name}/_rebuild-analysis` | The endpoint reanalyses every document, which an index needs after its language module changes revision. |
| `GET /tasks`, `GET /tasks/{id}`, `POST /tasks/{id}/_cancel` | The endpoints list, report, and stop long-running tasks. See [Tasks](#tasks). |

## Tasks

Five operations run long enough that the server answers before they finish: an import sent with `?async=true`, `restore`, `_rebalance`, `vectors/_optimize`, and `_rebuild-analysis`. Each one answers 202 with a task record and carries on in the background. Every one of them uses the same record shape, which `GET /tasks/{id}` returns again as the work runs.

```json
{
  "id": "0f0d9d3a-6d1e-4a1a-9a9f-2f0d0a1b2c3d",
  "type": "import",
  "indexName": "movies",
  "status": "running",
  "owner": "narsil-0",
  "createdAt": 1755180000000,
  "startedAt": 1755180000000,
  "progress": { "indexed": 12000, "failed": 3, "bytesProcessed": 4194304, "bytesTotal": 9437184 }
}
```

A task ends at `succeeded`, `failed`, or `cancelled`. A failed one holds `error` with the code and the message that stopped it, while a finished import holds `result` with what it indexed and the first refusals. An import alone reports `progress`.

An import counts every refusal, and it lists the first `limits.maxImportErrors` of them, which defaults to 100. Where the list is shorter than the count, the result sets `errorsTruncated`. A body over `limits.maxImportBytes`, which defaults to 100 MB, answers 413 `PAYLOAD_TOO_LARGE` before any of it is indexed.

`GET /tasks` pages through the records, newest first, and filters them by `indexName`, by a comma-separated `type`, and by a comma-separated `status`. It answers `{"tasks":[],"total":0,"from":0,"limit":20,"next":null}`, where `next` holds the offset the following page starts at, and null closes the listing. A `limit` above `limits.maxTaskPageSize`, which defaults to 1,000, answers 400 `INVALID_REQUEST`.

`POST /tasks/{id}/_cancel` asks a running task to stop, and it answers 202 with the record. The work stops between units, so a task reaches `cancelled` only once it has stopped, and a request that comes too late leaves it `succeeded`. Cancelling a finished task answers 409 `TASK_NOT_CANCELLABLE`. A task another instance started answers 409 `TASK_OWNED_BY_ANOTHER_INSTANCE`, because only the process running the work can stop it.

`options.taskStore` decides where the records are kept. The default holds 1,000 of them in this process and drops the oldest finished ones first. A restart loses them, and a second instance never sees them. Supply a store of your own, such as Redis, DynamoDB, or a database, so that any instance can answer for a task. That store receives a time to live with every write: 24 hours for a running record, and an hour for a finished one. The work itself still runs in the process that accepted it, so a shared store gives cross-instance visibility instead of distributed execution. Set `options.instanceId` to a stable value as well, because a restart then marks that instance's own running tasks failed instead of leaving them stuck.

`GET /capabilities` lists the optional routes this server answers, so a client can check before it sends a request that an older server would refuse with 404.

```json
{ "capabilities": ["documents.import.async", "tasks.cancel", "tasks.filter", "indexes.rebuildAnalysis"] }
```

## Listing documents

`POST /indexes/{name}/documents/_list` pages through the stored documents without searching, in document-id order until the body names a `sort`. The body takes `cursor`, `limit`, `filters`, `sort`, and `document`, which are the parameters [`listDocuments`](indexes-and-documents.md#list) takes. It goes over a body rather than a query string because `filters`, `sort`, and `document` are nested objects.

```bash
curl -X POST localhost:9876/indexes/movies/documents/_list \
  -H 'content-type: application/json' \
  -d '{"limit":100}'
```

```json
{
  "documents": [{ "id": "m1", "document": { "title": "The Matrix" } }],
  "cursor": "eyJ2IjoxLCJhIjoibTEifQ==",
  "total": 1204,
  "elapsed": 0.4
}
```

Send the cursor back on the next request, and stop once it comes back null. The cursor holds no server state, so nothing expires when a client stops paging. A client that saved a cursor can resume against a server that has restarted since.

The server bounds `limit` by `limits.maxFetchDocuments`, which defaults to 10,000, and answers 400 `INVALID_REQUEST` for a larger value. It answers a body naming more than eight `sort` fields the same way. A search whose `offset` plus `limit` passes the 10,000-result window answers 400 `SEARCH_RESULT_WINDOW_EXCEEDED`, which names the cursor as the way to page further. For a cursor it never issued, or one sent back under a different `sort`, it answers 400 `SEARCH_INVALID_CURSOR`.

A document id crosses the wire percent-encoded, and the server decodes every path segment, so it finds the document that an id holding a slash, a space, or an accent names. An index name never needs the encoding, because the engine accepts alphanumerics, dots, hyphens, and underscores alone. A segment holding an escape the server cannot decode answers 400 `INVALID_REQUEST`.

The [client guide](client.md) covers `@delali/narsil/client`, which reaches every route here through `fetch` and turns each failure back into a `NarsilError`. The [HTTP server example](../packages/ts/examples/http-server/README.md) documents every endpoint with request and response bodies, curl walkthroughs, Docker packaging, and the environment-driven configuration of a production launcher.
