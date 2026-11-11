import {
  fromWords,
  highWord,
  INFINITE_HIGH_WORD,
  lowWord,
  MAGNITUDE_MASK,
  scaleByPowerOfTwo,
} from '../geo/geo-host-bindings'

const CHUNK_BITS = 24
const CHUNK_TOP_BIT = 23
const CHUNK_LIMIT = 0x1000000
const CHUNK_MASK = 0xffffff
const CHUNK_SLOTS = 20
const EXTENDED_TERMS = 4
const EXPONENT_BIAS_LESS_23 = 1046
const INPUT_CHUNKS = 3
const INTEGRAL_INPUT_CHUNKS = 2
const OCTANT_MASK = 7
const PAST_HALF_TURN = 2
const TOP_CHUNK_MASK_ONE = 0x7fffff
const TOP_CHUNK_MASK_TWO = 0x3fffff
const TABLED_MULTIPLES = 32
const PI_OVER_FOUR_HIGH_WORD = 0x3fe921fb
const PI_OVER_TWO_HIGH_WORD = 0x3ff921fb
const THREE_PI_OVER_FOUR_HIGH_WORD = 0x4002d97c
const MEDIUM_LIMIT_HIGH_WORD = 0x413921fb
const SECOND_ROUND_CANCELLED_BITS = 16
const THIRD_ROUND_CANCELLED_BITS = 49
const EXPONENT_SHIFT = 20
const EXPONENT_MASK = 0x7ff

const TWO_OVER_PI = Int32Array.from([
  0xa2f983, 0x6e4e44, 0x1529fc, 0x2757d1, 0xf534dd, 0xc0db62, 0x95993c, 0x439041, 0xfe5163, 0xabdebb, 0xc561b7,
  0x246e3a, 0x424dd2, 0xe00649, 0x2eea09, 0xd1921c, 0xfe1deb, 0x1cb129, 0xa73ee8, 0x8235f5, 0x2ebb44, 0x84e99c,
  0x7026b4, 0x5f7e41, 0x3991d6, 0x398353, 0x39f49c, 0x845f8b, 0xbdf928, 0x3b1ff8, 0x97ffde, 0x05980f, 0xef2f11,
  0x8b5a0a, 0x6d1f6d, 0x367ecf, 0x27cb09, 0xb74f46, 0x3f669e, 0x5fea2d, 0x7527ba, 0xc7ebe5, 0xf17b3d, 0x0739f7,
  0x8a5292, 0xea6bfb, 0x5fb11f, 0x8d5d08, 0x560330, 0x46fc7b, 0x6babf0, 0xcfbc20, 0x9af436, 0x1da9e3, 0x91615e,
  0xe61b08, 0x659985, 0x5f14a0, 0x68408d, 0xffd880, 0x4d7327, 0x310606, 0x1556ca, 0x73a8c9, 0x60e27b, 0xc08c6b,
])

const MULTIPLE_HIGH_WORDS = Int32Array.from([
  0x3ff921fb, 0x400921fb, 0x4012d97c, 0x401921fb, 0x401f6a7a, 0x4022d97c, 0x4025fdbb, 0x402921fb, 0x402c463a,
  0x402f6a7a, 0x4031475c, 0x4032d97c, 0x40346b9c, 0x4035fdbb, 0x40378fdb, 0x403921fb, 0x403ab41b, 0x403c463a,
  0x403dd85a, 0x403f6a7a, 0x40407e4c, 0x4041475c, 0x4042106c, 0x4042d97c, 0x4043a28c, 0x40446b9c, 0x404534ac,
  0x4045fdbb, 0x4046c6cb, 0x40478fdb, 0x404858eb, 0x404921fb,
])

const PI_OVER_TWO_CHUNKS = Float64Array.from([
  1.570796251296997, 7.549789415861596e-8, 5.390302529957765e-15, 3.282003415807913e-22, 1.270655753080676e-29,
  1.2293330898111133e-36, 2.7337005381646456e-44, 2.1674168387780482e-51,
])

