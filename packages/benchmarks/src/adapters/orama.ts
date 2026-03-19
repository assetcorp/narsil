import {
  type AnyOrama,
  create,
  insertMultiple,
  load,
  remove as removeDoc,
  save,
  search,
  searchVector,
} from '@orama/orama'
import type { BenchDocument, SearchEngine, SerializableEngine, VectorBenchDocument, VectorSearchEngine } from '../types'

export function createOramaTextOnlyAdapter(): SearchEngine {
  let db: AnyOrama | null = null

  return {
    name: 'orama',

    async create() {
      db = create({
        schema: { title: 'string' as const, body: 'string' as const },
        language: 'english',
      })
    },

    async insert(documents: BenchDocument[]) {
      if (!db) return
      const docs = documents.map(d => ({ title: d.title, body: d.body }))
      await insertMultiple(db, docs)
    },

    async search(query: string) {
      if (!db) return 0
      const result = await search(db, { term: query })
      return result.count
    },

    async teardown() {
      db = null
    },
  }
}

export function createOramaFullSchemaAdapter(): SearchEngine {
  let db: AnyOrama | null = null
  const trackedIds: string[] = []

  return {
    name: 'orama',
    insertedIds: trackedIds,

    async create() {
      db = create({
        schema: {
          title: 'string' as const,
          body: 'string' as const,
          score: 'number' as const,
          category: 'enum' as const,
        },
        language: 'english',
      })
      trackedIds.length = 0
    },

    async insert(documents: BenchDocument[]) {
      if (!db) return
      const docs = documents.map(({ id, ...doc }) => doc)
      const ids = await insertMultiple(db, docs)
      for (const id of ids) {
        trackedIds.push(id)
      }
    },

    async search(query: string) {
      if (!db) return 0
      const result = await search(db, { term: query })
      return result.count
    },

    async searchWithFilter(query: string) {
      if (!db) return 0
      const result = await search(db, {
        term: query,
        where: {
          category: { eq: 'engineering' },
          score: { gte: 50 },
        },
      })
      return result.count
    },

    async searchWithIds(query: string) {
      if (!db) return []
      const result = await search(db, { term: query, limit: 10 })
      return result.hits.map(h => h.id)
    },

    async insertWithIds(documents: BenchDocument[]) {
      if (!db) return
      const ids = await insertMultiple(db, documents)
      for (const id of ids) {
        trackedIds.push(id)
      }
    },

    async remove(docId: string) {
      if (!db) return
      await removeDoc(db, docId)
    },

    async removeBatch(docIds: string[]) {
      if (!db) return
      for (const id of docIds) {
        await removeDoc(db, id)
      }
    },

    async teardown() {
      db = null
    },
  }
}

export function createOramaSerializableAdapter(): SerializableEngine {
  let db: AnyOrama | null = null

  return {
    name: 'orama',

    async create() {
      db = create({
        schema: {
          title: 'string' as const,
          body: 'string' as const,
          score: 'number' as const,
          category: 'enum' as const,
        },
        language: 'english',
      })
    },

    async insert(documents: BenchDocument[]) {
      if (!db) return
      const docs = documents.map(({ id, ...doc }) => doc)
      await insertMultiple(db, docs)
    },

    async serialize() {
      if (!db) return ''
      return JSON.stringify(save(db))
    },

    async deserializeAndSearch(serialized: Uint8Array | string, query: string) {
      const fresh = create({
        schema: {
          title: 'string' as const,
          body: 'string' as const,
          score: 'number' as const,
          category: 'enum' as const,
        },
        language: 'english',
      })
      load(fresh, JSON.parse(serialized as string))
      const result = await search(fresh, { term: query })
      return result.count
    },

    async teardown() {
      db = null
    },
  }
}

export function createOramaVectorAdapter(dimension: number): VectorSearchEngine {
  let db: AnyOrama | null = null

  return {
    name: 'orama',

    async create() {
      db = create({
        schema: {
          title: 'string' as const,
          embedding: `vector[${dimension}]` as const,
        },
        language: 'english',
      })
    },

    async insert(documents: VectorBenchDocument[]) {
      if (!db) return
      const docs = documents.map(({ id, ...doc }) => doc)
      await insertMultiple(db, docs)
    },

    async searchVector(queryVector: number[], k: number) {
      if (!db) return 0
      const result = await searchVector(db, {
        mode: 'vector',
        vector: { value: queryVector, property: 'embedding' },
        similarity: 0,
        limit: k,
      })
      return result.count
    },

    async teardown() {
      db = null
    },
  }
}
