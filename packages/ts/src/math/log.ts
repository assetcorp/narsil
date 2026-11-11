import { highWord, INFINITE_HIGH_WORD, lowWord, MAGNITUDE_MASK, SMALLEST_NORMAL_HIGH_WORD, withHighWord } from './words'

const EXPONENT_BIAS = 1023
const EXPONENT_SHIFT = 20
const SUBNORMAL_SCALE_EXPONENT = 54
const ROUNDING_OFFSET = 0x95f64
const HALVING_BIT = 0x100000
const ONE_HIGH_WORD = 0x3ff00000
const SIGNIFICAND_MASK = 0x000fffff
const NEAR_ONE_LIMIT = 3
const LOWER_SPLIT = 0x6147a
const UPPER_SPLIT = 0x6b851

const LN2_HI = 6.931471803691238e-1
const LN2_LO = 1.9082149292705877e-10
const TWO54 = 1.8014398509481984e16
const TWO = 2
const THIRD = 3.333333333333333e-1
const HALF = 0.5
const LG1 = 6.666666666666735e-1
const LG2 = 3.999999999940942e-1
const LG3 = 2.857142874366239e-1
const LG4 = 2.2222198432149784e-1
const LG5 = 1.818357216161805e-1
const LG6 = 1.5313837699209373e-1
const LG7 = 1.4798198605116586e-1

function nearOne(fraction: number, scale: number): number {
  if (fraction === 0) {
    if (scale === 0) return 0
    return scale * LN2_HI + scale * LN2_LO
  }
  const cubic = fraction * fraction * (HALF - THIRD * fraction)
  if (scale === 0) return fraction - cubic
  return scale * LN2_HI - (cubic - scale * LN2_LO - fraction)
}

function series(fraction: number, scale: number, significand: number): number {
  const ratio = fraction / (TWO + fraction)
  const square = ratio * ratio
  const below = significand - LOWER_SPLIT
  const fourth = square * square
  const above = UPPER_SPLIT - significand
  const even = fourth * (LG2 + fourth * (LG4 + fourth * LG6))
  const odd = square * (LG1 + fourth * (LG3 + fourth * (LG5 + fourth * LG7)))
  const poly = odd + even
  if ((below | above) > 0) {
    const halfSquare = HALF * fraction * fraction
    if (scale === 0) return fraction - (halfSquare - ratio * (halfSquare + poly))
    return scale * LN2_HI - (halfSquare - (ratio * (halfSquare + poly) + scale * LN2_LO) - fraction)
  }
  if (scale === 0) return fraction - ratio * (fraction - poly)
  return scale * LN2_HI - (ratio * (fraction - poly) - scale * LN2_LO - fraction)
}

export function log(value: number): number {
  let high = highWord(value)
  let scale = 0
  let scaled = value
  if (high < SMALLEST_NORMAL_HIGH_WORD) {
    if (((high & MAGNITUDE_MASK) | lowWord(value)) === 0) return Number.NEGATIVE_INFINITY
    if (high < 0) return Number.NaN
    scale -= SUBNORMAL_SCALE_EXPONENT
    scaled *= TWO54
    high = highWord(scaled)
  }
  if (high >= INFINITE_HIGH_WORD) return scaled + scaled
  scale += (high >> EXPONENT_SHIFT) - EXPONENT_BIAS
  const significand = high & SIGNIFICAND_MASK
  const halving = (significand + ROUNDING_OFFSET) & HALVING_BIT
  scaled = withHighWord(scaled, significand | (halving ^ ONE_HIGH_WORD))
  scale += halving >> EXPONENT_SHIFT
  const fraction = scaled - 1
  if ((SIGNIFICAND_MASK & (2 + significand)) < NEAR_ONE_LIMIT) return nearOne(fraction, scale)
  return series(fraction, scale, significand)
}
