import { mergeFacets } from '#platform/facet-merge'
import { ErrorCodes, NarsilError } from '../../errors'
import { compareCodePoints } from '../ordering/code-points'

export interface FacetBucket {
  value: string
  count: number
}

function requireCount(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'A facet count must fit an unsigned 32-bit integer', { value })
  }
}

export function mergeFacetBuckets(
  lists: readonly (readonly FacetBucket[])[],
  bounds: readonly number[],
  ascending: boolean,
  limit: number | undefined,
): { buckets: FacetBucket[]; errorBound: number; undercount: number } {
  if (bounds.length !== lists.length) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'Each facet list must have one error bound')
  }
  const byValue = new Map<string, number>()
  const labels: string[] = []
  let entries = 0
  for (const list of lists) {
    entries += list.length
    requireCount(entries)
    for (const bucket of list) {
      requireCount(bucket.count)
      if (byValue.has(bucket.value)) continue
      byValue.set(bucket.value, labels.length)
      labels.push(bucket.value)
    }
  }
  let undercount = 0
  for (const bound of bounds) {
    requireCount(bound)
    undercount += bound
  }
  requireCount(undercount)
  const offsets = new Uint32Array(lists.length + 1)
  const values = new Uint32Array(entries)
  const counts = new Uint32Array(entries)
  let at = 0
  for (let source = 0; source < lists.length; source++) {
    offsets[source] = at
    for (const bucket of lists[source]) {
      const key = byValue.get(bucket.value)
      if (key === undefined) throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'A facet value has no key')
      values[at] = key
      counts[at++] = bucket.count
    }
  }
  offsets[lists.length] = at
  const ordered = Uint32Array.from(labels, (_, key) => key)
  ordered.sort((left, right) => compareCodePoints(labels[left], labels[right]))
  const ranks = new Uint32Array(labels.length)
  for (let rank = 0; rank < ordered.length; rank++) ranks[ordered[rank]] = rank
  const kept = limit === undefined || limit === Number.POSITIVE_INFINITY ? labels.length : limit
  const size = Math.min(kept, labels.length)
  requireCount(size)
  const outValues = new Uint32Array(size)
  const outCounts = new Uint32Array(size)
  const outBound = new Uint32Array(1)
  const found = mergeFacets(
    offsets,
    values,
    counts,
    Uint32Array.from(bounds),
    ranks,
    ascending,
    size,
    outValues,
    outCounts,
    outBound,
  )
  if (found < 0) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'The facet lists cannot be merged', { status: found })
  }
  const buckets = Array.from(outValues.subarray(0, found), (key, position) => ({
    value: labels[key],
    count: outCounts[position],
  }))
  return { buckets, errorBound: outBound[0], undercount }
}
