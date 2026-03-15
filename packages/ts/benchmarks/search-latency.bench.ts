import { beforeAll, bench, describe } from 'vitest'
import { createNarsil, type Narsil } from '../src/narsil'
import type { AnyDocument, IndexConfig, SchemaDefinition } from '../src/types/schema'

const schema: SchemaDefinition = {
  title: 'string' as const,
  body: 'string' as const,
  score: 'number' as const,
  category: 'enum' as const,
}

const indexConfig: IndexConfig = {
  schema,
  language: 'english',
}

const wordPool = [
  'search',
  'engine',
  'index',
  'document',
  'query',
  'filter',
  'result',
  'database',
  'storage',
  'partition',
  'shard',
  'cluster',
  'node',
  'replica',
  'token',
  'stemmer',
  'analyzer',
  'ranking',
  'scoring',
  'relevance',
  'inverted',
  'forward',
  'bitmap',
  'vector',
  'embedding',
  'dimension',
  'algorithm',
  'optimization',
  'cache',
  'buffer',
  'pipeline',
  'stream',
  'concurrent',
  'parallel',
  'distributed',
  'fault',
  'tolerant',
  'recovery',
  'latency',
  'throughput',
  'bandwidth',
  'capacity',
  'scalable',
  'elastic',
  'compress',
  'serialize',
  'encode',
  'decode',
  'transform',
  'aggregate',
]

const categoryPool = ['engineering', 'research', 'operations', 'analytics', 'infrastructure']

function randomSentence(wordCount: number): string {
  const words: string[] = []
  for (let i = 0; i < wordCount; i++) {
    words.push(wordPool[Math.floor(Math.random() * wordPool.length)])
  }
  return words.join(' ')
}

function generateDocuments(count: number): AnyDocument[] {
  const docs: AnyDocument[] = []
  for (let i = 0; i < count; i++) {
    docs.push({
      title: randomSentence(5 + Math.floor(Math.random() * 5)),
      body: randomSentence(20 + Math.floor(Math.random() * 30)),
      score: Math.floor(Math.random() * 100),
      category: categoryPool[Math.floor(Math.random() * categoryPool.length)],
    })
  }
  return docs
}

let narsil: Narsil

describe('Search Latency (10K documents)', () => {
  beforeAll(async () => {
    narsil = await createNarsil()
    await narsil.createIndex('bench', indexConfig)
    const docs = generateDocuments(10_000)
    await narsil.insertBatch('bench', docs)
  })

  bench('fulltext search', async () => {
    await narsil.query('bench', { term: 'search engine distributed' })
  })

  bench('fulltext search with filters', async () => {
    await narsil.query('bench', {
      term: 'search engine',
      filters: {
        fields: {
          score: { gte: 30, lte: 80 },
        },
      },
    })
  })

  bench('fulltext search with sorting', async () => {
    await narsil.query('bench', {
      term: 'algorithm optimization',
      sort: { score: 'desc' },
    })
  })

  bench('fulltext search with facets', async () => {
    await narsil.query('bench', {
      term: 'query filter result',
      facets: { category: {} },
    })
  })

  bench('preflight query', async () => {
    await narsil.preflight('bench', { term: 'database partition shard' })
  })
})
