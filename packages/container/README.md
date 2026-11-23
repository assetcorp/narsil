# Narsil container image

This image serves one Narsil node over HTTP, and it takes every setting from an environment variable, so you can deploy the search server without writing a Node.js startup file. The [container specification](../spec/container.md) defines each variable, and this README covers the ones that most deployments set.

## Start a node

[`compose.yaml`](compose.yaml) starts one node with Docker Compose, reads its admin key from an `.env` file, and keeps its data on a volume. The [container guide](../../docs/container-image.md) takes that node from `docker compose up` through adding documents, searching them, and connecting each client, and it restarts the node to show that the documents stay.

To start a node without Compose, give it an admin key of at least 32 characters, and mount a volume at `/data` so that your indexes survive a restart:

```bash skip
docker run --rm -p 7700:7700 \
  -e NARSIL_ADMIN_KEY="$(openssl rand -hex 32)" \
  -v narsil-data:/data \
  ghcr.io/assetcorp/narsil:latest
```

The node answers `GET /livez` and `GET /readyz` without a key, so a Kubernetes probe can call them directly. Every other route needs the key as `Authorization: Bearer <key>`:

```bash skip
curl -X POST localhost:7700/indexes \
  -H "authorization: Bearer $NARSIL_ADMIN_KEY" \
  -H 'content-type: application/json' \
  -d '{"name":"movies","config":{"schema":{"title":"string"}}}'
```

The [HTTP server guide](../../docs/http-server.md) describes every route that the node serves.

The image serves one node outside any cluster. To run the nodes of a cluster, build them in code with the TypeScript package, as the [cluster guide](../../docs/cluster.md) shows, or start the Rust server's `narsil-server` binary with its `cluster` feature, as [its README](../rust-server/README.md#join-a-cluster) describes.

## Choose a tag

| Tag | What it holds |
|-----|---------------|
| `latest` | The newest release of `@delali/narsil`. |
| `<major>.<minor>`, such as `0.4` | The newest patch release of that minor version. |
| `<version>` | One release, which never changes once it is published. |
| `next` | The newest prerelease, which the publish workflow builds from each push to `main`. |
| `sha-<commit>` | The image that the publish workflow built from that commit. |
| `latest-rust`, `<version>-rust`, and each tag above with `-rust` added | The same release served by the Rust server, which reads the same variables. |

You can switch a node between the TypeScript server and the Rust server by changing the tag alone. The Rust image leaves out the `transformers` kind of embedder and reranker, so its startup program exits with status 1 when a variable sets that kind.

Pin a version in production, so that a new release reaches your nodes only when you change the tag:

<!-- release-version narsil-ts -->
`docker pull ghcr.io/assetcorp/narsil:0.4.5`
<!-- /release-version -->

Each tag covers `linux/amd64` and `linux/arm64`, and each image carries provenance and SBOM attestations from its build.

## Common settings

| Variable | Default | What it sets |
|----------|---------|--------------|
| `NARSIL_ADMIN_KEY` | none | The key that may call every route. |
| `NARSIL_READ_KEY` | none | The key that may call only the search and read routes. |
| `NARSIL_HTTP_PORT` | `7700` | The port that the server binds to. |
| `NARSIL_STORAGE` | `filesystem` | `filesystem` keeps data under `/data`, while `memory` loses every index on a restart. |
| `NARSIL_LANGUAGES` | `english` | The language modules that the node registers, as a comma-separated list such as `english,french`. |
| `NARSIL_EMBEDDERS` | none | The embedding adapters that an index can name, each configured through the `NARSIL_EMBEDDER_<NAME>_*` variables. |
| `NARSIL_WEBHOOK_URL` | none | The endpoint that receives signed event deliveries, which needs `NARSIL_WEBHOOK_SECRET` beside it. |

The specification lists the rest, including tokens, limits, rerank adapters, device sync, change feeds, and query suggestions.

The startup program checks every variable before it binds the port. When a value breaks its rule, the program writes one line to standard error that gives the variable and the rule, and it exits with status 1. That line never holds a key or a secret, so you can forward the container logs to a shared system.

## Storage and memory

With `filesystem` storage, the node keeps four folders inside `/data`. It keeps the indexes and their write-ahead log in `indexes/`, the task records in `tasks/`, the undelivered webhook events in `webhooks/`, and the files of each `transformers` model in `models/`. A node that restarts on the same volume keeps its documents and its task history, and it can embed text without network access once it has downloaded a model.

The image sets `NODE_OPTIONS=--max-old-space-size-percentage=75`, so the engine's heap can grow to three quarters of the memory that you give the container. Node ends the process once an index outgrows that limit, so size the container memory for the indexes that you expect. The image also loads jemalloc through `LD_PRELOAD`, because jemalloc returns the memory that the server's threads free to the system, while glibc's allocator can hold on to it. The Rust image loads jemalloc in the same way. The Rust server asks the kernel to back each block of full-precision vectors with 2 MiB pages, which lets the processor find more of the vectors that a search reads without walking the page tables, and the kernel grants those pages only where the host's `/sys/kernel/mm/transparent_hugepage/enabled` reads `madvise` or `always`.

The server process works as the `node` user, with user ID 1000, so a volume that you mount at `/data` has to be writable by that user. The Rust server works as the `narsil` user under the same user ID, so you can mount one volume in both images.

## Events

The node writes each engine event and each finished task to standard output as one line of JSON, in the shape `{"type":"task.finished","timestamp":"...","data":{...}}`. When you set `NARSIL_WEBHOOK_URL`, it also sends the same body to that URL, signed under the [Standard Webhooks](https://www.standardwebhooks.com/) scheme with the secret in `NARSIL_WEBHOOK_SECRET`, and it retries a failed delivery nine times over about 75 hours.

## Build the image

Build from the root of this repository, because the image compiles the engine, the adapters, and the native search core from source:

```bash skip
docker build -f packages/container/Dockerfile -t narsil:local .
```

Build the Rust image from the root of the repository too, through its separate Dockerfile:

```bash skip
docker build -f packages/rust-container/Dockerfile -t narsil:local-rust .
```

Pass `--build-arg NARSIL_BUILD_VERSION=<version>` and `--build-arg NARSIL_BUILD_GIT_SHA=<commit>` to set what `GET /version` reports.
