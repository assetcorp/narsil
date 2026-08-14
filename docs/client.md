# Client

`@delali/narsil/client` reaches a Narsil server over HTTP under the method names the embedded engine uses.

```ts
import { createNarsilClient } from '@delali/narsil/client'

const client = createNarsilClient({ url: 'http://localhost:9876' })

const results = await client.query('movies', { term: 'matrix', fields: ['title'] })
```

That call takes the arguments [`query`](full-text-search.md#basic-queries) takes on an embedded engine, and it answers with the same `QueryResult`. Every other method follows the same rule, so a module written against an engine moves to a server when you change what it imports.

HTTP forces two differences. Every method takes per-call request settings as a last argument, which hold the signal, the deadline, and any extra headers. The operations that can run for minutes answer with a task record while the work carries on, so you follow that record instead of awaiting the work.

The client sends through `fetch` and imports no Node built-in, so it runs in a browser, in Node, and in an edge function. `scripts/check-browser-bundle.mjs` walks its import graph on every build so that a Node import cannot reach it unnoticed.

## Building one

```ts
const client = createNarsilClient({
  url: 'https://search.example.com',
  apiKey: process.env.NARSIL_API_KEY,
  timeoutMs: 10_000,
})
```

Only `url` is required.

| Option | What it does |
| --- | --- |
| `url` | The server answers at this address. Pass an absolute URL, or a path such as `/search-api` when a browser reaches the server through its own origin. |
| `apiKey` | The client sends this as `authorization: Bearer <key>`, which a server reads in its `onRequest` hook. For any other scheme, set the header yourself through `headers`. |
| `headers` | The client sends these with every request, and a per-call header of the same name replaces one. |
| `timeoutMs` | The client waits this many milliseconds for an answer, and 30,000 unless you say otherwise. Pass 0 so that it waits for as long as the server takes. |
| `fetch` | The client sends through this instead of the global `fetch`, which is what a proxy agent or a test stub needs. |

The client opens no connection, and it holds no state beyond the capabilities it reads once, so nothing needs closing. Keep one for the application's lifetime.

## Settings for one call

Every method takes `signal`, `timeoutMs`, and `headers` last. Aborting the signal fails the call with `CLIENT_REQUEST_ABORTED`, and it stops the HTTP request as well.

```ts
const controller = new AbortController()
const results = await client.query('movies', { term: 'matrix' }, { signal: controller.signal, timeoutMs: 2000 })
```

Three routes carry a corpus or a whole index, so `importDocuments`, `snapshot`, and `restore` set no deadline of their own. Each waits until you set `timeoutMs`, either on the client or on the call.

## Errors

Every failure throws a `NarsilError` under the code the server sent, so a branch written against an embedded engine works here unchanged. `details.status` holds the HTTP status alongside whatever details the server sent.

```ts
import { ErrorCodes, NarsilError } from '@delali/narsil/client'

try {
  await client.insert('movies', { title: 42 })
} catch (err) {
  if (err instanceof NarsilError && err.code === ErrorCodes.DOC_VALIDATION_FAILED) {
    console.error(err.message, err.details)
  }
}
```

A server's `onRequest` hook rejects a request under a code of its own, such as `UNAUTHORIZED`, and the client passes that code through unchanged.

Five codes come from the client itself, and no server sends one. They are exported as `ClientErrorCodes`.

| Code | The client raises it when |
| --- | --- |
| `CLIENT_CONNECTION_FAILED` | `fetch` could not reach the server. |
| `CLIENT_REQUEST_TIMEOUT` | The deadline passed before the answer arrived. |
| `CLIENT_REQUEST_ABORTED` | The caller aborted the signal. |
| `CLIENT_INVALID_RESPONSE` | The answer holds no JSON, or not the shape the route documents, which is what a proxy's error page produces. |
| `CLIENT_TASK_TIMEOUT` | The wait passed `waitTimeoutMs` while the task kept running. |

A lookup by id answers with nothing instead of failing, so `get` returns `undefined` for an unknown document and `getTask` returns `null` for an unknown task. Every other failure throws.

## Loading a corpus

`importDocuments` encodes the documents as NDJSON, sends them in one request, and answers once the whole load has finished. It takes a string or a byte array as well, so NDJSON you read from a file needs no re-encoding.

```ts
const result = await client.importDocuments('movies', documents)
console.log(result.indexed, result.failed, result.errors)
```

One bad record never abandons the rest, because the server notes each failure and carries on. `failed` counts every refusal, while `errors` lists the first 100 of them, which is the server's `maxImportErrors` limit. `errorsTruncated` marks a list cut short. The server's `maxImportBytes` limit refuses a body over 100 MB with `PAYLOAD_TOO_LARGE`.

Where a load would outlast a proxy's response timeout, start a task instead and follow it.

```ts
const task = await client.startImport('movies', documents)
const finished = await client.waitForTask(task.id, {
  onProgress: record => console.log(record.progress?.bytesProcessed, 'of', record.progress?.bytesTotal),
})
```

## Following a task

Five operations run as tasks: an import started through `startImport`, `restore`, `rebalance`, `optimizeVectors`, and `rebuildAnalysis`. Each answers straight away with a record holding an `id`, a `status`, and, for an import alone, a `progress` object.

`waitForTask` polls until the task reaches `succeeded`, `failed`, or `cancelled`, then returns the record it ended on. A failed task comes back with its `error` set while the call throws nothing, because a part-finished import still reports what it indexed. Read the status you get back.

| Option | What it does |
| --- | --- |
| `pollIntervalMs` | The client asks again this often, and every 250 ms unless you say otherwise, which is how often a running import writes its progress. |
| `waitTimeoutMs` | The wait fails with `CLIENT_TASK_TIMEOUT` after this long while the task keeps running. It waits for as long as the task takes unless you set this. |
| `onProgress` | The client calls this each time the record changes, and never twice for the same figures. |

`cancelTask` asks a running task to stop. The work stops between units, so the task reaches `cancelled` only once it has stopped, and a request that comes too late leaves it `succeeded`. Whatever the task had already written stays written.

`listTasks` pages through the records the server still holds, newest first, and filters them by index, type, and status.

```ts
const page = await client.listTasks({ indexName: 'movies', status: ['running'], limit: 50 })
```

A page holds 20 records unless `limit` sets another size. `next` holds the offset the following page starts at, and it comes back null on the last page. The server's default store keeps 1,000 records and drops the oldest finished ones first, so `getTask` answers `null` once a record has gone. A [`taskStore`](http-server.md#tasks) of your own receives a time to live with every write: 24 hours for a running record, and an hour for a finished one.

## Asking what a server serves

`version` reports the build the server was stamped with, while `isAlive` and `isReady` report the two probes. Readiness turns false while a server starts up, and again once it starts draining. All three answer without credentials.

`supports` reports whether the server serves an optional route. Check it before calling a route an older server would refuse with 404.

```ts
import { ASYNC_IMPORT_CAPABILITY } from '@delali/narsil/client'

if (await client.supports(ASYNC_IMPORT_CAPABILITY)) {
  await client.startImport('movies', documents)
}
```

The client reads the answer once and keeps it, because a server cannot take on a capability without restarting. A server that predates the endpoint itself answers 404, and the client then reports a server with no capabilities.

## Every method

| Group | Methods |
| --- | --- |
| Indexes | `createIndex`, `listIndexes`, `dropIndex`, `getStats`, `getPartitionStats`, `clear` |
| Documents | `insert`, `get`, `has`, `put`, `update`, `remove`, `countDocuments` |
| Bulk | `insertBatch`, `updateBatch`, `removeBatch`, `getMultiple`, `listDocuments`, `importDocuments`, `startImport` |
| Search | `query`, `preflight`, `suggest` |
| Tasks | `getTask`, `listTasks`, `cancelTask`, `waitForTask` |
| Maintenance | `checkpoint`, `snapshot`, `restore`, `vectorMaintenanceStatus`, `compactVectors`, `optimizeVectors`, `rebalance`, `updatePartitionConfig`, `rebuildAnalysis`, `getMemoryStats` |
| Server | `version`, `capabilities`, `supports`, `isAlive`, `isReady` |

`createIndex` takes whatever JSON can express of the engine's configuration. A custom tokeniser, a stop-word function, and an embedding adapter are all functions, so name a language and a server-registered adapter instead. The [HTTP server guide](http-server.md) covers the `embeddingAdapters` option a server registers those under.

The client encodes every index name and document id it puts in a path, and the server decodes each segment. An id holding a slash, a space, or an accent therefore reaches the document it names.
