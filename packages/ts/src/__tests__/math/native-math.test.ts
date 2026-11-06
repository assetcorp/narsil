import { describe, expect, it } from 'vitest'
import { asin, atan, atan2 } from '../../math/inverse'
import { log } from '../../math/log'
import { cos, sin, tan } from '../../math/trig'
import { loadNativeCore } from '../../vector/native/loader'
import { seededRandom } from '../integration/filtered-vectors/library'
import { backendAvailable, searchThrough } from '../integration/filtered-vectors/search-backend'

const RANDOM_INPUTS_PER_FUNCTION = 400_000
const SPAN_INPUTS_PER_FUNCTION = 400_000
const NATIVE_STATUS_OK = 0
const EXPONENT_BIAS = 1023
const EXPONENT_SHIFT = 20
const SIGNIFICAND_HIGH_MASK = 0xfffff
const SIGN_BIT = 0x80000000
const UINT32_RANGE = 4294967296
const LARGEST_EXPONENT = 1023
const SUBNORMAL_EXPONENT = -1023
const TEST_TIMEOUT_MS = 120_000

const words = new DataView(new ArrayBuffer(8))

function doubleFrom(high: number, low: number): number {
  words.setUint32(0, high >>> 0)
  words.setUint32(4, low >>> 0)
  return words.getFloat64(0)
}

function bitsOf(value: number): string {
  words.setFloat64(0, value)
  return `0x${words.getBigUint64(0).toString(16).padStart(16, '0')}`
}

type Draw = () => number

function randomDouble(draw: Draw, lowestExponent: number, highestExponent: number, signed: boolean): number {
  const span = highestExponent - lowestExponent + 1
  const exponent = lowestExponent + Math.floor(draw() * span)
  const sign = signed && draw() < 0.5 ? SIGN_BIT : 0
  const significand = Math.floor(draw() * UINT32_RANGE) & SIGNIFICAND_HIGH_MASK
  const high = sign | ((exponent + EXPONENT_BIAS) << EXPONENT_SHIFT) | significand
  return doubleFrom(high, Math.floor(draw() * UINT32_RANGE))
}

const SPECIAL_VALUES = [
  0,
  -0,
  1,
  -1,
  0.5,
  -0.5,
  Number.MIN_VALUE,
  -Number.MIN_VALUE,
  2.2250738585072014e-308,
  Number.MAX_VALUE,
  -Number.MAX_VALUE,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  Number.NaN,
  Math.PI,
  -Math.PI,
  Math.PI / 2,
  Math.PI / 4,
  3 * (Math.PI / 4),
  1 - Number.EPSILON,
  1 + Number.EPSILON,
  0.9999999999999999,
  1e-300,
  1e300,
  2 ** 19 * (Math.PI / 2),
  2 ** 20 * (Math.PI / 2),
  1e22,
  6381956970095103 * 2 ** 797,
]

function neighbours(value: number): number[] {
  words.setFloat64(0, value)
  const bits = words.getBigUint64(0)
  const around: number[] = []
  for (const step of [-2n, -1n, 1n, 2n]) {
    words.setBigUint64(0, BigInt.asUintN(64, bits + step))
    around.push(words.getFloat64(0))
  }
  return around
}

function specialInputs(): number[] {
  const inputs = [...SPECIAL_VALUES]
  for (let turns = -64; turns <= 64; turns++) {
    const quarter = turns * (Math.PI / 2)
    inputs.push(quarter, ...neighbours(quarter))
  }
  for (const value of [0.5, 1, 2, 0.95]) inputs.push(...neighbours(value), ...neighbours(-value))
  return inputs
}

interface UnaryCase {
  name: string
  operation: number
  port: (value: number) => number
  host: (value: number) => number
  range: [number, number]
  span: [number, number]
}

const UNARY_CASES: UnaryCase[] = [
  {
    name: 'log',
    operation: 0,
    port: log,
    host: Math.log,
    range: [SUBNORMAL_EXPONENT, LARGEST_EXPONENT],
    span: [0, 4],
  },
  { name: 'sin', operation: 1, port: sin, host: Math.sin, range: [-40, LARGEST_EXPONENT], span: [-4, 4] },
  { name: 'cos', operation: 2, port: cos, host: Math.cos, range: [-40, LARGEST_EXPONENT], span: [-4, 4] },
  { name: 'tan', operation: 3, port: tan, host: Math.tan, range: [-40, LARGEST_EXPONENT], span: [-4, 4] },
  { name: 'asin', operation: 4, port: asin, host: Math.asin, range: [-40, 0], span: [-1, 1] },
  { name: 'atan', operation: 5, port: atan, host: Math.atan, range: [-40, 70], span: [-4, 4] },
]

