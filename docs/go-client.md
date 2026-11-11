# Go client

The Go module `github.com/assetcorp/narsil/packages/go` reaches a Narsil server, or every node of a Narsil cluster, from Go 1.26 or later. It holds one typed method for every route in the server's OpenAPI file, under the route's name in Go form, so `createIndex` becomes `CreateIndex`. It depends on the standard library alone.

```bash
go get github.com/assetcorp/narsil/packages/go
```

```go
import narsil "github.com/assetcorp/narsil/packages/go"

client, err := narsil.New(narsil.Config{URLs: []string{"http://localhost:9876"}})
if err != nil {
	return err
}
defer client.CloseIdleConnections()

_, err = client.CreateIndex(ctx, narsil.HTTPCreateIndexBody{
	Name: "movies",
	Config: narsil.HTTPIndexBody{Schema: narsil.SchemaDefinition{
		"title": {FieldType: narsil.Ptr(narsil.FieldTypeString)},
		"year":  {FieldType: narsil.Ptr(narsil.FieldTypeNumber)},
	}},
})
if err != nil {
	return err
}
_, err = client.Insert(ctx, "movies", narsil.InsertBody{
	ID:       narsil.Ptr("the-matrix"),
	Document: narsil.AnyDocument{"title": "The Matrix", "year": 1999},
})
if err != nil {
	return err
}
results, err := client.Query(ctx, "movies", narsil.HTTPQueryParams{Term: narsil.Ptr("matrix")})
```

Every method takes a `context.Context` first and any number of `CallOption` values last. One `Client` is safe to use from many goroutines at once, so keep one for the lifetime of the application.

## Types

The generator turns every schema in the OpenAPI file into a named Go type and copies each description into its doc comment. An optional field is a pointer, which `narsil.Ptr` fills, or a slice or a map that you leave nil. A field that the server accepts as `null` and that you can also leave out is a `narsil.Nullable[T]`, so `narsil.Null[T]()` sends `null`, `narsil.Value(v)` sends a value, and the zero value leaves the field out.

A field that takes one of several shapes is a struct with one field for each shape, such as `FieldType` and `SchemaDefinition` on `SchemaDefinitionValue`. Set exactly one of them before you send it, because the client refuses a value with none set or with two set. When the client reads one, it sets the field whose shape matches the JSON. A string with a fixed set of values is a named string type with a constant for each value, such as `narsil.FieldTypeString`.

## Settings

Only `URLs` is required in `narsil.Config`.

| Field | What it does |
| --- | --- |
| `URLs` | The server answers at each of these `http` or `https` addresses. List every node in a cluster so that the client can move a request to the next node when one fails. An empty list, or an address of any other scheme, fails with `CONFIG_INVALID`. |
| `APIKey` | The client sends this as `Authorization: Bearer <key>`, which a server reads in its `onRequest` hook. |
| `Headers` | The client sends these headers with every request. |
| `Timeout` | The client waits this long for each try, and 30 seconds unless you set it. `narsil.NoTimeout` waits for as long as the server takes. |
| `MaxResponseBytes` | The client stops reading an answer past this many bytes and fails with `CLIENT_INVALID_RESPONSE`. Zero reads whatever the server sends. |
| `URLSkip` | After an address refuses a connection, the client skips it for this long, one second unless you set it, and twice as long after each further refusal. |
| `MaxURLSkip` | The client never skips an address for longer than this, 30 seconds unless you set it. |
| `HTTPClient` | The client sends through this `*http.Client`, which is how you add a proxy or custom certificates. Leave the `Timeout` of that `http.Client` at zero, because the client bounds each try through the context. The client that `New` builds follows no redirects. |

`narsil.WithTimeout`, `narsil.WithHeader`, and `narsil.WithMaxResponseBytes` change one call.

```go
results, err := client.Query(ctx, "movies", narsil.HTTPQueryParams{Term: narsil.Ptr("matrix")},
	narsil.WithTimeout(2*time.Second))
```

The methods that move a corpus or a whole index wait for as long as the server takes unless you set `Timeout` or `WithTimeout`. Those are `ImportNDJSON`, the `ImportDocuments` and `StartImport` helpers that call it, `Snapshot`, `Restore`, `ExportDocuments`, and `ImportDocumentExport`. The context of the call bounds every method. A context that you cancel fails the call with `CLIENT_REQUEST_ABORTED`, while a context deadline that passes fails it with `CLIENT_REQUEST_TIMEOUT`. In both cases the client sends nothing more.

## Failover

The client starts each request on the address after the one that took the previous request, so that requests spread across the nodes. It moves a request to the next address only where sending it again cannot store anything twice.

A read is a `GET`, or a route that the server marks as repeatable, such as a search, a suggestion, a document list, and a `_multi-get`. A read moves to the next address after a refused connection, a broken connection, a timeout, or an answer of 502, 503, or 504. Once every address has failed that way, the client sends the read once more, so a client with N addresses can send N + 1 requests.

A write moves to the next address in two cases alone: when the dial failed before any byte of the request left the client, such as a refused connection or a name that did not resolve, and when the node refused the write with `NODE_NOT_READY`. A write that reached a node can have taken effect there, so a timeout or a broken connection returns the error to you and the client sends nothing more.

A body that you pass as a `*bytes.Reader`, a `*bytes.Buffer`, or a `*strings.Reader` can go to a second address. Any other `io.Reader`, such as an `*os.File`, goes to one address alone, because the client cannot read it twice.

## Errors

Every failure comes back as a `*narsil.Error`, under the code that the server sent, so a branch that you write against a code works whichever node answered. `narsil.ErrorCode(err)` returns the code, and the empty string when the error holds no `*narsil.Error`, such as a value that the client could not encode as JSON.

