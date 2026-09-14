import { readHeapStatistics, readHostMemoryBytes } from '#platform/heap-statistics'
import { MIN_WORKER_OLD_GENERATION_MB, WORKER_HEAP_BUDGET_FRACTION, WORKER_YOUNG_GENERATION_MB } from './constants'
import { resolveRequestThreadCount, resolveWorkerCount, splitWorkerBudget } from './pool'

const BYTES_PER_MEGABYTE = 1024 * 1024

export interface WorkerResourceLimits {
  maxYoungGenerationSizeMb?: number
  maxOldGenerationSizeMb?: number
}

function memoryBudgetBytes(): number | null {
  const host = readHostMemoryBytes()
  if (host !== null) return host
  const heap = readHeapStatistics()
  return heap === null ? null : heap.limitBytes
}

function engineThreadCount(): number {
  return resolveRequestThreadCount() + splitWorkerBudget(resolveWorkerCount()).vector
}

export function workerResourceLimits(): WorkerResourceLimits {
  const limits: WorkerResourceLimits = { maxYoungGenerationSizeMb: WORKER_YOUNG_GENERATION_MB }
  const budgetBytes = memoryBudgetBytes()
  if (budgetBytes === null) return limits
  const shareMb = Math.floor((budgetBytes * WORKER_HEAP_BUDGET_FRACTION) / engineThreadCount() / BYTES_PER_MEGABYTE)
  limits.maxOldGenerationSizeMb = Math.max(MIN_WORKER_OLD_GENERATION_MB, shareMb)
  return limits
}
