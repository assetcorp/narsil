# React

`@delali/narsil/react` gives a React application Narsil's reads as hooks, over a client of a server or over an engine in the same page. Each hook sends one request and reports where that request stands. Whenever its arguments change, the hook sends the request again.

```tsx
import { createNarsilClient } from '@delali/narsil/client'
import { NarsilProvider, useQuery } from '@delali/narsil/react'

const client = createNarsilClient({ url: '/search-api' })

function Results({ term }: { term: string }) {
  const { data, isLoading } = useQuery('movies', { term, fields: ['title'] })
  if (isLoading) return <Spinner />
  return <ol>{data?.hits.map(hit => <li key={hit.id}>{hit.document.title}</li>)}</ol>
}

export function App() {
  return (
    <NarsilProvider client={client}>
      <Results term="matrix" />
    </NarsilProvider>
  )
}
```

React is an optional peer dependency at 19.2 or later, which no other entry point imports. The hooks import no Node built-in, so they work in a browser. On a server, each hook renders as loading and sends nothing.

Build the client outside the component tree, because a render that builds a client builds a new one every time, so every hook under it starts again.

## Searching an engine in the page

Pass an engine to the provider in place of a client, so that every read hook calls the engine method of the same name, with no server in between.

```tsx
import { createNarsil } from '@delali/narsil'
import { NarsilProvider } from '@delali/narsil/react'

const engine = await createNarsil()
await engine.createIndex('movies', { schema: { title: 'string' } })

export function App() {
  return (
    <NarsilProvider engine={engine}>
      <Results term="matrix" />
    </NarsilProvider>
  )
}
```

Create the engine outside the component tree as well, because a render that creates an engine creates a new one every time, with none of the indexes that the first one holds. The provider throws `CONFIG_INVALID` as it renders when its props set both a client and an engine, or neither.

Under an engine, each read hook returns the same data that a client returns from a server that holds the same index. A vector field comes back as an array of numbers under both, while `elapsed` reports the time that the engine spent in the page. The engine answers in the page, so the hooks leave out `headers` and `timeoutMs`.

`useTask`, `useTasks`, and `useImport` throw `CONFIG_INVALID` as they render under an engine, because only a server handles tasks and imports. `useNarsilClient` throws the same error under an engine, because the provider holds no client, so import the engine into a component that writes and call the write method on the engine itself.

### Refreshing after a write

The provider listens for the engine's `write` event, whose payload holds the name of the index. The engine emits it after the inserts, updates, and removals, singly or in a batch, and after `clear`, `restore`, `rebalance`, `rebuildAnalysis`, `compactVectors`, `optimizeVectors`, `createIndex`, and `dropIndex`. A call that throws emits it too, because a call can change the index before it throws. After a write, every hook that reads that index searches again, while `useIndexes` searches again after a write to any index.

