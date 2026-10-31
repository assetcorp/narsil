# HTTP server

The server subpath turns an engine into a REST service, and this guide covers every route it serves.

`@delali/narsil/server` puts a REST API in front of an engine that the application builds. The application creates the engine and sets its configuration, such as durability, embedding adapters, and workers, and the server shares that engine across requests. On Node.js the server receives requests on the workers that hold the worker copies, which the engine calls request threads, and it starts one for every thread in `workers.count`, or one alone on a machine with fewer than three cores. A request thread answers a query on an index whose copy it holds from that copy and from the vector copy the threads share, while it sends every write, every admin request, and every query on an index without a copy to the main thread, which answers as it does for its own callers. See [Request threads](partitions-and-workers.md#request-threads). `NarsilServer.requestThreadCount` reports how many threads took requests, and it reads zero where the main thread answers everything itself, which happens with `workers.enabled: false`, on a runtime without worker threads, and on a cluster node's engine. A write returns before it reaches every copy, so pass `wait: true` on a write, or call `POST /indexes/{name}/_wait-for-writes`, before a search that has to see it; see [Writes and the copies](partitions-and-workers.md#writes-and-the-copies). The HTTP layer is built on `uWebSockets.js`, an optional peer dependency:

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

`ServerOptions` also accepts these settings:

- `cors` sets which cross-origin requests the server accepts.
- `onRequest` is a hook for authentication, which the main thread runs once per request on behalf of every request thread.
- `limits` sets the caps on body size, concurrency, the result window, the rerank window, and fetch counts, where `maxConcurrentRequests` counts the requests in flight on every thread together. `limits.maxRerankWindow` caps the `rerank.window` of a search, so that one remote request sends at most that many documents to a model. It defaults to 100, or to the engine's `maxRerankWindow` where that is lower, and the server answers a larger window with 400 `INVALID_REQUEST`. `createServer` throws `CONFIG_INVALID` for a value outside 1 to the engine's `maxRerankWindow`.
- `embeddingAdapters` holds the adapters that JSON index configs refer to by name.
- `rerankAdapters` holds the rerank adapters that a search's `rerank.adapter` refers to by name. The request threads send each model call to the main thread, which holds them. See [Reranking](reranking.md#over-http-and-in-a-cluster).
- `taskStore` keeps the status of long-running tasks across restarts.
- `instanceId` lets the server mark its own unfinished tasks as failed after a restart.
- `allowInsecure` lets the server bind a trusted private network address without an `onRequest` hook.
- `allowRegex` lets you refuse regular expressions from every client. See [Regular expressions](#regular-expressions).
- `cluster` takes the cluster node that the server fronts, so that the server can report the cluster's topology. See [Cluster routes](#cluster-routes).

The server refuses to bind a non-loopback address without an `onRequest` hook, because the admin endpoints can destroy data.

The server closes a connection that receives no request for 8 to 12 seconds, and `uWebSockets.js` sets that limit with no option to change it. When a connection pool or a reverse proxy keeps an idle connection for longer, the next request that it sends on that connection can fail with a closed connection or a reset, so set its idle timeout below 8 seconds. A Node.js client can also fail this way when its thread stalls for 8 seconds or more, because the pool's own idle timer cannot fire during the stall. Break long synchronous work into steps that yield to the event loop.

The full surface:

| Method and path | Purpose |
| --- | --- |
| `GET /livez`, `GET /readyz`, `GET /health` | The probes answer without authentication. `/livez` answers 200 whenever the process can serve HTTP. `/readyz` and `/health` answer 503 until the engine is ready, and again once shutdown begins, so a load balancer that reads either one stops sending traffic through a shutdown. On a cluster node, both of them answer 503 until the node reports `SERVING`. See [Cluster routes](#cluster-routes). |
| `GET /cluster`, `GET /indexes/{name}/cluster`, `PUT /indexes/{name}/replication-factor` | The endpoints report the cluster topology and one index's allocation, and they change an index's replication factor. A server fronting a single engine answers all three with 501. See [Cluster routes](#cluster-routes). |
| `GET /cluster/health`, `GET /metrics` | The endpoints report a green, yellow, or red status for the cluster and each index, and the replication and coordinator figures in the Prometheus text format. Both take the server's authentication, and a server fronting a single engine answers both with 501. See [Cluster health](#cluster-health) and [Metrics](#metrics). |
| `GET /version` | The endpoint reports the build identity stamped at startup. Its `vectorSearch` field names the path through which the answering thread searches vector graphs, `native` or `wasm`. See [Native search core](vector-search.md#native-search-core). |
| `GET /capabilities` | The endpoint lists the optional routes this server serves, and it needs no key either. See [Tasks](#tasks). |
| `GET /stats/memory` | The endpoint returns `getMemoryStats()` plus `requestThreads`, the number of worker threads that receive requests. See [Request threads](partitions-and-workers.md#request-threads). |
| `POST /indexes`, `GET /indexes`, `DELETE /indexes/{name}` | The endpoints create, list, and drop indexes. |
| `GET /indexes/{name}/stats`, `GET /indexes/{name}/partitions`, `GET /indexes/{name}/count` | The endpoints report index, partition, and document-count statistics. |
| `POST /indexes/{name}/_clear` | The endpoint removes every document but keeps the index. |
| `POST /indexes/{name}/_open`, `POST /indexes/{name}/_close` | The endpoints load an index into memory and release it back to disk. See [Index lifecycle](persistence-and-durability.md#index-lifecycle). |
| `POST /indexes/{name}/documents` | The endpoint inserts one document, and `options.wait` in the body makes it return only once every worker copy has applied the write. |
| `GET`, `PUT`, `PATCH`, `DELETE /indexes/{name}/documents/{id}` | The endpoints read, upsert, update, and remove one document. `PUT` and `PATCH` take `options.wait` in the body, and `DELETE` takes `?wait=true`. |
| `POST /indexes/{name}/_wait-for-writes` | The endpoint answers once every worker copy of the index has applied every write that returned before the request. See [Writes and the copies](partitions-and-workers.md#writes-and-the-copies). |
| `GET /indexes/{name}/documents/{id}/_exists` | The endpoint reports whether the id exists. |
| `POST /indexes/{name}/documents/_batch` | The endpoint runs a batch insert, update, or delete with partial results, and `options.wait` applies to the whole batch. |
| `POST /indexes/{name}/documents/_multi-get` | The endpoint fetches many documents by id. |
| `POST /indexes/{name}/documents/_list` | The endpoint pages through every stored document, in document-id order or in an order the body names. See [Listing documents](#listing-documents). |
| `POST /indexes/{name}/documents/_import` | The endpoint streams an NDJSON corpus in bounded batches, and `?async=true` runs it as a task instead. See [Tasks](#tasks). |
| `POST /indexes/{name}/search`, `POST /indexes/{name}/search/preflight`, `POST /indexes/{name}/suggest` | The endpoints run queries, match counts, and autocomplete. Each response carries `analysisStale: true` while the index holds terms an earlier analysis produced. See [Analysis revisions](language-support.md#analysis-revisions). |
| `GET /indexes/{name}/synonyms`, `POST /indexes/{name}/synonyms` | The endpoints read and replace the synonym set of an index. `GET` answers `{ "synonyms": [...] }` with every word as it was written. `POST` takes the new set as `{ "synonyms": [...] }`, answers `{ "ok": true }` once every search uses it, and answers 400 for a body of any other shape. An empty list removes the set. See [Synonyms](full-text-search.md#synonyms). |
| `POST /indexes/{name}/bm25` | The endpoint replaces the BM25 setting of an index. It takes the new setting as `{ "k1": 1.4, "b": 0.5, "fields": { "title": { "b": 0.2 } } }`, answers `{ "ok": true }` once the server applies it, and answers 400 for a value out of range or a field without text. An empty object clears the setting. See [BM25 parameters](full-text-search.md#bm25-parameters). |
| `POST /indexes/{name}/_checkpoint`, `GET /indexes/{name}/snapshot`, `POST /indexes/{name}/restore` | The endpoints force a checkpoint, stream a snapshot archive, and restore an index from an archive as a task. See [Snapshots and exports](#snapshots-and-exports). |
| `GET /indexes/{name}/export`, `POST /indexes/{name}/import` | The endpoints stream a document export and import one as a task. See [Snapshots and exports](#snapshots-and-exports). |
| `GET /indexes/{name}/vector-maintenance`, `POST /indexes/{name}/vectors/_compact`, `POST /indexes/{name}/vectors/_optimize` | The endpoints report and run vector maintenance. |
| `POST /indexes/{name}/_rebalance`, `POST /indexes/{name}/partition-config` | The endpoints reshape partitions and adjust partition caps. |
| `POST /indexes/{name}/_rebuild-analysis` | The endpoint reanalyses every document, which an index needs after its language module changes revision. |
| `POST /indexes/{name}/_change-analysis` | The endpoint gives a live index a new language, tokeniser, or stop word set, from a body such as `{ "language": "french", "tokenizer": null, "stopWords": ["sku"] }`. It answers 400 for a member that it does not recognise or a value of another type. See [Changing an index's analysis](full-text-search.md#changing-an-indexs-analysis). |
| `GET /tasks`, `GET /tasks/{id}`, `POST /tasks/{id}/_cancel` | The endpoints list, report, and stop long-running tasks. See [Tasks](#tasks). |

## OpenAPI description

The file [`packages/ts/openapi.json`](https://github.com/assetcorp/narsil/blob/main/packages/ts/openapi.json) describes every route above in OpenAPI 3.1, so that you can generate a client in any language from it. The npm package holds the same file, which you can import as `@delali/narsil/openapi.json`, and that copy describes the server of the same release.

Where one method of the TypeScript client covers a route, the operation ID is the name of that method, as in `createIndex`. The file marks five `POST` routes with `x-narsil-repeatable: true`, which are search, preflight, suggest, `_list`, and `_multi-get`. Those routes only read, so a client can resend one of those requests after a connection failure, and it should resend no other `POST` without its own check.

## Regular expressions

By default, the server accepts a `regex` test on a pattern field from any client. Because the matcher never backtracks and the engine limits every pattern test through its `patternWorkCap` setting, a regular expression can cost no more work than that cap allows. Set `allowRegex: false` on a public endpoint that should accept no regular expressions at all.

```ts
const server = createServer(engine, { host: '127.0.0.1', port: 7700, allowRegex: false })
```

While `allowRegex` is false, the server answers 400 with `SEARCH_INVALID_FILTER` to every search, preflight, and document list request whose filter holds a `regex` test. The server finds a `regex` test at any depth of `and`, `or`, and `not`. The error message tells the client that the server refused the test because of the `allowRegex` option. The request threads refuse such a request in the same way, before they search a worker copy. The other pattern tests, such as `contains` and `wildcard`, stay available, so a client can still match `INV-*-2024`. When you pass a value other than true or false, `createServer` throws `CONFIG_INVALID`. See [Pattern tests](filters-facets-and-pagination.md#pattern-tests) for the syntax and the limits.

## Shutting down

`server.shutdown()` closes the server and then shuts the engine down, which is the one call that a process whose work is this server makes on its way out:

```ts
const stop = async (): Promise<void> => {
  await server.shutdown()
  process.exit(0)
}

process.once('SIGTERM', () => void stop())
process.once('SIGINT', () => void stop())
```

`server.close()` stops the server taking requests and leaves the engine running, which is what a process that fronts one engine with two servers calls. That process shuts the engine down itself once its last server closes.

Shutting the engine down is what ends the request threads, which is why a process that closes the server alone still holds them. Where such a process exits while a request thread holds a client connection, Node terminates that thread and then fails to close its event loop. Node prints an assertion of its own and ends the process with code 134 in place of the code that you passed, so a supervisor reading the exit code records a crash. A process that installs no signal handler takes Node's default, under which `SIGTERM` ends it with code 143 and no assertion.

An uncaught error on the main thread ends the process the same way, because nothing shuts the engine down on that path. Node prints your own error and its stack first, so you still see what failed. Handle the error yourself where you want a clean exit code:

```ts
process.on('uncaughtException', async error => {
  console.error(error)
  await server.shutdown()
  process.exit(1)
})
```

## Tasks

Seven operations take long enough that the server answers before they finish: an import sent with `?async=true`, `restore`, the `import` of a document export, `_rebalance`, `vectors/_optimize`, `_rebuild-analysis`, and `_change-analysis`. Each one answers 202 with a task record and carries on in the background. Every one of them uses the same record shape, which `GET /tasks/{id}` returns again as the work proceeds.

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

An import counts every refusal, and it lists the first `limits.maxImportErrors` of them, which defaults to 100. Where the list is shorter than the count, the result sets `errorsTruncated`. A body over `limits.maxImportBytes`, which defaults to 100 MB, answers 413 `PAYLOAD_TOO_LARGE` before any of it is indexed, and a single line over `limits.maxLineBytes` answers the same code with the line number in `details.line`.

Each running task holds its own working set, and an async import holds the whole uploaded corpus until it finishes, so one instance drives `limits.maxConcurrentTasks` of them at once, which defaults to 4. A request that arrives while that many are running answers 429 `TOO_MANY_REQUESTS`. Set it to 0 to accept every task, which suits a server behind a queue of your own.

`GET /tasks` pages through the records, newest first, and filters them by `indexName`, by a comma-separated `type`, and by a comma-separated `status`. It answers `{"tasks":[],"total":0,"from":0,"limit":20,"next":null}`, where `next` holds the offset the following page starts at, and null closes the listing. A `limit` above `limits.maxTaskPageSize`, which defaults to 1,000, answers 400 `INVALID_REQUEST`.

`POST /tasks/{id}/_cancel` asks a running task to stop, and it answers 202 with the record. The work stops between units, so a task reaches `cancelled` only once it has stopped, and a request that comes too late leaves it `succeeded`. Cancelling a finished task answers 409 `TASK_NOT_CANCELLABLE`. A task another instance started answers 409 `TASK_OWNED_BY_ANOTHER_INSTANCE`, because only the process running the work can stop it.

`options.taskStore` decides where the records are kept. The default holds 1,000 of them in this process and drops the oldest finished ones first. A restart loses them, and a second instance never sees them. Supply a store of your own, such as Redis, DynamoDB, or a database, so that any instance can answer for a task. That store receives a time to live with every write: 24 hours for a running record, and an hour for a finished one. The work itself still executes in the process that accepted it, so a shared store lets every instance read the record while the work stays where it started. Set `options.instanceId` to a stable value as well, because a restart then marks that instance's own running tasks failed, and they would otherwise stay stuck.

`GET /capabilities` lists the optional routes this server answers, so a client can check before it sends a request that an older server would refuse with 404.

```json
{
  "capabilities": [
    "documents.import.async",
    "tasks.cancel",
    "tasks.filter",
    "indexes.rebuildAnalysis",
    "indexes.changeAnalysis",
    "indexes.lifecycle",
    "indexes.documentExport",
    "indexes.synonyms",
    "indexes.bm25"
  ]
}
```

## Snapshots and exports

`GET /indexes/{name}/snapshot` streams the index's snapshot archive with the content type `application/x-tar`. `GET /indexes/{name}/export` streams the index's document export with the content type `application/x-ndjson`. The [persistence guide](persistence-and-durability.md#snapshots-and-restore) describes both formats and which checkpoint the engine reads for each stream.

`POST /indexes/{name}/restore` takes a snapshot archive as the request body, while `POST /indexes/{name}/import` takes a document export. The server writes each body to a temporary file as the body arrives. It pauses the upload whenever it holds 8 MiB of the body in memory that it has yet to write to the disk, so the server needs the same memory for an upload of any size. Once the upload ends, the server answers 202 with a task record. In the task, the engine restores the index or imports the documents from that file, after which the server deletes the file.

The server limits both bodies to `limits.maxRestoreBytes`, 64 GiB by default, and answers a larger body with 413 `PAYLOAD_TOO_LARGE`. Set the limit to 0 to accept an upload of any size. The server answers an empty body with 400 `EMPTY_BODY`.

When an import of a document export finishes, its task record holds `result` with the fields of an NDJSON import's result: `indexed`, `failed`, `errors`, and `errorsTruncated`. `failed` is the number of refused lines, while `errors` holds the first `limits.maxImportErrors` refusals by line number, each with its line number, error code, and message. The server tracks `progress` for an NDJSON import alone.

## Cluster routes

A server that fronts a cluster node takes `node.cluster` as the `cluster` option, and the routes in this section then report what that node knows. Without the option, `/readyz` reports the engine alone, and every other route in this section answers 501 `CLUSTER_OPERATION_UNSUPPORTED`.

`GET /readyz` answers 200 only while the node reports `SERVING`, and 503 otherwise, so a load balancer can send traffic to a node once it serves every partition the controller gave it. The body names the node either way:

```json
{
  "status": "ready",
  "cluster": { "nodeId": "node-a", "roles": ["data", "coordinator", "controller"], "status": "active", "readiness": "SERVING", "isController": true }
}
```

`readiness` is one of `STARTING`, `JOINING`, `SERVING`, and `LEAVING`, which the [cluster guide](cluster.md#what-a-node-serves) defines.

`GET /cluster` reports the node itself under `node`, the id of the node holding the controller lease, and every registration the coordinator holds:

```json
{
  "node": { "nodeId": "node-a", "roles": ["data", "coordinator", "controller"], "status": "active", "readiness": "SERVING", "isController": true },
  "controllerNodeId": "node-a",
  "nodes": [
    {
      "nodeId": "node-a",
      "address": "node-a:9200",
      "roles": ["data", "coordinator", "controller"],
      "memory": { "processBytes": 412090368, "processLimitBytes": 4294967296, "heapBytes": 201326592, "heapLimitBytes": 2197815296, "full": false }
    }
  ]
}
```

`memory` holds the figures from the node's latest heartbeat, and it reads `null` for a node that has yet to report any. While a node reports `full`, every node refuses inserts and updates to each index that has a copy on that node, as the [cluster guide](cluster.md#when-a-node-runs-short-of-memory) describes.

`GET /indexes/{name}/cluster` reports one index's allocation partition by partition, in partition order. An index the controller has yet to allocate answers with `allocated` false and no partitions. A name the cluster would never accept answers 400 `INVALID_REQUEST`.

```json
{
  "indexName": "movies",
  "allocated": true,
  "version": 4,
  "partitions": [
    { "partitionId": 0, "state": "ACTIVE", "primary": "node-a", "primaryTerm": 1, "commitPoint": 1204, "replicas": ["node-b"], "inSyncSet": ["node-b"], "lastHolders": [], "unassignedReason": null }
  ]
}
```

`PUT /indexes/{name}/replication-factor` takes a body such as `{"replicationFactor": 2}` and changes how many replicas besides the primary each partition of the index keeps. The node sends the change to the controller, which stores the factor and writes an allocation table that carries it before the server answers 200 with the index name and the factor. A factor outside 0 to 255 answers 400 `CONFIG_INVALID`, and an index that the cluster doesn't hold answers 404 `INDEX_NOT_FOUND`.

### Cluster health

`GET /cluster/health` reports a status for the cluster and for each index, and it answers 200 whatever the status, so a monitor reads the status from the body:

```json
{
  "status": "yellow",
  "indexes": [
    { "indexName": "movies", "status": "yellow", "partitionCount": 4, "replicationFactor": 2, "partitionsWithoutPrimary": 0, "underReplicatedPartitions": 1 }
  ]
}
```

An index is `green` when every partition is `ACTIVE` with a primary and `replicationFactor` in-sync replicas. It is `yellow` when every partition has a primary but some partition holds fewer in-sync replicas, and `red` when some partition has no primary, so the documents in that partition can be neither read nor written. A primary or a replica counts only while its node stays registered with the coordinator, so an index turns red as soon as the node that holds a primary leaves and no replica can take over. The cluster takes the worst status of its indexes, and a cluster that holds no index reports `green`.

### Metrics

`GET /metrics` answers in the Prometheus text format, with the content type `text/plain; version=0.0.4; charset=utf-8`, so a Prometheus server can scrape each node directly. A node reports these series:

| Series | Labels | Reported by | Meaning |
| --- | --- | --- | --- |
| `narsil_replication_lag` | `index`, `partition`, `replica` | The partition's leader | The leader's last sequence number minus the highest sequence number that the replica acknowledged. |
| `narsil_commit_point` | `index`, `partition` | The partition's leader | The highest sequence number that the leader has acknowledged to a client. |
| `narsil_commit_point_floor` | `index`, `partition` | Every node | The floor on the commit point that the allocation table stores. The controller raises it only when it admits a replica, so it can trail `narsil_commit_point` by many writes. |
| `narsil_in_sync_replicas` | `index`, `partition` | Every node | The replicas besides the primary that the allocation table holds in the in-sync set. |
| `narsil_coordinator_request_seconds` | `operation` | Every node | A histogram of how long this node's calls to the coordinator took, such as `getAllocation`, with buckets from 1 ms to 10 s. |

Scrape every node, because each one reports the lag and the commit point only for the partitions that it leads. An alert on `narsil_replication_lag` that stays above zero for a few scrapes catches a replica that has stopped applying entries.

## Listing documents

`POST /indexes/{name}/documents/_list` pages through the stored documents without searching, in document-id order until the body names a `sort`. The body takes `cursor`, `limit`, `filters`, `sort`, and `document`, which are the parameters [`listDocuments`](indexes-and-documents.md#list) takes. It takes a body because `filters`, `sort`, and `document` are nested objects.

```bash
curl -X POST localhost:9876/indexes/movies/documents/_list \
  -H 'content-type: application/json' \
  -d '{"limit":100}'
```

```json
{
  "documents": [{ "id": "m1", "document": { "title": "The Matrix" } }],
  "cursor": "eyJ2IjozLCJhIjoibTEiLCJxIjoiMDU1MzdhMDcifQ==",
  "total": 1204,
  "elapsed": 0.4
}
```

Send the cursor back on the next request, and stop once it comes back null. The cursor holds no server state, so nothing expires when a client stops paging. A client that saved a cursor can resume against a server that has restarted since.

The server bounds `limit` by `limits.maxFetchDocuments`, which defaults to 10,000, and answers 400 `INVALID_REQUEST` for a larger value. It answers a body naming more than eight `sort` fields the same way. A search whose `offset` plus `limit` passes the 10,000-result window answers 400 `SEARCH_RESULT_WINDOW_EXCEEDED`, which names the cursor as the way to page further. A hybrid search whose page starts at the `hybrid.depth` that it sets answers the same status and code, and the message tells the caller to raise `hybrid.depth`. For a cursor it never issued, or one sent back under a changed query or a different `sort`, it answers 400 `SEARCH_INVALID_CURSOR`.

A document id crosses the wire percent-encoded, and the server decodes every path segment, so it finds the document that an id holding a slash, a space, or an accent names. An index name never needs the encoding, because the engine accepts alphanumerics, dots, hyphens, and underscores alone. A segment holding an escape the server cannot decode answers 400 `INVALID_REQUEST`.

The [client guide](client.md) covers `@delali/narsil/client`, which reaches every route here through `fetch` and turns each failure back into a `NarsilError`. The [HTTP server example](../packages/ts/examples/http-server/README.md) serves every route above from a launcher that takes each setting from the environment, and it covers the curl walkthrough, the Docker image, and the rules for binding it safely.
