# Narsil Adapter Interface Contracts

This document defines the adapter interfaces that Narsil uses to abstract
environment-specific functionality. Adapters provide pluggable backends for
persistence, invalidation, and tokenization. Any Narsil implementation must
support these contracts, and any adapter (built-in or community-contributed)
must conform to them.

---

## PersistenceAdapter

The persistence adapter handles durable storage of serialized index data
(`.nrsl` envelopes). All methods are asynchronous. The adapter does not
interpret the data; it stores and retrieves raw byte arrays keyed by
string paths.

### PersistenceAdapter Definition

```text
PersistenceAdapter {
  save(key: string, data: bytes): async -> void
  load(key: string): async -> bytes | null
  delete(key: string): async -> void
  list(prefix: string): async -> Array<string>
}
```

### PersistenceAdapter Methods

#### save(key, data)

- Stores the byte array `data` at the given `key`.
- If a value already exists at `key`, it is overwritten.
- Must be atomic: either the full write succeeds or the previous value
  remains intact. Partial writes must not leave corrupted data.
- On failure, throw/return an error with code `PERSISTENCE_SAVE_FAILED`.

#### load(key)

- Retrieves the byte array stored at `key`.
- Returns `null` if no value exists at `key`.
- On failure (I/O error, permission denied), throw/return an error with
  code `PERSISTENCE_LOAD_FAILED`.
- After loading, the caller validates the CRC32 checksum (if present in
  the envelope header). A mismatch raises `PERSISTENCE_CRC_MISMATCH`.

#### delete(key)

- Removes the value at `key`.
- Must be idempotent: deleting a non-existent key is not an error.
- On failure, throw/return an error with code `PERSISTENCE_DELETE_FAILED`.

#### list(prefix)

- Returns all keys that start with the given `prefix`.
- Used to discover indexes and partitions on startup
  (e.g., `list("")` returns all keys,
  `list("products/")` returns all keys for the "products" index).
- Returns an empty array if no keys match.
- Key ordering is not guaranteed.

### Key Format

Keys are slash-delimited string paths. The key format follows the
convention defined in [envelope.md](envelope.md):

| Key Pattern                      | Content            |
|----------------------------------|--------------------|
| `<indexName>/meta`               | Index metadata     |
| `<indexName>/partition_<N>`      | Partition N data   |
| `<indexName>/vector/<fieldName>` | Vector index data  |

### Security: Path Traversal Protection

Filesystem-based adapters must verify that the resolved file path stays
within the configured base directory. After resolving `basePath + key`
to an absolute path, confirm the result starts with the absolute
`basePath`. Reject any key that would escape the base directory
(e.g., keys containing `..`) with a `PERSISTENCE_SAVE_FAILED` error.

### Persistence Built-in Adapters

| Adapter             | Environment | Backend              |
|---------------------|-------------|----------------------|
| MemoryAdapter       | All         | In-memory Map        |
| FilesystemAdapter   | Node.js+    | .nrsl files on disk  |
| IndexedDBAdapter    | Browser     | IndexedDB store      |

### Community Adapter Guidelines

Community adapters (Redis, S3, PostgreSQL, etc.) should:

- Use the same key format as built-in adapters.
- Store the raw `.nrsl` bytes without modification.
- Support atomic writes (or document the lack of atomicity).
- Handle key listing for startup discovery.

---

## InvalidationAdapter

The invalidation adapter handles pub/sub coordination between multiple
Narsil instances. When one instance mutates data and persists it, the
invalidation adapter notifies other instances so they can evict stale
partitions from memory.

### InvalidationAdapter Definition

```text
InvalidationAdapter {
  publish(event: InvalidationEvent): async -> void
  subscribe(handler: function(InvalidationEvent) -> void): async -> void
  shutdown(): async -> void
}
```

### InvalidationAdapter Methods

#### publish(event)

- Broadcasts the event to all subscribers (including other
  processes/tabs/pods).
- Fire-and-forget semantics: the caller does not wait for delivery
  confirmation.
- Must be called AFTER persistence confirms
  (see [invalidation.md](invalidation.md) for event flow ordering).

#### subscribe(handler)

- Registers a callback that fires when an event arrives from another
  instance.
- Events from the current instance (identified by `sourceInstanceId`)
  should be ignored by the handler. The adapter itself does not filter;
  the engine's invalidation handler checks `sourceInstanceId`.
- May be called multiple times to register multiple handlers.

#### shutdown()

- Cleans up resources (close connections, stop polling, remove
  listeners).
- Must be idempotent: calling shutdown on an already-shut-down adapter
  is not an error.

### InvalidationEvent Types

Two event types flow through the invalidation adapter:

Partition invalidation (notifies instances to reload partitions):

```json
{
  "type":             "partition",
  "indexName":        "string",
  "partitions":       [0, 3],
  "timestamp":        1700000000000,
  "sourceInstanceId": "uuid-string"
}
```

