import { compareCodePoints } from '../ordering/code-points'

export const fieldRun = { entries: new Uint32Array(8), length: 0 }

const ranksByFieldNames = new WeakMap<readonly string[], Uint32Array>()

export function fieldNameRanks(fieldNames: readonly string[]): Uint32Array {
  const held = ranksByFieldNames.get(fieldNames)
  if (held !== undefined && held.length === fieldNames.length) return held
  const order = Array.from(fieldNames.keys()).sort((left, right) =>
    compareCodePoints(fieldNames[left], fieldNames[right]),
  )
  const ranks = new Uint32Array(order.length)
  for (let rank = 0; rank < order.length; rank++) ranks[order[rank]] = rank
  ranksByFieldNames.set(fieldNames, ranks)
  return ranks
}

export function orderRunByFieldName(
  docIds: ArrayLike<number>,
  fieldIndices: ArrayLike<number>,
  ranks: Uint32Array,
  start: number,
  count: number,
): Uint32Array {
  let entries = fieldRun.entries
  let end = start
  for (; end < count && docIds[end] === docIds[start]; end++) {
    let slot = end - start
    if (slot === entries.length) {
      const grown = new Uint32Array(slot * 2)
      grown.set(entries)
      entries = fieldRun.entries = grown
    }
    const rank = ranks[fieldIndices[end]]
    while (slot > 0 && ranks[fieldIndices[entries[slot - 1]]] > rank) {
      entries[slot] = entries[slot - 1]
      slot--
    }
    entries[slot] = end
  }
  fieldRun.length = end - start
  return entries
}
