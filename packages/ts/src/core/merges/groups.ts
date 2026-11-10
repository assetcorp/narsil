import { compareScores } from '../ordering/scores'
import { regionsOverlap } from '../regions'

interface MergedGroup {
  key: number
  sources: number[]
  retained: number
  head: number
  score: number
  idRank: number
}

function unsigned(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 0xffffffff
}

export function mergeGroups(
  keys: Uint32Array,
  offsets: Uint32Array,
  scores: Float64Array | null,
  scorePresent: Uint32Array | null,
  ranks: Uint32Array,
  idRanks: Uint32Array,
  sorted: boolean,
  maxPerGroup: number,
  limit: number | null,
  outKeys: Uint32Array,
  outOffsets: Uint32Array,
  outSources: Uint32Array,
  outIndices: Uint32Array,
): number {
  const count = ranks.length
  if (
    !unsigned(keys.length) ||
    !unsigned(count) ||
    offsets.length !== keys.length + 1 ||
    offsets[0] !== 0 ||
    offsets[keys.length] !== count ||
    idRanks.length !== count ||
    typeof sorted !== 'boolean' ||
    !unsigned(maxPerGroup) ||
    (limit !== null && !unsigned(limit)) ||
    (scores === null ? scorePresent !== null : scores.length !== count) ||
    (scorePresent !== null && scorePresent.length < Math.max(1, Math.ceil(count / 32)))
  )
    return -1
  const inputs = [keys, offsets, scores, scorePresent, ranks, idRanks]
  const outputs = [outKeys, outOffsets, outSources, outIndices]
  for (let target = 0; target < outputs.length; target++) {
    if (inputs.some(input => input !== null && regionsOverlap(outputs[target], input))) return -1
    for (let prior = 0; prior < target; prior++) if (regionsOverlap(outputs[target], outputs[prior])) return -1
  }
  for (let at = 1; at < offsets.length; at++) if (offsets[at] < offsets[at - 1]) return -1
  if (!sorted) for (let at = 0; at < count; at++) if (ranks[at] !== idRanks[at]) return -1
  if (outOffsets.length === 0) return -3
  if (keys.length === 0 || limit === 0) {
    outOffsets[0] = 0
    return 0
  }
  const scoreOf = (entry: number, absent: number): number =>
    scores === null || (scorePresent !== null && (scorePresent[entry >>> 5] & (1 << (entry & 31))) === 0)
      ? absent
      : scores[entry]
  const before = (left: number, leftSource: number, right: number, rightSource: number): boolean => {
    const score = sorted
      ? 0
      : compareScores(scoreOf(left, Number.NEGATIVE_INFINITY), scoreOf(right, Number.NEGATIVE_INFINITY))
    return (score || ranks[left] - ranks[right] || leftSource - rightSource) < 0
  }
  const byKey = new Map<number, MergedGroup>()
  for (let source = 0; source < keys.length; source++) {
    let group = byKey.get(keys[source])
    if (group === undefined) {
      group = { key: keys[source], sources: [], retained: 0, head: -1, score: 0, idRank: 0 }
      byKey.set(group.key, group)
    }
    group.sources.push(source)
    const start = offsets[source]
    const entries = offsets[source + 1] - start
    group.retained = Math.min(maxPerGroup, group.retained + entries)
    if (
      maxPerGroup > 0 &&
      entries > 0 &&
      (group.head === -1 || before(start, source, offsets[group.head], group.head))
    ) {
      group.head = source
      group.score = scoreOf(start, 0)
      group.idRank = idRanks[start]
    }
  }
  const groups = [...byKey.values()]
  groups.sort(
    (left, right) =>
      compareScores(left.score, right.score) ||
      Number(left.retained > 0) - Number(right.retained > 0) ||
      left.idRank - right.idRank ||
      left.sources[0] - right.sources[0],
  )
  const kept = Math.min(limit ?? groups.length, groups.length)
  if (outKeys.length < kept || outOffsets.length < kept + 1) return -3
  let needed = 0
  for (let at = 0; at < kept; at++) needed += groups[at].retained
  if (outSources.length < needed || outIndices.length < needed) return -3
  const positions = new Uint32Array(keys.length)
  const heap = new Uint32Array(keys.length)
  const sift = (parent: number, size: number): void => {
    const source = heap[parent]
    while (parent < Math.floor(size / 2)) {
      let child = parent * 2 + 1
      if (child + 1 < size && before(positions[heap[child + 1]], heap[child + 1], positions[heap[child]], heap[child]))
        child++
      if (!before(positions[heap[child]], heap[child], positions[source], source)) break
      heap[parent] = heap[child]
      parent = child
    }
    heap[parent] = source
  }
  let written = 0
  outOffsets[0] = 0
  for (let at = 0; at < kept; at++) {
    const group = groups[at]
    let size = 0
    for (const source of group.sources) {
      if (offsets[source] === offsets[source + 1]) continue
      heap[size++] = source
      positions[source] = offsets[source]
    }
    for (let parent = Math.floor(size / 2); parent > 0; parent--) sift(parent - 1, size)
    for (let entry = 0; entry < group.retained; entry++) {
      const source = heap[0]
      const position = positions[source]++
      outSources[written] = source
      outIndices[written++] = position - offsets[source]
      if (position + 1 === offsets[source + 1]) heap[0] = heap[--size]
      if (size > 0) sift(0, size)
    }
    outKeys[at] = group.key
    outOffsets[at + 1] = written
  }
  return kept
}
