import { createNarsil, type Narsil } from '@delali/narsil'
import type { BenchDocument, SearchEngine, VectorBenchDocument, VectorSearchEngine } from '../types'

export function createNarsilTextOnlyAdapter(): SearchEngine {
  let instance: Narsil | null = null

  return {
    name: 'narsil',

    async create() {
      instance = await createNarsil()
      await instance.createIndex('bench', {
        schema: { title: 'string' as const, body: 'string' as const },
        language: 'english',
        trackPositions: false,
      })
    },

    async insert(documents: BenchDocument[]) {
      if (!instance) return
      const docs = documents.map(d => ({ title: d.title, body: d.body }))
      await instance.insertBatch('bench', docs, { skipClone: true })
    },

    async search(query: string) {
      if (!instance) return 0
      const result = await instance.query('bench', { term: query })
      return result.count
    },

    async searchTermMatchAll(query: string) {
      if (!instance) return 0
      const result = await instance.query('bench', { term: query, termMatch: 'all' })
      return result.count
    },

    async teardown() {
      if (instance) {
        await instance.shutdown()
        instance = null
      }
    },
  }
}

export function createNarsilFullSchemaAdapter(): SearchEngine {
  let instance: Narsil | null = null

  return {
    name: 'narsil',

    async create() {
      instance = await createNarsil()
      await instance.createIndex('bench', {
        schema: {
          title: 'string' as const,
          body: 'string' as const,
          score: 'number' as const,
          category: 'enum' as const,
        },
        language: 'english',
        trackPositions: false,
      })
    },

    async insert(documents: BenchDocument[]) {
      if (!instance) return
      const docs = documents.map(({ id, ...doc }) => doc)
      await instance.insertBatch('bench', docs, { skipClone: true })
    },

    async search(query: string) {
      if (!instance) return 0
      const result = await instance.query('bench', { term: query })
      return result.count
    },

    async searchTermMatchAll(query: string) {
      if (!instance) return 0
      const result = await instance.query('bench', { term: query, termMatch: 'all' })
      return result.count
    },

    async teardown() {
      if (instance) {
        await instance.shutdown()
        instance = null
      }
    },
  }
}

export function createNarsilVectorAdapter(dimension: number): VectorSearchEngine {
  let instance: Narsil | null = null

  return {
    name: 'narsil',

    async create() {
      instance = await createNarsil()
      await instance.createIndex('bench', {
        schema: {
          title: 'string' as const,
          embedding: `vector[${dimension}]` as const,
        },
        language: 'english',
        trackPositions: false,
      })
    },

    async insert(documents: VectorBenchDocument[]) {
      if (!instance) return
      const docs = documents.map(({ id, ...doc }) => doc)
      await instance.insertBatch('bench', docs, { skipClone: true })
    },

    async searchVector(queryVector: number[], k: number) {
      if (!instance) return 0
      const result = await instance.query('bench', {
        vector: { field: 'embedding', value: queryVector, metric: 'cosine' },
        limit: k,
      })
      return result.count
    },

    async teardown() {
      if (instance) {
        await instance.shutdown()
        instance = null
      }
    },
  }
}
