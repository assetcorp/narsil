import type { InternalIdResolver, StoredDocument } from '../types/internal'
import type { AnyDocument } from '../types/schema'
import { compareCodePoints } from './ordering'

export type ReadonlyStoredDocument = {
  readonly fields: Readonly<Record<string, unknown>>
  readonly fieldLengths: Readonly<Record<string, number>>
}

export interface DocumentStore {
  store(docId: string, document: AnyDocument, fieldLengths: Record<string, number>): void
  storeRef(docId: string, document: AnyDocument, fieldLengths: Record<string, number>): void
  get(docId: string): ReadonlyStoredDocument | undefined
  remove(docId: string): boolean
  has(docId: string): boolean
  count(): number
  all(): IterableIterator<[string, ReadonlyStoredDocument]>
  clear(): void
  serialize(): Record<string, StoredDocument>
  deserialize(data: Record<string, StoredDocument>): void

  sortedDocIds(): readonly string[]
  releaseSortedDocIds(): void

  fieldLengthColumn(fieldName: string): Uint32Array | null
  ensureInternalId(docId: string): number
  getInternalId(docId: string): number | undefined
  getExternalId(internalId: number): string | undefined
  allInternalIds(): IterableIterator<number>
  internalIdCapacity(): number
  resolver(): InternalIdResolver
}

export function createDocumentStore(): DocumentStore {
  const docs = new Map<string, StoredDocument>()
  const forwardMap = new Map<string, number>()
  const reverseMap: Array<string | undefined> = []
  const lengthColumns = new Map<string, Uint32Array>()
  let nextInternalId = 0
  let sortedIds: string[] | null = null

  function writeFieldLengths(internalId: number, fieldLengths: Record<string, number>): void {
    for (const fieldName of Object.keys(fieldLengths)) {
      let column = lengthColumns.get(fieldName)
      if (column === undefined || column.length <= internalId) {
        const grown = new Uint32Array(Math.max(internalId + 1, (column?.length ?? 0) * 2, 64))
        if (column !== undefined) grown.set(column)
        column = grown
        lengthColumns.set(fieldName, column)
      }
      column[internalId] = fieldLengths[fieldName]
    }
  }

  function assignInternalId(docId: string): number {
    const existing = forwardMap.get(docId)
    if (existing !== undefined) return existing
    const internalId = nextInternalId++
    forwardMap.set(docId, internalId)
    reverseMap[internalId] = docId
    return internalId
  }

  function clearMappings(): void {
    forwardMap.clear()
    reverseMap.length = 0
    nextInternalId = 0
    sortedIds = null
  }

  const idResolver: InternalIdResolver = {
    toExternal(internalId: number): string | undefined {
      return reverseMap[internalId]
    },
    toInternal(externalId: string): number | undefined {
      return forwardMap.get(externalId)
    },
  }

  return {
    store(docId: string, document: AnyDocument, fieldLengths: Record<string, number>): void {
      if (!docs.has(docId)) sortedIds = null
      writeFieldLengths(assignInternalId(docId), fieldLengths)
      docs.set(docId, { fields: document as Record<string, unknown>, fieldLengths })
    },

    storeRef(docId: string, document: AnyDocument, fieldLengths: Record<string, number>): void {
      if (!docs.has(docId)) sortedIds = null
      writeFieldLengths(assignInternalId(docId), fieldLengths)
      docs.set(docId, { fields: document as Record<string, unknown>, fieldLengths })
    },

    get(docId: string): ReadonlyStoredDocument | undefined {
      return docs.get(docId)
    },

    remove(docId: string): boolean {
      const removed = docs.delete(docId)
      if (removed) {
        sortedIds = null
        const internalId = forwardMap.get(docId)
        if (internalId !== undefined) {
          forwardMap.delete(docId)
          reverseMap[internalId] = undefined
          for (const column of lengthColumns.values()) {
            if (internalId < column.length) column[internalId] = 0
          }
        }
      }
      return removed
    },

    has(docId: string): boolean {
      return docs.has(docId)
    },

    count(): number {
      return docs.size
    },

    all(): IterableIterator<[string, ReadonlyStoredDocument]> {
      return docs.entries() as IterableIterator<[string, ReadonlyStoredDocument]>
    },

    sortedDocIds(): readonly string[] {
      if (sortedIds === null) {
        const ids = Array.from(docs.keys())
        ids.sort(compareCodePoints)
        sortedIds = ids
      }
      return sortedIds
    },

    releaseSortedDocIds(): void {
      sortedIds = null
    },

    clear(): void {
      docs.clear()
      lengthColumns.clear()
      clearMappings()
    },

    serialize(): Record<string, StoredDocument> {
      const result: Record<string, StoredDocument> = {}
      for (const [docId, stored] of docs) {
        result[docId] = stored
      }
      return result
    },

    deserialize(data: Record<string, StoredDocument>): void {
      docs.clear()
      lengthColumns.clear()
      clearMappings()
      for (const docId of Object.keys(data)) {
        const stored = data[docId]
        writeFieldLengths(assignInternalId(docId), stored.fieldLengths)
        docs.set(docId, stored)
      }
    },

    fieldLengthColumn(fieldName: string): Uint32Array | null {
      return lengthColumns.get(fieldName) ?? null
    },

    ensureInternalId(docId: string): number {
      return assignInternalId(docId)
    },

    getInternalId(docId: string): number | undefined {
      return forwardMap.get(docId)
    },

    getExternalId(internalId: number): string | undefined {
      return reverseMap[internalId]
    },

    *allInternalIds(): IterableIterator<number> {
      for (const internalId of forwardMap.values()) {
        yield internalId
      }
    },

    internalIdCapacity(): number {
      return nextInternalId
    },

    resolver(): InternalIdResolver {
      return idResolver
    },
  }
}
