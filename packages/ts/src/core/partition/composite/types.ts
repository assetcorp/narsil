import type { FrozenSegment } from '../frozen'
import type { RemovedSpellings } from '../frozen/surface-slot'
import type { PartitionIndex } from '../partition-index'
import type { LiveTailFreezer } from './compaction'

export interface CompositePartition extends PartitionIndex {
  readonly live: PartitionIndex
  frozenSegmentCount(): number
  frozenSegmentSizes(): Array<{ segmentId: string; liveDocumentCount: number }>
  frozenSegmentsById(segmentIds: readonly string[]): FrozenSegment[]
  /** Adds a frozen segment whose documents the partition manager has already checked against every partition. */
  attachFrozenSegment(segment: FrozenSegment): void
  swapFrozenSegments(
    dropSegmentIds: readonly string[],
    replacement: FrozenSegment | readonly FrozenSegment[],
    removedSpellings?: ReadonlyMap<string, RemovedSpellings>,
  ): Map<string, RemovedSpellings>
  freezeLiveTail(freeze: LiveTailFreezer): FrozenSegment | null
  replaceLiveTail(segment: FrozenSegment): void
  removedSpellingsOf(docId: string): RemovedSpellings | undefined
  frozenSegments(): readonly FrozenSegment[]
  replaceFrozenSegments(segments: readonly FrozenSegment[]): void
  documentIdsHeldInMemory(): IterableIterator<string>
}
