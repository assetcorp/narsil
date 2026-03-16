import { type AnyOrama, create, insertMultiple, search, searchVector } from '@orama/orama'
import type { BenchDocument, SearchEngine, VectorBenchDocument, VectorSearchEngine } from '../types'

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
      const docs = documents.map(({ id, ...doc }) => doc)
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