const TWO24 = 1.6777216e7
const TWON24 = 5.9604644775390625e-8
const ONE_EIGHTH = 0.125
const EIGHT = 8
const HALF = 0.5
const INVPIO2 = 6.366197723675814e-1
const PIO2_1 = 1.5707963267341256
const PIO2_1T = 6.077100506506192e-11
const PIO2_2 = 6.077100506303966e-11
const PIO2_2T = 2.0222662487959506e-21
const PIO2_3 = 2.0222662487111665e-21
const PIO2_3T = 8.4784276603689e-32

class Reduction {
  lastInput = 0
  tableStart = 0
  exponent = 0
  top = 0
  quotient = 0
  pastHalf = 0
  fraction = 0
  readonly chunks = new Int32Array(CHUNK_SLOTS)
  readonly factors = new Float64Array(CHUNK_SLOTS)
  readonly terms = new Float64Array(CHUNK_SLOTS)
  readonly products = new Float64Array(CHUNK_SLOTS)

  constructor(readonly input: Float64Array) {}
}

function productTerm(red: Reduction, index: number): number {
  let sum = 0
  for (let j = 0; j <= red.lastInput; j++) sum += red.input[j] * red.factors[red.lastInput + index - j]
  return sum
}

function distill(red: Reduction): void {
  let rest = red.products[red.top]
  for (let i = 0, j = red.top; j > 0; i++, j--) {
    const carried = (TWON24 * rest) | 0
    red.chunks[i] = (rest - TWO24 * carried) | 0
    rest = red.products[j - 1] + carried
  }
  red.fraction = rest
}

function splitQuotient(red: Reduction): void {
  let scaled = scaleByPowerOfTwo(red.fraction, red.exponent)
  scaled -= EIGHT * Math.floor(scaled * ONE_EIGHTH)
  red.quotient = scaled | 0
  scaled -= red.quotient
  red.pastHalf = 0
  const highest = red.top - 1
  if (highest >= 0 && red.exponent > 0) {
    const whole = red.chunks[highest] >> (CHUNK_BITS - red.exponent)
    red.quotient += whole
    red.chunks[highest] -= whole << (CHUNK_BITS - red.exponent)
    red.pastHalf = red.chunks[highest] >> (CHUNK_TOP_BIT - red.exponent)
  } else if (highest >= 0 && red.exponent === 0) {
    red.pastHalf = red.chunks[highest] >> CHUNK_TOP_BIT
  } else if (scaled >= HALF) {
    red.pastHalf = PAST_HALF_TURN
  }
  red.fraction = scaled
}

function complement(red: Reduction): void {
  if (red.pastHalf <= 0) return
  let carry = 0
  red.quotient += 1
  for (let i = 0; i < red.top; i++) {
    const chunk = red.chunks[i]
    if (carry === 0) {
      if (chunk !== 0) {
        carry = 1
        red.chunks[i] = CHUNK_LIMIT - chunk
      }
    } else {
      red.chunks[i] = CHUNK_MASK - chunk
    }
  }
  const highest = red.top - 1
  if (highest >= 0 && red.exponent === 1) red.chunks[highest] &= TOP_CHUNK_MASK_ONE
  if (highest >= 0 && red.exponent === 2) red.chunks[highest] &= TOP_CHUNK_MASK_TWO
  if (red.pastHalf === PAST_HALF_TURN) {
    red.fraction = 1 - red.fraction
    if (carry !== 0) red.fraction -= scaleByPowerOfTwo(1, red.exponent)
  }
}

function moreTermsNeeded(red: Reduction): number {
  if (red.fraction !== 0) return 0
  let bits = 0
  for (let i = red.top - 1; i >= EXTENDED_TERMS; i--) bits |= red.chunks[i]
  if (bits !== 0) return 0
  let count = 1
  while (EXTENDED_TERMS >= count && red.chunks[EXTENDED_TERMS - count] === 0) count++
  return count
}

function extend(red: Reduction, count: number): void {
  for (let i = red.top + 1; i <= red.top + count; i++) {
    red.factors[red.lastInput + i] = TWO_OVER_PI[red.tableStart + i]
    red.products[i] = productTerm(red, i)
  }
  red.top += count
}