Statistics broadcast (shares partition statistics for broadcast scoring):

```json
{
  "type":       "statistics",
  "indexName":  "string",
  "instanceId": "uuid-string",
  "stats": {
    "totalDocs":         50000,
    "docFrequencies":    { "widget": 120 },
    "totalFieldLengths": { "title": 250000 }
  }
}
```

See [invalidation.md](invalidation.md) for the complete event flow and
concurrency model.

### Invalidation Built-in Adapters

| Adapter                  | Environment | Transport        |
|--------------------------|-------------|------------------|
| NoopInvalidation         | All         | No-op            |
| FilesystemInvalidation   | Node.js+    | JSON marker files|
| BroadcastChannelInvalid. | Browser     | BroadcastChannel |

---

## CustomTokenizer

The tokenizer adapter allows developers to replace Narsil's built-in
text analysis pipeline with a custom implementation. This is useful for
domain-specific tokenization (e.g., code search, chemical formulas,
medical terminology).

### CustomTokenizer Definition

```text
CustomTokenizer {
  tokenize(text: string): Array<TokenResult>
}

TokenResult {
  token:    string
  position: number
}
```

### CustomTokenizer Contract

#### tokenize(text)

- Receives raw field text.
- Returns an array of `{ token, position }` pairs.
- `token`: the normalized, analysis-ready token string (lowercased,
  stemmed, etc., as appropriate for the domain).
- `position`: zero-indexed position of the token in the text. Used
  for highlighting and phrase matching.
- When a custom tokenizer is configured for an index, Narsil bypasses
  its standard pipeline (NFC normalization, lowercasing, splitting,
  stop word removal, stemming) entirely and delegates to this function.
- The same tokenizer is used for both indexing and querying. Tokens
  produced at index time must match tokens produced at query time for
  the same input.

### CustomTokenizer Configuration

A custom tokenizer is set per index at creation time:

```json
{
  "schema": {},
  "tokenizer": {
    "tokenize": "function(text) -> Array<{ token, position }>"
  }
}
```

When a custom tokenizer is present, the `language` setting still applies
for stop words (unless the custom tokenizer handles stop word removal
itself) and for any other language-specific behavior outside
tokenization.

---

## LanguageModule

Language modules provide language-specific text analysis components. Each
module is a self-contained unit that can be loaded independently
(tree-shakeable).

### LanguageModule Definition

```text
LanguageModule {
  name:      string
  stemmer:   (function(token: string) -> string) | null
  stopWords: Set<string>
  tokenizer: TokenizerConfig | undefined
}

TokenizerConfig {
  splitPattern:        RegExp | undefined
  normalizeDiacritics: boolean | undefined
  minTokenLength:      number | undefined
}
```

### LanguageModule Fields

#### name

A lowercase identifier for the language (e.g., `"english"`, `"french"`,
`"twi"`). Used as the key in the language registry.

#### stemmer

A function that reduces a token to its root form. Returns the stemmed
form, or the input unchanged if no stemming rule applies. Set to `null`
for languages without a stemmer (partial support).

#### stopWords

A `Set` of common words to exclude from indexing. The set can be
overridden per index via the `stopWords` configuration option.

#### tokenizer

Optional tokenizer configuration that overrides defaults for this
language. Used by CJK languages (Chinese, Japanese) that require
character-based tokenization instead of whitespace splitting.

### Stop Word Override

Per-index stop word configuration supports two modes:

- **Set replacement:** Providing a `Set<string>` replaces the
  language's default stop words entirely.
- **Function modifier:** Providing a function
  `(defaults: Set<string>) -> Set<string>` receives the language's
  default stop words and returns a modified set (e.g., to add
  domain-specific words or remove words that are meaningful in
  the domain).

---

## EmbeddingAdapter

The embedding adapter converts text into vector embeddings. It
abstracts the embedding provider (remote API, local ONNX model,
custom inference server) behind a uniform interface so that Narsil
can auto-embed documents during indexing and queries during search.

### EmbeddingAdapter Definition

```text
EmbeddingAdapter {
  embed(input: string, purpose: 'document' | 'query', cancel?: CancelToken): async -> float32[]
  embedBatch?(inputs: Array<string>, purpose: 'document' | 'query', cancel?: CancelToken): async -> Array<float32[]>
  readonly dimensions: number
  shutdown?(): async -> void
}
```

### EmbeddingAdapter Methods

#### embed(input, purpose, signal?)

- Converts a text string into a vector embedding returned as a
  32-bit floating-point array.
- `purpose` indicates whether the input is a document being indexed
  or a query being searched. Asymmetric embedding models (E5, BGE,
  Nomic, Cohere, Google Vertex AI) use this to apply model-specific
  prefixes or parameters that produce different vectors for documents
  vs queries. Models without asymmetric behavior (MiniLM, GTE) ignore
  this parameter.
