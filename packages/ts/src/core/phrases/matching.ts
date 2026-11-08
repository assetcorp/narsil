import type { NativePhrasePostings, NativePhraseRequest } from '../../vector/native/types/phrases'
import { bitsetHas, bitsetSet } from '../bitset'
import { RADIX_BITS } from './constants'
import { sortPhraseRows } from './order'
import { bitmapWords } from './regions'
import type { PhraseWork } from './work'

export interface PhraseOutput {
  matched: Uint32Array
  starts: Uint32Array
  documents: Uint32Array
  fields: Uint16Array
  frequencies: Uint32Array
}

interface PreparedPhrase {
  index: number
  lead: number
  rows: number
}

function validRow(request: NativePhraseRequest, list: NativePhrasePostings, row: number): boolean {
  return (
    list.documents[row] < request.ordinalCount &&
    list.fields[row] < request.searchable.length &&
    list.positionStarts[row] <= list.positions.length &&
    list.positionCounts[row] <= list.positions.length - list.positionStarts[row]
  )
}

function rowFor(
  request: NativePhraseRequest,
  list: NativePhrasePostings,
  order: Uint32Array,
  document: number,
  field: number,
): number {
  let low = 0
  let high = order.length
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2)
    if (list.documents[order[middle]] < document) low = middle + 1
    else high = middle
  }
  for (let at = low; at < order.length && list.documents[order[at]] === document; at++) {
    const row = order[at]
    if (list.fields[row] === field && validRow(request, list, row)) return row
  }
  return -1
}

function countStarts(
  request: NativePhraseRequest,
  phrase: PreparedPhrase,
  leadRow: number,
  cursors: Uint32Array,
  ends: Uint32Array,
  work: PhraseWork,
): number {
  const list = request.postings[request.tokens[phrase.lead]]
  const start = list.positionStarts[leadRow]
  const end = start + list.positionCounts[leadRow]
  let frequency = 0
  for (let at = start; at < end; at++) {
    const anchor = list.positions[at] - request.offsets[phrase.lead]
    if (anchor < 0) continue
    let found = true
    for (let entry = request.starts[phrase.index]; entry < request.starts[phrase.index + 1]; entry++) {
      const positions = request.postings[request.tokens[entry]].positions
      const wanted = anchor + request.offsets[entry]
      let cursor = cursors[entry]
      while (cursor < ends[entry] && positions[cursor] < wanted) {
        cursor++
        if (work.add(1) !== 0) return frequency
      }
      cursors[entry] = cursor
      if (work.add(1) !== 0 || cursor === ends[entry]) return frequency
      if (positions[cursor] !== wanted) {
        found = false
        break
      }
    }
    if (found) frequency++
  }
  return frequency
}

export function matchPrepared(request: NativePhraseRequest, output: PhraseOutput, work: PhraseWork): number {
  const orders = request.postings.map(list => new Uint32Array(list.documents.length))
  let largest = 0
  for (const order of orders) largest = Math.max(largest, order.length)
  const spare = new Uint32Array(largest)
  const buckets = new Uint32Array(1 << RADIX_BITS)
  const prepared = new Uint8Array(orders.length)
  const cursors = new Uint32Array(request.tokens.length)
  const ends = new Uint32Array(request.tokens.length)
  const rowStarts = new Uint32Array(request.starts.length - 1)
  const rowCounts = new Uint32Array(rowStarts.length)
  const matched = new Uint32Array(bitmapWords(request.ordinalCount))
  const next = new Uint32Array(matched.length)
  const phrases: PreparedPhrase[] = []
  let missing = false
  for (let phrase = 0; phrase + 1 < request.starts.length && !missing; phrase++) {
    let lead = request.starts[phrase]
    for (let entry = request.starts[phrase]; entry < request.starts[phrase + 1]; entry++) {
      const token = request.tokens[entry]
      const list = request.postings[token]
      const count = list.documents.length
      if (count === 0) {
        missing = true
        break
      }
      if (prepared[token] === 0) {
        prepared[token] = 1
        const order = orders[token]
        for (let at = 0; at < count; at++) order[at] = at
        if (!list.ordered) {
          if (sortPhraseRows(list.documents, order, spare, buckets, work) !== 0) return work.status
        }
      }
      if (count < request.postings[request.tokens[lead]].documents.length) lead = entry
    }
    phrases.push({ index: phrase, lead, rows: request.postings[request.tokens[lead]].documents.length })
  }
  let total = 0
  if (!missing) {
    for (const phrase of phrases) {
      rowStarts[phrase.index] = total
      if (request.collect) total += phrase.rows
    }
    phrases.sort((first, second) => first.rows - second.rows)
    let allowed = request.filter
    for (const phrase of phrases) {
      next.fill(0)
      const leadToken = request.tokens[phrase.lead]
      const lead = request.postings[leadToken]
      let found = false
      for (const row of orders[leadToken]) {
        if (work.add(1) !== 0) return work.status
        if (!validRow(request, lead, row)) continue
        const document = lead.documents[row]
        const field = lead.fields[row]
        if (
          request.searchable[field] === 0 ||
          bitsetHas(request.removed, document) ||
          (allowed !== null && !bitsetHas(allowed, document))
        )
          continue
        let holdsEveryToken = true
        for (let entry = request.starts[phrase.index]; entry < request.starts[phrase.index + 1]; entry++) {
          const token = request.tokens[entry]
          const list = request.postings[token]
          const positionRow = token === leadToken ? row : rowFor(request, list, orders[token], document, field)
          if (positionRow < 0) {
            holdsEveryToken = false
            break
          }
          cursors[entry] = list.positionStarts[positionRow]
          ends[entry] = cursors[entry] + list.positionCounts[positionRow]
        }
        if (!holdsEveryToken) continue
        const frequency = countStarts(request, phrase, row, cursors, ends, work)
        if (work.status !== 0) return work.status
        if (frequency === 0) continue
        bitsetSet(next, document)
        found = true
        if (request.collect) {
          const into = rowStarts[phrase.index] + rowCounts[phrase.index]++
          output.documents[into] = document
          output.fields[into] = field
          output.frequencies[into] = frequency
        }
      }
      matched.set(next)
      allowed = matched
      if (!found) break
    }
    if (phrases.length === 0 && request.filter !== null) matched.set(request.filter)
  }
  if (work.flush() !== 0) return work.status
  total = 0
  for (let phrase = 0; phrase < rowStarts.length; phrase++) {
    output.starts[phrase] = total
    const from = rowStarts[phrase]
    const count = rowCounts[phrase]
    output.documents.copyWithin(total, from, from + count)
    output.fields.copyWithin(total, from, from + count)
    output.frequencies.copyWithin(total, from, from + count)
    total += count
  }
  output.starts[rowStarts.length] = total
  if (request.ordinalCount === 0) matched[0] = 0
  else if (request.ordinalCount % 32 !== 0) matched[matched.length - 1] &= (1 << (request.ordinalCount % 32)) - 1
  output.matched.set(matched)
  return total
}
