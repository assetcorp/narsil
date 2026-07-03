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
import {
  EMBEDDING_ADAPTER_NAME,
  EMBEDDING_FIELD,
  type EmbeddingProviderConfig,
  embeddingSourceFields,
  readEmbeddingConfig,
  WIKIPEDIA_LEAD_FIELD,
  WIKIPEDIA_LEAD_MAX_CHARS,
} from './embedding-config'
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

/* Each insert batch becomes one embedding request on the search server, and
 * OpenAI rejects embedding requests past 300k total tokens. The largest
 * embedded source (title plus abstract or article lead) is ~1.6k chars ≈ 400
 * tokens, so 256 documents ≈ 100k tokens leaves 3x headroom per request. */
const MAX_BATCH_DOCS_WITH_EMBEDDING = 256

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
  embedding?: {
    sourceFields: string[]
    dimensions: number
  }
}

/**
 * Cuts the article lead for the embedding input, breaking on a word boundary
 * so the vector never ends mid-word.
 */
export function articleLead(text: string, maxChars: number = WIKIPEDIA_LEAD_MAX_CHARS): string {
  if (text.length <= maxChars) return text
  const slice = text.slice(0, maxChars)
  const lastSpace = slice.lastIndexOf(' ')
  return lastSpace > maxChars / 2 ? slice.slice(0, lastSpace) : slice
}

function withEmbeddingField(schema: Record<string, unknown>, dimensions: number): Record<string, unknown> {
  return { ...schema, [EMBEDDING_FIELD]: `vector[${dimensions}]` }
}

/**
 * Removes stored vector values from query hits before they leave the app
 * server. A 1536-dimension vector serializes to ~12 KB of JSON per hit and
 * carries no meaning for result rendering or answer prompts.
 */
function stripStoredVectors(response: QueryResponse): QueryResponse {
  const strip = (hit: QueryResponse['hits'][number]) => {
    if (EMBEDDING_FIELD in hit.document) {
      delete hit.document[EMBEDDING_FIELD]
    }
  }
  for (const hit of response.hits) strip(hit)
  if (response.groups) {
    for (const group of response.groups) {
      for (const hit of group.hits) strip(hit)
    }
  }
  return response
}

/**
 * Attaches the embedding arrangement to a dataset load when an embedding
 * provider is configured: the schema gains the vector field, and the create
 * request names the server-registered adapter so the search server embeds
 * each document at insert and each query at search time. Without a provider
 * the plan is exactly the keyword-only load this app always performed.
 */
function planEmbedding(plan: IndexLoadPlan, embedding: EmbeddingProviderConfig | null): IndexLoadPlan {
  if (!embedding) return plan
  const sourceFields = embeddingSourceFields(plan.datasetId)
  if (!sourceFields) return plan

  let schema = withEmbeddingField(plan.schema, embedding.dimensions)
  let docs = plan.docs
  if (plan.datasetId === 'wikipedia') {
    schema = { ...schema, [WIKIPEDIA_LEAD_FIELD]: 'string' }
    docs = docs.map(doc => ({ ...doc, [WIKIPEDIA_LEAD_FIELD]: articleLead(String(doc.text ?? '')) }))
  }

  return {
    ...plan,
    schema,
    docs,
    embedding: { sourceFields, dimensions: embedding.dimensions },
  }
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

    const maxBatchDocs = plan.embedding ? MAX_BATCH_DOCS_WITH_EMBEDDING : MAX_BATCH_DOCS
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
      if (batch.length > 0 && (batchLength + json.length > MAX_BATCH_JSON_LENGTH || batch.length >= maxBatchDocs)) {
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
    await this.client.createIndex(plan.indexName, {
      schema: plan.schema,
      language: plan.language,
      embedding: plan.embedding
        ? {
            fields: { [EMBEDDING_FIELD]: plan.embedding.sourceFields },
            adapter: EMBEDDING_ADAPTER_NAME,
          }
        : undefined,
    })
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
      const embedding = readEmbeddingConfig()

      switch (request.datasetId) {
        case 'tmdb': {
          const tierData = tmdb.tiers.find(t => t.label === request.tier)
          if (!tierData) throw new Error(`Unknown TMDB tier: ${request.tier}`)
          await this.loadIndexIfMissing(
            planEmbedding(
              {
                indexName: `tmdb-${request.tier}`,
                datasetId: request.datasetId,
                schema: tmdbSchema as Record<string, unknown>,
                language: 'english',
                docs: await readDocumentsFile(dataRoot, 'tmdb', tierData.file),
              },
              embedding,
            ),
            signal,
          )
          break
        }

        case 'wikipedia': {
          for (const langCode of request.languages) {
            const langData = wikipedia.languages.find(l => l.code === langCode)
            if (!langData) continue
            await this.loadIndexIfMissing(
              planEmbedding(
                {
                  indexName: `wikipedia-${langCode}`,
                  datasetId: request.datasetId,
                  schema: wikipediaSchema as Record<string, unknown>,
                  language: languageName(langCode),
                  docs: await readDocumentsFile(dataRoot, 'wikipedia', langData.file),
                },
                embedding,
              ),
              signal,
            )
          }
          break
        }

        case 'scifact': {
          await this.loadIndexIfMissing(
            planEmbedding(
              {
                indexName: 'scifact',
                datasetId: request.datasetId,
                schema: scifactSchema as Record<string, unknown>,
                language: 'english',
                docs: await readDocumentsFile(dataRoot, 'scifact', scifact.docsFile),
              },
              embedding,
            ),
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

  async query(request: QueryRequest, signal?: AbortSignal): Promise<QueryResponse> {
    const { indexName, ...params } = request
    const response = await this.client.search(indexName, params as Record<string, unknown>, signal)
    return stripStoredVectors(response)
  }

  async suggest(request: SuggestRequest): Promise<SuggestResponse> {
    return this.client.suggest(request.indexName, {
      prefix: request.prefix,
      limit: request.limit,
    })
  }

  async getDocument(indexName: string, docId: string): Promise<Record<string, unknown> | null> {
    const document = await this.client.getDocument(indexName, docId)
    if (document && EMBEDDING_FIELD in document) {
      delete document[EMBEDDING_FIELD]
    }
    return document
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
