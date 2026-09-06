import { readHeapStatistics } from '#platform/heap-statistics'
import type { PartitionManager } from '../partitioning/manager'
import type { NarsilEventMap } from '../types/events'
import type { EngineCore, IndexRegistryEntry } from './core'
import { type EngineEventHandlers, emitEngineEvent } from './events'
import { createHeapPressureNotifier, type HeapPressureNotifier } from './heap-pressure'
import { createWatermarkNotifier, type WatermarkNotifier } from './watermark'

export interface NotifierWiring {
  eventHandlers: EngineEventHandlers
  indexRegistry: Map<string, IndexRegistryEntry>
  getManager(indexName: string): PartitionManager | undefined
}

export function wireWatermarkNotifier(wiring: NotifierWiring): WatermarkNotifier {
  return createWatermarkNotifier({
    getManager: wiring.getManager,
    getPartitionConfig: indexName => wiring.indexRegistry.get(indexName)?.config.partitions,
    emit: payload => emitEngineEvent(wiring.eventHandlers, 'partitionWatermark', payload),
  })
}

function warnUnheardHeapPressure(payload: NarsilEventMap['heapPressure']): void {
  console.warn(
    `Heap at ${payload.heapUsed} of ${payload.heapLimit} bytes after index "${payload.indexName}"; ` +
      'raise --max-old-space-size-percentage or close an idle index',
  )
}

export function wireHeapPressureNotifier(wiring: NotifierWiring): HeapPressureNotifier {
  return createHeapPressureNotifier({
    readHeap: readHeapStatistics,
    estimateIndexBytes: indexName => wiring.getManager(indexName)?.estimateMemoryBytes() ?? 0,
    emit: payload => {
      if (emitEngineEvent(wiring.eventHandlers, 'heapPressure', payload) === 0) warnUnheardHeapPressure(payload)
    },
  })
}

export function checkHeapAfterRecovery(
  core: Pick<EngineCore, 'indexRegistry' | 'executor' | 'heapPressureNotifier'>,
): void {
  const sized = [...core.indexRegistry.keys()].map(indexName => ({
    indexName,
    bytes: core.executor.getManager(indexName)?.estimateMemoryBytes() ?? 0,
  }))
  sized.sort((a, b) => b.bytes - a.bytes)
  for (const { indexName } of sized) core.heapPressureNotifier.check(indexName)
}
