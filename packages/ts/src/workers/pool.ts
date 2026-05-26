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

export type WorkerFactory = (workerId: number) => Executor

export interface WorkerPoolConfig {
  count?: number
  workerFactory: WorkerFactory
}

declare const navigator: { hardwareConcurrency?: number } | undefined

function resolveWorkerCount(requested?: number): number {
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
  const workers: WorkerSlot[] = []
  const indexAssignment = new Map<string, number>()
  let isShutdown = false

  function ensureWorker(slotIndex: number): WorkerSlot {
    if (!workers[slotIndex]) {
      workers[slotIndex] = {
        executor: config.workerFactory(slotIndex),
        indexes: new Set(),
      }
    }
    return workers[slotIndex]
  }

  function assignSlot(indexName: string): number {
    return fnv1a(indexName) % workerCount
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
    slot.indexes.add(indexName)
    indexAssignment.set(indexName, slotIndex)
  }

  function removeIndex(indexName: string): void {
    const slotIndex = indexAssignment.get(indexName)
    if (slotIndex === undefined) {
      return
    }

    const slot = workers[slotIndex]
    if (slot) {
      slot.indexes.delete(indexName)
    }
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

    return workers[slotIndex].executor
  }

  async function getMemoryStats(): Promise<MemoryStats[]> {
    const indices: number[] = []
    const pending: Array<Promise<MemoryReportPayload | null>> = []
    for (let i = 0; i < workers.length; i++) {
      const slot = workers[i]
      if (!slot) continue
      indices.push(i)
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

    const shutdownPromises = workers.filter(Boolean).map(slot => {
      const timeoutPromise = new Promise<void>(resolve => {
        setTimeout(resolve, 5_000)
      })

      return Promise.race([slot.executor.shutdown(), timeoutPromise])
    })

    await Promise.allSettled(shutdownPromises)
    indexAssignment.clear()
  }

  function getAllExecutors(): Executor[] {
    return workers.filter(Boolean).map(slot => slot.executor)
  }

  function addIndexToAll(indexName: string): void {
    if (isShutdown) {
      throw new NarsilError(ErrorCodes.WORKER_CRASHED, 'Worker pool has been shut down')
    }
    for (let i = 0; i < workerCount; i++) {
      const slot = ensureWorker(i)
      slot.indexes.add(indexName)
    }
    indexAssignment.set(indexName, 0)
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
