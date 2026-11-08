import type { NativePhrasePostings, NativePhraseRequest } from '../../vector/native/types/phrases'
import { typedRegion } from '../stored-values/regions'

export function bitmapWords(count: number): number {
  return Math.max(1, Math.ceil(count / 32))
}

export function readPhraseRequest(input: NativePhraseRequest): NativePhraseRequest | null {
  if (typeof input !== 'object' || input === null) return null
  const raw = {
    postings: input.postings,
    starts: input.starts,
    tokens: input.tokens,
    offsets: input.offsets,
    searchable: input.searchable,
    filter: input.filter,
    removed: input.removed,
    ordinalCount: input.ordinalCount,
    collect: input.collect,
  }
  if (!Array.isArray(raw.postings)) return null
  const listCount = raw.postings.length
  if (!Number.isInteger(listCount) || listCount < 0 || listCount > 0xffffffff) return null
  const lists: NativePhrasePostings[] = []
  for (let at = 0; at < listCount; at++) {
    const list: NativePhrasePostings = raw.postings[at]
    if (typeof list !== 'object' || list === null) return null
    lists.push({
      documents: list.documents,
      fields: list.fields,
      positionStarts: list.positionStarts,
      positionCounts: list.positionCounts,
      positions: list.positions,
      ordered: list.ordered,
    })
  }
  const postings: NativePhrasePostings[] = []
  for (const list of lists) {
    const documents = typedRegion(list.documents, 'Uint32Array')
    const fields = typedRegion(list.fields, 'Uint16Array')
    const positionStarts = typedRegion(list.positionStarts, 'Uint32Array')
    const positionCounts = typedRegion(list.positionCounts, 'Uint32Array')
    const positions = typedRegion(list.positions, 'Uint32Array')
    if (
      documents === null ||
      fields === null ||
      positionStarts === null ||
      positionCounts === null ||
      positions === null ||
      typeof list.ordered !== 'boolean' ||
      documents.length > 0xffffffff ||
      positions.length > 0xffffffff ||
      fields.length !== documents.length ||
      positionStarts.length !== documents.length ||
      positionCounts.length !== documents.length
    )
      return null
    postings.push({ documents, fields, positionStarts, positionCounts, positions, ordered: list.ordered })
  }
  const starts = typedRegion(raw.starts, 'Uint32Array')
  const tokens = typedRegion(raw.tokens, 'Uint32Array')
  const offsets = typedRegion(raw.offsets, 'Uint32Array')
  const searchable = typedRegion(raw.searchable, 'Uint8Array')
  const filter = raw.filter === null ? null : typedRegion(raw.filter, 'Uint32Array')
  const removed = typedRegion(raw.removed, 'Uint32Array')
  if (
    starts === null ||
    tokens === null ||
    offsets === null ||
    searchable === null ||
    removed === null ||
    (raw.filter !== null && filter === null) ||
    !Number.isInteger(raw.ordinalCount) ||
    raw.ordinalCount < 0 ||
    raw.ordinalCount > 0xffffffff ||
    typeof raw.collect !== 'boolean' ||
    searchable.length > 0x10000 ||
    starts.length === 0 ||
    starts.length - 1 > 0xffffffff ||
    tokens.length > 0xffffffff ||
    offsets.length !== tokens.length ||
    starts[0] !== 0 ||
    starts[starts.length - 1] !== tokens.length ||
    removed.length !== bitmapWords(raw.ordinalCount) ||
    (filter !== null && filter.length !== removed.length)
  )
    return null
  for (let at = 1; at < starts.length; at++) if (starts[at] <= starts[at - 1]) return null
  for (const token of tokens) if (token >= postings.length) return null
  for (const field of searchable) if (field > 1) return null
  return {
    postings,
    starts,
    tokens,
    offsets,
    searchable,
    filter,
    removed,
    ordinalCount: raw.ordinalCount,
    collect: raw.collect,
  }
}

export function phraseReadRegions(request: NativePhraseRequest): ArrayBufferView[] {
  const reads: ArrayBufferView[] = [
    request.starts,
    request.tokens,
    request.offsets,
    request.searchable,
    request.removed,
  ]
  if (request.filter !== null) reads.push(request.filter)
  for (const list of request.postings) {
    reads.push(list.documents, list.fields, list.positionStarts, list.positionCounts, list.positions)
  }
  return reads
}

export function phraseRowCapacity(request: NativePhraseRequest): number {
  let count = 0
  if (!request.collect) return count
  for (let phrase = 0; phrase + 1 < request.starts.length; phrase++) {
    let least = Infinity
    for (let at = request.starts[phrase]; at < request.starts[phrase + 1]; at++) {
      least = Math.min(least, request.postings[request.tokens[at]].documents.length)
    }
    count += least
    if (count > 0xffffffff) return -1
  }
  return count
}
