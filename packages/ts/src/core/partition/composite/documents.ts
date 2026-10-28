import type { AnyDocument } from '../../../types/schema'
import { compareCodePoints } from '../../ordering'
import type { ResolvedProjection } from '../../projection'
import type { FrozenSegment } from '../frozen'
import type { PartitionIndex } from '../partition-index'

export function compositeDocument(
  frozen: readonly FrozenSegment[],
  live: PartitionIndex,
  docId: string,
  projection?: ResolvedProjection,
): AnyDocument | undefined {
  for (const segment of frozen) {
    const projected = segment.docStore.projectedDocument(docId, projection)
    if (projected !== undefined) return projected
  }
  return live.get(docId, projection)
}

export function compositeFieldValues(
  frozen: readonly FrozenSegment[],
  live: PartitionIndex,
  docId: string,
  fieldPaths: readonly string[],
): unknown[] | undefined {
  for (const segment of frozen) {
    const internalId = segment.docStore.getInternalId(docId)
    if (internalId === undefined) continue
    return fieldPaths.map(fieldPath => segment.docStore.fieldReader(fieldPath)(internalId))
  }
  return live.fieldValues(docId, fieldPaths)
}

export function* compositeDocIds(frozen: readonly FrozenSegment[], live: PartitionIndex): IterableIterator<string> {
  for (const segment of frozen) {
    for (const internalId of segment.docStore.allInternalIds()) {
      const docId = segment.docStore.getExternalId(internalId)
      if (docId !== undefined) yield docId
    }
  }
  yield* live.docIds()
}

export function compositeSortedDocIds(frozen: readonly FrozenSegment[], live: PartitionIndex): readonly string[] {
  const merged: string[] = []
  for (const segment of frozen) {
    merged.push(...segment.docStore.sortedDocIds())
  }
  merged.push(...live.sortedDocIds())
  merged.sort(compareCodePoints)
  return merged
}
