# Narsil Container Specification

This document defines how a container image serves one Narsil node over HTTP and takes every setting from environment variables. Every conforming image reads the same variables with the same meaning, whatever language its server is written in. Narsil publishes every conforming image under one name, where the tag `<version>` holds the TypeScript server and the tag `<version>-rust` holds the Rust server, so a deployment can switch servers by changing the tag alone. Only the TypeScript server can join a cluster, so a deployment that needs cluster mode must use a tag without the `-rust` suffix.

An image holds the server and a startup program. The startup program must build the server's options from the variables below, the way a developer builds them in code, and it must serve every route that the server's OpenAPI document describes.

---

## Reading Variables

- Every variable takes the prefix `NARSIL_`, and an unset variable and an empty variable both take the default.
- A whole number must be written in decimal digits alone, a boolean must be `true` or `false`, and a list must be items separated by commas, where the startup program trims the spaces around each item and rejects an empty item.
- Where a value fails its rule, the startup program must exit with status 1 before it binds the port, and it must write one line to standard error that gives the variable and the rule that the value broke. That line must never hold the value of a key or a secret.
- The startup program must write one warning line for each variable with the prefix `NARSIL_` that this document leaves undefined, and it must go on starting, because Kubernetes adds variables such as `NARSIL_SERVICE_HOST` for a service of that name.

---

## Network

| Variable | Default | Meaning |
|----------|---------|---------|
| `NARSIL_HTTP_HOST` | `0.0.0.0` | The server binds to this address. |
| `NARSIL_HTTP_PORT` | `7700` | The server binds to this port, a whole number from 1 to 65,535. |
| `NARSIL_CORS_ORIGINS` | none | The server accepts cross-origin requests from these origins, given as a list, or from any origin where the value is `*`. |
| `NARSIL_ALLOW_INSECURE` | `false` | The server may start with no key set. |
| `NARSIL_INSTANCE_ID` | the host name | The server stamps this identifier on every task that it owns, as `instanceId` defines. |

The host and port variables include `HTTP` in their names, because Kubernetes sets `NARSIL_PORT` to a URL in every pod beside a service named `narsil`.

