import { resolveWorkerCount } from '../../workers/pool'
import type { VectorMetric } from '../brute-force'
import {
  VECTOR_INSERT_TIMEOUT_MS,
  VECTOR_SCRATCH_SLOTS,
  VECTOR_SEARCH_LOAD_TIMEOUT_MS,
  VECTOR_SEARCH_TIMEOUT_MS,
} from '../constants'
import { releaseLocksHeldBy } from '../hnsw/locks'
import type { OrdinalFilter } from '../ordinal-filter'
import type { GraphInsertOutcome, SharedVectorFieldHandles } from '../shared-field/types'
import type { WorkerCopySnapshot } from '../worker-copy'
import type {
  VectorInsertRequest,
  VectorOrdinalSearchRequest,
  VectorSearchRequest,
  VectorWorkerMessage,
} from './messages'
import { listen, listenForFailure, resolveWorkerEntryPoint, spawnWorker, type WorkerHandle } from './spawn'

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
  load(handle: string, snapshot: WorkerCopySnapshot): Promise<boolean>
  loadShared(handle: string, handles: SharedVectorFieldHandles): Promise<boolean>
  drop(handle: string): Promise<void>
  insertOrdinals(handle: string, ordinals: Int32Array): Promise<GraphInsertOutcome | null>
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
  scratchSlot: number
  pending: Map<string, PendingRequest>
  alive: boolean
  outstanding: number
}

/**
 * Reports the scratch slot a search pool worker uses, counted down from the
 * top so that it stays clear of a request thread's slot, which counts up from
 * one.
 *
 * @param index The worker's index in its pool.
 * @returns The slot the worker writes its query scratch into.
 *
 * @internal
 */
export function searchPoolScratchSlot(index: number): number {
  return VECTOR_SCRATCH_SLOTS - 1 - index
}

export async function createVectorSearchPool(requestedCount?: number): Promise<VectorSearchPool | null> {
  const entryPoint = resolveWorkerEntryPoint()
  const count = resolveWorkerCount(requestedCount)
  const slots: WorkerSlot[] = []
  const sharedFields = new Map<string, SharedVectorFieldHandles>()

  for (let i = 0; i < count; i++) {
    const worker = await spawnWorker(entryPoint)
    if (worker === null) break
    const slot: WorkerSlot = {
      worker,
      scratchSlot: searchPoolScratchSlot(i),
      pending: new Map(),
      alive: true,
      outstanding: 0,
    }

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
      for (const handles of sharedFields.values()) {
        if (handles.graph !== null) releaseLocksHeldBy(handles.graph, slot.scratchSlot)
      }
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

  async function sendBusy(slot: WorkerSlot, request: { requestId: string }, timeoutMs: number) {
    slot.outstanding += 1
    try {
      return await send(slot, request.requestId, request, timeoutMs)
    } finally {
      slot.outstanding -= 1
    }
  }

  async function broadcast(build: (slot: WorkerSlot, requestId: string) => unknown, timeoutMs: number) {
    const outcomes = await Promise.allSettled(
      slots.map(slot => {
        requestCounter += 1
        const requestId = `${requestCounter}`
        return send(slot, requestId, build(slot, requestId), timeoutMs)
      }),
    )
    return outcomes.every(
      outcome => outcome.status === 'fulfilled' && (outcome.value as VectorWorkerMessage).type === 'ack',
    )
  }

  return {
    get workerCount() {
      return slots.filter(slot => slot.alive).length
    },

    load(handle: string, snapshot: WorkerCopySnapshot): Promise<boolean> {
      return broadcast(
        (_slot, requestId) => ({ type: 'load', requestId, handle, snapshot }),
        VECTOR_SEARCH_LOAD_TIMEOUT_MS,
      )
    },

    async loadShared(handle: string, handles: SharedVectorFieldHandles): Promise<boolean> {
      sharedFields.set(handle, handles)
      const loaded = await broadcast(
        (slot, requestId) => ({ type: 'loadShared', requestId, handle, scratchSlot: slot.scratchSlot, handles }),
        VECTOR_SEARCH_LOAD_TIMEOUT_MS,
      )
      if (!loaded) sharedFields.delete(handle)
      return loaded
    },

    async drop(handle: string): Promise<void> {
      sharedFields.delete(handle)
      await broadcast((_slot, requestId) => ({ type: 'drop', requestId, handle }), VECTOR_SEARCH_TIMEOUT_MS)
    },

    async insertOrdinals(handle: string, ordinals: Int32Array): Promise<GraphInsertOutcome | null> {
      const slot = pickSlot()
      if (slot === null) return null
      requestCounter += 1
      const request: VectorInsertRequest = { type: 'insertOrdinals', requestId: `${requestCounter}`, handle, ordinals }
      const message = await sendBusy(slot, request, VECTOR_INSERT_TIMEOUT_MS)
      if (message.type !== 'inserted') return null
      return message.outcome
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

      const message = await sendBusy(slot, request, VECTOR_SEARCH_TIMEOUT_MS)
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

      const message = await sendBusy(slot, request, VECTOR_SEARCH_TIMEOUT_MS)
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

export function acquireVectorSearchPool(requestedCount?: number): Promise<VectorSearchPool | null> {
  poolHolders += 1
  if (workersUnavailable) return Promise.resolve(null)
  if (sharedPool === null) {
    sharedPool = createVectorSearchPool(requestedCount).then(
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
