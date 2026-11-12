import type { PartitionIndex } from '../../core/partition'
import { isCompositePartition } from '../../core/partition/composite'
import { partitionStoredFields } from '../../core/stored-values/references'
import type { AnyDocument } from '../../types/schema'
import type { VectorIndex } from '../../vector/vector-index'
import { copyVectorsInto } from './nested-values'
import type { PinnedReads, StatePins } from './state-pins'

export interface CurrentPartitions {
  locate(docId: string): number | undefined
  partitionOf(docId: string): PartitionIndex | undefined
}

export function currentReads(current: CurrentPartitions, vectorIndexes: ReadonlyMap<string, VectorIndex>): PinnedReads {
  const { partitionOf } = current
  return {
    get(docId, projection) {
      const document = partitionOf(docId)?.get(docId, projection)
      if (document !== undefined) copyVectorsInto(document, docId, vectorIndexes, projection)
      return document
    },
    getRef: docId => partitionOf(docId)?.getRef(docId),
    partitionIdOf: docId => current.locate(docId),
    fieldValues: (docId, fieldPaths) => partitionOf(docId)?.fieldValues(docId, fieldPaths),
    storedFields: (docId, fieldPaths) => partitionStoredFields(partitionOf(docId), docId, fieldPaths),
    sortValues: (docId, fields, fieldTypes, modes) => {
      const partition = partitionOf(docId)
      return partition === undefined ? fields.map(() => null) : partition.sortValues(docId, fields, fieldTypes, modes)
    },
    vectorsInto: (document: AnyDocument, docId, projection) =>
      copyVectorsInto(document, docId, vectorIndexes, projection),
  }
}

export function retirePartitions(
  pins: StatePins,
  retired: readonly PartitionIndex[],
  closesPagedSegments: boolean,
): void {
  pins.detach(retired, () => {
    if (!closesPagedSegments) return
    for (const partition of retired) {
      if (!isCompositePartition(partition)) continue
      for (const segment of partition.frozenSegments()) segment.paged?.close()
    }
  })
}

export function leftBehind(earlier: readonly PartitionIndex[], kept: readonly PartitionIndex[]): PartitionIndex[] {
  return earlier.filter(partition => !kept.includes(partition))
}

export interface OwnReads {
  current(): PinnedReads
}

export function ownReadsOf(current: CurrentPartitions, vectorIndexes: ReadonlyMap<string, VectorIndex>): OwnReads {
  let snapshot = new Map(vectorIndexes)
  let reads = currentReads(current, snapshot)
  const holdsCurrentIndexes = (): boolean => {
    if (snapshot.size !== vectorIndexes.size) return false
    if (vectorIndexes.size === 0) return true
    for (const [fieldPath, index] of vectorIndexes) if (snapshot.get(fieldPath) !== index) return false
    return true
  }
  return {
    current() {
      if (holdsCurrentIndexes()) return reads
      snapshot = new Map(vectorIndexes)
      reads = currentReads(current, snapshot)
      return reads
    },
  }
}

export interface VectorWriteWatch {
  watch(): void
}

export function createSearchRetirement(pins: StatePins): (free: () => void | Promise<void>) => Promise<void> {
  const pending = new Set<Promise<void>>()
  return free => {
    pins.afterRelease(() => {
      const disposal = free()
      if (disposal === undefined) return
      pending.add(disposal)
      void disposal.then(
        () => pending.delete(disposal),
        () => pending.delete(disposal),
      )
    })
    return Promise.all(pending).then(() => undefined)
  }
}

export function replaceVectorIndexes(
  current: Map<string, VectorIndex>,
  replacement: Map<string, VectorIndex>,
  retire: (free: () => Promise<void>) => Promise<void>,
): Promise<void> {
  const kept = new Set(replacement.values())
  const retired = [...current.values()].filter(index => !kept.has(index))
  current.clear()
  for (const [field, index] of replacement) current.set(field, index)
  return retire(() => Promise.all(retired.map(index => index.dispose())).then(() => undefined))
}

export function watchVectorWritesFor(
  vectorIndexes: ReadonlyMap<string, VectorIndex>,
  pins: StatePins,
): VectorWriteWatch {
  const watched = new Map<VectorIndex, () => void>()
  const noteWrite = (docId: string): void => pins.beforeWrite(docId)
  return {
    watch() {
      if (watched.size === vectorIndexes.size) {
        let unchanged = true
        for (const index of vectorIndexes.values()) {
          if (!watched.has(index)) {
            unchanged = false
            break
          }
        }
        if (unchanged) return
      }
      if (watched.size > 0) {
        const current = new Set(vectorIndexes.values())
        for (const [index, stop] of watched) {
          if (current.has(index)) continue
          stop()
          watched.delete(index)
        }
      }
      for (const index of vectorIndexes.values()) {
        if (!watched.has(index)) watched.set(index, index.watchWrites(noteWrite))
      }
    },
  }
}
