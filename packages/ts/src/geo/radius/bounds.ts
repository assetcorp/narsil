import { sin } from '../../math/trig'
import { DEG_TO_RAD } from '../constants'
import {
  HALF_CHORD_BOUND_COSINE_SLACK,
  HALF_CHORD_BOUND_MAX_SQUARE,
  HALF_CHORD_BOUND_RELATIVE_SLACK,
} from './constants'

export interface HalfChordBoundsOrigin {
  lat: number
  lon: number
  phi: number
  latitudeCosine: number
  latitudeSine: number
}

export const halfChordBounds = { lower: 0, upper: 0 }

export function halfChordBoundsOrigin(lat: number, lon: number, latitudeCosine: number): HalfChordBoundsOrigin {
  const phi = lat * DEG_TO_RAD
  return { lat, lon, phi, latitudeCosine, latitudeSine: sin(phi) }
}

export function boundHalfChord(origin: HalfChordBoundsOrigin, lat: number, lon: number): boolean {
  const halfDeltaPhi = ((lat - origin.lat) * DEG_TO_RAD) / 2
  const halfDeltaLambda = ((lon - origin.lon) * DEG_TO_RAD) / 2
  const step = lat * DEG_TO_RAD - origin.phi
  const phiSquare = halfDeltaPhi * halfDeltaPhi
  const lambdaSquare = halfDeltaLambda * halfDeltaLambda
  const stepSquare = step * step
  if (
    !(
      phiSquare <= HALF_CHORD_BOUND_MAX_SQUARE &&
      lambdaSquare <= HALF_CHORD_BOUND_MAX_SQUARE &&
      stepSquare <= HALF_CHORD_BOUND_MAX_SQUARE
    )
  ) {
    return false
  }
  const stepFourth = stepSquare * stepSquare
  const cosineEstimate =
    origin.latitudeCosine * (1 - stepSquare / 2) - origin.latitudeSine * (step - (step * stepSquare) / 6)
  const cosineSlack =
    (origin.latitudeCosine * stepFourth) / 24 +
    (Math.abs(origin.latitudeSine * step) * stepFourth) / 120 +
    HALF_CHORD_BOUND_COSINE_SLACK
  const phiLow = phiSquare - (phiSquare * phiSquare) / 3
  const phiHigh = phiLow + (2 * phiSquare * phiSquare * phiSquare) / 45
  const lambdaLow = lambdaSquare - (lambdaSquare * lambdaSquare) / 3
  const lambdaHigh = lambdaLow + (2 * lambdaSquare * lambdaSquare * lambdaSquare) / 45
  const lowestCosine = Math.max(0, cosineEstimate - cosineSlack)
  halfChordBounds.lower =
    (phiLow + origin.latitudeCosine * lowestCosine * lambdaLow) * (1 - HALF_CHORD_BOUND_RELATIVE_SLACK)
  halfChordBounds.upper =
    (phiHigh + origin.latitudeCosine * (cosineEstimate + cosineSlack) * lambdaHigh) *
    (1 + HALF_CHORD_BOUND_RELATIVE_SLACK)
  return true
}
