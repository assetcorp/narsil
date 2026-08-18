import type { InternalIdResolver, StoredDocument } from '../types/internal'
import type { AnyDocument } from '../types/schema'
import { compareCodePoints } from './ordering'

export type ReadonlyStoredDocument = {
  readonly fields: Readonly<Record<string, unknown>>
  readonly fieldLengths: Readonly<Record<string, number>>
}

/**
 * The reads the query path performs against a document store. The live store
 * implements it over its maps, and a frozen segment implements it over the
 * segment's document table.
 *
 * @internal
 */
export interface DocumentStoreReader {
  get(docId: string): ReadonlyStoredDocument | undefined
  has(docId: string): boolean
  count(): number
  all(): IterableIterator<[string, ReadonlyStoredDocument]>
  sortedDocIds(): readonly string[]
  releaseSortedDocIds(): void
  fieldLengthColumn(fieldName: string): Uint32Array | null
  getInternalId(docId: string): number | undefined
  getExternalId(internalId: number): string | undefined
  allInternalIds(): IterableIterator<number>
  internalIdCapacity(): number
  resolver(): InternalIdResolver
}

export interface DocumentStore extends DocumentStoreReader {
  store(docId: string, document: AnyDocument, fieldLengths: Record<string, number>): void
  storeRef(docId: string, document: AnyDocument, fieldLengths: Record<string, number>): void
  remove(docId: string): boolean
  clear(): void
  serialize(): Record<string, StoredDocument>
  deserialize(data: Record<string, StoredDocument>): void
  ensureInternalId(docId: string): number
}

type SliceableView = ArrayBufferView & { slice(begin?: number, end?: number): ArrayBufferView }

function detachedView(view: ArrayBufferView): ArrayBufferView {
  if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) return view
  if (view instanceof DataView) {
    return new DataView(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength))
  }
  return (view as SliceableView).slice()
}

function sharesABiggerBuffer(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false
  if (ArrayBuffer.isView(value)) return value.byteOffset !== 0 || value.byteLength !== value.buffer.byteLength

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (sharesABiggerBuffer(value[i])) return true
    }
    return false
  }

  const source = value as Record<string, unknown>
  for (const key of Object.keys(source)) {
    if (sharesABiggerBuffer(source[key])) return true
  }
  return false
}

function withOwnBuffers(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (ArrayBuffer.isView(value)) return detachedView(value)

  if (Array.isArray(value)) {
    const copy = new Array(value.length)
    for (let i = 0; i < value.length; i++) {
      copy[i] = withOwnBuffers(value[i])
    }
    return copy
  }

  const source = value as Record<string, unknown>
  const copy: Record<string, unknown> = {}
  for (const key of Object.keys(source)) {
    Object.defineProperty(copy, key, {
      value: withOwnBuffers(source[key]),
      writable: true,
      enumerable: true,
      configurable: true,
    })
  }
  return copy
}

/**
 * Gives a document its own memory where a field points into a buffer larger
 * than itself. Msgpack decodes a binary field as a window onto the buffer it
 * read, so a document recovered from a snapshot holds a vector that reports
 * six kilobytes and carries the whole partition behind it. Every copy of that
 * document, and every structured clone a worker boundary makes, would move the
 * partition rather than the vector, and the buffer would stay in memory for as
 * long as one document did.
 *
 * @param document - The document about to reach the store.
 * @returns The document itself where every field already owns its memory, and
 * a copy carrying loose fields otherwise.
 */
export function documentWithOwnBuffers(document: AnyDocument): AnyDocument {
  if (!sharesABiggerBuffer(document)) return document
  return withOwnBuffers(document) as AnyDocument
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
      docs.set(docId, { fields: documentWithOwnBuffers(document) as Record<string, unknown>, fieldLengths })
    },

    storeRef(docId: string, document: AnyDocument, fieldLengths: Record<string, number>): void {
      if (!docs.has(docId)) sortedIds = null
      writeFieldLengths(assignInternalId(docId), fieldLengths)
      docs.set(docId, { fields: documentWithOwnBuffers(document) as Record<string, unknown>, fieldLengths })
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
        const fields = documentWithOwnBuffers(stored.fields as AnyDocument) as Record<string, unknown>
        docs.set(docId, fields === stored.fields ? stored : { fields, fieldLengths: stored.fieldLengths })
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
