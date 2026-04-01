import { afterAll, beforeAll, bench, describe } from 'vitest'
import { createNarsil, type Narsil } from '../src/narsil'
import type { EmbeddingAdapter } from '../src/types/adapters'
import type { AnyDocument, IndexConfig, SchemaDefinition } from '../src/types/schema'
import { createRng, generateSentence } from './utils'

const SEED = 99
const DOC_COUNT = 1_000
const DIM = 128

function asyncDelay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function createLatencyAdapter(dimensions: number, latencyMs: number): EmbeddingAdapter {
  const adapterRng = createRng(SEED + 1000)

  return {
    dimensions,
    async embed(_input: string, _purpose: 'document' | 'query'): Promise<Float32Array> {
      await asyncDelay(latencyMs)
      const vec = new Float32Array(dimensions)
      for (let i = 0; i < dimensions; i++) {
        vec[i] = adapterRng() * 2 - 1
      }
      return vec
    },
    async embedBatch(inputs: string[], _purpose: 'document' | 'query'): Promise<Float32Array[]> {
      const results: Float32Array[] = []
      for (let idx = 0; idx < inputs.length; idx++) {
        await asyncDelay(latencyMs)
        const vec = new Float32Array(dimensions)
        for (let i = 0; i < dimensions; i++) {
          vec[i] = adapterRng() * 2 - 1
        }
        results.push(vec)
      }
      return results
    },
  }
}

const embeddingSchema: SchemaDefinition = {
  title: 'string',
  body: 'string',
  embedding: `vector[${DIM}]`,
}

const embeddingConfig: IndexConfig = {
  schema: embeddingSchema,
  language: 'english',
  embedding: {
    adapter: createLatencyAdapter(DIM, 0.1),
    fields: { embedding: ['title', 'body'] },
  },
}

const noEmbeddingConfig: IndexConfig = {
  schema: embeddingSchema,
  language: 'english',
}

function generateDocsWithText(count: number): AnyDocument[] {
  const rng = createRng(SEED)
  const docs: AnyDocument[] = []
  for (let i = 0; i < count; i++) {
    docs.push({
      title: generateSentence(rng, 5 + Math.floor(rng() * 8)),
      body: generateSentence(rng, 30 + Math.floor(rng() * 50)),
    })
  }
  return docs
}

function generateDocsWithPrecomputedVectors(count: number): AnyDocument[] {
  const rng = createRng(SEED)
  const docs: AnyDocument[] = []
  for (let i = 0; i < count; i++) {
    const vec = new Array(DIM)
    for (let d = 0; d < DIM; d++) {
      vec[d] = rng() * 2 - 1
    }
    docs.push({
      title: generateSentence(rng, 5 + Math.floor(rng() * 8)),
      body: generateSentence(rng, 30 + Math.floor(rng() * 50)),
      embedding: vec,
    })
  }
  return docs
}

const docsForEmbedding = generateDocsWithText(DOC_COUNT)
const docsWithVectors = generateDocsWithPrecomputedVectors(DOC_COUNT)

const queryRng = createRng(SEED + 2000)

function randomQueryVector(): number[] {
  const vec: number[] = []
  for (let d = 0; d < DIM; d++) {
    vec.push(queryRng() * 2 - 1)
  }
  return vec
}

describe('Embedding Overhead: Insert Throughput', () => {
  bench(
    'insertBatch 1K with auto-vectorization (mock adapter)',
    async () => {
      /* Intentionally includes full Narsil lifecycle (create + shutdown) per iteration
         because vitest bench does not support per-iteration setup outside the timed region.
         The higher iteration count stabilizes the measurement despite lifecycle overhead. */
      const narsil = await createNarsil()
      await narsil.createIndex('bench', embeddingConfig)
      await narsil.insertBatch('bench', docsForEmbedding)
      await narsil.shutdown()
    },
    { iterations: 5, warmupIterations: 1 },
  )

  bench(
    'insertBatch 1K pre-computed vectors (no adapter)',
    async () => {
      const narsil = await createNarsil()
      await narsil.createIndex('bench', noEmbeddingConfig)
      await narsil.insertBatch('bench', docsWithVectors)
      await narsil.shutdown()
    },
    { iterations: 5, warmupIterations: 1 },
  )
})

describe('Vector Search Latency (pre-stored vectors)', () => {
  let narsil: Narsil

  beforeAll(async () => {
    narsil = await createNarsil()
    await narsil.createIndex('search-bench', noEmbeddingConfig)
    await narsil.insertBatch('search-bench', docsWithVectors)
  })

  afterAll(async () => {
    await narsil.shutdown()
  })

  bench('vector search (cosine, top 10)', async () => {
    await narsil.query('search-bench', {
      vector: { field: 'embedding', value: randomQueryVector(), metric: 'cosine' },
      mode: 'vector',
      limit: 10,
    })
  })

  bench('hybrid search alpha=0.5 (BM25 + vector)', async () => {
    await narsil.query('search-bench', {
      term: 'server network protocol',
      vector: { field: 'embedding', value: randomQueryVector(), metric: 'cosine' },
      mode: 'hybrid',
      hybrid: { alpha: 0.5 },
      limit: 10,
    })
  })
})
