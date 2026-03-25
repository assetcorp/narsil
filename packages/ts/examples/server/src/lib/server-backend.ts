import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { createNarsil, registerLanguage } from '@delali/narsil'
import { createMemoryPersistence } from '@delali/narsil/adapters/memory'
import type {
  BackendEventHandler,
  BackendEventType,
  IndexListEntry,
  IndexStats,
  MemoryStatsResponse,
  NarsilBackend,
  PartitionStats,
  QueryRequest,
  QueryResponse,
  SuggestRequest,
  SuggestResponse,
} from '@delali/narsil-example-shared/backend'
import type { DatasetId } from '@delali/narsil-example-shared/manifest'
import { cranfield, tmdb, wikipedia } from '@delali/narsil-example-shared/manifest'
import { cranfieldSchema, tmdbSchema, wikipediaSchema } from '@delali/narsil-example-shared/schemas'
import type { LoadDatasetRequest } from '@delali/narsil-example-shared/types'

type Narsil = Awaited<ReturnType<typeof createNarsil>>
type SchemaType = Parameters<Narsil['createIndex']>[1]['schema']

let instance: Narsil | null = null
let initPromise: Promise<Narsil> | null = null

async function getNarsil(): Promise<Narsil> {
  if (instance) return instance
  if (initPromise) return initPromise
  initPromise = createNarsil({ persistence: createMemoryPersistence() })
  try {
    instance = await initPromise
    return instance
  } catch (err) {
    instance = null
    throw err
  } finally {
    initPromise = null
  }
}

const LANGUAGE_MODULES: Record<string, { loader: () => Promise<Record<string, unknown>>; name: string }> = {
  en: { loader: () => import('@delali/narsil/languages/english'), name: 'english' },
  fr: { loader: () => import('@delali/narsil/languages/french'), name: 'french' },
  ee: { loader: () => import('@delali/narsil/languages/ewe'), name: 'ewe' },
  zu: { loader: () => import('@delali/narsil/languages/zulu'), name: 'zulu' },
  tw: { loader: () => import('@delali/narsil/languages/twi'), name: 'twi' },
  yo: { loader: () => import('@delali/narsil/languages/yoruba'), name: 'yoruba' },
  sw: { loader: () => import('@delali/narsil/languages/swahili'), name: 'swahili' },
  ha: { loader: () => import('@delali/narsil/languages/hausa'), name: 'hausa' },
  dag: { loader: () => import('@delali/narsil/languages/dagbani'), name: 'dagbani' },
  ig: { loader: () => import('@delali/narsil/languages/igbo'), name: 'igbo' },
}

function langName(code: string): string {
  return LANGUAGE_MODULES[code]?.name ?? 'english'
}

async function ensureLanguage(code: string) {
  const entry = LANGUAGE_MODULES[code]
  if (!entry) return
  const mod = await entry.loader()
  const langModule = mod[entry.name] as Parameters<typeof registerLanguage>[0]
  if (!langModule) {
    throw new Error(`Language module '${entry.name}' not found`)
  }
  registerLanguage(langModule)
}

function findDataRoot(): string {
  let dir = import.meta.dirname ?? process.cwd()
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, 'data', 'processed')
    if (existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return path.resolve(process.cwd(), 'data', 'processed')
}

function safeDataPath(dataRoot: string, ...segments: string[]): string {
  const resolved = path.resolve(dataRoot, ...segments)
  if (!resolved.startsWith(dataRoot)) {
    throw new Error(`Path traversal detected: ${segments.join('/')}`)
  }
  return resolved
}

const BATCH_SIZE = 500

export class ServerBackend implements NarsilBackend {
  private listeners = new Map<string, Set<BackendEventHandler<BackendEventType>>>()

  private emit<T extends BackendEventType>(event: T, payload: unknown) {
    const handlers = this.listeners.get(event)
    if (!handlers) return
    for (const handler of handlers) {
      try {
        handler(payload as never)
      } catch {
        // Prevent a failing handler from breaking other handlers
      }
    }
  }

  private async indexBatched(
    inst: Narsil,
    indexName: string,
    docs: Record<string, unknown>[],
    datasetId: DatasetId,
  ): Promise<void> {
    const total = docs.length
    let indexed = 0
    this.emit('progress', { datasetId, phase: 'indexing', totalDocs: total, indexedDocs: 0 })
    for (let i = 0; i < total; i += BATCH_SIZE) {
      const batch = docs.slice(i, i + BATCH_SIZE)
      await inst.insertBatch(indexName, batch, { skipClone: true })
      indexed += batch.length
      this.emit('progress', { datasetId, phase: 'indexing', totalDocs: total, indexedDocs: indexed })
      await new Promise<void>(resolve => setTimeout(resolve, 0))
    }
  }

