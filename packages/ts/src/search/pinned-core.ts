import { regionsOverlap } from '../core/regions'

const MAX_ENTRIES = 0x7fffffff
const EMPTY_SLOT = -0x80000000

function uint32(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 0xffffffff
}

function selectFree(tree: Uint32Array, rank: number): number {
  let step = 2 ** Math.floor(Math.log2(tree.length))
  let prefix = 0
  while (step !== 0) {
    const next = prefix + step
    if (next <= tree.length && tree[next - 1] <= rank) {
      rank -= tree[next - 1]
      prefix = next
    }
    step = Math.floor(step / 2)
  }
  return prefix
}

export function placePinned(
  count: number,
  ranked: Int32Array,
  positions: Uint32Array,
  depth: number | null,
  output: Int32Array,
): number {
  if (
    !uint32(count) ||
    count > MAX_ENTRIES ||
    ranked.length > MAX_ENTRIES ||
    ranked.length !== positions.length ||
    (depth !== null && !uint32(depth)) ||
    regionsOverlap(output, ranked) ||
    regionsOverlap(output, positions)
  ) {
    return -1
  }
  let removedCount = 0
  let placedCount = 0
  for (let pin = 0; pin < ranked.length; pin++) {
    if (ranked[pin] < -1 || ranked[pin] >= count) return -1
    if (ranked[pin] >= 0) removedCount++
    if (depth === null || positions[pin] < depth) placedCount++
  }
  if (removedCount > count) return -1
  const needed = count - removedCount + placedCount
  if (needed > output.length) return -3
  const removed = new Uint32Array(removedCount)
  const ordered = new Uint32Array(placedCount)
  let removedAt = 0
  let placedAt = 0
  for (let pin = 0; pin < ranked.length; pin++) {
    if (ranked[pin] >= 0) removed[removedAt++] = ranked[pin]
    if (depth === null || positions[pin] < depth) ordered[placedAt++] = pin
  }
  removed.sort()
  for (let at = 1; at < removed.length; at++) if (removed[at] === removed[at - 1]) return -1
  ordered.sort((left, right) => positions[left] - positions[right] || left - right)
  const tree = new Uint32Array(needed)
  for (let at = 0; at < needed; at++) {
    const oneBased = at + 1
    tree[at] = oneBased & -oneBased
  }
  output.fill(EMPTY_SLOT, 0, needed)
  const organic = count - removedCount
  for (let remaining = ordered.length; remaining > 0; remaining--) {
    const pin = ordered[remaining - 1]
    const rank = Math.min(positions[pin], organic + remaining - 1)
    const slot = selectFree(tree, rank)
    output[slot] = -1 - pin
    for (let at = slot; at < needed; at = (at | (at + 1)) >>> 0) tree[at]--
  }
  let next = 0
  let dropped = 0
  for (let at = 0; at < needed; at++) {
    if (output[at] !== EMPTY_SLOT) continue
    while (dropped < removed.length && removed[dropped] === next) {
      dropped++
      next++
    }
    output[at] = next++
  }
  return needed
}
