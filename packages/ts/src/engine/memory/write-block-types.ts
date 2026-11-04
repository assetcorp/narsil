import type { CapacityScope } from '../../partitioning/manager/capacity'
import type { AnyDocument } from '../../types/schema'
import type { MemoryFractionSettings } from './fractions'
import type { MemoryGroupedItem, MemoryGroupedWrite, MemoryGroupRefusal, MemoryReservation } from './grouped-writes'
import type { WriteAnalysisSource } from './write-analysis'

export interface MemoryWriteGrouping {
  reserveFor(indexName: string, document: AnyDocument): MemoryReservation
  applyInGroups<T extends MemoryGroupedItem>(
    indexName: string,
    write: MemoryGroupedWrite<T>,
  ): Promise<MemoryGroupRefusal | null>
}

export interface MemoryWriteBlock {
  refuseWhileFull(indexName: string): void
  memoryReleased(): void
  grouping?: MemoryWriteGrouping
}

export interface MemoryWriteBlockDeps {
  settings: MemoryFractionSettings | undefined
  capacityScope: CapacityScope
  source: WriteAnalysisSource
}
