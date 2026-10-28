import type { InternalIdResolver } from '../../../types/internal'
import type { AnyDocument } from '../../../types/schema'
import type { DocumentStoreReader, ReadonlyStoredDocument } from '../../document-store'
import type { ResolvedProjection } from '../../projection'
import type { FrozenDocumentSource } from './document-source'
import type { ExternalIdTable } from './external-ids'
import type { FrozenTombstones } from './tombstones'

export function createFrozenDocTable(
  idTable: ExternalIdTable,
  lengthColumns: ReadonlyMap<string, Uint32Array>,
  documents: FrozenDocumentSource,
  tombstones: FrozenTombstones,
): DocumentStoreReader {
  const capacity = idTable.count
  let sortedIds: string[] | null = null
  let sortedRevision = -1

  function storedAt(ordinal: number): ReadonlyStoredDocument {
    const fieldLengths: Record<string, number> = {}
    for (const [fieldName, column] of lengthColumns) {
      const length = column[ordinal]
      if (length > 0) fieldLengths[fieldName] = length
    }
    return { fields: documents.docAt(ordinal) as Record<string, unknown>, fieldLengths }
  }

  function liveOrdinal(docId: string): number | undefined {
    const ordinal = idTable.ordinalOf(docId)
    if (ordinal < 0 || tombstones.has(ordinal)) return undefined
    return ordinal
  }

  const resolver: InternalIdResolver = {
    toExternal(internalId: number): string | undefined {
      if (internalId < 0 || internalId >= capacity || tombstones.has(internalId)) return undefined
      return idTable.idAt(internalId)
    },
    toInternal(externalId: string): number | undefined {
      return liveOrdinal(externalId)
    },
    isLive(internalId: number): boolean {
      return internalId >= 0 && internalId < capacity && !tombstones.has(internalId)
    },
  }

  return {
    get(docId: string): ReadonlyStoredDocument | undefined {
      const ordinal = liveOrdinal(docId)
      if (ordinal === undefined) return undefined
      return storedAt(ordinal)
    },

    has(docId: string): boolean {
      return liveOrdinal(docId) !== undefined
    },

    count(): number {
      return capacity - tombstones.size
    },

    *all(): IterableIterator<[string, ReadonlyStoredDocument]> {
      for (let ordinal = 0; ordinal < capacity; ordinal++) {
        if (tombstones.has(ordinal)) continue
        yield [idTable.idAt(ordinal), storedAt(ordinal)]
      }
    },

    sortedDocIds(): readonly string[] {
      if (sortedIds === null || sortedRevision !== tombstones.revision) {
        sortedIds = idTable.collectSortedIds(ordinal => tombstones.has(ordinal))
        sortedRevision = tombstones.revision
      }
      return sortedIds
    },

    releaseSortedDocIds(): void {
      sortedIds = null
    },

    fieldLengthColumn(fieldName: string): Uint32Array | null {
      return lengthColumns.get(fieldName) ?? null
    },

    getInternalId(docId: string): number | undefined {
      return liveOrdinal(docId)
    },

    getExternalId(internalId: number): string | undefined {
      return resolver.toExternal(internalId)
    },

    *allInternalIds(): IterableIterator<number> {
      for (let ordinal = 0; ordinal < capacity; ordinal++) {
        if (!tombstones.has(ordinal)) yield ordinal
      }
    },

    internalIdCapacity(): number {
      return capacity
    },

    contentBytes(): number {
      return documents.byteLength
    },

    resolver(): InternalIdResolver {
      return resolver
    },

    fieldReader(fieldPath: string): (internalId: number) => unknown {
      const read = documents.fieldReader(fieldPath)
      return internalId => (resolver.isLive(internalId) ? read(internalId) : undefined)
    },

    projectedDocument(docId: string, projection?: ResolvedProjection): AnyDocument | undefined {
      const ordinal = liveOrdinal(docId)
      return ordinal === undefined ? undefined : documents.projectedAt(ordinal, projection)
    },
  }
}
