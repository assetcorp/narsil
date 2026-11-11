import { regionsOverlap } from '../../engine/optional-reads-host-bindings'

export function mergeFacets(
  offsets: Uint32Array,
  values: Uint32Array,
  counts: Uint32Array,
  bounds: Uint32Array,
  valueRanks: Uint32Array,
  ascending: boolean,
  limit: number | null,
  outValues: Uint32Array,
  outCounts: Uint32Array,
  outBound: Uint32Array,
): number {
  if (
    offsets.length === 0 ||
    offsets[0] !== 0 ||
    offsets[offsets.length - 1] !== values.length ||
    values.length !== counts.length ||
    bounds.length !== offsets.length - 1 ||
    typeof ascending !== 'boolean' ||
    (limit !== null && (!Number.isInteger(limit) || limit < 0 || limit > 0xffffffff))
  ) {
    return -1
  }
  const inputs = [offsets, values, counts, bounds, valueRanks]
  const outputs = [outValues, outCounts, outBound]
  for (let target = 0; target < outputs.length; target++) {
    if (inputs.some(input => regionsOverlap(outputs[target], input))) return -1
    for (let prior = 0; prior < target; prior++) {
      if (regionsOverlap(outputs[target], outputs[prior])) return -1
    }
  }
  for (let at = 1; at < offsets.length; at++) if (offsets[at] < offsets[at - 1]) return -1
  for (const key of values) if (key >= valueRanks.length) return -1
  if (outBound.length === 0) return -3
  let bound = 0
  for (const missing of bounds) {
    bound += missing
    if (bound > 0xffffffff) return -1
  }
  const totals = new Float64Array(valueRanks.length).fill(-1)
  const keys = new Uint32Array(valueRanks.length)
  let distinct = 0
  for (let at = 0; at < values.length; at++) {
    const key = values[at]
    if (totals[key] < 0) {
      keys[distinct++] = key
      totals[key] = 0
    }
    totals[key] += counts[at]
    if (totals[key] > 0xffffffff) return -1
  }
  const kept = Math.min(limit ?? distinct, distinct)
  if (kept > outValues.length || kept > outCounts.length) return -3
  const ordered = keys.subarray(0, distinct)
  ordered.sort(
    (left, right) =>
      (ascending ? totals[left] - totals[right] : totals[right] - totals[left]) || valueRanks[left] - valueRanks[right],
  )
  let largest = 0
  for (let at = kept; at < distinct; at++) largest = Math.max(largest, totals[ordered[at]])
  if (bound + largest > 0xffffffff) return -1
  for (let at = 0; at < kept; at++) {
    outValues[at] = ordered[at]
    outCounts[at] = totals[ordered[at]]
  }
  outBound[0] = bound + largest
  return kept
}
