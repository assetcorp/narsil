import { ClientErrorCodes, NarsilError } from '@delali/narsil'
import type { DatasetLoadProgress } from '@delali/narsil-example-shared'
import {
  transferableBuffersIn,
  type WorkerArgs,
  type WorkerMethod,
  type WorkerOutbound,
  type WorkerRequest,
  type WorkerResult,
} from './protocol'

const CHANGE_COALESCE_MS = 150

interface PendingCall {
  resolve: (value: unknown) => void
  reject: (error: NarsilError) => void
}

/**
 * Calls the engine running in the Web Worker. Every method mirrors the one on
 * `Narsil` it forwards to, and a failure arrives as the `NarsilError` the
 * engine threw, under the code it carried.
 */
export class NarsilWorkerClient {
  private worker: Worker | null = null
  private nextId = 0
  private readonly pending = new Map<string, PendingCall>()
  private readonly progressListeners = new Set<(progress: DatasetLoadProgress) => void>()
  private readonly changeListeners = new Set<() => void>()
  private readonly revisions = new Map<string, number>()
  private readonly changedIndexes = new Set<string>()
  private changeTimer: ReturnType<typeof setTimeout> | null = null
  private allRevision = 0

  private connect(): Worker {
    if (this.worker !== null) return this.worker

    const worker = new Worker(new URL('./narsil-worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent<WorkerOutbound>) => {
      this.receive(event.data)
    }
    worker.onerror = (event: ErrorEvent) => {
      this.failAll(event.message || 'The search worker stopped')
    }
    this.worker = worker
    return worker
  }

  private receive(message: WorkerOutbound): void {
    if (message.kind === 'progress') {
      for (const listener of this.progressListeners) listener(message.progress)
      return
    }
    if (message.kind === 'changed') {
      this.queueChange(message.indexName)
      return
    }

    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)

    if (message.kind === 'failure') {
      pending.reject(new NarsilError(message.code, message.message))
      return
    }
    pending.resolve(message.result)
  }

  private queueChange(indexName: string): void {
    this.changedIndexes.add(indexName)
    if (this.changeTimer !== null) return
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null
      for (const name of this.changedIndexes) this.revisions.set(name, (this.revisions.get(name) ?? 0) + 1)
      this.changedIndexes.clear()
      this.allRevision += 1
      for (const listener of this.changeListeners) listener()
    }, CHANGE_COALESCE_MS)
  }

  private failAll(message: string): void {
    for (const [, pending] of this.pending) {
      pending.reject(new NarsilError(ClientErrorCodes.CLIENT_CONNECTION_FAILED, message))
    }
    this.pending.clear()
  }

  call<K extends WorkerMethod>(method: K, args: WorkerArgs<K>, signal?: AbortSignal): Promise<WorkerResult<K>> {
    if (signal?.aborted === true) {
      return Promise.reject(new NarsilError(ClientErrorCodes.CLIENT_REQUEST_ABORTED, 'The request was aborted'))
    }

    const id = `call-${++this.nextId}`
    const request: WorkerRequest<K> = { id, method, args }

    return new Promise<WorkerResult<K>>((resolve, reject) => {
      const onAbort = () => {
        this.pending.delete(id)
        reject(new NarsilError(ClientErrorCodes.CLIENT_REQUEST_ABORTED, 'The request was aborted'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })

      this.pending.set(id, {
        resolve: value => {
          signal?.removeEventListener('abort', onAbort)
          resolve(value as WorkerResult<K>)
        },
        reject: error => {
          signal?.removeEventListener('abort', onAbort)
          reject(error)
        },
      })
      this.connect().postMessage(request, { transfer: transferableBuffersIn(args) })
    })
  }

  onProgress(listener: (progress: DatasetLoadProgress) => void): () => void {
    this.progressListeners.add(listener)
    return () => {
      this.progressListeners.delete(listener)
    }
  }

  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener)
    return () => {
      this.changeListeners.delete(listener)
    }
  }

  revisionOf(indexName: string | null): number {
    return indexName === null ? this.allRevision : (this.revisions.get(indexName) ?? 0)
  }
}

export const narsilWorker = new NarsilWorkerClient()