const ATAN2_OPERATION = 6
const SIN_OPERATION = 1

function unaryInputs(testCase: UnaryCase, seed: number): Float64Array {
  const draw = seededRandom(seed)
  const special = specialInputs()
  const spanStart = special.length + RANDOM_INPUTS_PER_FUNCTION
  const inputs = new Float64Array(spanStart + SPAN_INPUTS_PER_FUNCTION)
  inputs.set(special)
  for (let index = special.length; index < spanStart; index++) {
    inputs[index] = randomDouble(draw, testCase.range[0], testCase.range[1], true)
  }
  const [lowest, highest] = testCase.span
  for (let index = spanStart; index < inputs.length; index++) {
    inputs[index] = lowest + draw() * (highest - lowest)
  }
  return inputs
}

function firstDifference(
  expected: (index: number) => number,
  actual: Float64Array,
  describeInput: (index: number) => string,
): string | null {
  for (let index = 0; index < actual.length; index++) {
    const wanted = expected(index)
    if (Object.is(wanted, actual[index]) || (Number.isNaN(wanted) && Number.isNaN(actual[index]))) continue
    return `${describeInput(index)}: expected ${bitsOf(wanted)}, got ${bitsOf(actual[index])}`
  }
  return null
}

const checksHostMath = process.arch === 'x64'

interface SpecVector {
  operation: number
  port: (first: number, second: number) => number
  inputs: string[]
  result: string
}

const SPEC_VECTORS: SpecVector[] = [
  { operation: 0, port: log, inputs: ['4004000000000000'], result: '3FED5240F0E0E078' },
  { operation: 0, port: log, inputs: ['0000000000000001'], result: 'C0874385446D71C3' },
  { operation: 1, port: sin, inputs: ['3FF0000000000000'], result: '3FEAED548F090CEE' },
  { operation: 1, port: sin, inputs: ['4480F0CF064DD592'], result: 'BFEB453AB76BF397' },
  { operation: 2, port: cos, inputs: ['3FE0000000000000'], result: '3FEC1528065B7D50' },
  { operation: 2, port: cos, inputs: ['7E37E43C8800759C'], result: 'BFE2699022ADC4C1' },
  { operation: 3, port: tan, inputs: ['3FE6666666666666'], result: '3FEAF406C2FC78AE' },
  { operation: 3, port: tan, inputs: ['3FF921FB54442D18'], result: '434D02967C31CDB5' },
  { operation: 4, port: asin, inputs: ['3FD3333333333333'], result: '3FD380159E14F6FF' },
  { operation: 4, port: asin, inputs: ['3FEF5C28F5C28F5C'], result: '3FF5ED690583BE07' },
  { operation: 5, port: atan, inputs: ['3FE0000000000000'], result: '3FDDAC670561BB4F' },
  { operation: 5, port: atan, inputs: ['4202A05F20000000'], result: '3FF921FB543D4DE0' },
  { operation: 6, port: atan2, inputs: ['3FE0000000000000', 'BFE6666666666666'], result: '40042BB5F776EB80' },
  { operation: 6, port: atan2, inputs: ['C008000000000000', '3EE4F8B588E368F1'], result: 'BFF921F7D57B40F2' },
]

function doubleOfHex(hex: string): number {
  words.setBigUint64(0, BigInt(`0x${hex}`))
  return words.getFloat64(0)
}

function hexOf(value: number): string {
  words.setFloat64(0, value)
  return words.getBigUint64(0).toString(16).toUpperCase().padStart(16, '0')
}

describe('the TypeScript maths port gives the results that the specification publishes', () => {
  for (const vector of SPEC_VECTORS) {
    it(`gives ${vector.result} for operation ${vector.operation} of ${vector.inputs.join(', ')}`, () => {
      const [first, second] = vector.inputs.map(doubleOfHex)
      expect(hexOf(vector.port(first, second))).toBe(vector.result)
    })
  }
})

