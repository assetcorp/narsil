import { highWord, INFINITE_HIGH_WORD, lowWord, MAGNITUDE_MASK, withLowWord } from './words'

const ONE_HIGH_WORD = 0x3ff00000
const STEEP_SINE_LIMIT = 0.97499990463256836
const TINY_LIMIT = 7.450580596923828e-9
const HUGE_TANGENT_LIMIT = 2 ** 66
const FIRST_BAND_LIMIT = 0.4375
const SECOND_BAND_LIMIT = 0.6875
const THIRD_BAND_LIMIT = 1.1875
const FOURTH_BAND_LIMIT = 2.4375
const NO_BAND = -1
const STEEP_BAND = 3
const RATIO_EXPONENT_LIMIT = 60
const PLAIN_RATIO_FLOOR = 2 ** -59
const PLAIN_RATIO_CEILING = 2 ** 60
const SMALLEST_NORMAL = 2.2250738585072014e-308
const EXPONENT_SHIFT = 20
const SIGN_SHIFT = 31
const RUN_SIGN_SHIFT = 30
const RUN_SIGN_MASK = 2
const BOTH_POSITIVE = 0
const RISE_NEGATIVE = 1
const RUN_NEGATIVE = 2

const HUGE = 1e300
const TWO = 2
const PIO2_HI = 1.5707963267948966
const PIO2_LO = 6.123233995736766e-17
const PIO4_HI = 7.853981633974483e-1
const PS0 = 1.6666666666666666e-1
const PS1 = -3.255658186224009e-1
const PS2 = 2.0121253213486293e-1
const PS3 = -4.005553450067941e-2
const PS4 = 7.915349942898145e-4
const PS5 = 3.479331075960212e-5
const QS1 = -2.403394911734414
const QS2 = 2.0209457602335057
const QS3 = -6.882839716054533e-1
const QS4 = 7.703815055590194e-2

const ATAN_HI = Float64Array.from([4.636476090008061e-1, 7.853981633974483e-1, 9.82793723247329e-1, 1.5707963267948966])
const ATAN_LO = Float64Array.from([
  2.2698777452961687e-17, 3.061616997868383e-17, 1.3903311031230998e-17, 6.123233995736766e-17,
])

const ATAN_C0 = 3.333333333333293e-1
const ATAN_C1 = -1.9999999999876483e-1
const ATAN_C2 = 1.4285714272503466e-1
const ATAN_C3 = -1.1111110405462356e-1
const ATAN_C4 = 9.090887133436507e-2
const ATAN_C5 = -7.69187620504483e-2
const ATAN_C6 = 6.661073137387531e-2
const ATAN_C7 = -5.8335701337905735e-2
const ATAN_C8 = 4.9768779946159324e-2
const ATAN_C9 = -3.6531572744216916e-2
const ATAN_C10 = 1.6285820115365782e-2

const ONE_AND_HALF = 1.5
const HALF = 0.5
const TINY = 1e-300
const PI_O_4 = 7.853981633974483e-1
const PI_O_2 = 1.5707963267948966
const PI_WHOLE = Math.PI
const PI_LO = 1.2246467991473532e-16
const THREE = 3

function asinRatio(square: number): number {
  const numerator = square * (PS0 + square * (PS1 + square * (PS2 + square * (PS3 + square * (PS4 + square * PS5)))))
  const denominator = 1 + square * (QS1 + square * (QS2 + square * (QS3 + square * QS4)))
  return numerator / denominator
}

function steepAsin(absolute: number): number {
  const rest = 1 - absolute
  const halfRest = rest * HALF
  const root = Math.sqrt(halfRest)
  if (absolute >= STEEP_SINE_LIMIT) {
    return PIO2_HI - (TWO * (root + root * asinRatio(halfRest)) - PIO2_LO)
  }
  const rootHead = withLowWord(root, 0)
  const correction = (halfRest - rootHead * rootHead) / (root + rootHead)
  const ratio = asinRatio(halfRest)
  const lowPart = TWO * root * ratio - (PIO2_LO - TWO * correction)
  const highPart = PIO4_HI - TWO * rootHead
  return PIO4_HI - (lowPart - highPart)
}

export function asin(value: number): number {
  const absolute = Math.abs(value)
  if (!(absolute < 1)) {
    if (absolute === 1) return value * PIO2_HI + value * PIO2_LO
    return Number.NaN
  }
  if (absolute < HALF) {
    if (absolute < TINY_LIMIT) return value
    return value + value * asinRatio(value * value)
  }
  const angle = steepAsin(absolute)
  return value < 0 ? -angle : angle
}

let bandValue = 0

function atanBand(value: number, absolute: number): number {
  bandValue = value
  if (absolute < FIRST_BAND_LIMIT) return NO_BAND
  if (absolute < SECOND_BAND_LIMIT) {
    bandValue = (TWO * absolute - 1) / (TWO + absolute)
    return 0
  }
  if (absolute < THIRD_BAND_LIMIT) {
    bandValue = (absolute - 1) / (absolute + 1)
    return 1
  }
  if (absolute < FOURTH_BAND_LIMIT) {
    bandValue = (absolute - ONE_AND_HALF) / (1 + ONE_AND_HALF * absolute)
    return 2
  }
  bandValue = -1 / absolute
  return STEEP_BAND
}

