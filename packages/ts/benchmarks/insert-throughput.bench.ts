import { bench, describe } from 'vitest'
import { createNarsil } from '../src/narsil'
import type { IndexConfig, SchemaDefinition } from '../src/types/schema'
import { generateDocuments } from './utils'

const SEED = 42

const schema: SchemaDefinition = {
  title: 'string' as const,
  body: 'string' as const,
  score: 'number' as const,
}

const indexConfig: IndexConfig = {
  schema,
  language: 'english',
}

const multiPartitionConfig: IndexConfig = {
  ...indexConfig,
  partitions: {
    maxDocsPerPartition: 5_000,
    maxPartitions: 8,
  },
}

const docs1K = generateDocuments(1_000, SEED)
const docs10K = generateDocuments(10_000, SEED)
const docs50K = generateDocuments(50_000, SEED)

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
    { iterations: 5, warmupIterations: 1 },
  )

  bench(
    'insertBatch 1K documents',
    async () => {
      const narsil = await createNarsil()
      await narsil.createIndex('bench', indexConfig)
      await narsil.insertBatch('bench', docs1K)
      await narsil.shutdown()
    },
    { iterations: 5, warmupIterations: 1 },
  )

  bench(
    'insertBatch 10K documents',
    async () => {
      const narsil = await createNarsil()
      await narsil.createIndex('bench', indexConfig)
      await narsil.insertBatch('bench', docs10K)
      await narsil.shutdown()
    },
    { iterations: 5, warmupIterations: 1 },
  )

  bench(
    'insertBatch 50K documents',
    async () => {
      const narsil = await createNarsil()
      await narsil.createIndex('bench', indexConfig)
      await narsil.insertBatch('bench', docs50K)
      await narsil.shutdown()
    },
    { iterations: 3, warmupIterations: 1 },
  )

  bench(
    'insertBatch 10K with partition splitting',
    async () => {
      const narsil = await createNarsil()
      await narsil.createIndex('bench', multiPartitionConfig)
      await narsil.insertBatch('bench', docs10K)
      await narsil.shutdown()
    },
    { iterations: 5, warmupIterations: 1 },
  )
})
