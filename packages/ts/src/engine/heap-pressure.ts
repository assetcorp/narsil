import type { HeapStatistics } from '#platform/heap-statistics'
import type { NarsilEventMap } from '../types/events'
import { HEAP_PRESSURE_REARM_FRACTION, HEAP_PRESSURE_WARNING_FRACTION } from './constants'

export interface HeapPressureNotifier {
  check(indexName: string): void
}

export interface HeapPressureDeps {
  readHeap(): HeapStatistics | null
  estimateIndexBytes(indexName: string): number
  emit(payload: NarsilEventMap['heapPressure']): void
}

export function createHeapPressureNotifier(deps: HeapPressureDeps): HeapPressureNotifier {
  let warned = false

  function check(indexName: string): void {
    const heap = deps.readHeap()
    if (heap === null) return
    const fraction = heap.usedBytes / heap.limitBytes
    if (warned) {
      if (fraction < HEAP_PRESSURE_REARM_FRACTION) warned = false
      return
    }
    if (fraction < HEAP_PRESSURE_WARNING_FRACTION) return
    warned = true
    deps.emit({
      indexName,
      heapUsed: heap.usedBytes,
      heapLimit: heap.limitBytes,
      estimatedMemoryBytes: deps.estimateIndexBytes(indexName),
    })
  }

  return { check }
}
