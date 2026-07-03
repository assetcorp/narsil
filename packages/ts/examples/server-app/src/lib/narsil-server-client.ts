import type {
  IndexListEntry,
  IndexStats,
  MemoryStatsResponse,
  PartitionStats,
  QueryResponse,
  SuggestResponse,
} from '@delali/narsil-example-shared/backend'
import type { NarsilServerConfig } from './server-config'

const READ_TIMEOUT_MS = 30_000
const BATCH_WRITE_TIMEOUT_MS = 120_000

interface ErrorEnvelope {
  error?: { code?: string; message?: string }
}

export interface BatchInsertResult {
  succeeded: string[]
  failed: Array<{ docId: string; error: { code: string; message: string } }>
}

export interface CreateIndexConfig {
  schema: Record<string, unknown>
  language: string
}

export class NarsilServerError extends Error {
  readonly status: number
  readonly code: string

  constructor(message: string, status: number, code: string) {
    super(message)
    this.name = 'NarsilServerError'
    this.status = status
    this.code = code
  }
}

/**
 * Minimal REST client for the routes this app uses on a Narsil HTTP server.
 * Runs only in the app's server-side code so the API key never reaches the
 * browser.
 */
export class NarsilServerClient {
  private readonly baseUrl: string
  private readonly apiKey: string | undefined

  constructor(config: NarsilServerConfig) {
    this.baseUrl = config.baseUrl
    this.apiKey = config.apiKey
  }

  private async request<T>(method: string, path: string, body?: string, timeoutMs = READ_TIMEOUT_MS): Promise<T> {
    const headers: Record<string, string> = {}
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`

    let response: Response
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new Error(`The Narsil server did not respond within ${timeoutMs}ms (${method} ${path})`)
      }
      throw new Error(
        `The Narsil server is unreachable at ${this.baseUrl}. Start it, or fix NARSIL_SERVER_URL. (${method} ${path})`,
      )
    }

    const text = await response.text()
    if (!response.ok) {
      let code = 'HTTP_ERROR'
      let message = `${method} ${path} failed with status ${response.status}`
      try {
        const envelope = JSON.parse(text) as ErrorEnvelope
        if (envelope.error?.message) {
          message = envelope.error.message
          code = envelope.error.code ?? code
        }
      } catch {
        // Non-JSON error body; the status-based message stands.
      }
      throw new NarsilServerError(message, response.status, code)
    }
    return JSON.parse(text) as T
  }

  async createIndex(name: string, config: CreateIndexConfig): Promise<void> {
    await this.request('POST', '/indexes', JSON.stringify({ name, config }))
  }

  /**
   * Inserts documents that are already serialized to JSON. The batch body is
   * assembled from the per-document strings so each document is stringified
   * exactly once across batch sizing and transport.
   */
  async insertBatchSerialized(indexName: string, documentJsons: string[]): Promise<BatchInsertResult> {
    const body = `{"action":"insert","documents":[${documentJsons.join(',')}],"options":{"skipClone":true}}`
    return this.request<BatchInsertResult>(
      'POST',
      `/indexes/${encodeURIComponent(indexName)}/documents/_batch`,
      body,
      BATCH_WRITE_TIMEOUT_MS,
    )
  }

  async search(indexName: string, params: Record<string, unknown>): Promise<QueryResponse> {
    return this.request<QueryResponse>(
      'POST',
      `/indexes/${encodeURIComponent(indexName)}/search`,
      JSON.stringify(params),
    )
  }

  async suggest(indexName: string, params: { prefix: string; limit?: number }): Promise<SuggestResponse> {
    return this.request<SuggestResponse>(
      'POST',
      `/indexes/${encodeURIComponent(indexName)}/suggest`,
      JSON.stringify(params),
    )
  }

  async getStats(indexName: string): Promise<IndexStats> {
    return this.request<IndexStats>('GET', `/indexes/${encodeURIComponent(indexName)}/stats`)
  }

  async getPartitionStats(indexName: string): Promise<PartitionStats[]> {
    const result = await this.request<{ partitions: PartitionStats[] }>(
      'GET',
      `/indexes/${encodeURIComponent(indexName)}/partitions`,
    )
    return result.partitions
  }

  async getMemoryStats(): Promise<MemoryStatsResponse> {
    return this.request<MemoryStatsResponse>('GET', '/stats/memory')
  }

  async listIndexes(): Promise<IndexListEntry[]> {
    const result = await this.request<{ indexes: IndexListEntry[] }>('GET', '/indexes')
    return result.indexes
  }

  async dropIndex(indexName: string): Promise<void> {
    await this.request('DELETE', `/indexes/${encodeURIComponent(indexName)}`)
  }
}