Where neither key of [Access](#access) is set and `NARSIL_ALLOW_INSECURE` is `false`, the startup program must exit with status 1.

---

## Access

| Variable | Meaning |
|----------|---------|
| `NARSIL_ADMIN_KEY` | A request that carries this key may call every route. |
| `NARSIL_READ_KEY` | A request that carries this key may call the read routes. |

- Each key must hold at least 32 characters, and the two keys must differ; the startup program must exit with status 1 otherwise.
- A request carries a key or a token as `Authorization: Bearer <value>`. A WebSocket upgrade may carry it as the `Sec-WebSocket-Protocol` value that follows `narsil.sync.v1` or `narsil.changes.v1`.
- The server must compare a presented key with each configured key in constant time.
- `GET /livez`, `GET /readyz`, `GET /health`, and `GET /version` must answer without a credential, so that an orchestrator can probe the container.

### Read Routes

The read routes are every `GET` route other than `GET /indexes/{name}/snapshot` and `GET /indexes/{name}/export`, together with these `POST` routes: `/indexes/{name}/search`, `/indexes/{name}/search/preflight`, `/indexes/{name}/suggest`, `/indexes/{name}/documents/_list`, `/indexes/{name}/documents/_multi-get`, `/indexes/{name}/_wait-for-writes`, and `/indexes/{name}/query-suggestions/record`.

### Tokens

A token lets a backend give a browser or a phone a credential that expires.

- A token must be a JSON Web Token with the header `alg` set to `HS256`, signed with the UTF-8 bytes of the admin key or of the read key. The token grants the routes of the key that verifies its signature.
- The server must refuse a token whose `alg` is anything other than `HS256`, a token without `exp`, a token whose `exp` is not later than the current time, and a token whose `nbf` is more than 60 seconds later than the current time.
- A token may carry `indexes`, a list of index names. Such a token reaches only the routes whose path holds one of those names in place of `{name}`, together with the probe routes.
- A token may carry `sub`, the person, and `group`, the group, which [Query Suggestions](#query-suggestions) reads.
- The server must admit a request under a token as a grant that expires at `exp`, so that it closes a device sync feed or a change feed with close code 4401 at that time.

### Refusals

| Status | Code | Raised when |
|--------|------|-------------|
| 401 | `UNAUTHORIZED` | A request outside the probe routes carries no credential, or a key or a token that the server cannot verify. |
| 403 | `FORBIDDEN` | A verified credential asks for a route outside its role or outside its `indexes`. |

---

## Storage

| Variable | Default | Meaning |
|----------|---------|---------|
| `NARSIL_STORAGE` | `filesystem` | `filesystem` keeps data under `NARSIL_DATA_DIR`, and `memory` keeps nothing across a restart. |
| `NARSIL_DATA_DIR` | `/data` | The node keeps its data in this folder. |
| `NARSIL_DURABILITY_MODE` | `sync` | The write-ahead log runs in this mode, `sync` or `async`, as [Durability Modes](durability.md#durability-modes) defines. |

With `filesystem`, the node must keep its indexes under `indexes/`, its task records under `tasks/`, its webhook queue under `webhooks/`, and the files of its `transformers` models under `models/`, all inside `NARSIL_DATA_DIR`, and it must run write-ahead log durability on `indexes/`. An image must ignore, and may delete, a file under `tasks/`, `webhooks/`, or `models/` that it cannot read, because only the index files carry a cross-implementation format.

With `memory`, the startup program must write a warning line that a restart loses every index, and the node must keep the files of its `transformers` models in the operating system's temporary folder.

An image should declare `/data` as a volume.

---

## Engine

| Variable | Default | Meaning |
|----------|---------|---------|
| `NARSIL_LANGUAGES` | `english` | The node registers these language modules before it creates the engine, given as a list of module names. |
| `NARSIL_WORKERS` | the engine's default | The engine holds worker copies on this many threads, and `0` turns worker copies off. |
| `NARSIL_PROMOTION_THRESHOLD` | `1000` | An index gains worker copies once it holds this many documents. |
| `NARSIL_ALLOW_REGEX` | `true` | The server accepts a `regex` test in a filter. |

The startup program must exit with status 1 for a name in `NARSIL_LANGUAGES` that the image holds no module for. Where a saved index needs a language outside the list, the startup program must exit with status 1 and give the index and the language.

---

## Limits

Each variable sets the server limit of the same name, and its default is the server's default.

| Variable | Default |
|----------|---------|
| `NARSIL_LIMIT_MAX_BODY_BYTES` | 16,777,216 |
| `NARSIL_LIMIT_MAX_IMPORT_BYTES` | 104,857,600 |
| `NARSIL_LIMIT_MAX_RESTORE_BYTES` | 68,719,476,736 |
| `NARSIL_LIMIT_MAX_LINE_BYTES` | 4,194,304 |
| `NARSIL_LIMIT_IMPORT_BATCH_SIZE` | 1,000 |
| `NARSIL_LIMIT_MAX_CONCURRENT_REQUESTS` | 0, which sets no bound |
| `NARSIL_LIMIT_MAX_BODY_BYTES_IN_FLIGHT_FRACTION` | 0.1, a decimal from 0 to 1 |
| `NARSIL_LIMIT_MAX_RESULT_WINDOW` | 10,000 |
| `NARSIL_LIMIT_MAX_RERANK_WINDOW` | 100 |
| `NARSIL_LIMIT_MAX_FETCH_DOCUMENTS` | 10,000 |
| `NARSIL_LIMIT_MAX_IMPORT_ERRORS` | 100 |
| `NARSIL_LIMIT_MAX_TASK_PAGE_SIZE` | 1,000 |
| `NARSIL_LIMIT_MAX_CONCURRENT_TASKS` | 4 |

---

## Embedding and Rerank Adapters

`NARSIL_EMBEDDERS` and `NARSIL_RERANKERS` each give a list of adapter names. A name must match `[a-z0-9][a-z0-9_-]{0,63}`, and an index or a query refers to the adapter by that name. Each name sets its variables through its infix, which is the name in upper case with every `-` written as `_`, and two names with the same infix must make the startup program exit with status 1.

### Embedders

| Variable | Default | Meaning |
|----------|---------|---------|
| `NARSIL_EMBEDDER_<INFIX>_KIND` | none, required | `openai` calls an OpenAI-compatible embedding endpoint, and `transformers` runs a model inside the node. |
| `NARSIL_EMBEDDER_<INFIX>_URL` | none, required for `openai` | The adapter sends its requests to this base URL. |
| `NARSIL_EMBEDDER_<INFIX>_API_KEY` | none | The adapter sends this key to the endpoint. |
| `NARSIL_EMBEDDER_<INFIX>_MODEL` | required for `openai`, `Xenova/all-MiniLM-L6-v2` for `transformers` | The adapter embeds with this model. |
| `NARSIL_EMBEDDER_<INFIX>_DIMENSIONS` | none, required | The adapter returns vectors of this length, which must equal the length that the vector field declares. |
| `NARSIL_EMBEDDER_<INFIX>_TIMEOUT_MS` | 30,000 | The adapter abandons a request after this many milliseconds. |
| `NARSIL_EMBEDDER_<INFIX>_MAX_RETRIES` | 3 | The adapter tries a failed request again this many times. |

### Rerankers

| Variable | Default | Meaning |
|----------|---------|---------|
| `NARSIL_RERANKER_<INFIX>_KIND` | none, required | `http` calls a `/rerank` endpoint in the request format that Cohere defines, and `transformers` runs a cross-encoder inside the node. |
| `NARSIL_RERANKER_<INFIX>_URL` | none, required for `http` | The adapter sends its requests to this base URL. |
| `NARSIL_RERANKER_<INFIX>_API_KEY` | none | The adapter sends this key to the endpoint. |
| `NARSIL_RERANKER_<INFIX>_MODEL` | required for `http`, `Xenova/ms-marco-MiniLM-L-6-v2` for `transformers` | The adapter scores with this model. |
| `NARSIL_RERANKER_<INFIX>_TIMEOUT_MS` | 30,000 | The adapter abandons a request after this many milliseconds. |
| `NARSIL_RERANKER_<INFIX>_MAX_RETRIES` | 3 | The adapter tries a failed request again this many times. |
| `NARSIL_RERANKER_<INFIX>_MAX_DOCUMENTS_PER_REQUEST` | 1,000 | The adapter sends at most this many documents in one request. |

An image may leave out the `transformers` kind, and the startup program of such an image must exit with status 1 where a variable asks for it.

---

## Device Sync and Change Feeds

| Variable | Default | Meaning |
|----------|---------|---------|
| `NARSIL_SYNC` | `false` | The server turns on the device sync routes. |
| `NARSIL_CHANGES` | `false` | The server turns on the change feed. |

The startup program must exit with status 1 where either variable is `true` and no key is set.

---

## Query Suggestions

| Variable | Default | Meaning |
|----------|---------|---------|
| `NARSIL_QUERY_SUGGESTIONS` | `false` | The server counts searches. |
| `NARSIL_QUERY_SUGGESTIONS_KEY` | none, required when `NARSIL_QUERY_SUGGESTIONS` is `true` | The node scrambles each person's ID with this key, whose UTF-8 bytes must number at least 32, as [The Key](query-suggestions.md#the-key) defines. |

The startup program must exit with status 1 where `NARSIL_QUERY_SUGGESTIONS` is `true` and the key is missing or shorter than 32 bytes. The server must take the person and the group of each request as follows.

- A request under a token counts for the token's `sub` and `group`.
- A request under the admin key counts for the `Narsil-Person` and `Narsil-Group` headers.
- A request that lacks the person or the group, or whose person or group breaks the format that [Phrases](query-suggestions.md#phrases) defines, counts nothing, and the server must answer the search as it would otherwise.
- A request under the read key, and a request without a credential, count nothing.

---

## Events and Webhooks

The node must write every engine event other than `write`, and every finished task, as one JSON line to standard output, in the shape of a delivery body.

| Variable | Default | Meaning |
|----------|---------|---------|
| `NARSIL_WEBHOOK_URL` | none | The node delivers events to this URL. |
| `NARSIL_WEBHOOK_SECRET` | none, required with a URL | The node signs each delivery with this secret, written as `whsec_` followed by the base64 of 24 to 64 random bytes. |
| `NARSIL_WEBHOOK_EVENTS` | every type | The node delivers only these types, given as a list. |

An event type is `engine.` followed by the event's name, such as `engine.workerCrash`, or `task.finished`. The `write` event has no type, because the change feed delivers every write. The startup program must exit with status 1 for a name in `NARSIL_WEBHOOK_EVENTS` that is no type.

- Each delivery must be a `POST` whose body is a JSON object holding `type`, `timestamp` in RFC 3339 form, and `data`, the event's payload or the task record.
- Each delivery must carry the headers `webhook-id`, a unique message identifier, `webhook-timestamp`, the send time in whole seconds since the Unix epoch, and `webhook-signature`, which is `v1,` followed by the base64 of the HMAC-SHA256 of `<webhook-id>.<webhook-timestamp>.<body>` under the secret's decoded bytes, as Standard Webhooks defines.
- The node must queue each delivery without delaying the engine, and with `filesystem` storage it must keep the queue under `webhooks/`, so that a restart resumes delivery.
- The queue must hold at most 10,000 deliveries. When it is full, the node must drop the oldest delivery, count every drop, and write the count to standard output.
- The node may send deliveries in any order, with at most 4 sends in flight, and each delivery must follow a separate retry schedule, so that a failing delivery delays no other. The node must abandon a send after 15 seconds.
- A 2xx answer completes the delivery. A 410 answer must stop every delivery until the node restarts. Any other answer, and a failed send, must make the node try again 5 seconds, 5 minutes, 30 minutes, 2 hours, 5 hours, 10 hours, 14 hours, 20 hours, and 24 hours after each failed try in turn, each wait lengthened by up to 10% at random, which is the schedule that Standard Webhooks gives. The node must drop the delivery and write a line to standard output after the last try fails.

---

## Process

- The startup program must shut the server and the engine down on `SIGTERM` and on `SIGINT`, and it must exit with status 0 after a clean shutdown and with status 1 otherwise.
- The image should run the server as a user other than root.
- The image must set `NARSIL_BUILD_VERSION` to its release version and `NARSIL_BUILD_GIT_SHA` to the commit of its build, which `/version` reports.
