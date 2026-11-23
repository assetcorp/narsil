# Serving Narsil

## Choose the server

Narsil has two servers, which answer the same routes with the same statuses, error codes, and limits, so every client calls either one unchanged. They also keep their indexes in one file format, so a node keeps its indexes when it switches from one to the other.

- **The TypeScript server** is in `@delali/narsil/server` and in the image `ghcr.io/assetcorp/narsil`. Choose it for a cluster node that embeds documents through an embedding adapter, for a `transformers` embedder or reranker that runs a model inside the node, or for a server that needs code that you write in TypeScript.
- **The Rust server** is in every image tag that ends in `-rust`, such as `latest-rust` for `latest`, which serves the same release. The image serves one node outside any cluster, so it answers the cluster routes, the backup routes, `/metrics`, and `/cluster/health` with 501 and the code `CLUSTER_OPERATION_UNSUPPORTED`, and its startup program exits with status 1 when a variable asks for the `transformers` kind. Its crate, `delali-narsil-server`, serves an engine from a Rust program, and `cargo install delali-narsil-server` installs its `narsil-server` binary. A binary built with `--features cluster` can join a cluster beside TypeScript nodes when `NARSIL_CLUSTER_ETCD_ENDPOINTS` is set, and it then answers the same routes as a TypeScript cluster node.

## Start the image when the server needs no code

The image `ghcr.io/assetcorp/narsil` serves one node and takes every setting from an environment variable. With `NARSIL_ADMIN_KEY` and `NARSIL_READ_KEY` set in the shell, this command starts a node that keeps its indexes on a volume:

```bash skip
docker run -d -p 127.0.0.1:7700:7700 -e NARSIL_ADMIN_KEY -e NARSIL_READ_KEY -v narsil-data:/data ghcr.io/assetcorp/narsil:latest
```

- Each key must hold at least 32 characters, and the two keys must differ, or the node exits with status 1.
- The read key may call the search, suggestion, and document-reading routes, which include listing and fetching every stored document, and every `GET` route apart from the snapshot and the export. Give that key to a browser only when every document in the node may be public, and route a browser's searches through the app's backend otherwise.
- The node answers `/livez`, `/readyz`, `/health`, and `/version` without a key, and every other route needs `Authorization: Bearer <key>`.
- `NARSIL_LANGUAGES` registers language modules, given as a comma-separated list such as `english,french`. `NARSIL_EMBEDDERS` and `NARSIL_RERANKERS` list adapter names that an index or a query can use, and each name takes its kind, such as `openai` for an OpenAI-compatible endpoint or `transformers` for a model inside the node, from a variable such as `NARSIL_EMBEDDER_<NAME>_KIND`, which spells the name in upper case with each `-` written as `_`.
- Add `-rust` to the tag, as in `ghcr.io/assetcorp/narsil:latest-rust`, to run the same release on the Rust server with the same variables.
- Write the server in the steps below when it needs an adapter that you write, an `onRequest` hook that no key describes, or cluster mode, because the image serves one node.

## 1. Install the server's peer package

```bash skip
pnpm add -E "uWebSockets.js@$(node -p "require('./node_modules/@delali/narsil/package.json').devDependencies['uWebSockets.js']")"
```

The command installs uWebSockets.js from the GitHub source in the `devDependencies` of the installed `@delali/narsil`, since its author publishes it only on GitHub. Ignore the packages with similar names on npm. When the package is missing, `server.listen()` throws `CONFIG_INVALID` with a message that contains the name of the package to install.

## 2. Write the server

```ts
import { timingSafeEqual } from 'node:crypto'
import { createNarsil } from '@delali/narsil'
import { createFilesystemPersistence } from '@delali/narsil/adapters/filesystem'
import { createServer, type RequestContext, type RequestDenial } from '@delali/narsil/server'

const adminKey = process.env.NARSIL_ADMIN_KEY
const searchKey = process.env.NARSIL_SEARCH_KEY
if (!adminKey || !searchKey) throw new Error('Set NARSIL_ADMIN_KEY and NARSIL_SEARCH_KEY')
if (adminKey === searchKey) throw new Error('Give NARSIL_ADMIN_KEY and NARSIL_SEARCH_KEY different values')

const SEARCH_ROUTE = /^\/indexes\/[^/]+\/(search|search\/preflight|suggest)$/

const holds = (header: string | undefined, key: string): boolean => {
  const sent = Buffer.from(header ?? '')
  const expected = Buffer.from(`Bearer ${key}`)
  return sent.length === expected.length && timingSafeEqual(sent, expected)
}

const admit = (request: RequestContext): RequestDenial | undefined => {
  if (holds(request.headers.authorization, adminKey)) return undefined
  if (holds(request.headers.authorization, searchKey) && request.method === 'POST' && SEARCH_ROUTE.test(request.path)) {
    return undefined
  }
  return { status: 401, code: 'UNAUTHORIZED', message: 'Send a key that allows this request.' }
}

const engine = await createNarsil({ persistence: createFilesystemPersistence({ directory: './data/search' }) })

const server = createServer(engine, {
  host: '0.0.0.0',
  port: 7700,
  onRequest: admit,
  cors: { origin: ['https://app.example.com'] },
  limits: { maxConcurrentRequests: 256 },
})

await server.listen()

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void server.shutdown())
}
```

