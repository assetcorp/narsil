import { SCRATCH_SLOTS_PER_THREAD_POOL } from '../vector/constants'
import {
  FALLBACK_CPU_COUNT,
  MAX_WORKER_COUNT,
  MIN_CORES_FOR_SEVERAL_REQUEST_THREADS,
  MIN_WORKER_COUNT,
} from './constants'

declare const navigator: { hardwareConcurrency?: number } | undefined

export function detectCpuCount(): number {
  try {
    if (navigator?.hardwareConcurrency) {
      return navigator.hardwareConcurrency
    }
    if (typeof process !== 'undefined') {
      const ap = (process as unknown as Record<string, unknown>).availableParallelism
      if (typeof ap === 'function') {
        return ap() as number
      }
    }
  } catch {
    return FALLBACK_CPU_COUNT
  }
  return FALLBACK_CPU_COUNT
}

export function resolveWorkerCount(requested?: number): number {
  if (requested !== undefined && requested > 0) {
    return Math.min(requested, SCRATCH_SLOTS_PER_THREAD_POOL)
  }
  return Math.max(MIN_WORKER_COUNT, Math.min(MAX_WORKER_COUNT, detectCpuCount() - 1))
}

export function resolveRequestThreadCount(requested?: number): number {
  if (detectCpuCount() < MIN_CORES_FOR_SEVERAL_REQUEST_THREADS) return 1
  return resolveWorkerCount(requested)
}

export function splitWorkerBudget(total: number): { keyword: number; vector: number } {
  const keyword = Math.ceil(total / 2)
  return { keyword, vector: total - keyword }
}
