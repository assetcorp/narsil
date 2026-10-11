import { ErrorCodes, NarsilError } from '../errors'
import { type LocationBox, longitudeBoxes } from './cells'
import {
  ANTIMERIDIAN_SPAN_DEGREES,
  FULL_TURN_DEGREES,
  MAX_LATITUDE_DEGREES,
  MAX_LONGITUDE_DEGREES,
  MIN_POLYGON_POINTS,
} from './constants'
import { isLatitude, isLongitude } from './coordinates'
import { buildLongitudeEdgeTree, forEachEdgeSpanning } from './edge-tree'

type GeoPoint = { lat: number; lon: number }

export function requirePolygonRing(points: unknown): void {
  if (!Array.isArray(points) || points.length < MIN_POLYGON_POINTS) {
    throw new NarsilError(
      ErrorCodes.SEARCH_INVALID_FILTER,
      `A polygon encloses an area only with at least ${MIN_POLYGON_POINTS} points`,
      { points: Array.isArray(points) ? points.length : typeof points, minimum: MIN_POLYGON_POINTS },
    )
  }
  points.forEach((point: unknown, position: number) => {
    const { lat, lon } = (point ?? {}) as { lat?: unknown; lon?: unknown }
    if (typeof lat !== 'number' || !Number.isFinite(lat) || typeof lon !== 'number' || !Number.isFinite(lon)) {
      throw new NarsilError(
        ErrorCodes.SEARCH_INVALID_FILTER,
        `A polygon point carries a finite "lat" and "lon", and the point at position ${position} does not`,
        { position },
      )
    }
    if (isLatitude(lat) && isLongitude(lon)) return
    throw new NarsilError(
      ErrorCodes.SEARCH_INVALID_FILTER,
      `A polygon point has a "lat" from -${MAX_LATITUDE_DEGREES} to ${MAX_LATITUDE_DEGREES} and a "lon" from -${MAX_LONGITUDE_DEGREES} to ${MAX_LONGITUDE_DEGREES}, and the point at position ${position} sets ${lat}, ${lon}`,
      { position, lat, lon },
    )
  })
}

function signedArea(polygon: readonly GeoPoint[]): number {
  let area = 0
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    area += polygon[j].lon * polygon[i].lat - polygon[i].lon * polygon[j].lat
  }
  return area
}

function crossesAntimeridian(polygon: readonly GeoPoint[]): boolean {
  let west = Number.POSITIVE_INFINITY
  let east = Number.NEGATIVE_INFINITY
  for (const point of polygon) {
    if (point.lon < west) west = point.lon
    if (point.lon > east) east = point.lon
  }
  return east - west >= ANTIMERIDIAN_SPAN_DEGREES && signedArea(polygon) < 0
}

function eastward(lon: number): number {
  return lon < 0 ? lon + FULL_TURN_DEGREES : lon
}

export function polygonContainment(polygon: readonly GeoPoint[]): (lat: number, lon: number) => boolean {
  const n = polygon.length
  if (n < MIN_POLYGON_POINTS) return () => false

  const unwrap = crossesAntimeridian(polygon)
  const lats = new Float64Array(n)
  const lons = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    lats[i] = polygon[i].lat
    lons[i] = unwrap ? eastward(polygon[i].lon) : polygon[i].lon
  }
  const edges = buildLongitudeEdgeTree(lons)

  return (lat: number, rawLon: number): boolean => {
    const lon = unwrap ? eastward(rawLon) : rawLon
    let inside = false
    forEachEdgeSpanning(edges, lon, (i, j) => {
      const intersectLat = lats[i] + ((lats[j] - lats[i]) / (lons[j] - lons[i])) * (lon - lons[i])
      if (lat < intersectLat) inside = !inside
    })
    return inside
  }
}

export function polygonBoxes(polygon: readonly GeoPoint[]): LocationBox[] {
  if (polygon.length < MIN_POLYGON_POINTS) return []
  const unwrap = crossesAntimeridian(polygon)
  let south = Number.POSITIVE_INFINITY
  let north = Number.NEGATIVE_INFINITY
  let west = Number.POSITIVE_INFINITY
  let east = Number.NEGATIVE_INFINITY
  for (const point of polygon) {
    const lon = unwrap ? eastward(point.lon) : point.lon
    south = Math.min(south, point.lat)
    north = Math.max(north, point.lat)
    west = Math.min(west, lon)
    east = Math.max(east, lon)
  }
  if (west >= MAX_LONGITUDE_DEGREES)
    return longitudeBoxes(south, north, west - FULL_TURN_DEGREES, east - FULL_TURN_DEGREES)
  return longitudeBoxes(south, north, west, east)
}

export function isPointInPolygon(lat: number, lon: number, polygon: readonly GeoPoint[]): boolean {
  return polygonContainment(polygon)(lat, lon)
}

export function polygonCentroid(polygon: Array<{ lat: number; lon: number }>): { lat: number; lon: number } {
  if (polygon.length < MIN_POLYGON_POINTS) {
    return { lat: 0, lon: 0 }
  }

  let signedArea = 0
  let cx = 0
  let cy = 0
  const n = polygon.length

  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    const cross = polygon[i].lat * polygon[j].lon - polygon[j].lat * polygon[i].lon

    signedArea += cross
    cx += (polygon[i].lat + polygon[j].lat) * cross
    cy += (polygon[i].lon + polygon[j].lon) * cross
  }

  signedArea /= 2

  if (signedArea === 0) {
    let latSum = 0
    let lonSum = 0
    for (let i = 0; i < n; i++) {
      latSum += polygon[i].lat
      lonSum += polygon[i].lon
    }
    return { lat: latSum / n, lon: lonSum / n }
  }

  const factor = 6 * signedArea

  return {
    lat: cx / factor,
    lon: cy / factor,
  }
}
