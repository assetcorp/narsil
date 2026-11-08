import type { NativeFrozenStrings } from '../../vector/native/types/frozen-segments'
import type { NativeKeywordMergeInput } from '../../vector/native/types/segment-merge'
import { rowRemoved } from '../segment-writes/postings'
import { requireSegment } from '../segment-writes/status'
import { createMergeRows, type MergeRows, type MergeTermSource, mergeRows, mergeTermSources } from './rows'
import { mergeStrings } from './strings'
import { compareMergeBytes, decodeMergeText, mergeText } from './text'

export interface MergeTerm {
  text: string | null
  bytes: Uint8Array
  rowStart: number
  rowEnd: number
  documents: number
}

function termText(term: MergeTerm): string {
  return term.text ?? decodeMergeText(term.bytes)
}

function keptTermsOf(inputs: readonly NativeKeywordMergeInput[], terms: readonly MergeTerm[]): ReadonlySet<string> {
  if (inputs.every(input => input.spellings === null)) return new Set()
  return new Set(terms.map(termText))
}

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

function collectTerms(sources: readonly MergeTermSource[], rows: MergeRows): MergeTerm[] {
  const terms: MergeTerm[] = []
  for (let start = 0; start < sources.length; ) {
    const { text, bytes } = sources[start]
    let end = start + 1
    while (end < sources.length && compareMergeBytes(sources[end].bytes, bytes) === 0) end++
    const rowStart = rows.count
    const documents = mergeRows(sources, start, end, rows)
    if (rows.count > rowStart) terms.push({ text, bytes, rowStart, rowEnd: rows.count, documents })
    start = end
  }
  return terms
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
    const bytes = retained.text.subarray(retained.offsets[at], retained.offsets[at + 1])
    requireSegment(at === 0 || compareMergeBytes(terms[at - 1].bytes, bytes) < 0)
    terms.push({
      text,
      bytes,
      documents: retained.counts[at],
      rowStart: 0,
      rowEnd: 0,
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
  const sources = retained === null ? mergeTermSources(inputs) : []
  const rows = createMergeRows(inputs, sources)
  const terms = retained === null ? collectTerms(sources, rows) : retainedRows(inputs, retained, documentCount)
  let termBytes = 0
  let positionCount = 0
  for (const term of terms) termBytes += term.bytes.length
  for (let row = 0; row < rows.count; row++) positionCount += rows.positionCounts[row]
  requireSegment(
    terms.length <= 0xffffffff && termBytes <= 0xffffffff && rows.count <= 0xffffffff && positionCount <= 0xffffffff,
  )
  const keptTerms = keptTermsOf(inputs, terms)
  const surfaces = mergeStrings(inputs, keptTerms, false)
  const spellings = mergeStrings(inputs, keptTerms, true)
  const hasPositions =
    retained === null &&
    inputs.some(input => (input.growing == null ? input.positionOffsets !== null : input.growing.positions !== null))
  const sizes = new Uint32Array([
    terms.length,
    termBytes,
    rows.count,
    positionCount,
    Number(hasPositions),
    surfaces.entries.length,
    surfaces.bytes,
    spellings.entries.length,
    spellings.bytes,
  ])
  return { terms, rows, surfaces: surfaces.entries, spellings: spellings.entries, sizes, hasPositions }
}

export type KeywordMergePlan = ReturnType<typeof prepareMerge>