function normaliseChunks(red: Reduction): void {
  if (red.fraction === 0) {
    red.top -= 1
    red.exponent -= CHUNK_BITS
    while (red.top > 0 && red.chunks[red.top] === 0) {
      red.top--
      red.exponent -= CHUNK_BITS
    }
    return
  }
  const scaled = scaleByPowerOfTwo(red.fraction, -red.exponent)
  if (scaled >= TWO24) {
    const carried = (TWON24 * scaled) | 0
    red.chunks[red.top] = (scaled - TWO24 * carried) | 0
    red.top += 1
    red.exponent += CHUNK_BITS
    red.chunks[red.top] = carried
  } else {
    red.chunks[red.top] = scaled | 0
  }
}

function writeResult(red: Reduction, out: Float64Array): void {
  let scale = scaleByPowerOfTwo(1, red.exponent)
  for (let i = red.top; i >= 0; i--) {
    red.products[i] = scale * red.chunks[i]
    scale *= TWON24
  }
  for (let i = red.top; i >= 0; i--) {
    let sum = 0
    for (let k = 0; k <= EXTENDED_TERMS && k <= red.top - i; k++) sum += PI_OVER_TWO_CHUNKS[k] * red.products[i + k]
    red.terms[red.top - i] = sum
  }
  let sum = 0
  for (let i = red.top; i >= 0; i--) sum += red.terms[i]
  out[0] = red.pastHalf === 0 ? sum : -sum
  sum = red.terms[0] - sum
  for (let i = 1; i <= red.top; i++) sum += red.terms[i]
  out[1] = red.pastHalf === 0 ? sum : -sum
}

function kernelRemPio2(input: Float64Array, count: number, out: Float64Array, exponent: number): number {
  const red = new Reduction(input)
  red.lastInput = count - 1
  red.tableStart = Math.trunc((exponent - 3) / CHUNK_BITS)
  if (red.tableStart < 0) red.tableStart = 0
  red.exponent = exponent - CHUNK_BITS * (red.tableStart + 1)
  for (let i = 0, j = red.tableStart - red.lastInput; i <= red.lastInput + EXTENDED_TERMS; i++, j++) {
    red.factors[i] = j < 0 ? 0 : TWO_OVER_PI[j]
  }
  for (let i = 0; i <= EXTENDED_TERMS; i++) red.products[i] = productTerm(red, i)
  red.top = EXTENDED_TERMS
  for (;;) {
    distill(red)
    splitQuotient(red)
    complement(red)
    const needed = moreTermsNeeded(red)
    if (needed === 0) break
    extend(red, needed)
  }
  normaliseChunks(red)
  writeResult(red, out)
  return red.quotient & OCTANT_MASK
}

export const THREE_PI_OVER_FOUR_LIMIT = 2.3561935424804688
const QUARTER_TURN_FIRST = 1.570796012878418
const QUARTER_TURN_PAST = 1.5707969665527344

export const quarterTurn = { head: 0, tail: 0 }

export function reduceQuarterTurn(value: number, absolute: number): number {
  const nearQuarter = absolute >= QUARTER_TURN_FIRST && absolute < QUARTER_TURN_PAST
  if (value > 0) {
    let rest = value - PIO2_1
    if (!nearQuarter) {
      quarterTurn.head = rest - PIO2_1T
      quarterTurn.tail = rest - quarterTurn.head - PIO2_1T
    } else {
      rest -= PIO2_2
      quarterTurn.head = rest - PIO2_2T
      quarterTurn.tail = rest - quarterTurn.head - PIO2_2T
    }
    return 1
  }
  let rest = value + PIO2_1
  if (!nearQuarter) {
    quarterTurn.head = rest + PIO2_1T
    quarterTurn.tail = rest - quarterTurn.head + PIO2_1T
  } else {
    rest += PIO2_2
    quarterTurn.head = rest + PIO2_2T
    quarterTurn.tail = rest - quarterTurn.head + PIO2_2T
  }
  return -1
}

