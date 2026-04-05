import type { InternalIdResolver, StoredDocument } from '../types/internal'
import type { AnyDocument } from '../types/schema'

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

  ensureInternalId(docId: string): number
  getInternalId(docId: string): number | undefined
  getExternalId(internalId: number): string | undefined
  allInternalIds(): IterableIterator<number>
  resolver(): InternalIdResolver
}

export function createDocumentStore(): DocumentStore {
  const docs = new Map<string, StoredDocument>()
  const forwardMap = new Map<string, number>()
  const reverseMap: Array<string | undefined> = []
  let nextInternalId = 0

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
      assignInternalId(docId)
      docs.set(docId, { fields: document as Record<string, unknown>, fieldLengths })
    },

    storeRef(docId: string, document: AnyDocument, fieldLengths: Record<string, number>): void {
      assignInternalId(docId)
      docs.set(docId, { fields: document as Record<string, unknown>, fieldLengths })
    },

    get(docId: string): ReadonlyStoredDocument | undefined {
      return docs.get(docId)
    },

    remove(docId: string): boolean {
      const removed = docs.delete(docId)
      if (removed) {
        const internalId = forwardMap.get(docId)
        if (internalId !== undefined) {
          forwardMap.delete(docId)
          reverseMap[internalId] = undefined
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

    clear(): void {
      docs.clear()
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
      clearMappings()
      for (const docId of Object.keys(data)) {
        assignInternalId(docId)
        docs.set(docId, data[docId])
      }
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

    resolver(): InternalIdResolver {
      return idResolver
    },
  }
}
