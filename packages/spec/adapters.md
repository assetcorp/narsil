# Narsil Adapter Interface Contracts

Adapters are how Narsil reaches anything outside its own memory: durable storage, coordination between instances, text analysis, and embedding models. This document defines each adapter contract. Every Narsil implementation must support these contracts, and every adapter, built in or contributed, must conform to them.

---

## Notation

Type definitions here and throughout the specification use a language-neutral notation. It illustrates the contract, and each implementation expresses it in its own type system.

| Notation | Meaning |
|----------|---------|
| `List<T>` | An ordered collection of elements of type `T` |
| `Map<K, V>` | A mapping from keys of type `K` to values of type `V` |
| `Set<T>` | An unordered collection of distinct elements of type `T` |
| `string` | Text |
| `integer`, `number` | A whole number, and any numeric value |
| `boolean` | True or false |
| `bytes` | A byte array |
| `value` | A value of any type |
| `T or absent` | A value that is either a `T` or missing; each language maps 'absent' to its own null, nil, None, or optional type |
| `async ... -> T` | An asynchronous operation producing a `T` |
| `-> nothing` | An operation that produces no value |
| `uint8`, `uint16`, `uint32`, `uint64`, `float32`, `float64` | Exact widths in a byte layout or on the wire |

---

## PersistenceAdapter

The persistence adapter stores serialised index data, meaning `.nrsl` envelopes, durably. Every method is asynchronous. The adapter never interprets what it stores; it saves and returns raw byte arrays keyed by string paths.

```text
PersistenceAdapter {
  async save(key: string, data: bytes) -> nothing
  async load(key: string) -> bytes or absent
  async delete(key: string) -> nothing
  async list(prefix: string) -> List<string>
}
```

### save(key, data)

- Stores `data` under `key`, replacing whatever was there before.
- The write must be atomic: either the whole write succeeds or the previous value survives untouched. A partial write must never leave corrupt data behind.
- A failure raises `PERSISTENCE_SAVE_FAILED`.

### load(key)

- Returns the bytes stored under `key`, or absent when the key holds nothing.
- A failure, whether an I/O error or a permission refusal, raises `PERSISTENCE_LOAD_FAILED`.
- The caller verifies the CRC32 checksum afterwards, when the envelope header carries one, and a mismatch raises `PERSISTENCE_CRC_MISMATCH`.

### delete(key)

- Removes whatever is stored under `key`.
- It must be idempotent, so deleting a key that holds nothing is not an error.
- A failure raises `PERSISTENCE_DELETE_FAILED`.

### list(prefix)

- Returns every key that starts with `prefix`, and an empty list when none match.
- Startup discovery uses it to find indexes and partitions, so `list("")` returns every key and `list("products/")` returns every key belonging to the `products` index.
- Key ordering is not guaranteed.

### Key Format

