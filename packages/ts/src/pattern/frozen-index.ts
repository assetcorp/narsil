import type { PatternIndexArrays, PatternIndexReader } from '../core/pattern-index/types'
import { buildArrays, EMPTY_POSTINGS, findRun } from './runs-arrays'

export function readPatternArrays(arrays: PatternIndexArrays): PatternIndexReader {
  const source = {
    count: arrays.offsets.length - 1,
    codePoints: arrays.runs,
    postingsAt: (run: number) => arrays.postings.subarray(arrays.offsets[run], arrays.offsets[run + 1]),
  }

  return {
    documents: () => arrays.docIds,

    postings(first: number, second: number, third: number): Uint32Array {
      const run = findRun(arrays.runs, first, second, third)
      return run < 0 ? EMPTY_POSTINGS : source.postingsAt(run)
    },

    toArrays(fieldPath: string, remap: Int32Array | null): PatternIndexArrays {
      return buildArrays(fieldPath, arrays.docIds, source, null, remap)
    },

    bytes(): number {
      return arrays.docIds.byteLength + arrays.runs.byteLength + arrays.offsets.byteLength + arrays.postings.byteLength
    },
  }
}
