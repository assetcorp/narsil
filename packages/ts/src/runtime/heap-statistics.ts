import { getHeapStatistics } from 'node:v8'

export interface HeapStatistics {
  usedBytes: number
  limitBytes: number
}

export function readHostMemoryBytes(): number | null {
  try {
    const constrained = (process as unknown as { constrainedMemory?: () => number }).constrainedMemory
    const bytes = typeof constrained === 'function' ? constrained() : 0
    if (Number.isFinite(bytes) && bytes > 0) return bytes
    return null
  } catch {
    return null
  }
}

export function readHeapStatistics(): HeapStatistics | null {
  try {
    const stats = getHeapStatistics()
    const usedBytes = stats.used_heap_size
    const limitBytes = stats.heap_size_limit
    if (!Number.isFinite(usedBytes) || !Number.isFinite(limitBytes) || limitBytes <= 0) return null
    return { usedBytes, limitBytes }
  } catch {
    return null
  }
}
