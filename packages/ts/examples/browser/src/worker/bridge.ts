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
import type { WorkerOutbound, WorkerRequest } from './messages'

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

let requestCounter = 0

function nextId(): string {
  return `req_${++requestCounter}_${Date.now()}`
}

export class WorkerBackend implements NarsilBackend {
  private worker: Worker | null = null
  private pending = new Map<string, PendingRequest>()
  private listeners = new Map<string, Set<BackendEventHandler<BackendEventType>>>()

  private getWorker(): Worker {
    if (this.worker) return this.worker

    this.worker = new Worker(new URL('./narsil-worker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (event: MessageEvent<WorkerOutbound>) => {
      this.handleMessage(event.data)
    }
    this.worker.onerror = (event: ErrorEvent) => {
      const message = event.message || 'Worker error'
      this.rejectAllPending(message)
      this.emit('error', { message })
    }
    return this.worker
  }

  private rejectAllPending(reason: string) {
    for (const [, pending] of this.pending) {
      pending.reject(new Error(reason))
    }
    this.pending.clear()
  }

  destroy() {
    this.rejectAllPending('Worker backend destroyed')
    this.worker?.terminate()
    this.worker = null
    this.listeners.clear()
  }

  private handleMessage(msg: WorkerOutbound) {
    if (msg.type === 'progress') {
      this.emit('progress', msg.payload)
      return
    }

    const pending = this.pending.get(msg.requestId)
    if (!pending) return
    this.pending.delete(msg.requestId)

    if (msg.error) {
      pending.reject(new Error(msg.error))
    } else {
      pending.resolve(msg.result)
    }
  }

  private send(type: WorkerRequest['type'], payload: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const requestId = nextId()
      this.pending.set(requestId, { resolve, reject })
      const msg: WorkerRequest = { requestId, type, payload }
      this.getWorker().postMessage(msg)
    })
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

  async loadDataset(request: LoadDatasetRequest): Promise<void> {
    await this.send('loadDataset', { request })
  }

  async query(request: QueryRequest): Promise<QueryResponse> {
    return this.send('query', request) as Promise<QueryResponse>
  }

  async suggest(request: SuggestRequest): Promise<SuggestResponse> {
    return this.send('suggest', request) as Promise<SuggestResponse>
  }

  async getStats(indexName: string): Promise<IndexStats> {
    return this.send('getStats', { indexName }) as Promise<IndexStats>
  }

  async getPartitionStats(indexName: string): Promise<PartitionStats[]> {
    return this.send('getPartitionStats', { indexName }) as Promise<PartitionStats[]>
  }

  async getMemoryStats(): Promise<MemoryStatsResponse> {
    return this.send('getMemoryStats', {}) as Promise<MemoryStatsResponse>
  }

  async listIndexes(): Promise<IndexListEntry[]> {
    return this.send('listIndexes', {}) as Promise<IndexListEntry[]>
  }

  async deleteIndex(indexName: string): Promise<void> {
    await this.send('deleteIndex', { indexName })
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