```go
_, err := client.Insert(ctx, "movies", narsil.InsertBody{Document: narsil.AnyDocument{"title": 42}})
var failure *narsil.Error
if errors.As(err, &failure) && failure.Code == "DOC_VALIDATION_FAILED" {
	log.Println(failure.Message, failure.Details, failure.Status)
}
```

`Status` holds the HTTP status, and 0 where no answer arrived. Five codes come from the client itself, and no server sends one.

| Constant | Code | The client returns it when |
| --- | --- | --- |
| `CodeClientConnectionFailed` | `CLIENT_CONNECTION_FAILED` | The client could not reach the server, or the connection broke before the answer arrived. |
| `CodeClientRequestTimeout` | `CLIENT_REQUEST_TIMEOUT` | The deadline passed before the answer arrived. |
| `CodeClientRequestAborted` | `CLIENT_REQUEST_ABORTED` | You cancelled the context of the call. |
| `CodeClientInvalidResponse` | `CLIENT_INVALID_RESPONSE` | The answer held no Narsil error envelope or not the shape that the route documents, which is what the HTML error page of a proxy produces, or it passed `MaxResponseBytes`. |
| `CodeClientTaskTimeout` | `CLIENT_TASK_TIMEOUT` | `WaitForTask` passed `WaitTimeout` while the task kept running. |

`Get` returns a nil document for an unknown id, and `GetTask` returns a nil record once the server no longer holds it. Every other failure returns an error.

## Loading documents

`ImportDocuments` encodes the documents as NDJSON, sends them in one request, and returns once the whole load has finished. `ImportNDJSON` sends NDJSON that you already hold or stream from a file.

```go
result, err := client.ImportDocuments(ctx, "movies", []narsil.AnyDocument{
	{"id": "alien", "title": "Alien", "year": 1979},
})
if err != nil {
	return err
}
log.Println(result.Indexed, result.Failed)
```

One bad record never abandons the rest, because the server notes each failure and carries on. Where a load would outlast the response timeout of a proxy, call `StartImport` and follow the task that it returns. `InsertBatch`, `UpdateBatch`, and `RemoveBatch` each write many documents in one request, and they return the ids that the server wrote along with every refusal.

## Following a task

`WaitForTask` polls a task until it reaches `succeeded`, `failed`, or `cancelled`, then returns the record it ended on. A failed task comes back with its `Error` set and a nil Go error, because a part-finished import still reports what it indexed, so read the `Status` of the record.

| `narsil.WaitOptions` field | What it does |
| --- | --- |
| `PollInterval` | The client waits this long between polls, 250 milliseconds unless you set it. |
| `WaitTimeout` | The wait fails with `CLIENT_TASK_TIMEOUT` after this long while the task keeps running. The context alone bounds the wait unless you set this. |
| `OnProgress` | The client calls this each time the record changes, and never twice for the same figures. |

The wait fails with `TASK_NOT_FOUND` when the server drops the record before the task ends.

## Snapshots and exports

`Snapshot` and `ExportDocuments` return a `*narsil.ResponseStream`, which is an `io.ReadCloser` over the body as it arrives. The client never holds the whole body in memory, so `io.Copy` writes an index of any size to a file. Close the stream when you finish, so that the client can release the connection.

```go
archive, err := client.Snapshot(ctx, "movies", narsil.SnapshotParams{})
if err != nil {
	return err
}
file, err := os.Create("movies.tar")
if err != nil {
	archive.Close()
	return err
}
_, err = io.Copy(file, archive)
archive.Close()
file.Close()
if err != nil {
	return err
}

upload, err := os.Open("movies.tar")
if err != nil {
	return err
}
defer upload.Close()
task, err := client.Restore(ctx, "movies", upload)
if err != nil {
	return err
}
finished, err := client.WaitForTask(ctx, task.ID, narsil.WaitOptions{})
```

`Restore` and `ImportDocumentExport` take any `io.Reader`, and the client sends the bytes as it reads them, so an archive on disk never has to fit in memory.

## Asking what a server serves

`IsAlive` and `IsReady` return true for an answer of 200 and false for any other answer, so `IsReady` returns false while a server starts up and once it starts draining, because the server answers 503 then. Both return an error when no server answers at all. `Supports` reports whether the server serves an optional route, and the client reads the list once and keeps it.

```go
exports, err := client.Supports(ctx, narsil.CapabilityDocumentExport)
if err != nil {
	return err
}
if exports {
	stream, err := client.ExportDocuments(ctx, "movies")
	if err != nil {
		return err
	}
	defer stream.Close()
}
```

## Every method

A generator writes a method for every operation in [`packages/ts/openapi.json`](../packages/ts/openapi.json). Continuous integration regenerates the client and fails when the committed code differs, so the pull request that adds a route to the server also adds its method to the client. The [HTTP server guide](http-server.md) covers what each route does, and the [cluster guide](cluster.md) covers the routes that a cluster serves.

The client calls the two HTTP routes of [device sync](device-sync.md) through `UpdateSync`, which replaces the sync setting of an index, and `SyncSnapshot`, which returns the published snapshot as a `*narsil.ResponseStream`. Pass `narsil.WithHeader("Range", ...)` and `narsil.WithHeader("If-Range", ...)` to resume a download. The sync feed at `GET /indexes/{name}/sync/feed` is a WebSocket, so the OpenAPI file describes no route for it and the client has no method for it. A device reads the feed through `@delali/narsil/sync`.

Each release of the module carries a tag of the form `packages/go/vX.Y.Z`, which is the form that `go get` reads for a module in a subdirectory.
