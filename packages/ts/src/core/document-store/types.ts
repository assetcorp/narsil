import type { InternalIdResolver, StoredDocument } from '../../types/internal'
import type { AnyDocument } from '../../types/schema'
import type { ResolvedProjection } from '../projection'

export type ReadonlyStoredDocument = {
  readonly fields: Readonly<Record<string, unknown>>
  readonly fieldLengths: Readonly<Record<string, number>>
}

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
  liveOrdinals(): Uint32Array
  liveOrdinalBytes(): number
  internalIdCapacity(): number
  numberingGeneration(): number
  contentBytes(): number
  resolver(): InternalIdResolver
  fieldReader(fieldPath: string): (internalId: number) => unknown
  projectedDocument(docId: string, projection?: ResolvedProjection): AnyDocument | undefined
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
