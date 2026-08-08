import { spawnNodeWorker } from '#platform/node-worker'
import { detectRuntime } from '../runtime/detect'
import { resolveWorkerCount } from '../workers/pool'
import type { VectorMetric } from './brute-force'
import type { VectorReplicaSnapshot } from './replica'
import type { VectorSearchRequest, VectorWorkerMessage } from './search-worker'

const SEARCH_TIMEOUT_MS = 30_000
const LOAD_TIMEOUT_MS = 300_000

export interface ReplicaSearchResult {
  docId: string
  score: number
}

export interface VectorSearchPool {
  readonly workerCount: number
  load(handle: string, snapshot: VectorReplicaSnapshot): Promise<boolean>
  drop(handle: string): Promise<void>
  search(
    handle: string,
    query: Float32Array,
    k: number,
    metric: VectorMetric,
    minSimilarity: number,
    efSearch?: number,
  ): Promise<ReplicaSearchResult[]>
  shutdown(): Promise<void>
}

interface WorkerHandle {
  postMessage(msg: unknown, transfer?: ArrayBuffer[] | unknown[]): void
  on?(event: string, handler: (...args: unknown[]) => void): void
  addEventListener?(event: string, handler: (...args: unknown[]) => void): void
  unref?(): void
  terminate(): void | Promise<void>
}

interface PendingRequest {
  resolve(message: VectorWorkerMessage): void
  reject(err: Error): void
  timer: ReturnType<typeof setTimeout>
}

interface WorkerSlot {
  worker: WorkerHandle
  pending: Map<string, PendingRequest>
  alive: boolean
  outstanding: number
}

function resolveWorkerEntryPoint(): string {
  const base = import.meta.url
  const distIndex = base.lastIndexOf('/dist/')
  if (distIndex !== -1) {
    return new URL('vector/search-worker.mjs', base.slice(0, distIndex + 6)).href
  }
  return base.replace(/\/src\/vector\/[^/]+$/, '/dist/vector/search-worker.mjs')
}

async function spawnWorker(entryPoint: string): Promise<WorkerHandle | null> {
  const runtime = detectRuntime()

  if (runtime.supportsWorkerThreads) {
    try {
      return await spawnNodeWorker(new URL(entryPoint))
    } catch {
      return null
    }
  }

  if (runtime.supportsWebWorkers) {
    try {
      const WorkerCtor = (globalThis as Record<string, unknown>).Worker as
        | (new (
            url: string | URL,
            options?: { type?: string },
          ) => WorkerHandle)
        | undefined
      if (typeof WorkerCtor !== 'function') return null
      return new WorkerCtor(entryPoint, { type: 'module' })
    } catch {
      return null
    }
  }

  return null
}

function listen(worker: WorkerHandle, handler: (msg: unknown) => void): void {
  if (typeof worker.on === 'function') {
    worker.on('message', handler)
    return
  }
  worker.addEventListener?.('message', (event: unknown) => {
    handler((event as { data: unknown }).data)
  })
}

function listenForFailure(worker: WorkerHandle, handler: (err: Error) => void): void {
  if (typeof worker.on === 'function') {
    worker.on('error', (err: unknown) => handler(err instanceof Error ? err : new Error(String(err))))
    worker.on('exit', () => handler(new Error('Vector search worker exited')))
    return
  }
  worker.addEventListener?.('error', () => handler(new Error('Vector search worker failed')))
}