describe.skipIf(!backendAvailable('native'))(
  'the native core gives the results that the specification publishes',
  () => {
    searchThrough('native')

    it('gives every published result', () => {
      const core = loadNativeCore()
      expect(core).not.toBeNull()
      if (core === null) return
      for (const vector of SPEC_VECTORS) {
        const [first, second] = vector.inputs.map(doubleOfHex)
        const results = new Float64Array(1)
        const seconds = vector.operation === ATAN2_OPERATION ? Float64Array.of(second) : new Float64Array(0)
        expect(core.applyMath(vector.operation, Float64Array.of(first), seconds, results)).toBe(NATIVE_STATUS_OK)
        expect(hexOf(results[0]), `${vector.operation} ${vector.inputs.join(', ')}`).toBe(vector.result)
      }
    })

    it('refuses arguments that hold fewer values than the results', () => {
      const core = loadNativeCore()
      expect(core).not.toBeNull()
      if (core === null) return
      const results = new Float64Array(4)
      const none = new Float64Array(0)
      expect(() => core.applyMath(SIN_OPERATION, new Float64Array(3), none, results)).toThrow()
      expect(() => core.applyMath(SIN_OPERATION, new Float64Array(5), none, results)).toThrow()
      expect(() => core.applyMath(ATAN2_OPERATION, new Float64Array(4), new Float64Array(3), results)).toThrow()
      expect(() => core.applyMath(ATAN2_OPERATION, new Float64Array(4), none, results)).toThrow()
      expect(core.applyMath(SIN_OPERATION, Float64Array.of(0, 0, 0, 0), new Float64Array(9), results)).toBe(
        NATIVE_STATUS_OK,
      )
      expect(Array.from(results)).toEqual([0, 0, 0, 0])
    })
  },
)

describe.skipIf(!backendAvailable('native'))('the native core and the TypeScript port compute the same maths', () => {
  searchThrough('native')

  for (const [position, testCase] of UNARY_CASES.entries()) {
    it(
      `${testCase.name} gives the same bits in C and in TypeScript`,
      () => {
        const core = loadNativeCore()
        expect(core).not.toBeNull()
        if (core === null) return
        const inputs = unaryInputs(testCase, 20261105 + position)
        const results = new Float64Array(inputs.length)
        expect(core.applyMath(testCase.operation, inputs, new Float64Array(0), results)).toBe(NATIVE_STATUS_OK)
        const describeInput = (index: number) => `${testCase.name}(${inputs[index]} ${bitsOf(inputs[index])})`
        expect(firstDifference(index => testCase.port(inputs[index]), results, describeInput)).toBeNull()
        if (checksHostMath) {
          expect(firstDifference(index => testCase.host(inputs[index]), results, describeInput)).toBeNull()
        }
      },
      TEST_TIMEOUT_MS,
    )
  }

  it(
    'atan2 gives the same bits in C and in TypeScript',
    () => {
      const core = loadNativeCore()
      expect(core).not.toBeNull()
      if (core === null) return
      const draw = seededRandom(20261112)
      const special = specialInputs()
      const pairs = special.length * special.length + RANDOM_INPUTS_PER_FUNCTION
      const rises = new Float64Array(pairs)
      const runs = new Float64Array(pairs)
      let next = 0
      for (const rise of special) {
        for (const run of special) {
          rises[next] = rise
          runs[next] = run
          next++
        }
      }
      for (; next < pairs; next++) {
        rises[next] = randomDouble(draw, SUBNORMAL_EXPONENT, LARGEST_EXPONENT, true)
        runs[next] = randomDouble(draw, SUBNORMAL_EXPONENT, LARGEST_EXPONENT, true)
      }
      const results = new Float64Array(pairs)
      expect(core.applyMath(ATAN2_OPERATION, rises, runs, results)).toBe(NATIVE_STATUS_OK)
      const describeInput = (index: number) => `atan2(${rises[index]}, ${runs[index]})`
      expect(firstDifference(index => atan2(rises[index], runs[index]), results, describeInput)).toBeNull()
      if (checksHostMath) {
        expect(firstDifference(index => Math.atan2(rises[index], runs[index]), results, describeInput)).toBeNull()
      }
    },
    TEST_TIMEOUT_MS,
  )
})
