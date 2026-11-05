import { atan2 } from '../../math/inverse'
import { cos, sin } from '../../math/trig'
import { DEG_TO_RAD, EARTH_RADIUS_METERS } from '../constants'

export interface HaversineOrigin {
  lat: number
  lon: number
  latitudeCosine: number
}

export function haversineOrigin(lat: number, lon: number): HaversineOrigin {
  return { lat, lon, latitudeCosine: cos(lat * DEG_TO_RAD) }
}

export function haversineHalfChord(origin: HaversineOrigin, lat: number, lon: number): number {
  const phi2 = lat * DEG_TO_RAD
  const deltaPhi = (lat - origin.lat) * DEG_TO_RAD
  const deltaLambda = (lon - origin.lon) * DEG_TO_RAD

  const halfDeltaPhi = sin(deltaPhi / 2)
  const halfDeltaLambda = sin(deltaLambda / 2)

  return halfDeltaPhi * halfDeltaPhi + origin.latitudeCosine * cos(phi2) * halfDeltaLambda * halfDeltaLambda
}

export function haversineHalfChordOfAngle(angle: number): number {
  const halfChordSine = sin(angle / 2)
  return halfChordSine * halfChordSine
}

export function haversineDistanceOfChord(halfChord: number): number {
  const c = 2 * atan2(Math.sqrt(halfChord), Math.sqrt(1 - halfChord))
  return EARTH_RADIUS_METERS * c
}

export function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  return haversineDistanceOfChord(haversineHalfChord(haversineOrigin(lat1, lon1), lat2, lon2))
}
