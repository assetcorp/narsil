import { fnv1a } from '../core/hash'
import { ErrorCodes, NarsilError } from '../errors'
import { FALLBACK_CPU_COUNT, MAX_WORKER_COUNT, MIN_WORKER_COUNT } from './constants'
import type { Executor } from './executor'
import { createRequestId } from './protocol'

export interface MemoryStats {
  workerId: number
  heapUsed: number
  heapTotal: number
  heapLimit: number | null
  external: number
}

export interface WorkerLease {
  readonly workerId: number
  readonly executor: Executor
  release(): void
}

export interface WorkerReplacement {
  readonly workerId: number
  readonly executor: Executor
  hold(indexName: string): void
  admit(): void
  abandon(): void
}

export interface WorkerPool {
  getExecutor(indexName: string): Executor
  getAllExecutors(): Executor[]
  executorsHolding(indexName: string): Executor[]
  leaseLeastBusy(): WorkerLease | null
  leaseIdle(limit: number): WorkerLease[]
  queriesInFlight(): number
  spawnAll(): void
  deadWorkerIds(): number[]
  spawnReplacement(workerId: number): WorkerReplacement | null
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
  inFlight: number
  serving: boolean
}

interface MemoryReportPayload {
  heapUsed?: number
  heapTotal?: number
  heapLimit?: number | null
  external?: number
}

function toFinite(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function toHeapLimit(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
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

  let cpuCount = FALLBACK_CPU_COUNT
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
    cpuCount = FALLBACK_CPU_COUNT
  }

  return Math.max(MIN_WORKER_COUNT, Math.min(MAX_WORKER_COUNT, cpuCount - 1))
}

export function splitWorkerBudget(total: number): { keyword: number; vector: number } {
  const keyword = Math.ceil(total / 2)
  return { keyword, vector: total - keyword }
}

export function createWorkerPool(config: WorkerPoolConfig): WorkerPool {
  const workerCount = resolveWorkerCount(config.count)
  const workers = new Map<number, WorkerSlot>()
  const deadSlots = new Set<number>()
  const indexAssignment = new Map<string, number>()
  let isShutdown = false

  function handleWorkerDeath(slotIndex: number, error: Error): void {
    if (isShutdown) {
      return
    }
    const slot = workers.get(slotIndex)
    if (slot !== undefined && !slot.serving) {
      workers.delete(slotIndex)
      return
    }
    if (deadSlots.has(slotIndex)) {
      return
    }
    deadSlots.add(slotIndex)
    const indexNames = slot ? [...slot.indexes].sort() : []
    workers.delete(slotIndex)
    config.onWorkerCrash?.(slotIndex, indexNames, error)
  }

  function spawnSlot(slotIndex: number, serving: boolean): WorkerSlot {
    const slot: WorkerSlot = {
      executor: config.workerFactory(slotIndex, error => handleWorkerDeath(slotIndex, error)),
      indexes: new Set(),
      inFlight: 0,
      serving,
    }
    workers.set(slotIndex, slot)
    return slot
  }

  function ensureWorker(slotIndex: number): WorkerSlot | undefined {
    const slot = workers.get(slotIndex)
    if (slot !== undefined) return slot
    if (deadSlots.has(slotIndex)) return undefined
    return spawnSlot(slotIndex, true)
  }

  function deadWorkerIds(): number[] {
    return [...deadSlots].filter(slotIndex => !workers.has(slotIndex)).sort((a, b) => a - b)
  }

  function spawnReplacement(slotIndex: number): WorkerReplacement | null {
    if (isShutdown || !deadSlots.has(slotIndex) || workers.has(slotIndex)) return null
    const slot = spawnSlot(slotIndex, false)
    return {
      workerId: slotIndex,
      executor: slot.executor,
      hold(indexName: string): void {
        slot.indexes.add(indexName)
      },
      admit(): void {
        if (workers.get(slotIndex) !== slot) return
        deadSlots.delete(slotIndex)
        slot.serving = true
      },
      abandon(): void {
        if (workers.get(slotIndex) === slot) workers.delete(slotIndex)
        void slot.executor.shutdown().catch(() => undefined)
      },
    }
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
    if (slot?.serving) {
      return slot.executor
    }
    for (const survivor of workers.values()) {
      if (survivor.serving && survivor.indexes.has(indexName)) {
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
        heapLimit: toHeapLimit(report?.heapLimit),
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

  function executorsHolding(indexName: string): Executor[] {
    const holders: Executor[] = []
    for (const slot of workers.values()) {
      if (slot.indexes.has(indexName)) holders.push(slot.executor)
    }
    return holders
  }

  function lease(workerId: number, slot: WorkerSlot): WorkerLease {
    slot.inFlight += 1
    let released = false
    return {
      workerId,
      executor: slot.executor,
      release() {
        if (released) return
        released = true
        slot.inFlight -= 1
      },
    }
  }

  function leaseLeastBusy(): WorkerLease | null {
    let chosenId = -1
    let chosen: WorkerSlot | null = null
    for (const [workerId, slot] of workers) {
      if (!slot.serving) continue
      if (chosen === null || slot.inFlight < chosen.inFlight) {
        chosenId = workerId
        chosen = slot
      }
      if (chosen.inFlight === 0) break
    }
    return chosen === null ? null : lease(chosenId, chosen)
  }

  function queriesInFlight(): number {
    let total = 0
    for (const slot of workers.values()) {
      if (slot.serving) total += slot.inFlight
    }
    return total
  }

  function leaseIdle(limit: number): WorkerLease[] {
    const leases: WorkerLease[] = []
    for (const [workerId, slot] of workers) {
      if (leases.length >= limit) break
      if (slot.serving && slot.inFlight === 0) leases.push(lease(workerId, slot))
    }
    return leases
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

  function spawnAll(): void {
    if (isShutdown) {
      throw new NarsilError(ErrorCodes.WORKER_CRASHED, 'Worker pool has been shut down')
    }
    for (let i = 0; i < workerCount; i++) ensureWorker(i)
  }

  return {
    getExecutor,
    getAllExecutors,
    executorsHolding,
    leaseLeastBusy,
    leaseIdle,
    queriesInFlight,
    spawnAll,
    deadWorkerIds,
    spawnReplacement,
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
