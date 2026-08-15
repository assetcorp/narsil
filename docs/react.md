# React

`@delali/narsil/react` gives a React application the client's methods as hooks. Each hook sends one request and reports where that request stands. It sends the request again whenever its arguments change.

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

React is an optional peer dependency at 19.2 or later, and no other entry point imports it. The hooks import no Node built-in, so they run in a browser. On a server they render as loading and send nothing.

Build the client outside the component tree. A client built during a render would be a new client on every render, and every hook under it would start again.

## What a read hook gives you

Every hook that reads returns the same five fields.

| Field | What it holds |
| --- | --- |
| `data` | This is the answer, and it stays `undefined` until the first one arrives. |
| `error` | This is the `NarsilError` the last request ended on, and the next success clears it. |
| `isLoading` | This is true while the hook waits with nothing to show, so a spinner branches on this one. |
| `isFetching` | This is true while any request runs, a refresh included, so an indicator that dims the list branches on this one. |
| `refresh` | Calling it asks the server again, and the answer already on screen stays until the new one arrives. |

Every hook takes the same settings as its last argument.

| Setting | What it does |
| --- | --- |
| `enabled` | The hook sends nothing while this is false, which is how a search waits for a term. A request already in flight stops when its key does. |
| `keepPreviousData` | The hits already on screen stay there while the next answer loads. |
| `refreshIntervalMs` | The hook asks again this often, and it pauses while the page is hidden. |
| `headers` | The hook sends these with its request. |
| `timeoutMs` | The hook gives the server this many milliseconds to answer. |

## The hooks

| Hook | The client method behind it |
| --- | --- |
| `useQuery(indexName, params, options?)` | `query` |
| `usePreflight(indexName, params, options?)` | `preflight` |
| `useSuggest(indexName, params, options?)` | `suggest` |
| `useDocument(indexName, docId, options?)` | `get` |
| `useDocuments(indexName, params?, options?)` | `listDocuments` |
| `useIndexes(options?)` | `listIndexes` |
| `useStats(indexName, options?)` | `getStats` |
| `useTask(taskId, options?)` | `getTask`, polled |
| `useTasks(query?, options?)` | `listTasks` |
| `useImport(indexName, options?)` | `startImport` and `getTask` |

`useNarsilClient` returns the client the provider holds, which covers every method that has no hook of its own, such as a write.

```tsx
const client = useNarsilClient()
const onSave = useCallback(() => client.put('movies', id, document), [client, id, document])
```

`useDocument` answers with `undefined` for a document the index does not hold, and it reports no failure, so read `isLoading` to tell an empty answer from one still on its way. Passing no id switches the hook off, which is what a detail panel does until somebody picks a row.

## One request for the whole tree

Two components asking for the same thing under one provider send one request and read one answer. The provider gives each set of arguments a key, and one key holds one request. A header, a filter, or a page size that differs therefore gives a request of its own.

The provider keeps an answer for two seconds after the last component reading it unmounts, which is the interval [SWR dedupes requests within](https://swr.vercel.app/docs/api). That wait covers the gap React leaves between unmounting a component and mounting it again, so a development double render and a quick navigation back each send one request rather than two. Set `keepAliveMs` on the provider for a longer or a shorter wait.

Once the wait passes with nothing reading the key, the provider forgets the answer and stops the request behind it.

## Searching as somebody types

Pass the term straight in, and set `keepPreviousData` so that the list holds still between answers.

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

`useDeferredValue` keeps the input responsive while React renders the results, and `enabled` holds the first request back until the term is worth searching for. An answer that reaches the hook after a newer one never replaces it, however slowly the server answered.

## Loading a corpus

`useImport` sends the documents and asks the server to load them as a task. It then follows that task to the end.

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

`start` returns once the server has read the body and taken the work on. Where the server refuses the corpus, `start` throws the server's own failure and the hook reports it in `error`, so catch the one you await. From then on the hook asks every 250 ms, which is how often the server writes the figures. It stops as soon as the load succeeds, fails, or is cancelled, and it leaves five seconds between attempts while the server is failing.

`task` holds the record from the moment the server takes the load on, and `progress` and `result` read two of its fields. `onSettled` fires once, on the final record. `cancel` stops the upload while the corpus is still going up, and asks the server to stop the task after that. `reset` clears the record and the failure, ready for another load.

Unmounting the component stops the polling alone, because the server finishes the load either way. Follow it again with `useTask`, under the id `start` returned.

The server refuses a body over its `maxImportBytes` limit, 100 MB by default, with `PAYLOAD_TOO_LARGE`. Send a larger corpus in several calls.

## Following any task

`useTask` asks about a task while it is queued or running, and it stops once the task reaches a final status.

```tsx
const { data: task } = useTask(taskId)
```

A failed task comes back with its `error` set rather than as a thrown failure, because a part-finished import still reports what it indexed, so read `task.status`. The hook reports `null` for a record the server no longer holds, and it stops asking.

Polling pauses while the page is hidden, and it reads the figures once as soon as the page comes back, so a background tab asks for nothing nobody is reading.

## Keys and arguments

A hook identifies its request by the method name and the arguments, read the way the client sends them: the order the object keys were written in makes no difference, a field set to `undefined` reads the same as an absent one, and a query vector reads the same as a number array or a `Float32Array`.

The hook refuses an argument an HTTP request cannot express, and it throws `CONFIG_INVALID` as it renders. It refuses a function, a symbol, an object that holds a reference back to itself, and more than 32 levels of nesting.

A hook that receives the same object between renders, through `useMemo` or a constant, reuses the key instead of building it again. The parameters a search sends are small, so that saving shows only with a raw query vector of a thousand dimensions or more.

## Errors

Every failure comes back as a `NarsilError` under the code the server sent, so a branch written against an embedded engine works here unchanged.

```tsx
const { error } = useQuery('movies', params)
if (error?.code === ErrorCodes.INDEX_NOT_FOUND) return <CreateIndexPrompt />
```

The six client codes in the [client guide](client.md#errors) reach a hook as well, so a hook reports `CLIENT_CONNECTION_FAILED` for a request the browser could not send, and `CLIENT_UNEXPECTED_ERROR` for a failure it cannot place at all. A failure leaves whatever the hook already showed on screen, and the next success clears it.

A hook that runs outside a `NarsilProvider` throws `CONFIG_INVALID` as it renders.

## Credentials in a browser

Anybody reading the bundle can read the key a browser client was built with. Point the client at a path on your own origin, such as `/search-api`, and let your own server add the key as it passes the request on. The [HTTP server guide](http-server.md) covers the `onRequest` hook that server reads it in.
