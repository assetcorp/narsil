import { ErrorCodes, NarsilError } from '../errors'
import { MAX_LATITUDE_DEGREES, MAX_LONGITUDE_DEGREES, MIN_POLYGON_POINTS } from './constants'
import { isLatitude, isLongitude } from './coordinates'

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
      `A polygon point must hold a "lat" from -${MAX_LATITUDE_DEGREES} to ${MAX_LATITUDE_DEGREES} and a "lon" from -${MAX_LONGITUDE_DEGREES} to ${MAX_LONGITUDE_DEGREES}, while the point at position ${position} holds ${lat}, ${lon}`,
      { position, lat, lon },
    )
  })
}
