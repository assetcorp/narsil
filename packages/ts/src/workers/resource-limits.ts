import { readHeapStatistics, readHostMemoryBytes } from '#platform/heap-statistics'
import {
  MAX_WORKER_COUNT,
  MIN_WORKER_OLD_GENERATION_MB,
  WORKER_HEAP_BUDGET_FRACTION,
  WORKER_YOUNG_GENERATION_MB,
} from './constants'

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

/**
 * Reports the heap limits one worker starts under, which divide the memory
 * this host allows between the workers this process runs. A worker that
 * receives no limit takes a heap of its own, so a pool of them may reserve
 * several times the memory the host allows, and the operating system ends the
 * whole process once they fill it.
 *
 * The limit is a backstop instead of an operating point, because the runtime
 * ends a worker that reaches it, so it leaves room for the copies a worker
 * holds and for the garbage a batch leaves behind. A process that starts
 * under `--max-old-space-size` or `--max-old-space-size-percentage` overrides
 * these limits with that one figure, which every worker then takes in full.
 *
 * @param workerCount How many workers of this pool share the budget, the
 * largest pool this engine starts where the caller gives no count. The engine
 * runs a pool for the index copies and another for vector search, so each
 * pool divides its own share of the memory the host allows.
 * @returns The limits to start a worker under, which name the young
 * generation alone on a runtime that reports neither the memory the host
 * allows nor its heap statistics.
 *
 * @internal
 */
export function workerResourceLimits(workerCount?: number): WorkerResourceLimits {
  const limits: WorkerResourceLimits = { maxYoungGenerationSizeMb: WORKER_YOUNG_GENERATION_MB }
  const budgetBytes = memoryBudgetBytes()
  if (budgetBytes === null) return limits
  const workers = workerCount !== undefined && workerCount > 0 ? workerCount : MAX_WORKER_COUNT
  const shareMb = Math.floor((budgetBytes * WORKER_HEAP_BUDGET_FRACTION) / workers / BYTES_PER_MEGABYTE)
  limits.maxOldGenerationSizeMb = Math.max(MIN_WORKER_OLD_GENERATION_MB, shareMb)
  return limits
}
