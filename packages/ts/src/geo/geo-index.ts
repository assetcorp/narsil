import type { GeopointEntry } from '../types/internal'
import { coveringRanges, type LocationBox, locationCode, radiusBoxes } from './cells'
import { haversineDistance } from './haversine'
import { polygonBoxes, polygonContainment } from './polygon'
import { vincentyDistance } from './vincenty'

export interface GeoIndexReader {
  radiusQuery(lat: number, lon: number, distanceMeters: number, inside: boolean, highPrecision: boolean): Set<number>
  polygonQuery(points: Array<{ lat: number; lon: number }>, inside: boolean): Set<number>
  serialize(): GeopointEntry[]
}

export interface GeoIndex extends GeoIndexReader {
  insert(internalId: number, lat: number, lon: number): void
  remove(internalId: number): void
  clear(): void
  deserialize(data: GeopointEntry[]): void
}

interface LocatedEntry extends GeopointEntry {
  code: number
}

function firstAtOrAfter(entries: readonly LocatedEntry[], code: number): number {
  let lo = 0
  let hi = entries.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (entries[mid].code < code) lo = mid + 1
    else hi = mid
  }
  return lo
}

export function createGeoIndex(): GeoIndex {
  const entries: LocatedEntry[] = []
  const byDocument = new Map<number, LocatedEntry>()
  let sorted = true

  function ensureSorted(): void {
    if (sorted) return
    entries.sort((left, right) => left.code - right.code || left.docId - right.docId)
    sorted = true
  }

  function removeEntry(internalId: number): void {
    const entry = byDocument.get(internalId)
    if (entry === undefined) return
    byDocument.delete(internalId)
    ensureSorted()
    for (let at = firstAtOrAfter(entries, entry.code); at < entries.length; at++) {
      if (entries[at] !== entry) continue
      entries.splice(at, 1)
      return
    }
  }

  function matching(boxes: readonly LocationBox[], passes: (entry: LocatedEntry) => boolean, inside: boolean) {
    ensureSorted()
    const within = new Set<number>()
    for (const range of coveringRanges(boxes)) {
      for (let at = firstAtOrAfter(entries, range.from); at < entries.length && entries[at].code < range.to; at++) {
        if (passes(entries[at])) within.add(entries[at].docId)
      }
    }
    if (inside) return within
    const outside = new Set<number>()
    for (const entry of entries) {
      if (!within.has(entry.docId)) outside.add(entry.docId)
    }
    return outside
  }

  const index: GeoIndex = {
    insert(internalId: number, lat: number, lon: number): void {
      removeEntry(internalId)
      const entry: LocatedEntry = { lat, lon, docId: internalId, code: locationCode(lat, lon) }
      entries.push(entry)
      byDocument.set(internalId, entry)
      sorted = false
    },

    remove(internalId: number): void {
      removeEntry(internalId)
    },

    radiusQuery(
      lat: number,
      lon: number,
      distanceMeters: number,
      inside: boolean,
      highPrecision: boolean,
    ): Set<number> {
      const distanceFn = highPrecision ? vincentyDistance : haversineDistance
      return matching(
        radiusBoxes(lat, lon, distanceMeters),
        entry => distanceFn(lat, lon, entry.lat, entry.lon) <= distanceMeters,
        inside,
      )
    },

    polygonQuery(points: Array<{ lat: number; lon: number }>, inside: boolean): Set<number> {
      const contains = polygonContainment(points)
      return matching(polygonBoxes(points), entry => contains(entry.lat, entry.lon), inside)
    },

    clear(): void {
      entries.length = 0
      byDocument.clear()
      sorted = true
    },

    serialize(): GeopointEntry[] {
      ensureSorted()
      return entries.map(entry => ({ lat: entry.lat, lon: entry.lon, docId: entry.docId }))
    },

    deserialize(data: GeopointEntry[]): void {
      index.clear()
      for (const entry of data) index.insert(entry.docId, entry.lat, entry.lon)
    },
  }
  return index
}
