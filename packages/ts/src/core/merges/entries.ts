import { mergeRankings, mergeSorted } from '#platform/result-merges'
import { ErrorCodes, NarsilError } from '../../errors'

interface RankedEntry {
  score?: number | null
}

export function mergeEntries<Entry extends RankedEntry>(
  arrays: readonly (readonly Entry[])[],
  limit: number,
  compareRanks: (left: Entry, right: Entry) => number,
  scored: boolean,
): Entry[] {
  let count = 0
  for (const entries of arrays) count += entries.length
  if (count > 0xffffffff || arrays.length > 0xffffffff || !Number.isInteger(limit) || limit < 0 || limit > 0xffffffff) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'The search rankings or limit exceed the merge layout')
  }
  const offsets = new Uint32Array(arrays.length + 1)
  const entries = new Array<Entry>(count)
  const scores = scored ? new Float64Array(count) : null
  let position = 0
  for (let source = 0; source < arrays.length; source++) {
    offsets[source] = position
    for (const entry of arrays[source]) {
      entries[position] = entry
      if (scores !== null) scores[position] = entry.score ?? Number.NEGATIVE_INFINITY
      position++
    }
  }
  offsets[arrays.length] = count
  const ordered = new Uint32Array(count)
  for (let index = 0; index < count; index++) ordered[index] = index
  ordered.sort((left, right) => compareRanks(entries[left], entries[right]))
  const ranks = new Uint32Array(count)
  let rank = 0
  for (let index = 0; index < count; index++) {
    if (index > 0 && compareRanks(entries[ordered[index - 1]], entries[ordered[index]]) !== 0) rank++
    ranks[ordered[index]] = rank
  }
  const needed = Math.min(count, limit)
  const lists = new Uint32Array(needed)
  const indices = new Uint32Array(needed)
  const found =
    scores === null
      ? mergeSorted(offsets, ranks, needed, lists, indices)
      : mergeRankings(offsets, scores, ranks, needed, lists, indices)
  if (found < 0) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'The search rankings cannot be merged', { status: found })
  }
  const merged = new Array<Entry>(found)
  for (let index = 0; index < found; index++) merged[index] = entries[offsets[lists[index]] + indices[index]]
  return merged
}
