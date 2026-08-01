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
| `GET /stats/memory` | The endpoint returns `getMemoryStats()`. |
| `POST /indexes`, `GET /indexes`, `DELETE /indexes/{name}` | The endpoints create, list, and drop indexes. |
| `GET /indexes/{name}/stats`, `GET /indexes/{name}/partitions`, `GET /indexes/{name}/count` | The endpoints report index, partition, and document-count statistics. |
| `POST /indexes/{name}/_clear` | The endpoint removes every document but keeps the index. |
| `POST /indexes/{name}/documents` | The endpoint inserts one document. |
| `GET`, `PUT`, `PATCH`, `DELETE /indexes/{name}/documents/{id}` | The endpoints read, upsert, update, and remove one document. |
| `GET /indexes/{name}/documents/{id}/_exists` | The endpoint reports whether the id exists. |
| `POST /indexes/{name}/documents/_batch` | The endpoint runs a batch insert, update, or delete with partial results. |
| `POST /indexes/{name}/documents/_multi-get` | The endpoint fetches many documents by id. |
| `POST /indexes/{name}/documents/_import` | The endpoint streams an NDJSON corpus in bounded batches. |
| `POST /indexes/{name}/search`, `POST /indexes/{name}/search/preflight`, `POST /indexes/{name}/suggest` | The endpoints run queries, match counts, and autocomplete. Each response carries `analysisStale: true` while the index holds terms an earlier analysis produced. See [Analysis revisions](language-support.md#analysis-revisions). |
| `POST /indexes/{name}/_checkpoint`, `GET /indexes/{name}/snapshot`, `POST /indexes/{name}/restore` | The endpoints force a checkpoint, download a snapshot, and restore one. |
| `GET /indexes/{name}/vector-maintenance`, `POST /indexes/{name}/vectors/_compact`, `POST /indexes/{name}/vectors/_optimize` | The endpoints report and run vector maintenance. |
| `POST /indexes/{name}/_rebalance`, `POST /indexes/{name}/partition-config` | The endpoints reshape partitions and adjust partition caps. |
| `GET /tasks`, `GET /tasks/{id}` | The endpoints report long-running task status. |

The [HTTP server example](../packages/ts/examples/http-server/README.md) documents every endpoint with request and response bodies, curl walkthroughs, Docker packaging, and the environment-driven configuration of a production launcher.
