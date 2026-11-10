import {
  freezeEncodedSegmentShared,
  mergeSegmentContents,
  SegmentRefusal,
  selectionKeeps,
} from '#platform/worker-copies-host'
import type { PartialWordAnalysis } from '../partial-words/spellings'
import type { FrozenSegment } from './index'
import type { SegmentSelection } from './merge'
import type { SharedSegmentSnapshot } from './shared-snapshot'
import type { TextAnalysis } from './surface-slot'

export function splitMergeSelections(
  selections: readonly SegmentSelection[],
): [SegmentSelection[], SegmentSelection[]] {
  let count = 0
  for (const selection of selections) {
    for (let ordinal = 0; ordinal < selection.segment.arrays.documentCount; ordinal++) {
      if (selectionKeeps(selection, ordinal)) count++
    }
  }
  if (count < 2) throw new SegmentRefusal(8)
  const middle = Math.ceil(count / 2)
  const halves: [SegmentSelection[], SegmentSelection[]] = [[], []]
  let at = 0
  for (const selection of selections) {
    const marks = new Uint8Array(selection.segment.arrays.documentCount)
    let first = false
    let second = false
    for (let ordinal = 0; ordinal < marks.length; ordinal++) {
      if (!selectionKeeps(selection, ordinal)) continue
      if (at++ < middle) {
        marks[ordinal] = 1
        first = true
      } else {
        marks[ordinal] = 2
        second = true
      }
    }
    if (first) halves[0].push({ segment: selection.segment, keep: ordinal => marks[ordinal] === 1 })
    if (second) halves[1].push({ segment: selection.segment, keep: ordinal => marks[ordinal] === 2 })
  }
  return halves
}

export function mergeFrozenSegmentOutputs(
  segments: readonly FrozenSegment[],
  analysis: PartialWordAnalysis | null,
  textAnalysis: TextAnalysis | null,
): SharedSegmentSnapshot[] | null {
  if (typeof SharedArrayBuffer !== 'function') return null
  const outputs: SharedSegmentSnapshot[] = []
  const pending: SegmentSelection[][] = [segments.map(segment => ({ segment }))]
  while (pending.length > 0) {
    const selections = pending.pop()
    if (selections === undefined) break
    try {
      const merged = mergeSegmentContents(selections, analysis, textAnalysis)
      const snapshot = freezeEncodedSegmentShared(
        merged.payload,
        merged.documents,
        undefined,
        analysis,
        merged.reusedPartialWords,
      )
      if (snapshot === null) return null
      outputs.push(snapshot)
    } catch (error) {
      if (!(error instanceof SegmentRefusal) || error.status !== 8) throw error
      const [first, second] = splitMergeSelections(selections)
      pending.push(second, first)
    }
  }
  return outputs
}
