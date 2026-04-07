import { afterAll, bench, describe } from 'vitest'
import { createNarsil, type Narsil } from '../src/narsil'
import type { EmbeddingAdapter } from '../src/types/adapters'
import type { AnyDocument, IndexConfig, SchemaDefinition } from '../src/types/schema'
import { createRng, generateSentence } from './utils'

const SEED = 99
const INSERT_DOC_COUNT = 1_000
const SEARCH_DOC_COUNT = 10_000
const SEARCH_DOC_COUNT_LARGE = 50_000
const DIM = 1536

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

const schema: SchemaDefinition = {
  title: 'string',
  body: 'string',
  embedding: `vector[${DIM}]`,
}

const embeddingConfig: IndexConfig = {
  schema,
  language: 'english',
  embedding: {
    adapter: createLatencyAdapter(DIM, 0.1),
    fields: { embedding: ['title', 'body'] },
  },
}

const noEmbeddingConfig: IndexConfig = {
  schema,
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

function generateDocsWithVectors(count: number, seed: number): AnyDocument[] {
  const rng = createRng(seed)
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

const docsForEmbedding = generateDocsWithText(INSERT_DOC_COUNT)
const docsWithVectorsInsert = generateDocsWithVectors(INSERT_DOC_COUNT, SEED)

const queryRng = createRng(SEED + 2000)

function randomQueryVector(): number[] {
  const vec: number[] = []
  for (let d = 0; d < DIM; d++) {
    vec.push(queryRng() * 2 - 1)
  }
  return vec
}

let search10k: Narsil | null = null

async function getSearch10k(): Promise<Narsil> {
  if (search10k) return search10k
  search10k = await createNarsil()
  await search10k.createIndex('bench', noEmbeddingConfig)
  const docs = generateDocsWithVectors(SEARCH_DOC_COUNT, SEED + 100)
  await search10k.insertBatch('bench', docs)
  return search10k
}

let search50k: Narsil | null = null

async function getSearch50k(): Promise<Narsil> {
  if (search50k) return search50k
  search50k = await createNarsil()
  await search50k.createIndex('bench', {
    ...noEmbeddingConfig,
    partitions: {
      maxDocsPerPartition: 10_000,
      maxPartitions: 8,
    },
  })
  const docs = generateDocsWithVectors(SEARCH_DOC_COUNT_LARGE, SEED + 200)
  await search50k.insertBatch('bench', docs)
  return search50k
}

describe('Embedding Overhead: Insert Throughput (1K docs, 1536 dims)', () => {
  bench(
    'insertBatch 1K with auto-vectorization (mock adapter)',
    async () => {
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
      await narsil.insertBatch('bench', docsWithVectorsInsert)
      await narsil.shutdown()
    },
    { iterations: 5, warmupIterations: 1 },
  )
})

describe('Vector Search Latency: 10K docs, 1536 dims (brute-force)', () => {
  afterAll(async () => {
    if (search10k) {
      await search10k.shutdown()
      search10k = null
    }
  })

  bench('vector search (cosine, top 10)', async () => {
    const narsil = await getSearch10k()
    await narsil.query('bench', {
      vector: { field: 'embedding', value: randomQueryVector(), metric: 'cosine' },
      mode: 'vector',
      limit: 10,
    })
  })

  bench('hybrid search alpha=0.5 (BM25 + vector)', async () => {
    const narsil = await getSearch10k()
    await narsil.query('bench', {
      term: 'server network protocol',
      vector: { field: 'embedding', value: randomQueryVector(), metric: 'cosine' },
      mode: 'hybrid',
      hybrid: { alpha: 0.5 },
      limit: 10,
    })
  })
})

describe('Vector Search Latency: 50K docs, 1536 dims (multi-partition)', () => {
  afterAll(async () => {
    if (search50k) {
      await search50k.shutdown()
      search50k = null
    }
  })

  bench('vector search (cosine, top 10)', async () => {
    const narsil = await getSearch50k()
    await narsil.query('bench', {
      vector: { field: 'embedding', value: randomQueryVector(), metric: 'cosine' },
      mode: 'vector',
      limit: 10,
    })
  })

  bench('hybrid search alpha=0.5 (BM25 + vector)', async () => {
    const narsil = await getSearch50k()
    await narsil.query('bench', {
      term: 'server network protocol',
      vector: { field: 'embedding', value: randomQueryVector(), metric: 'cosine' },
      mode: 'hybrid',
      hybrid: { alpha: 0.5 },
      limit: 10,
    })
  })
})
