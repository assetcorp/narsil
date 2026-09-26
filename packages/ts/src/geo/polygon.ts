import { ErrorCodes, NarsilError } from '../errors'
import { ANTIMERIDIAN_SPAN_DEGREES, FULL_TURN_DEGREES, MIN_POLYGON_POINTS } from './constants'

type GeoPoint = { lat: number; lon: number }

export function requirePolygonRing(points: unknown): void {
  if (!Array.isArray(points) || points.length < MIN_POLYGON_POINTS) {
    throw new NarsilError(
      ErrorCodes.SEARCH_INVALID_FILTER,
      `A polygon encloses an area only with at least ${MIN_POLYGON_POINTS} points`,
      { points: Array.isArray(points) ? points.length : typeof points, minimum: MIN_POLYGON_POINTS },
    )
  }
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

  return (lat: number, rawLon: number): boolean => {
    const lon = unwrap ? eastward(rawLon) : rawLon
    let inside = false
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const lonI = lons[i]
      const lonJ = lons[j]
      if (lonI > lon !== lonJ > lon) {
        const intersectLat = lats[i] + ((lats[j] - lats[i]) / (lonJ - lonI)) * (lon - lonI)
        if (lat < intersectLat) inside = !inside
      }
    }
    return inside
  }
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
