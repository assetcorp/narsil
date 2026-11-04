import { collectAndReturnPages } from '#platform/idle-heap-cleanup'
import { ErrorCodes, NarsilError } from '../../errors'
import { collectGarbageBeforeRefusal, collectYoungGenerationBeforeRefusal } from '../../runtime/thread-heap'
import { ENGINE_MEMORY_FIGURES_MAX_AGE_MS, FULL_MEMORY_COLLECTION_INTERVAL_MS } from './constants'
import { type MemoryFractionSettings, type MemoryFractions, memoryFractionsOf } from './fractions'
import { readEngineMemoryFigures } from './measure'
import { createMemoryMonitor, type MemoryMonitor } from './monitor'

const MEMORY_FULL_REASON = 'memory_full'

export interface MeasuredWriteBlock {
  fractions: MemoryFractions
  monitor: MemoryMonitor
  refuseWhileFull(indexName: string): void
  memoryReleased(): void
}

function finiteOrNull(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) ? value : null
}

export function createMeasuredWriteBlock(settings: MemoryFractionSettings | undefined): MeasuredWriteBlock {
  const fractions = memoryFractionsOf(settings)
  const monitor = createMemoryMonitor({
    fractions,
    intervalMs: ENGINE_MEMORY_FIGURES_MAX_AGE_MS,
    collectionIntervalMs: FULL_MEMORY_COLLECTION_INTERVAL_MS,
    read: readEngineMemoryFigures,
    collectGarbage: collectAndReturnPages,
    collectGarbageBeforeRefusal,
    collectYoungGenerationBeforeRefusal,
    onFullChange: () => {},
  })

  return {
    fractions,
    monitor,
    refuseWhileFull(indexName) {
      monitor.measureIfOlderThan(ENGINE_MEMORY_FIGURES_MAX_AGE_MS)
      if (!monitor.isFull()) return
      monitor.measureWithoutGarbage()
      if (!monitor.isFull()) return
      const report = monitor.report()
      throw new NarsilError(
        ErrorCodes.MEMORY_WRITE_BLOCKED,
        `The engine refuses inserts and updates to index '${indexName}' because its memory passed the block level of its limit. Remove documents to free memory, and writes resume once memory falls below the resume level.`,
        {
          reason: MEMORY_FULL_REASON,
          indexName,
          processBytes: finiteOrNull(report?.processBytes),
          processLimitBytes: finiteOrNull(report?.processLimitBytes),
          heapBytes: finiteOrNull(report?.heapBytes),
          heapLimitBytes: finiteOrNull(report?.heapLimitBytes),
        },
      )
    },
    memoryReleased() {
      if (monitor.isFull()) monitor.remeasureAfterRelease()
    },
  }
}
