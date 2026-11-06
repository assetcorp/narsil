import { DEG_TO_RAD } from '../constants'
import { COSINE_BOUND_ABSOLUTE_SLACK, HALF_CHORD_BOUND_MAX_SQUARE, HALF_CHORD_BOUND_RELATIVE_SLACK } from './constants'

const COSINE_SECOND = -1 / 2
const COSINE_FOURTH = 1 / 24
const COSINE_SIXTH = -1 / 720
const COSINE_EIGHTH = 1 / 40_320
const COSINE_TENTH = -1 / 3_628_800
const COSINE_TWELFTH = 1 / 479_001_600
const COSINE_FOURTEENTH = -1 / 87_178_291_200
const COSINE_SIXTEENTH = 1 / 20_922_789_888_000
const SINE_THIRD = -1 / 6
const SINE_FIFTH = 1 / 120
const SINE_SEVENTH = -1 / 5_040
const SINE_NINTH = 1 / 362_880
const SINE_ELEVENTH = -1 / 39_916_800
const SINE_THIRTEENTH = 1 / 6_227_020_800
const SINE_FIFTEENTH = -1 / 1_307_674_368_000
const SINE_SEVENTEENTH = 1 / 355_687_428_096_000
const SINE_SQUARE_FOURTH = 1 / 3
const SINE_SQUARE_SIXTH = 2 / 45

export interface HalfChordOrigin {
  lat: number
  lon: number
  phi: number
  cosineLow: number
  cosineHigh: number
  sineLow: number
  sineHigh: number
}

export const halfChordBounds = { lower: 0, upper: 0 }

export function sineSquareLow(square: number): number {
  return square - square * square * SINE_SQUARE_FOURTH
}

export function sineSquareHigh(square: number): number {
  return sineSquareLow(square) + square * square * square * SINE_SQUARE_SIXTH
}

export function halfChordOrigin(lat: number, lon: number): HalfChordOrigin {
  const phi = lat * DEG_TO_RAD
  const square = phi * phi
  const squareFourth = square * square * (square * square)
  const cosine =
    1 +
    square *
      (COSINE_SECOND +
        square *
          (COSINE_FOURTH +
            square *
              (COSINE_SIXTH +
                square *
                  (COSINE_EIGHTH + square * (COSINE_TENTH + square * (COSINE_TWELFTH + square * COSINE_FOURTEENTH))))))
  const magnitude = Math.abs(phi)
  const sine =
    magnitude *
    (1 +
      square *
        (SINE_THIRD +
          square *
            (SINE_FIFTH +
              square *
                (SINE_SEVENTH +
                  square *
                    (SINE_NINTH + square * (SINE_ELEVENTH + square * (SINE_THIRTEENTH + square * SINE_FIFTEENTH)))))))
  const sineHigh = sine + magnitude * squareFourth * squareFourth * SINE_SEVENTEENTH + COSINE_BOUND_ABSOLUTE_SLACK
  const sineLow = sine - COSINE_BOUND_ABSOLUTE_SLACK
  return {
    lat,
    lon,
    phi,
    cosineLow: Math.max(0, cosine - COSINE_BOUND_ABSOLUTE_SLACK),
    cosineHigh: cosine + squareFourth * squareFourth * COSINE_SIXTEENTH + COSINE_BOUND_ABSOLUTE_SLACK,
    sineLow: phi < 0 ? -sineHigh : sineLow,
    sineHigh: phi < 0 ? -sineLow : sineHigh,
  }
}

export function boundHalfChord(origin: HalfChordOrigin, lat: number, lon: number): boolean {
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
  const stepCosineLow = 1 - stepSquare / 2
  const stepCosineHigh = stepCosineLow + (stepSquare * stepSquare) / 24
  const stepSine = step - (step * stepSquare) / 6
  const stepSineEnd = stepSine + (step * stepSquare * stepSquare) / 120
  const stepSineLow = Math.min(stepSine, stepSineEnd)
  const stepSineHigh = Math.max(stepSine, stepSineEnd)
  const turnLow = Math.min(
    origin.sineLow * stepSineLow,
    origin.sineLow * stepSineHigh,
    origin.sineHigh * stepSineLow,
    origin.sineHigh * stepSineHigh,
  )
  const turnHigh = Math.max(
    origin.sineLow * stepSineLow,
    origin.sineLow * stepSineHigh,
    origin.sineHigh * stepSineLow,
    origin.sineHigh * stepSineHigh,
  )
  const cosineLow = Math.max(0, origin.cosineLow * stepCosineLow - turnHigh - COSINE_BOUND_ABSOLUTE_SLACK)
  const cosineHigh = origin.cosineHigh * stepCosineHigh - turnLow + COSINE_BOUND_ABSOLUTE_SLACK
  halfChordBounds.lower =
    (sineSquareLow(phiSquare) + origin.cosineLow * cosineLow * sineSquareLow(lambdaSquare)) *
    (1 - HALF_CHORD_BOUND_RELATIVE_SLACK)
  halfChordBounds.upper =
    (sineSquareHigh(phiSquare) + origin.cosineHigh * cosineHigh * sineSquareHigh(lambdaSquare)) *
    (1 + HALF_CHORD_BOUND_RELATIVE_SLACK)
  return true
}
