import type { PostingListView } from '../../types/internal'

const NO_DELETED: PostingListView['deletedDocs'] = { size: 0, has: () => false }
const FIELD_SLOTS = 0x10000
const NO_ROW = -1

interface CombinedRows {
  docIds: number[]
  fieldNameIndices: number[]
  frequencies: number[]
  documents: Set<number>
  totalTermFrequency: number
}

let rowOfField: Int32Array | null = null

function addRow(combined: CombinedRows, rowOf: Int32Array, docId: number, field: number, frequency: number): void {
  combined.totalTermFrequency += frequency
  const existing = rowOf[field]
  if (existing !== NO_ROW) {
    combined.frequencies[existing] += frequency
    return
  }
  rowOf[field] = combined.docIds.length
  combined.docIds.push(docId)
  combined.fieldNameIndices.push(field)
  combined.frequencies.push(frequency)
  combined.documents.add(docId)
}

function lowestDocumentAt(lists: readonly PostingListView[], cursors: Uint32Array): number {
  let lowest = Number.POSITIVE_INFINITY
  for (let at = 0; at < lists.length; at++) {
    if (cursors[at] < lists[at].length && lists[at].docIds[cursors[at]] < lowest) lowest = lists[at].docIds[cursors[at]]
  }
  return lowest
}

function mergeOrderedLists(lists: readonly PostingListView[], combined: CombinedRows): void {
  rowOfField ??= new Int32Array(FIELD_SLOTS).fill(NO_ROW)
  const rowOf = rowOfField
  const cursors = new Uint32Array(lists.length)
  for (let docId = lowestDocumentAt(lists, cursors); docId !== Number.POSITIVE_INFINITY; ) {
    const runStart = combined.docIds.length
    for (let at = 0; at < lists.length; at++) {
      const list = lists[at]
      const deleted = list.deletedDocs.size > 0 && list.deletedDocs.has(docId)
      let row = cursors[at]
      for (; row < list.length && list.docIds[row] === docId; row++) {
        if (!deleted) addRow(combined, rowOf, docId, list.fieldNameIndices[row], list.termFrequencies[row])
      }
      cursors[at] = row
    }
    for (let row = runStart; row < combined.docIds.length; row++) rowOf[combined.fieldNameIndices[row]] = NO_ROW
    docId = lowestDocumentAt(lists, cursors)
  }
}

function combineUnorderedLists(lists: readonly PostingListView[], combined: CombinedRows): void {
  const rowOf = new Map<number, number>()
  for (const list of lists) {
    const deleted = list.deletedDocs
    const hasDeleted = deleted.size > 0
    for (let row = 0; row < list.length; row++) {
      const docId = list.docIds[row]
      if (hasDeleted && deleted.has(docId)) continue
      const field = list.fieldNameIndices[row]
      const frequency = list.termFrequencies[row]
      combined.totalTermFrequency += frequency
      const key = docId * FIELD_SLOTS + field
      const existing = rowOf.get(key)
      if (existing !== undefined) {
        combined.frequencies[existing] += frequency
        continue
      }
      rowOf.set(key, combined.docIds.length)
      combined.docIds.push(docId)
      combined.fieldNameIndices.push(field)
      combined.frequencies.push(frequency)
      combined.documents.add(docId)
    }
  }
}

function rowsByDocument(docIds: readonly number[]): Uint32Array {
  const order = new Uint32Array(docIds.length)
  for (let row = 0; row < order.length; row++) order[row] = row
  return order.sort((left, right) => docIds[left] - docIds[right] || left - right)
}

function listOf(combined: CombinedRows, order: Uint32Array | null): PostingListView {
  const length = combined.docIds.length
  const docIds = new Uint32Array(length)
  const termFrequencies = new Float64Array(length)
  const fieldNameIndices = new Uint16Array(length)
  for (let at = 0; at < length; at++) {
    const row = order === null ? at : order[at]
    docIds[at] = combined.docIds[row]
    termFrequencies[at] = combined.frequencies[row]
    fieldNameIndices[at] = combined.fieldNameIndices[row]
  }
  return {
    length,
    docIds,
    termFrequencies,
    fieldNameIndices,
    positions: null,
    docIdSet: combined.documents,
    deletedDocs: NO_DELETED,
    totalTermFrequency: combined.totalTermFrequency,
    structureRevision: 0,
    ordered: false,
  }
}

export function combinePostingLists(lists: readonly PostingListView[]): PostingListView {
  if (lists.length === 1) return lists[0]
  const combined: CombinedRows = {
    docIds: [],
    fieldNameIndices: [],
    frequencies: [],
    documents: new Set<number>(),
    totalTermFrequency: 0,
  }
  if (lists.every(list => list.ordered)) {
    mergeOrderedLists(lists, combined)
    return listOf(combined, null)
  }
  combineUnorderedLists(lists, combined)
  return listOf(combined, rowsByDocument(combined.docIds))
}