export function atan(value: number): number {
  const absolute = Math.abs(value)
  if (!(absolute < HUGE_TANGENT_LIMIT)) {
    if (Number.isNaN(value)) return Number.NaN
    return value < 0 ? -ATAN_HI[STEEP_BAND] - ATAN_LO[STEEP_BAND] : ATAN_HI[STEEP_BAND] + ATAN_LO[STEEP_BAND]
  }
  if (absolute < TINY_LIMIT && HUGE + value > 1) return value
  const band = atanBand(value, absolute)
  const reduced = bandValue
  const square = reduced * reduced
  const fourth = square * square
  const odd =
    square *
    (ATAN_C0 + fourth * (ATAN_C2 + fourth * (ATAN_C4 + fourth * (ATAN_C6 + fourth * (ATAN_C8 + fourth * ATAN_C10)))))
  const even = fourth * (ATAN_C1 + fourth * (ATAN_C3 + fourth * (ATAN_C5 + fourth * (ATAN_C7 + fourth * ATAN_C9))))
  if (band < 0) return reduced - reduced * (odd + even)
  const angle = ATAN_HI[band] - (reduced * (odd + even) - ATAN_LO[band] - reduced)
  return value < 0 ? -angle : angle
}

function bothInfinite(quadrant: number): number {
  if (quadrant === BOTH_POSITIVE) return PI_O_4 + TINY
  if (quadrant === RISE_NEGATIVE) return -PI_O_4 - TINY
  if (quadrant === RUN_NEGATIVE) return THREE * PI_O_4 + TINY
  return -THREE * PI_O_4 - TINY
}

function runInfinite(quadrant: number): number {
  if (quadrant === BOTH_POSITIVE) return 0
  if (quadrant === RISE_NEGATIVE) return -0
  if (quadrant === RUN_NEGATIVE) return PI_WHOLE + TINY
  return -PI_WHOLE - TINY
}

function placeInQuadrant(angle: number, quadrant: number): number {
  if (quadrant === BOTH_POSITIVE) return angle
  if (quadrant === RISE_NEGATIVE) return -angle
  if (quadrant === RUN_NEGATIVE) return PI_WHOLE - (angle - PI_LO)
  return angle - PI_LO - PI_WHOLE
}

function edgeAngle(rise: number, run: number, quadrant: number): number | undefined {
  const runMagnitude = highWord(run) & MAGNITUDE_MASK
  const riseHigh = highWord(rise)
  const riseMagnitude = riseHigh & MAGNITUDE_MASK
  if ((riseMagnitude | lowWord(rise)) === 0) {
    if (quadrant === BOTH_POSITIVE || quadrant === RISE_NEGATIVE) return rise
    return quadrant === RUN_NEGATIVE ? PI_WHOLE + TINY : -PI_WHOLE - TINY
  }
  if ((runMagnitude | lowWord(run)) === 0) return riseHigh < 0 ? -PI_O_2 - TINY : PI_O_2 + TINY
  if (runMagnitude === INFINITE_HIGH_WORD) {
    return riseMagnitude === INFINITE_HIGH_WORD ? bothInfinite(quadrant) : runInfinite(quadrant)
  }
  if (riseMagnitude === INFINITE_HIGH_WORD) return riseHigh < 0 ? -PI_O_2 - TINY : PI_O_2 + TINY
  return undefined
}

export function atan2(rise: number, run: number): number {
  const ratio = Math.abs(rise / run)
  if (
    ratio > PLAIN_RATIO_FLOOR &&
    ratio < PLAIN_RATIO_CEILING &&
    Math.abs(rise) >= SMALLEST_NORMAL &&
    Math.abs(run) >= SMALLEST_NORMAL &&
    run !== 1
  ) {
    return placeInQuadrant(atan(ratio), (rise < 0 ? RISE_NEGATIVE : 0) | (run < 0 ? RUN_NEGATIVE : 0))
  }
  return atan2OfWords(rise, run)
}

function atan2OfWords(rise: number, run: number): number {
  if (Number.isNaN(rise) || Number.isNaN(run)) return Number.NaN
  const runHigh = highWord(run)
  if (((runHigh - ONE_HIGH_WORD) | lowWord(run)) === 0) return atan(rise)
  const riseHigh = highWord(rise)
  let quadrant = ((riseHigh >>> SIGN_SHIFT) & 1) | ((runHigh >>> RUN_SIGN_SHIFT) & RUN_SIGN_MASK)
  const edge = edgeAngle(rise, run, quadrant)
  if (edge !== undefined) return edge
  const exponentGap = ((riseHigh & MAGNITUDE_MASK) - (runHigh & MAGNITUDE_MASK)) >> EXPONENT_SHIFT
  let angle = 0
  if (exponentGap > RATIO_EXPONENT_LIMIT) {
    angle = PI_O_2 + HALF * PI_LO
    quadrant &= 1
  } else if (runHigh < 0 && exponentGap < -RATIO_EXPONENT_LIMIT) {
    angle = 0
  } else {
    angle = atan(Math.abs(rise / run))
  }
  return placeInQuadrant(angle, quadrant)
}
