import { compareScores } from '../ordering/scores'
import { regionsOverlap as overlaps } from '../regions'

function merge(
  offsets: Uint32Array,
  scores: Float64Array | null,
  ranks: Uint32Array,
  limit: number,
  lists: Uint32Array,
  indices: Uint32Array,
): number {
  if (
    offsets.length === 0 ||
    offsets[0] !== 0 ||
    !Number.isInteger(limit) ||
    limit < 0 ||
    limit > 0xffffffff ||
    offsets[offsets.length - 1] !== ranks.length ||
    (scores !== null && scores.length !== ranks.length) ||
    overlaps(lists, indices) ||
    overlaps(lists, offsets) ||
    overlaps(lists, ranks) ||
    overlaps(indices, offsets) ||
    overlaps(indices, ranks) ||
    (scores !== null && (overlaps(lists, scores) || overlaps(indices, scores)))
  ) {
    return -1
  }
  for (let position = 1; position < offsets.length; position++) {
    if (offsets[position] < offsets[position - 1]) return -1
  }
  const needed = Math.min(limit, ranks.length)
  if (needed > lists.length || needed > indices.length) return -3
  if (needed === 0) return 0
  const count = offsets.length - 1
  const heap = new Uint32Array(count)
  const positions = new Uint32Array(count)
  let size = 0
  for (let source = 0; source < count; source++) {
    const start = offsets[source]
    if (start === offsets[source + 1]) continue
    heap[size++] = source
    positions[source] = start
  }
  function before(left: number, right: number): boolean {
    const leftAt = positions[left]
    const rightAt = positions[right]
    const order = scores === null ? 0 : compareScores(scores[leftAt], scores[rightAt])
    return (order || ranks[leftAt] - ranks[rightAt] || left - right) < 0
  }
  function siftDown(parent: number): void {
    const source = heap[parent]
    while (parent < Math.floor(size / 2)) {
      let child = parent * 2 + 1
      if (child + 1 < size && before(heap[child + 1], heap[child])) child++
      if (!before(heap[child], source)) break
      heap[parent] = heap[child]
      parent = child
    }
    heap[parent] = source
  }
  for (let parent = Math.floor(size / 2); parent > 0; parent--) siftDown(parent - 1)
  for (let position = 0; position < needed; position++) {
    const source = heap[0]
    const current = positions[source]
    lists[position] = source
    indices[position] = current - offsets[source]
    positions[source] = current + 1
    if (current + 1 === offsets[source + 1]) heap[0] = heap[--size]
    if (size > 0) siftDown(0)
  }
  return needed
}

export function mergeRankings(
  offsets: Uint32Array,
  scores: Float64Array,
  ranks: Uint32Array,
  limit: number,
  lists: Uint32Array,
  indices: Uint32Array,
): number {
  return merge(offsets, scores, ranks, limit, lists, indices)
}

export function mergeSorted(
  offsets: Uint32Array,
  ranks: Uint32Array,
  limit: number,
  lists: Uint32Array,
  indices: Uint32Array,
): number {
  return merge(offsets, null, ranks, limit, lists, indices)
}
