import { getHeapStatistics } from 'node:v8'

export interface HeapStatistics {
  usedBytes: number
  limitBytes: number
  availableBytes: number | null
}

export function readHeapStatistics(): HeapStatistics | null {
  try {
    const stats = getHeapStatistics()
    const usedBytes = stats.used_heap_size
    const limitBytes = stats.heap_size_limit
    if (!Number.isFinite(usedBytes) || !Number.isFinite(limitBytes) || limitBytes <= 0) return null
    const available = stats.total_available_size
    const availableBytes = Number.isFinite(available) && available >= 0 ? available : null
    return { usedBytes, limitBytes, availableBytes }
  } catch {
    return null
  }
}
