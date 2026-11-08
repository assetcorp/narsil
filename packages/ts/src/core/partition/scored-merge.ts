import type { ScoredDocument } from '../../types/internal'
import { mergeEntries } from '../merges/entries'
import { compareCodePoints } from '../ordering'

export function kWayMerge(arrays: ScoredDocument[][]): ScoredDocument[] {
  let only: ScoredDocument[] | undefined
  for (const entries of arrays) {
    if (entries.length === 0) continue
    if (only !== undefined)
      return mergeEntries(arrays, 0xffffffff, (left, right) => compareCodePoints(left.docId, right.docId), true)
    only = entries
  }
  return only ?? []
}
