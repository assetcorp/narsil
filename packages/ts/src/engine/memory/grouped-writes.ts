import { ErrorCodes, NarsilError } from '../../errors'
import type { BatchResult } from '../../types/results'
import type { AnyDocument } from '../../types/schema'
import { BATCH_CHUNK_SIZE } from '../constants'
import type { DocumentBound } from './document-bound'
import type { ProjectedGroup } from './write-projection'

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
  takeGroup(indexName: string, bounds: readonly number[], start: number, mostDocuments: number): ProjectedGroup
  refusedAfter(indexName: string, docId: string, refusedDocId: string): NarsilError
}

const NOTHING_RESERVED: MemoryReservation = { release: () => {} }

function asDocumentError(err: unknown, docId: string): NarsilError {
  return err instanceof NarsilError ? err : new NarsilError(ErrorCodes.DOC_VALIDATION_FAILED, String(err), { docId })
}

export function reserveForDocument(
  projection: GroupedWriteProjection,
  indexName: string,
  document: AnyDocument,
): MemoryReservation {
  const bound = projection.boundOf(indexName)
  if (bound === null) return NOTHING_RESERVED
  return projection.takeGroup(indexName, [bound(document)], 0, 1)
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

  const bounds: number[] = []
  const bounded: T[] = []
  for (const item of write.items) {
    try {
      bounds.push(bound(item.document))
      bounded.push(item)
    } catch (err) {
      write.failed.push({ docId: item.docId, error: asDocumentError(err, item.docId) })
    }
  }

  const mostDocuments = write.mostDocuments ?? BATCH_CHUNK_SIZE
  let start = 0
  while (start < bounded.length) {
    let group: ProjectedGroup
    try {
      group = projection.takeGroup(indexName, bounds, start, mostDocuments)
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
