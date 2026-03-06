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

| Key Pattern                 | Content          |
|-----------------------------|------------------|
| `<indexName>/meta`          | Index metadata   |
| `<indexName>/partition_<N>` | Partition N data |

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
  stemmer:   function(token: string) -> string | null
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
