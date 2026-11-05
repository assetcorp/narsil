import { quarterTurn, reduceQuarterTurn, remPio2, THREE_PI_OVER_FOUR_LIMIT } from './reduce'
import { highWord, lowWord, MAGNITUDE_MASK, withLowWord } from './words'

const PI_OVER_FOUR_LIMIT = 0.7853984832763672
const TINY_SINE_LIMIT = 7.450580596923828e-9
const TINY_TANGENT_LIMIT = 3.725290298461914e-9
const SMALL_COSINE_LIMIT = 0.2999999523162842
const LARGE_COSINE_LIMIT = 0.7812504768371582
const TANGENT_REFLECTION_LIMIT = 0.6743354797363281
const BELOW_HALF_HIGH_WORD_SCALE = 2 ** 22
const BELOW_HALF_QUARTER_STEP = 2 ** -24
const FROM_HALF_HIGH_WORD_SCALE = 2 ** 21
const FROM_HALF_QUARTER_STEP = 2 ** -23
const QUADRANT_MASK = 3

const HALF = 0.5
const TWO = 2
const LARGE_COSINE_QUARTER = 0.28125

const COS1 = 4.16666666666666e-2
const COS2 = -1.388888888887411e-3
const COS3 = 2.480158728947673e-5
const COS4 = -2.7557314351390663e-7
const COS5 = 2.087572321298175e-9
const COS6 = -1.1359647557788195e-11

const SIN1 = -1.6666666666666632e-1
const SIN2 = 8.33333333332249e-3
const SIN3 = -1.984126982985795e-4
const SIN4 = 2.7557313707070068e-6
const SIN5 = -2.5050760253406863e-8
const SIN6 = 1.58969099521155e-10

const TAN0 = 3.333333333333341e-1
const TAN1 = 1.3333333333320124e-1
const TAN2 = 5.396825397622605e-2
const TAN3 = 2.1869488294859542e-2
const TAN4 = 8.8632398235993e-3
const TAN5 = 3.5920791075913124e-3
const TAN6 = 1.4562094543252903e-3
const TAN7 = 5.880412408202641e-4
const TAN8 = 2.464631348184699e-4
const TAN9 = 7.817944429395571e-5
const TAN10 = 7.140724913826082e-5
const TAN11 = -1.8558637485527546e-5
const TAN12 = 2.590730518636337e-5

const PIO4 = 7.853981633974483e-1
const PIO4LO = 3.061616997868383e-17

const reduced = new Float64Array(2)

function kernelCos(head: number, tail: number): number {
  const absolute = Math.abs(head)
  if (absolute < TINY_SINE_LIMIT) return 1
  const square = head * head
  const poly = square * (COS1 + square * (COS2 + square * (COS3 + square * (COS4 + square * (COS5 + square * COS6)))))
  if (absolute < SMALL_COSINE_LIMIT) return 1 - (HALF * square - (square * poly - head * tail))
  const quarter =
    absolute >= LARGE_COSINE_LIMIT
      ? LARGE_COSINE_QUARTER
      : absolute < HALF
        ? Math.floor(absolute * BELOW_HALF_HIGH_WORD_SCALE) * BELOW_HALF_QUARTER_STEP
        : Math.floor(absolute * FROM_HALF_HIGH_WORD_SCALE) * FROM_HALF_QUARTER_STEP
  const shifted = HALF * square - quarter
  const rest = 1 - quarter
  return rest - (shifted - (square * poly - head * tail))
}

function kernelSin(head: number, tail: number, withTail: boolean): number {
  if (Math.abs(head) < TINY_SINE_LIMIT) return head
  const square = head * head
  const cube = square * head
  const poly = SIN2 + square * (SIN3 + square * (SIN4 + square * (SIN5 + square * SIN6)))
  if (!withTail) return head + cube * (SIN1 + square * poly)
  return head - (square * (HALF * tail - cube * poly) - tail - cube * SIN1)
}

function carefulReciprocal(head: number, rest: number): number {
  const sum = head + rest
  const sumHead = withLowWord(sum, 0)
  const sumTail = rest - (sumHead - head)
  const reciprocal = -1 / sum
  const reciprocalHead = withLowWord(reciprocal, 0)
  const error = 1 + reciprocalHead * sumHead
  return reciprocalHead + reciprocal * (error + reciprocalHead * sumTail)
}

