import { create, insertMultiple, search, type AnyOrama } from '@orama/orama'
import type { BenchDocument, SearchEngine } from '../types'

export function createOramaAdapter(): SearchEngine {
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
      const docs = documents.map(({ id, ...doc }) => doc)
      await insertMultiple(db!, docs)
    },

    async search(query: string) {
      const result = await search(db!, { term: query })
      return result.count
    },

    async teardown() {
      db = null
    },
  }
}
