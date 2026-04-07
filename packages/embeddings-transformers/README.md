# @delali/narsil-embeddings-transformers

A [Transformers.js](https://huggingface.co/docs/transformers.js) embedding adapter for the [Narsil](https://github.com/assetcorp/narsil) search engine. This adapter runs embedding models directly in Node.js or the browser using ONNX Runtime, so there are no external API calls and no data leaves your environment. It conforms to Narsil's `EmbeddingAdapter` interface and supports any Hugging Face model that works with the `feature-extraction` pipeline.

## Installation

```bash
pnpm add @delali/narsil-embeddings-transformers @huggingface/transformers
```

`@huggingface/transformers` is a peer dependency. You must install it alongside this package. Any version `>=3.0.0` is supported.

## Quick start

```typescript
import { createTransformersEmbedding } from '@delali/narsil-embeddings-transformers'

const embedding = createTransformersEmbedding({
  dimensions: 384,
})

const vector = await embedding.embed('a red panda eating bamboo', 'document')
console.log(vector.length) // 384
```

The factory function returns a synchronous adapter object. The underlying model loads lazily on the first `embed()` or `embedBatch()` call, and subsequent calls reuse the same pipeline instance.

## Choosing a model

The default model is `Xenova/all-MiniLM-L6-v2`, a 384-dimensional sentence embedding model that works well for general-purpose text similarity. Here are common alternatives:

| Model | Dimensions | Size (q8) | Use case |
| ----- | ---------- | --------- | ---------- |
| `Xenova/all-MiniLM-L6-v2` | 384 | ~23 MB | General-purpose, good balance of speed and quality |
| `Xenova/bge-base-en-v1.5` | 768 | ~65 MB | Higher quality English embeddings, requires prefix |
| `Xenova/bge-small-en-v1.5` | 384 | ~23 MB | Smaller BGE variant for English |
| `Xenova/multilingual-e5-small` | 384 | ~50 MB | Multilingual support, requires prefix |
| `Xenova/gte-small` | 384 | ~23 MB | Strong general-purpose alternative |

Set the `dimensions` config value to match the output dimensionality of your chosen model. If you set it incorrectly, the adapter will throw an error on the first embedding call.

```typescript
const embedding = createTransformersEmbedding({
  model: 'Xenova/bge-base-en-v1.5',
  dimensions: 768,
})
```

### Browser vs Node.js

All models work in both environments. In the browser, models are downloaded from the Hugging Face Hub and cached in the browser's Cache API. In Node.js, models are cached on disk at `~/.cache/huggingface/`. The first call triggers the download; subsequent calls load from cache.

## Document and query prefixes

Some models (BGE, E5, and instruction-tuned models) require specific text prefixes for documents and queries. Configure these with `documentPrefix` and `queryPrefix`:

```typescript
const embedding = createTransformersEmbedding({
  model: 'Xenova/bge-base-en-v1.5',
  dimensions: 768,
  documentPrefix: 'Represent this sentence: ',
  queryPrefix: 'Represent this sentence for searching relevant passages: ',
})
```

For E5 models:

```typescript
const embedding = createTransformersEmbedding({
  model: 'Xenova/multilingual-e5-small',
  dimensions: 384,
  documentPrefix: 'passage: ',
  queryPrefix: 'query: ',
})
```

The adapter prepends the appropriate prefix based on the `purpose` argument (`'document'` or `'query'`) passed to `embed()` and `embedBatch()`.

## Device and quantization

Control where inference runs and at what precision:

```typescript
const embedding = createTransformersEmbedding({
  dimensions: 384,
  device: 'webgpu',  // 'wasm' | 'webgpu' | 'cpu'
  dtype: 'q8',       // 'q8' | 'q4' | 'fp32' | 'fp16'
})
```

- **`device`**: Defaults to auto-detection by Transformers.js. Use `'webgpu'` for GPU acceleration in supported browsers. Use `'cpu'` for Node.js environments.
- **`dtype`**: Defaults to `'q8'` (8-bit quantization). Lower precision like `'q4'` reduces model size and speeds up inference at a small quality cost. Use `'fp32'` for full-precision inference when accuracy matters more than speed.

## Download progress

Track model download progress for a better loading experience:

```typescript
const embedding = createTransformersEmbedding({
  dimensions: 384,
  progress: (data) => {
    console.log('Download progress:', data)
  },
})
```

The `progress` callback is passed through to the Transformers.js `pipeline()` function as `progress_callback`. The callback data includes status, file name, and download percentage when available.

## Integration with Narsil

The adapter plugs into Narsil's embedding configuration for automatic vector generation on insert and text-based vector search on query:

```typescript
import { createNarsil } from '@delali/narsil'
import { createTransformersEmbedding } from '@delali/narsil-embeddings-transformers'

const embeddingAdapter = createTransformersEmbedding({
  dimensions: 384,
})

const narsil = createNarsil({
  embedding: embeddingAdapter,
})

const index = await narsil.createIndex({
  name: 'articles',
  schema: {
    title: 'string',
    body: 'string',
    titleVector: 'vector[384]',
  },
  embedding: {
    fields: {
      titleVector: ['title', 'body'],
    },
  },
})

await index.insert({
  title: 'Introduction to Vector Search',
  body: 'Vector search finds similar items by comparing numerical representations...',
})

const results = await index.query({
  vector: {
    field: 'titleVector',
    text: 'how does semantic search work',
    limit: 10,
  },
})
```

When you insert a document, Narsil automatically generates embeddings for the `titleVector` field by concatenating the `title` and `body` source fields and passing them through the adapter. When you query with `text` instead of a raw vector, Narsil embeds the query text using the same adapter with the `'query'` purpose.

## Shutdown and cleanup

Release the ONNX session and free memory by calling `shutdown()`:

```typescript
await embeddingAdapter.shutdown()
```

If the adapter is passed to a Narsil instance, calling `narsil.shutdown()` will shut down the embedding adapter automatically.

## API reference

### `createTransformersEmbedding(config)`

Returns an object conforming to Narsil's `EmbeddingAdapter` interface.

### Config options

| Option | Type | Default | Description |
| ------ | ---- | ------- | ----------- |
| `dimensions` | `number` | **(required)** | Output dimensionality of the model. Must match the model's actual output size. |
| `model` | `string` | `'Xenova/all-MiniLM-L6-v2'` | Hugging Face model identifier for the `feature-extraction` pipeline. |
| `dtype` | `string` | `'q8'` | Model quantization level: `'q8'`, `'q4'`, `'fp32'`, `'fp16'`. |
| `device` | `'wasm' \| 'webgpu' \| 'cpu'` | auto-detect | Inference backend. Omit to let Transformers.js pick the best available. |
| `pooling` | `'mean' \| 'cls'` | `'mean'` | Token pooling strategy for generating a single vector from token-level outputs. |
| `normalize` | `boolean` | `true` | Whether to L2-normalize output vectors. |
| `documentPrefix` | `string` | `''` | Text prepended to input when `purpose` is `'document'`. |
| `queryPrefix` | `string` | `''` | Text prepended to input when `purpose` is `'query'`. |
| `progress` | `(data: unknown) => void` | - | Callback for model download progress events. |
| `pipelineOptions` | `Record<string, unknown>` | - | Additional options passed through to the Transformers.js `pipeline()` constructor. |

### Returned adapter methods

| Method | Signature | Description |
| ------ | --------- | ----------- |
| `embed` | `(input: string, purpose: 'document' \| 'query', signal?: AbortSignal) => Promise<Float32Array>` | Embed a single string. |
| `embedBatch` | `(inputs: string[], purpose: 'document' \| 'query', signal?: AbortSignal) => Promise<Float32Array[]>` | Embed multiple strings in a single model forward pass. |
| `dimensions` | `readonly number` | The configured output dimensionality. |
| `shutdown` | `() => Promise<void>` | Release the model pipeline and free resources. |

## License

Apache-2.0
