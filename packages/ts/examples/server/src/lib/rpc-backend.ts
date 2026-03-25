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
  loadDatasetFn,
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
    this.emit('progress', { datasetId: request.datasetId, phase: 'indexing' })
    try {
      await loadDatasetFn({ data: request })
      this.emit('progress', { datasetId: request.datasetId, phase: 'complete' })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.emit('progress', { datasetId: request.datasetId, phase: 'error', error: message })
      throw err
    }
  }

  async query(request: QueryRequest): Promise<QueryResponse> {
    return queryFn({ data: request }) as Promise<QueryResponse>
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