Keys are slash-delimited paths, every key belonging to an index starts with `<indexName>/`, and the full key table is in [Storage Path Convention](envelope.md#storage-path-convention).

### Path Traversal Protection

A filesystem-backed adapter must confirm that the resolved file path stays inside the configured base directory. Resolve `basePath + key` to an absolute path and check that the result starts with the absolute `basePath`. Reject any key that would escape, such as one containing `..`, with `PERSISTENCE_SAVE_FAILED`.

### Built-in Persistence Adapters

| Adapter | Environment | Backend |
|---------|-------------|---------|
| MemoryAdapter | all | An in-memory map |
| FilesystemAdapter | server runtimes | `.nrsl` files on disk |
| IndexedDBAdapter | browser | An IndexedDB store |

### Community Adapter Guidelines

A community adapter, whether it targets Redis, S3, PostgreSQL, or anything else, should:

- Use the same key format the built-in adapters use.
- Store the raw `.nrsl` bytes unchanged.
- Write atomically, or document plainly that it cannot.
- Support key listing, so startup discovery works.

---

## InvalidationAdapter

The invalidation adapter carries publish and subscribe traffic between Narsil instances. When one instance mutates data and persists it, the adapter tells the others so that they can evict the stale partitions from memory.

```text
InvalidationAdapter {
  async publish(event: InvalidationEvent) -> nothing
  async subscribe(handler: (event: InvalidationEvent) -> nothing) -> nothing
  async shutdown() -> nothing
}
```

### publish(event)

- Broadcasts the event to every subscriber, across processes, tabs, and pods alike.
- Delivery is fire and forget, so the caller waits for no confirmation.
- The caller must publish only after persistence confirms; see [invalidation.md](invalidation.md) for the ordering rule.

### subscribe(handler)

- Registers a callback that fires when an event arrives from another instance.
- The engine's handler checks `sourceInstanceId` and drops the events this instance published itself. The adapter does no filtering of its own.
- It may be called more than once to register several handlers.

### shutdown()

- Releases resources by closing connections, stopping timers, and removing listeners.
- It must be idempotent, so shutting down an adapter that is already shut down is not an error.

### InvalidationEvent Types

Two event types cross the adapter. A partition event tells other instances to reload the listed partitions:

```json
{
  "type":             "partition",
  "indexName":        "string",
  "partitions":       [0, 3],
  "timestamp":        1700000000000,
  "sourceInstanceId": "uuid-string"
}
```

A statistics event shares partition statistics for broadcast scoring:

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

The full event flow and the concurrency model are in [invalidation.md](invalidation.md).

### Built-in Invalidation Adapters

| Adapter | Environment | Transport |
|---------|-------------|-----------|
| NoopInvalidation | all | none |
| FilesystemInvalidation | server runtimes | JSON marker files |
| BroadcastChannelInvalidation | browser | a broadcast channel |

---

## CustomTokenizer

A custom tokeniser replaces Narsil's built-in text analysis for one index, which is what domain-specific text needs: source code, chemical formulae, or medical terminology.

```text
CustomTokenizer {
  tokenize(text: string) -> List<TokenResult>
}

TokenResult {
  token:    string
  position: uint32
}
```

### tokenize(text)

- It receives the raw field text and returns `{ token, position }` pairs.
- `token` is the normalised, analysis-ready token, lower-cased and stemmed as the domain requires.
- `position` is the token's position in the text, numbered from zero, which highlighting and phrase matching read.
- With a custom tokeniser configured, Narsil skips its whole standard pipeline, meaning NFC normalisation, lower-casing, splitting, stop word removal, and stemming, and calls this function instead.
- The same tokeniser runs for indexing and for querying, so a token produced at index time must match the token produced at query time for the same input.

### Configuration

Each index names or supplies its tokeniser when the caller creates it:

```text
IndexConfig {
  tokenizer: CustomTokenizer or string or absent
}
```

A `CustomTokenizer` value supplies the tokeniser directly, and a string names an entry in the [Analysis Registry](#analysis-registry). A name is the only form that reaches a worker or survives a restart, because a tokeniser is code and no boundary carries code.

The `language` setting still applies alongside a custom tokeniser: it supplies the stop words, unless the tokeniser removes them itself, and any other language behaviour outside tokenisation.

---

## LanguageModule

A language module carries the language-specific parts of text analysis. Each one is self-contained, so a build loads only the languages it uses.

```text
LanguageModule {
  name:       string
  stemmer:    ((token: string) -> string) or absent
  stopWords:  Set<string>
  normalizer: ((token: string) -> string) or absent
  tokenizer:  TokenizerConfig or absent
}

TokenizerConfig {
  splitPattern:        regex or absent
  normalizeDiacritics: boolean or absent
  minTokenLength:      uint32 or absent
  stripPossessive:     boolean or absent
  ngramSize:           uint32 or absent
}
```

### name

A lower-case identifier for the language, such as `english`, `french`, or `twi`. It is the key in the language registry.

### stemmer

A function that reduces a token to its root form. It returns the stemmed form, or the input unchanged when no rule applies. A language with no stemmer, meaning one Narsil supports partially, leaves this absent.

### stopWords

A set of common words to keep out of the index. Each index can override it through the `stopWords` configuration option.

### normalizer

A function that maps two spellings of one word onto one token, which is what an orthography with optional marks needs. German expands ß to `ss`, Greek removes its accents, Serbian converts Cyrillic to Latin, and Hindi rewrites a nasal consonant with a halant as anusvara. It runs on every token of that language, at index time and at query time alike, so that a document written one way answers a query written the other way. A language whose spellings need no such repair leaves it absent.

### tokenizer

An optional configuration that overrides the tokenisation defaults for this language. A language that writes its words with no space between them needs it, because splitting on whitespace and punctuation hands such a language a whole sentence as one token.

| Field | Effect |
|-------|--------|
| `splitPattern` | Narsil splits text on every match of this expression. It defaults to a run of characters that are none of a letter, a mark, a number, an underscore, an apostrophe, or a hyphen. |
| `normalizeDiacritics` | Narsil strips the combining marks from U+0300 to U+036F from every token. It defaults to off. |
| `minTokenLength` | Narsil discards a token shorter than this length. It defaults to 1. |
| `stripPossessive` | Narsil removes a trailing apostrophe, and a trailing apostrophe followed by `s`. It defaults to off, and English turns it on. |
| `ngramSize` | Narsil replaces each run of Han, Hiragana, Katakana, Hangul, Thai, Lao, Khmer, or Myanmar characters with its overlapping character n-grams of this size. It defaults to absent, which leaves every run whole, and every language that sets it uses 2. |

### Stop Word Override

Per-index stop word configuration takes one of three forms. A set replaces the language's default stop words outright. A function of the form `(defaults: Set<string>) -> Set<string>` receives the language's defaults and returns the modified set, which is how a caller adds domain-specific words or keeps a word the language treats as noise and the domain treats as meaningful. A string names an entry in the [Analysis Registry](#analysis-registry). A set and a name both reach a worker and survive a restart, because a set persists as its word list in the index metadata, while a function does neither and needs a registered name for both.

---

## Analysis Pipeline

Narsil analyses text in a fixed order, and every implementation must follow that order, so that a port produces the same tokens as the reference implementation for the same input.

1. A tokeniser configured on the index replaces every step below. Narsil calls it and takes its output as final.
2. Narsil folds full-width and half-width forms. It maps each code point from U+FF01 to U+FF5E onto its ASCII equivalent by subtracting 0xFEE0, maps half-width katakana from U+FF61 to U+FF9D onto the matching full-width katakana, and maps the half-width voiced and semi-voiced marks U+FF9E and U+FF9F onto the combining marks U+3099 and U+309A.
3. Narsil normalises the text to NFC, which composes each combining voice mark onto the kana before it.
4. Narsil maps the apostrophe variants U+2019, U+02BC, and U+02BB onto U+0027, maps the dotted capital I at U+0130 onto `i`, and removes the combining dot above at U+0307 and the Armenian marks from U+055B to U+055F.
5. Narsil lower-cases the text.
6. Narsil splits the text on the language's `splitPattern`.
7. Narsil expands each part into character n-grams when the language sets `ngramSize`. It cuts each part where the script changes, expands a run of Han, Hiragana, Katakana, Hangul, Thai, Lao, Khmer, or Myanmar characters into its overlapping n-grams, and leaves whole both a run of any other script and a run no longer than `ngramSize`. It counts a base character together with every code point of Unicode general category M that follows it as one character, so that no n-gram begins or ends inside a written character.
8. Narsil strips a possessive ending when the language sets `stripPossessive`.
9. Narsil discards a token shorter than `minTokenLength`.
10. Narsil discards a token the index's stop word set holds. It compares the token as step 9 leaves it, before the normaliser and the stemmer run, so a caller writes a stop word list in the language's ordinary spelling.
11. Narsil applies the language's `normalizer`.
12. Narsil strips the combining marks from U+0300 to U+036F when the language sets `normalizeDiacritics` or the caller asks for it.
13. Narsil applies the language's `stemmer`.

A string of ASCII characters alone skips steps 2 to 4, because no step among them changes such a string.

Steps 11 to 13 read the token alone, so an implementation may cache their result under a key of the raw token, the language name, and those two flags.

---

## Analysis Registry

The engine keeps a registry of tokenisers and stop word sets under names the caller chooses:

```text
registerTokenizer(name: string, tokenizer: CustomTokenizer) -> nothing
registerStopWords(name: string, stopWords: Set<string> or ((defaults: Set<string>) -> Set<string>)) -> nothing
```

An index configuration that gives a string for `tokenizer` or for `stopWords` resolves that string against the registry when the caller creates the index, and an unknown name raises `CONFIG_INVALID` listing the names that are registered.

Names exist because no boundary carries code. A tokeniser and a stop word function are both code, and a worker thread, a restart, and a second machine each receive data alone, so an index configured with either value runs in the calling thread and loses its analysis on recovery. An index configured with a name carries the name across instead, and each side resolves that name against its own registry. The `language` setting has always worked this way, and these two settings now match it.

An engine with durability configured refuses an index whose `tokenizer` is a `CustomTokenizer` or whose `stopWords` is a function, raising `CONFIG_INVALID` that names the registry as the alternative. A checkpoint re-analyses the raw documents, so an index whose analysis cannot be persisted would be rewritten with the language default on restart. A literal stop word set is data, so durability accepts it and persists the words themselves.

### Binding

An index resolves its tokeniser and its stop words once, when the caller creates it, and it holds what it resolved for its whole life. Registering a name a second time binds the indexes created afterwards and leaves every existing index untouched. An existing index stores tokens the earlier value produced, and rebinding it would leave its stored tokens in one form and every later query in another, so the engine leaves the binding alone. An index whose analysis must change needs a fresh index and a reindex, as [Analysis Changes](#analysis-changes) describes.

This differs from [Named Adapter Registration](#named-adapter-registration) for embedding adapters, where re-registration rebinds every referencing index. An embedding adapter produces vectors that a rebinding leaves valid, while a tokeniser produces the terms an index is built from.

### Registration Rules

- A name must be a non-empty string, and any other value raises `CONFIG_INVALID`.
- A registered tokeniser must supply a `tokenize` operation, and one without it raises `CONFIG_INVALID`.
- A registered stop word value must be a set or a function of the form above, and any other value raises `CONFIG_INVALID`.
- The registry belongs to the process and not to one engine instance, so several engines in one process share every registration, exactly as they share the language registry.

### Analysis Changes

The split pattern, the n-gram size, the normaliser, the stemmer, the stop words, and the folding steps together decide which tokens an index stores. A change to any of them changes the tokens a query produces, while the tokens already stored keep their earlier form, so a query misses documents it matched before.

The `.nrsl` envelope records no analysis version, so no automatic check reports the mismatch. A release that changes analysis must say so plainly, and an operator meeting such a release must create a fresh index and reindex every document into it.

---

## EmbeddingAdapter

The embedding adapter turns text into vectors. It hides the provider, whether that is a remote API, a local model, or a custom inference server, behind one interface, so Narsil can embed documents while indexing and queries while searching.

```text
EmbeddingAdapter {
  async embed(input: string, purpose: 'document' or 'query', cancel: CancelToken or absent) -> List<float32>
  async embedBatch(inputs: List<string>, purpose: 'document' or 'query', cancel: CancelToken or absent) -> List<List<float32>>   (optional)
  dimensions: uint32   (read-only)
  async shutdown() -> nothing   (optional)
}
```

### embed(input, purpose, cancel)

- Converts one text string into a vector of 32-bit floats.
- `purpose` says whether the input is a document being indexed or a query being searched. An asymmetric model, such as E5, BGE, Nomic, or a Cohere or Google Vertex AI model, uses it to apply the prefix or parameter that produces a different vector for a document than for a query. A symmetric model, such as MiniLM or GTE, ignores it.
- `cancel` is an optional cancellation token for cooperative cancellation, and a cancelled call returns an abort error. Narsil passes a token during shutdown so that in-flight requests stop. Each runtime supplies its own mechanism for this.
- A failure returns an error, which Narsil wraps in `EMBEDDING_FAILED`.

### embedBatch(inputs, purpose, cancel), optional

- Takes a list of strings and returns a list of vectors in the same order.
- When the adapter provides it, Narsil calls it instead of calling `embed` in a loop during a batch insert.
- When the adapter omits it, Narsil calls `embed` for each input concurrently, using whatever concurrency the runtime offers.
- Chunking and rate limiting belong to the adapter, not to Narsil, because the adapter is the only side that knows the provider's token limits.
- The returned vectors must follow the order of the inputs.

### dimensions, a read-only property

- Reports the dimensionality of the vectors this adapter produces.
- Narsil checks it against the schema's vector field dimensions when the index is created, and a mismatch raises `EMBEDDING_DIMENSION_MISMATCH`.
- It must be a positive integer, and it must stay constant for the adapter's lifetime.

### shutdown(), optional

- Releases whatever the adapter holds, such as an inference session, an open connection, or a timer. Narsil calls it during engine shutdown.
- It must be idempotent, so shutting down an adapter that is already shut down is not an error.

### Embedding Configuration

An embedding adapter is configured at two levels. The instance level sets the default for every index:

```json
{
  "embedding": "EmbeddingAdapter instance"
}
```

The index level overrides that default:

```json
{
  "schema": {
    "title": "string",
    "description": "string",
    "contentVec": "vector[1536]"
  },
  "embedding": {
    "adapter": "an EmbeddingAdapter instance, or the name of a registered adapter",
    "fields": {
      "contentVec": ["title", "description"],
      "titleVec": "title"
    }
  }
}
```

The index-level `adapter` is optional whenever an instance-level adapter is set.

### Named Adapter Registration

The engine keeps a registry of embedding adapters under names the caller chooses. An adapter enters the registry through the engine configuration, as a map of name to instance, or later through `registerEmbeddingAdapter(name, adapter)`. An index-level `adapter` given as a string resolves against that registry when the index is created, and an unknown name raises `EMBEDDING_CONFIG_INVALID` listing the names that are registered.

Names exist for durability. An adapter instance holds live resources, such as an API client or an inference session, and cannot be serialised, so an index created with a bare instance loses its binding across a restart. An index created with a registered name persists that name in its metadata, and recovery rebinds the adapter from the registry; see [Index Metadata](durability.md#index-metadata). A server, and any deployment that persists indexes, should register adapters by name, and a bare instance suits short-lived in-process use.

Registering a name that is already taken replaces the binding and rebinds every index referencing it. Rebinding first validates the new adapter's dimensions against every mapped vector field of every affected index, and a mismatch raises `EMBEDDING_DIMENSION_MISMATCH` naming the offending index, leaving no index rebound and the registry entry unchanged. That is what makes credential rotation safe: register a fresh adapter under the same name and every index follows it.

### Field Mapping Rules

- Each key in `fields` must name a vector field in the schema.
- Each value is either one string, naming a single source field, or a list of strings naming several.
- Each source field must be a string-typed field in the schema.
- Several source fields are concatenated with a newline between them.
- Order inside the list carries meaning. A field listed first carries more weight in the resulting embedding, because transformer models weight earlier positions more heavily, so put the most important field first.
- Narsil validates every field reference and type when the index is created, and an invalid mapping raises `EMBEDDING_CONFIG_INVALID`.

### Insert Behaviour

Inserting a document into an index that configures embeddings runs this sequence:

1. Required field validation runs first, when the index configures a `required` list.
2. For each mapped vector field:
   1. A document that already carries the vector field keeps it as it is, and no embedding runs. That is the path for callers who bring their own vectors.
   2. A document missing the vector field has its source field values collected.
   3. A missing or empty source field is skipped. When every source field for a mapping is missing or empty, Narsil raises `EMBEDDING_NO_SOURCE`.
   4. The source values that are present are joined with newlines and passed to the adapter with `purpose` set to `document`.
   5. The returned vector is assigned to the vector field on the document.
3. Schema validation runs. A vector the adapter produced skips the schema's vector validation, because the adapter is trusted internal infrastructure and its dimensions were checked when the index was created.
4. The document is indexed.

For a batch insert, an adapter that provides `embedBatch` receives all the texts of one mapped vector field in a single call, one call per field. An adapter without it falls back to concurrent `embed` calls.

An embedding failure during insert raises `EMBEDDING_FAILED`. A single insert throws it. A batch insert moves that one document into the failed list and carries on with the rest. Each failed entry carries the document's own `id` as its `docId` when the document supplies a non-empty string id, and an empty string when it does not, because a document that was never indexed receives no generated identifier.

### Query Behaviour

Vector query parameters accept either a raw vector or text to embed:

```json
{
  "vector": {
    "field": "contentVec",
    "value": [0.12, -0.45],
    "text": "search query text"
  }
}
```

- `value` is a raw vector of 32-bit floats.
- `text` is a string Narsil embeds through the index's adapter with `purpose` set to `query`.
- `value` and `text` are mutually exclusive, and supplying both is an error.
- Supplying `text` against an index with no embedding adapter raises `EMBEDDING_CONFIG_INVALID`.

### Required Fields

An index can declare fields that every document must carry:

```json
{
  "schema": {
    "title": "string",
    "price": "number"
  },
  "required": ["title", "price"]
}
```

- `required` lists the field names that must be present and non-null in every inserted document.
- It defaults to empty, which leaves every field optional.
- Validation runs before embedding, so a document that will fail validation never costs an adapter call.
- A missing required field raises `DOC_MISSING_REQUIRED_FIELD`.
- This is independent of strict mode, which rejects fields the schema does not declare. An index may use both.

### EmbeddingAdapter Error Codes

| Code | Raised when | Kind |
|------|-------------|------|
| `EMBEDDING_FAILED` | The adapter threw while embedding, whether from a network error, a model failure, or exhausted memory | runtime |
| `EMBEDDING_DIMENSION_MISMATCH` | The adapter's dimensions differ from the schema's vector dimensions at index creation | configuration |
| `EMBEDDING_NO_SOURCE` | Every mapped source field is missing or empty and no vector was supplied | runtime |
| `EMBEDDING_CONFIG_INVALID` | A field mapping references a field that does not exist or holds the wrong type | configuration |
| `DOC_MISSING_REQUIRED_FIELD` | A document omits a field named in the `required` list | validation |

### Built-in Embedding Adapters

| Adapter | Package | Environment | Transport |
|---------|---------|-------------|-----------|
| OpenAI-compatible | `@delali/narsil/embeddings/openai` | all | HTTP |
| Transformers.js | `@delali/narsil-embeddings-transformers` | all | ONNX Runtime |

#### OpenAI-Compatible Adapter

```json
{
  "baseUrl": "https://api.openai.com/v1",
  "apiKey": "a string, or a function returning one",
  "model": "text-embedding-3-small",
  "timeout": 30000,
  "maxRetries": 3
}
```

- It works with any provider that serves the OpenAI `/v1/embeddings` endpoint, which includes OpenAI, Azure OpenAI, Mistral, Together AI, Fireworks, and Groq.
- It uses the runtime's own HTTP client and pulls in no HTTP dependency.
- `apiKey` takes a string for the simple case, or a function for a key resolved at call time from a vault or a rotation service.
- It retries a transient failure, meaning status 429, 500, 502, or 503, with exponential backoff and jitter, and it never retries a permanent failure such as 400, 401, or 403.
- It never logs, serialises, or embeds the API key in an error message.
- It supports cooperative cancellation through the runtime's HTTP client.

#### Transformers.js Adapter

```json
{
  "model": "Xenova/all-MiniLM-L6-v2",
  "dtype": "q8",
  "device": "wasm | webgpu | cpu",
  "pooling": "mean | cls",
  "normalize": true,
  "documentPrefix": "passage: ",
  "queryPrefix": "query: ",
  "progress": "(data) -> nothing",
  "pipelineOptions": "passthrough options for the underlying pipeline"
}
```

- It is a separate package, because the underlying transformers library is a heavy dependency of roughly 40 MB once its WebAssembly binaries are counted.
- That library is a peer dependency, so the caller controls its version.
- The pipeline is created on the first `embed` call and reused afterwards.
- Dimensions are detected from the model's output during that first call.
- `documentPrefix` and `queryPrefix` are prepended according to the `purpose` argument, which is what E5 and BGE models need. A model that needs no prefix, such as MiniLM or GTE, leaves both unset.
- `pipelineOptions` passes advanced options such as a cache directory, a revision, or a local-files-only flag straight through, so the primary configuration stays small.
- `shutdown` disposes the inference session and frees its memory.

### Community Adapter Guidelines

A community adapter, whether it targets Cohere, Voyage AI, or a custom model server, should:

- Satisfy the `EmbeddingAdapter` contract.
- Handle `purpose` the way its model needs.
- Provide `embedBatch` when the underlying API accepts batch requests.
- Provide `shutdown` when the adapter holds resources.
- Document the model's dimensions clearly.
- Handle retries and rate limiting internally.
- Support cooperative cancellation.
