import MiniSearch from 'minisearch'
import { stemmer } from 'stemmer'
import type { BenchDocument, SearchEngine, SerializableEngine } from '../types'

function processTerm(term: string): string {
  return stemmer(term.toLowerCase())
}

export function createMiniSearchTextOnlyAdapter(): SearchEngine {
  let ms: MiniSearch<BenchDocument> | null = null

  return {
    name: 'minisearch',

    async create() {
      ms = new MiniSearch<BenchDocument>({
        fields: ['title', 'body'],
        storeFields: ['title', 'body'],
        idField: 'id',
        processTerm,
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

const FULL_SCHEMA_OPTIONS = {
  fields: ['title', 'body'],
  storeFields: ['title', 'body', 'score', 'category'],
  idField: 'id' as const,
  processTerm,
}

export function createMiniSearchFullSchemaAdapter(): SearchEngine {
  let ms: MiniSearch<BenchDocument> | null = null
  const trackedIds: string[] = []

  return {
    name: 'minisearch',
    insertedIds: trackedIds,

    async create() {
      ms = new MiniSearch<BenchDocument>(FULL_SCHEMA_OPTIONS)
      trackedIds.length = 0
    },

    async insert(documents: BenchDocument[]) {
      if (!ms) return
      ms.addAll(documents)
      for (const doc of documents) {
        trackedIds.push(doc.id)
      }
    },

    async search(query: string) {
      if (!ms) return 0
      return ms.search(query).length
    },

    async searchWithIds(query: string) {
      if (!ms) return []
      return ms
        .search(query)
        .slice(0, 10)
        .map(r => String(r.id))
    },

    async insertWithIds(documents: BenchDocument[]) {
      if (!ms) return
      ms.addAll(documents)
      for (const doc of documents) {
        trackedIds.push(doc.id)
      }
    },

    async remove(docId: string) {
      if (!ms) return
      ms.discard(docId)
    },

    async teardown() {
      ms = null
    },
  }
}

export function createMiniSearchSerializableAdapter(): SerializableEngine {
  let ms: MiniSearch<BenchDocument> | null = null

  return {
    name: 'minisearch',

    async create() {
      ms = new MiniSearch<BenchDocument>(FULL_SCHEMA_OPTIONS)
    },

    async insert(documents: BenchDocument[]) {
      if (!ms) return
      ms.addAll(documents)
    },

    async serialize() {
      if (!ms) return ''
      return JSON.stringify(ms)
    },

    async deserializeAndSearch(serialized: Uint8Array | string, query: string) {
      const restored = MiniSearch.loadJSON<BenchDocument>(serialized as string, FULL_SCHEMA_OPTIONS)
      return restored.search(query).length
    },

    async teardown() {
      ms = null
    },
  }
}
