import type { CompactPostingList } from '../types/internal'

export const INITIAL_CAPACITY = 8
export const MAX_TERM_FREQUENCY = 65535
export const COMPACTION_THRESHOLD = 0.3

export function createPostingList(): CompactPostingList {
  return {
    length: 0,
    docIds: [],
    termFrequencies: new Uint16Array(INITIAL_CAPACITY),
    fieldNameIndices: new Uint8Array(INITIAL_CAPACITY),
    positions: null,
    docIdSet: new Set(),
    deletedDocs: new Set(),
    totalTermFrequency: 0,
    revision: 0,
    ordered: true,
  }
}

export function growTypedArrays(list: CompactPostingList): void {
  const newCap = list.termFrequencies.length * 2

  const newTF = new Uint16Array(newCap)
  newTF.set(list.termFrequencies)
  list.termFrequencies = newTF

  const newFNI = new Uint8Array(newCap)
  newFNI.set(list.fieldNameIndices)
  list.fieldNameIndices = newFNI
}

export function compactList(list: CompactPostingList): void {
  if (list.deletedDocs.size === 0) return
  list.revision++

  let writeIdx = 0
  for (let i = 0; i < list.length; i++) {
    if (!list.deletedDocs.has(list.docIds[i])) {
      if (writeIdx !== i) {
        list.docIds[writeIdx] = list.docIds[i]
        list.termFrequencies[writeIdx] = list.termFrequencies[i]
        list.fieldNameIndices[writeIdx] = list.fieldNameIndices[i]
        if (list.positions) {
          list.positions[writeIdx] = list.positions[i]
        }
      }
      writeIdx++
    } else {
      list.totalTermFrequency -= list.termFrequencies[i]
    }
  }
  list.docIds.length = writeIdx
  if (list.positions) list.positions.length = writeIdx
  list.length = writeIdx
  list.deletedDocs.clear()
}

export function compactDocEntries(list: CompactPostingList, internalId: number): void {
  list.revision++
  let writeIdx = 0
  for (let i = 0; i < list.length; i++) {
    if (list.docIds[i] !== internalId) {
      if (writeIdx !== i) {
        list.docIds[writeIdx] = list.docIds[i]
        list.termFrequencies[writeIdx] = list.termFrequencies[i]
        list.fieldNameIndices[writeIdx] = list.fieldNameIndices[i]
        if (list.positions) {
          list.positions[writeIdx] = list.positions[i]
        }
      }
      writeIdx++
    } else {
      list.totalTermFrequency -= list.termFrequencies[i]
    }
  }
  list.docIds.length = writeIdx
  if (list.positions) list.positions.length = writeIdx
  list.length = writeIdx
}
