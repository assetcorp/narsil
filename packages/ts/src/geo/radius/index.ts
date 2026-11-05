import { cos } from '../../math/trig'
import type { LocationBox } from '../cells'
import { DEG_TO_RAD, EARTH_RADIUS_METERS } from '../constants'
import { boundHalfChord, type HalfChordBoundsOrigin, halfChordBounds, halfChordBoundsOrigin } from './bounds'
import { radiusBoxes } from './boxes'
import {
  RADIUS_BAND_MAX_ANGLE_RADIANS,
  RADIUS_BAND_MIN_ANGLE_RADIANS,
  RADIUS_EXACT_CHECK_BAND_RATIO,
  RADIUS_GEODESIC_BAND_MAX_ANGLE_RADIANS,
  RADIUS_GEODESIC_BAND_MIN_METERS,
  RADIUS_GEODESIC_BAND_RATIO,
  WGS84_LARGEST_CURVATURE_RADIUS_METERS,
  WGS84_SMALLEST_CURVATURE_RADIUS_METERS,
} from './constants'
import { haversineDistanceOfChord, haversineHalfChord, haversineHalfChordOfAngle } from './haversine'
import { vincentyDistanceFrom, vincentyOrigin } from './vincenty'

export interface RadiusCandidate {
  readonly lat: number
  readonly lon: number
}

type CandidateTest = (candidate: RadiusCandidate) => boolean

export interface RadiusTest {
  boxes: LocationBox[]
  candidateTest(): CandidateTest
}

interface HalfChordBand {
  surelyWithin: number
  surelyBeyond: number
}

function sphericalBand(angle: number): HalfChordBand | null {
  if (angle < RADIUS_BAND_MIN_ANGLE_RADIANS || angle > RADIUS_BAND_MAX_ANGLE_RADIANS) return null
  const edge = haversineHalfChordOfAngle(angle)
  return {
    surelyWithin: edge * (1 - RADIUS_EXACT_CHECK_BAND_RATIO),
    surelyBeyond: edge * (1 + RADIUS_EXACT_CHECK_BAND_RATIO),
  }
}

function geodesicBand(distanceMeters: number): HalfChordBand | null {
  const angle = distanceMeters / EARTH_RADIUS_METERS
  if (distanceMeters < RADIUS_GEODESIC_BAND_MIN_METERS || angle > RADIUS_GEODESIC_BAND_MAX_ANGLE_RADIANS) return null
  const nearest = (distanceMeters * (1 - RADIUS_GEODESIC_BAND_RATIO)) / WGS84_LARGEST_CURVATURE_RADIUS_METERS
  const farthest = (distanceMeters * (1 + RADIUS_GEODESIC_BAND_RATIO)) / WGS84_SMALLEST_CURVATURE_RADIUS_METERS
  return { surelyWithin: haversineHalfChordOfAngle(nearest), surelyBeyond: haversineHalfChordOfAngle(farthest) }
}

function boundedFirst(
  origin: HalfChordBoundsOrigin,
  band: HalfChordBand | null,
  exactly: CandidateTest,
): CandidateTest {
  if (band === null) return exactly
  const { surelyWithin, surelyBeyond } = band
  return candidate => {
    if (boundHalfChord(origin, candidate.lat, candidate.lon)) {
      if (halfChordBounds.upper < surelyWithin) return true
      if (halfChordBounds.lower > surelyBeyond) return false
    }
    return exactly(candidate)
  }
}

function haversineTest(origin: HalfChordBoundsOrigin, distanceMeters: number): CandidateTest {
  const band = sphericalBand(distanceMeters / EARTH_RADIUS_METERS)
  const surelyWithin = band?.surelyWithin ?? Number.NEGATIVE_INFINITY
  const surelyBeyond = band?.surelyBeyond ?? Number.POSITIVE_INFINITY
  return boundedFirst(origin, band, candidate => {
    const halfChord = haversineHalfChord(origin, candidate.lat, candidate.lon)
    if (halfChord < surelyWithin) return true
    if (halfChord > surelyBeyond) return false
    return haversineDistanceOfChord(halfChord) <= distanceMeters
  })
}

function vincentyTest(origin: HalfChordBoundsOrigin, distanceMeters: number): CandidateTest {
  const ellipsoidOrigin = vincentyOrigin(origin.lat, origin.lon)
  return boundedFirst(
    origin,
    geodesicBand(distanceMeters),
    candidate => vincentyDistanceFrom(ellipsoidOrigin, candidate.lat, candidate.lon) <= distanceMeters,
  )
}

export function radiusTest(lat: number, lon: number, distanceMeters: number, highPrecision: boolean): RadiusTest {
  const latitudeCosine = cos(lat * DEG_TO_RAD)
  return {
    boxes: radiusBoxes(lat, lon, distanceMeters, latitudeCosine),
    candidateTest() {
      const origin = halfChordBoundsOrigin(lat, lon, latitudeCosine)
      return highPrecision ? vincentyTest(origin, distanceMeters) : haversineTest(origin, distanceMeters)
    },
  }
}
