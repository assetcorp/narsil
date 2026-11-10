import { createDocIdMap } from '#platform/doc-id-tables'
import type { InternalIdResolver, StoredDocument } from '../../types/internal'
import type { AnyDocument } from '../../types/schema'
import { compareCodePoints } from '../ordering'
import { getNestedValue } from '../partition/utils'
import { cloneProjected, type ResolvedProjection } from '../projection'
import { FIELD_LENGTH_INITIAL_CAPACITY } from './constants'
import { LiveOrdinals } from './live'
import type { DocumentStore, ReadonlyStoredDocument } from './types'
import { documentValueBytes, documentWithOwnBuffers } from './values'

export function createDocumentStore(): DocumentStore {
  const internalIds = createDocIdMap<number>()
  const storedById: Array<StoredDocument | undefined> = []
  const reverseMap: Array<string | undefined> = []
  const lengthColumns = new Map<string, Uint32Array>()
  const live = new LiveOrdinals()
  let nextInternalId = 0
  let numberingResets = 0
  let sortedIds: string[] | null = null
  let storedContentBytes = 0
  let storedCount = 0
  let newestNumberedDocId: string | undefined

  function storedOf(docId: string): StoredDocument | undefined {
    const internalId = internalIds.get(docId)
    return internalId === undefined ? undefined : storedById[internalId]
  }

  function putStored(docId: string, internalId: number, stored: StoredDocument): void {
    if (storedById[internalId] === undefined) {
      storedCount++
      sortedIds = null
      if (docId !== newestNumberedDocId) {
        internalIds.delete(docId)
        internalIds.set(docId, internalId)
        newestNumberedDocId = docId
      }
    }
    storedById[internalId] = stored
    live.add(internalId)
  }

  function replaceStored(docId: string, document: AnyDocument, fieldLengths: Record<string, number>): AnyDocument {
    const internalId = assignInternalId(docId)
    const existing = storedById[internalId]
    if (existing !== undefined) storedContentBytes -= documentValueBytes(existing.fields)
    writeFieldLengths(internalId, fieldLengths)
    const fields = documentWithOwnBuffers(document) as Record<string, unknown>
    storedContentBytes += documentValueBytes(fields)
    putStored(docId, internalId, { fields, fieldLengths })
    return fields as AnyDocument
  }

  function writeFieldLengths(internalId: number, fieldLengths: Record<string, number>): void {
    for (const fieldName of Object.keys(fieldLengths)) {
      let column = lengthColumns.get(fieldName)
      if (column === undefined || column.length <= internalId) {
        const grown = new Uint32Array(
          Math.max(internalId + 1, (column?.length ?? 0) * 2, FIELD_LENGTH_INITIAL_CAPACITY),
        )
        if (column !== undefined) grown.set(column)
        column = grown
        lengthColumns.set(fieldName, column)
      }
      column[internalId] = fieldLengths[fieldName]
    }
  }

  function assignInternalId(docId: string): number {
    const existing = internalIds.get(docId)
    if (existing !== undefined) return existing
    const internalId = nextInternalId
    live.reserve(internalId)
    nextInternalId++
    internalIds.set(docId, internalId)
    newestNumberedDocId = docId
    reverseMap[internalId] = docId
    return internalId
  }

  function clearMappings(): void {
    live.clear()
    internalIds.clear()
    storedById.length = 0
    reverseMap.length = 0
    nextInternalId = 0
    storedCount = 0
    newestNumberedDocId = undefined
    numberingResets++
    sortedIds = null
  }

  function* storedEntries(): IterableIterator<[string, StoredDocument]> {
    for (const [docId, internalId] of internalIds) {
      const stored = storedById[internalId]
      if (stored !== undefined) yield [docId, stored]
    }
  }

  function* liveIds(): IterableIterator<number> {
    for (let internalId = 0; internalId < storedById.length; internalId++) {
      if (storedById[internalId] !== undefined) yield internalId
    }
  }

  const idResolver: InternalIdResolver = {
    toExternal(internalId: number): string | undefined {
      return reverseMap[internalId]
    },
    toInternal(externalId: string): number | undefined {
      return internalIds.get(externalId)
    },
    isLive(internalId: number): boolean {
      return reverseMap[internalId] !== undefined
    },
  }

  return {
    store(docId: string, document: AnyDocument, fieldLengths: Record<string, number>): AnyDocument {
      return replaceStored(docId, document, fieldLengths)
    },

    storeRef(docId: string, document: AnyDocument, fieldLengths: Record<string, number>): AnyDocument {
      return replaceStored(docId, document, fieldLengths)
    },

    get(docId: string): ReadonlyStoredDocument | undefined {
      return storedOf(docId)
    },

    remove(docId: string): boolean {
      const internalId = internalIds.get(docId)
      const existing = internalId === undefined ? undefined : storedById[internalId]
      if (internalId === undefined) return false
      if (existing === undefined) {
        internalIds.delete(docId)
        reverseMap[internalId] = undefined
        if (internalId === nextInternalId - 1) nextInternalId--
        if (newestNumberedDocId === docId) newestNumberedDocId = undefined
        return false
      }
      storedContentBytes -= documentValueBytes(existing.fields)
      sortedIds = null
      storedCount--
      internalIds.delete(docId)
      storedById[internalId] = undefined
      live.remove(internalId)
      reverseMap[internalId] = undefined
      for (const column of lengthColumns.values()) {
        if (internalId < column.length) column[internalId] = 0
      }
      return true
    },

    has(docId: string): boolean {
      return storedOf(docId) !== undefined
    },

    count(): number {
      return storedCount
    },

    all(): IterableIterator<[string, ReadonlyStoredDocument]> {
      return storedEntries()
    },

    sortedDocIds(): readonly string[] {
      if (sortedIds === null) {
        const ids: string[] = []
        for (const [docId] of storedEntries()) ids.push(docId)
        ids.sort(compareCodePoints)
        sortedIds = ids
      }
      return sortedIds
    },

    releaseSortedDocIds(): void {
      sortedIds = null
    },

    clear(): void {
      lengthColumns.clear()
      clearMappings()
      storedContentBytes = 0
    },

    serialize(): Record<string, StoredDocument> {
      const result: Record<string, StoredDocument> = {}
      for (const [docId, stored] of storedEntries()) {
        result[docId] = stored
      }
      return result
    },

    deserialize(data: Record<string, StoredDocument>): void {
      lengthColumns.clear()
      clearMappings()
      storedContentBytes = 0
      for (const docId of Object.keys(data)) {
        const stored = data[docId]
        const internalId = assignInternalId(docId)
        writeFieldLengths(internalId, stored.fieldLengths)
        const fields = documentWithOwnBuffers(stored.fields as AnyDocument) as Record<string, unknown>
        storedContentBytes += documentValueBytes(fields)
        putStored(docId, internalId, fields === stored.fields ? stored : { fields, fieldLengths: stored.fieldLengths })
      }
    },

    fieldLengthColumn(fieldName: string): Uint32Array | null {
      return lengthColumns.get(fieldName) ?? null
    },

    ensureInternalId(docId: string): number {
      return assignInternalId(docId)
    },

    getInternalId(docId: string): number | undefined {
      return internalIds.get(docId)
    },

    getExternalId(internalId: number): string | undefined {
      return reverseMap[internalId]
    },

    *allInternalIds(): IterableIterator<number> {
      for (let internalId = 0; internalId < reverseMap.length; internalId++) {
        if (reverseMap[internalId] !== undefined) yield internalId
      }
    },

    liveOrdinals: () => live.regions(nextInternalId, liveIds),
    liveOrdinalBytes: () => live.bytes(),

    internalIdCapacity(): number {
      return nextInternalId
    },

    numberingGeneration(): number {
      return numberingResets
    },

    contentBytes(): number {
      return storedContentBytes
    },

    resolver(): InternalIdResolver {
      return idResolver
    },

    fieldReader(fieldPath: string): (internalId: number) => unknown {
      return internalId => {
        const stored = storedById[internalId]
        return stored === undefined ? undefined : getNestedValue(stored.fields, fieldPath)
      }
    },

    projectedDocument(docId: string, projection?: ResolvedProjection): AnyDocument | undefined {
      const stored = storedOf(docId)
      return stored === undefined ? undefined : cloneProjected(stored.fields, projection)
    },
  }
}
