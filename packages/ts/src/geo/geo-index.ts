import { FieldPresence } from '../core/field-index/presence'
import type { GeopointEntry } from '../types/internal'

export { filterGeoRegions } from './filter'

import { coveringRanges, type LocationBox, locationCode } from './cells'
import { polygonBoxes, polygonContainment } from './polygon'
import { radiusBoxes, radiusCandidateTest } from './radius'
import {
  emptyGeoRegions,
  firstGeoAfter,
  firstGeoAtOrAfter,
  type GeoRegions,
  geoRegionsWithCapacity,
  geoSortedOrder,
  mergeGeoRows,
  withoutGeoRows,
  withoutRemovedGeoPending,
} from './storage'

export interface GeoIndexReader {
  regionBytes(): number
  presentOrdinals(capacity: number): Uint32Array
  regions(): GeoRegions
  radiusQuery(lat: number, lon: number, distanceMeters: number, inside: boolean, highPrecision: boolean): Set<number>
  polygonQuery(points: Array<{ lat: number; lon: number }>, inside: boolean): Set<number>
  documentIds(): Iterable<number>
  serialize(): GeopointEntry[]
}

export interface GeoIndex extends GeoIndexReader {
  insert(internalId: number, lat: number, lon: number): void
  remove(internalId: number): void
  clear(): void
  deserialize(data: GeopointEntry[]): void
}

type LocationTest = (lat: number, lon: number) => boolean

export function createGeoIndex(removalMergeFloor: number, removalMergeDivisor: number): GeoIndex {
  let located = emptyGeoRegions()
  let placed = 0
  let removedRows: number[] = []
  let pending = emptyGeoRegions()
  let pendingCount = 0
  const pendingRemoved = new Set<number>()
  const byDocument = new Map<number, number | bigint>()
  const present = new FieldPresence(() => byDocument.keys())

  function ensureSorted(): void {
    if (removedRows.length > 0) {
      placed = withoutGeoRows(located, placed, removedRows)
      removedRows = []
    }
    if (pendingRemoved.size > 0) {
      pendingCount = withoutRemovedGeoPending(pending, pendingCount, pendingRemoved)
      pendingRemoved.clear()
    }
    if (pendingCount === 0) return
    const order = geoSortedOrder(pending, pendingCount)
    located = geoRegionsWithCapacity(located, placed, placed + pendingCount)
    mergeGeoRows(located, placed, pending, order, byDocument)
    placed += pendingCount
    pendingCount = 0
    pending = emptyGeoRegions()
  }

  function removeDocument(docId: number, reference: number | bigint): void {
    present.invalidate()
    byDocument.delete(docId)
    if (typeof reference === 'number') pendingRemoved.add(-reference - 1)
    else removedRows.push(firstGeoAfter(located, placed, reference, docId) - 1)
    const removedCount = removedRows.length + pendingRemoved.size
    const held = placed + pendingCount
    if (removedCount >= Math.max(removalMergeFloor, held / removalMergeDivisor)) ensureSorted()
  }

  function matching(boxes: readonly LocationBox[], prepare: () => LocationTest, inside: boolean) {
    ensureSorted()
    const within = new Set<number>()
    let passes: LocationTest | null = null
    for (const range of coveringRanges(boxes)) {
      let at = firstGeoAtOrAfter(located, placed, BigInt(range.from))
      const end = BigInt(range.to)
      for (; at < placed && located.codes[at] < end; at++) {
        passes ??= prepare()
        if (passes(located.lat[at], located.lon[at])) within.add(located.ordinals[at])
      }
    }
    if (inside) return within
    const outside = new Set<number>()
    for (let at = 0; at < placed; at++) {
      const docId = located.ordinals[at]
      if (!within.has(docId)) outside.add(docId)
    }
    return outside
  }

  const index: GeoIndex = {
    presentOrdinals: capacity => present.regions(capacity),
    regionBytes: () =>
      located.codes.byteLength +
      located.lat.byteLength +
      located.lon.byteLength +
      located.ordinals.byteLength +
      pending.codes.byteLength +
      pending.lat.byteLength +
      pending.lon.byteLength +
      pending.ordinals.byteLength +
      present.bytes(),
    regions(): GeoRegions {
      ensureSorted()
      return {
        codes: located.codes.subarray(0, placed),
        lat: located.lat.subarray(0, placed),
        lon: located.lon.subarray(0, placed),
        ordinals: located.ordinals.subarray(0, placed),
      }
    },
    insert(internalId: number, lat: number, lon: number): void {
      present.invalidate()
      const existing = byDocument.get(internalId)
      if (existing !== undefined) removeDocument(internalId, existing)
      pending = geoRegionsWithCapacity(pending, pendingCount, pendingCount + 1)
      pending.codes[pendingCount] = BigInt(locationCode(lat, lon))
      pending.lat[pendingCount] = lat
      pending.lon[pendingCount] = lon
      pending.ordinals[pendingCount] = internalId
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

    documentIds(): Iterable<number> {
      return byDocument.keys()
    },

    clear(): void {
      present.invalidate()
      located = emptyGeoRegions()
      placed = 0
      removedRows = []
      pending = emptyGeoRegions()
      pendingCount = 0
      pendingRemoved.clear()
      byDocument.clear()
    },

    serialize(): GeopointEntry[] {
      ensureSorted()
      return Array.from({ length: placed }, (_, at) => ({
        lat: located.lat[at],
        lon: located.lon[at],
        docId: located.ordinals[at],
      }))
    },

    deserialize(data: GeopointEntry[]): void {
      index.clear()
      for (const entry of data) index.insert(entry.docId, entry.lat, entry.lon)
    },
  }
  return index
}
