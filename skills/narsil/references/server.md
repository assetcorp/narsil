# Serving Narsil

## 1. Install the server's peer package

```bash
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
- The server calls `onRequest` for every route apart from `/livez`, `/readyz`, `/health`, `/version`, and `/capabilities`. A caller that it admits can also drop, clear, and restore indexes, so give a browser a key that the hook limits to the search routes, as above, and keep the admin key on servers.
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
- The admin methods that take a while, which are `restore`, `rebalance`, `optimizeVectors`, and `rebuildAnalysis`, return a task record. `await client.waitForTask(record.id)` returns the record once the task ends, and it throws nothing for a failed task, so check `status` and `error`.
- For a React app, install `react`, wrap the tree in `<NarsilProvider client={client}>`, and call `useQuery(indexName, params, { keepPreviousData: true })` from `@delali/narsil/react`. Build the client outside every component.

From any other language, send JSON with the caller's key:

```http
POST /indexes/products/search
Authorization: Bearer <key>
Content-Type: application/json

{"term": "folding bicycle", "limit": 10}
```

- The search body takes the same fields as `query`, and the answer holds `hits`, `count`, `countExact`, `coverage`, and, when asked for, `facets` and `cursor`.
- Create an index with `POST /indexes` and `{"name": "products", "config": {"schema": {"title": "string", "price": "number"}}}`. Insert one document with `POST /indexes/{name}/documents` and `{"document": {...}}`, and many with `POST /indexes/{name}/documents/_batch` and `{"documents": [...]}`.
- Load a large corpus as NDJSON through `POST /indexes/{name}/documents/_import`, and add `?async=true` to receive a task that `GET /tasks/{id}` reports on.
- The server answers a failure with `{"error": {"code", "message", "details"}}` and the HTTP status that matches the code.
- A JSON request can't carry an embedding adapter, so register adapters by name in `createNarsil({ embeddingAdapters })`, and name one under `config.embedding.adapter` when you create the index.

## Move an embedded index behind the server

The embedded engine and the server read the same `.nrsl` format, so move the built index across whole:

```ts
const admin = createNarsilClient({ url: 'https://search.example.com', apiKey: process.env.NARSIL_ADMIN_KEY })
const bytes = await narsil.snapshot('products')
const record = await admin.restore('products', bytes)
const finished = await admin.waitForTask(record.id)
if (finished.status !== 'succeeded') throw new Error(finished.error?.message ?? finished.status)
```

Then replace each `narsil.query(...)` call with the same call on a client, since the client keeps the engine's method names and argument shapes.
