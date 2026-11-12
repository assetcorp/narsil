# Python client

`narsil-client` reaches a Narsil server, or every node of a Narsil cluster, from Python 3.11 or later. It holds one typed method for every route in the server's OpenAPI file, under the route's name in snake case, so `createIndex` becomes `create_index`. `NarsilClient` blocks on each call, while `AsyncNarsilClient` offers the same methods as coroutines that you can await under asyncio or trio.

```bash
pip install narsil-client
```

The package depends on `httpx`, `pydantic`, and `anyio`, and it needs no NumPy, although it sends a NumPy array in a document as the list of numbers that it holds.

```python
from narsil_client import NarsilClient

with NarsilClient("http://localhost:9876") as client:
    client.create_index({"name": "movies", "config": {"schema": {"title": "string", "year": "number"}}})
    client.insert("movies", {"id": "the-matrix", "document": {"title": "The Matrix", "year": 1999}})
    results = client.query("movies", {"term": "matrix"})
    print([hit.id for hit in results.hits])
```

Every method that takes a body accepts either a plain dictionary in the server's JSON field names or the Pydantic model that the client generates for it, which you import from `narsil_client.models`. Every answer comes back as one of those models, with its fields in snake case.

```python
import anyio
from narsil_client import AsyncNarsilClient

async def main() -> None:
    async with AsyncNarsilClient(["http://10.0.0.1:9876", "http://10.0.0.2:9876"]) as client:
        results = await client.query("movies", {"term": "matrix"}, timeout_ms=2000)
        print(results.count)

anyio.run(main)
```

## Settings

Only the address is required. Every other setting is a keyword argument, and both forms of the client take the same ones.

| Setting | What it does |
| --- | --- |
| `url` | The server answers at this `http` or `https` address. Pass a list, such as one address for every node in a cluster, so that the client can move a request to the next node when one fails. An empty list, or an address of any other scheme, raises `CONFIG_INVALID`. |
| `api_key` | The client sends this as `authorization: Bearer <key>`, which a server reads in its `onRequest` hook. |
| `headers` | The client sends these headers with every request, and a header of the same name on one call replaces one. |
| `timeout_ms` | The client waits this many milliseconds for each try, and 30,000 unless you say otherwise. Pass 0 so that it waits for as long as the server takes. |
| `max_response_bytes` | The client stops reading an answer past this many bytes and raises `CLIENT_INVALID_RESPONSE`. It reads whatever the server sends unless you set this. |
| `url_skip_ms` | After an address refuses a connection, the client skips it for this many milliseconds, 1,000 unless you say otherwise, and twice as long after each further refusal. |
| `max_url_skip_ms` | The client never skips an address for longer than this, 30,000 milliseconds unless you say otherwise. |
| `http_client` | The client sends through this `httpx.Client`, or `httpx.AsyncClient` for the async form, which is how you add a proxy or custom certificates. The client leaves a client that you pass open when it closes. |

Every method also takes `timeout_ms`, `headers`, and `max_response_bytes` as keyword arguments for one call. The client holds a pool of connections, so keep one client for the lifetime of the application, and close it with a `with` block or with `close_connections()`. One `NarsilClient` is safe to share between threads.

The methods that move a corpus or a whole index wait for as long as the server takes unless you set `timeout_ms` on the client or on the call. Those are `import_ndjson`, the `import_documents` and `start_import` helpers that call it, `snapshot`, `restore`, `export_documents`, and `import_document_export`. Under the async client, cancel the task or the scope that awaits a call to stop it, and the cancellation reaches your code unchanged.

## Failover

The client starts each request on the address after the one that took the previous request, so that requests spread across the nodes. It moves a request to the next address only where sending it again cannot store anything twice.

A read is a `GET`, or a route that the server marks as repeatable, such as a search, a suggestion, a document list, and a `_multi-get`. A read moves to the next address after a refused connection, a broken connection, a timeout, or an answer of 502, 503, or 504. Once every address has failed that way, the client sends the read once more, so a client with N addresses can send N + 1 requests.

A write moves to the next address in two cases alone: when the connection failed before any byte of the request left the client, such as a refused connection or a name that did not resolve, and when the node refused the write with `NODE_NOT_READY`. A write that reached a node can have taken effect there, so a timeout or a broken connection raises the error to you and the client sends nothing more. A body that you pass as a file or an iterator goes to one address, because the client cannot read it twice.

## Errors

Every failure raises `NarsilError`, under the code that the server sent, so a branch that you write against a code works whichever node answered. `details` holds the values that the server sent, and `status` holds the HTTP status.

```python
from narsil_client import NarsilError

try:
    client.insert("movies", {"document": {"title": 42}})
except NarsilError as error:
    if error.code == "DOC_VALIDATION_FAILED":
        print(error.message, error.details, error.status)
```

Four codes come from the client itself, and no server sends one. `ClientErrorCodes` holds each of them.

| Code | The client raises it when |
| --- | --- |
| `CLIENT_CONNECTION_FAILED` | The client could not reach the server, or the connection broke before the answer arrived. |
| `CLIENT_REQUEST_TIMEOUT` | The deadline passed before the answer arrived. |
| `CLIENT_INVALID_RESPONSE` | The answer held no Narsil error envelope or not the shape that the route documents, which is what the HTML error page of a proxy produces, or it passed `max_response_bytes`. |
| `CLIENT_TASK_TIMEOUT` | `wait_for_task` passed `wait_timeout_ms` while the task kept running. |

The client raises `CONFIG_INVALID` before it sends anything when a setting is out of range, such as an empty list of addresses. `get` returns `None` for an unknown document, and `get_task` returns `None` once the server no longer holds the record. Every other failure raises.

