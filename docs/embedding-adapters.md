# Embedding adapters

An embedding adapter turns text into vectors, so a caller searches by meaning without producing a single vector by hand. This guide covers the bundled adapters, naming them, and writing one of your own.

Embedding adapters turn text into vectors automatically, on insert and at query time. Configure a default adapter for the whole engine, register named adapters, or set one per index. Map each vector field to the text fields it embeds; multiple source fields concatenate before embedding.

```ts
import { createNarsil } from '@delali/narsil'
import { createOpenAIEmbedding } from '@delali/narsil/embeddings/openai'

const narsil = await createNarsil({
  embedding: createOpenAIEmbedding({
    baseUrl: 'https://api.openai.com/v1',
    apiKey: process.env.OPENAI_API_KEY ?? '',
    model: 'text-embedding-3-small',
    dimensions: 1536,
  }),
})

await narsil.createIndex('articles', {
  schema: {
    title: 'string',
    body: 'string',
    embedding: 'vector[1536]',
  },
  embedding: {
    fields: {
      embedding: ['title', 'body'],
    },
  },
})

await narsil.insert('articles', {
  title: 'Distributed search engines',
  body: 'Partitioning data across shards improves throughput...',
})

const results = await narsil.query('articles', {
  mode: 'vector',
  vector: { field: 'embedding', text: 'how do search engines scale?' },
})
```

## Named adapters

An adapter instance is a function and cannot be serialized, so an index that names its adapter survives durability recovery: the engine persists the name in index metadata and rebinds it on the next start. Register names through the config or at runtime, and reference them from the index config:

```ts
import { createNarsil } from '@delali/narsil'
import { createOpenAIEmbedding } from '@delali/narsil/embeddings/openai'

const engine = await createNarsil({
  embeddingAdapters: {
    'openai-small': createOpenAIEmbedding({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: process.env.OPENAI_API_KEY ?? '',
      model: 'text-embedding-3-small',
      dimensions: 1536,
    }),
  },
  durability: { directory: './narsil-data' },
})

await engine.createIndex('articles', {
  schema: { title: 'string', embedding: 'vector[1536]' },
  embedding: {
    adapter: 'openai-small',
    fields: { embedding: ['title'] },
  },
})

engine.registerEmbeddingAdapter('openai-small', myReplacementAdapter)
```

`registerEmbeddingAdapter` rebinds every index referencing that name, which lets you rotate credentials or swap models without recreating indexes.

## Bundled adapters

| Adapter | Package | Dependencies |
| --- | --- | --- |
| OpenAI | `@delali/narsil/embeddings/openai` | The adapter has no dependencies and uses `fetch`. |
| Transformers.js | `@delali/narsil-embeddings-transformers` | The adapter needs `@huggingface/transformers` as a peer dependency. |

The OpenAI adapter retries retryable failures with exponential backoff and jitter, chunks batches at 2,048 inputs per request, and accepts a timeout and a retry cap. `baseUrl` points at any OpenAI-compatible endpoint, and `apiKey` accepts a string or a function returning one, so short-lived credentials work. The Transformers.js adapter runs models locally with lazy pipeline initialization, supports WebGPU, WASM, and CPU backends, and handles asymmetric models such as E5 and BGE through `documentPrefix` and `queryPrefix`. Its own [README](../packages/embeddings-transformers/README.md) documents every option.

## Custom adapters

Build an adapter by satisfying the `EmbeddingAdapter` interface:

```ts
interface EmbeddingAdapter {
  embed(input: string, purpose: 'document' | 'query', signal?: AbortSignal): Promise<Float32Array>
  embedBatch?(inputs: string[], purpose: 'document' | 'query', signal?: AbortSignal): Promise<Float32Array[]>
  readonly dimensions: number
  shutdown?(): Promise<void>
}
```

When `embedBatch` is missing, Narsil falls back to parallel `embed()` calls with a concurrency limit of 8.
