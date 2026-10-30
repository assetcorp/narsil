import { readOldGenerationStatistics } from '#platform/heap-statistics'
import { processLimitBytes } from '#platform/process-limit'
import { engineThreadYoungGenerationBytes } from '../../../runtime/engine-threads'
import { admittedHeapBytes } from '../../../runtime/thread-heap'
import type { NodeMemoryReport } from '../../coordinator/types'
import { RECENT_MEMORY_FIGURES_MAX_ADMITTED_FRACTION, RECENT_MEMORY_FIGURES_MAX_AGE_MS } from '../constants'

export type MemoryFigures = Omit<NodeMemoryReport, 'full'> & {
  youngHeapBytes: number
  heapCommittedBytes: number
  youngCeilingBytes: number
  youngReserveBytes: number
}

let lastFigures: MemoryFigures | null = null
let lastFiguresReadAt = Number.NEGATIVE_INFINITY
let admittedBytesAtLastFigures = 0
const recentFigures: MemoryFigures = {
  processBytes: 0,
  processLimitBytes: 0,
  heapBytes: 0,
  heapLimitBytes: 0,
  youngHeapBytes: 0,
  heapCommittedBytes: 0,
  youngCeilingBytes: 0,
  youngReserveBytes: 0,
}

function readFreshFigures(): MemoryFigures | null {
  try {
    const heap = readOldGenerationStatistics()
    const processBytes = process.memoryUsage.rss()
    const limitBytes = processLimitBytes(processBytes)
    if (heap === null || !Number.isFinite(processBytes) || !Number.isFinite(limitBytes) || limitBytes <= 0) {
      return null
    }
    return {
      processBytes,
      processLimitBytes: limitBytes,
      heapBytes: heap.usedBytes,
      heapLimitBytes: heap.limitBytes,
      youngHeapBytes: heap.youngUsedBytes,
      heapCommittedBytes: Math.max(heap.committedBytes, heap.usedBytes),
      youngCeilingBytes: heap.youngCeilingBytes,
      youngReserveBytes: heap.youngReserveBytes + engineThreadYoungGenerationBytes(),
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
  recentFigures.heapCommittedBytes = lastFigures.heapCommittedBytes + admittedSince
  recentFigures.youngCeilingBytes = lastFigures.youngCeilingBytes
  recentFigures.youngReserveBytes = lastFigures.youngReserveBytes
  return recentFigures
}
