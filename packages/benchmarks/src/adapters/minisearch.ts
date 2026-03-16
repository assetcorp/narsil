import MiniSearch from 'minisearch'
import type { BenchDocument, SearchEngine } from '../types'

export function createMiniSearchAdapter(): SearchEngine {
  let ms: MiniSearch<BenchDocument> | null = null

  return {
    name: 'minisearch',

    async create() {
      ms = new MiniSearch<BenchDocument>({
        fields: ['title', 'body'],
        storeFields: ['title', 'body', 'score', 'category'],
        idField: 'id',
      })
    },

    async insert(documents: BenchDocument[]) {
      ms!.addAll(documents)
    },

    async search(query: string) {
      const results = ms!.search(query)
      return results.length
    },

    async teardown() {
      ms = null
    },
  }
}