export async function createVectorSearchPool(requestedCount?: number): Promise<VectorSearchPool | null> {
  const entryPoint = resolveWorkerEntryPoint()
  const count = resolveWorkerCount(requestedCount)
  const slots: WorkerSlot[] = []

  for (let i = 0; i < count; i++) {
    const worker = await spawnWorker(entryPoint)
    if (worker === null) break
    const slot: WorkerSlot = { worker, pending: new Map(), alive: true, outstanding: 0 }

    listen(worker, raw => {
      const message = raw as VectorWorkerMessage
      const key = message.type === 'ack' ? message.handle : message.requestId
      if (typeof key !== 'string') return
      const waiting = slot.pending.get(key)
      if (!waiting) return
      slot.pending.delete(key)
      clearTimeout(waiting.timer)
      waiting.resolve(message)
    })

    listenForFailure(worker, err => {
      slot.alive = false
      for (const [, waiting] of slot.pending) {
        clearTimeout(waiting.timer)
        waiting.reject(err)
      }
      slot.pending.clear()
    })

    slots.push(slot)
  }

  if (slots.length === 0) return null

  let requestCounter = 0

  function send(slot: WorkerSlot, key: string, message: unknown, timeoutMs: number): Promise<VectorWorkerMessage> {
    return new Promise<VectorWorkerMessage>((resolve, reject) => {
      if (!slot.alive) {
        reject(new Error('Vector search worker is not running'))
        return
      }
      const timer = setTimeout(() => {
        slot.pending.delete(key)
        reject(new Error(`Vector search worker did not answer within ${timeoutMs}ms`))
      }, timeoutMs)
      slot.pending.set(key, { resolve, reject, timer })
      try {
        slot.worker.postMessage(message)
      } catch (err) {
        slot.pending.delete(key)
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  return {
    get workerCount() {
      return slots.filter(slot => slot.alive).length
    },

    async load(handle: string, snapshot: VectorReplicaSnapshot): Promise<boolean> {
      const outcomes = await Promise.allSettled(
        slots.map(slot => send(slot, handle, { type: 'load', handle, snapshot }, LOAD_TIMEOUT_MS)),
      )
      return outcomes.every(
        outcome => outcome.status === 'fulfilled' && (outcome.value as VectorWorkerMessage).type === 'ack',
      )
    },

    async drop(handle: string): Promise<void> {
      await Promise.allSettled(slots.map(slot => send(slot, handle, { type: 'drop', handle }, SEARCH_TIMEOUT_MS)))
    },

    async search(
      handle: string,
      query: Float32Array,
      k: number,
      metric: VectorMetric,
      minSimilarity: number,
      efSearch?: number,
    ): Promise<ReplicaSearchResult[]> {
      let slot: WorkerSlot | null = null
      for (const candidate of slots) {
        if (!candidate.alive) continue
        if (slot === null || candidate.outstanding < slot.outstanding) slot = candidate
        if (slot.outstanding === 0) break
      }
      if (slot === null) throw new Error('No vector search worker is running')

      requestCounter += 1
      const requestId = `${requestCounter}`

      const request: VectorSearchRequest = {
        type: 'search',
        requestId,
        handle,
        query,
        k,
        metric,
        minSimilarity,
        ...(efSearch !== undefined ? { efSearch } : {}),
      }

      slot.outstanding += 1
      let message: VectorWorkerMessage
      try {
        message = await send(slot, requestId, request, SEARCH_TIMEOUT_MS)
      } finally {
        slot.outstanding -= 1
      }
      if (message.type === 'error') throw new Error(message.message)
      if (message.type !== 'result') throw new Error('Vector search worker returned an unexpected message')

      const results: ReplicaSearchResult[] = new Array(message.docIds.length)
      for (let i = 0; i < message.docIds.length; i++) {
        results[i] = { docId: message.docIds[i], score: message.scores[i] }
      }
      return results
    },

    async shutdown(): Promise<void> {
      for (const slot of slots) {
        slot.alive = false
        for (const [, waiting] of slot.pending) {
          clearTimeout(waiting.timer)
          waiting.reject(new Error('Vector search pool has shut down'))
        }
        slot.pending.clear()
        try {
          await slot.worker.terminate()
        } catch {
          slot.alive = false
        }
      }
    },
  }
}

let sharedPool: Promise<VectorSearchPool | null> | null = null
let poolHolders = 0
let workersUnavailable = false

export function acquireVectorSearchPool(): Promise<VectorSearchPool | null> {
  poolHolders += 1
  if (workersUnavailable) return Promise.resolve(null)
  if (sharedPool === null) {
    sharedPool = createVectorSearchPool().then(
      pool => {
        if (pool === null) workersUnavailable = true
        return pool
      },
      () => {
        workersUnavailable = true
        return null
      },
    )
  }
  return sharedPool
}

export async function releaseVectorSearchPool(): Promise<void> {
  if (poolHolders === 0) return
  poolHolders -= 1
  if (poolHolders > 0 || sharedPool === null) return

  const pending = sharedPool
  sharedPool = null
  const pool = await pending
  await pool?.shutdown()
}
