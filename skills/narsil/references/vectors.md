# Vector search, hybrid search, and cited answers

## Embed as you write

```ts
import { createNarsil } from '@delali/narsil'
import { createTransformersEmbedding } from '@delali/narsil-embeddings-transformers'

const narsil = await createNarsil({
  embeddingAdapters: { minilm: createTransformersEmbedding({ dimensions: 384 }) },
})

await narsil.createIndex('articles', {
  schema: { title: 'string', body: 'string', embedding: 'vector[384]' },
  embedding: { adapter: 'minilm', fields: { embedding: ['title', 'body'] } },
})
```

- The engine embeds the named text fields into `embedding` on every insert and update, so the app writes each document as text alone. The engine rejects a document with no text in any source field with `EMBEDDING_NO_SOURCE`.
- The index stores the adapter's name, never the adapter itself. Pass the same `embeddingAdapters` under the same names each time the process starts, because the engine throws `EMBEDDING_CONFIG_INVALID` for a write or a text query on an index whose adapter it lacks.
- `dimensions` has to equal the `N` in `vector[N]`. The transformers adapter loads `Xenova/all-MiniLM-L6-v2` by default, which returns 384 numbers. Its first call downloads the model from the Hugging Face Hub, so the first execution needs network access, and the adapter reads the cached copy after that.
- When the installed adapter's `peerDependencies` allow only `@huggingface/transformers` releases below 4.0.0, install a 3.x release, and pass `dtype: 'fp32'`, because that adapter defaults to 8-bit weights, which give a text a different vector inside a batch.
- For a hosted model, use `createOpenAIEmbedding({ baseUrl, apiKey, model, dimensions })` from `@delali/narsil/embeddings/openai`, which takes any OpenAI-compatible endpoint. Ask the user for the key and read it from the environment.
- An adapter of your own needs `dimensions` and `embed(input, purpose, signal)`, where `purpose` is `'document'` or `'query'`. Add `embedBatch` when the model embeds a batch faster than single texts.
- To supply vectors yourself, leave `embedding` out of the index, store a `number[]` in the vector field, and query with `vector: { field, value }`.

## Query by meaning

```ts
const results = await narsil.query('articles', {
  mode: 'hybrid',
  term: question,
  vector: { field: 'embedding', text: question },
  document: { exclude: ['embedding'] },
  limit: 5,
})
```

- `mode: 'vector'` ranks by meaning alone, while `mode: 'hybrid'` fuses the keyword and vector rankings by reciprocal rank fusion. Prefer hybrid for help articles and product names, where exact words still matter.
- The engine drops each hit that scores below `vector.similarity`, which is how an app learns that nothing matched. A rank fusion score stays near 0.03 whatever the quality of the match, so read the vector scores from a `mode: 'vector'` query before you choose a floor.
- `hybrid: { strategy: 'linear', alpha: 0.7 }` blends the two scores directly in place of rank fusion.
- The engine refuses `sort` on a hybrid query with `SEARCH_INVALID_MODE`.
- The engine scans a vector field exactly until the field holds 1,024 vectors, and past that count it builds a quantised HNSW graph. On a graph, `vector.efSearch` and `vector.oversample` trade speed for recall.

## Answers that cite their sources

1. Index each passage as its own document, such as one section of a help article, and store the article's URL and title beside it, so that each hit points at a passage that the answer can quote.
2. Retrieve with the hybrid query above, and give the model each hit's `id`, title, and passage text, with an instruction to cite the ids that it uses.
3. Check each cited id against the retrieved hits, and render the answer with a link for each cited source.
4. When the query returns no hits, tell the user that the documentation holds no answer, and leave the model out of it. A `similarity` floor on a `mode: 'vector'` query is what lets a weak match drop out, since a hybrid query keeps every keyword match.

With `highlight: { fields: ['body'] }`, the engine marks the matched words in each passage for display. Give the model the whole passage, because a 200-character snippet can cut out the sentence that holds the answer.