The provider starts the refresh once 200 ms pass with no further write, so each mounted hook searches once per burst of writes, after the last write in the burst. The 200 ms matches the default update interval of [live queries in Couchbase Lite](https://docs.couchbase.com/mobile/1.4.4/couchbase-lite-ios/interfaceCBLLiveQuery.html). Set `refreshAfterWriteMs` on the provider for a longer or a shorter wait. While an application keeps writing at intervals shorter than that wait, the last answer stays on screen.

A hook discards any answer that is still in flight when the engine reports a write to its index, so an older answer never replaces a newer one.

The engine emits the event once a query can see the write, which means after every worker copy applies it and after any rebalance in progress replays it, so the search that the refresh sends includes the write. A search that finishes between the write and the event can therefore still reach the screen, until the refresh replaces its answer. Where an engine shares an IndexedDB store with other tabs through `createBroadcastChannelInvalidation()`, it also emits the event after it reloads an index that another tab saved, so the hooks in every tab refresh.

The engine waits for a write to become visible only while a listener is registered for the event, so a write adds no step while nothing listens.

## What a read hook returns

Every hook that reads returns the same five fields.

| Field | What it holds |
| --- | --- |
| `data` | This is the answer, and it stays `undefined` until the first one arrives. |
| `error` | This is the `NarsilError` that the last request ended on, and the next success clears it. |
| `isLoading` | This is true until the first answer arrives, so show a spinner while it is true. |
| `isFetching` | This is true while any request is in flight, a refresh included, so dim the list while it is true. |
| `refresh` | Calling it sends the request again, and the answer already on screen stays there until the new one arrives. |

The last argument of every read hook holds the same settings, apart from `useTask`, where `pollIntervalMs` replaces `refreshIntervalMs`.

| Setting | What it does |
| --- | --- |
| `enabled` | The hook sends nothing while this is false, so keep it false until the search has a term. A request already in flight continues until the provider drops its key, which happens `keepAliveMs` after the last component that reads the key unmounts. That interval is 2,000 ms unless you set another value on the provider. |
| `keepPreviousData` | The hits already on screen stay there while the next answer loads. |
| `refreshIntervalMs` | The hook sends the request again at this interval in milliseconds, pausing while the page is hidden. |
| `headers` | A client sends these headers with the request, while an engine leaves them out. |
| `timeoutMs` | A client gives the server this many milliseconds to answer, while an engine leaves the setting out. |

## The hooks

| Hook | The method behind it |
| --- | --- |
| `useQuery(indexName, params, options?)` | `query` |
| `usePreflight(indexName, params, options?)` | `preflight` |
| `useSuggest(indexName, params, options?)` | `suggest` |
| `useDocument(indexName, docId, options?)` | `get` |
| `useDocuments(indexName, params?, options?)` | `listDocuments` |
| `useIndexes(options?)` | `listIndexes` |
| `useStats(indexName, options?)` | `getStats` |
| `useTask(taskId, options?)` | `getTask`, polled, under a client alone |
| `useTasks(query?, options?)` | `listTasks`, under a client alone |
| `useImport(indexName, options?)` | `startImport` and `getTask`, under a client alone |

`useNarsilClient` returns the client that the provider holds, for every method that has no hook of its own, such as a write.

```tsx
const client = useNarsilClient()
const onSave = useCallback(() => client.put('movies', id, document), [client, id, document])
```

`useDocument` returns `undefined` with no failure for a document that the index does not hold, so check `isLoading` to tell an empty answer from one that is still on its way. Passing no id switches the hook off, which suits a detail panel until somebody picks a row.

## One request for the whole tree

Two components that ask for the same thing under one provider send one request and read one answer. The provider gives each set of arguments a key and sends one request per key, so a header, a filter, or a page size that differs starts a request of its own.

The provider keeps an answer for two seconds after the last component that reads it unmounts, which is the interval within which [SWR dedupes requests](https://swr.vercel.app/docs/api). That wait covers the gap that React leaves between unmounting a component and mounting it again, so a development double render and a quick navigation back each send one request. Set `keepAliveMs` on the provider for a longer or a shorter wait.

Once the wait passes with no component reading the key, the provider drops the answer and aborts the request behind it.

## Searching as somebody types

Pass the term straight in, and set `keepPreviousData` so that the list stays in place between answers.

```tsx
function Search() {
  const [term, setTerm] = useState('')
  const deferred = useDeferredValue(term)
  const { data, isFetching } = useQuery(
    'movies',
    { term: deferred, limit: 20 },
    { enabled: deferred.length > 1, keepPreviousData: true },
  )

  return (
    <>
      <input value={term} onChange={event => setTerm(event.target.value)} />
      <ol style={{ opacity: isFetching ? 0.6 : 1 }}>{data?.hits.map(hit => <Hit key={hit.id} hit={hit} />)}</ol>
    </>
  )
}
```

`useDeferredValue` keeps the input responsive while React renders the results. The `enabled` setting holds back the first request until the term has two characters. An answer that reaches the hook after a newer one never replaces it, however slowly the server answers.

## Loading a corpus

`useImport` sends the documents and asks the server to load them as a task. The hook then polls that task until the task ends.

```tsx
function Importer({ documents }: { documents: AnyDocument[] }) {
  const { start, cancel, progress, result, error, isImporting } = useImport('movies')

  const onImport = useCallback(() => {
    start(documents).catch(() => undefined)
  }, [start, documents])

  return (
    <>
      <button onClick={onImport} disabled={isImporting}>Import</button>
      {isImporting && <button onClick={cancel}>Stop</button>}
      {progress && <progress value={progress.bytesProcessed} max={progress.bytesTotal} />}
      {result && <p>{result.indexed} indexed, {result.failed} refused</p>}
      {error && <p role="alert">{error.message}</p>}
    </>
  )
}
```

`start` returns once the server has received the body and started the task. Where the server refuses the corpus, `start` throws the server's own failure and the hook reports it in `error`, so catch the error from the call that you await. Once the task starts, the hook polls it every 250 ms, which matches how often the server updates the figures. The hook stops polling once the task succeeds, fails, or ends in a cancellation. While the server is failing, the hook waits five seconds between attempts.

`task` holds the record from the moment the server starts the task, while `progress` and `result` are two of its fields. `onSettled` fires once, on the final record. `cancel` aborts the upload while the browser is still sending the corpus, and after that it asks the server to stop the task. `reset` clears the record and the failure, ready for another load.

Unmounting the component stops the polling alone, because the server finishes the load either way. Follow the load again with `useTask`, under the id that `start` returns.

The server refuses a body over its `maxImportBytes` limit, 100 MB by default, with `PAYLOAD_TOO_LARGE`, so send a larger corpus in several calls.

## Following any task

`useTask` polls a task until the task reaches a final status, and then it stops.

```tsx
const { data: task } = useTask(taskId)
```

A failed task comes back as a record with its `error` field set, because a part-finished import still reports what it indexed, so check `task.status`. The hook reports `null` for a record that the server no longer holds, then stops polling.

The hook pauses polling while the page is hidden, and it fetches the figures once as soon as the page is visible again.

## Keys and arguments

A hook builds the key for its request from the method name and the arguments, encoded the way that the client sends them. The order of an object's keys makes no difference to the key. A field set to `undefined` gives the same key as an absent field. A `Float32Array` gives the key of the numbers that it holds. Float32 rounding changes some of those numbers, so the same vector as a plain array of numbers can give a different key. Pass a query vector in one form wherever two components need to share a request.

A hook throws `CONFIG_INVALID` as it renders for an argument that an HTTP request cannot express, under an engine as well as under a client. That covers a function, a symbol, an object that refers back to itself, and more than 32 levels of nesting.

A hook that receives the same object between renders, through `useMemo` or a constant, reuses the key that it built for that object. The parameters of a search are small, so the saving matters only for a raw query vector of a thousand dimensions or more.

## Errors

A hook reports every failure as a `NarsilError`, under the code that the server sent or that the engine threw, so a branch written against one source works unchanged against the other.

```tsx
const { error } = useQuery('movies', params)
if (error?.code === ErrorCodes.INDEX_NOT_FOUND) return <CreateIndexPrompt />
```

Under a client, the six client codes in the [client guide](client.md#errors) reach a hook as well. The hook reports `CLIENT_CONNECTION_FAILED` for a request that the browser fails to send, and `CLIENT_UNEXPECTED_ERROR` for a failure that the client cannot attribute to the server. After a failure, `data` keeps the last answer, while the next success clears `error`.

A hook called outside a `NarsilProvider` throws `CONFIG_INVALID` as it renders.

## Credentials in a browser

Anybody who reads the bundle can read the key that a browser client sends. Point the client at a path on your own origin, such as `/search-api`, and let your own server add the key as it passes the request on. The [HTTP server guide](http-server.md) covers the `onRequest` hook, where the Narsil server checks that key.
