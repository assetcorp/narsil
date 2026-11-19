# Run Narsil in a container

The image `ghcr.io/assetcorp/narsil` serves one Narsil node over HTTP and takes every setting from an environment variable, so you can start a search server without writing any code. This guide starts a node with Docker Compose, creates an index, adds documents to it, and searches them over HTTP. It then connects the TypeScript, Python, and Go clients to the node, and it restarts the node to show that the documents stay on its volume.

You need Docker with the Compose plugin, `curl`, and `openssl`. The client sections also need Node.js 22 or later, Python 3.11 or later, and Go 1.26 or later. Each client section stands alone, so you can skip the languages that you don't use.

## Start a node

Create a folder for the node, download the Compose file into it, and write an admin key to `.env`:

```bash skip
mkdir narsil && cd narsil
curl -fsSLO https://raw.githubusercontent.com/assetcorp/narsil/main/packages/container/compose.yaml
export NARSIL_ADMIN_KEY="$(openssl rand -hex 32)"
echo "NARSIL_ADMIN_KEY=$NARSIL_ADMIN_KEY" > .env
docker compose up -d
```

The [Compose file](../packages/container/compose.yaml) pulls the image, publishes port 7700 on `127.0.0.1` alone so that only programs on your machine can reach the node, and mounts a volume called `narsil-data` at `/data`, which is the folder where the node keeps its indexes. Compose reads `NARSIL_ADMIN_KEY` from `.env` each time that you start the node from this folder, and the node refuses to start when the key holds fewer than 32 characters. The commands in this guide read the key from the shell, so load `.env` into any new terminal with `set -a; . ./.env; set +a` before you carry on.

Wait until the node reports that it is ready:

```bash skip
curl -fs --retry 30 --retry-delay 1 --retry-all-errors http://localhost:7700/readyz
```

```text skip
{"status":"ready"}
```

The node answers `/readyz`, `/livez`, `/health`, and `/version` without a key, so that an orchestrator can probe the container. Every other route needs the key in an `Authorization: Bearer` header, and the node answers 401 to a request that leaves it out.

## Add documents and search them

Create an index called `movies` with a text field and a number field:

```bash skip
curl -sS -X POST http://localhost:7700/indexes \
  -H "authorization: Bearer $NARSIL_ADMIN_KEY" \
  -H 'content-type: application/json' \
  -d '{"name":"movies","config":{"schema":{"title":"string","year":"number"}}}'
```

```text skip
{"name":"movies"}
```

Add three documents in one batch:

```bash skip
curl -sS -X POST http://localhost:7700/indexes/movies/documents/_batch \
  -H "authorization: Bearer $NARSIL_ADMIN_KEY" \
  -H 'content-type: application/json' \
  -d '{"documents":[
    {"id":"the-matrix","title":"The Matrix","year":1999},
    {"id":"the-matrix-reloaded","title":"The Matrix Reloaded","year":2003},
    {"id":"spirited-away","title":"Spirited Away","year":2001}
  ]}'
```

```text skip
{"succeeded":["the-matrix","the-matrix-reloaded","spirited-away"],"failed":[]}
```

The node writes the batch to its write-ahead log on the volume before it answers, so a restart keeps every document that the answer lists under `succeeded`. Search the titles for `matrix`:

```bash skip
curl -sS -X POST http://localhost:7700/indexes/movies/search \
  -H "authorization: Bearer $NARSIL_ADMIN_KEY" \
  -H 'content-type: application/json' \
  -d '{"term":"matrix"}'
```

```text skip
{"hits":[{"id":"the-matrix","score":0.5619608610546839,"document":{"id":"the-matrix","title":"The Matrix","year":1999}},{"id":"the-matrix-reloaded","score":0.43445713627757077,"document":{"id":"the-matrix-reloaded","title":"The Matrix Reloaded","year":2003}}],"count":2,"countExact":true,"elapsed":2.9942779999998947,"coverage":{"totalPartitions":1,"queriedPartitions":1,"timedOutPartitions":0,"failedPartitions":0}}
```

The node returns the two Matrix films, because only their titles contain the word, and it ranks them by their BM25 scores. `elapsed` gives the milliseconds that the search took on the node, so it will differ on your machine. The [HTTP server guide](http-server.md) describes every route that the node serves, including bulk imports, snapshots, and long-running tasks.

## Connect a client

Each client takes the node's address and the admin key, and it calls the same routes under the method names of its language. Start each program below from the `narsil` folder, in a terminal where `NARSIL_ADMIN_KEY` is set.

### TypeScript

```bash skip
mkdir typescript && cd typescript
npm install @delali/narsil
```

Save this program as `search.mjs`:

```ts
import { createNarsilClient } from '@delali/narsil/client'

const client = createNarsilClient({ url: 'http://localhost:7700', apiKey: process.env.NARSIL_ADMIN_KEY })
const results = await client.query('movies', { term: 'matrix' })
console.log(results.hits.map(hit => hit.id))
```

```bash skip
node search.mjs
cd ..
```

```text skip
[ 'the-matrix', 'the-matrix-reloaded' ]
```

