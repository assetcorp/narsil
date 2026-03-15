import { bench, describe } from 'vitest'
import { createNarsil } from '../src/narsil'
import type { AnyDocument, IndexConfig, SchemaDefinition } from '../src/types/schema'

const schema: SchemaDefinition = {
  title: 'string' as const,
  body: 'string' as const,
  score: 'number' as const,
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
    })
  }
  return docs
}

const docs1K = generateDocuments(1000)
const docs10K = generateDocuments(10_000)

describe('Insert Throughput', () => {
  bench(
    'insert 1K documents one by one',
    async () => {
      const narsil = await createNarsil()
      await narsil.createIndex('bench', indexConfig)
      for (const doc of docs1K) {
        await narsil.insert('bench', doc)
      }
      await narsil.shutdown()
    },
    { iterations: 3, warmupIterations: 1 },
  )

  bench(
    'insertBatch 1K documents',
    async () => {
      const narsil = await createNarsil()
      await narsil.createIndex('bench', indexConfig)
      await narsil.insertBatch('bench', docs1K)
      await narsil.shutdown()
    },
    { iterations: 3, warmupIterations: 1 },
  )

  bench(
    'insertBatch 10K documents',
    async () => {
      const narsil = await createNarsil()
      await narsil.createIndex('bench', indexConfig)
      await narsil.insertBatch('bench', docs10K)
      await narsil.shutdown()
    },
    { iterations: 3, warmupIterations: 1 },
  )
})
