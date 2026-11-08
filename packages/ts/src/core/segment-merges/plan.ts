import type { NativeFrozenStrings } from '../../vector/native/types/frozen-segments'
import type { NativeKeywordMergeInput } from '../../vector/native/types/segment-merge'
import { compareCodePoints } from '../ordering'
import { rowRemoved } from '../segment-writes/postings'
import { requireSegment } from '../segment-writes/status'
import { sourcePosting, sourceTerm, sourceTermCount } from './source'
import { mergeStrings } from './strings'
import { mergeText } from './text'

export interface MergePosting {
  input: NativeKeywordMergeInput
  row: number
  target: number
  source: number
  positionStart: number
  positionCount: number
  positions: Uint32Array | null
  frequency: number
  field: number
}

export interface MergeTerm {
  text: string
  bytes: Uint8Array
  postings: MergePosting[]
  documents: number
}

const encoder = new TextEncoder()

function checkMappings(inputs: readonly NativeKeywordMergeInput[], documentCount: number, fieldCount: number): void {
  const mapped = new Uint32Array(Math.max(1, Math.ceil(documentCount / 32)))
  let count = 0
  for (const input of inputs) {
    const fields = new Set<number>()
    for (const field of input.fieldMapping) {
      requireSegment(field < fieldCount && !fields.has(field))
      fields.add(field)
    }
    for (let ordinal = 0; ordinal < input.mapping.length; ordinal++) {
      const target = input.mapping[ordinal]
      if (target === 0xffffffff) continue
      requireSegment(input.growing == null || !rowRemoved(input.growing, ordinal))
      requireSegment(target < documentCount)
      const mask = 1 << (target & 31)
      requireSegment((mapped[target >>> 5] & mask) === 0)
      mapped[target >>> 5] |= mask
      count++
    }
  }
  requireSegment(count === documentCount)
}

function compareRows(left: MergePosting, right: MergePosting): number {
  return left.target - right.target || left.source - right.source || left.row - right.row
}

function collectTerms(inputs: readonly NativeKeywordMergeInput[]): MergeTerm[] {
  const terms = new Map<string, MergePosting[]>()
  for (let source = 0; source < inputs.length; source++) {
    const input = inputs[source]
    for (let ordinal = 0; ordinal < sourceTermCount(input); ordinal++) {
      const term = sourceTerm(input, ordinal)
      if (term === null) continue
      const { text, start, end } = term
      let rows = terms.get(text)
      if (rows === undefined) {
        rows = []
        terms.set(text, rows)
      }
      for (let row = start; row < end; row++) {
        const posting = sourcePosting(input, source, ordinal, row)
        if (posting !== null) rows.push(posting)
      }
    }
  }
  const result: MergeTerm[] = []
  for (const [text, postings] of terms) {
    if (postings.length === 0) continue
    postings.sort(compareRows)
    let previous = -1
    let documents = 0
    for (const row of postings) {
      if (row.target !== previous) documents++
      previous = row.target
    }
    result.push({ text, bytes: encoder.encode(text), postings, documents })
  }
  result.sort((left, right) => compareCodePoints(left.text, right.text))
  return result
}

function retainedRows(
  inputs: readonly NativeKeywordMergeInput[],
  retained: NativeFrozenStrings,
  documentCount: number,
): MergeTerm[] {
  requireSegment(retained.offsets[0] === 0 && retained.offsets[retained.counts.length] === retained.text.length)
  for (const input of inputs) {
    requireSegment(
      input.growing == null &&
        input.postingDocuments.length === 0 &&
        (input.positionValues?.length ?? 0) === 0 &&
        input.terms.counts.length === 0,
    )
  }
  const terms: MergeTerm[] = []
  for (let at = 0; at < retained.counts.length; at++) {
    const text = mergeText(retained, at)
    requireSegment(text !== null && retained.counts[at] > 0 && retained.counts[at] <= documentCount)
    requireSegment(at === 0 || compareCodePoints(terms[at - 1].text, text) < 0)
    terms.push({
      text,
      bytes: retained.text.subarray(retained.offsets[at], retained.offsets[at + 1]),
      documents: retained.counts[at],
      postings: [],
    })
  }
  return terms
}

export function prepareMerge(
  inputs: readonly NativeKeywordMergeInput[],
  documentCount: number,
  fieldCount: number,
  retained: NativeFrozenStrings | null = null,
) {
  checkMappings(inputs, documentCount, fieldCount)
  const terms = retained === null ? collectTerms(inputs) : retainedRows(inputs, retained, documentCount)
  let termBytes = 0
  let postingCount = 0
  let positionCount = 0
  for (const term of terms) {
    termBytes += term.bytes.length
    postingCount += term.postings.length
    for (const row of term.postings) positionCount += row.positionCount
  }
  requireSegment(
    terms.length <= 0xffffffff && termBytes <= 0xffffffff && postingCount <= 0xffffffff && positionCount <= 0xffffffff,
  )
  const keptTerms = new Set(terms.map(term => term.text))
  const surfaces = mergeStrings(inputs, keptTerms, false)
  const spellings = mergeStrings(inputs, keptTerms, true)
  const hasPositions =
    retained === null &&
    inputs.some(input => (input.growing == null ? input.positionOffsets !== null : input.growing.positions !== null))
  const sizes = new Uint32Array([
    terms.length,
    termBytes,
    postingCount,
    positionCount,
    Number(hasPositions),
    surfaces.entries.length,
    surfaces.bytes,
    spellings.entries.length,
    spellings.bytes,
  ])
  return { terms, surfaces: surfaces.entries, spellings: spellings.entries, sizes, hasPositions }
}

export type KeywordMergePlan = ReturnType<typeof prepareMerge>
