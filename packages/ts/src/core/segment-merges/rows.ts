import type { NativeKeywordMergeInput } from '../../vector/native/types/segment-merge'
import { createPostingRead, type PostingRead, readPosting, sourceTerm, sourceTermCount } from './source'
import { compareMergeBytes } from './text'

export interface MergeTermSource {
  text: string | null
  bytes: Uint8Array
  input: NativeKeywordMergeInput
  source: number
  ordinal: number
  start: number
  end: number
}

export interface MergeRows {
  count: number
  targets: Uint32Array
  frequencies: Uint16Array
  fields: Uint16Array
  sources: Uint32Array
  rowIds: Uint32Array
  positionStarts: Uint32Array
  positionCounts: Uint32Array
  positionValues: (Uint32Array | null)[]
  read: PostingRead
}

function compareSources(left: MergeTermSource, right: MergeTermSource): number {
  return compareMergeBytes(left.bytes, right.bytes) || left.source - right.source || left.ordinal - right.ordinal
}

export function mergeTermSources(inputs: readonly NativeKeywordMergeInput[]): MergeTermSource[] {
  const sources: MergeTermSource[] = []
  let ordered = true
  for (let source = 0; source < inputs.length; source++) {
    const input = inputs[source]
    const count = sourceTermCount(input)
    for (let ordinal = 0; ordinal < count; ordinal++) {
      const term = sourceTerm(input, ordinal)
      if (term === null) continue
      const entry: MergeTermSource = {
        text: term.text,
        bytes: term.bytes,
        input,
        source,
        ordinal,
        start: term.start,
        end: term.end,
      }
      if (ordered && sources.length > 0 && compareSources(sources[sources.length - 1], entry) > 0) ordered = false
      sources.push(entry)
    }
  }
  if (!ordered) sources.sort(compareSources)
  return sources
}

function positionValuesOf(input: NativeKeywordMergeInput): Uint32Array | null {
  return input.growing == null ? input.positionValues : (input.growing.positions?.values ?? null)
}

export function createMergeRows(
  inputs: readonly NativeKeywordMergeInput[],
  sources: readonly MergeTermSource[],
): MergeRows {
  let capacity = 0
  for (const source of sources) capacity += source.end - source.start
  return {
    count: 0,
    targets: new Uint32Array(capacity),
    frequencies: new Uint16Array(capacity),
    fields: new Uint16Array(capacity),
    sources: new Uint32Array(capacity),
    rowIds: new Uint32Array(capacity),
    positionStarts: new Uint32Array(capacity),
    positionCounts: new Uint32Array(capacity),
    positionValues: inputs.map(positionValuesOf),
    read: createPostingRead(),
  }
}

function compareRowsAt(rows: MergeRows, left: number, right: number): number {
  return (
    rows.targets[left] - rows.targets[right] ||
    rows.sources[left] - rows.sources[right] ||
    rows.rowIds[left] - rows.rowIds[right]
  )
}

function sortRows(rows: MergeRows, from: number, to: number): void {
  const order = new Uint32Array(to - from)
  for (let at = 0; at < order.length; at++) order[at] = from + at
  order.sort((left, right) => compareRowsAt(rows, left, right))
  const { targets, frequencies, fields, sources, rowIds, positionStarts, positionCounts } = rows
  for (const column of [targets, frequencies, fields, sources, rowIds, positionStarts, positionCounts]) {
    const held = column.slice(from, to)
    for (let at = 0; at < order.length; at++) column[from + at] = held[order[at] - from]
  }
}

export function mergeRows(sources: readonly MergeTermSource[], start: number, end: number, rows: MergeRows): number {
  const first = rows.count
  const read = rows.read
  let ordered = true
  for (let at = start; at < end; at++) {
    const { input, ordinal, source } = sources[at]
    for (let row = sources[at].start; row < sources[at].end; row++) {
      if (!readPosting(input, ordinal, row, read)) continue
      const index = rows.count++
      rows.targets[index] = read.target
      rows.frequencies[index] = read.frequency
      rows.fields[index] = input.fieldMapping[read.field]
      rows.sources[index] = source
      rows.rowIds[index] = row
      rows.positionStarts[index] = read.positionStart
      rows.positionCounts[index] = read.positionCount
      if (ordered && index > first && compareRowsAt(rows, index - 1, index) > 0) ordered = false
    }
  }
  if (!ordered) sortRows(rows, first, rows.count)
  let documents = 0
  for (let index = first; index < rows.count; index++) {
    if (index === first || rows.targets[index] !== rows.targets[index - 1]) documents++
  }
  return documents
}
