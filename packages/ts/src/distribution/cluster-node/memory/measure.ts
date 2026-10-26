import { totalmem } from 'node:os'
import { readHeapStatistics } from '#platform/heap-statistics'
import type { NodeMemoryReport } from '../../coordinator/types'

export type MemoryFigures = Omit<NodeMemoryReport, 'full'>

function processLimitBytes(): number {
  const hostBytes = totalmem()
  const constrained = typeof process.constrainedMemory === 'function' ? process.constrainedMemory() : 0
  return Number.isFinite(constrained) && constrained > 0 && constrained < hostBytes ? constrained : hostBytes
}

export function readMemoryFigures(): MemoryFigures | null {
  try {
    const heap = readHeapStatistics()
    const processBytes = process.memoryUsage.rss()
    const limitBytes = processLimitBytes()
    if (heap === null || !Number.isFinite(processBytes) || !Number.isFinite(limitBytes) || limitBytes <= 0) {
      return null
    }
    return {
      processBytes,
      processLimitBytes: limitBytes,
      heapBytes: heap.usedBytes,
      heapLimitBytes: heap.configuredLimitBytes ?? heap.limitBytes,
    }
  } catch {
    return null
  }
}