  async loadDataset(request: LoadDatasetRequest): Promise<void> {
    this.emit('progress', { datasetId: request.datasetId, phase: 'indexing' })

    try {
      const inst = await getNarsil()
      const dataRoot = findDataRoot()

      switch (request.datasetId) {
        case 'tmdb': {
          const tierData = tmdb.tiers.find(t => t.label === request.tier)
          if (!tierData) throw new Error(`Unknown TMDB tier: ${request.tier}`)

          const indexName = `tmdb-${request.tier}`
          const existing = inst.listIndexes()
          if (!existing.some(idx => idx.name === indexName)) {
            const filePath = safeDataPath(dataRoot, 'tmdb', tierData.file)
            const docs = JSON.parse(await readFile(filePath, 'utf-8')) as Record<string, unknown>[]
            await inst.createIndex(indexName, { schema: tmdbSchema as SchemaType, language: 'english' })
            await this.indexBatched(inst, indexName, docs, request.datasetId)
          }
          this.emit('ready', { indexName })
          break
        }

        case 'wikipedia': {
          for (const langCode of request.languages) {
            const langData = wikipedia.languages.find(l => l.code === langCode)
            if (!langData) continue

            const indexName = `wikipedia-${langCode}`
            const existing = inst.listIndexes()
            if (!existing.some(idx => idx.name === indexName)) {
              await ensureLanguage(langCode)
              const filePath = safeDataPath(dataRoot, 'wikipedia', langData.file)
              const docs = JSON.parse(await readFile(filePath, 'utf-8')) as Record<string, unknown>[]
              await inst.createIndex(indexName, { schema: wikipediaSchema as SchemaType, language: langName(langCode) })
              await this.indexBatched(inst, indexName, docs, request.datasetId)
            }
            this.emit('ready', { indexName })
          }
          break
        }

        case 'cranfield': {
          const indexName = 'cranfield'
          const existing = inst.listIndexes()
          if (!existing.some(idx => idx.name === indexName)) {
            const filePath = safeDataPath(dataRoot, 'cranfield', cranfield.docsFile)
            const docs = JSON.parse(await readFile(filePath, 'utf-8')) as Record<string, unknown>[]
            await inst.createIndex(indexName, { schema: cranfieldSchema as SchemaType, language: 'english' })
            await this.indexBatched(inst, indexName, docs, request.datasetId)
          }
          this.emit('ready', { indexName })
          break
        }

        case 'custom': {
          const { documents, schema, indexName, language } = request
          const existing = inst.listIndexes()
          if (existing.some(idx => idx.name === indexName)) {
            await inst.dropIndex(indexName)
          }
          if (language) await ensureLanguage(language)
          await inst.createIndex(indexName, { schema: schema as SchemaType, language: language ?? 'english' })
          await this.indexBatched(inst, indexName, documents, request.datasetId)
          this.emit('ready', { indexName })
          break
        }
      }

      this.emit('progress', { datasetId: request.datasetId, phase: 'complete' })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.emit('error', { message })
      this.emit('progress', { datasetId: request.datasetId, phase: 'error', error: message })
      throw err
    }
  }

  async query(request: QueryRequest): Promise<QueryResponse> {
    const inst = await getNarsil()
    const { indexName, ...params } = request
    return inst.query(indexName, params as Parameters<Narsil['query']>[1]) as unknown as QueryResponse
  }

  async suggest(request: SuggestRequest): Promise<SuggestResponse> {
    const inst = await getNarsil()
    return inst.suggest(request.indexName, {
      prefix: request.prefix,
      limit: request.limit,
    }) as unknown as SuggestResponse
  }

  async getStats(indexName: string): Promise<IndexStats> {
    const inst = await getNarsil()
    return inst.getStats(indexName) as unknown as IndexStats
  }

  async getPartitionStats(indexName: string): Promise<PartitionStats[]> {
    const inst = await getNarsil()
    return inst.getPartitionStats(indexName) as unknown as PartitionStats[]
  }

  async getMemoryStats(): Promise<MemoryStatsResponse> {
    const inst = await getNarsil()
    return inst.getMemoryStats() as unknown as MemoryStatsResponse
  }

  async listIndexes(): Promise<IndexListEntry[]> {
    const inst = await getNarsil()
    return inst.listIndexes() as unknown as IndexListEntry[]
  }

  async deleteIndex(indexName: string): Promise<void> {
    const inst = await getNarsil()
    await inst.dropIndex(indexName)
  }

  subscribe<T extends BackendEventType>(event: T, handler: BackendEventHandler<T>): void {
    let handlers = this.listeners.get(event)
    if (!handlers) {
      handlers = new Set()
      this.listeners.set(event, handlers)
    }
    handlers.add(handler as BackendEventHandler<BackendEventType>)
  }

  unsubscribe<T extends BackendEventType>(event: T, handler: BackendEventHandler<T>): void {
    const handlers = this.listeners.get(event)
    if (!handlers) return
    handlers.delete(handler as BackendEventHandler<BackendEventType>)
  }
}