function nearQuarterTurn(value: number, out: Float64Array): number {
  const magnitude = highWord(value) & MAGNITUDE_MASK
  if (highWord(value) >= 0) {
    let rest = value - PIO2_1
    if (magnitude !== PI_OVER_TWO_HIGH_WORD) {
      out[0] = rest - PIO2_1T
      out[1] = rest - out[0] - PIO2_1T
    } else {
      rest -= PIO2_2
      out[0] = rest - PIO2_2T
      out[1] = rest - out[0] - PIO2_2T
    }
    return 1
  }
  let rest = value + PIO2_1
  if (magnitude !== PI_OVER_TWO_HIGH_WORD) {
    out[0] = rest + PIO2_1T
    out[1] = rest - out[0] + PIO2_1T
  } else {
    rest += PIO2_2
    out[0] = rest + PIO2_2T
    out[1] = rest - out[0] + PIO2_2T
  }
  return -1
}

function cancelledBits(exponent: number, reduced: number): number {
  return exponent - ((highWord(reduced) >>> EXPONENT_SHIFT) & EXPONENT_MASK)
}

function mediumTurns(value: number, out: Float64Array): number {
  const magnitude = highWord(value) & MAGNITUDE_MASK
  const absolute = Math.abs(value)
  const turns = (absolute * INVPIO2 + HALF) | 0
  const whole = turns
  let rest = absolute - whole * PIO2_1
  let tail = whole * PIO2_1T
  out[0] = rest - tail
  if (turns >= TABLED_MULTIPLES || magnitude === MULTIPLE_HIGH_WORDS[turns - 1]) {
    const exponent = magnitude >> EXPONENT_SHIFT
    if (cancelledBits(exponent, out[0]) > SECOND_ROUND_CANCELLED_BITS) {
      let before = rest
      tail = whole * PIO2_2
      rest = before - tail
      tail = whole * PIO2_2T - (before - rest - tail)
      out[0] = rest - tail
      if (cancelledBits(exponent, out[0]) > THIRD_ROUND_CANCELLED_BITS) {
        before = rest
        tail = whole * PIO2_3
        rest = before - tail
        tail = whole * PIO2_3T - (before - rest - tail)
        out[0] = rest - tail
      }
    }
  }
  out[1] = rest - out[0] - tail
  if (highWord(value) < 0) {
    out[0] = -out[0]
    out[1] = -out[1]
    return -turns
  }
  return turns
}

function largeTurns(value: number, out: Float64Array): number {
  const magnitude = highWord(value) & MAGNITUDE_MASK
  const exponent = (magnitude >> EXPONENT_SHIFT) - EXPONENT_BIAS_LESS_23
  let scaled = fromWords(magnitude - (exponent << EXPONENT_SHIFT), lowWord(value))
  const chunks = new Float64Array(INPUT_CHUNKS)
  for (let i = 0; i < INTEGRAL_INPUT_CHUNKS; i++) {
    chunks[i] = scaled | 0
    scaled = (scaled - chunks[i]) * TWO24
  }
  chunks[INTEGRAL_INPUT_CHUNKS] = scaled
  let count = INPUT_CHUNKS
  while (count > 1 && chunks[count - 1] === 0) count--
  const turns = kernelRemPio2(chunks, count, out, exponent)
  if (highWord(value) < 0) {
    out[0] = -out[0]
    out[1] = -out[1]
    return -turns
  }
  return turns
}

export function remPio2(value: number, out: Float64Array): number {
  const magnitude = highWord(value) & MAGNITUDE_MASK
  if (magnitude <= PI_OVER_FOUR_HIGH_WORD) {
    out[0] = value
    out[1] = 0
    return 0
  }
  if (magnitude < THREE_PI_OVER_FOUR_HIGH_WORD) return nearQuarterTurn(value, out)
  if (magnitude <= MEDIUM_LIMIT_HIGH_WORD) return mediumTurns(value, out)
  if (magnitude >= INFINITE_HIGH_WORD) {
    out[0] = Number.NaN
    out[1] = Number.NaN
    return 0
  }
  return largeTurns(value, out)
}