- `signal` is an optional cancellation token for cooperative
  cancellation. When cancelled, the method returns an abort error.
  Narsil passes a cancellation signal during shutdown to cancel
  in-flight embedding requests. The cancellation mechanism is
  runtime-specific (e.g., `AbortSignal` in JavaScript,
  `context.Context` in Go, `CancellationToken` in Rust).
- On failure, the adapter returns an error. Narsil wraps it with
  error code `EMBEDDING_FAILED`.

#### embedBatch?(inputs, purpose, signal?)

- Optional batch method. Accepts an array of text strings and returns
  an array of float32 vectors in the same order.
- When implemented, Narsil calls this instead of calling `embed()` in
  a loop during `insertBatch()`.
- When not implemented, Narsil falls back to calling `embed()`
  concurrently for each input, using the runtime's native
  concurrency mechanism.
- Chunking and rate limiting are the adapter's responsibility, not
  Narsil's. For example, an OpenAI adapter knows its token limits and
  can chunk internally.
- The adapter must return vectors in the same order as the inputs
  array.

#### dimensions (readonly property)

- Reports the dimensionality of vectors produced by this adapter.
- Narsil validates this against the schema's vector field dimensions
  at index creation time. A mismatch throws
  `EMBEDDING_DIMENSION_MISMATCH`.
- Must be a positive integer.
- Must remain constant for the lifetime of the adapter.

#### shutdown?()

- Optional cleanup method. Called during `narsil.shutdown()`.
- Must be idempotent: calling shutdown on an already-shut-down adapter
  is not an error.
- Used by adapters that hold resources (ONNX sessions, open
  connections, timers).
- Follows the same pattern as `InvalidationAdapter.shutdown()`.

### Embedding Configuration

The embedding adapter is configured at two levels:

**Instance-level** (default for all indexes):

```json
{
  "embedding": "EmbeddingAdapter instance"
}
```

**Index-level** (overrides instance-level):

```json
{
  "schema": {
    "title": "string",
    "description": "string",
    "contentVec": "vector[1536]"
  },
  "embedding": {
    "adapter": "EmbeddingAdapter instance (optional if instance-level is set)",
    "fields": {
      "contentVec": ["title", "description"],
      "titleVec": "title"
    }
  }
}
```

### Field Mapping Rules

- Keys in `fields` must reference vector fields in the schema.
- Values are either a single string (one source field) or an array of
  strings (multiple source fields concatenated).
- Source fields must be string-typed fields in the schema.
- When multiple source fields are specified, they are concatenated
  with `\n` (newline) as the separator.
- Field order in the array is semantically significant: fields listed
  first receive higher representational weight in the embedding due to
  positional bias in transformer models (documented in "Dwell in the
  Beginning", ACL 2024). Place the most important field first.
- Validation: At `createIndex` time, Narsil validates that all field
  references exist in the schema and have the correct types. Invalid
  mappings throw `EMBEDDING_CONFIG_INVALID`.

### Insert Behavior

When a document is inserted into an index with embedding
configuration:

1. Required field validation runs first (if `required` array is
   configured).
2. For each mapped vector field:
   a. If the document already contains the vector field, Narsil uses
      it as-is (skip embedding). This preserves the "bring your own
      vectors" path.
   b. If the vector field is absent, Narsil collects the source field
      values from the document.
   c. Missing or empty source fields are skipped. If ALL source fields
      for a mapping are missing or empty, Narsil throws
      `EMBEDDING_NO_SOURCE`.
   d. Present source fields are concatenated with `\n` and passed to
      `adapter.embed(text, 'document', signal)`.
   e. The returned `Float32Array` is assigned to the vector field on
      the document.
3. Schema validation runs. Vectors produced by the adapter skip
   `validateVector()` (the adapter is trusted internal
   infrastructure; dimensions were validated at index creation).
4. The document is indexed.

For `insertBatch`, if the adapter implements `embedBatch`, Narsil
collects all texts per mapped vector field and calls `embedBatch`
once per field. If `embedBatch` is not implemented, Narsil falls back
to concurrent `embed()` calls.

Embedding failure during insert results in `EMBEDDING_FAILED`. For
single insert, this throws. For batch insert, the individual document
goes to `BatchResult.failed` and processing continues for remaining
documents.

### Query Behavior

Vector query parameters accept either a raw vector or text for
auto-embedding:

```json
{
  "vector": {
    "field": "contentVec",
    "value": [0.12, -0.45, "..."],
    "text": "search query text"
  }
}
```

- `value`: A raw vector (`Float32Array` or `number[]`). Current
  behavior, unchanged.
- `text`: A text string to be auto-embedded using the index's
  embedding adapter with `purpose: 'query'`.
- `value` and `text` are mutually exclusive. Providing both is an
  error.
- If `text` is provided but the index has no embedding adapter,
  Narsil throws `EMBEDDING_CONFIG_INVALID`.

### Required Fields

A separate but related feature. Indexes can declare required fields:

```json
{
  "schema": {
    "title": "string",
    "price": "number"
  },
  "required": ["title", "price"]
}
```

- `required` is an array of field names that must be present (not
  `undefined` or `null`) in every inserted document.
- Default: empty array (all fields optional, same as current
  behavior).
- Validation runs before embedding, so no adapter calls are wasted on
  documents that will fail validation.
- Missing required fields throw `DOC_MISSING_REQUIRED_FIELD`.
- Follows JSON Schema's `required` array pattern (used by MongoDB,
  OpenAPI).
