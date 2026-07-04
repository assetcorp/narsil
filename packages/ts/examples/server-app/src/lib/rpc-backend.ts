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
import type { LoadDatasetRequest } from '@delali/narsil-example-shared/types'
import { watchLoadJob } from './load-status-client'
import {
  deleteIndexFn,
  getMemoryStatsFn,
  getPartitionStatsFn,
  getStatsFn,
  listIndexesFn,
  queryFn,
  suggestFn,
} from './server-fns'

export class RpcBackend implements NarsilBackend {
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

  /** Starts a server-side load job and follows it by polling. The job runs to
   * completion on the app server even if this page reloads or closes. */
  async loadDataset(request: LoadDatasetRequest): Promise<void> {
    const response = await fetch('/api/load', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    })

    if (!response.ok) {
      const text = await response.text()
      let message = `Load failed: ${response.status}`
      try {
        const parsed = JSON.parse(text) as { error?: string }
        if (parsed.error) message = parsed.error
      } catch {
        // Use status-based message
      }
      this.emit('progress', { datasetId: request.datasetId, phase: 'error', error: message })
      throw new Error(message)
    }

    await watchLoadJob(request.datasetId, progress => {
      this.emit('progress', progress)
    })
  }

  async query(request: QueryRequest): Promise<QueryResponse> {
    return queryFn({ data: request }) as Promise<QueryResponse>
  }

  async batchQuery(
    requests: QueryRequest[],
    onResult: (index: number, response: QueryResponse) => void,
  ): Promise<void> {
    const response = await fetch('/api/batch-query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ queries: requests }),
    })

    if (!response.ok || !response.body) {
      throw new Error(`Batch query failed: ${response.status}`)
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let failure: string | undefined

    for (;;) {
      const { done, value } = await reader.read()
      if (done || failure !== undefined) break

      buffer += decoder.decode(value, { stream: true })
      const parts = buffer.split('\n\n')
      buffer = parts.pop() ?? ''

      for (const part of parts) {
        const line = part.trim()
        if (!line.startsWith('data: ')) continue
        try {
          const parsed = JSON.parse(line.slice(6)) as { i?: number; response?: QueryResponse; error?: string }
          if (typeof parsed.error === 'string') {
            failure = parsed.error
            break
          }
          if (typeof parsed.i === 'number' && parsed.response !== undefined) {
            onResult(parsed.i, parsed.response)
          }
        } catch {
          // Malformed event, skip
        }
      }
    }

    if (failure !== undefined) {
      await reader.cancel().catch(() => {})
      throw new Error(failure)
    }
  }

  async suggest(request: SuggestRequest): Promise<SuggestResponse> {
    return suggestFn({ data: request }) as Promise<SuggestResponse>
  }

  async getStats(indexName: string): Promise<IndexStats> {
    return getStatsFn({ data: { indexName } }) as Promise<IndexStats>
  }

  async getPartitionStats(indexName: string): Promise<PartitionStats[]> {
    return getPartitionStatsFn({ data: { indexName } }) as Promise<PartitionStats[]>
  }

  async getMemoryStats(): Promise<MemoryStatsResponse> {
    return getMemoryStatsFn() as Promise<MemoryStatsResponse>
  }

  async listIndexes(): Promise<IndexListEntry[]> {
    return listIndexesFn() as Promise<IndexListEntry[]>
  }

  async deleteIndex(indexName: string): Promise<void> {
    await deleteIndexFn({ data: { indexName } })
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
