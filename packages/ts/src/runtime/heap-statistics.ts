import { getHeapStatistics } from 'node:v8'

export interface HeapStatistics {
  usedBytes: number
  limitBytes: number
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
