import { ErrorCodes, NarsilError } from '../../errors'
import type { BatchResult } from '../../types/results'
import type { AnyDocument } from '../../types/schema'
import { BATCH_CHUNK_SIZE } from '../constants'
import type { DocumentBound } from './document-bound'
import type { CountExactly, ProjectedGroup } from './write-projection'

export interface MemoryReservation {
  release(): void
}

export interface MemoryGroupRefusal {
  refusedDocId: string
}

export interface MemoryGroupedItem {
  docId: string
  document: AnyDocument
}

export interface MemoryGroupedWrite<T extends MemoryGroupedItem> {
  items: T[]
  failed: BatchResult['failed']
  apply: (group: T[]) => Promise<void>
  mostDocuments?: number
}

export interface GroupedWriteProjection {
  boundOf(indexName: string): DocumentBound | null
  countedBoundOf(indexName: string): DocumentBound | null
  takeGroup(
    indexName: string,
    bounds: readonly number[],
    start: number,
    mostDocuments: number,
    countExactly: CountExactly,
  ): ProjectedGroup
  refusedAfter(indexName: string, docId: string, refusedDocId: string): NarsilError
}

function exactCounter(
  projection: GroupedWriteProjection,
  indexName: string,
  bounds: number[],
  documents: readonly AnyDocument[],
): CountExactly {
  const counted = new Set<number>()
  return position => {
    if (counted.has(position)) return
    counted.add(position)
    const bound = projection.countedBoundOf(indexName)
    if (bound === null) return
    try {
      bounds[position] = Math.min(bounds[position], bound(documents[position]))
    } catch {}
  }
}

const NOTHING_RESERVED: MemoryReservation = { release: () => {} }

const UNBOUNDED_DOCUMENT_BYTES = 0

function asDocumentError(err: unknown, docId: string): NarsilError {
  return err instanceof NarsilError ? err : new NarsilError(ErrorCodes.DOC_VALIDATION_FAILED, String(err), { docId })
}

function boundOrNothing(bound: DocumentBound, document: AnyDocument): number {
  try {
    return bound(document)
  } catch {
    return UNBOUNDED_DOCUMENT_BYTES
  }
}

export function reserveForDocument(
  projection: GroupedWriteProjection,
  indexName: string,
  document: AnyDocument,
): MemoryReservation {
  const bound = projection.boundOf(indexName)
  if (bound === null) return NOTHING_RESERVED
  const bounds = [boundOrNothing(bound, document)]
  if (bounds[0] === UNBOUNDED_DOCUMENT_BYTES) return NOTHING_RESERVED
  return projection.takeGroup(indexName, bounds, 0, 1, exactCounter(projection, indexName, bounds, [document]))
}

export async function applyInGroups<T extends MemoryGroupedItem>(
  projection: GroupedWriteProjection,
  indexName: string,
  write: MemoryGroupedWrite<T>,
): Promise<MemoryGroupRefusal | null> {
  const bound = projection.boundOf(indexName)
  if (bound === null) {
    if (write.items.length > 0) await write.apply(write.items)
    return null
  }

  const bounded = write.items
  const bounds = bounded.map(item => boundOrNothing(bound, item.document))

  const mostDocuments = write.mostDocuments ?? BATCH_CHUNK_SIZE
  const countExactly = exactCounter(
    projection,
    indexName,
    bounds,
    bounded.map(item => item.document),
  )
  let start = 0
  while (start < bounded.length) {
    let group: ProjectedGroup
    try {
      group = projection.takeGroup(indexName, bounds, start, mostDocuments, countExactly)
    } catch (err) {
      const refusedDocId = bounded[start].docId
      write.failed.push({ docId: refusedDocId, error: asDocumentError(err, refusedDocId) })
      for (let index = start + 1; index < bounded.length; index++) {
        const docId = bounded[index].docId
        write.failed.push({ docId, error: projection.refusedAfter(indexName, docId, refusedDocId) })
      }
      return { refusedDocId }
    }
    try {
      await write.apply(bounded.slice(start, start + group.count))
    } finally {
      group.release()
    }
    start += group.count
  }
  return null
}
