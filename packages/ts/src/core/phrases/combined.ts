import type { PostingListView } from '../../types/internal'
import type { NativePhrasePostings } from '../../vector/native/types/phrases'
import { MAX_HELD_FOLDED_PHRASE_POSTINGS } from './constants'
import { missingPostings, phrasePostings } from './postings'

interface Cursor {
  part: NativePhrasePostings
  order: Uint32Array | null
  at: number
}

interface HeldCombination {
  parts: readonly NativePhrasePostings[]
  postings: NativePhrasePostings
}

const combinations = new WeakMap<PostingListView, HeldCombination[]>()

function documentOrder(part: NativePhrasePostings): Uint32Array | null {
  if (part.ordered) return null
  const order = new Uint32Array(part.documents.length)
  for (let row = 0; row < order.length; row++) order[row] = row
  return order.sort((left, right) => part.documents[left] - part.documents[right] || left - right)
}

function rowOf(cursor: Cursor): number {
  return cursor.order === null ? cursor.at : cursor.order[cursor.at]
}

function lowestDocument(cursors: readonly Cursor[]): number {
  let lowest = -1
  for (const cursor of cursors) {
    if (cursor.at >= cursor.part.documents.length) continue
    const document = cursor.part.documents[rowOf(cursor)]
    if (lowest === -1 || document < lowest) lowest = document
  }
  return lowest
}

function mergedPostings(parts: readonly NativePhrasePostings[]): NativePhrasePostings {
  let rowCount = 0
  let positionCount = 0
  for (const part of parts) {
    rowCount += part.documents.length
    for (let row = 0; row < part.documents.length; row++) positionCount += part.positionCounts[row]
  }
  const documents = new Uint32Array(rowCount)
  const fields = new Uint16Array(rowCount)
  const positionStarts = new Uint32Array(rowCount)
  const positionCounts = new Uint32Array(rowCount)
  const positions = new Uint32Array(positionCount)
  const cursors: Cursor[] = parts.map(part => ({ part, order: documentOrder(part), at: 0 }))
  const sameDocument: Array<{ part: NativePhrasePostings; row: number }> = []
  let written = 0
  let filled = 0
  for (let document = lowestDocument(cursors); document !== -1; document = lowestDocument(cursors)) {
    sameDocument.length = 0
    for (const cursor of cursors) {
      while (cursor.at < cursor.part.documents.length && cursor.part.documents[rowOf(cursor)] === document) {
        sameDocument.push({ part: cursor.part, row: rowOf(cursor) })
        cursor.at++
      }
    }
    sameDocument.sort((left, right) => left.part.fields[left.row] - right.part.fields[right.row])
    for (let first = 0; first < sameDocument.length; ) {
      const field = sameDocument[first].part.fields[sameDocument[first].row]
      const start = filled
      let last = first
      for (; last < sameDocument.length; last++) {
        const { part, row } = sameDocument[last]
        if (part.fields[row] !== field) break
        const from = part.positionStarts[row]
        positions.set(part.positions.subarray(from, from + part.positionCounts[row]), filled)
        filled += part.positionCounts[row]
      }
      if (last - first > 1) positions.subarray(start, filled).sort()
      documents[written] = document
      fields[written] = field
      positionStarts[written] = start
      positionCounts[written] = filled - start
      written++
      first = last
    }
  }
  return {
    documents: documents.subarray(0, written),
    fields: fields.subarray(0, written),
    positionStarts: positionStarts.subarray(0, written),
    positionCounts: positionCounts.subarray(0, written),
    positions: positions.subarray(0, filled),
    ordered: true,
  }
}

function sameParts(left: readonly NativePhrasePostings[], right: readonly NativePhrasePostings[]): boolean {
  return left.length === right.length && left.every((part, at) => part === right[at])
}

export function combinedPhrasePostings(lists: readonly PostingListView[]): NativePhrasePostings {
  const parts = lists.map(phrasePostings).filter(part => part.documents.length > 0)
  if (parts.length === 0) return missingPostings
  if (parts.length === 1) return parts[0]
  const held = combinations.get(lists[0]) ?? []
  const found = held.find(combination => sameParts(combination.parts, parts))
  if (found !== undefined) return found.postings
  const postings = mergedPostings(parts)
  const kept = held.filter(combination => combination.parts[0] === parts[0])
  combinations.set(lists[0], [...kept.slice(1 - MAX_HELD_FOLDED_PHRASE_POSTINGS), { parts, postings }])
  return postings
}
