import { fnv1a } from '../core/hash'
import { ErrorCodes, NarsilError } from '../errors'
import type { Executor } from './executor'
import { createRequestId } from './protocol'

export interface MemoryStats {
  workerId: number
  heapUsed: number
  heapTotal: number
  external: number
}

export interface WorkerPool {
  getExecutor(indexName: string): Executor
  getAllExecutors(): Executor[]
  readonly workerCount: number
  addIndex(indexName: string): void
  addIndexToAll(indexName: string): void
  removeIndex(indexName: string): void
  getMemoryStats(): Promise<MemoryStats[]>
  shutdown(): Promise<void>
}

interface WorkerSlot {
  executor: Executor
  indexes: Set<string>
}

interface MemoryReportPayload {
  heapUsed?: number
  heapTotal?: number
  external?: number
}

function toFinite(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export type WorkerFactory = (workerId: number, onDeath?: (error: Error) => void) => Executor

export interface WorkerPoolConfig {
  count?: number
  workerFactory: WorkerFactory
  onWorkerCrash?: (workerId: number, indexNames: string[], error: Error) => void
}

declare const navigator: { hardwareConcurrency?: number } | undefined

export function resolveWorkerCount(requested?: number): number {
  if (requested !== undefined && requested > 0) {
    return requested
  }

  let cpuCount = 4
  try {
    if (navigator?.hardwareConcurrency) {
      cpuCount = navigator.hardwareConcurrency
    } else if (typeof process !== 'undefined') {
      const ap = (process as unknown as Record<string, unknown>).availableParallelism
      if (typeof ap === 'function') {
        cpuCount = ap() as number
      }
    }
  } catch {
    cpuCount = 4
  }

  return Math.max(2, Math.min(8, cpuCount - 1))
}

export function createWorkerPool(config: WorkerPoolConfig): WorkerPool {
  const workerCount = resolveWorkerCount(config.count)
  const workers = new Map<number, WorkerSlot>()
  const deadSlots = new Set<number>()
  const indexAssignment = new Map<string, number>()
  let isShutdown = false

  function handleWorkerDeath(slotIndex: number, error: Error): void {
    if (isShutdown || deadSlots.has(slotIndex)) {
      return
    }
    deadSlots.add(slotIndex)
    const slot = workers.get(slotIndex)
    const indexNames = slot ? [...slot.indexes].sort() : []
    workers.delete(slotIndex)
    config.onWorkerCrash?.(slotIndex, indexNames, error)
  }

  function ensureWorker(slotIndex: number): WorkerSlot | undefined {
    if (deadSlots.has(slotIndex)) {
      return undefined
    }
    let slot = workers.get(slotIndex)
    if (!slot) {
      slot = {
        executor: config.workerFactory(slotIndex, error => handleWorkerDeath(slotIndex, error)),
        indexes: new Set(),
      }
      workers.set(slotIndex, slot)
    }
    return slot
  }

  function assignSlot(indexName: string): number {
    const preferred = fnv1a(indexName) % workerCount
    for (let probe = 0; probe < workerCount; probe++) {
      const candidate = (preferred + probe) % workerCount
      if (!deadSlots.has(candidate)) {
        return candidate
      }
    }
    throw new NarsilError(ErrorCodes.WORKER_CRASHED, `Every worker in the pool has crashed`)
  }

  function addIndex(indexName: string): void {
    if (isShutdown) {
      throw new NarsilError(ErrorCodes.WORKER_CRASHED, 'Worker pool has been shut down')
    }

    if (indexAssignment.has(indexName)) {
      return
    }

    const slotIndex = assignSlot(indexName)
    const slot = ensureWorker(slotIndex)
    if (!slot) {
      throw new NarsilError(ErrorCodes.WORKER_CRASHED, `Worker ${slotIndex} for index "${indexName}" has crashed`)
    }
    slot.indexes.add(indexName)
    indexAssignment.set(indexName, slotIndex)
  }

  function removeIndex(indexName: string): void {
    for (const slot of workers.values()) slot.indexes.delete(indexName)
    indexAssignment.delete(indexName)
  }

  function getExecutor(indexName: string): Executor {
    if (isShutdown) {
      throw new NarsilError(ErrorCodes.WORKER_CRASHED, 'Worker pool has been shut down')
    }

    const slotIndex = indexAssignment.get(indexName)
    if (slotIndex === undefined) {
      throw new NarsilError(ErrorCodes.INDEX_NOT_FOUND, `Index "${indexName}" is not registered in the worker pool`)
    }

    const slot = workers.get(slotIndex)
    if (slot) {
      return slot.executor
    }
    for (const survivor of workers.values()) {
      if (survivor.indexes.has(indexName)) {
        return survivor.executor
      }
    }
    throw new NarsilError(ErrorCodes.WORKER_CRASHED, `Every worker holding index "${indexName}" has crashed`)
  }

  async function getMemoryStats(): Promise<MemoryStats[]> {
    const indices: number[] = []
    const pending: Array<Promise<MemoryReportPayload | null>> = []
    for (const [slotIndex, slot] of workers) {
      indices.push(slotIndex)
      pending.push(
        slot.executor
          .execute<MemoryReportPayload>({ type: 'memoryReport', requestId: createRequestId() })
          .catch(() => null),
      )
    }

    const reports = await Promise.all(pending)
    const stats: MemoryStats[] = []
    for (let n = 0; n < indices.length; n++) {
      const report = reports[n]
      stats.push({
        workerId: indices[n],
        heapUsed: toFinite(report?.heapUsed),
        heapTotal: toFinite(report?.heapTotal),
        external: toFinite(report?.external),
      })
    }
    return stats
  }

  async function shutdown(): Promise<void> {
    if (isShutdown) {
      return
    }

    isShutdown = true

    const shutdownPromises = [...workers.values()].map(slot => {
      const timeoutPromise = new Promise<void>(resolve => {
        setTimeout(resolve, 5_000)
      })

      return Promise.race([slot.executor.shutdown(), timeoutPromise])
    })

    await Promise.allSettled(shutdownPromises)
    indexAssignment.clear()
  }

  function getAllExecutors(): Executor[] {
    return [...workers.values()].map(slot => slot.executor)
  }

  function addIndexToAll(indexName: string): void {
    if (isShutdown) {
      throw new NarsilError(ErrorCodes.WORKER_CRASHED, 'Worker pool has been shut down')
    }
    for (let i = 0; i < workerCount; i++) {
      ensureWorker(i)?.indexes.add(indexName)
    }
    indexAssignment.set(indexName, assignSlot(indexName))
  }

  return {
    getExecutor,
    getAllExecutors,
    get workerCount() {
      return workerCount
    },
    addIndex,
    addIndexToAll,
    removeIndex,
    getMemoryStats,
    shutdown,
  }
}