function tinyTangent(head: number, tail: number, sign: number): number {
  const magnitude = highWord(head) & MAGNITUDE_MASK
  if ((magnitude | lowWord(head) | (sign + 1)) === 0) return 1 / Math.abs(head)
  if (sign === 1) return head
  return carefulReciprocal(head, tail)
}

function kernelTan(angleHead: number, angleTail: number, sign: number): number {
  let head = angleHead
  let tail = angleTail
  const negative = head < 0
  const absolute = Math.abs(head)
  if (absolute < TINY_TANGENT_LIMIT) return tinyTangent(head, tail, sign)
  const reflected = absolute >= TANGENT_REFLECTION_LIMIT
  if (reflected) {
    if (negative) {
      head = -head
      tail = -tail
    }
    const offset = PIO4 - head
    const offsetTail = PIO4LO - tail
    head = offset + offsetTail
    tail = 0
  }
  const square = head * head
  const fourth = square * square
  const odd = TAN1 + fourth * (TAN3 + fourth * (TAN5 + fourth * (TAN7 + fourth * (TAN9 + fourth * TAN11))))
  const even = square * (TAN2 + fourth * (TAN4 + fourth * (TAN6 + fourth * (TAN8 + fourth * (TAN10 + fourth * TAN12)))))
  const cube = square * head
  let rest = tail + square * (cube * (odd + even) + tail)
  rest += TAN0 * cube
  const sum = head + rest
  if (reflected) {
    const direction = negative ? -1 : 1
    return direction * (sign - TWO * (head - ((sum * sum) / (sum + sign) - rest)))
  }
  if (sign === 1) return sum
  return carefulReciprocal(head, rest)
}

function sinOfTurns(turns: number, head: number, tail: number): number {
  switch (turns & QUADRANT_MASK) {
    case 0:
      return kernelSin(head, tail, true)
    case 1:
      return kernelCos(head, tail)
    case 2:
      return -kernelSin(head, tail, true)
    default:
      return -kernelCos(head, tail)
  }
}

function cosOfTurns(turns: number, head: number, tail: number): number {
  switch (turns & QUADRANT_MASK) {
    case 0:
      return kernelCos(head, tail)
    case 1:
      return -kernelSin(head, tail, true)
    case 2:
      return -kernelCos(head, tail)
    default:
      return kernelSin(head, tail, true)
  }
}

export function sin(value: number): number {
  const absolute = Math.abs(value)
  if (absolute < PI_OVER_FOUR_LIMIT) return kernelSin(value, 0, false)
  if (absolute < THREE_PI_OVER_FOUR_LIMIT) {
    const turns = reduceQuarterTurn(value, absolute)
    return sinOfTurns(turns, quarterTurn.head, quarterTurn.tail)
  }
  if (!(absolute < Number.POSITIVE_INFINITY)) return Number.NaN
  const turns = remPio2(value, reduced)
  return sinOfTurns(turns, reduced[0], reduced[1])
}

export function cos(value: number): number {
  const absolute = Math.abs(value)
  if (absolute < PI_OVER_FOUR_LIMIT) return kernelCos(value, 0)
  if (absolute < THREE_PI_OVER_FOUR_LIMIT) {
    const turns = reduceQuarterTurn(value, absolute)
    return cosOfTurns(turns, quarterTurn.head, quarterTurn.tail)
  }
  if (!(absolute < Number.POSITIVE_INFINITY)) return Number.NaN
  const turns = remPio2(value, reduced)
  return cosOfTurns(turns, reduced[0], reduced[1])
}

export function tan(value: number): number {
  const absolute = Math.abs(value)
  if (absolute < PI_OVER_FOUR_LIMIT) return kernelTan(value, 0, 1)
  if (absolute < THREE_PI_OVER_FOUR_LIMIT) {
    const turns = reduceQuarterTurn(value, absolute)
    return kernelTan(quarterTurn.head, quarterTurn.tail, 1 - ((turns & 1) << 1))
  }
  if (!(absolute < Number.POSITIVE_INFINITY)) return Number.NaN
  const turns = remPio2(value, reduced)
  return kernelTan(reduced[0], reduced[1], 1 - ((turns & 1) << 1))
}
