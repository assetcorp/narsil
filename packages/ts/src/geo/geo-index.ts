import { bitsetSet, createBitSet } from '../core/bitset'
import { PENDING_REMOVAL_MERGE_DIVISOR, PENDING_REMOVAL_MERGE_FLOOR } from '../core/constants'
import type { GeopointEntry } from '../types/internal'
import { coveringRanges, type LocationBox, locationCode } from './cells'
import { polygonBoxes, polygonContainment } from './polygon'
import { radiusBoxes, radiusCandidateTest } from './radius'

export interface GeoIndexReader {
  radiusQuery(lat: number, lon: number, distanceMeters: number, inside: boolean, highPrecision: boolean): Set<number>
  polygonQuery(points: Array<{ lat: number; lon: number }>, inside: boolean): Set<number>
  documentsBitset(capacity: number): Uint32Array
  serialize(): GeopointEntry[]
}

export interface GeoIndex extends GeoIndexReader {
  insert(internalId: number, lat: number, lon: number): void
  remove(internalId: number): void
  clear(): void
  deserialize(data: GeopointEntry[]): void
}

type LocationTest = (lat: number, lon: number) => boolean
type LocationRows = Float64Array<ArrayBuffer>

const REMOVED_DOC_ID = -1
const ROW_STRIDE = 4
const ROW_CODE = 0
const ROW_LAT = 1
const ROW_LON = 2
const ROW_DOC_ID = 3

function firstAtOrAfter(rows: LocationRows, length: number, code: number): number {
  let lo = 0
  let hi = length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (rows[mid * ROW_STRIDE + ROW_CODE] < code) lo = mid + 1
    else hi = mid
  }
  return lo
}

function firstAfter(rows: LocationRows, length: number, code: number, docId: number): number {
  let lo = 0
  let hi = length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    const midCode = rows[mid * ROW_STRIDE + ROW_CODE]
    if (midCode > code || (midCode === code && rows[mid * ROW_STRIDE + ROW_DOC_ID] > docId)) hi = mid
    else lo = mid + 1
  }
  return lo
}

function withCapacity(rows: LocationRows, kept: number, needed: number): LocationRows {
  if (rows.length >= needed * ROW_STRIDE) return rows
  const grown = new Float64Array(Math.max(needed, (rows.length / ROW_STRIDE) * 2) * ROW_STRIDE)
  grown.set(rows.subarray(0, kept * ROW_STRIDE))
  return grown
}

function withoutRows(rows: LocationRows, length: number, removedRows: number[]): number {
  const removed = Float64Array.from(removedRows).sort()
  let write = removed[0]
  for (let at = 0; at < removed.length; at++) {
    const from = removed[at] + 1
    const to = at + 1 < removed.length ? removed[at + 1] : length
    if (to > from) rows.copyWithin(write * ROW_STRIDE, from * ROW_STRIDE, to * ROW_STRIDE)
    write += to - from
  }
  return write
}

function withoutRemovedPending(rows: LocationRows, length: number): number {
  let write = 0
  for (let read = 0; read < length; read++) {
    const source = read * ROW_STRIDE
    if (rows[source + ROW_DOC_ID] === REMOVED_DOC_ID) continue
    if (write !== read) rows.copyWithin(write * ROW_STRIDE, source, source + ROW_STRIDE)
    write++
  }
  return write
}

function sortedOrder(rows: LocationRows, length: number): Uint32Array {
  const order = new Uint32Array(length)
  for (let at = 0; at < length; at++) order[at] = at
  return order.sort(
    (left, right) =>
      rows[left * ROW_STRIDE + ROW_CODE] - rows[right * ROW_STRIDE + ROW_CODE] ||
      rows[left * ROW_STRIDE + ROW_DOC_ID] - rows[right * ROW_STRIDE + ROW_DOC_ID],
  )
}

function mergeInto(
  located: LocationRows,
  placed: number,
  pending: LocationRows,
  order: Uint32Array,
  byDocument: Map<number, number>,
): void {
  let unmerged = placed
  for (let right = order.length - 1; right >= 0; right--) {
    const source = order[right] * ROW_STRIDE
    const code = pending[source + ROW_CODE]
    const docId = pending[source + ROW_DOC_ID]
    const from = firstAfter(located, unmerged, code, docId)
    if (from < unmerged) located.copyWithin((from + right + 1) * ROW_STRIDE, from * ROW_STRIDE, unmerged * ROW_STRIDE)
    const target = (from + right) * ROW_STRIDE
    located[target + ROW_CODE] = code
    located[target + ROW_LAT] = pending[source + ROW_LAT]
    located[target + ROW_LON] = pending[source + ROW_LON]
    located[target + ROW_DOC_ID] = docId
    byDocument.set(docId, code)
    unmerged = from
  }
}

