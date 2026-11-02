import { collectAndReturnPages } from '#platform/idle-heap-cleanup'
import { ErrorCodes, NarsilError } from '../../errors'
import { collectGarbageBeforeRefusal, collectYoungGenerationBeforeRefusal } from '../../runtime/thread-heap'
import type { BatchResult } from '../../types/results'
import type { AnyDocument } from '../../types/schema'
import { ENGINE_MEMORY_FIGURES_MAX_AGE_MS, FULL_MEMORY_COLLECTION_INTERVAL_MS } from './constants'
import { type MemoryFractionSettings, memoryFractionsOf } from './fractions'
import {
  applyInGroups,
  type GroupedWriteProjection,
  type MemoryGroupedItem,
  type MemoryGroupedWrite,
  type MemoryGroupRefusal,
  type MemoryReservation,
  reserveForDocument,
} from './grouped-writes'
import { readEngineMemoryFigures, readRecentEngineMemoryFigures } from './measure'
import { createMemoryMonitor } from './monitor'
import { validateMemoryFractions } from './validate'
import { vectorGrowthBytesOf, type WriteAnalysisSource, writeAnalysisOf } from './write-analysis'
import { createWriteProjection, WRITE_WOULD_FILL_MEMORY_REASON } from './write-projection'

export type { MemoryGroupedItem, MemoryGroupedWrite, MemoryGroupRefusal, MemoryReservation } from './grouped-writes'

const MEMORY_FULL_REASON = 'memory_full'

export interface MemoryWriteBlock {
  refuseWhileFull(indexName: string): void
  memoryReleased(): void
  reserveFor(indexName: string, document: AnyDocument): MemoryReservation
  applyInGroups<T extends MemoryGroupedItem>(
    indexName: string,
    write: MemoryGroupedWrite<T>,
  ): Promise<MemoryGroupRefusal | null>
  refuseRemaining(
    indexName: string,
    docIds: readonly string[],
    refusal: MemoryGroupRefusal,
    failed: BatchResult['failed'],
  ): void
}

export interface MemoryWriteBlockDeps {
  settings: MemoryFractionSettings | undefined
  source: WriteAnalysisSource
}

function finiteOrNull(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) ? value : null
}

export function validateMemorySettings(settings: unknown): void {
  validateMemoryFractions('memory', settings)
}

function refusedAfter(indexName: string, docId: string, refusedDocId: string): NarsilError {
  return new NarsilError(
    ErrorCodes.MEMORY_WRITE_BLOCKED,
    `The engine refuses document '${docId}' for index '${indexName}' because document '${refusedDocId}' before it in the batch would not fit in the engine's memory. Retry the refused documents once the writes in progress finish.`,
    { reason: WRITE_WOULD_FILL_MEMORY_REASON, indexName, docId, refusedDocId },
  )
}

export function createMemoryWriteBlock(deps: MemoryWriteBlockDeps): MemoryWriteBlock {
  const fractions = memoryFractionsOf(deps.settings)
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
  const projection = createWriteProjection({
    refusal: {
      code: ErrorCodes.MEMORY_WRITE_BLOCKED,
      refuser: 'The engine',
      owner: 'the engine',
      fillAdvice: 'Retry once the writes in progress finish, or remove documents to free memory.',
      details: {},
    },
    fractions,
    measure: () => readRecentEngineMemoryFigures(ENGINE_MEMORY_FIGURES_MAX_AGE_MS),
    measureWithoutGarbage: () => monitor.measureWithoutGarbage(),
    collections: () => monitor.collections(),
    refusedAfterCollection: figures => monitor.refusedAfterCollection(figures),
    analysisOf: indexName => writeAnalysisOf(deps.source, indexName),
    vectorGrowthBytesOf: (indexName, documents) => vectorGrowthBytesOf(deps.source, indexName, documents),
  })
  const grouped: GroupedWriteProjection = {
    boundOf: indexName => projection.boundOf(indexName),
    takeGroup: (indexName, bounds, start, mostDocuments) =>
      projection.takeGroup(indexName, bounds, start, mostDocuments),
    refusedAfter,
  }

  return {
    refuseWhileFull(indexName) {
      monitor.measureIfOlderThan(ENGINE_MEMORY_FIGURES_MAX_AGE_MS)
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
    reserveFor: (indexName, document) => reserveForDocument(grouped, indexName, document),
    applyInGroups: (indexName, write) => applyInGroups(grouped, indexName, write),
    refuseRemaining(indexName, docIds, refusal, failed) {
      for (const docId of docIds) {
        failed.push({ docId, error: refusedAfter(indexName, docId, refusal.refusedDocId) })
      }
    },
  }
}
