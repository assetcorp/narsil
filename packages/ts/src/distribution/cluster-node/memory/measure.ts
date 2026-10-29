import { totalmem } from 'node:os'
import { readOldGenerationStatistics } from '#platform/heap-statistics'
import { admittedHeapBytes } from '../../../runtime/thread-heap'
import type { NodeMemoryReport } from '../../coordinator/types'
import {
  PROCESS_LIMIT_REFRESH_INTERVAL_MS,
  RECENT_MEMORY_FIGURES_MAX_ADMITTED_FRACTION,
  RECENT_MEMORY_FIGURES_MAX_AGE_MS,
} from '../constants'

export type MemoryFigures = Omit<NodeMemoryReport, 'full'> & { youngHeapBytes: number }

let processLimit = 0
let processLimitReadAt = Number.NEGATIVE_INFINITY
let lastFigures: MemoryFigures | null = null
let lastFiguresReadAt = Number.NEGATIVE_INFINITY
let admittedBytesAtLastFigures = 0
const recentFigures: MemoryFigures = {
  processBytes: 0,
  processLimitBytes: 0,
  heapBytes: 0,
  heapLimitBytes: 0,
  youngHeapBytes: 0,
}

function readProcessLimit(): number {
  const hostBytes = totalmem()
  const constrained = typeof process.constrainedMemory === 'function' ? process.constrainedMemory() : 0
  return Number.isFinite(constrained) && constrained > 0 && constrained < hostBytes ? constrained : hostBytes
}

function processLimitBytes(): number {
  const now = performance.now()
  if (now - processLimitReadAt >= PROCESS_LIMIT_REFRESH_INTERVAL_MS) {
    processLimit = readProcessLimit()
    processLimitReadAt = now
  }
  return processLimit
}

function readFreshFigures(): MemoryFigures | null {
  try {
    const heap = readOldGenerationStatistics()
    const processBytes = process.memoryUsage.rss()
    const limitBytes = processLimitBytes()
    if (heap === null || !Number.isFinite(processBytes) || !Number.isFinite(limitBytes) || limitBytes <= 0) {
      return null
    }
    return {
      processBytes,
      processLimitBytes: limitBytes,
      heapBytes: heap.usedBytes,
      heapLimitBytes: heap.limitBytes,
      youngHeapBytes: heap.youngUsedBytes,
    }
  } catch {
    return null
  }
}

export function readMemoryFigures(): MemoryFigures | null {
  const figures = readFreshFigures()
  lastFigures = figures
  lastFiguresReadAt = performance.now()
  admittedBytesAtLastFigures = admittedHeapBytes()
  return figures
}

export function readRecentMemoryFigures(): MemoryFigures | null {
  const admittedSince = admittedHeapBytes() - admittedBytesAtLastFigures
  if (
    lastFigures === null ||
    performance.now() - lastFiguresReadAt >= RECENT_MEMORY_FIGURES_MAX_AGE_MS ||
    admittedSince > RECENT_MEMORY_FIGURES_MAX_ADMITTED_FRACTION * lastFigures.heapLimitBytes
  ) {
    return readMemoryFigures()
  }
  recentFigures.processLimitBytes = lastFigures.processLimitBytes
  recentFigures.heapLimitBytes = lastFigures.heapLimitBytes
  recentFigures.processBytes = lastFigures.processBytes + admittedSince
  recentFigures.heapBytes = lastFigures.heapBytes + admittedSince
  recentFigures.youngHeapBytes = lastFigures.youngHeapBytes
  return recentFigures
}