export function createGeoIndex(): GeoIndex {
  let located: LocationRows = new Float64Array(0)
  let placed = 0
  let removedRows: number[] = []
  let pending: LocationRows = new Float64Array(0)
  let pendingCount = 0
  let pendingRemoved = 0
  const byDocument = new Map<number, number>()

  function ensureSorted(): void {
    if (removedRows.length > 0) {
      placed = withoutRows(located, placed, removedRows)
      removedRows = []
    }
    if (pendingRemoved > 0) {
      pendingCount = withoutRemovedPending(pending, pendingCount)
      pendingRemoved = 0
    }
    if (pendingCount === 0) return
    const order = sortedOrder(pending, pendingCount)
    located = withCapacity(located, placed, placed + pendingCount)
    mergeInto(located, placed, pending, order, byDocument)
    placed += pendingCount
    pendingCount = 0
    pending = new Float64Array(0)
  }

  function removeDocument(docId: number, reference: number): void {
    byDocument.delete(docId)
    if (reference < 0) {
      pending[(-reference - 1) * ROW_STRIDE + ROW_DOC_ID] = REMOVED_DOC_ID
      pendingRemoved++
    } else {
      removedRows.push(firstAfter(located, placed, reference, docId) - 1)
    }
    const removedCount = removedRows.length + pendingRemoved
    const held = placed + pendingCount
    if (removedCount >= Math.max(PENDING_REMOVAL_MERGE_FLOOR, held / PENDING_REMOVAL_MERGE_DIVISOR)) ensureSorted()
  }

  function matching(boxes: readonly LocationBox[], prepare: () => LocationTest, inside: boolean) {
    ensureSorted()
    const within = new Set<number>()
    let passes: LocationTest | null = null
    const end = placed * ROW_STRIDE
    for (const range of coveringRanges(boxes)) {
      let base = firstAtOrAfter(located, placed, range.from) * ROW_STRIDE
      for (; base < end && located[base + ROW_CODE] < range.to; base += ROW_STRIDE) {
        passes ??= prepare()
        if (passes(located[base + ROW_LAT], located[base + ROW_LON])) within.add(located[base + ROW_DOC_ID])
      }
    }
    if (inside) return within
    const outside = new Set<number>()
    for (let base = 0; base < end; base += ROW_STRIDE) {
      const docId = located[base + ROW_DOC_ID]
      if (!within.has(docId)) outside.add(docId)
    }
    return outside
  }

  const index: GeoIndex = {
    insert(internalId: number, lat: number, lon: number): void {
      const existing = byDocument.get(internalId)
      if (existing !== undefined) removeDocument(internalId, existing)
      pending = withCapacity(pending, pendingCount, pendingCount + 1)
      const base = pendingCount * ROW_STRIDE
      pending[base + ROW_CODE] = locationCode(lat, lon)
      pending[base + ROW_LAT] = lat
      pending[base + ROW_LON] = lon
      pending[base + ROW_DOC_ID] = internalId
      pendingCount++
      byDocument.set(internalId, -pendingCount)
    },

    remove(internalId: number): void {
      const existing = byDocument.get(internalId)
      if (existing !== undefined) removeDocument(internalId, existing)
    },

    radiusQuery(
      lat: number,
      lon: number,
      distanceMeters: number,
      inside: boolean,
      highPrecision: boolean,
    ): Set<number> {
      return matching(
        radiusBoxes(lat, lon, distanceMeters),
        () => radiusCandidateTest(lat, lon, distanceMeters, highPrecision),
        inside,
      )
    },

    polygonQuery(points: Array<{ lat: number; lon: number }>, inside: boolean): Set<number> {
      const contains = polygonContainment(points)
      return matching(polygonBoxes(points), () => contains, inside)
    },

    documentsBitset(capacity: number): Uint32Array {
      const bits = createBitSet(capacity)
      for (const docId of byDocument.keys()) bitsetSet(bits, docId)
      return bits
    },

    clear(): void {
      located = new Float64Array(0)
      placed = 0
      removedRows = []
      pending = new Float64Array(0)
      pendingCount = 0
      pendingRemoved = 0
      byDocument.clear()
    },

    serialize(): GeopointEntry[] {
      ensureSorted()
      const serialized: GeopointEntry[] = new Array(placed)
      for (let at = 0; at < placed; at++) {
        const base = at * ROW_STRIDE
        serialized[at] = {
          lat: located[base + ROW_LAT],
          lon: located[base + ROW_LON],
          docId: located[base + ROW_DOC_ID],
        }
      }
      return serialized
    },

    deserialize(data: GeopointEntry[]): void {
      index.clear()
      for (const entry of data) index.insert(entry.docId, entry.lat, entry.lon)
    },
  }
  return index
}
