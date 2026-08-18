# Errors

The engine throws a `NarsilError` for every failure, and each one carries a stable string `code`, a message written for a person to read, and a `details` object holding the values that produced the failure. The full set of codes is exported as `ErrorCodes`. Match on the code, because the message changes between releases.

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

The codes you handle most often:

| Code | Thrown when |
| --- | --- |
| `INDEX_NOT_FOUND` / `INDEX_ALREADY_EXISTS` | An operation names an unknown index, or `createIndex` reuses a name. |
| `DOC_NOT_FOUND` / `DOC_ALREADY_EXISTS` | A read, update, or removal names an unknown id, or an insert reuses one. |
| `DOC_VALIDATION_FAILED` / `DOC_MISSING_REQUIRED_FIELD` | A document does not match the schema or omits a required field. |
| `SEARCH_INVALID_FIELD` / `SEARCH_INVALID_FILTER` / `SEARCH_INVALID_CURSOR` | A query names an unknown field, passes a malformed filter, or replays a bad cursor. |
| `VECTOR_DIMENSION_MISMATCH` | A vector's length differs from the field's declared dimension. |
| `EMBEDDING_FAILED` / `EMBEDDING_CONFIG_INVALID` | An adapter call failed, or the embedding configuration is contradictory. |
| `PARTITION_CAPACITY_EXCEEDED` / `PARTITION_REBALANCING_BACKPRESSURE` | An insert passes the capacity cap, or a config change collides with a running reshape. |
| `LANGUAGE_NOT_SUPPORTED` | An index config names a language module that was never imported. |
| `CONFIG_INVALID` | A configuration value is out of range or contradictory. |

The HTTP server raises codes of its own for a request that never reaches the engine, such as `INVALID_JSON`, `PAYLOAD_TOO_LARGE`, and `TOO_MANY_REQUESTS`, which `ServerErrorCodes` exports. The [client](client.md#errors) raises six more when a request cannot reach a server at all, or when nothing that came back explains what went wrong, which `ClientErrorCodes` exports. `NarsilError.code` covers all three sets, and it takes any other string as well, because a server's `onRequest` hook rejects a request under a code of its own and the client passes that code through unchanged.
