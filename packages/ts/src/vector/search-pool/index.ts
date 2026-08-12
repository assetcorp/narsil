import { resolveWorkerCount } from '../../workers/pool'
import type { VectorMetric } from '../brute-force'
import type { OrdinalFilter } from '../ordinal-filter'
import type { SharedGenerationSnapshot } from '../shared-generation/types'
import type { WorkerCopySnapshot } from '../worker-copy'
import type { VectorOrdinalSearchRequest, VectorSearchRequest, VectorWorkerMessage } from './messages'
import { listen, listenForFailure, resolveWorkerEntryPoint, spawnWorker, type WorkerHandle } from './spawn'

const SEARCH_TIMEOUT_MS = 30_000
const LOAD_TIMEOUT_MS = 300_000

export interface WorkerCopySearchResult {
  docId: string
  score: number
}

export interface OrdinalSearchResult {
  ordinals: Uint32Array
  scores: Float64Array
}

export interface VectorSearchPool {
  readonly workerCount: number
  readonly scratchSlotCount: number
  load(handle: string, snapshot: WorkerCopySnapshot): Promise<boolean>
  loadShared(handle: string, snapshot: SharedGenerationSnapshot): Promise<boolean>
  drop(handle: string): Promise<void>
  search(
    handle: string,
    query: Float32Array,
    k: number,
    metric: VectorMetric,
    minSimilarity: number,
    efSearch?: number,
    filter?: OrdinalFilter,
  ): Promise<WorkerCopySearchResult[]>
  searchOrdinals(
    handle: string,
    query: Float32Array,
    k: number,
    metric: VectorMetric,
    minSimilarity: number,
    efSearch?: number,
    filter?: OrdinalFilter,
  ): Promise<OrdinalSearchResult>
  shutdown(): Promise<void>
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
      const key = message.requestId
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

  function pickSlot(): WorkerSlot | null {
    let slot: WorkerSlot | null = null
    for (const candidate of slots) {
      if (!candidate.alive) continue
      if (slot === null || candidate.outstanding < slot.outstanding) slot = candidate
      if (slot.outstanding === 0) break
    }
    return slot
  }

  async function sendSearch(
    slot: WorkerSlot,
    request: VectorSearchRequest | VectorOrdinalSearchRequest,
  ): Promise<VectorWorkerMessage> {
    slot.outstanding += 1
    try {
      return await send(slot, request.requestId, request, SEARCH_TIMEOUT_MS)
    } finally {
      slot.outstanding -= 1
    }
  }

  return {
    get workerCount() {
      return slots.filter(slot => slot.alive).length
    },

    get scratchSlotCount() {
      return slots.length
    },

    async load(handle: string, snapshot: WorkerCopySnapshot): Promise<boolean> {
      const outcomes = await Promise.allSettled(
        slots.map(slot => {
          requestCounter += 1
          const requestId = `${requestCounter}`
          return send(slot, requestId, { type: 'load', requestId, handle, snapshot }, LOAD_TIMEOUT_MS)
        }),
      )
      return outcomes.every(
        outcome => outcome.status === 'fulfilled' && (outcome.value as VectorWorkerMessage).type === 'ack',
      )
    },

    async loadShared(handle: string, snapshot: SharedGenerationSnapshot): Promise<boolean> {
      const outcomes = await Promise.allSettled(
        slots.map((slot, scratchSlot) => {
          requestCounter += 1
          const requestId = `${requestCounter}`
          return send(
            slot,
            requestId,
            { type: 'loadShared', requestId, handle, scratchSlot, snapshot },
            LOAD_TIMEOUT_MS,
          )
        }),
      )
      return outcomes.every(
        outcome => outcome.status === 'fulfilled' && (outcome.value as VectorWorkerMessage).type === 'ack',
      )
    },

    async drop(handle: string): Promise<void> {
      await Promise.allSettled(
        slots.map(slot => {
          requestCounter += 1
          const requestId = `${requestCounter}`
          return send(slot, requestId, { type: 'drop', requestId, handle }, SEARCH_TIMEOUT_MS)
        }),
      )
    },

    async search(
      handle: string,
      query: Float32Array,
      k: number,
      metric: VectorMetric,
      minSimilarity: number,
      efSearch?: number,
      filter?: OrdinalFilter,
    ): Promise<WorkerCopySearchResult[]> {
      const slot = pickSlot()
      if (slot === null) throw new Error('No vector search worker is running')

      requestCounter += 1
      const request: VectorSearchRequest = {
        type: 'search',
        requestId: `${requestCounter}`,
        handle,
        query,
        k,
        metric,
        minSimilarity,
        ...(filter !== undefined ? { filter } : {}),
        ...(efSearch !== undefined ? { efSearch } : {}),
      }

      const message = await sendSearch(slot, request)
      if (message.type === 'error') throw new Error(message.message)
      if (message.type !== 'result') throw new Error('Vector search worker returned an unexpected message')

      const results: WorkerCopySearchResult[] = new Array(message.docIds.length)
      for (let i = 0; i < message.docIds.length; i++) {
        results[i] = { docId: message.docIds[i], score: message.scores[i] }
      }
      return results
    },

    async searchOrdinals(
      handle: string,
      query: Float32Array,
      k: number,
      metric: VectorMetric,
      minSimilarity: number,
      efSearch?: number,
      filter?: OrdinalFilter,
    ): Promise<OrdinalSearchResult> {
      const slot = pickSlot()
      if (slot === null) throw new Error('No vector search worker is running')

      requestCounter += 1
      const request: VectorOrdinalSearchRequest = {
        type: 'searchOrdinals',
        requestId: `${requestCounter}`,
        handle,
        query,
        k,
        metric,
        minSimilarity,
        ...(filter !== undefined ? { filter } : {}),
        ...(efSearch !== undefined ? { efSearch } : {}),
      }

      const message = await sendSearch(slot, request)
      if (message.type === 'error') throw new Error(message.message)
      if (message.type !== 'ordinalResult') throw new Error('Vector search worker returned an unexpected message')

      return { ordinals: message.ordinals, scores: message.scores }
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
