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
import { scifact, tmdb, wikipedia } from '@delali/narsil-example-shared/manifest'
import { scifactSchema, tmdbSchema, wikipediaSchema } from '@delali/narsil-example-shared/schemas'
import type { LoadDatasetRequest } from '@delali/narsil-example-shared/types'
import { findDataRoot, readDocumentsFile } from './dataset-files'
import { NarsilServerClient } from './narsil-server-client'
import type { NarsilServerConfig } from './server-config'

const WIKIPEDIA_LANGUAGE_NAMES: Record<string, string> = {
  en: 'english',
  fr: 'french',
  ee: 'ewe',
  zu: 'zulu',
  tw: 'twi',
  yo: 'yoruba',
  sw: 'swahili',
  ha: 'hausa',
  dag: 'dagbani',
  ig: 'igbo',
}

function languageName(code: string): string {
  return WIKIPEDIA_LANGUAGE_NAMES[code] ?? 'english'
}

/* The Narsil server rejects JSON bodies above 16 MiB. The byte budget counts
 * UTF-16 code units, which understate UTF-8 bytes by up to 3x for non-ASCII
 * text, so 4M units keeps the worst case near 12 MiB. */
const MAX_BATCH_JSON_LENGTH = 4 * 1024 * 1024
const MAX_BATCH_DOCS = 500

/**
 * The server rejects inserting a document whose ID already exists, and the
 * bundled corpora contain occasional repeated rows (movies-100000.json ships
 * two IDs twice), so repeated IDs collapse to their first occurrence.
 */
export function dedupeDocumentsById(docs: Record<string, unknown>[]): Record<string, unknown>[] {
  const seen = new Set<string | number>()
  const unique: Record<string, unknown>[] = []
  for (const doc of docs) {
    const id = doc.id
    if (typeof id === 'string' || typeof id === 'number') {
      if (seen.has(id)) continue
      seen.add(id)
    }
    unique.push(doc)
  }
  return unique
}

interface IndexLoadPlan {
  indexName: string
  datasetId: DatasetId
  schema: Record<string, unknown>
  language: string
  docs: Record<string, unknown>[]
}

/**
 * NarsilBackend implementation that performs every engine operation over REST
 * against a Narsil HTTP server. Dataset loading reads the example corpora from
 * disk on the app server and pushes them to the search server in batches.
 */
export class RestBackend implements NarsilBackend {
  private readonly client: NarsilServerClient
  private listeners = new Map<string, Set<BackendEventHandler<BackendEventType>>>()

  constructor(config: NarsilServerConfig) {
    this.client = new NarsilServerClient(config)
  }

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

  private async insertBatched(plan: IndexLoadPlan, signal?: AbortSignal): Promise<void> {
    const docs = dedupeDocumentsById(plan.docs)
    const total = docs.length
    let indexed = 0
    this.emit('progress', { datasetId: plan.datasetId, phase: 'indexing', totalDocs: total, indexedDocs: 0 })

    let batch: string[] = []
    let batchLength = 0
    const flush = async (): Promise<void> => {
      if (batch.length === 0) return
      signal?.throwIfAborted()
      const result = await this.client.insertBatchSerialized(plan.indexName, batch, signal)
      if (result.failed.length > 0) {
        const first = result.failed[0]
        throw new Error(`${result.failed.length} documents failed to index (first: ${first.error.message})`)
      }
      indexed += batch.length
      batch = []
      batchLength = 0
      this.emit('progress', { datasetId: plan.datasetId, phase: 'indexing', totalDocs: total, indexedDocs: indexed })
    }

    for (const doc of docs) {
      const json = JSON.stringify(doc)
      if (batch.length > 0 && (batchLength + json.length > MAX_BATCH_JSON_LENGTH || batch.length >= MAX_BATCH_DOCS)) {
        await flush()
      }
      batch.push(json)
      batchLength += json.length
    }
    await flush()
  }

