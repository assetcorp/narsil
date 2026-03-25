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

  async loadDataset(request: LoadDatasetRequest): Promise<void> {
    const response = await fetch('/api/load', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    })

    if (!response.ok || !response.body) {
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

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const parts = buffer.split('\n\n')
      buffer = parts.pop() ?? ''

      for (const part of parts) {
        const line = part.trim()
        if (!line.startsWith('data: ')) continue
        try {
          const progress = JSON.parse(line.slice(6))
          this.emit('progress', progress)
        } catch {
          // Malformed event, skip
        }
      }
    }

    this.emit('progress', { datasetId: request.datasetId, phase: 'complete' })
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

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const parts = buffer.split('\n\n')
      buffer = parts.pop() ?? ''

      for (const part of parts) {
        const line = part.trim()
        if (!line.startsWith('data: ')) continue
        try {
          const { i, response: qr } = JSON.parse(line.slice(6)) as { i: number; response: QueryResponse }
          onResult(i, qr)
        } catch {
          // Malformed event, skip
        }
      }
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
