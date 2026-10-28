import type { PostingListView } from '../../types/internal'

const NO_DELETED: PostingListView['deletedDocs'] = { size: 0, has: () => false }
const FIELD_SLOTS = 0x10000

export function combinePostingLists(lists: readonly PostingListView[]): PostingListView {
  if (lists.length === 1) return lists[0]
  const rowOf = new Map<number, number>()
  const docIds: number[] = []
  const fieldNameIndices: number[] = []
  const frequencies: number[] = []
  const documents = new Set<number>()
  let totalTermFrequency = 0
  for (const list of lists) {
    const deleted = list.deletedDocs
    const hasDeleted = deleted.size > 0
    for (let row = 0; row < list.length; row++) {
      const docId = list.docIds[row]
      if (hasDeleted && deleted.has(docId)) continue
      const field = list.fieldNameIndices[row]
      const frequency = list.termFrequencies[row]
      totalTermFrequency += frequency
      const key = docId * FIELD_SLOTS + field
      const existing = rowOf.get(key)
      if (existing !== undefined) {
        frequencies[existing] += frequency
        continue
      }
      rowOf.set(key, docIds.length)
      docIds.push(docId)
      fieldNameIndices.push(field)
      frequencies.push(frequency)
      documents.add(docId)
    }
  }
  return {
    length: docIds.length,
    docIds: Uint32Array.from(docIds),
    termFrequencies: Float64Array.from(frequencies),
    fieldNameIndices: Uint16Array.from(fieldNameIndices),
    positions: null,
    docIdSet: documents,
    deletedDocs: NO_DELETED,
    totalTermFrequency,
    structureRevision: 0,
    ordered: false,
  }
}
