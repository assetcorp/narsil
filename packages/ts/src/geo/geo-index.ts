import type { GeopointEntry } from '../types/internal'
import { haversineDistance } from './haversine'
import { isPointInPolygon } from './polygon'
import { vincentyDistance } from './vincenty'

export interface GeoIndex {
  readonly entries: readonly GeopointEntry[]
  insert(docId: string, lat: number, lon: number): void
  remove(docId: string): void
  radiusQuery(lat: number, lon: number, distanceMeters: number, inside: boolean, highPrecision: boolean): Set<string>
  polygonQuery(points: Array<{ lat: number; lon: number }>, inside: boolean): Set<string>
  clear(): void
  serialize(): GeopointEntry[]
  deserialize(data: GeopointEntry[]): void
}

export function createGeoIndex(): GeoIndex {
  const entries: GeopointEntry[] = []

  return {
    get entries() {
      return entries
    },

    insert(docId: string, lat: number, lon: number): void {
      entries.push({ lat, lon, docId })
    },

    remove(docId: string): void {
      for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i].docId === docId) {
          entries.splice(i, 1)
          return
        }
      }
    },

    radiusQuery(
      lat: number,
      lon: number,
      distanceMeters: number,
      inside: boolean,
      highPrecision: boolean,
    ): Set<string> {
      const result = new Set<string>()
      const distanceFn = highPrecision ? vincentyDistance : haversineDistance
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]
        const dist = distanceFn(lat, lon, entry.lat, entry.lon)
        const withinRadius = dist <= distanceMeters
        if (inside ? withinRadius : !withinRadius) {
          result.add(entry.docId)
        }
      }
      return result
    },

    polygonQuery(points: Array<{ lat: number; lon: number }>, inside: boolean): Set<string> {
      const result = new Set<string>()
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]
        const withinPolygon = isPointInPolygon(entry.lat, entry.lon, points)
        if (inside ? withinPolygon : !withinPolygon) {
          result.add(entry.docId)
        }
      }
      return result
    },

    clear(): void {
      entries.length = 0
    },

    serialize(): GeopointEntry[] {
      return entries.map(e => ({ ...e }))
    },

    deserialize(data: GeopointEntry[]): void {
      entries.length = 0
      for (const entry of data) {
        entries.push({ lat: entry.lat, lon: entry.lon, docId: entry.docId })
      }
    },
  }
}
