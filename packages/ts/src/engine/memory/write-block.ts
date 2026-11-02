import type { BatchResult } from '../../types/results'
import type { AnyDocument } from '../../types/schema'
import type { MemoryFractionSettings } from './fractions'
import type { MemoryGroupedItem, MemoryGroupedWrite, MemoryGroupRefusal, MemoryReservation } from './grouped-writes'
import { createMeasuredWriteBlock } from './measured-block'
import { PASS_THROUGH_WRITE_BLOCK } from './pass-through'
import { validateMemoryFractions } from './validate'
import type { WriteAnalysisSource } from './write-analysis'

export type { MemoryGroupedItem, MemoryGroupedWrite, MemoryGroupRefusal, MemoryReservation } from './grouped-writes'

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

export function validateMemorySettings(settings: unknown): void {
  validateMemoryFractions('memory', settings)
}

export function createMemoryWriteBlock(deps: MemoryWriteBlockDeps): MemoryWriteBlock {
  const measured = createMeasuredWriteBlock(deps.settings)
  return {
    ...PASS_THROUGH_WRITE_BLOCK,
    refuseWhileFull: measured.refuseWhileFull,
    memoryReleased: measured.memoryReleased,
  }
}
