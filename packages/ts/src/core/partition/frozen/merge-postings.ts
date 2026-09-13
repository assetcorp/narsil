import { compareCodePoints } from '../../ordering'
import type { SegmentPostingColumns } from './columns'
import type { FrozenSegment } from './index'

/**
 * This records where each surviving document of one input segment goes in the
 * merged segment, holding its new ordinal, or -1 where a tombstone drops it.
 *
 * @internal
 */
export interface SegmentRemap {
  segment: FrozenSegment
  remap: Int32Array
  fieldIndexRemap: Uint8Array
}

/**
 * These are the merged segment's posting arrays, which the merge sizes in a
 * counting pass and fills in a second pass over the same token order.
 *
 * @internal
 */
export interface MergedPostings extends SegmentPostingColumns {
  tokens: string[]
  docFrequencies: Record<string, number>
}

interface TokenCursor {
  input: SegmentRemap
  at: number
  token: string
}

interface TokenRange {
  input: SegmentRemap
  start: number
  end: number
}

function advance(cursor: TokenCursor): boolean {
  cursor.at += 1
  if (cursor.at >= cursor.input.segment.arrays.tokenTable.size) return false
  cursor.token = cursor.input.segment.arrays.tokenTable.tokenAt(cursor.at)
  return true
}

function openCursors(inputs: readonly SegmentRemap[]): TokenCursor[] {
  const cursors: TokenCursor[] = []
  for (const input of inputs) {
    const table = input.segment.arrays.tokenTable
    if (table.size === 0) continue
    cursors.push({ input, at: 0, token: table.tokenAt(0) })
  }
  return cursors
}

function walkTokens(inputs: readonly SegmentRemap[], visit: (token: string, ranges: TokenRange[]) => void): void {
  const cursors = openCursors(inputs)
  while (cursors.length > 0) {
    let smallest = cursors[0].token
    for (let i = 1; i < cursors.length; i++) {
      if (compareCodePoints(cursors[i].token, smallest) < 0) smallest = cursors[i].token
    }
    const ranges: TokenRange[] = []
    for (let i = cursors.length - 1; i >= 0; i--) {
      const cursor = cursors[i]
      if (cursor.token !== smallest) continue
      const arrays = cursor.input.segment.arrays
      const slot = arrays.tokenTable.payloadSlot(cursor.at)
      ranges.push({ input: cursor.input, start: arrays.postingOffsets[slot], end: arrays.postingOffsets[slot + 1] })
      if (!advance(cursor)) cursors.splice(i, 1)
    }
    ranges.reverse()
    visit(smallest, ranges)
  }
}

function uniqueSurvivors(range: TokenRange): number {
  const { arrays } = range.input.segment
  const remap = range.input.remap
  let docs = 0
  let previous = -1
  let ordered = true
  for (let p = range.start; p < range.end; p++) {
    const internalId = arrays.postingDocIds[p]
    if (remap[internalId] < 0) continue
    if (internalId < previous) ordered = false
    if (internalId !== previous) docs += 1
    previous = internalId
  }
  if (ordered) return docs
  const seen = new Set<number>()
  for (let p = range.start; p < range.end; p++) {
    const internalId = arrays.postingDocIds[p]
    if (remap[internalId] >= 0) seen.add(internalId)
  }
  return seen.size
}

function countRange(range: TokenRange, counts: { postings: number; positions: number }): void {
  const { arrays } = range.input.segment
  const remap = range.input.remap
  for (let p = range.start; p < range.end; p++) {
    const internalId = arrays.postingDocIds[p]
    if (remap[internalId] < 0) continue
    counts.postings += 1
    if (arrays.positionOffsets !== null) {
      counts.positions += arrays.positionOffsets[p + 1] - arrays.positionOffsets[p]
    }
  }
}

/**
 * Merges the postings of several frozen segments into one set of flat arrays,
 * building no live index. A counting pass sizes the arrays before a second
 * pass fills them, and each input's positions copy across as bytes.
 *
 * @param inputs The segments to merge with their ordinal remaps.
 * @returns The merged postings in code point token order.
 *
 * @internal
 */
export function mergePostings(inputs: readonly SegmentRemap[]): MergedPostings {
  let totalPostings = 0
  let totalPositions = 0
  let tokenCount = 0
  let hasPositions = false
  for (const input of inputs) {
    if (input.segment.arrays.positionOffsets !== null) hasPositions = true
  }
  walkTokens(inputs, (_token, ranges) => {
    const counts = { postings: 0, positions: 0 }
    for (const range of ranges) countRange(range, counts)
    if (counts.postings === 0) return
    tokenCount += 1
    totalPostings += counts.postings
    totalPositions += counts.positions
  })

  const tokens: string[] = []
  const docFrequencies: Record<string, number> = Object.create(null)
  const postingOffsets = new Uint32Array(tokenCount + 1)
  const postingDocIds = new Uint32Array(totalPostings)
  const postingFrequencies = new Uint16Array(totalPostings)
  const postingFieldIndices = new Uint8Array(totalPostings)
  const positionOffsets = hasPositions ? new Uint32Array(totalPostings + 1) : null
  const positionValues = hasPositions ? new Uint32Array(totalPositions) : null
  let postingCursor = 0
  let positionCursor = 0

  walkTokens(inputs, (token, ranges) => {
    const tokenStart = postingCursor
    let docs = 0
    for (const range of ranges) {
      const { arrays } = range.input.segment
      const remap = range.input.remap
      const fieldIndexRemap = range.input.fieldIndexRemap
      docs += uniqueSurvivors(range)
      for (let p = range.start; p < range.end; p++) {
        const internalId = arrays.postingDocIds[p]
        const target = remap[internalId]
        if (target < 0) continue
        postingDocIds[postingCursor] = target
        postingFrequencies[postingCursor] = arrays.postingFrequencies[p]
        postingFieldIndices[postingCursor] = fieldIndexRemap[arrays.postingFieldIndices[p]]
        if (positionOffsets !== null && positionValues !== null) {
          positionOffsets[postingCursor] = positionCursor
          if (arrays.positionOffsets !== null && arrays.positionValues !== null) {
            const from = arrays.positionOffsets[p]
            const to = arrays.positionOffsets[p + 1]
            positionValues.set(arrays.positionValues.subarray(from, to), positionCursor)
            positionCursor += to - from
          }
        }
        postingCursor += 1
      }
    }
    if (postingCursor === tokenStart) return
    tokens.push(token)
    docFrequencies[token] = docs
    postingOffsets[tokens.length] = postingCursor
  })
  if (positionOffsets !== null) positionOffsets[postingCursor] = positionCursor

  return {
    tokens,
    docFrequencies,
    postingOffsets,
    postingDocIds,
    postingFrequencies,
    postingFieldIndices,
    positionOffsets,
    positionValues,
  }
}