  /** Creates the index and fills it. A partially filled index is dropped on
   * failure so a retry starts clean instead of being skipped as loaded. */
  private async createAndFill(plan: IndexLoadPlan, signal?: AbortSignal): Promise<void> {
    await this.client.createIndex(plan.indexName, { schema: plan.schema, language: plan.language })
    try {
      await this.insertBatched(plan, signal)
    } catch (err) {
      try {
        await this.client.dropIndex(plan.indexName)
      } catch {
        // The server may be unreachable; the partial index is reported below.
      }
      throw err
    }
  }

  private async loadIndexIfMissing(plan: IndexLoadPlan, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    const existing = await this.client.listIndexes()
    if (!existing.some(idx => idx.name === plan.indexName)) {
      await this.createAndFill(plan, signal)
    }
    this.emit('ready', { indexName: plan.indexName })
  }

  async loadDataset(request: LoadDatasetRequest, options?: { signal?: AbortSignal }): Promise<void> {
    const signal = options?.signal
    this.emit('progress', { datasetId: request.datasetId, phase: 'indexing' })

    try {
      const dataRoot = findDataRoot()

      switch (request.datasetId) {
        case 'tmdb': {
          const tierData = tmdb.tiers.find(t => t.label === request.tier)
          if (!tierData) throw new Error(`Unknown TMDB tier: ${request.tier}`)
          await this.loadIndexIfMissing(
            {
              indexName: `tmdb-${request.tier}`,
              datasetId: request.datasetId,
              schema: tmdbSchema as Record<string, unknown>,
              language: 'english',
              docs: await readDocumentsFile(dataRoot, 'tmdb', tierData.file),
            },
            signal,
          )
          break
        }

        case 'wikipedia': {
          for (const langCode of request.languages) {
            const langData = wikipedia.languages.find(l => l.code === langCode)
            if (!langData) continue
            await this.loadIndexIfMissing(
              {
                indexName: `wikipedia-${langCode}`,
                datasetId: request.datasetId,
                schema: wikipediaSchema as Record<string, unknown>,
                language: languageName(langCode),
                docs: await readDocumentsFile(dataRoot, 'wikipedia', langData.file),
              },
              signal,
            )
          }
          break
        }

        case 'scifact': {
          await this.loadIndexIfMissing(
            {
              indexName: 'scifact',
              datasetId: request.datasetId,
              schema: scifactSchema as Record<string, unknown>,
              language: 'english',
              docs: await readDocumentsFile(dataRoot, 'scifact', scifact.docsFile),
            },
            signal,
          )
          break
        }

        case 'custom': {
          const { documents, schema, indexName, language } = request
          const existing = await this.client.listIndexes()
          if (existing.some(idx => idx.name === indexName)) {
            await this.client.dropIndex(indexName)
          }
          await this.createAndFill(
            {
              indexName,
              datasetId: request.datasetId,
              schema: schema as Record<string, unknown>,
              language: language ? languageName(language) : 'english',
              docs: documents,
            },
            signal,
          )
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
    const { indexName, ...params } = request
    return this.client.search(indexName, params as Record<string, unknown>)
  }

  async suggest(request: SuggestRequest): Promise<SuggestResponse> {
    return this.client.suggest(request.indexName, {
      prefix: request.prefix,
      limit: request.limit,
    })
  }

  async getStats(indexName: string): Promise<IndexStats> {
    return this.client.getStats(indexName)
  }

  async getPartitionStats(indexName: string): Promise<PartitionStats[]> {
    return this.client.getPartitionStats(indexName)
  }

  async getMemoryStats(): Promise<MemoryStatsResponse> {
    return this.client.getMemoryStats()
  }

  async listIndexes(): Promise<IndexListEntry[]> {
    return this.client.listIndexes()
  }

  async deleteIndex(indexName: string): Promise<void> {
    await this.client.dropIndex(indexName)
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
