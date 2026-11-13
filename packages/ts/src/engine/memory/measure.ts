import { readOldGenerationStatistics } from '#platform/heap-statistics'
import { readProcessMemoryUse } from '#platform/process-limit'
import type { NodeMemoryReport } from '../../distribution/coordinator/types'
import { engineThreadYoungGenerationBytes } from '../../runtime/engine-threads'
import { admittedHeapBytes } from '../../runtime/thread-heap'
import { RECENT_MEMORY_FIGURES_MAX_ADMITTED_FRACTION, RECENT_MEMORY_FIGURES_MAX_AGE_MS } from './constants'

export type MemoryFigures = Omit<NodeMemoryReport, 'full'> & {
  youngHeapBytes: number
  heapCommittedBytes: number
  youngCeilingBytes: number
  youngReserveBytes: number
}

let lastFigures: MemoryFigures | null = null
let lastFiguresComplete = false
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
    const memory = readProcessMemoryUse()
    lastFiguresComplete = heap !== null && memory !== null
    if (heap === null && memory === null) return null
    return {
      processBytes: memory?.processBytes ?? 0,
      processLimitBytes: memory?.limitBytes ?? Number.POSITIVE_INFINITY,
      heapBytes: heap?.usedBytes ?? 0,
      heapLimitBytes: heap?.limitBytes ?? Number.POSITIVE_INFINITY,
      youngHeapBytes: heap?.youngUsedBytes ?? 0,
      heapCommittedBytes: heap === null ? 0 : Math.max(heap.committedBytes, heap.usedBytes),
      youngCeilingBytes: heap?.youngCeilingBytes ?? 0,
      youngReserveBytes: (heap?.youngReserveBytes ?? 0) + engineThreadYoungGenerationBytes(),
    }
  } catch {
    lastFiguresComplete = false
    return null
  }
}

function measure(): MemoryFigures | null {
  const figures = readFreshFigures()
  lastFigures = figures
  lastFiguresReadAt = performance.now()
  admittedBytesAtLastFigures = admittedHeapBytes()
  return figures
}

function recent(maxAgeMs: number): MemoryFigures | null {
  const admittedSince = admittedHeapBytes() - admittedBytesAtLastFigures
  if (
    lastFigures === null ||
    performance.now() - lastFiguresReadAt >= maxAgeMs ||
    admittedSince > RECENT_MEMORY_FIGURES_MAX_ADMITTED_FRACTION * lastFigures.heapLimitBytes
  ) {
    return measure()
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

export function readMemoryFigures(): MemoryFigures | null {
  const figures = measure()
  return lastFiguresComplete ? figures : null
}

export function readRecentMemoryFigures(): MemoryFigures | null {
  const figures = recent(RECENT_MEMORY_FIGURES_MAX_AGE_MS)
  return lastFiguresComplete ? figures : null
}

export function readEngineMemoryFigures(): MemoryFigures | null {
  return measure()
}

export function readRecentEngineMemoryFigures(maxAgeMs: number): MemoryFigures | null {
  return recent(maxAgeMs)
}
