# Narsil Go client

`github.com/assetcorp/narsil/packages/go` calls a Narsil search server, or every node of a Narsil cluster, from Go 1.26 or later. It holds a typed method for every route that the server documents in its OpenAPI file, and it depends on the standard library alone.

```bash
go get github.com/assetcorp/narsil/packages/go
```

```go
client, err := narsil.New(narsil.Config{URLs: []string{"http://localhost:9876"}})
if err != nil {
	return err
}
results, err := client.Query(ctx, "movies", narsil.HTTPQueryParams{Term: narsil.Ptr("matrix")})
```

When you list several addresses, the client moves a read to the next node after a refused connection, a timeout, or an answer of 502, 503, or 504. It moves a write only when the request never left the client or when the node answers `NODE_NOT_READY`, so the client never sends a second copy of a write that a node may have applied. Every failure comes back as a `*narsil.Error`, under the code that the server sent or under a `CLIENT_` code for a failure on this side.

[The Go client guide](https://github.com/assetcorp/narsil/blob/main/docs/go-client.md) covers the settings, the helpers, streaming a snapshot or an export, and the failover rules in full.
