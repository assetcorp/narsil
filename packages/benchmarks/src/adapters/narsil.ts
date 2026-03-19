import { createNarsil, type Narsil } from '@delali/narsil'
import type { BenchDocument, SearchEngine, SerializableEngine, VectorBenchDocument, VectorSearchEngine } from '../types'

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
  const trackedIds: string[] = []

  return {
    name: 'narsil',
    insertedIds: trackedIds,

    async create() {
      instance = await createNarsil()
      trackedIds.length = 0
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
      const result = await instance.insertBatch('bench', docs, { skipClone: true })
      for (const id of result.succeeded) {
        trackedIds.push(id)
      }
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

    async searchWithFilter(query: string) {
      if (!instance) return 0
      const result = await instance.query('bench', {
        term: query,
        filters: {
          fields: {
            category: { eq: 'engineering' },
            score: { gte: 50 },
          },
        },
      })
      return result.count
    },

    async searchWithIds(query: string) {
      if (!instance) return []
      const result = await instance.query('bench', { term: query, limit: 10 })
      return result.hits.map(h => h.id)
    },

    async insertWithIds(documents: BenchDocument[]) {
      if (!instance) return
      for (const doc of documents) {
        const { id, ...fields } = doc
        await instance.insert('bench', fields, id)
        trackedIds.push(id)
      }
    },

    async remove(docId: string) {
      if (!instance) return
      await instance.remove('bench', docId)
    },

    async removeBatch(docIds: string[]) {
      if (!instance) return
      await instance.removeBatch('bench', docIds)
    },

    async teardown() {
      if (instance) {
        await instance.shutdown()
        instance = null
      }
    },
  }
}

export function createNarsilSerializableAdapter(): SerializableEngine {
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

    async serialize() {
      if (!instance) return new Uint8Array(0)
      return instance.snapshot('bench')
    },

    async deserializeAndSearch(serialized: Uint8Array | string, query: string) {
      const fresh = await createNarsil()
      await fresh.restore('bench', serialized as Uint8Array)
      const result = await fresh.query('bench', { term: query })
      await fresh.shutdown()
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
