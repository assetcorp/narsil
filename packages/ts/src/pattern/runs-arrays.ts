import { GrowableUint32 } from '../core/partition/growable-uint32'
import { PATTERN_RUN_CODE_POINTS } from '../core/pattern-index/constants'
import type { PatternIndexArrays } from '../core/pattern-index/types'
import { compareRuns } from './text'

export const EMPTY_POSTINGS = new Uint32Array(0)

export interface RunSource {
  readonly count: number
  readonly codePoints: Uint32Array
  postingsAt(run: number): Uint32Array
}

export function remapAscending(source: Uint32Array, remap: Int32Array | null, out: GrowableUint32): void {
  const start = out.length
  let ordered = true
  for (const ordinal of source) {
    const mapped = remap === null ? ordinal : ordinal < remap.length ? remap[ordinal] : -1
    if (mapped < 0) continue
    if (out.length > start && out.values[out.length - 1] > mapped) ordered = false
    out.push(mapped)
  }
  if (!ordered) out.values.subarray(start, out.length).sort()
}

export function sortedRunOrder(codePoints: Uint32Array, count: number): number[] {
  const order: number[] = new Array(count)
  for (let run = 0; run < count; run++) order[run] = run
  order.sort((left, right) =>
    compareRuns(codePoints, left * PATTERN_RUN_CODE_POINTS, codePoints, right * PATTERN_RUN_CODE_POINTS),
  )
  return order
}

export function buildArrays(
  fieldPath: string,
  documents: Uint32Array,
  source: RunSource,
  order: readonly number[] | null,
  remap: Int32Array | null,
): PatternIndexArrays {
  const docIds = new GrowableUint32(Math.max(1, documents.length))
  remapAscending(documents, remap, docIds)

  const runs = new GrowableUint32(Math.max(1, source.count * PATTERN_RUN_CODE_POINTS))
  const offsets = new GrowableUint32(source.count + 1)
  const postings = new GrowableUint32(Math.max(1, source.count))
  offsets.push(0)
  for (let position = 0; position < source.count; position++) {
    const run = order === null ? position : order[position]
    const before = postings.length
    remapAscending(source.postingsAt(run), remap, postings)
    if (postings.length === before) continue
    const at = run * PATTERN_RUN_CODE_POINTS
    runs.push(source.codePoints[at])
    runs.push(source.codePoints[at + 1])
    runs.push(source.codePoints[at + 2])
    offsets.push(postings.length)
  }

  return trimmedArrays(fieldPath, docIds, runs, offsets, postings)
}

export function trimmedArrays(
  fieldPath: string,
  docIds: GrowableUint32,
  runs: GrowableUint32,
  offsets: GrowableUint32,
  postings: GrowableUint32,
): PatternIndexArrays {
  return {
    fieldPath,
    docIds: docIds.values.slice(0, docIds.length),
    runs: runs.values.slice(0, runs.length),
    offsets: offsets.values.slice(0, offsets.length),
    postings: postings.values.slice(0, postings.length),
  }
}

export function findRun(runs: Uint32Array, first: number, second: number, third: number): number {
  let low = 0
  let high = runs.length / PATTERN_RUN_CODE_POINTS
  while (low < high) {
    const middle = (low + high) >>> 1
    const at = middle * PATTERN_RUN_CODE_POINTS
    const difference = runs[at] - first || runs[at + 1] - second || runs[at + 2] - third
    if (difference === 0) return middle
    if (difference < 0) low = middle + 1
    else high = middle
  }
  return -1
}
