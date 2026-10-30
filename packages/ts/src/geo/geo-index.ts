import { bitsetSet, createBitSet } from '../core/bitset'
import { PENDING_REMOVAL_MERGE_DIVISOR, PENDING_REMOVAL_MERGE_FLOOR } from '../core/constants'
import type { GeopointEntry } from '../types/internal'
import { coveringRanges, type LocationBox, locationCode, radiusBoxes } from './cells'
import { haversineDistance } from './haversine'
import { polygonBoxes, polygonContainment } from './polygon'
import { vincentyDistance } from './vincenty'

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

interface LocatedEntry extends GeopointEntry {
  code: number
}

const REMOVED_DOC_ID = -1

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

function dropRemoved(entries: LocatedEntry[]): void {
  let write = 0
  for (let read = 0; read < entries.length; read++) {
    if (entries[read].docId !== REMOVED_DOC_ID) entries[write++] = entries[read]
  }
  entries.length = write
}

function mergeSortedPending(entries: LocatedEntry[], pending: LocatedEntry[]): void {
  pending.sort((left, right) => left.code - right.code || left.docId - right.docId)
  const mainLength = entries.length
  for (const entry of pending) entries.push(entry)
  let left = mainLength - 1
  let right = pending.length - 1
  let write = entries.length - 1
  while (right >= 0) {
    const later = left >= 0 ? entries[left] : undefined
    const next = pending[right]
    if (later !== undefined && (later.code > next.code || (later.code === next.code && later.docId > next.docId))) {
      entries[write--] = later
      left--
    } else {
      entries[write--] = next
      right--
    }
  }
}

export function createGeoIndex(): GeoIndex {
  let entries: LocatedEntry[] = []
  let pending: LocatedEntry[] = []
  const byDocument = new Map<number, LocatedEntry>()
  let removedCount = 0

  function ensureSorted(): void {
    if (removedCount > 0) {
      dropRemoved(entries)
      dropRemoved(pending)
      removedCount = 0
    }
    if (pending.length === 0) return
    if (entries.length === 0) {
      pending.sort((left, right) => left.code - right.code || left.docId - right.docId)
      entries = pending
    } else {
      mergeSortedPending(entries, pending)
    }
    pending = []
  }

  function removeEntry(entry: LocatedEntry): void {
    byDocument.delete(entry.docId)
    entry.docId = REMOVED_DOC_ID
    removedCount++
    const held = entries.length + pending.length
    if (removedCount >= Math.max(PENDING_REMOVAL_MERGE_FLOOR, held / PENDING_REMOVAL_MERGE_DIVISOR)) ensureSorted()
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
      const existing = byDocument.get(internalId)
      if (existing !== undefined) removeEntry(existing)
      const entry: LocatedEntry = { lat, lon, docId: internalId, code: locationCode(lat, lon) }
      pending.push(entry)
      byDocument.set(internalId, entry)
    },

    remove(internalId: number): void {
      const existing = byDocument.get(internalId)
      if (existing !== undefined) removeEntry(existing)
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

    documentsBitset(capacity: number): Uint32Array {
      const bits = createBitSet(capacity)
      for (const docId of byDocument.keys()) bitsetSet(bits, docId)
      return bits
    },

    clear(): void {
      entries = []
      pending = []
      byDocument.clear()
      removedCount = 0
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
