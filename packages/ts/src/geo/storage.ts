import { ErrorCodes, NarsilError } from './geo-host-bindings'

export interface GeoRegions {
  codes: BigUint64Array
  lat: Float64Array
  lon: Float64Array
  ordinals: Uint32Array
}

export function emptyGeoRegions(): GeoRegions {
  return {
    codes: new BigUint64Array(0),
    lat: new Float64Array(0),
    lon: new Float64Array(0),
    ordinals: new Uint32Array(0),
  }
}

export function geoRegionsWithCapacity(rows: GeoRegions, kept: number, needed: number): GeoRegions {
  if (needed <= rows.codes.length) return rows
  if (needed > 0xffffffff) throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'The geo field exceeds its region layout')
  const capacity = Math.max(needed, Math.min(0xffffffff, rows.codes.length * 2))
  const grown: GeoRegions = {
    codes: new BigUint64Array(capacity),
    lat: new Float64Array(capacity),
    lon: new Float64Array(capacity),
    ordinals: new Uint32Array(capacity),
  }
  grown.codes.set(rows.codes.subarray(0, kept))
  grown.lat.set(rows.lat.subarray(0, kept))
  grown.lon.set(rows.lon.subarray(0, kept))
  grown.ordinals.set(rows.ordinals.subarray(0, kept))
  return grown
}

export function firstGeoAtOrAfter(rows: GeoRegions, length: number, code: bigint): number {
  let lo = 0
  let hi = length
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2)
    if (rows.codes[mid] < code) lo = mid + 1
    else hi = mid
  }
  return lo
}

export function firstGeoAfter(rows: GeoRegions, length: number, code: bigint, ordinal: number): number {
  let lo = 0
  let hi = length
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2)
    const midCode = rows.codes[mid]
    if (midCode > code || (midCode === code && rows.ordinals[mid] > ordinal)) hi = mid
    else lo = mid + 1
  }
  return lo
}

function moveRows(rows: GeoRegions, into: number, from: number, end: number): void {
  rows.codes.copyWithin(into, from, end)
  rows.lat.copyWithin(into, from, end)
  rows.lon.copyWithin(into, from, end)
  rows.ordinals.copyWithin(into, from, end)
}

export function withoutGeoRows(rows: GeoRegions, length: number, removedRows: readonly number[]): number {
  const removed = Uint32Array.from(removedRows).sort()
  let write = removed[0]
  for (let at = 0; at < removed.length; at++) {
    const from = removed[at] + 1
    const to = at + 1 < removed.length ? removed[at + 1] : length
    if (to > from) moveRows(rows, write, from, to)
    write += to - from
  }
  return write
}

export function withoutRemovedGeoPending(rows: GeoRegions, length: number, removed: ReadonlySet<number>): number {
  let write = 0
  for (let read = 0; read < length; read++) {
    if (removed.has(read)) continue
    if (write !== read) moveRows(rows, write, read, read + 1)
    write++
  }
  return write
}

export function geoSortedOrder(rows: GeoRegions, length: number): Uint32Array {
  const order = Uint32Array.from({ length }, (_, at) => at)
  return order.sort((left, right) => {
    const leftCode = rows.codes[left]
    const rightCode = rows.codes[right]
    return leftCode < rightCode ? -1 : leftCode > rightCode ? 1 : rows.ordinals[left] - rows.ordinals[right]
  })
}

export function mergeGeoRows(
  located: GeoRegions,
  placed: number,
  pending: GeoRegions,
  order: Uint32Array,
  byDocument: Map<number, number | bigint>,
): void {
  let unmerged = placed
  for (let right = order.length - 1; right >= 0; right--) {
    const source = order[right]
    const code = pending.codes[source]
    const ordinal = pending.ordinals[source]
    const from = firstGeoAfter(located, unmerged, code, ordinal)
    if (from < unmerged) moveRows(located, from + right + 1, from, unmerged)
    const target = from + right
    located.codes[target] = code
    located.lat[target] = pending.lat[source]
    located.lon[target] = pending.lon[source]
    located.ordinals[target] = ordinal
    byDocument.set(ordinal, code)
    unmerged = from
  }
}
