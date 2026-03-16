import { createNarsil, type Narsil } from '@delali/narsil'
import type { BenchDocument, SearchEngine } from '../types'

export function createNarsilAdapter(): SearchEngine {
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
      await instance.insertBatch('bench', docs)
    },

    async search(query: string) {
      if (!instance) return 0
      const result = await instance.query('bench', { term: query })
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
