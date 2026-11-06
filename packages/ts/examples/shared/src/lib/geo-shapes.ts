import type { FilterExpression } from '@delali/narsil'

export interface GeoPoint {
  lat: number
  lon: number
}

export type MapShape =
  | { kind: 'radius'; centre: GeoPoint; distanceKm: number }
  | { kind: 'polygon'; corners: GeoPoint[] }

export const MAP_WIDTH = 360
export const MAP_HEIGHT = 180
export const MAX_POLYGON_CORNERS = 64
export const MAX_RADIUS_KM = 20_000
export const COORDINATE_DECIMALS = 4

const MAX_LATITUDE = 90
const MAX_LONGITUDE = 180

export function isGeoPoint(value: unknown): value is GeoPoint {
  if (typeof value !== 'object' || value === null) return false
  const { lat, lon } = value as Record<string, unknown>
  return typeof lat === 'number' && Number.isFinite(lat) && typeof lon === 'number' && Number.isFinite(lon)
}

export function validPoint(lat: number, lon: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= MAX_LATITUDE && Math.abs(lon) <= MAX_LONGITUDE
}

export function projectX(lon: number): number {
  return lon + MAX_LONGITUDE
}

export function projectY(lat: number): number {
  return MAX_LATITUDE - lat
}

export function unproject(x: number, y: number): GeoPoint {
  const lon = Math.min(MAX_LONGITUDE, Math.max(-MAX_LONGITUDE, x - MAX_LONGITUDE))
  const lat = Math.min(MAX_LATITUDE, Math.max(-MAX_LATITUDE, MAX_LATITUDE - y))
  return { lat: roundCoordinate(lat), lon: roundCoordinate(lon) }
}

export function roundCoordinate(value: number): number {
  const scale = 10 ** COORDINATE_DECIMALS
  return Math.round(value * scale) / scale
}

export function formatCorner(point: GeoPoint): string {
  return `${point.lat}, ${point.lon}`
}

export function parseCorners(text: string): GeoPoint[] | string {
  const lines = text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
  if (lines.length > MAX_POLYGON_CORNERS) return `Draw at most ${MAX_POLYGON_CORNERS} corners.`
  const corners: GeoPoint[] = []
  for (const line of lines) {
    const parts = line.split(',').map(part => part.trim())
    const lat = Number(parts[0])
    const lon = Number(parts[1])
    if (parts.length !== 2 || parts[0] === '' || parts[1] === '' || !validPoint(lat, lon)) {
      return `"${line}" is no corner. Write each one as a latitude and a longitude, such as 5.6, -0.2.`
    }
    corners.push({ lat, lon })
  }
  return corners
}

export function shapeFilter(field: string, shape: MapShape): FilterExpression | null {
  if (shape.kind === 'radius') {
    const { centre, distanceKm } = shape
    if (!validPoint(centre.lat, centre.lon) || !(distanceKm > 0) || distanceKm > MAX_RADIUS_KM) return null
    return { fields: { [field]: { radius: { lat: centre.lat, lon: centre.lon, distance: distanceKm, unit: 'km' } } } }
  }
  if (shape.corners.length < 3) return null
  return { fields: { [field]: { polygon: { points: shape.corners } } } }
}
