import type { PostingListView } from '../../types/internal'

const NO_DELETED: PostingListView['deletedDocs'] = { size: 0, has: () => false }
const FIELD_SLOTS = 0x10000
const NO_ROW = -1
const END = Number.POSITIVE_INFINITY

interface CombinedRows {
  docIds: Uint32Array
  fieldNameIndices: Uint16Array
  frequencies: Float64Array
  length: number
  documents: number
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
  const row = combined.length++
  rowOf[field] = row
  combined.docIds[row] = docId
  combined.fieldNameIndices[row] = field
  combined.frequencies[row] = frequency
}

function mergeOrderedLists(lists: readonly PostingListView[], combined: CombinedRows): void {
  rowOfField ??= new Int32Array(FIELD_SLOTS).fill(NO_ROW)
  const rowOf = rowOfField
  const count = lists.length
  const docIds = lists.map(list => list.docIds)
  const fields = lists.map(list => list.fieldNameIndices)
  const frequencies = lists.map(list => list.termFrequencies)
  const deleted = lists.map(list => (list.deletedDocs.size > 0 ? list.deletedDocs : null))
  const lengths = lists.map(list => list.length)
  const cursors = new Uint32Array(count)
  const heads = new Float64Array(count)
  for (let at = 0; at < count; at++) heads[at] = lengths[at] > 0 ? docIds[at][0] : END
  for (;;) {
    let docId = END
    for (let at = 0; at < count; at++) if (heads[at] < docId) docId = heads[at]
    if (docId === END) return
    const runStart = combined.length
    for (let at = 0; at < count; at++) {
      if (heads[at] !== docId) continue
      const ids = docIds[at]
      const skip = deleted[at]?.has(docId) === true
      let row = cursors[at]
      for (; row < lengths[at] && ids[row] === docId; row++) {
        if (!skip) addRow(combined, rowOf, docId, fields[at][row], frequencies[at][row])
      }
      cursors[at] = row
      heads[at] = row < lengths[at] ? ids[row] : END
    }
    if (combined.length > runStart) combined.documents++
    for (let row = runStart; row < combined.length; row++) rowOf[combined.fieldNameIndices[row]] = NO_ROW
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
      const at = combined.length++
      rowOf.set(key, at)
      combined.docIds[at] = docId
      combined.fieldNameIndices[at] = field
      combined.frequencies[at] = frequency
    }
  }
}

function rowsOf(capacity: number): CombinedRows {
  return {
    docIds: new Uint32Array(capacity),
    fieldNameIndices: new Uint16Array(capacity),
    frequencies: new Float64Array(capacity),
    length: 0,
    documents: 0,
    totalTermFrequency: 0,
  }
}

function sortedByDocument(combined: CombinedRows): CombinedRows {
  const length = combined.length
  const ids = combined.docIds
  const order = new Uint32Array(length)
  for (let row = 0; row < length; row++) order[row] = row
  order.sort((left, right) => ids[left] - ids[right] || left - right)
  const sorted = rowsOf(length)
  sorted.length = length
  sorted.totalTermFrequency = combined.totalTermFrequency
  for (let at = 0; at < length; at++) {
    const row = order[at]
    sorted.docIds[at] = ids[row]
    sorted.fieldNameIndices[at] = combined.fieldNameIndices[row]
    sorted.frequencies[at] = combined.frequencies[row]
    if (at === 0 || ids[row] !== sorted.docIds[at - 1]) sorted.documents++
  }
  return sorted
}

export function combinePostingLists(lists: readonly PostingListView[]): PostingListView {
  if (lists.length === 1) return lists[0]
  let capacity = 0
  for (const list of lists) capacity += list.length
  let combined = rowsOf(capacity)
  if (lists.every(list => list.ordered)) mergeOrderedLists(lists, combined)
  else {
    combineUnorderedLists(lists, combined)
    combined = sortedByDocument(combined)
  }
  const length = combined.length
  return {
    length,
    docIds: combined.docIds.subarray(0, length),
    termFrequencies: combined.frequencies.subarray(0, length),
    fieldNameIndices: combined.fieldNameIndices.subarray(0, length),
    positions: null,
    docIdSet: { size: combined.documents },
    deletedDocs: NO_DELETED,
    totalTermFrequency: combined.totalTermFrequency,
    structureRevision: 0,
    ordered: false,
  }
}
