import type { OpenStore, OrdinalDocuments } from './open-store'
import { entryAt } from './ordinal-reads'
import type { VectorStoreEntry, VectorStoreSnapshot } from './types'

export function* entriesOf(
  open: OpenStore | null,
  documents: OrdinalDocuments,
): IterableIterator<[string, VectorStoreEntry]> {
  if (open === null) return
  for (let ordinal = 0; ordinal < documents.length; ordinal++) {
    const docId = documents[ordinal]
    if (docId === undefined) continue
    yield [docId, entryAt(open, ordinal)]
  }
}

export function* docIdsOf(open: OpenStore | null, documents: OrdinalDocuments): IterableIterator<string> {
  if (open === null) return
  for (let ordinal = 0; ordinal < documents.length; ordinal++) {
    const docId = documents[ordinal]
    if (docId !== undefined) yield docId
  }
}

export function snapshotOf(
  open: OpenStore | null,
  documents: OrdinalDocuments,
  replacedOrdinals: ReadonlySet<number>,
): VectorStoreSnapshot {
  const slots = documents.length
  const dimension = open === null ? 0 : open.handles.dimension
  const vectors = new Float32Array(slots * dimension)
  const magnitudes = new Float64Array(slots)
  const docIds: Array<string | null> = new Array(slots)
  for (let ordinal = 0; ordinal < slots; ordinal++) {
    docIds[ordinal] = documents[ordinal] ?? null
    if (open === null || (documents[ordinal] === undefined && !replacedOrdinals.has(ordinal))) continue
    vectors.set(open.view.vectorAt(ordinal), ordinal * dimension)
    magnitudes[ordinal] = open.magnitudes[ordinal]
  }
  return { dimension, slots, vectors, magnitudes, docIds, replacedOrdinals: [...replacedOrdinals] }
}
