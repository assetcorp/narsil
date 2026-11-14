# Narsil Go client

`github.com/assetcorp/narsil/packages/go` calls a Narsil search server, or every node of a Narsil cluster, from Go 1.26 or later. It holds a typed method for every route that the server documents in its OpenAPI file, and it depends on the standard library alone, so it builds without cgo or a C compiler.

To search an index inside a Go process with no server, use [the Go engine](https://github.com/assetcorp/narsil/tree/main/packages/go/engine) at `github.com/assetcorp/narsil/packages/go/engine`. The two modules carry separate version tags: this client's releases carry tags of the form `packages/go/vX.Y.Z`, while the engine's carry `packages/go/engine/vX.Y.Z`. The change feed subscriber at `github.com/assetcorp/narsil/packages/go/changes` carries `packages/go/changes/vX.Y.Z`, and each of its releases requires the newest client release, so the release workflow refuses it while the client on `main` holds changes that no client release includes.

```bash
go get github.com/assetcorp/narsil/packages/go
```

```go
package main

import (
	"context"
	"fmt"
	"log"

	narsil "github.com/assetcorp/narsil/packages/go"
)

func main() {
	client, err := narsil.New(narsil.Config{URLs: []string{"http://localhost:9876"}})
	if err != nil {
		log.Fatal(err)
	}
	results, err := client.Query(context.Background(), "movies", narsil.HTTPQueryParams{Term: narsil.Ptr("matrix")})
	if err != nil {
		log.Fatal(err)
	}
	for _, hit := range results.Hits {
		fmt.Println(hit.ID)
	}
}
```

The program prints the ID of every hit for `matrix` in the `movies` index of a Narsil server on port 9876, such as the [HTTP server example](https://github.com/assetcorp/narsil/tree/main/packages/ts/examples/http-server) started with `NARSIL_PORT=9876`.

When you list several addresses, the client moves a read to the next node after a refused connection, a timeout, or an answer of 502, 503, or 504. It moves a write only when the request never left the client or when the node answers `NODE_NOT_READY`, so the client never sends a second copy of a write that a node may have applied. Every failure comes back as a `*narsil.Error`, under the code that the server sent or under a `CLIENT_` code for a failure on this side.

[The Go client guide](https://github.com/assetcorp/narsil/blob/main/docs/go-client.md) covers the settings, the helpers, streaming a snapshot or an export, and the failover rules in full.

## License

Apache-2.0
