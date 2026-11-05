import { EARTH_RADIUS_METERS } from '../constants'
import {
  boundHalfChord,
  type HalfChordOrigin,
  halfChordBounds,
  halfChordOrigin,
  sineSquareHigh,
  sineSquareLow,
} from './bounds'
import { radiusBoxes } from './boxes'
import {
  HALF_CHORD_BOUND_MAX_SQUARE,
  HALF_CHORD_BOUND_RELATIVE_SLACK,
  RADIUS_BAND_MAX_ANGLE_RADIANS,
  RADIUS_BAND_MIN_ANGLE_RADIANS,
  RADIUS_EXACT_CHECK_BAND_RATIO,
  RADIUS_GEODESIC_BAND_MAX_ANGLE_RADIANS,
  RADIUS_GEODESIC_BAND_MIN_METERS,
  RADIUS_GEODESIC_BAND_RATIO,
  WGS84_LARGEST_CURVATURE_RADIUS_METERS,
  WGS84_SMALLEST_CURVATURE_RADIUS_METERS,
} from './constants'
import {
  type HaversineOrigin,
  haversineDistanceOfChord,
  haversineHalfChord,
  haversineHalfChordOfAngle,
  haversineOrigin,
} from './haversine'
import { type VincentyOrigin, vincentyDistanceFrom, vincentyOrigin } from './vincenty'

type CandidateTest = (candidateLat: number, candidateLon: number) => boolean

function exactHaversineTest(lat: number, lon: number, distanceMeters: number, angle: number | null): CandidateTest {
  let origin: HaversineOrigin | null = null
  let surelyWithin = Number.NEGATIVE_INFINITY
  let surelyBeyond = Number.POSITIVE_INFINITY
  return (candidateLat, candidateLon) => {
    if (origin === null) {
      origin = haversineOrigin(lat, lon)
      if (angle !== null) {
        const edge = haversineHalfChordOfAngle(angle)
        surelyWithin = edge * (1 - RADIUS_EXACT_CHECK_BAND_RATIO)
        surelyBeyond = edge * (1 + RADIUS_EXACT_CHECK_BAND_RATIO)
      }
    }
    const halfChord = haversineHalfChord(origin, candidateLat, candidateLon)
    if (halfChord < surelyWithin) return true
    if (halfChord > surelyBeyond) return false
    return haversineDistanceOfChord(halfChord) <= distanceMeters
  }
}

function haversineTest(lat: number, lon: number, distanceMeters: number): CandidateTest {
  const angle = distanceMeters / EARTH_RADIUS_METERS
  if (angle < RADIUS_BAND_MIN_ANGLE_RADIANS || angle > RADIUS_BAND_MAX_ANGLE_RADIANS) {
    return exactHaversineTest(lat, lon, distanceMeters, null)
  }
  const edgeSquare = (angle / 2) * (angle / 2)
  if (edgeSquare > HALF_CHORD_BOUND_MAX_SQUARE) return exactHaversineTest(lat, lon, distanceMeters, angle)
  const surelyWithin =
    sineSquareLow(edgeSquare) * (1 - RADIUS_EXACT_CHECK_BAND_RATIO) * (1 - HALF_CHORD_BOUND_RELATIVE_SLACK)
  const surelyBeyond =
    sineSquareHigh(edgeSquare) * (1 + RADIUS_EXACT_CHECK_BAND_RATIO) * (1 + HALF_CHORD_BOUND_RELATIVE_SLACK)
  let origin: HalfChordOrigin | null = null
  let exactly: CandidateTest | null = null
  return (candidateLat, candidateLon) => {
    origin ??= halfChordOrigin(lat, lon)
    if (boundHalfChord(origin, candidateLat, candidateLon)) {
      if (halfChordBounds.upper < surelyWithin) return true
      if (halfChordBounds.lower > surelyBeyond) return false
    }
    exactly ??= exactHaversineTest(lat, lon, distanceMeters, angle)
    return exactly(candidateLat, candidateLon)
  }
}

function exactVincentyTest(lat: number, lon: number, distanceMeters: number): CandidateTest {
  let ellipsoid: VincentyOrigin | null = null
  return (candidateLat, candidateLon) => {
    ellipsoid ??= vincentyOrigin(lat, lon)
    return vincentyDistanceFrom(ellipsoid, candidateLat, candidateLon) <= distanceMeters
  }
}

function vincentyTest(lat: number, lon: number, distanceMeters: number): CandidateTest {
  const angle = distanceMeters / EARTH_RADIUS_METERS
  if (distanceMeters < RADIUS_GEODESIC_BAND_MIN_METERS || angle > RADIUS_GEODESIC_BAND_MAX_ANGLE_RADIANS) {
    return exactVincentyTest(lat, lon, distanceMeters)
  }
  const nearest = (distanceMeters * (1 - RADIUS_GEODESIC_BAND_RATIO)) / WGS84_LARGEST_CURVATURE_RADIUS_METERS / 2
  const farthest = (distanceMeters * (1 + RADIUS_GEODESIC_BAND_RATIO)) / WGS84_SMALLEST_CURVATURE_RADIUS_METERS / 2
  const surelyWithin = sineSquareLow(nearest * nearest) * (1 - HALF_CHORD_BOUND_RELATIVE_SLACK)
  const surelyBeyond = sineSquareHigh(farthest * farthest) * (1 + HALF_CHORD_BOUND_RELATIVE_SLACK)
  let origin: HalfChordOrigin | null = null
  let exactly: CandidateTest | null = null
  return (candidateLat, candidateLon) => {
    origin ??= halfChordOrigin(lat, lon)
    if (boundHalfChord(origin, candidateLat, candidateLon)) {
      if (halfChordBounds.upper < surelyWithin) return true
      if (halfChordBounds.lower > surelyBeyond) return false
    }
    exactly ??= exactVincentyTest(lat, lon, distanceMeters)
    return exactly(candidateLat, candidateLon)
  }
}

export { radiusBoxes }

export function radiusCandidateTest(
  lat: number,
  lon: number,
  distanceMeters: number,
  highPrecision: boolean,
): CandidateTest {
  return highPrecision ? vincentyTest(lat, lon, distanceMeters) : haversineTest(lat, lon, distanceMeters)
}