## 3. Keep it safe

- The server binds `127.0.0.1` on port 9876 by default. For any other address, `listen()` throws `CONFIG_INVALID` unless you pass `onRequest`. Set `allowInsecure: true` only on a private network where something else controls access.
- The server calls `onRequest` for every route apart from `/livez`, `/readyz`, `/health`, and `/version`. A caller that it admits can also drop, clear, and restore indexes, so give a browser a key that the hook limits to the search routes, as above, and keep the admin key on servers.
- List the app's origins in `cors.origin`, since `cors: true` admits every origin.
- `limits.maxConcurrentRequests` defaults to 0, which sheds nothing, so set a ceiling before the address goes public. The server answers a body over 16 MiB with 413, and a `limit` or an `offset` over 10,000 with 400.
- Put a TLS-terminating proxy in front before anything outside the machine connects. Behind a proxy, `remoteAddress` holds the proxy's address.
- Call `server.shutdown()` before the process exits, because it stops the server and then the engine. A process that calls `process.exit` after the server has served a request aborts with exit code 134.

## 4. Call it

From JavaScript or TypeScript, including a browser, use the client, which takes the engine's method names:

```ts
import { createNarsilClient } from '@delali/narsil/client'

const search = createNarsilClient({ url: 'https://search.example.com', apiKey: process.env.NARSIL_SEARCH_KEY })
const results = await search.query('products', { term: 'folding bicycle', limit: 10 })
```

- `process.env` exists only on a server. In a browser bundle, read the search-only key from the app's public build settings, such as `import.meta.env.VITE_NARSIL_SEARCH_KEY` under Vite, and keep the admin key out of every bundle.
- The admin methods that take a while, which are `restore`, `importDocumentExport`, `rebalance`, `optimizeVectors`, `rebuildAnalysis`, and `changeAnalysis`, return a task record. `await client.waitForTask(record.id)` returns the record once the task ends, and it throws nothing for a failed task, so check `status` and `error`.
- For a React app, install `react`, wrap the tree in `<NarsilProvider client={client}>`, and call `useQuery(indexName, params, { keepPreviousData: true })` from `@delali/narsil/react`. Build the client outside every component.

Call the server from Python through the `narsil-client` package on PyPI, or from Go through the `github.com/assetcorp/narsil/packages/go` module. Each client holds a typed method for every route that the server documents in its OpenAPI file. When you give a client the addresses of several cluster nodes, it moves a read to the next node after a refused connection, a timeout, or an answer of 502, 503, or 504.

From any other language, send JSON with the caller's key:

```http skip
POST /indexes/products/search
Authorization: Bearer <key>
Content-Type: application/json

{"term": "folding bicycle", "limit": 10}
```

- The search body takes the same fields as `query`, and the answer holds `hits`, `count`, `countExact`, `coverage`, and, when asked for, `facets` and `cursor`.
- Create an index with `POST /indexes` and `{"name": "products", "config": {"schema": {"title": "string", "price": "number"}}}`. Insert one document with `POST /indexes/{name}/documents` and `{"document": {...}}`, and many with `POST /indexes/{name}/documents/_batch` and `{"documents": [...]}`.
- Load a large corpus as NDJSON through `POST /indexes/{name}/documents/_import`, and add `?async=true` to receive a task that `GET /tasks/{id}` reports on.
- Every read leaves out vector fields unless the index sets `"returnVectors": true`. Add `?vectors=true` to `GET /indexes/{name}/documents/{id}`, or send `"document": {"vectors": true}` in a search, multi-get, or list body, to get them back.
- The server answers a failure with `{"error": {"code", "message", "details"}}` and the HTTP status that matches the code.
- A JSON request can't carry an embedding adapter, so register adapters by name in `createNarsil({ embeddingAdapters })`, and name one under `config.embedding.adapter` when you create the index.

## Move an embedded index behind the server

The embedded engine and the server restore the same snapshot archive, so stream the built index across whole:

<!-- example setup
import type { Narsil } from '@delali/narsil'
import { createNarsilClient } from '@delali/narsil/client'
declare const narsil: Narsil
-->
```ts
const admin = createNarsilClient({ url: 'https://search.example.com', apiKey: process.env.NARSIL_ADMIN_KEY })
const archive = await narsil.snapshot('products')
const record = await admin.restore('products', archive)
const finished = await admin.waitForTask(record.id)
if (finished.status !== 'succeeded') throw new Error(finished.error?.message ?? finished.status)
```

Then replace each `narsil.query(...)` call with the same call on a client, since the client keeps the engine's method names and argument shapes.