- This is orthogonal to the existing strict mode (which rejects extra
  fields). Both can be used together.

### EmbeddingAdapter Error Codes

| Code                           | When                                                                              | Severity      |
|--------------------------------|-----------------------------------------------------------------------------------|---------------|
| `EMBEDDING_FAILED`             | Adapter threw during embed/embedBatch (network error, model failure, OOM)         | Runtime       |
| `EMBEDDING_DIMENSION_MISMATCH` | Adapter dimensions != schema vector dimensions at createIndex                     | Configuration |
| `EMBEDDING_NO_SOURCE`          | All mapped source fields missing/empty, no manual vector provided                 | Runtime       |
| `EMBEDDING_CONFIG_INVALID`     | Field mapping references nonexistent or wrong-type schema fields                  | Configuration |
| `DOC_MISSING_REQUIRED_FIELD`   | Document missing a field in the required array                                    | Validation    |

### Embedding Built-in Adapters

| Adapter          | Package                                  | Environment | Transport        |
|------------------|------------------------------------------|-------------|------------------|
| OpenAI-compat.   | `@delali/narsil/embeddings/openai`       | All         | fetch (HTTP)     |
| Transformers.js  | `@delali/narsil-embeddings-transformers` | All         | ONNX Runtime     |

#### OpenAI-compatible Adapter

Configuration:

```json
{
  "baseUrl": "https://api.openai.com/v1",
  "apiKey": "string or function returning string/Promise<string>",
  "model": "text-embedding-3-small",
  "timeout": 30000,
  "maxRetries": 3
}
```

- Works with any provider implementing the OpenAI `/v1/embeddings`
  endpoint (OpenAI, Azure OpenAI, Mistral, Together AI, Fireworks,
  Groq).
- Uses `fetch` (no external HTTP dependencies).
- `apiKey` accepts a string for simple use or a function for dynamic
  resolution (vault lookups, token rotation).
- Retries transient failures (429, 500, 502, 503) with exponential
  backoff and jitter. Does not retry permanent failures (400, 401,
  403).
- The adapter never logs, serializes, or includes the API key in
  error messages.
- Supports cooperative cancellation via the runtime's HTTP client.

#### Transformers.js Adapter

Configuration:

```json
{
  "model": "Xenova/all-MiniLM-L6-v2",
  "dtype": "q8",
  "device": "wasm | webgpu | cpu",
  "pooling": "mean | cls",
  "normalize": true,
  "documentPrefix": "passage: ",
  "queryPrefix": "query: ",
  "progress": "function(data) -> void",
  "pipelineOptions": "PretrainedOptions passthrough"
}
```

- Shipped as a separate package
  (`@delali/narsil-embeddings-transformers`) because
  `@huggingface/transformers` is a heavy dependency (~40MB with WASM
  binaries).
- `@huggingface/transformers` is a peer dependency so the user
  controls the version.
- Pipeline is created lazily on first `embed()` call (singleton
  pattern). Subsequent calls reuse the session.
- Dimensions are auto-detected from the model output on first call
  (warm-up inference).
- `documentPrefix`/`queryPrefix` are prepended based on the `purpose`
  parameter. This handles models like E5 (`passage: `/`query: `) and
  BGE (query instruction prefix). Models that need no prefix (MiniLM,
  GTE) leave these unset.
- `pipelineOptions` is an escape hatch for advanced transformers.js
  configuration (`cache_dir`, `revision`, `local_files_only`) without
  polluting the primary config surface.
- `shutdown()` disposes the ONNX session and frees memory.

### Community Adapter Guidelines

Community adapters (Cohere, Voyage AI, custom model servers, etc.)
should:

- Implement the `EmbeddingAdapter` interface.
- Handle the `purpose` parameter appropriately for their model's
  asymmetric behavior.
- Implement `embedBatch` when the underlying API supports batch
  requests.
- Implement `shutdown` when the adapter holds resources.
- Document the model's expected dimensions clearly.
- Handle retries and rate limiting internally.
- Support cooperative cancellation.