## Loading documents

`import_documents` encodes a list of documents as NDJSON, sends them in one request, and returns once the whole load has finished. It also takes a string or bytes of NDJSON, which it sends unchanged.

```python
result = client.import_documents("movies", documents)
print(result.indexed, result.failed, result.errors)
```

One bad record never abandons the rest, because the server notes each failure and carries on. Where a load would outlast the response timeout of a proxy, start a task and follow it instead.

```python
task = client.start_import("movies", documents)
finished = client.wait_for_task(task.id, on_progress=lambda record: print(record.progress))
print(finished.status)
```

`insert_batch`, `update_batch`, and `remove_batch` each write many documents in one request, and they return the ids that the server wrote along with every refusal.

## Following a task

`wait_for_task` polls a task until it reaches `succeeded`, `failed`, or `cancelled`, then returns the record it ended on. A failed task comes back with its `error` set and raises nothing, because a part-finished import still reports what it indexed, so read the status of the record that you get back.

| Argument | What it does |
| --- | --- |
| `poll_interval_ms` | The client waits this many milliseconds between polls, 250 unless you say otherwise. |
| `wait_timeout_ms` | The wait raises `CLIENT_TASK_TIMEOUT` after this long while the task keeps running. It waits for as long as the task takes unless you set this. |
| `on_progress` | The client calls this each time the record changes, and never twice for the same figures. |

The wait raises `TASK_NOT_FOUND` when the server drops the record before the task ends.

## Snapshots and exports

`snapshot` and `export_documents` return a `ResponseStream`, or an `AsyncResponseStream` under the async client, that yields the body in chunks as it arrives. The client never holds the whole body in memory, so you can write an index of any size to a file. Use the stream as a context manager, so that the connection closes when you stop reading early.

```python
with client.snapshot("movies") as archive, open("movies.tar", "wb") as sink:
    for chunk in archive:
        sink.write(chunk)

with open("movies.tar", "rb") as upload:
    task = client.restore("movies", upload)
client.wait_for_task(task.id)
```

`restore` and `import_document_export` take bytes, a file opened in binary mode, or an iterable of byte chunks, and the async client also takes an async iterable. The client reads a file in chunks of 64 KiB as it sends them.

## Following changes

`update_changes` and `get_changes` turn [change capture](change-capture.md) on for an index and report its epoch. `follow_changes` follows the server's change feed, and it needs the `changes` extra, which adds the WebSocket and MessagePack libraries. The client imports them only when you call `follow_changes`, so a program that never follows a feed can leave the extra out, and a call without it raises `CONFIG_INVALID` with the install command.

```bash
pip install "narsil-client[changes]"
```

```python
from narsil_client import ChangesBatch, ChangesResync

with client.follow_changes("orders", epoch=saved.epoch, positions=saved.positions, credential=token) as subscription:
    for event in subscription:
        if isinstance(event, ChangesBatch):
            apply(event.changes)
            save(event.position)
            subscription.ack([event.position])
        elif isinstance(event, ChangesResync):
            rebuild_from_export()
```

Leave `epoch` and `positions` out to start at the index's current heads, or pass the epoch and the positions from the header of a document export. Save each batch's position once you have applied its changes, and acknowledge only saved positions, because the server pauses the feed while the changes that you have not acknowledged pass its window. The client keeps the highest acknowledged position of every partition and sends all of them with each acknowledgement. After a `ChangesResync`, take a document export of the index, replace your copy with its documents, and follow from the epoch and the positions in its header.

The async client returns a subscription that connects when you enter it with `async with`, and you iterate it with `async for` and await `ack`. It works under asyncio and trio. The credential travels as a second WebSocket subprotocol, and the client writes it into no error. The feed refuses redirects, as the HTTP requests do, because a redirect to another host would carry the credential there. A subscription that ends raises `NarsilError`: `CHANGES_NOT_ENABLED` when capture turns off, the code in the close reason when the index's setting refuses the subscription, `CONFIG_INVALID` when the server refuses a message, and `CLIENT_CONNECTION_FAILED` with the `close_code` in its details for anything else, such as an expired credential.

A vector in a change arrives as a list of floats, whichever form the engine stored it in. The client reads a binary value as a vector only at a path in the `vector_fields` of `ChangesSubscribed`, and it returns every other binary value as `bytes`.

## Asking what a server serves

`is_alive` and `is_ready` return `True` for an answer of 200 and `False` for any other answer, so `is_ready` returns `False` while a server starts up and once it starts draining, because the server answers 503 then. Both raise when no server answers at all. `supports` reports whether the server serves an optional route, and the client reads the list once and keeps it.

```python
from narsil_client import DOCUMENT_EXPORT_CAPABILITY

if client.supports(DOCUMENT_EXPORT_CAPABILITY):
    stream = client.export_documents("movies")
```

## Every method

A generator writes a method for every operation in [`packages/ts/openapi.json`](../packages/ts/openapi.json), and it copies each description into the docstring that your editor shows. Continuous integration regenerates the client and fails when the committed code differs, so the pull request that adds a route to the server also adds its method to the client. The [HTTP server guide](http-server.md) covers what each route does, and the [cluster guide](cluster.md) covers the routes that a cluster serves.

The client calls the two HTTP routes of [device sync](device-sync.md) through `update_sync`, which replaces the sync setting of an index, and `sync_snapshot`, which returns the published snapshot as a `ResponseStream`, or an `AsyncResponseStream` under the async client. Pass `Range` and `If-Range` through `headers` to resume a download. The sync feed at `GET /indexes/{name}/sync/feed` is a WebSocket, so the OpenAPI file describes no route for it and the client has no method for it. A device reads the feed through `@delali/narsil/sync`.
