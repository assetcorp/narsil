import type { StoredDocument } from '../types/internal'
import type { AnyDocument } from '../types/schema'

export type ReadonlyStoredDocument = {
  readonly fields: Readonly<Record<string, unknown>>
  readonly fieldLengths: Readonly<Record<string, number>>
}

export interface DocumentStore {
  store(docId: string, document: AnyDocument, fieldLengths: Record<string, number>): void
  get(docId: string): ReadonlyStoredDocument | undefined
  remove(docId: string): boolean
  has(docId: string): boolean
  count(): number
  all(): IterableIterator<[string, ReadonlyStoredDocument]>
  clear(): void
  serialize(): Record<string, StoredDocument>
  deserialize(data: Record<string, StoredDocument>): void
}

export function createDocumentStore(): DocumentStore {
  const docs = new Map<string, StoredDocument>()

  return {
    store(docId: string, document: AnyDocument, fieldLengths: Record<string, number>): void {
      docs.set(docId, { fields: structuredClone(document), fieldLengths })
    },

    get(docId: string): ReadonlyStoredDocument | undefined {
      return docs.get(docId)
    },

    remove(docId: string): boolean {
      return docs.delete(docId)
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
      for (const docId of Object.keys(data)) {
        docs.set(docId, data[docId])
      }
    },
  }
}
