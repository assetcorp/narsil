import { fnv1a } from '../core/hash'
import { ErrorCodes, NarsilError } from '../errors'
import type { Executor } from './executor'

export interface MemoryStats {
  workerId: number
  heapUsed: number
  heapTotal: number
  external: number
}

export interface WorkerPool {
  getExecutor(indexName: string): Executor
  addIndex(indexName: string): void
  removeIndex(indexName: string): void
  getMemoryStats(): MemoryStats[]
  shutdown(): Promise<void>
}

interface WorkerSlot {
  executor: Executor
  indexes: Set<string>
  memoryStats: { heapUsed: number; heapTotal: number; external: number }
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
    if (typeof navigator !== 'undefined' && navigator?.hardwareConcurrency) {
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
        memoryStats: { heapUsed: 0, heapTotal: 0, external: 0 },
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

  function getMemoryStats(): MemoryStats[] {
    const stats: MemoryStats[] = []
    for (let i = 0; i < workers.length; i++) {
      const slot = workers[i]
      if (slot) {
        stats.push({
          workerId: i,
          heapUsed: slot.memoryStats.heapUsed,
          heapTotal: slot.memoryStats.heapTotal,
          external: slot.memoryStats.external,
        })
      }
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

  return { getExecutor, addIndex, removeIndex, getMemoryStats, shutdown }
}
