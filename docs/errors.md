# Errors

The engine throws a `NarsilError` for every failure, which carries a stable string `code`, a message written for a person to read, and a `details` object holding the values that produced the failure. The package exports the engine's codes as `ErrorCodes`. Match on the code, because the message can change between releases.

```ts
import { ErrorCodes, NarsilError } from '@delali/narsil'

try {
  await narsil.insert('products', { title: 42 })
} catch (err) {
  if (err instanceof NarsilError && err.code === ErrorCodes.DOC_VALIDATION_FAILED) {
    console.error(err.message, err.details)
  }
}
```

The codes in this table are the ones that callers handle most often:

| Code | Thrown when |
| --- | --- |
| `INDEX_NOT_FOUND` / `INDEX_ALREADY_EXISTS` | An operation names an unknown index, or `createIndex` reuses a name. |
| `DOC_NOT_FOUND` / `DOC_ALREADY_EXISTS` | A read, update, or removal names an unknown id, or an insert reuses one. |
| `DOC_VALIDATION_FAILED` / `DOC_MISSING_REQUIRED_FIELD` | A document does not match the schema or omits a required field. |
| `SEARCH_INVALID_FIELD` / `SEARCH_INVALID_FILTER` / `SEARCH_INVALID_CURSOR` | A query names an unknown field, passes a malformed filter, or replays a bad cursor. |
| `SEARCH_WORK_CAP_EXCEEDED` | The engine stops a search before it checks every candidate, because the work on its pattern tests passes the cap in the `patternWorkCap` engine setting. The HTTP server answers this error with status 400. When a node raises it, a cluster coordinator fails the whole query, whatever the value of `allowPartialResults`. See [Pattern tests](filters-facets-and-pagination.md#pattern-tests). |
| `VECTOR_DIMENSION_MISMATCH` | A vector's length differs from the field's declared dimension. |
| `EMBEDDING_FAILED` / `EMBEDDING_CONFIG_INVALID` | An adapter call fails, or the embedding configuration is contradictory. |
| `RERANK_FAILED` | A rerank adapter throws, outlasts `rerankTimeout`, or returns a list of another length or a score that is not a finite number. The HTTP server answers it with status 503. See [Reranking](reranking.md#writing-an-adapter). |
| `RERANK_CONFIG_INVALID` | A query's `rerank` gives an adapter that the engine has not registered, a field that is not text, a field more than once, a window outside 1 to `maxRerankWindow`, a window above the `hybrid.depth` that a hybrid query sets, or no query text. The HTTP server answers it with status 400. |
| `PARTITION_CAPACITY_EXCEEDED` / `PARTITION_REBALANCING_BACKPRESSURE` | An insert passes the capacity cap, or a config change collides with a running reshape. |
| `RESTORE_MEMORY_EXCEEDED` | A `restore` over an existing index would need more JavaScript heap or more process memory than the process has free while it holds both copies, so the engine keeps the existing index. The HTTP server answers this error with status 507. See [Snapshots and restore](persistence-and-durability.md#snapshots-and-restore). |
| `INDEX_REOPEN_CAPACITY_EXHAUSTED` | The number of callers waiting for one index to reopen goes over `lifecycle.maxReopenWaiters`. See [Index lifecycle](persistence-and-durability.md#index-lifecycle). |
| `INSTANCE_SHUT_DOWN` | A caller uses an instance after its `shutdown()`, and the HTTP server returns status 503 for that call. |
| `LANGUAGE_NOT_SUPPORTED` | An index config names a language module that the caller never imports. |
| `COORDINATOR_DEPENDENCY_MISSING` / `TRANSPORT_DEPENDENCY_MISSING` | The etcd coordinator or the gRPC transport cannot load its optional peer package. See [Build a node](cluster.md#build-a-node). |
| `CONFIG_INVALID` | A configuration value is out of range or contradictory, or the HTTP server cannot load `uWebSockets.js`. A browser app also gets it when it creates or loads an index with a pattern field before it registers the pattern search code, or an index with a `partial` field before it registers the partial-word search code. The engine also raises it for a `partial` field in an index whose `surfaceForms` setting is off. |

The HTTP server raises codes of its own for a request that never reaches the engine, such as `INVALID_JSON`, `PAYLOAD_TOO_LARGE`, and `TOO_MANY_REQUESTS`, which `ServerErrorCodes` exports. The [client](client.md#errors) raises six more when a request cannot reach a server at all, or when nothing in the response explains what went wrong, which `ClientErrorCodes` exports. `NarsilError.code` covers all three sets, and it takes any other string as well, because a server's `onRequest` hook rejects a request under a code of its own and the client passes that code through unchanged.
