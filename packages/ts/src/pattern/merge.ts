import { GrowableUint32 } from '../core/partition/growable-uint32'
import { PATTERN_RUN_CODE_POINTS } from '../core/pattern-index/constants'
import type { PatternIndexArrays, PatternMergeInput } from '../core/pattern-index/types'
import { remapAscending, trimmedArrays } from './runs-arrays'
import { compareRuns } from './text'

function sortTailIfUnordered(values: GrowableUint32, start: number): void {
  for (let at = start + 1; at < values.length; at++) {
    if (values.values[at - 1] > values.values[at]) {
      values.values.subarray(start, values.length).sort()
      return
    }
  }
}

function smallestRun(inputs: readonly PatternMergeInput[], cursors: readonly number[]): number {
  let smallest = -1
  for (let input = 0; input < inputs.length; input++) {
    const runCount = inputs[input].arrays.offsets.length - 1
    if (cursors[input] >= runCount) continue
    if (smallest < 0) {
      smallest = input
      continue
    }
    const order = compareRuns(
      inputs[input].arrays.runs,
      cursors[input] * PATTERN_RUN_CODE_POINTS,
      inputs[smallest].arrays.runs,
      cursors[smallest] * PATTERN_RUN_CODE_POINTS,
    )
    if (order < 0) smallest = input
  }
  return smallest
}

export function mergePatternArrays(fieldPath: string, inputs: readonly PatternMergeInput[]): PatternIndexArrays {
  const docIds = new GrowableUint32(1)
  for (const input of inputs) remapAscending(input.arrays.docIds, input.remap, docIds)
  sortTailIfUnordered(docIds, 0)

  const runs = new GrowableUint32(PATTERN_RUN_CODE_POINTS)
  const offsets = new GrowableUint32(1)
  const postings = new GrowableUint32(1)
  offsets.push(0)
  const cursors = inputs.map(() => 0)

  for (let smallest = smallestRun(inputs, cursors); smallest >= 0; smallest = smallestRun(inputs, cursors)) {
    const source = inputs[smallest].arrays.runs
    const at = cursors[smallest] * PATTERN_RUN_CODE_POINTS
    const first = source[at]
    const second = source[at + 1]
    const third = source[at + 2]
    const before = postings.length
    for (let input = 0; input < inputs.length; input++) {
      const { arrays, remap } = inputs[input]
      const run = cursors[input]
      if (run >= arrays.offsets.length - 1) continue
      const runAt = run * PATTERN_RUN_CODE_POINTS
      if (arrays.runs[runAt] !== first || arrays.runs[runAt + 1] !== second || arrays.runs[runAt + 2] !== third) {
        continue
      }
      remapAscending(arrays.postings.subarray(arrays.offsets[run], arrays.offsets[run + 1]), remap, postings)
      cursors[input] = run + 1
    }
    if (postings.length === before) continue
    sortTailIfUnordered(postings, before)
    runs.push(first)
    runs.push(second)
    runs.push(third)
    offsets.push(postings.length)
  }

  return trimmedArrays(fieldPath, docIds, runs, offsets, postings)
}