The [client guide](client.md) covers the settings for one call, following a task, and the error codes that the client raises.

### Python

```bash skip
mkdir python && cd python
python3 -m venv .venv
.venv/bin/pip install narsil-client
```

Save this program as `search.py`:

```python
import os

from narsil_client import NarsilClient

with NarsilClient("http://localhost:7700", api_key=os.environ["NARSIL_ADMIN_KEY"]) as client:
    results = client.query("movies", {"term": "matrix"})
    print([hit.id for hit in results.hits])
```

```bash skip
.venv/bin/python search.py
cd ..
```

```text skip
['the-matrix', 'the-matrix-reloaded']
```

The [Python client guide](python-client.md) covers the async client, the failover rules, and the errors.

### Go

```bash skip
mkdir go && cd go
go mod init example.com/search
go get github.com/assetcorp/narsil/packages/go
```

Save this program as `main.go`:

```go
package main

import (
	"context"
	"fmt"
	"log"
	"os"

	narsil "github.com/assetcorp/narsil/packages/go"
)

func main() {
	client, err := narsil.New(narsil.Config{URLs: []string{"http://localhost:7700"}, APIKey: os.Getenv("NARSIL_ADMIN_KEY")})
	if err != nil {
		log.Fatal(err)
	}
	defer client.CloseIdleConnections()
	results, err := client.Query(context.Background(), "movies", narsil.HTTPQueryParams{Term: narsil.Ptr("matrix")})
	if err != nil {
		log.Fatal(err)
	}
	for _, hit := range results.Hits {
		fmt.Println(hit.ID)
	}
}
```

```bash skip
go run .
cd ..
```

```text skip
the-matrix
the-matrix-reloaded
```

The [Go client guide](go-client.md) covers the generated types, the settings for one call, and the failover rules.

## Restart the node

`docker compose down` removes the container and keeps the `narsil-data` volume. Start a new container and wait for it:

```bash skip
docker compose down
docker compose up -d
curl -fs --retry 30 --retry-delay 1 --retry-all-errors http://localhost:7700/readyz
```

```text skip
{"status":"ready"}
```

Search the new container for `matrix` again:

```bash skip
curl -sS -X POST http://localhost:7700/indexes/movies/search \
  -H "authorization: Bearer $NARSIL_ADMIN_KEY" \
  -H 'content-type: application/json' \
  -d '{"term":"matrix"}'
```

```text skip
{"hits":[{"id":"the-matrix","score":0.5619608610546839,"document":{"id":"the-matrix","title":"The Matrix","year":1999}},{"id":"the-matrix-reloaded","score":0.43445713627757077,"document":{"id":"the-matrix-reloaded","title":"The Matrix Reloaded","year":2003}}],"count":2,"countExact":true,"elapsed":3.2948010000000068,"coverage":{"totalPartitions":1,"queriedPartitions":1,"timedOutPartitions":0,"failedPartitions":0}}
```

As the new container starts, the node recovers the `movies` index from the checkpoint and the write-ahead log under `/data/indexes`, so the search returns the same two films with the same scores. `docker compose down --volumes` deletes the volume as well, which removes every index for good.

## Choose a tag

The Compose file takes the image tag from `NARSIL_IMAGE_TAG` in `.env`, and it uses `latest` when you leave that variable out. The [image README](../packages/container/README.md#choose-a-tag) lists every tag. Pin a release in production, so that a new release reaches the node only when you change the tag:

<!-- release-version narsil-ts -->
```bash skip
echo "NARSIL_IMAGE_TAG=0.4.5" >> .env
docker compose up -d
```
<!-- /release-version -->

Compose replaces the container with one from the new image, and the new container mounts the same volume.

### The Rust server

Every tag has a matching tag that ends in `-rust`, such as `latest-rust` for `latest`, whose image serves the same release from the Rust server. Both servers read the same variables and serve the same routes, so you can switch a node between them by changing the tag alone. To switch, set `NARSIL_IMAGE_TAG` in `.env` to a tag that ends in `-rust`, and start the node again with `docker compose up -d`.

The two servers keep their indexes in one file format, so the node keeps its indexes across the switch. The [container specification](../packages/spec/container.md#storage) allows each image to ignore the task records and queued webhook deliveries that it can't read, so the node can lose its task history and the deliveries in its queue when you switch. The Rust image leaves out the `transformers` kind of embedder and reranker, so its startup program exits with status 1 when a variable sets that kind.

## Cluster mode

The image serves one node. When that node joins a cluster, it has to use a tag without `-rust`, because only the TypeScript server runs cluster mode. The [cluster guide](cluster.md) shows how you can build the nodes of a cluster in code.

## Change a setting

Every setting is an environment variable that begins with `NARSIL_`. Add a variable under `environment` in `compose.yaml`, such as `NARSIL_LANGUAGES: english,french` to register a second language module, and start the node again with `docker compose up -d`. The [image README](../packages/container/README.md#common-settings) lists the settings that most deployments change, and the [container specification](../packages/spec/container.md) defines every variable.
