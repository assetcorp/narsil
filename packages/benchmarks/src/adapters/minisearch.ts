import MiniSearch from 'minisearch'
import type { BenchDocument, SearchEngine } from '../types'

export function createMiniSearchTextOnlyAdapter(): SearchEngine {
  let ms: MiniSearch<BenchDocument> | null = null

  return {
    name: 'minisearch',

    async create() {
      ms = new MiniSearch<BenchDocument>({
        fields: ['title', 'body'],
        storeFields: ['title', 'body'],
        idField: 'id',
      })
    },

    async insert(documents: BenchDocument[]) {
      if (!ms) return
      ms.addAll(documents.map(d => ({ id: d.id, title: d.title, body: d.body }) as BenchDocument))
    },

    async search(query: string) {
      if (!ms) return 0
      return ms.search(query).length
    },

    async teardown() {
      ms = null
    },
  }
}

export function createMiniSearchFullSchemaAdapter(): SearchEngine {
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
      if (!ms) return
      ms.addAll(documents)
    },

    async search(query: string) {
      if (!ms) return 0
      return ms.search(query).length
    },

    async teardown() {
      ms = null
    },
  }
}
