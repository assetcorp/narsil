import { readHeapStatistics } from '#platform/heap-statistics'
import type { PartitionManager } from '../partitioning/manager'
import type { NarsilEventMap } from '../types/events'
import type { EventHandler, IndexRegistryEntry } from './core'
import { createHeapPressureNotifier, type HeapPressureNotifier } from './heap-pressure'
import { createWatermarkNotifier, type WatermarkNotifier } from './watermark'

export interface NotifierWiring {
  eventHandlers: Map<string, Set<EventHandler>>
  indexRegistry: Map<string, IndexRegistryEntry>
  getManager(indexName: string): PartitionManager | undefined
}

function emitEngineEvent<E extends keyof NarsilEventMap>(
  eventHandlers: Map<string, Set<EventHandler>>,
  event: E,
  payload: NarsilEventMap[E],
): void {
  const handlers = eventHandlers.get(event)
  if (!handlers) return
  for (const handler of handlers) {
    try {
      handler(payload)
    } catch (err) {
      console.warn(`${event} handler error:`, err instanceof Error ? err.message : String(err))
    }
  }
}

export function wireWatermarkNotifier(wiring: NotifierWiring): WatermarkNotifier {
  return createWatermarkNotifier({
    getManager: wiring.getManager,
    getPartitionConfig: indexName => wiring.indexRegistry.get(indexName)?.config.partitions,
    emit: payload => emitEngineEvent(wiring.eventHandlers, 'partitionWatermark', payload),
  })
}

export function wireHeapPressureNotifier(wiring: NotifierWiring): HeapPressureNotifier {
  return createHeapPressureNotifier({
    readHeap: readHeapStatistics,
    estimateIndexBytes: indexName => wiring.getManager(indexName)?.estimateMemoryBytes() ?? 0,
    emit: payload => emitEngineEvent(wiring.eventHandlers, 'heapPressure', payload),
  })
}
